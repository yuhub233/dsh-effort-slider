# TURBO 契约：ULTRA 档位 + 闪电控件 + 舰队 tok/s

> 本文件是**并行开发的接口冻结单**。多个子代理同时改不同文件，一切以本文件为准。
> 变更必须改本文件并在下方"变更记录"留一行，不允许各自解释。

## 1. 锁定的产品决策（用户已拍板）

| 项 | 决定 |
|---|---|
| ULTRA 形态 | **滑条第 6 格**（在 MAX 右侧），不是独立开关 |
| ULTRA 语义 | 顶格真实 effort + 注入 **rigor 策略**（英文提示词）。它**不能**让模型比顶格更用力 |
| 闪电控件 | 独立开关，**默认关**。开启 = 注入**编排策略**（英文提示词） |
| 提示词语言 | **英文** |
| tok/s 显示 | **整数大数字，禁止 k/M 缩写**（`12,840 tok/s`，不是 `12.8k`） |
| 注入机制 | `agent/pre-step` waterfall，**按 session id 精确过滤** + **文本变了才注入**（见 §9 实证） |
| 提示词可见性 | 后台注入 + 界面 **policy chip** 可展开读原文 |
| 复用 | 策略文本 **组合自现成轮子**（见 §7），不重新发明 |

## 2. 档位模型

```
levels = <模型目录里真实可用的 effort 列表>  +  [{ id: "ultra", label: "ULTRA", ultra: true }]
pct    = index / (levels.length - 1)
```

- `isMax`  = `index === 真实 effort 数 - 1` → 流体 **×2 流速 + 星流**（沿用现有行为，**不许改数值**）
- `isUltra`= 最后一格 → **继承 isMax 的全部效果**，并叠加 ULTRA 视觉层
- 根节点属性：`data-ultra="1"`（仅 ULTRA 时）；`data-lightning="1"`（闪电开启时）
- 闪电是**正交**开关：任何档位都能开；开启时 `--es-rate` 由客户端按采样值驱动

## 3. 宿主半边文件与接口

### 3.1 `policy.mjs`（纯模块，无副作用）

```js
export function policyText({ ultra, lightning }) // → string（都不开时返回 ""）
export const ULTRA_POLICY   // string
export const LIGHTNING_POLICY // string
```

### 3.2 `metrics.mjs`（纯模块，可离线单测）

```js
export function createFleetMeter(options = {}) // → meter
// options: { windowMs = 1500, generatingMs = 800, includeCacheReads = false, now = () => Date.now() }
// meter: {
//   setMembers(ids)            // 替换舰队成员集合（本会话的子代理 id）；非成员 chunk 一律忽略
//   ingest(agentId, chunk, atMs) // chunk = StreamChunk 的形状子集（只读这几个字段）
//   sample(): { rate, gen, agents, generating, total }  // 全整数
//   reset()                    // 换会话时清空
//   dispose()                  // 无定时器，仅清引用
// }
```

- `gen`  = 最近 window Ms 内**生成** token 速率（整数 tok/s）
- `rate` = 最近 window Ms 内 **(生成 + 输入)** token 速率（整数 tok/s）—— 头条大数字
- `total`= 累计 token（生成 + 输入）—— 也是大数字；`agents` = 成员数
- token 估算：CJK 码点按 1 token/字，其余按 4 字符/token 向上取整
- 成员来自运行中的 `SessionStore` 和 `session/created` / `session/disposed` 事件；沿 `header.parentSession` 判定归属，只计 `header.origin === "subagent"`（包括 one-shot）。普通 fork 可作为祖先链中间节点，本身不计入。已归档会话不计入成员数，不扫描持久化会话文件。
- 输入 token 取 `usage` 帧：`max(0, inputTokens - cacheReadTokens)`（`includeCacheReads` 可关掉该扣减）
- 累计值取 **每 agent 的 `max(增量估算, Σ usage.outputTokens)`**：实时会长、调用结束被精确值校准
- **无定时器、无 I/O、无全局状态** —— 便于离线测试

### 3.3 `inject.mjs`（已实现）

```js
export function createPolicyInjector(ctx, { log, resolve })
// → { dispose(), lastInjected(sessionId) }
// resolve(sessionId) 返回"本会话当前应当生效的文本"（策略正文 / OFF 提示 / 空串）
// 去重由 inject.mjs 负责：文本与上次注入相同就不注入（§9）
```

### 3.4 路由（扩展已有 `index.mjs`，**不动** `PATCH .../preferences`）

- `GET  /plugins/dsh-effort-slider/turbo?session=<id>` →
  `{ ok, session, lightning, ultra, rate, gen, agents, generating, total, stamp }`
- `PATCH /plugins/dsh-effort-slider/turbo` body `{ session, lightning?, ultra? }` →
  `{ ok, lightning, ultra }`（持久化到 `DSH_HOME/storages/effort-slider.json` 的 `sessions` 字段，原子写）

## 4. DOM / CSS 契约（客户端与 CSS 各改各的文件，靠这张表对齐）

| 选择器 | 角色 |
|---|---|
| `[data-ultra="1"]` / `[data-lightning="1"]` | 根状态 |
| `.es-rail__core` | ULTRA 白炽核心层，绝对定位，默认 `display:none` |
| `.es-knob--ultra` | ULTRA 时的旋钮附加态（细白环 + 呼吸） |
| `.es-panel__level--ultra` | 面板上的 `ULTRA` 标签（字距 0.18em、铂金白、细下划线） |
| `.es-pill__bolt` | 闪电按钮，`data-on="1"` 为通电 |
| `.es-rate` / `.es-rate__num` / `.es-rate__unit` | tok/s 读数；`data-idle="1"` 时整块隐藏 |
| `.es-policy` / `.es-policy__body` | 策略 chip 与展开的原文块 |

- CSS 变量：`--es-rate`（0–1，JS 写入，驱动发光强度）
- **禁止**：`!important`、`:root/html/body` 选择器、改动既有 4 套皮肤的结构性规则、动 `.es-rail__stars`
- 布局稳定：读数为等宽 + `font-variant-numeric: tabular-nums`，数字变化**不得**引起 pill 抖动

## 5. 安全红线

1. **绝不全局注入**：策略文本只能进入被跟踪的那一个 session；子代理、其它会话（如微信会话）一律不受影响。
2. 子代理**不得**继承闪电策略（防递归爆炸）；闪电策略文本自身也要写死"你是子代理就忽略本策略"。
3. 闪电默认关；读数在无数据时显示 0 并隐藏，**绝不允许编造数字**。
4. 任何宿主异常都不得冒泡成插件加载失败（沿用 `index.mjs` 现有 A/B/C/D 原则）。

## 6. 验证计划

- `node build.mjs`（我用；CSS → `lib/client.js` 字节一致断言）
- 既有：`test/fluid.test.mjs`（119 检查）、`test/smoke-test.mjs`、`<local-workspace>/_acceptance.mjs`
- 新增：`test/metrics.test.mjs`（离线）、注入探针实测、客户端 CDP 截图目视（我看图）
- 预览站 `<local-workspace>/effort-slider-preview\index.html` 需同步（最后做，避免中间态）

## 7. 复用的"轮子"（不重新造）

| 来源 | 用途 | 形态 |
|---|---|---|
| [obra/superpowers](https://github.com/obra/superpowers)（MIT）`dispatching-parallel-agents` / `subagent-driven-development` | 闪电：派活与集成纪律 | 策略文本依据（**不 vendor**：DSH 上不保证存在，策略里写明"没有就跳过"） |
| [obra/superpowers](https://github.com/obra/superpowers)（MIT）`verification-before-completion` / `systematic-debugging` | Ultra：证据与根因纪律 | 同上 |
| [Anthropic：How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)（2025-06-13） | 委派契约、规模阶梯、×15 token 事实、产物写文件回传指针 | 策略文本依据 |
| 社区对 Claude Code 档位设置的整理（ClaudeWorld S26/S28 等） | effort vs orchestration 正交、7 个质量模式与反模式 | 策略文本骨架 |
| [Feather Icons](https://github.com/feathericons/feather) `zap`（MIT） | 闪电按钮 SVG 路径 | 复制了一行路径字符串 |
| 本机 gpt-6-astra 通道（`subagent_gpt6`） | 卡点时的第二意见 | 策略第 8 条：**只在卡点问一次，短问短答**；Astra 不吃长输入/不长输出；没有 Astra 就忽略该条（**不引用** dual-plan-fusion 的长背景包 SOP） |

> 逐条许可与"是否随仓库分发"另见 [`THIRD-PARTY.md`](THIRD-PARTY.md)。

## 8. 变更记录

- 初版：锁定 §1 决策，冻结 §3/§4 接口。
- 补 §9：asar 源码核对结果（注入会落盘、每个 step 都会 append、变了才注入）；
  §3.3 的 injector 签名按实证改写。
- 2026-10-02：成员统计改用有界内存索引和生命周期事件，取消每两秒的持久化后代扫描；客户端补齐 remote 依赖，并清理切换 / 卸载后的查询、轮询与目录订阅。

## 9. 实证：注入到底发生了什么（app.asar 源码核对）

四条硬事实（都有源码行号，来自 `<local-workspace>/_probe-extract\`）：

| # | 事实 | 证据 |
|---|---|---|
| 1 | `decision.messages` **会落盘**，事件类型是 **`user/message`** | `dsh-agent-loop/lib/index.js:1028` |
| 2 | **每个 step 都 append 一次**（`firstAttempt` 是 `step()` 的局部变量，只防单步内的 provider 重试） | 同上 `:1015 / :1028 / :1029` |
| 3 | `agent/pre-step` **每个 step 都触发**，续跑 step 里 `messages` 通常是 `[]` | `:934-957`、`inbox.claim` `:104-112` |
| 4 | 引擎自己的解法是 **"文本没变就不注入"**（`RuntimeContextProjection.project` 的 `retained` 比对） | `:330-355`、`:894-901` |

⇒ **`inject.mjs` 采用 #4 的同款纪律**：策略文本只在"应当生效的文本发生变化"时进历史，
所以既不会每步堆一条，也不会因为"用户没说话"而漏注入。

**会话恢复期的 4 条硬约束**（违反不会即时报错，而是下次恢复会话时报
`SessionPersistenceCorruptionError`，所以一条都不能错）：

1. `id` 是非空字符串；2. `role === "user"`；3. `source.kind` 是**生产者自有的非空字符串**
（形如 `plugin:dsh-effort-slider`，禁止裸 `kind:"plugin"` + `plugin` 对——DSH 会话格式 v4
已把该旧形式退休，落盘准入会直接抛 `format v4 message requires a producer-owned source kind`，
导致整个回合失败）；4. `content` 是数组。

`form: "instructions"` 按框架约定带上（不被运行时校验）；`source.plugin` **已移除**。

**已知的可见性后果**：注入的文本会作为 `source.kind='plugin:dsh-effort-slider'` 的 user 消息进入会话日志
（DSH 自己的运行时上下文、`@pluginId` 参考上下文走的是同一条路），因此**在会话记录里可见**——
这正好与"策略 chip 可读原文"的透明性目标一致，但不要再把它描述成"完全不可见"。
