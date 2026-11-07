# 发布说明

## 路由与 AgentCompass 对齐（三仓契约 R1–R6）

### 候选池里的旧模型名：去掉别名后的影响

Magpie 之前有一批自有别名，例如 `gpt-5.4` 指向当时的旗舰。这些名字不在 AgentCompass 的 `accounts.json` 里，所以别名去掉了，共影响 **57 个名字**（下表列全）。还在用这些名字的配置不会报配置错误，但路由结果会变：

- 打分下降，例如 `gpt-5.4` 以前按旗舰打分，现在按通用行（tier 2.8）。任务难度高于它们的能力时，这个候选池**选不出模型**。
- `node test/nonrealtime-change-report.mjs` 按 20 个候选池 × 176 个画像（3520 行）对比 ab8baba：候选池含这些名字的有 752 行结果变了，其中 512 行现在选不出模型。
- **处理办法**：按表换成"建议改用"的名字。

现在的提示：

- 路由结果的 `warnings` 里每次都带 `candidate name <名字> is not in the catalog: ...; use <替代名>`。日志里同一条提示每个运行时只打一次。Magpie 会同时开多个运行时，所以多打几次是正常的。去重最多记 1024 条，超过后最久没出现的那条会被挤掉，之后再出现时会再打一次。
- 选不出模型时返回 503。客户端只看到原因码、点名的模型名和一句说明，看不到候选池和配额。明细只写本地日志，例如 `no candidate is available: gpt-5.4@low: ability 2.26 below the coupled floor 3.60; ...`。
- 日志和 503 里的模型名会转义控制字符，超过 128 个字符的部分截断，单行日志最多 16384 个字符。

| 503 原因码 | 文案（前缀 `agentcompass: `） | 什么时候出现 |
|---|---|---|
| `no_route` | `no_route: no candidate can serve this request` | 没有点名，候选池里选不出模型 |
| `pin_not_in_pool` | `pin_not_in_pool: pinned model <名字> is not among the candidates` | 点名的模型不在候选池里 |
| `model_unhealthy` | `model_unhealthy: pinned model <名字> is marked unhealthy` | 点名的模型不健康 |
| `pin_unavailable` | `pin_unavailable: pinned model <名字> cannot serve this request` | 点名的模型因其他原因不可用，例如档位不提供、能力不够 |
| `invalid_caller_profile` | `invalid_caller_profile: the task profile is invalid` | 调用方给的任务画像不合法 |
| 其他错误码 | `<错误码>: this request could not be routed` | 其他阻断，例如 `classifier_invalid_output` |

点名也可以是 `pinned bundle <名字>` 或 `pinned effort <档位>`，原因码相同。

下面第 3 组仍是目录里的条目，只是能力低，所以不给提示，分数按目录计算。

#### 1. 不在目录里（34 个）：按通用行打分（tier 2.8）

| 名字 | 建议改用 |
|---|---|
| `claude-3-5-haiku` | `claude-haiku-5-5` |
| `claude-3-5-haiku-latest` | `claude-haiku-5-5` |
| `claude-3-haiku` | `claude-haiku-5-5` |
| `claude-3-opus` | `claude-opus-5-5` |
| `claude-3-7-sonnet` | `claude-sonnet-5-5` |
| `claude-3-7-sonnet-latest` | `claude-sonnet-5-5` |
| `claude-3-5-sonnet` | `claude-sonnet-5-5` |
| `claude-3-5-sonnet-latest` | `claude-sonnet-5-5` |
| `gpt-5.5` | `gpt-6-astra` |
| `gpt-5.4` | `gpt-6-astra` |
| `gpt-5` | `gpt-6-astra` |
| `o3` | `gpt-6-astra` |
| `o1` | `gpt-6-astra` |
| `gpt-5.4-mini` | `gpt-6-luna` |
| `gpt-5.4-nano` | `gpt-6-luna` |
| `gpt-5.5-mini` | `gpt-6-luna` |
| `gpt-5.5-nano` | `gpt-6-luna` |
| `gpt-5-mini` | `gpt-6-luna` |
| `gpt-5-nano` | `gpt-6-luna` |
| `gpt-4.1-mini` | `gpt-6-luna` |
| `gpt-4.1-nano` | `gpt-6-luna` |
| `gpt-4o-mini` | `gpt-6-luna` |
| `gpt-5.5-pro` | `gpt-6-pro` |
| `gpt-5.4-pro` | `gpt-6-pro` |
| `o3-pro` | `gpt-6-pro` |
| `o1-pro` | `gpt-6-pro` |
| `gpt-5.3-codex` | `gpt-6.1-sol` |
| `gpt-5.2-codex` | `gpt-6.1-sol` |
| `gpt-5.1-codex` | `gpt-6.1-sol` |
| `gpt-5-codex` | `gpt-6.1-sol` |
| `gpt-4.1` | `gpt-6.1-sol` |
| `gpt-4o` | `gpt-6.1-sol` |
| `o3-mini` | `gpt-6.1-sol` |
| `o4-mini` | `gpt-6.1-sol` |

#### 2. 属于某个 family（20 个）：按目标模型估算，tier 减 0.3，不用目标的努力曲线

| 名字 | 现在估算的目标 | 建议改用 |
|---|---|---|
| `claude-opus-4-5` | `claude-opus-5-5` | `claude-opus-5-5` |
| `claude-opus-4-1` | `claude-opus-5-5` | `claude-opus-5-5` |
| `claude-opus-4` | `claude-opus-5-5` | `claude-opus-5-5` |
| `claude-sonnet-4-5` | `claude-sonnet-5-5` | `claude-sonnet-5-5` |
| `claude-sonnet-4` | `claude-sonnet-5-5` | `claude-sonnet-5-5` |
| `deepseek-r1` | `deepseek-v4-pro` | `deepseek-v4-pro` |
| `deepseek-reasoner` | `deepseek-v4-pro` | `deepseek-v4-pro` |
| `deepseek-v3` | `deepseek-v4-pro` | `deepseek-v4-pro` |
| `deepseek-chat` | `deepseek-v4-pro` | `deepseek-v4.1-flash-free` |
| `deepseek-v4.1-io` | `deepseek-v4-pro` | `deepseek-v4.1-flash-free` |
| `gemini-3-flash` | `gemini-3.8-flash-high` | `gemini-3.8-flash-high` |
| `gemini-2.5-flash` | `gemini-3.8-flash-high` | `gemini-3.8-flash-high` |
| `gemini-2.5-flash-lite` | `gemini-3.8-flash-high` | `gemini-3.8-flash-high` |
| `gemini-2.0-flash` | `gemini-3.8-flash-high` | `gemini-3.8-flash-high` |
| `gemini-2.0-flash-lite` | `gemini-3.8-flash-high` | `gemini-3.8-flash-high` |
| `gemini-3-pro` | `gemini-4-argon-high` | `gemini-4-argon-high` |
| `gemini-2.5-pro` | `gemini-4-argon-high` | `gemini-4-argon-high` |
| `gpt-5.6-sol-mini` | `gpt-5.6-sol` | `gpt-6-luna` |
| `grok-3` | `grok-4.7` | `grok-4.7` |
| `grok-3-mini` | `grok-4.7-build-fast` | `grok-4.7-build-fast` |

#### 3. 目录里仍有自己的条目（3 个）：不再指向新模型

| 名字 | 建议改用 |
|---|---|
| `claude-haiku-4-5` | `claude-haiku-5-5` |
| `claude-opus-4-6` | `claude-opus-5-5` |
| `claude-sonnet-4-6` | `claude-sonnet-5-5` |

例如 `claude-opus-4-6` 以前等同当时的旗舰（tier 4.6），现在按它自己的条目（tier 2.74）打分。

另有 6 个名字（`claude-opus-5-5-low|medium|high`、`claude-sonnet-5-5-low|medium|high`）也不再是 Magpie 的别名，但解析结果不变，不受影响。

### 会话保持

- 保持前先看当前候选池是否还提供这个档位（`model:effort`、`efforts[]`、provider 表都算）。不提供时，降到候选池提供、且新路由也能接受的最高档，并加警告。新路由能否接受看能力下限和实时响应下限。没有这样的档位，或者用户点名了档位，就结束保持，`why` 为 `effort_gone`，重新路由。
- 上面的降档只在会话状态跨候选池保留时发生，例如通过 `continuityStore` 选项共享存储。在真实的 Magpie 宿主里改配置会重载运行时、清空存储，会话按新候选池从历史重放，所以结果和新路由相同：能选就按新路由选，选不出就返回 503，不会有"已降档"的警告。
- 点名了裸模型名表外的档位（例如候选池 `grok-4.7`、点名 `grok-4.7:medium`）时，新路由接受这个档位，保持也接受，不会每轮重新路由。
- 保持期间换点名立即生效，`gpt-6-astra-medium`、`gpt-6-astra:medium`、`claude-opus-9` 这些写法都按解析后的结果比较。

### 模型健康状态

- 名字有自己的条目或别名时，失败记在解析后的条目下，任何写法都会让这一行下线。
- family 名字的失败只记在原名下。`gpt-6.2-sol-preview` 一次 502 不再让 `gpt-6.1-sol` 下线；反过来，不点名时，`gpt-6.1-sol` 不健康也不再排除 `gpt-6.2-sol-preview`。代价是上游整体故障时，返回 503 之前多几次失败请求，上限是池里的名字数。
- 点名的模型有自己的条目或别名且不健康时，它匹配到的所有行都排除，包括 family 行，返回 503（`model_unhealthy`）。已经停在 family 行上的会话也不再保持。点名 family 名字本身时，只看这个名字的健康状态。

### 其他行为变化

- 候选名上的 `:auto`、`:off`、`:default` 不约束档位，路由时会去掉；`-off` 不是档位后缀（`gpt-6.1-sol-off` 按 family 处理）。
- 点名时不一样：`:default` 算一个具体档位，点名 `gpt-6.1-sol:default` 找不到对应的行，返回 503（`pin_unavailable`），和 AgentCompass 相同。
- 任务级 `multi_task`、`task_count` 的值原样校验。`multi_task:"false"`、`task_count:0` 这类值返回 `invalid_caller_profile`。
- 不归本插件路由的请求也会去掉点名字段，不传给上游。
- 保持的轮次带上候选池里那一行的 `modeId`、`draws`。
- `when` 规则排除的行会写进 `warnings` 和 `excluded`，并给出原因。
- `onProvider` 不能拒绝请求：Magpie 在这个阶段不理会 `ctx.reject`。provider 的模型表提供不了路由结果、且表内也选不出模型时，只告警，然后照发，由上游报错和网关的转试处理。
- 分数按 Python 的方式取整（`0.7625` → `0.762`，恰好居中时取偶数），和 AgentCompass 保持一致。
