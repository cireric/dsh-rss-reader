/**
 * 导航轴（navSelection）的契约测试（2026-10 两列布局任务 2）。
 *
 * 为什么单独起一个文件而不塞进 client-bundle.test.mjs：这一层测的是**状态与动作**的语义
 * （源 x filter 叠加、切源后 selectedId 的归属），与那边测的按键接线不是一类问题；
 * 而且本文件要在实现之前就存在（TDD），单独一份才好确认它先红。
 *
 * 桩件沿用 client-bundle.test.mjs 里 driveStore 那套：加载**真实构建产物** lib/client.js，
 * 用桩 fetch 按 endpoint 回数据 —— 测的是真实 store，不是另写一份逻辑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')

/** 一条最小可用的条目。默认 feedA，两个源的场景各自覆盖 feedId。 */
function item(id, overrides = {}) {
  return {
    id, feedId: 'feedA', feedTitle: '源 A', title: '标题 ' + id,
    link: 'https://example.com/' + id, readAt: undefined, starred: false,
    fetchedAt: '2026-10-06T00:00:00.000Z', ...overrides,
  }
}

/**
 * 造一份符合宿主契约的 overview。
 *
 * perFeedUnread 刻意**按宿主侧语义派生**（键域 = feeds 表，0 未读的源也留 0 值键），
 * 这样客户端「无条件使用」才是被测的真相；若这里图省事只给未读 > 0 的源发键，
 * 就测不出「键域不全」这个任务 1 专门守的点。
 */
function overviewOf(items) {
  const feeds = [...new Set(items.map((entry) => entry.feedId))].map((feedId) => ({ id: feedId, title: feedId }))
  const perFeedUnread = {}
  for (const feed of feeds) perFeedUnread[feed.id] = 0
  for (const entry of items) {
    if (entry.readAt === undefined) perFeedUnread[entry.feedId] += 1
  }
  return {
    feeds, items,
    unread: items.filter((entry) => entry.readAt === undefined).length,
    perFeedUnread,
    refreshed: false,
  }
}

/**
 * 加载真实 bundle 并取出它导出的 createReaderStore。
 *
 * 沙箱里必须备好 HTMLElement / setTimeout 这些全局：按键与消抖会碰到它们，
 * 缺一个的表现是「整组测试报错」而不是断言失败（client-bundle.test.mjs 顶部实测记着）。
 * fetch 是**装好沙箱后再覆盖**的：这样每个用例各拿到自己的 overview，互不串味。
 */
function loadExports(overview) {
  const source = readFileSync(BUNDLE, 'utf8')
  let captured = null
  class HTMLElementStub {}
  const sandbox = {
    document: { addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null, activeElement: null },
    window: { __ModuleLoader__: { load: (entry) => { captured = entry } }, open: () => {} },
    console,
    HTMLElement: HTMLElementStub,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.ok(captured !== null, 'client bundle 没有调用 window.__ModuleLoader__.load')
  sandbox.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    const ok = (value) => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) })
    if (body.endpoint === 'overview') return ok(overview)
    return ok({ changed: 1, unread: 0 })
  }
  // 本文件只驱动 store（不渲染组件），hook 桩给到「能跑通模块定义」即可；
  // useState 真的存值是「渲染多遍」那类用例才需要的，这里用不上。
  const require = (specifier) => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') {
      return {
        jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment'),
        useEffect: () => {}, useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
        useCallback: (fn) => fn, useRef: (initial) => ({ current: initial }), default: {},
      }
    }
    throw new Error('未预期的外部依赖：' + specifier)
  }
  return captured.factory(require)
}

/** 喂一份 overview 给真实 store，返回 store 本体。 */
async function storeWith(items) {
  const exports = loadExports(overviewOf(items))
  const store = exports.createReaderStore()
  await store.load('overview')
  return store
}

/** 两个源各若干条：这组用例的共同前置。 */
function twoFeeds() {
  return [
    item('a1'), item('a2'),
    item('b1', { feedId: 'feedB', feedTitle: '源 B' }),
  ]
}

const ids = (list) => list.map((entry) => entry.id)

test('选源后 visible() 只含该源条目', async () => {
  const store = await storeWith(twoFeeds())
  assert.equal(store.visible().length, 3, '前置条件：初始是聚合视图')

  store.selectNav({ kind: 'feed', feedId: 'feedB' })

  const visible = store.visible()
  assert.deepEqual(ids(visible), ['b1'], '选中 feedB 后只剩它的条目')
  assert.ok(visible.every((entry) => entry.feedId === 'feedB'), '可见条目不得混入别的源')
})

test('叠加：源 + 未读 filter 只显示该源未读（两条件相乘，不是二选一）', async () => {
  const store = await storeWith([
    item('a1', { readAt: '2026-10-01T00:00:00.000Z' }),
    item('a2'),
    item('b1', { feedId: 'feedB', feedTitle: '源 B' }),
  ])
  store.setFilter('unread')
  store.selectNav({ kind: 'feed', feedId: 'feedA' })

  assert.deepEqual(ids(store.visible()), ['a2'],
    '要同时满足两个条件：本源的已读条目（a1）与别源的未读条目（b1）都得排除')
})

test('虚拟视图与既有 setFilter 等价，不留两套状态', async () => {
  const store = await storeWith(twoFeeds())
  store.setFilter('unread')
  assert.equal(store.get().filter, 'unread', '前置条件：filter 轴确实被切过')

  store.selectNav({ kind: 'virtual' })

  assert.equal(store.get().navSelection.kind, 'virtual')
  assert.equal(store.get().filter, 'all', '切回虚拟视图要把 filter 归位，否则两套过滤状态并存')
  assert.deepEqual(ids(store.visible()), ['a1', 'a2', 'b1'], '虚拟视图 = 聚合视图，行为与初始态一致')
  // filter 轴仍然独立可用 —— 虚拟视图不是第二套过滤状态
  store.setFilter('starred')
  assert.deepEqual(ids(store.visible()), [], 'starred 过滤仍照常生效（三条轴各管一件事）')
})

test('再选中同一个源 = 取消选中，回到虚拟视图', async () => {
  const store = await storeWith(twoFeeds())
  store.selectNav({ kind: 'feed', feedId: 'feedB' })
  assert.deepEqual(ids(store.visible()), ['b1'], '前置条件：第一次选中生效')

  store.selectNav({ kind: 'feed', feedId: 'feedB' })

  // 只比字段不比对象：store 跑在 vm 沙箱里，沙箱造的对象与测试 realm 的原型不同，
  // deepStrictEqual 会为「原型不同」而红 —— 那是夹具假象，不是被测行为。
  assert.equal(store.get().navSelection.kind, 'virtual', '再点同一个源应当取消选中')
  assert.deepEqual(ids(store.visible()), ['a1', 'a2', 'b1'], '取消后回到聚合视图')
})

test('切到源后 selectedId 落到新列表第一条，不指向被过滤掉的条目', async () => {
  const store = await storeWith([
    item('a1'),
    item('b1', { feedId: 'feedB', feedTitle: '源 B' }),
    item('b2', { feedId: 'feedB', feedTitle: '源 B' }),
  ])
  assert.equal(store.get().selectedId, 'a1', '前置条件：初始选中的是 feedA 的条目')

  store.selectNav({ kind: 'feed', feedId: 'feedB' })

  const selectedId = store.get().selectedId
  assert.equal(selectedId, 'b1', '选中项必须落到新列表第一条，否则 j/k 会在看不见的条目上无反应')
  assert.ok(store.visible().some((entry) => entry.id === selectedId), '选中项必须真的在可见列表里')
  assert.notEqual(selectedId, 'a1', '换列表前那条不该还占着 selectedId（它已被过滤掉）')
})

test('已选中某源时切 filter：selectedId 落在该源内第一条，而不是全表第一条', async () => {
  // 这条钉的是 setFilter 的新语义（源 × filter）。既有 setFilter 用例（client-bundle 那几条）
  // 全跑在 virtual 状态下，源条件恒真，所以这条路径此前零覆盖 —— 而它是唯一能把 selectedId
  // 留在源内的入口：若退回「只按 filter 算第一条」，selectedId 会指到源外条目，visible() 里
  // 没有它，j/k 直接失灵。
  const store = await storeWith([
    item('a1'), item('a2'),
    item('b1', { feedId: 'feedB', feedTitle: '源 B' }),
    item('b2', { feedId: 'feedB', feedTitle: '源 B' }),
  ])
  store.selectNav({ kind: 'feed', feedId: 'feedB' })
  assert.equal(store.get().selectedId, 'b1', '前置条件：选源后落在 b1')

  store.setFilter('all')

  const selectedId = store.get().selectedId
  assert.equal(selectedId, 'b1', '切 filter 后仍须留在 feedB 内，不该跳到全表第一条 a1')
  assert.ok(store.visible().some((entry) => entry.id === selectedId), '选中项必须真的在可见列表里')
  assert.ok(store.visible().every((entry) => entry.feedId === 'feedB'), '切 filter 不该把源条件带走')
})

test('applyOverview 把 perFeedUnread 存进 state（左栏角标的数据来源）', async () => {
  const store = await storeWith([
    item('a1'), item('a2', { readAt: '2026-10-01T00:00:00.000Z' }),
    item('b1', { feedId: 'feedB', feedTitle: '源 B' }),
  ])
  assert.deepEqual(store.get().perFeedUnread, { feedA: 1, feedB: 1 },
    'perFeedUnread 必须落到 state；0 未读的源也保留 0 值键（键域 = feeds 表）')
})

/**
 * 导航**光标**（2026-10-10 两列布局任务 6 的返工，按规格 §2.4 补齐）。
 *
 * 规格 §2.4 把 shift+n/p 与 shift+o 写成两件事：
 *   | shift+n / shift+p | 在左栏导航内下/上**移动选中**（跨虚拟视图与源） |
 *   | shift+o           | **打开**导航内当前选中的项（等同点击） |
 * 第一版实现让两者塌缩成一行（navSelection 同时兼任光标与「生效的过滤」）⇒ shift+n 走一行
 * 就等于打开它，shift+o 实际只剩「取消」，规格无从满足。所以拆出一个**纯光标** navCursor：
 * 它只表示「导航里高亮在哪一行」，**不改变**任何过滤结果、不影响 selectedId。
 *
 * 这三条用例钉的就是这条分工：初值 / 移动只动光标 / 打开才落作用域。
 */
test('navCursor 初值 = 与初始 filter 一致的那一行；顶栏换 filter 时光标跟着走', async () => {
  const store = await storeWith(twoFeeds())
  // 只比字段不比对象：store 跑在 vm 沙箱里，deepStrictEqual 会为「原型不同」而红（夹具假象）
  assert.deepEqual({ ...store.get().navCursor }, { kind: 'filter', filter: 'all' },
    '初值必须是「全部」那一行 —— 初始 filter 就是 all，光标所在行即当前生效的视图')

  store.setFilter('unread')
  assert.deepEqual({ ...store.get().navCursor }, { kind: 'filter', filter: 'unread' },
    '顶栏换 filter 就是「当前项换了一行」，光标必须跟着 —— 否则键盘接着 shift+n 会从旧位置跳')
})

test('moveNavCursor 只动光标：navSelection / filter / selectedId / visible() 一律不变', async () => {
  const store = await storeWith(twoFeeds())
  const before = {
    navSelection: { ...store.get().navSelection },
    filter: store.get().filter,
    selectedId: store.get().selectedId,
    visible: ids(store.visible()),
  }

  store.moveNavCursor(1)
  assert.deepEqual({ ...store.get().navCursor }, { kind: 'filter', filter: 'unread' }, '光标应当移到下一行')
  // 「移动 ≠ 打开」的可断言形式：移动之后**生效视图**必须原封不动
  assert.deepEqual({
    navSelection: { ...store.get().navSelection },
    filter: store.get().filter,
    selectedId: store.get().selectedId,
    visible: ids(store.visible()),
  }, before, '移动光标不得改变任何过滤结果 —— 这就是规格 §2.4 的「移动」与「打开」之分')

  store.moveNavCursor(-1)
  assert.deepEqual({ ...store.get().navCursor }, { kind: 'filter', filter: 'all' }, '往回一格应当回到「全部」')

  // 跨过虚拟视图三行进入源列表：光标换成源的形状，而作用域依旧不动
  for (let i = 0; i < 3; i += 1) store.moveNavCursor(1)
  assert.deepEqual({ ...store.get().navCursor }, { kind: 'feed', feedId: 'feedA' }, '第四行是第一个源')
  assert.deepEqual({ ...store.get().navSelection }, { kind: 'virtual' }, '移到源那一行**不是**选中该源')

  // 边界：到头/到尾夹住不动
  store.moveNavCursor(1)
  assert.deepEqual({ ...store.get().navCursor }, { kind: 'feed', feedId: 'feedB' }, '最后一行是第二个源')
  store.moveNavCursor(1)
  assert.deepEqual({ ...store.get().navCursor }, { kind: 'feed', feedId: 'feedB' }, '尾行再往下应当夹住')
  for (let i = 0; i < 9; i += 1) store.moveNavCursor(-1)
  assert.deepEqual({ ...store.get().navCursor }, { kind: 'filter', filter: 'all' }, '首行再往上应当夹住')
})

test('openNavCursor 才落作用域：源行 → selectNav；虚拟视图行 → setFilter（等同鼠标点击）', async () => {
  const store = await storeWith(twoFeeds())

  // 光标走到第二个源（全部→未读→星标→源A→源B）
  for (let i = 0; i < 4; i += 1) store.moveNavCursor(1)
  assert.deepEqual({ ...store.get().navCursor }, { kind: 'feed', feedId: 'feedB' }, '前置条件：光标在源 B 上')
  assert.deepEqual(ids(store.visible()), ['a1', 'a2', 'b1'], '前置条件：此时仍是聚合视图（光标还没打开）')

  store.openNavCursor()
  assert.deepEqual({ ...store.get().navSelection }, { kind: 'feed', feedId: 'feedB' }, '打开源行 = 选中该源')
  assert.deepEqual(ids(store.visible()), ['b1'], '右栏切到该源')
})

test('「源 × filter 叠加」下打开虚拟视图行：filter 生效，而生效的导航项仍是那个源（叠加不塌缩）', async () => {
  // 这条钉的是：键盘「打开虚拟视图行」与鼠标「点顶栏 filter 按钮」必须逐条等价（规格 §2.4
  // 「等同点击」）。若键盘自作主张「退出源作用域」，两条路径就会得到不同状态 —— 那正是
  // 「标签与实现各说各话」的同类缺陷，只是换了个方向。
  const store = await storeWith(twoFeeds())
  store.selectNav({ kind: 'feed', feedId: 'feedB' })   // 先选到一个源（模拟鼠标点左栏）
  const beforeNavSelection = { ...store.get().navSelection }

  // 选定源之后光标落在那一行（feedB 是最后一行），往上走三格才到虚拟视图的「未读」
  for (let i = 0; i < 3; i += 1) store.moveNavCursor(-1)
  assert.deepEqual({ ...store.get().navCursor }, { kind: 'filter', filter: 'unread' }, '前置条件：光标在「未读」行')
  store.openNavCursor()                                 // 打开「未读」那一行
  assert.equal(store.get().filter, 'unread', '打开虚拟视图行 = 该 filter 生效')
  assert.deepEqual({ ...store.get().navSelection }, beforeNavSelection,
    '源作用域仍在 —— 与鼠标点顶栏「未读」是同一条路（规格 §2.1 的源 × filter 叠加）')
  assert.deepEqual(ids(store.visible()), ['b1'], '未读且属于源 B 的只剩 b1（叠加，不是二选一）')
})

test('toggleNav 翻转左栏显隐（供任务 6 的 u 键接线，本任务不改键位）', async () => {
  const store = await storeWith(twoFeeds())
  assert.equal(store.get().navVisible, true, '前置条件：左栏默认可见')

  store.toggleNav()
  assert.equal(store.get().navVisible, false, '第一次应当收起')

  store.toggleNav()
  assert.equal(store.get().navVisible, true, '第二次应当再展开')
})
