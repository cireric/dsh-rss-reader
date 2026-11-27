/**
 * 正文工具栏里的翻译控件（R7，2026-11-26 评审从 article-pane 抽出）。
 *
 * 抽出理由：article-pane 已经超过 1400 行，而「目标语言 / 译-停止-继续-重译按钮 / 进度 /
 * 原文-对照切换」是一块自洽的 UI，状态机只依赖 translation + blocks；留在正文文件里会让
 * 每次改状态机都要在巨大的 JSX 中穿针。
 *
 * 几何测量仍由父组件注入 `geometryOf`：它绑定的是滚动容器 ref，属于 ArticleView 的职责；
 * 本组件只在点击那一刻调用，不缓存 DOMRect（spec §4.3 视口优先）。
 */
import type { ReactNode, Ref } from 'react'
import { TARGET_LANGUAGES, TRANSLATE_BUTTON_TEXT, TRANSLATE_LABEL_TEXT, type TargetLanguage } from '../translate-copy.js'
import { articleTranslatePlanOf, type TranslateGeometry } from '../translate-blocks.js'
import { hasTranslations, type TranslationEntry, type TranslationMode } from './translate-state.js'
import { TranslationToggle } from './translate-view.js'

export interface TranslateToolbarProps {
  /** 当前正文块；undefined = 还没加载 / 加载失败。 */
  readonly blocks: readonly Record<string, unknown>[] | undefined
  readonly translation: TranslationEntry | undefined
  readonly translationMode: TranslationMode
  readonly translateAvailable: boolean
  readonly translateTarget: TargetLanguage
  /** 确认框关闭后把焦点还给「译」按钮（与设置页确认框同一条约定）。 */
  readonly buttonRef: Ref<HTMLButtonElement>
  readonly onTranslateTarget: (target: TargetLanguage) => void
  readonly onTranslationMode: (mode: TranslationMode) => void
  readonly onTranslate: (geometry: TranslateGeometry | undefined) => void
  readonly onContinueTranslate: (geometry: TranslateGeometry | undefined) => void
  readonly onRetranslate: (geometry: TranslateGeometry | undefined) => void
  readonly onStopTranslate: () => void
  readonly geometryOf: () => TranslateGeometry | undefined
}

type TranslateButtonState = 'translate' | 'stop' | 'continue' | 'retranslate'

/**
 * 按钮只表达**下一步该做什么**（2026-11-26 用户拍板）：
 *  - 没有任何译文（含一条都没成功）⇒「译」，从头开始；
 *  - 在跑 ⇒「停止」；
 *  - 有译文但还缺块（停止 / 批失败 / 空回包）⇒「继续翻译」，只补缺的块；
 *  - 全部译完 ⇒「重译」——唯一真实场景是换了模型想用新路由重翻同一篇（D20 不因换模型作废旧译文）。
 */
function stateOf(translation: TranslationEntry | undefined, remaining: number): TranslateButtonState {
  if (translation === undefined || (translation.blocks.size === 0 && translation.status !== 'running')) return 'translate'
  if (translation.status === 'running') return 'stop'
  return remaining > 0 ? 'continue' : 'retranslate'
}

function textOf(state: TranslateButtonState, remaining: number, total: number): string {
  switch (state) {
    case 'translate': return TRANSLATE_BUTTON_TEXT.translate
    case 'stop': return TRANSLATE_BUTTON_TEXT.stop
    case 'continue': return TRANSLATE_BUTTON_TEXT.continue(remaining, total)
    case 'retranslate': return TRANSLATE_BUTTON_TEXT.retranslate
  }
}

function titleOf(state: TranslateButtonState, empty: boolean): string {
  if (empty) return '这篇没有可翻译的正文'
  switch (state) {
    case 'translate': return '翻译当前文章（先译屏幕内的段落）'
    case 'stop': return '停止后续批次（在途一批会跑完）'
    case 'continue': return '继续翻译剩余段落（已译块不重发）'
    case 'retranslate': return '重新翻译整篇（会重新调用模型）'
  }
}

export function TranslateToolbar(props: TranslateToolbarProps): ReactNode {
  const {
    blocks, translation, translationMode, translateAvailable, translateTarget, buttonRef,
    onTranslateTarget, onTranslationMode, onTranslate, onContinueTranslate, onRetranslate,
    onStopTranslate, geometryOf,
  } = props
  const plan = articleTranslatePlanOf(blocks ?? [])
  const empty = plan.totalBlocks === 0 && plan.overlongBlocks.length === 0
  const remaining = translation === undefined ? 0 : Math.max(0, translation.total - translation.blocks.size)
  const state = stateOf(translation, remaining)
  const buttonText = textOf(state, remaining, translation?.total ?? 0)
  const buttonTitle = titleOf(state, empty)
  const effectiveMode: TranslationMode = hasTranslations(translation) ? translationMode : 'original'

  return (
    <>
      {/*
        * 目标语言（2026-11-26 用户拍板：按就近原则从设置页 / Aa 面板挪到「译」旁边）。
        * 不配文字 label —— 下拉里就是语言名，`aria-label` 留给读屏器；不可用时不渲染。
        */}
      {translateAvailable && (
        <select className="dsh-rss-translate-language" value={translateTarget}
          aria-label="翻译目标语言" data-rss-translate-language=""
          onChange={(event) => onTranslateTarget(event.target.value as TargetLanguage)}>
          {TARGET_LANGUAGES.map((language) => (
            <option key={language.id} value={language.id}>{language.label}</option>
          ))}
        </select>
      )}
      {/*
        * 一键翻译（R7 01 / 04 / 06）。**不可用时不渲染**（R7 02 / spec §4.1）：
        * 连按钮都不该出现，而不是点了再说「没有模型」。放在 Aa 左侧是固定位置。
        * 点击这一刻才量几何（R7 04）：滚动位置随时在变，渲染期缓存 rect 会在用户滚动后
        * 变成另一篇视角；`geometryOf` 只读 DOM，选批仍是纯函数。
        */}
      {translateAvailable && (
        <button ref={buttonRef} type="button"
          className={'dsh-rss-btn' + (state === 'retranslate' ? ' dsh-rss-btn--ghost' : '')}
          data-rss-translate="" data-rss-translate-state={state}
          disabled={empty}
          aria-label={buttonText}
          title={buttonTitle}
          onClick={() => {
            const geometry = geometryOf()
            if (state === 'stop') { onStopTranslate(); return }
            if (state === 'continue') { onContinueTranslate(geometry); return }
            if (state === 'retranslate') { onRetranslate(geometry); return }
            onTranslate(geometry)
          }}>{buttonText}</button>
      )}
      {translation !== undefined && translation.total > 0 && (
        <span data-rss-translate-progress className="dsh-rss-meta" role="status">
          {TRANSLATE_LABEL_TEXT.progress(Math.min(translation.blocks.size, translation.total), translation.total)}
        </span>
      )}
      {/*
        * 原文 / 对照 单枚切换（2026-11-26 用户拍板，替代原来的三枚）。
        * 判据是 `hasTranslations`（至少一块真的回填了译文），不是「有翻译条目」——
        * 全批失败时条目存在，但一个译文都没有，按钮出现就是在承诺一份不存在的内容。
        */}
      {hasTranslations(translation) && (
        <TranslationToggle mode={effectiveMode === 'original' ? 'original' : 'parallel'} onChange={onTranslationMode} />
      )}
    </>
  )
}
