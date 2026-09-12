# DSH 插件形态：实测事实与集成点

> 本文只写**跑出来的事实**，不写推测。每条都注明怎么验证的，新会话可以自己复现。
> 侦察时间：2026-09-12。DSH 版本 `0.1.5-rc.1`。

## 0. 一句话结论

团队协作层应该做成 **DSH 插件**（Cordis row），而不是外部常驻服务。DSH 已经提供了
之前手搓的四样东西：**会话、工作区、agent 循环、人在环审批**。插件只需要补"团队对象"
这一层。

---

## 1. 插件包结构（照抄 `dsh-plugin-feishu-bot` 的约定）

```jsonc
// package.json
{
  "type": "module",
  "main": "./lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },  // ./client 是 web UI 半边
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },       // 装包即装插件
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-slots"] }
  },
  "peerDependencies": { "@deepseek-ai/dsh-tools": "*" }
}
```

```yaml
# cordis.patch.yml
- insert:
    - id: team
      name: ./lib/index.js
```

**`dsh.bundle.patch` 是关键**：声明它的包会自动加入 profile 的 bundles 层栈，
`dsh plugin --profile web add link:/path/to/pkg` 就是全部安装动作，
`dsh plugin remove` 就摘干净。配置/禁用走 profile 自己的 `cordis.patch.yml`
（`- id: team` + `disabled: true` 或 `config: {...}`），因为它在所有 bundle 层**之后**应用。

## 2. 入口必须是"绝不拖垮 harness"的形式

**两条硬约束**（参考实现用血换来的，注释里写得很清楚）：

1. **boot audit 会重新抛出失败 row 的错误** → 插件加载时抛异常 = **整个 DSH 起不来**。
   所以 `apply()` 里所有可能失败的动作（import 实现、注册工具、挂路由）都必须 catch 住并只记日志。
2. **Cordis 只用 mtime 查询串做动态 import** → 实现文件（`lib/team.js`）用
   `await import(url.href + '?v=' + mtime)` 在 `apply()` **内部**加载，
   这样改完保存、重新激活 row 就生效，不用重启。

**`inject` 必须声明在 Cordis 直接 import 的那个模块上** —— 动态 import 进来的实现，
它的 `export const inject` 不会被读。

`inject` 里只放**必须有**的服务：Cordis 会把 inject 不可用的 fiber 挂起（静默不激活）。
`tools` 必须声明，因为 `ctx.tools.registerTool` 是对 service 的**属性访问**，traceable proxy 会拒绝；
其它服务（`agents`、`timer`、连接服务）一律用 `ctx.get('x')` 这种"可选读"，不需要声明。

## 3. 开一个会话 / 驱动一轮（心脏）

```js
const agents = ctx.get('agents')            // AgentRegistry（Service）
const live = agents.get(sessionId)          // → Agent | undefined
const handle = await agents.create({ ... }) // 或 agents.resume({ resumeSessionId, agentOptions, setup })
// handle.agent 是 Agent；handle 自带 disposer（能力即所有权）

// 驱动一轮：
agent.followup({
  id: newMessageId(),
  role: 'user',
  content: [{ type: 'text', text: prompt }],
  source: { kind: 'plugin', plugin: 'team', form: 'relay' },
})
// 等它静止：
await waitForWorkToSettle(agent, session, startedAt, isTimedOut)
// 取回复：lastAssistantText(session, startSeq)  （session.seq 是回合起点）
```

相关服务：`agentPresets.resolve(name)`、`permissionPresets.set(session, preset)`、
`sessionTitle.rename(session, name)`。

## 4. 人在环：飞书里回答 DSH 的提问与审批

DSH 把这两个决策放在 **Cordis waterfall** 上：

| 事件 | 何时触发 |
|---|---|
| `user-questions/request` | 模型调用 `ask_user_question` 工具时 |
| `approval/request` | 工具调用需要权限决策时 |

参考实现用 `{ prepend: true }` 注册，并且**只认领"这一轮是飞书驱动"的会话**
（`activeTurns` 集合）—— 因为浏览器端 answerer 也挂在同一条 waterfall 上，
GUI 发起的提问该归 GUI。没有这个区分，`ask()` 会找不到回答者。

**这条对团队层很重要**：需求确认、任务接受/开始这两道人工确认，
可以直接复用 DSH 的提问机制，而不必自己发明卡片按钮协议。

## 5. cwd = 工作区（已实测）

```console
$ cd /tmp/dsh-probe && dsh --profile headless "读取当前目录下的 note.txt，只回答那个字符串"
MAGIC-7391
```

- headless 一次性驱动，最终回答打到 **stdout**，推理过程到 stderr
- **没有 `--workspace` 参数**：工作区就是**进程启动时的 cwd**
- 权限三档：`read-only` / `workspace-write` / `danger-full-access`（`dsh-permission-presets`）
- 当前 `~/.dsh/settings.yaml` 是 `permission.defaultPreset: read-only`

## 6. SDK runtime（常驻接口，已实测握手成功）

`dsh --profile sdk-minimal` 起 JSON-RPC stdio 服务（换行分隔）。

| 请求 | 说明 |
|---|---|
| `initialize` | `{ cwd, provider, model, reasoningEffort?, maxTokens? }` |
| | **`cwd` 是进程级的**：一个 runtime = 一个工作区 |
| | 返回 `serverInfo.name = "deepseek-harness-sdk-runtime"` |
| `session/prompt` | `{ sessionId, contentBlocks }`；**sessionId 未知就懒创建 agent+session** |
| `shutdown` | — |

通知：`session.event`（完整会话日志事件流）、`session.status`（`idle`/`running`）、
`subagent.started` / `subagent.finished`。

**踩过的坑（必须避开）**：`sdk-minimal` 用 `compression: none` 写 `$DSH_HOME/sessions`，
而 web/tui 模式用 `jsonl.zstd`。同一个 root 混用会直接报错：

```
session artifact "...session.v3.jsonl.zstd" uses .jsonl.zstd,
but this backend is configured for compression "none"
```

**解法**：`--patch` 覆盖层把 SDK 的会话根目录分开：

```yaml
- id: sessions
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: !!js dshHomePath('sessions-sdk')
    compression: none
```

> 注意：插件形态**不需要**走 SDK runtime —— 进程内直接拿 `agents` 服务更简单。
> 这条路留着是为了"一个项目一个独立工作区的 runtime"那种部署。

## 7. 可用的进程内服务（按需 `ctx.get()`）

`agents`（AgentRegistry）、`agentPresets`、`permissionPresets`、`sessionTitle`、
`sessionQuery`、`tools`、`storage`（+ `dsh-storage-domain`）、`sandbox`、
`typertGateway`（`invoke({namespace, method, args})`，可跑 DSH 原生命令）、
`connection`（web 半边：`connection.fetch.register({path, methods, fetch})` 挂带鉴权的路由）、
`webServer`（裸路由，**无鉴权**，慎用）。

事件：`session/event`、`user-questions/request`、`approval/request`。

## 8. 环境已就绪的部分

- `~/.dsh/settings.yaml`：`agent-default-model` = `deepseek-official / deepseek-flash`，
  `reasoningEffort: max`；另有 kimi / 火山（glm-5.3）等 provider 配好
- 模型凭据在 `~/.dsh/llm-deepseek/`（**插件不用管密钥**）
- profile：`~/.dsh/profiles/web`（已装 `dsh-plugin-feishu-bot`，符号链接到本仓库，改 `lib/*.js` 即生效）
- **headless 与 SDK 都不需要额外的 key 注入**，实测直接可用

## 9. 与飞书桥插件的关系

`dsh-plugin-feishu-bot`（本仓库同级目录）已经做了：**一个飞书群 → 一个 DSH 会话**、
卡片与降级投递、文件发送、slash 命令、工作区/会话切换、`group_require_mention`、
`acknowledge`（收到消息先回表情）、人在环问答与审批。**4700 行，不要重写。**

它**没有**对外提供 Cordis 服务，只在内部监听事件。所以团队插件有两条路：

1. **独立 row + 复用同一个 `agents` 服务**（改动小，两行共存；
   但"群消息 → 团队对象"的接线要自己从 `session/event` 里看）
2. 给桥加一个对外服务（要改 4700 行的那个文件，风险大）

**当前选择：路 1。**

---

## 10. 写 `lib/team.js` 时新踩到的坑（2026-09-12 实测，已验证）

上面 1~9 节是侦察阶段的事实。下面这几条是**真的把插件跑起来之后**才暴露的，
每一条都对应一次真实失败，来的人可以省掉这一轮。

### 10.1 插件里 `agents.create()` 必须自己解析默认模型（否则整轮以 error 结束）

`@deepseek-ai/dsh-agent-loop` 注册了一个 prompt 变量：

```js
ctx.systemPrompt.variable('model', (context) => context.agent?.options.model)
```

而部署的 persona 段里写着 `{{model}}`。所以**用空的 `agentOptions` 建会话**，
提示词组装阶段就直接失败，回合以 `error` 收场、模型一个字都没说：

```
turn/end {"reason":{"kind":"error","error":{
  "message":"prompt variable \"{{model}}\" has no value for this assembly
             (section \"deployment:persona-prefix\")"}}}
```

交互式会话不会遇到，因为 app 在别处替它们解析了默认值。插件要自己来：

```js
const selection = ctx.get('agentDefaultModel').currentSelection()  // {provider, model, reasoningEffort?}
```

**这条的代价**：第一版 E2E 跑通了整条流水线，但执行会话的证据是
「（本轮没有文本汇报）」——状态机、门禁、回写全对，只有模型没说话。

### 10.2 任务侧的动作名是 `confirm_split`，不是 `confirm`

`TASK_ALLOWED` 里任务用 `confirm_split: ['proposed']`；`confirm` 是**需求**的动作
（`draft → confirmed`）。调用 `transitionTask(task, 'confirm', …)` 会拿到
`{ok:false, code:'unknown', message:'未实现的动作 confirm'}`。

### 10.3 `assign` 的执行者从 **context** 读，不在任务对象上

```js
// hub/src/domain/machine.ts，case 'assign'
const who = ctx.suggestedAssignee ?? null
if (who === null) return err('no_assignee', …)
```

所以"把 assignee 写进任务对象再调 `assign`"会静默失败（`no_assignee`）。
正确做法：随 `TransitionContext` 一起传 `{ suggestedAssignee }`。

### 10.4 租约对象**没有 `id`**，它的身份就是 `task`

`leaseSchema` 的字段是 `task`（一个任务同时只能有一个有效租约）。
一个要求 `doc.id` 的仓库会拒收它；别给它编一个 id——那会让同一件事有两个身份
并让两者漂移。仓库按 kind 决定身份字段即可。

### 10.5 两套 ID 规则，别统一

`req-<yyyy>-<NNN>`（按年）与 `task-<N>`（**全局递增**，不按需求分段）。
schema 用正则钉着这两条（`^req-\d{4}-\d{3,}$` / `^task-\d+$`）；
把任务也按年份编号会被 `parseTask` 直接拒掉。

### 10.6 执行会话不该能改台账

`team` 工具是全局注册的，**执行会话也看得见它**。若不管，执行者可以自己写证据、
自己推状态，甚至递归调 `run_task`。做法：`execute(args, exec)` 里用
`exec.agent.id` 判断是不是本插件驱动的会话，是就拒绝（让它把结果写在汇报里，
由团队层回写）。

### 10.7 boot-safety 在真实 harness 里验过了

`lib/team.js` 故意留成缺失状态跑了一次真 profile：

```console
$ dsh --profile headless --patch team.patch.yml "只回答三个字：READY"
READY                      # exit 0
[team] cannot load …/lib/team.js: ERR_MODULE_NOT_FOUND: … domain/index.js
```

**harness 照常启动、照常回答**，插件只在自己的日志里留下原因。这条契约不是推测。

### 10.8 `dsh plugin add` 会顺手把**已安装但不在 bundles 里**的包也补进去

`dsh plugin add` 在 `pnpm add` 之后会做一次对账（"Reconcile `dsh.profile.bundles`
against the installed state"）。实测：`dsh-plugin-feishu-bot` 早就在
`dependencies` 里但**不在** `bundles` 里，装团队插件时它被一起写进了 bundles ——
也就是**下一次重启，飞书桥会开始连飞书**。不想要就在 profile 的
`cordis.patch.yml` 里显式关掉：

```yaml
- id: feishu-bot
  disabled: true
```

### 10.9 装完必查的两条

```console
$ dsh --profile web --dump-config > /tmp/tree.yml     # 用 /tmp 下自己的文件名
$ node ~/.dsh/profiles/web/plugins/inventory-check.cjs /tmp/tree.yml
entries checked: 154  →  identified: 154, loose modules: 0, THROWING: 0
```

`THROWING` 必须是 0：某个 row 的所属包认不出来时，**每个会话的每个请求**都会
以 `REQUEST_EXTENSION` 失败。另外 `/tmp/tree.yml` 可能早就被别的会话用 root 建过
（重定向会 `Permission denied`，而你会读到**旧的**内容）——换个文件名。

---

## 11. 写飞书层与 GUI 半边时新踩到的坑（2026-09-12，全部实测）

### 11.1 降级链的每一级长什么样：`{msg_type, content, uuid}`，**不是** `{card}`

`degradationLadder(spec)` 的 1~4 级返回的是**飞书 API 请求体本身**：

```js
{ level: 1, via: 'card', payload: { msg_type: 'interactive', content: '<卡片 JSON 串>', uuid: 'req-2026-014-card' } }
```

`content` **已经是字符串**，不是对象。发送端如果按 `payload.card` 取内容，会把每一级
卡片都发成空 body —— 内容恰好在"保证不丢"的地方丢掉。另外 `uuid` 是幂等键，必须透传，
否则重试会重复发卡。第 5 级多一个 `file` 字段（附件描述，multipart 上传属发送层）。

### 11.2 卡片构造函数要一个**带 `nonce()` 的 ctx**

```js
buildRequirementCard(req, tasks, { nonce: () => …, now: () => new Date(), leaseOf: (id) => …, buttons: false })
```

`nonce()` 不是可选的（按钮 value 要用）。只传 `{buttons:false}` 会得到
`TypeError: ctx.nonce is not a function`；而如果调用点用 `try/catch` 包着卡片构建
（也确实该包着：渲染失败不该丢对象），**这个错会被静默吞掉、降级成纯文本** ——
于是"卡片能用"变成一个没人发现的假设。测试要断言 `msg_type === 'interactive'`，
而不是"发出去了东西"。

### 11.3 先分诊、后提取的顺序，会让"被 @ 不许被词表否决"这条规则**不可达**

设计文档写得很清楚（02 §3 / 04 §6）：词表只用来判断**没 @ 机器人**时群里哪句话值得收；
@ 了本身就是最强的意图信号。但 hub（以及照抄它的流水线）是先分诊、`kind !== 'requirement'`
就直接忽略，于是：

```
@机器人 支付重试这块   → 分诊：status（"有内容但没有表达诉求"）→ 被丢弃
```

提取层里那段"直接 @ 了就把判据放宽"的代码**永远跑不到**。修法在上层二选一：
`directAddress` 时用 `{...cfg, require_intent:false}` 再分诊，或放行 `status`/`question`
继续走提取。这条失败作者本人抱怨过一次（"群机器人只要@了就对用户输入做出相应"）。

### 11.4 部分配置会**整块覆盖**默认值（`{} ?? DEFAULT` 的陷阱）

```js
config: config.feishu?.triage ?? triage.DEFAULT_TRIAGE_CONFIG   // ✗
```

`config.feishu.triage` 只要是 `{}`（"我写了这个键但没写内容"），它就是 truthy，
默认值全部丢失 → `intentWords is not iterable` 崩在分诊里。凡是"默认值 + 用户覆盖"的
地方都要**合并**而不是**替换**：`resolveTriageConfig(partial)` 或
`{...DEFAULT, ...(partial ?? {})}`。同一轮里这份代码犯了两次（triage 与 commands）。

### 11.5 浏览器半边：手写 bundle 的契约，以及主题变量的真身

- 契约照 `dsh-plugin-feishu-bot/lib/client.js`：`window.__ModuleLoader__.load({id, factory})`、
  **经典脚本**（没有顶层 import/export）、`id` 必须是**包名**、只 `require('react')`、
  `module.exports.apply = (ctx) => ctx.slots.inject(...)`、`inject = ['slots']`。
- `main` 是 **keyed** 槽：`ctx.slots.register({name:'main', key:'team'}, Component)`；
  侧栏入口是 `sidebar.panellist` 的 list 槽 `{id:'team', order, label}`。**两处的 id/key 必须相同**，
  否则面板永远打不开，而且没有任何报错。
- **主题变量**：`Theme.listTokens` 只列了 14 个 alias，但实盘 UI 里在用的更多
  （`--dsw-alias-label-tertiary`、`--dsw-alias-link`、`--dsw-alias-state-business-primary`、
  `--dsw-alias-button-primary-hover`、`--dsw-alias-interactive-bg-hover`… 都能在
  `@deepseek-ai/dsh-client-ui-*` 的 bundle 里 grep 到）。**别把 provider 的清单当全集**，
  但也别凭空编 —— 去 shipped 的 client bundle 里搜一下最稳。
- 没有浏览器也能验一半：把 bundle 当经典脚本喂给假的 `window.__ModuleLoader__` + 假 `react`，
  断言 `definition.id`、`exports.inject`、以及 `apply()` 真的注册了两个槽。
  这能抓住"面板根本挂不上"，抓不住渲染问题。要真渲染就装 `jsdom` + 真 `react`（18.3.1，与 DSH 一致）
  把它当经典脚本加载、跑 effect、点按钮 —— 见本包的 `test/client-render.test.mjs`（可选，默认 skip）。
- **块注释里出现 `*/` 会提前结束注释，而 `node --check` 照样通过**。真实例子：注释里写
  `@deepseek-ai/*/lib/*.js`，那个 `*/` 把注释截断，剩下的半行恰好还能解析成合法语句 ——
  语法检查全绿，只有真执行 factory 才 `ReferenceError`。手写 bundle 尤其容易踩：
  **它唯一的"编译"就是真跑一遍**，所以要么避开 `*/`，要么就别省那一次加载测试。
- `sidebar.panellist` 的"没有 icon 字段"不等于"不用画图标"：**图标就是那个占位组件本身**，
  它会被渲染进侧栏按钮里，props 是 `{size, active}` —— 返回 `null` 就得到一个空按钮。
- `main` 的格子按 key **保留挂载**（切走再切回不会重新取数），所以面板要自己处理
  "回到前台刷新"（`visibilitychange → visible`）并在卸载时摘掉监听。

### 11.6 端到端测试别复用固定的 session id，也别只删一半

E2E 连着跑几轮、每轮都用同一个执行会话 id（`team-task-1`）并在中途
`rm -rf` 掉 `~/.dsh/sessions/<桶>/team-task-1`，会把一个**旧的头观察**留在缓存里。
之后任何按 id 解析语料的工具都会直接失败：

```
Error: session source headers conflict for session "team-task-1"
       (SESSION_QUERY_SOURCE_CONFLICT, 来自 @deepseek-ai/dsh-session-query)
```

判据在 `assertSessionHeadersCompatible`：同一逻辑会话的两份 header 只要
`createdAt` / `cwd` / `parentSession` / `isSeeded` / `delegationDepth` 有一项不一致就报冲突
（live 一份、persisted 一份）。清理办法是把那个 workspace 桶整个删掉：

```console
$ rm -rf ~/.dsh/sessions/--tmp-team-e2e-ws--
```

教训有两条：**测试用随机 session ID**（或在断言前清干净），以及排查这种错时先想
"是不是同一个 id 被创建过两次"。

---

## 12. 给浏览器半边配路由：`connection` 要 **inject**，不能 `get`

**这是最坑的一次，症状还特别误导人**：插件行挂上了、`team` 工具注册了、GUI 面板也渲染出来了，
只有面板的接口 **404**。

### 12.1 根因

`dsh-client-connection` 提供的 `connection` 服务**在最后一层 bundle 的 `apply()` 跑完之后**
才就绪，所以：

```js
const connection = ctx.get('connection')   // ✗ web profile 里也拿到 undefined
```

一次性读取读到的是"那一刻"的 store。DSH 自己的网关是这么拿的：

```js
// @deepseek-ai/dsh-api-gateway
ctx.inject(['connection'], (connectionCtx) => {
  connectionCtx.connection.rpc.intercept('/api', …)
})
ctx.inject(['connection', 'webServer'], (webCtx) => { … webCtx.connection.requestRejection(req) … })
```

**要点**：`inject` 用**回调形式**（`ctx.inject([...], cb)`）是"等它出现再干活"，
不会把整个 fiber 挂起 —— 所以它跟"别把可选服务写进 row 的 `inject` 声明"并不矛盾：
声明会 park 整个插件（headless 里连台账带工具全没），回调只是订阅。

### 12.2 路由 API 本身没错，鉴权是自带的

```js
connectionCtx.effect(() => connection.fetch.register({
  path: '/api/team/ledger', methods: ['GET','POST'], requestBody: 'buffered', fetch: handler,
}), 'team: ledger Fetch route')
```

`connection` 只挂**一条 `/api` 前缀路由**，先在它上面做 Host/Origin 围栏 + 浏览器鉴权
（`requestRejection` → 403/401），再把请求分发给注册进来的 exact Fetch 路由。
所以只要把路径注册在 `/api/…` 下面，鉴权就是**白拿的**。
（想再叠一层，可以在 handler 里自己调 `webCtx.connection.requestRejection(req)`。）

### 12.3 怎么在不动现有 harness 的前提下验证这条路

起一个**完全隔离**的 web 实例：临时 `DSH_HOME` + 另一个端口 + 用绝对路径挂 row
（不需要 pnpm、不需要动 profile）：

```console
$ DSH_HOME=/tmp/team-probe dsh --profile web --port 3099 --no-open
dsh web: http://127.0.0.1:3099/?token=0dE8cEEV…        # ← 这行就是换 cookie 用的 token
```

然后用那个 token 换 cookie，才能穿过后面的鉴权围栏做判断：

```console
$ curl -s -c /tmp/c.txt -o /dev/null "http://127.0.0.1:3099/?token=$TOKEN"   # 303
$ curl -s -b /tmp/c.txt -w '%{http_code}\n' http://127.0.0.1:3099/api/team/ledger   # 200 ✓
$ curl -s -b /tmp/c.txt -w '%{http_code}\n' http://127.0.0.1:3099/api/team/nope     # 404（对照）
$ curl -s -o /dev/null -w '%{http_code}\n'  http://127.0.0.1:3099/api/team/ledger   # 401（无 cookie）
```

**没有那个对照的 404，200 什么都证明不了**；而没有 cookie 的 401 才说明这条路由
不是个对全网开放的后门。

### 12.4 附带发现：桥插件也踩了同一个坑

`dsh-plugin-feishu-bot/lib/index.js` 里的 `mountSettingsApi` 用的是同一句
`ctx.get('connection')`，所以它的设置页路由大概也一直没挂上（只是没人注意到）。
同样的改法：把探测换成 `ctx.inject(['connection'], cb)`。

---

## 13. 和飞书桥对接：它转发过来的消息长什么样（三个都会让你聋掉）

这三条是**桥的源码 + 真实运行**核对出来的，任何一条搞错，"团队层收群消息"就是静默失效。

### 13.1 `source` 不是 `user`，是 `plugin: 'feishu-bot'`

```js
// dsh-plugin-feishu-bot/lib/bot.js:2493
agent.followup({
  id: newMessageId(), role: 'user',
  content: [{ type: 'text', text: prompt }],
  source: { kind: 'plugin', plugin: 'feishu-bot', form: 'relay' },   // ← 注意
})
```

所以"只认 `kind === 'user'`"的入站过滤器会**丢掉每一条群消息**。正确的判据是：
`kind === 'user'`（人在 DSH 里直接说的）**或** `kind === 'plugin' && plugin === 'feishu-bot'`；
其余一律不算（尤其是 `plugin: 'team'` —— 那是本插件自己的转发）。

### 13.2 @ 已经被剥掉了，所以不能靠文本判"有没有 @ 我"

桥在注入前做了 `stripMentions(...)`，落到会话里的文本**没有 @**。
而桥默认 `groupRequireMention: true`，**群消息只有在被 @ 时才转发** ——
也就是说：**"被桥转发过"本身就等价于"被 @ 了"**。
如果这里还用 `looksAddressed(text)` 判，设计文档里"被 @ 了不许被词表否决"那条规则
又会变回不可达（见 §11.3）。团队层的做法：seam 层给这类消息打 `addressed: true`。

另外 `/` 开头的行是桥自己的命令面（`/ws`、`/skill`、`/stop`…），`/skill` 的提示词也会
以同样形状进会话 —— 不排除掉就会凭空多出需求。

### 13.3 发言人**不在**消息里

桥只注入 `content: [{type:'text', text}]`：**没有 open_id、也没有姓名**。
后果很具体：群里发一句 `接受 task-1`，团队层无法知道是谁说的，
于是它**拒绝执行**（"认不出你是谁"）—— 这是对的默认（否则群里任何人都能替别人确认任务）。

两条出路：
- `feishu.senders`（`open_id → human:xxx`）：最准，但需要桥把发言人带过来，**目前带不了**；
- `feishu.chatActors`（`chat_id → human:xxx`）：把整个群当作一个人说话。
  只在一人群/单一操作者时成立，**是真的放宽**，所以是显式 opt-in。

（设计文档里"群消息剥离 @、无发言人名，P1 补发言人注入"—— 说的就是这条。）

### 13.4 顺带：`patchReload: live` 是真的会热挂载

profile 的 `dsh.profile.bundles` / `cordis.patch.yml` 改动**不需要重启**：

```console
# 把 - id: feishu-bot / disabled: true 去掉之后，约 1 分钟内：
$ tail -3 ~/.dsh/feishu-bot/plugin.log
… long connection established
… [ '[ws]', 'ws client ready' ]
… heartbeat {"state":"connected", …}
```

桥的子进程会被重新拉起并连上长连接。**但插件自己的 JS 不会重载**：
Cordis 只在行激活时 import 一次，而 `lib/index.js` 里那句带 mtime 的动态 import 只覆盖
`lib/team.js` —— 由它静态 import 下去的 `lib/feishu/*.js`、`lib/domain/*.js` 仍然是旧版本。
**改了深层文件就必须重启**（或者把同样的 mtime 技巧套到那一层）。

### 13.5 profile 的 `cordis.patch.yml` 必须是**数组**，注释不能顶掉内容

把文件里的 `[]` 换成纯注释，启动就直接失败：

```
Error: dsh: overlay /Users/…/cordis.patch.yml must be a top-level YAML array of loader patch entries
```

（改完立刻 `dsh --profile web --dump-config` 看一眼 exit code，比等重启时才发现好。）


---

## 14. 「服务比插件激活更晚就绪」——一天里踩了两次

同一个形状的 bug 出现了两次，症状都是**静默失效**（没有任何报错，功能就是不在）：

```js
const connection = ctx.get('connection')            // ✗ web profile 里也是 undefined
const registry = ctx.get('workspaceRegistry')       // ✗ 同样 undefined
```

原因：这两个服务都不是"随插件层一起就绪"的。

- `dsh-client-connection` 在**所有 bundle 层的 apply 跑完之后**才提供 `connection`；
- `workspaceRegistry` 的说明写得更直白：*"Startup waits for `sessionPersistence`, builds one
  canonical-cwd header index, and completes the one-time history bootstrap **before the service
  becomes active**"*。

而我们在最后一层 bundle 里，`apply()` 跑得很早 → 读到 undefined → 代码里那句
`if (!service) return` 把功能"安静地"关掉了。

**正确写法**（DSH 自己的 `dsh-api-gateway` 就是这么做的）：

```js
ctx.inject(['connection'], (connectionCtx) => {
  connectionCtx.connection.fetch.register({ … })
})
ctx.inject(['workspaceRegistry'], (registryCtx) => {
  registryCtx.workspaceRegistry.create(path, title)
})
```

`inject` 的**回调形式**是"等它出现再干活"，不会像 row 的 `inject` 声明那样把整个 fiber 挂起
（声明会让 headless profile 里连台账带工具全没）。在 headless 里这些服务**永远不会来**，
所以等的时候要带超时：`Promise.race([ready, timeout(2000)])`，否则一次 `await` 就把消息处理挂死。

**判别方法**：一个功能"该有却没有、日志里也没有错误"时，先怀疑它依赖的服务是不是**晚到**的，
然后 grep 一遍自己代码里的 `ctx.get(`。

### 14.1 顺带：会话要出现在客户端侧栏，需要三件事

侧栏是按**工作区**列会话的，而工作区的 `sessionIds` 按"会话 header 的 cwd == 工作区路径"过滤。
所以插件的会话默认是**三重不可见**：

1. 没有工作区认领那个目录 → `workspaceRegistry.create(path, title)`；
2. 会话日志还在内存缓冲里 → 持久化 header 是索引的来源，`sessions.flush(session)` 让它立刻成立；
3. 标题是 `feishu-oc_c91d…` → `sessionTitle.rename(session, '飞书 · ' + 群名)`。

`lib/workspace.js` 就是这三件事，而且每一件都是"失败只丢标签，不丢功能"。

---

## 15. 两个插件用同一套 session id = 一个插件悄悄继承了另一个的记忆

**症状**：机器人照常回答，工作区也建好了，但**那个工作区里一个会话都没有** —— 会话跑到另一个项目的工作区下面去了。

**根因**：`agents.resume({ resumeSessionId })` 对**任何**已存在的会话都成功，而会话的 cwd 是**建会话时定死的**。团队插件第一版的聊天会话 id 用的是
`feishu-<chat_id>` —— 和之前那个飞书桥插件**一模一样**。于是：

```
团队插件想开：feishu-oc_87a4…（cwd = ~/.dsh/team/workspace）
agents.resume 找到：桥当年用同一个 id 建过的会话（cwd = ~/Desktop/仓贷，188KB 历史）
→ 复用它 → 会话永远落在「仓贷」工作区下
```

日志里全是成功，回答也正常，只有"它在错误的项目里、带着别人的记忆"这一点没有任何提示。

**三条修法**（都值得抄）：

1. **id 要带自己的命名空间**：`team-feishu-<chat_id>`，别用别的插件已经在用的形状。
2. **resume 之后校验 cwd**：不一致就**别用**，换一个带世代后缀的新 id 重建，并且**把真实 id 回传给调用方**（调用方要把它记进自己的簿记）。
   比较路径要用 `realpath` —— macOS 上 `/tmp` 与 `/private/tmp` 是同一个地方，纯字符串比较会让守卫对每个临时工作区**每条消息都误触发**。
3. **已有记录要能迁移**：读到旧前缀的 session_id 就改写成新前缀（保留别的一切），否则老会话永远修不回来。

一句话：**会话 id 是跨插件的共享命名空间**，谁都可以 resume 谁，别指望隔离。

---

## 16. 飞书的 markdown：只有卡片会渲染，而且认的是子集（实测）

**症状**：机器人回答里满是 `**加粗**`、`` `code` ``、`> 引用`，用户看到的就是这些标点本身。
原因很简单：飞书的 **`text` 消息完全不渲染 markdown**，只有**交互卡片的 `markdown` 元素**会渲染 —— 而且只是子集。

### 16.1 拿真卡片一条条测出来的支持面

| 构造 | 飞书卡片 | 处理方式（`lib/feishu/richtext.js`） |
|---|---|---|
| `**加粗**` / `*斜体*` / `~~删除~~` / `[文字](url)` | ✅ 渲染（行首行中都行） | 原样透传 |
| ```` ```代码块``` ```` | ✅ 渲染，**带高亮和行号** | 原样透传，**围栏内绝不改写** |
| `` `行内代码` `` | ❌ **不支持** | **去掉反引号**（见 16.2） |
| `# 标题` | ❌ 不认 | 改写成 `**加粗**` |
| `> 引用` | ❌ 把 `>` 当字符 | 改写成 `▎引用` |
| `- 项` | ❌ 把 `-` 当字符 | 改写成 `• 项` |
| markdown 表格 | ❌ 完全不是表格 | 转成**原生 `table` 元素** |
| `---` | ❌ | 转成原生 `hr` 元素 |

### 16.2 反引号不只是"不渲染"，它会把**整行后面的强调**一起带崩

这是实测出来的、文档里没有的一条：

```
行内：`code` · **加粗** · *斜体* · ~~删除~~ · [链接](url)
      └─ 反引号原样显示，而且从它之后的 **加粗** *斜体* ~~删除~~ 全部变成字面星号
         （同一张卡里，另一行行首的 **…** 却渲染正常）
```

把反引号去掉之后，同一行立刻全部正常（同一张卡对照验证过）。
结论：**行内代码必须降级成普通文字**；留着一对反引号，代价是整行的格式。

### 16.3 怎么验（不需要写代码猜）

直接调 API 往自己的单聊发一张**诊断卡**，每行只放一个变量，截图即可定位：

```js
const card = { config: { wide_screen_mode: true }, header: {…}, elements: toElements(lines) }
await client.send(chatId, { msg_type: 'interactive', card })
```

"每行一个变量"是要点 —— 第一次那张卡把加粗/斜体/删除/行内码堆在同一行，
只能看出"这行坏了"，定位不到是哪一个构造；隔离之后一眼就看出是反引号。

---

## 17. 把"内管配置台"搬进插件面板：四条约定与两个坑

旧 hub 的控制台（Vue + 自研 HTTP 服务）没有随插件形态一起过来。它的**功能**被拆到了两处：
配置落在 `~/.dsh/team/config.json`（文件是逃生口），而"看得见、改得动、能自检"重新做进了
DSH GUI 的面板里（`lib/settings.js` + `lib/api.js` 的 `/api/team/config` + `lib/client.js` 的「配置」页）。

### 17.1 四条约定（都不是实现细节，是产品决定）

1. **保存前校验，拒绝就一个字节都不写**。问题以 `path + message` 返回，表单标在对应字段上。
   半写入的配置比写不进去危险得多 —— 下次启动时你不知道它是新的还是旧的。
2. **密钥只写不读**：`appSecret` 能设不能查，回显只有 `appSecretSet: true/false`。
   一个能显示密钥的控制台，就是一张迟早会被截图的密钥。留空 = 不修改（空框绝不抹掉已存的值）。
   顺带拦下"首尾有空白字符"——粘贴密钥最常见的事故，而它报错的位置离原因有三屏远。
3. **保存即生效**：`Object.assign(config, loadConfig(rowConfig))` 把文件重新读进运行中的配置对象；
   改了凭据/`mode` 还要**就地重建长连接**（响应里带 `restarted`）。
   控制台说"已保存"而实际要重启，是那种让人不再信任它的谎。
   唯一不动的，是设计本身要冻结的：进行中任务的**门禁快照**（改超时只影响新任务）。
4. **可审计**：每次保存写一行 `config-audit.jsonl`（谁、改了哪些键、备份路径），旧文件留 `.bak-<时间戳>`。
   "周二谁把 @ 要求关掉的"这个问题，否则只能靠手工 diff 备份来回答。

### 17.2 坑一：展示字段不是配置字段

`redact()` 要回答面板的问题（"密钥设了吗"），于是产出里多了一个 `appSecretSet`。
第一版把整个 redact 后的对象直接喂给校验器 → 每次加载都报一条
`feishu.appSecretSet: 未知配置项` 的**假问题**。

危害不在这一条，而在"校验列表永远不为空" —— 真的问题出现时，没人会去看那份清单。
**规则**：投影给校验器的对象，必须是"可写字段的子集"，展示用的标志位永远不进校验。

### 17.3 坑二：面板的形状 vs 文件的形状

面板把 `senders` / `chatActors` 当作 `members` 的同级（顶层），而**加载器是从 `feishu` 下面读它们**的。
合并时按面板形状写顶层 → 保存**报告成功、实际什么都没变**。

两个修法都做了：`mergePatch` 显式把它们映射进 `feishu`（并加测试钉住），
`loadConfig` 同时接受两种写法（手写的文件把 `senders` 放在顶层也很合理）。
**规则**：凡是"两处各自理解同一份数据"的地方，都要有一条测试断言"存进去的能被读出来"。

## 18. 多机器人：一等对象、一个 app 一个身份、会话属于「机器人 × 群」

这一段是把工作台的真实模型（机器人 / 成员 / 会话三张表）搬进插件时踩出来的，全部有测试或实测支撑。

### 18.1 一个飞书 app = 一条长连接 = 一个身份（绕不过去）

飞书侧没有"一个应用多个机器人身份"这回事。推论很硬：

- 两个机器人填同一个 `app_id` → 群里**同一张脸**（同名、同头像、同权限）。多机器人只体现在
  角色、会话、卡片头上，**在飞书里看不出来**；
- 要各有身份，就得**每个机器人一个飞书应用**，插件为每个应用各拨一条连接；
- 每个应用的密钥是独立的 → 配置需要 `feishu.apps: { "<appId>": { appSecret, botOpenId, name } }`，
  而 `resolveCredentials(config)` 必须能接受"这次拨哪个应用"的覆盖参数。
  **环境变量只描述默认应用**：一旦调用方明确指定了应用，就不能再看 env —— env 泄漏进第二个应用
  会静默用错误的身份连上去，比连不上更糟。

### 18.2 会话属于「机器人 × 群」，不属于群

`team-bot-<botId>-<chatId>`。同一机器人在两个群是两段上下文；同一个群里两个机器人也是两段。
`chats/` 记录的是**群自己**（名字、类型、最近跟谁说话），`bot-sessions/` 记录的是**这一对**
（DSH 会话 id、轮次、最后活动）—— 把会话 id 写进群记录，就是"一个机器人的会话被当成群的会话"，
这正是要修掉的那个混淆。

`bots: []` 保留为**单助手模式**的明确开关（旧行为与旧 session id 一起保留，安装不受影响）。

### 18.3 路由顺序里最容易写错的两位

`routeBots` 的顺序是 **点名 > 已绑定 > 角色优先级**。第一版把"已绑定"放在最前，
结果是：在一个已经绑定了需求机器人的群里 `@开发机器人` 永远叫不动开发机器人 ——
roster 里第二个机器人等于不存在。**明确指名必须压过一切黏性**。

配套的第二条：**发言策略只筛掉候选，不改变顺序**。`req`（`onIntent: false`）优先级高于
`dev`（`onIntent: true`）时，"只问最高优先级的候选者"会让**那个被配置成该答这种消息的机器人
永远答不上话**。正确做法是按顺序找**第一个愿意开口的**：`plan()` 遍历候选，谁愿意就是谁。

### 18.4 租约的真正用途：同一条群消息会在每条连接上各到一次

一个机器人一个应用之后，一个群里有 N 个应用就有 N 条长连接，**同一条群消息会被投递 N 次**。
进程内 `routeBots` 只选出一个机器人，所以进程内不会重复；**跨应用**才会。
`createReplyLease`（按群、内存、TTL 90s）就是"这句话只回一次"的依据：
第一个机器人拿下群，其他连接上的候选者看到租约就闭嘴（原因记进日志与群记录）。
回合失败且一句话都没说时**释放**租约，让下一个能答。

### 18.5 整数组写入必须归一化，否则运行态会写进配置文件

面板渲染的行来自 `roster.bots[]`，上面带着 `problems` / `sessions` / `appIdResolved` /
`feishu.connected`（运行时事实），而面板会把这一行**原样提交回来**。
第一版 `mergePatch` 直接落盘 → 配置文件里出现 `connected: true`、`sessions: [...]`，
下次加载就把运行态当成有人配过的配置读。

修法：`mergePatch` 对 `bots` / `members` 走 `normalizeBot` / `normalizeMember`，
只允许文档化字段落盘。**规则**：只要一个写路径的输入来自"给界面看的投影"，
就必须经过一次归一化，别指望界面只回传干净的字段。

### 18.6 校验器需要"这个安装事实"，否则会拒绝正确配置

`botProblems` 判断"这个机器人没有可用应用"要看**全局默认应用**；判断"应用没有密钥"
要看**哪些应用真的有密钥**。第一版没把这两样传进去：默认 roster 一启用就报
`bots[0].feishu.appId` 错误，配置台在完全健康的安装上显示一条红字。

两条规则：
1. `validatePatch(patch, context)` 显式接收 `defaultAppId` / `appsWithSecret` / `knownPresets`；
2. **同一次 patch 里新增的应用也算数**（否则"填密钥 + 启用该机器人的机器人"这一次保存会被
   误拒 —— 这正是面板最常走的那条路）。

同族的坑：`redact()` 给面板的 `feishu.apps` 是**只读数组**，**绝不能**再投影给校验器
（§17.2 的 `appSecretSet` 就是这个错误的第一次）。校验用文件里的原始 map，视图只给人看。

### 18.7 兼容旧形状：迁移不能静默丢人

`members` 从 `{域: [人]}` 变成一张表。规则：

- 两种形状都读，表和老映射合并成**并集**（旧映射迁到 `domains`），谁都不会因为"两处不一致"而消失；
- 第一次写表时，把文件里旧映射**先搬进 `domains`** 再占 `members` 这个键 ——
  否则那些人的角色域当场清零，而他们失去的是"确认自己需求"的资格；
- 老前端（旧标签页）回传的 map 形状仍然接受，但**路由到 `domains`**，绝不覆盖表。

### 18.8 一个小而致命的 JS 细节：`pick(...)` 跳过了空串

`pick(source.a, source.b, '')` 在**全都没值**时返回 `undefined`（因为 `''` 被当成"没值"跳过），
`String(undefined)` 就是字符串 `"undefined"` —— 于是成员行多出一个 `openId: "undefined"`，
看着像配置，实际会把 `feishu.senders` 污染成一条永远匹配不上的映射。
**规则**：用来兜底的空串写成 `?? ''`，不要让 `pick` 去承载"默认空值"。

### 18.9 被点名也要拿租约（否则一个提问会听到两次回答）

多应用之后最容易漏的一条：**同一条群消息在每条连接上各到一次**，而点名的那一次和
"另一条连接上的候选者"是两个不同的机器人（被点名的那个不在这个应用上，所以它压根不是
这条投递的候选）。只做"点名压过租约"而不"点名也拿下租约"，就会出现：
A 应用的投递里需求机器人回答了，B 应用的投递里开发机器人（onIntent 命中）也回答了一次 ——
群里对同一句话看到两条回答。

规则两条，缺一不可：
1. **明确指名压过已有租约**（否则一个群被某个机器人占住后，别的机器人就再也叫不动了）；
2. **回答本身仍然要拿下租约**（否则第二次投递不会被挡）。

另外，会话打不开或回合失败时都要**释放**租约 —— 一句话都没说出去却占着群，
表现就是"机器人突然不理人 90 秒"。

### 18.10 「存进去读不出来」的第二次现场：`senders` 的两份拷贝

`senders` / `chatActors` 的加载顺序是 `feishu.senders` 先、顶层 `senders` 后（`objectOf` 逐个
`Object.assign`，后面的覆盖前面的），而面板把补丁写在 `feishu` 下面 —— 于是**文件里那份陈旧的顶层
拷贝会盖掉刚保存的值**：保存报告成功，实际什么都没变。（和 §17.3 是同一类错误，只是换了个字段。）

修法：`mergePatch` 把两份**迁成一份**（写 `feishu.*`，删掉顶层那份）。判定标准很简单：
**同一个值只有一个家**，凡是"loader 读两处"的地方，写路径都必须把它收敛到 loader 优先读的那一处。

这个坑是被 `test/example-config.test.mjs` 逼出来的：那个测试拿**样例配置**去跑真正的
`validatePatch`，于是样例里每一个"文档教了但校验器不认"的键都会当场失败 ——
样例配置是给人抄的，抄出来不能存，就是在批量生产错误配置。

### 18.11 「角色 → preset」那张表是机器人之前的遗留（删掉它，而不是留着）

第一版沿用了 hub 的形状：`sessions.presets = { req: ..., dev: ..., qa: ... }`，面板给每个角色
一个输入框。机器人成为一等对象之后，这张表就变成了**第二个真相**：

- 机器人自己的 `agentPreset` 优先，所以只要名册里写了，角色表那一格**不生效**；
- 会话是按需创建的（`run_task` 派给 `bot:<id>` → 用那个机器人的 preset / model / role，
  见 `tools.js` `sessionSpecFor`），所以"预先按角色声明 preset"这件事本身就没有对象了；
- 而它**仍然可能生效**（名册里没有这个角色时），所以它既不是死的、也不是活的 ——
  这种"填了有时有用、有时没用"的字段，是配置页里最费解的东西。

处理方式：真值由 host 算（`bots.js` `sessionRoleView`：每个角色的 preset 来自谁、来源是哪一档），
面板**只读显示**；可写的旋钮只剩机器人自己的 `agentPreset`（机器人页）和全局兜底 `sessions.preset`。

**写路径上还有一颗雷**：输入框一旦不渲染，`valueOf` 读回来就是空串，而保存路径里
"空串 → null"是标准写法 —— 于是"删掉输入框"会变成"每次保存都把文件里手写的角色映射抹成 null"。
所以保存路径不是"不渲染"，而是**完全不提这个键**（`nextPresets` / `nextSessions.presets` 一个都不出现），
并用 `client-half.test.mjs` 里的源码断言钉住：
`assert.equal(/sessions\.presets\./.test(code), false)`。

**规则**：删一个表单字段时，要同时删掉它在**提交路径**上的痕迹；否则"少了一个输入框"会静默变成"多了一次擦除"。

### 18.12 把字段搬到它真正属于的对象上（应用 → 机器人）

第一版把 `feishu.appId / appSecret / botOpenId / chatIds` 放在「配置」页当全局配置。机器人成为
一等对象之后这是错的：**一个应用 = 一条长连接 = 一个身份**，所以应用是**机器人的属性** ——
两台机器人各要一张脸，就得各有一个应用、各有各的密钥。「配置」页那一组字段因此成了
"写在一处、生效在另一处"的配置，而且机器人页**根本没有地方填密钥**（能填 appId，却填不了
它的密钥，等于绑不上）。

搬动分三步，少一步都会出问题：

1. **编辑权搬走**：机器人页的「编辑」里加 `app id` / 应用密钥 / 机器人 `open_id` / 所在群；
   配置页那一组换成一行**只读现状**（"默认应用 cli_…（密钥已设置）；没有其它应用。"），
   并写明"在机器人页改" —— 让人知道东西去哪了，而不是以为功能没了。
2. **提交路径搬走**：配置页的提交代码里那几段**必须删掉**。输入框不在了，`text('feishu.appId')`
   返回空串，而旧代码会把它当成"用户清空了它" → 一次保存把 app id 和密钥一起抹掉。
   （§18.11 是同一个坑的反面：那次是"没了输入框 → 提交 null 抹掉映射"。）
3. **一个值一个家**：机器人用的是默认应用就写 `feishu.appSecret`，是它自己的应用就写
   `feishu.apps.<appId>.appSecret`；两个框都留空 → **patch 里根本不出现这两个键**。
   密钥是密码框、永远从空开始、只允许从**草稿**读（`client-half.test.mjs` 用一条
   `x.appSecret` 的读取白名单把它钉住：除了 `fields.appSecret` 不许有第二个来源）。

顺带清掉一个同族的谎：**`feishu.chatIds` 从来没有任何代码读它**（loader 读进来，然后没人用），
文件里写着"只处理这些群"而插件处理所有群。处理方式不是"留着但标注废弃"，而是**明确拒绝**：
校验器对这个键返回错误，并指出替代品（`bots[].feishu.chats`，由路由器真正执行）。
**能被接受却被忽略的键，比被拒绝的键危险得多** —— 前者会教会使用者一条系统并不存在的规则。

实测（隔离 web 实例 + 真 HTTP）：一次 POST 同时带 `bots` 与 `feishu`（默认应用的密钥 + 这个机器人
自己应用的密钥）→ `applied: ["bots","feishu"]`，两台机器人各自解析到自己的应用，两个应用各自报告
密钥已设与不同指纹；落盘后两个密钥各就各位、无运行态字段泄漏；指名一个没配密钥的应用 →
`invalid_config` + `bots[1].feishu.appId`，文件一个字节没变。

### 18.13 不要造"默认应用"这个概念（采纳，而不是继承）

把应用搬到机器人身上之后，最容易留下的一条尾巴是**"默认应用"**：安装级 `feishu.appId` 还在，
机器人没写应用时"就继承它"。听起来无害，实际会造出三个问题：

1. **界面上没法如实显示**：编辑器只能给一个空输入框 + 一行占位文字"空 = 默认应用 cli_…"，
   于是操作者看到的是"我用的那个 id 被当成一个全局默认值"，而不是"这台机器人用这个应用"；
2. **"这台机器人用哪个应用"不再是机器人的属性** —— 它成了一个安装级事实的投影，任何按机器人
   展示、比较、告警的地方都得先做一次解析；
3. 于是"两台机器人共用一张脸"这种判断，只能写成"两边的字段**都为空**吗"—— 加了显式 appId
   之后这个判断立刻失效（实测：`botProblems` 的共用应用告警直接不响了）。

处理方式是**在加载时采纳**（`lib/config.js` `ownApps`）：`feishu.appId` 被写进每一台还没有
自己应用的机器人，之后每一台都自己回答这个问题。运行时行为一个字都不变（还是拨那个应用），
但面板显示与提交的都是"这一台自己的应用"，共用判断也变成比较**实际解析出来的应用**。

**一个凭据一个家**（延续 §18.10）：面板把密钥写到 `feishu.apps.<appId>.appSecret`，不再有
"是不是默认应用"的分支；安装级 `feishu.appSecret` 继续**读得到**（应用条目没密钥时兜底，
所以现有安装不会因为这次改动掉线），而一旦应用条目里真的有值了，同一次保存就把老键
**迁走** —— 但**只在值确实存在时**才删：应用条目还没有密钥就把兜底删掉，等于当场把应用弄下线。

实测（隔离实例 + 真 HTTP，配置完全照现有安装的形态：只有安装级 appId/appSecret、没有 bots）：
`GET` 回来六台机器人**每台都带着自己的 `feishu.appId`**，整份响应里没有"默认应用"四个字；
用面板编辑器会发的那份 patch 保存 → `applied: ["bots","feishu"]`，密钥落到应用条目、
`feishu.appSecret` 从文件里迁走，`bots[0].feishu.appId` 落盘成显式值。

---

## 19. `ctx` 是带守卫的代理：**不要往它身上写属性**（2026-09-12 线上事故）

一条测试接缝差点让整个插件在真实宿主里起不来。写错的那一行就是：

```js
if (ctx !== null && typeof ctx === 'object') ctx.teamFeishu = feishu   // ✗ 真 ctx 会抛
```

真宿主里的报错是 `cannot set property "teamFeishu" without provide`，来自 `@deepseek-ai/cordis`
的 ctx 代理 `set` 陷阱（`lib/index.js` 的 `ReflectService.handler.set`）。源码里的判据值得逐字记住：

```js
set: (target, prop, value, ctx) => {
  if (isSpecialProperty(prop)) return Reflect.set(target, prop, value, ctx)   // symbol / then / prototype / 数字串 / 下划线开头
  const error = new Error(`cannot set property "${prop}" without provide`)
  const def = target.reflect.props[prop]
  if (!def) {
    if (!ctx.fiber.runtime) return Reflect.set(target, prop, value, ctx)      // ← 只有"没在跑的 fiber"才放行
    throw enhanceError(error)
  }
  …
}
```

三个要点，每一个都让这个坑更难自己发现：

1. **只有 `provide` 过的名字（或 accessor）能赋值**。想挂一个自己的东西，用 `ctx.provide()`/服务，
   或者干脆放**模块作用域**（本插件的 `api`/`configApi`/`logsApi`/`feishuSeam` 就是后者）。
2. **抛不抛取决于 `ctx.fiber.runtime`**：`new Context()` 这种裸上下文的 runtime 为空，赋值会
   **静默成功** —— 于是"我本地试了一下没事"完全不能作数。走 `ctx.plugin(plugin, config)`
   才是与 loader 同一条路径。
3. **测试替身会让它永远绿**。用例里的假 ctx 是普通对象，`ctx.xxx = …` 当然收下。
   这类错误的形状因此是：**测试全绿，宿主里整个插件不激活**。

后果为什么特别难查：本插件的入口是 boot-safe 的（§2），激活失败只写日志、不抛，所以宿主活着、
面板（浏览器半边是静态脚本）也照常渲染，只是**一个接口都不在** —— 使用者看到的是
"读取失败：HTTP 404 的响应不是 JSON"，像路由写错了，而真相在 `~/.dsh/team/load-report.txt` 里。

**两条防御，都已经落地：**

- `test/activation.test.mjs` 用**真 Cordis 上下文**（`ctx.plugin()`）把发布的那一行挂一遍：
  断言 entry 不抛、工具注册、四条路由挂上、台账路由真的回 JSON；另一条用例把"一激活就写 ctx
  未声明属性"的坏实现放进临时目录，验证这一行没把宿主带下去、且自述路由说出了原因。
- 入口自己挂 `GET /api/team/boot`（`lib/index.js` 的 `bootRoute()`）：**它不依赖实现是否活着**，
  失败时返回 `{ok:false, phase, message, hint}`（只吐首行，堆栈留在磁盘上）。
  面板在台账路由 404 时会探它，把真话直接写在页面上 —— 这正是当年缺的那一环。

**判别方法**：功能"该有却没有、日志里也没有错误"，且面板接口全 404 时，先看
`load-report.txt`；写代码时记住 `ctx` 不是可以随便挂东西的对象。

---

## 20. 多应用的两个坑：身份继承，与"谁被点名"（2026-09-12 线上）

用户加第二个应用（`cli_aa157481…`，机器人"个人网银前端"）拉进群，**@ 它没有任何反应**，
台账里也没有它的会话。日志里的那一行就是全部线索：

```
拨号：{"appId":"cli_aa91…"} apps=2 (cli_aa91… → req; cli_aa15… → dev)
长连接就绪：{"online":2,"apps":[
  {"appId":"cli_aa91…","botOpenId":"ou_847e6…"},      ← 第一个应用的机器人
  {"appId":"cli_aa15…","botOpenId":"ou_847e6…"}]}    ← 也是它！两张脸一个身份
```

拿两个应用的凭据各问一次 `/open-apis/bot/v3/info`，真相立刻出来：

| 应用 | 真实 bot open_id |
|---|---|
| `cli_aa910fe2…` | `ou_847e6c1667692e892cd81eb4eb2992e4` |
| `cli_aa157481…` | `ou_bfc12499defc8102b9877ac2a0968d7e` |

### 20.1 坑一：安装级的 `feishu.botOpenId` 被所有应用继承

`startConnection` 里原本是：

```js
const configuredBotId = app?.botOpenId !== '' ? app.botOpenId : config?.feishu?.botOpenId   // ✗ 谁都继承
```

安装级那个值说的只是**默认应用**。别的应用继承它 → "这条消息 @ 了我吗"永远按错的 open_id 算：
被 @ 的那台不开口，没被 @ 的那台倒以为自己被点名。这是"默认应用"这个概念的**第三次**露头
（前两次是 `appId` / `appSecret`，见 §18.13）—— 凡是安装级的身份字段，都要问一句"它属于谁"。

修法：`configuredBotOpenId(app, config)` —— 自己的值优先；**只有默认应用**（或没有 descriptor 的单应用形态）
才用安装级的值；其余一律返回空串，让连接去问 `/open-apis/bot/v3/info`（用它自己的凭据）。

### 20.2 坑二：一个群里两台机器人时，"事件从哪个应用来"是竞态

同一个群消息在**两条连接上各到一次**，去重只放先到的那条过去。而 `routeBots` 之前先按
"事件来自哪个应用"过滤候选 —— 于是 @ 了 B、A 的连接先到，候选里根本没有 B，**没人回答**，
而且时灵时不灵（这就是用户看到的"偶尔不理我"）。

修法：把"@ 到了谁"当成事实，而不是靠猜。

- `normalizeMessage` 带上 `mentionedOpenIds`（`mentions[].id.open_id`，按 open_id 不按名字）；
- `team.js` 的 `mentionedAppsOf` 用**每个应用自己的 botOpenId** 把名单翻成应用清单
  （遍历 `appDescriptors(config)` 而不是 `state.clients` —— 后者在 `mode: 'off'` / 还没拨号时是空的，
  用它会让这条判断在最开始那几条消息上静默失效）；
- `routeBots` 不再排除"被点名的那个应用"的机器人，并把它排在候选第一位；
- `responder.addressedTo` 认这份清单（**不靠正文里有没有它的名字**：机器人可以在飞书里叫 A、
  在名册里叫 B），于是 `requireMention: true` 的群里被点名就会开口。

**顺带钉住的边界**：正文里出现另一台机器人的名字（没有结构化 mention）**不算**证据 ——
那种"机器人自己猜你叫的是它"和"机器人打断人"没法区分。这一条有专门的用例。

### 20.3 还有一处稳定性：群的应用身份

群记录的 `app_id` 原来写的是"这条消息从哪条连接来的"，于是这个群的播报身份会随消息
一会儿这张脸、一会儿那张脸。现在记 `app_ids`（这个群见过哪些应用），`app_id` 优先取
**主机器人的应用**（前提是它确实来过这个群），拿不准才用收到这条连接的那个。
回答不受影响：回答一直用**回答者自己**的应用（`clientFor(bot)`）。

---

## 21. 会话属于「机器人 × 群」，不是属于群（2026-09-12 用户要求）

用户的原话：**"同一个群里有多个机器人，每个机器人都是单独的会话，不是一个群共用一个会话。"**

键一直是 `robot × chat`（`team-bot-<机器人>-<群>`），但有两处让这句话在**界面上**不成立：

1. **继承单助手时代的会话**。名册出现之前，一个群的助手说的是 `team-feishu-<群>`；
   为了让"这个群聊过什么"不丢，第一个服务这个群的机器人会**接着那条会话说**。
   出发点没错，画面却正是用户反对的那一个：会话 id 还是群的名字，看起来这个群只有一条会话。
   → 拿掉继承，一律 `team-bot-<机器人>-<群>`；历史记录由 `migrateLegacySessions()`
   一次性改名（记 `migrated_from`，日志里写一行，旧会话文件留在 `~/.dsh/sessions` 不动）。
   **代价说清楚**：换 id 就是换了 DSH 会话，旧会话的历史不会被带过来。

2. **登记时机**。原来要等这台机器人**第一次回答**才建会话记录。于是"群里两台机器人、
   会话页只有一台" —— 和"共用一个会话"一样容易被误读。
   → 只要有**证据**说明它在群里（它的应用收到过消息，或消息 @ 到了它的应用），就把记录建出来，
   标成"还没在这个群说过话"；真正能跑的 DSH 会话仍然在第一次回答时才打开。

`seen`（消息数）仍然只记在**主机器人**名下：每台都记一遍会让 N 台机器人的数字永远一样，
"这个群归谁记"就没有意义了。

**一般的教训**：用户说"这两件事应该分开"时，先去看**界面上能不能看出来是分开的** ——
数据模型对、id 对、测试全绿，但面板上显示的是另一回事，那在用户那里就等于没做。
