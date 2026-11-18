/**
 * 排序键与 keyset 游标：`recency` 降序、同 `recency` 内 id 升序的协议。
 *
 * 为什么单独成模块（2026-11-18 shared.ts 规则归位）：排序键、wire 格式（`<recency>|<id>`）与
 * 「认不出必须响亮失败」是**分页协议**的三件套；它们原先住在 `shared.ts` 这个 42 导出的抽屉里，
 * 与视图偏好、未读判据混在一起。现在 store / item-page / search-worker / tools 都从这里取协议。
 *
 * 页面级的**栅栏**（把游标绑在范围上）不在这里，在 `src/item-page.ts`；本模块只管裸游标。
 */

/**
 * 条目的排序用时间：优先发布时间，缺则退到抓取时间。
 *
 * 宿主侧（列表排序、按源裁剪、显式清理）与浏览器半（列表显示）都用它——原先三处各写一份，
 * 任何一处改了规则都会让列表顺序与清理判据悄悄不一致。
 */
export function recencyOf(record: { publishedAt?: string; fetchedAt: string }): string {
  return record.publishedAt ?? record.fetchedAt
}

/**
 * keyset 游标的**解出形态**：一页的边界行 = 排序键（recency）与 id 的**一对值**。
 *
 * 为什么必须是一对值而不是行引用/偏移量：分页期间会有条目被清理、退订连带删除，
 * 而 recency 会大量打平（同一轮抓取的条目共享 fetchedAt）。只带时间会在打平点上死循环或跳页
 * （spec §10.3）；行引用则会在那一行被删掉时静默丢页。
 */
export interface Cursor {
  /** 边界行的 recency = publishedAt ?? fetchedAt（与 recencyOf 同一口径） */
  recency: string
  /** 边界行的条目 id；同 recency 内按它升序续页 */
  id: string
}

/**
 * 游标 → wire 字符串，格式 `"<recency>|<id>"`（brief 定稿的接口）。
 *
 * 分隔符取 `|`：recency 的取值域是 ISO-8601 时刻（见 decodeCursor 的校验），**不含** `|`；
 * 于是「按第一个 `|` 切」是唯一确定的切法。id 是 opaque 摘要，理论上可能含 `|`，
 * 所以切分从左边切、右边整段归 id。
 */
export function encodeCursor(cursor: Cursor): string {
  return cursor.recency + '|' + cursor.id
}

/**
 * wire 字符串 → 游标；**认不出的一律 undefined**。
 *
 * ⚠️ 调用方必须把 undefined 当成**响亮失败**（bad-request），绝不能当成「没有游标 ⇒ 从第一页开始」：
 * 客户端把游标原样回带，一旦解不出却又回第一页，翻页就永远翻不完 —— 每页都回同一批条目，
 * 界面无限追加（用户看到的是重复，而不是报错）。
 *
 * recency 的取值域收得很紧（**实测**：本插件所有写入口都是 `new Date(...).toISOString()` ——
 * refresh.ts 的 stamp、feed/date.ts 的 toIsoUtc，都是毫秒精度 UTC），所以按 ISO-8601 时刻校验。
 * 形状不认 ⇒ 那是**别的版本/别的写入者**塞进来的游标，宁可响亮拒绝也不要静默给出一页错数据。
 */
export function decodeCursor(raw: string): Cursor | undefined {
  const separator = raw.indexOf('|')
  if (separator <= 0) return undefined
  const recency = raw.slice(0, separator)
  const id = raw.slice(separator + 1)
  // 两端都不许带空白：cursor 是机器生成的字符串，多出空白说明它被人手改过或来自别的格式
  if (recency !== recency.trim() || id !== id.trim() || id === '') return undefined
  if (!ISO_INSTANT.test(recency) || Number.isNaN(Date.parse(recency))) return undefined
  return { recency, id }
}

/** ISO-8601 时刻（毫秒可有可无，时区必须是 Z 或 ±HH:MM）。宽松于 toISOString 的产物，但足以挡住垃圾。 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
