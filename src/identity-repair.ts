/**
 * 身份修复：把「同一源、同一链接」的重复条目合并成一条。
 *
 * 为什么需要它（而不是只把「以后不再分叉」修好）：分叉是**写进存储**的既成事实——2026-10-09 实测
 * 本机库里 162 条里 40 组重复（同一 feedId + 同一 link 两个 id），老的那条带已读态、新的那条是
 * 未读 ⇒ 列表里同一篇文章上下两条，未读计数跟着虚高。
 * 前向的身份识别（refresh.ts 的 known 索引 + item-id.ts 的候选表）只保证不再新增重复，存量必须
 * 就地合并——否则用户还得自己一条条删。
 *
 * 合并规则：
 * - **幸存者 = 抓取时间最早的那条**（原始条目），同刻按 id 字典序定序 ⇒ 结果与遍历顺序无关；
 * - 用户状态按「有则留、真则留」合并：已读取现成的、星标/保持未读取或、正文取更完整的一份；
 * - 只在**同一源内**按链接合并；链接为空的条目一律不参与（否则一堆空链接会被合成一条）。
 */
import { rebuildItem, type ArticleRecord, type ItemRecord } from './domain.js'
import { articleCharsOf } from './retention.js'
import type { ReaderStore } from './store.js'

/** 参与分组的最小信息。抽出来是为了让「谁和谁算重复」可以被单测直接钉住。 */
export interface IdentityRow {
  id: string
  link: string
  fetchedAt: string
}

/**
 * 把同一源的条目按链接分组，只留下真正重复的组。
 *
 * 每组内部**最早的在前**（同刻按 id 定序）：这个顺序就是「幸存者是谁」的判据，
 * 所以必须与输入顺序无关 —— 否则存储设施换一种遍历顺序，合并结果就跟着变。
 */
export function duplicateGroups(rows: readonly IdentityRow[]): string[][] {
  const byLink = new Map<string, IdentityRow[]>()
  for (const row of rows) {
    const link = row.link.trim()
    if (link === '') continue
    const group = byLink.get(link)
    if (group === undefined) byLink.set(link, [row])
    else group.push(row)
  }
  const duplicates: string[][] = []
  for (const group of byLink.values()) {
    if (group.length < 2) continue
    const ordered = [...group].sort((a, b) =>
      a.fetchedAt === b.fetchedAt ? a.id.localeCompare(b.id) : a.fetchedAt.localeCompare(b.fetchedAt))
    duplicates.push(ordered.map((row) => row.id))
  }
  return duplicates
}

/** 两份正文缓存取更完整的一份：版本优先，同版本按字符数（与正文闸门同一把尺子）。 */
function fullerArticle(a: ArticleRecord | undefined, b: ArticleRecord | undefined): ArticleRecord | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  const revisionA = a.revision ?? 1
  const revisionB = b.revision ?? 1
  if (revisionA !== revisionB) return revisionA > revisionB ? a : b
  return articleCharsOf(a) >= articleCharsOf(b) ? a : b
}

/**
 * 把重复条目并入幸存者：用户状态与正文缓存一律保住，其余字段以幸存者为准。
 *
 * 走 rebuildItem（按 schema 字段表搬运）而不是展开对象：schema 是 .strict()，多余键会被拒，
 * 而手写重建漏字段的账历史上已经吃过一次（见 domain.ts）。
 */
export function mergeItemRecords(keep: ItemRecord, extra: ItemRecord): ItemRecord {
  const article = fullerArticle(keep.article, extra.article)
  const summary = (extra.summary?.length ?? 0) > (keep.summary?.length ?? 0) ? extra.summary : keep.summary
  return rebuildItem(keep, {
    set: {
      title: keep.title.trim() === '' ? extra.title : keep.title,
      publishedAt: keep.publishedAt ?? extra.publishedAt,
      summary,
      readAt: keep.readAt ?? extra.readAt,
      starred: keep.starred || extra.starred,
      keptUnread: keep.keptUnread === true || extra.keptUnread === true ? true : undefined,
      article,
      // 两者互斥：拿到了正文就没有「失败原因」可言
      articleFailure: article === undefined ? (keep.articleFailure ?? extra.articleFailure) : undefined,
    },
  })
}

/**
 * 扫描全部订阅源的条目，合并同源同链接的重复。
 *
 * 幂等：合并后同一链接只剩一条，再跑一次没有任何组可合并（返回 0）。
 * 返回合并掉的条数与处理的组数——调用方要把它写进日志：静默改用户数据是不可接受的。
 */
export async function repairIdentities(store: ReaderStore): Promise<{ merged: number; groups: number }> {
  let merged = 0
  let groups = 0
  for (const [feedId] of store.listFeeds()) {
    const rows = store.listItems(feedId).map(([id, record]) => ({ id, link: record.link, fetchedAt: record.fetchedAt }))
    for (const ids of duplicateGroups(rows)) {
      const keeperId = ids[0]
      const keeper = store.item(keeperId)
      if (keeper === undefined) continue
      let survivor = keeper
      for (const loserId of ids.slice(1)) {
        const loser = store.item(loserId)
        if (loser === undefined) continue
        survivor = mergeItemRecords(survivor, loser)
        merged += 1
      }
      groups += 1
      await store.saveItem(keeperId, survivor)
      for (const loserId of ids.slice(1)) await store.deleteItem(loserId)
    }
  }
  return { merged, groups }
}
