/**
 * 翻译域的客户端动作（R7 01）。
 *
 * 01 只有一条编排：把当前正文的前 12 个可翻块（合计 ≤2000 字符）发给 translateBatch，
 * 成功写进 store 的 translations。批次串行 / 停止 / 继续 / 重试是 04/05 的票 —— 这里不提前
 * 造状态机，只保留 `status` 字段让后续票有地方扩展。
 *
 * 为什么动作住在独立文件而不是 store.ts：store 已经是 800 行的汇合点；翻译的写边界只有
 * `translations` 一个字段，独立成工厂后 02/03/05 扩展编排时不必在 store 里穿针。
 */
import type { TranslateBatchResult } from '../shared.js'
import { DEFAULT_TARGET_LANGUAGE, type TargetLanguage } from '../translate-copy.js'
import { translatableBlocksOf, translatableTextOf } from '../translate-blocks.js'
import type { ReaderState, ReaderStoreDeps, TranslationEntry } from './store.js'

/** 一批的硬上限（spec §4.3 / D15）：01 的首批与 04 的后续批共用这两个数。 */
export const TRANSLATE_BATCH_MAX_BLOCKS = 12
export const TRANSLATE_BATCH_MAX_CHARS = 2000

/** 内存键：条目 + 正文版本 + 目标语言（spec §4.6 / D11）。 */
export function translationKeyOf(itemId: string, contentVersion: string, target: TargetLanguage): string {
  return itemId + ':' + contentVersion + ':' + target
}

/** 从 store 快照里取某篇正文的译文；正文版本或语言不同都取不到（旧译文不冒充）。 */
export function translationEntryOf(
  state: ReaderState,
  itemId: string,
  contentVersion: string | undefined,
  target: TargetLanguage = DEFAULT_TARGET_LANGUAGE,
): TranslationEntry | undefined {
  if (contentVersion === undefined) return undefined
  return state.translations.get(translationKeyOf(itemId, contentVersion, target))
}

/** 一次待译块：正文下标 → 请求 id（`b` + 下标）。 */
interface BatchBlock {
  readonly index: number
  readonly id: string
  readonly text: string
}

/**
 * 首批选择：按正文顺序取可翻块，先到先切（12 块 / 2000 字符，spec §4.3）。
 *
 * 空 / 纯空白块跳过：端点声明要求 text 非空，把空段落塞进去会让整批 bad-request。
 * 遇到第一个会超字符上限的块就停 —— 跳过它继续装后面的短块会打乱正文顺序。
 */
export function firstBatchOf(blocks: readonly Record<string, unknown>[]): BatchBlock[] {
  const batch: BatchBlock[] = []
  let chars = 0
  for (const index of translatableBlocksOf(blocks)) {
    if (batch.length >= TRANSLATE_BATCH_MAX_BLOCKS) break
    const block = blocks[index]
    if (block === undefined) continue
    const text = translatableTextOf(block)
    if (text.trim() === '') continue
    if (chars + text.length > TRANSLATE_BATCH_MAX_CHARS) break
    batch.push({ index, id: 'b' + index, text })
    chars += text.length
  }
  return batch
}

export interface TranslateActionHost {
  get: () => ReaderState
  set: (patch: Partial<ReaderState>) => void
  rpc: ReaderStoreDeps['rpc']
  log: ReaderStoreDeps['log']
}

export function createTranslateActions(host: TranslateActionHost) {
  const { get, set, rpc, log } = host

  /** 整份替换 Map（不改原对象，React 才会看到变化）。 */
  const storeEntry = (entry: TranslationEntry): void => {
    const next = new Map(get().translations)
    next.set(entry.key, entry)
    set({ translations: next })
  }

  /**
   * 翻译当前正文的首批（01 的唯一入口）。
   *
   * 目标语言固定 `zh-CN`：语言偏好是 03/06 的票；01 先证明链路通。
   * 同一篇同一语言正在飞时直接忽略重复点击 —— 01 没有停止按钮，重复请求只会白花两份钱。
   */
  const startTranslate = async (): Promise<void> => {
    const state = get()
    const article = state.article
    if (article === undefined || article.loading === true) return
    if (article.itemId === undefined || article.contentVersion === undefined || article.blocks === undefined) return
    const target = DEFAULT_TARGET_LANGUAGE
    const key = translationKeyOf(article.itemId, article.contentVersion, target)
    if (state.translations.get(key)?.status === 'running') return

    const batch = firstBatchOf(article.blocks)
    if (batch.length === 0) return
    const title = typeof article.title === 'string' && article.title.trim() !== '' ? article.title : undefined
    storeEntry({ key, blocks: new Map(), done: 0, total: batch.length, status: 'running' })

    try {
      const result = await rpc<TranslateBatchResult>('translateBatch', {
        target,
        ...(title === undefined ? {} : { title }),
        items: batch.map((item) => ({ id: item.id, text: item.text })),
      })
      const blocks = new Map<number, string>()
      for (const item of Array.isArray(result.items) ? result.items : []) {
        if (typeof item.id !== 'string' || typeof item.text !== 'string') continue
        if (item.text.trim() === '') continue
        const match = /^b(\d+)$/.exec(item.id)
        if (match === null) continue
        blocks.set(Number(match[1]), item.text)
      }
      const translatedTitle = typeof result.title === 'string' && result.title.trim() !== '' ? result.title : undefined
      storeEntry({
        key,
        ...(translatedTitle === undefined ? {} : { title: translatedTitle }),
        // 标题跟着首批发出去；回包没给只说明标题失败，正文照常完成（spec §4.3）。
        ...(title !== undefined && translatedTitle === undefined ? { titleFailed: true } : {}),
        blocks,
        done: batch.length,
        total: batch.length,
        status: 'done',
      })
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      log('warn', '[rss-reader] 翻译请求失败', failure)
      storeEntry({
        key,
        blocks: new Map(),
        done: 0,
        total: batch.length,
        status: 'failed',
        error: message,
      })
    }
  }

  return { startTranslate }
}
