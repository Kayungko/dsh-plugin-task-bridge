/**
 * smoke.mjs — dsh-plugin-task-bridge 离线全规则冒烟。
 * 零网络、零宿主、零真实凭据；全部用合成 token（test-token-*）。
 * 在仓库根直接 `node smoke.mjs` 即可（本插件零 @deepseek-ai import）。
 *
 * 覆盖矩阵（对照固定契约逐条）：
 *   A 路由注册面   apply() → 6 条 exact 路由 + 重复注册抛错 + disposer 反注册 +
 *                  缺 webServer 抛错 + resolveConfig 默认/覆盖 + 0.0.0.0 绑定告警
 *   B 回环拒绝     非回环/缺地址 → 403 unauthorized + warn 日志；回环三形态放行
 *   C 鉴权矩阵     缺头/错值(异长)/错值(等长)/空值 → 401；重复头 → 400；正确 → 200；
 *                  tokenMatches 恒时比较单元
 *   D token 文件   缺失/空文件 → 503；热轮换（size 变化路径 + 同长度 mtime 路径）
 *   E body 规则    Content-Type 非 JSON 415 / CL 预检超限 413（先于 token）/
 *                  CL 非法 400 / 流式累计超限 413 / 非法 UTF-8 400 / 非 JSON 400 /
 *                  JSON 非对象 400 / 流中止 400 / 空对象缺字段 400（ops 未调）/
 *                  恰好达限放行
 *   F 方法白名单   GET /v1/spawn → 405+allow:POST；POST /v1/models → 405+allow:GET；
 *                  方法检查先于 token
 *   G 端点分发     6 端点 happy path：ops 参数形状（reportBack:false 强制、伪 caller、
 *                  cwd 解析链、wait 钳制）+ 回执字段透传（workspace/placement/…）+
 *                  externalRef 四态（0.2.0，wire 契约 C1：传/不传/超长/非字符串）
 *   H 错误信封     ops 失败码→桥 code 映射逐项 + 未知码 + ops 抛异常 + 服务缺席/无 ops
 *                  503 + 孤儿 sessionId 透传 + 桥侧前置校验先于 ops
 *   I 策略闸       单元（注入时钟滚动窗口）+ e2e（第 N+1 次 429 policy-gated +
 *                  retryAfterMs + Retry-After 头 + ops 未调）+ 鉴权先于策略闸
 *   J wait 断连    res close（未写完）→ AbortSignal 置位（服务端等待即刻释放）
 *   K 信封与头     content-type 固定；失败信封三字段形态；ok 字段在首位
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { apply, resolveConfig, defaultTokenFile } from './index.mjs';
import { tokenMatches, TokenStore, TOKEN_HEADER_KEY } from './auth.mjs';
import { RollingWindowGate } from './policy.mjs';
import {
  ENDPOINTS, makeCaller, isLoopbackAddress,
  WAIT_MAX_TIMEOUT_MS, WAIT_DEFAULT_TIMEOUT_MS,
  BRIDGE_CALLER_SESSION_ID, BRIDGE_CALLER_ORIGIN,
} from './endpoints.mjs';

// 合成假 token（绝非真实凭据；脱敏红线）。A/B 异长，B/C 等长（测两条轮换路径）。
const TOKEN_A = 'test-token-smoke-aaaa-0123456789abcdef';
const TOKEN_B = 'test-token-smoke-bbbb-0123456789abcdef-rotation';
const TOKEN_C = 'test-token-smoke-cccc-0123456789abcdef-rotated2';

let sectionCount = 0;
function pass(label) {
  sectionCount += 1;
  console.log(`  [OK] ${label}`);
}

// ---------------------------------------------------------------------------
// mock 基建
// ---------------------------------------------------------------------------

function authHeaders(token) {
  return { [TOKEN_HEADER_KEY]: token };
}

function distinctFrom(lower) {
  const d = {};
  for (const [k, v] of Object.entries(lower)) d[k] = Array.isArray(v) ? v : [v];
  return d;
}

/** 构造 mock IncomingMessage（异步可迭代 body + headersDistinct + socket）。 */
function makeReq({ method = 'GET', url = '/', headers = {}, distinct = null, remoteAddress = '127.0.0.1', body = null, complete = true } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  req.headers = lower;
  req.headersDistinct = distinct ?? distinctFrom(lower);
  req.socket = { remoteAddress };
  req.complete = complete;
  req.resume = () => {};
  let chunks = [];
  if (body !== null) {
    if (typeof body === 'string') chunks = [Buffer.from(body, 'utf8')];
    else if (Buffer.isBuffer(body)) chunks = [body];
    else if (Array.isArray(body)) chunks = body.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)));
  }
  req[Symbol.asyncIterator] = async function* () {
    for (const c of chunks) yield c;
  };
  return req;
}

/** 构造 mock ServerResponse（EventEmitter，支持 writeHead/end/close 事件）。 */
function makeRes() {
  const res = new EventEmitter();
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.statusCode = undefined;
  res.headers = {};
  res.body = undefined;
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    Object.assign(res.headers, headers ?? {});
    res.headersSent = true;
    return res;
  };
  res.setHeader = (name, value) => { res.headers[name] = value; return res; };
  res.getHeader = (name) => res.headers[name];
  res.end = (data) => {
    if (data !== undefined) res.body = data;
    res.writableEnded = true;
    res.emit('finish');
    return res;
  };
  return res;
}

/** 跑一个 handler，返回解析后的应答。 */
async function hit(handler, req, res = makeRes()) {
  await handler(req, res);
  const body = res.body === undefined ? null : JSON.parse(res.body);
  return { status: res.statusCode, body, headers: res.headers, res };
}

/** 默认 mock ops 服务：捕获调用 + 返回固定回执（形状对齐真实 ops）。 */
function makeMockService(overrides = {}) {
  const calls = { spawnTask: [], sendMessage: [], progress: [], waitFor: [], listTasks: [], models: [] };
  const receipts = {
    spawnTask: {
      ok: true, sessionId: 'session-child-1', shortId: 'child-1', title: '0910｜探索｜冒烟子任务',
      team: 'smoke', cwd: 'D:/git/DHS-Tool', workspace: { id: 'ws-1', title: 'DHS-Tool' },
      placement: 'exact-match', started: true, correlationId: 'task-coord-smoke-1', depth: 1,
      model: { provider: 'test-provider', model: 'test-model' }, modelSource: 'explicit',
      hint: 'the new task is now visible in the session list',
    },
    sendMessage: {
      ok: true, delivered: true, targetId: 'session-worker', mode: 'steer', messageId: 'msg-1',
      reference: 'ref-1', placement: 'next-step (mid-run steering)', targetStatus: 'running',
      queueDepth: { nextTurn: 0, nextStep: 1 }, hint: 'delivered != consumed',
    },
    progress: {
      ok: true, sessionId: 'session-worker', shortId: 'worker', title: 'Worker', cwd: 'D:/proj',
      updatedAt: 1700000000000, todos: null, goal: null, agentState: 'running',
      queue: [{ placement: 'next-step', source: 'coordinator', text: '…' }],
      recent: [{ seq: 3, text: 'working on it' }], seq: 3,
    },
    waitFor: {
      ok: true, mode: 'all', settled: false, reason: 'timed out after 45000ms; still running: session-worker',
      waitedMs: 45000, count: 1, targets: [{ sessionId: 'session-worker', idle: false, agentState: 'running' }],
      sessionId: 'session-worker', hint: 'still running: check /v1/progress',
    },
    listTasks: {
      ok: true, count: 1, truncated: false, callerSessionId: 'task-bridge-external', team: 'smoke',
      tasks: [{ sessionId: 'session-child-1', title: '0910｜探索｜冒烟子任务', status: 'idle' }],
      hint: 'use /v1/progress to read one task in depth',
    },
    models: {
      ok: true, default: { provider: 'host-provider', model: 'host-model' },
      pluginDefault: { provider: 'plugin-provider', model: 'plugin-model' },
      providers: [{ id: 'plugin-provider', models: [{ id: 'plugin-model', efforts: ['high'] }] }],
      hint: 'use these exact provider/model ids',
    },
  };
  const ops = {};
  for (const method of Object.keys(calls)) {
    ops[method] = async (...args) => {
      calls[method].push(args);
      if (overrides[method]) return overrides[method](...args);
      return receipts[method];
    };
  }
  return { config: { minSendIntervalMs: 2000, maxQueuePerTask: 5 }, version: '0.24.0-seam-test', ops, calls, receipts };
}

/**
 * 挂载桥到 mock ctx，执行 effect 工厂（复刻 cordis 装载），返回测试把手。
 * @param {{config?: object, service?: object|null, webServerHost?: string}} opts
 *   service: undefined → 默认 mock；null → ctx.get 返回 null（服务缺席）；
 *            对象 → 用该对象（可无 ops，模拟旧版/disabled coordinator）。
 */
function mount(opts = {}) {
  const { config = {}, webServerHost = '127.0.0.1' } = opts;
  let currentService = opts.service === undefined ? makeMockService() : opts.service;
  const routes = new Map();
  const effects = [];
  const logs = { info: [], warn: [] };
  const webServer = {
    host: webServerHost,
    register(route) {
      if (routes.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`);
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    },
  };
  const ctx = {
    webServer,
    logger: { info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)) },
    effect(factory, label) { effects.push({ factory, label }); },
    get: (name) => (name === 'taskCoordinator' ? currentService : undefined),
  };
  apply(ctx, config);
  for (const e of effects) e.factory(); // cordis 在挂载时执行 effect 工厂
  return {
    routes, effects, logs, ctx, webServer,
    handler: (path) => {
      const route = routes.get(path);
      if (!route) throw new Error(`no route registered at ${path}`);
      return route.handler;
    },
    service: () => currentService,
    setService: (s) => { currentService = s; },
  };
}

// ---------------------------------------------------------------------------
// 测试主体
// ---------------------------------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), 'task-bridge-smoke-'));
try {
  // ===== A 路由注册面 =====
  {
    const tokenPath = join(tmp, 'a-token.txt');
    writeFileSync(tokenPath, TOKEN_A, 'utf8');
    const m = mount({ config: { tokenFile: tokenPath } });
    assert.equal(m.routes.size, 7, '应注册恰好 7 条路由');
    for (const e of ENDPOINTS) {
      assert.ok(m.routes.has(e.path), `路由 ${e.path} 缺失`);
      assert.equal(m.routes.get(e.path).kind, 'exact', `${e.path} 应为 exact`);
    }
    // 重复注册抛错（复刻 webserver 语义）
    assert.throws(() => m.webServer.register({ kind: 'exact', path: '/v1/spawn', handler: () => {} }), /duplicate/);
    // disposer 反注册
    const d = m.webServer.register({ kind: 'exact', path: '/v1/extra', handler: () => {} });
    assert.ok(m.routes.has('/v1/extra'));
    d();
    assert.ok(!m.routes.has('/v1/extra'), 'disposer 应移除路由');
    assert.equal(m.routes.size, 7);
    // apply 缺 webServer 抛错
    assert.throws(() => apply({ logger: { info() {}, warn() {} }, effect() {} }, {}), /webServer/);
    // resolveConfig 默认
    const def = resolveConfig({});
    assert.equal(def.tokenFile, defaultTokenFile());
    assert.equal(def.maxBodyBytes, 256 * 1024);
    assert.equal(def.spawnWindowMs, 60000);
    assert.equal(def.spawnMaxPerWindow, 10);
    assert.equal(def.defaultCwd, homedir());
    // resolveConfig 覆盖 + trim
    const over = resolveConfig({ tokenFile: ' X.txt ', defaultCwd: ' D:/x ', maxBodyBytes: 1024, spawnWindowMs: 5000, spawnMaxPerWindow: 2 });
    assert.equal(over.tokenFile, 'X.txt');
    assert.equal(over.defaultCwd, 'D:/x');
    assert.equal(over.maxBodyBytes, 1024);
    assert.equal(over.spawnWindowMs, 5000);
    assert.equal(over.spawnMaxPerWindow, 2);
    // 非法值回退默认
    const bad = resolveConfig({ maxBodyBytes: -5, spawnWindowMs: 'x', spawnMaxPerWindow: 0 });
    assert.equal(bad.maxBodyBytes, 256 * 1024);
    assert.equal(bad.spawnWindowMs, 60000);
    assert.equal(bad.spawnMaxPerWindow, 10);
    // 127.0.0.1 绑定不告警
    assert.equal(m.logs.warn.length, 0, '回环绑定不应告警');
    // 0.0.0.0 绑定强告警
    const m2 = mount({ config: { tokenFile: tokenPath }, webServerHost: '0.0.0.0' });
    assert.ok(m2.logs.warn.some((l) => l.includes('0.0.0.0')), '0.0.0.0 绑定应强告警');
    pass('A 路由注册面');
  }

  // ===== B 回环拒绝 =====
  {
    const tokenPath = join(tmp, 'b-token.txt');
    writeFileSync(tokenPath, TOKEN_A, 'utf8');
    const m = mount({ config: { tokenFile: tokenPath } });
    const handler = m.handler('/v1/models');
    for (const bad of ['192.168.1.5', '10.0.0.1', '::ffff:192.168.1.5', '']) {
      const r = await hit(handler, makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A), remoteAddress: bad }));
      assert.equal(r.status, 403, `非回环 ${bad} 应 403`);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.code, 'unauthorized');
    }
    // 缺 socket.remoteAddress（undefined）→ 403（fail-closed；析构默认会吞 undefined，故构造后显式删除）
    {
      const req = makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A) });
      delete req.socket.remoteAddress;
      const r = await hit(handler, req);
      assert.equal(r.status, 403, '缺 remoteAddress 应 403（fail-closed）');
      assert.equal(r.body.code, 'unauthorized');
    }
    assert.ok(m.logs.warn.some((l) => l.includes('non-loopback')), '非回环拒绝应记 warn 日志');
    for (const good of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const r = await hit(handler, makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A), remoteAddress: good }));
      assert.equal(r.status, 200, `回环 ${good} 应放行`);
      assert.equal(r.body.ok, true);
    }
    // 单元：isLoopbackAddress
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.1.2.3'), true);
    assert.equal(isLoopbackAddress('172.16.0.1'), false);
    assert.equal(isLoopbackAddress(undefined), false);
    pass('B 回环拒绝');
  }

  // ===== C 鉴权矩阵 =====
  {
    const tokenPath = join(tmp, 'c-token.txt');
    writeFileSync(tokenPath, TOKEN_A, 'utf8');
    const m = mount({ config: { tokenFile: tokenPath } });
    const handler = m.handler('/v1/models');
    // 缺头
    let r = await hit(handler, makeReq({ url: '/v1/models' }));
    assert.equal(r.status, 401); assert.equal(r.body.code, 'unauthorized');
    // 错值（异长——长度前置分支）
    r = await hit(handler, makeReq({ url: '/v1/models', headers: authHeaders('test-token-wrong') }));
    assert.equal(r.status, 401); assert.equal(r.body.code, 'unauthorized');
    // 错值（等长——timingSafeEqual 分支）
    r = await hit(handler, makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A.slice(0, -1) + 'Z') }));
    assert.equal(r.status, 401);
    // 空值
    r = await hit(handler, makeReq({ url: '/v1/models', headers: authHeaders('') }));
    assert.equal(r.status, 401);
    // 重复头（headersDistinct 长度 2）
    r = await hit(handler, makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A), distinct: { [TOKEN_HEADER_KEY]: [TOKEN_A, TOKEN_A] } }));
    assert.equal(r.status, 400); assert.equal(r.body.code, 'bad-request');
    // 正确
    r = await hit(handler, makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 200); assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.providers), 'models 回执应含 providers');
    assert.ok(m.logs.warn.some((l) => l.includes('unauthorized')), '鉴权失败应记 warn');
    // 恒时比较单元
    assert.equal(tokenMatches(TOKEN_A, TOKEN_A), true);
    assert.equal(tokenMatches(TOKEN_A, TOKEN_B), false);
    assert.equal(tokenMatches(TOKEN_A, TOKEN_A.slice(0, -1) + 'Z'), false); // 等长异值
    assert.equal(tokenMatches('', ''), false);
    assert.equal(tokenMatches(TOKEN_A, ''), false);
    assert.equal(tokenMatches(undefined, TOKEN_A), false);
    assert.equal(tokenMatches(123, TOKEN_A), false);
    pass('C 鉴权矩阵');
  }

  // ===== D token 文件（缺失/空/热轮换）=====
  {
    const tokenPath = join(tmp, 'd-token.txt');
    const m = mount({ config: { tokenFile: tokenPath } }); // 文件尚不存在
    const handler = m.handler('/v1/models');
    // 缺失 → 503（即使带了「看似正确」的头）
    let r = await hit(handler, makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 503); assert.equal(r.body.code, 'upstream-error');
    // 空文件（仅空白）→ 503
    writeFileSync(tokenPath, '   \n\t \n', 'utf8');
    r = await hit(handler, makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 503);
    // 轮换·size 变化路径
    writeFileSync(tokenPath, TOKEN_A, 'utf8');
    r = await hit(handler, makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 200, '写入 TOKEN_A 后应放行');
    writeFileSync(tokenPath, TOKEN_B, 'utf8'); // 异长
    r = await hit(handler, makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 401, '轮换后旧 token 应失效');
    r = await hit(handler, makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_B) }));
    assert.equal(r.status, 200, '轮换后新 token 应放行');
    // 轮换·同长度 mtime 路径（TOKEN_C 与 TOKEN_B 等长）
    assert.equal(TOKEN_B.length, TOKEN_C.length, 'B/C 应等长以测 mtime 路径');
    writeFileSync(tokenPath, TOKEN_C, 'utf8');
    const later = new Date(Date.now() + 5000);
    utimesSync(tokenPath, later, later); // 强制 mtime 变化（size 不变）
    r = await hit(handler, makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_B) }));
    assert.equal(r.status, 401, '同长度轮换后旧 token 应失效（mtime 路径）');
    r = await hit(handler, makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_C) }));
    assert.equal(r.status, 200, '同长度轮换后新 token 应放行');
    // TokenStore 单元：目录路径 → unavailable
    const dirStore = new TokenStore(tmp);
    assert.equal(dirStore.current().error, 'unavailable');
    pass('D token 文件');
  }

  // ===== E body 规则 =====
  {
    const tokenPath = join(tmp, 'e-token.txt');
    writeFileSync(tokenPath, TOKEN_A, 'utf8');
    const m = mount({ config: { tokenFile: tokenPath, maxBodyBytes: 64 } });
    const handler = m.handler('/v1/send');
    const H = { ...authHeaders(TOKEN_A), 'content-type': 'application/json' };
    const svc = m.service();
    // Content-Type 非 JSON → 415
    let r = await hit(handler, makeReq({ method: 'POST', url: '/v1/send', headers: { ...authHeaders(TOKEN_A), 'content-type': 'text/plain' }, body: '{}' }));
    assert.equal(r.status, 415); assert.equal(r.body.code, 'forbidden-body');
    // CL 预检超限 → 413
    r = await hit(handler, makeReq({ method: 'POST', url: '/v1/send', headers: { ...H, 'content-length': '65' }, body: 'x'.repeat(65) }));
    assert.equal(r.status, 413); assert.equal(r.body.code, 'forbidden-body');
    // CL 预检先于 token：无 token + 超大 CL → 413（不是 401）
    r = await hit(handler, makeReq({ method: 'POST', url: '/v1/send', headers: { 'content-type': 'application/json', 'content-length': '999999' } }));
    assert.equal(r.status, 413, 'CL 预检应先于 token 鉴权');
    // CL 非法 → 400
    r = await hit(handler, makeReq({ method: 'POST', url: '/v1/send', headers: { ...H, 'content-length': '12abc' }, body: '{}' }));
    assert.equal(r.status, 400); assert.equal(r.body.code, 'forbidden-body');
    // 流式累计超限（CL 谎报小）→ 413
    r = await hit(handler, makeReq({ method: 'POST', url: '/v1/send', headers: { ...H, 'content-length': '5' }, body: [Buffer.from('{"text":"'), Buffer.alloc(80, 0x61), Buffer.from('"}')] }));
    assert.equal(r.status, 413);
    // 非法 UTF-8 → 400
    r = await hit(handler, makeReq({ method: 'POST', url: '/v1/send', headers: H, body: [Buffer.from([0xff, 0xfe, 0x28])] }));
    assert.equal(r.status, 400); assert.equal(r.body.code, 'forbidden-body');
    // 非 JSON → 400
    r = await hit(handler, makeReq({ method: 'POST', url: '/v1/send', headers: H, body: 'not-json' }));
    assert.equal(r.status, 400); assert.equal(r.body.code, 'forbidden-body');
    // JSON 非对象（数组）→ 400
    r = await hit(handler, makeReq({ method: 'POST', url: '/v1/send', headers: H, body: '[1,2]' }));
    assert.equal(r.status, 400); assert.equal(r.body.code, 'forbidden-body');
    // 流中止（complete:false）→ 400
    r = await hit(handler, makeReq({ method: 'POST', url: '/v1/send', headers: H, body: '{}', complete: false }));
    assert.equal(r.status, 400); assert.equal(r.body.code, 'forbidden-body');
    // 空对象缺字段 → 400 bad-request，且 ops 未被调用
    const before = svc.calls.sendMessage.length;
    r = await hit(handler, makeReq({ method: 'POST', url: '/v1/send', headers: H, body: '{}' }));
    assert.equal(r.status, 400); assert.equal(r.body.code, 'bad-request');
    assert.equal(svc.calls.sendMessage.length, before, '前置校验失败时 ops 不应被调用');
    // 恰好达限放行（构造正好 64 字节的合法 body）
    const pad = 64 - Buffer.byteLength(JSON.stringify({ sessionId: 's1', text: '' }));
    const exactBody = JSON.stringify({ sessionId: 's1', text: 'x'.repeat(pad) });
    assert.equal(Buffer.byteLength(exactBody), 64, '构造的 body 应恰好 64 字节');
    r = await hit(handler, makeReq({ method: 'POST', url: '/v1/send', headers: { ...H, 'content-length': '64' }, body: exactBody }));
    assert.equal(r.status, 200, '恰好达限应放行');
    assert.equal(svc.calls.sendMessage.length, before + 1);
    pass('E body 规则');
  }

  // ===== F 方法白名单 =====
  {
    const tokenPath = join(tmp, 'f-token.txt');
    writeFileSync(tokenPath, TOKEN_A, 'utf8');
    const m = mount({ config: { tokenFile: tokenPath } });
    // GET /v1/spawn → 405 + allow:POST
    let r = await hit(m.handler('/v1/spawn'), makeReq({ method: 'GET', url: '/v1/spawn', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 405); assert.equal(r.body.code, 'bad-request'); assert.equal(r.headers.allow, 'POST');
    // POST /v1/models → 405 + allow:GET
    r = await hit(m.handler('/v1/models'), makeReq({ method: 'POST', url: '/v1/models', headers: { ...authHeaders(TOKEN_A), 'content-type': 'application/json' }, body: '{}' }));
    assert.equal(r.status, 405); assert.equal(r.headers.allow, 'GET');
    // 方法检查先于 token：无 token + 错方法 → 405（不是 401）
    r = await hit(m.handler('/v1/spawn'), makeReq({ method: 'GET', url: '/v1/spawn' }));
    assert.equal(r.status, 405, '方法白名单应先于 token 鉴权');
    pass('F 方法白名单');
  }

  // ===== G 端点分发×形状 =====
  {
    const tokenPath = join(tmp, 'g-token.txt');
    writeFileSync(tokenPath, TOKEN_A, 'utf8');
    const m = mount({ config: { tokenFile: tokenPath, defaultCwd: 'D:/default-cwd' } });
    const svc = m.service();
    const H = { ...authHeaders(TOKEN_A), 'content-type': 'application/json' };

    // G1 spawn：reportBack 强制 false + 伪 caller + cwd 链（请求 cwd 赢）+ 回执透传
    let r = await hit(m.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: '去做冒烟', cwd: 'D:/req-cwd', team: 'smoke', provider: 'p1', model: 'm1', reasoningEffort: 'high', reportBack: true, title: '探索｜冒烟' }) }));
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.placement, 'exact-match', 'placement 应透传');
    assert.equal(r.body.workspace.id, 'ws-1', 'workspace 应透传');
    assert.equal(r.body.correlationId, 'task-coord-smoke-1');
    assert.equal(r.body.modelSource, 'explicit');
    assert.equal(r.body.depth, 1);
    assert.equal(svc.calls.spawnTask.length, 1);
    const [spawnArgs, spawnCaller] = svc.calls.spawnTask[0];
    assert.equal(spawnArgs.reportBack, false, 'spawn 必须强制 reportBack:false（即使请求带 true）');
    assert.equal(spawnArgs.prompt, '去做冒烟');
    assert.equal(spawnArgs.provider, 'p1');
    assert.equal(spawnArgs.reasoningEffort, 'high');
    assert.equal(spawnCaller.sessionId, BRIDGE_CALLER_SESSION_ID);
    assert.equal(spawnCaller.origin, BRIDGE_CALLER_ORIGIN);
    assert.notEqual(spawnCaller.origin, 'subagent', '伪 caller origin 必须非 subagent');
    assert.equal(spawnCaller.cwd, 'D:/req-cwd', '请求 cwd 应赢');

    // G2 spawn：无请求 cwd → config.defaultCwd
    r = await hit(m.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: 'x' }) }));
    assert.equal(svc.calls.spawnTask[1][1].cwd, 'D:/default-cwd', '无请求 cwd 应用 config.defaultCwd');
    assert.equal(svc.calls.spawnTask[1][0].reportBack, false);

    // G3 spawn：无请求 cwd 且无 defaultCwd → homedir()
    const m3 = mount({ config: { tokenFile: tokenPath } });
    await hit(m3.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: 'y' }) }));
    assert.equal(m3.service().calls.spawnTask[0][1].cwd, homedir(), 'cwd 链末级应为用户主目录');

    // G3b spawn externalRef（v0.2.0，wire 契约 C1，dshq-ledger-mailbox-spec Part C）：
    // 传/不传/超长/非字符串四态。echo 型 mock：回执按 ops 实形状回显 externalRef，
    // 验证「请求 → 桥校验/trim → ops 参数 → 回执透传」全链。合成 ref 值（脱敏红线）。
    {
      const mRef = mount({
        config: { tokenFile: tokenPath },
        service: makeMockService({
          spawnTask: async (args) => ({
            ok: true, sessionId: 'session-ref-child', shortId: 'ref-chil', started: true, depth: 1,
            ...(args.externalRef !== undefined ? { externalRef: args.externalRef } : {}),
          }),
        }),
      });
      const refSvc = mRef.service();
      // ① 传：trim 后透传 ops + 回执回显；恰好 200 字符（trim 后）放行
      let rr = await hit(mRef.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: 'p', externalRef: '  thread-synth:wave-smoke  ' }) }));
      assert.equal(rr.status, 200);
      assert.equal(refSvc.calls.spawnTask[0][0].externalRef, 'thread-synth:wave-smoke', 'ops 应收到 trim 后的 externalRef');
      assert.equal(rr.body.externalRef, 'thread-synth:wave-smoke', '回执应回显 externalRef');
      const ref200 = 'r'.repeat(200);
      rr = await hit(mRef.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: 'p', externalRef: ` ${ref200} ` }) }));
      assert.equal(rr.status, 200, 'trim 后恰好 200 字符应放行');
      assert.equal(refSvc.calls.spawnTask[1][0].externalRef, ref200);
      // ② 不传：缺席 / null / 空串 / 仅空白 → ops 参数不含 externalRef 键（视为缺席）
      for (const [index, body] of [
        [0, { prompt: 'p' }],
        [1, { prompt: 'p', externalRef: null }],
        [2, { prompt: 'p', externalRef: '' }],
        [3, { prompt: 'p', externalRef: '   \t ' }],
      ]) {
        rr = await hit(mRef.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify(body) }));
        assert.equal(rr.status, 200, `缺席形态 ${index} 应放行`);
        const args = refSvc.calls.spawnTask.at(-1)[0];
        assert.equal('externalRef' in args, false, `缺席形态 ${index} 不得携带 externalRef 键`);
        assert.equal('externalRef' in rr.body, false, `缺席形态 ${index} 回执不得回显 externalRef`);
      }
      const callsBeforeReject = refSvc.calls.spawnTask.length;
      // ③ 超长：trim 后 201 字符 → 400 bad-request，ops 未调
      rr = await hit(mRef.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: 'p', externalRef: 'x'.repeat(201) }) }));
      assert.equal(rr.status, 400); assert.equal(rr.body.code, 'bad-request');
      assert.match(rr.body.error, /externalRef/);
      // 边界：trim 前 201 但 trim 后 200 → 放行（契约以 trim 后计）
      rr = await hit(mRef.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: 'p', externalRef: ` ${'x'.repeat(200)} ` }) }));
      assert.equal(rr.status, 200, 'trim 后 200 应放行（超限判定以 trim 后为准）');
      // ④ 非字符串：数字/布尔/对象/数组 → 400 bad-request，ops 未调
      for (const invalid of [42, true, { ref: 'x' }, ['x']]) {
        rr = await hit(mRef.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: 'p', externalRef: invalid }) }));
        assert.equal(rr.status, 400, `非字符串 ${JSON.stringify(invalid)} 应 400`);
        assert.equal(rr.body.code, 'bad-request');
        assert.match(rr.body.error, /externalRef/);
      }
      // 201 超长 + 4 个非字符串 = 5 次拒绝；期间仅 trim-200 边界那次到达 ops
      assert.equal(refSvc.calls.spawnTask.length, callsBeforeReject + 1, '被拒请求不得到达 ops（边界放行那次除外）');
    }

    // G4 send：targetId 映射 + mode/reference 透传 + 回执
    r = await hit(m.handler('/v1/send'), makeReq({ method: 'POST', url: '/v1/send', headers: H, body: JSON.stringify({ sessionId: 'session-worker', text: '纠偏一下', mode: 'steer', reference: 'msg-1' }) }));
    assert.equal(r.status, 200);
    assert.equal(r.body.messageId, 'msg-1');
    assert.equal(r.body.queueDepth.nextStep, 1);
    const [sendArgs, sendCaller] = svc.calls.sendMessage[0];
    assert.equal(sendArgs.targetId, 'session-worker', 'sessionId 应映射为 ops 的 targetId');
    assert.equal(sendArgs.mode, 'steer');
    assert.equal(sendArgs.reference, 'msg-1');
    assert.equal(sendCaller.sessionId, BRIDGE_CALLER_SESSION_ID);

    // G5 send：缺省 mode → 'queue'
    await hit(m.handler('/v1/send'), makeReq({ method: 'POST', url: '/v1/send', headers: H, body: JSON.stringify({ sessionId: 's', text: 't' }) }));
    assert.equal(svc.calls.sendMessage[1][0].mode, 'queue');

    // G6 progress：sessionId 透传 + 回执
    r = await hit(m.handler('/v1/progress'), makeReq({ url: '/v1/progress?sessionId=session-worker', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 200);
    assert.equal(r.body.agentState, 'running');
    assert.equal(svc.calls.progress[0][0], 'session-worker');
    // progress 缺 sessionId → 400，ops 未调
    const pBefore = svc.calls.progress.length;
    r = await hit(m.handler('/v1/progress'), makeReq({ url: '/v1/progress', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 400); assert.equal(r.body.code, 'bad-request');
    assert.equal(svc.calls.progress.length, pBefore);

    // G7 wait：钳制 + 参数形状
    r = await hit(m.handler('/v1/wait'), makeReq({ url: '/v1/wait?sessionId=s1&timeoutMs=60000', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 200); assert.equal(r.body.settled, false, '超时应 200 settled:false');
    let [waitArgs] = svc.calls.waitFor[0];
    assert.equal(waitArgs.timeoutMs, WAIT_MAX_TIMEOUT_MS, 'wait 必须钳到 ≤50000ms');
    assert.equal(waitArgs.mode, 'all');
    assert.deepEqual(waitArgs.sessionIds, ['s1']);
    assert.ok(waitArgs.signal instanceof AbortSignal, 'wait 应传 AbortSignal');
    // 缺省 timeoutMs → 45000
    await hit(m.handler('/v1/wait'), makeReq({ url: '/v1/wait?sessionId=s1', headers: authHeaders(TOKEN_A) }));
    assert.equal(svc.calls.waitFor[1][0].timeoutMs, WAIT_DEFAULT_TIMEOUT_MS);
    // 小值不放大
    await hit(m.handler('/v1/wait'), makeReq({ url: '/v1/wait?sessionId=s1&timeoutMs=1000', headers: authHeaders(TOKEN_A) }));
    assert.equal(svc.calls.waitFor[2][0].timeoutMs, 1000);
    // 多目标（重复参数 + 逗号串）
    await hit(m.handler('/v1/wait'), makeReq({ url: '/v1/wait?sessionId=a&sessionId=b&sessionIds=c,d&mode=any', headers: authHeaders(TOKEN_A) }));
    assert.deepEqual(svc.calls.waitFor[3][0].sessionIds, ['a', 'b', 'c', 'd']);
    assert.equal(svc.calls.waitFor[3][0].mode, 'any');
    // 非法 timeoutMs / mode / 无目标 → 400
    r = await hit(m.handler('/v1/wait'), makeReq({ url: '/v1/wait?sessionId=s1&timeoutMs=abc', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 400);
    r = await hit(m.handler('/v1/wait'), makeReq({ url: '/v1/wait?sessionId=s1&mode=both', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 400);
    r = await hit(m.handler('/v1/wait'), makeReq({ url: '/v1/wait', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 400);

    // G8 list：查询参数透传 + 回执
    r = await hit(m.handler('/v1/list'), makeReq({ url: '/v1/list?team=smoke&filter=child&limit=3&ungrouped=true&includeSubagents=true', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 200);
    assert.equal(r.body.tasks.length, 1);
    const [listArgs] = svc.calls.listTasks[0];
    assert.equal(listArgs.team, 'smoke');
    assert.equal(listArgs.filter, 'child');
    assert.equal(listArgs.limit, 3);
    assert.equal(listArgs.ungrouped, true);
    assert.equal(listArgs.includeSubagents, true);
    // 非法 limit / 布尔 → 400
    r = await hit(m.handler('/v1/list'), makeReq({ url: '/v1/list?limit=abc', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 400);
    r = await hit(m.handler('/v1/list'), makeReq({ url: '/v1/list?ungrouped=maybe', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 400);

    // G9 models
    r = await hit(m.handler('/v1/models'), makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A) }));
    assert.equal(r.status, 200);
    assert.equal(r.body.providers[0].id, 'plugin-provider');
    assert.equal(svc.calls.models.length, 1);

    // makeCaller 单元
    const c1 = makeCaller('D:/req', { defaultCwd: 'D:/def' });
    assert.equal(c1.cwd, 'D:/req');
    const c2 = makeCaller(undefined, { defaultCwd: 'D:/def' });
    assert.equal(c2.cwd, 'D:/def');
    const c3 = makeCaller('   ', {});
    assert.equal(c3.cwd, homedir());
    assert.equal(c1.sessionId, BRIDGE_CALLER_SESSION_ID);
    assert.equal(c1.origin, undefined);
    pass('G 端点分发×形状');
  }

  // ===== H 错误信封映射 =====
  {
    const tokenPath = join(tmp, 'h-token.txt');
    writeFileSync(tokenPath, TOKEN_A, 'utf8');
    const H = { ...authHeaders(TOKEN_A), 'content-type': 'application/json' };
    const cases = [
      ['rate-limited', 429, 'rate-limited'],
      ['queue-full', 429, 'queue-full'],
      ['target-busy', 429, 'rate-limited'],
      ['target-not-found', 404, 'not-found'],
      ['target-vanished', 404, 'not-found'],
      ['bad-request', 400, 'bad-request'],
      ['model-unavailable', 400, 'bad-request'],
      ['model-select-failed', 502, 'upstream-error'],
      ['kickoff-rejected', 502, 'upstream-error'],
      ['spawn-create-failed', 502, 'upstream-error'],
      ['spawn-depth-exceeded', 429, 'policy-gated'],
      ['catalog-unavailable', 503, 'upstream-error'],
      ['resolve-failed', 502, 'upstream-error'],
      ['caller-unknown', 502, 'upstream-error'],
      ['wait-failed', 500, 'upstream-error'],
      ['totally-unknown-code', 500, 'upstream-error'],
    ];
    for (const [opsCode, wantStatus, wantCode] of cases) {
      const m = mount({ config: { tokenFile: tokenPath }, service: makeMockService({ spawnTask: async () => ({ ok: false, code: opsCode, error: `ops ${opsCode}` }) }) });
      const r = await hit(m.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: 'x' }) }));
      assert.equal(r.status, wantStatus, `ops ${opsCode} → HTTP ${wantStatus}`);
      assert.equal(r.body.code, wantCode, `ops ${opsCode} → 信封 ${wantCode}`);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.upstreamCode, opsCode, 'upstreamCode 应保留原始 ops 码');
      assert.ok(typeof r.body.error === 'string' && r.body.error.length > 0);
    }
    // rate-limited 附 retryAfterMs（从 service.config.minSendIntervalMs）
    {
      const m = mount({ config: { tokenFile: tokenPath }, service: makeMockService({ sendMessage: async () => ({ ok: false, code: 'rate-limited', error: 'slow down' }) }) });
      const r = await hit(m.handler('/v1/send'), makeReq({ method: 'POST', url: '/v1/send', headers: H, body: JSON.stringify({ sessionId: 's', text: 't' }) }));
      assert.equal(r.status, 429);
      assert.equal(r.body.retryAfterMs, 2000, 'retryAfterMs 应来自 coordinator config.minSendIntervalMs');
      assert.equal(r.headers['retry-after'], '2');
    }
    // 孤儿 sessionId 透传（model-select-failed）
    {
      const m = mount({ config: { tokenFile: tokenPath }, service: makeMockService({ spawnTask: async () => ({ ok: false, code: 'model-select-failed', error: 'orphan created', sessionId: 'session-orphan-1', depth: 1, team: 'smoke' }) }) });
      const r = await hit(m.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: 'x' }) }));
      assert.equal(r.body.sessionId, 'session-orphan-1', '孤儿 sessionId 必须透传供补救');
      assert.equal(r.body.depth, 1);
      assert.equal(r.body.team, 'smoke');
    }
    // ops 抛异常 → 500
    {
      const m = mount({ config: { tokenFile: tokenPath }, service: makeMockService({ spawnTask: async () => { throw new Error('boom'); } }) });
      const r = await hit(m.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: 'x' }) }));
      assert.equal(r.status, 500); assert.equal(r.body.code, 'upstream-error');
      assert.ok(m.logs.warn.some((l) => l.includes('threw')), 'ops 异常应记 warn');
    }
    // 服务缺席（ctx.get → null）→ 503
    {
      const m = mount({ config: { tokenFile: tokenPath }, service: null });
      const r = await hit(m.handler('/v1/models'), makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A) }));
      assert.equal(r.status, 503); assert.equal(r.body.code, 'upstream-error');
    }
    // 服务存在但无 ops（旧版/disabled coordinator）→ 503
    {
      const m = mount({ config: { tokenFile: tokenPath }, service: { config: {}, version: '0.23.0' } });
      const r = await hit(m.handler('/v1/models'), makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A) }));
      assert.equal(r.status, 503);
    }
    // ops 存在但目标方法非函数 → 503
    {
      const m = mount({ config: { tokenFile: tokenPath }, service: { config: {}, version: 'x', ops: {} } });
      const r = await hit(m.handler('/v1/models'), makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A) }));
      assert.equal(r.status, 503);
    }
    // 桥侧前置校验先于 ops：spawn 缺 prompt → 400 且 ops 未调
    {
      const m = mount({ config: { tokenFile: tokenPath } });
      const r = await hit(m.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ title: 'no prompt' }) }));
      assert.equal(r.status, 400); assert.equal(r.body.code, 'bad-request');
      assert.equal(m.service().calls.spawnTask.length, 0, '缺 prompt 时 ops 不应被调用');
    }
    pass('H 错误信封映射');
  }

  // ===== I 策略闸 =====
  {
    // 单元：注入时钟的滚动窗口
    let t = 1000;
    const gate = new RollingWindowGate({ windowMs: 60000, max: 3 }, () => t);
    assert.equal(gate.tryAcquire().ok, true);
    assert.equal(gate.tryAcquire().ok, true);
    assert.equal(gate.tryAcquire().ok, true);
    const denied = gate.tryAcquire();
    assert.equal(denied.ok, false);
    assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 60000, 'retryAfterMs 应在窗口内');
    assert.equal(gate.size, 3);
    t += 60001; // 窗口滑出
    assert.equal(gate.tryAcquire().ok, true, '窗口滑过后应重新准入');
    assert.throws(() => new RollingWindowGate({ windowMs: 0, max: 1 }), /windowMs/);
    assert.throws(() => new RollingWindowGate({ windowMs: 1000, max: 0 }), /max/);

    // e2e：第 4 次 spawn（max 3）→ 429 policy-gated
    const tokenPath = join(tmp, 'i-token.txt');
    writeFileSync(tokenPath, TOKEN_A, 'utf8');
    const m = mount({ config: { tokenFile: tokenPath, spawnMaxPerWindow: 3 } });
    const H = { ...authHeaders(TOKEN_A), 'content-type': 'application/json' };
    for (let i = 0; i < 3; i++) {
      const r = await hit(m.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: `task-${i}` }) }));
      assert.equal(r.status, 200, `spawn ${i} 应成功`);
    }
    assert.equal(m.service().calls.spawnTask.length, 3);
    const r4 = await hit(m.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: 'task-4' }) }));
    assert.equal(r4.status, 429);
    assert.equal(r4.body.code, 'policy-gated');
    assert.ok(r4.body.retryAfterMs > 0 && r4.body.retryAfterMs <= 60000);
    assert.ok(/^\d+$/.test(r4.headers['retry-after']), 'Retry-After 头应为秒数');
    assert.equal(m.service().calls.spawnTask.length, 3, '被闸的 spawn 不得到达 ops');
    // 其他端点不受 spawn 窗口影响
    const rl = await hit(m.handler('/v1/list'), makeReq({ url: '/v1/list', headers: authHeaders(TOKEN_A) }));
    assert.equal(rl.status, 200);
    // 鉴权先于策略闸：超限 + 无 token → 401（而非 policy-gated）
    const r5 = await hit(m.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) }));
    assert.equal(r5.status, 401, '鉴权应先于策略闸');
    pass('I 策略闸');
  }

  // ===== J wait 断连 =====
  {
    const tokenPath = join(tmp, 'j-token.txt');
    writeFileSync(tokenPath, TOKEN_A, 'utf8');
    let resolveWait;
    const m = mount({
      config: { tokenFile: tokenPath },
      service: makeMockService({ waitFor: () => new Promise((resolve) => { resolveWait = resolve; }) }),
    });
    const handler = m.handler('/v1/wait');
    const res = makeRes();
    const req = makeReq({ url: '/v1/wait?sessionId=s1', headers: authHeaders(TOKEN_A) });
    const pending = hit(handler, req, res); // 不立即 await
    await new Promise((r) => setTimeout(r, 0)); // 让 handler 跑到 ops.waitFor
    assert.equal(m.service().calls.waitFor.length, 1, 'ops.waitFor 应已被调用');
    const signal = m.service().calls.waitFor[0][0].signal;
    assert.equal(signal.aborted, false, '初始未中止');
    res.emit('close'); // 客户端断连（响应未写完）
    assert.equal(signal.aborted, true, '断连必须中止服务端等待（AbortSignal 置位）');
    resolveWait({ ok: true, mode: 'all', settled: false, reason: 'wait aborted by caller', waitedMs: 0, count: 1, targets: [] });
    await pending; // handler 完成（向已断开客户端写应答被静默吞掉）
    pass('J wait 断连');
  }

  // ===== K 信封与头 =====
  {
    const tokenPath = join(tmp, 'k-token.txt');
    writeFileSync(tokenPath, TOKEN_A, 'utf8');
    const m = mount({ config: { tokenFile: tokenPath } });
    // 成功信封 content-type 固定
    const ok = await hit(m.handler('/v1/models'), makeReq({ url: '/v1/models', headers: authHeaders(TOKEN_A) }));
    assert.match(ok.headers['content-type'], /^application\/json; charset=utf-8$/);
    assert.equal(Object.keys(ok.body)[0], 'ok', 'ok 字段应在首位');
    assert.equal(ok.body.ok, true);
    // 失败信封三字段形态
    const bad = await hit(m.handler('/v1/models'), makeReq({ url: '/v1/models', headers: authHeaders('wrong') }));
    assert.deepEqual(Object.keys(bad.body).sort(), ['code', 'error', 'ok'], '失败信封应为 {ok,code,error}');
    assert.equal(bad.body.ok, false);
    pass('K 信封与头');
  }

  // L runtime capabilities and optional progress contract negotiation.
  {
    const tokenPath = join(tmp, 'l-token.txt');
    writeFileSync(tokenPath, TOKEN_A, 'utf8');
    const service = makeMockService();
    service.capabilities = { progressCursor: true, externalRef: true };
    const m = mount({ config: { tokenFile: tokenPath }, service });
    const capRequest = () => makeReq({ url: '/v1/capabilities', headers: authHeaders(TOKEN_A) });
    const caps = await hit(m.handler('/v1/capabilities'), capRequest());
    assert.equal(caps.body.coordinatorEnabled, true);
    assert.equal(caps.body.coordinatorVersion, service.version);
    assert.equal(caps.body.capabilities.progressCursor, true);
    assert.equal(caps.body.limits.waitMaxMs, 50000);
    const progressReq = () => makeReq({ url: '/v1/progress?sessionId=s&cursor=opaque&messageId=m', headers: authHeaders(TOKEN_A) });
    await hit(m.handler('/v1/progress'), progressReq());
    assert.deepEqual(service.calls.progress.at(-1)[3], { cursor: 'opaque', messageId: 'm' });
    delete service.capabilities;
    const old = await hit(m.handler('/v1/progress'), progressReq());
    assert.equal(old.status, 503);
    assert.equal(old.body.upstreamCode, 'capability-unavailable');
    const absent = mount({ config: { tokenFile: tokenPath }, service: null });
    const noService = await hit(absent.handler('/v1/capabilities'), capRequest());
    assert.equal(noService.body.coordinatorEnabled, false);
    assert.deepEqual(noService.body.capabilities, {});
    const denied = await hit(m.handler('/v1/capabilities'), makeReq({ url: '/v1/capabilities' }));
    assert.equal(denied.status, 401);
    pass('L 运行能力与增量协议');
  }

  console.log(`\n[OK] smoke 全部通过（${sectionCount} 节：A-L）`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
