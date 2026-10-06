/**
 * turbo.test.mjs —— ULTRA / LIGHTNING 宿主半边的离线集成测试（不需要真宿主）。
 *
 * 为什么要有这个文件：宿主半边（策略注入 + /turbo 路由 + 舰队计量）**只有重启 DSH 才会加载**，
 * 而"随便重启"是被禁止的。所以在离线环境下用假 ctx / 假 req-res 把这些逻辑跑一遍，
 * 是这一层唯一能在重启前拿到的可执行证据。
 *
 * 覆盖：
 *   [1] 注入的形状合法（会话恢复期的 4 条硬约束）
 *   [2] 文本没变 → 不重复注入（引擎 RuntimeContextProjection 的同款纪律）
 *   [3] 文本变了 → 再注入一次；关闭模式 → 补一条 OFF 提示
 *   [4] resolve 抛错 / 决策是 reject → 原样放行，绝不抛
 *   [5] PATCH 写入状态并持久化；非法 session id 被拒
 *   [6] 只有被跟踪会话的后代才计入读数；GET 返回整数与大数字口径
 *
 * 运行：`node test/turbo.test.mjs`（cwd 无所谓），全部通过退出码 0。
 */
import assert from "node:assert/strict";
import { createTurbo, OFF_NOTICE, TURBO_ENDPOINT } from "../turbo.mjs";
import { createPolicyInjector } from "../inject.mjs";
import { policyText } from "../policy.mjs";

let checks = 0;
let failures = 0;
function ok(condition, label) {
  checks += 1;
  try {
    assert.ok(condition, label);
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}\n       ${error?.message ?? error}`);
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

/* ── 假宿主 ─────────────────────────────────────────────────────────────── */

function fakeCtx({ descendants = {}, liveSessions = [] } = {}) {
  const listeners = new Map();
  const routes = [];
  const services = new Map();
  const live = new Map(liveSessions.map((session) => [session.id, session]));
  for (const [rootId, children] of Object.entries(descendants)) {
    live.set(rootId, { id: rootId, header: {} });
    for (const id of children) live.set(id, { id, header: { parentSession: rootId, origin: "subagent" } });
  }
  const reads = { lists: 0, descendants: 0, history: 0 };
  let pendingPayload = null;
  services.set("subagents", {
    async listDescendants() {
      reads.descendants += 1;
      throw new Error("持久化后代扫描不能用于实时计量");
    },
  });
  services.set("sessions", {
    list() { reads.lists += 1; return [...live.values()]; },
    get(id) { return live.get(id); },
  });
  services.set("sessionQuery", {
    async listSessions() { reads.history += 1; throw new Error("不能扫描会话历史"); },
  });
  return {
    listeners,
    routes,
    reads,
    emit(name, ...args) {
      for (const handler of [...(listeners.get(name) ?? [])]) handler(...args);
    },
    createSession(session, announce = true) {
      live.set(session.id, session);
      if (announce) this.emit("session/created", session);
    },
    disposeSession(id) {
      const session = live.get(id);
      live.delete(id);
      this.emit("session/disposed", session);
    },
    /** 生产环境由 index.mjs 传进来的 readJson；这里是等价的替身。 */
    readJson: async () => ({ ok: true, value: pendingPayload }),
    setPayload(value) { pendingPayload = value; },
    on(name, fn) {
      const arr = listeners.get(name) ?? [];
      arr.push(fn);
      listeners.set(name, arr);
      return () => {
        const index = arr.indexOf(fn);
        if (index >= 0) arr.splice(index, 1);
      };
    },
    get(name) {
      return services.get(name);
    },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
  };
}

/** 走一次 agent/pre-step（waterfall）：返回插件追加之后的 decision。 */
async function runPreStep(ctx, { agentId = "session-root0001", messages = [], claimed = null } = {}) {
  const handlers = ctx.listeners.get("agent/pre-step") ?? [];
  let decision = null;
  const next = async () => ({ kind: "enter", messages: claimed ?? messages });
  for (const handler of handlers) decision = await handler({ agent: { id: agentId }, messages, turn: 1, step: 1, signal: { throwIfAborted() {} } }, next);
  return decision;
}

function fakeResponse() {
  return {
    headersSent: false,
    status: null,
    body: null,
    writeHead(status) { this.status = status; this.headersSent = true; return this; },
    end(text) { if (text !== undefined) this.body = String(text); return this; },
  };
}

async function callRoute(ctx, path, { method = "GET", session, payload } = {}) {
  const route = ctx.routes.find((item) => item.path === path);
  assert.ok(route, `路由 ${path} 未注册`);
  ctx.setPayload(payload ?? null);
  const request = { method, url: path + (session ? `?session=${encodeURIComponent(session)}` : "") };
  const response = fakeResponse();
  await route.handler(request, response);
  return response;
}

/* ── 1~4：注入器 ────────────────────────────────────────────────────────── */

async function injectionSuite() {
  console.log("\n[1-4] agent/pre-step 注入");
  const SESSION = "session-root0001";

  // [1] 形状合法
  {
    const ctx = fakeCtx();
    let text = "POLICY-A";
    const injector = createPolicyInjector(ctx, { resolve: () => text });
    const decision = await runPreStep(ctx, { messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } }] });
    const injected = decision.messages[decision.messages.length - 1];
    ok(decision.kind === "enter" && decision.messages.length === 2, "[1] 注入后 messages 多了一条");
    ok(typeof injected.id === "string" && injected.id.length > 0, "[1] id 是非空字符串（会话恢复硬约束）");
    ok(injected.role === "user", "[1] role === 'user'");
    ok(injected.source && typeof injected.source.kind === "string" && injected.source.kind.length > 0, "[1] source.kind 非空");
    ok(injected.source.kind === "plugin:dsh-effort-slider" && injected.source.form === "instructions", "[1] source.kind 是 V4 producer kind + form:instructions");
    ok(injected.source.plugin === undefined, "[1] V4 来源不再携带 plugin 属性");
    ok(Array.isArray(injected.content) && injected.content[0].type === "text" && injected.content[0].text === "POLICY-A", "[1] content 是数组且文本正确");

    // [2] 文本没变 → 不再注入
    const again = await runPreStep(ctx, { messages: [{ id: "u2", role: "user", content: [], source: { kind: "user" } }] });
    ok(again.messages.length === 1, "[2] 同一文本第二次不重复注入");

    // [3] 文本变了 → 再注入
    text = "POLICY-B";
    const changed = await runPreStep(ctx, { messages: [{ id: "u3", role: "user", content: [], source: { kind: "user" } }] });
    ok(changed.messages.length === 2 && changed.messages[1].content[0].text === "POLICY-B", "[3] 文本变化后再注入一次");

    // 关闭：resolver 返回 OFF 提示
    text = OFF_NOTICE;
    const offStep = await runPreStep(ctx, { messages: [{ id: "u4", role: "user", content: [], source: { kind: "user" } }] });
    ok(offStep.messages.length === 2 && offStep.messages[1].content[0].text === OFF_NOTICE, "[3] 关闭后补一条 OFF 提示");
    const offAgain = await runPreStep(ctx, { messages: [{ id: "u5", role: "user", content: [], source: { kind: "user" } }] });
    ok(offAgain.messages.length === 1, "[3] OFF 提示也只出现一次");

    // 空文本 → 不注入
    text = "";
    const none = await runPreStep(ctx, { messages: [{ id: "u6", role: "user", content: [], source: { kind: "user" } }] });
    ok(none.messages.length === 1, "[3] 文本为空时不注入");
    injector.dispose();
  }

  // [4] 健壮性：resolve 抛错 / reject 决策 / 非 enter 决策
  {
    const ctx = fakeCtx();
    const injector = createPolicyInjector(ctx, {
      resolve: () => { throw new Error("resolver 炸了"); },
    });
    let threw = false;
    let decision = null;
    try {
      decision = await runPreStep(ctx, { messages: [{ id: "u1", role: "user", content: [], source: { kind: "user" } }] });
    } catch { threw = true; }
    ok(!threw && decision.messages.length === 1, "[4] resolver 抛错时不外抛、不注入");

    const rejectHandler = ctx.listeners.get("agent/pre-step")[0];
    const rejected = await rejectHandler({ agent: { id: SESSION }, messages: [] }, async () => ({ kind: "reject" }));
    ok(rejected.kind === "reject", "[4] reject 决策原样放行");
    injector.dispose();

    // dispose 之后不再注入
    const after = await runPreStep(ctx, { messages: [{ id: "u9", role: "user", content: [], source: { kind: "user" } }] });
    ok(after === null, "[4] dispose 之后监听器已摘除");
  }
}

/* ── 5~6：turbo 状态 / 路由 / 读数 ──────────────────────────────────────── */

async function turboSuite() {
  console.log("\n[5-6] /turbo 路由与舰队读数");
  const ROOT = "session-root0001";
  const CHILD = "session-child0001";
  const OTHER = "session-other0001";

  const sessions = {};
  const ctx = fakeCtx({ descendants: { [ROOT]: [CHILD] } });
  const turbo = createTurbo(ctx, {
    log: () => {},
    readSessions: () => sessions,
    // ⚠️ 必须**深拷贝快照**再回写：`next` 就是 turbo 内部那个活对象，
    // 若先 delete 全部键再 Object.assign(next)，会把刚写进去的状态自己抹掉
    // （第一版就是这么假绿的——PATCH 响应说 true，状态却空了）。
    writeSessions: async (next) => {
      const snapshot = JSON.parse(JSON.stringify(next));
      for (const key of Object.keys(sessions)) delete sessions[key];
      Object.assign(sessions, snapshot);
      return true;
    },
    readJson: ctx.readJson,
  });
  await tick();

  // GET：没有 session 参数 → 全默认
  {
    const response = await callRoute(ctx, "/plugins/dsh-effort-slider/turbo");
    const body = JSON.parse(response.body);
    ok(response.status === 200 && body.ok === true, "[5] GET 无参数返回 ok");
    ok(body.lightning === false && body.ultra === false && body.policy === "", "[5] 默认关且无策略文本");
    ok(Number.isInteger(body.rate) && body.rate === 0 && Number.isInteger(body.total), "[6] 空读数全是整数 0");
  }

  // PATCH：开闪电
  {
    const response = await callRoute(ctx, "/plugins/dsh-effort-slider/turbo", { method: "PATCH", payload: { session: ROOT, lightning: true } });
    const body = JSON.parse(response.body);
    ok(response.status === 200 && body.lightning === true && body.persisted === true, "[5] PATCH 打开闪电并持久化");
    ok(sessions[ROOT]?.lightning === true, "[5] 状态写进了状态文件");
  }

  // GET：策略文本出现，且等于 policyText({lightning:true})
  {
    const response = await callRoute(ctx, "/plugins/dsh-effort-slider/turbo", { session: ROOT });
    const body = JSON.parse(response.body);
    ok(body.policy === policyText({ lightning: true }), "[5] GET 返回的策略文本与 policy.mjs 一致");
    ok(body.policy.includes("Lightning Mode"), "[5] 文本里确实有闪电策略");
  }

  // PATCH：非法 session id 被拒
  {
    const response = await callRoute(ctx, "/plugins/dsh-effort-slider/turbo", { method: "PATCH", payload: { session: "../../etc/passwd", lightning: true } });
    ok(response.status === 400, "[5] 非法 session id 被拒（400）");
  }

  // [6] 只有后代（成员）计入读数
  await tick();
  {
    const stream = (agentId, text) => {
      for (const handler of ctx.listeners.get("agent/assistant-stream") ?? []) {
        handler({ agent: { id: agentId }, frame: { type: "chunk", chunk: { type: "text-delta", index: 0, text }, time: Date.now() } });
      }
    };
    stream(CHILD, "x".repeat(40));                 // 成员：40 字符 ≈ 10 token
    stream(OTHER, "y".repeat(400));                // 非成员：必须被忽略
    const response = await callRoute(ctx, "/plugins/dsh-effort-slider/turbo", { session: ROOT });
    const body = JSON.parse(response.body);
    ok(body.agents === 1, `[6] 成员数 = 1（实际 ${body.agents}）`);
    ok(body.gen > 0 && body.gen <= 10, `[6] 生成速率来自成员（gen=${body.gen}）`);
    ok(body.rate < 30, `[6] 非成员的 400 字符没有被计入（rate=${body.rate}）`);
    ok(body.total > 0, "[6] 累计 token 在增长");
  }

  // [6] 关掉闪电后，成员集清空 → 读数归零
  {
    await callRoute(ctx, "/plugins/dsh-effort-slider/turbo", { method: "PATCH", payload: { session: ROOT, lightning: false } });
    await tick();
    const response = await callRoute(ctx, "/plugins/dsh-effort-slider/turbo", { session: ROOT });
    const body = JSON.parse(response.body);
    ok(body.agents === 0 && body.rate === 0, "[6] 关掉后不再统计（agents=0, rate=0）");
    ok(body.policy === "", "[6] 关掉后不再返回策略文本");
  }

  turbo.dispose();
  ok(ctx.routes.length === 0, "[6] dispose 之后路由已注销");
}

async function lifecycleSuite() {
  console.log("\n[7] 运行中会话索引：不扫描持久化记录，生命周期立即生效");
  const root = "session-life-root";
  const fork = { id: "session-life-fork", header: { parentSession: root } };
  const child = { id: "session-life-child", header: { origin: "subagent", parentSession: fork.id } };
  const grandchild = { id: "session-life-grandchild", header: { origin: "subagent", parentSession: child.id } };
  const unrelated = { id: "session-life-unrelated", header: { origin: "subagent", parentSession: "session-other-root" } };
  const ctx = fakeCtx({ liveSessions: [{ id: root, header: {} }, fork, child, grandchild, unrelated] });
  const turbo = createTurbo(ctx, {
    readSessions: () => ({ [root]: { lightning: true } }),
    writeSessions: async () => true,
    readJson: ctx.readJson,
  });
  ok(turbo.sample().agents === 2, "[7] 穿过普通 fork 查祖先，只计当前 root 的子代理");
  ok(ctx.reads.lists === 1, "[7] 启动时只读取一次内存中的运行会话");

  // one-shot 与 continuable 都由 origin 判定，不回放历史读取 descriptor。
  const oneShot = {
    id: "session-life-oneshot",
    header: { origin: "subagent", parentSession: root },
    snapshotEvents() { throw new Error("不得回放历史"); },
  };
  ctx.createSession(oneShot);
  ok(turbo.sample().agents === 3, "[7] 新子代理立即进入，包含 one-shot，不读取历史");
  ctx.disposeSession(child.id);
  ok(turbo.sample().agents === 2, "[7] 父代理退场后，其仍在运行的孙代理继续计入");
  ctx.emit("agent/assistant-stream", { agent: { id: child.id, session: child }, frame: { type: "chunk", chunk: { type: "text-delta", text: "x".repeat(400) } } });
  ok(turbo.sample().total === 0 && turbo.sample().agents === 2, "[7] 已退场代理的迟到流帧不能重新加入");

  // 漏掉 create（例如服务初始化晚于插件）仍可从流载荷自愈。
  const late = { id: "session-life-late", header: { origin: "subagent", parentSession: root } };
  ctx.createSession(late, false);
  ctx.emit("agent/assistant-stream", { agent: { id: late.id, session: late }, frame: { type: "chunk", chunk: { type: "text-delta", text: "x".repeat(40) } } });
  ok(turbo.sample().agents === 3 && turbo.sample().total === 10, "[7] 流事件可补齐新会话元数据，首个 chunk 也能计量");
  const cycle = { id: "session-life-cycle", header: { origin: "subagent", parentSession: "session-life-cycle" } };
  ctx.createSession(cycle);
  ok(turbo.sample().agents === 3, "[7] 环形祖先链被忽略，不阻塞生命周期事件");
  await callRoute(ctx, TURBO_ENDPOINT, { method: "PATCH", payload: { session: root, lightning: false } });
  ok(turbo.sample().agents === 0, "[7] 关闭模式立即摘除成员");
  await callRoute(ctx, TURBO_ENDPOINT, { method: "PATCH", payload: { session: root, lightning: true } });
  ok(turbo.sample().agents === 3 && ctx.reads.lists === 1, "[7] 重新开启只使用内存索引，不重复列会话");
  for (let i = 0; i < 2100; i += 1) ctx.createSession({ id: `session-idle-${i}`, header: {} });
  const beforeLateChunk = turbo.sample();
  ctx.emit("agent/assistant-stream", { agent: { id: child.id, session: child }, frame: { type: "chunk", chunk: { type: "text-delta", text: "x".repeat(400) } } });
  ok(turbo.sample().agents === beforeLateChunk.agents && turbo.sample().total === beforeLateChunk.total,
    "[7] 索引达到上限后，迟到的已退场对象也不能重新加入");
  ok(ctx.reads.descendants === 0 && ctx.reads.history === 0, "[7] 全流程没有持久化查询 / listDescendants 调用");

  const captured = [...(ctx.listeners.get("session/created") ?? [])];
  turbo.dispose();
  turbo.dispose();
  for (const handler of captured) handler(oneShot);
  ok([...ctx.listeners.values()].every((handlers) => handlers.length === 0), "[7] dispose 移除所有事件订阅");
  ok(turbo.sample().agents === 0 && turbo.sample().total === 0, "[7] dispose 清除计量状态，迟到回调不起作用");
}

async function main() {
  await injectionSuite();
  await turboSuite();
  await lifecycleSuite();
  console.log(`\n检查条数: ${checks}，通过: ${checks - failures}，失败: ${failures}`);
  if (failures > 0) {
    console.log("有失败 ❌");
    process.exit(1);
  }
  console.log("全部通过 ✅");
  process.exit(0);
}

await main();
