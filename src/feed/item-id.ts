/**
 * 条目稳定 id —— 已读态（readAt）绑在它上面。
 *
 * 交接件 §8「去重不是归档」：去重集合会滚出窗口，已读态不能跟着丢，
 * 因此 id 必须是**同一 feed、同一条目在任意次重复抓取下的同一取值**。
 *
 * 派生优先级：feed 自带的 id/guid → 永久链接 → 标题+发布时间的哈希。
 * 前缀 feedId 是为了让同一篇文章出现在两个订阅源时各自保有独立的已读态。
 *
 * ⚠️ 2026-10-09 实测的坑（`itemIdCandidates` 的存在理由）：**光有「同一个依据必然派生出同一个 id」
 * 是不够的——依据本身会变**。源把 guid 从 `?p=123` 改成永久链接、guid 整条消失、链接换域名或
 * 带不带 utm、一次响应内的撞车退回，都会让同一篇文章派生出第二个 id；它带着「没见过」的身份进库，
 * 于是列表里同一篇文章上下两条，老的那条还留着已读态（本机实测：162 条里 40 组重复，见
 * identity-repair.ts）。所以落库前必须能拿**全部候选身份**去问一遍「这个身份我们是不是见过了」。
 */
import { createHash } from 'node:crypto'

export interface ItemIdSource {
  /** feed 自带的 guid / Atom id（第一优先） */
  id?: string
  link?: string
  title?: string
  publishedAt?: string
}

function hashIdentity(feedId: string, basis: string): string {
  return createHash('sha1').update(`${feedId}|${basis}`).digest('hex').slice(0, 32)
}

export function deriveItemId(feedId: string, item: ItemIdSource): string {
  const basis = item.id?.trim() || item.link?.trim() || `${item.title ?? ''}|${item.publishedAt ?? ''}`
  return hashIdentity(feedId, basis)
}

/**
 * 一条条目的**全部候选身份**，按可信度排序：源 id/guid → 链接 → 标题+时间签名。
 *
 * 整体交出来而不是只给最高优先的那一个，理由见文件头：候选表就是「拿它去问我们见没见过」的输入。
 * 全部候选都为空（连标题都没有的畸形条目）时退回 deriveItemId，保证 candidates[0] 恒等于旧的
 * 逐条派生结果——身份的主路径不变，变的只是「先问一句」。
 */
export function itemIdCandidates(feedId: string, item: ItemIdSource, options: { includeSourceId?: boolean } = {}): string[] {
  const candidates: string[] = []
  const add = (basis: string | undefined): void => {
    const value = basis?.trim()
    if (value === undefined || value === '') return
    const id = hashIdentity(feedId, value)
    if (!candidates.includes(id)) candidates.push(id)
  }
  if (options.includeSourceId !== false) add(item.id)
  add(item.link)
  // 标题+时间只在有标题时才算候选：空标题会退化成 `|时间` 这种几乎所有条目都撞在一起的依据
  if ((item.title ?? '').trim() !== '') add(`${item.title ?? ''}|${item.publishedAt ?? ''}`)
  if (candidates.length === 0) candidates.push(deriveItemId(feedId, item))
  return candidates
}

/**
 * 撞车被退级时的候选表：**不含源给的 id/guid**。
 *
 * 退级的含义就是「不信源给的那个身份」，所以依据里必须真的没有它——否则退完还是同一个 id，
 * 「退级」变成原地踏步，两条不同文章仍会塌成一条（既有单测正是这么抓住它的）。
 */
export function demotedCandidates(feedId: string, item: ItemIdSource): string[] {
  return itemIdCandidates(feedId, item, { includeSourceId: false })
}

/** 已知身份的可核对信息（来自条目表；去重窗口里的老身份没有记录）。 */
export interface KnownEntry {
  link: string
  title: string
  publishedAt?: string
}

/** 「这个身份我们见过吗」——已存条目与去重窗口合起来答这一个问题。 */
export interface KnownIdentities {
  /** 这个身份是否已知（条目表里有这条，或它还在去重窗口里） */
  has(id: string): boolean
  /**
   * 同一源里，这条链接已经被哪个身份占用（条目表按链接反查）。
   * 源换了 guid 写法时这是唯一能把老条目认回来的依据——候选表里已经找不到老身份了。
   */
  idOf(link: string): string | undefined
  /** 该身份对应的已存条目；只在去重窗口里见过（已被裁掉）时返回 undefined。 */
  recordOf(id: string): KnownEntry | undefined
}

/**
 * 「本条与已知条目说的是同一篇文章吗」——认回**已有记录**的身份时的旁证要求。
 *
 * 为什么必须有：源可以拿**老文章的 guid 去发一篇新文章**（guid 复用）。只凭「id 相同」就认回，
 * 新文章会顶掉老条目的身份——它的正文被并进老记录、自己则消失不见，正是规格 §5 不变量 2 要防的
 * 「静默丢数据」。有旁证（时间或标题对得上）才认，否则宁可多一条重复：重复看得见，丢数据看不见。
 * 注意这条**不**施加于「只在去重窗口里的老身份」——它没有记录可核对，而放行它是
 * 「滚出保留量 ≠ 滚出去重窗口」那条既有不变量的前提。
 */
export function corroborates(known: KnownEntry, item: ItemIdSource): boolean {
  const publishedAt = item.publishedAt?.trim()
  if (publishedAt !== undefined && publishedAt !== '' && known.publishedAt !== undefined && known.publishedAt !== '') {
    return publishedAt === known.publishedAt
  }
  const title = item.title?.trim()
  if (title !== undefined && title !== '' && known.title.trim() !== '') return title === known.title.trim()
  return false
}

export interface ResolvedIds {
  ids: string[]
  /** 因为源内 id 撞车而改按链接重算的条数（源不可信，见下） */
  untrusted: number
  /**
   * 因为「本来就见过」而沿用老身份的条数（源改了 id 形态 / 链接换过 / 撞车退回后又要回来）。
   * 它不是一个错误，但必须看得见：这个数不为 0 就意味着源的行为变过。
   */
  reclaimed: number
}

/**
 * 一次响应内的身份解析。
 *
 * 三步，顺序不能换：
 * ① **链接反查**：同源里这条链接已经有条目 ⇒ 沿用它的身份。源换 guid 写法时（WordPress 的
 *    `?p=123` 与永久链接就是同一篇文章的两种 guid 写法）候选表里根本没有老身份，只有链接还认得出。
 * ② **候选命中**：候选身份里任意一个已知、且**说得通** ⇒ 沿用。覆盖「链接换过但 guid 没变」与
 *    反向的「guid 消失但当初是按链接落的库」。「说得通」= 那个身份没被同响应里的别的链接占用，
 *    且已存记录与本条对得上（时间或标题，见 corroborates）——挡的是 guid 复用把新文章写成老文章。
 * ③ **全新条目**：按优先级派生（结果与改动前的逐条派生逐字一致）。
 * ④ 最后才是同一响应内的撞车兜底（规格 §5 不变量 2）：撞车组里**没被认回**的那些退回链接依据；
 *    已经被认回的条目不算在内——它的身份有据可查，不能被同响应里的另一条挤掉（挤掉就是又一次分叉）。
 */
export function resolveItemIds(
  feedId: string,
  items: readonly ItemIdSource[],
  known?: KnownIdentities,
): ResolvedIds {
  const candidates = items.map((item) => itemIdCandidates(feedId, item))
  const linkOf = items.map((item) => item.link?.trim() ?? '')
  /** 逐条派生本该得到的身份（= 改动前的行为）。untrusted 与「退级」都以它为基准。 */
  const naive = candidates.map((list) => list[0])
  const ids: string[] = items.map((_, index) => naive[index])
  const claimed: boolean[] = items.map(() => false)
  /** 本次响应里**已经花掉**的身份：id → 占用它的链接。用来挡住「抢别人的身份」。 */
  const taken = new Map<string, string>()
  const claim = (index: number, id: string): void => {
    ids[index] = id
    claimed[index] = true
    if (!taken.has(id)) taken.set(id, linkOf[index])
  }
  let reclaimed = 0

  /**
   * 规格 §5 不变量 2：同一响应里 id 撞车且 URL 不同 ⇒ 源不可信，撞车组一律**不信源给的 id**。
   *
   * 只标记「要退级」，不在这里定身份——退级的条目稍后还有一次「认回老身份」的机会
   * （同一篇老文章被列了两遍时，它就该留在老身份上）。
   */
  const collision = new Map<string, number[]>()
  for (const [index, id] of naive.entries()) {
    const group = collision.get(id)
    if (group === undefined) collision.set(id, [index])
    else group.push(index)
  }
  const demote: boolean[] = items.map(() => false)
  for (const group of collision.values()) {
    if (group.length < 2) continue
    if (new Set(group.map((index) => linkOf[index])).size < 2) continue
    for (const index of group) demote[index] = true
  }

  /**
   * 该条目**可以用的**（候选里排最前的）身份；一个都不能用就返回 undefined。
   *
   * 两道闸门，缺一不可：
   * - 身份没被同响应里**别的链接**占走（否则新条目顶掉老条目）；
   * - 若它对应一条已存记录，则要说得通（见 corroborates）——源拿老文章的 guid 发新文章时，
   *   放行就等于让新文章顶着老身份进库、把老条目连内容带已读态一起顶掉（静默丢数据）。
   * 被挡下时继续往候选表下面找（通常是链接），于是新文章拿到自己的身份——
   * 宁可多一条重复：重复看得见，丢数据看不见。
   */
  const usable = (index: number, id: string): boolean => {
    const owner = taken.get(id)
    if (owner !== undefined) return owner === linkOf[index]
    if (known?.has(id) !== true) return true
    const record = known.recordOf(id)
    return record === undefined || corroborates(record, items[index])
  }
  /** 退级的条目从「不含源 id」的候选里挑（退级就是要真的不用那个 id）。 */
  const poolOf = (index: number): string[] =>
    demote[index] ? demotedCandidates(feedId, items[index]) : candidates[index]
  const pick = (index: number): string | undefined => poolOf(index).find((id) => usable(index, id))

  // ① 链接反查：最强证据（同一条链接就是同一篇文章），先跑完再谈别的
  for (const index of items.keys()) {
    const byLink = linkOf[index] === '' ? undefined : known?.idOf(linkOf[index])
    if (byLink === undefined) continue
    claim(index, byLink)
    // 与源当前写法本该派生的身份不同 ⇒ 依据确实变过（同一条老条目正常重抓不会计进来）
    if (byLink !== naive[index]) reclaimed += 1
  }

  // ② 候选命中：可用的候选里有一个是**已知的** ⇒ 沿用（这就是「认回老身份」）
  for (const index of items.keys()) {
    if (claimed[index]) continue
    const adopt = pick(index)
    if (adopt === undefined || known?.has(adopt) !== true) continue
    claim(index, adopt)
    // 认回的身份不是「按源当前写法本该派生的那个」⇒ 源的依据变过，这就是 reclaimed 的含义
    if (adopt !== naive[index]) reclaimed += 1
  }

  // ③ 全新条目：按优先级派生（候选都没被挡时结果与改动前的逐条派生逐字一致）
  for (const index of items.keys()) {
    if (claimed[index]) continue
    const next = pick(index)
    if (next === undefined) {
      // 候选全被挡（畸形条目）：退回逐条派生的结果。宁可撞车也不静默丢条目
      ids[index] = naive[index]
      continue
    }
    ids[index] = next
    if (!taken.has(next)) taken.set(next, linkOf[index])
  }

  // 留痕：被撞车牵连、且最终**没能**留在逐条派生身份上的条数（认回来的不算——它有据可查）
  let untrusted = 0
  for (const index of items.keys()) {
    if (!demote[index]) continue
    if (ids[index] !== naive[index]) untrusted += 1
  }
  return { ids, untrusted, reclaimed }
}
