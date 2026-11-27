/**
 * 翻译域的客户端共享状态与纯 helper（R7，2026-11-26 评审拆分）。
 *
 * 为什么从 store.ts 抽出来：`TranslationEntry` / `TranslationMode` / `hasTranslations` 同时被
 * store、translate-actions、article-pane、translate-view 使用。留在 store 里会让
 * `store → translate-actions → store` 形成运行时循环；抽成叶子模块后三边都只依赖这里。
 *
 * 这里不放任何 React / DOM / RPC 逻辑，只放「一条译文是什么、有没有可用译文、下一个显示态」。
 */
import type { TranslateFailureReason } from '../translate-copy.js'

/**
 * 一个失败批的可见信息（R7 05 / spec §4.7）。
 *
 * `indices` 必须原样保留**整批**：重试按钮点一次要重发这一批的全部块，而不是只发批首块。
 * 失败批的块不在 `blocks` 里，所以渲染层能据此同时做到「每块位置显示原因」与
 * 「批首块位置只放一个重试按钮」。
 */
export interface TranslationBatchFailure {
  readonly indices: readonly number[]
  readonly reason: TranslateFailureReason
}

/**
 * 一条正文的翻译内存态（R7，contract「客户端共享状态」）。
 *
 * 键 = `${itemId}:${contentVersion}:${target}`：正文版本变了旧译文自动不可见（spec §4.6），
 * 目标语言不同也不互相冒充。`blocks` 只收**非空译文**的块下标 → 渲染层不需要再判空。
 */
export interface TranslationEntry {
  readonly key: string
  readonly blocks: ReadonlyMap<number, string>
  /**
   * 每个块实际由哪个模型译出（2026-11-26 评审修复）。
   *
   * 之前的单一 `model` 只能代表最后一条非空回包：译一半 → 停止 → 改模型 → 继续时，前半篇
   * 会被标成新模型。按块记录后，文章末尾可以如实列出「译自 A、B」，而不是把旧译文冒名成
   * 新模型（spec §4.6 的「标签如实写旧 model」）。
   */
  readonly models: ReadonlyMap<number, string>
  /**
   * 失败批：键 = 批首块下标。批失败不影响已完成块，也不让整篇立刻失败；
   * 只有连续 3 批失败才写 `status: 'failed'`（spec §4.7）。
   */
  readonly failures: ReadonlyMap<number, TranslationBatchFailure>
  total: number
  /**
   * 最近一次非空回包的模型。保留它是为了兼容既有测试 / 遥测；界面展示请用 `models`
   * （多模型混排时 `model` 不足以说明每一块是谁译的）。
   */
  model?: string
  /** 'done' = 本轮编排已跑完（可能仍有失败批或空回包缺口；是否有缺块看 blocks / failures）。 */
  status: 'running' | 'done' | 'stopped' | 'failed'
  error?: string
  /** 连续 3 批失败而整篇停止时的最后一类原因；顶层「翻译已停止：…」的文案来源。 */
  stoppedReason?: TranslateFailureReason
}

/** 首次外发确认框的待确认内容（R7 06 / spec §4.2）。 */
export interface TranslateConfirmRequest {
  readonly chars: number
  readonly provider: string
  readonly model: string
}

/**
 * 这条译文是否「有译文可用」：至少一个块成功回填。
 *
 * 判据只留这一份：渲染层（切换器是否出现、两态是否回落原文）与动作层（`t` 该切换还是
 * 触发翻译）必须给同一个答案。全批失败 / 首批未回时条目仍然存在（有进度、有失败按钮），
 * 但 `blocks.size === 0` —— 只看「条目存在」会让切换器承诺一份并不存在的译文。
 */
export function hasTranslations(entry: TranslationEntry | undefined): boolean {
  return entry !== undefined && entry.blocks.size > 0
}

/** 正文的两态（2026-11-26 用户拍板）：原文 / 对照（原文 + 下层译文）。纯「译文」态已删除。 */
export type TranslationMode = 'original' | 'parallel'

/**
 * 两态的取值域：原文 → 对照 → 原文（`t` 键的语义，D14）。
 *
 * 只定义在这一处：切换按钮与 `t` 都按它走，别在组件里另抄一份。
 */
export const TRANSLATION_MODES: readonly TranslationMode[] = ['original', 'parallel']

/** `t` 的下一个态；认不出的值（理论上不可达）回落到原文，不抛错。 */
export function nextTranslationMode(mode: TranslationMode): TranslationMode {
  const at = TRANSLATION_MODES.indexOf(mode)
  if (at < 0) return 'original'
  return TRANSLATION_MODES[(at + 1) % TRANSLATION_MODES.length]
}

/**
 * 一条译文实际涉及哪些模型（按块首次出现的顺序，去重）。
 *
 * 没有 `models`（理论上的旧条目）时退回单一 `model`，不编造、不显示空标签。
 */
export function translationModelsOf(entry: TranslationEntry | undefined): string[] {
  if (entry === undefined) return []
  const models = new Set<string>()
  for (const model of entry.models.values()) {
    if (model.trim() !== '') models.add(model)
  }
  if (models.size === 0 && entry.model !== undefined && entry.model.trim() !== '') models.add(entry.model)
  return [...models]
}
