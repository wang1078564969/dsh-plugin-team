# REVIEW-01：功能完备性审查报告（第一轮）

> 审查对象：`dsh-plugin-team` 当前实现（HEAD `6af88df` 之后的代码）+ 现状设计文档 `docs/DESIGN.md`。
> 审查方式：四个**互相独立**的视角并行审查（完备性对照 / 卡死路径 / 并发与重启 / 接口与权限），
> 每个视角只读代码、只报能指到 `文件:行号` 的结论；**再由我逐条复核**，能跑的用 `node` 真跑一遍。
> 报告里每条都标了验证状态：
>
> - ✅ **复现过**（我执行了代码，看到现象）
> - 📖 **读代码得出**（静态阅读，逻辑清楚但没跑）
> - ⚠️ **被下调或证伪**（审查提出，复核后改判 —— 这类也写进来，免得下一个人重复排查）

---

## 1. 一句话结论

**骨架是完整的，但"最后一公里"有四处断路，而且都断在最关键的地方**：
需求永远无法收口（P0-1）、自动释放会制造永久卡死的任务（P0-2）、需求一变更就冻死全部在途任务（P0-3）、
默认配置下群里的按钮是死的而且教人回一句机器人听不懂的指令（P0-4）。

其余 18 条是"能用但会咬人"的问题：权限闸只覆盖 4/31 个写动作、群命令缺参数与动词、
门禁超时形同装饰、重复投递污染计数、面板看不到 CI/MR/决策。

| 级别 | 条数 | 其中我复现过的 |
|---|---|---|
| P0（断路，功能不成立） | 4 | 4 |
| P1（会咬人 / 静默错误行为） | 10 | 5 |
| P2（一致性与整洁） | 8 | 4 |
| 证伪 / 下调 | 4 | 3 |

**最刺眼的一条**：`finish` 的断路（P0-1）在 494 个用例里**一条都没覆盖** —— 测试全绿，
功能是坏的。这说明"测试数量"给了虚假的安全感（见 §6 的测试盲区）。

---

## 2. P0：四处断路

### R1-P0-1 ✅ 需求永远无法完成：`transitionRequirement('finish')` 抛 `ReferenceError`

**现象**：群里 `验收 task-1` → 任务真的变成 `done`，但**群里一句回话都没有**；需求永远停在 `dispatched`。

**证据**：`lib/domain/machine.js:782` 用了 `withHistory(...)`，而这个助手**只定义在 `transitionTask` 内部**
（`machine.js:253`）；`transitionRequirement` 自己的助手叫 `ok`（`machine.js:752`）。

**复现**（我跑的）：
```console
$ node -e "…transitionRequirement(req,'finish','human:pm',{now, allTasksDone:true, requirement:req, …})"
ReferenceError: withHistory is not defined
    at Module.transitionRequirement (…/lib/domain/machine.js:782:7)
```

**这条其实是两个半边，而且静默的那半边更坏**（复核：两处调用点行为不同）：

| 调用点 | 传的 ctx | 实际结果 |
|---|---|---|
| 自动收口 `tools.js:283`（`tryFinishRequirement`） | `transitionCtx(null, req)` —— **没有 `allTasksDone`** | 在 `machine.js:776` 就 `err('tasks_open')` 返回，`tryFinishRequirement` 拿到 `ok!==true` → **返回 null，需求永远不完成，而且完全静默**（没有异常、没有日志） |
| 手动 `team finish_requirement`（`tools.js:1118`） | 传了 `allTasksDone` | 走到 `machine.js:782` → **抛 `ReferenceError`** → 工具返回 `handler_failed`（`lib/tools.js:1945`） |

**群命令路径的症状**（`验收 task-1`）：任务先被提交成 `done`（`tools.js:1042-1048`），
再调 `tryFinishRequirement` → 静默返回 null → **任务卡被异步改成"完成"，群里却没有任何回执**。
（若换成会抛的那条路，异常会穿过 `runCommand`（`lib/feishu/ingest.js:416-437`，无 try/catch），
落到连接层只写一行 `inbound handling failed`，`lib/feishu/connection.js:454-457` —— 同样没有回执。）

**修法**：`machine.js:782` 改用 `ok(...)`；`tryFinishRequirement` 补上 `allTasksDone`
（由 `requirementComplete` 的结果算）并包 try/catch、失败要播报；
补两条用例：自动收口、手动 finish。

### R1-P0-2 ✅ 自动释放制造永久卡死的任务：落到 `assigned + assignee:null`，而 `assign` 不认这个状态

**证据**：`machine.js:576`（`timeout_start` 置 `state:'assigned', assignee:null`）、
`machine.js:408`（`unassign`）、`machine.js:598`（`timeout_lease`）都落在这里；
而 `assign` 只允许 `['confirmed','rejected']`（`machine.js:172`），`reassign` 只允许 `accepted`（`machine.js:177`）。

**复现**（我跑的，`assigned + assignee:null`）：
```console
availableActions = ["accept","reject","suspend","drop","timeout_accept"]
assign   → invalid_state
reassign → invalid_state
start    → invalid_state
accept   → not_assigned_to_you
```
前两个动作在"没有 assignee"时不可能成立，`drop` 没有 handler，`suspend` 又是下一个断路。
**默认策略就是 `start: {on_timeout: 'auto_release', max_release: 2}`（`lib/config.js:54`）**，
也就是说：默认配置下，每一次"接受了但没开始"都会制造一个永久卡死的任务。

**修法**：`assign` 也接受 `assigned`（且把 `assignee:null` 视作待派发）；
`timeout_start` / `timeout_lease` / `unassign` 之后**把该门禁作废**，避免 tick 每分钟重试同一个非法跃迁
（见 R1-P1-10）。

### R1-P0-3 ✅ `suspended` 任务零出口：`change_requirement` 会冻死全部在途任务

**证据**：`tools.js:1159-1165` 的 `change_requirement` 把所有受影响任务 `transitionTask(..., 'suspend')`；
状态机允许 `resume`/`drop`（`machine.js:203-214`），但 **handlers 里没有 `resume_task`/`drop_task`**
（`lib/tools.js` 的 35 个 handler 清单里没有），面板不做任务 suspend（`lib/client.js:155` 只有需求动作），
群动词也没有。

**复现**（我跑的）：`availableActions(suspended) = ["resume","drop"]` → 两个都没有入口。

**影响**：任何一次"需求变更"让全部在途任务永久冻结，而且没有任何播报。

**修法**：补 `resume_task` / `drop_task` handler + 群动词「恢复/冻结」；`change_requirement` 之后播报影响面。

### R1-P0-4 ✅ `feishu.buttons:false` 不起作用：默认配置下群里的按钮是死的

**背景**：按钮默认关，是因为**没有公网回调端点**（飞书要 HTTPS 回调，DSH Web 只听 `127.0.0.1`）。
所以"按钮关掉、改用文本指令"是设计里明确的降级路径。

**证据**：`degradationLadder` 只把 `opts.buttons` 用在**第 2、3 级的命名**上，
第 1 级恒定 `cardPayload(true, true)`（`lib/feishu/cards.js:426`）；调用方传进来的
`{buttons: config.feishu?.buttons === true}`（`lib/notify.js:243`）根本没被读。

**复现**（我跑的）：
```console
$ degradationLadder(spec, { buttons: false })[0] → 含 `action` 元素 = true   # 真按钮照发
$ …[2] → "操作：回复 `task.accept` 表示「接受」"                            # 兜底教的是这个
$ parseCommand('task.accept') → null                                      # 而命令解析器不认
```
群命令词表是 `接受/接了/accept`（`lib/feishu/ingest.js:37-47`），没有 `task.accept`。
**结果**：人看到的按钮点了没反应，照兜底文本回复又得到"没听懂"。

**修法**：`degradationLadder` 尊重 `opts.buttons === false`（第 1 级就用去按钮形态），
并把兜底文案改成**群命令真正认的词**（`接受 task-1`），最好由 `DEFAULT_COMMANDS` 反查生成，
避免两处再漂移。

---

## 3. P1：会咬人的十条

| # | 结论 | 证据 | 验证 |
|---|---|---|---|
| R1-P1-1 | **群命令语法太窄**：`<动词> <id>` 之外的多余内容会让整条命令解析失败 —— `阻塞 task-1 等接口` → `null` → 当 prose 走分诊（可能建出垃圾需求）；`阻塞/转派` 需要的参数因此给不出。另外 `confirm_split`（确认拆解）与 `submit_task`（提交验收）**没有动词**，只用飞书的人走不完闭环 | `lib/feishu/ingest.js:37-47`、`:58-70`、`lib/tools.js:1076-1083` | ✅ |
| R1-P1-2 | **成员闸只覆盖 4/31 个写动作**（accept/start/submit/verify，`tools.js:798/816/1000/1032`）。其余只走状态机的 domainOwner/owner 判定 → `role:"observer"` 的域负责人照样能指派、拒绝、阻塞、归档、废弃 | `lib/tools.js:107-109`、`lib/members.js:236-246` | ✅ |
| R1-P1-3 | **配置接口与日志接口的写入口没有权限校验**：`POST /api/team/config` 只要求 `actor` 是非空字符串（谁都能填 `human:admin`），`POST /api/team/logs` 的 `clear_buffer` 连 actor 都不要。密钥、名册、准入映射都在这一层后面 | `lib/api.js:535-560`、`:277-286`、`lib/settings.js:682` | 📖 |
| R1-P1-4 | **`confirm_split` 门禁的超时是装饰**：`initializeGates`（唯一会给门禁填 `due_at` 的函数）**全库零调用**，建任务时四个门禁 `due_at` 全是 null → 调度器直接跳过（`scheduler.js:94`）。连带：日报里的「待确认」清单是**死代码** —— `Array.isArray(task.gates)` 恒为 false（gates 是 record 不是数组），且 Gate 上没有 `name`/`state` 字段 | `lib/domain/objects.js:178`、`lib/team.js:152-167` | ✅ |
| R1-P1-5 | **租约没有续约入口**（`renewLease` 零调用，`renewals` 永远是 0），所以每份租约必然到期；而租约收回只允许 `in_progress`（`machine.js:219`），`accepted` 的租约收不回、每次 tick 重复失败**只写日志** | `lib/domain/lease.js:117`、`lib/tools.js:809-810`、`:1679-1681` | 📖 |
| R1-P1-6 | **重复投递会污染计数**：多应用 = 多长连接，同一条群消息每条连接各到一次，去重在"记录"处、而记录发生在**资产下载之后**的 await 另一侧 → `chat.messages` +2（我实测）、资产下载两次、回执卡被 PATCH 两次。**不会重复建单**（ingest 的查重是同步的，见 §5 的改判） | `lib/team.js:383-391`、`:485`、`lib/feishu/ingest.js` | ✅ |
| R1-P1-7 | **`run_task` 的闸门在 await 之前**：两次并发调用（模型并行工具调用、两个标签页）都会通过状态检查 → 驱动两轮真实会话（真花 token、可能真改代码），`evidence` 后写者赢，`turns` 丢一轮 | `lib/tools.js:855-872` vs `:909`/`:921`、`lib/api.js:125-141` | 📖 |
| R1-P1-8 | **日报的"主机器人"漏了旧记录兼容**：`primaryBotOf`（模块级，日报用）只读 `primary_bot_id`，而 inbound 路径**读了 `bot_id` 兜底**（`team.js:419-427`）。真实数据里两个群记录都只有 `bot_id` → 日报由默认应用的脸发出 | `lib/team.js:185-188`、`~/.dsh/team/chats/*.json` | ✅ |
| R1-P1-9 | **`no-chat` 的播报跳过没有任何日志**，而 tick 的报告硬编码 `notified: true` → 运维无法回答"为什么群里没动静"（DSH 里用工具建的需求就是这一类：`origin.surface:'internal'`） | `lib/notify.js:186-189`、`lib/tools.js:1591/1619` | 📖 |
| R1-P1-10 | **权限的三条结构性弱点**：`actor` 是自由文本（`actorFor` 只判空，可冒充任何人）、`memberCanWrite` 对**不在成员表里的人默认放行**、worker 护栏只在工具路径（HTTP 路由可绕） | `lib/tools.js:69-73`、`lib/members.js:241`、`lib/api.js:135` vs `lib/tools.js:1929-1935` | 📖 |

---

## 4. P2：一致性与整洁的八条

| # | 结论 | 证据 | 验证 |
|---|---|---|---|
| R1-P2-1 | `lib/team.js` 里 `flushDailyReports` **声明了两次**（969/976，函数体逐字相同）—— 死代码，且只改一处会静默失效 | `lib/team.js:969`、`:976` | ✅ |
| R1-P2-2 | 配置键 `feishu.statePath` **零读取点**。而我们拒绝 `feishu.chatIds` 的理由正是"被接受但被忽略的键比被拒绝的更糟" —— 自相矛盾 | `lib/config.js:339` | ✅ |
| R1-P2-3 | **面板看不到决策与 CI/MR**：`requirementRow` 不投影 `decisions`/`links`，`taskRow` 不投影 `ci`/`mr`/`last_run`（飞书卡片 footer 有 `🧪 CI 等待中`，面板什么都没有） | `lib/api.js:27-46`、`:48-71` | ✅ |
| R1-P2-4 | **只增不减**：`notify.inFlight`（每 card_key 一条）、`tools.announced`（每任务一条）、`metrics.alertedAt`；`config.json.bak-*` 与 `assets/` 没有清理策略。其中 **`notify.throttled` 对 `kind !== 'task'` 直接 skip**，静默丢掉 callout 类的待补发（资产回执、催办）—— 这条是行为丢失，不只是内存 | `lib/notify.js:99`、`:480`、`lib/tools.js:210` | 📖 |
| R1-P2-5 | `Inbox.prune` 的**删除判据与重写判据不是同一个谓词**（时间解析不出的行：内存删掉、文件里留下 → 重启复活、永远清不掉）；`load()` 是整段 try（一行坏 JSON 丢掉其后所有行）；`record` 先改内存后写盘（与 store 相反） | `lib/feishu/ingest.js:195-212`、`:110-120`、`:165-168` | 📖 |
| R1-P2-6 | 死导出 `docs.docSize`、`repos.relativeRepo`、`repos.isGitRepo`；`requirement_view` 的"必须写明来源"校验**被自己的调用方豁免**（`write()` 与 `list()` 都传 `allowView:true`），而且这个类型**没有生产者** | `lib/docs.js:221`、`:311`、`:347` | ✅ |
| R1-P2-7 | 接口给了没人读的字段 10 处（`leases[].kind`、`delivery.byVia/card/fallback`、`counts.buffered`、`diagnostics.ledger/mode`、`messages[].consumedBy/preview`…）；其中 `leases[].kind` 与 `task.last_run` 是**面板想显示也拿不到**的。另外失败响应不带 snapshot，面板拒绝后保留旧数据且**不提示这是旧数据** | `lib/api.js:112`、`:214-215`、`:152`、`lib/client.js:3330-3349` | 📖 |
| R1-P2-9 | `docs/GAP-VS-DESIGN.md:132-139` 那段「整个播报层零调用点」**已经过期**（`lib/notify.js` 已完整接线），而且给的行号（`buildDecisionCard:942` 等）与现在差 60 行 —— 一份会误导人的历史文档 | `docs/GAP-VS-DESIGN.md:132` | ✅ |
| R1-P2-10 | 领域层 `TransitionCode` typedef 只声明 9 个码，生产会返回 `no_change`（`machine.js:419`）与 `tasks_open`（`:776`）两个**表外码**；`initializeGates`/`renewLease`/`releaseLease`/`upcoming`/`remainingMs`/`hasDeadline`/`leaseIdOf`/`describeSpan` 等一批导出零引用（有的是移植时保留的 hub 表面，有的确实是死代码） | `lib/domain/*.js` | 📖 |
| R1-P2-8 | 面板「提交验收」自造一条假证据（`ref: 'gui:'+Date.now()`）；tick 用**任务执行者本人**当 actor 做跃迁（审计里像"执行者自己放弃了任务"），而 `system` 是合法 principal（`PRINCIPAL_RE` 允许裸 `system`） | `lib/client.js:4726-4728`、`lib/tools.js:1594` | ✅ |

---

## 5. 复核后下调 / 证伪的四条（别重复排查）

| 审查提出的 | 复核结论 |
|---|---|
| "两条长连接会各建一条需求（重复建单）" | ⚠️ **下调**：我实测并发喂同一事件两次 → `inbox` 只有 1 条，**需求不会重复**（ingest 的 `seenEvent`/`seen` 检查与 `record` 是同步相邻的，Node 单线程挡住了）。真实症状是**计数污染**（`chat.messages = 2`）与重复下载/重复 PATCH —— 见 R1-P1-6 |
| "`notify` 用未安全化的 id，`previous` 恒 null，计数器停在 1" | ⚠️ **证伪**：读写用的是同一个 `cardRecordId`，实测 `deliveries` 累加到 2、`created_at` 保持首值；`store.put` 对含 `:` 的 id 直接抛错，不存在静默分叉 |
| "`event_id` 读不到（真实数据全 null）" | ⚠️ **证伪**：SDK 会把事件 header 展平到顶层，`connection.js:362` 的读法正确；真实数据为 null 是那批消息早于该字段落库 |
| "tick 与手动 tick 真并发" / "`prune` 重写吃掉期间新数据" | ⚠️ **证伪**：`tick` 全程同步无 await；prune 是 30 行压成 15 行（压缩不是丢数据） |

---

## 6. 测试盲区（比缺陷本身更值得记住）

1. **P0-1 一条用例都没有**：grep 全仓库，`finish` / `finish_requirement` 在 `test/` 里零命中。
   494 个用例全绿的假安全感就来自这种"整条路径没人碰"。
2. **领域层的引擎测了，接线没测**：`transitionRequirement` 的每个动作在 `domain.test.mjs` 里大概都有用例，
   但**从 handler 到状态机的那一段**（`finish_requirement` / `verify_task → tryFinishRequirement`）没有。
3. **默认配置的交互面没测**：`feishu.buttons` 默认 false，但没有任何用例断言"按钮关掉之后卡片里没有 `action` 元素"。
4. **群命令的"端到端可用性"没测**：测的是"解析对不对"，没测"每个动词都对应一个存在的 handler 且参数够用"。
   （`DEFAULT_COMMANDS` 与 handlers 的**对账**值得做成一条用例。）
5. **旧数据兼容只测了一半**：`bot_id → primary_bot_id` 的兜底在 inbound 路径测了，日报那条路径没测。

---

## 7. 本轮要修什么（按这个顺序做）

**第一批（P0，必须）**
1. `machine.js:782` 改 `ok(...)`；`tryFinishRequirement` 包 try/catch + 失败播报；
   补"任务全部验收 → 需求自动 done"与"手动 finish"两条用例。
2. 释放/收回/交回落点：`assign` 接受 `assigned`，或释放时保留可派发语义；同时把该门禁作废，止住 tick 空转。
3. 补 `resume_task` / `drop_task`（handler + 群动词 + 面板任务动作），并让 `change_requirement` 播报影响面。
4. `degradationLadder` 尊重 `opts.buttons === false`；兜底文案由 `DEFAULT_COMMANDS` 反查生成；
   补用例：`buttons:false` 时卡片里没有 `action` 元素，且文案里出现的动词 `parseCommand` 认。

**第 1.5 批（文档卫生，顺手）**

- 修 `docs/GAP-VS-DESIGN.md` 那段过期断言（改成"已接线，见 `lib/notify.js`"）；
- `docs/DESIGN.md` 的 §5.1 补一句"`InboundMessage` 的落库形状是 snake_case，与 `normalizeMessage` 的 camelCase 输出不是同一个对象"。

**第二批（P1，本轮也做）**

5. 群命令语法扩成 `<动词> <id> [原因/对象]`，并把多余部分作为 `note`/`assignee` 传给需要的 handler；
   `DEFAULT_COMMANDS` 补 `submit_task` / `confirm_split`；加一条"动词 ↔ handler 对账"的用例。
6. 成员闸从 4 个 handler **上移到统一分发处**（`buildTeamTool` 的 `execute` 或 `handlers` 的包装层）：
   一处覆盖全部写动作；`memberCanWrite` 对非成员改为**默认拒绝**（可由配置放行）；
   `actor` 必须是成员表里的人（`system` 与 `human:` 未登记者按配置处理）。
7. 配置接口与日志接口的写入口加同一道闸（actor 必填 + 成员校验）；`clear_buffer` 加 actor 并记一行审计。
8. 建任务时调 `initializeGates`（门禁 `due_at` 有值）；日报的「待确认」改用 `Object.entries(task.gates)` + `gateSatisfied()`。
9. 租约：补 `renew_lease` handler + 群动词「续约」；`timeout_lease` 允许从 `accepted` 收回；收回失败要播报。
10. 去重前移：查重通过后**先落一条占位记录**再下载资产（副作用之前就有记录）。
11. `run_task` 按 `task id` 加 in-flight 去重（同一任务并发只驱动一轮）。
12. `primaryBotOf` 与 inbound 共用同一个"谁是主"的解析（含 `bot_id` 兜底）。
13. `no-chat` 跳过要记一行日志；tick 的 `notified` 反映真实投递结果。

**第三批（P2，能顺手就顺手）**

14. 删掉重复声明；`statePath` 要么实现要么拒绝（选拒绝）；面板补 `decisions`/`ci`/`mr`/`last_run`；
    删死导出；`requirement_view` 校验在 `write()` 时生效；`prune` 统一判据；`record` 先写盘后改内存；
    tick 用 `system` 当 actor；面板「提交验收」不再自造假证据（改成如实留空或写"人工提交"）。

**明确不在本轮做（写清理由）**
- 面板建需求/拆任务（那是飞书与模型的活，面板保持"看 + 确认"）；
- 改派后销毁旧会话（要动 `exec` 的会话身份规则，先留观察）；
- 决策的 supersede/reject 入口（低风险，等有人真的需要）；
- `assets/` 与配置文件备份的清理策略（给个上限就行，本轮只记录）。

---

## 8. 本轮已修（第一轮完善，随 `docs/DESIGN.md` 一起提交）

**P0 四条全部修掉，并各配一条从真实入口走的回归用例**（`test/round1-fixes.test.mjs`，12 条）：

| 编号 | 修法 | 落点 |
|---|---|---|
| R1-P0-1 | `withHistory` → `ok`；`tryFinishRequirement` 补 `allTasksDone`（**这条才是静默失效的那一半**）并包 try/catch，失败播报 | `lib/domain/machine.js`、`lib/tools.js` |
| R1-P0-2 | `assign` 也接受 `assigned`（仅当没有执行者，`availableActions` 同步收窄）；tick 遇到"到期但当前状态不适用"的门禁**作废它**，止住每分钟空转 | `lib/domain/machine.js`、`lib/tools.js` |
| R1-P0-3 | 补 `resume_task` / `drop_task` / `unassign_task`（handler + 群动词 + 工具 schema）；`drop_task` 顺手把它从需求的任务清单里摘掉 | `lib/tools.js`、`lib/feishu/ingest.js` |
| R1-P0-4 | `degradationLadder` 尊重 `opts.buttons === false`（默认配置下第一级就不带按钮）；兜底文案改成 `label + 对象 id` 的**群命令**，并加了一条"文案里的每句话解析器都认"的用例 | `lib/feishu/cards.js` |

**P1 修了九条**：

- 群命令语法扩成 `<动词> <id> [原因/对象]`（`阻塞 task-1 等接口` 不再掉进 prose 分诊）；
  词表补齐 `submit_task`/`confirm_split`/`unassign_task`/`resume_task`/`drop_task`/`renew_lease`（R1-P1-1）；
- 成员闸上移到 `createHandlers` 的统一出口，一处覆盖所有写动作；名册**非空**时是一张白名单，
  但**只管人**（`bot:*` 走机器人那层闸）（R1-P1-2）；
- 租约补 `renew_lease`；`resume/drop/unassign/renew` 与其余动作一样过闸（R1-P1-5）；
- 去重前移成"占位认领"（`inbox.claim()`，同步、在任何 await 之前）—— 并发重投不再重复下载/重复计数（R1-P1-6）；
- `run_task` 加进程内互斥（`already_running`），并发只驱动一轮（R1-P1-7）；
- 日报与 inbound 共用"谁是主"的解析（含 `bot_id` 历史兼容）（R1-P1-8）；
- `no-chat` 跳过写日志；缺 timer 时启动就 warn（R1-P1-9）；
- 定时催办 id 带小时时间片（否则第二次催办只是 PATCH 旧卡，人收不到通知）；
- `ci_start/ci_pass/ci_fail` 与 `archive` 补上身份守卫（以前任何人都能推"CI 通过"，而合并门禁读它）；
- `memberCanWrite` 对**非成员的人**默认拒绝（名册空时不限制）—— 成员表第一次真的是一张权限表。

**P2 顺手清了**：重复的 `flushDailyReports`；`feishu.statePath` 不再伪装成活配置；
日报与 @配额统一用**本地**日期（UTC 日期会让 UTC-6 的部署在下午重置配额）；
`no-chat` 日志；footer 的 0 语义统一（量不到才不显示）；工具 schema 补齐 11 个 handler
真读却未声明的参数（`slug`/`status`/`source`/`visibility`/`requiredApprovals`…，以前
`additionalProperties: false` 把它们**从工具调用挡在门外**）；`feishu.ask` 补上解析
（以前只在读取侧有默认值，旋钮拧不动）。

**测试基础设施**：`test/run-all.mjs` 现在把 `DSH_HOME` 指到一个空临时目录 ——
以前有若干用例没传 `dataDir`，于是它们**读的是开发者本人的真实配置**，测试结果与这台机器有关。
这是"审查发现的问题里最隐蔽的一条"，因为它会让别的缺陷时隐时现。

**明确留到第二轮**（写在这里以免被当成遗漏）：
面板对"被 row config 固定的键"没有提示（§13.2 记着）；container `docs` 的 `requirement_view`
没有生产者；`assets/` 与配置备份没有清理策略；语音/转发/撤回/表情四类入站事件仍未接；
审批三档（允许一次/本次会话/始终）未接 DSH approval；token 成本按天聚合未做。

## 9. 审查方法说明（便于复查）

- 四个视角各自独立读完代码后给出结论，**互不参考**；
- 我复核了每一条 P0 与五条 P1（能跑的都跑了：`transitionRequirement`、`availableActions`、
  并发重复投递、`degradationLadder`、`parseCommand`、`validateFrontmatter`、门禁 `due_at`）；
- 复核推翻了一条 P0（重复建单）与三条 P1/P2 的假设，见 §5；
- 本轮结束后按同样的四个视角**再审一次**（`REVIEW-02.md`），看修完是否引入新问题。
