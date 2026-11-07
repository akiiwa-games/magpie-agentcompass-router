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
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "gpt-6.1-sol",
        "gpt-6-astra",
        "gemini-4-argon-high",
        "gemini-3.8-flash-high"
      ]
    }
  }
}
```

Or from the CLI:

```sh
magpie plugin options <plugin-spec> '{"candidateModels":["claude-opus-5-5","claude-sonnet-5-5","gpt-6.1-sol","gemini-4-argon-high","gemini-3.8-flash-high"]}'
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

Single-pass bounded extraction over Anthropic `/v1/messages`, OpenAI `/v1/responses`, `/v1/chat/completions`, and Gemini payloads builds a task profile (`work_kind` across 16 canonical routes, `difficulty`, `reasoning_depth`, `code_complexity`, `context_scale`, `divergence`, `hallucination_risk`, `error_cost`, `needs_visual`, `needs_gui`, `realtime_loop`).

Each `<model, effort>` pair in `candidateModels` is scored on:

```text
pure_intent_score(m, e) = fit_score(m, e) - overqual_penalty(m, e) - effort_selectivity_penalty(m, e)
```

- **7D convergent fit**: Weighted match over `reasoning`, `code`, `context`, `tool_use`, `rigor`, `speed`, and `autonomy`, scaled by per-model `EFFORT_CURVES` (`minimal` / `low` / `medium` / `high` / `xhigh` / `max`), with a steep deficit penalty below the task's ability floor.
- **3D Model DNA**: Matches `divergence` (creative/architectural exploration), `global_rigor` (cross-module invariants and deep debugging), and `module_precision` (self-contained code and schema accuracy).
- **Over-qualification & effort selectivity**: Penalizes frontier models and `xhigh` / `max` effort on routine tasks unless unlocked by high demand or pre-reset quota sprint.
- **Live observe-act responsiveness (`realtime_loop`)**: When the classifier (`src/scorer-live.js`) or explicit caller input marks `realtime_loop: true` (the worker itself acts inside a live observe → decide → act loop against a changing external system; deterministic `inferTaskProfile` never guesses `realtime_loop` from keywords and always sets `false` unless explicitly passed):
  - **Responsiveness floor (`0.50`) & effort step-down (`resolveRealtimeEffort`)**: Candidates below the per-turn responsiveness floor step down to the highest provider-dispatchable effort (`DISPATCH_EFFORTS`) that clears both the task's ability gate and the responsiveness floor (skipping models whose effort is baked into the model ID, or deferring when a healthy, applicable sibling candidate already covers that lower effort). Quota burn and cost are computed at the stepped-down effort.
  - **Exclusion & conservative default**: Candidates that still fall below `0.50` after step-down are excluded with `"responsiveness X.XX below realtime_loop floor 0.50 (too slow per turn for a live loop)"`. Names AgentCompass has no calibrated row for default to `0.52` (`responsiveness_source: "default"`). A name resolves to its speed data as AgentCompass's `resolve_canonical_model` does (`resolveResponsivenessModelKey`), which is a separate mapping from the one routing uses: `claude-opus-4-6` routes as `claude-opus-5-5` but has its own responsiveness, its own pin identity, and no `none` step-down.
  - **Responsiveness blend & user pins**: Eligible candidates blend `0.35 * responsiveness` into `fit_score`. Explicitly pinned models/efforts are never stepped down or excluded for responsiveness, emitting a warning instead. On Magpie a pin is the plugin options `pinnedModel` / `pinnedEffort` / `pinnedBundle`, and the warning goes to Magpie's log. Non-`realtime_loop` routing is completely unchanged.
  - **The flag on Magpie**: `realtime_loop` stops at the gateway: the middleware removes it from the body before the upstream sees it. Magpie's pooled runtimes share nothing between requests, so send it on every turn or set the plugin option `realtime_loop: true`; a turn sent without it routes as non-realtime on a runtime that has not seen the session.
  - **Warm-session hold boundary (by design)**: Continuation holds (`why: "cache" | "turn" | "followup" | "realtime_loop"`) are evaluated before calling the external scorer (`scoreTaskLive`), so an already-running warm session does not invoke the classifier mid-hold. `realtime_loop` is decided by the classifier on the session's first turn (or when a hold expires/reroutes) and persisted in session state, or can be passed explicitly (`realtime_loop: true` in the request payload or plugin options) on any turn to break a non-realtime hold (`capability_outgrown: realtime_loop_required`) without relying on any text heuristics.

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

## Repository layout

| Path | Description |
|---|---|
| `src/middleware.js` | Synchronous `moejs` gateway middleware (`onRequest`, `onProvider`, `onAccount`, `onResponse`) and pool `strategies`. |
| `src/index.js` | Mode B Decision Provider (`agentcompass/agentcompass-systemone`, `/v1/systemone`, `jevLevelled` and `jevBody`). |
| `src/continuity.js` | Session key fingerprinting, tool-loop lock, KV cache TTLs, monotonic effort ratchet, and stateless history replay. |
| `src/profiler-core.js` | Single-pass multi-protocol request fact extractor and deterministic 10D task profiler. |
| `src/allocator.js` | 7D capability + 3D Model DNA + effort-curve candidate ranker. |
| `src/quota.js`, `src/quota-loader.js` | 5h/7d window opportunity-cost model, pre-reset surplus sprint, and Magpie pool seat ordering. |
| `src/catalog.js` | 16 `work_kind` routes, model capability/DNA catalog, aliases, and `EFFORT_CURVES`. Generated from AgentCompass's `accounts.json` at the commit in `test/fixtures/agentcompass-pin.json` (`npm run catalog:sync`, `npm run catalog:check`). |
| `src/scorer-live.js`, `src/hooks.js` | Optional external System-One scorer client (LRU + timeout fallback) and programmatic Bun hook helper. |
| `test/router.test.mjs` | Unit test suite (`npm test` / `bun test`). |
| `test/realtime-parity.test.mjs`, `test/routing-parity.test.mjs` | The port against AgentCompass's `allocator.py` at the pinned commit; regenerate with `test/fixtures/gen_realtime_parity.py` and `gen_routing_parity.py`. |
| `test/routing-contract.test.mjs` | One regression test per finding of the routing review. |

## Tests

```sh
npm test                       # or: bun test
```

---

## 中文说明

基于 [AgentCompass](https://github.com/akiiwa-games/AgentCompass) 的 [Magpie](https://github.com/yetone/magpie) 网关路由插件：按任务意图、7 维客观能力、3 维模型禀赋（`divergence` 发散创意、`global_rigor` 全局严密、`module_precision` 单模块精准）、会话连续性与 5h/7d 订阅配额经济学选出 `<model>:<effort>` 并对号池席位排序。默认在 `moejs` 网关中间件内同步运行（`< 1 ms`，零网络请求），并可按需开启 `/v1/systemone` 决策 Provider 供路由组（Routing Groups）使用。

### 快速上手

#### 1. 安装

```sh
magpie plugin add @magpie-community/gateway-agentcompass          # 插件市场
# 或：magpie plugin add github:akiiwa-games/magpie-agentcompass-router
# 或：magpie plugin add /path/to/magpie-agentcompass-router
magpie plugin list
```

#### 2. 网关中间件（模式 A，默认）

在插件选项中配置 `candidateModels`（或 `availableModels` / `allowedModels`），客户端请求 `model: "agentcompass"`（或 `"agentcompass/auto"`，或设 `"routeAllModels": true`）：

```sh
magpie plugin options <plugin-spec> '{"candidateModels":["claude-opus-5-5","claude-sonnet-5-5","gpt-6.1-sol","gemini-4-argon-high","gemini-3.8-flash-high"]}'
```

- 请求虚拟模型 `agentcompass` / `agentcompass/*` 时，中间件将 `body.model` 改写为 `<targetModel>:<targetEffort>`，并按协议注入思考档位字段（`reasoning_effort`、`reasoning.effort`、`output_config.effort`）。
- 未配置 `candidateModels` 或 `defaultModel` 时请求虚拟模型会返回 HTTP 400（`agentcompass: set candidateModels in the plugin's options`），不猜测模型列表。
- 开启 `routeAllModels: true` 且未配置候选列表时，具体模型名保持不变，仅自动注入思考档位。

#### 3. 账号池席位排序（`routings`）

在多账号池上选择本插件的路由策略（名称见下表），按「待探测新号 (`learns`) → 临期富余冲刺 (`36h` 内重置) → 低机会成本订阅 → 按量 API Key → 高占用储备 (`≥90%`) → 冷却/耗尽」排序。

#### 4. 路由组分类器（模式 B，按需开启）

在 Magpie 的 **Routing Groups** 中把本插件用作分类器（`/v1/systemone`，需 `0.1.1+`）：

```sh
magpie plugin options <plugin-spec> '{"enableDecisionProvider": true}'
# 重启 Magpie（或 magpie web），然后免 Key 登录：
magpie plugin login agentcompass
magpie group set <group> effort=auto classifier=agentcompass/agentcompass-systemone
```

#### 各安装来源下的名称

Magpie 会用包名前缀命名号池策略（`routings`），而客户端请求的虚拟模型（`agentcompass` / `agentcompass/auto`）与分类器模型（`agentcompass/agentcompass-systemone`）与安装来源无关：

| 安装来源 | 号池策略（`routings`） | 路由组分类器（模式 B） |
|---|---|---|
| 插件市场 `@magpie-community/gateway-agentcompass` | `gateway-agentcompass/agentcompass`、`gateway-agentcompass/agentcompass-pure` | `agentcompass/agentcompass-systemone` |
| GitHub `github:akiiwa-games/magpie-agentcompass-router` | `agentcompass/agentcompass`、`agentcompass/agentcompass-pure` | `agentcompass/agentcompass-systemone` |
| 本地目录 | `<目录名>/agentcompass`、`<目录名>/agentcompass-pure` | `agentcompass/agentcompass-systemone` |

可通过 `magpie plugin list` 查看本机实际注册的名称。

### 决策流程简述

1. **会话连续性优先（`src/continuity.js`）**：轮内工具循环（`within: true`）、KV 缓存温热期内（Anthropic/Gemini `5m`，ChatGPT/Codex Responses 与 DeepSeek `1h`）或短追问（`"继续"`、`"go ahead"`、`"lgtm"`）直接保持当前 `<model>:<effort>` 且思考档位单调不降级（`keepsEffort`；实时会话不触发抬档棘轮）。跨 `sync.Pool` 池化 `moejs` 实例时，自动从客户端重发的对话历史回溯锚点轮次（最多 4 轮）重放决策，确保任意实例结果一致。仅在新会话、上游报错（`status >= 400`）、配额耗尽、新增视觉/GUI 或显式传入 `realtime_loop: true`、任务复杂度越界、输入超窗口 95%、累计上下文达 2M、或缓存冷化/压缩后重新路由。（设计边界：温会话的 hold 发生在外部评分器调用之前，对已在跑的温会话不会在 hold 期间重跑分类器；`realtime_loop` 判定在会话首回合或重路由时由分类器给出并随会话状态保存，或由调用方在任意回合显式传入 `realtime_loop: true` 触发重路由，不做任何基于任务文本的硬编码判断。）
2. **任务画像与能力选型（`src/profiler-core.js`、`src/allocator.js`）**：单遍有界解析 Anthropic / OpenAI Responses / Chat / Gemini 请求体，生成任务画像（含 `realtime_loop` 实时观察→动作循环标记，仅由分类器 `src/scorer-live.js` 或调用方显式传入，启发式画像恒为 `false`），结合 7 维客观能力、Effort 投入曲线、3 维 Model DNA、实时循环响应速度（`responsiveness` 下限 `0.50`、自动降档到过能力门限与响应下限的最高可派发档位、兄弟候选礼让、慢模型排除、未测速模型保守默认 `0.52`、用户点名仅告警：Magpie 上通过插件选项 `pinnedModel` / `pinnedEffort` / `pinnedBundle` 点名，告警写入 Magpie 日志）。`realtime_loop` 标记由中间件在转发前从请求体移除，不会发给上游；Magpie 的池化运行时之间不共享状态，客户端需每轮都带上该标记或设置插件选项 `realtime_loop: true`，否则未见过该会话的运行时会按非实时路由与防杀鸡用牛刀惩罚对 `candidateModels` 评分。
3. **订阅配额精算（`src/quota.js`）**：过滤低于安全水位（长窗口 `5%`、短窗口 `10%`）或限流的窗口，计算期望短缺机会成本，并在距重置 36 小时内对富余额度给予冲刺加分（`reset_bonus` / `sprint_sunk`）。

---

## Related projects

- [AgentCompass](https://github.com/akiiwa-games/AgentCompass) — cross-host multi-agent task router (`agentcompass roll`), 5h/7d subscription quota scheduler, 2M-token rotation guard, and `PreToolUse` spawn gate.
- [cindy-agentcompass-plugin](https://github.com/akiiwa-games/cindy-agentcompass-plugin) — Cindy host plugin for AgentCompass task routing and child-task collection.
- [Magpie](https://github.com/yetone/magpie) — local AI gateway and multi-subscription proxy.

## License

MIT
