/**
 * 显示窗：**读者本地日 → 半开区间**的唯一裁决者（ADR-0005 决定 2）。
 *
 * 这个模块只做三件事，也只该做这三件：
 *   1. 档位 + 现在 → `{ from, to }`（半开区间 `[from, to)`，ISO 瞬间；「全部」是 undefined）；
 *   2. 现在 → 今天的起点（未读三联拆分只用得着这一个阈值，见 spec 第三节第 16 条）；
 *   3. 一行是否落在窗内（`publishedAt` 非空 + 半开区间）。
 * 它不读 store、不碰 DOM、不发查询 —— 宿主与浏览器半共用同一份算术，谁都不许再写第二份。
 *
 * **为什么「落在窗内」也在这里**（R1 02）：列表取数（SQL / JS 适配器）与未读账目（unread.ts）
 * 必须共用同一段窗口判据。把它留在 item-page.ts 会让 unread.ts（被客户端以类型引用）
 * 反向依赖 item-page.ts 的 `node:crypto`，浏览器半直接编译不过；而且窗口判据本来就只认
 * 边界与 `publishedAt`，正是本模块的职责。
 *
 * **为什么不用毫秒减法**：`now - 3 * 86400e3` 假设了「一天 = 24 小时」。DST 的春季自然日只有
 * 23 小时、秋季有 25 小时，用毫秒减法算出来的 `from` 会落在前一天的 23:00 或第二天 01:00，
 * 于是「近 3 天」在调时那一周悄悄多看或少看一段。这里一律走**本地日期构造器逐日推算**
 * （`new Date(y, m, d - n)`）：它按日历借位，跨月、跨年、DST 都是它自己的事。
 *
 * **为什么边界由客户端算、宿主不重算**：宿主与浏览器不保证同一时区（远程宿主、容器、SSH），
 * 而「今天」是读者的今天。宿主只做 `published_at >= from AND published_at < to`（见
 * src/store-sqlite.ts 的 WINDOW_FILTER）。本模块因此必须能在浏览器半编译（无 `node:*` 依赖）。
 */

/** 档位四个值。本轮不持久化：面板每次打开都回到 `all`（spec 实现决策第 1 条）。 */
export type DisplayWindowRange = 'all' | 'today' | '3d' | '7d'

/**
 * 显示窗的传输形态：两个 `toISOString()` 瞬间，`from` 含、`to` 不含。
 *
 * 库里的 `published_at` 由 `toIsoUtc` 归一成同一形态（毫秒三位 + `Z`），所以字符串比较等于时间比较；
 * 别的形态（无毫秒、带 `+08:00` 偏移、只有日期）在入参层就被拒绝（src/endpoint-payloads.ts）。
 */
export interface DisplayWindowBounds {
  readonly from: string
  readonly to: string
}

/**
 * 此刻所在**本地自然日**的起点（00:00:00.000）。
 *
 * 单独导出是因为未读三联拆分只需要这一个阈值：`today` = `published_at >= todayFrom`，
 * `earlier` = `published_at < todayFrom`，`noDate` = `published_at IS NULL` —— 三分恒等于总数。
 */
export function startOfLocalDay(now: Date): Date {
  // 用三个本地分量重新构造，而不是 setHours(0,0,0,0)：两者对 DST 都正确，但构造器是「按日历
  // 造这一天的午夜」的直白写法，读的人不必再想一遍 setHours 在调时日的行为。
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/**
 * 档位 + 现在 → 半开区间；`all` 回 `undefined`（= 不带窗口，旧行为逐字不变）。
 *
 * 「今天」= 本地今日午夜到明日午夜；「近 3 天」= **含今天在内**的 3 个自然日，即今天 − 2 天的
 * 午夜到明日午夜（不是 72 小时），「近 7 天」同理。`to` 永远不补成日末：半开区间是协议的一部分。
 */
export function displayWindowBoundsOf(range: DisplayWindowRange, now: Date): DisplayWindowBounds | undefined {
  if (range === 'all') return undefined
  const days = range === 'today' ? 1 : range === '3d' ? 3 : 7
  // `d - (days - 1)`：日构造器会把越界的日子按日历借位（例如 1 月 1 日 − 6 天 = 去年 12 月 26 日），
  // 而 DST 那天的「一天」由运行时自己决定是 23 还是 25 小时 —— 这里一行时区判断都没有。
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return { from: from.toISOString(), to: to.toISOString() }
}

/**
 * 「这一行落在显示窗内吗」—— JS 侧**唯一一份**显示窗谓词（ADR-0005 决定 1）。
 *
 * 判据只认 `publishedAt`：没有发布日期的条目**永不进窗**（不许拿 fetchedAt 兜底 —— 那会把
 * 「刚抓到的老文章」算成今天）。半开区间 `[from, to)`：等于 `from` 的在窗内，等于 `to` 的不在。
 *
 * SQL 侧的同一份判据是 `src/store-sqlite.ts` 的 WINDOW_FILTER（每种语言各一处）；两份语义
 * 「逐字同义」由 tests/helpers/reader-store-contract.mjs 的窗口契约与端点用例钉住。
 * 列表取数（store / memory-store）与未读账目（unread.ts）都走这里 —— 账目与列表必须是
 * 同一段时间判据，否则只在「无日期 + fetchedAt 落在窗内」这种截面与列表对不上。
 */
export function inDisplayWindow(record: { readonly publishedAt?: string }, window: DisplayWindowBounds): boolean {
  return record.publishedAt !== undefined
    && record.publishedAt >= window.from
    && record.publishedAt < window.to
}
