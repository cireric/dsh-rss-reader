/**
 * 标签域的动作（阶段 4 票据 03：48 项按域分家的第一块）。
 *
 * 从 src/client/store.ts 搬出来的四个动作：createTag / renameTag / deleteTag / toggleItemTag。
 * 它们只碰 tags 与条目的 tagIds，共享三样东西（与 store 的边界表一致）：get / set / rpc。
 *
 * 两个串行化状态跟着搬进来，而不是留在 store 里：
 *  - `tagWrite`：写盘队列 —— 两次快速切换同一个标签时，必须按到达顺序落盘；
 *  - `tagEpoch`：失败代数 —— 一次失败后，队列里尚未发送的旧快照必须作废，
 *    否则它们会把已经回滚过的坏状态再写一遍（2026-10 的实测缺陷）。
 * 它们只被这一族动作读写，放在外面等于把内部不变量暴露给别的域。
 */
import type { TagView } from '../shared.js'
import type { ReaderStoreDeps, ReaderState } from './store.js'

export interface TagActionHost {
  get: () => ReaderState
  set: (patch: Partial<ReaderState>) => void
  rpc: ReaderStoreDeps['rpc']
  log: ReaderStoreDeps['log']
  /** 改完标签后要让「上次看到哪儿」跟上（删掉当前标签时回落虚拟视图）。 */
  persistView: () => void
  /** 重新取当前页：迟到/失败之后靠它把服务端真值拉回来。 */
  reload: () => Promise<void>
}

export function createTagActions(host: TagActionHost) {
  const { get, set, rpc, log, persistView, reload } = host
  let tagWrite: Promise<void> = Promise.resolve()
  /** 失败代数：一次失败后，队列里尚未发送的旧快照必须作废，避免它们再把坏状态写一次。 */
  let tagEpoch = 0

  const createTag = async (name: string): Promise<void> => {
    try {
      const result = await rpc<{ tag: TagView }>('createTag', { name })
      set({ tags: [...get().tags, { ...result.tag, itemCount: 0 }], notice: '已创建标签「' + result.tag.name + '」' })
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  const renameTag = async (id: string, name: string): Promise<void> => {
    try {
      const result = await rpc<{ tag: TagView }>('renameTag', { id, name })
      // 改名不换 id：当前标签范围与文章关联都保持不变，只替换显示名。
      set({
        tags: get().tags.map((tag) => tag.id === id ? { ...tag, name: result.tag.name } : tag),
        notice: '已把标签改名为「' + result.tag.name + '」',
      })
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  const deleteTag = async (id: string): Promise<void> => {
    try {
      await rpc<{ deleted: true }>('deleteTag', { id })
      const nav = get().navSelection
      const selected = nav.kind === 'tag' && nav.tagId === id
      set({
        tags: get().tags.filter((tag) => tag.id !== id),
        items: get().items.map((item) => ({ ...item, tagIds: (item.tagIds ?? []).filter((tagId) => tagId !== id) })),
        ...(selected ? { navSelection: { kind: 'virtual' }, filter: 'all', navCursor: { kind: 'filter', filter: 'all' } } : {}),
        notice: '已删除标签（文章与阅读状态不受影响）',
      })
      if (selected) {
        persistView()
        await reload()
      }
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** 乐观切换一篇文章的标签；写盘串行化，迟到失败会回取当前页把可见状态拉回真相。 */
  const toggleItemTag = (tagId: string): void => {
    const itemId = get().selectedId
    if (itemId === undefined) return
    const item = get().items.find((entry) => entry.id === itemId)
    const tag = get().tags.find((entry) => entry.id === tagId)
    if (item === undefined || tag === undefined) return
    const epoch = tagEpoch
    const current = item.tagIds ?? []
    const active = current.includes(tagId)
    const nextIds = active ? current.filter((id) => id !== tagId) : [...current, tagId]
    const delta = active ? -1 : 1
    set({
      items: get().items.map((entry) => entry.id === itemId ? { ...entry, tagIds: nextIds } : entry),
      tags: get().tags.map((entry) => entry.id === tagId
        ? { ...entry, itemCount: Math.max(0, (entry.itemCount ?? 0) + delta) }
        : entry),
    })
    tagWrite = tagWrite.then(async () => {
      if (epoch !== tagEpoch) return
      try {
        const result = await rpc<{ itemId: string; tags: TagView[] }>('setItemTags', { itemId, tagIds: nextIds })
        if (get().items.some((entry) => entry.id === itemId)) {
          set({ error: undefined, items: get().items.map((entry) => entry.id === itemId
            ? { ...entry, tagIds: result.tags.map((tag) => tag.id) }
            : entry) })
        }
      } catch (failure) {
        tagEpoch += 1
        const message = failure instanceof Error ? failure.message : String(failure)
        // 迟到/失败都不许把乐观状态留在界面上；重取当前页会把服务端真值带回。
        await reload()
        // load 成功会清 error；失败提示必须在回取之后重新挂上，否则用户只看到静默回滚。
        set({ error: message })
      }
    }).catch((error: unknown) => {
      log('error', '标签写入队列异常', error)
    })
  }
  return { createTag, renameTag, deleteTag, toggleItemTag }
}
