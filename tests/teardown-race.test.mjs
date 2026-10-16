/**
 * teardown 与在途刷新的竞态（2026-10-13 真机实测缺陷的判据）。
 *
 * 病象（真机日志，同一份日志里出现两次）：两次成功装载之间夹着
 *   [..] 装载失败：Error: database is not open
 * 而库本身是好的（迁移完成、PRAGMA integrity_check = ok、老域文件哈希未变）。
 *
 * 根因：teardown 曾是「abort 之后同步 close」，而重载时 teardown 完全可能跑在「这一代的
 * refreshNow 还在等网络」的那一刻：refreshNow 早在进入时就把 store 抓在手里（ready() 只挡得住
 * **下一次**取 store），controller.abort() 也拦不住它继续写，于是写落在已关闭的句柄上。
 *
 * 为什么必须走真 SQLite（不能拿 store 桩代替）：被判定的是**句柄的生命周期** —— 桩里没有
 * node:sqlite 的 close 语义，把库换成桩就等于把待验证的那一层换成我的理解（docs/pitfalls.md 二、2.6）。
 *
 * 慢源用一台「收了请求就不响应」的本地 HTTP 服务器表达。**在飞是个因果信号**（请求真的到了
 * 服务器才 resolve 的 promise），不是 sleep 赌出来的：本仓库记过 sleep 型断言的坑。
 *
 * 2026-10-15（H2）：本文件原先要伪造整个宿主（抓 webServer.register 的 handler、手写 ctx.effect
 * 收 disposer、process.env.DSH_HOME、假 connection）才能驱动 apply —— 现在生命周期与传输壳各自
 * 有了 Interface，于是这里直接 start/stop + 直接调 createHttpHandler，**假 ctx 全部消失**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/config.js'
import { createLifecycle } from '../lib/lifecycle.js'
import { createDispatch, createHttpHandler } from '../lib/endpoints.js'

const FEED_ID = 'https://feed0.example.com/atom.xml'

/** 有界轮询一个因果信号（不是「睡一段时间再看」）。 */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return predicate()
}

/**
 * 装配一个真实的 lifecycle：一台「收了请求就不响应」的本地服务器当慢源 + 临时存储根。
 * 交回判据：日志行、「在飞」的因果信号、stop、以及 config.json 里的源记录。
 */
async function assemble({ refreshOnStart, timeoutMs = 10000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-teardown-race-'))
  const lines = []
  // 收了请求就 resolve「在飞」信号，但**永不响应** —— 慢源的最小形状
  let markArrived
  const reached = new Promise((resolve) => { markArrived = resolve })
  const server = createServer(() => { markArrived() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + server.address().port + '/feed.xml'
  const configFile = join(dir, 'config.json')
  // config 由「宿主」持有并同时传给两端（index.ts 的接线方式）：生命周期与端点注册表各收一份，
  // 这样两条路径读到的阈值永远一致。
  const config = Config({ feeds: [url], refreshOnStart, timeoutMs })
  const lifecycle = createLifecycle({
    config,
    storagesRoot: dir,
    configFile,
    log: (line) => lines.push(line),
    // 摘要由宿主提供（措辞归宿主）：「在途刷新落定」那条判据读的就是这一行。
    summarize: (outcomes) => '刷新完成，共 ' + outcomes.length + ' 源',
  })
  // refresh 一路走真实传输：与面板那条路径同源（createHttpHandler + createDispatch）
  const dispatch = createDispatch({
    config,
    log: (line) => lines.push(line),
    ready: lifecycle.ready,
    refreshNow: lifecycle.refreshNow,
    lastRefreshCompletedAt: lifecycle.lastRefreshCompletedAt,
    articleAttempts: lifecycle.articleAttempts,
  })
  const handler = createHttpHandler(dispatch, {
    requestRejection: () => undefined,
    log: (line) => lines.push(line),
  })
  return {
    dir, lines, reached, lifecycle, handler, url,
    requestRefresh: () => requestRefresh(handler),
    /** 这一代的源记录（调度键与失败原因都在 config.json 里） */
    feedRecord: () => {
      const feeds = JSON.parse(readFileSync(configFile, 'utf8')).feeds
      const values = Object.values(feeds ?? {})
      return values.length === 1 ? values[0] : { 期望一个源实际: values.length }
    },
    stop: () => lifecycle.stop(),
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** 通过真传输触发一轮 refresh（与客户端走的是同一条路）。 */
async function requestRefresh(handler) {
  const request = {
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ endpoint: 'refresh', payload: {} })) },
  }
  const response = { status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await handler(request, response)
  return response
}

test('启动刷新在飞时 teardown：不得把库关在正在写的刷新底下（无「装载失败 / database is not open」）', async () => {
  const host = await assemble({ refreshOnStart: true })
  try {
    // 刻意**不 await** start：它内部的启动刷新会一路等到落定（慢源 10s），等到它返回就
    // 没有「在飞」可停了。启动它，然后在「请求真的到了源」这个因果信号上停。
    const starting = host.lifecycle.start()
    await host.reached   // 前置条件：这一轮刷新**真的在飞**（网络请求已经到了源）

    const startedAt = Date.now()
    await host.stop()
    const elapsed = Date.now() - startedAt
    // 卡住的那次抓取只能靠 stop 的 abort 结束：timeoutMs 是 10s，若这里等到它，
    // 就说明 abort 根本没被观察到 —— 那正是「无界等待」的形态。
    assert.ok(elapsed < 5000, 'stop 必须靠 abort 立即收尾，而不是干等单源超时（实际 ' + elapsed + 'ms）')

    // 在途刷新必须**落定**（中止是预期内的收尾），并且**不许**被记成装载失败
    assert.ok(host.lines.some((line) => /刷新完成|装载失败/.test(line)),
      '在途刷新必须在 stop 内落定：\n' + host.lines.join('\n'))
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
    await starting   // 装载链自己也要落定（stop 已等过它，这里只是不许留悬挂 promise）
  } finally {
    await host.close()
  }
})

test('面板触发（RPC）的在飞刷新同样受 teardown 保护：不得写在已关闭的句柄上', async () => {
  // 这一条与上面那条是**两个不同的 signal 来源**：装载那一轮带着本代的 signal，
  // 而面板点刷新那条 refreshNow() **一个 signal 都没带**。stop 若只等前者，后者照样
  // 会在句柄关掉之后继续写 —— 同一病象的第二个入口。
  const host = await assemble({ refreshOnStart: false })
  try {
    await host.lifecycle.start()

    const pending = host.requestRefresh()   // 刻意不 await：模拟面板点刷新后正在飞
    await host.reached

    await host.stop()
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