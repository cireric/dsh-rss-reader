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
  const sandbox = {
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
  return { id: captured.id, exports: captured.factory(require), sandbox, opened }
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
