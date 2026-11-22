/**
 * 设置页的 DOM 层验收（R11 01，spec C13–C14 / D20–D23）。
 *
 * 为什么必须用真实 React + 真实构建产物：本票的核心承诺一条是「设置页不吞阅读键」——
 * 它只在 `document` 级监听 + `view` 守卫的组合里成立。假 React 夹具（client-bundle.test.mjs）
 * 忽略依赖数组，`defaultPrevented` 也无从观察；jsdom + 真 KeyboardEvent 才能表达
 * 「事件没被 preventDefault、列表选中没动」这两条。
 *
 * 与 scroll-dom.test.mjs 同一套装配方式（jsdom 从 dsh checkout 里解析，缺依赖则跳过）：
 * 这里只需要 overview / viewPreferences / settings 三个桩，所以不复制那 400 行夹具，
 * 只保留本票用得到的部分。
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

/** 依次探测 dsh checkout（与 scripts/build.sh 同一串候选路径）。 */
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

/** 在 .pnpm 里按前缀找一个包（名字带 peer 后缀，只能用前缀匹配）。 */
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
    console.warn('[settings-page-dom] 真实 React/jsdom 装配失败，跳过本组测试：', error instanceof Error ? error.message : error)
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
}

/** 本轮 mount 的收尾函数登记表：afterEach 统一清（未决 handle 会拖死变异判定）。 */
const liveCleanups = []

/** 等 predicate 为真；固定 sleep 是在赌机器速度。 */
async function waitFor(predicate, { timeout = 2000, interval = 5, label = '条件' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error('等待超时（' + timeout + 'ms）：' + label)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/**
 * 起一个 DOM 环境 + 渲染真实 Reader。返回的对象与 scroll-dom.test.mjs 的同名夹具同形
 * （press / settle / waitFor / store），但只桩本票会碰到的端点。
 */
async function mount({ settings } = {}) {
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

  const React = require_(STACK.reactPath)
  const jsxRuntime = require_(join(STACK.reactPath, 'jsx-runtime'))
  const createRoot = require_(join(STACK.reactDomPath, 'client')).createRoot

  const overview = {
    feeds: [{ id: 'f1', title: '源一' }, { id: 'f2', title: '源二' }],
    items: [], folders: [], tags: [], unread: 0,
    perFeedUnread: { f1: 0, f2: 0 }, refreshed: false,
  }
  const settingsReply = settings ?? { effective: { ...TUNABLE_DEFAULTS }, defaults: { ...TUNABLE_DEFAULTS } }
  const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
  const requests = []
  let pendingFetches = 0
  const fetchStub = async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push({ endpoint: body.endpoint, payload: body.payload })
    if (body.endpoint === 'settings') return ok({ settings: settingsReply })
    if (body.endpoint === 'viewPreferences') return ok({})
    if (body.endpoint === 'overview' || body.endpoint === 'refresh') return ok(overview)
    if (body.endpoint === 'duplicateHints') return ok({ hints: [] })
    return { ok: false, status: 200, json: async () => ({ ok: false, error: { code: 'unknown-endpoint', message: '桩未实现 ' + body.endpoint, details: {} } }) }
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

  const press = (key, shiftKey = false) => {
    const event = new win.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
    win.document.dispatchEvent(event)
    return event.defaultPrevented
  }
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    reactRoot.unmount()
    dom.window.close()
    for (const key of Object.keys(globalSnapshot)) {
      try { globalThis[key] = globalSnapshot[key] } catch (error) { console.warn('[settings-page-dom] 全局还原失败：', key, error) }
    }
  }
  liveCleanups.push(cleanup)
  const $ = (selector) => win.document.querySelector(selector)
  return { win, store, requests, press, settle, waitFor, cleanup, $ }
}

/** 进入设置页并等它上屏。 */
async function openSettings(h) {
  h.$('[data-rss-settings-open]').click()
  await h.waitFor(() => h.$('[data-rss-settings-page]') !== null, { label: '设置页上屏' })
  await h.settle()
}

afterEach(() => {
  while (liveCleanups.length > 0) {
    try { liveCleanups.pop()() } catch (error) { console.warn('[settings-page-dom] 收尾失败：', error) }
  }
})

test('R11 01 设置页骨架：工具栏进入、标题与返回按钮、五分区按 D13 顺序、首行只读值', skip, async () => {
  const h = await mount({
    settings: {
      effective: { ...TUNABLE_DEFAULTS, refreshFeedsPerRound: 7 },
      defaults: { ...TUNABLE_DEFAULTS },
    },
  })
  await openSettings(h)
  assert.equal(h.store.get().view, 'settings', '点「设置」必须进入 settings 视图')
  assert.ok(h.requests.some((entry) => entry.endpoint === 'settings'), '进入设置页必须向宿主取一次快照')
  assert.equal(h.$('.dsh-rss-settings-title')?.textContent, '设置', '页内标题必须是「设置」')
  assert.equal(h.$('[data-rss-settings-back]')?.textContent, '← 返回列表（Esc）', '返回按钮文案是验收项')
  const sections = [...h.win.document.querySelectorAll('[data-rss-settings-section]')]
    .map((node) => node.getAttribute('data-rss-settings-section'))
  assert.deepEqual(sections, ['fetch', 'display', 'feedOrder', 'agent', 'about'], '五分区必须按 D13 顺序')
  const row = h.$('[data-rss-setting="refreshFeedsPerRound"]')
  assert.ok(row !== null, '第一个分区里必须有「每次刷新抓取源数」这一行')
  assert.equal(row.querySelector('.dsh-rss-settings-label')?.textContent, '每次刷新抓取源数')
  assert.equal(row.querySelector('[data-rss-setting-value]')?.textContent, '7', '只读值必须显示宿主下发的生效值')
  // D16：行内没有来源标签、没有「清除本页设置」这类小链接。
  assert.doesNotMatch(row.textContent ?? '', /本页覆盖|插件配置|默认值|清除本页设置/)
  assert.equal(row.querySelector('a'), null, '行内不许有链接')
  assert.equal(row.querySelector('button'), null, '本票这一行只读，不该出现按钮')
})

test('R11 01 退出设置页：Esc / 返回按钮 / 再点一次设置都回列表', skip, async () => {
  const h = await mount()
  await openSettings(h)
  // ① Esc
  assert.equal(h.press('Escape'), true, 'Esc 在设置页必须被接管（否则浏览器会退出全屏等）')
  assert.equal(h.store.get().view, 'list', 'Esc 必须回列表（D20）')
  await h.settle()
  assert.equal(h.$('[data-rss-settings-page]'), null, '回列表后设置页必须从 DOM 消失')
  // ② 页内返回按钮
  await openSettings(h)
  h.$('[data-rss-settings-back]').click()
  await h.settle()
  assert.equal(h.store.get().view, 'list', '「← 返回列表（Esc）」必须回列表')
  // ③ 再点一次工具栏「设置」
  await openSettings(h)
  h.$('[data-rss-settings-open]').click()
  await h.settle()
  assert.equal(h.store.get().view, 'list', '再点一次「设置」必须回列表（与 F 的 toggle 同型）')
})

test('R11 01 左栏与过滤：设置页下点导航项或切过滤立即回列表且导航生效', skip, async () => {
  const h = await mount()
  await openSettings(h)
  // 点左栏某个源：D21 —— settings 下左栏保留，但导航即退出。
  const feedRow = h.$('[data-rss-nav-row="feed:f2"]')
  assert.ok(feedRow !== null, '前置：左栏必须渲染源行')
  feedRow.click()
  await h.settle()
  assert.equal(h.store.get().view, 'list', '点左栏源必须退出设置页（不许「点了没反应」）')
  assert.deepEqual(h.store.get().navSelection, { kind: 'feed', feedId: 'f2' }, '退出后导航必须真的生效')

  // 切过滤（顶栏/左栏虚拟视图行）：同一条规则。
  await openSettings(h)
  const unreadRow = h.$('[data-rss-nav-row="filter:unread"]')
  assert.ok(unreadRow !== null, '前置：左栏必须渲染过滤行')
  unreadRow.click()
  await h.settle()
  assert.equal(h.store.get().view, 'list', '切过滤必须退出设置页')
  assert.equal(h.store.get().filter, 'unread', '退出后过滤必须真的生效')
})

test('R11 01 设置页不吞阅读键：j / k / 空格不 preventDefault，? 仍可开帮助', skip, async () => {
  const h = await mount()
  await openSettings(h)
  const selectedBefore = h.store.get().selectedId
  for (const key of ['j', 'k', 'n', 'p', 'o', 's', 'm', 'A', 'V', 'i', '1', '2', ' ']) {
    assert.equal(h.press(key), false, key + ' 在设置页不得被 preventDefault（D22）')
  }
  assert.equal(h.store.get().selectedId, selectedBefore, '阅读键不许移动列表选中')
  assert.equal(h.store.get().view, 'settings', '阅读键不得改变视图')
  assert.equal(h.$('[data-rss-settings-page]') !== null, true, '设置页必须还在')
  // 允许的三个键：? 打开帮助、F 去订阅管理、Esc 回列表。
  assert.equal(h.press('?'), true, '? 必须仍能打开帮助')
  await h.waitFor(() => h.$('[data-rss-help]') !== null, { label: '帮助浮窗打开' })
  h.press('Escape')
  await h.waitFor(() => h.$('[data-rss-help]') === null, { label: '帮助浮窗关闭' })
  assert.equal(h.store.get().view, 'settings', '关帮助不该连带退出设置页')
  assert.equal(h.press('f'), true, 'F 必须仍能去订阅管理')
  assert.equal(h.store.get().view, 'feeds', 'F 在设置页下应切到订阅管理')
})

test('R11 01 警示条：坏文件 / 坏值提示可见、可关闭，且本会话内不再出现', skip, async () => {
  const h = await mount({
    settings: {
      effective: { ...TUNABLE_DEFAULTS },
      defaults: { ...TUNABLE_DEFAULTS },
      warning: '有 1 项设置无法识别，已忽略',
    },
  })
  await openSettings(h)
  const warning = h.$('[data-rss-settings-warning]')
  assert.ok(warning !== null, '有读侧告警时设置页顶部必须有警示条（D17）')
  assert.match(warning.textContent ?? '', /有 1 项设置无法识别，已忽略/)
  warning.querySelector('button').click()
  await h.settle()
  assert.equal(h.$('[data-rss-settings-warning]'), null, '「知道了」必须能关掉警示条')
  // 关掉是本次会话内有效：再进设置页不再出现（不重置 dismissed）。
  await openSettings(h)
  assert.equal(h.$('[data-rss-settings-warning]'), null, '重进设置页不该把已关闭的警示条又弹出来')
})

test('R11 01 输入控件守卫：焦点在设置页输入框内时阅读键让位', skip, async () => {
  const h = await mount()
  await openSettings(h)
  // 本票设置页还没有真实输入框（02 票才加）；用一只挂在设置页里的 input 验证同一条全局守卫：
  // isTypingTarget 只看事件目标，不看它属于哪个视图。
  const input = h.win.document.createElement('input')
  h.$('[data-rss-settings-page]').appendChild(input)
  input.focus()
  const selectedBefore = h.store.get().selectedId
  const event = new h.win.KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })
  input.dispatchEvent(event)
  assert.equal(event.defaultPrevented, false, '输入框里的 j 不该被阅读器接管')
  assert.equal(h.store.get().selectedId, selectedBefore, '输入框里的 j 不许移动列表选中')
  assert.equal(h.store.get().view, 'settings', '输入框里的 j 不许切视图')
})
