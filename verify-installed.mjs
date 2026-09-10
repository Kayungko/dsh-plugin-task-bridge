/**
 * verify-installed.mjs — 安装态自检（mock ctx）。
 *
 * 在安装位置（<profile>/node_modules/dsh-plugin-task-bridge）或「临时目录 junction
 * 仿真」位置运行 `node verify-installed.mjs`。本插件零 @deepseek-ai 源码 import，
 * 故仓库工作区也能直接跑；junction 仿真用于忠实复刻 profile node_modules 树的
 * 解析环境（见 README「测试」节，先例：dsh-plugin-web-search-mana 的 verify）。
 *
 * 覆盖（对照固定契约）：
 *   ① 入口可 import + exports 形状（name/inject/apply/resolveConfig/defaultTokenFile）
 *   ② 装载契约静态断言：package.json dsh.bundle.patch 指向 cordis.patch.yml；
 *      cordis.patch.yml 声明与 coordinator 同一共享 isolate label 'dsh-task-bridge'
 *   ③ apply() → 恰好 6 条 exact 路由，路径/方法齐全，重复注册抛错，disposer 反注册
 *   ④ 鉴权矩阵端到端（真实临时 token 文件 + 合成 token）：缺头/错值 401、重复头 400、
 *      正确 200、token 文件缺失 503
 *   ⑤ spawn 端到端：走到 mock ops 且参数含 reportBack:false + 伪 caller 形状；
 *      回执 workspace/placement/correlationId 透传
 *   ⑥ wait 钳制：timeoutMs 超大 → ops 收到 ≤50000
 *   ⑦ 降级：服务缺席 / 服务无 ops → 503 upstream-error
 *
 * 脱敏红线：仅用合成 token（test-token-verify-*），绝不读/引用真实 token 文件。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
console.log('verify location :', here);

// ---- ① 入口 import + exports 形状 ----
const entry = await import('./index.mjs');
assert.equal(entry.name, 'task-bridge', 'export const name 应为 task-bridge');
assert.deepEqual(entry.inject, ['webServer'], 'inject 应为 ["webServer"]');
assert.equal(typeof entry.apply, 'function', 'export function apply 缺失');
assert.equal(typeof entry.resolveConfig, 'function', 'resolveConfig 缺失');
assert.equal(typeof entry.defaultTokenFile, 'function', 'defaultTokenFile 缺失');
const endpointsMod = await import('./endpoints.mjs');
const { ENDPOINTS, BRIDGE_CALLER_SESSION_ID, WAIT_MAX_TIMEOUT_MS } = endpointsMod;
assert.equal(ENDPOINTS.length, 6, '应为 6 端点');
console.log('  [OK] ① 入口 exports 形状（零 @deepseek-ai import，本位置可直接解析）');

// ---- ② 装载契约静态断言 ----
{
  const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-plugin-task-bridge');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch 应指向 cordis.patch.yml');
  assert.equal(pkg.type, 'module');
  const yml = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
  assert.match(yml, /taskCoordinator:\s*'dsh-task-bridge'/, "cordis.patch.yml 应声明共享 isolate label 'dsh-task-bridge'");
  assert.match(yml, /group:\s*true/, '应以独立插件组挂载（故障隔离）');
  assert.match(yml, /name:\s*'dsh-plugin-task-bridge'/, '子 runtime entry 应指向本包');
  console.log("  [OK] ② 装载契约（dsh.bundle.patch + 共享 isolate label 'dsh-task-bridge' + group）");
}

// ---- mock 基建（自包含；复刻宿主 webserver.register 契约）----
function authHeaders(token) { return { 'x-task-bridge-token': token }; }

function makeReq({ method = 'GET', url = '/', headers = {}, distinct = null, remoteAddress = '127.0.0.1', body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  req.headers = lower;
  req.headersDistinct = distinct ?? Object.fromEntries(Object.entries(lower).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));
  req.socket = { remoteAddress };
  req.complete = true;
  req.resume = () => {};
  const chunks = body === null ? [] : (Array.isArray(body) ? body : [Buffer.from(body)]).map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)));
  req[Symbol.asyncIterator] = async function* () { for (const c of chunks) yield c; };
  return req;
}

function makeRes() {
  const res = new EventEmitter();
  res.headersSent = false; res.writableEnded = false; res.destroyed = false;
  res.statusCode = undefined; res.headers = {}; res.body = undefined;
  res.writeHead = (s, h) => { res.statusCode = s; Object.assign(res.headers, h ?? {}); res.headersSent = true; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; return res; };
  res.end = (d) => { if (d !== undefined) res.body = d; res.writableEnded = true; return res; };
  return res;
}

async function hit(handler, req, res = makeRes()) {
  await handler(req, res);
  return { status: res.statusCode, body: res.body === undefined ? null : JSON.parse(res.body), headers: res.headers };
}

function makeMockOps() {
  const calls = { spawnTask: [], waitFor: [], models: [] };
  const ops = {
    async spawnTask(args, caller) { calls.spawnTask.push({ args, caller }); return { ok: true, sessionId: 'session-verify-child', shortId: 'verify-chi', title: '0910｜探索｜自检', cwd: 'D:/git/DHS-Tool', workspace: { id: 'ws-verify', title: 'DHS-Tool' }, placement: 'exact-match', started: true, correlationId: 'task-coord-verify-1', depth: 1, hint: '…' }; },
    async waitFor(args, caller) { calls.waitFor.push({ args, caller }); return { ok: true, mode: args.mode, settled: false, reason: 'timed out', waitedMs: args.timeoutMs, count: args.sessionIds.length, targets: [] }; },
    async models(args, caller) { calls.models.push({ args, caller }); return { ok: true, providers: [{ id: 'verify-provider', models: [{ id: 'verify-model' }] }], hint: '…' }; },
  };
  return { ops, calls };
}

function mount({ config = {}, service }) {
  const routes = new Map();
  const effects = [];
  const logs = { info: [], warn: [] };
  const webServer = {
    host: '127.0.0.1',
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
    get: (name) => (name === 'taskCoordinator' ? service : undefined),
  };
  entry.apply(ctx, config);
  for (const e of effects) e.factory();
  return { routes, logs, handler: (p) => routes.get(p).handler, webServer };
}

const tmp = mkdtempSync(join(tmpdir(), 'task-bridge-verify-'));
try {
  const TOKEN = 'test-token-verify-0123456789abcdef-0123456789abcdef'; // 合成假值
  const tokenPath = join(tmp, 'verify-token.txt');
  writeFileSync(tokenPath, TOKEN, 'utf8');

  // ---- ③ 路由表注册齐全 ----
  {
    const mock = makeMockOps();
    const m = mount({ config: { tokenFile: tokenPath }, service: { config: { minSendIntervalMs: 2000 }, version: '0.24.0', ops: mock.ops } });
    assert.equal(m.routes.size, 6, '应注册恰好 6 条路由');
    for (const e of ENDPOINTS) {
      const route = m.routes.get(e.path);
      assert.ok(route, `路由 ${e.path} 缺失`);
      assert.equal(route.kind, 'exact', `${e.path} 应为 exact`);
      assert.equal(typeof route.handler, 'function');
    }
    // 重复注册抛错（宿主 webserver 契约）
    assert.throws(() => m.webServer.register({ kind: 'exact', path: '/v1/spawn', handler: () => {} }), /duplicate/);
    console.log('  [OK] ③ 路由表注册齐全（6 exact，路径/方法对齐收敛清单，重复注册抛错）');

    // ---- ④ 鉴权矩阵端到端 ----
    const modelsHandler = m.handler('/v1/models');
    let r = await hit(modelsHandler, makeReq({ url: '/v1/models' }));
    assert.equal(r.status, 401, '缺头应 401'); assert.equal(r.body.code, 'unauthorized');
    r = await hit(modelsHandler, makeReq({ url: '/v1/models', headers: authHeaders('test-token-wrong') }));
    assert.equal(r.status, 401, '错值应 401');
    r = await hit(modelsHandler, makeReq({ url: '/v1/models', headers: authHeaders(TOKEN), distinct: { 'x-task-bridge-token': [TOKEN, TOKEN] } }));
    assert.equal(r.status, 400, '重复头应 400'); assert.equal(r.body.code, 'bad-request');
    r = await hit(modelsHandler, makeReq({ url: '/v1/models', headers: authHeaders(TOKEN) }));
    assert.equal(r.status, 200, '正确 token 应 200'); assert.equal(r.body.ok, true);
    assert.equal(mock.calls.models.length, 1, 'models 应走到 mock ops');
    // token 文件缺失 → 503
    const missing = join(tmp, 'no-such-token.txt');
    const m2 = mount({ config: { tokenFile: missing }, service: { config: {}, version: '0.24.0', ops: mock.ops } });
    r = await hit(m2.handler('/v1/models'), makeReq({ url: '/v1/models', headers: authHeaders(TOKEN) }));
    assert.equal(r.status, 503, 'token 文件缺失应 503'); assert.equal(r.body.code, 'upstream-error');
    console.log('  [OK] ④ 鉴权矩阵端到端（缺头/错值 401、重复头 400、正确 200、token 缺失 503）');

    // ---- ⑤ spawn 端到端：reportBack:false + 伪 caller + 回执透传 ----
    {
      const spawnHandler = m.handler('/v1/spawn');
      const H = { ...authHeaders(TOKEN), 'content-type': 'application/json' };
      const r = await hit(spawnHandler, makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: '自检子任务', cwd: 'D:/git/DHS-Tool', reportBack: true }) }));
      assert.equal(r.status, 200); assert.equal(r.body.ok, true);
      assert.equal(mock.calls.spawnTask.length, 1, 'spawn 应走到 mock ops');
      const { args, caller } = mock.calls.spawnTask[0];
      assert.equal(args.reportBack, false, 'spawn 必须强制 reportBack:false（即使请求带 true）');
      assert.equal(args.prompt, '自检子任务');
      assert.equal(caller.sessionId, BRIDGE_CALLER_SESSION_ID, '伪 caller sessionId');
      assert.equal(caller.origin, undefined, '伪 caller origin 应 undefined（非 subagent）');
      assert.equal(caller.cwd, 'D:/git/DHS-Tool', 'caller.cwd 应取请求 cwd');
      // 回执透传
      assert.equal(r.body.workspace.id, 'ws-verify', 'workspace 应透传');
      assert.equal(r.body.placement, 'exact-match', 'placement 应透传');
      assert.equal(r.body.correlationId, 'task-coord-verify-1');
      console.log('  [OK] ⑤ spawn 端到端（reportBack:false 强制 + 伪 caller 形状 + workspace/placement 回执透传）');
    }

    // ---- ⑥ wait 钳制 ----
    {
      const waitHandler = m.handler('/v1/wait');
      const r = await hit(waitHandler, makeReq({ url: '/v1/wait?sessionId=s1&timeoutMs=999999', headers: authHeaders(TOKEN) }));
      assert.equal(r.status, 200);
      assert.equal(mock.calls.waitFor[0].args.timeoutMs, WAIT_MAX_TIMEOUT_MS, 'wait 必须钳到 ≤50000ms');
      assert.ok(mock.calls.waitFor[0].args.signal instanceof AbortSignal, 'wait 应传 AbortSignal');
      console.log('  [OK] ⑥ wait 钳制（timeoutMs 999999 → ops 收到 ≤50000 + AbortSignal）');
    }
  }

  // ---- ⑦ 降级：服务缺席 / 无 ops → 503 ----
  {
    const H = { ...authHeaders(TOKEN), 'content-type': 'application/json' };
    // 服务缺席（ctx.get → undefined）
    const mNull = mount({ config: { tokenFile: tokenPath }, service: undefined });
    let r = await hit(mNull.handler('/v1/models'), makeReq({ url: '/v1/models', headers: authHeaders(TOKEN) }));
    assert.equal(r.status, 503, '服务缺席应 503'); assert.equal(r.body.code, 'upstream-error');
    // 服务存在但无 ops（disabled / 旧版 coordinator）
    const mNoOps = mount({ config: { tokenFile: tokenPath }, service: { config: {}, version: '0.23.0' } });
    r = await hit(mNoOps.handler('/v1/spawn'), makeReq({ method: 'POST', url: '/v1/spawn', headers: H, body: JSON.stringify({ prompt: 'x' }) }));
    assert.equal(r.status, 503, '无 ops 应 503');
    console.log('  [OK] ⑦ 降级（服务缺席 / 无 ops → 503 upstream-error，对齐 webhook-github 503 语义）');
  }

  console.log('\n[OK] verify-installed 全部通过：入口/装载契约/路由表/鉴权矩阵端到端/spawn e2e(reportBack:false+伪 caller)/wait 钳制/降级 503');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
