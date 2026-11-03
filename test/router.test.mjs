import assert from "node:assert/strict";
import test from "node:test";

import { rankCandidates, selectBestRoute } from "../src/allocator.js";
import { ROUTE_CARRIER_KEY, onRequest as hookOnRequest } from "../src/hooks.js";
import {
  AgentCompassRouterPlugin,
  DECISION_MODEL_ID,
  PROVIDER_ID,
  evaluateLevelsProbe,
  handleSystemOneRequest,
} from "../src/index.js";
import { onAccount as mwOnAccount, onRequest as mwOnRequest, strategies } from "../src/middleware.js";
import { extractRequestFacts, inferTaskProfile } from "../src/profiler-core.js";
import { clearProfileCache, scoreTaskLive } from "../src/scorer-live.js";

test("1. Deterministic 10-Field Profiler & AgentCompass Pure Intent Allocation", async (t) => {
  await t.test("Routine bounded bulk work selects lightweight model (gemini-3.8-flash-high) and penalizes expensive overqualification", () => {
    const profile = inferTaskProfile({
      objective: "Perform a mechanical batch rename of `foo_bar` to `fooBar` across the JSON fixtures using a uniform rule.",
    });
    assert.equal(profile.work_kind, "bounded_bulk_work");
    assert.equal(profile.reasoning_depth, 1);

    const decision = selectBestRoute(profile);
    assert.equal(decision.ok, true);
    assert.equal(decision.difficulty, "routine");
    assert.equal(decision.canonicalModel, "gemini-3.8-flash-high");
    assert.equal(decision.targetEffort, "high");

    // Verify that expensive frontier models like gpt-6-astra or claude-fable-5-1 received overqualification penalty
    const ranked = rankCandidates(profile);
    const astraHigh = ranked.ranking.find((c) => c.canonicalModel === "gpt-6-astra" && c.effort === "high");
    assert.ok(astraHigh, "gpt-6-astra:high should be in eligible ranking");
    assert.ok(astraHigh.components.overqualification > 0, "gpt-6-astra:high should pay overqualification penalty on routine work");
  });

  await t.test("Convergent single-module production coding selects gpt-6.1-sol via module_precision DNA", () => {
    const profile = inferTaskProfile({
      objective: "Implement a standalone self-contained LRU cache algorithm module in TypeScript with unit tests.",
    });
    assert.equal(profile.work_kind, "self_contained_code");
    const decision = selectBestRoute(profile);
    assert.equal(decision.canonicalModel, "gpt-6.1-sol");
    assert.equal(decision.targetEffort, "high");
  });

  await t.test("Coupled cross-module deadlock & invariant audit selects claude-opus-5-5 via global_rigor + anti_hallucination", () => {
    const profile = inferTaskProfile({
      objective:
        "Conduct a read-only security audit and cross-module deadlock / race condition root-cause review across the gateway subsystem.",
    });
    assert.equal(profile.work_kind, "debug_review");
    assert.equal(profile.code_complexity, 0, "read-only review must force code_complexity=0");
    assert.equal(profile.reasoning_depth, 3);

    const decision = selectBestRoute(profile);
    assert.equal(decision.difficulty, "coupled");
    assert.equal(decision.canonicalModel, "claude-opus-5-5");
    assert.ok(["high", "max"].includes(decision.targetEffort));
  });

  await t.test("Open-ended divergent architecture ideation selects gemini-4-argon-high via divergence DNA (0.96)", () => {
    const profile = inferTaskProfile({
      objective:
        "Brainstorm and formulate a novel creative gameplay scheme and first-principles roadmap for an AI agent simulation game.",
      work_kind: "direction_reasoning",
    });
    assert.equal(profile.divergence, 3);
    assert.equal(profile.reasoning_depth, 3);

    const decision = selectBestRoute(profile);
    assert.equal(decision.workKind, "direction_reasoning");
    assert.equal(decision.canonicalModel, "gemini-4-argon-high");
  });

  await t.test("Frontier mathematical proof (reasoning_depth=4, floor=4.2) selects claude-opus-5-5", () => {
    const profile = inferTaskProfile({
      objective: "Provide a formal mathematical proof or refute the optimal-stopping theorem bound for this Markov chain.",
    });
    assert.equal(profile.reasoning_depth, 4);
    const decision = selectBestRoute(profile);
    assert.equal(decision.difficulty, "frontier");
    assert.equal(decision.canonicalModel, "claude-opus-5-5");
  });

  await t.test("GUI computer-use task routes to gpt-6-astra (#1 GUI grounding) and excludes text-only models", () => {
    const profile = inferTaskProfile({
      objective: "Operate the desktop app GUI: click the Settings button, take a screenshot, and toggle the proxy switch.",
    });
    assert.equal(profile.work_kind, "computer_use");
    assert.equal(profile.needs_gui, true);
    assert.equal(profile.needs_visual, true);

    const ranked = rankCandidates(profile);
    const grok = ranked.allCandidates.find((c) => c.canonicalModel === "grok-4.7");
    assert.ok(grok.excluded.includes("task needs visual input"), "text-only grok-4.7 must be excluded on visual/GUI work");
    assert.equal(ranked.selected.canonicalModel, "gpt-6-astra");
  });
});

test("2. Two-Stage Tandem (`magpie.hooks` [Bun 10s] -> `magpie.middleware` [`moejs` 250ms]) bypasses `host.js:1411` model rollback", async () => {
  const originalBody = {
    model: "auto",
    stream: true,
    messages: [
      {
        role: "user",
        content: "Review the diff and diagnose the cross-module race condition in internal/gateway/decide.go (read-only review).",
      },
    ],
    tools: [{ type: "function", function: { name: "read_file" } }],
  };

  let reportedOutcome = null;
  let reportedBytes = 0;
  const hookCtx = {
    protocol: "chat",
    agent: "claude-code",
    options: {
      gatewayTimeoutMs: 8000,
      scorerType: "heuristic",
      candidateModels: ["claude-opus-5-5", "gpt-6.1-sol", "gemini-3.8-flash-high"],
    },
    state: {},
    report(code, bytes) {
      reportedOutcome = code;
      reportedBytes = bytes;
    },
  };

  // Stage 1: Run Async Bun Hook (`src/hooks.js`)
  const afterHook = await hookOnRequest(structuredClone(originalBody), hookCtx);
  assert.ok(afterHook, "hookOnRequest should return a body with carrier");
  assert.equal(reportedOutcome, "ready");
  assert.ok(reportedBytes > 0);

  // Verify `host.js:1411` invariant: tools, tool_choice, function_call, functions, toolConfig, model, stream MUST be identical!
  for (const key of ["tools", "tool_choice", "function_call", "functions", "toolConfig", "model", "stream"]) {
    assert.equal(
      JSON.stringify(afterHook[key]),
      JSON.stringify(originalBody[key]),
      `host.js:1411 invariant violated on key: ${key}`,
    );
  }
  assert.ok(afterHook[ROUTE_CARRIER_KEY], "carrier __agentcompass_route must be present after Stage 1");
  assert.equal(afterHook[ROUTE_CARRIER_KEY].targetModel, "claude-opus-5-5");

  // Stage 2: Run Sync `moejs` Middleware (`src/middleware.js`)
  const mwCtx = {
    protocol: "chat",
    agent: "claude-code",
    options: { injectProtocolEffort: true },
    state: {},
  };
  const afterMw = mwOnRequest(afterHook, mwCtx);
  assert.ok(afterMw, "mwOnRequest should return mutated body");
  assert.equal(ROUTE_CARRIER_KEY in afterMw, false, "carrier must be stripped before reaching upstream");
  assert.match(afterMw.model, /^claude-opus-5-5:(high|max)$/);
  assert.ok(["high", "xhigh"].includes(afterMw.reasoning_effort));

  // Verify `onAccount` can read `mwCtx.state.agentcompass`
  const skipRes = mwOnAccount(
    { provider: "openai", account: "openai#1" },
    {
      state: mwCtx.state,
      options: { accountsByWorkKind: { debug_review: ["anthropic#1"] } },
    },
  );
  assert.deepEqual(skipRes, { skip: true });
});

test("3. Live System-One Scorer (`openai_compatible` and `jev`) with LRU Cache & Deadline Fallback", async (t) => {
  clearProfileCache();

  await t.test("Live OpenAI-compatible scorer parses 10-field JSON profile and caches it", async () => {
    let fetchCalls = 0;
    const mockFetch = async (_url, init) => {
      fetchCalls++;
      // Verify RouterAgent header is sent to prevent recursive Magpie classification
      assert.equal(init.headers["User-Agent"], "Magpie-Router/1.0");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  work_kind: "frontend_implementation",
                  reasoning_depth: 2,
                  code_complexity: 2,
                  context_scale: 1,
                  divergence: 2,
                  hallucination_risk: 2,
                  error_cost: 2,
                  needs_visual: true,
                  needs_gui: false,
                  local_only: true,
                  interaction_style: "engineering",
                  expected_hours: 1.0,
                  hours_confidence: "high",
                  urgency: "unknown",
                  reason: "Frontend React dashboard component with visual styling.",
                  multi_task: false,
                  task_count: "1",
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const task = { objective: "Build the interactive React analytics dashboard component from the Figma spec." };
    const first = await scoreTaskLive(task, {
      scorerType: "openai_compatible",
      scorerBaseUrl: "http://127.0.0.1:4096",
      scorerModel: "gemini-3.8-flash-high",
      fetch: mockFetch,
    });
    assert.equal(first.meta.source, "system_one_live");
    assert.equal(first.profile.work_kind, "frontend_implementation");
    assert.equal(fetchCalls, 1);

    // Second call with identical task hits LRU cache in 0ms without calling fetch
    const second = await scoreTaskLive(task, {
      scorerType: "openai_compatible",
      scorerBaseUrl: "http://127.0.0.1:4096",
      scorerModel: "gemini-3.8-flash-high",
      fetch: mockFetch,
    });
    assert.equal(second.meta.cached, true);
    assert.equal(fetchCalls, 1);
  });

  await t.test("Timeout or HTTP failure gracefully falls back to deterministic twin without failing closed", async () => {
    clearProfileCache();
    const failingFetch = async () => {
      throw new Error("Simulated timeout");
    };
    const res = await scoreTaskLive(
      { objective: "Fix the memory leak in the WebSocket connection pool." },
      { scorerType: "openai_compatible", fetch: failingFetch },
    );
    assert.equal(res.meta.source, "heuristic_fallback");
    assert.equal(res.profile.work_kind, "debug_review");
  });
});

test("4. Native Magpie `/v1/systemone` Decision Provider (`decide: true` / `decides: true`)", async () => {
  // 4a. Test `jevLevelled` probe (`decide.go:310`)
  const levelProbe = await handleSystemOneRequest({
    model: DECISION_MODEL_ID,
    state: { kinds: ["简单日常", "常规开发", "复杂跨模块架构"] },
    questions: {
      levels: { type: "noul" },
      work0: { type: "score" },
      work1: { type: "score" },
      work2: { type: "score" },
    },
  });
  assert.ok(levelProbe.answers.levels.noul >= 0.5, "difficulty scale intents must be recognized as levels");
  assert.ok(levelProbe.answers.work0.score < levelProbe.answers.work2.score);

  // 4b. Test `jevBody` turn classification (`decide.go:167`)
  const turnDecision = await handleSystemOneRequest({
    model: DECISION_MODEL_ID,
    state: {
      turn: "Please conduct a read-only security audit and race condition review across the authentication middleware.",
    },
    questions: {
      intent: {
        type: "choice",
        criteria: {
          frontend_implementation: "Frontend UI work",
          debug_review: "Bug diagnosis and code review",
          bounded_bulk_work: "Simple batch edits",
          none: "None of the above",
        },
      },
      effort: {
        type: "score",
        criteria: ["low", "medium", "high", "xhigh"],
      },
    },
  });
  assert.equal(turnDecision.answers.intent.choice, "debug_review");
  assert.ok(turnDecision.answers.intent.confidence >= 0.6, "confidence must clear Magpie's jevSure (0.6)");
  assert.ok(turnDecision.answers.effort.score >= 2.0, "coupled review must select high/xhigh effort (>= 2.0)");

  // 4c. Test OpenCode / Magpie plugin registration and loader.fetch
  assert.equal(PROVIDER_ID, "agentcompass");
  const plugin = await AgentCompassRouterPlugin({ magpie: { option: () => false } }, {});
  const cfg = {};
  await plugin.config(cfg);
  assert.equal(cfg.provider[PROVIDER_ID].name, "AgentCompass");
  assert.equal(cfg.provider[PROVIDER_ID].decide, true);
  assert.equal(cfg.provider[PROVIDER_ID].models[DECISION_MODEL_ID].decides, true);

  const loaded = await plugin.auth.loader();
  const httpRes = await loaded.fetch("https://agentcompass.local/v1/systemone", {
    method: "POST",
    body: JSON.stringify({
      model: DECISION_MODEL_ID,
      state: { turn: "Batch rename all `old_id` fields to `new_id` across fixtures." },
      questions: {
        intent: {
          type: "choice",
          criteria: {
            bounded_bulk_work: "Bulk edits",
            debug_review: "Debugging",
            none: "None",
          },
        },
        effort: { type: "score", criteria: ["low", "medium", "high", "xhigh"] },
      },
    }),
  });
  assert.equal(httpRes.status, 200);
  const json = await httpRes.json();
  assert.equal(json.answers.intent.choice, "bounded_bulk_work");
});

test("5. Pool strategy `agentcompass` / `agentcompass-pure` orders non-resting lowest-used seats first", () => {
  const seats = [
    { key: "seat-resting", used: 10, resting: true },
    { key: "seat-busy", used: 80, resting: false },
    { key: "seat-fresh", used: 20, resting: false },
  ];
  assert.deepEqual(strategies.agentcompass("anthropic", seats, {}), ["seat-fresh", "seat-busy", "seat-resting"]);
  assert.deepEqual(strategies["agentcompass-pure"]("anthropic", seats, {}), ["seat-fresh", "seat-busy", "seat-resting"]);
});
