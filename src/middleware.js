/**
 * Stage 2 of the Two-Stage Tandem Architecture: Sync JS Gateway Middleware (`magpie.middleware`)
 *
 * Runs inside Magpie's in-process `moejs` VM (`internal/middleware/run.go`, 250 ms budget)
 * immediately after `magpie.hooks` (`src/hooks.js`) and right before `s.serve` resolves the
 * target model and effort (`internal/gateway/middleware.go:42-78`).
 *
 * Capabilities in `src/middleware.js`:
 * 1. Consumes and deletes the transient `body.__agentcompass_route` carrier populated by
 *    Stage 1 (`src/hooks.js` in Bun with up to 10,000 ms budget), syncing continuation state
 *    into the `moejs` continuity store.
 * 2. If `magpie.hooks` was not enabled or timed out, runs `evaluateProviderContinuation` first
 *    (holding the current Provider/Model on `within: true` tool loops, warm KV cache, or short
 *    follow-up nudges), and only executes `inferTaskProfile` + `selectBestRoute` when selecting
 *    or switching a Provider/Model is needed!
 * 3. Rewrites `body.model` (using either `<model>:<effort>` which `gateway.go:askedAt` natively
 *    splits, or bare `<model>` plus protocol-specific reasoning effort fields).
 * 4. Implements `onResponse(body, ctx)` and `onUsage(row, options)` (`internal/middleware/run.go:349`)
 *    to update token/cache watermarks and mark a Provider/Model unhealthy (`healthy: false`)
 *    when a request fails or is rejected (`status >= 400`, `rejected: true`).
 * 5. Implements `onAccount(account, ctx)` to optionally filter accounts, and exports a
 *    `strategies["agentcompass-pure"]` seat-ordering strategy.
 */

import { selectBestRoute } from "./allocator.js";
import { canonicalModel } from "./catalog.js";
import {
  computeSessionKey,
  defaultContinuityStore,
  evaluateProviderContinuation,
  keepsEffort,
} from "./continuity.js";
import { extractRequestFacts, inferTaskProfile } from "./profiler-core.js";

const ROUTE_CARRIER_KEY = "__agentcompass_route";

const DEFAULT_VIRTUAL_MODELS = [
  "auto",
  "agentcompass",
  "agentcompass/auto",
  "intent",
  "group/intent",
  "group/agentcompass",
];

function shouldRoute(model, options = {}) {
  if (!model || typeof model !== "string") return false;
  if (options.routeAllModels === true) return true;
  const clean = model.trim().toLowerCase();
  const triggerList = options.triggerModels || options.routeModelTriggers;
  const triggers =
    Array.isArray(triggerList) && triggerList.length > 0
      ? triggerList.map((m) => String(m).trim().toLowerCase())
      : DEFAULT_VIRTUAL_MODELS;
  return triggers.includes(clean) || clean.startsWith("agentcompass/");
}

/**
 * Apply the selected effort to the request body according to the client protocol,
 * or encode `<model>:<effort>` which Magpie's `askedAt` (`internal/gateway/gateway.go:1560`)
 * natively parses and applies to every upstream candidate!
 */
export function applyRoutedModelAndEffort(body, decision, ctx = {}) {
  const options = ctx?.options || {};
  const protocol = String(ctx?.protocol || "").toLowerCase();
  const rawModel = decision.targetModel;
  const targetEffort = decision.targetEffort || "high";

  if (!rawModel) return body;

  const mappedModel =
    (options.modelMap && typeof options.modelMap === "object" && options.modelMap[rawModel]) ||
    rawModel;
  const targetModel =
    typeof options.modelPrefix === "string" &&
    options.modelPrefix.trim() &&
    !mappedModel.includes("/")
      ? `${options.modelPrefix.trim().replace(/\/$/, "")}/${mappedModel}`
      : mappedModel;

  // Magpie natively supports `<model>:<effort>` in `gateway.go:askedAt` (unless disabled by option)
  if (options.useColonEffort !== false && targetEffort && !targetModel.includes(":")) {
    body.model = `${targetModel}:${targetEffort}`;
  } else {
    body.model = targetModel;
  }

  if (options.injectProtocolEffort === true && targetEffort) {
    if (protocol === "chat") {
      body.reasoning_effort = targetEffort === "max" ? "xhigh" : targetEffort;
    } else if (protocol === "responses") {
      body.reasoning = {
        ...(body.reasoning && typeof body.reasoning === "object" ? body.reasoning : {}),
        effort: targetEffort === "max" ? "xhigh" : targetEffort,
      };
    } else if (protocol === "anthropic") {
      body.output_config = {
        ...(body.output_config && typeof body.output_config === "object"
          ? body.output_config
          : {}),
        effort: targetEffort === "xhigh" ? "max" : targetEffort,
      };
    }
  }

  return body;
}

export function onRequest(body, ctx = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }

  const options = ctx.options || {};
  const store = options.continuityStore || defaultContinuityStore;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  let decision = null;

  // 1. Check if Stage 1 (`src/hooks.js` in Bun) attached a pre-computed decision carrier
  if (body[ROUTE_CARRIER_KEY] && typeof body[ROUTE_CARRIER_KEY] === "object") {
    decision = body[ROUTE_CARRIER_KEY];
    delete body[ROUTE_CARRIER_KEY];

    const sessionKey =
      decision.continuation?.sessionKey || computeSessionKey(body, ctx);
    if (sessionKey && decision.targetModel) {
      const facts = extractRequestFacts(body, ctx);
      store.recordRequest(
        sessionKey,
        {
          model: decision.targetModel,
          effort: decision.targetEffort || "high",
          workKind: decision.workKind || "general_implementation",
          difficulty: decision.difficulty || "routine",
          why: decision.continuation?.why || "first",
          held: Boolean(decision.continuation?.held),
        },
        facts,
        now
      );
    }
  } else if (shouldRoute(body.model, options)) {
    // 2. Zero-latency (< 1 ms) synchronous fallback inside `moejs`
    const facts = extractRequestFacts(body, ctx);
    const sessionKey = facts.sessionKey || computeSessionKey(body, ctx);
    const sessionState = sessionKey ? store.get(sessionKey, now) : null;
    const candidateModels = options.candidateModels || options.allowedModels;

    const cont = evaluateProviderContinuation(facts, sessionState, {
      now,
      affinityMode: options.affinityMode || options.affinity || "cache",
      availableModels: candidateModels,
      unhealthyModels: options.unhealthyModels,
      store,
      coldAfterMs: options.coldAfterMs,
      cacheTtl: options.cacheTtl,
      models: options.catalog?.models,
      aliases: options.catalog?.aliases,
    });

    if (cont.shouldHold && cont.model) {
      const heldEffort = keepsEffort(
        sessionState,
        cont.effort || sessionState?.effort || "high",
        facts.estimatedInputTokens,
        now,
        {
          ...options,
          isShortFollowup: facts.isShortFollowup,
        }
      );
      if (sessionKey) {
        store.recordRequest(
          sessionKey,
          {
            model: cont.model,
            effort: heldEffort,
            provider: cont.provider || sessionState?.provider || "",
            workKind: sessionState?.workKind || "general_implementation",
            difficulty: sessionState?.difficulty || "routine",
            why: cont.why,
            held: true,
          },
          facts,
          now
        );
      }
      decision = {
        ok: true,
        targetModel: cont.model,
        canonicalModel: canonicalModel(cont.model, options.catalog?.aliases),
        targetEffort: heldEffort,
        modelWithEffort: `${cont.model}:${heldEffort}`,
        workKind: sessionState?.workKind || "general_implementation",
        difficulty: sessionState?.difficulty || "routine",
        continuation: {
          held: true,
          why: cont.why,
          sessionKey,
          turn: facts.turn,
          within: facts.within,
          previousModel: cont.previousModel || cont.model,
          previousEffort: cont.previousEffort || heldEffort,
        },
      };
    } else if (facts.objective) {
      const profile = inferTaskProfile(facts);
      const unhealthyModels = [
        ...store.getUnhealthyModels(now),
        ...(Array.isArray(options.unhealthyModels) ? options.unhealthyModels : []),
      ];
      if (cont.why === "provider_unhealthy" && cont.previousModel) {
        unhealthyModels.push(cont.previousModel);
      }
      const minContextTokens =
        cont.why === "outgrown" ? Number(facts.estimatedInputTokens || 0) : 0;

      decision = selectBestRoute(profile, {
        objective: facts.objective,
        candidateModels,
        catalog: options.catalog,
        unhealthyModels,
        minContextTokens,
        continuity: {
          previousModel: cont.previousModel || null,
          previousEffort: cont.previousEffort || null,
          why: cont.why,
          cacheWarm: false,
        },
      });

      if (!decision.ok && (unhealthyModels.length > 0 || minContextTokens > 0)) {
        decision = selectBestRoute(profile, {
          objective: facts.objective,
          candidateModels,
          catalog: options.catalog,
        });
      }

      if (decision && decision.targetModel) {
        let finalEffort = decision.targetEffort;
        if (
          sessionState &&
          canonicalModel(decision.targetModel) === canonicalModel(sessionState.model) &&
          cont.why !== "cold" &&
          cont.why !== "compacted" &&
          cont.why !== "first" &&
          cont.why !== "worn"
        ) {
          finalEffort = keepsEffort(
            sessionState,
            decision.targetEffort,
            facts.estimatedInputTokens,
            now,
            options
          );
        }
        decision.targetEffort = finalEffort;
        decision.modelWithEffort = `${decision.targetModel}:${finalEffort}`;
        decision.continuation = {
          held: false,
          why: cont.why,
          reasonDetail: cont.reasonDetail || null,
          sessionKey,
          turn: facts.turn,
          within: facts.within,
          previousModel: cont.previousModel || null,
          previousEffort: cont.previousEffort || null,
        };

        if (sessionKey) {
          store.recordRequest(
            sessionKey,
            {
              model: decision.targetModel,
              effort: finalEffort,
              workKind: decision.workKind,
              difficulty: decision.difficulty,
              why: cont.why,
              held: false,
            },
            facts,
            now
          );
        }
      }
    }
  }

  if (!decision || !decision.targetModel) {
    return undefined;
  }

  if (ctx.state && typeof ctx.state === "object") {
    ctx.state.agentcompass = decision;
  }

  applyRoutedModelAndEffort(body, decision, ctx);
  return body;
}

/**
 * Middleware `onResponse(body, ctx)` hook (`internal/middleware/run.go`):
 * Updates token/cache watermarks on success and marks `healthy = false` on upstream error.
 */
export function onResponse(body, ctx = {}) {
  const options = ctx?.options || {};
  const store = options.continuityStore || defaultContinuityStore;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const decision = ctx?.state?.agentcompass;
  const sessionKey =
    decision?.continuation?.sessionKey ||
    computeSessionKey(ctx?.request || {}, ctx) ||
    store.lastActiveSessionKey;

  store.recordResponse(
    sessionKey,
    body,
    {
      ...ctx,
      model: decision?.targetModel || ctx?.model || body?.model,
    },
    now
  );
  return undefined;
}

/**
 * Middleware `onUsage(row, options)` hook (`internal/middleware/run.go:349`):
 * Receives Magpie's per-request usage/status telemetry (`rejected`, `status`, `input_tokens`, `cache_read`, etc.).
 */
export function onUsage(row, options = {}) {
  if (!row || typeof row !== "object") return;
  const store = options?.continuityStore || defaultContinuityStore;
  const now = Number.isFinite(options?.now) ? Number(options.now) : Date.now();
  store.recordUsage(row, now);
}

export function onAccount(account, ctx = {}) {
  const decision = ctx?.state?.agentcompass;
  const options = ctx?.options || {};
  if (!decision || !account) return undefined;

  // Optional account-level allowlist per work_kind if configured in plugin options
  const allowedByKind = options.accountsByWorkKind?.[decision.workKind];
  if (Array.isArray(allowedByKind) && allowedByKind.length > 0) {
    const id = account.account || account.key || account.provider;
    if (id && !allowedByKind.includes(id) && !allowedByKind.includes(account.provider)) {
      return { skip: true };
    }
  }
  return undefined;
}

/**
 * Optional pool seat-ordering strategy (`agentcompass/agentcompass` and `agentcompass/agentcompass-pure`).
 * Prefers non-resting seats with the lowest pace / usage pressure.
 * Returns seat indexes `[0 .. seats.length - 1]` as required by `internal/middleware/points.go:232`
 * and `magpie-community/plugins/scripts/middleware.mjs:order()`.
 */
function agentcompassPureStrategy(_pool, seats, _options) {
  if (!Array.isArray(seats)) return [];
  if (seats.length <= 1) return seats.map((_, i) => i);
  return seats
    .map((_, i) => i)
    .sort((ia, ib) => {
      const a = seats[ia] || {};
      const b = seats[ib] || {};
      if (Boolean(a.resting) !== Boolean(b.resting)) {
        return a.resting ? 1 : -1;
      }
      const aUsed = typeof a.used === "number" ? a.used : 50;
      const bUsed = typeof b.used === "number" ? b.used : 50;
      return aUsed - bUsed || ia - ib;
    });
}

export const strategies = {
  agentcompass: agentcompassPureStrategy,
  "agentcompass-pure": agentcompassPureStrategy,
};
