/**
 * 设置覆盖层的**内存态**（R11 01，spec D4 / D4.1 / D6）。
 *
 * 它在 apply 里只做一次：读 `settings.json` → 快照四个键的基线 → 把 overrides 合并进
 * **同一个 config 对象**。之后 lifecycle / dispatch 每次调用读到的就是这份生效值（四个键都是
 * 「调用时现读」），所以改内存对象即下一次调用生效，不需要重启（spec §1 源码核对）。
 *
 * 为什么控制器不塞进 ReaderStore：settings 是插件配置，不是条目数据 —— ReaderStore 的接口
 * 是条目与订阅的契约，多一个方法会让 memory-store / store-sqlite 都被迫实现一份（D30）。
 */
import { Config } from './config.js'
import type { Config as ConfigShape } from './config.js'
import { readSettingsFile } from './storage/settings-file.js'
import type { TunableSettings } from './settings-schema.js'
import { TUNABLE_KEYS } from './settings-schema.js'
import type { SettingsSnapshot } from './shared.js'

export interface SettingsControl {
  /** settings 端点的回包值：生效值 + 默认值（+ 读侧告警）。每次现读内存 config。 */
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

export function createSettingsControl(deps: SettingsControlDeps): SettingsControl {
  const { config, settingsPath, log } = deps
  // 基线必须在合并之前拍：合并会改写 config，之后就再也分不出「patch 给的」与「settings 覆盖的」。
  const baseline = snapshotOf(config)
  // 默认值由 schema 现取，不做第二份常量（D4.1）。
  const defaults = snapshotOf(Config({} as ConfigShape))
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
