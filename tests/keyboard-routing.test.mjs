/**
 * 键盘路由的**纯函数层**判据（2026-10-15 C1）：routeKey(event, ctx) 把一次按键变成 store 动作。
 *
 * 为什么这一层单独有测试：搬运前那141 行路由长在 src/client/index.tsx 的组件体内，要测它只能
 * 走 createReader 渲染整棵组件树 —— 而那套夹具（tests/client-bundle.test.mjs）用的是自写假 React，
 * useEffect 忽略依赖数组（docs/pitfalls.md §2.1 记过那次 175/175 全绿而真机空格无响应的事故）。
 * 搬成纯函数后，24 个 action 分支的守卫与副作用可以直接驱动，不需要 React。
 *
 * **这一层的边界**（不要误读成「按键行为已全覆盖」）：它验路由与守卫，验不了「监听器有没有正确
 * 重注册」「闭包有没有捕获旧值」——那两类必须靠真 DOM 层（tests/scroll-dom.test.mjs 已在做）。
 *
 * 依赖：**routeKey 从 bundle 里取**（index.tsx 有一行仅供测试的 re-export）—— client 半只出
 * 单文件 lib/client.js（tsdown codeSplitting: false），.mjs 无法直接 import client 目录下的模块；
 * 这与 tests/scroll-dom.test.mjs 是同一套路（vm + 真 jsdom），只是我们不渲染 React。
 * jsdom 从 dsh checkout 解析（scripts/build.sh 现链，本仓库没有锁文件）。（与 tests/scroll-dom.test.mjs 同一串候选路径，scripts/build.sh
 * 现链、本仓库没有锁文件）。解析不到就**跳过**——那是环境能力，不是本仓库的缺陷。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(join(ROOT, 'package.json'))

function loadJsdom() {
  const home = process.env['HOME'] ?? ''
  const candidates = [
    process.env['DSH_CHECKOUT'],
    join(home, 'dsh-harness'), join(home, 'dsh'),
    join(home, '.dsh', 'dsh-harness'), join(home, 'deepseek-harness'),
  ]
  const checkout = candidates.find((c) => c !== undefined && existsSync(join(c, 'node_modules', '.pnpm')))
  if (checkout === undefined) return undefined
  try {
    return require_.resolve('jsdom', { paths: [checkout] }) === undefined
      ? undefined
      : require_(require_.resolve('jsdom', { paths: [checkout] })).JSDOM
  } catch (error) {
    console.warn('[keyboard-routing] jsdom 解析失败，跳过本组：', error instanceof Error ? error.message : error)
    return undefined
  }
}

const JSDOM = loadJsdom()

/**
 * 从 bundle 里取 routeKey：client 半只有单文件产物，.mjs 测试拿不到内部模块。
 * 取不到（bundle 太旧 / 没导出）时返回 undefined，对应用例整体跳过 —— 那不是本仓库的缺陷。
 */
/**
 * 从 bundle 里取 routeKey —— 与 tests/scroll-dom.test.mjs:182-192 同一套路：
 * 桩掉 window.__ModuleLoader__.load 捕获 entry，再 factory(require) 取 exports。
 *
 * 为什么必须走这条路：client 半只出**单文件** lib/client.js（tsdown codeSplitting: false），
 * .mjs 测试拿不到 client 目录下的任何模块 ⇒ index.tsx 有一行仅供测试的 re-export。
 * ⚠️ 这里不用 vm.createContext 建 sandbox：bundle 顶部是 window.__ModuleLoader__.load(...)
 *   而 sandbox 里的 window 是我造的空壳 ⇒ 直接抛（首次写成那样，8 条用例全部 SKIP、0 pass ——
 *   正是 pitfalls §2.7 说的「看起来在跑、其实一条都没跑」）。改成 runInThisContext + 真 jsdom window。
 */
/** 把 jsdom 的窗口铺到 globalThis —— bundle 顶层就在摸 window/document（scroll-dom:116-121 同款）。 */
function installGlobals(win) {
  globalThis.window = win
  globalThis.document = win.document
  globalThis.HTMLElement = win.HTMLElement
  globalThis.Element = win.Element
  globalThis.Node = win.Node
  globalThis.KeyboardEvent = win.KeyboardEvent
}

function loadRouteKey() {
  const bundlePath = new URL('../lib/client.js', import.meta.url)
  if (!existsSync(bundlePath)) return undefined
  try {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true })
    installGlobals(dom.window)
    let captured = null
    dom.window.__ModuleLoader__ = { load: (entry) => { captured = entry } }
    vm.runInThisContext(readFileSync(bundlePath, 'utf8'), { filename: 'client.js' })
    if (captured === null) throw new Error('bundle 没有调用 window.__ModuleLoader__.load')
    // bundle 顶层 require 这几个外部依赖。**本组不渲染 React**（只调 routeKey），
    // 但 factory() 执行期间会 require 它们，所以必须返回能用的桩 —— 抛异常会让整组 SKIP
    //（第一版就这么写的：8 条用例全 skip、0 pass，正是 pitfalls §2.7 说的「看起来在跑」）。
    const reactStub = new Proxy({}, { get: () => () => null })
    const requireFn = (specifier) => {
      if (specifier === 'react' || specifier === 'react/jsx-runtime' || specifier === 'react-dom/client') return reactStub
      if (specifier === 'cordis') return {}
      if (specifier.startsWith('@deepseek-ai/')) return {}
      throw new Error('未预期的外部依赖：' + specifier)
    }
    return captured.factory(requireFn).routeKey
  } catch (error) {
    console.warn('[keyboard-routing] bundle 加载失败，跳过本组：', error instanceof Error ? error.message : error)
    return undefined
  }
}

const routeKey = loadRouteKey()

/** 造一个记账用的假 store：只记被调了什么，不真的动数据。 */
function fakeStore(state = {}) {
  const calls = []
  const record = (name) => (...args) => { calls.push([name, ...args]) }
  const store = { calls, get: () => ({ view: 'list', navVisible: true, selectedId: 'a1', ...state }) }
  // routeKey 会碰到的全部动作（源码核对 src/client/store.ts:861-874 与 index.tsx:331-470）
  for (const name of [
    'selectRelative', 'stepArticle', 'moveNavCursor', 'openNavCursor', 'toggleNav', 'openSelected',
    'openArticle', 'closeArticle', 'toggleFeeds', 'refreshCount', 'setLayout', 'toggleStar',
    'toggleRead', 'markAllRead', 'markRead',
  ]) store[name] = record(name)
  return store
}

let dom = undefined
let win = undefined
let document_ = undefined

/** 每个用例一套 DOM：panelRoot 带可见性，scrollBox 是滚动容器。 */
function setupDom({ rectLength = 1, withScrollBox = true } = {}) {
  if (JSDOM === undefined) return undefined
  dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true })
  win = dom.window
  document_ = win.document
  installGlobals(win)
  const panelRoot = document_.createElement('div')
  panelRoot.getClientRects = () => new Array(rectLength)
  document_.body.appendChild(panelRoot)
  if (withScrollBox) {
    const box = document_.createElement('div')
    box.setAttribute('data-rss-scroll', 'list')
    box.getClientRects = () => new Array(1)
    panelRoot.appendChild(box)
  }
  return { panelRoot, win, document: document_ }
}

/** 一个够用的 KeyboardEvent 替身：只带 routeKey 读的那几个字段。 */
function keyEvent(key, over = {}) {
  return {
    key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false,
    target: document_.body, preventDefault() { this.defaultPrevented = true },
    ...over,
  }
}

/** 造 routeKey 的 ctx。over 可覆盖任一字段（root / expanded / helpOpen / store）。 */
function makeCtx(over = {}) {
  const setup = setupDom(over.dom ?? {})
  if (setup === undefined) return undefined
  const expandedCalls = []
  const helpCalls = []
  const ctx = {
    root: setup.panelRoot,
    store: over.store ?? fakeStore(over.state),
    expanded: over.expanded,
    setExpanded: (next) => expandedCalls.push(next),
    helpOpen: over.helpOpen ?? false,
    setHelpOpen: (next) => helpCalls.push(next),
    ...over.ctx,
  }
  return { ctx, store: ctx.store, expandedCalls, helpCalls, setup }
}

// 只有 jsdom 缺失才 skip —— 那是**环境能力**（依赖来自 dsh checkout，pitfalls §2.3 的既有处理）。
//
// ⚠️ routeKey 取不到**必须硬失败，不能 skip**（2026-10-15 独立评审实测：改成 skip 时，把 bundle
// 换成不导出 routeKey 的旧版 ⇒ pass 0 / skipped 8 / exit 0 —— 8 条判据全不跑而套件全绿）。
// 本文件是唯一能表达「守卫取反」的一层，它一 skip，8 条 Review Focus 同时失去全部判据，
// 而 gate 仍会报 0 幸存。取不到 routeKey 的真实原因只有两个：bundle 太旧（该 build:client）
// 或 re-export 被删了（那正是需要变红的事）。
if (routeKey === undefined) {
  throw new Error('[keyboard-routing] bundle 里没有 routeKey 导出：请跑 npm run build:client；' +
    '若 routeKey 真的被删了，那这条测试该红 —— 它不许静默跳过（docs/pitfalls.md §2.7）')
}

const skip = JSDOM === undefined

test('Review Focus 1：面板不在前台时一律不响应（getClientRects 为 0）', { skip }, () => {
  const h = makeCtx({ dom: { rectLength: 0 } })
  routeKeyOf('j', h)
  assert.deepEqual(h.store.calls, [], '不可见的面板不许响应按键（在对话里按 j 会动一个看不见的列表）')
})

test('Review Focus 2：输入框里的按键被 isTypingTarget 挡住', { skip }, () => {
  const h = makeCtx()
  const input = h.setup.document.createElement('input')
  h.setup.document.body.appendChild(input)
  // ⚠️ target 是**事件**的字段，走第三个参数（事件覆盖），不是 ctx 的 —— 首版写成
  // `{...h, ctx: {...h.ctx, target: input}}` 塞进了 ctx，事件侧仍是 body，于是守卫失效、用例翻红。
  routeKeyOf('j', h, { target: input })
  assert.deepEqual(h.store.calls, [], '输入框里打字不该触发列表移动')
})

test('Review Focus 5：修饰键与 defaultPrevented 一律不响应', { skip }, () => {
  for (const over of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { defaultPrevented: true }]) {
    const h = makeCtx()
    routeKeyOf('j', h, over)   // 修饰键在事件上，不在 ctx 上（同 Review Focus 2 的更正）
    assert.deepEqual(h.store.calls, [], JSON.stringify(over) + ' 时不该响应')
  }
})

test('Review Focus 6：正文视图里 o 与 u 被视图守卫挡住（背后那个看不见的列表）', { skip }, () => {
  for (const action of ['o', 'u']) {
    const h = makeCtx({ state: { view: 'article' } })
    routeKeyOf(action, h)
    assert.deepEqual(h.store.calls, [], '正文页按 ' + action + ' 不该动背后的列表（2026-10-06 实测缺陷）')
    assert.deepEqual(h.expandedCalls, [], '正文页按 o 不该改 expanded')
    assert.deepEqual(h.helpCalls, [])
  }
})

test('Review Focus 3：帮助浮窗开着时 Esc 只关帮助，不连带关文章', { skip }, () => {
  const h = makeCtx({ state: { view: 'article' }, helpOpen: true })
  routeKeyOf('Escape', h)
  assert.deepEqual(h.helpCalls, [false], 'Esc 先关帮助（用户拍板的三个关闭出口之一）')
  assert.ok(!h.store.calls.some(([name]) => name === 'closeArticle'), '不许连带关文章')
})

test('Review Focus 4：左栏折叠时导航键静默不响应', { skip }, () => {
  // 大写键值：浏览器里按 Shift+n 给的 event.key 是 'N'（keys.ts:41 'N'→navNext）。
  // ⚠️ 小写 'o' 不在这组里 —— 它是 **expand**（展开条目），而展开**不受 navVisible 约束**
  //   （原实现也没有：index.tsx:362 的 expand 只有 view 守卫）—— 左栏折叠与否与正文/列表里
  //   展开某一行无关。实测：折叠态下 N/P/O 三个导航键什么都不调，小写 o 照常 markRead。
  for (const key of ['Shift+N', 'Shift+P', 'Shift+O']) {
    const h = makeCtx({ state: { view: 'list', navVisible: false } })
    routeKeyOfNav(key, h)
    assert.deepEqual(h.store.calls, [], '折叠态下按 ' + key + ' 没有「导航里的位置」可动')
  }
})

test('j/k 按视图分流：列表页移动选中，正文页切文章', { skip }, () => {
  const list = makeCtx({ state: { view: 'list' } })
  routeKeyOf('j', list)
  assert.deepEqual(list.store.calls[0], ['selectRelative', 1], '列表页 j = 移动选中')

  const article = makeCtx({ state: { view: 'article' } })
  routeKeyOf('j', article)
  assert.deepEqual(article.store.calls[0], ['stepArticle', 1], '正文页 j = 下一条文章')
})

test('o 键在列表页翻转展开：已展开则收起，否则展开当前行并标已读', { skip }, () => {
  const opened = makeCtx({ state: { view: 'list', selectedId: 'a1' }, expanded: undefined })
  routeKeyOf('o', opened)
  assert.deepEqual(opened.expandedCalls, ['a1'], '首次按 o 展开当前行')
  assert.ok(opened.store.calls.some(([name]) => name === 'markRead'), '展开即标已读（GR 语义）')

  const closed = makeCtx({ state: { view: 'list', selectedId: 'a1' }, expanded: 'a1' })
  routeKeyOf('o', closed)
  assert.deepEqual(closed.expandedCalls, [undefined], '已展开则收起')
})

/* ==================== C4-b：候选清单「基线零覆盖」判定的收编（2026-10-16） ==================== */
/* 以下 7 条判定经反向变异复测（scripts/mutation-test.mjs --probes，今日 main）确认此前零覆盖；
 * 每条判定同步有正式守门变异（MUTATIONS 表 client-probe-* 条目）。offsetHeight 一类在
 * scroll-dom 的真 DOM 层表达（那里有真实布局桩），不在此文件。 */

test('C4-b 判定：弹层开着时按键被弹层守卫挡住（closest dialog/modal）', { skip }, () => {
  const h = makeCtx({})
  if (h === undefined) return
  // 弹层判定是「closest 到任一弹层角色」：把目标挂进一个 role=dialog 的容器。
  // ⚠️ 目标必须是**非输入元素**：若用 <input>，tagName===INPUT 那一层（同一判定的另一半）
  // 仍会挡住按键，closest 取反的变异照样全绿 —— 判据要钉的是 closest 这一半本体。
  const dialog = h.setup.document.createElement('div')
  dialog.setAttribute('role', 'dialog')
  const inner = h.setup.document.createElement('span')
  dialog.appendChild(inner)
  h.setup.document.body.appendChild(dialog)
  const ev = keyEvent('j', { target: inner })
  routeKey(ev, h.ctx)
  assert.deepEqual(h.store.calls, [], '弹层里的键不许漏到路由 —— closest 守卫取反时这条会红')
})

test('C4-b 判定：isContentEditable 的元素挡住按键', { skip }, () => {
  const h = makeCtx({})
  if (h === undefined) return
  const editable = h.setup.document.createElement('div')
  editable.isContentEditable = true
  h.setup.document.body.appendChild(editable)
  const ev = keyEvent('j', { target: editable })
  routeKey(ev, h.ctx)
  assert.deepEqual(h.store.calls, [], '可编辑区里的键不许触发动作（守卫取反时红）')
})

test('C4-b 判定：正文视图里 V/openArticle 被视图守卫挡住', { skip }, () => {
  const h = makeCtx({ state: { view: 'article' } })
  if (h === undefined) return
  routeKeyOf('V', h)
  assert.ok(!h.store.calls.some(([name]) => name === 'openArticle'), '正文页 V 不得再开正文（守卫删除时红）')
})

test('C4-b 判定：列表页按 1 切 expanded、按 2 切回 list（切错方向时红）', { skip }, () => {
  // 2026-10-18：此前只测了「正文页/订阅页不接管」那半边守卫，**没有一条断言看着列表页真的切了布局**
  // ⇒ 变异 'setLayout("expanded") → setLayout("list")' 长期幸存（scripts/mutation-test.mjs
  // 的 'client-1 键切展开视图'）。这里按方向钉：切成什么会被直接看见。
  const h = makeCtx({ state: { view: 'list' } })
  if (h === undefined) return
  routeKeyOf('1', h)
  assert.deepEqual(h.store.calls.filter(([name]) => name === 'setLayout'), [['setLayout', 'expanded']], '列表页按 1 必须切到 expanded')
  routeKeyOf('2', h)
  assert.deepEqual(h.store.calls.filter(([name]) => name === 'setLayout'), [['setLayout', 'expanded'], ['setLayout', 'list']], '按 2 必须切回 list')
})

test('C4-b 判定：expandedView/listView 只在列表页切布局（正文/订阅管理不接管）', { skip }, () => {
  const article = makeCtx({ state: { view: 'article' } })
  if (article === undefined) return
  routeKeyOf('1', article)
  assert.ok(!article.store.calls.some(([name]) => name === 'setLayout'), '正文页按 1 不得切背后的列表布局（守卫删除时红）')
  const feeds = makeCtx({ state: { view: 'feeds' } })
  if (feeds === undefined) return
  routeKeyOf('2', feeds)
  assert.ok(!feeds.store.calls.some(([name]) => name === 'setLayout'), '订阅管理页按 2 同样不得接管（守卫删除时红）')
})

test('C4-b 判定：订阅管理页按 Esc 不得穿透成 toggleFeeds', { skip }, () => {
  const h = makeCtx({ state: { view: 'feeds' } })
  if (h === undefined) return
  routeKeyOf('Escape', h)
  // 2026-10-10 裁决后的契约：订阅页按 Esc 是**显式动作**（toggleFeeds 收订阅页），
  // 不是 no-op —— 判据钉「它必须发生」；probe-Esc 订阅页 把该分支删掉时这条红。
  assert.ok(h.store.calls.some(([name]) => name === 'toggleFeeds'), '订阅页 Esc 必须收订阅页（分支删除时红）')
})

test('C4-b 判定：s 键星标动作真实接线（star 分支删除时整条红）', { skip }, () => {
  const h = makeCtx({})
  if (h === undefined) return
  routeKeyOf('s', h)
  assert.ok(h.store.calls.some(([name]) => name === 'toggleStar'), 'star case 必须接到 store.toggleStar（case 改名时红）')
})

/** 派发一次按键给 routeKey。over 可覆盖事件字段（如修饰键）。 */
function routeKeyOf(key, h, over = {}) {
  routeKey(keyEvent(key, { target: h.setup.document.body, ...over }), h.ctx)
}
function routeKeyOfNav(label, h) {
  // ⚠️ 浏览器里按 Shift+o 给的 event.key 是**大写 'O'** —— resolveReaderKey 收的是
  // 「已经带上 shift 的实际键值」，不是「小写 + shiftKey 标志」（首版传 'o'+shiftKey，
  // 于是它落到 case 'o' → 'expand'，折叠态那条断言就红了）。
  routeKey(keyEvent(label.replace('Shift+', ''), { target: h.setup.document.body }), h.ctx)
}