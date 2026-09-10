# DSH⇄Codex 跨端编排生态总览（ECOSYSTEM）

> 定位：本文是**生态级**入口——五个组件如何拼成一个「Codex L1 ⇄ DSH L2 双层总控」系统、怎么装、怎么运维、出了问题去哪查。单组件细节各归其 README。
> 状态：全链实机验证（2026-09-10）。维护约定：任一组件升版或通道语义变化，同步更新本文版本矩阵与通道表。

## 1. 全景图

```
┌─ Codex 侧（L1，一级总控）─────────────────────────────┐
│  Codex 会话 (thread)                                   │
│   ├─ dsh-orchestration skill（纪律大脑：工作流/授权阶梯）│
│   ├─ dsh_task_* MCP 工具（6 个，推理中结构化调用）       │
│   ├─ dshq CLI（十命令：台账/别名/信箱/派发/纠偏/等待）   │
│   └─ heartbeat 定时巡检（原生 automation，分钟级自唤醒）  │
└──────────────┬────────────────────────────────────────┘
               │ HTTP（回环 127.0.0.1:43120/v1/*，X-Task-Bridge-Token）
┌──────────────▼─ DSH 侧 ───────────────────────────────┐
│  dsh-plugin-task-bridge（六端点，token 唯一防线）        │
│   └─ 服务缝 → dsh-plugin-task-coordinator ops 实例      │
│        └─ task_* 工具面 → L2 总控会话 → 子任务舰队       │
│           （工作区归属五级链 / 编排视图 / GUI 设置页）    │
└──────────────┬────────────────────────────────────────┘
               │ 反向：文件信箱 C:\Users\admin\.dshq\outbox\
               │（DSH 写信 → Codex heartbeat 巡检发现 → ack）
               └─ 共享记忆：OpenViking（两端自动召回/捕获）
```

## 2. 组件地图

| 组件 | 仓库/位置 | 版本基线 | 角色 | 文档入口 |
|---|---|---|---|---|
| task-coordinator（含服务缝） | Kayungko/dsh-plugin-task-coordinator（`plugin/`） | ≥ v0.25.0 | DSH 侧编排核心：11 工具 + provide `{config,version,ops}` 缝 + externalRef 全链 | 其 README / `docs/PROTOCOL.md §17`（缝契约） |
| task-bridge | Kayungko/dsh-plugin-task-bridge（`bridge/`） | ≥ v0.2.0 | 回环 HTTP 控制面：六端点包 ops，安全全责 | `bridge/README.md`（安全模型必读） |
| bridge-mcp | Kayungko/dsh-task-bridge-mcp（`bridge-mcp/`） | ≥ v0.3.0 | Codex 侧 MCP wrapper（6 工具）+ dshq CLI + 台账/别名/信箱 | `bridge-mcp/README.md`、`docs/cross-agent-playbook.md` |
| dsh-orchestration skill | `C:\Users\admin\.agents\skills\dsh-orchestration\`（共享目录，两端可见） | 随 bridge-mcp | Codex 侧操作纪律：四工作流/拉模型/信件授权阶梯 | `SKILL.md` |
| 文件信箱 + heartbeat | `C:\Users\admin\.dshq\outbox\` + Codex 原生 automation | — | DSH→Codex 确定性递送 + 无人巡检自唤醒 | playbook §B/§E |

## 3. 五条通道（全部实机验证）

| # | 通道 | 方向 | 机制 | 时延 | 首验 |
|---|---|---|---|---|---|
| 1 | 读（侦察） | L1→L2 | `dshq list/status/progress`（GET） | 秒级 | 09-10 首航 121 任务 |
| 2 | 写（指挥） | L1→L2 | `dshq send/spawn`（POST，伪 caller `task-bridge-external`，reportBack 结构性关闭） | 秒级送达，目标轮边界消费 | 09-10 问候闭环 |
| 3 | 回（回执） | L2→L1 | 回信约定：【L2→L1】置顶 ≤200 字写入转录，L1 `dshq reply` 拉取 | L1 拉取时 | 09-10 逐字命中 |
| 4 | 信（长内容） | L2→L1 | 信箱：DSH 写信落 outbox（frontmatter to/status），Codex `dshq mailbox` 读+ack | Codex 巡检时 | 09-10 两封委托信 |
| 5 | 醒（自触发） | L2 侧无 → L1 自治 | Codex heartbeat 定时续接原 thread 巡检信箱+舰队 | 分钟级，**零人工** | 09-10 16:28 演习信三步白名单 |

身份互认：L1 派发带 `--ref <thread短id>:<波次>`→ DSH registry/list/progress 全链可反查；L1 侧 pin 别名 + waves 台账永不手贴长 ID。

## 4. 快速开始（安装顺序有依赖，不可乱序）

1. **task-coordinator ≥0.25.0**：`plugin/install.ps1` → 重启 DSH（服务缝是宿主面代码）
2. **task-bridge ≥0.2.0**：`bridge/install.ps1`（首装自动生成 64hex token 于 `~/.dsh/task-bridge-token`，已存在不覆盖）→ 重启 DSH
3. **bridge-mcp**：clone 即用（零依赖）；MCP 挂载＝`~/.codex/config.toml` 加 `[mcp_servers.dsh-task-bridge]`（command=node + `src/server.mjs` 绝对路径，**零凭据入配置**）
4. **skill**：拷 `bridge-mcp/skills/dsh-orchestration/` 到 `C:\Users\admin\.agents\skills\`
5. **验证**：`dshq version`（桥可达+token 来源）→ `dshq status` → 探针 spawn/watch/reply 一轮
6. （可选）**heartbeat**：照 playbook §E2 模板在目标 thread 创建，5 分钟档首验后转 30 分钟正式档

## 5. 安全模型速览（细节在 bridge/README「安全模型（必读）」）

- **token 是唯一防线**（exact 路由零宿主鉴权，探针实证）：恒时比较、文件权限即边界、覆写即热轮换（无需重启）
- 仅回环 + 非回环 403 + body 256KB 限长 + 自定义头防 CSRF
- 策略闸：60s/10 次 spawn 滚动窗口（429 policy-gated + retryAfterMs）
- 桥派发**不过 GUI 确认卡**（凭证 callerSessionId 绑定对桥结构性不可用）——纪律替代闸门：串行派发 + ref 可审计 + 信件四级授权阶梯（playbook §E4）
- 脱敏红线：token/凭据绝不进 argv、日志、仓库、对话正文（两端记忆库共享，进对话即进记忆）

## 6. 运维手册

| 操作 | 方法 | 生效 |
|---|---|---|
| token 轮换 | 覆写 `~/.dsh/task-bridge-token`（64hex） | **即时**（两端惰性重读） |
| 桥/coordinator 升版 | 各自 install.ps1 → **重启 DSH** | 重启后 |
| CLI/MCP/skill 升级 | git pull bridge-mcp（skill 拷共享目录） | Codex 下次调用即新 |
| 队列深度上限 | DSH GUI 设置→任务编排（0-50，活读） | **免重启** |
| 桥默认工作区 | profile patch `task-bridge-runtime.config.defaultCwd` | 重启后 |
| 故障排查 | playbook §D 故障速查表（401/refused/429/空 recent/截断/没信） | — |

## 7. 双层总控工作流（L1 视角模板）

在 Codex 会话里一句话即可开工（详见 playbook §A）：

> 在 DSH 开一个二级总控：dshq spawn「你是 <项目> 的 L2 总控，工作目录 <DSH工作区路径>；拆波次派发（单发串行免确认卡）、独立复验每份汇报、通过→写信上报 L1（to=本 thread）+转录置顶【L2→L1】摘要、不通过→task_send 纠偏续跑；你没有 reportBack，一切上报走信箱；契约疑义停下写信问 L1」--cwd <路径> --team <名> --ref <thread短id>:<波次>；派完 pin 别名并 watch。

治理边界：桥生 L2 记 depth=1，其子任务 depth=2 顶格（孙辈派发被拒，需调 `maxSpawnDepth`）；L2 批量派发（batch≥2）会在 DSH GUI 弹确认卡等人点，无人链用单发串行。

## 8. 版本矩阵与设计史

| 日期 | 里程碑 |
|---|---|
| 09-05 | 三子agent评估定案独立插件（2:1）；随后暂停 |
| 09-08 | 双层总控可行性确认；OpenViking 记忆层评估（记忆有用/控制不行） |
| 09-09 | 再锚定调研（2 行缝发现/鉴权探针矩阵/端点裁剪/MCP 载体）；用户立项+拍板桥不过弹卡 |
| 09-10 上午 | 实施波次三件套交付（缝 v0.24.0 / 桥 v0.1.0 / MCP v0.1.1）；探针 10/10；首航三通道闭环 |
| 09-10 下午 | recent 恒空缺陷修复（v0.24.1）；Codex 工具包两轮（v0.2.0/v0.3.0：dshq/台账/别名/信箱）；externalRef 端到端（v0.25.0 + 桥 v0.2.0）；**heartbeat 首验通过（16:28，本机首次代理自唤醒）** |

调研文档索引（`D:\git\DHS-Tool\research\`）：task-bridge-reanchoring.md（设计权威）· codex-side-toolkit-spec.md · dshq-ledger-mailbox-spec.md · codex-selftrigger-survey.md · cross-agent-playbook 在 bridge-mcp/docs/。

## 9. 许可

MIT（各组件仓库同）。
