/**
 * 订阅真相的落点：`storages/rss-reader/config.json`（host 半）。
 *
 * **这不是插件配置面**。`src/config.ts` 的 `Config` 是宿主注入的插件配置（注入器写死 `{}`，
 * 只吃 schema 默认值），而那份文件是用户订阅的**唯一**可备份副本 —— 条目与正文可再生、
 * 明确不进备份（spec §9.2）。所以：读不出来必须响亮失败，绝不返回空订阅 ——
 * 「返回空 feeds」在用户眼里就是「我的订阅全没了」，而它其实只是一次解析失败。
 *
 * `feeds` 的取值是 **feedId → FeedRecord 的完整映射**，不是 URL 列表：`etag` / `lastModified`
 * 决定条件请求、`contentRevision` 决定要不要绕开 304 回填摘要、`lastAttemptedAt` 是陈旧度调度的
 * 排序键（回落 `lastFetchedAt`）、`lastFetchedAt` 是「上次成功」要回给界面、`lastFailure` 也要回给
 * 界面。只存 URL 会让这几项在迁移那一刻静默归零 ——
 * 表现是「迁移后第一轮全量重抓 + 摘要回填空转」，而不会有任何断言翻红（spec 的定稿加固）。
 * 每个记录都过 `feedRecordSchema`（`strict`）就是为了让这个「逐字段同形」由机器来保证。
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { feedRecordSchema, type FeedRecord } from '../domain.js'
import { mergeFolderDirectory } from '../folders.js'
import { parseRsshubBase } from '../settings-schema.js'
import { httpUrlOrEmpty, type CuratedSourceEntry } from '../shared.js'

/** 实例池上限（spec §4.1.1）：>5 条拒绝保存。读取侧只告警、不替用户删数据。 */
export const RSSHUB_INSTANCE_MAX = 5

/**
 * RSSHub 的持久化策略（R15 01，spec §4.1.1 / §5.1）。
 *
 * 三个字段一次定好形状：`instances` 是实例池（顺序即优先级），`hiddenNamespaces` / `hideNsfw`
 * 是 06 / 07 票的筛选偏好 —— 它们现在只是被读回、被保存，行为留给后续票，避免再改一次配置形状。
 *
 * 为什么放在 `config.json` 而不是 `settings.json`：设置层只支持标量键（`src/settings-schema.ts`），
 * 数组会迫使新增整套 array tunable；`config.json` 本来就是用户列表（`folders` / `feedOrder`）的家。
 */
export interface ReaderRsshubConfig {
  /** 0–5 条实例源站（已归一成 `URL.origin`）。0 条 = 用户主动关闭 RSSHub。 */
  instances: string[]
  /** 探索视图里被用户隐藏的 namespace（06 / 07 票）。 */
  hiddenNamespaces: string[]
  /** 是否默认隐藏 NSFW 路由（06 票）。 */
  hideNsfw: boolean
}

/** config.json 的完整形状。版本是**硬相等**的契约（见 readConfigFile 的拒绝逻辑）。 */
export interface ReaderConfigFile {
  /** feedId（归一化后的 URL）→ 完整订阅记录。0 订阅是合法的空对象。 */
  feeds: Record<string, FeedRecord>
  /**
   * 显式文件夹目录。**可为空**，空目录也必须留住（这是它不能只从 feed.folder 派生的原因）。
   *
   * 读取时返回的是「显式目录 ∪ 当前 feed.folder 的非空分组」；写入时同一份并集落盘。
   * 首版沿用 v1 的可选字段：不认识它的旧写入者会把空目录丢掉（限制记录在 M2 02 的交付说明里），
   * 但「读旧配置」不会丢 —— 没有这个字段时，现有订阅的 folder 就是目录。
   */
  folders?: string[]
  /**
   * 订阅源的显式顺序（R3）：**可选**，只记录用户排过的 feedId。
   *
   * 缺省 ≠ 空数组：**缺省表示「从没排过」**，读取时绝不能把它物化出来 —— 一次保存视图偏好或
   * 刷新写回就凭空多出一个键，等于把「没排过」改写成「排过」，用户手改文件时也无从分辨。
   * 空数组则是用户/写入者明确给出的合法值。未列出的源由 src/feed-order.ts 按 `feeds` 键序追加。
   */
  feedOrder?: string[]
  /**
   * RSSHub 实例池与筛选偏好（R15 01）。**缺省 ≠ 空池**：
   * 缺省 = 从没配过，运行时回落旧的 `settings.json` `rsshubBase`（单元素池）；
   * `instances: []` = 用户主动清空，功能关闭，**绝不回落**旧值。
   */
  rsshub?: ReaderRsshubConfig
  /**
   * 精选源包（R15 08，spec §4.3.1）。**缺省 ≠ 空数组**：
   * 缺省 = 从没打开过「精选源」视图，首次打开时用内置快照初始化并落盘；
   * `[]` = 用户把清单删光了，**不再自动填充**。两者必须可区分，否则「删光」永远关不掉种子。
   */
  curatedSources?: CuratedSourceEntry[]
  /** 视图偏好（两列布局的单例槽）。形状归一化在 src/preferences.ts 的 sanitizeViewPreferences 做。 */
  viewPreferences?: unknown
  /** 文件格式版本。只认 1。 */
  version: 1
}

const CURRENT_CONFIG_VERSION = 1

/**
 * 订阅文件是不是**不存在**（只有 ENOENT 算「不在」）。
 *
 * **为什么单独问一次、而不复用 {@link readConfigFile} 的返回值**：那条对 ENOENT 返回「空订阅」
 * （首次安装的既定语义），于是调用方再也分不出「首次安装」与「文件半路没了」—— 而这恰是装载
 * 路径必须分清的两类事实（见 src/index.ts 的 assertSubscriptionsNotLost：库里还有条目就必须
 * 响亮失败）。让它改返回一个带标记的对象会牵动 store-sqlite 的三处调用，为这一问不值。
 *
 * **口径必须与 {@link readConfigFile} 逐字相同**：只有 ENOENT 算「不在」，其余 errno 一律抛错 ——
 * 把「读不出来」当成「不在」等于让一次故障冒充首次安装（EACCES / ELOOP / EIO 会走进同一个分支）。
 *
 * @throws 路径存在但 stat 不了时，消息含路径。
 */
export function configFileMissing(path: string): boolean {
  try {
    statSync(path)
    return false
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return true
    throw new Error(
      `无法判断订阅文件 ${path} 是否存在（它既不是「没有」、也不是「在」，未做任何写入）：${String(error)}`,
      { cause: error },
    )
  }
}

/**
 * 读订阅文件。
 *
 * - 文件**不存在** ⇒ 空订阅（首次安装；调用方随后会拿 `Config.feeds` 做种子）。
 * - 文件**存在但读不进来**（截断的 JSON / 形状不对 / 版本不认 / 记录不合 `FeedRecord`）⇒
 *   **抛错**，消息带路径。绝不返回空订阅：那是「静默清空用户面板」的同义词。
 *
 * @param warn 可选的告警出口（RSSHub 坏实例逐条丢弃时用）。设置页把它接到插件日志；
 *             其它调用方不传 = 静默丢弃，但**绝不**因此让整份配置失败。
 * @throws 解析或校验失败时。
 */
export function readConfigFile(path: string, warn?: (line: string) => void): ReaderConfigFile {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      // 只有「没有这个文件」才是新装。其余 errno（EACCES/EISDIR…）都得响亮失败
      return { version: CURRENT_CONFIG_VERSION, feeds: {} }
    }
    throw new Error(`读取订阅文件 ${path} 失败：${String(error)}`, { cause: error })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `订阅文件 ${path} 不是合法 JSON（已保留原文件，未做任何写入）：${String(error)}`,
      { cause: error },
    )
  }
  return validateConfig(parsed, path, warn)
}

/** 校验读进来的值；不合法一律抛错并带路径。读写共用同一套判据，所以「读得进必写得回」。 */
function validateConfig(parsed: unknown, path: string, warn?: (line: string) => void): ReaderConfigFile {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`订阅文件 ${path} 的顶层不是对象（读到 ${describe(parsed)}）`)
  }
  const record = parsed as Record<string, unknown>
  if (record.version !== CURRENT_CONFIG_VERSION) {
    // 硬相等，与存储域的 version 语义一致：宁可打不开，也不硬按 v1 解释未来格式
    throw new Error(
      `订阅文件 ${path} 的版本是 ${JSON.stringify(record.version)}，本版只认 ${CURRENT_CONFIG_VERSION}：` +
        '不硬按 v1 的形状解释它（那会丢掉这个版本不认识的字段）。请升级插件，或从备份恢复。',
    )
  }
  const feeds = record.feeds
  if (typeof feeds !== 'object' || feeds === null || Array.isArray(feeds)) {
    throw new Error(
      `订阅文件 ${path} 的 feeds 不是 feedId → 记录的映射（读到 ${describe(feeds)}）：` +
        '只有 URL 列表会丢掉 etag/正文版本等字段，拒绝继续。',
    )
  }

  const valid: Record<string, FeedRecord> = {}
  for (const [feedId, raw] of Object.entries(feeds as Record<string, unknown>)) {
    const result = feedRecordSchema.safeParse(raw)
    if (!result.success) {
      throw new Error(
        `订阅文件 ${path} 里的源 ${feedId} 不合 FeedRecord：${result.error.message}`,
        { cause: result.error },
      )
    }
    valid[feedId] = result.data
  }
  // 文件夹目录：显式项必须逐条是字符串；随后与当前非空成员分组取并集。
  // 这一步放在读侧而不是只在写侧，是为了让「旧配置（没有 folders 字段）也能读出目录」成立。
  const foldersRaw = record.folders
  const explicitFolders: string[] = []
  if (foldersRaw !== undefined) {
    if (!Array.isArray(foldersRaw)) {
      throw new Error(
        `订阅文件 ${path} 的 folders 不是字符串数组（读到 ${describe(foldersRaw)}）：` +
          '空目录必须由目录单独记录，拒绝把认不出的形状当成「没有目录」。',
      )
    }
    for (const entry of foldersRaw) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        throw new Error(
          `订阅文件 ${path} 的 folders 里有非法名称（读到 ${describe(entry)}）：` +
            '目录项必须是非空字符串；已有名称原样保留，不做规范化。',
        )
      }
      explicitFolders.push(entry)
    }
  }
  // 订阅源顺序：只判**形状**。不认识的 id 与空串是正常形态（退订残留 / 手改垃圾），
  // 交给 src/feed-order.ts 在派生时丢弃 —— 读侧若为它们报错，一次退订残留就能让面板打不开。
  // 也**不**在这里规范化（排序 / 去重 / 过滤）：读不写盘，原样带回去才是「读取不改写文件」。
  const feedOrderRaw = record.feedOrder
  let feedOrder: string[] | undefined
  if (feedOrderRaw !== undefined) {
    if (!Array.isArray(feedOrderRaw)) {
      throw new Error(
        `订阅文件 ${path} 的 feedOrder 不是字符串数组（读到 ${describe(feedOrderRaw)}）：` +
          '顺序只能由一份显式数组表达，拒绝把认不出的形状当成「没有排过」。',
      )
    }
    for (const entry of feedOrderRaw) {
      if (typeof entry !== 'string') {
        throw new Error(
          `订阅文件 ${path} 的 feedOrder 里有非字符串项（读到 ${describe(entry)}）：` +
            '每一项都必须是 feedId 字符串。',
        )
      }
    }
    feedOrder = [...feedOrderRaw]
  }
  // RSSHub 实例池：坏项逐条丢弃 + 告警，**不抛错**。它和 folders / feedOrder 的语义刻意不同 ——
  // 一个手滑的实例地址不该让整份订阅配置打不开；那些是结构（目录 / 顺序），坏掉就无从解释。
  const rsshub = validateRsshub(record.rsshub, path, warn)
  // 精选源包同理：一条手滑的地址不该让整份订阅配置失效（它只是清单，不是订阅）。
  const curatedSources = validateCuratedSources(record.curatedSources, path, warn)
  return {
    version: CURRENT_CONFIG_VERSION,
    feeds: valid,
    viewPreferences: record.viewPreferences,
    folders: mergeFolderDirectory(explicitFolders, valid),
    // 缺省时**不写这个键**（值是 undefined 会让 JSON.stringify 抹掉，但对象形状里仍多一个键；
    // 用条件展开把「没排过」保持成真正的不存在）。
    ...(feedOrder === undefined ? {} : { feedOrder }),
    ...(rsshub === undefined ? {} : { rsshub }),
    // 同上：缺省保持成真正的不存在 —— 这是「首次打开用种子初始化」唯一能看见的信号。
    ...(curatedSources === undefined ? {} : { curatedSources }),
  }
}

/**
 * 校验 `rsshub` 字段（§4.1.1）。
 *
 * 三条与别处不同的约定：
 *  1. **坏实例逐条丢**，不抛错 —— 地址是外部可变输入，一条坏的不该让整份 config.json 失效；
 *  2. **空串算坏项**：`parseRsshubBase('')` 在设置层表示「未配置」，但在池子里它没有意义，
 *     留下只会让运行时多一次空地址请求；
 *  3. 池子超过 5 条**读侧保留并告警**，保存侧才拒绝 —— 读侧替用户删数据是不可逆的，
 *     让他在设置页看到「有 6 条、保存前需删减」比静默丢一条诚实。
 *
 * 告警里**不回显原始地址**：URL 可能带 userinfo（凭据），日志不该成为第二份泄漏面。
 */
function validateRsshub(
  raw: unknown,
  path: string,
  warn?: (line: string) => void,
): ReaderRsshubConfig | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    warn?.(`订阅文件 ${path} 的 rsshub 不是对象（读到 ${describe(raw)}），已忽略这个字段；旧的 rsshubBase 仍按遗留键读取`)
    return undefined
  }
  const record = raw as Record<string, unknown>
  const rawInstances = record.instances
  if (!Array.isArray(rawInstances)) {
    // `instances` 缺席 = 这个 rsshub 字段没写完整：整份忽略，让迁移逻辑回落旧 rsshubBase。
    warn?.(`订阅文件 ${path} 的 rsshub.instances 不是数组（读到 ${describe(rawInstances)}），已忽略整个 rsshub 字段`)
    return undefined
  }
  const instances: string[] = []
  for (const [index, entry] of rawInstances.entries()) {
    const parsed = parseRsshubBase(entry)
    if (parsed === undefined || parsed === '') {
      warn?.(`订阅文件 ${path} 的 rsshub.instances 第 ${index + 1} 项不是合法的实例源站`
        + '（只支持 http(s)，不能带路径 / 查询 / 参数），已丢弃')
      continue
    }
    instances.push(parsed)
  }
  if (instances.length > RSSHUB_INSTANCE_MAX) {
    warn?.(`订阅文件 ${path} 的 rsshub.instances 有 ${instances.length} 个（上限 ${RSSHUB_INSTANCE_MAX} 个），`
      + '设置页保存前需要删减到上限以内')
  }

  const rawHidden = record.hiddenNamespaces
  const hiddenNamespaces: string[] = []
  if (rawHidden !== undefined) {
    if (!Array.isArray(rawHidden)) {
      warn?.(`订阅文件 ${path} 的 rsshub.hiddenNamespaces 不是字符串数组（读到 ${describe(rawHidden)}），已按空列表处理`)
    } else {
      for (const [index, entry] of rawHidden.entries()) {
        if (typeof entry !== 'string' || entry.trim() === '') {
          warn?.(`订阅文件 ${path} 的 rsshub.hiddenNamespaces 第 ${index + 1} 项不是非空字符串，已丢弃`)
          continue
        }
        hiddenNamespaces.push(entry.trim())
      }
    }
  }

  let hideNsfw = true
  if (record.hideNsfw !== undefined) {
    if (typeof record.hideNsfw === 'boolean') hideNsfw = record.hideNsfw
    else warn?.(`订阅文件 ${path} 的 rsshub.hideNsfw 不是布尔值（读到 ${describe(record.hideNsfw)}），已按默认 true 处理`)
  }

  return { instances, hiddenNamespaces, hideNsfw }
}

/** 一条源包输入被丢弃的原因（索引从 0 起；对外文案里 +1）。 */
export interface CuratedSourceIssue {
  readonly index: number
  readonly reason: string
}

/**
 * 源包条目的归一化与去重（R15 08，spec §7「源包归一化与去重」）。
 *
 * 为什么放在 storage 层而不是控制器里：**读文件和保存两条路径必须用同一套判据** ——
 * 读取侧用它在手改文件里逐条丢坏项，保存侧用它在写盘前把客户端送来的原始数组变成
 * 可落盘的形状。两套判据会出现「保存时接受、重启后消失」这类只有重启才暴露的分家。
 *
 * 判据只有三条，都是**形状**，不猜内容：
 *  1. `url` 必须是绝对 http(s) 地址（与别处共用 shared.ts 的 `httpUrlOrEmpty`），归一成
 *     `URL.toString()` —— 于是 `https://a.example` 与 `https://a.example/` 是同一个 URL（去重的键）；
 *  2. `addedAt` 必须是能解析的时刻串（空串、乱码都算坏项）；
 *  3. 同 URL 只留**第一条**（保留用户先加的那条，后来的重复项丢弃并回报）。
 *
 * `title` / `category` / `note` 是自由文本：去首尾空白，空串折成 undefined（不落无意义的键）；
 * 不校验长度，也不替用户编内容。
 */
export function normalizeCuratedSources(raw: readonly unknown[]): {
  entries: CuratedSourceEntry[]
  issues: CuratedSourceIssue[]
} {
  const entries: CuratedSourceEntry[] = []
  const issues: CuratedSourceIssue[] = []
  const seen = new Set<string>()
  const textOf = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

  for (const [index, item] of raw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      issues.push({ index, reason: '不是对象' })
      continue
    }
    const record = item as Record<string, unknown>
    const url = typeof record.url === 'string' ? httpUrlOrEmpty(record.url.trim()) : ''
    if (url === '') {
      // 不回显原始地址：URL 可能带 userinfo（凭据），告警不该成为第二份泄漏面。
      issues.push({ index, reason: 'url 不是绝对 http(s) 地址' })
      continue
    }
    if (seen.has(url)) {
      issues.push({ index, reason: 'URL 与前面的条目重复' })
      continue
    }
    const addedAt = typeof record.addedAt === 'string' ? record.addedAt.trim() : ''
    if (addedAt === '' || Number.isNaN(Date.parse(addedAt))) {
      issues.push({ index, reason: 'addedAt 不是有效时刻' })
      continue
    }
    seen.add(url)
    const entry: CuratedSourceEntry = { url, addedAt }
    const title = textOf(record.title)
    const category = textOf(record.category)
    const note = textOf(record.note)
    if (title !== undefined) entry.title = title
    if (category !== undefined) entry.category = category
    if (note !== undefined) entry.note = note
    entries.push(entry)
  }
  return { entries, issues }
}

/**
 * 校验 config.json 的 `curatedSources` 字段（R15 08）。
 *
 * 与 `rsshub` 同一条语义：**坏项逐条丢弃 + 告警，不抛错** —— 它只是清单，一条坏地址不该让
 * 整份订阅配置打不开。与 `rsshub` 不同的是「字段存在但形状认不出」：
 * `rsshub` 缺 `instances` 时整份忽略、回落旧设置；这里若也忽略，就会把一份**存在的**字段
 * 当成「从没配过」，下次打开时用种子覆盖掉用户（哪怕已经读不出来）的清单。所以按空数组处理：
 * 字段存在 ⇒ 不自动填充，且告警说明原因。
 */
function validateCuratedSources(
  raw: unknown,
  path: string,
  warn?: (line: string) => void,
): CuratedSourceEntry[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) {
    warn?.(`订阅文件 ${path} 的 curatedSources 不是数组（读到 ${describe(raw)}），已按空清单处理；`
      + '内置快照不会覆盖一份已经存在的字段')
    return []
  }
  const { entries, issues } = normalizeCuratedSources(raw)
  for (const issue of issues) {
    warn?.(`订阅文件 ${path} 的 curatedSources 第 ${issue.index + 1} 项${issue.reason}，已丢弃`)
  }
  return entries
}

/**
 * 整份替换订阅文件：同目录临时文件 → fsync → rename 覆盖（照
 * `@deepseek-ai/dsh-storage-json/src/atomic.ts` 的协议），权限 0600。
 *
 * 为什么不是 `writeFileSync(path)`：那份文件是订阅的**唯一**副本，写到一半掉电会留下半截 JSON，
 * 下次装载直接打不开。rename 在 POSIX 与 Windows 上都是原子替换。
 */
export function writeConfigFile(path: string, value: ReaderConfigFile): void {
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    // 写前过一遍与读侧**同一套**校验：保证「写得进必读得回」，且 folders 的并集语义在
    // 每条写入路径上都成立（refresh / 订阅操作 / 偏好保存都不必各自记得带上目录）。
    const normalized = validateConfig(value, path)
    const serialized = JSON.stringify(normalized, null, 2) + '\n'
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
    // 失败不能留下垃圾临时文件：它会让「目录里只有 config.json」这条不变式变成假的
    try {
      rmSync(tmp, { force: true })
    } catch (cleanupError) {
      throw new Error(
        `写订阅文件 ${path} 失败：${String(error)}；清理临时文件 ${tmp} 也失败：${String(cleanupError)}`,
        { cause: error },
      )
    }
    throw new Error(`写订阅文件 ${path} 失败（临时文件已清理，原文件未动）：${String(error)}`, {
      cause: error,
    })
  }
}

/** 值的人话描述：错误消息里报 `typeof` 常常看不出「[] 与 {} 的区别」这类问题。 */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === code
}
