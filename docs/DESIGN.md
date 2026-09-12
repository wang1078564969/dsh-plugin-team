# dsh-plugin-team 设计文档（现状版）

> **这份文档和其他文档的关系**
>
> - `team-agent-architecture/`（仓库外，`../team-agent-architecture/`）是**要做什么**：需求、协议、取舍的原始设计。
> - `docs/GAP-VS-DESIGN.md` 是**设计 vs 实现**的差距清单，以及每一批改了什么、为什么。
> - `docs/DESIGN.md`（本文）是**现在是什么**：把已经落地的代码反过来写成一份可以照着读、照着改、
>   照着接手的架构说明书。凡是本文写下的行为，都能在代码里指到位置；凡是代码里刻意不做的事，
>   本文也会说明理由。
>
> 读法建议：先看 §2 形态与 §3 总览图建立地图，再看 §5 数据模型与 §15 不变量（这两节是"改代码前必须知道的事"），
> 然后按链路读 §6–§12。§18 是本文自己承认的缺口。

---

## 1. 一句话形态

**一个 DSH 插件行（Cordis row），在宿主进程里把"飞书群"与"DSH 会话"缝成一条团队协作流水线**：
群里的一句话变成需求对象，需求拆成任务，任务经过两道人工确认后交给一个**真实的 DSH 执行会话**跑一轮，
结果回写成证据、回到群里播报、进台账与观测页。

它**不是**外部服务：没有独立进程、没有数据库、没有队列中间件，也不依赖任何公网入站。
持久化是**一对象一文件的 JSON 台账**加几份 append-only 的 jsonl；并发靠"单一写入者 + 每 card_key 串行化"。

体量：`lib/` 共 39 个模块 / 约 23.1k 行（其中浏览器半边 `client.js` 4.9k 行是手写经典脚本），
`test/` 35 个文件约 14k 行，**506 个用例**（`wc -l` 实测，2026-09-12）。

---

## 2. 形态：为什么是一个插件行

### 2.1 行（row）是唯一的安装单元

`cordis.patch.yml` 插入一行 `- id: team` → 装包即装插件，`dsh plugin remove` 即卸载。
包声明 `dsh.bundle.patch`，所以它自动进入 profile 的 bundles 栈；要配置或关掉，在 profile 自己的
`cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: team
  disabled: true
- id: team
  config: { dataDir: /path/to/team-data }
```

### 2.2 入口刻意很小，而且**两层兜底**

`lib/index.js`（169 行）只做三件事，每件都有一条踩过的坑：

| 它做的事 | 为什么必须这样 |
|---|---|
| 在 `apply()` **内部**动态 import `lib/team.js`（带 mtime 查询串） | Cordis 只 import 一次、Node 缓存模块：模块级 import 会把实现冻结在进程启动时那一版，改代码必须重启。带 mtime 的动态 import 让"保存即生效"成立 |
| import 或激活失败只**记日志并吞掉**（不 throw） | harness 的启动审计会把失败 row 的错误**重新抛出**，一个抛异常的插件能拖垮整个 harness。协作层绝不能有这个能力 |
| 把实现发布的 Fetch 路由挂到 `connection` 服务上（`ctx.inject(['connection'], cb)`） | 一是 `ctx.get('connection')` 在 web profile 里会**采样过早**（服务比最后一层 row 的 `apply()` 晚提供）→ 面板能渲染但路由 404；二是挂在 connection 的 `/api` 后面才有浏览器鉴权，否则一个能建任务、确认门禁的端点等于远程遥控 |

`inject` 只声明 `tools`，因为 `ctx.tools.register` 是**属性访问**，追踪代理要求先声明；
其余服务（`agents`、`timer`、`connection`、`sessionQuery`、`tokenMeter`、`workspaceRegistry`）
一律用 `ctx.get()` 可选读取 —— 声明一个可选服务会把整行在缺它的 profile 里**停住**（headless 就连台账和工具一起没了）。

### 2.3 服务依赖一览（全部可选，缺了就降级）

| 服务 | 用途 | 缺失时的行为 |
|---|---|---|
| `tools`（**唯一声明**的） | 注册 `team` 工具 | 没有它插件没有意义（声明它是对的） |
| `agents` | 起/复用执行会话（`lib/exec.js`） | `run_task` 返回 `session_unavailable`，其余功能照常 |
| `timer` | 门禁扫描、补发节流卡、日报、去重表清理 | 所有这些"到点发生的事"不发生，其余照常；日志里说明是缺 timer |
| `connection` | 挂三个 `/api/team/*` 路由 | 面板读不到数据（工具照常） |
| `sessionQuery` | 回忆里的**情景记忆**（跨会话全文检索） | `recall` 如实说"这一半没查"，文档与台账照常 |
| `tokenMeter` | 卡片 footer 的 token 数 | 那一段不显示（不写 0） |
| `workspaceRegistry` | 让机器人的会话出现在主机 DSH 客户端 | 会话不登记，其余照常 |

---

## 3. 总览图

```
                    飞书（长连接，我们自己拨号；无公网入站）
                              │  im.message.receive_v1 / bot.added
                              ▼
        ┌──────────────────────────────────────────────────────────┐
        │ lib/team.js  createFeishuController（每 app 一条连接）      │
        │  规范化消息 → 去重(event_id) → 群记录/定主 → 资产落库       │
        │      → 表态(reaction) → 分诊流水线 → 一个机器人回答          │
        └───────┬───────────────────────┬──────────────────┬───────┘
                │                       │                  │
        ┌───────▼────────┐   ┌──────────▼────────┐  ┌──────▼─────────┐
        │ 入站流水线      │   │ 执行（lib/exec）   │  │ 播报（notify）  │
        │ ingest/triage/ │   │ agents.create/    │  │ 决策→计划→降级链 │
        │ extract        │   │ resume + drive    │  │ →卡台账→节流补发  │
        └───────┬────────┘   └──────────┬────────┘  └──────┬─────────┘
                │                       │                  │
                └───────────┬───────────┴──────────────────┘
                            ▼
                 ┌──────────────────────┐        ┌────────────────────┐
                 │ 领域层 lib/domain     │        │ 观测              │
                 │ 两个状态机 + 门禁快照  │        │ logbus / metrics   │
                 │ 租约 / 超时扫描       │        │ assets / docs      │
                 └──────────┬───────────┘        └────────┬───────────┘
                            ▼                             ▼
                 ┌──────────────────────┐        ┌────────────────────┐
                 │ store：一对象一文件   │        │ 三个 /api/team/*   │
                 │ <dataDir>/{requirements,tasks,…}│（面板读与写）      │
                 └──────────────────────┘        └─────────┬──────────┘
                                                           ▼
                                          lib/client.js（GUI 侧栏 + 六个页签）
```

三条边各有明确的所有者，**不允许互相穿透**：

- **入站**只写"记录 + 需求对象"，它**不驱动**执行会话；
- **执行**只通过 `store` 与领域层改对象，它**不直接发飞书消息**（消息由 `notify` 决定与投递）；
- **播报**只读对象与决策，它**不改任何状态**（观测与播报都不能有副作用）。

---

## 4. 三个一等对象（+ 一条"群归谁"的规则）

### 4.1 机器人 `bots[]`

一个机器人 = **一个身份 + 一个角色 + 自己的飞书应用 + 自己的群 + 自己的会话**。

| 字段组 | 说明 |
|---|---|
| `id` / `displayName` / `role` / `baseRole` | 角色取 `req/dev/qa/coord/lib/ops/custom`；`baseRole` 决定它默认继承谁的权限与预设 |
| `agentPreset` / `model` | 它作为哪个 DSH agent 跑、用哪个模型（按机器人覆盖） |
| `feishu.appId` / `feishu.chats` / `feishu.speakPolicy` | 用哪个应用说话、服务哪些群（空 = 该应用下全部）、什么时候开口（`onMention`/`onIntent`/`leaseRequired`/`digestOnly`） |
| `capabilities` / `scope` / `budget` / `skills` / `knowledgePack` | 能做什么、能碰哪些仓库/文档、预算与知识包 |
| `enabled` | **默认关**：手写 roster 忘了写 `enabled` 不会突然在真群里说话 |

**应用是机器人的属性，不是全局配置**：没有"默认应用"这个概念；安装级 `feishu.appId` 只在加载时被
**采纳**进每台没写应用的机器人，从此是它自己的。

### 4.2 成员 `members[]`（角色域分配在**人**身上）

一个人一行：`key`（`human:<名字>`）、`name`、`openId`、`role`、`domains[]`、`projects[]`、
`canApprove[]`、`delegate`、`active`。兼容旧的 `{域: [人]}` 映射（读得进，写回落到 `domains`）。

### 4.3 会话：身份是**机器人 × 群**

`team-bot-<botId>-<chatId>`（私有群/任务另有规则），配一个**发言租约**：
同一条群消息在多条连接上各到一次时，先说话的那个把群占住 `feishu.speakLeaseMs`（默认 90s），
避免两个机器人同时对同一句话开口。

### 4.4 群的主机器人（用户补充的需求）

| 概念 | 函数 | 回答的问题 |
|---|---|---|
| 路由 | `routeBots()` | **谁来回这一条**（点名 > 已绑定 > 角色优先级） |
| 主 | `pickPrimaryBot()` | **这个群归谁记**（首次接触定，此后不变；换主是显式动作，记下谁改的、何时、之前是谁） |

每一条入站消息都记在主机器人名下（`botsession.seen`），`turns` 只数它真正回答过的轮次 ——
"记录"与"回答"必须分得开。

---

## 5. 数据模型与落盘布局

### 5.1 store：一对象一文件的 JSON 台账

`lib/store.js`（243 行）：`<dataDir>/<kind>/<id>.json`，原子写（写 `.tmp` 再 rename）。

`KINDS` 表（`lib/store.js:38`）决定目录、id 前缀与 id 风格：

| kind | 目录 | id 字段 | id 规则 |
|---|---|---|---|
| `requirement` | `requirements/` | `id` | `year-seq` → `req-2026-001` |
| `task` | `tasks/` | `id` | `seq` → `task-1` |
| `lease` | `leases/` | **`task`** | `follows-task`（id 就是任务 id） |
| `decision` | `decisions/` | `id` | `year-seq` → `adr-2026-001` |
| `session` | `runs/` | `id` | `follows-task`（执行会话按任务） |
| `chat` | `chats/` | `id` | `external`（群 id 原样，`oc_…`） |
| `botsession` | `bot-sessions/` | `id` | `external`（`<botId>.<chatId>`） |
| `card` | `cards/` | `id` | `external`（`cardRecordId(card_key)`：非 `[A-Za-z0-9._-]` 一律换 `.`，防路径穿越；原始 key 存在 `card_key` 字段里） |

### 5.2 其余落盘物

| 位置 | 内容 | 谁写 / 谁读 | 轮转与保留 |
|---|---|---|---|
| `<dataDir>/inbox/messages.jsonl` | 入站消息（append-only，最后一行赢）+ `event_id` 索引 | 流水线写 / 观测页、去重读 | `feishu.dedupeRetentionDays`（默认 30 天，tick 每小时清一次并重写文件） |
| `<dataDir>/logs/team.jsonl` | 结构化日志（**写入前脱敏**） | logbus 写 / 日志页读 | 2MB 轮转；内存环形缓冲 500 条 |
| `<dataDir>/assets/<id>/<原名>` + `assets/index.jsonl` | 入站图片/文件（`id = sha1(messageId + \0 + fileKey)[:16]`）+ 索引 | 控制器写 / 日志页读 | **无清理**（是消息内容，不是过程数据；同 key 重投不存第二份） |
| `<dataDir>/config.json` + `config.json.bak-<epochMs>` + `config-audit.jsonl` | 配置真身（0600）、备份、审计 | 配置台写 / 所有人读 | 审计只追加；**备份与审计都没有清理**（每次保存一份备份） |
| `<dataDir>/load-report.txt` | 入口加载失败的一行记录 | `lib/index.js` 写 | — |
| `<workspace>/docs/**` + `_meta/docs.json` | 团队文档库（主副本、走 git）+ 机器读的索引 | `lib/docs.js` | 索引是派生物，可重建 |
| `<workspace>/_drafts/`、`docs/_assets/` | 草稿区与文档附件 | 文档层 | — |

### 5.3 领域对象

`lib/domain/`（约 2.8k 行，从 hub 移植成纯 ESM JS、零依赖）：
`requirement` / `task` / `lease` / `decision` 的 schema（`schema.js` 1279 行）、
两个状态机（`machine.js` 845 行）、门禁快照与三条硬闸（`objects.js`）、租约（`lease.js`）、
超时扫描（`scheduler.js`）。

**门禁快照是冻结的**：任务创建时把四道门禁的**超时与策略**抄进任务对象，此后改配置**不影响进行中的任务** ——
这是设计 06 §4.2 的要求，也是"配置改了，正在跑的任务行为突然变了"这类事故的解药。

**但要分清楚冻的是什么**：冻结的是"**谁必须点头**"（`required_by`）与"超时怎么办"
（`timeout_snapshot` / `on_timeout`）；而"**谁有资格动手**"（`acceptors`、`pmOwners`、
成员表的角色）是**实时**的 —— 组织变化（有人转岗、停用、被设成 observer）应当立刻生效。
两者混为一谈会得出"改成员表不该影响权限"的错误结论。

**另外**：`initializeGates()` 必须在**建任务时**调一次。门禁的 `due_at` 只有它和状态机的
`activateDue` 会填，而新建任务停在 `proposed`（`confirm_split` 的激活状态），此时还没有任何
跃迁发生 —— 漏掉它，"8 小时没人确认拆解就催办"这条承诺在实现里就是装饰（调度器会直接跳过
`due_at === null` 的门禁）。

---

## 6. 入站链路（一条群消息的完整旅程）

> **两套形状，别混**：`normalizeMessage()` 的产物是 **camelCase**
> （`chatId` / `messageId` / `eventId` / `text` / `resources` / `addressed`…），
> 而**落进收件箱的那一行是 snake_case**（`message_id` / `event_id` / `chat_id` /
> `triage_kind` / `consumed_by` / `recorded_by`…，见 `lib/feishu/ingest.js` 的 `onMessage`）。
> 观测页、去重表、`schema.js` 的 `InboundMessage` 都按**后者**读。

顺序**不能改**，每一步的失败行为都写在括号里：

1. **规范化**（`lib/feishu/connection.js` `normalizeMessage`）：文本 / 富文本 `post`（压成 markdown）/
   图片 / 文件；`@机器人` 从正文里**删掉**（那是"在叫它"，不是内容），`@别人` 保留成 `@名字`；
   带上 `eventId` 与 `resources`。自己发的消息与其它 app 的消息**直接返回 null**。
2. **占位认领**（`inbox.claim()`，`lib/team.js`）：`event_id` 是权威键（重投时 `message_id`
   会变），`message_id` 兜底。**认领是同步的、发生在任何 `await` 之前** ——
   这是这一版修掉的一个真问题：以前"检查"在资产下载之前、而"记录"在下载之后，
   多应用（多长连接）下同一条消息的两次投递正好落在那个 await 的两侧，
   于是资产下载两次、群消息计数 +2、回执卡被 PATCH 两次。认领之后第二个到达者立刻看到记录。
3. **群记录与定主**：写入/更新 `chat`（`app_id`、`primary_bot_id`、`messages`、`last_inbound`），
   并把这行记在主机器人名下（`botsession.seen`）。这一步在**任何回答之前**发生。
4. **资产落库**（`lib/assets.js`）：图片/文件下载 → `assets/<id>/<原名>` → `asset://<id>`；
   `asset-ref:` 占位替换成真引用。**下载失败就没有引用**（指向空气的引用比"没收到"更糟），
   失败逐条写日志。这一步站在"记录是地板"一侧：流水线没起来也照做。
5. **准入**（可选收紧）：`feishu.requireRegisteredChat` 打开时，没登记的群连收件箱都不进，
   并在日志里说明为什么。
6. **表态**：被 @ 的消息加一个 reaction（`feishu.reaction`，默认开）。**表态 ≠ 会建单**，
   它是"我看到了"的唯一即时反馈；失败只记日志。
7. **纯非文本消息**：没有正文可判 → 记一条"已落库为资产"、回一句"已收到图片"、到此为止（不进分诊）。
8. **分诊**（`lib/feishu/triage.js`）：`requirement` / `status` / `question` / `smalltalk` /
   `command` / `noise`。**被 @ 压过词表**：@ 了机器人但分诊判成 status/question 的，仍然交给提取层
   （代价是一张待确认卡，收益是不会出现"我 @ 了它，它说没发现诉求"）。
9. **提取**（`lib/feishu/extract.js`）：标题、问题、建议方案、优先级、仓库、验收标准、缺失项。
10. **建单或落空**：新建需求（并回卡）、并入已有需求（去重 + 相似度）、追问缺失项（每群只问一次）、
    或**记下原因**（"漏单"就是靠这个可查）。
11. **命令**：`接受/开始/验收/拒绝/阻塞/打结…` 走状态机，**人不该排在模型后面等**。
12. **回答**：由**一个**机器人用它自己在这个群里的会话回答（`lib/feishu/responder.js`）；
    回复引用触发它的那条消息（话题隔离，引用失败自动退化为普通消息）。

---

## 7. 出站链路（"要不要说、怎么说、说出去了吗"）

`lib/notify.js`（517 行）+ `lib/feishu/broadcast.js`（1038 行）：

1. **决策**（`decideBroadcast`）：`immediate` / `digest` / `suppress`，理由逐条返回
   （门禁需要人、人类直接触发、状态跃迁、重复事件、进度类…）。
2. **@人配额**：同一个人当天被 @ 超过 N 次 → 通知照发但**改成静默待办**（`MentionQuota.asSilent`），
   卡片上也不再出现那个人的 `<at>`。
3. **计划**（`planDelivery`）：`create` / `update` / `resent` / `throttled` / `skip`。
   `update` 是"同一个话题只有一张卡"的落点（`card_key → message_id` 台账，**落盘**，重启之后仍更新那张卡）。
4. **每 `card_key` 串行化**：不串行就会建出两张卡 —— 机器人承接任务时 `accept` 与 `start` 连着发生，
   两次投递都会看到"还没有卡"。这是实测抓出来的真 bug（手工点两下复现不了）。
5. **投递**（`deliverCard`）：五级降级链，前三级 `PATCH` 原地更新、失败逐级降级：
   `card → card-plain-table → card-no-buttons → text → text-with-file`。
   **永远不抛**：失败返回 `{action:'failed'}` 并留一行日志。
6. **补发**：节流窗口（2 秒）内被并掉的卡由 5 秒定时器补一次原地更新 ——
   否则**最后一次跃迁永远不出现在群里**，而人只关心最后那个状态。
7. **日报**（每天 `feishu.dailyReportHour`）：摘要桶（键 `群|类型`）+ **现算的"在等谁确认"**。
   `digest` 模式的意义是"这类话不必马上说"，但**攒起来的东西必须有人说**。
8. **回执类**（收到图片/文件）也走这一层，所以节流/聚合/没有群就不发的规则**只有一份**。
9. **三个入口都兜住构造失败**：`task` / `notice` / `report` 各自 try 住卡片构造，失败返回
   `skip: card-build-failed` 并记日志 —— 播报层的"永远不抛"要靠每一个入口自己守住
   （`report` 曾经漏了，一次形状不对的 `lines` 会让**当天后面所有群都不发日报**）。
10. **"再提醒一次"必须换 id**：`card_key = callout:<id>`，同 id 的第二次投递是 PATCH。
    定时催办的 id 因此带上小时时间片（`reason:taskId:YYYY-MM-DDTHH`）——
    同一小时内合并，跨小时是一条新消息。

---

## 8. 执行链路

`lib/exec.js`（566 行）是"心脏"：`agents.create` / `resume` 起会话，`followup` 投一条消息，
等这一轮结束（事件监听 + 状态轮询 + `whenIdle()` 兜底，三者都不信任单一信号）。

`run_task` 的顺序（每一步都能单独拒绝），**并且同一个任务同一时刻只驱动一轮** ——
闸门是"读状态 → await 起会话 → await 驱动"，中间全是 await，模型并行调用或面板连点
都会各过一道闸、驱动两轮真实会话（真花 token、evidence 后写者赢）。进程内的
`runningTasks` 集合 + `try/finally` 释放解决它（第二个到达者拿到 `already_running`）。

`run_task` 的顺序：

1. **机器人能力闸**（`botCan(bot,'run_task')`，代码类任务再加 `write_code`）；
2. **作用域闸**（`botCanTouchRepo(bot, task.repo)`）；
3. 起/复用会话（`sessionSpecFor`：机器人自己的 preset/model，按任务角色）；
4. `drive(prompt, {timeoutMs})` —— prompt 里带验收标准、代码类任务还带**分支与 trailer 约定**；
5. 这一轮的**事实**（耗时/步数/token）写进会话记录（卡片的 footer 从这里取）；
6. 汇报写成 `evidence`（`writeTask` → 触发播报/摘要）；
7. `submit` 送进验收（被拒也如实返回"执行完成但提交被拒"）。

**超时不是静默失败**：没产出结论时返回 `turn_timeout` 并说明会话可以继续。

---

## 9. 权限与作用域：三层闸

| 层 | 实现 | 判什么 |
|---|---|---|
| **领域层** | `lib/domain/machine.js` 的动作表 + `transitionCtx` | "这个主体配不配做这个动作"（跨域任务要各域确认、执行者不能自己验收…） |
| **组织层** | `lib/members.js` `memberCanWrite`，**挂在 `createHandlers` 的统一出口上** | "这个人现在是不是能动手"（观察者只读、停用的人要走代理、`canApprove` 是白名单）。闸只写在 4 个 handler 里时，"观察者只读"对其余 30 多个写动作没有落点，而且漏一个是**静默**的；现在新增动作默认就在闸内。名册**非空**时它是白名单（只对人；`bot:*`/`role:*`/`system` 归机器人那层闸） |
| **机器人层** | `lib/bots.js` `botCan` / `botCanTouchRepo` | "这台机器人有没有这个能力 / 能不能碰这个仓库" |

配置里的 `permissions.cannot` 与 `scope.repos` 在这里**真的拦人**，而不是只做展示；
群准入另有三道：`requireRegisteredChat`、`chatAllowlist`、机器人自己的 `feishu.chats`。

---

## 10. 观测

| 能力 | 实现 | 页面 |
|---|---|---|
| 结构化日志（脱敏、双写、轮转） | `lib/logbus.js` | 日志页：级别/来源筛选、重启前文件日志 |
| 漏单 + 分诊结论 | `inbox` + `/api/team/logs` | 同页：每条消息"为什么没建单" |
| 降级率（哪一级在发） | `lib/metrics.js` | 投递统计：**落盘口径**（每条卡台账的 `via` —— 一行台账 = 群里的一条消息，跨重启成立）与**本进程口径**（逐次投递，重启清零）并排显示；后两级标"降级" |
| 每群机器人发言占比、@人次数、被静默数 | `lib/metrics.js` | 占比表；> 25% 且样本 ≥ 8 条 → tick 写一行 warn（按群冷却 30 分钟） |
| 卡片更新了几次 | `card` 台账（`deliveries`/`created_at`/`via`/`mention_count`） | 观测与排障 |
| 文档库与陈旧 | `lib/docs.js` | 团队文档一块：条数、类型分布、过期的那几行与原因 |

口径上两条刻意的选择：**重启不能让指标变好看**（分子分母都来自落盘事实）；
**假警报比没警报更糟**（样本不足不告警，但仍然画出来）。

---

## 11. 文档与记忆

- **沉淀知识**写工作区文件：`docs/{specs,decisions,runbooks,meetings,notes,requirements}/`，
  **frontmatter 是硬要求**（缺 `owner` 之类的必填字段一个字节都不写）；
  `docs/index.md`（人的入口）与 `_meta/docs.json`（机器读的）都是**派生物**，可重建；
  陈旧检测看引用图与"多久没更新"。
- **情景记忆**用 DSH 自己的会话历史（`ctx.sessionQuery`），**不建自建记忆库**。
- `lib/recall.js` 一次提问同时查文档、会话历史与台账，每条都带出处；
  查不到的那一半**如实说没查**，而不是拿空数组装作"历史上什么都没有"。

---

## 12. 仓库与 CI

**先说做不到的**：卡片按钮与 Git webhook 都要公网入站 HTTPS，而 DSH Web 只监听 `127.0.0.1`。
所以真正检出/提交/开 MR/合并的是执行会话里的 `git` / `gh`，插件负责：

1. **约定**：分支 `req/<需求>/<任务>`、提交带 `Req:`/`Task:` trailer（写进代码类任务的 prompt）；
2. **判定**：能不能合并由三道门说话（人类审批 + CI 通过 + 只有 ops 能合并）；
3. **记录与播报**：CI 状态机（`ci_start/ci_pass/ci_fail`）+ `ci_stuck` 超时播报 + 卡片 footer 的 `🧪`；
4. **知识索引**：扫一次真实检出 → `docs/specs/<repo>-overview.md`。

---

## 13. 配置面

### 13.1 两个名字陷阱（写在最前面，因为踩过）

| 你看到的 | 它其实是什么 |
|---|---|
| 台账快照里的 `config.members` | **域 → 负责人**的派生映射（旧形状） |
| 配置接口 `redact()` 后的 `members` | **成员表**（数组，人一行） |
| 配置页的 `domains` | 也是那张"域 → 负责人"映射 |
| 真正的域清单 | 叫 `knownDomains`（`lib/settings.js:126` 有专门注释解释这个撞名） |

### 13.2 优先级（**按代码的真实行为写，不按愿望写**）

```
环境变量（少量键） > row 的 config: 块 > <dataDir>/config.json > 默认值
```

⚠️ **row 压过配置文件** —— 这一点曾经在本文件与 `lib/config.js` 的注释里都写反了
（写成"文件优先"），于是一个"面板保存了却不生效"的现象看起来像 bug，其实是配置来源的
顺序问题。`lib/config.js` 里绝大多数键都是 `pick(row.X, file.X, 默认)`，`dataDir` 与
`feishu.mode` 另有 env 在前。

**这意味着**：如果 profile 的 `cordis.patch.yml` 里给某个键写了值，面板改它不会有任何
效果（保存会成功、值会落进 `config.json`，但读出来的仍是 row 的值）。所以面板必须把
"哪些键被 row 固定住了"说出来，而不是让操作者自己猜 —— 这是配置台待补的一项
（见 `docs/REVIEW-02.md` 的跟踪项）。
配置的**真身始终是那个文件**：面板是编辑它的界面，不是它的主人 —— 手写的 `//` 注释键、
面板不认识的键，保存时全部原样保留。

配置台四条约定：保存前校验（拒绝就一个字节都不写）、**密钥只写不读**（回显"已设置"，留空表示不改）、
保存即生效（`reload()` + 必要时就地重建长连接）、可审计（每次保存一行 `config-audit.jsonl` + 备份）。

---

## 14. 浏览器半边

`lib/client.js` 是**手写的经典脚本**（4.9k 行，无构建、无 JSX、无 ESM）：注册侧栏入口与中心面板，
数据全部走三个 `/api/team/*` 路由。六个页签：**台账 / 配置 / 机器人 / 成员 / 会话 / 日志**。

约束（改了会直接坏）：不能用 `import`/`export`/JSX；`React.createElement` 是全部词汇；
页面读不到宿主的任何对象，**只能读接口给的 JSON**；
所有写操作必须带 `actor`（接口层拒绝没有 actor 的写）。

---

## 15. 不变量（改代码前必须知道的事）

| # | 不变量 | 违反了会怎样 |
|---|---|---|
| 1 | 入口的两层 try/catch 不能去掉 | 一个加载错误拖垮整个 harness |
| 2 | `inject` 里只能声明 `tools` | 声明可选服务会把整行在缺它的 profile 里停住 |
| 3 | 去重发生在任何副作用之前 | 重投会重复下载、重复落盘、重复回执 |
| 4 | 播报层永远不抛、观测层只读 | 一次投递失败会弄坏刚落好的台账对象 |
| 5 | 同一 `card_key` 的投递必须串行 | 群里出现两张卡（刷屏） |
| 6 | 卡台账必须落盘 | 每次重启群里多一张新卡 |
| 7 | 门禁快照冻结 | 改配置会改变进行中任务的行为 |
| 8 | 记录是地板（不依赖流水线是否起来） | 最需要排查的时候反而什么都查不到 |
| 9 | 没上报的字段整段不显示（token/footer） | 卡片上出现"🧠 0 tok"这种谎报 |
| 10 | 观测指标的分母只数成功 | 失败混进降级率会让它假性变好 |
| 11 | 密钥只写不读、日志写入前脱敏 | 密钥进文件、进页面 |
| 12 | 写操作必须带 actor | 门禁被一个下拉框绕过 |

---

## 16. 失败模式与降级

| 失败 | 系统行为 |
|---|---|
| 飞书凭据缺失 / 长连接起不来 | 出站卡片仍可用；日志与自检页说明原因；入站为 0 |
| 协议层（分诊/提取）加载失败 | 消息照样记录，标注"分诊不可用"，不静默丢 |
| 执行会话起不来 | `run_task` 返回 `session_unavailable`，任务留在原状态 |
| 模型这一轮超时 | 返回 `turn_timeout`，任务留 `in_progress`，会话可继续 |
| 卡片发送失败 | 五级降级；全失败返回 `failed` + attempts，台账不受影响 |
| 某个群没有来源群（DSH 里建的需求） | `skip: no-chat`（这不是错误） |
| 没有 `timer` | 门禁超时不扫描、节流不补发、日报不发；日志说明 |
| 没有 `sessionQuery` | `recall` 的门票少一半，如实说明 |
| 文件坏了（inbox/assets 索引） | 能读多少读多少，坏行报错但不让整个功能不可用 |

---

## 17. 测试策略

- **零依赖**：`npm test` = `node test/run-all.mjs`，34 个文件 494 个用例，跑的是真实模块（不是 mock 世界）。
- **可选渲染测试**（4 个文件）：真 react + jsdom 把面板渲出来、真点击、真断言 POST body；
  没装就跳过（`TEAM_CLIENT_TEST_MODULES` 指向任意装好它们的目录）。
- **oracle 差分**：领域层用 hub 的 zod 实现当参照做了 12 368 例差分；分诊/提取层做过 0 差异差分。
- **走真实入站路径的用例**：喂伪造飞书事件走 `handleInbound`（记录、定主、资产、去重都在这条路上验）。
- **每个"踩过的坑"都有一条用例**：两张卡的竞态、改派不重置门禁、footer 丢失、失败停在加载态、
  点筛选读到旧条件、重投重复下载、需求收口断路、自动释放的死任务、按钮关不掉的死按钮。
- **与机器无关**：`test/run-all.mjs` 把 `DSH_HOME` 指向一个空临时目录。以前有若干用例
  没传 `dataDir`，于是它们读的是**开发者本人的真实 `config.json`** —— 测试结果与这台机器有关，
  而这会让别的缺陷时隐时现。

---

## 18. 代码地图

按行数与职责（`wc -l`，2026-09-12）：

| 模块 | 行数 | 职责 |
|---|---|---|
| `lib/client.js` | 4924 | 浏览器半边：手写经典脚本，侧栏入口 + 六个页签 |
| `lib/tools.js` | 2100+ | `team` 工具的**全部 39 个动作**（台账、门禁、执行、CI、仓库、文档、回忆），以及三条横切规则：未知 action → `bad_request`、调用方是执行会话 → 拒绝（worker 不得改台账）、handler 抛错 → `handler_failed` |
| `lib/domain/schema.js` | 1279 | 四类对象的 schema 与校验（逐字对照 hub，含 `.strict()`） |
| `lib/domain/machine.js` | 873 | 两个状态机（含 CI 与归档的身份守卫） |
| `lib/feishu/broadcast.js` | 1038 | 播报决策、节流、聚合、@配额、卡片构造 |
| `lib/team.js` | 1001 | Feishu 控制器：连接池、入站分发、群记录、日报、接线 |
| `lib/domain/machine.js` | 845 | 两个状态机的动作表与效果 |
| `lib/feishu/ingest.js` | 748 | 入站流水线（去重、命令、分诊→提取→建单） |
| `lib/settings.js` | 737 | 配置台 host 半边：校验/原子写/审计/自检 |
| `lib/feishu/cards.js` | 723 | 卡片渲染与五级降级链、发送边界 |
| `lib/feishu/extract.js` | 642 | 从一段话里抽出需求要素与相似度 |
| `lib/bots.js` | 633 | 机器人名册、能力、作用域、路由与定主 |
| `lib/api.js` | 593 | 三个 HTTP 路由（台账 / 配置 / 日志） |
| `lib/docs.js` | 596 | 文档载体：frontmatter、索引、陈旧检测 |
| `lib/feishu/connection.js` | 601 | 长连接、事件规范化、富文本与资源提取 |
| `lib/exec.js` | 566 | 执行会话池：起/复用/驱动/等一轮结束 |
| `lib/notify.js` | 517 | 出站：决策→投递→台账→补发，@人行与统计 |
| `lib/feishu/responder.js` | 493 | 一个机器人怎么回答（发言策略、租约、引用） |
| `lib/feishu/triage.js` | 459 | 分诊（沟通 ≠ 需求） |
| `lib/config.js` | 438 | 配置解析与优先级 |
| `lib/feishu/client.js` | 398 | 出站传输：token 缓存、非零 code 当失败、资源下载 |
| `lib/repos.js` | 377 | 分支/trailer 约定、CI 状态、合并判定、仓库索引 |
| `lib/domain/objects.js` | 338 | 门禁快照与三条硬闸 |
| `lib/feishu/richtext.js` | 294 | markdown → 飞书卡片/文本 |
| `lib/members.js` | 269 | 成员表与写权限 |
| `lib/store.js` | 243 | 一对象一文件的台账 |
| `lib/domain/lease.js` | 234 | 租约与到期判定 |
| `lib/metrics.js` | 231 | 降级率与发言占比 |
| `lib/assets.js` | 219 | 入站资产落库与 `asset://` |
| `lib/logbus.js` | 216 | 结构化日志（脱敏、轮转、查询） |
| `lib/domain/scheduler.js` | 215 | 门禁与租约的超时扫描 |
| `lib/workspace.js` | 213 | 把机器人的会话挂进主机 DSH 的会话列表 |
| `lib/sessions.js` | 211 | 会话身份（机器人 × 群）与消息记录 |
| `lib/index.js` | 169 | 入口：boot-safe + 动态 import + 挂路由 |
| `lib/domain/index.js` | 158 | 领域层 barrel |
| `lib/feishu/apps.js` | 151 | 按飞书应用分组（一 app 一连接一身份） |
| `lib/tasktypes.js` | 141 | 任务类型 → 域映射（10 域 / 9 类型） |
| `lib/recall.js` | 99 | 回忆：文档 + 会话历史 + 台账 |

## 19. 改动指引（要改什么，去哪里）

`team` 工具现在有 **39 个动作**（`buildTeamTool().parameters.properties.action.enum`）。
其中**写动作统一过一道成员闸**（`createHandlers` 出口处的包装，不在各 handler 里）：
纯读动作（`list`/`show`/`list_chats`/`recall`/`tick`）与按 `op` 判定的读子命令
（`docs op=list|read|search|stale`、`repo op=branch|index`）不需要 actor，其余都需要。

| 想做的事 | 改哪里 | 别忘了 |
|---|---|---|
| 加一个模型能调的动作 | `lib/tools.js`：`actions` 加实现 + `buildTeamTool()` 的 enum/参数/描述 | 用例；涉及写对象就走 `writeTask()`（播报挂在它上面）；**默认就会过成员闸**（除非把它加进 `ACTOR_FREE`）；参数要写进 schema，否则 `additionalProperties: false` 会让它传不进来 |
| 加一种卡片 | `lib/feishu/broadcast.js` 加构造函数；`lib/notify.js` 加一个入口（`task`/`notice`/`report` 同形） | 卡片 spec 的字段（`status`/`confirm_line`/`at_line`/`footer`）在 `cards.js` 里渲染；footer 只放"真的有"的字段 |
| 加一个页签 | `lib/client.js`：`tabButton()` 加一个 + 渲染函数 + `TeamLedger` 里取数 | 页签数与路由数的断言在 `test/client-half.test.mjs`；新读取路径要自己在 `lib/api.js` 加 |
| 加一个接口 | `lib/api.js` 的对应 `create*Api`：`snapshot()` 给数据、`handler()` 处理方法与 body | 写操作必须校验 `actor`；路由要挂进 `lib/index.js` 的 `routes` 数组 |
| 加一个配置键 | `lib/config.js` 解析（带默认值）+ `lib/settings.js` 的校验/可编辑清单 | 配置台要为它渲染一个字段；`config.example.json` 与 README 同步 |
| 加一个持久化对象 | `lib/store.js` 的 `KINDS` 表（目录/前缀/id 风格） | 一对象一文件；id 必须能进文件名 |
| 加一种入站消息类型 | `lib/feishu/connection.js`：`normalizeMessage` 取正文 + `resourcesOf` 认资源 | 非文本要能在流水线里"记录但不出结论"；去重在副作用之前 |
| 加一个观测指标 | `lib/metrics.js`（算）+ `lib/api.js` 的 `createLogsApi`（给）+ `lib/client.js`（画） | 分子分母都要是**落盘事实**，否则重启就变好看 |
| 改权限判定 | `lib/members.js`（人的组织事实）/ `lib/bots.js`（机器人的能力）/ `lib/domain/machine.js`（领域规则） | 三层各管各的：混在一起会让领域层依赖组织配置 |

## 20. 部署与运维

```console
# 安装（在 profile 里）
dsh plugin --profile web add link:/path/to/dsh-plugin-team

# 装完必查两条
dsh --profile web --dump-config > /tmp/tree.yml
node ~/.dsh/profiles/web/plugins/inventory-check.cjs /tmp/tree.yml
#   entries checked: 153 → identified: 153, loose modules: 0, THROWING: 0
```

- **重启语义**：`lib/team.js` 及其依赖是动态 import（带 mtime），保存后在面板上重新生效即可；
  **入口 `lib/index.js` 与 `cordis.patch.yml` 的改动要重启宿主**。
- **数据**：默认 `~/.dsh/team`（env `DSH_TEAM_DATA` 覆盖）。备份这个目录 = 备份台账、收件箱、日志、资产与配置。
- **工作区**：`workspace` 既是执行会话的 cwd，也是团队文档库（`docs/`）的根。
- **自检入口**：面板「配置」页的接入自检（真调飞书：身份、长连接、群列表、台账计数）；
  日志页（级别/来源/漏单/降级率/占比/文档/资产）。
- **与飞书桥插件的关系**：一个飞书应用只能有一条长连接，**`dsh-plugin-feishu-bot` 不能同时跑**
  （它会抢走同一个应用的事件）。

## 21. 这份文档承认的缺口

（功能完备性的系统审查见 `docs/REVIEW-01.md` / `REVIEW-02.md`，本节只列写文档时已知的）

0. **两轮审查的跟踪**：第一轮 22 条（4 P0 已修）见 `docs/REVIEW-01.md`；第二轮的镜头是
   "**这一批改动有没有引入新问题**"与"**从零装一台到日常用起来，哪一步会卡住**"，
   结论见 `docs/REVIEW-02.md`。本节的缺口表按两轮结论更新。 —— 系统性的功能完备性审查见 `docs/REVIEW-01.md`
   （22 条发现，其中 4 条 P0 已修）；第二轮见 `docs/REVIEW-02.md`。
1. **没有自治的"计划"层**：任务没有子步骤/进度百分比，`footer` 里的步数是"上一轮工具调用数"，
   不是"3/5 步"那种计划进度。
2. **审批三档**（允许一次 / 本次会话 / 始终）与 DSH 的 approval 服务还没接。
3. **token/成本按机器人按天**没有聚合。
4. **入站只处理文本/富文本/图片/文件**：语音、转发合并消息、表情回应、撤回都还没接。
5. **文档写的"跨机器副本同步"**没有实现（设计 01 §2 的权威副本 vs 各人副本）—— 目前假定单一写入者。
6. **面板无法触发文件预览/下载资产**：`asset://` 引用能在页面看到，但点不开。
