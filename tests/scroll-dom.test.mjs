/**
 * 客户端「滚动容器」接线测试 —— 用**真实 React 18 + 真实 DOM** 渲染**真实构建产物**。
 *
 * 为什么必须另起一层（而不是加在 client-bundle.test.mjs 里）：那套夹具用的是自写的假 React，
 * 它的 useEffect 写成 `(fn) => { fn() }` —— **完全忽略依赖数组**，且所有 ref 回调共用同一个桩节点。
 * 于是「容器被闭包捕获、依赖数组里没有它」这一类失效**在那套夹具里根本无法表达**。
 * 2026-10-09 的实测就是证据：带缺陷的构建产物在 npm test 下 175/175 全绿，
 * 而用户在详情页按空格毫无反应。
 *
 * 依赖来自 dsh checkout（本仓库没有锁文件，依赖由 scripts/build.sh 现链）：
 *  - jsdom：checkout 根 devDependencies 里有，可直接解析
 *  - react / react-dom：只存在于 checkout 的 .pnpm 目录，按 build.sh 同样的 glob 方式定位
 * 任何一条解析不到时**跳过而不是失败**：这是环境能力，不是本仓库的缺陷。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { READER_KEY_HELP } from '../lib/keys.js'

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

/** 把真实 React / jsdom 装配起来；缺任何一项就返回 undefined（调用方跳过）。 */
function loadStack() {
  const checkout = checkoutRoot()
  if (checkout === undefined) return undefined
  try {
    const jsdomPath = require_.resolve('jsdom', { paths: [checkout] })
    const reactPath = pnpmPackage(checkout, 'react')
    const reactDomPath = pnpmPackage(checkout, 'react-dom')
    if (reactPath === undefined || reactDomPath === undefined) return undefined
    return {
      JSDOM: require_(jsdomPath).JSDOM,
      // 刻意**不在这里 require React**：React DOM 在模块加载时用 canUseDOM 决定是否走
      // IE9 的 input 事件 polyfill（jsdom 下会炸在 attachEvent 上）。先建好 JSDOM、把
      // window/document 装进全局，再 require，React 才会走正常的 input 事件路径。
      reactPath,
      reactDomPath,
    }
  } catch (error) {
    // 不静默：解析失败要能看出是环境问题还是路径写法过期（换 dsh 版本时 pnpm 目录名会变）
    console.warn('[scroll-dom] 真实 React/jsdom 装配失败，跳过本组测试：', error instanceof Error ? error.message : error)
    return undefined
  }
}

const STACK = loadStack()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 等到 predicate() 为真。
 *
 * 为什么不用 sleep(n)：固定毫秒是在赌机器速度 —— 赌赢了白等，赌输了 flaky。
 * 这里的判据是**业务可见状态**（view === 'article'、正文容器在 DOM 里、请求真的发出去了），
 * 状态一到就往下走，超时才失败（失败信息带 label，能直接看出在等什么）。
 */
async function waitFor(predicate, { timeout = 1000, interval = 5, label = '条件' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error('等待超时（' + timeout + 'ms）：' + label)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

/**
 * 桩 overview：一份**守宿主契约**的返回值（feeds 表 + items + perFeedUnread）。
 *
 * 为什么封装成一份而不是三处各拼一个对象：perFeedUnread 的**键域严格 = feeds 表**（0 未读的源
 * 也保留 0 值键）是任务 1 裁决下来的契约，散在几处迟早写出三份语义不同的桩 —— 本文件此前就是
 * 三份（两处只给未读 > 0 的源发键），而缺键的表现是「角标空白 vs 角标 0」，界面上无从分辨。
 *
 * 为什么是**给桩补数据**而不是让客户端去容忍缺失：宿主既已裁决它是必填字段（src/shared.ts:58-65
 * 的注释即契约原文），客户端就该无条件使用它。作品代码里写 `?? {}` 去兜，等于掩盖一个
 * 契约上不该存在的形状，代价要等任务 3 用这个字段渲染左栏时才显现。
 *
 * @param items 条目表
 * @param feeds 订阅源表；不给则按 items 里出现过的 feedId 推导（此时两者恰好相等）
 */
function overviewStub(items, feeds, folders, accountItems = items, tags = []) {
  const table = feeds ?? [...new Set(items.map((entry) => entry.feedId))].map((feedId) => ({ id: feedId, title: feedId }))
  // 显式传入的目录优先；否则从 feeds 的 folder 派生（空目录只能靠显式参数表达）。
  const directory = folders ?? (() => {
    const derived = []
    for (const feed of table) {
      if (feed.folder === undefined || feed.folder === '') continue
      let folder = derived.find((entry) => entry.name === feed.folder)
      if (folder === undefined) { folder = { name: feed.folder, feedIds: [] }; derived.push(folder) }
      folder.feedIds.push(feed.id)
    }
    return derived
  })()
  const perFeedUnread = {}
  // 先按 feeds 表铺 0：这一步是键域的全部要点，缺了它 0 未读的源就会丢键
  for (const feed of table) perFeedUnread[feed.id] = 0
  // 账目按**全量**算（文件夹浏览时 items 已按成员过滤，但未读账仍是全局权威值）。
  for (const entry of accountItems) {
    // 已退订源的条目可能仍在 items 里，但那种源不该出现在 map 中（契约：键域 = feeds 表）
    if (entry.readAt === undefined && entry.feedId in perFeedUnread) perFeedUnread[entry.feedId] += 1
  }
  return {
    feeds: table, items, folders: directory, tags,
    unread: accountItems.filter((entry) => entry.readAt === undefined).length,
    perFeedUnread,
    refreshed: false,
  }
}


/**
 * 起一个 DOM 环境 + 加载真实 bundle + 渲染真实 Reader。
 * 返回的 press 派发的是真 KeyboardEvent；box 是**从 DOM 里按标记属性现查的**真实节点
 * （所以它同时验证了「标记属性真的写进了 DOM」）。
 */
/** 本轮 mountReader 的收尾函数登记表：afterEach 统一清（消灭未决 handle ⇒ 变异不再拖死套件）。 */
const liveCleanups = []

async function mountReader({ items = [], feeds, folders, tags = [], article, holdArticle, search, folderApi, duplicates } = {}) {
  const { JSDOM } = STACK
  // P3（gate 调优轮）：挂载前拍全局快照，cleanup 时还原 —— 此前每个 mount 都把
  // window/document/fetch/ResizeObserver 覆盖成新 JSDOM 的桩且从不还原，跨用例的桩污染面
  // 与未决 handle 泄漏叠加，是「runner 内部挂死」的放大器（还原救不了已挂死的用例，
  // 但消灭了「前一条用例的桩污染下一条」这半个失效面）。
  const globalSnapshot = {}
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node', 'KeyboardEvent', 'ResizeObserver', 'fetch']) {
    globalSnapshot[key] = globalThis[key]
  }
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true })
  const win = dom.window
  // 真实 React 需要这些全局；测试进程里逐个覆盖，跑完由 node:test 的进程隔离兜底
  globalThis.window = win
  globalThis.document = win.document
  globalThis.HTMLElement = win.HTMLElement
  globalThis.Element = win.Element
  globalThis.Node = win.Node
  globalThis.KeyboardEvent = win.KeyboardEvent
  // jsdom 无布局引擎：getClientRects 恒为空数组，会让面板的可见性守卫直接 return（实测踩到）。
  // 面板"可见"是这组测试的前提，所以显式补上；这是 jsdom 的能力缺口，不是被测代码的宽容。
  win.Element.prototype.getClientRects = function () { return [{}] }
  // jsdom 没有 ResizeObserver（实测 undefined），而被测代码用它来「内容长高后继续贴底」。
  // 这里装一个**受控桩**：它把所有观察器登记下来，测试据此显式触发「图片进场、内容长高」——
  // 否则那条 bug 在测试里无法表达（真实浏览器里是图片加载驱动的，测试里没有图片）。
  const observers = []
  class ResizeObserverStub {
    constructor(callback) { this.callback = callback; this.targets = [] }
    observe(target) { this.targets.push(target); observers.push(this) }
    unobserve() {}
    disconnect() { observers.splice(observers.indexOf(this), 1) }
  }
  globalThis.ResizeObserver = ResizeObserverStub
  win.ResizeObserver = ResizeObserverStub

  // 全局就位后再加载 React（见 loadStack 的注释：canUseDOM 在模块加载那一刻定值）。
  const React = require_(STACK.reactPath)
  const jsxRuntime = require_(join(STACK.reactPath, 'jsx-runtime'))
  const createRoot = require_(join(STACK.reactDomPath, 'client')).createRoot

  const endpoints = []
  const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
  /**
   * markRead / unmarkRead 的回包**必须带 perFeedUnread**（宿主契约见 src/endpoints.ts 的 accountOf）。
   *
   * 本组用例只测滚动，看着像用不到账目 —— 但打开正文会走 loadArticle 里的「显示即打开」，
   * 它**隐式**调 markRead（不是用例里写出来的调用，所以 grep 不到）。桩件回一个缺字段的信封时，
   * 客户端会把 state.perFeedUnread 覆盖成 undefined，左栏角标当场崩、本组 10 条一起红。
   * 桩件必须守它模仿的那条契约，别指望作品代码替它兜（docs/pitfalls.md 二、2.5 / 2.6）。
   */
  // 可变的宿主夹具：文件夹管理动作会改 feeds/folders，overview 必须反映改后的状态，
  // 否则「操作后左栏和未读数更新」这条验收在 DOM 层根本表达不出来。
  const serverFeeds = (feeds ?? [...new Set(items.map((entry) => entry.feedId))].map((feedId) => ({ id: feedId, title: feedId })))
    .map((feed) => ({ ...feed }))
  let tagSeq = 0
  const serverTags = tags.map((tag) => ({ ...tag }))
  const tagDirectory = () => serverTags.map((tag) => ({
    ...tag, itemCount: items.filter((entry) => (entry.tagIds ?? []).includes(tag.id)).length,
  }))
  const serverFolders = (folders ?? (() => {
    const derived = []
    for (const feed of serverFeeds) {
      if (feed.folder === undefined || feed.folder === '') continue
      let folder = derived.find((entry) => entry.name === feed.folder)
      if (folder === undefined) { folder = { name: feed.folder, feedIds: [] }; derived.push(folder) }
      folder.feedIds.push(feed.id)
    }
    return derived
  })()).map((folder) => ({ name: folder.name, feedIds: [...folder.feedIds] }))
  const account = overviewStub(items, serverFeeds, serverFolders)
  const feedOf = new Map(items.map((entry) => [entry.id, entry.feedId]))
  const markReply = (endpoint, ids) => {
    const delta = endpoint === 'markRead' ? -1 : 1
    for (const id of ids) {
      const feedId = feedOf.get(id)
      if (feedId === undefined || account.perFeedUnread[feedId] === undefined) continue
      account.perFeedUnread[feedId] = Math.max(0, account.perFeedUnread[feedId] + delta)
      account.unread += delta
    }
    return { changed: ids.length, unread: account.unread, perFeedUnread: { ...account.perFeedUnread } }
  }
  let releaseArticle
  const gate = holdArticle === true ? new Promise((resolve) => { releaseArticle = resolve }) : undefined
  const requests = []
  const fetchStub = async (_url, init) => {
    const body = JSON.parse(init.body)
    endpoints.push(body.endpoint)
    requests.push({ endpoint: body.endpoint, payload: body.payload })
    // refresh 与 overview 都回完整 Overview（src/endpoints.ts:112-118）—— 桩件此前把 refresh
    // 回成 {changed,unread}，而面板挂载时走的就是 refresh（index.tsx:184），于是 overview 字段
    // 全是 undefined。这是夹具没守住契约，不是代码该容忍的形状。
    if (body.endpoint === 'overview' || body.endpoint === 'refresh') {
      const folder = body.payload?.folder
      const tagId = body.payload?.tagId
      let visibleItems = folder === undefined
        ? items
        : items.filter((entry) => serverFeeds.some((feed) => feed.id === entry.feedId && feed.folder === folder))
      if (tagId !== undefined) visibleItems = visibleItems.filter((entry) => (entry.tagIds ?? []).includes(tagId))
      return ok(overviewStub(visibleItems, serverFeeds, serverFolders, items, tagDirectory()))
    }
    if (body.endpoint === 'searchItems' && search) return ok(await search(body.payload))
    // 跨源重复提示（M5 03）：客户端一次 load 调一次，桩按用例给的结果回
    if (body.endpoint === 'duplicateHints') return ok({ hints: duplicates ?? [] })
    if (folderApi !== undefined) {
      const custom = await folderApi(body, { feeds: serverFeeds, folders: serverFolders, items })
      if (custom !== undefined) return custom
    }
    if (body.endpoint === 'listTags') return ok({ tags: tagDirectory() })
    if (body.endpoint === 'createTag') {
      const name = String(body.payload?.name ?? '').trim()
      const tag = { id: 'tag-' + (++tagSeq), name }
      serverTags.push(tag)
      return ok({ tag: { ...tag, itemCount: 0 } })
    }
    if (body.endpoint === 'renameTag') {
      const tag = serverTags.find((entry) => entry.id === body.payload?.id)
      if (tag === undefined) return ok({ tag: { id: body.payload?.id, name: body.payload?.name, itemCount: 0 } })
      tag.name = String(body.payload?.name ?? '').trim()
      return ok({ tag: { ...tag, itemCount: items.filter((entry) => (entry.tagIds ?? []).includes(tag.id)).length } })
    }
    if (body.endpoint === 'deleteTag') {
      const id = String(body.payload?.id ?? '')
      const index = serverTags.findIndex((entry) => entry.id === id)
      if (index >= 0) serverTags.splice(index, 1)
      for (const entry of items) entry.tagIds = (entry.tagIds ?? []).filter((tagId) => tagId !== id)
      return ok({ deleted: true })
    }
    if (body.endpoint === 'setItemTags') {
      const item = items.find((entry) => entry.id === body.payload?.itemId)
      const ids = Array.isArray(body.payload?.tagIds) ? [...new Set(body.payload.tagIds)] : []
      if (item !== undefined) item.tagIds = ids
      const current = serverTags.filter((tag) => ids.includes(tag.id))
      return ok({ itemId: body.payload?.itemId, tags: current })
    }
    if (body.endpoint === 'listFolders') return ok({ folders: serverFolders })
    if (body.endpoint === 'createFolder') {
      const name = String(body.payload?.name ?? '').trim()
      serverFolders.push({ name, feedIds: [] })
      return ok({ folders: serverFolders })
    }
    if (body.endpoint === 'renameFolder') {
      const from = String(body.payload?.from ?? '')
      const to = String(body.payload?.to ?? '').trim()
      for (const folder of serverFolders) if (folder.name === from) folder.name = to
      for (const feed of serverFeeds) if (feed.folder === from) feed.folder = to
      return ok({ folders: serverFolders })
    }
    if (body.endpoint === 'deleteFolder') {
      const name = String(body.payload?.name ?? '')
      let detached = 0
      for (let i = serverFolders.length - 1; i >= 0; i -= 1) if (serverFolders[i].name === name) serverFolders.splice(i, 1)
      for (const feed of serverFeeds) if (feed.folder === name) { delete feed.folder; detached += 1 }
      return ok({ folders: serverFolders, detached })
    }
    if (body.endpoint === 'moveFeedToFolder') {
      const feedId = String(body.payload?.feedId ?? '')
      const folder = body.payload?.folder
      const feed = serverFeeds.find((entry) => entry.id === feedId)
      if (feed !== undefined) {
        if (folder === null || folder === undefined || folder === '') delete feed.folder
        else feed.folder = String(folder)
      }
      for (const entry of serverFolders) entry.feedIds = serverFeeds.filter((f) => f.folder === entry.name).map((f) => f.id)
      return ok({ folders: serverFolders })
    }
    if (body.endpoint === 'article') {
      if (gate !== undefined) await gate
      // article 可以是函数：阅读进度的用例需要「a 有进度、b 没有」这种按条目区分的回包
      const payload = typeof article === 'function' ? article(body.payload.itemId) : article
      return ok(payload ?? { itemId: body.payload.itemId, title: 'ART', blocks: [{ kind: 'p', text: '正文' }], paragraphs: ['正文'] })
    }
    if (body.endpoint === 'markRead' || body.endpoint === 'unmarkRead') {
      const ids = Array.isArray(body.payload?.itemIds) ? body.payload.itemIds : []
      return ok(markReply(body.endpoint, ids))
    }
    return ok({ changed: 1, unread: 0 })
  }
  // 在飞请求计数：settle() 用它判断「这一串异步链走完了没有」。
  // 没有它，一个点击触发的 fetch 还没回来，settle 会因为「DOM 暂时没变」提前返回。
  let pendingFetches = 0
  const trackedFetch = async (...args) => {
    pendingFetches += 1
    try { return await fetchStub(...args) } finally { pendingFetches -= 1 }
  }
  globalThis.fetch = trackedFetch
  win.fetch = trackedFetch

  // 让出一次「任务」：React 18 的调度器走 MessageChannel，timers 与它不在同一条队尾。
  // 用同一条通道让路，能保证「先排的 React 工作」在我们这一跳之前跑完 —— 花费是 0，
  // 不是「等 5ms 碰运气」。环境没有 MessageChannel 时退回 0ms 定时器（同一条宏任务）。
  const nextTask = () => new Promise((resolve) => {
    if (typeof win.MessageChannel !== "function") { setTimeout(resolve, 0); return }
    const channel = new win.MessageChannel()
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve() }
    channel.port2.postMessage(0)
  })
  const settle = async ({ timeout = 1000, quietTicks = 2, allowPending = false } = {}) => {
    let mutations = 0
    const observer = new win.MutationObserver(() => { mutations += 1 })
    observer.observe(win.document, { subtree: true, childList: true, attributes: true, characterData: true })
    try {
      let seen = -1
      let quiet = 0
      let ticks = 0
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        // 两个不同任务源各让一跳：React 的调度消息走 MessageChannel，而定时器队列是另一条线，
        // 只让其中一条会漏掉「排在另一条前面的提交」（实测并发下 1/6 轮偶发早退）。
        await nextTask()
        await new Promise((resolve) => setTimeout(resolve, 0))
        ticks += 1
        if (!allowPending && pendingFetches > 0) { quiet = 0; continue }
        if (mutations === seen) {
          quiet += 1
          // 至少两跳：第一跳可能只是把 React 的调度消息排到队尾（此刻 DOM 还没动）。
          if (quiet >= quietTicks && ticks >= 2) return
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
  const rootRef = createRoot(win.document.getElementById('root'))
  rootRef.render(React.createElement(exportsObj.createReader(store)))
  // 首次上屏 = React 真的把 Reader 挂上去了（root 有子节点），不是「睡够 50ms」。
  await waitFor(() => win.document.getElementById('root').childNodes.length > 0, { timeout: 2000, label: 'Reader 首次上屏' })
  // 挂载后组件自己会走一次 refresh（index.tsx:184）—— 等它落地再交给用例。
  await settle()

  /** 按标记属性现取容器 —— 与按键处理器读的是同一个属性，所以它顺带钉住了标记。 */
  const box = (kind) => win.document.querySelector('[data-rss-scroll="' + kind + '"]')
  /**
   * 按 aria-label 找按钮。
   * 为什么不用文本找：按钮上写的是 ↑ / ↓，靠文案定位的测试一改文案就失效；
   * 而 aria-label 是给读屏器的语义契约，改它意味着无障碍语义真的变了（那时才该让测试红）。
   */
  const byLabel = (...labels) => labels
    .map((label) => win.document.querySelector('button[aria-label="' + label + '"]'))
    .filter((el) => el !== null)
  /** 给容器装上可控的滚动几何：jsdom 没有布局，scrollHeight/clientHeight 恒为 0。 */
  const geometry = new WeakMap()
  const arm = (el, { scrollHeight = 3000, clientHeight = 300 } = {}) => {
    let top = 0
    Object.defineProperty(el, 'clientHeight', { get: () => clientHeight, configurable: true })
    Object.defineProperty(el, 'scrollHeight', { get: () => scrollHeight, configurable: true })
    Object.defineProperty(el, 'scrollTop', { get: () => top, set: (next) => { top = next }, configurable: true })
    geometry.set(el, () => top)
    return el
  }
  /**
   * 让测试能显式模拟「内容长高」（懒加载图片进场）。
   * growTo 改的是滚动容器的 scrollHeight，然后手动触发登记过的观察器 ——
   * 这与真实浏览器里「图片载入 → 内容变高 → ResizeObserver 回调」是等价的触发序列。
   */
  const observeContent = (el) => {
    let height = null
    for (const observer of observers) {
      if (observer.targets.some((t) => t === el || el.contains(t))) { height = el; break }
    }
    if (height === null) return undefined
    return {
      growTo: (nextHeight) => {
        Object.defineProperty(el, 'scrollHeight', { get: () => nextHeight, configurable: true })
        for (const observer of observers.slice()) observer.callback([], observer)
      },
    }
  }
  /** 模拟用户自己滚动：改 scrollTop 并派发 scroll 事件（用来验证「滚走即解除贴底」）。 */
  const userScroll = (el, nextTop) => {
    el.scrollTop = nextTop
    el.dispatchEvent(new win.Event('scroll'))
  }
  const press = (key, shiftKey = false) => {
    const event = new win.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
    win.document.dispatchEvent(event)
    return event.defaultPrevented
  }
  /**
   * 收尾：卸载 React root + 关 JSDOM。为什么必须有（2026-10-16 C4-b 实测）：
   * 变异门槛会往产物里注入「断言必红」的缺陷，其中 helpOpen/Esc 族的失效形态会让
   * node:test 的收尾被本夹具留下的未决 handle（React root 的订阅、JSDOM 的 timer）拖住，
   * 整个 judge 套件被拖过 gate 的 120s 悬崖 ⇒ 变异记「套件超时」= 判定无效。
   * 挂起不是判据问题，是夹具的资源泄漏 —— cleanup 把泄漏本体消灭。
   */
  /**
   * 等到「界面把这次动作落地」：没有在飞请求，且 DOM 连续两个 5ms 刻度没有变化。
   *
   * 它不是「等一个猜出来的时长」——它等的是可观测的事件（请求计数归零 + 变更停止）。
   * 之所以需要它而不是每条都写 waitFor：一半以上的动作只产生「重渲染」这一种结果，
   * 没有比「界面不再变化」更精确、又不把测试写成实现细节的业务信号。
   * 超时抛错：界面一直在变（渲染死循环 / 异步链没落地）必须响亮失败，不许静默通过。
   */
  const cleanup = () => {
    try { rootRef.unmount() } catch { /* 已卸载 */ }
    try { dom.window.close() } catch { /* 已关 */ }
    for (const key of Object.keys(globalSnapshot)) {
      try { globalThis[key] = globalSnapshot[key] } catch { /* 还原失败不掩盖用例结果 */ }
    }
  }
  // 登记到模块级收尾表：afterEach 统一调用（用例无需逐一改）
  liveCleanups.push(cleanup)
  return { store, win, endpoints, requests, server: { feeds: serverFeeds, folders: serverFolders }, box, byLabel, arm, observeContent, userScroll, press, exports: exportsObj, release: () => { if (releaseArticle !== undefined) releaseArticle() }, scrollTop: (el) => (geometry.get(el) ?? (() => el.scrollTop))(), cleanup, settle, waitFor }
}

/** 一条最小可用条目。 */
function item(overrides = {}) {
  return {
    id: 'item-1', feedId: 'f', feedTitle: '源', title: '标题',
    link: 'https://example.com/a', readAt: undefined, starred: false,
    fetchedAt: '2026-10-06T00:00:00.000Z', ...overrides,
  }
}

/** 把受控 input/select 的值设进去并派发 React 认的事件（原生 setter 绕过 React 的 value tracker）。 */
function setControlValue(win, element, value) {
  const proto = element.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter === undefined) throw new Error('找不到 ' + element.tagName + ' 的 value setter')
  setter.call(element, value)
  element.dispatchEvent(new win.Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
}

const skip = STACK === undefined ? { skip: '环境缺真实 React/jsdom（见本文件顶部说明）' } : {}

afterEach(() => {
  while (liveCleanups.length > 0) {
    try { liveCleanups.pop()() } catch { /* 收尾失败不掩盖用例结果 */ }
  }
})

test('详情页空格翻页：容器必须在 DOM 里、且按键真的改了它的 scrollTop', skip, async () => {
  // 这个用例就是 2026-10-09 那条缺陷的回归闸门：当时容器存在 state 里被 keydown 闭包捕获，
  // 进详情页后空格是 no-op —— 而旧夹具对此全绿。
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  await h.settle()

  // 列表页：空格应当滚动
  const list = h.arm(h.box('list'))
  assert.equal(h.press(' '), true, '列表页空格应当被接管')
  assert.equal(h.scrollTop(list), 300, '列表页空格应当滚动一屏')

  // 进详情页（走真实按键路径，不走 store 直调 —— 要覆盖「按 V 之后」这个真实时序）
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()
  assert.equal(h.store.get().view, 'article', 'V 应当进入详情页')

  const article = h.box('article')
  assert.ok(article !== null, '详情页必须有 [data-rss-scroll="article"] 容器（按键靠它定位）')
  h.arm(article)
  assert.equal(h.press(' '), true, '详情页空格应当被接管 —— 被闭包捕获时这里是 false')
  assert.equal(h.scrollTop(article), 300, '详情页空格应当滚动一屏')
})

test('详情页 n/p 按「正文一行」滚动，而不是回落到列表行高（48px = 一行半）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()

  const article = h.arm(h.box('article'))
  assert.equal(h.press('n'), true, '详情页 n 应当被接管')
  const step = h.scrollTop(article)
  // 正文块是 16px × 1.85 = 29.6 —— 步长必须来自**正文元素**的行高。
  // 这里刻意钉住具体值：量错对象（量容器）会得到 21.7，那是面板继承来的字号行高，
  // 而回落到列表行高则是 48 —— 两者都是病象，且都能被这个断言区分开。
  assert.equal(step, 29.6, '正文页逐行扫视应当用正文行高（29.6px），实际 ' + step)
  assert.notEqual(step, 48, '退回列表行高 48px 就是老的病象（按一次滚一行半）')
  assert.notEqual(step, 21.7, '量到容器继承的字号行高同样是错的（应当量承载正文的元素）')
})

// 2026-10-10 键位 A 方案：u 归还 GR 原义（左栏显隐），上半页改由 shift+d 承担。
// 本用例（任务 4 落的）原名「d / u 翻半页」，键位随决策更新 —— 断言强度不变，只是把
// 「按 u 向上半页」换成「按 shift+d 向上半页」。真机给的是大写 'D'（shiftKey=true）。
test('详情页 d / shift+d 翻半页（整屏的一半，且夹得住边界）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()

  const article = h.arm(h.box('article'))
  assert.equal(h.press('d'), true, 'd 应当被接管')
  assert.equal(h.scrollTop(article), 150, 'd 应当滚动半屏')
  assert.equal(h.press('D', true), true, 'shift+d 应当被接管 —— 真机上 shift+d 给的是大写 D')
  assert.equal(h.scrollTop(article), 0, 'shift+d 应当滚回原位（接盘原本 u 的上半页）')
  assert.equal(h.press('D', true), true, '顶部再按 shift+d 仍应被接管（只是夹在 0）')
  assert.equal(h.scrollTop(article), 0, '顶部再往上不该越界')
})

test('正文加载中也有容器：空格不再是 no-op（此前容器只存在于加载完成的分支）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })], holdArticle: true })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  // allowPending：正文请求被 gate 故意挂住（这就是被测形态），不能等它回来
  await h.settle({ allowPending: true })
  assert.equal(h.store.get().article?.loading, true, '此刻正文应当还在抓取中')

  const article = h.box('article')
  assert.ok(article !== null, '抓取在途时也必须已有容器 —— 否则按空格毫无反应')
  h.arm(article, { scrollHeight: 3000, clientHeight: 300 })
  assert.equal(h.press(' '), true, '加载中按空格也应当被接管')
  h.release()
})

test('切换文章后阅读位置归零（DOM 节点被复用，scrollTop 不会自己重置）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })] })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()

  const article = h.arm(h.box('article'))
  h.press(' ')
  assert.equal(h.scrollTop(article), 300, '先滚下去一屏')

  // ⚠️ 必须**先取句柄再按键**：arm() 会给节点装一个新的 scrollTop 记录器（初值 0），
  // 换文章之后再 arm 一次，读到的是刚装上去的 0，而不是组件有没有归零 ——
  // 那样的断言永远通过，等于没测（这条是变异门槛查出来的，见 client-换文章不归零）。
  // ⚠️ 这里**不要再 arm 一次**：arm() 会给节点装一个初值为 0 的新记录器，
  // 那样读到的是刚装上去的 0，而不是组件有没有归零 —— 断言永远通过，等于没测。
  // （这条是变异门槛查出来的：client-换文章不归零 一开始是幸存者。）
  h.press('j') // 切下一条
  await h.settle()
  assert.equal(h.store.get().article.itemId, 'b', 'j 应当切到下一条')
  assert.equal(h.box('article'), article, 'React 会复用同一个 DOM 节点（正是需要显式归零的原因）')
  assert.equal(h.scrollTop(article), 0, '换文章后应当从顶部开始读')
})

test('订阅管理页按翻页键不该刷警告（无容器的视图是正常状态，不是异常）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' })] })
  await h.store.load('overview')
  await h.settle()
  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  try {
    h.press('F') // 进订阅管理
    await h.settle()
    assert.equal(h.store.get().view, 'feeds', 'F 应当切到订阅管理')
    h.press(' ')
    h.press('d')
  } finally {
    console.warn = original
  }
  assert.deepEqual(warnings, [], '订阅管理页本来就没有滚动容器，不该产生警告：' + warnings.join(' | '))
})

test('按键守卫不依赖环境全局：本 realm 没有 HTMLElement 时，快捷键照样能用', skip, async () => {
  // 这条钉的是 2026-10-09 实测到的一类故障：isTypingTarget 用 instanceof HTMLElement，
  // 而那个标识符必须在 bundle 所在 realm 的全局里存在。宿主页面与 bundle 不同 realm、
  // 或测试环境没给这个全局时，按键处理器第一行就抛 ReferenceError ——
  // 而事件派发会把异常吞掉，症状只剩「所有快捷键全哑，控制台什么都没有」。
  // 判定改为只看节点自身的 nodeType 之后，这条路径与环境全局完全无关。
  const h = await mountReader({ items: [item({ id: 'a' })] })
  await h.store.load('overview')
  await h.settle()

  const list = h.arm(h.box('list'))
  assert.equal(h.press(' '), true, '基线：正常环境下空格可用')
  assert.equal(h.scrollTop(list), 300, '基线：正常环境下空格滚动一屏')

  // 抹掉本 realm 的 HTMLElement 全局，再按一次 —— 旧实现会在这里整条链路失效
  const saved = globalThis.HTMLElement
  delete globalThis.HTMLElement
  let prevented = null
  let thrown = null
  try {
    prevented = h.press(' ')
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  } finally {
    globalThis.HTMLElement = saved
  }
  assert.equal(thrown, null, '按键处理不该抛错：' + thrown)
  assert.equal(prevented, true, '全局缺失时快捷键仍应被接管（旧实现这里是 false，且毫无提示）')
})

test('右下角箭头按钮：上方回顶部、下方去底部（作用在真实滚动容器上）', skip, async () => {
  // 用户要的是「详情页右下角两个上下排列的箭头」：点击上方回顶部、下方去底部。
  // 这条同时钉住三件事：按钮真的渲染出来了、它们挂的是滚动容器（不是别的节点）、
  // 且点击真的改变了容器的 scrollTop。
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()

  const article = h.arm(h.box('article'), { scrollHeight: 3000, clientHeight: 300 })
  const buttons = h.byLabel('回到文章顶部', '前往文章底部')
  assert.equal(buttons.length, 2, '详情页应当有且只有两个跳转按钮，实际 ' + buttons.length)
  assert.deepEqual(buttons.map((b) => b.textContent), ['↑', '↓'], '应当是上下排列的箭头（上→顶、下→底）')

  // 先滚到中间，再按「去底部」：应当到 maxTop（3000 - 300）
  article.scrollTop = 1200
  buttons[1].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  assert.equal(h.scrollTop(article), 2700, '下方箭头应当把容器滚到底部')

  buttons[0].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  assert.equal(h.scrollTop(article), 0, '上方箭头应当回到文章顶部')
})

test('右下角箭头按钮：加载中/抓取失败时不渲染（那时没有正文可跳）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' })], holdArticle: true })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  // allowPending：正文请求被 gate 故意挂住（这就是被测形态），不能等它回来
  await h.settle({ allowPending: true })
  assert.equal(h.store.get().article?.loading, true, '前置条件：正文仍在抓取中')
  assert.equal(h.byLabel('回到文章顶部', '前往文章底部').length, 0, '加载中不该出现跳转按钮')
  h.release()
})

test('点「↓去底部」后内容长高（懒加载图片进场）：必须继续贴底，而不是差一截', skip, async () => {
  // 用户实测 2026-10-09：新文章首点 ↓ 到不了底、差一小段；先点 ↑ 再点 ↓ 就正常。
  // 根因：正文图片 loading=lazy 且没有固有尺寸 ⇒ 点 ↓ 那一刻的 scrollHeight 只是「当时的」，
  // 图片随后的加载把内容撑高，而 scrollTop 留在原地。这条用**受控的 ResizeObserver** 复现它。
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()

  // 装上可控几何 + 可控观察器：内容「长高」由测试显式触发，不依赖真实图片加载
  const article = h.box('article')
  h.arm(article, { scrollHeight: 3000, clientHeight: 300 })
  const growth = h.observeContent(article)
  assert.ok(growth !== undefined, '需要一个 ResizeObserver 桩：jsdom 没有这个全局')

  const buttons = h.byLabel('回到文章顶部', '前往文章底部')
  buttons[1].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  assert.equal(h.scrollTop(article), 2700, '点击后应当先到底（3000 - 300）')

  // 模拟懒加载图片进场：内容高度从 3000 涨到 3600
  growth.growTo(3600)
  assert.equal(h.scrollTop(article), 3300, '内容长高后必须继续贴底（3600 - 300）—— 否则就是那个 bug')

  // 再长一次仍然贴住（长文里图片是一张张进的）
  growth.growTo(4200)
  assert.equal(h.scrollTop(article), 3900, '连续长高应当一直贴底')
})

test('用户自己滚走后就解除「贴底」：不该把读者硬拽回去', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()

  const article = h.box('article')
  h.arm(article, { scrollHeight: 3000, clientHeight: 300 })
  const growth = h.observeContent(article)
  const buttons = h.byLabel('回到文章顶部', '前往文章底部')

  buttons[1].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  assert.equal(h.scrollTop(article), 2700, '前置：已贴底')

  // 用户自己往上滚（模拟滚轮/滚动条拖动）：scrollTop 变化 + 滚动事件
  h.userScroll(article, 1000)
  growth.growTo(3600)
  assert.equal(h.scrollTop(article), 1000, '用户滚走之后，内容长高不该把他拽回底部')

  // 回到顶部同样解除：之后内容长高也不该动
  buttons[0].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  growth.growTo(4200)
  assert.equal(h.scrollTop(article), 0, '点了「回顶部」之后内容长高不该把位置拉走')
})

/**
 * 左栏（任务 3）：虚拟视图三行 + 订阅源列表 + 每源未读角标。
 *
 * 这一组刻意**走 DOM 而不是 store**：左栏的价值全在「渲染出来了、点得动、角标跟着 showUnread 走」，
 * 只断言 store 的话，「左栏压根没渲染」这种实现也能全绿（本仓库 2026-10-07 的教训：三条变异
 * 在只断言 store 的套件里全部幸存）。
 *
 * 行的定位一律靠 `data-rss-nav-row`（一个稳定标记）而不是序号或文本：左栏上方是虚拟视图三行、
 * 下方是源列表，靠序号定位会让「往上面插一行」变成一次误导性的测试失败。
 */
test('正文页阅读偏好：时长标「估算」、字号/栏宽落到正文、写盘发的是整份偏好', skip, async () => {
  // 固定中英混合夹具：600 CJK 字 ÷ 300 字/分 = 2 分钟，再 + 200 词 ÷ 200 词/分 = 1 分钟，合计 3。
  // 两个速率各占一半，任何一边失效（只数中文 / 只数英文）都会得到 2 而不是 3。
  const payload = {
    itemId: 'a', title: 'ART',
    blocks: [
      { kind: 'p', text: '中'.repeat(600) },
      { kind: 'p', text: Array.from({ length: 200 }, (_, index) => 'word' + index).join(' ') },
    ],
  }
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })], article: payload })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()

  const badge = h.win.document.querySelector('[data-rss-reading-minutes]')
  assert.ok(badge !== null, '正文页必须显示预计阅读时长')
  assert.match(badge.textContent ?? '', /估算/, '必须标明这是估算值，而不是「阅读时间」那种确定口吻')
  assert.equal(badge.getAttribute('data-rss-reading-minutes'), '3', '600 字 + 200 词应当是 3 分钟（中英两套速率各算一半）')

  // 默认档位 = 改动前写死的排版（16px / 760px）：老用户升上来观感不变
  const body = () => h.win.document.querySelector('article.dsh-rss-article-column')
  assert.equal(body().style.fontSize, '16px')
  assert.equal(body().style.maxWidth, '760px')

  // 改字号：正文当场跟着变（不是只把值存起来），并且落盘的是**整份**偏好
  const sizeSelect = h.win.document.querySelector('select[aria-label="正文字号"]')
  assert.ok(sizeSelect !== null, '正文页要有字号选择')
  setControlValue(h.win, sizeSelect, '20')
  await h.settle()
  assert.equal(body().style.fontSize, '20px', '改字号必须当场生效')

  const saved = h.requests.filter((entry) => entry.endpoint === 'saveViewPreferences').at(-1)
  assert.ok(saved !== undefined, '改字号必须落盘（否则重开插件就白改了）')
  const prefs = saved.payload.preferences
  assert.deepEqual(prefs.reading, { fontSize: 20, lineWidth: 760, theme: 'auto' })
  // 写侧是整份覆盖：只发 reading 的话这三项会缺席，宿主就会把它们回落默认
  assert.deepEqual(prefs.navSelection, { kind: 'virtual' }, '写盘必须带上导航选中')
  assert.equal(prefs.filter, 'all', '写盘必须带上 filter')
  assert.equal(prefs.navVisible, true, '写盘必须带上左栏显隐')

  // 改字号后键盘逐行翻页必须跟着新的「正文一行」走：20px × 1.85 = 37。
  // 量不到正文元素时会退回 30 的兜底值 —— 两个数不同，所以这条能区分「真的量到了」。
  const scroller = h.arm(h.box('article'))
  assert.equal(h.press('n'), true, '正文页 n 仍应被接管')
  assert.equal(h.scrollTop(scroller), 37, '逐行步长必须按新字号算（20 × 1.85）')

  // 主题标记：auto 时不覆盖任何颜色（完全继承宿主）
  assert.equal(h.box('article').getAttribute('data-rss-reading-theme'), 'auto')
})

test('阅读进度：切走再回来接着读、滚动不写盘、离开时落盘（M5 02）', skip, async () => {
  // 内容标识与进度都由宿主给：客户端只负责「按比例恢复 + 在离开时把比例交回去」。
  const articleOf = (itemId) => itemId === 'a'
    ? { itemId: 'a', title: 'ART', blocks: [{ kind: 'p', text: '中'.repeat(100) }], contentVersion: '3:aaaa', progress: 0.5 }
    : { itemId: 'b', title: 'ART B', blocks: [{ kind: 'p', text: '另一篇' }], contentVersion: '3:bbbb' }
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })], article: articleOf, holdArticle: true })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })

  // 容器必须**在正文到达之前**装上几何：恢复发生在「内容真的画出来」那一刻
  // React 的重渲染是异步的：view 已切过去但 DOM 还没提交时 box 仍是 null（既有用例都在这里 sleep）
  await h.waitFor(() => h.box('article') !== null, { timeout: 900, label: '正文容器出现' })
  const box = h.arm(h.box('article'), { scrollHeight: 3000, clientHeight: 300 })
  h.release()
  await h.settle()

  assert.equal(h.scrollTop(box), 1350, '0.5 × (3000-300) = 1350：重开同版缓存要回到上次的位置')

  // 滚动本身不许写盘（逐帧写会把库写热）：滚几次都不该有 saveReadingProgress
  const saves = () => h.requests.filter((entry) => entry.endpoint === 'saveReadingProgress')
  h.userScroll(box, 2100)
  h.userScroll(box, 2400)
  await h.settle()
  assert.equal(saves().length, 0, '滚动过程不许产生任何写盘请求')

  // 切换文章 = 离开这篇：此刻落盘，比例就是离开时屏幕上的那一段
  h.press('j')
  await h.settle()
  const saved = saves()
  assert.equal(saved.length, 1, '切换一次应当且只应当写一次')
  assert.equal(saved[0].payload.itemId, 'a', '写的是**离开的那一篇**')
  assert.equal(saved[0].payload.contentVersion, '3:aaaa', '版本标识必须原样回带（宿主按它来决定要不要沿用）')
  assert.ok(Math.abs(saved[0].payload.ratio - 2400 / 2700) < 1e-9, '比例 = 当前 scrollTop / 可滚高度，实际 ' + saved[0].payload.ratio)

  assert.equal(h.store.get().article.itemId, 'b', 'j 应当切到 b')
  assert.equal(h.scrollTop(box), 0, 'b 没有进度 ⇒ 从顶部开始（不沿用上一条的位置）')

  // 关掉正文（组件卸载）= 另一条落盘路径：ref 已经被置空，节点引用要另存
  h.press('Escape')
  await h.settle()
  assert.equal(h.store.get().view, 'list', 'Esc 回列表')
  const afterClose = saves()
  assert.equal(afterClose.length, 2, '卸载也要落盘一次')
  assert.equal(afterClose[1].payload.itemId, 'b')
  assert.equal(afterClose[1].payload.ratio, 0, 'b 停在顶部 ⇒ 记 0')
})

test('跨源重复提示：行内可展开看别的来源，且展开不会把那篇标成已读（M5 03）', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' }), item({ id: 'b', feedId: 'g', feedTitle: '源 G' })],
    duplicates: [{
      itemId: 'a',
      others: [{ itemId: 'b', feedId: 'g', feedTitle: '源 G', title: '同一篇（另一源）', link: 'https://other.example/a' }],
    }],
  })
  await h.store.load('overview')
  await h.settle()

  const hint = h.win.document.querySelector('[data-rss-duplicates="a"]')
  assert.ok(hint !== null, 'a 那一行应当出现跨源重复提示')
  assert.match(hint.textContent ?? '', /另有 1 个来源/, '提示文案要说清「几个来源」')
  const link = hint.querySelector('[data-rss-dupe-item="b"]')
  assert.ok(link !== null, '展开后要能看到别的来源那条')
  assert.match(link.textContent ?? '', /源 G/, '每一行都要标明它来自哪个源')
  assert.equal(link.getAttribute('href'), 'https://other.example/a', '点开是那一源的原文（提示不改任何状态）')

  // 行本身是 role=button（点击会选中 + 标读）：展开提示必须 stopPropagation，不能顺手把文章标读
  assert.equal(h.store.get().items.find((entry) => entry.id === 'a').readAt, undefined, '前置条件：未读')
  const summary = hint.querySelector('summary')
  summary.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
  await h.settle()
  assert.equal(h.store.get().items.find((entry) => entry.id === 'a').readAt, undefined,
    '展开提示不该把那篇文章标成已读（stopPropagation 是承重的）')

  // b 没有提示（桩只给了 a 一条）
  assert.equal(h.win.document.querySelector('[data-rss-duplicates="b"]'), null, '没有候选的行不该凭空多出一行提示')
})

test('左栏渲染：虚拟视图三行 + 每个订阅源一行', skip, async () => {
  // 三个源：一个未读 2 条、一个未读 1 条、一个 0 未读 —— 后者专门用来钉「键域 = feeds 表」：
  // 0 未读的源也必须有一行，且它的角标是 0 而不是空白（缺键在界面上就是「空白 vs 0」无从分辨）。
  const h = await mountReader({
    items: [
      item({ id: 'a', feedId: 'f1', feedTitle: '源一' }),
      item({ id: 'b', feedId: 'f1', feedTitle: '源一' }),
      item({ id: 'c', feedId: 'f2', feedTitle: '源二' }),
    ],
    feeds: [{ id: 'f1', title: '源一' }, { id: 'f2', title: '源二' }, { id: 'f3', title: '源三' }],
  })
  await h.store.load('overview')
  await h.settle()

  const nav = h.win.document.querySelector('[data-rss-nav]')
  assert.ok(nav !== null, '左栏容器必须带 data-rss-nav 标记（任务 4 靠它区分「不是滚动容器」）')
  assert.equal(h.exports.LEFT_NAV_WIDTH, 240, '左栏宽度常量必须是 240')

  const rows = [...h.win.document.querySelectorAll('[data-rss-nav-row]')]
  const labels = rows.map((row) => row.getAttribute('data-rss-nav-row'))
  assert.deepEqual(labels, ['filter:all', 'filter:unread', 'filter:starred', 'feed:f1', 'feed:f2', 'feed:f3'],
    '左栏应当是虚拟视图三行 + 每个订阅源一行；实际 ' + JSON.stringify(labels))
  assert.deepEqual(rows.map((row) => row.getAttribute('data-rss-nav-badge')), [null, null, null, '2', '1', '0'],
    '每个源都要有角标，0 未读的源是 0 而不是空白（perFeedUnread 键域 = feeds 表）')
  // 两个标记各司其职（2026-10-10 任务 6 返工）：
  //   data-rss-nav-cursor   = 键盘光标落在哪一行（shift+n/p 移动的就是它）
  //   data-rss-nav-selected = 哪一行**此刻生效**（点击它不会改变右栏）
  // 初始状态下两者都在「全部」那一行。
  assert.equal(rows[0].getAttribute('data-rss-nav-cursor'), '', '默认光标应当在「全部」那一行')
  assert.equal(rows[0].getAttribute('data-rss-nav-selected'), '', '默认生效的也是「全部」')
  assert.equal(rows[3].getAttribute('data-rss-nav-cursor'), null, '光标不在源那一行')
  assert.equal(rows[3].getAttribute('data-rss-nav-selected'), null, '未选中的源不该高亮')
})

test('隐藏未读计数时左栏角标也消失（GR spec 不变量 8）', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a', feedId: 'f1', feedTitle: '源一' })],
    feeds: [{ id: 'f1', title: '源一' }],
  })
  await h.store.load('overview')
  await h.settle()

  const feedRow = () => h.win.document.querySelector('[data-rss-nav-row="feed:f1"]')
  assert.equal(feedRow().getAttribute('data-rss-nav-badge'), '1', '前置条件：默认显示角标')

  // 走真实交互：点顶栏那个复选框，而不是直调 store.setShowUnread —— 这样「顶栏 / 侧栏徽标 /
  // 左栏角标三者同消」才真的被钉住（三者任一一处漏改，这里就会红）。
  const toggle = [...h.win.document.querySelectorAll('input[type="checkbox"]')][0]
  assert.ok(toggle !== undefined, '应当有「显示未读计数」复选框')
  toggle.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()

  assert.equal(h.store.get().showUnread, false, '前置条件：计数已隐藏')
  assert.equal(feedRow().getAttribute('data-rss-nav-badge'), null,
    '隐藏未读计数后左栏角标必须一起消失 —— 「隐藏」只做一半就是规格不变量 8 的破损')
  // 行本身还在：隐藏的是计数，不是订阅源列表
  assert.ok(feedRow() !== null, '隐藏计数不该把源列表一起藏掉')
})

test('点击某个源：右栏列表只剩该源条目', skip, async () => {
  const h = await mountReader({
    items: [
      item({ id: 'a', feedId: 'f1', feedTitle: '源一' }),
      item({ id: 'b', feedId: 'f2', feedTitle: '源二' }),
      item({ id: 'c', feedId: 'f1', feedTitle: '源一' }),
    ],
    feeds: [{ id: 'f1', title: '源一' }, { id: 'f2', title: '源二' }],
  })
  await h.store.load('overview')
  await h.settle()

  const listTitles = () => [...h.win.document.querySelectorAll('[data-rss-row]')].map((row) => row.getAttribute('data-rss-row'))
  assert.deepEqual(listTitles(), ['a', 'b', 'c'], '前置条件：聚合视图下三条都在')

  // 真实 MouseEvent 派发：走的是 onClick → store.selectNav 的完整接线，不是直调 store
  const row = h.win.document.querySelector('[data-rss-nav-row="feed:f1"]')
  row.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()

  assert.deepEqual(h.store.get().navSelection, { kind: 'feed', feedId: 'f1' }, '点击应当把导航选中切到该源')
  assert.deepEqual(listTitles(), ['a', 'c'], '右栏应当只剩该源的条目')
  assert.equal(
    h.win.document.querySelector('[data-rss-nav-row="feed:f1"]').getAttribute('data-rss-nav-selected'), '',
    '被选中的源应当高亮',
  )
  // 2026-10-10 用户实测反馈后改判：三个过滤标签必须**同等对待**。旧断言写的是「选了源之后
  // 「全部」不该还亮着」，后来又加了一个只为 'all' 开的口子 —— 结果是「未读/星标」亮、「全部」不亮，
  // 用户一眼就当成 bug。现在统一为：生效的过滤行始终点亮（与源行同时亮是正确的，两条正交轴）。
  assert.equal(
    h.win.document.querySelector('[data-rss-nav-row="filter:all"]').getAttribute('data-rss-nav-selected'), '',
    '选中的源要亮，生效的过滤行（这里是「全部」）同样要亮 —— 三个标签一律同等对待',
  )
  // 鼠标点击必须把**键盘光标**同步落到被点的那一行（2026-10-10 任务 6 返工）：
  // 否则光标还停在旧位置，读者接着按 shift+n 会从旧位置跳，而不是从「我刚点的那里」走。
  assert.equal(
    h.win.document.querySelector('[data-rss-nav-row="feed:f1"]').getAttribute('data-rss-nav-cursor'), '',
    '点击某个源之后，光标应当同步落到该行',
  )
  assert.equal(
    h.win.document.querySelector('[data-rss-nav-row="filter:all"]').getAttribute('data-rss-nav-cursor'), null,
    '光标不该还停在「全部」——那正是「键盘从旧位置跳」的成因',
  )

  // 再点同一个源 = 取消（任务 2 已裁决的语义：点亮的项再点一次回到聚合视图）
  h.win.document.querySelector('[data-rss-nav-row="feed:f1"]').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()
  assert.deepEqual(h.store.get().navSelection, { kind: 'virtual' }, '再点同一个源应当取消选中')
  assert.deepEqual(listTitles(), ['a', 'b', 'c'], '取消后应当回到聚合视图')
})

/* ── 切作用域必须退出正文（R2 票 03）────────────────────────────────────────────
 * 右栏正文面的唯一真相是 article.itemId：作用域已经换了、正文却还是上一篇，
 * 读者看到的是一篇不属于当前源/文件夹/标签/过滤的文章。四条用例守着两个入口：
 * 左栏（selectNav：源/文件夹/标签，含「再选同一个 = 取消」分支）与过滤三连（setFilter）。
 * 搜索提交自己回列表，不在这一组里重复实现。 */
test('正文视图下点另一个源：回到列表、旧文章不再显示，且不额外标读/取数', skip, async () => {
  const h = await mountReader({
    items: [
      item({ id: 'a', feedId: 'f1', feedTitle: '源一' }),
      item({ id: 'b', feedId: 'f2', feedTitle: '源二' }),
    ],
    feeds: [{ id: 'f1', title: '源一' }, { id: 'f2', title: '源二' }],
  })
  await h.store.load('overview')
  await h.settle()

  const navRow = (key) => h.win.document.querySelector('[data-rss-nav-row="' + key + '"]')
  const clickNav = (key) => navRow(key).dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  const rows = () => [...h.win.document.querySelectorAll('[data-rss-row]')].map((el) => el.getAttribute('data-rss-row'))

  clickNav('feed:f1')
  await h.settle()
  assert.deepEqual(rows(), ['a'], '前置条件：源一的列表只有 a')

  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.waitFor(() => h.box('article') !== null, { timeout: 900, label: '正文容器出现' })
  assert.equal(h.store.get().article?.itemId, 'a', '前置条件：正在看 a 的正文')

  const marksBefore = h.requests.filter((entry) => entry.endpoint === 'markRead').length
  const articlesBefore = h.requests.filter((entry) => entry.endpoint === 'article').length

  clickNav('feed:f2')
  await h.settle()

  assert.equal(h.store.get().view, 'list', '切到另一个源后必须回到列表，而不是继续停在旧正文')
  assert.equal(h.store.get().article, undefined, '旧正文必须清空 —— 它已经不属于当前作用域')
  assert.equal(h.box('article'), null, '正文容器必须从 DOM 消失，不能把上一源的旧文章留在屏幕上')
  assert.equal(h.box('list')?.style.display, 'block', '列表容器必须重新可见')
  assert.deepEqual(rows(), ['b'], '右栏只显示新源 f2 的条目')
  assert.deepEqual({ ...h.store.get().navSelection }, { kind: 'feed', feedId: 'f2' }, '作用域已切到源二')
  assert.equal(h.store.get().selectedId, 'b', '选中语义不变：落到新作用域的第一条')
  assert.equal(h.requests.filter((entry) => entry.endpoint === 'markRead').length, marksBefore,
    '切源不是打开条目，不许额外标读')
  assert.equal(h.requests.filter((entry) => entry.endpoint === 'article').length, articlesBefore,
    '切源不是打开正文，不许额外取数')
})

test('正文视图下再点同一个源（取消选中）：同样回到列表', skip, async () => {
  const h = await mountReader({
    items: [
      item({ id: 'a', feedId: 'f1', feedTitle: '源一' }),
      item({ id: 'b', feedId: 'f2', feedTitle: '源二' }),
    ],
    feeds: [{ id: 'f1', title: '源一' }, { id: 'f2', title: '源二' }],
  })
  await h.store.load('overview')
  await h.settle()

  const clickFeed1 = () => h.win.document.querySelector('[data-rss-nav-row="feed:f1"]')
    .dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))

  clickFeed1()
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  assert.equal(h.store.get().article?.itemId, 'a', '前置条件：正在看源一的 a')

  // 同一个源再点一次 = 取消选中（既有裁决）；这条分支同样属于「切作用域」，也必须退出正文。
  clickFeed1()
  await h.settle()

  assert.deepEqual({ ...h.store.get().navSelection }, { kind: 'virtual' }, '再选同源应当取消选中')
  assert.equal(h.store.get().view, 'list', '取消选中也必须回到列表，不能停在旧正文')
  assert.equal(h.store.get().article, undefined, '取消选中同样要清空旧正文')
  assert.equal(h.box('article'), null, '正文容器必须消失')
  assert.deepEqual(
    [...h.win.document.querySelectorAll('[data-rss-row]')].map((el) => el.getAttribute('data-rss-row')),
    ['a', 'b'],
    '取消后回到聚合列表',
  )
})

test('正文视图下点文件夹 / 标签：同样回到列表、清空旧文章', skip, async () => {
  const h = await mountReader({
    items: [
      item({ id: 'a', feedId: 'f1', feedTitle: '源一', tagIds: ['t1'] }),
      item({ id: 'b', feedId: 'f2', feedTitle: '源二' }),
    ],
    feeds: [{ id: 'f1', title: '源一', folder: '技术' }, { id: 'f2', title: '源二' }],
    tags: [{ id: 't1', name: '标签一' }],
  })
  await h.store.load('overview')
  await h.settle()

  const navRow = (key) => h.win.document.querySelector('[data-rss-nav-row="' + key + '"]')
  assert.ok(navRow('folder:技术') !== null, '前置条件：文件夹行在左栏')
  assert.ok(navRow('tag:t1') !== null, '前置条件：标签行在左栏')
  // 文件夹行本身是展开/折叠；「进入文件夹」是旁边那个独立的打开按钮（两个动作在 DOM 层分开）。
  const openFolder = () => h.win.document.querySelector('[data-rss-folder-open="技术"]')
    .dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))

  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.waitFor(() => h.box('article') !== null, { timeout: 900, label: '正文容器出现' })

  openFolder()
  await h.settle()
  assert.deepEqual({ ...h.store.get().navSelection }, { kind: 'folder', folder: '技术' }, '作用域已切到文件夹')
  assert.equal(h.store.get().view, 'list', '切文件夹后必须回到列表')
  assert.equal(h.store.get().article, undefined, '切文件夹同样要清空旧正文')
  assert.equal(h.box('article'), null, '正文容器必须消失')

  // 文件夹内的第一条已被 relocate 选中；再开一次正文，再从正文切到标签。
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '再次进入正文页' })
  await h.waitFor(() => h.box('article') !== null, { timeout: 900, label: '正文容器再次出现' })

  navRow('tag:t1').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()
  assert.deepEqual({ ...h.store.get().navSelection }, { kind: 'tag', tagId: 't1' }, '作用域已切到标签')
  assert.equal(h.store.get().view, 'list', '切标签后必须回到列表')
  assert.equal(h.store.get().article, undefined, '切标签同样要清空旧正文')
  assert.equal(h.box('article'), null, '正文容器必须消失')
})

test('正文视图下切「未读 / 星标」过滤：回到列表', skip, async () => {
  const h = await mountReader({
    items: [
      item({ id: 'a', feedId: 'f1', feedTitle: '源一' }),
      item({ id: 'b', feedId: 'f1', feedTitle: '源一', starred: true, readAt: '2026-10-01T00:00:00.000Z' }),
      item({ id: 'c', feedId: 'f1', feedTitle: '源一' }),
    ],
    feeds: [{ id: 'f1', title: '源一' }],
  })
  await h.store.load('overview')
  await h.settle()

  const navRow = (key) => h.win.document.querySelector('[data-rss-nav-row="' + key + '"]')
  const clickFilter = (key) => navRow('filter:' + key).dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))

  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.waitFor(() => h.box('article') !== null, { timeout: 900, label: '正文容器出现' })

  clickFilter('unread')
  await h.settle()
  assert.equal(h.store.get().filter, 'unread', '前置条件：过滤已切到未读')
  assert.equal(h.store.get().view, 'list', '切未读过滤后必须回到列表')
  assert.equal(h.store.get().article, undefined, '切过滤同样要清空旧正文')
  assert.equal(h.box('article'), null, '正文容器必须消失')

  // a 打开即已读，未读范围里剩下 c；再开 c 的正文，然后切「星标」。
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '再次进入正文页' })
  await h.waitFor(() => h.box('article') !== null, { timeout: 900, label: '正文容器再次出现' })
  assert.equal(h.store.get().article?.itemId, 'c', '前置条件：正在看未读的 c')

  clickFilter('starred')
  await h.settle()
  assert.equal(h.store.get().filter, 'starred', '前置条件：过滤已切到星标')
  assert.equal(h.store.get().view, 'list', '切星标过滤后必须回到列表')
  assert.equal(h.store.get().article, undefined, '切过滤同样要清空旧正文')
  assert.equal(h.box('article'), null, '正文容器必须消失')
  assert.deepEqual(
    [...h.win.document.querySelectorAll('[data-rss-row]')].map((el) => el.getAttribute('data-rss-row')),
    ['b'],
    '星标过滤下只剩 b',
  )
})

test('选了「未读」再选源：源与过滤两条轴各自生效，未读行仍亮着（用户实测反馈）', skip, async () => {
  // 用户报的现象：「先选未读，再选源，未读的选择状态丢了」。
  // 实测定性：filter **没有**被清掉（右栏确实只剩该源的未读），丢的是**左栏那一行的点亮** ——
  // 旧的点亮条件是 `selectedFeedId === undefined && filter === view.key`，选了源就整组不亮。
  // 本用例把「功能没丢」与「指示没丢」两件事都钉住：缺前者是 bug，缺后者就是这次反馈的复发。
  const h = await mountReader({
    items: [
      item({ id: 'a', feedId: 'f1', feedTitle: '源一' }),
      item({ id: 'b', feedId: 'f1', feedTitle: '源一', readAt: '2026-10-01T00:00:00.000Z' }),
      item({ id: 'c', feedId: 'f2', feedTitle: '源二' }),
    ],
    feeds: [{ id: 'f1', title: '源一' }, { id: 'f2', title: '源二' }],
  })
  await h.store.load('overview')
  await h.settle()

  const row = (key) => h.win.document.querySelector('[data-rss-nav-row="' + key + '"]')
  const marked = (key) => row(key).getAttribute('data-rss-nav-selected') === ''

  // ① 先点左栏「未读」
  row('filter:unread').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()
  assert.equal(h.store.get().filter, 'unread', '前置条件：过滤切到未读')

  // ② 再点源一
  row('feed:f1').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()

  // ③ 功能：源 × filter 相乘，右栏只剩「源一的未读」
  assert.deepEqual(h.store.get().navSelection, { kind: 'feed', feedId: 'f1' }, '前置条件：已选中源一')
  assert.equal(h.store.get().filter, 'unread', '选源不得把过滤清掉（两条轴相乘，不是二选一）')
  const titles = [...h.win.document.querySelectorAll('[data-rss-row]')].map((el) => el.getAttribute('data-rss-row'))
  assert.deepEqual(titles, ['a'], '右栏应当只剩「源一的未读」，实际 ' + JSON.stringify(titles))

  // ④ 指示：源行与「未读」行都要亮，读者才看得出过滤仍在生效
  assert.equal(marked('feed:f1'), true, '选中的源要亮')
  assert.equal(marked('filter:unread'), true,
    '「未读」仍在对结果收窄，必须继续亮 —— 它一灭，读者就以为过滤被清掉了（用户实测反馈）')
  // 「全部」与「未读」必须一视同仁：曾经为 'all' 开过一个不点亮的口子，
  // 用户实测反馈把它当成 bug（三个标签两个亮一个不亮）—— 一致性优先。
  assert.equal(marked('filter:all'), false, '前置条件：此刻生效的是「未读」，所以「全部」不该亮')
  // 真正的一致性判据：把 filter 切回 all，该亮的换成「全部」
  row('filter:all').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()
  assert.equal(h.store.get().filter, 'all', '前置条件：过滤切回全部')
  assert.equal(marked('filter:all'), true, '「全部」生效时必须点亮 —— 它与其他两个标签同等对待')
})

test('过滤三连只显示一处：左栏可见时顶栏不重复（收起左栏则回落到顶栏）', skip, async () => {
  // 用户实测反馈：左栏顶部与右列顶栏各有一组「全部/未读/星标」，是同一个状态的两个入口，
  // 摆两处会让人问「哪边算数」。定策：左栏可见时由左栏承担，顶栏只在左栏收起时回落显示 ——
  // 这样「收起导航」不会让过滤失去入口，同时任何时刻都只有一处。
  const h = await mountReader({
    items: [item({ id: 'a', feedId: 'f1', feedTitle: '源一' })],
    feeds: [{ id: 'f1', title: '源一' }],
  })
  await h.store.load('overview')
  await h.settle()

  // 左栏那份：虚拟视图三行（带 data-rss-nav-row="filter:*"）
  const navFilterRows = () => h.win.document.querySelectorAll('[data-rss-nav-row^="filter:"]').length
  // 顶栏那份：正文按钮里文本恰好是三个标签之一的
  const toolbarFilterButtons = () => [...h.win.document.querySelectorAll('button')]
    .filter((el) => ['全部', '未读', '星标'].includes((el.textContent ?? '').trim())).length

  assert.equal(navFilterRows(), 3, '前置条件：左栏有虚拟视图三行')
  assert.equal(toolbarFilterButtons(), 0,
    '左栏可见时顶栏不得再放一份同样的过滤按钮 —— 同一状态两处显示，读者会问「哪边算数」（用户实测反馈）')

  // 收起左栏：入口必须回落到顶栏，不能因为「收起导航」就没有过滤入口了
  h.store.toggleNav()
  await h.settle()
  assert.equal(navFilterRows(), 0, '前置条件：左栏已收起')
  assert.equal(toolbarFilterButtons(), 3, '左栏收起后过滤入口应回落到顶栏（3 个按钮）')
})


test('折叠左栏：容器整个从 DOM 消失（不是 width:0 留一条缝）', skip, async () => {
  // 这条是 scripts/mutation-test.mjs 「client-折叠时左栏仍渲染」的判据。
  // 为什么断言「节点不在 DOM 里」而不是断言宽度为 0：jsdom 没有布局引擎，宽度恒为 auto，
  // 断言宽度只能测出实现选的写法、测不出「收起后这一列还在不在」；而任务 3 的精确取值恰恰是
  // 「不占宽度 = 这一列不存在」——「渲染出来但 width:0」会连容器带它的 1px 右边框一起留下。
  const h = await mountReader({
    items: [item({ id: 'a', feedId: 'f1', feedTitle: '源一' })],
    feeds: [{ id: 'f1', title: '源一' }],
  })
  await h.store.load('overview')
  await h.settle()

  // 只断言「在不在 DOM 里」这个布尔量，不要把 jsdom 节点本身交给 assert.equal：
  // 断言失败时 node 会 inspect 实参，而 inspect 一个 jsdom 元素会跑到超时被 SIGKILL
  // （实测 31s、无断言消息，变异门槛只能看到一条「文件级失败」）——判据本身反而变得不可读。
  const navPresent = () => h.win.document.querySelector('[data-rss-nav]') !== null
  const navRowPresent = () => h.win.document.querySelector('[data-rss-nav-row]') !== null

  assert.equal(navPresent(), true, '前置条件：默认展开，左栏在 DOM 里')
  assert.ok(h.box('list') !== null, '前置条件：右栏条目流在 DOM 里')

  // 走 store 的 toggleNav —— 折叠开关的唯一状态源就是这个字段；
  // 本任务不接键位（那是任务 6 的 u 键），所以这里直接翻状态，不虚构一个还不存在的按键。
  h.store.toggleNav()
  await h.settle()

  assert.equal(h.store.get().navVisible, false, '前置条件：已折叠')
  assert.equal(navPresent(), false,
    '折叠必须把左栏整个从 DOM 移除 —— 渲染但 width:0 会留下容器与那道右边框的缝')
  assert.equal(navRowPresent(), false, '折叠时左栏的行也不该还在')
  assert.ok(h.box('list') !== null, '折叠只该影响左栏，右栏条目流不受波及')
})


/**
 * 两列布局之后（2026-10-10 任务 4）：滚动按键必须只作用于右栏。
 *
 * 左栏同样带 overflowY: auto（feed-nav.tsx:51），所以「它会不会被滚」不取决于它能不能滚，
 * 而取决于按键路径现取的那个选择器能不能命中它：左栏打 data-rss-nav，右栏条目流打
 * data-rss-scroll="list"（index.tsx:482）。
 *
 * 为什么两个容器都要装滚动几何：不装的话左栏 scrollTop 恒为 0，「左栏没动」这条断言就退化成
 * 「什么都没发生也通过」。装上之后，「命中错了对象」不再是「查不到节点」这种显式异常，
 * 而是「左栏动了、右栏没动」——一个只有断言能看见的错位。
 *
 * 文档序要点（这条判据的全部力量）：FeedNav 渲染在右栏之前，一旦左栏也被打上
 * data-rss-scroll，document.querySelector 取到的第一个匹配就是左栏 ⇒ 按键去滚左栏，本用例翻红。
 */
test('滚动不误命中左栏：n/p 与空格只滚右栏', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a', feedId: 'f1', feedTitle: '源一' }), item({ id: 'b', feedId: 'f1', feedTitle: '源一' })],
    feeds: [{ id: 'f1', title: '源一' }],
  })
  await h.store.load('overview')
  await h.settle()

  // 只取布尔量再断言：把 jsdom 节点本身交给 assert，失败时 node 会 inspect 它直到超时被 SIGKILL，
  // 断言文案永远打不出来（docs/pitfalls.md §2.8 实测 31s）。变异门槛天天走「断言会失败」这条路。
  const nav = h.win.document.querySelector('[data-rss-nav]')
  assert.equal(nav !== null, true, '前置条件：两列布局下左栏在 DOM 里')
  const navHasScrollAttr = () => h.win.document.querySelector('[data-rss-nav]').getAttribute('data-rss-scroll') !== null
  assert.equal(navHasScrollAttr(), false, '承重判定：左栏不得带 data-rss-scroll，带上就会被滚动选择器命中')

  // 两个容器都装几何：左栏「可滚」是前提（否则断的不是本任务守的东西）
  h.arm(nav, { scrollHeight: 3000, clientHeight: 300 })
  const list = h.arm(h.box('list'), { scrollHeight: 3000, clientHeight: 300 })

  // n / p：逐行扫视
  assert.equal(h.press('n'), true, 'n 应当被接管')
  assert.equal(h.scrollTop(list), 48, '右栏应当下滚一行（jsdom 量不到行高，用列表兜底 48）')
  assert.equal(h.scrollTop(nav), 0, 'n 不得滚左栏')
  assert.equal(h.press('p'), true, 'p 应当被接管')
  assert.equal(h.scrollTop(list), 0, 'p 应当把右栏滚回顶部')
  assert.equal(h.scrollTop(nav), 0, 'p 不得滚左栏')

  // 空格：翻整屏，同样只作用右栏
  assert.equal(h.press(' '), true, '空格应当被接管')
  assert.equal(h.scrollTop(list), 300, '空格应当把右栏滚一屏')
  assert.equal(h.scrollTop(nav), 0, '空格不得滚左栏 —— 两列之后「按键只作用右栏」就是这条')
})

/**
 * 左栏键盘流（2026-10-10 两列布局任务 6，用户拍板 A 方案）。
 *
 * 四条键位：`u` = 左栏显隐（GR §3.8 第 250 行，原为「向上半页」）、`shift+n/p` = 导航内移动选中
 * （§3.8 第 209 行）、`shift+o` = 打开导航选中项（§3.8 第 212 行）。
 *
 * 为什么这一组必须走真实 DOM 而不是直调 store（本仓库 2026-10-07 的教训：三条接线变异在只断言
 * store 的套件里全部幸存）：键位→动作→store→渲染这条链上任何一环断了，症状都是「按键毫无反应」，
 * 只有对着渲染出来的左栏断言才看得见。判据一律用 `data-rss-nav-selected` / `data-rss-nav` 这类
 * 已有标记定位 —— 序号会因为「往上面插一行」而误导。
 */
test('u 键折叠/展开左栏：走真实按键路径，且正文页不接管（与 o 键同一条裁决）', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a', feedId: 'f1', feedTitle: '源一' })],
    feeds: [{ id: 'f1', title: '源一' }],
  })
  await h.store.load('overview')
  await h.settle()

  const navPresent = () => h.win.document.querySelector('[data-rss-nav]') !== null
  assert.equal(navPresent(), true, '前置条件：默认展开，左栏在 DOM 里')

  assert.equal(h.press('u'), true, 'u 应当被接管 —— 2026-10-10 之前它在这里是「向上半页」')
  await h.settle()
  assert.equal(h.store.get().navVisible, false, 'u 第一次按下应当折叠左栏')
  assert.equal(navPresent(), false, '折叠后左栏容器必须整个消失（不是 width:0）')

  assert.equal(h.press('u'), true, '再按一次 u 仍应被接管')
  await h.settle()
  assert.equal(navPresent(), true, '再按 u 应当把左栏找回来')

  // 正文页里 u 不改「背后那个看不见的左栏」（与 o 键同一裁决，见 keys 帮助行旁的注释）
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()
  assert.equal(h.store.get().view, 'article', '前置条件：已进正文页')
  assert.equal(h.press('u'), false, '正文页的 u 不该被接管（左栏属于背后的东西）')
  assert.equal(h.store.get().navVisible, true, '正文页按 u 不该动左栏 —— 否则回列表时导航莫名没了')
})

test('shift+n / shift+p 在左栏导航里移动选中（不是右栏文章列表的 j/k）', skip, async () => {
  // 数据形状按断言设计：a = 已读 + 星标（好让它只在「星标 / 源一 / 全部」里出现），
  // b = 未读 + 未星标。这样每换一行，右栏内容都有肉眼可辨的变化，
  // 「左栏高亮动了、右栏纹丝不动」这种半截接线才会被抓住。
  const h = await mountReader({
    items: [
      item({ id: 'a', feedId: 'f1', feedTitle: '源一', starred: true, readAt: '2026-10-01T00:00:00.000Z' }),
      item({ id: 'b', feedId: 'f2', feedTitle: '源二' }),
    ],
    feeds: [{ id: 'f1', title: '源一' }, { id: 'f2', title: '源二' }],
  })
  await h.store.load('overview')
  await h.settle()

  /**
   * 左栏**光标**行（键盘高亮）与**生效**行（选中项）是两个标记，刻意分开：
   * 规格 §2.4 的「移动」只动光标，而「哪一行此刻生效」必须仍然看得见（否则读者不知道
   * 自己按 shift+o 会打开什么）。两个定位器都不靠行序号 —— 往左栏上面插一行不该误导测试。
   */
  const rowWith = (attr) => {
    const on = [...h.win.document.querySelectorAll('[data-rss-nav-row]')]
      .find((row) => row.getAttribute(attr) !== null)
    return on === undefined ? null : on.getAttribute('data-rss-nav-row')
  }
  /** 键盘光标所在行（shift+n/p 移动的就是它）。 */
  const cursorRow = () => rowWith('data-rss-nav-cursor')
  /** 当前**生效**的视图那一行（= 点击它不会改变右栏）。 */
  const selectedRow = () => rowWith('data-rss-nav-selected')
  /** 右栏列表当前显示的条目 id（导航换源/换 filter 之后必须跟着变）。 */
  const listIds = () => [...h.win.document.querySelectorAll('[data-rss-row]')].map((row) => row.getAttribute('data-rss-row'))

  assert.equal(selectedRow(), 'filter:all', '前置条件：默认高亮左栏第一行「全部」')
  assert.deepEqual(listIds(), ['a', 'b'], '前置条件：聚合视图两条都在')

  // ── 规格 §2.4 的核心：shift+n 是**移动**，不是**打开** ─────────────────────────────
  // 移动光标之后：左栏高亮走一行，而**生效视图与右栏内容一个字都不许变**。
  // 这条断言就是「移动 ≠ 打开」的可断言形式（第一版实现让两者塌缩，这条会当场红）。
  assert.equal(h.press('N', true), true, 'shift+n 应当被接管')
  await h.settle()
  assert.equal(cursorRow(), 'filter:unread', 'shift+n 应当把左栏光标移到下一行')
  assert.equal(selectedRow(), 'filter:all', '而「生效」那一行仍是「全部」—— 光标与生效是两件事')
  assert.equal(h.store.get().filter, 'all', '移动光标**不改变**生效的 filter（打开才改 —— 规格 §2.4）')
  assert.deepEqual(listIds(), ['a', 'b'], '移动光标**不改变**右栏列表内容')
  assert.deepEqual({ ...h.store.get().navSelection }, { kind: 'virtual' }, '移动光标**不选中**任何源')

  // 小写 n 是「扫视」：滚动视野但**不改变选中**，尤其不该动左栏高亮（两条轴不能互相顶掉）
  assert.equal(h.press('n'), true, '小写 n 仍应被接管（扫视）')
  await h.settle()
  assert.equal(cursorRow(), 'filter:unread', '小写 n 不得改变左栏光标')
  assert.equal(h.store.get().filter, 'all', '小写 n 不得改变生效的 filter')

  // 继续向下走到源列表，再往回；到头/到尾要夹住而不是绕回。全程右栏纹丝不动。
  h.press('N', true); await h.settle()
  assert.equal(cursorRow(), 'filter:starred', '第三行是星标')
  h.press('N', true); await h.settle()
  assert.equal(cursorRow(), 'feed:f1', '跳过虚拟视图三行后进入源列表')
  h.press('N', true); await h.settle()
  assert.equal(cursorRow(), 'feed:f2', '再下一行是第二个源')
  assert.deepEqual(listIds(), ['a', 'b'], '一路移动到底，右栏仍是聚合视图 —— 光标走过谁都不等于打开谁')
  h.press('N', true); await h.settle()
  assert.equal(cursorRow(), 'feed:f2', '已经是最后一行，shift+n 应当夹住不动')
  assert.equal(h.press('N', true), true, '夹住时按键仍应被接管（不是「键坏了」）')

  h.press('P', true); await h.settle()
  assert.equal(cursorRow(), 'feed:f1', 'shift+p 应当回到上一行')
  for (let i = 0; i < 4; i += 1) { h.press('P', true); await h.settle() }
  assert.equal(cursorRow(), 'filter:all', '一路向上应当停在第一行（到头夹住，不绕回）')
  assert.equal(selectedRow(), 'filter:all', '全程没打开过任何一行，「生效」始终是「全部」')

  // ── 只有 shift+o 才让光标那一行生效 ────────────────────────────────────────────────
  h.press('N', true); await h.settle()          // 光标 → 未读
  h.press('N', true); await h.settle()          // 光标 → 星标
  h.press('N', true); await h.settle()          // 光标 → 源一
  assert.deepEqual(listIds(), ['a', 'b'], '前置条件：光标走到源一，右栏仍是聚合视图')
  assert.equal(h.press('O', true), true, 'shift+o 应当被接管')
  await h.settle()
  assert.deepEqual({ ...h.store.get().navSelection }, { kind: 'feed', feedId: 'f1' }, 'shift+o 打开源一 = 选中它')
  assert.deepEqual(listIds(), ['a'], '打开之后右栏才切到源一（a 是它的条目）')
})

/**
 * shift+o 的语义（GR spec §3.8 第 212 行 / 规格 §2.4）：**打开**导航中当前选中的项 —— 「打开」就是
 * 「点击它」。与 shift+n/p 的「移动」是两件事（第一版让两者塌缩成一行，本条用例当时把那个**缺陷状态**
 * 当行为钉住了；返工后按规格改写 —— 光标在哪 ≠ 哪一行生效）。
 *
 * 这条用例刻意用**两个独立挂载**做对照：两边从同一起点出发，一边「移动到某行 + shift+o」，一边
 * 「鼠标点那一行」，最终状态必须逐字段相等。绕开「同一个 store 里先后做两件事」那种比法 ——
 * 那样比出来的相等可能只是「第二次没生效」。
 *
 * 数据形状按断言设计：a = 已读 + 星标，b = 未读 + 未星标。于是每一行都有肉眼可辨的内容。
 */
test('shift+o 打开光标所在行 = 等价于点击它（虚拟视图 → setFilter，源 → selectNav）', skip, async () => {
  const items = [
    item({ id: 'a', feedId: 'f1', feedTitle: '源一', starred: true, readAt: '2026-10-01T00:00:00.000Z' }),
    item({ id: 'b', feedId: 'f2', feedTitle: '源二' }),
  ]
  const feeds = [{ id: 'f1', title: '源一' }, { id: 'f2', title: '源二' }]
  const mount = async () => {
    const h = await mountReader({ items, feeds })
    await h.store.load('overview')
    await h.settle()
    return h
  }
  const snapshot = (h) => {
    const state = h.store.get()
    return {
      navSelection: { ...state.navSelection },
      filter: state.filter,
      selectedId: state.selectedId,
      list: [...h.win.document.querySelectorAll('[data-rss-row]')].map((row) => row.getAttribute('data-rss-row')),
    }
  }

  // ① 光标停在虚拟视图那一行（此刻是「全部」）时按 shift+o = 打开它。必须**幂等**：
  //    不能自作主张换成别的 filter —— 否则按一下 shift+o 就把读者的过滤换掉了。
  const h = await mount()
  assert.deepEqual(snapshot(h), { navSelection: { kind: 'virtual' }, filter: 'all', selectedId: 'a', list: ['a', 'b'] },
    '前置条件：初始是聚合视图')
  assert.equal(h.press('O', true), true, 'shift+o 应当被接管')
  await h.settle()
  assert.deepEqual(snapshot(h), { navSelection: { kind: 'virtual' }, filter: 'all', selectedId: 'a', list: ['a', 'b'] },
    '虚拟视图行上的 shift+o 应当等价于打开「全部」，不产生副作用')

  // ② 键盘路径：移动到「星标」行（移动本身不生效），再 shift+o —— 此刻才落作用域。
  const viaKey = await mount()
  const keyMoves = (h, n) => (async () => { for (let i = 0; i < n; i += 1) { h.press('N', true); await h.settle() } })()
  await keyMoves(viaKey, 2) // 全部→未读→星标
  assert.deepEqual(snapshot(viaKey), { navSelection: { kind: 'virtual' }, filter: 'all', selectedId: 'a', list: ['a', 'b'] },
    '走到「星标」行时右栏必须还是聚合视图 —— 移动不等于打开')
  assert.equal(viaKey.press('O', true), true, 'shift+o 应当被接管')
  await viaKey.settle()
  const afterKey = snapshot(viaKey)
  assert.equal(afterKey.filter, 'starred', '打开「星标」行之后 filter 才变成 starred')
  assert.deepEqual(afterKey.list, ['a'], '右栏随之只剩星标条目')

  // ③ 鼠标路径：从同一起点直接点「星标」那一行 —— 两条路径最终状态必须逐字段相等。
  const viaMouse = await mount()
  viaMouse.win.document.querySelector('[data-rss-nav-row="filter:starred"]')
    .dispatchEvent(new viaMouse.win.MouseEvent('click', { bubbles: true }))
  await viaMouse.settle()
  assert.deepEqual(snapshot(viaMouse), afterKey, '键盘「移动到该行 + shift+o」与鼠标点击该行必须落到同一份状态')

  // ④ 源行同样等价于点击：键盘移动 + shift+o 对比鼠标点击同一行
  const viaKeyFeed = await mount()
  await keyMoves(viaKeyFeed, 3) // 全部→未读→星标→源一
  assert.equal(viaKeyFeed.press('O', true), true, '源行上的 shift+o 应当被接管')
  await viaKeyFeed.settle()
  const afterKeyFeed = snapshot(viaKeyFeed)
  assert.deepEqual(afterKeyFeed.navSelection, { kind: 'feed', feedId: 'f1' }, '打开源一 = 选中它')

  const viaMouseFeed = await mount()
  viaMouseFeed.win.document.querySelector('[data-rss-nav-row="feed:f1"]')
    .dispatchEvent(new viaMouseFeed.win.MouseEvent('click', { bubbles: true }))
  await viaMouseFeed.settle()
  assert.deepEqual(snapshot(viaMouseFeed), afterKeyFeed, '源行上两条路径必须落到同一份状态')
})

test('左栏折叠时 shift+n/p/o 不生效：不许改一个看不见的导航', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a', feedId: 'f1', feedTitle: '源一' })],
    feeds: [{ id: 'f1', title: '源一' }],
  })
  await h.store.load('overview')
  await h.settle()

  h.press('u'); await h.settle()
  assert.equal(h.store.get().navVisible, false, '前置条件：左栏已折叠')
  const before = JSON.stringify(snapshotState(h))

  assert.equal(h.press('N', true), false, '折叠时 shift+n 不该被接管')
  assert.equal(h.press('P', true), false, '折叠时 shift+p 不该被接管')
  assert.equal(h.press('O', true), false, '折叠时 shift+o 不该被接管')
  await h.settle()
  assert.equal(JSON.stringify(snapshotState(h)), before, '折叠时左栏导航键不得改动任何状态')

  h.press('u'); await h.settle()
  assert.equal(h.store.get().navVisible, true, '前置条件：左栏已展开')
  assert.equal(h.press('N', true), true, '展开后 shift+n 恢复可用')
})

/**
 * 从**指定元素**上派发按键（模拟真实浏览器：target 就是当前焦点）。
 * harness 的 press 只能打在 document 上，而「焦点在浮窗里 / 在输入框里」这两种守卫行为
 * 只有指定 target 才表达得出来 —— 它们恰恰是键盘流最容易静默失效的两处。
 */
function pressFrom(h, element, key, shiftKey = false) {
  const event = new h.win.KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  element.dispatchEvent(event)
  return event.defaultPrevented
}

/** 左栏导航键可改动的状态面：这几个字段任一被悄悄改了，都是「看不见的导航被动了」。 */
function snapshotState(h) {
  const state = h.store.get()
  return {
    navVisible: state.navVisible,
    navSelection: state.navSelection,
    navCursor: state.navCursor,
    filter: state.filter,
    selectedId: state.selectedId,
  }
}

/**
 * 帮助浮窗（2026-10-10）。用户拍板：非模态（后台键继续生效）、三个关闭出口（Esc / ? / ✕）、
 * 头部只留最右端一个 ? 入口、内容逐行来自 keys.ts 的 READER_KEY_HELP。
 *
 * 这一组的每一环都能失败成「按了没反应」：键位没接上、开合状态没进 keydown effect 的依赖数组
 * （闭包捕获）、浮窗被自己的守卫吃掉（焦点在浮窗里时）、提示行删了而浮窗没画出来。
 * 只断言 resolveReaderKey 或 store 的测试对这些一律看不见。
 */
test('? 开合帮助浮窗：浮窗逐行画出来自 keys.ts 的帮助表', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' })] })
  await h.store.load('overview')
  await h.settle()
  const help = () => h.win.document.querySelector('[data-rss-help]')
  assert.equal(help(), null, '前置条件：默认不该有浮窗')

  assert.equal(h.press('?'), true, '? 应当被接管（不被宿主或浏览器抢走）')
  await h.settle()
  assert.notEqual(help(), null, '按 ? 之后应当出现帮助浮窗')

  // 内容逐行核对而不是抽查两个词：少的正是「表里有一行、浮窗没画」这类脱节
  const text = help().textContent ?? ''
  for (const section of READER_KEY_HELP) {
    for (const entry of section.entries) {
      assert.ok(text.includes(entry.label), '浮窗里缺了这一行的键位写法：' + entry.label)
    }
  }

  assert.equal(h.press('?'), true, '再按一次 ? 仍应被接管')
  await h.settle()
  assert.equal(help(), null, '再按 ? 应当关闭浮窗（开合同一个键）')
})

test('头部只留最右端一个 ? 入口：那行塞满键位的提示行必须真的没了', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' })] })
  await h.store.load('overview')
  await h.settle()

  // 提示行的指纹：删掉之后这两个词不该再出现在面板里（浮窗里的写法是「j / k」与「n / p」，不会误命中）
  const body = h.win.document.body.textContent ?? ''
  assert.equal(body.includes('j/k 移动'), false, '头部那行键位提示又被写回来了')
  assert.equal(body.includes('n/p 扫视'), false, '头部那行键位提示又被写回来了')

  const entry = h.win.document.querySelector('button[aria-label="快捷键帮助"]')
  assert.notEqual(entry, null, '头部应当有 ? 帮助入口')
  assert.equal(entry.getAttribute('aria-expanded'), 'false', '收起态应当反映到 aria-expanded')
  entry.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()
  assert.notEqual(h.win.document.querySelector('[data-rss-help]'), null, '点击 ? 入口应当打开浮窗')
  assert.equal(entry.getAttribute('aria-expanded'), 'true', '展开态应当反映到 aria-expanded')
})

test('Esc 关浮窗且不穿透：正文页里只收浮窗，不把文章一起关掉', STACK === undefined ? { skip: '环境缺真实 React/jsdom（见本文件顶部说明）' } : { timeout: 8000 }, async () => {
  // ⚠️ timeout: 8000（2026-10-16 C4-b 实测）：helpOpen/Esc 族变异会让本用例在 node:test 下
  // 挂起（断言必红，但 runner 的收尾被前面 mountReader 留下的未决 handle 拖住）⇒ judge 套件
  // 被拖过 gate 的 120s 悬崖，变异记「套件超时」= 判定无效。node:test 原生 timeout 把「挂起」
  // 变成「响亮的红」——红才是被抓住；判据本身（断言序列）未动。
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()
  assert.equal(h.store.get().view, 'article', '前置条件：已进正文页')

  assert.equal(h.press('?'), true, '正文页里 ? 也该能用（帮助不随视图分流）')
  await h.settle()
  assert.notEqual(h.win.document.querySelector('[data-rss-help]'), null, '前置条件：浮窗已开')

  assert.equal(h.press('Escape'), true, 'Esc 应当被接管')
  await h.settle()
  assert.equal(h.win.document.querySelector('[data-rss-help]'), null, 'Esc 应当关掉浮窗')
  assert.equal(h.store.get().view, 'article', '第一次 Esc 只关浮窗 —— 不许顺手把文章也关了')

  h.press('Escape')
  await h.settle()
  assert.equal(h.store.get().view, 'list', '浮窗已关，第二次 Esc 回到原来的语义（正文 → 列表）')
})

test('✕ 关闭；焦点落在浮窗里之后 ? 与 Esc 仍然有效（非模态不许被自己的守卫吃掉）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' })] })
  await h.store.load('overview')
  await h.settle()
  h.press('?'); await h.settle()

  const close = h.win.document.querySelector('button[aria-label="关闭快捷键帮助"]')
  assert.notEqual(close, null, '浮窗应当有一个 ✕ 关闭按钮')
  // 真实浏览器里点按钮会把焦点给它 —— 这里也把焦点放过去，再**从它身上**派发按键。
  // 这是本用例的全部要点：浮窗若用了 role="dialog" / aria-modal，isTypingTarget 会把从浮窗内
  // 发出的按键全部吞掉（含 Esc），? 与 Esc 当场变哑。
  close.focus()
  assert.equal(h.win.document.activeElement, close, '前置条件：焦点在 ✕ 上')
  assert.equal(pressFrom(h, close, '?'), true, '焦点在浮窗里时 ? 仍应被接管')
  await h.settle()
  assert.equal(h.win.document.querySelector('[data-rss-help]'), null, '再按 ? 应当关掉浮窗')

  h.press('?'); await h.settle()
  const close2 = h.win.document.querySelector('button[aria-label="关闭快捷键帮助"]')
  close2.focus()
  assert.equal(pressFrom(h, close2, 'Escape'), true, '焦点在浮窗里时 Esc 仍应被接管')
  await h.settle()
  assert.equal(h.win.document.querySelector('[data-rss-help]'), null, 'Esc 应当关掉浮窗')

  h.press('?'); await h.settle()
  h.win.document.querySelector('button[aria-label="关闭快捷键帮助"]')
    .dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()
  assert.equal(h.win.document.querySelector('[data-rss-help]'), null, '点 ✕ 应当关掉浮窗')
})

test('非模态：浮窗开着时 j 仍然作用于背后的列表（这是拍板结论，不是默认行为）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  await h.settle()
  const before = h.store.get().selectedId
  h.press('?'); await h.settle()
  assert.notEqual(h.win.document.querySelector('[data-rss-help]'), null, '前置条件：浮窗已开')
  assert.equal(h.press('j'), true, '浮窗开着时 j 仍应被接管')
  await h.settle()
  assert.notEqual(h.store.get().selectedId, before, '浮窗开着时 j 必须照旧移动背后的选中项（非模态）')
})

test('输入框里的 ? 不触发帮助（别抢正在打字的人的键）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' })] })
  await h.store.load('overview')
  await h.settle()
  // 头部那个「显示未读计数」复选框是面板里真实存在的 input（左栏角标用例也在用它定位）
  const checkbox = [...h.win.document.querySelectorAll('input[type="checkbox"]')][0]
  assert.notEqual(checkbox, undefined, '前置条件：头部有复选框')
  assert.equal(pressFrom(h, checkbox, '?'), false, '从输入框发出的 ? 不该被接管')
  await h.settle()
  assert.equal(h.win.document.querySelector('[data-rss-help]'), null, '输入框里的 ? 不该弹出帮助')
})

test('o 键：同一行连按两次必须收起（依赖数组里的 expanded 是承重的）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a', summary: '这一段正文摘录，展开之后才出现在行里' })] })
  await h.store.load('overview')
  await h.settle()
  const row = h.win.document.querySelector('[data-rss-row="a"]')
  assert.ok(row !== null, '前置条件：列表里有这一行')
  // 展开态会多渲染一段摘录（index.tsx 的 isOpen 分支），所以行长度就是「是否展开」的可观察量。
  const sizeNow = () => row.innerHTML.length

  h.press('o'); await h.settle()
  const afterOpen = sizeNow()
  assert.ok(afterOpen > 0, '前置条件：第一次按 o 应当展开')

  h.press('o'); await h.settle()
  const afterSecondO = sizeNow()

  assert.ok(afterSecondO < afterOpen, '第二次按 o 必须收起 —— 若 expanded 不在依赖数组里，监听器读到的是注册那一刻的 undefined，于是永远「展开」而收不起来（行长度 ' + afterOpen + ' → ' + afterSecondO + '）')
})

/* ==================== C4-b 迁入（原 tests/client-bundle.test.mjs 假 React 层） ==================== */
/* 这一组原来长在假 React 层，但它们的判据本体是「监听器 × 真渲染」—— useEffect 忽略
 * 依赖数假的仿真层无法表达，如今由真 React 18 + jsdom 承载（迁入时判据逐字保真）。 */

test('C4-b 迁入：A 的撤销窗口 5 秒后自动撤掉（此前 until 只写不读，撤销条常驻）', skip, async () => {
  // 本用例首版等了**真的 5 秒**墙钟 —— 判据更硬，但把 judge 套件基线从 ~7s 抬到 ~11.6s，
  // K=6 并行下直接越过 gate 的 120s 套件悬崖（实测：本轮 gate 两条变异假「套件超时」）。
  // 退回「捕获定时器 + 手动触发」：虚拟化的**只有墙钟等待**，「5000ms 这个窗口时长」
  // 本身改为断言钉住；真实渲染 / 监听器 / store 全保留。悬崖是 gate 侧的结构病
  //（C1 终审 C1+I1 已记），等 gate 调优轮修，不在测试侧硬扛。
  const realSetTimeout = globalThis.setTimeout
  const timers = []
  globalThis.setTimeout = (fn, ms) => {
    if (ms === 5000) { timers.push({ fn, ms }); return 0 }
    return realSetTimeout(fn, ms)
  }
  try {
    const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
    await h.store.load('overview')
    await h.store.markAllRead()

    const armed = timers.find((entry) => entry.ms === 5000)
    assert.ok(armed !== undefined, 'markAll 必须给撤销窗口上 5000ms 定时器；实捕：' + JSON.stringify(timers.map((entry) => entry.ms)))
    assert.ok(h.store.get().undo !== undefined, '刚标完应当有撤销条')

    armed.fn()
    assert.equal(h.store.get().undo, undefined, '窗口到期后撤销条必须消失')
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
})

test('C4-b 迁入：o 展开并触发 markRead 端点（副作用不能漏）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  h.press('o')
  await h.settle()
  assert.ok(
    h.endpoints.includes('markRead'),
    'o 必须触发 markRead 端点；实际端点：[' + h.endpoints.join(', ') + ']',
  )
})

test('C4-b 迁入：1 切展开视图、2 切回列表（且默认是列表 = 既有行为）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  assert.equal(h.store.get().layout, 'list', '默认必须是紧凑列表 —— 这是本插件既有行为')
  h.press('1')
  await h.settle()
  assert.equal(h.store.get().layout, 'expanded', '1 必须切到展开视图')
  h.press('2')
  await h.settle()
  assert.equal(h.store.get().layout, 'list', '2 必须切回列表视图')
})

test('C4-b 迁入：j / k 经真实监听器驱动选中项（接线判据在真 DOM 层安家）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })] })
  await h.store.load('overview')
  const before = h.store.get().selectedId
  h.press('j')
  await h.settle()
  assert.notEqual(h.store.get().selectedId, before, 'j 必须移动选中项 —— 不动说明接线的某一环断了')
  h.press('k')
  await h.settle()
  assert.equal(h.store.get().selectedId, before, 'k 必须移回来')
})

test('C4-b 迁入：未绑定的键不动任何状态（不误触发）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  const snapshot = JSON.stringify(h.store.get())
  h.press('z')
  await h.settle()
  assert.equal(JSON.stringify(h.store.get()), snapshot, '未绑定的键不该改任何状态')
})

test('C4-b 判定：行高量不到（offsetHeight=0）时按列表兜底 48 滚，而不是按 0 滚（量错对象的「有值但不正确」是实测事故）', skip, async () => {
  // 判据的现场：measureRowHeight 读 [data-rss-row] 的 offsetHeight，判定是
  // Number.isFinite(height) && height > 0 —— 取反掉「0 行高」后必须落 LIST_ROW_STEP_FALLBACK(48)，
  // 而不是把 0 当有效步长（按 0 滚 = 键盘扫视静默失效）。真 DOM 层才能把「行高=0」表达出来。
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })] })
  await h.store.load('overview')
  const listBox = h.box('list')
  assert.ok(listBox !== null, '前置：列表滚动容器在 DOM 里')
  h.arm(listBox, { scrollHeight: 3000, clientHeight: 300 })
  // 把唯一一行的 offsetHeight 打成 0（jsdom 本就无布局，这里显式钉住「量到 0」这个形状）
  const row = listBox.querySelector('[data-rss-row]')
  assert.ok(row !== null, '前置：列表里有一行 [data-rss-row]')
  Object.defineProperty(row, 'offsetHeight', { get: () => 0, configurable: true })
  h.press('n')
  await h.settle()
  assert.equal(h.scrollTop(listBox), 48, '行高量到 0 必须走兜底 48（offsetHeight 判定取反时这条会按 0 滚而红）')
})

test('刷新搜索后相同选中项移出视口时，列表跟随其新位置', skip, async () => {
  const current = item({ id: 'current' })
  let hits = [current]
  const h = await mountReader({ items: [current], search: () => ({ items: hits }) })
  h.store.submitSearch({ text: '支付' })
  await h.settle()
  assert.equal(h.store.get().selectedId, 'current')
  const list = h.arm(h.box('list'), { clientHeight: 100 })
  const row = list.querySelector('[data-rss-row="current"]')
  Object.defineProperty(row, 'offsetTop', { get: () => Array.from(row.parentElement.children).indexOf(row) * 120 })
  Object.defineProperty(row, 'offsetHeight', { value: 40 })
  hits = [item({ id: 'new' }), current]
  await h.store.load('refresh')
  await h.settle()
  assert.equal(h.store.get().selectedId, 'current')
  assert.equal(list.querySelector('[data-rss-row="current"]'), row)
  assert.equal(h.scrollTop(list), 60)
})

test('文件夹展开与折叠同步键盘行序，汇总未读且保留订阅选择', skip, async () => {
  const h = await mountReader({
    items: [
      item({ id: 'first', feedId: 'a' }),
      item({ id: 'second', feedId: 'b' }),
      item({ id: 'read', feedId: 'b', readAt: '2026-10-06T01:00:00.000Z' }),
      item({ id: 'unfiled', feedId: 'c' }),
    ],
    feeds: [{ id: 'c', title: '未分类源' }, { id: 'a', title: '源 A', folder: '技术/工具' }, { id: 'b', title: '源 B', folder: '技术/工具' }],
  })
  const doc = h.win.document
  const key = 'folder:技术/工具'
  const folder = () => doc.querySelector('[data-rss-nav-row="' + key + '"]')
  const rows = () => Array.from(doc.querySelectorAll('[data-rss-nav-row]'), (row) => row.getAttribute('data-rss-nav-row'))
  const cursor = () => doc.querySelector('[data-rss-nav-cursor]')?.getAttribute('data-rss-nav-row')
  const visible = () => h.store.visible().map(({ id }) => id)
  const top = ['filter:all', 'filter:unread', 'filter:starred', key]
  assert.deepEqual(rows(), [...top, 'feed:a', 'feed:b', 'feed:c'])
  assert.equal(folder().getAttribute('data-rss-nav-badge'), '2')
  assert.equal(folder().getAttribute('aria-expanded'), 'true')

  h.store.selectNav({ kind: 'feed', feedId: 'a' })
  assert.deepEqual(visible(), ['first'])
  h.press('P', true)
  await h.settle()
  assert.equal(cursor(), key)
  h.press('O', true)
  await h.settle()
  assert.deepEqual(rows(), [...top, 'feed:c'])
  assert.equal(folder().getAttribute('aria-expanded'), 'false')
  assert.equal(folder().getAttribute('data-rss-nav-badge'), '2')
  h.press('N', true)
  await h.settle()
  assert.equal(cursor(), 'feed:c')
  assert.deepEqual(visible(), ['first'])

  folder().click()
  await h.settle()
  assert.deepEqual(rows(), [...top, 'feed:a', 'feed:b', 'feed:c'])
  h.press('N', true)
  await h.settle()
  assert.equal(cursor(), 'feed:a')
  h.store.setShowUnread(false)
  await h.settle()
  assert.equal(folder().hasAttribute('data-rss-nav-badge'), false)
})

test('文件夹浏览：空目录可见，进入后只显示成员条目，空目录有明确空状态', skip, async () => {
  const h = await mountReader({
    items: [
      item({ id: 'a1', feedId: 'a' }),
      item({ id: 'b1', feedId: 'b' }),
      item({ id: 'c1', feedId: 'c' }),
    ],
    feeds: [
      { id: 'a', title: '源 A', folder: '技术' },
      { id: 'b', title: '源 B', folder: '技术' },
      { id: 'c', title: '源 C' },
    ],
    folders: [{ name: '技术', feedIds: ['a', 'b'] }, { name: '空文件夹', feedIds: [] }],
  })
  await h.store.load('overview')
  await h.settle()
  const doc = h.win.document
  const rows = () => Array.from(doc.querySelectorAll('[data-rss-nav-row]'), (row) => row.getAttribute('data-rss-nav-row'))

  assert.ok(rows().includes('folder:技术'), '有成员的文件夹在左栏')
  assert.ok(rows().includes('folder:空文件夹'), '空文件夹也必须出现在左栏（目录不是 feed.folder 的派生物）')
  assert.equal(doc.querySelector('[data-rss-nav-row="folder:空文件夹"]').getAttribute('data-rss-nav-badge'), '0')

  const openTech = doc.querySelector('[data-rss-folder-open="技术"]')
  assert.ok(openTech, '进入文件夹必须有独立可聚焦按钮')
  openTech.click()
  await h.settle()
  assert.deepEqual(h.store.get().navSelection, { kind: 'folder', folder: '技术' })
  assert.equal(doc.querySelector('.dsh-rss-toolbar-title strong').textContent, '技术', '标题切到文件夹名')
  assert.deepEqual(h.store.visible().map((entry) => entry.id), ['a1', 'b1'], '只显示成员源的条目')
  const lastOverview = [...h.requests].reverse().find((request) => request.endpoint === 'overview')
  assert.equal(lastOverview.payload.folder, '技术', '宿主必须先按成员筛选再分页（请求带 folder）')

  doc.querySelector('[data-rss-folder-open="空文件夹"]').click()
  await h.settle()
  assert.deepEqual(h.store.visible(), [], '空文件夹没有条目')
  assert.match(doc.querySelector('[data-rss-scroll="list"]').textContent, /这个文件夹还没有订阅源/)
})

test('文件夹搜索：范围取成员交集，续页回带查询绑定游标', skip, async () => {
  const calls = []
  const h = await mountReader({
    items: [
      item({ id: 'a1', feedId: 'a' }),
      item({ id: 'b1', feedId: 'b' }),
      item({ id: 'c1', feedId: 'c' }),
    ],
    feeds: [
      { id: 'a', title: '源 A', folder: '技术' },
      { id: 'b', title: '源 B', folder: '技术' },
      { id: 'c', title: '源 C' },
    ],
    folders: [{ name: '技术', feedIds: ['a', 'b'] }],
    search: async (payload) => {
      calls.push(payload)
      if (payload.cursor === undefined) return { items: [item({ id: 'a1', feedId: 'a' })], nextCursor: 'C1' }
      return { items: [item({ id: 'b1', feedId: 'b' })] }
    },
  })
  await h.store.load('overview')
  await h.settle()
  h.store.selectNav({ kind: 'folder', folder: '技术' })
  await h.settle()
  h.store.submitSearch({ text: '支付' })
  await h.settle()

  assert.equal(calls.length, 1, '第一页一次搜索')
  assert.deepEqual([...calls[0].feedIds], ['a', 'b'], '搜索范围收窄到文件夹成员')
  assert.equal(calls[0].feedId, undefined, '文件夹范围不能退化成单源参数')
  assert.deepEqual(h.store.visible().map((entry) => entry.id), ['a1'])

  await h.store.loadMore()
  await h.settle()
  assert.equal(calls[1].cursor, 'C1', '续页原样回带宿主游标')
  assert.deepEqual(h.store.visible().map((entry) => entry.id), ['a1', 'b1'], '第二页追加而不是替换')
})

test('文件夹管理：创建、改名、移动、删除二次确认与焦点恢复', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a' }), item({ id: 'b1', feedId: 'b' })],
    feeds: [
      { id: 'a', title: '源 A', folder: '旧文件夹' },
      { id: 'b', title: '源 B' },
    ],
    folders: [{ name: '旧文件夹', feedIds: ['a'] }],
  })
  await h.store.load('overview')
  await h.settle()
  h.press('f')
  await h.settle()
  const doc = h.win.document

  const newInput = doc.querySelector('[data-rss-folder-new]')
  setControlValue(h.win, newInput, ' 新文件夹 ')
  doc.querySelector('[data-rss-folder-create] button[type="submit"]').click()
  await h.settle()
  assert.ok(doc.querySelector('[data-rss-folder-manage="新文件夹"]'), '创建后管理面板里出现空文件夹')

  doc.querySelector('[data-rss-folder-rename="新文件夹"]').click()
  await h.settle()
  const renameInput = doc.querySelector('[data-rss-folder-rename-input="新文件夹"]')
  setControlValue(h.win, renameInput, '改名后')
  doc.querySelector('[data-rss-folder-rename-save="新文件夹"]').click()
  await h.settle()
  assert.ok(doc.querySelector('[data-rss-folder-manage="改名后"]'), '改名后目录项更新')

  const moveSelectB = doc.querySelector('[data-rss-feed-folder="b"]')
  setControlValue(h.win, moveSelectB, '改名后')
  await h.settle()
  assert.equal(h.server.feeds.find((feed) => feed.id === 'b').folder, '改名后', '移动落到宿主状态')
  const moveSelectA = doc.querySelector('[data-rss-feed-folder="a"]')
  setControlValue(h.win, moveSelectA, '改名后')
  await h.settle()
  assert.equal(h.server.feeds.find((feed) => feed.id === 'a').folder, '改名后', '已有成员也能移动')
  assert.match(doc.querySelector('[data-rss-folder-manage="改名后"]').textContent, /2 个订阅/)

  const deleteButton = doc.querySelector('[data-rss-folder-delete="改名后"]')
  deleteButton.click()
  await h.settle()
  assert.ok(doc.querySelector('[data-rss-folder-confirm="改名后"]'), '删除先出确认条')
  assert.match(doc.querySelector('[data-rss-folder-confirm="改名后"]').textContent, /成员会变为未分类/)
  doc.querySelector('[data-rss-folder-confirm-no="改名后"]').click()
  await h.settle()
  assert.ok(doc.querySelector('[data-rss-folder-manage="改名后"]'), '取消删除不改变目录')
  assert.equal(doc.activeElement, deleteButton, '取消后焦点回到触发删除的按钮')

  deleteButton.click()
  await h.settle()
  doc.querySelector('[data-rss-folder-confirm-yes="改名后"]').click()
  await h.settle()
  assert.equal(doc.querySelector('[data-rss-folder-manage="改名后"]'), null, '确认后目录项消失')
  assert.equal(h.server.feeds.find((feed) => feed.id === 'a').folder, undefined, '删除只解除分类（a）')
  assert.equal(h.server.feeds.find((feed) => feed.id === 'b').folder, undefined, '删除只解除分类（b）')
})

test('当前浏览文件夹：改名迁移范围，删除回到跨源列表', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a' }), item({ id: 'c1', feedId: 'c' })],
    feeds: [
      { id: 'a', title: '源 A', folder: '技术' },
      { id: 'c', title: '源 C' },
    ],
    folders: [{ name: '技术', feedIds: ['a'] }],
  })
  await h.store.load('overview')
  await h.settle()
  const doc = h.win.document
  doc.querySelector('[data-rss-folder-open="技术"]').click()
  await h.settle()
  assert.deepEqual(h.store.get().navSelection, { kind: 'folder', folder: '技术' })

  h.press('f')
  await h.settle()
  doc.querySelector('[data-rss-folder-rename="技术"]').click()
  await h.settle()
  const input = doc.querySelector('[data-rss-folder-rename-input="技术"]')
  setControlValue(h.win, input, '技术二')
  doc.querySelector('[data-rss-folder-rename-save="技术"]').click()
  await h.settle()
  assert.deepEqual(h.store.get().navSelection, { kind: 'folder', folder: '技术二' }, '改名后当前浏览范围跟着迁移')

  doc.querySelector('[data-rss-folder-delete="技术二"]').click()
  await h.settle()
  doc.querySelector('[data-rss-folder-confirm-yes="技术二"]').click()
  await h.settle()
  assert.deepEqual(h.store.get().navSelection, { kind: 'virtual' }, '删除当前文件夹后回到跨源列表')
  h.press('Escape')
  await h.settle()
  assert.deepEqual(h.store.visible().map((entry) => entry.id), ['a1', 'c1'], '跨源列表恢复')
})

test('文件夹管理失败可恢复：创建失败保留原数据，重试成功后清掉错误', skip, async () => {
  let failCreate = true
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a' })],
    feeds: [{ id: 'a', title: '源 A', folder: '旧文件夹' }],
    folders: [{ name: '旧文件夹', feedIds: ['a'] }],
    folderApi: async (body) => {
      if (body.endpoint !== 'createFolder' || !failCreate) return undefined
      // 传输层成功、信封失败：callRpc 的两层判定要分开（否则只会得到 HTTP 200）。
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: { code: 'conflict', message: '文件夹已存在：重复名', details: {} } }),
      }
    },
  })
  await h.store.load('overview')
  await h.settle()
  h.press('f')
  await h.settle()
  const doc = h.win.document
  const input = doc.querySelector('[data-rss-folder-new]')
  setControlValue(h.win, input, '重复名')
  doc.querySelector('[data-rss-folder-create] button[type="submit"]').click()
  await h.settle()

  assert.match(h.store.get().error ?? '', /文件夹已存在/, '失败必须可见')
  assert.ok(doc.querySelector('[data-rss-folder-manage="旧文件夹"]'), '失败不改变原有目录')
  assert.equal(doc.querySelector('[data-rss-folder-manage="重复名"]'), null)

  failCreate = false
  setControlValue(h.win, doc.querySelector('[data-rss-folder-new]'), '重复名')
  doc.querySelector('[data-rss-folder-create] button[type="submit"]').click()
  await h.settle()
  assert.ok(doc.querySelector('[data-rss-folder-manage="重复名"]'), '重试成功后新目录出现')
  assert.equal(h.store.get().error, undefined, '成功刷新后错误条被清掉')
})


test('标签浏览与编辑：左栏行、空标签、列表/正文共用标签栏，频繁切换不高亮成已读', async () => {
  const h = await mountReader({
    items: [
      item({ id: 'a1', feedId: 'a', title: '甲文章', tagIds: ['t1'] }),
      item({ id: 'a2', feedId: 'a', title: '乙文章', tagIds: ['t1', 't2'] }),
    ],
    feeds: [{ id: 'a', title: '源 A' }],
    tags: [{ id: 't1', name: '待读' }, { id: 't2', name: '参考' }, { id: 'empty', name: '空标签' }],
  })
  await h.store.load('overview')
  await h.settle()
  const doc = h.win.document
  assert.ok(doc.querySelector('[data-rss-nav-row="tag:t1"]'), '标签行进入左栏')
  assert.ok(doc.querySelector('[data-rss-nav-row="tag:empty"]'), '空标签仍可见')
  assert.equal(doc.querySelector('[data-rss-nav-row="tag:t1"]').textContent.includes('待读'), true)

  doc.querySelector('[data-rss-nav-row="tag:t1"]').click()
  await h.settle()
  assert.deepEqual(h.store.get().navSelection, { kind: 'tag', tagId: 't1' })
  assert.deepEqual(h.store.visible().map((entry) => entry.id), ['a1', 'a2'], '标签范围只含成员')
  assert.ok(doc.querySelector('[data-rss-tag-editor]'), '列表视图有共用标签栏')
  assert.equal(doc.querySelector('[data-rss-tag-toggle="t1"]').getAttribute('aria-pressed'), 'true')
  assert.equal(doc.querySelector('[data-rss-tag-toggle="t2"]').getAttribute('aria-pressed'), 'false')

  // 标签芯片是编辑控件：Space 不能让 document 的翻页快捷键滚列表。
  const list = h.arm(h.box('list'))
  const chip = doc.querySelector('[data-rss-tag-toggle="t2"]')
  chip.focus()
  chip.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
  assert.equal(h.scrollTop(list), 0, '标签芯片上的空格被编辑控件拦下，不触发列表翻页')

  // 频繁点击：先加 t2 再移除 t1；写入串行队列按点击后的快照覆盖，最后服务端与界面一致。
  doc.querySelector('[data-rss-tag-toggle="t2"]').click()
  doc.querySelector('[data-rss-tag-toggle="t1"]').click()
  await h.settle()
  assert.deepEqual(h.store.visible().find((entry) => entry.id === 'a1').tagIds, ['t2'])
  assert.ok(h.requests.filter((entry) => entry.endpoint === 'setItemTags').length >= 2)
  assert.equal(h.requests.some((entry) => entry.endpoint === 'markRead'), false, '标签编辑不许标读')

  // 正文视图复用同一个标签栏：打开 a1 后仍可编辑，且选区仍是 a1。
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()
  assert.equal(h.store.get().view, 'article')
  assert.ok(doc.querySelector('[data-rss-tag-editor]'), '正文视图有同一标签栏')
  assert.equal(doc.querySelector('[data-rss-tag-toggle="t2"]').getAttribute('aria-pressed'), 'true')
  doc.querySelector('[data-rss-tag-toggle="t2"]').click()
  await h.settle()
  assert.deepEqual(h.store.get().items.find((entry) => entry.id === 'a1').tagIds, [])
})


test('标签行纳入 Shift+N/P/O 的可见行序，空标签也可到达', async () => {
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a', tagIds: ['t1'] })],
    feeds: [{ id: 'a', title: '源 A' }],
    tags: [{ id: 't1', name: '待读' }, { id: 'empty', name: '空标签' }],
  })
  await h.store.load('overview')
  await h.settle()
  // 行序：全部 / 未读 / 星标 / 源 A / 标签 待读 / 标签 空标签。
  h.press('N', true); await h.settle()
  h.press('N', true); await h.settle()
  h.press('N', true); await h.settle()
  h.press('N', true); await h.settle()
  assert.deepEqual(h.store.get().navCursor, { kind: 'tag', tagId: 't1' }, '标签行在统一行序里，Shift+N 能到达')
  assert.equal(h.press('O', true), true, 'Shift+O 在标签行上被接管')
  await h.settle()
  assert.deepEqual(h.store.get().navSelection, { kind: 'tag', tagId: 't1' })
})

test('标签管理：创建、改名、删除只清关联，不改文章与阅读状态', async () => {
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a', title: '文章', readAt: '2026-10-06T00:00:00.000Z', tagIds: ['t1'] })],
    feeds: [{ id: 'a', title: '源 A' }],
    tags: [{ id: 't1', name: '旧标签' }],
  })
  await h.store.load('overview')
  await h.settle()
  h.press('f')
  await h.settle()
  const doc = h.win.document
  setControlValue(h.win, doc.querySelector('[data-rss-tag-new]'), '新标签')
  doc.querySelector('[data-rss-tag-create] button[type="submit"]').click()
  await h.settle()
  assert.ok(h.store.get().tags.some((tag) => tag.name === '新标签'), '创建后目录出现新标签')

  doc.querySelector('[data-rss-tag-rename="t1"]').click()
  await h.settle()
  setControlValue(h.win, doc.querySelector('[data-rss-tag-rename-input="t1"]'), '改名后')
  doc.querySelector('[data-rss-tag-rename-save="t1"]').click()
  await h.settle()
  assert.equal(h.store.get().tags.find((tag) => tag.id === 't1').name, '改名后', '改名保留 id')

  doc.querySelector('[data-rss-tag-delete="t1"]').click()
  await h.settle()
  doc.querySelector('[data-rss-tag-confirm-yes="t1"]').click()
  await h.settle()
  assert.equal(h.store.get().tags.some((tag) => tag.id === 't1'), false, '标签从目录移除')
  assert.deepEqual(h.store.get().items.find((entry) => entry.id === 'a1').tagIds, [], '只清文章关联')
  assert.equal(h.store.get().items.find((entry) => entry.id === 'a1').readAt, '2026-10-06T00:00:00.000Z', '阅读状态不变')
})


test('标签 + 搜索：搜索请求携带标签 id，结果仍按标签范围显示', async () => {
  const h = await mountReader({
    items: [
      item({ id: 'a1', feedId: 'a', title: '甲文章', tagIds: ['t1'] }),
      item({ id: 'a2', feedId: 'a', title: '乙文章', tagIds: ['t2'] }),
    ],
    feeds: [{ id: 'a', title: '源 A' }],
    tags: [{ id: 't1', name: '待读' }, { id: 't2', name: '参考' }],
    search: async (payload) => ({
      items: payload.tagId === 't1' ? [item({ id: 'a1', feedId: 'a', title: '甲文章', tagIds: ['t1'] })] : [],
      nextCursor: undefined,
    }),
  })
  await h.store.load('overview')
  await h.settle()
  h.win.document.querySelector('[data-rss-nav-row="tag:t1"]').click()
  await h.settle()
  h.store.submitSearch({ text: '甲' })
  await h.settle()
  const searchRequest = h.requests.filter((entry) => entry.endpoint === 'searchItems').at(-1)
  assert.equal(searchRequest.payload.tagId, 't1', '标签范围随搜索请求下发，宿主先在 SQL 里取交集')
  assert.deepEqual(h.store.visible().map((entry) => entry.id), ['a1'])
})


test('标签写入失败：乐观关联回滚、错误可见，重试成功后恢复', async () => {
  let fail = true
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a', title: '文章', tagIds: [] })],
    feeds: [{ id: 'a', title: '源 A' }],
    tags: [{ id: 't1', name: '待读' }],
    folderApi: async (body) => {
      if (body.endpoint !== 'setItemTags' || !fail) return undefined
      // 传输层成功、信封失败：模拟宿主写标签失败，而网络本身没断。
      return { ok: true, status: 200, json: async () => ({ ok: false, error: { code: 'internal', message: '写标签失败' } }) }
    },
  })
  await h.store.load('overview')
  await h.settle()
  const doc = h.win.document
  doc.querySelector('[data-rss-tag-toggle="t1"]').click()
  await h.settle()
  assert.match(h.store.get().error ?? '', /写标签失败/, '失败必须可见')
  assert.deepEqual(h.store.get().items.find((entry) => entry.id === 'a1').tagIds, [], '失败回取服务端真值，不留乐观脏状态')

  fail = false
  doc.querySelector('[data-rss-tag-toggle="t1"]').click()
  await h.settle()
  assert.deepEqual(h.store.get().items.find((entry) => entry.id === 'a1').tagIds, ['t1'], '重试成功后关联落盘')
  assert.equal(h.store.get().error, undefined, '成功路径清掉错误')
})


test('删除当前标签范围：回到跨源列表，标签从目录消失但文章保留', async () => {
  const h = await mountReader({
    items: [
      item({ id: 'a1', feedId: 'a', title: '甲文章', tagIds: ['t1'] }),
      item({ id: 'a2', feedId: 'a', title: '乙文章', tagIds: [] }),
    ],
    feeds: [{ id: 'a', title: '源 A' }],
    tags: [{ id: 't1', name: '待读' }],
  })
  await h.store.load('overview')
  await h.settle()
  const doc = h.win.document
  doc.querySelector('[data-rss-nav-row="tag:t1"]').click()
  await h.settle()
  assert.deepEqual(h.store.get().navSelection, { kind: 'tag', tagId: 't1' })

  h.press('f')
  await h.settle()
  doc.querySelector('[data-rss-tag-delete="t1"]').click()
  await h.settle()
  doc.querySelector('[data-rss-tag-confirm-yes="t1"]').click()
  await h.settle()
  assert.deepEqual(h.store.get().navSelection, { kind: 'virtual' }, '删除当前标签后回到跨源列表')
  assert.equal(h.store.get().tags.some((tag) => tag.id === 't1'), false, '标签从目录消失')
  assert.deepEqual(h.store.get().items.find((entry) => entry.id === 'a1').tagIds, [], '只清关联')
  h.press('Escape')
  await h.settle()
  assert.deepEqual(h.store.visible().map((entry) => entry.id).sort(), ['a1', 'a2'], '文章保留')
})


/* ───────────────── M4 01：只发现、不订阅（真实 React + jsdom） ───────────────── */
/**
 * 为什么这三条必须落在这一层：候选清单是**渲染出来的**，「取消之后什么都没加」是一条
 * 跨组件的行为（按钮 → store → 端点），假 React 夹具既测不了状态重渲染、也看不见 DOM 标记。
 * 桩必须守宿主契约：discoverFeeds 回 {url,candidates,warnings}，addFeed 回 OpmlImportResult
 * ——少给字段会让界面在渲染时读到 undefined（docs/pitfalls.md 二、2.6）。
 */
const DISCOVERY_CANDIDATES = [
  { url: 'https://site.test/a.xml', title: '源 A 的 feed', format: 'rss2', itemCount: 3 },
  { url: 'https://site.test/b.xml', format: 'atom', itemCount: 0 },
]
const ADD_FEED_REPORT = (url) => ({ added: 1, existed: 0, failed: [], skipped: [], accepted: [{ url }] })

test('订阅发现：候选逐条列出、选中的那条走 addFeed、取消不添加任何源', async () => {
  const report = { url: 'https://site.test/', candidates: DISCOVERY_CANDIDATES, warnings: [{ url: 'https://site.test/broken.xml', reason: '不是可识别的 feed（RSS 2.0 / RSS 1.0 / Atom 皆不匹配）' }] }
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a' })],
    feeds: [{ id: 'a', title: '源 A' }],
    folderApi: async (body) => {
      if (body.endpoint === 'discoverFeeds') {
        return { ok: true, status: 200, json: async () => ({ ok: true, value: report }) }
      }
      if (body.endpoint === 'addFeed') {
        return { ok: true, status: 200, json: async () => ({ ok: true, value: ADD_FEED_REPORT(body.payload.url) }) }
      }
      return undefined
    },
  })
  await h.store.load('overview')
  await h.settle()
  h.press('f')
  await h.settle()
  const doc = h.win.document
  const input = doc.querySelector('[data-rss-add-input]')
  setControlValue(h.win, input, 'https://site.test/')
  await h.settle()

  doc.querySelector('[data-rss-discover]').click()
  // 加载态：点下去当场进 busy —— 既有的「正在逐源抓取校验…」提示与各按钮的 disabled 都由这
  // 一个标志驱动（这里只钉标志本身：按钮的 disabled 是渲染的派生结果，瞬时读 DOM 会读到上一帧）。
  assert.equal(h.store.get().feedsBusy, true, '发现期间必须进入 busy 态（加载反馈的承重点）')
  await h.settle()
  assert.equal(h.store.get().feedsBusy, false, '结果到达后退出 busy')
  assert.deepEqual(h.requests.filter((request) => request.endpoint === 'discoverFeeds').map((request) => request.payload.url),
    ['https://site.test/'], '发现请求带的是用户填的那个 URL')
  const rows = () => Array.from(doc.querySelectorAll('[data-rss-candidate]'), (row) => row.getAttribute('data-rss-candidate'))
  assert.deepEqual(rows(), ['https://site.test/a.xml', 'https://site.test/b.xml'], '候选逐条列出（保序）')
  assert.match(doc.querySelector('[data-rss-candidate="https://site.test/a.xml"]').textContent, /源 A 的 feed/)
  assert.match(doc.querySelector('[data-rss-discovery-warning]').textContent, /不是可识别的 feed/,
    '校验失败的候选要显示原因，而不是只剩一个没有解释的空位')

  // 取消：清单收起，且**一个源都没加**
  doc.querySelector('[data-rss-discovery-cancel]').click()
  await h.settle()
  assert.equal(doc.querySelector('[data-rss-discovery]'), null, '取消后候选清单消失')
  assert.equal(h.requests.filter((request) => request.endpoint === 'addFeed').length, 0, '取消不添加任何源')

  // 再发现一次，这次挑一条添加：只有被选中的那个 URL 落库
  doc.querySelector('[data-rss-discover]').click()
  await h.settle()
  doc.querySelector('[data-rss-candidate-add="https://site.test/a.xml"]').click()
  await h.settle()
  assert.deepEqual(h.requests.filter((request) => request.endpoint === 'addFeed').map((request) => request.payload.url),
    ['https://site.test/a.xml'], '只添加用户选中的那一条')
  assert.equal(doc.querySelector('[data-rss-discovery]'), null, '选完清单收起')

  // 手填入口仍在：回车 = 直接添加（既有语义，不强迫每个源都先发现一遍）
  const inputAgain = doc.querySelector('[data-rss-add-input]')
  setControlValue(h.win, inputAgain, 'https://direct.test/feed.xml')
  await h.settle()
  inputAgain.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await h.settle()
  assert.deepEqual(h.requests.filter((request) => request.endpoint === 'addFeed').map((request) => request.payload.url),
    ['https://site.test/a.xml', 'https://direct.test/feed.xml'], '输入框回车仍走既有的直接添加')
})

test('订阅发现：零候选与通道错误都有明确反馈（错误时不假装「没有候选」）', async () => {
  let mode = 'empty'
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a' })],
    feeds: [{ id: 'a', title: '源 A' }],
    folderApi: async (body) => {
      if (body.endpoint !== 'discoverFeeds') return undefined
      if (mode === 'empty') {
        const value = {
          url: 'https://site.test/', candidates: [],
          warnings: [{ url: 'https://site.test/', reason: '未发现公开声明的订阅源（页面里没有 link rel=alternate 的 RSS/Atom 声明）' }],
        }
        return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: false, error: { code: 'internal', message: '页面抓取失败' } }) }
    },
  })
  await h.store.load('overview')
  await h.settle()
  h.press('f')
  await h.settle()
  const doc = h.win.document
  setControlValue(h.win, doc.querySelector('[data-rss-add-input]'), 'https://site.test/')
  await h.settle()

  doc.querySelector('[data-rss-discover]').click()
  await h.settle()
  assert.match(doc.querySelector('[data-rss-discovery-empty]').textContent, /没有发现可订阅的源/,
    '零候选要说清下一步（继续手填），而不是留白')
  assert.match(doc.querySelector('[data-rss-discovery]').textContent, /未发现公开声明的订阅源/)

  mode = 'fail'
  doc.querySelector('[data-rss-discover]').click()
  await h.settle()
  assert.equal(doc.querySelector('[data-rss-discovery]'), null, '失败时不许留着上一次的候选（那会让人以为刚才那次没发生）')
  assert.match(doc.querySelector('.dsh-rss-status--error').textContent, /页面抓取失败/, '通道失败要可见')
})


/* ──────────────── M4 02：管理页的健康信息（真实 DOM） ──────────────── */
test('M4 02：管理页显示健康、连败次数、最近尝试与上次成功；历史未知写成「次数未知」而不是 0', skip, async () => {
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString()
  const minuteAgo = new Date(Date.now() - 60 * 1000).toISOString()
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a' })],
    feeds: [
      { id: 'a', title: '源 A', lastFetchedAt: hourAgo, lastAttemptedAt: minuteAgo, lastFailure: 'HTTP 502', failureCount: 3 },
      { id: 'b', title: '源 B' },
    ],
  })
  await h.store.load('overview')
  await h.settle()
  h.press('f')
  await h.settle()
  const doc = h.win.document

  const a = doc.querySelector('[data-rss-feed-health="a"]')
  assert.ok(a, '每个源都要有一行健康信息')
  assert.match(a.textContent, /健康：有告警/, '成功过、最近失败 ⇒ 有告警')
  assert.match(a.textContent, /连续失败：3 次/, '连败次数要显示')
  assert.match(a.textContent, /最近尝试：1 分钟前/, '最近尝试来自 lastAttemptedAt')
  assert.match(a.textContent, /上次成功：1 小时前/, '上次成功来自 lastFetchedAt')
  assert.match(a.textContent, /最近错误：HTTP 502/, '原因要显示')

  const b = doc.querySelector('[data-rss-feed-health="b"]')
  assert.match(b.textContent, /健康：从未成功/, '没成功过 ⇒ 从未成功（不是「正常」）')
  assert.match(b.textContent, /连续失败：次数未知/, '老记录没有计数 ⇒ 未知，不许写成 0')
  assert.doesNotMatch(b.textContent, /连续失败：0 次/)
})


test('行内 Enter / Space 与 o 同义：再按一次收起（GR 规范 o / enter = open/close）', skip, async () => {
  // 病象（2026-11-14 之前）：点击是 toggle、o 是 toggle，而行内 Enter/Space 写的是「恒展开」——
  // 同一条 GR 规则（docs/google-reader-feature-spec.md:211「o / enter | open/close item」）
  // 在三个入口有三种实现。这条用例钉的就是「三个入口同一条」。
  const h = await mountReader({ items: [item({ id: 'x' })] })
  await h.store.load('overview')
  await h.settle()
  const rowOf = () => h.win.document.querySelector('[data-rss-row="x"] .dsh-rss-row-main')
  assert.ok(rowOf() !== null, '条目行必须渲染出来')

  rowOf().dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
  await h.settle()
  assert.ok(h.win.document.querySelector('[data-rss-row="x"] .dsh-rss-summary') !== null, '点击后展开')
  assert.notEqual(h.store.get().items.find((entry) => entry.id === 'x').readAt, undefined,
    '点击即标已读 —— store.activate 是「打开即已读」的唯一触发点')

  rowOf().dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await h.settle()
  assert.equal(h.win.document.querySelector('[data-rss-row="x"] .dsh-rss-summary'), null,
    'Enter 必须收起 —— 此前这里写的是「恒展开」，按一次只会展开、永远收不起来')

  rowOf().dispatchEvent(new h.win.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
  await h.settle()
  assert.ok(h.win.document.querySelector('[data-rss-row="x"] .dsh-rss-summary') !== null, 'Space 再展开（与 Enter 同义）')
})

test('P0-1：条目链接是 javascript: 时，列表行与正文页都不渲染可点的原站链接（历史脏数据兜底）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'bad', link: 'javascript:alert(1)' })] })
  await h.store.load('overview')
  await h.settle()
  const row = h.win.document.querySelector('[data-rss-row="bad"] .dsh-rss-row-main')
  assert.ok(row !== null, '条目行必须渲染出来')
  row.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
  await h.settle()

  assert.equal(h.win.document.querySelector('a[href^="javascript:"]'), null,
    '列表行展开后不许出现 javascript: 的 href（白名单把它当成无链接）')

  // 正文页的「打开原站」：link 来自同一条脏记录，必须同样挡掉。
  h.store.select('bad')
  await h.store.openArticle()
  await h.settle()
  assert.equal(h.win.document.querySelector('a[href^="javascript:"]'), null,
    '正文页的「打开原站」同样不许出现 javascript:')
})

/** 在列表视图点开一条行，返回它的摘要区（点击 = 选中 + 标已读 + 展开摘录）。 */
async function openSummaryRow(h, id) {
  const row = h.win.document.querySelector('[data-rss-row="' + id + '"] .dsh-rss-row-main')
  assert.ok(row !== null, '条目行必须渲染出来：' + id)
  row.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
  await h.settle()
  const summary = h.win.document.querySelector('[data-rss-row="' + id + '"] .dsh-rss-summary')
  assert.ok(summary !== null, '展开后必须有摘要区：' + id)
  return summary
}

// 列表行展开的三种呈现各有一条直接用例：这是「摘要判据归位」重构前用户可见行为的全部，
// 现状零覆盖 —— 搬 paragraphsOf / hasBodyText 时任何分支或文案漂移都必须当场翻红。
// 文案按逐字钉，不按正则片段：这两句兜底是用户分辨「源没给正文」与「源只给外链」的唯一线索。

test('列表行展开①：够门槛时按段落逐块渲染（不许拼成一行）', skip, async () => {
  const firstParagraph = '第一段：这是订阅源提供的正文，长度足够跨过四十个字符的门槛。'
  const secondParagraph = '第二段：继续说明，两段拼起来肯定超过四十个字。'
  const h = await mountReader({
    items: [item({ id: 'body', summary: '<p>' + firstParagraph + '</p><p>' + secondParagraph + '</p>' })],
  })
  await h.store.load('overview')
  await h.settle()

  const summary = await openSummaryRow(h, 'body')
  const paragraphBlocks = [...summary.children].filter((element) => element.tagName === 'SPAN')
  assert.deepEqual(
    paragraphBlocks.map((element) => element.textContent),
    [firstParagraph, secondParagraph],
    '正文必须按段落逐块渲染（两段 = 两个块）',
  )
  assert.ok(!summary.textContent.includes('（此源'), '有正文时不许出现任何兜底文案')
})

test('列表行展开②：段落非空但不到门槛 →「此源只提供标题与外链，正文在原站」', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'link-only', summary: '<p><a href="https://news.ycombinator.com/item?id=1">Comments</a></p>' })],
  })
  await h.store.load('overview')
  await h.settle()

  const summary = await openSummaryRow(h, 'link-only')
  const block = summary.querySelector('span')
  assert.ok(block !== null, '兜底文案必须是摘要区的块')
  assert.equal(block.textContent, '（此源只提供标题与外链，正文在原站）', '文案逐字不变')
})

test('列表行展开③：一个段落都没有 →「此源未提供正文，点下面到原站阅读」', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'no-summary' })] })
  await h.store.load('overview')
  await h.settle()

  const summary = await openSummaryRow(h, 'no-summary')
  const block = summary.querySelector('span')
  assert.ok(block !== null, '兜底文案必须是摘要区的块')
  assert.equal(block.textContent, '（此源未提供正文，点下面到原站阅读）', '文案逐字不变')
})

// ── R4：正文抓取失败时回退到订阅源内容 ─────────────────────────────────────────
// 回退是**纯渲染**：判据与列表行共用 paragraphsOf + hasBodyText，内容不进 ArticleState、
// 不写缓存、不参与阅读时长。下面三条钉住票上的关键判定，第四条钉「无 failure 的空 blocks」文案。

test('正文失败回退：订阅源摘要够门槛时显示来源标注、原因行与全部段落，不显示阅读时长', skip, async () => {
  const firstParagraph = '第一段：这是订阅源提供的正文，长度足够跨过四十个字符的门槛。'
  const secondParagraph = '第二段：继续说明，两段拼起来肯定超过四十个字。'
  const h = await mountReader({
    items: [
      item({ id: 'a', summary: '<p>' + firstParagraph + '</p><p>' + secondParagraph + '</p>' }),
      item({ id: 'b' }),
    ],
    article: { failure: '403' },
  })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()

  // 回退不改变读态：打开的 a 标已读，b 保持未读（loadArticle / activate 的既有行为一字未动）。
  assert.ok(h.store.get().items.find((entry) => entry.id === 'a').readAt !== undefined, '打开条目仍标已读')
  assert.equal(h.store.get().items.find((entry) => entry.id === 'b').readAt, undefined, '其他条目的读态不受回退影响')

  const note = h.win.document.querySelector('[role="note"]')
  assert.ok(note !== null, '回退必须渲染 role="note" 的来源标注（不是错误态 alert）')
  assert.match(note.textContent ?? '', /以下为订阅源提供的内容，可能不是全文/, '标签文案逐字不变')
  const reason = note.querySelector('.dsh-rss-meta')
  assert.ok(reason !== null, '原因行要沿用 dsh-rss-meta 小字样式')
  assert.equal(reason.textContent, '原站正文没能取到：403', '原因行必须带上端点返回的失败原文')

  const body = h.win.document.querySelector('article.dsh-rss-article-column')
  assert.ok(body !== null, '正文列必须存在')
  assert.ok(body.contains(note), '回退标签与段落必须同属正文列（字号/栏宽/主题由它继承）')
  assert.deepEqual(
    [...body.querySelectorAll('p')].map((element) => element.textContent),
    [firstParagraph, secondParagraph],
    '摘要必须按段落逐块渲染（复用正文的 p 块，不许拼成一行）',
  )
  assert.equal(h.win.document.querySelector('[data-rss-reading-minutes]'), null,
    '回退段落不许参与阅读时长估算：该位置不该出现任何分钟数')
  assert.ok([...h.win.document.querySelectorAll('a')].some((element) => (element.textContent ?? '').includes('打开原站')),
    '「打开原站」照常保留')
  const retry = [...h.win.document.querySelectorAll('button')]
    .find((element) => (element.textContent ?? '').trim() === '重试抓取')
  assert.ok(retry !== undefined, '回退态必须有「重试抓取」按钮')
  assert.equal(h.byLabel('回到文章顶部', '前往文章底部').length, 2,
    '回退态照常显示回顶/到底按钮（有可滚内容）')

  const articleCalls = () => h.requests.filter((entry) => entry.endpoint === 'article')
  const saves = () => h.requests.filter((entry) => entry.endpoint === 'saveReadingProgress')
  assert.equal(articleCalls().length, 1, '打开一次只发一次正文请求（回退是纯渲染）')
  assert.equal(saves().length, 0, '回退内容没有 contentVersion：不许写阅读进度')

  // 返回列表再打开同一条：仍要重新请求 —— 证明回退内容没有被当成缓存。
  // 离开（组件卸载）也不能写进度：回退态没有 contentVersion，写进去就是把摘要当成原站正文（R4-B5）。
  h.press('Escape')
  await h.settle()
  assert.equal(saves().length, 0, '离开回退页（Esc 回列表）后不得发 saveReadingProgress')
  h.press('V', true)
  await h.waitFor(() => articleCalls().length === 2, { timeout: 900, label: '第二次打开重新请求正文' })
  await h.settle()
  assert.equal(articleCalls().length, 2, '返回列表再打开同一条必须重新抓取')
})

test('正文失败回退：摘要不到门槛时保持原错误块，不显示回退标签与重试', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a', summary: '<p><a href="https://news.ycombinator.com/item?id=1">Comments</a></p>' })],
    article: { failure: '403' },
  })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()

  const alert = h.win.document.querySelector('[role="alert"]')
  assert.ok(alert !== null, '门槛不过时必须保持原错误块')
  assert.match(alert.textContent ?? '', /没能取到正文：403/, '错误块文案逐字不变')
  assert.match(alert.textContent ?? '', /可以返回列表，或打开原站阅读。/, '兜底提示逐字不变')
  assert.equal(h.win.document.querySelector('[role="note"]'), null, '门槛不过时不许出现回退标签')
  assert.equal(
    [...h.win.document.querySelectorAll('button')].some((element) => (element.textContent ?? '').trim() === '重试抓取'),
    false,
    '保持现状：门槛不过时没有新增重试按钮',
  )
  assert.equal(h.byLabel('回到文章顶部', '前往文章底部').length, 0,
    '失败且无正文可读时不出回顶/到底按钮（与改动前一致）')
  assert.equal(h.requests.filter((entry) => entry.endpoint === 'article').length, 1, '仍只发一次正文请求')
})

// 验收 3：summary 缺失 / 空串（验收 2 是「不到 40 字」的另一种输入）。
// 这两条刻意分开挂载：夹具约定一条用例一个 mountReader，复盘时能直接看出是哪种输入红的。
test('正文失败回退：summary 缺失时保持原错误块，不出现回退标签', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: { failure: '403' },
  })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()

  const alert = h.win.document.querySelector('[role="alert"]')
  assert.ok(alert !== null, 'summary 缺失时必须保持原错误块（不是回退态）')
  assert.match(alert.textContent ?? '', /没能取到正文：403/, '错误块文案逐字不变')
  assert.equal(h.win.document.querySelector('[role="note"]'), null, 'summary 缺失时不许出现回退标签')
})

test('正文失败回退：summary 为空串时保持原错误块，不出现回退标签', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a', summary: '' })],
    article: { failure: '403' },
  })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()

  const alert = h.win.document.querySelector('[role="alert"]')
  assert.ok(alert !== null, 'summary 为空串时必须保持原错误块（不是回退态）')
  assert.match(alert.textContent ?? '', /没能取到正文：403/, '错误块文案逐字不变')
  assert.equal(h.win.document.querySelector('[role="note"]'), null, 'summary 为空串时不许出现回退标签')
})

test('正文失败回退：重试请求的是正文页那一篇（article.itemId），冷却期原文照实显示', skip, async () => {
  let attempt = 0
  const cooldown = '刚刚取过这篇正文，请 30 秒后再试'
  const h = await mountReader({
    items: [
      item({ id: 'a', summary: '<p>这一篇的订阅源摘要足够长，超过四十个字符的门槛，用于回退展示，第二句再多补一些字。</p>' }),
      item({ id: 'b', summary: '<p>另一篇也足够长，但重试绝不该去抓它——正文页的唯一真相是 article.itemId。</p>' }),
    ],
    article: () => {
      attempt += 1
      return attempt === 1 ? { failure: '403' } : { failure: cooldown }
    },
  })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()

  const articleCalls = () => h.requests.filter((entry) => entry.endpoint === 'article')
  const markReads = () => h.requests.filter((entry) => entry.endpoint === 'markRead')
  assert.equal(articleCalls().length, 1, '前置条件：首次打开只请求一次')
  assert.equal(markReads().length, 1, '前置条件：打开条目标一次已读（loadArticle → activate）')

  // 制造「列表选中项 ≠ 正文页那一篇」：重试若读 selectedId 就会去抓 b。
  h.store.select('b')
  await h.settle()
  assert.equal(h.store.get().selectedId, 'b', '前置条件：列表选中项已切到 b')

  const retry = [...h.win.document.querySelectorAll('button')]
    .find((element) => (element.textContent ?? '').trim() === '重试抓取')
  assert.ok(retry !== undefined, '回退态必须能重试')
  retry.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.waitFor(() => articleCalls().length === 2, { timeout: 900, label: '重试发出第二次正文请求' })
  await h.settle()

  const calls = articleCalls()
  assert.equal(calls[1].payload.itemId, 'a', '重试必须取 article.itemId，不是列表选中项 selectedId')
  assert.equal(h.store.get().article.itemId, 'a', '正文页仍然停在 a')
  assert.equal(markReads().length, 1,
    '重试不得重复标已读：条目已读时 activate → markRead 早退（R4-B8）')
  // 已知且有意（不是本次回退新增的规则）：loadArticle 开头把 selectedId 钉回正文那一篇。
  // 列表选中项会因此从 b 变回 a；把它钉成断言，避免日后误判成「重试改坏了列表选中」。
  assert.equal(h.store.get().selectedId, 'a',
    '重试后 selectedId 会被 loadArticle 带回正文那一篇（既有行为，已知且有意）')
  const reason = h.win.document.querySelector('[role="note"] .dsh-rss-meta')
  assert.ok(reason !== null, '重试失败后仍显示回退原因行')
  assert.equal(reason.textContent, '原站正文没能取到：' + cooldown, '冷却期失败原文必须照实显示，不吞不改写')
})

test('正文失败回退：成功但空 blocks 也显示回退，原因行写「原站没有可显示的正文」', skip, async () => {
  const paragraph = '订阅源提供了这一段正文，虽然没有 failure，但原站正文块是空的；这句补充说明让它超过四十个字符的门槛。'
  const h = await mountReader({
    items: [item({ id: 'a', summary: '<p>' + paragraph + '</p>' })],
    article: { itemId: 'a', title: 'ART', blocks: [], paragraphs: [] },
  })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()

  const note = h.win.document.querySelector('[role="note"]')
  assert.ok(note !== null, '没有可渲染 blocks 时也要回退')
  const reason = note.querySelector('.dsh-rss-meta')
  assert.ok(reason !== null, '原因行必须存在')
  assert.equal(reason.textContent, '原站没有可显示的正文', '无 failure 时原因行是这句（不是「没能取到」）')
  const body = h.win.document.querySelector('article.dsh-rss-article-column')
  assert.deepEqual([...body.querySelectorAll('p')].map((element) => element.textContent), [paragraph],
    '回退段落仍然按 p 渲染')
})

test('正文失败回退：字号/栏宽/主题当场生效，空格可滚动正文容器', skip, async () => {
  // 验收 5：回退态不是「死内容」——它继承正文容器，读起来必须和原站正文一样可调、可滚。
  const paragraph = '回退态也要能调排版：这一段订阅源内容足够长，跨过四十个字符的门槛，用来验证字号、栏宽与主题。'
  const h = await mountReader({
    items: [item({ id: 'a', summary: '<p>' + paragraph + '</p>' })],
    article: { failure: '403' },
  })
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()

  assert.ok(h.win.document.querySelector('[role="note"]') !== null, '前置条件：当前是回退态')
  const body = () => h.win.document.querySelector('article.dsh-rss-article-column')
  assert.equal(body().style.fontSize, '16px', '默认字号')
  assert.equal(body().style.maxWidth, '760px', '默认栏宽')

  // 字号：回退段落与标签都住在正文列里，必须当场跟着变
  const sizeSelect = h.win.document.querySelector('select[aria-label="正文字号"]')
  assert.ok(sizeSelect !== null, '正文页要有字号选择')
  setControlValue(h.win, sizeSelect, '20')
  await h.settle()
  assert.equal(body().style.fontSize, '20px', '回退态改字号必须当场生效')

  // 栏宽：同样落在正文列上
  const widthSelect = h.win.document.querySelector('select[aria-label="正文栏宽"]')
  assert.ok(widthSelect !== null, '正文页要有栏宽选择')
  setControlValue(h.win, widthSelect, '900')
  await h.settle()
  assert.equal(body().style.maxWidth, '900px', '回退态改栏宽必须当场生效')

  // 主题：标记打在滚动容器上（CSS 按它覆盖正文面）
  const themeSelect = h.win.document.querySelector('select[aria-label="正文主题"]')
  assert.ok(themeSelect !== null, '正文页要有主题选择')
  setControlValue(h.win, themeSelect, 'dark')
  await h.settle()
  assert.equal(h.box('article').getAttribute('data-rss-reading-theme'), 'dark', '回退态改主题必须当场生效')

  // 空格：按键路径按标记属性现取容器，回退态同样要能滚
  const scroller = h.arm(h.box('article'))
  assert.equal(h.press(' '), true, '回退态空格应被正文页接管')
  assert.equal(h.scrollTop(scroller), 300, '回退态空格应当滚动正文容器一屏')
})
