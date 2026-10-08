/**
 * 正文面（2026-10-07 从 index.tsx 拆出）：结构化块渲染、阅读视图 / 原站视图切换。
 *
 * 原站视图的沙箱属性也定义在这里 —— iframe 与它的策略属于同一个概念，不该分居两个文件。
 */
import type { ReactNode } from 'react'
import type { ArticlePayload } from '../shared.js'
import type { ArticleState } from './store.js'

/**
 * 原站视图 iframe 的属性：**单点定义**——既给 JSX 用，也给契约测试断言，防止两处各说各话。
 *
 * 为什么必须沙箱（2026-10-07 安全评审）：feed 里的条目链接完全由发布者控制，而宿主的抓取
 * 接受 data: URL —— 攻击者不需要任何真站点，就能造出一个「可嵌入」的恶意页，让它在 DSH
 * 页面内以无沙箱 iframe 加载（脚本、弹窗、下载，以及一次点击后的整页跳转）。
 *
 * 刻意**不给** allow-same-origin：给了它 frame 就保留真实 origin，而一旦 SSRF 那条路径让
 * frame 落在 http://127.0.0.1:3080/...，同源且可执行脚本的 frame 能自行解除沙箱并触到 DSH
 * 页面。代价是原站拿不到自己的 cookie/storage，少数站点会显示未登录态——这是明知取舍：
 * 宁可牺牲原站登录态，也不留同源升级路径。
 * 也刻意**不给** allow-top-navigation：否则一次用户点击就能把整个标签页换成钓鱼页。
 */
export const ORIGINAL_VIEW_FRAME_PROPS = {
  sandbox: 'allow-scripts allow-forms allow-popups',
  referrerPolicy: 'no-referrer',
} as const
/** 阅读器内的正文视图（D 方案）：默认抽取正文，站点允许时可切「原站视图」看原样页面。 */
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

export function ArticleView({ article, link, onBack, onToggleRender, setBox, canPrev, canNext, onPrev, onNext }: {
  article: ArticleState | undefined
  link: string | undefined
  onBack: () => void
  onToggleRender: () => void
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
  const original = article?.render === 'original'
  const frameable = article?.frameable === true

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px',
        borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
      }}>
        <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" onClick={onBack}>← 返回列表（Esc）</button>
        <span style={{ flex: 1 }} />
        {/* 上/下一条：焦点进入 iframe 后键盘就收不到了（浏览器限制），这两个按钮是**唯一可用的切换手段**。
            标签里的键名与实际键位一致：详情页 j = 下一条、k = 上一条（n/p 是扫视，不换文章）。 */}
        <button type="button" className="dsh-rss-btn" disabled={!canPrev}
          title="上一条（k）" onClick={onPrev}>↑ 上一条</button>
        <button type="button" className="dsh-rss-btn" disabled={!canNext}
          title="下一条（j）" onClick={onNext}>↓ 下一条</button>
        <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
          disabled={!frameable || article?.loading === true}
          title={frameable
            ? '在原站原样页面与抽取正文之间切换（W 切换；本页可直接按 W）'
            : '该站点通过 X-Frame-Options / CSP 禁止被嵌入，只能看抽取版或去原站'}
          onClick={onToggleRender}>
          {original ? '阅读视图（W）' : '原站视图（W）'}
        </button>
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
      ) : original && link !== undefined ? (
        // 原站视图：浏览器内嵌整页，样式/代码/交互全是原样（已被 X-Frame-Options 放行的站点才可用）
        <>
          <div style={{ padding: '4px 20px', fontSize: 11, opacity: 0.6 }}>
            原站视图：页面内的按键由原站接管，本插件的快捷键需先点回面板——或直接用上方按钮切回阅读视图
          </div>
          <iframe
            src={link}
            title={article.title ?? '原站视图'}
            {...ORIGINAL_VIEW_FRAME_PROPS}
            style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', background: '#fff' }}
          />
        </>
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
