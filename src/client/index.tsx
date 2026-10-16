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
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
import { createReaderStore, relativeTime, useReaderStore, VIRTUAL_VIEWS, type Filter, type MarkAllRange, type ReaderStore } from './store.js'
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
import { ArticleView } from './article-pane.js'
import { MIN_CONTENT_CHARS, recencyOf, ROUTE_PATH, type ArticlePayload, type CleanupResult, type FeedView, type ItemView, type OpmlExportResult, type OpmlImportResult, type Overview, type RpcResult } from '../shared.js'
import { htmlToText } from '../html-text.js'
// resolveReaderKey 也搬去了（keyboard-routing.ts 第 1 层）；这里只留帮助浮窗要用的两张表。
import { READER_KEY_HELP, READER_HELP_SCOPE_LABEL } from '../keys.js'
// 只剩「跟随选中项滚动」那条 effect 用的三个（nextScrollTop / isElementNode / SCROLL_ATTR）；
// 扫视与翻页那几个（scanTop / pageTop / halfPageTop / scanStepFor / scrollSelectorFor / lineStepFrom）
// 已随 141 行键盘路由搬进 keyboard-routing.ts（2026-10-15）。
import { nextScrollTop, isElementNode, SCROLL_ATTR } from '../list-scroll.js'

export const inject = ['slots']

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

/** 面板内自带的样式：只用带前缀的类名，不碰宿主视觉 token。 */
const STYLE = `
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


function toParagraphs(html: string | undefined): string[] {
  // 直接用抽取层那套共享实现（html-text.ts）。原先这里自己抄了一份：标签处理规则逐字相同，
  // 但少了解码实体那一步，闭合标签清单也少了 pre —— 两份实现注定会越走越远。
  if (html === undefined || html === '') return []
  return htmlToText(html).split('\n')
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
    useEffect(() => {
      root?.focus()
    }, [root])

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
    }, [state.selectedId, state.view])

    // 换文章时的「归零阅读位置 + 解除钉底」已搬进 article-pane（2026-10-15 C2）：它与「内容长高时
    // 继续贴底」是同一个行为的两半，原先分居两文件、同一个 effect 键、改一次要动两个文件。
    //
    // ref 回调写成稳定引用：内联箭头每次渲染都是新函数，React 会在每次提交时先置 null 再挂载。
    const setListBox = useCallback((node: HTMLDivElement | null): void => { listBox.current = node }, [])

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
    const failing = state.feeds.filter((feed) => feed.lastFailure)
    // 顶栏那组 filter 按钮与键盘导航的行序共用同一份定义（见 VIRTUAL_VIEWS 的注释）
    const filters = VIRTUAL_VIEWS

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
            perFeedUnread={state.perFeedUnread}
            filter={state.filter}
            navSelection={state.navSelection}
            navCursor={state.navCursor}
            showUnread={state.showUnread}
            onSelectFilter={(next) => store.setFilter(next)}
            onSelectFeed={(feedId) => store.selectNav({ kind: 'feed', feedId })}
          />
        )}
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>
          <strong>RSS 阅读器</strong>
          {state.showUnread && <span style={{ opacity: 0.7 }}>{state.unread} 条未读 / {state.items.length} 条</span>}
          {/* 「未读计数可隐藏」（规格 §5 不变量 8）：默认显示，勾掉即隐藏 —— 徽标也跟着消失 */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, opacity: 0.85 }}>
            <input type="checkbox" checked={state.showUnread} onChange={(event) => store.setShowUnread(event.target.checked)} />
            显示未读计数
          </label>
          {/* 「全部标为已读」的时间范围（规格 §3.3 的 panic button）：默认全量，不选就等于没变 */}
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto', fontSize: 12, opacity: 0.85 }}>
            A 键范围
            <select value={state.markAllRange} onChange={(event) => store.setMarkAllRange(event.target.value as MarkAllRange)}>
              <option value="all">全部</option>
              <option value="day">早于 1 天</option>
              <option value="week">早于 1 周</option>
              <option value="month">早于 1 月</option>
            </select>
          </label>
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
          <span style={{ flex: 1 }} />
          {/* 那行塞满键位的提示行于 2026-10-10 收进「?」帮助浮窗：它既挤，又必须与 keys.ts 逐字
              同步（本仓库为「标签与实现各说各话」付过两次学费）。浮窗现在逐行渲染 keys.ts 的
              READER_KEY_HELP —— 界面文案不再有第二份，同步这件事从「靠人记」变成「靠测试」。 */}
          <button type="button" className="dsh-rss-btn"
            title="订阅管理：导入/导出 OPML、加源、退订（F 键）"
            onClick={() => store.toggleFeeds()}>订阅</button>
          <button type="button" className="dsh-rss-btn" disabled={state.loading}
            title="删除「已读且未星标」的旧条目（阈值可在 Config.cleanupAfterDays 调，默认 30 天）"
            onClick={() => {
              if (window.confirm('清理已读的旧条目？\n\n只删除「已读 + 未星标 + 早于阈值」的条目，星标与未读的都会保留。此操作不可撤销。')) {
                void store.cleanup()
              }
            }}>清理旧条目</button>
          <button type="button" className="dsh-rss-btn" disabled={state.loading}
            title="重新抓取所有订阅源（受最小间隔节流）"
            onClick={() => { void store.load('refresh') }}>
            <RefreshIcon spinning={slowLoading} />
            {slowLoading ? '刷新中…' : '刷新'}
          </button>
          {/* 帮助入口放最右端：它是「说明书」，与左边那三个动作按钮不是一类东西。
              点击与按 ? 键走同一个开关，不写第二份逻辑。 */}
          <button type="button" className="dsh-rss-btn" style={{ fontWeight: 600 }}
            title="快捷键帮助（?）" aria-label="快捷键帮助" aria-expanded={helpOpen}
            onClick={() => setHelpOpen((open) => !open)}>?</button>
        </div>
        {slowLoading && <div className="dsh-rss-bar" aria-hidden="true" />}

        {state.error !== undefined && <div style={{ padding: '8px 20px', color: '#c0392b' }}>{state.error}</div>}
        {state.notice !== undefined && (
          <div style={{ padding: '6px 20px', fontSize: 12, opacity: 0.8 }}>
            {state.notice}
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
            {failing.length} 个源抓取失败：{failing.map((feed) => feed.title + '（' + feed.lastFailure + '）').join('；')}
          </div>
        )}

        {state.view === 'feeds' && (
          <FeedsView
            feeds={state.feeds}
            busy={state.feedsBusy}
            report={state.importReport}
            notice={state.notice}
            onImport={(text) => { void store.importOpml(text) }}
            onExport={() => { void store.exportOpml() }}
            onAdd={(url) => { void store.addFeed(url) }}
            onRemove={(url) => { void store.removeFeed(url) }}
            onBack={() => store.toggleFeeds()}
          />
        )}

        {state.view === 'article' && (
          <ArticleView
            article={state.article}
            link={state.items.find((entry) => entry.id === state.article?.itemId)?.link}
            onBack={() => store.closeArticle()}
            // 不再传 setBox：阅读容器的滚动生命周期（换文章归零 / 内容长高贴底）已归 article-pane
            // 自己（2026-10-15 C2）；键盘那条路径按键时刻按 scrollAttr 现取容器，不需要跨组件 ref 桥接。
            scrollAttr={SCROLL_ATTR}
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
          {!state.loading && items.length === 0 && (
            <div style={{ padding: 20, opacity: 0.7 }}>
              {state.filter === 'starred' ? '还没有星标条目。' : state.filter === 'unread' ? '没有未读条目。' : '还没有条目。订阅源以存储域为准；可在 Config.feeds 里给种子，或用 OPML 导入（M4）。'}
            </div>
          )}
          {items.map((item) => {
            // expanded 视图下每条都带正文摘录；list 视图下只有 o 展开的那一条（GR 的 o 就是 list 专用）
            const isOpen = state.layout === 'expanded' || expanded === item.id
            const unread = item.readAt === undefined
            const selected = state.selectedId === item.id
            return (
              <div key={item.id} data-rss-row={item.id}
                style={{ borderBottom: '1px solid color-mix(in srgb, currentColor 8%, transparent)' }}>
                <div role="button" tabIndex={0}
                  onClick={() => {
                    store.select(item.id)
                    setExpanded((current) => (current === item.id ? undefined : item.id))
                    void store.markRead(item.id)
                  }}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); store.select(item.id); setExpanded(item.id); void store.markRead(item.id) } }}
                  style={{
                    padding: '10px 20px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'baseline',
                    background: selected ? 'color-mix(in srgb, currentColor 7%, transparent)' : 'transparent',
                  }}>
                  <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', flex: '0 0 auto', marginTop: 6, background: unread ? 'currentColor' : 'transparent' }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: unread ? 600 : 400, opacity: unread ? 1 : 0.7 }}>
                      {item.starred ? '★ ' : ''}{item.keptUnread === true ? '⚑ ' : ''}{item.title || item.link || '(无标题)'}
                    </span>
                    <span style={{ display: 'block', fontSize: 12, opacity: 0.6, marginTop: 2 }}>
                      {item.feedTitle} · {relativeTime(recencyOf(item))}
                    </span>
                    {isOpen && (
                      <span style={{ display: 'block', marginTop: 8, opacity: 0.85, fontSize: 13 }}>
                        {(() => {
                          const paragraphs = toParagraphs(item.summary)
                          const bodyText = paragraphs.join(' ').trim()
                          // 「勉强算有正文」不该冒充正文：像 HN 那样 feed 里只有一串 Comments 链接时，
                          // 剥完标签只剩几个字符——与其显示一行孤零零的 "Comments"，不如如实说明。
                          if (bodyText.length < MIN_CONTENT_CHARS) {
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
                          style={{ fontSize: 12, marginTop: 8, marginRight: item.link === '' ? 0 : 12 }}
                          onClick={(event) => { event.stopPropagation(); void store.toggleKeepUnread(item.id) }}>
                          {item.keptUnread === true ? '取消保持未读' : '保持未读'}
                        </button>
                        {item.link !== '' && (
                          <a href={item.link} target="_blank" rel="noreferrer" style={{ fontSize: 12, display: 'inline-block', marginTop: 8 }}>打开原站 ↗</a>
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

function Badge({ store }: { store: ReaderStore }): ReactNode {
  const state = useReaderStore(store)
  // 计数被隐藏时徽标也必须消失 —— 否则「隐藏」只做了一半
  if (!state.showUnread || state.unread === 0) return null
  return <span title={state.unread + ' 条未读'} style={{ fontSize: 10 }}>{state.unread > 99 ? '99+' : state.unread}</span>
}

export function apply(ctx: ClientContext): void {
  const store = createReaderStore()
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