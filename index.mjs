/**
 * dsh-plugin-task-bridge — 入口（v0.1.0 MVP）。
 *
 * 本地回环 HTTP 控制面桥：外部本机进程（如 Codex 总控 / 其 MCP stdio wrapper）
 * 经宿主 webserver 的 exact 路由驱动 DSH 任务。六个端点（/v1/spawn、/v1/send、
 * /v1/progress、/v1/wait、/v1/list、/v1/models）包装 dsh-plugin-task-coordinator
 * 0.24.0 服务缝 provide 的同一 ops 实例。
 *
 * 服务缝消费方式（research/task-bridge-reanchoring.md §1 + coordinator PROTOCOL §17）：
 *  - coordinator 以 provide('taskCoordinator', { config, version, ops }) 暴露 ops；
 *    其插件组与本桥插件组声明同一 isolate 共享 label 'dsh-task-bridge'
 *    （GlobalRealm：同 label 组共享 Symbol 'taskCoordinator@dsh-task-bridge'）；
 *  - 桥对 taskCoordinator 用惰性 ctx.get()（不硬 inject）——coordinator 未装/
 *    禁用/版本不含 ops 时，路由仍挂载、全部端点回 503 upstream-error（对齐
 *    dsh-webhook-github 的 503 降级语义，PROTOCOL §17.1）；
 *  - 桥只读 ops、不 provide 同名服务、只透传 6 方法白名单（PROTOCOL §17.2）。
 *
 * 安全模型（README 安全节有完整论述）：exact 路由命中后零宿主鉴权（探针矩阵
 * 实证，蓝图 §2.2）——桥 token（X-Task-Bridge-Token 头 + timingSafeEqual 恒时
 * 比较）是唯一防线，叠加回环自检、方法白名单、body 限长与桥侧 spawn 策略闸。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { TokenStore } from './auth.mjs';
import { RollingWindowGate } from './policy.mjs';
import { ENDPOINTS, createEndpointHandler } from './endpoints.mjs';

/** Cordis 插件名（loader diagnostics 用）。 */
export const name = 'task-bridge';

/** 硬依赖：宿主 webserver（路由挂载面）。taskCoordinator 走惰性 ctx.get，不算硬依赖。 */
export const inject = ['webServer'];

/** body 限长默认（固定契约⑧：256KB）。 */
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
/** 策略闸滚动窗口默认（固定契约⑦：60s）。 */
export const DEFAULT_SPAWN_WINDOW_MS = 60_000;
/** 策略闸窗口内 spawn 配额默认（固定契约⑦：10 次）。 */
export const DEFAULT_SPAWN_MAX_PER_WINDOW = 10;

/** token 文件默认路径（固定契约①：<用户主目录>/.dsh/task-bridge-token）。 */
export function defaultTokenFile() {
  return join(homedir(), '.dsh', 'task-bridge-token');
}

/**
 * 配置解析：全部带默认值，错误类型不猜测（对齐 coordinator config.mjs 风格）。
 * 纯函数，可离线单测。
 * @param {unknown} input patch 行 config（profile 层可按 id 覆盖）
 */
export function resolveConfig(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const trimmed = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);
  const positiveInt = (value, fallback) => (Number.isInteger(value) && value > 0 ? value : fallback);
  return {
    tokenFile: trimmed(source.tokenFile) ?? defaultTokenFile(),
    defaultCwd: trimmed(source.defaultCwd) ?? homedir(),
    maxBodyBytes: positiveInt(source.maxBodyBytes, DEFAULT_MAX_BODY_BYTES),
    spawnWindowMs: positiveInt(source.spawnWindowMs, DEFAULT_SPAWN_WINDOW_MS),
    spawnMaxPerWindow: positiveInt(source.spawnMaxPerWindow, DEFAULT_SPAWN_MAX_PER_WINDOW),
  };
}

export function apply(ctx, input = {}) {
  const config = resolveConfig(input);
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('task-bridge: ctx.webServer is unavailable; mount @deepseek-ai/dsh-host-webserver first');
  }

  // 绑定面感知（非阻塞，蓝图 §2.4 项6）：webserver Config 允许 host:'0.0.0.0'——
  // 桥不假设宿主恒回环；运行时逐请求回环守卫才是真防线，此处只做强告警。
  try {
    if (webServer.host === '0.0.0.0') {
      ctx.logger?.warn?.(
        'task-bridge: host webserver binds 0.0.0.0 — the bridge refuses non-loopback remotes per request (token alone is not enough); consider host 127.0.0.1',
      );
    }
  } catch {
    /* host getter 永不阻断挂载 */
  }

  const tokenStore = new TokenStore(config.tokenFile);
  const gate = new RollingWindowGate({ windowMs: config.spawnWindowMs, max: config.spawnMaxPerWindow });
  // 惰性解析 taskCoordinator（PROTOCOL §17.2 约定3）：每次请求活取，coordinator
  // 后装载/禁用/卸载都能被正确反映（缺席 → ops undefined → 端点回 503）。
  const getCoordinator = () => (typeof ctx.get === 'function' ? ctx.get('taskCoordinator') : undefined);

  for (const endpoint of ENDPOINTS) {
    const handler = createEndpointHandler(endpoint, { config, tokenStore, gate, getCoordinator, logger: ctx.logger });
    const route = { kind: 'exact', path: endpoint.path, handler };
    // 照 webhook-github 注册模式：ctx.effect(() => webServer.register(route), label)
    // ——effect 面负责 fiber-scoped 自动反注册（插件卸载时清理路由）。
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => webServer.register(route), `task-bridge: ${endpoint.path}`);
    } else {
      webServer.register(route); // 无 effect 面时直接注册（丢失自动反注册能力）
    }
  }

  ctx.logger?.info?.(
    `task-bridge: ${ENDPOINTS.length} exact routes mounted on the host webserver (${ENDPOINTS.map((e) => `${e.method} ${e.path}`).join(', ')}); auth ${'X-Task-Bridge-Token'} via ${config.tokenFile}`,
  );
}
