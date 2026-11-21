/**
 * 测试用宿主：ADR-0008 的「范围标读」求值（`markRead` 的 scope / all 路径）。
 *
 * 为什么单独一份：`client-bundle`（假 React + 假通道）与 `scroll-dom`（真 DOM + fetch 桩）两套
 * 夹具都要模拟同一个宿主行为。两处各写一遍判据，就会有一天「一个桩跳过了 keptUnread、另一个
 * 没跳」—— 那种夹具分家会让同一条客户端逻辑在两层得到不同结论（docs/pitfalls.md 二、2.6）。
 *
 * 判据与 `src/endpoints.ts` 的 `scopeMarkCandidates` 同形：
 *   范围（feedId / folder / tagId / 全库）× 显示窗（只判 publishedAt）× 过滤（starred）
 *   × `before`（recency 阈值）× 未读 × （skipKept 时）非保持未读。
 *
 * @param items    夹具条目（ItemView 形状：id / feedId / publishedAt / fetchedAt / starred / keptUnread / tagIds）
 * @param isRead   id ⇒ 是否已读（夹具自己的读态台账；条目上的 readAt 只是初始快照）
 * @param payload  markRead 的入参
 * @param options.folderFeedIds  (folderName) => 成员源 id 列表（文件夹范围用；缺省按夹具推导）
 * @returns 命中的条目 id（顺序 = 夹具顺序）
 */
export function scopeMarkIdsOf(items, isRead, payload, options = {}) {
  const feedId = typeof payload?.feedId === 'string' ? payload.feedId : undefined
  const folder = typeof payload?.folder === 'string' ? payload.folder : undefined
  const tagId = typeof payload?.tagId === 'string' ? payload.tagId : undefined
  const starred = payload?.starred === true
  const skipKept = payload?.skipKept === true
  const before = typeof payload?.before === 'string' ? payload.before : undefined
  const windowed = typeof payload?.from === 'string' && typeof payload?.to === 'string'
  const members = folder === undefined
    ? undefined
    : new Set((options.folderFeedIds?.(folder) ?? items.filter((entry) => entry.folder === folder).map((entry) => entry.feedId)))
  return items.filter((entry) => {
    if (isRead(entry.id)) return false
    if (feedId !== undefined && entry.feedId !== feedId) return false
    if (members !== undefined && !members.has(entry.feedId)) return false
    if (tagId !== undefined && !(entry.tagIds ?? []).includes(tagId)) return false
    if (starred && entry.starred !== true) return false
    if (skipKept && entry.keptUnread === true) return false
    const recency = entry.publishedAt ?? entry.fetchedAt
    if (before !== undefined && !(recency < before)) return false
    // 显示窗只认 publishedAt（ADR-0005）：没有发布日期的条目永不进窗。
    if (windowed && (entry.publishedAt === undefined || entry.publishedAt < payload.from || entry.publishedAt >= payload.to)) return false
    return true
  }).map((entry) => entry.id)
}
