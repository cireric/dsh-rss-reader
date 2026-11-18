/**
 * 查询条件栅栏：把续页游标绑在「本次查询的条件」上。
 *
 * 为什么需要（阶段 9 / 阶段 6 留下的欠账）：搜索端点（`searchItems`）与 agent 搜索工具
 * （`rss_search`）此前各写一份「哈希查询条件 → 加 `:` → 切片 → decodeCursor → 拼 nextCursor」。
 * 同一协议两份实现，改一处不会让另一处红；而两者都是**用户可见的翻页**，栅栏失效的形态是
 * 「换了查询条件还接着旧页翻」——不报错，只是结果错。
 *
 * 与 `item-page.ts` 的**范围栅栏**同形但不同 owner：那边绑「文件夹/标签范围」，这边绑查询条件
 * （文本、过滤、日期、源集合）。两者共用 `cursor.ts` 的 wire 格式（`<recency>|<id>`），本模块
 * 只负责「前缀 + 切片 + 形状校验 + 回拼」，不解释查询条件本身。
 */
import { createHash } from 'node:crypto'
import { decodeCursor } from './cursor.js'

/**
 * 查询条件 → 栅栏键（带尾部 `:`）。
 *
 * `parts` 的**顺序与内容**由调用方定：同一个查询必须每次给出同一份 parts（源 id 先排序），
 * 否则键会漂、旧游标全失效。这里只负责确定性哈希，不猜哪些条件该进键。
 */
export function queryFenceKey(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url') + ':'
}

/** 围栏解码的两种结果：`ok`（inner 缺省 = 第一页）或 `mismatch`（前缀/形状不对）。 */
export type FenceParse =
  | { readonly status: 'ok'; readonly inner?: string }
  | { readonly status: 'mismatch' }

/**
 * 校验并切出栅栏内的裸游标。
 *
 * `undefined` = 第一页（合法）；空串、前缀不符、前缀对但游标体认不出，一律 `mismatch` ——
 * 调用方必须把它变成响亮失败，绝不能当成「没有游标 ⇒ 从第一页开始」（那会让翻页永远翻不完）。
 */
export function decodeFencedCursor(key: string, raw: string | undefined): FenceParse {
  if (raw === undefined) return { status: 'ok' }
  if (!raw.startsWith(key)) return { status: 'mismatch' }
  const inner = raw.slice(key.length)
  if (inner === '' || decodeCursor(inner) === undefined) return { status: 'mismatch' }
  return { status: 'ok', inner }
}

/** 把裸游标拼回带栅栏的 wire 形状；到底（undefined）保持 undefined。 */
export function encodeFencedCursor(key: string, nextCursor: string | undefined): string | undefined {
  return nextCursor === undefined ? undefined : key + nextCursor
}
