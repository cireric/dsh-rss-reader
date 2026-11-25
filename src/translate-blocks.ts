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

/**
 * 一批的硬上限（spec §4.3 / D15）：12 块且 2000 字符，先到先切。
 *
 * 放在这个零依赖模块里，是因为视口选批（`pickBatch`）与串行编排（`translate-actions`）必须
 * 用同一组数；两处各写一份时，「纯函数认为一批能装 12 块、动作层只发 10 块」这种漂移不会有
 * 任何测试翻红。
 */
export const TRANSLATE_BATCH_MAX_BLOCKS = 12
export const TRANSLATE_BATCH_MAX_CHARS = 2000
/** 单块 2000–6000 独占一批；> 6000 不进任何批（spec §4.3 三档）。 */
export const TRANSLATE_BLOCK_MAX_CHARS = 6000
/** 单篇可翻字符上限（spec §4.3 / D3）：> 30000 直接拒绝，不静默截断。 */
export const TRANSLATE_ARTICLE_MAX_CHARS = 30000

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

/**
 * 一个块参与批次计量的字符数：空白块记 0。
 *
 * 端点明确拒绝 `text` 全空白的条目（spec §5.1），把空白块的 `length` 当成可翻字符会让
 * 「计划里 3 块、实际发出去 2 块」——进度永远差一块。01 的 firstBatchOf 也是同一条判据。
 */
export function translateCharsOf(block: Record<string, unknown>): number {
  const text = translatableTextOf(block)
  return text.trim() === '' ? 0 : text.length
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

/** 视口矩形（`getBoundingClientRect` 的最小投影；DOM 只负责量，纯函数不认 DOMRect）。 */
export interface TranslateRect {
  readonly top: number
  readonly bottom: number
  readonly left: number
  readonly right: number
}

/**
 * 一个可翻块的测量结果。
 *
 * `index` 是**正文块下标**（不是可翻块序号）：请求 id 是 `b + 块下标`，选批结果也回这个下标，
 * 中间再转一次序号必然出错。`rect` 缺席 = 这个块量不到（尚未渲染 / 浏览器没布局），按不可见处。
 */
export interface TranslateBlockRect {
  readonly index: number
  readonly rect: TranslateRect | undefined
}

/** DOM 层量到的整份视口几何；`pickBatch` 的入参由它和一个已翻集合拼成。 */
export interface TranslateGeometry {
  readonly container: TranslateRect
  readonly blocks: ReadonlyArray<TranslateBlockRect>
}

/** `pickBatch` 的全部输入：DOM 层只填矩形与字符数，判定本身不碰 DOM。 */
export interface PickBatchInput {
  /** 可翻块的矩形，按文档顺序；不可翻块不必出现。 */
  readonly rects: ReadonlyArray<TranslateBlockRect>
  /** 滚动容器矩形；undefined = 没量到容器（按「可见集为空」退化）。 */
  readonly container: TranslateRect | undefined
  /** 已翻块下标：跨批续选时跳过它们。 */
  readonly translated: ReadonlySet<number>
  /** 每块字符数，按**正文块下标**取值（与请求里的 text.length 同口径）。 */
  readonly chars: ReadonlyArray<number>
}

/** 两个矩形是否有非空交集。贴边（bottom === top）不算可见，避免零高度块污染可见集。 */
function intersects(a: TranslateRect, b: TranslateRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
}

/** 从候选下标里按「先到先切」取一批；2000–6000 的块独占一批。 */
function batchFrom(indices: readonly number[], chars: ReadonlyArray<number>): number[] {
  const first = indices[0]
  if (first === undefined) return []
  // 2000 < 单块 ≤ 6000：独占一批，本批放宽到 6000。> 6000 已在候选过滤里被排除。
  if ((chars[first] ?? 0) > TRANSLATE_BATCH_MAX_CHARS) return [first]
  const batch: number[] = []
  let totalChars = 0
  for (const index of indices) {
    const blockChars = chars[index] ?? 0
    // 遇到长块就截断当前批，但**不跳过它**去装后面的短块 —— 那会打乱正文顺序。
    if (blockChars > TRANSLATE_BATCH_MAX_CHARS) break
    if (batch.length >= TRANSLATE_BATCH_MAX_BLOCKS) break
    if (totalChars + blockChars > TRANSLATE_BATCH_MAX_CHARS) break
    batch.push(index)
    totalChars += blockChars
  }
  return batch
}

/**
 * 视口选批（spec §4.3 / §5.5）：点「译」时先翻当前屏幕里看得见的块。
 *
 * 判据顺序：
 *   1. 过滤掉已翻块、空块与 > 6000 的超长块；
 *   2. 与滚动容器矩形求交，交到的块按文档顺序优先成批；
 *   3. 可见集为空（停在顶部 / 尚未渲染完）⇒ 从第一个剩余块开始取一批。
 *
 * 这是纯函数：入参只有矩形与数字，jsdom 之外也能单测。DOM 层（article-pane）只负责量矩形，
 * 不许在这里读 `window` / `document`。
 */
export function pickBatch(input: PickBatchInput): number[] {
  const candidates = [...input.rects]
    .filter((entry) => Number.isInteger(entry.index) && entry.index >= 0)
    .sort((a, b) => a.index - b.index)
    .filter((entry) => {
      if (input.translated.has(entry.index)) return false
      const blockChars = input.chars[entry.index] ?? 0
      return blockChars > 0 && blockChars <= TRANSLATE_BLOCK_MAX_CHARS
    })
  const container = input.container
  const visible = container === undefined
    ? []
    : candidates.filter((entry) => entry.rect !== undefined && intersects(entry.rect, container))
  const pool = visible.length > 0 ? visible : candidates
  return batchFrom(pool.map((entry) => entry.index), input.chars)
}

/** 整篇翻译的静态计划（spec §4.3 / D3）：字符总数、可翻块数、超长块与上限判定。 */
export interface TranslateArticlePlan {
  /** 可翻块文本长度之和（含超长块；上限判断用这个口径）。 */
  readonly chars: number
  /** 可翻且不超长、非空白的块数 —— 进度分母 Y（不含超长块）。 */
  readonly totalBlocks: number
  /** > 6000 的块下标：不参与任何批次，原位标「段落过长未翻译」。 */
  readonly overlongBlocks: readonly number[]
  /** 会真正进入批次的块下标（升序）。 */
  readonly eligibleBlocks: readonly number[]
  /** 是否超过单篇 30000 字符上限；用 `>`，恰好 30000 必须放行。 */
  readonly tooLong: boolean
}

/**
 * 从正文块算出整篇计划。
 *
 * 空白块不计入 `totalBlocks`：端点明确拒绝 `text` 全空白的条目（spec §5.1），把它算进分母
 * 会让进度永远差几块、完成态永远到不了。它也不进批次 —— 与 01 的 firstBatchOf 同一条判据。
 */
export function articleTranslatePlanOf(blocks: readonly Record<string, unknown>[]): TranslateArticlePlan {
  let chars = 0
  const overlongBlocks: number[] = []
  const eligibleBlocks: number[] = []
  for (const index of translatableBlocksOf(blocks)) {
    const block = blocks[index]
    if (block === undefined) continue
    const length = translateCharsOf(block)
    chars += length
    if (length > TRANSLATE_BLOCK_MAX_CHARS) overlongBlocks.push(index)
    else if (length > 0) eligibleBlocks.push(index)
  }
  return {
    chars,
    totalBlocks: eligibleBlocks.length,
    overlongBlocks,
    eligibleBlocks,
    tooLong: chars > TRANSLATE_ARTICLE_MAX_CHARS,
  }
}
