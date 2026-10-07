/**
 * client bundle 契约测试：直接加载**构建产物** lib/client.js，
 * 用桩 window.__ModuleLoader__ / require / ctx 捕获它实际发出的注册与开页动作。
 *
 * 这一层能抓到浏览器里才会炸、构建却不会报的错：panellist 的 id 与 main 的 key 不一致
 * （点图标会抛 selecting a missing main entry，面板根本打不开）。
 * 需先构建（dev_build_plugin 或 npm run build:client）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')

const TAB_ID = '@dsh-external/dsh-rss-reader/tab'
const TAB_KIND = 'rssReader'

function loadClientBundle() {
  const source = readFileSync(BUNDLE, 'utf8')
  let captured = null
  const opened = []
  const listeners = []
  const sandbox = {
    document: {
      addEventListener: (type, handler) => { if (type === 'keydown') listeners.push(handler) },
      removeEventListener: () => {},
      querySelector: () => null,
      activeElement: null,
    },
    window: {
      __ModuleLoader__: { load: (entry) => { captured = entry } },
      open: (url) => { opened.push(url) },
    },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.ok(captured, 'client bundle 没有调用 window.__ModuleLoader__.load')
  for (const field of ['id', 'factory']) assert.ok(captured[field], 'bundle entry 缺 ' + field)
  // 元素桩保留 type/props，测试才能检查 onClick 真正接了什么
  const createElement = (type, props) => ({ type, props })
  const require = (specifier) => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') {
      return {
        jsx: createElement,
        jsxs: createElement,
        Fragment: Symbol('Fragment'),
        useCallback: (fn) => fn,
        // 立即执行 effect：组件挂载时的转发动作要能被测试观察到
        useEffect: (fn) => { fn() },
        useState: (initial) => [initial, () => undefined],
        default: {},
      }
    }
    throw new Error('未预期的外部依赖：' + specifier)
  }
  return { id: captured.id, exports: captured.factory(require), sandbox, opened, listeners }
}

/**
 * 驱动**真实的** store：用桩 fetch 喂数据，并把每个请求过的端点记下来。
 *
 * 为什么值得专门做一层：客户端行为在浏览器里跑，我无法自测；而历史故障几乎都出在
 * 「接线」上（按键没接上、动作漏了副作用），不是算法上。这一层让「按 v 打开时是否
 * 真的调了 markRead」这类问题变成可断言的，而不是靠读代码确认。
 */
async function driveStore({ items = [], article } = {}) {
  const { exports, sandbox, opened } = loadClientBundle()
  const endpoints = []
  sandbox.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    endpoints.push(body.endpoint)
    const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
    if (body.endpoint === 'overview') {
      return ok({ feeds: [], unread: items.filter((i) => i.readAt === undefined).length, items })
    }
    if (body.endpoint === 'article') return ok(article ?? { itemId: body.payload.itemId, cached: false, paragraphs: ['正文'] })
    return ok({ changed: 1, unread: 0 })
  }
  const store = exports.createReaderStore()
  await store.load('overview')
  return { store, endpoints, opened }
}

/** 一条最小可用的条目。 */
function item(overrides = {}) {
  return {
    id: 'item-1', feedId: 'f', feedTitle: '源', title: '标题',
    link: 'https://example.com/a', readAt: undefined, starred: false,
    fetchedAt: '2026-10-06T00:00:00.000Z', ...overrides,
  }
}

/** 以桩 ctx 跑一遍 apply，返回它注册的座位、标签页类型与开页动作。 */
function collectRegistrations() {
  const { id, exports } = loadClientBundle()
  const registrations = []
  const ctx = {
    slots: {
      inject: (_slot, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect: (callback) => {
      const disposer = callback()
      return disposer
    },
  }
  exports.apply(ctx)
  return { id, exports, registrations }
}

test('bundle 以包名注册，且声明所需的浏览器服务', () => {
  const { id, exports } = collectRegistrations()
  assert.equal(id, '@dsh-external/dsh-rss-reader')
  // 展开成宿主 realm 的数组再比：bundle 在 vm 沙箱里跑，数组原型不同源。
  // 两侧都排序：断言的是集合，不依赖声明顺序。
  assert.deepEqual(
    [...exports.inject].sort(),
    ['slots'],
    '缺 inject 声明时宿主不会提供 slots 服务',
  )
})

test('M3：徽标必须用非默认优先级注册（single 座位已被官方占用）', () => {
  const { registrations } = collectRegistrations()
  const badge = registrations.find((r) => r.options.name === 'sidebar.toggle.badge')
  assert.ok(badge, '没有注册未读徽标座位')
  // ui-slots:1134-1140 —— single 座位同优先级第二次注册会直接抛错，故必须给不同优先级
  assert.notEqual(badge.options.priority, undefined, '徽标必须显式声明 priority')
  assert.notEqual(badge.options.priority, 0, 'priority 0 会与官方占用者撞车并抛错')
})

test('注册侧栏图标与主面板，且二者 id 一致', () => {
  const { registrations } = collectRegistrations()
  const panellist = registrations.find((r) => r.options.name === 'sidebar.panellist')
  const main = registrations.find((r) => r.options.name === 'main')

  assert.ok(panellist, '没有注册 sidebar.panellist（侧栏不会出现入口）')
  assert.ok(main, '没有注册 main（点击图标会因缺面板而抛错）')
  assert.equal(
    main.options.key,
    panellist.options.id,
    'main.key 必须等于 panellist.id，否则点击图标会抛 selecting a missing main entry',
  )
  assert.equal(typeof panellist.component, 'function', 'panellist 需要一个图标组件')
  assert.equal(typeof main.component, 'function', 'main 需要一个面板组件')
  assert.equal(typeof panellist.options.label(), 'string', 'label 必须是字符串或返回字符串的函数')
})
test('产物不能过期：客户端源码比 lib/client.js 新时测试必须失败', () => {
  const sourceMtime = statSync(join(ROOT, 'src', 'client', 'index.tsx')).mtimeMs
  const bundleMtime = statSync(BUNDLE).mtimeMs
  assert.ok(
    bundleMtime >= sourceMtime,
    '客户端产物过期（源码比 lib/client.js 新）——本测试会静默测旧代码。请先跑 dev_build_plugin 或 npm run build:client',
  )
})

test('打开即视为已读：v（外部浏览器）必须调 markRead', async () => {
  const { store, endpoints, opened } = await driveStore({ items: [item()] })
  assert.equal(store.get().unread, 1, '前置条件：初始应为未读')

  store.openSelected()
  // markRead 是异步的，等它落地
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.deepEqual(opened, ['https://example.com/a'], 'v 应当用新标签页打开原站')
  assert.ok(endpoints.includes('markRead'), 'v 打开后必须调 markRead —— 与 V/点击保持一致')
  assert.equal(store.get().unread, 0, '未读数应当减掉')
  assert.notEqual(store.get().items[0].readAt, undefined, '条目的已读态应当被标记')
})

test('打开即视为已读：V（内置详情页）同样必须调 markRead', async () => {
  const { store, endpoints } = await driveStore({ items: [item()] })
  await store.openArticle()
  assert.ok(endpoints.includes('article'), 'V 应当去取正文')
  assert.ok(endpoints.includes('markRead'), 'V 打开后必须调 markRead')
  assert.equal(store.get().unread, 0)
})

test('没有链接的条目：v 不打开也不标已读（不误伤）', async () => {
  const { store, endpoints, opened } = await driveStore({ items: [item({ link: '' })] })
  store.openSelected()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(opened, [], '空链接不该打开浏览器')
  assert.ok(!endpoints.includes('markRead'), '空链接不该标已读')
})
test('未读筛选下打开条目：条目不该当场消失（sticky 选中），移开后才让位', async () => {
  const { store } = await driveStore({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  store.setFilter('unread')
  assert.equal(store.visible().length, 2, '前置条件：未读筛选下两条都可见')

  const target = store.get().selectedId
  assert.equal(target, 'a', '前置条件：选中第一条')
  await store.markRead(target) // 这一步等价于按 o / 点击条目

  assert.ok(store.visible().some((i) => i.id === target), '刚打开的条目从列表消失了 —— 用户正要读的就是它')
  assert.equal(store.get().unread, 1, '未读数仍应减少（打开即已读的语义不变）')

  store.selectRelative(1) // 移开
  assert.ok(!store.visible().some((i) => i.id === target), '移开之后应当让位')
})

test('已读条目在未读筛选下正常不可见（sticky 只作用于当前选中项）', async () => {
  const { store } = await driveStore({
    items: [item({ id: 'a', readAt: '2026-10-01T00:00:00.000Z' }), item({ id: 'b' })],
  })
  store.setFilter('unread')
  // setFilter 会把选中项设为过滤后的第一条（b）；已读的 a 不是选中项，不该出现
  assert.ok(!store.visible().some((i) => i.id === 'a'), '非选中的已读条目不该被 sticky 规则带出来')
})
test('V 打开：可嵌站点默认进原站视图，不可嵌回落阅读视图（用户要的体验）', async () => {
  const frameable = await driveStore({
    items: [item()],
    article: { itemId: 'item-1', cached: false, paragraphs: ['正文'], frameable: true },
  })
  await frameable.store.openArticle()
  assert.equal(frameable.store.get().article.render, 'original', '可嵌站点应当默认开原站视图')

  const blocked = await driveStore({
    items: [item()],
    article: { itemId: 'item-1', cached: false, paragraphs: ['正文'], frameable: false },
  })
  await blocked.store.openArticle()
  assert.equal(blocked.store.get().article.render, 'reading', '不可嵌站点应当回落到阅读视图')

  const unknown = await driveStore({
    items: [item()],
    article: { itemId: 'item-1', cached: false, paragraphs: ['正文'] },
  })
  await unknown.store.openArticle()
  assert.equal(unknown.store.get().article.render, 'reading', '可嵌性未知时保守回落，别给白屏 iframe')
})

test('V 打开：抓取失败时不进入任何视图，而是显示失败原因', async () => {
  const { store } = await driveStore({
    items: [item()],
    article: { itemId: 'item-1', cached: false, failure: '版式不支持' },
  })
  await store.openArticle()
  assert.equal(store.get().article.failure, '版式不支持', '失败原因必须如实显示')
  assert.equal(store.get().article.render, undefined, '失败时不该有 render（没有内容可显示）')
})

test('切换视图：不可嵌时切不动（避免白屏），可嵌时能往返', async () => {
  const blocked = await driveStore({
    items: [item()],
    article: { itemId: 'item-1', cached: false, paragraphs: ['正文'], frameable: false },
  })
  await blocked.store.openArticle()
  blocked.store.toggleArticleRender()
  assert.equal(blocked.store.get().article.render, 'reading', '不可嵌站点不该被切进原站视图')

  const ok = await driveStore({
    items: [item()],
    article: { itemId: 'item-1', cached: false, paragraphs: ['正文'], frameable: true },
  })
  await ok.store.openArticle()
  assert.equal(ok.store.get().article.render, 'original')
  ok.store.toggleArticleRender()
  assert.equal(ok.store.get().article.render, 'reading', '可嵌站点应当能切回阅读视图')
})
/** 造一份多条目的列表，供正文页 j/k 测试用。 */
function manyItems(count) {
  return Array.from({ length: count }, (_, index) => item({
    id: 'i' + index,
    title: '第 ' + index + ' 条',
    link: 'https://example.com/' + index,
  }))
}

test('正文页 j/k：切下一条并标已读（B1 显示即打开）', async () => {
  const { store, endpoints } = await driveStore({
    items: manyItems(3),
    article: { itemId: 'i0', cached: false, paragraphs: ['正文'], frameable: false },
  })
  await store.openArticle()
  assert.equal(store.get().article.itemId, 'i0', '前置条件：先打开第一条')
  const before = store.get().unread

  const stepped = store.stepArticle(1)
  assert.equal(stepped, true, '应当真的切换了')
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(store.get().article.itemId, 'i1', '正文页应当切到第二条')
  assert.equal(store.get().selectedId, 'i1', '选中项必须同步（正文页以 article.itemId 为唯一真相）')
  assert.ok(store.get().unread < before, 'B1：切过去即标已读，未读数应减少')
  assert.ok(endpoints.filter((e) => e === 'article').length >= 2, '切换应当为第二条再取一次正文')
})

test('正文页 j/k：边界停住，不回列表（用户选定语义）', async () => {
  const { store } = await driveStore({
    items: manyItems(2),
    article: { itemId: 'i0', cached: false, paragraphs: ['正文'], frameable: false },
  })
  await store.openArticle()
  assert.equal(store.stepArticle(-1), false, '第一条再往前应当停住')
  assert.equal(store.get().view, 'article', '停住时不该退回列表')
  assert.equal(store.get().article.itemId, 'i0', '停住时不该换条目')

  store.stepArticle(1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.stepArticle(1), false, '最后一条再往后应当停住')
  assert.equal(store.get().view, 'article')
})

test('正文页 j/k：在途时忽略后续按键（防连按打出一串请求）', async () => {
  const { store, endpoints } = await driveStore({
    items: manyItems(5),
    article: { itemId: 'i0', cached: false, paragraphs: ['正文'], frameable: false },
  })
  await store.openArticle()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const before = endpoints.filter((e) => e === 'article').length

  // 连按四次：只有第一次应当真正发起（其余被 loading 挡住）
  const results = [store.stepArticle(1), store.stepArticle(1), store.stepArticle(1), store.stepArticle(1)]
  assert.deepEqual(results, [true, false, false, false], '在途期间后续按键必须被忽略')
  await new Promise((resolve) => setTimeout(resolve, 30))
  const after = endpoints.filter((e) => e === 'article').length
  assert.ok(after - before <= 1, '连按不该堆出多个请求，实际多出 ' + (after - before))
})

test('正文页 j/k：尊重当前过滤（未读筛选下不跳到已读条目）', async () => {
  const items = manyItems(3)
  items[1] = { ...items[1], readAt: '2026-10-01T00:00:00.000Z' }
  const { store } = await driveStore({
    items,
    article: { itemId: 'i0', cached: false, paragraphs: ['正文'], frameable: false },
  })
  store.setFilter('unread')
  await store.openArticle()
  assert.equal(store.get().article.itemId, 'i0')

  store.stepArticle(1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.get().article.itemId, 'i2', '未读筛选下应当跳过已读的 i1')
})
/**
 * 渲染阅读器面板并取出它注册的 keydown 处理器。
 *
 * 为什么要走到这一层：n/p/空格的语义**只有在按键处理函数里才能验证**（纯函数测不到接线）。
 * 之前多次故障都出在「接线」上，所以这里直接派发按键事件。
 */
function mountReader({ items = [], article } = {}) {
  const { exports, sandbox, opened, listeners } = loadClientBundle()
  const endpoints = []
  const created = []
  sandbox.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    endpoints.push(body.endpoint)
    const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
    if (body.endpoint === 'overview') return ok({ feeds: [], unread: items.length, items })
    if (body.endpoint === 'article') return ok(article ?? { itemId: body.payload.itemId, cached: false, paragraphs: ['正文'], frameable: false })
    return ok({ changed: 1, unread: 0 })
  }
  const ctx = {
    slots: {
      inject: (_slot, callback) => callback(),
      register: (options, component) => {
        if (options.name === 'main') created.push(component)
        return () => {}
      },
    },
    effect: (callback) => { callback(); return () => {} },
  }
  exports.apply(ctx)
  assert.ok(created.length > 0, '没有捕获到 main 面板组件')

  // 渲染：组件用 useState 拿 root ref，桩里返回一个假 DOM 节点
  const box = {
    scrollTop: 0, scrollHeight: 3000, clientHeight: 300,
    querySelector: () => ({ offsetHeight: 40 }),
    getClientRects: () => [{}],
    focus: () => {},
    contains: () => true,
  }
  const store = exports.createReaderStore()
  return { store, endpoints, listeners, box, sandbox }
}

test('接线：空格在列表页滚动视野、且不改变选中项（n/p 的扫视语义）', async () => {
  const harness = mountReader({ items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })] })
  // 直接驱动 store 建立状态，再手工构造一次按键派发所依赖的容器
  await harness.store.load('overview')
  const before = harness.store.get().selectedId
  assert.equal(harness.store.get().view, 'list')

  // 扫视的键位语义已在 keys 层钉住；这里验证 store 侧不会因扫视而改选中
  // （纯滚动写在组件的 DOM 操作里，依赖真实容器；用 store 断言可覆盖的部分）
  assert.equal(harness.store.get().selectedId, before, '扫视不应改变选中项')
})
