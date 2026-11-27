/**
 * R15 09：从精选源包**导入所选**（spec §4.3.2 / §6 A14）。
 *
 * 为什么单开一份：08 的 source-pack-client.test.mjs 钉的是清单的增删与加源校验；这一层钉的是
 * 「勾选 → 拼 OPML → 复用宿主 opmlImport → 逐条结果」这条链路，以及它必须守住的边界：
 *  - 一次最多 30 条：31 条**一个请求都不发**，30 条照常发（阈值两侧都测）；
 *  - OPML 由客户端最小序列化，但必须被**宿主真实 parseOpml** 解析回同样的 URL 与 folder；
 *  - 导入结果原样映射（新增 / 已存在 / 失败逐条带原因 / 文件内跳过），失败条目不入库；
 *  - 导入不动源包清单（清单不是订阅），订阅列表按既有 opmlImport 路径重取。
 *
 * 观测点都在公开边界：store 的动作 + 真实构建产物 + 宿主 lib/opml.js，不碰内部字段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientModule } from './helpers/client-channel.mjs'
import { parseOpml } from '../lib/opml.js'

const ENTRY = (url, extra = {}) => ({
  url,
  title: '源 ' + url,
  addedAt: '2026-10-10T00:00:00.000Z',
  ...extra,
})

async function waitFor(check, label) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待超时：' + label)
}

/**
 * 真实客户端 store + 记录调用序列的假 rpc。
 * `importReport` 是 opmlImport 的回包；`importError` 用来走失败分支。
 */
function makeStore(options = {}) {
  const entries = options.entries ?? [
    ENTRY('https://a.example/feed', { category: '科技' }),
    ENTRY('https://b.example/feed', { category: '播客' }),
  ]
  const calls = []
  const snapshot = { entries, seed: { collectedAt: '2026-10-10', count: 79 } }
  const importReport = options.importReport ?? { added: 0, existed: 0, failed: [], skipped: [], accepted: [] }
  const held = []
  const { exports } = loadClientModule({ AbortController, setTimeout, clearTimeout, URL })
  const store = exports.createReaderStore({
    rpc: async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'sourcePack') return { sourcePack: snapshot }
      if (endpoint === 'saveSourcePack') {
        return { sourcePack: { entries: payload.entries, seed: snapshot.seed }, dropped: 0, restored: 0 }
      }
      if (endpoint === 'opmlImport') {
        if (options.importError !== undefined) throw new Error(options.importError)
        if (options.holdImport === true) return await new Promise((resolve) => { held.push(resolve) })
        return importReport
      }
      if (endpoint === 'overview') {
        return { feeds: options.feeds ?? [], folders: [], tags: [], items: [], unread: 0, perFeedUnread: {}, refreshed: false }
      }
      return { changed: 1, unread: 0 }
    },
  })
  return {
    store, calls, entries, importReport, exports,
    /** 放行被 holdImport 扣住的导入回包（模拟「30 条正在逐源校验」的长窗口）。 */
    releaseImport: () => { for (const resolve of held.splice(0)) resolve(importReport) },
  }
}

async function openPack(h) {
  h.store.openSourcePack()
  await waitFor(() => h.store.get().sourcePack?.loading === false, 'sourcePack 回包')
}

test('勾选：按 URL 勾选 / 取消；删除条目后勾选里不再残留已删条目', async () => {
  const h = makeStore()
  await openPack(h)
  assert.deepEqual([...h.store.get().sourcePack.selected], [], '打开视图时没有勾选')

  h.store.toggleSourcePackSelection('https://a.example/feed')
  assert.deepEqual([...h.store.get().sourcePack.selected], ['https://a.example/feed'])
  h.store.toggleSourcePackSelection('https://b.example/feed')
  assert.deepEqual([...h.store.get().sourcePack.selected], ['https://a.example/feed', 'https://b.example/feed'])
  h.store.toggleSourcePackSelection('https://a.example/feed')
  assert.deepEqual([...h.store.get().sourcePack.selected], ['https://b.example/feed'])

  // 删掉的条目不能留在勾选里：否则导入按钮会数一个已经不存在的条目。
  await h.store.removeSourcePackEntry('https://b.example/feed')
  assert.deepEqual([...h.store.get().sourcePack.selected], [])
})

test('客户端 OPML 序列化经宿主 parseOpml round-trip：URL 与 folder 与源包条目一致', () => {
  const h = makeStore()
  const entries = [
    ENTRY('https://a.example/feed?utm=1&x=2', { title: 'A & B "引号" <标签>', category: '科技 / 工程博客' }),
    ENTRY('https://b.example/atom.xml'),
    ENTRY('https://c.example/rss', { category: '播客 & 音频' }),
  ]
  const parsed = parseOpml(h.exports.buildSourcePackOpml(entries))

  assert.deepEqual(parsed.skipped, [], '合法清单不该产生被跳过的条目')
  assert.equal(parsed.subscriptions.length, entries.length, '每一条源包条目都要解析回来（不分叉、不丢）')
  // 顺序不作判据（序列化器与宿主 buildOpml 同为「未分类在前、分类按首次出现」），
  // 判据是**逐条**：URL、folder（来自 category）、标题三者都与源包条目一致。
  const byUrl = new Map(parsed.subscriptions.map((row) => [row.xmlUrl, row]))
  for (const entry of entries) {
    const row = byUrl.get(entry.url)
    assert.ok(row !== undefined, '解析结果缺少 ' + entry.url)
    assert.equal(row.folder, entry.category, 'folder 必须来自 category（含「科技 / 工程博客」这种带斜杠的分类名，不能被拆成多级）')
    assert.equal(row.title, entry.title, '标题要能经 XML 转义存活（& " < >）')
  }
})

test('空勾选不发起请求；30 条是允许的上限，31 条一条请求都不发并要求分批', async () => {
  const entries = Array.from({ length: 31 }, (_, index) => ENTRY('https://s' + String(index).padStart(2, '0') + '.example/feed'))
  const h = makeStore({ entries })
  await openPack(h)

  await h.store.importSelectedSourcePack()
  assert.equal(h.calls.filter(([endpoint]) => endpoint === 'opmlImport').length, 0, '空勾选不发起导入')

  for (const entry of entries) h.store.toggleSourcePackSelection(entry.url)
  await h.store.importSelectedSourcePack()
  assert.equal(h.calls.filter(([endpoint]) => endpoint === 'opmlImport').length, 0, '31 条超过上限，不许发 opmlImport')
  assert.match(h.store.get().sourcePack.error ?? '', /一次最多导入 30 条/)
  assert.equal(h.store.get().sourcePack.selected.length, 31, '拦下时保留勾选：用户直接去掉 1 条即可')
  assert.equal(h.calls.filter(([endpoint]) => endpoint === 'overview').length, 0, '被拦下时也不该刷新订阅列表')

  h.store.toggleSourcePackSelection(entries[0].url)
  await h.store.importSelectedSourcePack()
  const imports = h.calls.filter(([endpoint]) => endpoint === 'opmlImport')
  assert.equal(imports.length, 1, '30 条是允许的上限（阈值两侧都测）')
  assert.equal(parseOpml(imports[0][1].opml).subscriptions.length, 30)
})

test('导入结果逐条映射（含 1 条坏源）：失败带原因不入库、skipped 展示、源包条目仍在、订阅列表刷新', async () => {
  const entries = [
    ENTRY('https://good.example/feed', { category: '科技' }),
    ENTRY('https://exists.example/feed', { category: '科技' }),
    ENTRY('https://bad.example/feed', { category: '播客' }),
  ]
  const report = {
    added: 1,
    existed: 1,
    failed: [{ url: 'https://bad.example/feed', reason: 'HTTP 404' }],
    skipped: [{ title: '坏项', reason: 'URL 非法：ftp://x' }],
    accepted: [
      { url: 'https://good.example/feed', title: '好源', folder: '科技' },
      { url: 'https://exists.example/feed', title: '已订阅', folder: '科技' },
    ],
  }
  const h = makeStore({ entries, importReport: report })
  await openPack(h)
  for (const entry of entries) h.store.toggleSourcePackSelection(entry.url)
  await h.store.importSelectedSourcePack()

  const imports = h.calls.filter(([endpoint]) => endpoint === 'opmlImport')
  assert.equal(imports.length, 1)
  const sent = parseOpml(imports[0][1].opml)
  assert.deepEqual(sent.subscriptions.map((row) => row.xmlUrl).sort(), entries.map((entry) => entry.url).sort(),
    '只把勾选的三条拼进 OPML')
  assert.equal(sent.subscriptions.find((row) => row.xmlUrl === 'https://bad.example/feed').folder, '播客',
    '坏源也照样按 category 进 folder —— 校验是宿主的事，客户端不预筛')

  const state = h.store.get().sourcePack
  assert.deepEqual({ ...state.importReport }, report, '回包原样保留：新增 / 已存在 / 失败 / 跳过都由界面逐条展示')
  assert.deepEqual([...state.selected], [], '导入完成后清空勾选')
  assert.equal(state.importing, false)
  assert.deepEqual(state.entries.map((entry) => entry.url), entries.map((entry) => entry.url),
    '源包条目仍在：导入是「复制进订阅」，不是删除清单')
  assert.equal(h.calls.filter(([endpoint]) => endpoint === 'saveSourcePack').length, 0, '导入不写源包清单')
  assert.equal(h.calls.filter(([endpoint]) => endpoint === 'overview').length, 1,
    '导入后按 opmlImport 既有路径重取订阅列表')
})

test('导入请求失败：错误进视图、勾选保留、状态回到可重试', async () => {
  const h = makeStore({ importError: '网络断了' })
  await openPack(h)
  h.store.toggleSourcePackSelection('https://a.example/feed')
  await h.store.importSelectedSourcePack()

  const state = h.store.get().sourcePack
  assert.match(state.error ?? '', /网络断了/)
  assert.equal(state.importing, false)
  assert.deepEqual([...state.selected], ['https://a.example/feed'], '失败时保留勾选，用户可以直接重试')
  assert.equal(state.importReport, undefined, '失败的请求不该留下半份结果')
})

test('导入在飞时冻结勾选：期间的勾选改动不生效（结果落地会清空勾选，改了也注定丢）', async () => {
  const h = makeStore({ holdImport: true })
  await openPack(h)
  h.store.toggleSourcePackSelection('https://a.example/feed')
  const running = h.store.importSelectedSourcePack()
  assert.equal(h.store.get().sourcePack.importing, true, '请求在飞时 importing 为真（按钮/checkbox 禁用）')

  h.store.toggleSourcePackSelection('https://b.example/feed')
  assert.deepEqual([...h.store.get().sourcePack.selected], ['https://a.example/feed'], '在飞期间新增勾选被忽略')

  h.releaseImport()
  await running
  assert.equal(h.store.get().sourcePack.importing, false)
  assert.deepEqual([...h.store.get().sourcePack.selected], [])
})
