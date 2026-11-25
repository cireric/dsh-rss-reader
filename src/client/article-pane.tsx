/**
 * 正文面（2026-10-07 从 index.tsx 拆出，2026-10-08 去掉原站视图）：结构化块渲染。
 *
 * **为什么不再内嵌原站页面**：那个 iframe 的沙箱（无 allow-same-origin）会让现代站点的样式流程
 * 断掉、整页只剩裸 HTML；而放宽沙箱（加 allow-same-origin + 允许脚本）等于让发布者的脚本在 DSH
 * 页面上下文里跑，是当初加沙箱要挡的事。取舍结论：**正文只走抽取视图**，想看原样就用
 * 「打开原站 ↗」在新标签页看——那是浏览器自己的上下文，没有沙箱折衷。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { edgeTopFor, readingRatioOf, restoreTopFor } from '../list-scroll.js'

/**
 * 正文图片的最大显示高度（像素）。
 *
 * 为什么需要：正文里常混着超长截图（整页截图、长对话）与原图。只限宽时，一张像素高度很大的图
 * 会把版面撑出几十屏，读者要滚很久才能回到正文——「默认视图」的可读性直接崩掉。限高之后超长图
 * 缩成可辨认尺寸，需要看细节时点「打开原站」。
 */
const ARTICLE_IMAGE_MAX_HEIGHT = 640
import { estimateReadingMinutes, hasBodyText, httpUrlOrEmpty, type ItemView } from '../shared.js'
import { foldOf, groupImageBlocks, type ImageFold, type ImageGroup } from '../image-fold.js'
import { paragraphsOf } from '../html-text.js'
import { READING_FONT_SIZES, READING_LINE_WIDTHS } from '../preferences.js'
import type { ReadingPreferences } from '../preferences.js'
import type { ArticleState, TranslateConfirmRequest, TranslationEntry, TranslationMode } from './store.js'
import { TranslationModeSwitcher, TranslationSegment, translatedBlockOf } from './translate-view.js'
import {
  TARGET_LANGUAGES, TRANSLATE_BUTTON_TEXT, TRANSLATE_FAILURE_UI, TRANSLATE_LABEL_TEXT,
  translateNoticeText,
  type TargetLanguage, type TranslateFailureReason,
} from '../translate-copy.js'
import {
  articleTranslatePlanOf,
  translateCharsOf,
  TRANSLATE_BLOCK_MAX_CHARS,
  type TranslateBlockRect,
  type TranslateGeometry,
  type TranslateRect,
} from '../translate-blocks.js'
import { ConfirmDialog } from './confirm-dialog.js'
// InlineRun 从 article-text.js 取，**不从 article.js**：后者 import 了 node:crypto 与 feed/fetch.js，
// 而 client bundle 不许出现任何 node: 说明符（tsdown 不会因此报错，失败被推迟到浏览器运行期）。
// 见 docs/pitfalls.md §1.7b。
import type { InlineRun } from '../article-text.js'

/**
 * 行内代码的样式。
 *
 * 字号用 `em` 而不是 `px`：正文字号可调（M5 01），写死像素会让「放大字号」之后代码反而比
 * 周围散文更小。与 `pre` 块同一族写法（见下面 pre 分支），等宽字体栈也照抄一份 ——
 * 两处都写死同一串是刻意的：它们必须看起来是同一套字体。
 */
const INLINE_CODE_STYLE = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '0.9em',
  padding: '0.1em 0.3em',
  borderRadius: 4,
  background: 'color-mix(in srgb, currentColor 8%, transparent)',
} as const

/** 把一个「大概是对象」的值读成对象；认不出返回 undefined（`block` 是 wire 形状，处处要校验）。 */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * 块里的 `runs`（wire 形状）→ 可信的 `InlineRun[]`；认不出就返回 undefined。
 *
 * 为什么必须逐字段校验：`block` 是 `Record<string, unknown>`（端点回包 / 缓存里读回来的 JSON），
 * 本仓库禁 `as any`，也不许把「大概是那个形状」当成类型。旧缓存里根本没有这个字段，
 * 所以 undefined 是**常态**而不是边角。
 *
 * 为什么任何一条 run 认不出就**整块**退回纯文本（而不是跳过那一条）：`text` 是 `runs` 的派生
 * 投影（ADR-0007），退回纯文本是无损的；跳过一条会静默吞掉那段文字，那才是真正的内容损失。
 * 空数组与缺席同义（投影上等价，见 spec 的等价性提醒）。
 */
function inlineRunsOf(value: unknown): InlineRun[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const runs: InlineRun[] = []
  for (const entry of value) {
    const run = recordOf(entry)
    if (run === undefined) return undefined
    const text = run['text']
    if (typeof text !== 'string') return undefined
    const kind = run['kind']
    if (kind === 'link') {
      const href = run['href']
      if (typeof href !== 'string') return undefined
      runs.push({ kind: 'link', text, href })
      continue
    }
    if (kind === 'text' || kind === 'strong' || kind === 'em' || kind === 'code') {
      runs.push({ kind, text })
      continue
    }
    return undefined
  }
  return runs
}

/**
 * 列表的 `itemRuns`（wire 形状）→ 每个条目一组 run；认不出就返回 undefined。
 *
 * 判据是 spec 决策 1 那条不变量：**要么都缺席、要么与 `items` 等长同序**。长度对不上时
 * 整份退回 `items`（纯文本），而不是「能对上的就渲染」—— 那会让同一条列表里有的行是富文本、
 * 有的行是纯文本，而读者无从知道为什么。
 */
function itemRunGroupsOf(value: unknown, expectedLength: number): InlineRun[][] | undefined {
  if (!Array.isArray(value) || value.length !== expectedLength) return undefined
  const groups: InlineRun[][] = []
  for (const entry of value) {
    const runs = inlineRunsOf(entry)
    if (runs === undefined) return undefined
    groups.push(runs)
  }
  return groups
}

/**
 * 一段内联语义 → React 元素。
 *
 * 为什么按 run 渲染而不是把 runs 拼回一个字符串：链接可点、加粗/斜体/行内代码各有元素，
 * 正是读者要「一眼分出这是命令、那是散文」的东西；拼回去等于把抽取层保住的语义再丢一次。
 * 仍然**只产出 React 元素**：正文来自任意网页，React 的 innerHTML 注入口在这里必须是零
 * （验收 18 靠全仓 grep 那个标识符守住，所以注释里也不写它的字面量）。
 */
function InlineRunsView({ runs }: { runs: readonly InlineRun[] }): ReactNode {
  return runs.map((run, index) => {
    if (run.kind === 'link') {
      // 纵深防御（spec 决策 14）：抽取期已过 safeUrl，渲染期再过一次唯一白名单 httpUrlOrEmpty。
      // 认不出（历史脏数据 / javascript: / data:）⇒ 退化成纯文本，绝不产生可点的 <a>。
      const href = httpUrlOrEmpty(run.href)
      if (href === '') return <span key={index}>{run.text}</span>
      return (
        <a key={index} href={href} target="_blank" rel="noreferrer noopener"
          // 点击不冒泡到整行：列表行是 role=button（选中 + 标读），正文里的链接虽然不在行内，
          // 但同一条规矩留在这里，免得日后把富文本铺进列表时踩回「点链接顺手标了已读」。
          onClick={(event) => { event.stopPropagation() }}>{run.text}</a>
      )
    }
    if (run.kind === 'strong') return <strong key={index}>{run.text}</strong>
    if (run.kind === 'em') return <em key={index}>{run.text}</em>
    if (run.kind === 'code') return <code key={index} style={INLINE_CODE_STYLE}>{run.text}</code>
    return <span key={index}>{run.text}</span>
  })
}

/**
 * 图片三态的标记属性名：值是 `loading` / `ok` / `failed`。
 *
 * 为什么要把内部状态写进 DOM：三态在 jsdom 里**没有任何别的可观测差别**（没有布局引擎、
 * 图片不真的加载，见 `docs/pitfalls.md` §2.2），不标出来验收 9 的前半条就无法表达。
 * 它同时是 07 灯箱的入口判据（只有 `ok` 的图可点），所以不是测试脚手架。
 */
const IMAGE_STATE_ATTR = 'data-rss-image-state'

/** 图片容器的最小高度（px，spec 决策 20）：加载完成时把位移从「整张图」压到「高度差」。 */
const ARTICLE_IMAGE_MIN_HEIGHT = 120

/**
 * 正文图与灯箱图共用的 referrer 策略（**唯一来源**，两处都读它，不许各写一份）。
 *
 * 为什么是 `strict-origin-when-cross-origin` 而不是 `no-referrer`：
 * 2026-11-21 真机事故 —— `no-referrer` 让 Referer 变空，而 `cdnfile.sspai.com`（实测占本机缓存
 * 52.7% 的图）**空 Referer 一律 403**，于是所有图都显示「图片加载失败」。
 * 三态对照（浏览器 UA，逐域名 curl，三轮一致）：R6 前坏图 30.5% → no-referrer 78.9% → 本策略 30.5%。
 *
 * 而且那个隐私收益本就不存在：本插件是 SPA（`grep pushState|location|URLSearchParams src/client/`
 * 零命中），没有按文章区分的 URL，Referer 里从来只有宿主 origin、不携带「正在读哪一篇」。
 * 本策略跨源只发 origin、不发路径，既让图床通过，也仍然不暴露路径。
 *
 * ⚠️ 已知的**既有**问题（不是本属性造成，改它也不会好）：`icon.solidot.org`(26.3%) 要自家域名
 * Referer、`icon.zhiding.cn`(4.2%) 要非空 Referer，两者在 R6 之前就 403。要修得按域名决定策略，
 * 那是另一件事，别在这里顺手加白名单。
 */
const ARTICLE_IMAGE_REFERRER_POLICY = 'strict-origin-when-cross-origin'

/** 一张图的载入观察值。 */
type ImageState = 'loading' | 'ok' | 'failed'

/**
 * 正文里的一张图 —— 三态（`loading` / `ok` / `failed`）+ 占位。
 *
 * **为什么是独立子组件**（spec 决策 21）：`ArticleView` 那条「不放 `useState`」的约定管的是
 * 折叠态（它必须被 `routeKey` 读到，所以住在 `index.tsx`）。逐图的载入观察值没有任何按键要读，
 * 放进 `ArticleView` 会让每次图片载入都重渲染整篇正文。
 *
 * **为什么 `key` 必须是 `itemId + ':' + index`**（调用方负责）：换文章时若块数相同，React 会
 * 复用同一个实例 ⇒ 沿用上一篇的 `ok` 态，而新图根本没加载过。复合 key 让 React 语义化地重挂，
 * 换篇即复位，不需要 `useEffect` 去重置。
 *
 * **为什么挂载后还要补判 `complete`**（spec 决策 22）：缓存命中的图可能在 React 挂上
 * `onLoad` 监听器**之前**就已经 `complete` 了 —— 那一刻 `load` 事件早已派发完毕，只靠
 * `onLoad` 的图会永远停在「载入中」。这与 `docs/pitfalls.md` §3.1（长驻监听器不许捕获会变的值）
 * 是同一族：**事件可能早于监听器**。用 `ref` + 挂载后跑一次的 effect 补判是正确的形态
 * （`useEffect` 在 DOM 就位后跑，读到的 `complete` 是当下的值）。
 */
function ArticleImage({ src, alt, caption, onOpen }: {
  src: string
  alt: string
  caption: string
  /** 点开这张图（灯箱，R6 07）。只在 `state === 'ok'` 时挂到 `<img>` 上，见下面的注释。 */
  onOpen: (src: string) => void
}): ReactNode {
  const [state, setState] = useState<ImageState>('loading')
  const imageRef = useRef<HTMLImageElement | null>(null)

  /**
   * 补判「挂载前就已 complete」。
   *
   * 依赖数组只放 `src`：换图（同实例换 src）时要重新判一次，而 `setState` 是稳定的。
   * `naturalWidth > 0` 才是「真的解码成功」——`complete === true` 也覆盖「加载失败后放弃」
   * 那种情况（此时 `naturalWidth` 是 0），所以必须两个条件一起看（spec 决策 22）。
   */
  useEffect(() => {
    const image = imageRef.current
    if (image === null) return
    if (!image.complete) return
    setState(image.naturalWidth > 0 ? 'ok' : 'failed')
  }, [src])

  if (state === 'failed') {
    /*
     * 失败态**不渲染 `<img>`**（spec 决策 23）：留着它浏览器会画一个破图图标，
     * 而我们要的是「图片加载失败」这行字 + alt。把图换成文案，同时也让
     * 「失败态 DOM 里没有 img」成立 —— 注意与折叠态区分：折叠是根本没有 img，
     * 失败态是 img 被替换成文案。
     */
    return (
      <figure {...{ [IMAGE_STATE_ATTR]: state }} style={{ margin: '0 0 1.3em' }}>
        <div style={{
          minHeight: ARTICLE_IMAGE_MIN_HEIGHT, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 4, padding: '12px 16px',
          borderRadius: 6, textAlign: 'center',
          border: '1px dashed color-mix(in srgb, currentColor 25%, transparent)',
          background: 'color-mix(in srgb, currentColor 4%, transparent)',
        }}>
          <span>图片加载失败</span>
          {/* 有 alt 就一并显示：它是这张图唯一的可读内容，丢掉等于什么都不剩 */}
          {alt !== '' && <span className="dsh-rss-meta">{alt}</span>}
        </div>
        {caption !== '' && (
          <figcaption className="dsh-rss-meta" style={{ marginTop: 8, textAlign: 'center' }}>{caption}</figcaption>
        )}
      </figure>
    )
  }

  return (
    <figure {...{ [IMAGE_STATE_ATTR]: state }} style={{ margin: '0 0 1.3em' }}>
      {/*
       * loading=lazy：长文里的图片很多，一次性加载会拖慢首屏。
       * decoding=async 让解码不阻塞滚动。
       * referrerPolicy=strict-origin-when-cross-origin：**浏览器默认值，显式写出来是为了钉住它**。
       *
       * ⚠️ 2026-11-21 真机回归（病象 → 根因 → 修法）：这里原本写的是 `no-referrer`（R6 01 的隐私改动），
       * 结果**所有图都显示「图片加载失败」**。根因（`实测`，浏览器 UA 逐域名 curl）：空 Referer 会让
       * `cdnfile.sspai.com`（本机缓存里 52.7% 的图）返回 403，非空才 200；三态对照是
       * R6 前坏图 30.5% → R6 后 78.9% → 本策略 30.5%。也就是说那条隐私改动用「真实功能损坏」
       * 换了一个**并不存在**的收益：本插件是 SPA（`grep pushState|location|URLSearchParams src/client/`
       * 零命中），没有按文章区分的 URL，所以 Referer 里从来只有宿主 origin，不携带「正在读哪一篇」。
       * 本策略跨源只发 origin、不发路径，既让图床通过，也仍然不暴露路径。
       *
       * 另注：`icon.solidot.org`(26.3%) 与 `icon.zhiding.cn`(4.2%) 在 R6 之前就 403 —— 那是**既有的**
       * 防盗链问题（前者要自家域名 Referer，后者要非空），不是本次回归，也不由本属性决定。
       * maxHeight 与 objectFit：正文里混着长截图与原图，只限宽的话一张 1×3000 的图会把版面撑出
       * 几十屏。限高之后超长图缩成可辨认的尺寸（点开原站看大图），版面保持连续。
       * minHeight 在外层容器上、不在 <img> 上（spec 决策 20）：占位要的是「容器先占住 120px」，
       * 加在图上会把图本身拉高。
       */}
      <div style={{ minHeight: ARTICLE_IMAGE_MIN_HEIGHT }}>
        {/*
         * 灯箱入口（R6 07，spec 决策 24）：**只给 `ok` 的图挂点击**。
         *
         * 判据是 `state === 'ok'`，不是「有没有 `<img>`」——「载入中」的图也在 DOM 里，
         * 若按元素类型挂点击，读者会在还在加载的占位块上点出一个空灯箱（或一张永远不出图的灯箱）。
         * 这也正是 06 把三态写进 `data-rss-image-state` 的第二个用处（第一个是验收 9 的可观测性）。
         *
         * `cursor: zoom-in` 只在可点时给：它是「这张图能点」的唯一视觉线索，而不可点的图上
         * 摆一个放大镜手势就是撒谎。
         */}
        <img ref={imageRef} src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy={ARTICLE_IMAGE_REFERRER_POLICY}
          onLoad={() => { setState('ok') }}
          onError={() => { setState('failed') }}
          onClick={state === 'ok' ? () => { onOpen(src) } : undefined}
          style={{
            display: 'block', margin: '0 auto', width: '100%', height: 'auto',
            maxHeight: ARTICLE_IMAGE_MAX_HEIGHT, objectFit: 'contain', borderRadius: 6,
            cursor: state === 'ok' ? 'zoom-in' : 'default',
          }} />
      </div>
      {caption !== '' && (
        <figcaption className="dsh-rss-meta" style={{ marginTop: 8, textAlign: 'center' }}>{caption}</figcaption>
      )}
    </figure>
  )
}

/**
 * 单个正文块的渲染。
 *
 * 之所以要分类型：用户反馈「图片不显示、样式变形」——根因是抽取层过去只回传纯文本段落，
 * 图片被整块丢弃、标题/列表/引用的语义也没了，客户端只能一律当段落排版。
 * 这里按块类型给语义化样式（图片限宽、列表留符号、引用加左边线、标题分级字号）。
 *
 * **`runs` 缺席时逐字照旧渲染 `text`**（R5 03）：纯文本段落本来就不产出 runs（`runsFieldOf`
 * 只在存在非 text run 时才写字段），所以「没有 runs」是常态路径，不是兼容分支 —— 旧缓存、
 * 纯文本段落、R4 的回退摘要（`paragraphBlocks` 造的 p 块）全都走这里。
 */
function ArticleBlockView({ block, onOpenImage, textOverride, itemOverride }: {
  block: Record<string, unknown>
  /** 点开这张图（灯箱）。图片块以外的块不读它。 */
  onOpenImage: (src: string) => void
  /**
   * 译文态（R7 03）：给了纯文本就替换本块文字，忽略 runs —— 译文是纯文本，没有内联语义（D8）。
   * 只由可翻块（p / h / quote）传入；list 用 `itemOverride`，pre / img / table 永不传。
   */
  textOverride?: string
  /** 译文态 list：按行拆好且**行数已校验**的译文条目（判据在 translate-view 的 translatedBlockOf）。 */
  itemOverride?: readonly string[]
}): ReactNode {
  const kind = typeof block['kind'] === 'string' ? block['kind'] : 'p'
  const text = typeof block['text'] === 'string' ? block['text'] : ''
  const runs = inlineRunsOf(block['runs'])
  /** 带内联语义就按 run 画，否则原样画 `text`（两条路的内容相同，只是前者有元素语义）。 */
  const inline = (fallback: string): ReactNode => {
    if (textOverride !== undefined) return textOverride
    return runs === undefined ? fallback : <InlineRunsView runs={runs} />
  }

  if (kind === 'img') {
    const src = typeof block['src'] === 'string' ? block['src'] : ''
    if (src === '') return null
    const alt = typeof block['alt'] === 'string' ? block['alt'] : ''
    const caption = typeof block['caption'] === 'string' ? block['caption'] : ''
    // 三态与占位全在子组件里（spec 决策 21）：本组件保持无 state。
    return <ArticleImage src={src} alt={alt} caption={caption} onOpen={onOpenImage} />
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
      <div style={{ fontSize: size, fontWeight: 600, lineHeight: 1.4, margin: '1.4em 0 0.5em' }}>{inline(text)}</div>
    )
  }

  if (kind === 'list') {
    const ordered = block['ordered'] === true
    const originalItems = Array.isArray(block['items']) ? block['items'] : []
    // 译文态：条目来自已经校验过行数的译文行；原文的 itemRuns 此时完全没有意义（文字已换）。
    const items = itemOverride !== undefined ? itemOverride : originalItems
    // itemRuns 与 items 等长同序才用（判据见 itemRunGroupsOf）；否则整份退回纯文本。
    const itemRuns = itemOverride === undefined ? itemRunGroupsOf(block['itemRuns'], originalItems.length) : undefined
    const ListTag = ordered ? 'ol' : 'ul'
    return (
      <ListTag style={{ margin: '0 0 1.1em', paddingLeft: '1.5em' }}>
        {items.map((entry, index) => {
          const group = itemRuns === undefined ? undefined : itemRuns[index]
          return (
            <li key={index} style={{ marginBottom: '0.3em' }}>
              {group === undefined ? String(entry) : <InlineRunsView runs={group} />}
            </li>
          )
        })}
      </ListTag>
    )
  }

  if (kind === 'quote') {
    return (
      <blockquote style={{
        margin: '0 0 1.1em', padding: '0.2em 0 0.2em 1em',
        borderLeft: '3px solid color-mix(in srgb, currentColor 25%, transparent)',
        opacity: 0.9,
      }}>{inline(text)}</blockquote>
    )
  }

  if (kind === 'table') return <TableBlockView block={block} />

  return <p style={{ margin: '0 0 1.05em' }}>{inline(text)}</p>
}

/**
 * 表格块 → 真正的 `<table>`（R5 04）。
 *
 * **为什么不能沿用「按 text 渲染」那条路**：`table` 块两个字段都没有（既没有 `text` 也没有
 * `items`），落到默认分支只会渲染出一个空 `<p>` —— 表格整块消失。而把行列摊成流水文字则
 * 丢掉全部行列关系，那正是本项要修的观感。
 *
 * 横向滚动：外层容器 `overflowX: auto`。窄栏下 5 列的表格必然比正文栏宽，不给它自己的滚动
 * 上下文就只能压成一堆换行或撑破正文栏。⚠️ 这条的**真实观感**只能在真机上看（jsdom 没有布局
 * 能力，见 `docs/pitfalls.md` §2.2），用例只断言结构与样式属性。
 *
 * 字号用 `em` 而不是 `px`：与 `pre` 同一理由 —— 正文字号可调（M5 01），写死 px 会让表格在
 * 20px 正文下显得很小。`0.9375em` 比正文略小：表格信息密度高，与正文同号会显得笨重。
 */
function TableBlockView({ block }: { block: Record<string, unknown> }): ReactNode {
  /** 单元格只认字符串（wire 形状宽松，认不出就当空串 —— 不编造内容）。 */
  const cellText = (value: unknown): string => (typeof value === 'string' ? value : '')
  const rowCells = (row: unknown): string[] => (Array.isArray(row) ? row.map(cellText) : [])
  const header = Array.isArray(block['header']) ? block['header'].map(cellText) : undefined
  const rows = Array.isArray(block['rows']) ? block['rows'].map(rowCells) : []
  const align = Array.isArray(block['align']) ? block['align'] : []
  /** 列对齐：只认 left / center / right，其余（含缺席）返回 undefined ⇒ 不设 textAlign。 */
  const alignOf = (column: number): 'left' | 'center' | 'right' | undefined => {
    const value = align[column]
    return value === 'left' || value === 'center' || value === 'right' ? value : undefined
  }
  const cellStyle = (column: number): { textAlign?: 'left' | 'center' | 'right' } => {
    const textAlign = alignOf(column)
    return textAlign === undefined ? {} : { textAlign }
  }
  // 没有 header 也没有数据行时什么都不画（空表格没有可读内容，画个空壳只会误导）
  if (header === undefined && rows.length === 0) return null
  return (
    <div style={{ margin: '0 0 1.1em', overflowX: 'auto', fontSize: '0.9375em' }}>
      <table style={{
        borderCollapse: 'collapse', lineHeight: 1.6,
        // 不让表格被压成极窄的多行：内容不够时按内容排，超宽时由外层容器横向滚动
        minWidth: '100%',
      }}>
        {header !== undefined && (
          <thead>
            <tr>
              {header.map((cell, column) => (
                <th key={column} style={{
                  fontWeight: 600, textAlign: alignOf(column), padding: '0.35em 0.6em',
                  borderBottom: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
                  whiteSpace: 'nowrap',
                }}>{cell}</th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, column) => (
                <td key={column} style={{
                  ...cellStyle(column), padding: '0.35em 0.6em',
                  borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
                  verticalAlign: 'top',
                }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * 纯文本段落 → p 块。
 *
 * 两处共用：老缓存的 `paragraphs`（正文）与回退段落（R4-B2）都只是字符串，都该走
 * `ArticleBlockView` 的 p 分支。原先两处各写一份 `map((text) => ({ kind: 'p', text }))`，
 * 一份改了（包一层块 / 去空白）另一份不会跟着改。
 */
function paragraphBlocks(paragraphs: readonly string[]): Array<Record<string, unknown>> {
  return paragraphs.map((text) => ({ kind: 'p', text }))
}

/** 折叠提示上的标记属性名：值是该组的序号（测试按它定位，spec 未规定名字，本票定为这个）。 */
const IMAGE_FOLD_ATTR = 'data-rss-image-fold'

/**
 * 一组图片的折叠提示文案（spec 决策 8）。
 *
 * 单图优先 `caption` 再 `alt`：caption 是读者在图上看得见的图注，alt 是给读屏器与加载失败时用的
 * 备选。两者都空时只说「图片」——**不编造**说明文字（AGENTS.md「不编造数据」）。
 * 多图组按张数说话：列各图说明会把一条提示撑成一小段，而读者的意图只是「这里有 3 张图」。
 */
function foldLabelOf(group: ImageGroup): string {
  if (group.blocks.length > 1) return '▸ 图片 ' + group.blocks.length + ' 张'
  const block = group.blocks[0]
  const caption = typeof block['caption'] === 'string' ? block['caption'] : ''
  const alt = typeof block['alt'] === 'string' ? block['alt'] : ''
  const label = caption !== '' ? caption : alt
  return label === '' ? '▸ 图片' : '▸ 图片：' + label
}

/**
 * 折叠态的一条提示。
 *
 * **刻意是普通文本元素 + `onClick`，不是 `<button>` / `<summary>`，也不给 `tabIndex`**（spec 决策 11）：
 *  - 正文视图里**空格 = 翻页**。可聚焦控件（`<button>`）会带着自己的空格激活语义，而
 *    `keyboard-routing.ts` 的 `isTypingTarget` 对 `<button>` 返回 `false` ⇒ 守卫不挡，
 *    翻页静默失效；
 *  - 提示进 Tab 序还会让键盘用户在长文里 Tab 过几十条提示。
 * 键盘路径一律走 `i` 键（04 的票），鼠标路径走这里的 `onClick`——符合本插件「鼠标可选、键盘完备」的分工。
 *
 * 为什么是 `<div>` 而不是 `<span>`：它是块级的一条「占位提示」，夹在段落之间；行内 `<span>`
 * 会让上下段落的间距塌成一行（视觉上分不清「这里有一张图被折叠了」）。
 * `tabIndex` 在 `<div>` 上天然是 -1（`实测` jsdom：`<div>` / `<span>` 的 `tabIndex` 都是 -1），
 * 所以不写它 —— 写了也只是让验收 6 的 `[tabindex]` 类判据有歧义。
 * 也不加 `role="button"`：读屏器把它念成一段文字正是我们要的（它不是键盘可达的控件）。
 */
function ImageFoldHint({ group, onExpand }: {
  group: ImageGroup
  onExpand: (groupIndex: number) => void
}): ReactNode {
  return (
    <div
      {...{ [IMAGE_FOLD_ATTR]: String(group.index) }}
      onClick={() => { onExpand(group.index) }}
      style={{
        margin: '0 0 1.1em', padding: '6px 10px', borderRadius: 6,
        border: '1px dashed color-mix(in srgb, currentColor 25%, transparent)',
        cursor: 'pointer', opacity: 0.85,
      }}
    >{foldLabelOf(group)}</div>
  )
}

/**
 * 灯箱覆盖层的标记属性名：值是它正在显示的那张图的 `src`。
 *
 * 与 `data-rss-image-state` / `data-rss-image-fold` 同一约定：标记写没写进 DOM 本身也是被测行为
 * （测试按它现取节点，不认行号与组件树形状）。值放 `src` 而不是空串，是为了让「灯箱开的是哪张图」
 * 在 DOM 里可直接读 —— 否则「换篇后灯箱关了」与「灯箱开成了新文章的第一张图」不可区分。
 */
const LIGHTBOX_ATTR = 'data-rss-lightbox'

/**
 * 灯箱（R6 07，spec 决策 24–28）：点已加载的正文图看大图。
 *
 * **为什么 `inset: 0` 挂在这里而不是面板根**：`ArticleView` 的外层已经是 `position: relative`
 * （给右下角跳转按钮当地坐标系），覆盖层铺在那一层里就天然只盖正文面 —— 顶栏的「返回列表」
 * 与左栏的源都还在，读者不用先关灯箱才能换一篇。挂到面板根会连它们一起盖住；挂进滚动容器
 * 会让覆盖层跟着内容滚走。零布局改动。
 *
 * **`z-index: 5`**：压在正文之上、在帮助浮窗（`z-index: 6`）之下 —— 与 `back` 动作里
 * 「帮助 → 灯箱 → 退出正文」的 Esc 优先级一致（视觉最上层先关）。
 *
 * **为什么不用 `role="dialog"` / `aria-modal`**（spec 决策 25）：`keyboard-routing.ts` 的
 * `isTypingTarget` 会把焦点落在 `[role="dialog"]` / `[aria-modal="true"]` / `<dialog>` 里的按键
 * **全部吞掉，含 Esc**。读者只要用鼠标点过一次灯箱里的图，焦点进了覆盖层，Esc 就再也关不掉它
 * —— 帮助浮窗踩过同一个坑（`HelpPanel` 的注释记着那次实测事故）。所以这里用
 * `role="region"` + `aria-label`，按键照常路由到正文（非模态，spec 决策 27）。
 *
 * **点背景关、点图不关**：关闭挂在外层 `onClick` 上，图上的 `onClick` 要 `stopPropagation()`。
 * 不做「点图也关」——读者点一下大图常常是想看细节或只是误触，那一下不该把大图收掉。
 */
function Lightbox({ src, onClose }: {
  src: string
  onClose: () => void
}): ReactNode {
  return (
    <div
      {...{ [LIGHTBOX_ATTR]: src }}
      role="region"
      aria-label="图片查看"
      // tabIndex 让覆盖层可聚焦：读者用鼠标点进来之后 Esc 仍要有落点可发（与浮窗同一条约定）。
      // -1 而不是 0：它不该进 Tab 序 —— 键盘路径是「点图 → Esc」，中间不该多一站。
      tabIndex={-1}
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 5,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 12, padding: 16,
        // 半透明遮罩：正文仍在背后隐约可见，读者不会以为「整页被换掉了」
        background: 'color-mix(in srgb, var(--rss-bg) 88%, transparent)',
        backdropFilter: 'blur(2px)',
        outline: 'none',
      }}
    >
      <img
        src={src}
        alt=""
        // 与正文图同一条策略（2026-11-21 防盗链回归）：见正文图那段注释。
        // 两处必须一致 —— 各写一个会出现「正文能显示、点开却失败」。
        referrerPolicy={ARTICLE_IMAGE_REFERRER_POLICY}
        // 点图本身不关闭：冒泡到外层就会触发 onClose，所以必须在这里截断。
        onClick={(event) => { event.stopPropagation() }}
        style={{
          // 原尺寸（spec 决策 24）：限宽不横向溢出、限高不纵向撑出屏幕。
          // objectFit: contain 让长截图等比缩进可视区，而不是被裁掉一头。
          maxWidth: '100%', maxHeight: '100vh', objectFit: 'contain',
          borderRadius: 6, background: 'var(--rss-bg)',
        }}
      />
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        // 与正文图同一条策略：新标签打开也是一次请求，策略不一致会让「正文能看、点原图打不开」。
        referrerPolicy={ARTICLE_IMAGE_REFERRER_POLICY}
        // 链接的点击同样不许冒泡到背景（否则「点原图」会先把灯箱关掉再开新标签）
        onClick={(event) => { event.stopPropagation() }}
        style={{ fontSize: 13, color: 'var(--rss-accent)' }}
      >原图 ↗</a>
    </div>
  )
}

/** `getBoundingClientRect()` → 纯函数认的四个数（DOMRect 不进 translate-blocks）。 */
function rectOf(element: Element): TranslateRect {
  const rect = element.getBoundingClientRect()
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
}

/**
 * 量当前正文的视口几何（spec §4.3）：滚动容器 + 每个块的矩形。
 *
 * 块锚点是渲染层打的 `data-rss-block={块下标}`（见下面 displayBlocks.map）。用锚点而不是把 ref
 * 数组抬到 React 里：块下标本来就是渲染的唯一身份，锚点让「DOM 顺序 === displayBlocks 下标」
 * 成为可核对的事实；图片折叠只让成员返回 null，剩下的锚点仍带着原下标。
 */
function translateGeometryOf(box: HTMLElement): TranslateGeometry {
  const blocks: TranslateBlockRect[] = []
  for (const node of box.querySelectorAll<HTMLElement>('[data-rss-block]')) {
    const raw = node.getAttribute('data-rss-block')
    if (raw === null) continue
    const index = Number(raw)
    if (!Number.isInteger(index) || index < 0) continue
    blocks.push({ index, rect: rectOf(node) })
  }
  return { container: rectOf(box), blocks }
}

export function ArticleView({ article, item, onBack, onRetry, scrollAttr, canPrev, canNext, onPrev, onNext, reading, onReading, onSaveProgress, expandedGroups, onExpandImageGroup, imagesExpanded, lightboxSrc, onOpenImage, onCloseLightbox, translation, translationMode, onTranslationMode, translateAvailable, translateTarget, onTranslateTarget, onTranslate, onContinueTranslate, onRetranslate, translateConfirm, onConfirmTranslate, onCancelTranslate, onStopTranslate, onRetryBatch }: {
  article: ArticleState | undefined
  item: ItemView | undefined
  onBack: () => void
  /**
   * 当前正文的译文（R7 01）：键是 `itemId:contentVersion:target`，由 index.tsx 从 store
   * 现查后传入。组件不持有译文状态 —— 切条目 / 切面板回来才不会丢（spec §4.6）。
   */
  translation: TranslationEntry | undefined
  /** 三态（R7 03）：值归 store 所有，本组件只照着画、把用户的切换交回去。 */
  translationMode: TranslationMode
  /** 点切换器 ⇒ 只改 store 里的显示态（动作层不发 rpc，验收 12）。 */
  onTranslationMode: (mode: TranslationMode) => void
  /**
   * 翻译当前是否可用（R7 02，spec §4.1）：`translateInfo.available === true` 才渲染「译」按钮
   * 与 Aa 面板里的目标语言下拉。判据只由 store 持有，组件不自己再探一次。
   */
  translateAvailable: boolean
  /** 目标语言（R7 02 / §5.3）：值与设置页「显示」分区共用 store 里的同一份。 */
  translateTarget: TargetLanguage
  /** 改目标语言：交给 store 落进 viewPreferences，组件不持有状态。 */
  onTranslateTarget: (target: TargetLanguage) => void
  /**
   * 点「译」：动作在 store 的 translate-actions 里，组件只交回意图与**点击那一刻**量到的几何。
   * 几何不进 props / state：滚动位置随时在变，只有点击瞬间的视口才是「第一批翻哪些」的依据。
   */
  onTranslate: (geometry: TranslateGeometry | undefined) => void
  /** 「继续翻译（还剩 N/M）」：以现有进度续跑，已译块不重发（R7 06 / D19）。 */
  onContinueTranslate: (geometry: TranslateGeometry | undefined) => void
  /** 「重译」：清空该 key 的译文后整篇重发（R7 06 / D19），不绑快捷键。 */
  onRetranslate: (geometry: TranslateGeometry | undefined) => void
  /** 首次外发确认框的待确认内容；undefined = 不显示（R7 06 / spec §4.2）。 */
  translateConfirm: TranslateConfirmRequest | undefined
  /** 确认外发：组件在确认那一刻再量一次视口，然后交给动作层写标记 + 开始翻译。 */
  onConfirmTranslate: (geometry: TranslateGeometry | undefined) => void
  /** 取消外发：只清确认态，不写 settings、不发 rpc。 */
  onCancelTranslate: () => void
  /**
   * 停止后续批（R7 04）：组件卸载 = 离开正文面 / 切面板。在途那一批允许跑完，
   * store 的编排会在下一批前看到 token 已变而退出（spec §4.6 / D18）。
   */
  onStopTranslate: () => void
  /**
   * 重试一个失败批（R7 05）：参数是**批首块下标**，动作层按 entry.failures 找回整批 indices。
   * 组件不缓存批次内容 —— 失败批的唯一真相在 store，组件只把用户点的那个批首交回去。
   */
  onRetryBatch: (headIndex: number) => void
  /**
   * 重试抓取当前正文页这一篇（R4-B4）。
   * 请求哪个条目由 store 按 `article.itemId` 决定，本组件只负责把用户意图交回去 ——
   * 组件不碰 selectedId：正文页的唯一真相是 article.itemId（见 list-actions.ts 的 loadArticle）。
   */
  onRetry: () => void
  /** 记一次阅读进度（M5 02）：只在切换 / 关闭 / 卸载时调，滚动本身不写盘 */
  onSaveProgress: (itemId: string, contentVersion: string, ratio: number) => void
  /** 正文排版偏好（M5 01）：值归 store 所有，本组件只负责照着画、把用户的改动交回去 */
  reading: ReadingPreferences
  onReading: (patch: Partial<ReadingPreferences>) => void
  /**
   * 被点开的图片组序号（R6 03 的**组级覆盖**，spec 决策 5 / 14）。
   *
   * 状态住在 `index.tsx` 而不是本组件：`i` 键（04 的票）要在 `routeKey` 里读到它并清空它，
   * 而 `routeKey` 与 `ArticleView` 是两个组件。本票只有「点提示」这一条写入路径，但它与 `i`
   * 必须共享**同一个** state，否则 04 会再造一份、两份判定分家。
   */
  expandedGroups: ReadonlySet<number>
  /** 点某组的折叠提示 ⇒ 只展开那一组（组是原子的，spec 决策 19）。 */
  onExpandImageGroup: (groupIndex: number) => void
  /**
   * 图片折叠的**篇级覆盖**（R6 04，spec 决策 5 / 14）：`undefined` = 这一篇还没按过 `i`。
   *
   * 状态住在 `index.tsx`（与 `expandedGroups` 同一条通道），本组件只照着画：`i` 键在
   * `routeKey` 里写它，若状态留在本组件里，按键与渲染就会脱钩（spec 验收 18）。
   * 它与组覆盖是两层：`组覆盖 ?? 篇覆盖 ?? 偏好`（`foldOf` 是唯一裁决点）。
   */
  imagesExpanded: boolean | undefined
  /**
   * 灯箱正在显示的那张图的 `src`（R6 07，spec 决策 14 / 26）：`undefined` = 灯箱关着。
   *
   * 与 `imagesExpanded` / `expandedGroups` 同一条通道（`useState` 在 `index.tsx` → 进
   * `KeyRoutingCtx` → 进 `routeKey` 调用 → 进依赖数组 → 作为 prop 传到这里）。
   * **必须抬上去，不是可选**：`Esc` 由 `routeKey` 的 `back` 动作按优先级处理，而 `back`
   * 读的是 `ctx`；状态留在本组件里，`Esc` 永远读不到它（spec 决策 14 的实测理由）。
   * 本组件只负责照着画 —— 打开走 `onOpenImage`，关闭走 `onCloseLightbox`。
   */
  lightboxSrc: string | undefined
  /** 点某张已载入的图 ⇒ 打开灯箱（写入 `lightboxSrc`）。 */
  onOpenImage: (src: string) => void
  /** 关闭灯箱（点背景）。`Esc` 走的是 `back` 动作，不经过这里。 */
  onCloseLightbox: () => void
  /** 容器标记属性名：按键处理按它现取容器（取值集中在 list-scroll.ts 的 scrollSelectorFor） */
  scrollAttr: string
  /** 上/下一条是否可切（与键盘共用同一判定，见 canStepArticle） */
  canPrev: boolean
  canNext: boolean
  onPrev: () => void
  onNext: () => void
}): ReactNode {
  // 新缓存是结构化块；老缓存只有纯文本段落——把后者包成 p 块，走同一条渲染路径。
  // 这份 blocks **只用于估算阅读时长**，回退段落绝不进来（R4-B5）。
  const readingBlocks: Array<Record<string, unknown>> = article?.blocks !== undefined
    ? article.blocks
    : paragraphBlocks(article?.paragraphs ?? [])
  /**
   * 回退内容（R4-B1）：正文区没有可渲染块时，用订阅源自带的摘要兜底。
   *
   * 判据与列表行**完全一致**：paragraphsOf 切段 + hasBodyText 过 40 字门槛（两处共用一份实现）。
   * 内容只在渲染期从 item.summary 现算，不写进 ArticleState —— 第二次打开同一条仍会请求原站，
   * 原站恢复后自然重抓。加载中 / 没有 article 时不回退：那两态没有「正文不可用」可谈。
   */
  const hasRenderedBlocks = readingBlocks.length > 0
  const fallbackParagraphs = hasRenderedBlocks ? [] : paragraphsOf(item?.summary)
  const hasFallbackBody = !hasRenderedBlocks && hasBodyText(fallbackParagraphs)
  /**
   * 正文区此刻的形态 —— **唯一**的派生判别式。
   *
   * 改造前同一件事写了三遍：回退标签看 `fallback !== undefined`、错误块看
   * `failure !== undefined && fallback === undefined`、回顶按钮又手工拼
   * `failure === undefined || fallbackActive`。三份表达式必须永远一致，改一处漏一处就会出
   * 「有回退内容却没有回顶按钮」这类错位。现在渲染、标签、回顶按钮都只读这一个值。
   *
   * 顺序即优先级，与改造前三个渲染分支逐字对应：没有 article 或加载中 → loading；
   * 有回退内容 → fallback；端点给了失败原因 → failed；其余 → content
   * （含「成功但 blocks 为空且摘要不够门槛」的空白正文，保持原样）。
   */
  const bodyState: 'loading' | 'failed' | 'fallback' | 'content' =
    article === undefined || article.loading === true
      ? 'loading'
      : hasFallbackBody
        ? 'fallback'
        : article.failure !== undefined
          ? 'failed'
          : 'content'
  /** 失败原因原文：回退态的原因行与错误块共用，照实显示、不改写（R4-B3 / R4-B7）。 */
  const articleFailure = article?.failure
  /**
   * 实际画出来的 blocks：回退态是摘要段落（复用 ArticleBlockView 的 p 分支）。
   * 与 readingBlocks 分成两个变量的理由见 R4-B5 —— 回退内容没有 contentVersion，
   * 算进阅读时长就是给用户一个不属于这篇正文的分钟数。
   */
  const displayBlocks: Array<Record<string, unknown>> = bodyState === 'fallback'
    ? paragraphBlocks(fallbackParagraphs)
    : readingBlocks
  /**
   * 图片组（spec 决策 16）：按 `displayBlocks` 的块顺序切，组序号就是这里的下标。
   *
   * 在**同一份** `displayBlocks` 上分组（不是 `readingBlocks`）：回退态画的是摘要段落，
   * 两者不是同一个数组；拿错数组会让「回退态没有图片提示」这条自动成立的性质变成巧合。
   * 回退段落不含 `img` 块 ⇒ 分组天然为空 ⇒ 提示不出现（spec 验收 23）。
   */
  const imageGroups = groupImageBlocks(displayBlocks)
  /**
   * 折叠判定体（spec 决策 6）：**每次渲染现造**，绝不进 `useMemo`。
   *
   * `foldOf` 在构造时对组覆盖 `Set` 取快照（见 `image-fold.ts` 的注释），所以把它缓存下来
   * 再指望它跟着新 `Set` 变，症状是「点了提示没反应」或「`i` 按了不生效」。
   * 三层输入齐了：偏好 `reading.expandImages`、篇级覆盖 `imagesExpanded`（04 的 `i` 写的）、
   * 组级覆盖 `expandedGroups`（03 的点提示写的）。判定顺序 `组 ?? 篇 ?? 偏好` 只在 `foldOf` 里算。
   */
  const fold: ImageFold = foldOf(reading.expandImages, imagesExpanded, expandedGroups)
  /** 块下标 → 该块所属的组；非图片块不在表里。 */
  const groupOfBlock = new Map<number, ImageGroup>()
  for (const group of imageGroups) {
    for (const blockIndex of group.blockIndexes) groupOfBlock.set(blockIndex, group)
  }
  /**
   * 本篇的条目 id：复合 key 的前半截（spec 决策 21）。
   * 取 `article.itemId` 而不是 `item.id`：正文页的唯一真相是 article.itemId（见 list-actions.ts
   * 的 loadArticle）—— item 可能已经被列表侧的选中变化换到别的条目，那时 key 会跟着错。
   */
  const articleItemId = article?.itemId ?? ''
  /**
   * 正文块的 React key：**`itemId + ':' + index`**，不是裸 `index`（spec 决策 21）。
   *
   * 裸下标在换文章时若块数相同，React 会复用同一个 `ArticleBlockView` 实例 ——
   * 里面的 `<ArticleImage>` 于是沿用上一篇的 `ok` 态，而新图根本没加载过（读者看到一张
   * 从没加载成功的图被当成「已载入」）。复合 key 让 React 语义化地重挂，换篇即复位，
   * 不需要 `useEffect` 去重置状态。折叠提示也用同一个 key：它本身无状态，但同一个 map
   * 里的 key 必须互不冲突。
   */
  const blockKeyOf = (at: number): string => articleItemId + ':' + at
  /**
   * 实际生效的三态（R7 03）：**没有译文条目时一律按原文画**，切换器也不出现（spec §4.5）。
   * 这一层派生放在渲染处，store 只保存用户选过的态 —— 否则「有没有译文」会被复制成第二个判据。
   */
  const effectiveMode: TranslationMode = translation === undefined ? 'original' : translationMode
  /**
   * 块下标 → 它所属的失败批（R7 05）。`failures` 以批首为键，渲染要按**块**找原因，
   * 所以先摊平成「块 → { 批首, 原因 }」：同批每块位置显示原因，只有批首位置放重试按钮。
   */
  const failedBatchOf = new Map<number, { readonly head: number; readonly reason: TranslateFailureReason }>()
  if (translation !== undefined) {
    for (const [head, failure] of translation.failures) {
      for (const index of failure.indices) failedBatchOf.set(index, { head, reason: failure.reason })
    }
  }
  /**
   * 标题三态（spec §4.5）：
   *  - 译文态：有译文标题且没有失败标记 ⇒ 译文标题；标题翻译失败 ⇒ 原文标题 + 角标；
   *  - 对照态：**永远**原文标题（对照的用途是核对正文，标题不参与）；
   *  - 原文态：原文标题。
   */
  const translatedTitle = effectiveMode === 'translated' && translation?.titleFailed !== true
    ? translation?.title
    : undefined
  const title = translatedTitle !== undefined ? translatedTitle : (article?.title || item?.title)
  const titleNotTranslated = effectiveMode === 'translated' && translation?.titleFailed === true
  const publishedAt = item?.publishedAt
  // R12：作者只由 src/author.ts 在读路径归一化；这里直接用投影值，不再加桩件守卫。
  const author = item?.author
  // 历史行可能带脏 link（修复前落库的 javascript:）：渲染前过 shared.ts 的唯一白名单。
  // 认不出就当作「无链接」——与 item.link === '' 的既有语义一致（不渲染「打开原站」）。
  const rawLink = item?.link
  const link = rawLink === undefined ? undefined : httpUrlOrEmpty(rawLink)
  // 只按**已缓存的正文**估：加载中 / 抓取失败时 readingBlocks 为空 ⇒ 0 ⇒ 界面不出现任何数字。
  // 刻意不拿 summary 或源里的 excerpt 去凑 —— 回退内容不是原站正文，不给它编一个时长（R4-B5）。
  const readMinutes = estimateReadingMinutes(readingBlocks)
  /**
   * 翻译按钮的状态机（R7 06 / spec §4.1 / D19）：
   *  无条目 → 译；在译 → 停止；中止且还有剩余 → 继续；完成 / 失败 → 重译（次要样式）。
   *
   * 「还剩 N/M」与进度同一口径（total - done）：done 是**成功回填的块数**，失败批不计入，
   * 所以读者看到的剩余量就是继续之后真正会补的批（失败批另有重试按钮，不混进这句文案）。
   */
  const translatePlan = articleTranslatePlanOf(article?.blocks ?? [])
  const translateEmpty = translatePlan.totalBlocks === 0 && translatePlan.overlongBlocks.length === 0
  const translateRemaining = translation === undefined ? 0 : Math.max(0, translation.total - translation.done)
  const translateButtonState: 'translate' | 'stop' | 'continue' | 'retranslate' = translation === undefined
    ? 'translate'
    : translation.status === 'running'
      ? 'stop'
      : translation.status === 'stopped' && translateRemaining > 0
        ? 'continue'
        : 'retranslate'
  const translateButtonText = translateButtonState === 'translate'
    ? TRANSLATE_BUTTON_TEXT.translate
    : translateButtonState === 'stop'
      ? TRANSLATE_BUTTON_TEXT.stop
      : translateButtonState === 'continue'
        ? TRANSLATE_BUTTON_TEXT.continue(translateRemaining, translation?.total ?? 0)
        : TRANSLATE_BUTTON_TEXT.retranslate
  const translateButtonTitle = translateEmpty
    ? '这篇没有可翻译的正文'
    : translateButtonState === 'translate'
      ? '翻译当前文章（先译屏幕内的段落）'
      : translateButtonState === 'stop'
        ? '停止后续批次（在途一批会跑完）'
        : translateButtonState === 'continue'
          ? '继续翻译剩余段落（已译块不重发）'
          : '重新翻译整篇（会重新调用模型）'

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
  /** 「译」按钮的 ref：确认框关闭后把焦点还给触发它的控件（与设置页三处确认框同一条约定）。 */
  const translateButtonRef = useRef<HTMLButtonElement | null>(null)
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

  /**
   * 卸载中止（R7 04 / D18）：组件卸载 = 切面板 / 离开正文面，后续批必须停。
   *
   * 用 ref 转发而不是把 `onStopTranslate` 直接放进依赖数组：父组件回调身份一旦变化，
   * effect 的 cleanup 会跟着跑一次 —— 那会在一次普通重渲染里把正在跑的翻译停掉。
   */
  const onStopTranslateRef = useRef(onStopTranslate)
  useEffect(() => { onStopTranslateRef.current = onStopTranslate }, [onStopTranslate])
  useEffect(() => () => { onStopTranslateRef.current() }, [])

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
    // 回退态没有 contentVersion，也就没有可恢复的阅读进度（R4-B5）：别拿旧比例去对一段摘要。
    if (bodyState !== 'content') return
    const ratio = article.restoreRatio
    if (ratio === undefined || ratio <= 0) return
    const top = restoreTopFor(ratio, box.scrollHeight, box.clientHeight)
    box.scrollTop = top
    expectedTopRef.current = top
    // 图片还没进场时内容更矮：记住这个比例，长高时按它补正（用户一动就解除，见 handleScroll）
    restoreRatioRef.current = ratio
  }, [article?.itemId, article?.loading, article?.failure, article?.restoreRatio, bodyState])

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
    // 回退态不写阅读进度：摘要不是原站正文，没有 contentVersion，也不该被记成「读到哪儿」（R4-B5）。
    if (itemId === undefined || contentVersion === undefined || bodyState === 'fallback') return undefined
    return () => {
      const box = boxRef.current ?? lastBoxRef.current
      if (box === null) return
      onSaveProgress(itemId, contentVersion, readingRatioOf(box.scrollTop, box.scrollHeight, box.clientHeight))
    }
  }, [article?.itemId, article?.contentVersion, bodyState, onSaveProgress])

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
              * 一键翻译（R7 01 / 04 / 06）。**不可用时不渲染**（R7 02 / spec §4.1）：
              * 连按钮都不该出现，而不是点了再说「没有模型」。放在 Aa 左侧是固定位置。
              *
              * 状态机（D19）：译 → 停止（在译）→ 继续翻译（中止且还有剩余）→ 重译（完成 / 失败）。
              * 点击这一刻才量几何（R7 04）：滚动位置随时在变，渲染期缓存 rect 会在用户滚动后
              * 变成另一篇视角；`translateGeometryOf` 只读 DOM，选批仍是纯函数。
              * 可翻块为 0（全图片 / 无正文）时禁用并说明原因（spec §4.1）。
              */}
            {translateAvailable && (
              <button ref={translateButtonRef} type="button"
                className={'dsh-rss-btn' + (translateButtonState === 'retranslate' ? ' dsh-rss-btn--ghost' : '')}
                data-rss-translate="" data-rss-translate-state={translateButtonState}
                disabled={translateEmpty}
                aria-label={translateButtonText}
                title={translateButtonTitle}
                onClick={() => {
                  const box = boxRef.current
                  const geometry = box === null ? undefined : translateGeometryOf(box)
                  if (translateButtonState === 'stop') { onStopTranslate(); return }
                  if (translateButtonState === 'continue') { onContinueTranslate(geometry); return }
                  if (translateButtonState === 'retranslate') { onRetranslate(geometry); return }
                  onTranslate(geometry)
                }}>{translateButtonText}</button>
            )}
            {translation !== undefined && translation.total > 0 && (
              <span data-rss-translate-progress className="dsh-rss-meta" role="status">{TRANSLATE_LABEL_TEXT.progress(translation.done, translation.total)}</span>
            )}
            {/*
              * 三态切换器（R7 03 / spec §4.5）：「有译文之后，工具栏出现」。
              * 没有译文条目时整块不渲染 —— 切换器出现本身就在承诺「这里有译文可切」。
              * 放在「译」与进度右侧、Aa 左侧：任务区里所有翻译控件连成一片，不打断阅读偏好的入口。
              */}
            {translation !== undefined && (
              <TranslationModeSwitcher mode={effectiveMode} onChange={onTranslationMode} />
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
                {/*
                  * 「默认折叠图片」（R6 03）：与字号 / 栏宽 / 主题同处，值同样走 onReading 交回 store
                  * 并落盘 —— 面板不持有状态，否则重开插件就恢复不了（spec 决策 3）。
                  *
                  * 为什么是复选框而不是 <select>：它是布尔值，两个 <option> 的「是/否」下拉要多一次
                  * 点击才看得出当前状态；复选框的勾选态本身就是答案。
                  * ⚠️ 它与折叠提示是两种元素：这里是真正的表单控件（在 `Aa` 面板里，Tab 得到、空格有意义），
                  * 而正文里的提示不许进 Tab 序（spec 决策 11）—— 别把这条规矩套到面板上。
                  */}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={reading.expandImages === false}
                    aria-label="默认折叠图片"
                    onChange={(event) => onReading({ expandImages: !event.target.checked })} />
                  默认折叠图片
                </label>
                {/*
                  * 翻译目标语言（R7 02 / spec §5.3）：与设置页「显示」分区共用同一个
                  * viewPreferences.translateTarget。不可用时不渲染（spec §4.1）；
                  * 语言表从 translate-copy 读，不在这里另抄一份语言名。
                  */}
                {translateAvailable && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    目标语言
                    <select value={translateTarget} aria-label="翻译目标语言" data-rss-target-language=""
                      onChange={(event) => onTranslateTarget(event.target.value as TargetLanguage)}>
                      {TARGET_LANGUAGES.map((language) => (
                        <option key={language.id} value={language.id}>{language.label}</option>
                      ))}
                    </select>
                  </label>
                )}
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
              {/*
                * 标题翻译失败角标（spec §4.5）：只在译文态出现 —— 对照态永远原文标题，
                * 原文态本来就不该提「未翻译」。标题文本本身已经回落到原文，角标只是说明原因。
                */}
              {titleNotTranslated && (
                <span data-rss-title-failed className="dsh-rss-meta" style={{ display: 'inline-block', marginTop: 4 }}>
                  {TRANSLATE_LABEL_TEXT.titleNotTranslated}
                </span>
              )}
              {item !== undefined && (
                <div className="dsh-rss-meta" style={{ marginTop: 8 }}>
                  {item.feedTitle}
                  {author !== undefined && <> · {author}</>}
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
          {/*
            * 整篇停止提示（R7 05 / spec §4.7）：连续 3 批失败后不再发后续批，这句话放在正文
            * 顶部（标题之后、正文之前），读者先知道「后面没有译文不是漏翻」。
            * `stoppedReason` 是枚举，文案由 translate-copy 统一拼——不在组件里拼中文。
            */}
          {translation !== undefined && translation.status === 'failed' && translation.stoppedReason !== undefined && (
            <div data-rss-translation-stopped role="alert" style={{
              margin: '0 0 18px', padding: '8px 10px', borderRadius: 6,
              color: 'var(--rss-error)',
              border: '1px solid color-mix(in srgb, var(--rss-error) 32%, transparent)',
              background: 'color-mix(in srgb, var(--rss-error) 6%, transparent)',
            }}>
              {TRANSLATE_FAILURE_UI.stopped(translation.stoppedReason)}
            </div>
          )}
          {/*
            * 回退标签（R4-B3）：正文列标题 header 之后、正文块之前。
            * 用 role="note" 而不是 role="alert"：这不是错误态 —— 用户有内容可读，只是来源不是原站正文。
            * 原因行沿用 dsh-rss-meta 小字，文案按有无 failure 分两种；failure 原文照实显示（不吞、不改写）。
            */}
          {bodyState === 'fallback' && (
            <div role="note" style={{
              marginBottom: 18, padding: '10px 12px', borderRadius: 6,
              border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
              background: 'color-mix(in srgb, currentColor 4%, transparent)',
            }}>
              <div style={{ fontWeight: 600 }}>以下为订阅源提供的内容，可能不是全文</div>
              <div className="dsh-rss-meta" style={{ marginTop: 4 }}>
                {articleFailure === undefined
                  ? '原站没有可显示的正文'
                  : '原站正文没能取到：' + articleFailure}
              </div>
              <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                style={{ marginTop: 8 }} onClick={onRetry}>重试抓取</button>
            </div>
          )}
          {bodyState === 'loading' ? (
            <p className="dsh-rss-meta" role="status">正在抓取原站正文…</p>
          ) : bodyState === 'failed' ? (
            <div role="alert" style={{ color: 'var(--rss-error)' }}>
              没能取到正文：{articleFailure}
              <div className="dsh-rss-meta" style={{ marginTop: 6 }}>
                {link ? '可以返回列表，或打开原站阅读。' : '可以按 Esc 返回列表。'}
              </div>
            </div>
          ) : displayBlocks.map((block, index) => {
            /*
             * 折叠在**组层**判定（spec 决策 5 / 6 / 19），所以这一层先问判定体、再决定画什么。
             * 组内任一成员被折叠 ⇒ 整组换成一条提示，且提示落在**组首块**的位置上：
             * 这样段落与图片的相对顺序不变（spec 验收 20），提示也不会跑到组中间去。
             * 判定只走 `fold.shouldRender(group.index)` 这一处 —— 不在 JSX 里另写
             * `reading.expandImages === true`，否则「提示说折叠、DOM 里有 img」迟早发生。
             */
            const group = groupOfBlock.get(index)
            // 「不是图片块」与「这一组该渲染」画出**同一样东西**，所以合并成一个分支：
            // 分开写时两处 JSX 必须逐字同步，将来给 ArticleBlockView 加一个 prop 只改一处，
            // 症状是「有的块带 onOpenImage、有的不带」——灯箱入口时灵时不灵，极难看出来。
            // 语义没变：组覆盖 / 篇覆盖 / 偏好的裁决仍然只在 `fold.shouldRender` 那一处（决策 5）。
            if (group === undefined || fold.shouldRender(group.index)) {
              const kind = typeof block['kind'] === 'string' ? block['kind'] : 'p'
              /** 可翻块（D10）：只有它们的译文会替换 / 追加文本；pre / img / table 永远原样。 */
              const translatable = kind === 'p' || kind === 'h' || kind === 'quote' || kind === 'list'
              /**
               * 译文内容（R7 03）：`translation.blocks` 以块下标为键，不按数组顺序硬贴。
               * 空 / 纯空白、list 行数不等都在 `translatedBlockOf` 里判成 undefined ⇒ 该块退回原文；
               * 这是**唯一**的「译文能不能用」判据，译文态与对照态共用。
               */
              const translated = translation?.blocks.get(index)
              const translatedContent = translated === undefined ? undefined : translatedBlockOf(block, translated)
              /**
               * 超长块（R7 04 / spec §4.3 第三档）：> 6000 字符不进任何批，原位说明原因。
               * 只在有本篇译文条目时出现 —— 没点「译」之前不该先给读者一排「未翻译」。
               */
              const tooLong = translation !== undefined && translateCharsOf(block) > TRANSLATE_BLOCK_MAX_CHARS
              const tooLongNotice = tooLong && (
                <p data-rss-translation-too-long={index} className="dsh-rss-meta" style={{ margin: '0 0 1.1em' }}>
                  {TRANSLATE_LABEL_TEXT.blockTooLong}
                </p>
              )
              /**
               * 批级失败提示（R7 05 / spec §4.7）：失败批内**每个**可翻块位置都显示原因，
               * 重试按钮只放在批首块位置（一个批一个按钮）。按钮点下去由动作层按批首找回整批
               * indices，所以这里只交回 head，不在这里复制 indices —— 批次真相在 store。
               */
              const batchFailure = failedBatchOf.get(index)
              const batchFailureNotice = batchFailure !== undefined && (
                <p data-rss-translation-failure={index} className="dsh-rss-meta"
                  style={{ margin: '0 0 1.1em', color: 'var(--rss-error)' }}>
                  {TRANSLATE_FAILURE_UI.batch(batchFailure.reason)}
                  {batchFailure.head === index && (
                    <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                      data-rss-translation-retry={batchFailure.head}
                      style={{ marginLeft: 8 }}
                      // 整篇还在跑（后面批在飞）时禁用：批次必须串行，动作层也会再挡一次。
                      disabled={translation?.status === 'running'}
                      onClick={() => { onRetryBatch(batchFailure.head) }}>
                      {TRANSLATE_BUTTON_TEXT.retry}
                    </button>
                  )}
                </p>
              )
              /**
               * `data-rss-block` 是测量锚点（R7 04）：DOM 顺序与 displayBlocks 下标一一对应，
               * `translateGeometryOf` 按它把矩形喂给纯函数 pickBatch。译文段也住在这个包裹里，
               * 这样「块 + 自己的译文」始终是一个整体，不会与相邻块串段。
               */
              const blockBox = (content: ReactNode): ReactNode => (
                <div key={blockKeyOf(index)} data-rss-block={index}>
                  {content}
                  {tooLongNotice}
                  {batchFailureNotice}
                </div>
              )
              /**
               * 译文态（spec §4.5）：可翻块换成译文纯文本；不可翻块原样渲染。
               * 没有可用译文的可翻块（还没翻到 / 空白 / list 行数不等 / 超长）退回原文 ——
               * 读者看到的永远是「有内容」的块，而不是一段空白。
               */
              if (effectiveMode === 'translated') {
                return blockBox(
                  <>
                    {/* table 不翻，但必须让读者知道这不是漏翻（验收 D10）。 */}
                    {kind === 'table' && (
                      <p data-rss-table-not-translated className="dsh-rss-meta" style={{ margin: '0 0 6px' }}>
                        {TRANSLATE_LABEL_TEXT.tableNotTranslated}
                      </p>
                    )}
                    {translatable && translatedContent !== undefined ? (
                      // pre-wrap 必须落在译文内容这一层：模型回包里的换行是排版信息（spec §4.5），
                      // 普通段落默认折叠空白，整段译文会被压成一行。
                      <div data-rss-translation={index} style={{ whiteSpace: 'pre-wrap' }}>
                        <ArticleBlockView block={block} onOpenImage={onOpenImage}
                          textOverride={translatedContent.text} itemOverride={translatedContent.items} />
                      </div>
                    ) : (
                      <ArticleBlockView block={block} onOpenImage={onOpenImage} />
                    )}
                  </>,
                )
              }
              /**
               * 原文 / 对照态：原文块照旧渲染；对照态在它后面追加**自己的**译文段
               * （pre / img / table 不产生译文段，只渲染一次 —— 本票第 3 条）。
               */
              return blockBox(
                <>
                  <ArticleBlockView block={block} onOpenImage={onOpenImage} />
                  {effectiveMode === 'parallel' && translatable && translatedContent !== undefined && (
                    <TranslationSegment index={index} content={translatedContent} ordered={block['ordered'] === true} />
                  )}
                </>,
              )
            }
            // 折叠：只在组首块画提示，其余成员整块不渲染（组是原子的）
            if (group.blockIndexes[0] !== index) return null
            return (
              <div key={blockKeyOf(index)} data-rss-block={index}>
                <ImageFoldHint group={group} onExpand={onExpandImageGroup} />
              </div>
            )
          })}
          {/*
            * 「译自 {model}」（R7 05 / spec §4.4）：放在正文末尾、最后一段译文之后。
            * model 用回包里的值（store 侧的 TranslationEntry.model），不读客户端设置——
            * 显示设置里的模型会把「实际是谁译的」伪造成用户的选择。原文态没有译文内容，
            * 不显示这行；有译文但还没收到任何回包 model 时也不编造。
            */}
          {translation !== undefined && translation.model !== undefined
            && translation.blocks.size > 0 && effectiveMode !== 'original' && (
            <p data-rss-translated-from className="dsh-rss-meta" style={{ margin: '18px 0 0' }}>
              {TRANSLATE_LABEL_TEXT.translatedFrom(translation.model)}
            </p>
          )}
        </article>
      </div>

      {/*
        * 右下角的「回顶部 / 去底部」。**click 才去读容器**（见 scrollToEdge）——
        * 不把节点存进 state 让回调捕获，这与键盘那条路径是同一条约束。
        * 按钮放在滚动容器**之后**且同属相对定位层：不进滚动流，长文里也不会被滚走。
        *
        * 只在正文真的画出来时显示：加载中、抓取失败且无回退内容时既没有正文可跳，
        * 按钮也只会挤在「正在抓取…」那行旁边造成误解。回退态有摘要段落可滚，照常显示（R4-B6）。
        */}
      {(bodyState === 'content' || bodyState === 'fallback') && (
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
      {/*
        * 灯箱放在**这一层**（`position: relative` 的正文外层）的最后：`inset: 0` 因此只铺正文面，
        * 不盖顶栏与左栏（spec 决策 24）。放在滚动容器**之后**是关键 —— 放进去就会跟着内容滚走。
        * 只在正文真的画出来时可能打开（入口是正文里的图），但这里不另加 `bodyState` 判断：
        * 折叠 / 换篇 / 按 `i` 三条路径都会把它清掉，多一个守卫就多一处可能与那三条分家的判定。
        */}
      {/*
        * 首次外发确认（R7 06 / spec §4.2）。共享 ConfirmDialog 的三条出口：
        *   取消 / Esc ⇒ 只清 store 里的待确认态，不写 settings、不发 rpc；
        *   确认 ⇒ 动作层先写 `translateNoticeAck = true`（走 saveSettings patch）再开始翻译。
        * 文案里的 provider/model/字符数在**点「译」那一刻**算好（store 的 translateConfirm），
        * 不在这里按渲染时设置重算 —— 用户在框开着时切了模型，不能出现「说的是 A、发的是 B」。
        */}
      {translateConfirm !== undefined && (
        <ConfirmDialog
          titleId="rss-translate-confirm-title"
          title="翻译外发确认"
          rootAttrs={{ 'data-rss-translate-confirm': '' }}
          cardAttrs={{ 'data-rss-translate-confirm-card': '' }}
          confirmAttrs={{ 'data-rss-translate-confirm-ok': '', 'aria-label': '确认外发并开始翻译' }}
          cancelAttrs={{ 'data-rss-translate-confirm-cancel': '', 'aria-label': '取消翻译外发' }}
          confirmLabel="开始翻译"
          returnFocus={() => { translateButtonRef.current?.focus() }}
          onCancel={onCancelTranslate}
          onConfirm={() => {
            const box = boxRef.current
            onConfirmTranslate(box === null ? undefined : translateGeometryOf(box))
          }}
        >
          <p data-rss-translate-notice className="dsh-rss-confirm-note">
            {translateNoticeText(translateConfirm.provider, translateConfirm.model, translateConfirm.chars)}
          </p>
        </ConfirmDialog>
      )}
      {lightboxSrc !== undefined && <Lightbox src={lightboxSrc} onClose={onCloseLightbox} />}
    </div>
  )
}

/** 侧栏折叠按钮里的未读数（非交互）。 */
