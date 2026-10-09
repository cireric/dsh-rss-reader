/**
 * 正文面（2026-10-07 从 index.tsx 拆出，2026-10-08 去掉原站视图）：结构化块渲染。
 *
 * **为什么不再内嵌原站页面**：那个 iframe 的沙箱（无 allow-same-origin）会让现代站点的样式流程
 * 断掉、整页只剩裸 HTML；而放宽沙箱（加 allow-same-origin + 允许脚本）等于让发布者的脚本在 DSH
 * 页面上下文里跑，是当初加沙箱要挡的事。取舍结论：**正文只走抽取视图**，想看原样就用
 * 「打开原站 ↗」在新标签页看——那是浏览器自己的上下文，没有沙箱折衷。
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { edgeTopFor } from '../list-scroll.js'

/**
 * 正文图片的最大显示高度（像素）。
 *
 * 为什么需要：正文里常混着超长截图（整页截图、长对话）与原图。只限宽时，一张像素高度很大的图
 * 会把版面撑出几十屏，读者要滚很久才能回到正文——「默认视图」的可读性直接崩掉。限高之后超长图
 * 缩成可辨认尺寸，需要看细节时点「打开原站」。
 */
const ARTICLE_IMAGE_MAX_HEIGHT = 640
import type { ArticlePayload } from '../shared.js'
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
          <figcaption style={{ fontSize: 13, opacity: 0.65, marginTop: 6, textAlign: 'center' }}>{caption}</figcaption>
        )}
      </figure>
    )
  }

  if (kind === 'pre') {
    return (
      <pre style={{
        margin: '0 0 1.1em', padding: '10px 12px', overflowX: 'auto',
        borderRadius: 6, fontSize: 13, lineHeight: 1.6,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        background: 'color-mix(in srgb, currentColor 6%, transparent)',
      }}>{text}</pre>
    )
  }

  if (kind === 'h') {
    const level = typeof block['level'] === 'number' ? block['level'] : 2
    const size = level <= 1 ? 22 : level === 2 ? 19 : level === 3 ? 17 : 16
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

export function ArticleView({ article, link, onBack, setBox, scrollAttr, canPrev, canNext, onPrev, onNext }: {
  article: ArticleState | undefined
  link: string | undefined
  onBack: () => void
  /** 阅读视图滚动容器的 ref 回调：空格翻页要作用在它上面（跨组件只能传进来） */
  setBox: (node: HTMLDivElement | null) => void
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

  /**
   * 本组件自己也要拿到滚动容器 —— 右下角那两个按钮要作用在它上面。
   *
   * 与键盘路径同一条约束（2026-10-09）：**点击时刻读 `boxRef.current`**，不在渲染期捕获节点。
   * 用 ref 而不是 state：身份跨渲染稳定，读的永远是最新的；用 state 会让回调闭包捕获旧值。
   * 同时把节点转交给父组件的 setBox（键盘那条路径靠它），两者互不替代。
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

  /** 贴到底部，并记下这次是我们写的（供 handleScroll 区分用户滚动）。 */
  const pinToBottom = useCallback((box: HTMLDivElement): void => {
    box.scrollTop = edgeTopFor(box.scrollHeight - box.clientHeight, 'bottom')
    expectedTopRef.current = box.scrollTop
  }, [])

  const handleScroll = useCallback((): void => {
    const box = boxRef.current
    if (box === null) return
    // 容差 2px：滚动位置是小数、浏览器也可能做亚像素取整，不该因这点偏差误判成用户滚动
    if (Math.abs(box.scrollTop - expectedTopRef.current) > 2) pinnedRef.current = false
  }, [])

  const attachBox = useCallback((node: HTMLDivElement | null): void => {
    const previous = boxRef.current
    if (previous !== null && previous !== node) previous.removeEventListener('scroll', handleScroll)
    boxRef.current = node
    setBox(node)
    if (node !== null) node.addEventListener('scroll', handleScroll)
  }, [handleScroll, setBox])

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

  // 换文章时解除钉住（新文章要从顶部开始读，见 index.tsx 那条归零 effect）
  useEffect(() => { pinnedRef.current = false }, [article?.itemId])

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
    const observer = new ResizeObserver(() => { if (pinnedRef.current) pinToBottom(box) })
    observer.observe(content)
    return () => { observer.disconnect() }
  }, [article?.itemId, article?.loading, article?.failure, pinToBottom])


  return (
    // position:relative 是给右下角那两个跳转按钮当地坐标系的：
    // 按钮不能放进滚动容器里（会跟着内容滚走），只能浮在它之上、由本层定位。
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px',
        borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
      }}>
        <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" onClick={onBack}>← 返回列表（Esc）</button>
        <span style={{ flex: 1 }} />
        {/* 上/下一条：与键盘同一套判定；详情页 j = 下一条、k = 上一条（n/p 是扫视，不换文章）。 */}
        <button type="button" className="dsh-rss-btn" disabled={!canPrev}
          title="上一条（k）" onClick={onPrev}>↑ 上一条</button>
        <button type="button" className="dsh-rss-btn" disabled={!canNext}
          title="下一条（j）" onClick={onNext}>↓ 下一条</button>
        {link !== undefined && link !== '' && (
          <a href={link} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>打开原站 ↗</a>
        )}
      </div>

      {/*
        * 滚动容器**包在三种状态之外**（2026-10-09 修）。
        * 此前它只存在于「正文加载完成」这条分支里，于是加载中和抓取失败时按空格毫无反应——
        * 而这两个状态恰恰是用户最容易反复按键的时候（在等正文出来）。容器先立着，
        * 里面画什么再按状态决定；没有可滚内容时滚动计算自然得到 0，不会乱动。
        */}
      <div ref={attachBox} {...{ [scrollAttr]: 'article' }}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 24px 32px' }}>
        {article === undefined || article.loading ? (
          <div style={{ padding: '12px 22px', opacity: 0.7 }}>正在抓取并抽取原站正文…</div>
        ) : article.failure !== undefined ? (
          <div style={{ padding: '12px 22px', color: '#c0392b' }}>
            没能取到正文：{article.failure}
            <div style={{ opacity: 0.7, marginTop: 6, fontSize: 12 }}>可以按 Esc 回列表，或点右上角去原站阅读。</div>
          </div>
        ) : (
          // 阅读视图：限宽 + 加大行高（长文可读性）；每种块由 ArticleBlockView 给语义化样式
          <div style={{ maxWidth: 760, margin: '0 auto', fontSize: 16, lineHeight: 1.85 }}>
            {article.title !== undefined && (
              <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.4, marginBottom: 18 }}>{article.title}</div>
            )}
            {blocks.map((block, index) => <ArticleBlockView key={index} block={block} />)}
          </div>
        )}
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
