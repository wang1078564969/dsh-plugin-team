# 与设计文档的差距（可核对版）

这份表回答一个问题：**`team-agent-architecture/` 里设想的东西，插件现在做到了多少。**
每一行都带代码证据（`file:line`）或明确的"找不到"。它取代凭印象的"差不多了"。

## 怎么读

- 图例：**✅ 已实现**（有代码 + 有测试断言）· **🟡 部分**（字段/配置/移植的代码在，但行为没接上）· **❌ 没实现**
- **证据口径**：✅ 必须能指到 `dsh-plugin-team/` 里的 `file:line`。
  `hub/` 是旧的外部实现，**它的功能不算**；`09-implementation-status.md` 记的是 hub 的状态，
  所以那份文档里的 ✅ **不能**当作插件的 ✅ ——这一条是这份表存在的最大理由。
- **工作量**：S ≈ 一两天（一个文件 + 测试）· M ≈ 几个文件或一个新页面 · L ≈ 新子系统/横切改造
- **前提已变**：设计写在"自建 Hub 常驻节点 + SQLite + HTTP 控制台 + `bots/*.yaml`"的形态上。
  插件形态下这些前提不成立，相关条目要按新形态重做，而不是照抄。

## 一、协作协议闭环（最高优先：不闭环，"协作"就不成立）

| # | 能力点 | 文档位置 | 状态 | 代码证据 | 缺什么 | 工作量 |
|---|---|---|---|---|---|---|
| 1 | **超时催办/升级真的通知到人** | 06 §4.2、02 §4 | ❌ | `lib/tools.js` `tick()` 只 `decided.push(...)`（`lib/tools.js:545-591`），全程没有出站调用 | 门禁到期、租约将失效、`escalate_to_owner` 现在**只写日志**：人不会知道有活等他 | M |
| 2 | **播报决策引擎接线**（immediate/digest/suppress + 节流 + 聚合 + `card_key` 幂等 + @配额 + 占比告警） | 04 §2.1-2.3 | 🟡 | 引擎已移植且测试完整：`decideBroadcast` `lib/feishu/broadcast.js:113`、`BroadcastThrottle:236`、`DigestAggregator:296`、`cardKeyOf:363`、`BroadcastChannel:376`、`planDelivery:464`；**运行时只用了卡片构造函数**（`lib/feishu/ingest.js:398`） | 没有任何调用点；`feishu/client.js` 连 `request()`/更新消息都没有（只有 `call/send/sendThrough`） | M |
| 3 | **五级降级投递 + 原地更新卡片** | 04 §2.1、§3.2 | 🟡 | `cards.degradationLadder` ✅ 用在 `lib/feishu/ingest.js:235`；`deliverCard(client,target,card,{patchMessageId})` 已移植（`lib/feishu/cards.js` 540+/643 `PATCH /im/v1/messages/:id`） | 运行时不用 `deliverCard`（它要 `client.request()`，而真 transport 没有这个方法）；卡片**永远是新消息**，同一个任务会刷出多张 | M（与 #2 同一件） |
| 4 | **状态机的"可做动作"要都能触发** | 06 §4.1 | 🟡 | 机器里有：`reject/block/unblock/suspend/resume/drop/archive/unassign/reassign/ci_start`（`availableActions` 实测输出）；工具只暴露 13 个动作（`lib/tools.js:711`） | 群里 `拒绝/阻塞` 两个命令**映射到不存在的 handler**（`DEFAULT_COMMANDS` 有 `reject_task`/`block_task`，`handlers` 里没有）→ 回了句"这个动作还没有接上" | S |
| 5 | **需求对象跟着任务走到 `done`/`archived`** | 06 §3.1 | 🟡 | `verify_task` 只 `transitionTask(..., 'verify')`（`lib/tools.js:524-530`），**没有 `transitionRequirement`** | 需求永远停在 `dispatched`；`done/archived/changed/blocked/suspended/dropped` 都没有入口 | S |
| 6 | **决策对象（ADR）** | 06 §6、02 §3 | ❌ | store 有 `decision` kind，schema 有校验（`lib/domain/schema.js:1143`），`list` 支持它（`lib/tools.js:758`） | **没有任何创建入口**：`grep "put('decision'"` 为空；面板也不展示 | S |
| 7 | **权限矩阵真正拦人**（`permissions.can_create/can_update/cannot/writes_to/approval_required`） | 02 §2 | ❌ | `lib/bots.js` 只把这些字段归一化；`grep "permissions\."` 在 tools/domain 里**零命中** | "机器人不能给自己派活/不能改需求原文/不能合并"目前靠状态机隐式挡了一部分，配置里的矩阵完全没用上 | M |
| 8 | **作用域 `scope`（projects/repos/docs/memory_scopes）** | 02 §2 | ❌ | 同 #7，字段只在名册里 | 机器人能碰什么没有任何边界 | M |
| 9 | **预算与超限行为（`budget.dailyTokens/dailyCostUsd/onExceed`）** | 02 §2、03 §2 | ❌ | 字段在 `lib/bots.js`；`grep budget` 在运行时零命中 | 没有记账、没有超限动作 | M |
| 10 | **角色 persona 真的进 prompt** | 02 §2 | ❌ | `persona{tone,language}` 只在 `lib/bots.js:130` 归一化 | 会话装配时不带它，等于没有 | S |
| 11 | **多人验收门禁**（设计："多人协作由主 owner 确认"） | 06 §3.1、08 | 🟡 | 移植时按 hub 原样保留，README 已知问题里钉着（`required_by` 两人时 ping-pong） | 语义没定：现在既不是"任一域负责人"也不是"全部确认" | S |
| 12 | **消息表态（reaction）** | 04 §0.1（已定） | ❌ | `grep reaction` 只命中注释 | 收到 @ 消息先表态这条没做 | S |
| 13 | **分诊结论可见** | 04 §0.2 | 🟡 | 结论写进了 `inbox/messages.jsonl` 与日志（`lib/feishu/ingest.js`） | 面板看不到（见 #18），群里也不说 | S |

## 二、飞书交互与播报（细节）

| # | 能力点 | 文档位置 | 状态 | 代码证据 | 缺什么 | 工作量 |
|---|---|---|---|---|---|---|
| 14 | 长连接 / 一 app 一连接 / 多应用 | 04 §0、02 §1.2 | ✅ | 自己拨号 `lib/feishu/connection.js` `createConnectionPool`；`lib/feishu/apps.js` 按应用分组；实测多应用各自解析 | — | — |
| 15 | 事件去重（重启有效） | 04 §4.1 | ✅ | `Inbox` 追加 `inbox/messages.jsonl`（`lib/feishu/ingest.js`），`skipped:'duplicate'` 有测试 | — | — |
| 16 | 消息分诊（沟通≠需求） | 04 §0、02 §2.2（新增设计） | ✅ | `lib/feishu/triage.js` + 两组测试 | — | — |
| 17 | 群内指令（接受/开始/验收/拒绝/阻塞/状态） | 02 §4、04 §3.3 | 🟡 | 解析与门禁都在（`lib/feishu/ingest.js`），但两个动作没 handler（见 #4） | 见 #4 | S |
| 18 | 日志页（问题第一眼） | 05 §4.0 | ❌ | 面板五个页签里没有日志；`inbox` 只在自检里报条数 | 出问题只能去 `~/.dsh/team/` 里 grep | S |
| 19 | 通知回填（人不在时补发） | 04 §0 | ❌ | `grep backfill/回填` 零命中 | 未做 | M |
| 20 | 文档镜像 `mirror_docs` | 04 §0、01 §6 | ❌ | `grep mirror` 只命中注释 | 未做（依赖 #21 的文档载体） | L |
| 21 | @人配额、机器人发言占比告警 | 04 §2.3 | 🟡 | `MentionQuota`（`lib/feishu/broadcast.js:163`）已移植 | 引擎没接线（见 #2） | M |
| 22 | 报告卡（日报/周报） | 04 §2.1、02 §1.1（coord） | ❌ | 无 | 调度机器人的核心产出没有 | M |

## 三、工作区 / 文档 / 记忆（路线图）

| # | 能力点 | 文档位置 | 状态 | 代码证据 | 缺什么 | 工作量 |
|---|---|---|---|---|---|---|
| 23 | 工作区目录规范 | 01 §3 | 🟡 | 台账自己的目录（`requirements/` `tasks/` …）由 `lib/store.js` 建；`workspace/` 是执行会话的 cwd | 设计里的 `workspace/docs/`（团队文档库）没有约定与初始化 | S |
| 24 | Frontmatter 硬要求 | 01 §4.1 | ❌ | `grep frontmatter` 零命中 | 文档没有元数据头 → 检索/陈旧检测无从谈起 | M |
| 25 | 索引可重建 | 01 §4.3 | ❌ | 无（设计已建议：优先用 DSH 自己的检索，不自建索引器） | 未做 | M |
| 26 | 陈旧检测 | 01 §4.6 | ❌ | `grep 陈旧` 零命中 | 未做 | M |
| 27 | 写入冲突（乐观锁） | 01 §4.4 | ❌ | 无（设计已把优先级降下来：文档走 git） | 未做 | S |
| 28 | 记忆生命周期 | 07 全篇 | ❌ | `grep 记忆` 只在注释里 | 07 的结论是"复用 DSH 会话历史 + 工作区文件"，插件还没接 | L |
| 29 | 人员画像 | 07 | ❌ | `grep 画像` 零命中 | 未做 | L |
| 30 | 技能库 / 知识包 | 02 §2.1 | 🟡 | `skills[]`、`knowledgePack` 字段在名册里（`lib/bots.js`） | 没有任何装配或加载逻辑 | L |

## 四、外部系统对接

| # | 能力点 | 文档位置 | 状态 | 代码证据 | 缺什么 | 工作量 |
|---|---|---|---|---|---|---|
| 31 | Git 分支/提交约定 | 03 §1.3 | ❌ | 无 | 执行会话在一个工作目录里跑，没有任何分支约定 | M |
| 32 | MR 门禁 | 03 §1.4 | ❌ | `canApprove` 只是成员表里的一个数组 | 没有任何 MR 对接 | L |
| 33 | CI 状态机 | 03 §1.5 | 🟡 | 机器里有 `ci_start` 动作与 `ci_running` 状态（`availableActions` 实测） | 没有任何 CI 对接，也没有触发它的入口 | L |
| 34 | 仓库知识索引 | 03 §1.7 | ❌ | 无 | 未做 | M |
| 35 | 需求 ↔ 仓库关联 | 03 §1 | 🟡 | `knownRepos` + 提取器能认出仓库名并落到 `task.repo` | 只存了个名字：不检出、不校验、不用 | S |
| 36 | 内网方案 | 03 第二部分 | ❌ | — | 设计要求按插件形态重写 | — |

## 五、配置台

| # | 能力点 | 文档位置 | 状态 | 代码证据 | 缺什么 | 工作量 |
|---|---|---|---|---|---|---|
| 37 | 配置即文件 + 界面编辑 | 05 §1-2 | ✅ | `lib/settings.js` + `lib/api.js` + 面板「配置」页；校验不过一个字节不写、`.bak-` 备份、审计行 | — | — |
| 38 | 机器人页 / 成员页 / 会话页 | 05 §4.3-4.4 | ✅ | 面板五个页签（`lib/client.js`） | — | — |
| 39 | 模型与预算页 | 05 §4.5 | 🟡 | 名册里有 `model.primary`（会话真的用它）与 `budget` 字段 | 预算是死字段（见 #9）；没有"这一页" | M |
| 40 | 通知页 | 05 §4.6 | ❌ | 无 | 通知策略现在只有每机器人的 4 个开关 | M |
| 41 | 接入自检 | 05 §4.1 | ✅ | `diagnostics`（凭据/身份/长连接/所在群/台账计数）真调飞书 | — | — |
| 42 | 敏感页二次确认 / 设备令牌 | 05 §3.2-3.3 | 🟡 | 面板走 DSH 自己的 cookie 围栏（`/api` 前缀） | 没有"按人"的权限：面板是浏览器身份，写操作靠 `actor` 字段 | S |

## 六、三类差距（这个分类比"缺多少项"更有用）

把上面的行按**为什么会缺**分组，处理的顺序完全不同：

### A 类 · hub 做过，插件只搬了代码没接线

**这是唯一一类"照抄就对了"的差距**，也是现在最该先做的：代码在、测试在，只差调用点。

| 项 | hub 的证据 | 插件缺的那一步 |
|---|---|---|
| 超额完成：门禁超时的**催办与升级真的发卡片** | `hub/src/runtime/pipeline.ts:1305-1360`：`tick()` 里 `decideBroadcast` → `buildTaskCard` → `#sendOrUpdate(cardKeyOf('task', id), …)`，三种结果（只催办 / 升级 / 正常跃迁）各发一张卡 | 插件的 `tick`（`lib/tools.js:545`）只 `decided.push(...)`。要接的是：`deliverCard` + `planDelivery` + `card_key → message_id` 的持久化 + 一个 digest 定时器 |
| 播报决策/节流/聚合/@配额/占比告警 | `hub/src/runtime/broadcast.ts`（`09` §2.3 标 ✅） | 引擎已移植（`lib/feishu/broadcast.js`）但零调用点 |
| 卡片原地更新（同一话题一张卡） | 同上 `#sendOrUpdate` → `PATCH /im/v1/messages/:id` | `deliverCard` 移植了（`lib/feishu/cards.js:643`），但真 transport 没有 `client.request()` |
| 两个群命令（拒绝/阻塞） | hub 有对应动作 | 插件 `DEFAULT_COMMANDS` 有、`handlers` 没有（实测：`handlers` 只有 13 个键） |

### B 类 · 两边都没做（设计里画了，从未实现）

**不要把这类算成"插件缺失"** —— 它们是**设计未落地**，做之前要先确认还要不要做。

| 项 | 证据 |
|---|---|
| 需求走到 `done` / `archived` | 需求状态机**没有任何动作产出 `done`**（`lib/domain/machine.js:592-602` `REQ_ALLOWED` 只有 confirm/confirm_split/change/reconfirm/block/unblock/suspend/resume/drop/archive）；`requirementComplete()` 这个"其下任务都 done 了"的判据在 hub 里**定义了但没人调用**（`hub/src/domain/objects.ts:253`）。所以 `09` §2.1 给"需求对象 8 个状态"打的 ✅ 是**schema 层**的 ✅，状态跃迁层从来没有过 |
| 冲突对象 | hub：`conflictSchema` + `inbox/conflicts` 目录，**没有任何代码创建它**（只有 store 引用 schema）；插件：连 store kind 都没有 |
| Frontmatter / 索引 / 陈旧检测 / 附件 | `01` 自己标注"六件事全部未实现" |
| 记忆 / 画像 / 技能库 | `07` 自己标注为路线图；`09` §2.6 在 hub 侧也是 ❌/🟡 |
| Git 分支约定 / MR 门禁 / CI 状态机 / 仓库知识索引 | `03` §1 全未实现；`can_approve: merge` 只是一个权限位 |
| 通知回填 | `09` §2.3 在 hub 侧就是 ❌ |

### C 类 · 前提已变（设计假设在插件形态下不成立）

| 设计假设 | 现在是什么 | 该变成什么 |
|---|---|---|
| 自建 Hub 常驻节点 + HTTP 控制台 + `access.yaml` 认证 | DSH 插件 + 槽位渲染的浏览器半边 + harness 自己的 cookie 围栏 | 面板的"按人权限"要靠 `actor` 字段与成员表，不能再指望一套自己的登录 |
| SQLite 存事件/去重 | 一对象一文件的 JSON 台账 + `inbox/messages.jsonl` | 保持文件（可 `cat`、可 git），事件流用追加文件 |
| `bots/*.yaml` 一人一文件 | 一份 `config.json` 里的 `bots` 数组 + 面板编辑 | 保留"配置即文件"，但不再要求一机器人一文件 |
| 飞书卡片按钮（回调） | DSH Web 只监听 `127.0.0.1`，飞书**回调不到** | 已按设计自己的降级级：卡片带文本指令，群里发 `接受/开始/验收`；按钮要等一个公网入口 |
| 内网方案（自建推理/适配器） | DSH 自己就是执行体 | `03` 第二部分需要按插件形态重写 |

## 六点五、三份独立审计的结论（与上面一致，数字更细）

三份逐文档审计（00-02 / 03-04 / 05-08）各自独立核对了代码，结论与上表一致，量级如下：

| 文档簇 | 核对到的能力点 | 其中 ✅ | 结论里最大的缺口 |
|---|---|---|---|
| 00-02（总览 / 工作区 / 机器人需求） | 46 | 12 | 状态跃迁不进群；拒绝/转派/阻塞无入口；权限矩阵无强制层；需求只进不出且不去重；记忆与文档沉淀整段不存在 |
| 03-04（外网 / 飞书消息） | 149 | 17 | 播报链零调用点；群命令缺 4 个动作；超时不出声；进度与中间产物不可见；准入与权限强制层缺失 |
| 05-08（配置台 / 对象 / 记忆 / 评审） | 76 | 21 | 配置改动无影响面/无草稿/无审批；`on_timeout` 是装饰；`rejected` 是死状态；无角色权限层；无日志页 |

三份都独立指出同一件事，这也是本轮的**头号缺口**：
**`lib/feishu/broadcast.js` 整个播报层在 `lib/` 里零调用点** ——
`decideBroadcast:113`、`planDelivery:464`、`BroadcastThrottle:236`、`DigestAggregator:296`、
`MentionQuota:163`、`BroadcastChannel:376`、`buildTaskCard:606`、`buildDecisionCard:942`、
`buildNoticeCard:912`、`buildReportCard:891` 全部没有生产消费者；唯一接线的是建单时的
`buildRequirementCard`（`lib/feishu/ingest.js:398`），而卡片更新入口 `deliverCard`
（`lib/feishu/cards.js:563`，走 `PATCH`）同样没有调用方（ingest 走只 POST 的 `sendThrough`）。
**后果**：群里除了"已记为需求"那一张卡和命令的文本回复之外，接受 / 开始 / 阻塞 / 验收 /
门禁催办 / 超时释放**全程无声** —— 人只能自己盯着 DSH 面板看。

## 六点六、本轮已修（2026-09-12，都有测试钉住）

上面表里的这一批已经不再是 ❌/🟡：

| 修的 | 之前是什么样 | 现在 |
|---|---|---|
| **拒绝后不悬空** | `rejected` 是死状态：`availableActions` 为空，`assign` 只认 `confirmed` → 任务永久卡住（而设计 02 §5.3 说"不允许悬空"） | `assign` 也接受 `rejected`；`reject_task` + `assign_task` 构成回路，实测 `rejected → assigned` |
| **群里的拒绝/阻塞** | 命令表宣传 `拒绝/阻塞`，handler 表里没有 → 人收到"✖ 这个动作还没有接上" | `reject_task` / `block_task`（原因必填）/ `unblock_task` 三个动作 + 群里 `拒绝/阻塞/解除` 三个动词，逐条实测可达 |
| **验收打回** | 卡片上有 `task.reject_review` 按钮，状态机里没有这个动作 → 按下去只会得到"未实现的动作"；设计 06 §4.1 表末行写着 `in_review → in_progress` | 新增动作 + `reject_review` handler + 群里 `打回`；守卫与 `verify` 同批人，且执行者不能打回自己；理由落进历史的 `reason` 字段（与"系统要做什么"的 `effects` 分开） |
| **`on_timeout` 是装饰** | `dueAction()` 只看门禁名：`start` 一律释放、`accept` 一律升级。于是 `start.on_timeout='escalate_to_owner'`（别自动放掉我的任务）**照着释放** | 策略驱动：只有 `auto_release` 才释放；配置校验直接拒绝"配了但没有对应机器动作"的组合（`auto_release` 只允许在 `start` 上） |
| **决策对象（ADR）** | 只有 schema：`parseDecision` 除测试无人调用，且 store 生成 `dec-` 前缀、schema 只认 `adr-` → 真造一条立刻校验失败 | store 前缀改 `adr-`；新增 `record_decision`（AI/人都能记），`related.requirements` 双向可追；实测 `adr-2026-001` 落盘并在需求上记下引用 |
| **`withHistory` 记不下人的理由** | 只有 `effects`（系统要做什么），"人为什么这么决定"无处可写 | 加第四个参数 `reason`，`reject_review` 用它记"缺单测"这类理由 |
| **原生卡片的 footer 整段丢失** | `cards.js` 的 `buildCardJson` 不渲染 `card.footer`，只有 markdown 分支里有 | 见"接下来"（本轮先记下，未改） |

### 第二批：出站通知链（A 类接完，2026-09-12）

**之前**：`broadcast.js` 整个播报层零调用点；`tick` 的门禁催办/升级/超时释放只写 `console.log`；
群里除了建单那一张卡与命令文本回复之外全程无声。

**现在**（新模块 `lib/notify.js` + 接线）：

| 修的 | 说明 |
|---|---|
| **每次状态跃迁都会播报** | 播报挂在"写任务对象"的唯一入口 `writeTask()` 上，判据是**状态真的变了**（`blocked_reason` 这类元数据写入不会刷消息）。第一版挂在 `commit()` 上，实测"接受"这一步群里仍然没消息 —— 因为 `accept_task` 自己写对象、不走 commit |
| **同一张卡**：第二次是 `PATCH` 原地更新，不是又发一条 | 卡台账（`card_key → message_id`）**落盘**在 store 的新种类 `card` 里：重启之后仍然更新那张卡，而不是群里多出一张新的 |
| **建卡的竞态**（新发现的真 bug） | 机器人承接时 `accept` 与 `start` 连着发生，两次投递都会看到"还没有卡" → **一个任务两张卡**。修法是按 `card_key` 串行化投递；用例是"连着发、不 await"，手工点两下永远复现不了 |
| **`tick` 的催办/升级/收回真的发消息** | 只催办（`notify_only`）与升级（`escalate`）各发一条一次性通知卡；**状态真的变了**的那两条（超时释放、租约收回）只原地更新任务卡 —— 同一个话题出现两张卡正是设计要避免的刷屏。`decided[]` 每条都带 `notified` 标记 |
| **digest 不进群、也不丢** | 进度类进摘要桶并可通过 `digestBuckets()` 取用（日报/看板那一层还没做，见第 22 项），没有来源群的对象（DSH 里建的需求）明确返回 `skip: no-chat` |
| **@人配额** | 同一个人当天被 @ 超过 3 次之后，通知照发但改成静默待办（不再 @） |
| **补发** | 节流窗口内被并掉的卡由 5 秒定时器补一次原地更新，否则**最后一次跃迁永远不出现在群里** |

**接这条链时又抓出两个协议 bug**（都已修 + 有测试）：

| bug | 症状 |
|---|---|
| **改派不重算门禁确认人** | 机器人拒绝 → 改派给真人之后，accept 门禁的 `required_by` 还是建任务时那份（机器人那份是**空的**）。`required_by.every(...)` 对空数组恒真 → 门禁立刻算满足：任务既不用本人接受、也永远不会超时催办 |
| **`reassign` 连确认记录都不换** | 它换掉执行者却把门禁整份留给旧执行者（旧确认人 + 旧确认记录），而它自己的效果文案写着"新执行者仍需点接受"。现在 `assign` 与 `reassign` 共用同一份 `gatesForAssignee()`（这也是它们当初能写歪的原因），并补上了 `reassign_task` 入口与群里 `转派` 动词 |

## 七、建议顺序

### 第三批 + 第四批：需求闭环、权限层、日志与观测（2026-09-12，都已落地并有测试）

| 批次 | 修的 | 落地位置 |
|---|---|---|
| ③ 需求闭环 | `findDuplicate` 去重（标题先归一化再比）、`decideAsk` 每群只追问一次、`change`/`drop`/`suspend`/`resume` 入口、需求 `done → archived` 路径、跨域验收确认累加、主负责人可关门禁 | `lib/feishu/ingest.js`、`lib/tools.js`、`lib/domain/` |
| ③ 权限与作用域 | `members` 名册 + `memberCanWrite`、`bots[].capabilities` 与角色默认能力、`botCanTouchRepo`、任务类型→域映射（`lib/tasktypes.js`，10 域 / 9 类型）、`gateWrite()` 在 accept/start/submit/verify 上按人查权 | `lib/members.js`、`lib/bots.js`、`lib/tasktypes.js`、`lib/tools.js` |
| ④ 日志页 | 内存环形缓冲（500）+ `logs/team.jsonl`（2MB 轮转）双写、**写入前脱敏**、`/api/team/logs`、面板第六个页签：级别/来源筛选、重启前文件日志、收件箱漏单与**每条的分诊结论**、3 秒自动刷新（可关） | `lib/logbus.js`、`lib/api.js`、`lib/client.js` |
| ④ 表态 | 被点到的消息加一个 reaction（失败只记日志，不影响回答） | `lib/team.js` |
| ④ 降级率 | 五级降级链的**后两级占比**（`CARD_VIAS`/`FALLBACK_VIAS` 从 `cards.js` 导出，页面副本有测试逐字比对）；`via`/`mentions`/`created_at`/`deliveries` 落在卡台账上，重启不改口径 | `lib/metrics.js`、`lib/notify.js` |
| ④ 发言占比 | 每群一行：分子 = 群里卡台账行数（原地更新不算新消息），分母 + 收件箱入站消息；**> 25% 且样本 ≥ 8 条**时在 tick 里写一行 warn（按群冷却 30 分钟） | `lib/metrics.js`、`lib/team.js` |
| ④ 观测页两个坑 | ① 第一次读失败时页面**停在"读取日志中…"**（payload 永远为 null）→ 失败排在加载之前，并给一个刷新入口；② 点级别/来源按钮时 `patch()` 还没重渲染，`loadLogs` 读到的是**旧筛选** → 筛选由调用方显式传入 | `lib/client.js` |

### 建议顺序

1. ~~**A 类接完：出站通知链**~~ ✅ **已完成**（见上一节）。
2. **超额完成：需求闭环**（`findDuplicate` 去重、`decideAsk` 追问、`change/drop/suspend` 入口、
   需求 `done/archived` 路径、多人验收门禁语义）—— 一件 M，逐项 S。现在需求只进不出、
   同一件事会建三遍、建完没人澄清也废不掉。
3. **权限与作用域强制层**（`permissions.cannot` / `scope` / `budget` + 角色域 `fallback` +
   任务类型→域映射）—— 一件 M。设计里最不能出错的一条："需求机器人手里不该有 git 写权限"，
   现在一个被派活的需求机器人和开发机器人权限完全一样。
4. **日志页 + 漏单检测 + 分诊结论可见 + 表态（reaction）** —— S/S/S/S，"出问题第一眼"。
5. **卡片与渲染的零碎**：footer 三字段、表格单元格清理、事件 `post` 富文本、图片回执、
   `event_id` 去重键 + 保留窗口 —— 逐项 S。
6. **B 类"载体"两件**（文档 frontmatter/陈旧检测；记忆复用 DSH 会话历史 + 工作区文件）—— 各 L，先定形状。
7. **Git/MR/CI 对接** —— L，且要先确认是否真要（`00` §5.2 至今列在"待定"）。
   **做不到的部分已明确**：飞书卡片按钮与 Git webhook 都需要公网入站 HTTPS，而 DSH Web 只监听
   `127.0.0.1`；替代方案是设计自己的"去按钮"级 + 群文本命令，以及让 agent 在工作目录里用
   `gh`/`git` 自己完成检出与 MR，插件只记关联并在合并时过门禁。

## 八、用户补充的需求：每个群一个主机器人，负责这个群所有消息的记录

（2026-09-12 提出，已实现并测试。）

设计文档里"谁回答"是路由规则（02 §4.2 单响应者），但**没有"这个群归谁"这一层**：
记录散在追加式 inbox 日志里，归属只能靠"上一次谁回答的"反推。这一条把它补成一等概念：

| 之前 | 现在 |
|---|---|
| 群记录里的 `bot_id` = **上一次谁回答的**（回答才写） | `primary_bot_id` = **这个群的主机器人**（首次接触就定，此后不变）；`last_bot_id` 才是"最后谁回答的" |
| 没人回答的消息只在全局 inbox 里，谁的账也不算 | 每条消息都记在主机器人名下（`botsession.seen`），`turns` 只数它真正回答过的轮次 |
| 换主＝下一条消息换个人回答，顺带把记录也带走 | 换主是**显式动作**（面板「群」表的「改主」→ 台账路由 `set_primary_bot`，记下谁改的、何时、之前是谁）；回答换人不等于换主 |
| 群列表不存在（审计里的"缺群表"） | 「会话」页上半就是群表：群 / 主机器人 / 消息·轮次 / 上次活动 / 改主 |

两条规则的分工（这是最容易写混的地方，所以各有一个函数、各自有用例）：
`routeBots()` 回答"**谁来回这一条**"（点名 > 已绑定 > 优先级）；
`pickPrimaryBot()` 回答"**这个群归谁记**"（已有主且仍在服务这个群 → 就是它）。

**记录是地板**：`handleInbound` 在流水线不可用时也写群记录与主机器人的消息计数 ——
降级时最需要排查，不能恰恰在那时什么都查不到。
