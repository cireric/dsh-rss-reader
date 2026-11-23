/**
 * R9 03：订阅管理的「回溯」行内表单与结果区的 DOM 层验收（spec §4.1 / §4.8 / A8 / A10）。
 *
 * 为什么用真 React + jsdom + 真实构建产物：本票的核心承诺全是**画在 DOM 上**的事实——
 * 「点开才出现表单」「非法输入零请求」「运行中整行写操作置灰」「连点只发一次」「失败逐条可读」。
 * 假 React 夹具（client-bundle）看不出受控输入、disabled 状态与事件传播；只断言 store 又会漏掉
 * 「state 对了但 attribute 没写」这类接线故障。
 *
 * 装配方式与 settings-page-dom.test.mjs 一致（jsdom 从 dsh checkout 解析，缺依赖则跳过）：
 * 只桩本票会用到的端点，避免复制 scroll-dom 那套大夹具。
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
    console.warn('[backfill-dom] 真实 React/jsdom 装配失败，跳过本组测试：', error instanceof Error ? error.message : error)
    return undefined
  }
}

const STACK = loadStack()
const skip = STACK === undefined ? { skip: '环境缺真实 React/jsdom（见本文件顶部说明）' } : {}

const FEEDS = [{ id: 'f1', title: '源一' }, { id: 'f2', title: '源二' }, { id: 'f3', title: '源三' }]

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

/** 一份守宿主契约的 overview：feeds 表决定管理页行序，perFeedUnread 键域与 feeds 一致。 */
function overviewOf(feeds) {
  const perFeedUnread = {}
  for (const feed of feeds) perFeedUnread[feed.id] = 0
  return { feeds, items: [], folders: [], tags: [], unread: 0, perFeedUnread, refreshed: false }
}

/** 一次成功回溯的默认报告（各用例只覆盖自己关心的字段）。 */
function reportOf(payload, overrides = {}) {
  return {
    feedId: payload.feedId,
    archiveUrl: payload.archiveUrl,
    sampleCount: 10,
    archiveLinks: 51,
    matched: 20,
    existing: 3,
    attempted: 17,
    added: 17,
    failures: [],
    remaining: 0,
    ...overrides,
  }
}

/**
 * 起一个 DOM 环境 + 渲染真实 Reader。
 *
 * @param backfill 自定义 `backfillHistory` 桩：收到 payload，返回 `{ value }`（成功报告）或
 *   `{ error: { code, message, details } }`（失败信封）；不传则回默认报告。
 * @param holdBackfill 返回一个 Promise：回溯请求会扣在这里，用来观察运行中的禁用状态。
 */
async function mount({ feeds = FEEDS, backfill, holdBackfill } = {}) {
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

  const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
  const failEnvelope = (error) => ({ ok: true, status: 200, json: async () => ({ ok: false, error }) })
  const requests = []
  let pendingFetches = 0
  let backfillCalls = 0
  const fetchStub = async (_url, init) => {
    const body = JSON.parse(init.body)
    requests.push({ endpoint: body.endpoint, payload: body.payload })
    if (body.endpoint === 'refresh' || body.endpoint === 'overview') return ok(overviewOf(feeds))
    if (body.endpoint === 'viewPreferences') return ok({ preferences: undefined })
    if (body.endpoint === 'saveViewPreferences') return ok({ preferences: body.payload?.preferences })
    if (body.endpoint === 'duplicateHints') return ok({ hints: [] })
    if (body.endpoint === 'backfillHistory') {
      backfillCalls += 1
      if (holdBackfill !== undefined) await holdBackfill
      const custom = backfill === undefined ? undefined : await backfill(body.payload, backfillCalls)
      if (custom?.error !== undefined) return failEnvelope(custom.error)
      return ok(custom?.value ?? reportOf(body.payload))
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
  /** 等 DOM 连续两跳不变；allowPending 用于「请求被扣住、但要点界面」的断言。 */
  const settle = async ({ timeout = 2000, allowPending = false } = {}) => {
    let mutations = 0
    const observer = new win.MutationObserver(() => { mutations += 1 })
    observer.observe(win.document, { subtree: true, childList: true, attributes: true, characterData: true })
    try {
      let seen = -1
      let quiet = 0
      let ticks = 0
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        await nextTask()
        await new Promise((resolve) => setTimeout(resolve, 0))
        ticks += 1
        if (!allowPending && pendingFetches > 0) { quiet = 0; continue }
        if (mutations === seen) {
          quiet += 1
          if (quiet >= 2 && ticks >= 2) return
        } else {
          seen = mutations
          quiet = 0
        }
      }
      throw new Error('等界面稳定超时（' + timeout + 'ms）：在飞请求 ' + pendingFetches + ' 个，DOM 变更 ' + mutations + ' 次')
    } finally {
      observer.disconnect()
    }
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
      try { globalThis[key] = globalSnapshot[key] } catch (error) { console.warn('[backfill-dom] 全局还原失败：', key, error) }
    }
  }
  liveCleanups.push(cleanup)
  const $ = (selector) => win.document.querySelector(selector)
  return { win, store, requests, press, settle, waitFor, cleanup, $ }
}

/** 受控 input 的值写进去并派发 React 认的 input 事件（原生 setter 绕过 value tracker）。 */
function setControlValue(win, element, value) {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('找不到 INPUT 的 value setter')
  setter.call(element, value)
  element.dispatchEvent(new win.Event('input', { bubbles: true }))
}

/** 管理页里某个源的那一行。 */
function rowOf(h, feedId) {
  return h.$('[data-rss-feed-row="' + feedId + '"]')
}

/** 打开某行的回溯表单并等它上屏。 */
async function openBackfill(h, feedId) {
  rowOf(h, feedId).querySelector('[data-rss-feed-backfill="' + feedId + '"]').click()
  await h.waitFor(() => rowOf(h, feedId).querySelector('[data-rss-backfill-url]') !== null, { label: feedId + ' 的回溯表单' })
  await h.settle()
}

/** 填表；不传的字段保持现值（limit 默认 20）。 */
function fillBackfill(h, feedId, url, limit) {
  const row = rowOf(h, feedId)
  if (url !== undefined) setControlValue(h.win, row.querySelector('[data-rss-backfill-url]'), url)
  if (limit !== undefined) setControlValue(h.win, row.querySelector('[data-rss-backfill-limit]'), limit)
}

/** 进入订阅管理页（f 键）。 */
async function openFeedsView(h) {
  h.press('f')
  await h.waitFor(() => h.store.get().view === 'feeds', { label: '订阅管理页上屏' })
  await h.settle()
}

afterEach(() => {
  while (liveCleanups.length > 0) {
    try { liveCleanups.pop()() } catch (error) { console.warn('[backfill-dom] 收尾失败：', error) }
  }
})

test('R9 03 回溯表单：行内「回溯」展开归档页 / 篇数（默认 20）/ 开始 / 取消，再点一次收起', skip, async () => {
  const h = await mount()
  await h.store.load('overview')
  await h.settle()
  await openFeedsView(h)
  const row = rowOf(h, 'f1')
  const trigger = row.querySelector('[data-rss-feed-backfill="f1"]')
  assert.ok(trigger !== null, '每个源行都要有「回溯」按钮')
  assert.equal(trigger.textContent, '回溯')
  assert.equal(row.querySelector('[data-rss-backfill-url]'), null, '未点开时不该显示表单')

  await openBackfill(h, 'f1')
  const openRow = rowOf(h, 'f1')
  assert.equal(openRow.querySelector('[data-rss-backfill-url]').value, '', '归档页地址每次现填，不记忆上次')
  assert.equal(openRow.querySelector('[data-rss-backfill-limit]').value, '20', '篇数默认 20（spec §4.1）')
  assert.ok(openRow.querySelector('[data-rss-backfill-start]') !== null, '必须有「开始」')
  assert.ok(openRow.querySelector('[data-rss-backfill-cancel]') !== null, '必须有「取消」')

  openRow.querySelector('[data-rss-feed-backfill="f1"]').click()
  await h.settle()
  assert.equal(rowOf(h, 'f1').querySelector('[data-rss-backfill-url]'), null, '再点「回溯」收起表单')
  h.cleanup()
})

test('R9 03 回溯提交：Enter 只发一次 backfillHistory，参数正确；成功后 reload 宿主快照、不乐观改列表', skip, async () => {
  const h = await mount({
    backfill: (payload) => ({ value: reportOf(payload, { added: 2, existing: 1, matched: 4, attempted: 3, remaining: 0 }) }),
  })
  await h.store.load('overview')
  await h.settle()
  await openFeedsView(h)
  await openBackfill(h, 'f1')
  fillBackfill(h, 'f1', 'https://example.com/archives.html', '7')

  const urlInput = rowOf(h, 'f1').querySelector('[data-rss-backfill-url]')
  const enter = new h.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  urlInput.dispatchEvent(enter)
  assert.equal(enter.defaultPrevented, true, 'Enter 由表单自己提交并 preventDefault（不交给全局按键）')
  await h.settle()

  const calls = h.requests.filter((entry) => entry.endpoint === 'backfillHistory')
  assert.equal(calls.length, 1, '一次回车只发一次回溯请求')
  assert.deepEqual(calls[0].payload, { feedId: 'f1', archiveUrl: 'https://example.com/archives.html', limit: 7 },
    '提交参数 = 当前源 + 现填的归档页地址 + 数字篇数')

  const callIndex = h.requests.findIndex((entry) => entry.endpoint === 'backfillHistory')
  const reloadIndex = h.requests.findIndex((entry, index) => index > callIndex && entry.endpoint === 'overview')
  assert.ok(reloadIndex > callIndex, '成功后必须 reload(overview) 取回宿主快照')
  assert.equal(h.store.get().items.length, 0, '报告说 added=2，但列表仍以宿主快照为准（无条目就是无条目）')

  const result = rowOf(h, 'f1').querySelector('[data-rss-backfill-result]')
  assert.ok(result !== null, '成功后行内必须出现结果区')
  assert.match(result.textContent, /新增\s*2\s*篇/, '结果区要写新增篇数')
  h.cleanup()
})

test('R9 03 回溯结果：新增 / 已存在 / 形态命中与技术性失败逐条渲染，失败为空时不显示空列表', skip, async () => {
  const h = await mount({
    backfill: (payload, call) => ({
      value: call === 1
        ? reportOf(payload, {
            added: 1,
            existing: 3,
            matched: 5,
            attempted: 3,
            remaining: 0,
            failures: [
              { url: 'https://example.com/blog/2026/11/a.html', reason: 'HTTP 404' },
              { url: 'https://example.com/blog/2026/11/b.html', reason: '无发布日期' },
            ],
          })
        : reportOf(payload, { feedId: payload.feedId, added: 0, existing: 0, matched: 0, attempted: 0, failures: [], remaining: 0 }),
    }),
  })
  await h.store.load('overview')
  await h.settle()
  await openFeedsView(h)
  await openBackfill(h, 'f1')
  fillBackfill(h, 'f1', 'https://example.com/archives.html', '20')
  rowOf(h, 'f1').querySelector('[data-rss-backfill-start]').click()
  await h.settle()

  const result = rowOf(h, 'f1').querySelector('[data-rss-backfill-result]')
  assert.ok(result !== null, '结果区必须渲染')
  assert.match(result.textContent, /新增\s*1\s*篇/, '新增计数')
  assert.match(result.textContent, /已存在\s*3\s*篇/, '已存在计数')
  assert.match(result.textContent, /形态命中\s*5\s*篇/, '形态命中计数')
  const failures = [...result.querySelectorAll('[data-rss-backfill-failure]')]
  assert.equal(failures.length, 2, '失败必须逐条渲染，不能只报总数')
  assert.match(failures[0].textContent, /https:\/\/example\.com\/blog\/2026\/11\/a\.html.*HTTP 404/, '第一条失败 = 地址 + 可读原因')
  assert.match(failures[1].textContent, /https:\/\/example\.com\/blog\/2026\/11\/b\.html.*无发布日期/, '第二条失败 = 地址 + 可读原因')

  // 第二个源跑一次 failures 为空：不许出现空的失败列表（空壳会让人以为「有失败但没显示」）。
  await openBackfill(h, 'f2')
  fillBackfill(h, 'f2', 'https://example.com/archives.html', '20')
  rowOf(h, 'f2').querySelector('[data-rss-backfill-start]').click()
  await h.settle()
  const emptyResult = rowOf(h, 'f2').querySelector('[data-rss-backfill-result]')
  assert.ok(emptyResult !== null, '无失败也要有结果区（计数照常）')
  assert.equal(emptyResult.querySelectorAll('[data-rss-backfill-failure]').length, 0, '失败为空时不渲染失败条目')
  assert.doesNotMatch(emptyResult.textContent, /失败\s*\d+\s*篇|以下失败/, '失败为空时不许留下空列表标题')
  h.cleanup()
})

test('R9 03 回溯停止原因：stoppedBy=deadline 与 limit 各有一句人话（limit 写明受每源上限限制）', skip, async () => {
  const h = await mount({
    backfill: (payload, call) => ({
      value: call === 1
        ? reportOf(payload, { added: 0, existing: 0, matched: 9, attempted: 4, remaining: 5, stoppedBy: 'deadline' })
        : reportOf(payload, { added: 1, existing: 0, matched: 2, attempted: 1, remaining: 1, stoppedBy: 'limit' }),
    }),
  })
  await h.store.load('overview')
  await h.settle()
  await openFeedsView(h)

  await openBackfill(h, 'f1')
  fillBackfill(h, 'f1', 'https://example.com/archives.html', '20')
  rowOf(h, 'f1').querySelector('[data-rss-backfill-start]').click()
  await h.settle()
  const deadlineText = rowOf(h, 'f1').querySelector('[data-rss-backfill-result]').textContent
  assert.match(deadlineText, /120\s*秒/, 'deadline 要说明单轮预算，而不是只给一个字段值')
  assert.match(deadlineText, /剩余\s*5\s*篇/, 'deadline 要告诉人还剩多少没抓')

  await openBackfill(h, 'f2')
  fillBackfill(h, 'f2', 'https://example.com/archives.html', '20')
  rowOf(h, 'f2').querySelector('[data-rss-backfill-start]').click()
  await h.settle()
  const limitText = rowOf(h, 'f2').querySelector('[data-rss-backfill-result]').textContent
  assert.match(limitText, /受每源上限限制/, 'limit 必须写明「受每源上限限制」（spec §4.6）')
  assert.match(limitText, /剩余\s*1\s*篇/, 'limit 也要告诉人还剩多少')
  h.cleanup()
})

test('R9 03 回溯非法输入：非 http(s) 地址与篇数不在 1–50 都是就地原因 + 零请求', skip, async () => {
  const h = await mount()
  await h.store.load('overview')
  await h.settle()
  await openFeedsView(h)
  await openBackfill(h, 'f1')

  const cases = [
    { url: 'ftp://example.com/archives.html', limit: '20', reason: /http\(s\)|http\/https/ },
    { url: 'not a url', limit: '20', reason: /http\(s\)|http\/https/ },
    { url: 'https://example.com/archives.html', limit: '0', reason: /1[–-]50/ },
    { url: 'https://example.com/archives.html', limit: '51', reason: /1[–-]50/ },
    { url: 'https://example.com/archives.html', limit: '', reason: /1[–-]50/ },
    { url: 'https://example.com/archives.html', limit: '2.5', reason: /1[–-]50/ },
  ]
  for (const entry of cases) {
    fillBackfill(h, 'f1', entry.url, entry.limit)
    rowOf(h, 'f1').querySelector('[data-rss-backfill-start]').click()
    await h.settle()
    const status = rowOf(h, 'f1').querySelector('[data-rss-backfill-result]')
    assert.ok(status !== null, '非法输入也要就地说明（' + entry.url + ' / ' + entry.limit + '）')
    assert.match(status.textContent, entry.reason, '原因要能看出是地址还是篇数的问题：' + status.textContent)
  }
  assert.equal(h.requests.filter((entry) => entry.endpoint === 'backfillHistory').length, 0, '客户端先拦：一次请求都不许发')
  assert.equal(h.store.get().error, undefined, '客户端入参校验不写全局 error（就地说明即可）')
  h.cleanup()
})

test('R9 03 回溯运行中：本行回溯 / ↑ / ↓ / 移动到 / 退订全禁用，连点「开始」只发一次请求', skip, async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const h = await mount({
    holdBackfill: gate,
    backfill: (payload) => ({ value: reportOf(payload, { added: 1, failures: [], remaining: 0 }) }),
  })
  await h.store.load('overview')
  await h.settle()
  await openFeedsView(h)

  await openBackfill(h, 'f2')
  fillBackfill(h, 'f2', 'https://example.com/archives.html', '20')
  const start = rowOf(h, 'f2').querySelector('[data-rss-backfill-start]')
  start.click()
  // 连点：第二次点击发生在第一次的回包之前。state 的 disabled 要等重渲染，ref 守卫负责这一次。
  start.click()
  await h.waitFor(() => h.store.get().view === 'feeds' && h.requests.some((entry) => entry.endpoint === 'backfillHistory'), { label: '回溯请求发出' })
  await h.settle({ allowPending: true })

  const row = rowOf(h, 'f2')
  assert.equal(row.querySelector('[data-rss-feed-backfill="f2"]').disabled, true, '运行中本行的回溯按钮禁用')
  assert.equal(row.querySelector('[data-rss-feed-order-up="f2"]').disabled, true, '运行中本行 ↑ 禁用')
  assert.equal(row.querySelector('[data-rss-feed-order-down="f2"]').disabled, true, '运行中本行 ↓ 禁用')
  assert.equal(row.querySelector('[data-rss-feed-folder="f2"]').disabled, true, '运行中本行「移动到」禁用')
  assert.equal(row.querySelector('[data-rss-feed-remove="f2"]').disabled, true, '运行中本行退订禁用')
  assert.equal(row.querySelector('[data-rss-backfill-start]').disabled, true, '运行中「开始」禁用（防连点）')
  assert.equal(rowOf(h, 'f1').querySelector('[data-rss-feed-remove="f1"]').disabled, false, '别的源不受这一行的影响')

  const callsNow = h.requests.filter((entry) => entry.endpoint === 'backfillHistory')
  assert.equal(callsNow.length, 1, '连点开始不产生第二个请求')
  assert.deepEqual(callsNow[0].payload, { feedId: 'f2', archiveUrl: 'https://example.com/archives.html', limit: 20 })

  release()
  await h.settle()
  const done = rowOf(h, 'f2')
  assert.equal(done.querySelector('[data-rss-feed-backfill="f2"]').disabled, false, '完成后回溯按钮恢复')
  assert.equal(done.querySelector('[data-rss-feed-order-up="f2"]').disabled, false, '完成后 ↑ 恢复（中间行）')
  assert.equal(done.querySelector('[data-rss-feed-folder="f2"]').disabled, false, '完成后移动到恢复')
  assert.equal(done.querySelector('[data-rss-feed-remove="f2"]').disabled, false, '完成后退订恢复')
  assert.equal(h.requests.filter((entry) => entry.endpoint === 'backfillHistory').length, 1, '整轮只发一次回溯请求')
  h.cleanup()
})

test('R9 03 回溯失败态：宿主拒绝时行内显示可读原因、全局 error 同步写下，不显示伪造报告', skip, async () => {
  const h = await mount({
    backfill: () => ({ error: { code: 'bad-request', message: '样本不足，无法判断文章链接形态（至少需要 3 条已有条目）', details: {} } }),
  })
  await h.store.load('overview')
  await h.settle()
  await openFeedsView(h)
  await openBackfill(h, 'f1')
  fillBackfill(h, 'f1', 'https://example.com/archives.html', '20')
  rowOf(h, 'f1').querySelector('[data-rss-backfill-start]').click()
  await h.settle()

  const result = rowOf(h, 'f1').querySelector('[data-rss-backfill-result]')
  assert.ok(result !== null, '失败也要把原因留在行内')
  assert.match(result.textContent, /样本不足/, '行内原因要是宿主给的人类可读文本')
  assert.equal(result.querySelector('[data-rss-backfill-summary]'), null, '失败时不许显示半份报告')
  assert.match(h.store.get().error, /样本不足/, '同一原因必须写进全局 error（本文件既有 catch 纪律）')
  assert.equal(h.requests.filter((entry) => entry.endpoint === 'backfillHistory').length, 1, '失败也不重试')
  h.cleanup()
})

test('R9 03 回溯取消与 Esc：Esc 不外泄到全局、焦点回到「回溯」；取消按钮同一条路径', skip, async () => {
  const h = await mount()
  await h.store.load('overview')
  await h.settle()
  await openFeedsView(h)
  await openBackfill(h, 'f1')

  const urlInput = rowOf(h, 'f1').querySelector('[data-rss-backfill-url]')
  urlInput.focus()
  const esc = new h.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  urlInput.dispatchEvent(esc)
  assert.equal(esc.defaultPrevented, true, 'Esc 由表单自己处理并 preventDefault')
  await h.settle()
  assert.equal(h.store.get().view, 'feeds', 'Esc 不许外泄到全局把订阅管理页关掉')
  assert.equal(rowOf(h, 'f1').querySelector('[data-rss-backfill-url]'), null, 'Esc 收起表单')
  assert.equal(h.win.document.activeElement, rowOf(h, 'f1').querySelector('[data-rss-feed-backfill="f1"]'),
    '取消后焦点回到触发它的「回溯」按钮')

  await openBackfill(h, 'f1')
  fillBackfill(h, 'f1', 'https://example.com/archives.html')
  rowOf(h, 'f1').querySelector('[data-rss-backfill-cancel]').click()
  await h.settle()
  assert.equal(rowOf(h, 'f1').querySelector('[data-rss-backfill-url]'), null, '取消按钮收起表单')
  assert.equal(h.win.document.activeElement, rowOf(h, 'f1').querySelector('[data-rss-feed-backfill="f1"]'),
    '取消按钮也把焦点还给「回溯」')
  h.cleanup()
})
