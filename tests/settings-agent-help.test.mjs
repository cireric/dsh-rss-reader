/**
 * Agent 说明与关于区（R11 06，spec D24–D25 / D14 ⑤ / D14.1 / E24）。
 *
 * 这一层验三件事：
 *  ① 文案只有一份来源：`AGENT_HELP` 的顺序与内容就是设置页渲染的内容，README 只留指针；
 *  ② 渲染条目数 == 常量长度（防「常量改了、页面少画一条」的静默漂移）；
 *  ③ 关于区的版本 / 路径 / 12 个只读值全部由宿主下发 —— 客户端不硬编码，也没有输入控件。
 *
 * 为什么用真实 React + jsdom 渲染整页：本票的验收对象是「页面上画了几条」，直接测常量等于
 * 自证。装配方式与 settings-page-dom.test.mjs 同源（读真实构建产物 lib/client.js）。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { AGENT_APPROVAL_NOTE, AGENT_HELP } from '../lib/agent-help.js'
import { Config } from '../lib/config.js'
import { createSettingsControl } from '../lib/settings-control.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const require_ = createRequire(join(ROOT, 'package.json'))

/** spec §4.2 的 12 个只读键，按页面要求的顺序（期望值来自 spec，不 import 宿主白名单）。 */
const READ_ONLY_KEYS = [
  'timeoutMs', 'maxBytes', 'maxItemsPerFeed', 'maxSeenPerFeed', 'maxContentChars', 'maxArticleCacheChars',
  'importConcurrency', 'articleMaxBytes', 'articleCooldownMs', 'refreshOnStart', 'maxItemsShown', 'logFile',
]

const READ_ONLY_VALUES = {
  timeoutMs: 15000,
  maxBytes: 5 * 1024 * 1024,
  maxItemsPerFeed: 500,
  maxSeenPerFeed: 5000,
  maxContentChars: 50000,
  maxArticleCacheChars: 8_000_000,
  importConcurrency: 5,
  articleMaxBytes: 2 * 1024 * 1024,
  articleCooldownMs: 30000,
  refreshOnStart: true,
  maxItemsShown: 300,
  logFile: '',
}

const TUNABLE_DEFAULTS = {
  refreshFeedsPerRound: 20,
  refreshConcurrency: 5,
  minRefreshIntervalMs: 600000,
  cleanupAfterDays: 30,
}

const ABOUT_VERSION = '9.9.9-test'
const ABOUT_DATA_DIR = '/home/reader/.dsh/storages/rss-reader'
const ABOUT_SETTINGS_PATH = ABOUT_DATA_DIR + '/settings.json'

function aboutSnapshot() {
  return {
    effective: { ...TUNABLE_DEFAULTS },
    defaults: { ...TUNABLE_DEFAULTS },
    version: ABOUT_VERSION,
    dataDir: ABOUT_DATA_DIR,
    settingsPath: ABOUT_SETTINGS_PATH,
    readOnly: READ_ONLY_KEYS.map((key) => ({ key, value: READ_ONLY_VALUES[key] })),
  }
}

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
    console.warn('[settings-agent-help] 真实 React/jsdom 装配失败，跳过本组测试：', error instanceof Error ? error.message : error)
    return undefined
  }
}

const STACK = loadStack()
const skip = STACK === undefined ? { skip: '环境缺真实 React/jsdom（见本文件顶部说明）' } : {}

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
 * 起一个 DOM 环境 + 渲染真实 Reader。与 settings-page-dom.test.mjs 的夹具同形，
 * 但只桩本文件用得到的端点（overview / viewPreferences / settings）。
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
    feeds: [], items: [], folders: [], tags: [], unread: 0,
    perFeedUnread: {}, refreshed: false,
  }
  const settingsReply = settings ?? aboutSnapshot()
  const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
  let pendingFetches = 0
  const fetchStub = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.endpoint === 'settings') return ok({ settings: settingsReply })
    if (body.endpoint === 'viewPreferences') return ok({})
    if (body.endpoint === 'overview' || body.endpoint === 'refresh') return ok(overview)
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

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    reactRoot.unmount()
    dom.window.close()
    for (const key of Object.keys(globalSnapshot)) {
      try { globalThis[key] = globalSnapshot[key] } catch (error) { console.warn('[settings-agent-help] 全局还原失败：', key, error) }
    }
  }
  liveCleanups.push(cleanup)
  const $ = (selector) => win.document.querySelector(selector)
  return { win, store, settle, waitFor, cleanup, $ }
}

/** 进入设置页并等它上屏。 */
async function openSettings(h) {
  h.$('[data-rss-settings-open]').click()
  await h.waitFor(() => h.$('[data-rss-settings-page]') !== null, { label: '设置页上屏' })
  await h.settle()
}

afterEach(() => {
  while (liveCleanups.length > 0) {
    try { liveCleanups.pop()() } catch (error) { console.warn('[settings-agent-help] 收尾失败：', error) }
  }
})

test('R11 06 AGENT_HELP：四条固定顺序，每条是工具名 + 一句话 + 一个示例问法', () => {
  assert.deepEqual(AGENT_HELP.map((entry) => entry.name), [
    'rss_search', 'rss_list_feeds', 'rss_read_article', 'rss_update_item',
  ], '四条工具的顺序是 spec D24 的验收项')
  for (const entry of AGENT_HELP) {
    assert.deepEqual(Object.keys(entry).sort(), ['example', 'name', 'what'], '每条只有三段：name / what / example')
    assert.ok(entry.what.trim().length > 0, entry.name + ' 缺一句话说明')
    assert.ok(entry.example.trim().length > 0, entry.name + ' 缺示例问法')
  }
  assert.equal(AGENT_APPROVAL_NOTE, '写操作（标记已读 / 星标 / 改标签）每次都需要你批准。')
})

test('R11 06 关于区数据由宿主下发：版本运行时取自 package.json，路径与 12 个只读值同源', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-settings-agent-'))
  try {
    const settingsPath = join(dir, 'settings.json')
    const config = Config({ timeoutMs: 12345, maxItemsShown: 77 })
    const control = createSettingsControl({ config, settingsPath, log: () => {} })
    const snapshot = control.snapshot()
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    assert.equal(snapshot.version, pkg.version, '版本必须运行时读 package.json，不能抄一份字符串')
    assert.equal(snapshot.settingsPath, settingsPath, 'settings.json 路径来自 settings 控制器')
    assert.equal(snapshot.dataDir, dirname(settingsPath), '数据目录来自存储根（settings.json 所在目录）')
    assert.deepEqual(snapshot.readOnly.map((entry) => entry.key), READ_ONLY_KEYS,
      '12 个只读键与顺序只能由宿主白名单决定')
    const valueOf = Object.fromEntries(snapshot.readOnly.map((entry) => [entry.key, entry.value]))
    assert.equal(valueOf['timeoutMs'], 12345, '只读值取自同一份 Config（patch 值）')
    assert.equal(valueOf['maxItemsShown'], 77, '只读值取自同一份 Config')
    assert.equal(valueOf['refreshOnStart'], true, '布尔值原样下发')
    assert.equal(valueOf['logFile'], '', '空 logFile 原样下发，展示文案由客户端决定')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('R11 06 Agent 说明：按 AGENT_HELP 固定顺序渲染全部条目，末尾是审批提示', skip, async () => {
  const h = await mount()
  await openSettings(h)
  const box = h.$('[data-rss-agent-help]')
  assert.ok(box !== null, 'Agent 说明分区必须有一个可枚举的容器')
  const items = [...box.querySelectorAll('[data-rss-agent-tool]')]
  assert.equal(items.length, AGENT_HELP.length, '渲染条目数必须 == 常量长度（D24 / E24）')
  assert.deepEqual(items.map((node) => node.getAttribute('data-rss-agent-tool')),
    AGENT_HELP.map((entry) => entry.name), '页面上四条的顺序必须与常量一致')
  for (const [index, entry] of AGENT_HELP.entries()) {
    const text = items[index].textContent ?? ''
    assert.ok(text.includes(entry.name), '第 ' + (index + 1) + ' 条必须显示工具名 ' + entry.name)
    assert.ok(text.includes(entry.what), '第 ' + (index + 1) + ' 条必须显示一句话说明')
    assert.ok(text.includes(entry.example), '第 ' + (index + 1) + ' 条必须显示示例问法')
  }
  const note = box.querySelector('[data-rss-agent-approval]')
  assert.ok(note !== null, '分区末尾必须有固定的审批提示')
  assert.equal(note.textContent, AGENT_APPROVAL_NOTE)
  assert.equal(box.lastElementChild, note, '审批提示必须在分区末尾')
})

test('R11 06 关于区：版本 / 路径 + 默认折叠的 12 行只读参数，无任何输入控件', skip, async () => {
  const h = await mount()
  await openSettings(h)
  const about = h.$('[data-rss-about]')
  assert.ok(about !== null, '关于区必须存在')
  const valueOf = (key) => about.querySelector('[data-rss-about="' + key + '"] .dsh-rss-about-value')?.textContent
  assert.equal(valueOf('version'), ABOUT_VERSION, '版本号必须显示宿主下发的值')
  assert.equal(valueOf('dataDir'), ABOUT_DATA_DIR, '数据目录必须显示宿主下发的值')
  assert.equal(valueOf('settingsPath'), ABOUT_SETTINGS_PATH, 'settings.json 路径必须显示宿主下发的值')

  const details = about.querySelector('[data-rss-about-readonly]')
  assert.ok(details !== null, '只读参数区必须存在')
  assert.equal(details.open, false, '只读参数区默认折叠（D14）')
  assert.equal(details.querySelector('summary')?.textContent, '其余 12 个参数（只读）')
  const rows = [...details.querySelectorAll('[data-rss-about-key]')]
  assert.equal(rows.length, READ_ONLY_KEYS.length, '只读表必须覆盖 12 个字段')
  assert.deepEqual(rows.map((row) => row.getAttribute('data-rss-about-key')), READ_ONLY_KEYS,
    '12 行的顺序必须与宿主白名单一致')
  for (const row of rows) {
    const key = row.getAttribute('data-rss-about-key')
    const text = row.textContent ?? ''
    assert.ok(text.includes(key), '每行必须显示字段名 ' + key)
    if (key !== 'logFile') {
      assert.ok(text.includes(String(READ_ONLY_VALUES[key])), '每行必须显示当前值：' + key)
    }
  }
  const logRow = details.querySelector('[data-rss-about-key="logFile"]')
  assert.match(logRow.textContent ?? '', /（未设置，仅走宿主日志）/, 'logFile 空串必须显示可读文案')
  assert.equal(about.querySelectorAll('input, select, textarea, [contenteditable]').length, 0,
    '关于区只能读：不允许出现任何输入控件')
})

test('R11 06 README：只有一行指针，没有第二份工具文案', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const pointer = '能力说明见 阅读器 → 设置 → Agent'
  assert.equal(readme.split(pointer).length - 1, 1, 'README 必须恰好有一行 Agent 指针')
  for (const entry of AGENT_HELP) {
    assert.equal(readme.includes(entry.what), false, 'README 不得复制 ' + entry.name + ' 的一句话说明')
    assert.equal(readme.includes(entry.example), false, 'README 不得复制 ' + entry.name + ' 的示例问法')
    assert.equal(readme.includes(entry.name), false, 'README 不应再抄一份工具名：' + entry.name)
  }
})
