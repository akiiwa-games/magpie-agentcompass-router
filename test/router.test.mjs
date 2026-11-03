import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { rankCandidates, selectBestRoute } from "../src/allocator.js";
import { DEFAULT_SCORING_POLICY } from "../src/catalog.js";
import {
  CACHE_COLD_MS,
  CHATGPT_CODEX_COLD_MS,
  SessionContinuityStore,
  WORKER_WORN_TOKENS,
  analyzeTurnState,
  coldAfterMs,
  computeSessionKey,
  evaluateProviderContinuation,
  firstWords,
  isShortFollowupMessage,
  keepsEffort,
  sha256Hex,
  userSaidFromText,
} from "../src/continuity.js";
import {
  ROUTE_CARRIER_KEY,
  onRequest as hookOnRequest,
  onResponse as hookOnResponse,
} from "../src/hooks.js";
import {
  AGENTCOMPASS_ICON_DATA_URI,
  AgentCompassRouterPlugin,
  DECISION_MODEL_ID,
  PROVIDER_ID,
  clearQuotasCache,
  evaluateLevelsProbe,
  evaluateModelQuota,
  handleSystemOneRequest,
  loadLiveQuotas,
  normalizeQuotaSnapshot,
  orderSeatsByQuotaEconomics,
} from "../src/index.js";
import {
  onAccount as mwOnAccount,
  onRequest as mwOnRequest,
  onResponse as mwOnResponse,
  onUsage as mwOnUsage,
  strategies,
} from "../src/middleware.js";
import { extractRequestFacts, inferTaskProfile, profileTask } from "../src/profiler-core.js";
import { clearProfileCache, scoreTaskLive } from "../src/scorer-live.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    assert.ok(["high", "xhigh", "max"].includes(decision.targetEffort));
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
  assert.match(afterMw.model, /^claude-opus-5-5:(high|xhigh|max)$/);
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

test("5. Pool strategy `agentcompass` / `agentcompass-pure` orders non-resting lowest-used seat indexes first", () => {
  const seats = [
    { key: "seat-resting", used: 10, resting: true },
    { key: "seat-busy", used: 80, resting: false },
    { key: "seat-fresh", used: 20, resting: false },
  ];
  const order1 = strategies.agentcompass("anthropic", seats, {});
  const order2 = strategies["agentcompass-pure"]("anthropic", seats, {});
  assert.deepEqual(order1, [2, 1, 0]);
  assert.deepEqual(order2, [2, 1, 0]);
  assert.deepEqual(order1.map((i) => seats[i].key), ["seat-fresh", "seat-busy", "seat-resting"]);
});

test("6. Magpie Plugin Market & GitHub Topic Discovery Contract (`package.json`, `icon`, `options`, `registry.json`)", async () => {
  assert.equal(profileTask, inferTaskProfile);
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, "agentcompass");
  assert.equal(pkg.magpie.name, "AgentCompass");
  assert.equal(pkg.magpie.hooks, "./src/hooks.js");
  assert.equal(pkg.magpie.middleware, "./src/middleware.js");
  assert.ok(pkg.magpie.icon.startsWith("data:image/svg+xml;base64,"));
  assert.equal(pkg.magpie.icon, AGENTCOMPASS_ICON_DATA_URI);

  const decodedSvg = Buffer.from(pkg.magpie.icon.split(",")[1], "base64").toString("utf8");
  assert.ok(decodedSvg.includes("<svg"), "Decoded icon must be valid SVG for Magpie StoreIcon()");

  for (const kw of ["magpie-plugin", "opencode", "opencode-plugin", "provider", "auth", "agentcompass", "intent-routing"]) {
    assert.ok(pkg.keywords.includes(kw), `package.json keywords must include "${kw}"`);
  }
  assert.equal(
    pkg.keywords.includes("pi-package"),
    false,
    "OpenCode plugins must not include 'pi-package' in keywords (pi.js:49 treats pi-package as a Pi extension instead of OpenCode plugin)"
  );

  const plugin = await AgentCompassRouterPlugin({ magpie: { option: (_p, k) => k === "prefer_local_heuristic" } }, {});
  assert.equal(plugin.auth.icon, AGENTCOMPASS_ICON_DATA_URI);
  const optKeys = plugin.auth.options.map((o) => o.key);
  assert.ok(optKeys.includes("prefer_local_heuristic"));
  assert.ok(optKeys.includes("live_scorer"));
  for (const key of optKeys) {
    assert.match(key, /^[a-z0-9_-]{1,40}$/);
  }

  const listing = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "docs", "magpie-community-registry-entry.json"), "utf8"));
  assert.equal(listing.package, "agentcompass");
  assert.equal(listing.name, "AgentCompass");
  assert.deepEqual(listing.providers, ["agentcompass"]);
  assert.equal(listing.kind, "middleware");
  assert.ok(listing.summary?.en && listing.summary?.zh);
});

test("7. Magpie-Aligned Session Affinity, Turn-Loop Lock, Cache-Temperature Hold & Switching (`src/continuity.js`)", async (t) => {
  await t.test("Scenario 1 (`why: first` & subagent isolation): New session runs intent routing and isolates `x-claude-code-agent-id` subagents", async () => {
    const store = new SessionContinuityStore();
    const t0 = 1_700_000_000_000;
    let scorerCalls = 0;

    // Verify pure-JS SHA-256 against NIST test vector ("abc")
    assert.equal(
      sha256Hex("abc"),
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );

    const req1 = {
      model: "agentcompass/auto",
      messages: [
        {
          role: "user",
          content:
            "Audit our distributed Raft consensus state machine across 4 modules to find the split-brain deadlock root cause.",
        },
      ],
    };

    const afterHook1 = await hookOnRequest(req1, {
      protocol: "chat",
      headers: { "x-session-id": "sess-main-1" },
      options: {
        continuityStore: store,
        now: t0,
        scorerType: "openai_compatible",
        scorerBaseUrl: "http://127.0.0.1:9999/v1",
        useCache: false,
        fetch: async () => {
          scorerCalls += 1;
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        work_kind: "debug_review",
                        reasoning_depth: 3,
                        code_complexity: 3,
                        context_scale: 3,
                        divergence: 1,
                        hallucination_risk: 3,
                        error_cost: 3,
                        needs_visual: false,
                        needs_gui: false,
                        local_only: true,
                        interaction_style: "engineering",
                        expected_hours: 2.0,
                        hours_confidence: "high",
                        urgency: "normal",
                        reason: "cross-module deadlock root cause",
                        multi_task: false,
                        task_count: "1",
                      }),
                    },
                  },
                ],
              }),
          };
        },
      },
    });

    assert.equal(scorerCalls, 1, "First turn of a new session must invoke intent scorer once");
    const carrier1 = afterHook1[ROUTE_CARRIER_KEY];
    assert.equal(carrier1.continuation.held, false);
    assert.equal(carrier1.continuation.why, "first");
    assert.equal(carrier1.canonicalModel, "claude-opus-5-5");

    // Simulate subagent sharing the same `x-session-id` but with `x-claude-code-agent-id`
    const subagentReq = {
      model: "agentcompass/auto",
      messages: [
        {
          role: "user",
          content: "Batch rename `old_var` to `new_var` across JSON fixtures.",
        },
      ],
    };
    const mainKey = computeSessionKey(req1, { headers: { "x-session-id": "sess-main-1" } });
    const subKey = computeSessionKey(subagentReq, {
      headers: {
        "x-session-id": "sess-main-1",
        "x-claude-code-agent-id": "subagent-haiku-worker",
      },
    });
    assert.notEqual(mainKey, subKey, "Subagent must have an isolated session key");

    await hookOnRequest(subagentReq, {
      protocol: "chat",
      headers: {
        "x-session-id": "sess-main-1",
        "x-claude-code-agent-id": "subagent-haiku-worker",
      },
      options: { continuityStore: store, now: t0 + 1000, prefer_local_heuristic: true },
    });

    // Main session must still hold `claude-opus-5-5`, unaffected by subagent
    assert.equal(store.get(mainKey, t0 + 1000).model, "claude-opus-5-5");
  });

  await t.test("Scenario 2 (`why: turn` mid-turn lock): Tool results & agent-injected `<system-reminder>` lock Provider/Model with 0 scorer calls", async () => {
    const store = new SessionContinuityStore();
    const t0 = 1_700_000_000_000;
    let scorerCalls = 0;
    const countingFetch = async () => {
      scorerCalls += 1;
      throw new Error("Scorer should NOT be called during mid-turn hold!");
    };

    // Turn 1: User starts a complex task on `claude-opus-5-5:high`
    const firstTurn = {
      model: "agentcompass/auto",
      messages: [
        {
          role: "user",
          content:
            "Refactor the distributed transaction coordinator across 4 microservices to fix the two-phase commit deadlock.",
        },
      ],
    };
    const hooked1 = await hookOnRequest(firstTurn, {
      protocol: "chat",
      headers: { "x-session-id": "sess-turn-lock" },
      options: { continuityStore: store, now: t0, prefer_local_heuristic: true },
    });
    const routed1 = mwOnRequest(structuredClone(hooked1), {
      protocol: "chat",
      headers: { "x-session-id": "sess-turn-lock" },
      options: { continuityStore: store, now: t0 },
    });
    assert.equal(routed1.model, "claude-opus-5-5:xhigh");

    // Step 2a: Assistant calls a tool, and the next request ends with `role: "tool"`
    const toolResultReq = {
      model: "agentcompass/auto",
      messages: [
        ...firstTurn.messages,
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "package coordinator // simple 10-line file",
        },
      ],
    };

    const hooked2a = await hookOnRequest(toolResultReq, {
      protocol: "chat",
      headers: { "x-session-id": "sess-turn-lock" },
      options: {
        continuityStore: store,
        now: t0 + 10 * 60 * 1000, // Even after 10 minutes (> 5m cache TTL), mid-turn `within: true` MUST still hold!
        scorerType: "openai_compatible",
        scorerBaseUrl: "http://127.0.0.1:9999/v1",
        fetch: countingFetch,
      },
    });
    assert.equal(scorerCalls, 0, "Mid-turn tool result must make 0 scorer calls");
    assert.equal(hooked2a[ROUTE_CARRIER_KEY].continuation.held, true);
    assert.equal(hooked2a[ROUTE_CARRIER_KEY].continuation.why, "turn");
    assert.equal(hooked2a[ROUTE_CARRIER_KEY].continuation.within, true);
    assert.equal(hooked2a[ROUTE_CARRIER_KEY].modelWithEffort, "claude-opus-5-5:xhigh");

    // Step 2b: Agent injects a `role: "user"` message containing only `<system-reminder>` and `TodoWrite` noise
    const agentNoiseReq = {
      model: "agentcompass/auto",
      messages: [
        ...toolResultReq.messages,
        {
          role: "user",
          content:
            "<system-reminder>Remember to run tests before finishing.</system-reminder>\n\nThe TodoWrite tool hasn't been used recently.",
        },
      ],
    };
    assert.equal(userSaidFromText(agentNoiseReq.messages[3].content), "");
    const turnState2b = analyzeTurnState(agentNoiseReq);
    assert.equal(turnState2b.within, true, "Agent-injected reminder must keep within === true");
    assert.equal(turnState2b.turn, 1, "Agent-injected reminder must not increment user turn count");

    const hooked2b = await hookOnRequest(agentNoiseReq, {
      protocol: "chat",
      headers: { "x-session-id": "sess-turn-lock" },
      options: {
        continuityStore: store,
        now: t0 + 12 * 60 * 1000,
        scorerType: "openai_compatible",
        scorerBaseUrl: "http://127.0.0.1:9999/v1",
        fetch: countingFetch,
      },
    });
    assert.equal(scorerCalls, 0);
    assert.equal(hooked2b[ROUTE_CARRIER_KEY].continuation.held, true);
    assert.equal(hooked2b[ROUTE_CARRIER_KEY].continuation.why, "turn");
  });

  await t.test("Scenario 3 (`why: cache` & `why: followup` + `keepsEffort`): Warm KV cache and short follow-up nudges hold model and ratchet effort", async () => {
    const store = new SessionContinuityStore();
    const t0 = 1_700_000_000_000;
    let scorerCalls = 0;

    // Turn 1: Complex task routes to `claude-opus-5-5:high`
    const turn1 = {
      model: "agentcompass/auto",
      messages: [
        {
          role: "user",
          content:
            "Audit the cross-module state synchronization protocol across gateway, worker, and store for race conditions.",
        },
      ],
    };
    const ctx1 = {
      protocol: "anthropic",
      headers: { "x-session-id": "sess-warm-cache" },
      options: { continuityStore: store, now: t0, prefer_local_heuristic: true },
    };
    const hooked1 = await hookOnRequest(turn1, ctx1);
    assert.equal(hooked1[ROUTE_CARRIER_KEY].modelWithEffort, "claude-opus-5-5:xhigh");

    // Simulate response returning 4,200 tokens (>= 1024 CACHE_WORTH_TOKENS) and cache creation
    await hookOnResponse(
      {
        id: "msg_1",
        model: "claude-opus-5-5",
        usage: {
          input_tokens: 1800,
          cache_creation_input_tokens: 2100,
          output_tokens: 300,
        },
      },
      ctx1
    );

    // Turn 2 (2 minutes later, within 5m Anthropic cache TTL): User asks a trivial routine question
    // Because the 4,200-token KV cache is warm, it MUST hold `claude-opus-5-5:xhigh` (`why: "cache"`) without calling scorer!
    const turn2 = {
      model: "agentcompass/auto",
      messages: [
        ...turn1.messages,
        { role: "assistant", content: "Here is the protocol audit and synchronization state machine." },
        { role: "user", content: "Also rename the variable `sync_flag` to `isSynced` in that file." },
      ],
    };
    const hooked2 = await hookOnRequest(turn2, {
      protocol: "anthropic",
      headers: { "x-session-id": "sess-warm-cache" },
      options: {
        continuityStore: store,
        now: t0 + 2 * 60 * 1000,
        scorerType: "openai_compatible",
        scorerBaseUrl: "http://127.0.0.1:9999/v1",
        fetch: async () => {
          scorerCalls += 1;
          throw new Error("Should not call scorer while KV cache is warm!");
        },
      },
    });
    assert.equal(scorerCalls, 0);
    assert.equal(hooked2[ROUTE_CARRIER_KEY].continuation.held, true);
    assert.equal(hooked2[ROUTE_CARRIER_KEY].continuation.why, "cache");
    assert.equal(hooked2[ROUTE_CARRIER_KEY].modelWithEffort, "claude-opus-5-5:xhigh");

    // Turn 3 (short follow-up "继续" / "ok go ahead" even when token count < 1024):
    assert.equal(isShortFollowupMessage("继续"), true);
    assert.equal(isShortFollowupMessage("好的，按这个改"), true);
    assert.equal(isShortFollowupMessage("ok, go ahead"), true);
    assert.equal(isShortFollowupMessage("lgtm"), true);

    // Verify `/v1/systemone` (`handleSystemOneRequest`) short follow-up inherits `previous_message_kind` & ratchets effort with 0 scorer calls
    const sysOneFollowup = await handleSystemOneRequest(
      {
        model: DECISION_MODEL_ID,
        state: {
          message: "继续",
          previous_message_kind: "debug_review",
          previous_message_reasoning: "high",
          previous_user_message: "Audit the distributed lock manager.",
          previous_assistant_reply: "I found two lock ordering inversions. Shall I continue?",
        },
        questions: {
          intent: {
            type: "choice",
            criteria: {
              debug_review: "Debugging and review",
              bounded_bulk_work: "Routine bulk edits",
              none: "None",
            },
          },
          effort: {
            type: "score",
            criteria: ["low", "medium", "high", "xhigh"],
          },
        },
      },
      {
        scorerType: "openai_compatible",
        scorerBaseUrl: "http://127.0.0.1:9999/v1",
        fetch: async () => {
          scorerCalls += 1;
          throw new Error("Short follow-up in /v1/systemone must not call external scorer!");
        },
      }
    );
    assert.equal(scorerCalls, 0);
    assert.equal(sysOneFollowup.answers.intent.choice, "debug_review");
    assert.ok(sysOneFollowup.answers.intent.confidence >= 0.9);
    assert.equal(sysOneFollowup.answers.effort.score, 2.0, "Effort must stay ratcheted at high (2.0)");
    assert.equal(sysOneFollowup.agentcompass.continuation.held, true);
    assert.equal(sysOneFollowup.agentcompass.continuation.why, "followup");

    // Verify `keepsEffort` directly: warm session on `xhigh` never drops to `low`
    const sessionSnap = store.get(hooked2[ROUTE_CARRIER_KEY].continuation.sessionKey, t0 + 2 * 60 * 1000);
    assert.equal(keepsEffort(sessionSnap, "low", 4200, t0 + 2 * 60 * 1000), "xhigh");
    // Verify ChatGPT/Codex & DeepSeek 1h cache TTL vs default 5m TTL
    assert.equal(coldAfterMs("claude-opus-5-5"), CACHE_COLD_MS);
    assert.equal(coldAfterMs("gpt-6.1-sol"), CHATGPT_CODEX_COLD_MS);
    assert.equal(coldAfterMs("deepseek-v4.1-flash-free"), CHATGPT_CODEX_COLD_MS);
  });

  await t.test("Scenario 4 (`why: capability_outgrown` / `outgrown` / `worn`): Modality, tier escalation, 95% context window, and 2M wear trigger re-routing", async () => {
    const store = new SessionContinuityStore();
    const t0 = 1_700_000_000_000;

    // 4a. Visual modality outgrowth: session starts on text-only `grok-4.7`, next turn sends an image
    const sessKeyVis = "sess-vis-outgrow";
    store.set(
      sessKeyVis,
      {
        model: "grok-4.7",
        effort: "medium",
        tokens: 4000,
        cached: true,
        healthy: true,
        turn: 1,
      },
      t0
    );
    const visReq = {
      model: "agentcompass/auto",
      session_id: sessKeyVis,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect this UI screenshot and diagnose the overlapping flex layout bug." },
            { type: "image_url", image_url: { url: "https://example.com/bug.png" } },
          ],
        },
      ],
    };
    const hookedVis = await hookOnRequest(visReq, {
      protocol: "chat",
      session_id: sessKeyVis,
      options: { continuityStore: store, now: t0 + 30_000, prefer_local_heuristic: true },
    });
    assert.equal(hookedVis[ROUTE_CARRIER_KEY].continuation.held, false);
    assert.equal(hookedVis[ROUTE_CARRIER_KEY].continuation.why, "capability_outgrown");
    assert.equal(hookedVis[ROUTE_CARRIER_KEY].continuation.reasonDetail, "visual_modality_required");
    assert.notEqual(hookedVis[ROUTE_CARRIER_KEY].canonicalModel, "grok-4.7");

    // 4b. Tier escalation outgrowth: session starts on lightweight `claude-haiku-5-5` (tier 3.2),
    // next turn asks for a complex cross-module architecture & deadlock refactoring
    const sessKeyTier = "sess-tier-outgrow";
    store.set(
      sessKeyTier,
      {
        model: "claude-haiku-5-5",
        effort: "low",
        tokens: 3000,
        cached: true,
        healthy: true,
        turn: 1,
      },
      t0
    );
    const tierReq = {
      model: "agentcompass/auto",
      messages: [
        { role: "user", content: "Rename `foo` to `bar`." },
        { role: "assistant", content: "Done." },
        {
          role: "user",
          content:
            "Now perform a cross-module architecture refactoring and root cause deadlock audit across our consensus engine.",
        },
      ],
    };
    const tierKey = computeSessionKey(tierReq, { headers: { "x-session-id": sessKeyTier } });
    store.set(tierKey, store.get(sessKeyTier, t0), t0);
    const hookedTier = await hookOnRequest(tierReq, {
      protocol: "chat",
      headers: { "x-session-id": sessKeyTier },
      options: { continuityStore: store, now: t0 + 20_000, prefer_local_heuristic: true },
    });
    assert.equal(hookedTier[ROUTE_CARRIER_KEY].continuation.held, false);
    assert.equal(hookedTier[ROUTE_CARRIER_KEY].continuation.why, "capability_outgrown");
    assert.equal(hookedTier[ROUTE_CARRIER_KEY].canonicalModel, "claude-opus-5-5");

    // 4c. Context window 95% outgrowth (`claude-opus-5-5` has 200k limit; 95% = 190k; pass 195k tokens)
    const outgrownReq = {
      model: "agentcompass/auto",
      estimated_input_tokens: 195_000,
      messages: [
        {
          role: "user",
          content: "Analyze the entire multi-module repository dump and architecture trade-offs.",
        },
      ],
    };
    const outgrownKey = computeSessionKey(outgrownReq, { headers: { "x-session-id": "sess-ctx-outgrow" } });
    store.set(
      outgrownKey,
      {
        model: "claude-opus-5-5",
        effort: "high",
        tokens: 195_000,
        cached: true,
        healthy: true,
        turn: 2,
      },
      t0
    );
    const hookedOutgrown = await hookOnRequest(outgrownReq, {
      protocol: "chat",
      headers: { "x-session-id": "sess-ctx-outgrow" },
      options: { continuityStore: store, now: t0 + 10_000, prefer_local_heuristic: true },
    });
    assert.equal(hookedOutgrown[ROUTE_CARRIER_KEY].continuation.held, false);
    assert.equal(hookedOutgrown[ROUTE_CARRIER_KEY].continuation.why, "outgrown");
    // Must switch to a model whose 95% context window >= 195k (e.g. `gemini-4-argon-high` 1M or `gpt-6-astra` 400k)
    assert.ok(
      ["gemini-4-argon-high", "gpt-6-astra", "gpt-6.1-terra", "gpt-6.1-sol"].includes(
        hookedOutgrown[ROUTE_CARRIER_KEY].canonicalModel
      ),
      `Expected >205k context model, got ${hookedOutgrown[ROUTE_CARRIER_KEY].canonicalModel}`
    );

    // 4d. 2M cumulative token wear (`compactedTokens + tokens >= 2,000,000`)
    const wornCheck = evaluateProviderContinuation(
      { within: false, turn: 15, estimatedInputTokens: 150_000 },
      {
        model: "claude-opus-5-5",
        effort: "high",
        tokens: 150_000,
        compactedTokens: WORKER_WORN_TOKENS - 100_000,
        cached: true,
        healthy: true,
        updatedAt: t0,
      },
      { now: t0 + 5_000 }
    );
    assert.equal(wornCheck.shouldHold, false);
    assert.equal(wornCheck.why, "worn");
  });

  await t.test("Scenario 5 (`why: cold` & `why: compacted`): Expired KV cache or `/compact` re-evaluates and cleanly downshifts on routine work", async () => {
    const store = new SessionContinuityStore();
    const t0 = 1_700_000_000_000;

    const routineFollowupReq = {
      model: "agentcompass/auto",
      messages: [
        {
          role: "user",
          content: "Audit the distributed consensus engine across modules.",
        },
        {
          role: "assistant",
          content: "Audit complete.",
        },
        {
          role: "user",
          content: "Perform a mechanical batch rename of `old_key` to `newKey` across the JSON fixtures.",
        },
      ],
    };
    const sessKey = computeSessionKey(routineFollowupReq, { headers: { "x-session-id": "sess-cold-downshift" } });
    store.set(
      sessKey,
      {
        model: "claude-opus-5-5",
        effort: "high",
        tokens: 8000,
        cached: true,
        healthy: true,
        turn: 1,
      },
      t0
    );

    // 5a. Advance clock by 6 minutes (> 5m Anthropic cacheCold): cache is now COLD
    const hookedCold = await hookOnRequest(routineFollowupReq, {
      protocol: "anthropic",
      headers: { "x-session-id": "sess-cold-downshift" },
      options: {
        continuityStore: store,
        now: t0 + 6 * 60 * 1000,
        prefer_local_heuristic: true,
      },
    });
    assert.equal(hookedCold[ROUTE_CARRIER_KEY].continuation.held, false);
    assert.equal(hookedCold[ROUTE_CARRIER_KEY].continuation.why, "cold");
    // Must downshift from `claude-opus-5-5` to lightweight `gemini-3.8-flash-high`!
    assert.equal(hookedCold[ROUTE_CARRIER_KEY].canonicalModel, "gemini-3.8-flash-high");

    // 5b. Reset to warm `claude-opus-5-5` with 20,000 tokens, then send a compacted context (2,000 tokens < 50% of 20,000)
    store.set(
      sessKey,
      {
        model: "claude-opus-5-5",
        effort: "high",
        tokens: 20_000,
        cached: true,
        healthy: true,
        turn: 2,
      },
      t0 + 10 * 60 * 1000
    );
    const compactedReq = {
      ...routineFollowupReq,
      estimated_input_tokens: 2_000,
    };
    const hookedCompacted = await hookOnRequest(compactedReq, {
      protocol: "anthropic",
      headers: { "x-session-id": "sess-cold-downshift" },
      options: {
        continuityStore: store,
        now: t0 + 11 * 60 * 1000, // Only 1 minute later, but tokens dropped from 20k -> 2k!
        prefer_local_heuristic: true,
      },
    });
    assert.equal(hookedCompacted[ROUTE_CARRIER_KEY].continuation.held, false);
    assert.equal(hookedCompacted[ROUTE_CARRIER_KEY].continuation.why, "compacted");
    assert.equal(hookedCompacted[ROUTE_CARRIER_KEY].canonicalModel, "gemini-3.8-flash-high");
    // Verify `compactedTokens` accumulated the pre-compaction 20,000 tokens
    assert.equal(store.get(sessKey, t0 + 11 * 60 * 1000).compactedTokens, 20_000);
  });

  await t.test("Scenario 6 (`why: provider_unhealthy`): Upstream 429/502 error in `onResponse` or `onUsage` marks model unhealthy and fails over", async () => {
    const store = new SessionContinuityStore();
    const t0 = 1_700_000_000_000;

    const req = {
      model: "agentcompass/auto",
      messages: [
        {
          role: "user",
          content: "Audit the cross-module concurrency lock graph and race condition invariants.",
        },
      ],
    };
    const ctx = {
      protocol: "chat",
      headers: { "x-session-id": "sess-failover" },
      options: { continuityStore: store, now: t0, prefer_local_heuristic: true },
    };

    const hooked1 = await hookOnRequest(req, ctx);
    assert.equal(hooked1[ROUTE_CARRIER_KEY].canonicalModel, "claude-opus-5-5");

    // Simulate upstream 429 rate-limit failure reported to `hookOnResponse` (or `mwOnUsage`)
    await hookOnResponse(
      { error: { message: "Rate limit exceeded", status: 429 } },
      { ...ctx, status: 429 }
    );
    assert.equal(store.isModelHealthy("claude-opus-5-5", t0 + 1000), false);

    // Retry the exact same request (or even a mid-turn tool loop): because `claude-opus-5-5` is unhealthy,
    // it MUST break the lock (`why: "provider_unhealthy"`) and switch to a healthy fallback model!
    const hooked2 = await hookOnRequest(req, {
      ...ctx,
      options: { ...ctx.options, now: t0 + 2000 },
    });
    assert.equal(hooked2[ROUTE_CARRIER_KEY].continuation.held, false);
    assert.equal(hooked2[ROUTE_CARRIER_KEY].continuation.why, "provider_unhealthy");
    assert.notEqual(
      hooked2[ROUTE_CARRIER_KEY].canonicalModel,
      "claude-opus-5-5",
      "Unhealthy model must be excluded on failover"
    );

    // Also verify `mwOnUsage` marking a model unhealthy on `{ rejected: true, status: 503 }`
    const fallbackModel = hooked2[ROUTE_CARRIER_KEY].canonicalModel;
    mwOnUsage(
      {
        session_id: hooked2[ROUTE_CARRIER_KEY].continuation.sessionKey,
        model: fallbackModel,
        rejected: true,
        status: 503,
      },
      { continuityStore: store, now: t0 + 3000 }
    );
    assert.equal(store.isModelHealthy(fallbackModel, t0 + 3500), false);
  });
});

test("Subscription Quota Economics: Opportunity Cost, Safety Margin Exclusion, Pre-Reset Sprint & Seat Ordering", async (t) => {
  await t.test("1. Exhausted subscription window (< 5% safety margin or < 10% short-window floor) excludes provider and routes to healthy subscription", () => {
    const t0 = 1_700_000_000_000;
    const implProfile = {
      work_kind: "general_implementation",
      reasoning_depth: 2,
      code_complexity: 2,
      context_scale: 1,
      divergence: 1,
      hallucination_risk: 2,
      error_cost: 2,
      needs_visual: false,
      needs_gui: false,
      local_only: true,
      interaction_style: "engineering",
      expected_hours: 0.5,
    };

    // Without quota constraints, `gpt-6.1-sol` (`gpt-5.3-codex`) wins `general_implementation`
    const baseline = selectBestRoute(implProfile, {
      candidateModels: ["gpt-5.3-codex", "claude-sonnet-4-6"],
      now: t0,
    });
    assert.equal(baseline.targetModel, "gpt-5.3-codex");

    // When `codex` has only 3% remaining on its 7d window (< 5% safety_margin_pct), it is excluded
    // and `claude-sonnet-4-6` (with 80% remaining) wins automatically!
    const withExhaustedCodex = selectBestRoute(implProfile, {
      candidateModels: ["gpt-5.3-codex", "claude-sonnet-4-6"],
      now: t0,
      quotas: {
        "codex/work@example.com": {
          kind: "subscription",
          quota: {
            windows: [
              { name: "7d", used: 97, remaining: 3, resetsAt: new Date(t0 + 48 * 3600 * 1000).toISOString() },
            ],
          },
        },
        "claude/pro@example.com": {
          kind: "subscription",
          quota: {
            windows: [
              { name: "7d", used: 20, remaining: 80, resetsAt: new Date(t0 + 72 * 3600 * 1000).toISOString() },
            ],
          },
        },
      },
    });
    assert.equal(withExhaustedCodex.targetModel, "claude-sonnet-4-6");
    assert.equal(withExhaustedCodex.selectedAccount, "claude/pro@example.com");
  });

  await t.test("2. High opportunity cost / scarcity on over-burned subscription shifts routing to well-funded subscription before hitting 0%", () => {
    const t0 = 1_700_000_000_000;
    const implProfile = {
      work_kind: "general_implementation",
      reasoning_depth: 2,
      code_complexity: 2,
      context_scale: 2,
      divergence: 1,
      hallucination_risk: 2,
      error_cost: 2,
      needs_visual: false,
      needs_gui: false,
      local_only: true,
      interaction_style: "engineering",
      expected_hours: 1.5,
    };

    // Codex has 14% left with 130h (5.4 days) remaining in its 168h week (burning 2.3%/h, high shortage probability & scarcity).
    // Claude has 92% left with 48h remaining in its week.
    const decision = selectBestRoute(implProfile, {
      candidateModels: ["gpt-5.3-codex", "claude-sonnet-4-6"],
      now: t0,
      quotas: {
        "codex/scarce@example.com": {
          kind: "subscription",
          quota: {
            windows: [
              {
                name: "7d",
                used: 86,
                remaining: 14,
                resetsAt: new Date(t0 + 130 * 3600 * 1000).toISOString(),
                pct_per_hour_24h: 2.2,
              },
            ],
          },
        },
        "claude/plentiful@example.com": {
          kind: "subscription",
          quota: {
            windows: [
              {
                name: "7d",
                used: 8,
                remaining: 92,
                resetsAt: new Date(t0 + 48 * 3600 * 1000).toISOString(),
              },
            ],
          },
        },
      },
    });
    assert.equal(
      decision.targetModel,
      "claude-sonnet-4-6",
      "High opportunity cost + scarcity on Codex should shift routing to plentiful Claude subscription"
    );
    assert.ok(decision.components.reset_bonus >= 0);
  });

  await t.test("3. Pre-reset surplus sprint (`reset_bonus` & `sprint_sunk`): harvests expiring subscription quota and unlocks higher effort", () => {
    const t0 = 1_700_000_000_000;
    const hardProfile = {
      work_kind: "general_implementation",
      reasoning_depth: 2,
      code_complexity: 2,
      context_scale: 2,
      divergence: 1,
      hallucination_risk: 2,
      error_cost: 2,
      needs_visual: false,
      needs_gui: false,
      local_only: true,
      interaction_style: "engineering",
      expected_hours: 1.0,
    };

    // Normally on `general_implementation` (depth 2), `claude-opus-4-6` pays an overqualification penalty
    // and `gpt-5.3-codex:high` wins.
    // Now give `claude` 65% remaining quota resetting in just 3 hours (`resetHours = 3 <= 36h horizon`)!
    const sprintDecision = selectBestRoute(hardProfile, {
      candidateModels: ["gpt-5.3-codex", "claude-opus-4-6"],
      now: t0,
      quotas: {
        "codex/normal@example.com": {
          kind: "subscription",
          quota: {
            windows: [
              {
                name: "7d",
                used: 45,
                remaining: 55,
                resetsAt: new Date(t0 + 100 * 3600 * 1000).toISOString(),
              },
            ],
          },
        },
        "claude/expiring-soon@example.com": {
          kind: "subscription",
          quota: {
            windows: [
              {
                name: "7d",
                used: 35,
                remaining: 65,
                resetsAt: new Date(t0 + 3 * 3600 * 1000).toISOString(),
              },
            ],
          },
        },
      },
    });

    assert.equal(
      sprintDecision.targetModel,
      "claude-opus-4-6",
      "Expiring Claude subscription with 65% surplus resetting in 3h must win via reset_bonus"
    );
    assert.ok(
      sprintDecision.components.reset_bonus > 0.8,
      `Expected reset_bonus > 0.8, got ${sprintDecision.components.reset_bonus}`
    );
    assert.ok(
      ["xhigh", "max"].includes(sprintDecision.targetEffort),
      `Pre-reset surplus sprint on non-routine work should waive effort penalty and unlock xhigh/max effort (got ${sprintDecision.targetEffort})`
    );
  });

  await t.test("4. Sticky session failover on quota exhaustion (`why: quota_exhausted`) & automatic `quotas.json` file discovery", async () => {
    const store = new SessionContinuityStore();
    const t0 = 1_700_000_000_000;

    // Create a temporary Magpie config directory with `quotas.json` and `providers.json`
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-quotas-test-"));
    const quotasFile = path.join(tmpDir, "quotas.json");
    fs.writeFileSync(path.join(tmpDir, "providers.json"), "{}", "utf8");
    fs.writeFileSync(
      quotasFile,
      JSON.stringify({
        "codex/acct1": {
          kind: "subscription",
          quota: {
            windows: [
              {
                name: "7d",
                used: 98,
                remaining: 2,
                resetsAt: new Date(t0 + 48 * 3600 * 1000).toISOString(),
              },
            ],
          },
        },
        "claude/acct1": {
          kind: "subscription",
          quota: {
            windows: [
              {
                name: "7d",
                used: 15,
                remaining: 85,
                resetsAt: new Date(t0 + 72 * 3600 * 1000).toISOString(),
              },
            ],
          },
        },
      }),
      "utf8"
    );
    clearQuotasCache();

    try {
      const loaded = loadLiveQuotas({ magpieConfigDir: tmpDir }, t0);
      assert.ok(loaded && loaded["codex/acct1"]);

      const req = {
        model: "agentcompass/auto",
        messages: [
          {
            role: "user",
            content: "Implement the next pagination helper method in the user service.",
          },
        ],
      };
      const sessKey = computeSessionKey(req, { headers: { "x-session-id": "sess-quota-spent" } });
      // Session was previously holding `gpt-5.3-codex` with warm KV cache
      store.set(
        sessKey,
        {
          model: "gpt-5.3-codex",
          effort: "high",
          provider: "codex",
          tokens: 12_000,
          cached: true,
          healthy: true,
          turn: 2,
        },
        t0
      );

      const hooked = await hookOnRequest(req, {
        protocol: "chat",
        headers: { "x-session-id": "sess-quota-spent" },
        options: {
          continuityStore: store,
          magpieConfigDir: tmpDir,
          candidateModels: ["gpt-5.3-codex", "claude-sonnet-4-6"],
          now: t0 + 15_000,
          prefer_local_heuristic: true,
        },
      });

      assert.equal(hooked[ROUTE_CARRIER_KEY].continuation.held, false);
      assert.equal(hooked[ROUTE_CARRIER_KEY].continuation.why, "quota_exhausted");
      assert.equal(hooked[ROUTE_CARRIER_KEY].targetModel, "claude-sonnet-4-6");
      assert.equal(hooked[ROUTE_CARRIER_KEY].selectedAccount, "claude/acct1");
    } finally {
      clearQuotasCache();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test("5. `strategies.agentcompass` pool seat ordering: `learns` -> pre-reset sprint -> healthy subscription -> API key -> low reserve -> resting/spent", () => {
    const t0 = 1_700_000_000_000;
    const seats = [
      // Index 0: Resting seat
      { key: "claude/resting", account: true, known: true, learns: false, used: 20, soon: [t0 + 48 * 3600_000], pace: 1.6, resting: true, tokens: 0 },
      // Index 1: Low-reserve seat (94% used >= 90% keepPercent)
      { key: "claude/low-reserve", account: true, known: true, learns: false, used: 94, soon: [t0 + 24 * 3600_000], pace: 0.25, resting: false, tokens: 100 },
      // Index 2: Unshared pay-as-you-go API key (`account: false`, `soon: []`)
      { key: "claude/api-key", account: false, known: false, learns: false, used: 0, soon: [], pace: 0, resting: false, tokens: 0 },
      // Index 3: Normal healthy subscription (50% used, 100h left)
      { key: "claude/normal-sub", account: true, known: true, learns: false, used: 50, soon: [t0 + 100 * 3600_000], pace: 0.5, resting: false, tokens: 500 },
      // Index 4: Pre-reset surplus sprint subscription (30% used = 70% left, renewing in 3 hours!)
      { key: "claude/sprint-sub", account: true, known: true, learns: false, used: 30, soon: [t0 + 3 * 3600_000], pace: 23.3, resting: false, tokens: 1000 },
      // Index 5: Unknown subscription that `learns` on its first response
      { key: "claude/learns-sub", account: true, known: false, learns: true, used: 0, soon: [], pace: 0, resting: false, tokens: 0 },
    ];

    const order = strategies.agentcompass("claude", seats, { now: t0 });
    assert.deepEqual(
      order,
      [5, 4, 3, 2, 1, 0],
      `Expected [learns(5), sprint(4), normalSub(3), apiKey(2), lowReserve(1), resting(0)], got [${order.join(", ")}]`
    );
  });

  await t.test("6. Strict AgentCompass Main-Repo Parity (`allocator.py` + `reference-accounts.json` invariants)", () => {
    // Verify calibrated subjective blend weights (0.49 / 0.34 / 0.17) and default_hours (0.4 / 1.0 / 2.0 / 3.5)
    assert.deepEqual(DEFAULT_SCORING_POLICY.profile.subjective, {
      weight: 0.49,
      vector_weight: 0.34,
      route_weight: 0.17,
    });
    assert.deepEqual(DEFAULT_SCORING_POLICY.default_hours, {
      routine: 0.4,
      hard: 1.0,
      coupled: 2.0,
      frontier: 3.5,
    });

    // Verify multi-task detection (`MULTI_TASK_MARK_RE`)
    const multiProfile = inferTaskProfile({
      objective: "Task 1: Refactor the auth middleware.\nTask 2: Build the billing CSV exporter.",
    });
    assert.equal(multiProfile.multi_task, true);
    assert.equal(multiProfile.task_count, "2");

    // Verify `free_usage` (+0.18 `unlimited_bonus`) on unlimited subscription accounts
    const unlimitedDec = selectBestRoute(
      {
        work_kind: "bounded_bulk_work",
        reasoning_depth: 1,
        code_complexity: 1,
        context_scale: 2,
        divergence: 1,
        hallucination_risk: 1,
        error_cost: 1,
        needs_visual: false,
        needs_gui: false,
        local_only: true,
        interaction_style: "engineering",
        expected_hours: 0.4,
      },
      {
        candidateModels: ["gpt-6.1-sol", "gemini-3.8-flash-high"],
        quotas: {
          "codex/unlimited@example.com": {
            kind: "subscription",
            unlimited: true,
          },
          "gemini/limited@example.com": {
            kind: "subscription",
            quota: {
              windows: [{ name: "7d", used: 40, remaining: 60, resetHours: 100 }],
            },
          },
        },
      }
    );
    assert.equal(unlimitedDec.targetModel, "gpt-6.1-sol");
    assert.equal(unlimitedDec.components.free_usage, 0.18);
  });
});


