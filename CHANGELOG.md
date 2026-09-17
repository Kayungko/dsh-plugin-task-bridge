# Changelog

## [0.3.0] - 2026-09-18

### 收编正式化（0918 总控）

- 正式化 09-12 Codex 协作波次提交 47d8982（新增同等鉴权 /v1/capabilities 运行时能力端点 + progress 增量 cursor/messageId 透传）——当时随 plugin 线部署在产，现收编补版本。收编验证：smoke 全绿 + 活体探针 models/list 200（2.0.10 宿主）。

### Codex 协作增量（09-12 波次原文）

新增同等鉴权的 /v1/capabilities；progress 透传 cursor/messageId，旧 coordinator 不支持时明确 capability-unavailable；原六业务端点和八种错误码不变。

仅源码变更，不表示已部署、重启或完成实机验收。

本文件记录 `dsh-plugin-task-bridge` 的版本变更。格式参照 Keep a Changelog，版本遵循语义化版本。

## [0.2.1] - 2026-09-12

### 变更

- **宿主要求声明规范化**（五仓统一标准，权威文档 `ECOSYSTEM.md §9`）：`@deepseek-ai/dsh-host-webserver` peerDep 从无界 `>=0.1.2-rc.1` 收紧为 `>=0.1.2-rc.1 <0.2.0 || >=0.1.5-rc.1 <0.1.6`。两处修正：①semver 预发布规则下原范围实际**不含** 0.1.5-rc.1（预发布版只命中同 [major,minor,patch] 元组的比较器），市场/安装校验会误报 mismatch；②无界范围补上 `<0.2.0` 防波。运行时零变化（copy 部署不跑 npm 解析，此线是校验面+文档防线）。
- verify-installed 版本断言同步 0.2.1。

## [0.2.0] - 2026-09-10

externalRef 端到端会话对应（桥端）——与 `dsh-plugin-task-coordinator` v0.25.0 同波施工，设计权威 `research/dshq-ledger-mailbox-spec.md` Part C（wire 契约 C1 两端锁死）。解决「经桥派发的 DSH 会话无法反查是哪个外部对话/波次派的」（桥伪 caller 恒为 `task-bridge-external`）。

### 新增

- **`POST /v1/spawn` 接受可选 `externalRef`**（wire 契约 C1）：string、可选、trim 后 ≤200 字符；空串/仅空白视为缺席（`null`/`undefined` 与其他可选字段同规）；非字符串或超长 → `bad-request`（400，桥侧校验**先于 ops**——违规请求不触达 coordinator，也不消耗策略闸配额外的 ops 调用）。语义=自由文本（建议格式 `<thread短id>:<波次名>`），桥只校验透传、不解析。
- **全链透出**：externalRef 经 ops.spawnTask（coordinator 0.25.0+）持久化进 spawn registry，spawn 成功回执回显（trim 形态，经 callOps 原样透传）；`GET /v1/list` 行与 `GET /v1/progress` 由 coordinator 侧 registry 合并路径自动透出（桥零改动——成功载荷本就原样透传）。

### 变更

- `peerDependencies` 的 coordinator 要求 `>=0.24.0` → **`>=0.25.0`**：0.24.x 的 ops.spawnTask 会**静默忽略** externalRef（不报错、不落盘），抬版本线避免「ref 已带上」的假对应信心；六端点其余行为对 0.24.x 无破坏（copy-based 部署不跑 npm 解析，peer 线是文档性防线）。
- README：版本头、前置依赖表（coordinator 0.25.0+ 与静默忽略警示）、端点对照表（spawn 请求/回执、list/progress 透出）、externalRef 契约注、curl 示例、消费指南第 1 步、测试节。

### 测试

- `smoke.mjs` G 节增 externalRef 四态块：传（trim 透传 ops + 回执回显 + 恰好 200 放行）、不传（缺席/null/空串/仅空白 → ops 参数不含键）、超长（trim 后 201 → 400 bad-request 且 ops 未调；trim 前 201/trim 后 200 → 放行）、非字符串（数字/布尔/对象/数组 → 400）。`verify-installed.mjs`：版本断言 0.2.0；⑤ spawn e2e 增 externalRef trim 透传/回执回显/超长拒绝零触达。junction 仿真安装态 ALL PASSED。

### 未验证项

- 真机写端点（活体 `dshq spawn --ref probe:c1` → list/progress 命中 → DSH registry 落盘核对）：桥运行中实例仍是 v0.1.0，**本波次不部署不打真机**（红线），部署与活体验证归总控。

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
