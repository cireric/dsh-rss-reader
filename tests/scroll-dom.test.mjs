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
import { DEFAULT_READING_PREFERENCES } from '../lib/preferences.js'
import { scopeMarkIdsOf } from './helpers/mark-scope.mjs'
import { deriveFeedOrder, reorderFeedOrder } from '../lib/feed-order.js'

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

async function mountReader({ items = [], feeds, folders, tags = [], article, holdArticle, holdOverview = false, search, folderApi, overviewApi, markReadGate, duplicates, timers, now, badge = false, prefs = { value: undefined, writes: [] }, store: existingStore } = {}) {
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
  // R1 04：未读三联拆分的桩。判据必须与宿主同形（src/unread.ts / unreadSplitSql）：
  // today = publishedAt >= todayFrom、earlier = 更早、noDate = 无发布日；只数未读、键域 = feeds 表。
  // 读态必须单独记账：items 数组是夹具的初始快照，客户端乐观改的是它自己的 state，不回头改这里。
  const readIds = new Set(items.filter((entry) => entry.readAt !== undefined).map((entry) => entry.id))
  const splitOf = (todayFrom) => {
    const split = { today: 0, earlier: 0, noDate: 0 }
    for (const entry of items) {
      if (readIds.has(entry.id)) continue
      if (account.perFeedUnread[entry.feedId] === undefined) continue
      if (entry.publishedAt === undefined) split.noDate += 1
      else if (entry.publishedAt >= todayFrom) split.today += 1
      else split.earlier += 1
    }
    return split
  }
  /** 只有请求带了 todayFrom 才回 unreadSplit（缺席即缺席，与宿主的旧形状一致）。 */
  const withSplit = (value, todayFrom) => todayFrom === undefined || todayFrom === null
    ? value
    : { ...value, unreadSplit: splitOf(todayFrom) }
  /** 半开区间判据与宿主同形：只认 publishedAt，无日期永不进窗。 */
  const inWindowOf = (entry, from, to) => entry.publishedAt !== undefined
    && entry.publishedAt >= from && entry.publishedAt < to
  /**
   * 回包的账目必须按请求的窗口算（src/endpoints.ts 的 accountOf 同形），否则「今天档位标读
   * 回窗内账」在 DOM 层根本表达不出来 —— 桩件只回全量账会被当成宿主行为。
   */
  const replyAccount = (payload) => {
    if (typeof payload?.from !== 'string' || typeof payload?.to !== 'string') {
      return { unread: account.unread, perFeedUnread: { ...account.perFeedUnread } }
    }
    const perFeedUnread = {}
    for (const feed of serverFeeds) perFeedUnread[feed.id] = 0
    for (const entry of items) {
      if (readIds.has(entry.id) || perFeedUnread[entry.feedId] === undefined) continue
      if (!inWindowOf(entry, payload.from, payload.to)) continue
      perFeedUnread[entry.feedId] += 1
    }
    return { unread: Object.values(perFeedUnread).reduce((sum, count) => sum + count, 0), perFeedUnread }
  }
  const accountReply = (extra, payload) => withSplit({ ...extra, ...replyAccount(payload) }, payload?.todayFrom)
  const markReply = (endpoint, ids, payload) => {
    const delta = endpoint === 'markRead' ? -1 : 1
    for (const id of ids) {
      const feedId = feedOf.get(id)
      if (endpoint === 'markRead') readIds.add(id)
      else readIds.delete(id)
      if (feedId === undefined || account.perFeedUnread[feedId] === undefined) continue
      account.perFeedUnread[feedId] = Math.max(0, account.perFeedUnread[feedId] + delta)
      account.unread += delta
    }
    return accountReply({ changed: ids.length }, payload)
  }
  let releaseArticle
  const gate = holdArticle === true ? new Promise((resolve) => { releaseArticle = resolve }) : undefined
  // R2-01：把 overview 扣住，用来表达「恢复还在路上，用户已经动手」这个真实窗口。
  // 恢复读的是同一条宿主通道，所以挂起它等价于宿主慢了一拍。
  let releaseOverview
  const overviewGate = holdOverview === true ? new Promise((resolve) => { releaseOverview = resolve }) : undefined
  const requests = []
  const fetchStub = async (_url, init) => {
    const body = JSON.parse(init.body)
    endpoints.push(body.endpoint)
    requests.push({ endpoint: body.endpoint, payload: body.payload })
    // 视图记忆（R2-01）：重开面板 = 新 store 读同一份宿主 prefs。写盘落进同一个对象，
    // 于是「关面板 → 再开」在这层是可表达的，不必碰实现内部。
    if (body.endpoint === 'viewPreferences') return ok({ preferences: prefs.value })
    if (body.endpoint === 'saveViewPreferences') {
      prefs.value = body.payload?.preferences
      prefs.writes.push(body.payload?.preferences)
      return ok({ preferences: prefs.value })
    }
    // refresh 与 overview 都回完整 Overview（src/endpoints.ts:112-118）—— 桩件此前把 refresh
    // 回成 {changed,unread}，而面板挂载时走的就是 refresh（index.tsx:184），于是 overview 字段
    // 全是 undefined。这是夹具没守住契约，不是代码该容忍的形状。
    if (body.endpoint === 'overview' || body.endpoint === 'refresh') {
      if (overviewGate !== undefined) await overviewGate
      // R1-03：用例可以整包接管 overview 回包（在途续页要控制「先扣住、后放行」的顺序）。
      if (overviewApi !== undefined) {
        const custom = await overviewApi(body, {
          items, serverFeeds, serverFolders, tagDirectory, overviewStub,
        })
        if (custom !== undefined) return ok(custom)
      }
      const folder = body.payload?.folder
      const tagId = body.payload?.tagId
      let visibleItems = folder === undefined
        ? items
        : items.filter((entry) => serverFeeds.some((feed) => feed.id === entry.feedId && feed.folder === folder))
      if (tagId !== undefined) visibleItems = visibleItems.filter((entry) => (entry.tagIds ?? []).includes(tagId))
      // R1-03：窗口是半开区间 [from, to)，只认 publishedAt（无日期永不进窗）—— 与宿主
      // src/store-sqlite.ts 的 WINDOW_FILTER 同一判据。桩必须照契约收窄，否则「切档后列表
      // 只剩窗内条目」在 DOM 层根本表达不出来（docs/pitfalls.md 二、2.6）。
      const from = body.payload?.from
      const to = body.payload?.to
      const windowed = typeof from === 'string' && typeof to === 'string'
      const inWindow = (entry) => inWindowOf(entry, from, to)
      if (windowed) visibleItems = visibleItems.filter(inWindow)
      // 账目按窗且是**全局**账（不随 folder / tag 收窄）—— 与宿主 buildOverview 的 accountOf 同形。
      const accountItems = windowed ? items.filter(inWindow) : items
      return ok(withSplit(
        overviewStub(visibleItems, serverFeeds, serverFolders, accountItems, tagDirectory()),
        body.payload?.todayFrom,
      ))
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
    if (body.endpoint === 'reorderFeeds') {
      // 宿主语义只留一份（src/feed-order.ts）：桩只把当前 serverFeeds 适配成 config 形状、
      // 交给共享纯函数，再把结果写回状态 —— 不再复刻「未知忽略 / 未点名补末尾 / 重复保首次」。
      // 否则「overview 随后按新顺序下发」这条验收可能被一个更宽松的替身放过去
      //（docs/pitfalls.md 2.6：桩件的派生数据要守它模仿的那条契约）。
      const ids = Array.isArray(body.payload?.ids) ? body.payload.ids : []
      const byId = Object.fromEntries(serverFeeds.map((feed) => [feed.id, feed]))
      const current = serverFeeds.map((feed) => feed.id)
      const next = reorderFeedOrder(current, byId, ids) ?? deriveFeedOrder(current, byId)
      serverFeeds.splice(0, serverFeeds.length, ...next.map((id) => byId[id]))
      return ok({ feedOrder: next })
    }
    if (body.endpoint === 'article') {
      if (gate !== undefined) await gate
      // article 可以是函数：阅读进度的用例需要「a 有进度、b 没有」这种按条目区分的回包
      const payload = typeof article === 'function' ? article(body.payload.itemId) : article
      return ok(payload ?? { itemId: body.payload.itemId, title: 'ART', blocks: [{ kind: 'p', text: '正文' }], paragraphs: ['正文'] })
    }
    if (body.endpoint === 'markRead' || body.endpoint === 'unmarkRead') {
      // 账目回包竞争（R1 评审 P1）：用例需要表达「旧档发出的动作回包晚到」——扣住一次回包，
      // 让切档 / 新档第一页先落地，再放行。桩件的账目仍按请求体里的窗口算（守宿主契约）。
      if (markReadGate !== undefined) await markReadGate
      const payload = body.payload ?? {}
      // 范围标读（ADR-0008）：桩件按与宿主同一条判据在**夹具全量**上求值 —— 只在 state.items
      // （已加载页）上算会重演「源里 19 条未读显示 0 条」的假绿（helpers/mark-scope.mjs）。
      const bulk = body.endpoint === 'markRead' && !Array.isArray(payload.itemIds)
      if (bulk) {
        const ids = scopeMarkIdsOf(items, (id) => readIds.has(id), payload, {
          folderFeedIds: (name) => serverFolders.find((folder) => folder.name === name)?.feedIds,
        })
        if (payload.dryRun === true) return ok(accountReply({ count: ids.length }, payload))
        const reply = markReply('markRead', ids, payload)
        return ok({ ...reply, ids })
      }
      const ids = Array.isArray(payload.itemIds) ? payload.itemIds : []
      return ok(markReply(body.endpoint, ids, body.payload))
    }
    // 星标 / 保持未读：账目一格不动，但契约上回包必须带账（五个带账端点同一个信封）。
    // 桩件漏了 perFeedUnread 会把客户端账目覆盖成 undefined —— 那是夹具比生产宽松。
    if (body.endpoint === 'toggleStar' || body.endpoint === 'toggleKeepUnread') {
      return ok(accountReply({ changed: 1 }, body.payload))
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
  // R2-02：滚动/选中的 300ms 去抖写手可以换成捕获式假定时器，让「写了几次、窗口多长」
  // 变成同步事实，而不是靠真等 300ms 赌机器速度（与 nav-persistence 的 fakeTimers 同形）。
  // 同一次面板会话可以复用既有 store 再挂载（R2 重开用例要验证「同一个 store 的第二次挂载」）；
  // 不传时与既有形态逐字一致。
  const store = existingStore ?? exportsObj.createReaderStore({
    // 显示窗边界依赖「现在」：用例把本地日冻住，切档请求体才能断言到确定的 ISO 瞬间。
    ...(now === undefined ? {} : { now }),
    ...(timers === undefined ? {} : { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout }),
  })
  const rootRef = createRoot(win.document.getElementById('root'))
  rootRef.render(React.createElement(exportsObj.createReader(store)))
  // 侧栏徽标的独立挂载（badge: true）：它不在 Reader 树里（sidebar.toggle.badge 座位单独注册），
  // R1-03 要断言「切档后徽标与顶栏是同一个数」只能在这里自己挂一份。
  let badgeHost = null
  let badgeRoot = null
  if (badge === true) {
    badgeHost = win.document.createElement('div')
    badgeHost.setAttribute('data-test-badge', '')
    win.document.body.appendChild(badgeHost)
    badgeRoot = createRoot(badgeHost)
    badgeRoot.render(React.createElement(exportsObj.Badge, { store }))
  }
  // 首次上屏 = React 真的把 Reader 挂上去了（root 有子节点），不是「睡够 50ms」。
  await waitFor(() => win.document.getElementById('root').childNodes.length > 0, { timeout: 2000, label: 'Reader 首次上屏' })
  // 挂载后组件自己会走一次 refresh（index.tsx:184）—— 等它落地再交给用例。
  // holdOverview 是**被测形态**（恢复在途），不能等它回来。
  await settle({ allowPending: holdOverview === true })

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
  // 显式生命周期状态，替代「try 住再看是不是已卸载」的空 catch：
  // 重复卸载必须是一次可解释的 no-op，而不是靠吞掉异常让收尾看起来正常。
  let mounted = true
  let domClosed = false
  const cleanup = () => {
    if (badgeRoot !== null) { badgeRoot.unmount(); badgeRoot = null }
    if (mounted) { mounted = false; rootRef.unmount() }
    if (!domClosed) { domClosed = true; dom.window.close() }
    for (const key of Object.keys(globalSnapshot)) {
      try { globalThis[key] = globalSnapshot[key] } catch { /* 还原失败不掩盖用例结果 */ }
    }
  }
  // 登记到模块级收尾表：afterEach 统一调用（用例无需逐一改）
  liveCleanups.push(cleanup)
  /**
   * 关面板：只卸 Reader 本身，保留 store 与 JSDOM（重开用例随后会再挂一个）。
   * 必须等 flush 的写盘落地才返回 —— 断言「关面板那一刻记住了」得等异步链走完。
   */
  const unmount = async () => {
    if (!mounted) return
    mounted = false
    rootRef.unmount()
    await settle()
  }
  return { store, win, endpoints, requests, server: { feeds: serverFeeds, folders: serverFolders }, box, byLabel, arm, observeContent, userScroll, press, exports: exportsObj, prefs, badgeText: () => badgeHost === null ? undefined : badgeHost.textContent, unmount, release: () => { if (releaseArticle !== undefined) releaseArticle() }, releaseOverview: () => { if (releaseOverview !== undefined) releaseOverview() }, scrollTop: (el) => (geometry.get(el) ?? (() => el.scrollTop))(), cleanup, settle, waitFor }
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

/**
 * 订阅管理页的排序按钮（R3-03）。
 *
 * 这一层必须用真 DOM 的理由：验收要求「点一下行序变、首末置灰、busy 全灰、宿主拒绝后屏幕不变」——
 * 全是**画在 DOM 上**的事实，只断言 store 状态会漏掉「state 变了但 attribute 没写」这类接线故障。
 */
function feedOrderRows(doc) {
  return [...doc.querySelectorAll('[data-rss-feed-row]')].map((row) => row.getAttribute('data-rss-feed-row'))
}
/** 左栏的源行序：两处必须读同一份 state.feeds（spec 验收 1 的「三处同序」的界面侧证据）。 */
function navFeedOrder(doc) {
  return [...doc.querySelectorAll('[data-rss-nav-row]')]
    .map((row) => row.getAttribute('data-rss-nav-row'))
    .filter((key) => key.startsWith('feed:'))
    .map((key) => key.slice('feed:'.length))
}

/**
 * 展开的文件夹里紧随目录行之后的成员行序（navRowsOf 把同一文件夹的成员连续排在一起）。
 * 成员行序必须来自宿主下发的 feeds 顺序，而不是 FolderView.feedIds 的键序 —— 后者只当集合用。
 */
function folderMemberRows(doc, folder) {
  const rows = [...doc.querySelectorAll('[data-rss-nav-row]')]
  const start = rows.findIndex((row) => row.getAttribute('data-rss-nav-row') === 'folder:' + folder)
  if (start < 0) return undefined
  const members = []
  for (const row of rows.slice(start + 1)) {
    const key = row.getAttribute('data-rss-nav-row')
    if (!key.startsWith('feed:')) break
    members.push(key.slice('feed:'.length))
  }
  return members
}

test('订阅管理页 ↑ / ↓：只挪一格、其它行相对序不变，首末置灰，说明文案在导出按钮附近', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a' }), item({ id: 'b1', feedId: 'b' }), item({ id: 'c1', feedId: 'c' })],
    feeds: [
      { id: 'a', title: '源 A' },
      { id: 'b', title: '源 B' },
      { id: 'c', title: '源 C' },
    ],
  })
  await h.store.load('overview')
  await h.settle()
  h.press('f')
  await h.settle()
  const doc = h.win.document
  assert.deepEqual(feedOrderRows(doc), ['a', 'b', 'c'], '前置：管理页按宿主下发的顺序渲染')
  assert.deepEqual(navFeedOrder(doc), ['a', 'b', 'c'], '前置：左栏与管理页同序')

  assert.equal(doc.querySelector('[data-rss-feed-order-up="a"]').disabled, true, '首行的 ↑ 必须置灰')
  assert.equal(doc.querySelector('[data-rss-feed-order-up="b"]').disabled, false, '中间行的 ↑ 可用')
  assert.equal(doc.querySelector('[data-rss-feed-order-down="c"]').disabled, true, '末行的 ↓ 必须置灰')
  assert.equal(doc.querySelector('[data-rss-feed-order-down="b"]').disabled, false, '中间行的 ↓ 可用')

  // 键盘可达：原生 button 默认可 Tab 到、可聚焦（不许为了「不抢快捷键」加 tabIndex={-1}）。
  // Enter 的激活是浏览器原生行为，jsdom 不模拟默认动作，所以这里只钉可聚焦与 tabIndex。
  const upC = doc.querySelector('[data-rss-feed-order-up="c"]')
  assert.equal(upC.tabIndex, 0, '排序按钮必须在 Tab 序列里（tabIndex 0）')
  upC.focus()
  assert.equal(doc.activeElement, upC, '排序按钮必须能获得焦点')

  // R3-4：说明文案原样落在导出按钮附近，提前讲清「OPML 不记录顺序」
  const hint = doc.querySelector('[data-rss-feed-order-hint]')
  assert.ok(hint !== null, '订阅管理页必须有一句排序说明')
  assert.equal(hint.textContent, '↑ / ↓ 调整顺序，只影响显示先后；OPML 不记录顺序，导出再导入不保证原顺序。')

  // 结构判据（不只看文本在不在）：提示必须和导出按钮同处一个工具条容器，且是这个节点**最近的**
  // 共同祖先 —— 否则文案被挪到面板外或别的区块里，本用例名里的「在导出按钮附近」就是空话。
  const exportButton = [...doc.querySelectorAll('button')].find((button) => button.textContent.trim() === '导出 OPML')
  assert.ok(exportButton !== undefined, '前置：导出按钮必须存在')
  const ancestors = new Set()
  for (let node = exportButton; node !== null; node = node.parentElement) ancestors.add(node)
  let common = hint
  while (common !== null && !ancestors.has(common)) common = common.parentElement
  assert.notEqual(common, null, '提示必须与导出按钮处在同一个面板里')
  assert.equal(common, hint.parentElement, '提示必须直接挂在它与导出按钮的最近共同容器上')
  // 共同祖先不能只是 <body>：那说明提示被挪出了订阅管理面板，「在导出按钮附近」已经名不副实。
  assert.notEqual(common, doc.body, '提示不能飘到面板外（最近共同容器不是 body）')
  assert.notEqual(common, doc.documentElement, '提示不能飘到文档根')

  doc.querySelector('[data-rss-feed-order-up="c"]').click()
  await h.settle()
  assert.deepEqual(feedOrderRows(doc), ['a', 'c', 'b'], '点 ↑ 只把 c 挪一格；a 与 b 的相对先后不变')
  assert.deepEqual(navFeedOrder(doc), ['a', 'c', 'b'], '左栏与订阅管理页读同一份 state.feeds，同序变化')
  const reorders = h.requests.filter((entry) => entry.endpoint === 'reorderFeeds')
  assert.equal(reorders.length, 1, '一次点击只发一次重排请求')
  assert.deepEqual(reorders[0].payload, { ids: ['a', 'c', 'b'] }, 'ids 由当前 state.feeds 整体推出（相邻交换）')
})

test('文件夹内成员行序跟随宿主下发顺序（不是成员数组的键序），与管理页同序变化', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'b1', feedId: 'b' }), item({ id: 'a1', feedId: 'a' })],
    // 宿主下发的顺序是 b、a；而 FolderView.feedIds 仍是 feeds 键序 a、b（它只当集合用）。
    feeds: [
      { id: 'b', title: '源 B', folder: '技术' },
      { id: 'a', title: '源 A', folder: '技术' },
    ],
    folders: [{ name: '技术', feedIds: ['a', 'b'] }],
  })
  await h.store.load('overview')
  await h.settle()
  const doc = h.win.document

  assert.equal(doc.querySelector('[data-rss-nav-row="folder:技术"]').getAttribute('aria-expanded'), 'true',
    '前置：文件夹已展开，成员行就在左栏')
  assert.deepEqual(folderMemberRows(doc, '技术'), ['b', 'a'],
    '展开的文件夹里，成员行序 = 宿主下发顺序；若读 feedIds 的键序会变成 a、b')
  h.press('f')
  await h.settle()
  assert.deepEqual(feedOrderRows(doc), ['b', 'a'], '前置：左栏与订阅管理页同序（都读 state.feeds）')

  doc.querySelector('[data-rss-feed-order-up="a"]').click()
  await h.settle()
  assert.deepEqual(folderMemberRows(doc, '技术'), ['a', 'b'],
    '↑ 挪一格后文件夹成员行序仍然只跟宿主下发顺序（左栏同序）')
  assert.deepEqual(feedOrderRows(doc), ['a', 'b'], '订阅管理页同步到同一份顺序（不是各算一套）')
})

test('订阅管理页：导入 / 加源在途时排序按钮全部置灰（不借 feedsBusy 的文案撒谎）', skip, async () => {
  let releaseAdd
  const addGate = new Promise((resolve) => { releaseAdd = resolve })
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a' }), item({ id: 'b1', feedId: 'b' })],
    feeds: [{ id: 'a', title: '源 A' }, { id: 'b', title: '源 B' }],
    folderApi: async (body) => {
      if (body.endpoint !== 'addFeed') return undefined
      // 加源要逐源抓取校验：扣住它就得到「长操作在途」的真实时序
      await addGate
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { added: 1, existed: 0, failed: [], skipped: [] } }) }
    },
  })
  await h.store.load('overview')
  await h.settle()
  h.press('f')
  await h.settle()
  const doc = h.win.document
  const pending = h.store.addFeed('https://new.example/feed')
  await h.waitFor(() => h.store.get().feedsBusy === true, { timeout: 900, label: '加源在途' })
  await h.settle({ allowPending: true })

  for (const id of ['a', 'b']) {
    for (const direction of ['up', 'down']) {
      assert.equal(doc.querySelector('[data-rss-feed-order-' + direction + '="' + id + '"]').disabled, true,
        'busy 时 ' + id + ' 的 ' + direction + ' 必须置灰（两个写手不能同时改同一份订阅文件）')
    }
  }
  assert.match(doc.body.textContent, /正在逐源抓取校验/, '前置：此刻确实处于加源忙态')

  releaseAdd()
  await pending
  await h.settle()
  assert.equal(h.store.get().feedsBusy, false)
  assert.equal(doc.querySelector('[data-rss-feed-order-up="b"]').disabled, false, '加源完成后按钮恢复可用')
})

test('订阅管理页：宿主拒绝重排时行序不变、错误可见', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a' }), item({ id: 'b1', feedId: 'b' }), item({ id: 'c1', feedId: 'c' })],
    feeds: [{ id: 'a', title: '源 A' }, { id: 'b', title: '源 B' }, { id: 'c', title: '源 C' }],
    folderApi: async (body) => {
      if (body.endpoint !== 'reorderFeeds') return undefined
      // 传输层成功、信封失败：走的是 callRpc 的错误分支（与「写盘失败」同一条路径）
      return {
        ok: true, status: 200,
        json: async () => ({ ok: false, error: { code: 'storage', message: '写入失败（模拟）', details: {} } }),
      }
    },
  })
  await h.store.load('overview')
  await h.settle()
  h.press('f')
  await h.settle()
  const doc = h.win.document

  doc.querySelector('[data-rss-feed-order-up="b"]').click()
  await h.settle()
  assert.deepEqual(feedOrderRows(doc), ['a', 'b', 'c'], '宿主拒绝时界面顺序必须保持宿主快照（绝不乐观重排）')
  const alert = doc.querySelector('[role="alert"]')
  assert.ok(alert !== null, '失败必须有一条可见的错误')
  assert.match(alert.textContent, /storage: 写入失败（模拟）/, '错误内容要能指向原因')
})

test('订阅管理页：连点两次 ↑ 只发一次重排请求', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a' }), item({ id: 'b1', feedId: 'b' }), item({ id: 'c1', feedId: 'c' })],
    feeds: [{ id: 'a', title: '源 A' }, { id: 'b', title: '源 B' }, { id: 'c', title: '源 C' }],
  })
  await h.store.load('overview')
  await h.settle()
  h.press('f')
  await h.settle()
  const doc = h.win.document

  const up = doc.querySelector('[data-rss-feed-order-up="c"]')
  up.click()
  up.click() // 同一 tick 的第二次点击：第一次还在途，必须被忽略
  await h.settle()
  const reorders = h.requests.filter((entry) => entry.endpoint === 'reorderFeeds')
  assert.equal(reorders.length, 1, '连点不能堆出两个请求（界面否则来回抽动）')
  assert.deepEqual(feedOrderRows(doc), ['a', 'c', 'b'], '只生效一次移动')
})

test('订阅管理页：改过的顺序在关掉重开后保持（宿主快照驱动）', skip, async () => {
  const items = [item({ id: 'a1', feedId: 'a' }), item({ id: 'b1', feedId: 'b' }), item({ id: 'c1', feedId: 'c' })]
  const feeds = [{ id: 'a', title: '源 A' }, { id: 'b', title: '源 B' }, { id: 'c', title: '源 C' }]
  const first = await mountReader({ items, feeds })
  await first.store.load('overview')
  await first.settle()
  first.press('f')
  await first.settle()
  first.win.document.querySelector('[data-rss-feed-order-up="b"]').click()
  await first.settle()
  assert.deepEqual(feedOrderRows(first.win.document), ['b', 'a', 'c'], '前置：宿主已落成新顺序')
  await first.unmount()

  // 重开面板 = 重新走 overview 读宿主（这里的 serverFeeds 就是「重启后的 config.json」）
  const second = await mountReader({ items, feeds: first.server.feeds })
  await second.settle()
  second.press('f')
  await second.settle()
  assert.deepEqual(feedOrderRows(second.win.document), ['b', 'a', 'c'], '重开 / 重启后顺序保持，不回到键序')
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
  assert.deepEqual(prefs.reading, { fontSize: 20, lineWidth: 760, theme: 'auto', expandImages: true })
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

test('左栏渲染：虚拟视图三行 + 精选源面板一行 + 每个订阅源一行', skip, async () => {
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
  // R15 08 起多一行「精选源」面板入口（它不是 Filter，所以排在虚拟视图之后、订阅源之前）。
  assert.deepEqual(labels, ['filter:all', 'filter:unread', 'filter:starred', 'view:sourcePack', 'feed:f1', 'feed:f2', 'feed:f3'],
    '左栏应当是虚拟视图三行 + 精选源面板一行 + 每个订阅源一行；实际 ' + JSON.stringify(labels))
  assert.deepEqual(rows.map((row) => row.getAttribute('data-rss-nav-badge')), [null, null, null, null, '2', '1', '0'],
    '每个源都要有角标，0 未读的源是 0 而不是空白（perFeedUnread 键域 = feeds 表）')
  // 两个标记各司其职（2026-10-10 任务 6 返工）：
  //   data-rss-nav-cursor   = 键盘光标落在哪一行（shift+n/p 移动的就是它）
  //   data-rss-nav-selected = 哪一行**此刻生效**（点击它不会改变右栏）
  // 初始状态下两者都在「全部」那一行。
  assert.equal(rows[0].getAttribute('data-rss-nav-cursor'), '', '默认光标应当在「全部」那一行')
  assert.equal(rows[0].getAttribute('data-rss-nav-selected'), '', '默认生效的也是「全部」')
  assert.equal(rows[4].getAttribute('data-rss-nav-cursor'), null, '光标不在源那一行')
  assert.equal(rows[4].getAttribute('data-rss-nav-selected'), null, '未选中的源不该高亮')
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

  // 走真实交互：R11 05 起复选框从工具栏「更多」搬进了设置页，所以先进设置页再点它，
  // 而不是直调 store.setShowUnread —— 这样「设置页控件 → store → 左栏角标」整条接线才被钉住。
  h.win.document.querySelector('[data-rss-settings-open]').click()
  await h.waitFor(() => h.win.document.querySelector('[data-rss-settings-page]') !== null, { label: '设置页上屏' })
  await h.settle()
  const toggle = h.win.document.querySelector('[data-rss-setting-checkbox="showUnread"]')
  assert.ok(toggle !== null, '设置页「显示」区应当有「显示未读计数」复选框')
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

/* ==================== A 的二次确认（2026-11-21） ==================== */
/* 用户报告的现场：按 A 什么都不发生。三条判据各守一段：
 *  ① 按大写 A 必须**弹框**（不是直接标读，也不是没反应）；
 *  ② 只有确认那一刻才标读，且撤销窗口照旧；
 *  ③ 0 候选也要弹框并说明 —— 静默 no-op 正是「按了没反应」的观感来源。 */

test('A 键弹确认框：显示条数与作用域，打开与 Esc 取消都不得改读态', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c', readAt: '2026-10-01T00:00:00.000Z' })] })
  await h.store.load('overview')
  await h.settle()
  const doc = h.win.document
  const unread = () => h.store.get().items.filter((entry) => entry.readAt === undefined).length
  const before = unread()

  h.press('A', true)
  await h.settle()
  const card = doc.querySelector('[data-rss-markall-confirm]')
  assert.ok(card !== null, '按大写 A 必须弹出确认框')
  assert.match(card.textContent, /2 条未读/, '条数必须是当前列表里的未读（已读那条不算）')
  assert.match(card.textContent, /全部文章/, '作用域摘要必须写清当前列表')
  assert.equal(unread(), before, '打开确认框本身不得改任何条目的读态')
  // 确认框的条数由宿主 dry-run 给出（ADR-0008）：dry-run 请求允许出现，但**写**不允许。
  assert.equal(
    h.requests.filter((entry) => entry.endpoint === 'markRead' && entry.payload?.dryRun !== true).length, 0,
    '确认之前不得发真正标读的 markRead（dryRun 只数不写）',
  )

  // 关掉再按一次必须能重新打开（确认框的状态在 Esc 后复位）
  doc.querySelector('[data-rss-markall-confirm] [role="dialog"]')
    .dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  await h.settle()
  assert.equal(doc.querySelector('[data-rss-markall-confirm]'), null, 'Esc 必须关掉确认框')
  assert.equal(unread(), before, '取消不得改读态')

  h.press('A', true)
  await h.settle()
  assert.ok(doc.querySelector('[data-rss-markall-confirm]') !== null, '大写 A 必须能再次打开确认框')
})

test('A 在源视图里只标该源（范围进宿主，不落成整个库）', skip, async () => {
  // ADR-0008：范围作为 scope 发给宿主 —— 客户端若把 feed 当成 all，别的源会被误标。
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'f1' }), item({ id: 'a2', feedId: 'f1' }), item({ id: 'b1', feedId: 'f2' })],
  })
  await h.store.load('overview')
  await h.settle()
  h.store.selectNav({ kind: 'feed', feedId: 'f1' })
  await h.settle()
  h.press('A', true)
  await h.settle()
  const card = h.win.document.querySelector('[data-rss-markall-confirm]')
  assert.ok(card !== null, '源视图里按大写 A 必须弹确认框')
  assert.match(card.textContent, /2 条未读/, '候选只算该源的 2 条，不是全库 3 条')
  h.win.document.querySelector('[data-rss-markall-ok]').click()
  await h.settle()
  const items = h.store.get().items
  assert.notEqual(items.find((entry) => entry.id === 'a1').readAt, undefined, '源内条目必须标读')
  assert.notEqual(items.find((entry) => entry.id === 'a2').readAt, undefined, '源内条目必须标读')
  assert.equal(items.find((entry) => entry.id === 'b1').readAt, undefined, '别的源的条目不许被标')
  const write = h.requests.filter((entry) => entry.endpoint === 'markRead' && entry.payload?.dryRun !== true).pop()
  assert.equal(write.payload.feedId, 'f1', '范围必须作为 feedId 发给宿主')
})

test('A 的确认框：确认后标读并给撤销窗口（只有确认那一刻才标）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  await h.settle()
  h.press('A', true)
  await h.settle()
  const ok = h.win.document.querySelector('[data-rss-markall-ok]')
  assert.ok(ok !== null, '确认框必须有一个「标为已读」按钮')
  assert.equal(ok.disabled, false, '2 条候选时按钮必须可用')
  ok.click()
  await h.settle()
  assert.ok(h.store.get().items.every((entry) => entry.readAt !== undefined), '确认后两条都必须标为已读')
  assert.deepEqual([...(h.store.get().undo?.ids ?? [])].sort(), ['a', 'b'], '撤销条必须记住这一批')
  assert.ok(h.endpoints.includes('markRead'), '确认后才发 markRead')
  assert.equal(h.win.document.querySelector('[data-rss-markall-confirm]'), null, '确认后确认框必须关掉')

  // 点撤销后焦点必须回到面板：撤销条随即卸载，焦点会掉到 body —— 之后按 A / j 会静默失效
  // （2026-11-21 真机实测 activeElement=body）。与下拉框那条同族。
  const undoButton = [...h.win.document.querySelectorAll('button')].find((button) => button.textContent === '撤销')
  assert.ok(undoButton !== undefined, '撤销条必须渲染出来')
  // 真机点鼠标会把焦点给按钮（jsdom 的 .click() 不会），所以这里显式 focus 再点 ——
  // 否则这条判据对「撤销后不归还焦点」的变异恒绿（2026-11-21 gate 实测：该变异幸存）。
  undoButton.focus()
  assert.equal(h.win.document.activeElement, undoButton, '前置条件：撤销按钮持有焦点')
  undoButton.click()
  await h.settle()
  assert.equal(h.win.document.activeElement?.getAttribute('data-dsh-rss-reader'), '', '点完撤销焦点必须回到阅读器根')
})

test('A 的确认框：0 候选时按钮禁用并说明原因（不再静默 no-op）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a', readAt: '2026-10-01T00:00:00.000Z' })] })
  await h.store.load('overview')
  await h.settle()
  h.press('A', true)
  await h.settle()
  const card = h.win.document.querySelector('[data-rss-markall-confirm]')
  assert.ok(card !== null, '即使 0 条候选也要弹框 —— 静默无反应正是用户报告的症状')
  assert.match(card.textContent, /当前范围没有可标记的未读/)
  const ok = h.win.document.querySelector('[data-rss-markall-ok]')
  assert.equal(ok.disabled, true, '0 条时确认按钮必须禁用')
})

test('改完时间范围后按 A 仍生效（下拉框用指针选完必须归还焦点）', skip, async () => {
  // 回归判据：修复前，焦点留在 [data-rss-window] 上 ⇒ isTypingTarget 把随后所有按键吞掉，
  // 按大写 A 毫无反应（2026-11-21 真机实测）。这条用例在删掉 useSelectFocusReturn 时必红。
  const h = await mountReader({ items: [item({ id: 'a' })] })
  await h.store.load('overview')
  await h.settle()
  const doc = h.win.document
  const select = doc.querySelector('[data-rss-window]')
  assert.ok(select !== null, '前置条件：顶栏有时间范围控件')

  // 指针路径：pointerdown → change。改完必须把焦点交回面板根。
  select.focus()
  select.dispatchEvent(new h.win.Event('pointerdown', { bubbles: true }))
  setControlValue(h.win, select, 'today')
  await h.settle()
  assert.notEqual(doc.activeElement, select, '指针选完范围后焦点必须离开 select，否则下一个快捷键会被吞掉')
  h.press('A', true)
  await h.settle()
  assert.ok(doc.querySelector('[data-rss-markall-confirm]') !== null, '改完范围后按大写 A 必须能弹确认框')

  // 键盘路径不抢焦点：方向键多步选择不能被中途打断
  const selectAgain = doc.querySelector('[data-rss-window]')
  selectAgain.focus()
  setControlValue(h.win, selectAgain, 'all')
  await h.settle()
  assert.equal(doc.activeElement, selectAgain, '键盘改档不得抢走焦点（否则方向键只能走一步）')
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
  // 精选源面板入口在虚拟视图之后、文件夹之前（R15 08）。
  const top = ['filter:all', 'filter:unread', 'filter:starred', 'view:sourcePack', key]
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

/* ──────────────── R8a 03：候选来源徽标（真实 React + jsdom） ──────────────── */
/**
 * 两类候选混排（spec D9）：页面声明与 RSSHub 各带来源徽标；Radar 行第二行是「站点名 · 未验证」，
 * 不许出现 format / 条数（那会让用户以为它被校验过）。「添加」对两类一视同仁 —— 都是同一个
 * onAdd → addFeed，真正的校验在那边。
 */
test('R8a 03：RSSHub 候选带来源徽标与「未验证」，添加走 addFeed；页面候选仍标「页面声明」', async () => {
  const radarUrl = 'https://hub.test/github/branches/DIYgod/RSSHub'
  const report = {
    url: 'https://github.com/DIYgod/RSSHub',
    candidates: [
      { url: 'https://github.com/feed.xml', title: '页面源', format: 'rss2', itemCount: 3, source: 'page' },
      { url: radarUrl, title: '仓库分支', siteName: 'GitHub', source: 'rsshub' },
    ],
    warnings: [{ url: 'github.com', reason: '1 条规则无法拼出完整地址' }],
  }
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
  setControlValue(h.win, doc.querySelector('[data-rss-add-input]'), 'https://github.com/DIYgod/RSSHub')
  await h.settle()
  doc.querySelector('[data-rss-discover]').click()
  await h.settle()

  const pageRow = doc.querySelector('[data-rss-candidate="https://github.com/feed.xml"]')
  assert.equal(pageRow.querySelector('[data-rss-candidate-source]').textContent, '页面声明')
  assert.match(pageRow.textContent, /rss2 · 3 条/, '页面候选保留原有的格式与条数')

  const radarRow = doc.querySelector('[data-rss-candidate="' + radarUrl + '"]')
  assert.equal(radarRow.querySelector('[data-rss-candidate-source]').textContent, 'RSSHub')
  assert.match(radarRow.textContent, /GitHub · 未验证/, 'Radar 行第二行：站点名 · 未验证')
  assert.doesNotMatch(radarRow.textContent, /条|rss2|atom/, '未验证的候选不许显示条数或格式')
  const add = radarRow.querySelector('[data-rss-candidate-add="' + radarUrl + '"]')
  assert.equal(add.disabled, false, '「添加」对 Radar 候选同样可用')
  assert.match(doc.querySelector('[data-rss-discovery]').textContent, /1 条规则无法拼出完整地址/,
    '跳过计数要在警告区可见')

  add.click()
  await h.settle()
  assert.deepEqual(h.requests.filter((request) => request.endpoint === 'addFeed').map((request) => request.payload.url),
    [radarUrl], '点 Radar 行的「添加」必须把拼出的地址交给 addFeed（那里才真正校验）')
})


/* ──────────────── R15 10：试读（候选 / 地址） ──────────────── */
/**
 * A15：候选行与地址输入框都能就地试读，显示「可用 N 条 · 耗时 X ms」或失败原因；
 * Radar 候选试读后不再停留在「未验证」。试读不落库 —— addFeed 仍是「添加」才走的路。
 */
test('R15 10：候选与地址输入框可试读；Radar 行试读后换成可用条数 / 失败原因', async () => {
  const pageUrl = 'https://site.test/a.xml'
  const radarUrl = 'https://hub.test/github/branches/DIYgod/RSSHub'
  const report = {
    url: 'https://site.test/',
    candidates: [
      { url: pageUrl, title: '页面源', format: 'rss2', itemCount: 3, source: 'page' },
      { url: radarUrl, title: '仓库分支', siteName: 'GitHub', source: 'rsshub' },
    ],
    warnings: [],
  }
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a' })],
    feeds: [{ id: 'a', title: '源 A' }],
    folderApi: async (body) => {
      if (body.endpoint === 'discoverFeeds') {
        return { ok: true, status: 200, json: async () => ({ ok: true, value: report }) }
      }
      if (body.endpoint === 'probeFeeds') {
        const value = body.payload.urls.map((url) => (url === radarUrl
          ? { url, ok: false, elapsedMs: 12, reason: '目标被安全策略拒绝' }
          : { url, ok: true, itemCount: 7, format: 'rss2', elapsedMs: 35 }))
        return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
      }
      return undefined
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

  // 标题不再把 Radar 候选算成「已验证」。
  assert.match(doc.querySelector('[data-rss-discovery]').textContent, /2 个候选/)
  assert.doesNotMatch(doc.querySelector('[data-rss-discovery]').textContent, /已验证/)

  // 页面候选：试读成功显示条数与耗时。
  doc.querySelector('[data-rss-candidate-probe="' + pageUrl + '"]').click()
  await h.settle()
  assert.match(doc.querySelector('[data-rss-candidate-probe-result="' + pageUrl + '"]').textContent,
    /可用 7 条 · 耗时 35 ms/)

  // Radar 候选：试读后「未验证」被结果替换；失败原因是可展示的一句话。
  const radarRow = doc.querySelector('[data-rss-candidate="' + radarUrl + '"]')
  assert.match(radarRow.textContent, /GitHub · 未验证/, '试读前仍是未验证')
  radarRow.querySelector('[data-rss-candidate-probe="' + radarUrl + '"]').click()
  await h.settle()
  assert.doesNotMatch(radarRow.textContent, /未验证/, '试读后不再写「未验证」')
  assert.match(radarRow.querySelector('[data-rss-candidate-probe-result="' + radarUrl + '"]').textContent,
    /目标被安全策略拒绝/)

  // 地址输入框：同一套结果展示，请求带的是输入框里那个地址。
  setControlValue(h.win, doc.querySelector('[data-rss-add-input]'), 'https://direct-probe.test/feed')
  await h.settle()
  doc.querySelector('[data-rss-add-probe]').click()
  await h.settle()
  assert.match(doc.querySelector('[data-rss-add-probe-result]').textContent, /可用 7 条 · 耗时 35 ms/)
  assert.deepEqual(
    h.requests.filter((request) => request.endpoint === 'probeFeeds').map((request) => request.payload.urls),
    [[pageUrl], [radarUrl], ['https://direct-probe.test/feed']],
    '每次试读只发被点的那一条地址',
  )
  assert.equal(h.requests.filter((request) => request.endpoint === 'addFeed').length, 0,
    '试读是只读探测，不许顺手走 addFeed 落库')
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

/* ==================== R2-01 阅读位置：回到上次那一行（真 React + jsdom） ==================== */

/** 三个条目、两个源：足够验证「选中哪一行」与「行在视口外」两种形态。 */
function readingPositionItems() {
  return [
    item({ id: 'a1' }),
    item({ id: 'a2' }),
    item({ id: 'b1', feedId: 'B', feedTitle: '源 B' }),
  ]
}

/** 一份合法的视图记忆（没有阅读位置时就是旧配置的形状）。 */
function viewMemory(overrides = {}) {
  return {
    navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true,
    reading: DEFAULT_READING_PREFERENCES, ...overrides,
  }
}

test('R2-01 重开面板：上次停留的那一行被选中', skip, async () => {
  const prefs = { value: undefined, writes: [] }
  const items = readingPositionItems()
  const first = await mountReader({ items, prefs })
  await first.settle()
  assert.equal(first.store.get().selectedId, 'a1', '前置：没有记忆时落在作用域第一条')

  // 用 j 移动两行（j/k 与纯选中都算「用户已动手」）
  first.press('j'); await first.settle()
  first.press('j'); await first.settle()
  assert.equal(first.store.get().selectedId, 'b1', '前置：用户停在 b1')

  // 关面板 = 卸载 Reader；写手必须立刻 flush（不能等 300ms 去抖 —— 面板已经没了）
  await first.unmount()
  assert.equal(prefs.value.lastItemId, 'b1', '关面板那一刻必须把当下选中项写进记忆')

  // 重开面板 = 新 store 读同一份宿主 prefs
  const second = await mountReader({ items, prefs })
  await second.settle()
  assert.equal(second.store.get().selectedId, 'b1', '重开面板必须选中上次停留的那一行')
  const row = second.win.document.querySelector('[data-rss-row="b1"]')
  assert.ok(row !== null, 'b1 必须渲染出来')
  assert.equal(row.hasAttribute('data-rss-selected'), true, '选中态必须真的画在那一行上，而不是只改了 state')
})

test('R2-01 正文里关面板：重开后选中那一篇', skip, async () => {
  const prefs = { value: undefined, writes: [] }
  const items = readingPositionItems()
  const first = await mountReader({ items, prefs })
  await first.settle()
  first.press('j'); await first.settle()
  first.press('j'); await first.settle()
  assert.equal(first.store.get().selectedId, 'b1', '前置：停在 b1')

  assert.equal(first.press('V', true), true, 'V 应当被接管')
  await first.waitFor(() => first.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await first.settle()
  assert.equal(first.store.get().article?.itemId, 'b1', '前置：正文页打开的就是 b1')

  // 在正文里关面板：flush 取的是**当下**的选中项（loadArticle 会 activate 它）
  await first.unmount()
  assert.equal(prefs.value.lastItemId, 'b1', '正文里关面板也要记住那一篇')

  const second = await mountReader({ items, prefs })
  await second.settle()
  assert.equal(second.store.get().selectedId, 'b1', '重开后那一行已被选中，按一次 Enter 就回到原文')
  assert.equal(second.store.get().view, 'list', '重开一律回列表（不自动打开正文）')
})

test('R2-01 恢复迟到：用户先选的行不被覆盖', skip, async () => {
  // 恢复要等 overview 往返；这段窗口里用户可能已经按 j / 点了另一行。
  // 把 overview 扣住就得到这个真实时序：先有手势，后有恢复。
  const prefs = { value: viewMemory({ lastItemId: 'a1' }), writes: [] }
  const items = readingPositionItems()
  const h = await mountReader({ items, prefs, holdOverview: true })
  assert.equal(h.store.get().items.length, 0, '前置：overview 被扣住，列表还没有数据')
  assert.equal(h.store.get().selectedId, undefined, '前置：恢复也还没到')

  h.store.select('b1')                     // 行点击 / j/k 走的同一个动作（纯选中）
  assert.equal(h.store.get().selectedId, 'b1', '前置：用户手势已经生效')
  h.releaseOverview()
  await h.settle()

  assert.equal(h.store.get().items.length, items.length, '前置：overview 已放行')
  assert.equal(h.store.get().selectedId, 'b1', '迟到的恢复不得把选中拽回 a1')
  assert.equal(h.win.document.querySelector('[data-rss-row="b1"]').hasAttribute('data-rss-selected'), true,
    '界面上选中的仍是用户选的那一行')
})

test('R2-01 恢复的选中行在视口外：列表把它带进视口', skip, async () => {
  // jsdom 没有布局引擎，offsetTop/offsetHeight 恒为 0 —— 给行装上可测几何，
  // 与既有「跟随选中项滚动」用例同一手法（量的是真 DOM 节点，只是尺寸由测试给）。
  const prefs = { value: viewMemory({ lastItemId: 'b1' }), writes: [] }
  const items = readingPositionItems()
  const h = await mountReader({ items, prefs, holdOverview: true })
  const list = h.arm(h.box('list'), { scrollHeight: 3000, clientHeight: 300 })
  Object.defineProperty(h.win.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return this.getAttribute?.('data-rss-row') === null ? 0 : 48 },
  })
  Object.defineProperty(h.win.HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get() {
      if (this.getAttribute?.('data-rss-row') === null) return 0
      const parent = this.parentElement
      return parent === null ? 0 : Array.from(parent.children).indexOf(this) * 1000
    },
  })

  h.releaseOverview()
  await h.settle()

  assert.equal(h.store.get().selectedId, 'b1', '前置：恢复选中了视口外的 b1（第 3 行，offsetTop 2000）')
  assert.equal(h.scrollTop(list), 1748, '恢复的选中行必须被带进视口（2000 + 48 - 300）')
})

/* ==================== R2-02 列表滚回原处（真 React + jsdom） ==================== */

/**
 * 捕获式假定时器（与 nav-persistence 的那份同形）。
 *
 * 为什么 DOM 层也要它：去抖窗口 300ms 是**行为**（窗口内只写一次、窗口长度 300ms），
 * 真等 300ms 只能断言「最终写了」，断不到「写了几次」；且会把这组用例拖慢。
 */
function fakeTimers() {
  const scheduled = new Map()
  let seq = 0
  return {
    setTimeout(handler, ms) {
      seq += 1
      scheduled.set(seq, { handler, ms })
      return seq
    },
    clearTimeout(handle) { scheduled.delete(handle) },
    pending() { return [...scheduled.values()] },
    runAll() {
      const jobs = [...scheduled.values()]
      scheduled.clear()
      for (const job of jobs) job.handler()
    },
  }
}

/** 给列表行装上可测几何（jsdom 没有布局引擎，offsetTop/offsetHeight 恒为 0）。 */
function armRows(h, { base = 0, gap = 300, rowHeight = 48 } = {}) {
  Object.defineProperty(h.win.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() { return this.getAttribute?.('data-rss-row') === null ? 0 : rowHeight },
  })
  Object.defineProperty(h.win.HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get() {
      if (this.getAttribute?.('data-rss-row') === null) return 0
      const parent = this.parentElement
      return parent === null ? 0 : base + Array.from(parent.children).indexOf(this) * gap
    },
  })
}

test('R2-02 列表滚动去抖：连续滚动只写一次，关面板 flush 最后一处位置', skip, async () => {
  const timers = fakeTimers()
  const prefs = { value: undefined, writes: [] }
  const h = await mountReader({ items: readingPositionItems(), prefs, timers })
  await h.settle()
  const list = h.arm(h.box('list'), { scrollHeight: 3000, clientHeight: 300 })
  // 首屏后选中项落在 a1；给它可测几何，避免跟随规则在滚动断言前自己动滚动条。
  armRows(h, { base: 900, gap: 300 })

  h.userScroll(list, 400)
  h.userScroll(list, 900)
  await h.settle()
  assert.equal(prefs.writes.length, 0, '去抖窗口内不许写盘（滚动逐帧写会把域写热）')
  assert.equal(timers.pending().length, 1, '连续滚动只排一次待写')

  timers.runAll()
  await h.settle()
  const saves = () => h.requests.filter((entry) => entry.endpoint === 'saveViewPreferences')
  assert.equal(saves().length, 1, '一次滚动序列只产生一次 saveViewPreferences')
  assert.equal(prefs.value.lastListScrollTop, 900, '落盘内容必须含最后的滚动位置')
  assert.equal(prefs.value.lastItemId, 'a1', '整份写同时带上当下的选中项')

  // 滚动后立刻关面板：定时器还没到点，卸载 flush 必须把最后位置带走
  h.userScroll(list, 1200)
  await h.unmount()
  assert.equal(saves().length, 2, '卸载 flush 落一次')
  assert.equal(prefs.value.lastListScrollTop, 1200, '关面板那一刻的位置必须记住')
})

test('R2-02 重开面板：列表滚回保存的位置，且恢复本身不写盘', skip, async () => {
  // 保存值是像素坐标：首屏渲染完成后写回 scrollTop。选中 a1 的行在恢复后的视口内，
  // 因此既有的「跟随选中」规则不应再动它（票面验收：选中行仍在视口内）。
  const prefs = { value: viewMemory({ lastListScrollTop: 640 }), writes: [] }
  const h = await mountReader({ items: readingPositionItems(), prefs, holdOverview: true })
  const list = h.arm(h.box('list'), { scrollHeight: 3000, clientHeight: 300 })
  armRows(h, { base: 700, gap: 300 })

  h.releaseOverview()
  await h.settle()

  assert.equal(h.store.get().selectedId, 'a1', '前置：恢复落在第一条')
  assert.equal(h.scrollTop(list), 640, '列表必须滚回保存的位置')
  assert.equal(h.win.document.querySelector('[data-rss-row="a1"]').hasAttribute('data-rss-selected'), true,
    '选中态画在那一行上')
  assert.equal(prefs.writes.length, 0, '恢复只读不写：打开面板不产生 saveViewPreferences')
})

test('R2 同一个 store 卸载后再挂载：第二次仍恢复选中与滚动', skip, async () => {
  // 真实宿主只在 apply() 里建一次 store，「切走再回来」是组件卸载后重挂，store 不重建。
  // 这条用例必须复用同一个 store —— 每次 mount 都新建 store 的话，记忆标志位永远是新的，
  // 第二次挂载不恢复的缺陷会被夹具自己盖掉。
  const prefs = { value: viewMemory({ lastItemId: 'b1', lastListScrollTop: 640 }), writes: [] }
  const items = readingPositionItems()
  const first = await mountReader({ items, prefs, holdOverview: true })
  const firstList = first.arm(first.box('list'), { scrollHeight: 3000, clientHeight: 300 })
  armRows(first, { base: 500, gap: 100 })
  first.releaseOverview()
  await first.settle()
  assert.equal(first.store.get().selectedId, 'b1', '前置：第一次挂载恢复选中 b1')
  assert.equal(first.scrollTop(firstList), 640, '前置：第一次挂载恢复滚动 640')
  await first.unmount()

  const second = await mountReader({ items, prefs, holdOverview: true, store: first.store })
  const secondList = second.arm(second.box('list'), { scrollHeight: 3000, clientHeight: 300 })
  armRows(second, { base: 500, gap: 100 })
  second.releaseOverview()
  await second.settle()

  assert.equal(second.store.get().selectedId, 'b1', '同一个 store 的第二次挂载仍须恢复选中')
  assert.equal(second.scrollTop(secondList), 640, '同一个 store 的第二次挂载仍须恢复滚动位置')
  assert.equal(prefs.writes.length, 0, '两次恢复都只读不写')
})

test('R2-02 保存的滚动位置超过当前可滚范围：夹到最近有效位置，且程序化写回不排写', skip, async () => {
  const timers = fakeTimers()
  const prefs = { value: viewMemory({ lastListScrollTop: 5000 }), writes: [] }
  const h = await mountReader({ items: readingPositionItems(), prefs, holdOverview: true, timers })
  const list = h.arm(h.box('list'), { scrollHeight: 3000, clientHeight: 300 })
  // 选中行放在夹取后的视口内（2700..3000），避免跟随规则把结果改写成别的值
  armRows(h, { base: 2800, gap: 300 })

  h.releaseOverview()
  await h.settle()

  assert.equal(h.scrollTop(list), 2700, '5000 必须夹到 scrollHeight - clientHeight = 2700')
  // 真浏览器会为「把 scrollTop 写成 2700」派发一次 scroll 事件。恢复时记下的必须是**夹取后**的值，
  // 否则监听器会把 2700 当成一次新滚动，排出一次纯属恢复副作用的写盘。
  h.userScroll(list, 2700)
  assert.equal(timers.pending().length, 0, '夹取后的写回不得排一次写（记忆里的值与 DOM 一致）')
  timers.runAll()
  await h.settle()
  assert.equal(prefs.writes.length, 0, '夹取与恢复（含它触发的 scroll）都不写盘')
})

test('R2-02 恢复到达前用户已滚动：旧记忆的选中与滚动都不许覆盖用户手势', skip, async () => {
  const timers = fakeTimers()
  const prefs = { value: viewMemory({ lastItemId: 'b1', lastListScrollTop: 640 }), writes: [] }
  const h = await mountReader({ items: readingPositionItems(), prefs, holdOverview: true, timers })
  const list = h.arm(h.box('list'), { scrollHeight: 3000, clientHeight: 300 })
  // 选中行放在用户滚动后的视口内（500..800），于是最终 scrollTop 只由「谁赢」决定
  armRows(h, { base: 600, gap: 300 })

  h.userScroll(list, 500)                  // 恢复还在路上，用户自己滚到了 500
  assert.equal(timers.pending().length, 1, '前置：用户的滚动已经排了一次去抖写')
  h.releaseOverview()
  await h.settle()

  assert.equal(h.scrollTop(list), 500, '迟到的恢复不得把滚动位置重置回 640')
  assert.equal(h.store.get().selectedId, 'a1', '滚动也是用户手势：恢复不得把选中拽到 b1（保留 overview 落地的第一条）')
})

test('R2-02 恢复的滚动位置让选中行落到视口外：跟随规则把它带进来', skip, async () => {
  // 与 R2-01 的「选中行在视口外」同形，但这次保存的滚动位置是 0 —— 证明恢复滚动
  // 与跟随选中是两条接力：先写回 0，再由既有规则把视口外的选中行带进视口。
  const prefs = { value: viewMemory({ lastItemId: 'b1', lastListScrollTop: 0 }), writes: [] }
  const h = await mountReader({ items: readingPositionItems(), prefs, holdOverview: true })
  const list = h.arm(h.box('list'), { scrollHeight: 3000, clientHeight: 300 })
  armRows(h, { base: 0, gap: 1000 })

  h.releaseOverview()
  await h.settle()

  assert.equal(h.store.get().selectedId, 'b1', '前置：恢复选中了视口外的 b1（第 3 行，offsetTop 2000）')
  assert.equal(h.scrollTop(list), 1748, '先恢复 0，再按跟随规则把 b1 带进视口（2000 + 48 - 300）')
})

/* ──────────────── R1-03：顶栏时间范围档位（真 React + jsdom + 真 bundle） ──────────────── */

/** R1-03 的固定「现在」：本地自然日边界必须可预测（边界由被测代码用本地日期构造器算）。 */
const WINDOW_NOW = new Date(2026, 10, 20, 10, 0, 0)
const WINDOW_FROM = new Date(2026, 10, 20).toISOString()
const WINDOW_TO = new Date(2026, 10, 21).toISOString()
const atLocal = (day, hour = 12) => new Date(2026, 10, day, hour, 0, 0).toISOString()
const windowFeeds = () => [
  { id: 'f1', title: '源 1', folder: '技术' },
  { id: 'f2', title: '源 2' },
]
const windowFolders = () => [{ name: '技术', feedIds: ['f1'] }]
/**
 * 夹具（spec 验收 1 的子集）：
 *   今天 3 条（2 未读 + 1 已读）、2 天前 1 条未读、10 天前 1 条未读、无日期 1 条未读。
 *   「全部」= 6 条 / 5 未读；「今天」= 3 条 / 2 未读；「近 3 天」= 4 条 / 3 未读。
 */
function windowItems() {
  return [
    item({ id: 'today-1', feedId: 'f1', publishedAt: atLocal(20, 1), starred: true, keptUnread: true }),
    item({ id: 'today-2', feedId: 'f1', publishedAt: atLocal(20, 2) }),
    item({ id: 'today-read', feedId: 'f2', publishedAt: atLocal(20, 3), readAt: '2026-11-20T03:00:00.000Z' }),
    item({ id: 'two-days', feedId: 'f2', publishedAt: atLocal(18) }),
    item({ id: 'ten-days', feedId: 'f1', publishedAt: atLocal(10) }),
    item({ id: 'no-date', feedId: 'f2', fetchedAt: atLocal(20, 4) }),
  ]
}
const windowMount = (extra = {}) => mountReader({
  items: windowItems(), feeds: windowFeeds(), folders: windowFolders(),
  now: () => WINDOW_NOW.getTime(), ...extra,
})

test('R1-03 窗口控件：默认全部、四个档位、与「已加载」同一行、Tab 可达且焦点守卫放行', skip, async () => {
  const h = await windowMount()
  await h.settle()
  const doc = h.win.document
  const select = doc.querySelector('[data-rss-window]')
  assert.ok(select, '列表视图的顶栏必须有时间范围控件')
  assert.equal(select.tagName, 'SELECT', '必须是原生 select（Tab 可达、键盘可操作）')
  assert.equal(select.value, 'all', '默认档位是「全部」')
  assert.deepEqual([...select.options].map((option) => option.value), ['all', 'today', '3d', '7d'])
  assert.deepEqual([...select.options].map((option) => option.textContent), ['全部时间', '今天', '近 3 天', '近 7 天'])
  const counts = select.closest('.dsh-rss-counts')
  assert.ok(counts !== null, '控件与「已加载 X 条」必须在同一行（同一个计数容器）')
  // R1-04 起「全部」档位把未读的构成说出来（R1-03 这里是「全局 N 条未读」）。
  assert.match(counts.textContent, /共 5 条未读/, '全部档位的总未读')
  assert.match(counts.textContent, /今天 2 · 更早 2 · 无日期 1/, '全部档位带三联拆分（数字来自宿主回包）')
  assert.match(counts.textContent, /已加载 6 条/)
  assert.equal(select.tabIndex, 0, '原生 select 默认可 Tab 聚焦')
  assert.equal(select.disabled, false)

  // 焦点在 SELECT 上：既有的输入控件守卫必须放行（j 不生效），失焦后恢复。
  const before = h.store.get().selectedId
  const list = h.arm(h.box('list'), { scrollHeight: 3000, clientHeight: 300 })
  select.focus()
  const jEvent = new h.win.KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })
  select.dispatchEvent(jEvent)
  assert.equal(h.store.get().selectedId, before, '焦点在 SELECT 上时 j 不得移动选中')
  assert.equal(jEvent.defaultPrevented, false, '守卫应直接放行，而不是拦下按键')
  select.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true }))
  assert.equal(h.store.get().selectedId, before, '焦点在 SELECT 上时 k 不得移动选中')
  select.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
  assert.equal(h.scrollTop(list), 0, '焦点在 SELECT 上时空格不得翻页')
  select.blur()
  h.press('j')
  assert.notEqual(h.store.get().selectedId, before, '失焦后 j 必须恢复')

  // A 的范围控件 2026-11-21 搬进了确认框；R11 05 起工具栏「更多」整个删除（没有任何条目了）。
  // 改完设置焦点留在 select 上，随后的 A 会被输入控件守卫吞掉 —— 那正是用户报告的那次「按 A 无反应」。
  assert.equal(doc.querySelector('.dsh-rss-settings-panel'), null,
    '工具栏「更多」必须已整个删除；列表视图里不该再有它的面板')
  h.press('A', true)
  await h.settle()
  const confirm = doc.querySelector('[data-rss-markall-confirm]')
  assert.ok(confirm !== null, '范围控件必须在 A 的确认框里')
  assert.match(confirm.textContent, /当前列表/)
  assert.ok(doc.querySelector('[data-rss-markall-range]') !== null, '确认框里必须有范围下拉')
  doc.querySelector('[data-rss-markall-cancel]').click()
  await h.settle()
  h.press('?')
  await h.settle()
  assert.match(doc.querySelector('[data-rss-help]').textContent, /当前列表/)

  // 只在列表视图渲染：切到订阅管理后控件必须消失（顶栏标题换了，计数行整块不渲染）。
  h.store.toggleFeeds()
  await h.settle()
  assert.equal(doc.querySelector('[data-rss-window]'), null, '非列表视图不得渲染时间范围控件')
})

test('R1-03 切档：只发一次 overview（本地日界）、items 整体替换、选中落第一条、账目与角标按窗', skip, async () => {
  const h = await windowMount({ badge: true })
  await h.settle()
  const doc = h.win.document
  setControlValue(h.win, doc.querySelector('[data-rss-window]'), 'today')
  await h.settle()

  const overviewCalls = h.requests.filter((request) => request.endpoint === 'overview')
  assert.equal(overviewCalls.length, 1, '切档必须只发一次 overview（新档第一页）')
  assert.deepEqual(overviewCalls[0].payload, { from: WINDOW_FROM, to: WINDOW_TO, todayFrom: WINDOW_FROM },
    '请求体必须带本地自然日的半开区间与「今天」的起点，由唯一构造器一次产出')

  const state = h.store.get()
  assert.deepEqual([...state.items].map((entry) => entry.id), ['today-1', 'today-2', 'today-read'],
    'items 必须整体替换成新档第一页，而不是在旧列表上追加')
  assert.equal(state.selectedId, 'today-1', '选中落到新列表第一条')
  assert.equal([...doc.querySelectorAll('[data-rss-row]')].length, 3, '界面上旧档条目必须消失')
  assert.equal(state.displayWindow, 'today')

  const counts = doc.querySelector('.dsh-rss-counts')
  assert.match(counts.textContent, /今天 2 条未读/, '窗口档位的顶栏文案是「今天 N 条未读」')
  assert.match(counts.textContent, /已加载 3 条/)

  // 同一档位下的守恒：顶栏总未读 = 各源角标之和；文件夹角标 = 成员角标之和。
  const sum = Object.values({ ...state.perFeedUnread }).reduce((acc, n) => acc + n, 0)
  assert.equal(sum, state.unread, '顶栏总未读必须等于各源角标之和')
  const folderBadge = [...doc.querySelectorAll('[data-rss-nav-badge]')]
    .find((element) => element.textContent.includes('技术'))
  assert.equal(folderBadge?.getAttribute('data-rss-nav-badge'), '2', '文件夹角标 = 成员源角标之和（f1 今天 2 未读）')

  // 侧栏徽标读同一个 state.unread：切档一起变，不另存「全局总数」。
  assert.equal(h.badgeText(), '2', '侧栏徽标与顶栏必须是同一个数')
})

test('R1-03 窗口选空：只发一次请求、显示空态、不自动放宽', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'old', feedId: 'f1', publishedAt: atLocal(10) })],
    feeds: windowFeeds(), folders: windowFolders(),
    now: () => WINDOW_NOW.getTime(),
  })
  await h.settle()
  setControlValue(h.win, h.win.document.querySelector('[data-rss-window]'), 'today')
  await h.settle()

  assert.equal(h.requests.filter((request) => request.endpoint === 'overview').length, 1,
    '空窗口只发一次 overview，不得自动换更宽的档位再发一次')
  assert.equal(h.store.get().items.length, 0)
  assert.equal(h.store.get().displayWindow, 'today', '不得自动放宽档位')
  assert.equal(h.win.document.querySelector('[data-rss-window]').value, 'today')
  assert.match(h.box('list').textContent, /「今天」内暂无内容，可换一个时间范围/)
})

test('R1-03 窗口为空且请求失败：照旧显示错误，不拿「暂无内容」掩盖', skip, async () => {
  const h = await windowMount({
    overviewApi: async (body) => {
      if (body.payload?.from !== undefined) throw new Error('injected-window-failure')
      return undefined
    },
  })
  await h.settle()
  setControlValue(h.win, h.win.document.querySelector('[data-rss-window]'), 'today')
  await h.settle()
  const doc = h.win.document
  assert.match(doc.querySelector('[role="alert"]').textContent, /injected-window-failure/,
    '错误必须照旧显示（空态不许掩盖失败）')
  assert.doesNotMatch(h.box('list').textContent, /可换一个时间范围/,
    '有 error 时不许显示「暂无内容」的空态文案')
})

test('R1-03 搜索进行中控件 disabled 并说明原因，退出搜索恢复', skip, async () => {
  const h = await windowMount({ search: async () => ({ items: [] }) })
  await h.settle()
  h.store.submitSearch({ text: '支付' })
  await h.settle()
  const doc = h.win.document
  const select = doc.querySelector('[data-rss-window]')
  assert.equal(select.disabled, true, '搜索进行中必须禁用时间范围控件')
  assert.match(doc.querySelector('[data-rss-window-reason]').textContent, /搜索有自己的日期筛选/,
    '禁用必须给出可见原因')

  h.store.submitSearch()
  await h.settle()
  assert.equal(doc.querySelector('[data-rss-window]').disabled, false, '退出搜索后恢复')
})

test('R1-03 切档不动范围/过滤/A 范围/条目读态，切文件夹也不重置档位', skip, async () => {
  const h = await windowMount()
  await h.settle()
  h.store.setFilter('unread')
  h.store.setMarkAllRange('week')
  await h.settle()
  const writesBeforeWindow = h.prefs.writes.length
  setControlValue(h.win, h.win.document.querySelector('[data-rss-window]'), 'today')
  await h.settle()

  assert.equal(h.prefs.writes.length, writesBeforeWindow, '切档本身不写视图记忆（档位不持久化）')
  const state = h.store.get()
  assert.equal(state.filter, 'unread', '切档不改变过滤三连')
  assert.equal(state.markAllRange, 'week', '切档不改变 A 键范围')
  assert.equal(state.navSelection.kind, 'virtual', '切档不改变当前源/文件夹/标签')
  const todayOne = state.items.find((entry) => entry.id === 'today-1')
  assert.equal(todayOne.starred, true, '切档不改星标')
  assert.equal(todayOne.keptUnread, true, '切档不改保持未读')
  assert.equal(todayOne.readAt, undefined, '切档不改已读态')
  assert.equal(state.items.find((entry) => entry.id === 'today-read').readAt, '2026-11-20T03:00:00.000Z',
    '窗内的已读条目仍是已读')

  // 切文件夹（会触发一次带窗重取）不重置档位。
  h.store.selectNav({ kind: 'folder', folder: '技术' })
  await h.settle()
  assert.equal(h.store.get().displayWindow, 'today', '切文件夹不重置档位')
  assert.equal(h.win.document.querySelector('[data-rss-window]').value, 'today')
  const lastOverview = h.requests.filter((request) => request.endpoint === 'overview').at(-1)
  assert.equal(lastOverview.payload.folder, '技术', '文件夹范围照旧带给宿主')
  assert.equal(lastOverview.payload.from, WINDOW_FROM, '切文件夹后的取数仍带同一份窗口')

  // 切单个源同样不重置档位（源切换不重取，但档位是视野设置，与范围正交）。
  h.store.selectNav({ kind: 'feed', feedId: 'f1' })
  assert.equal(h.store.get().displayWindow, 'today', '切源不重置档位')
})

test('R1-03 在途续页：切档后旧回包不得把旧档条目追加进来（hold 控制回包顺序）', skip, async () => {
  let releaseOldPage
  const oldPageGate = new Promise((resolve) => { releaseOldPage = resolve })
  const h = await windowMount({
    overviewApi: async (body, ctx) => {
      if (body.payload?.cursor === 'C1') {
        // 旧档的第二页：先扣住，等切档与新档第一页都落地后再放行。
        await oldPageGate
        return {
          ...ctx.overviewStub([item({ id: 'old-page', feedId: 'f1', publishedAt: atLocal(10) })], ctx.serverFeeds, ctx.serverFolders),
          nextCursor: undefined,
        }
      }
      if (body.endpoint === 'refresh') {
        return { ...ctx.overviewStub(ctx.items, ctx.serverFeeds, ctx.serverFolders), nextCursor: 'C1' }
      }
      return undefined
    },
  })
  await h.settle()
  const doc = h.win.document
  const more = [...doc.querySelectorAll('button')].find((button) => button.textContent.includes('加载更多'))
  assert.ok(more !== undefined, '前置：第一页必须有续页入口')
  more.click()
  await h.waitFor(() => h.store.get().loadingMore === true, { label: '旧档续页在途' })

  setControlValue(h.win, doc.querySelector('[data-rss-window]'), 'today')
  await h.waitFor(() => h.store.get().displayWindow === 'today' && h.store.get().items.length === 3,
    { label: '新档第一页落地' })
  await h.settle({ allowPending: true })

  releaseOldPage()
  await h.settle()
  assert.deepEqual([...h.store.get().items].map((entry) => entry.id), ['today-1', 'today-2', 'today-read'],
    '旧档续页的回包必须整包丢弃，最终 items 全部属于新档')
  assert.equal(h.store.get().loadingMore, false, '切档必须清掉在途续页的 loadingMore 标记')
})

/* ──────────────── R1 评审 P1：账目必须跟着窗口走（不许把别的窗口的数字挂在当前档位名下） ──────────────── */

test('R1 评审 P1：切档时账目未对齐 —— 顶栏「正在统计…」、左栏角标与徽标消失，回包落地后才恢复', skip, async () => {
  let releaseWindow
  const windowGate = new Promise((resolve) => { releaseWindow = resolve })
  const h = await windowMount({
    badge: true,
    overviewApi: async (body) => {
      // 只扣住带窗的 overview：首屏 refresh（全部）必须正常落地，否则没有旧账可撒谎。
      if (body.payload?.from !== undefined) await windowGate
      return undefined
    },
  })
  await h.settle()
  const doc = h.win.document
  assert.equal(h.badgeText(), '5', '前置：全部档位的账目已落地')
  assert.match(doc.querySelector('.dsh-rss-counts').textContent, /共 5 条未读/)

  setControlValue(h.win, doc.querySelector('[data-rss-window]'), 'today')
  await h.waitFor(() => doc.querySelector('[data-rss-unread-pending]') !== null,
    { label: '切档后出现「账目未对齐」标记' })
  const counts = doc.querySelector('.dsh-rss-counts')
  assert.match(counts.textContent, /正在统计/, '未对齐期间只给中性文案')
  assert.equal(doc.querySelector('[data-rss-unread-count]'), null, '未对齐期间不许渲染任何未读数字')
  assert.doesNotMatch(counts.textContent, /今天 5 条未读/, '绝不许把「全部」的 5 条挂在「今天」名下')
  assert.doesNotMatch(counts.textContent, /共 5 条未读/, '连「全部」档位的文案也不许留在「今天」档位下')
  assert.equal(doc.querySelectorAll('[data-rss-nav-badge]').length, 0,
    '未对齐期间左栏每源 / 文件夹角标必须一起消失')
  assert.equal(h.badgeText(), '', '未对齐期间侧栏徽标必须一起消失')

  releaseWindow()
  await h.settle()
  assert.equal(doc.querySelector('[data-rss-unread-pending]'), null, '窗内账落地后 pending 必须消失')
  assert.match(doc.querySelector('.dsh-rss-counts').textContent, /今天 2 条未读/, '顶栏改说窗内数')
  assert.equal(doc.querySelector('[data-rss-nav-row="feed:f1"]').getAttribute('data-rss-nav-badge'), '2',
    'f1 的角标恢复成窗内数')
  assert.equal(doc.querySelector('[data-rss-nav-row="feed:f2"]').getAttribute('data-rss-nav-badge'), '0',
    '0 未读的源照旧有键（不是空白）')
  const folderBadge = [...doc.querySelectorAll('[data-rss-nav-badge]')]
    .find((element) => element.textContent.includes('技术'))
  assert.equal(folderBadge?.getAttribute('data-rss-nav-badge'), '2', '文件夹角标 = 成员源角标之和')
  assert.equal(h.badgeText(), '2', '侧栏徽标恢复成同一个窗内数')
})

test('R1 评审 P1：切档 overview 失败 —— 错误可见、顶栏停在「正在统计…」，切回原档位立刻恢复', skip, async () => {
  let holdAll = false
  let releaseAll
  const allGate = new Promise((resolve) => { releaseAll = resolve })
  const h = await windowMount({
    badge: true,
    overviewApi: async (body) => {
      if (body.payload?.from !== undefined) throw new Error('injected-window-failure')
      if (holdAll) await allGate
      return undefined
    },
  })
  await h.settle()
  const doc = h.win.document
  setControlValue(h.win, doc.querySelector('[data-rss-window]'), 'today')
  await h.waitFor(() => doc.querySelector('[role="alert"]')?.textContent?.includes('injected-window-failure') === true,
    { label: '带窗 overview 失败并显示错误' })

  assert.ok(doc.querySelector('[data-rss-unread-pending]'), '失败后账目仍未对齐：顶栏必须停在 pending')
  assert.match(doc.querySelector('.dsh-rss-counts').textContent, /正在统计/)
  assert.doesNotMatch(doc.querySelector('.dsh-rss-counts').textContent, /今天 \d+ 条未读/,
    '失败时不许出现「窗口名 + 数字」（那个数其实属于另一个窗口）')
  assert.equal(h.badgeText(), '', '失败期间侧栏徽标也必须是空的')
  assert.equal(doc.querySelectorAll('[data-rss-nav-badge]').length, 0, '失败期间左栏角标必须是空的')

  // 切回「全部」：账目标记仍是「全部」⇒ 数字立即恢复，不必等这次 overview 回包（扣住它）。
  holdAll = true
  setControlValue(h.win, doc.querySelector('[data-rss-window]'), 'all')
  await h.waitFor(() => doc.querySelector('[data-rss-unread-pending]') === null,
    { label: '切回全部后数字恢复' })
  assert.equal(h.store.get().loading, true, '回包还在路上：恢复不是等出来的')
  assert.match(doc.querySelector('.dsh-rss-counts').textContent, /共 5 条未读/)
  assert.equal(h.badgeText(), '5')

  releaseAll()
  await h.settle()
})

test('R1 评审 P1：切档前发出的 markRead 回包晚到 —— 不得把「全部」的账盖回「今天」', skip, async () => {
  let releaseMarkRead
  const markReadGate = new Promise((resolve) => { releaseMarkRead = resolve })
  const h = await windowMount({ badge: true, markReadGate })
  await h.settle()
  const doc = h.win.document
  assert.equal(h.badgeText(), '5', '前置：全部档位的账目已落地')

  // 「全部」档位发出一次标读（ten-days 在「今天」窗外，今天窗的账不受它影响），回包被扣住。
  const markDone = h.store.markRead('ten-days')
  await h.waitFor(() => h.store.get().unread === 4, { label: '乐观账目生效' })

  setControlValue(h.win, doc.querySelector('[data-rss-window]'), 'today')
  await h.waitFor(() => doc.querySelector('.dsh-rss-counts')?.textContent.includes('今天 2 条未读') === true,
    { label: '新档第一页落地、顶栏按窗报数' })
  assert.equal(h.badgeText(), '2')

  // 旧档（全部）的回包现在才到：整份丢弃，不许把账目改回「全部」的 4 条 / f2 的 2 条。
  releaseMarkRead()
  await markDone
  await h.settle()
  assert.equal(h.store.get().unread, 2, '旧窗口回包必须整份丢弃（「全部」是 4 条，今天窗是 2 条）')
  assert.deepEqual(h.store.get().perFeedUnread, { f1: 2, f2: 0 }, '每源角标也不得被旧窗口的账覆盖')
  assert.equal(doc.querySelector('[data-rss-unread-pending]'), null, '迟到的旧账不得把对齐状态打回 pending')
  assert.match(doc.querySelector('.dsh-rss-counts').textContent, /今天 2 条未读/)
  assert.equal(h.badgeText(), '2')
})

test('R1-03 重开面板：档位不持久化，回到「全部」', skip, async () => {
  const now = () => WINDOW_NOW.getTime()
  const first = await mountReader({ items: windowItems(), feeds: windowFeeds(), folders: windowFolders(), now })
  await first.settle()
  setControlValue(first.win, first.win.document.querySelector('[data-rss-window]'), 'today')
  await first.settle()
  assert.equal(first.store.get().displayWindow, 'today', '前置：已切到「今天」')

  await first.unmount()
  assert.equal(first.store.get().displayWindow, 'all', '面板卸载 = 会话结束：档位复位（不写视图记忆）')

  const second = await mountReader({ items: windowItems(), feeds: windowFeeds(), folders: windowFolders(), now, store: first.store })
  await second.settle()
  assert.equal(second.store.get().displayWindow, 'all')
  assert.equal(second.win.document.querySelector('[data-rss-window]').value, 'all', '重开面板默认「全部」')
  const refresh = second.requests.filter((request) => request.endpoint === 'refresh')
  assert.equal(refresh.length, 1)
  assert.equal(refresh[0].payload?.from, undefined, '重开后的首屏取数不带窗口（旧行为）')
})

/* ──────────────── R1-04：未读三联拆分与顶栏文案（真 React + jsdom + 真 bundle） ──────────────── */

/**
 * 夹具（比 R1-03 的 windowItems 多一条**已读**的无日期条目）：
 *   今天 3 条（2 未读 + 1 已读）、2 天前 1 未读、10 天前 1 未读、无日期 2 条（1 未读 + 1 已读）。
 *   全部 = 7 条 / 5 未读；三联 = 今天 2 / 更早 2 / 无日期 1（已读的 no-date-read 不进 K）。
 *   「今天」窗 = 3 条 / 2 未读，split 仍是同一份（与窗口无关）。
 */
function splitItems() {
  return [
    item({ id: 'today-1', feedId: 'f1', publishedAt: atLocal(20, 1) }),
    item({ id: 'today-2', feedId: 'f1', publishedAt: atLocal(20, 2) }),
    item({ id: 'today-read', feedId: 'f2', publishedAt: atLocal(20, 3), readAt: '2026-11-20T03:00:00.000Z' }),
    item({ id: 'two-days', feedId: 'f2', publishedAt: atLocal(18) }),
    item({ id: 'ten-days', feedId: 'f1', publishedAt: atLocal(10) }),
    item({ id: 'no-date', feedId: 'f2', fetchedAt: atLocal(20, 4) }),
    item({ id: 'no-date-read', feedId: 'f2', fetchedAt: atLocal(20, 4), readAt: '2026-11-19T00:00:00.000Z' }),
  ]
}
const splitMount = (extra = {}) => mountReader({
  items: splitItems(), feeds: windowFeeds(), folders: windowFolders(),
  now: () => WINDOW_NOW.getTime(), ...extra,
})

test('R1-04 全部档位文案：三个桶来自宿主回包，K 只数未读', skip, async () => {
  const h = await splitMount()
  await h.settle()
  const counts = h.win.document.querySelector('.dsh-rss-counts')

  assert.match(counts.textContent, /共 5 条未读/, 'X = 总未读（不是 items 条数 7）')
  assert.match(counts.textContent, /今天 2/, 'today = publishedAt >= todayFrom 的未读')
  assert.match(counts.textContent, /更早 2/, 'earlier = 今天之前的未读')
  assert.match(counts.textContent, /无日期 1/, 'K 只数未读：两条无日期里那条已读的不能算')

  // 「全部」档位也必须把今天起点带给宿主，否则回包没有拆分 —— 客户端不本地推导。
  const first = h.requests.find((request) => request.endpoint === 'refresh' || request.endpoint === 'overview')
  assert.equal(first.payload.todayFrom, WINDOW_FROM, '全部档位的请求也带今天起点')
  assert.equal(first.payload.from, undefined, '全部档位不带窗口（旧行为）')
})

test('R1-04 全部档位省零：今天 0 省「今天 0」、无日期 0 省「无日期 0」', skip, async () => {
  const onlyEarlier = await mountReader({
    items: [item({ id: 'old', feedId: 'f1', publishedAt: atLocal(10) })],
    feeds: windowFeeds(), folders: windowFolders(), now: () => WINDOW_NOW.getTime(),
  })
  await onlyEarlier.settle()
  const onlyEarlierText = onlyEarlier.win.document.querySelector('.dsh-rss-counts').textContent
  assert.match(onlyEarlierText, /共 1 条未读/, '总未读照常')
  assert.match(onlyEarlierText, /更早 1/, '更早永远显示（基线只规定省掉两个 0）')
  assert.doesNotMatch(onlyEarlierText, /今天 0/, 'today = 0 时不许写「今天 0」')
  assert.doesNotMatch(onlyEarlierText, /无日期 0/, 'noDate = 0 时不许写「无日期 0」')

  const todayNoDateZero = await mountReader({
    items: splitItems().filter((entry) => !entry.id.startsWith('no-date')),
    feeds: windowFeeds(), folders: windowFolders(), now: () => WINDOW_NOW.getTime(),
  })
  await todayNoDateZero.settle()
  const text = todayNoDateZero.win.document.querySelector('.dsh-rss-counts').textContent
  assert.match(text, /共 4 条未读/, '4 = 今天 2 + 更早 2')
  assert.match(text, /今天 2/, '不是零的那一项照常显示')
  assert.doesNotMatch(text, /无日期 0/, 'noDate = 0 时省掉')
})

test('R1-04 窗口档位文案：窗内数 + 无日期未计入提示（K=0 不提示）；没有 split 时回落旧文案', skip, async () => {
  const h = await splitMount()
  await h.settle()
  const doc = h.win.document
  setControlValue(h.win, doc.querySelector('[data-rss-window]'), 'today')
  await h.settle()

  const counts = doc.querySelector('.dsh-rss-counts')
  assert.match(counts.textContent, /今天 2 条未读/, '窗口档位的 N 是窗内未读（今天窗 = 2）')
  assert.match(counts.textContent, /另有 1 条未读没有发布日期，未计入/,
    'K > 0 时追加提示；K 来自同一份 split，不是客户端数 items')
  assert.deepEqual(h.store.get().unreadSplit, { today: 2, earlier: 2, noDate: 1 },
    '窗口档位下 state 里保存的 split 仍是「全部未读」的三分')

  // 验收 12 的 DOM 半边：今天档位标掉一条今天的未读 —— 窗内数减 1，split.today 也减 1，
  // 无日期的 K 一格不动（它描述的是全量未读，与窗口无关）。
  await h.store.markRead('today-1')
  await h.settle()
  assert.deepEqual(h.store.get().unreadSplit, { today: 1, earlier: 2, noDate: 1 })
  assert.match(counts.textContent, /今天 1 条未读/)
  assert.match(counts.textContent, /另有 1 条未读没有发布日期，未计入/)

  // K = 0：同一条提示不许出现（把无日期条目从夹具里去掉）。
  const noNoDate = await mountReader({
    items: splitItems().filter((entry) => !entry.id.startsWith('no-date')),
    feeds: windowFeeds(), folders: windowFolders(), now: () => WINDOW_NOW.getTime(),
  })
  await noNoDate.settle()
  setControlValue(noNoDate.win, noNoDate.win.document.querySelector('[data-rss-window]'), 'today')
  await noNoDate.settle()
  const noNoDateText = noNoDate.win.document.querySelector('.dsh-rss-counts').textContent
  assert.match(noNoDateText, /今天 2 条未读/)
  assert.doesNotMatch(noNoDateText, /没有发布日期/, 'K = 0 时不许出现「未计入」提示')

  // 宿主没给 split（旧宿主 / 回包缺席）：全部档位回落到既有的「全局 X 条未读」。
  const legacy = await mountReader({
    items: splitItems(), feeds: windowFeeds(), folders: windowFolders(), now: () => WINDOW_NOW.getTime(),
    overviewApi: async (_body, ctx) => ctx.overviewStub(ctx.items, ctx.serverFeeds, ctx.serverFolders),
  })
  await legacy.settle()
  const legacyText = legacy.win.document.querySelector('.dsh-rss-counts').textContent
  assert.match(legacyText, /全局 5 条未读/, 'split 缺席 ⇒ 回落旧文案，不编造 0/0/0')
  assert.equal(legacy.store.get().unreadSplit, undefined, '缺席即缺席，不沿用旧值')
})

test('R1-04 写操作后 split 由回包整份覆盖：标读后今天减 1，星标后原样保留', skip, async () => {
  const h = await splitMount()
  await h.settle()
  const doc = h.win.document

  await h.store.markRead('today-1')
  await h.settle()
  assert.deepEqual(h.store.get().unreadSplit, { today: 1, earlier: 2, noDate: 1 },
    '标掉一条今天的未读：回包的 split 整体覆盖（today 2 → 1），不是被清空')
  assert.match(doc.querySelector('.dsh-rss-counts').textContent, /共 4 条未读/)
  assert.match(doc.querySelector('.dsh-rss-counts').textContent, /今天 1/)
  const markRequest = h.requests.filter((request) => request.endpoint === 'markRead').at(-1)
  assert.equal(markRequest.payload.todayFrom, WINDOW_FROM, '账目镜像也带同一份今天起点（窗随账走）')

  await h.store.toggleStar('two-days')
  await h.settle()
  assert.deepEqual(h.store.get().unreadSplit, { today: 1, earlier: 2, noDate: 1 },
    '不改读态的动作（星标）也必须把 split 原样带回，不能抹掉')
  assert.match(doc.querySelector('.dsh-rss-counts').textContent, /共 4 条未读/)
})

/**
 * 进入正文页并返回 `<article>` 正文列 —— 本组用例的公共前置。
 *
 * 为什么单独提出来：R5 03 的每一条判据都要先走「列表 → 按 V → 等正文落地」这条路，
 * 而这条路的等待条件（view 变 article + settle）在四条用例里逐字重复过一次就够了。
 * 失败时抛出的是「在哪一步没等到」，不是某条断言的行号。
 */
async function openArticle(h) {
  await h.store.load('overview')
  await h.settle()
  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '进入正文页' })
  await h.settle()
  const body = h.win.document.querySelector('article.dsh-rss-article-column')
  assert.ok(body !== null, '正文列必须存在')
  return body
}

/**
 * —— 表格渲染（R5 04）——
 *
 * ⚠️ jsdom **没有布局能力**（`docs/pitfalls.md` §2.2），所以这里只断言**结构**：有没有
 * `overflowX: auto` 的容器、`<table>` 是不是它的子节点、字号单位是不是 `em`。
 * **不断言宽度或溢出** —— 那种断言在 jsdom 里要么恒真、要么与真实排版无关。
 * 窄栏真机验收（≈320px 下 5 列横向滚动）留给票据 06，未验之前标「未验」。
 */
test('正文表格：真正的 table 元素 + 横向滚动容器 + 表头加粗 + align 映射到 textAlign', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [
        { kind: 'p', text: '正文段落。' },
        {
          kind: 'table',
          header: ['参数', '值', '备注'],
          rows: [['电压', '220V', '正常'], ['电流', '10A', '']],
          align: ['left', 'right', undefined],
        },
      ],
    },
  })
  const body = await openArticle(h)

  const table = body.querySelector('table')
  assert.ok(table !== null, '表格必须渲染成真正的 <table>（不是段落流水）')

  // 横向滚动容器：表格的父节点，且 overflowX 是 auto（窄栏下横向滚动，不压成一堆换行）
  const scroller = table.parentElement
  assert.ok(scroller !== null, '表格必须有外层容器')
  assert.equal(scroller.style.overflowX, 'auto', '外层容器必须 overflowX: auto（窄栏横向滚动）')
  assert.equal(scroller.style.fontSize.endsWith('em'), true,
    '字号单位必须是 em（跟随正文字号），实际：' + scroller.style.fontSize)

  // 表头：thead > tr > th，且加粗
  const thead = table.querySelector('thead')
  assert.ok(thead !== null, '有 header 时必须渲染 <thead>')
  const ths = [...thead.querySelectorAll('th')]
  assert.deepEqual(ths.map((th) => th.textContent), ['参数', '值', '备注'], '表头文字要按列')
  for (const th of ths) assert.equal(th.style.fontWeight, '600', '表头必须加粗（fontWeight 600）')

  // 表体：tbody > tr > td，行列数对得上
  const rows = [...table.querySelectorAll('tbody tr')]
  assert.equal(rows.length, 2, '表体行数必须与 blocks.rows 一致')
  assert.deepEqual(rows.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)),
    [['电压', '220V', '正常'], ['电流', '10A', '']], '单元格文字与行列必须一一对应')

  // align 映射到 textAlign（按列；undefined 的列不设 textAlign）
  assert.deepEqual(rows.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.style.textAlign || '')),
    [['left', 'right', ''], ['left', 'right', '']], 'align 必须按列映射到 textAlign')
})

test('正文内联：链接渲染成 <a>，带 target=_blank 与 rel（含 noopener / noreferrer）', skip, async () => {
  // 夹具的 text 与 runs 严格一致（抽取层保证的那条不变量），这样「渲染的是 runs 而不是 text」
  // 不会因为内容不同而被误判成「两种都行」。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [{
        kind: 'p', text: '详见官方文档。',
        runs: [
          { kind: 'text', text: '详见' },
          { kind: 'link', text: '官方文档', href: 'https://example.com/docs' },
          { kind: 'text', text: '。' },
        ],
      }],
    },
  })
  const body = await openArticle(h)

  const anchors = [...body.querySelectorAll('p a')]
  assert.equal(anchors.length, 1, '链接必须渲染成恰好一个 <a>')
  const anchor = anchors[0]
  assert.equal(anchor.textContent, '官方文档', '链接文字就是 run 的文字')
  assert.equal(anchor.getAttribute('href'), 'https://example.com/docs', 'href 原样落到 DOM')
  assert.equal(anchor.getAttribute('target'), '_blank', '必须在新标签页打开（不丢掉正在读的这篇）')
  const rel = (anchor.getAttribute('rel') ?? '').split(/\s+/).filter((token) => token !== '')
  assert.ok(rel.includes('noopener'), 'rel 必须含 noopener（新标签页拿不到 window.opener）')
  assert.ok(rel.includes('noreferrer'), 'rel 必须含 noreferrer（不泄漏来源地址）')
  // 段落文本仍与 runs 拼接一致：元素渲染没有吞字、没有多加空格
  assert.equal(body.querySelector('p').textContent, '详见官方文档。',
    '段落可见文本必须逐字等于 runs 拼接结果')
})

test('正文内联：加粗 / 斜体 / 行内代码渲染成 strong / em / code，行内代码字号用 em', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [{
        kind: 'p', text: '不要在生产环境执行 npm install foo。',
        runs: [
          { kind: 'text', text: '不要' },
          { kind: 'strong', text: '在生产环境' },
          { kind: 'em', text: '执行' },
          { kind: 'code', text: 'npm install foo' },
          { kind: 'text', text: '。' },
        ],
      }],
    },
  })
  const body = await openArticle(h)
  const paragraph = body.querySelector('p')

  const strong = paragraph.querySelector('strong')
  assert.ok(strong !== null, '加粗 run 必须渲染成 <strong>')
  assert.equal(strong.textContent, '在生产环境')

  const em = paragraph.querySelector('em')
  assert.ok(em !== null, '斜体 run 必须渲染成 <em>')
  assert.equal(em.textContent, '执行')

  const code = paragraph.querySelector('code')
  assert.ok(code !== null, '行内代码 run 必须渲染成 <code>')
  assert.equal(code.textContent, 'npm install foo')
  // 字号必须是 em 而不是 px：正文字号可调，写死像素会让放大后的正文里代码反而更小。
  // 断言的是**样式属性**（jsdom 没有布局能力，见 pitfalls §2.2），不是渲染出来的像素尺寸。
  assert.match(code.style.fontSize, /em$/, '行内代码字号必须用 em 跟随正文字号，不许写 px')
  assert.equal(code.style.fontSize, '0.9em')
  assert.match(code.style.fontFamily, /monospace/, '行内代码必须用等宽字体，与散文分开')

  // 顺序也是判据：run 流是有序的，元素必须按原顺序出现在段落里
  assert.equal(paragraph.textContent, '不要在生产环境执行npm install foo。',
    '三种内联元素按 run 顺序拼回可见文本，不吞字、不重排')
})

test('正文内联：非法链接退化成纯文本，不产生 <a>（渲染期白名单）', skip, async () => {
  // 纵深防御（spec 决策 14）：抽取期已过 safeUrl，但历史脏数据可能带着 javascript: 落进缓存。
  // 判据是「DOM 里没有 <a>、文字仍在」——两者缺一都不算合格（吞掉文字同样是内容损失）。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [{
        kind: 'p', text: '别点这里，也别点那里。',
        runs: [
          { kind: 'text', text: '别点' },
          { kind: 'link', text: '这里', href: 'javascript:alert(1)' },
          { kind: 'text', text: '，也别点' },
          { kind: 'link', text: '那里', href: 'data:text/html,<script>alert(1)</script>' },
          { kind: 'text', text: '。' },
        ],
      }],
    },
  })
  const body = await openArticle(h)
  const paragraph = body.querySelector('p')

  assert.equal(body.querySelectorAll('a').length, 0, '非法协议不许产生任何 <a>（javascript: / data: 都算）')
  assert.equal(paragraph.textContent, '别点这里，也别点那里。', '退化成纯文本：文字一个都不能少')
})

test('正文内联：runs 缺席的块与今天逐字一致（纯文本段落 / 旧缓存 / 回退摘要）', skip, async () => {
  // 02 之后纯文本段落**本来就不产出 runs**，所以这是常态路径而不是兼容分支。
  // 判据同时覆盖三条来源：新缓存的纯文本块、老缓存的 paragraphs、以及回退摘要的 p 块。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      // 无 runs 的 p / h / quote / list：四种都必须走原路径
      blocks: [
        { kind: 'p', text: '纯文本段落，没有任何内联语义。' },
        { kind: 'h', text: '纯文本标题', level: 2 },
        { kind: 'quote', text: '纯文本引用' },
        { kind: 'list', ordered: false, items: ['条目一', '条目二'] },
      ],
    },
  })
  const body = await openArticle(h)

  assert.equal(body.querySelector('p').textContent, '纯文本段落，没有任何内联语义。')
  assert.equal(body.querySelector('p').querySelectorAll('strong, em, code, a').length, 0,
    '没有 runs 的段落不许凭空长出内联元素')
  // 标题块渲染成 div，但正文列里还有 header 的 meta div —— 按可见文本找，不按标签序号找
  const heading = [...body.querySelectorAll('div')].find((element) => element.textContent === '纯文本标题')
  assert.ok(heading !== undefined, '标题仍走 text（纯文本标题原样画出来）')
  assert.equal(heading.querySelectorAll('strong, em, code, a').length, 0, '没有 runs 的标题不许长出内联元素')
  assert.equal(body.querySelector('blockquote').textContent, '纯文本引用', '引用仍走 text')
  assert.deepEqual([...body.querySelectorAll('li')].map((element) => element.textContent),
    ['条目一', '条目二'], '列表仍走 items（没有 itemRuns 时逐字不变）')
})

test('正文内联：列表的 itemRuns 等长同序时按 run 渲染，长度对不上则整份退回纯文本', skip, async () => {
  // 判据来自 spec 决策 1 的不变量：itemRuns 要么缺席、要么与 items 等长同序。
  // 长度对不上时「能对上几条就渲染几条」会让同一列表里富文本与纯文本混排，读者无从分辨。
  const items = ['用 npm install 装', '再看官方文档']
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [
        {
          kind: 'list', ordered: true, items,
          itemRuns: [
            [
              { kind: 'text', text: '用 ' },
              { kind: 'code', text: 'npm install' },
              { kind: 'text', text: ' 装' },
            ],
            [
              { kind: 'text', text: '再看' },
              { kind: 'link', text: '官方文档', href: 'https://example.com/docs' },
            ],
          ],
        },
        // 长度对不上（2 条 items、1 组 itemRuns）：整份退回 items
        {
          kind: 'list', ordered: false, items: ['甲', '乙'],
          itemRuns: [[{ kind: 'strong', text: '甲' }]],
        },
      ],
    },
  })
  const body = await openArticle(h)
  const lists = [...body.querySelectorAll('ol, ul')]
  assert.equal(lists.length, 2, '两个列表块都要画出来')

  const [富文本列表, 退回列表] = lists
  assert.equal(富文本列表.querySelector('li code').textContent, 'npm install', '列表项的 code run 渲染成 <code>')
  assert.equal(富文本列表.querySelector('li a').getAttribute('href'), 'https://example.com/docs',
    '列表项的 link run 也过白名单并渲染成 <a>')
  assert.deepEqual([...富文本列表.querySelectorAll('li')].map((element) => element.textContent), items,
    '列表项可见文本仍逐字等于 items')

  assert.deepEqual([...退回列表.querySelectorAll('li')].map((element) => element.textContent), ['甲', '乙'],
    'itemRuns 长度对不上时整份退回 items（不许只渲染能对上的那几行）')
  assert.equal(退回列表.querySelectorAll('strong, em, code, a').length, 0,
    '退回之后不许残留任何内联元素')
})

test('正文内联：点击链接不冒泡到整行（列表行是 role=button，同一条规矩防回归）', skip, async () => {
  // 正文里的链接不在列表行内，但 spec 决策 15 要求把这条规矩写进验收 ——
  // 免得日后把富文本铺进列表摘要时，点链接顺手把文章标成已读。
  //
  // 判据挂在 **document** 上而不是正文列上：React 18 把合成事件的监听器挂在根容器（#root），
  // 所以锚点到 #root 之间的原生祖先**必然**先收到事件 —— 在那里挂计数器测的是 React 的委托机制，
  // 不是被测行为（改成那样这条用例永远红，与实现无关）。stopPropagation 在 #root 那一层执行，
  // 于是 document 成为「事件有没有逃出应用」的真实边界。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [{
        kind: 'p', text: '详见官方文档。',
        runs: [
          { kind: 'text', text: '详见' },
          { kind: 'link', text: '官方文档', href: 'https://example.com/docs' },
          { kind: 'text', text: '。' },
        ],
      }],
    },
  })
  const body = await openArticle(h)
  const anchor = body.querySelector('p a')
  assert.ok(anchor !== null, '前置条件：段落里有链接')

  let escaped = 0
  const onDocumentClick = () => { escaped += 1 }
  h.win.document.addEventListener('click', onDocumentClick)
  try {
    anchor.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
    await h.settle()
  } finally {
    h.win.document.removeEventListener('click', onDocumentClick)
  }
  assert.equal(escaped, 0, '链接点击必须 stopPropagation，不许冒泡出应用（列表行的 role=button 依赖这条规矩）')
})

/**
 * —— 图片折叠的渲染层（R6 03）——
 *
 * 判据全部落在 **DOM 上**（spec 验收 2 的「DOM 里没有 `<img>`」），不看 store 里的布尔值：
 * `display:none` 的图是否仍被下载属于浏览器实现细节，而「没有元素」就没有请求、也没有 Referer。
 *
 * 折叠提示的定位靠 `data-rss-image-fold`（值是组序号）：这是本文件唯一被允许依赖的标记属性，
 * 与 `data-rss-scroll` / `data-rss-row` 同一族 —— 标记写没写进 DOM 本身也是被测行为。
 */
const FOLD_ATTR = 'data-rss-image-fold'

/** 折叠提示元素（按组序号可选）。 */
function foldHints(root) {
  return [...root.querySelectorAll('[' + FOLD_ATTR + ']')]
}

/**
 * 以「默认折叠图片」为偏好的视图记忆 —— 模拟宿主读回来的那份。
 *
 * 刻意走 `viewMemory()` + 展开 `DEFAULT_READING_PREFERENCES`，而不是手写四个字段：
 * 手写会在 02 加字段时静默漏掉一项，读回来的归一化结果与测试意图悄悄分家。
 */
function foldedPrefs() {
  return {
    value: viewMemory({ reading: { ...DEFAULT_READING_PREFERENCES, expandImages: false } }),
    writes: [],
  }
}

/** 一张图块。`caption` / `alt` 传 undefined 表示字段缺席（抽取层不写空串）。 */
function imgBlock(src, { alt, caption } = {}) {
  return { kind: 'img', src, ...(alt === undefined ? {} : { alt }), ...(caption === undefined ? {} : { caption }) }
}

test('折叠偏好：单图带 caption ⇒ DOM 里没有 <img>，提示是「▸ 图片：<caption>」', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    prefs: foldedPrefs(),
    article: {
      itemId: 'a', title: 'ART',
      blocks: [
        { kind: 'p', text: '前一段。' },
        imgBlock('https://img.example/one.png', { alt: '替代文本', caption: '一张图的说明' }),
        { kind: 'p', text: '后一段。' },
      ],
    },
  })
  const body = await openArticle(h)

  assert.equal(body.querySelectorAll('img').length, 0,
    '折叠时 DOM 里不许有 <img> —— 不是 display:none、不是空 src（spec 决策 7）')
  const hints = foldHints(body)
  assert.equal(hints.length, 1, '一组图对应一条提示')
  // 文案优先 caption（读者看得到的图注），alt 是给读屏器与加载失败时用的
  assert.equal(hints[0].textContent, '▸ 图片：一张图的说明', '单图提示要带上 caption')
})

test('折叠偏好：单图既无 caption 也无 alt ⇒ 提示只有「▸ 图片」（不编造内容）', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    prefs: foldedPrefs(),
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/plain.png')],
    },
  })
  const body = await openArticle(h)

  assert.equal(body.querySelectorAll('img').length, 0, '折叠时不许渲染 <img>')
  const hints = foldHints(body)
  assert.equal(hints.length, 1, '单图自成一组（spec 决策 17）')
  assert.equal(hints[0].textContent, '▸ 图片', '两个来源都空时不许编造说明文字')
})

test('折叠偏好：连续三张图合成一组，提示是「▸ 图片 3 张」（不是三条单图提示）', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    prefs: foldedPrefs(),
    article: {
      itemId: 'a', title: 'ART',
      blocks: [
        { kind: 'p', text: '图集：' },
        imgBlock('https://img.example/1.png', { alt: '一' }),
        imgBlock('https://img.example/2.png', { alt: '二' }),
        imgBlock('https://img.example/3.png', { alt: '三' }),
      ],
    },
  })
  const body = await openArticle(h)

  assert.equal(body.querySelectorAll('img').length, 0, '折叠时一张都不渲染（组是原子的）')
  const hints = foldHints(body)
  assert.equal(hints.length, 1, '相邻三张图是一组，只该有一条提示')
  assert.equal(hints[0].textContent, '▸ 图片 3 张', '多图组按张数说话，不列各图说明')
})

test('默认偏好（展开）：<img> 直接渲染、src 与原块一致，DOM 里没有折叠提示', skip, async () => {
  // 这条是「默认值拍板为 true」的判据（spec 验收 1）：不传 prefs 就是宿主默认那份。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [
        { kind: 'p', text: '前一段。' },
        imgBlock('https://img.example/one.png', { alt: '替代文本', caption: '一张图的说明' }),
      ],
    },
  })
  const body = await openArticle(h)

  const images = [...body.querySelectorAll('img')]
  assert.equal(images.length, 1, '默认展开时图片直接渲染，不需要任何展开动作')
  assert.equal(images[0].getAttribute('src'), 'https://img.example/one.png', 'src 必须与原块一致')
  assert.equal(foldHints(body).length, 0, '展开态不许残留折叠提示')
})

/**
 * —— R6 01 / 防盗链回归：正文图片的 referrer 策略 ——
 *
 * 判据读 `getAttribute('referrerpolicy')`，**不读** `img.referrerPolicy`：
 * jsdom 里 `'referrerPolicy' in img === false`（`实测`，spec「补充说明」第 357 行），
 * 读属性恒 `undefined`，会让这条用例对任何实现都恒红；而 React 18 会把 `referrerPolicy`
 * 这个 prop 写成 DOM 的 `referrerpolicy` **属性**，那才是浏览器真正拿去发请求的东西。
 *
 * 这条**不设任何偏好**：默认态就是展开的。
 *
 * ⚠️ **2026-11-21 真机回归后改判据（病象 → 根因 → 修法）**
 *
 * 病象：装上 R6 后打开任何一篇带图文章，**所有图都显示「图片加载失败」**。
 * 根因（`实测`，浏览器 UA 逐域名 curl）：`referrerPolicy="no-referrer"` 把 Referer 变成空，
 * 而 `cdnfile.sspai.com`（本机缓存里 52.7% 的图）**空 Referer 一律 403**，非空才 200。
 * 三态对照：R6 前坏图 30.5% → R6 后 78.9% → `strict-origin-when-cross-origin` 30.5%。
 * 修法：改回 `strict-origin-when-cross-origin`（**正是浏览器默认值**）—— 跨源只发 origin、
 * 不发路径，sspai 恢复 200。
 *
 * 顺带纠正 spec 决策 29 的一个前提：本插件是 SPA（`grep pushState|location|URLSearchParams src/client/`
 * 零命中），**没有按文章区分的 URL**，所以 R6 之前外泄的 Referer 只是宿主 origin，
 * **不携带「正在读哪一篇」**。用「真实功能损坏」换这个并不存在的隐私收益是错的。
 *
 * 判据因此从「必须是 no-referrer」改成「必须是能通过图床的那个策略」，见下面两条用例。
 */
test('R6 01：正文图片的 referrer 策略是 strict-origin-when-cross-origin（防盗链回归）', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [
        { kind: 'p', text: '一张图。' },
        { kind: 'img', src: 'https://cdn.example.com/one.png', alt: '图一', caption: '说明一' },
        { kind: 'img', src: 'https://tracker.example.net/pixel.gif', alt: '' },
      ],
    },
  })
  const body = await openArticle(h)

  const images = [...body.querySelectorAll('img')]
  assert.equal(images.length, 2, '前置条件：两张图都要真的渲染出来（默认展开态）')
  for (const image of images) {
    assert.equal(
      image.getAttribute('referrerpolicy'),
      'strict-origin-when-cross-origin',
      '图片 ' + image.getAttribute('src') + ' 的 referrerpolicy 必须是 strict-origin-when-cross-origin —— ' +
      '写成 no-referrer 会让「空 Referer 就 403」的图床（如 cdnfile.sspai.com，实测占本机缓存 52.7%）全部加载失败',
    )
  }
  // 既有的两个图片属性不许被这条改动挤掉（同一处 props，最容易顺手改坏）
  assert.equal(images[0].getAttribute('loading'), 'lazy')
  assert.equal(images[0].getAttribute('decoding'), 'async')
})

/**
 * `Aa` 面板（正文排版偏好那一块）。
 *
 * ⚠️ 不能写 `querySelector('details.dsh-rss-settings')`：顶栏「更多」曾用同一个 class 且先出现在
 * 文档里 ⇒ 拿到的是「更多」面板（本用例第一版就踩过）。R11 05 删掉了「更多」，但按
 * 「哪个 details 里有字号选择」定位仍是语义定位（那一块就是排版面板），不依赖文档顺序。
 */
function aaPanel(h) {
  const size = h.win.document.querySelector('select[aria-label="正文字号"]')
  assert.ok(size !== null, '前置：正文页要有 Aa 面板（字号选择）')
  const panel = size.closest('details.dsh-rss-settings')
  assert.ok(panel !== null, '前置：字号选择必须在 Aa 面板里')
  return panel
}

test('Aa 面板的「默认折叠图片」开关：勾上当场折叠、取消当场回来，且落盘的是整份偏好', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/one.png', { alt: '替代文本' })],
    },
  })
  const body = await openArticle(h)
  assert.equal(body.querySelectorAll('img').length, 1, '前置：默认展开')

  // 开关与字号 / 栏宽 / 主题同处一个面板：同一块 <details> 里必须能找到它（spec 决策 3）
  const panel = aaPanel(h)
  const toggle = panel.querySelector('input[type="checkbox"][aria-label="默认折叠图片"]')
  assert.ok(toggle !== null, 'Aa 面板里必须有「默认折叠图片」开关')
  assert.equal(toggle.checked, false, '默认展开 ⇒ 开关未勾选（它表达的是「默认折叠」）')

  // 走真实交互：点复选框本身（不是直调 store.setReading），这样「面板 → onReading → store → 落盘」
  // 整条接线才真的被钉住 —— 任何一段漏接，图片不会变。
  toggle.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()

  assert.equal(h.store.get().reading.expandImages, false, '勾上开关 ⇒ 偏好变成折叠')
  assert.equal(body.querySelectorAll('img').length, 0, '折叠必须当场生效：DOM 里没有 <img>')
  assert.equal(foldHints(body).length, 1, '折叠后出现一条提示')

  const saved = h.requests.filter((entry) => entry.endpoint === 'saveViewPreferences').at(-1)
  assert.ok(saved !== undefined, '改偏好必须落盘（否则重开插件就白改了）')
  assert.deepEqual(saved.payload.preferences.reading,
    { fontSize: 16, lineWidth: 760, theme: 'auto', expandImages: false },
    '写盘的是整份 reading：只发 expandImages 的话另外三项会被宿主回落默认')

  // 取消勾选 ⇒ 图片立刻回来（spec 验收 2 的另一半）
  toggle.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()
  assert.equal(h.store.get().reading.expandImages, true, '取消勾选 ⇒ 偏好回到展开')
  assert.equal(body.querySelectorAll('img').length, 1, '取消勾选后图片立刻回来')
  assert.equal(foldHints(body).length, 0, '展开后提示必须消失')
})

test('折叠状态随字号 / 栏宽 / 主题切换而保持（排版调整不打断阅读）', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    prefs: foldedPrefs(),
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/one.png', { caption: '说明' })],
    },
  })
  const body = await openArticle(h)
  assert.equal(foldHints(body).length, 1, '前置：已折叠')

  const panel = aaPanel(h)
  const select = (label) => {
    const found = panel.querySelector('select[aria-label="' + label + '"]')
    assert.ok(found !== null, '前置：Aa 面板里有「' + label + '」')
    return found
  }
  // 三项逐一改：每次改完都断言「仍折叠、提示还在」——折叠态若挂在某个被重置的分支上，
  // 这里会当场红（spec 验收 22）。
  setControlValue(h.win, select('正文字号'), '20')
  await h.settle()
  assert.equal(body.style.fontSize, '20px', '前置：字号真的变了')
  assert.equal(body.querySelectorAll('img').length, 0, '改字号后仍然折叠')
  assert.equal(foldHints(body).length, 1, '改字号后提示还在')

  setControlValue(h.win, select('正文栏宽'), '1080')
  await h.settle()
  assert.equal(body.style.maxWidth, '1080px', '前置：栏宽真的变了')
  assert.equal(foldHints(body).length, 1, '改栏宽后提示还在')

  setControlValue(h.win, select('正文主题'), 'dark')
  await h.settle()
  assert.equal(h.box('article').getAttribute('data-rss-reading-theme'), 'dark', '前置：主题真的变了')
  assert.equal(body.querySelectorAll('img').length, 0, '改主题后仍然折叠')
  assert.equal(foldHints(body).length, 1, '改主题后提示还在')
})

test('改完字号 / 栏宽 / 主题后灯箱仍然可用：点图能开、Esc 能关（spec 验收 22 的后半句）', skip, async () => {
  // spec 验收 22 的字面要求是两件事：「折叠状态**与灯箱可用性**不受影响」。
  // 上一条只断了前半句（折叠态保持）—— 它证明偏好没被排版调整冲掉，却证明不了
  // 灯箱还活着。而「改完排版灯箱点不开」是个真实可达的失效形态：图片的三态（loading/ok）
  // 住在 `ArticleImage` 的组件 state 里，若排版调整让正文块**重新挂载**（块 key 里混进了
  // 排版偏好），三态就回到 loading，而灯箱只对 `state === 'ok'` 的图开放 ⇒ 点图没反应。
  // 上一条断的是「折叠态还在」，那种实现对它恒绿。
  //
  // 判据按灯箱的入口写：`[data-rss-image-state="ok"] img`（图要先手动派发 load 才变 ok，
  // jsdom 不加载资源 —— 见 `docs/pitfalls.md` §2.2）。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/one.png', { alt: '图一', caption: '说明' })],
    },
  })
  const body = await openArticle(h)
  assert.equal(body.querySelectorAll('img').length, 1, '前置：默认展开，图在正文里')

  // 先把图推进 ok 态（jsdom 不加载资源、不派发 load —— `docs/pitfalls.md` §2.2）。
  // **只派发这一次**：之后每改一项排版都断言它仍是 ok。若排版调整让正文块重新挂载，
  // 新的 `<img>` 没有收到过 load ⇒ 三态回到 loading，读者点图就没反应了（正是本条的判据）。
  const firstImage = body.querySelector('img')
  firstImage.dispatchEvent(new h.win.Event('load'))
  await h.settle()
  assert.equal(imageStates(body)[0].getAttribute(IMAGE_STATE_ATTR), 'ok', '前置：图已载入')

  const panel = aaPanel(h)
  const select = (label) => {
    const found = panel.querySelector('select[aria-label="' + label + '"]')
    assert.ok(found !== null, '前置：Aa 面板里有「' + label + '」')
    return found
  }
  // 三项逐一改（与上一条同样的顺序）：每次改完都要求灯箱**当场仍可用**。
  // 逐项而不是只在最后验一次：哪一项把灯箱弄坏了，失败消息要能点名是哪一项。
  for (const [label, value, expect] of [
    ['正文字号', '20', () => assert.equal(body.style.fontSize, '20px', '前置：字号真的变了')],
    ['正文栏宽', '1080', () => assert.equal(body.style.maxWidth, '1080px', '前置：栏宽真的变了')],
    ['正文主题', 'dark', () => assert.equal(h.box('article').getAttribute('data-rss-reading-theme'), 'dark', '前置：主题真的变了')],
  ]) {
    setControlValue(h.win, select(label), value)
    await h.settle()
    expect()

    // 入口：三态容器 + 里面的 <img>。图必须已经 ok —— jsdom 不加载资源，手动派发 load。
    const frame = body.querySelector('[' + IMAGE_STATE_ATTR + '="ok"]')
    assert.ok(frame !== null, '改完「' + label + '」后图片必须还在 ok 态（灯箱只对 ok 的图开放）——'
      + ' 若排版调整让正文块重新挂载，三态会回到 loading，读者点图就没反应了')
    const image = frame.querySelector('img')
    assert.ok(image !== null, '改完「' + label + '」后三态容器里必须还有 <img>')

    clickOn(h, image)
    await h.settle()
    assert.equal(hasLightbox(h.win.document), true, '改完「' + label + '」后点图必须仍能打开灯箱')

    assert.equal(h.press('Escape'), true, '改完「' + label + '」后 Esc 必须被接管（灯箱是它该关的东西）')
    await h.settle()
    assert.equal(hasLightbox(h.win.document), false, '改完「' + label + '」后 Esc 必须仍能关掉灯箱')
    assert.equal(h.store.get().view, 'article', 'Esc 只关灯箱，不许把文章也关了')
  }
})

test('点提示只展开那一组：组内 <img> 出现且 src 与原块一致，另一组仍折叠', skip, async () => {
  // 两组夹具（1 张 + 2 张，中间夹一段文字）：只有两组才能区分「点提示展开这一组」与
  // 「点提示展开整篇」—— 单组夹具对这两种实现恒绿（spec 验收 7）。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    prefs: foldedPrefs(),
    article: {
      itemId: 'a', title: 'ART',
      blocks: [
        { kind: 'p', text: '第一组之前。' },
        imgBlock('https://img.example/solo.png', { alt: '独图' }),
        { kind: 'p', text: '两组之间的段落。' },
        imgBlock('https://img.example/g2a.png', { alt: '二之一' }),
        imgBlock('https://img.example/g2b.png', { alt: '二之二' }),
      ],
    },
  })
  const body = await openArticle(h)
  const hints = foldHints(body)
  assert.equal(hints.length, 2, '前置：两段图各一组 ⇒ 两条提示')
  assert.deepEqual(hints.map((hint) => hint.textContent), ['▸ 图片：独图', '▸ 图片 2 张'],
    '前置：单组用单图文案、双图组用张数文案')

  hints[0].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()

  const images = [...body.querySelectorAll('img')]
  assert.equal(images.length, 1, '只展开第一组（1 张），第二组必须仍折叠')
  assert.equal(images[0].getAttribute('src'), 'https://img.example/solo.png', '展开的图 src 必须与原块一致')
  const remaining = foldHints(body)
  assert.equal(remaining.length, 1, '被点开那组的提示消失，另一组的提示还在')
  assert.equal(remaining[0].getAttribute(FOLD_ATTR), '1', '剩下的提示是第二组（序号 1）')
})

test('折叠 / 展开前后，段落与图片的相对顺序不变', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    prefs: foldedPrefs(),
    article: {
      itemId: 'a', title: 'ART',
      blocks: [
        { kind: 'p', text: '段一。' },
        imgBlock('https://img.example/1.png', { alt: '一' }),
        { kind: 'p', text: '段二。' },
        imgBlock('https://img.example/2.png', { alt: '二' }),
        imgBlock('https://img.example/3.png', { alt: '三' }),
        { kind: 'p', text: '段三。' },
      ],
    },
  })
  const body = await openArticle(h)
  /**
   * 正文列的「内容骨架」：段落文字与图片**组**按 DOM 顺序排开。
   *
   * 折叠态下 `<img>` 不存在，所以提示顶替图片的位置 —— 两者在骨架里都记成 'IMG'；
   * 连续的 'IMG' 再压成一项，因为一组图在折叠态是一条提示、展开态是 N 张图，
   * 它们占的是**同一个**位置（组是原子的，spec 决策 19）。不压的话这条判据会变成
   * 「张数不许变」，那是另一件事（验收 8 管的是分组边界）。
   */
  const skeleton = () => {
    const flat = [...body.querySelectorAll('p, img, [' + FOLD_ATTR + ']')]
      .map((node) => (node.tagName === 'P' ? node.textContent : 'IMG'))
    return flat.filter((entry, index) => entry !== 'IMG' || flat[index - 1] !== 'IMG')
  }

  const folded = skeleton()
  assert.deepEqual(folded, ['段一。', 'IMG', '段二。', 'IMG', '段三。'],
    '折叠态：两个图片组各占一个位置（第二组三张图只出一条提示）')

  // 全部展开（点两次提示）：骨架必须与折叠态逐项相同
  for (const hint of foldHints(body)) {
    hint.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
    await h.settle()
  }
  assert.equal(foldHints(body).length, 0, '前置：两组都点开了')
  assert.deepEqual(skeleton(), folded, '展开不许改变段落与图片的相对顺序（spec 验收 20）')
})

test('组级覆盖是会话级瞬时状态：换到下一篇时复位（不许凭空展开新文章的同一组）', skip, async () => {
  // 两篇都有图、且组序号都是 0：若复位漏了，新文章第 0 组会直接是展开态。
  const articleOf = (itemId) => ({
    itemId, title: 'ART ' + itemId,
    blocks: [imgBlock('https://img.example/' + itemId + '.png', { alt: itemId })],
  })
  const h = await mountReader({
    items: [item({ id: 'a' }), item({ id: 'b' })],
    prefs: foldedPrefs(),
    article: articleOf,
  })
  const body = await openArticle(h)
  const first = foldHints(body)
  assert.equal(first.length, 1, '前置：a 篇折叠着')
  first[0].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()
  assert.equal(body.querySelectorAll('img').length, 1, '前置：a 篇第 0 组已点开')

  h.press('j')
  await h.settle()
  assert.equal(h.store.get().article.itemId, 'b', '前置：切到 b 篇')
  assert.equal(body.querySelectorAll('img').length, 0, '换篇后新文章必须回到偏好决定的形态（折叠）')
  assert.equal(foldHints(body).length, 1, '新文章同样有一条提示')
})

test('折叠提示不抢空格：向提示元素本身派发 keydown，正文仍按一屏翻页且图片仍折叠', skip, async () => {
  // ⚠️ 这条**不能**用夹具的 press()：它派发到 document，而「提示是可聚焦控件 / 自带 onKeyDown」
  // 这个缺陷只在**事件目标就是提示**时可见（spec 验收 5 的实测记录）。派发到提示元素上，
  // 事件照样冒泡到 document 上的 routeKey —— 所以判据是「翻页有没有发生」，不是「有没有 preventDefault」：
  // routeKey 自己会 preventDefault，真正的问题在它前面的 `event.defaultPrevented` 守卫。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    prefs: foldedPrefs(),
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/one.png', { alt: '说明' }), { kind: 'p', text: '正文。' }],
    },
  })
  const body = await openArticle(h)
  const hint = foldHints(body)[0]
  assert.ok(hint !== undefined, '前置：已折叠')

  const box = h.arm(h.box('article'), { scrollHeight: 3000, clientHeight: 300 })
  const event = new h.win.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
  hint.dispatchEvent(event)
  await h.settle()

  assert.equal(h.scrollTop(box), 300, '空格必须照常翻一屏（提示不许吞掉它）')
  assert.equal(body.querySelectorAll('img').length, 0, '翻页不该顺手展开图片')

  // shift+空格（上半页）同样不能被提示吃掉
  h.userScroll(box, 300)
  const up = new h.win.KeyboardEvent('keydown', { key: ' ', shiftKey: true, bubbles: true, cancelable: true })
  hint.dispatchEvent(up)
  await h.settle()
  assert.equal(h.scrollTop(box), 0, 'shift+空格必须照常往上翻一屏')
})

test('折叠提示不在 Tab 序里：tabIndex < 0，且不是 BUTTON / SUMMARY / INPUT / SELECT / TEXTAREA、不是带 href 的链接', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    prefs: foldedPrefs(),
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/one.png', { alt: '说明' }), { kind: 'p', text: '正文。' }],
    },
  })
  const body = await openArticle(h)
  const hint = foldHints(body)[0]
  assert.ok(hint !== undefined, '前置：已折叠')

  /**
   * 判据是**两条一起**（spec 验收 6 的二次更正），缺一不可：
   *  ① 行为判据 `tabIndex < 0` —— 「Tab 键选不到它」的直接表达；
   *  ② 结构判据：`tagName` 不在可交互名单、也不是带 `href` 的 `A` —— 兜住
   *     `<button tabIndex={-1}>`（`tabIndex` 也是 -1，但可聚焦且自带空格激活语义）。
   *
   * ⚠️ **别写成** `matches(':any-link, button, summary, input, select, textarea, [tabindex]')`：
   * 那个选择器会把 `<span tabIndex={-1}>` 一并拒绝，而那个形态空格翻页正常、Tab 也选不到 ——
   * 判据过严同样会误杀正确实现（实测，见 spec 验收 6）。
   */
  const interactive = ['BUTTON', 'SUMMARY', 'INPUT', 'SELECT', 'TEXTAREA']
  assert.ok(!interactive.includes(hint.tagName), '提示不得用可交互元素（实际 ' + hint.tagName + '）')
  assert.ok(!(hint.tagName === 'A' && hint.hasAttribute('href')), '提示不得是链接')
  assert.ok(hint.tabIndex < 0, '提示不得进入 Tab 序（tabIndex=' + hint.tabIndex + '）')

  // 顺带钉住「Tab 序列里真的没有它」：正文列里所有可聚焦元素都不该是提示本身。
  // 用 tabIndex >= 0 当判据（与上面 ① 同一条性质），不是再列一遍标签名。
  const tabbable = [...body.querySelectorAll('*')].filter((node) => node.tabIndex >= 0)
  assert.equal(tabbable.some((node) => node.hasAttribute(FOLD_ATTR)), false,
    '提示本身不许出现在正文的可聚焦集合里')
})

test('回退态不受折叠影响：即使偏好是折叠，也没有图片提示（也没有灯箱入口）', skip, async () => {
  // 回退态的正文来自 `paragraphBlocks(fallbackParagraphs)`，不含 img 块 ⇒ 分组为空 ⇒ 提示不出现。
  // 这条用例的价值不在「现在是对的」，而在**把这条性质钉住**：日后若有人把分组挪到
  // readingBlocks 上、或让回退内容走另一条渲染路径，这里会红。
  // 夹具构造见「正文失败回退」族：failure + 摘要过 40 字门槛（hasBodyText）。
  const h = await mountReader({
    items: [item({
      id: 'a',
      summary: '<p>订阅源提供的摘要足够长，超过四十个字符的门槛，用于回退展示，再多补几个字凑够门槛。</p>',
    })],
    prefs: foldedPrefs(),
    article: { failure: '403' },
  })
  const body = await openArticle(h)

  assert.ok(h.win.document.querySelector('[role="note"]') !== null, '前置：确实进了回退态')
  assert.equal(foldHints(body).length, 0, '回退内容里没有图片块 ⇒ 不许出现折叠提示')
  assert.equal(body.querySelectorAll('img').length, 0, '回退内容本来就没有图片')
  // 灯箱是 07 的票；这里只断言「回退态没有灯箱入口」这个**当前**事实不因本票而变：
  // 正文里不存在任何 data-rss-lightbox 标记。
  assert.equal(body.querySelectorAll('[data-rss-lightbox]').length, 0, '回退态没有灯箱入口')
})

/**
 * —— `i` 键切换整篇图片（R6 04）——
 *
 * 判据全在 DOM 上（与 03 同一口径）：按一次 `i` 后**所有组的 `<img>` 都不在 DOM 里**
 * （不是 `display:none`），再按一次全部出现。
 *
 * 这里同时是「依赖数组没漏」的判据（spec 验收 19）：`imagesExpanded` 若没进 keydown effect
 * 的依赖数组，监听器闭包读到的是**注册那一刻**的值 ⇒ 第二次按 `i` 不生效（`expanded`
 * 那条 2026-10-15 实测事故的同族：拿掉依赖后按 `o` 永远收不起来，当时 402 条测试全绿）。
 */

/** 两组图片的正文夹具（1 张 + 2 张，中间夹一段文字）：单组夹具区分不了「整篇」与「这一组」。 */
function twoGroupArticle(itemId = 'a') {
  return {
    itemId, title: 'ART ' + itemId,
    blocks: [
      { kind: 'p', text: '第一组之前。' },
      imgBlock('https://img.example/solo.png', { alt: '独图' }),
      { kind: 'p', text: '两组之间的段落。' },
      imgBlock('https://img.example/g2a.png', { alt: '二之一' }),
      imgBlock('https://img.example/g2b.png', { alt: '二之二' }),
    ],
  }
}

test('i 键切换整篇图片：折叠偏好下按一次全部出现，再按一次全部消失（依赖数组没漏）', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    prefs: foldedPrefs(),
    article: twoGroupArticle(),
  })
  const body = await openArticle(h)
  assert.equal(body.querySelectorAll('img').length, 0, '前置：偏好是折叠')
  assert.equal(foldHints(body).length, 2, '前置：两组各一条提示')

  assert.equal(h.press('i'), true, '正文页的 i 必须被接管（与其他接管键同族，走 run() 的 preventDefault）')
  await h.settle()
  assert.equal(body.querySelectorAll('img').length, 3, '按一次 i ⇒ 两组共三张图全部出现（全篇统一）')
  assert.equal(foldHints(body).length, 0, '全篇展开后不许留下任何提示')

  // ⚠️ 第二次按 i 是「依赖数组没漏」的判据：监听器读到旧值时，它仍以为基线是折叠，
  // 于是再写一次「展开」—— 图片不会收起，这条当场红。
  assert.equal(h.press('i'), true, '第二次按 i 也必须被接管')
  await h.settle()
  assert.equal(body.querySelectorAll('img').length, 0, '再按一次 i ⇒ 全部消失（DOM 里没有，不是隐藏）')
  assert.equal(foldHints(body).length, 2, '折叠回来时两组提示都回来')
})

test('i 清空组覆盖：先点开某一组再按 i，全篇统一到同一形态（不是「部分展开取反」）', skip, async () => {
  // spec 决策 10 的核心：`i` 翻的是**基线**（篇级覆盖 ?? 偏好）并清空组覆盖，
  // 所以结果与「读者点过几组」无关。这里读者点开了第 0 组，基线仍是偏好（折叠）⇒
  // 按 i 应得到「全篇展开」，而不是「把已展开那组收起、其余保持折叠」这类局部结果。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    prefs: foldedPrefs(),
    article: twoGroupArticle(),
  })
  const body = await openArticle(h)
  foldHints(body)[0].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()
  assert.equal(body.querySelectorAll('img').length, 1, '前置：只点开了第 0 组（1 张）')

  h.press('i')
  await h.settle()
  assert.equal(body.querySelectorAll('img').length, 3, '按 i ⇒ 全篇统一到展开（组覆盖被清空）')
  assert.equal(foldHints(body).length, 0, '清空组覆盖后不该再有任何提示')

  // 再按一次：基线此时是篇级覆盖 true ⇒ 全篇折叠。若组覆盖没被清空，第 0 组会逆着 i 留着。
  h.press('i')
  await h.settle()
  assert.equal(body.querySelectorAll('img').length, 0, '再按 i ⇒ 全篇折叠，点开过的那组也必须收起')
})

test('i 的篇级覆盖是会话级：Esc 回列表后重开同一篇复位（复位 effect 的第二个依赖）', skip, async () => {
  // 这条守 spec 决策 15 的**第二个**依赖 `state.view`：`closeArticle` 只 `set({ view: 'list' })`、
  // 刻意保留 `article`（阅读进度落盘要用它），所以那一刻 `articleItemId` **不变** ——
  // 只依赖 `articleItemId` 时，重开同一篇会带着上次的篇级覆盖回来。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    prefs: foldedPrefs(),
    article: twoGroupArticle(),
  })
  const body = await openArticle(h)
  h.press('i')
  await h.settle()
  assert.equal(body.querySelectorAll('img').length, 3, '前置：按 i 展开了整篇')

  h.press('Escape')
  await h.settle()
  assert.equal(h.store.get().view, 'list', '前置：Esc 回列表')

  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '重新进入正文页' })
  await h.settle()
  const reopened = h.win.document.querySelector('article.dsh-rss-article-column')
  assert.ok(reopened !== null, '正文列必须存在')
  assert.equal(reopened.querySelectorAll('img').length, 0,
    '重开同一篇要回到偏好决定的形态（折叠）—— 篇级覆盖不跨阅读会话保留')
})

test('i 的篇级覆盖是会话级：j/k 换篇复位（复位 effect 的第一个依赖）', skip, async () => {
  // 第一个依赖 `articleItemId`：连续换篇时 `view` 一直是 'article'，只看 `view` 会漏。
  const h = await mountReader({
    items: [item({ id: 'a' }), item({ id: 'b' })],
    prefs: foldedPrefs(),
    article: (itemId) => twoGroupArticle(itemId),
  })
  const body = await openArticle(h)
  h.press('i')
  await h.settle()
  assert.equal(body.querySelectorAll('img').length, 3, '前置：a 篇按 i 展开')

  h.press('j')
  await h.settle()
  assert.equal(h.store.get().article.itemId, 'b', '前置：切到 b 篇')
  assert.equal(body.querySelectorAll('img').length, 0, '换篇后新文章回到偏好决定的形态（折叠）')
})

test('换篇后 i 作用于新那篇：复位之后新篇自己能被 i 展开（spec 验收 4 的后半句）', skip, async () => {
  // spec 验收 4 的字面要求是两件事：「切到另一篇后，`i` 作用于新那篇」。
  // 上一条只断了前半句（换篇复位 ⇒ 新篇折叠）—— 它证明复位发生了，却证明不了
  // **复位之后 `i` 还能作用在新篇上**。缺了后半句，一个「换篇时把篇级覆盖锁死/忽略按键」
  // 的实现照样全绿：新篇永远折叠，看起来完全正常。
  //
  // 这条同时钉住两件事，缺一不可：
  //  ① 换篇复位（新篇回到偏好决定的形态，不带 a 篇的展开态）；
  //  ② 复位之后在新篇按 `i` ⇒ 新篇展开（篇级覆盖对新篇真的可写、且写在 b 篇上）。
  const h = await mountReader({
    items: [item({ id: 'a' }), item({ id: 'b' })],
    prefs: foldedPrefs(),
    article: (itemId) => twoGroupArticle(itemId),
  })
  const body = await openArticle(h)

  assert.equal(h.press('i'), true, '前置：a 篇按 i 被接管')
  await h.settle()
  assert.equal(body.querySelectorAll('img').length, 3, '前置：a 篇被 i 展开（两组共三张）')

  assert.equal(h.press('j'), true, '前置：j 换到 b 篇')
  await h.settle()
  assert.equal(h.store.get().article.itemId, 'b', '前置：确实换到了 b 篇')
  // ① 复位：a 篇的展开态不许跟过来
  assert.equal(body.querySelectorAll('img').length, 0, '换篇后 b 篇回到偏好决定的形态（折叠）—— a 篇的覆盖不跨篇')
  assert.equal(foldHints(body).length, 2, '复位后 b 篇两组提示都在')

  // ② 作用于新那篇：复位不是「锁死」，`i` 在 b 篇照样能翻基线
  assert.equal(h.press('i'), true, 'b 篇按 i 同样必须被接管')
  await h.settle()
  assert.equal(h.store.get().article.itemId, 'b', '按 i 不许把文章换掉（它只动图片）')
  assert.equal(body.querySelectorAll('img').length, 3, '在新篇按 i ⇒ 新篇展开（i 作用于当前这一篇）')
  assert.equal(foldHints(body).length, 0, '展开后 b 篇不该留下提示')

  // 再按一次：仍然是 b 篇自己的基线在翻（回到折叠），不是把 a 篇的旧覆盖捞回来
  assert.equal(h.press('i'), true, '第三次按 i 也必须被接管')
  await h.settle()
  assert.equal(body.querySelectorAll('img').length, 0, '再按 i ⇒ b 篇折叠（翻的是 b 篇自己的基线）')
  assert.equal(foldHints(body).length, 2, '折叠回来时 b 篇两组提示都回来')
})

test('i 在列表页不改变任何状态（图片开关只在正文页生效）', skip, async () => {
  // 守卫住在 routeKey 的 view 判断里（spec 验收 17）。列表页按 i 之后进正文，
  // 图片仍应是偏好决定的形态 —— 若列表页那次按键写了篇级覆盖，这里会红。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    prefs: foldedPrefs(),
    article: twoGroupArticle(),
  })
  await h.store.load('overview')
  await h.settle()
  assert.equal(h.store.get().view, 'list', '前置：在列表页')
  h.press('i')
  await h.settle()
  assert.equal(h.store.get().view, 'list', '列表页按 i 不该切视图')
  assert.deepEqual(h.prefs.writes, [], '列表页按 i 不该写任何偏好')

  const body = await openArticle(h)
  assert.equal(body.querySelectorAll('img').length, 0, '列表页那次 i 不许留下篇级覆盖')
})

/**
 * —— 组级覆盖（R6 05；spec 决策 5 / 9 / 15、验收 7 / 21）——
 *
 * 03 已经让「点提示只展开那一组」成立（`expandImageGroup` 只 add 那一组、`foldOf` 组覆盖优先），
 * 那条判据也已落在上面的「点提示只展开那一组」里（spec 验收 7 的「第二组仍折叠」）。
 * 本段补的是**同一层语义的另外两半**：
 *  ① 组覆盖必须压过**篇级**覆盖（上面那条只验到「压过偏好」，而两者在 `foldOf` 里是两行不同的代码）；
 *  ② 组覆盖不落盘 —— `state.view` 那条复位依赖（`j`/`k` 换篇已被「组级覆盖是会话级瞬时状态」
 *     那条覆盖，但「Esc 回列表后重开**同一篇**」走的是另一个依赖，那条路径此前只对篇级覆盖有判据）。
 */

test('组覆盖优先于篇级覆盖：按 i 把整篇写成折叠后，点过的那一组仍然展开', skip, async () => {
  // spec 决策 5 的「组级优先于篇级」：读者明确点过的那一组，不该被一个全局开关盖掉。
  // ⚠️ 夹具必须让**篇级覆盖**（而不是偏好）等于折叠：默认偏好是展开，按一次 `i` 把篇级写成
  // `false` —— 若组覆盖不压过篇级，点提示后那张图仍然不出现（提示也不会消失），这条当场红。
  // 与上面那条「点提示只展开那一组」的区别：那条的折叠来自**偏好**，这条来自**篇级覆盖**；
  // 两种来源在 `foldOf` 里是两行不同的代码，一条用例守不住另一条。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: twoGroupArticle(),
  })
  const body = await openArticle(h)
  assert.equal(body.querySelectorAll('img').length, 3, '前置：默认偏好是展开，三张图都在')
  assert.equal(foldHints(body).length, 0, '前置：展开态没有提示')

  assert.equal(h.press('i'), true, '正文页的 i 必须被接管')
  await h.settle()
  assert.equal(body.querySelectorAll('img').length, 0, '前置：按 i 把篇级覆盖写成折叠')
  const hints = foldHints(body)
  assert.equal(hints.length, 2, '前置：两组各一条提示')

  hints[0].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()

  const images = [...body.querySelectorAll('img')]
  assert.equal(images.length, 1, '组覆盖必须压过篇级覆盖：只有点过的那一组展开')
  assert.equal(images[0].getAttribute('src'), 'https://img.example/solo.png', '展开的图 src 必须与原块一致')
  const remaining = foldHints(body)
  assert.equal(remaining.length, 1, '另一组的提示必须还在')
  assert.equal(remaining[0].getAttribute(FOLD_ATTR), '1', '剩下的是第二组（序号 1）')
})

test('组覆盖不落盘：Esc 回列表后重开同一篇，回到偏好决定的初始形态', skip, async () => {
  // spec 验收 21 的**第二条**依赖（决策 15 的 `state.view`）：`closeArticle` 只 `set({ view: 'list' })`、
  // 刻意保留 `article`（阅读进度落盘要用它），所以那一刻 `articleItemId` **不变** ——
  // 只依赖 `articleItemId` 时，组覆盖会跨阅读会话留下来，重开同一篇会带着上次点开的组回来。
  //
  // 与「组级覆盖是会话级瞬时状态：换到下一篇时复位」那条**不重叠**：那条走 `j`/`k`（`articleItemId`
  // 变了、`view` 一直是 `'article'`），这条走 Esc → 重开（`view` 变了、`articleItemId` 没变）。
  // 两个依赖各有一条判据，缺哪一条都会让对应路径静默失效。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    prefs: foldedPrefs(),
    article: twoGroupArticle(),
  })
  const body = await openArticle(h)
  foldHints(body)[0].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()
  assert.equal(body.querySelectorAll('img').length, 1, '前置：a 篇第 0 组已点开')

  h.press('Escape')
  await h.settle()
  assert.equal(h.store.get().view, 'list', '前置：Esc 回列表')

  h.press('V', true)
  await h.waitFor(() => h.store.get().view === 'article', { timeout: 900, label: '重新进入正文页' })
  await h.settle()
  const reopened = h.win.document.querySelector('article.dsh-rss-article-column')
  assert.ok(reopened !== null, '正文列必须存在')
  assert.equal(reopened.querySelectorAll('img').length, 0,
    '重开同一篇要回到偏好决定的形态（折叠）—— 组覆盖不跨阅读会话保留')
  assert.equal(foldHints(reopened).length, 2, '两组提示都回来')
})

/**
 * —— 图片三态与占位（R6 06）——
 *
 * 判据读 `[data-rss-image-state]` 这个标记属性（值是 `loading` / `ok` / `failed`）：
 * 「载入中」与「已载入」在 jsdom 里**没有任何别的可观测差别**（没有布局引擎、图片不真的加载，
 * 见 `docs/pitfalls.md` §2.2），不标出来就无法表达 spec 验收 9 的前半条。
 * 这个标记同时是 07 灯箱的入口判据（只给 `ok` 的图挂点击），所以它不只是测试脚手架。
 *
 * ⚠️ jsdom 里 `<img>` **不加载资源、不派发 `load` / `error`、不经过 `Image` 构造器**（`实测`，
 * `/tmp/r6-notes/ENV.md`），所以三态用例一律**手动派发事件**；「挂载前已 complete」那条
 * 用 `Object.defineProperty` 桩在 **`HTMLImageElement.prototype`** 上（一创建就带桩值）。
 */
const IMAGE_STATE_ATTR = 'data-rss-image-state'

/** 正文里所有带三态标记的图片容器（按 DOM 顺序）。 */
function imageStates(root) {
  return [...root.querySelectorAll('[' + IMAGE_STATE_ATTR + ']')]
}

test('R6 06：图片三态——挂载后初始是「载入中」，onLoad 之后变成 ok', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/one.png', { alt: '替代文本', caption: '说明' })],
    },
  })
  const body = await openArticle(h)

  const frames = imageStates(body)
  assert.equal(frames.length, 1, '前置：一张图 ⇒ 一个三态容器')
  assert.equal(frames[0].getAttribute(IMAGE_STATE_ATTR), 'loading',
    '图片刚上屏时必须是「载入中」——读者要知道它在加载，而不是「本来就没图」')

  const image = body.querySelector('img')
  assert.ok(image !== null, '前置：载入中的图仍在 DOM 里（占位靠它自己的盒子）')
  image.dispatchEvent(new h.win.Event('load'))
  await h.settle()

  assert.equal(imageStates(body)[0].getAttribute(IMAGE_STATE_ATTR), 'ok', 'onLoad 之后进 ok')
  assert.equal(body.querySelectorAll('img').length, 1, 'ok 态的图照旧在 DOM 里')
})

test('R6 06：onError 之后是失败态——文案「图片加载失败」+ alt，且 DOM 里没有 <img>（不留破图）', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/broken.png', { alt: '图床挂了的那张图', caption: '图注' })],
    },
  })
  const body = await openArticle(h)

  const image = body.querySelector('img')
  assert.ok(image !== null, '前置：初始是载入中，图在 DOM 里')
  image.dispatchEvent(new h.win.Event('error'))
  await h.settle()

  const frames = imageStates(body)
  assert.equal(frames.length, 1, '前置：三态容器仍在（占位不塌）')
  assert.equal(frames[0].getAttribute(IMAGE_STATE_ATTR), 'failed', 'onError 之后必须进失败态')
  // 失败态的核心：文案 + alt，**不显示破图图标** —— 后者靠「DOM 里没有 <img>」表达
  const text = frames[0].textContent ?? ''
  assert.ok(text.includes('图片加载失败'), '失败态必须明说「图片加载失败」（实际：' + text + '）')
  assert.ok(text.includes('图床挂了的那张图'), '有 alt 时一并显示 alt（它是这张图唯一的可读内容）')
  assert.equal(body.querySelectorAll('img').length, 0,
    '失败态必须把 <img> 从 DOM 里移除 —— 留着它浏览器就画破图图标（spec 决策 23）')
})

test('R6 06：失败态没有 alt 时只说「图片加载失败」，不编造说明文字', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/no-alt.png')],
    },
  })
  const body = await openArticle(h)

  body.querySelector('img').dispatchEvent(new h.win.Event('error'))
  await h.settle()

  const frames = imageStates(body)
  assert.equal(frames[0].getAttribute(IMAGE_STATE_ATTR), 'failed', '前置：已进失败态')
  assert.equal((frames[0].textContent ?? '').trim(), '图片加载失败', '两个来源都空时不许编造说明文字')
})

/**
 * 桩「挂载前就已 complete」的图。
 *
 * ⚠️ 桩必须装在 **`HTMLImageElement.prototype`** 上，不能装在某个实例上：React 创建 `<img>` 与
 * 把它挂进 DOM 是两次独立的提交，测试**拿不到**「节点已创建、effect 还没跑」那个中间时刻，
 * 所以只能在元素一出生就带桩值（这是 `/tmp/r6-notes/ENV.md` 记的实测结论）。
 * `arm()` 改实例、`ResizeObserver` 改全局，都是同一族手法（`tests/scroll-dom.test.mjs` 先例）。
 *
 * 返回的 `restore()` 必须在用例末尾调：原型是**跨用例共享**的（同一个 JSDOM 实例内），
 * 留着会让后续用例的图片凭空变成「已载入」。
 */
function stubImageMetrics(win, { complete, naturalWidth }) {
  const proto = win.HTMLImageElement.prototype
  const saved = {
    complete: Object.getOwnPropertyDescriptor(proto, 'complete'),
    naturalWidth: Object.getOwnPropertyDescriptor(proto, 'naturalWidth'),
  }
  Object.defineProperty(proto, 'complete', { get: () => complete, configurable: true })
  Object.defineProperty(proto, 'naturalWidth', { get: () => naturalWidth, configurable: true })
  return () => {
    // 还原成 jsdom 自己的访问器（不是删掉：删掉会让属性彻底消失，`img.complete` 变 undefined）
    if (saved.complete !== undefined) Object.defineProperty(proto, 'complete', saved.complete)
    if (saved.naturalWidth !== undefined) Object.defineProperty(proto, 'naturalWidth', saved.naturalWidth)
  }
}

test('R6 06：缓存命中的图在挂载前就已 complete（naturalWidth > 0）⇒ 直接是 ok，不停在「载入中」', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/cached.png', { alt: '缓存里的图' })],
    },
  })
  // 在正文渲染**之前**装桩：图片一出生就 complete 且 naturalWidth > 0，模拟浏览器缓存命中
  // （那时 `load` 事件早已派发完毕，React 的 onLoad 永远收不到 —— spec 决策 22）。
  const restore = stubImageMetrics(h.win, { complete: true, naturalWidth: 640 })
  try {
    const body = await openArticle(h)
    await h.settle()

    const frames = imageStates(body)
    assert.equal(frames.length, 1, '前置：一张图')
    assert.equal(frames[0].getAttribute(IMAGE_STATE_ATTR), 'ok',
      '挂载前已 complete 且 naturalWidth > 0 ⇒ 必须补判成 ok；只靠 onLoad 的实现在这里恒停在「载入中」')
    assert.equal(body.querySelectorAll('img').length, 1, 'ok 态的图照旧在 DOM 里')
  } finally { restore() }
})

test('R6 06：挂载前已 complete 但 naturalWidth === 0（加载失败后放弃）⇒ 补判成 failed', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/dead.png', { alt: '早已放弃的图' })],
    },
  })
  const restore = stubImageMetrics(h.win, { complete: true, naturalWidth: 0 })
  try {
    const body = await openArticle(h)
    await h.settle()

    const frames = imageStates(body)
    assert.equal(frames[0].getAttribute(IMAGE_STATE_ATTR), 'failed',
      'complete 但 naturalWidth 为 0 ⇒ 图其实没解码成功，必须进失败态而不是 ok')
    assert.ok((frames[0].textContent ?? '').includes('图片加载失败'), '失败态文案要在')
    assert.equal(body.querySelectorAll('img').length, 0, '失败态不留 <img>（不画破图）')
  } finally { restore() }
})

test('R6 06：换篇后三态复位——A 篇图 0 是 ok，切到 B 篇图 0 必须重新从「载入中」开始', skip, async () => {
  /*
   * 两篇块数**相同**：spec 决策 21 担心的形态是「裸 index 当 key ⇒ React 复用同一个
   * <ArticleImage> 实例 ⇒ 沿用 a 的 ok 态」。**这条用例钉的是行为（换篇必须复位），
   * 不是那个实现差异** —— 实测（2026-11-21，票据 06）：把 key 改回裸 `index`，本用例照样绿。
   *
   * 原因在 `loadArticle` 的时序（源码核对 `src/client/list-actions.ts:710`）：换篇先
   * `set({ article: { loading: true } })`，那一刻 `blocks` 为空 ⇒ 夹具必然先提交一次
   * **零图片**的渲染，图片组件本来就被卸载过一次，复合 key 与裸下标因此在今天无法区分。
   * 探针观察到的换篇序列是 `{imgs:0} → {imgs:1, loading}`。
   *
   * 复合 key 仍然是正确形态（它不依赖「中间恰好没有图」这个偶然事实），所以实现保留；
   * 但这句测试的诚实定位是「验收 9 的复位要求」，不是「决策 21 的判据」。
   * 这条缺口记在 `docs/pitfalls.md` §3.6。
   */
  const articleOf = (itemId) => ({
    itemId, title: 'ART ' + itemId,
    blocks: [imgBlock('https://img.example/' + itemId + '.png', { alt: itemId })],
  })
  const h = await mountReader({
    items: [item({ id: 'a' }), item({ id: 'b' })],
    article: articleOf,
  })
  const body = await openArticle(h)

  const first = body.querySelector('img')
  assert.ok(first !== null, '前置：a 篇的图已渲染')
  assert.equal(first.getAttribute('src'), 'https://img.example/a.png', '前置：a 篇的图')
  first.dispatchEvent(new h.win.Event('load'))
  await h.settle()
  assert.equal(imageStates(body)[0].getAttribute(IMAGE_STATE_ATTR), 'ok', '前置：a 篇的图 0 已是 ok')

  h.press('j')
  await h.settle()
  assert.equal(h.store.get().article.itemId, 'b', '前置：切到 b 篇')

  const frames = imageStates(body)
  assert.equal(frames.length, 1, '前置：b 篇也是一张图（块数与 a 相同）')
  assert.equal(frames[0].getAttribute(IMAGE_STATE_ATTR), 'loading',
    '换篇后三态必须复位 —— 裸 index 当 key 会让 React 复用实例、沿用上一篇的 ok 态')
  const second = body.querySelector('img')
  assert.ok(second !== null, '复位后的图仍在 DOM 里')
  assert.equal(second.getAttribute('src'), 'https://img.example/b.png', '前置：确实是 b 篇的图')
})

/**
 * 占位（spec 决策 20）：容器 `min-height: 120px` + 图片 `width: 100%; height: auto`。
 *
 * ⚠️ 这里**只断言样式声明**，不断言位移量：jsdom 没有布局引擎（`docs/pitfalls.md` §2.2），
 * 「加载完成时版面跳不跳」只能在真机上量 —— 那是验收 24，本票标「未验」。
 * 断言 `aspect-ratio` **不出现**同样是声明层面的判据：抽取层只回传 `src`/`alt`/`caption`，
 * 没有比例可填，写了就是空转（决策 20 明确否掉）。
 */
test('R6 06：占位——图片容器 min-height 120px、图片 width 100% / height auto，且不用 aspect-ratio', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/one.png', { alt: '一' })],
    },
  })
  const body = await openArticle(h)

  const image = body.querySelector('img')
  assert.ok(image !== null, '前置：图已渲染')
  // 容器：图与 figcaption 之间那层（min-height 加在容器上，不是 <img> 上 —— 加在图上会把图拉高）
  const container = image.parentElement
  assert.ok(container !== null, '前置：图片必须包在一层容器里（min-height 要有地方放）')
  assert.equal(container.style.minHeight, '120px', '图片容器必须给 min-height: 120px（占位，决策 20）')
  assert.equal(image.style.width, '100%', '图片必须 width: 100%')
  assert.equal(image.style.height, 'auto', '图片必须 height: auto（否则 min-height 会把图拉变形）')
  // 决策 20 明确否掉 aspect-ratio：抽取层没有比例可填，写了也是空转
  assert.equal(image.style.aspectRatio, '', '不许用 aspect-ratio（抽取层不提供宽高）')
  assert.equal(container.style.aspectRatio, '', '容器同样不许用 aspect-ratio')
  // 既有的限高不受影响（长截图限高是独立决定，spec 决策 33）
  assert.equal(image.style.maxHeight, '640px', 'maxHeight 640 不许被本票挤掉')
})

/**
 * —— 灯箱（R6 07）——
 *
 * 判据全部落在 **DOM 上**：灯箱节点的存在 / 消失、`href` 与 `src` 是否同一个值、`scrollTop`
 * 有没有变、`view` 还是不是 `article`。不看 store 里的布尔值，也不看组件树形状。
 *
 * 灯箱节点的定位靠 `data-rss-lightbox`（spec 未规定名字，本票定为这个）—— 与
 * `data-rss-scroll` / `data-rss-image-state` 同一族：标记写没写进 DOM 本身也是被测行为。
 *
 * ⚠️ jsdom **不加载图片、不派发 `load`**（`实测`，`/tmp/r6-notes/ENV.md`），而灯箱只对
 * `state === 'ok'` 的图开放，所以每条用例都要先手动派发一次 `load` 把图推进 ok 态。
 * 这一步不是走形式：它就是「灯箱入口判据」的一半（另一半是「载入中的图点不开」）。
 */
const LIGHTBOX_ATTR = 'data-rss-lightbox'

/**
 * 灯箱覆盖层节点（没有则 null）。
 *
 * ⚠️ 这个返回值只许拿来做**分支与读取**，不许直接当 `assert.equal` 的实参（`docs/pitfalls.md` §2.8）：
 * 断言失败时 node 会 inspect 那个 jsdom 元素，而 inspect 一个巨大、循环引用、getter 成堆的节点
 * 会一路跑到超时被 SIGKILL —— 表现是「文件级翻红、零断言消息」，门槛里看不出是哪条守卫在喊。
 * 所以判「有没有」一律走下面的 `hasLightbox()`（布尔），`lightboxOf()` 只在断言**通过**之后取节点。
 */
function lightboxOf(root) {
  return root.querySelector('[' + LIGHTBOX_ATTR + ']')
}

/** 灯箱是否在 DOM 里 —— 布尔形态，专供 `assert.equal`（理由见 lightboxOf 的注释）。 */
function hasLightbox(root) {
  return root.querySelector('[' + LIGHTBOX_ATTR + ']') !== null
}

/** 帮助浮窗是否在 DOM 里 —— 同样是布尔形态（既有用例直接传节点，本组不复制那个写法）。 */
function hasHelp(root) {
  return root.querySelector('[data-rss-help]') !== null
}

/** 点一个元素（真 MouseEvent，冒泡 + 可取消 —— 与既有行点击 / 提示点击同一手法）。 */
function clickOn(h, element) {
  element.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true, cancelable: true }))
}

/**
 * 把正文里第一张图推进 ok 态并点开灯箱，返回灯箱节点。
 *
 * 抽成公共前置的理由与 `openArticle` 相同：「load → settle → click → settle」这四步在
 * 七八条用例里逐字重复过一次就够了；失败时抛出的是「在哪一步没等到」，不是某条断言的行号。
 */
async function openLightbox(h, body) {
  const image = body.querySelector('img')
  assert.ok(image !== null, '前置：正文里要有一张图（默认展开态）')
  image.dispatchEvent(new h.win.Event('load'))
  await h.settle()
  assert.equal(imageStates(body)[0].getAttribute(IMAGE_STATE_ATTR), 'ok', '前置：图已载入（灯箱只对 ok 的图开放）')

  clickOn(h, image)
  await h.settle()
  assert.equal(hasLightbox(h.win.document), true, '点已加载的图必须打开灯箱')
  const lightbox = lightboxOf(h.win.document)
  assert.ok(lightbox !== null, '前置：灯箱节点取得到')
  return lightbox
}

test('R6 07：点已加载的图打开灯箱——原尺寸图 + 「原图 ↗」新标签链接，href 等于该图 src', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/one.png', { alt: '图一', caption: '说明一' })],
    },
  })
  const body = await openArticle(h)
  const lightbox = await openLightbox(h, body)

  const zoomed = lightbox.querySelector('img')
  assert.ok(zoomed !== null, '灯箱里必须渲染一张图 —— 它就是「看大图」这件事本身')
  assert.equal(zoomed.getAttribute('src'), 'https://img.example/one.png',
    '灯箱图必须指向读者点的那张图（不是另取一张、不是缩略图地址）')
  // 原尺寸：限宽 + 限高都写死在覆盖层里（spec 决策 24）。jsdom 没有布局引擎，只能断声明。
  assert.equal(zoomed.style.maxWidth, '100%', '灯箱图必须 maxWidth: 100%（不许横向溢出正文面）')
  assert.equal(zoomed.style.maxHeight, '100vh', '灯箱图必须 maxHeight: 100vh（长截图不许撑出屏幕）')
  // 隐私：与正文 <img> 同一条（spec 决策 29）—— 灯箱是第二处会外泄阅读行为的图片请求。
  // 与正文图同一条策略（2026-11-21 防盗链回归）：no-referrer 会让空 Referer 就 403 的图床挂掉，
  // 而 strict-origin-when-cross-origin 是浏览器默认值、跨源只发 origin。灯箱图与正文图必须一致 ——
  // 两处若各写一个，读者会看到「正文能显示、点开却失败」这种自相矛盾的形态。
  assert.equal(zoomed.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin',
    '灯箱图的 referrerpolicy 必须与正文图一致（strict-origin-when-cross-origin）')

  const raw = lightbox.querySelector('a')
  assert.ok(raw !== null, '灯箱里必须有「原图 ↗」链接')
  assert.equal(raw.getAttribute('href'), 'https://img.example/one.png',
    '「原图 ↗」的 href 必须等于该图 src（读者要的是原始尺寸，不是重新拼的地址）')
  assert.equal(raw.getAttribute('target'), '_blank', '「原图 ↗」必须在新标签打开（不把读者带离阅读器）')
  assert.equal(raw.getAttribute('rel'), 'noreferrer', '新标签链接必须 rel="noreferrer"（spec 决策 24）')
  assert.ok((raw.textContent ?? '').includes('原图'), '链接文案要说明它做什么（实际：' + (raw.textContent ?? '') + '）')
})

test('R6 07：载入中的图点不开——灯箱只对 state === "ok" 的图开放', skip, async () => {
  // 为什么必须单独一条：把 onClick 无条件挂在每张图上，读者会在「还在加载」的占位块上点出一个
  // 空灯箱（或一张永远不出图的灯箱）。判据是「点了之后没有灯箱节点」，不是「图有没有 onClick」。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/slow.png', { alt: '还在加载' })],
    },
  })
  const body = await openArticle(h)

  const image = body.querySelector('img')
  assert.ok(image !== null, '前置：载入中的图在 DOM 里')
  assert.equal(imageStates(body)[0].getAttribute(IMAGE_STATE_ATTR), 'loading', '前置：此刻是载入中')

  clickOn(h, image)
  await h.settle()
  assert.equal(hasLightbox(h.win.document), false, '载入中的图点开不许有灯箱（否则读者点出一张永远不出图的空覆盖层）')
})

test('R6 07：Esc 关灯箱但**不退出正文**（view 仍为 article）', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: { itemId: 'a', title: 'ART', blocks: [imgBlock('https://img.example/one.png', { alt: '图一' })] },
  })
  const body = await openArticle(h)
  await openLightbox(h, body)

  assert.equal(h.press('Escape'), true, 'Esc 应当被接管（不是漏给宿主）')
  await h.settle()
  assert.equal(hasLightbox(h.win.document), false, 'Esc 必须关掉灯箱')
  assert.equal(h.store.get().view, 'article', 'Esc 只关灯箱 —— 不许顺手把文章也关了（读者只是想收掉那张大图）')

  // 第二次 Esc 才回到原来的语义（正文 → 列表）：优先级链是逐级下降的，不是一次性清空
  assert.equal(h.press('Escape'), true, '灯箱关掉后 Esc 仍应被接管')
  await h.settle()
  assert.equal(h.store.get().view, 'list', '灯箱已关，第二次 Esc 回到原语义（正文 → 列表）')
})

test('R6 07：点背景关闭灯箱，点图本身不关闭', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: { itemId: 'a', title: 'ART', blocks: [imgBlock('https://img.example/one.png', { alt: '图一' })] },
  })
  const body = await openArticle(h)
  let lightbox = await openLightbox(h, body)

  // ① 点图本身：读者常常点一下大图想「再放大」或只是误触 —— 那不该把灯箱收掉
  const zoomed = lightbox.querySelector('img')
  assert.ok(zoomed !== null, '前置：灯箱里有图')
  clickOn(h, zoomed)
  await h.settle()
  assert.equal(hasLightbox(h.win.document), true, '点灯箱里的图不许关闭灯箱（只有背景与 Esc 是关闭出口）')

  // ② 点背景（覆盖层自身）：这才是「点外面关掉」
  const overlay = lightboxOf(h.win.document)
  assert.ok(overlay !== null, '前置：灯箱仍在（上一步点图没有关掉它）')
  clickOn(h, overlay)
  await h.settle()
  assert.equal(hasLightbox(h.win.document), false, '点背景必须关掉灯箱')
  assert.equal(h.store.get().view, 'article', '点背景只关灯箱，不改视图')
})

test('R6 07：Esc 的优先级是 帮助浮窗 → 灯箱 → 退出正文（一条链逐级下降）', skip, async () => {
  // 三个出口同住 `back` 动作（spec 决策 26）。为什么顺序不能反：帮助是全局浮窗、视觉上压在
  // 灯箱之上（z-index 6 > 5），最上层先走；而灯箱关掉之后读者仍在正文里，不该被一路带到列表。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: { itemId: 'a', title: 'ART', blocks: [imgBlock('https://img.example/one.png', { alt: '图一' })] },
  })
  const body = await openArticle(h)
  await openLightbox(h, body)

  assert.equal(h.press('?'), true, '灯箱开着时 ? 仍应被接管（帮助不随灯箱分流）')
  await h.settle()
  assert.equal(hasHelp(h.win.document), true, '前置：帮助浮窗已开')
  assert.equal(hasLightbox(h.win.document), true, '前置：灯箱仍开着（帮助是叠在它上面的）')

  assert.equal(h.press('Escape'), true, '第一级 Esc 应当被接管')
  await h.settle()
  assert.equal(hasHelp(h.win.document), false, '第一级：帮助浮窗先关')
  assert.equal(hasLightbox(h.win.document), true, '第一级：灯箱必须还在（帮助优先于灯箱）')
  assert.equal(h.store.get().view, 'article', '第一级：视图不变')

  assert.equal(h.press('Escape'), true, '第二级 Esc 应当被接管')
  await h.settle()
  assert.equal(hasLightbox(h.win.document), false, '第二级：灯箱关')
  assert.equal(h.store.get().view, 'article', '第二级：仍不退出正文')

  assert.equal(h.press('Escape'), true, '第三级 Esc 应当被接管')
  await h.settle()
  assert.equal(h.store.get().view, 'list', '第三级：这才退出正文回列表')
})

test('R6 07：灯箱是非模态的——n / p / 空格 / d 仍滚动正文，灯箱一直开着', skip, async () => {
  // 与帮助浮窗同一条约定（spec 决策 27）：覆盖层不许吞键，否则读者在大图上既不能翻页也不能
  // 微调位置，只能先关掉它。判据是 `scrollTop` **真的变了**且灯箱仍在 —— 不是「按键没被
  // preventDefault」（routeKey 自己就会 preventDefault，那个信号对任何实现都恒真）。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: {
      itemId: 'a', title: 'ART',
      blocks: [imgBlock('https://img.example/one.png', { alt: '图一' }), { kind: 'p', text: '正文段落。' }],
    },
  })
  const body = await openArticle(h)
  await openLightbox(h, body)

  const article = h.arm(h.box('article'), { scrollHeight: 3000, clientHeight: 300 })

  for (const [key, label] of [['n', 'n（扫视下一行）'], ['p', 'p（扫视上一行）'], [' ', '空格（整屏）'], ['d', 'd（半屏）']]) {
    const before = h.scrollTop(article)
    assert.equal(h.press(key), true, '灯箱开着时 ' + label + ' 仍应被接管')
    await h.settle()
    assert.notEqual(h.scrollTop(article), before, '灯箱开着时 ' + label + ' 必须真的滚动正文（非模态，spec 决策 27）')
    assert.equal(hasLightbox(h.win.document), true, '灯箱开着时 ' + label + ' 不许把灯箱关掉')
  }
  assert.equal(h.store.get().view, 'article', '全程留在正文页')
})

test('R6 07：j / k 是换文章不是滚动——换篇后灯箱自动关闭（复位 effect 覆盖）', skip, async () => {
  // 源码核对（`src/client/keyboard-routing.ts:180-189`）：`next` / `prev` 在 `view === 'article'`
  // 时调 `store.stepArticle`，是**换篇**。所以它们不参与「滚动仍生效」那条，而是靠决策 15 的
  // 复位 effect 让灯箱跟着关 —— 旧文章的 `src` 不该留在一个新文章的浮层里。
  const articleOf = (itemId) => ({
    itemId, title: 'ART ' + itemId,
    blocks: [imgBlock('https://img.example/' + itemId + '.png', { alt: itemId })],
  })
  const h = await mountReader({
    items: [item({ id: 'a' }), item({ id: 'b' })],
    article: articleOf,
  })
  const body = await openArticle(h)
  const lightbox = await openLightbox(h, body)
  assert.equal(lightbox.querySelector('img')?.getAttribute('src'), 'https://img.example/a.png', '前置：a 篇的图')

  assert.equal(h.press('j'), true, '灯箱开着时 j 仍应被接管（换篇不是灯箱的私有动作）')
  await h.settle()
  assert.equal(h.store.get().article.itemId, 'b', '前置：已切到 b 篇')
  assert.equal(hasLightbox(h.win.document), false,
    '换篇后灯箱必须关闭 —— 否则 a 篇的图会占着 b 篇的屏幕（spec 决策 15 的复位 effect 覆盖这条）')
  assert.equal(h.store.get().view, 'article', '换篇仍在正文页')
})

test('R6 07：按 i 折叠整篇时一并关掉灯箱（不许出现「全折叠了、一张图还占满屏」）', skip, async () => {
  // spec 决策 24 的残留态：折叠态下正文里没有 <img>，灯箱却是同一张图的大图 —— 读者会以为
  // 折叠没生效。判据是「灯箱消失 + 图消失」两条一起。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: { itemId: 'a', title: 'ART', blocks: [imgBlock('https://img.example/one.png', { alt: '图一' })] },
  })
  const body = await openArticle(h)
  await openLightbox(h, body)

  assert.equal(h.press('i'), true, 'i 应当被接管')
  await h.settle()
  assert.equal(hasLightbox(h.win.document), false, 'i 折叠整篇时必须一并关掉灯箱（决策 24）')
  assert.equal(body.querySelectorAll('img').length, 0, '前置：折叠后正文里没有 <img>')
  assert.equal(foldHints(body).length, 1, '前置：折叠提示出现了')
})

test('R6 07：覆盖层只盖正文面——inset 0 + z-index 5 挂在 ArticleView 已定位的外层上', skip, async () => {
  // 挂错地方的两个后果（spec 决策 24）：挂到面板根 ⇒ 连顶栏与左栏一起盖住，读者看不见
  // 「返回列表」也点不了源；挂进滚动容器 ⇒ 覆盖层跟着内容滚走。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: { itemId: 'a', title: 'ART', blocks: [imgBlock('https://img.example/one.png', { alt: '图一' })] },
  })
  const body = await openArticle(h)
  const lightbox = await openLightbox(h, body)

  // inset 0：铺满那一层（jsdom 把 `inset: 0` 序列化成 `0px`，实测）
  assert.equal(lightbox.style.inset, '0px', '覆盖层必须 inset: 0（铺满正文面，不是一个小浮窗）')
  assert.equal(lightbox.style.zIndex, '5', '覆盖层必须 z-index: 5（压在正文之上、帮助浮窗 6 之下）')

  const layer = lightbox.parentElement
  assert.ok(layer !== null, '前置：覆盖层有父节点')
  assert.equal(layer.style.position, 'relative', '覆盖层必须挂在 ArticleView 那层 position: relative 上（inset 才有参照）')
  assert.ok(layer.contains(body), '前置：那层就是正文所在的层（它包着正文列）')
  assert.equal(body.contains(lightbox), false, '覆盖层不许放进滚动容器 —— 否则它跟着内容滚走')
  assert.equal(layer === h.win.document.querySelector('[data-dsh-rss-reader]'), false,
    '覆盖层不许挂在面板根上 —— 那会连顶栏与左栏一起盖住（读者点不到「返回列表」与源）')
})

test('R6 07：灯箱用 role="region" + aria-label，不许用 role="dialog" / aria-modal', skip, async () => {
  // 为什么这条是硬判据而不是无障碍洁癖（spec 决策 25）：`isTypingTarget` 会把焦点落在
  // `[role="dialog"]` / `[aria-modal="true"]` / `<dialog>` 里的按键**全部吞掉，含 Esc** ——
  // 读者只要用鼠标点过一次灯箱里的图，Esc 就再也关不掉它（帮助浮窗踩过同一个坑，实测）。
  const h = await mountReader({
    items: [item({ id: 'a' })],
    article: { itemId: 'a', title: 'ART', blocks: [imgBlock('https://img.example/one.png', { alt: '图一' })] },
  })
  const body = await openArticle(h)
  const lightbox = await openLightbox(h, body)

  assert.equal(lightbox.getAttribute('role'), 'region', '覆盖层必须是 role="region"（对话框语义会把 Esc 一起吞掉）')
  assert.equal(lightbox.getAttribute('aria-modal'), null, '覆盖层不许写 aria-modal（它不是模态）')
  assert.equal(lightbox.tagName, 'DIV', '覆盖层不许是 <dialog>（同样会触发 isTypingTarget 的弹层守卫）')
  assert.ok((lightbox.getAttribute('aria-label') ?? '') !== '', 'region 必须带 aria-label（否则读屏器只说「区域」）')

  // 反向验证：把焦点放进灯箱里再按 Esc，仍然关得掉 —— 这正是「不用 dialog 语义」换来的行为
  lightbox.focus()
  assert.equal(pressFrom(h, lightbox, 'Escape'), true, '焦点在灯箱里时 Esc 仍应被接管（非模态约定）')
  await h.settle()
  assert.equal(hasLightbox(h.win.document), false, '焦点在灯箱里时 Esc 必须关得掉 —— dialog 语义会在这里静默失效')
})

/* ── R12 04：列表行与正文 header 显示作者 ─────────────────────────────────────
 * 文案断言必须同时钉三件事，缺一条就有实现能全绿逃走（验收 12/13）：
 *  1. 无作者时不出现「未知作者 / 佚名 / —」这类伪造文案，也不留空段；
 *  2. 单源视图（selectedFeed !== undefined）也显示作者 —— 只钉跨源三段的话，
 *     「作者只加在跨源分支」的变异会幸存；
 *  3. 超长作者的行内文本仍是原值、title 给全文（省略是显示决定，数据层不截断）。
 * 时间夹具固定用 2020-01-01：relativeTime 超过 30 天回 ISO 日期，断言与运行时钟无关。
 */
const AUTHOR_AT = '2020-01-01T00:00:00.000Z'
const AUTHOR_TIME = '2020-01-01'

function listMetaOf(h, id) {
  const meta = h.win.document.querySelector('[data-rss-row="' + id + '"] .dsh-rss-meta')
  assert.ok(meta !== null, '条目 ' + id + ' 应有列表行 meta')
  return meta
}

/** 伪造文案与空段是两条独立失效：前者是占位符，后者是拼 undefined 拼出来的空串。 */
function assertNoAuthorPlaceholderOrEmptySegment(meta) {
  const text = meta.textContent ?? ''
  assert.doesNotMatch(text, /未知作者|佚名|—/, '无作者时不许出现占位文案：' + JSON.stringify(text))
  for (const segment of text.split(' · ')) {
    assert.notEqual(segment.trim(), '', 'meta 不许出现空段：' + JSON.stringify(text))
  }
}

test('R12 04 列表行：跨源视图有作者三段、无作者两段，且无伪造文案与空段', skip, async () => {
  const h = await mountReader({
    items: [
      item({ id: 'with', feedId: 'f1', feedTitle: '源一', author: '张三', publishedAt: AUTHOR_AT }),
      item({ id: 'without', feedId: 'f1', feedTitle: '源一', publishedAt: AUTHOR_AT }),
    ],
    feeds: [{ id: 'f1', title: '源一' }],
  })
  await h.store.load('overview')
  await h.settle()

  const withAuthor = listMetaOf(h, 'with')
  assert.equal(withAuthor.textContent, '源一 · 张三 · ' + AUTHOR_TIME,
    '跨源视图有作者时必须是「源 · 作者 · 时间」三段')
  assertNoAuthorPlaceholderOrEmptySegment(withAuthor)
  const authorEl = withAuthor.querySelector('[data-rss-author]')
  assert.ok(authorEl !== null, '作者要有独立文本节点（单行省略与 title 全文挂在它上面）')
  assert.notEqual(authorEl.tagName, 'A', '作者按纯文本渲染，不做可点链接（决策 17）')
  assert.equal(authorEl.getAttribute('href'), null, '作者不是链接')

  const withoutAuthor = listMetaOf(h, 'without')
  assert.equal(withoutAuthor.textContent, '源一 · ' + AUTHOR_TIME,
    '跨源视图无作者时保持现状两段，不许拼出空段')
  assertNoAuthorPlaceholderOrEmptySegment(withoutAuthor)
  assert.equal(withoutAuthor.querySelector('[data-rss-author]'), null, '无作者时不该有作者节点')
})

test('R12 04 列表行：单源视图有作者两段、无作者只有时间，且无伪造文案与空段', skip, async () => {
  const h = await mountReader({
    items: [
      item({ id: 'with', feedId: 'f1', feedTitle: '源一', author: '李四', publishedAt: AUTHOR_AT }),
      item({ id: 'without', feedId: 'f1', feedTitle: '源一', publishedAt: AUTHOR_AT }),
    ],
    feeds: [{ id: 'f1', title: '源一' }],
  })
  await h.store.load('overview')
  await h.settle()

  // 走真实点击：单源视图是 selectedFeed !== undefined 的那条分支，直调 store 会绕开接线。
  h.win.document.querySelector('[data-rss-nav-row="feed:f1"]')
    .dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await h.settle()
  assert.deepEqual(h.store.get().navSelection, { kind: 'feed', feedId: 'f1' }, '前置：已切到单源视图')

  const withAuthor = listMetaOf(h, 'with')
  assert.equal(withAuthor.textContent, '李四 · ' + AUTHOR_TIME,
    '单源视图有作者时必须是「作者 · 时间」两段（源名本来就不显示）')
  assertNoAuthorPlaceholderOrEmptySegment(withAuthor)
  assert.ok(withAuthor.querySelector('[data-rss-author]') !== null, '单源视图同样要渲染作者')

  const withoutAuthor = listMetaOf(h, 'without')
  assert.equal(withoutAuthor.textContent, AUTHOR_TIME,
    '单源视图无作者时只有时间，不许留前导空段')
  assertNoAuthorPlaceholderOrEmptySegment(withoutAuthor)
})

test('R12 04 列表行：超长作者显示原值，title 给全文（数据层不截断）', skip, async () => {
  // 80 个汉字足够超过任何窄侧栏宽度；jsdom 没有排版引擎，省略号本身不做断言（口径见票据）。
  const longAuthor = '欧'.repeat(80) + '作者'
  const h = await mountReader({
    items: [item({ id: 'long', feedId: 'f1', feedTitle: '源一', author: longAuthor, publishedAt: AUTHOR_AT })],
    feeds: [{ id: 'f1', title: '源一' }],
  })
  await h.store.load('overview')
  await h.settle()

  const meta = listMetaOf(h, 'long')
  const authorEl = meta.querySelector('[data-rss-author]')
  assert.ok(authorEl !== null, '前置：作者节点存在')
  assert.equal(authorEl.textContent, longAuthor, '行内文本必须是原值 —— 省略是 CSS 的决定，不改写数据')
  assert.equal(authorEl.getAttribute('title'), longAuthor, 'title 必须给全文（鼠标悬停能看到完整作者名）')
  assert.equal(meta.textContent, '源一 · ' + longAuthor + ' · ' + AUTHOR_TIME, '超长作者也不改变三段结构')
})

test('R12 04 正文 header：有作者显示「源 · 作者 · 日期 · 约 N 分钟」，无作者保持现状', skip, async () => {
  const blocks = [{ kind: 'p', text: '中'.repeat(600) }]
  const headerOf = (body) => {
    const header = body.querySelector('header .dsh-rss-meta')
    assert.ok(header !== null, '正文 header 应有 meta 行')
    return header
  }

  const withAuthor = await mountReader({
    items: [item({ id: 'a', feedId: 'f1', feedTitle: '源一', author: '张三', publishedAt: AUTHOR_AT })],
    feeds: [{ id: 'f1', title: '源一' }],
    article: { itemId: 'a', title: 'ART', blocks },
  })
  const withHeader = headerOf(await openArticle(withAuthor))
  // 日期格式交给平台 locale（zh-CN），这里只钉「源 · 作者 · 日期 · 时长」的组成与顺序。
  assert.match(withHeader.textContent ?? '', /^源一 · 张三 · .+ · 约 2 分钟（估算）$/,
    '有作者时正文 header 必须是「源 · 作者 · 日期 · 约 N 分钟」')
  assertNoAuthorPlaceholderOrEmptySegment(withHeader)
  assert.equal(withHeader.querySelector('a'), null, '正文 header 的作者不做可点链接')

  const withoutAuthor = await mountReader({
    items: [item({ id: 'a', feedId: 'f1', feedTitle: '源一', publishedAt: AUTHOR_AT })],
    feeds: [{ id: 'f1', title: '源一' }],
    article: { itemId: 'a', title: 'ART', blocks },
  })
  const withoutHeader = headerOf(await openArticle(withoutAuthor))
  assert.match(withoutHeader.textContent ?? '', /^源一 · .+ · 约 2 分钟（估算）$/,
    '无作者时正文 header 保持现状（源 · 日期 · 时长）')
  assert.doesNotMatch(withoutHeader.textContent ?? '', /张三|未知作者|佚名|—/, '无作者时不许出现作者或占位文案')
  assertNoAuthorPlaceholderOrEmptySegment(withoutHeader)
})


/* ──────────────── R15 02：订阅行的 RSSHub 来源（真实 DOM） ──────────────── */
/**
 * 出处由宿主下发（FeedView.rsshub），客户端只显示 —— 这里钉的正是「非 RSSHub 源什么都不加」：
 * 若客户端自己拿实例池重判，两份裁决迟早会漂，而那种漂移在 DOM 上表现为多一行或少一行。
 */
test('R15 02：RSSHub 源显示「RSSHub · 当前实例」；非 RSSHub 源不显示来源', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a1', feedId: 'a' }), item({ id: 'b1', feedId: 'b' })],
    feeds: [
      { id: 'a', title: 'RSSHub 源', rsshub: { namespace: 'baoyu', path: '/baoyu/blog', instance: 'https://hub.test' } },
      { id: 'b', title: '原生源' },
    ],
  })
  await h.store.load('overview')
  await h.settle()
  h.press('f')
  await h.settle()
  const doc = h.win.document

  const rowA = doc.querySelector('[data-rss-feed-rsshub="a"]')
  assert.ok(rowA, 'RSSHub 源必须有一行来源标注')
  assert.match(rowA.textContent, /RSSHub · https:\/\/hub\.test/, '显示来源类型与当前实例（宿主下发的值）')

  assert.equal(doc.querySelector('[data-rss-feed-rsshub="b"]'), null, '非 RSSHub 源不许凭空多一行来源')
})
