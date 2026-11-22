/**
 * 设置覆盖层的**内存态**（R11 01，spec D4 / D4.1 / D6；R11 06 追加「关于」区数据）。
 *
 * 它在 apply 里只做一次：读 `settings.json` → 快照四个键的基线 → 把 overrides 合并进
 * **同一个 config 对象**。之后 lifecycle / dispatch 每次调用读到的就是这份生效值（四个键都是
 * 「调用时现读」），所以改内存对象即下一次调用生效，不需要重启（spec §1 源码核对）。
 *
 * 为什么控制器不塞进 ReaderStore：settings 是插件配置，不是条目数据 —— ReaderStore 的接口
 * 是条目与订阅的契约，多一个方法会让 memory-store / store-sqlite 都被迫实现一份（D30）。
 */
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Config } from './config.js'
import type { Config as ConfigShape } from './config.js'
import { readSettingsFile } from './storage/settings-file.js'
import type { TunableKey, TunableSettings } from './settings-schema.js'
import { TUNABLE_KEYS } from './settings-schema.js'
import type { ReadOnlySettingView, SettingsSnapshot } from './shared.js'

export interface SettingsControl {
  /** settings 端点的回包值：生效值 / 默认值 / 读侧告警 + 关于区数据。每次现读内存 config。 */
  snapshot: () => SettingsSnapshot
  /**
   * 合并**之前**的四键基线快照（D4）。
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
 * 「Config 减去 `feeds`（订阅种子，不是参数）与四个可调键」的差集，顺序即页面顺序。
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
  if (outcome.status === 'corrupt') {
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
    // D3：只覆盖文件点名的键；其余键保持 patch / schema 默认给的值。
    for (const key of TUNABLE_KEYS) {
      const value = outcome.overrides[key]
      if (value === undefined) continue
      config[key] = value
    }
  }

  return {
    baseline,
    snapshot: () => ({
      effective: snapshotOf(config),
      defaults,
      version,
      dataDir,
      settingsPath,
      readOnly: readOnlyOf(config),
      ...(warning === undefined ? {} : { warning }),
    }),
  }
}

/** 四键快照：只搬运白名单键，不整份复制 Config（配置面有 17 个字段，设置页只关心这四个）。 */
function snapshotOf(config: ConfigShape): TunableSettings {
  const snapshot = {} as TunableSettings
  for (const key of TUNABLE_KEYS) snapshot[key] = config[key]
  return snapshot
}
