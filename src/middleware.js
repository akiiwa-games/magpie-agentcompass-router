/**
 * Stage 2 of the Two-Stage Tandem Architecture: Sync JS Gateway Middleware (`magpie.middleware`)
 *
 * Runs inside Magpie's in-process `moejs` VM (`internal/middleware/run.go`, 250 ms budget)
 * immediately after `magpie.hooks` (`src/hooks.js`) and right before `s.serve` resolves the
 * target model and effort (`internal/gateway/middleware.go:42-78`).
 *
 * Capabilities in `src/middleware.js`:
 * 1. Consumes and deletes the transient `body.__agentcompass_route` carrier populated by
 *    Stage 1 (`src/hooks.js` in Bun with up to 10,000 ms budget).
 * 2. If `magpie.hooks` was not enabled or timed out, runs the built-in `< 1 ms` deterministic
 *    10-field task profiler (`inferTaskProfile`) + AgentCompass multi-dimensional allocator
 *    (`selectBestRoute`) directly inside `moejs`!
 * 3. Rewrites `body.model` (using either `<model>:<effort>` which `gateway.go:askedAt` natively
 *    splits, or bare `<model>` plus protocol-specific reasoning effort fields).
 * 4. Implements `onAccount(account, ctx)` to optionally filter accounts, and exports a
 *    `strategies["agentcompass-pure"]` seat-ordering strategy.
 */

import { selectBestRoute } from "./allocator.js";
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
  const triggers = Array.isArray(triggerList) && triggerList.length > 0
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
    typeof options.modelPrefix === "string" && options.modelPrefix.trim() && !mappedModel.includes("/")
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
        ...(body.output_config && typeof body.output_config === "object" ? body.output_config : {}),
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
  let decision = null;

  // 1. Check if Stage 1 (`src/hooks.js` in Bun) attached a pre-computed decision carrier
  if (body[ROUTE_CARRIER_KEY] && typeof body[ROUTE_CARRIER_KEY] === "object") {
    decision = body[ROUTE_CARRIER_KEY];
    delete body[ROUTE_CARRIER_KEY];
  } else if (shouldRoute(body.model, options)) {
    // 2. Zero-latency (< 1 ms) synchronous fallback inside `moejs`
    const facts = extractRequestFacts(body, ctx);
    if (facts.objective) {
      const profile = inferTaskProfile(facts);
      decision = selectBestRoute(profile, {
        objective: facts.objective,
        candidateModels: options.candidateModels || options.allowedModels,
        catalog: options.catalog,
      });
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
 */
function agentcompassPureStrategy(_pool, seats, _options) {
  if (!Array.isArray(seats) || seats.length <= 1) return seats;
  return [...seats]
    .sort((a, b) => {
      if (Boolean(a.resting) !== Boolean(b.resting)) {
        return a.resting ? 1 : -1;
      }
      const aUsed = typeof a.used === "number" ? a.used : 50;
      const bUsed = typeof b.used === "number" ? b.used : 50;
      return aUsed - bUsed;
    })
    .map((s) => s.key);
}

export const strategies = {
  agentcompass: agentcompassPureStrategy,
  "agentcompass-pure": agentcompassPureStrategy,
};
