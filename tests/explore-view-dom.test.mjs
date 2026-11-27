/**
 * R8b 04：探索视图的 DOM 层验收（spec §4.1 / §4.4 / §4.5 / §4.6、D1 / D6 / D11 / D14）。
 *
 * 为什么要真实 React + 真实构建产物：入口可见性依赖「面板挂载时补取一次 settings 快照」，
 * 参数表单是受控输入，键盘豁免依赖 document 级监听 + view 守卫 —— 这三类都只有真 DOM 层能表达。
 * 装配手法照抄 tests/settings-page-dom.test.mjs（jsdom 从 dsh checkout 解析，缺依赖则跳过）。
 *
 * 断言纪律：不把 jsdom 节点本身交给 assert（pitfalls §2.8），等条件一律轮询 waitFor（§2.13）。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const require_ = createRequire(join(ROOT, 'package.json'))

/** 依次探测 dsh checkout（与 scripts/build.sh / settings-page-dom.test.mjs 同一串候选）。 */
function checkoutRoot() {
  const home = process.env['HOME'] ?? ''
  const candidates = [
    process.env['DSH_CHECKOUT'],
    join(home, 'dsh-harness'),
    join(home, 'dsh'),
    join(home, '.dsh', 'dsh-harness'),
    join(home, 'deepseek-harness'),
  ]
  return candidates.find((candidate) => candidate !== undefined && existsSync(join(candidate, 'node_modules', '.pnpm')))
}

function pnpmPackage(checkout, prefix) {
  const store = join(checkout, 'node_modules', '.pnpm')
  const dir = readdirSync(store).find((entry) => entry.startsWith(prefix + '@'))
  return dir === undefined ? undefined : join(store, dir, 'node_modules', prefix)
}

function loadStack() {
  const checkout = checkoutRoot()
  if (checkout === undefined) return undefined
  try {
    const jsdomPath = require_.resolve('jsdom', { paths: [checkout] })
    const reactPath = pnpmPackage(checkout, 'react')
    const reactDomPath = pnpmPackage(checkout, 'react-dom')
    if (reactPath === undefined || reactDomPath === undefined) return undefined
    return { JSDOM: require_(jsdomPath).JSDOM, reactPath, reactDomPath }
  } catch (error) {
    console.warn('[explore-view-dom] 真实 React/jsdom 装配失败，跳过本组测试：', error instanceof Error ? error.message : error)
    return undefined
  }
}

const STACK = loadStack()
const skip = STACK === undefined ? { skip: '环境缺真实 React/jsdom（见本文件顶部说明）' } : {}

const TUNABLE_DEFAULTS = {
  refreshFeedsPerRound: 20,
  refreshConcurrency: 5,
  minRefreshIntervalMs: 600000,
  cleanupAfterDays: 30,
  rsshubBase: '',
}

/** 夹具：两条带参数的同站路由 + 一条无 example 的路由（证「有值才显示」）。 */
const BRANCHES = {
  namespace: 'github', siteName: 'GitHub', path: '/branches/:user/:repo', name: '仓库分支',
  categories: ['programming'], example: '/github/branches/DIYgod/RSSHub',
  parameters: { user: '用户名', repo: '仓库名' },
  features: { requireConfig: 'none', requirePuppeteer: false, antiCrawler: true, supportPodcast: false, nsfw: false },
}
const ISSUES = {
  namespace: 'github', siteName: 'GitHub', path: '/issues/:user/:repo/:state?', name: '仓库 Issues',
  categories: ['programming'], example: '/github/issues/DIYgod/RSSHub/open',
  parameters: { user: '用户名', repo: '仓库名', state: '状态' },
  features: { requireConfig: 'required', requirePuppeteer: false, antiCrawler: false, supportPodcast: true, nsfw: false },
}
const ZHIHU = {
  namespace: 'zhihu', siteName: '知乎', path: '/people/activities/:id', name: '用户动态',
  categories: ['social'], example: undefined, parameters: {},
  features: { requireConfig: 'none', requirePuppeteer: false, antiCrawler: false, supportPodcast: false, nsfw: false },
}

function catalogPage(items = [BRANCHES, ISSUES, ZHIHU], totals = {}) {
  return {
    siteTotal: totals.siteTotal ?? 2,
    routeTotal: totals.routeTotal ?? 3,
    matched: totals.matched ?? items.length,
    categories: totals.categories ?? ['programming', 'social'],
    items,
    ...(totals.nextCursor === undefined ? {} : { nextCursor: totals.nextCursor }),
  }
}

/** 本轮 mount 的收尾函数登记表：afterEach 统一清（未决 handle 会拖死变异判定）。 */
const liveCleanups = []

async function waitFor(predicate, { timeout = 2000, interval = 5, label = '条件' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error('等待超时（' + timeout + 'ms）：' + label)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/** 起一个 DOM 环境 + 渲染真实 Reader；只桩本票会用到的端点。 */
async function mount({ rsshubBase = 'https://rsshub.example', catalog, build, addFeed } = {}) {
  const { JSDOM } = STACK
  const globalSnapshot = {}
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'ResizeObserver', 'fetch']) {
    globalSnapshot[key] = globalThis[key]
  }
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true })
  const win = dom.window
  globalThis.window = win
  globalThis.document = win.document
  globalThis.HTMLElement = win.HTMLElement
  globalThis.Element = win.Element
  globalThis.Node = win.Node
  globalThis.KeyboardEvent = win.KeyboardEvent
  // jsdom 无布局引擎：getClientRects 恒为空 ⇒ keyboard-routing 的「面板可见」守卫会直接 return。
  win.Element.prototype.getClientRects = function () { return [{}] }
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  globalThis.ResizeObserver = ResizeObserverStub
  win.ResizeObserver = ResizeObserverStub

  // React 必须在 jsdom 全局就位之后 require（pitfalls §2.11）。
  const React = require_(STACK.reactPath)
  const jsxRuntime = require_(join(STACK.reactPath, 'jsx-runtime'))
  const createRoot = require_(join(STACK.reactDomPath, 'client')).createRoot

  const settingsState = {
    effective: { ...TUNABLE_DEFAULTS, rsshubBase },
    defaults: { ...TUNABLE_DEFAULTS },
    version: '0.1.0', dataDir: '/tmp/rss-reader', settingsPath: '/tmp/rss-reader/settings.json', readOnly: [],
  }
  // R15 01：探索入口看的是实例池快照（宿主已把坏项丢掉）。夹具用 rsshubBase 模拟一条池子记录。
  const rsshubInstances = /^https?:\/\//.test(rsshubBase) ? [rsshubBase] : []
  // R15 06：NSFW 开关的初值与写路径都走 rsshubSettings 快照（config.json 的 rsshub.hideNsfw）。
  let rsshubHideNsfw = true
  // R15 07：隐藏列表同样是 config.json 的事实；桩必须像宿主一样把 payload 里的 hiddenNamespaces
  // 写回快照，否则「保存后重取」这条验收会被一个更宽松的替身放过去（pitfalls 二、2.6）。
  let rsshubHidden = []
  const rsshubSnapshot = () => ({
    instances: rsshubInstances, hiddenNamespaces: [...rsshubHidden], hideNsfw: rsshubHideNsfw,
  })
  const overview = { feeds: [], items: [], folders: [], tags: [], unread: 0, perFeedUnread: {}, refreshed: false }
  const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
  const failEnvelope = (error) => ({ ok: true, status: 200, json: async () => ({ ok: false, error }) })
  const requests = []
  let pendingFetches = 0
  const fetchStub = async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push({ endpoint: body.endpoint, payload: body.payload })
    if (body.endpoint === 'settings') return ok({ settings: settingsState })
    if (body.endpoint === 'rsshubSettings') return ok({ rsshub: rsshubSnapshot() })
    if (body.endpoint === 'saveRsshubSettings') {
      if (typeof body.payload?.hideNsfw === 'boolean') rsshubHideNsfw = body.payload.hideNsfw
      if (Array.isArray(body.payload?.hiddenNamespaces)) rsshubHidden = [...body.payload.hiddenNamespaces]
      return ok({ rsshub: rsshubSnapshot() })
    }
    if (body.endpoint === 'viewPreferences') return ok({ preferences: undefined })
    if (body.endpoint === 'saveViewPreferences') return ok({ preferences: body.payload?.preferences })
    if (body.endpoint === 'overview' || body.endpoint === 'refresh') return ok(overview)
    if (body.endpoint === 'duplicateHints') return ok({ hints: [] })
    if (body.endpoint === 'exploreCatalog') {
      if (typeof catalog === 'function') {
        const custom = await catalog(body.payload)
        if (custom?.error !== undefined) return failEnvelope(custom.error)
        if (custom?.value !== undefined) return ok(custom.value)
      }
      return ok(catalogPage())
    }
    if (body.endpoint === 'exploreBuildUrl') {
      if (typeof build === 'function') {
        const custom = await build(body.payload)
        if (custom?.error !== undefined) return failEnvelope(custom.error)
        if (custom?.value !== undefined) return ok(custom.value)
      }
      return ok({ url: 'https://rsshub.example/github/branches/DIYgod/RSSHub' })
    }
    if (body.endpoint === 'addFeed') {
      if (typeof addFeed === 'function') {
        const custom = await addFeed(body.payload)
        if (custom?.error !== undefined) return failEnvelope(custom.error)
        if (custom?.value !== undefined) return ok(custom.value)
      }
      return ok({ added: 1, existed: 0, failed: [], skipped: [], accepted: [{ url: body.payload.url }] })
    }
    return failEnvelope({ code: 'unknown-endpoint', message: '桩未实现 ' + body.endpoint, details: {} })
  }
  const trackedFetch = async (...args) => {
    pendingFetches += 1
    try { return await fetchStub(...args) } finally { pendingFetches -= 1 }
  }
  globalThis.fetch = trackedFetch
  win.fetch = trackedFetch

  const nextTask = () => new Promise((resolve) => {
    if (typeof win.MessageChannel !== 'function') { setTimeout(resolve, 0); return }
    const channel = new win.MessageChannel()
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve() }
    channel.port2.postMessage(0)
  })
  const settle = async ({ timeout = 2000 } = {}) => {
    const deadline = Date.now() + timeout
    let quiet = 0
    while (Date.now() < deadline) {
      await nextTask()
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (pendingFetches > 0) { quiet = 0; continue }
      quiet += 1
      if (quiet >= 2) return
    }
    throw new Error('等界面稳定超时（' + timeout + 'ms）：在飞请求 ' + pendingFetches + ' 个')
  }

  let captured = null
  win.__ModuleLoader__ = { load: (entry) => { captured = entry } }
  vm.runInThisContext(readFileSync(BUNDLE, 'utf8'), { filename: 'client.js' })
  assert.ok(captured !== null, 'bundle 没有调用 window.__ModuleLoader__.load')
  const requireFn = (specifier) => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    throw new Error('未预期的外部依赖：' + specifier)
  }
  const exportsObj = captured.factory(requireFn)
  const store = exportsObj.createReaderStore()
  const reactRoot = createRoot(win.document.getElementById('root'))
  reactRoot.render(React.createElement(exportsObj.createReader(store)))
  await waitFor(() => win.document.getElementById('root').childNodes.length > 0, { label: 'Reader 首次上屏' })
  await settle()
  // 面板挂载会补取一次设置快照（入口可见性判据），等它落地再断言入口。
  await waitFor(() => store.get().settings !== undefined, { label: 'settings 快照' })
  await waitFor(() => store.get().rsshubSettings !== undefined, { label: '实例池快照' })

  const press = (key, shiftKey = false) => {
    const event = new win.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
    win.document.dispatchEvent(event)
    return event.defaultPrevented
  }
  const cleanup = () => {
    try { reactRoot.unmount() } catch (error) { console.warn('[explore-view-dom] unmount 失败：', error) }
    dom.window.close()
    for (const key of Object.keys(globalSnapshot)) {
      try { globalThis[key] = globalSnapshot[key] } catch (error) { console.warn('[explore-view-dom] 全局还原失败：', key, error) }
    }
  }
  liveCleanups.push(cleanup)
  const $ = (selector) => win.document.querySelector(selector)
  const $$ = (selector) => [...win.document.querySelectorAll(selector)]
  const calls = (endpoint) => requests.filter((entry) => entry.endpoint === endpoint)
  return { win, store, requests, calls, press, settle, waitFor, cleanup, $, $$, rsshub: rsshubSnapshot }
}

/** 受控 input 写值并派发 React 认的 input 事件（原生 setter 绕过 value tracker）。 */
function setControlValue(win, element, value) {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('找不到 INPUT 的 value setter')
  setter.call(element, value)
  element.dispatchEvent(new win.Event('input', { bubbles: true }))
}

async function openSettings(h) {
  h.$('[data-rss-settings-open]').click()
  await h.waitFor(() => h.$('[data-rss-settings-page]') !== null, { label: '设置页上屏' })
  await h.settle()
}

async function openFeeds(h) {
  h.press('F')
  await h.waitFor(() => h.store.get().view === 'feeds', { label: '订阅管理页上屏' })
  await h.settle()
}

async function openExploreFromFeeds(h) {
  await openFeeds(h)
  const entry = h.$('[data-rss-explore-open]')
  assert.ok(entry !== null, '订阅管理页的「添加订阅」区域必须有探索入口')
  entry.click()
  await h.waitFor(() => h.store.get().view === 'explore', { label: '探索视图上屏' })
  await h.waitFor(() => h.$('[data-rss-explore-view]') !== null, { label: '探索视图渲染' })
  await h.settle()
}

afterEach(() => {
  while (liveCleanups.length > 0) {
    try { liveCleanups.pop()() } catch (error) { console.warn('[explore-view-dom] 收尾失败：', error) }
  }
})

test('R8b 04 入口可见性：rsshubBase 已配置时设置页与订阅管理页都有入口', skip, async () => {
  const h = await mount({ rsshubBase: 'https://rsshub.example' })
  try {
    await openSettings(h)
    const settingsEntry = h.$('[data-rss-settings-section="rsshub"] [data-rss-explore-open]')
    assert.ok(settingsEntry !== null, '设置页「RSSHub」分区必须有「浏览该实例的路由表」')
    assert.match(settingsEntry.textContent ?? '', /浏览该实例的路由表/, '入口文案是验收项')

    h.press('Escape')
    await h.waitFor(() => h.store.get().view === 'list', { label: 'Esc 回列表' })
    await openFeeds(h)
    const feedsEntry = h.$('[data-rss-explore-open]')
    assert.ok(feedsEntry !== null, '订阅管理页「添加订阅」区域必须有探索入口')
  } finally {
    h.cleanup()
  }
})

test('R8b 04 D11 入口隐藏：未配置 rsshubBase 时两处入口都不渲染', skip, async () => {
  const h = await mount({ rsshubBase: '' })
  try {
    await openSettings(h)
    const settingsEntry = h.$('[data-rss-settings-section="rsshub"] [data-rss-explore-open]')
    assert.equal(settingsEntry !== null, false, '未配置实例时设置页入口必须消失')

    h.press('Escape')
    await h.waitFor(() => h.store.get().view === 'list', { label: 'Esc 回列表' })
    await openFeeds(h)
    const feedsEntry = h.$('[data-rss-explore-open]')
    assert.equal(feedsEntry !== null, false, '未配置实例时订阅管理页入口必须消失')
  } finally {
    h.cleanup()
  }
})

test('R8b 04 入口可见性：非法 rsshubBase（ftp://x）与未配置同判据 —— 两处入口都不渲染', skip, async () => {
  // 宿主 exploreBaseOf 走 parseRsshubBase：ftp://x 解析失败 ⇒ not-configured。入口若只看
  // 字符串非空，就会先渲染再让人点进一个必然报错的页面 — 两处入口必须用同一份判据。
  const h = await mount({ rsshubBase: 'ftp://x' })
  try {
    await openSettings(h)
    const settingsEntry = h.$('[data-rss-settings-section="rsshub"] [data-rss-explore-open]')
    assert.equal(settingsEntry !== null, false, '非法实例地址时设置页入口必须消失')

    h.press('Escape')
    await h.waitFor(() => h.store.get().view === 'list', { label: 'Esc 回列表' })
    await openFeeds(h)
    const feedsEntry = h.$('[data-rss-explore-open]')
    assert.equal(feedsEntry !== null, false, '非法实例地址时订阅管理页入口必须消失')
  } finally {
    h.cleanup()
  }
})

test('R15 04 行内分类：每行按 route.categories 显示徽标，顶部筛选保留', skip, async () => {
  // spec §4.2.3：「分类筛选保留；categories 在行内也显示（现在只在顶部筛选区）」。
  // 顶部按钮与行内徽标是两类节点：前者触发筛选，后者只陈述事实。
  const h = await mount()
  try {
    await openExploreFromFeeds(h)
    const row = (path) => h.$$('[data-rss-explore-row]')
      .find((item) => item.getAttribute('data-rss-explore-path') === path)
    const badges = (path) => [...row(path).querySelectorAll('[data-rss-explore-category-badge]')]
      .map((badge) => badge.textContent)

    assert.deepEqual(badges('/branches/:user/:repo'), ['programming'], '行内必须显示这条路由自己的分类')
    assert.deepEqual(badges('/people/activities/:id'), ['social'], '不同分类照实显示，不串行')
    assert.equal(row('/branches/:user/:repo').querySelector('[data-rss-explore-category-badge="programming"]')
      ?.className, 'dsh-rss-explore-badge', '分类徽标与既有事实徽标同族（同一套样式）')
    assert.notEqual(h.$('[data-rss-explore-category="programming"]'), null, '顶部按分类筛选的按钮必须保留')
  } finally {
    h.cleanup()
  }
})

test('R8b 04 列表行：站点名可点、路由名 / 模板 / 参数说明 / example / 事实徽标（false 不出现）', skip, async () => {
  const h = await mount()
  try {
    await openExploreFromFeeds(h)
    const rows = h.$$('[data-rss-explore-row]')
    assert.equal(rows.length, 3, '第一页 3 条路由必须全部渲染')
    const branches = rows.find((row) => row.getAttribute('data-rss-explore-path') === '/branches/:user/:repo')
    const issues = rows.find((row) => row.getAttribute('data-rss-explore-path') === '/issues/:user/:repo/:state?')
    const zhihu = rows.find((row) => row.getAttribute('data-rss-explore-path') === '/people/activities/:id')
    assert.ok(branches !== undefined && issues !== undefined && zhihu !== undefined, '三条夹具路由都要在列表里')

    // 站点名（可点 = 钻取）+ 路由名 + 等宽模板
    assert.equal(branches.querySelector('[data-rss-explore-site]')?.textContent, 'GitHub')
    assert.match(branches.textContent ?? '', /仓库分支/)
    assert.equal(branches.querySelector('[data-rss-explore-path-text]')?.textContent, '/branches/:user/:repo')

    // 参数说明取 parameters[name]（缺则显示参数名）
    const paramsText = branches.querySelector('[data-rss-explore-parameters]')?.textContent ?? ''
    assert.match(paramsText, /用户名/, '参数说明必须来自路由的 parameters')

    // example 有值才显示
    assert.match(branches.querySelector('[data-rss-explore-example]')?.textContent ?? '', /DIYgod\/RSSHub/)
    assert.equal(zhihu.querySelector('[data-rss-explore-example]') ?? null, null, '没有 example 的路由不许显示示例行')

    // 事实徽标：true 才显示
    assert.notEqual(branches.querySelector('[data-rss-explore-feature="antiCrawler"]'), null, '反爬徽标必须出现')
    assert.equal(branches.querySelector('[data-rss-explore-feature="requirePuppeteer"]'), null, 'false 的徽标不许出现')
    assert.notEqual(issues.querySelector('[data-rss-explore-feature="requireConfig"]'), null, '需配置徽标必须出现')
    assert.notEqual(issues.querySelector('[data-rss-explore-feature="supportPodcast"]'), null, '播客徽标必须出现')
    assert.equal(issues.querySelector('[data-rss-explore-feature="antiCrawler"]'), null, 'false 的徽标不许出现')

    // 点站点名 = 设 namespace 钻取（D2）
    branches.querySelector('[data-rss-explore-site]').click()
    await h.settle()
    const after = h.calls('exploreCatalog').at(-1).payload
    assert.equal(after?.namespace, 'github', '点站点名必须把 namespace 作为筛选条件重取第一页')
    assert.equal(after?.cursor, undefined, '钻取 = 换筛选 = 第一页，不许带旧游标')
  } finally {
    h.cleanup()
  }
})

test('R15 04 需配置徽标：required / optional 显示对应文案，none 不显示', skip, async () => {
  // 三态必须在界面上分得开：只显示「需配置」会让用户以为可选配置也是必填（A9）。
  const features = (requireConfig) => ({
    requireConfig, requirePuppeteer: false, antiCrawler: false, supportPodcast: false, nsfw: false,
  })
  const route = (path, requireConfig) => ({
    namespace: 'shapes', siteName: '形态样本', path, name: path,
    categories: [], parameters: {}, features: features(requireConfig),
  })
  const h = await mount({
    catalog: () => ({
      value: catalogPage(
        [route('/required/:id', 'required'), route('/optional/:id', 'optional'), route('/none/:id', 'none')],
        { siteTotal: 1, routeTotal: 3 },
      ),
    }),
  })
  try {
    await openExploreFromFeeds(h)
    const row = (path) => h.$$('[data-rss-explore-row]')
      .find((item) => item.getAttribute('data-rss-explore-path') === path)
    const badge = (path) => row(path).querySelector('[data-rss-explore-feature="requireConfig"]')

    assert.equal(badge('/required/:id')?.textContent, '需配置（必填）', '必填数组必须显示「需配置（必填）」')
    assert.equal(badge('/optional/:id')?.textContent, '需配置（可选）', '全可选数组必须显示「需配置（可选）」')
    assert.equal(badge('/none/:id'), null, 'none 不许显示任何需配置徽标')
  } finally {
    h.cleanup()
  }
})

test('R15 05 周测徽标：通过 / 失败显示对应文案，未参加什么都不显示', skip, async () => {
  // 只允许「周测通过 / 周测失败」两种事实文案；未参加周测不显示第三枚徽标，
  // 也绝不允许写成「优质 / 推荐 / 评分」（spec §4.2.2）。
  const features = { requireConfig: 'none', requirePuppeteer: false, antiCrawler: false, supportPodcast: false, nsfw: false }
  const route = (path, weeklyTest) => ({
    namespace: 'weekly', siteName: '周测样本', path, name: path,
    categories: [], parameters: {}, features,
    ...(weeklyTest === undefined ? {} : { weeklyTest }),
  })
  const h = await mount({
    catalog: () => ({
      value: catalogPage(
        [route('/passed/:id', 'passed'), route('/failed/:id', 'failed'), route('/ungraded/:id', undefined)],
        { siteTotal: 1, routeTotal: 3 },
      ),
    }),
  })
  try {
    await openExploreFromFeeds(h)
    const row = (path) => h.$$('[data-rss-explore-row]')
      .find((item) => item.getAttribute('data-rss-explore-path') === path)
    const badge = (path) => row(path).querySelector('[data-rss-explore-weekly]')

    assert.equal(badge('/passed/:id')?.textContent, '周测通过')
    assert.equal(badge('/failed/:id')?.textContent, '周测失败')
    assert.equal(badge('/ungraded/:id'), null, '未参加周测不显示任何徽标')
    const listText = h.$('[data-rss-explore-view]')?.textContent ?? ''
    assert.equal(/优质|推荐|评分/.test(listText), false, '文案不许出现优质 / 推荐 / 评分')
  } finally {
    h.cleanup()
  }
})

test('R8b 04 行尾「订阅…」把表单开在该行内部（真机反馈：原先表单挂在整张列表之后）', skip, async () => {
  const h = await mount()
  try {
    await openExploreFromFeeds(h)
    const rows = () => h.$$('[data-rss-explore-row]')
    assert.equal(h.$('[data-rss-explore-form]'), null, '没选路由时不该有表单')

    const branches = rows().find((row) => row.getAttribute('data-rss-explore-path') === '/branches/:user/:repo')
    branches.querySelector('[data-rss-explore-pick="/branches/:user/:repo"]').click()
    await h.waitFor(() => h.$('[data-rss-explore-form]') !== null, { label: '行内表单上屏' })
    assert.equal(branches.contains(h.$('[data-rss-explore-form]')), true, '表单必须落在被点中的那一行里')
    assert.equal(h.$$('[data-rss-explore-form]').length, 1, '同时只允许一张表单')

    // 换一行：表单跟着移动，旧行不再持有
    const zhihu = rows().find((row) => row.getAttribute('data-rss-explore-path') === '/people/activities/:id')
    zhihu.querySelector('[data-rss-explore-pick="/people/activities/:id"]').click()
    await h.settle()
    assert.equal(branches.contains(h.$('[data-rss-explore-form]')), false, '旧行不该留着表单')
    assert.equal(zhihu.contains(h.$('[data-rss-explore-form]')), true, '表单必须移到新选中的行里')
  } finally {
    h.cleanup()
  }
})

test('R8b 04 切换 category / q：重取第一页，旧行清空、请求不带 cursor', skip, async () => {
  const h = await mount()
  try {
    await openExploreFromFeeds(h)
    const before = h.calls('exploreCatalog').length
    assert.equal(before, 1, '前置条件：打开探索只取一次目录')

    h.$('[data-rss-explore-category="programming"]').click()
    await h.waitFor(() => h.calls('exploreCatalog').length === before + 1, { label: '按分类重取' })
    await h.settle()
    const categoryCall = h.calls('exploreCatalog').at(-1).payload
    assert.equal(categoryCall?.category, 'programming')
    assert.equal(categoryCall?.cursor, undefined, '换筛选必须从第一页开始（旧游标不回带，B7）')

    // 再点同类 = 清除（D10 单选）
    h.$('[data-rss-explore-category="programming"]').click()
    await h.waitFor(() => h.calls('exploreCatalog').length === before + 2, { label: '再点同类清除' })
    await h.settle()
    assert.equal(h.calls('exploreCatalog').at(-1).payload?.category, undefined, '再点同类必须清除分类')

    // 搜索框提交 q
    const input = h.$('[data-rss-explore-search]')
    assert.ok(input !== null, '必须有搜索框')
    setControlValue(h.win, input, 'github')
    h.$('[data-rss-explore-search-form]').dispatchEvent(new h.win.Event('submit', { bubbles: true, cancelable: true }))
    await h.waitFor(() => h.calls('exploreCatalog').length === before + 3, { label: '按 q 重取' })
    await h.settle()
    const queryCall = h.calls('exploreCatalog').at(-1).payload
    assert.equal(queryCall?.q, 'github')
    assert.equal(queryCall?.cursor, undefined, '换 q 必须从第一页开始')
  } finally {
    h.cleanup()
  }
})

test('R8b 04 空态三种文案分开：目录为空 / 筛选无命中 / 实例不可达', skip, async () => {
  const empty = await mount({
    catalog: () => ({ value: catalogPage([], { siteTotal: 0, routeTotal: 0, matched: 0, categories: [] }) }),
  })
  try {
    await openExploreFromFeeds(empty)
    const text = empty.$('[data-rss-explore-empty]')?.textContent ?? ''
    assert.match(text, /目录为空/, '目录为空必须有自己的文案')
  } finally {
    empty.cleanup()
  }

  const filtered = await mount({
    catalog: (payload) => payload?.q === 'nohit'
      ? { value: catalogPage([], { matched: 0 }) }
      : undefined,
  })
  try {
    await openExploreFromFeeds(filtered)
    setControlValue(filtered.win, filtered.$('[data-rss-explore-search]'), 'nohit')
    filtered.$('[data-rss-explore-search-form]').dispatchEvent(new filtered.win.Event('submit', { bubbles: true, cancelable: true }))
    await filtered.waitFor(() => (filtered.$('[data-rss-explore-empty]')?.textContent ?? '').includes('没有匹配'), { label: '筛选无命中文案' })
  } finally {
    filtered.cleanup()
  }

  const broken = await mount({
    catalog: () => ({ error: { code: 'catalog-unavailable', message: '拉取路由表失败：连接超时', details: {} } }),
  })
  try {
    await openExploreFromFeeds(broken)
    const errorText = broken.$('[data-rss-explore-error]')?.textContent ?? ''
    assert.match(errorText, /连接超时/, '不可达必须原样展示宿主 message，不是空列表')
    assert.equal(broken.$('[data-rss-explore-empty]') ?? null, null, '错误态不许伪装成空列表')
  } finally {
    broken.cleanup()
  }
})

test('R8b 04 参数表单：按 example 预填；必填留空本地拦截并点名（不调 exploreBuildUrl）', skip, async () => {
  const h = await mount()
  try {
    await openExploreFromFeeds(h)
    h.$('[data-rss-explore-route="/branches/:user/:repo"]').click()
    await h.waitFor(() => h.$('[data-rss-explore-form]') !== null, { label: '参数表单上屏' })

    const userInput = h.$('[data-rss-explore-param="user"]')
    const repoInput = h.$('[data-rss-explore-param="repo"]')
    assert.ok(userInput !== null && repoInput !== null, '模板里的两个参数都要有输入框')
    assert.equal(userInput.value, 'DIYgod', 'example 反推的 user 必须预填')
    assert.equal(repoInput.value, 'RSSHub', 'example 反推的 repo 必须预填')

    // 清空必填项 ⇒ 本地拦住「拼地址」，并点名缺的参数
    setControlValue(h.win, userInput, '')
    const buildBefore = h.calls('exploreBuildUrl').length
    h.$('[data-rss-explore-build]').click()
    await h.settle()
    assert.equal(h.calls('exploreBuildUrl').length, buildBefore, '必填缺失时不许发 exploreBuildUrl（本地先拦）')
    assert.match(h.$('[data-rss-explore-missing]')?.textContent ?? '', /user/, '界面必须点名缺的是 user')

    // 填回去：走宿主拼地址，展示只读文本 + 「添加」
    setControlValue(h.win, userInput, 'DIYgod')
    h.$('[data-rss-explore-build]').click()
    await h.waitFor(() => h.calls('exploreBuildUrl').length === buildBefore + 1, { label: '调 exploreBuildUrl' })
    await h.waitFor(() => h.$('[data-rss-explore-url]') !== null, { label: '拼好的地址上屏' })
    const buildCall = h.calls('exploreBuildUrl').at(-1).payload
    assert.equal(buildCall.namespace, 'github')
    assert.equal(buildCall.path, '/branches/:user/:repo')
    assert.equal(buildCall.values.user, 'DIYgod')
    assert.equal(buildCall.values.repo, 'RSSHub')
    assert.match(h.$('[data-rss-explore-url]').textContent ?? '', /branches\/DIYgod\/RSSHub/)

    // 连续订阅：添加一次，视图不关、表单不清、出现回执
    h.$('[data-rss-explore-add]').click()
    await h.waitFor(() => h.$('[data-rss-explore-added]') !== null, { label: '已添加回执' })
    await h.settle()
    assert.equal(h.store.get().view, 'explore', '添加成功后探索视图不许关闭（D6）')
    const addCalls = h.calls('addFeed')
    assert.equal(addCalls.length, 1, '一次点击只能调一次 addFeed')
    assert.equal(addCalls[0].payload.url, 'https://rsshub.example/github/branches/DIYgod/RSSHub')
    assert.equal(h.$('[data-rss-explore-added]').textContent, '已添加 ✓')
    assert.equal(h.$('[data-rss-explore-form]') !== null, true, '表单必须保留（连续订阅）')
    assert.equal(h.$('[data-rss-explore-param="user"]').value, 'DIYgod', '表单草稿不许清空')

    // `:state?` 必须标「可选」，且按 example 预填（open）
    h.$('[data-rss-explore-route="/issues/:user/:repo/:state?"]').click()
    await h.waitFor(() => h.$('[data-rss-explore-field="state"]') !== null, { label: 'Issues 表单' })
    assert.match(h.$('[data-rss-explore-field="state"]').textContent ?? '', /可选/, '可选参数必须标出来')
    assert.equal(h.$('[data-rss-explore-param="state"]').value, 'open', '可选参数同样按 example 预填')

    // parameters 里没有说明时，标签回落成参数名（不编造中文说明）
    h.$('[data-rss-explore-route="/people/activities/:id"]').click()
    await h.waitFor(() => h.$('[data-rss-explore-field="id"]') !== null, { label: '知乎表单' })
    assert.equal(h.$('[data-rss-explore-field="id"]').textContent?.trim(), 'id', '缺说明时显示参数名')
  } finally {
    h.cleanup()
  }
})

test('R8b 04 预填提示：example 缺省 / 段数对不上 ⇒ 字段留空并提示按官方文档填写', skip, async () => {
  const NO_EXAMPLE = {
    namespace: 'zhihu', siteName: '知乎', path: '/people/activities/:id', name: '用户动态',
    categories: ['social'], parameters: {},
    features: { requireConfig: 'none', requirePuppeteer: false, antiCrawler: false, supportPodcast: false, nsfw: false },
  }
  // 段数对不上：模板要 3 段（branches + user + repo），example 只给了 2 段 ⇒ prefillValues 返回空
  const MISMATCH = {
    namespace: 'github', siteName: 'GitHub', path: '/labels/:user/:repo', name: '段数对不上',
    categories: ['programming'], example: '/github/labels/DIYgod',
    parameters: { user: '用户名', repo: '仓库名' },
    features: { requireConfig: 'none', requirePuppeteer: false, antiCrawler: false, supportPodcast: false, nsfw: false },
  }
  const h = await mount({
    catalog: () => ({ value: catalogPage([BRANCHES, NO_EXAMPLE, MISMATCH], { siteTotal: 2, routeTotal: 3 }) }),
  })
  try {
    await openExploreFromFeeds(h)

    // example 能对齐：有预填，不许出现「按官方文档填写」的提示
    h.$('[data-rss-explore-route="/branches/:user/:repo"]').click()
    await h.waitFor(() => h.$('[data-rss-explore-param="user"]') !== null, { label: 'Branches 表单' })
    assert.equal(h.$('[data-rss-explore-param="user"]').value, 'DIYgod')
    assert.equal(h.$('[data-rss-explore-prefill-hint]') ?? null, null, '预填成功时不显示提示')

    // example 缺省：字段留空 + 明说要按官方文档填写（不是让人以为界面没加载出来）
    h.$('[data-rss-explore-route="/people/activities/:id"]').click()
    await h.waitFor(() => h.$('[data-rss-explore-param="id"]') !== null, { label: '无 example 表单' })
    assert.equal(h.$('[data-rss-explore-param="id"]').value, '', '缺 example 时字段必须留空')
    assert.match(h.$('[data-rss-explore-prefill-hint]')?.textContent ?? '', /按官方文档填写/, '缺 example 必须提示按官方文档填写')

    // 段数对不上：同样不预填、同样提示
    h.$('[data-rss-explore-route="/labels/:user/:repo"]').click()
    await h.waitFor(() => h.$('[data-rss-explore-param="repo"]') !== null, { label: '段数不符表单' })
    assert.equal(h.$('[data-rss-explore-param="user"]').value, '', '段数对不上时不许猜值')
    assert.equal(h.$('[data-rss-explore-param="repo"]').value, '', '段数对不上时不许猜值')
    assert.match(h.$('[data-rss-explore-prefill-hint]')?.textContent ?? '', /按官方文档填写/, '段数对不上也必须提示按官方文档填写')
  } finally {
    h.cleanup()
  }
})

test('R8b 04 拼地址回包竞态：两个站点同 path 时，切站后旧回包不许写进新表单', skip, async () => {
  const ALPHA_ROOT = {
    namespace: 'alpha', siteName: 'Alpha', path: '/', name: '站点首页',
    categories: [], parameters: {},
    features: { requireConfig: 'none', requirePuppeteer: false, antiCrawler: false, supportPodcast: false, nsfw: false },
  }
  const BETA_ROOT = {
    namespace: 'beta', siteName: 'Beta', path: '/', name: '站点首页',
    categories: [], parameters: {},
    features: { requireConfig: 'none', requirePuppeteer: false, antiCrawler: false, supportPodcast: false, nsfw: false },
  }
  // 回包由用例手动放行：在飞期间切到另一站点的同 path 路由，模拟旧回包迟到。
  let releaseBuild
  const buildGate = new Promise((resolve) => { releaseBuild = resolve })
  const h = await mount({
    catalog: () => ({ value: catalogPage([ALPHA_ROOT, BETA_ROOT], { siteTotal: 2, routeTotal: 2 }) }),
    build: async () => {
      await buildGate
      return { value: { url: 'https://rsshub.example/alpha/' } }
    },
  })
  try {
    await openExploreFromFeeds(h)
    const rowOf = (namespace) => h.$$('[data-rss-explore-row]').find(
      (row) => row.querySelector('[data-rss-explore-site]')?.getAttribute('data-rss-explore-site') === namespace,
    )
    const alphaRow = rowOf('alpha')
    const betaRow = rowOf('beta')
    assert.ok(alphaRow !== undefined && betaRow !== undefined, '两个同 path 站点都要在列表里')

    alphaRow.querySelector('[data-rss-explore-route="/"]').click()
    await h.waitFor(() => h.$('[data-rss-explore-build]') !== null, { label: 'Alpha 表单' })
    h.$('[data-rss-explore-build]').click()
    await h.waitFor(() => h.calls('exploreBuildUrl').length === 1, { label: 'Alpha 拼地址请求在飞' })

    // 在飞期间切到 Beta 的同 path 路由：旧回包属于 Alpha，绝不能落到 Beta 的表单上。
    betaRow.querySelector('[data-rss-explore-route="/"]').click()
    await h.waitFor(() => h.store.get().explore?.selected?.namespace === 'beta', { label: '切到 Beta' })
    releaseBuild()
    await h.settle()

    assert.equal(h.store.get().explore?.builtUrl, undefined, '切站后旧回包不许写进新表单状态')
    assert.equal(h.$('[data-rss-explore-url]') ?? null, null, 'Beta 表单不许显示 Alpha 拼出的地址')
    assert.equal(h.$('[data-rss-explore-form-path]')?.textContent, '/', '仍停在 Beta 的表单上')
  } finally {
    h.cleanup()
  }
})

test('R8b 04 添加失败：走既有 error 通道显示原因，不给「已添加」回执', skip, async () => {
  const h = await mount({
    addFeed: () => ({
      value: { added: 0, existed: 0, failed: [{ url: 'https://rsshub.example/x', reason: '这个地址不是可订阅的源' }], skipped: [], accepted: [] },
    }),
  })
  try {
    await openExploreFromFeeds(h)
    h.$('[data-rss-explore-route="/branches/:user/:repo"]').click()
    await h.waitFor(() => h.$('[data-rss-explore-form]') !== null, { label: '参数表单上屏' })
    h.$('[data-rss-explore-build]').click()
    await h.waitFor(() => h.$('[data-rss-explore-url]') !== null, { label: '拼好的地址上屏' })
    h.$('[data-rss-explore-add]').click()
    await h.waitFor(() => (h.$('.dsh-rss-status--error')?.textContent ?? '').includes('不是可订阅的源'), { label: '全局错误条' })
    assert.equal(h.$('[data-rss-explore-added]') ?? null, null, '失败时不许出现「已添加」回执')
    assert.equal(h.store.get().view, 'explore', '失败后仍停在探索视图（可以改了再试）')
  } finally {
    h.cleanup()
  }
})

test('R8b 04 加载更多：带游标续页并追加（不是重取第一页）', skip, async () => {
  const second = [{
    namespace: 'github', siteName: 'GitHub', path: '/releases/:user/:repo', name: '仓库 Releases',
    categories: ['programming'], example: '/github/releases/DIYgod/RSSHub',
    parameters: { user: '用户名', repo: '仓库名' },
    features: { requireConfig: 'none', requirePuppeteer: false, antiCrawler: false, supportPodcast: false, nsfw: false },
  }]
  const h = await mount({
    catalog: (payload) => payload?.cursor === 'C1'
      ? { value: catalogPage(second, { matched: 4, nextCursor: undefined }) }
      : { value: catalogPage(undefined, { matched: 4, nextCursor: 'C1' }) },
  })
  try {
    await openExploreFromFeeds(h)
    const more = h.$('[data-rss-explore-more]')
    assert.ok(more !== null, '有 nextCursor 时必须渲染「加载更多」')
    more.click()
    await h.waitFor(() => h.calls('exploreCatalog').length === 2, { label: '续页请求' })
    await h.settle()
    assert.equal(h.calls('exploreCatalog').at(-1).payload?.cursor, 'C1', '续页必须原样回带游标')
    const rows = h.$$('[data-rss-explore-row]')
    assert.equal(rows.length, 4, '续页必须追加到现有行尾部')
    assert.equal(h.$('[data-rss-explore-more]') ?? null, null, '到底之后「加载更多」必须消失')
  } finally {
    h.cleanup()
  }
})

test('R8b 04 键盘：探索视图里 j/k 不被接管；Esc 回列表且焦点有归处', skip, async () => {
  const h = await mount()
  try {
    await openFeeds(h)
    const entry = h.$('[data-rss-explore-open]')
    entry.focus()
    assert.equal(h.win.document.activeElement === entry, true, '前置条件：入口持有焦点')
    entry.click()
    await h.waitFor(() => h.store.get().view === 'explore', { label: '探索视图上屏' })
    await h.settle()

    assert.equal(h.press('j'), false, '探索视图里 j 不许被 preventDefault（阅读键不作用）')
    assert.equal(h.press('k'), false, '探索视图里 k 不许被 preventDefault')
    assert.equal(h.store.get().view, 'explore', 'j/k 不许把视图带走')

    assert.equal(h.press('Escape'), true, 'Esc 在探索视图必须被接管')
    await h.waitFor(() => h.store.get().view === 'list', { label: 'Esc 回列表' })
    await h.settle()
    const active = h.win.document.activeElement
    assert.ok(active !== null, '退出探索后焦点必须在面板内（不许落到 body）')
    assert.equal(active === h.win.document.body, false, '退出探索后焦点不许停在 body（键盘会失灵）')

    // spec §4.1 的另一半：b 也能退出探索（它不是全局绑定，只在本视图生效）
    await openExploreFromFeeds(h)
    assert.equal(h.press('b'), true, 'b 在探索视图必须被接管')
    await h.waitFor(() => h.store.get().view === 'list', { label: 'b 回列表' })

    // 任何离开路径都必须整份丢弃探索状态（D14）；F（订阅管理）是 Esc 之外的另一条真实出口。
    await openExploreFromFeeds(h)
    assert.notEqual(h.store.get().explore, undefined, '前置条件：探索状态存在')
    assert.equal(h.press('F'), true, 'F 在探索视图仍可用（非阅读视图豁免）')
    await h.waitFor(() => h.store.get().view === 'feeds', { label: 'F 进订阅管理' })
    assert.equal(h.store.get().explore, undefined, '离开探索即整份清掉（D14）')
  } finally {
    h.cleanup()
  }
})

// ── R15 06：NSFW 默认隐藏 + 只看可跑（A8 / A12 的界面侧）───────────────────

test('R15 06 两个开关：默认关；切换即重取第一页（不带 cursor）并写回配置 / 视图记忆', skip, async () => {
  const NSFW_ROUTE = {
    namespace: 'secret', siteName: '隐藏站', path: '/secret', name: '隐藏路由',
    categories: [], parameters: {},
    features: { requireConfig: 'none', requirePuppeteer: false, antiCrawler: false, supportPodcast: false, nsfw: true },
  }
  // 回包按请求里的开关变化 —— 若客户端只在本地过滤，这里会看到请求没变、计数也没变。
  const h = await mount({
    catalog: (payload) => payload?.onlyRunnable === true
      ? { value: catalogPage([BRANCHES], { siteTotal: 2, routeTotal: 2, matched: 1 }) }
      : payload?.hideNsfw === false
        ? { value: catalogPage([BRANCHES, NSFW_ROUTE], { siteTotal: 2, routeTotal: 2, matched: 2 }) }
        : { value: catalogPage([BRANCHES], { siteTotal: 2, routeTotal: 2, matched: 1 }) },
  })
  try {
    await openExploreFromFeeds(h)
    const showNsfw = h.$('[data-rss-explore-show-nsfw]')
    const onlyRunnable = h.$('[data-rss-explore-only-runnable]')
    assert.ok(showNsfw !== null, '顶部必须有「显示 NSFW」开关')
    assert.ok(onlyRunnable !== null, '顶部必须有「只看可跑」开关')
    assert.equal(showNsfw.checked, false, '「显示 NSFW」默认关（hideNsfw 默认 true）')
    assert.equal(onlyRunnable.checked, false, '「只看可跑」默认关')

    const first = h.calls('exploreCatalog')[0].payload
    assert.equal(first.hideNsfw, true, '默认请求必须把 hideNsfw 发给宿主（宿主侧过滤）')
    assert.equal(first.onlyRunnable, false)
    assert.equal(h.$('[data-rss-explore-feature="nsfw"]'), null, '开关未打开时 NSFW 徽标不许渲染')

    // 显示 NSFW：持久化到 config.rsshub.hideNsfw，并以新筛选重取第一页。
    showNsfw.click()
    await h.waitFor(() => h.calls('exploreCatalog').length === 2, { label: '显示 NSFW 后重取' })
    await h.settle()
    const second = h.calls('exploreCatalog').at(-1).payload
    assert.equal(second.hideNsfw, false, '开关打开后请求必须带 hideNsfw=false')
    assert.equal(second.cursor, undefined, '过滤器变了游标必须重来')
    const savedRsshub = h.calls('saveRsshubSettings').at(-1)?.payload
    assert.equal(savedRsshub?.hideNsfw, false, '写路径走 saveRsshubSettings')
    assert.deepEqual(savedRsshub?.instances, ['https://rsshub.example'], '保存筛选偏好不许冲掉实例池')
    assert.equal(h.$('[data-rss-explore-feature="nsfw"]')?.textContent, 'NSFW', '开关打开后行内显示 NSFW 徽标')

    // 只看可跑：进入视图记忆（不是 config.rsshub 的第四个字段），同样重取第一页。
    onlyRunnable.click()
    await h.waitFor(() => h.calls('exploreCatalog').length === 3, { label: '只看可跑后重取' })
    await h.settle()
    const third = h.calls('exploreCatalog').at(-1).payload
    assert.equal(third.onlyRunnable, true, '开关打开后请求必须带 onlyRunnable=true')
    assert.equal(third.cursor, undefined, '过滤器变了游标必须重来')
    const savedPrefs = h.calls('saveViewPreferences').at(-1)?.payload.preferences
    assert.equal(savedPrefs?.onlyRunnable, true, '写路径走 saveViewPreferences')
  } finally {
    h.cleanup()
  }
})

test('R15 07：探索行「隐藏此站点」写入 config.rsshub.hiddenNamespaces，并按新筛选重取第一页', skip, async () => {
  // 桩件照宿主契约把隐藏列表写回快照，再据此过滤目录 —— 这样「点完行消失、matched 同步变小」
  // 才是从保存到重取的完整链路，而不是只看一个请求体。
  const h = await mount({
    catalog: () => {
      const hidden = h.rsshub().hiddenNamespaces
      const items = [BRANCHES, ISSUES, ZHIHU].filter((row) => !hidden.includes(row.namespace))
      return { value: catalogPage(items, { siteTotal: 2, routeTotal: 3, matched: items.length }) }
    },
  })
  try {
    await openExploreFromFeeds(h)
    assert.equal(h.$$('[data-rss-explore-row]').length, 3, '前置：隐藏前三条路由都在')
    assert.match(h.$('[data-rss-explore-counts]').textContent ?? '', /命中 3 条/)

    const row = h.$$('[data-rss-explore-row]')
      .find((item) => item.getAttribute('data-rss-explore-path') === '/branches/:user/:repo')
    const hide = row.querySelector('[data-rss-explore-hide-site="github"]')
    assert.ok(hide !== null, '每一行都要有「隐藏此站点」按钮（按该行的 namespace）')
    assert.match(hide.textContent ?? '', /隐藏此站点/)
    hide.click()
    await h.settle()

    const save = h.calls('saveRsshubSettings').at(-1)
    assert.deepEqual(save.payload.hiddenNamespaces, ['github'], '隐藏 = 把该行的 namespace 写进 config.rsshub.hiddenNamespaces')
    assert.deepEqual(save.payload.instances, ['https://rsshub.example'], '只改隐藏列表，实例池原样带上')
    await h.waitFor(() => h.$$('[data-rss-explore-row]').length === 1, { label: '隐藏后重取第一页' })
    assert.deepEqual(
      h.$$('[data-rss-explore-row]').map((item) => item.getAttribute('data-rss-explore-path')),
      ['/people/activities/:id'],
      '被隐藏站点（github）的行必须一起消失',
    )
    assert.match(h.$('[data-rss-explore-counts]').textContent ?? '', /命中 1 条/, 'matched 随之重算')
    assert.equal(h.calls('exploreCatalog').at(-1).payload.cursor, undefined, '筛选变了必须从第一页重取')
  } finally {
    h.cleanup()
  }
})
