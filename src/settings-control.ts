/**
 * 设置覆盖层的**内存态**（R11 01 读取 / 02 写入 / 06 关于区数据，spec D3 / D4 / D4.1 / D6 / D7 / D8）。
 *
 * 它在 apply 里只做一次：读 `settings.json` → 快照四个键的基线 → 把 overrides 合并进
 * **同一个 config 对象**。之后 lifecycle / dispatch 每次调用读到的就是这份生效值（四个键都是
 * 「调用时现读」），所以改内存对象即下一次调用生效，不需要重启（spec §1 源码核对）。
 *
 * 写路径的唯一硬规则（D7）：**先落盘成功，再改内存**。反过来会出现「界面上已经生效、重启后
 * 打回原形」的半成功 —— 恰恰是最难被用户诊断的一种失败。写盘失败时本对象的 `overrides`
 * 与 config 都不许动。
 *
 * 为什么控制器不塞进 ReaderStore：settings 是插件配置，不是条目数据 —— ReaderStore 的接口
 * 是条目与订阅的契约，多一个方法会让 memory-store / store-sqlite 都被迫实现一份（D30）。
 */
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Config } from './config.js'
import type { Config as ConfigShape } from './config.js'
import { readSettingsFile, writeSettingsFile } from './storage/settings-file.js'
import type { NumberTunableKey, TunableKey, TunableSettings, TunableOverrides } from './settings-schema.js'
import { NUMBER_TUNABLE_KEYS, TUNABLE_KEYS, assignTunableValue } from './settings-schema.js'
import type { ReadOnlySettingView, SettingsSnapshot } from './shared.js'

/** 一次保存的结果：成功带回与读端点同形的快照，失败只带一句可展示的原因。 */
export type SettingsSaveOutcome =
  | { readonly ok: true; readonly snapshot: SettingsSnapshot }
  | { readonly ok: false; readonly message: string }

export interface SettingsControl {
  /** settings 端点的回包值：生效值 / 默认值 / 读侧告警 + 关于区数据。每次现读内存 config。 */
  snapshot: () => SettingsSnapshot
  /**
   * 逐项保存（02 票）。入参已由端点 schema 按白名单与范围校验过，这里只负责
   * 「合并 → 落盘 → 改内存 → 留痕」的固定顺序。
   */
  save: (patch: TunableOverrides) => SettingsSaveOutcome
  /**
   * 页面级「恢复默认」（07 票，D28）：一次写盘把四个数字键恢复成代码默认。
   *
   * 逐键的删 / 写判断只看**合并前的基线**（`baseline`）与默认值是否相等，不看当前生效值 ——
   * 当前生效值可能是用户刚覆盖的值，拿它判断会得出「已经等于默认就什么都不用做」，而文件里的
   * 旧覆盖（或将来改默认值后的钉子）仍然留着。
   */
  resetToDefaults: () => SettingsSaveOutcome
  /**
   * 合并**之前**的可调键基线快照（D4）。
   *
   * 界面不展示它（D16），恢复默认（07 票）靠它判断某个键该删覆盖还是写一条等于默认值的覆盖（D28）。
   */
  readonly baseline: TunableSettings
}

export interface SettingsControlDeps {
  readonly config: ConfigShape
  readonly settingsPath: string
  /** 与插件共用同一份日志（装载早期的设置问题也要能在 reader-*.log 里查到）。 */
  readonly log: (line: string) => void
}

/**
 * 「关于」区只读表的白名单与顺序（R11 06，spec §4.2 / D14.1）。
 *
 * 为什么要显式列出来而不是 `Object.keys(config)`：Config 将来加字段时，必须有人**决定**
 * 它是否对用户可见 —— 自动枚举会把内部参数一起漏给用户。这份名单是
 * 「Config 减去 `feeds`（订阅种子，不是参数）与可调键」的差集，顺序即页面顺序。
 * 取值直接读同一个 config 对象，所以页面上的值就是插件运行时真正在用的值。
 */
const READ_ONLY_KEYS = [
  'timeoutMs', 'maxBytes', 'maxItemsPerFeed', 'maxSeenPerFeed', 'maxContentChars',
  'maxArticleCacheChars', 'importConcurrency', 'articleMaxBytes', 'articleCooldownMs',
  'refreshOnStart', 'maxItemsShown', 'logFile',
] as const satisfies ReadonlyArray<Exclude<keyof ConfigShape, 'feeds' | TunableKey>>

function readOnlyOf(config: ConfigShape): ReadOnlySettingView[] {
  return READ_ONLY_KEYS.map((key) => ({ key, value: config[key] }))
}

/**
 * 插件版本：**运行时**读自己包里的 package.json，不在源码里抄字符串（D14 ⑤）。
 *
 * 路径相对本模块的 `import.meta.url`：src → lib 的两种运行形态都指向仓库/包根，
 * 所以构建产物与发布包不用区分。读不出就响亮抛错（版本是发布物的一部分，
 * 返回空串只会让「关于」区静默缺一行）。
 */
function readPackageVersion(): string {
  const file = new URL('../package.json', import.meta.url)
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  const version = typeof parsed === 'object' && parsed !== null
    ? (parsed as { version?: unknown }).version
    : undefined
  if (typeof version !== 'string' || version === '') {
    throw new Error('无法从 ' + file.pathname + ' 读出 version')
  }
  return version
}

export function createSettingsControl(deps: SettingsControlDeps): SettingsControl {
  const { config, settingsPath, log } = deps
  // 基线必须在合并之前拍：合并会改写 config，之后就再也分不出「patch 给的」与「settings 覆盖的」。
  const baseline = snapshotOf(config)
  // 默认值由 schema 现取，不做第二份常量（D4.1）。
  const defaults = snapshotOf(Config({} as ConfigShape))
  // 关于区的版本 / 路径在装载时固定；只读参数每次现读 config，和端点回包同源。
  const version = readPackageVersion()
  // settings.json 与 config.json / rss.db 同住 storageRoot()；它的目录就是「数据目录」，
  // 不另传一份路径 —— 少一个可以漂的来源。
  const dataDir = dirname(settingsPath)
  const outcome = readSettingsFile(settingsPath)

  let warning: string | undefined
  // 当前文件里真实存在的覆盖（不是生效值）：保存时要在这份之上做稀疏合并，
  // 否则「只改一项」会把另外三个 patch 基线值钉进文件（D3）。
  let overrides: TunableOverrides = {}
  if (outcome.status === 'unreadable') {
    // 读不出来是 I/O 错误（EACCES / EISDIR…），不是坏文件：用继承值继续、报警、留日志，
    // 但**不隔离改名** —— 改名治不好权限，还会把用户稍后能修好的文件搬走（D6 之外的一类）。
    warning = '设置文件无法读取（' + outcome.reason + '），当前使用继承值'
    log(warning)
  } else if (outcome.status === 'corrupt') {
    // D6 第一类：整份隔离，用继承值继续。不抛错 —— 设置文件坏掉不该让阅读器打不开。
    warning = outcome.quarantinedTo === undefined
      ? '设置文件无法读取（隔离失败：' + (outcome.quarantineError ?? '原因未知') + '），当前使用继承值'
      : '设置文件无法读取，已隔离为 ' + outcome.quarantinedTo + '，当前使用继承值'
    log(warning)
  } else if (outcome.status === 'ok') {
    if (outcome.dropped > 0) {
      warning = '有 ' + outcome.dropped + ' 项设置无法识别，已忽略'
      log(warning)
    }
    overrides = { ...outcome.overrides }
    // D3：只覆盖文件点名的键；其余键保持 patch / schema 默认给的值。
    // 键表是唯一的遍历来源：字符串键与数字键走同一段，不再另写一句 `rsshubBase`。
    for (const key of TUNABLE_KEYS) {
      const value = overrides[key]
      if (value === undefined) continue
      assignTunableValue(config, key, value)
    }
  }

  const snapshot = (): SettingsSnapshot => ({
    effective: snapshotOf(config),
    defaults,
    version,
    dataDir,
    settingsPath,
    readOnly: readOnlyOf(config),
    ...(warning === undefined ? {} : { warning }),
  })

  const save = (patch: TunableOverrides): SettingsSaveOutcome => {
    // 空 patch = 没有要改的项（D4.1 的 Partial 允许空对象）。这里必须**显式**空操作：
    // 继续往下会把现有 overrides 原样重写一遍 —— 内容没变但 mtime 变了，还会在写盘失败时
    // 把一个「什么都没改」的请求报成错误。回当前快照即可。
    if (Object.keys(patch).length === 0) return { ok: true, snapshot: snapshot() }
    const next: TunableOverrides = { ...overrides, ...patch }
    const before = snapshotOf(config)
    try {
      // ① 先落盘。这一行不成功，下面的内存改写一行都不执行（D7）。
      writeSettingsFile(settingsPath, next)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    // ② 落盘成功后才认这份覆盖：之后即使本进程崩掉，重启读到的也是刚写下的值。
    overrides = next
    for (const key of TUNABLE_KEYS) {
      const value = patch[key]
      if (value === undefined) continue
      assignTunableValue(config, key, value)
      // D8：每次成功保存留一行「旧 → 新」。设置页没有来源标签，日志是唯一的复盘凭据。
      log('设置：' + key + ' ' + before[key] + ' → ' + value)
    }
    return { ok: true, snapshot: snapshot() }
  }

  /**
   * 恢复默认（R11 07，spec D28 / D8）。
   *
   * 逐键规则：
   *  - 基线恰好等于默认值 ⇒ **删覆盖**，生效值回落到基线（正好是默认值），不留钉子；
   *  - 基线不等于默认值 ⇒ **写一条等于默认值的覆盖** —— 删掉覆盖只会回落到非默认的基线。
   *
   * 整组只写一次盘，成功后才改内存并逐键留痕（与 save 同一条 D7 顺序）。四项本来就都已是
   * 默认值时直接返回、不碰文件：写一份相同内容只会改 mtime，还多一次可能失败的 IO。
   */
  const resetToDefaults = (): SettingsSaveOutcome => {
    const prior = snapshotOf(config)
    const next: TunableOverrides = { ...overrides }
    const actions: Array<{ readonly key: NumberTunableKey; readonly kind: 'delete' | 'write' }> = []
    for (const key of NUMBER_TUNABLE_KEYS) {
      const target = defaults[key]
      if (baseline[key] === target) {
        if (next[key] !== undefined) {
          delete next[key]
          actions.push({ key, kind: 'delete' })
        }
      } else if (next[key] !== target) {
        next[key] = target
        actions.push({ key, kind: 'write' })
      }
    }
    if (actions.length === 0) return { ok: true, snapshot: snapshot() }
    try {
      // ① 先落盘（D7）：失败时下面的内存改写一行都不执行。
      writeSettingsFile(settingsPath, next)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    // ② 落盘成功后才认这份状态：四项一起回到默认值（删覆盖的键由基线回落，写覆盖的键由覆盖给出）。
    overrides = next
    for (const key of NUMBER_TUNABLE_KEYS) config[key] = defaults[key]
    for (const action of actions) {
      // D8：删覆盖记结果值（括号里的默认值）；写覆盖记旧的生效值 → 新的默认值。
      log(action.kind === 'delete'
        ? '恢复默认：' + action.key + ' 删覆盖（' + defaults[action.key] + '）'
        : '恢复默认：' + action.key + ' ' + prior[action.key] + ' → ' + defaults[action.key])
    }
    return { ok: true, snapshot: snapshot() }
  }

  return { baseline, snapshot, save, resetToDefaults }
}

/**
 * 可调键快照：只搬运白名单键，不整份复制 Config（配置面有 17 个字段，设置页只关心这几项）。
 * 显式列出字段而不是索引循环：键表扩成数字 / 字符串混合后，索引写入会失去类型保证。
 */
function snapshotOf(config: ConfigShape): TunableSettings {
  return {
    refreshFeedsPerRound: config.refreshFeedsPerRound,
    refreshConcurrency: config.refreshConcurrency,
    minRefreshIntervalMs: config.minRefreshIntervalMs,
    cleanupAfterDays: config.cleanupAfterDays,
    rsshubBase: config.rsshubBase,
  }
}
