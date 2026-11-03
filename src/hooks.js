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
 * 4. Therefore, `hooks.js` performs the async System-One 10-field task profiling + AgentCompass
 *    multi-dimensional allocation within the 10s Bun budget, and writes the routing verdict into a
 *    transient carrier property `body.__agentcompass_route`.
 * 5. Immediately afterwards (`middleware.go:42`), Stage 2 (`src/middleware.js` in `moejs`) reads
 *    and deletes `body.__agentcompass_route`, rewrites `body.model` and reasoning effort in `< 0.2 ms`,
 *    and hands the routed request to `s.serve`!
 */

import { selectBestRoute } from "./allocator.js";
import { extractRequestFacts } from "./profiler-core.js";
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
  const triggers = Array.isArray(options.triggerModels) && options.triggerModels.length > 0
    ? options.triggerModels.map((m) => String(m).trim().toLowerCase())
    : DEFAULT_VIRTUAL_MODELS;
  return triggers.includes(clean) || clean.startsWith("agentcompass/");
}

export async function onRequest(body, ctx = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    ctx.report?.("skipped");
    return undefined;
  }

  const options = ctx.options || {};
  const facts = extractRequestFacts(body, ctx);

  if (!shouldRouteRequest(facts.model, options)) {
    ctx.report?.("skipped");
    return undefined;
  }

  if (!facts.objective) {
    ctx.report?.("empty");
    return undefined;
  }

  const { profile, meta } = await scoreTaskLive(facts, {
    scorerType: options.scorerType || "heuristic",
    scorerModel: options.scorerModel,
    scorerBaseUrl: options.scorerBaseUrl,
    scorerApiKey: options.scorerApiKey,
    jevBaseUrl: options.jevBaseUrl,
    jevApiKey: options.jevApiKey,
    scorerTimeoutMs: options.scorerTimeoutMs || Math.max(500, (options.gatewayTimeoutMs || 8000) - 500),
    useCache: options.useCache !== false,
    signal: ctx.signal,
    fetch: options.fetch,
  });

  const decision = selectBestRoute(profile, {
    objective: facts.objective,
    candidateModels: options.candidateModels,
    catalog: options.catalog,
  });

  if (!decision.ok || !decision.targetModel) {
    ctx.report?.("empty");
    return undefined;
  }

  // Attach transient routing carrier for Stage 2 (`src/middleware.js` in `moejs`).
  // Never mutate `model`, `tools`, `tool_choice`, `function_call`, `functions`, `toolConfig`, or `stream` here!
  const carrier = {
    v: 1,
    targetModel: decision.targetModel,
    canonicalModel: decision.canonicalModel,
    targetEffort: decision.targetEffort,
    modelWithEffort: decision.modelWithEffort,
    workKind: decision.workKind,
    difficulty: decision.difficulty,
    requiredAbility: decision.requiredAbility,
    score: decision.score,
    components: decision.components,
    profile: decision.profile,
    scorer: meta,
    topCandidates: decision.topCandidates,
  };

  const next = {
    ...body,
    [ROUTE_CARRIER_KEY]: carrier,
  };

  const payloadBytes = JSON.stringify(carrier).length;
  ctx.state = ctx.state || {};
  ctx.state.route = carrier;
  ctx.report?.("ready", payloadBytes);
  return next;
}

export async function onResponse(_reply, _ctx) {
  return undefined;
}
