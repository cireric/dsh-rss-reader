/**
 * @dsh-external/dsh-rss-reader — client 半（M3 键盘面 + 未读徽标）。
 *
 * 入口只有侧栏图标 `sidebar.panellist`，点击切到主栏阅读器（该座位的 id 必须同名于
 * `main` 座位的 key，缺 main 条目点选即抛错）。
 *
 * 键盘：**不走 `ctx.shortcuts`**（平台禁止无修饰键的绑定，见 keys.ts 注释），而是 `document` 级
 * 监听 + 输入框/弹层/不可见三重守卫：面板卸载即移除监听，所以只在阅读器挂载期生效。
 * 键位语义集中在 `src/keys.ts`（纯函数、有单测），滚动跟随在 `src/list-scroll.ts`（同）。
 *
 * 状态放在 apply 里创建的共享 store 上（不是组件内部 state）：快捷键要能驱动同一份状态，
 * 未读徽标也要在没有面板时读它。
 *
 * 数据只经同源 HTTP 通道走主进程（见 shared.ts），浏览器半不直连存储。
 */
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Context as ClientContext } from 'cordis'
// 只为触发模块增强（与官方客户端插件同一写法）：ctx.slots 由 ui-renderer/client 声明
// （它 declare module '@deepseek-ai/cordis' 把 slots 挂到 Context 上），运行时由宿主提供，
// 见 package.json 的 dsh.client.inject。没有它，客户端半过不了类型检查 —— 这正是
// 2026-10-07 之前 tsc 完全没覆盖客户端所掩盖的东西。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// 用到的槽位键由这两个包声明进 SlotMap（main 来自 layout，sidebar.* 来自 sidebar）
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { createReaderStore, nextExpandedOf, relativeTime, useReaderStore, VIRTUAL_VIEWS, type Filter, type MarkAllRange, type ReaderState, type ReaderStore, type ReaderStoreDeps } from './store.js'
import { DISPLAY_WINDOW_OPTIONS, displayWindowNameOf, unreadCountTextOf } from './window-control.js'
import { translationEntryOf } from './translate-actions.js'
import type { DisplayWindowRange } from '../display-window.js'
// 导出面是构建产物对外的契约（契约测试直接调它），store 搬家后仍要从入口转出去
export { createReaderStore }
// **仅供单测取用**（R7 05）：失败信封的 details 透传住在 browserRpc 里，而 client 半只出
// 单文件 bundle，测试拿不到 store.ts 的私有实现。测试用导出的 RpcError 构造假 rpc 的失败，
// 并直接喂 browserRpc 一个信封断言 code / details / message。不是运行时需要的能力。
export { browserRpc } from './store.js'
export { RpcError } from './rpc-error.js'
// **仅供单测取用的 re-export**：键盘路由住在 ./keyboard-routing.ts，而 client 半只出单文件
// bundle（tsdown codeSplitting: false），.mjs 测试无法直接 import client 目录下的模块。
// tests/keyboard-routing.test.mjs 用 vm 加载 lib/client.js 后从这里取它来驱动那 10 处 view 守卫。
// ⚠️ 它**不是**运行时需要的导出 —— 删掉它，键盘功能照常，只是那组守卫失去单测。
export { routeKey } from './keyboard-routing.js'
// 左栏宽度：横向 flex 布局与本组件共用同一个常量（feed-nav.tsx），分散写会出现 1px 的缝
export { LEFT_NAV_WIDTH } from './feed-nav.js'
import { routeKey } from './keyboard-routing.js'
import { FeedsView } from './feeds-view.js'
import { FeedNav } from './feed-nav.js'
import { TagEditor } from './tag-editor.js'
import { ArticleView } from './article-pane.js'
import { SettingsView } from './settings-view.js'
import { ExploreView } from './explore-view.js'
import { SourcePackView } from './source-pack-view.js'
import { ConfirmDialog } from './confirm-dialog.js'
// 空组覆盖住 `image-fold.ts`（R6 04 从本文件搬去）：`i` 键在 keyboard-routing.ts 里也要写它，
// 两处各造一个 `new Set()` 会得到值相等但引用不同的两份「空组覆盖」，而 React 的相等判断与
// `foldOf` 的快照语义都靠**同一个引用**才不多跑一次渲染。理由见那边的常量注释。
import { EMPTY_IMAGE_GROUPS } from '../image-fold.js'
import { hasBodyText, httpUrlOrEmpty, ROUTE_PATH, type ArticlePayload, type CleanupResult, type FeedView, type ItemView, type OpmlExportResult, type OpmlImportResult, type Overview, type RpcResult } from '../shared.js'
import { recencyOf } from '../cursor.js'
import { paragraphsOf } from '../html-text.js'
// resolveReaderKey 也搬去了（keyboard-routing.ts 第 1 层）；这里只留帮助浮窗要用的两张表。
import { READER_KEY_HELP, READER_HELP_SCOPE_LABEL } from '../keys.js'
// 只剩「跟随选中项滚动」那条 effect 用的两个（nextScrollTop / SCROLL_ATTR）；
// 扫视与翻页那几个（scanTop / pageTop / halfPageTop / scanStepFor / scrollSelectorFor / lineStepFrom）
// 已随 141 行键盘路由搬进 keyboard-routing.ts（2026-10-15）。
// 夹取（clampScrollTop）已收进 store.takeListScrollTop：面板拿到的就是夹取后的值，
// 这里不再保留第二份夹取（同一条判据只留一个裁决者）。
// isElementNode 的**类型收窄**住在客户端（./element-node.ts）：host 工程没有 DOM lib，
// 收窄留在共享文件里会让 host 编译不过（2026-11-13 实测 tsc 7.0.2 TS2304）。
import { nextScrollTop, SCROLL_ATTR } from '../list-scroll.js'
import { isElementNode } from './element-node.js'

export const inject = ['slots']

/**
 * 「账目与档位尚未对齐」时传给左栏的**空**每源账目（R1 评审 P1）。
 *
 * 空 map 的含义是「还不知道」，不是「每个源都是 0」：feed-nav 见到空 map 会一个角标都不渲染。
 * 用模块级常量而不是字面量 `{}`，是为了让 FeedNav 的 props 引用在 pending 期间保持稳定。
 */
const NO_UNREAD: Record<string, number> = {}

/** panellist 图标的 id 必须与 main 座位的 key 相同。 */
const PANEL_ID = 'dsh-rss-reader'
/** 阅读器根节点的标记：快捷键用它判断焦点是否在本面板内。 */
const ROOT_ATTR = 'data-dsh-rss-reader'
/** 帮助浮窗的标记：与 data-rss-row / data-rss-scroll 同一约定 —— 测试按标记属性现取节点，
 *  不靠序号或文案定位（改文案不该让测试红，改语义才该）。 */
const HELP_ATTR = 'data-rss-help'

/**
 * 加载指示的消抖阈值：刷新常常在毫秒级返回，立刻显示「刷新中」会闪一下。
 * 超过这个时长才把加载态画出来（docs/pitfalls.md「刷新与加载态」那条教训）。
 */
const SLOW_LOADING_MS = 180

/** 在面板内映射宿主主题，独立渲染时回落到浏览器系统色。 */
const STYLE = `
[data-dsh-rss-reader] {
  --rss-bg: var(--dsw-alias-bg-base, Canvas);
  --rss-fg: var(--dsw-alias-label-primary, CanvasText);
  --rss-muted: var(--dsw-alias-label-secondary, color-mix(in srgb, var(--rss-fg) 68%, var(--rss-bg)));
  --rss-accent: var(--dsw-alias-state-business-primary, LinkText);
  --rss-line: var(--dsw-alias-border-l2, color-mix(in srgb, var(--rss-fg) 12%, transparent));
  --rss-hover: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--rss-fg) 6%, var(--rss-bg)));
  --rss-selected: color-mix(in srgb, var(--rss-accent) 12%, var(--rss-bg));
  --rss-side: var(--dsw-alias-bg-layer-1, color-mix(in srgb, var(--rss-fg) 4%, var(--rss-bg)));
  --rss-error: var(--dsw-alias-state-error-primary, #c0392b);
  background:var(--rss-bg); color:var(--rss-fg);
}
[data-dsh-rss-reader] :is(button, [role="button"], a, summary, input, select):focus-visible {
  outline:2px solid var(--rss-accent); outline-offset:-2px;
}
[data-dsh-rss-reader] a { color:var(--rss-accent); text-underline-offset:.2em; }
.dsh-rss-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px 16px;
  padding:12px clamp(12px, 2vw, 28px); border-bottom:1px solid var(--rss-line); }
.dsh-rss-toolbar-title { min-width:0; flex:1 1 140px; overflow-wrap:anywhere; }
.dsh-rss-toolbar-title strong { display:block; font-size:16px; line-height:1.35; }
.dsh-rss-meta { display:block; color:var(--rss-muted); font-size:12px; line-height:1.45; }
/* R12：作者名单行省略。inline-block 是 overflow / text-overflow 生效的前提，
   max-width:100% 防止超长作者把后面的相对时间挤出容器；全文留在 title 里。
   只在这里截显示，数据层保持原值（决策 15）。 */
.dsh-rss-author { display:inline-block; max-width:100%; vertical-align:bottom;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dsh-rss-counts { display:flex; flex-wrap:wrap; gap:2px 12px; margin-top:3px; }
/* 时间范围档位（R1-03）：与计数同一行的原生 select。font:inherit 让它跟 .dsh-rss-meta 的
   12px 走；显式 max-width 是为了窄面板下不把「已加载 N 条」挤到第二行（值为自然日名，最长 5 字）。 */
.dsh-rss-window { font:inherit; font-size:12px; line-height:1.4; max-width:8.5em;
  padding:1px 4px; border-radius:4px; color:inherit; background:var(--rss-bg);
  border:1px solid var(--rss-line); }
.dsh-rss-window:disabled { opacity:.55; }
.dsh-rss-window-hint { font-size:11px; color:var(--rss-muted); }
/* R7：正文工具栏的目标语言下拉（与「译」相邻，裸下拉不带文字 label；不可用时不渲染）。 */
.dsh-rss-translate-language { font:inherit; font-size:12px; padding:1px 4px; border-radius:4px;
  color:inherit; background:var(--rss-bg); border:1px solid var(--rss-line); max-width:100%; }
.dsh-rss-actions { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.dsh-rss-settings { position:relative; }
.dsh-rss-settings > summary::-webkit-details-marker { display:none; }
.dsh-rss-settings-panel { position:absolute; z-index:4; inset-inline-end:0; top:calc(100% + 6px);
  display:grid; gap:10px; width:max-content; max-width:min(240px, 64vw); padding:12px;
  border:1px solid var(--rss-line); border-radius:8px; background:var(--rss-bg);
  box-shadow:0 8px 22px color-mix(in srgb, var(--rss-fg) 14%, transparent); font-size:13px; }
.dsh-rss-settings-panel label { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.dsh-rss-status { padding:5px clamp(12px, 2vw, 28px); font-size:12px; color:var(--rss-muted);
  border-bottom:1px solid var(--rss-line); overflow-wrap:anywhere; }
.dsh-rss-status--error { color:var(--rss-error); }
/* R11 01 设置页：单页纵向滚动（D13 不做二级导航）。容器自己可聚焦 —— 空格 / d 要交给
   浏览器原生滚动，而原生滚动要求焦点在可滚容器上（见 settings-view.tsx 的文件头）。 */
/* container-type:inline-size 让下面的窄面板断点量**这个面板**而不是视口：宿主里浏览器可以很宽、
   阅读器面板却很窄，@media 在那个场景永远不触发（D14.2 的堆叠要求会静默失效）。 */
.dsh-rss-settings-page { flex:1; min-height:0; overflow-y:auto; outline:none;
  container-type:inline-size; padding:12px clamp(12px, 2vw, 28px) 24px; }
.dsh-rss-settings-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.dsh-rss-settings-title { margin:0; font-size:18px; line-height:1.3; }
.dsh-rss-settings-warning { display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
.dsh-rss-settings-section { margin-top:18px; padding-top:14px; border-top:1px solid var(--rss-line); }
.dsh-rss-settings-section-title { margin:0 0 8px; font-size:14px; }
/* 一行 = 名称 + 帮助 + 值 + 单位。窄面板（<460px）下上下堆叠，值不与名称抢宽度（D14.2）。 */
.dsh-rss-settings-row { display:flex; align-items:baseline; flex-wrap:wrap; gap:4px 10px; padding:6px 0; }
.dsh-rss-settings-label { font-size:13px; }
.dsh-rss-settings-value { font-size:13px; font-weight:600; font-variant-numeric:tabular-nums; }
.dsh-rss-settings-unit { font-size:12px; color:var(--rss-muted); }
.dsh-rss-settings-help { flex-basis:100%; margin:0; font-size:12px; color:var(--rss-muted); line-height:1.45; }
/* R11 02 数值输入与就地反馈：只在本分区内新增，别的设置页样式不动。 */
.dsh-rss-settings-input { font:inherit; font-size:13px; width:6.5em; padding:2px 6px;
  border-radius:4px; color:inherit; background:var(--rss-bg); border:1px solid var(--rss-line);
  font-variant-numeric:tabular-nums; }
.dsh-rss-settings-input:disabled { opacity:.55; }
/* R8a：实例地址是整条 URL，数值行的 6.5em 只够显示到 https://rsshub。
   仍允许在窄面板里收缩（max-width），否则整行会横向溢出。 */
.dsh-rss-settings-input--url { width:20em; max-width:100%; }
/* R15 01：实例池列表。每行 = 地址 + 位次 + 四个动作；窄面板照样换行，不横向溢出。 */
.dsh-rss-rsshub-pool { list-style:none; margin:0; padding:0; flex-basis:100%;
  display:flex; flex-direction:column; gap:2px; }
.dsh-rss-rsshub-instance { display:flex; align-items:baseline; flex-wrap:wrap; gap:4px 8px;
  padding:4px 0; border-top:1px dashed var(--rss-line); }
.dsh-rss-rsshub-instance-url { font-size:13px; font-weight:600; overflow-wrap:anywhere; }
.dsh-rss-rsshub-rank { flex-basis:auto; }
/* 推荐卡片只在空池出现：它是起点建议，不是产品默认值。 */
.dsh-rss-rsshub-recommend { flex-basis:100%; margin-top:8px; padding:8px 10px;
  border:1px solid var(--rss-line); border-radius:6px; }
.dsh-rss-rsshub-recommend-list { margin:4px 0; padding-left:18px; font-size:12px; }
/* R7：模型下拉的选项是模型 id（最长见过 31 字符），数值行的 6.5em 只显示得出「deepsee」。
   用内容宽度而不是再写一个 em 常量：选项变长时不会又截断；窄面板仍靠 max-width 收缩。 */
.dsh-rss-settings-input--select { width:auto; min-width:12em; max-width:100%; }
/* R7：翻译中的占位（同译文段的位置）。动画是装饰，读屏器靠 aria-label「正在翻译」。 */
.dsh-rss-translate-pending { display:flex; align-items:center; min-height:18px; margin:0 0 1.1em; padding-left:10px; }
.dsh-rss-spinner { width:12px; height:12px; border-radius:50%;
  border:2px solid color-mix(in srgb, currentColor 22%, transparent); border-top-color:var(--rss-accent);
  animation:dsh-rss-spin .8s linear infinite; }
@keyframes dsh-rss-spin { to { transform:rotate(360deg) } }
@media (prefers-reduced-motion: reduce) { .dsh-rss-spinner { animation:none; border-top-color:currentColor; opacity:.55 } }
.dsh-rss-settings-saved { font-size:12px; color:var(--rss-accent); }
.dsh-rss-settings-error { flex-basis:100%; margin:0; font-size:12px; color:var(--rss-error); line-height:1.45; }
/* R11 03：非整分钟的「= 90123 ms」只在这个前提下出现（整分钟不显示，D14.2）。 */
.dsh-rss-settings-hint { flex-basis:100%; margin:0; font-size:12px; color:var(--rss-muted);
  font-variant-numeric:tabular-nums; }
/* R11 07：恢复默认影响整组，与上面的单项参数用一条分隔线隔开（D14.2 / D28）。 */
.dsh-rss-settings-reset { display:flex; align-items:center; flex-wrap:wrap; gap:6px 12px;
  margin-top:12px; padding-top:12px; border-top:1px solid var(--rss-line); }
/* 窄面板 = **容器**宽度，不是视口宽度（容器查询以上面的 container-type 为前提）。 */
@container (max-width: 460px) {
  .dsh-rss-settings-row { flex-direction:column; align-items:flex-start; }
}
/* R11 06 关于区：绝对路径很长，窄面板里必须能断行，否则会横向溢出（只作用于本票新增节点）。 */
.dsh-rss-about-value { overflow-wrap:anywhere; }
.dsh-rss-about-summary { cursor:pointer; font-size:13px; margin-top:6px; }
/* R8b 04 探索视图：主栏可能很窄，所以搜索 / 分类 / 参数字段一律可换行、纵向堆叠，
   输入框只给 flex-basis 下限，绝不写死宽度（写死会把窄栏撑出横向滚动）。 */
.dsh-rss-explore-page { flex:1; min-height:0; overflow-y:auto; padding:12px clamp(12px, 2vw, 28px) 24px; }
.dsh-rss-explore-head { display:flex; align-items:center; flex-wrap:wrap; gap:8px 12px; }
.dsh-rss-explore-title { font-size:16px; line-height:1.35; }
.dsh-rss-explore-search { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:12px; }
.dsh-rss-explore-input { font:inherit; font-size:13px; padding:3px 8px; border-radius:4px;
  color:inherit; background:var(--rss-bg); border:1px solid var(--rss-line); min-width:0; flex:1 1 220px; }
.dsh-rss-explore-categories { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
.dsh-rss-explore-category { font:inherit; font-size:12px; padding:2px 8px; border-radius:999px;
  border:1px solid var(--rss-line); background:transparent; color:inherit; cursor:pointer; }
.dsh-rss-explore-category[aria-pressed="true"] { background:var(--rss-selected);
  border-color:var(--rss-accent); font-weight:600; }
.dsh-rss-explore-active { margin-top:8px; font-size:12px; color:var(--rss-muted); }
.dsh-rss-explore-note { padding:16px 4px; font-size:13px; color:var(--rss-muted); }
.dsh-rss-explore-list { list-style:none; margin:12px 0 0; padding:0; }
.dsh-rss-explore-row { padding:10px 0; border-top:1px solid var(--rss-line); }
.dsh-rss-explore-row-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 10px; }
.dsh-rss-explore-site { font:inherit; font-size:12px; padding:0; border:0; background:transparent;
  color:var(--rss-accent); cursor:pointer; text-decoration:underline; text-underline-offset:.2em; }
.dsh-rss-explore-route { font:inherit; font-size:14px; font-weight:600; padding:0; border:0;
  background:transparent; color:inherit; cursor:pointer; text-align:left; }
.dsh-rss-explore-route:hover { color:var(--rss-accent); }
.dsh-rss-explore-pick { margin-left:auto; }

.dsh-rss-explore-path { display:block; margin-top:4px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size:12px; overflow-wrap:anywhere; }
.dsh-rss-explore-detail { margin-top:4px; font-size:12px; color:var(--rss-muted); overflow-wrap:anywhere; }
.dsh-rss-explore-features { display:flex; flex-wrap:wrap; gap:4px; margin-top:6px; }
.dsh-rss-explore-badge { padding:0 5px; border-radius:3px; border:1px solid var(--rss-line);
  font-size:10px; color:var(--rss-muted); }
.dsh-rss-explore-more { padding:10px 0; text-align:center; }
.dsh-rss-explore-form { display:flex; flex-direction:column; gap:8px; margin-top:10px;
  padding-top:10px; border-top:1px solid var(--rss-line); }
.dsh-rss-explore-form-title { font-size:14px; font-weight:600; }
.dsh-rss-explore-field { display:flex; flex-direction:column; gap:3px; }
.dsh-rss-explore-field-label { font-size:12px; color:var(--rss-muted); }
.dsh-rss-explore-form-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.dsh-rss-explore-url { flex:1 1 240px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
/* R15 08 精选源：结构与探索页同族（纵向、可换行），但列表行是「清单条目」而不是路由行。 */
.dsh-rss-pack-page { flex:1; min-height:0; overflow-y:auto; padding:12px clamp(12px, 2vw, 28px) 24px; }
.dsh-rss-pack-head { display:flex; align-items:center; flex-wrap:wrap; gap:8px 12px; }
.dsh-rss-pack-title { font-size:16px; line-height:1.35; font-weight:600; }
.dsh-rss-pack-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:12px; }
.dsh-rss-pack-input { font:inherit; font-size:13px; padding:3px 8px; border-radius:4px;
  border:1px solid var(--rss-line); background:var(--rss-bg); color:inherit; min-width:0; flex:1 1 220px; }
.dsh-rss-pack-select { font:inherit; font-size:13px; padding:3px 6px; border-radius:4px;
  border:1px solid var(--rss-line); background:var(--rss-bg); color:inherit; }
.dsh-rss-pack-form { display:flex; flex-direction:column; gap:8px; margin-top:12px; padding:12px;
  border:1px solid var(--rss-line); border-radius:8px; }
.dsh-rss-pack-form-title { font-size:14px; font-weight:600; }
.dsh-rss-pack-field { display:flex; flex-direction:column; gap:3px; }
.dsh-rss-pack-field-label { font-size:12px; color:var(--rss-muted); }
.dsh-rss-pack-form-actions { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.dsh-rss-pack-probe { font-size:12px; color:var(--rss-muted); }
.dsh-rss-pack-list { list-style:none; margin:12px 0 0; padding:0; }
.dsh-rss-pack-row { padding:10px 0; border-top:1px solid var(--rss-line); }
.dsh-rss-pack-row-head { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 10px; }
.dsh-rss-pack-name { font-size:14px; font-weight:600; overflow-wrap:anywhere; }
.dsh-rss-pack-badge { padding:0 5px; border-radius:3px; border:1px solid var(--rss-line);
  font-size:11px; color:var(--rss-muted); }
.dsh-rss-pack-url { display:block; margin-top:4px; font-size:12px; color:var(--rss-muted);
  font-family:ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap:anywhere; }
.dsh-rss-pack-note, .dsh-rss-pack-note-line { margin-top:4px; font-size:12px; color:var(--rss-muted);
  overflow-wrap:anywhere; }
.dsh-rss-pack-row-head button { margin-left:auto; }
.dsh-rss-pack-footnote { margin-top:16px; }
.dsh-rss-pack-notice { margin-top:8px; font-size:12px; color:var(--rss-accent);
  font-size:12px; overflow-wrap:anywhere; }
.dsh-rss-row { border-bottom:1px solid var(--rss-line); }
.dsh-rss-row:hover, [data-rss-nav-row]:hover { background:var(--rss-hover); }
.dsh-rss-row[data-rss-selected], [data-rss-nav-selected] { background:var(--rss-selected); }
[data-rss-nav-selected] { font-weight:600; }
[data-rss-nav-cursor] { box-shadow:inset 3px 0 0 var(--rss-accent); }
.dsh-rss-row-main { display:flex; gap:10px; align-items:baseline; cursor:pointer;
  padding:10px clamp(12px, 2vw, 28px); }
.dsh-rss-dot { width:6px; height:6px; border-radius:50%; flex:none; background:transparent; }
.dsh-rss-row[data-rss-unread] .dsh-rss-dot { background:var(--rss-accent); }
.dsh-rss-row-title { display:block; font-size:14px; line-height:1.4; overflow-wrap:anywhere; }
.dsh-rss-row[data-rss-unread] .dsh-rss-row-title { font-weight:650; }
.dsh-rss-dupes { display:block; margin-top:4px; font-size:12px; }
.dsh-rss-dupes > summary { cursor:pointer; color:var(--rss-muted); width:max-content; }
.dsh-rss-dupes-list { display:flex; flex-direction:column; gap:2px; margin-top:4px; }
.dsh-rss-dupes-list a { overflow-wrap:anywhere; }
.dsh-rss-summary { display:block; max-width:760px; margin-top:8px;
  font-size:14px; line-height:1.65; overflow-wrap:anywhere; }
.dsh-rss-article-inset { padding-inline:clamp(24px, 4vw, 52px); }
.dsh-rss-article-column { max-width:760px; margin-inline:auto; overflow-wrap:anywhere; }
/* 阅读主题（M5 01）：auto 不带任何覆盖 ⇒ 完全继承宿主。light/dark 只改**正文面滚动区**这一块，
   顶栏是外壳、仍旧跟宿主走，否则一块面板里会出现两片底色。
   必须连 --rss-muted / --rss-line / --rss-accent 一起写：自定义属性是按**声明处**求值后继承的，
   只在子元素上改 --rss-fg 不会让根上算好的 --rss-line 回头重算。 */
[data-rss-reading-theme="light"] { --rss-fg:#1a1a1a; --rss-bg:#ffffff; --rss-muted:#5c5c5c; --rss-line:#e3e3e3; --rss-accent:#0b62d6;
  background:var(--rss-bg); color:var(--rss-fg); }
[data-rss-reading-theme="dark"] { --rss-fg:#e4e4e4; --rss-bg:#16181c; --rss-muted:#9aa0a6; --rss-line:#2c2f36; --rss-accent:#7ab0ff;
  background:var(--rss-bg); color:var(--rss-fg); }
.dsh-rss-article-nav { display:flex; flex-wrap:wrap; align-items:center; gap:8px;
  justify-content:space-between; padding-block:10px; }
.dsh-rss-article-title { font-size:clamp(24px, 2.5vw, 32px); font-weight:700; line-height:1.35; margin:0; }
.dsh-rss-btn { display:inline-flex; align-items:center; gap:6px; font:inherit; font-size:13px;
  padding:4px 10px; border-radius:6px; color:inherit; background:transparent; cursor:pointer;
  border:1px solid color-mix(in srgb, currentColor 22%, transparent);
  transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease; }
.dsh-rss-btn:hover:not(:disabled) { background: color-mix(in srgb, currentColor 10%, transparent);
  border-color: color-mix(in srgb, currentColor 35%, transparent); }
.dsh-rss-btn:active:not(:disabled) { background: color-mix(in srgb, currentColor 16%, transparent); }
.dsh-rss-btn:disabled { opacity:.55; cursor:default; }
.dsh-rss-btn--ghost { border-color:transparent; padding:2px 8px; }
.dsh-rss-spin { animation: dsh-rss-spin 800ms linear infinite; transform-origin:50% 50%; }
@keyframes dsh-rss-spin { to { transform: rotate(360deg); } }
.dsh-rss-bar { position:relative; height:2px; overflow:hidden; }
.dsh-rss-bar::after { content:''; position:absolute; top:0; bottom:0; width:35%;
  background:currentColor; opacity:.45; animation: dsh-rss-slide 1s ease-in-out infinite; }
@keyframes dsh-rss-slide { 0% { left:-35%; } 100% { left:100%; } }
.dsh-rss-help { position:absolute; inset:0; z-index:6; display:flex; justify-content:center;
  align-items:center; padding:20px; pointer-events:none; }
.dsh-rss-help-card { pointer-events:auto; display:flex; flex-direction:column; gap:2px;
  width:100%; max-width:660px; max-height:100%; overflow-y:auto; padding:12px 16px 14px;
  border-radius:10px; font-size:13px;
  background:Canvas; color:CanvasText;
  border:1px solid color-mix(in srgb, CanvasText 20%, transparent);
  box-shadow:0 14px 40px color-mix(in srgb, CanvasText 24%, transparent); }
.dsh-rss-help-head { display:flex; align-items:center; gap:10px; padding-bottom:4px; }
.dsh-rss-help-title { font-size:14px; font-weight:600; }
.dsh-rss-help-legend { font-size:11px; opacity:.6; }
/* 三列一个 grid（整卡共用列宽，不是每行各排各的：行若各自 max-content，summary 的起点
   会随键位列长短参差，比旧的固定 132px 更糟）。键位列 max-content 随内容自适应。
   行用 display:contents —— 它的三个单元格直接进 grid；代价是行自身不成盒（行 hover 若做
   在 P2，得挂在单元格上）。 */
.dsh-rss-help-body { display:grid; grid-template-columns:max-content 1fr max-content;
  column-gap:10px; row-gap:3px; align-items:baseline; }
.dsh-rss-help-group { grid-column:1 / -1; font-size:11px; font-weight:600; opacity:.55;
  letter-spacing:.06em; margin:8px 0 2px; }
.dsh-rss-help-row { display:contents; }
.dsh-rss-help-key { font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size:12px; white-space:nowrap; }
.dsh-rss-help-key kbd { font-family:inherit; font-size:inherit; padding:1px 5px;
  border:1px solid color-mix(in srgb, CanvasText 22%, transparent); border-radius:4px;
  background:color-mix(in srgb, CanvasText 6%, transparent); }
.dsh-rss-help-sum { min-width:0; }
.dsh-rss-help-scope { font-size:11px; opacity:.5; white-space:nowrap; }
/* A 的二次确认（2026-11-21）：模态浮层。刻意用 role="dialog" + aria-modal —— 键盘守卫会把框内
   按键全部拦下（后台的 j/k 不会动列表），这正是模态要的；代价是 Esc 也被拦，所以 Esc 由卡片的
   onKeyDown 处理（back 动作里另有同一判据，覆盖「焦点还没进框」的一瞬）。 */
.dsh-rss-confirm { position:absolute; inset:0; z-index:7; display:flex; justify-content:center;
  align-items:center; padding:20px; background:color-mix(in srgb, CanvasText 28%, transparent); }
.dsh-rss-confirm-card { display:flex; flex-direction:column; gap:10px; width:100%; max-width:420px;
  padding:16px 18px; border-radius:10px; font-size:13px;
  background:Canvas; color:CanvasText;
  border:1px solid color-mix(in srgb, CanvasText 20%, transparent);
  box-shadow:0 14px 40px color-mix(in srgb, CanvasText 24%, transparent); }
.dsh-rss-confirm-title { font-size:14px; font-weight:600; line-height:1.4; }
.dsh-rss-confirm-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; }
.dsh-rss-confirm-row label { display:flex; align-items:center; gap:6px; }
.dsh-rss-confirm-row select { font:inherit; padding:2px 4px; border-radius:4px; color:inherit;
  background:var(--rss-bg); border:1px solid var(--rss-line); }
.dsh-rss-confirm-note { font-size:12px; color:var(--rss-muted); }
.dsh-rss-confirm-actions { display:flex; justify-content:flex-end; gap:8px; padding-top:2px; }
.dsh-rss-btn--primary { border-color:var(--rss-accent); font-weight:600; }
@media (prefers-reduced-motion: reduce) {
  .dsh-rss-spin, .dsh-rss-bar::after { animation:none; }
  .dsh-rss-btn, [data-dsh-rss-reader] [data-rss-scroll] { transition:none !important; }
}
`

/** 刷新图标：加载时整圈旋转，省掉额外的 spinner 元素。 */
function RefreshIcon({ spinning }: { spinning?: boolean }): ReactNode {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" aria-hidden="true"
      className={spinning === true ? 'dsh-rss-spin' : undefined}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M13.6 2.2v3.2h-3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}


function ReaderIcon({ size = 16, active = false }: { size?: number; active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ opacity: active ? 1 : 0.72 }}>
      <circle cx="3.6" cy="12.4" r="1.6" fill="currentColor" />
      <path d="M2 7.2A6.8 6.8 0 0 1 8.8 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M2 2.6A11.4 11.4 0 0 1 13.4 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 组装 Reader 组件。
 *
 * **刻意 export**：客户端行为在浏览器里跑、我无法自测，导出来之后测试可以直接渲染它并派发
 * 真实按键事件，而不是只断言 store 的最终状态。2026-10-07 实测：把「所有键解析短路」
 * 「可见性守卫恒真」「干脆不注册监听器」三条变异分别注入构建产物，只断言 store 的测试
 * 103 条全绿——说明按键接线那一层此前零覆盖。
 */
/**
 * 快捷键帮助浮窗（GR spec §3.8 第 255 行：`?` = 快捷键帮助）。
 *
 * 为什么**不**用 role="dialog" / aria-modal：面板的按键守卫（isTypingTarget）会把焦点位于
 * dialog 内的按键全部吞掉（含 Esc）—— 鼠标点过一次浮窗里的 ✕，焦点就落在浮窗内，再按 ? 或 Esc
 * 会全哑。用户拍板要的是「非模态：查键位时后台的键仍生效」，所以这里用 role="region"：
 * 与那条守卫天然不冲突，语义上也不再假装自己是个模态框。
 *
 * 内容逐行来自 keys.ts 的 READER_KEY_HELP（唯一来源）—— 本组件不写任何键位文案，
 * 免得又出现「界面写一套、实现认一套」那类既有故障。
 */
function HelpPanel({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <div className="dsh-rss-help" {...{ [HELP_ATTR]: '' }}>
      <div className="dsh-rss-help-card" role="region" aria-label="快捷键列表">
        <div className="dsh-rss-help-head">
          <span className="dsh-rss-help-title">快捷键帮助</span>
          <span className="dsh-rss-help-legend">未标注适用范围的键，在任何视图都生效</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
            aria-label="关闭快捷键帮助" onClick={onClose}>✕</button>
        </div>
        {/* 键位渲染成 <kbd> 芯片，但分隔符仍写原文 ' / '：scroll-dom 的断言是
            text.includes(entry.label)，textContent 少一个空格当场红。 */}
        <div className="dsh-rss-help-body">
          {READER_KEY_HELP.map((section) => (
            <Fragment key={section.title}>
              <div className="dsh-rss-help-group">{section.title}</div>
              {section.entries.map((entry) => (
                <div key={entry.label} className="dsh-rss-help-row">
                  <span className="dsh-rss-help-key">
                    {entry.label.split(' / ').map((part, index) => (
                      <Fragment key={part}>
                        {index > 0 ? ' / ' : null}
                        <kbd>{part}</kbd>
                      </Fragment>
                    ))}
                  </span>
                  <span className="dsh-rss-help-sum">{entry.summary}</span>
                  <span className="dsh-rss-help-scope">{READER_HELP_SCOPE_LABEL[entry.scope]}</span>
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 原生 select「选完把焦点还回去」的唯一实现（2026-11-21）。
 *
 * **病象**：用鼠标改完顶栏的时间范围（旧版还有「A 键范围」）后再按 A / j / k，毫无反应。
 * **根因**：`<select>` 选完仍持有焦点，而 keyboard-routing.ts 的 isTypingTarget 把来自 SELECT 的
 * 按键全部当成「用户正在输入」放行给控件 —— 守卫本身没错（不抢输入控件的键），错的是控件用完
 * 不还焦点。实测：焦点在 [data-rss-window] 上按大写 A，无撤销条、未读数不变；点一下列表再按就正常。
 *
 * 只对**指针**路径归还：键盘选 select 时方向键是多步的（每步都触发 change），中途抢走焦点会让
 * 一次选择只能走一步。pointerdown 打标记、keydown/blur 清标记，change 时按标记决定。
 */
function useSelectFocusReturn(getTarget: () => HTMLElement | null): {
  pointer: { onPointerDown: () => void; onKeyDown: () => void; onBlur: () => void }
  commit: () => void
} {
  const viaPointer = useRef(false)
  return {
    pointer: {
      onPointerDown: () => { viaPointer.current = true },
      onKeyDown: () => { viaPointer.current = false },
      onBlur: () => { viaPointer.current = false },
    },
    commit: () => {
      if (!viaPointer.current) return
      viaPointer.current = false
      getTarget()?.focus()
    },
  }
}

/**
 * 确认框里的作用域摘要：读者要能一眼看出「哪些条目会被标」，不用自己去猜当前过滤与时间窗。
 *
 * 与顶栏标题同一套取值来源（navSelection / filter / displayWindow），不另存「上次的摘要」——
 * 那份副本迟早与真实状态分家。
 *
 * ⚠️ 刻意**不**写「已加载 N 条」（ADR-0008）：候选由宿主在库全量上求值，条数可能大于已加载页
 * （源里 19 条未读、已加载页 0 条就是常态）。把「已加载」摆在「将标记 N 条」旁边，读者会以为
 * 其中有一个数错了 —— 这正是本轮要消灭的那类口径混乱。
 */
function listScopeText(state: ReaderState): string {
  const selection = state.navSelection
  const where = selection.kind === 'feed'
    ? (state.feeds.find((feed) => feed.id === selection.feedId)?.title ?? '该源')
    : selection.kind === 'folder'
      ? '文件夹「' + selection.folder + '」'
      : selection.kind === 'tag'
        ? '标签「' + (state.tags.find((tag) => tag.id === selection.tagId)?.name ?? selection.tagId) + '」'
        : '全部文章'
  const filter = VIRTUAL_VIEWS.find((entry) => entry.key === state.filter)?.label ?? state.filter
  return where + ' · ' + filter + ' · ' + displayWindowNameOf(state.displayWindow)
}

/**
 * A 的二次确认框（2026-11-21 用户拍板）。
 *
 * 为什么不是 window.confirm：要在框里改「范围」并实时显示「将标记 N 条」，原生 confirm 做不到；
 * 而且 jsdom 里 window.confirm 没有实现，整条功能会变得不可测（测试只能断言「没崩」）。
 *
 * 为什么用 role="dialog" + aria-modal，而 HelpPanel 刻意用 region：这一层**要**拦键 ——
 * isTypingTarget 会把框内按键当成输入目标放行给控件，于是后台的 j/k 不会在确认框开着时动列表。
 * 代价是 Esc 也被拦，所以 Esc 必须由本卡片的 onKeyDown 处理（back 动作里还有一份，覆盖
 * 「刚按下 A、焦点还没进框」的那一瞬；两处都只做「关掉」这一件事）。
 *
 * 条数的唯一判据是 store.markAllPlan —— 与真正标读那份名单同一个函数，框里说几条就标几条。
 */
function MarkAllConfirm({ state, store, onCancel, onConfirm }: {
  state: ReaderState
  store: ReaderStore
  onCancel: () => void
  onConfirm: () => void
}): ReactNode {
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  /**
   * 条数由宿主 dry-run 给出（ADR-0008）：客户端只说「范围 × 过滤 × 窗 × 阈值」，
   * 候选在库全量上求值 —— 再按 `visible()` 数一遍就又会只看见已加载页（19 条未读显示 0）。
   * 统计期间按钮禁用；换范围 / 换视图时重算。
   */
  const [count, setCount] = useState<number | undefined>(undefined)
  const [countFailed, setCountFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setCount(undefined)
    setCountFailed(false)
    void store.countMarkAllCandidates()
      .then((value) => { if (alive) setCount(value ?? 0) })
      .catch(() => { if (alive) setCountFailed(true) })
    return () => { alive = false }
  }, [store, state.markAllRange, state.navSelection, state.displayWindow, state.filter, state.search, state.items.length])
  const keptCount = store.visible().filter((item) => item.readAt === undefined && item.keptUnread === true).length
  const rangeSelect = useSelectFocusReturn(() => confirmRef.current)
  return (
    // 外壳与 Esc / 焦点归还在共享 ConfirmDialog（S6）；这里只提供内容与动作。
    // 关框后的焦点仍由 closeMarkAllConfirm 还给面板根（与既有行为一致）。
    <ConfirmDialog
      titleId="dsh-rss-markall-title"
      title={countFailed
        ? '统计当前范围的未读失败了，请重试'
        : count === undefined
          ? '正在统计当前列表的未读…'
          : count === 0
            ? '当前范围没有可标记的未读'
            : '把当前列表里的 ' + String(count) + ' 条未读标为已读？'}
      titleAttrs={{ 'data-rss-markall-count': String(count ?? '') }}
      rootAttrs={{ 'data-rss-markall-confirm': '' }}
      cancelAttrs={{ 'data-rss-markall-cancel': '' }}
      confirmAttrs={{ 'data-rss-markall-ok': '' }}
      confirmLabel="标为已读"
      confirmDisabled={countFailed || count === undefined || count === 0}
      confirmRef={confirmRef}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <div className="dsh-rss-confirm-row">
        <label>范围
          <select data-rss-markall-range="" value={state.markAllRange} {...rangeSelect.pointer}
            onChange={(event) => {
              store.setMarkAllRange(event.target.value as MarkAllRange)
              rangeSelect.commit()
            }}>
            <option value="all">全部</option>
            <option value="day">早于 1 天</option>
            <option value="week">早于 1 周</option>
            <option value="month">早于 1 月</option>
          </select>
        </label>
        <span className="dsh-rss-meta">{listScopeText(state)}</span>
      </div>
      {keptCount > 0 && (
        <div className="dsh-rss-confirm-note">另有 {keptCount} 条「保持未读」不受影响</div>
      )}
    </ConfirmDialog>
  )
}

export function createReader(store: ReaderStore): () => ReactNode {
  return function Reader(): ReactNode {
    const state = useReaderStore(store)
    const [root, setRoot] = useState<HTMLDivElement | null>(null)
    /**
     * 列表滚动容器句柄。**刻意不用 useState**：useRef 的身份跨渲染稳定，读的永远是最新的 .current。
     *
     * 原先这里还有第二个句柄 articleBox（阅读容器），2026-10-15 C2 随「换文章归零」一起搬去了
     * article-pane。原文记着一条同形态事故，值得留在原地：正文容器曾被长驻的 keydown 监听器
     * 闭包捕获（依赖数组不会因为「它在别处被赋值」而重跑 ⇒ 读到注册那一刻的 null），详情页
     * 空格 / n / p 全部静默失效（2026-10-09）。**所以那条路径现在一律按键时刻现取容器**
     * （按标记属性 querySelector，见 keyboard-routing.ts 的 focusScrollBox）——本仓库不为这件事
     * 再留一个跨组件的 ref 桥接。
     */
    const listBox = useRef<HTMLDivElement | null>(null)
    /**
     * 进入探索前的焦点所在（R8b 04，spec §4.1）。
     *
     * 为什么在这里记而不是在 store：DOM 节点不属于状态域；而且入口按钮所在的面板（设置 / 订阅管理）
     * 会在切到探索时卸载 —— 必须在**点击那一刻**取，等 React 提交后再取，activeElement 已经变成 body。
     * 退出时若那个控件还连着就还给它，否则回落面板根（与 closeMarkAllConfirm 的同一条兜底）。
     */
    const exploreReturnFocus = useRef<HTMLElement | null>(null)
    const [expanded, setExpanded] = useState<string | undefined>(undefined)
    /**
     * 被点开的**图片组**序号（R6 03，spec 决策 5 / 14 的「组级覆盖」）。
     *
     * 为什么抬到本组件而不是留在 `ArticleView`：04 的 `i` 键要在 `routeKey` 里读它、并清空它
     * （「按 `i` ⇒ 全篇统一到同一个形态」）。`routeKey` 与 `ArticleView` 是两个组件，状态留在
     * 正文组件里，`i` 就永远读不到它 —— 这与 `expanded` / `helpOpen` 被抬上来的理由完全同源。
     *
     * 本票只接「点提示」这一条写入路径；篇级覆盖（`imagesExpanded`）留给 04，避免两票各造一份
     * 语义重叠的 state。两个状态都不落盘：它们是**本次阅读的瞬时状态**（spec 决策 9）。
     */
    const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<number>>(EMPTY_IMAGE_GROUPS)
    /**
     * 图片折叠的**篇级覆盖**（R6 04，spec 决策 5 / 14）：`undefined` = 这一篇还没按过 `i`。
     *
     * 为什么必须是三态而不是布尔：`i` 的语义是「翻**基线**」（基线 = `篇级覆盖 ?? 偏好`），
     * 而「读者还没表过态」与「读者明确选了展开」是两件事 —— 后者在偏好是折叠时也必须保持展开。
     * 用布尔初值 `false` 会让偏好从展开改成折叠时，旧文章莫名其妙停在折叠（反过来也一样）。
     *
     * 与 `expandedGroups` / `expanded` / `helpOpen` 同一条通道：`useState` 在本组件 →
     * 进 `KeyRoutingCtx` → 进 `routeKey` 调用 → **进依赖数组** → 作为 prop 传给 `ArticleView`。
     * 一个都不能少：漏了最后一步按键与渲染脱钩（按 `i` 界面不动），漏了依赖数组则第二次按不生效。
     * 不落盘 —— 与组覆盖同级，是**本次阅读的瞬时状态**（spec 决策 9）。
     */
    const [imagesExpanded, setImagesExpanded] = useState<boolean | undefined>(undefined)
    /**
     * 灯箱正在显示的那张图的 `src`（R6 07，spec 决策 14 / 26）：`undefined` = 关着。
     *
     * 与 `imagesExpanded` / `expandedGroups` / `expanded` / `helpOpen` 走**同一条通道**：
     * `useState` 在本组件 → 进 `KeyRoutingCtx` → 进 `routeKey` 调用 → **进依赖数组** →
     * 作为 prop 传给 `ArticleView`。一个都不能少。
     *
     * **必须抬上来，不是可选**：`Esc` 的优先级（帮助 → 灯箱 → 退出正文）实现在 `routeKey` 的
     * `back` 动作里，而 `back` 读的是 `ctx`。状态留在 `ArticleView` 里，`Esc` 永远读不到它
     * （spec 决策 14 明写这一条是「必须」）。不落盘 —— 与另外两个图片覆盖同级，是本次阅读的瞬时状态。
     */
    const [lightboxSrc, setLightboxSrc] = useState<string | undefined>(undefined)
    /** 帮助浮窗开合。它进 keydown effect 的依赖数组（见那条 effect 的收尾注释）。 */
    const [helpOpen, setHelpOpen] = useState(false)
    /**
     * A 的二次确认框开合（2026-11-21）。
     *
     * 与 helpOpen 同一条通道：进 KeyRoutingCtx（`back` 要判断 Esc 该不该关它）⇒ 进 keydown effect
     * 的依赖数组 ⇒ 面板卸载即随监听器一起消失。真正的标读不在这里，而在确认按钮的 onClick。
     */
    const [markAllConfirm, setMarkAllConfirm] = useState(false)
    /**
     * 关确认框并把焦点还给面板根。
     *
     * 不还的话焦点会落到 body：Esc / a / j 这些键要么被浏览器自己处理，要么要用户再点一下面板
     * 才恢复 —— 「关掉弹窗后键盘失灵」是同族事故。与下拉框的 useSelectFocusReturn 同一条理由。
     */
    const closeMarkAllConfirm = useCallback((): void => {
      setMarkAllConfirm(false)
      root?.focus()
    }, [root])
    // 两个顶栏下拉框共用「选完还焦点」这条判据（函数里带 pointer 标记，不共享标记本身）。
    const windowSelect = useSelectFocusReturn(() => root)
    const searchReadSelect = useSelectFocusReturn(() => root)
    // 慢加载：只有超过 180ms 还在加载时才把「刷新中」画出来，避免毫秒级请求闪一下
    const [slowLoading, setSlowLoading] = useState(false)
    useEffect(() => {
      if (!state.loading) {
        setSlowLoading(false)
        return
      }
      const timer = setTimeout(() => setSlowLoading(true), SLOW_LOADING_MS)
      return () => clearTimeout(timer)
    }, [state.loading])

    // 打开面板即刷新（主进程侧有最小间隔节流），并把焦点收到列表上，键盘立即可用。
    // R8b 04 / R15 01：设置快照与实例池原先只在打开设置页时才取；探索的两处入口要按
    // 生效实例池判可见性，所以面板挂载时补一次 —— 没进过设置页也必须能正确决定入口显不显示。
    useEffect(() => {
      void store.load('refresh')
      void store.loadSettings()
      // R15 01：探索入口的可见性看实例池（空池 = 功能关闭），面板挂载时一并取。
      void store.loadRsshubSettings()
      // R7 02：翻译可用性在面板加载时探一次（宿主侧 30s 缓存；saveSettings 后失效）。
      void store.loadTranslateInfo()
    }, [])
    // 关面板时把待写的阅读位置落一次（R2-01）：写手是 300ms 去抖的，读者完全可能选完一行立刻离开。
    // 没有待写值时 flushViewMemory 什么都不做 —— 「打开面板看一眼再关」不产生写请求。
    useEffect(() => () => { store.flushViewMemory() }, [store])
    useEffect(() => {
      root?.focus()
    }, [root])

    /**
     * 退出探索后还焦点（R8b 04）。入口按钮通常已随设置 / 订阅管理页卸载，此时回落面板根 ——
     * 不还的话焦点落在 body，之后的 j/k / Esc 全都要用户先点一下面板（同 useSelectFocusReturn 的教训）。
     */
    const viewBeforeExploreExit = useRef(state.view)
    useEffect(() => {
      const previous = viewBeforeExploreExit.current
      viewBeforeExploreExit.current = state.view
      if (previous !== 'explore' || state.view === 'explore') return
      const target = exploreReturnFocus.current
      exploreReturnFocus.current = null
      if (target !== null && target.isConnected) target.focus()
      else root?.focus()
    }, [state.view, root])

    /** 打开探索：入口两处共用；先记下焦点再切视图（见 exploreReturnFocus 的注释）。 */
    const openExplore = useCallback((): void => {
      const doc = root?.ownerDocument
      const active = doc?.activeElement
      exploreReturnFocus.current = isElementNode(active) && active !== doc?.body ? active : null
      store.openExplore()
    }, [root, store])

    // 记录列表滚动位置（R2-02）：passive 监听，滚动手势只更新 store 的模块内值并排 300ms 去抖写。
    // 刻意不 setState：滚动不该触发 React 渲染。卸载时随上面那条 flushViewMemory 一起落一次。
    useEffect(() => {
      const box = listBox.current
      if (box === null) return
      const onScroll = (): void => { store.rememberListScrollTop(box.scrollTop) }
      box.addEventListener('scroll', onScroll, { passive: true })
      return () => { box.removeEventListener('scroll', onScroll) }
    }, [store])

    // 恢复列表滚动位置（R2-02）：列表首屏渲染完成后**取一次**保存值并写回。
    // 用 useLayoutEffect 是刻意的：必须在浏览器绘制前写 scrollTop，否则会先闪一下顶部再跳回原处；
    // 它还必须早于下面那条「跟随选中」的 useEffect，跟随规则才能基于恢复后的位置判断选中行是否可见
    // （在视口内就不动它；因视口变化落到视口外，才允许跟随规则把它带进来）。
    // 取不到（没有记忆 / 用户恢复前已滚过 / 已取过）就什么都不做。
    // 夹取已在 store.takeListScrollTop 内完成，拿到的就是可写的最终值 —— 这里直接写 DOM。
    //
    // 依赖里必须有 state.loading：同一个 store 的第二次挂载时 items 可能已经在上一次会话里，
    // 本次 overview 落到 state 的数组甚至可能与旧值同引用（缓存 / 夹具）—— 只盯 items 的话
    // 恢复值到达时这个 effect 不会重跑，滚动就停在 0。loading 的 true→false 是「这一轮取数真的
    // 走完了」的业务信号，恢复值恰在它之后交接，所以它必须参与触发。
    useLayoutEffect(() => {
      if (state.view !== 'list') return
      const box = listBox.current
      if (box === null) return
      const saved = store.takeListScrollTop(box.scrollHeight - box.clientHeight)
      if (saved === undefined) return
      box.scrollTop = saved
    }, [store, state.view, state.items, state.loading])

    // 跟随滚动：选中项超出可视区时才滚（j/k 走到边界后屏幕要跟着动——用户实测缺失）。
    // 位置计算在 src/list-scroll.ts 里，是纯函数且有单测；这里只负责量 DOM 并写入。
    useEffect(() => {
      const box = listBox.current
      if (box === null || state.view !== 'list') return
      const selected = state.selectedId
      if (selected === undefined) return
      const row = box.querySelector('[data-rss-row="' + selected + '"]')
      if (!isElementNode(row)) return
      const target = nextScrollTop(box.scrollTop, box.clientHeight, row.offsetTop, row.offsetHeight)
      if (target !== box.scrollTop) box.scrollTop = target
      // 依赖里没有 listBox：它现在是稳定句柄，变了也不该重跑（每次渲染都会变的话反而是噪音）
    }, [state.selectedId, state.view, state.searchRevision])

    // 换文章时的「归零阅读位置 + 解除钉底」已搬进 article-pane（2026-10-15 C2）：它与「内容长高时
    // 继续贴底」是同一个行为的两半，原先分居两文件、同一个 effect 键、改一次要动两个文件。
    //
    // ref 回调写成稳定引用：内联箭头每次渲染都是新函数，React 会在每次提交时先置 null 再挂载。
    const setListBox = useCallback((node: HTMLDivElement | null): void => { listBox.current = node }, [])

    /**
     * 行点击 / Enter / Space 共用：激活（选中 + 标已读）+ 展开切换。
     *
     * 三个入口必须走同一条：此前点击是 toggle、o 是 toggle，而 Enter/Space 写成了「恒展开」——
     * 同一条 GR 规则（o / enter = open/close）在三个地方有三种实现。
     */
    const activateRow = useCallback((itemId: string): void => {
      store.activate(itemId)
      setExpanded((current) => nextExpandedOf(current, itemId))
    }, [store])

    /**
     * 点折叠提示 ⇒ 只展开那一组（R6 03，spec 验收 7）。
     *
     * 函数式更新而不是读 `expandedGroups`：读者可能连点两组，两次都基于**上一次的结果**累加，
     * 不会出现「第二次点击把第一组又收回去」。`ReadonlySet` 要求换新对象，所以这里造一份副本。
     */
    const expandImageGroup = useCallback((groupIndex: number): void => {
      setExpandedGroups((current) => {
        if (current.has(groupIndex)) return current
        const next = new Set(current)
        next.add(groupIndex)
        return next
      })
    }, [])

    /**
     * 换篇 / 换视图时清空**两个**图片覆盖（R6 03 的组级 + 04 的篇级；spec 决策 15）。
     *
     * **两个依赖缺一不可**：
     *  - `articleItemId` 覆盖 `j` / `k` 换篇 —— 连续换篇时 `view` 一直是 `'article'`，只看 `view` 会漏；
     *  - `state.view` 覆盖「Esc 回列表后重开**同一篇**」—— `closeArticle` 只 `set({ view: 'list' })`、
     *    刻意保留 `article`（阅读进度落盘要用它），所以那一刻 `articleItemId` 不变。
     *
     * 不这么做的话：读者点开过第 0 组、换到下一篇，新文章的第 0 组会**凭空是展开的**；
     * 读者按过 `i` 展开整篇、Esc 出去再点回同一篇，会带着上次的篇级覆盖回来（偏好失去意义）。
     * 初值与复位值共用同一个 `EMPTY_IMAGE_GROUPS` 引用 ⇒ 首屏那次复位是 no-op（React 相等即跳过）。
     *
     * 07 的灯箱态也在这条 effect 里清（spec 决策 15 的代码形状：一条 effect 清三个状态）——
     * 换篇时旧文章的 `src` 不该留在一个新文章的浮层里。
     */
    const articleItemId = state.article?.itemId
    useEffect(() => {
      setImagesExpanded(undefined)
      setExpandedGroups(EMPTY_IMAGE_GROUPS)
      // 灯箱一起清（R6 07，spec 决策 15）：`j` / `k` 换篇时灯箱必须关，否则旧文章的图占着新文章的屏。
      // 放这条 effect 而不是 `back` 里，是因为它同时覆盖「Esc 回列表后重开同一篇」那条路径
      // （`closeArticle` 只改 view、刻意保留 article ⇒ 那一刻 articleItemId 不变）。
      setLightboxSrc(undefined)
      // 首次外发确认框同理（R7 06）：换条目 / 离开正文时，待确认的正文与字符数已经不属于
      // 眼前这一篇了，必须收掉 —— 否则回来点「译」会拿着旧文章的字符数去确认新文章的外发。
      store.cancelTranslate()
    }, [articleItemId, state.view, store])

    // 键盘流：挂在 document 上 + 输入框守卫（24 个 action 的判据与路由都在 keyboard-routing.ts）。
    // 原实现挂在面板根节点并要求其持有焦点，导致「必须先点一下页面」才响应（用户实测）。
    // 挂 document 的代价是作用域变宽，因此由 routeKey 内部的 isTypingTarget 挡住输入框/弹层；
    // 面板卸载时监听随 effect 清理一并移除，所以只有阅读器存在时才可能响应。
    // ⚠️ 不走 ctx.shortcuts：平台规则禁止无修饰键的绑定（configuration.ts:100 ——
    // modifiers 为空或全为 shift 即 modifier-required，register 会直接 throw，实测会炸掉整个 client 半）。
    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent): void => {
        routeKey(event, {
          root, store,
          expanded, setExpanded,
          helpOpen, setHelpOpen,
          imagesExpanded, setImagesExpanded,
          expandedGroups, setExpandedGroups,
          lightboxSrc, setLightboxSrc,
          markAllConfirm, setMarkAllConfirm,
        })
      }
      document.addEventListener('keydown', onKeyDown)
      return () => { document.removeEventListener('keydown', onKeyDown) }
      // 依赖数组里**必须**有 expanded 与 helpOpen：routeKey 要**读**它们（Esc 得判断「先关帮助还是
      // 先回列表」；o 得判断「折叠这次展开的行」还是「展开当前行」）。
      //
      // ⚠️ 读到的之所以是「最新值」，**正因为它们在依赖里** —— 监听器因此在每次变化时重新注册。
      // 漏了它，读到的就是**注册那一刻**的值（闭包捕获），不是「永远最新」：2026-10-15 独立评审实测，
      // 拿掉 expanded 后按 o 永远收不起来，而当时全套 402 条测试全绿；
      // 判据现已落在 tests/scroll-dom.test.mjs 的「同一行连按两次 o 必须收起」。
      //
      // 两个 setter **不进**依赖：它们的调用点全是函数式更新（setExpanded((current) => …)），
      // setter 身份跨渲染稳定，放进去只是让 effect 白跑。
      //
      // `imagesExpanded`（R6 04）同理**必须**在依赖里：`i` 的语义是「翻基线」，而基线 =
      // `imagesExpanded ?? 偏好`，`routeKey` 要读它。漏了它，第二次按 `i` 仍读到注册那一刻的
      // `undefined` ⇒ 又写一次「展开」，图片收不起来 —— 正是「同一行连按两次 o」的同族事故。
      // 判据落在 tests/scroll-dom.test.mjs 的「i 键切换整篇图片…（依赖数组没漏）」。
      //
      // `expandedGroups` 是唯一一个**只写不读**的依赖（`routeKey` 里 `grep ctx.expandedGroups`
      // 零命中：`i` 只调 `ctx.setExpandedGroups`，从不读它），所以它严格来说不必在数组里。
      // 保留它是个**取舍**，理由如实写在这里，免得下一个人以为是漏看：
      //   · 拿掉它实测全绿（scroll-dom 147 + keyboard-routing 24 条），行为确实不变 ——
      //     因为写入路径是 `setExpandedGroups(EMPTY_IMAGE_GROUPS)`（常量，不依赖旧值）。
      //   · 但它是**本 effect 依赖数组尾部**那三行变异（`client-helpOpen 不进依赖数组` /
      //     `client-i 的状态不在依赖数组里` / `client-灯箱态不在依赖数组里`）的锚点上下文。
      //     拿掉它要给三条变异一起重锚，而这些变异守的是别人的判据（helpOpen / imagesExpanded
      //     / lightboxSrc），与 `expandedGroups` 无关 —— 为一次零收益的重构去动三条门槛条目，
      //     风险大于收益。
      //   · 将来若真有一处要**读** `expandedGroups`（例如「按 i 后回到上一次点开的组」），
      //     它已经在数组里，不会重演「闭包捕获旧值」那一族事故（pitfalls §3.1）。
      // 换句话说：留着是**有意的保守**，不是忘了删。真要删，请把上面三条变异的重锚一起做。
      //
      // `lightboxSrc`（R6 07）**必须**在依赖里，而且理由与 `expanded` 完全同源：`back` 要**读**
      // 它判断「这一下 Esc 是关灯箱还是关文章」。漏了它，`Esc` 读到的永远是注册那一刻的
      // `undefined` ⇒ 灯箱开着时按 Esc 直接把文章关了（灯箱随着视图切换一起消失，看起来
      // 「关掉了」，其实是退出了正文）。判据落在 tests/scroll-dom.test.mjs 的
      // 「Esc 关灯箱但不退出正文」与「帮助 → 灯箱 → 正文」两条。
      // `markAllConfirm`（2026-11-21）同理：`back` 要**读**它判断「这一下 Esc 是关确认框还是别的东西」。
      // 漏了它，刚开框的那一瞬按 Esc 会径直去关灯箱 / 退正文 —— 而且焦点还没进框时 document 层
      // 是唯一能收到 Esc 的地方（框内按键会被 isTypingTarget 拦下，由对话框自己处理）。
    }, [root, store, expanded, helpOpen, imagesExpanded, expandedGroups, lightboxSrc, markAllConfirm])

    const items = store.visible()
    /**
     * 账目与当前档位是否对齐（R1 评审 P1）：切档后 displayWindow 立刻变了，而账目（以及它的
     * accountWindow 标记）要等新档第一页回包才换。不对齐期间界面上的任何数字都可能属于
     * **另一个窗口** —— 顶栏、左栏每源/文件夹角标、侧栏徽标必须一起闭嘴，而不是各显示各的。
     */
    const accountAligned = state.accountWindow === state.displayWindow
    const failing = state.feeds.filter((feed) => feed.lastFailure)
    // 顶栏那组 filter 按钮与键盘导航的行序共用同一份定义（见 VIRTUAL_VIEWS 的注释）
    const filters = VIRTUAL_VIEWS
    const { navSelection } = state
    const selectedFeed = navSelection.kind === 'feed'
      ? state.feeds.find((feed) => feed.id === navSelection.feedId)
      : undefined
    const selectedFolder = navSelection.kind === 'folder'
      ? state.folders.find((folder) => folder.name === navSelection.folder)
      : undefined
    const selectedTag = navSelection.kind === 'tag'
      ? state.tags.find((tag) => tag.id === navSelection.tagId)
      : undefined
    // 搜索表单里的「订阅源」多选只列当前范围（文件夹）内的源：范围外勾选与文件夹取交集恒为空，
    // 摆出来只会让用户以为筛选坏了。
    const searchScopeFeeds = navSelection.kind === 'folder'
      ? state.feeds.filter((feed) => feed.folder === navSelection.folder)
      : state.feeds
    const activeArticle = state.view === 'article'
      ? state.items.find((entry) => entry.id === state.article?.itemId)
      : undefined
    /**
     * 当前正文的译文（R7 01）：从 store 按「条目 + 正文版本 + 目标语言」现查。
     * 不把整张 Map 传进 ArticleView —— 组件只该看见这一篇的那一条。
     */
    const articleTranslation = state.article === undefined
      ? undefined
      : translationEntryOf(state, state.article.itemId, state.article.contentVersion, state.translateTarget)
    /** 在飞的批（R7 优化）：key 必须与当前这篇的译文键一致，否则旧场次的占位会画到别的文章上。 */
    const articleTranslationPending = state.translatePending !== undefined
      && articleTranslation !== undefined && state.translatePending.key === articleTranslation.key
      ? state.translatePending.indices
      : undefined
    const tagTarget = state.view === 'article'
      ? activeArticle
      : state.items.find((item) => item.id === state.selectedId)
    /**
     * 探索入口的可见性（R8b 04 / D11 → R15 01 实例池）：两处入口共用这一份判据 ——
     * 宿主下发的生效实例池是否非空。
     *
     * 地址合法性已经在宿主侧由 `parseRsshubBase` 判过（坏项在 `config.json` 读取时就被丢弃）；
     * 客户端不再解析第二遍，也不看遗留的 `settings.rsshubBase` —— 空池就是功能关闭，
     * 即使旧键还留着也不能让入口诈尸。
     */
    const exploreAvailable = (state.rsshubSettings?.instances.length ?? 0) > 0

    return (
      <div ref={setRoot} tabIndex={0} {...{ [ROOT_ATTR]: '' }}
        // position:relative 是必需的：帮助浮窗用 absolute 定位挂在根内，根没有定位时会挂到
        // 最近的定位祖先（或页面）上，浮窗跑出面板。与列表容器那条同一条理由（见下面 setListBox）。
        style={{ position: 'relative', display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 14, lineHeight: 1.55, outline: 'none' }}>
        <style>{STYLE}</style>
        {/* 横向 flex 由这一层承担：左栏常驻导航，右栏沿用原来的纵向结构（内部一律不动）。
            折叠时**不渲染左栏**而不是给它 width:0 —— width:0 会留下一条边框的缝，
            而「收起」在视觉上必须等于「这一列不存在」。 */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {state.navVisible && (
          <FeedNav
            feeds={state.feeds}
            folders={state.folders}
            tags={state.tags}
            perFeedUnread={accountAligned ? state.perFeedUnread : NO_UNREAD}
            filter={state.filter}
            navSelection={state.navSelection}
            navCursor={state.navCursor}
            foldedFolders={state.foldedFolders}
            showUnread={state.showUnread}
            sourcePackActive={state.view === 'sourcePack'}
            onSelectFilter={(next) => store.setFilter(next)}
            onSelectFeed={(feedId) => store.selectNav({ kind: 'feed', feedId })}
            onSelectFolder={(folder) => store.selectNav({ kind: 'folder', folder })}
            onSelectTag={(tagId) => store.selectNav({ kind: 'tag', tagId })}
            onToggleFolder={store.toggleFolder}
            onOpenSourcePack={store.openSourcePack}
          />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <div className="dsh-rss-toolbar">
          <div className="dsh-rss-toolbar-title">
            <strong>{state.view === 'list'
              ? selectedFeed?.title ?? selectedFolder?.name ?? selectedTag?.name ?? filters.find((filter) => filter.key === state.filter)?.label
              : state.view === 'sourcePack' ? '精选源' : 'RSS 阅读器'}</strong>
            {state.view === 'list' && (
              <div className="dsh-rss-meta dsh-rss-counts">
                {/* 时间范围档位（R1-03，spec 决策 22）：只在列表视图、与「已加载 X 条」同一行。
                    原生 select = Tab 可达、键盘可操作；焦点在它上面时键盘路由的输入控件守卫
                    （keyboard-routing.ts 的 isTypingTarget，已把 SELECT 算作输入控件）会放行，
                    j / k / 空格不会吞键。搜索有自己的日期筛选（UTC 日界，口径不同），
                    所以搜索进行中禁用并给出可见原因（spec 决策 27）。 */}
                <select className="dsh-rss-window" data-rss-window="" aria-label="时间范围"
                  value={state.displayWindow}
                  disabled={state.search !== undefined}
                  title={state.search !== undefined
                    ? '搜索进行中不可用：搜索有自己的日期筛选，退出搜索后可切换'
                    : '按本地自然日筛选列表与未读计数'}
                  {...windowSelect.pointer}
                  onChange={(event) => {
                    void store.setWindow(event.target.value as DisplayWindowRange)
                    // 选完把焦点还给面板：原生 select 会一直持有焦点，而键盘守卫会吞掉随后所有按键
                    // （2026-11-21 实测：「改完时间范围 → 按 A」毫无反应）。
                    windowSelect.commit()
                  }}>
                  {DISPLAY_WINDOW_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                {state.search !== undefined && (
                  <span className="dsh-rss-window-hint" data-rss-window-reason="">搜索进行中不可用：搜索有自己的日期筛选</span>
                )}
                {state.showUnread && (accountAligned
                  ? (
                    // 数字与三分全部来自宿主回包（state.unread / state.unreadSplit），客户端不数条目。
                    <span data-rss-unread-count="">{unreadCountTextOf(state.displayWindow, state)}</span>
                  )
                  : (
                    // 账目还没换到当前档位（R1 评审 P1）：宁可说「正在统计…」，也不能把别的窗口的数字
                    // 挂在当前档位名下。data-rss-unread-pending 就是这段静默期的可断言标记。
                    <span data-rss-unread-pending="" title="正在按当前时间范围重新统计未读">正在统计…</span>
                  ))}
                <span>已加载 {state.items.length} 条</span>
              </div>
            )}
          </div>
          {/* 过滤三连（全部/未读/星标）与左栏顶部那三行是**同一个状态**（都走 store.setFilter）。
              左栏可见时由左栏承担显示与切换 —— 同一状态摆两处，读者会问「哪边算数」（用户实测反馈）。
              左栏收起（u 键）时回落到顶栏，保证「收起导航」不会让过滤失去入口。 */}
          {!state.navVisible && (
            <span style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
              {filters.map((filter) => (
                <button key={filter.key} type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                  onClick={() => store.setFilter(filter.key)}
                  style={{
                    fontWeight: state.filter === filter.key ? 600 : 400,
                    opacity: state.filter === filter.key ? 1 : 0.65,
                  }}>
                  {filter.label}
                </button>
              ))}
            </span>
          )}
          <div className="dsh-rss-actions">
          {/* 那行塞满键位的提示行于 2026-10-10 收进「?」帮助浮窗：它既挤，又必须与 keys.ts 逐字
              同步（本仓库为「标签与实现各说各话」付过两次学费）。浮窗现在逐行渲染 keys.ts 的
              READER_KEY_HELP —— 界面文案不再有第二份，同步这件事从「靠人记」变成「靠测试」。 */}
          <button type="button" className="dsh-rss-btn"
            title="订阅管理：导入/导出 OPML、加源、退订（F 键）"
            onClick={() => store.toggleFeeds()}>订阅</button>
          <button type="button" className="dsh-rss-btn" disabled={state.loading}
            title="抓取本轮订阅源（受最小间隔节流）"
            onClick={() => { void store.load('refresh') }}>
            <RefreshIcon spinning={slowLoading} />
            {slowLoading ? '刷新中…' : '刷新'}
          </button>
          {/* R11 05：工具栏「更多」已整个撤销 —— 04 把清理搬进设置页后它只剩「显示未读计数」，
              05 再把这一项搬进设置页「显示」区，菜单已没有任何条目。样式表里的
              `.dsh-rss-settings` / `.dsh-rss-settings-panel` 仍被正文页 Aa 面板复用，所以不动。 */}
          {/* 设置入口（R11 01，D19）：放在「刷新」与「?」之间；再点一次回列表（与 F 的 toggle 同型）。
              所有视图都可见 —— 工具栏本来就常驻，不给它按视图分叉。 */}
          <button type="button" className="dsh-rss-btn" data-rss-settings-open=""
            title="设置：每次刷新抓取源数与运行参数" aria-pressed={state.view === 'settings'}
            onClick={() => store.toggleSettings()}>设置</button>
          {/* 帮助入口放最右端：它是「说明书」，与左边那三个动作按钮不是一类东西。
              点击与按 ? 键走同一个开关，不写第二份逻辑。 */}
          <button type="button" className="dsh-rss-btn" style={{ fontWeight: 600 }}
            title="快捷键帮助（?）" aria-label="快捷键帮助" aria-expanded={helpOpen}
            onClick={() => setHelpOpen((open) => !open)}>?</button>
          </div>
        </div>
        {slowLoading && <div className="dsh-rss-bar" aria-hidden="true" />}

        {state.view === 'list' && (
          <form key={state.search ? 'active' : 'idle'} className="dsh-rss-toolbar" role="search" onSubmit={(event) => {
            event.preventDefault()
            const form = new FormData(event.currentTarget)
            const read = form.get('read')
            const feedIds = form.getAll('feed').map(String)
            store.submitSearch({
              text: String(form.get('text') ?? ''),
              from: String(form.get('from') || '') || undefined,
              to: String(form.get('to') || '') || undefined,
              read: read === 'read' || read === 'unread' ? read : undefined,
              starred: form.has('starred'),
              feedIds: feedIds.length ? feedIds : undefined,
            })
            root?.focus()
          }}>
            <input data-rss-search-input="" name="text" type="search" aria-label="搜索本地文章" placeholder="搜索本地文章" defaultValue={state.search?.text} />
            <button type="submit" className="dsh-rss-btn">搜索</button>
            {state.search && <button type="reset" className="dsh-rss-btn" onClick={() => store.submitSearch()}>退出搜索</button>}
            <details>
              <summary>搜索筛选</summary>
              <label> 已读状态 <select name="read" defaultValue={state.search?.read ?? ''}
                {...searchReadSelect.pointer} onChange={() => { searchReadSelect.commit() }}>
                <option value="">不限</option><option value="unread">未读</option><option value="read">已读</option>
              </select></label>
              <label><input name="starred" type="checkbox" defaultChecked={state.search?.starred} /> 仅星标</label>
              <label> 起始日期 <input name="from" type="date" defaultValue={state.search?.from} /></label>
              <label> 结束日期 <input name="to" type="date" defaultValue={state.search?.to} /></label>
              {navSelection.kind === 'folder' && (
                <small className="dsh-rss-meta" data-rss-search-folder={navSelection.folder}>
                  搜索范围：文件夹「{navSelection.folder}」
                </small>
              )}
              {navSelection.kind === 'tag' && (
                <small className="dsh-rss-meta" data-rss-search-tag={navSelection.tagId}>
                  搜索范围：标签「{selectedTag?.name ?? navSelection.tagId}」
                </small>
              )}
              {searchScopeFeeds.length > 1 && <fieldset>
                <legend>订阅源</legend>
                {searchScopeFeeds.map((feed) => <label key={feed.id} style={{ display: 'block' }}>
                  <input name="feed" type="checkbox" value={feed.id} defaultChecked={state.search?.feedIds?.includes(feed.id)} /> {feed.title}
                </label>)}
              </fieldset>}
            </details>
            {state.search && <small className="dsh-rss-meta">正文仅搜索已缓存内容</small>}
            {state.search && state.loading && <span role="status">正在搜索…</span>}
          </form>
        )}
        {state.error !== undefined && <div className="dsh-rss-status dsh-rss-status--error" role="alert">{state.error}</div>}
        {state.notice !== undefined && (
          <div className="dsh-rss-status">
            <span role="status">{state.notice}</span>
            <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
              style={{ marginLeft: 8 }} onClick={() => store.dismissNotice()}>知道了</button>
          </div>
        )}
        {state.undo !== undefined && (
          <div style={{ padding: '6px 20px', fontSize: 12, background: 'color-mix(in srgb, currentColor 8%, transparent)' }}>
            已把 {state.undo.ids.length} 条标为已读 ·{' '}
            {/* 点完撤销把焦点还给面板：撤销条随即消失，焦点会掉到 body —— 之后按 A / j 全都
                静默失效（与下拉框那条同族，2026-11-21 真机实测：撤销后 activeElement=body）。 */}
            <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
              onClick={() => { void store.undoMarkAll(); root?.focus() }}>撤销</button>
          </div>
        )}
        {failing.length > 0 && (
          <div style={{ padding: '6px 20px', opacity: 0.75, fontSize: 12 }}>
            {/* 连败次数缺失（老记录）时写「次数未知」，不补 0：把「不知道」写成「0 次失败」是撒谎 */}
            {failing.length} 个源抓取失败：{failing.map((feed) => feed.title
              + '（' + (feed.failureCount === undefined ? '次数未知' : '连续 ' + feed.failureCount + ' 次') + '：' + feed.lastFailure + '）').join('；')}
          </div>
        )}

        {(state.view === 'list' || state.view === 'article') && tagTarget !== undefined && (
          <TagEditor tags={state.tags} activeIds={tagTarget.tagIds ?? []} onToggle={store.toggleItemTag} />
        )}

        {state.view === 'feeds' && (
          <FeedsView
            feeds={state.feeds}
            folders={state.folders}
            busy={state.feedsBusy}
            report={state.importReport}
            notice={state.notice}
            discovery={state.discovery}
            onImport={(text) => { void store.importOpml(text) }}
            onExport={() => { void store.exportOpml() }}
            onAdd={(url) => { void store.addFeed(url) }}
            onDiscover={(url) => { void store.discover(url) }}
            onProbe={(urls) => store.probe(urls)}
            onClearDiscovery={() => { store.clearDiscovery() }}
            onRemove={(url) => { void store.removeFeed(url) }}
            onCreateFolder={(name) => { void store.createFolder(name) }}
            onRenameFolder={(from, to) => { void store.renameFolder(from, to) }}
            onDeleteFolder={(name) => { void store.deleteFolder(name) }}
            onMoveFeed={(feedId, folder) => { void store.moveFeedToFolder(feedId, folder) }}
            onMoveOrder={(feedId, direction) => { void store.moveFeedOrder(feedId, direction) }}
            onBackfill={(feedId, archiveUrl, limit) => store.backfill(feedId, archiveUrl, limit)}
            tags={state.tags}
            onCreateTag={(name) => { void store.createTag(name) }}
            onRenameTag={(id, name) => { void store.renameTag(id, name) }}
            onDeleteTag={(id) => { void store.deleteTag(id) }}
            onBack={() => store.toggleFeeds()}
            exploreAvailable={exploreAvailable}
            onExplore={openExplore}
          />
        )}

        {state.view === 'article' && (
          <ArticleView
            article={state.article}
            item={activeArticle}
            onBack={() => store.closeArticle()}
            // 重试抓取当前正文页那一篇：store 按 article.itemId 取数，不用 selectedId（R4-B4）。
            onRetry={store.retryArticle}
            // 不再传 setBox：阅读容器的滚动生命周期（换文章归零 / 内容长高贴底）已归 article-pane
            // 自己（2026-10-15 C2）；键盘那条路径按键时刻按 scrollAttr 现取容器，不需要跨组件 ref 桥接。
            scrollAttr={SCROLL_ATTR}
            reading={state.reading}
            onReading={store.setReading}
            onSaveProgress={store.saveArticleProgress}
            expandedGroups={expandedGroups}
            onExpandImageGroup={expandImageGroup}
            imagesExpanded={imagesExpanded}
            // 灯箱（R6 07）：状态在本组件（`routeKey` 的 `back` 要读它），这里只传值与两个写入回调。
            lightboxSrc={lightboxSrc}
            onOpenImage={setLightboxSrc}
            onCloseLightbox={() => setLightboxSrc(undefined)}
            translation={articleTranslation}
            translationPending={articleTranslationPending}
            // 两态（R7 03）：值在 store，正文面只照着画；切换动作只改渲染态、不发 rpc。
            translationMode={state.translationMode}
            onTranslationMode={store.setTranslationMode}
            // 可用性与目标语言（R7 02）：不可用时工具栏不渲染语言下拉与「译」按钮。
            translateAvailable={state.translationInfo?.available === true}
            translateTarget={state.translateTarget}
            onTranslateTarget={store.setTranslateTarget}
            // 点击时把视口矩形交给动作层（R7 04）：选批是纯函数，组件只负责量。
            // R7 06：入口改走 requestTranslate —— 首次外发先弹确认框，t 键与按钮共用这一条。
            onTranslate={(geometry) => { void store.requestTranslate(geometry) }}
            onContinueTranslate={(geometry) => { void store.continueTranslate(geometry) }}
            onRetranslate={(geometry) => { void store.retranslate(geometry) }}
            translateConfirm={state.translateConfirm}
            onConfirmTranslate={(geometry) => { void store.confirmTranslate(geometry) }}
            onCancelTranslate={store.cancelTranslate}
            // 组件卸载（切面板 / 离开正文面）时中止后续批；在途那批允许跑完。
            onStopTranslate={store.stopTranslate}
            // 失败批的重试（R7 05）：组件只交回批首下标，整批 indices 由动作层从 store 找回。
            onRetryBatch={(headIndex) => { void store.retryBatch(headIndex) }}
            canPrev={store.canStepArticle(-1)}
            canNext={store.canStepArticle(1)}
            onPrev={() => { store.stepArticle(-1) }}
            onNext={() => { store.stepArticle(1) }}
          />
        )}

        {state.view === 'explore' && state.explore !== undefined && (
          <ExploreView
            state={state.explore}
            onQuery={store.setExploreQuery}
            hideNsfw={state.rsshubSettings?.hideNsfw ?? true}
            onlyRunnable={state.onlyRunnable}
            onToggleHideNsfw={(hideNsfw) => { void store.setExploreHideNsfw(hideNsfw) }}
            onLoadMore={() => { void store.loadMoreExplore() }}
            onSelectRoute={store.selectExploreRoute}
            onDraftValue={store.setExploreDraftValue}
            onBuild={() => { void store.buildExploreAddress() }}
            onAdd={() => { void store.addExploreSubscription() }}
            onBack={() => store.closeExplore()}
          />
        )}

        {state.view === 'sourcePack' && state.sourcePack !== undefined && (
          <SourcePackView
            state={state.sourcePack}
            onQuery={store.setSourcePackQuery}
            onCategory={store.setSourcePackCategory}
            onOpenForm={store.openSourcePackForm}
            onCloseForm={store.closeSourcePackForm}
            onDraft={store.setSourcePackDraft}
            onProbe={() => { void store.probeSourcePackUrl() }}
            onSave={(force) => { void store.saveSourcePackDraft(force === true) }}
            onRemove={(url) => { void store.removeSourcePackEntry(url) }}
            onRestoreSeed={() => { void store.restoreSourcePackSeed() }}
            onBack={store.closeSourcePack}
          />
        )}

        {state.view === 'settings' && (
          <SettingsView
            settings={state.settings}
            error={state.settingsError}
            rsshub={state.rsshubSettings}
            rsshubError={state.rsshubSettingsError}
            warningDismissed={state.settingsWarningDismissed}
            reading={state.reading}
            onReading={(patch) => store.setReading(patch)}
            showUnread={state.showUnread}
            onShowUnread={(value) => store.setShowUnread(value)}
            translationInfo={state.translationInfo}
            onSaveTranslateRoute={(patch) => store.saveTranslateRoute(patch)}
            onClose={() => store.closeSettings()}
            onDismissWarning={() => store.dismissSettingsWarning()}
            onSave={(key, value) => store.saveSetting(key, value)}
            onReset={() => store.resetSettings()}
            onTestRsshub={(base) => store.testRsshub(base)}
            onSaveRsshub={(instances) => store.saveRsshubInstances(instances)}
            onCleanupPreview={() => store.cleanupPreview()}
            onCleanup={() => store.cleanup()}
            onManageFeeds={() => store.toggleFeeds()}
            exploreAvailable={exploreAvailable}
            onExplore={openExplore}
          />
        )}

        <div ref={setListBox} {...{ [SCROLL_ATTR]: 'list' }} style={{
          // position:relative 是必需的：row.offsetTop 以最近的定位祖先为参照，
          // 少了它量到的是相对页面/body 的位置，滚动计算会整体偏掉。
          position: 'relative',
          flex: 1, minHeight: 0, overflowY: 'auto',
          display: state.view === 'list' ? 'block' : 'none',
          opacity: slowLoading ? 0.6 : 1, transition: 'opacity 150ms ease',
        }}>
          {!state.loading && items.length === 0 && (!state.search || !state.error) && (
            <div style={{ padding: 20, opacity: 0.7 }}>
              {state.search
                ? '没有找到匹配的本地文章。'
                // 档位非「全部」且列表为空：这是**真空**，不是加载失败 —— 明说档位名并提示换档，
                // 但绝不自动放宽（spec 决策 26 / 验收 13）。有 error 时走下面的既有文案，
                // 错误条照旧显示，不用空态掩盖。
                : state.displayWindow !== 'all' && state.error === undefined
                  ? '「' + displayWindowNameOf(state.displayWindow) + '」内暂无内容，可换一个时间范围。'
                  : navSelection.kind === 'folder'
                  ? (selectedFolder?.feedIds.length === 0
                    ? '这个文件夹还没有订阅源。可以在订阅管理里把订阅移进来。'
                    : state.filter === 'starred'
                      ? '这个文件夹里还没有星标条目。'
                      : state.filter === 'unread'
                        ? '这个文件夹里没有未读条目。'
                        : '这个文件夹里还没有条目。')
                  : navSelection.kind === 'tag'
                    ? (selectedTag?.itemCount === 0
                      ? '这个标签还没有文章。可以在列表或正文的标签栏里给它添加文章。'
                      : state.filter === 'starred'
                        ? '这个标签下还没有星标条目。'
                        : state.filter === 'unread'
                          ? '这个标签下没有未读条目。'
                          : '这个标签下还没有条目。')
                    : state.filter === 'starred' ? '还没有星标条目。' : state.filter === 'unread' ? '没有未读条目。' : '还没有条目。可以在订阅管理中添加订阅源或导入 OPML。'}
            </div>
          )}
          {items.map((item) => {
            // expanded 视图下每条都带正文摘录；list 视图下只有 o 展开的那一条（GR 的 o 就是 list 专用）
            const isOpen = state.layout === 'expanded' || expanded === item.id
            // 历史行可能带脏 link（修复前落库的 javascript:）：渲染前过 shared.ts 的唯一白名单。
            // 空串 = 既有的「无链接」语义（不渲染「打开原站」、也不留点击间距）。
            const safeLink = httpUrlOrEmpty(item.link)
            const unread = item.readAt === undefined
            const selected = state.selectedId === item.id
            // R12：作者只由 src/author.ts 在读路径归一化；这里直接用投影值，不再加桩件守卫。
            const author = item.author
            return (
              <div key={item.id} className="dsh-rss-row" data-rss-row={item.id}
                data-rss-unread={unread ? '' : undefined} data-rss-selected={selected ? '' : undefined}>
                <div role="button" tabIndex={0} className="dsh-rss-row-main"
                  onClick={() => { activateRow(item.id) }}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateRow(item.id) } }}
                  >
                  <span aria-hidden="true" className="dsh-rss-dot" />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="dsh-rss-row-title">
                      {item.starred ? '★ ' : ''}{item.keptUnread === true ? '⚑ ' : ''}{item.title || item.link || '(无标题)'}
                    </span>
                    <span className="dsh-rss-meta" style={{ marginTop: 2 }}>
                      {selectedFeed === undefined && item.feedTitle + ' · '}
                      {author !== undefined && (
                        <>
                          <span className="dsh-rss-author" data-rss-author="" title={author}>{author}</span>
                          {' · '}
                        </>
                      )}
                      {relativeTime(recencyOf(item))}
                    </span>
                    {/* 跨源重复提示（M5 03）：只提示、不合并 —— 每个源仍保留自己的 id / 已读 / 星标。
                        点击与空格都要 stopPropagation：整行是个 role=button（会选中+标读），
                        展开提示不该顺手把那篇文章标成已读。 */}
                    {state.duplicates[item.id] !== undefined && (
                      <details className="dsh-rss-dupes" data-rss-duplicates={item.id}
                        onClick={(event) => event.stopPropagation()}>
                        <summary onKeyDown={(event) => { if (event.key === ' ') event.stopPropagation() }}>
                          另有 {state.duplicates[item.id].length} 个来源
                        </summary>
                        <span className="dsh-rss-dupes-list">
                          {state.duplicates[item.id].map((other) => {
                            // 历史行可能带脏 link：渲染期统一过白名单。空 href 会变成「点一下刷新当前页」，
                            // 所以认不出就退成纯文本，不做可点链接。
                            const href = httpUrlOrEmpty(other.link)
                            const label = other.feedTitle + ' · ' + (other.title || other.link)
                            return href === ''
                              ? <span key={other.itemId} data-rss-dupe-item={other.itemId}>{label}</span>
                              : <a key={other.itemId} href={href} target="_blank" rel="noreferrer"
                                  data-rss-dupe-item={other.itemId}>{label}</a>
                          })}
                        </span>
                      </details>
                    )}
                    {isOpen && (
                      <span className="dsh-rss-summary">
                        {(() => {
                          const paragraphs = paragraphsOf(item.summary)
                          // 「勉强算有正文」不该冒充正文：像 HN 那样 feed 里只有一串 Comments 链接时，
                          // 剥完标签只剩几个字符——与其显示一行孤零零的 "Comments"，不如如实说明。
                          // 门槛与判据都住在 shared.ts（hasBodyText），与正文面的回退内容共用一份。
                          if (!hasBodyText(paragraphs)) {
                            return (
                              <span style={{ display: 'block', opacity: 0.7 }}>
                                {paragraphs.length === 0
                                  ? '（此源未提供正文，点下面到原站阅读）'
                                  : '（此源只提供标题与外链，正文在原站）'}
                              </span>
                            )
                          }
                          return paragraphs.map((paragraph, index) => (
                            <span key={index} style={{ display: 'block', margin: index === 0 ? '0' : '0.6em 0 0' }}>{paragraph}</span>
                          ))
                        })()}
                        {/* 「保持未读」按规格是**条目下方的链接**（GR 没给它快捷键），所以这里不放键位 */}
                        <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                          style={{ fontSize: 12, marginTop: 8, marginRight: safeLink === '' ? 0 : 12 }}
                          onClick={(event) => { event.stopPropagation(); void store.toggleKeepUnread(item.id) }}>
                          {item.keptUnread === true ? '取消保持未读' : '保持未读'}
                        </button>
                        {safeLink !== '' && (
                          <a href={safeLink} target="_blank" rel="noreferrer" style={{ fontSize: 12, display: 'inline-block', marginTop: 8 }}>打开原站 ↗</a>
                        )}
                      </span>
                    )}
                  </span>
                </div>
              </div>
            )
          })}
          {/* 续页入口（keyset 分页）：只在宿主明确给出续页游标时出现 —— 缺省即到底。
              刻意**不做无限滚动**：那要引入滚动事件 + 阈值判定（常驻监听器），而本插件的验收项里
              有一条是「卸载不留残余资源」；一个显式按钮同样把第 301 条之后送达，代价却小得多。
              在途时禁用（loadingMore）：连点会堆出多个请求，每次都要过一次 SQL 与一次 feeds 文件读。 */}
          {state.nextCursor !== undefined && (
            <div style={{ padding: '10px 20px', textAlign: 'center' }}>
              {/* 只由续页自身在途（loadingMore）禁用：刷新期间启用「加载更多」是既有行为，
                  在途续页由列表版本号作废；切档时 nextCursor 已被 setWindow 清空，这一行根本不渲染。 */}
              <button type="button" className="dsh-rss-btn" disabled={state.loadingMore}
                onClick={() => { void store.loadMore() }}>
                {state.loadingMore ? '加载中…' : '加载更多'}
              </button>
            </div>
          )}
          </div>
        </div>
        </div>
        {/* 浮窗挂在面板根内：这样「面板不可见即不响应」与「卸载即清理」两条既有约束自动覆盖它，
            不必为浮窗单开一套生命周期。 */}
        {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} />}
        {/* A 的确认框：与帮助浮窗同一处挂载（面板根内）—— 面板不可见即不渲染、卸载即清理。 */}
        {markAllConfirm && (
          <MarkAllConfirm
            state={state}
            store={store}
            onCancel={closeMarkAllConfirm}
            onConfirm={() => { void store.markAllRead(); closeMarkAllConfirm() }}
          />
        )}
      </div>
    )
  }
}

/**
 * 侧栏未读徽标。数据源是**同一个 store 的 state.unread**（宿主下发的账目，切档后就是窗内账），
 * 不另存「全局总数」——那会变成第二套账目口径（spec 补充说明）。
 *
 * 刻意 export 给 DOM 层测试：R1-03 要断言「切档后徽标与顶栏是同一个数」，而这颗组件不在
 * Reader 树里（它是 sidebar.toggle.badge 座位单独注册的），测试只能自己挂一次。
 */
export function Badge({ store }: { store: ReaderStore }): ReactNode {
  const state = useReaderStore(store)
  // 计数被隐藏时徽标也必须消失 —— 否则「隐藏」只做了一半
  // 账目还没换到当前档位时（R1 评审 P1）同样不显示：这个数是上一个窗口的，挂在这里就是撒谎。
  if (!state.showUnread || state.accountWindow !== state.displayWindow || state.unread === 0) return null
  return <span title={state.unread + ' 条未读'} style={{ fontSize: 10 }}>{state.unread > 99 ? '99+' : state.unread}</span>
}

/**
 * 插件入口。
 *
 * @param deps 可选的依赖覆盖（与 createReaderStore 同一个 ReaderStoreDeps）。生产宿主只传 ctx；
 *   测试传第二个参数就能换掉通道 / 定时器 / opener —— 否则「经由 apply 建的 store」永远只能用
 *   浏览器默认实现，而那种用例要么伪造全局 fetch，要么根本没得测（2026-11-15 实测：client-bundle
 *   的 apply 路径在沙箱里直接 ReferenceError: fetch is not defined）。
 */
export function apply(ctx: ClientContext, deps?: Partial<ReaderStoreDeps>): void {
  const store = createReaderStore(deps)
  const Reader = createReader(store)

  // 阅读器本体进主栏；id 必须与 panellist 图标的 id 相同，否则点图标会抛错
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL_ID },
    Reader,
  )), 'dsh-rss-reader: main panel')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'RSS 阅读器' },
    ReaderIcon,
  )), 'dsh-rss-reader: panellist icon')

  // 未读徽标：数据源就是上面那个共享 store；启动先拉一次，之后每次面板刷新都会更新。
  // ⚠️ 这个座位是 single 且已被官方 DesktopUpdateIndicator 以**默认优先级 0** 占用；
  // slots 的规则是「同一 cell 同优先级的第二次注册直接抛错」（ui-slots:1134-1140），
  // 而「cell 内最低优先级的条目渲染」。故显式给 -1：既避开抛错，又让本插件渲染。
  ctx.effect(() => ctx.slots.inject('sidebar.toggle.badge', () => ctx.slots.register(
    { name: 'sidebar.toggle.badge', priority: -1 },
    () => <Badge store={store} />,
  )), 'dsh-rss-reader: unread badge')
  void store.load('overview')

}
