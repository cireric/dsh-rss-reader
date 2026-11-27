/**
 * 视图记忆（两列布局任务 7）的契约测试。
 *
 * 钉三条：① 记住并恢复「上次看到哪儿」；② 持久化值不可信时回落默认且不抛错；
 * ③ **老域（文件里没有 global 键）补上 global 槽后仍能打开** —— 这条是本任务唯一的
 * 「推测必须先实测」项，见下面第三条用例的注释。
 *
 * 三层各有各的判据，不互相替代：
 *   - 纯函数层：sanitizeViewPreferences 的形状归一化（读侧唯一判定点）；
 *   - 宿主端点层：viewPreferences / saveViewPreferences 与真实 ReaderStore 的接线；
 *   - 客户端层：真实构建产物 lib/client.js 里的 store，用桩传输喂持久化值 —— 恢复与写盘
 *     都是接线，而本仓库的历史故障几乎都出在接线上。
 * 第四条用例用**真实 JsonStorageBackend + 真实 DomainFacility + 真实 readerDomain** 打开一个
 * 手工构造的老文件 —— 只有这一层能证明「老用户没被锁在门外」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { createFakeChannel, loadClientModule } from './helpers/client-channel.mjs'
import { overviewStub } from './helpers/overview-fixture.mjs'
import { articleCharsOf } from '../lib/retention.js'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'
import { readerDomain } from '../lib/domain.js'
import { createStore } from '../lib/store.js'
import { openDatabase, migrateSchema } from '../lib/storage/db.js'
import { createSqliteStore } from '../lib/store-sqlite.js'
import { sanitizeViewPreferences, DEFAULT_VIEW_PREFERENCES, DEFAULT_READING_PREFERENCES, READING_FONT_SIZES, READING_LINE_WIDTHS } from '../lib/preferences.js'
import { createMemoryStore } from '../lib/memory-store.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
// 与 client-bundle.test.mjs 的 BUNDLE_NAME 同一条理由（变异门槛的「崩了」分类器靠帧里的文件名）
const BUNDLE_NAME = 'client.js'

/** 等一轮宏任务：客户端写盘是 fire-and-forget 的异步链，断言前必须先让它落定。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 捕获式假定时器（R2-01）：阅读位置的写手用 store 注入的 setTimeout 去抖。
 *
 * 为什么不用真等 350ms：去抖窗口本身是**行为**（300ms 内多次选中只写一次），
 * 真等只能断言「最终写了」，断不到「写了几次」与「窗口多长」；假定时器把这两件事都变成同步事实。
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

/* ============================ ① 纯函数层：形状归一化 ============================ */

test('sanitizeViewPreferences：形状合法时原样通过，且只留协议里的八个字段（两个位置字段可缺省）', () => {
  const value = sanitizeViewPreferences({ navSelection: { kind: 'feed', feedId: 'A' }, filter: 'unread', navVisible: false })
  assert.deepEqual(value, { navSelection: { kind: 'feed', feedId: 'A' }, filter: 'unread', navVisible: false, showUnread: true, onlyRunnable: false, translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES })
  // M5 之前的配置里没有 reading 键：必须补默认值，而不是把它当成「整份记忆不可信」
  assert.deepEqual(value.reading, DEFAULT_READING_PREFERENCES, '旧配置缺 reading 时补默认排版')
  // 未知键必须被丢掉：它会被原样写回存储，攒够一版就成历史包袱
  const extra = sanitizeViewPreferences({ navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true, legacyJunk: 1 })
  assert.deepEqual(Object.keys(extra).sort(), ['filter', 'navSelection', 'navVisible', 'onlyRunnable', 'reading', 'showUnread', 'translateTarget'])
  // R2：阅读位置是「可选的两项」—— 有就原样通过，整份协议的键域不能多也不能少
  const positioned = sanitizeViewPreferences({
    navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true,
    lastItemId: 'a2', lastListScrollTop: 640,
  })
  assert.deepEqual(Object.keys(positioned).sort(), ['filter', 'lastItemId', 'lastListScrollTop', 'navSelection', 'navVisible', 'onlyRunnable', 'reading', 'showUnread', 'translateTarget'])
  // 默认常量本身必须是合法形状（它同时是域里的 initial）
  assert.deepEqual(sanitizeViewPreferences(DEFAULT_VIEW_PREFERENCES), DEFAULT_VIEW_PREFERENCES)
})

test('sanitizeViewPreferences：lastItemId 只认非空字符串，认不出就当没有', () => {
  // 阅读位置（R2-01）：记住「上次选中的那一行」。它与其他字段同一条归一化规则 ——
  // 一次坏值只抹掉它自己，不许把导航/过滤/排版一起带走。
  const base = { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false }
  const kept = sanitizeViewPreferences({ ...base, lastItemId: 'a2' })
  assert.equal(kept.lastItemId, 'a2', '非空字符串必须原样保留')
  assert.equal(kept.filter, 'unread', 'lastItemId 合法时其他字段一项不丢')

  for (const raw of ['', 0, null, true, {}, []]) {
    const value = sanitizeViewPreferences({ ...base, lastItemId: raw })
    assert.equal('lastItemId' in value, false, '认不出的 lastItemId 必须当作没有：' + JSON.stringify(raw))
    assert.equal(value.navSelection.kind, 'virtual', '坏 lastItemId 不许带走 navSelection：' + JSON.stringify(raw))
    assert.equal(value.filter, 'unread', '坏 lastItemId 不许带走 filter：' + JSON.stringify(raw))
    assert.equal(value.navVisible, false, '坏 lastItemId 不许带走 navVisible：' + JSON.stringify(raw))
  }

  // 旧配置根本没有这个键：读入正常，且返回对象里不凭空多一个 undefined 键
  const legacy = sanitizeViewPreferences(base)
  assert.equal('lastItemId' in legacy, false, '旧配置缺字段时必须保持「没有」，不是 undefined 占位')
  // 默认偏好不必带这个键（首次安装的 initial 与「没有记忆」是同一件事）
  assert.equal('lastItemId' in DEFAULT_VIEW_PREFERENCES, false)
})

test('sanitizeViewPreferences：lastListScrollTop 只认有限且 ≥ 0 的数，认不出就当没有', () => {
  // 阅读位置（R2-02）：列表滚动位置是像素坐标，0 是合法值（停在顶部），负值与 NaN 只会让滚动条乱跳。
  // 与 lastItemId 同一条归一化规则：一次坏值只抹掉它自己，不许带走导航/过滤/排版。
  const base = { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false }
  const keptZero = sanitizeViewPreferences({ ...base, lastListScrollTop: 0 })
  assert.equal(keptZero.lastListScrollTop, 0, '0 必须保留 —— 「停在顶部」不是「没有记忆」')
  assert.equal(keptZero.filter, 'unread', 'lastListScrollTop 合法时其他字段一项不丢')

  const kept = sanitizeViewPreferences({ ...base, lastListScrollTop: 1234.5 })
  assert.equal(kept.lastListScrollTop, 1234.5, '有限正数必须原样保留')

  for (const raw of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '100', null, true, {}, []]) {
    const value = sanitizeViewPreferences({ ...base, lastListScrollTop: raw })
    assert.equal('lastListScrollTop' in value, false, '认不出的滚动位置必须当作没有：' + String(raw))
    assert.equal(value.navSelection.kind, 'virtual', '坏滚动位置不许带走 navSelection：' + String(raw))
    assert.equal(value.filter, 'unread', '坏滚动位置不许带走 filter：' + String(raw))
    assert.equal(value.navVisible, false, '坏滚动位置不许带走 navVisible：' + String(raw))
  }

  // 反方向同样独立：别的字段坏掉不许把合法的滚动位置一起带走
  const independent = sanitizeViewPreferences({ ...base, filter: 'bogus', reading: { fontSize: 999 }, lastListScrollTop: 640 })
  assert.equal(independent.lastListScrollTop, 640, 'filter / reading 坏掉不该抹掉滚动位置')
  assert.equal(independent.filter, 'all', '坏 filter 只回落它自己')
  assert.deepEqual(independent.reading, DEFAULT_READING_PREFERENCES, '坏排版只回落它自己')

  // 旧配置根本没有这个键：读入正常，且返回对象里不凭空多一个 undefined 键
  const legacy = sanitizeViewPreferences(base)
  assert.equal('lastListScrollTop' in legacy, false, '旧配置缺字段时必须保持「没有」，不是 undefined 占位')
  assert.equal('lastListScrollTop' in DEFAULT_VIEW_PREFERENCES, false)
})

test('sanitizeViewPreferences：认不出的形状一律回落默认，绝不编造', () => {
  const defaults = { ...DEFAULT_VIEW_PREFERENCES }
  const bad = [
    undefined, null, 0, 'x', [], true,
    {},                                                   // 空对象
    { navSelection: { kind: 'nope' } },                   // 未知 kind
    { navSelection: { kind: 'feed' } },                   // 缺 feedId
    { navSelection: { kind: 'feed', feedId: '' } },       // 空 feedId
    { navSelection: { kind: 'feed', feedId: 7 } },        // feedId 不是字符串
    { filter: 'starred?', navVisible: 'yes' },            // 非法枚举 + 非法布尔
    { filter: null, navVisible: 0 },
  ]
  for (const raw of bad) {
    assert.deepEqual(sanitizeViewPreferences(raw), defaults, '不可信值必须整份回落：' + JSON.stringify(raw))
  }
  // 逐字段独立回落：filter 坏了不该把 navSelection 一起带走（否则一次坏值会抹掉更多记忆）
  const partial = sanitizeViewPreferences({ navSelection: { kind: 'feed', feedId: 'A' }, filter: 'bogus', navVisible: false })
  assert.deepEqual(partial, { navSelection: { kind: 'feed', feedId: 'A' }, filter: 'all', navVisible: false, showUnread: true, onlyRunnable: false, translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES })
})

test('sanitizeViewPreferences：正文排版逐字段归一，档位外的值一律回落默认', () => {
  // 界面能选的档位必须原样存回来（否则就会出现「选了 20px，重开变回 16px」）。
  // 逐档遍历而不是只挑一个：加档位时最容易漏的地方就是「界面加了 option、归一化没跟上」。
  for (const fontSize of READING_FONT_SIZES) {
    for (const lineWidth of READING_LINE_WIDTHS) {
      assert.deepEqual(
        sanitizeViewPreferences({ reading: { fontSize, lineWidth, theme: 'dark' } }).reading,
        { fontSize, lineWidth, theme: 'dark', expandImages: true },
        '档位必须原样通过：' + fontSize + 'px / ' + lineWidth + 'px')
    }
  }
  // 一个字段坏掉只带走它自己 —— 与上面三项同一条规则
  const cases = [
    [{ fontSize: 18.5, lineWidth: 640, theme: 'light' }, { fontSize: 16, lineWidth: 640, theme: 'light', expandImages: true }],
    [{ fontSize: '18', lineWidth: 640, theme: 'light' }, { fontSize: 16, lineWidth: 640, theme: 'light', expandImages: true }],
    [{ fontSize: 18, lineWidth: 100, theme: 'light' }, { fontSize: 18, lineWidth: 760, theme: 'light', expandImages: true }],
    [{ fontSize: 18, lineWidth: 640, theme: 'sepia' }, { fontSize: 18, lineWidth: 640, theme: 'auto', expandImages: true }],
    [null, DEFAULT_READING_PREFERENCES],
    [{}, DEFAULT_READING_PREFERENCES],
  ]
  for (const [raw, expected] of cases) {
    assert.deepEqual(sanitizeViewPreferences({ reading: raw }).reading, expected, 'raw = ' + JSON.stringify(raw))
  }
})

test('sanitizeViewPreferences：图片折叠偏好只判布尔，非布尔回落 true 且不带走同份记忆', () => {
  // R6 02 / spec 验收 13。`expandImages` 的语义是「默认是否展开图片」，默认 true。
  // 判据刻意是**只判布尔**：`"yes"` / `1` / `null` 这些「看起来像」的值一律回落 true，
  // 不做真值转换 —— 把 `"no"` 当 false 会让一个字符串悄悄关掉图片，读者完全无从理解。
  const bad = ['yes', 'no', '', 0, 1, null, undefined, [], {}, NaN]
  for (const value of bad) {
    assert.deepEqual(
      sanitizeViewPreferences({ reading: { expandImages: value } }).reading.expandImages,
      true,
      '非布尔必须回落 true：' + JSON.stringify(value),
    )
  }
  // 合法布尔原样通过（两个方向都要测：只测 false 会让「恒返回 true」的实现假绿）
  assert.equal(sanitizeViewPreferences({ reading: { expandImages: false } }).reading.expandImages, false)
  assert.equal(sanitizeViewPreferences({ reading: { expandImages: true } }).reading.expandImages, true)

  // 关键：坏值只带走它自己。同份记忆里的另外四项必须原样保住 ——
  // 否则一次坏值会表现为「我设的图片折叠没了，字号和上次读到哪儿也一起丢了」。
  const kept = sanitizeViewPreferences({
    navSelection: { kind: 'feed', feedId: 'A' }, filter: 'starred', navVisible: false,
    reading: { fontSize: 20, lineWidth: 1080, theme: 'dark', expandImages: 'yes' },
    lastItemId: 'b1', lastListScrollTop: 420,
  })
  assert.equal(kept.reading.expandImages, true, '坏值回落 true')
  assert.equal(kept.reading.fontSize, 20, '字号不许被图片偏好的坏值带走')
  assert.equal(kept.reading.lineWidth, 1080, '栏宽不许被带走')
  assert.equal(kept.reading.theme, 'dark', '主题不许被带走')
  assert.equal(kept.lastItemId, 'b1', '阅读位置不许被带走')
  assert.equal(kept.lastListScrollTop, 420, '列表滚动位置不许被带走')
  assert.equal(kept.filter, 'starred')
  assert.equal(kept.navVisible, false)
})

test('sanitizeViewPreferences：showUnread 只判布尔，"false" / 1 / null 一律回落 true 且不带走同份记忆', () => {
  // R11 05 / D27.2：显示未读计数从纯内存状态搬进视图记忆。归一化规则与 navVisible 同一条 ——
  // **只认布尔**：字符串 "false"、数字 1、null 这些「看起来像」的值一律回落 true。
  // 不做真值转换的理由：把 "false" 当 false 会让一个字符串悄悄关掉计数，读者完全无从解释。
  const bad = ['false', 'true', 'yes', 'no', '', 0, 1, null, undefined, [], {}, NaN]
  for (const value of bad) {
    assert.equal(
      sanitizeViewPreferences({ showUnread: value }).showUnread,
      true,
      '非布尔必须回落 true（不做真值转换）：' + JSON.stringify(value),
    )
  }
  // 合法布尔两个方向都测：只测 false 会让「恒返回 true」的实现假绿
  assert.equal(sanitizeViewPreferences({ showUnread: false }).showUnread, false, '合法的 false 必须原样保留')
  assert.equal(sanitizeViewPreferences({ showUnread: true }).showUnread, true)

  // 默认值单点：没有任何记忆时显示未读计数（改动前的既有行为）
  assert.equal(DEFAULT_VIEW_PREFERENCES.showUnread, true, '默认必须是显示 —— 否则就是悄悄改了既有行为')

  // 坏值只带走它自己：同份记忆的导航 / 过滤 / 排版 / 阅读位置一项都不许被拖下水
  const kept = sanitizeViewPreferences({
    navSelection: { kind: 'feed', feedId: 'A' }, filter: 'starred', navVisible: false,
    showUnread: 'false',
    reading: { fontSize: 20, lineWidth: 1080, theme: 'dark', expandImages: false },
    lastItemId: 'b1', lastListScrollTop: 420,
  })
  assert.equal(kept.showUnread, true, '坏 showUnread 回落 true')
  assert.equal(kept.reading.expandImages, false, '合法排版不许被 showUnread 的坏值带走')
  assert.equal(kept.filter, 'starred')
  assert.equal(kept.navVisible, false)
  assert.equal(kept.lastItemId, 'b1')
  assert.equal(kept.lastListScrollTop, 420)
})

test('图片折叠偏好走端点往返：存下 false 读回 false，存回 true 读回 true', async () => {
  // R6 02 / spec 验收 12 的**偏好层**那一半（Seam 4）。
  // ⚠️ 验收 12 的「设回展开后直接渲染」需要 UI 开关与折叠渲染，那是 03 的票 ——
  // 本票只能测到「值存得下、读得回」。渲染层的那一半在 03 的 scroll-dom 用例里。
  const store = memoryStore()
  store.feeds.set('A', { url: 'A', title: 'A' })
  const reading = { fontSize: 16, lineWidth: 760, theme: 'auto' }

  const folded = await callEndpoint(store, 'saveViewPreferences', {
    preferences: { navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true, reading: { ...reading, expandImages: false } },
  })
  assert.equal(folded.preferences.reading.expandImages, false, '回带宿主实际存下的值必须是折叠')

  const readBack = await callEndpoint(store, 'viewPreferences', {})
  assert.equal(readBack.preferences.reading.expandImages, false, '重开面板读到的仍是折叠')

  const expanded = await callEndpoint(store, 'saveViewPreferences', {
    preferences: { navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true, reading: { ...reading, expandImages: true } },
  })
  assert.equal(expanded.preferences.reading.expandImages, true, '设回展开后必须存下展开')
  assert.equal((await callEndpoint(store, 'viewPreferences', {})).preferences.reading.expandImages, true, '再读回仍是展开')
})

test('显示未读计数走端点往返：存下 false 读回 false，坏值一律回落 true', async () => {
  const store = memoryStore()
  store.feeds.set('A', { url: 'A', title: 'A' })
  const base = {
    navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true,
    reading: DEFAULT_READING_PREFERENCES,
  }

  const saved = await callEndpoint(store, 'saveViewPreferences', {
    preferences: { ...base, showUnread: false },
  })
  assert.equal(saved.preferences.showUnread, false, '回带宿主实际存下的值必须是关闭')
  assert.equal((await callEndpoint(store, 'viewPreferences', {})).preferences.showUnread, false,
    '重开面板读到的仍是关闭（D27.2 持久化）')

  // 存坏值时读侧唯一归一化点必须回落 true，且不许把垃圾透出去
  for (const raw of ['false', 1, null]) {
    const normalized = await callEndpoint(store, 'saveViewPreferences', {
      preferences: { ...base, showUnread: raw },
    })
    assert.equal(normalized.preferences.showUnread, true,
      '不合法的 showUnread 必须归一成 true：' + JSON.stringify(raw))
    assert.equal((await callEndpoint(store, 'viewPreferences', {})).preferences.showUnread, true,
      '读侧同样回落 true：' + JSON.stringify(raw))
  }
})

test('sanitizeViewPreferences：文件夹选中按目录判据恢复，未知文件夹回落虚拟视图', () => {
  const knownFolder = (folder) => folder === '技术'
  assert.deepEqual(
    sanitizeViewPreferences({ navSelection: { kind: 'folder', folder: '技术' } }, undefined, knownFolder).navSelection,
    { kind: 'folder', folder: '技术' },
  )
  assert.deepEqual(
    sanitizeViewPreferences({ navSelection: { kind: 'folder', folder: 'gone' } }, undefined, knownFolder).navSelection,
    { kind: 'virtual' },
  )
})

test('sanitizeViewPreferences：标签选中按「标签还在不在」恢复，未知标签回落虚拟视图', () => {
  const knownTag = (tagId) => tagId === 't1'
  assert.deepEqual(
    sanitizeViewPreferences({ navSelection: { kind: 'tag', tagId: 't1' } }, undefined, undefined, knownTag).navSelection,
    { kind: 'tag', tagId: 't1' }, '还在的标签必须原样保留')
  assert.deepEqual(
    sanitizeViewPreferences({ navSelection: { kind: 'tag', tagId: 'gone' } }, undefined, undefined, knownTag).navSelection,
    { kind: 'virtual' }, '被删掉的标签必须回落 —— 与已退订的源同一条规则')
  // 不传判据 = 只验形状（与 feed 那条同义）
  assert.deepEqual(
    sanitizeViewPreferences({ navSelection: { kind: 'tag', tagId: 'gone' } }).navSelection,
    { kind: 'tag', tagId: 'gone' })
})

test('sanitizeViewPreferences：给了「源是否还在订」的判据时，未知 feedId 回落虚拟视图', () => {
  const known = (feedId) => feedId === 'A'
  assert.deepEqual(
    sanitizeViewPreferences({ navSelection: { kind: 'feed', feedId: 'A' } }, known).navSelection,
    { kind: 'feed', feedId: 'A' }, '在订的源必须原样保留 —— 否则「回落」会把正常记忆也吃掉')
  assert.deepEqual(
    sanitizeViewPreferences({ navSelection: { kind: 'feed', feedId: 'gone' } }, known).navSelection,
    { kind: 'virtual' }, '已退订的源必须回落，而不是留一个指向不存在源的选中态')
  // 不传判据 = 只验形状（客户端恢复时用：那一刻本地 feeds 还是空的，拿它当判据会把正常记忆全吃掉）
  assert.deepEqual(
    sanitizeViewPreferences({ navSelection: { kind: 'feed', feedId: 'gone' } }).navSelection,
    { kind: 'feed', feedId: 'gone' })
  // 返回的必须是新对象：不可把未校验的原值引到 state 里
  const raw = { navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true }
  assert.notEqual(sanitizeViewPreferences(raw), raw)
})

/* =================== ①b 宿主真实适配器（lib/store.js 的 createStore） =================== */

/**
 * 一个最小的 Domain 桩，只为驱动**真实的** createStore。
 *
 * 为什么要这一层：下面端点层用的是本文件自己的内存桩，而生产路径走的是 createStore ——
 * 只测桩就等于「介质换成了我的理解」。这里把 Domain 的 table/global 两个面按真实接口填出来，
 * 让 createStore 里那两句 sanitizeViewPreferences 真的被执行。
 */
function fakeDomain({ feedIds = [] } = {}) {
  const tables = { feeds: new Map(), items: new Map(), cursors: new Map() }
  for (const id of feedIds) tables.feeds.set(id, { url: id })
  let global
  const handle = (name) => ({
    get: (key) => tables[name].get(key),
    entries: () => [...tables[name].entries()][Symbol.iterator](),
    keys: () => [...tables[name].keys()][Symbol.iterator](),
    get size() { return tables[name].size },
    put: async (key, value) => { tables[name].set(key, value) },
    delete: async (key) => tables[name].delete(key),
    update: async (key, fn) => { const next = fn(tables[name].get(key)); tables[name].set(key, next); return next },
  })
  return {
    domain: { name: 'rss_reader', table: handle, global: { get: () => global, set: async (value) => { global = value } } },
    readGlobal: () => global,
    writeGlobal: (value) => { global = value },
  }
}

test('真实 createStore：读侧校验坏值、写侧归一后才落库（生产路径，不是桩）', () => {
  const { domain, readGlobal, writeGlobal } = fakeDomain({ feedIds: ['A'] })
  const store = createStore(domain)

  assert.deepEqual(store.viewPreferences(), DEFAULT_VIEW_PREFERENCES, '媒介还没有 global ⇒ 回落 initial')

  // 写侧：未知源先归一再落库 —— 认不出的原值绝不许进媒介
  return store.saveViewPreferences({ navSelection: { kind: 'feed', feedId: 'gone' }, filter: 'unread', navVisible: false })
    .then((saved) => {
      assert.deepEqual(saved, { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false, showUnread: true, onlyRunnable: false, translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES })
      assert.deepEqual(readGlobal(), saved, '落库的必须是归一后的值')
      assert.deepEqual(store.viewPreferences(), saved, '读回来一致')

      // 读侧：媒介里被塞了坏值时也不许透出去（这是读侧校验唯一能生效的位置）
      writeGlobal({ navSelection: { kind: 'feed', feedId: 'gone' }, filter: 'bogus', navVisible: 1 })
      assert.deepEqual(store.viewPreferences(), DEFAULT_VIEW_PREFERENCES, '坏值诚实回落，不编造也不透传')

      // 在订的源必须保住（回落不能把正常记忆也吃掉）
      writeGlobal({ navSelection: { kind: 'feed', feedId: 'A' }, filter: 'starred', navVisible: false })
      assert.deepEqual(store.viewPreferences(), { navSelection: { kind: 'feed', feedId: 'A' }, filter: 'starred', navVisible: false, showUnread: true, onlyRunnable: false, translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES })
    })
})

/**
 * 同一组契约，换到**生产路径**的自持存储上再钉一遍（Task 4 的 cutover）。
 *
 * 为什么两条都要留着，而不是把上面的 fakeDomain 换成它：那条同时是 `lib/store.js` 两个变异
 * 的判据（scripts/mutation-test.mjs 的 'persist-宿主读侧不校验' 与 'persist-宿主写侧不归一'）。
 * 删掉它、只留 SQLite 版，那两条变异就**幸存**了 —— 而门槛上「幸存」等于测试缺口。
 * 反过来只留旧那条也不够：Task 4 之后生产路径是 createSqliteStore，它一次都没被这组契约测过。
 *
 * 两条路径的共同判据（读侧归一、写侧归一再落库、未知源回落）在这里逐条重复，是刻意的：
 * 存储换介质时最容易发生的事，就是「旧实现的那条承诺没跟过来」。
 */
test('真实 createSqliteStore：读侧校验坏值、写侧归一后才落库（cutover 后的生产路径）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-nav-sqlite-'))
  const configPath = join(dir, 'config.json')
  const db = openDatabase(':memory:')
  try {
    migrateSchema(db)
    const store = createSqliteStore(db, configPath)
    await store.saveFeed('A', { url: 'A' })

    assert.deepEqual(store.viewPreferences(), DEFAULT_VIEW_PREFERENCES, 'config.json 还没有 ⇒ 回落默认')

    // 写侧：未知源先归一再落库 —— 认不出的原值绝不许进文件
    const saved = await store.saveViewPreferences({ navSelection: { kind: 'feed', feedId: 'gone' }, filter: 'unread', navVisible: false })
    assert.deepEqual(saved, { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false, showUnread: true, onlyRunnable: false, translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES })
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).viewPreferences, saved, '落盘的必须是归一后的值')
    assert.deepEqual(store.viewPreferences(), saved, '读回来一致')

    // 读侧：文件里被塞了坏值时也不许透出去（这是读侧校验唯一能生效的位置）
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    onDisk.viewPreferences = { navSelection: { kind: 'feed', feedId: 'gone' }, filter: 'bogus', navVisible: 1 }
    writeFileSync(configPath, JSON.stringify(onDisk))
    assert.deepEqual(store.viewPreferences(), DEFAULT_VIEW_PREFERENCES, '坏值诚实回落，不编造也不透传')

    // 在订的源必须保住（回落不能把正常记忆也吃掉）
    await store.saveViewPreferences({ navSelection: { kind: 'feed', feedId: 'A' }, filter: 'starred', navVisible: false })
    assert.deepEqual(store.viewPreferences(), { navSelection: { kind: 'feed', feedId: 'A' }, filter: 'starred', navVisible: false, showUnread: true, onlyRunnable: false, translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ============================ ② 宿主端点层 ============================ */

test('真实 createSqliteStore：两个阅读位置字段原样落进 config.json，旧配置缺这两个键仍能读', async () => {
  // R2-01 / R2-02 的存储承诺：阅读位置只是视图记忆的又两位，走同一条「整份覆盖写 + 读侧归一」的路径。
  // 用生产路径（createSqliteStore）而不是内存桩：config.json 才是用户重开面板时真正读的那份文件。
  const dir = mkdtempSync(join(tmpdir(), 'rss-nav-position-'))
  const configPath = join(dir, 'config.json')
  const db = openDatabase(':memory:')
  try {
    migrateSchema(db)
    const store = createSqliteStore(db, configPath)
    const saved = await store.saveViewPreferences({
      navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true,
      reading: DEFAULT_READING_PREFERENCES, lastItemId: 'a2', lastListScrollTop: 640,
    })
    assert.equal(saved.lastItemId, 'a2', '写侧归一必须保留 lastItemId')
    assert.equal(saved.lastListScrollTop, 640, '写侧归一必须保留 lastListScrollTop')
    const onDiskSaved = JSON.parse(readFileSync(configPath, 'utf8')).viewPreferences
    assert.equal(onDiskSaved.lastItemId, 'a2',
      '落盘文件里必须真的有这一位（否则重开后无从恢复）')
    assert.equal(onDiskSaved.lastListScrollTop, 640,
      '滚动位置也必须真的落盘（否则重开面板只会回到顶部）')
    assert.equal(store.viewPreferences().lastItemId, 'a2', '读回来一致')
    assert.equal(store.viewPreferences().lastListScrollTop, 640, '滚动位置读回来一致')

    // 旧版本留下的配置没有这两个键：读入正常、其他偏好一项不丢，也不凭空写一个 undefined 进去
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    delete onDisk.viewPreferences.lastItemId
    delete onDisk.viewPreferences.lastListScrollTop
    writeFileSync(configPath, JSON.stringify(onDisk))
    const legacy = store.viewPreferences()
    assert.equal('lastItemId' in legacy, false, '旧配置缺字段 ⇒ 当作没有，而不是 undefined 占位')
    assert.equal('lastListScrollTop' in legacy, false, '旧配置缺滚动位置 ⇒ 当作没有')
    assert.equal(legacy.filter, 'all', '缺位置字段不许带走 filter')
    assert.deepEqual(legacy.reading, DEFAULT_READING_PREFERENCES, '缺位置字段不许带走排版')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

const memoryStore = () => createMemoryStore()

/** EndpointDeps 的桩（形状照 src/endpoints.ts 的 EndpointDeps，不增减字段）。 */
const deps = (store) => ({
  config: Config({}),
  log: () => {},
  ready: () => store,
  refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
  lastRefreshCompletedAt: () => undefined,
  articleAttempts: new Map(),
})

async function callEndpoint(store, endpoint, payload) {
  const result = await createDispatch(deps(store))(endpoint, payload)
  assert.equal(result.ok, true, endpoint + ' 应当成功')
  return result.value
}

test('端点：saveViewPreferences 存下偏好，viewPreferences 原样读回', async () => {
  const store = memoryStore()
  store.feeds.set('A', { url: 'A', title: 'A' })
  // reading 刻意用非默认档位：默认值原样往返是测不出「字段有没有真的过端点」的
  const preferences = {
    navSelection: { kind: 'feed', feedId: 'A' }, filter: 'starred', navVisible: false, showUnread: true, onlyRunnable: false,
    translateTarget: 'zh-CN', reading: { fontSize: 20, lineWidth: 640, theme: 'dark', expandImages: true },
  }

  const saved = await callEndpoint(store, 'saveViewPreferences', { preferences })
  assert.deepEqual(saved.preferences, preferences, '回带宿主实际存下的值')

  const read = await callEndpoint(store, 'viewPreferences', {})
  assert.deepEqual(read.preferences, preferences, '重开面板读到的必须与写下去的一致')
  assert.deepEqual(store.getRawPreferences(), preferences, '真的落到域的 global 槽上')
})

test('端点：未知 feedId / 非法形状写进来时回落默认，不抛错也不把垃圾存进域', async () => {
  const store = memoryStore()
  store.feeds.set('A', { url: 'A', title: 'A' })

  const unknownFeed = await callEndpoint(store, 'saveViewPreferences', { preferences: { navSelection: { kind: 'feed', feedId: 'gone' }, filter: 'unread', navVisible: false } })
  assert.deepEqual(unknownFeed.preferences, { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false, showUnread: true, onlyRunnable: false, translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES },
    '已退订的源要回落虚拟视图，而 filter / navVisible 这两条仍然保得住')
  assert.deepEqual(store.getRawPreferences(), unknownFeed.preferences, '存进域的必须是回落后的值 —— 不许把认不出的原值原样塞进去')

  const junk = await callEndpoint(store, 'saveViewPreferences', { preferences: 'not-an-object' })
  assert.deepEqual(junk.preferences, DEFAULT_VIEW_PREFERENCES, '整份认不出就整份回落')
  const missing = await callEndpoint(store, 'viewPreferences', {})
  assert.deepEqual(missing.preferences, DEFAULT_VIEW_PREFERENCES, '读侧同样不许抛错')

  // 域里存着坏值时，读端点必须回落而不是把它透出去（绕过写侧归一，直接往媒介里塞坏值）
  store.putRawPreferences({ navSelection: { kind: 'feed', feedId: 'gone' }, filter: 'bogus', navVisible: 1 })
  const read = await callEndpoint(store, 'viewPreferences', {})
  assert.deepEqual(read.preferences, DEFAULT_VIEW_PREFERENCES, '诚实回落到默认，而不是编造或透传')
})

/* ============================ ③ 客户端层（真实构建产物） ============================ */

function item(id, overrides = {}) {
  return {
    id, feedId: 'A', feedTitle: '源 A', title: '标题 ' + id,
    link: 'https://example.com/' + id, readAt: undefined, starred: false,
    fetchedAt: '2026-10-06T00:00:00.000Z', ...overrides,
  }
}

/** 守宿主契约的 overview 桩（键域 = feeds 表，0 未读的源也留键）。 */
// 宿主回包形状只在 tests/helpers/overview-fixture.mjs 一处定义（阶段 4 验收项）。
const overviewOf = (items, tags = []) => overviewStub({ items, tags })

/**
 * 加载真实 bundle / 驱动真实 store。prefs 是「宿主那一侧的域 global」：跨两次 store 实例共享，
 * 这样「重开面板」在测试里就是「再建一个 store、读同一份 prefs」。
 */
function loadExports({ items, tags = [], prefs, failSave = false, writeDelayMs = [], timers }) {
  // 2026-11-15 阶段 4 票据 02：沙箱与假通道收进共享 helper（本文件不再自己写 fetch 分支）。
  const { exports } = loadClientModule()
  const channel = createFakeChannel({
    overview: overviewOf(items, tags),
    request: async (endpoint, payload) => {
      if (endpoint === 'refresh') return overviewOf(items, tags)
      if (endpoint === 'viewPreferences') return { preferences: prefs.value }
      if (endpoint === 'saveViewPreferences') {
        if (failSave) throw new Error('internal: 写盘失败')
        // 第 n 次写盘的延迟由用例指定：用来表达「后发的先到」这种真实网络里会发生的事。
        // ⚠️ 序号必须在**请求到达时**取，不能用 prefs.writes.length（它只在落库后 +1）：
        // 两个请求同时在飞时，第二个到达时 length 还是 0 —— 两次会拿到同一个延迟，
        // 「后发先到」这个形态就表达不出来（本条夹具的第一版正是这么错的，变异因此静默幸存）。
        prefs.arrived = (prefs.arrived ?? 0) + 1
        const delay = writeDelayMs[prefs.arrived - 1] ?? 0
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
        prefs.value = payload.preferences
        prefs.writes.push(payload.preferences)
        return { preferences: prefs.value }
      }
      return undefined
    },
  })
  // 调用点保持 exports.createReaderStore()：这里把通道注入进去。
  const create = exports.createReaderStore
  exports.createReaderStore = (overrides = {}) => create({
    rpc: channel.rpc,
    ...(timers === undefined ? {} : { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout }),
    ...overrides,
  })
  // 阅读位置的用例要断言「不额外取数」：通道按游标记下的调用序列是唯一可信来源。
  exports.__pageCalls = () => channel.pageCalls
  // 恢复不许碰读态/阅读进度：一次调用序列就能证明「恢复不是打开」。
  exports.__calls = () => channel.calls
  return exports
}

/** 「重开面板」：新 store 读同一份宿主 prefs。 */
async function openPanel(shared) {
  const exports = loadExports(shared)
  const store = exports.createReaderStore()
  await store.load('overview')
  await flush()
  return store
}

function twoFeeds() {
  return [item('a1'), item('a2'), item('b1', { feedId: 'B', feedTitle: '源 B' })]
}

const ids = (list) => list.map((entry) => entry.id)

test('记住上次选中的导航项、filter 与左栏显隐，重开后恢复', async () => {
  const prefs = { value: undefined, writes: [] }
  const first = await openPanel({ items: twoFeeds(), prefs })

  // 起点：没有任何记忆时是默认态
  assert.equal(first.get().filter, 'all')
  assert.equal(first.get().navSelection.kind, 'virtual')
  assert.equal(first.get().navVisible, true)
  assert.equal(prefs.value, undefined, '没动作就不该写盘 —— 读一次面板不产生副作用')

  // **逐个动作各断言一次写入**：persistView 落的是整份 state，若只在最后断言一次，
  // 那么任何单个动作漏写都会被后一个动作的整份写入盖过去 —— 那条守卫就永远没人看。
  first.setFilter('unread')
  await flush()
  assert.deepEqual(prefs.value, { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: true, showUnread: true, onlyRunnable: false, translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES, lastItemId: 'a1' },
    'setFilter 自己就要写一次盘（整份写带上当前选中项 a1）')

  first.selectNav({ kind: 'feed', feedId: 'B' })
  await flush()
  assert.deepEqual(prefs.value, { navSelection: { kind: 'feed', feedId: 'B' }, filter: 'unread', navVisible: true, showUnread: true, onlyRunnable: false, translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES, lastItemId: 'b1' },
    'selectNav 自己就要写一次盘（切源后选中项落到 b1）')

  first.toggleNav()
  await flush()
  assert.equal(prefs.writes.length, 3, '三个关键动作各写一次，不多不少')
  assert.deepEqual(prefs.value, { navSelection: { kind: 'feed', feedId: 'B' }, filter: 'unread', navVisible: false, showUnread: true, onlyRunnable: false, translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES, lastItemId: 'b1' },
    '四个导航/排版状态都必须落盘；lastItemId 只在有选中项时出现')

  // 重开面板：新 store 实例 + 同一份宿主 prefs
  const second = await openPanel({ items: twoFeeds(), prefs })
  assert.equal(second.get().filter, 'unread', 'filter 必须恢复，而不是回 all 初始态')
  assert.equal(second.get().navSelection.kind, 'feed', '选中的源必须恢复')
  assert.equal(second.get().navSelection.feedId, 'B')
  assert.equal(second.get().navVisible, false, '左栏显隐必须恢复')
  assert.equal(second.get().selectedId, 'b1', '阅读位置也必须恢复：重开就停在 b1')
  assert.deepEqual(ids(second.visible()), ['b1'], '恢复后的右栏内容就是「源 B × 未读」')
  // 光标刻意**不**持久化：恢复时按既有规则落到「生效的那一行」（见 src/client/store.ts 的注释）
  assert.deepEqual({ ...second.get().navCursor }, { kind: 'feed', feedId: 'B' },
    '光标落在生效的源那一行 —— 与鼠标点源、shift+o 打开源行同一规则')
})

test('显示未读计数：setShowUnread 落盘、重开面板保持关闭，坏值恢复成默认显示', async () => {
  const prefs = { value: undefined, writes: [] }
  const first = await openPanel({ items: twoFeeds(), prefs })
  assert.equal(first.get().showUnread, true, '默认显示（既有行为）')

  // 一次动作一次整份写：只发 showUnread 会让其他偏好被宿主回落默认
  first.setShowUnread(false)
  await flush()
  assert.equal(first.get().showUnread, false, '关闭立即生效')
  assert.equal(prefs.value?.showUnread, false, '关闭必须写进视图记忆（D27.2）')
  assert.equal(prefs.value?.filter, 'all', '整份写必须带上 filter')
  assert.deepEqual(prefs.value?.navSelection, { kind: 'virtual' }, '整份写必须带上导航选中')
  assert.equal(prefs.value?.lastItemId, 'a1', '整份写必须带上阅读位置')

  const second = await openPanel({ items: twoFeeds(), prefs })
  assert.equal(second.get().showUnread, false, '重开面板（重新读偏好）必须保持关闭')
  assert.equal(prefs.writes.length, 1, '恢复本身不写盘：一次用户动作只写一次')

  second.setShowUnread(true)
  await flush()
  assert.equal(second.get().showUnread, true, '重新打开立即恢复')
  assert.equal(prefs.value?.showUnread, true)
  assert.equal(prefs.writes.length, 2, '第二次动作再写一次')

  // 持久化值不可信：只认布尔 ⇒ "false" / 1 / null 一律回落 true
  for (const raw of ['false', 1, null]) {
    const restored = await openPanel({
      items: twoFeeds(),
      prefs: {
        value: {
          navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true,
          reading: DEFAULT_READING_PREFERENCES, showUnread: raw,
        },
        writes: [],
      },
    })
    assert.equal(restored.get().showUnread, true, '坏 showUnread 必须恢复成显示：' + JSON.stringify(raw))
  }
})

test('选中的标签会记住：重开后回到同一个标签，而不是静默掉回「全部」', async () => {
  // 这条钉的就是 2026-11-14 之前的缺陷：persistView 的手写三元把 tag 投影成 virtual，
  // 按标签筛选生效、落盘却写成「全部」，还顺手覆盖掉上次记住的源/文件夹。
  const prefs = { value: undefined, writes: [] }
  const tags = [{ id: 't1', name: '工作', itemCount: 1 }]
  const first = await openPanel({ items: twoFeeds(), tags, prefs })
  first.selectNav({ kind: 'tag', tagId: 't1' })
  await flush()
  assert.deepEqual(prefs.value.navSelection, { kind: 'tag', tagId: 't1' },
    '落盘必须是 tag —— 写成 virtual 就是这条缺陷本身')

  const second = await openPanel({ items: twoFeeds(), tags, prefs })
  assert.equal(second.get().navSelection.kind, 'tag', '重开后必须回到标签')
  assert.equal(second.get().navSelection.tagId, 't1')
  assert.deepEqual({ ...second.get().navCursor }, { kind: 'tag', tagId: 't1' }, '光标落到标签那一行')
})

test('标签被删掉之后：记忆里的选中态回落虚拟视图，面板照常打开', async () => {
  const prefs = {
    value: { navSelection: { kind: 'tag', tagId: 'gone' }, filter: 'all', navVisible: true, reading: DEFAULT_READING_PREFERENCES },
    writes: [],
  }
  const store = await openPanel({ items: twoFeeds(), tags: [], prefs })
  assert.equal(store.get().navSelection.kind, 'virtual', '标签没了 ⇒ 回落，不抛错也不留一个指向空标签的选中态')
})

test('改字号只动排版：导航、过滤与左栏显隐一项都不许被覆盖（重开后排版也恢复）', async () => {
  // 病象是「调完字号，选中的源和未读筛选没了」——写侧是整份覆盖，只发 reading 就会让
  // sanitizeViewPreferences 把另外三项当缺失而回落默认。判据 = 落库那一份的四个字段。
  const prefs = { value: undefined, writes: [] }
  const first = await openPanel({ items: twoFeeds(), prefs })
  first.setFilter('unread')
  first.selectNav({ kind: 'feed', feedId: 'B' })
  first.toggleNav()                     // 左栏收起 = 布局偏好（navVisible 是它在本协议里的那一位）
  await flush()

  first.setReading({ fontSize: 20 })
  await flush()
  assert.deepEqual(prefs.value, {
    navSelection: { kind: 'feed', feedId: 'B' }, filter: 'unread', navVisible: false, showUnread: true, onlyRunnable: false,
    translateTarget: 'zh-CN', reading: { fontSize: 20, lineWidth: 760, theme: 'auto', expandImages: true }, lastItemId: 'b1',
  }, '写盘落的必须是整份 state：只发 reading 会让另外三项回落默认')

  first.setReading({ theme: 'dark' })
  await flush()
  assert.deepEqual(prefs.value.reading, { fontSize: 20, lineWidth: 760, theme: 'dark', expandImages: true },
    '同一份排版里改另一个字段时，前一次的选择必须留着（合并而不是覆盖）')

  const second = await openPanel({ items: twoFeeds(), prefs })
  // 展开一层再断言：store 对象活在 vm 沙箱的 realm 里，原型不同会让 deepEqual 形同虚设地红
  assert.deepEqual({ ...second.get().reading }, { fontSize: 20, lineWidth: 760, theme: 'dark', expandImages: true }, '重开面板后字号与主题必须恢复')
  assert.equal(second.get().navSelection.feedId, 'B', '重开后选中的源仍然是 B')
  assert.equal(second.get().filter, 'unread', '重开后 filter 仍然是 unread')
  assert.equal(second.get().navVisible, false, '重开后左栏仍然收着')
})

test('持久化值不可信时（未知 feedId / 非法 shape）回落默认值且不抛错', async () => {
  const ghost = { value: { navSelection: { kind: 'feed', feedId: 'ghost' }, filter: 'unread', navVisible: false }, writes: [] }
  // 不用 openPanel：这条还要看**调用序列**。未知 feedId 若没在读侧被挡掉，恢复后会按它向宿主
  // 取一次源页（R14 的恢复重取）—— 那次请求本身就是缺陷的可见形态，最终 state 回不回落是后话。
  const exports = loadExports({ items: twoFeeds(), prefs: ghost })
  const store = exports.createReaderStore()
  await store.load('overview')
  await flush()
  assert.equal(store.get().navSelection.kind, 'virtual', '源已退订 ⇒ 回落虚拟视图，而不是留一个指向不存在源的选中态')
  assert.deepEqual(ids(store.visible()), ['a1', 'a2', 'b1'], '回落之后右栏必须能看到条目（不是空列表）')
  assert.deepEqual(
    exports.__calls().filter(([endpoint, payload]) => endpoint === 'overview' && payload?.feedId !== undefined),
    [],
    '读侧不校验形状 ⇒ 会把一个已知无效的 feedId 当成真的范围发给宿主；回落必须发生在请求之前',
  )

  // 三项**全部**非法时整份回落默认
  for (const value of [
    'not-an-object', 0, null, true, [],
    { navSelection: { kind: 'nope' }, filter: 'bogus', navVisible: 'yes' },
    { navSelection: { kind: 'feed', feedId: 7 }, filter: null, navVisible: 1 },
    { navSelection: null, filter: [], navVisible: null },
  ]) {
    const junk = await openPanel({ items: twoFeeds(), prefs: { value, writes: [] } })
    assert.equal(junk.get().filter, 'all', '非法 filter 回落 all：' + JSON.stringify(value))
    assert.equal(junk.get().navVisible, true, '非法 navVisible 回落 true：' + JSON.stringify(value))
    assert.equal(junk.get().navSelection.kind, 'virtual', '非法 navSelection 回落虚拟视图：' + JSON.stringify(value))
  }
  // 单字段非法时只回落那一项 —— 合法的那几项必须原样恢复（否则一次坏值抹掉更多记忆）
  const onlyFilterBad = await openPanel({
    items: twoFeeds(),
    prefs: { value: { navSelection: { kind: 'feed', feedId: 'B' }, filter: 'bogus', navVisible: false }, writes: [] },
  })
  assert.equal(onlyFilterBad.get().filter, 'all', '非法 filter 回落 all')
  assert.equal(onlyFilterBad.get().navVisible, false, 'navVisible 合法则原样恢复')
  assert.equal(onlyFilterBad.get().navSelection.feedId, 'B', 'navSelection 合法则原样恢复')

  // 排版的坏值同样只回落它自己：字号认不出时，导航那三项照常恢复
  const badReading = await openPanel({
    items: twoFeeds(),
    prefs: { value: { navSelection: { kind: 'feed', feedId: 'B' }, filter: 'unread', navVisible: false, reading: { fontSize: 999, theme: 'neon' } }, writes: [] },
  })
  assert.deepEqual({ ...badReading.get().reading }, { fontSize: 16, lineWidth: 760, theme: 'auto', expandImages: true }, '档位外的排版值回落默认')
  assert.equal(badReading.get().navSelection.feedId, 'B', '排版坏了不该带走导航记忆')
  assert.equal(badReading.get().filter, 'unread', '排版坏了不该带走 filter')

  // 逐字段独立回落：坏掉一项不该把另外两项的记忆一起抹掉
  const partial = await openPanel({
    items: twoFeeds(),
    prefs: { value: { navSelection: { kind: 'feed', feedId: 'B' }, filter: 'bogus', navVisible: false }, writes: [] },
  })
  assert.equal(partial.get().filter, 'all')
  assert.equal(partial.get().navVisible, false, 'filter 坏了不该带走 navVisible')
  assert.equal(partial.get().navSelection.feedId, 'B', 'filter 坏了不该带走选中的源')
})

test('写盘失败必须可见：进 error 而不是被吞掉', async () => {
  const prefs = { value: undefined, writes: [] }
  const exports = loadExports({ items: twoFeeds(), prefs, failSave: true })
  const store = exports.createReaderStore()
  await store.load('overview')
  await flush()

  store.toggleNav()
  await flush()

  assert.ok(store.get().error !== undefined, '写盘失败的异常必须有可见后果（AGENTS.md 禁空 catch）')
  assert.match(String(store.get().error), /写盘失败|internal/)
  assert.equal(store.get().navVisible, false, '持久化失败不该回滚界面上的状态 —— 那是两件事')
})

test('恢复是异步的：用户在它到达之前的手势不会被旧记忆盖掉（整份让位）', async () => {
  // 面板一挂载就 load，而恢复要等一次读端点往返。这中间用户可以按 u —— 若恢复无条件覆盖，
  // 表现是「按了没反应，过一会儿左栏自己弹回来」。判据就是这条时序。
  //
  // 裁决：**手势一旦发生就整份让位**，不做「碰过的那项让位、其余照常恢复」的逐项合并。
  // 理由是那条合并路径自己会制造矛盾状态 —— 手势已经把「当前 state」整份写进存储了
  //（persistView 落的是三项），此时的 state 才是存储里的真值；再拿旧记忆回填没被碰的那两项，
  // 就会出现「界面显示 unread，存储里记着 all」，下次重开又变回 all，用户更无从理解。
  // 代价如实说明：恢复窗口（一次本机 RPC 往返）内发生的手势，会用当时的状态覆盖全部记忆。
  const prefs = { value: { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: true }, writes: [] }
  const exports = loadExports({ items: twoFeeds(), prefs })
  const store = exports.createReaderStore()
  const loading = store.load('overview')   // 刻意不 await：模拟「还在读」的那一刻
  store.toggleNav()                        // 用户此刻按了 u
  assert.equal(store.get().navVisible, false, '前置条件：手势已经生效')
  await loading
  await flush()

  assert.equal(store.get().navVisible, false, '恢复不得盖掉用户已经做过的手势')
  assert.equal(store.get().filter, 'all', '整份让位：手势那一刻的状态就是新的记忆（存储里也是它）')
  assert.deepEqual(prefs.value, { navSelection: { kind: 'virtual' }, filter: 'all', navVisible: false, showUnread: true, onlyRunnable: false, translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES },
    '存储里必须是与界面一致的那份 —— 两者不一致才是真正的缺陷')
})

test('写盘串行化：前一次慢、后一次快时，最终的记忆是「后一次动作」', async () => {
  // 不串行化时两个请求会同时在飞，先发但慢的那个最后落地 —— 记忆回退成用户更早的状态，
  // 表现为「选了源、重开面板却回到上一个源」。判据是最终落库的值 + 落地顺序。
  const prefs = { value: { navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true }, writes: [], order: [] }
  const exports = loadExports({ items: twoFeeds(), prefs, writeDelayMs: [40, 0] })
  const store = exports.createReaderStore()
  await store.load('overview')
  await flush()

  store.setFilter('unread')                              // 第一次写：慢（40ms）
  store.selectNav({ kind: 'feed', feedId: 'B' })         // 第二次写：快
  await new Promise((resolve) => setTimeout(resolve, 120))

  assert.equal(prefs.writes.length, 2, '两次动作各写一次')
  assert.deepEqual(prefs.value, { navSelection: { kind: 'feed', feedId: 'B' }, filter: 'unread', navVisible: true, showUnread: true, onlyRunnable: false, translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES, lastItemId: 'b1' },
    '最终记忆必须是最新动作那一份，而不是最后落地的那个请求')
  assert.deepEqual(prefs.writes[0], { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: true, showUnread: true, onlyRunnable: false, translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES, lastItemId: 'a1' },
    '串行化：第一次写的是动作发生时的状态（当时还没选源，选中项是 a1）')
  assert.deepEqual(prefs.writes[1], { navSelection: { kind: 'feed', feedId: 'B' }, filter: 'unread', navVisible: true, showUnread: true, onlyRunnable: false, translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES, lastItemId: 'b1' })
  // 顺序即「按动作先后」，与 setFilter 里那句注释同一条判据
  assert.deepEqual((() => {
    const s = store.get()
    return {
      navSelection: s.navSelection.kind === 'feed' ? { kind: 'feed', feedId: s.navSelection.feedId } : { kind: 'virtual' },
      filter: s.filter, navVisible: s.navVisible, showUnread: s.showUnread, onlyRunnable: s.onlyRunnable, translateTarget: s.translateTarget, reading: { ...s.reading },
      ...(s.selectedId === undefined ? {} : { lastItemId: s.selectedId }),
    }
  })(), prefs.value, '界面状态与存储里的记忆必须一致')
})

test('只在关键动作时写盘：移动光标（每次按键）不产生写入', async () => {
  const prefs = { value: { navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true }, writes: [] }
  const store = await openPanel({ items: twoFeeds(), prefs })
  assert.equal(prefs.writes.length, 0, '前置条件：恢复本身不写盘（否则每次打开都回写一遍同样的值）')

  store.moveNavCursor(1)
  store.moveNavCursor(1)
  store.moveNavCursor(-1)
  await flush()
  assert.equal(prefs.writes.length, 0,
    '光标移动不是被记忆的状态：它每按一次都发生，写盘只会把域写热而记不住任何东西（取舍见报告）')

  store.toggleNav()
  await flush()
  assert.equal(prefs.writes.length, 1, '真正被记忆的动作才写一次')
})

/* ============================ ③b 阅读位置：回到上次那一行（R2-01） ============================ */

test('阅读位置：选中变化去抖写一次，保存内容含 lastItemId', async () => {
  // 为什么必须去抖：j/k 每次移动都会换选中，逐次写盘等于每按一次键就写一次域。
  // 判据钉行为而不是实现常量：不当场写；把待写定时器推进之后，恰好落一次。
  const timers = fakeTimers()
  const prefs = { value: undefined, writes: [] }
  const store = await openPanel({ items: twoFeeds(), prefs, timers })
  assert.equal(store.get().selectedId, 'a1', '前置：没有记忆时与今天一致（落在作用域第一条）')

  store.select('b1')
  assert.equal(prefs.writes.length, 0, '选中不当场写盘')
  assert.equal(timers.pending().length, 1, '选中变化必须排一次写')
  timers.runAll()
  await flush()
  assert.equal(prefs.writes.length, 1, '一次去抖只写一次')
  assert.equal(prefs.value.lastItemId, 'b1', '保存内容必须含 lastItemId')

  // **整份覆盖写**：普通导航（切左栏显隐）不换选中，但会重写整份偏好 ——
  // 若写入口没带上当下的选中项，这一下就把阅读位置抹了（本项最容易踩的坑）。
  store.toggleNav()
  await flush()
  assert.equal(prefs.writes.length, 2, 'toggleNav 自己写一次')
  assert.equal(prefs.value.lastItemId, 'b1', '普通导航的整份写必须携带当下的选中项')
})

test('阅读位置：重开面板选中上次那一行，且恢复本身不写盘', async () => {
  const timers = fakeTimers()
  const prefs = { value: undefined, writes: [] }
  const first = await openPanel({ items: twoFeeds(), prefs, timers })
  first.select('b1')
  first.flushViewMemory()               // 等价于关面板：把待写值立刻落盘
  await flush()
  assert.equal(prefs.value.lastItemId, 'b1', '前置：记忆里已经是 b1')

  const second = await openPanel({ items: twoFeeds(), prefs, timers: fakeTimers() })
  assert.equal(second.get().selectedId, 'b1', '重开面板必须选中上次停留的那一行')
  assert.equal(prefs.writes.length, 1, '恢复只读不写：重开面板不产生 saveViewPreferences')

  // 恢复不是打开：读态不变，也不触发阅读进度写回（用户故事 11/12）
  const third = loadExports({ items: twoFeeds(), prefs, timers: fakeTimers() })
  const restored = third.createReaderStore()
  await restored.load('overview')
  await flush()
  assert.equal(restored.get().items.every((entry) => entry.readAt === undefined), true,
    '恢复前后任何条目的读态都不许变（恢复不是打开）')
  assert.equal(third.__calls().some(([endpoint]) => endpoint === 'markRead' || endpoint === 'unmarkRead'), false,
    '恢复不得调用标读端点')
  assert.equal(third.__calls().some(([endpoint]) => endpoint === 'saveReadingProgress'), false,
    '恢复不得产生阅读进度写回')
})

test('阅读位置：上次那一条不在当前页 ⇒ 不选中，也不额外取数', async () => {
  const prefs = {
    value: {
      navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true,
      reading: DEFAULT_READING_PREFERENCES, lastItemId: 'gone',
    },
    writes: [],
  }
  const exports = loadExports({ items: twoFeeds(), prefs })
  const store = exports.createReaderStore()
  await store.load('overview')
  await flush()

  assert.equal(store.get().selectedId, undefined, '条目已被清理 ⇒ 面板正常打开、没有选中行')
  assert.deepEqual(ids(store.visible()), ['a1', 'a2', 'b1'], '列表照常可见（不是空面板）')
  assert.equal(exports.__pageCalls().length, 1, '不在当前页就不额外取数：只发生了挂载那一次 overview')
  assert.equal(prefs.writes.length, 0, '恢复不写盘')
})

test('阅读位置：上次的源已退订 ⇒ 回落「全部」，其他视图偏好照常恢复', async () => {
  const prefs = {
    value: {
      navSelection: { kind: 'feed', feedId: 'gone' }, filter: 'all', navVisible: true,
      reading: DEFAULT_READING_PREFERENCES, lastItemId: 'a2',
    },
    writes: [],
  }
  const store = await openPanel({ items: twoFeeds(), prefs })
  assert.equal(store.get().navSelection.kind, 'virtual', '已退订的源回落虚拟视图 —— 面板打得开比记得住更重要')
  assert.deepEqual(ids(store.visible()), ['a1', 'a2', 'b1'], '回落之后右栏是「全部」而不是空范围')
  assert.equal(store.get().selectedId, 'a2', 'lastItemId 是另一项视图偏好，不随源失效一起丢')
  assert.equal(store.get().navVisible, true, '其他偏好不丢')
})

test('阅读位置：旧配置没有 lastItemId 时正常读入，其他偏好一项不丢', async () => {
  const prefs = {
    value: {
      navSelection: { kind: 'feed', feedId: 'B' }, filter: 'unread', navVisible: false,
      reading: { fontSize: 20, lineWidth: 900, theme: 'dark', expandImages: true },
    },
    writes: [],
  }
  const store = await openPanel({ items: twoFeeds(), prefs })
  assert.equal(store.get().navSelection.kind, 'feed', '旧配置的源选中必须保住')
  assert.equal(store.get().filter, 'unread')
  assert.equal(store.get().navVisible, false)
  assert.deepEqual({ ...store.get().reading }, { fontSize: 20, lineWidth: 900, theme: 'dark', expandImages: true })
  assert.equal(store.get().selectedId, 'b1', '没有阅读位置时按既有规则落在作用域第一条')
  assert.equal(prefs.writes.length, 0, '旧配置被读一次也不产生写')
})

test('阅读位置：flushViewMemory 只写待写值，没有待写值不制造空写', async () => {
  const timers = fakeTimers()
  const prefs = { value: undefined, writes: [] }
  const store = await openPanel({ items: twoFeeds(), prefs, timers })

  store.flushViewMemory()
  await flush()
  assert.equal(prefs.writes.length, 0, '没有待写值时 flush 不写 —— 否则每次打开/关闭面板都白热一次存储')

  store.select('b1')
  assert.equal(timers.pending().length, 1, '前置：有一次待写')
  store.flushViewMemory()
  assert.equal(timers.pending().length, 0, 'flush 必须先取消待写定时器（否则随后还会再写一次）')
  store.flushViewMemory()
  await flush()
  assert.equal(prefs.writes.length, 1, '一次待写只落一次')
  assert.equal(prefs.value.lastItemId, 'b1', '落的是当下选中项')
})

test('阅读位置：打开条目（activate）也排一次写 —— 正文里关面板能记住那一篇', async () => {
  const timers = fakeTimers()
  const prefs = { value: undefined, writes: [] }
  const store = await openPanel({ items: twoFeeds(), prefs, timers })
  store.activate('a2')
  await flush()
  assert.equal(timers.pending().length, 1, '打开条目也要进入写手（否则正文里关面板会丢掉那一篇）')
  store.flushViewMemory()
  await flush()
  assert.equal(prefs.value.lastItemId, 'a2')
})

test('阅读位置：恢复到达前用户先选了另一行 ⇒ 恢复整份让位，不把选中拽回去', async () => {
  // 时机与「按 u」那条既有用例同形：面板一挂载就 load，恢复要等一次读端点往返。
  // 这次用户的手势是**选中条目**（纯选中也是「已动手」，见实现决策 8）。
  const timers = fakeTimers()
  const prefs = {
    value: {
      navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true,
      reading: DEFAULT_READING_PREFERENCES, lastItemId: 'a1',
    },
    writes: [],
  }
  const exports = loadExports({ items: twoFeeds(), prefs, timers })
  const store = exports.createReaderStore()
  const loading = store.load('overview')   // 刻意不 await：模拟恢复还在路上
  store.select('b1')
  assert.equal(store.get().selectedId, 'b1', '前置：用户手势已经生效')
  await loading
  await flush()

  assert.equal(store.get().selectedId, 'b1', '迟到的恢复不得把选中拽回 a1')
  timers.runAll()
  await flush()
  assert.equal(prefs.value.lastItemId, 'b1', '手势那一刻的选中项成为新记忆')
})

/* ============================ ③c 列表滚动位置：滚回原处（R2-02） ============================ */

/** 一份合法的视图记忆（旧配置形状 = 没有两个位置字段）。 */
const savedView = (overrides = {}) => ({
  navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true,
  reading: DEFAULT_READING_PREFERENCES, ...overrides,
})

test('列表滚动位置：滚动去抖写一次，保存内容含 lastListScrollTop', async () => {
  // 滚动是高频动作：每帧写盘会把域写热，所以它必须和选中共用同一个去抖写手。
  // 判据钉行为而不是实现常量：不当场写；把待写定时器推进之后，恰好落一次。
  // 同时钉住整份覆盖写那条最容易踩的坑：普通导航不换滚动位置，但会把整份偏好重写一遍 ——
  // 写入口少带 lastListScrollTop，一次切左栏就把位置抹了。
  const timers = fakeTimers()
  const prefs = { value: undefined, writes: [] }
  const store = await openPanel({ items: twoFeeds(), prefs, timers })

  store.rememberListScrollTop(640)
  assert.equal(prefs.writes.length, 0, '滚动不当场写盘')
  assert.equal(timers.pending().length, 1, '滚动必须排一次去抖写')

  // 连续滚动重新计时，只在停下来之后写一次
  store.rememberListScrollTop(720)
  store.rememberListScrollTop(800)
  assert.equal(timers.pending().length, 1, '连续滚动不许叠加出多个待写')
  timers.runAll()
  await flush()
  assert.equal(prefs.writes.length, 1, '一次滚动序列只写一次')
  assert.equal(prefs.value.lastListScrollTop, 800, '保存内容必须含 lastListScrollTop')
  assert.equal(prefs.value.lastItemId, 'a1', '整份写必须同时带上当下的选中项')

  store.toggleNav()
  await flush()
  assert.equal(prefs.writes.length, 2, 'toggleNav 自己写一次')
  assert.equal(prefs.value.lastListScrollTop, 800, '普通导航的整份写必须携带滚动位置（否则一次导航就抹掉）')
})

test('列表滚动位置：滚动后立刻关面板（flush）也记住', async () => {
  // 去抖窗口 300ms：读者滚完立刻关面板，定时器会被清掉 —— 若卸载不 flush，最后那个位置就丢了。
  const timers = fakeTimers()
  const prefs = { value: undefined, writes: [] }
  const store = await openPanel({ items: twoFeeds(), prefs, timers })

  store.rememberListScrollTop(900)
  assert.equal(timers.pending().length, 1, '前置：有一次待写')
  store.flushViewMemory()
  assert.equal(timers.pending().length, 0, 'flush 必须先取消待写定时器（否则随后还会再写一次）')
  await flush()
  assert.equal(prefs.writes.length, 1, '一次待写只落一次')
  assert.equal(prefs.value.lastListScrollTop, 900, 'flush 必须带上滚动位置')
  assert.equal(prefs.value.lastItemId, 'a1', 'flush 同时也带当下选中项')
})

test('列表滚动位置：恢复值只被取一次，取过就清空；恢复本身不写盘', async () => {
  const prefs = { value: savedView({ lastListScrollTop: 640 }), writes: [] }
  const store = await openPanel({ items: twoFeeds(), prefs })
  assert.equal(store.takeListScrollTop(2000), 640, '面板首屏后能按当前可滚范围取到恢复值')
  assert.equal(store.takeListScrollTop(2000), undefined, '取过即清空 —— 第二次什么都不做')
  assert.equal(prefs.writes.length, 0, '恢复只读不写（打开面板不产生 saveViewPreferences）')
})

test('列表滚动位置：取恢复值时按当前可滚范围夹取，夹取后的写回不排写', async () => {
  // 存进去的是 9999，当前容器只能滚到 2700。夹取必须在 store 里完成并把**夹取后的值**
  // 记成「上一次的位置」—— 面板随后写 DOM 时浏览器会派发一次 scroll，若记的是 9999，
  // 监听器会把这次程序化写回当成用户滚动，排出一次纯属恢复副作用的写盘。
  const timers = fakeTimers()
  const prefs = { value: savedView({ lastListScrollTop: 9999 }), writes: [] }
  const store = await openPanel({ items: twoFeeds(), prefs, timers })
  assert.equal(store.takeListScrollTop(2700), 2700, '9999 必须夹到当前最大可滚位置 2700')
  store.rememberListScrollTop(2700)        // 等价于浏览器为程序化写回派发的 scroll 事件
  assert.equal(timers.pending().length, 0, '夹取后的值与记忆一致，不得排一次写')
  timers.runAll()
  await flush()
  assert.equal(prefs.writes.length, 0, '恢复（含它触发的 scroll）不写盘')
})

test('列表滚动位置：恢复到达前用户已滚动 ⇒ 选中与滚动都不被旧记忆覆盖', async () => {
  // 滚动同样是用户手势：恢复还在路上时用户先滚过，迟到的恢复就不许再动这个列表 ——
  // 既不能重置滚动，也不能把选中拽回旧记忆那一行（否则视口会被「跟随选中」再次拉走）。
  const timers = fakeTimers()
  const prefs = { value: savedView({ lastItemId: 'b1', lastListScrollTop: 640 }), writes: [] }
  const exports = loadExports({ items: twoFeeds(), prefs, timers })
  const store = exports.createReaderStore()
  const loading = store.load('overview')   // 刻意不 await：模拟恢复还在路上
  store.rememberListScrollTop(120)
  assert.equal(timers.pending().length, 1, '前置：用户的滚动已经排了一次写')
  await loading
  await flush()

  assert.equal(store.takeListScrollTop(2000), undefined, '用户已经滚过 ⇒ 旧滚动位置必须放弃，不许覆盖他刚滚到的地方')
  assert.equal(store.get().selectedId, 'a1', '滚动也是用户手势：选中恢复同样让位（保留 overview 落地的第一条）')
})

test('阅读位置：同一个 store 卸载后再挂载（会话结束）会重新读记忆', async () => {
  // 真实宿主只在 apply() 里建一次 store；面板切走再回来时组件重挂、store 不重建。
  // 若恢复标志位停在「已恢复 / 已动手」，第二次挂载就再也不会读记忆。
  const timers = fakeTimers()
  const prefs = { value: savedView({ lastItemId: 'b1', lastListScrollTop: 640 }), writes: [] }
  const store = await openPanel({ items: twoFeeds(), prefs, timers })
  assert.equal(store.get().selectedId, 'b1', '前置：第一次挂载恢复选中 b1')
  assert.equal(store.takeListScrollTop(2000), 640, '前置：第一次挂载取到滚动位置')
  store.flushViewMemory()                  // 等价于面板卸载：会话结束

  // 两次挂载之间记忆可能被别的面板改写（视图记忆是单槽，以最后写入为准）。
  // 第二次挂载必须重新读，而不是沿用上一次的恢复结果。
  prefs.value = savedView({ lastItemId: 'a2', lastListScrollTop: 300 })
  await store.load('overview')
  await flush()

  assert.equal(store.get().selectedId, 'a2', '第二次挂载必须重新读记忆并恢复选中')
  assert.equal(store.takeListScrollTop(2000), 300, '第二次挂载必须重新交接滚动位置')
  assert.equal(prefs.writes.length, 0, '两次恢复都只读不写')
})

/* ============================ ④ 老域能否打开（必须实测） ============================ */

/**
 * 找真实的 JsonStorageBackend。
 *
 * 为什么必须是**真实后端**：站点要证明的是「老用户升级后还能打开域」，而版本检查、global 的
 * null 哨兵语义都发生在后端与设施的边界上（lib/types/spec.d.ts:83-89、storage-json 的 format.ts）。
 * 自己写一个内存 KvUnit 来「模拟」后端，等于把待验证的那一层换成我的理解 —— 那就是猜测冒充实测。
 * 本仓不链 dsh-storage-json（scripts/build.sh 只链了 storage-domain），故按 checkout 现取。
 */
async function realJsonBackendClass() {
  const home = process.env['HOME'] ?? ''
  const candidates = [
    process.env['DSH_CHECKOUT'], join(home, 'dsh-harness'), join(home, 'dsh'),
    join(home, '.dsh', 'dsh-harness'), join(home, 'deepseek-harness'),
  ].filter((candidate) => candidate !== undefined && candidate !== '')
  const install = () => import('@deepseek-ai/dsh-storage-json').then((module) => module.JsonStorageBackend)
  for (const checkout of candidates) {
    const paths = [
      join(checkout, 'packages', 'storage', 'storage-json', 'lib', 'index.js'),
      join(checkout, 'apps', 'cli', 'node_modules', '@deepseek-ai', 'dsh-base', 'node_modules', '@deepseek-ai', 'dsh-storage-json', 'lib', 'index.js'),
    ]
    for (const path of paths) {
      if (existsSync(path)) return (await import(pathToFileURL(path).href)).JsonStorageBackend
    }
  }
  // 兜底：万一将来被链进 node_modules
  try {
    return await install()
  } catch (error) {
    throw new Error('找不到真实 @deepseek-ai/dsh-storage-json（本用例需要它；试过 ' + candidates.join(' / ') + '）：' + String(error))
  }
}

/** 用真实后端 + 真实 DomainFacility 打开一个**手工构造的老域文件**。 */
async function openRealDomain({ name, schema, initial, tables, fileContent }) {
  const { DomainFacility, defineDomain, domainTable } = await import('@deepseek-ai/dsh-storage-domain')
  const JsonStorageBackend = await realJsonBackendClass()
  const dir = mkdtempSync(join(tmpdir(), 'rss-legacy-domain-'))
  const file = join(dir, name + '.json')
  writeFileSync(file, JSON.stringify(fileContent, null, 2) + '\n')
  const backend = new JsonStorageBackend(dir)
  const ctx = {
    emit: () => {},
    logger: { warn: (message) => console.warn('[legacy-domain]', message), error: (message) => console.warn('[legacy-domain]', message) },
    storage: { backend: { get: (backendName) => (backendName === 'json' ? backend : undefined) } },
  }
  const facility = new DomainFacility(ctx, { backend: 'json', routes: {} })
  const spec = defineDomain({ name, version: 1, global: { schema, initial }, tables })
  return { domain: await facility.open(spec), file, dir }
}

test('老域（文件里没有 global）能正常打开并回落到 initial', async () => {
  const { z } = await import('zod')
  const tables = { feeds: (await import('@deepseek-ai/dsh-storage-domain')).domainTable(z.object({ url: z.string() }).strict()) }
  const initial = { navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true }
  // ① 老文件**完全没有 global 键**（升级前写下的形态）② 老文件里 global 是 null（本机实测的形态）
  const legacyVariants = {
    '没有 global 键': { unit: { name: 'rss_reader_legacy_a', version: 1 }, tables: { feeds: { f1: { url: 'f1' } } } },
    'global 为 null': { unit: { name: 'rss_reader_legacy_b', version: 1 }, global: null, tables: { feeds: { f1: { url: 'f1' } } } },
  }
  let index = 0
  for (const [label, content] of Object.entries(legacyVariants)) {
    index += 1
    const name = 'rss_reader_legacy_' + (index === 1 ? 'a' : 'b')
    const { domain, file } = await openRealDomain({
      name,
      // 与 src/domain.ts 的 global 槽**同一形状**：必须非 null，但形状不合格也不许拒绝
      schema: z.unknown().refine((value) => value !== null),
      initial, tables, fileContent: content,
    })
    assert.deepEqual(domain.global.get(), initial, label + '：媒介没有 global 时必须回落到 initial')
    assert.equal(domain.table('feeds').size, 1, label + '：原有的表记录必须原样还在（老用户的数据没被弄丢）')

    // 真的写一次：老文件被就地补上 global，且版本维持 1、表记录不丢
    await domain.global.set({ navSelection: { kind: 'feed', feedId: 'f1' }, filter: 'unread', navVisible: false })
    await domain.close()
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(written.unit.version, 1, '版本必须仍是 1 —— 升 version 会让老用户打不开域（src/domain.ts 有实测记录）')
    assert.deepEqual(written.global, { navSelection: { kind: 'feed', feedId: 'f1' }, filter: 'unread', navVisible: false }, label + '：首次 set 才落盘')
    assert.deepEqual(written.tables.feeds, { f1: { url: 'f1' } }, label + '：补 global 不得动表数据')
  }
})

test('readerDomain 的 global 槽：非 null 约束满足设施要求，且 version 仍是 1', () => {
  assert.equal(readerDomain.version, 1, '禁止改 version：single layout 下版本是硬相等检查')
  assert.ok(readerDomain.global !== undefined, 'UI 偏好走 global 单例槽，不新增表')
  assert.deepEqual(Object.keys(readerDomain.tables).sort(), ['cursors', 'feeds', 'items'], '禁止新增 domain 表')
  assert.equal(readerDomain.global.schema.safeParse(null).success, false,
    'null 是「从未写过」的哨兵：global schema 必须拒绝 null（defineDomain 也会因此抛错）')
})

test('sanitizeViewPreferences：translateTarget 只认语言表里的 id，认不出回落 zh-CN', () => {
  // R7 02 / spec §5.3：默认简体中文；旧配置没这个键 ⇒ 补默认，不许因为缺字段回落整份记忆。
  assert.equal(DEFAULT_VIEW_PREFERENCES.translateTarget, 'zh-CN')
  for (const language of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
    assert.equal(sanitizeViewPreferences({ translateTarget: language }).translateTarget, language,
      '合法语言必须原样保留：' + language)
  }
  for (const raw of ['fr', 'zh-cn', '', 1, null, true, {}, []]) {
    const value = sanitizeViewPreferences({ translateTarget: raw, filter: 'unread' })
    assert.equal(value.translateTarget, 'zh-CN', '认不出的语言回落默认：' + JSON.stringify(raw))
    assert.equal(value.filter, 'unread', '坏语言不许带走其它记忆字段')
  }
  assert.equal(sanitizeViewPreferences({}).translateTarget, 'zh-CN', '旧配置缺字段时补默认值')
})

// ── R15 06：「只看可跑」是视图记忆，不是 config.rsshub 的第四个字段 ──────────────

test('sanitizeViewPreferences：onlyRunnable 只判布尔，缺省 / 认不出回落 false', () => {
  assert.equal(DEFAULT_VIEW_PREFERENCES.onlyRunnable, false, '默认不启用「只看可跑」')
  assert.equal(sanitizeViewPreferences({ onlyRunnable: true }).onlyRunnable, true, 'true 必须保留')
  assert.equal(sanitizeViewPreferences({ onlyRunnable: false }).onlyRunnable, false, 'false 必须保留')

  for (const raw of ['true', 'false', 1, 0, null, {}, []]) {
    assert.equal(
      sanitizeViewPreferences({ onlyRunnable: raw }).onlyRunnable,
      false,
      '认不出的值必须回落 false：' + JSON.stringify(raw),
    )
  }

  // 与其他字段同一条规则：一次坏值只抹掉它自己，不许带走导航记忆。
  const partial = sanitizeViewPreferences({
    navSelection: { kind: 'feed', feedId: 'A' }, onlyRunnable: 'yes',
  })
  assert.equal(partial.navSelection.kind, 'feed')
  assert.equal(partial.onlyRunnable, false)
})

// ── R15 06：「只看可跑」的持久化（重启后保持，且不污染 config.rsshub）──────────

test('端点：onlyRunnable=true 落盘并原样读回（重启后保持）', async () => {
  const store = memoryStore()
  const preferences = {
    navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true, showUnread: true, onlyRunnable: true,
    translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES,
  }
  const saved = await callEndpoint(store, 'saveViewPreferences', { preferences })
  assert.deepEqual(saved.preferences, preferences, 'onlyRunnable 必须真的过端点')
  const read = await callEndpoint(store, 'viewPreferences', {})
  assert.deepEqual(read.preferences, preferences, '重开面板读到的必须仍是 true')
})

test('客户端：重开面板时 onlyRunnable 从视图记忆恢复（默认 false）', async () => {
  const defaultPrefs = { value: undefined, writes: [] }
  const fresh = await openPanel({ items: twoFeeds(), prefs: defaultPrefs })
  assert.equal(fresh.get().onlyRunnable, false, '没有记忆时默认不启用「只看可跑」')

  const prefs = {
    value: {
      navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true, showUnread: true, onlyRunnable: true,
      translateTarget: 'zh-CN', reading: DEFAULT_READING_PREFERENCES,
    },
    writes: [],
  }
  const reopened = await openPanel({ items: twoFeeds(), prefs })
  assert.equal(reopened.get().onlyRunnable, true, '视图记忆里的 true 必须在重开后生效')
})
