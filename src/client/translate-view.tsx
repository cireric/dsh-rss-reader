/**
 * 译文视图（R7 03，spec §4.5 / §5.5）。
 *
 * 这个文件只做两件事：
 *   ① 三态切换器（原文 / 译文 / 对照）—— 只在有译文条目时由正文面渲染；
 *   ② 「译文 → 可渲染内容」的投影 —— 空译文、list 行数不等都在这里被判成「没有可用译文」。
 *
 * 为什么投影必须与渲染分开：对照态与译文态都要回答「这一块的译文能不能用」，两处各写一份
 * 时，同一条回包在两种模式下会给出不同结论（例如对照态硬贴两行、译文态又退回原文）。
 * 判据收在这里一处，正文面只负责按模式摆位置。
 */
import type { ReactNode } from 'react'
import { TRANSLATE_MODE_TEXT } from '../translate-copy.js'
import { TRANSLATION_MODES, type TranslationMode } from './store.js'

/** 译文内容的稳定标记：值 = 正文块下标（测试与排查都按它定位，不认组件树形状）。 */
const TRANSLATION_ATTR = 'data-rss-translation'

/** 一条可渲染的译文：`text` 必非空；list 额外带拆好的行（行数已经校验）。 */
export interface TranslatedBlockContent {
  readonly text: string
  readonly items?: readonly string[]
}

/**
 * 把 store 里的原始译文投影成可渲染内容。
 *
 * - 空串 / 纯空白 ⇒ `undefined`：该块退回原文，不渲染空段落（spec §4.5）；
 * - list ⇒ 按行拆回条目，**行数必须等于原文 `items.length`**，否则整块退回原文（验收 7）。
 *   行数不等时若硬贴，读者会看到「两条原文配三条译文」的错位列表，且无从知道哪条对哪条；
 * - 其余可翻块 ⇒ 纯文本（D8：译文没有 runs，丢了内联语义是已接受的取舍）。
 */
export function translatedBlockOf(
  block: Record<string, unknown>,
  translated: string | undefined,
): TranslatedBlockContent | undefined {
  if (translated === undefined || translated.trim() === '') return undefined
  if (block['kind'] !== 'list') return { text: translated }
  const items = Array.isArray(block['items']) ? block['items'] : []
  const lines = translated.split(/\r?\n/)
  if (lines.length !== items.length) return undefined
  return { text: translated, items: lines }
}

/**
 * 三态切换器（spec §4.5 / §5.6）。
 *
 * 三枚都是真正的 `<button type="button">`：可 Tab 到达、空格 / 回车可激活；`aria-pressed`
 * 把当前态暴露给读屏器。没有译文时**不渲染本组件**（判据在正文面，避免两处各判一次）。
 */
export function TranslationModeSwitcher({ mode, onChange }: {
  mode: TranslationMode
  onChange: (mode: TranslationMode) => void
}): ReactNode {
  return (
    <div data-rss-translation-modes="" role="group" aria-label="译文显示方式"
      style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      {TRANSLATION_MODES.map((entry) => (
        <button key={entry} type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
          data-rss-translation-mode={entry}
          aria-pressed={mode === entry}
          onClick={() => { onChange(entry) }}>{TRANSLATE_MODE_TEXT[entry]}</button>
      ))}
    </div>
  )
}

/**
 * 对照态的译文段：原文块之后紧跟的一段（左 3px 竖线 + 次要色）。
 *
 * list 必须还原成 `<ul>` / `<ol>`（验收 7：list 译文是 ul 且行数相等），其余块保持
 * `white-space: pre-wrap` 的纯文本 —— 模型回包里的换行是排版信息，不能丢。
 * 只有**可翻块且译文有效**才会走到这里；pre / img / table 永远不产生这个段（spec §4.5）。
 */
export function TranslationSegment({ index, content, ordered }: {
  index: number
  content: TranslatedBlockContent
  ordered: boolean
}): ReactNode {
  const style = {
    margin: '0 0 1.1em', paddingLeft: 10,
    borderLeft: '3px solid color-mix(in srgb, currentColor 20%, transparent)',
    color: 'color-mix(in srgb, currentColor 72%, transparent)',
    whiteSpace: 'pre-wrap' as const,
  }
  if (content.items !== undefined) {
    const ListTag = ordered ? 'ol' : 'ul'
    return (
      <div {...{ [TRANSLATION_ATTR]: String(index) }} style={style}>
        <ListTag style={{ margin: 0, paddingLeft: '1.5em' }}>
          {content.items.map((item, at) => (
            <li key={at} style={{ marginBottom: '0.3em' }}>{item}</li>
          ))}
        </ListTag>
      </div>
    )
  }
  return <div {...{ [TRANSLATION_ATTR]: String(index) }} style={style}>{content.text}</div>
}
