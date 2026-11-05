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
    magpieVersion: null,
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
          data: ALL_MODELS.map((id) => ({ id, object: "model", created: 1700000000, owned_by: "sandbox-upstream" })),
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
    await runMagpieCli(["plugin", "options", PLUGIN_DIR, JSON.stringify(basePluginOptions)], env);

    // 5. Configure Mode B Routing Group (`group/compass-group`) using `agentcompass/agentcompass-systemone`
    // Note: first model in `models=` is `upstream/gpt-6-luna` so `"none of these"` fallback lands on `gpt-6-luna`!
    await runMagpieCli(
      [
        "group",
        "add",
        "Compass Group",
        "models=upstream/gpt-6-luna,upstream/claude-opus-5-5,upstream/gpt-6.1-sol,upstream/gemini-4-argon-high,upstream/gemini-3.8-flash-high",
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

    // 6. Start real `magpie web` daemon (serves both Web GUI API on webPort and Gateway on gwPort)
    magpieProc = spawn(MAGPIE_BIN, ["web", "--addr", `127.0.0.1:${webPort}`, "--no-open"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    magpieProc.stdout.on("data", (d) => magpieLogs.push(d.toString("utf8")));
    magpieProc.stderr.on("data", (d) => magpieLogs.push(d.toString("utf8")));

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
    assert.ok(
      ready,
      `magpie web + gateway did not become ready on ports ${webPort}/${gwPort}:\n${magpieLogs.join("")}`
    );
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
    const catalogWaitStart = Date.now();
    let opusXhighSent = null;
    for (let n = 0; Date.now() - catalogWaitStart < 120_000; n++) {
      const r = await postChat({ model: "upstream/claude-opus-5-5:xhigh", messages: [{ role: "user", content: `effort probe ${n}` }] });
      assert.equal(r.status, 200, "a direct upstream/claude-opus-5-5:xhigh must be served");
      opusXhighSent = upstreamCalls[upstreamCalls.length - 1].reasoning_effort;
      if (opusXhighSent === "xhigh") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(opusXhighSent, "xhigh", "Magpie must forward claude-opus-5-5:xhigh as xhigh within 120 s of starting (models.dev catalog)");
    report.hostEffortReadyMs = Date.now() - catalogWaitStart;
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
    upstreamServer.close();
    scorerServer.close();
  }
}

main().catch((err) => {
  console.error("[Linux Sandbox] E2E Test Failed:", err);
  process.exit(1);
});
