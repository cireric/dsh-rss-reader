/**
 * 刷新日志的落点与保留窗口（host 半，Task 7）。
 *
 * **为什么从 `state/dsh-rss-reader/reader.log` 搬到这里、并且按天分文件**：
 * 旧路径是「一个文件写到天荒地老」（本机实测 503 KB），而它和用户数据没有任何关系，
 * 却和 `storages/rss-reader/` 里的订阅文件各占一处 —— 排查时得先知道路径才找得到。
 * 搬进插件自己的存储根之后，日志与 config.json / rss.db 同住，按天分文件让「保留多少天」
 * 变成一个能真的执行的策略。
 *
 * ⚠️ **上面那个旧路径是历史，不是活着的落点**：本文件只写 `reader-YYYY-MM-DD.log`，
 * 没有任何代码再写或读 `state/dsh-rss-reader/`。别照着它去找今天的日志。
 *
 * ⚠️ **prune 的杀伤面必须窄到只认 `reader-YYYY-MM-DD.log`**：同一个目录里躺着用户订阅的
 * 唯一副本 config.json 和装着已读态/星标的 rss.db（含 -wal / -shm 边车）。一次前缀匹配
 * （`startsWith('reader-')`）或随手一个 `reader-*` glob，某天就会开始删用户数据 ——
 * 而删除是不可逆的。认不出的名字一律**跳过**：宁可留一个垃圾文件，不可猜一个日期。
 *
 * **判据只看文件名，不看 mtime**：mtime 会被备份/rsync/cp -a/改系统时钟改掉，
 * 而文件名里的日期才是「这条日志属于哪一天」本身。
 *
 * **日期一律用 UTC**：日志行首的时间戳由 `toISOString()` 写死为 UTC，文件名必须跟着它走，
 * 否则「同一条日志属于哪一天」取决于在哪台机器上看（本机是 CST，差 8 小时）。
 */
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** 一天的毫秒数。日志按整天划分，不引入日历库（跨时区的偏移不存在：一切按 UTC）。 */
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 日志文件名的唯一形状。**匹配与解析共用这一条正则**，避免「删的时候宽、认的时候窄」
 * 这类两边慢慢漂开的经典缺陷。
 */
const LOG_NAME = /^reader-(\d{4})-(\d{2})-(\d{2})\.log$/

const errnoOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : ''

/**
 * 某一天的日志路径：`<root>/reader-YYYY-MM-DD.log`（UTC 日期）。
 *
 * @param root 日志目录（插件存储根 `storages/rss-reader`，或 `config.logFile` 的 dirname）
 * @param date 归属哪一天；传 `new Date()` 即「今天」
 */
export function dailyLogPath(root: string, date: Date): string {
  // toISOString 对非法 Date 会抛 RangeError —— 响亮失败好过拼出一个 'reader-NaN-NaN-NaN.log'
  return join(root, 'reader-' + date.toISOString().slice(0, 10) + '.log')
}

/**
 * 从文件名里解出 UTC 当日 00:00 的毫秒数；认不出返回 `undefined`。
 *
 * 不直接用 `Date.parse(name)`：它对日期串的宽容度随实现而变，且「解析成功」不等于
 * 「这是个真日期」——`2026-13-99` 这种形状合法、日期不存在的名字必须被挡在外面。
 * 这里把三段数字喂给 `Date.UTC` 再回读，回读对不上就说明发生了进位（即不是真日期）。
 */
function dayMsOf(name: string): number | undefined {
  const matched = LOG_NAME.exec(name)
  if (matched === null) return undefined
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  const at = Date.UTC(year, month - 1, day)
  const probe = new Date(at)
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return undefined
  }
  return at
}

/**
 * 删掉超出保留窗口的日志文件，返回**成功删除的个数**。
 *
 * 保留窗口是**闭区间**：`[今天 − (keepDays − 1) 天, 今天]`。即 keepDays = 14 时，
 * 今天与前 13 天（共 14 个日期）留着，第 14 天前的那份删掉。边界取闭区间是因为
 * 「保留 14 天」的自然读法是「14 份按天日志」而不是「13 份」，而且它能被一条
 * 钉在两侧的用例固定住（tests/log-file.test.mjs 的边界用例）。
 *
 * 两种失败的性质**不同**，所以处理也不同：
 * - **目录不存在**（ENOENT）= 首次装载还没写过日志，是正常路径 ⇒ 返回 0；
 * - **读不了目录 / 删不掉某个文件** = 真故障 ⇒ **抛错并带上路径**，由调用方（src/index.ts 的
 *   log 路径）写进 ctx.logger 留痕。绝不吞掉：日志静默停更，用户与 agent 都无从察觉。
 *   删除是逐个尽力而为的（某一份失败不影响其余），失败清单汇总在抛出的错误消息里。
 *
 * @param root 日志目录
 * @param keepDays 保留天数（含今天），默认 14
 * @param now 判定「今天」的时刻，默认当前时间（测试用）
 * @throws 目录读不出来、或有文件删不掉时（消息含路径与失败文件名）。
 */
export function pruneOldLogs(root: string, keepDays = 14, now: Date = new Date()): number {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return 0
    throw new Error(`读取日志目录 ${root} 失败（无法判断哪些日志超期，未删任何文件）：${String(error)}`, {
      cause: error,
    })
  }

  // 「今天」= now 的 UTC 日零点。用日期边界而不是 now 本身，是为了让文件名里的日期
  // 直接可比（否则「今天」这个判据会随当天时刻滑出窗口）。
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const cutoff = today - (keepDays - 1) * DAY_MS

  let removed = 0
  const failures: string[] = []
  for (const name of entries) {
    const day = dayMsOf(name)
    // 认不出的名字（reader-backup.log / reader-2026-13-99.log / reader-.log …）一律跳过。
    // ⚠️ 这半边 `day === undefined` **不是**可有可无的等价写法：少了它，判据就只剩
    // `if (day >= cutoff) continue`，而 undefined >= 数字 恒为 false ⇒ 认不出的名字会**直接落到
    // 下面的 unlinkSync**，把同目录的 config.json / rss.db 及其边车一起删掉（不可逆）。
    // 它同时守着「认不出就跳过」这条契约的两端，所以两条都要在。
    if (day === undefined || day >= cutoff) continue
    try {
      // 只删**普通文件**。同名**目录**同样匹配 LOG_NAME，而 unlinkSync 删目录会抛 EISDIR ——
      // 那会把「目录撞名」这条正常路径升级成一次整次的清理失败（用户看到一条无谓的告警），
      // 而目录本身也没被删掉。`throwIfNoEntry: false` 另挡「readdir 之后条目消失」的竞态。
      // 两者都是「跳过」，与上面「认不出就跳过」同一条纪律。
      // statSync 的其余错误（EACCES / ELOOP …）与 unlinkSync 的失败一起收进 failures ——
      // 一并响亮地抛出，绝不退化成「静默停更」。
      const entry = statSync(join(root, name), { throwIfNoEntry: false })
      if (entry === undefined || !entry.isFile()) continue
      unlinkSync(join(root, name))
      removed += 1
    } catch (error) {
      failures.push(name + '（' + String(error) + '）')
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `删除超期日志失败（已删 ${removed} 个，共 ${failures.length} 个失败，目录 ${root}）：` + failures.join('、'),
    )
  }
  return removed
}
