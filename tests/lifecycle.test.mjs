/**
 * 生命周期的 Interface（2026-10-15 H2 Task 3）。
 *
 * 这些用例钉的是**顺序与时序**——它们在 src/index.ts 的 apply 闭包里时只能靠读实现确认
 * （teardown-race.test.mjs 为此要伪造整个宿主：抓 handler、手写 ctx.effect、改 process.env.DSH_HOME）。
 * 搬进 createLifecycle 之后，测试直接 start/stop，不再需要任何假宿主。
 *
 * 刻意用**真实 SQLite + 真实临时目录**：判据全在「句柄什么时候开、什么时候关、在谁手上」，
 * 内存桩测不到（桩的 open/close 记不住真实句柄何时可删）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/config.js'
import { createLifecycle } from '../lib/lifecycle.js'

const FEED_ID = 'https://feed0.example.com/atom.xml'

/** 一个完整的临时存储根：config.json 带上一个源，让装载链真的走完。 */
function workspace(tag) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-lifecycle-' + tag + '-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ version: 1, feeds: { [FEED_ID]: { url: FEED_ID, title: '源 0' } } }))
  const clean = () => rmSync(dir, { recursive: true, force: true })
  return { dir, configFile: join(dir, 'config.json'), clean }
}

/**
 * 装载一个 lifecycle；refreshOnStart 关掉，避免测试自己撞网络。
 *
 * summarize **必填**（2026-10-15 独立评审后的收紧）：它就是「刷新落定」在日志里留痕的那一行，
 * teardown-race 的「在途刷新必须在 stop 内落定」读的就是它。做成可选时，不传就静默少一行日志。
 */
function make(tag, extra = {}) {
  const ws = workspace(tag)
  const lines = []
  const lc = createLifecycle({
    config: Config({ refreshOnStart: false }),
    storagesRoot: ws.dir,
    configFile: ws.configFile,
    log: (line) => lines.push(line),
    summarize: (outcomes) => '刷新完成，共 ' + outcomes.length + ' 源',
    ...extra,
  })
  return { lc, lines, ...ws }
}

test('生命周期：start 走完装载链后 ready() 给出 store，停掉后给 undefined', async () => {
  const h = make('basic')
  try {
    assert.equal(h.lc.ready(), undefined, 'start 之前没有 store')
    await h.lc.start()
    assert.notEqual(h.lc.ready(), undefined, 'start 落定后必须交出 store')
    assert.deepEqual(h.lc.ready().listFeeds().map(([id]) => id), [FEED_ID], '配置里的源必须被播种')
    await h.lc.stop()
    assert.equal(h.lc.ready(), undefined, '停掉之后不许再交出 store（cancelled 之后仍能拿到就是悬垂句柄）')
  } finally { h.clean() }
})

test('Review Focus 1：start 期间 stop —— 不误关、不泄漏、且落定后不交出 store', async () => {
  const h = make('stop-during-start')
  try {
    const starting = h.lc.start()
    await h.lc.stop()          // 刻意不等 start 落定
    await starting             // start 自己落定（不许抛）
    assert.equal(h.lc.ready(), undefined, '取消之后 start 即使落定也不许交出 store')
    // 目录能被删掉 ⇒ 没有句柄还握着（Windows 语义下这会直接失败）
    assert.doesNotThrow(() => h.clean(), '库文件必须已关闭 —— 取消途中建出来的句柄若留着，下次装载撞 SQLITE_BUSY')
  } finally { rmSync(h.dir, { recursive: true, force: true }) }
})

test('Review Focus 4：stop 重复调用是安全的空操作（不放宽断言、不吞错）', async () => {
  const h = make('double-stop')
  try {
    await h.lc.start()
    await h.lc.stop()
    await assert.doesNotReject(() => h.lc.stop(), '第二次 stop 必须是空操作，不是异常')
    await assert.doesNotReject(() => h.lc.stop())
    assert.equal(h.lc.ready(), undefined)
  } finally { h.clean() }
})

test('Review Focus 3：stop 之后 refreshNow 直接 false，不许拿一个正在关的 store', async () => {
  const h = make('refresh-after-stop')
  try {
    await h.lc.start()
    await h.lc.stop()
    assert.equal(await h.lc.refreshNow(), false, '已关停 ⇒ refresh 不得发起')
    assert.equal(await h.lc.refreshNow({ force: true }), false, 'force 也不许越过就绪判定')
  } finally { h.clean() }
})

test('Review Focus 2：重复 start 不会把状态搅乱（幂等：第二次不重跑装载链）', async () => {
  const h = make('double-start')
  try {
    await h.lc.start()
    const first = h.lc.ready()
    await h.lc.start()
    assert.equal(h.lc.ready(), first, '重复 start 不得换掉已就绪的 store（等价变异）')
    await h.lc.stop()
    assert.equal(h.lc.ready(), undefined)
  } finally { h.clean() }
})

test('Review Focus 5：stop 的等待有界 —— 落定的刷新必须等完，不靠超时兜', async () => {
  // 判据：stop 必须**等在途刷新落定**（关句柄前不能有人在写），而这个等待是有界的
  // （每个抓取自带 AbortSignal.timeout，且 stop 会先 abort）。
  const h = make('bounded-wait')
  try {
    await h.lc.start()
    // 塞一个「会落定但稍慢」的在途刷新：走完 fetchImpl 之前必须等它
    let settled = false
    const refresh = h.lc.refreshNow({ force: true }).then(() => { settled = true })
    const startedAt = Date.now()
    await h.lc.stop()
    const elapsed = Date.now() - startedAt
    assert.equal(settled, true, 'stop 返回时在途刷新必须已落定（不等它就是 database is not open）')
    assert.ok(elapsed < 5000, '等待必须有界（实际 ' + elapsed + 'ms）')
  } finally { h.clean() }
})
// ⚠️ 本用例断言的是**代码该有的行为**，但它抓不到「删掉那个 close」的变异（实测：本平台删文件
// 不因句柄而失败，重开同名库也不立刻撞 SQLITE_BUSY ⇒ 那个失效面不可观测）。留着它是为了把
// 「守卫抛错 ⇒ 响亮失败」这条守住并让场景显式存在，不是给变异当判据。
test('守卫抛错时响亮失败，且失败路径自己关掉句柄（订阅丢了那条路径）', async () => {
  // 场景：config.json 不在、而库里有条目 ⇒ 守卫抛错。此时句柄**尚未登记**（database = db 在后面），
  // stop 的「先看 database 再 close」关不到它 ⇒ 失败路径必须自己关。不关的后果是每次重载泄漏一个
  // SQLite 连接，而守卫抛错恰恰是最可能反复发生的那种失败。
  const { createLifecycle } = await import('../lib/lifecycle.js')
  const { Config } = await import('../lib/config.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { openDatabase, migrateSchema } = await import('../lib/storage/db.js')
  const dir = mkdtempSync(join(tmpdir(), 'rss-guard-close-'))
  try {
    // 先造一个「有数据、没订阅」的库
    const db = openDatabase(join(dir, 'rss.db'))
    migrateSchema(db)
    db.prepare('INSERT INTO items (id, feed_id, title, link, fetched_at, starred) VALUES (?, ?, ?, ?, ?, 0)')
      .run('x1', 'https://gone.example.com/f.xml', '标题', 'https://gone.example.com/1', new Date().toISOString())
    db.close()

    const lines = []
    const lc = createLifecycle({
      config: Config({ feeds: [], refreshOnStart: false }),
      storagesRoot: dir,
      configFile: join(dir, 'config.json'),      // 故意不存在
      log: (line) => lines.push(line),
      summarize: () => '（本用例走守卫失败，不该到这里）',
    })
    await lc.start()
    assert.ok(lines.some((line) => line.includes('装载失败')),
      '守卫必须响亮失败：\n' + lines.join('\n'))

    // 关键判据：守卫抛错后句柄已被失败路径自己关掉 —— 此时删掉目录不该有残留句柄，
    // 而**再开一个同名库**能立即拿到写锁（残留句柄会撞 SQLITE_BUSY）。
    await lc.stop()
    const reopened = openDatabase(join(dir, 'rss.db'))
    reopened.close()
    assert.doesNotThrow(() => rmSync(dir, { recursive: true, force: true }),
      '守卫抛错后句柄必须已关闭 —— 残留句柄会让下一次装载撞 SQLITE_BUSY')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
// ── 补齐评审点名的三条缺口（2026-10-15 独立评审 ffccc574）────────────────────────
// 评审的实验：这四条变异在全套 393 条下**保持绿** ⇒ 对应约束没有判据。
//   ① `if (!options.force && lastCompletedAt !== undefined` → `if (false && …`（节流恒不触发）
//   ④ `if (cancelled) {` → `if (false) {`（取消后继续装载并交出 store）
//   ⑤ stop 里 `if (database) {` → `if (false) {`（永不关句柄）
//   ⑦ `generationSignal = undefined` 去掉（信号没清）
// 多数是**既有缺口**（基线 lib/index.js 里是同一份代码），但 H2 的验收标准写着「每条约束各有
// 一条测试」，且 ⑤⑦ 属于**句柄释放**这一层（本仓库记过事故）。下面三条把它们各自钉住。

test('缺口 ①：refreshNow 的节流往返 —— 第二轮被拦且记下「还剩多久」', async () => {
  const h = make('throttle')
  try {
    await h.lc.start()
    // 第一轮：无源可抓（feeds 为空）也会**真的发起**一轮并盖上完成时间戳
    h.lines.length = 0
    assert.equal(await h.lc.refreshNow(), true, '第一轮应当真的发起抓取（并盖完成时间戳）')

    // 第二轮：不带 force ⇒ 被 minRefreshIntervalMs 拦下
    const second = await h.lc.refreshNow()
    assert.equal(second, false, '第二轮必须被节流拦下（恒不触发的变异会让它变 true）')
    assert.ok(h.lines.some((line) => line.includes('刷新被节流')),
      '被节流必须留痕 —— 否则界面上只表现为「点了没反应」，用户与 agent 都无法区分“没抓”和“抓了没新内容”：\n' + h.lines.join('\n'))
  } finally { h.clean() }
})

// ⚠️ 缺口 ④（取消途中关库）与缺口 ⑦（stop 清信号）：**试过补判据，结构上打不到，已放弃并记账**。
// ④ 试过「取消后 ready() 是 undefined」——但 ready() 本就因 cancelled=true 而返回 undefined，
//   与 cancelled 分支无关；它真正的后果「取消后 db 被关掉」属句柄释放一类，在 macOS 不可观测
//   （与上一条「守卫抛错不自己关库」同因：删文件不因句柄失败、重开同名库不立刻撞 BUSY）。
// ⑦ 试过「stop 之后再建一代 lifecycle 能正常抓」——**结构上不可能**：start 的 `started` 一次性、
//   `stopped` 不可逆，同一个 lifecycle 无法重启，而新建对象与上一代的信号无关。
// 而它们真正的可观测后果只在「取消与关闭交错」的那个时序里，而本平台无法制造那个时序。
// ⇒ 代码里的 `if (cancelled) { db.close(); return }` 与 `generationSignal = undefined` **保留**
//   （它们是正确的，删了是真 bug），缺的只是本平台抓不到它们的判据。记在 ledger 的「已知不可观测」。