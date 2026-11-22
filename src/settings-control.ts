/**
 * 设置覆盖层的**内存态**（R11 01 读取 / 02 写入，spec D3 / D4 / D4.1 / D6 / D7 / D8）。
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
import { Config } from './config.js'
import type { Config as ConfigShape } from './config.js'
import { readSettingsFile, writeSettingsFile } from './storage/settings-file.js'
import type { TunableSettings, TunableOverrides } from './settings-schema.js'
import { TUNABLE_KEYS } from './settings-schema.js'
import type { SettingsSnapshot } from './shared.js'

/** 一次保存的结果：成功带回与读端点同形的快照，失败只带一句可展示的原因。 */
export type SettingsSaveOutcome =
  | { readonly ok: true; readonly snapshot: SettingsSnapshot }
  | { readonly ok: false; readonly message: string }

export interface SettingsControl {
  /** settings 端点的回包值：生效值 + 默认值（+ 读侧告警）。每次现读内存 config。 */
  snapshot: () => SettingsSnapshot
  /**
   * 逐项保存（02 票）。入参已由端点 schema 按白名单与范围校验过，这里只负责
   * 「合并 → 落盘 → 改内存 → 留痕」的固定顺序。
   */
  save: (patch: TunableOverrides) => SettingsSaveOutcome
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

export function createSettingsControl(deps: SettingsControlDeps): SettingsControl {
  const { config, settingsPath, log } = deps
  // 基线必须在合并之前拍：合并会改写 config，之后就再也分不出「patch 给的」与「settings 覆盖的」。
  const baseline = snapshotOf(config)
  // 默认值由 schema 现取，不做第二份常量（D4.1）。
  const defaults = snapshotOf(Config({} as ConfigShape))
  const outcome = readSettingsFile(settingsPath)

  let warning: string | undefined
  // 当前文件里真实存在的覆盖（不是生效值）：保存时要在这份之上做稀疏合并，
  // 否则「只改一项」会把另外三个 patch 基线值钉进文件（D3）。
  let overrides: TunableOverrides = {}
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
    overrides = { ...outcome.overrides }
    // D3：只覆盖文件点名的键；其余键保持 patch / schema 默认给的值。
    for (const key of TUNABLE_KEYS) {
      const value = overrides[key]
      if (value === undefined) continue
      config[key] = value
    }
  }

  const snapshot = (): SettingsSnapshot => ({
    effective: snapshotOf(config),
    defaults,
    ...(warning === undefined ? {} : { warning }),
  })

  const save = (patch: TunableOverrides): SettingsSaveOutcome => {
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
      config[key] = value
      // D8：每次成功保存留一行「旧 → 新」。设置页没有来源标签，日志是唯一的复盘凭据。
      log('设置：' + key + ' ' + before[key] + ' → ' + value)
    }
    return { ok: true, snapshot: snapshot() }
  }

  return { baseline, snapshot, save }
}

/** 四键快照：只搬运白名单键，不整份复制 Config（配置面有 17 个字段，设置页只关心这四个）。 */
function snapshotOf(config: ConfigShape): TunableSettings {
  const snapshot = {} as TunableSettings
  for (const key of TUNABLE_KEYS) snapshot[key] = config[key]
  return snapshot
}
