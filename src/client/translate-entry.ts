/**
 * 翻译回包 → 客户端条目的纯投影（R7，2026-11-26 评审拆分）。
 *
 * 从 translate-actions.ts 抽出来的原因：这些函数只做「回包校验 / 批失败原因 / 条目合并」，
 * 不碰 session、队列或 React；混在 800 行的编排文件里既难读，也让「自动编排」与「手动重试」
 * 容易各写一份。现在两条路径都只调用这里的一处实现。
 */
import type { TranslateBatchResult } from '../shared.js'
import { blockIndexOfTranslateId, translateBlockIdOf, translatableTextOf, type TranslateRequestItem } from '../translate-blocks.js'
import { isTranslateFailureReason, type TranslateFailureReason } from '../translate-copy.js'
import { RpcError } from './rpc-error.js'
import type { TranslationEntry } from './translate-state.js'

/**
 * 宿主回包的 items → 块下标译文。
 *
 * 这里**不用** host 的 `applyBatch`：那是宿主校验模型输出的判据（少给 / 多给 / 重复一律整批
 * 失败）。宿主已经把空白译文从回包里丢掉，客户端若要求「请求 id 一个不少」会把「某块模型
 * 返回空白」误判成整批失败 —— 而 spec 明确空白块只退回原文、不计批失败。
 * 客户端只守住自己收到的形状：id 必须属于本批、不许重复；缺的那条按「无译文」处理。
 */
export function translatedBlocksOf(
  result: TranslateBatchResult,
  requestedIds: ReadonlySet<string>,
): Map<number, string> | undefined {
  if (!Array.isArray(result.items)) return undefined
  const blocks = new Map<number, string>()
  const seen = new Set<string>()
  for (const item of result.items) {
    if (item === null || typeof item !== 'object') return undefined
    if (typeof item.id !== 'string' || typeof item.text !== 'string') return undefined
    if (!requestedIds.has(item.id) || seen.has(item.id)) return undefined
    seen.add(item.id)
    if (item.text.trim() === '') continue
    const index = blockIndexOfTranslateId(item.id)
    if (index === undefined) continue
    blocks.set(index, item.text)
  }
  return blocks
}

/**
 * 从 rpc 失败里取四类原因之一（R7 05）。
 *
 * 只认 `RpcError` + `code === 'translate-failed'` + details.reason 属于四类枚举：
 * 别用 message 文本反推 —— 文案是界面资产，改一个标点就会让重试分类静默失效。
 * 其它 code（bad-request / 通道错误）不是「这一批模型失败」，返回 undefined 交给调用方
 * 按整篇失败处理：那些错误继续跑下一批只会重复撞同一面墙。
 */
export function batchFailureReasonOf(failure: unknown): TranslateFailureReason | undefined {
  if (!(failure instanceof RpcError) || failure.code !== 'translate-failed') return undefined
  if (typeof failure.details !== 'object' || failure.details === null) return undefined
  const details = failure.details as { readonly reason?: unknown }
  return isTranslateFailureReason(details.reason) ? details.reason : undefined
}

/** 回包 model 只在非空字符串时采信；空 / 缺字段等于「这次不知道是谁译的」，保留上一个值。 */
export function modelOfResult(result: TranslateBatchResult): string | undefined {
  return typeof result.model === 'string' && result.model.trim() !== '' ? result.model : undefined
}

/** 正文块下标 → 请求项；空白块不发送（端点会整批 bad-request）。 */
export function requestItemsOf(blocks: readonly Record<string, unknown>[], indices: readonly number[]): TranslateRequestItem[] {
  const items: TranslateRequestItem[] = []
  for (const index of indices) {
    const block = blocks[index]
    if (block === undefined) continue
    const text = translatableTextOf(block)
    if (text.trim() === '') continue
    items.push({ id: translateBlockIdOf(index), text })
  }
  return items
}

/**
 * 一批成功回包 → 新条目。
 *
 * 自动编排与手动重试共用它：只做落库投影，不决定 status 的终态；调用方成功后该继续
 * （running）还是完成（done）由它自己定。
 *
 * `models` 按块记录本次回包的模型，`model` 仍记最后一条非空回包；界面用前者展示多模型。
 *
 * @param head 失败批的批首下标：成功即清掉这条失败记录。
 */
export function appliedEntryOf(
  entry: TranslationEntry,
  result: TranslateBatchResult,
  requestedIds: ReadonlySet<string>,
  options: { readonly head: number },
): TranslationEntry | undefined {
  const translatedBlocks = translatedBlocksOf(result, requestedIds)
  if (translatedBlocks === undefined) return undefined
  const nextBlocks = new Map(entry.blocks)
  for (const [index, text] of translatedBlocks) nextBlocks.set(index, text)
  const nextFailures = new Map(entry.failures)
  nextFailures.delete(options.head)
  const resultModel = modelOfResult(result)
  const nextModels = new Map(entry.models)
  if (resultModel !== undefined) {
    for (const index of translatedBlocks.keys()) nextModels.set(index, resultModel)
  }
  return {
    ...entry,
    blocks: nextBlocks,
    models: nextModels,
    failures: nextFailures,
    status: 'running',
    ...(resultModel === undefined ? {} : { model: resultModel }),
  }
}
