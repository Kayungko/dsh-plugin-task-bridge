# dsh-plugin-task-bridge

> 本地回环 HTTP 控制面桥 —— 让外部本机进程（如 Codex 总控 / 其 MCP stdio wrapper）驱动 DeepSeek Harness（DSH）的任务会话。
>
> 版本 **0.2.0** · 许可 MIT · 宿主 DSH Desktop（cordis 插件架构）

外部驱动方没有 DSH 的进程内 agent 上下文，无法直接调用 `task_*` 工具。本桥在宿主 webserver 上注册 6 条 **exact 路由**，把 HTTP 请求翻译成对 `dsh-plugin-task-coordinator` **服务缝**（`taskCoordinator` 服务的 `ops` 实例）的调用，从而以「拉非推」（long-poll `wait` + 轮询 `progress`）模型驱动 DSH 任务。

设计基线与取证见 `research/task-bridge-reanchoring.md`（本仓库上级 `D:\git\DHS-Tool\research`）；服务缝消费契约见 `dsh-plugin-task-coordinator` 的 `docs/PROTOCOL.md §17`。

---

## 目录

- [架构](#架构)
- [前置依赖](#前置依赖)
- [安装 / 卸载](#安装--卸载)
- [安全模型（必读）](#安全模型必读)
- [端点契约](#端点契约)
- [错误码表](#错误码表)
- [配置参考](#配置参考)
- [消费指南（给外部驱动方）](#消费指南给外部驱动方)
- [测试](#测试)
- [限制与未验证项](#限制与未验证项)

---

## 架构

```
  外部本机进程（Codex CLI / MCP stdio wrapper / 任意 HTTP 客户端）
        │  HTTP  头 X-Task-Bridge-Token: <token>
        ▼
  宿主 webserver  127.0.0.1:43120（exact 路由命中后零宿主鉴权）
        │  /v1/spawn  /v1/send  /v1/progress  /v1/wait  /v1/list  /v1/models
        ▼
  dsh-plugin-task-bridge（本插件，独立 group，isolate 共享 label 'dsh-task-bridge'）
        │  中间件链：① 回环自检 ② 方法白名单 ③ body 限长预检 ④ token 恒时比较
        │            ⑤ body 读取 ⑥ 端点分发（策略闸 / 字段校验）
        │  惰性 ctx.get('taskCoordinator').ops   （只读，不 monkey-patch）
        ▼
  dsh-plugin-task-coordinator 0.24.0+ 服务缝（同一 ops 实例，与 GUI 内总控共享
        限流计数 / spawn 注册表 / 确认凭证 —— 无双写者分叉）
        ▼
  DSH 会话原语（spawn / send / progress / wait / list / models）
```

**关键设计**：

- 桥**自身不绑定任何 socket**——它把路由注册到宿主既有的 webserver（同端口 43120），复用宿主的 HTTP 栈。
- 桥是**纯服务消费方**：零 `@deepseek-ai/*` 源码 import，只经 `inject: ['webServer']` 与惰性 `ctx.get('taskCoordinator')` 取运行时服务。因此 `smoke.mjs` 可完全离线运行。
- 桥与 GUI 内总控**共享同一 ops 实例**（方案 A，蓝图 §1.4）：限流、注册表、确认凭证天然一致，不存在两个 limiter 各限各的正确性缺陷。

---

## 前置依赖

| 依赖 | 要求 | 缺失时行为 |
|---|---|---|
| `@deepseek-ai/dsh-host-webserver` | 提供 `webServer` 服务（`register`/`host`） | `apply()` 抛错，桥不挂载（硬依赖） |
| `dsh-plugin-task-coordinator` **0.25.0+**（服务缝自 0.24.0） | 服务缝：`provide('taskCoordinator', { config, version, ops })`，且其插件组 isolate 改为共享 label `'dsh-task-bridge'`；**externalRef 全链（registry 持久化/回执/list/progress 透出）需 0.25.0+**——0.24.x 下该字段被 ops 静默忽略（不报错、不落盘） | 桥仍挂载路由，但所有端点回 **503 upstream-error**（惰性 `ctx.get` 返回 undefined 或载荷无 ops） |

> **isolate 共享 label 是双向的**：coordinator 组与本桥组都必须在各自 `cordis.patch.yml` 声明 `isolate: { taskCoordinator: 'dsh-task-bridge' }`，cordis 加载器才会让两者共享同一 GlobalRealm Symbol（`taskCoordinator@dsh-task-bridge`）。coordinator 0.24.0 已落地此改动；本桥 `cordis.patch.yml` 声明同一 label。

---

## 安装 / 卸载

copy-based 部署（照 `dsh-plugin-task-coordinator` 先例，不跑 pnpm、不动 lockfile）：

```powershell
# 安装到默认 profile（%USERPROFILE%\.dsh\profiles\desktop）
pwsh install.ps1

# 自定义 token 路径（须与插件 config.tokenFile 一致）
pwsh install.ps1 -TokenFile D:\somewhere\task-bridge-token

# 卸载（移除 bundle 条目与目标目录；保留 token 文件）
pwsh install.ps1 -Uninstall
```

`install.ps1` 做四件事：

1. 拷贝插件文件到 `<profile>\node_modules\dsh-plugin-task-bridge`（原地覆写）；
2. 更新 profile manifest（`dependencies` 加 `file:` specifier、`dsh.profile.bundles` 加包名）与 `.package-map.json`（只增不删）；
3. **首次安装生成 token 文件**：32 随机字节 → 64 位小写十六进制（等价 `crypto.randomBytes(32).toString('hex')`），默认路径 `%USERPROFILE%\.dsh\task-bridge-token`；**已存在则绝不覆盖**；尽力收紧 ACL（禁用继承 + 仅当前用户完全控制，失败仅告警）；
4. 安装前备份 manifest 到 `backups\<时间戳>\`。

安装/卸载后**重启 DSH Desktop** 生效。

---

## 安全模型（必读）

### token 是唯一防线

宿主 webserver **没有可继承的统一鉴权层**：exact 路由命中后，handler 被直接调用，零宿主鉴权介入（探针矩阵实证，蓝图 §2.2——未命中命名路由的请求走裸 404，不经过 GUI 的 BrowserAuth）。因此：

> **桥 token（`X-Task-Bridge-Token` 头 + 恒时比较）是访问这 6 个端点的唯一防线。** 任何能向 43120 端口发起回环请求并持有 token 的本机进程，都能 spawn/send/cancel DSH 任务。

防御纵深（照官方 `dsh-webhook-github` 骨架 + 蓝图 §2.4 增强）：

| 防御项 | 实现 | 失败应答 |
|---|---|---|
| **回环自检** | 逐请求校验 `req.socket.remoteAddress` ∈ {`127.0.0.1`, `::1`, `::ffff:127.*`}；缺地址按非回环处理（fail-closed）。注册时若 `webServer.host === '0.0.0.0'` 强告警（webserver Config 允许 0.0.0.0，桥不假设宿主恒回环） | 403 `unauthorized` + warn 日志 |
| **token 恒时比较** | `crypto.timingSafeEqual` + 长度前置检查（照宿主 `dsh-client-connection` 的 `tokenMatches` 先例）；token 文件不可用 → fail-closed 503 | 401 `unauthorized` / 503 `upstream-error` |
| **单值头校验** | `headersDistinct[name]` 长度必须 === 1（防头注入/走私） | 400 `bad-request` |
| **方法白名单** | 每端点固定 GET 或 POST；不符 → 405 + `allow` 头 | 405 `bad-request` |
| **Content-Type 收窄** | POST 必须 `application/json`（至多一个 utf-8 charset 参数） | 415 `forbidden-body` |
| **body 限长** | Content-Length 预检（先于 token）+ 流式累计双保险 + fatal UTF-8 解码；默认 256KB | 413/400 `forbidden-body` |
| **策略闸** | spawn 滚动窗口限流（默认 60s/10 次） | 429 `policy-gated` |
| **错误不回显** | 未鉴权路径的错误文案全为静态串，不含请求数据；ops 错误文案仅对已鉴权的本机驱动方透传 | —— |
| **CSRF** | 自定义头（非简单头）迫使跨站请求走 CORS preflight，而桥不返回任何 CORS 头 → 浏览器跨站无法伪造带 token 的请求 | —— |

### token 轮换方法

token 文件被 `TokenStore` 以 `(mtimeMs, size)` 为缓存戳**活读**：覆写文件后，**下一个请求即生效，无需重启宿主**。

```powershell
# 轮换（生成新 token 并覆写；旧 token 立即失效）
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$token = -join ($bytes | ForEach-Object { $_.ToString('x2') })
$tokenFile = Join-Path $env:USERPROFILE '.dsh\task-bridge-token'
Set-Content -Path $tokenFile -Value $token -NoNewline -Encoding ascii
Write-Host "新 token（请同步给外部驱动方）: $token"
```

轮换后须把新 token 同步给所有外部驱动方（Codex MCP wrapper 的 env / `http_headers_helper` 等）。

> **同长度轮换的边界**：若新 token 与旧 token 字节长度完全相同且写入发生在同一毫秒（`mtimeMs` 未变），缓存戳可能不刷新。实践中随机 64-hex token 同长概率高，但同毫秒覆写极罕见；如需绝对保险，轮换后对文件 `touch` 一下（更新 mtime）即可。`smoke.mjs` D 节覆盖了「同长度 + mtime 变化」与「异长度」两条轮换路径。

### 脱敏红线

测试与文档中的 token 一律合成假值（`test-token-*`），**绝不读取/引用/生成真实 token 文件内容进仓库**。`install.ps1` 生成的真实 token 只落在用户主目录的 token 文件里，不入库、不打日志。

---

## 端点契约

Base URL：`http://127.0.0.1:43120`（宿主 webserver 同端口）。所有端点均为 **exact 路由**，应答 `content-type: application/json; charset=utf-8`。

**信封**（固定契约②）：

- 成功：`{ "ok": true, ...payload }`
- 失败：`{ "ok": false, "code": "<稳定枚举>", "error": "<文案>", ...补救字段 }`
  - `code` ∈ `unauthorized` / `forbidden-body` / `bad-request` / `policy-gated` / `rate-limited` / `queue-full` / `not-found` / `upstream-error`
  - 失败信封可携带上游上下文字段：`upstreamCode`（原始 ops 码）、孤儿 `sessionId`、`retryAfterMs` 等

所有请求须带头 `X-Task-Bridge-Token: <token>`。

### 端点×方法×请求/应答形状对照表

| 端点 | 方法 | 请求 | 成功应答（`ok:true` + 透传字段） | 主要失败 |
|---|---|---|---|---|
| `/v1/spawn` | POST | body：`{ prompt!, title?, cwd?, team?, sessionId?, provider?, model?, reasoningEffort?, externalRef? }`（客户端的 `reportBack` 一律忽略，桥强制 `false`；`externalRef` 见下方契约注） | `sessionId, shortId, title?, team?, externalRef?, cwd, workspace({id,title}\|null), placement, normalizedFrom?, note?, warning?, model?, modelSource?, started, correlationId, depth, hint` | `policy-gated` 429 / `bad-request` 400 / `upstream-error` 502（含孤儿 `sessionId`） |
| `/v1/send` | POST | body：`{ sessionId!, text!, mode?='queue'\|'steer', reference? }` | `delivered, targetId, mode, messageId?, reference?, placement, targetStatus, queueDepth{nextTurn,nextStep}, hint, note?` | `rate-limited`/`queue-full` 429 / `not-found` 404 / `bad-request` 400 |
| `/v1/progress` | GET | query：`sessionId!` | `sessionId, shortId, team?, externalRef?, title, cwd, updatedAt, todos, goal, agentState('idle'\|'running'\|'cold-idle'), queue[], recent[], seq?, note?, inspectError?` | `not-found` 404 / `bad-request` 400 |
| `/v1/wait` | GET | query：`sessionId`（可重复）或 `sessionIds`（逗号分隔），`timeoutMs?`（钳 ≤50000，缺省 45000），`mode?='all'\|'any'` | `mode, settled(bool), reason, waitedMs, count, targets[{sessionId,idle,agentState}], sessionId?, hint?` —— **超时也是 200**（`settled:false`） | `bad-request` 400 / `upstream-error` 500 |
| `/v1/list` | GET | query：`filter?, team?, limit?(1..500,缺省50), includeSubagents?(bool), ungrouped?(bool)` | `count, truncated, callerSessionId, team?, ungrouped?, tasks[]`（行含 `team?`/`externalRef?` registry 富化）`, hint` | `bad-request` 400 |
| `/v1/models` | GET | —— | `default?, pluginDefault?, providers[{id,name?,models[{id,name?,efforts[],defaultEffort?}]}], failedProviders?, hint` | `upstream-error` 503 |

> **externalRef（v0.2.0，wire 契约 C1——`research/dshq-ledger-mailbox-spec.md` Part C，两端锁死不得单方更改）**：外部派发方的自由文本对应标识（建议格式 `<thread短id>:<波次名>`，如 `01a08955:sgame-m3`）。string、可选、trim 后 ≤200 字符；空串/仅空白视为缺席；非字符串或超长 → `bad-request`（桥侧校验先于 ops，违规请求不消耗配额外的 ops 调用）。DSH 侧**只存储回显、不解析**：coordinator（0.25.0+）registry 持久化、spawn 回执回显（trim 形态）、`/v1/list` 行与 `/v1/progress` 均透出——供外部驱动方反查「这个 DSH 会话是我的哪个对话/波次派的」。coordinator 0.24.x 会静默忽略该字段（peerDependencies 已抬至 >=0.25.0）。

> **cancel / confirm / spawn_batch / transcript 不在 MVP**：蓝图 §0.2 将 `/v1/cancel` 列为第二批（⏸，可用 `/v1/send` 发停止指令降级替代），`/v1/confirm`+`/v1/spawn_batch` 列为二期（依赖 agent-less 弹卡端到端验证），`/v1/transcript` 已砍（OpenViking 记忆面承担叙事交接）。

### curl 示例（token 用占位符 `$TOKEN`）

```bash
TOKEN=$(cat ~/.dsh/task-bridge-token)   # 仅示意；Windows 用 type %USERPROFILE%\.dsh\task-bridge-token
BASE=http://127.0.0.1:43120

# spawn（reportBack 被桥强制 false，反馈走 wait+progress 拉取；externalRef 可选，
# 带上派发方的会话/波次标识以便日后反查对应，见端点契约注）
curl -s -X POST "$BASE/v1/spawn" \
  -H "X-Task-Bridge-Token: $TOKEN" -H 'content-type: application/json' \
  -d '{"prompt":"实现 X 功能","cwd":"D:/git/proj","team":"feat-x","externalRef":"<thread短id>:feat-x"}'

# wait 长轮询（单次 ≤50s；settled:false 则续 call 形成心跳）
curl -s --max-time 55 "$BASE/v1/wait?sessionId=session-xxx&timeoutMs=45000" \
  -H "X-Task-Bridge-Token: $TOKEN"

# progress（读活状态）
curl -s "$BASE/v1/progress?sessionId=session-xxx" -H "X-Task-Bridge-Token: $TOKEN"

# send 纠偏（steer 在运行中插话；queue 排队下一轮）
curl -s -X POST "$BASE/v1/send" \
  -H "X-Task-Bridge-Token: $TOKEN" -H 'content-type: application/json' \
  -d '{"sessionId":"session-xxx","text":"改用方案 B","mode":"steer"}'

# list（换会话后重建指挥上下文）
curl -s "$BASE/v1/list?team=feat-x" -H "X-Task-Bridge-Token: $TOKEN"

# models（查部署特定的合法 provider/model id —— 永远不要猜）
curl -s "$BASE/v1/models" -H "X-Task-Bridge-Token: $TOKEN"
```

---

## 错误码表

桥信封 `code` 是**稳定枚举**（固定契约②，三任务共用，不得增删改）。HTTP status 细分，`upstreamCode` 保留原始 ops 码。

| code | HTTP | 触发条件 |
|---|---|---|
| `unauthorized` | 401 / 403 | token 头缺失/错值（401）；非回环远端地址（403） |
| `forbidden-body` | 400 / 413 / 415 | 请求体被拒：Content-Type 非 JSON（415）、body 超限（413）、非法 UTF-8 / 非法 JSON / JSON 非对象 / 流中止（400） |
| `bad-request` | 400 / 405 | 语义校验失败（缺 `prompt`/`text`/`sessionId`、`mode`/`limit`/`timeoutMs` 非法、重复/畸形 token 头）；方法不符（405） |
| `policy-gated` | 429 | 桥侧滚动窗口 spawn 限额超限（附 `retryAfterMs` + `Retry-After` 头）；或 ops `spawn-depth-exceeded` |
| `rate-limited` | 429 | ops `rate-limited`（附 `retryAfterMs`，取自 coordinator `config.minSendIntervalMs`）/ `target-busy` |
| `queue-full` | 429 | ops `queue-full`（目标积压消息达上限） |
| `not-found` | 404 | ops `target-not-found` / `target-vanished` |
| `upstream-error` | 500 / 502 / 503 | ops 不可用（服务缺席/无 ops，503）；ops 抛异常或部分失败（`model-select-failed`/`kickoff-rejected`/`spawn-create-failed`/`resolve-failed` 等，502，孤儿 `sessionId` 透传）；ops 返回不可识别结果（500）；桥内部异常（500） |

ops 码 → 桥码的完整映射见 `endpoints.mjs` 的 `OPS_CODE_MAP`。未列出的 ops 码一律归 `upstream-error`/500。

---

## 配置参考

全部可选，缺省即用内置默认。profile 层可在 `cordis.patch.yml` 的 `task-bridge-runtime` entry 覆盖，或直接改本插件 `cordis.patch.yml`。

| 键 | 类型 | 默认 | 语义 |
|---|---|---|---|
| `tokenFile` | string | `<homedir>/.dsh/task-bridge-token` | token 文件路径（固定契约①） |
| `defaultCwd` | string | `<homedir>` | 伪 caller 的兜底 cwd（请求未带 cwd 时用） |
| `maxBodyBytes` | 正整数 | `262144`（256KB） | POST body 上限（固定契约⑧） |
| `spawnWindowMs` | 正整数 | `60000` | 策略闸滚动窗口长度（固定契约⑦） |
| `spawnMaxPerWindow` | 正整数 | `10` | 窗口内 spawn 配额（固定契约⑦） |

> `wait` 单次封顶 `WAIT_MAX_TIMEOUT_MS = 50000`（固定契约⑤）是**硬常量，不可配置**——对齐 Codex MCP `tool_timeout_sec` 默认 60s，留序列化余量。缺省 `WAIT_DEFAULT_TIMEOUT_MS = 45000`。

---

## 消费指南（给外部驱动方）

本桥是「拉非推」控制面：外部驱动方（Codex）没有入站通道，只能主动 call。推荐循环：

1. **spawn** 派发任务 → 拿 `sessionId`（记下 `correlationId` 供 send 的 `reference` 引用）。建议带 `externalRef: '<thread短id>:<波次名>'`（v0.2.0，契约 C1）——DSH 侧 registry/回执/list/progress 全链存储回显，换会话后可经 `/v1/list` 反查「哪些任务是本轮对话派的」。
2. **wait** 长轮询（`timeoutMs ≤ 50000`）：
   - `settled:true` → 任务空闲，读 **progress** 看结果；
   - `settled:false`（超时，HTTP 200）→ **同一 turn 内续 call wait** 形成心跳（不要当成错误）。
3. **progress** 读活状态：`agentState`（idle/running/cold-idle）、`queue`（待处理消息）、`recent`（尾部转录摘录）、`todos`/`goal`。
4. **send** 纠偏：
   - `queueDepth.nextTurn ≥ 2` → 该消息要约 N 轮后才被读；若它要改变目标的下一步，改用 `mode:'steer'`（运行中插话，扩展当前轮）。
   - 收到 `rate-limited`（429）→ 按 `retryAfterMs` 等待再试；桥**不自动重试**（重试会撞 coordinator 的 2s 限频），节奏交还驱动方。
5. **孤儿会话补救**：spawn 返回 `upstream-error` 且带 `sessionId`（`model-select-failed`/`kickoff-rejected`）→ 会话已建但未正常开场；驱动方可对该 `sessionId` 补 send 开场，或（二期 cancel 上线后）取消它。
6. **换会话重建上下文**：用 `/v1/list?team=<workstream>` 找回「自己的」任务（registry 按 team 持久登记，宿主重启后仍在）。
7. **模型路线**：spawn 传 `provider`+`model` 前，先 `/v1/models` 查部署特定的合法 id —— 永远不要猜。

> **reportBack 恒 false**：桥 spawn 的任务不会向桥「汇报」（伪 caller `task-bridge-external` 非真实会话，回报后缀会指向不存在的目标）。反馈一律走 wait+progress 拉取。

---

## 测试

```bash
node --check index.mjs auth.mjs endpoints.mjs policy.mjs smoke.mjs verify-installed.mjs  # 语法
node smoke.mjs            # 离线全规则（11 节 A-K，零网络/零宿主/零真实凭据）
node verify-installed.mjs # 安装态自检（mock ctx；仓库/安装位置/junction 仿真均可跑）
```

- **`smoke.mjs`**：mock ops + mock webserver 注册面，覆盖鉴权矩阵、回环拒绝、body 限长、策略闸、wait 钳制、reportBack:false 强制、伪 caller 形状、错误信封映射、wait 断连中止、externalRef 四态（0.2.0，契约 C1：传/不传/超长/非字符串 + 200/201 trim 边界）等全部规则。
- **`verify-installed.mjs`**：mock ctx 安装态，断言路由表注册齐全、鉴权矩阵端到端、spawn 走到 mock ops 且参数含 `reportBack:false`、externalRef trim 透传/回执回显/超长拒绝、降级 503。
- **junction 仿真安装态**（开发期自证，先例 `dsh-plugin-web-search-mana`）：把插件文件拷入临时目录，在其中 `node_modules\@deepseek-ai` 建 junction 指向宿主 `app.asar.unpacked\node_modules\@deepseek-ai`，再于该目录运行 `verify-installed.mjs`——忠实复刻 profile node_modules 树的解析环境。本插件零 `@deepseek-ai` import，junction 为环境保真（非解析必需）。

---

## 限制与未验证项

| # | 项 | 状态 |
|---|---|---|
| 1 | **真机路由注册**：桥在真实运行的宿主 webserver 上注册 6 条 exact 路由、与 GUI/api 路由共存无冲突 | **未验证**（红线：本任务不部署到真实宿主、不打真机端点；留待总控集成） |
| 2 | **真 token 链路**：`install.ps1` 生成的真实 token 文件 → 宿主内 `TokenStore` 活读 → 外部进程持 token 访问的端到端 | **未验证**（同上；smoke/verify 用合成 token + 临时文件覆盖逻辑） |
| 3 | **isolate label 热切换**：coordinator 从 `true` 升级到共享 label 时的 patch-context 迁移 | 机制源码已验证（蓝图 §6 未验证项2）；**热切换实测未做**（首次部署是冷加载，不涉及迁移） |
| 4 | **confirm/spawn_batch 弹卡通道**：agent-less `userQuestions.ask` 全局 waterfall 端到端 | 二期；MVP 用串行 spawn + 桥侧策略闸替代（蓝图 §3.3.3） |
| 5 | **cancel 端点** | 第二批（蓝图 §0.2 ⏸）；MVP 可用 `/v1/send` 发停止指令降级替代 |

---

## 文件清单

| 文件 | 职责 |
|---|---|
| `index.mjs` | 入口：`name`/`inject['webServer']`/`apply`；配置解析；6 条 exact 路由注册；0.0.0.0 绑定告警 |
| `auth.mjs` | `TokenStore`（mtime+size 戳缓存热轮换）+ `tokenMatches`（timingSafeEqual 恒时比较）；纯模块 |
| `policy.mjs` | `RollingWindowGate` 滚动窗口 spawn 限流（时钟可注入）；纯模块 |
| `endpoints.mjs` | 中间件链 + 6 端点实现 + ops 包装 + `OPS_CODE_MAP` 信封映射 + 防御骨架（照 webhook-github）；纯模块 |
| `cordis.patch.yml` | 装载声明：独立 group + 共享 isolate label `'dsh-task-bridge'` |
| `install.ps1` | copy-based 部署 + 首装随机 token 生成 + 卸载 |
| `smoke.mjs` | 离线全规则冒烟（11 节） |
| `verify-installed.mjs` | 安装态自检（mock ctx） |

## 许可

MIT。
