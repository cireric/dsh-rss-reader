/**
 * RSSHub 实例池的**内存态与写路径**（R15 01，spec §4.1.1 / §4.1.2 / §5 / §6 A5–A6）。
 *
 * 为什么单独成模块而不是塞进 settings-control：`settings.json` 是**标量覆盖层**，池子是数组；
 * 而且池子住在 `config.json`（与 `feeds` / `folders` 同一份用户真相），写盘必须 read-modify-write，
 * 不能把整份 config 从内存对象序列化回磁盘 —— 那会把 store 刚写进去的 feeds 状态冲掉。
 *
 * 两条硬规则：
 *  1. **先落盘成功，再改内存**（与 settings-control 的 D7 同一条）：否则界面显示已生效、重启打回原形；
 *  2. **写盘保留其它顶层字段**：每次保存都重新读一遍 config.json，只替换 `rsshub` 这一块。
 *
 * 迁移判据（A5）：`config.rsshub` 缺省 ⇒ 内存视为 `[config.rsshubBase]`；`instances: []` 是用户
 * 主动关闭，**不回落**旧值。这两件事必须可区分 —— 否则「清空池」永远关不掉升级前留下的地址。
 */
import type { Config as ConfigShape } from './config.js'
import { parseRsshubBase } from './settings-schema.js'
import type { RsshubSettingsSnapshot } from './shared.js'
import {
  RSSHUB_INSTANCE_MAX,
  readConfigFile,
  writeConfigFile,
  type ReaderConfigFile,
  type ReaderRsshubConfig,
} from './storage/config-file.js'

/** 一次保存的 patch：只带要改的字段。实例数组是整份替换（顺序即优先级）。 */
export interface RsshubSettingsPatch {
  readonly instances?: string[]
  readonly hiddenNamespaces?: string[]
  readonly hideNsfw?: boolean
}

/**
 * 一次保存的结果。失败只带一句可展示的原因：写盘失败与「超过 5 条」是两类不同错误，
 * 但它们都只影响这一次操作，界面只需要说清楚「为什么没存下」。
 */
export type RsshubSettingsSaveOutcome =
  | { readonly ok: true; readonly snapshot: RsshubSettingsSnapshot }
  // `reason` 让端点把「你输错了」与「磁盘写不进去」分成两种信封：用户要采取的动作不同。
  | { readonly ok: false; readonly message: string; readonly reason: 'invalid' | 'write-failed' }

export interface RsshubSettingsControl {
  /** 设置页读端点：生效实例池 + 筛选偏好 + 读侧告警。 */
  snapshot: () => RsshubSettingsSnapshot
  /**
   * 当前生效的实例池（顺序即优先级）。发现 / 探索 / 刷新只读这一份。
   *
   * 返回副本：调用方拿到的是快照，不是可以反向改内存态的内部数组。
   */
  instances: () => string[]
  /** 保存整份实例池（或 06 / 07 票的筛选偏好）。先落盘成功，再改内存。 */
  save: (patch: RsshubSettingsPatch) => RsshubSettingsSaveOutcome
}

export interface RsshubSettingsDeps {
  /** 插件配置（`settings.json` 已合并）。只在构造时用来读取遗留键 `rsshubBase`。 */
  readonly config: ConfigShape
  /** `config.json` 的落点：池子与订阅同在那一份文件里。 */
  readonly configPath: string
  readonly log: (line: string) => void
}

/**
 * 旧的 `rsshubBase` 折算成单元素池。
 *
 * 空串 / 非法地址都折成空池：`parseRsshubBase` 是地址的唯一判据，这里不另写一套。
 */
function legacyInstancesOf(config: ConfigShape): string[] {
  const base = parseRsshubBase(config.rsshubBase)
  return base === undefined || base === '' ? [] : [base]
}

function cloneState(state: ReaderRsshubConfig): ReaderRsshubConfig {
  return {
    instances: [...state.instances],
    hiddenNamespaces: [...state.hiddenNamespaces],
    hideNsfw: state.hideNsfw,
  }
}

/**
 * 读一次 config.json，得到内存初值。
 *
 * `config.json` 读不出来时**不抛错**（对照 readConfigFile 在装载路径上的响亮失败）：这里只负责
 * 设置页与发现功能的实例池。真的文件损坏会在 lifecycle 装载时响亮失败，不该由设置面板抢先炸掉；
 * 但必须留一行日志 + 一条警示，不能装作「池子是空的」。
 */
function readInitialState(
  config: ConfigShape,
  configPath: string,
  log: (line: string) => void,
): { state: ReaderRsshubConfig; warning: string | undefined; legacy: boolean } {
  const warnings: string[] = []
  try {
    const file = readConfigFile(configPath, (line) => {
      warnings.push(line)
      log(line)
    })
    if (file.rsshub !== undefined) {
      return { state: cloneState(file.rsshub), warning: warnings.length === 0 ? undefined : warnings.join('；'), legacy: false }
    }
    return {
      state: { instances: legacyInstancesOf(config), hiddenNamespaces: [], hideNsfw: true },
      warning: warnings.length === 0 ? undefined : warnings.join('；'),
      legacy: true,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const warning = `订阅文件无法读取（${message}），实例池暂按旧设置显示`
    log(warning)
    return {
      state: { instances: legacyInstancesOf(config), hiddenNamespaces: [], hideNsfw: true },
      warning,
      legacy: true,
    }
  }
}

export function createRsshubSettings(deps: RsshubSettingsDeps): RsshubSettingsControl {
  const { config, configPath, log } = deps
  const initial = readInitialState(config, configPath, log)
  let state = initial.state
  let warning = initial.warning
  // 「池子从未写过」时继续每次现读遗留的 `rsshubBase`：saveSettings 仍可改它（API / 旧界面），
  // 读到的必须立刻生效，而不是等重启。第一次保存池子后这个模式永久结束（显式空数组也算写过了）。
  let legacyMode = initial.legacy

  const effectiveInstances = (): string[] => legacyMode ? legacyInstancesOf(config) : state.instances

  const snapshot = (): RsshubSettingsSnapshot => ({
    instances: [...effectiveInstances()],
    hiddenNamespaces: [...state.hiddenNamespaces],
    hideNsfw: state.hideNsfw,
    ...(warning === undefined ? {} : { warning }),
  })

  const save = (patch: RsshubSettingsPatch): RsshubSettingsSaveOutcome => {
    let dropped = 0
    const next = cloneState(state)
    // 只改筛选偏好时也要带上**此刻**的遗留实例（legacyMode 下 state 是构造时的旧值）。
    next.instances = [...effectiveInstances()]

    if (patch.instances !== undefined) {
      // 上限先判「条数」再判「每条地址」：用户传 6 条时，说的是「最多 5 个」而不是逐条地址错误。
      if (patch.instances.length > RSSHUB_INSTANCE_MAX) {
        return {
          ok: false,
          reason: 'invalid',
          message: `最多 ${RSSHUB_INSTANCE_MAX} 个实例（当前 ${patch.instances.length} 个），请先删减到上限以内`,
        }
      }
      const instances: string[] = []
      for (const [index, entry] of patch.instances.entries()) {
        const parsed = parseRsshubBase(entry)
        if (parsed === undefined || parsed === '') {
          dropped += 1
          // 不回显原始地址：URL 可能带 userinfo（凭据），日志不该成为第二份泄漏面。
          log(`RSSHub 实例池：第 ${index + 1} 项不是合法的实例源站（只支持 http(s)，不能带路径 / 查询 / 参数），已丢弃`)
          continue
        }
        instances.push(parsed)
      }
      next.instances = instances
    } else if (next.instances.length > RSSHUB_INSTANCE_MAX) {
      // 只改筛选偏好时也可能撞上「手改文件留下的 6 条」：写盘前仍按 0–5 的契约再判一次。
      return {
        ok: false,
        reason: 'invalid',
        message: `最多 ${RSSHUB_INSTANCE_MAX} 个实例（当前 ${next.instances.length} 个），请先删减到上限以内`,
      }
    }

    if (patch.hiddenNamespaces !== undefined) {
      const hidden: string[] = []
      for (const [index, entry] of patch.hiddenNamespaces.entries()) {
        if (typeof entry !== 'string' || entry.trim() === '') {
          dropped += 1
          log(`RSSHub 隐藏列表：第 ${index + 1} 项不是非空字符串，已丢弃`)
          continue
        }
        hidden.push(entry.trim())
      }
      // 去重后落盘：同一个 namespace 点两次「隐藏此站点」仍是同一件事。留下重复项会让
      // 设置页显示「已隐藏（3）」而实际只有两个站点 —— 界面数字与事实分家。
      next.hiddenNamespaces = [...new Set(hidden)]
    }

    if (patch.hideNsfw !== undefined) next.hideNsfw = patch.hideNsfw

    // 每次保存都重新读一遍：store 可能刚写过 feeds / folders / feedOrder，内存态不是权威。
    let current: ReaderConfigFile
    try {
      current = readConfigFile(configPath)
    } catch (error) {
      return { ok: false, reason: 'write-failed', message: error instanceof Error ? error.message : String(error) }
    }
    try {
      // ① 先落盘。这一行不成功，下面的内存改写一行都不执行。
      writeConfigFile(configPath, { ...current, rsshub: next })
    } catch (error) {
      return { ok: false, reason: 'write-failed', message: error instanceof Error ? error.message : String(error) }
    }

    // ② 落盘成功后才认这份状态。写过池子之后不再回落到遗留键（哪怕是空数组）。
    state = next
    legacyMode = false
    warning = dropped === 0
      ? undefined
      : `已忽略 ${dropped} 条无效项（网络地址只支持 http(s) 源站，不能带路径 / 查询 / 参数）`
    if (warning !== undefined) log(warning)
    log('RSSHub 实例池：保存 ' + next.instances.length + ' 个实例'
      + (next.instances.length === 0 ? '（功能关闭）' : '：' + next.instances.join('、')))
    return { ok: true, snapshot: snapshot() }
  }

  return {
    snapshot,
    instances: () => [...effectiveInstances()],
    save,
  }
}
