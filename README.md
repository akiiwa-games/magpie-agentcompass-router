# magpie-agentcompass-router

> **Intent, Multi-Dimensional Capability, Subscription Quota Opportunity-Cost & Session-Affinity Routing Plugin for [Magpie](https://github.com/yetone/magpie), powered by [AgentCompass](https://github.com/akiiwa-games/AgentCompass).**
>
> 为 [Magpie](https://github.com/yetone/magpie) 打造的**意图 × 能力矩阵 × 订阅配额机会成本 × 会话粘性路由插件**——突破 Magpie 同步插件 20ms/250ms 时间预算限制，拿到 **10s–60s** 充裕推理预算，完整运行 **[AgentCompass](https://github.com/akiiwa-games/AgentCompass)** 本体的 **10 维任务画像 + 6 维客观能力向量 + 3 维主观禀赋（Model DNA）+ 5h/7d 订阅窗口机会成本精算与临期余量冲刺（Pre-Reset Sprint）+ 思考档位投入曲线** 核心算法。

---

## 🔗 与 [AgentCompass 本体](https://github.com/akiiwa-games/AgentCompass) 的关系及生态协同（Magpie + Cindy + Paseo）

本插件将 **[AgentCompass](https://github.com/akiiwa-games/AgentCompass)** 的核心选型引擎（`route_judge.py` + `allocator.py` 的纯意图路由内核）提取并移植为原生 Magpie 插件。

如果你不仅需要在网关单次请求（Turn 级）做精准意图路由，还需要**跨工具的多 Agent 任务编排、5h/7d 订阅额度机会成本精算、2M 历史上下文防失忆换人、以及多宿主统一门禁**，强烈建议将本插件与 **[AgentCompass 本体（`https://github.com/akiiwa-games/AgentCompass`）](https://github.com/akiiwa-games/AgentCompass)** 配合 **[Magpie](https://github.com/yetone/magpie)**、**[Cindy](https://github.com/yetone/cindy)**、**Paseo** 共同使用：

```mermaid
flowchart TB
    subgraph Apps["日常开发宿主 & 客户端"]
        CC["Claude Code / Codex CLI"]
        OC["OpenCode / Cursor / Antigravity"]
    end

    subgraph Ecosystem["四件套协同工作流"]
        AC["🧭 AgentCompass 本体<br/>github.com/akiiwa-games/AgentCompass<br/>• 跨宿主子 Agent 调度 (agentcompass roll)<br/>• 5h/7d 窗口美元机会成本 & 燃尽速率精算<br/>• 2M 历史累计 Token 防失忆自动换人<br/>• PreToolUse 路由门禁 & 每日审计"]
        MG["🪶 Magpie + magpie-agentcompass-router（本插件）<br/>• 本地多订阅/API 统一网关与协议互转<br/>• Turn 级每轮请求纯意图选模 + 自动配 Effort<br/>• 10s-60s 异步 System-One 10 维画像"]
        CD["📊 Cindy (yetone/cindy)<br/>• 菜单栏实时订阅用量监测 (Claude / Codex / Gemini)<br/>• 写入 ~/.cindy/state.json 供 AgentCompass 读取"]
        PS["🚀 Paseo<br/>• 跨 Provider 子 Agent 进程池与 Git Worktree 隔离<br/>• 承载 AgentCompass 派出的并发 Worker"]
    end

    CC -->|"单轮网关请求"| MG
    OC -->|"单轮网关请求"| MG
    CC -->|"派发独立子任务 (roll)"| AC
    OC -->|"派发独立子任务 (roll)"| AC
    CD -->|"实时 5h/7d 剩余配额"| AC
    AC -->|"启动隔离 Worker"| PS
    PS -->|"API 请求经过网关"| MG
    AC -.->|"共用核心 10D 画像 & 7D+3D 选模算法"| MG
```

### 四件套各自解决什么问题？

| 组件 | 定位与职责 | 与 [AgentCompass 本体](https://github.com/akiiwa-games/AgentCompass) 共用时的增益 |
| :--- | :--- | :--- |
| **[AgentCompass 本体](https://github.com/akiiwa-games/AgentCompass)** | **跨宿主总调度器（Macro-Orchestrator）**<br/>管理 Claude Code、Codex、OpenCode、Antigravity、Dot、Grok 等所有子 Agent 派工与额度护栏 | 提供 `agentcompass roll` 一键拆单/派工、5h/7d 窗口美元价值最大化、2M 累计上下文强制交接换人、以及 `PreToolUse` 门禁 |
| **[Magpie](https://github.com/yetone/magpie) + 本插件** | **本地网关与单轮意图路由器（Micro-Router）**<br/>在 HTTP 网关层拦截每次 LLM 调用，按 Prompt 真实难度动态改写 `<model>:<effort>` | 当主会话不派子 Agent、直接在客户端对话时，由本插件在网关层自动把简单问答切给快模型、把复杂排障/架构切给顶配模型并挂上合适 `effort` |
| **[Cindy](https://github.com/yetone/cindy)** | **实时订阅配额遥测（Quota Telemetry）**<br/>常驻状态栏采集各家 Pro/Max 账号的 5h / 7d 窗口用量与重置时间 | Cindy 产出的 `~/.cindy/state.json` 可直接被 AgentCompass 本体读取，让每次派工不仅看任务意图，还实时避开即将限流的账号 |
| **Paseo** | **多 Agent 并发运行时（Execution Runtime）**<br/>管理后台 Worker 会话生命周期、跨 worktree 并发开发与父子 Agent 消息通信 | AgentCompass 本体计算出最优 `<provider>/<model>:<effort>` 后，直接通过 Paseo 启动带显式权限模式与父会话回调契约的 Worker |

---

## ❓ 为什么需要这个插件？（Magpie 原生路由的痛点与时间预算突破）

直接阅读 Magpie 源码（`internal/gateway/`、`internal/middleware/`、`internal/plugin/`）可以发现，Magpie 原生路由与同步插件存在两个核心瓶颈：

1. **同步 JS 插件时间预算极短，且 Pool Strategy 拿不到 Prompt**：
   - `strategies[name](pool, seats, options)` 运行在内置 `moejs` 沙箱中，**硬超时仅 `20 ms`**（`strategyLimit = 20 * time.Millisecond`），且入参只有账号槽位数组，**完全看不到用户的请求正文与意图**。
   - `magpie.middleware`（`onRequest`）同样运行在无网络的 `moejs` 沙箱中，**硬超时仅 `250 ms`**（`requestLimit = 250 * time.Millisecond`），无法发起外部 System-One 小模型分类请求。
2. **原生 Routing Group 规则过于扁平**：
   - Magpie 原生 `classify.go` + `rules.go` 只向分类器询问单一的 1D `intent` 标签和 `0..3` 的整数 `effort`，再按静态列表映射模型；
   - 缺少多维能力向量匹配（如 `code` vs `reasoning` vs `context` vs `rigor`）、缺少模型主观禀赋区分（擅长发散脑暴的 `Gemini 4 Argon` vs 擅长跨模块严密推演的 `Claude Opus 5.5` vs 擅长单模块高精度代码的 `GPT-6.1 Sol`）、缺少连续能力底线（`required_ability` floor）与杀鸡用牛刀惩罚（`overqualification penalty`）。

### 💡 本插件如何合法拿到 10s–60s 时间预算？

我们通过分析 Magpie 的请求管线（`internal/gateway/middleware.go:serveAgent` 与 `internal/gateway/decide.go`），设计了**双模式长预算架构**，无需修改 Magpie 任何一行源码：

#### 模式 A：两阶段接力直改模型（`magpie.hooks` [Bun, 10,000 ms] $\rightarrow$ `magpie.middleware` [`moejs`, 250 ms]）
在 `internal/gateway/middleware.go:serveAgent` 中：
1. **第一阶段（`src/hooks.js`，Bun 运行时，最长 `10,000 ms` 预算）**：
   - Magpie 先执行 `gatewayHooks`（第 39 行），默认超时 `1200 ms`，可通过插件配置或环境变量 `AGENTCOMPASS_GATEWAY_TIMEOUT_MS=8000` 提升至 **`10,000 ms`（10 秒）**！
   - `src/hooks.js` 在完整的 Bun 异步环境中调用外部或本地 System-One 模型（支持 Jev `/v1/systemone`、任意 OpenAI 兼容快模型、以及毫秒级确定性启发式兜底），生成 [AgentCompass](https://github.com/akiiwa-games/AgentCompass) 的 **10 维结构化任务画像**，并运行完整的 `selectBestRoute()` 算法算出最优 `<targetModel>:<targetEffort>`。
   - **绕过 `host.js:1411` 限制**：Magpie 的 `host.js` 禁止 `hooks` 直接修改 `body.model` / `tools` / `stream`，但允许写入自定义元数据字段。因此 `hooks.js` 将选型结果写入 `body.__agentcompass_route`。
2. **第二阶段（`src/middleware.js`，`moejs` 运行时，`< 0.2 ms` 完成）**：
   - 紧接着（第 42 行），Magpie 执行 `gwmw.Agent`（`src/middleware.js`）。
   - `middleware.js` 读取并删除 `body.__agentcompass_route`，直接将 `body.model` 改写为 `<targetModel>:<targetEffort>`（Magpie `gateway.go:1560` 的 `askedAt()` 原生支持 `<model>:<effort>` 语法并自动设置请求思考档位！）。

#### 模式 B：原生 Routing Group 决策 Provider（`decide: true` / `/v1/systemone`，8,000 ms – 60,000 ms 预算）
- `src/index.js` 同时注册了一个拥有 `decide: true` 能力的 Magpie Provider（`agentcompass`，显示名称 `AgentCompass`）及决策模型 `agentcompass-systemone`（`decides: true`）。
- 当你在 Magpie UI 的 **Routing Group -> Classifier** 中选择 `agentcompass/agentcompass-systemone` 时，Magpie 的 `askJev`（`internal/gateway/decide.go:132`）会赋予它 `Settings.ClassifyTimeout` 的专属预算（**默认 `8,000 ms`，最高可在 Magpie 设置中调至 `60,000 ms` = 60 秒**）。
- 插件完整兼容 Magpie 的两套 `/v1/systemone` 协议（`jevLevelled` 两级分类与 `jevBody` 单级分类），并在后台用完整的 10 维画像 + 7D/3D 向量算法把最优路由反推回你配置的 Routing Group 规则与 `effort`（`low` / `medium` / `high` / `xhigh`）。

---

## 🧠 核心算法：10 维任务画像 × (7 维客观能力 + 3 维主观禀赋)

本插件完整移植了 [AgentCompass (`E:\PROJECTS\route_manager`)](https://github.com/akiiwa-games/AgentCompass) 的纯意图选型公式（详见 [`src/allocator.js`](./src/allocator.js) 与 [`src/profiler-core.js`](./src/profiler-core.js)）：

### 1. 10 维任务画像（Task Profile）
每次请求都会被剖析为 10 个正交维度：
- `work_kind`（16 类标准工作形态：`routine_execution`、`self_contained_code`、`repo_implementation`、`architecture_refactor`、`debugging_root_cause`、`direction_reasoning`、`frontier_research`、`verification_audit`、`writing_polishing` 等）
- `difficulty`（`easy` / `medium` / `hard` / `max`）
- `reasoning_depth`（`1..4`）：逻辑推演深度与未知根因排查复杂度
- `code_complexity`（`0..4`）：代码修改跨度与状态机耦合度（只读审查强制归零）
- `context_ breadth`（`1..4`）：上下文广度与跨文件/长日志规模
- `tool_intensity`（`0..3`）：工具链调用密集度
- `rigor_need`（`1..4`）：工程严密性与零回归要求
- `divergence_need`（`0..3`）：发散创意、第一性原理脑暴需求
- `global_rigor_need`（`0..3`）：跨系统全局不变量与长链路一致性需求
- `module_precision_need`（`0..3`）：单模块契约、Schema 与边界条件精确度需求

### 2. 候选 `<model, effort>` 综合效用函数
对每一个候选模型与思考档位组合 $(m, e)$，插件计算：

$$\text{pure\_intent\_score}(m, e) = \text{fit\_score}(m, e) - \text{overqual\_penalty}(m, e) - \text{effort\_Selectivity\_penalty}(m, e)$$

其中：
- **思考档位缩放（Effort Scaling）**：不同思考档位（`low` / `medium` / `high` / `xhigh` / `max`）按 `EFFORT_CURVES` 动态缩放模型的 `reasoning`、`rigor`、`autonomy` 等能力维度；
- **7 维客观能力拟合（Convergent Fit）**：加权点积匹配 `reasoning`、`code`、`context`、`tool_use`、`rigor`、`speed`、`autonomy`，并对低于任务硬性门槛（`min_reasoning` / `min_code` / `min_rigor`）的候选施加缺口惩罚（`deficit * 14.0`）；
- **3 维模型主观禀赋（Subjective Model DNA）**：
  - `divergence`（发散与创意突破：如 `gemini-4-argon-high` = `95`）
  - `global_rigor`（全局架构与深水区排障：如 `claude-opus-5-5` = `97`、`gpt-6-astra` = `94`）
  - `module_precision`（单模块精准实现：如 `gpt-6.1-sol` = `95`、`gpt-6.1-terra` = `89`）
- **双模融合权重**：收敛型任务（`convergence_weight = 0.80`）以硬指标为主；发散/脑暴型任务（`divergence_weight = 0.45`）大幅提升主观禀赋权重；
- **防杀鸡用牛刀（Overqualification & Effort Selectivity）**：当任务需求（`task_demand`）较低时，自动惩罚过高模型与过高 `effort`（如 `xhigh` / `max` 仅在 `task_demand >= 82` 或 `reasoning_depth >= 4` 时解锁）。

### 3. 对齐 Magpie 原生 Router 的会话粘性、轮内锁定与按需重选（[`src/continuity.js`](./src/continuity.js)）
参考 Magpie 原生 `internal/gateway/affinity.go`、`rules.go` 与 `decide.go`，本插件**绝不在每次 HTTP 请求上无脑重复跑分类器**，而是严格遵循**“仅在需要选择/切换 Provider（或能力/上下文越界）时才做意图路由，其余情况锁定续用”**：
- **会话与子 Agent 隔离标识（`computeSessionKey` & `firstWords`）**：结合 `session_id`、首条真实用户消息的纯 JS SHA-256 前 12 字节指纹（自动剥离 `<system-reminder>`、`<task-notification>`、`TodoWrite` 等 Agent 注入噪声）与 `x-claude-code-agent-id`，防止共享同一 `session` 的子代理覆盖主会话粘性状态。
- **轮内工具循环 100% 锁定（`within: true` $\rightarrow$ `why: "turn"`）**：只要最后一条消息是工具返回（`role: "tool"`、`tool_result`、`function_call_output`）或仅含系统注入提醒而无新用户发言，**100% 锁定本轮选定的 `<model>:<effort>`，零外部评分调用**（保护 OpenAI `reasoning.encrypted_content`、Anthropic `thinking.signature` 签名块与 KV 缓存）。
- **跨轮 KV 缓存保鲜续用与思考档位单调棘轮（`why: "cache" | "followup"` & `keepsEffort`）**：
  - 当会话已建立有效前缀缓存（$\ge 1024$ tokens 或 `cached: true`）且未超过缓存冷化窗口（Anthropic/Gemini 默认 `5m`，ChatGPT/Codex Responses 与 DeepSeek 磁盘缓存 `1h`），或用户发送简短追问（`"继续"`、`"好的，按这个改"`、`"ok go ahead"`、`"lgtm"`），直接保持当前模型且 `keepsEffort` 保证思考档位单调不降级（如 `high/max` 不会掉回 `low`）。
- **仅在 6 类信号触发时重新执行意图路由**：
  1. `why: "first"` — 新会话首轮请求；
  2. `why: "provider_unhealthy"` — `onResponse` / `onUsage` 捕获上游报错或限流（`status >= 400` / `rejected: true`），自动剔除故障模型并故障转移；
  3. `why: "capability_outgrown"` — 新一轮引入图片/截图而当前模型不支持视觉，或轻量级模型（`tier < 3.5`）遭遇跨模块架构重构/深水区死锁排障；
  4. `why: "outgrown"` — 当前输入超出模型 `context_window` 的 **95%**（如 200k 窗口达到 >190k），自动升级至 400k / 1M 大窗口模型；
  5. `why: "worn"` — 遵循 AgentCompass 2M 累计未压缩上下文防失忆规则（`compactedTokens + tokens >= 2,000,000`）；
  6. `why: "cold"` / `why: "compacted"` — 闲置超过缓存 TTL 或刚执行 `/compact`（Token 骤降 >50%），重新评估并允许在简单日常任务上顺滑降档省钱。

### 4. 5h / 7d 订阅配额机会成本、临期余量冲刺（Pre-Reset Sprint）与账号池排序（[`src/quota.js`](./src/quota.js) & [`src/quota-loader.js`](./src/quota-loader.js)）
本插件不仅匹配模型能力，还完整移植了 AgentCompass `allocator.py` 的**订阅窗口经济学模型**，并与 Magpie 的实时配额遥测（`quotas.json`、`/v1/magpie/quotas` 及 `strategies` 的 `Seat` 结构）深度打通：
- **自动读取 Magpie 实时配额（`quotas.json`）**：在 Bun 阶段自动发现并读取 Magpie 配置目录下的 `quotas.json`（带 5s `mtime` 缓存，零额外 I/O 开销），支持 `<provider>/<account>` 多账号、多窗口（`5h` / `7d` / `monthly`）与专属模型窗口（`opus` / `sonnet` / `gemini-weekly` / `3p-weekly`）。
- **安全水位硬门禁（Safety Margin & Short-Window Floor）**：
  - 当某个订阅窗口剩余配额低于安全底线（默认长窗口 `safety_margin_pct = 5%`、短窗口 `short_window_floor_pct = 10%`）或已触发 `rate_limited` 时，自动剔除该候选，切换到配额健康的 Provider。
  - 若当前粘性会话所在 Provider 耗尽配额，即使 KV 缓存仍温热也会立即触发 `why: "quota_exhausted"`（对齐 Magpie `affinity.go` 的 `spent`），无缝故障转移至有余量的订阅。
- **正态需求预测与边际短缺机会成本（`demandForecast` & `computeWindowCost`）**：
  - 根据窗口剩余百分比 `remaining`、距重置小时数 `reset_hours` 与消耗速率预测未来需求 $D \sim \mathcal{N}(\mu, \sigma^2)$，计算本次请求挤占未来高优工作的期望短缺量 $\mathbb{E}[(D - \text{remaining})^+] \times \text{capacity\_usd} \times \text{score\_per\_displaced\_usd}$，并在余量低于 `45%` 时叠加稀缺惩罚（`scarcity_cost`），在额度见底前主动分流。
- **重置前临期余量冲刺（Pre-Reset Surplus Sprint：`reset_bonus` & `sprint_sunk`）**：
  - 当订阅窗口进入重置倒计时（默认 `reset_horizon_hours = 36h` 内）且剩余额度高于重置前预测需求（`surplus_pct > 0`）时，自动赋予最高 `+1.2` 的 `reset_bonus` 奖励，并在非日常任务上按 `sprint_sunk` 比例豁免高思考档位惩罚（`effort_penalty`）与高配模型惩罚（`overqualification`），在额度过期作废前自动切给顶配模型并解锁 `xhigh` / `max` 深度思考！
- **订阅优先于按量 API Key & 账号池排序策略（`strategies.agentcompass`）**：
  - 在同池多账号排序（`routings: agentcompass/agentcompass`）中，综合 `Seat` 的 `learns`、`account`（订阅优先于按量付费钱包）、`used`、`soon`（重置时间戳）与 `pace`（每小时可用余量），按 `待探测新号 (learns) -> 临期富余冲刺号 (sprint) -> 低机会成本健康订阅 -> 按量 API Key -> 低余量储备号 (>=90%) -> 冷却/耗尽号` 返回最优槽位排列 `[0 .. seats.length - 1]`。

---

## 📦 安装与接入指南

### 1. 获取插件

```bash
git clone https://github.com/akiiwa-games/magpie-agentcompass-router.git
cd magpie-agentcompass-router
```

将插件添加到 Magpie 并启用 `agentcompass`：

```bash
magpie plugin add /path/to/magpie-agentcompass-router
magpie plugin login agentcompass
magpie plugin list
```

或在 `~/.magpie/plugins/` 创建软链接：

```bash
# Linux / macOS
ln -s "$(pwd)" ~/.magpie/plugins/agentcompass

# Windows (PowerShell)
New-Item -ItemType SymbolicLink -Path "$HOME\.magpie\plugins\agentcompass" -Target (Get-Location).Path
```

---

### 2. 配置方式一（推荐）：模式 A —— 两阶段接力直改 `<model>:<effort>`（10s 时间预算）

在模式 A 下，客户端只需发送虚拟模型名（如 `model: "auto"`、`model: "agentcompass"`，或开启 `routeAllModels: true` 拦截全部请求），插件就会在网关层自动计算最佳 `<model>:<effort>` 并转发给对应上游。

通过 `magpie plugin options` 或在 `~/.magpie/config.json` 中设置：

```json
{
  "plugins": {
    "agentcompass": {
      "gatewayTimeoutMs": 8000,
      "routeModelTriggers": ["auto", "agentcompass", "compass", "smart", "default"],
      "routeAllModels": false,
      "allowedModels": [
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
        "gpt-6-astra",
        "gpt-6.1-sol",
        "gpt-6.1-terra",
        "gpt-6-luna",
        "gemini-4-argon-high",
        "gemini-3.8-flash-high"
      ],
      "modelMap": {
        "claude-opus-5-5": "claude-opus-4-6",
        "claude-sonnet-5-5": "claude-sonnet-4-6",
        "claude-haiku-5-5": "claude-haiku-4-5"
      },
      "scorer": {
        "kind": "openai_compatible",
        "baseUrl": "http://127.0.0.1:3000/v1",
        "apiKey": "your-key-or-magpie-local-token",
        "model": "gpt-5.4-nano",
        "timeoutMs": 6500
      }
    }
  }
}
```

> **提示**：
> - 如果不配置外部 `scorer.baseUrl`，插件会默认使用 `< 1 ms` 零延迟的确定性 10 维启发式画像器（`kind: "heuristic"`），同样运行完整的 10D × (7D+3D) 选模算法。
> - 如果将 `scorer.baseUrl` 指向 Magpie 自身（如 `http://127.0.0.1:3000/v1`），插件会自动附带 `User-Agent: Magpie-Router/1.0` 请求头，触发 Magpie `rules.go:196` 的内置防递归保护，绝不会产生死循环！
> - `modelMap` 可将 AgentCompass 标准模型 ID 映射为你 Magpie 网关里实际配置的模型 ID。

---

### 3. 配置方式二：模式 B —— 作为 Magpie Routing Group 原生 Classifier（最高 60s 时间预算）

如果你喜欢使用 Magpie UI 的 **Routing Groups（路由组）** 可视化界面：

1. 在 Magpie 中登录启用本插件提供的 Provider：`magpie plugin login agentcompass`（显示名称为 `AgentCompass`）；
2. 进入你的 **Routing Group** 设置，将 **Classifier（分类器模型）** 选择为 `agentcompass/agentcompass-systemone`（CLI：`magpie group set <group> effort=auto classifier=agentcompass/agentcompass-systemone`）；
3. 在 Magpie 全局设置中，可将 `ClassifyTimeout` 调整为 `8000`–`30000` ms（最高支持 `60000` ms）；
4. 在 Routing Group 中按标准类别（如 `direction_reasoning`、`debug_review`、`self_contained_code`、`bounded_bulk_work`）配置你的目标模型列表——插件会自动运行 AgentCompass 算法，选出最匹配的规则分支与思考档位（`low` / `medium` / `high` / `xhigh`）。

---

## 🧪 运行测试与 Linux 沙盒真实网关实测报告（Real Linux Sandbox E2E Verification）

### 1. 单元测试（Node.js / Bun 零依赖）

覆盖多协议解析、10 维画像推断、能力向量选型、两阶段 `hooks -> middleware` 接力及 `/v1/systemone` 协议兼容：

```bash
node --test test/router.test.mjs
```

### 2. Linux 沙盒真实网关实测（Real Linux Sandbox E2E Verification）

我们在隔离的 Linux x86_64 沙盒环境（WSL2 Linux `6.18.40.1-microsoft-standard-WSL2 x86_64` `/run/magpie-sandbox` tmpfs）中，使用真实编译的 Linux `magpie` 二进制守护进程（`magpie serve`）+ Linux `bun` v1.4.2 插件宿主 + 嵌入式 `moejs` 引擎完成了全链路端到端实测（脚本见 [`test/run-linux-sandbox.sh`](./test/run-linux-sandbox.sh) 与 [`test/linux-sandbox-e2e.mjs`](./test/linux-sandbox-e2e.mjs)，完整 JSON 报告见 [`docs/linux-sandbox-e2e-report.json`](./docs/linux-sandbox-e2e-report.json)）。

#### 插件挂载与 `magpie plugin list` 实测输出

```text
/run/magpie-sandbox/agentcompass  on
  async gateway hook  onRequest
  gateway middleware  onRequest, onAccount, onResponse · routings agentcompass/agentcompass, agentcompass/agentcompass-pure · onUsage
  agentcompass (AgentCompass, 1 models)  signed in
```

#### 8 大场景全链路真实网关与插件市场端到端（E2E）验证结果

| 场景 | 验证链路与协议 | 实测路由与市场合约结果 | 关键不变量验证 | 状态 |
| :--- | :--- | :--- | :--- | :--- |
| **Scenario 1: CLI 插件生命周期与元数据契约** | `magpie plugin add` · `magpie plugin login agentcompass` · `magpie plugin list` | `agentcompass (AgentCompass, 1 models) signed in` · `routings agentcompass/agentcompass, agentcompass/agentcompass-pure` | `magpie.name = "AgentCompass"` 与 `magpie.icon` (`data:image/svg+xml;base64,...`) 校验通过 | ✅ PASS |
| **Scenario 2: 插件市场 (`registry.json`) 与 Web/GUI 管理 API** | `magpie web` · `GET /api/plugins/listings` · `GET /api/plugins` · `GET /api/plugins/page` · `POST /api/plugins/off` & `options` | 市场解析 `package: "agentcompass"`；图标落盘为 `file:a100c6af45032ded.svg`；README 渲染 `16,299 B`；`Off: true` 时请求保持原模型 `gpt-6-luna` 不改写 | 完整覆盖 `internal/plugin/market.go`、`github.go` 与 `internal/gui/plugins.go` | ✅ PASS |
| **Scenario 3: 1,600 ms 异步 System-One 长预算 + 复杂跨模块死锁排障** | **Mode A** (`hooks.js` [Bun] $\rightarrow$ `middleware.js` [`moejs`]) · `/v1/chat/completions` · `model="auto"` | `claude-opus-5-5` : `max` | 异步分类器耗时 `1730 ms`（突破 20ms/250ms/1200ms 限制），`__agentcompass_route` 载体被剥离，反递归头 `Magpie-Router/1.0` 生效 | ✅ PASS |
| **Scenario 4: 5 维 Model DNA 区分度（发散创意 vs 独立模块编码 vs 日常批量降级）** | **Mode A** · `/v1/chat/completions` & `/v1/responses` | 发散脑暴 $\rightarrow$ `gemini-4-argon-high:high`<br/>独立模块 (`/v1/responses`) $\rightarrow$ `gpt-6.1-sol:high`<br/>机械批量重命名 $\rightarrow$ `gemini-3.8-flash-high:high` | `divergence`、`module_precision` 与 `overqualification` 过配惩罚同时生效 | ✅ PASS |
| **Scenario 5: Anthropic `/v1/messages` 协议与 SSE 流式 (`stream: true`)** | **Mode A** · `POST /v1/messages` & `POST /v1/chat/completions` (`stream: true`) | `/v1/messages` $\rightarrow$ `claude-opus-5-5` (`type="message"`)<br/>SSE `stream: true` $\rightarrow$ `gpt-6.1-sol:high` (`text/event-stream` + `[DONE]`) | 流式请求与 Anthropic 协议均正常路由且不触发 `host.js:1411` 字段回滚 | ✅ PASS |
| **Scenario 6: 故障演练与优雅降级（HTTP 500 & 评分超时）** | **Mode A** · 远程评分器注入 `HTTP 500` 与 `2000ms > 300ms` 超时 | `HTTP 500` $\rightarrow$ `claude-opus-5-5`<br/>`Timeout (368ms)` $\rightarrow$ `gemini-4-argon-high` | 远程 System-One 异常或超时时自动无缝回退至 `<1ms` 本地确定性 `profileTask`，网关请求零报错 | ✅ PASS |
| **Scenario 7: 原生路由组 `/v1/systemone` 决策（含规则命中、`"none of these"` 兜底与 `effort=auto`）** | **Mode B** (`group/compass-group` · `classifier=agentcompass/agentcompass-systemone` · `effort=auto`) | `direction_reasoning` $\rightarrow$ `gemini-4-argon-high:high`<br/>`debug_review` $\rightarrow$ `claude-opus-5-5:xhigh`<br/>未命中意图 (`"none of these"`) $\rightarrow$ 默认首模型 `gpt-6-luna` | 完整验证 `jevLevelled`、`jevBody`、`"none of these"` 兜底回退及 Jev 四档思考强度自动升级 | ✅ PASS |
| **Scenario 8: 多轮会话粘性、轮内工具锁定 (`within: true`) 与短追问续用 (`keepsEffort`)** | **Mode A** · 同一 `x-session-id` 连续 3 轮：首轮死锁排障 $\rightarrow$ 轮内 `tool` + `<system-reminder>` $\rightarrow$ 短追问 `"继续"` | 首轮 $\rightarrow$ `claude-opus-5-5:max`（调用 1 次评分器）<br/>轮内工具循环 $\rightarrow$ `claude-opus-5-5:max`（**0 次评分调用**）<br/>短追问 `"继续"` $\rightarrow$ `claude-opus-5-5:max`（**0 次评分调用**） | 严格验证轮内锁定（`why: "turn"`）、短追问续用（`why: "followup"`）与 `keepsEffort` 单调棘轮 | ✅ PASS |

---

## 📂 仓库目录结构

- [`package.json`](./package.json) — Magpie 插件清单（同时挂载 `main`、`magpie.hooks`、`magpie.middleware`、`./continuity`）
- [`src/catalog.js`](./src/catalog.js) — 16 类 `work_kind`、13 个核心模型 7D 能力向量 + 3D 主观禀赋（Model DNA）+ `context_window`、Effort 投入曲线与默认策略
- [`src/continuity.js`](./src/continuity.js) — **会话粘性、轮内工具循环锁定（`within`）、KV 缓存温度保持（`cacheCold` / `chatGPTCold` / `deepseekCold`）、单调思考棘轮（`keepsEffort`）与能力/窗口/2M 越界判定引擎**（纯 ES2022，兼容 Bun 与 `moejs`）
- [`src/profiler-core.js`](./src/profiler-core.js) — 四大协议（Anthropic / OpenAI Responses / Chat / Gemini）请求抽取器 + 确定性 10 维任务画像器
- [`src/allocator.js`](./src/allocator.js) — AgentCompass 纯意图与能力矩阵选型核心算法实现（含 `continuity` 连续性权重与不健康模型剔除）
- [`src/scorer-live.js`](./src/scorer-live.js) — 异步 System-One 10 维画像器（支持 Jev `/v1/systemone`、OpenAI 兼容接口、LRU 缓存与超时无损降级）
- [`src/hooks.js`](./src/hooks.js) — **阶段一（Bun `magpie.hooks`，最长 10s 预算）**：先执行 `evaluateProviderContinuation`，仅在需要选模/换模时调用异步 10D 画像与选型，注入 `body.__agentcompass_route`
- [`src/middleware.js`](./src/middleware.js) — **阶段二（`moejs` `magpie.middleware`，250ms 预算）**：消费路由结果并改写 `body.model = "<model>:<effort>"`，实现 `onResponse` / `onUsage` 故障与缓存水位追踪，并导出 `agentcompass` / `agentcompass-pure` 账号池策略
- [`src/index.js`](./src/index.js) — **模式 B（OpenCode / Magpie Decision Provider，最高 60s 预算）**：注册 `agentcompass/agentcompass-systemone`，实现 `/v1/systemone`（兼容 `jevLevelled`、`jevBody` 与 `previous_message_kind` / `previous_message_reasoning` 短追问续用）
- [`docs/RESEARCH_AND_SCHEME.md`](./docs/RESEARCH_AND_SCHEME.md) — **深度调研与架构设计报告**（含 Magpie 源码逐文件行号级分析、完整方案推导与 Linux 沙盒实测报告）
- [`docs/magpie-community-registry-entry.json`](./docs/magpie-community-registry-entry.json) — **`magpie-community/plugins` 标准 `registry.json` 市场条目**
- [`docs/linux-sandbox-e2e-report.json`](./docs/linux-sandbox-e2e-report.json) — **Linux 沙盒 8 大场景全链路真实网关与市场 E2E 实测 JSON 报告**
- [`test/router.test.mjs`](./test/router.test.mjs) — 自动化单元测试套件
- [`test/linux-sandbox-e2e.mjs`](./test/linux-sandbox-e2e.mjs) & [`test/run-linux-sandbox.sh`](./test/run-linux-sandbox.sh) — Linux 沙盒真实 `magpie serve` 全链路端到端验证套件

---

## 📖 相关项目

- **[AgentCompass 本体 (`akiiwa-games/AgentCompass`)](https://github.com/akiiwa-games/AgentCompass)** — 跨宿主多 Agent 意图路由、5h/7d 订阅配额精算与防失忆交接系统（支持与 Magpie、Cindy、Paseo 协同工作）
- **[Magpie (`yetone/magpie`)](https://github.com/yetone/magpie)** — 本地 AI 网关与多订阅代理工具
- **[Cindy (`yetone/cindy`)](https://github.com/yetone/cindy)** — 状态栏 AI 订阅配额实时监控工具
