/**
 * 客户端订阅源排序动作（R3-03）的契约测试。
 *
 * 为什么单独起一个文件：这层要钉的是**时序**——「宿主回包前顺序不动」「在途忽略重复调用」
 * 「失败只写 error、不重排」都在毫秒级的窗口里，真 DOM 夹具只能靠点得快来表达，容易假绿。
 * 这里用 tests/helpers/client-channel.mjs 的 script / hold 把请求**扣住**，让窗口变成同步事实
 * （先例：R2 的「恢复到达前用户已动手」）。驱动方式与 tests/nav-selection.test.mjs 同形：
 * 加载真实构建产物 lib/client.js，喂一条假 rpc，测真实 store。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFakeChannel, loadClientModule } from './helpers/client-channel.mjs'
import { overviewStub } from './helpers/overview-fixture.mjs'

const feedIds = (store) => store.get().feeds.map((feed) => feed.id)
const reorderCalls = (channel) => channel.calls.filter(([endpoint]) => endpoint === 'reorderFeeds')
const overviewCalls = (channel) => channel.calls.filter(([endpoint]) => endpoint === 'overview').length

/**
 * 一台「真宿主」替身：overview 永远下发它当下的顺序，reorderFeeds 按宿主的归一规则改它。
 *
 * 桩件必须守它模仿的那条契约（docs/pitfalls.md 2.6）：未知 id 忽略、重复保首次、
 * 未点名的按当前相对顺序补末尾 —— 与 src/feed-order.ts 的实现同义，否则「未点名补末尾」
 * 这类用例会被一个更宽松的替身放过去。
 */
function harness({ order = ['a', 'b', 'c'], script = [] } = {}) {
  const server = { feeds: order.map((id) => ({ id, title: '源 ' + id.toUpperCase() })) }
  const applyOrder = (requested) => {
    const next = []
    for (const id of requested) {
      const feed = server.feeds.find((entry) => entry.id === id)
      if (feed !== undefined && !next.includes(feed)) next.push(feed)
    }
    for (const feed of server.feeds) if (!next.includes(feed)) next.push(feed)
    server.feeds = next
    return next.map((feed) => feed.id)
  }
  const channel = createFakeChannel({
    overview: { items: [] },
    script,
    request: async (endpoint, payload) => {
      if (endpoint === 'overview') return overviewStub({ items: [], feeds: server.feeds })
      if (endpoint === 'reorderFeeds') return { feedOrder: applyOrder(payload.ids) }
      return undefined
    },
  })
  const { exports } = loadClientModule({ AbortController, setTimeout, clearTimeout })
  const store = exports.createReaderStore({ rpc: channel.rpc })
  return { store, channel, server, applyOrder }
}

test('moveFeedOrder：按当前 feeds 顺序整体推出 ids，成功后 reload 用宿主快照改行序', async () => {
  const { store, channel } = harness()
  await store.load('overview')
  assert.deepEqual(feedIds(store), ['a', 'b', 'c'], '前置：初始顺序来自宿主 overview')

  await store.moveFeedOrder('b', -1)
  assert.deepEqual(reorderCalls(channel), [['reorderFeeds', { ids: ['b', 'a', 'c'] }]],
    'ids 必须是整份当前顺序的相邻交换，而不是只发被移动的那一个')
  assert.deepEqual(feedIds(store), ['b', 'a', 'c'], '新顺序来自宿主回包后的 reload，不是本地推算')
  assert.equal(overviewCalls(channel), 2, '成功后必须重新取快照（初始 1 次 + 重排后 1 次）')
})

test('moveFeedOrder：首行上移 / 末行下移是 no-op，不发请求', async () => {
  const { store, channel } = harness()
  await store.load('overview')

  await store.moveFeedOrder('a', -1)
  await store.moveFeedOrder('c', 1)
  assert.equal(reorderCalls(channel).length, 0, '到边界不该惊动宿主（UI 已置灰，动作也不能越界）')
  assert.deepEqual(feedIds(store), ['a', 'b', 'c'])
})

test('moveFeedOrder：宿主回包前不做乐观重排', async () => {
  // 把重排请求扣住 = 宿主还在写盘。这段时间里界面必须仍是旧顺序。
  const { store, channel, applyOrder } = harness({
    script: [{ when: ({ endpoint }) => endpoint === 'reorderFeeds', hold: true }],
  })
  await store.load('overview')

  const pending = store.moveFeedOrder('b', -1)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(channel.heldCount, 1, '请求必须真的被扣住，否则本用例根本测不到窗口')
  assert.deepEqual(feedIds(store), ['a', 'b', 'c'], '宿主回包前不许先改 feeds（屏幕新、文件旧的形态）')
  assert.equal(store.get().feedsBusy, false, '排序在途不许置 feedsBusy —— 它的文案是「正在逐源抓取校验…」，会撒谎')

  applyOrder(['b', 'a', 'c'])
  channel.release({ feedOrder: ['b', 'a', 'c'] })
  await pending
  assert.deepEqual(feedIds(store), ['b', 'a', 'c'], '回包并 reload 之后才允许变')
})

test('moveFeedOrder：在途忽略重复调用，只发一次请求', async () => {
  const { store, channel, applyOrder } = harness({
    script: [{ when: ({ endpoint }) => endpoint === 'reorderFeeds', hold: true }],
  })
  await store.load('overview')

  const first = store.moveFeedOrder('b', -1)
  const second = store.moveFeedOrder('a', 1)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(channel.heldCount, 1, '同一时刻只允许一个重排在途')
  assert.equal(reorderCalls(channel).length, 1, '第二次调用必须被忽略，不能堆请求')

  applyOrder(['b', 'a', 'c'])
  channel.release({ feedOrder: ['b', 'a', 'c'] })
  await Promise.all([first, second])
  assert.deepEqual(feedIds(store), ['b', 'a', 'c'], '只生效第一次移动')
  assert.equal(reorderCalls(channel).length, 1)
})

test('moveFeedOrder：宿主拒绝时写 error、顺序保持宿主快照', async () => {
  const { store, channel } = harness({
    script: [{ when: ({ endpoint }) => endpoint === 'reorderFeeds', message: 'storage: 写不进去' }],
  })
  await store.load('overview')

  await store.moveFeedOrder('b', -1)
  // 跨 realm 的 Error 不是沙箱 realm 的 Error 实例（docs/pitfalls.md 2.12），所以按消息判可见性；
  // 仓库既有用法同形（client-bundle.test.mjs 的 String(store.get().error).includes(...)）。
  assert.match(String(store.get().error), /storage: 写不进去/, '失败必须可见（不能静默 no-op）')
  assert.deepEqual(feedIds(store), ['a', 'b', 'c'], '失败后顺序保持宿主那一份')
  assert.equal(overviewCalls(channel), 1, '失败不应再拉一次 overview 掩盖现场')
})
