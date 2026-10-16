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
import { test } from 'node:test'
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
      React: require_(reactPath),
      jsxRuntime: require_(join(reactPath, 'jsx-runtime')),
      createRoot: require_(join(reactDomPath, 'client')).createRoot,
      renderToString: require_(join(reactDomPath, 'server')).renderToString,
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
function overviewStub(items, feeds) {
  const table = feeds ?? [...new Set(items.map((entry) => entry.feedId))].map((feedId) => ({ id: feedId, title: feedId }))
  const perFeedUnread = {}
  // 先按 feeds 表铺 0：这一步是键域的全部要点，缺了它 0 未读的源就会丢键
  for (const feed of table) perFeedUnread[feed.id] = 0
  for (const entry of items) {
    // 已退订源的条目可能仍在 items 里，但那种源不该出现在 map 中（契约：键域 = feeds 表）
    if (entry.readAt === undefined && entry.feedId in perFeedUnread) perFeedUnread[entry.feedId] += 1
  }
  return {
    feeds: table, items,
    unread: items.filter((entry) => entry.readAt === undefined).length,
    perFeedUnread,
    refreshed: false,
  }
}


/**
 * 起一个 DOM 环境 + 加载真实 bundle + 渲染真实 Reader。
 * 返回的 press 派发的是真 KeyboardEvent；box 是**从 DOM 里按标记属性现查的**真实节点
 * （所以它同时验证了「标记属性真的写进了 DOM」）。
 */
async function mountReader({ items = [], feeds, article, holdArticle } = {}) {
  const { JSDOM, React, jsxRuntime, createRoot } = STACK
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
  const account = overviewStub(items, feeds)
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
  const fetchStub = async (_url, init) => {
    const body = JSON.parse(init.body)
    endpoints.push(body.endpoint)
    // refresh 与 overview 都回完整 Overview（src/endpoints.ts:112-118）—— 桩件此前把 refresh
    // 回成 {changed,unread}，而面板挂载时走的就是 refresh（index.tsx:184），于是 overview 字段
    // 全是 undefined。这是夹具没守住契约，不是代码该容忍的形状。
    if (body.endpoint === 'overview' || body.endpoint === 'refresh') return ok(overviewStub(items, feeds))
    if (body.endpoint === 'article') {
      if (gate !== undefined) await gate
      return ok(article ?? { itemId: body.payload.itemId, title: 'ART', blocks: [{ kind: 'p', text: '正文' }], paragraphs: ['正文'] })
    }
    if (body.endpoint === 'markRead' || body.endpoint === 'unmarkRead') {
      const ids = Array.isArray(body.payload?.itemIds) ? body.payload.itemIds : []
      return ok(markReply(body.endpoint, ids))
    }
    return ok({ changed: 1, unread: 0 })
  }
  globalThis.fetch = fetchStub
  win.fetch = fetchStub

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
  createRoot(win.document.getElementById('root')).render(React.createElement(exportsObj.createReader(store)))
  await sleep(50)

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
  return { store, win, endpoints, box, byLabel, arm, observeContent, userScroll, press, exports: exportsObj, release: () => { if (releaseArticle !== undefined) releaseArticle() }, scrollTop: (el) => (geometry.get(el) ?? (() => el.scrollTop))() }
}

/** 一条最小可用条目。 */
function item(overrides = {}) {
  return {
    id: 'item-1', feedId: 'f', feedTitle: '源', title: '标题',
    link: 'https://example.com/a', readAt: undefined, starred: false,
    fetchedAt: '2026-10-06T00:00:00.000Z', ...overrides,
  }
}

const skip = STACK === undefined ? { skip: '环境缺真实 React/jsdom（见本文件顶部说明）' } : {}

test('详情页空格翻页：容器必须在 DOM 里、且按键真的改了它的 scrollTop', skip, async () => {
  // 这个用例就是 2026-10-09 那条缺陷的回归闸门：当时容器存在 state 里被 keydown 闭包捕获，
  // 进详情页后空格是 no-op —— 而旧夹具对此全绿。
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  await sleep(30)

  // 列表页：空格应当滚动
  const list = h.arm(h.box('list'))
  assert.equal(h.press(' '), true, '列表页空格应当被接管')
  assert.equal(h.scrollTop(list), 300, '列表页空格应当滚动一屏')

  // 进详情页（走真实按键路径，不走 store 直调 —— 要覆盖「按 V 之后」这个真实时序）
  h.press('V', true)
  for (let i = 0; i < 40 && h.store.get().view !== 'article'; i += 1) await sleep(20)
  await sleep(60)
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
  await sleep(30)
  h.press('V', true)
  for (let i = 0; i < 40 && h.store.get().view !== 'article'; i += 1) await sleep(20)
  await sleep(60)

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
  await sleep(30)
  h.press('V', true)
  for (let i = 0; i < 40 && h.store.get().view !== 'article'; i += 1) await sleep(20)
  await sleep(60)

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
  await sleep(30)
  h.press('V', true)
  await sleep(80)
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
  await sleep(30)
  h.press('V', true)
  for (let i = 0; i < 40 && h.store.get().view !== 'article'; i += 1) await sleep(20)
  await sleep(60)

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
  await sleep(200)
  assert.equal(h.store.get().article.itemId, 'b', 'j 应当切到下一条')
  assert.equal(h.box('article'), article, 'React 会复用同一个 DOM 节点（正是需要显式归零的原因）')
  assert.equal(h.scrollTop(article), 0, '换文章后应当从顶部开始读')
})

test('订阅管理页按翻页键不该刷警告（无容器的视图是正常状态，不是异常）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' })] })
  await h.store.load('overview')
  await sleep(30)
  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  try {
    h.press('F') // 进订阅管理
    await sleep(30)
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
  await sleep(30)

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
  await sleep(30)
  h.press('V', true)
  for (let i = 0; i < 40 && h.store.get().view !== 'article'; i += 1) await sleep(20)
  await sleep(60)

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
  await sleep(30)
  h.press('V', true)
  await sleep(80)
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
  await sleep(30)
  h.press('V', true)
  for (let i = 0; i < 40 && h.store.get().view !== 'article'; i += 1) await sleep(20)
  await sleep(60)

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
  await sleep(30)
  h.press('V', true)
  for (let i = 0; i < 40 && h.store.get().view !== 'article'; i += 1) await sleep(20)
  await sleep(60)

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
  await sleep(30)

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
  await sleep(30)

  const feedRow = () => h.win.document.querySelector('[data-rss-nav-row="feed:f1"]')
  assert.equal(feedRow().getAttribute('data-rss-nav-badge'), '1', '前置条件：默认显示角标')

  // 走真实交互：点顶栏那个复选框，而不是直调 store.setShowUnread —— 这样「顶栏 / 侧栏徽标 /
  // 左栏角标三者同消」才真的被钉住（三者任一一处漏改，这里就会红）。
  const toggle = [...h.win.document.querySelectorAll('input[type="checkbox"]')][0]
  assert.ok(toggle !== undefined, '应当有「显示未读计数」复选框')
  toggle.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await sleep(30)

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
  await sleep(30)

  const listTitles = () => [...h.win.document.querySelectorAll('[data-rss-row]')].map((row) => row.getAttribute('data-rss-row'))
  assert.deepEqual(listTitles(), ['a', 'b', 'c'], '前置条件：聚合视图下三条都在')

  // 真实 MouseEvent 派发：走的是 onClick → store.selectNav 的完整接线，不是直调 store
  const row = h.win.document.querySelector('[data-rss-nav-row="feed:f1"]')
  row.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await sleep(30)

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
  await sleep(30)
  assert.deepEqual(h.store.get().navSelection, { kind: 'virtual' }, '再点同一个源应当取消选中')
  assert.deepEqual(listTitles(), ['a', 'b', 'c'], '取消后应当回到聚合视图')
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
  await sleep(30)

  const row = (key) => h.win.document.querySelector('[data-rss-nav-row="' + key + '"]')
  const marked = (key) => row(key).getAttribute('data-rss-nav-selected') === ''

  // ① 先点左栏「未读」
  row('filter:unread').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await sleep(30)
  assert.equal(h.store.get().filter, 'unread', '前置条件：过滤切到未读')

  // ② 再点源一
  row('feed:f1').dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await sleep(30)

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
  await sleep(30)
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
  await sleep(30)

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
  await sleep(30)
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
  await sleep(30)

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
  await sleep(30)

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
  await sleep(30)

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
  await sleep(30)

  const navPresent = () => h.win.document.querySelector('[data-rss-nav]') !== null
  assert.equal(navPresent(), true, '前置条件：默认展开，左栏在 DOM 里')

  assert.equal(h.press('u'), true, 'u 应当被接管 —— 2026-10-10 之前它在这里是「向上半页」')
  await sleep(30)
  assert.equal(h.store.get().navVisible, false, 'u 第一次按下应当折叠左栏')
  assert.equal(navPresent(), false, '折叠后左栏容器必须整个消失（不是 width:0）')

  assert.equal(h.press('u'), true, '再按一次 u 仍应被接管')
  await sleep(30)
  assert.equal(navPresent(), true, '再按 u 应当把左栏找回来')

  // 正文页里 u 不改「背后那个看不见的左栏」（与 o 键同一裁决，见 keys 帮助行旁的注释）
  h.press('V', true)
  for (let i = 0; i < 40 && h.store.get().view !== 'article'; i += 1) await sleep(20)
  await sleep(60)
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
  await sleep(30)

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
  await sleep(30)
  assert.equal(cursorRow(), 'filter:unread', 'shift+n 应当把左栏光标移到下一行')
  assert.equal(selectedRow(), 'filter:all', '而「生效」那一行仍是「全部」—— 光标与生效是两件事')
  assert.equal(h.store.get().filter, 'all', '移动光标**不改变**生效的 filter（打开才改 —— 规格 §2.4）')
  assert.deepEqual(listIds(), ['a', 'b'], '移动光标**不改变**右栏列表内容')
  assert.deepEqual({ ...h.store.get().navSelection }, { kind: 'virtual' }, '移动光标**不选中**任何源')

  // 小写 n 是「扫视」：滚动视野但**不改变选中**，尤其不该动左栏高亮（两条轴不能互相顶掉）
  assert.equal(h.press('n'), true, '小写 n 仍应被接管（扫视）')
  await sleep(30)
  assert.equal(cursorRow(), 'filter:unread', '小写 n 不得改变左栏光标')
  assert.equal(h.store.get().filter, 'all', '小写 n 不得改变生效的 filter')

  // 继续向下走到源列表，再往回；到头/到尾要夹住而不是绕回。全程右栏纹丝不动。
  h.press('N', true); await sleep(20)
  assert.equal(cursorRow(), 'filter:starred', '第三行是星标')
  h.press('N', true); await sleep(20)
  assert.equal(cursorRow(), 'feed:f1', '跳过虚拟视图三行后进入源列表')
  h.press('N', true); await sleep(20)
  assert.equal(cursorRow(), 'feed:f2', '再下一行是第二个源')
  assert.deepEqual(listIds(), ['a', 'b'], '一路移动到底，右栏仍是聚合视图 —— 光标走过谁都不等于打开谁')
  h.press('N', true); await sleep(20)
  assert.equal(cursorRow(), 'feed:f2', '已经是最后一行，shift+n 应当夹住不动')
  assert.equal(h.press('N', true), true, '夹住时按键仍应被接管（不是「键坏了」）')

  h.press('P', true); await sleep(20)
  assert.equal(cursorRow(), 'feed:f1', 'shift+p 应当回到上一行')
  for (let i = 0; i < 4; i += 1) { h.press('P', true); await sleep(20) }
  assert.equal(cursorRow(), 'filter:all', '一路向上应当停在第一行（到头夹住，不绕回）')
  assert.equal(selectedRow(), 'filter:all', '全程没打开过任何一行，「生效」始终是「全部」')

  // ── 只有 shift+o 才让光标那一行生效 ────────────────────────────────────────────────
  h.press('N', true); await sleep(20)          // 光标 → 未读
  h.press('N', true); await sleep(20)          // 光标 → 星标
  h.press('N', true); await sleep(20)          // 光标 → 源一
  assert.deepEqual(listIds(), ['a', 'b'], '前置条件：光标走到源一，右栏仍是聚合视图')
  assert.equal(h.press('O', true), true, 'shift+o 应当被接管')
  await sleep(30)
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
    await sleep(30)
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
  await sleep(30)
  assert.deepEqual(snapshot(h), { navSelection: { kind: 'virtual' }, filter: 'all', selectedId: 'a', list: ['a', 'b'] },
    '虚拟视图行上的 shift+o 应当等价于打开「全部」，不产生副作用')

  // ② 键盘路径：移动到「星标」行（移动本身不生效），再 shift+o —— 此刻才落作用域。
  const viaKey = await mount()
  const keyMoves = (h, n) => (async () => { for (let i = 0; i < n; i += 1) { h.press('N', true); await sleep(20) } })()
  await keyMoves(viaKey, 2) // 全部→未读→星标
  assert.deepEqual(snapshot(viaKey), { navSelection: { kind: 'virtual' }, filter: 'all', selectedId: 'a', list: ['a', 'b'] },
    '走到「星标」行时右栏必须还是聚合视图 —— 移动不等于打开')
  assert.equal(viaKey.press('O', true), true, 'shift+o 应当被接管')
  await sleep(30)
  const afterKey = snapshot(viaKey)
  assert.equal(afterKey.filter, 'starred', '打开「星标」行之后 filter 才变成 starred')
  assert.deepEqual(afterKey.list, ['a'], '右栏随之只剩星标条目')

  // ③ 鼠标路径：从同一起点直接点「星标」那一行 —— 两条路径最终状态必须逐字段相等。
  const viaMouse = await mount()
  viaMouse.win.document.querySelector('[data-rss-nav-row="filter:starred"]')
    .dispatchEvent(new viaMouse.win.MouseEvent('click', { bubbles: true }))
  await sleep(30)
  assert.deepEqual(snapshot(viaMouse), afterKey, '键盘「移动到该行 + shift+o」与鼠标点击该行必须落到同一份状态')

  // ④ 源行同样等价于点击：键盘移动 + shift+o 对比鼠标点击同一行
  const viaKeyFeed = await mount()
  await keyMoves(viaKeyFeed, 3) // 全部→未读→星标→源一
  assert.equal(viaKeyFeed.press('O', true), true, '源行上的 shift+o 应当被接管')
  await sleep(30)
  const afterKeyFeed = snapshot(viaKeyFeed)
  assert.deepEqual(afterKeyFeed.navSelection, { kind: 'feed', feedId: 'f1' }, '打开源一 = 选中它')

  const viaMouseFeed = await mount()
  viaMouseFeed.win.document.querySelector('[data-rss-nav-row="feed:f1"]')
    .dispatchEvent(new viaMouseFeed.win.MouseEvent('click', { bubbles: true }))
  await sleep(30)
  assert.deepEqual(snapshot(viaMouseFeed), afterKeyFeed, '源行上两条路径必须落到同一份状态')
})

test('左栏折叠时 shift+n/p/o 不生效：不许改一个看不见的导航', skip, async () => {
  const h = await mountReader({
    items: [item({ id: 'a', feedId: 'f1', feedTitle: '源一' })],
    feeds: [{ id: 'f1', title: '源一' }],
  })
  await h.store.load('overview')
  await sleep(30)

  h.press('u'); await sleep(30)
  assert.equal(h.store.get().navVisible, false, '前置条件：左栏已折叠')
  const before = JSON.stringify(snapshotState(h))

  assert.equal(h.press('N', true), false, '折叠时 shift+n 不该被接管')
  assert.equal(h.press('P', true), false, '折叠时 shift+p 不该被接管')
  assert.equal(h.press('O', true), false, '折叠时 shift+o 不该被接管')
  await sleep(30)
  assert.equal(JSON.stringify(snapshotState(h)), before, '折叠时左栏导航键不得改动任何状态')

  h.press('u'); await sleep(30)
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
  await sleep(30)
  const help = () => h.win.document.querySelector('[data-rss-help]')
  assert.equal(help(), null, '前置条件：默认不该有浮窗')

  assert.equal(h.press('?'), true, '? 应当被接管（不被宿主或浏览器抢走）')
  await sleep(30)
  assert.notEqual(help(), null, '按 ? 之后应当出现帮助浮窗')

  // 内容逐行核对而不是抽查两个词：少的正是「表里有一行、浮窗没画」这类脱节
  const text = help().textContent ?? ''
  for (const section of READER_KEY_HELP) {
    for (const entry of section.entries) {
      assert.ok(text.includes(entry.label), '浮窗里缺了这一行的键位写法：' + entry.label)
    }
  }

  assert.equal(h.press('?'), true, '再按一次 ? 仍应被接管')
  await sleep(30)
  assert.equal(help(), null, '再按 ? 应当关闭浮窗（开合同一个键）')
})

test('头部只留最右端一个 ? 入口：那行塞满键位的提示行必须真的没了', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' })] })
  await h.store.load('overview')
  await sleep(30)

  // 提示行的指纹：删掉之后这两个词不该再出现在面板里（浮窗里的写法是「j / k」与「n / p」，不会误命中）
  const body = h.win.document.body.textContent ?? ''
  assert.equal(body.includes('j/k 移动'), false, '头部那行键位提示又被写回来了')
  assert.equal(body.includes('n/p 扫视'), false, '头部那行键位提示又被写回来了')

  const entry = h.win.document.querySelector('button[aria-label="快捷键帮助"]')
  assert.notEqual(entry, null, '头部应当有 ? 帮助入口')
  assert.equal(entry.getAttribute('aria-expanded'), 'false', '收起态应当反映到 aria-expanded')
  entry.dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await sleep(30)
  assert.notEqual(h.win.document.querySelector('[data-rss-help]'), null, '点击 ? 入口应当打开浮窗')
  assert.equal(entry.getAttribute('aria-expanded'), 'true', '展开态应当反映到 aria-expanded')
})

test('Esc 关浮窗且不穿透：正文页里只收浮窗，不把文章一起关掉', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  await sleep(30)
  h.press('V', true)
  for (let i = 0; i < 40 && h.store.get().view !== 'article'; i += 1) await sleep(20)
  await sleep(60)
  assert.equal(h.store.get().view, 'article', '前置条件：已进正文页')

  assert.equal(h.press('?'), true, '正文页里 ? 也该能用（帮助不随视图分流）')
  await sleep(30)
  assert.notEqual(h.win.document.querySelector('[data-rss-help]'), null, '前置条件：浮窗已开')

  assert.equal(h.press('Escape'), true, 'Esc 应当被接管')
  await sleep(30)
  assert.equal(h.win.document.querySelector('[data-rss-help]'), null, 'Esc 应当关掉浮窗')
  assert.equal(h.store.get().view, 'article', '第一次 Esc 只关浮窗 —— 不许顺手把文章也关了')

  h.press('Escape')
  await sleep(30)
  assert.equal(h.store.get().view, 'list', '浮窗已关，第二次 Esc 回到原来的语义（正文 → 列表）')
})

test('✕ 关闭；焦点落在浮窗里之后 ? 与 Esc 仍然有效（非模态不许被自己的守卫吃掉）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' })] })
  await h.store.load('overview')
  await sleep(30)
  h.press('?'); await sleep(30)

  const close = h.win.document.querySelector('button[aria-label="关闭快捷键帮助"]')
  assert.notEqual(close, null, '浮窗应当有一个 ✕ 关闭按钮')
  // 真实浏览器里点按钮会把焦点给它 —— 这里也把焦点放过去，再**从它身上**派发按键。
  // 这是本用例的全部要点：浮窗若用了 role="dialog" / aria-modal，isTypingTarget 会把从浮窗内
  // 发出的按键全部吞掉（含 Esc），? 与 Esc 当场变哑。
  close.focus()
  assert.equal(h.win.document.activeElement, close, '前置条件：焦点在 ✕ 上')
  assert.equal(pressFrom(h, close, '?'), true, '焦点在浮窗里时 ? 仍应被接管')
  await sleep(30)
  assert.equal(h.win.document.querySelector('[data-rss-help]'), null, '再按 ? 应当关掉浮窗')

  h.press('?'); await sleep(30)
  const close2 = h.win.document.querySelector('button[aria-label="关闭快捷键帮助"]')
  close2.focus()
  assert.equal(pressFrom(h, close2, 'Escape'), true, '焦点在浮窗里时 Esc 仍应被接管')
  await sleep(30)
  assert.equal(h.win.document.querySelector('[data-rss-help]'), null, 'Esc 应当关掉浮窗')

  h.press('?'); await sleep(30)
  h.win.document.querySelector('button[aria-label="关闭快捷键帮助"]')
    .dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }))
  await sleep(30)
  assert.equal(h.win.document.querySelector('[data-rss-help]'), null, '点 ✕ 应当关掉浮窗')
})

test('非模态：浮窗开着时 j 仍然作用于背后的列表（这是拍板结论，不是默认行为）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  await sleep(30)
  const before = h.store.get().selectedId
  h.press('?'); await sleep(30)
  assert.notEqual(h.win.document.querySelector('[data-rss-help]'), null, '前置条件：浮窗已开')
  assert.equal(h.press('j'), true, '浮窗开着时 j 仍应被接管')
  await sleep(30)
  assert.notEqual(h.store.get().selectedId, before, '浮窗开着时 j 必须照旧移动背后的选中项（非模态）')
})

test('输入框里的 ? 不触发帮助（别抢正在打字的人的键）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' })] })
  await h.store.load('overview')
  await sleep(30)
  // 头部那个「显示未读计数」复选框是面板里真实存在的 input（左栏角标用例也在用它定位）
  const checkbox = [...h.win.document.querySelectorAll('input[type="checkbox"]')][0]
  assert.notEqual(checkbox, undefined, '前置条件：头部有复选框')
  assert.equal(pressFrom(h, checkbox, '?'), false, '从输入框发出的 ? 不该被接管')
  await sleep(30)
  assert.equal(h.win.document.querySelector('[data-rss-help]'), null, '输入框里的 ? 不该弹出帮助')
})

test('o 键：同一行连按两次必须收起（依赖数组里的 expanded 是承重的）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a', summary: '这一段正文摘录，展开之后才出现在行里' })] })
  await h.store.load('overview')
  await sleep(30)
  const row = h.win.document.querySelector('[data-rss-row="a"]')
  assert.ok(row !== null, '前置条件：列表里有这一行')
  // 展开态会多渲染一段摘录（index.tsx 的 isOpen 分支），所以行长度就是「是否展开」的可观察量。
  const sizeNow = () => row.innerHTML.length

  h.press('o'); await sleep(30)
  const afterOpen = sizeNow()
  assert.ok(afterOpen > 0, '前置条件：第一次按 o 应当展开')

  h.press('o'); await sleep(30)
  const afterSecondO = sizeNow()

  assert.ok(afterSecondO < afterOpen, '第二次按 o 必须收起 —— 若 expanded 不在依赖数组里，监听器读到的是注册那一刻的 undefined，于是永远「展开」而收不起来（行长度 ' + afterOpen + ' → ' + afterSecondO + '）')
})
