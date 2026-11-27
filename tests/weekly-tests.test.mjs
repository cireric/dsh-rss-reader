/**
 * R15 05：官方周测数据的解析、7 天缓存与「可跑」判定（spec §4.2.2 / §4.2.3 / A10 / A12）。
 *
 * 数据源是外部周更文件（1.7 MB、形状会漂），所以这里钉三件对外行为：标题 → 映射键的拼法、
 * 缓存的生命期与失败降级、以及「可跑」谓词与稳定分区。出网一律桩 fetch + 可注入时钟，不真出网、不 sleep。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  attachWeeklyTests,
  clearWeeklyTestsCache,
  isRunnableRoute,
  loadWeeklyTests,
  parseWeeklyTests,
  partitionRunnableRoutes,
  weeklyTestKey,
} from '../lib/weekly-tests.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('周测映射键 = "/" + namespace + path（title 是完整路径模板）', () => {
  assert.equal(weeklyTestKey('github', '/branches/:user/:repo'), '/github/branches/:user/:repo')
  assert.equal(weeklyTestKey('163', '/music/user/playlist/:uid/:type?'), '/163/music/user/playlist/:uid/:type?')
})

/** 2026-11-27 的真实周测裁剪快照（口径见 tests/fixtures/weekly-tests/README.md）。 */
function weeklySnapshot() {
  return JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'weekly-tests', 'weekly-tests-2026-11-27.json'), 'utf8'))
}

test('解析：只收 "/" 开头的路由标题，passed / failed 照实映射，非路由标题不进表', () => {
  const tests = parseWeeklyTests(weeklySnapshot())
  assert.ok(tests !== undefined, '真实形状必须解析成功')
  assert.equal(tests.size, 5, '7 条断言里只有 5 条路由标题（2 条非路由标题不算）')
  assert.equal(tests.get('/github/branches/:user/:repo'), 'passed')
  assert.equal(tests.get('/163/music/user/events/:id'), 'passed')
  assert.equal(tests.get('/81/jfjb/:page?'), 'passed', '可选参数模板原样保留 :page?')
  assert.equal(tests.get('/zhihu/people/activities/:id'), 'failed')
  assert.equal(tests.get('/freebuf/articles/:type'), 'failed')
  assert.equal(tests.has('/exports app entrypoint'), false, '非路由标题不许被加上 "/" 前缀塞进表')
  assert.equal(tests.has('exports app entrypoint'), false)
})

test('形状漂移：顶层不是对象 / testResults 不是数组 / 断言容器缺失 ⇒ undefined（整份不可用）', () => {
  const drift = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'weekly-tests', 'shape-drift.json'), 'utf8'))
  for (const [label, raw] of [
    ['null', null],
    ['数组', []],
    ['标量', 'oops'],
    ['testResults 是对象', { testResults: {} }],
    ['testResults 缺失', {}],
    ['testResult 不是对象', { testResults: [1] }],
    ['assertionResults 缺失', drift],
    ['assertionResults 不是数组', { testResults: [{ assertionResults: 'x' }] }],
  ]) {
    assert.equal(parseWeeklyTests(raw), undefined, label + ' ⇒ 必须整份判不可用，不许返回半份表')
  }
})

// ── 7 天缓存与失败降级（A10）─────────────────────────────────────────────

const WEEKLY_URL = 'https://rsshub.js.org/build/test-full-routes.json'
const TTL = 7 * 24 * 60 * 60 * 1000
const FAILURE_BACKOFF = 10 * 60 * 1000

/** 可注入时钟：不 sleep，直接推进毫秒。 */
function clock(start = 1_000_000) {
  let current = start
  return { now: () => current, advance: (ms) => { current += ms } }
}

/** 桩 fetch：按调用次序回放回包，并记录 url / validators / limits。 */
function stubFetch(...outcomes) {
  const calls = []
  const queue = [...outcomes]
  const impl = async (url, validators, limits) => {
    calls.push({ url, validators, limits })
    const outcome = queue.length > 1 ? queue.shift() : queue[0]
    return outcome
  }
  impl.calls = calls
  return impl
}

const okBody = (raw) => ({ kind: 'ok', body: JSON.stringify(raw) })

test('成功拉取：按官方地址要一次，7 天内零请求，第 7 天+1ms 才重新拉', async () => {
  clearWeeklyTestsCache()
  const fetchImpl = stubFetch(okBody(weeklySnapshot()))
  const time = clock()
  const first = await loadWeeklyTests({ fetchImpl, now: time.now })

  assert.ok(first !== undefined, '真实形状必须给出映射表')
  assert.equal(first.size, 5)
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].url, WEEKLY_URL, '官方周测地址是常量，不随实例变化')
  assert.deepEqual(fetchImpl.calls[0].validators, {}, '周测文件不需要条件请求')
  const limits = fetchImpl.calls[0].limits
  assert.ok(limits.timeoutMs > 0 && limits.timeoutMs <= 20_000, '必须有有界的超时预算（实际 ' + limits.timeoutMs + 'ms）')
  assert.ok(limits.maxBytes >= 2 * 1024 * 1024 && limits.maxBytes <= 16 * 1024 * 1024, '体积预算要容得下 1.7 MB 的实测大小')

  time.advance(TTL - 1)
  const hit = await loadWeeklyTests({ fetchImpl, now: time.now })
  assert.equal(hit, first, '7 天内返回同一份映射（进程内缓存）')
  assert.equal(fetchImpl.calls.length, 1, '7 天内第二次必须零请求')

  time.advance(2)
  await loadWeeklyTests({ fetchImpl, now: time.now })
  assert.equal(fetchImpl.calls.length, 2, '过期后必须重新拉取')
})

test('失败降级：超时 / 非 2xx / 坏 JSON / 形状漂移 / 超预算 ⇒ undefined，且 10 分钟内不再重打', async () => {
  for (const [label, outcome] of [
    ['超时', { kind: 'failed', reason: '超时（8000ms）' }],
    ['非 2xx', { kind: 'failed', reason: 'HTTP 503' }],
    ['坏 JSON', { kind: 'ok', body: '<html>网关错误页</html>' }],
    ['形状漂移', okBody(JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'weekly-tests', 'shape-drift.json'), 'utf8')))],
    ['超预算', { kind: 'failed', reason: '响应超过体积上限 8388608 字节' }],
    ['304', { kind: 'not-modified' }],
  ]) {
    clearWeeklyTestsCache()
    const fetchImpl = stubFetch(outcome)
    const time = clock()
    assert.equal(await loadWeeklyTests({ fetchImpl, now: time.now }), undefined, label + ' ⇒ 无周测标注（不抛）')
    assert.equal(fetchImpl.calls.length, 1, label + '：第一次必须尝试')
    // 失败退避：离线时每次打开探索都重打 1.7 MB 是不可接受的。
    time.advance(FAILURE_BACKOFF - 1)
    assert.equal(await loadWeeklyTests({ fetchImpl, now: time.now }), undefined)
    assert.equal(fetchImpl.calls.length, 1, label + '：10 分钟内必须零请求')
    time.advance(2)
    await loadWeeklyTests({ fetchImpl, now: time.now })
    assert.equal(fetchImpl.calls.length, 2, label + '：退避结束后要重试')
  }
})

test('失败后恢复：退避结束重试成功即回到 7 天缓存，失败标记清掉', async () => {
  clearWeeklyTestsCache()
  const fetchImpl = stubFetch(
    { kind: 'failed', reason: 'HTTP 503' },
    okBody(weeklySnapshot()),
  )
  const time = clock()
  assert.equal(await loadWeeklyTests({ fetchImpl, now: time.now }), undefined)
  time.advance(FAILURE_BACKOFF + 1)
  const recovered = await loadWeeklyTests({ fetchImpl, now: time.now })
  assert.ok(recovered !== undefined, '退避后的重试成功要立刻可用')
  time.advance(TTL - 1)
  const cached = await loadWeeklyTests({ fetchImpl, now: time.now })
  assert.equal(cached, recovered, '恢复后按 7 天缓存，不再受失败退避影响')
  assert.equal(fetchImpl.calls.length, 2)
})

test('并发首拉只出网一次：两个探索请求共享同一份在飞请求（不重复下载 1.7 MB）', async () => {
  clearWeeklyTestsCache()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let calls = 0
  const impl = async () => {
    calls += 1
    await gate
    return okBody(weeklySnapshot())
  }
  const a = loadWeeklyTests({ fetchImpl: impl })
  const b = loadWeeklyTests({ fetchImpl: impl })
  release()
  const [first, second] = await Promise.all([a, b])
  assert.equal(calls, 1, '并发的首个探索请求只许拉一次')
  assert.equal(first, second, '两个调用拿到同一份映射')
  assert.ok(first !== undefined)
})

// ── 可跑判定与稳定分区（A12 的排序侧）────────────────────────────────────

/** 一条最小路由行：只带判定需要的 facts。 */
function rowOf(namespace, path, features = {}) {
  return {
    namespace,
    siteName: namespace,
    path,
    name: path,
    categories: [],
    parameters: {},
    features: {
      requireConfig: 'none',
      requirePuppeteer: false,
      antiCrawler: false,
      supportPodcast: false,
      nsfw: false,
      ...features,
    },
  }
}

test('可跑 = 周测通过 + 无反爬 + 无必填配置 + 非 nsfw；任一不满足都不算（A12）', () => {
  const row = rowOf('github', '/branches/:user/:repo')
  assert.equal(isRunnableRoute(row, 'passed'), true, '四个条件全满足才算可跑')
  assert.equal(isRunnableRoute(row, 'failed'), false, '周测失败不算可跑')
  assert.equal(isRunnableRoute(row, undefined), false, '未参加周测 = 没有「通过」事实，不算可跑')
  assert.equal(isRunnableRoute(rowOf('a', '/x', { antiCrawler: true }), 'passed'), false, '反爬不算')
  assert.equal(isRunnableRoute(rowOf('a', '/x', { requireConfig: 'required' }), 'passed'), false, '必填配置不算')
  assert.equal(isRunnableRoute(rowOf('a', '/x', { requireConfig: 'optional' }), 'passed'), true, '可选配置仍算可跑')
  assert.equal(isRunnableRoute(rowOf('a', '/x', { nsfw: true }), 'passed'), false, 'nsfw 不算')
})

test('排序：可跑优先是稳定分区 —— 组内保持目录原序，不重排整体', () => {
  // 目录原序刻意让「可跑」分散在中间，任何一次整体重排（按路径 / 名称）都会改变组内次序。
  const rows = [
    rowOf('aa', '/first', { antiCrawler: true }),   // 不可跑
    rowOf('bb', '/second'),                          // 可跑
    rowOf('cc', '/third', { nsfw: true }),           // 不可跑
    rowOf('dd', '/fourth'),                          // 可跑
    rowOf('ee', '/fifth'),                           // 可跑
    rowOf('ff', '/sixth', { requireConfig: 'required' }), // 不可跑
  ]
  const tests = new Map([
    ['/aa/first', 'passed'],
    ['/bb/second', 'passed'],
    ['/cc/third', 'passed'],
    ['/dd/fourth', 'passed'],
    ['/ee/fifth', 'passed'],
    ['/ff/sixth', 'passed'],
  ])
  const ranked = partitionRunnableRoutes(rows, tests)
  assert.deepEqual(
    ranked.map((row) => row.path),
    ['/second', '/fourth', '/fifth', '/first', '/third', '/sixth'],
    '可跑组（second/fourth/fifth）整体前移，组内与原序一致；其余组同样保序',
  )
  assert.deepEqual(ranked.map((row) => row.path).sort(), rows.map((row) => row.path).sort(), '只分区，不丢行、不重复')
})

test('周测整体不可用（undefined）⇒ 全表保持目录原序；失败样本也不前移', () => {
  const rows = [
    rowOf('aa', '/first'),
    rowOf('bb', '/second'),
    rowOf('cc', '/third'),
  ]
  assert.deepEqual(partitionRunnableRoutes(rows, undefined).map((row) => row.path), ['/first', '/second', '/third'])
  const failedOnly = new Map([['/aa/first', 'failed'], ['/bb/second', 'failed'], ['/cc/third', 'failed']])
  assert.deepEqual(partitionRunnableRoutes(rows, failedOnly).map((row) => row.path), ['/first', '/second', '/third'])
})

test('出页附加：通过的带 passed、失败的带 failed、未参加的不出现该键；不修改冻结的索引行', () => {
  const passed = Object.freeze(rowOf('github', '/branches/:user/:repo'))
  const failed = Object.freeze(rowOf('zhihu', '/people/activities/:id'))
  const ungraded = Object.freeze(rowOf('other', '/unknown/:id'))
  const tests = new Map([
    ['/github/branches/:user/:repo', 'passed'],
    ['/zhihu/people/activities/:id', 'failed'],
  ])
  const views = attachWeeklyTests([passed, failed, ungraded], tests)
  assert.equal(views[0].weeklyTest, 'passed')
  assert.equal(views[1].weeklyTest, 'failed')
  assert.equal('weeklyTest' in views[2], false, '未参加周测不许下发第三个值（ungraded）')
  assert.equal('weeklyTest' in passed, false, '冻结的目录行不能被原地改动（12h 索引缓存会带着它）')
  assert.notEqual(views[0], passed, '出页附加必须产生新对象')
  assert.equal(views[0].namespace, 'github')
  assert.equal(views[0].features, passed.features, '未变化的子结构可以共享引用')
  assert.deepEqual(attachWeeklyTests([ungraded], undefined), [ungraded], '没有周测表时原样返回')
})

test('fetch 实现直接抛异常也不许穿透：按失败降级（A10 的「不抛」）', async () => {
  clearWeeklyTestsCache()
  const impl = async () => {
    throw new Error('socket hang up')
  }
  const time = clock()
  assert.equal(await loadWeeklyTests({ fetchImpl: impl, now: time.now }), undefined)
})
