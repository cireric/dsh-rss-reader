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
async function mount({ settings, saveSettings } = {}) {
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
  let settingsState = settings ?? { effective: { ...TUNABLE_DEFAULTS }, defaults: { ...TUNABLE_DEFAULTS } }
  const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
  // 宿主通道的真实形态：HTTP 200 + 信封 ok:false（browserRpc 先看 response.ok 再看信封）。
  const failEnvelope = (error) => ({ ok: true, status: 200, json: async () => ({ ok: false, error }) })
  const requests = []
  let pendingFetches = 0
  const fetchStub = async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push({ endpoint: body.endpoint, payload: body.payload })
    if (body.endpoint === 'settings') return ok({ settings: settingsState })
    if (body.endpoint === 'saveSettings') {
      // 桩默认按 patch 合并生效值并回同形快照；用例可以用 saveSettings 选项改写（失败 / 延迟）。
      if (saveSettings !== undefined) {
        const custom = await saveSettings(body.payload)
        if (custom?.error !== undefined) return failEnvelope(custom.error)
        if (custom?.settings !== undefined) { settingsState = custom.settings; return ok({ settings: settingsState }) }
      }
      const patch = body.payload?.patch ?? {}
      settingsState = { ...settingsState, effective: { ...settingsState.effective, ...patch } }
      return ok({ settings: settingsState })
    }
    if (body.endpoint === 'viewPreferences') return ok({})
    if (body.endpoint === 'overview' || body.endpoint === 'refresh') return ok(overview)
    if (body.endpoint === 'duplicateHints') return ok({ hints: [] })
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


/** 把受控 input 的值设进去并派发 React 认的 input 事件（原生 setter 绕过 React 的 value tracker）。 */
function setControlValue(win, element, value) {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('找不到 INPUT 的 value setter')
  setter.call(element, value)
  element.dispatchEvent(new win.Event('input', { bubbles: true }))
}

/** 等一个设置行上的「已保存 ✓」/红字标记出现（设置页的反馈是异步的）。 */
async function waitForSaved(h, key) {
  await h.waitFor(() => h.$('[data-rss-setting-saved="' + key + '"]') !== null, { label: key + ' 的「已保存 ✓」' })
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
  // R11 02：这一行从只读值变成输入框，初值必须显示宿主下发的生效值。
  const input = row.querySelector('[data-rss-setting-input="refreshFeedsPerRound"]')
  assert.ok(input !== null, '第一个参数必须有输入框（02 票把只读改成可写）')
  assert.equal(input.value, '7', '输入框初值必须是宿主下发的生效值')
  // D16：行内没有来源标签、没有「清除本页设置」这类小链接。
  assert.doesNotMatch(row.textContent ?? '', /本页覆盖|插件配置|默认值|清除本页设置/)
  assert.equal(row.querySelector('a'), null, '行内不许有链接')
  assert.equal(row.querySelector('button'), null, '这一行不需要按钮（失焦 / 回车提交）')
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

// ── R11 02：第一个参数可写（spec D12 / D14.2，验收 C16–C17）────────────────────────────
//
// 这一组钉的是**交互契约**：失焦/回车提交、成功就地一闪、非法值零请求、失败保留输入。
// 「另一个输入框里已键入但未提交的文字不丢」在 02 票只有一行可写输入，所以用一个同页的
// 草稿输入 + 页面根节点身份一起证明「没有整页重绘」—— 重挂会把两样都带走。

test('R11 02 保存成功：失焦提交合法值，S 就地「已保存 ✓」约 1.4 秒，且不整页重绘', async () => {
  const h = await mount()
  await openSettings(h)
  const page = h.$('[data-rss-settings-page]')
  // 模拟另一个还有未提交文字的输入框（03 票会把它变成真控件）。
  const draft = h.win.document.createElement('input')
  draft.setAttribute('data-test-draft', '')
  h.$('[data-rss-settings-section="fetch"]').appendChild(draft)
  draft.focus()
  setControlValue(h.win, draft, '草稿未提交')

  const input = h.$('[data-rss-setting-input="refreshFeedsPerRound"]')
  input.focus()
  setControlValue(h.win, input, '7')
  input.blur()
  await waitForSaved(h, 'refreshFeedsPerRound')

  const saves = h.requests.filter((entry) => entry.endpoint === 'saveSettings')
  assert.equal(saves.length, 1, '一次提交只发一次保存')
  assert.deepEqual(saves[0].payload, { patch: { refreshFeedsPerRound: 7 } }, 'patch 必须只带被改的键')
  assert.equal(h.$('[data-rss-setting-saved="refreshFeedsPerRound"]').textContent, '已保存 ✓')
  assert.equal(h.store.get().settings.effective.refreshFeedsPerRound, 7, '成功后用回包覆盖权威值')
  assert.equal(h.$('[data-rss-settings-page]'), page, '保存反馈不许整页重绘（节点身份不变）')
  assert.equal(draft.value, '草稿未提交', '另一个输入框里未提交的文字不许丢')

  // 约 1.4 秒后消失：不能一直挂着，也不能立刻消失（那等于没反馈）。
  await h.waitFor(() => h.$('[data-rss-setting-saved="refreshFeedsPerRound"]') === null,
    { timeout: 2500, label: '「已保存 ✓」自动消失' })
})

test('R11 02 保存成功：回车提交，与失焦走同一路径', async () => {
  const h = await mount()
  await openSettings(h)
  const input = h.$('[data-rss-setting-input="refreshFeedsPerRound"]')
  input.focus()
  setControlValue(h.win, input, '8')
  // 回车只负责把输入框交给失焦路径（提交逻辑只写一份，避免两条路径漂移）。
  input.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await waitForSaved(h, 'refreshFeedsPerRound')
  const saves = h.requests.filter((entry) => entry.endpoint === 'saveSettings')
  assert.deepEqual(saves.map((entry) => entry.payload), [{ patch: { refreshFeedsPerRound: 8 } }])
  assert.equal(h.store.get().settings.effective.refreshFeedsPerRound, 8)
})

test('R11 02 非法值：负数 / 超上限 / 非数字都是就地红字 + 零请求 + 输入保留', async () => {
  const h = await mount()
  await openSettings(h)
  const input = h.$('[data-rss-setting-input="refreshFeedsPerRound"]')
  for (const bad of ['-1', '1000', 'abc', '']) {
    input.focus()
    setControlValue(h.win, input, bad)
    input.blur()
    await h.waitFor(() => h.$('[data-rss-setting-error="refreshFeedsPerRound"]') !== null,
      { label: bad + ' 的就地红字' })
    assert.equal(h.requests.filter((entry) => entry.endpoint === 'saveSettings').length, 0,
      '非法值必须零请求：' + JSON.stringify(bad))
    assert.equal(input.value, bad, '非法输入必须保留，不许悄悄改成别的数：' + JSON.stringify(bad))
  }
  assert.equal(h.store.get().settings.effective.refreshFeedsPerRound, 20, '本地校验失败不许改权威值')
})

test('R11 02 保存失败：输入保留、就地显示「保存失败：… 当前生效值仍是 N」、顶部有提示', async () => {
  const h = await mount({
    saveSettings: () => ({ error: { code: 'write-failed', message: '磁盘满了', details: {} } }),
  })
  await openSettings(h)
  const input = h.$('[data-rss-setting-input="refreshFeedsPerRound"]')
  input.focus()
  setControlValue(h.win, input, '9')
  input.blur()
  await h.waitFor(() => h.$('[data-rss-setting-error="refreshFeedsPerRound"]') !== null,
    { label: '保存失败的就地提示' })
  const error = h.$('[data-rss-setting-error="refreshFeedsPerRound"]').textContent
  assert.match(error, /保存失败：/, '就地错误必须以「保存失败：」开头')
  assert.match(error, /当前生效值仍是 20/, '必须告诉用户此刻真正生效的值')
  assert.equal(input.value, '9', '失败时保留用户输入，方便改完重试')
  assert.match(h.store.get().error ?? '', /保存设置失败/, '顶部状态条也要有提示（D12）')
})

test('R11 02 保存串行化：第二次保存等第一次回包，且只接受最新一次回包为权威（风险 3）', async () => {
  const order = []
  let releaseFirst
  const firstGate = new Promise((resolve) => { releaseFirst = resolve })
  let call = 0
  const h = await mount({
    saveSettings: async (payload) => {
      call += 1
      const mine = call
      order.push('start' + mine + ':' + payload.patch.refreshFeedsPerRound)
      if (mine === 1) await firstGate
      order.push('end' + mine)
      return { settings: { effective: { ...TUNABLE_DEFAULTS, refreshFeedsPerRound: payload.patch.refreshFeedsPerRound }, defaults: { ...TUNABLE_DEFAULTS } } }
    },
  })
  await openSettings(h)
  const first = h.store.saveSetting('refreshFeedsPerRound', 7)
  const second = h.store.saveSetting('refreshFeedsPerRound', 9)
  // 第一条在飞时，第二条不许发出去（串行链不是并发请求）。
  await h.waitFor(() => order.length >= 1, { label: '第一次保存发出' })
  // 不能用 settle()：这里故意让第一条请求一直悬着；给足时间证明第二条不会偷偷发出去。
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(order, ['start1:7'], '第一次回包前不许发第二次')
  releaseFirst()
  const results = await Promise.all([first, second])
  assert.deepEqual(order, ['start1:7', 'end1', 'start2:9', 'end2'], '两次保存必须按提交顺序串行')
  assert.equal(results[1].ok, true)
  assert.equal(h.store.get().settings.effective.refreshFeedsPerRound, 9, '最新一次回包才是权威')
})
