/**
 * 刷新日志按天分文件的判据（Task 7）。
 *
 * 这些都不是实现细节，而是「日志换到存储目录之后，不会再吃掉邻居」的判据：
 * - 文件名必须按 **UTC** 日期定：本机是 CST（+08:00），按本地日期会在每天 08:00 换名字，
 *   而日志行首的时间戳是 toISOString() 写的 UTC —— 两者对不上时，「一条日志属于哪一天」
 *   取决于在哪台机器上看，排障时最贵的就是这种说不清；
 * - prune 的匹配必须**窄到只认 reader-YYYY-MM-DD.log**：日志和 config.json / rss.db 同住
 *   storages/rss-reader/，一次前缀匹配（startsWith('reader-')）或随手一个 glob 就会开始删用户数据；
 * - 认不出的名字（reader-backup.log / reader-2026-13-99.log）不能删也不能崩 —— 宁可留一个垃圾，
 *   不可猜一个日期；
 * - 判据只看**文件名**，不看 mtime：mtime 会被备份/rsync/cp -a 改掉，而文件名是日志的归属本身；
 * - 保留窗口是**闭区间**：今天 + 前 13 天（共 14 天）留着，第 14 天前那份删掉；
 * - 读不了目录必须**抛错**（调用方留痕），不许静默当成「没有日志」：否则用户永远不知道日志停更了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dailyLogPath, pruneOldLogs } from '../lib/storage/log-file.js'

/** 每个用例一个独立临时目录；调用方负责在 finally 里删掉它。 */
const tempDir = (tag) => mkdtempSync(join(tmpdir(), 'rss-logfile-' + tag + '-'))

/** 一天（毫秒）—— 造超期日志时按天回推，不写死具体日期串。 */
const DAY_MS = 24 * 60 * 60 * 1000

/** 从基准时刻往前 n 天。 */
const daysBefore = (base, n) => new Date(base.getTime() - n * DAY_MS)

/** 目录里当前的条目名（排序，便于断言整个集合）。 */
const names = (root) => readdirSync(root).sort()

test('dailyLogPath 按 UTC 日期命名，不受本机时区（CST）影响', () => {
  assert.equal(dailyLogPath('/root', new Date('2026-10-11T23:30:00Z')), '/root/reader-2026-10-11.log')
  assert.equal(dailyLogPath('/root', new Date('2026-10-11T00:00:00Z')), '/root/reader-2026-10-11.log')
  // 本机是 UTC+8：这一刻在当地已经是 10-12 凌晨，但日志行首的时间戳写的是 UTC 10-11 ——
  // 按本地日期取名会让同一份文件的归属随机器所在时区漂移。
  assert.equal(
    dailyLogPath('/root', new Date('2026-10-11T16:30:00Z')),
    '/root/reader-2026-10-11.log',
    '文件名必须跟着日志行的时间戳走（UTC），不跟着本机时区',
  )
  // 月/日补零既是文件名的格式契约，也保证匹配用得上它
  assert.equal(dailyLogPath('/root', new Date('2026-01-02T03:04:05Z')), '/root/reader-2026-01-02.log')
})

test('pruneOldLogs 只删超期的 reader-*.log，绝不碰 config.json / rss.db 及其边车', () => {
  const root = tempDir('scope')
  try {
    const now = new Date('2026-10-11T12:00:00Z')
    // 超期两份 + 窗口内两份
    for (const name of ['reader-2026-09-21.log', 'reader-2026-09-26.log', 'reader-2026-09-28.log', 'reader-2026-10-11.log']) {
      writeFileSync(join(root, name), 'line\n')
    }
    // 同住一个目录的邻居：订阅真相、库、库的边车，以及一个无关文件。
    // 它们都必须活下来 —— 这条正是本次修复的重点（日志搬到这儿了，prune 的杀伤面必须窄）。
    for (const name of ['config.json', 'rss.db', 'rss.db-wal', 'rss.db-shm', 'notes.txt']) {
      writeFileSync(join(root, name), 'x')
    }
    // rss.db 造得像一个真的超期文件：若 prune 的判据里混进 mtime，它会第一个被误删 ——
    // 而那是用户的订阅库，删掉等于数据没了。
    const dbPath = join(root, 'rss.db')
    utimesSync(dbPath, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'))

    assert.equal(pruneOldLogs(root, 14, now), 2, '只应删掉两份超期日志')

    assert.deepEqual(names(root), [
      'config.json',
      'notes.txt',
      'reader-2026-09-28.log',
      'reader-2026-10-11.log',
      'rss.db',
      'rss.db-shm',
      'rss.db-wal',
    ], '删的只能是超期日志：一个邻居都不许少')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneOldLogs 的保留窗口是闭区间：今天 + 前 13 天留，第 14 天前删', () => {
  const root = tempDir('boundary')
  try {
    const now = new Date('2026-10-11T12:00:00Z')
    // 逐个钉住边界两侧 —— 只断言「有老文件被删」的用例放走的是「窗口整体偏移一天」这类错。
    const at = (n) => dailyLogPath(root, daysBefore(now, n))
    for (const n of [0, 1, 13, 14, 15]) writeFileSync(at(n), 'line\n')

    assert.equal(pruneOldLogs(root, 14, now), 2, '第 14 天与第 15 天前的那两份超期')

    assert.deepEqual(names(root), [basename(at(0)), basename(at(1)), basename(at(13))].sort(),
      '留下的必须正好是今天 + 前 13 天')
    for (const n of [14, 15]) {
      assert.equal(names(root).includes(basename(at(n))), false,
        '第 ' + n + ' 天前的日志必须删掉（窗口 = 今天 + 13 天 = 14 天）')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneOldLogs 对认不出的文件名既不删也不崩，且判据只看文件名不看 mtime', () => {
  const root = tempDir('malformed')
  try {
    const now = new Date('2026-10-11T12:00:00Z')
    // ⚠️ 三个「后缀不对」的夹具必须带一个**超期**日期：若用「今天」的日期，它们在两种正则下
    // 都落在窗口内 ⇒ 删不删都看不出来 ⇒ 尾锚 `$` 其实没人守着（修复轮 1/5 的 F4：
    // 去掉 `$` 的变异曾整轮幸存）。带超期日期才能问出真问题：「reader-2026-09-01.log.bak
    // 是不是一条该删的日志？」正确答案不是 —— 它不是 `reader-YYYY-MM-DD.log` 这个名字。
    const malformed = [
      'reader-backup.log',             // 前缀对、没有日期
      'reader-2026-13-99.log',         // 形状对、不是真日期
      'reader-20260911.log',           // 日期没分隔符
      'reader-2026-09-01.log.bak',     // 日期**超期**、后缀不对（尾锚的判别式）
      'reader-2026-09-01.log.gz',      // 同上
      'reader-2026-09-01.log.1',       // 轮转编号后缀，同样不许被当成日志
      'reader-.log',
    ]
    for (const name of malformed) writeFileSync(join(root, name), 'x')
    // 把它们全改成「很久以前」：若 prune 的判据里混进 mtime，这些会一起被误删。
    const longAgo = new Date('2000-01-01T00:00:00Z')
    for (const name of malformed) utimesSync(join(root, name), longAgo, longAgo)

    // 一份超期日志作对照：证明这次 prune 真的干活了（否则「全都没删」也能骗过上面那条）
    const stale = dailyLogPath(root, daysBefore(now, 30))
    writeFileSync(stale, 'line\n')

    assert.equal(pruneOldLogs(root, 14, now), 1)
    assert.equal(names(root).includes(basename(stale)), false, '超期的那份该删')
    assert.deepEqual(names(root), [...malformed].sort(), '认不出的 ' + malformed.length + ' 个名字必须原样留着')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneOldLogs 匹配到同名目录时跳过（EISDIR 不许升级成整次清理失败）', () => {
  const root = tempDir('isdir')
  try {
    const now = new Date('2026-10-11T12:00:00Z')
    // 一个**超期**的、名字恰好合形的目录：它匹配 LOG_NAME，若直接 unlinkSync 会抛 EISDIR ⇒
    // 整次 prune 抛错（用户看到一条无谓的清理告警），而目录本身也删不掉。
    // 目录不是日志，跳过它才是对的。
    mkdirSync(join(root, 'reader-2026-09-01.log'))
    writeFileSync(join(root, 'reader-2026-09-01.log', 'inner.txt'), 'x')
    writeFileSync(dailyLogPath(root, daysBefore(now, 30)), 'line\n')

    assert.equal(pruneOldLogs(root, 14, now), 1, '只该删掉那份真日志，撞名的目录不参与计数')
    // 整个集合比对：目录还在，且它是这里唯一的条目（那份超期真日志已被删）
    assert.deepEqual(names(root), ['reader-2026-09-01.log'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneOldLogs 对不存在的目录返回 0（首次装载还没写过日志）', () => {
  const base = tempDir('missing')
  try {
    assert.equal(pruneOldLogs(join(base, 'nope'), 14, new Date('2026-10-11T12:00:00Z')), 0)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('pruneOldLogs 读不了目录必须抛错（消息带路径），不静默当成「没有日志」', () => {
  const base = tempDir('unreadable')
  try {
    const notADir = join(base, 'not-a-dir')
    writeFileSync(notADir, 'x')
    // readdirSync 会抛 ENOTDIR。吞掉它 = 日志静默停更（无任何痕迹）。
    assert.throws(
      () => pruneOldLogs(notADir, 14, new Date()),
      (error) => error.message.includes(notADir),
    )
    // 目录不存在与之不同：那是首次装载的正常路径，不该抛（上面那条用例已钉）
    mkdirSync(join(base, 'empty-dir'))
    assert.equal(pruneOldLogs(join(base, 'empty-dir'), 14, new Date()), 0)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
