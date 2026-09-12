/*
 * 团队台账：dsh-plugin-team 的浏览器半边（DSH GUI 里的一个中心面板 + 一个侧栏入口）。
 *
 * 手写 bundle，没有构建步骤。DSH 自己的 client 包是 tsdown 按同一套包装产出的，
 * 那个 preset 就是三个字符串（照 dsh-plugin-feishu-bot/lib/client.js 的写法）：
 *
 *   banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`
 *   intro:  'var module = { exports: {} }; var exports = module.exports;'
 *   footer: 'return module.exports; } });'
 *
 * loader 只校验 `id` 与 `factory`。官方 cookbook 里写明：仓库之外的包
 * “必须自己产出同样的格式”，本文件做的就是这件事。几个容易写错的地方：
 *
 *   - 它是以【经典脚本】被加载的：不能有顶层 import / export。
 *   - `id` 必须是【包名】；loader 会把 `<id>/client` 别名到它上面。
 *   - React 从 `require` 来（平台模块表注入），不打包、不 import。
 *   - `module.exports` 原样返回：不要设 `__esModule`，除非同时给出 `default`，
 *     否则 loader 会解包成 undefined。
 *
 * 它怎么跟自己的 host 半边说话。这里【没有】`host.call`——那是动态 Cordis
 * runner 的 builtin。已发布的浏览器半边只通过 `connection` 服务上的一条精确
 * Fetch 路由回家，而这条路由同时也带来了 GUI 自己的浏览器 cookie 鉴权。
 * 路由由 `lib/api.js` 实现、`lib/index.js` 挂载；本文件只认这一个地址。
 *
 * 两个槽的确切契约（对着 DSH 源码核过，不是猜的）：
 *
 *   - `sidebar.panellist`（package `dsh-client-ui-sidebar`，list / scope root）
 *     注册项是**可序列化的元数据** `{ id, order, label }`，没有 icon 字段；
 *     侧栏用它自己的按钮，标题取 `resolveSlotLabel(label) ?? id`，并让这个 id
 *     去派发 `main` 的同名 key。占位组件本身被渲染进那个按钮的
 *     `<span class="panelGlyph" aria-hidden="true">`，以 `{ size, active }`
 *     为 props（见 `SidebarPanelIconOwnerProps`）——所以**图标就是这个组件**，
 *     这里画一个 currentColor 的 SVG，颜色跟着主题走。
 *
 *   - `main`（package `dsh-client-ui-layout`，keyed / scope root）
 *     渲染点是 `renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })`
 *     ——owner props 是【空的】，只有标准槽 props（若干 hook）。所以面板组件
 *     一律不读 props，自己用 useState/useEffect + fetch 取数。
 *     侧栏入口 id 与 main 的 key 必须都是 `team`。
 *
 * 关于 actor。host 会拒绝任何没有 actor 的写操作，理由是“这个界面以浏览器
 * 身份登录，不代表某个人”。所以面板上必须有一个 actor 输入框：默认取名册里
 * 的第一个人（其次成员域里的第一个 principal），都没有才用
 * `config.defaultOwner`，用户可改。
 *
 * 关于拒绝。状态机的 `ok:false` 是设计里最重要的一条信息：`message` 原样
 * 展示，`pending`（还差谁确认）单独一块展示，绝不吞掉、绝不改写成“操作失败”。
 *
 * 纯 JavaScript：没有 JSX、没有 TypeScript。`React.createElement` 就是全部
 * 词汇；样式只用主题的 CSS 变量，明暗主题都不会写死颜色。
 */

/** host 半边 `lib/api.js` 提供的路由（POST 的 action 名与 `team` 工具同一套）。 */
const LEDGER_URL = '/api/team/ledger'

/**
 * host 半边新增的配置路由：GET 读 config + problems + diagnostics + editable，
 * POST `{ patch, actor }` 改配置（actor 必填，缺了 host 会拒绝）。
 * 这是本文件认识的第二个、也是最后一个地址。
 */
const CONFIG_URL = '/api/team/config'

/**
 * 配置页要渲染的固定清单。
 *
 * `editable` 只回答“这一项能不能改”，不回答“界面上有没有这一项”：缺的成员域
 * 也要显示（否则用户看不出它是空的），所以清单在客户端写死，渲染前再逐项问
 * `editable`——不在清单里的键一个输入框都不给。
 */
const MEMBER_DOMAINS = ['pm', 'requirement', 'development', 'testing', 'ops', 'security']
const GATE_NAMES = ['confirm_split', 'accept', 'start', 'acceptance']
const GATE_TITLE = {
  confirm_split: 'confirm_split（拆解确认）',
  accept: 'accept（接受）',
  start: 'start（开始）',
  acceptance: 'acceptance（验收）',
}
const ON_TIMEOUT_OPTIONS = ['remind_then_escalate', 'auto_release', 'escalate_to_owner', 'notify_submitter']
/*
 * SESSION_ROLES / SESSION_ROLE_TITLE 曾经用来渲染「角色 → preset」那七个输入框。
 * 那个表单被删掉了（preset 属于机器人，见 renderSessionRoles），常量一并删除：
 * 留着一个没人用的角色表，下一个人会以为它还在生效。
 */
/* 机器人角色：取值与标题都要和 host 的 lib/bots.js（BOT_ROLES / ROLE_LABELS）一致。 */
const BOT_ROLE_VALUES = ['req', 'dev', 'qa', 'coord', 'lib', 'ops', 'custom']
const BOT_ROLE_TITLE = {
  req: 'req（需求）', dev: 'dev（开发）', qa: 'qa（测试）', coord: 'coord（调度）',
  lib: 'lib（资料）', ops: 'ops（运维）', custom: 'custom（专项）',
}
const FEISHU_MODES = ['own', 'off']
const FEISHU_MODE_TITLE = { own: 'own（自己接飞书）', off: 'off（不接飞书）' }

/** 两张键值表在“脏字段”表里用的键：它们不是单个输入框，而是整张表。 */
const KV_SENDERS = '__senders'
const KV_CHAT_ACTORS = '__chatActors'

/** GET 的等待上限：挂住的后端不应该让面板永远停在“读取中…”。 */
const GET_TIMEOUT_MS = 20000

/**
 * 面板只驱动这 4 个动作（`available` 里出现哪个就渲染哪个按钮），
 * 外加每个任务常驻的「执行一轮」。其余动作（create_requirement /
 * propose_tasks / assign_task / block / …）留给 `team` 工具，面板只把
 * “状态机还允许什么”如实列出来，不假装自己能做。
 */
const ACTION_LABEL = {
  accept: '接受（门禁 1）',
  start: '确认开始（门禁 2）',
  submit: '提交验收',
  verify: '验收通过',
}
const ACTION_CALL = {
  accept: 'accept_task',
  start: 'start_task',
  submit: 'submit_task',
  verify: 'verify_task',
}
const ACTION_ORDER = ['accept', 'start', 'submit', 'verify']

/** 状态 → 语气（决定标签用哪个主题色），以及给中文读者的一句注解。 */
const STATE_TONE = {
  draft: 'mute', confirmed: 'info', dispatched: 'info', changed: 'warn',
  done: 'ok', archived: 'ok', blocked: 'err', suspended: 'warn', dropped: 'err',
  proposed: 'mute', assigned: 'info', accepted: 'info', in_progress: 'info',
  ci_running: 'info', in_review: 'info',
}
const STATE_LABEL = {
  draft: '草稿', confirmed: '已确认', dispatched: '已派发', changed: '已变更',
  done: '已完成', archived: '已归档', blocked: '阻塞', suspended: '挂起', dropped: '已放弃',
  proposed: '待确认拆解', assigned: '待接受', accepted: '已接受待开始',
  in_progress: '进行中', ci_running: 'CI 中', in_review: '待验收',
}
const GATE_LABEL = { accept: '接受', start: '开始', acceptance: '验收' }

const CSS = [
  /*
   * 根元素是 flex 列容器（.centerCol 是 display:flex; flex-direction:column;
   * overflow:hidden）里的一个 flex item，所以用 `flex:1 1 auto; min-height:0`
   * 让它自己内部滚动；`height:100%` 只是对非 flex 父容器的兜底。
   */
  '.teamled { display: flex; flex-direction: column; gap: 14px; box-sizing: border-box; flex: 1 1 auto; min-height: 0; height: 100%; overflow: auto; padding: 18px 20px 44px; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-primary); }',
  '.teamled-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }',
  '.teamled-h1 { font-size: 15px; font-weight: 600; }',
  '.teamled-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary); }',
  '.teamled-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
  '.teamled-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }',
  '.teamled-input { flex: 1 1 220px; min-width: 200px; max-width: 340px; box-sizing: border-box; padding: 6px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; font-family: inherit; }',
  '.teamled-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
  '.teamled-btn { padding: 6px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-size: 12px; font-family: inherit; cursor: pointer; }',
  '.teamled-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); border-color: var(--dsw-alias-border-l2); }',
  '.teamled-btn:disabled { opacity: 0.5; cursor: default; }',
  '.teamled-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground); font-weight: 600; }',
  '.teamled-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); border-color: var(--dsw-alias-button-primary-hover); }',
  '.teamled-btn-run { padding: 7px 14px; font-size: 13px; }',
  '.teamled-chip { padding: 3px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 11px; }',
  '.teamled-tag { padding: 2px 7px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; }',
  '.teamled-tag-ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }',
  '.teamled-tag-warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }',
  '.teamled-tag-err { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }',
  '.teamled-tag-info { color: var(--dsw-alias-state-business-primary); border-color: var(--dsw-alias-state-business-primary); }',
  '.teamled-cols { display: flex; align-items: flex-start; gap: 14px; flex-wrap: wrap; }',
  '.teamled-col { display: flex; flex-direction: column; gap: 10px; flex: 1 1 380px; min-width: 300px; }',
  '.teamled-colhead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }',
  '.teamled-coltitle { font-size: 13px; font-weight: 600; }',
  '.teamled-note { font-size: 11px; color: var(--dsw-alias-label-tertiary); }',
  '.teamled-card { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }',
  '.teamled-card-focus { border-color: var(--dsw-alias-brand-primary); }',
  '.teamled-cardhead { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }',
  '.teamled-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); }',
  '.teamled-reqhead { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; width: 100%; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }',
  '.teamled-title { font-weight: 600; }',
  '.teamled-gates { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
  '.teamled-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); word-break: break-word; }',
  '.teamled-lease { font-size: 11px; color: var(--dsw-alias-label-secondary); }',
  '.teamled-blocked { font-size: 12px; color: var(--dsw-alias-state-error-primary); }',
  '.teamled-pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary); }',
  '.teamled-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin-top: 2px; }',
  '.teamled-panel { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }',
  '.teamled-panel-ok { border-color: var(--dsw-alias-state-success-primary); }',
  '.teamled-panel-err { border-color: var(--dsw-alias-state-error-primary); }',
  '.teamled-panel-warn { border-color: var(--dsw-alias-state-warn-primary); }',
  '.teamled-panel-title { font-size: 12px; font-weight: 600; }',
  '.teamled-msg { font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }',
  '.teamled-msg-ok { color: var(--dsw-alias-state-success-primary); }',
  '.teamled-msg-err { color: var(--dsw-alias-state-error-primary); }',
  '.teamled-msg-warn { color: var(--dsw-alias-state-warn-primary); }',
  '.teamled-pending { font-size: 12px; color: var(--dsw-alias-state-warn-primary); }',
  '.teamled-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary); }',
  '.teamled-report { max-height: 240px; overflow: auto; margin: 0; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word; }',
  '.teamled-decided { display: flex; flex-direction: column; gap: 3px; }',
  '.teamled-decided-item { font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-word; }',
  '.teamled-ok { color: var(--dsw-alias-state-success-primary); }',
  '.teamled-err { color: var(--dsw-alias-state-error-primary); }',
  '.teamled-warn { color: var(--dsw-alias-state-warn-primary); }',
  '.teamled-info { color: var(--dsw-alias-label-secondary); }',
  '.teamled-mute { color: var(--dsw-alias-label-tertiary); }',
  '.teamled-linkish { padding: 0 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-link); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; cursor: pointer; }',
  '.teamled-linkish:hover { border-color: var(--dsw-alias-border-l2); }',

  /* 页签栏：台账 / 配置。当前页用品牌色实心，切页只改 state，不动 URL、不刷新。 */
  '.teamcfg-textarea { min-height: 62px; resize: vertical; font-family: inherit; }',
  '.teamled-tabs { display: flex; align-items: flex-end; gap: 6px; border-bottom: 1px solid var(--dsw-alias-border-l1); }',
  '.teamled-tab { padding: 7px 16px; border: 1px solid var(--dsw-alias-border-l1); border-bottom: none; border-radius: 9px 9px 0 0; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 13px; font-family: inherit; cursor: pointer; }',
  '.teamled-tab:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }',
  '.teamled-tab-active, .teamled-tab-active:hover { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground); font-weight: 600; }',

  /* 配置页：自检块 / 表单 / 保存条。表单元素全部跟随主题变量。 */
  '.teamcfg { display: flex; flex-direction: column; gap: 14px; }',
  '.teamcfg-spacer { flex: 1 1 auto; }',
  '.teamcfg-sec { display: flex; flex-direction: column; gap: 9px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }',
  '.teamcfg-sectitle { font-size: 13px; font-weight: 600; }',
  '.teamcfg-field { display: grid; grid-template-columns: minmax(150px, 210px) minmax(0, 1fr); gap: 4px 10px; align-items: center; }',
  '.teamcfg-label { font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-word; }',
  '.teamcfg-control { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }',
  '.teamcfg-input { flex: 1 1 220px; min-width: 160px; box-sizing: border-box; padding: 6px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; font-family: inherit; }',
  '.teamcfg-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
  '.teamcfg-num { flex: 0 0 auto; width: 140px; box-sizing: border-box; padding: 6px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; font-family: inherit; }',
  '.teamcfg-num:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
  '.teamcfg-select { flex: 0 0 auto; max-width: 100%; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12px; font-family: inherit; }',
  '.teamcfg-check { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary); }',
  '.teamcfg-hint { grid-column: 2; font-size: 11px; color: var(--dsw-alias-label-tertiary); word-break: break-word; }',
  '.teamcfg-kvlist { display: flex; flex-direction: column; gap: 7px; min-width: 0; }',
  '.teamcfg-kvrow { display: grid; grid-template-columns: minmax(110px, 1fr) minmax(110px, 1fr) auto; gap: 7px; align-items: center; }',
  '.teamcfg-kvrow .teamcfg-input { min-width: 0; flex: 1 1 auto; }',
  '.teamcfg-diag { display: flex; flex-direction: column; gap: 5px; }',
  '.teamcfg-diagrow { display: flex; align-items: flex-start; gap: 7px; font-size: 12px; line-height: 1.6; }',
  '.teamcfg-diagmark { flex: 0 0 auto; }',
  '.teamcfg-diag-ok { color: var(--dsw-alias-state-success-primary); }',
  '.teamcfg-diag-bad { color: var(--dsw-alias-state-error-primary); }',
  '.teamcfg-diagsub { margin-left: 22px; font-size: 11px; color: var(--dsw-alias-label-tertiary); word-break: break-word; }',
  '.teamcfg-problem { font-size: 12px; line-height: 1.6; color: var(--dsw-alias-state-error-primary); word-break: break-word; }',
  '.teamcfg-problem-path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }',
  '.teamcfg-json { box-sizing: border-box; width: 100%; min-height: 132px; resize: vertical; padding: 7px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5; }',
  '.teamcfg-json:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
  '.teamcfg-json:disabled { opacity: 0.65; }',

  /* 名册页（机器人 / 成员 / 会话）：看为主，改配置仍然回「配置」页。 */
  '.teamroster { display: flex; flex-direction: column; gap: 14px; }',
  '.teamroster-wrap { overflow-x: auto; }',
  '.teamroster-table { width: 100%; border-collapse: collapse; font-size: 12px; }',
  '.teamroster-th { padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-tertiary); font-size: 11px; font-weight: 600; text-align: left; white-space: nowrap; }',
  '.teamroster-td { padding: 7px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: top; word-break: break-word; }',
  '.teamroster-td-mute { color: var(--dsw-alias-label-tertiary); }',
  '.teamroster-probs { display: flex; flex-direction: column; gap: 3px; }',
  '.teamroster-prob-err { font-size: 11px; color: var(--dsw-alias-state-error-primary); word-break: break-word; }',
  '.teamroster-prob-warn { font-size: 11px; color: var(--dsw-alias-state-warn-primary); word-break: break-word; }',
  '.teamroster-group { display: flex; flex-direction: column; gap: 8px; }',
  '.teamroster-sess { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }',
  '.teamroster-sesshead { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }',
  '.teamroster-openid { flex: 0 0 auto; width: 260px; box-sizing: border-box; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }',
  '.teamroster-openid:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
  '.teamroster-openid:disabled { opacity: 0.65; }',
].join('\n')

window.__ModuleLoader__.load({
  id: 'dsh-plugin-team',
  factory: function (require) {
    var module = { exports: {} }

    var React = require('react')

    /*
     * CSS 按需注入，方式与构建产物一致。
     *
     * DSH 自己的 client 包由 lightningcss 把每个 *.module.css 内联成字符串、
     * 再追加一个带 `data-plugin-css` 的 <style>。手写 bundle 没有构建步骤，
     * 于是照做：带上同样的守卫，因为这个 factory 在一个页面的生命周期里可能
     * 执行不止一次，第二个同样的标签会把每条规则都翻倍。
     *
     * 下面每个 `--dsw-alias-*` 都在真实 token 表里核过（这些名字在
     * @deepseek-ai 各包的 lib 产物里都能找到用量）；编出来的名字会静默地
     * 什么都不上色。
     *
     * 注意：块注释里不能出现那两个字符组成的“注释结束”序列——本行的
     * 通配写法首版就踩了这个坑，`node --check` 照样通过，因为被提前截断
     * 出来的那半行恰好还能解析；只有真的执行这个 factory 才会炸。
     */
    var CSS_TAG_ID = 'dsh-plugin-team/client.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null) {
      var styleTag = document.createElement('style')
      styleTag.setAttribute('data-plugin-css', CSS_TAG_ID)
      styleTag.textContent = CSS
      document.head.appendChild(styleTag)
    }

    /* ---------------------------------------------------------------- *
     * 取值与格式化：host 的响应一律当成不可信输入来读
     * ---------------------------------------------------------------- */

    function describe(error) {
      if (error === null || error === undefined) return '未知错误'
      if (typeof error === 'string') return error
      if (error.message !== undefined) return String(error.message)
      return String(error)
    }

    function asText(value) {
      if (typeof value === 'string') return value
      if (value === null || value === undefined) return ''
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return ''
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function asObject(value) {
      return value !== null && typeof value === 'object' && Array.isArray(value) === false ? value : null
    }

    function asNumber(value, fallback) {
      var number = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(number) ? number : (fallback === undefined ? 0 : fallback)
    }

    function nonEmptyString(value) {
      return typeof value === 'string' && value !== ''
    }

    function oneLine(value, max) {
      var text = asText(value).replace(/\s+/g, ' ').trim()
      if (max !== undefined && text.length > max) return text.slice(0, max) + '…'
      return text
    }

    function parseDate(value) {
      if (typeof value !== 'string' || value === '') return null
      var date = new Date(value)
      return isNaN(date.getTime()) ? null : date
    }

    function pad2(number) {
      return (number < 10 ? '0' : '') + String(number)
    }

    /** ISO → 本地时间（浏览器时区）。解析不了就把原串还回去，不显示 Invalid Date。 */
    function localTime(value) {
      var date = parseDate(value)
      if (date === null) return asText(value)
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    function formatDuration(ms) {
      var seconds = Math.round(Math.abs(ms) / 1000)
      if (seconds < 60) return String(seconds) + ' 秒'
      var minutes = Math.floor(seconds / 60)
      if (minutes < 60) return String(minutes) + ' 分钟'
      var hours = Math.floor(minutes / 60)
      if (hours < 24) return String(hours) + ' 小时'
      return String(Math.floor(hours / 24)) + ' 天'
    }

    /** 相对时间只是辅助：宿主与浏览器的钟不一定一致，所以永远和绝对时间一起显示。 */
    function relativeTime(value) {
      var date = parseDate(value)
      if (date === null) return ''
      var delta = date.getTime() - Date.now()
      return (delta >= 0 ? '剩余 ' : '已过 ') + formatDuration(delta)
    }

    function stamp(value) {
      var date = parseDate(value)
      if (date === null) return asText(value)
      return localTime(value) + '（' + relativeTime(value) + '）'
    }

    function stateTone(state) {
      var tone = STATE_TONE[asText(state)]
      return tone === undefined ? 'mute' : tone
    }

    function stateTagText(state) {
      var raw = asText(state)
      if (raw === '') return '（无状态）'
      var label = STATE_LABEL[raw]
      return label === undefined ? raw : raw + ' · ' + label
    }

    /* ---------------------------------------------------------------- *
     * 与 host 半边的一次往返
     * ---------------------------------------------------------------- */

    /**
     * `fetch` 是同源的，浏览器自动带上 GUI 的 cookie；`credentials` 只是把
     * 这件事写明。返回值永远是一个“结果对象”而不是 reject：每个调用点都要
     * 渲染点东西，抛出去只会晚一行被接住。
     *
     * timeoutMs > 0 时给这次请求加一个上限——被挂住的后端不应该让界面永远
     * 停在“读取中…”。执行一轮（run_task）可能跑好几分钟，所以那种调用传 0：
     * 客户端放弃等待并不会让服务端的回合停下，假装超时只会说假话。
     *
     * `url` 是第一个参数：台账页走 callApi（下面那个薄包装），配置页走
     * CONFIG_URL。除地址之外的行为两边完全一样，超时/非 JSON/网络错误
     * 都收敛成同一种结果对象。
     */
    function callApiTo(url, method, body, timeoutMs) {
      var options = { method: method, credentials: 'same-origin', headers: { accept: 'application/json' } }
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      var startedAt = Date.now()
      var request = fetch(url, options).then(function (response) {
        return response.json().then(function (payload) {
          return { status: response.status, payload: payload, elapsed: Date.now() - startedAt, error: null }
        }, function () {
          return { status: response.status, payload: null, elapsed: Date.now() - startedAt, error: 'HTTP ' + String(response.status) + ' 的响应不是 JSON' }
        })
      }, function (error) {
        return { status: 0, payload: null, elapsed: Date.now() - startedAt, error: describe(error) }
      })

      if (!(timeoutMs > 0) || typeof setTimeout !== 'function') return request

      return new Promise(function (resolve) {
        var settled = false
        var timer = setTimeout(function () {
          if (settled === true) return
          settled = true
          resolve({
            status: 0,
            payload: null,
            elapsed: Date.now() - startedAt,
            error: '读取超时：' + String(Math.round(timeoutMs / 1000)) + ' 秒没有响应',
          })
        }, timeoutMs)
        request.then(function (outcome) {
          if (settled === true) return
          settled = true
          clearTimeout(timer)
          resolve(outcome)
        })
      })
    }

    /** 台账路由的入口：签名与改动前完全一致，台账页的每个调用点都没动。 */
    function callApi(method, body, timeoutMs) {
      return callApiTo(LEDGER_URL, method, body, timeoutMs)
    }

    /* ---------------------------------------------------------------- *
     * 纯展示的小件
     * ---------------------------------------------------------------- */

    function tag(key, tone, text, title) {
      var props = { className: 'teamled-tag teamled-tag-' + tone, key: key }
      if (title !== undefined) props.title = title
      return React.createElement('span', props, text)
    }

    function line(key, className, text, title) {
      var props = { className: className, key: key }
      if (title !== undefined) props.title = title
      return React.createElement('div', props, text)
    }

    /**
     * 侧栏入口的图标。
     *
     * 注册项里**没有** icon 字段（`SidebarPanelMetadata` 只有 id / order /
     * label），占位组件本身就是要画在那个 `aria-hidden` 的 panelGlyph 里的
     * 东西——所以图标在这里，用 `currentColor` 继承侧栏的主题前景色，
     * 不写死任何颜色。props 只按 `SidebarPanelIconOwnerProps`（size / active）
     * 防御性地读一个 size，active 由侧栏自己负责配色。
     */
    function TeamGlyph(props) {
      var size = 18
      if (props !== null && typeof props === 'object' && asNumber(props.size, 0) > 0) size = asNumber(props.size, 18)
      return React.createElement('svg', {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        focusable: 'false',
        'aria-hidden': 'true',
      },
        React.createElement('rect', { x: 1.7, y: 2.2, width: 12.6, height: 11.6, rx: 2.4 }),
        React.createElement('path', { d: 'M4.3 6.1h7.4M4.3 8.7h7.4M4.3 11.3h4.2' }),
      )
    }

    /**
     * actor 的默认值：名册里的第一个人，其次成员域里的第一个 principal，
     * 最后才是需求默认负责人。
     *
     * `members` 的身份换了两次，这里按【新 → 旧】依次试，三种快照都能读出
     * 一个默认值来：
     *   1. `memberList`：成员对象数组（GET /api/team/config 的 `config.members`
     *      与台账快照新加的 `memberList`），第一个成员的 `key`；
     *   2. `domains`：域 → principal 数组（GET /api/team/config 的
     *      `config.domains`），按对象键的顺序取第一个非空 principal；
     *   3. `members.pm`：老台账快照里的域表（`members` 从数组换成表之前的样子）。
     * 一个都没有才落到 `defaultOwner`——它是兜底，不是首选。
     */
    function deriveActor(snapshot) {
      var config = asObject(snapshot) === null ? null : asObject(snapshot.config)
      if (config === null) return ''

      var memberList = asArray(config.memberList)
      for (var i = 0; i < memberList.length; i += 1) {
        var member = asObject(memberList[i])
        if (member !== null && nonEmptyString(member.key)) return member.key
      }

      var firstPrincipal = function (domainMap) {
        var domains = asObject(domainMap)
        if (domains === null) return ''
        var names = Object.keys(domains)
        for (var d = 0; d < names.length; d += 1) {
          var principals = asArray(domains[names[d]])
          for (var p = 0; p < principals.length; p += 1) {
            if (nonEmptyString(principals[p])) return principals[p]
          }
        }
        return ''
      }
      var fromDomains = firstPrincipal(config.domains)
      if (fromDomains !== '') return fromDomains
      /*
       * 老台账快照的 `members` 是域表；新的 `config.members` 是成员数组，
       * `asObject` 对数组返回 null，所以这一支只会命中老形状。
       */
      var members = asObject(config.members)
      if (members !== null) {
        var pm = asArray(members.pm)
        for (var m = 0; m < pm.length; m += 1) {
          if (nonEmptyString(pm[m])) return pm[m]
        }
      }
      return asText(config.defaultOwner)
    }

    /** 一行一条“到期扫描”的结论（tick 的 decided 条目，形状不止一种）。 */
    function describeDecision(item) {
      var entry = asObject(item)
      if (entry === null) return { tone: 'mute', text: nonEmptyString(item) ? item : '（无法识别的条目）' }
      var parts = []
      if (nonEmptyString(entry.task)) parts.push(entry.task)
      if (nonEmptyString(entry.gate)) parts.push('门禁 ' + entry.gate)
      if (nonEmptyString(entry.lease)) parts.push('租约 ' + entry.lease)
      if (nonEmptyString(entry.action)) parts.push('动作 ' + entry.action)
      if (entry.ok === true) parts.push('已执行')
      if (entry.dry_run === true) parts.push('预演，未改动')
      if (nonEmptyString(entry.state)) parts.push('→ ' + entry.state)
      if (entry.release_count !== undefined && entry.release_count !== null) parts.push('退回计数 ' + String(entry.release_count))
      if (nonEmptyString(entry.what)) parts.push(entry.what)
      var text = parts.length === 0 ? '（空条目）' : parts.join(' · ')
      var tone = 'info'
      if (entry.ok === false) tone = 'err'
      else if (entry.action === 'notify_only' || entry.lease === 'notify') tone = 'warn'
      if (entry.ok === false) {
        if (nonEmptyString(entry.code)) text += ' · code=' + entry.code
        /* 拒绝的原因也要原样出现，不能只留一个条目 id。 */
        if (nonEmptyString(entry.message)) text += ' · ' + entry.message
      }
      return { tone: tone, text: text }
    }

    /* ---------------------------------------------------------------- *
     * 配置页：把 /api/team/config 的响应当成不可信输入来读
     * ---------------------------------------------------------------- */

    /** `editable` 数组 → 集合。接口没给（或给错）就是空集：那就不给编辑。 */
    function editableSet(payload) {
      var set = {}
      var list = asArray(asObject(payload) === null ? null : payload.editable)
      for (var i = 0; i < list.length; i += 1) {
        if (nonEmptyString(list[i])) set[list[i]] = true
      }
      return set
    }

    /** 逗号 / 顿号 / 分号 / 换行都当分隔符：中文输入法下这几种最常见。 */
    function parseList(text) {
      var raw = asText(text).split(/[,，、;；\n]/)
      var out = []
      for (var i = 0; i < raw.length; i += 1) {
        var item = raw[i].replace(/\s+/g, ' ').trim()
        if (item !== '') out.push(item)
      }
      return out
    }

    /** 数组 → 字符串，再 → 数组，必须能原样对回来（浅比较靠它）。 */
    function readTextList(value) {
      var list = asArray(value)
      var out = []
      for (var i = 0; i < list.length; i += 1) {
        if (nonEmptyString(list[i])) out.push(list[i])
        else if (typeof list[i] === 'number') out.push(String(list[i]))
      }
      return out
    }

    function joinList(value) {
      return readTextList(value).join(', ')
    }

    function sameList(left, right) {
      if (left.length !== right.length) return false
      for (var i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false
      return true
    }

    /** 键值对象 → 可编辑的行数组；空对象给一行空行，用户才有地方下手。 */
    function kvToRows(value) {
      var source = asObject(value)
      var rows = []
      if (source !== null) {
        var keys = Object.keys(source)
        for (var i = 0; i < keys.length; i += 1) rows.push({ k: keys[i], v: asText(source[keys[i]]) })
      }
      if (rows.length === 0) rows.push({ k: '', v: '' })
      return rows
    }

    /**
     * 行数组 → 对象。空键的行丢掉；只填了值没填键的行是本地错误（不猜）。
     * 同一个键出现两次也报出来——静默地后盖前会让用户以为改上了。
     */
    function rowsToObject(rows, path) {
      var out = {}
      var problems = []
      var list = asArray(rows)
      for (var i = 0; i < list.length; i += 1) {
        var row = asObject(list[i])
        if (row === null) continue
        var key = asText(row.k).trim()
        var value = asText(row.v).trim()
        if (key === '') {
          if (value !== '') problems.push({ path: path + '[' + String(i) + ']', message: '这一行只填了值，没有填键' })
          continue
        }
        if (Object.prototype.hasOwnProperty.call(out, key)) {
          problems.push({ path: path + '.' + key, message: '这个键在这一栏里出现了两次，只会保留最后一行' })
        }
        out[key] = value
      }
      return { value: out, problems: problems }
    }

    function sameObject(left, right) {
      var a = asObject(left) === null ? {} : left
      var b = asObject(right) === null ? {} : right
      var keys = Object.keys(a)
      if (keys.length !== Object.keys(b).length) return false
      for (var i = 0; i < keys.length; i += 1) {
        if (Object.prototype.hasOwnProperty.call(b, keys[i]) !== true) return false
        if (asText(a[keys[i]]) !== asText(b[keys[i]])) return false
      }
      return true
    }

    /*
     * 结构化字段（bots / feishu.apps）在表单里只是一个 JSON 文本框。
     *
     * 它们不是标量也不是字符串列表，硬拆成几十个输入框既难用又难验证；而这个
     * 面板的规矩是「宁可少给一个控件，也不猜键的形状」。所以：原样显示 host
     * 给的 JSON（缩进后），改了就整段提交，改坏了就在本地拦下来——不猜。
     */

    /** 值 → 文本框里的文本。缩进是为了能读；`undefined` 给空串。 */
    function jsonText(value) {
      if (value === undefined) return ''
      try {
        var text = JSON.stringify(value, null, 2)
        return text === undefined ? '' : text
      } catch (error) {
        return ''
      }
    }

    /**
     * 文本框 → 值。
     *
     * 空文本框是本地错误而不是「清空」：这两个字段都不是可空的（要清空就写
     * `[]` 或 `{}`），把「什么都没填」当成删除会让一次误删静默生效。
     */
    function parseJsonField(text, path) {
      var raw = asText(text).trim()
      if (raw === '') return { value: undefined, problem: { path: path, message: '不能为空：要清空就填 []（数组）或 {}（对象）' } }
      var value
      try {
        value = JSON.parse(raw)
      } catch (error) {
        return { value: undefined, problem: { path: path, message: '不是合法的 JSON：' + String(error && error.message ? error.message : error) } }
      }
      var kind = Array.isArray(value) ? 'array' : (value !== null && typeof value === 'object' ? 'object' : typeof value)
      return { value: value, problem: null, kind: kind }
    }

    /** 同样的 JSON 语义（键顺序无关的浅比较够用：两端都来自 JSON.parse）。 */
    function sameJson(left, right) {
      var a = jsonText(left)
      var b = jsonText(right)
      if (a === b) return true
      try {
        return JSON.stringify(left) === JSON.stringify(right)
      } catch (error) {
        return false
      }
    }

    /** 后端的问题清单 → `[{path, message}]`，非对象条目也留成一行原文。 */
    function readProblems(value) {
      var list = asArray(value)
      var out = []
      for (var i = 0; i < list.length; i += 1) {
        var item = asObject(list[i])
        if (item === null) {
          out.push({ path: '', message: list[i] === null || list[i] === undefined ? '（空条目）' : String(list[i]) })
          continue
        }
        out.push({
          path: asText(item.path),
          message: nonEmptyString(item.message) ? asText(item.message) : '（这一条 host 没有给出 message）',
        })
      }
      return out
    }

    /** 自检结果里解释失败原因的那个字段（名字不止一种）。 */
    function firstProblemMessage(source) {
      var entry = asObject(source)
      if (entry === null) return '接口没有说明原因'
      var candidates = ['message', 'error', 'reason', 'detail']
      for (var i = 0; i < candidates.length; i += 1) {
        if (nonEmptyString(entry[candidates[i]])) return asText(entry[candidates[i]])
      }
      return '接口没有说明原因'
    }

    /**
     * diagnostics → 五行带状态的自检结果。
     *
     * 依次回答：用哪份凭据、机器人是谁、长连接通不通、机器人在哪些群、台账里
     * 现在有多少东西。缺一项就是 ⛔ + 一句「接口没有返回这一项」——自检块绝不
     * 因为拿不到数据就整块消失（那恰好是最需要知道的事）。
     */
    function buildDiagnosticRows(diagnostics) {
      var diag = asObject(diagnostics)
      if (diag === null) return []
      var rows = []

      /* 1. 凭据：来源 + appId */
      var credentials = asObject(diag.credentials)
      var credentialsOk = credentials !== null && credentials.ok === true
      var credentialsText = '凭据：接口没有返回这一项'
      if (credentials !== null) {
        credentialsText = credentialsOk
          ? '凭据来源 ' + (nonEmptyString(credentials.source) ? asText(credentials.source) : '（未说明）') +
            '，appId ' + (nonEmptyString(credentials.appId) ? asText(credentials.appId) : '（未说明）')
          : '凭据不可用：' + firstProblemMessage(credentials)
      }
      rows.push(configDiagRow('d-cred', credentialsOk, credentialsText))

      /* 2. 机器人身份：名字 + openId */
      var identity = asObject(diag.identity)
      var identityOk = identity !== null && identity.ok === true
      var identityText = '机器人身份：接口没有返回这一项'
      if (identity !== null) {
        identityText = identityOk
          ? '机器人身份 ' + (nonEmptyString(identity.name) ? asText(identity.name) : '（未命名）') +
            '（openId ' + (nonEmptyString(identity.openId) ? asText(identity.openId) : '（未说明）') + '）'
          : '机器人身份读不到：' + firstProblemMessage(identity)
      }
      rows.push(configDiagRow('d-id', identityOk, identityText))

      /* 3. 长连接：ready / connected / lastReadyAt / lastError */
      var connection = asObject(diag.connection)
      var ready = connection !== null && connection.ready === true
      var connected = connection !== null && connection.connected === true
      var connectionText = '长连接：接口没有返回这一项'
      var connectionDetail = ''
      if (connection !== null) {
        connectionText = (ready && connected ? '长连接已就绪：' : '长连接未就绪：') +
          'ready=' + (ready ? 'true' : 'false') + '，connected=' + (connected ? 'true' : 'false') +
          (nonEmptyString(connection.lastReadyAt) ? '，最近就绪 ' + localTime(connection.lastReadyAt) : '')
        if (nonEmptyString(connection.lastError)) connectionDetail = 'lastError: ' + asText(connection.lastError)
      }
      rows.push(configDiagRow('d-conn', ready && connected, connectionText, connectionDetail))

      /* 4. 机器人所在的群：ok 就逐个列 name + chatId，不 ok 就显示原因 */
      var chats = asObject(diag.chats)
      var chatsOk = chats !== null && chats.ok === true
      var chatItems = chats === null ? [] : asArray(chats.items)
      if (chatsOk !== true) {
        rows.push(configDiagRow('d-chats', false,
          '群列表读不到：' + (chats === null ? '接口没有返回这一项' : firstProblemMessage(chats))))
      } else {
        rows.push(configDiagRow('d-chats', true, '机器人所在群 ' + String(chatItems.length) + ' 个'))
        for (var c = 0; c < chatItems.length; c += 1) {
          var chat = asObject(chatItems[c])
          if (chat === null) {
            rows.push(configDiagSub('d-chat-' + String(c), '· ' + String(chatItems[c])))
            continue
          }
          rows.push(configDiagSub('d-chat-' + String(c),
            '· ' + (nonEmptyString(chat.name) ? asText(chat.name) : '（无名群）') +
            ' · ' + (nonEmptyString(chat.chatId) ? asText(chat.chatId) : '（没有 chatId）') +
            (nonEmptyString(chat.mode) ? ' · ' + asText(chat.mode) : '')))
        }
        if (chatItems.length === 0) rows.push(configDiagSub('d-chat-none', '· （机器人现在不在任何群里）'))
      }

      /* 5. 台账计数 */
      var ledger = asObject(diag.ledger)
      rows.push(configDiagRow('d-ledger', ledger !== null,
        ledger === null
          ? '台账计数：接口没有返回这一项'
          : '台账：需求 ' + String(asNumber(ledger.requirements, 0)) +
            ' · 任务 ' + String(asNumber(ledger.tasks, 0)) +
            ' · 群 ' + String(asNumber(ledger.chats, 0)) +
            ' · 收件箱 ' + String(asNumber(ledger.inbox, 0))))

      return rows
    }

    /** 自检块里的一行：✅/⛔ + 文案 [+ 补充说明]。 */
    function configDiagRow(key, ok, text, detail) {
      var children = [
        React.createElement('span', { className: 'teamcfg-diagmark ' + (ok === true ? 'teamcfg-diag-ok' : 'teamcfg-diag-bad'), key: 'm' }, ok === true ? '✅' : '⛔'),
        React.createElement('span', { className: ok === true ? 'teamcfg-diag-ok' : 'teamcfg-diag-bad', key: 't' }, text),
      ]
      if (detail !== undefined && detail !== null && detail !== '') {
        children.push(React.createElement('span', { className: 'teamcfg-hint', key: 'd' }, detail))
      }
      return React.createElement('div', { className: 'teamcfg-diagrow', key: key }, children)
    }

    /** 自检块里的从属行（比如逐个群）：不加 ✅/⛔，只把明细排开。 */
    function configDiagSub(key, text) {
      return React.createElement('div', { className: 'teamcfg-diagsub', key: key }, text)
    }

    /**
     * 服务端的 config → 表单字段表。
     *
     * 摊平成“一层”的字符串/布尔表（键就是 editable 里那种点路径），键值表另存
     * 成行数组。这样 set 和浅比较都只有一层，提交时再按顶层键组装回 patch。
     */
    function buildConfigForm(config) {
      var cfg = asObject(config) === null ? {} : config
      /*
       * `domains` 是域表（域 → principal 数组）。老快照里这个键叫 `members`，
       * 但新的 `config.members` 换成了成员对象数组（见「成员」页），所以这里
       * 只认 `domains`；成员列表那个数组不在这一页编辑。
       */
      var domains = asObject(cfg.domains) === null ? {} : cfg.domains
      var gates = asObject(cfg.gates) === null ? {} : cfg.gates
      var sessions = asObject(cfg.sessions) === null ? {} : cfg.sessions
      var presets = asObject(sessions.presets) === null ? {} : sessions.presets
      var feishu = asObject(cfg.feishu) === null ? {} : cfg.feishu
      var numberText = function (value) {
        return value === null || value === undefined || value === '' ? '' : String(value)
      }
      var optionalText = function (value) {
        return value === null || value === undefined ? '' : asText(value)
      }

      var fields = {
        defaultOwner: asText(cfg.defaultOwner),
        workspace: asText(cfg.workspace),
        workspaceTitle: asText(cfg.workspaceTitle),
        tickIntervalMs: numberText(cfg.tickIntervalMs),
        knownRepos: joinList(cfg.knownRepos),
        'feishu.speakLeaseMs': numberText(feishu.speakLeaseMs),
        'feishu.mode': asText(feishu.mode),
        /*
         * feishu.appId / appSecret / botOpenId / chatIds / apps 在这里【故意不再登记】：
         * 飞书应用是**机器人的属性**（一台机器人一个应用才有自己的身份），所以它们
         * 在「机器人」页跟着那一台机器人一起编辑（见 TeamBotsPage 的编辑器）。
         * 登记了字段就必须渲染控件、就必须提交 —— 少一个输入框不能变成多一次擦除。
         */
        'feishu.requireMention': feishu.requireMention === true,
        'feishu.respond': feishu.respond === true,
        'feishu.buttons': feishu.buttons === true,
        /* 不在 editable 里，但界面上要显示成一个（禁用的）勾选框：值也要读进来 */
        'feishu.addressedOverridesIntent': feishu.addressedOverridesIntent === true,
        'sessions.preset': optionalText(sessions.preset),
        'sessions.provider': optionalText(sessions.provider),
        'sessions.model': optionalText(sessions.model),
        'sessions.reasoningEffort': optionalText(sessions.reasoningEffort),
        'sessions.turnTimeoutMs': numberText(sessions.turnTimeoutMs),
        'sessions.maxLive': numberText(sessions.maxLive),
        /* 结构化字段：整段 JSON 进文本框（见 jsonText / parseJsonField） */
        bots: jsonText(cfg.bots),
      }

      var i
      for (i = 0; i < MEMBER_DOMAINS.length; i += 1) {
        fields['domains.' + MEMBER_DOMAINS[i]] = joinList(domains[MEMBER_DOMAINS[i]])
      }
      for (i = 0; i < GATE_NAMES.length; i += 1) {
        var gate = asObject(gates[GATE_NAMES[i]]) === null ? {} : gates[GATE_NAMES[i]]
        fields['gates.' + GATE_NAMES[i] + '.timeout'] = asText(gate.timeout)
        fields['gates.' + GATE_NAMES[i] + '.on_timeout'] = asText(gate.on_timeout)
        fields['gates.' + GATE_NAMES[i] + '.max_release'] = numberText(gate.max_release)
      }
      /*
       * 这里**故意不再**给「角色 → preset」生成字段（原来每个角色一个输入框）：
       * preset 是机器人的属性，会话是按需由那个机器人创建的，让人再按角色填一遍
       * 就是把同一个决定写两处，而其中一处（角色表）在机器人写了 agentPreset 之后
       * 根本不生效。面板改为只读展示 host 算出来的 sessionRoles
       * （见 lib/bots.js `sessionRoleView` 与下面的 renderSessionRoles）。
       */

      return { fields: fields, rows: { senders: kvToRows(cfg.senders), chatActors: kvToRows(cfg.chatActors) } }
    }

    /**
     * 表单 → `patch`。只带【真的改了】的字段：
     *
     *   - 标量 / 列表：值不同才带；
     *   - domains / bots / knownRepos / gates / sessions / senders / chatActors：
     *     这一组里有任何一个子项变了就带【整组】——这样无论 host 是整体替换还是
     *     深合并，都不会把同一组里别的键悄悄抹掉；
     *   - feishu：按 editable 给的叶子路径逐项带（`applied` 里就是
     *     `feishu.requireMention` 这种写法）；
     *   - `feishu.appSecret`：只有用户真的敲了才带，留空 = 不修改。
     *
     * 返回 `problems` 是**本地**校验（数字框里填了字、键值表只填了值、JSON 不合法…）。
     * 它们不为空时调用方不应该发请求：宁可原样告诉用户哪里不对。
     */
    function buildConfigPatch(original, fields, rows, editable) {
      var cfg = asObject(original) === null ? {} : original
      var form = asObject(fields) === null ? {} : fields
      var tables = asObject(rows) === null ? {} : rows
      var can = function (key) { return editable[key] === true }
      var text = function (key) { return asText(form[key]).trim() }
      var patch = {}
      var problems = []
      var changed = []

      /* ---- 基础文本 ---- */
      var scalarKeys = ['defaultOwner', 'workspace', 'workspaceTitle']
      for (var s = 0; s < scalarKeys.length; s += 1) {
        var scalar = scalarKeys[s]
        if (can(scalar) !== true) continue
        var value = text(scalar)
        if (value === asText(cfg[scalar])) continue
        patch[scalar] = value
        changed.push(scalar)
      }

      if (can('tickIntervalMs')) {
        var tickRaw = text('tickIntervalMs')
        if (tickRaw !== asText(cfg.tickIntervalMs)) {
          var tick = Number(tickRaw)
          if (tickRaw === '' || Number.isFinite(tick) !== true || tick <= 0) {
            problems.push({ path: 'tickIntervalMs', message: 'tick 间隔要填正数（毫秒），例如 60000' })
          } else {
            patch.tickIntervalMs = tick
            changed.push('tickIntervalMs')
          }
        }
      }

      /*
       * ---- 成员域（domains）：六个域整组提交（缺的域也提交成空数组，
       * 语义就是“这个域没人”）。成员列表（`members`，成员对象数组）不在这
       * 一页改：它的 openId 绑定在「成员」页上做。
       */
      if (can('domains')) {
        var domains = asObject(cfg.domains) === null ? {} : cfg.domains
        var nextDomains = {}
        var domainsChanged = false
        for (var m = 0; m < MEMBER_DOMAINS.length; m += 1) {
          var domain = MEMBER_DOMAINS[m]
          var list = parseList(form['domains.' + domain])
          nextDomains[domain] = list
          if (sameList(list, readTextList(domains[domain])) !== true) domainsChanged = true
        }
        if (domainsChanged === true) {
          patch.domains = nextDomains
          changed.push('domains')
        }
      }

      /* ---- 结构化字段：bots（整段 JSON，改坏了不发请求） ---- */
      if (can('bots')) {
        /*
         * 空文本框 + 没有基线值 = “这一项这里本来就没有”，不算改动；只有基线
         * 存在而用户把内容删空了，才是「不能为空」。否则接口有一天没返回 bots
         * 就会让整页保存都被一条本地错误挡住——那是把缺数据当成了用户错误。
         */
        if (asText(form.bots).trim() !== '' || cfg.bots !== undefined) {
          var parsedBots = parseJsonField(form.bots, 'bots')
          if (parsedBots.problem !== null) problems.push(parsedBots.problem)
          else if (sameJson(parsedBots.value, cfg.bots) !== true) {
            patch.bots = parsedBots.value
            changed.push('bots')
          }
        }
      }

      /* ---- 只读列表：knownRepos ---- */
      if (can('knownRepos')) {
        var repos = parseList(form.knownRepos)
        if (sameList(repos, readTextList(cfg.knownRepos)) !== true) {
          patch.knownRepos = repos
          changed.push('knownRepos')
        }
      }

      /* ---- 键值表：senders / chatActors ---- */
      var tableKeys = [['senders', 'senders'], ['chatActors', 'chatActors']]
      for (var t = 0; t < tableKeys.length; t += 1) {
        var tableName = tableKeys[t][0]
        if (can(tableName) !== true) continue
        var built = rowsToObject(tables[tableName], tableName)
        for (var p = 0; p < built.problems.length; p += 1) problems.push(built.problems[p])
        if (sameObject(built.value, cfg[tableName]) !== true) {
          patch[tableName] = built.value
          changed.push(tableName)
        }
      }

      /* ---- 门禁：四道整组提交 ---- */
      if (can('gates')) {
        var gates = asObject(cfg.gates) === null ? {} : cfg.gates
        var nextGates = {}
        var gatesChanged = false
        for (var g = 0; g < GATE_NAMES.length; g += 1) {
          var gateName = GATE_NAMES[g]
          var gate = asObject(gates[gateName]) === null ? {} : gates[gateName]
          var timeout = text('gates.' + gateName + '.timeout')
          var onTimeout = text('gates.' + gateName + '.on_timeout')
          var maxRaw = text('gates.' + gateName + '.max_release')
          var maxRelease = null
          if (maxRaw !== '') {
            var maxNumber = Number(maxRaw)
            if (Number.isFinite(maxNumber) !== true || maxNumber < 0) {
              problems.push({ path: 'gates.' + gateName + '.max_release', message: '退回次数上限要填非负整数（留空表示不限）' })
            } else {
              maxRelease = maxNumber
            }
          }
          nextGates[gateName] = { timeout: timeout, on_timeout: onTimeout, max_release: maxRelease }
          var maxOriginal = gate.max_release === null || gate.max_release === undefined ? '' : String(gate.max_release)
          if (timeout !== asText(gate.timeout) || onTimeout !== asText(gate.on_timeout) || maxRaw !== maxOriginal) gatesChanged = true
        }
        if (gatesChanged === true) {
          patch.gates = nextGates
          changed.push('gates')
        }
      }

      /* ---- 会话：整组提交；preset 一类的空串按接口的形状给 null ---- */
      if (can('sessions')) {
        var sessions = asObject(cfg.sessions) === null ? {} : cfg.sessions
        var nextSessions = {}
        var sessionsChanged = false
        var optionalKeys = ['preset', 'provider', 'model', 'reasoningEffort']
        for (var o = 0; o < optionalKeys.length; o += 1) {
          var optionalKey = optionalKeys[o]
          var optionalValue = text('sessions.' + optionalKey)
          nextSessions[optionalKey] = optionalValue === '' ? null : optionalValue
          if (optionalValue !== asText(sessions[optionalKey])) sessionsChanged = true
        }
        /*
         * `sessions.presets` 一概不提交：面板已经不渲染这些输入框了，而空输入框提
         * 交上去就是 null，那会把文件里手写的角色映射整张抹掉。要改某个角色的
         * preset，改那个机器人的 agentPreset（「机器人」页）—— 那里才是它生效的地方。
         */

        var turnRaw = text('sessions.turnTimeoutMs')
        var turnOriginal = sessions.turnTimeoutMs === null || sessions.turnTimeoutMs === undefined ? '' : String(sessions.turnTimeoutMs)
        var turnValue = null
        if (turnRaw !== '') {
          var turnNumber = Number(turnRaw)
          if (Number.isFinite(turnNumber) !== true || turnNumber <= 0) {
            problems.push({ path: 'sessions.turnTimeoutMs', message: '一轮的超时要填正数（毫秒），留空表示用默认' })
          } else {
            turnValue = turnNumber
          }
        }
        if (turnRaw !== turnOriginal) sessionsChanged = true
        nextSessions.turnTimeoutMs = turnValue

        var liveRaw = text('sessions.maxLive')
        var liveOriginal = sessions.maxLive === null || sessions.maxLive === undefined ? '' : String(sessions.maxLive)
        var liveValue = null
        if (liveRaw !== '') {
          var liveNumber = Number(liveRaw)
          if (Number.isFinite(liveNumber) !== true || liveNumber < 0) {
            problems.push({ path: 'sessions.maxLive', message: '并发会话上限要填非负整数，留空表示用默认' })
          } else {
            liveValue = liveNumber
          }
        }
        if (liveRaw !== liveOriginal) sessionsChanged = true
        nextSessions.maxLive = liveValue

        if (sessionsChanged === true) {
          patch.sessions = nextSessions
          changed.push('sessions')
        }
      }

      /* ---- 飞书：逐叶子路径，只带改过的 ---- */
      var feishu = asObject(cfg.feishu) === null ? {} : cfg.feishu
      var feishuPatch = {}
      var feishuChanged = false
      if (can('feishu.mode')) {
        var mode = text('feishu.mode')
        if (mode !== asText(feishu.mode)) { feishuPatch.mode = mode; feishuChanged = true }
      }
      /*
       * 这里【故意没有】feishu.appId / appSecret / chatIds / apps 的提交代码。
       * 输入框已经不在这一页了，而 `text()` 对不存在的字段返回空串 —— 留着旧代码
       * 就会把空串当成"用户清空了它"，一次保存把应用 id 和密钥一起抹掉。
       * 这些字段现在由「机器人」页的编辑器提交（那里知道它属于哪一台机器人）。
       */
      var flags = ['requireMention', 'respond', 'buttons', 'addressedOverridesIntent']
      for (var f = 0; f < flags.length; f += 1) {
        if (can('feishu.' + flags[f]) !== true) continue
        var nextFlag = form['feishu.' + flags[f]] === true
        if (nextFlag !== (feishu[flags[f]] === true)) { feishuPatch[flags[f]] = nextFlag; feishuChanged = true }
      }
      /*
       * `feishu.speakLeaseMs`：发言租约的时长。留空 = 不修改（和 appSecret 同
       * 一条规矩：一个数字框被清空，说不清用户是想恢复默认还是想填 0）。
       */
      if (can('feishu.speakLeaseMs')) {
        var leaseRaw = text('feishu.speakLeaseMs')
        var leaseOriginal = feishu.speakLeaseMs === null || feishu.speakLeaseMs === undefined ? '' : String(feishu.speakLeaseMs)
        if (leaseRaw !== leaseOriginal) {
          if (leaseRaw === '') {
            problems.push({ path: 'feishu.speakLeaseMs', message: '发言租约要填正数（毫秒）；留空不会提交任何改动' })
          } else {
            var lease = Number(leaseRaw)
            if (Number.isFinite(lease) !== true || lease <= 0) {
              problems.push({ path: 'feishu.speakLeaseMs', message: '发言租约要填正数（毫秒），例如 60000' })
            } else {
              feishuPatch.speakLeaseMs = lease
              feishuChanged = true
            }
          }
        }
      }
      if (feishuChanged === true) {
        patch.feishu = feishuPatch
        changed.push('feishu')
      }

      return { patch: patch, problems: problems, changed: changed }
    }

    /* ---------------------------------------------------------------- *
     * 面板本体
     * ---------------------------------------------------------------- */

    /**
     * 「配置」页签的内容。
     *
     * 纯渲染：不持有状态，也【不调用任何 hook】——它是被 TeamLedger 当普通函数
     * 调用后拼进 children 的，不是独立挂载的组件。状态全部留在 TeamLedger 里：
     * 两个页签是同一个 main 面板的两种画法，切页不卸载，也就不会丢掉填了一半
     * 的表单。
     */
    function TeamConfigPage(props) {
      var payload = asObject(props.payload)
      var config = payload === null ? null : asObject(payload.config)
      var diagnostics = payload === null ? null : asObject(payload.diagnostics)
      var feishu = config === null ? null : asObject(config.feishu)
      var editable = asObject(props.editable) === null ? {} : props.editable
      var fields = asObject(props.fields) === null ? {} : props.fields
      var rows = asObject(props.rows) === null ? {} : props.rows
      var editableKeys = Object.keys(editable)
      var can = function (key) { return editable[key] === true }
      var readOnlyHint = '这一项不在接口返回的 editable 里，只能读。'

      var valueOf = function (path) {
        var value = fields[path]
        if (typeof value === 'string') return value
        if (typeof value === 'number' || typeof value === 'boolean') return String(value)
        return ''
      }
      var checkedOf = function (path) { return fields[path] === true }

      /* ---------------- 表单小件（闭包，省得把十几个参数一路传下去） ---------------- */

      var textInput = function (path, key, placeholder) {
        return React.createElement('input', {
          className: 'teamcfg-input',
          type: 'text',
          key: key,
          value: valueOf(path),
          spellCheck: false,
          placeholder: placeholder === undefined ? '' : placeholder,
          onChange: function (event) { props.onField(path, event.target.value) },
        })
      }

      var numberInput = function (path, key, placeholder) {
        return React.createElement('input', {
          className: 'teamcfg-num',
          type: 'text',
          inputMode: 'numeric',
          key: key,
          value: valueOf(path),
          spellCheck: false,
          placeholder: placeholder === undefined ? '' : placeholder,
          onChange: function (event) { props.onField(path, event.target.value) },
        })
      }

      var passwordInput = function (path, key, placeholder) {
        return React.createElement('input', {
          className: 'teamcfg-input',
          type: 'password',
          key: key,
          value: valueOf(path),
          spellCheck: false,
          autoComplete: 'new-password',
          placeholder: placeholder,
          onChange: function (event) { props.onField(path, event.target.value) },
        })
      }

      /**
       * 结构化字段的编辑框：整段 JSON。不在 editable 里就是只读（禁用）——
       * 一个改不动的框也要能看见值，否则用户不知道 host 现在到底配了什么。
       */
      var jsonInput = function (path, key, writable) {
        var inputProps = {
          className: 'teamcfg-json',
          key: key,
          value: valueOf(path),
          spellCheck: false,
          rows: 8,
          placeholder: '[]',
        }
        if (writable === true) inputProps.onChange = function (event) { props.onField(path, event.target.value) }
        else {
          inputProps.disabled = true
          inputProps.readOnly = true
        }
        return React.createElement('textarea', inputProps)
      }

      /**
       * 下拉框。两种用法：
       *   selectInput(path, key, options, labels)                  —— 值取自表单表（配置页）
       *   selectInput(key, options, labels, value, onChange)       —— 值来自草稿（机器人编辑器）
       * 第二种不是"重复实现"：编辑器的值不在 `form` 里，而在 TeamLedger 的草稿里，
       * 复用第一种会让下拉框读到空值、一改还把别的字段带偏。
       */
      var selectInput = function (path, key, options, labels, explicitValue, explicitOnChange) {
        var fromDraft = explicitOnChange !== undefined && explicitOnChange !== null
        var current = fromDraft ? asText(explicitValue) : valueOf(path)
        var list = options.slice()
        /* 服务端给了清单以外的值也要显示出来：下拉框不许悄悄改掉没列出来的值 */
        if (current !== '' && list.indexOf(current) < 0) list.unshift(current)
        var options_ = []
        for (var i = 0; i < list.length; i += 1) {
          var option = list[i]
          var label = labels !== undefined && labels[option] !== undefined ? labels[option] : option
          options_.push(React.createElement('option', { value: option, key: 'o' + String(i) }, label))
        }
        var selectProps = {
          className: 'teamcfg-select',
          key: key,
          value: current,
        }
        if (fromDraft) {
          selectProps.onChange = function (event) { explicitOnChange(event.target.value) }
        } else {
          selectProps.onChange = function (event) { props.onField(path, event.target.value) }
        }
        return React.createElement('select', selectProps, options_)
      }

      var checkInput = function (path, key, readOnly) {
        var inputProps = {
          type: 'checkbox',
          key: key,
          checked: checkedOf(path),
        }
        if (readOnly === true) {
          inputProps.disabled = true
          inputProps.readOnly = true
          /* 空 onChange：受控 checkbox 不给 onChange 时 React 会警告，而禁用项本来就不会触发 */
          inputProps.onChange = function () {}
        } else {
          inputProps.onChange = function (event) { props.onField(path, event.target.checked === true) }
        }
        return React.createElement('input', inputProps)
      }

      var field = function (key, label, control, hint) {
        var children = [
          React.createElement('div', { className: 'teamcfg-label', key: 'l' }, label),
          React.createElement('div', { className: 'teamcfg-control', key: 'c' }, control),
        ]
        if (hint !== undefined && hint !== null && hint !== '') {
          children.push(React.createElement('div', { className: 'teamcfg-hint', key: 'h' }, hint))
        }
        return React.createElement('div', { className: 'teamcfg-field', key: key }, children)
      }

      /**
       * 「角色 → preset」的**只读**展示。
       *
       * 这里原来是 7 个输入框，让人按角色手填 preset。现在不填了，理由不是"省事"：
       * preset 是**机器人的属性**，会话又是按需由那个机器人创建的，所以角色表只是
       * 一个"机器人自己没写时才生效"的兜底。把它做成一排输入框，等于请人把同一个
       * 决定写两遍，而其中一遍（角色表）在他写了机器人那一遍之后就不生效了 ——
       * 这种"填了没用"的字段比没有字段更糟。
       *
       * 真值由 host 算（lib/bots.js `sessionRoleView`）：谁提供这个角色的 preset、
       * 以及来源是机器人 / 角色映射 / 全局兜底，面板只负责原样显示。
       */
      var renderSessionRoles = function (payload) {
        var rows = payload === null || payload === undefined ? null : payload.sessionRoles
        if (!Array.isArray(rows)) {
          return line('f-roles-missing', 'teamcfg-hint',
            '接口没有返回 sessionRoles，所以这里显示不了「各角色实际用谁」。刷新一次配置再试。')
        }
        if (rows.length === 0) {
          return line('f-roles-empty', 'teamcfg-hint',
            '名册里还没有机器人：先在「机器人」页加一个，它的 agentPreset 就是这个角色的 preset。')
        }
        var SOURCE = {
          bot: '机器人自己的 agentPreset',
          'sessions.presets': '角色映射 sessions.presets（机器人自己写了 preset 时会被盖过）',
          'sessions.preset': '全局兜底 sessions.preset',
          none: '未设置 → 用部署自己的默认预设',
        }
        var children = [
          React.createElement('div', { className: 'teamcfg-label', key: 'l' }, '角色 → preset（只读）'),
          React.createElement('div', { className: 'teamcfg-control', key: 'c' }, rows.map(function (raw, i) {
            var row = asObject(raw)
            if (row === null) return null
            var role = asText(row.role)
            var label = asText(row.roleLabel) === '' ? role : asText(row.roleLabel)
            var bot = asText(row.botName) === '' ? asText(row.botId) : asText(row.botName) + '（' + asText(row.botId) + '）'
            var preset = asText(row.preset) === '' ? '（未设置）' : asText(row.preset)
            var text = role + '（' + label + '） · ' +
              (bot === '' ? '没有机器人' : bot) + ' · preset: ' + preset +
              ' · 来源：' + (SOURCE[asText(row.source)] ?? asText(row.source))
            return React.createElement('div', { className: 'teamcfg-hint', key: 'r' + String(i) }, text)
          })),
        ]
        return React.createElement('div', { className: 'teamcfg-field' }, children)
      }

      /**
       * 只读的"现在有哪些飞书应用、谁在用"。
       *
       * 这一行是**替代品**：它原来是一组可编辑的输入框，现在那些输入框搬到了
       * 「机器人」页。留着这一行的目的是让人知道"东西没丢，只是跟着机器人走了"，
       * 顺带把密钥是否已设置、谁在用它讲清楚 —— 这些都是 host 算好的事实。
       */
      var renderAppsSummary = function (payload) {
        var roster = payload === null || payload === undefined ? null : asObject(payload.roster)
        var config = payload === null || payload === undefined ? null : asObject(payload.config)
        var apps = roster === null ? null : asArray(roster.apps)
        var defaultAppId = config === null ? '' : asText(asObject(config.feishu) === null ? '' : asObject(config.feishu).appId)
        if (apps === null || apps.length === 0) {
          return defaultAppId === ''
            ? '现在一个飞书应用都没配：在「机器人」页选中一台机器人，填它的 app id 与密钥。'
            : '只配了一个应用 ' + defaultAppId + '（密钥' + (config !== null && asObject(config.feishu) !== null && asObject(config.feishu).appSecretSet === true ? '已设置' : '未设置') + '）。'
        }
        var parts = []
        for (var i = 0; i < apps.length; i += 1) {
          var app = asObject(apps[i])
          if (app === null) continue
          var bots = readTextList(app.bots)
          // 不再标"默认应用"：应用是机器人的属性，没有哪一个更默认。
          parts.push(asText(app.appId) +
            '：密钥' + (app.appSecretSet === true ? '已设置' : '未设置') +
            '，' + (bots.length === 0 ? '还没有机器人用它' : '机器人 ' + bots.join('、')))
        }
        return parts.join(' ｜ ')
      }

      var section = function (key, title, note, nodes) {
        var head = [React.createElement('span', { className: 'teamcfg-sectitle', key: 't' }, title)]
        if (note !== undefined && note !== null && note !== '') {
          head.push(React.createElement('span', { className: 'teamled-note', key: 'n' }, note))
        }
        return React.createElement('div', { className: 'teamcfg-sec', key: key },
          React.createElement('div', { className: 'teamled-row', key: 'h' }, head),
          nodes,
        )
      }

      /** 问题清单：path + message 逐条原文，不合并、不改写。 */
      var problemsPanel = function (key, title, problems) {
        var nodes = []
        for (var i = 0; i < problems.length; i += 1) {
          var problem = asObject(problems[i])
          var path = problem === null ? '' : asText(problem.path)
          var message = problem === null ? asText(problems[i]) : asText(problem.message)
          nodes.push(React.createElement('div', { className: 'teamcfg-problem', key: 'p' + String(i) },
            path === '' ? null : React.createElement('span', { className: 'teamcfg-problem-path', key: 'k' }, path + '：'),
            React.createElement('span', { key: 'm' }, message === '' ? '（这一条没有 message）' : message),
          ))
        }
        return React.createElement('div', { className: 'teamled-panel teamled-panel-err', key: key },
          React.createElement('div', { className: 'teamled-panel-title teamled-err', key: 't' }, title),
          nodes,
        )
      }

      /** 两列输入的键值表：可增删行。 */
      var kvTable = function (tableKey, label, keyPlaceholder, hint) {
        var list = asArray(rows[tableKey])
        if (list.length === 0) list = [{ k: '', v: '' }]
        var nodes = []
        for (var i = 0; i < list.length; i += 1) {
          var row = asObject(list[i])
          var rowKey = row === null ? '' : asText(row.k)
          var rowValue = row === null ? '' : asText(row.v)
          nodes.push(React.createElement('div', { className: 'teamcfg-kvrow', key: 'r' + String(i) },
            React.createElement('input', {
              className: 'teamcfg-input',
              type: 'text',
              key: 'k',
              value: rowKey,
              spellCheck: false,
              placeholder: keyPlaceholder,
              onChange: function (index) {
                return function (event) { props.onRow(tableKey, index, 'k', event.target.value) }
              }(i),
            }),
            React.createElement('input', {
              className: 'teamcfg-input',
              type: 'text',
              key: 'v',
              value: rowValue,
              spellCheck: false,
              /* 只有 actor 那个框用 'human:xxx' 做占位，别的都写成模板：页面里
                 「哪个框是 actor」永远只有一个答案 */
              placeholder: 'human:<名字>',
              onChange: function (index) {
                return function (event) { props.onRow(tableKey, index, 'v', event.target.value) }
              }(i),
            }),
            React.createElement('button', {
              className: 'teamled-btn',
              type: 'button',
              key: 'd',
              title: '删掉这一行',
              onClick: function (index) {
                return function () { props.onRemoveRow(tableKey, index) }
              }(i),
            }, '删'),
          ))
        }
        var control = React.createElement('div', { className: 'teamcfg-kvlist', key: 'kv' },
          nodes,
          React.createElement('div', { className: 'teamled-row', key: 'add' },
            React.createElement('button', {
              className: 'teamled-btn',
              type: 'button',
              onClick: function () { props.onAddRow(tableKey) },
            }, '+ 加一行'),
          ),
        )
        return field('f-kv-' + tableKey, label, control, hint)
      }

      /* ---------------- 1. 接入自检 ---------------- */

      var children = []
      var checkedAtText = '还没有自检时间'
      if (diagnostics !== null && nonEmptyString(diagnostics.checkedAt)) {
        checkedAtText = '检查时间 ' + stamp(diagnostics.checkedAt)
      }
      var diagRows = payload === null ? [] : buildDiagnosticRows(diagnostics)
      var diagBody
      if (diagRows.length > 0) diagBody = React.createElement('div', { className: 'teamcfg-diag', key: 'rows' }, diagRows)
      else if (props.phase === 'error') diagBody = React.createElement('div', { className: 'teamled-note', key: 'none' }, '自检没跑成：' + asText(props.error))
      else diagBody = React.createElement('div', { className: 'teamled-note', key: 'none' }, '自检中…（GET ' + CONFIG_URL + '）')

      children.push(React.createElement('div', { className: 'teamled-panel', key: 'diag' },
        React.createElement('div', { className: 'teamled-row', key: 'h' },
          React.createElement('span', { className: 'teamled-panel-title', key: 't' }, '接入自检'),
          React.createElement('span', { className: 'teamled-note', key: 'at' }, checkedAtText),
          React.createElement('span', { className: 'teamcfg-spacer', key: 'sp' }),
          React.createElement('button', {
            className: 'teamled-btn',
            type: 'button',
            key: 'reload',
            disabled: props.fetching === true || props.busy === true,
            title: '重新 GET ' + CONFIG_URL + '：凭据 / 机器人身份 / 长连接 / 群列表 / 台账计数',
            onClick: function () { props.onReload() },
          }, props.fetching === true ? '自检中…' : '重新自检'),
        ),
        diagBody,
      ))

      /* 读配置失败，或还没读到：这里就把话说清楚，别让下面出现一个空表单。 */
      if (payload === null) {
        if (props.phase === 'error') {
          children.push(React.createElement('div', { className: 'teamled-panel teamled-panel-err', key: 'loaderr' },
            React.createElement('div', { className: 'teamled-msg teamled-err', key: 'm' }, '读取配置失败：' + asText(props.error)),
            React.createElement('div', { className: 'teamled-note', key: 'n' }, '接口：' + CONFIG_URL + '（GET，同源，带 GUI 的浏览器 cookie）。'),
            React.createElement('div', { className: 'teamled-row', key: 'a' },
              React.createElement('button', {
                className: 'teamled-btn',
                type: 'button',
                disabled: props.fetching === true,
                onClick: function () { props.onReload() },
              }, props.fetching === true ? '重试中…' : '重试'),
            ),
          ))
        } else {
          children.push(React.createElement('div', { className: 'teamled-panel', key: 'loading' },
            React.createElement('div', { className: 'teamled-msg teamled-info' }, '读取配置中…'),
            React.createElement('div', { className: 'teamled-note' }, '读取 ' + CONFIG_URL + '；超过 ' + String(Math.round(GET_TIMEOUT_MS / 1000)) + ' 秒没有响应会报超时。'),
          ))
        }
      }

      /* ---------------- 2. 配置表单 ---------------- */

      var formSections = []
      if (payload !== null && editableKeys.length === 0) {
        formSections.push(React.createElement('div', { className: 'teamled-panel teamled-panel-warn', key: 'noeditable' },
          React.createElement('div', { className: 'teamled-panel-title teamled-warn', key: 't' }, '没有拿到可编辑清单（editable）'),
          React.createElement('div', { className: 'teamled-note', key: 'n' }, '接口没有返回非空的 editable 数组，所以一个输入框都不渲染：宁可不给改，也不猜哪些键能改。点右上角「重新自检」再试一次。'),
        ))
      } else if (payload !== null) {
        var basicNodes = []
        if (can('workspaceTitle')) basicNodes.push(field('f-title', 'workspaceTitle', textInput('workspaceTitle', 'i', '团队 · 飞书'), '团队名称（面板和提示里用）'))
        if (can('workspace')) basicNodes.push(field('f-ws', 'workspace', textInput('workspace', 'i', '/Users/…/team/workspace'), '执行会话的工作目录（任务的仓库都在它下面）'))
        if (can('defaultOwner')) basicNodes.push(field('f-owner', 'defaultOwner', textInput('defaultOwner', 'i', 'human:wangmengfan'), '没人指定负责人时的兜底身份：human:<名字> 或 bot:<角色>'))
        if (can('tickIntervalMs')) basicNodes.push(field('f-tick', 'tickIntervalMs', numberInput('tickIntervalMs', 'i', '60000'), '定时扫门禁 / 租约的间隔，单位毫秒'))
        if (basicNodes.length > 0) formSections.push(section('f-basic', '基础', 'workspace · workspaceTitle · defaultOwner · tickIntervalMs', basicNodes))

        /*
         * 成员【域】（domains）：域 → principal 列表。这里是「这个域里有哪些
         * 身份」，不是成员名册；成员自己的 openId 绑定在「成员」页上做。
         */
        if (can('domains')) {
          var domainNodes = []
          for (var mi = 0; mi < MEMBER_DOMAINS.length; mi += 1) {
            domainNodes.push(field('f-d-' + MEMBER_DOMAINS[mi], MEMBER_DOMAINS[mi],
              textInput('domains.' + MEMBER_DOMAINS[mi], 'i', 'human:<名字>, bot:<角色>'),
              mi === 0 ? '逗号 / 顿号分隔；空着就是这个域没人（没配的域也照样显示）。成员的 openId 在「成员」页绑定。' : ''))
          }
          formSections.push(section('f-domains', '成员域（domains）', '每个域一行，逗号分隔', domainNodes))
        }

        /* 机器人名册（bots）：结构化字段，整段 JSON 进文本框。 */
        if (can('bots')) {
          formSections.push(section('f-bots', '机器人（bots）', '整段 JSON；改坏了不会提交（本地就能看出来）', [
            field('f-bots-json', 'bots', jsonInput('bots', 'bots', true),
              '数组，每项含 id / displayName / role / feishu / permissions …；形状与 GET 返回的 config.bots 一致，只改要改的地方'),
          ]))
        }

        var kvNodes = []
        if (can('senders')) kvNodes.push(kvTable('senders', 'senders', 'ou_…（open_id）', 'open_id → human:xxx：群里谁发的消息算谁在说话'))
        if (can('chatActors')) kvNodes.push(kvTable('chatActors', 'chatActors', 'oc_…（chat_id）', 'chat_id → human:xxx：某个群整体算谁'))
        if (kvNodes.length > 0) formSections.push(section('f-kv', '键值表', '左边是键、右边是值；空键的行不会提交', kvNodes))

        if (can('knownRepos')) {
          formSections.push(section('f-repos', '已知仓库（knownRepos）', '', [
            field('f-repos-list', 'knownRepos', textInput('knownRepos', 'i', 'pay-service, web-app'), '逗号分隔；任务只能挂在这里列出的仓库上'),
          ]))
        }

        if (can('gates')) {
          var gateNodes = []
          for (var gi = 0; gi < GATE_NAMES.length; gi += 1) {
            var gateName = GATE_NAMES[gi]
            var gateControl = React.createElement('div', { className: 'teamcfg-control', key: 'c' },
              textInput('gates.' + gateName + '.timeout', 'to', '4h / 30m / 1d'),
              selectInput('gates.' + gateName + '.on_timeout', 'ot', ON_TIMEOUT_OPTIONS),
              numberInput('gates.' + gateName + '.max_release', 'mr', '留空 = 不限'),
            )
            gateNodes.push(field('f-gate-' + gateName, GATE_TITLE[gateName], gateControl,
              'timeout（形如 2h / 30m / 1d）· on_timeout（超时怎么办）· max_release（退回次数上限，可空）'))
          }
          formSections.push(section('f-gates', '门禁（gates）', '四道门禁各一行', gateNodes))
        }

        if (can('sessions')) {
          var sessionNodes = []
          sessionNodes.push(renderSessionRoles(payload))
          sessionNodes.push(field('f-s-preset', 'sessions.preset', textInput('sessions.preset', 'i', '（空 = null）'), '所有机器人共用的兜底 preset（机器人自己的 agentPreset 优先）'))
          sessionNodes.push(field('f-s-provider', 'sessions.provider', textInput('sessions.provider', 'i', '（空 = null）')))
          sessionNodes.push(field('f-s-model', 'sessions.model', textInput('sessions.model', 'i', '（空 = null）')))
          sessionNodes.push(field('f-s-effort', 'sessions.reasoningEffort', textInput('sessions.reasoningEffort', 'i', '（空 = null）')))
          sessionNodes.push(field('f-s-turn', 'sessions.turnTimeoutMs', numberInput('sessions.turnTimeoutMs', 'i', '900000'), '一轮执行的上限，单位毫秒'))
          sessionNodes.push(field('f-s-live', 'sessions.maxLive', numberInput('sessions.maxLive', 'i', '4'), '同时活着的执行会话上限'))
          formSections.push(section('f-sessions', '会话（sessions）',
            '会话不需要预先声明：任务派给哪个机器人，就用那个机器人的 preset 与模型按需起会话',
            sessionNodes))
        }

        var feishuNodes = []
        if (can('feishu.mode')) feishuNodes.push(field('f-f-mode', 'feishu.mode', selectInput('feishu.mode', 's', FEISHU_MODES, FEISHU_MODE_TITLE), 'own = 插件自己接飞书长连接；off = 不接'))
        /*
         * 飞书应用不在这里编辑：一台机器人一个应用才有自己的身份，所以 app id、
         * 密钥、机器人 open_id、所在群都跟着那一台机器人在「机器人」页改。这里只留
         * 一行只读的现状说明 —— 让人知道东西去哪儿了，而不是让他以为功能没了。
         */
        feishuNodes.push(field('f-f-apps-moved', '飞书应用',
          React.createElement('span', { className: 'teamcfg-hint', key: 'v' },
            renderAppsSummary(payload)),
          '每台机器人一个应用：在「机器人」页选中那一台，填它的 app id 与密钥（留空 = 不修改）'))
        if (can('feishu.speakLeaseMs')) feishuNodes.push(field('f-f-lease', 'feishu.speakLeaseMs', numberInput('feishu.speakLeaseMs', 'i', '60000'), '发言租约：一个机器人在一个群里连续说多久算“同一轮”，单位毫秒'))
        var flagNodes = []
        if (can('feishu.requireMention')) flagNodes.push(React.createElement('label', { className: 'teamcfg-check', key: 'rm' }, checkInput('feishu.requireMention', 'c'), 'requireMention（群里必须 @ 机器人才响应）'))
        if (can('feishu.respond')) flagNodes.push(React.createElement('label', { className: 'teamcfg-check', key: 'rs' }, checkInput('feishu.respond', 'c'), 'respond（真的把回复发出去）'))
        if (can('feishu.buttons')) flagNodes.push(React.createElement('label', { className: 'teamcfg-check', key: 'bt' }, checkInput('feishu.buttons', 'c'), 'buttons（卡片按钮）'))
        /*
         * 被 @ 是否越过诉求词表：这是有取舍的策略开关（见 ingest.js），所以它跟着
         * editable 走 —— editable 里有它就可点，没有就整项不渲染。写死成禁用的勾选框
         * 等于告诉操作者"设置存在但你不能改"，比不显示还糟。
         */
        if (can('feishu.addressedOverridesIntent')) flagNodes.push(React.createElement('label', { className: 'teamcfg-check', key: 'ao' }, checkInput('feishu.addressedOverridesIntent', 'c'), 'addressedOverridesIntent（被 @ 就不被诉求词表否决）'))
        if (flagNodes.length > 0) feishuNodes.push(field('f-f-flags', '开关', React.createElement('div', { className: 'teamcfg-control', key: 'c' }, flagNodes)))

        /*
         * botOpenId 是**只读**展示（飞书侧认出来的身份），它跟着这一组一起出现，
         * 也一起消失：editable 里一个 feishu.* 都没有时整组不渲染
         * （只渲染 editable 给的键，这是硬规矩）。
         */
        if (feishuNodes.length > 0) {
          formSections.push(section('f-feishu', '飞书（feishu）',
            '这一页只剩全局策略；应用与机器人身份跟着「机器人」页的那一台走',
            feishuNodes))
        }

        var formProblems = readProblems(payload.problems)
        if (formProblems.length > 0) {
          formSections.push(problemsPanel('cfg-payload-problems', '配置里现在就有这些问题（GET ' + CONFIG_URL + ' 的 problems）', formProblems))
        }
      }

      children = children.concat(formSections)

      /* ---------------- 3. 上一次保存的结果（原样展示） ---------------- */

      if (props.notice !== null) {
        var notice = asObject(props.notice)
        if (notice !== null) {
          var kind = asText(notice.kind)
          var toneClass = kind === 'ok' ? 'teamled-msg-ok' : kind === 'err' ? 'teamled-msg-err' : 'teamled-msg-warn'
          var panelClass = kind === 'ok' ? 'teamled-panel-ok' : kind === 'err' ? 'teamled-panel-err' : 'teamled-panel-warn'
          var noticeChildren = [
            React.createElement('div', { className: 'teamled-panel-title ' + toneClass, key: 't' }, asText(notice.title)),
            React.createElement('div', { className: 'teamled-msg ' + toneClass, key: 'm' }, asText(notice.message)),
          ]
          var noticeProblems = asArray(notice.problems)
          for (var np = 0; np < noticeProblems.length; np += 1) {
            var item = asObject(noticeProblems[np])
            var itemPath = item === null ? '' : asText(item.path)
            var itemMessage = item === null ? asText(noticeProblems[np]) : asText(item.message)
            noticeChildren.push(React.createElement('div', { className: 'teamcfg-problem', key: 'p' + String(np) },
              itemPath === '' ? null : React.createElement('span', { className: 'teamcfg-problem-path', key: 'k' }, itemPath + '：'),
              React.createElement('span', { key: 'm' }, itemMessage === '' ? '（这一条没有 message）' : itemMessage),
            ))
          }
          if (noticeProblems.length > 0) {
            noticeChildren.push(React.createElement('div', { className: 'teamled-note', key: 'pn' }, '以上是接口返回的 problems 原文，逐条列出，没有改写。'))
          }
          if (nonEmptyString(notice.code)) noticeChildren.push(React.createElement('div', { className: 'teamled-code', key: 'c' }, 'code: ' + asText(notice.code)))
          if (asNumber(notice.elapsed, 0) > 0) noticeChildren.push(React.createElement('div', { className: 'teamled-meta', key: 'e' }, '用时 ' + String(asNumber(notice.elapsed, 0)) + ' ms'))
          children.push(React.createElement('div', { className: 'teamled-panel ' + panelClass, key: 'notice' }, noticeChildren))
        }
      }

      /* ---------------- 4. 保存条 ---------------- */

      if (payload !== null && editableKeys.length > 0) {
        var saveBar = []
        saveBar.push(React.createElement('span', { className: 'teamled-meta', key: 'l' }, 'actor（谁在改）'))
        saveBar.push(React.createElement('input', {
          className: 'teamcfg-input teamcfg-actor',
          type: 'text',
          key: 'actor',
          value: asText(props.actor),
          spellCheck: false,
          placeholder: 'human:xxx（必填，与台账页共用同一个值）',
          title: 'host 按这个身份判定权限；缺了会返回 bad_request',
          onChange: function (event) { props.onActor(event.target.value) },
        }))
        saveBar.push(React.createElement('button', {
          className: 'teamled-btn teamled-btn-primary',
          type: 'button',
          key: 'save',
          disabled: props.busy === true || props.fetching === true || asText(props.actor).trim() === '',
          title: 'POST ' + CONFIG_URL + '：只提交改动过的字段',
          onClick: function () { props.onSave() },
        }, props.busy === true ? '保存中…' : '保存'))
        if (props.touched === true) saveBar.push(React.createElement('span', { className: 'teamled-warn', key: 'dirty' }, '有未保存的改动'))
        if (asText(props.actor).trim() === '') saveBar.push(React.createElement('span', { className: 'teamled-warn', key: 'noactor' }, 'actor 为空：保存已禁用'))
        saveBar.push(React.createElement('span', { className: 'teamcfg-spacer', key: 'sp' }))
        saveBar.push(React.createElement('span', { className: 'teamled-note', key: 'note' },
          '只提交改过的字段（浅比较）；保存成功后用返回的 config / diagnostics 刷新本页。'))
        children.push(React.createElement('div', { className: 'teamled-bar', key: 'savebar' }, saveBar))
      }

      return React.createElement('div', { className: 'teamcfg', key: 'cfg' }, children)
    }

    /* ---------------------------------------------------------------- *
     * 三个名册页：机器人 / 成员 / 会话
     *
     * 它们与「配置」页读【同一个】GET /api/team/config（同一份 configData），
     * 所以切页不重新取数、也不会两页显示两份不一样的状态。区别只是画法：
     * 配置页是“改”，这三页是“看现在到底是什么样”——robot 名册、成员名册、
     * 每个机器人在每个群的会话。
     *
     * 与 TeamConfigPage 一样：纯渲染、不调用任何 hook（被 TeamLedger 当普通
     * 函数调用后拼进 children），状态全部留在 TeamLedger 里。
     * ---------------------------------------------------------------- */

    /** 名册页共用的「读到了没有」块：拿到 payload 之前只有这一件事可说。 */
    function rosterStateNodes(props, what) {
      if (asObject(props.payload) !== null) return []
      if (props.phase === 'error') {
        return [React.createElement('div', { className: 'teamled-panel teamled-panel-err', key: 'loaderr' },
          React.createElement('div', { className: 'teamled-msg teamled-err', key: 'm' }, '读取' + what + '失败：' + asText(props.error)),
          React.createElement('div', { className: 'teamled-note', key: 'n' }, '接口：' + CONFIG_URL + '（GET，同源，带 GUI 的浏览器 cookie）。'),
          React.createElement('div', { className: 'teamled-row', key: 'a' },
            React.createElement('button', {
              className: 'teamled-btn',
              type: 'button',
              disabled: props.fetching === true,
              onClick: function () { props.onReload() },
            }, props.fetching === true ? '重试中…' : '重试'),
          ),
        )]
      }
      return [React.createElement('div', { className: 'teamled-panel', key: 'loading' },
        React.createElement('div', { className: 'teamled-msg teamled-info' }, '读取配置中…'),
        React.createElement('div', { className: 'teamled-note' }, '读取 ' + CONFIG_URL + '；超过 ' + String(Math.round(GET_TIMEOUT_MS / 1000)) + ' 秒没有响应会报超时。'),
      )]
    }

    /**
     * 上一次写操作的结果。
     *
     * 与配置页同一套画法、同一条规矩：`problems` / `code` / `message` 全是 host
     * 的原文，逐条排出，不改写、不合并、不“总结”。
     */
    function rosterNoticePanel(notice) {
      var entry = asObject(notice)
      if (entry === null) return null
      var kind = asText(entry.kind)
      var toneClass = kind === 'ok' ? 'teamled-msg-ok' : kind === 'err' ? 'teamled-msg-err' : 'teamled-msg-warn'
      var panelClass = kind === 'ok' ? 'teamled-panel-ok' : kind === 'err' ? 'teamled-panel-err' : 'teamled-panel-warn'
      var nodes = [
        React.createElement('div', { className: 'teamled-panel-title ' + toneClass, key: 't' }, asText(entry.title)),
        React.createElement('div', { className: 'teamled-msg ' + toneClass, key: 'm' }, asText(entry.message)),
      ]
      var problems = readProblems(entry.problems)
      for (var i = 0; i < problems.length; i += 1) {
        nodes.push(React.createElement('div', { className: 'teamcfg-problem', key: 'p' + String(i) },
          problems[i].path === '' ? null : React.createElement('span', { className: 'teamcfg-problem-path', key: 'k' }, problems[i].path + '：'),
          React.createElement('span', { key: 'm' }, problems[i].message),
        ))
      }
      if (problems.length > 0) {
        nodes.push(React.createElement('div', { className: 'teamled-note', key: 'pn' }, '以上是接口返回的 problems 原文，逐条列出，没有改写。'))
      }
      if (nonEmptyString(entry.code)) nodes.push(React.createElement('div', { className: 'teamled-code', key: 'c' }, 'code: ' + asText(entry.code)))
      if (asNumber(entry.elapsed, 0) > 0) nodes.push(React.createElement('div', { className: 'teamled-meta', key: 'e' }, '用时 ' + String(asNumber(entry.elapsed, 0)) + ' ms'))
      return React.createElement('div', { className: 'teamled-panel ' + panelClass, key: 'notice' }, nodes)
    }

    /**
     * 名册页共用的一张表。
     *
     * 格子里可以是字符串，也可以是节点；空值统一显示成「—」，因为“这一格没
     * 有值”和“这一格的值是空字符串”在界面上应该长得一样——用户不需要区分
     * 一个他没填过的字段到底是缺键还是空串。
     */
    function rosterTable(key, headers, rows) {
      var headCells = []
      for (var h = 0; h < headers.length; h += 1) {
        headCells.push(React.createElement('th', { className: 'teamroster-th', key: 'h' + String(h) }, headers[h]))
      }
      var bodyRows = []
      for (var r = 0; r < rows.length; r += 1) {
        var cells = asArray(rows[r])
        var tds = []
        for (var c = 0; c < cells.length; c += 1) {
          var cell = cells[c]
          var content = cell === null || cell === undefined || cell === '' ? '—' : cell
          tds.push(React.createElement('td', { className: 'teamroster-td', key: 'c' + String(c) }, content))
        }
        bodyRows.push(React.createElement('tr', { key: 'r' + String(r) }, tds))
      }
      return React.createElement('div', { className: 'teamroster-wrap', key: key },
        React.createElement('table', { className: 'teamroster-table' },
          React.createElement('thead', null, React.createElement('tr', null, headCells)),
          React.createElement('tbody', null, bodyRows),
        ))
    }

    /**
     * 名册条目上的 `problems`：`field` 与 `message` 分开摆（field 用等宽字），
     * `level` 只决定颜色。空清单显示「无」——不是空白，因为“检查过了，没问题”
     * 和“没有检查结果”必须看得出区别。
     */
    function rosterProblems(value) {
      var list = asArray(value)
      if (list.length === 0) return React.createElement('span', { className: 'teamroster-td-mute' }, '无')
      var nodes = []
      for (var i = 0; i < list.length; i += 1) {
        var item = asObject(list[i])
        var level = item === null ? '' : asText(item.level)
        var field = item === null ? '' : asText(item.field)
        var message = item === null ? String(list[i]) : asText(item.message)
        nodes.push(React.createElement('div', {
          className: level === 'error' ? 'teamroster-prob-err' : 'teamroster-prob-warn',
          key: 'p' + String(i),
        },
          field === '' ? null : React.createElement('span', { className: 'teamled-code', key: 'f' }, field + '：'),
          React.createElement('span', { key: 'm' }, message === '' ? '（这一条没有 message）' : message),
        ))
      }
      return React.createElement('div', { className: 'teamroster-probs' }, nodes)
    }

    /** 按 id 找一条名册条目（`roster.bots` / `config.bots` 都走这一个函数）。 */
    function findById(list, id) {
      var items = asArray(list)
      for (var i = 0; i < items.length; i += 1) {
        var item = asObject(items[i])
        if (item !== null && asText(item.id) === id) return item
      }
      return null
    }


      /** 安装级应用 id：老配置里机器人还没写自己的应用时，由 loader 采纳进每台机器人（见 config.ownApps）。 */
      var defaultAppIdOf = function (config) {
        var feishu = config === null ? null : asObject(config.feishu)
        return feishu === null ? '' : asText(feishu.appId)
      }

      /** host 认得（已经有密钥）的 appId 列表：用来在提交前发现"这个应用还没配密钥"。 */
      var knownAppIds = function (payload) {
        var roster = payload === null ? null : asObject(payload.roster)
        var apps = roster === null ? null : asArray(roster.apps)
        var out = []
        if (apps === null) return out
        for (var i = 0; i < apps.length; i += 1) {
          var app = asObject(apps[i])
          if (app !== null && app.appSecretSet === true) out.push(asText(app.appId))
        }
        return out
      }

      /**
       * 「机器人」页的编辑表单。
       *
       * 飞书应用在这里编辑，而不是在「配置」页 —— 一台机器人一个应用才有它自己的
       * 身份（一个应用只能有一条长连接、一个机器人 open_id），所以 app id、密钥、
       * open_id、所在群都是**这一台机器人**的属性。密钥是密码框且永远从空开始：
       * 留空 = 不修改，浏览器从来没有拿到过它。
       */
      var renderBotEditor = function (props, draft) {
        var payload = asObject(props.payload)
        var editable = asObject(props.editable) === null ? {} : props.editable
        var can = function (key) { return editable[key] === true }
        var actor = asText(props.actor).trim()
        var busy = props.busy === true
        var config = payload === null ? null : asObject(payload.config)
        var fields = asObject(draft.fields) === null ? {} : draft.fields
        var isNew = draft.isNew === true
        var defaultAppId = defaultAppIdOf(config)
        var appId = asText(fields.appId).trim()
        var targetApp = appId === '' ? defaultAppId : appId

        /* 这个应用现在有没有密钥：从 host 的只读应用视图里查，不猜。 */
        var appEntry = null
        var roster = payload === null ? null : asObject(payload.roster)
        var apps = roster === null ? null : asArray(roster.apps)
        if (apps !== null) {
          for (var i = 0; i < apps.length; i += 1) {
            var one = asObject(apps[i])
            if (one !== null && asText(one.appId) === targetApp) appEntry = one
          }
        }
        var secretSet = appEntry !== null && appEntry.appSecretSet === true
        /*
         * 这台机器人之外还有哪些应用：填 app id 是自由文本，所以把"已知的"列在提示里，
         * 免得操作者凭记忆敲 —— 敲错一位就是一个连不上的应用。
         */
        var knownAppsText = ''
        if (apps !== null) {
          var knownParts = []
          for (var k = 0; k < apps.length; k += 1) {
            var known = asObject(apps[k])
            if (known === null) continue
            var knownBots = readTextList(known.bots)
            knownParts.push(asText(known.appId) + (knownBots.length === 0 ? '（还没有机器人）' : '（' + knownBots.join('、') + '）'))
          }
          knownAppsText = knownParts.join('、')
        }
        var writer = can('bots') === true && actor !== '' && busy !== true

        var editable = function (path, value, onChange, placeholder, type, lockAlways) {
          var inputProps = {
            className: 'teamcfg-input',
            type: type === undefined ? 'text' : type,
            key: path,
            value: value,
            spellCheck: false,
            placeholder: placeholder === undefined ? '' : placeholder,
          }
          if (lockAlways === true) {
            /*
             * 身份字段永远锁住（id）：改 id 等于换一台机器人 —— 台账里的
             * `bot:<id>`、门禁、证据都指着旧的那个。要换就删掉重建。
             */
            inputProps.disabled = true
            inputProps.readOnly = true
            inputProps.title = 'id 是身份：改它等于换一台机器人。要换就删掉重建。'
          } else if (writer === true) inputProps.onChange = function (event) { onChange(event.target.value) }
          else {
            inputProps.disabled = true
            inputProps.readOnly = true
            inputProps.title = actor === '' ? 'actor 为空：host 会拒绝没有 actor 的写操作' : 'editable 里没有 bots，只能读'
          }
          return React.createElement('input', inputProps)
        }
        /** 本地下拉框：配置页那个 selectInput 是 TeamConfigPage 内部的，这里借不到。 */
        var botSelect = function (key, options, labels, value, onChange, disabled) {
          var list = options.slice()
          if (value !== '' && list.indexOf(value) < 0) list.unshift(value)
          var optionNodes = []
          for (var i = 0; i < list.length; i += 1) {
            var label = labels !== undefined && labels[list[i]] !== undefined ? labels[list[i]] : list[i]
            optionNodes.push(React.createElement('option', { value: list[i], key: 'o' + String(i) }, label))
          }
          var selectProps = { className: 'teamcfg-select', key: key, value: value, disabled: disabled === true }
          if (disabled !== true) selectProps.onChange = function (event) { onChange(event.target.value) }
          return React.createElement('select', selectProps, optionNodes)
        }
        var row = function (key, label, control, hint) {
          var children = [
            React.createElement('div', { className: 'teamcfg-label', key: 'l' }, label),
            React.createElement('div', { className: 'teamcfg-control', key: 'c' }, control),
          ]
          if (hint !== undefined && hint !== null && hint !== '') {
            children.push(React.createElement('div', { className: 'teamcfg-hint', key: 'h' }, hint))
          }
          return React.createElement('div', { className: 'teamcfg-field', key: key }, children)
        }
        var check = function (key, label, value, onToggle, hint) {
          var inputProps = { type: 'checkbox', key: 'c', checked: value === true, readOnly: writer !== true }
          if (writer === true) inputProps.onChange = function (event) { onToggle(event.target.checked) }
          return row(key, label, React.createElement('label', { className: 'teamcfg-check' }, React.createElement('input', inputProps), ' ' + (hint ?? '')), null)
        }
        var set = function (path) {
          return function (value) { props.onBotField(path, value) }
        }

        var nodes = []
        nodes.push(row('r-id', 'id', editable('id', asText(fields.id), set('id'), 'dev（[a-z][a-z0-9_-]*）', 'text', isNew !== true),
          isNew === true ? '身份：建好之后不能改（要换就删掉重建）' : '身份，不能改（它是台账里 bot:<id> 的那一半）'))
        nodes.push(row('r-name', '显示名', editable('displayName', asText(fields.displayName), set('displayName'), '开发机器人'),
          '群里 @ 它、卡片头显示的都是这个名字'))
        nodes.push(row('r-role', '角色 / 基准角色',
          React.createElement('div', { className: 'teamcfg-control' },
            botSelect('r-role-v', BOT_ROLE_VALUES, BOT_ROLE_TITLE, asText(fields.role), set('role'), writer !== true),
            botSelect('r-baserole-v', BOT_ROLE_VALUES, BOT_ROLE_TITLE, asText(fields.baseRole), set('baseRole'), writer !== true),
          ),
          '角色决定它归谁管（路由与优先级）；基准角色是它继承的权限与预设'))
        nodes.push(row('r-preset', 'agent 预设', editable('agentPreset', asText(fields.agentPreset), set('agentPreset'), '（空 = 按角色/全局兜底）'),
          '这台机器人作为哪个 DSH agent 跑；留空就用「配置」页那个只读表里的兜底'))
        nodes.push(row('r-model', '模型', editable('modelPrimary', asText(fields.modelPrimary), set('modelPrimary'), '（空 = 用部署默认）'),
          '只填模型名即可：provider 会用部署的默认值补齐'))
        nodes.push(row('r-app', '飞书应用', editable('appId', asText(fields.appId), set('appId'), 'cli_…'),
          '这台机器人自己的飞书应用：一个应用 = 一条长连接 = 一个身份。' +
            (knownAppsText === '' ? '' : '已知应用：' + knownAppsText + '。') +
            '两台机器人填同一个 app id，在群里就是同一张脸'))
        nodes.push(row('r-secret', '应用密钥（' + (targetApp === '' ? '还没有应用' : targetApp) + '）',
          React.createElement('input', {
            className: 'teamcfg-input',
            type: 'password',
            key: 'sec',
            value: asText(fields.appSecret),
            spellCheck: false,
            placeholder: secretSet === true ? '已设置，留空则不修改' : '未设置',
            disabled: writer !== true || targetApp === '',
            onChange: function (event) { props.onBotField('appSecret', event.target.value) },
          }),
          '密码框：留空就保持现在的值（POST 的 patch 里根本不会出现这个键）。写进 ' +
            (targetApp === '' ? '（先填上面的飞书应用）' : 'feishu.apps.' + targetApp + '.appSecret')))
        nodes.push(row('r-botopenid', '机器人 open_id（' + (targetApp === '' ? '还没有应用' : targetApp) + '）',
          editable('botOpenId', asText(fields.botOpenId), set('botOpenId'), 'ou_…（空 = 启动时自动探测）', 'text'),
          '飞书侧认出来的身份：判断「这条消息是不是在 @ 我」要用它；留空则由插件启动时探测'))
        nodes.push(row('r-chats', '所在群',
          React.createElement('textarea', {
            className: 'teamcfg-input teamcfg-textarea',
            key: 'chats',
            value: asText(fields.chatsText),
            spellCheck: false,
            rows: 3,
            placeholder: 'oc_…（一行一个）',
            disabled: writer !== true,
            onChange: function (event) { props.onBotField('chatsText', event.target.value) },
          }),
          '一行一个 chat_id；**留空 = 这个应用下的所有群**（不是"哪个群都不去"）'))
        nodes.push(check('r-onmention', '发言策略', fields.onMention === true, function (value) { props.onBotField('onMention', value) }, '被 @（或被点名）就回答'))
        nodes.push(check('r-onintent', '', fields.onIntent === true, function (value) { props.onBotField('onIntent', value) }, 'onIntent：没被 @ 但消息像它的活也回答（默认关）'))
        nodes.push(check('r-lease', '', fields.leaseRequired !== false, function (value) { props.onBotField('leaseRequired', value) }, 'leaseRequired：没被点名时先拿下这个群的发言租约（一个机器人一个应用时，同一条群消息会在每条连接上各到一次）'))
        nodes.push(check('r-digest', '', fields.digestOnly === true, function (value) { props.onBotField('digestOnly', value) }, 'digestOnly：只播报，不发卡片、不追问'))
        nodes.push(check('r-enabled', '启用', fields.enabled === true, function (value) { props.onBotField('enabled', value) }, '关掉就是不上线；配置问题不会因为关掉而消失'))

        return React.createElement('div', { className: 'teamled-panel', key: 'editor' },
          React.createElement('div', { className: 'teamled-row', key: 'h' },
            React.createElement('span', { className: 'teamled-panel-title', key: 't' },
              (isNew === true ? '新增机器人' : '编辑 ' + asText(draft.botId))),
            React.createElement('span', { className: 'teamcfg-spacer', key: 'sp' }),
            React.createElement('button', {
              className: 'teamled-btn teamled-btn-primary',
              type: 'button',
              key: 'save',
              disabled: writer !== true,
              title: 'POST ' + CONFIG_URL + '：整组提交 config.bots（需要时同一份 patch 里带上这个应用的密钥）',
              onClick: function () { props.onSaveBot() },
            }, busy === true ? '提交中…' : '保存这台机器人'),
            React.createElement('button', {
              className: 'teamled-btn',
              type: 'button',
              key: 'cancel',
              disabled: busy === true,
              onClick: function () { props.onCloseBot() },
            }, '取消'),
          ),
          React.createElement('div', { className: 'teamled-note', key: 'n' },
            '提交的是整组 config.bots（只改这一条）' + (isNew === true ? '，并在末尾加上这一条' : '') +
            '；写坏了 host 会在 problems 里逐条说明，一个字节都不落盘。'),
          nodes,
        )
      }

    /**
     * 「机器人」页。
     *
     * 一行为一个机器人：它是什么（id / 显示名 / 角色 / 基准角色）、它用哪个飞书
     * 应用、它在哪些群、配置上现在有什么问题、开没开。唯一的写操作是启停——
     * 它改的是 `config.bots`（整组提交），其余列全是只读。
     */
    function TeamBotsPage(props) {
      var payload = asObject(props.payload)
      var editable = asObject(props.editable) === null ? {} : props.editable
      var can = function (key) { return editable[key] === true }
      var actor = asText(props.actor).trim()
      var busy = props.busy === true

      var children = rosterStateNodes(props, '机器人名册')
      var notice = rosterNoticePanel(props.notice)
      if (notice !== null) children.push(notice)
      if (payload === null) return React.createElement('div', { className: 'teamroster', key: 'bots' }, children)

      /*
       * `null` 与 `[]` 必须分开：名册【没有返回】和名册【是空的】是两句不同的
       * 话，把前者画成「还没有配置任何机器人」就是在替 host 编一个它没说的结论。
       */
      var roster = asObject(payload.roster)
      var botsList = roster === null ? null : (Array.isArray(roster.bots) ? roster.bots : null)
      var bots = botsList === null ? [] : botsList
      var writable = can('bots') && actor !== '' && busy !== true

      children.push(React.createElement('div', { className: 'teamled-panel', key: 'head' },
        React.createElement('div', { className: 'teamled-row', key: 'h' },
          /* 没拿到名册时不报数字：「0 个」和「不知道有几个」不是一回事。 */
          React.createElement('span', { className: 'teamled-panel-title', key: 't' }, botsList === null ? '机器人' : '机器人（' + String(bots.length) + '）'),
          React.createElement('span', { className: 'teamcfg-spacer', key: 'sp' }),
          React.createElement('button', {
            className: 'teamled-btn',
            type: 'button',
            disabled: props.fetching === true || busy === true,
            title: '重新 GET ' + CONFIG_URL + '：名册与配置一起刷新',
            onClick: function () { props.onReload() },
          }, props.fetching === true ? '刷新中…' : '刷新名册'),
        ),
        React.createElement('div', { className: 'teamled-note', key: 'n' },
          '来源：GET ' + CONFIG_URL + ' 的 roster.bots（每一条是配置里的机器人 + 它解析出来的应用、所在群、配置问题、会话）。'),
        can('bots') !== true
          ? React.createElement('div', { className: 'teamled-note teamled-warn', key: 'ro' }, '接口的 editable 里没有 bots：这一页只能读。')
          : null,
        can('bots') === true && actor === ''
          ? React.createElement('div', { className: 'teamled-note teamled-warn', key: 'ao' }, 'actor 为空：启停按钮已禁用（host 不接受没有 actor 的写操作）。')
          : null,
      ))

      if (botsList === null) {
        children.push(React.createElement('div', { className: 'teamled-panel teamled-panel-warn', key: 'noroster' },
          React.createElement('div', { className: 'teamled-panel-title teamled-warn', key: 't' }, '接口没有返回 roster.bots'),
          React.createElement('div', { className: 'teamled-note', key: 'n' }, 'GET ' + CONFIG_URL + ' 的响应里没有 roster.bots（机器人名册数组）。这一页不猜：「没有名册」和「一个机器人都没配」不是一回事。'),
        ))
      } else if (bots.length === 0) {
        children.push(React.createElement('div', { className: 'teamled-panel', key: 'empty' },
          React.createElement('div', { className: 'teamled-note', key: 'n' }, '还没有配置任何机器人：在「配置」页的 bots 里加一条，或者飞书群里 @ 一下机器人看它认不认得出来。'),
        ))
      } else {
        var config = asObject(payload.config) === null ? {} : payload.config

        /*
         * 「启用了却上不了线」单独一块：这是开着机器人却没人应答时最先要看的
         * 答案，host 已经把原因写在每一条的 message 里，原文照排。
         */
        var offline = asArray(roster.offline)
        if (offline.length > 0) {
          var offlineNodes = [
            React.createElement('div', { className: 'teamled-panel-title teamled-warn', key: 't' },
              String(offline.length) + ' 个机器人启用了却上不了线'),
          ]
          for (var of = 0; of < offline.length; of += 1) {
            var entry = asObject(offline[of])
            offlineNodes.push(React.createElement('div', { className: 'teamled-msg teamled-warn', key: 'o' + String(of) },
              (entry === null ? String(offline[of]) : asText(entry.botId) + '：' + asText(entry.message))))
          }
          children.push(React.createElement('div', { className: 'teamled-panel teamled-panel-warn', key: 'offline' }, offlineNodes))
        }

        /*
         * 一行一个函数：`onClick` 里要按【这一行】的 id 与 enabled 发请求，
         * 用 for + var 会让所有行共用同一个变量（点哪一行都动最后一行）。
         */
        var botRow = function (bot) {
          var id = asText(bot.id)
          var feishu = asObject(bot.feishu) === null ? {} : bot.feishu
          var chats = readTextList(feishu.chats)
          var enabled = bot.enabled === true
          var inConfig = findById(config.bots, id)
          var toggleTitle = 'POST ' + CONFIG_URL + '：把 config.bots 里这一条的 enabled 取反（整组提交）'
          if (can('bots') !== true) toggleTitle = 'editable 里没有 bots，只能读'
          else if (actor === '') toggleTitle = 'actor 为空：写操作已禁用'
          else if (inConfig === null) toggleTitle = 'config.bots 里找不到这一条（id 对不上），改不了'
          /*
           * 状态：启停 + （host 给了的话）长连接通不通。后者回答的是「明明开着
           * 为什么它不说话」——connected 不是配置，只在这里显示。
           */
          var status = [
            React.createElement('span', { className: 'teamled-tag' + (enabled ? ' teamled-tag-ok' : ''), key: 's' }, enabled ? '已启用' : '已停用'),
          ]
          if (enabled === true && typeof feishu.connected === 'boolean') {
            status.push(React.createElement('span', {
              className: 'teamled-tag' + (feishu.connected === true ? ' teamled-tag-ok' : ' teamled-tag-err'),
              key: 'c',
            }, feishu.connected === true ? '已连接' : '未连接'))
          }
          return [
            React.createElement('span', { className: 'teamled-id', key: 'id' }, id === '' ? '（没有 id）' : id),
            asText(bot.displayName) === '' ? React.createElement('span', { className: 'teamroster-td-mute', key: 'n' }, '（没有显示名）') : asText(bot.displayName),
            asText(bot.role),
            asText(bot.baseRole),
            asText(bot.appIdResolved) === ''
              ? React.createElement('span', { className: 'teamroster-td-mute', key: 'a' }, '（没绑定应用）')
              : React.createElement('span', { className: 'teamled-id', key: 'a' }, asText(bot.appIdResolved)),
            chats.length === 0 ? '全部群' : chats.join('、'),
            rosterProblems(bot.problems),
            React.createElement('div', { className: 'teamled-row', key: 's' }, status),
            React.createElement('div', { className: 'teamled-row', key: 'op' },
              React.createElement('button', {
                className: 'teamled-btn',
                type: 'button',
                key: 'edit',
                disabled: inConfig === null,
                title: inConfig === null
                  ? 'config.bots 里找不到这一条（id 对不上）'
                  : 'POST ' + CONFIG_URL + ' 的整组提交前，先在这里改这一台机器人的字段',
                onClick: function () { props.onEditBot(id) },
              }, '编辑'),
              React.createElement('button', {
                className: 'teamled-btn',
                type: 'button',
                key: 'toggle',
                disabled: writable !== true || inConfig === null,
                title: toggleTitle,
                onClick: function () { props.onToggleBot(id, enabled !== true) },
              }, busy === true ? '提交中…' : (enabled ? '停用' : '启用')),
              React.createElement('button', {
                className: 'teamled-btn',
                type: 'button',
                key: 'del',
                disabled: writable !== true || inConfig === null,
                title: 'POST ' + CONFIG_URL + '：把这一条从 config.bots 里删掉（整组提交；host 会留 .bak 备份与审计行）',
                onClick: function () { props.onRemoveBot(id) },
              }, '删除'),
            ),
          ]
        }
        var rows = []
        for (var i = 0; i < bots.length; i += 1) {
          var bot = asObject(bots[i])
          rows.push(bot === null ? [String(bots[i]), '', '', '', '', '', '', '', ''] : botRow(bot))
        }
        children.push(rosterTable('table', ['id', '显示名', '角色', '基准角色', '飞书应用', '所在群', '配置问题', '状态', '操作'], rows))
        children.push(React.createElement('div', { className: 'teamled-row', key: 'addrow' },
          React.createElement('button', {
            className: 'teamled-btn',
            type: 'button',
            key: 'add',
            disabled: can('bots') !== true || actor === '' || busy === true,
            title: can('bots') !== true ? 'editable 里没有 bots，只能读' : '新增一台机器人（整组提交 config.bots）',
            onClick: function () { props.onAddBot() },
          }, '+ 新增机器人'),
          React.createElement('span', { className: 'teamled-note', key: 'hint' },
            '每台机器人一行：身份、角色、它的飞书应用与密钥、它服务的群、它什么时候开口，都在「编辑」里改。'),
        ))
        children.push(React.createElement('div', { className: 'teamled-note', key: 'foot' },
          '「所在群」为空 = 这个机器人在所有群里都应答（chats 是空数组）。启停只改 enabled，别的字段一个字都不动。'))
        var draft = asObject(props.botDraft)
        if (draft !== null) children.push(renderBotEditor(props, draft))
      }

      return React.createElement('div', { className: 'teamroster', key: 'bots' }, children)
    }

    /**
     * 「成员」页。
     *
     * 成员名册（`config.members`，成员对象数组）加上飞书侧的 open_id 绑定：
     * 一个成员绑上 open_id 之后，这个人在群里说话才算在他头上（host 会顺便
     * 派生出 senders 映射，见返回里的 derived.sendersAdded）。
     */
    function TeamMembersPage(props) {
      var payload = asObject(props.payload)
      var editable = asObject(props.editable) === null ? {} : props.editable
      var can = function (key) { return editable[key] === true }
      var actor = asText(props.actor).trim()
      var busy = props.busy === true
      var drafts = asObject(props.drafts) === null ? {} : props.drafts

      var children = rosterStateNodes(props, '成员名册')
      var notice = rosterNoticePanel(props.notice)
      if (notice !== null) children.push(notice)
      if (payload === null) return React.createElement('div', { className: 'teamroster', key: 'members' }, children)

      var config = asObject(payload.config) === null ? {} : payload.config
      var roster = asObject(payload.roster)
      var membersList = roster === null ? null : (Array.isArray(roster.members) ? roster.members : null)
      var members = membersList === null ? [] : membersList
      var replaceable = can('members') === true && Array.isArray(config.members) === true

      children.push(React.createElement('div', { className: 'teamled-panel', key: 'head' },
        React.createElement('div', { className: 'teamled-row', key: 'h' },
          /* 没拿到名册时不报数字：「0 个」和「不知道有几个」不是一回事。 */
          React.createElement('span', { className: 'teamled-panel-title', key: 't' }, membersList === null ? '成员' : '成员（' + String(members.length) + '）'),
          React.createElement('span', { className: 'teamcfg-spacer', key: 'sp' }),
          React.createElement('button', {
            className: 'teamled-btn',
            type: 'button',
            disabled: props.fetching === true || busy === true,
            title: '重新 GET ' + CONFIG_URL + '：名册与配置一起刷新',
            onClick: function () { props.onReload() },
          }, props.fetching === true ? '刷新中…' : '刷新名册'),
        ),
        React.createElement('div', { className: 'teamled-note', key: 'n' },
          '来源：GET ' + CONFIG_URL + ' 的 roster.members（config.members 的每一项 + 它自己的配置问题）。改一个 openId 就是整组提交一次 config.members。'),
        replaceable !== true
          ? React.createElement('div', { className: 'teamled-note teamled-warn', key: 'ro' },
            can('members') !== true
              ? '接口的 editable 里没有 members：这一页只能读（成员域在「配置」页改）。'
              : '接口返回的 config.members 不是数组：拿不到要提交的整组，绑定改不了。')
          : null,
        replaceable === true && actor === ''
          ? React.createElement('div', { className: 'teamled-note teamled-warn', key: 'ao' }, 'actor 为空：绑定按钮已禁用（host 不接受没有 actor 的写操作）。')
          : null,
      ))

      if (membersList === null) {
        children.push(React.createElement('div', { className: 'teamled-panel teamled-panel-warn', key: 'noroster' },
          React.createElement('div', { className: 'teamled-panel-title teamled-warn', key: 't' }, '接口没有返回 roster.members'),
          React.createElement('div', { className: 'teamled-note', key: 'n' }, 'GET ' + CONFIG_URL + ' 的响应里没有 roster.members（成员名册数组）。这一页不猜：「没有名册」和「一个成员都没有」不是一回事。'),
        ))
      } else if (members.length === 0) {
        children.push(React.createElement('div', { className: 'teamled-panel', key: 'empty' },
          React.createElement('div', { className: 'teamled-note', key: 'n' }, '还没有任何成员：在「配置」页的成员域（domains）里写上 human:<名字>，或者直接建一个成员。'),
        ))
      } else {
        /*
         * 一行一个函数：输入框的 onChange 与保存按钮的 onClick 都要绑住
         * 【这一行】的 key，for + var 会让它们共用最后一个成员。
         */
        var memberRow = function (member) {
          var key = asText(member.key)
          var stored = asText(member.openId)
          var draft = Object.prototype.hasOwnProperty.call(drafts, key) ? asText(drafts[key]) : stored
          var changed = draft !== stored
          var inputProps = {
            className: 'teamroster-openid',
            type: 'text',
            key: 'o',
            value: draft,
            spellCheck: false,
            placeholder: 'ou_…（这个人的飞书 open_id）',
            title: replaceable === true
              ? '改完点右边的「保存 openId」：整组 config.members 一起提交'
              : 'editable 里没有 members 或 config.members 不是数组：只能读',
          }
          if (replaceable === true) inputProps.onChange = function (event) { props.onMemberDraft(key, event.target.value) }
          else {
            inputProps.disabled = true
            inputProps.readOnly = true
          }
          var saveProps = {
            className: 'teamled-btn',
            type: 'button',
            key: 'op',
            disabled: replaceable !== true || busy === true || actor === '' || changed !== true,
            title: changed !== true
              ? 'openId 没有改动'
              : 'POST ' + CONFIG_URL + '：把这一条成员的 openId 改成输入框里的值（整组提交 config.members）',
            onClick: function () { props.onSaveMember(key) },
          }
          return [
            React.createElement('span', { className: 'teamled-id', key: 'k' }, key === '' ? '（没有 key）' : key),
            asText(member.name),
            asText(member.role),
            readTextList(member.domains).join('、'),
            readTextList(member.projects).join('、'),
            React.createElement('div', { className: 'teamcfg-control', key: 'o' }, React.createElement('input', inputProps)),
            rosterProblems(member.problems),
            React.createElement('div', { className: 'teamled-row', key: 'op' },
              React.createElement('button', saveProps, busy === true ? '提交中…' : '保存 openId'),
              changed === true ? React.createElement('span', { className: 'teamled-warn', key: 'd' }, '有未提交的改动') : null,
            ),
          ]
        }
        var rows = []
        for (var i = 0; i < members.length; i += 1) {
          var member = asObject(members[i])
          rows.push(member === null ? [String(members[i]), '', '', '', '', '', '', ''] : memberRow(member))
        }
        children.push(rosterTable('table', ['成员（key）', '名字', '角色', '域', '项目', 'openId（飞书）', '配置问题', '操作'], rows))
      }

      /*
       * 没归属的 sender 映射：senders 里有这个 open_id，但它指的那个人不在成员
       * 名册里（人删了，或者键名写错了）。host 只报告、不自动删——手写的映射
       * 可能是有意的（比如故意把某个人留在表外），删掉会静默地把他锁在外面。
       */
      var senders = roster === null ? null : asObject(roster.senders)
      var unbound = senders === null ? [] : asArray(senders.unbound)
      var senderNodes = [
        React.createElement('div', { className: 'teamled-row', key: 'h' },
          React.createElement('span', { className: 'teamled-panel-title', key: 't' }, '没归属的发送者映射（roster.senders.unbound，' + String(unbound.length) + '）'),
        ),
        React.createElement('div', { className: 'teamled-note', key: 'n' },
          '这些是 senders 里【已经存在】的映射，但它们指向的 principal 现在不在成员名册里：要么这个人被删了，要么键名写错了。' +
          'host 只报告、不自动清理（手写的映射可能是有意的），要不要改由你定：把这个人加回成员域，或者在「配置」页的 senders 表里改掉它。' +
          '把某个成员的 openId 绑好之后，返回的 derived.sendersAdded 会告诉你是谁被补上的。'),
      ]
      if (senders === null) {
        senderNodes.push(React.createElement('div', { className: 'teamled-note', key: 'none' }, '接口没有返回 roster.senders，所以这一块暂时是空的。'))
      } else if (unbound.length === 0) {
        senderNodes.push(React.createElement('div', { className: 'teamled-note', key: 'none' }, '没有没归属的映射：senders 里的每个 principal 都在成员名册里。'))
      } else {
        var senderRows = []
        for (var u = 0; u < unbound.length; u += 1) {
          var sender = asObject(unbound[u])
          if (sender === null) {
            senderRows.push([String(unbound[u]), '', ''])
            continue
          }
          senderRows.push([
            React.createElement('span', { className: 'teamled-id', key: 'o' }, asText(sender.openId)),
            asText(sender.principal) === '' ? React.createElement('span', { className: 'teamroster-td-mute', key: 'p' }, '（没有 principal）') : asText(sender.principal),
            sender.principalKnown === true
              ? '配置里有这个身份'
              : (sender.principalKnown === false ? '配置里没有这个身份' : '（host 没说）'),
          ])
        }
        senderNodes.push(rosterTable('unbound', ['open_id', 'principal', 'principalKnown'], senderRows))
      }
      children.push(React.createElement('div', { className: 'teamled-panel', key: 'senders' }, senderNodes))

      return React.createElement('div', { className: 'teamroster', key: 'members' }, children)
    }

    /**
     * 「会话」页。
     *
     * 每个机器人一行一行的会话记录：它在哪个群、说过多少轮、最后一次活跃/回复
     * 是什么时候、会话和工作区落在哪里。按机器人分组，组标题是显示名。
     */
    /**
     * 一行「群 → 主机器人」。
     *
     * 改主是**显式动作**（也许多数时候你都不会点它）：下拉选好 → 点「改主」。
     * actor 为空时按钮禁用并说明原因 —— host 不接受没有 actor 的写操作。
     */
    function renderChatRow(props, chat, bots, config) {
      if (chat === null) return ['']
      var chatId = asText(chat.id)
      var primaryId = asText(chat.primaryBotId)
      var primaryName = asText(chat.primaryBotName)
      var title = asText(chat.title)
      var candidates = asArray(bots)
      if (candidates.length === 0) candidates = asArray(config.bots)
      var options = []
      for (var i = 0; i < candidates.length; i += 1) {
        var bot = asObject(candidates[i])
        if (bot === null) continue
        var id = asText(bot.id)
        if (id === '') continue
        options.push(React.createElement('option', { value: id, key: 'o' + String(i) },
          asText(bot.displayName) === '' ? id : asText(bot.displayName) + '（' + id + '）'))
      }
      var selectProps = {
        className: 'teamcfg-select',
        key: 'pick',
        value: primaryId,
        disabled: props.busy === true || asText(props.actor).trim() === '' || options.length === 0,
        onChange: function (event) { props.onPickPrimary(chatId, event.target.value) },
      }
      var buttonProps = {
        className: 'teamled-btn',
        type: 'button',
        key: 'go',
        disabled: props.busy === true || asText(props.actor).trim() === '' || asText(props.pickedPrimary[chatId] ?? '').trim() === '' || asText(props.pickedPrimary[chatId] ?? '') === primaryId,
        title: asText(props.actor).trim() === ''
          ? 'actor 为空：改主是写操作，host 会拒绝'
          : 'POST ' + LEDGER_URL + ' {action:"set_primary_bot"}：把 (chat).primary_bot_id 换成选中的机器人',
        onClick: function () { props.onSetPrimary(chatId, asText(props.pickedPrimary[chatId] ?? '')) },
      }
      return [
        React.createElement('div', { key: 'c' },
          React.createElement('div', { className: 'teamled-title' }, title === '' ? '（这个群没有标题）' : title),
          React.createElement('div', { className: 'teamled-id' }, chatId),
        ),
        primaryId === ''
          ? React.createElement('span', { className: 'teamroster-td-mute', key: 'p' }, '（还没有主：群里还没有消息）')
          : React.createElement('div', { key: 'p' },
            React.createElement('div', {}, primaryName === '' ? primaryId : primaryName),
            React.createElement('div', { className: 'teamled-id' }, primaryId +
              (nonEmptyString(chat.primarySince) ? ' · 定于 ' + stamp(chat.primarySince) : '')),
          ),
        String(asNumber(chat.messages, 0)) + ' / ' + String(asNumber(chat.turns, 0)),
        (nonEmptyString(chat.lastSeen) ? stamp(chat.lastSeen) : '—') +
          (nonEmptyString(chat.lastInbound) ? ' · ' + asText(chat.lastInbound) : ''),
        React.createElement('div', { className: 'teamled-row', key: 'a' },
          React.createElement('select', selectProps, options),
          React.createElement('button', buttonProps, '改主'),
        ),
      ]
    }

    function TeamSessionsPage(props) {
      var payload = asObject(props.payload)
      var children = rosterStateNodes(props, '会话列表')
      /*
       * 这一页上也有写操作（「改主机器人」），所以成功/失败提示必须画出来 ——
       * 少了这一句，改主之后界面看着"什么也没发生"（提示设了但没人渲染）。
       */
      var notice = rosterNoticePanel(props.notice)
      if (notice !== null) children.push(notice)
      if (payload === null) return React.createElement('div', { className: 'teamroster', key: 'sessions' }, children)

      /* `null` 与 `[]` 分开：没返回会话 ≠ 没有会话（见 TeamBotsPage 的说明）。 */
      var sessionsList = Array.isArray(payload.sessions) ? payload.sessions : null
      var sessions = sessionsList === null ? [] : sessionsList
      var roster = asObject(payload.roster)
      var bots = roster === null ? [] : asArray(roster.bots)
      var config = asObject(payload.config) === null ? {} : payload.config

      children.push(React.createElement('div', { className: 'teamled-panel', key: 'head' },
        React.createElement('div', { className: 'teamled-row', key: 'h' },
          React.createElement('span', { className: 'teamled-panel-title', key: 't' }, sessionsList === null ? '机器人会话' : '机器人会话（' + String(sessions.length) + '）'),
          React.createElement('span', { className: 'teamcfg-spacer', key: 'sp' }),
          React.createElement('button', {
            className: 'teamled-btn',
            type: 'button',
            disabled: props.fetching === true,
            title: '重新 GET ' + CONFIG_URL + '：会话与配置一起刷新',
            onClick: function () { props.onReload() },
          }, props.fetching === true ? '刷新中…' : '刷新'),
        ),
        React.createElement('div', { className: 'teamled-note', key: 'n' },
          '来源：GET ' + CONFIG_URL + ' 的 sessions（每个机器人 × 每个群一条会话）。这些会话同时也是工作区里的会话文件，所以在这里看到的就是 GUI 侧栏里那些。'),
      ))

      if (sessionsList === null) {
        children.push(React.createElement('div', { className: 'teamled-panel teamled-panel-warn', key: 'nosessions' },
          React.createElement('div', { className: 'teamled-panel-title teamled-warn', key: 't' }, '接口没有返回 sessions'),
          React.createElement('div', { className: 'teamled-note', key: 'n' }, 'GET ' + CONFIG_URL + ' 的响应里没有 sessions（会话列表数组）。这一页不猜：「没有返回」和「一条会话都没有」不是一回事。'),
        ))
        return React.createElement('div', { className: 'teamroster', key: 'sessions' }, children)
      }

      if (sessions.length === 0) {
        children.push(React.createElement('div', { className: 'teamled-panel', key: 'empty' },
          React.createElement('div', { className: 'teamled-msg teamled-info', key: 'm' }, '还没有任何机器人会话：在群里 @ 一下机器人就会有第一条'),
        ))
        return React.createElement('div', { className: 'teamroster', key: 'sessions' }, children)
      }

      /*
       * 先画「群 → 主机器人」：用户的要求是**每个群有一个主的机器人，而且主机器人
       * 负责这个群所有消息的记录**。所以这一段的每一行回答三件事：
       * 这个群归谁、它记了多少条、什么时候定的主。
       */
      var chatsList = Array.isArray(payload.chats) ? payload.chats : null
      if (chatsList !== null && chatsList.length > 0) {
        var chatRows = []
        for (var ci = 0; ci < chatsList.length; ci += 1) {
          chatRows.push(renderChatRow(props, asObject(chatsList[ci]), bots, config))
        }
        children.push(React.createElement('div', { className: 'teamled-panel', key: 'chats' },
          React.createElement('div', { className: 'teamled-row', key: 'h' },
            React.createElement('span', { className: 'teamled-panel-title', key: 't' }, '群与主机器人（' + String(chatsList.length) + '）'),
            React.createElement('span', { className: 'teamcfg-spacer', key: 'sp' }),
            React.createElement('span', { className: 'teamled-note', key: 'n' }, '主机器人负责这个群**所有**消息的记录'),
          ),
          React.createElement('div', { className: 'teamled-note', key: 'n2' },
            '「记了多少条」是主机器人名下的消息数（含它没有回答的那些）；「轮次」是它真正回答过的轮数 —— 这两个数字本来就该对不上。'),
          rosterTable('chats', ['群', '主机器人', '消息 / 轮次', '上次活动', '改主'], chatRows),
        ))
      } else if (chatsList === null) {
        children.push(React.createElement('div', { className: 'teamled-panel teamled-panel-warn', key: 'nochats' },
          React.createElement('div', { className: 'teamled-panel-title teamled-warn', key: 't' }, '接口没有返回 chats'),
          React.createElement('div', { className: 'teamled-note', key: 'n' }, 'GET ' + CONFIG_URL + ' 的响应里没有 chats（群列表）。这一页不猜：「没有返回」和「一个群都没有」不是一回事。'),
        ))
      }

      /* 按 botId 分组，顺序按第一次出现的顺序（host 给的顺序照搬，不重排）。 */
      var groups = []
      var indexByBot = {}
      for (var i = 0; i < sessions.length; i += 1) {
        var entry = asObject(sessions[i])
        if (entry === null) continue
        var botId = asText(entry.botId)
        var group = Object.prototype.hasOwnProperty.call(indexByBot, botId) ? groups[indexByBot[botId]] : null
        if (group === null) {
          var known = findById(bots, botId)
          if (known === null) known = findById(config.bots, botId)
          var display = known === null ? '' : asText(known.displayName)
          group = { botId: botId, name: display === '' ? botId : display, items: [] }
          indexByBot[botId] = groups.length
          groups.push(group)
        }
        group.items.push(entry)
      }

      for (var g = 0; g < groups.length; g += 1) {
        var current = groups[g]
        var cards = []
        for (var s = 0; s < current.items.length; s += 1) {
          var session = current.items[s]
          var chatId = asText(session.chatId)
          var title = asText(session.title)
          var head = [
            React.createElement('span', { className: 'teamled-title', key: 't' }, title === '' ? '（这个群没有标题）' : title),
            chatId === '' ? null : React.createElement('span', { className: 'teamled-id', key: 'c' }, chatId),
            /* chatType 只有 host 认得的两种值：p2p（私聊）与 group（群） */
            nonEmptyString(session.chatType)
              ? React.createElement('span', { className: 'teamled-tag', key: 't2' }, asText(session.chatType) === 'p2p' ? '私聊' : '群')
              : null,
            React.createElement('span', { className: 'teamled-tag', key: 'n' }, '轮次 ' + String(asNumber(session.turns, 0))),
          ]
          if (nonEmptyString(session.lastSeen)) head.push(React.createElement('span', { className: 'teamled-tag', key: 'ls' }, '上次活跃 ' + stamp(session.lastSeen)))
          if (nonEmptyString(session.lastReplyAt)) head.push(React.createElement('span', { className: 'teamled-tag', key: 'lr' }, '上次回复 ' + stamp(session.lastReplyAt)))
          var meta = []
          if (nonEmptyString(session.sessionId)) meta.push('session ' + asText(session.sessionId))
          if (nonEmptyString(session.workspace)) meta.push('workspace ' + asText(session.workspace))
          cards.push(React.createElement('div', { className: 'teamroster-sess', key: 's' + String(s) },
            React.createElement('div', { className: 'teamroster-sesshead', key: 'h' }, head),
            meta.length === 0 ? null : React.createElement('div', { className: 'teamled-meta', key: 'm' }, meta.join(' · ')),
          ))
        }
        children.push(React.createElement('div', { className: 'teamled-panel', key: 'g' + String(g) },
          React.createElement('div', { className: 'teamled-row', key: 'h' },
            React.createElement('span', { className: 'teamled-panel-title', key: 't' }, current.name),
            React.createElement('span', { className: 'teamled-note', key: 'n' }, current.botId === current.name ? '（名册里没有这个 botId）' : current.botId),
            React.createElement('span', { className: 'teamcfg-spacer', key: 'sp' }),
            React.createElement('span', { className: 'teamled-note', key: 'c' }, String(current.items.length) + ' 个群'),
          ),
          React.createElement('div', { className: 'teamroster-group', key: 'cards' }, cards),
        ))
      }

      return React.createElement('div', { className: 'teamroster', key: 'sessions' }, children)
    }

    function TeamLedger() {
      var state = React.useState({
        /* loading | ready | error —— data 到手就是 ready，出错才落到 error */
        phase: 'loading',
        data: null,
        error: null,
        fetching: true,
        actor: '',
        actorTouched: false,
        busy: '',
        busyLabel: '',
        busySince: 0,
        tickSeq: 0,
        notice: null,
        openReq: null,
        focus: null,
        focusSeq: 0,
        tick: null,
        /*
         * 配置页 + 三个名册页（机器人 / 成员 / 会话）。与台账那一份数据完全
         * 分开：切到这四个页签里的任何一个才去 GET /api/team/config，所以台账
         * 页的第一次取数、以及它的每一条断言都不受这里影响。
         */
        tab: 'ledger',
        configPhase: 'idle',
        configData: null,
        configError: null,
        configFetching: false,
        configElapsed: 0,
        configFields: null,
        configRows: null,
        configDirty: null,
        configBusy: false,
        configNotice: null,
        /* 名册页的写操作：一次一件（busy 非空时按钮全禁用） */
        rosterBusy: '',
        rosterNotice: null,
        /* 「成员」页上还没提交的 openId（key → 输入框里的值） */
        memberDrafts: null,
        /*
         * 「机器人」页的编辑器：一次只编辑一台（`botDraft` 为 null = 没打开）。
         * 草稿留在 TeamLedger 里，因为三个名册页都是被当普通函数调用的纯渲染，
         * 不能持有 hook 状态（切页不卸载，表单一半的内容才不会丢）。
         */
        botDraft: null,
        /* 「会话」页里每个群选中的主机器人（还没提交）。 */
        pickedPrimary: {},
      })
      var current = state[0]
      var setState = state[1]

      /* 给事件回调读最新忙碌状态用（visibilitychange 的监听只装一次）。 */
      var busyRef = React.useRef(false)
      busyRef.current = current.busy !== ''

      var patch = function (fields) {
        setState(function (previous) { return Object.assign({}, previous, fields) })
      }

      var actorValue = function () {
        return asText(current.actor).trim()
      }

      var applySnapshot = function (snapshot, elapsed) {
        setState(function (previous) {
          var next = Object.assign({}, previous, {
            phase: 'ready',
            data: snapshot,
            error: null,
            fetching: false,
            elapsed: elapsed === undefined ? previous.elapsed : elapsed,
          })
          /* 用户没动过 actor 就跟着配置走；动过就绝不覆盖。 */
          if (previous.actorTouched !== true) next.actor = deriveActor(snapshot)
          return next
        })
      }

      /**
       * GET 一次台账。
       *
       * 已经有数据时刷新失败**不清空界面**：保留旧快照，用一条 warn 说明刷新
       * 失败。没有数据时失败才落到 error 相位，并且给出重试按钮——任何一条
       * 路径都会离开“读取中…”。
       */
      var load = function (options) {
        var settings = asObject(options)
        var isRetry = settings !== null && settings.retry === true
        setState(function (previous) {
          return Object.assign({}, previous, {
            fetching: true,
            error: null,
            phase: previous.data === null ? 'loading' : previous.phase,
          })
        })
        callApi('GET', undefined, GET_TIMEOUT_MS).then(function (outcome) {
          var payload = outcome.payload
          var failure = null
          if (outcome.error !== null) failure = outcome.error
          else if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) failure = 'HTTP ' + String(outcome.status) + ' 的响应不是 JSON'
          else if (payload.ok !== true) failure = nonEmptyString(payload.message) ? payload.message : '接口返回了意外的结果'

          if (failure !== null) {
            setState(function (previous) {
              var hasData = previous.data !== null
              return Object.assign({}, previous, {
                fetching: false,
                phase: hasData ? previous.phase : 'error',
                error: failure,
                notice: hasData
                  ? {
                    kind: 'warn',
                    title: '刷新失败（仍在显示上一次的快照）',
                    message: (isRetry === true ? '重试仍然失败：' : '') + failure,
                    pending: [],
                    code: '',
                    report: null,
                    elapsed: outcome.elapsed,
                  }
                  : previous.notice,
              })
            })
            return
          }

          setState(function (previous) {
            var next = Object.assign({}, previous, {
              phase: 'ready',
              data: payload,
              error: null,
              fetching: false,
              elapsed: outcome.elapsed,
            })
            if (previous.actorTouched !== true) next.actor = deriveActor(payload)
            return next
          })
        })
      }

      React.useEffect(function () {
        load({})
      }, [])

      /*
       * main 面板是按 key 保留挂载的（layout 的 retainMainPanels），切走再切
       * 回来不会重新取数。所以回到这个标签页时静默刷新一次；正在跑动作时不碰，
       * 免得把用户刚点出来的东西盖掉。
       */
      React.useEffect(function () {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined
        var onVisibility = function () {
          if (typeof document.visibilityState === 'string' && document.visibilityState !== 'visible') return
          if (busyRef.current === true) return
          load({})
        }
        document.addEventListener('visibilitychange', onVisibility)
        return function () {
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [])

      /* 忙碌时每秒重绘一次，让「已 N 秒」真的在走：长动作不能看起来像卡死。 */
      React.useEffect(function () {
        if (current.busy === '' || typeof setInterval !== 'function') return undefined
        var handle = setInterval(function () {
          setState(function (previous) {
            return previous.busy === '' ? previous : Object.assign({}, previous, { tickSeq: previous.tickSeq + 1 })
          })
        }, 1000)
        return function () {
          clearInterval(handle)
        }
      }, [current.busy])

      /* 需求里点某个任务 id：把那一行滚进视野并高亮。 */
      React.useEffect(function () {
        if (current.focus === null) return undefined
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return undefined
        var id = asText(current.focus).replace(/["\\]/g, '')
        if (id === '') return undefined
        var node = document.querySelector('[data-team-task="' + id + '"]')
        if (node === null) return undefined
        if (typeof node.scrollIntoView === 'function') {
          try {
            node.scrollIntoView({ block: 'center' })
          } catch (error) {
            node.scrollIntoView()
          }
        }
        return undefined
      }, [current.focus, current.focusSeq])

      var noticeError = function (title, message, code, elapsed) {
        patch({
          busy: '',
          busyLabel: '',
          notice: {
            kind: 'err',
            title: title,
            message: message,
            pending: [],
            code: code === undefined ? '' : code,
            report: null,
            elapsed: elapsed === undefined ? 0 : elapsed,
          },
        })
      }

      /**
       * 发一个动作。
       *
       * `payload` 里带的键会盖到 body 上（id / evidence / dry_run / note…）。
       * 成功后优先用响应里带回来的 `snapshot` 直接刷新（省一次 GET），
       * 没有就重新 GET。失败时**一个字都不改**地把 message / pending / code
       * 摆出来：状态机的拒绝必须能被看见。
       */
      var runAction = function (label, action, payload) {
        var actor = actorValue()
        if (actor === '') {
          noticeError(
            '需要 actor',
            '写操作必须说明是谁在点：host 会以「这个界面以浏览器身份登录，不代表某个人」为由拒绝没有 actor 的调用。',
            'bad_request',
          )
          return
        }
        var body = { action: action, actor: actor }
        var extra = asObject(payload)
        if (extra !== null) {
          var keys = Object.keys(extra)
          for (var i = 0; i < keys.length; i += 1) body[keys[i]] = extra[keys[i]]
        }
        patch({
          busy: action + ':' + asText(body.id),
          busyLabel: label,
          busySince: Date.now(),
          notice: null,
        })
        callApi('POST', body, 0).then(function (outcome) {
          var result = outcome.payload
          if (outcome.error !== null) {
            noticeError(label + ' · 请求失败', outcome.error, '', outcome.elapsed)
            return
          }
          if (result === null || typeof result !== 'object' || Array.isArray(result)) {
            noticeError(label + ' · 响应异常', 'HTTP ' + String(outcome.status) + ' 的响应不是 JSON', '', outcome.elapsed)
            return
          }

          if (result.ok !== true) {
            var pending = []
            var raw = asArray(result.pending)
            for (var p = 0; p < raw.length; p += 1) {
              if (nonEmptyString(raw[p])) pending.push(raw[p])
            }
            patch({
              busy: '',
              busyLabel: '',
              notice: {
                kind: 'err',
                title: label + ' 被拒：' + action,
                message: nonEmptyString(result.message) ? result.message : '（host 没有给出 message）',
                pending: pending,
                code: asText(result.code),
                report: null,
                elapsed: outcome.elapsed,
              },
            })
            return
          }

          var lines = []
          if (nonEmptyString(result.what)) lines.push(result.what)
          var bits = []
          if (nonEmptyString(result.id)) bits.push(result.id)
          if (nonEmptyString(result.state)) bits.push('状态 ' + result.state)
          if (nonEmptyString(result.gates)) bits.push(result.gates)
          if (bits.length > 0) lines.push(bits.join(' · '))
          var lease = asObject(result.lease)
          if (lease !== null) lines.push('租约：' + asText(lease.holder) + ' · 到期 ' + stamp(lease.expires_at))
          if (nonEmptyString(result.session_id)) lines.push('会话：' + result.session_id)
          if (result.timedOut === true) lines.push('注意：这一轮是超时结束的，任务留在 in_progress')
          lines.push('用时 ' + String(asNumber(outcome.elapsed, 0)) + ' ms')

          patch({
            busy: '',
            busyLabel: '',
            notice: {
              kind: 'ok',
              title: label + ' 完成：' + action,
              message: lines.join('\n'),
              pending: [],
              code: '',
              report: nonEmptyString(result.report) ? result.report : null,
              elapsed: asNumber(outcome.elapsed, 0),
            },
          })

          if (action === 'tick') {
            var decided = []
            var items = asArray(result.decided)
            for (var d = 0; d < items.length; d += 1) decided.push(describeDecision(items[d]))
            patch({
              tick: {
                dryRun: result.dry_run === true,
                gates: asNumber(result.gates, 0),
                leases: asNumber(result.leases, 0),
                decided: decided,
              },
            })
          }

          var snapshot = asObject(result.snapshot)
          if (snapshot !== null) applySnapshot(snapshot, asNumber(outcome.elapsed, 0))
          else load({})
        })
      }

      /* ---------------- 配置页：取数、表单、保存 ---------------- */

      /**
       * 重建表单：服务端的值 + 用户已经改过（dirty）的那些字段。
       *
       * 这样「重新自检」只刷新没被动过的输入框，不会把用户填了一半的内容抹掉；
       * 而服务端在别处改过的值又能立刻反映出来。`clearEdits` 为 true（保存成功
       * 之后）就是完全按服务端返回的 config 重建。
       */
      var rebuildConfigForm = function (previous, config, clearEdits) {
        var built = buildConfigForm(config)
        var fields = built.fields
        var rows = built.rows
        var dirty = clearEdits === true || asObject(previous.configDirty) === null ? {} : previous.configDirty
        if (clearEdits !== true) {
          var previousFields = asObject(previous.configFields)
          if (previousFields !== null) {
            var keys = Object.keys(previousFields)
            for (var i = 0; i < keys.length; i += 1) {
              if (dirty[keys[i]] === true) fields[keys[i]] = previousFields[keys[i]]
            }
          }
          var previousRows = asObject(previous.configRows)
          if (previousRows !== null) {
            if (dirty[KV_SENDERS] === true && previousRows.senders !== undefined) rows.senders = previousRows.senders
            if (dirty[KV_CHAT_ACTORS] === true && previousRows.chatActors !== undefined) rows.chatActors = previousRows.chatActors
          }
        }
        return { fields: fields, rows: rows, dirty: dirty }
      }

      /**
       * 一次成功的 GET / POST 结果 → 配置页状态（config / diagnostics 都换新）。
       *
       * `payload.config` 不是一个对象时**不重建表单**：那说明这一次响应没有
       * 给出配置（畸形或半截的数据），此时把输入框清空才是真的丢东西。自检
       * 结果、相位照样更新，只是用户眼前的表单保持原样。
       */
      var applyConfigPayload = function (previous, payload, elapsed, clearEdits) {
        var config = asObject(payload) === null ? null : asObject(payload.config)
        var next = Object.assign({}, previous, {
          configPhase: 'ready',
          configData: payload,
          configError: null,
          configFetching: false,
          configBusy: false,
          configElapsed: elapsed,
        })
        if (config !== null) {
          var rebuilt = rebuildConfigForm(previous, config, clearEdits === true)
          next.configFields = rebuilt.fields
          next.configRows = rebuilt.rows
          next.configDirty = rebuilt.dirty
        }
        return next
      }

      /**
       * GET 一次配置（也就是「接入自检」）。
       *
       * 与台账的 load 同一套规矩：已经有数据时刷新失败不清空界面，只挂一条
       * warn；没有数据时才落到 error 相位并给重试按钮。
       */
      var loadConfig = function (options) {
        var settings = asObject(options)
        var isRetry = settings !== null && settings.retry === true
        setState(function (previous) {
          return Object.assign({}, previous, {
            configFetching: true,
            configError: null,
            configPhase: previous.configData === null ? 'loading' : previous.configPhase,
          })
        })
        callApiTo(CONFIG_URL, 'GET', undefined, GET_TIMEOUT_MS).then(function (outcome) {
          var payload = outcome.payload
          var failure = null
          if (outcome.error !== null) failure = outcome.error
          else if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) failure = 'HTTP ' + String(outcome.status) + ' 的响应不是 JSON'
          else if (payload.ok !== true) failure = nonEmptyString(payload.message) ? payload.message : '接口返回了意外的结果'

          if (failure !== null) {
            setState(function (previous) {
              var hasData = previous.configData !== null
              return Object.assign({}, previous, {
                configFetching: false,
                configPhase: hasData ? previous.configPhase : 'error',
                configError: failure,
                configNotice: hasData
                  ? {
                    kind: 'warn',
                    title: (isRetry === true ? '重新自检失败' : '自检失败') + '（仍在显示上一次的结果）',
                    message: failure,
                    problems: [],
                    code: '',
                    elapsed: outcome.elapsed,
                  }
                  : previous.configNotice,
              })
            })
            return
          }

          setState(function (previous) { return applyConfigPayload(previous, payload, outcome.elapsed, false) })
        })
      }

      /* 表单编辑：标量 / 列表 / 下拉 / 勾选都是同一个入口。 */
      var setConfigField = function (path, value) {
        setState(function (previous) {
          var fields = asObject(previous.configFields) === null ? {} : previous.configFields
          var dirty = asObject(previous.configDirty) === null ? {} : previous.configDirty
          var nextFields = Object.assign({}, fields)
          var nextDirty = Object.assign({}, dirty)
          nextFields[path] = value
          nextDirty[path] = true
          return Object.assign({}, previous, { configFields: nextFields, configDirty: nextDirty })
        })
      }

      /* 键值表：格子、加行、删行。整张表记成一条脏标记。 */
      var setConfigRow = function (table, index, side, value) {
        setState(function (previous) {
          var rows = asObject(previous.configRows) === null ? {} : previous.configRows
          var dirty = asObject(previous.configDirty) === null ? {} : previous.configDirty
          var nextRows = Object.assign({}, rows)
          var list = asArray(nextRows[table]).slice()
          var row = asObject(list[index])
          var copy = { k: row === null ? '' : asText(row.k), v: row === null ? '' : asText(row.v) }
          copy[side] = value
          list[index] = copy
          nextRows[table] = list
          var nextDirty = Object.assign({}, dirty)
          nextDirty[table === KV_CHAT_ACTORS ? KV_CHAT_ACTORS : KV_SENDERS] = true
          return Object.assign({}, previous, { configRows: nextRows, configDirty: nextDirty })
        })
      }

      var addConfigRow = function (table) {
        setState(function (previous) {
          var rows = asObject(previous.configRows) === null ? {} : previous.configRows
          var dirty = asObject(previous.configDirty) === null ? {} : previous.configDirty
          var nextRows = Object.assign({}, rows)
          var list = asArray(nextRows[table]).slice()
          list.push({ k: '', v: '' })
          nextRows[table] = list
          var nextDirty = Object.assign({}, dirty)
          nextDirty[table === KV_CHAT_ACTORS ? KV_CHAT_ACTORS : KV_SENDERS] = true
          return Object.assign({}, previous, { configRows: nextRows, configDirty: nextDirty })
        })
      }

      var removeConfigRow = function (table, index) {
        setState(function (previous) {
          var rows = asObject(previous.configRows) === null ? {} : previous.configRows
          var dirty = asObject(previous.configDirty) === null ? {} : previous.configDirty
          var nextRows = Object.assign({}, rows)
          var list = asArray(nextRows[table]).slice()
          list.splice(index, 1)
          if (list.length === 0) list.push({ k: '', v: '' })
          nextRows[table] = list
          var nextDirty = Object.assign({}, dirty)
          nextDirty[table === KV_CHAT_ACTORS ? KV_CHAT_ACTORS : KV_SENDERS] = true
          return Object.assign({}, previous, { configRows: nextRows, configDirty: nextDirty })
        })
      }

      var configNotice = function (notice) {
        setState(function (previous) {
          return Object.assign({}, previous, { configBusy: false, configNotice: notice })
        })
      }

      /**
       * 保存。
       *
       * 三道前置检查各自说清楚：没有 actor、还没读到配置、表单本地就不合法。
       * 本地不合法时**不发请求**——半保存比不保存更难查。真正的校验仍然在
       * host：它返回的 `ok:false` / `problems` 一律原文摆出来，一个字不改。
       */
      var saveConfig = function () {
        var actor = actorValue()
        if (actor === '') {
          configNotice({
            kind: 'err',
            title: '需要 actor',
            message: '改配置同样要说清是谁在改：host 会以「需要 actor：谁在改配置必须写清楚」为由拒绝没有 actor 的调用。',
            problems: [],
            code: 'bad_request',
            elapsed: 0,
          })
          return
        }
        var payload = asObject(current.configData)
        var original = payload === null ? null : asObject(payload.config)
        if (original === null) {
          configNotice({
            kind: 'err',
            title: '还没有读到配置',
            message: '先点「重新自检」把配置读回来，再保存。',
            problems: [],
            code: '',
            elapsed: 0,
          })
          return
        }

        var built = buildConfigPatch(
          original,
          asObject(current.configFields) === null ? {} : current.configFields,
          asObject(current.configRows) === null ? {} : current.configRows,
          editableSet(payload),
        )
        if (built.problems.length > 0) {
          configNotice({
            kind: 'err',
            title: '本地校验没通过，没有发出请求',
            message: '下面每条都是表单里的问题，改好再保存。服务端的问题清单要等请求发出去才会回来。',
            problems: built.problems,
            code: 'local_validation',
            elapsed: 0,
          })
          return
        }
        if (built.changed.length === 0) {
          configNotice({
            kind: 'warn',
            title: '没有改动',
            message: '表单和已经读到的配置一致，所以没有发出请求。',
            problems: [],
            code: '',
            elapsed: 0,
          })
          return
        }

        patch({ configBusy: true, configNotice: null })
        callApiTo(CONFIG_URL, 'POST', { patch: built.patch, actor: actor }, 0).then(function (outcome) {
          var result = outcome.payload
          if (outcome.error !== null) {
            configNotice({ kind: 'err', title: '保存 · 请求失败', message: outcome.error, problems: [], code: '', elapsed: outcome.elapsed })
            return
          }
          if (result === null || typeof result !== 'object' || Array.isArray(result)) {
            configNotice({ kind: 'err', title: '保存 · 响应异常', message: 'HTTP ' + String(outcome.status) + ' 的响应不是 JSON', problems: [], code: '', elapsed: outcome.elapsed })
            return
          }

          if (result.ok !== true) {
            var problems = readProblems(result.problems)
            var returnedConfig = asObject(result.config)
            setState(function (previous) {
              var next = Object.assign({}, previous, {
                configBusy: false,
                configNotice: {
                  kind: 'err',
                  title: '保存被拒' + (nonEmptyString(result.code) ? '（' + result.code + '）' : ''),
                  message: nonEmptyString(result.message)
                    ? result.message
                    : (problems.length > 0 ? 'host 用 problems 说明了原因，逐条列在下面。' : '（host 既没有给出 message，也没有给出 problems）'),
                  problems: problems,
                  code: asText(result.code),
                  elapsed: asNumber(outcome.elapsed, 0),
                },
              })
              /* 校验失败时 host 会把【没改动的旧 config】带回来：刷基线，用户的输入留着 */
              if (returnedConfig !== null) {
                var base = asObject(previous.configData) === null ? {} : previous.configData
                next.configData = Object.assign({}, base, { config: returnedConfig })
                var rebuilt = rebuildConfigForm(previous, returnedConfig, false)
                next.configFields = rebuilt.fields
                next.configRows = rebuilt.rows
                next.configDirty = rebuilt.dirty
              }
              return next
            })
            return
          }

          var applied = readTextList(result.applied)
          setState(function (previous) {
            var base = asObject(previous.configData) === null ? {} : previous.configData
            var merged = Object.assign({}, base)
            if (asObject(result.config) !== null) merged.config = result.config
            if (asObject(result.diagnostics) !== null) merged.diagnostics = result.diagnostics
            var next = applyConfigPayload(previous, merged, asNumber(outcome.elapsed, 0), true)
            next.configNotice = {
              kind: 'ok',
              title: '已保存：' + (applied.length === 0 ? '（host 没有给出 applied 列表）' : applied.join('、')),
              message: '接口返回的 config / diagnostics 已经用来刷新这一页。',
              /* 保存成功也可能带 problems（比如“能存但有点可疑”）——照样原样列出 */
              problems: readProblems(result.problems),
              code: '',
              elapsed: asNumber(outcome.elapsed, 0),
            }
            return next
          })
        })
      }

      /* ---------------- 名册页的写操作（启停机器人 / 绑定 openId） ---------------- */

      /** 名册页一次写操作的结果：与配置页同一个通知形状。 */
      var rosterNotice = function (notice) {
        setState(function (previous) {
          return Object.assign({}, previous, { rosterBusy: '', rosterNotice: notice })
        })
      }

      /**
       * 名册页的保存。
       *
       * 与 saveConfig 同一条规矩：没有 actor 就不发请求（half 保存比不保存更难
       * 查）；真正能不能写由 host 说了算，它的 `ok:false` / `problems` / `code`
       * 一律原文摆出来。成功时用返回的 config / diagnostics / roster / sessions
       * 刷新这一页，并清掉成员页上还没提交的草稿——界面回到 host 的值。
       */
      var saveRosterPatch = function (nextPatch, label) {
        var actor = actorValue()
        if (actor === '') {
          rosterNotice({
            kind: 'err',
            title: '需要 actor',
            message: 'host 会拒绝没有 actor 的写操作（它不代表某个人）。先在「配置」页的保存条或台账页填上「谁在点」，再回来改。',
            problems: [],
            code: 'bad_request',
            elapsed: 0,
          })
          return
        }
        patch({ rosterBusy: label, rosterNotice: null })
        callApiTo(CONFIG_URL, 'POST', { patch: nextPatch, actor: actor }, 0).then(function (outcome) {
          var result = outcome.payload
          var failure = null
          if (outcome.error !== null) failure = outcome.error
          else if (result === null || typeof result !== 'object' || Array.isArray(result)) failure = 'HTTP ' + String(outcome.status) + ' 的响应不是 JSON'
          if (failure !== null) {
            rosterNotice({ kind: 'err', title: label + ' · 请求失败', message: failure, problems: [], code: '', elapsed: outcome.elapsed })
            return
          }

          if (result.ok !== true) {
            var refusedProblems = readProblems(result.problems)
            setState(function (previous) {
              var next = Object.assign({}, previous, {
                rosterBusy: '',
                rosterNotice: {
                  kind: 'err',
                  title: label + ' 被拒' + (nonEmptyString(result.code) ? '（' + result.code + '）' : ''),
                  message: nonEmptyString(result.message)
                    ? result.message
                    : (refusedProblems.length > 0 ? 'host 用 problems 说明了原因，逐条列在下面。' : '（host 既没有给出 message，也没有给出 problems）'),
                  problems: refusedProblems,
                  code: asText(result.code),
                  elapsed: asNumber(outcome.elapsed, 0),
                },
              })
              /* 校验失败时 host 带回【没改动的旧 config】：刷基线，草稿留着让用户改 */
              if (asObject(result.config) !== null) {
                var base = asObject(previous.configData) === null ? {} : previous.configData
                next.configData = Object.assign({}, base, { config: result.config })
                var rebuilt = rebuildConfigForm(previous, result.config, false)
                next.configFields = rebuilt.fields
                next.configRows = rebuilt.rows
                next.configDirty = rebuilt.dirty
              }
              return next
            })
            return
          }

          var applied = readTextList(result.applied)
          var derived = asObject(result.derived)
          var sendersAdded = derived === null ? [] : asArray(derived.sendersAdded)
          var addedText = []
          for (var a = 0; a < sendersAdded.length; a += 1) {
            var added = asObject(sendersAdded[a])
            if (added === null) continue
            addedText.push(asText(added.openId) + ' → ' + asText(added.principal))
          }
          setState(function (previous) {
            var base = asObject(previous.configData) === null ? {} : previous.configData
            var merged = Object.assign({}, base)
            if (asObject(result.config) !== null) merged.config = result.config
            if (asObject(result.diagnostics) !== null) merged.diagnostics = result.diagnostics
            if (asObject(result.roster) !== null) merged.roster = result.roster
            if (Array.isArray(result.sessions)) merged.sessions = result.sessions
            if (Array.isArray(result.problems)) merged.problems = result.problems
            var next = applyConfigPayload(previous, merged, asNumber(outcome.elapsed, 0), false)
            next.rosterBusy = ''
            next.memberDrafts = null
            next.rosterNotice = {
              kind: 'ok',
              title: label + '：已保存' + (applied.length === 0 ? '' : '（applied: ' + applied.join('、') + '）'),
              message: addedText.length === 0
                ? '接口返回的 config / roster 已经用来刷新这一页。'
                : '接口返回的 config / roster 已经用来刷新这一页。顺便派生了 senders：' + addedText.join('、'),
              problems: readProblems(result.problems),
              code: '',
              elapsed: asNumber(outcome.elapsed, 0),
            }
            return next
          })
        })
      }

      /**
       * 「机器人」页：启停一个机器人。
       *
       * 只动 `enabled` 一个键，但按【整组】提交 `config.bots`：无论 host 是整体
       * 替换还是深合并，同一组里别的键都不会被悄悄抹掉。
       */
      var toggleBot = function (botId, enabled) {
        var payload = asObject(current.configData)
        var original = payload === null ? null : asObject(payload.config)
        var bots = original === null ? [] : asArray(original.bots)
        if (bots.length === 0) {
          rosterNotice({
            kind: 'err',
            title: '没有拿到 config.bots',
            message: '接口返回的 config 里没有 bots 数组，拿不到要提交的整组。点「刷新名册」重新读一次。',
            problems: [],
            code: '',
            elapsed: 0,
          })
          return
        }
        var nextBots = []
        var found = false
        for (var i = 0; i < bots.length; i += 1) {
          var bot = asObject(bots[i])
          if (bot === null) { nextBots.push(bots[i]); continue }
          if (asText(bot.id) === botId) {
            found = true
            nextBots.push(Object.assign({}, bot, { enabled: enabled === true }))
          } else {
            nextBots.push(bot)
          }
        }
        if (found !== true) {
          rosterNotice({
            kind: 'err',
            title: 'config.bots 里没有 ' + botId,
            message: '名册里的这一条在 config.bots 里找不到同 id 的条目（id 对不上），所以没有可提交的东西。',
            problems: [],
            code: '',
            elapsed: 0,
          })
          return
        }
        saveRosterPatch({ bots: nextBots }, (enabled === true ? '启用 ' : '停用 ') + botId)
      }

      /** 「成员」页：改一个成员的 openId 草稿（还没提交）。 */
      var setMemberDraft = function (memberKey, value) {
        setState(function (previous) {
          var drafts = asObject(previous.memberDrafts) === null ? {} : previous.memberDrafts
          var next = Object.assign({}, drafts)
          next[memberKey] = value
          return Object.assign({}, previous, { memberDrafts: next })
        })
      }

      /**
       * 「成员」页：整组提交 `config.members`，只改这一条的 `openId`。
       *
       * 一个成员绑上 open_id，这个人在群里说话才算在他头上；host 会顺便把它
       * 写进 senders 映射，并在 `derived.sendersAdded` 里报出来（下面照原文显示）。
       */
      var saveMemberOpenId = function (memberKey) {
        var payload = asObject(current.configData)
        var original = payload === null ? null : asObject(payload.config)
        var members = original === null || Array.isArray(original.members) !== true ? null : original.members
        if (members === null) {
          rosterNotice({
            kind: 'err',
            title: '没有拿到 config.members',
            message: '接口返回的 config.members 不是数组，拿不到要提交的整组。点「刷新名册」重新读一次。',
            problems: [],
            code: '',
            elapsed: 0,
          })
          return
        }
        var drafts = asObject(current.memberDrafts) === null ? {} : current.memberDrafts
        if (Object.prototype.hasOwnProperty.call(drafts, memberKey) !== true) {
          rosterNotice({
            kind: 'warn',
            title: '没有改动',
            message: '这一条成员的 openId 没有改过，所以没有发出请求。',
            problems: [],
            code: '',
            elapsed: 0,
          })
          return
        }
        var value = asText(drafts[memberKey]).trim()
        var nextMembers = []
        var found = false
        for (var i = 0; i < members.length; i += 1) {
          var member = asObject(members[i])
          if (member === null) { nextMembers.push(members[i]); continue }
          if (asText(member.key) === memberKey) {
            found = true
            nextMembers.push(Object.assign({}, member, { openId: value }))
          } else {
            nextMembers.push(member)
          }
        }
        if (found !== true) {
          rosterNotice({
            kind: 'err',
            title: 'config.members 里没有 ' + memberKey,
            message: '名册里的这一条在 config.members 里找不到同 key 的条目（key 对不上），所以没有可提交的东西。',
            problems: [],
            code: '',
            elapsed: 0,
          })
          return
        }
        saveRosterPatch({ members: nextMembers }, memberKey + ' 的 openId')
      }

      /* ------------------------------------------------------------------ *
       * 「机器人」页的编辑器：草稿、取值、整组提交
       * ------------------------------------------------------------------ */

      /** 一台机器人的初始形状（新增时用）。 */
      var emptyBotRow = function () {
        return {
          id: '', displayName: '', role: 'dev', baseRole: 'dev', enabled: false,
          feishu: { appId: '', chats: [], speakPolicy: { onMention: true, onIntent: false, leaseRequired: true, digestOnly: false } },
        }
      }

      var botRowToDraft = function (row, isNew) {
        var feishu = asObject(row.feishu) === null ? {} : row.feishu
        var policy = asObject(feishu.speakPolicy) === null ? {} : feishu.speakPolicy
        var model = asObject(row.model) === null ? {} : row.model
        return {
          botId: asText(row.id),
          isNew: isNew === true,
          fields: {
            id: asText(row.id),
            displayName: asText(row.displayName),
            role: asText(row.role) === '' ? 'dev' : asText(row.role),
            baseRole: asText(row.baseRole) === '' ? (asText(row.role) === '' ? 'dev' : asText(row.role)) : asText(row.baseRole),
            agentPreset: asText(row.agentPreset),
            modelPrimary: asText(model.primary),
            appId: asText(feishu.appId),
            chatsText: readTextList(feishu.chats).join('\n'),
            onMention: policy.onMention !== false,
            onIntent: policy.onIntent === true,
            leaseRequired: policy.leaseRequired !== false,
            digestOnly: policy.digestOnly === true,
            enabled: row.enabled === true,
            /*
             * 密钥永远从空开始：浏览器从来没拿到过它，留空 = 不修改。
             * 它和 botOpenId 都放在 fields 里 —— setBotField 只写 fields，
             * 另开一处放就会变成"输入了但提交时是空的"这种静默丢值。
             */
            appSecret: '',
            botOpenId: '',
          },
        }
      }

      var openBotEditor = function (botId) {
        var payload = asObject(current.configData)
        var config = payload === null ? null : asObject(payload.config)
        var rows = config === null ? null : config.bots
        if (Array.isArray(rows) !== true) {
          rosterNotice({
            kind: 'err',
            title: '没有拿到 config.bots',
            message: '接口返回的 config.bots 不是数组，拿不到要编辑的那一条。点「刷新名册」重新读一次。',
            problems: [], code: '', elapsed: 0,
          })
          return
        }
        var row = findById(rows, botId)
        if (row === null) {
          rosterNotice({
            kind: 'err',
            title: 'config.bots 里没有 ' + botId,
            message: '名册里的这一条在 config.bots 里找不到同 id 的条目，所以没有可编辑的对象。',
            problems: [], code: '', elapsed: 0,
          })
          return
        }
        patch({ botDraft: botRowToDraft(row, false) })
      }

      var addBot = function () {
        patch({ botDraft: botRowToDraft(emptyBotRow(), true) })
      }

      var setBotField = function (path, value) {
        setState(function (previous) {
          var draft = asObject(previous.botDraft)
          if (draft === null) return previous
          var fields = Object.assign({}, asObject(draft.fields) === null ? {} : draft.fields)
          fields[path] = value
          return Object.assign({}, previous, { botDraft: Object.assign({}, draft, { fields: fields }) })
        })
      }

      /**
       * 整组提交 `config.bots`，需要时在同一份 patch 里带上这个应用的密钥。
       *
       * 密钥写在哪，取决于这台机器人用的是哪个应用，而且**只有一个家**：
       * 永远是它自己的那个应用：`feishu.apps.<appId>.{appSecret, botOpenId}`
       * 两个框都留空就一个字节都不发（留空 = 不修改，和密码框的语义一致）。
       */
      var saveBotDraft = function () {
        var payload = asObject(current.configData)
        var config = payload === null ? null : asObject(payload.config)
        var rows = config === null ? null : config.bots
        var draft = asObject(current.botDraft)
        if (Array.isArray(rows) !== true || draft === null) return
        var fields = asObject(draft.fields) === null ? {} : draft.fields
        var isNew = draft.isNew === true
        var id = asText(fields.id).trim()
        var defaultAppId = defaultAppIdOf(config)

        var problems = []
        if (/^[a-z][a-z0-9_-]{0,31}$/.test(id) !== true) {
          problems.push({ path: 'bots.id', message: '机器人 id 要形如 [a-z][a-z0-9_-]*（最长 32 位）：没有 id 就没法路由、@ 或修复' })
        }
        if (isNew !== true && id !== asText(draft.botId)) {
          problems.push({ path: 'bots.id', message: 'id 是身份，不能改（改 id 等于换一台机器人）。要改就删掉重建。' })
        }
        if (isNew === true && findById(rows, id) !== null) {
          problems.push({ path: 'bots.id', message: '已经有一台机器人叫 ' + id + ' 了' })
        }
        var appId = asText(fields.appId).trim()
        if (appId !== '' && /^cli_[A-Za-z0-9]+$/.test(appId) !== true) {
          problems.push({ path: 'bots.feishu.appId', message: '飞书 app id 形如 cli_xxx（这台机器人自己的应用）' })
        }
        var chatLines = asText(fields.chatsText).split('\n')
        var chats = []
        for (var c = 0; c < chatLines.length; c += 1) {
          var line = chatLines[c].trim()
          if (line === '') continue
          if (/^oc_/.test(line) !== true) {
            problems.push({ path: 'bots.feishu.chats', message: '群 id 形如 oc_xxx，这一行不是：' + line })
            continue
          }
          chats.push(line)
        }
        var targetApp = appId === '' ? defaultAppId : appId
        var secret = asText(fields.appSecret)
        var openId = asText(fields.botOpenId).trim()
        if (appId !== '' && appId !== defaultAppId && secret === '' && knownAppIds(payload).indexOf(appId) < 0) {
          problems.push({
            path: 'bots.feishu.appId',
            message: '应用 ' + appId + ' 还没有 appSecret：在下面「应用密钥」里填一个，否则这台机器人上不了线',
          })
        }
        if (problems.length > 0) {
          rosterNotice({
            kind: 'err',
            title: '还没提交：本地就能看出问题',
            message: '下面这些不是 host 说的，是面板在发请求之前就看出来的。',
            problems: problems, code: '', elapsed: 0,
          })
          return
        }

        var row = isNew === true ? emptyBotRow() : Object.assign({}, findById(rows, draft.botId))
        row.id = id
        row.displayName = asText(fields.displayName)
        row.role = asText(fields.role)
        row.baseRole = asText(fields.baseRole)
        row.agentPreset = asText(fields.agentPreset) === '' ? null : asText(fields.agentPreset)
        row.model = Object.assign({}, asObject(row.model) === null ? {} : row.model, {
          primary: asText(fields.modelPrimary) === '' ? null : asText(fields.modelPrimary),
        })
        row.feishu = Object.assign({}, asObject(row.feishu) === null ? {} : row.feishu, {
          appId: appId,
          chats: chats,
          speakPolicy: {
            onMention: fields.onMention !== false,
            onIntent: fields.onIntent === true,
            leaseRequired: fields.leaseRequired !== false,
            digestOnly: fields.digestOnly === true,
          },
        })
        row.enabled = fields.enabled === true

        var nextBots = []
        var replaced = false
        for (var i = 0; i < rows.length; i += 1) {
          var existing = asObject(rows[i])
          if (isNew !== true && existing !== null && asText(existing.id) === asText(draft.botId)) {
            nextBots.push(row)
            replaced = true
          } else {
            nextBots.push(rows[i])
          }
        }
        if (isNew === true || replaced !== true) nextBots.push(row)

        var nextPatch = { bots: nextBots }
        if ((secret !== '' || openId !== '') && targetApp !== '') {
          /*
           * ONE HOME PER CREDENTIAL, AND IT IS THE APP'S OWN ENTRY. The editor no longer
           * asks "is this the default app?" — a bot names its app, so the secret always
           * lands on that app: `feishu.apps.<appId>.appSecret`. The installation-level
           * `feishu.appSecret` stays readable (an existing value keeps working and is
           * preferred only when the app entry has none — see feishu/apps.js), but the
           * console stops writing it, so the two cannot drift.
           */
          var entry = {}
          if (secret !== '') entry.appSecret = secret
          if (openId !== '') entry.botOpenId = openId
          var appsPatch = {}
          appsPatch[targetApp] = entry
          nextPatch.feishu = { apps: appsPatch }
        }
        saveRosterPatch(nextPatch, (isNew === true ? '新增 ' : '保存 ') + id)
      }

      /**
       * 删掉一台机器人：整组提交，把这一条从 config.bots 里去掉。
       *
       * 不做"确认弹窗"那一套：这是一次可回滚的配置写入（host 每次保存都留 `.bak-`
       * 备份与审计行），不是删数据。列表里少一条，比多点一次确认更容易被发现。
       */
      var removeBot = function (botId) {
        var payload = asObject(current.configData)
        var config = payload === null ? null : asObject(payload.config)
        var rows = config === null ? null : config.bots
        if (Array.isArray(rows) !== true) return
        var nextBots = []
        var found = false
        for (var i = 0; i < rows.length; i += 1) {
          var row = asObject(rows[i])
          if (row !== null && asText(row.id) === botId) { found = true; continue }
          nextBots.push(rows[i])
        }
        if (found !== true) return
        patch({ botDraft: null })
        saveRosterPatch({ bots: nextBots }, '删除 ' + botId)
      }

      /**
       * 改一个群的**主机器人**（群里所有消息的记录归属）。
       *
       * 走**台账路由的动作**（`{action:'set_primary_bot'}`）而不是配置写入：
       * 群是运行态对象，不是配置文件里的字段 —— 写进 config.json 会让"这个群归谁"
       * 变成一个需要重启才生效、而且和实际群记录对不上的东西。
       */
      var setPrimaryBot = function (chatId, botId) {
        var actor = actorValue()
        if (actor === '') {
          rosterNotice({
            kind: 'err',
            title: '需要 actor',
            message: 'host 会拒绝没有 actor 的写操作。先在「配置」页的保存条或台账页填上「谁在点」。',
            problems: [], code: 'bad_request', elapsed: 0,
          })
          return
        }
        patch({ rosterBusy: '改主机器人' })
        callApiTo(LEDGER_URL, 'POST', { action: 'set_primary_bot', id: chatId, assignee: 'bot:' + botId, actor: actor }, 0).then(function (outcome) {
          var result = outcome.payload
          var failure = null
          if (outcome.error !== null) failure = outcome.error
          else if (result === null || typeof result !== 'object' || Array.isArray(result)) failure = 'HTTP ' + String(outcome.status) + ' 的响应不是 JSON'
          if (failure !== null) {
            rosterNotice({ kind: 'err', title: '改主机器人 · 请求失败', message: failure, problems: [], code: '', elapsed: outcome.elapsed })
            return
          }
          if (result.ok !== true) {
            rosterNotice({
              kind: 'err',
              title: '改主机器人被拒' + (nonEmptyString(result.code) ? '（' + asText(result.code) + '）' : ''),
              message: nonEmptyString(result.message) ? asText(result.message) : '（host 没有给出 message）',
              problems: readProblems(result.problems), code: asText(result.code), elapsed: outcome.elapsed,
            })
            return
          }
          /*
           * 就地更新那一行，而不是再拉一次配置：`loadConfig` 会把这条成功提示冲掉
           * （它按"这一页是新数据"的路径重建状态），而这里的信息已经足够了 ——
           * host 用 `ok:true` 确认了写入，返回里的 `what` 是它自己的原话。
           * 下一次「刷新名册」自然会对齐 host 的真实状态。
           */
          setState(function (previous) {
            var data = Object.assign({}, asObject(previous.configData) ?? {})
            var rows = asArray(data.chats)
            var next = []
            for (var i = 0; i < rows.length; i += 1) {
              var row = asObject(rows[i])
              if (row === null || asText(row.id) !== chatId) { next.push(rows[i]); continue }
              var known = findById(asArray(data.bots), botId)
              if (known === null) {
                var roster = asObject(data.roster)
                known = roster === null ? null : findById(asArray(roster.bots), botId)
              }
              next.push(Object.assign({}, row, {
                previousPrimaryBotId: asText(row.primaryBotId) === '' ? null : asText(row.primaryBotId),
                primaryBotId: botId,
                primaryBotName: known === null ? botId : asText(known.displayName),
                primarySince: new Date().toISOString(),
              }))
            }
            data.chats = next
            return Object.assign({}, previous, {
              configData: data,
              rosterBusy: '',
              rosterNotice: {
                kind: 'ok',
                title: '改主机器人：已保存',
                message: asText(result.what) + ' —— 之后这个群的消息都记在它名下（旧的记录不会被改写）。',
                problems: [], code: '', elapsed: outcome.elapsed,
              },
            })
          })
        })
      }

      /* 第一次切到「配置」或某个名册页才取数：台账页在挂载时仍然只有那一次 GET。 */
      React.useEffect(function () {
        if (current.tab === 'ledger') return undefined
        if (current.configPhase !== 'idle') return undefined
        loadConfig({})
        return undefined
      }, [current.tab, current.configPhase])

      /* ---------------- 渲染 ---------------- */

      var children = []
      var data = asObject(current.data)
      var config = data === null ? null : asObject(data.config)
      var counts = data === null ? null : asObject(data.counts)
      var requirements = data === null ? [] : asArray(data.requirements)
      var tasks = data === null ? [] : asArray(data.tasks)
      var runs = data === null ? [] : asArray(data.runs)
      var isBusy = current.busy !== ''
      var canWrite = actorValue() !== ''
      var busySeconds = Math.max(0, Math.floor((Date.now() - asNumber(current.busySince, Date.now())) / 1000))

      /* 任务/会话按 id 建索引，供需求卡片和任务卡片互查。 */
      var tasksById = {}
      var runsByTask = {}
      var i
      for (i = 0; i < tasks.length; i += 1) {
        var taskItem = asObject(tasks[i])
        if (taskItem !== null && nonEmptyString(taskItem.id)) tasksById[taskItem.id] = taskItem
      }
      for (i = 0; i < runs.length; i += 1) {
        var runItem = asObject(runs[i])
        if (runItem !== null && nonEmptyString(runItem.task)) runsByTask[runItem.task] = runItem
      }

      /* 顶部：标题 + 刷新 + 扫超时（预演） */
      var headRight = []
      headRight.push(React.createElement('button', {
        className: 'teamled-btn',
        type: 'button',
        key: 'refresh',
        disabled: current.fetching === true || isBusy,
        onClick: function () { load({ retry: true }) },
      }, current.fetching === true ? '读取中…' : '刷新'))
      headRight.push(React.createElement('button', {
        className: 'teamled-btn',
        type: 'button',
        key: 'tick',
        title: 'tick 默认就是预演：只报告到期的门禁与租约，不改变任何对象',
        disabled: isBusy || canWrite !== true,
        onClick: function () { runAction('扫超时（预演）', 'tick', { dry_run: true }) },
      }, isBusy && current.busy.indexOf('tick') === 0 ? '扫描中…' : '扫超时（预演）'))

      /*
       * 顶部：标题 + 刷新 + 扫超时（预演）。
       *
       * 这是两个页签共用的“面板头”，所以从 children 里提出来单独存一份；
       * 台账正文的其余部分（忙碌 / 加载 / 出错 / 两列）顺序一个字没动。
       */
      var headNode = React.createElement('div', { className: 'teamled-head', key: 'head' },
        React.createElement('div', { key: 'left' },
          React.createElement('div', { className: 'teamled-h1', key: 'h1' }, '团队台账'),
          React.createElement('div', { className: 'teamled-sub', key: 'sub' },
            '需求 → 任务 → 两道人工门禁 → 真实 DSH 会话执行一轮。写操作都要 actor；状态机的拒绝会原样显示。'),
        ),
        /* 台账的那两个按钮只在台账页出现：它们的忙碌面板与回执都画在台账正文里，
           在配置页点它们会“什么都没发生”。配置页有自己的「重新自检」和「保存」。 */
        React.createElement('div', { className: 'teamled-row', key: 'right' }, current.tab === 'config' ? [] : headRight),
      )

      if (isBusy) {
        children.push(React.createElement('div', { className: 'teamled-panel teamled-panel-warn', key: 'busy' },
          React.createElement('div', { className: 'teamled-panel-title teamled-warn' },
            (current.busyLabel === '' ? current.busy : current.busyLabel) + ' 进行中…（已 ' + String(busySeconds) + ' 秒）'),
          React.createElement('div', { className: 'teamled-note' },
            '执行一轮要交给一个真实会话跑完一整轮，可能几分钟；这一栏会在结束时变成结果。'),
        ))
      }

      if (current.phase === 'loading') {
        children.push(React.createElement('div', { className: 'teamled-panel', key: 'loading' },
          React.createElement('div', { className: 'teamled-msg teamled-info' }, '读取台账中…'),
          React.createElement('div', { className: 'teamled-note' }, '读取 ' + LEDGER_URL + '（同源，带 GUI 的浏览器 cookie）；超过 ' + String(Math.round(GET_TIMEOUT_MS / 1000)) + ' 秒没有响应会报超时，不会一直停在这一行。'),
        ))
      }

      if (current.phase === 'error') {
        children.push(React.createElement('div', { className: 'teamled-panel teamled-panel-err', key: 'error' },
          React.createElement('div', { className: 'teamled-msg teamled-err', key: 'm' }, '读取失败：' + asText(current.error)),
          React.createElement('div', { className: 'teamled-note', key: 'n' }, '接口：' + LEDGER_URL + '（GET）。如果插件行没有挂载，或者 connection 服务不可用，这条路由就不存在。'),
          React.createElement('div', { className: 'teamled-row', key: 'a' },
            React.createElement('button', {
              className: 'teamled-btn',
              type: 'button',
              disabled: current.fetching === true,
              onClick: function () { load({ retry: true }) },
            }, current.fetching === true ? '重试中…' : '重试'),
          ),
        ))
      }

      if (data !== null) {
        /* 配置摘要 + 统计 */
        var barChildren = []
        barChildren.push(React.createElement('span', { className: 'teamled-meta', key: 'actor-label' }, 'actor（谁在点）'))
        barChildren.push(React.createElement('input', {
          className: 'teamled-input',
          type: 'text',
          key: 'actor',
          value: current.actor,
          spellCheck: false,
          placeholder: 'human:xxx（默认取名册里的第一个人）',
          title: 'host 按这个身份判定权限，必须写清楚是谁在点',
          onChange: function (event) { patch({ actor: event.target.value, actorTouched: true }) },
        }))
        barChildren.push(React.createElement('span', { className: 'teamled-chip', key: 'c-req' }, '需求 ' + String(asNumber(counts === null ? 0 : counts.requirements, 0))))
        barChildren.push(React.createElement('span', { className: 'teamled-chip', key: 'c-task' }, '任务 ' + String(asNumber(counts === null ? 0 : counts.tasks, 0))))
        barChildren.push(React.createElement('span', { className: 'teamled-chip', key: 'c-lease' }, '租约 ' + String(asNumber(counts === null ? 0 : counts.leases, 0))))
        barChildren.push(React.createElement('span', { className: 'teamled-chip', key: 'c-run' }, '会话 ' + String(asNumber(counts === null ? 0 : counts.runs, 0))))
        children.push(React.createElement('div', { className: 'teamled-bar', key: 'bar' }, barChildren))

        var facts = []
        if (config !== null) {
          facts.push('工作区 ' + (asText(config.workspace) === '' ? '（未配置）' : asText(config.workspace)))
          facts.push('飞书 ' + (asText(config.feishuMode) === '' ? 'off' : asText(config.feishuMode)))
          facts.push('数据目录 ' + (asText(config.dataDir) === '' ? '（未配置）' : asText(config.dataDir)))
          facts.push('tick ' + String(asNumber(config.tickIntervalMs, 0)) + 'ms')
          if (asText(config.defaultOwner) !== '') facts.push('默认负责人 ' + asText(config.defaultOwner))
        }
        var metaBits = []
        if (nonEmptyString(data.generatedAt)) metaBits.push('快照 ' + stamp(data.generatedAt))
        if (asNumber(current.elapsed, 0) > 0) metaBits.push('用时 ' + String(asNumber(current.elapsed, 0)) + ' ms')
        if (current.fetching === true) metaBits.push('刷新中…')
        if (canWrite !== true) metaBits.push('actor 为空：写操作已禁用')

        children.push(React.createElement('div', { className: 'teamled-row', key: 'config' },
          React.createElement('div', { className: 'teamled-meta', title: config === null ? '' : asText(config.workspace) }, facts.join(' · ')),
          React.createElement('div', { className: metaBits.length > 0 && canWrite !== true ? 'teamled-warn' : 'teamled-meta' }, metaBits.join(' · ')),
        ))

        if (canWrite !== true) {
          children.push(React.createElement('div', { className: 'teamled-note teamled-warn', key: 'actor-warn' },
            'actor 为空，写操作按钮已禁用。填上「谁在点」（例如 human:wangmengfan）就能用；host 不接受没有 actor 的调用。'))
        }

        /* 上一次动作的结果 */
        if (current.notice !== null) {
          var notice = current.notice
          var noticeClass = notice.kind === 'ok' ? 'teamled-msg-ok' : notice.kind === 'err' ? 'teamled-msg-err' : 'teamled-msg-warn'
          var panelClass = notice.kind === 'ok' ? 'teamled-panel-ok' : notice.kind === 'err' ? 'teamled-panel-err' : 'teamled-panel-warn'
          var noticeChildren = []
          noticeChildren.push(React.createElement('div', { className: 'teamled-panel-title ' + noticeClass, key: 't' }, asText(notice.title)))
          noticeChildren.push(React.createElement('div', { className: 'teamled-msg ' + noticeClass, key: 'm' }, asText(notice.message)))
          var pendingList = asArray(notice.pending)
          if (pendingList.length > 0) {
            noticeChildren.push(React.createElement('div', { className: 'teamled-pending', key: 'p' },
              '还差谁确认：' + pendingList.join('、')))
          }
          if (nonEmptyString(notice.code)) {
            noticeChildren.push(React.createElement('div', { className: 'teamled-code', key: 'c' }, 'code: ' + notice.code))
          }
          if (nonEmptyString(notice.report)) {
            noticeChildren.push(React.createElement('div', { className: 'teamled-meta', key: 'rl' }, '执行会话的汇报（原文）：'))
            noticeChildren.push(React.createElement('pre', { className: 'teamled-report', key: 'r' }, notice.report))
          }
          if (asNumber(notice.elapsed, 0) > 0) {
            noticeChildren.push(React.createElement('div', { className: 'teamled-meta', key: 'e' }, '用时 ' + String(asNumber(notice.elapsed, 0)) + ' ms'))
          }
          children.push(React.createElement('div', { className: 'teamled-panel ' + panelClass, key: 'notice' }, noticeChildren))
        }

        /* 到期扫描的结果 */
        if (current.tick !== null) {
          var scan = current.tick
          var scanChildren = []
          scanChildren.push(React.createElement('div', { className: 'teamled-panel-title', key: 't' },
            '扫超时' + (scan.dryRun === true ? '（预演，未改动任何对象）' : '') + '：扫到 ' + String(asNumber(scan.gates, 0)) + ' 个到期门禁 / ' + String(asNumber(scan.leases, 0)) + ' 个到期租约'))
          var decidedList = asArray(scan.decided)
          if (decidedList.length === 0) {
            scanChildren.push(React.createElement('div', { className: 'teamled-note', key: 'empty' }, '没有到期的门禁或租约。'))
          } else {
            var decidedNodes = []
            for (i = 0; i < decidedList.length; i += 1) {
              var entry = asObject(decidedList[i])
              var tone = entry === null ? 'mute' : asText(entry.tone)
              var text = entry === null ? String(decidedList[i]) : asText(entry.text)
              decidedNodes.push(React.createElement('div', { className: 'teamled-decided-item teamled-' + (tone === '' ? 'info' : tone), key: 'd' + String(i) }, text))
            }
            scanChildren.push(React.createElement('div', { className: 'teamled-decided', key: 'list' }, decidedNodes))
          }
          scanChildren.push(React.createElement('div', { className: 'teamled-note', key: 'n' },
            '预演报告的就是真跑一遍会做的动作（动作名与超时策略来自每道门禁的快照）。真正执行由插件的定时 tick 负责。'))
          children.push(React.createElement('div', { className: 'teamled-panel', key: 'tick' }, scanChildren))
        }

        /* 两列：需求 / 任务 */
        var reqColumn = []
        reqColumn.push(React.createElement('div', { className: 'teamled-colhead', key: 'rh' },
          React.createElement('span', { className: 'teamled-coltitle' }, '需求（' + String(requirements.length) + '）'),
          React.createElement('span', { className: 'teamled-note' }, '点标题展开问题 / 方案 / 验收标准 / 任务 id'),
        ))
        if (requirements.length === 0) {
          reqColumn.push(React.createElement('div', { className: 'teamled-note', key: 'empty' }, '还没有需求。用 `team` 工具（action=create_requirement）或飞书群消息建一个。'))
        }
        for (i = 0; i < requirements.length; i += 1) {
          var requirement = asObject(requirements[i])
          if (requirement === null) continue
          var reqId = asText(requirement.id)
          var isOpen = current.openReq !== null && current.openReq === reqId
          var reqHead = []
          reqHead.push(React.createElement('span', { className: 'teamled-meta', key: 'caret' }, isOpen ? '▾' : '▸'))
          reqHead.push(React.createElement('span', { className: 'teamled-id', key: 'id' }, reqId === '' ? '（无 id）' : reqId))
          reqHead.push(tag('state', stateTone(requirement.state), stateTagText(requirement.state)))
          if (nonEmptyString(requirement.priority)) {
            reqHead.push(tag('prio', requirement.priority === 'P0' || requirement.priority === 'P1' ? 'warn' : 'mute', asText(requirement.priority), '优先级'))
          }
          reqHead.push(React.createElement('span', { className: 'teamled-title', key: 'title' }, asText(requirement.title) === '' ? '（无标题）' : asText(requirement.title)))

          var reqCard = []
          reqCard.push(React.createElement('button', {
            className: 'teamled-reqhead',
            type: 'button',
            key: 'head',
            onClick: function (id) {
              return function () {
                patch({ openReq: current.openReq === id ? null : id })
              }
            }(reqId),
          }, reqHead))

          var reqMeta = []
          if (nonEmptyString(requirement.owner)) reqMeta.push('负责人 ' + requirement.owner)
          if (nonEmptyString(requirement.requester)) reqMeta.push('提出人 ' + requirement.requester)
          if (nonEmptyString(requirement.origin)) reqMeta.push('来源 ' + requirement.origin)
          if (nonEmptyString(requirement.chat_id)) reqMeta.push('群 ' + requirement.chat_id)
          if (nonEmptyString(requirement.type)) reqMeta.push('类型 ' + requirement.type)
          if (reqMeta.length > 0) reqCard.push(line('meta', 'teamled-meta', reqMeta.join(' · ')))

          if (isOpen) {
            var body = asObject(requirement.body)
            var problem = body === null ? '' : asText(body.problem)
            var proposal = body === null ? '' : asText(body.proposal)
            reqCard.push(React.createElement('div', { className: 'teamled-meta', key: 'pl' }, '问题（problem）'))
            reqCard.push(React.createElement('pre', { className: 'teamled-pre', key: 'problem' }, problem === '' ? '（空）' : problem))
            reqCard.push(React.createElement('div', { className: 'teamled-meta', key: 'sl' }, '方案（proposal）'))
            reqCard.push(React.createElement('pre', { className: 'teamled-pre', key: 'proposal' }, proposal === '' ? '（空）' : proposal))

            var criteria = asArray(requirement.acceptance_criteria)
            reqCard.push(React.createElement('div', { className: 'teamled-meta', key: 'cl' }, '验收标准（' + String(criteria.length) + '）'))
            if (criteria.length === 0) {
              reqCard.push(line('cnone', 'teamled-note', '（没写验收标准）'))
            } else {
              var criteriaNodes = []
              for (var c = 0; c < criteria.length; c += 1) {
                criteriaNodes.push(React.createElement('div', { className: 'teamled-decided-item', key: 'c' + String(c) }, '· ' + asText(criteria[c])))
              }
              reqCard.push(React.createElement('div', { className: 'teamled-decided', key: 'clist' }, criteriaNodes))
            }

            var reqTaskIds = asArray(requirement.tasks)
            reqCard.push(React.createElement('div', { className: 'teamled-meta', key: 'tl' }, '任务（' + String(reqTaskIds.length) + '）'))
            if (reqTaskIds.length === 0) {
              reqCard.push(line('tnone', 'teamled-note', '（还没有拆出任务）'))
            } else {
              var chipNodes = []
              for (var t = 0; t < reqTaskIds.length; t += 1) {
                var taskId = asText(reqTaskIds[t])
                if (taskId === '') continue
                var known = asObject(tasksById[taskId])
                var chipTitle = known === null ? '这个任务不在快照里' : stateTagText(known.state) + '：' + (asText(known.title) || taskId)
                chipNodes.push(React.createElement('button', {
                  className: 'teamled-linkish',
                  type: 'button',
                  key: 't' + String(t),
                  title: chipTitle + '（点击定位到右侧任务）',
                  onClick: function (id) {
                    return function () {
                      patch({ focus: id, focusSeq: current.focusSeq + 1 })
                    }
                  }(taskId),
                }, taskId))
              }
              reqCard.push(React.createElement('div', { className: 'teamled-row', key: 'tlist' }, chipNodes))
            }

            var history = asArray(requirement.history)
            if (history.length > 0) {
              var historyNodes = []
              for (var h = 0; h < history.length; h += 1) {
                var record = asObject(history[h])
                if (record === null) continue
                historyNodes.push(React.createElement('div', { className: 'teamled-decided-item', key: 'h' + String(h) },
                  '· ' + asText(record.from) + ' → ' + asText(record.to) + '（' + asText(record.by) + '，' + localTime(record.at) + '）'))
              }
              reqCard.push(React.createElement('div', { className: 'teamled-meta', key: 'hl' }, '最近历史'))
              reqCard.push(React.createElement('div', { className: 'teamled-decided', key: 'hlist' }, historyNodes))
            }
          }

          reqColumn.push(React.createElement('div', {
            className: 'teamled-card' + (isOpen ? ' teamled-card-focus' : ''),
            key: 'req-' + String(i),
          }, reqCard))
        }

        var taskColumn = []
        taskColumn.push(React.createElement('div', { className: 'teamled-colhead', key: 'th' },
          React.createElement('span', { className: 'teamled-coltitle' }, '任务（' + String(tasks.length) + '）'),
          React.createElement('span', { className: 'teamled-note' }, '「退回 ×N」= release_count > 0：门禁超时真的把任务退回过，这是门禁在起作用的信号。'),
        ))
        if (tasks.length === 0) {
          taskColumn.push(React.createElement('div', { className: 'teamled-note', key: 'empty' }, '还没有任务。需求里用 `team` 工具 propose_tasks 拆一把。'))
        }
        for (i = 0; i < tasks.length; i += 1) {
          var task = asObject(tasks[i])
          if (task === null) continue
          var currentTaskId = asText(task.id)
          var isFocused = current.focus !== null && current.focus === currentTaskId
          var cardChildren = []

          var taskHead = []
          taskHead.push(React.createElement('span', { className: 'teamled-id', key: 'id' }, currentTaskId === '' ? '（无 id）' : currentTaskId))
          taskHead.push(tag('state', stateTone(task.state), stateTagText(task.state)))
          var releaseCount = asNumber(task.release_count, 0)
          if (releaseCount > 0) {
            taskHead.push(tag('release', 'warn', '退回 ×' + String(releaseCount), '门禁超时把任务退回的次数（release_count）；大于 0 说明门禁真的在起作用'))
          }
          if (nonEmptyString(task.assignee)) {
            taskHead.push(React.createElement('span', { className: 'teamled-meta', key: 'assignee' }, '执行者 ' + task.assignee))
          } else {
            taskHead.push(React.createElement('span', { className: 'teamled-warn', key: 'assignee' }, '还没有执行者'))
          }
          cardChildren.push(React.createElement('div', { className: 'teamled-cardhead', key: 'head' }, taskHead))
          cardChildren.push(line('title', 'teamled-title', asText(task.title) === '' ? '（无标题）' : asText(task.title)))

          if (nonEmptyString(task.gates)) {
            cardChildren.push(line('gates', 'teamled-gates', task.gates))
          }

          /* 门禁明细：还差谁确认、截止什么时候、超时怎么处理。 */
          var gateDetail = asObject(task.gate_detail)
          if (gateDetail !== null) {
            var gateParts = []
            var gateNames = ['accept', 'start', 'acceptance']
            for (var g = 0; g < gateNames.length; g += 1) {
              var gateName = gateNames[g]
              var gate = asObject(gateDetail[gateName])
              if (gate === null || gate.not_applicable === true) continue
              var confirmedBy = []
              var confirmations = asArray(gate.confirmed_by)
              for (var f = 0; f < confirmations.length; f += 1) {
                var confirmation = asObject(confirmations[f])
                if (confirmation !== null && nonEmptyString(confirmation.by)) confirmedBy.push(confirmation.by)
              }
              var waiting = []
              var requiredBy = asArray(gate.required_by)
              for (var r = 0; r < requiredBy.length; r += 1) {
                if (nonEmptyString(requiredBy[r]) && confirmedBy.indexOf(requiredBy[r]) < 0) waiting.push(requiredBy[r])
              }
              var gateText = GATE_LABEL[gateName] + '：' + (waiting.length === 0 ? '已确认' : '待 ' + waiting.join('、') + ' 确认')
              if (nonEmptyString(gate.due_at)) gateText += '（截止 ' + stamp(gate.due_at) + '）'
              if (nonEmptyString(gate.on_timeout)) gateText += '，超时 ' + gate.on_timeout
              gateParts.push(gateText)
            }
            if (gateParts.length > 0) cardChildren.push(line('gatedetail', 'teamled-meta', gateParts.join(' · ')))
          }

          var taskMeta = []
          if (nonEmptyString(task.type)) taskMeta.push('类型 ' + task.type)
          var domains = asArray(task.domains)
          if (domains.length > 0) taskMeta.push('域 ' + domains.join('/'))
          if (nonEmptyString(task.repo)) taskMeta.push('仓库 ' + task.repo)
          if (nonEmptyString(task.branch)) taskMeta.push('分支 ' + task.branch)
          if (nonEmptyString(task.owner)) taskMeta.push('负责人 ' + task.owner)
          if (taskMeta.length > 0) cardChildren.push(line('meta', 'teamled-meta', taskMeta.join(' · ')))

          if (nonEmptyString(task.blocked_reason)) {
            cardChildren.push(line('blocked', 'teamled-blocked', '阻塞原因：' + task.blocked_reason))
          }

          var lease = asObject(task.lease)
          if (lease === null) {
            cardChildren.push(line('lease', 'teamled-lease', '租约：无（接受任务时会自动起租）'))
          } else {
            var leaseText = '租约：' + asText(lease.holder) + '（' + asText(lease.state) + '）· 到期 ' + stamp(lease.expires_at)
            var renewals = asNumber(lease.renewals, 0)
            if (renewals > 0) leaseText += ' · 已续 ' + String(renewals) + ' 次'
            cardChildren.push(line('lease', 'teamled-lease', leaseText))
          }

          var evidence = asArray(task.evidence)
          if (evidence.length === 0) {
            cardChildren.push(line('ev', 'teamled-meta', '证据：0 条'))
          } else {
            var lastEvidence = asObject(evidence[evidence.length - 1])
            var evText = '证据 ' + String(evidence.length) + ' 条'
            if (lastEvidence !== null) {
              evText += ' · 最近 [' + asText(lastEvidence.kind) + '] ' + oneLine(lastEvidence.note, 140)
              if (asText(lastEvidence.note) === '') evText += asText(lastEvidence.ref)
              if (nonEmptyString(lastEvidence.at)) evText += '（' + localTime(lastEvidence.at) + '）'
            }
            cardChildren.push(line('ev', 'teamled-meta', evText))
          }

          var run = asObject(runsByTask[currentTaskId])
          if (run !== null) {
            cardChildren.push(line('run', 'teamled-meta',
              '执行会话 ' + asText(run.session_id) + ' · 已 ' + String(asNumber(run.turns, 0)) + ' 轮 · 角色 ' + asText(run.role) +
              (nonEmptyString(run.last_used) ? ' · 最后 ' + localTime(run.last_used) : '')))
          }

          /* 按钮：先按 available 渲染那 4 个，再常驻「执行一轮」。 */
          var actionButtons = []
          var available = asArray(task.available)
          for (var a = 0; a < ACTION_ORDER.length; a += 1) {
            var key = ACTION_ORDER[a]
            if (available.indexOf(key) < 0) continue
            actionButtons.push(React.createElement('button', {
              className: 'teamled-btn',
              type: 'button',
              key: key,
              disabled: isBusy || canWrite !== true,
              title: 'POST action=' + ACTION_CALL[key] + (key === 'submit' ? '（附一条 note 证据）' : ''),
              onClick: function (actionKey, actionName, taskId) {
                return function () {
                  runAction(ACTION_LABEL[actionKey], actionName, actionKey === 'submit'
                    ? { id: taskId, evidence: { kind: 'note', ref: 'gui:' + String(Date.now()), note: '由 GUI 提交' } }
                    : { id: taskId })
                }
              }(key, ACTION_CALL[key], currentTaskId),
            }, ACTION_LABEL[key]))
          }

          var isRunningThis = isBusy && current.busy === 'run_task:' + currentTaskId
          actionButtons.push(React.createElement('button', {
            className: 'teamled-btn teamled-btn-primary teamled-btn-run',
            type: 'button',
            key: 'run',
            disabled: isBusy || canWrite !== true,
            title: 'POST action=run_task：把这个任务交给一个真实 DSH 会话跑一轮，汇报回写为证据',
            onClick: function (taskId) {
              return function () {
                runAction('执行一轮', 'run_task', { id: taskId })
              }
            }(currentTaskId),
          }, isRunningThis ? '执行中…（已 ' + String(busySeconds) + ' 秒）' : '▶ 执行一轮'))
          cardChildren.push(React.createElement('div', { className: 'teamled-actions', key: 'actions' }, actionButtons))

          var unmapped = []
          for (var u = 0; u < available.length; u += 1) {
            var actionName = asText(available[u])
            if (actionName === '' || ACTION_CALL[actionName] !== undefined) continue
            unmapped.push(actionName)
          }
          if (unmapped.length > 0) {
            cardChildren.push(line('unmapped', 'teamled-note',
              '状态机还允许：' + unmapped.join('、') + '（本面板只接上面几个，其余走 `team` 工具）'))
          }

          var taskProps = { className: 'teamled-card' + (isFocused ? ' teamled-card-focus' : ''), key: 'task-' + String(i) }
          if (currentTaskId !== '') taskProps['data-team-task'] = currentTaskId
          taskColumn.push(React.createElement('div', taskProps, cardChildren))
        }

        children.push(React.createElement('div', { className: 'teamled-cols', key: 'cols' },
          React.createElement('div', { className: 'teamled-col', key: 'reqs' }, reqColumn),
          React.createElement('div', { className: 'teamled-col', key: 'tasks' }, taskColumn),
        ))

        children.push(React.createElement('div', { className: 'teamled-note', key: 'foot' },
          '本面板只走 ' + LEDGER_URL + '（GET 取快照，POST 发动作）。actor 决定权限判定；' +
          '`ok:false` 的 message / pending / code 都是 host 的原文，不做任何改写。' +
          '「扫超时」在这里只做预演；真正的超时回收由插件自己的定时 tick 执行。'))
      }

      /* ---------------- 页签栏与最终拼装 ---------------- */

      /*
       * 页签栏。五个按钮，当前页高亮（.teamled-tab-active 用品牌色实心，明暗
       * 主题下都显眼）；切页只改 state，不动 URL、不刷新、也不卸载这个面板
       * （main 是按 key 保留挂载的），所以填了一半的表单不会丢。
       *
       * 高亮只比 `key === current.tab`：以前写成“是不是 config 页”，多一个页签
       * 就会同时亮两个。
       */
      var tabButton = function (key, label, title) {
        var active = key === current.tab
        var tabProps = {
          className: 'teamled-tab' + (active ? ' teamled-tab-active' : ''),
          type: 'button',
          key: 'tab-' + key,
          title: title,
        }
        if (active === true) tabProps['aria-current'] = 'true'
        tabProps.onClick = function () { patch({ tab: key }) }
        return React.createElement('button', tabProps, label)
      }

      var tabsNode = React.createElement('div', { className: 'teamled-tabs', key: 'tabs' },
        tabButton('ledger', '台账', '需求 / 任务 / 门禁 / 执行一轮（原有内容）'),
        tabButton('config', '配置', '接入自检与 team 的全部可编辑配置'),
        tabButton('bots', '机器人', '机器人名册：角色 / 飞书应用 / 所在群 / 配置问题 / 启停'),
        tabButton('members', '成员', '成员名册与飞书 openId 绑定（谁在群里说话算谁）'),
        tabButton('sessions', '会话', '每个机器人在每个群的会话：轮次 / 最后活跃 / 工作区'),
      )

      var configNode = null
      if (current.tab === 'config') {
        configNode = TeamConfigPage({
          phase: current.configPhase,
          error: current.configError,
          fetching: current.configFetching === true,
          payload: current.configData,
          editable: editableSet(current.configData),
          fields: current.configFields,
          rows: current.configRows,
          touched: Object.keys(asObject(current.configDirty) === null ? {} : current.configDirty).length > 0,
          notice: current.configNotice,
          busy: current.configBusy === true,
          actor: current.actor,
          onField: setConfigField,
          onRow: setConfigRow,
          onAddRow: addConfigRow,
          onRemoveRow: removeConfigRow,
          onReload: function () { loadConfig({ retry: true }) },
          onSave: saveConfig,
          onActor: function (value) { patch({ actor: value, actorTouched: true }) },
        })
      }

      /*
       * 三个名册页共用同一份 configData（以及同一套读写 handler）：它们读的是
       * 同一个 GET /api/team/config，只是画法不同。切页不重新取数。
       */
      var rosterProps = {
        phase: current.configPhase,
        error: current.configError,
        fetching: current.configFetching === true,
        payload: current.configData,
        editable: editableSet(current.configData),
        actor: current.actor,
        notice: current.rosterNotice,
        busy: current.rosterBusy !== '',
        drafts: current.memberDrafts,
        onReload: function () { loadConfig({ retry: true }) },
        onToggleBot: toggleBot,
        onMemberDraft: setMemberDraft,
        onSaveMember: saveMemberOpenId,
        botDraft: current.botDraft,
        pickedPrimary: current.pickedPrimary ?? {},
        onPickPrimary: function (chatId, botId) {
          setState(function (previous) {
            var picked = Object.assign({}, previous.pickedPrimary ?? {})
            picked[chatId] = botId
            return Object.assign({}, previous, { pickedPrimary: picked })
          })
        },
        onSetPrimary: setPrimaryBot,
        onEditBot: openBotEditor,
        onAddBot: addBot,
        onRemoveBot: removeBot,
        onBotField: setBotField,
        onSaveBot: saveBotDraft,
        onCloseBot: function () { patch({ botDraft: null }) },
      }
      var rosterNode = null
      if (current.tab === 'bots') rosterNode = TeamBotsPage(rosterProps)
      else if (current.tab === 'members') rosterNode = TeamMembersPage(rosterProps)
      else if (current.tab === 'sessions') rosterNode = TeamSessionsPage(rosterProps)

      /* 默认页签是「台账」：切到这四个页签之前，渲染出来的东西与改动前逐字相同。 */
      var rendered = [headNode, tabsNode]
      if (current.tab === 'config') rendered = rendered.concat([configNode])
      else if (rosterNode !== null) rendered = rendered.concat([rosterNode])
      else rendered = rendered.concat(children)
      return React.createElement('div', { className: 'teamled' }, rendered)
    }

    module.exports.apply = function (ctx) {
      /*
       * 侧栏入口。list 槽的注册项是元数据 `{ id, order, label }`（没有 icon
       * 字段）；这个 id 同时就是 main 要派发的 key，两处必须都是 `team`。
       * 图标由占位组件画（见 TeamGlyph 的说明）。
       */
      ctx.slots.inject('sidebar.panellist', function () {
        return ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'team',
          order: 40,
          label: '团队台账',
        }, TeamGlyph)
      })

      /*
       * 中心面板。keyed 槽：宿主在侧栏入口 id 与这个 key 相等时渲染它，
       * owner props 是空的，组件不读 props。
       */
      ctx.slots.inject('main', function () {
        return ctx.slots.register({ name: 'main', key: 'team' }, TeamLedger)
      })
    }

    /* 这个浏览器模块真正的 Cordis 服务注入；package.json 里 `dsh.client.inject`
     * 是文档，不是依赖。 */
    module.exports.inject = ['slots']

    return module.exports
  },
})
