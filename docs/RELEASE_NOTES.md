# 发布说明

## 移除内置的文本分类：自动路由需要分类模型

插件不再用正则、词表或消息长度猜任务类型。任务画像只来自分类模型或调用方传入的 `body.profile`。

**升级影响**：Mode A（中间件）访问不了分类模型，所以靠 `agentcompass/auto` 或 `routeAllModels` 走 Mode A 自动路由的用户，如果客户端不传 `body.profile`，请求会变成未路由，响应和日志里带 `未路由：分类不可用`。如果也没配 `defaultModel`，`agentcompass/auto` 这个名字没有对应的模型，通常得到 404。

**处理办法**（任选其一）：

- 改用 Mode B（`/v1/systemone` 路由组）并配分类模型：`allowExternalScorer: true` 加 `scorerBaseUrl`、`scorerCommand` 或 `scorer`。只配分类模型、继续走 Mode A 不会恢复路由。
- 客户端每次请求都传 `body.profile`。
- 只想要一个固定回退时配 `defaultModel`，这时请求不做路由。

直接请求具体模型的用户不受影响。各入口的行为见 README 的 `Without a classifier` / `没有分类模型时`。

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
| `model_unhealthy` | `model_unhealthy: pinned model <名字> is marked unhealthy` | 点名的模型不健康（旗舰，或点名的 family 名字） |
| `model_unhealthy` | `model_unhealthy: the model of pinned bundle <名字> is marked unhealthy` | 点名的 bundle 所用的模型不健康 |
| `pin_unavailable` | `pin_unavailable: pinned model <名字> cannot serve this request` | 点名的模型因其他原因不可用，例如档位不提供、能力不够 |
| `invalid_caller_profile` | `invalid_caller_profile: the task profile is invalid` | 调用方给的任务画像不合法 |
| 其他错误码 | `<错误码>: this request could not be routed` | 其他阻断，例如 `classifier_invalid_output` |

其他原因码里，点名也可以是 `pinned bundle <名字>` 或 `pinned effort <档位>`。健康状态属于模型，所以只点名档位时不会出现 `model_unhealthy`，而是 `pin_unavailable`。

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
- `effort_gone` 之后的重新路由沿用会话原来的任务画像，不按本轮文字（例如"继续"）重新判断，所以不会落回刚被拒绝的那一行。hooks 路径这时不调用分类器。这次路由的 `warnings` 带 `<模型>: effort <档位> is no longer offered; routed again`，选不出时这条写本地日志。
- 上面的降档只在会话状态跨候选池保留时发生，例如通过 `continuityStore` 选项共享存储。在真实的 Magpie 宿主里改配置会重载运行时、清空存储，会话按新候选池从历史重放，所以结果和新路由相同：能选就按新路由选，选不出就返回 503，不会有"已降档"的警告。重放不经过 `effort_gone`：如果第一轮重放被拒，会话状态是空的，这一轮的文字（例如"继续"）会按新任务单独路由，可能选中第一轮被拒的档位。
- 点名了裸模型名表外的档位（例如候选池 `grok-4.7`、点名 `grok-4.7:medium`）时，新路由接受这个档位，保持也接受，不会每轮重新路由。
- 保持期间换点名立即生效，`gpt-6-astra-medium`、`gpt-6-astra:medium`、`claude-opus-9` 这些写法都按解析后的结果比较。

### `/v1/systemone` 默认不返回明细

开了 `enableDecisionProvider` 之后，`/v1/systemone` 是网关的公开路由，所有不限模型的网关 key 都能调用，所以这个回答默认只留路由结论：

| 情况 | `agentcompass` 字段 |
|---|---|
| 选出模型 | `{ targetModel, targetEffort }` |
| 选不出 | `{ targetModel: null, blocked: true, error, message }` |

- 以前回答里的账号标识、配额、候选池名、健康状态、能力值、任务画像、`warnings` 现在默认都没有。`warnings` 写本地日志。成功回答里去掉的账号和配额不写日志；选不出时 `warnings` 可能带账号和配额，把日志发给别人之前要注意。
- 带点名的拒绝统一成 `pin_unavailable`，文案不带名字，调用方不能借此探测某个名字是否在候选池里、是否健康。这和 middleware 的 503 不同，那边的 503 带原因码和点名的名字。
- Magpie 只读 `model`、`answers`、`usage`，路由不受影响。如果运营者确实需要明细，比如自己的工具要读，就显式设置 `"decisionProviderDetails": true`（默认关闭，只认 `true`），回答恢复之前的字段，blocked 回答另外多一个 `refusal`。打开后，能调这个接口的 key 都能读到明细。

### 禁用某个档位

要禁用一个模型的某个档位，在候选池里加一行同模型的 `disabled: true`，和裸名或 `efforts[]` 行放在一起：

```json
["gpt-6.1-sol", { "model": "gpt-6.1-sol", "effort": "medium", "disabled": true }]
```

- 这一档不再被任何同账户、同模型的行派发。这个修复之前，裸名或 `efforts[]` 行展开出来的这一档仍可能被选中。
- 点名这一档时返回 503（`pin_unavailable`），和 AgentCompass 相同。
- 会话停在这一档时会离开它。
- provider 自己的模型表（`modelsByProvider`）不用抄这一行，`onProvider` 重新路由时同样排除这一档。`/v1/systemone` 的短跟进在这一档被禁用时不走快路径，这一轮会调用分类器。
- 只对这一个模型生效。family 行是另一个模型：禁用 `claude-opus-5-5` 的 high 不影响 `claude-opus-9`，反过来也一样。
- 禁用行带 `account` 时只对该账户生效，其他账户和不带账户的裸名不受影响。
- 手写了 `disabled_by_default` 的行也一样：点名能用它，但用不了被禁用的档位。

### 模型健康状态

- 名字有自己的条目或别名时，失败记在解析后的条目下，任何写法都会让这一行下线。
- family 名字的失败只记在原名下。`gpt-6.2-sol-preview` 一次 502 不再让 `gpt-6.1-sol` 下线；反过来，不点名时，`gpt-6.1-sol` 不健康也不再排除 `gpt-6.2-sol-preview`。代价是上游整体故障时，返回 503 之前多几次失败请求，上限是池里的名字数。
- 点名有自己条目或别名的模型时，只匹配这个模型的行。family 行是另一个模型，不算匹配，不能顶替点名被选，健康与否都一样。所以点名 `claude-opus-5-5` 时总是选它自己；它不健康时返回 503（`model_unhealthy`）；候选池里只有 `claude-opus-9` 时返回 503（`pin_not_in_pool`）。以前 family 行分数更高时可能被选中。停在 family 行上的会话收到点名后会离开它。点名 family 名字本身时，只看这个名字的健康状态。

### 其他行为变化

- 整个对话没有用户文字时（例如第一轮只发图片），只要有候选池或点名也照常路由（middleware 和 hooks 相同），所以禁用的档位、点名和不健康拒绝都生效。以前这种请求不路由：虚拟名默认返回 404，配了 `routeModelTriggers`、Routing Group 或 `routeAllModels` 时按原模型和默认的 `high` 或客户端自带的档位发出。现在虚拟名加无文字请求按候选池正常路由，候选池里的未知模型名选不出时返回 503。既没有候选池也没有点名时不变。
- 候选名上的 `:auto`、`:off`、`:default` 不约束档位，路由时会去掉；`-off` 不是档位后缀（`gpt-6.1-sol-off` 按 family 处理）。
- 点名时不一样：`:default` 算一个具体档位，点名 `gpt-6.1-sol:default` 找不到对应的行，返回 503（`pin_unavailable`），和 AgentCompass 相同。
- 任务级 `multi_task`、`task_count` 的值原样校验。`multi_task:"false"`、`task_count:0` 这类值返回 `invalid_caller_profile`。
- 不归本插件路由的请求也会去掉点名字段，不传给上游。
- 保持的轮次带上候选池里那一行的 `modeId`、`draws`。
- `when` 规则排除的行会写进 `warnings` 和 `excluded`，并给出原因。
- `onProvider` 不能拒绝请求：Magpie 在这个阶段不理会 `ctx.reject`。provider 的模型表提供不了路由结果、且表内也选不出模型时，只告警，然后照发，由上游报错和网关的转试处理。
- 分数按 Python 的方式取整（`0.7625` → `0.762`，恰好居中时取偶数），和 AgentCompass 保持一致。

### 已知限制

- `useColonEffort: false` 时，`onProvider` 选中的模型不在宿主选的模型上生效：宿主只认自己选的模型，档位却用 `onProvider` 选的。如果 `modelsByProvider` 的列表里没有宿主选的模型，可能发出该模型已禁用的档位。默认的冒号写法不受影响。
- `modelsByProvider` 在真实网关（v0.1.3196）里改不了模型，默认写法下连档位也改不了。这是宿主行为，上一条的根因也在这里。
- `/v1/systemone`：上一轮是 `max`、`xhigh` 被禁用、`criteria` 里没有 `max` 时，回答映射成 `xhigh`。
- 带 `account` 的禁用行只对该账户生效。`useColonEffort: false` 且 `modelsByProvider` 是裸名列表时，这一档仍可能发出。这符合上面的规则，配置时留意。
