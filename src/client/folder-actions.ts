/**
 * 文件夹动作（阶段 4b 票据 05 的第二个切片）。
 *
 * 四个动作：createFolder / renameFolder / deleteFolder / moveFeedToFolder。
 * 它们只碰目录与订阅的 folder 归属，共用 applyFolders（把宿主回包落到 state）。
 *
 * 为什么先切这一块：它与 feeds / navSelection 不同，**不需要** persistView 的归属先定下来。
 * 注意 persistView 在这一族里有 **两处**（不是一处）：renameFolder 改完选中项的名字、deleteFolder
 * 删掉当前所在文件夹后的回落 —— 两处都按 host 注入借用，归属问题留到订阅域整体搬时再定。
 */
import type { FolderView } from '../shared.js'
import type { ReaderStoreDeps, ReaderState } from './store.js'

export interface FolderActionHost {
  get: () => ReaderState
  set: (patch: Partial<ReaderState>) => void
  rpc: ReaderStoreDeps['rpc']
  /** 把宿主回包的目录落到 state（store 里的既有实现）。 */
  applyFolders: (folders: FolderView[]) => void
  /** 重取当前页。 */
  reload: () => Promise<void>
  /** 改完导航状态后记住它。 */
  persistView: () => void
}

export function createFolderActions(host: FolderActionHost) {
  const { get, set, rpc, applyFolders, reload, persistView } = host
  const createFolder = async (name: string): Promise<void> => {
    try {
      const result = await rpc<{ folders: FolderView[] }>('createFolder', { name })
      applyFolders(result.folders)
      set({ notice: '已创建文件夹「' + name.trim() + '」' })
      await reload()
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  const renameFolder = async (from: string, to: string): Promise<void> => {
    try {
      const result = await rpc<{ folders: FolderView[] }>('renameFolder', { from, to })
      // 当前正在浏览这个文件夹：范围必须跟着迁移，否则右栏会变成一个不存在的名字。
      const nav = get().navSelection
      const selected = nav.kind === 'folder' && nav.folder === from
      applyFolders(result.folders)
      if (selected) {
        set({ navSelection: { kind: 'folder', folder: to.trim() }, navCursor: { kind: 'folder', folder: to.trim() } })
        persistView()
      }
      set({ notice: '已把文件夹「' + from + '」改名为「' + to.trim() + '」' })
      await reload()
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  const deleteFolder = async (name: string): Promise<void> => {
    try {
      const result = await rpc<{ folders: FolderView[]; detached: number }>('deleteFolder', { name })
      const nav = get().navSelection
      const selected = nav.kind === 'folder' && nav.folder === name
      const cursor = get().navCursor
      const cursorOnIt = cursor.kind === 'folder' && cursor.folder === name
      applyFolders(result.folders)
      if (selected) {
        // 删除当前文件夹：回到跨源列表（与「源被退订」同一条回落规则）。
        set({ navSelection: { kind: 'virtual' }, filter: 'all', navCursor: { kind: 'filter', filter: 'all' } })
        persistView()
      } else if (cursorOnIt) {
        set({ navCursor: { kind: 'filter', filter: get().filter } })
      }
      set({ notice: '已删除文件夹「' + name + '」，' + result.detached + ' 个订阅变为未分类' })
      await reload()
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  const moveFeedToFolder = async (feedId: string, folder: string | undefined): Promise<void> => {
    try {
      const result = await rpc<{ folders: FolderView[] }>('moveFeedToFolder', {
        feedId,
        // 协议里 null 才是「移出到未分类」；undefined 会被 JSON 丢掉，宿主看不到这个键。
        folder: folder ?? null,
      })
      applyFolders(result.folders)
      set({ notice: folder === undefined ? '已把订阅移出分类' : '已把订阅移到「' + folder + '」' })
      await reload()
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }


  return { createFolder, renameFolder, deleteFolder, moveFeedToFolder }
}
