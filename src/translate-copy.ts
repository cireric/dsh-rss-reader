/**
 * 翻译文案的**唯一来源**（R7，contract「文案单源」）。
 *
 * 语言名、四类失败文案、按钮 / 标签、隐私句都从这里读：02 的语言下拉、03 的三态切换器、
 * 04 的「段落过长」、05 的重试与 06 的确认框会同时消费这张表。各票手抄一份的下场是
 * 「设置页写简体中文、正文 prompt 写 Chinese」这类静默分家，而没有任何断言会翻红。
 *
 * 零 node 依赖：客户端与宿主都要 import（client bundle 不许出现 node: 说明符）。
 */

/** 支持的目标语言（spec §5.4 / D4）。`instruction` 是 prompt 里用的英文语言名。 */
export const TARGET_LANGUAGES = [
  { id: 'zh-CN', label: '简体中文', instruction: 'Simplified Chinese' },
  { id: 'zh-TW', label: '繁體中文', instruction: 'Traditional Chinese' },
  { id: 'en', label: 'English', instruction: 'English' },
  { id: 'ja', label: '日本語', instruction: 'Japanese' },
  { id: 'ko', label: '한국어', instruction: 'Korean' },
] as const

export type TargetLanguage = (typeof TARGET_LANGUAGES)[number]['id']

export const DEFAULT_TARGET_LANGUAGE: TargetLanguage = 'zh-CN'

/** 认不出的值一律 false —— 调用方据此回落默认或拒绝入参，不猜语言。 */
export function isTargetLanguage(value: unknown): value is TargetLanguage {
  return typeof value === 'string' && TARGET_LANGUAGES.some((entry) => entry.id === value)
}

/** 目标语言 → prompt 里的英文语言名（唯一查表处）。 */
export function targetLanguageInstructionOf(target: TargetLanguage): string {
  const entry = TARGET_LANGUAGES.find((candidate) => candidate.id === target)
  if (entry === undefined) throw new Error('未登记的目标语言：' + target)
  return entry.instruction
}

/** 模型侧失败的四类原因（spec §4.7 / D17）。 */
export type TranslateFailureReason = 'timeout' | 'truncated' | 'empty' | 'unavailable'

/**
 * 四类失败文案**分开、不合并**：超时和截断对用户是两条不同的行动线索
 *（等一会儿重试 vs 调小范围），合并成「翻译失败」等于把可诊断信息丢掉。
 */
export const TRANSLATE_FAILURE_TEXT: Record<TranslateFailureReason, string> = {
  timeout: '超时（60s）',
  truncated: '输出被截断（达到输出上限）',
  empty: '模型没有返回可用译文',
  unavailable: '模型未挂载或无可用路由',
}

/** 按钮文案（01 只用「译」，其余留给 02/05；表一次建全避免各票各抄）。 */
export const TRANSLATE_BUTTON_TEXT = {
  translate: '译',
  stop: '停止',
  retranslate: '重译',
  continue: (remaining: number, total: number): string => '继续翻译（还剩 ' + remaining + '/' + total + '）',
} as const

/** 标签文案（03/05 直接复用）。 */
export const TRANSLATE_LABEL_TEXT = {
  tableNotTranslated: '表格未翻译',
  blockTooLong: '段落过长未翻译',
  titleNotTranslated: '标题未翻译',
  translatedFrom: (model: string): string => '译自 ' + model,
  /** 进度（spec §4.8）：X = 已完成批里的块数，Y = 全篇可翻块数（不含超长块）。 */
  progress: (done: number, total: number): string => '已译 ' + done + '/' + total + ' 块',
} as const

/** 三态切换器的按钮文案（R7 03 / spec §4.5）：顺序即 `t` 的循环顺序，别在组件里另抄一份。 */
export const TRANSLATE_MODE_TEXT = {
  original: '原文',
  translated: '译文',
  parallel: '对照',
} as const

/**
 * 整篇上限提示（spec §4.3 / D3）。
 *
 * 把字符数与上限都写进文案：只说「文章太长」用户没法判断差多少，也无从决定要不要手动删减。
 */
export const TRANSLATE_LIMIT_TEXT = {
  articleTooLong: (chars: number, limit: number): string =>
    '正文共 ' + chars + ' 字符，超过单篇 ' + limit + ' 字符上限，本次不翻译',
} as const

/**
 * 首次外发的隐私句（spec §4.2）：provider/model 与字符数都由调用方按**当前**路由与正文现算。
 * 不把「约 N 字符」写死在这里 —— 那句话必须能随文章变化。
 */
export function translateNoticeText(provider: string, model: string, chars: number): string {
  return '翻译会把当前文章正文发送给 ' + provider + '/' + model + '，本次约 ' + chars + ' 字符，可能产生调用费用。'
}
