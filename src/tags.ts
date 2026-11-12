/**
 * 标签的输入规则（M2 05）：纯函数，只有名称归一化与错误分类，不碰存储。
 *
 * 与文件夹（src/folders.ts）同一条思路：把「什么算可预期失败」收在一处，
 * 端点只负责把 TagError.code 转成失败信封，存储层只负责在事务里落库。
 */
export const TAG_NAME_MAX_CHARS = 80

export type TagErrorCode = 'bad-request' | 'conflict' | 'not-found'

export class TagError extends Error {
  readonly code: TagErrorCode

  constructor(code: TagErrorCode, message: string) {
    super(message)
    this.name = 'TagError'
    this.code = code
  }
}

/** 新名称 trim 后必须非空且不超过 80 个 Unicode 码点；已有名称不经过这里（改名目标是新名称）。 */
export function normalizeTagName(raw: unknown): string {
  if (typeof raw !== 'string') throw new TagError('bad-request', '标签名称必须是字符串')
  const name = raw.trim()
  if (name === '') throw new TagError('bad-request', '标签名称不能为空白')
  if ([...name].length > TAG_NAME_MAX_CHARS) {
    throw new TagError('bad-request', '标签名称最长 ' + TAG_NAME_MAX_CHARS + ' 个字符（按 Unicode 码点计）')
  }
  return name
}

/**
 * 关联请求的 id 列表归一化：每项必须是非空字符串；重复 id 去重（幂等写入的前提）。
 * 空数组合法 = 清空该文章的全部标签。
 */
export function normalizeTagIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new TagError('bad-request', 'tagIds 必须是字符串数组')
  const ids: string[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || value === '') {
      throw new TagError('bad-request', '标签 ID 必须是非空字符串')
    }
    if (!ids.includes(value)) ids.push(value)
  }
  return ids
}

/** 文章/标签 id 的形状（存在性由存储层查）。 */
export function requireTagId(raw: unknown, label = '标签 ID'): string {
  if (typeof raw !== 'string' || raw === '') throw new TagError('bad-request', label + '必须是非空字符串')
  return raw
}
