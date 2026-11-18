/**
 * 正文面（2026-10-07 从 index.tsx 拆出，2026-10-08 去掉原站视图）：结构化块渲染。
 *
 * **为什么不再内嵌原站页面**：那个 iframe 的沙箱（无 allow-same-origin）会让现代站点的样式流程
 * 断掉、整页只剩裸 HTML；而放宽沙箱（加 allow-same-origin + 允许脚本）等于让发布者的脚本在 DSH
 * 页面上下文里跑，是当初加沙箱要挡的事。取舍结论：**正文只走抽取视图**，想看原样就用
 * 「打开原站 ↗」在新标签页看——那是浏览器自己的上下文，没有沙箱折衷。
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { edgeTopFor, readingRatioOf, restoreTopFor } from '../list-scroll.js'

/**
 * 正文图片的最大显示高度（像素）。
 *
 * 为什么需要：正文里常混着超长截图（整页截图、长对话）与原图。只限宽时，一张像素高度很大的图
 * 会把版面撑出几十屏，读者要滚很久才能回到正文——「默认视图」的可读性直接崩掉。限高之后超长图
 * 缩成可辨认尺寸，需要看细节时点「打开原站」。
 */
const ARTICLE_IMAGE_MAX_HEIGHT = 640
import { httpUrlOrEmpty, estimateReadingMinutes, type ItemView } from '../shared.js'
import { READING_FONT_SIZES, READING_LINE_WIDTHS } from '../preferences.js'
import type { ReadingPreferences } from '../preferences.js'
import type { ArticleState } from './store.js'

/**
 * 单个正文块的渲染。
 *
 * 之所以要分类型：用户反馈「图片不显示、样式变形」——根因是抽取层过去只回传纯文本段落，
 * 图片被整块丢弃、标题/列表/引用的语义也没了，客户端只能一律当段落排版。
 * 这里按块类型给语义化样式（图片限宽、列表留符号、引用加左边线、标题分级字号）。
 */
function ArticleBlockView({ block }: { block: Record<string, unknown> }): ReactNode {
  const kind = typeof block['kind'] === 'string' ? block['kind'] : 'p'
  const text = typeof block['text'] === 'string' ? block['text'] : ''

  if (kind === 'img') {
    const src = typeof block['src'] === 'string' ? block['src'] : ''
    if (src === '') return null
    const alt = typeof block['alt'] === 'string' ? block['alt'] : ''
    const caption = typeof block['caption'] === 'string' ? block['caption'] : ''
    return (
      <figure style={{ margin: '0 0 1.3em' }}>
        {/*
         * loading=lazy：长文里的图片很多，一次性加载会拖慢首屏。
         * decoding=async 让解码不阻塞滚动。
         * maxHeight 与 objectFit：正文里混着长截图与原图，只限宽的话一张 1×3000 的图会把版面撑出
         * 几十屏。限高之后超长图缩成可辨认的尺寸（点开原站看大图），版面保持连续。
         */}
        <img src={src} alt={alt} loading="lazy" decoding="async"
          style={{
            display: 'block', margin: '0 auto', maxWidth: '100%', height: 'auto',
            maxHeight: ARTICLE_IMAGE_MAX_HEIGHT, objectFit: 'contain', borderRadius: 6,
          }} />
        {caption !== '' && (
          <figcaption className="dsh-rss-meta" style={{ marginTop: 8, textAlign: 'center' }}>{caption}</figcaption>
        )}
      </figure>
    )
  }

  if (kind === 'pre') {
    return (
      <pre style={{
        margin: '0 0 1.1em', padding: '10px 12px', overflowX: 'auto',
        // em 而不是 px：正文字号可调（M5 01），写死 13px 会在 20px 正文下显得很小
        borderRadius: 6, fontSize: '0.8125em', lineHeight: 1.6, overflowWrap: 'normal',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        background: 'color-mix(in srgb, currentColor 6%, transparent)',
      }}>{text}</pre>
    )
  }

  if (kind === 'h') {
    const level = typeof block['level'] === 'number' ? block['level'] : 2
    // em 而不是 px（22/19/17/16 都是 16px 基准下的原值）：字号可调之后，写死 px 会让 20px 正文
    // 比 h4 还大 —— 标题必须跟着正文一起缩放，否则「放大字号」反而把层级弄反了
    const size = level <= 1 ? '1.375em' : level === 2 ? '1.1875em' : level === 3 ? '1.0625em' : '1em'
    return (
      <div style={{ fontSize: size, fontWeight: 600, lineHeight: 1.4, margin: '1.4em 0 0.5em' }}>{text}</div>
    )
  }

  if (kind === 'list') {
    const ordered = block['ordered'] === true
    const items = Array.isArray(block['items']) ? block['items'] : []
    const ListTag = ordered ? 'ol' : 'ul'
    return (
      <ListTag style={{ margin: '0 0 1.1em', paddingLeft: '1.5em' }}>
        {items.map((entry, index) => <li key={index} style={{ marginBottom: '0.3em' }}>{String(entry)}</li>)}
      </ListTag>
    )
  }

  if (kind === 'quote') {
    return (
      <blockquote style={{
        margin: '0 0 1.1em', padding: '0.2em 0 0.2em 1em',
        borderLeft: '3px solid color-mix(in srgb, currentColor 25%, transparent)',
        opacity: 0.9,
      }}>{text}</blockquote>
    )
  }

  return <p style={{ margin: '0 0 1.05em' }}>{text}</p>
}

export function ArticleView({ article, item, onBack, scrollAttr, canPrev, canNext, onPrev, onNext, reading, onReading, onSaveProgress }: {
  article: ArticleState | undefined
  item: ItemView | undefined
  onBack: () => void
  /** 记一次阅读进度（M5 02）：只在切换 / 关闭 / 卸载时调，滚动本身不写盘 */
  onSaveProgress: (itemId: string, contentVersion: string, ratio: number) => void
  /** 正文排版偏好（M5 01）：值归 store 所有，本组件只负责照着画、把用户的改动交回去 */
  reading: ReadingPreferences
  onReading: (patch: Partial<ReadingPreferences>) => void
  /** 容器标记属性名：按键处理按它现取容器（取值集中在 list-scroll.ts 的 scrollSelectorFor） */
  scrollAttr: string
  /** 上/下一条是否可切（与键盘共用同一判定，见 canStepArticle） */
  canPrev: boolean
  canNext: boolean
  onPrev: () => void
  onNext: () => void
}): ReactNode {
  // 新缓存是结构化块；老缓存只有纯文本段落——把后者包成 p 块，走同一条渲染路径
  const blocks: Array<Record<string, unknown>> = article?.blocks !== undefined
    ? article.blocks
    : (article?.paragraphs ?? []).map((text) => ({ kind: 'p', text }))
  const title = article?.title || item?.title
  const publishedAt = item?.publishedAt
  // 历史行可能带脏 link（修复前落库的 javascript:）：渲染前过 shared.ts 的唯一白名单。
  // 认不出就当作「无链接」——与 item.link === '' 的既有语义一致（不渲染「打开原站」）。
  const rawLink = item?.link
  const link = rawLink === undefined ? undefined : httpUrlOrEmpty(rawLink)
  // 只按**已缓存的正文**估：加载中 / 抓取失败时 blocks 为空 ⇒ 0 ⇒ 界面不出现任何数字。
  // 刻意不拿 summary 或源里的 excerpt 去凑 —— 那不是用户即将读的那段文本。
  const readMinutes = estimateReadingMinutes(blocks)

  /**
   * 本组件自己拿到滚动容器 —— 右下角那两个按钮要作用在它上面。
   *
   * 与键盘路径同一条约束（2026-10-09）：**点击时刻读 `boxRef.current`**，不在渲染期捕获节点。
   * 用 ref 而不是 state：身份跨渲染稳定，读的永远是最新的；用 state 会让回调闭包捕获旧值。
   *
   * 2026-10-15（C2）：原先还要把节点转交给父组件的 `setBox`（键盘路径靠它拿容器），
   * 那条桥接 prop 已删 —— 键盘路径改为**按键时刻按 `scrollAttr` 标记属性现取**
   * （keyboard-routing.ts 的 focusScrollBox，理由见那里：现取还能覆盖容器换节点的情况）。
   */
  const boxRef = useRef<HTMLDivElement | null>(null)
  /**
   * 「钉住底部」意图。
   *
   * 为什么需要它：正文图片是 `loading="lazy"` 且**没有固有尺寸**（抽取层只回传 src/alt），
   * 所以图片真正进入视口之前高度是 0。点 ↓ 那一刻算出的 scrollHeight 只是**当时的**；
   * 图片随后进场加载、把内容撑高，而滚动位置留在原地 ⇒ 看起来「没到底、还差一小段」，
   * 而先点一次 ↑ 再点 ↓ 就正常（那时图片已有尺寸）。2026-10-09 用户实测。
   * 钉住之后内容再长高会继续贴底；只有用户自己滚走才解除（见 handleScroll）。
   */
  const pinnedRef = useRef(false)
  /** 我们自己写进去的 scrollTop：滚动事件里的值与它不一致 ⇒ 说明是用户滚的。 */
  const expectedTopRef = useRef(0)
  /**
   * 卸载时 ref 回调会先用 null 覆盖 boxRef，而被动 effect 的 cleanup 跑在那之后 ——
   * 所以「离开这篇时读到哪儿」必须另存一个**只增不删**的节点引用（节点被摘掉后 scrollTop 仍在）。
   */
  const lastBoxRef = useRef<HTMLDivElement | null>(null)
  /** 待恢复的比例（M5 02）：内容长高时按它重算位置，直到用户自己滚走。 */
  const restoreRatioRef = useRef<number | undefined>(undefined)

  /** 贴到底部，并记下这次是我们写的（供 handleScroll 区分用户滚动）。 */
  const pinToBottom = useCallback((box: HTMLDivElement): void => {
    box.scrollTop = edgeTopFor(box.scrollHeight - box.clientHeight, 'bottom')
    expectedTopRef.current = box.scrollTop
  }, [])

  const handleScroll = useCallback((): void => {
    const box = boxRef.current
    if (box === null) return
    // 容差 2px：滚动位置是小数、浏览器也可能做亚像素取整，不该因这点偏差误判成用户滚动
    if (Math.abs(box.scrollTop - expectedTopRef.current) > 2) {
      pinnedRef.current = false
      // 用户自己滚了就不再按比例纠正：恢复只在「他还没动过」的那一小段时间里补正
      restoreRatioRef.current = undefined
    }
  }, [])

  const attachBox = useCallback((node: HTMLDivElement | null): void => {
    const previous = boxRef.current
    if (previous !== null && previous !== node) previous.removeEventListener('scroll', handleScroll)
    boxRef.current = node
    if (node !== null) {
      lastBoxRef.current = node
      node.addEventListener('scroll', handleScroll)
    }
  }, [handleScroll])

  /** 跳到文章一端。容器量不到时什么都不做 —— 没有容器就没得滚，不该抛错。 */
  const scrollToEdge = (edge: 'top' | 'bottom'): void => {
    const box = boxRef.current
    if (box === null) return
    if (edge === 'top') {
      // 明确解除钉住：用户要看开头，之后内容再长高也不该把他拽回底部
      pinnedRef.current = false
      box.scrollTop = edgeTopFor(box.scrollHeight - box.clientHeight, 'top')
      expectedTopRef.current = box.scrollTop
      return
    }
    pinnedRef.current = true
    pinToBottom(box)
  }

  /**
   * 换文章时：归零阅读位置 + 解除钉底 —— **同一件事的两个后果，用同一条 effect**。
   *
   * 2026-10-15（C2）从 index.tsx 搬来。为什么需要归零（2026-10-09 修）：React 会复用正文
   * 容器的 DOM 节点，节点不换 ⇒ scrollTop 保留上一条的位置；读了一半按 j，新文章会从半截开始
   * —— 而 j/k 的语义是「换条目」，不是「同一篇里翻页」。以 itemId 为键而不是 view：连续按 j 时
   * view 一直是 'article'，只有 itemId 在变。
   *
   * 搬进来的理由：它与下面的「内容长高时继续贴底」是**同一个行为的两半**（阅读容器的滚动位置），
   * 原先分居两个文件、同一个 effect 键、写同一个 scrollTop —— 今天改一次要动两个文件。
   */
  useEffect(() => {
    pinnedRef.current = false
    restoreRatioRef.current = undefined
    const box = boxRef.current
    if (box !== null) box.scrollTop = 0
  }, [article?.itemId])

  /**
   * 恢复上次读到的位置（M5 02）。
   *
   * 时机是「正文真的画出来了」这一刻：加载中容器里只有一行占位文字，那时量到的 scrollHeight 是假的。
   * 比例来自宿主（只有内容版本对得上才会给），所以这里不做版本判断 —— 判据只有一处。
   *
   * ⚠️ 不能并进上面那条 itemId 的 effect：换文章时 payload 还没到（loading: true），
   * 那一刻 article.restoreRatio 还是 undefined。
   */
  useEffect(() => {
    const box = boxRef.current
    if (box === null || article === undefined) return
    if (article.loading === true || article.failure !== undefined) return
    const ratio = article.restoreRatio
    if (ratio === undefined || ratio <= 0) return
    const top = restoreTopFor(ratio, box.scrollHeight, box.clientHeight)
    box.scrollTop = top
    expectedTopRef.current = top
    // 图片还没进场时内容更矮：记住这个比例，长高时按它补正（用户一动就解除，见 handleScroll）
    restoreRatioRef.current = ratio
  }, [article?.itemId, article?.loading, article?.failure, article?.restoreRatio])

  /**
   * 离开这篇时把「读到哪儿」写回去（M5 02）。
   *
   * 用 effect 的 cleanup 而不是「切换那一刻调一次」：卸载路径（Esc 回列表、关面板）与
   * 切换路径（j/k、点上一条）在这里是**同一件事**，分开写必然漏掉一条。
   * 滚动过程本身不写盘 —— 判据在 tests/scroll-dom.test.mjs：滚多少次都不产生 saveReadingProgress。
   */
  useEffect(() => {
    const itemId = article?.itemId
    const contentVersion = article?.contentVersion
    if (itemId === undefined || contentVersion === undefined) return undefined
    return () => {
      const box = boxRef.current ?? lastBoxRef.current
      if (box === null) return
      onSaveProgress(itemId, contentVersion, readingRatioOf(box.scrollTop, box.scrollHeight, box.clientHeight))
    }
  }, [article?.itemId, article?.contentVersion, onSaveProgress])

  /**
   * 内容长高时继续贴底。
   *
   * 观察的是**正文内容那层**，不是滚动容器本身：容器是 flex:1 的固定高，内容变高它不变。
   * 依赖里带正文状态：加载 → 成功会让 React 换掉那个子节点，换完必须重新观察，
   * 否则观察器盯的是一个已经被丢弃的节点（那样恰好会在「文章刚加载完」时失效）。
   */
  useEffect(() => {
    const box = boxRef.current
    const content = box === null ? null : box.firstElementChild
    if (box === null || content === null) return undefined
    // 没有 ResizeObserver 就退化成「点击那一下到底」—— 与本插件对缺失全局的一贯处理一致
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) { pinToBottom(box); return }
      const ratio = restoreRatioRef.current
      if (ratio === undefined) return
      // 按比例补正：图片进场把内容撑高时，比例不变意味着「还是那一段文字」
      const top = restoreTopFor(ratio, box.scrollHeight, box.clientHeight)
      box.scrollTop = top
      expectedTopRef.current = top
    })
    observer.observe(content)
    return () => { observer.disconnect() }
  }, [article?.itemId, article?.loading, article?.failure, pinToBottom])


  return (
    // position:relative 是给右下角那两个跳转按钮当地坐标系的：
    // 按钮不能放进滚动容器里（会跟着内容滚走），只能浮在它之上、由本层定位。
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div className="dsh-rss-article-inset" style={{ borderBottom: '1px solid var(--rss-line)' }}>
        <div className="dsh-rss-article-column dsh-rss-article-nav">
          <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
            title="返回列表（Esc）" onClick={onBack}>← 返回列表</button>
          <div className="dsh-rss-actions">
            {/* 与键盘共用判定，j/k 切文章，n/p 滚动当前文章。 */}
            <button type="button" className="dsh-rss-btn" disabled={!canPrev}
              title="上一条（k）" onClick={onPrev}>↑ 上一条</button>
            <button type="button" className="dsh-rss-btn" disabled={!canNext}
              title="下一条（j）" onClick={onNext}>↓ 下一条</button>
            {link !== undefined && link !== '' && (
              <a className="dsh-rss-btn dsh-rss-btn--ghost" href={link} target="_blank" rel="noreferrer">打开原站 ↗</a>
            )}
            {/*
              * 阅读偏好（M5 01）收在一个 <details> 里：三个 <select> 摊开摆会把这一行挤成两层，
              * 而它们是「调一次就一直用」的东西，不值得占常驻版面。与顶栏「更多」同一个面板样式。
              * 值一律走 store（onReading），本组件不持有状态 —— 否则重开插件就恢复不了。
              */}
            <details className="dsh-rss-settings">
              <summary className="dsh-rss-btn" title="正文字号 / 栏宽 / 主题"
                onKeyDown={(event) => { if (event.key === ' ') event.stopPropagation() }}>Aa</summary>
              <div className="dsh-rss-settings-panel">
                <label>字号
                  <select value={reading.fontSize} aria-label="正文字号"
                    onChange={(event) => onReading({ fontSize: Number(event.target.value) })}>
                    {READING_FONT_SIZES.map((size) => <option key={size} value={size}>{size}px</option>)}
                  </select>
                </label>
                <label>栏宽
                  <select value={reading.lineWidth} aria-label="正文栏宽"
                    onChange={(event) => onReading({ lineWidth: Number(event.target.value) })}>
                    {READING_LINE_WIDTHS.map((width) => <option key={width} value={width}>{width}px</option>)}
                  </select>
                </label>
                <label>主题
                  <select value={reading.theme} aria-label="正文主题"
                    onChange={(event) => onReading({ theme: event.target.value as ReadingPreferences['theme'] })}>
                    <option value="auto">跟随宿主</option>
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                  </select>
                </label>
              </div>
            </details>
          </div>
        </div>
      </div>

      {/*
        * 滚动容器**包在三种状态之外**（2026-10-09 修）。
        * 此前它只存在于「正文加载完成」这条分支里，于是加载中和抓取失败时按空格毫无反应——
        * 而这两个状态恰恰是用户最容易反复按键的时候（在等正文出来）。容器先立着，
        * 里面画什么再按状态决定；没有可滚内容时滚动计算自然得到 0，不会乱动。
        */}
      <div ref={attachBox} {...{ [scrollAttr]: 'article' }} {...{ 'data-rss-reading-theme': reading.theme }}
        className="dsh-rss-article-inset"
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', scrollbarGutter: 'stable both-edges', paddingBlock: '24px 40px' }}>
        {/* 字号/栏宽写在这一层：.dsh-rss-article-column 的 760px 只是默认值，行内 maxWidth 覆盖它 */}
        <article className="dsh-rss-article-column" style={{ fontSize: reading.fontSize, lineHeight: 1.85, maxWidth: reading.lineWidth }}>
          {title && (
            <header style={{ marginBottom: 24 }}>
              <h1 className="dsh-rss-article-title">{title}</h1>
              {item !== undefined && (
                <div className="dsh-rss-meta" style={{ marginTop: 8 }}>
                  {item.feedTitle}
                  {publishedAt !== undefined && (
                    <> · <time dateTime={publishedAt}>{new Date(publishedAt).toLocaleDateString('zh-CN')}</time></>
                  )}
                  {/* 「估算」两个字是承诺边界：速率是整数近似值，不许写成「阅读时间」那种确定口吻 */}
                  {readMinutes > 0 && (
                    <> · <span data-rss-reading-minutes={readMinutes}>约 {readMinutes} 分钟（估算）</span></>
                  )}
                </div>
              )}
            </header>
          )}
          {article === undefined || article.loading ? (
            <p className="dsh-rss-meta" role="status">正在抓取原站正文…</p>
          ) : article.failure !== undefined ? (
            <div role="alert" style={{ color: 'var(--rss-error)' }}>
              没能取到正文：{article.failure}
              <div className="dsh-rss-meta" style={{ marginTop: 6 }}>
                {link ? '可以返回列表，或打开原站阅读。' : '可以按 Esc 返回列表。'}
              </div>
            </div>
          ) : blocks.map((block, index) => <ArticleBlockView key={index} block={block} />)}
        </article>
      </div>

      {/*
        * 右下角的「回顶部 / 去底部」。**click 才去读容器**（见 scrollToEdge）——
        * 不把节点存进 state 让回调捕获，这与键盘那条路径是同一条约束。
        * 按钮放在滚动容器**之后**且同属相对定位层：不进滚动流，长文里也不会被滚走。
        *
        * 只在正文真的画出来时显示：加载中/抓取失败时既没有正文可跳，按钮也只会挤在
        * 「正在抓取…」那行旁边造成误解（与下面判断正文状态的那三支条件保持同一口径）。
        */}
      {article !== undefined && article.loading !== true && article.failure === undefined && (
        <div style={{
          position: 'absolute', right: 16, bottom: 16,
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
            title="回到文章顶部" aria-label="回到文章顶部"
            onClick={() => scrollToEdge('top')}
            style={{ padding: '4px 8px', lineHeight: 1 }}>↑</button>
          <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
            title="前往文章底部" aria-label="前往文章底部"
            onClick={() => scrollToEdge('bottom')}
            style={{ padding: '4px 8px', lineHeight: 1 }}>↓</button>
        </div>
      )}
    </div>
  )
}

/** 侧栏折叠按钮里的未读数（非交互）。 */
