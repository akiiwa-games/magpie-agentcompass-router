# magpie-agentcompass-router

A [Magpie](https://github.com/yetone/magpie) gateway plugin powered by [AgentCompass](https://github.com/akiiwa-games/AgentCompass). It routes requests and orders account-pool seats by task intent, 7D capability vectors, 3D Model DNA (`divergence`, `global_rigor`, `module_precision`), session continuity, and 5h/7d subscription quota economics.

By default it runs synchronously inside Magpie's `moejs` gateway middleware (`magpie.middleware`) in under 1 ms with zero network calls, and optionally registers an on-demand Magpie Decision Provider (`agentcompass/agentcompass-systemone`, `/v1/systemone`) for Routing Groups.

## Quickstart

### 1. Install

```sh
magpie plugin add @magpie-community/gateway-agentcompass          # plugin market
# or: magpie plugin add github:akiiwa-games/magpie-agentcompass-router
# or: magpie plugin add /path/to/magpie-agentcompass-router
magpie plugin list
```

### 2. Gateway middleware (Mode A, default)

Configure `candidateModels` (or `availableModels` / `allowedModels`) in the plugin options, then send requests to `model: "agentcompass"` (or `"agentcompass/auto"`, or set `"routeAllModels": true`):

```json
{
  "plugins": {
    "agentcompass": {
      "routeAllModels": false,
      "candidateModels": [
        "claude-opus-4-6",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
        "gpt-5.4",
        "gpt-5.3-codex",
        "gemini-2.5-pro",
        "gemini-2.5-flash"
      ]
    }
  }
}
```

Or from the CLI:

```sh
magpie plugin options <plugin-spec> '{"candidateModels":["claude-opus-4-6","claude-sonnet-4-6","gpt-5.4","gemini-2.5-pro","gemini-2.5-flash"]}'
```

- Requests to `agentcompass` or `agentcompass/*` rewrite `body.model` to `<targetModel>:<targetEffort>` (which Magpie's gateway splits natively) and set protocol-specific effort fields (`reasoning_effort`, `reasoning.effort`, `output_config.effort`).
- If a virtual model (`agentcompass` / `agentcompass/*`) is requested without `candidateModels` or `defaultModel`, the middleware rejects the call with HTTP 400 (`agentcompass: set candidateModels in the plugin's options`) rather than guessing models.
- If `routeAllModels: true` is set without `candidateModels`, concrete model names are kept as-is and only the reasoning effort is injected.

### 3. Account-pool seat strategy (`routings`)

To order accounts inside a Magpie pool by quota headroom, pre-reset surplus sprint, and subscription vs. metered API key priority, select the plugin's routing strategy on your pool (see table below for exact name by install source).

### 4. Routing Group Classifier (Mode B, opt-in)

To use AgentCompass as a Classifier in Magpie's **Routing Groups** UI (`/v1/systemone`, using Magpie's `ClassifyTimeout` of 8–60s):

```sh
magpie plugin options <plugin-spec> '{"enableDecisionProvider": true}'
# restart Magpie (or magpie web), then sign in (keyless):
magpie plugin login agentcompass
magpie plugin list   # shows: agentcompass (AgentCompass, 1 models)  signed in
magpie group set <group> effort=auto classifier=agentcompass/agentcompass-systemone
```

*(Requires plugin `0.1.1+`; `0.1.0` did not register the `auth` hook required by Magpie's provider list — see [issue #1](https://github.com/akiiwa-games/magpie-agentcompass-router/issues/1)).*

### Names by install source

Magpie prefixes pool strategies with the package name (stripped of scope and `middleware-` / `opencode-` / `tools-`), whereas the virtual request model (`agentcompass` / `agentcompass/auto`) and the decision provider (`agentcompass/agentcompass-systemone`) are independent of install source:

| Install source | Pool strategies (`routings`) | Classifier model (Mode B) |
|---|---|---|
| Market `@magpie-community/gateway-agentcompass` | `gateway-agentcompass/agentcompass`, `gateway-agentcompass/agentcompass-pure` | `agentcompass/agentcompass-systemone` |
| GitHub `github:akiiwa-games/magpie-agentcompass-router` | `agentcompass/agentcompass`, `agentcompass/agentcompass-pure` | `agentcompass/agentcompass-systemone` |
| Local directory | `<dir>/agentcompass`, `<dir>/agentcompass-pure` | `agentcompass/agentcompass-systemone` |

Run `magpie plugin list` to inspect the exact names on your machine.

---

## How it decides

```text
Request ──▶ Session continuity check (src/continuity.js)
             ├─ hold current <model>:<effort> on tool loops, warm KV cache, or short follow-ups
             └─ otherwise:
                  10D task profiler (src/profiler-core.js)
                    ──▶ 7D capability + 3D Model DNA + quota allocator (src/allocator.js, src/quota.js)
                    ──▶ <targetModel>:<targetEffort>
```

### 1. Session continuity (`src/continuity.js`)

The router avoids re-classifying every HTTP request and preserves prompt caches and reasoning signatures:

- **In-turn tool loops (`within: true` → `why: "turn"`)**: When the latest message is a tool result (`role: "tool"`, `tool_result`, `function_call_output`) or an injected system reminder with no new user text, the session's `<model>:<effort>` is held unconditionally.
- **Warm KV cache & short follow-ups (`why: "cache" | "followup"`)**: While a session's prefix cache is warm (`5m` for Anthropic/Gemini, `1h` for ChatGPT/Codex Responses and DeepSeek) or when the user sends a short continuation nudge (`"继续"`, `"go ahead"`, `"lgtm"`), the current model is kept and `keepsEffort` prevents effort from dropping mid-session.
- **History replay across pooled VMs (`replayedState`)**: Magpie runs each request on a pooled `moejs` runtime (`sync.Pool`). When a follow-up or tool loop lands on a runtime that did not serve the earlier turn, the middleware slices the anchor turn out of the resent conversation history and replays its decision (up to 4 turns back) so every runtime produces the same route.
- **Re-route triggers**: Re-evaluates only on `first` (new session), `provider_unhealthy` (upstream `status >= 400` recorded by `onResponse`), `quota_exhausted`, `capability_outgrown` (new visual/GUI input or complex work on a light model), `outgrown` (input exceeds 95% of `context_window`), `worn` (`compacted + live >= 2M` tokens), or `cold` / `compacted`.

### 2. Task profiling & Model DNA allocation (`src/profiler-core.js`, `src/allocator.js`)

Single-pass bounded extraction over Anthropic `/v1/messages`, OpenAI `/v1/responses`, `/v1/chat/completions`, and Gemini payloads builds a 10-field task profile (`work_kind` across 16 canonical routes, `difficulty`, `reasoning_depth`, `code_complexity`, `context_scale`, `divergence`, `hallucination_risk`, `error_cost`, `needs_visual`, `needs_gui`).

Each `<model, effort>` pair in `candidateModels` is scored on:

```text
pure_intent_score(m, e) = fit_score(m, e) - overqual_penalty(m, e) - effort_selectivity_penalty(m, e)
```

- **7D convergent fit**: Weighted match over `reasoning`, `code`, `context`, `tool_use`, `rigor`, `speed`, and `autonomy`, scaled by per-model `EFFORT_CURVES` (`minimal` / `low` / `medium` / `high` / `xhigh` / `max`), with a steep deficit penalty below the task's ability floor.
- **3D Model DNA**: Matches `divergence` (creative/architectural exploration), `global_rigor` (cross-module invariants and deep debugging), and `module_precision` (self-contained code and schema accuracy).
- **Over-qualification & effort selectivity**: Penalizes frontier models and `xhigh` / `max` effort on routine tasks unless unlocked by high demand or pre-reset quota sprint.

### 3. Quota economics & seat ordering (`src/quota.js`, `src/quota-loader.js`)

- **Hard reserve gates**: Excludes rate-limited windows or windows below safety reserves (`safety_margin_pct = 5%`, `short_window_floor_pct = 10%`).
- **Opportunity cost & pre-reset sprint**: Prices expected shortage against forecast demand before reset (`demandForecast`, `computeWindowCost`). Within 36 hours of a window reset, surplus quota above forecast demand earns a `reset_bonus` and discounts over-qualification and effort penalties (`sprint_sunk`).
- **Pool seat ordering (`strategies.agentcompass`)**: Orders Magpie `Seat` entries (`{ account, known, learns, used, soon, pace, resting }`) as:
  `unprobed (learns) → pre-reset sprint → healthy subscriptions → metered API keys → high-usage reserve (≥90%) → resting/exhausted`.

---

## Plugin options

Set under `plugins.agentcompass` (or via `magpie plugin options`):

| Option | Default | Description |
|---|---|---|
| `candidateModels` | — | Candidate model IDs the middleware may route to (aliases: `availableModels`, `allowedModels`, `models`). |
| `defaultModel` | — | Fallback model when no `candidateModels` list is set (alias: `fallbackModel`). |
| `routeAllModels` | `false` | Route every incoming model request, not only `agentcompass` virtual models. |
| `routeModelTriggers` | `["agentcompass", "agentcompass/auto", "agentcompass/intent", "agentcompass/system-one-0.5"]` | Virtual model names that trigger routing when `routeAllModels` is `false` (alias: `triggerModels`). |
| `injectProtocolEffort` | `true` | Write the selected effort into protocol fields (`reasoning_effort`, `reasoning.effort`, `output_config.effort`). |
| `useColonEffort` | `true` | Rewrite `body.model` as `<model>:<effort>` for Magpie's native effort splitter. |
| `modelMap` / `modelPrefix` | — | Map canonical model IDs to custom upstream names or prepend a provider prefix. |
| `modelsByProvider` | — | Per-provider candidate model lists used by `onProvider(body, ctx)`. |
| `accountsByWorkKind` | — | Per-`work_kind` allowlist of account `ref` / `name` / `provider` filtered in `onAccount(account, ctx)`. |
| `affinityMode` | `"cache"` | Session continuity mode (`"cache"` or `"off"`). |
| `quotas` / `quotasPath` | — | Inline quota snapshot object or explicit path to a quota JSON file (`quotaFile`). No implicit directory scanning. |
| `meteredOk` | `true` | Allow metered API keys when scoring candidates. |
| `enableDecisionProvider` | `false` | Register the `agentcompass/agentcompass-systemone` Decision Provider (`/v1/systemone`) for Routing Groups. |
| `allowExternalScorer` | `false` | Allow Mode B (`src/index.js`) or `src/hooks.js` to call an external `scorer` (`{ kind, baseUrl, apiKey, model, timeoutMs }`) with heuristic fallback on timeout/error. |

---

## Repository layout

| Path | Description |
|---|---|
| [`src/middleware.js`](src/middleware.js) | Synchronous `moejs` gateway middleware (`onRequest`, `onProvider`, `onAccount`, `onResponse`) and pool `strategies`. |
| [`src/index.js`](src/index.js) | Mode B Decision Provider (`agentcompass/agentcompass-systemone`, `/v1/systemone`, `jevLevelled` and `jevBody`). |
| [`src/continuity.js`](src/continuity.js) | Session key fingerprinting, tool-loop lock, KV cache TTLs, monotonic effort ratchet, and stateless history replay. |
| [`src/profiler-core.js`](src/profiler-core.js) | Single-pass multi-protocol request fact extractor and deterministic 10D task profiler. |
| [`src/allocator.js`](src/allocator.js) | 7D capability + 3D Model DNA + effort-curve candidate ranker. |
| [`src/quota.js`](src/quota.js), [`src/quota-loader.js`](src/quota-loader.js) | 5h/7d window opportunity-cost model, pre-reset surplus sprint, and Magpie pool seat ordering. |
| [`src/catalog.js`](src/catalog.js) | 16 `work_kind` routes, model capability/DNA catalog, aliases, and `EFFORT_CURVES`. |
| [`src/scorer-live.js`](src/scorer-live.js), [`src/hooks.js`](src/hooks.js) | Optional external System-One scorer client (LRU + timeout fallback) and programmatic Bun hook helper. |
| [`docs/`](docs/) | Architecture notes ([`RESEARCH_AND_SCHEME.md`](docs/RESEARCH_AND_SCHEME.md)), market registry entry, and Linux sandbox E2E report ([`linux-sandbox-e2e-report.json`](docs/linux-sandbox-e2e-report.json)). |

## Tests

```sh
# Unit tests (multi-protocol extraction, 10D profiling, allocator, continuity replay, quota economics, /v1/systemone)
npm test

# End-to-end 8-scenario verification against a real Magpie Linux binary in an isolated tmpfs sandbox
MAGPIE_LINUX_BIN=/path/to/magpie sh test/run-linux-sandbox.sh
```

## Related projects

- [AgentCompass](https://github.com/akiiwa-games/AgentCompass) — cross-host multi-agent task router (`agentcompass roll`), 5h/7d subscription quota scheduler, 2M-token rotation guard, and `PreToolUse` spawn gate.
- [cindy-agentcompass-plugin](https://github.com/akiiwa-games/cindy-agentcompass-plugin) — Cindy host plugin for AgentCompass task routing and child-task collection.
- [Magpie](https://github.com/yetone/magpie) — local AI gateway and multi-subscription proxy.

## License

MIT
