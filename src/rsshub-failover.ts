/**
 * RSSHub 刷新的**实例切换规则**与**冷却**（R15 03，spec §4.1.4）。
 *
 * 这个模块只做三件纯事，网络与存储都在 `refresh.ts`：
 *  ① 候选顺序：上次成功的实例（仍在池中）→ 池顺序；处于冷却期的实例稳定排到最后；
 *  ② 跨实例地址：同一条路由换一台实例（path 与 query 取自订阅 URL 本身）；
 *  ③ 失败摘要：一行 `实例: 原因；实例: 原因`，带截断。
 *
 * **冷却为什么是进程内 Map、不落盘**：它只是「下次先试谁」的排序优化，不是关于源的事实。
 * 落盘会把它变成第二份需要迁移、需要和真实成功/失败对账的状态；进程重启后所有实例重新平等，
 * 最坏只是先试一台正在坏的实例（多 12 s），没有正确性损失。同理，冷却不是拉黑：
 * 源只配一个实例时照常尝试它，10 分钟一到就回到原顺序。
 */
import { rsshubOriginOf } from './rsshub-source.js'

/** 单个实例的超时上限：12 s（与配置里的 timeoutMs 无关）。 */
export const RSSHUB_ATTEMPT_TIMEOUT_MS = 12_000

/** 一次刷新的切换总预算：20 s。第一个用满 12 s 时，第二个只剩 8 s。 */
export const RSSHUB_REFRESH_BUDGET_MS = 20_000

/** 每次刷新最多尝试几个**不同**实例（spec §4.1.4 的硬上限，防止切换把延迟放大成池子大小倍）。 */
export const RSSHUB_MAX_ATTEMPTS = 2

/** 连续失败多少次后该实例在此源上排到最后。 */
export const RSSHUB_COOLDOWN_FAILURES = 2

/** 冷却时长：10 分钟（不是拉黑，到期自动回原序）。 */
export const RSSHUB_COOLDOWN_MS = 10 * 60 * 1000

/**
 * `lastFailure` 的截断长度（UTF-16 码元，即 JS 的 `.length`）。
 *
 * 为什么是 200：这条字符串会随 `config.json` 落盘，也会原样出现在订阅行的「最近错误」里。
 * 两个实例的 `host: 原因` 正常只有 40–80 个字符；底层网络错误偶尔会带上完整的请求 URL
 * 与嵌套原因（几百字符），对用户没有额外信息，还会把一行的布局撑坏。200 足够放下两个正常摘要，
 * 超出的一律截断并补 `…`，让人知道「这里还有，但没必要展开」。
 */
export const RSSHUB_FAILURE_MAX_CHARS = 200

/** 一次失败尝试的摘要原料。 */
export interface RsshubAttemptFailure {
  /** 实例源站（URL.origin） */
  readonly instance: string
  /** 失败原因：复用 feed/fetch.ts 的现有措辞（超时 / HTTP 503 / ...），不另造一套。 */
  readonly reason: string
}

/**
 * 候选实例顺序（纯函数）。
 *
 * @param preferredInstance `feed.rsshub.instance`：上次**成功**的那台。只有它仍在池中才排第一 ——
 *   用户把实例移出池子之后，不该再往那台机器发请求。
 * @param instances 生效实例池（顺序即优先级）。
 * @param isCooling 该实例此刻是否在本源的冷却期。冷却只影响排序，调用方仍会拿到它（排在最后）。
 *
 * 顺序内去重（池子里手改出的重复项只试一次）。返回的是归一后的 `URL.origin`。
 */
export function rsshubInstanceOrder(
  preferredInstance: string | undefined,
  instances: readonly string[],
  isCooling: (instance: string) => boolean,
): string[] {
  const ordered: string[] = []
  const preferred = preferredInstance === undefined ? undefined : rsshubOriginOf(preferredInstance)
  if (preferred !== undefined && instances.some((instance) => rsshubOriginOf(instance) === preferred)) {
    ordered.push(preferred)
  }
  for (const instance of instances) {
    const origin = rsshubOriginOf(instance)
    if (origin === undefined || ordered.includes(origin)) continue
    ordered.push(origin)
  }
  // 稳定分区（不是 sort）：冷却中的实例整体后移，组内仍保持池序 —— 排序必须是确定的，
  // 否则同一批实例每轮顺序不同，「先试谁」就变成了掷骰子。
  const ready = ordered.filter((instance) => !isCooling(instance))
  const cooling = ordered.filter((instance) => isCooling(instance))
  return [...ready, ...cooling]
}

/**
 * 把一条订阅搬到另一台实例上：`path` 与 `query` 都取自**订阅 URL 本身**。
 *
 * 为什么不用 `feed.rsshub.path`：那是来源字段里的描述（老记录还可能是按 URL 现算的），
 * 而订阅身份始终是 `feed.id` 这个 URL —— 两者万一被手改成不一致，应该跟订阅走。
 * 同一实例时原样返回：不因为拼接产生任何字节差异（A2 的首选请求必须就是原 URL）。
 */
export function rsshubInstanceUrl(feedUrl: string, instance: string): string {
  const current = new URL(feedUrl)
  if (rsshubOriginOf(instance) === current.origin) return feedUrl
  const target = new URL(instance)
  target.pathname = current.pathname
  target.search = current.search
  return target.toString()
}

interface CooldownEntry {
  /** 连续失败次数；成功一次整条删除，下次从 1 重新数。 */
  failures: number
  /** 冷却截止的墙钟毫秒；0 = 从未进入冷却。 */
  coolingUntil: number
}

export interface RsshubCooldown {
  /** 该源对该实例此刻是否在冷却期（`nowMs` 是墙钟毫秒）。 */
  isCooling: (feedId: string, instance: string, nowMs: number) => boolean
  /** 记一次失败；达到阈值后把冷却窗口从**现在**重新计 10 分钟。 */
  recordFailure: (feedId: string, instance: string, nowMs: number) => void
  /** 记一次成功：清零该实例在该源上的连败计数（不是把冷却时间减半，是整条删掉）。 */
  recordSuccess: (feedId: string, instance: string) => void
}

/**
 * 造一份冷却表。键是 `feedId|instance`：同一个实例在不同源上的健康度互不相干 ——
 * 实例对源 A 的某条路由持续 503，不代表它对源 B 也坏（RSSHub 是路由级故障）。
 *
 * 条目只在失败时新增、成功时删除；冷却到期**只影响排序**（`isCooling` 恒为 false），条目本身不删 ——
 * 它还要留着连败次数，否则「连续失败」会在冷却到期后从 1 重新数。条目量级是「源数 × 用过的实例数」，
 * 每条只有两个数字，不值得为它加一套需要定期跑的清理逻辑。
 */
export function createRsshubCooldown(): RsshubCooldown {
  const entries = new Map<string, CooldownEntry>()
  const keyOf = (feedId: string, instance: string): string => feedId + '|' + instance
  return {
    isCooling: (feedId, instance, nowMs) => {
      const entry = entries.get(keyOf(feedId, instance))
      return entry !== undefined && entry.coolingUntil > nowMs
    },
    recordFailure: (feedId, instance, nowMs) => {
      const key = keyOf(feedId, instance)
      const failures = (entries.get(key)?.failures ?? 0) + 1
      // 第 2 次连败才进冷却；之后再失败说明它刚又被证明是坏的，窗口从「现在」重计，
      // 而不是沿用上一次的截止时间提前放回来。
      entries.set(key, {
        failures,
        coolingUntil: failures >= RSSHUB_COOLDOWN_FAILURES ? nowMs + RSSHUB_COOLDOWN_MS : 0,
      })
    },
    recordSuccess: (feedId, instance) => { entries.delete(keyOf(feedId, instance)) },
  }
}

/**
 * 进程内单例。生命周期是「这个插件进程」，不随某一次刷新重置 —— 冷却要跨轮次才有意义。
 * 测试要隔离时用 `createRsshubCooldown()` 自己造一份。
 */
export const rsshubCooldown: RsshubCooldown = createRsshubCooldown()

/** 摘要里的实例名：主机名（含端口），不带协议 —— 用户认得的是 `rss.tips` 而不是 `https://`。 */
function hostOf(instance: string): string {
  const origin = rsshubOriginOf(instance)
  return origin === undefined ? instance : new URL(origin).host
}

/**
 * 全失败时写进 `lastFailure` 的一行摘要，如 `slarker: 超时；rss.tips: HTTP 503`。
 *
 * 只列**真正尝试过**的实例：没轮到的那台不该出现在失败原因里（否则用户会以为三台都坏了）。
 * 超过 {@link RSSHUB_FAILURE_MAX_CHARS} 时截断并补省略号，理由见该常量的注释。
 */
export function rsshubFailureSummary(attempts: readonly RsshubAttemptFailure[]): string {
  const line = attempts.map(({ instance, reason }) => hostOf(instance) + ': ' + reason).join('；')
  return line.length <= RSSHUB_FAILURE_MAX_CHARS ? line : line.slice(0, RSSHUB_FAILURE_MAX_CHARS) + '…'
}
