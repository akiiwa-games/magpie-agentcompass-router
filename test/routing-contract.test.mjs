/**
 * One regression test per finding of the routing review (contract R1-R6). Modules are imported as namespaces so that, run
 * against the code before the fix, a missing export fails its own test and not the whole file.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as allocator from "../src/allocator.js";
import * as catalog from "../src/catalog.js";
import * as continuity from "../src/continuity.js";
import * as hooks from "../src/hooks.js";
import * as index from "../src/index.js";
import * as middleware from "../src/middleware.js";
import * as profiler from "../src/profiler-core.js";
import * as quota from "../src/quota.js";
import * as scorer from "../src/scorer-live.js";

const { rankCandidates, selectBestRoute } = allocator;
const { SessionContinuityStore } = continuity;
const NOW = 1790000000000;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PROFILE = {
  multi_task: false,
  task_count: "1",
  work_kind: "general_implementation",
  reasoning_depth: 2,
  code_complexity: 2,
  context_scale: 2,
  divergence: 1,
  hallucination_risk: 2,
  error_cost: 2,
  needs_visual: false,
  needs_gui: false,
  local_only: false,
  interaction_style: "engineering",
};
const REALTIME = { ...PROFILE, realtime_loop: true };
const ROUTINE = { ...PROFILE, reasoning_depth: 1, code_complexity: 0, hallucination_risk: 1, error_cost: 1 };

const TASK = "Implement the parser module and its unit tests";
const request = (extra = {}) => ({ model: "agentcompass/auto", messages: [{ role: "user", content: TASK }], ...extra });
const context = (options, extra = {}) => ({
  state: {},
  reject: (status, message) => ({ rejected: status, message }),
  options: { continuityStore: new SessionContinuityStore(), now: NOW, ...options },
  ...extra,
});
const candidate = (ranked, id) => ranked.allCandidates.find((c) => c.id === id);
const SYSTEM_ONE_QUESTIONS = {
  intent: { type: "choice", criteria: { general_implementation: "implementation", bounded_bulk_work: "routine" } },
  effort: { type: "score", criteria: ["low", "medium", "high", "xhigh"] },
};
const systemOne = (state, options) =>
  index.handleSystemOneRequest({ model: "jev-6b-int8", state: { message: TASK, ...state }, questions: SYSTEM_ONE_QUESTIONS }, options);

/** An external classifier answering `answer`, counting its calls. */
function classifier(answer) {
  const calls = { count: 0 };
  const reply = JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] });
  const options = {
    scorerType: "openai_compatible",
    allowExternalScorer: true,
    scorerBaseUrl: "http://127.0.0.1:9/v1",
    scorerApiKey: "k",
    scorerModel: "m",
    fetch: async () => {
      calls.count += 1;
      return { ok: true, status: 200, text: async () => reply, json: async () => JSON.parse(reply) };
    },
  };
  return { options, calls };
}

// ---------------------------------------------------------------------------- R1: one parser

test("M-1.1 unhealthy models match on the parsed key, and on the raw name for a family or unknown one", () => {
  const dated = rankCandidates(PROFILE, { candidateModels: ["gpt-6.1-sol-20261001:high"], unhealthyModels: ["gpt-6.1-sol"] });
  assert.equal(dated.allCandidates[0].eligible, false);
  const named = rankCandidates(PROFILE, { candidateModels: ["gpt-6.1-sol:high"], unhealthyModels: ["gpt-6.1-sol-20261001"] });
  assert.equal(named.allCandidates[0].eligible, false);
  for (const raw of ["gemini-2.5-pro", "totally-unknown-model"]) {
    const ranked = rankCandidates(PROFILE, { candidateModels: [`${raw}:high`], unhealthyModels: [raw] });
    assert.equal(ranked.allCandidates[0].eligible, false, raw);
  }
});

test("M-1.2 the continuity bonus reaches a dated or preview spelling of the previous model", () => {
  for (const [model, previousModel] of [
    ["claude-opus-5-5-20261001", "claude-opus-5-5-20261001"],
    ["claude-opus-5-5-20261001", "claude-opus-5-5"],
    ["claude-opus-5-5", "claude-opus-5-5-latest"],
  ]) {
    const ranked = rankCandidates(PROFILE, {
      candidateModels: [`${model}:high`],
      continuity: { previousModel, previousEffort: "high", cacheWarm: true, why: "cold" },
    });
    assert.ok(ranked.allCandidates[0].components.continuity > 0, `${model} after ${previousModel}`);
  }
});

test("M-1.3 tier, curves and speed read one parse: own row for an exact or alias name, the shrunk target with default speed for a family", () => {
  for (const name of ["claude-opus-4-6", "claude-opus-5-5-20261001", "gemini-4-argon", "minimax-m4", "o4-mini-2025-04-16", "glm-6-flash"]) {
    assert.equal(catalog.resolveModelSpec(name).canonical, catalog.resolveResponsivenessModelKey(name).key, name);
  }
  assert.notEqual(catalog.resolveModelSpec("minimax-m4").spec.tier, catalog.DEFAULT_MODELS["gpt-6.1-sol"].tier);
  assert.equal(catalog.resolveModelSpec("claude-opus-4-6").canonical, "claude-opus-4-6");
  assert.notEqual(catalog.DEFAULT_MODELS["claude-opus-4-6"].tier, catalog.DEFAULT_MODELS["claude-opus-5-5"].tier);

  const { source, key } = catalog.resolveModel("gemini-2.5-pro");
  assert.equal(source, "family");
  const target = catalog.DEFAULT_MODELS[key];
  assert.ok(Math.abs(catalog.resolveModelSpec("gemini-2.5-pro").spec.tier - (target.tier - 0.3)) < 1e-9);
  const speed = allocator.bundleResponsiveness({ model: "gemini-2.5-pro", effort: "high" });
  assert.equal(speed.value, 0.52);
  assert.equal(speed.source, "default");
  // A `:effort` in the name constrains the effort, it is not part of the key
  assert.equal(catalog.resolveModel("gpt-6-astra:high").key, "gpt-6-astra");
  assert.equal(catalog.resolveModel("gpt-6-astra:high").effort, "high");
});

test("M-1.4 quota: o4 is an OpenAI family, a window binds the raw name, and a flat curve is read as flat", () => {
  const window = { id: "five_hour", used: 50, reset_at: "2030-01-01T00:00:00Z" };
  const codex = { "codex/main": { kind: "subscription", quota: { windows: [window] } } };
  assert.equal(quota.providerMatchesModel("codex", "o4-mini-2025-04-16"), true);
  assert.notEqual(quota.evaluateModelQuota("o4-mini-2025-04-16", "high", { difficulty: "hard", hours: 1 }, codex, {}, NOW), null);

  const bound = { "claude/main": { kind: "subscription", quota: { windows: [{ id: "weekly", used: 99.9, reset_at: "2030-01-01T00:00:00Z", models: ["claude-opus-4-6"] }] } } };
  assert.equal(quota.evaluateModelQuota("claude-opus-4-6", "high", { difficulty: "hard", hours: 1 }, bound, {}, NOW).eligible, false);
  assert.equal(quota.windowBindsModel("weekly", "claude-opus-4-6", ["claude-opus-4-6"], "anthropic/claude-opus-4-6"), true);
  assert.equal(quota.windowBindsModel("weekly", "claude-opus-5-5", ["claude-opus-4-6"], "claude-opus-5-5"), false);

  assert.deepEqual(catalog.EFFORT_CURVES["glm-5.3"].burn, { default: catalog.EFFORT_CURVES["glm-5.3"].burn.default, high: catalog.EFFORT_CURVES["glm-5.3"].burn.high });
});

test("B-1.5 extractModelList keeps object entries and never takes an id for a model name", () => {
  const entry = { id: "seat_a", provider: "codex", account: "codex", model: "gpt-6.1-sol", efforts: ["medium"] };
  assert.deepEqual(hooks.extractModelList([entry]), [entry]);

  const body = request();
  middleware.onRequest(body, context({ candidateModels: [entry] }));
  assert.equal(body.model, "gpt-6.1-sol:medium");

  const ctx = context({ candidateModels: [entry] });
  const viaHooks = request();
  return hooks.onRequest(viaHooks, ctx).then(() => {
    assert.equal(ctx.state.route.targetModel, "gpt-6.1-sol");
    assert.equal(ctx.state.route.targetEffort, "medium");
  });
});

// ---------------------------------------------------------------------------- R2: the efforts a candidate may use

test("B-2.1 `model:effort` in a pool is a fixed effort: too slow is excluded, not stepped down", () => {
  const ranked = rankCandidates(REALTIME, { candidateModels: ["gpt-6-astra:high"] });
  const astra = ranked.allCandidates[0];
  assert.equal(astra.effort, "high");
  assert.equal(astra.realtime_stepped_from, undefined);
  assert.equal(astra.eligible, false);
  assert.match(astra.excluded.join("; "), /gpt-6-astra@high: responsiveness 0\.00 below the realtime_loop floor 0\.5/);
  assert.equal(selectBestRoute(REALTIME, { candidateModels: ["gpt-6-astra:high"] }).targetModel ?? null, null);
});

test("B-2.2 step-down lands only on what the candidate or pool offers, and each effort of an entry has its own id", () => {
  const listed = rankCandidates(REALTIME, { candidateModels: [{ provider: "codex", account: "codex", model: "gpt-6-astra", efforts: ["high"] }] });
  assert.equal(listed.allCandidates[0].effort, "high");
  assert.equal(listed.allCandidates[0].eligible, false);
  assert.ok(listed.allCandidates[0].excluded.length > 0);

  const pool = rankCandidates(REALTIME, { candidateModels: ["gpt-6-astra:low", "gpt-6-astra:high"] });
  assert.equal(pool.selected.effort, "low");
  assert.equal(candidate(pool, "gpt-6-astra:high").effort, "high");

  const split = rankCandidates(REALTIME, { candidateModels: [{ id: "a", provider: "codex", account: "codex", model: "gpt-6-astra", efforts: ["medium", "high"] }] });
  assert.equal(new Set(split.allCandidates.map((c) => c.id)).size, 2);
  assert.equal(split.selected.effort, "medium");

  // Disabled on the same account and model: not a landing
  const opus = { provider: "claude", account: "claude", model: "claude-opus-5-5" };
  const disabled = rankCandidates(REALTIME, { candidateModels: [{ id: "h", ...opus }, { id: "m", ...opus, effort: "medium", disabled: true }] });
  assert.notEqual(candidate(disabled, "h").effort, "medium");
  // On another harness it still is
  const elsewhere = rankCandidates(REALTIME, { candidateModels: [{ id: "h", ...opus, harness: "claude" }, { id: "m", ...opus, harness: "other", effort: "medium", disabled: true }] });
  assert.equal(candidate(elsewhere, "h").effort, "medium");

  // A second account of a provider reads that provider's table; `pi` has one of its own
  const second = rankCandidates(REALTIME, { candidateModels: [{ id: "k", provider: "claude-2", account: "claude-2", model: "claude-haiku-5-5" }] });
  assert.equal(candidate(second, "k").effort, "high", "claude dispatches haiku at high only");
  assert.equal(candidate(second, "k").eligible, false);
  assert.ok(catalog.DISPATCH_EFFORTS.pi);
  const onPi = rankCandidates(REALTIME, { candidateModels: [{ id: "p", provider: "pi", account: "pi", model: "gpt-6-astra" }] });
  assert.ok(catalog.DISPATCH_EFFORTS.pi["gpt-6-astra"].includes(candidate(onPi, "p").effort));
});

// ---------------------------------------------------------------------------- R3: what the user pins

test("B-3.1 a pinned unhealthy or spent model is blocked with the reason, never rerun without the filters", async (t) => {
  t.mock.method(console, "warn", () => {});
  const options = { candidateModels: ["gpt-6-astra", "gpt-6.1-sol"], pinnedModel: "gpt-6-astra", unhealthyModels: ["gpt-6-astra"], realtime_loop: true };

  const decision = selectBestRoute(REALTIME, options);
  assert.equal(decision.blocked, true);
  assert.equal(decision.targetModel ?? null, null);
  assert.ok(decision.warnings.length > 0);

  const viaHooks = context(options);
  await hooks.onRequest(request(), viaHooks);
  assert.equal(viaHooks.state.route, undefined);
  assert.ok(viaHooks.state.routeBlocked.warnings.length > 0);

  const body = request();
  const refused = middleware.onRequest(body, context(options));
  assert.equal(refused.rejected, 503);
  assert.notEqual(body.model, "gpt-6-astra:high");

  const answer = await systemOne({ realtime_loop: true }, { ...options });
  assert.equal(answer.agentcompass.blocked, true);
  assert.equal(answer.agentcompass.targetModel, null);

  // Not pinned either: an ordinary fallback keeps the filters too
  const spent = selectBestRoute(PROFILE, { candidateModels: ["gpt-6-astra"], unhealthyModels: ["gpt-6-astra"] });
  assert.equal(spent.targetModel ?? null, null);
  const small = selectBestRoute(PROFILE, { candidateModels: ["gpt-6-luna"], minContextTokens: 1e12 });
  assert.equal(small.targetModel ?? null, null);
  const unpinned = request();
  assert.equal(middleware.onRequest(unpinned, context({ candidateModels: ["gpt-6-astra"], unhealthyModels: ["gpt-6-astra"] })).rejected, 503);
});

test("B-3.1 a concrete model under routeAllModels, with nothing pinned and no route, goes as asked", () => {
  const body = request({ model: "gpt-6-astra" });
  const result = middleware.onRequest(body, context({ routeAllModels: true, candidateModels: ["gpt-6-astra"], unhealthyModels: ["gpt-6-astra"] }));
  assert.equal(result?.rejected, undefined);
  assert.equal(body.model, "gpt-6-astra");
});

test("M-3.2 a changed pin breaks a warm hold and routes to the new pin", async () => {
  const candidateModels = ["gpt-6-astra", "gpt-6.1-sol"];
  const meta = { metadata: { session_id: "pin-change" } };
  const messages = [{ role: "user", content: TASK }, { role: "assistant", content: "ok" }, { role: "user", content: "Now write the docs for it as well" }];
  for (const run of ["hooks", "middleware"]) {
    const continuityStore = new SessionContinuityStore();
    const first = context({ candidateModels, continuityStore, pinnedModel: "gpt-6.1-sol" });
    await hooks.onRequest(request(meta), first);
    assert.equal(first.state.route.targetModel, "gpt-6.1-sol");
    continuityStore.recordResponse(first.state.sessionKey, { usage: { input_tokens: 2000, output_tokens: 300 } }, {}, NOW);

    const second = context({ candidateModels, continuityStore, pinnedModel: "gpt-6-astra", now: NOW + 1000 });
    if (run === "hooks") await hooks.onRequest({ ...request(meta), messages }, second);
    else middleware.onRequest({ ...request(meta), messages }, second);
    assert.equal(second.state.route.targetModel, "gpt-6-astra", run);
    assert.equal(second.state.route.continuation.why, "user_pin_override", run);
    assert.equal(second.state.route.continuation.held, false, run);
  }
});

test("M-3.3 a pin in the request body or System-One state reaches the allocator, in any mode, and stays out of the upstream body", async () => {
  const candidateModels = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"];
  for (const pins of [{ pinned_model: "gpt-6.1-sol" }, { constraints: { model: "gpt-6.1-sol" } }, { task: { pinned_model: "gpt-6.1-sol" } }]) {
    const body = request(pins);
    middleware.onRequest(body, context({ candidateModels }));
    assert.match(body.model, /^gpt-6\.1-sol:/, JSON.stringify(pins));
    assert.equal(body.pinned_model, undefined);

    const ctx = context({ candidateModels });
    await hooks.onRequest(request(pins), ctx);
    assert.equal(ctx.state.route.targetModel, "gpt-6.1-sol", JSON.stringify(pins));
  }
  const effort = request({ pinned_model: "gpt-6-astra:low" });
  middleware.onRequest(effort, context({ candidateModels: ["gpt-6-astra"] }));
  assert.equal(effort.model, "gpt-6-astra:low");

  const answer = await systemOne({ pinned_model: "gpt-6.1-sol" }, { candidateModels });
  assert.equal(answer.agentcompass.targetModel, "gpt-6.1-sol");
});

test("M-3.4 a pinned disabled_by_default model is allowed on the default catalog and not routed unpinned; xhigh and max get no exemption", () => {
  for (const model of ["gpt-5.3-codex-spark", "claude-fable-5-1"]) {
    assert.equal(catalog.DEFAULT_MODELS[model].disabled_by_default, true, model);
    assert.equal(selectBestRoute(ROUTINE, { constraintModel: model }).targetModel, model);
  }
  for (const profile of [ROUTINE, PROFILE]) {
    assert.ok(!["gpt-5.3-codex-spark", "claude-fable-5-1"].includes(selectBestRoute(profile).targetModel));
  }

  const astra = (efforts) => ({ constraintModel: "gpt-6-astra", candidateModels: [{ provider: "codex", account: "codex", model: "gpt-6-astra", efforts }] });
  const reaches = selectBestRoute(REALTIME, astra(["xhigh", "medium"]));
  assert.equal(reaches.targetEffort, "medium");
  const none = selectBestRoute(REALTIME, astra(["xhigh", "max"]));
  assert.equal(none.targetEffort, "xhigh", "the fastest of what it offers");
  assert.ok(none.warnings.some((w) => w.includes("realtime_loop")));
  // Model and effort pinned: kept, and only warned about
  const kept = selectBestRoute(REALTIME, { ...astra(["xhigh", "max"]), constraintEffort: "max" });
  assert.equal(kept.targetEffort, "max");
  assert.ok(kept.warnings.length > 0);
  // The final bundle keeps what it was given
  const bundle = { id: "b", provider: "codex", account: "codex", model: "gpt-6-astra", effort: "high", modeId: "full-access", draws: ["x"] };
  const routed = selectBestRoute(PROFILE, { candidateModels: [bundle], pinnedBundle: "b" });
  assert.equal(routed.bundle.effort, "high");
  assert.equal(routed.bundle.modeId, "full-access");
  assert.deepEqual(routed.bundle.draws, ["x"]);
});

test("a pinned family name stays itself: it never folds to the flagship, and with no such row it is blocked", () => {
  const argon = { id: "ag", provider: "antigravity", account: "agy", harness: "antigravity", model: "gemini-4-argon-high", effort: "high" };
  const blocked = selectBestRoute(PROFILE, { constraintModel: "gemini-2.5-pro", candidateModels: [argon] });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.targetModel ?? null, null);
  assert.ok(blocked.warnings.length > 0);
  const own = { id: "own", provider: "openrouter", account: "or", model: "gemini-2.5-pro", effort: "high" };
  assert.equal(selectBestRoute(PROFILE, { constraintModel: "gemini-2.5-pro", candidateModels: [argon, own] }).targetModel, "gemini-2.5-pro");
});

test("a `-effort` suffix is an effort, in a pool and in a pin", () => {
  const ranked = rankCandidates(REALTIME, { candidateModels: ["gpt-6-astra-high"] });
  assert.equal(ranked.allCandidates[0].effort, "high", "fixed, not stepped");
  assert.equal(ranked.allCandidates[0].eligible, false);
  assert.equal(selectBestRoute(PROFILE, { candidateModels: ["gpt-6-astra-medium"] }).targetEffort, "medium");
  const pinned = selectBestRoute(PROFILE, { constraintModel: "gpt-6-astra-low", candidateModels: ["gpt-6.1-sol", "gpt-6-astra"] });
  assert.equal(pinned.targetModel, "gpt-6-astra");
  assert.equal(pinned.targetEffort, "low");
  // The effort's own field wins over one in the name
  const named = { id: "a", provider: "codex", account: "codex", model: "gpt-6-astra", effort: "high" };
  const both = selectBestRoute(PROFILE, { constraintModel: "gpt-6-astra-medium", constraintEffort: "high", candidateModels: [named] });
  assert.equal(both.targetEffort, "high");
  // A model whose own name ends like an effort stays that model
  assert.equal(catalog.resolveModel("qwen3.8-max").effort, null);
});

test("a provider whose table does not list the model offers no step-down", () => {
  const row = { id: "x", provider: "codex", account: "codex", model: "claude-opus-5-5", effort: "high" };
  const ranked = rankCandidates(REALTIME, { candidateModels: [row] });
  assert.equal(candidate(ranked, "x").effort, "high");
  assert.equal(candidate(ranked, "x").realtime_stepped_from, undefined);
  // A gateway has no table at all: the curve decides
  const gateway = rankCandidates(REALTIME, { candidateModels: [{ ...row, provider: "openrouter", account: "openrouter" }] });
  assert.equal(candidate(gateway, "x").realtime_stepped_from, "high");
});

test("an effort the pool has no row for can be pinned: a row `<carrier>@<effort>` with pin_carrier, on what the provider dispatches", () => {
  const row = { id: "opus", provider: "claude", account: "claude", model: "claude-opus-5-5", effort: "high", modeId: "bypass" };
  const decision = selectBestRoute(PROFILE, { candidateModels: [row], constraintModel: "claude-opus-5-5", constraintEffort: "medium" });
  assert.equal(decision.targetEffort, "medium");
  assert.equal(decision.bundle.pin_carrier, "opus");
  assert.equal(decision.bundle.modeId, "bypass");
  const ranked = rankCandidates(PROFILE, { candidateModels: [row], constraintModel: "claude-opus-5-5", constraintEffort: "medium" });
  assert.ok(ranked.allCandidates.some((c) => c.id === "opus@medium"));
  // Haiku dispatches at high only
  const haiku = { id: "h", provider: "claude", account: "claude", model: "claude-haiku-5-5", effort: "high" };
  assert.equal(selectBestRoute(PROFILE, { candidateModels: [haiku], constraintModel: "claude-haiku-5-5", constraintEffort: "medium" }).blocked, true);
  // A fixed row carries nothing else
  assert.equal(selectBestRoute(PROFILE, { candidateModels: ["claude-opus-5-5:high"], constraintModel: "claude-opus-5-5", constraintEffort: "medium" }).blocked, true);
});

test("a family name scores as auto_bundles says: no curve of its own, the estimated price, the target's route place", () => {
  const family = { id: "f", provider: "claude", account: "claude", model: "claude-opus-9", effort: "low" };
  assert.equal(candidate(rankCandidates(PROFILE, { candidateModels: [family] }), "f").components.ability_value, 3.76);
  assert.equal(catalog.resolveModelSpec("claude-opus-9").spec.usd_per_hour, 3);
  assert.equal(allocator.fitScore("computer_use", "claude-opus-9"), allocator.fitScore("computer_use", "claude-opus-5-5"));
  const gui = { ...REALTIME, needs_gui: true, needs_visual: true, work_kind: "frontend_implementation" };
  const guiFit = (model) => candidate(rankCandidates(gui, { candidateModels: [{ ...family, model, effort: "high" }] }), "f").components.gui_fit;
  assert.equal(guiFit("claude-opus-9"), guiFit("claude-opus-5-5"));
});

test("an unknown name scores on the generic row, whatever its size looks like", () => {
  assert.equal(catalog.resolveModel("totally-unknown-mini").source, "unknown");
  assert.equal(catalog.resolveModelSpec("totally-unknown-mini").spec.tier, catalog.resolveModelSpec("totally-unknown-model").spec.tier);
});

test("dot_text marked unavailable takes dot off the route even with a dot row in the pool", () => {
  const research = { ...PROFILE, work_kind: "web_research" };
  const pool = ["dot", "claude-sonnet-5-5"];
  const fit = (options) => rankCandidates(research, { candidateModels: pool, ...options }).allCandidates.find((c) => c.model === "claude-sonnet-5-5").components.route_fit;
  assert.ok(fit({}) < 1);
  assert.equal(fit({ unavailable: ["dot_text"] }), 1);
});

const turnOne = (text = "Implement the parser module and tests") => ({ model: "agentcompass/auto", messages: [{ role: "user", content: text }] });
const followUp = (first) => ({ model: "agentcompass/auto", messages: [...first.messages, { role: "assistant", content: "ok" }, { role: "user", content: "继续" }] });
const quietly = (fn) => {
  const warn = console.warn;
  const logged = [];
  console.warn = (line) => logged.push(line);
  try {
    return { value: fn(), logged };
  } finally {
    console.warn = warn;
  }
};
/** Two turns of one session through the middleware; returns what each sent and how the second was decided. */
function twoTurns(optionsOne, optionsTwo) {
  const store = new SessionContinuityStore();
  const first = turnOne();
  const ctxOne = { sessionId: "s", options: { continuityStore: store, now: NOW, ...optionsOne }, state: {} };
  quietly(() => middleware.onRequest(first, ctxOne));
  const second = followUp(first);
  const rejected = [];
  const ctxTwo = { sessionId: "s", options: { continuityStore: store, now: NOW + 1000, ...optionsTwo }, state: {}, reject: (status, message) => rejected.push([status, message]) };
  quietly(() => middleware.onRequest(second, ctxTwo));
  return { first: first.model, second: second.model, route: ctxTwo.state.route, rejected, store };
}

test("a pin changed during a hold takes effect however it is spelled (review M1)", () => {
  for (const pin of ["gpt-6-astra-medium", "gpt-6-astra:medium", "openai/gpt-6-astra-medium"]) {
    const run = twoTurns({ candidateModels: ["gpt-6-astra"], pinnedEffort: "high" }, { candidateModels: ["gpt-6-astra"], constraintModel: pin });
    assert.equal(run.first, "gpt-6-astra:high", pin);
    assert.equal(run.second, "gpt-6-astra:medium", pin);
    assert.equal(run.route.continuation.held, false, pin);
    assert.equal(run.route.continuation.why, "user_pin_override", pin);
  }
  // A family name never passes for the flagship the session is on...
  const pool = ["claude-opus-5-5", "claude-opus-9"];
  const family = twoTurns({ candidateModels: ["claude-opus-5-5"] }, { candidateModels: pool, constraintModel: "claude-opus-9" });
  assert.equal(family.route.targetModel, "claude-opus-9");
  assert.equal(family.route.continuation.held, false);
  // ...with no row of that name the route says so rather than keep the old model...
  const noRow = twoTurns({ candidateModels: ["claude-opus-5-5"] }, { candidateModels: ["claude-opus-5-5"], constraintModel: "claude-opus-9" });
  assert.equal(noRow.rejected[0]?.[0], 503);
  assert.match(noRow.rejected[0][1], /claude-opus-9/);
  // ...and a session already on that name stays on it.
  const stay = twoTurns({ candidateModels: pool, constraintModel: "claude-opus-9" }, { candidateModels: pool, constraintModel: "claude-opus-9" });
  assert.equal(stay.route.targetModel, "claude-opus-9");
  assert.equal(stay.route.continuation.held, true);
});

test("a hold steps down to what the pool still offers, and never sends the effort it took away (review M2)", () => {
  const sol = "gpt-6.1-sol";
  for (const [name, one, two, effort] of [
    ["`model:effort`", [`${sol}:high`], [`${sol}:medium`], "medium"],
    ["efforts[]", [{ model: sol, efforts: ["high"] }], [{ model: sol, efforts: ["low"] }], "low"],
    ["another model in the pool", [`${sol}:high`], [`${sol}:medium`, "claude-sonnet-5-5:high"], "medium"],
  ]) {
    const run = twoTurns({ candidateModels: one }, { candidateModels: two });
    assert.equal(run.first, `${sol}:high`, name);
    assert.equal(run.second, `${sol}:${effort}`, name);
    assert.equal(run.route.continuation.held, true, name);
    assert.match(run.route.warnings[0], /no longer offered/, name);
  }
  // The dispatch table counts too: Haiku dispatches at high only, so nothing is below it and the hold breaks
  const haiku = { id: "h", provider: "claude", account: "claude", model: "claude-haiku-5-5" };
  const noLower = twoTurns({ candidateModels: [`${sol}:high`] }, { candidateModels: [`${sol}:xhigh`, haiku] });
  assert.equal(noLower.route.continuation.held, false);
  assert.equal(noLower.route.continuation.why, "effort_gone");
  assert.notEqual(noLower.second, `${sol}:high`);
  // Unchecking the effort is taking it away
  const disabled = twoTurns(
    { candidateModels: [{ id: "a", provider: "codex", account: "codex", model: sol, effort: "high" }] },
    { candidateModels: [{ id: "a", provider: "codex", account: "codex", model: sol, effort: "high", disabled: true }, { id: "b", provider: "codex", account: "codex", model: sol, effort: "medium" }] },
  );
  assert.notEqual(disabled.second, `${sol}:high`);
  // A pin names the effort, so nothing may step it: the route says what is wrong
  const pinned = twoTurns({ candidateModels: [`${sol}:high`], pinnedEffort: "high" }, { candidateModels: [`${sol}:medium`], pinnedEffort: "high" });
  assert.equal(pinned.route?.targetEffort === "high", false);
  assert.equal(pinned.rejected[0]?.[0], 503);
  assert.equal(allocator.heldEffortOn([`${sol}:medium`], sol, "high"), "medium");
  assert.equal(allocator.heldEffortOn([`${sol}:xhigh`], sol, "high"), null);
  assert.equal(allocator.candidateOffers([{ model: sol, effort: "high" }], sol, "low"), true, "one bundle at its scoring effort steps within dispatch");
  assert.equal(allocator.candidateOffers(["gpt-6-astra-medium"], "gpt-6-astra-medium", "high"), false);
});

test("the hooks hold as the middleware does, on the name routed and what the pool offers (review M1, M2)", async () => {
  const run = async (one, two, extra = {}) => {
    const store = new SessionContinuityStore();
    const first = turnOne();
    await hooks.onRequest(first, { protocol: "chat", sessionId: "h", options: { candidateModels: one, continuityStore: store, now: NOW }, state: {} });
    const ctx = { protocol: "chat", sessionId: "h", options: { candidateModels: two, continuityStore: store, now: NOW + 1000, ...extra }, state: {} };
    await hooks.onRequest(followUp(first), ctx);
    return ctx.state.route;
  };
  const stepped = await run(["gpt-6.1-sol:high"], ["gpt-6.1-sol:medium"]);
  assert.equal(stepped.continuation.held, true);
  assert.equal(stepped.targetEffort, "medium");
  assert.match(stepped.warnings[0], /no longer offered/);
  const gone = await run(["gpt-6.1-sol:high"], ["gpt-6.1-sol:xhigh", "claude-sonnet-5-5"]);
  assert.equal(gone.continuation.held, false);
  assert.equal(gone.continuation.why, "effort_gone");
  assert.notEqual(gone.targetEffort, "high");
  const pinned = await run(["gpt-6-astra"], ["gpt-6-astra"], { constraintModel: "gpt-6-astra-medium" });
  assert.equal(pinned.continuation.why, "user_pin_override");
  assert.equal(pinned.targetEffort, "medium");
  const row = { id: "x", provider: "codex", account: "codex", model: "gpt-6-astra", effort: "medium", modeId: "m", draws: 2 };
  const held = await run([row], [row]);
  assert.equal(held.continuation.held, true);
  assert.equal(held.bundle.modeId, "m", "review m7");
  assert.equal(held.bundle.draws, 2, "review m7");
});

test("catalog:check reads a CRLF checkout, and .gitattributes keeps src/catalog.js LF (review M3)", async () => {
  const sync = await import(pathToFileURL(path.join(REPO, "scripts", "sync-catalog.mjs")).href);
  const source = fs.readFileSync(path.join(REPO, "src", "catalog.js"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(sync.currentBlock(source.replace(/\n/g, "\r\n")), sync.currentBlock(source));
  const attr = execFileSync("git", ["-C", REPO, "check-attr", "eol", "src/catalog.js"], { encoding: "utf8" });
  assert.match(attr, /eol: lf/);
});

test("a pool name with no row of its own says so, and a blocked route names its models (review M4)", () => {
  const ok = selectBestRoute(PROFILE, { candidateModels: ["claude-sonnet-5-5", "gpt-5.4", "gemini-2.5-pro"] });
  assert.equal(ok.ok, true);
  assert.equal(ok.warnings.length, 2);
  assert.match(ok.warnings[0], /gpt-5\.4 is not in the catalog: scored on the generic row \(tier 2\.8\); use gpt-6-astra/);
  assert.match(ok.warnings[1], /gemini-2\.5-pro is not in the catalog: scored as an estimate of gemini-4-argon-high \(tier 3\.7\); use gemini-4-argon-high/);
  assert.deepEqual(selectBestRoute(PROFILE, { candidateModels: ["claude-sonnet-5-5", "claude-opus-4-6"] }).warnings, []);

  const rejected = [];
  const refuse = (pool, content, extra = {}) =>
    quietly(() =>
      middleware.onRequest(
        { model: "agentcompass/auto", messages: [{ role: "user", content }] },
        { options: { candidateModels: pool, continuityStore: new SessionContinuityStore(), now: NOW, ...extra }, state: {}, reject: (s, m) => rejected.push([s, m]) },
      ),
    );
  refuse(["gpt-5.4"], "Prove the correctness of this distributed consensus algorithm and redesign the architecture across all modules");
  assert.equal(rejected[0][0], 503);
  assert.match(rejected[0][1], /no candidate is available: gpt-5\.4@low: ability/);
  assert.match(rejected[0][1], /candidate name gpt-5\.4 is not in the catalog/);
  refuse(["gpt-5.4"], "hello", { constraintModel: "claude-opus-9" });
  assert.equal(rejected[1][0], 503);
  assert.match(rejected[1][1], /pinned model claude-opus-9 is not among the candidates/);

  // The log carries a name warning once per process, a route's other warnings every time
  const name = `gpt-5.4-${NOW}-unlisted`;
  const once = quietly(() => {
    allocator.logRouteWarnings([`candidate name ${name} is not in the catalog`, "slow"]);
    allocator.logRouteWarnings([`candidate name ${name} is not in the catalog`, "slow"]);
  });
  assert.equal(once.logged.filter((line) => line.includes(name)).length, 1);
  assert.equal(once.logged.filter((line) => line.endsWith("slow")).length, 2);

  // The release notes list every retired name with its replacement
  const names = Object.values(catalog.RETIRED_NAMES).flat();
  assert.equal(names.length, 57);
  const notes = fs.readFileSync(path.join(REPO, "docs", "RELEASE_NOTES.md"), "utf8");
  for (const [target, retired] of Object.entries(catalog.RETIRED_NAMES)) {
    assert.ok(catalog.DEFAULT_MODELS[target], target);
    for (const old of retired) {
      assert.ok(notes.includes(`\`${old}\``), old);
      if (catalog.resolveModel(old).source === "exact") continue;
      assert.match(catalog.catalogNameWarning(old), new RegExp(`use ${target}$`), old);
    }
  }
});

test("a failure of a family name stays on that name; the flagship keeps serving (review M5)", () => {
  const store = new SessionContinuityStore();
  const pool = ["gpt-6.2-sol-preview", "gpt-6.1-sol"];
  const first = turnOne();
  const ctx = { sessionId: "f", options: { candidateModels: ["gpt-6.2-sol-preview"], continuityStore: store, now: NOW }, state: {} };
  quietly(() => middleware.onRequest(first, ctx));
  assert.equal(ctx.state.route.targetModel, "gpt-6.2-sol-preview");
  middleware.onResponse({ error: { message: "bad gateway" } }, { ...ctx, status: 502 });
  assert.deepEqual(store.getUnhealthyModels(NOW), ["gpt-6.2-sol-preview"]);
  assert.equal(store.isModelHealthy("gpt-6.1-sol", NOW), true);
  assert.equal(store.isModelHealthy("gpt-6.2-sol-preview", NOW), false);

  // The next turn leaves the failed name and lands on the flagship, in this session and in a new one
  const next = followUp(first);
  const ctxNext = { sessionId: "f", options: { candidateModels: pool, continuityStore: store, now: NOW + 1000 }, state: {} };
  quietly(() => middleware.onRequest(next, ctxNext));
  assert.equal(ctxNext.state.route.targetModel, "gpt-6.1-sol");
  assert.equal(ctxNext.state.route.continuation.why, "provider_unhealthy");
  const fresh = selectBestRoute(PROFILE, { candidateModels: ["gpt-6.1-sol"], unhealthyModels: store.getUnhealthyModels(NOW) });
  assert.equal(fresh.targetModel, "gpt-6.1-sol");
  const allocated = rankCandidates(PROFILE, { candidateModels: ["gpt-6.1-sol:high"], unhealthyModels: ["gpt-6.2-sol-preview"] });
  assert.equal(allocated.allCandidates[0].eligible, true);

  // An exact or alias name is its row: any spelling takes the row down
  const exact = new SessionContinuityStore();
  exact.markModelUnhealthy("gpt-6.1-sol-20261001", "http_502", NOW);
  assert.deepEqual(exact.getUnhealthyModels(NOW), ["gpt-6.1-sol"]);
  assert.equal(rankCandidates(PROFILE, { candidateModels: ["gpt-6.1-sol:high"], unhealthyModels: exact.getUnhealthyModels(NOW) }).allCandidates[0].eligible, false);
});

test("a pin that names a fixed-effort id makes no row of another effort (review m2)", () => {
  const argon = { id: "a", provider: "antigravity", account: "agy", harness: "antigravity", model: "gemini-4-argon-high", effort: "high" };
  assert.equal(selectBestRoute(PROFILE, { candidateModels: [argon], constraintModel: "gemini-4-argon-high", constraintEffort: "medium" }).blocked, true);
  assert.equal(catalog.nameFixesEffort("gemini-4-argon-high"), true);
  assert.equal(catalog.nameFixesEffort("gpt-6.1-sol"), false);
  assert.equal(catalog.nameFixesEffort("qwen3.8-max"), false, "-max is a size unless the base is a row");
  assert.equal(catalog.nameFixesEffort("gpt-6.1-sol-max"), true);
});

test("scores round as Python rounds them (review m3)", () => {
  assert.equal(catalog.pyRound(0.7625, 3), 0.762);
  assert.equal(allocator.round3(0.7625), 0.762);
  assert.equal(catalog.pyRound(0.0625, 3), 0.062, "an exact tie goes to the even digit");
  assert.equal(catalog.pyRound(0.1875, 3), 0.188, "an exact tie goes to the even digit");
  assert.equal(catalog.pyRound(2.5, 0), 2);
  assert.equal(catalog.pyRound(0.12345, 4), 0.1235);
  assert.equal(catalog.pyRound(-0.7625, 3), -0.762);
  assert.ok(Object.is(catalog.pyRound(-0.00001, 3), 0));
});

test("`:auto` and `:off` constrain nothing; `-off` is not an effort (review m4)", () => {
  assert.deepEqual(catalog.splitEffortSuffix("gpt-6.1-sol:auto"), { name: "gpt-6.1-sol:auto", effort: null });
  assert.equal(catalog.resolveModel("gpt-6.1-sol:auto").key, "gpt-6.1-sol");
  assert.equal(catalog.resolveModel("gpt-6.1-sol:off").effort, null);
  assert.equal(catalog.resolveModel("gpt-6.1-sol-off").source, "family");
  const pool = selectBestRoute(PROFILE, { candidateModels: ["gpt-6.1-sol:auto"] });
  assert.equal(pool.targetModel, "gpt-6.1-sol");
  assert.doesNotMatch(pool.modelWithEffort, /auto/);
  const pin = selectBestRoute(PROFILE, { candidateModels: ["gpt-6.1-sol"], constraintModel: "gpt-6.1-sol:auto" });
  assert.equal(pin.ok, true);
  assert.equal(pin.targetModel, "gpt-6.1-sol");
});

test("task-level multi_task and task_count are checked as stated (review m5)", () => {
  for (const bad of [{ multi_task: "false" }, { task_count: 0 }, { task_count: NaN }, { task_count: "" }, { multi_task: true, task_count: "1" }, { multi_task: false, task_count: "3" }]) {
    const decision = selectBestRoute({ objective: "Fix a bug", ...bad }, { candidateModels: ["gpt-6.1-sol"] });
    assert.equal(decision.blocked, true, JSON.stringify(bad));
    assert.equal(decision.error, "invalid_caller_profile", JSON.stringify(bad));
  }
  assert.equal(profiler.inferTaskProfile({ objective: "Fix a bug", task_count: 3 }).multi_task, true);
  assert.equal(profiler.inferTaskProfile({ objective: "Fix a bug", multi_task: false }).task_count, "1");
  assert.equal(profiler.inferTaskProfile({ objective: "Fix a bug", multi_task: true }).task_count, "2");
});

test("a request this plugin does not route keeps its pin fields from the upstream too (review m6)", () => {
  const body = { model: "gpt-6-luna", pinned_model: "x", constraints: { model: "x" }, constraint_effort: "low", messages: [{ role: "user", content: "hi" }] };
  assert.equal(middleware.onRequest(body, { options: {}, state: {} }), body);
  for (const field of ["pinned_model", "constraints", "constraint_effort"]) assert.equal(field in body, false, field);
});

test("a held turn carries the pool's bundle, with its modeId and draws (review m7)", () => {
  const row = { id: "x", provider: "codex", account: "codex", model: "gpt-6-astra", effort: "medium", modeId: "m", draws: 2 };
  const run = twoTurns({ candidateModels: [row] }, { candidateModels: [row] });
  assert.equal(run.route.continuation.held, true);
  assert.equal(run.route.bundle.modeId, "m");
  assert.equal(run.route.bundle.draws, 2);
  assert.equal(run.route.bundle.effort, run.route.targetEffort);
});

test("a route its `when` rules block says why (review m8)", () => {
  const decision = selectBestRoute(PROFILE, { candidateModels: [{ id: "w", provider: "codex", model: "gpt-6.1-sol", effort: "high", when: { max_reasoning_depth: 1 } }] });
  assert.equal(decision.blocked, true);
  assert.match(decision.warnings[0], /gpt-6\.1-sol@high: its when rule allows reasoning depth up to 1, the task has 2/);
  assert.match(decision.excluded[0], /when rule/);
});

test("a provider with nothing usable refuses rather than send what it does not offer (review m9)", () => {
  const options = (extra) => ({ candidateModels: ["gpt-6.1-sol"], continuityStore: new SessionContinuityStore(), now: NOW, ...extra });
  const rejected = [];
  const reject = (status, message) => {
    rejected.push([status, message]);
    return "refused";
  };
  const body = turnOne();
  const ctx = { sessionId: "p", options: options({ pinnedModel: "gpt-6.1-sol", modelsByProvider: { other: ["claude-sonnet-5-5"] } }), state: {}, provider: { id: "other" }, reject };
  quietly(() => middleware.onRequest(body, ctx));
  assert.equal(quietly(() => middleware.onProvider(body, ctx)).value, "refused");
  assert.equal(rejected[0][0], 503);
  assert.match(rejected[0][1], /other/);
  assert.match(rejected[0][1], /gpt-6\.1-sol/);
  // efforts[] on the provider: only `low`, which this task's floor rules out
  const lowOnly = { sessionId: "q", options: options({ routePerProvider: true, modelsByProvider: { p: [{ model: "gpt-6.1-sol", efforts: ["low"] }] } }), state: {}, provider: { id: "p" }, reject };
  const hard = { model: "agentcompass/auto", messages: [{ role: "user", content: "Implement the parser module and tests" }] };
  quietly(() => middleware.onRequest(hard, lowOnly));
  assert.equal(quietly(() => middleware.onProvider(hard, lowOnly)).value, "refused");
  assert.match(rejected[1][1], /provider p has no route: no candidate is available: gpt-6\.1-sol@low: ability/);
});

test("the pools of the non-realtime report are in the repo", () => {
  const pools = JSON.parse(fs.readFileSync(path.join(REPO, "test", "fixtures", "nonrealtime-pools.json"), "utf8"));
  assert.equal(pools.length, 20);
  assert.ok(fs.existsSync(path.join(REPO, "test", "nonrealtime-change-report.mjs")));
  assert.doesNotMatch(fs.readFileSync(path.join(REPO, "scripts", "catalog-overlay.mjs"), "utf8"), /`pi` has its own dispatch table/);
});

test("M-3.5 onProvider reroutes on a held turn too, and keeps the unhealthy models out", async (t) => {
  t.mock.method(console, "warn", () => {});
  const continuityStore = new SessionContinuityStore();
  const options = { candidateModels: ["claude-sonnet-5-5"], modelsByProvider: { codex: ["gpt-6.1-sol"] }, continuityStore };
  const first = context(options);
  const firstBody = request({ metadata: { session_id: "held" } });
  middleware.onRequest(firstBody, first);
  continuityStore.recordResponse(first.state.route.continuation.sessionKey, { usage: { input_tokens: 2000, output_tokens: 300 } }, {}, NOW);

  const held = context({ ...options, now: NOW + 1000 });
  const body = {
    ...request({ metadata: { session_id: "held" } }),
    messages: [{ role: "user", content: TASK }, { role: "assistant", content: "ok" }, { role: "user", content: "继续" }],
  };
  middleware.onRequest(body, held);
  assert.equal(held.state.route.continuation.held, true);
  assert.match(body.model, /^claude-sonnet-5-5:/);
  middleware.onProvider(body, { ...held, provider: { id: "codex" } });
  assert.match(body.model, /^gpt-6\.1-sol:/);

  const pool = ["claude-sonnet-5-5", "gpt-6.1-sol"];
  const unhealthy = context({ candidateModels: pool, modelsByProvider: { p: pool }, routePerProvider: true, unhealthyModels: ["claude-sonnet-5-5"] });
  const other = request();
  middleware.onRequest(other, unhealthy);
  middleware.onProvider(other, { ...unhealthy, provider: { id: "p" } });
  assert.match(other.model, /^gpt-6\.1-sol:/);
});

// ---------------------------------------------------------------------------- R4: profiles

test("M-4.1 task_count takes a bucket from a positive integer, contradictions and anything else are illegal, and validation is idempotent", async () => {
  const { validateProfile } = profiler;
  for (const [value, bucket, multi] of [[1, "1", false], [2, "2", true], [3, "3", true], [4, ">3", true], [9, ">3", true], ["2", "2", true], [">3", ">3", true]]) {
    assert.equal(validateProfile({ ...PROFILE, multi_task: multi, task_count: value }).task_count, bucket, String(value));
  }
  for (const value of [0, -1, 1.5, NaN, Infinity, "many", null, undefined]) {
    assert.throws(() => validateProfile({ ...PROFILE, task_count: value }), /task_count/, String(value));
  }
  assert.throws(() => validateProfile({ ...PROFILE, multi_task: true, task_count: "1" }), /task_count/);
  assert.throws(() => validateProfile({ ...PROFILE, multi_task: false, task_count: "3" }), /task_count/);
  const once = validateProfile(PROFILE);
  assert.deepEqual(validateProfile(once), once);

  // The default classifier keeps them consistent as well
  for (const objective of [TASK, "First fix the parser, then update the docs, and also add the release notes"]) {
    const inferred = profiler.inferTaskProfile({ objective });
    assert.equal(inferred.multi_task, inferred.task_count !== "1", objective);
  }

  // An illegal classifier answer is not repaired: one retry, then blocked
  const { options, calls } = classifier({ reasoning_depth: 2, code_complexity: 2, context_scale: 2, divergence: 1, hallucination_risk: 2, error_cost: 2, interaction_style: "engineering", multi_task: true, task_count: "1" });
  const scored = await scorer.scoreTaskLive({ objective: TASK }, { ...options, useCache: false });
  assert.equal(scored.profile, null);
  assert.equal(scored.meta.error, "classifier_invalid_output");
  assert.equal(calls.count, 2);

  // An illegal caller profile says so
  const decision = selectBestRoute({ ...PROFILE, multi_task: true, task_count: "1" }, { candidateModels: ["gpt-6.1-sol"] });
  assert.equal(decision.error, "invalid_caller_profile");
  assert.throws(() => rankCandidates({ ...PROFILE, task_count: "many" }), (err) => err.code === "invalid_caller_profile");
});

test("M-4.2 the profile cache keys on every structured field, copies both ways, and a bad entry is a miss", async () => {
  const answer = { ...PROFILE };
  delete answer.work_kind;
  const { options, calls } = classifier(answer);
  scorer.clearProfileCache();

  await scorer.scoreTaskLive({ objective: TASK, work_kind: "general_implementation" }, options);
  await scorer.scoreTaskLive({ objective: TASK, work_kind: "code_review" }, options);
  await scorer.scoreTaskLive({ objective: TASK, needs: { gui: true } }, options);
  assert.equal(calls.count, 3, "different structured fields, different entries");

  const task = { objective: `${TASK} (isolation)` };
  const first = await scorer.scoreTaskLive(task, options);
  const before = calls.count;
  const depth = first.profile.reasoning_depth;
  first.profile.reasoning_depth = 99;
  const second = await scorer.scoreTaskLive(task, options);
  assert.equal(calls.count, before, "served from the cache");
  assert.equal(second.profile.reasoning_depth, depth, "a caller's change to the result does not reach the cache");
  second.profile.reasoning_depth = 98;
  assert.equal((await scorer.scoreTaskLive(task, options)).profile.reasoning_depth, depth);

  // Written by an older version: revalidated on read, a failure is a miss
  const stale = { objective: `${TASK} (stale)` };
  scorer.putCachedProfile(scorer.cacheKeyOf(stale, options), { reasoning_depth: 99 }, {});
  const reread = await scorer.scoreTaskLive(stale, options);
  assert.ok(reread.profile.reasoning_depth <= 4);
  assert.equal(calls.count, before + 1);
  scorer.clearProfileCache();
});

// ---------------------------------------------------------------------------- R5 / R6: pinned data, scoring as AgentCompass

test("7.1 the catalog block is generated from accounts.json at the pinned commit", async (t) => {
  const script = path.join(REPO, "scripts", "sync-catalog.mjs");
  assert.ok(fs.existsSync(script), "scripts/sync-catalog.mjs");
  const { agentCompassAvailable } = await import(pathToFileURL(path.join(REPO, "scripts", "agentcompass-pin.mjs")).href);
  if (!agentCompassAvailable()) {
    t.skip("the AgentCompass repository is not here");
    return;
  }
  const out = execFileSync(process.execPath, [script, "--check"], { encoding: "utf8" });
  assert.match(out, /matches AgentCompass/);
});

test("7.2 no routine effort overhead: on a routine task astra:high does not lose to astra:xhigh", () => {
  const computerUse = { ...ROUTINE, work_kind: "computer_use", needs_visual: true, needs_gui: true };
  const ranked = rankCandidates(computerUse, { candidateModels: [{ model: "gpt-6-astra", efforts: ["high", "xhigh"] }] });
  const byEffort = Object.fromEntries(ranked.allCandidates.map((c) => [c.effort, c]));
  assert.equal(ranked.task.difficulty, "routine");
  assert.ok(byEffort.high.score > byEffort.xhigh.score, `high ${byEffort.high.score}, xhigh ${byEffort.xhigh.score}`);
  assert.equal(byEffort.high.components.effort_penalty, 0);
});

test("7.3 a bundle's `when` is checked in every mode", () => {
  const bundle = { id: "easy_only", provider: "codex", account: "codex", model: "gpt-6.1-sol", effort: "high", when: { max_reasoning_depth: 1 } };
  const fallback = { id: "any", provider: "codex", account: "codex", model: "gpt-6.1-terra", effort: "high" };
  assert.deepEqual(rankCandidates(PROFILE, { candidateModels: [bundle, fallback] }).ranking.map((c) => c.id), ["any"]);
  assert.equal(rankCandidates(ROUTINE, { candidateModels: [bundle, fallback] }).ranking.length, 2);
});

test("7.4 the harness factor discounts a harness's score as accounts.json says", () => {
  const model = "claude-sonnet-5-5";
  const direct = { id: "direct", provider: "claude", account: "claude", harness: "claude", model, effort: "high" };
  const resilient = { id: "agy", provider: "antigravity-resilient", account: "agy", harness: "antigravity-resilient", model, effort: "high" };
  const ranked = rankCandidates(PROFILE, { candidateModels: [resilient, direct] });
  const a = candidate(ranked, "direct");
  const b = candidate(ranked, "agy");
  assert.ok(a.eligible && b.eligible);
  const factor = catalog.DEFAULT_SCORING_POLICY.harness_factors.rules.find((r) => r.harness === "antigravity-resilient" && r.model_prefix === "claude").factor;
  assert.ok(factor < 1);
  assert.ok(b.score < a.score, `${b.score} < ${a.score}`);
  assert.equal(b.components.harness_factor, factor);
});

test("m-5.2 cross-repo data comes from the pinned commit through git, never a checkout or a floating ref", () => {
  const pin = JSON.parse(fs.readFileSync(path.join(REPO, "test", "fixtures", "agentcompass-pin.json"), "utf8"));
  assert.match(pin.commit, /^[0-9a-f]{40}$/);
  for (const file of [
    "test/router.test.mjs",
    "test/realtime-parity.test.mjs",
    "test/fixtures/gen_realtime_parity.py",
    "test/fixtures/gen_routing_parity.py",
    "scripts/sync-catalog.mjs",
  ]) {
    const text = fs.readFileSync(path.join(REPO, file), "utf8");
    assert.doesNotMatch(text, /route_manager\/skills/, file);
    assert.doesNotMatch(text, /origin\/main/, file);
  }
  const fixture = JSON.parse(fs.readFileSync(path.join(REPO, "test", "fixtures", "agentcompass-realtime-parity.json"), "utf8"));
  assert.equal(JSON.stringify(fixture).includes(pin.commit.slice(0, 7)), true, "the fixture names the commit it came from");
});

// ---------------------------------------------------------------------------- warnings and plumbing

test("m-7.1 a route's warnings survive the hand-off between hooks and middleware", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const options = { candidateModels: ["gemini-4-argon-high"], pinnedModel: "gemini-4-argon-high", realtime_loop: true };
  const ctx = context(options);
  await hooks.onRequest(request(), ctx);
  assert.ok(ctx.state.route.warnings.length > 0);

  middleware.onRequest(request(), context({ candidateModels: ["gemini-4-argon-high"] }, { state: { route: ctx.state.route } }));
  assert.ok(warn.mock.calls.some((c) => String(c.arguments[0]).includes(ctx.state.route.warnings[0])));
});

test("m-7.2 a blocked route says why, pinned or not", () => {
  for (const options of [
    { candidateModels: ["gpt-6-astra"], constraintModel: "gpt-6-astra", unhealthyModels: ["gpt-6-astra"] },
    { candidateModels: ["gpt-6-luna"], constraintModel: "gpt-6-luna", minContextTokens: 1e12 },
    { candidateModels: ["gpt-6-astra"], unhealthyModels: ["gpt-6-astra"] },
  ]) {
    const decision = selectBestRoute(PROFILE, options);
    assert.equal(decision.blocked, true, JSON.stringify(options));
    assert.ok(decision.warnings.length > 0, JSON.stringify(options));
    assert.ok(decision.excluded.length > 0, JSON.stringify(options));
  }
});

test("m-7.3 handleSystemOneRequest reads every candidate list the plugin may be given", async () => {
  const entry = { id: "seat", provider: "codex", account: "codex", model: "gpt-6.1-sol", efforts: ["medium"] };
  for (const key of ["availableModels", "allowedModels", "models"]) {
    const answer = await systemOne({}, { [key]: [entry] });
    assert.equal(answer.agentcompass.targetModel, "gpt-6.1-sol", key);
    assert.equal(answer.agentcompass.targetEffort, "medium", key);
  }
  const mapped = await systemOne({}, { modelMap: { "gpt-6.1-sol": "upstream/gpt-6.1-sol" } });
  assert.equal(mapped.agentcompass.targetModel, "gpt-6.1-sol");
});
