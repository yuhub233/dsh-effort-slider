/**
 * inject.mjs —— 把 ULTRA / LIGHTNING 的策略文本注入到**指定会话**的模型请求里。
 *
 * 机制不是我们发明的：DSH 内置插件就是这么做的（源码已从 app.asar 里核对过）：
 *
 *   1. `tool-cordis.js` 注入 `@pluginId` 参考上下文：
 *        ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
 *          const decision = await next();
 *          if (decision.kind === "reject") return decision;
 *          return { ...decision, messages: [...decision.messages, ...contexts] };
 *        });
 *   2. `dsh-agent-loop/lib/index.js:1028` 会把 `decision.messages` 逐条 append 成
 *      **`user/message`** 事件 —— 也就是**会落盘、会进历史**，而且**每个 step 都 append 一次**
 *      （`firstAttempt` 只在单个 step 内部防重试）。
 *   3. 所以"每个 step 都注入"必然让历史里堆满重复条目。引擎自己的解法是
 *      `RuntimeContextProjection.project()` 的 `retained` 比对：**文本没变就不注入**。
 *
 * 本模块采用与引擎同款的三条纪律：
 *   · **变了才注入**：把"上一次注入的文本"按 session 记住，文本相同就原样放行；
 *   · 先 `await next()`，在框架自己的决定之上追加，绝不吞掉别人的决定；
 *   · 注入的是 `source: { kind:"plugin:dsh-effort-slider", form:"instructions" }` 的 user 消息
 *     （v4 会话格式要求生产者自有 kind：禁止裸 `kind:"plugin"` + `plugin` 对，
 *      旧形式会在落盘准入时抛 "format v4 message requires a producer-owned source kind"）。
 *
 * 会话恢复期的硬约束（违反不会有即时报错，而是**下次恢复会话时报损坏**，所以一条都不能错）：
 *   `id` 非空字符串 / `role === "user"` / `source.kind` 非空字符串 / `content` 是数组。
 *
 * 红线：
 *   · **只影响被跟踪的那一个 session**：按 `agent.id` 精确比对。子代理会继承父代理的
 *     作用域，所以"注册到父作用域"是**不行**的，必须按 id 过滤；
 *   · 监听器永远不抛错、永远返回一个合法 decision；任何异常都退化成"什么都不注入"。
 */
import { randomUUID } from "node:crypto";

/**
 * @param {object} ctx      宿主 Cordis 上下文
 * @param {object} options  { log?: (msg:string)=>void, resolve: (sessionId:string)=>string }
 *        `resolve` 返回"本会话当前**应当**生效的文本"：策略正文、或"模式已关闭"的提示、
 *        或空串（表示从未启用过）。**去重由本模块负责**，调用方不需要自己判断"是不是变了"。
 * @returns {{ dispose: () => void, lastInjected: (sessionId: string) => string | undefined }}
 */
export function createPolicyInjector(ctx, options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  const resolve = typeof options.resolve === "function" ? options.resolve : () => "";
  /** sessionId -> 上一次真正注入的文本（引擎 retained 比对的同款做法） */
  const lastInjected = new Map();
  let listenerDisposer = null;
  let disposed = false;

  function instructionMessage(text) {
    return {
      id: randomUUID(),
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "plugin:dsh-effort-slider", form: "instructions" },
    };
  }

  const handler = async (payload, next) => {
    // 1) 先让框架自己算 —— 无论后面做什么，next() 必须被调用
    const decision = typeof next === "function" ? await next() : undefined;
    try {
      if (disposed) return decision;
      if (decision === null || decision === undefined) return decision;
      if (decision.kind !== "enter") return decision;                 // reject / 未知形状一律放行
      if (!Array.isArray(decision.messages)) return decision;
      const sessionId = payload?.agent?.id;
      if (typeof sessionId !== "string" || sessionId.length === 0) return decision;
      const text = resolve(sessionId);
      if (typeof text !== "string" || text.length === 0) return decision;
      if (lastInjected.get(sessionId) === text) return decision;      // 文本没变 → 不重复注入
      lastInjected.set(sessionId, text);
      return { ...decision, messages: [...decision.messages, instructionMessage(text)] };
    } catch (error) {
      // 注入失败绝不能让这一步失败 —— 这是"锦上添花"的能力
      try { log(`策略注入失败（已跳过本步）：${String(error)}`); } catch { /* 连日志都不能抛 */ }
      return decision;
    }
  };

  try {
    const off = ctx.on("agent/pre-step", handler);
    if (typeof off === "function") listenerDisposer = off;
  } catch (error) {
    try { log(`注册 agent/pre-step 失败（策略注入不可用）：${String(error)}`); } catch { /* 忽略 */ }
  }

  return {
    lastInjected: (sessionId) => lastInjected.get(sessionId),
    dispose() {
      disposed = true;
      try { listenerDisposer?.(); } catch { /* 卸载异常不冒泡 */ }
      listenerDisposer = null;
      lastInjected.clear();
    },
  };
}

export default { createPolicyInjector };
