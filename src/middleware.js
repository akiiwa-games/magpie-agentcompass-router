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
import { orderSeatsByQuotaEconomics } from "./quota.js";

const ROUTE_CARRIER_KEY = "__agentcompass_route";

const DEFAULT_VIRTUAL_MODELS = [
  "agentcompass",
  "agentcompass/auto",
  "agentcompass/intent",
  "agentcompass/system-one-0.5",
];

function stripEffortSuffix(rawModel) {
  if (!rawModel || typeof rawModel !== "string") return "";
  const trimmed = rawModel.trim();
  const colonIdx = trimmed.lastIndexOf(":");
  if (colonIdx > 0) {
    const suffix = trimmed.slice(colonIdx + 1).toLowerCase();
    if (["none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto"].includes(suffix)) {
      return trimmed.slice(0, colonIdx);
    }
  }
  return trimmed;
}

function isVirtualModelName(model, options = {}) {
  if (!model || typeof model !== "string") return false;
  const clean = stripEffortSuffix(model).toLowerCase();
  if (clean === "agentcompass" || clean.startsWith("agentcompass/")) {
    return true;
  }
  const triggerList = options.triggerModels || options.routeModelTriggers;
  if (Array.isArray(triggerList) && triggerList.length > 0) {
    return triggerList.some((m) => String(m).trim().toLowerCase() === clean);
  }
  return DEFAULT_VIRTUAL_MODELS.includes(clean);
}

function extractModelList(source) {
  if (!source) return null;
  if (Array.isArray(source)) {
    const list = source
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          return String(item.id || item.name || item.model || "").trim();
        }
        return "";
      })
      .filter(Boolean);
    return list.length > 0 ? list : null;
  }
  if (typeof source === "object") {
    const keys = Object.keys(source)
      .map((k) => k.trim())
      .filter(Boolean);
    return keys.length > 0 ? keys : null;
  }
  return null;
}

function resolveCandidateModels(body, ctx = {}, options = {}) {
  const explicit =
    extractModelList(options.candidateModels) ||
    extractModelList(options.allowedModels) ||
    extractModelList(options.availableModels) ||
    extractModelList(options.models) ||
    extractModelList(ctx?.models) ||
    extractModelList(ctx?.availableModels) ||
    extractModelList(body?.available_models) ||
    extractModelList(ctx?.provider?.models) ||
    extractModelList(options.modelMap);

  if (explicit) {
    return { candidateModels: explicit, hasExplicitCandidates: true, canRewriteModel: true };
  }

  if (options.allowUnconstrainedCatalog === true) {
    return { candidateModels: null, hasExplicitCandidates: false, canRewriteModel: true };
  }

  const rawModel = stripEffortSuffix(body?.model || ctx?.model || "");
  if (rawModel && !isVirtualModelName(rawModel, options)) {
    return {
      candidateModels: [rawModel],
      hasExplicitCandidates: false,
      canRewriteModel: true,
    };
  }

  const fallback = String(options.defaultModel || options.fallbackModel || "").trim();
  if (fallback) {
    return {
      candidateModels: [fallback],
      hasExplicitCandidates: false,
      canRewriteModel: true,
    };
  }

  return { candidateModels: null, hasExplicitCandidates: false, canRewriteModel: false };
}

function shouldRoute(model, options = {}) {
  if (!model || typeof model !== "string") return false;
  if (options.routeAllModels === true) return true;
  return isVirtualModelName(model, options);
}

function applyProtocolEffortOnly(body, targetEffort, ctx = {}) {
  const options = ctx?.options || {};
  const protocol = String(ctx?.protocol || "").toLowerCase();
  if (options.injectProtocolEffort !== true || !targetEffort) return body;

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
  return body;
}

/**
 * Apply the selected effort to the request body according to the client protocol,
 * or encode `<model>:<effort>` which Magpie's `askedAt` (`internal/gateway/gateway.go:1560`)
 * natively parses and applies to every upstream candidate!
 */
export function applyRoutedModelAndEffort(body, decision, ctx = {}) {
  const options = ctx?.options || {};
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

  applyProtocolEffortOnly(body, targetEffort, ctx);

  return body;
}

export function onRequest(body, ctx = {}) {
  let carrierFromBody = null;
  try {
    if (body && typeof body === "object" && !Array.isArray(body)) {
      if (body[ROUTE_CARRIER_KEY] && typeof body[ROUTE_CARRIER_KEY] === "object") {
        carrierFromBody = body[ROUTE_CARRIER_KEY];
      }
      if (ROUTE_CARRIER_KEY in body) {
        delete body[ROUTE_CARRIER_KEY];
      }
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return undefined;
    }

    const options = ctx.options || {};
    const store = options.continuityStore || defaultContinuityStore;
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const { candidateModels, hasExplicitCandidates, canRewriteModel } = resolveCandidateModels(
      body,
      ctx,
      options
    );
    let decision = null;

    // 1. Check if Stage 1 (`src/hooks.js`) or shared `ctx.state` provided a pre-computed decision
    const stateRoute =
      carrierFromBody ||
      (ctx?.state?.route && typeof ctx.state.route === "object" ? ctx.state.route : null);

    if (stateRoute) {
      decision = stateRoute;
      // If `middleware` has explicit candidateModels that `hooks` did not have, re-select within `candidateModels`
      if (
        hasExplicitCandidates &&
        !decision.hasExplicitCandidates &&
        decision.profile &&
        Array.isArray(candidateModels) &&
        !candidateModels.includes(decision.targetModel)
      ) {
        const constrained = selectBestRoute(decision.profile, {
          objective: "",
          candidateModels,
          catalog: options.catalog,
          quotas: options.quotas,
          meteredOk: options.meteredOk,
          now,
        });
        if (constrained.ok && constrained.targetModel) {
          decision = {
            ...decision,
            targetModel: constrained.targetModel,
            canonicalModel: constrained.canonicalModel,
            targetEffort: constrained.targetEffort || decision.targetEffort,
            modelWithEffort: `${constrained.targetModel}:${constrained.targetEffort || decision.targetEffort}`,
            canRewriteModel: true,
            hasExplicitCandidates: true,
          };
        }
      }

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
      // 2. Zero-latency (< 1 ms) synchronous execution inside `moejs`
      const facts = extractRequestFacts(body, ctx);
      const sessionKey = facts.sessionKey || computeSessionKey(body, ctx);
      const sessionState = sessionKey ? store.get(sessionKey, now) : null;

      const cont = evaluateProviderContinuation(facts, sessionState, {
        now,
        affinityMode: options.affinityMode || options.affinity || "cache",
        availableModels: candidateModels,
        unhealthyModels: options.unhealthyModels,
        quotas: options.quotas,
        policy: options.catalog?.policy,
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
          canRewriteModel,
          hasExplicitCandidates,
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
          quotas: options.quotas,
          meteredOk: options.meteredOk,
          now,
          continuity: {
            previousModel: cont.previousModel || null,
            previousEffort: cont.previousEffort || null,
            why: cont.why,
            cacheWarm: false,
          },
        });

        if (!decision.ok && (unhealthyModels.length > 0 || minContextTokens > 0 || options.quotas)) {
          decision = selectBestRoute(profile, {
            objective: facts.objective,
            candidateModels,
            catalog: options.catalog,
            now,
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
          decision.canRewriteModel = canRewriteModel;
          decision.hasExplicitCandidates = hasExplicitCandidates;
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
      return carrierFromBody ? body : undefined;
    }

    ctx.state = ctx.state || {};
    ctx.state.agentcompass = decision;
    ctx.state.route = decision;

    const allowModelRewrite =
      canRewriteModel ||
      decision.canRewriteModel === true ||
      decision.hasExplicitCandidates === true ||
      Boolean(carrierFromBody);

    if (!allowModelRewrite) {
      if (options.injectProtocolEffort === true) {
        applyProtocolEffortOnly(body, decision.targetEffort, ctx);
        return body;
      }
      return undefined;
    }

    applyRoutedModelAndEffort(body, decision, ctx);
    return body;
  } finally {
    if (body && typeof body === "object" && !Array.isArray(body) && ROUTE_CARRIER_KEY in body) {
      delete body[ROUTE_CARRIER_KEY];
    }
  }
}

/**
 * Middleware `onProvider(body, ctx)` hook (`internal/middleware/run.go:Tried`):
 * When `ctx.provider` exposes a provider's available `models` (or `options.modelsByProvider[provider.id]`),
 * selects the best model within that provider's catalog and ensures `__agentcompass_route` never leaks.
 */
export function onProvider(body, ctx = {}) {
  try {
    if (body && typeof body === "object" && !Array.isArray(body) && ROUTE_CARRIER_KEY in body) {
      delete body[ROUTE_CARRIER_KEY];
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return undefined;
    }

    const options = ctx?.options || {};
    const prov = ctx?.provider && typeof ctx.provider === "object" ? ctx.provider : null;
    const providerModels =
      extractModelList(prov?.models) ||
      extractModelList(options.modelsByProvider?.[prov?.id]) ||
      extractModelList(options.modelsByProvider?.[prov?.name]);

    const prevDecision = ctx?.state?.agentcompass || ctx?.state?.route;
    if (providerModels && providerModels.length > 0 && prevDecision?.profile) {
      const needProviderRoute =
        isVirtualModelName(body.model, options) ||
        prevDecision.canRewriteModel === false ||
        options.routePerProvider === true;

      if (needProviderRoute) {
        const routed = selectBestRoute(prevDecision.profile, {
          objective: "",
          candidateModels: providerModels,
          catalog: options.catalog,
          quotas: options.quotas,
          meteredOk: options.meteredOk,
        });
        if (routed.ok && routed.targetModel) {
          const updated = {
            ...prevDecision,
            targetModel: routed.targetModel,
            canonicalModel: routed.canonicalModel,
            targetEffort: routed.targetEffort || prevDecision.targetEffort || "high",
            modelWithEffort: `${routed.targetModel}:${routed.targetEffort || prevDecision.targetEffort || "high"}`,
            canRewriteModel: true,
            hasExplicitCandidates: true,
          };
          if (ctx.state && typeof ctx.state === "object") {
            ctx.state.agentcompass = updated;
            ctx.state.route = updated;
          }
          applyRoutedModelAndEffort(body, updated, ctx);
          return body;
        }
      }
    }
    return undefined;
  } finally {
    if (body && typeof body === "object" && !Array.isArray(body) && ROUTE_CARRIER_KEY in body) {
      delete body[ROUTE_CARRIER_KEY];
    }
  }
}

/**
 * Middleware `onResponse(body, ctx)` hook (`internal/middleware/run.go`):
 * Updates token/cache watermarks on success and marks `healthy = false` on upstream error.
 */
export function onResponse(body, ctx = {}) {
  try {
    if (body && typeof body === "object" && !Array.isArray(body) && ROUTE_CARRIER_KEY in body) {
      delete body[ROUTE_CARRIER_KEY];
    }
    const options = ctx?.options || {};
    const store = options.continuityStore || defaultContinuityStore;
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const decision = ctx?.state?.agentcompass || ctx?.state?.route;
    const sessionKey =
      decision?.continuation?.sessionKey ||
      ctx?.state?.sessionKey ||
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
  } finally {
    if (body && typeof body === "object" && !Array.isArray(body) && ROUTE_CARRIER_KEY in body) {
      delete body[ROUTE_CARRIER_KEY];
    }
  }
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

/**
 * Middleware `onAccount(account, ctx)` hook (`internal/middleware/account.go:58`):
 * Magpie passes `{ref, provider, name, kind, model}` as the first argument AND sets `ctx.account` to it.
 * Also supports `(body, ctx)` where `ctx` or `ctx.account` carries `{ref, provider, name, kind, model}`,
 * as well as legacy `{provider, account, key}` shapes.
 */
export function onAccount(accountOrBody, ctx = {}) {
  try {
    if (
      accountOrBody &&
      typeof accountOrBody === "object" &&
      !Array.isArray(accountOrBody) &&
      ROUTE_CARRIER_KEY in accountOrBody
    ) {
      delete accountOrBody[ROUTE_CARRIER_KEY];
    }

    const decision = ctx?.state?.agentcompass || ctx?.state?.route;
    const options = ctx?.options || {};
    if (!decision) return undefined;

    const acct =
      ctx?.account && typeof ctx.account === "object"
        ? ctx.account
        : accountOrBody &&
            typeof accountOrBody === "object" &&
            (accountOrBody.ref ||
              accountOrBody.provider ||
              accountOrBody.name ||
              accountOrBody.kind ||
              accountOrBody.account ||
              accountOrBody.key)
          ? accountOrBody
          : ctx;

    if (!acct || typeof acct !== "object") return undefined;

    const allowedByKind = options.accountsByWorkKind?.[decision.workKind];
    if (Array.isArray(allowedByKind) && allowedByKind.length > 0) {
      const identifiers = [
        acct.ref,
        acct.name,
        acct.provider,
        acct.kind,
        acct.provider && acct.name ? `${acct.provider}/${acct.name}` : "",
        acct.account,
        acct.key,
      ]
        .filter((v) => typeof v === "string" && v.trim())
        .map((v) => v.trim());

      if (identifiers.length > 0 && !identifiers.some((id) => allowedByKind.includes(id))) {
        return { skip: true };
      }
    }
    return undefined;
  } finally {
    if (
      accountOrBody &&
      typeof accountOrBody === "object" &&
      !Array.isArray(accountOrBody) &&
      ROUTE_CARRIER_KEY in accountOrBody
    ) {
      delete accountOrBody[ROUTE_CARRIER_KEY];
    }
  }
}

/**
 * Pool seat-ordering strategy (`agentcompass/agentcompass` and `agentcompass/agentcompass-pure`).
 * Combines Magpie's `Seat` telemetry (`account`, `known`, `learns`, `used`, `soon`, `pace`, `resting`, `tokens`)
 * with AgentCompass's subscription opportunity-cost and pre-reset surplus sprint economics.
 * Returns seat indexes `[0 .. seats.length - 1]` as required by `internal/middleware/points.go:232`
 * and `magpie-community/plugins/scripts/middleware.mjs:order()`.
 */
export const strategies = {
  agentcompass: orderSeatsByQuotaEconomics,
  "agentcompass-pure": orderSeatsByQuotaEconomics,
};
