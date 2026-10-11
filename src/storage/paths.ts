/**
 * 自持存储的落点与目录权限（host 半）。
 *
 * **为什么必须委托 `resolveDshHome` 而不是自己读 `process.env.DSH_HOME`**：
 * `src/index.ts:119` 已经手抄过一份 `process.env.DSH_HOME || join(homedir(), '.dsh')`。
 * 两份的差别不在「谁更对」，而在**留成两份**：官方实现把「空串/纯空白 = 未设置」当未设置
 * （源码核对 packages/util/home-paths/src/index.ts:87-91），手抄版会把它当路径用 ——
 * `DSH_HOME='   '` 时手抄版得到 `'   /storages/rss-reader'` 这种相对路径，数据悄悄落到
 * 进程的 CWD 上；官方实现回落 `~/.dsh`。
 * 本模块是这个落点的**唯一**来源，后续任务（迁移、日志、库）都从这里取，不再各算一份。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/**
 * 插件自持存储目录：`<dshHome>/storages/rss-reader`。
 *
 * @param dshHome 显式指定的宿主根，压过 `$DSH_HOME`（测试与多实例用）；省略则交给 resolveDshHome。
 * @returns **绝对**路径（resolveDshHome 会 resolve，空白 `$DSH_HOME` 不会渗进来）。
 *
 * 目录名带连字符是自持的直接好处：存储域的域名受 `UNIT_NAME_RE` 约束（不允许连字符），
 * 而这里是插件自己的目录，不受那条规则管。
 */
export function storageRoot(dshHome?: string): string {
  return join(resolveDshHome(dshHome), 'storages', 'rss-reader')
}

/**
 * 递归建出存储根，权限 `0700`。可重复调用（插件每次装载都会走一遍）。
 *
 * **失败必须响亮**，且**不许回落临时目录**：目录建不出来时数据没有落点，
 * 悄悄换个地方写会让用户以为订阅还在（Review Focus 5）。所以这里把路径写进消息再抛。
 *
 * 已存在的目录**不改权限** —— 照 `@deepseek-ai/dsh-storage-sqlite/src/schema.ts:36-49`
 * 的先例（"Existing files retain their modes"）：本函数只负责「建」，擅自 chmod 别人已有的
 * 目录是越权，而权限诊断另有更直接的办法（用户看得见路径）。
 */
export function ensureStorageRoot(root: string): void {
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `无法创建订阅存储目录 ${root}：${detail}` +
        '（请检查 $DSH_HOME 是否可写、路径上是否有同名文件；不会回落到临时目录）',
      { cause: error },
    )
  }
}
