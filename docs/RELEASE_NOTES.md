# 发布说明

## 路由与 AgentCompass 对齐（三仓契约 R1–R6）

### 候选池里的旧模型名：去掉别名后的影响

Magpie 之前有一批自有别名，例如 `gpt-5.4` 指向当时的旗舰。这些名字不在 AgentCompass 的 `accounts.json` 里，所以别名去掉了，共影响 **57 个名字**（下表列全）。还在用这些名字的配置不会报配置错误，但路由结果会变：

- 打分下降，例如 `gpt-5.4` 以前按旗舰打分，现在按通用行（tier 2.8）。任务难度高于它们的能力时，这个候选池**选不出模型**。
- `node test/nonrealtime-change-report.mjs` 按 20 个候选池 × 176 个画像（3520 行）对比 ab8baba：候选池含这些名字的有 752 行结果变了，其中 512 行现在选不出模型。
- **处理办法**：按表换成"建议改用"的名字。

现在的提示：

- 路由结果的 `warnings` 里每次都带 `candidate name <名字> is not in the catalog: ...; use <替代名>`，日志里同一个名字每个进程只打一次。
- 选不出模型时返回 503，文案带模型名和原因，例如 `no candidate is available: gpt-5.4@low: ability 2.26 below the coupled floor 3.60; ...`，后面跟上面那条名字提示。
- 点名的模型不在候选池里时也是 503：`pinned model <名字> is not among the candidates`。

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

- 保持前先看当前候选池是否还提供这个档位（`model:effort`、`efforts[]`、provider 表都算）。不提供时降到可用的最高档并加警告；没有更低的档位，或者用户点名了档位，就结束保持，`why` 为 `effort_gone`，重新路由。
- 保持期间换点名立即生效，`gpt-6-astra-medium`、`gpt-6-astra:medium`、`claude-opus-9` 这些写法都按解析后的结果比较。

### 模型健康状态

- 名字有自己的条目或别名时，失败记在解析后的条目下，任何写法都会让这一行下线。
- family 名字的失败只记在原名下。`gpt-6.2-sol-preview` 一次 502 不再让 `gpt-6.1-sol` 下线；反过来，`gpt-6.1-sol` 不健康时也不再排除 `gpt-6.2-sol-preview`。

### 其他行为变化

- `:auto`、`:off`、`:default` 不约束档位，路由时会去掉；`-off` 不是档位后缀（`gpt-6.1-sol-off` 按 family 处理）。
- 任务级 `multi_task`、`task_count` 的值原样校验。`multi_task:"false"`、`task_count:0` 这类值返回 `invalid_caller_profile`。
- 不归本插件路由的请求也会去掉点名字段，不传给上游。
- 保持的轮次带上候选池里那一行的 `modeId`、`draws`。
- `when` 规则排除的行会写进 `warnings` 和 `excluded`，并给出原因。
- provider 的模型表提供不了路由结果，且在这张表内也选不出模型时，`onProvider` 调用 `ctx.reject(503)`，文案带 provider 和原因。Magpie 是否会因此转试下一个 provider，取决于网关对 `reject` 的实现，这里没有验证。
- 分数按 Python 的方式取整（`0.7625` → `0.762`，恰好居中时取偶数），和 AgentCompass 保持一致。
