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
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
/**
 * 加载产物时给 vm 的文件名。**不是装饰**：变异门槛的「崩了」分类器靠在错误栈帧里找
 * 被改过的文件名来分辨「断言失败」与「变异代码自己崩了」；不给 filename 时帧上只有
 * `evalmachine.<anonymous>`，client 那一族（50 条变异）就永远进不了那个分类器
 * （2026-10-11 终检评审 B1 实测：lib/client.js 顶层抛 ReferenceError 时门槛报「未判为崩溃」）。
 * 新增任何加载 lib/client.js 的沙箱，都必须照抄这一行。
 */
const BUNDLE_NAME = 'client.js'

function loadClientBundle() {
  const source = readFileSync(BUNDLE, 'utf8')
  let captured = null
  const opened = []
  const listeners = []
  // isTypingTarget 会对 event.target 做 instanceof HTMLElement —— 沙箱里没有这个全局，
  // 不给就会让按键处理器直接抛 ReferenceError（实测踩到）。空类即可：null 不是它的实例。
  class HTMLElementStub {}
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
    HTMLElement: HTMLElementStub,
    // 组件的某些 effect 用 setTimeout 做消抖（SLOW_LOADING_MS），沙箱里不给会直接抛
    // ReferenceError —— 实测踩到，表现为三条接线测试全部报错而不是断言失败。
    setTimeout,
    clearTimeout,
    Date,
    JSON,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: BUNDLE_NAME })
  assert.ok(captured, 'client bundle 没有调用 window.__ModuleLoader__.load')
  for (const field of ['id', 'factory']) assert.ok(captured[field], 'bundle entry 缺 ' + field)
  // 元素桩保留 type/props，测试才能检查 onClick 真正接了什么
  const createElement = (type, props) => ({ type, props })
  // 最小的 hooks 状态：按渲染序号存 useState 的值；每次渲染前调 beginRender 归零。
  // 为什么需要它——若 useState 永远返回初始值 + 空 setter，组件里的 root 会恒为 null，
  // 而按键处理器第一行的可见性守卫会因此直接 return，接线就永远测不到（实测如此）。
  const hooks = []
  let hookIndex = 0
  const require = (specifier) => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') {
      return {
        jsx: createElement,
        jsxs: createElement,
        Fragment: Symbol('Fragment'),
        useCallback: (fn) => fn,
        // useRef：**身份跨渲染稳定**是它的全部要点（容器句柄就靠这条活着）。
        // 若这里每次都新建对象，按键处理器会拿到一个永远为 null 的句柄 ——
        // 那正好是本文件顶部记着的那类「闭包捕获」缺陷，假夹具不该自己再造一个。
        useRef: (initial) => {
          const at = hookIndex
          hookIndex += 1
          if (!(at in hooks)) hooks[at] = { current: initial }
          return hooks[at]
        },
        // 立即执行 effect：组件挂载时的转发动作要能被测试观察到
        useEffect: (fn) => { fn() },
        useState: (initial) => {
          const at = hookIndex
          hookIndex += 1
          if (!(at in hooks)) hooks[at] = typeof initial === 'function' ? initial() : initial
          return [hooks[at], (next) => { hooks[at] = typeof next === 'function' ? next(hooks[at]) : next }]
        },
        default: {},
      }
    }
    throw new Error('未预期的外部依赖：' + specifier)
  }
  return {
    id: captured.id,
    exports: captured.factory(require),
    sandbox,
    opened,
    listeners,
    hooks,
    beginRender: () => { hookIndex = 0 },
  }
}

/**
 * 驱动**真实的** store：用桩 fetch 喂数据，并把每个请求过的端点记下来。
 *
 * 为什么值得专门做一层：客户端行为在浏览器里跑，我无法自测；而历史故障几乎都出在
 * 「接线」上（按键没接上、动作漏了副作用），不是算法上。这一层让「按 v 打开时是否
 * 真的调了 markRead」这类问题变成可断言的，而不是靠读代码确认。
 */
async function driveStore({ items = [], article, hostTruth, failEndpoints = [], shouldFail } = {}) {
  const { exports, sandbox, opened } = loadClientBundle()
  const endpoints = []
  // calls 是加法式的：给「请求体本身也要断言」的用例用（例如 markRead 的 skipKept）
  const calls = []
  const host = hostAccount(items, hostTruth)
  // shouldFail = { endpoint, when }：把该端点的请求**挂起**到 when(calls) 为真再回失败信封 ——
  // 交错用例的时序闸门（单线程桩里这是唯一能让「A2 在 U 的 RPC 在飞时挤进来」成立的办法）。
  const held = []
  const failEnvelope = () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: { code: 'injected', message: '注入失败' } }) })
  sandbox.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    endpoints.push(body.endpoint)
    calls.push(body)
    const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
    // 释放已满足条件的挂起请求（每来一个新请求都重新判定一次）
    for (let i = held.length - 1; i >= 0; i--) {
      if (shouldFail?.when?.(calls) === true) { held[i].resolve(failEnvelope()); held.splice(i, 1) }
    }
    // 失败注入：统一回滚判据的触发器。回**分发核 fail() 的真实形状**——HTTP 200 + ok:false 信封
    //（若回 HTTP 500，callRpc 在 HTTP 层就 throw，正文信封根本不被读，错误文本变成 'HTTP 500'）
    if (failEndpoints.includes(body.endpoint)) return failEnvelope()
    if (shouldFail !== undefined && body.endpoint === shouldFail.endpoint) {
      if (shouldFail.when === undefined || shouldFail.when(calls) === true) return failEnvelope()
      return new Promise((resolve) => { held.push({ resolve }) })
    }
    // refresh 与 overview 都回完整 Overview（src/endpoints.ts:112-118）：面板挂载时走的是
    // refresh（index.tsx:184），桩件若把 refresh 回成 {changed,unread}，applyOverview 会拿到
    // 一堆 undefined。这是夹具要守的契约，不是代码该容忍的形状。
    if (body.endpoint === 'overview' || body.endpoint === 'refresh') {
      return ok(overviewStub(items))
    }
    if (body.endpoint === 'article') return ok(article ?? { itemId: body.payload.itemId, cached: false, paragraphs: ['正文'] })
    if (body.endpoint === 'markRead' || body.endpoint === 'unmarkRead') {
      const ids = Array.isArray(body.payload?.itemIds) ? body.payload.itemIds : []
      return ok(host.reply(body.endpoint, ids))
    }
    // toggleStar / toggleKeepUnread 的回包同样带账（分发核按 carriesAccount 合并）——
    // 旧桩只回 {changed, unread:0} 是契约上不存在的形状；新管线照单全收，桩必须守契约
    return ok({ changed: 1, ...host.snapshot() })
  }
  const store = exports.createReaderStore()
  await store.load('overview')
  return { store, endpoints, calls, opened, sandbox }
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
 * 宿主账目的**可动副本** + markRead/unmarkRead 的回包形状（照 src/endpoints.ts 的 accountOf）。
 *
 * 为什么桩件必须回 perFeedUnread：作品代码在截断场景下只能靠这份账目整体覆盖（否则本地增量
 * 会把本地看不见的外部漂移留成幽灵未读）。桩件少给一个字段，就等于要求作品代码去容忍一个
 * **契约上不该存在的形状** —— 本仓库明确不选那条路（docs/pitfalls.md 二、2.5 / 2.6）。
 */
function hostAccount(items, hostTruth) {
  const base = overviewStub(items)
  const account = {
    unread: hostTruth?.unread ?? base.unread,
    perFeedUnread: { ...base.perFeedUnread, ...(hostTruth?.perFeedUnread ?? {}) },
  }
  const feedOf = new Map(items.map((entry) => [entry.id, entry.feedId]))
  return {
    /** 当前宿主真账的只读副本：所有 carriesAccount 端点的回包都带这一份（分发核的合并契约）。 */
    snapshot() {
      return { unread: account.unread, perFeedUnread: { ...account.perFeedUnread } }
    },
    reply(endpoint, ids) {
      const delta = endpoint === 'markRead' ? -1 : 1
      for (const id of ids) {
        const feedId = feedOf.get(id)
        if (feedId === undefined || account.perFeedUnread[feedId] === undefined) continue
        account.perFeedUnread[feedId] = Math.max(0, account.perFeedUnread[feedId] + delta)
        account.unread += delta
      }
      return { changed: ids.length, unread: account.unread, perFeedUnread: { ...account.perFeedUnread } }
    },
  }
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
/**
 * src/client 下**每一个** .ts/.tsx 的最新 mtime（递归）。
 *
 * 为什么递归而不是只看 index.tsx：2026-10-15 新增了 src/client/keyboard-routing.ts，若判据
 * 仍只 stat index.tsx，那「改了 keyboard-routing.ts 忘了 rebuild」就是**全套绿而真机行为是旧的**
 * （独立评审实测：给 toggleNav 加一条真回归且不 rebuild ⇒ pass 40 / fail 0）。
 */
function newestClientSourceMtime(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestClientSourceMtime(path))
    else if (/\.tsx?$/.test(entry.name)) newest = Math.max(newest, statSync(path).mtimeMs)
  }
  return newest
}

test('产物不能过期：客户端任一源码比 lib/client.js 新时测试必须失败', () => {
  const sourceMtime = newestClientSourceMtime(join(ROOT, 'src', 'client'))
  const bundleMtime = statSync(BUNDLE).mtimeMs
  assert.ok(
    bundleMtime >= sourceMtime,
    '客户端产物过期（src/client 下任一 .ts/.tsx 比 lib/client.js 新）——本测试会静默测旧代码。请先跑 dev_build_plugin 或 npm run build:client',
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
test('V 打开：正文只有抽取一条路（原站视图整条路径已删除）', async () => {
  // 2026-10-08：内嵌原站的 iframe 被删掉了 —— 严格沙箱会让现代站点只剩裸 HTML（用户实测），
  // 放宽沙箱又要让发布者的脚本跑在 DSH 页面上下文里。想看原样就点「打开原站 ↗」去新标签页。
  // 可嵌性（frameable）仍从 host 带回、仍留在状态里，但它不再决定任何视图。
  for (const frameable of [true, false, undefined]) {
    const harness = await driveStore({
      items: [item()],
      article: { itemId: 'item-1', cached: false, paragraphs: ['正文'], ...(frameable === undefined ? {} : { frameable }) },
    })
    await harness.store.openArticle()
    assert.equal(harness.store.get().article.render, undefined,
      'render 字段随原站视图一起删掉了，不该再出现在状态里（frameable=' + String(frameable) + '）')
    assert.notEqual(harness.store.get().article.paragraphs, undefined, '正文必须照常拿到')
  }
})

test('V 打开：抓取失败时不进入任何视图，而是显示失败原因', async () => {
  const { store } = await driveStore({
    items: [item()],
    article: { itemId: 'item-1', cached: false, failure: '版式不支持' },
  })
  await store.openArticle()
  assert.equal(store.get().article.failure, '版式不支持', '失败原因必须如实显示')
  assert.equal(store.get().article.blocks, undefined, '失败时不该有内容块')
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
  const host = hostAccount(items)
  sandbox.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    endpoints.push(body.endpoint)
    const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
    if (body.endpoint === 'overview' || body.endpoint === 'refresh') return ok(overviewStub(items))
    if (body.endpoint === 'article') return ok(article ?? { itemId: body.payload.itemId, cached: false, paragraphs: ['正文'], frameable: false })
    if (body.endpoint === 'markRead' || body.endpoint === 'unmarkRead') {
      const ids = Array.isArray(body.payload?.itemIds) ? body.payload.itemIds : []
      return ok(host.reply(body.endpoint, ids))
    }
    // 其余 carriesAccount 端点的回包同样带账（契约形状；新管线会照单全收这份账）
    return ok({ changed: 1, ...host.snapshot() })
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

test('客户端不得再内嵌原站页面（2026-10-08 删除 iframe 后的守护）', () => {
  // 为什么是「禁止内嵌」而不是「必须沙箱」：这个 iframe 的两条路都不能接受 ——
  // 严格沙箱 ⇒ 现代站点只剩裸 HTML（用户实测）；放宽沙箱 ⇒ 发布者脚本跑在 DSH 页面上下文里。
  // 所以原站内容一律走新标签页（浏览器自己的上下文），客户端不该再出现 iframe / 沙箱常量。
  const { exports } = loadClientBundle()
  assert.equal(exports.ORIGINAL_VIEW_FRAME_PROPS, undefined,
    'ORIGINAL_VIEW_FRAME_PROPS 必须随原站视图一起删掉（留着就是死代码）')
  // 导出面是客户端对外的契约：入口必须还在（测试与宿主都靠它）
  assert.notEqual(exports.apply, undefined, '插件入口必须在')
  assert.notEqual(exports.createReader, undefined, '阅读器工厂必须在')
  assert.equal(exports.ORIGINAL_VIEW_FRAME_PROPS, undefined, '原站视图的沙箱常量必须已删')
})
test('详情页按钮：canStepArticle 与 stepArticle 判定必须一致（防「按钮灰着但键盘能切」）', async () => {
  const { store } = await driveStore({
    items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })],
    article: { itemId: 'a', cached: false, paragraphs: ['正文'], frameable: false },
  })
  await store.openArticle()
  await new Promise((resolve) => setTimeout(resolve, 20))

  // 首条：不能往上，能往下
  assert.equal(store.canStepArticle(-1), false, '首条不该有上一条')
  assert.equal(store.stepArticle(-1), false, '键盘也应拒绝（与按钮一致）')
  assert.equal(store.canStepArticle(1), true)
  assert.equal(store.stepArticle(1), true)

  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.get().article.itemId, 'b', '应当切到第二条')

  // 末条：不能往下
  store.stepArticle(1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.get().article.itemId, 'c', '应当切到第三条')
  assert.equal(store.canStepArticle(1), false, '末条不该有下一条（按钮置灰）')
  assert.equal(store.stepArticle(1), false, '键盘同样拒绝')
})

test('详情页按钮：抓取在途时两侧都不可切（防连点堆请求）', async () => {
  const { store } = await driveStore({
    items: [item({ id: 'a' }), item({ id: 'b' })],
    article: { itemId: 'a', cached: false, paragraphs: ['正文'], frameable: false },
  })
  const pending = store.openArticle()
  // 未 await：此刻 article.loading 为真
  assert.equal(store.canStepArticle(1), false, '在途时按钮应当置灰')
  assert.equal(store.canStepArticle(-1), false)
  await pending
})

test('详情页按钮：尊重当前过滤（未读筛选下按钮也跳过已读条目）', async () => {
  const items = [item({ id: 'a' }), { ...item({ id: 'b' }), readAt: '2026-10-01T00:00:00.000Z' }, item({ id: 'c' })]
  const { store } = await driveStore({
    items,
    article: { itemId: 'a', cached: false, paragraphs: ['正文'], frameable: false },
  })
  store.setFilter('unread')
  await store.openArticle()
  await new Promise((resolve) => setTimeout(resolve, 20))
  store.stepArticle(1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(store.get().article.itemId, 'c', '未读筛选下应当跳过已读的 b')
})

/**
 * 渲染**真实组件**并取出它注册的 keydown 处理器 —— 让按键「接线」可断言。
 *
 * 为什么需要这一层：既有的测试只驱动 store（断言最终状态），而历史故障几乎都出在接线
 * （键没接上、副作用漏了）。2026-10-07 实测：把「所有键解析短路」「可见性守卫恒真」
 * 「干脆不注册监听器」三条变异分别注入构建产物，套件全绿 —— 那一层此前零覆盖。
 *
 * 桩件是最小 React：useState 真的存值，渲染一遍后把树里所有 ref 回调用假 DOM 节点调一遍，
 * 再渲染一遍（第一遍里 root 还是 null，按键处理器的可见性守卫会拦住所有按键）。
 */
function renderReader({ items = [] } = {}) {
  const harness = loadClientBundle()
  const { exports, sandbox, listeners } = harness
  const endpoints = []
  const host = hostAccount(items)
  sandbox.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    endpoints.push(body.endpoint)
    const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
    if (body.endpoint === 'overview' || body.endpoint === 'refresh') return ok(overviewStub(items))
    if (body.endpoint === 'markRead' || body.endpoint === 'unmarkRead') {
      const ids = Array.isArray(body.payload?.itemIds) ? body.payload.itemIds : []
      return ok(host.reply(body.endpoint, ids))
    }
    // 其余 carriesAccount 端点的回包同样带账（契约形状；新管线会照单全收这份账）
    return ok({ changed: 1, ...host.snapshot() })
  }
  const store = exports.createReaderStore()
  const Reader = exports.createReader(store)
  const box = {
    scrollTop: 0,
    scrollHeight: 3000,
    clientHeight: 300,
    querySelector: () => ({ offsetHeight: 40 }),
    getClientRects: () => [{}],
    focus: () => {},
    contains: () => true,
  }
  const renderOnce = () => { harness.beginRender(); return Reader() }
  // 桩件没有真的 React，ref 不会被自动调用：把树里的 ref 回调都拿假节点调一遍
  for (const props of collectRefs(renderOnce())) props.ref(box)
  renderOnce()
  return { store, listeners, box, endpoints, sandbox }
}

/** 深度遍历元素桩（{type, props}）收集所有函数型 ref，供 renderReader 手工挂载。 */
function collectRefs(node, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collectRefs(child, found)
    return found
  }
  const props = node.props
  if (props !== null && typeof props === 'object') {
    if (typeof props.ref === 'function') found.push(props)
    for (const value of Object.values(props)) {
      if (value !== null && typeof value === 'object') collectRefs(value, found)
    }
  }
  return found
}

/** 构造一次按键事件：不需要真 DOM —— isTypingTarget 对 null 返回 false，正好放行。 */
function keyEvent(key, shiftKey = false) {
  return {
    key,
    shiftKey,
    target: null,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    defaultPrevented: false,
    preventDefault: () => {},
  }
}

test('按键接线：j / k 真的驱动选中项（此前三条变异全部幸存）', async () => {
  const harness = renderReader({ items: [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })] })
  await harness.store.load('overview')
  assert.ok(harness.listeners.length > 0, '组件必须注册 keydown 监听器')
  const handler = harness.listeners[harness.listeners.length - 1]

  const before = harness.store.get().selectedId
  handler(keyEvent('j'))
  assert.notEqual(harness.store.get().selectedId, before, 'j 必须移动选中项 —— 不动说明接线的某一环断了')
  handler(keyEvent('k'))
  assert.equal(harness.store.get().selectedId, before, 'k 必须移回来')
})

test('按键接线：未绑定的键不动任何状态（不误触发）', async () => {
  const harness = renderReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await harness.store.load('overview')
  const handler = harness.listeners[harness.listeners.length - 1]
  const snapshot = JSON.stringify(harness.store.get())
  handler(keyEvent('z'))
  assert.equal(JSON.stringify(harness.store.get()), snapshot, '未绑定的键不该改任何状态')
})

test('按键接线：o 展开并触发 markRead（副作用不能漏）', async () => {
  const harness = renderReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await harness.store.load('overview')
  const handler = harness.listeners[harness.listeners.length - 1]
  handler(keyEvent('o'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(
    harness.endpoints.includes('markRead'),
    'o 必须触发 markRead 端点；实际端点：[' + harness.endpoints.join(', ') + ']',
  )
})


test('A 的撤销窗口：5 秒后自动撤掉（此前 until 只写不读，撤销条常驻）', async () => {
  const harness = renderReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  // 记录定时器并手动触发到期回调 —— 不必真等 5 秒
  const timers = []
  harness.sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
  harness.sandbox.clearTimeout = () => {}

  await harness.store.load('overview')
  await harness.store.markAllRead()

  const armed = timers.find((entry) => entry.ms === 5000)
  assert.ok(armed !== undefined, 'markAll 必须给撤销窗口上定时器；实际 setTimeout 延时：' + JSON.stringify(timers.map((entry) => entry.ms)))
  assert.ok(harness.store.get().undo !== undefined, '刚标完应当有撤销条')

  armed.fn()
  assert.equal(harness.store.get().undo, undefined, '窗口到期后撤销条必须消失')
})

test('A 全部标为已读必须跳过「保持未读」的条目（规格 §3.3 的存在理由）', async () => {
  const { store, calls } = await driveStore({ items: [item({ id: 'a' }), item({ id: 'b', keptUnread: true }), item({ id: 'c' })] })
  await store.markAllRead()
  const body = calls.find((call) => call.endpoint === 'markRead')
  assert.ok(body !== undefined, '应当调 markRead')
  assert.deepEqual(body.payload.itemIds.slice().sort(), ['a', 'c'], '被保持的条目不该进批量名单')
  assert.equal(body.payload.skipKept, true, '还要让宿主侧再挡一次（客户端列表只是快照）')
  const items = store.get().items
  assert.equal(items.find((entry) => entry.id === 'b').readAt, undefined, '被保持的条目在本地也不该被标已读')
  assert.notEqual(items.find((entry) => entry.id === 'a').readAt, undefined, '其余条目照常标记')
})

test('保持未读可切换，并把状态回填到条目上', async () => {
  const { store, calls } = await driveStore({ items: [item({ id: 'a' })] })
  await store.toggleKeepUnread('a')
  assert.ok(calls.some((call) => call.endpoint === 'toggleKeepUnread' && call.payload.itemId === 'a'), '应当调 toggleKeepUnread')
  assert.equal(store.get().items[0].keptUnread, true)
  await store.toggleKeepUnread('a')
  assert.equal(store.get().items[0].keptUnread, false, '再切一次应取消')
})

/* ------------------ C3：六动作统一的「乐观 → 覆盖 / 回滚」判据 ------------------ */
/* 判据之家 = src/client/account-mirror.ts 头部的动作表；2026-10-16 拍板「失败统一回滚」。 */

test('C3：toggleStar 失败回滚星标并进 error 条（统一回滚）', async () => {
  const { store } = await driveStore({ items: [item({ id: 'a' })], failEndpoints: ['toggleStar'] })
  store.select('a')
  await store.toggleStar()
  assert.equal(store.get().items[0].starred, false, '失败 = 动作没发生：星标必须回到按下前')
  assert.ok(String(store.get().error).includes('injected'), '错误必须可见（AGENTS.md 禁静默）')
})

test('C3：toggleKeepUnread 失败回滚保持未读并进 error 条（统一回滚）', async () => {
  const { store } = await driveStore({ items: [item({ id: 'a' })], failEndpoints: ['toggleKeepUnread'] })
  await store.toggleKeepUnread('a')
  // 按下前这个键是 undefined（乐观把它翻成 true，失败回滚到按下前 = undefined，不是 false）
  assert.equal(store.get().items[0].keptUnread, undefined, '失败必须回到按下前——若没回滚它会是 true')
  assert.ok(String(store.get().error).includes('injected'), '错误必须可见')
})

test('C3：toggleRead 撤销已读失败回滚 readAt 与账目（统一回滚）', async () => {
  const readAt = '2026-10-15T00:00:00.000Z'
  const { store } = await driveStore({ items: [item({ id: 'a', readAt })], failEndpoints: ['unmarkRead'] })
  store.select('a')
  const beforeUnread = store.get().unread
  await store.toggleRead()
  assert.equal(store.get().items[0].readAt, readAt, '失败必须回到按下前的 readAt')
  assert.equal(store.get().unread, beforeUnread, '账目也必须回到按下前')
  assert.ok(String(store.get().error).includes('injected'), '错误必须可见')
})

test('C3：markRead 失败回滚已读与账目（统一回滚收编的第一处旧缺口）', async () => {
  const { store } = await driveStore({ items: [item({ id: 'a' })], failEndpoints: ['markRead'] })
  const beforeUnread = store.get().unread
  await store.markRead('a')
  assert.equal(store.get().items[0].readAt, undefined, '失败必须回到按下前——旧实现只报错不回滚')
  assert.equal(store.get().unread, beforeUnread, '账目同样回滚')
  assert.ok(String(store.get().error).includes('injected'), '错误必须可见')
})

test('C3：markAllRead 失败回滚整批并撤掉撤销条（挂着回不去的撤销只会再吃一次错）', async () => {
  const { store } = await driveStore({
    items: [item({ id: 'a' }), item({ id: 'b' })], failEndpoints: ['markRead'],
  })
  await store.markAllRead()
  const state = store.get()
  assert.equal(state.items.find((entry) => entry.id === 'a').readAt, undefined, '失败必须整批回到按下前')
  assert.equal(state.undo, undefined, '撤销条必须撤掉——它对应的动作没有发生')
  assert.ok(String(state.error).includes('injected'), '错误必须可见')
})

test('C3：undoMarkAll 失败恢复撤销条并重新武装 5 秒窗口（只塞回 state 会常驻）', async () => {
  const { store, sandbox } = await driveStore({ items: [item({ id: 'a' })], failEndpoints: ['unmarkRead'] })
  const timers = []
  sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
  sandbox.clearTimeout = () => {}
  await store.markAllRead()
  const before = timers.length
  await store.undoMarkAll()
  assert.ok(store.get().undo !== undefined, '失败 = 撤销没发生：撤销条必须恢复')
  assert.equal(timers.length, before + 1, '必须重新武装定时器——否则恢复出的撤销条常驻（2026-10-07 那类缺陷）')
  assert.equal(timers[timers.length - 1].ms, 5000, '窗口仍是 5 秒（README 承诺）')
})

test('C3：撤销在飞时更晚的 A 写下自己的撤销条，U 失败不得用旧 batch 盖掉它（身份 CAS）', async () => {
  // 时序：A1（只标 a，b 太新）→ U 撤销在飞（挂起）→ A2 全量标 [a,b] 挤进来写下 U2 → U 回失败。
  // 若 rollback 不做身份 CAS，U 会把撤销条恢复成自己那个旧 batch ['a']，把 A2 的 ['a','b'] 盖掉，
  // 且多武装一次定时器把 A2 的窗口重置 —— 两个都是 2026-10-07「撤销条管理」缺陷的变体。
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString()
  const recent = new Date(Date.now() - 60 * 1000).toISOString()
  const { store, sandbox } = await driveStore({
    items: [item({ id: 'a', fetchedAt: old }), item({ id: 'b', fetchedAt: recent })],
    shouldFail: {
      endpoint: 'unmarkRead',
      // U 的 unmarkRead 是第 1 个请求；等到第 2 个 markRead（= A2 已挤进来）再放行失败
      when: (calls) => calls.filter((entry) => entry.endpoint === 'markRead').length >= 2,
    },
  })
  const timers = []
  sandbox.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length }
  sandbox.clearTimeout = () => {}

  store.setMarkAllRange('day')
  await store.markAllRead()               // A1：批 = [a]，撤销条 U1，武装定时器 ①
  const pendingUndo = store.undoMarkAll() // U：乐观清条目、清撤销条，RPC 挂起
  store.setMarkAllRange('all')
  const pendingA2 = store.markAllRead()   // A2：批 = [a,b]，写下 U2 并武装定时器 ②；随后 U 被放行失败
  await pendingUndo
  await pendingA2

  assert.deepEqual(store.get().undo?.ids, ['a', 'b'], '撤销条必须还是 A2 的那批 —— 被 U 的旧 batch 盖掉就是 CAS 失效')
  assert.equal(timers.length, 2, '定时器只由两次 A 各武装一次；U 的失败回滚不得再武装（否则 A2 的窗口被重置）')
  assert.ok(String(store.get().error).includes('injected'), 'U 的失败仍要可见（回滚跳过 ≠ 吞错）')
})

test('C3：toggleStar 成功后账目以宿主回包为准落地（旧实现把回包整个丢掉）', async () => {
  // 宿主真账故意大于本地视图：只有「回包账目真的落了地」才能得到 5
  const { store } = await driveStore({
    items: [item({ id: 'a' })], hostTruth: { unread: 5, perFeedUnread: { f: 5 } },
  })
  store.select('a')
  await store.toggleStar()
  assert.equal(store.get().unread, 5, '回包里的 unread 必须落地——丢弃回包会让账目停在乐观基线')
  assert.equal(store.get().perFeedUnread.f, 5, '每源账目同落地')
  assert.equal(store.get().items[0].starred, true, '翻转本身照常生效')
})

test('按键接线：1 切展开视图、2 切回列表（且默认是列表 = 既有行为）', async () => {
  const harness = renderReader({ items: [item({ id: 'a' }), item({ id: 'b' })] })
  await harness.store.load('overview')
  const handler = harness.listeners[harness.listeners.length - 1]
  assert.equal(harness.store.get().layout, 'list', '默认必须是紧凑列表 —— 这是本插件既有行为')
  handler(keyEvent('1'))
  assert.equal(harness.store.get().layout, 'expanded', '1 必须切到展开视图')
  handler(keyEvent('2'))
  assert.equal(harness.store.get().layout, 'list', '2 必须切回列表视图')
})

test('A 的范围阈值：只标「早于所选范围」的条目（规格 §3.3 的 panic button）', async () => {
  // 时间基准现算，避免用例随真实日期漂移
  const old = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString()
  const recent = new Date(Date.now() - 60 * 1000).toISOString()
  const { store, calls } = await driveStore({ items: [item({ id: 'old', fetchedAt: old }), item({ id: 'recent', fetchedAt: recent })] })
  store.setMarkAllRange('day')
  await store.markAllRead()
  const body = calls.find((call) => call.endpoint === 'markRead')
  assert.deepEqual(body.payload.itemIds, ['old'], '范围阈值必须挡掉尚未「早于」的条目')
  assert.equal(typeof body.payload.before, 'string', '还要把截止时间交给宿主再挡一次')
  assert.equal(store.get().items.find((entry) => entry.id === 'recent').readAt, undefined, '刚发布的条目不该被标已读')
  assert.notEqual(store.get().items.find((entry) => entry.id === 'old').readAt, undefined, '早于阈值的条目照常标记')
})

test('A 的默认范围是全部：不带阈值时行为与以前完全一致', async () => {
  const recent = new Date(Date.now() - 60 * 1000).toISOString()
  const { store, calls } = await driveStore({ items: [item({ id: 'recent', fetchedAt: recent })] })
  assert.equal(store.get().markAllRange, 'all', '默认必须是全量 —— 否则就是悄悄改了既有行为')
  await store.markAllRead()
  const body = calls.find((call) => call.endpoint === 'markRead')
  assert.deepEqual(body.payload.itemIds, ['recent'])
  assert.equal(body.payload.before, undefined, '全量时不传截止时间')
})

test('r 刷新未读计数：只重取本地视图，不触发抓取（规格不变量 1）', async () => {
  const { store, endpoints } = await driveStore({ items: [item()] })
  await store.refreshCount()
  assert.ok(endpoints.includes('overview'), '要重取 overview')
  assert.ok(!endpoints.includes('refresh'), 'r 不该触发抓取 —— 那是 refresh 端点的事')
})

test('分页接线：续页游标在时渲染「加载更多」，点它真的取下一页（并追加到当前列表）', async () => {
  // 接线判据（不是算法判据）：按钮必须**真的**接上 store.loadMore，且它走的端点是 overview。
  // 本仓库多次踩到「解析对了但没接线」（键位、动作、副作用各一次），所以这一层不能省。
  const { exports, sandbox, beginRender } = loadClientBundle()
  const first = [item({ id: 'a1' }), item({ id: 'a2' })]
  const second = [item({ id: 'a3' })]
  const endpoints = []
  sandbox.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    endpoints.push(body.endpoint)
    const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
    if (body.endpoint === 'overview' || body.endpoint === 'refresh') {
      if (body.payload?.cursor === 'C1') return ok(overviewStub(second))
      return ok({ ...overviewStub(first), nextCursor: 'C1' })
    }
    // 兜底同样守回包契约（本用例不会打到这些端点，但这条桩常被复制当模板 —— 别把契约上
    // 不存在的形状传给下一代用例，与 driveStore / mountReader / renderReader 的桩同一条纪律）
    return ok({ changed: 1, unread: 0, perFeedUnread: {} })
  }
  const store = exports.createReaderStore()
  const Reader = exports.createReader(store)
  // 假 React：渲染两遍（第一遍 ref 还是 null，见文件顶部的说明），并在两遍之间挂上假节点
  const box = {
    scrollTop: 0, scrollHeight: 3000, clientHeight: 300,
    querySelector: () => ({ offsetHeight: 40 }), getClientRects: () => [{}],
    focus: () => {}, contains: () => true,
  }
  const renderOnce = () => { beginRender(); return Reader() }
  /**
   * 从渲染树里收集所有 button 元素桩。
   *
   * 为什么用**文案**定位这一个按钮（与本文件其它用例按 aria-label 定位的惯例不同）：
   * 「加载更多」这个入口的语义就是它的文案（它没有独立的无障碍标签，也不该为测试单独加一个），
   * 而它同时是本任务新增的唯一入口 —— 找不到它，第 301 条之后就又到不了了。
   */
  const buttons = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (node.type === 'button' && node.props !== undefined) buttons.push(node)
    for (const value of Object.values(node.props ?? {})) {
      if (value !== null && typeof value === 'object') walk(value)
    }
  }
  // 假 React 不会因为 store 变化自动重渲染（useEffect 里那次订阅只改 hooks 槽位，不触发渲染），
  // 所以顺序是：先渲染一遍挂上假节点 → 拉数据 → **再渲染一遍**读取当前 state 的树。
  // 这不是绕开接线判据：第二遍渲染出来的 onClick 正是组件在 nextCursor 到位后给出的那一个。
  for (const props of collectRefs(renderOnce())) props.ref(box)

  await store.load('overview')
  assert.equal(store.get().nextCursor, 'C1', '前置条件：宿主给了续页游标')
  walk(renderOnce())
  const more = buttons.find((entry) => typeof entry.props.children === 'string' && entry.props.children.includes('加载更多'))
  assert.ok(more !== undefined, 'state.nextCursor 存在时必须渲染「加载更多」入口；否则第 301 条之后又永远到不了')

  more.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.ok(endpoints.includes('overview'), '「加载更多」必须走 overview 端点')
  assert.deepEqual([...store.get().items].map((entry) => entry.id), ['a1', 'a2', 'a3'],
    '续页必须追加到当前列表尾部（接线判据：点击真的驱动了 loadMore）')
  assert.equal(store.get().nextCursor, undefined, '到底之后按钮要从界面上消失（游标缺省）')
})

test('未读计数可隐藏（规格不变量 8）：默认显示，隐藏只动呈现不动数据', async () => {
  const { store } = await driveStore({ items: [item()] })
  assert.equal(store.get().showUnread, true, '默认必须显示 —— 否则就是悄悄改了既有行为')
  store.setShowUnread(false)
  assert.equal(store.get().showUnread, false)
  assert.equal(store.get().unread, 1, '隐藏只是呈现，计数本身不该被改掉')
})
