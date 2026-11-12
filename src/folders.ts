/**
 * 文件夹目录的语义（M2 02）：**纯函数**，输入输出都是 config.json 的形状。
 *
 * 为什么单独成模块：目录与订阅归属共用同一份 `config.json`，而「创建/改名/删除/移动」
 * 的校验与改写规则必须只有一处。放在 store-sqlite 里会让这些规则与「读文件、写文件」缠在一起，
 * 单测就只能起一个真库；放在端点里则会把「配置文件长什么样」泄进 wire 层。
 *
 * **目录与成员是两件事**：`folders` 是显式目录（空目录也必须活下来），`feed.folder` 是归属。
 * 读取时两者取并集 —— 旧配置没有 `folders` 字段时，现有订阅的 `folder` 就是目录；
 * 而并集也意味着「OPML 刚带来的新分组」在第一次写入后自动进入目录。
 *
 * 名称规则（首版默认，可逆）：新名称去掉首尾空白，按 **Unicode 码点**计 1–80 个字符；
 * 重复按**精确名称**比较（区分大小写，不做大小写折叠）。已有名称原样保留 —— OPML 里的
 * `父/子` 也是名称的一部分，不拆、不规范化。
 */
import type { FeedRecord } from './domain.js'
import type { ReaderConfigFile } from './storage/config-file.js'
import type { FolderView } from './shared.js'

/** 新名称的 Unicode 码点上限。已有名称不受它约束（OPML 可能带来更长的历史分组名）。 */
export const FOLDER_NAME_MAX_CHARS = 80

export type FolderErrorCode = 'bad-request' | 'conflict' | 'not-found'

/**
 * 文件夹操作的「可预期失败」。端点据此回 bad-request / conflict / not-found；
 * 其余异常（读写文件失败、磁盘满）原样抛出，由 dispatch 兜成 internal —— 两类失败不能混。
 */
export class FolderError extends Error {
  readonly code: FolderErrorCode

  constructor(code: FolderErrorCode, message: string) {
    super(message)
    this.name = 'FolderError'
    this.code = code
  }
}

/** 空字符串与缺失同义：都是「未分类」（与 OPML 导出把 '' 当未分类是同一口径）。 */
function folderOf(feed: FeedRecord): string | undefined {
  if (feed.folder === undefined || feed.folder === '') return undefined
  return feed.folder
}

/** 当前订阅里出现的非空分组名，按 config.json 的订阅顺序。 */
export function derivedFolderNames(feeds: Record<string, FeedRecord>): string[] {
  const names: string[] = []
  for (const feed of Object.values(feeds)) {
    const name = folderOf(feed)
    if (name !== undefined && !names.includes(name)) names.push(name)
  }
  return names
}

/**
 * 显式目录 ∪ 当前非空成员分组。
 *
 * 顺序：显式目录在前（这是用户/上次写入定下的顺序），派生名按订阅顺序追加。
 * 精确去重：同名只留第一次出现的位置。
 */
export function mergeFolderDirectory(
  explicit: readonly string[] | undefined,
  feeds: Record<string, FeedRecord>,
): string[] {
  const merged: string[] = []
  for (const name of explicit ?? []) {
    if (!merged.includes(name)) merged.push(name)
  }
  for (const name of derivedFolderNames(feeds)) {
    if (!merged.includes(name)) merged.push(name)
  }
  return merged
}

/** 读接口的形状：目录（含空目录）与每个文件夹的成员（订阅 id 按 config.json 顺序）。 */
export function folderViews(file: { folders?: readonly string[]; feeds: Record<string, FeedRecord> }): FolderView[] {
  return mergeFolderDirectory(file.folders, file.feeds).map((name) => ({
    name,
    feedIds: Object.entries(file.feeds)
      .filter(([, feed]) => folderOf(feed) === name)
      .map(([feedId]) => feedId),
  }))
}

/** 新名称校验：去首尾空白后必须是非空、≤80 个 Unicode 码点。 */
export function normalizeNewFolderName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new FolderError('bad-request', '文件夹名称必须是字符串')
  }
  const name = raw.trim()
  if (name === '') {
    throw new FolderError('bad-request', '文件夹名称不能为空白')
  }
  if ([...name].length > FOLDER_NAME_MAX_CHARS) {
    throw new FolderError('bad-request', '文件夹名称最长 ' + FOLDER_NAME_MAX_CHARS + ' 个字符（按 Unicode 码点计）')
  }
  return name
}

/** 现有名称必须**精确**存在；不 trim（已有名称原样保留，包括前后空白由外部写入的历史值）。 */
function requireExistingName(file: ReaderConfigFile, raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') {
    throw new FolderError('bad-request', '文件夹名称必须是非空字符串')
  }
  if (!mergeFolderDirectory(file.folders, file.feeds).includes(raw)) {
    throw new FolderError('not-found', '文件夹不存在：' + raw)
  }
  return raw
}

/** 创建文件夹：只改目录，不动任何订阅。 */
export function addFolder(file: ReaderConfigFile, rawName: unknown): ReaderConfigFile {
  const name = normalizeNewFolderName(rawName)
  const folders = mergeFolderDirectory(file.folders, file.feeds)
  if (folders.includes(name)) {
    throw new FolderError('conflict', '文件夹已存在：' + name)
  }
  return { ...file, folders: [...folders, name] }
}

/**
 * 改名：目录与所有成员的归属在**同一次**变换里改完（调用方随后一次性原子写盘）。
 * 改到同名是幂等空操作；目标名与别的目录项精确碰撞则拒绝。
 */
export function renameFolder(file: ReaderConfigFile, rawFrom: unknown, rawTo: unknown): ReaderConfigFile {
  const from = requireExistingName(file, rawFrom)
  const to = normalizeNewFolderName(rawTo)
  if (to === from) return file
  const folders = mergeFolderDirectory(file.folders, file.feeds)
  if (folders.includes(to)) {
    throw new FolderError('conflict', '文件夹已存在：' + to)
  }
  const feeds: Record<string, FeedRecord> = {}
  for (const [feedId, feed] of Object.entries(file.feeds)) {
    feeds[feedId] = folderOf(feed) === from ? { ...feed, folder: to } : feed
  }
  return {
    ...file,
    feeds,
    folders: folders.map((name) => (name === from ? to : name)),
  }
}

/**
 * 删除文件夹：**只解除分类**。订阅记录、条目、已读/星标/保持未读都不动 ——
 * 这是与 removeFeed 的分界线，两者必须是独立入口（票据 02 的硬约束）。
 */
export function deleteFolder(file: ReaderConfigFile, rawName: unknown): { file: ReaderConfigFile; detached: number } {
  const name = requireExistingName(file, rawName)
  const feeds: Record<string, FeedRecord> = {}
  let detached = 0
  for (const [feedId, feed] of Object.entries(file.feeds)) {
    if (folderOf(feed) !== name) {
      feeds[feedId] = feed
      continue
    }
    const next = { ...feed }
    delete next.folder
    feeds[feedId] = next
    detached += 1
  }
  return {
    file: {
      ...file,
      feeds,
      folders: mergeFolderDirectory(file.folders, file.feeds).filter((folder) => folder !== name),
    },
    detached,
  }
}

/**
 * 移动订阅：`folder === undefined` 表示移出到未分类（清除 `feed.folder`）。
 * 目标不存在 / 源不存在都是明确失败；重复移到同一位置保持幂等。
 */
export function moveFeedToFolder(
  file: ReaderConfigFile,
  rawFeedId: unknown,
  rawFolder: unknown,
): { file: ReaderConfigFile; folder: string | undefined } {
  if (typeof rawFeedId !== 'string' || rawFeedId === '') {
    throw new FolderError('bad-request', '移动订阅需要 feedId')
  }
  const current = file.feeds[rawFeedId]
  if (current === undefined) {
    throw new FolderError('not-found', '订阅不存在：' + rawFeedId)
  }
  let target: string | undefined
  if (rawFolder === undefined || rawFolder === null || rawFolder === '') {
    target = undefined
  } else if (typeof rawFolder === 'string') {
    target = rawFolder
  } else {
    throw new FolderError('bad-request', '文件夹名称必须是字符串或 null（null = 未分类）')
  }
  if (target !== undefined && !mergeFolderDirectory(file.folders, file.feeds).includes(target)) {
    throw new FolderError('not-found', '文件夹不存在：' + target)
  }
  if (folderOf(current) === target) return { file, folder: target }
  const next = { ...current }
  if (target === undefined) delete next.folder
  else next.folder = target
  return {
    file: { ...file, feeds: { ...file.feeds, [rawFeedId]: next } },
    folder: target,
  }
}
