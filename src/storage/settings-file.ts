/**
 * `storages/rss-reader/settings.json` 的落点（R11，spec D1 / D2 / D6）。
 *
 * 为什么**不复用** `writeConfigFile`：那个函数绑定 `ReaderConfigFile` 的形状，写前会
 * `validateConfig` 并把未声明的顶层键丢掉 —— 用它写设置等于让两个不同职责的文件共用一套 schema。
 * 这里照抄它的**原子写协议**（同目录临时文件 → `wx` + 0600 → 写 → fsync → rename），
 * 但不共享任何形状判断。
 *
 * 读侧失败分三类（D6，不许合并成一条）：
 *  ① 不是合法 JSON / 顶层不是对象 / 版本认不出 ⇒ 整份隔离为 `settings.json.corrupt-<时间戳>`；
 *  ② 某个键值超范围或类型错 ⇒ 只丢那个键，其余照用，**不自动重写文件**；
 *  ③ 认不出的键 ⇒ 读时忽略（写时也不会回写，因为写路径只遍历白名单）。
 *
 * ④ 另外还有一类**不是文件内容的问题**：读操作本身失败（EACCES / EISDIR…）。它不是坏文件，
 * 不能走隔离改名 —— 改名既治不好权限，也会把一个暂时读不到的文件永久搬走。这类走
 * `unreadable` 独立 outcome，由调用方用继承值继续并报警（D17 的警示条）。
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isTunableKey, parseTunableValue, TUNABLE_KEYS } from '../settings-schema.js'
import type { TunableOverrides } from '../settings-schema.js'

/** 本版只认 1；版本不是 1 与「不是合法 JSON」走同一条隔离路（D2 的闸门语义）。 */
export const SETTINGS_VERSION = 1

/** 读一次设置文件的四种结果。 `warning` 的文案由控制器拼，本模块只说事实。 */
export type SettingsReadOutcome =
  | { readonly status: 'absent' }
  | { readonly status: 'ok'; readonly overrides: TunableOverrides; readonly dropped: number }
  /** 读操作本身失败（不是坏文件）：继承值继续，不做隔离改名。 */
  | { readonly status: 'unreadable'; readonly reason: string }
  | {
    readonly status: 'corrupt'
    readonly reason: string
    /** 隔离成功时的目标路径；隔离失败时缺席，失败原因在 `quarantineError`。 */
    readonly quarantinedTo?: string
    readonly quarantineError?: string
  }

/**
 * 读设置文件。**永远不抛**：坏文件不能阻断启动，返回 `corrupt` / `unreadable` 由调用方决定怎么报警。
 *
 * 只有 ENOENT 算「从未写过」（D18）。其余读失败（EACCES / EISDIR…）是 I/O 错误，不是「文件内容坏了」：
 * 它们没有可隔离的坏数据，改名也修不好权限 ⇒ 返回 `unreadable`，让调用方用继承值继续并说明原因。
 * 把「读不出来」当成「没有」会让一次权限故障冒充首装，用户永远不会知道自己的设置为什么没生效。
 */
export function readSettingsFile(path: string): SettingsReadOutcome {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { status: 'absent' }
    // 读失败 ≠ 坏文件（D6 只定义内容异常的三类）：不调 corrupt()，绝不做 renameSync。
    return { status: 'unreadable', reason: '读取失败：' + String(error) }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return corrupt(path, '不是合法 JSON：' + String(error))
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return corrupt(path, '顶层不是对象（读到 ' + describe(parsed) + '）')
  }
  const record = parsed as Record<string, unknown>
  if (record['version'] !== SETTINGS_VERSION) {
    return corrupt(path, '版本是 ' + JSON.stringify(record['version']) + '，本版只认 ' + SETTINGS_VERSION)
  }
  const rawOverrides = record['overrides']
  if (typeof rawOverrides !== 'object' || rawOverrides === null || Array.isArray(rawOverrides)) {
    return corrupt(path, 'overrides 不是对象（读到 ' + describe(rawOverrides) + '）')
  }

  const overrides: TunableOverrides = {}
  let dropped = 0
  for (const [key, value] of Object.entries(rawOverrides as Record<string, unknown>)) {
    // ③ 未知键读时忽略，且**不计入** dropped：它不是坏值，只是本版不认识。
    if (!isTunableKey(key)) continue
    // ② 逐键丢弃：一次坏值只该抹掉它自己，不许把另外三项一起带走（与 sanitizeViewPreferences 同一条规则）。
    const parsedValue = parseTunableValue(key, value)
    if (parsedValue === undefined) {
      dropped += 1
      continue
    }
    overrides[key] = parsedValue
  }
  return { status: 'ok', overrides, dropped }
}

/**
 * 原子写整份设置（只写白名单内的键，稀疏）。
 *
 * 为什么先校验再写：写进去读不回来的值等于把坏数据固化；调用方的错误要在落盘前就响。
 * 失败时临时文件被清掉、原文件不动（与 writeConfigFile 同一条不变式）。
 */
export function writeSettingsFile(path: string, overrides: TunableOverrides): void {
  const clean: TunableOverrides = {}
  for (const key of TUNABLE_KEYS) {
    const value = overrides[key]
    if (value === undefined) continue
    const parsed = parseTunableValue(key, value)
    if (parsed === undefined) {
      throw new Error('设置项 ' + key + ' 的值不合法：' + JSON.stringify(value))
    }
    clean[key] = parsed
  }
  const serialized = JSON.stringify({ version: SETTINGS_VERSION, overrides: clean }, null, 2) + '\n'
  const tmp = join(dirname(path), '.' + randomUUID() + '.tmp')
  try {
    // 'wx' + 0600：临时文件也必须是 0600，否则 rename 之后权限就放宽了
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeFileSync(fd, serialized, 'utf8')
      // fsync 才让「rename 之后的内容」在掉电后真的还在；只 rename 只保证「要么旧要么新」
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch (cleanupError) {
      throw new Error(
        '写设置文件 ' + path + ' 失败：' + String(error) + '；清理临时文件 ' + tmp + ' 也失败：' + String(cleanupError),
        { cause: error },
      )
    }
    throw new Error('写设置文件 ' + path + ' 失败（临时文件已清理，原文件未动）：' + String(error), { cause: error })
  }
}

/** 整份隔离：改名保留原文件，绝不让下一次启动继续读同一份坏数据。 */
function corrupt(path: string, reason: string): SettingsReadOutcome {
  const target = path + '.corrupt-' + new Date().toISOString().replace(/:/g, '-')
  try {
    renameSync(path, target)
    return { status: 'corrupt', reason, quarantinedTo: target }
  } catch (error) {
    // 隔离失败不能吞成「什么都没发生」：把原因带回调用方，页面警示条会说明这一情况。
    return { status: 'corrupt', reason, quarantineError: String(error) }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === code
}

/** 值的人话描述：错误消息里报 `typeof` 常常看不出「[] 与 {} 的区别」。 */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}
