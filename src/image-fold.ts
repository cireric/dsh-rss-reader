/**
 * 图片折叠的**决策层**：把正文块切成「图片组」，并回答「这一组现在该不该渲染 `<img>`」。
 *
 * 为什么是纯函数、且刻意不碰 DOM（与 `list-scroll.ts` 同一族）：
 *  - 「相邻的图算一组」是**渲染概念**，不是抽取概念。抽取层（`article.ts`）的职责是
 *    「把 HTML 变成结构化块」，它不知道版面怎么排；把它塞进抽取层会让缓存内容依赖排版决定，
 *    改一次就得抬 `EXTRACTOR_REVISION`（spec 决策 18 / 31）。放这里就能随便改。
 *  - 「该不该渲染」必须只有**一个**裁决点（spec 决策 5 / 6）。此前最容易出的事故是渲染层
 *    各自写 `expandImages === true`：提示说折叠、DOM 里却有 `<img>`，两者读了不同的表达式。
 *  - 无 node 依赖 ⇒ host 与 client 都能编译（`article.ts` 引了 `node:crypto`，客户端不可用，
 *    见 `docs/pitfalls.md` §1.7b）。`tests/image-fold.test.mjs` 因此能直接测它。
 */

/** 一个图片组：连续相邻的 `img` 块。 */
export interface ImageGroup {
  /**
   * 组序号（0..N-1），**组覆盖的 `Set` 装的就是这个数**（spec 决策 16）。
   *
   * 为什么不用「首图 src」当标识：`dedupeImages` 明确允许同一 `src` 在正文出现 2 次
   * （`MAX_SAME_IMAGE = 2`），两个组会共用一个键 —— 点开第一组，第二组跟着亮。
   */
  readonly index: number
  /** 组内每个块在**输入数组**里的下标（消费方回查原文用；与 `blocks` 一一对应）。 */
  readonly blockIndexes: ReadonlyArray<number>
  /** 组内的块本身（wire 形状），顺序与 `blockIndexes` 一致。 */
  readonly blocks: ReadonlyArray<Record<string, unknown>>
}

/**
 * 块是不是图片块。
 *
 * `kind` 的取法沿用 `src/client/article-pane.tsx` 的 `ArticleBlockView`：
 * `typeof block['kind'] === 'string' ? block['kind'] : 'p'`。**两处必须是同一条规则** ——
 * 否则一个缺 `kind` 的旧缓存块会被渲染层当段落画、被分组层当「透明分隔物」跳过，
 * 组的边界与画出来的东西对不上。
 */
function isImageBlock(block: Record<string, unknown>): boolean {
  return typeof block['kind'] === 'string' && block['kind'] === 'img'
}

/**
 * 按块顺序把正文切成图片组（spec 决策 16 / 17）。
 *
 * 规则：相邻连续的 `img` 块归为一组；中间夹**任何**非 `img` 块就断开；单张图自成一组。
 * 特别地，**空的 `<p>` 同样断开** —— 它视觉上没有内容，但它是一个块，块顺序就是读者的阅读顺序。
 * 跳过空块等于把两段本来分开的图并成一组，读者点一次提示会放出两张毫不相干的图。
 *
 * 组序号是输出列表里的下标，所以它天然是 0..N-1 连续的。
 *
 * @param blocks - 正文块（wire 形状，`Record<string, unknown>`）。**只读，不改动、不排序**。
 * @returns 按输入顺序排列的组列表；正文无图时是空数组（不是错误）。
 */
export function groupImageBlocks(blocks: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<ImageGroup> {
  const groups: ImageGroup[] = []
  let indexes: number[] = []
  let members: Array<Record<string, unknown>> = []

  /** 收束当前组；空组（没有正在累积的块）时不产出任何东西。 */
  const flush = (): void => {
    if (indexes.length === 0) return
    groups.push({ index: groups.length, blockIndexes: indexes, blocks: members })
    indexes = []
    members = []
  }

  for (let at = 0; at < blocks.length; at += 1) {
    const block = blocks[at]
    if (isImageBlock(block)) {
      indexes.push(at)
      members.push(block)
      continue
    }
    // 任何非 img 块都是边界 —— 包括空 p。
    flush()
  }
  flush()
  return groups
}

/**
 * 折叠判定体（spec 决策 6）：`ArticleView` 与图片块组件都只消费它，不各自重算。
 *
 * 与 `shouldRenderImage` 是**同一处裁决者的两种表述**：那个是单点查询，这个是给需要
 * 「每组各问一次」的渲染层用的。实现上后者委托前者，所以两层派生只有一处算 ——
 * 两份独立的判定逻辑迟早分叉，症状是「`i` 按了没反应」或「提示说折叠、DOM 里有 img」。
 */
export interface ImageFold {
  /** 第 `groupIndex` 组现在该不该渲染 `<img>`。纯查询，可重复调用。 */
  shouldRender(groupIndex: number): boolean
}

/**
 * 由三层输入造一个判定体：`组覆盖 ?? 篇覆盖 ?? 偏好`（spec 决策 5）。
 *
 * **组级优先于篇级**：读者明确点过的那一组，不该被一个全局开关的默认值盖掉。
 *
 * @param preference - 偏好层的值（`ReadingPreferences.expandImages`），决定初始形态。
 * @param articleOverride - 篇级覆盖（`boolean | undefined`），本次阅读里 `i` 键写的瞬时值。
 * @param groupOverrides - 被点开的组序号集合。
 *
 * ⚠️ **组覆盖在构造时取快照**：那个 `Set` 住在 `index.tsx` 的 state 里，换篇时会被整个替换。
 * 判定体若直接闭包它，「渲染」与「读者上次点过什么」就会脱钩 —— 拿一份快照，
 * 判定体就是这次渲染的纯函数。
 */
export function foldOf(
  preference: boolean,
  articleOverride: boolean | undefined,
  groupOverrides: ReadonlySet<number>,
): ImageFold {
  const opened = new Set(groupOverrides)
  return {
    shouldRender: (groupIndex: number): boolean => shouldRenderImage(preference, articleOverride, opened, groupIndex),
  }
}

/**
 * 单点判定：第 `groupIndex` 组现在该不该渲染 `<img>`（spec 决策 5 的签名）。
 *
 * 判定顺序就是 `组覆盖 ?? 篇覆盖 ?? 偏好`：
 *  1. 组覆盖命中 ⇒ 渲染（读者明确点过这一组）；
 *  2. 否则 `篇覆盖 ?? 偏好` —— `篇覆盖` 是 `boolean | undefined`，`undefined` 才落到偏好。
 *
 * 折叠时**不渲染 `<img>` 元素**（不是 `display:none`、不是空 `src`）：DOM 里没有元素，
 * 浏览器就不会发请求，也不会带 `Referer`（spec 决策 7）。
 */
export function shouldRenderImage(
  preference: boolean,
  articleOverride: boolean | undefined,
  groupOverrides: ReadonlySet<number>,
  groupIndex: number,
): boolean {
  if (groupOverrides.has(groupIndex)) return true
  return articleOverride ?? preference
}
