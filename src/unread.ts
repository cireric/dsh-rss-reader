/**
 * 未读判据与账目：`readAt` 缺省即未读；每源账目的**唯一算法**。
 *
 * 为什么单独成模块（2026-11-18 shared.ts 规则归位）：这条判据在 GLOSSARY 里是「未读判据」，
 * 在 SQL 侧有一个**第二实现**（`read_at IS NULL`），两者必须在同一夹具上逐键对账；
 * 它和 wire 形状挤在 shared.ts 里时，「改判据要同时改 SQL」这件事没有一个固定的地址可以指。
 */
import type { DisplayWindowBounds } from './display-window.js'
import { inDisplayWindow } from './display-window.js'

/**
 * 未读的**唯一判据**：已读 = readAt 有值（粒度见上面的 ItemView.readAt，用户 2026-10-05 定）。
 *
 * 抽成函数不是为了复用代码，是为了让「未读怎么算」**只有一处**：本计划已经两次栽在
 * 「同一条不变式在两个地方各算一遍」上（任务 1 的键域、任务 5 的 unread 口径），每次都表现为
 * 两个数各自自洽、合起来对不上，且只在特定截断/漂移截面才显形。
 *
 * **本函数是这条判据的定义处**；JS 侧任何算未读的地方都必须走它（现役调用方：下面的
 * countUnreadPerFeed —— 旧适配器 createStore 与内存替身 src/memory-store.ts 都经它实现）。
 *
 * ⚠️ Task 5 之后**两条端点路径**（buildOverview / accountOf）不再有 JS 侧的全表记账：都改走存储侧的
 * unreadPerFeed，而自持实现为了不物化 10 万行，在 SQL 里写作 `read_at IS NULL` ——
 * 那是**同一判据的第二实现**，不是第二口径；「两者确实等价」由 tests/store-sqlite.test.mjs 的
 * 逐键对账用例钉住（「unreadPerFeed：与 unread.ts 的唯一口径在同一夹具上逐键相等」）。
 * ⚠️ **不是「宿主侧一处都不剩」**：旧适配器 `src/store.ts` 的 createStore 仍把整张 items 表
 * 摊进 JS 再数一遍（它只被测试当「旧实现 ↔ 自持实现」的同义性基线驱动，不在装载路径上）。
 * 改本条判据时，那处 SQL 与它的对账用例必须一起改。
 */
export const isUnread = (item: { readonly readAt?: string }): boolean => item.readAt === undefined

/**
 * 每源未读账目的**唯一算法**：键域 = feeds 表（0 未读的源也铺 0 值键），未读判据 = isUnread。
 *
 * 两个独立的陷阱都由这里一处挡掉：
 *  ① **不得从 items 派生**——items 是按 maxItemsShown 截断的，而账目按全量表算（endpoints.ts 的
 *     buildOverview 注释）：从截断后的 items 派生，各源之和必然小于顶栏总未读。
 *  ② **已退订源的残留条目不进账**——键域严格 = feeds 表，多一个键就等于左栏多一行幽灵。
 *
 * `window`（R1 02）：可选的显示窗；判据与列表取数**共用** `display-window.ts` 的 inDisplayWindow
 * —— 只认 `publishedAt`、无日期永不进窗，半开区间 `[from, to)`。它在未读判据**之后**生效，
 * 所以窗内账目恒等于「窗内列表里的未读行数」。无窗口 = 全量，旧行为逐字不变。
 *
 * @param feedIds 订阅表当前的全部源 id（只用于定键域，顺序不影响结果）
 * @param items   条目表（宿主传全量；已退订源的残留条目会被 ① 的键域判定挡掉）
 * @param window  可选的显示窗（半开区间）；缺省 = 「全部」
 */
export function countUnreadPerFeed(
  feedIds: Iterable<string>,
  items: Iterable<{ readonly feedId: string; readonly readAt?: string; readonly publishedAt?: string }>,
  window?: DisplayWindowBounds,
): Record<string, number> {
  const unread: Record<string, number> = {}
  // 先按 feeds 表铺 0：左栏按 feeds 表逐行渲染时无条件命中，不必区分「缺键」与「0」
  for (const feedId of feedIds) unread[feedId] = 0
  for (const item of items) {
    if (unread[item.feedId] === undefined) continue
    if (!isUnread(item)) continue
    // 窗口判据只此一份（src/display-window.ts 的 inDisplayWindow）：与 listRecent 的 JS 半边同源。
    if (window !== undefined && !inDisplayWindow(item, window)) continue
    unread[item.feedId] += 1
  }
  return unread
}

/**
 * 未读三联拆分：**全部未读**的构成，只数未读、与显示窗无关（R1 04，spec 决策 16 / 17）。
 *
 * 三个桶共用**一个**阈值 `todayFrom`（读者本地「今天」的起点）：
 *   - `today`  = `publishedAt >= todayFrom`
 *   - `earlier` = `publishedAt < todayFrom`
 *   - `noDate` = 没有 `publishedAt`
 * 所以 `today + earlier + noDate` 恒等于全量未读 —— 时间戳在未来的未读算进「今天」，不另开
 * 第四类；`publishedAt IS NULL` 由 `noDate` 单独接住，不落进前两桶。
 */
export interface UnreadSplit {
  today: number
  earlier: number
  noDate: number
}

/**
 * 未读三联拆分的 **JS 侧唯一算法**（SQL 侧见 store-sqlite.ts 的 unreadSplitSql）。
 *
 * 与 countUnreadPerFeed 同一把尺子：键域先按传进来的 feeds 表收窄，再看 isUnread。这样
 * 三分之和才等于 `unreadPerFeed` 求和出来的总数（已退订源的残留条目不进账）。
 *
 * `todayFrom` 是**唯一**的时间输入：没有窗口、没有终点。字符串比较等于时间比较的前提与
 * 显示窗相同（publishedAt 已由 toIsoUtc 归一成毫秒三位 + Z）。
 */
export function countUnreadSplit(
  feedIds: Iterable<string>,
  items: Iterable<{ readonly feedId: string; readonly readAt?: string; readonly publishedAt?: string }>,
  todayFrom: string,
): UnreadSplit {
  const domain = new Set(feedIds)
  const split: UnreadSplit = { today: 0, earlier: 0, noDate: 0 }
  for (const item of items) {
    if (!domain.has(item.feedId)) continue
    if (!isUnread(item)) continue
    if (item.publishedAt === undefined) split.noDate += 1
    else if (item.publishedAt >= todayFrom) split.today += 1
    else split.earlier += 1
  }
  return split
}

/**
 * 未读账的 wire 形状：overview 与 markRead / unmarkRead **共用同一份**。
 *
 * 标读端点必须回它（不能只回 unread）：客户端只拿得到 maxItemsShown 条 items，截断之外那部分
 * 账（含**另一个面板刚标掉的**）它看不见；只回总数会让客户端拿本地盲增量去补每源账目，
 * 于是左栏各源之和 ≠ 顶栏总未读（spec §4 不变量 1，任务 9 实测复现：本地 3 条/宿主 20，
 * 外部把某本地不可见的源标空 ⇒ 差 3）。
 */
export interface UnreadAccount {
  unread: number
  /** 键域 = feeds 表，见 countUnreadPerFeed */
  perFeedUnread: Record<string, number>
  /**
   * 未读三联拆分；**只在请求给了 `todayFrom` 时出现**（R1 04）。
   *
   * 为什么可选而不是恒有：不带 `todayFrom` 的旧请求必须逐字回旧形状（spec 验收 14），
   * 客户端据此区分「宿主没算拆分」与「拆分真的是 0/0/0」—— 前者回落到旧的「全局 X 条未读」。
   */
  unreadSplit?: UnreadSplit
}
