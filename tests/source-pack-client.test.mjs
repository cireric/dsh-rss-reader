/**
 * R15 08：精选源包在**真实客户端 store** 上的接线（spec §4.3.1 / §6 A13）。
 *
 * 为什么单独一份：宿主侧的归一化 / 落盘判据在 source-pack.test.mjs；这一层钉的是
 * 「打开视图取清单、搜索与分类、加源先校验、失败仍可保存并保留原因、删除只动清单」这些
 * 客户端行为 —— 它们住在 src/client/source-pack-actions.ts，只有驱动构建产物才看得见。
 *
 * 桩件沿用 client-channel.mjs（与 nav-selection 等同一条装配），不另造一套 React / fetch。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientModule } from './helpers/client-channel.mjs'

const SEED = [
  { url: 'https://a.example/feed', title: '源 A', category: '科技', addedAt: '2026-10-10T00:00:00.000Z' },
  { url: 'https://b.example/feed', title: '源 B', category: '播客', addedAt: '2026-10-10T00:00:00.000Z' },
]

async function waitFor(check, label) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待超时：' + label)
}

function makeStore() {
  const calls = []
  const snapshot = { entries: SEED, seed: { collectedAt: '2026-10-10', count: 79 } }
  // URL 是浏览器必有的全局（isHttpUrl 用它判协议）；沙箱缺了会把合法地址误判成非法。
  const { exports } = loadClientModule({ AbortController, setTimeout, clearTimeout, URL })
  const store = exports.createReaderStore({
    rpc: async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'sourcePack') return { sourcePack: snapshot }
      if (endpoint === 'saveSourcePack') {
        return {
          sourcePack: { entries: payload.entries, seed: snapshot.seed },
          dropped: 0,
          restored: 0,
        }
      }
      if (endpoint === 'discoverFeeds') {
        if (payload.url === 'https://good.example/feed') {
          return {
            url: payload.url,
            candidates: [{ url: payload.url, title: '好源', format: 'rss2', itemCount: 12, source: 'page' }],
            warnings: [],
          }
        }
        // 失败样本：页面与实例都没解析出 feed（客户端只负责如实显示原因）。
        return { url: payload.url, candidates: [], warnings: [{ reason: 'HTTP 404' }] }
      }
      return { changed: 1, unread: 0 }
    },
  })
  return { store, calls, snapshot }
}

test('打开精选源：取回清单与种子元信息；搜索 / 分类是视图状态，删除走 saveSourcePack', async () => {
  const { store, calls, snapshot } = makeStore()
  store.openSourcePack()
  assert.equal(store.get().view, 'sourcePack')
  await waitFor(() => store.get().sourcePack?.loading === false, 'sourcePack 回包')

  const state = store.get().sourcePack
  assert.equal(state.entries.length, 2)
  assert.deepEqual(state.seed, snapshot.seed)

  store.setSourcePackQuery('源 A')
  assert.equal(store.get().sourcePack.q, '源 A')
  store.setSourcePackCategory('播客')
  assert.equal(store.get().sourcePack.category, '播客')

  await store.removeSourcePackEntry(SEED[0].url)
  const save = calls.findLast(([endpoint]) => endpoint === 'saveSourcePack')
  assert.deepEqual(save[1].entries.map((entry) => entry.url), [SEED[1].url], '删除只改清单，不发 removeFeed')
  assert.equal(store.get().sourcePack.entries.length, 1)

  store.closeSourcePack()
  assert.equal(store.get().view, 'list')
})

test('加源：先抓一次解析；失败仍可「仍然保存」，条目带「未验证：原因」备注', async () => {
  const { store, calls } = makeStore()
  store.openSourcePack()
  await waitFor(() => store.get().sourcePack?.loading === false, 'sourcePack 回包')

  store.openSourcePackForm()
  store.setSourcePackDraft({ url: 'https://bad.example/feed' })
  await store.probeSourcePackUrl()
  const probed = store.get().sourcePack
  assert.equal(probed.probe.ok, false)
  assert.equal(probed.probe.reason, 'HTTP 404')
  assert.equal(calls.filter(([endpoint]) => endpoint === 'discoverFeeds').length, 1,
    '抓取校验只调宿主 discoverFeeds（客户端不直连目标站）')

  await store.saveSourcePackDraft(true)
  const save = calls.findLast(([endpoint]) => endpoint === 'saveSourcePack')
  const added = save[1].entries.at(-1)
  assert.equal(added.url, 'https://bad.example/feed')
  assert.match(added.note ?? '', /未验证：HTTP 404/, '未验证原因必须留在清单里')
  assert.equal(store.get().sourcePack.formOpen, false, '保存成功后收起表单')
  assert.equal(store.get().sourcePack.notice, '已添加 ✓')

  // 成功路径：标题从解析结果预填，格式（wire 形状没有独立字段）与「已验证」一起写进 note。
  store.openSourcePackForm()
  store.setSourcePackDraft({ url: 'https://good.example/feed' })
  await store.probeSourcePackUrl()
  assert.equal(store.get().sourcePack.probe.ok, true)
  assert.equal(store.get().sourcePack.draft.title, '好源', '解析出的标题要预填')
  await store.saveSourcePackDraft()
  const savedGood = calls.findLast(([endpoint]) => endpoint === 'saveSourcePack')[1].entries.at(-1)
  assert.equal(savedGood.title, '好源')
  assert.match(savedGood.note ?? '', /已验证：rss2/)
})

test('编辑：改分类与备注走 saveSourcePack 整份替换，只动被编辑的那一条且只落盘一次（spec §4.3.1）', async () => {
  const { store, calls } = makeStore()
  store.openSourcePack()
  await waitFor(() => store.get().sourcePack?.loading === false, 'sourcePack 回包')

  store.openSourcePackEditor(SEED[0].url)
  const draft = store.get().sourcePack.editing
  assert.equal(draft?.url, SEED[0].url, '编辑态必须定位到被点的那一条')
  assert.equal(draft?.category, '科技', '草稿回填当前分类')
  assert.equal(draft?.note, '', '没有备注时草稿是空串（不是编造内容）')

  store.setSourcePackEditDraft({ category: '  科学  ', note: '每周更新' })
  await store.saveSourcePackEdit()

  const saves = calls.filter(([endpoint]) => endpoint === 'saveSourcePack')
  assert.equal(saves.length, 1, '编辑只允许一次整份替换落盘')
  const entries = saves[0][1].entries
  assert.deepEqual(entries.map((entry) => entry.url), SEED.map((entry) => entry.url), '条目集合与顺序不变')
  assert.equal(entries[0].category, '科学', '分类被 trim 后保存')
  assert.equal(entries[0].note, '每周更新', '备注被保存')
  assert.equal(entries[0].title, '源 A', '编辑分类 / 备注不许抹掉标题')
  assert.equal(entries[0].addedAt, SEED[0].addedAt, 'addedAt 是条目的历史事实，编辑不许重写')
  assert.deepEqual(entries[1], SEED[1], '其它条目原样带上、一个字段都不动')

  const after = store.get().sourcePack
  assert.equal(after.saving, false)
  assert.equal(after.editing, undefined, '保存成功后退出编辑态')
  assert.equal(after.notice, '已保存 ✓')

  // 清空 = 用户主动去掉这两个字段：键不落盘（不是空串）。
  store.openSourcePackEditor(SEED[0].url)
  store.setSourcePackEditDraft({ category: '', note: '' })
  await store.saveSourcePackEdit()
  const cleared = calls.filter(([endpoint]) => endpoint === 'saveSourcePack').at(-1)[1].entries[0]
  assert.equal('category' in cleared, false, '清空分类 ⇒ 键不出现')
  assert.equal('note' in cleared, false, '清空备注 ⇒ 键不出现')
})
