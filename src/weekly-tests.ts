/**
 * R15 05：官方周测数据（`https://rsshub.js.org/build/test-full-routes.json`）的拉取、缓存与
 * 「可跑」判定。
 *
 * 为什么要独立成模块：这份 1.7 MB 的周更文件是**外部事实**，会超时、会 404、会改形状；把它
 * 的拉取和解析塞进端点，失败路径就会和目录取表混在一起，只能靠真实例验证。这里对外只承诺
 * 一件事：要么给出一张「完整路径模板 → 通过 / 失败」的表，要么给出 `undefined`（= 无周测标注）。
 * 宁可不标注，也不拿半份数据冒充完整事实。
 */
import type { ExploreRouteView } from './shared.js'
import { fetchFeed, type FetchResult } from './feed/fetch.js'

/** 周测结论只有两种（wire 上缺省 = 未参加）；与 `ExploreRouteView['weeklyTest']` 同一份声明。 */
export type WeeklyTest = NonNullable<ExploreRouteView['weeklyTest']>

/** 只读映射：键 = 完整路径模板（含 namespace 段），值 = 通过 / 失败。 */
export type WeeklyTestMap = ReadonlyMap<string, WeeklyTest>

/**
 * 周测数据代次（R15 06）：每份映射对象一个自增序号，供游标栅栏判断「翻页中途周测换代」。
 *
 * 为什么按对象身份而不是内容哈希：代次回答的是「这一页和下一页看的是不是同一份周测」。
 * 重新拉取后即便内容恰好相同，也已经是新的一份事实；按对象身份判会保守地让旧游标失效，
 * 这正是我们想要的诚实失败（静默重复 / 漏行更糟）。WeakMap 不阻止映射被回收。
 */
const weeklyTestGenerations = new WeakMap<WeeklyTestMap, number>()
let weeklyTestGenerationSeq = 0

/**
 * 一份周测映射的稳定代次；`undefined`（本次没有周测标注）固定为 `none`。
 *
 * 同一个映射对象在整个缓存生命期内返回同一个值；`loadWeeklyTests` 刷新后是新对象 ⇒ 新代次。
 * 直接构造的非缓存映射（测试 / 未来其它来源）也按对象身份惰性取号，不需要调用方配合。
 */
export function weeklyTestGenerationOf(weeklyTests: WeeklyTestMap | undefined): string {
  if (weeklyTests === undefined) return 'none'
  const known = weeklyTestGenerations.get(weeklyTests)
  if (known !== undefined) return String(known)
  weeklyTestGenerationSeq += 1
  weeklyTestGenerations.set(weeklyTests, weeklyTestGenerationSeq)
  return String(weeklyTestGenerationSeq)
}

/**
 * 测试标题是**完整**路径模板（`/github/branches/:user/:repo`），目录里的 `path` 是相对模板
 *（`/branches/:user/:repo`）—— 拼法只有这一处，端点与未来的筛选都从这里取键。
 */
export function weeklyTestKey(namespace: string, path: string): string {
  return '/' + namespace + path
}

/** 对象判据：数组也是 object，但出现在这些位置一定是漂移。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 把 Jest 汇总 JSON 投影成「路径模板 → 通过 / 失败」。
 *
 * 为什么容器形状一坏就整份放弃：这是一份**外部事实**，半份表的危险不在于少几条徽标，而在于
 * 剩下那部分看起来仍然权威。三种容器（顶层对象 / `testResults` 数组 / 每项的
 * `assertionResults` 数组）任一不符 ⇒ `undefined`，由调用方按「本次没有周测标注」处理。
 *
 * 为什么不收非 `/` 开头的标题：那 4 条是 `exports app entrypoint` 之类的非路由测试，
 * 拼进来只会得到永远匹配不上的键；`title` 非字符串 / 状态不是 passed|failed 的单条跳过，
 * 一条脏断言不该否掉其余 3,900 条。
 */
export function parseWeeklyTests(raw: unknown): WeeklyTestMap | undefined {
  if (!isRecord(raw)) return undefined
  const results = raw['testResults']
  if (!Array.isArray(results)) return undefined
  const tests = new Map<string, WeeklyTest>()
  for (const result of results) {
    if (!isRecord(result)) return undefined
    const assertions = result['assertionResults']
    if (!Array.isArray(assertions)) return undefined
    for (const assertion of assertions) {
      if (!isRecord(assertion)) continue
      const title = assertion['title']
      const status = assertion['status']
      if (typeof title !== 'string' || !title.startsWith('/')) continue
      if (status === 'passed' || status === 'failed') tests.set(title, status)
    }
  }
  return tests
}

/**
 * 「可跑」的唯一谓词（spec §4.2.3 / A12）：周测通过 + 无反爬 + 无必填配置 + 非 nsfw。
 *
 * 票 06 的「只看可跑」硬过滤必须复用这一个函数 —— 排序把一个路由放前面、筛选却把它留下，
 * 两处判据就会各说各话。它只回答事实组合，不是质量评分（文案也不许写成优质 / 推荐）。
 */
export function isRunnableRoute(route: ExploreRouteView, weeklyTest: WeeklyTest | undefined): boolean {
  return weeklyTest === 'passed'
    && route.features.antiCrawler === false
    && route.features.requireConfig !== 'required'
    && route.features.nsfw === false
}

/**
 * 稳定分区：可跑的整块前移，其余保持目录原序；两组内部各自保序。
 *
 * 为什么不用 `sort` + 比较器：比较器只定义「谁前谁后」，同组元素的相对次序要靠引擎的实现细节
 * 才可能稳定，而目录顺序是分页键序的一部分。分区一次 O(n)、不比较，语义与实现都更窄。
 */
export function partitionRunnableRoutes(
  rows: readonly ExploreRouteView[],
  weeklyTests: WeeklyTestMap | undefined,
): ExploreRouteView[] {
  const runnable: ExploreRouteView[] = []
  const rest: ExploreRouteView[] = []
  for (const row of rows) {
    const weeklyTest = weeklyTests?.get(weeklyTestKey(row.namespace, row.path))
    const target = isRunnableRoute(row, weeklyTest) ? runnable : rest
    target.push(row)
  }
  return [...runnable, ...rest]
}

/**
 * 出页时把周测结论附加到**当前这一页**的行上。
 *
 * 刻意不写进目录索引：索引按实例缓存 12h、行是冻结的，而周测 7 天才刷新一次；烤进去会让
 * 「索引缓存没过期」变成「周测不能更新」。行本身是新的对象，未参加周测的行原样返回（不下发
 * `weeklyTest` 键，界面据此不显示徽标）。
 */
export function attachWeeklyTests(
  rows: readonly ExploreRouteView[],
  weeklyTests: WeeklyTestMap | undefined,
): ExploreRouteView[] {
  if (weeklyTests === undefined) return [...rows]
  return rows.map((row) => {
    const weeklyTest = weeklyTests.get(weeklyTestKey(row.namespace, row.path))
    return weeklyTest === undefined ? row : { ...row, weeklyTest }
  })
}

/** 官方周测文件（spec §4.2.2）：常量地址，与用户配置的实例无关。 */
const WEEKLY_TESTS_URL = 'https://rsshub.js.org/build/test-full-routes.json'

/** 周更文件 ⇒ 进程内缓存 7 天；重启即空。 */
const WEEKLY_TESTS_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 失败退避 10 分钟：失败不进 7 天缓存，但也不能「每次打开探索都重打 1.7 MB」——离线时那会让
 * 每次翻页都先等一次超时。10 分钟后的一次重试足以在恢复网络后自动接上。
 */
const WEEKLY_TESTS_FAILURE_BACKOFF_MS = 10 * 60 * 1000

/**
 * 拉取预算：实测 1.73 MB / 3.9 s。超时取 8 s（两倍余量，且首次打开探索与目录并行拉取时
 * 不会把页面拖过十秒）；体积上限 8 MiB，给未压缩体积留四倍余量。
 */
const WEEKLY_TESTS_TIMEOUT_MS = 8_000
const WEEKLY_TESTS_MAX_BYTES = 8 * 1024 * 1024

/** `loadWeeklyTests` 的可选依赖：测试注入桩 fetch 与时钟，生产用真实 fetchFeed 与 Date.now。 */
export interface WeeklyTestDeps {
  fetchImpl?: typeof fetchFeed
  now?: () => number
}

interface CachedWeeklyTests {
  readonly map: WeeklyTestMap
  /** 过期时刻（毫秒，取自可注入时钟）。 */
  readonly expiresAt: number
}

let cachedWeeklyTests: CachedWeeklyTests | undefined
/** 上一次失败的时刻；只有它、没有缓存时起退避作用。 */
let failedAt: number | undefined
/** 在飞请求：并发的首个探索请求共享同一次下载，不许各自打一份 1.7 MB。 */
let inflight: Promise<WeeklyTestMap | undefined> | undefined

/**
 * 清空进程内缓存 —— **只给测试隔离用**。生产路径没有「换实例」这类会改变周测数据的键：
 * 周测文件是全局常量，7 天过期由记录自己的 expiresAt 处理。
 */
export function clearWeeklyTestsCache(): void {
  cachedWeeklyTests = undefined
  failedAt = undefined
  inflight = undefined
}

/**
 * 取周测映射；**任何失败都返回 `undefined`**（= 本次没有周测标注），绝不抛、绝不回半份表。
 *
 * 调用方（探索端点）与目录取表**并行**发起它：目录失败就直接返回（不等周测），目录成功才把
 * 结果用于出页时的徽标与排序。目录索引有 12h 实例键缓存，周测 7 天刷新，两者生命周期不同，
 * 不能把周测烤进冻结的索引行。
 */
export async function loadWeeklyTests(deps: WeeklyTestDeps = {}): Promise<WeeklyTestMap | undefined> {
  const now = deps.now ?? Date.now
  const at = now()
  if (cachedWeeklyTests !== undefined) {
    if (at < cachedWeeklyTests.expiresAt) return cachedWeeklyTests.map
    // 过期就丢掉：留着它会让一次失败之后继续拿旧表冒充「本周事实」。
    cachedWeeklyTests = undefined
  }
  if (failedAt !== undefined && at - failedAt < WEEKLY_TESTS_FAILURE_BACKOFF_MS) return undefined
  if (inflight !== undefined) return inflight
  const task = fetchWeeklyTests(deps)
  inflight = task
  try {
    return await task
  } finally {
    if (inflight === task) inflight = undefined
  }
}

/** 拉一次并落缓存；所有失败分支都只记录退避起点。 */
async function fetchWeeklyTests(deps: WeeklyTestDeps): Promise<WeeklyTestMap | undefined> {
  const now = deps.now ?? Date.now
  const failed = (): undefined => {
    failedAt = now()
    return undefined
  }
  let fetched: FetchResult
  try {
    fetched = await (deps.fetchImpl ?? fetchFeed)(WEEKLY_TESTS_URL, {}, {
      timeoutMs: WEEKLY_TESTS_TIMEOUT_MS,
      maxBytes: WEEKLY_TESTS_MAX_BYTES,
    })
  } catch {
    // 抓取层原则上以 `{ kind: 'failed' }` 回报；这里兜的是「实现自身抛了」的意外（连接被重置、
    // 注入的桩件抛错）。周测是锦上添花，任何异常都不许变成探索页的 500。
    return failed()
  }
  // 304 不该出现（我们不发送条件头）：真出现了说明拿到的不是一份完整清单，按不可用处理。
  if (fetched.kind !== 'ok') return failed()

  let raw: unknown
  try {
    raw = JSON.parse(fetched.body)
  } catch {
    // 网关的 HTML 错误页 / 截断的 body 都走这里。周测是锦上添花，不把英文异常抛给探索页。
    return failed()
  }
  const map = parseWeeklyTests(raw)
  if (map === undefined) return failed()

  cachedWeeklyTests = { map, expiresAt: now() + WEEKLY_TESTS_TTL_MS }
  failedAt = undefined
  return map
}
