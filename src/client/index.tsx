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
import { useCallback, useEffect, useState, type ReactNode } from 'react'
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
import { createReaderStore, relativeTime, useReaderStore, type Filter, type ReaderStore } from './store.js'
// 导出面是构建产物对外的契约（契约测试直接调它），store 搬家后仍要从入口转出去
export { createReaderStore }
import { FeedsView } from './feeds-view.js'
import { ArticleView } from './article-pane.js'
// 契约测试断言的就是这一份（iframe 沙箱属性）；它现在住在 article-view 里
export { ORIGINAL_VIEW_FRAME_PROPS } from './article-pane.js'
import { MIN_CONTENT_CHARS, recencyOf, ROUTE_PATH, type ArticlePayload, type CleanupResult, type FeedView, type ItemView, type OpmlExportResult, type OpmlImportResult, type Overview, type RpcResult } from '../shared.js'
import { htmlToText } from '../html-text.js'
import { resolveReaderKey } from '../keys.js'
import { nextScrollTop, scanTop, pageTop } from '../list-scroll.js'

export const inject = ['slots']

/** panellist 图标的 id 必须与 main 座位的 key 相同。 */
const PANEL_ID = 'dsh-rss-reader'
/** 阅读器根节点的标记：快捷键用它判断焦点是否在本面板内。 */
const ROOT_ATTR = 'data-dsh-rss-reader'


/**
 * 加载指示的消抖阈值：刷新常常在毫秒级返回，立刻显示「刷新中」会闪一下。
 * 超过这个时长才把加载态画出来（handoff §8 记过这条教训）。
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


/**
 * 快捷键的守卫：焦点在输入框、可编辑区或弹层里时不响应。
 *
 * 为什么不再要求「阅读器持有焦点」：用户实测切到阅读器后必须先用鼠标点一下才能用快捷键——
 * 因为宿主在面板切换后并不把按键交给我们的节点。现在监听挂在 document 上（面板卸载即移除），
 * 于是「只有阅读器存在时才可能响应」由生命周期保证，而「别抢输入框的键」由本函数保证。
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  try {
    if (target.isContentEditable) return true
    if (target.closest('[role="dialog"], [aria-modal="true"], dialog') !== null) return true
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  } catch (error) {
    // 不能静默降级：判定失败意味着「这次按键会被当成非输入框而放行」，那是行为上的改变，
    // 必须在控制台留下证据（浏览器里 console 是本插件唯一可见的通道）。
    console.warn('[rss-reader] 输入框判定失败，本次按键按「非输入框」处理', error)
    return false
  }
  return false
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
export function createReader(store: ReaderStore): () => ReactNode {
  return function Reader(): ReactNode {
    const state = useReaderStore(store)
    const [root, setRoot] = useState<HTMLDivElement | null>(null)
    const [listBox, setListBox] = useState<HTMLDivElement | null>(null)
    // 详情页阅读视图的滚动容器：空格翻页要作用在它上面
    const [articleBox, setArticleBox] = useState<HTMLDivElement | null>(null)
    const [expanded, setExpanded] = useState<string | undefined>(undefined)
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
      if (listBox === null || state.view !== 'list') return
      const selected = state.selectedId
      if (selected === undefined) return
      const row = listBox.querySelector('[data-rss-row="' + selected + '"]')
      if (!(row instanceof HTMLElement)) return
      const target = nextScrollTop(listBox.scrollTop, listBox.clientHeight, row.offsetTop, row.offsetHeight)
      if (target !== listBox.scrollTop) listBox.scrollTop = target
    }, [listBox, state.selectedId, state.view])

    // 键盘流：挂在 document 上 + 输入框守卫。
    // 原实现挂在面板根节点并要求其持有焦点，导致「必须先点一下页面」才响应（用户实测）。
    // 挂 document 的代价是作用域变宽，因此用 isTypingTarget 挡住输入框/弹层；
    // 面板卸载时监听随 effect 清理一并移除，所以只有阅读器存在时才可能响应。
    // ⚠️ 不走 ctx.shortcuts：平台规则禁止无修饰键的绑定（configuration.ts:100 ——
    // modifiers 为空或全为 shift 即 modifier-required，register 会直接 throw，实测会炸掉整个 client 半）。
    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent): void => {
        if (isTypingTarget(event.target)) return
        // 宿主可能把非当前主栏面板保活在后台（ui-layout 的 retainMainPanels 就是这个意图）：
        // 面板没真正显示时不响应，否则你在对话里按 j/k 会去动一个看不见的列表。
        // 用 getClientRects().length 判可见：display:none 或未挂载时为 0，且不受定位方式影响。
        if (root === null || root.getClientRects().length === 0) return
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
        // 键位语义在 src/keys.ts（纯函数，宿主侧有单测）；这里只把动作落到 store 上
        // 空格的大小写不敏感，方向必须靠 shift 标志分辨（见 keys.ts 的单测）
        const action = resolveReaderKey(event.key, event.shiftKey)
        if (action === 'none') return
        const view = store.get().view
        const run = (act: () => void): void => { event.preventDefault(); act() }
        switch (action) {
          // 正文视图里 j/k 不移动：每次移动都意味着一次抓取，误按代价太高（Esc 回列表再移动）
          // j/k 按视图分流——同一个键始终是「换条目」，语义不因视图而变：
          //   列表页 → 移动选中（不标已读，用户 2026-10-06 定）
          //   正文页 → 切上/下一条文章（B1：显示即打开，故标已读；在途防抖、边界停住）
          case 'next':
            if (view === 'article') { run(() => { store.stepArticle(1) }); break }
            if (view !== 'list') return
            run(() => store.selectRelative(1))
            break
          case 'prev':
            if (view === 'article') { run(() => { store.stepArticle(-1) }); break }
            if (view !== 'list') return
            run(() => store.selectRelative(-1))
            break
          // Google Reader 语义：o 展开/折叠 + 标已读（已读的唯一自动触发点，另有显式的 m）
          case 'expand':
            // 只在列表页有意义：正文页按 o 曾会展开"背后那个看不见的列表"里的条目，
            // 表现为按 Esc 回列表后发现某行莫名展开（既存缺陷，2026-10-06 修）
            if (view !== 'list') return
            run(() => {
              const selected = store.get().selectedId
              if (selected === undefined) return
              setExpanded((current) => (current === selected ? undefined : selected))
              void store.markRead(selected)
            })
            break
          // n/p = 扫视：滚动视野但**不改变选中**（GR 原义：scroll without viewing）
          // 列表页滚列表，详情页滚文章——两处都是「只看不动」
          case 'scanNext':
          case 'scanPrev': {
            const direction: 1 | -1 = action === 'scanNext' ? 1 : -1
            const box = view === 'list' ? listBox : view === 'article' ? articleBox : null
            if (box === null) return
            run(() => {
              const row = box.querySelector('[data-rss-row]')
              const rowHeight = row instanceof HTMLElement ? row.offsetHeight : 48
              box.scrollTop = scanTop(box.scrollTop, rowHeight, box.scrollHeight - box.clientHeight, direction)
            })
            break
          }
          // 空格 / shift+空格 = 按一屏翻页（列表与详情页都适用）
          case 'pageDown':
          case 'pageUp': {
            const direction: 1 | -1 = action === 'pageDown' ? 1 : -1
            const box = view === 'list' ? listBox : view === 'article' ? articleBox : null
            if (box === null) return
            run(() => {
              box.scrollTop = pageTop(box.scrollTop, box.clientHeight, box.scrollHeight - box.clientHeight, direction)
            })
            break
          }
          case 'openExternal': run(() => store.openSelected()); break
          case 'openArticle': if (view !== 'list') return; run(() => { void store.openArticle() }); break
          case 'toggleRender': if (view !== 'article') return; run(() => store.toggleArticleRender()); break
          case 'manageFeeds': run(() => store.toggleFeeds()); break
          // Esc：从正文回到列表；列表态下不拦截（不抢弹层的 Esc）
          // Esc：正文 → 列表；订阅管理 → 列表。列表态不拦截（不抢弹层的 Esc）
          case 'back':
            if (view === 'article') { event.preventDefault(); store.closeArticle(); break }
            if (view === 'feeds') { event.preventDefault(); store.toggleFeeds(); break }
            return
          case 'star': run(() => { void store.toggleStar() }); break
          case 'toggleRead': run(() => { void store.toggleRead() }); break
          case 'markAll': run(() => { void store.markAllRead() }); break
          default: return
        }
      }
      document.addEventListener('keydown', onKeyDown)
      return () => { document.removeEventListener('keydown', onKeyDown) }
    }, [root, store])

    const items = store.visible()
    const failing = state.feeds.filter((feed) => feed.lastFailure)
    const filters: Array<{ key: Filter; label: string }> = [
      { key: 'all', label: '全部' },
      { key: 'unread', label: '未读' },
      { key: 'starred', label: '星标' },
    ]

    return (
      <div ref={setRoot} tabIndex={0} {...{ [ROOT_ATTR]: '' }}
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 14, lineHeight: 1.55, outline: 'none' }}>
        <style>{STYLE}</style>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>
          <strong>RSS 阅读器</strong>
          <span style={{ opacity: 0.7 }}>{state.unread} 条未读 / {state.items.length} 条</span>
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
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, opacity: 0.55 }}>j/k 移动 · n/p 扫视 · 空格翻页 · o 展开并已读 · V 读正文 · v 开原站 · s 星标 · m 已读 · A 全部 · F 订阅</span>
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
            onToggleRender={() => store.toggleArticleRender()}
            setBox={setArticleBox}
            canPrev={store.canStepArticle(-1)}
            canNext={store.canStepArticle(1)}
            onPrev={() => { store.stepArticle(-1) }}
            onNext={() => { store.stepArticle(1) }}
          />
        )}

        <div ref={setListBox} style={{
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
            const isOpen = expanded === item.id
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
        </div>
      </div>
    )
  }
}

function Badge({ store }: { store: ReaderStore }): ReactNode {
  const state = useReaderStore(store)
  if (state.unread === 0) return null
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