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

/** config.json 的完整形状。版本是**硬相等**的契约（见 readConfigFile 的拒绝逻辑）。 */
export interface ReaderConfigFile {
  /** feedId（归一化后的 URL）→ 完整订阅记录。0 订阅是合法的空对象。 */
  feeds: Record<string, FeedRecord>
  /** 视图偏好（两列布局的单例槽）。形状归一化在 src/shared.ts 的 sanitizeViewPreferences 做。 */
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
 * @throws 解析或校验失败时。
 */
export function readConfigFile(path: string): ReaderConfigFile {
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
  return validateConfig(parsed, path)
}

/** 校验读进来的值；不合法一律抛错并带路径。读写共用同一套判据，所以「读得进必写得回」。 */
function validateConfig(parsed: unknown, path: string): ReaderConfigFile {
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
  return { version: CURRENT_CONFIG_VERSION, feeds: valid, viewPreferences: record.viewPreferences }
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
    const serialized = JSON.stringify(value, null, 2) + '\n'
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
