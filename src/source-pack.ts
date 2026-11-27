/**
 * 精选源包的内存态与写路径（R15 08，spec §4.3.1 / §5.1 / §6 A13）。
 *
 * 为什么单独成模块而不是塞进 store：清单住在 `config.json`（与 `feeds` / `folders` 同一份
 * 用户真相），写盘必须 read-modify-write —— 不能把整份 config 从内存对象序列化回磁盘，
 * 那会把 store 刚写进去的订阅状态冲掉。
 *
 * 两条硬规则（与 rsshub-settings / settings-control 同一条）：
 *  1. **先落盘成功，再改内存**：否则界面显示已删除、重启又回来；
 *  2. **写盘保留其它顶层字段**：每次保存都重新读一遍 config.json，只替换 `curatedSources`。
 *
 * 初始化语义（spec §4.3.1）：
 *  - 字段**不存在** ⇒ 首次打开（第一次取快照）时用 `src/curated-seed.ts` 的内置快照初始化并落盘；
 *  - 字段**存在但为空数组** ⇒ 用户删光了，**不再自动填充**。
 *  这两件事必须可区分 —— 否则「删光」永远关不掉种子。初始化刻意放在 `snapshot()` 而不是
 *  构造函数：插件装载不等于用户打开了「精选源」视图，装载时写盘会让「只是升级了插件」也留下
 *  一份 79 条的清单。
 */
import { CURATED_SEED, CURATED_SEED_META } from './curated-seed.js'
import {
  normalizeCuratedSources,
  readConfigFile,
  writeConfigFile,
  type ReaderConfigFile,
} from './storage/config-file.js'
import type { CuratedSourceEntry, SourcePackSnapshot } from './shared.js'

/**
 * 一次保存的结果。坏项**不是**失败：逐条丢弃后在 `snapshot.warning` 与 `dropped` 里回报；
 * 只有写盘失败才让整次操作失败（用户要去查磁盘 / 权限，而不是改自己的输入）。
 */
export type SourcePackSaveOutcome =
  | {
      readonly ok: true
      readonly snapshot: SourcePackSnapshot
      readonly dropped: number
      /** 「恢复内置快照」本次补进来的条数（普通保存恒为 0）。 */
      readonly restored: number
    }
  | { readonly ok: false; readonly message: string; readonly reason: 'write-failed' }

export interface SourcePackControl {
  /** 读端点：当前清单 + 内置快照元信息 + 读侧告警。首次调用可能触发种子初始化并落盘。 */
  snapshot: () => SourcePackSnapshot
  /**
   * 整份替换清单。`entries` 是客户端送来的原始数组（不可信），逐条归一化 + 去重后落盘。
   * `restoreSeed` = 恢复内置快照：只补**缺失**的 URL，不清空用户自己的条目。
   */
  save: (entries: readonly unknown[], options?: { restoreSeed?: boolean }) => SourcePackSaveOutcome
}

export interface SourcePackDeps {
  /** `config.json` 的落点：清单与订阅同在那一份文件里。 */
  readonly configPath: string
  readonly log: (line: string) => void
}

function cloneEntries(entries: readonly CuratedSourceEntry[]): CuratedSourceEntry[] {
  return entries.map((entry) => ({ ...entry }))
}

function seedEntries(): CuratedSourceEntry[] {
  return cloneEntries(CURATED_SEED)
}

/** 一条源包输入被丢弃的原因拼成一句可展示的告警；不回显 URL（可能带 userinfo）。 */
function warnOf(issues: ReadonlyArray<{ index: number; reason: string }>): string | undefined {
  if (issues.length === 0) return undefined
  const details = issues.map((issue) => `第 ${issue.index + 1} 项${issue.reason}`).join('；')
  return `已忽略 ${issues.length} 条无效项（${details}）`
}

/**
 * 读一次 config.json，得到内存初值与「要不要初始化种子」。
 *
 * 读不出来时**不抛错**（对照 readConfigFile 在装载路径上的响亮失败）：这里只负责「精选源」
 * 视图。真的文件损坏会在 lifecycle 装载时响亮失败，不该由这张清单抢先炸掉；但必须留日志 +
 * 一条警示，不能装作「清单是空的」。
 */
function readInitial(
  configPath: string,
  log: (line: string) => void,
): { state: CuratedSourceEntry[]; warning: string | undefined; seedPending: boolean } {
  const warnings: string[] = []
  try {
    const file = readConfigFile(configPath, (line) => {
      warnings.push(line)
      log(line)
    })
    const warning = warnings.length === 0 ? undefined : warnings.join('；')
    if (file.curatedSources !== undefined) {
      return { state: cloneEntries(file.curatedSources), warning, seedPending: false }
    }
    return { state: [], warning, seedPending: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const warning = `订阅文件无法读取（${message}），精选源包暂按空清单显示`
    log(warning)
    return { state: [], warning, seedPending: true }
  }
}

export function createSourcePack(deps: SourcePackDeps): SourcePackControl {
  const { configPath, log } = deps
  const initial = readInitial(configPath, log)
  let state = initial.state
  let warning = initial.warning
  // 「字段不存在」= 从没初始化过。这个标志只在第一次成功落盘后永久结束；显式空数组不置位。
  let seedPending = initial.seedPending

  /**
   * 首次打开时把内置快照落盘。失败**不静默**：内存里先给种子（视图至少能看），
   * 但保留 seedPending，下一次打开会再试 —— 一次磁盘故障不该变成「永久只有内存清单」。
   */
  const initializeSeed = (): void => {
    let current: ReaderConfigFile
    try {
      current = readConfigFile(configPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warning = `内置精选源初始化失败（${message}），本次仅显示内存清单`
      state = seedEntries()
      log(warning)
      return
    }
    // 另一个写入者（或上一次只写了一半）已经把字段落上了：以文件为准，不覆盖。
    if (current.curatedSources !== undefined) {
      state = cloneEntries(current.curatedSources)
      seedPending = false
      return
    }
    const seeds = seedEntries()
    try {
      writeConfigFile(configPath, { ...current, curatedSources: seeds })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warning = `内置精选源初始化失败（${message}），本次仅显示内存清单`
      state = seeds
      log(warning)
      return
    }
    state = seeds
    seedPending = false
    warning = undefined
    log(`精选源包：已用内置快照初始化 ${seeds.length} 条（采集日 ${CURATED_SEED_META.collectedAt}）`)
  }

  const snapshot = (): SourcePackSnapshot => {
    if (seedPending) initializeSeed()
    return {
      entries: cloneEntries(state),
      seed: { collectedAt: CURATED_SEED_META.collectedAt, count: CURATED_SEED_META.count },
      ...(warning === undefined ? {} : { warning }),
    }
  }

  const save = (
    entries: readonly unknown[],
    options?: { restoreSeed?: boolean },
  ): SourcePackSaveOutcome => {
    const normalized = normalizeCuratedSources(entries)
    let next = normalized.entries
    let restored = 0
    if (options?.restoreSeed === true) {
      const have = new Set(next.map((entry) => entry.url))
      const missing = CURATED_SEED.filter((entry) => !have.has(entry.url))
      if (missing.length > 0) {
        next = [...next, ...cloneEntries(missing)]
        restored = missing.length
      }
    }

    // 每次保存都重新读一遍：store 可能刚写过 feeds / folders / feedOrder，内存态不是权威。
    let current: ReaderConfigFile
    try {
      current = readConfigFile(configPath)
    } catch (error) {
      return { ok: false, reason: 'write-failed', message: error instanceof Error ? error.message : String(error) }
    }
    try {
      // ① 先落盘。这一行不成功，下面的内存改写一行都不执行。
      writeConfigFile(configPath, { ...current, curatedSources: next })
    } catch (error) {
      return { ok: false, reason: 'write-failed', message: error instanceof Error ? error.message : String(error) }
    }

    // ② 落盘成功后才认这份状态。
    state = next
    seedPending = false
    warning = warnOf(normalized.issues)
    if (warning !== undefined) log(warning)
    log(`精选源包：保存 ${next.length} 条${restored > 0 ? `（恢复内置快照补入 ${restored} 条）` : ''}`)
    return { ok: true, snapshot: snapshot(), dropped: normalized.issues.length, restored }
  }

  return { snapshot, save }
}
