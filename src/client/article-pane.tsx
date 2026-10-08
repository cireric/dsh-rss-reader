/**
 * 正文面（2026-10-07 从 index.tsx 拆出，2026-10-08 去掉原站视图）：结构化块渲染。
 *
 * **为什么不再内嵌原站页面**：那个 iframe 的沙箱（无 allow-same-origin）会让现代站点的样式流程
 * 断掉、整页只剩裸 HTML；而放宽沙箱（加 allow-same-origin + 允许脚本）等于让发布者的脚本在 DSH
 * 页面上下文里跑，是当初加沙箱要挡的事。取舍结论：**正文只走抽取视图**，想看原样就用
 * 「打开原站 ↗」在新标签页看——那是浏览器自己的上下文，没有沙箱折衷。
 */
import type { ReactNode } from 'react'
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
        {/* loading=lazy：长文里的图片很多，一次性加载会拖慢首屏 */}
        <img src={src} alt={alt} loading="lazy"
          style={{ display: 'block', maxWidth: '100%', height: 'auto', borderRadius: 6 }} />
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

export function ArticleView({ article, link, onBack, setBox, canPrev, canNext, onPrev, onNext }: {
  article: ArticleState | undefined
  link: string | undefined
  onBack: () => void
  /** 阅读视图滚动容器的 ref 回调：空格翻页要作用在它上面（跨组件只能传进来） */
  setBox: (node: HTMLDivElement | null) => void
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


  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
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

      {article === undefined || article.loading ? (
        <div style={{ padding: '12px 22px', opacity: 0.7 }}>正在抓取并抽取原站正文…</div>
      ) : article.failure !== undefined ? (
        <div style={{ padding: '12px 22px', color: '#c0392b' }}>
          没能取到正文：{article.failure}
          <div style={{ opacity: 0.7, marginTop: 6, fontSize: 12 }}>可以按 Esc 回列表，或点右上角去原站阅读。</div>
        </div>
      ) : (
        // 阅读视图：限宽 + 加大行高（长文可读性）；每种块由 ArticleBlockView 给语义化样式
        <div ref={setBox} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 24px 32px' }}>
          <div style={{ maxWidth: 760, margin: '0 auto', fontSize: 16, lineHeight: 1.85 }}>
            {article.title !== undefined && (
              <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.4, marginBottom: 18 }}>{article.title}</div>
            )}
            {blocks.map((block, index) => <ArticleBlockView key={index} block={block} />)}
          </div>
        </div>
      )}
    </div>
  )
}

/** 侧栏折叠按钮里的未读数（非交互）。 */
