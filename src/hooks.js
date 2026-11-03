/**
 * Stage 1 of the Two-Stage Tandem Architecture: Async Bun Gateway Hook (`magpie.hooks`)
 *
 * How Magpie executes this hook (`internal/gateway/middleware.go:39` & `internal/plugin/host.js:1374`):
 * 1. Runs in the **Bun** plugin host BEFORE `moejs` middleware (`magpie.middleware`) and BEFORE
 *    model resolution (`s.serve`).
 * 2. Has an asynchronous time budget configurable via `gatewayTimeoutMs` up to **10,000 ms (10 seconds)**
 *    (vs. 20 ms for `strategies` and 250 ms for `moejs` middleware).
 * 3. `host.js:1411` checks that `magpie.hooks` does NOT directly mutate `body.model`, `body.stream`,
 *    `body.tools`, `body.tool_choice`, `body.function_call`, `body.functions`, or `body.toolConfig`.
 * 4. Aligned with Magpie native router (`internal/gateway/affinity.go` & `rules.go`), `hooks.js`
 *    first checks `evaluateProviderContinuation`:
 *    - When `shouldHold === true` (`why: "turn" | "cache" | "followup" | "session" | "strict"`),
 *      it holds the current Provider/Model & monotonic effort (`keepsEffort`) in `< 0.1 ms` with
 *      ZERO external scorer calls.
 *    - Only when selecting or switching a Provider/Model is required (`why: "first" | "provider_unhealthy" |
 *      "capability_outgrown" | "outgrown" | "worn" | "compacted" | "cold"`) does it invoke `scoreTaskLive`
 *      + `selectBestRoute`.
 * 5. Immediately afterwards (`middleware.go:42`), Stage 2 (`src/middleware.js` in `moejs`) reads
 *    and deletes `body.__agentcompass_route`, rewrites `body.model` and reasoning effort in `< 0.2 ms`,
 *    and hands the routed request to `s.serve`.
 */

import { selectBestRoute } from "./allocator.js";
import { canonicalModel } from "./catalog.js";
import {
  computeSessionKey,
  defaultContinuityStore,
  evaluateProviderContinuation,
  keepsEffort,
} from "./continuity.js";
import { extractRequestFacts } from "./profiler-core.js";
import { loadLiveQuotas } from "./quota-loader.js";
import { scoreTaskLive } from "./scorer-live.js";

export const ROUTE_CARRIER_KEY = "__agentcompass_route";

export const DEFAULT_VIRTUAL_MODELS = [
  "auto",
  "agentcompass",
  "agentcompass/auto",
  "intent",
  "group/intent",
  "group/agentcompass",
];

/**
 * Determine whether this request should be routed by AgentCompass.
 */
export function shouldRouteRequest(model, options = {}) {
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

export async function onRequest(body, ctx = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    ctx.report?.("skipped");
    return undefined;
  }

  const options = ctx.options || {};
  const scorerCfg = options.scorer && typeof options.scorer === "object" ? options.scorer : {};
  const facts = extractRequestFacts(body, ctx);

  if (!shouldRouteRequest(facts.model, options)) {
    ctx.report?.("skipped");
    return undefined;
  }

  const store = options.continuityStore || defaultContinuityStore;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const sessionKey = facts.sessionKey || computeSessionKey(body, ctx);
  const sessionState = sessionKey ? store.get(sessionKey, now) : null;
  const candidateModels = options.candidateModels || options.allowedModels;
  const liveQuotas = loadLiveQuotas(options, now);

  const cont = evaluateProviderContinuation(facts, sessionState, {
    now,
    affinityMode: options.affinityMode || options.affinity || "cache",
    availableModels: candidateModels,
    unhealthyModels: options.unhealthyModels,
    quotas: liveQuotas,
    policy: options.catalog?.policy,
    store,
    coldAfterMs: options.coldAfterMs,
    cacheTtl: options.cacheTtl,
    models: options.catalog?.models,
    aliases: options.catalog?.aliases,
  });

  // Fast path: Hold active session Provider/Model without calling the intent classifier
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
    const canonical = canonicalModel(cont.model, options.catalog?.aliases);
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

    const carrier = {
      v: 1,
      targetModel: cont.model,
      canonicalModel: canonical,
      targetEffort: heldEffort,
      modelWithEffort: `${cont.model}:${heldEffort}`,
      workKind: sessionState?.workKind || "general_implementation",
      difficulty: sessionState?.difficulty || "routine",
      requiredAbility: null,
      score: null,
      components: null,
      profile: null,
      scorer: {
        kind: "continuity_hold",
        held: true,
        why: cont.why,
        calls: 0,
      },
      continuation: {
        held: true,
        why: cont.why,
        sessionKey,
        turn: facts.turn,
        within: facts.within,
        previousModel: cont.previousModel || cont.model,
        previousEffort: cont.previousEffort || heldEffort,
      },
      topCandidates: [],
    };

    const next = {
      ...body,
      [ROUTE_CARRIER_KEY]: carrier,
    };

    const payloadBytes = JSON.stringify(carrier).length;
    ctx.state = ctx.state || {};
    ctx.state.sessionKey = sessionKey;
    ctx.state.route = carrier;
    ctx.report?.("ready", payloadBytes);
    return next;
  }

  if (!facts.objective) {
    ctx.report?.("empty");
    return undefined;
  }

  const envScorerUrl = globalThis.process?.env?.AGENTCOMPASS_SCORER_URL || "";
  const envScorerTimeout = Number(globalThis.process?.env?.AGENTCOMPASS_SCORER_TIMEOUT_MS) || 0;
  const preferHeuristic =
    options.prefer_local_heuristic === true ||
    scorerCfg.prefer_local_heuristic === true ||
    globalThis.process?.env?.AGENTCOMPASS_PREFER_LOCAL_HEURISTIC === "1";

  const { profile, meta } = await scoreTaskLive(facts, {
    scorerType: preferHeuristic
      ? "heuristic"
      : options.scorerType ||
        scorerCfg.kind ||
        scorerCfg.type ||
        (envScorerUrl ? "openai_compatible" : "heuristic"),
    scorerModel:
      options.scorerModel || scorerCfg.model || globalThis.process?.env?.AGENTCOMPASS_SCORER_MODEL,
    scorerBaseUrl: options.scorerBaseUrl || scorerCfg.baseUrl || envScorerUrl,
    scorerApiKey:
      options.scorerApiKey ||
      scorerCfg.apiKey ||
      globalThis.process?.env?.AGENTCOMPASS_SCORER_API_KEY,
    jevBaseUrl: options.jevBaseUrl || scorerCfg.jevBaseUrl,
    jevApiKey: options.jevApiKey || scorerCfg.jevApiKey,
    scorerTimeoutMs:
      options.scorerTimeoutMs ||
      scorerCfg.timeoutMs ||
      envScorerTimeout ||
      Math.max(500, (options.gatewayTimeoutMs || 8000) - 500),
    useCache: options.useCache !== false && scorerCfg.useCache !== false,
    signal: ctx.signal,
    fetch: options.fetch,
  });

  const unhealthyModels = [
    ...store.getUnhealthyModels(now),
    ...(Array.isArray(options.unhealthyModels) ? options.unhealthyModels : []),
  ];
  if (cont.why === "provider_unhealthy" && cont.previousModel) {
    unhealthyModels.push(cont.previousModel);
  }

  const minContextTokens =
    cont.why === "outgrown" ? Number(facts.estimatedInputTokens || 0) : 0;

  let decision = selectBestRoute(profile, {
    objective: facts.objective,
    candidateModels,
    catalog: options.catalog,
    unhealthyModels,
    minContextTokens,
    quotas: liveQuotas,
    meteredOk: options.meteredOk,
    now,
    continuity: {
      previousModel: cont.previousModel || null,
      previousEffort: cont.previousEffort || null,
      why: cont.why,
      cacheWarm: false,
    },
  });

  // Graceful fallback if all candidates were filtered out by temporary unhealthy/context/quota constraints
  if (!decision.ok && (unhealthyModels.length > 0 || minContextTokens > 0 || liveQuotas)) {
    decision = selectBestRoute(profile, {
      objective: facts.objective,
      candidateModels,
      catalog: options.catalog,
      now,
    });
  }

  if (!decision.ok || !decision.targetModel) {
    ctx.report?.("empty");
    return undefined;
  }

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

  // Attach transient routing carrier for Stage 2 (`src/middleware.js` in `moejs`).
  // Never mutate `model`, `tools`, `tool_choice`, `function_call`, `functions`, `toolConfig`, or `stream` here!
  const carrier = {
    v: 1,
    targetModel: decision.targetModel,
    canonicalModel: decision.canonicalModel,
    targetEffort: finalEffort,
    modelWithEffort: `${decision.targetModel}:${finalEffort}`,
    selectedAccount: decision.selectedAccount || null,
    quota: decision.quota || null,
    workKind: decision.workKind,
    difficulty: decision.difficulty,
    requiredAbility: decision.requiredAbility,
    score: decision.score,
    components: decision.components,
    profile: decision.profile,
    scorer: meta,
    continuation: {
      held: false,
      why: cont.why,
      reasonDetail: cont.reasonDetail || null,
      sessionKey,
      turn: facts.turn,
      within: facts.within,
      previousModel: cont.previousModel || null,
      previousEffort: cont.previousEffort || null,
    },
    topCandidates: decision.topCandidates,
  };

  const next = {
    ...body,
    [ROUTE_CARRIER_KEY]: carrier,
  };

  const payloadBytes = JSON.stringify(carrier).length;
  ctx.state = ctx.state || {};
  ctx.state.sessionKey = sessionKey;
  ctx.state.route = carrier;
  ctx.report?.("ready", payloadBytes);
  return next;
}

export async function onResponse(reply, ctx = {}) {
  const options = ctx?.options || {};
  const store = options.continuityStore || defaultContinuityStore;
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const sessionKey =
    ctx?.state?.sessionKey ||
    ctx?.state?.route?.continuation?.sessionKey ||
    computeSessionKey(ctx?.request || {}, ctx);

  store.recordResponse(
    sessionKey,
    reply,
    {
      ...ctx,
      model: ctx?.state?.route?.targetModel || ctx?.model || reply?.model,
    },
    now
  );
  return undefined;
}
