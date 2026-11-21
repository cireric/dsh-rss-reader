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
import { createReaderStore, nextExpandedOf, relativeTime, useReaderStore, VIRTUAL_VIEWS, type Filter, type MarkAllRange, type ReaderStore, type ReaderStoreDeps } from './store.js'
import { DISPLAY_WINDOW_OPTIONS, displayWindowNameOf, unreadCountTextOf } from './window-control.js'
import type { DisplayWindowRange } from '../display-window.js'
// 导出面是构建产物对外的契约（契约测试直接调它），store 搬家后仍要从入口转出去
export { createReaderStore }
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
 * 「没有被点开过的图片组」—— 模块级常量而不是每次 `new Set()`。
 *
 * 两处用途：① `useState` 的初值；② 换篇 / 换视图时的复位值。同一个引用让「空组覆盖」在
 * 多次复位之间保持稳定，也让依赖数组里那个值不会因为「又造了一个空 Set」而白跑一遍 effect。
 * `ReadonlySet` 是刻意的：写入一律换新对象（`new Set(previous).add(n)`），不原地改 ——
 * 原地改会让 `foldOf` 的快照与 React 的相等判断同时失灵。
 */
const EMPTY_IMAGE_GROUPS: ReadonlySet<number> = new Set<number>()


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
.dsh-rss-counts { display:flex; flex-wrap:wrap; gap:2px 12px; margin-top:3px; }
/* 时间范围档位（R1-03）：与计数同一行的原生 select。font:inherit 让它跟 .dsh-rss-meta 的
   12px 走；显式 max-width 是为了窄面板下不把「已加载 N 条」挤到第二行（值为自然日名，最长 5 字）。 */
.dsh-rss-window { font:inherit; font-size:12px; line-height:1.4; max-width:8.5em;
  padding:1px 4px; border-radius:4px; color:inherit; background:var(--rss-bg);
  border:1px solid var(--rss-line); }
.dsh-rss-window:disabled { opacity:.55; }
.dsh-rss-window-hint { font-size:11px; color:var(--rss-muted); }
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
    /** 帮助浮窗开合。它进 keydown effect 的依赖数组（见那条 effect 的收尾注释）。 */
    const [helpOpen, setHelpOpen] = useState(false)
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

    // 打开面板即刷新（主进程侧有最小间隔节流），并把焦点收到列表上，键盘立即可用
    useEffect(() => {
      void store.load('refresh')
    }, [])
    // 关面板时把待写的阅读位置落一次（R2-01）：写手是 300ms 去抖的，读者完全可能选完一行立刻离开。
    // 没有待写值时 flushViewMemory 什么都不做 —— 「打开面板看一眼再关」不产生写请求。
    useEffect(() => () => { store.flushViewMemory() }, [store])
    useEffect(() => {
      root?.focus()
    }, [root])

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
     * 换篇 / 换视图时清空组级覆盖（R6 03；spec 决策 15 的复位规则，本票只承担组级这一半）。
     *
     * **两个依赖缺一不可**：
     *  - `articleItemId` 覆盖 `j` / `k` 换篇 —— 连续换篇时 `view` 一直是 `'article'`，只看 `view` 会漏；
     *  - `state.view` 覆盖「Esc 回列表后重开**同一篇**」—— `closeArticle` 只 `set({ view: 'list' })`、
     *    刻意保留 `article`（阅读进度落盘要用它），所以那一刻 `articleItemId` 不变。
     *
     * 不这么做的话，读者点开过第 0 组、换到下一篇，新文章的第 0 组会**凭空是展开的**。
     * 初值与复位值共用同一个 `EMPTY_IMAGE_GROUPS` 引用 ⇒ 首屏那次复位是 no-op（React 相等即跳过）。
     */
    const articleItemId = state.article?.itemId
    useEffect(() => {
      setExpandedGroups(EMPTY_IMAGE_GROUPS)
    }, [articleItemId, state.view])

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
    }, [root, store, expanded, helpOpen])

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
    const tagTarget = state.view === 'article'
      ? activeArticle
      : state.items.find((item) => item.id === state.selectedId)

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
            onSelectFilter={(next) => store.setFilter(next)}
            onSelectFeed={(feedId) => store.selectNav({ kind: 'feed', feedId })}
            onSelectFolder={(folder) => store.selectNav({ kind: 'folder', folder })}
            onSelectTag={(tagId) => store.selectNav({ kind: 'tag', tagId })}
            onToggleFolder={store.toggleFolder}
          />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <div className="dsh-rss-toolbar">
          <div className="dsh-rss-toolbar-title">
            <strong>{state.view === 'list'
              ? selectedFeed?.title ?? selectedFolder?.name ?? selectedTag?.name ?? filters.find((filter) => filter.key === state.filter)?.label
              : 'RSS 阅读器'}</strong>
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
                  onChange={(event) => { void store.setWindow(event.target.value as DisplayWindowRange) }}>
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
          <details className="dsh-rss-settings">
            <summary className="dsh-rss-btn" onKeyDown={(event) => {
              // 空格应打开原生折叠区，避免被文档级翻页快捷键接管。
              if (event.key === ' ') event.stopPropagation()
            }}>更多</summary>
            <div className="dsh-rss-settings-panel">
              <label>显示未读计数
                <input type="checkbox" checked={state.showUnread} onChange={(event) => store.setShowUnread(event.target.checked)} />
              </label>
              {/* A 的作用范围是**当前列表**（已加载页 + 当前范围 + 当前过滤 + 当前显示窗）。
                  文案只在这里与 keys.ts 的帮助表出现两次（spec 决策 31），别处不抄第三份。 */}
              <label>A 键范围（当前列表）
                <select value={state.markAllRange} onChange={(event) => store.setMarkAllRange(event.target.value as MarkAllRange)}>
                  <option value="all">全部</option>
                  <option value="day">早于 1 天</option>
                  <option value="week">早于 1 周</option>
                  <option value="month">早于 1 月</option>
                </select>
              </label>
              <button type="button" className="dsh-rss-btn" disabled={state.loading}
                title="删除「已读且未星标」的旧条目（阈值可在 Config.cleanupAfterDays 调，默认 30 天）"
                onClick={() => {
                  if (window.confirm('清理已读的旧条目？\n\n只删除「已读 + 未星标 + 早于阈值」的条目，星标与未读的都会保留。此操作不可撤销。')) {
                    void store.cleanup()
                  }
                }}>清理旧条目</button>
            </div>
          </details>
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
              <label> 已读状态 <select name="read" defaultValue={state.search?.read ?? ''}>
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
            <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" onClick={() => { void store.undoMarkAll() }}>撤销</button>
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
            onClearDiscovery={() => { store.clearDiscovery() }}
            onRemove={(url) => { void store.removeFeed(url) }}
            onCreateFolder={(name) => { void store.createFolder(name) }}
            onRenameFolder={(from, to) => { void store.renameFolder(from, to) }}
            onDeleteFolder={(name) => { void store.deleteFolder(name) }}
            onMoveFeed={(feedId, folder) => { void store.moveFeedToFolder(feedId, folder) }}
            onMoveOrder={(feedId, direction) => { void store.moveFeedOrder(feedId, direction) }}
            tags={state.tags}
            onCreateTag={(name) => { void store.createTag(name) }}
            onRenameTag={(id, name) => { void store.renameTag(id, name) }}
            onDeleteTag={(id) => { void store.deleteTag(id) }}
            onBack={() => store.toggleFeeds()}
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
            canPrev={store.canStepArticle(-1)}
            canNext={store.canStepArticle(1)}
            onPrev={() => { store.stepArticle(-1) }}
            onNext={() => { store.stepArticle(1) }}
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
                      {selectedFeed === undefined && item.feedTitle + ' · '}{relativeTime(recencyOf(item))}
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
