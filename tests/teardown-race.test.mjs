/**
 * teardown 与在途刷新的竞态（2026-10-13 真机实测缺陷的判据）。
 *
 * 病象（真机日志，同一份日志里出现两次）：两次成功装载之间夹着
 *   [..] 装载失败：Error: database is not open
 * 而库本身是好的（迁移完成、PRAGMA integrity_check = ok、老域文件哈希未变）。
 *
 * 根因（源码核对 src/index.ts:305-377，见本轮报告的「根因」一节）：自持存储的 effect 体是一段
 * **浮动的异步 IIFE**，而 teardown 里是**同步** database.close()。重载时 teardown 完全可能跑在
 * 「这一代的 refreshNow 还在等网络」的那一刻（装载时的启动刷新，慢源可达数十秒）：refreshNow
 * 早在进入时就把 store 抓在手里（ready() 只挡得住**下一次**取 store），controller.abort() 也拦不住
 * 它继续写，于是写落在已关闭的句柄上，node:sqlite 抛 database is not open，外层 catch 记成「装载失败」。
 *
 * 为什么必须走真装配（不能拿 store 桩代替）：被判定的是**句柄的生命周期** —— 桩里没有
 * node:sqlite 的 close 语义，把库换成桩就等于把待验证的那一层换成我的理解（docs/pitfalls.md 二、2.6）。
 *
 * 慢源用一台「收了请求就不响应」的本地 HTTP 服务器表达。**在飞是个因果信号**（请求真的到了
 * 服务器才 resolve 的 promise），不是 sleep 赌出来的：本仓库记过 sleep 型断言的坑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

/** 有界轮询一个因果信号（不是「睡一段时间再看」）。 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

/** 通过插件的真 HTTP 路由触发一轮 refresh（与客户端走的是同一条路）。 */
async function requestRefresh(handler) {
  const request = {
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ endpoint: 'refresh', payload: {} })) },
  }
  const response = { status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await handler(request, response)
  return response
}

/**
 * 把 apply 装到一个假宿主上（形状照 tests/refresh.test.mjs 的 withRealRefresh），并交回判据：
 * 日志行、「在途」的因果信号、teardown、以及 config.json 里的源记录。
 */
async function assemble({ refreshOnStart, timeoutMs = 10000 }) {
  const home = mkdtempSync(join(tmpdir(), 'rss-teardown-race-'))
  const savedHome = process.env.DSH_HOME
  const savedUserProfile = process.env.USERPROFILE
  process.env.DSH_HOME = home
  process.env.USERPROFILE = home
  const lines = []
  const disposers = []
  let handler
  let markArrived
  const reached = new Promise((resolve) => { markArrived = resolve })
  // 收了请求就**不响应**：把这一轮刷新钉死在网络上，好让 teardown 正好落在「等网络」那一刻
  const server = createServer(() => { markArrived() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + server.address().port + '/feed.xml'
  const ctx = {
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
    effect: (callback) => { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
    webServer: { register: (route) => { handler = route.handler; return () => { handler = undefined } } },
    connection: { requestRejection: () => undefined },
  }
  apply(ctx, { feeds: [url], refreshOnStart, minRefreshIntervalMs: 0, timeoutMs })
  return {
    home, url, lines, reached,
    route: () => handler,
    /** 这一代的源记录（订阅映射与失败原因都在 config.json 里） */
    feedRecord: () => {
      const feeds = JSON.parse(readFileSync(join(home, 'storages', 'rss-reader', 'config.json'), 'utf8')).feeds
      const values = Object.values(feeds ?? {})
      return values.length === 1 ? values[0] : { 期望一个源实际: values.length }
    },
    teardown: async () => { for (const dispose of disposers) await dispose() },
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      rmSync(home, { recursive: true, force: true })
      if (savedHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = savedHome
      if (savedUserProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = savedUserProfile
    },
  }
}

test('启动刷新在飞时 teardown：不得把库关在正在写的刷新底下（无「装载失败 / database is not open」）', async () => {
  const host = await assemble({ refreshOnStart: true })
  try {
    await host.reached   // 前置条件：这一轮刷新**真的在飞**（网络请求已经到了源）

    const startedAt = Date.now()
    await host.teardown()
    const elapsed = Date.now() - startedAt
    // 卡住的那次抓取只能靠 teardown 的 abort 结束：timeoutMs 是 10s，若这里等到它，
    // 就说明 abort 根本没被观察到 —— 那正是「无界等待」的形态。
    assert.ok(elapsed < 5000, 'teardown 必须靠 abort 立即收尾，而不是干等单源超时（实际 ' + elapsed + 'ms）')

    // 在途刷新必须**落定**（中止是预期内的收尾），并且**不许**被记成装载失败
    assert.ok(host.lines.some((line) => /刷新完成|装载失败/.test(line)),
      '在途刷新必须在 teardown 内落定：\n' + host.lines.join('\n'))
    assert.ok(!host.lines.some((line) => line.includes('database is not open')),
      '不许在已关闭的句柄上写：\n' + host.lines.join('\n'))
    assert.ok(!host.lines.some((line) => line.includes('装载失败')),
      '被中止的在途刷新是收尾，不是装载失败：\n' + host.lines.join('\n'))

    // 中止必须**被观察到**：这一轮的失败要落进源记录（调度键 + 失败原因），不许静默消失 ——
    // 否则下一轮会把它当成「从未尝试过」的源（refresh.ts 的排序键正是 lastAttemptedAt）
    const record = host.feedRecord()
    assert.ok(record.lastAttemptedAt !== undefined,
      '被中止的尝试必须盖 lastAttemptedAt（调度键）：' + JSON.stringify(record))
    assert.match(String(record.lastFailure), /已中止|超时/,
      '中止的原因必须落进记录：' + JSON.stringify(record))
    assert.equal(record.lastFetchedAt, undefined, '中止不是成功：不得盖 lastFetchedAt')
  } finally {
    await host.close()
  }
})

test('面板触发（RPC）的在飞刷新同样受 teardown 保护：不得写在已关闭的句柄上', async () => {
  // 这一条与上面那条是**两个不同的 signal 来源**：装载那一轮带着 controller.signal，
  // 而面板点刷新那条 refreshNow() **一个 signal 都没带**。teardown 若只等前者，后者照样
  // 会在句柄关掉之后继续写 —— 同一病象的第二个入口。
  const host = await assemble({ refreshOnStart: false })
  try {
    const startupDone = await waitFor(
      () => host.lines.some((line) => line.includes('refreshOnStart=false')), 10000)
    assert.ok(startupDone, '前置条件：装载异步体要走完（否则 store 还没建好，刷新根本不发请求）')

    const pending = requestRefresh(host.route())   // 刻意不 await：模拟面板点刷新后正在飞
    await host.reached

    await host.teardown()
    const response = await pending   // 必须落定：修好后靠 abort，修之前靠单源超时（10s）

    assert.ok(!response.body.includes('database is not open'),
      '面板触发的那一轮同样不许写在已关闭的句柄上：' + response.body)
    const record = host.feedRecord()
    assert.ok(record.lastAttemptedAt !== undefined,
      '被中止的尝试必须盖 lastAttemptedAt（调度键）：' + JSON.stringify(record))
    assert.match(String(record.lastFailure), /已中止|超时/,
      '中止的原因必须落进记录：' + JSON.stringify(record))
  } finally {
    await host.close()
  }
})
