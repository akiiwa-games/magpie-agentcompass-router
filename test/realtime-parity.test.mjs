/**
 * Pins the two invariants the realtime_loop port has to keep:
 *   - non-realtime routing is identical to the pre-branch code (the fixed pre-branch commit ab8baba, `MAGPIE_PARITY_BASELINE` overrides);
 *   - realtime responsiveness, step-down and pin identity are identical to AgentCompass (fixture from gen_realtime_parity.py).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EFFORT_CURVES,
  EFFORT_RESPONSIVENESS,
  CANONICAL_ROUTES,
  DISPATCH_EFFORTS,
  canonicalModel,
  resolveModelSpec,
  resolveResponsivenessModelKey,
} from "../src/catalog.js";
import {
  bundleResponsiveness,
  isCandidatePinned,
  rankCandidates,
  resolveRealtimeCurves,
  resolveRealtimeEffort,
  selectBestRoute,
} from "../src/allocator.js";
import { SessionContinuityStore, evaluateProviderContinuation, keepsEffort } from "../src/continuity.js";
import { onRequest as hooksForProfile } from "../src/hooks.js";
import { onProvider as middlewareOnProvider, onRequest as middlewareForProfile } from "../src/middleware.js";
import { handleSystemOneRequest as systemOneForState } from "../src/index.js";
import { SCORER_SYSTEM_PROMPT, scoreTaskLive } from "../src/scorer-live.js";
import { answerRequest, answerSystemOne } from "./classifier-stub.mjs";

// The baseline profiled a text by itself; here the classifier answers what the baseline said for it.
const hooksOnRequest = async (body, ctx = {}) => {
  answerRequest(body, ctx);
  return hooksForProfile(body, ctx);
};
const middlewareOnRequest = (body, ctx = {}) => {
  answerRequest(body, ctx);
  return middlewareForProfile(body, ctx);
};
const handleSystemOneRequest = async (body, options = {}) => systemOneForState(answerSystemOne(body, options), options);

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/agentcompass-realtime-parity.json"), "utf8"));
const NOW = 1790000000000;

// ---------------------------------------------------------------------------------------------------------------------
// Baseline: the code this branch forked from
// ---------------------------------------------------------------------------------------------------------------------

let baseline = null;
let baselineSkip = null;
let baselineDir = null;

before(async () => {
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  let sha;
  try {
    // A fixed commit, not origin/main: once this branch is merged, origin/main is HEAD and the test compares nothing.
    sha = git("rev-parse", "--verify", `${process.env.MAGPIE_PARITY_BASELINE || "ab8baba2aa9b41df1b9e5a76a56c9df8721d5abb"}^{commit}`);
  } catch {
    baselineSkip = "the pre-realtime baseline commit is not in this checkout";
    return;
  }
  baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-baseline-"));
  fs.mkdirSync(path.join(baselineDir, "src"));
  fs.writeFileSync(path.join(baselineDir, "package.json"), git("show", `${sha}:package.json`));
  for (const file of git("ls-tree", "--name-only", `${sha}`, "src/").split(/\r?\n/)) {
    fs.writeFileSync(path.join(baselineDir, file), execFileSync("git", ["show", `${sha}:${file}`], { cwd: ROOT }));
  }
  const load = (name) => import(pathToFileURL(path.join(baselineDir, "src", name)).href);
  baseline = {
    sha,
    allocator: await load("allocator.js"),
    catalog: await load("catalog.js"),
    continuity: await load("continuity.js"),
    hooks: await load("hooks.js"),
    middleware: await load("middleware.js"),
    index: await load("index.js"),
    scorer: await load("scorer-live.js"),
  };
});

after(() => {
  if (baselineDir) fs.rmSync(baselineDir, { recursive: true, force: true });
});

const STYLES = ["engineering", "exploration", "text_only", "advisory"];
const GRID = [];
for (const work_kind of Object.keys(CANONICAL_ROUTES)) {
  for (const reasoning_depth of [1, 2, 3, 4]) {
    for (const code_complexity of [0, 1, 2, 3]) {
      for (const divergence of [1, 2, 3]) {
        for (const error_cost of [1, 2, 3]) {
          GRID.push({
            work_kind,
            reasoning_depth,
            code_complexity,
            context_scale: ((reasoning_depth + divergence) % 3) + 1,
            divergence,
            hallucination_risk: ((code_complexity + error_cost) % 3) + 1,
            error_cost,
            interaction_style: STYLES[(reasoning_depth + code_complexity) % 4],
            needs_visual: work_kind === "visual_analysis" || work_kind === "computer_use",
            needs_gui: work_kind === "computer_use",
            local_only: false,
          });
        }
      }
    }
  }
}
// Every 12th profile still covers every route, depth and effort tier; the README pool walks the whole grid.
const SAMPLED_GRID = GRID.filter((_, i) => i % 12 === 0);

// Fields the branch adds to every result. Anything else differing is a routing change.
const ADDED_KEYS = new Set(["realtimeLoop", "realtime_loop", "responsiveness", "responsivenessSource", "warnings"]);
function withoutAddedKeys(value) {
  if (Array.isArray(value)) return value.map(withoutAddedKeys);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (!ADDED_KEYS.has(k)) out[k] = withoutAddedKeys(v);
  }
  return out;
}

function routingDiffs(pool, grid, options = {}) {
  const diffs = [];
  for (const profile of grid) {
    const opts = { candidateModels: pool, now: NOW, ...options };
    const head = withoutAddedKeys(rankCandidates(profile, opts));
    const base = withoutAddedKeys(baseline.allocator.rankCandidates(profile, opts));
    if (JSON.stringify(head) !== JSON.stringify(base)) {
      diffs.push({ kind: profile.work_kind, depth: profile.reasoning_depth, base: base.selected?.id, head: head.selected?.id });
    }
  }
  return diffs;
}

const README_POOL = ["claude-opus-4-6", "claude-sonnet-4-6", "gpt-5.4", "gemini-2.5-pro", "gemini-2.5-flash"];

const NON_REALTIME_POOLS = {
  "dated openai and anthropic": ["o3-mini-2025-01-31", "o4-mini-2025-04-16", "gpt-5-2025-08-07", "claude-3-7-sonnet-20250219"],
  "gpt-5 chat variants": ["openai/gpt-5-chat", "openai/gpt-5-turbo", "anthropic/claude-sonnet-4-6"],
  "deepseek dated": ["deepseek-pro-20250501", "gemini-2.5-flash"],
  "-preview/-latest": ["kimi-k2.6-preview", "glm-5.2-latest", "openrouter/xai/grok-4.6", "qwen3-max-20260101"],
  "openrouter :free": ["deepseek/deepseek-r1:free", "google/gemini-2.0-flash-exp:free", "meta-llama/llama-3.3-70b-instruct:free"],
  ":default suffix": ["claude-opus-5-5:default", "claude-sonnet-5-5:default", "gpt-6.1-sol:default"],
  "legacy claude and modern": ["claude-opus-4-6:xhigh", "claude-sonnet-4-6:medium", "claude-haiku-4-5:medium", "claude-sonnet-5-5:high", "gpt-6-astra:high"],
  "modern bare strings": ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-astra", "gpt-6.1-sol", "gemini-4-argon-high", "gemini-3.8-flash-high", "grok-4.7"],
  "grok-bot and dot": ["grok-bot", "dot", "claude-sonnet-5-5:high"],
  "{model} objects": [{ model: "claude-opus-5-5" }, { model: "claude-sonnet-5-5" }, { model: "gpt-6-astra" }, { model: "gpt-6.1-terra" }],
  "{model} dated objects": [{ model: "o3-mini-2025-01-31" }, { model: "claude-3-7-sonnet-20250219" }, { model: "deepseek-pro-20250501" }],
  "{id,provider,model}": [{ id: "o", provider: "claude", model: "claude-opus-5-5" }, { id: "s", provider: "claude", model: "claude-sonnet-5-5" }, { id: "a", provider: "codex", model: "gpt-6-astra" }],
  "{id,provider,model} dated": [{ id: "m", provider: "openai", model: "o3-mini-2025-01-31" }, { id: "c", provider: "openrouter", model: "openai/gpt-5-chat" }],
  "bundles with effort": [{ id: "o", provider: "claude", model: "claude-opus-5-5", effort: "high" }, { id: "s", provider: "claude", model: "claude-sonnet-5-5", effort: "low" }, { id: "a", provider: "codex", model: "gpt-6-astra", effort: "xhigh" }],
  "bundles dated with effort": [{ id: "m", provider: "openai", model: "o3-mini-2025-01-31", effort: "low" }, { id: "g", provider: "openai", model: "gpt-5-2025-08-07", effort: "medium" }, { id: "c", provider: "anthropic", model: "claude-3-7-sonnet-20250219", effort: "high" }],
  "object fields main ignores": [{ model: "claude-opus-5-5", effort: "HIGH", disabled: true }, { model: "gpt-6-astra", efforts: ["LOW", "high"], when: { min_difficulty: "frontier" } }, { id: "x", model: "claude-sonnet-5-5", discovery_unavailable: true, pinned: true }],
};

test("R3 parity: non-realtime default pool routes identically to origin/main", (t) => {
  if (!baseline) return t.skip(baselineSkip);
  assert.deepEqual(routingDiffs(undefined, GRID), []);
});

test("R3 parity: non-realtime README pool (2304 profiles) routes identically to origin/main", (t) => {
  if (!baseline) return t.skip(baselineSkip);
  assert.equal(GRID.length, 2304);
  assert.deepEqual(routingDiffs(README_POOL, GRID), []);
});

for (const [name, pool] of Object.entries(NON_REALTIME_POOLS)) {
  test(`R3 parity: non-realtime pool routes identically to origin/main: ${name}`, (t) => {
    if (!baseline) return t.skip(baselineSkip);
    assert.deepEqual(routingDiffs(pool, SAMPLED_GRID), []);
  });
}

test("R3 parity: non-realtime options and inputs main ignores or treats its own way route identically", (t) => {
  if (!baseline) return t.skip(baselineSkip);
  const pool = ["claude-opus-5-5", "gpt-6-astra", "claude-sonnet-5-5"];
  // Pin and availability options are realtime-only; unhealthy names keep main's canonical matching.
  for (const options of [
    { constraintModel: "gpt-6-astra" },
    { pinnedBundle: "nope" },
    { constraintEffort: "low" },
    { unavailable: ["x"], launchFailures: { claude: { until: "2099-01-01T00:00:00Z" } } },
    { realtime_loop: false },
  ]) {
    assert.deepEqual(routingDiffs(pool, SAMPLED_GRID, options), [], JSON.stringify(options));
  }
  assert.deepEqual(
    routingDiffs(["kimi-k2.6-preview", "glm-5.2-latest", "claude-sonnet-5-5"], SAMPLED_GRID, { unhealthyModels: ["kimi-k2.6", "glm-5.2"] }),
    [],
  );
});

test("R3 parity: canonicalModel and resolveModelSpec match origin/main on every spelling", (t) => {
  if (!baseline) return t.skip(baselineSkip);
  const names = [...Object.keys(FIXTURE.canonical), "claude-opus-5-5:default", "openrouter/qwen/foo", "qwen/foo", "OpenRouter/OpenAI/GPT-5-Mini", "spark", "gemini-spark", "grok-spark", "gpt-5.3-spark", "gpt-5.3-codex_spark"];
  for (const name of names) {
    assert.equal(canonicalModel(name), baseline.catalog.canonicalModel(name), name);
    if (name.includes("codex-spark")) continue; // has its own entry now; see the Spark tests
    const head = resolveModelSpec(name);
    const base = baseline.catalog.resolveModelSpec(name);
    assert.equal(head.canonical, base.canonical, name);
    assert.equal(head.spec.tier, base.spec.tier, name);
    assert.deepEqual(head.spec.capabilities, base.spec.capabilities, name);
  }
});

const E2E_TEXTS = [
  "Fix the null check in src/foo.js and add a unit test",
  "Refactor the cross-module architecture to remove the race condition and find the root cause of the deadlock",
  "Write a short poem about autumn",
  "Look at this screenshot and tell me what is wrong with the layout",
  "Search the web for the latest pricing of hosted vector databases",
];
const E2E_POOLS = { README: README_POOL, modern: NON_REALTIME_POOLS["modern bare strings"], dated: NON_REALTIME_POOLS["dated openai and anthropic"] };

function conversation(text, turns) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: i === 0 ? text : `${text} (follow-up ${i})` });
    if (i < turns - 1) messages.push({ role: "assistant", content: `answer ${i}` });
  }
  return messages;
}

async function hooksRun(lib, text, pool, turns = 3) {
  const out = [];
  const store = new lib.continuity.SessionContinuityStore();
  for (let turn = 1; turn <= turns; turn++) {
    const ctx = { state: {}, options: { continuityStore: store, candidateModels: pool, now: NOW + turn * 1000 } };
    await lib.hooks.onRequest({ model: "agentcompass/auto", messages: conversation(text, turn) }, ctx);
    const r = ctx.state.route;
    out.push(r ? withoutAddedKeys({ ...r, scorer: null }) : null);
  }
  return out;
}

async function middlewareRun(lib, text, pool, turns = 3) {
  const out = [];
  const store = new lib.continuity.SessionContinuityStore();
  for (let turn = 1; turn <= turns; turn++) {
    const body = { model: "agentcompass/auto", messages: conversation(text, turn) };
    const ctx = { state: {}, options: { continuityStore: store, candidateModels: pool, now: NOW + turn * 1000 } };
    await lib.middleware.onRequest(body, ctx);
    out.push(withoutAddedKeys({ body, route: ctx.state.route ?? null }));
  }
  return out;
}

const HEAD_LIB = () => ({
  continuity: { SessionContinuityStore },
  hooks: { onRequest: hooksOnRequest },
  middleware: { onRequest: middlewareOnRequest },
  index: { handleSystemOneRequest },
});

test("R3 parity: hooks end to end routes non-realtime sessions identically to origin/main", async (t) => {
  if (!baseline) return t.skip(baselineSkip);
  for (const [poolName, pool] of Object.entries(E2E_POOLS)) {
    for (const text of E2E_TEXTS) {
      assert.deepEqual(await hooksRun(HEAD_LIB(), text, pool), await hooksRun(baseline, text, pool), `${poolName}: ${text}`);
    }
  }
});

test("R3 parity: middleware end to end routes non-realtime sessions identically to origin/main", async (t) => {
  if (!baseline) return t.skip(baselineSkip);
  for (const [poolName, pool] of Object.entries(E2E_POOLS)) {
    for (const text of E2E_TEXTS) {
      assert.deepEqual(await middlewareRun(HEAD_LIB(), text, pool), await middlewareRun(baseline, text, pool), `${poolName}: ${text}`);
    }
  }
});

test("R3 parity: the decision provider answers non-realtime requests identically to origin/main", async (t) => {
  if (!baseline) return t.skip(baselineSkip);
  const questions = baseline.scorer.buildJevScorerPayload({ objective: "x" }).questions;
  const answer = async (lib, state, pool) =>
    withoutAddedKeys(
      (await lib.handleSystemOneRequest({ model: "jev-6b-int8", state, questions }, { candidateModels: pool })).answers,
    );
  for (const pool of Object.values(E2E_POOLS)) {
    for (const message of E2E_TEXTS) {
      for (const extra of [{}, { previous_message_kind: "general_implementation", previous_message_reasoning: "high" }, { task: { hasVisualInput: true } }]) {
        const state = { message, ...extra };
        assert.deepEqual(await answer({ handleSystemOneRequest }, state, pool), await answer(baseline.index, state, pool));
      }
    }
  }
});

test("R3 parity: the scorer cache and prompt only gain what realtime_loop needs", async (t) => {
  if (!baseline) return t.skip(baselineSkip);
  // Main caches by objective alone, whatever other fields the task carries; only an explicit realtime_loop splits an entry.
  const options = {
    allowExternalScorer: true,
    scorerType: "openai_compatible",
    scorerBaseUrl: "http://127.0.0.1:9999",
    fetch: async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ...GRID[100], expected_hours: 1, task_count: "1" }) } }] }), { status: 200 }),
  };
  const run = async (score, salt) => {
    const objective = `cache parity ${salt}`;
    const first = await score({ objective, needs: { visual: true } }, options);
    const second = await score({ objective, work_kind: "web_research" }, options);
    return [first.meta.source, second.meta.source, withoutAddedKeys(first.profile), withoutAddedKeys(second.profile)];
  };
  assert.deepEqual(await run(scoreTaskLive, "a"), await run(baseline.scorer.scoreTaskLive, "a"));
  const prompt = (text) =>
    text.split("\n").filter((line) => !line.includes("realtime_loop") && !line.includes("previous_user") && line !== "CRITICAL RULES:").join("\n").trim();
  assert.equal(prompt(SCORER_SYSTEM_PROMPT), prompt(baseline.scorer.SCORER_SYSTEM_PROMPT));
});

test("R3 parity: continuation decisions and keepsEffort match origin/main without realtime", (t) => {
  if (!baseline) return t.skip(baselineSkip);
  const sessions = [
    { model: "claude-haiku-5-5", effort: "high", tokens: 100, updatedAt: NOW - 1000 },
    { model: "claude-haiku-5-5", effort: "low", tokens: 5000, cached: true, updatedAt: NOW - 1000 },
    { model: "claude-opus-5-5", effort: "xhigh", tokens: 100, updatedAt: NOW - 1000, realtimeLoop: false },
  ];
  const facts = [
    { turnText: "ok thanks, next", estimatedInputTokens: 50 },
    { within: true },
  ];
  for (const affinityMode of ["cache", "turn", "session", "strict"]) {
    for (const session of sessions) {
      for (const fact of facts) {
        const options = { now: NOW, affinityMode };
        assert.deepEqual(
          evaluateProviderContinuation(fact, session, options),
          baseline.continuity.evaluateProviderContinuation(fact, session, options),
        );
        assert.equal(
          keepsEffort(session, "low", 2048, NOW),
          baseline.continuity.keepsEffort(session, "low", 2048, NOW),
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Python AgentCompass parity
// ---------------------------------------------------------------------------------------------------------------------

test("R3 Python: fixture covers the agreed spellings and grid", () => {
  assert.ok(FIXTURE.variants.length >= 95, `${FIXTURE.variants.length} spellings`);
  assert.ok(FIXTURE.models.length >= 31, `${FIXTURE.models.length} models`);
  assert.equal(Object.keys(FIXTURE.responsiveness[FIXTURE.models[0]]).length, 9);
});

test("m1-R3 Python: responsiveness key equals allocator.canonical on every spelling", () => {
  const diffs = [];
  for (const [name, canonical] of Object.entries(FIXTURE.canonical)) {
    const { key, known } = resolveResponsivenessModelKey(name);
    if (key !== canonical) diffs.push(`${name}: js=${key} py=${canonical}`);
    // Spark has a catalog entry here and none in accounts.json; its speed is the same default either way
    const pyKnown = FIXTURE.models.includes(canonical) || canonical === "gpt-5.3-codex-spark";
    if (known !== pyKnown) diffs.push(`${name}: known=${known}`);
  }
  assert.deepEqual(diffs, []);
});

test("m1-R3 Python: named aliases and family fallbacks land where model_resolution.py puts them", () => {
  const key = (m) => resolveResponsivenessModelKey(m).key;
  assert.equal(key("zai-org-glm-5-2"), "glm-5.2");
  assert.equal(key("venice-api/zai-org-glm-5-2"), "glm-5.2");
  assert.equal(key("deepseek-flash"), "deepseek-v4.1-flash-free");
  assert.equal(key("deepseek-v4-flash"), "deepseek-v4.1-flash-free");
  assert.equal(key("claude-haiku-4-20250514"), "claude-haiku-5-5");
  // Aliases are never prefix-matched: `grok-4` must not swallow `grok-4-fast`.
  assert.equal(key("grok-4-fast"), "grok-4.7-build-fast");
  assert.equal(key("gpt-6.10-terra"), "gpt-6.1-terra");
});

test("R3 Python: bundleResponsiveness matches bundle_responsiveness for every model and spelling at 9 efforts", () => {
  const diffs = [];
  let compared = 0;
  for (const [name, efforts] of Object.entries(FIXTURE.responsiveness)) {
    for (const [effort, [value, source]] of Object.entries(efforts)) {
      const js = bundleResponsiveness({ model: name, effort });
      compared++;
      if (js.value !== value || js.source !== source) {
        diffs.push(`${name}@${effort}: js=${js.value}/${js.source} py=${value}/${source}`);
      }
    }
  }
  assert.ok(compared >= (FIXTURE.models.length + 95) * 9 - 9 * 5);
  assert.deepEqual(diffs.slice(0, 40), []);
});

test("R3 Python: resolveRealtimeEffort matches resolve_realtime_effort at the agreed effort grid and gates", () => {
  const diffs = [];
  for (const [model, effort, provider, gate, effective, value, source, steppedFrom] of FIXTURE.stepdown) {
    const js = resolveRealtimeEffort({ model, effort, provider, account: provider }, { realtime_loop: true }, {}, { gate });
    if (js.effort !== effective || js.responsiveness !== value || js.source !== source || js.steppedFrom !== steppedFrom) {
      diffs.push(`${model}@${effort} ${provider} gate=${gate}: js=${js.effort}<-${js.steppedFrom} ${js.responsiveness}/${js.source} py=${effective}<-${steppedFrom} ${value}/${source}`);
    }
  }
  assert.ok(FIXTURE.stepdown.length >= 31 * 9);
  assert.deepEqual(diffs.slice(0, 40), []);
});

test("R3 Python: static tables match accounts.json", () => {
  for (const [model, curve] of Object.entries(FIXTURE.effort_curves)) {
    if (curve.responsiveness) assert.deepEqual(EFFORT_RESPONSIVENESS[model], curve.responsiveness, model);
  }
  assert.deepEqual(DISPATCH_EFFORTS, FIXTURE.dispatch_efforts);
});

test("M1-R3: ability curves on realtime tasks are the ones accounts.json declares, never guessed", () => {
  for (const [model, curve] of Object.entries(FIXTURE.effort_curves)) {
    const js = resolveRealtimeCurves(model, canonicalModel(model));
    assert.deepEqual(js.ability, curve.ability, `${model} ability`);
  }
  // Non-realtime scoring still reads the routing table only.
  assert.equal(EFFORT_CURVES["deepseek-v4-pro"], undefined);
});

test("M1-R3: slow models with a flat ability curve are excluded, models without one step down", () => {
  const rtProfile = { ...GRID[0], work_kind: "general_implementation", reasoning_depth: 1, code_complexity: 1, needs_visual: false, needs_gui: false, realtime_loop: true };
  const stay = (model, provider) => resolveRealtimeEffort({ model, effort: "high", provider }, { realtime_loop: true }, {}, { gate: 3.0 });
  for (const model of ["deepseek-v4-pro", "deepseek-v4-pro-20260101", "deepseek-r1", "glm-5.3", "glm-5.3-latest", "mistral-large-4", "mistral-large-4-20260101"]) {
    const r = stay(model, "openrouter");
    assert.equal(r.effort, "high", model);
    assert.equal(r.steppedFrom, null, model);
  }
  assert.deepEqual([stay("grok-4.6", "xai").effort, stay("grok-4.6", "xai").responsiveness], ["low", 0.675]);
  assert.deepEqual([stay("xai/grok-4.6", "xai").effort, stay("xai/grok-4.6", "xai").steppedFrom], ["low", "high"]);
  assert.deepEqual([stay("claude-opus-4-7", "openrouter").effort, stay("claude-opus-4-7", "openrouter").responsiveness], ["none", 0.929]);
  assert.equal(stay("anthropic/claude-opus-4-7-20260101", "openrouter").effort, "none");

  const pool = ["deepseek-v4-pro:high", "glm-5.3:high", "mistral-large-4:high", { id: "spark", provider: "openrouter", model: "gpt-5.3-codex-spark", effort: "medium" }];
  const ranked = rankCandidates(rtProfile, { candidateModels: pool, now: NOW });
  assert.equal(ranked.selected?.id, "spark");
  for (const model of ["deepseek-v4-pro", "glm-5.3", "mistral-large-4"]) {
    const c = ranked.allCandidates.find((x) => x.model === model);
    assert.equal(c.eligible, false, model);
    assert.ok(c.excluded.some((e) => e.includes("too slow per turn")), model);
  }
});

test("M2-R3: pin identity follows allocator.canonical: a pin never crosses 4-x and 5-5", () => {
  const names = Object.keys(FIXTURE.canonical);
  const diffs = [];
  for (const pin of names) {
    // A pin's own `:effort` narrows it further, which Python's `canonical` has no notion of; ask at that effort.
    const effort = /:(none|off|minimal|low|medium|high|xhigh|max|ultra|auto|default)$/i.exec(pin)?.[1].toLowerCase() || "high";
    for (const model of names) {
      const js = isCandidatePinned({ model, effort }, canonicalModel(model), { constraint_model: pin });
      const py = FIXTURE.canonical[pin] === FIXTURE.canonical[model];
      // A pin may also name the candidate literally; Python only ever sees it canonicalized, and the two can only differ for unknown names.
      if (js !== py && !(js && pin.split("/").pop() === model.split("/").pop())) {
        diffs.push(`pin=${pin} model=${model}: js=${js} py=${py}`);
      }
    }
  }
  assert.deepEqual(diffs.slice(0, 40), []);

  const rtProfile = { ...GRID[0], work_kind: "general_implementation", reasoning_depth: 1, code_complexity: 1, needs_visual: false, needs_gui: false, realtime_loop: true };
  const opus46 = { id: "opus46", provider: "claude", model: "claude-opus-4-6", effort: "high" };
  const opus55 = { id: "opus55", provider: "claude", model: "claude-opus-5-5", effort: "high" };
  for (const pin of ["claude-opus-4-6", "anthropic/claude-opus-4-6-20250514"]) {
    const r = selectBestRoute(rtProfile, { candidateModels: [opus55, opus46], constraintModel: pin, now: NOW });
    assert.equal(r.targetModel, "claude-opus-4-6", pin);
    assert.equal(r.targetEffort, "high", pin);
    assert.ok(r.warnings.length > 0, pin);
  }
  const ranked = rankCandidates(rtProfile, { candidateModels: [opus55, opus46], constraintModel: "claude-opus-5-5", now: NOW });
  assert.equal(ranked.selected.id, "opus55");
  const slow = ranked.allCandidates.find((c) => c.id === "opus46");
  assert.equal(slow.eligible, false);
  assert.ok(slow.excluded.includes("explicit model constraint"));
});

test("M2-R3: a 5-5 candidate is not a sibling of an older opus, so the step-down is not blocked", () => {
  // Routing folds both names into claude-opus-5-5; allocator.py keeps them apart, so 5-5@medium does not defer 4-7@high.
  assert.equal(canonicalModel("claude-opus-4-7"), "claude-opus-4-7");
  assert.equal(resolveModelSpec("claude-opus-4-7").canonical, "claude-opus-5-5");
  const bundles = [
    { id: "o47", account: "acct", provider: "gw", model: "claude-opus-4-7", effort: "high" },
    { id: "o55", account: "acct", provider: "gw", model: "claude-opus-5-5", effort: "medium" },
  ];
  const r = resolveRealtimeEffort(bundles[0], { realtime_loop: true, bundles }, {}, { gate: 0 });
  assert.equal(r.effort, "none");
  assert.equal(r.steppedFrom, "high");
  // A real sibling (same responsiveness key) still takes precedence.
  const withSibling = [...bundles, { id: "o47none", account: "acct", provider: "gw", model: "anthropic/claude-opus-4-7", effort: "none" }];
  const held = resolveRealtimeEffort(withSibling[0], { realtime_loop: true, bundles: withSibling }, {}, { gate: 0 });
  assert.equal(held.effort, "high");
  assert.equal(held.steppedFrom, null);
});

test("R3: provider-less candidates stay on dispatchable efforts, with or without a known family", () => {
  const rtProfile = { ...GRID[0], work_kind: "general_implementation", reasoning_depth: 1, code_complexity: 1, needs_visual: false, needs_gui: false, realtime_loop: true };
  for (const [entry, allowed] of [
    ["claude-haiku-5-5", ["high"]],
    ["gpt-6-luna", ["high"]],
    ["claude-opus-4-6", ["high"]],
    ["grok-4.7", ["low", "high", "xhigh"]],
  ]) {
    const ranked = rankCandidates(rtProfile, { candidateModels: [entry], now: NOW });
    for (const c of ranked.allCandidates) {
      assert.ok(allowed.includes(c.effort), `${entry}: ${c.effort}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// M3-R3: realtime session continuation
// ---------------------------------------------------------------------------------------------------------------------

const REALTIME_FIRST_TURN = "Stay in the live match and react each turn";
const SCORER_PROFILE = {
  work_kind: "general_implementation",
  reasoning_depth: 2,
  code_complexity: 2,
  context_scale: 2,
  divergence: 2,
  hallucination_risk: 2,
  error_cost: 2,
  needs_visual: false,
  needs_gui: false,
  local_only: false,
  interaction_style: "engineering",
  expected_hours: 1.0,
};

/** Scorer that answers `realtime_loop: true` only on its first call: the follow-up alone would not read as realtime. */
function scorerOptions(store, pool, extra = {}) {
  let calls = 0;
  const options = {
    continuityStore: store,
    candidateModels: pool,
    allowExternalScorer: true,
    scorerType: "openai_compatible",
    scorerBaseUrl: "http://127.0.0.1:9/v1",
    scorerApiKey: "k",
    scorerModel: "m",
    useCache: false,
    now: NOW,
    fetch: async () => {
      calls += 1;
      const content = JSON.stringify({ ...SCORER_PROFILE, realtime_loop: calls === 1 });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    ...extra,
  };
  return { options, calls: () => calls };
}

async function hooksTurn(options, messages, extraBody = {}) {
  const ctx = { state: {}, options };
  await hooksOnRequest({ model: "agentcompass/auto", messages, ...extraBody }, ctx);
  return ctx;
}

const twoTurns = (second) => [
  { role: "user", content: REALTIME_FIRST_TURN },
  { role: "assistant", content: "ok" },
  { role: "user", content: second },
];

test("M3-R3: a short realtime session holds on turn 2, without rerouting or ratcheting the effort back up", async () => {
  const store = new SessionContinuityStore();
  const { options, calls } = scorerOptions(store, ["gpt-6-astra:xhigh", "gpt-5.3-codex-spark:high"]);
  const first = await hooksTurn(options, [{ role: "user", content: REALTIME_FIRST_TURN }]);
  assert.equal(first.state.route.realtimeLoop, true);
  assert.equal(store.get(first.state.sessionKey, NOW).realtimeLoop, true);
  const firstEffort = first.state.route.targetEffort;
  const firstModel = first.state.route.targetModel;

  const second = await hooksTurn(options, twoTurns("Here is the stack trace from the handler when a socket closes."));
  assert.equal(second.state.route.continuation.held, true);
  assert.equal(second.state.route.continuation.why, "realtime_loop");
  assert.equal(second.state.route.targetEffort, firstEffort);
  assert.equal(second.state.route.targetModel, firstModel);
  assert.equal(second.state.route.realtimeLoop, true);
  assert.equal(calls(), 1, "a hold does not call the scorer");
  assert.equal(store.get(first.state.sessionKey, NOW).realtimeLoop, true);
});

test("M3-R3: an explicit realtime_loop:false ends the realtime hold; a non-realtime session is untouched", async () => {
  const store = new SessionContinuityStore();
  const { options } = scorerOptions(store, ["gpt-6-astra:xhigh"]);
  const first = await hooksTurn(options, [{ role: "user", content: REALTIME_FIRST_TURN }]);
  assert.equal(first.state.route.realtimeLoop, true);
  const off = await hooksTurn(options, twoTurns("Now write up the summary."), { realtime_loop: false });
  assert.equal(off.state.route.continuation.held, false);
  assert.equal(off.state.route.realtimeLoop, false);
  assert.equal(store.get(first.state.sessionKey, NOW).realtimeLoop, false);
});

test("M3-R3: a realtime session is not moved off its fast model by tier escalation", () => {
  const session = { model: "gpt-6-luna", effort: "high", tokens: 5000, cached: true, realtimeLoop: true, updatedAt: NOW - 1000 };
  const facts = { demandsFrontierEscalation: true };
  const held = evaluateProviderContinuation(facts, session, { now: NOW });
  assert.equal(held.shouldHold, true);
  assert.equal(held.why, "cache");
  const notRealtime = evaluateProviderContinuation(facts, { ...session, realtimeLoop: false }, { now: NOW });
  assert.equal(notRealtime.shouldHold, false);
  assert.equal(notRealtime.reasonDetail, "tier_escalation_required");
  // A session's words alone never move it
  assert.equal(
    evaluateProviderContinuation({ turnText: "Redesign the distributed architecture and find the root cause of this deadlock" }, { ...session, realtimeLoop: false }, { now: NOW }).why,
    "cache",
  );
  // An explicit false, and the real reasons to move, still move it.
  assert.equal(evaluateProviderContinuation({ ...facts, realtime_loop: false }, session, { now: NOW }).reasonDetail, "tier_escalation_required");
  assert.equal(evaluateProviderContinuation({ hasCurrentTurnVisual: true }, { ...session, model: "grok-4.7" }, { now: NOW }).why, "capability_outgrown");
  assert.equal(evaluateProviderContinuation({}, session, { now: NOW, unhealthyModels: ["gpt-6-luna"] }).why, "provider_unhealthy");
  assert.equal(evaluateProviderContinuation({}, { ...session, cached: false, tokens: 10, updatedAt: NOW - 3 * 3600 * 1000 }, { now: NOW }).why, "cold");
});

test("M3-R3: keepsEffort reads the realtime flag off the session", () => {
  const session = { model: "gpt-6-astra", effort: "high", tokens: 5000, cached: true, realtimeLoop: true, updatedAt: NOW - 1000 };
  assert.equal(keepsEffort(session, "low", 2048, NOW), "low");
  assert.equal(keepsEffort(session, undefined, 2048, NOW), "high");
  assert.equal(keepsEffort(session, "low", 2048, NOW, { realtime_loop: false }), "high");
  assert.equal(keepsEffort({ ...session, realtimeLoop: false }, "low", 2048, NOW), "high");
});

test("M3-R3: a hold keeps the routed name instead of rewriting it to the canonical model", async () => {
  const store = new SessionContinuityStore();
  const options = { continuityStore: store, candidateModels: ["gpt-5.3-codex:medium"], now: NOW };
  const first = await hooksTurn(options, [{ role: "user", content: REALTIME_FIRST_TURN }], { realtime_loop: true });
  assert.equal(first.state.route.targetModel, "gpt-5.3-codex");
  store.recordResponse(first.state.sessionKey, { usage: { input_tokens: 2000, output_tokens: 300 } }, {}, NOW);
  const second = await hooksTurn(options, twoTurns("Redesign the distributed architecture and find the root cause of this deadlock."), {});
  assert.equal(second.state.route.continuation.held, true);
  assert.equal(second.state.route.targetModel, "gpt-5.3-codex");
  assert.equal(second.state.route.modelWithEffort, "gpt-5.3-codex:medium");
  assert.equal(second.state.route.realtimeLoop, true);
});

test("M3-R3: rerouting a realtime session keeps it realtime, so the effort is not ratcheted back up", async () => {
  const store = new SessionContinuityStore();
  const pool = ["gpt-6-astra:xhigh", "claude-sonnet-5-5:xhigh"];
  // Turn mode reroutes every new turn, and the scorer no longer calls this turn realtime.
  const { options } = scorerOptions(store, pool, { affinityMode: "turn" });
  const first = await hooksTurn(options, [{ role: "user", content: REALTIME_FIRST_TURN }]);
  assert.equal(first.state.route.realtimeLoop, true);
  const second = await hooksTurn(options, twoTurns("Here is what the live page shows now."));
  assert.equal(second.state.route.continuation.why, "turn_mode");
  assert.equal(second.state.route.continuation.held, false);
  assert.equal(second.state.route.realtimeLoop, true);
  assert.notEqual(second.state.route.targetEffort, "xhigh");
  assert.equal(store.get(first.state.sessionKey, NOW).realtimeLoop, true);

  // Same for a provider failure: the replacement is chosen for a live loop too.
  const failed = new SessionContinuityStore();
  const again = scorerOptions(failed, pool);
  const a = await hooksTurn(again.options, [{ role: "user", content: REALTIME_FIRST_TURN }]);
  const model = a.state.route.targetModel;
  const b = await hooksTurn({ ...again.options, unhealthyModels: [model] }, twoTurns("Here is what the live page shows now."));
  assert.equal(b.state.route.continuation.why, "provider_unhealthy");
  assert.equal(b.state.route.realtimeLoop, true);
  assert.notEqual(b.state.route.targetModel, model);
  assert.notEqual(b.state.route.targetEffort, "xhigh");
});

test("M3-R3: middleware keeps realtimeLoop through holds and across stateless replay", async () => {
  const pool = ["gpt-5.3-codex-spark:medium", "claude-sonnet-5-5:medium"];
  const turn = async (store, messages, extraBody = {}) => {
    const ctx = { state: {}, options: { continuityStore: store, candidateModels: pool, now: NOW } };
    const body = { model: "agentcompass/auto", messages, ...extraBody };
    await middlewareOnRequest(body, ctx);
    return { route: ctx.state.route, sessionKey: ctx.state.sessionKey, body };
  };
  const m1 = [{ role: "user", content: REALTIME_FIRST_TURN }];
  const m2 = [...m1, { role: "assistant", content: "ok" }, { role: "user", content: "here is the live state now" }];
  const m3 = [...m2, { role: "assistant", content: "ok" }, { role: "user", content: "and here is the next state" }];
  const store = new SessionContinuityStore();
  const first = await turn(store, m1, { realtime_loop: true });
  assert.equal(first.route.realtimeLoop, true);
  const second = await turn(store, m2);
  assert.equal(second.route.continuation.held, true);
  assert.equal(second.route.realtimeLoop, true);
  assert.equal(second.route.targetModel, first.route.targetModel);
  assert.equal(second.route.targetEffort, first.route.targetEffort);

  // A pooled runtime that never saw the session replays it from the history, whose first turn carried the flag.
  const replay = await turn(new SessionContinuityStore(), m3, { realtime_loop: true });
  assert.equal(replay.route.realtimeLoop, true);
  assert.equal(replay.route.continuation.held, true);
  assert.equal(replay.route.continuation.replayed, true);
  assert.equal(replay.route.targetModel, first.route.targetModel);
});

test("Sandbox: realtime_loop stops at the gateway and never reaches the upstream", async () => {
  const pool = ["gpt-6-astra:medium", "claude-sonnet-5-5:medium"];
  const run = async (extra) => {
    const ctx = { state: {}, options: { continuityStore: new SessionContinuityStore(), candidateModels: pool, now: NOW } };
    const body = { messages: [{ role: "user", content: "Tune the live loop" }], ...extra };
    const result = await middlewareOnRequest(body, ctx);
    return { body, result, route: ctx.state.route };
  };
  for (const flag of [true, false]) {
    const claimed = await run({ model: "agentcompass/auto", realtime_loop: flag });
    assert.equal(claimed.route.realtimeLoop, flag, "the router read the flag first");
    assert.ok(!("realtime_loop" in claimed.body));
    const named = await run({ model: "upstream/gpt-6-luna", realtime_loop: flag });
    assert.equal(named.result, named.body, "a hook only passes on a body it returns");
    assert.ok(!("realtime_loop" in named.body));
  }
  const needs = await run({ model: "agentcompass/auto", needs: { realtime_loop: true } });
  assert.equal(needs.route.realtimeLoop, true);
  assert.ok(!("needs" in needs.body));
  const otherNeeds = await run({ model: "agentcompass/auto", needs: { realtime_loop: true, visual: false } });
  assert.deepEqual(otherNeeds.body.needs, { visual: false });
  assert.equal((await run({ model: "upstream/gpt-6-luna" })).result, undefined, "a request without the flag is left alone");
  const notAFlag = await run({ model: "upstream/gpt-6-luna", realtime_loop: "yes" });
  assert.equal(notAFlag.result, undefined);
  assert.equal(notAFlag.body.realtime_loop, "yes");
});

test("Sandbox: pin options reach routing through the middleware and warn in the log", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const pool = ["upstream/gemini-4-argon-high", "upstream/gpt-6-astra"];
  const run = async (extra, pins) => {
    const ctx = { state: {}, options: { continuityStore: new SessionContinuityStore(), candidateModels: pool, now: NOW, ...pins } };
    const body = { model: "agentcompass/auto", messages: [{ role: "user", content: "Tune the live loop" }], ...extra };
    await middlewareOnRequest(body, ctx);
    return body.model;
  };
  const pin = { pinnedModel: "upstream/gemini-4-argon-high" };
  assert.match(await run({ realtime_loop: true }, {}), /^upstream\/gpt-6-astra:/);
  assert.equal(warn.mock.callCount(), 0);
  assert.equal(await run({ realtime_loop: true }, pin), "upstream/gemini-4-argon-high:high");
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /^agentcompass: pinned .*below the realtime_loop floor/);
  assert.equal(await run({}, pin), await run({}, {}), "a pin does nothing without realtime_loop");
  assert.equal(warn.mock.callCount(), 1);
});

test("m1-R4: a middleware with its own store keeps the realtime flag of the hooks' route", async () => {
  const pool = ["gpt-6-astra", "claude-sonnet-5-5"];
  const hooksStore = new SessionContinuityStore();
  const middlewareStore = new SessionContinuityStore();
  const messages = [{ role: "user", content: REALTIME_FIRST_TURN }];
  const ctx = { state: {}, options: { continuityStore: hooksStore, candidateModels: pool, now: NOW } };
  await hooksOnRequest({ model: "agentcompass/auto", messages, realtime_loop: true }, ctx);
  const route = ctx.state.route;
  assert.equal(route.realtimeLoop, true);
  // The flag reached the hooks only: the middleware has the route to go by
  middlewareOnRequest({ model: "agentcompass/auto", messages }, { state: { route }, options: { continuityStore: middlewareStore, candidateModels: pool, now: NOW } });
  assert.equal(middlewareStore.get(route.continuation.sessionKey, NOW).realtimeLoop, true);
  assert.equal(hooksStore.get(route.continuation.sessionKey, NOW).realtimeLoop, true);
});

const classifierSays = (realtime_loop) => {
  const answer = JSON.stringify({ reasoning_depth: 4, code_complexity: 3, context_scale: 2, divergence: 1, hallucination_risk: 3, error_cost: 3, interaction_style: "engineering", needs_visual: false, needs_gui: false, realtime_loop, work_kind: "debug_review", confidence: 0.9 });
  const reply = JSON.stringify({ choices: [{ message: { content: answer } }] });
  const fetch = async () => ({ ok: true, status: 200, text: async () => reply, json: async () => JSON.parse(reply) });
  return { scorerType: "openai_compatible", allowExternalScorer: true, scorerBaseUrl: "http://127.0.0.1:9/v1", scorerApiKey: "k", scorerModel: "m", fetch, useCache: false };
};

test("P1: a Tandem middleware with its own store follows a classifier-only realtime route on an effort-suffixed pool", async () => {
  const pools = {
    suffixed: ["claude-opus-5-5:xhigh", "gemini-4-argon-high:high", "gpt-6-astra:high", "claude-sonnet-5-5:medium"],
    bare: ["claude-opus-5-5", "gemini-4-argon-high", "gpt-6-astra", "claude-sonnet-5-5"],
  };
  const tandem = async (pool, shared, realtime) => {
    const hooksStore = new SessionContinuityStore();
    const store = shared ? hooksStore : new SessionContinuityStore();
    const options = { candidateModels: pool, now: NOW, ...classifierSays(realtime) };
    const body = { model: "agentcompass/auto", messages: [{ role: "user", content: "Find the root cause of the race in the scheduler across modules" }] };
    const ctx = { state: {}, options: { ...options, continuityStore: hooksStore } };
    await hooksOnRequest(body, ctx);
    const route = ctx.state.route;
    middlewareOnRequest(body, { state: { route }, options: { ...options, continuityStore: store } });
    return { route, final: body.model, stored: store.get(route.continuation.sessionKey, NOW)?.realtimeLoop };
  };
  for (const [name, pool] of Object.entries(pools)) {
    const own = await tandem(pool, false, true);
    assert.equal(own.route.realtimeLoop, true, name);
    assert.equal(own.final, `${own.route.targetModel}:${own.route.targetEffort}`, name);
    assert.equal(own.final, (await tandem(pool, true, true)).final, name);
    assert.equal(own.stored, true, name);
    assert.doesNotMatch(own.final, /^gemini-4-argon-high/, name);
  }
  // Without realtime the middleware routes for itself on a suffixed pool, as it does on origin/main, from the classifier's answer
  const noRealtime = await tandem(pools.suffixed, false, false);
  const solo = { model: "agentcompass/auto", messages: [{ role: "user", content: "Find the root cause of the race in the scheduler across modules" }] };
  middlewareOnRequest(solo, { state: {}, profile: noRealtime.route.profile, options: { candidateModels: pools.suffixed, now: NOW, continuityStore: new SessionContinuityStore() } });
  assert.equal(noRealtime.final, solo.model);
});

test("m2-R4: onProvider and the decision provider honor pins, and only under realtime_loop", async (t) => {
  t.mock.method(console, "warn", () => {});
  const pool = ["gemini-4-argon-high", "gpt-6-astra"];
  const pin = { pinnedModel: "gemini-4-argon-high" };
  const provider = async (extra, pins) => {
    const options = { continuityStore: new SessionContinuityStore(), candidateModels: pool, modelsByProvider: { p: pool }, routePerProvider: true, now: NOW, ...pins };
    const ctx = { state: {}, options };
    const body = { model: "agentcompass/auto", messages: [{ role: "user", content: "Tune the live loop" }], ...extra };
    await middlewareOnRequest(body, ctx);
    middlewareOnProvider(body, { ...ctx, provider: { id: "p" } });
    return body.model;
  };
  assert.equal(await provider({ realtime_loop: true }, pin), "gemini-4-argon-high:high");
  assert.match(await provider({ realtime_loop: true }, {}), /^gpt-6-astra:/);
  assert.equal(await provider({}, pin), await provider({}, {}));

  const questions = { effort: { type: "level" }, intent: { criteria: { "gemini-4-argon-high": "Argon", "gpt-6-astra": "Astra", none: "none of these" } } };
  const effort = async (state, pins) =>
    (await handleSystemOneRequest({ model: "jev-6b-int8", state: { message: "Tune the live loop", ...state }, questions }, { candidateModels: pool, ...pins })).answers.effort;
  assert.deepEqual(await effort({ realtime_loop: true }, { ...pin, pinnedEffort: "high" }), await effort({ realtime_loop: true }, { candidateModels: ["gemini-4-argon-high"], ...pin }));
  assert.notDeepEqual(await effort({ realtime_loop: true }, pin), await effort({ realtime_loop: true }, {}));
  assert.deepEqual(await effort({}, pin), await effort({}, {}), "no pin effect without realtime_loop");

  // When the quotas leave nothing, the second try without them keeps the pin too
  const spent = { kind: "subscription", quota: { windows: [{ name: "7d", used: 100, remaining: 0, resetsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString() }] } };
  const quotas = Object.fromEntries(["codex", "gemini", "antigravity", "openai", "google"].map((p) => [`${p}/a@example.com`, spent]));
  const intent = async (pins) =>
    (await handleSystemOneRequest({ model: "jev-6b-int8", state: { message: "Tune the live loop", realtime_loop: true, quotas }, questions }, { candidateModels: pool, ...pins })).answers.intent.choice;
  assert.equal(await intent(pin), "gemini-4-argon-high");
  assert.equal(await intent({}), "gpt-6-astra");
});

test("m3-R4: the slow pin warning names the model the speed was read for", () => {
  const profile = { ...GRID[0], work_kind: "general_implementation", reasoning_depth: 1, code_complexity: 1, needs_visual: false, needs_gui: false, realtime_loop: true };
  const warningOf = (candidate, pinnedModel) => selectBestRoute(profile, { candidateModels: [candidate], pinnedModel, now: NOW }).warnings[0];
  const row = (m) => FIXTURE.responsiveness[m].high[0].toFixed(2);
  assert.match(warningOf("claude-opus-4-6:high", "claude-opus-4-6"), new RegExp(`\\(claude-opus-4-6@high\\) responsiveness ${row("claude-opus-4-6")}`));
  assert.match(warningOf("gemini-4-argon-high:high", "gemini-4-argon-high"), /\(gemini-4-argon-high@high\)/);
  // A model whose speed doesn't apply is named as the speed was read too: this spelling's canonical model is grok-4.7
  assert.match(warningOf("grok-bot-20260101", "grok-bot-20260101"), /\(grok-bot@high\) responsiveness is not_applicable/);
});

const SPARK = "gpt-5.3-codex-spark";

test("Spark: every spelling has its own conservative entry and none resolves to gpt-6.1-sol", () => {
  for (const name of [SPARK, `openai/${SPARK}`, `codex/${SPARK}:medium`, "OpenAI/GPT-5.3-Codex-Spark", `${SPARK}-20260212`, `${SPARK}@20260212`, `${SPARK}-preview`, `${SPARK}-latest`]) {
    const { canonical, spec } = resolveModelSpec(name);
    assert.equal(canonical, SPARK, name);
    assert.equal(spec.tier, 3.0, name);
  }
  const spark = resolveModelSpec(SPARK).spec;
  const luna = resolveModelSpec("gpt-6-luna").spec;
  assert.ok(spark.tier <= luna.tier);
  assert.ok(spark.cost <= luna.cost);
  for (const [k, v] of Object.entries(spark.capabilities)) assert.ok(v <= luna.capabilities[k], k);
  assert.match(spark.basis, /Not in AgentCompass accounts\.json/);
  assert.equal(FIXTURE.models.includes(SPARK), false, "If AgentCompass lists Spark now, copy its values instead");
  // Other codex names keep the family fallback, the default pool never picks Spark
  assert.equal(resolveModelSpec("gpt-5.3-codex").canonical, "gpt-6.1-sol");
  assert.equal(resolveModelSpec("some-codex-model").canonical, "gpt-6.1-sol");
  // Spark's entry is for this model: another model's "spark" is not it
  for (const name of ["spark", "gemini-spark", "grok-spark", "gpt-5.3-spark", "gpt-5.3-codex_spark"]) assert.notEqual(resolveModelSpec(name).canonical, SPARK, name);
  assert.ok(rankCandidates(GRID[0], { now: NOW }).allCandidates.every((c) => c.canonicalModel !== SPARK));
  // Named in a realtime pool it runs on the same default as in AgentCompass
  assert.deepEqual(FIXTURE.responsiveness[SPARK].high, [0.52, "default"]);
  const bundle = bundleResponsiveness({ model: SPARK, effort: "high" });
  assert.deepEqual([bundle.value, bundle.source], [0.52, "default"]);
});

test("Spark: non-realtime differences from origin/main are all Spark's own entry, each with a reason", (t) => {
  if (!baseline) return t.skip(baselineSkip);
  // Every row names why origin/main, which scored Spark as gpt-6.1-sol (tier 3.6, its efforts and curves), chose otherwise.
  const reasonFor = (base, head, sparkRow) => {
    if (base.selected.canonicalModel !== "gpt-6.1-sol" || !base.selected.id.includes(SPARK)) return null;
    if (head.selected?.model?.includes(SPARK)) {
      return ["xhigh", "max"].includes(base.selected.effort) ? "effort-not-listed" : "no-effort-curve";
    }
    return sparkRow?.eligible ? "outscored-by-peer" : "below-the-task-gate";
  };
  const pools = { "spark alone": [SPARK], "spark + luna": [SPARK, "gpt-6-luna"], "spark + sol": [SPARK, "gpt-6.1-sol"], "spark + flash + sonnet": [SPARK, "claude-sonnet-5-5", "gemini-3.8-flash-high"] };
  const counts = {};
  for (const [name, pool] of Object.entries(pools)) {
    counts[name] = {};
    for (const profile of GRID) {
      const opts = { candidateModels: pool, now: NOW };
      const head = rankCandidates(profile, opts);
      const base = baseline.allocator.rankCandidates(profile, opts);
      if ((head.selected?.id ?? null) === (base.selected?.id ?? null)) continue;
      const sparkRows = head.allCandidates.filter((c) => c.model === SPARK);
      const reason = reasonFor(base, head, sparkRows.find((c) => c.eligible) || sparkRows[0]);
      assert.ok(reason, `${name}: a difference that is not Spark's: ${base.selected?.id} -> ${head.selected?.id} on ${JSON.stringify(profile)}`);
      counts[name][reason] = (counts[name][reason] || 0) + 1;
    }
    assert.ok(Object.keys(counts[name]).length > 0, `${name}: the entry changed nothing, so this test compares nothing`);
  }
  // Pools that do not name Spark are the "R3 parity" tests above: 0 differences.
  t.diagnostic(JSON.stringify(counts));
});
