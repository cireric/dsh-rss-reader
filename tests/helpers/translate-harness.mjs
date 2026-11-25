/**
 * 翻译客户端测试的共享夹具（R7 01）。
 *
 * 为什么单独成文件：02/03/05 都要在「真实 React + 真实 bundle + jsdom」里点按钮、看译文、
 * 切换条目。装配代码（checkout 探测、jsdom 全局、MessageChannel 让路、bundle 加载）一份就够；
 * 各票各抄一份时，桩件迟早会漂移成「有的文件里 translateBatch 回包带 model、有的不带」。
 *
 * 通道用 `createReaderStore({ rpc })` 注入，而不是塞 `window.fetch`：store 的唯一接缝就是
 * rpc（见 src/client/store.ts 的 ReaderStoreDeps），这样测试只关心端点名与 payload。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const require_ = createRequire(join(ROOT, 'package.json'))

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
    console.warn('[translate-harness] 真实 React/jsdom 装配失败：', error instanceof Error ? error.message : error)
    return undefined
  }
}

export const STACK = loadStack()
export const skip = STACK === undefined ? { skip: '环境缺真实 React/jsdom（见 tests/helpers/translate-harness.mjs）' } : {}

const liveCleanups = []

export function cleanupAll() {
  while (liveCleanups.length > 0) {
    try { liveCleanups.pop()() } catch (error) { console.warn('[translate-harness] 收尾失败：', error) }
  }
}

const TUNABLE_DEFAULTS = {
  refreshFeedsPerRound: 20,
  refreshConcurrency: 5,
  minRefreshIntervalMs: 600000,
  cleanupAfterDays: 30,
  rsshubBase: '',
  translateProvider: '',
  translateModel: '',
  translateEffort: '',
  translateNoticeAck: false,
}

/** R7 02 的默认探测结果：可用、跟随会话默认，并且带一份可选的模型目录。 */
export const AVAILABLE_TRANSLATE_INFO = {
  available: true,
  route: { provider: 'p', model: 'm' },
  sessionDefault: { provider: 'p', model: 'm' },
  providers: [
    { provider: 'p', models: [
      { id: 'm', efforts: ['low', 'high'] },
      { id: 'm2', efforts: [] },
    ] },
  ],
}

/** 条目夹具：客户端列表需要的字段一次给全，避免各用例各拼一份半成品。 */
export function itemOf(id, overrides = {}) {
  return {
    id,
    feedId: 'f1',
    feedTitle: '源一',
    title: '条目 ' + id,
    link: 'https://example.com/' + id,
    publishedAt: '2026-11-20T00:00:00.000Z',
    fetchedAt: '2026-11-20T00:00:00.000Z',
    summary: '摘要',
    ...overrides,
  }
}

export function articleOf(id, blocks, overrides = {}) {
  return {
    itemId: id,
    cached: true,
    title: '文章 ' + id,
    blocks,
    contentVersion: 'rev1:' + id,
    ...overrides,
  }
}

async function waitFor(predicate, { timeout = 2000, interval = 5, label = '条件' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error('等待超时（' + timeout + 'ms）：' + label)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/**
 * 起 DOM + 真实 Reader。
 *
 * @param items       条目表
 * @param articles    itemId → article 回包（或函数）
 * @param translateBatch 自定义翻译回包：接收 payload，返回 value 或 { error }
 */
export async function mount({
  items = [itemOf('a')], articles = {}, translateBatch,
  translateInfo = AVAILABLE_TRANSLATE_INFO, preferences = undefined,
} = {}) {
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
  // jsdom 无布局引擎：getClientRects 恒为空会让键盘路由的可见性守卫直接 return。
  win.Element.prototype.getClientRects = function () { return [{}] }
  class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
  globalThis.ResizeObserver = ResizeObserverStub
  win.ResizeObserver = ResizeObserverStub

  const React = require_(STACK.reactPath)
  const jsxRuntime = require_(join(STACK.reactPath, 'jsx-runtime'))
  const createRoot = require_(join(STACK.reactDomPath, 'client')).createRoot

  let storedItems = items.map((entry) => ({ ...entry }))
  const overviewNow = () => {
    const perFeedUnread = { f1: 0 }
    for (const entry of storedItems) {
      if (entry.readAt === undefined && perFeedUnread[entry.feedId] !== undefined) perFeedUnread[entry.feedId] += 1
    }
    return {
      feeds: [{ id: 'f1', title: '源一' }],
      items: storedItems,
      folders: [],
      tags: [],
      unread: Object.values(perFeedUnread).reduce((sum, count) => sum + count, 0),
      perFeedUnread,
      refreshed: false,
    }
  }
  const settings = {
    effective: { ...TUNABLE_DEFAULTS },
    defaults: { ...TUNABLE_DEFAULTS },
    version: '0.1.0',
    dataDir: '/tmp/rss-reader',
    settingsPath: '/tmp/rss-reader/settings.json',
    readOnly: [],
  }
  const requests = []
  // 失败信封要抛**真的** RpcError（bundle 里的类），否则 translate-actions 的
  // `instanceof RpcError` 判据在假 rpc 下永远不会成立，测试会覆盖不到 reason 分支。
  // 类在 bundle 加载后才拿得到，所以先声明、执行期再赋值。
  let RpcErrorClass
  const rpc = async (endpoint, payload) => {
    requests.push({ endpoint, payload })
    if (endpoint === 'settings') return { settings }
    if (endpoint === 'translateInfo') {
      return typeof translateInfo === 'function' ? translateInfo() : translateInfo
    }
    if (endpoint === 'viewPreferences') return { preferences }
    if (endpoint === 'saveViewPreferences') return { preferences: payload?.preferences }
    if (endpoint === 'saveSettings') {
      // 只实现客户端设置页需要的形状：把 patch 合并进 effective 并回同形快照。
      Object.assign(settings.effective, payload?.patch ?? {})
      return { settings }
    }
    if (endpoint === 'overview' || endpoint === 'refresh') return overviewNow()
    if (endpoint === 'markRead' || endpoint === 'unmarkRead') {
      const ids = Array.isArray(payload?.itemIds) ? payload.itemIds : []
      for (const entry of storedItems) {
        if (!ids.includes(entry.id)) continue
        if (endpoint === 'markRead') entry.readAt = '2026-11-22T00:00:00.000Z'
        else delete entry.readAt
      }
      return { ...overviewNow(), changed: ids.length }
    }
    if (endpoint === 'article') {
      const article = typeof articles === 'function' ? articles(payload?.itemId) : articles[payload?.itemId]
      if (article === undefined) return { itemId: payload?.itemId, blocks: [{ kind: 'p', text: '正文' }], contentVersion: 'rev1:' + payload?.itemId }
      return article
    }
    if (endpoint === 'duplicateHints') return { hints: [] }
    // 正文面卸载时会记一次阅读进度；本组用例不判它，但要给一个守约的回包免日志噪音。
    if (endpoint === 'saveReadingProgress') return { saved: true }
    if (endpoint === 'translateBatch') {
      if (translateBatch !== undefined) {
        const custom = await translateBatch(payload)
        if (custom?.error !== undefined) {
          // details 原样带给 RpcError：测试要覆盖「失败原因只在 details.reason 里」的契约。
          throw new RpcErrorClass(custom.error.code, custom.error.message, custom.error.details ?? {})
        }
        if (custom?.value !== undefined) return custom.value
      }
      return {
        model: 'fake/m',
        ...(payload?.title === undefined ? {} : { title: '译:' + payload.title }),
        items: (payload?.items ?? []).map((item) => ({ id: item.id, text: '译:' + item.text })),
      }
    }
    throw new Error('unknown-endpoint: ' + endpoint)
  }

  let captured = null
  win.__ModuleLoader__ = { load: (entry) => { captured = entry } }
  vm.runInThisContext(readFileSync(BUNDLE, 'utf8'), { filename: 'client.js' })
  if (captured === null) throw new Error('client bundle 没有调用 window.__ModuleLoader__.load')
  const requireFn = (specifier) => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    throw new Error('未预期的外部依赖：' + specifier)
  }
  const exportsObj = captured.factory(requireFn)
  RpcErrorClass = exportsObj.RpcError
  const createStore = () => exportsObj.createReaderStore({ rpc })
  const store = createStore()
  const root = createRoot(win.document.getElementById('root'))
  root.render(React.createElement(exportsObj.createReader(store)))

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
      quiet += 1
      if (quiet >= 2) return
    }
    throw new Error('等界面稳定超时（' + timeout + 'ms）')
  }

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
    try { root.unmount() } catch (error) { console.warn('[translate-harness] unmount 失败：', error) }
    dom.window.close()
    for (const key of Object.keys(globalSnapshot)) {
      try { globalThis[key] = globalSnapshot[key] } catch (error) { console.warn('[translate-harness] 全局还原失败：', key, error) }
    }
  }
  liveCleanups.push(cleanup)
  const $ = (selector) => win.document.querySelector(selector)
  const $$ = (selector) => [...win.document.querySelectorAll(selector)]
  const calls = (endpoint) => requests.filter((entry) => entry.endpoint === endpoint)
  return { win, store, requests, calls, createStore, exports: exportsObj, press, settle, waitFor, cleanup, $, $$ }
}

/** 打开某条目正文页并等它渲染完成。 */
export async function openArticle(h, itemId) {
  await h.store.load('overview')
  await h.settle()
  h.store.select(itemId)
  await h.store.openArticle()
  await h.waitFor(() => h.store.get().view === 'article' && h.store.get().article?.itemId === itemId, { label: '进入 ' + itemId + ' 正文页' })
  await h.settle()
  const body = h.$('article.dsh-rss-article-column')
  if (body === null) throw new Error('正文列没有渲染')
  return body
}
