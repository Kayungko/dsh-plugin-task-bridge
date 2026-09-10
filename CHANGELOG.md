# Changelog

本文件记录 `dsh-plugin-task-bridge` 的版本变更。格式参照 Keep a Changelog，版本遵循语义化版本。

## [0.1.0] - 2026-09-10

首个 MVP：本地回环 HTTP 控制面桥，让外部本机进程（Codex 总控 / 其 MCP wrapper）经宿主 webserver 的 exact 路由驱动 DSH 任务。设计基线 `research/task-bridge-reanchoring.md`；消费 `dsh-plugin-task-coordinator` 0.24.0 服务缝。

### 新增

- **六端点控制面**（蓝图 §0.2 收敛清单）：
  - `POST /v1/spawn` → `ops.spawnTask`（强制 `reportBack:false`，透出 workspace/placement/modelSource/correlationId/depth）
  - `POST /v1/send` → `ops.sendMessage`（透出 messageId/queueDepth/placement/targetStatus）
  - `GET /v1/progress` → `ops.progress`（冷热会话双路径，agentState/queue/recent/todos/goal/seq）
  - `GET /v1/wait` → `ops.waitFor`（长轮询，单次钳制 ≤50s，超时 200 `settled:false`，断连经 AbortSignal 中止服务端等待）
  - `GET /v1/list` → `ops.listTasks`（filter/team/limit/includeSubagents/ungrouped 透传）
  - `GET /v1/models` → `ops.models`（部署特定 provider/model 精确 id 目录 + default/pluginDefault 解析链）
- **服务缝消费**：惰性 `ctx.get('taskCoordinator')`（不硬 inject），只读 ops、不 monkey-patch、不 provide 同名（coordinator PROTOCOL §17.2 约定）；coordinator 缺席/禁用/无 ops 时全端点回 503 降级（对齐 webhook-github 503 语义）。
- **isolate 共享 label**：`cordis.patch.yml` 以独立 group 挂载，声明与 coordinator 同一字符串 label `'dsh-task-bridge'`（GlobalRealm 共享 Symbol `taskCoordinator@dsh-task-bridge`）。
- **安全纵深**（照官方 `dsh-webhook-github` 骨架 + 蓝图 §2.4 增强）：
  - `X-Task-Bridge-Token` 头 + `crypto.timingSafeEqual` 恒时比较（长度前置，照宿主 `tokenMatches` 先例）；
  - token 文件活读（mtime+size 戳缓存）支持热轮换，覆写即生效无需重启；token 不可用 fail-closed 503；
  - 逐请求回环自检（`127.0.0.1`/`::1`/`::ffff:127.*`，缺地址按非回环拒绝）+ 注册时 0.0.0.0 绑定强告警；
  - 方法白名单（405+allow）、Content-Type 收窄（415）、单值头校验（400）；
  - body 限长 256KB（Content-Length 预检先于 token + 流式累计双保险 + fatal UTF-8）；
  - 错误不回显（未鉴权路径静态文案）+ 503/500 兜底。
- **桥侧策略闸**：spawn 滚动窗口限流（默认 60s/10 次，config 可调），超限 429 `policy-gated` + `retryAfterMs` + `Retry-After` 头；堵住「串行单发绕过批量确认」治理漏洞（蓝图 §3.3.3 MVP 方案）。
- **伪 caller**：稳定身份 `{ sessionId:'task-bridge-external', origin:undefined, cwd }`，cwd 解析链「请求 cwd ?? config.defaultCwd ?? 用户主目录」；桥 spawn 恒 depth 1。
- **应答信封**：成功 `{ok:true,...payload}`；失败 `{ok:false,code,error}`，code 稳定枚举八值（unauthorized/forbidden-body/bad-request/policy-gated/rate-limited/queue-full/not-found/upstream-error）；ops 原始码经 `upstreamCode` 保留，孤儿 `sessionId` 透传供补救；rate-limited 附 `retryAfterMs`（取自 coordinator `config.minSendIntervalMs`）。
- **install.ps1**：copy-based 部署到 profile hoisted node_modules + manifest（dependencies/bundles）+ `.package-map.json`；首装生成 32 随机字节 → 64hex token（等价 `crypto.randomBytes(32).toString('hex')`），已存在不覆盖，尽力 ACL 收紧（仅当前用户）；`-Uninstall` 移除条目保留 token。
- **测试**：`smoke.mjs` 离线全规则（11 节 A-K：路由注册面/回环/鉴权矩阵/token 文件/body 规则/方法白名单/端点分发×形状/错误信封/策略闸/wait 断连/信封头）；`verify-installed.mjs` 安装态自检（mock ctx：入口/装载契约/路由表/鉴权矩阵端到端/spawn e2e reportBack:false+伪 caller/wait 钳制/降级 503）。junction 仿真安装态自证双双全绿。

### 说明

- 桥**自身不绑定 socket**——复用宿主 webserver（同端口 43120），exact 路由命中后零宿主鉴权，故 token 是唯一防线（README 安全节）。
- 桥是**纯服务消费方**：零 `@deepseek-ai/*` 源码 import，`smoke.mjs` 可完全离线运行。
- **不在 MVP**：`/v1/cancel`（第二批，可用 send 降级替代）、`/v1/confirm`+`/v1/spawn_batch`（二期，依赖 agent-less 弹卡验证）、`/v1/transcript`（已砍，OpenViking 记忆面承担叙事交接）。

### 未验证项

- 真机路由注册、真 token 端到端链路（红线：本任务不部署真实宿主、不打真机端点，留待总控集成）。
- isolate label 热切换实测（机制源码已验证；首次部署冷加载不涉及迁移）。
