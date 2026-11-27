/**
 * 设置页的 DOM 层验收（R11 01，spec C13–C14 / D20–D23）。
 *
 * 为什么必须用真实 React + 真实构建产物：本票的核心承诺一条是「设置页不吞阅读键」——
 * 它只在 `document` 级监听 + `view` 守卫的组合里成立。假 React 夹具（client-bundle.test.mjs）
 * 忽略依赖数组，`defaultPrevented` 也无从观察；jsdom + 真 KeyboardEvent 才能表达
 * 「事件没被 preventDefault、列表选中没动」这两条。
 *
 * 与 scroll-dom.test.mjs 同一套装配方式（jsdom 从 dsh checkout 里解析，缺依赖则跳过）：
 * 这里只需要 overview / viewPreferences / settings / saveSettings / cleanup 这几个桩，
 * 所以不复制那 400 行夹具，只保留本票用得到的部分。
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
  rsshubBase: '',
  // R7 02：设置快照必须与宿主同形；翻译分区读这三个键。
  translateProvider: '',
  translateModel: '',
  translateEffort: '',
  translateNoticeAck: false,
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
async function mount({ settings, saveSettings, testRsshub, rsshubPool, saveRsshubSettings, items, cleanupStub, article, prefs = { value: undefined, writes: [] } } = {}) {
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

  // 条目数组可变：cleanup 的桩件要能「预演只算、执行才删」，列表重载后也能看见真实删没删。
  let storedItems = [...(items ?? [])]
  const overview = {
    feeds: [{ id: 'f1', title: '源一' }, { id: 'f2', title: '源二' }],
    items: storedItems, folders: [], tags: [], unread: 0,
    perFeedUnread: { f1: 0, f2: 0 }, refreshed: false,
  }
  /**
   * 每次回包都按**夹具现状**重算未读账（R11 05：显示开关要断言「角标与标题栏未读数」）。
   * 固定 0 会让「隐藏后消失 / 恢复后回来」两条都因为前置条件不成立而假绿。
   */
  const overviewNow = () => {
    const perFeedUnread = { f1: 0, f2: 0 }
    for (const entry of storedItems) {
      if (entry.readAt === undefined && perFeedUnread[entry.feedId] !== undefined) perFeedUnread[entry.feedId] += 1
    }
    return {
      ...overview, items: storedItems,
      unread: Object.values(perFeedUnread).reduce((sum, count) => sum + count, 0),
      perFeedUnread,
    }
  }
  let settingsState = settings ?? { effective: { ...TUNABLE_DEFAULTS }, defaults: { ...TUNABLE_DEFAULTS } }
  // R15 01：实例池快照与 settings 分开取（池子住在 config.json）。默认空池。
  let rsshubState = rsshubPool ?? { instances: [], hiddenNamespaces: [], hideNsfw: true }
  const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
  // 宿主通道的真实形态：HTTP 200 + 信封 ok:false（browserRpc 先看 response.ok 再看信封）。
  const failEnvelope = (error) => ({ ok: true, status: 200, json: async () => ({ ok: false, error }) })
  const requests = []
  let pendingFetches = 0
  const fetchStub = async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push({ endpoint: body.endpoint, payload: body.payload })
    if (body.endpoint === 'settings') return ok({ settings: settingsState })
    if (body.endpoint === 'rsshubSettings') return ok({ rsshub: rsshubState })
    if (body.endpoint === 'saveRsshubSettings') {
      // 桩与宿主同形：坏项由宿主丢弃；用例可以整体改写回包（失败 / 延迟）。
      if (saveRsshubSettings !== undefined) {
        const custom = await saveRsshubSettings(body.payload)
        if (custom?.error !== undefined) return failEnvelope(custom.error)
        if (custom?.rsshub !== undefined) { rsshubState = custom.rsshub; return ok({ rsshub: rsshubState }) }
      }
      rsshubState = { ...rsshubState, instances: [...(body.payload?.instances ?? [])] }
      return ok({ rsshub: rsshubState })
    }
    if (body.endpoint === 'saveSettings') {
      // 桩默认按 patch 合并生效值并回同形快照；用例可以用 saveSettings 选项改写（失败 / 延迟）。
      if (saveSettings !== undefined) {
        const custom = await saveSettings(body.payload)
        if (custom?.error !== undefined) return failEnvelope(custom.error)
        if (custom?.settings !== undefined) { settingsState = custom.settings; return ok({ settings: settingsState }) }
      }
      // R11 07：恢复默认的客户端契约只看「生效值全默认」；文件层删/写规则由 endpoints 测试证明。
      if (body.payload?.resetToDefaults === true) {
        settingsState = { ...settingsState, effective: { ...settingsState.defaults } }
        return ok({ settings: settingsState })
      }
      const patch = body.payload?.patch ?? {}
      settingsState = { ...settingsState, effective: { ...settingsState.effective, ...patch } }
      return ok({ settings: settingsState })
    }
    // R8a 01：RSSHub 探活端点。默认桩回「通过」；用例可整体改写回包。
    if (body.endpoint === 'testRsshub') {
      if (testRsshub !== undefined) return ok(await testRsshub(body.payload))
      return ok({ passed: true, message: '测试通过：实例返回了 Radar 规则 JSON' })
    }
    // R11 04：cleanup 桩件必须支持 dryRun —— 预演只算不删，执行才删（C19 第一条）。
    if (body.endpoint === 'cleanup') {
      if (cleanupStub !== undefined) {
        const custom = await cleanupStub(body.payload)
        if (custom?.error !== undefined) return failEnvelope(custom.error)
        if (custom?.value !== undefined) return ok(custom.value)
      }
      const dryRun = body.payload?.dryRun === true
      // 与宿主同一条判据的**最小投影**：已读、未星标、未保持未读。
      const doomed = storedItems.filter((entry) => entry.readAt !== undefined
        && entry.starred !== true && entry.keptUnread !== true)
      const freedChars = doomed.reduce((sum, entry) => sum + (entry.summary?.length ?? 0), 0)
      if (!dryRun) {
        const ids = new Set(doomed.map((entry) => entry.id))
        storedItems = storedItems.filter((entry) => !ids.has(entry.id))
        overview.items = storedItems
      }
      return ok({ deleted: doomed.length, freedChars, cutoff: '2020-01-01T00:00:00.000Z', dryRun, unread: 0 })
    }
    // 视图记忆（R11 05）：重开面板 = 新 store 读同一份宿主 prefs，写盘落进同一个对象。
    if (body.endpoint === 'viewPreferences') return ok({ preferences: prefs.value })
    if (body.endpoint === 'saveViewPreferences') {
      prefs.value = body.payload?.preferences
      prefs.writes.push(body.payload?.preferences)
      return ok({ preferences: prefs.value })
    }
    if (body.endpoint === 'article') {
      if (article !== undefined) {
        const payload = typeof article === 'function' ? article(body.payload.itemId) : article
        if (payload !== undefined) return ok(payload)
      }
      return ok({ itemId: body.payload.itemId, title: 'ART', blocks: [{ kind: 'p', text: '正文' }] })
    }
    // 打开即已读：回包必须带完整账目（宿主契约），否则左栏角标会被 undefined 覆盖。
    if (body.endpoint === 'markRead' || body.endpoint === 'unmarkRead') {
      const ids = Array.isArray(body.payload?.itemIds) ? body.payload.itemIds : []
      for (const id of ids) {
        const entry = storedItems.find((candidate) => candidate.id === id)
        if (entry !== undefined) entry.readAt = body.endpoint === 'markRead' ? '2026-11-22T00:00:00.000Z' : undefined
      }
      return ok({ ...overviewNow(), changed: ids.length })
    }
    if (body.endpoint === 'overview' || body.endpoint === 'refresh') return ok(overviewNow())
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
  let unmounted = false
  /** 关面板但保留 store / JSDOM（R11 05 的「重开面板」用例要再挂一次）。 */
  const unmount = async () => {
    if (cleaned || unmounted) return
    unmounted = true
    reactRoot.unmount()
    await settle()
  }
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (!unmounted) { unmounted = true; reactRoot.unmount() }
    dom.window.close()
    for (const key of Object.keys(globalSnapshot)) {
      try { globalThis[key] = globalSnapshot[key] } catch (error) { console.warn('[settings-page-dom] 全局还原失败：', key, error) }
    }
  }
  liveCleanups.push(cleanup)
  const $ = (selector) => win.document.querySelector(selector)
  /** 预演前后的条目与读态快照：C19 要求「逐条不变」，所以读态一起带上。 */
  const itemsNow = () => storedItems.map((entry) => ({ id: entry.id, readAt: entry.readAt, starred: entry.starred === true, keptUnread: entry.keptUnread === true }))
  return { win, store, requests, press, settle, waitFor, cleanup, unmount, $, itemsNow, prefs }
}


/**
 * 数值行的**结构判据**（S3）：只按节点种类断言，不用词表。
 *
 * 原因：D16 撤掉的是「来源层」，不是某些词。旧断言 `/本页覆盖|插件配置|默认值|清除本页设置/`
 * 会把合法帮助文案（例如以后写「默认值」三个字）一起误杀，却抓不到一个换了措辞的来源标签。
 * 这里改为：行内每个元素必须是白名单里的一类（名称 / 输入 / 单位 / 帮助 / 反馈），且没有
 * 链接与来源/单项清除锚点。动作按钮只允许出现在调用方明确允许的行（清理天数）。
 */
const SETTING_ROW_ALLOWED_CLASSES = new Set([
  'dsh-rss-settings-label',   // 名称
  'dsh-rss-settings-input',   // 输入
  'dsh-rss-settings-unit',    // 单位
  'dsh-rss-settings-help',    // 帮助
  'dsh-rss-settings-hint',    // 帮助（毫秒旁注）
  'dsh-rss-settings-saved',   // 反馈（已保存 ✓）
  'dsh-rss-settings-error',   // 反馈（就地红字）
])

function assertNumberRowShape(row, { key, allowAction = false } = {}) {
  const label = row.querySelector('.dsh-rss-settings-label')
  assert.ok(label !== null, key + ' 行必须有名称节点')
  assert.equal(label.children.length, 0, key + ' 的名称节点里不许再嵌来源标签 / 控件')
  assert.equal(row.querySelector('a'), null, key + ' 行内不许有链接')
  assert.equal(row.querySelector('[data-rss-setting-source]'), null, key + ' 行内不许有来源标签')
  assert.equal(row.querySelector('[data-rss-setting-clear]'), null, key + ' 行内不许有单项清除控件')
  for (const child of [...row.children]) {
    if (child.tagName === 'BUTTON') {
      assert.equal(allowAction, true, key + ' 行内不该有按钮（只有清理天数行带动作）')
      continue
    }
    const classes = [...child.classList]
    assert.equal(classes.some((name) => SETTING_ROW_ALLOWED_CLASSES.has(name)), true,
      key + ' 行内出现非白名单节点：<' + child.tagName.toLowerCase() + ' class="' + child.className + '">')
  }
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

test('R11 01 设置页骨架：工具栏进入、标题与返回按钮、分区按 D13 顺序（R7 02 插入「翻译」）、首行只读值', skip, async () => {
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
  assert.deepEqual(sections, ['fetch', 'display', 'translate', 'rsshub', 'feedOrder', 'agent', 'about'],
    '六分区必须按 D13 + R8a 的顺序（RSSHub 在「显示」之后、「Agent 说明」之前）')
  const row = h.$('[data-rss-setting="refreshFeedsPerRound"]')
  assert.ok(row !== null, '第一个分区里必须有「每次刷新抓取源数」这一行')
  assert.equal(row.querySelector('.dsh-rss-settings-label')?.textContent, '每次刷新抓取源数')
  // R11 02：这一行从只读值变成输入框，初值必须显示宿主下发的生效值。
  const input = row.querySelector('[data-rss-setting-input="refreshFeedsPerRound"]')
  assert.ok(input !== null, '第一个参数必须有输入框（02 票把只读改成可写）')
  assert.equal(input.value, '7', '输入框初值必须是宿主下发的生效值')
  // D16：行内只有名称 / 输入 / 单位 / 帮助 / 反馈这几类节点（结构判据，不用词表）。
  assertNumberRowShape(row, { key: 'refreshFeedsPerRound' })
})

test('R11 D14③ 订阅源顺序：只有说明与「去订阅管理页」，不复制排序控件（D15）', skip, async () => {
  const h = await mount()
  try {
    await openSettings(h)
    const section = h.$('[data-rss-settings-section="feedOrder"]')
    assert.ok(section !== null, '「订阅源顺序」分区必须存在')
    assert.match(section.textContent ?? '', /订阅源的先后顺序在订阅管理页调整/, '分区必须有一行说明指针')
    const button = section.querySelector('[data-rss-go-feeds]')
    assert.ok(button !== null, '分区必须有「去订阅管理页」按钮')
    assert.equal((button.textContent ?? '').trim(), '去订阅管理页', '按钮文案是验收项')
    // D15：设置页不复制 ↑/↓ 控件，也不另存排序状态。
    assert.equal(section.querySelector('[data-rss-feed-order-up]'), null, '设置页不该有上移按钮')
    assert.equal(section.querySelector('[data-rss-feed-order-down]'), null, '设置页不该有下移按钮')
    assert.equal(section.querySelector('[data-rss-feed-order-list]'), null, '设置页不该渲染可排序列表')
    assert.deepEqual([...section.querySelectorAll('ul, ol')].map((node) => node.tagName), [], '不该出现列表容器')
    button.click()
    await h.settle()
    assert.equal(h.store.get().view, 'feeds', '按钮必须走既有 toggleFeeds 进入订阅管理页')
  } finally {
    h.cleanup()
  }
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

// ── R11 03：其余三个参数（spec §4.1 / D9–D11 / D14.2，验收 A1–A2、A6–A7、C14、C16）─────
//
// 这一组钉三件事：①三行都必须是「名称 + 一句帮助 + 输入框 + 单位」；
// ②毫秒 ↔ 分钟不做假换算 —— 展示值是 `String(ms / 60000)`，只有非整分钟才显示真实毫秒；
// ③三个键的本地校验与 02 同一条路（零请求、红字、输入保留），范围来自 settings-schema。

/** 取一个设置行（顺带断言存在，缺行时给出可读的失败原因）。 */
function rowOf(h, key) {
  const row = h.$('[data-rss-setting="' + key + '"]')
  assert.ok(row !== null, '设置页必须有 ' + key + ' 这一行')
  return row
}

/** 打开设置页并断言三行的标签 / 单位 / 输入框初值。 */
async function openWith(effective) {
  const settings = {
    effective: { ...TUNABLE_DEFAULTS, ...effective },
    defaults: { ...TUNABLE_DEFAULTS },
  }
  const h = await mount({ settings })
  await openSettings(h)
  return h
}

test('R11 03 三行结构：名称 + 一句帮助 + 输入框 + 单位（清理天数行带「立即清理」）', async () => {
  const h = await openWith({ refreshConcurrency: 12, cleanupAfterDays: 400 })
  try {
    const expected = [
      { key: 'refreshConcurrency', label: '抓取并发', unit: '个', value: '12' },
      { key: 'minRefreshIntervalMs', label: '自动刷新间隔', unit: '分钟', value: '10' },
      { key: 'cleanupAfterDays', label: '清理天数', unit: '天', value: '400' },
    ]
    for (const entry of expected) {
      const row = rowOf(h, entry.key)
      assert.equal(row.querySelector('.dsh-rss-settings-label')?.textContent, entry.label,
        entry.key + ' 的名称')
      assert.equal(row.querySelector('.dsh-rss-settings-input')?.value, entry.value,
        entry.key + ' 的输入框初值必须是宿主下发的生效值')
      assert.equal(row.querySelector('.dsh-rss-settings-unit')?.textContent, entry.unit,
        entry.key + ' 的单位')
      const helps = [...row.querySelectorAll('.dsh-rss-settings-help')]
      assert.equal(helps.length, 1, entry.key + ' 行内只保留一句帮助（D14.2）')
      assert.ok((helps[0].textContent ?? '').length > 0, entry.key + ' 的帮助不能为空')
      assert.ok((row.querySelector('.dsh-rss-settings-input')?.getAttribute('title') ?? '').length > 0,
        entry.key + ' 的详细语义必须放在 input 的 title 里')
      if (entry.key === 'cleanupAfterDays') {
        // R11 04：只有「清理天数」这一行带动作按钮（阈值与动作是同一件事，D27）。
        assert.deepEqual([...row.querySelectorAll('button')].map((button) => button.textContent), ['立即清理'],
          '清理天数行必须有且只有「立即清理」')
      } else {
        assert.equal(row.querySelector('button'), null, entry.key + ' 行内不该有按钮（清理按钮只属于清理天数行）')
      }
      assertNumberRowShape(row, { key: entry.key, allowAction: entry.key === 'cleanupAfterDays' })
    }
    // 票据指定文案（逐字）。
    assert.equal(h.$('[data-rss-setting="refreshFeedsPerRound"] .dsh-rss-settings-help')?.textContent,
      '0 = 抓全部源（源多时一轮会很慢）', '第一行的帮助文案是验收项')
    assert.match(h.$('[data-rss-setting="cleanupAfterDays"]')?.textContent ?? '',
      /只清理早于这个天数的已读条目（未星标、未保持未读）/, '清理天数的帮助文案是验收项')
  } finally {
    h.cleanup()
  }
})

test('R11 03 分钟展示：String(ms/60000) 最短精确表示，只有非整分钟才显示真实毫秒', async () => {
  // 600000 = 10 分钟整：显示 "10"，不显示「= 600000 ms」的噪音。
  const whole = await openWith({ minRefreshIntervalMs: 600000 })
  assert.equal(whole.$('[data-rss-setting-input="minRefreshIntervalMs"]')?.value, '10')
  assert.equal(whole.$('[data-rss-setting-ms-hint="minRefreshIntervalMs"]'), null,
    '整分钟不许显示毫秒提示')
  whole.cleanup()

  // 90000 = 1.5 分钟：显示 "1.5"，并在输入框下给出真实毫秒。
  const half = await openWith({ minRefreshIntervalMs: 90000 })
  assert.equal(half.$('[data-rss-setting-input="minRefreshIntervalMs"]')?.value, '1.5')
  assert.equal(half.$('[data-rss-setting-ms-hint="minRefreshIntervalMs"]')?.textContent, '= 90000 ms',
    '非整分钟必须显示真实毫秒')
  half.cleanup()

  // 90123 ms：不四舍五入、不补齐（String(90123/60000) 的最短精确表示），毫秒提示用原值。
  const odd = await openWith({ minRefreshIntervalMs: 90123 })
  assert.equal(odd.$('[data-rss-setting-input="minRefreshIntervalMs"]')?.value, '1.50205')
  assert.equal(odd.$('[data-rss-setting-ms-hint="minRefreshIntervalMs"]')?.textContent, '= 90123 ms')
  odd.cleanup()
})

test('R11 03 分钟保存：Math.round(分钟 × 60000)，0 = 不节流，且 10 分钟不会被存成别的数', async () => {
  const h = await openWith({ minRefreshIntervalMs: 600000 })
  try {
    const input = h.$('[data-rss-setting-input="minRefreshIntervalMs"]')
    input.focus()
    setControlValue(h.win, input, '1.5')
    input.blur()
    await waitForSaved(h, 'minRefreshIntervalMs')
    assert.deepEqual(h.requests.filter((entry) => entry.endpoint === 'saveSettings').map((entry) => entry.payload),
      [{ patch: { minRefreshIntervalMs: 90000 } }], '1.5 分钟必须保存成 90000 ms')

    input.focus()
    setControlValue(h.win, input, '0')
    input.blur()
    await h.waitFor(() => h.store.get().settings?.effective.minRefreshIntervalMs === 0,
      { label: '0 分钟保存为 0 ms' })
    assert.deepEqual(h.requests.filter((entry) => entry.endpoint === 'saveSettings').map((entry) => entry.payload),
      [{ patch: { minRefreshIntervalMs: 90000 } }, { patch: { minRefreshIntervalMs: 0 } }],
      '0 = 不节流，必须原样存 0')
    assert.equal(h.$('[data-rss-setting-ms-hint="minRefreshIntervalMs"]'), null,
      '0 是整分钟，不该出现毫秒提示')

    // 上限 1440 分钟 = 86400000 ms：分钟换算在边界上也要精确。
    input.focus()
    setControlValue(h.win, input, '1440')
    input.blur()
    await h.waitFor(() => h.store.get().settings?.effective.minRefreshIntervalMs === 86400000,
      { label: '1440 分钟保存为 86400000 ms' })
    assert.deepEqual(h.requests.filter((entry) => entry.endpoint === 'saveSettings').map((entry) => entry.payload).at(-1),
      { patch: { minRefreshIntervalMs: 86400000 } }, '1440 分钟必须保存成 86400000 ms')
  } finally {
    h.cleanup()
  }
})

test('R11 03 分钟输入允许省略整数位/小数位：.5 → 30000 ms，10. → 600000 ms（D11）', async () => {
  const h = await openWith({ minRefreshIntervalMs: 600000 })
  try {
    const input = h.$('[data-rss-setting-input="minRefreshIntervalMs"]')
    input.focus()
    setControlValue(h.win, input, '.5')
    input.blur()
    await waitForSaved(h, 'minRefreshIntervalMs')
    assert.deepEqual(h.requests.filter((entry) => entry.endpoint === 'saveSettings').map((entry) => entry.payload),
      [{ patch: { minRefreshIntervalMs: 30000 } }], '.5 分钟必须保存成 30000 ms')

    input.focus()
    setControlValue(h.win, input, '10.')
    input.blur()
    await h.waitFor(() => h.store.get().settings?.effective.minRefreshIntervalMs === 600000,
      { label: '10. 分钟保存为 600000 ms' })
    assert.deepEqual(h.requests.filter((entry) => entry.endpoint === 'saveSettings').map((entry) => entry.payload).at(-1),
      { patch: { minRefreshIntervalMs: 600000 } }, '10. 分钟必须保存成 600000 ms')
  } finally {
    h.cleanup()
  }
})

test('R11 03 未编辑不重写：聚焦又失焦不发请求，改写成等价写法（10 → 10.0）也不写盘', async () => {
  const h = await openWith({})
  try {
    for (const key of ['refreshFeedsPerRound', 'refreshConcurrency', 'minRefreshIntervalMs', 'cleanupAfterDays']) {
      const input = h.$('[data-rss-setting-input="' + key + '"]')
      input.focus()
      input.blur()
    }
    const minutes = h.$('[data-rss-setting-input="minRefreshIntervalMs"]')
    minutes.focus()
    setControlValue(h.win, minutes, '10.0')
    minutes.blur()
    await h.settle()
    assert.equal(h.requests.filter((entry) => entry.endpoint === 'saveSettings').length, 0,
      '没有真正改变数值时不许凭空写一条覆盖（稀疏覆盖的前提）')
    assert.equal(h.store.get().settings.effective.minRefreshIntervalMs, 600000)
  } finally {
    h.cleanup()
  }
})

test('R11 03 并发与清理天数保存：各发一次只带该键的 patch', async () => {
  const h = await openWith({})
  try {
    const concurrency = h.$('[data-rss-setting-input="refreshConcurrency"]')
    concurrency.focus()
    setControlValue(h.win, concurrency, '12')
    concurrency.blur()
    await waitForSaved(h, 'refreshConcurrency')

    const days = h.$('[data-rss-setting-input="cleanupAfterDays"]')
    days.focus()
    setControlValue(h.win, days, '400')
    days.blur()
    await waitForSaved(h, 'cleanupAfterDays')

    assert.deepEqual(h.requests.filter((entry) => entry.endpoint === 'saveSettings').map((entry) => entry.payload),
      [{ patch: { refreshConcurrency: 12 } }, { patch: { cleanupAfterDays: 400 } }],
      '每次提交只带被改的那一个键（与 02 同一条串行保存路径）')
    assert.equal(h.store.get().settings.effective.refreshConcurrency, 12)
    assert.equal(h.store.get().settings.effective.cleanupAfterDays, 400)
  } finally {
    h.cleanup()
  }
})

test('R11 03 三行非法值：就地红字 + 零请求 + 输入保留（范围读 settings-schema）', async () => {
  const h = await openWith({})
  try {
    const cases = [
      { key: 'refreshConcurrency', bad: ['0', '33', '1.5'], pattern: /1–32 的整数/ },
      { key: 'minRefreshIntervalMs', bad: ['-1', '1440.1', 'abc'], pattern: /0–1440 的分钟数/ },
      { key: 'cleanupAfterDays', bad: ['0', '-1', '3651', '1.5'], pattern: /1–3650 的整数/ },
    ]
    for (const entry of cases) {
      const input = h.$('[data-rss-setting-input="' + entry.key + '"]')
      for (const bad of entry.bad) {
        input.focus()
        setControlValue(h.win, input, bad)
        input.blur()
        await h.waitFor(() => h.$('[data-rss-setting-error="' + entry.key + '"]') !== null,
          { label: entry.key + ' 对 ' + bad + ' 的就地红字' })
        assert.match(h.$('[data-rss-setting-error="' + entry.key + '"]').textContent, entry.pattern,
          entry.key + ' 的错误文案要按该键自己的单位说清范围')
        assert.equal(h.requests.filter((request) => request.endpoint === 'saveSettings').length, 0,
          '非法值必须零请求：' + entry.key + '=' + bad)
        assert.equal(input.value, bad, '非法输入必须保留，不许悄悄改值：' + bad)
      }
    }
    assert.equal(h.store.get().settings.effective.refreshConcurrency, 5, '本地校验失败不许改权威值')
    assert.equal(h.store.get().settings.effective.minRefreshIntervalMs, 600000)
    assert.equal(h.store.get().settings.effective.cleanupAfterDays, 30)
  } finally {
    h.cleanup()
  }
})

// ── R11 07：恢复默认（spec D28 / D14.2，验收 C15）──────────────────────────────────
//
// 客户端只发一个动作、不做删/写判断：确认框里列出的 N 项来自**当前快照**的 effective vs defaults，
// 与宿主逐键规则同源 —— 生效值不等于默认值的项一定会在恢复时变化。确认后只发一次
// `saveSettings({ resetToDefaults: true })`，回包即权威值；N 也是提示里显示的那个数。

test('R11 07 恢复默认确认框：列出将变化的项与目标值，取消零写并还焦点', skip, async () => {
  const h = await mount({
    settings: {
      // 900000 ms = 15 分钟：确认框按界面单位（分钟）展示目标值，不暴露毫秒。
      effective: { ...TUNABLE_DEFAULTS, refreshConcurrency: 8, minRefreshIntervalMs: 900000, cleanupAfterDays: 45 },
      defaults: { ...TUNABLE_DEFAULTS },
    },
  })
  try {
    await openSettings(h)
    const button = h.$('[data-rss-reset-defaults]')
    assert.ok(button !== null, '抓取与清理分区末尾必须有「恢复默认」按钮')
    assert.equal(button.disabled, false, '有变化项时按钮可用')
    button.click()
    await h.waitFor(() => h.$('[data-rss-reset-confirm]') !== null, { label: '恢复默认确认框打开' })

    const dialog = h.$('[data-rss-reset-confirm]')
    assert.equal(dialog.getAttribute('role'), 'dialog', '确认框必须是 dialog')
    assert.equal(dialog.getAttribute('aria-modal'), 'true', '确认框必须是模态语义')
    assert.match(dialog.textContent ?? '', /抓取并发 8 → 5/, '确认框要列出变化的项与目标值')
    assert.match(dialog.textContent ?? '', /自动刷新间隔 15 → 10/, '分钟单位按界面单位展示，不出现 900000')
    assert.match(dialog.textContent ?? '', /清理天数 45 → 30/)
    assert.doesNotMatch(dialog.textContent ?? '', /每次刷新抓取源数/, '没变化的项不该出现在确认框里')

    h.$('[data-rss-reset-cancel]').click()
    await h.waitFor(() => h.$('[data-rss-reset-confirm]') === null, { label: '取消后确认框关闭' })
    assert.equal(h.requests.filter((entry) => entry.endpoint === 'saveSettings').length, 0,
      '取消必须零写：不发任何 saveSettings')
    assert.equal(h.win.document.activeElement, button, '确认框关闭后焦点回到「恢复默认」按钮')
    assert.equal(h.store.get().settings.effective.refreshConcurrency, 8, '取消后生效值不变')
  } finally {
    h.cleanup()
  }
})

test('R11 07 恢复默认确认：一次 reset 请求、四项生效值全默认、提示「已恢复 N 项默认值」', skip, async () => {
  const h = await mount({
    settings: {
      effective: { ...TUNABLE_DEFAULTS, refreshConcurrency: 8, minRefreshIntervalMs: 900000, cleanupAfterDays: 45 },
      defaults: { ...TUNABLE_DEFAULTS },
    },
  })
  try {
    await openSettings(h)
    h.$('[data-rss-reset-defaults]').click()
    await h.waitFor(() => h.$('[data-rss-reset-confirm]') !== null, { label: '恢复默认确认框打开' })
    h.$('[data-rss-reset-ok]').click()
    await h.waitFor(() => h.store.get().settings?.effective.cleanupAfterDays === 30
      && h.store.get().settings?.effective.refreshConcurrency === 5,
    { label: '恢复默认成功后的回包生效值' })
    await h.waitFor(() => h.$('[data-rss-reset-confirm]') === null, { label: '成功后确认框关闭' })

    const saves = h.requests.filter((entry) => entry.endpoint === 'saveSettings')
    assert.deepEqual(saves.map((entry) => entry.payload), [{ resetToDefaults: true }],
      '确认后必须一次请求完成，且入参只有 resetToDefaults（客户端不做逐项 patch）')
    assert.deepEqual(h.store.get().settings.effective, TUNABLE_DEFAULTS, '四项生效值必须全部等于默认值')
    assert.equal(h.store.get().notice, '已恢复 3 项默认值', 'N 是实际发生变化的项数（这里三项不是默认）')
    assert.ok([...h.win.document.querySelectorAll('[role="status"]')]
      .some((node) => node.textContent === '已恢复 3 项默认值'), '提示必须可见（全局 notice）')
    assert.equal(h.$('[data-rss-reset-defaults]').disabled, true, '恢复后四项全默认 ⇒ 按钮转为禁用')
  } finally {
    h.cleanup()
  }
})

test('R11 07 恢复默认：四项本来就是默认值时按钮禁用，点击不弹框也不写', skip, async () => {
  const h = await mount({
    settings: { effective: { ...TUNABLE_DEFAULTS }, defaults: { ...TUNABLE_DEFAULTS } },
  })
  try {
    await openSettings(h)
    const button = h.$('[data-rss-reset-defaults]')
    assert.ok(button !== null)
    assert.equal(button.disabled, true, 'N = 0 时按钮必须禁用（spec D28）')
    button.click()
    await h.settle()
    assert.equal(h.$('[data-rss-reset-confirm]'), null, '禁用按钮不许弹出确认框')
    assert.equal(h.requests.filter((entry) => entry.endpoint === 'saveSettings').length, 0, 'N = 0 时零写')
  } finally {
    h.cleanup()
  }
})

test('R11 07 恢复默认失败：确认框保留并显示错误，生效值不变', skip, async () => {
  const h = await mount({
    settings: {
      effective: { ...TUNABLE_DEFAULTS, cleanupAfterDays: 45 },
      defaults: { ...TUNABLE_DEFAULTS },
    },
    saveSettings: async (payload) => (payload?.resetToDefaults === true
      ? { error: { code: 'write-failed', message: '磁盘已满' } }
      : undefined),
  })
  try {
    await openSettings(h)
    h.$('[data-rss-reset-defaults]').click()
    await h.waitFor(() => h.$('[data-rss-reset-confirm]') !== null, { label: '恢复默认确认框打开' })
    h.$('[data-rss-reset-ok]').click()
    await h.waitFor(() => h.$('[data-rss-reset-error]') !== null, { label: '恢复默认失败的就地错误' })
    assert.match(h.$('[data-rss-reset-error]').textContent ?? '', /磁盘已满/, '确认框里要保留失败原因')
    assert.ok(h.$('[data-rss-reset-confirm]') !== null, '失败时确认框不关闭，用户可重试')
    assert.equal(h.store.get().settings.effective.cleanupAfterDays, 45, '失败不许改权威生效值')
    assert.match(h.store.get().error ?? '', /恢复默认失败：.*磁盘已满/, '顶部错误条也要能看见失败')
    assert.equal(h.requests.filter((entry) => entry.endpoint === 'saveSettings').length, 1, '只尝试一次，不自动重试')
  } finally {
    h.cleanup()
  }
})

// ── R15 01：RSSHub 实例池（spec §4.1.1 / §4.1.2 / §4.1.6 / A5–A6）────────────
//
// 这一组钉的是设置页的**用户动作**：增 / 删 / 上下移 / 测试连接 / 推荐卡片。
// 之前单地址输入框的验收项（失焦保存、恢复默认清空）已被实例池替代 —— 旧路径 `rsshubBase`
// 只保留在 settings.json 的迁移读取里，界面不再展示第二套地址状态。

const RECOMMENDED_HUBS = ['https://hub.slarker.me', 'https://rsshub.rss.tips', 'https://rsshub.cups.moe']

/** 宿主读端点的同一形状（子集）：测试只关心 instances。 */
function rsshubPoolOf(instances) {
  return { instances, hiddenNamespaces: [], hideNsfw: true }
}

test('R15 01 实例池：空池展示 3 个推荐实例但默认零写入，且说明未配置的后果', async () => {
  const h = await mount()
  try {
    await openSettings(h)
    const section = h.$('[data-rss-settings-section="rsshub"]')
    assert.ok(section !== null, '「RSSHub」分区必须存在')
    assert.equal(section.querySelectorAll('[data-rss-rsshub-instance]').length, 0, '空池没有实例行')

    const card = section.querySelector('[data-rss-rsshub-recommend]')
    assert.ok(card !== null, '空池必须展示「推荐实例」卡片')
    for (const url of RECOMMENDED_HUBS) {
      assert.match(card.textContent ?? '', new RegExp(url.replace(/\./g, '\\.')), '推荐卡片必须列出 ' + url)
    }
    const enable = card.querySelector('[data-rss-rsshub-recommend-enable]')
    assert.ok(enable !== null, '推荐卡片必须有「启用这 3 个」')
    assert.equal(enable.disabled, false, '空池时推荐卡片可点')
    assert.equal(h.requests.filter((entry) => entry.endpoint === 'saveRsshubSettings').length, 0,
      '打开设置页不许自动写入推荐实例（未配置 = 零请求的隐私边界）')
    assert.match(section.textContent ?? '', /未配置时 RSSHub 候选不出现/, '必须说明未配置时功能关闭')
    assert.equal(section.querySelector('[data-rss-rsshub-reset]').disabled, true, '空池时清空按钮禁用')
  } finally {
    h.cleanup()
  }
})

test('R15 01 读侧告警：坏项被宿主丢弃时在分区内说明（不把整页打成错误）', async () => {
  const warning = '已忽略 1 条无效项（网络地址只支持 http(s) 源站）'
  const h = await mount({ rsshubPool: { ...rsshubPoolOf(['https://ok.example']), warning } })
  try {
    await openSettings(h)
    const note = h.$('[data-rss-rsshub-warning]')
    assert.ok(note !== null, '有告警时必须显示一行说明')
    assert.match(note.textContent ?? '', /已忽略 1 条无效项/)
    assert.equal(h.store.get().settingsError, undefined, '告警不是整页错误')
  } finally {
    h.cleanup()
  }
})

test('R15 01 添加实例：保存归一后的地址并显示「已保存 ✓」，输入框清空', async () => {
  const h = await mount()
  try {
    await openSettings(h)
    const input = h.$('[data-rss-rsshub-add-input]')
    assert.ok(input !== null, '必须有「添加实例」输入框')
    setControlValue(h.win, input, ' https://rsshub.example/ ')
    h.$('[data-rss-rsshub-add]').click()
    await h.waitFor(() => h.store.get().rsshubSettings?.instances.length === 1, { label: '实例池保存回包' })

    const saves = h.requests.filter((entry) => entry.endpoint === 'saveRsshubSettings')
    assert.deepEqual(saves.map((entry) => entry.payload), [{ instances: ['https://rsshub.example'] }],
      '保存的是归一后的地址（trim / 去尾斜杠）')
    assert.equal(h.$('[data-rss-rsshub-instance="0"] [data-rss-rsshub-instance-url]').textContent,
      'https://rsshub.example', '新实例必须出现在列表里')
    assert.ok(h.$('[data-rss-rsshub-saved]') !== null, '成功后显示「已保存 ✓」')
    assert.equal(input.value, '', '成功后输入框清空')
  } finally {
    h.cleanup()
  }
})

test('R15 01 非法地址：就地红字 + 零请求 + 输入保留', async () => {
  const h = await mount()
  try {
    await openSettings(h)
    const input = h.$('[data-rss-rsshub-add-input]')
    for (const bad of ['https://rsshub.example/api', 'ftp://rsshub.example', 'not a url', '']) {
      setControlValue(h.win, input, bad)
      h.$('[data-rss-rsshub-add]').click()
      await h.waitFor(() => h.$('[data-rss-rsshub-draft-error]') !== null, { label: bad + ' 的就地红字' })
      assert.equal(h.requests.filter((entry) => entry.endpoint === 'saveRsshubSettings').length, 0,
        '非法地址必须零请求：' + bad)
      assert.equal(input.value, bad, '非法输入必须保留')
    }
    assert.deepEqual(h.store.get().rsshubSettings?.instances, [], '本地校验失败不许改权威值')
  } finally {
    h.cleanup()
  }
})

test('R15 01 上限：已有 5 条时添加按钮禁用，界面说明「最多 5 个」（A6 的界面侧）', async () => {
  const five = Array.from({ length: 5 }, (_, index) => 'https://hub' + index + '.example')
  const h = await mount({ rsshubPool: rsshubPoolOf(five) })
  try {
    await openSettings(h)
    const section = h.$('[data-rss-settings-section="rsshub"]')
    assert.equal(section.querySelectorAll('[data-rss-rsshub-instance]').length, 5)
    assert.equal(section.querySelector('[data-rss-rsshub-add]').disabled, true, '满 5 条后不许再加第 6 条')
    assert.match(section.textContent ?? '', /最多 5 个/, '必须说明上限')
  } finally {
    h.cleanup()
  }
})

test('R15 01 排序与删除：上移 / 下移 / 删除都保存整份新顺序', async () => {
  const pool = ['https://a.example', 'https://b.example', 'https://c.example']
  const h = await mount({ rsshubPool: rsshubPoolOf(pool) })
  try {
    await openSettings(h)
    h.$('[data-rss-rsshub-down="0"]').click()
    await h.waitFor(() => h.store.get().rsshubSettings?.instances[0] === 'https://b.example', { label: '下移生效' })
    let saves = h.requests.filter((entry) => entry.endpoint === 'saveRsshubSettings')
    assert.deepEqual(saves.at(-1).payload, { instances: ['https://b.example', 'https://a.example', 'https://c.example'] },
      '下移只交换相邻两项，整份数组按新顺序提交')

    h.$('[data-rss-rsshub-remove="1"]').click()
    await h.waitFor(() => h.store.get().rsshubSettings?.instances.length === 2, { label: '删除生效' })
    saves = h.requests.filter((entry) => entry.endpoint === 'saveRsshubSettings')
    assert.deepEqual(saves.at(-1).payload, { instances: ['https://b.example', 'https://c.example'] },
      '删除后仍是整份数组，不留空洞')
    assert.equal(h.$('[data-rss-rsshub-instance="2"]'), null, '第三行必须消失')
  } finally {
    h.cleanup()
  }
})

test('R15 01 测试连接：探的是该行实例，结果原地展示且不改保存值', async () => {
  const h = await mount({ rsshubPool: rsshubPoolOf(['https://a.example', 'https://b.example']) })
  try {
    await openSettings(h)
    h.$('[data-rss-rsshub-test="1"]').click()
    await h.waitFor(() => h.$('[data-rss-rsshub-result]') !== null, { label: '测试结果上屏' })
    const calls = h.requests.filter((entry) => entry.endpoint === 'testRsshub')
    assert.deepEqual(calls.map((entry) => entry.payload), [{ base: 'https://b.example' }],
      '探活只把这一行的地址交给宿主，浏览器不直连实例')
    assert.match(h.$('[data-rss-rsshub-result]').textContent, /测试通过/)
    assert.equal(h.requests.filter((entry) => entry.endpoint === 'saveRsshubSettings').length, 0,
      '探活不是保存：不许写盘')
  } finally {
    h.cleanup()
  }
})

test('R15 01 测试连接失败：把宿主的可读原因原地展示', async () => {
  const h = await mount({
    rsshubPool: rsshubPoolOf(['https://rsshub.example']),
    testRsshub: async () => ({ passed: false, message: '连接失败：HTTP 500' }),
  })
  try {
    await openSettings(h)
    h.$('[data-rss-rsshub-test="0"]').click()
    await h.waitFor(() => h.$('[data-rss-rsshub-result]') !== null, { label: '失败结果上屏' })
    assert.match(h.$('[data-rss-rsshub-result]').textContent, /HTTP 500/, '失败原因必须可读')
    assert.deepEqual(h.store.get().rsshubSettings?.instances, ['https://rsshub.example'], '探活不改配置')
  } finally {
    h.cleanup()
  }
})

test('R15 01 推荐卡片「启用这 3 个」：点按才一次写入推荐的 3 条', async () => {
  const h = await mount()
  try {
    await openSettings(h)
    h.$('[data-rss-rsshub-recommend-enable]').click()
    await h.waitFor(() => h.store.get().rsshubSettings?.instances.length === 3, { label: '推荐实例写入' })
    const saves = h.requests.filter((entry) => entry.endpoint === 'saveRsshubSettings')
    assert.deepEqual(saves.map((entry) => entry.payload), [{ instances: RECOMMENDED_HUBS }],
      '一次写入 3 个推荐实例，顺序与卡片一致')
    assert.equal(h.$('[data-rss-rsshub-instance="0"] [data-rss-rsshub-instance-url]').textContent,
      RECOMMENDED_HUBS[0], '写入后列表立刻显示')
  } finally {
    h.cleanup()
  }
})

test('R15 01 RSSHub 分区：官方实例列表链接指向 docs.rsshub.app，新窗口打开且断开 opener', async () => {
  const h = await mount()
  try {
    await openSettings(h)
    const note = h.$('[data-rss-rsshub-instances]')
    assert.ok(note !== null, 'RSSHub 分区必须有官方实例列表的说明行')
    const link = note.querySelector('a')
    assert.ok(link !== null, '说明行里必须有「官方实例列表」链接')
    assert.equal(link.getAttribute('href'), 'https://docs.rsshub.app/guide/instances', 'href 必须是官方实例文档')
    assert.equal(link.getAttribute('target'), '_blank', '列表在文档站，新窗口打开')
    assert.match(link.getAttribute('rel') ?? '', /noopener/, 'target=_blank 必须带 noopener（rel 里含 noopener）')
    assert.match(note.textContent ?? '', /社区维护/, '必须说明公共实例由社区维护')
    assert.match(note.textContent ?? '', /可能失效/, '必须说明公共实例可能失效')
  } finally {
    h.cleanup()
  }
})

// ── R11 04：手动清理 = 预演 → 确认 → 执行（spec D27–D27.1 / 验收 C19）─────────────
//
// 这一组钉的是**请求顺序与副作用边界**：点一次按钮必须先看到 dryRun 预演（一条都不删），
// C > 0 才有确认框；取消绝不发第二次请求；确认才执行。桩件的 cleanup 分支也按同一条语义
// 实现（见 mount 里的 dryRun 处理）—— 否则测试只能证明「发了两次请求」，证明不了「预演不删」。

/** 一条最小可用条目（形状与 scroll-dom.test.mjs 的 item() 同源）。 */
function item(overrides = {}) {
  return {
    id: 'item-1', feedId: 'f1', feedTitle: '源一', title: '标题',
    link: 'https://example.com/a', readAt: undefined, starred: false,
    fetchedAt: '2026-11-01T00:00:00.000Z', ...overrides,
  }
}

/** 有旧已读、有受保护、有未读的一组条目：只有 old-read 该被清理。 */
function cleanupItems() {
  return [
    item({ id: 'old-read', readAt: '2020-02-01T00:00:00.000Z', summary: 'x'.repeat(2048) }),
    item({ id: 'old-starred', readAt: '2020-02-01T00:00:00.000Z', starred: true }),
    item({ id: 'old-kept', readAt: '2020-02-01T00:00:00.000Z', keptUnread: true }),
    item({ id: 'old-unread', title: '未读旧条目' }),
  ]
}

/** 设置快照：清理天数可指定（确认框文案要显示当前阈值 D）。 */
function settingsWith(cleanupAfterDays) {
  return {
    effective: { ...TUNABLE_DEFAULTS, cleanupAfterDays },
    defaults: { ...TUNABLE_DEFAULTS },
  }
}

test('R11 04 手动清理：预演只算不删，C>0 弹确认框并含条数与阈值', async () => {
  const h = await mount({ items: cleanupItems(), settings: settingsWith(45) })
  try {
    await openSettings(h)
    const before = h.itemsNow()
    const button = h.$('[data-rss-cleanup-now]')
    assert.ok(button !== null, '「清理天数」行右侧必须有「立即清理」按钮')
    button.click()
    await h.waitFor(() => h.$('[data-rss-cleanup-confirm]') !== null, { label: '清理确认框弹出' })

    const cleanups = h.requests.filter((entry) => entry.endpoint === 'cleanup')
    assert.equal(cleanups.length, 1, '点一次按钮只发一次预演请求')
    assert.equal(cleanups[0].payload.dryRun, true, '第一次 cleanup 必须带 dryRun: true（预演）')
    assert.deepEqual(h.itemsNow(), before, '预演前后条目数与读态必须逐条不变')
    assert.equal(h.store.get().view, 'settings', '预演不切视图')

    const text = h.$('[data-rss-cleanup-confirm]').textContent ?? ''
    assert.match(text, /将清理 1 条旧条目/, '确认框必须说清将清理多少条')
    assert.match(text, /45 天/, '确认框必须带上当前阈值 D 天')
    assert.equal(h.$('[data-rss-cleanup-confirm] [role="dialog"]')?.getAttribute('aria-modal'), 'true',
      '确认框必须是 role=dialog + aria-modal（与 MarkAllConfirm 同一约定）')
  } finally {
    h.cleanup()
  }
})

test('R11 04 手动清理：取消不发第二次请求、不删条目、焦点归还「立即清理」', async () => {
  const h = await mount({ items: cleanupItems(), settings: settingsWith(30) })
  try {
    await openSettings(h)
    const before = h.itemsNow()
    const button = h.$('[data-rss-cleanup-now]')
    button.click()
    await h.waitFor(() => h.$('[data-rss-cleanup-confirm]') !== null, { label: '清理确认框弹出' })
    h.$('[data-rss-cleanup-cancel]').click()
    await h.settle()

    assert.equal(h.$('[data-rss-cleanup-confirm]'), null, '取消必须关闭确认框')
    assert.equal(h.requests.filter((entry) => entry.endpoint === 'cleanup').length, 1,
      '取消绝不许发第二次 cleanup 请求')
    assert.deepEqual(h.itemsNow(), before, '取消不删任何条目')
    assert.equal(h.store.get().view, 'settings', '取消后仍在设置页')
    assert.equal(h.win.document.activeElement, button, '确认框关闭后焦点必须回到触发它的「立即清理」')
  } finally {
    h.cleanup()
  }
})

test('R11 04 手动清理：确认后执行第二次请求，状态条显示实际删除与释放量，view 仍是 settings', async () => {
  const h = await mount({ items: cleanupItems(), settings: settingsWith(30) })
  try {
    await openSettings(h)
    const button = h.$('[data-rss-cleanup-now]')
    button.click()
    await h.waitFor(() => h.$('[data-rss-cleanup-confirm]') !== null, { label: '清理确认框弹出' })
    h.$('[data-rss-cleanup-ok]').click()
    await h.waitFor(() => h.requests.filter((entry) => entry.endpoint === 'cleanup').length === 2,
      { label: '确认后的第二次 cleanup 请求' })

    const cleanups = h.requests.filter((entry) => entry.endpoint === 'cleanup')
    assert.equal(cleanups[0].payload.dryRun, true, '第一次仍是预演')
    assert.equal('dryRun' in cleanups[1].payload, false, '第二次执行不许带 dryRun（缺省 = 执行）')
    assert.equal(h.$('[data-rss-cleanup-confirm]'), null, '确认后确认框关闭')
    await h.waitFor(() => (h.store.get().notice ?? '').includes('已清理 1 条旧条目'), { label: '清理结果 notice' })
    const notice = h.store.get().notice ?? ''
    assert.match(notice, /已清理 1 条旧条目/, '状态条必须如实报实际删除条数')
    assert.match(notice, /释放约 2 KB/, '状态条必须带释放量（2048 字符 ≈ 2 KB）')
    await h.waitFor(() => h.store.get().items.every((entry) => entry.id !== 'old-read'),
      { label: '列表重载后不再有已清理条目' })
    assert.equal(h.store.get().view, 'settings', '执行完仍在设置页（不跳走）')
    assert.equal(h.win.document.activeElement, button, '确认后焦点回到「立即清理」')
  } finally {
    h.cleanup()
  }
})

test('R11 04 手动清理：0 条不弹框，直接回报「没有可清理的条目」', async () => {
  const h = await mount({
    items: [item({ id: 'kept', readAt: '2020-02-01T00:00:00.000Z', keptUnread: true }), item({ id: 'unread' })],
    settings: settingsWith(30),
  })
  try {
    await openSettings(h)
    const before = h.itemsNow()
    h.$('[data-rss-cleanup-now]').click()
    await h.waitFor(() => (h.store.get().notice ?? '').includes('没有可清理的条目'), { label: '0 条的结果 notice' })
    assert.match(h.store.get().notice ?? '', /没有可清理的条目/, '0 条必须直接回报，不弹框')
    assert.equal(h.$('[data-rss-cleanup-confirm]'), null, '0 条绝不弹确认框')
    assert.equal(h.requests.filter((entry) => entry.endpoint === 'cleanup').length, 1, '0 条只发一次预演')
    assert.deepEqual(h.itemsNow(), before, '0 条时同样不删任何东西')
    assert.equal(h.store.get().view, 'settings')
  } finally {
    h.cleanup()
  }
})

test('R11 04 手动清理：预演失败走全局 error，不弹框', async () => {
  const h = await mount({
    items: cleanupItems(),
    settings: settingsWith(30),
    cleanupStub: (payload) => payload?.dryRun === true
      ? { error: { code: 'cleanup-failed', message: '模拟预演失败', details: {} } }
      : undefined,
  })
  try {
    await openSettings(h)
    h.$('[data-rss-cleanup-now]').click()
    await h.waitFor(() => h.store.get().error !== undefined, { label: '预演失败的全局 error' })
    assert.match(h.store.get().error ?? '', /模拟预演失败/, '失败必须走全局 error 通道')
    assert.equal(h.$('[data-rss-cleanup-confirm]'), null, '预演失败绝不弹确认框')
    assert.equal(h.requests.filter((entry) => entry.endpoint === 'cleanup').length, 1, '失败后不重试')
    assert.equal(h.store.get().view, 'settings')
  } finally {
    h.cleanup()
  }
})

test('R11 04 手动清理：清理天数正在保存时「立即清理」禁用，保存完成后恢复', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const h = await mount({
    items: cleanupItems(),
    saveSettings: async (payload) => {
      await gate
      return {
        settings: {
          effective: { ...TUNABLE_DEFAULTS, ...payload.patch },
          defaults: { ...TUNABLE_DEFAULTS },
        },
      }
    },
  })
  try {
    await openSettings(h)
    const button = h.$('[data-rss-cleanup-now]')
    assert.equal(button.disabled, false, '空闲时按钮可用')
    const input = h.$('[data-rss-setting-input="cleanupAfterDays"]')
    input.focus()
    setControlValue(h.win, input, '45')
    input.blur()
    await h.waitFor(() => button.disabled === true, { label: '保存期间「立即清理」禁用' })
    assert.equal(button.disabled, true, '阈值正在写盘时不许用旧阈值预演')
    release()
    await h.waitFor(() => button.disabled === false, { label: '保存完成后按钮恢复' })
  } finally {
    h.cleanup()
  }
})

test('R11 P7 确认框 Esc：焦点不在框内时 document 上的 Esc 只关确认框，不退设置页', skip, async () => {
  const h = await mount({ items: cleanupItems(), settings: settingsWith(45) })
  try {
    await openSettings(h)

    // ① 清理确认框：焦点留在触发按钮上（模拟「刚打开、焦点还没进框」的一瞬）。
    h.$('[data-rss-cleanup-now]').click()
    await h.waitFor(() => h.$('[data-rss-cleanup-confirm]') !== null, { label: '清理确认框打开' })
    h.$('[data-rss-cleanup-now]').focus()
    h.win.document.dispatchEvent(new h.win.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }))
    await h.waitFor(() => h.$('[data-rss-cleanup-confirm]') === null, { label: '清理确认框被 Esc 关闭' })
    assert.equal(h.store.get().view, 'settings', '关清理确认框不许顺带退出设置页')

    // ② 恢复默认确认框：同一条窄窗口。
    h.$('[data-rss-reset-defaults]').click()
    await h.waitFor(() => h.$('[data-rss-reset-confirm]') !== null, { label: '恢复默认确认框打开' })
    h.$('[data-rss-reset-defaults]').focus()
    h.win.document.dispatchEvent(new h.win.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true,
    }))
    await h.waitFor(() => h.$('[data-rss-reset-confirm]') === null, { label: '恢复默认确认框被 Esc 关闭' })
    assert.equal(h.store.get().view, 'settings', '关恢复默认确认框不许顺带退出设置页')
  } finally {
    h.cleanup()
  }
})

test('R11 05 工具栏：「更多」整个消失，两个旧功能在设置页都有入口', async () => {
  const h = await mount()
  try {
    await h.settle()
    // 04 把清理搬走后菜单就只剩「显示未读计数」一项；05 再把它搬进设置页，整个 <details> 已无内容。
    const more = [...h.win.document.querySelectorAll('summary')]
      .find((summary) => (summary.textContent ?? '').trim() === '更多')
    // 断言布尔而不是元素本身：jsdom 节点被 util.inspect 展开会拖死整个测试进程（实测 SIGKILL）。
    assert.equal(more === undefined, true, '工具栏「更多」按钮必须整个删除（不是留一个空菜单）')
    assert.equal(h.$('.dsh-rss-settings-panel'), null, '列表视图不应再有「更多」面板')
    assert.equal([...h.win.document.querySelectorAll('button')]
      .some((button) => (button.textContent ?? '').includes('清理旧条目')), false,
    '「更多」里的旧清理入口必须已删除（清理动作只住在设置页）')

    await openSettings(h)
    assert.ok(h.$('[data-rss-setting-checkbox="expandImages"]') !== null, '「默认折叠图片」在设置页')
    assert.ok(h.$('[data-rss-setting-checkbox="showUnread"]') !== null, '「显示未读计数」在设置页')
    assert.ok(h.$('[data-rss-cleanup-now]') !== null, '清理入口在设置页')
  } finally {
    h.cleanup()
  }
})

// ── R11 05：显示区两个开关（spec D14 ② / D27.2 / 验收 C18）────────────────────
//
// 这一组刻意**走真实点击**：开关的价值全在「点一下 → store → 落盘 → 另一个面板 / 左栏 / 标题栏
// 跟着变」这条接线。直调 store 只能证明状态机，证明不了控件真的接上了。

/** 点一下复选框（jsdom 的原生 click 会先切换 checked，再派发 click —— React 的 onChange 靠它）。 */
function clickCheckbox(h, element) {
  element.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
}

const IMAGE_ARTICLE = {
  itemId: 'a', title: 'ART',
  blocks: [
    { kind: 'p', text: '一张图。' },
    { kind: 'img', src: 'https://img.example/one.png', alt: '图一' },
    { kind: 'img', src: 'https://img.example/two.png', alt: '图二' },
  ],
}

test('R11 05 显示区：两个开关带帮助文案，「默认折叠图片」与正文页 Aa 面板双向同步', skip, async () => {
  const h = await mount({ items: [item({ id: 'a' })], article: IMAGE_ARTICLE })
  try {
    await h.settle()
    await openSettings(h)

    const section = h.$('[data-rss-settings-section="display"]')
    assert.ok(section !== null, '分区里的「显示」区必须存在')
    const expand = h.$('[data-rss-setting-checkbox="expandImages"]')
    const unread = h.$('[data-rss-setting-checkbox="showUnread"]')
    assert.ok(expand !== null, '「默认折叠图片」复选框必须在显示区')
    assert.ok(unread !== null, '「显示未读计数」复选框必须在显示区')
    // 一行小字说明自己的作用（票面验收项）
    assert.match(section.textContent, /打开文章时不自动加载图片/, '「默认折叠图片」的帮助文案是验收项')
    assert.match(section.textContent, /左栏与标题栏的未读数字/, '「显示未读计数」的帮助文案是验收项')
    assert.match(section.textContent, /字号 \/ 栏宽 \/ 主题在正文页的 Aa 面板调整/, '显示区末尾要有 Aa 面板指针')
    // 默认 expandImages = true ⇒ 「默认折叠图片」未勾选；showUnread 默认 true ⇒ 勾选
    assert.equal(expand.checked, false, '默认展开图片 ⇒ 「默认折叠图片」开关不勾选')
    assert.equal(unread.checked, true, '默认显示未读计数')

    // 设置页改 → 正文页 Aa 面板同步
    clickCheckbox(h, expand)
    await h.settle()
    assert.equal(h.store.get().reading.expandImages, false, '勾上「默认折叠图片」必须写进同一份 reading')
    const saved = h.requests.filter((entry) => entry.endpoint === 'saveViewPreferences').at(-1)
    assert.ok(saved !== undefined, '改显示开关必须落盘')
    assert.equal(saved.payload.preferences.reading.expandImages, false, '落盘带 reading.expandImages = false')
    assert.equal(saved.payload.preferences.showUnread, true, '整份写必须带上 showUnread')

    h.$('[data-rss-settings-back]').click()
    await h.settle()
    h.press('V', true)
    await h.waitFor(() => h.store.get().view === 'article', { label: '进入正文页' })
    await h.settle()
    const aa = h.$('input[aria-label="默认折叠图片"]')
    assert.ok(aa !== null, '正文页 Aa 面板必须有同一个开关')
    assert.equal(aa.checked, true, '设置页勾上折叠 ⇒ Aa 面板必须同步勾选（同一份状态）')

    // 正文页改 → 设置页同步
    clickCheckbox(h, aa)
    await h.settle()
    assert.equal(h.store.get().reading.expandImages, true, 'Aa 面板取消折叠 ⇒ reading.expandImages = true')
    h.press('Escape')
    await h.settle()
    assert.equal(h.store.get().view, 'list', '前置：Esc 回列表')
    await openSettings(h)
    assert.equal(h.$('[data-rss-setting-checkbox="expandImages"]').checked, false,
      'Aa 面板取消折叠 ⇒ 设置页开关必须同步取消勾选（反向同步）')
  } finally {
    h.cleanup()
  }
})

test('R11 05 取消「默认折叠图片」后打开含图文章：图片直接出现，不需要展开动作', skip, async () => {
  const prefs = {
    value: {
      navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true, showUnread: true,
      reading: { fontSize: 16, lineWidth: 760, theme: 'auto', expandImages: false },
    },
    writes: [],
  }
  const h = await mount({ items: [item({ id: 'a' })], article: IMAGE_ARTICLE, prefs })
  try {
    await h.settle()
    assert.equal(h.store.get().reading.expandImages, false, '前置：偏好恢复成折叠')

    h.press('V', true)
    await h.waitFor(() => h.store.get().view === 'article', { label: '进入正文页' })
    await h.settle()
    assert.equal(h.win.document.querySelectorAll('article img').length, 0, '折叠态不许渲染 <img>')
    assert.equal(h.win.document.querySelectorAll('[data-rss-image-fold]').length, 1,
      '折叠态要有一条提示（说明这里确实有图被折叠了）')

    h.press('Escape')
    await h.settle()
    await openSettings(h)
    const expand = h.$('[data-rss-setting-checkbox="expandImages"]')
    assert.equal(expand.checked, true, '前置：当前是折叠偏好 ⇒ 开关勾选')
    clickCheckbox(h, expand)
    await h.settle()
    assert.equal(h.store.get().reading.expandImages, true, '取消勾选 ⇒ 偏好回到展开')

    h.$('[data-rss-settings-back]').click()
    await h.settle()
    h.press('V', true)
    await h.waitFor(() => h.store.get().view === 'article', { label: '再次进入正文页' })
    await h.settle()
    assert.equal(h.win.document.querySelectorAll('article img').length, 2,
      '取消勾选后打开含图文章：图片必须直接出现（两张都渲染）')
    assert.equal(h.win.document.querySelectorAll('[data-rss-image-fold]').length, 0,
      '图片直接出现 = 没有任何折叠提示，不需要展开动作')
  } finally {
    h.cleanup()
  }
})

test('R11 05 显示未读计数：左栏角标与标题栏立即消失/恢复，落盘并在重开面板后保持', skip, async () => {
  const prefs = { value: undefined, writes: [] }
  const h = await mount({ items: [item({ id: 'a', feedId: 'f1' })], prefs })
  try {
    await h.settle()
    const badgeOf = (mountHandle) => mountHandle.$('[data-rss-nav-row="feed:f1"]')?.getAttribute('data-rss-nav-badge')
    assert.equal(badgeOf(h), '1', '前置：默认显示左栏角标')
    assert.ok(h.$('[data-rss-unread-count]') !== null, '前置：标题栏有未读数')

    await openSettings(h)
    const toggle = h.$('[data-rss-setting-checkbox="showUnread"]')
    assert.equal(toggle.checked, true, '默认显示未读计数')

    clickCheckbox(h, toggle)
    await h.settle()
    assert.equal(h.store.get().showUnread, false, '关闭立即生效')
    assert.equal(badgeOf(h), null, '关闭后左栏角标必须立即消失')
    const savedOff = h.requests.filter((entry) => entry.endpoint === 'saveViewPreferences').at(-1)
    assert.ok(savedOff !== undefined, '关闭必须落盘（D27.2）')
    assert.equal(savedOff.payload.preferences.showUnread, false, '落盘的 showUnread = false')
    assert.equal(prefs.value?.showUnread, false, '写进视图记忆的必须就是关闭态')

    h.$('[data-rss-settings-back]').click()
    await h.settle()
    assert.equal(h.$('[data-rss-unread-count]'), null, '标题栏未读数也必须消失')

    // 重新打开立即恢复（不重启）
    await openSettings(h)
    clickCheckbox(h, h.$('[data-rss-setting-checkbox="showUnread"]'))
    await h.settle()
    assert.equal(h.store.get().showUnread, true, '重新勾选立即生效')
    assert.equal(badgeOf(h), '1', '左栏角标立即恢复')
    h.$('[data-rss-settings-back]').click()
    await h.settle()
    assert.ok(h.$('[data-rss-unread-count]') !== null, '标题栏未读数立即恢复')

    // 再关一次，然后模拟「关面板 → 重开面板」：新 store 读同一份宿主偏好
    await openSettings(h)
    clickCheckbox(h, h.$('[data-rss-setting-checkbox="showUnread"]'))
    await h.settle()
    assert.equal(prefs.value?.showUnread, false)
    await h.unmount()

    const second = await mount({ items: [item({ id: 'a', feedId: 'f1' })], prefs })
    try {
      await second.settle()
      assert.equal(second.store.get().showUnread, false, '重开面板必须恢复「不显示未读计数」')
      assert.equal(badgeOf(second), null, '重开后左栏角标仍然隐藏')
      await openSettings(second)
      assert.equal(second.$('[data-rss-setting-checkbox="showUnread"]').checked, false,
        '重开后设置页开关仍是未勾选')
    } finally {
      second.cleanup()
    }
  } finally {
    h.cleanup()
  }
})
