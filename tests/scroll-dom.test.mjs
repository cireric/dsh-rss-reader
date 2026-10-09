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
 * 起一个 DOM 环境 + 加载真实 bundle + 渲染真实 Reader。
 * 返回的 press 派发的是真 KeyboardEvent；box 是**从 DOM 里按标记属性现查的**真实节点
 * （所以它同时验证了「标记属性真的写进了 DOM」）。
 */
async function mountReader({ items = [], article, holdArticle } = {}) {
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
  let releaseArticle
  const gate = holdArticle === true ? new Promise((resolve) => { releaseArticle = resolve }) : undefined
  const fetchStub = async (_url, init) => {
    const body = JSON.parse(init.body)
    endpoints.push(body.endpoint)
    if (body.endpoint === 'overview') return ok({ feeds: [], unread: items.length, items })
    if (body.endpoint === 'article') {
      if (gate !== undefined) await gate
      return ok(article ?? { itemId: body.payload.itemId, title: 'ART', blocks: [{ kind: 'p', text: '正文' }], paragraphs: ['正文'] })
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
  return { store, win, endpoints, box, byLabel, arm, observeContent, userScroll, press, release: () => { if (releaseArticle !== undefined) releaseArticle() }, scrollTop: (el) => (geometry.get(el) ?? (() => el.scrollTop))() }
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

test('详情页 d / u 翻半页（整屏的一半，且夹得住边界）', skip, async () => {
  const h = await mountReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await h.store.load('overview')
  await sleep(30)
  h.press('V', true)
  for (let i = 0; i < 40 && h.store.get().view !== 'article'; i += 1) await sleep(20)
  await sleep(60)

  const article = h.arm(h.box('article'))
  assert.equal(h.press('d'), true, 'd 应当被接管')
  assert.equal(h.scrollTop(article), 150, 'd 应当滚动半屏')
  assert.equal(h.press('u'), true, 'u 应当被接管')
  assert.equal(h.scrollTop(article), 0, 'u 应当滚回原位')
  assert.equal(h.press('u'), true, '顶部再按 u 仍应被接管（只是夹在 0）')
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
