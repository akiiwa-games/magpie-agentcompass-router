/**
 * Real Linux Sandbox Full-Chain E2E & Plugin Market Verification (`test/linux-sandbox-e2e.mjs`)
 *
 * Runs inside an isolated Linux environment (WSL2 Linux x86_64 `/run/magpie-sandbox`)
 * against the compiled static Linux `magpie` binary (`magpie web` + gateway daemon)
 * + Linux `bun` plugin host + embedded `moejs` runtime.
 *
 * Records the Magpie version it ran (`magpie --version`) in the report. The package ships the middleware alone
 * (no `magpie.hooks`, no async scorer): Mode A is `src/middleware.js` on the virtual models `agentcompass` /
 * `agentcompass/*`, Mode B is the decision provider's `/v1/systemone` (opt-in `enableDecisionProvider`).
 *
 * Scenarios:
 * - Scenario 1: CLI Plugin Lifecycle (`magpie plugin add`, `login`, `list`, `magpie.name`, `magpie.icon`)
 * - Scenario 2: Plugin Market (`MAGPIE_PLUGIN_MARKET` registry.json) & Web/GUI API (`/api/plugins/listings`,
 *   `/api/plugins`, `/api/plugins/page`, `POST /api/plugins/off` toggle, `POST /api/plugins/options`)
 * - Scenario 3: Mode A latency/budget (`agentcompass/auto` never waits for a 1,600ms System One scorer; overhead
 *   inside moejs's 250ms budget; no candidateModels -> HTTP 400)
 * - Scenario 4: Mode A Model DNA differentiation (ideation, self-contained coding on `/v1/responses`, bulk, debugging)
 * - Scenario 5: Mode A Anthropic `/v1/messages` & `/v1/chat/completions` SSE streaming (`stream: true`)
 * - Scenario 6: Degradation when System One is unavailable/slow (Mode B scorer HTTP 500 / timeout -> heuristic;
 *   Mode A unaffected)
 * - Scenario 7: Mode B Native Routing Group (`group/compass-group`) via `/v1/systemone` Decision Provider
 *   (specific intent rules, `"none of these"` fallback rule, and `effort=auto` 4-level Jev logprobs scaling)
 * - Scenario 8: Mode A session affinity, mid-turn tool lock (`within: true`) & short follow-up hold
 * - Scenario 9: Non-realtime requests reach the upstream exactly as a second Magpie running the origin/main build sends
 *   them (`BASELINE_PLUGIN_DIR`; pools, name spellings, protocols, sessions)
 * - Scenario 10: `realtime_loop: true` excludes Argon high and steps efforts down, on every protocol
 * - Scenario 11: A realtime session's later turns hold, with no reroute and no effort ratchet
 * - Scenario 12: A pinned slow model is kept, with a warning in Magpie's log
 * - Scenario 13: Real upstreams (`REAL_CODEX_AUTH`, `REAL_CLAUDE_AUTH`, `REAL_GROK_AUTH`): for each, no `realtime_loop` on
 *   the wire, routes as on the mock, and the `openai_compatible` classifier on 12 paired hard cases
 */

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const SANDBOX_ROOT = process.env.MAGPIE_SANDBOX_ROOT || "/run/magpie-sandbox";
const MAGPIE_BIN = process.env.MAGPIE_BIN || path.join(SANDBOX_ROOT, "magpie");
const PLUGIN_DIR = process.env.PLUGIN_DIR || path.join(SANDBOX_ROOT, "agentcompass");
const BASELINE_PLUGIN_DIR = process.env.BASELINE_PLUGIN_DIR || "";
const REAL_CODEX_AUTH = process.env.REAL_CODEX_AUTH || "";
const REAL_CLAUDE_AUTH = process.env.REAL_CLAUDE_AUTH || "";
const REAL_GROK_AUTH = process.env.REAL_GROK_AUTH || "";

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

// Spellings the upstream serves too, for Scenario 9's pools
const VARIANT_MODELS = [
  "claude-opus-5-5-20261001",
  "claude-sonnet-5-5-latest",
  "gpt-6.1-sol-20261001",
  "gpt-6-luna-chat",
  "gemini-4-argon-high-preview",
  "gemini-3.8-flash-high-latest",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "gpt-5.4",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "grok-4.7-build-fast",
];

function runMagpieCli(args, env, bin = MAGPIE_BIN) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
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

// The upstream provider and routing group a Magpie under test is given; Scenario 9 needs two identical ones.
async function configureGateway(env, upPort, pluginDir, pluginOptions, bin = MAGPIE_BIN) {
  const addProvOut = await runMagpieCli(
    [
      "provider",
      "add",
      "SandboxUpstream",
      "id=upstream",
      `url=http://127.0.0.1:${upPort}/v1`,
      `responses=http://127.0.0.1:${upPort}/v1`,
      "key=sk-sandbox-upstream",
      `models=${[...ALL_MODELS, ...VARIANT_MODELS].join(",")}`,
    ],
    env,
    bin
  );
  console.log("[Linux Sandbox] Added upstream provider:", addProvOut.trim());

  await runMagpieCli(["plugin", "options", pluginDir, JSON.stringify(pluginOptions)], env, bin);

  // Mode B Routing Group (`group/compass-group`) using `agentcompass/agentcompass-systemone`
  // Note: first model in `models=` is `upstream/gpt-6-luna` so `"none of these"` fallback lands on `gpt-6-luna`!
  await runMagpieCli(
    [
      "group",
      "add",
      "Compass Group",
      "models=upstream/gpt-6-luna,upstream/claude-opus-5-5,upstream/gpt-6.1-sol,upstream/gemini-4-argon-high,upstream/gemini-3.8-flash-high",
      "routing=order",
    ],
    env,
    bin
  );
  await runMagpieCli(
    [
      "group",
      "set",
      "compass-group",
      "effort=auto",
      "classifier=agentcompass/agentcompass-systemone",
    ],
    env,
    bin
  );
  await runMagpieCli(
    ["group", "rule", "add", "compass-group", "use=upstream/gemini-4-argon-high", "intent=direction_reasoning"],
    env,
    bin
  );
  await runMagpieCli(
    ["group", "rule", "add", "compass-group", "use=upstream/claude-opus-5-5", "intent=debug_review"],
    env,
    bin
  );
  await runMagpieCli(
    ["group", "rule", "add", "compass-group", "use=upstream/gpt-6.1-sol", "intent=self_contained_code"],
    env,
    bin
  );
  await runMagpieCli(
    ["group", "rule", "add", "compass-group", "use=upstream/gemini-3.8-flash-high", "intent=bounded_bulk_work"],
    env,
    bin
  );
}

// A real `magpie web` daemon (serves both Web GUI API on webPort and Gateway on gwPort), once both answer.
async function startMagpieWeb(env, gwPort, webPort, webCookie, logs, bin = MAGPIE_BIN) {
  const proc = spawn(bin, ["web", "--addr", `127.0.0.1:${webPort}`, "--no-open"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(d.toString("utf8")));
  proc.stderr.on("data", (d) => logs.push(d.toString("utf8")));

  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      const [gwRes, webRes] = await Promise.all([
        fetch(`http://127.0.0.1:${gwPort}/v1/models`),
        fetch(`http://127.0.0.1:${webPort}/api/plugins`, { headers: { Cookie: webCookie } }),
      ]);
      if (gwRes.ok && webRes.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ready, `magpie web + gateway did not become ready on ports ${webPort}/${gwPort}:\n${logs.join("")}`);
  return proc;
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
    magpieVersion: null,
    magpieBinarySha256: process.env.MAGPIE_BINARY_SHA256 || null,
    pluginCommit: process.env.PLUGIN_COMMIT || null,
    baselineCommit: process.env.BASELINE_COMMIT || null,
    scenarios: {},
    steps: [],
  };

  console.log(`[Linux Sandbox] OS: ${process.platform} ${process.arch} (${os.release()})`);
  assert.equal(process.platform, "linux", "Must run inside Linux sandbox");

  // Load community registry entry to serve via local mock market endpoint
  const registryEntry = JSON.parse(
    fs.readFileSync(path.join(PLUGIN_DIR, "docs", "magpie-community-registry-entry.json"), "utf8")
  );
  const pkgJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "package.json"), "utf8"));

  // 1. Start Upstream Mock LLM + Plugin Market Registry Server
  const upstreamCalls = [];
  const upstreamServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    // Serve local plugin market registry.json for MAGPIE_PLUGIN_MARKET
    if (req.method === "GET" && url.pathname === "/registry.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          version: 1,
          plugins: [registryEntry],
        })
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [...ALL_MODELS, ...VARIANT_MODELS].map((id) => ({ id, object: "model", created: 1700000000, owned_by: "sandbox-upstream" })),
        })
      );
      return;
    }

    // Anthropic Messages API (/v1/messages)
    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const body = await readJsonBody(req);
      const record = {
        path: url.pathname,
        model: body.model,
        stream: Boolean(body.stream),
        reasoning_effort: body.output_config?.effort ?? body.thinking?.type ?? null,
        hasRouteCarrier: "__agentcompass_route" in body,
        body,
      };
      upstreamCalls.push(record);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: `msg_anth_${upstreamCalls.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                routed_model: body.model,
                reasoning_effort: record.reasoning_effort,
                has_carrier: record.hasRouteCarrier,
              }),
            },
          ],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 25, output_tokens: 15 },
        })
      );
      return;
    }

    // OpenAI Chat Completions (/v1/chat/completions) & Responses (/v1/responses)
    if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses")) {
      const body = await readJsonBody(req);
      const record = {
        path: url.pathname,
        model: body.model,
        stream: Boolean(body.stream),
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

      if (body.stream === true) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const chunkPayload = {
          id: `chatcmpl_stream_${upstreamCalls.length}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: JSON.stringify({
                  routed_model: body.model,
                  reasoning_effort: record.reasoning_effort,
                  has_carrier: record.hasRouteCarrier,
                  stream: true,
                }),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 25, completion_tokens: 15, total_tokens: 40 },
        };
        res.write(`data: ${JSON.stringify(chunkPayload)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
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

  // 2. Start Configurable Async System-One Scorer Server (supports delay, HTTP 500 fault, and timeout simulation)
  const scorerCalls = [];
  let scorerDelayMs = 1600;
  let scorerForceStatus = 200;
  const scorerServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const started = Date.now();
      const body = await readJsonBody(req);
      const userPrompt = String(body.messages?.[body.messages.length - 1]?.content || "");
      await new Promise((r) => setTimeout(r, scorerDelayMs));

      if (scorerForceStatus !== 200) {
        scorerCalls.push({
          userAgent: req.headers["user-agent"] || "",
          elapsedMs: Date.now() - started,
          forcedErrorStatus: scorerForceStatus,
        });
        res.writeHead(scorerForceStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Simulated System-One scorer failure" } }));
        return;
      }

      let profile;
      if (/deadlock|race condition|root cause|security audit/i.test(userPrompt)) {
        profile = {
          work_kind: "debug_review",
          interaction_style: "engineering",
          reasoning_depth: 4,
          code_complexity: 3,
          context_scale: 3,
          divergence: 1,
          hallucination_risk: 3,
          error_cost: 3,
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
          divergence: 3,
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
      } else if (/translate|spanish|french/i.test(userPrompt)) {
        profile = {
          work_kind: "text_in_text_out",
          interaction_style: "text_only",
          reasoning_depth: 1,
          code_complexity: 0,
          context_scale: 1,
          divergence: 1,
          hallucination_risk: 1,
          error_cost: 1,
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
  const webPort = 13426;
  const webKey = "sandbox-web-key-12345678";
  const webCookie = `magpie_web_${webPort}=${webKey}`;

  let magpieProc = null;
  let baselineProc = null;
  const magpieLogs = [];

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
      MAGPIE_WEB_KEY: webKey,
      MAGPIE_PLUGIN_MARKET: `http://127.0.0.1:${upPort}/registry.json`,
      NO_COLOR: "1",
    };

    // =========================================================================
    // SCENARIO 1: CLI Plugin Lifecycle & Metadata Contract
    // =========================================================================
    report.magpieVersion = (await runMagpieCli(["--version"], env)).trim();
    console.log(`[Linux Sandbox] ${report.magpieVersion}`);
    const listText = await runMagpieCli(["plugin", "list"], env);
    assert.ok(
      listText.includes("agentcompass (AgentCompass, 1 models)  signed in"),
      `Expected signed-in agentcompass in plugin list:\n${listText}`
    );
    assert.ok(
      listText.includes("routings agentcompass/agentcompass, agentcompass/agentcompass-pure"),
      `Expected routings agentcompass/agentcompass in plugin list:\n${listText}`
    );
    assert.equal(pkgJson.magpie?.name, "AgentCompass");
    assert.ok(pkgJson.magpie?.icon?.startsWith("data:image/svg+xml;base64,"));

    report.scenarios.scenario1_cli_lifecycle = {
      pass: true,
      pluginListOutput: listText.trim(),
      magpieName: pkgJson.magpie.name,
      hasSvgDataUriIcon: true,
    };
    console.log("[PASS] Scenario 1 (CLI Plugin Lifecycle): magpie plugin list & metadata verified");

    // 3. Configure Upstream Provider in Magpie (supporting OpenAI Chat, Responses, and Gateway-translated Anthropic Messages)
    // 4. Configure initial Plugin Options
    const basePluginOptions = {
      gatewayTimeoutMs: 8000,
      scorerType: "openai_compatible",
      scorerBaseUrl: `http://127.0.0.1:${scorerPort}/v1`,
      scorerApiKey: "sk-sandbox-scorer",
      scorerModel: "systemone-10d",
      useCache: false,
      injectProtocolEffort: true,
      // Mode B: the decision provider exists only when this is on (issue #1)
      enableDecisionProvider: true,
      // Mode A: the pool `agentcompass/*` picks from (it rejects the request when none is set)
      candidateModels: ALL_MODELS.map((m) => `upstream/${m}`),
    };
    // 5. Upstream provider, plugin options and Mode B Routing Group
    await configureGateway(env, upPort, PLUGIN_DIR, basePluginOptions);

    // 6. Start real `magpie web` daemon (serves both Web GUI API on webPort and Gateway on gwPort)
    magpieProc = await startMagpieWeb(env, gwPort, webPort, webCookie, magpieLogs);
    console.log(
      `[Linux Sandbox] Real Linux 'magpie web' GUI API (127.0.0.1:${webPort}) + Gateway (127.0.0.1:${gwPort}) is live`
    );

    // =========================================================================
    // SCENARIO 2: Plugin Market Registry & Web/GUI Management API
    // =========================================================================
    {
      // 2a. Verify Market Listings via GET /api/plugins/listings
      const listingsRes = await fetch(`http://127.0.0.1:${webPort}/api/plugins/listings`, {
        headers: { Cookie: webCookie },
      });
      assert.equal(listingsRes.status, 200);
      const listingsData = await listingsRes.json();
      const marketItem = listingsData.listings?.find((l) => l.package === registryEntry.package);
      assert.ok(marketItem, `Market listings must include package '${registryEntry.package}' from MAGPIE_PLUGIN_MARKET`);
      assert.equal(marketItem.name, "AgentCompass");
      assert.equal(marketItem.kind, "middleware");
      // The decision provider is opt-in (enableDecisionProvider), so the listing claims no provider
      assert.deepEqual(marketItem.providers, registryEntry.providers);

      // 2b. Verify Installed Plugin State, OwnName, Stored SVG Icon & OptionsExample via GET /api/plugins
      // Wait briefly so RepoIcons background store completes on the data:image/svg+xml icon
      await new Promise((r) => setTimeout(r, 100));
      const stateRes = await fetch(`http://127.0.0.1:${webPort}/api/plugins`, {
        headers: { Cookie: webCookie },
      });
      assert.equal(stateRes.status, 200);
      const stateData = await stateRes.json();
      const installed = stateData.plugins?.find((p) => p.spec === PLUGIN_DIR);
      assert.ok(installed, "Installed plugin must be present in GET /api/plugins");
      assert.equal(installed.ownName, "AgentCompass");
      assert.ok(
        installed.icon?.startsWith("file:") && installed.icon?.endsWith(".svg"),
        `Expected Magpie StoreIcon to persist SVG icon as file:<hash>.svg, got: ${installed.icon}`
      );
      // isGateway means request hooks (magpie.hooks); the package ships middleware alone since 7c2dd6d
      assert.equal(Boolean(installed.isGateway), false);
      assert.equal(pkgJson.magpie?.hooks, undefined);
      assert.equal(installed.isMiddleware, true);
      assert.ok(installed.optionsExample && typeof installed.optionsExample === "object");

      // 2c. Verify Plugin README rendering via GET /api/plugins/page
      const pageRes = await fetch(
        `http://127.0.0.1:${webPort}/api/plugins/page?name=${encodeURIComponent(PLUGIN_DIR)}`,
        { headers: { Cookie: webCookie } }
      );
      assert.equal(pageRes.status, 200);
      const pageData = await pageRes.json();
      assert.ok(
        typeof pageData.readme === "string" && pageData.readme.includes("AgentCompass") && pageData.readme.length > 500,
        "GET /api/plugins/page must return the plugin's README.md"
      );

      // 2d. Verify Plugin Off/On toggle via POST /api/plugins/off
      const offRes = await fetch(`http://127.0.0.1:${webPort}/api/plugins/off`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: webCookie },
        body: JSON.stringify({ Spec: PLUGIN_DIR, Off: true }),
      });
      assert.equal(offRes.status, 200);
      const offState = await offRes.json();
      assert.equal(offState.plugins?.find((p) => p.spec === PLUGIN_DIR)?.off, true);

      // Send a request with an explicit upstream model while plugin is OFF -> must stay untouched
      const bypassResp = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local-agent" },
        body: JSON.stringify({
          model: "upstream/gpt-6-luna",
          messages: [{ role: "user", content: "Diagnose a complex deadlock while plugin is switched off." }],
        }),
      });
      assert.equal(bypassResp.status, 200);
      const bypassUp = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(bypassUp.model, "gpt-6-luna", "When plugin is Off: true, requests must not be rewritten");

      // Turn plugin back ON via POST /api/plugins/off
      const onRes = await fetch(`http://127.0.0.1:${webPort}/api/plugins/off`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: webCookie },
        body: JSON.stringify({ Spec: PLUGIN_DIR, Off: false }),
      });
      assert.equal(onRes.status, 200);
      const onState = await onRes.json();
      assert.equal(Boolean(onState.plugins?.find((p) => p.spec === PLUGIN_DIR)?.off), false);

      // 2e. Verify Plugin Options read/write via POST /api/plugins/options
      const optRes = await fetch(`http://127.0.0.1:${webPort}/api/plugins/options`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: webCookie },
        body: JSON.stringify({ Spec: PLUGIN_DIR, Options: basePluginOptions }),
      });
      assert.equal(optRes.status, 200);
      const optState = await optRes.json();
      assert.equal(
        optState.plugins?.find((p) => p.spec === PLUGIN_DIR)?.options?.gatewayTimeoutMs,
        8000
      );

      report.scenarios.scenario2_market_and_gui_api = {
        pass: true,
        marketListingPackage: marketItem.package,
        installedOwnName: installed.ownName,
        storedIconFile: installed.icon,
        readmeLength: pageData.readme.length,
        offBypassModel: bypassUp.model,
        optionsUpdated: true,
      };
      report.steps.push({
        test: "Scenario 2 — Plugin Market (`registry.json`), README Page, Icon Storage, Off/On Toggle & Options API",
        storedIcon: installed.icon,
        readmeLength: pageData.readme.length,
        offBypassModel: bypassUp.model,
        pass: true,
      });
      console.log(
        `[PASS] Scenario 2 (Market & Web GUI API): listing='${marketItem.package}', icon='${installed.icon}', README=${pageData.readme.length}B, Off/On & Options verified`
      );
    }

    // Mode A is the shipped middleware alone (`src/middleware.js`) on the virtual models `agentcompass` /
    // `agentcompass/*`: it runs synchronously in Magpie's `moejs` VM (250ms budget), calls no external scorer,
    // and picks from `candidateModels`. Scenarios 3-6 and 8 drive that path; Mode B (Scenario 7) is the decision
    // provider's `/v1/systemone`.
    const gwHeaders = { "Content-Type": "application/json", Authorization: "Bearer sk-local-agent" };
    const postChat = (body, headers = {}) =>
      fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
        method: "POST",
        headers: { ...gwHeaders, ...headers },
        body: JSON.stringify(body),
      });
    const setPluginOptions = async (Options) => {
      const r = await fetch(`http://127.0.0.1:${webPort}/api/plugins/options`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: webCookie },
        body: JSON.stringify({ Spec: PLUGIN_DIR, Options }),
      });
      assert.equal(r.status, 200, `POST /api/plugins/options failed: ${r.status}`);
    };

    // Magpie fits the effort it forwards to the levels its model catalog lists (`catalog.NearestEffort`), and
    // fetches that catalog from models.dev in the background after it starts. Until the fetch lands, 0.1.2891
    // sent `upstream/claude-opus-5-5:xhigh` on as `high`; once it lands, as `xhigh`, and runs flipped partway
    // through. The scenarios start once Magpie forwards xhigh as asked, so what they check is the middleware's.
    const awaitModelCatalog = async (post) => {
      const catalogWaitStart = Date.now();
      let opusXhighSent = null;
      for (let n = 0; Date.now() - catalogWaitStart < 120_000; n++) {
        const r = await post({ model: "upstream/claude-opus-5-5:xhigh", messages: [{ role: "user", content: `effort probe ${n}` }] });
        assert.equal(r.status, 200, "a direct upstream/claude-opus-5-5:xhigh must be served");
        opusXhighSent = upstreamCalls[upstreamCalls.length - 1].reasoning_effort;
        if (opusXhighSent === "xhigh") break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert.equal(opusXhighSent, "xhigh", "Magpie must forward claude-opus-5-5:xhigh as xhigh within 120 s of starting (models.dev catalog)");
      return Date.now() - catalogWaitStart;
    };
    report.hostEffortReadyMs = await awaitModelCatalog(postChat);
    console.log(`[Linux Sandbox] Magpie forwards claude-opus-5-5:xhigh as xhigh after ${report.hostEffortReadyMs}ms`);

    // =========================================================================
    // SCENARIO 3: Mode A latency / budget — `agentcompass/auto` never waits for System One
    // =========================================================================
    {
      // A System One scorer that would take 1,600ms is configured but Mode A must not call it:
      // the middleware has to stay inside moejs's 250ms budget and add no scorer round trip.
      scorerDelayMs = 1600;
      scorerForceStatus = 200;
      const scorerBefore = scorerCalls.length;
      const prompt =
        "Investigate a cross-module distributed lock race condition and deadlock root cause across 15 microservices.";

      // Baseline: the same upstream call without routing (explicit model, plugin does not claim it)
      const tBase = Date.now();
      const baseResp = await postChat({ model: "upstream/gpt-6-luna", messages: [{ role: "user", content: prompt }] });
      assert.equal(baseResp.status, 200);
      const baselineMs = Date.now() - tBase;

      const t0 = Date.now();
      const resp = await postChat({ model: "agentcompass/auto", messages: [{ role: "user", content: prompt }] });
      const elapsedMs = Date.now() - t0;
      const data = await resp.json();
      assert.equal(resp.status, 200, `Expected 200, got ${resp.status}: ${JSON.stringify(data)}`);
      const up = upstreamCalls[upstreamCalls.length - 1];
      assert.ok(ALL_MODELS.includes(up.model), `Mode A must route agentcompass/auto to a catalog model, got ${up.model}`);
      assert.ok(up.reasoning_effort, "Mode A must set a reasoning effort on the routed request");
      assert.equal(up.hasRouteCarrier, false, "middleware.js must not leave __agentcompass_route in the body");
      assert.equal(scorerCalls.length, scorerBefore, "Mode A must not call an external scorer");
      assert.ok(elapsedMs < 1000, `Routed request took ${elapsedMs}ms; it must not wait on the 1,600ms scorer`);
      const overheadMs = elapsedMs - baselineMs;
      assert.ok(overheadMs < 250, `Routing overhead ${overheadMs}ms exceeds moejs's 250ms middleware budget`);

      // Without candidateModels the virtual model has nothing to pick from: the middleware rejects with 400
      await setPluginOptions({ ...basePluginOptions, candidateModels: [] });
      const rejected = await postChat({ model: "agentcompass/auto", messages: [{ role: "user", content: prompt }] });
      const rejectedBody = await rejected.text();
      assert.equal(rejected.status, 400, `Expected ctx.reject(400) without candidateModels, got ${rejected.status}: ${rejectedBody}`);
      assert.ok(/candidateModels/.test(rejectedBody), `400 must name the missing option: ${rejectedBody}`);
      await setPluginOptions(basePluginOptions);

      report.scenarios.scenario3_mode_a_latency_budget = {
        pass: true,
        routedModel: up.model,
        routedEffort: up.reasoning_effort,
        carrierStripped: !up.hasRouteCarrier,
        scorerCalls: 0,
        configuredScorerDelayMs: 1600,
        routedElapsedMs: elapsedMs,
        baselineElapsedMs: baselineMs,
        overheadMs,
        noCandidateModelsStatus: rejected.status,
      };
      report.steps.push({
        test: "Scenario 3: Mode A latency/budget (`agentcompass/auto` -> middleware.js [moejs]; 1,600ms scorer configured but never called; no candidateModels -> 400)",
        routedModel: up.model,
        routedEffort: up.reasoning_effort,
        routedElapsedMs: elapsedMs,
        overheadMs,
        pass: true,
      });
      console.log(
        `[PASS] Scenario 3 (Mode A latency/budget): agentcompass/auto -> ${up.model}:${up.reasoning_effort} in ${elapsedMs}ms (overhead ${overheadMs}ms, 0 scorer calls)`
      );
    }

    // =========================================================================
    // SCENARIO 4: Mode A — Model DNA differentiation through the middleware
    // =========================================================================
    {
      const scorerBefore = scorerCalls.length;
      // 4a. Divergent ideation
      const resp1 = await postChat({
        model: "agentcompass/auto",
        messages: [
          {
            role: "user",
            content: "Brainstorm 5 unconventional first-principles creative architectural directions and novel product mechanics.",
          },
        ],
      });
      assert.equal(resp1.status, 200);
      const up1 = upstreamCalls[upstreamCalls.length - 1];

      // 4b. OpenAI /v1/responses: self-contained module coding
      const resp2 = await fetch(`http://127.0.0.1:${gwPort}/v1/responses`, {
        method: "POST",
        headers: gwHeaders,
        body: JSON.stringify({
          model: "agentcompass/auto",
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
      assert.equal(resp2.status, 200);
      const up2 = upstreamCalls[upstreamCalls.length - 1];

      // 4c. Routine bounded bulk work
      const resp3 = await postChat({
        model: "agentcompass/auto",
        messages: [
          { role: "user", content: "Perform a mechanical batch rename of foo_bar to fooBar across JSON fixtures." },
        ],
      });
      assert.equal(resp3.status, 200);
      const up3 = upstreamCalls[upstreamCalls.length - 1];

      // 4d. Coupled root-cause debugging
      const resp4 = await postChat({
        model: "agentcompass/auto",
        messages: [
          {
            role: "user",
            content: "Conduct a cross-module deadlock and race condition security audit across the distributed transaction coordinator.",
          },
        ],
      });
      assert.equal(resp4.status, 200);
      const up4 = upstreamCalls[upstreamCalls.length - 1];

      const picked = {
        ideation: up1.model,
        coding: up2.model,
        bulk: up3.model,
        debug: up4.model,
      };
      assert.deepEqual(picked, {
        ideation: "gemini-4-argon-high",
        coding: "gpt-6.1-sol",
        bulk: "gemini-3.8-flash-high",
        debug: "claude-opus-5-5",
      });
      assert.equal(up1.reasoning_effort, "high");
      assert.equal(up2.reasoning_effort, "high");
      assert.equal(up3.reasoning_effort, "high");
      assert.equal(up4.reasoning_effort, "xhigh", "Frontier root-cause debugging selects claude-opus-5-5:xhigh");
      assert.equal(up2.path, "/v1/responses", "Self-contained coding sent on /v1/responses must stay on that protocol");
      for (const u of [up1, up2, up3, up4]) {
        assert.ok(ALL_MODELS.includes(u.model));
        assert.equal(u.hasRouteCarrier, false);
      }
      assert.equal(scorerCalls.length, scorerBefore, "Mode A must not call an external scorer");

      report.scenarios.scenario4_model_dna_differentiation = {
        pass: true,
        divergentIdeation: `${up1.model}:${up1.reasoning_effort}`,
        selfContainedResponses: `${up2.model}:${up2.reasoning_effort}`,
        routineBulkWork: `${up3.model}:${up3.reasoning_effort}`,
        coupledDebugging: `${up4.model}:${up4.reasoning_effort}`,
      };
      report.steps.push({
        test: "Scenario 4: Mode A — Model DNA differentiation through the middleware (ideation / coding / bulk / debugging)",
        ...report.scenarios.scenario4_model_dna_differentiation,
      });
      console.log(
        `[PASS] Scenario 4 (Mode A Model DNA): ideation=${up1.model}:${up1.reasoning_effort}, coding=${up2.model}:${up2.reasoning_effort}, bulk=${up3.model}:${up3.reasoning_effort}, debug=${up4.model}:${up4.reasoning_effort}`
      );
    }

    // =========================================================================
    // SCENARIO 5: Mode A — Anthropic `/v1/messages` & SSE streaming (`stream: true`)
    // =========================================================================
    {
      // 5a. Anthropic `/v1/messages`
      const anthResp = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": "sk-local-agent", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "agentcompass/auto",
          max_tokens: 1024,
          messages: [
            {
              role: "user",
              content: "Conduct a cross-module deadlock and race condition security audit across the distributed transaction coordinator.",
            },
          ],
        }),
      });
      const anthData = await anthResp.json();
      assert.equal(anthResp.status, 200, `Anthropic /v1/messages failed: ${JSON.stringify(anthData)}`);
      assert.equal(anthData.type, "message", "Anthropic /v1/messages response must have type='message'");
      const anthUp = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(anthUp.model, "claude-opus-5-5", "Coupled deadlock audit on /v1/messages routes to claude-opus-5-5");
      assert.equal(anthUp.hasRouteCarrier, false);

      // 5b. OpenAI `/v1/chat/completions` with `stream: true` (SSE)
      const streamResp = await postChat({
        model: "agentcompass/auto",
        stream: true,
        messages: [{ role: "user", content: "Implement a standalone self-contained LRU cache algorithm in TypeScript." }],
      });
      assert.equal(streamResp.status, 200);
      assert.ok(
        streamResp.headers.get("content-type")?.includes("text/event-stream"),
        `Expected text/event-stream, got ${streamResp.headers.get("content-type")}`
      );
      const sseText = await streamResp.text();
      assert.ok(sseText.includes("data: ") && sseText.includes("[DONE]"), "SSE stream must contain data chunks and [DONE]");
      const streamUp = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(streamUp.stream, true, "stream: true must reach the upstream");
      assert.equal(streamUp.model, "gpt-6.1-sol", "Self-contained coding over SSE routes to gpt-6.1-sol");
      assert.equal(streamUp.reasoning_effort, "high");
      assert.equal(streamUp.hasRouteCarrier, false);
      // The routed model is the one the stream was served by
      assert.ok(sseText.includes(streamUp.model), "SSE chunks must carry the routed model");

      report.scenarios.scenario5_anthropic_and_sse_streaming = {
        pass: true,
        anthropicUpstreamPath: anthUp.path,
        anthropicRoutedModel: anthUp.model,
        anthropicEffort: anthUp.reasoning_effort,
        anthropicUpstreamBodyKeys: Object.keys(anthUp.body).sort(),
        sseStreamRoutedModel: streamUp.model,
        sseStreamEffort: streamUp.reasoning_effort,
        sseReceivedDone: sseText.includes("[DONE]"),
      };
      report.steps.push({
        test: "Scenario 5: Mode A — Anthropic `/v1/messages` & SSE streaming (`stream: true`) through the middleware",
        anthropicRouted: `${anthUp.model}:${anthUp.reasoning_effort}`,
        sseStreamRouted: `${streamUp.model}:${streamUp.reasoning_effort}`,
        pass: true,
      });
      console.log(
        `[PASS] Scenario 5 (Anthropic /v1/messages & SSE Stream): /v1/messages -> ${anthUp.model}:${anthUp.reasoning_effort} via ${anthUp.path}, SSE -> ${streamUp.model}:${streamUp.reasoning_effort}`
      );
    }

    // =========================================================================
    // SCENARIO 6: Degradation when System One is unavailable or slow
    // =========================================================================
    {
      // The only System One consumer left is the Mode B decision provider (`allowExternalScorer: true` opts it in
      // to the remote scorer); it must fall back to the local heuristic profile instead of failing the request.
      // Mode A never calls the scorer, so a dead scorer must not touch it at all.
      const externalOptions = { ...basePluginOptions, allowExternalScorer: true, scorerTimeoutMs: 300 };
      const groupReq = (content) =>
        postChat({ model: "group/compass-group", messages: [{ role: "user", content }] });
      const creative = "Brainstorm a novel creative gameplay scheme and first-principles roadmap for an AI simulation game.";

      // 6a. Healthy scorer: sanity check that Mode B really reaches it with the option on
      await setPluginOptions(externalOptions);
      scorerForceStatus = 200;
      scorerDelayMs = 20;
      const calls6a = scorerCalls.length;
      const r6a = await groupReq(creative);
      assert.equal(r6a.status, 200);
      const up6a = upstreamCalls[upstreamCalls.length - 1];
      assert.ok(scorerCalls.length > calls6a, "With allowExternalScorer on, Mode B must call the System One scorer");
      assert.equal(up6a.model, "gemini-4-argon-high");

      // 6b. Scorer HTTP 500 -> heuristic fallback, same routing, request still 200
      scorerForceStatus = 500;
      const calls6b = scorerCalls.length;
      const r6b = await groupReq(creative + " (variant b)");
      assert.equal(r6b.status, 200, "Mode B must succeed via heuristic fallback when the scorer returns HTTP 500");
      const up6b = upstreamCalls[upstreamCalls.length - 1];
      assert.ok(scorerCalls.length > calls6b, "the failing scorer must have been attempted");
      assert.equal(up6b.model, "gemini-4-argon-high", "heuristic fallback must still classify creative work as direction_reasoning");

      // 6c. Scorer slower than scorerTimeoutMs -> heuristic fallback quickly
      scorerForceStatus = 200;
      scorerDelayMs = 2000;
      const t6c = Date.now();
      const r6c = await groupReq(creative + " (variant c)");
      const timeoutElapsedMs = Date.now() - t6c;
      assert.equal(r6c.status, 200, "Mode B must succeed via heuristic fallback when the scorer times out");
      const up6c = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(up6c.model, "gemini-4-argon-high");
      assert.ok(timeoutElapsedMs < 1500, `Scorer timeout fallback should finish quickly (<1500ms), took ${timeoutElapsedMs}ms`);

      // 6d. Mode A with the scorer down: unaffected, zero scorer calls
      scorerForceStatus = 500;
      const calls6d = scorerCalls.length;
      const r6d = await postChat({
        model: "agentcompass/auto",
        messages: [{ role: "user", content: "Perform a mechanical batch rename of foo_bar to fooBar across JSON fixtures." }],
      });
      assert.equal(r6d.status, 200);
      const up6d = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(up6d.model, "gemini-3.8-flash-high");
      assert.equal(scorerCalls.length, calls6d, "Mode A must not touch the scorer even when it is down");

      // Restore
      scorerForceStatus = 200;
      scorerDelayMs = 100;
      await setPluginOptions(basePluginOptions);

      report.scenarios.scenario6_system_one_degradation = {
        pass: true,
        healthyScorerModeB: up6a.model,
        http500FallbackModeB: up6b.model,
        timeoutFallbackModeB: up6c.model,
        timeoutFallbackElapsedMs: timeoutElapsedMs,
        modeAWithScorerDown: up6d.model,
      };
      report.steps.push({
        test: "Scenario 6: Degradation when System One is unavailable or slow (Mode B scorer HTTP 500 / timeout -> local heuristic; Mode A unaffected)",
        ...report.scenarios.scenario6_system_one_degradation,
      });
      console.log(
        `[PASS] Scenario 6 (System One degradation): Mode B 500 -> ${up6b.model}, timeout (${timeoutElapsedMs}ms) -> ${up6c.model}; Mode A with scorer down -> ${up6d.model}`
      );
    }

    // =========================================================================
    // SCENARIO 7: Mode B — Native Routing Group (`group/compass-group`) via `/v1/systemone`
    // =========================================================================
    {
      // 7a. Matches `intent=direction_reasoning` rule + upgrades effort medium -> high
      const resp1 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local-agent" },
        body: JSON.stringify({
          model: "group/compass-group",
          reasoning_effort: "medium",
          messages: [
            {
              role: "user",
              content: "Brainstorm unconventional creative product architecture directions from first-principles.",
            },
          ],
        }),
      });
      assert.equal(resp1.status, 200);
      const up1 = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(up1.model, "gemini-4-argon-high");
      assert.equal(up1.reasoning_effort, "high");

      // 7b. Matches `intent=debug_review` rule + upgrades effort low -> xhigh
      const resp2 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local-agent" },
        body: JSON.stringify({
          model: "group/compass-group",
          reasoning_effort: "low",
          messages: [
            {
              role: "user",
              content: "Diagnose a multi-file memory corruption and deadlock root cause in the consensus state machine.",
            },
          ],
        }),
      });
      assert.equal(resp2.status, 200);
      const up2 = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(up2.model, "claude-opus-5-5");
      assert.equal(up2.reasoning_effort, "xhigh");

      // 7c. Unmatched intent ("none of these") -> falls back to group's default first model (`gpt-6-luna`)
      const resp3 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local-agent" },
        body: JSON.stringify({
          model: "group/compass-group",
          messages: [
            {
              role: "user",
              content: "Translate this short release greeting paragraph into Spanish and French.",
            },
          ],
        }),
      });
      assert.equal(resp3.status, 200);
      const up3 = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(
        up3.model,
        "gpt-6-luna",
        "When /v1/systemone returns choice='none of these', group/compass-group must fall back to its first default model (gpt-6-luna)"
      );

      report.scenarios.scenario7_mode_b_systemone_group = {
        pass: true,
        directionReasoningRule: `${up1.model}:${up1.reasoning_effort}`,
        debugReviewRule: `${up2.model}:${up2.reasoning_effort}`,
        noneOfTheseFallback: `${up3.model}:${up3.reasoning_effort}`,
      };
      report.steps.push({
        test: "Scenario 7: Mode B (`group/compass-group` via `/v1/systemone` Decision Provider) — Rules, `none of these` Fallback & `effort=auto`",
        directionReasoningRule: `${up1.model}:${up1.reasoning_effort}`,
        debugReviewRule: `${up2.model}:${up2.reasoning_effort}`,
        noneOfTheseFallback: `${up3.model}:${up3.reasoning_effort}`,
        pass: true,
      });
      console.log(
        `[PASS] Scenario 7 (Mode B /v1/systemone Classifier): direction_reasoning=${up1.model}:${up1.reasoning_effort}, debug_review=${up2.model}:${up2.reasoning_effort}, none_of_these=${up3.model}:${up3.reasoning_effort}`
      );
    }

    // =========================================================================
    // SCENARIO 8: Mode A — session affinity, mid-turn tool lock (`within: true`) & short follow-up hold
    // =========================================================================
    // Magpie hands each request a moejs runtime from a sync.Pool, so a session's requests land on different
    // runtimes. The middleware decides the turn a request continues again from the history the client resends,
    // so the route holds whichever runtime serves it. The sessions below are run SCENARIO8_REPEATS times on the
    // default GOMAXPROCS, each its own session, and every tool-loop step and follow-up is counted.
    {
      const repeats = Math.max(1, Number(process.env.SCENARIO8_REPEATS || 20));
      const scorerBefore8 = scorerCalls.length;
      const runs = [];
      let toolLoopReroutes = 0;
      let followupReroutes = 0;
      let up8a;
      let up8b;
      let up8c;

      for (let i = 0; i < repeats; i++) {
        // the session is known by its first message (Magpie gives middleware no headers); run 0 is the original
        const stickyFirstMsg = {
          role: "user",
          content:
            "Audit our multi-module distributed lock manager to find the root cause of the deadlock and race condition." +
            (i === 0 ? "" : ` Start with shard set ${i}.`),
        };
        const sessionHeaders = { "x-session-id": `e2e-sticky-session-${i + 1}` };

        // 8a. Turn 1 (`why: "first"`): routed by the middleware
        const resp8a = await postChat({ model: "agentcompass/auto", messages: [stickyFirstMsg] }, sessionHeaders);
        assert.equal(resp8a.status, 200);
        const a = upstreamCalls[upstreamCalls.length - 1];
        assert.equal(a.model, "claude-opus-5-5", `run ${i}: turn 1 routes to claude-opus-5-5`);
        assert.equal(a.reasoning_effort, "xhigh", `run ${i}: turn 1 effort xhigh`);

        // 8b. Mid-turn tool result + agent `<system-reminder>` (`within: true`): hold model and effort
        const resp8b = await postChat(
          {
            model: "agentcompass/auto",
            messages: [
              stickyFirstMsg,
              {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "call_lock_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"lock.go\"}" } },
                ],
              },
              { role: "tool", tool_call_id: "call_lock_1", content: "package lock // simple utility" },
              {
                role: "user",
                content: "<system-reminder>The TodoWrite tool hasn't been used recently.</system-reminder>",
              },
            ],
          },
          sessionHeaders
        );
        assert.equal(resp8b.status, 200);
        const b = upstreamCalls[upstreamCalls.length - 1];

        // 8c. Short conversational follow-up ("继续"): hold model and effort
        const resp8c = await postChat(
          {
            model: "agentcompass/auto",
            messages: [
              stickyFirstMsg,
              { role: "assistant", content: "I found the lock inversion between ShardLock and TxLock. Shall I continue with the fix?" },
              { role: "user", content: "继续" },
            ],
          },
          sessionHeaders
        );
        assert.equal(resp8c.status, 200);
        const c = upstreamCalls[upstreamCalls.length - 1];

        const loopHeld = b.model === a.model && b.reasoning_effort === a.reasoning_effort;
        const followHeld = c.model === a.model && c.reasoning_effort === a.reasoning_effort;
        if (!loopHeld) toolLoopReroutes += 1;
        if (!followHeld) followupReroutes += 1;
        runs.push({
          turn1: `${a.model}:${a.reasoning_effort}`,
          toolLoop: `${b.model}:${b.reasoning_effort}`,
          followup: `${c.model}:${c.reasoning_effort}`,
        });
        if (i === 0) [up8a, up8b, up8c] = [a, b, c];
      }

      const rerouted = runs.filter((r) => r.toolLoop !== r.turn1 || r.followup !== r.turn1);
      assert.equal(
        toolLoopReroutes + followupReroutes,
        0,
        `Mid-turn tool loop and short follow-up must hold turn 1's model and effort in every run: ${toolLoopReroutes} tool-loop and ${followupReroutes} follow-up re-routes in ${repeats} runs ${JSON.stringify(rerouted)}`
      );

      // 8d. A different session is not pinned to this session's choice: a bulk task still routes on its own merits
      const resp8d = await postChat(
        {
          model: "agentcompass/auto",
          messages: [
            { role: "user", content: "Perform a mechanical batch rename of foo_bar to fooBar across JSON fixtures." },
          ],
        },
        { "x-session-id": "e2e-other-session-2" }
      );
      assert.equal(resp8d.status, 200);
      const up8d = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(up8d.model, "gemini-3.8-flash-high", "A new session must be routed independently of another session's affinity");

      assert.equal(scorerCalls.length, scorerBefore8, "Mode A session handling must make zero scorer calls");

      report.scenarios.scenario8_session_continuity_and_turn_lock = {
        pass: true,
        gomaxprocs: process.env.GOMAXPROCS || "default",
        repeats,
        toolLoopReroutes,
        followupReroutes,
        firstTurnRouted: `${up8a.model}:${up8a.reasoning_effort}`,
        midTurnToolLoopRouted: `${up8b.model}:${up8b.reasoning_effort}`,
        shortFollowupRouted: `${up8c.model}:${up8c.reasoning_effort}`,
        otherSessionRouted: `${up8d.model}:${up8d.reasoning_effort}`,
        scorerCalls: scorerCalls.length - scorerBefore8,
      };
      report.steps.push({
        test: "Scenario 8: Mode A — session affinity, mid-turn tool lock (`within: true`) & short follow-up hold (`keepsEffort`), repeated on pooled runtimes",
        ...report.scenarios.scenario8_session_continuity_and_turn_lock,
      });
      console.log(
        `[PASS] Scenario 8 (Session Continuity & Mid-Turn Lock): ${repeats} sessions, ${toolLoopReroutes} tool-loop / ${followupReroutes} follow-up re-routes; turn1=${up8a.model}:${up8a.reasoning_effort}, toolLoop=${up8b.model}:${up8b.reasoning_effort}, followup=${up8c.model}:${up8c.reasoning_effort}, otherSession=${up8d.model}`
      );
    }

    // What a request reached the upstream as, for the realtime scenarios below
    const lastUp = () => upstreamCalls[upstreamCalls.length - 1];
    const routedAs = (u) => `${u.model}:${u.reasoning_effort}`;
    const postTo = (port, requestPath, body, headers) =>
      fetch(`http://127.0.0.1:${port}${requestPath}`, { method: "POST", headers, body: JSON.stringify(body) });
    const anthropicHeaders = { "Content-Type": "application/json", "x-api-key": "sk-local-agent", "anthropic-version": "2023-06-01" };
    const IDEATION = "Brainstorm 5 unconventional first-principles creative architectural directions and novel product mechanics.";
    const CODING = "Implement a standalone self-contained LRU cache module in TypeScript with unit tests.";
    const BULK = "Perform a mechanical batch rename of foo_bar to fooBar across JSON fixtures.";
    const DEBUG = "Conduct a cross-module deadlock and race condition security audit across the distributed transaction coordinator.";
    const userMsg = (content) => ({ role: "user", content });

    // =========================================================================
    // SCENARIO 9: Non-realtime requests match a second real Magpie running the origin/main build
    // =========================================================================
    if (!BASELINE_PLUGIN_DIR) {
      report.scenarios.scenario9_non_realtime_matches_origin_main = { pass: null, skipped: "BASELINE_SRC not set" };
      console.log("[SKIP] Scenario 9 (non-realtime vs origin/main): BASELINE_SRC not set");
    } else {
      const root = path.join(SANDBOX_ROOT, "baseline");
      const baseGw = 13427;
      const baseWeb = 13428;
      const baseCookie = `magpie_web_${baseWeb}=${webKey}`;
      const baseEnv = {
        ...env,
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, "state"),
        MAGPIE_ADDR: `127.0.0.1:${baseGw}`,
      };
      for (const dir of ["home", "tmp", "config", "cache", "data", "state"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
      // A `data` folder beside the binary is where Magpie keeps everything (portable mode, whatever XDG says), so a
      // second Magpie needs its own copy of the binary beside its own `data`.
      const baseBin = path.join(root, "magpie");
      fs.copyFileSync(MAGPIE_BIN, baseBin);
      fs.chmodSync(baseBin, 0o755);
      await runMagpieCli(["plugin", "add", BASELINE_PLUGIN_DIR], baseEnv, baseBin);
      await runMagpieCli(["plugin", "options", BASELINE_PLUGIN_DIR, JSON.stringify({ enableDecisionProvider: true })], baseEnv, baseBin);
      await runMagpieCli(["plugin", "login", "agentcompass"], baseEnv, baseBin);
      await configureGateway(baseEnv, upPort, BASELINE_PLUGIN_DIR, basePluginOptions, baseBin);
      const baselineLogs = [];
      baselineProc = await startMagpieWeb(baseEnv, baseGw, baseWeb, baseCookie, baselineLogs, baseBin);
      await awaitModelCatalog((body) => postTo(baseGw, "/v1/chat/completions", body, gwHeaders));

      const instances = [
        { name: "worktree", gw: gwPort, web: webPort, cookie: webCookie, spec: PLUGIN_DIR },
        { name: "origin/main", gw: baseGw, web: baseWeb, cookie: baseCookie, spec: BASELINE_PLUGIN_DIR },
      ];
      const up = (m) => `upstream/${m}`;
      const pools = {
        default: { candidateModels: ALL_MODELS.map(up) },
        "README pool": { candidateModels: ["claude-opus-4-6", "claude-sonnet-4-6", "gpt-5.4", "gemini-2.5-pro", "gemini-2.5-flash"].map(up) },
        "bare strings": { candidateModels: ALL_MODELS },
        "dated/-latest/-preview/-chat": {
          candidateModels: VARIANT_MODELS.slice(0, 6).map(up),
        },
        "{model} objects": { candidateModels: ALL_MODELS.map((model) => ({ model: up(model) })) },
        "{id,provider,model} objects": {
          candidateModels: ALL_MODELS.map((model) => ({ id: up(model), provider: "upstream", model })),
        },
        "bundles with effort": {
          candidateModels: ["claude-opus-5-5:xhigh", "claude-opus-5-5:medium", "gpt-6.1-sol:high", "gemini-4-argon-high:high", "gemini-3.8-flash-high:low"].map(up),
        },
        "pin options, which only act on realtime routing": {
          candidateModels: ALL_MODELS.map(up),
          pinnedModel: up("gemini-4-argon-high"),
          pinnedEffort: "high",
        },
      };
      const TEXTS = [IDEATION, CODING, BULK, DEBUG, "Translate this short release greeting paragraph into Spanish and French.", "修复登录页的空指针崩溃并补上回归测试"];
      const CHAT = "/v1/chat/completions";
      const corpus = (salt) => {
        const out = [];
        for (const text of TEXTS) {
          const first = userMsg(`${text} [${salt}]`);
          out.push({ path: CHAT, body: { model: "agentcompass/auto", messages: [first] } });
          // Later turns of that session: a tool loop step and a short follow-up
          out.push({
            path: CHAT,
            body: {
              model: "agentcompass/auto",
              messages: [
                first,
                { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
                { role: "tool", tool_call_id: "call_1", content: "ok" },
              ],
            },
          });
          out.push({ path: CHAT, body: { model: "agentcompass/auto", messages: [first, { role: "assistant", content: "Done. Continue?" }, userMsg("继续")] } });
          // A new turn of a session no runtime has seen: decided from the history alone
          out.push({
            path: CHAT,
            body: { model: "agentcompass/auto", messages: [userMsg(`${text} [cold ${salt}]`), { role: "assistant", content: "Done." }, userMsg(`Next, ${TEXTS[(TEXTS.indexOf(text) + 1) % TEXTS.length]}`)] },
          });
          out.push({ path: CHAT, body: { model: "agentcompass/auto", stream: true, messages: [userMsg(`${text} [stream ${salt}]`)] } });
          out.push({
            path: "/v1/responses",
            body: { model: "agentcompass/auto", input: [{ role: "user", content: [{ type: "input_text", text: `${text} [responses ${salt}]` }] }] },
          });
          out.push({ path: "/v1/messages", body: { model: "agentcompass/auto", max_tokens: 1024, messages: [userMsg(`${text} [messages ${salt}]`)] } });
          out.push({
            path: CHAT,
            body: {
              model: "agentcompass/auto",
              messages: [{ role: "user", content: [{ type: "text", text: `${text} [image ${salt}]` }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }],
            },
          });
        }
        out.push({ path: CHAT, body: { model: "agentcompass:low", messages: [userMsg(`${BULK} [suffix ${salt}]`)] } });
        out.push({ path: CHAT, body: { model: "upstream/gpt-6-luna", messages: [userMsg(`${DEBUG} [direct ${salt}]`)] } });
        out.push({ path: CHAT, body: { model: "group/compass-group", messages: [userMsg(`${DEBUG} [group ${salt}]`)] } });
        return out;
      };
      const applyPool = async (instance, poolOptions) => {
        const r = await fetch(`http://127.0.0.1:${instance.web}/api/plugins/options`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: instance.cookie },
          body: JSON.stringify({ Spec: instance.spec, Options: { ...basePluginOptions, ...poolOptions } }),
        });
        assert.equal(r.status, 200, `POST /api/plugins/options failed on ${instance.name}: ${r.status}`);
      };
      const send = async (instance, salt) => {
        const seen = [];
        for (const [at, req] of corpus(salt).entries()) {
          const before = upstreamCalls.length;
          const headers = req.path === "/v1/messages" ? anthropicHeaders : gwHeaders;
          const resp = await postTo(instance.gw, req.path, req.body, headers);
          await resp.text();
          const sent = upstreamCalls.slice(before).map((u) => ({
            path: u.path,
            model: u.model,
            effort: u.reasoning_effort,
            stream: u.stream,
            body: u.body,
          }));
          seen.push({ request: `#${at} ${req.path} ${String(JSON.stringify(req.body.messages?.at(-1)?.content ?? req.body.input)).slice(0, 60)}`, status: resp.status, sent });
        }
        return seen;
      };
      // A new full turn of a session holds on the runtime that has the session's warm record and reroutes on one that
      // has not, and Magpie picks the runtime from a pool: origin/main against itself flips on these requests. So they
      // are sampled: the routes either build gives, which must be no more than those two.
      const NEW_TURN_SAMPLES = 8;
      const sampleNewTurn = async (instance, text, salt) => {
        const held = new Set();
        const rerouted = new Set();
        const nextText = `Next, ${TEXTS[(TEXTS.indexOf(text) + 1) % TEXTS.length]}`;
        for (let n = 0; n < NEW_TURN_SAMPLES; n++) {
          const first = userMsg(`${text} [${salt} new turn ${n}]`);
          const a = await postTo(instance.gw, CHAT, { model: "agentcompass/auto", messages: [first] }, gwHeaders);
          await a.text();
          const firstRoute = routedAs(upstreamCalls[upstreamCalls.length - 1]);
          for (const later of [
            [first, { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } }] }, { role: "tool", tool_call_id: "call_1", content: "ok" }],
            [first, { role: "assistant", content: "Done. Continue?" }, userMsg("继续")],
          ]) {
            await (await postTo(instance.gw, CHAT, { model: "agentcompass/auto", messages: later }, gwHeaders)).text();
          }
          const b = await postTo(instance.gw, CHAT, { model: "agentcompass/auto", messages: [first, { role: "assistant", content: "Done." }, userMsg(nextText)] }, gwHeaders);
          await b.text();
          const nextRoute = routedAs(upstreamCalls[upstreamCalls.length - 1]);
          (nextRoute === firstRoute ? held : rerouted).add(nextRoute);
        }
        return { held: [...held], rerouted: [...rerouted] };
      };

      let requests = 0;
      let served = 0;
      const routes = new Set();
      const diffs = [];
      const perPool = {};
      const newTurnDiffs = [];
      let newTurnRows = 0;
      let newTurnRowsThatFlip = 0;
      let newTurnRowsThatReroute = 0;
      for (const [name, poolOptions] of Object.entries(pools)) {
        const salt = `p${Object.keys(perPool).length}`;
        for (const instance of instances) await applyPool(instance, poolOptions);
        const [mine, theirs] = [await send(instances[0], salt), await send(instances[1], salt)];
        for (const text of TEXTS) {
          const [a, b] = [await sampleNewTurn(instances[0], text, salt), await sampleNewTurn(instances[1], text, salt)];
          newTurnRows += 1;
          if (b.held.length > 0 && b.rerouted.length > 0) newTurnRowsThatFlip += 1;
          if (a.rerouted.length > 0 && b.rerouted.length > 0) newTurnRowsThatReroute += 1;
          // The runtime's two states give two routes at most, whichever build serves them; a third is a change in routing
          const clash = new Set([...a.held, ...a.rerouted, ...b.held, ...b.rerouted]).size > 2;
          if (clash) newTurnDiffs.push({ pool: name, text: text.slice(0, 40), worktree: a, originMain: b });
        }
        let poolDiffs = 0;
        const poolRoutes = new Set();
        mine.forEach((row, i) => {
          requests += 1;
          if (row.status === 200) served += 1;
          for (const s of row.sent) {
            routes.add(`${s.model}:${s.effort}`);
            poolRoutes.add(`${s.model}:${s.effort}`);
          }
          if (JSON.stringify(row) !== JSON.stringify(theirs[i])) {
            poolDiffs += 1;
            diffs.push({ pool: name, worktree: row, originMain: theirs[i] });
          }
        });
        perPool[name] = { requests: mine.length, diffs: poolDiffs, routes: poolRoutes.size };
      }
      baselineProc.kill("SIGTERM");
      const brief = diffs.slice(0, 5).map((d) => ({
        pool: d.pool,
        request: d.worktree.request,
        worktree: [d.worktree.status, d.worktree.sent.map((s) => `${s.model}:${s.effort}`)],
        originMain: [d.originMain.status, d.originMain.sent.map((s) => `${s.model}:${s.effort}`)],
      }));
      assert.equal(diffs.length, 0, `Non-realtime requests must reach the upstream as origin/main sends them: ${JSON.stringify(brief, null, 2)}`);
      assert.deepEqual(newTurnDiffs, [], "A new turn must reroute to the same route as on origin/main");
      assert.ok(newTurnRowsThatReroute > 0, "The new turn sampling compared nothing: no row rerouted on both builds");
      assert.ok(served / requests >= 0.9, `Most of the corpus must be served for the comparison to mean anything: ${served}/${requests}`);
      assert.ok(routes.size >= 10, `The corpus must exercise many routes: ${[...routes].join(", ")}`);
      assert.ok(routes.has("gemini-4-argon-high:high"), "Non-realtime routing still uses Argon high");

      report.scenarios.scenario9_non_realtime_matches_origin_main = {
        pass: true,
        requests,
        served,
        diffs: diffs.length,
        distinctRoutes: routes.size,
        perPool,
        newTurnSampling: {
          samplesPerRow: NEW_TURN_SAMPLES,
          rows: newTurnRows,
          diffs: newTurnDiffs.length,
          rowsComparedOnBothBuilds: newTurnRowsThatReroute,
          originMainRowsThatFlipOnThePool: newTurnRowsThatFlip,
        },
      };
      report.steps.push({
        test: "Scenario 9: non-realtime requests reach the upstream as a second real Magpie running origin/main sends them (status, model, effort, full body)",
        ...report.scenarios.scenario9_non_realtime_matches_origin_main,
      });
      console.log(`[PASS] Scenario 9 (non-realtime vs origin/main): ${requests} requests over ${Object.keys(pools).length} pools, ${served} served, ${routes.size} distinct routes, ${diffs.length} diffs; new turns: ${newTurnRows} rows x ${NEW_TURN_SAMPLES} samples, ${newTurnDiffs.length} diffs, ${newTurnRowsThatReroute} rows rerouted on both builds (origin/main flips on ${newTurnRowsThatFlip} rows)`);
      await setPluginOptions(basePluginOptions);
    }

    // =========================================================================
    // SCENARIO 10: `realtime_loop: true` excludes Argon high and steps efforts down
    // =========================================================================
    {
      const rt = { realtime_loop: true };
      const route = async (content, extra = {}) => {
        const r = await postChat({ model: "agentcompass/auto", messages: [userMsg(content)], ...extra });
        assert.equal(r.status, 200, `routing ${content} failed: ${r.status}`);
        return lastUp();
      };

      // 10a. The same four tasks, off and on
      const pairs = {
        ideation: [IDEATION, "gemini-4-argon-high:high", "gpt-6-astra:medium"],
        coding: [CODING, "gpt-6.1-sol:high", "gpt-6.1-sol:medium"],
        bulk: [BULK, "gemini-3.8-flash-high:high", "claude-sonnet-5-5:low"],
        debug: [DEBUG, "claude-opus-5-5:xhigh", "claude-opus-5-5:medium"],
      };
      const routed = {};
      const flagsForwarded = [];
      for (const [name, [text, off, on]] of Object.entries(pairs)) {
        const plain = await route(`${text} [10a off]`);
        const live = await route(`${text} [10a on]`, rt);
        assert.equal(routedAs(plain), off, `${name} without realtime_loop`);
        assert.equal(routedAs(live), on, `${name} with realtime_loop`);
        assert.notEqual(live.model, "gemini-4-argon-high", `${name}: realtime_loop must not reach Argon high`);
        if ("realtime_loop" in live.body) flagsForwarded.push(name);
        routed[name] = { nonRealtime: routedAs(plain), realtime: routedAs(live) };
      }
      assert.deepEqual(flagsForwarded, [], "realtime_loop is for the router; a real upstream rejects a field it does not know");

      // 10b. A pool of one slow bundle steps down instead of sending the listed xhigh
      await setPluginOptions({ ...basePluginOptions, candidateModels: ["upstream/claude-opus-5-5:xhigh"] });
      const steppedPlain = await route(`${DEBUG} [10b off]`);
      const stepped = await route(`${DEBUG} [10b on]`, rt);
      assert.equal(routedAs(steppedPlain), "claude-opus-5-5:xhigh");
      assert.equal(routedAs(stepped), "claude-opus-5-5:medium");

      // 10c. A pool of Argon high alone: excluded, so Argon is never called
      await setPluginOptions({ ...basePluginOptions, candidateModels: ["upstream/gemini-4-argon-high"] });
      const argonBefore = upstreamCalls.length;
      const argonOnly = await postChat({ model: "agentcompass/auto", messages: [userMsg(`${IDEATION} [10c on]`)], ...rt });
      const argonOnlyBody = await argonOnly.text();
      const argonOnlyCalls = upstreamCalls.slice(argonBefore).map((u) => u.model);
      assert.ok(!argonOnlyCalls.includes("gemini-4-argon-high"), `Argon high alone must not be called under realtime_loop: ${argonOnlyBody}`);
      await setPluginOptions(basePluginOptions);

      // 10d. A model named directly is not routed, and the flag still stops at the gateway
      const direct = await postChat({ model: "upstream/gemini-4-argon-high", messages: [userMsg(`${IDEATION} [10d direct]`)], ...rt });
      assert.equal(direct.status, 200);
      assert.equal(lastUp().model, "gemini-4-argon-high");
      assert.ok(!("realtime_loop" in lastUp().body));

      // 10e. Every protocol, and the plugin-wide option
      const responses = await postTo(gwPort, "/v1/responses", { model: "agentcompass/auto", input: [{ role: "user", content: [{ type: "input_text", text: `${CODING} [10e responses]` }] }], ...rt }, gwHeaders);
      assert.equal(responses.status, 200);
      const onResponses = lastUp();
      assert.equal(routedAs(onResponses), "gpt-6.1-sol:medium");
      assert.equal(onResponses.path, "/v1/responses");
      assert.ok(!("realtime_loop" in onResponses.body));

      const messages = await postTo(gwPort, "/v1/messages", { model: "agentcompass/auto", max_tokens: 1024, messages: [userMsg(`${DEBUG} [10e messages]`)], ...rt }, anthropicHeaders);
      assert.equal(messages.status, 200);
      const onMessages = lastUp();
      // Magpie sends a /v1/messages request to this chat-only provider without an effort, realtime or not (Scenario 5)
      assert.equal(onMessages.model, "claude-opus-5-5");
      assert.ok(!("realtime_loop" in onMessages.body));

      const streamed = await postChat({ model: "agentcompass/auto", stream: true, messages: [userMsg(`${CODING} [10e stream]`)], ...rt });
      assert.equal(streamed.status, 200);
      assert.ok((await streamed.text()).includes("[DONE]"));
      const onStream = lastUp();
      assert.equal(routedAs(onStream), "gpt-6.1-sol:medium");
      assert.ok(!("realtime_loop" in onStream.body));

      await setPluginOptions({ ...basePluginOptions, realtime_loop: true });
      const pluginWide = await route(`${IDEATION} [10e option]`);
      assert.equal(routedAs(pluginWide), "gpt-6-astra:medium");
      await setPluginOptions(basePluginOptions);

      report.scenarios.scenario10_realtime_routing = {
        pass: true,
        routed,
        slowBundleStepsDown: `${routedAs(steppedPlain)} -> ${routedAs(stepped)}`,
        argonOnlyPool: { status: argonOnly.status, upstreamCalls: argonOnlyCalls, body: argonOnlyBody.slice(0, 300) },
        responses: routedAs(onResponses),
        messages: routedAs(onMessages),
        stream: routedAs(onStream),
        pluginWideOption: routedAs(pluginWide),
        flagForwardedUpstream: false,
      };
      report.steps.push({
        test: "Scenario 10: `realtime_loop: true` excludes Argon high and steps efforts down on chat, responses, messages and streams",
        ...report.scenarios.scenario10_realtime_routing,
      });
      console.log(
        `[PASS] Scenario 10 (realtime routing): ${Object.entries(routed).map(([k, v]) => `${k} ${v.nonRealtime} -> ${v.realtime}`).join("; ")}; bundle ${routedAs(steppedPlain)} -> ${routedAs(stepped)}; Argon-only pool -> HTTP ${argonOnly.status}, upstream calls ${JSON.stringify(argonOnlyCalls)}`
      );
    }

    // =========================================================================
    // SCENARIO 11: A realtime session's later turns hold: no reroute, no effort ratchet
    // =========================================================================
    {
      const repeats = Math.max(1, Number(process.env.SCENARIO8_REPEATS || 20));
      const rt = { realtime_loop: true };
      const send = async (messages, extra = rt) => {
        const r = await postChat({ model: "agentcompass/auto", messages, ...extra });
        assert.equal(r.status, 200);
        return lastUp();
      };
      let reroutes = 0;
      let flaglessDrift = 0;
      const rerouted = [];
      const flaglessRoutes = {};
      let first;
      let ended;
      for (let i = 0; i < repeats; i++) {
        const opening = userMsg(`${DEBUG} [session ${i}]`);
        const a = await send([opening]);
        assert.equal(routedAs(a), "claude-opus-5-5:medium", `run ${i}: turn 1`);
        // Tool loop step
        const b = await send([
          opening,
          { role: "assistant", content: null, tool_calls: [{ id: "call_rt", type: "function", function: { name: "read_screen", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "call_rt", content: "frame 1" },
        ]);
        // Short follow-up
        const c = await send([opening, { role: "assistant", content: "Acted. Continue?" }, userMsg("继续")]);
        // A whole new turn that would route elsewhere on its own, and asks for high stakes work that would raise effort
        const d = await send([opening, { role: "assistant", content: "Acted." }, userMsg(`Next, ${IDEATION}`)]);
        const e = await send([
          opening,
          { role: "assistant", content: "Acted." },
          userMsg(`Next, ${IDEATION}`),
          { role: "assistant", content: "Acted again." },
          userMsg("Now find the root cause of the deadlock across every module and prove the fix formally."),
        ]);
        const turns = { a, b, c, d, e };
        const moved = Object.entries(turns).filter(([, u]) => routedAs(u) !== routedAs(a));
        if (moved.length > 0) {
          reroutes += moved.length;
          rerouted.push({ run: i, moved: moved.map(([k, u]) => `${k}=${routedAs(u)}`) });
        }
        // A client that stops sending the flag: the gateway's pooled runtimes only know it from the body. Recorded, not asserted.
        const f = await send([opening, { role: "assistant", content: "Acted." }, userMsg("继续")], {});
        flaglessRoutes[routedAs(f)] = (flaglessRoutes[routedAs(f)] || 0) + 1;
        if (routedAs(f) !== routedAs(a)) flaglessDrift += 1;
        if (i === 0) first = Object.fromEntries(Object.entries(turns).map(([k, u]) => [k, routedAs(u)]));
      }
      assert.equal(reroutes, 0, `Later turns of a realtime session must hold turn 1's route: ${JSON.stringify(rerouted)}`);

      // An explicit realtime_loop:false ends the session's realtime routing
      const opening = userMsg(`${IDEATION} [session end]`);
      const live = await send([opening]);
      const off = await send([opening, { role: "assistant", content: "Acted." }, userMsg(`Next, ${IDEATION}`)], { realtime_loop: false });
      ended = { realtime: routedAs(live), afterFalse: routedAs(off) };
      assert.equal(ended.realtime, "gpt-6-astra:medium");
      assert.ok(!("realtime_loop" in off.body), "realtime_loop:false is for the router too");

      // Anthropic protocol, turn 1 and a new turn
      const anthOpening = userMsg(`${DEBUG} [session messages]`);
      const anth1 = await postTo(gwPort, "/v1/messages", { model: "agentcompass/auto", max_tokens: 1024, messages: [anthOpening], ...rt }, anthropicHeaders);
      assert.equal(anth1.status, 200);
      const anthA = lastUp();
      const anth2 = await postTo(gwPort, "/v1/messages", { model: "agentcompass/auto", max_tokens: 1024, messages: [anthOpening, { role: "assistant", content: "Acted." }, userMsg(`Next, ${IDEATION}`)], ...rt }, anthropicHeaders);
      assert.equal(anth2.status, 200);
      const anthB = lastUp();
      assert.equal(anthA.model, "claude-opus-5-5");
      assert.equal(routedAs(anthB), routedAs(anthA), "/v1/messages: the next turn holds");

      report.scenarios.scenario11_realtime_session_hold = {
        pass: true,
        repeats,
        reroutes,
        turns: first,
        flaglessFollowups: { routes: flaglessRoutes, differFromTurn1: flaglessDrift, asserted: false },
        explicitFalse: ended,
        anthropic: [routedAs(anthA), routedAs(anthB)],
      };
      report.steps.push({
        test: "Scenario 11: a realtime session's later turns hold (tool loop, short follow-up, new turns), repeated on pooled runtimes",
        ...report.scenarios.scenario11_realtime_session_hold,
      });
      console.log(
        `[PASS] Scenario 11 (realtime session hold): ${repeats} sessions, ${reroutes} reroutes, turns ${JSON.stringify(first)}; flagless follow-ups ${JSON.stringify(flaglessRoutes)}; explicit false ${JSON.stringify(ended)}; /v1/messages ${routedAs(anthA)} -> ${routedAs(anthB)}`
      );
    }

    // =========================================================================
    // SCENARIO 12: A pinned slow model is kept, with a warning in Magpie's log
    // =========================================================================
    {
      const rt = { realtime_loop: true };
      const warningsLogged = () => magpieLogs.join("").split("\n").filter((l) => l.includes("[warn]") && l.includes("agentcompass: pinned"));
      const awaitWarnings = async (n) => {
        for (let i = 0; i < 25 && warningsLogged().length < n; i++) await new Promise((r) => setTimeout(r, 200));
        return warningsLogged();
      };
      const route = async (content, extra = {}) => {
        const r = await postChat({ model: "agentcompass/auto", messages: [userMsg(content)], ...extra });
        assert.equal(r.status, 200);
        return lastUp();
      };
      const before = warningsLogged().length;

      // 12a. Argon high pinned: kept on a task it would win, and on one it would not
      await setPluginOptions({ ...basePluginOptions, pinnedModel: "upstream/gemini-4-argon-high" });
      const argonIdeation = await route(`${IDEATION} [12a]`, rt);
      assert.equal(routedAs(argonIdeation), "gemini-4-argon-high:high");
      const argonDebug = await route(`${DEBUG} [12a]`, rt);
      assert.equal(routedAs(argonDebug), "gemini-4-argon-high:high");
      const argonLines = await awaitWarnings(before + 2);
      assert.equal(argonLines.length, before + 2, `A pinned slow model must warn in Magpie's log on each route:\n${magpieLogs.join("").slice(-2000)}`);
      assert.ok(argonLines[argonLines.length - 1].includes("gemini-4-argon-high"));
      assert.ok(argonLines[argonLines.length - 1].includes("below the realtime_loop floor"));

      // 12b. Pinned without realtime_loop: routing as if no pin existed, no warning
      const pinnedPlain = await route(`${DEBUG} [12b]`);
      assert.equal(routedAs(pinnedPlain), "claude-opus-5-5:xhigh");
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(warningsLogged().length, before + 2, "Without realtime_loop a pin neither routes nor warns");

      // 12c. A pinned slow effort is not stepped down
      await setPluginOptions({ ...basePluginOptions, pinnedModel: "upstream/claude-opus-5-5", pinnedEffort: "xhigh" });
      const opusPinned = await route(`${DEBUG} [12c]`, rt);
      assert.equal(routedAs(opusPinned), "claude-opus-5-5:xhigh");
      const opusLines = await awaitWarnings(before + 3);
      assert.equal(opusLines.length, before + 3);
      assert.ok(opusLines[opusLines.length - 1].includes("claude-opus-5-5"));

      // 12d. No pin: the same request is excluded and stepped down again (Scenario 10)
      await setPluginOptions(basePluginOptions);
      const unpinned = await route(`${IDEATION} [12d]`, rt);
      assert.equal(routedAs(unpinned), "gpt-6-astra:medium");
      assert.equal(warningsLogged().length, before + 3);

      report.scenarios.scenario12_pinned_slow_model = {
        pass: true,
        pinnedArgonIdeation: routedAs(argonIdeation),
        pinnedArgonDebug: routedAs(argonDebug),
        pinWithoutRealtime: routedAs(pinnedPlain),
        pinnedOpusXhigh: routedAs(opusPinned),
        withoutPin: routedAs(unpinned),
        warningLines: warningsLogged().slice(before),
      };
      report.steps.push({
        test: "Scenario 12: a pinned slow model is kept with a warning in Magpie's log; without the pin it is excluded or stepped down",
        ...report.scenarios.scenario12_pinned_slow_model,
      });
      console.log(
        `[PASS] Scenario 12 (pinned slow model): Argon ${routedAs(argonIdeation)} / ${routedAs(argonDebug)}, opus ${routedAs(opusPinned)}, no pin ${routedAs(unpinned)}; log: ${warningsLogged()[before]}`
      );
    }

    // =========================================================================
    // SCENARIO 13: Real upstreams (each account's sign-in) behind one gateway and plugin
    // =========================================================================
    // Only access tokens go in. Refresh tokens rotate: a client refreshing a copy of one would sign the machine's own agent
    // out (refresh_token_reused), and `magpie accounts import` spends it outright, so neither is used.
    // The copies live on the sandbox's tmpfs and go with this scenario. Nothing here logs a credential or a real log line
    // other than the observer's, and the requests' model and effort come from the observer plugin.
    // Magpie runs Claude Code and Grok Build as programs: the sandbox installs its own of each, and run-linux-sandbox.sh
    // keeps Windows' directories off PATH, where one would run on the host with the host's sign-ins.
    const REAL_ACCOUNTS = [
      {
        name: "codex",
        auth: REAL_CODEX_AUTH,
        file: ".codex/auth.json",
        pool: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-sol", "gpt-6-luna"],
        named: "gpt-6-luna",
      },
      {
        name: "claude",
        auth: REAL_CLAUDE_AUTH,
        file: ".claude/.credentials.json",
        pool: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
        named: "claude-haiku-5-5",
      },
      {
        name: "grok",
        auth: REAL_GROK_AUTH,
        file: ".grok/auth.json",
        pool: ["grok-4.7", "grok-4.7-build-fast"],
        named: "grok-4.7-build-fast",
      },
    ].filter((a) => a.auth);
    if (REAL_ACCOUNTS.length === 0) {
      report.scenarios.scenario13_real_upstream = { pass: null, skipped: "No REAL_*_AUTH set" };
      console.log("[SKIP] Scenario 13 (real upstream): no REAL_*_AUTH set");
    } else {
      const root = path.join(SANDBOX_ROOT, "real");
      const realGw = 13429;
      const realWeb = 13430;
      const realCookie = `magpie_web_${realWeb}=${webKey}`;
      const realEnv = {
        ...Object.fromEntries(Object.entries(env).filter(([k]) => !/^(ANTHROPIC|OPENAI|XAI|GROK|CLAUDE)/.test(k))),
        HOME: path.join(root, "home"),
        TMPDIR: path.join(root, "tmp"),
        XDG_CONFIG_HOME: path.join(root, "config"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_DATA_HOME: path.join(root, "data"),
        XDG_STATE_HOME: path.join(root, "state"),
        MAGPIE_ADDR: `127.0.0.1:${realGw}`,
      };
      assert.equal(/(^|:)\/mnt\//.test(realEnv.PATH), false, "A real sign-in must not reach a program on the host");
      const observerDir = path.join(PLUGIN_DIR, "test", "fixtures", "route-observer");
      const realLogs = [];
      let realProc = null;
      try {
        for (const dir of ["home", "tmp", "config", "cache", "data", "state"]) fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
        const withoutRefreshTokens = (value) =>
          !value || typeof value !== "object" || Array.isArray(value)
            ? value
            : Object.fromEntries(Object.entries(value).filter(([k]) => !/refresh.?token/i.test(k)).map(([k, v]) => [k, withoutRefreshTokens(v)]));
        const hostFileTime = (a) => fs.statSync(a.auth).mtimeMs;
        for (const a of REAL_ACCOUNTS) {
          a.hostFileTime = hostFileTime(a);
          const copy = JSON.stringify(withoutRefreshTokens(JSON.parse(fs.readFileSync(a.auth, "utf8"))));
          assert.equal(/refresh.?token"/i.test(copy), false, `${a.name}: the copy must hold no refresh token`);
          const target = path.join(root, "home", a.file);
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
          fs.writeFileSync(target, copy, { mode: 0o600 });
        }
        const realBin = path.join(root, "magpie");
        fs.copyFileSync(MAGPIE_BIN, realBin);
        fs.chmodSync(realBin, 0o755);

        const optionsFor = (a) => ({ enableDecisionProvider: true, injectProtocolEffort: true, useCache: false, candidateModels: a.pool.map((m) => `${a.name}/${m}`) });
        // What these print names the account, so a failure says only which step it was
        const signInStep = async (step, run) => {
          try {
            await run();
          } catch (err) {
            throw new Error(`Scenario 13 ${step} failed: ${String(err.message).replace(/[^\s"]+@[^\s"]+/g, "<redacted>").slice(0, 400)}`);
          }
        };
        await runMagpieCli(["plugin", "add", PLUGIN_DIR], realEnv, realBin);
        await runMagpieCli(["plugin", "options", PLUGIN_DIR, JSON.stringify(optionsFor(REAL_ACCOUNTS[0]))], realEnv, realBin);
        await runMagpieCli(["plugin", "login", "agentcompass"], realEnv, realBin);
        await runMagpieCli(["plugin", "add", observerDir], realEnv, realBin);
        if (REAL_ACCOUNTS.some((a) => a.name === "claude")) {
          await signInStep("claude-code install", () => {
            execFileSync(realBin, ["claude-code", "install"], { env: realEnv, input: "y\n", stdio: ["pipe", "ignore", "ignore"], timeout: 300_000 });
          });
          // A new Claude Code stops at its first-run screens and at trusting its folder, and no one is here to answer them
          const projects = {};
          for (let i = 0; i < 8; i++) projects[path.join(realEnv.TMPDIR, `magpie-claude-work-${i}`)] = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true };
          fs.writeFileSync(path.join(realEnv.HOME, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects }), { mode: 0o600 });
        }
        if (REAL_ACCOUNTS.some((a) => a.name === "grok")) {
          await signInStep("grok plugin", () => runMagpieCli(["plugin", "add", "@magpie-community/opencode-grok-auth"], realEnv, realBin));
          await signInStep("grok sign-in", () => runMagpieCli(["plugin", "login", "grok", "Use Grok Build's current sign-in"], realEnv, realBin));
        }
        realProc = await startMagpieWeb(realEnv, realGw, realWeb, realCookie, realLogs, realBin);

        const observed = () =>
          realLogs
            .join("")
            .split("\n")
            .filter((l) => l.includes("route-observer {"))
            .map((l) => JSON.parse(l.slice(l.indexOf("route-observer {") + "route-observer ".length)));
        const REAL_TIMEOUT_MS = 240_000;
        const callReal = async (requestPath, body) => {
          const before = observed().length;
          const started = Date.now();
          const resp = await fetch(`http://127.0.0.1:${realGw}${requestPath}`, {
            method: "POST",
            headers: gwHeaders,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REAL_TIMEOUT_MS),
          });
          const text = await resp.text();
          for (let i = 0; i < 25 && observed().length <= before; i++) await new Promise((r) => setTimeout(r, 200));
          const seen = observed().slice(before);
          let replied = null;
          try {
            const parsed = JSON.parse(text);
            replied = parsed.choices?.[0]?.message?.content ?? parsed.output?.flatMap((o) => o.content || []).find((c) => c.text)?.text ?? null;
          } catch {}
          return {
            status: resp.status,
            ms: Date.now() - started,
            replied: replied ? replied.slice(0, 40) : null,
            error: resp.status === 200 ? null : text.slice(0, 200),
            sent: seen[seen.length - 1] || null,
          };
        };
        const asRoute = (sent) => {
          if (!sent?.model) return null;
          const name = sent.model.replace(/^[^/]+\//, "");
          return name.includes(":") ? name : `${name}:${sent.effort}`;
        };
        const realWebPost = async (route, body) => {
          const r = await fetch(`http://127.0.0.1:${realWeb}/api/plugins/${route}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: realCookie },
            body: JSON.stringify({ Spec: PLUGIN_DIR, ...body }),
          });
          assert.equal(r.status, 200, `POST /api/plugins/${route} failed: ${r.status}`);
        };
        const pairs = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, "test", "fixtures", "realtime-classifier-pairs.json"), "utf8")).cases;
        const { scoreTaskLive } = await import(path.join(PLUGIN_DIR, "src", "scorer-live.js"));

        const accountsReport = {};
        for (const [index, a] of REAL_ACCOUNTS.entries()) {
          // The sign-in's models come in a moment after the gateway starts
          const wanted = [...a.pool, a.named].map((m) => `${a.name}/${m}`);
          let served = [];
          for (let i = 0; i < 90 && !wanted.every((m) => served.includes(m)); i++) {
            if (i > 0) await new Promise((r) => setTimeout(r, 500));
            const listed = await (await fetch(`http://127.0.0.1:${realGw}/v1/models`, { headers: gwHeaders })).json();
            served = (listed.data || []).map((m) => m.id);
          }
          for (const m of wanted) assert.ok(served.includes(m), `the ${a.name} sign-in must serve ${m}`);
          await realWebPost("options", { Options: optionsFor(a) });

          // The same requests on the mock upstream, with the same pool under its own provider name. Each account has its own
          // text, so that no route is held over from the account before
          const REPLY = `${" ".repeat(index * 3)} Reply with exactly: OK`;
          const realText = `${CODING}${REPLY}`;
          await setPluginOptions({ ...basePluginOptions, candidateModels: a.pool.map((m) => `upstream/${m}`) });
          const mockPlain = await postChat({ model: "agentcompass/auto", messages: [userMsg(`${realText}`)] });
          assert.equal(mockPlain.status, 200);
          const mockPlainRoute = routedAs(lastUp());
          const mockLive = await postChat({ model: "agentcompass/auto", messages: [userMsg(`${realText} `)], realtime_loop: true });
          assert.equal(mockLive.status, 200);
          const mockLiveRoute = routedAs(lastUp());
          await setPluginOptions(basePluginOptions);

          const namedModel = `${a.name}/${a.named}`;
          const plain = await callReal("/v1/chat/completions", { model: "agentcompass/auto", messages: [userMsg(realText)] });
          const live = await callReal("/v1/chat/completions", { model: "agentcompass/auto", messages: [userMsg(`${realText} `)], realtime_loop: true });
          const liveResponses = await callReal("/v1/responses", {
            model: "agentcompass/auto",
            input: [{ role: "user", content: [{ type: "input_text", text: `${realText}  ` }] }],
            realtime_loop: true,
          });
          const named = await callReal("/v1/chat/completions", { model: namedModel, messages: [userMsg(`Say OK.${REPLY}`)], realtime_loop: true });
          for (const [name, call] of Object.entries({ plain, live, liveResponses, named })) {
            assert.equal(call.status, 200, `${a.name} ${name} on the real upstream: ${call.error}`);
            assert.ok(call.replied, `${a.name} ${name}: the real upstream must answer with text`);
            assert.equal(call.sent?.flag, false, `${a.name} ${name}: realtime_loop must not go on to the real upstream`);
            assert.equal(call.sent?.provider, a.name, `${a.name} ${name}: served by this sign-in`);
          }
          assert.equal(asRoute(plain.sent), mockPlainRoute, `${a.name} non-realtime: the real upstream's route must be the mock's`);
          assert.equal(asRoute(live.sent), mockLiveRoute, `${a.name} realtime: the real upstream's route must be the mock's`);
          assert.notEqual(mockPlainRoute, mockLiveRoute, `${a.name}: the pair must show realtime routing doing something`);

          // Control: with AgentCompass off the flag does go on, so the observer's false above means something
          await realWebPost("off", { Off: true });
          const control = await callReal("/v1/chat/completions", { model: namedModel, messages: [userMsg(`Say OK.${REPLY}`)], realtime_loop: true });
          await realWebPost("off", { Off: false });
          assert.equal(control.sent?.flag, true, `${a.name}: with AgentCompass off the observer must see the flag`);

          // The classifier on a real endpoint: scoreTaskLive through this gateway, on the 12 paired hard cases
          const scored = [];
          for (const c of pairs) {
            const { profile, meta } = await scoreTaskLive(
              { objective: c.task },
              {
                scorerType: "openai_compatible",
                allowExternalScorer: true,
                scorerBaseUrl: `http://127.0.0.1:${realGw}/v1`,
                scorerApiKey: "sk-local-agent",
                scorerModel: namedModel,
                scorerTimeoutMs: 55_000,
                useCache: false,
              }
            );
            scored.push({
              id: c.id,
              expected: c.realtime_loop,
              got: profile.realtime_loop === true,
              expectedKind: c.work_kind,
              gotKind: profile.work_kind,
              source: meta.source,
              error: meta.fallbackReason || null,
              ms: meta.durationMs ?? null,
            });
          }
          const answered = scored.filter((s) => s.source === "system_one_live");
          const agree = answered.filter((s) => s.got === s.expected);
          const kindAgree = answered.filter((s) => s.gotKind === s.expectedKind);
          const missed = scored.filter((s) => s.got !== s.expected || s.source !== "system_one_live");
          assert.equal(answered.length, pairs.length, `${a.name}: every pair must be answered by the real classifier, not a fallback: ${JSON.stringify(missed)}`);

          accountsReport[a.name] = {
            pass: true,
            upstream: `${a.name} sign-in, access token only (refresh token never copied)`,
            routes: {
              nonRealtime: { real: asRoute(plain.sent), mock: mockPlainRoute, ms: plain.ms, status: plain.status },
              realtime: { real: asRoute(live.sent), mock: mockLiveRoute, ms: live.ms, status: live.status },
              realtimeResponses: { real: asRoute(liveResponses.sent), ms: liveResponses.ms, status: liveResponses.status },
              namedDirectly: { real: asRoute(named.sent), ms: named.ms, status: named.status },
            },
            flagSentOn: false,
            controlWithPluginOff: { observerSawFlag: control.sent?.flag, status: control.status, error: control.error },
            classifier: {
              model: namedModel,
              cases: pairs.length,
              answered: answered.length,
              msPerCase: [Math.min(...answered.map((s) => s.ms)), Math.max(...answered.map((s) => s.ms))],
              realtimeLoopAgreement: `${agree.length}/${pairs.length}`,
              workKindAgreement: `${kindAgree.length}/${pairs.length}`,
              disagreements: scored
                .filter((s) => s.got !== s.expected || s.gotKind !== s.expectedKind)
                .map(({ id, expected, got, expectedKind, gotKind }) => ({ id, expected, got, expectedKind, gotKind })),
            },
          };
          console.log(
            `[PASS] Scenario 13 (real upstream, ${a.name}): non-realtime ${asRoute(plain.sent)} (mock ${mockPlainRoute}) ${plain.status} in ${plain.ms}ms; realtime ${asRoute(live.sent)} (mock ${mockLiveRoute}) ${live.status} in ${live.ms}ms; /v1/responses ${asRoute(liveResponses.sent)} ${liveResponses.status}; named ${asRoute(named.sent)} ${named.status}; flag on the wire: none (plugin off control: observer ${control.sent?.flag}, HTTP ${control.status}); classifier ${namedModel}: realtime_loop ${agree.length}/${pairs.length}, work_kind ${kindAgree.length}/${pairs.length}`
          );
        }

        const hostFilesChanged = REAL_ACCOUNTS.filter((a) => hostFileTime(a) !== a.hostFileTime).map((a) => a.name);
        report.scenarios.scenario13_real_upstream = { pass: true, accounts: accountsReport, hostFilesChanged };
        report.steps.push({
          test: "Scenario 13: real upstreams, one per sign-in: no realtime_loop on the wire, routes as on the mock, classifier on 12 paired hard cases",
          ...report.scenarios.scenario13_real_upstream,
        });
        console.log(`[PASS] Scenario 13 (real upstream): accounts ${REAL_ACCOUNTS.map((a) => a.name).join(", ")}; host sign-in files changed during the run: ${JSON.stringify(hostFilesChanged)}`);
      } catch (err) {
        report.scenarios.scenario13_real_upstream = { pass: false };
        console.error(`[Linux Sandbox] Scenario 13 observer lines: ${realLogs.join("").split("\n").filter((l) => l.includes("route-observer {")).slice(-8).join(" | ")}`);
        throw err;
      } finally {
        if (realProc && !realProc.killed) {
          realProc.kill("SIGTERM");
          await new Promise((r) => setTimeout(r, 300));
        }
        fs.rmSync(root, { recursive: true, force: true });
        assert.equal(fs.existsSync(root), false, "the sign-in copies must be gone after Scenario 13");
      }
    }

    // Save complete JSON report
    const reportPath = path.join(SANDBOX_ROOT, "e2e-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n[Linux Sandbox] FULL-CHAIN E2E RUN PASSED! Report written to ${reportPath}`);
  } catch (err) {
    // what Magpie said, and the last requests it sent upstream, for the failure to be read without a rerun
    console.error(`[Linux Sandbox] magpie web log (tail):
${magpieLogs.join("").slice(-6000)}`);
    for (const u of upstreamCalls.slice(-3)) {
      const { messages, input, ...rest } = u.body || {};
      console.error(`[Linux Sandbox] upstream ${u.path}: ${JSON.stringify(rest).slice(0, 600)}`);
    }
    throw err;
  } finally {
    if (magpieProc && !magpieProc.killed) {
      magpieProc.kill("SIGTERM");
    }
    if (baselineProc && !baselineProc.killed) {
      baselineProc.kill("SIGTERM");
    }
    upstreamServer.close();
    scorerServer.close();
  }
}

main().catch((err) => {
  console.error("[Linux Sandbox] E2E Test Failed:", err);
  process.exit(1);
});
