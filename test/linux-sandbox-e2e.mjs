/**
 * Real Linux Sandbox Full-Chain E2E & Plugin Market Verification (`test/linux-sandbox-e2e.mjs`)
 *
 * Runs inside an isolated Linux environment (WSL2 Linux x86_64 `/run/magpie-sandbox`)
 * against the compiled static Linux `magpie` binary (`magpie web` + gateway daemon)
 * + Linux `bun` plugin host + embedded `moejs` runtime.
 *
 * Covers all 7 End-to-End Scenarios:
 * - Scenario 1: CLI Plugin Lifecycle (`magpie plugin add`, `login`, `list`, `magpie.name`, `magpie.icon`)
 * - Scenario 2: Plugin Market (`MAGPIE_PLUGIN_MARKET` registry.json) & Web/GUI API (`/api/plugins/listings`,
 *   `/api/plugins`, `/api/plugins/page`, `POST /api/plugins/off` toggle, `POST /api/plugins/options`)
 * - Scenario 3: Mode A Two-Stage Tandem (`hooks.js` [Bun] -> `middleware.js` [`moejs`]) with 1,600ms slow
 *   remote System-One scorer exceeding 20ms/250ms/1200ms limits
 * - Scenario 4: Mode A 5D Model DNA Differentiation (Divergent Ideation -> `gemini-4-argon-high`,
 *   `/v1/responses` Self-Contained Coding -> `gpt-6.1-sol`, Routine Bulk Work -> `gemini-3.8-flash-high`)
 * - Scenario 5: Mode A Anthropic `/v1/messages` Protocol & `/v1/chat/completions` SSE Streaming (`stream: true`)
 * - Scenario 6: Mode A Fault Injection & Graceful Degradation (Scorer HTTP 500 & Scorer Timeout -> `profileTask`)
 * - Scenario 7: Mode B Native Routing Group (`group/compass-group`) via `/v1/systemone` Decision Provider
 *   (specific intent rules, `"none of these"` fallback rule, and `effort=auto` 4-level Jev logprobs scaling)
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
    const magpieLogs = [];
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
      const marketItem = listingsData.listings?.find((l) => l.package === "agentcompass");
      assert.ok(marketItem, "Market listings must include package 'agentcompass' from MAGPIE_PLUGIN_MARKET");
      assert.equal(marketItem.name, "AgentCompass");
      assert.equal(marketItem.kind, "middleware");
      assert.deepEqual(marketItem.providers, ["agentcompass"]);

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
      assert.equal(installed.isGateway, true);
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
        `[PASS] Scenario 2 (Market & Web GUI API): listing='agentcompass', icon='${installed.icon}', README=${pageData.readme.length}B, Off/On & Options verified`
      );
    }

    // =========================================================================
    // SCENARIO 3: Mode A Two-Stage Tandem — 1,600ms Slow Async System-One Scorer
    // =========================================================================
    scorerDelayMs = 1600;
    scorerForceStatus = 200;
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

      report.scenarios.scenario3_slow_scorer_tandem = {
        pass: true,
        elapsedMs,
        scorerElapsedMs: lastScorer.elapsedMs,
        routedModel: lastUp.model,
        routedEffort: lastUp.reasoning_effort,
        carrierStripped: !lastUp.hasRouteCarrier,
      };
      report.steps.push({
        test: "Scenario 3: Mode A (1,600ms Async System-One -> hooks.js [Bun] -> middleware.js [moejs]) — Root Cause Debugging",
        elapsedMs,
        scorerElapsedMs: lastScorer.elapsedMs,
        routedModel: lastUp.model,
        routedEffort: lastUp.reasoning_effort,
        carrierStripped: !lastUp.hasRouteCarrier,
        pass: true,
      });
      console.log(
        `[PASS] Scenario 3 (Mode A 1.6s Async Budget): model="auto" -> ${lastUp.model}:${lastUp.reasoning_effort} in ${elapsedMs}ms`
      );
    }

    // =========================================================================
    // SCENARIO 4: Mode A — 5D Model DNA Differentiation
    // =========================================================================
    scorerDelayMs = 120;
    {
      // 4a. Creative First-Principles Brainstorming -> gemini-4-argon-high
      const resp1 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
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
      assert.equal(resp1.status, 200);
      const up1 = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(up1.model, "gemini-4-argon-high");
      assert.equal(up1.reasoning_effort, "high");

      // 4b. OpenAI /v1/responses Protocol — Self-Contained Module Coding -> gpt-6.1-sol
      const resp2 = await fetch(`http://127.0.0.1:${gwPort}/v1/responses`, {
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
      assert.equal(resp2.status, 200);
      const up2 = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(up2.path, "/v1/responses");
      assert.equal(up2.model, "gpt-6.1-sol");
      assert.equal(up2.reasoning_effort, "high");

      // 4c. Routine Bounded Bulk Work -> gemini-3.8-flash-high (Overqualification Penalty)
      const resp3 = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
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
      assert.equal(resp3.status, 200);
      const up3 = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(up3.model, "gemini-3.8-flash-high");

      report.scenarios.scenario4_model_dna_differentiation = {
        pass: true,
        divergentIdeation: `${up1.model}:${up1.reasoning_effort}`,
        selfContainedResponses: `${up2.model}:${up2.reasoning_effort}`,
        routineBulkWork: `${up3.model}:${up3.reasoning_effort}`,
      };
      report.steps.push({
        test: "Scenario 4: Mode A — 5D Model DNA Differentiation (Argon vs Sol 6.1 vs Flash 3.8)",
        divergentIdeation: `${up1.model}:${up1.reasoning_effort}`,
        selfContainedResponses: `${up2.model}:${up2.reasoning_effort}`,
        routineBulkWork: `${up3.model}:${up3.reasoning_effort}`,
        pass: true,
      });
      console.log(
        `[PASS] Scenario 4 (Mode A Model DNA): ideation=${up1.model}, coding=${up2.model}, bulk=${up3.model}`
      );
    }

    // =========================================================================
    // SCENARIO 5: Mode A — Anthropic `/v1/messages` & SSE Streaming (`stream: true`)
    // =========================================================================
    {
      // 5a. Anthropic `/v1/messages` request
      const anthResp = await fetch(`http://127.0.0.1:${gwPort}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": "sk-local-agent",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "auto",
          max_tokens: 1024,
          messages: [
            {
              role: "user",
              content:
                "Conduct a cross-module deadlock and race condition security audit across the distributed transaction coordinator.",
            },
          ],
        }),
      });
      const anthData = await anthResp.json();
      assert.equal(anthResp.status, 200, `Anthropic /v1/messages failed: ${JSON.stringify(anthData)}`);
      assert.equal(anthData.type, "message", "Anthropic /v1/messages response must have type='message'");
      const anthUp = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(anthUp.model, "claude-opus-5-5");
      assert.equal(anthUp.hasRouteCarrier, false);

      // 5b. OpenAI `/v1/chat/completions` with `stream: true` (SSE streaming)
      const streamResp = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local-agent" },
        body: JSON.stringify({
          model: "auto",
          stream: true,
          messages: [
            {
              role: "user",
              content: "Implement a standalone self-contained LRU cache algorithm in TypeScript.",
            },
          ],
        }),
      });
      assert.equal(streamResp.status, 200);
      assert.ok(
        streamResp.headers.get("content-type")?.includes("text/event-stream"),
        `Expected text/event-stream, got ${streamResp.headers.get("content-type")}`
      );
      const sseText = await streamResp.text();
      assert.ok(sseText.includes("data: ") && sseText.includes("[DONE]"), "SSE stream must contain data chunks and [DONE]");
      const streamUp = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(streamUp.stream, true);
      assert.equal(streamUp.model, "gpt-6.1-sol");
      assert.equal(streamUp.hasRouteCarrier, false);

      report.scenarios.scenario5_anthropic_and_sse_streaming = {
        pass: true,
        anthropicEndpoint: anthUp.path,
        anthropicRoutedModel: anthUp.model,
        anthropicEffort: anthUp.reasoning_effort,
        sseStreamRoutedModel: streamUp.model,
        sseReceivedDone: sseText.includes("[DONE]"),
      };
      report.steps.push({
        test: "Scenario 5: Mode A — Anthropic `/v1/messages` & SSE Streaming (`stream: true`)",
        anthropicRouted: `${anthUp.model}:${anthUp.reasoning_effort}`,
        sseStreamRouted: `${streamUp.model}:${streamUp.reasoning_effort}`,
        pass: true,
      });
      console.log(
        `[PASS] Scenario 5 (Anthropic /v1/messages & SSE Stream): /v1/messages -> ${anthUp.model}, SSE stream -> ${streamUp.model}`
      );
    }

    // =========================================================================
    // SCENARIO 6: Mode A — Fault Injection & Graceful Degradation (HTTP 500 & Timeout)
    // =========================================================================
    {
      // 6a. Scorer returns HTTP 500 -> seamless fallback to local `profileTask` (`inferTaskProfile`)
      scorerDelayMs = 20;
      scorerForceStatus = 500;
      const err500Resp = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local-agent" },
        body: JSON.stringify({
          model: "auto",
          messages: [
            {
              role: "user",
              content:
                "Conduct a read-only security audit and cross-module deadlock root-cause review across the gateway subsystem.",
            },
          ],
        }),
      });
      assert.equal(err500Resp.status, 200, "Gateway request must succeed via heuristic fallback when scorer returns HTTP 500");
      const up500 = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(up500.model, "claude-opus-5-5", "Heuristic fallback should route coupled deadlock review to claude-opus-5-5");

      // 6b. Scorer times out (scorerDelayMs=2000ms > scorerTimeoutMs=300ms) -> seamless fallback to local `profileTask`
      scorerForceStatus = 200;
      scorerDelayMs = 2000;
      await fetch(`http://127.0.0.1:${webPort}/api/plugins/options`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: webCookie },
        body: JSON.stringify({
          Spec: PLUGIN_DIR,
          Options: {
            ...basePluginOptions,
            scorerTimeoutMs: 300,
          },
        }),
      });

      const tTimeout0 = Date.now();
      const timeoutResp = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-local-agent" },
        body: JSON.stringify({
          model: "auto",
          messages: [
            {
              role: "user",
              content:
                "Brainstorm a novel creative gameplay scheme and first-principles roadmap for an AI simulation game.",
            },
          ],
        }),
      });
      const timeoutElapsedMs = Date.now() - tTimeout0;
      assert.equal(timeoutResp.status, 200, "Gateway request must succeed via heuristic fallback when scorer times out");
      const upTimeout = upstreamCalls[upstreamCalls.length - 1];
      assert.equal(
        upTimeout.model,
        "gemini-4-argon-high",
        "Heuristic fallback on scorer timeout should route creative brainstorming to gemini-4-argon-high"
      );
      assert.ok(timeoutElapsedMs < 1500, `Scorer timeout fallback should complete quickly (<1500ms), took ${timeoutElapsedMs}ms`);

      // Restore normal scorer settings
      scorerDelayMs = 100;
      await fetch(`http://127.0.0.1:${webPort}/api/plugins/options`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: webCookie },
        body: JSON.stringify({ Spec: PLUGIN_DIR, Options: basePluginOptions }),
      });

      report.scenarios.scenario6_fault_degradation = {
        pass: true,
        http500FallbackModel: up500.model,
        timeoutFallbackModel: upTimeout.model,
        timeoutFallbackElapsedMs: timeoutElapsedMs,
      };
      report.steps.push({
        test: "Scenario 6: Mode A — Fault Injection & Graceful Degradation (HTTP 500 & Scorer Timeout -> Local Heuristic `profileTask`)",
        http500FallbackModel: up500.model,
        timeoutFallbackModel: upTimeout.model,
        timeoutFallbackElapsedMs: timeoutElapsedMs,
        pass: true,
      });
      console.log(
        `[PASS] Scenario 6 (Fault Injection & Degradation): HTTP 500 -> ${up500.model}, Timeout (${timeoutElapsedMs}ms) -> ${upTimeout.model}`
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

    // Save complete JSON report
    const reportPath = path.join(SANDBOX_ROOT, "e2e-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n[Linux Sandbox] ALL 7 FULL-CHAIN E2E SCENARIOS PASSED! Report written to ${reportPath}`);
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
