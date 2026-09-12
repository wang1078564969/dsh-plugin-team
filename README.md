# dsh-plugin-team

DSH 的团队协作层：**需求 / 任务 / 两道人工确认 / 租约 / 决策**，而且**任务真的会被 agent 执行**。

这是一个 **DSH 插件**（Cordis row），不是外部服务 —— 会话、工作区、agent 循环、人在环审批都由 DSH 提供，
本插件只补"团队对象"这一层，并把任务**真的交给一个执行会话来跑**。

## 现在能跑什么

一句话：**群里说一句话 → 变成需求对象 → 拆任务 → 两道确认 → 交给执行会话跑一轮 → 汇报回写成证据 → 提交验收**，
并且在 DSH GUI 里有一块台账面板可以看和点。整条链路都在真实 harness / 真实飞书凭据上验过（见「实测」）。

| 文件 | 状态 |
|---|---|
| `package.json` / `cordis.patch.yml` | ✅ 按 DSH 插件约定；装包即装插件（含 `dsh.client` 浏览器半边） |
| `lib/index.js` | ✅ boot-safe 入口：加载失败只记日志，**绝不拖垮 harness**（真实 harness 里验过）；挂台账路由 |
| `lib/domain/`（3.4k 行） | ✅ hub 的领域层移植成纯 ESM JS、零依赖：两个状态机、门禁快照、三条硬闸、租约、超时扫描 |
| `lib/store.js` | ✅ 一对象一文件的 JSON 台账（原子写、按 kind 决定身份字段、两套 ID 规则） |
| `lib/config.js` | ✅ 配置解析（env > 配置文件 > row config > 默认值） |
| `lib/exec.js` | ✅ **心脏**：起/复用执行会话（`agents.create`/`resume`）、驱动一轮、等回合结束、读回汇报 |
| `lib/tools.js` | ✅ `team` 工具（13 个 action）：建需求/拆任务/两道确认/派发执行/提交验收/查台账/扫超时 |
| `lib/feishu/connection.js` | ✅ **自己的飞书长连接**（官方 SDK）：自己的凭据、自己的群登记、自己的机器人身份；**一个 app 一条连接**，多 app 由连接池逐个拨号；后台建连，不拖住激活 |
| `lib/bots.js` | ✅ **机器人注册表**：角色 / 基准角色 / 展示名 / 自己的飞书应用 / 所在群 / 发言策略 / 作用域 / 权限 / 模型 / 预算 / skills；路由（点名 > 绑定 > 角色优先级）与「配置问题」 |
| `lib/members.js` | ✅ **成员表**：一个人一行，角色域分配在**人身上**；兼容旧的 `{域: [人]}` 映射并派生出台账一直读的那张表 |
| `lib/sessions.js` | ✅ 会话身份是**机器人 × 群**（`team-bot-<botId>-<chatId>`）+ 发言租约（同一条群消息在多条连接上各到一次时只回一次） |
| `lib/feishu/apps.js` | ✅ 把 roster 按飞书应用分组：一个 app 一条连接一个身份；没配密钥的应用不会**静默**换成别的身份 |
| `lib/feishu/responder.js` | ✅ 一条消息由**一个机器人**回答，用它自己在这个群里的会话；发言策略（被 @ / 意图 / 租约 / 只播报）决定开不开口 |
| `lib/feishu/ingest.js` | ✅ 入站流水线：持久去重 → 指令解析 → 分诊 → 提取 → 建需求 → 回卡；**没建单的也记原因** |
| `lib/feishu/client.js` | ✅ 出站传输：token 缓存+并发合并、**非零 code 当失败**、五级降级投递 |
| `lib/feishu/{triage,extract,cards,broadcast}.js` | ✅ 从 hub 移植的协议层（分诊/提取/卡片与降级链/播报决策），纯函数 |
| `lib/workspace.js` | ✅ 让机器人的会话出现在**主机 DSH 客户端**里：注册工作区 + 挂会话 + 命名 + 落盘（详见下） |
| `lib/settings.js` | ✅ 配置台的 host 半边：读取 / 校验 / 原子写 / 审计 / 保存即重载 / 接入自检 |
| `lib/feishu/richtext.js` | ✅ markdown → 飞书卡片：标题/引用/列表/表格/分隔线改写、围栏保护、**行内代码去反引号**、超长截断、文本兜底剥标记（实测支持面见笔记 §16） |
| `lib/api.js` | ✅ 台账 API（`/api/team/ledger`，走 connection 的 cookie 鉴权；**没有 actor 的写操作一律拒绝**） |
| `lib/client.js` | ✅ DSH GUI 台账面板（侧栏入口 + 中心面板；手写 classic-script 半边，无构建） |
| `test/` | ✅ 380 个用例全绿（`npm test`），另有 2 个**可选**的渲染测试（见「实测」第 8 条） |
| 记忆 / skills 库 / 角色 preset 自动生成 | ⬜ 设计文档 07 与 02 §1.2，尚未落进插件 |

## 三个一等对象：机器人 / 成员 / 会话

旧 hub 的内管工作台里，这三样是分开的，这一点在插件里也一样 —— 第一版把它们压成
"一个 app + 一个群一个会话"，那是客服机器人的形状，不是团队。

### 机器人（N 个，和 agent 1:1）

一个机器人 = **一个身份 + 一个角色 + 自己的群 + 自己的会话**：

| 字段 | 含义 |
|---|---|
| `id` / `displayName` | `dev` / 开发机器人；群里点名说 `@开发机器人` 或 `dev` 就能找到它 |
| `role` / `baseRole` | `req`/`dev`/`qa`/`coord`/`lib`/`ops`/`custom`；基准角色决定它默认继承谁的权限与预设 |
| `agentPreset` / `model.primary` | 它作为哪个 DSH agent 跑（缺省按角色取 `sessions.presets[role]`）；模型也是**按机器人**覆盖 |
| `feishu.appId` | 它用哪个飞书应用说话（留空时由加载器采纳安装级的那个，从此是它自己的） |
| `feishu.chats` | 它服务哪些群；**空 = 该应用下的所有群**。非空就是真过滤（一个机器人不会被拉到别的群里说话） |
| `feishu.speakPolicy` | `onMention`（被 @ 必答）/ `onIntent`（没被 @ 但像它的活也可以答）/ `leaseRequired`（先拿发言租约）/ `digestOnly`（只播报） |
| `scope` / `permissions` / `budget` / `skills` / `knowledgePack` | 作用域、能做什么、预算、技能与知识包（设计文档 02 §2 的 `bot.yaml`，面板先做只读展示） |
| `enabled` | 关掉就是不上线；**默认关**（手写 roster 忘了写 `enabled` 不会突然在真群里说话） |

**应用是机器人的属性，不是全局配置**：`app id` / 密钥 / 机器人 `open_id` / 所在群都在「机器人」页
跟着那一台机器人改（一台机器人一个应用）。**没有"默认应用"这个概念**——每台机器人自己回答
"我用哪个应用"：安装级的 `feishu.appId` 会在加载时**被采纳进**每一台还没写应用的机器人
（`config.ownApps`），所以你现在的 id 就是这台机器人自己的 id，而不是一个它会继承的全局值。

密钥**只有一个家**：写进它自己那个应用的条目 `feishu.apps.<appId>.appSecret`（面板永远不问
"这是不是默认应用"）。老的安装级 `feishu.appSecret` 仍然**读得到**（应用条目没有密钥时兜底，
所以现有安装不会因为这次改动掉线），而一旦应用条目里真的写上了密钥，保存会把那个老键
**迁走**（同一个值不留两份）；两个框都留空就一个字节都不发。

**一条物理约束，绕不过去**：一个飞书应用只有一条长连接、一个身份。所以
**两个机器人填同一个 `app_id`，在群里就是同一张脸**（同名同头像同权限）。
要"需求机器人 / 开发机器人"在飞书里各是各的，就得**每个机器人一个飞书应用**
（各自填 `feishu.apps.<appId>.appSecret`），插件会为每个应用各拨一条连接。
只有一个应用也能跑：那时多机器人靠**角色 + 会话**区分，卡片头会带上是谁在回答
（这是同一张脸下唯一能看出角色的地方），配置检查里也会写明"共用一个飞书应用"。

**谁回答**（顺序就是 `routeBots` 的顺序）：
1. 消息里**点名**的机器人 —— 明确指名永远优先；
2. 这个群**已经绑定**的机器人 —— 一直跟谁说话就还是谁（改 roster 不会中途换人格）；
3. 角色优先级最高的那个（`coord` > `req` > `dev` > `qa` > `lib` > `ops` > `custom`）。

**开不开口**是另一个问题，由该机器人自己的 `speakPolicy` 决定：被点名 → 必须答；
没被点名但命中意图词 → 只有开了 `onIntent` 的机器人才答（所以"能答的那种活"不会被
一个更安静的高优先级机器人挡住）；私聊永远答。`digestOnly` 的机器人只发文本、不发卡片。

### 成员（多个，角色分配在人身上）

`members` 现在是**一张表**：一行一个人，`key`（`human:<名字>`）、`name`、`openId`、
`role`（`owner`/`member`/`observer`）、`domains`（角色域，可以多个）、`projects`、
`canApprove`、`delegate`（休假时的代理）、`active`。

台账一直读的那张"域 → 负责人"映射**还在**，只是变成了**派生结果**（`config.domains`）：
表的每一行把它的 `domains` 并进去，旧格式 `{pm: [...]}` 也照读不误。
**兼容是硬要求**：直接把旧映射换掉会让列在里面的人失去确认自己需求的资格，而且是静默的。

成员行里填了 `openId`，保存时会**顺带**补上 `feishu.senders` 映射（按键确认要靠它认人）；
反过来，`senders` 里已有的映射也会自动填进成员行 —— 一个 open_id 只输一次。
已有映射**只增不改**：手工写的那行永远优先。已被移除的成员如果还留着 sender 映射，
配置台会把它列在「未绑定 open_id 的 sender」里**报告**（不自动删：删错了就是把人锁在外面）。

### 需求的生命周期（不再"只进不出"）

| 动作 | 谁 | 说明 |
|---|---|---|
| `finish_requirement` | 需求负责人 / 域负责人 | 其下任务**全部** done 才允许（设计 06 §7 完整性约束 2）；最后一个任务被验收时**系统自己**也会推一次 —— 以前没有任何路径能产出 `done`，需求永远停在 `dispatched` |
| `archive_requirement` | 同上 | `done → archived`，视图转只读 |
| `change_requirement` | 同上 | 必须写"变了什么"；会自动把受影响的任务置为 `suspended`（设计 06 §3.1 的 effects） |
| `reconfirm_requirement` | 同上 | `changed → confirmed`，重走拆解 |
| `suspend/resume/block/unblock/drop` | 需求负责人或 pm | 治理类；`drop` 必须写原因 |

面板的台账页上，需求卡片按 host 给的 `available` 渲染按钮（`change`/`drop` 因为要写
原因，不画按钮但会说明去哪儿做）。

**去重**：同一件事换个说法再说一遍，会被**并入已有需求**（`findDuplicate`）并在群里
指回去，不再长第二张卡。**追问**：信息不全时机器人主动问一次具体的问题
（"怎样算做完？"），问过就转被动，状态记在群记录上（重启仍然记得）。
**批次窗口**：触发消息会和它前面**同一发件人连续说的几句**一起当成一批
（`selectContextMessages`：别人插话即话题边界、有上限）。

### 群的主机器人（每个群一个，负责这个群*所有*消息的记录）

**一个群有一个主的机器人**：群里的每条消息都记在它名下 —— 不管最后是谁回答、甚至没人回答。
两个数字特意分开，因为它们本来就该对不上：

| 数字 | 含义 |
|---|---|
| `seen`（消息数） | 主机器人**名下记了多少条**消息（含它没有回答的那些） |
| `turns`（轮次） | 它**真正回答过**多少轮 |

**主在首次接触时定下，此后不变**；规则与"谁来回这一条"共用同一套顺序（点名 > 已绑定 >
角色优先级），但**归属是黏性的**：一个群被点名换人回答一次，不该把"这个群归谁记"也换掉。
`pickPrimaryBot()` 与 `routeBots()` 因此是两条不同的规则（前者在已有主时优先原主，
后者让被点名的人来答）。

换主是**显式动作**：面板「会话」页的群表里选一台机器人 → 「改主」→ 走台账路由的
`set_primary_bot`（记下是谁改的、什么时候改的、之前是谁）。旧的群记录不会被改写 ——
新主从这个群的下一条开始记。

记录是**地板，不是流水线的副产品**：分诊/建单/卡片那一层没起来时（`feishu.mode = off`
或协议层加载失败），群记录与"主机器人记下了这一条"照样成立。

### 会话（按机器人创建，一个机器人 × 一个群一份）

```
team-bot-<botId>-<chatId>        # 有 roster 时：机器人自己的上下文
team-feishu-<chatId>             # bots: [] 时的单助手模式（旧行为，原样保留）
```

同一个开发机器人在需求群和开发群里是**两段上下文**；同一个群里两个机器人也是两段。
`bots: []` 是**明确的开关**：不要 roster，退回"一个助手、一个群一个会话"。

**会话不需要预先声明**：任务派给哪个机器人，就用**那个机器人**的 `agentPreset` 与 `model.primary` 按需起会话
（`sessionSpecFor`，见 `lib/tools.js`）；群里来一条消息，就用那个机器人在这个群的会话起一轮。
所以「配置」页里那张"角色 → preset"的表已经删掉了 —— preset 是机器人的属性，
让人再按角色填一遍，等于把同一个决定写两处，而其中一处（角色表）在机器人写了之后根本不生效。

面板「会话」页按机器人分组列出每一段会话（群名 / DSH 会话 id / 轮次 / 最后活动 / 工作区）。
侧栏里的会话标题是 `飞书 · <群名> · <机器人名>`：一个群里两个机器人就是两条会话，
不带机器人名根本分不出来。

## 在主机 DSH 客户端里看机器人的会话

飞书里每个群/单聊 = 一个 DSH 会话，它们都跑在**团队工作区**里。
要让它们在客户端侧栏可见，需要三件事同时成立（缺一个就是"看不见但也不报错"）：

| 需要 | 谁做 | 怎么做 |
|---|---|---|
| 有一个**工作区**认领这个目录 | `lib/workspace.js` | `workspaceRegistry.create(workspace, '团队 · 飞书')`，插件挂载时就注册 |
| 会话**落盘**（列表由持久化的 header 索引生成） | 同上 | 每条消息后 `sessions.flush(session)`，不用等检查点 |
| 会话有**人看得懂的名字** | 同上 | 取群名（`/im/v1/chats/:id`）→ `sessionTitle.rename(session, '飞书 · <群名>')` |

于是主机客户端侧栏会多出一个工作区「**团队 · 飞书**」，点开就是所有机器人的对话：
`飞书 · AAB`、`飞书 · 飞书单聊 9a10fa`…… 每条都能像普通会话一样打开看完整过程。

> 注意 `workspaceRegistry` 和 `connection` 一样**比插件激活更晚就绪**（它要先等 sessionPersistence
> 建完 header 索引），所以必须用 `ctx.inject([...], cb)` 等它，`ctx.get` 会静默拿到 undefined —— 这个坑
> 一天里踩了两次（见 `docs/DSH-PLUGIN-NOTES.md` §14）。

## 依赖

**运行时只依赖一个包**：`@larksuiteoapi/node-sdk`。飞书的长连接是 protobuf 帧 + 自己的握手/心跳/重连协议，
自己实现不现实；SDK 只负责那一段，上面的一切（事件归一化、@ 判定、去重、台账、回答）都在本包里。

**不再依赖 `dsh-plugin-feishu-bot`**：这个插件自己拨号、自己认机器人身份、自己记有哪些群。
（一个飞书 app 只能有一条长连接，所以那个桥**不能同时跑**；它已从 web profile 里移除。）

## 它和 hub 的关系

`../hub` 是同一套设计的**外部常驻服务**实现（自研 CLI + Vue 控制台 + SQLite + 自己管进程）。
它把"协作协议"写完了，但**从来没有把 DSH 接进去**：任务状态机全靠人点卡片推进，
`in_progress` 只是一个人点出来的状态 —— 用作者自己的话说，"本质都是在管理一个不会自己动的看板"。

本插件把那套协议搬进 DSH 进程内，补上缺的那一环：

| | 外部 Hub | 本插件 |
|---|---|---|
| 驱动 agent | 手搓 JSON-RPC、管进程、踩会话编码冲突 | 进程内 `ctx.get('agents')` |
| 任务真的执行 | ❌ 靠人点按钮 | ✅ `run_task` 交给真实会话，汇报回写为证据 |
| 会话可见 | 自己再写查看页 | DSH GUI 原生 |
| 人在环审批 | 自研卡片按钮 + nonce + 验签 | `user-questions/request` / `approval/request` waterfall |
| 安装 | 起进程、配端口 | `dsh plugin add` |

**hub 原地保留**：`src/domain/`（对象与状态机）、`src/runtime/triage.ts`（消息分诊）、
门禁快照与租约的测试用例都值得继续参考；但 `server/` `console/` `sqlite/` `cli/` 不再开发。

## 安装（profile 里，已实测）

```bash
dsh plugin --profile web add "link:/Users/nitoo/Desktop/DSH 飞书插件/dsh-plugin-team"
```

包声明了 `dsh.bundle.patch`，所以上面的命令就是**全部安装动作**（它同时把包写进
`dsh.profile.bundles`）。摘干净用 `dsh plugin --profile web remove dsh-plugin-team`。

⚠️ 它做 bundle 对账时，会**把已安装但不在 bundles 里的包也补进去**：实测
`dsh-plugin-feishu-bot` 被一起写进了 bundles（即下次重启飞书桥会开始连飞书）。
不想要就在 profile 的 `cordis.patch.yml` 里 `- id: feishu-bot` + `disabled: true`。

装完必查（`THROWING` 必须是 0，否则每个会话的每个请求都会失败）：

```bash
dsh --profile web --dump-config > /tmp/my-tree.yml
node ~/.dsh/profiles/web/plugins/inventory-check.cjs /tmp/my-tree.yml
```

## 配置台（就在 DSH GUI 的面板里）

hub 当年的「内管配置」现在搬进了插件自己的面板 —— 打开侧栏「**团队台账**」，顶部五个页签：

| 页 | 内容 |
|---|---|
| **台账** | 需求 / 任务 / 租约 / 执行会话；每个任务按状态机允许的动作渲染按钮（接受 / 开始 / ▶ 执行一轮 / 提交 / 验收 / 扫超时预演） |
| **配置** | 接入自检 + **全局**配置 + 保存。两段是只读的：「会话」显示每个角色的 preset 由谁提供（机器人自己的 `agentPreset` / 角色映射 / 全局兜底）；「飞书应用」只报现状——因为应用是机器人的属性，在**机器人页**编辑 |
| **机器人** | roster：id / 显示名 / 角色 / 基准角色 / 飞书应用 / 所在群 / **配置问题** / 状态 / 操作（编辑 · 启停 · 删除）；「编辑」里改**这一台**的全部字段（含**它的飞书应用与密钥**、所在群、发言策略四开关、agent 预设与模型）；下表是该机器人自己的会话 |
| **成员** | 成员表：成员键 / 姓名 / open_id / 角色 / 角色域 / 项目 / 可批准 / 状态 / 配置问题；行内增删改；下面列出"没有对应成员的 sender" |
| **会话** | 上半是**群与主机器人**（群 / 主机器人 / 消息·轮次 / 上次活动 / **改主**），下半是每个机器人 × 每个群的会话：群 / DSH 会话 id / 轮次 / 最后活动 / 工作区 |

**配置问题逐行显示**（`roster.bots[].problems` / `roster.members[].problems`），
不是一串 `bots[3].feishu.appId` 让人自己数行：机器人 id 重复、启用了却没有可用应用、
应用没有密钥、两个机器人共用一个应用（同一张脸）、既不答 @ 也看不了意图（只会记录）、
成员键不合法、成员没有 open_id（按键时认不出人）……全是**在保存前**就拒绝的。

**接入自检**（等价于旧 hub 的 `hub check`，都是真调飞书）：凭据来源与 appId、机器人身份（名字 + open_id）、长连接状态（connected / 最后就绪时间 / 最后错误）、机器人当前在哪些群、台账计数。

**配置表单**可改：负责人与角色域成员、`senders`（open_id → 人）、`chatActors`、工作区与侧栏标题、门禁四道超时与策略、各角色 agent preset、飞书开关（mode / requireMention / respond / buttons / chatIds / appId / appSecret）。

四条设计约定：

1. **保存前校验，拒绝就一个字节都不写** —— 问题以 `path + message` 逐条返回（`gates.accept.timeout: 超时写法形如 30m / 2h / 1d`），表单标在对应字段上。
2. **密钥只写不读**：`appSecret` 只能设置，回显的是"已设置"；留空表示不修改（空框不会把已有密钥抹掉）。首尾空白会被拦下 —— 粘贴密钥最常见的事故。
3. **保存即生效**：`reload()` 把文件重新读进运行中的配置对象；改了凭据或 `mode` 会**就地重建长连接**（响应里带 `restarted`），不用重启 harness。
   —— 唯一的例外是设计本身要冻结的东西：进行中任务的**门禁快照**不受影响（改超时只影响新任务，doc 06 §4.2）。
4. **可审计**：每次保存写一行 `config-audit.jsonl`（谁、改了哪些键、备份路径），旧文件备份成 `config.json.bak-<时间戳>`（600 权限）。

> 配置的**真身始终是那个文件**。面板是编辑它的界面，不是它的主人：手写的 `//` 注释键、面板不认识的键，保存时全部原样保留。

## 配置文件

优先级：**环境变量 > `$DSH_HOME/team/config.json` > row 的 `config:` 块 > 默认值**。
样例见 `config.example.json`。最常改的三个：

| 键 | 作用 |
|---|---|
| `workspace` | 执行会话的工作目录 —— 任务在这里被真正做掉（env `DSH_TEAM_WORKSPACE`） |
| `bots` | 机器人 roster（数组；`[]` = 单助手模式）。见「三个一等对象」 |
| `members` | 成员表（数组）。旧的 `{域: [人]}` 映射也照读，写回时落到 `domains` |
| `domains` | 域 → 负责人（派生自成员表，也可单独写） |
| `feishu.appId` / `feishu.appSecret` / `feishu.botOpenId` | 安装级应用记录（老形态）。加载时被采纳进每台没写应用的机器人；密钥在**机器人页**编辑，写回时落到应用自己的条目里 |
| `feishu.apps` | `{ "<appId>": { appSecret, botOpenId, name } }`：**应用登记表**，每台机器人指名其中一个（密钥的面板写入目标） |
| `feishu.speakLeaseMs` | 两个机器人都可能接话时，先说话的那个把群占住多久（默认 90s） |
| ~~`feishu.chatIds`~~ | **已删除**：插件从来没有读它（填了也不会"只处理这些群"）。群绑定在机器人身上（`bots[].feishu.chats`）；旧值会被配置检查直接拒绝并说明原因 |
| `sessions.presets` | **机器人之前的遗留兜底**：按角色指定 agent preset。机器人自己的 `agentPreset` 永远优先，所以它只对"名册里没有这个角色"或"手写的旧台账"起作用；面板不再请人填它 |

`dataDir`（默认 `~/.dsh/team`）只能用 env 或 row config 给 —— 配置文件本身就在它里面。

## 数据放哪

```
$DSH_HOME/team/
  config.json                    # 可选，人可读的配置
  workspace/                     # 执行会话的工作目录（默认值）
  requirements/req-2026-001.json # 需求
  tasks/task-1.json              # 任务（含门禁快照与证据）
  leases/task-1.json             # 租约：身份就是 task id
  decisions/adr-2026-001.json    # 决策
  runs/task-1.json               # 任务 ↔ 执行会话（本插件自己的簿记）
  chats/oc_xxx.json              # 一个群自己的记录：名字、类型、最近跟哪个机器人说话
  bot-sessions/dev.oc_xxx.json   # 机器人 × 群 的会话：DSH 会话 id、轮次、最后活动
  inbox/messages.jsonl           # 收到的每条消息（含没建单的原因），追加写
  config-audit.jsonl             # 每次保存配置一行：谁、改了哪些键、备份在哪
```

JSON 而不是数据库是**有意的**：出问题时人得能 `cat` 一个需求、看见它在什么状态、
为什么，并在界面本身坏掉时手工改。这是逃生口。

## 实测（2026-09-12）

**每一条都是真跑出来的，不是"应该能跑"：**

1. **boot-safe**（真 harness）：故意让 `lib/team.js` 加载失败 → harness 照常启动并回答（exit 0），插件只在自己日志里留下原因。
2. **心脏端到端**（`--profile headless` + 真模型）：模型只用 `team` 工具走完整条流水线 →
   需求 `req-2026-001`、任务 `task-1`（`bot:dev`）、执行会话 `team-task-1` 真的去读了工作区文件
   （还自己用 `od -c` 与 sha256 校验），把 `MAGIC-7391` 汇报回来 → 回写为证据（`session:team-task-1`）→
   状态推进到 `in_review`。改完飞书层后复跑一次，结果一致。
3. **飞书出站**（真凭据）：`resolveCredentials` 从桥的 config 取到 app `cli_aa91…`，
   `GET /open-apis/im/v1/chats` 返回 `code: 0` —— token 位置、Bearer 鉴权、错误语义都对。
   （**没有发任何消息**：往真实群里发测试卡是要你点头的事。）
4. **飞书入站**（真实协议层）：合成的群消息喂进桥的接缝 → 真分诊 → 真提取 → 建出
   `origin.surface=feishu` 的需求对象 → 真卡片回群；闲聊只记原因不建单；
   `接受 task-1` 走真门禁并起租；被别人接受时群里看到的是状态机原话。
5. **`@` 不被词表否决**：`@机器人 支付重试这块` 会一路走到台账（标题已去掉 @ 前缀），
   而不带 @ 的同一句话仍然只记原因。
6. **装进 web profile**：`inventory-check` → `154/154 identified, THROWING: 0`。
7. **路由真的挂上了（隔离 web 实例实测）**：临时 `DSH_HOME` + 3099 端口起一份 web，日志出现
   `[team] ledger route mounted at /api/team/ledger (behind the /api browser fence)`；
   拿启动 token 换 cookie 后 `GET /api/team/ledger` → **200 + JSON 快照**，
   同一 cookie 访问不存在的路径 → **404**（对照），无 cookie → **401**（围栏在它前面），
   无 `actor` 的 POST → 被拒。
   —— 这修的是个真 bug：**`ctx.get('connection')` 在 web profile 里也拿不到服务**，
   必须用 `ctx.inject(['connection'], cb)`（DSH 自己的 api gateway 就是这么写的）。
   `test/route.test.mjs` 用一个"只认 inject、`get` 永远返回 undefined"的假 ctx 把它钉住了。

8. **配置台（隔离 web 实例 + 真 HTTP）**：`GET /api/team/config` 返回配置 + 自检
   （凭据 ✅ / 机器人身份 ✅ / 长连接 ✅ / 机器人所在群 ✅）；`POST` 合法 patch → 落盘 + 就地重载 +
   **重建长连接**（响应带 `restarted`）；非法 patch → `invalid_config` 且**一个字节都没写**；
   缺 actor → 拒绝；每次保存留审计行与 `.bak-` 备份。密钥全程不回显。

9. **机器人 / 成员 / 会话三个对象（隔离 web 实例 + 真凭据，`feishu.mode=off` 所以不抢长连接）**：
   `GET /api/team/config` 返回的 `roster` 里，三个机器人各自带着**自己的配置问题**
   （共用应用 → warn「同一张脸」；指名了一个没配密钥的应用 → error + `offline` 说明）、
   成员表两行（其中一个的 `openId` 由 `feishu.senders` 自动填上、另一个被提醒"按键时认不出人"）、
   `roster.apps` 两个应用（密钥指纹、谁在用它）、未绑定 sender 被报告、`editable` 里出现
   `bots` / `domains` / `feishu.apps` / `feishu.speakLeaseMs`。
   `POST` 一份合法 roster + 成员表 → `applied: ["bots","members"]`、`derived.sendersAdded` 里是
   从成员行派生的 sender 映射、审计行与备份都落盘、**配置文件里没有运行态字段**
   （`problems`/`sessions`/`appIdResolved`/`connected` 都被归一化挡在外面）；
   `POST` 一份重复 id + 未配置应用的 roster → `invalid_config`，逐行给出 `bots[0].id` /
   `bots[1].id` / `bots[2].feishu.appId`，**文件一个字节都没变**。
   装配层也验了：`inventory-check` → `153/153 identified, THROWING: 0`。

10. **一台机器人一个应用（隔离实例 + 真 HTTP）**：一次 POST 同时带 `bots`（整组）与
    `feishu`（这台机器人自己应用的密钥）→ `applied: ["bots","feishu"]`，
    两台机器人各自解析到**自己的**应用（`req→cli_aa91…`、`dev→cli_devline…`），两个应用各自
    报告"密钥已设"与不同的指纹、各自的指纹与"谁在用它"，`offline` 为空；
    落盘后 `feishu.appSecret` 与 `feishu.apps.cli_devline….appSecret` 各就各位，
    **没有运行态字段泄漏**。指名一个没配密钥的应用 → `invalid_config` + `bots[1].feishu.appId`，
    文件一个字节都没变；已删除的 `feishu.chatIds` → 明确拒绝并指向 `bots[].feishu.chats`。

本地测试：`npm test` → **394 passed / 0 failed / 8 skipped**（跳过的是**可选**渲染测试组：台账页 / 配置页 /
机器人·成员·会话三页，`npm i -D react react-dom jsdom` 后即跑 → **402 passed / 0 failed / 0 skipped**）。
领域层另外用 hub 的 zod 实现当 oracle 做了 12 368 例差分（校验层 307 例逐字一致）；
分诊/提取层也做了 0 差异差分。

**GUI 半边：两级验证，都是真跑的。**

- `test/client-half.test.mjs`（跑在 `npm test` 里）：把 `lib/client.js` 当经典脚本喂给假的
  `__ModuleLoader__` + 假 `react`，断言包名、`inject`、以及 `apply()` 真的注册了
  `sidebar.panellist` 与 `main:team` 两个槽 —— 抓住"面板根本挂不上"。
- `test/client-render.test.mjs`（**可选，默认 skip**）：用**真的 react 18.3.1 + react-dom + jsdom**
  把面板渲染出来、真跑 effect、真点击，107 项断言：槽参数、每个动作的 POST body、
  拒绝原文（含"还差谁确认"）、畸形快照不白屏、GET 挂住 20s 超时、卸载后无残留监听。

```bash
# 想跑那个可选的渲染测试（不给零依赖的包硬塞 devDeps）：
npm i -D react react-dom jsdom && node --test test/client-render.test.mjs
# 或者指向任意装好它们的目录：
TEAM_CLIENT_TEST_MODULES=/path/with/node_modules node --test test/client-render.test.mjs
```

## 已知问题

- ~~多人验收门禁实际走不通（hub 既有 bug）~~ **已修**：确认现在**累积** ——
  第一次确认返回 `ok + partial`（状态不动、票记在门禁上、`pending` 说明还差谁），
  人齐了才完成。设计 04 §3.5 要的就是"并行确认、缺一方不推进"，而 hub 那版是把
  已记录的确认丢掉，于是永远 ping-pong。顺带修了同一处的一个更隐蔽的问题：
  验收人名单以前只算"任务跨越的域负责人 + pm"，**需求负责人自己反而点不动**自己
  需求下的验收（除非他碰巧兼着某个域）。
- **卡片按钮默认关闭**：按钮需要飞书能回调到的 HTTPS 入口（DSH Web 只监听 `127.0.0.1`），
  所以卡片走"去按钮 + 文本指令"那一级，群里的 `接受/开始/验收 task-1` 就是确认入口。
  要开按钮，得先有一个公网可达的回调地址。
- **一个 app 只能有一条长连接**：本插件现在自己持有它，所以 `dsh-plugin-feishu-bot`
  **不能同时跑**（已从 web profile 移除）。两个进程抢同一条连接的表现是"机器人时好时坏"，很难查。
- **发言人是真数据了**：事件里带 `sender.sender_id.open_id`，`feishu.senders`
  （`open_id → human:<名字>`）能精确工作；`feishu.chatActors`（一个群算一个人）那个
  兜底只在你想放宽时才需要。
- **群聊默认只在被 @ 时开口**（`feishu.requireMention: true`），私聊永远开口；
  要让机器人对群里每句话都应声就把它设成 false。
- **没登记的发言人只能看台账、不能改**：这是故意的（否则任何人都能用一句话
  替别人确认任务）。用 `feishu.senders` 把人登记进来。
- **单条消息提取**：`extractRequirement` 目前一次只喂一条消息，设计文档里的
  上下文窗口（把连续几条合成一个需求）还没接。
- **会话 id 有命名空间**：有 roster 时是 `team-bot-<botId>-<chatId>`，单助手模式是
  `team-feishu-<chat_id>`（都不是 `feishu-<chat_id>`）。后者是旧桥用过的形状，
  `agents.resume` 会把它的会话整个加载回来 —— 换个项目、带着别人的历史。
  池子还会校验"resume 回来的会话是否真的住在要的目录里"，不一致就重建（笔记 §15）。
- **一个机器人一个应用才有各自的身份**：不同机器人填同一个 `app_id` 时，它们在飞书里
  是同一张脸（这是飞书的限制，不是插件的）。此时群里只有一个"它"，多机器人只体现在
  角色、会话和卡片头上；配置检查会对这种共享明确告警。
- **`bots` 里的字段分两批**：`role/baseRole/agentPreset/model/skills/knowledgePack` 现在
  都真的生效（preset 与模型传给会话，角色决定路由与优先级）；`scope/permissions/budget`
  已建模、可在面板看到，但**还没有强制层**（设计文档 02 §2 的权限矩阵尚未落到代码）。

## 参考

- **`docs/DSH-PLUGIN-NOTES.md`** —— DSH 插件接口的实测事实（§1~§9 侦察、**§10/§11 写代码时新踩的 14 个坑**）。
  写代码前读这份，能省掉两轮侦察。
- `../team-agent-architecture/` —— 设计文档（对象与状态机见 `06`，飞书交互见 `04`）
- `../hub` —— 旧的外部 Hub。保留作参考，不再开发
- `../dsh-plugin-feishu-bot` —— 飞书 ↔ DSH 桥，**4700 行，不要重写**；它用的应用只能有一条长连接，
  团队插件现在自己持有连接，所以两者**不能同时跑**。要参考的是它的接缝设计，不是它的配置。
