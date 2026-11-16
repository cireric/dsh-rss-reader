/**
 * 搜索域的动作（阶段 4b 票据 04）。
 *
 * 搬出来的是 loadSearch / resetSearchPage / submitSearch，以及它们自己的两个状态：
 * searchRequest（在途请求，换词时 abort 旧的）与 searchPages（已加载页数）。
 *
 * 三条跨域耦合按票据写的解法处理：
 *  - listVersion 仍住在 store（列表域也用它判过期），这里只经 next/current 两个入口用；
 *  - refreshDuplicateHints 由 host 注入（它定义在 store 后半，工厂建在它之后）；
 *  - reset 暴露给别的域（setFilter / selectNav / select 都要调），不再各自摸内部状态。
 */
import type { ItemView, SearchPage, SearchQuery } from '../shared.js'
import type { ReaderStoreDeps, ReaderState } from './store.js'

export interface SearchActionHost {
  get: () => ReaderState
  set: (patch: Partial<ReaderState>) => void
  rpc: ReaderStoreDeps['rpc']
  newAbortController: ReaderStoreDeps['newAbortController']
  nextListVersion: () => number
  currentListVersion: () => number
  reload: () => Promise<void>
  refreshDuplicateHints: () => void
}

export function createSearchActions(host: SearchActionHost) {
  const { get, set, rpc, newAbortController, nextListVersion, currentListVersion, reload, refreshDuplicateHints } = host
  let searchRequest: AbortController | undefined
  let searchPages = 0

  const loadSearch = async (cursor?: string, pages = 1): Promise<void> => {
    const search = get().search
    if (!search) return
    searchRequest?.abort()
    const request = newAbortController()
    searchRequest = request
    const version = nextListVersion()
    const firstPage = cursor === undefined
    set({ loading: firstPage, loadingMore: !firstPage, error: undefined })
    const nav = get().navSelection
    const feedId = nav.kind === 'feed' ? nav.feedId : undefined
    const tagId = nav.kind === 'tag' ? nav.tagId : search.tagId
    // 文件夹范围 = 当前成员 id；若搜索表单另选了订阅源，取交集（两者是不可分割的「范围」条件）。
    const folderIds = nav.kind === 'folder'
      ? get().feeds.filter((feed) => feed.folder === nav.folder).map((feed) => feed.id)
      : undefined
    const scopedFeedIds = folderIds === undefined
      ? search.feedIds
      : search.feedIds === undefined
        ? folderIds
        : search.feedIds.filter((feedId) => folderIds.includes(feedId))
    const read = get().filter === 'unread' ? 'unread' : search.read
    const starred = get().filter === 'starred' || search.starred
    // 空文件夹（或与源筛选交集为空）不发请求：worker 对空 feeds 本来也回空，但这里是
    // 「范围就是空」而不是「忘了给范围」，失败形态必须区分开。
    const emptyScope = (get().filter === 'unread' && search.read === 'read')
      || (folderIds !== undefined && (scopedFeedIds?.length ?? 0) === 0)
    try {
      const found: ItemView[] = []
      const previous = firstPage ? [] : get().items
      const existing = new Set(previous.map((item) => item.id))
      let nextCursor = cursor
      let received = 0
      do {
        const page: SearchPage = emptyScope ? { items: [] } : await rpc<SearchPage>('searchItems', {
          ...search,
          ...(feedId === undefined ? {} : { feedId }),
          ...(scopedFeedIds === undefined ? {} : { feedIds: scopedFeedIds }),
          ...(tagId === undefined ? {} : { tagId }),
          cursor: nextCursor, read, starred,
        }, request.signal)
        if (version !== currentListVersion()) return
        for (const item of page.items) {
          if (existing.has(item.id)) continue
          existing.add(item.id)
          found.push(item)
        }
        nextCursor = page.nextCursor
        received++
      } while (nextCursor !== undefined && received < pages)

      // 翻页期间可能已标读，追加时保留当前列表的修改。
      const items = firstPage ? found : [...get().items, ...found]
      const selectedId = items.some((item) => item.id === get().selectedId) ? get().selectedId : items[0]?.id
      searchPages = firstPage ? received : searchPages + received
      set({
        items, selectedId, nextCursor, loading: false, loadingMore: false,
        searchRevision: get().searchRevision + (firstPage ? 1 : 0),
      })
      refreshDuplicateHints()
    } catch (error) {
      if (version !== currentListVersion()) return
      set({ loading: false, loadingMore: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (searchRequest === request) searchRequest = undefined
    }
  }

  const resetSearchPage = (): void => {
    if (!get().search) return
    searchPages = 0
    set({ items: [], selectedId: undefined, nextCursor: undefined })
    void loadSearch()
  }

  const submitSearch = (query?: SearchQuery): void => {
    if (!query?.text.trim()) {
      if (!get().search) return
      nextListVersion()
      searchRequest?.abort()
      set({ search: undefined, items: [], nextCursor: undefined, selectedId: undefined, loadingMore: false })
      void reload()
      return
    }
    set({ search: { ...query, text: query.text.trim() }, view: 'list', article: undefined })
    resetSearchPage()
  }

  return {
    load: loadSearch,
    reset: resetSearchPage,
    submit: submitSearch,
    abort: (): void => { searchRequest?.abort() },
    pages: (): number => searchPages,
    /** 有没有搜索请求在途（load() 的 catch 据此决定要不要清 loading）。 */
    inFlight: (): boolean => searchRequest !== undefined,
  }
}
