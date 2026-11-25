/**
 * 翻译块的纯投影与回包对齐（R7 01，spec §4.3 / D10 / 验收 8）。
 *
 * 零 node 依赖：这份判据同时会被客户端（选首批）与宿主（解析回包）使用，而 client bundle
 * 不许出现任何 `node:` 说明符（见 docs/pitfalls.md §1.7b）。所以入参用
 * `Record<string, unknown>` 而不是 import `article.ts` 的 ArticleBlock —— 后者是 host-only 模块。
 *
 * 「回包怎么对号入座」必须在这里收口：错位的译文如果按数组顺序贴，会把 A 段的中文贴到 B 段
 * 下面；少给 / 多给 / 重复都只能是**整批失败**，不能挑能对上的先贴上。
 */

/** 可翻译的正文块种类（D10）：`pre` / `img` / `table` 不翻、也不占编号。 */
const TRANSLATABLE_KINDS: ReadonlySet<string> = new Set(['p', 'h', 'quote', 'list'])

/** 回包里一条译文的 wire 形状（请求与响应共用）。 */
export interface TranslateRequestItem {
  readonly id: string
  readonly text: string
}

/** 一次回包对齐的结果：成功给出标题与「块下标 → 译文」，失败只有一种原因（整批失败）。 */
export type ApplyBatchResult =
  | {
    readonly ok: true
    /** 标题译文（缺失 / 纯空白 = 没有标题译文，不影响正文批次）。 */
    readonly title?: string
    readonly blocks: ReadonlyMap<number, string>
  }
  | { readonly ok: false; readonly reason: 'misaligned' }

/** 这个块是否属于可翻种类（只看 kind，不看文本是否为空）。 */
export function isTranslatableBlock(block: Record<string, unknown>): boolean {
  const kind = block['kind']
  return typeof kind === 'string' && TRANSLATABLE_KINDS.has(kind)
}

/**
 * 一个块用于翻译与字符统计的文本。
 *
 * `list` 必须按 `items.join('\n')` 计（spec §4.3 的字符口径）：换成 `join(' ')` 会让
 * 「一段列表占多少字符」与请求里真正发出去的文本不是同一件事，分批阈值随之漂移。
 * 不可翻块返回空串 —— 调用方不需要再判一次 kind。
 */
export function translatableTextOf(block: Record<string, unknown>): string {
  if (!isTranslatableBlock(block)) return ''
  if (block['kind'] === 'list') {
    const items = block['items']
    if (!Array.isArray(items)) return ''
    return items.map((item) => typeof item === 'string' ? item : String(item ?? '')).join('\n')
  }
  const text = block['text']
  return typeof text === 'string' ? text : ''
}

/** 可翻块的下标数组（升序，与正文块下标一致）。 */
export function translatableBlocksOf(blocks: readonly Record<string, unknown>[]): number[] {
  const indices: number[] = []
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block !== undefined && isTranslatableBlock(block)) indices.push(index)
  }
  return indices
}

/** 回包 items 里的一条：字段类型不对就返回 undefined（不猜、不编造）。 */
function responseItemOf(value: unknown): TranslateRequestItem | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const id = record['id']
  const text = record['text']
  if (typeof id !== 'string' || typeof text !== 'string') return undefined
  return { id, text }
}

/**
 * 把模型回包与请求对齐。
 *
 * 对齐判据（少给 / 多给 / 重复 / 认不出的条目一律整批失败）：请求里的每个 id 必须恰好出现一次，
 * 不允许出现请求之外的 id。这样「模型把 b3 的译文写成 b2」不会把错位文字贴到别的段落。
 *
 * 空 / 纯空白译文**不算失败**：该块只是没有译文（调用方退回原文，不渲染空段落）。
 * 标题是独立字段：缺失 / 空白只丢标题，不拖垮正文批次（spec §4.3）。
 */
export function applyBatch(
  requested: readonly TranslateRequestItem[],
  response: { readonly title?: unknown; readonly items?: unknown },
): ApplyBatchResult {
  const rawItems = response.items
  if (!Array.isArray(rawItems)) return { ok: false, reason: 'misaligned' }
  const items: TranslateRequestItem[] = []
  for (const raw of rawItems) {
    const item = responseItemOf(raw)
    if (item === undefined) return { ok: false, reason: 'misaligned' }
    items.push(item)
  }
  const expected = new Set(requested.map((item) => item.id))
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) return { ok: false, reason: 'misaligned' }
    seen.add(item.id)
    if (!expected.has(item.id)) return { ok: false, reason: 'misaligned' }
  }
  if (items.length !== requested.length) return { ok: false, reason: 'misaligned' }

  const blocks = new Map<number, string>()
  for (const item of items) {
    if (item.text.trim() === '') continue
    const match = /^b(\d+)$/.exec(item.id)
    if (match === null) continue
    blocks.set(Number(match[1]), item.text)
  }
  const title = typeof response.title === 'string' && response.title.trim() !== '' ? response.title : undefined
  return { ok: true, ...(title === undefined ? {} : { title }), blocks }
}
