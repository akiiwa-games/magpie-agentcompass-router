/**
 * Real Linux Sandbox End-to-End Verification (`test/linux-sandbox-e2e.mjs`)
 *
 * Runs inside an isolated Linux environment (WSL2 Alpine Linux x86_64 `/run/magpie-sandbox`)
 * against the compiled static Linux `magpie` binary (`magpie serve`) + Linux `bun` plugin host
 * + embedded `moejs` runtime.
 *
 * Verifies:
 * 1. All 4 Magpie plugin extension points load simultaneously in the real Linux `magpie` binary:
 *    - `async gateway hook onRequest` (`src/hooks.js` in Bun, up to 10,000 ms budget)
 *    - `gateway middleware onRequest, onAccount` (`src/middleware.js` in `moejs`, 250 ms budget)
 *    - `routings agentcompass/agentcompass` & `agentcompass/agentcompass-pure` (Pool strategy in `moejs`)
 *    - `agentcompass/agentcompass-systemone` (`src/index.js` OpenCode Decision Provider, `/v1/systemone`)
 * 2. Mode A (Two-Stage Tandem `hooks.js` [Bun] -> `middleware.js` [`moejs`]) with a **1,600 ms**
 *    async System-One scorer delay (75x the 20ms strategy limit, 6.4x the 250ms `moejs` limit,
 *    and exceeding the default 1,200ms hook limit via `gatewayTimeoutMs: 8000`).
 * 3. Multi-dimensional AgentCompass routing accuracy across diverse intents (`bounded_bulk_work`,
 *    `self_contained_code`, `debug_review`, `direction_reasoning`) and protocols (`/v1/chat/completions`
 *    and `/v1/responses`), including `<model>:<effort>` resolution and carrier cleanup.
 * 4. Mode B (Native Magpie Routing Group with `classifier=agentcompass/agentcompass-systemone`
 *    and `effort=auto`) calling `/v1/systemone` (`jevLevelled` + `jevBody`) end-to-end through Magpie!
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const SANDBOX_ROOT = process.env.MAGPIE_SANDBOX_ROOT || "/run/magpie-sandbox";
const MAGPIE_BIN = process.env.MAGPIE_BIN || path.join(SANDBOX_ROOT, "magpie");
const PLUGIN_DIR = process.env.PLUGIN_DIR || path.join(SANDBOX_ROOT, "agentcompass");

const ALL_MODELS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6.1-terra",
  "gpt-6-sol",
  "gpt-6-luna",
  "gemini-4-argon-high",
  "gemini-3.8-flash-high",
  "grok-4.7",
  "deepseek-v4.1-flash-free",
];

function runMagpieCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(MAGPIE_BIN, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `magpie ${args.join(" ")} failed (exit ${code}):\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`
          )
        );
      } else {
        resolve(stdout + stderr);
      }
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function listenRandomPort(server) {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(addr.port);
    });
    server.on("error", reject);
  });
}

async function main() {
  const report = {
    timestamp: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    sandboxRoot: SANDBOX_ROOT,
    steps: [],
  };

  console.log(`[Linux Sandbox] OS: ${process.platform} ${process.arch} (${os.release()})`);
  assert.equal(process.platform, "linux", "Must run inside Linux sandbox");

  // 1. Start Upstream Mock LLM Server
  const upstreamCalls = [];
  const upstreamServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: ALL_MODELS.map((id) => ({ id, object: "model", created: 1700000000, owned_by: "sandbox-upstream" })),
        })
      );
      return;
    }

    if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses")) {
      const body = await readJsonBody(req);
      const record = {
        path: url.pathname,
        model: body.model,
        reasoning_effort: body.reasoning_effort ?? body.reasoning?.effort ?? null,
        hasRouteCarrier: "__agentcompass_route" in body,
        body,
      };
      upstreamCalls.push(record);

      if (url.pathname === "/v1/responses") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: `resp_${upstreamCalls.length}`,
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "completed",
            model: body.model,
            output: [
              {
                type: "message",
                id: `msg_${upstreamCalls.length}`,
                status: "completed",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      routed_model: body.model,
                      reasoning_effort: record.reasoning_effort,
                      has_carrier: record.hasRouteCarrier,
                    }),
                    annotations: [],
                  },
                ],
              },
            ],
            usage: { input_tokens: 25, output_tokens: 15, total_tokens: 40 },
          })
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl_${upstreamCalls.length}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify({
                  routed_model: body.model,
                  reasoning_effort: record.reasoning_effort,
                  has_carrier: record.hasRouteCarrier,
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 25, completion_tokens: 15, total_tokens: 40 },
        })
      );
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Unhandled ${req.method} ${url.pathname}` } }));
  });

  // 2. Start Slow Async System-One Scorer Server (simulates 1,600 ms classification budget)
  const scorerCalls = [];
  let scorerDelayMs = 1600;
  const scorerServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const started = Date.now();
      const body = await readJsonBody(req);
      const userPrompt = String(body.messages?.[body.messages.length - 1]?.content || "");
      await new Promise((r) => setTimeout(r, scorerDelayMs));

      let profile;
      if (/deadlock|race condition|root cause/i.test(userPrompt)) {
        profile = {
          work_kind: "debug_review",
          interaction_style: "engineering",
          reasoning_depth: 4,
          code_complexity: 3,
          context_scale: 3,
          divergence: 1,
          hallucination_risk: 4,
          error_cost: 4,
          needs_visual: false,
          needs_gui: false,
          local_only: false,
        };
      } else if (/brainstorm|first-principles|creative|novel/i.test(userPrompt)) {
        profile = {
          work_kind: "direction_reasoning",
          interaction_style: "advisory",
          reasoning_depth: 3,
          code_complexity: 1,
          context_scale: 2,
          divergence: 4,
          hallucination_risk: 2,
          error_cost: 2,
          needs_visual: false,
          needs_gui: false,
          local_only: false,
        };
      } else if (/standalone|self-contained|lru cache/i.test(userPrompt)) {
        profile = {
          work_kind: "self_contained_code",
          interaction_style: "engineering",
          reasoning_depth: 2,
          code_complexity: 2,
          context_scale: 1,
          divergence: 1,
          hallucination_risk: 2,
          error_cost: 2,
          needs_visual: false,
          needs_gui: false,
          local_only: false,
        };
      } else {
        profile = {
          work_kind: "bounded_bulk_work",
          interaction_style: "engineering",
          reasoning_depth: 1,
          code_complexity: 1,
          context_scale: 1,
          divergence: 1,
          hallucination_risk: 1,
          error_cost: 1,
          needs_visual: false,
          needs_gui: false,
          local_only: false,
        };
      }

      scorerCalls.push({
        userAgent: req.headers["user-agent"] || "",
        elapsedMs: Date.now() - started,
        profile,
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `scorer_${scorerCalls.length}`,
          object: "chat.completion",
          model: body.model || "systemone-10d",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: JSON.stringify(profile),
              },
              finish_reason: "stop",
            },
          ],
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const upPort = await listenRandomPort(upstreamServer);
  const scorerPort = await listenRandomPort(scorerServer);
  const gwPort = 13425;

  let magpieProc = null;

  try {
    const env = {
      ...process.env,
      HOME: path.join(SANDBOX_ROOT, "home"),
      TMPDIR: path.join(SANDBOX_ROOT, "tmp"),
      XDG_CONFIG_HOME: path.join(SANDBOX_ROOT, "config"),
      XDG_CACHE_HOME: path.join(SANDBOX_ROOT, "cache"),
      XDG_DATA_HOME: path.join(SANDBOX_ROOT, "data"),
      XDG_STATE_HOME: path.join(SANDBOX_ROOT, "state"),
      MAGPIE_ADDR: `127.0.0.1:${gwPort}`,
      NO_COLOR: "1",
    };

    // 3. Configure Upstream Provider in Magpie
    const addProvOut = await runMagpieCli(
      [
        "provider",
        "add",
        "SandboxUpstream",
        "id=upstream",
        `url=http://127.0.0.1:${upPort}/v1`,
        `responses=http://127.0.0.1:${upPort}/v1`,
        "key=sk-sandbox-upstream",
        `models=${ALL_MODELS.join(",")}`,
      ],
      env
    );
    console.log("[Linux Sandbox] Added upstream provider:", addProvOut.trim());

    // 4. Verify Plugin Registration & Configure Options (8,000 ms hook budget + live System-One scorer)
    const pluginOptions = {
      gatewayTimeoutMs: 8000,
      scorerType: "openai_compatible",
      scorerBaseUrl: `http://127.0.0.1:${scorerPort}/v1`,
      scorerApiKey: "sk-sandbox-scorer",
      scorerModel: "systemone-10d",
      useCache: false,
      injectProtocolEffort: true,
    };
    const optOut = await runMagpieCli(["plugin", "options", PLUGIN_DIR, JSON.stringify(pluginOptions)], env);
    console.log("[Linux Sandbox] Configured plugin options:", optOut.trim());

    // 5. Configure Mode B Routing Group (`group/compass-group`) using `agentcompass/agentcompass-systemone`
    await runMagpieCli(
      [
        "group",
        "add",
        "Compass Group",
        "models=upstream/claude-opus-5-5,upstream/gpt-6.1-sol,upstream/gemini-4-argon-high,upstream/gemini-3.8-flash-high",
        "routing=order",
      ],
      env
    );
    await runMagpieCli(
      [
        "group",
        "set",
        "compass-group",
        "effort=auto",
        "classifier=agentcompass/agentcompass-systemone",
      ],
      env
    );
    await runMagpieCli(
      ["group", "rule", "add", "compass-group", "use=upstream/gemini-4-argon-high", "intent=direction_reasoning"],
      env
    );
    await runMagpieCli(
      ["group", "rule", "add", "compass-group", "use=upstream/claude-opus-5-5", "intent=debug_review"],
      env
    );
    await runMagpieCli(
      ["group", "rule", "add", "compass-group", "use=upstream/gpt-6.1-sol", "intent=self_contained_code"],
      env
    );
    await runMagpieCli(
      ["group", "rule", "add", "compass-group", "use=upstream/gemini-3.8-flash-high", "intent=bounded_bulk_work"],
      env
    );

    const groupShowOut = await runMagpieCli(["group", "show", "compass-group"], env);
    console.log("[Linux Sandbox] Configured Mode B Routing Group:\n" + groupShowOut.trim());

    // 6. Start real `magpie serve` daemon in Linux sandbox
    const magpieLogs = [];
    magpieProc = spawn(MAGPIE_BIN, ["serve"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    magpieProc.stdout.on("data", (d) => magpieLogs.push(d.toString("utf8")));
    magpieProc.stderr.on("data", (d) => magpieLogs.push(d.toString("utf8")));

    // Wait for `magpie healthcheck` to succeed
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${gwPort}/v1/models`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(ready, `magpie serve did not become ready on port ${gwPort}:\n${magpieLogs.join("")}`);
    console.log(`[Linux Sandbox] Real Linux 'magpie serve' is live on http://127.0.0.1:${gwPort}`);

    // =========================================================================
    // TEST CASE 1: Mode A (Two-Stage Tandem `hooks.js` [Bun] -> `middleware.js` [`moejs`])
    // with 1,600 ms async System-One classification (exceeding 20ms, 250ms, and 1200ms limits!)
    // =========================================================================
    {
      const t0 = Date.now();
      const resp = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local-agent" },
        body: JSON.stringify({
          model: "auto",
          messages: [
            {
              role: "user",
              content:
                "Investigate a complex cross-module distributed lock race condition and deadlock root cause across 15 microservices with zero regression.",
            },
          ],
        }),
      });
      const elapsedMs = Date.now() - t0;
      const data = await resp.json();
      assert.equal(resp.status, 200, `Expected 200, got ${resp.status}: ${JSON.stringify(data)}`);

      const lastUp = upstreamCalls[upstreamCalls.length - 1];
      const lastScorer = scorerCalls[scorerCalls.length - 1];
      assert.ok(lastScorer, "Async System-One scorer must be called by hooks.js in Bun");
      assert.equal(lastScorer.userAgent, "Magpie-Router/1.0", "Must send anti-recursion User-Agent header");
      assert.ok(lastScorer.elapsedMs >= 1500, `Scorer took ${lastScorer.elapsedMs}ms (>= 1500ms budget proof)`);
      assert.equal(lastUp.model, "claude-opus-5-5", "Should route complex root-cause debugging to claude-opus-5-5");
      assert.equal(lastUp.reasoning_effort, "max", "Frontier root-cause debugging (depth=4) selects claude-opus-5-5:max");
      assert.equal(lastUp.hasRouteCarrier, false, "middleware.js in moejs must strip __agentcompass_route");

      report.steps.push({
        test: "Mode A (1,600ms Async System-One -> hooks.js [Bun] -> middleware.js [moejs]) — Root Cause Debugging",
        elapsedMs,
        scorerElapsedMs: lastScorer.elapsedMs,
        routedModel: lastUp.model,
        routedEffort: lastUp.reasoning_effort,
        carrierStripped: !lastUp.hasRouteCarrier,
        pass: true,
      });
      console.log(
        `[PASS] Test 1 (Mode A 1.6s Async Budget): model="auto" -> ${lastUp.model}:${lastUp.reasoning_effort} in ${elapsedMs}ms`
      );
    }

    // =========================================================================
    // TEST CASE 2: Mode A — Creative First-Principles Brainstorming -> gemini-4-argon-high
    // =========================================================================
    scorerDelayMs = 200; // Speed up subsequent scorer calls while still exercising async HTTP in Bun
    {
      const resp = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local-agent" },
        body: JSON.stringify({
          model: "agentcompass/auto",
          messages: [
            {
              role: "user",
              content:
                "Brainstorm 5 unconventional first-principles creative architectural directions and novel product mechanics.",
            },
          ],
        }),
      });
      const data = await resp.json();
      assert.equal(resp.status, 200, `Expected 200, got ${resp.status}: ${JSON.stringify(data)}`);
      const lastUp = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(
        lastUp.model,
        "gemini-4-argon-high",
        "High divergence_need DNA should select gemini-4-argon-high"
      );
      assert.equal(lastUp.reasoning_effort, "high");
      report.steps.push({
        test: "Mode A — Creative First-Principles Brainstorming (Model DNA divergence=95)",
        routedModel: lastUp.model,
        routedEffort: lastUp.reasoning_effort,
        pass: true,
      });
      console.log(`[PASS] Test 2 (Mode A Divergence DNA): model="agentcompass/auto" -> ${lastUp.model}:${lastUp.reasoning_effort}`);
    }

    // =========================================================================
    // TEST CASE 3: Mode A — OpenAI `/v1/responses` Protocol — Self-Contained Coding -> gpt-6.1-sol
    // =========================================================================
    {
      const resp = await fetch(`http://127.0.0.1:${gwPort}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local-agent" },
        body: JSON.stringify({
          model: "auto",
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: "Implement a standalone self-contained LRU cache module in TypeScript with unit tests.",
                },
              ],
            },
          ],
        }),
      });
      const data = await resp.json();
      assert.equal(resp.status, 200, `Expected 200, got ${resp.status}: ${JSON.stringify(data)}`);
      const lastUp = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(lastUp.path, "/v1/responses");
      assert.equal(lastUp.model, "gpt-6.1-sol", "Single-module precision DNA should select gpt-6.1-sol");
      assert.equal(lastUp.reasoning_effort, "high");
      report.steps.push({
        test: "Mode A (`/v1/responses` protocol) — Self-Contained Module Coding (module_precision=95)",
        routedModel: lastUp.model,
        routedEffort: lastUp.reasoning_effort,
        pass: true,
      });
      console.log(`[PASS] Test 3 (Mode A /v1/responses): model="auto" -> ${lastUp.model}:${lastUp.reasoning_effort}`);
    }

    // =========================================================================
    // TEST CASE 4: Mode A — Routine Bounded Bulk Work -> gemini-3.8-flash-high (Overqualification Penalty)
    // =========================================================================
    {
      const resp = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local-agent" },
        body: JSON.stringify({
          model: "auto",
          messages: [
            {
              role: "user",
              content: "Perform a mechanical batch rename of foo_bar to fooBar across JSON fixtures.",
            },
          ],
        }),
      });
      const data = await resp.json();
      assert.equal(resp.status, 200, `Expected 200, got ${resp.status}: ${JSON.stringify(data)}`);
      const lastUp = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(
        lastUp.model,
        "gemini-3.8-flash-high",
        "Routine bounded bulk work should select lightweight gemini-3.8-flash-high and penalize expensive frontier models"
      );
      report.steps.push({
        test: "Mode A — Routine Bounded Bulk Work (Overqualification Penalty)",
        routedModel: lastUp.model,
        routedEffort: lastUp.reasoning_effort,
        pass: true,
      });
      console.log(`[PASS] Test 4 (Mode A Routine Bulk Work): model="auto" -> ${lastUp.model}:${lastUp.reasoning_effort}`);
    }

    // =========================================================================
    // TEST CASE 5: Mode B (Native Magpie Routing Group `group/compass-group` + `/v1/systemone` Classifier)
    // =========================================================================
    {
      const resp = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local-agent" },
        body: JSON.stringify({
          model: "group/compass-group",
          reasoning_effort: "medium",
          messages: [
            {
              role: "user",
              content:
                "Brainstorm unconventional creative product architecture directions from first-principles.",
            },
          ],
        }),
      });
      const data = await resp.json();
      assert.equal(resp.status, 200, `Expected 200, got ${resp.status}: ${JSON.stringify(data)}`);
      const lastUp = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(
        lastUp.model,
        "gemini-4-argon-high",
        "Mode B Routing Group should classify intent=direction_reasoning via /v1/systemone and route to gemini-4-argon-high"
      );
      assert.equal(
        lastUp.reasoning_effort,
        "high",
        "Mode B Routing Group effort=auto should upgrade medium -> high via /v1/systemone effort score"
      );
      report.steps.push({
        test: "Mode B (Native Routing Group `group/compass-group` via `/v1/systemone` Decision Provider) — Direction Reasoning",
        routedModel: lastUp.model,
        routedEffort: lastUp.reasoning_effort,
        pass: true,
      });
      console.log(
        `[PASS] Test 5 (Mode B /v1/systemone Classifier): model="group/compass-group" -> ${lastUp.model}:${lastUp.reasoning_effort}`
      );
    }

    // =========================================================================
    // TEST CASE 6: Mode B (`group/compass-group`) — Deep Root Cause Debugging -> claude-opus-5-5
    // =========================================================================
    {
      const resp = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local-agent" },
        body: JSON.stringify({
          model: "group/compass-group",
          reasoning_effort: "low",
          messages: [
            {
              role: "user",
              content:
                "Diagnose a multi-file memory corruption and deadlock root cause in the consensus state machine.",
            },
          ],
        }),
      });
      const data = await resp.json();
      assert.equal(resp.status, 200, `Expected 200, got ${resp.status}: ${JSON.stringify(data)}`);
      const lastUp = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(
        lastUp.model,
        "claude-opus-5-5",
        "Mode B Routing Group should classify intent=debug_review via /v1/systemone and route to claude-opus-5-5"
      );
      assert.equal(
        lastUp.reasoning_effort,
        "xhigh",
        "Mode B Routing Group effort=auto should upgrade low -> xhigh via /v1/systemone effort score (score=3 -> jevLevels[3]=xhigh)"
      );
      report.steps.push({
        test: "Mode B (Native Routing Group `group/compass-group` via `/v1/systemone` Decision Provider) — Debug Review",
        routedModel: lastUp.model,
        routedEffort: lastUp.reasoning_effort,
        pass: true,
      });
      console.log(
        `[PASS] Test 6 (Mode B /v1/systemone Classifier): model="group/compass-group" -> ${lastUp.model}:${lastUp.reasoning_effort}`
      );
    }

    // Save complete JSON report
    const reportPath = path.join(SANDBOX_ROOT, "e2e-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n[Linux Sandbox] ALL 6 LIVE E2E GATEWAY TESTS PASSED! Report written to ${reportPath}`);
  } finally {
    if (magpieProc && !magpieProc.killed) {
      magpieProc.kill("SIGTERM");
    }
    upstreamServer.close();
    scorerServer.close();
  }
}

main().catch((err) => {
  console.error("[Linux Sandbox] E2E Test Failed:", err);
  process.exit(1);
});
