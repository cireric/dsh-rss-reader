/**
 * 探索域的动作（R8b 04）：打开 / 关闭 / 筛选取页 / 续页 / 选路由预填 / 拼地址 / 连续订阅。
 *
 * 为什么单独成文件：照 store.ts 顶部的边界表，探索的 state（目录页、查询态、表单草稿、回执）
 * 不属于列表 / 搜索 / 订阅 / 标签 / 设置任何一块。放进订阅域会把「目录浏览」与「订阅增删」
 * 两种数据来源混在一起；而动作本身又必须能调现有的 `addFeed`（订阅的唯一入口）。
 *
 * 判据分工（spec §4.5）：**模板解析与预填读 explore-template.ts 的唯一实现**，地址拼装只调宿主
 * 的 `exploreBuildUrl` —— 客户端不拼地址、不解释 namespace，也不自己校验 constraint。
 */
import type { ExploreCatalogPage, ExploreRouteView } from '../shared.js'
import { parsePathTemplate, prefillValues } from '../explore-template.js'
// R15 06：hideNsfw 的默认值只有 rsshub-prefs.ts 一处（缺省 = 隐藏 NSFW）。
import { effectiveHideNsfw } from '../rsshub-prefs.js'
import type { ExploreState, ReaderState, ReaderStoreDeps } from './store.js'

export interface ExploreActionHost {
  get: () => ReaderState
  set: (patch: Partial<ReaderState>) => void
  rpc: ReaderStoreDeps['rpc']
  /**
   * 订阅的唯一入口（feed-actions 的 addFeed）。探索只把拼好的 URL 交给它，
   * 不复制「校验 → 落库 → reload」那条路径（D6 / spec §4.6）。
   */
  addFeed: (url: string) => Promise<{ ok: true; added: number; existed: number } | { ok: false; message: string }>
  /** 视图记忆的整份覆盖写（R15 06：「只看可跑」归 viewPreferences，不归 config.rsshub）。 */
  persistView: () => void
  /** 保存「显示 NSFW」开关（config.rsshub.hideNsfw）；写盘成功后才允许重取。 */
  saveRsshubHideNsfw: (hideNsfw: boolean) => Promise<{ ok: true } | { ok: false; message: string }>
  /** 隐藏一个站点（config.rsshub.hiddenNamespaces，R15 07）；写盘成功后才允许重取。 */
  hideNamespace: (namespace: string) => Promise<{ ok: true } | { ok: false; message: string }>
}

/** 一次打开探索时的空状态：q / category / namespace 与表单都从零开始（D14，不持久化）。 */
function emptyExplore(): ExploreState {
  return {
    items: [],
    q: '',
    category: undefined,
    namespace: undefined,
    categories: [],
    siteTotal: undefined,
    routeTotal: undefined,
    matched: undefined,
    loading: true,
    loadingMore: false,
    error: undefined,
    nextCursor: undefined,
    selected: undefined,
    draft: {},
    prefilled: false,
    missing: [],
    builtUrl: undefined,
    building: false,
    adding: false,
    receipt: undefined,
  }
}

/**
 * 只把生效中的筛子发给宿主（空串 / undefined = 不生效，与宿主 payload schema 同一语义）。
 *
 * R15 06 的两个开关**显式带上**：过滤在宿主侧执行，游标栅栏也按它们算 —— 客户端若只在本地过滤，
 * `matched` / 页大小 / `nextCursor` 会全部失真（spec §4.2.4）。缺省值仍由宿主兜底。
 */
function catalogPayloadOf(
  explore: ExploreState,
  cursor: string | undefined,
  hideNsfw: boolean,
  onlyRunnable: boolean,
): { q?: string; category?: string; namespace?: string; hideNsfw: boolean; onlyRunnable: boolean; cursor?: string } {
  const payload: {
    q?: string
    category?: string
    namespace?: string
    hideNsfw: boolean
    onlyRunnable: boolean
    cursor?: string
  } = { hideNsfw, onlyRunnable }
  if (explore.q !== '') payload.q = explore.q
  if (explore.category !== undefined) payload.category = explore.category
  if (explore.namespace !== undefined) payload.namespace = explore.namespace
  if (cursor !== undefined) payload.cursor = cursor
  return payload
}

export function createExploreActions(host: ExploreActionHost) {
  const { get, set, rpc, addFeed, persistView, saveRsshubHideNsfw, hideNamespace } = host

  /**
   * 第一页请求的代数。换筛选会立刻发起新请求，旧请求可能更晚回来 —— 不判代数就会把
   * 「上一次筛选的第一页」追加到这一次的列表里（同 search 域 listVersion 的手法）。
   */
  let pageVersion = 0

  const fetchFirstPage = async (): Promise<void> => {
    const version = ++pageVersion
    const explore = get().explore
    if (explore === undefined) return
    set({
      explore: {
        ...explore, items: [], nextCursor: undefined, matched: undefined,
        loading: true, loadingMore: false, error: undefined,
      },
    })
    try {
      const page = await rpc<ExploreCatalogPage>('exploreCatalog', catalogPayloadOf(
        explore,
        undefined,
        effectiveHideNsfw(get().rsshubSettings?.hideNsfw),
        get().onlyRunnable,
      ))
      if (version !== pageVersion) return
      const current = get().explore
      if (current === undefined) return
      set({
        explore: {
          ...current,
          items: page.items,
          categories: page.categories,
          siteTotal: page.siteTotal,
          routeTotal: page.routeTotal,
          matched: page.matched,
          nextCursor: page.nextCursor,
          loading: false,
          error: undefined,
        },
      })
    } catch (failure) {
      if (version !== pageVersion) return
      const current = get().explore
      if (current === undefined) return
      // 目录失败不是「空列表」：错误原样留在视图里（catalog-unavailable / not-configured 的 message）。
      set({
        explore: {
          ...current, items: [], loading: false,
          error: failure instanceof Error ? failure.message : String(failure),
        },
      })
    }
  }

  /** 打开探索：整份新状态 + 第一页。每次打开都重新请求（宿主侧 12h 缓存负责不重复出网）。 */
  const openExplore = (): void => {
    if (get().view === 'explore') return
    set({ view: 'explore', explore: emptyExplore() })
    void fetchFirstPage()
  }

  /** 关闭即整份丢弃（D14）：下一次打开回到干净状态。 */
  const closeExplore = (): void => { set({ view: 'list', explore: undefined }) }

  /**
   * 改查询条件：q / category / namespace 任一变化 ⇒ 已加载行与游标作废，重新取第一页。
   *
   * 为什么不在原列表上过滤：宿主的分页是在完整目录上做的 keyset；在客户端过滤当前页会出现
   * 「明明有命中却显示 0 条」，也会让旧游标与新筛选错配（B7 的栅栏会拒绝，界面就卡死）。
   */
  const setExploreQuery = (
    patch: Partial<Pick<ExploreState, 'q' | 'category' | 'namespace'>> & { onlyRunnable?: boolean },
  ): void => {
    const explore = get().explore
    if (explore === undefined) return
    const next: ExploreState = { ...explore }
    // 用 `in` 判「这一项有没有被点到」而不是 `!== undefined`：清除分类传的正是 undefined，
    // 若把 undefined 当成「没改」，点「清除筛选」后分类会顽固地留着。
    if ('q' in patch && patch.q !== undefined) next.q = patch.q.trim()
    if ('category' in patch) next.category = patch.category === '' ? undefined : patch.category
    if ('namespace' in patch) next.namespace = patch.namespace === '' ? undefined : patch.namespace
    // 「只看可跑」也走同一入口：它和 q / 分类一样是过滤器，变化必须重取第一页；
    // 但它住在视图记忆里（不是 config.rsshub），所以变化时顺手落一次盘。
    const nextOnlyRunnable = 'onlyRunnable' in patch && patch.onlyRunnable !== undefined
      ? patch.onlyRunnable
      : get().onlyRunnable
    const onlyRunnableChanged = nextOnlyRunnable !== get().onlyRunnable
    // 「再点同类 = 清除」在视图层把值翻译成 undefined；这里只判「有没有真的变」——
    // 同值重选不该白白发一次请求（分类按钮的音量）。
    const changed = next.q !== explore.q
      || next.category !== explore.category
      || next.namespace !== explore.namespace
      || onlyRunnableChanged
    if (!changed) return
    if (onlyRunnableChanged) {
      set({ onlyRunnable: nextOnlyRunnable })
      persistView()
    }
    set({ explore: { ...next, items: [], nextCursor: undefined, matched: undefined, loading: true, error: undefined } })
    void fetchFirstPage()
  }

  /**
   * 「显示 NSFW」开关（R15 06）：先写 config.rsshub.hideNsfw，成功后才用新筛选重取第一页。
   *
   * 失败不重取：界面开关读的是同一份快照，写盘失败时它本来就不会翻面；提前重取只会让请求与
   * 界面状态各说各话。过滤器变了游标必须重来（`fetchFirstPage` 会清空 items / nextCursor）。
   */
  const setExploreHideNsfw = async (hideNsfw: boolean): Promise<void> => {
    if (get().explore === undefined) return
    const result = await saveRsshubHideNsfw(hideNsfw)
    if (!result.ok) {
      set({ error: '保存 NSFW 偏好失败：' + result.message })
      return
    }
    await fetchFirstPage()
  }

  /**
   * 隐藏整个站点（R15 07）：先写 config.rsshub.hiddenNamespaces，成功后才用新筛选重取第一页。
   *
   * 与 NSFW 开关同一条纪律：隐藏是筛选条件的一部分（还会进游标栅栏），所以列表与游标必须
   * 整份作废重来 —— 失败时不重取，界面保持原样并给出可读原因。
   */
  const hideExploreNamespace = async (namespace: string): Promise<void> => {
    if (get().explore === undefined) return
    // 失败时宿主动作已写进全局 error（两个入口共用一条通道），这里不重取、不改列表。
    if (!(await hideNamespace(namespace)).ok) return
    await fetchFirstPage()
  }

  /** 续页：游标原样回带，成功后追加；失败保留已加载行（不让一次续页失败清空整屏）。 */
  const loadMoreExplore = async (): Promise<void> => {
    const explore = get().explore
    if (explore === undefined || explore.loading || explore.loadingMore || explore.nextCursor === undefined) return
    const version = pageVersion
    const cursor = explore.nextCursor
    set({ explore: { ...explore, loadingMore: true } })
    try {
      const page = await rpc<ExploreCatalogPage>('exploreCatalog', catalogPayloadOf(
        explore,
        cursor,
        effectiveHideNsfw(get().rsshubSettings?.hideNsfw),
        get().onlyRunnable,
      ))
      if (version !== pageVersion) return
      const current = get().explore
      if (current === undefined) return
      set({
        explore: {
          ...current,
          items: [...current.items, ...page.items],
          categories: page.categories,
          siteTotal: page.siteTotal,
          routeTotal: page.routeTotal,
          matched: page.matched,
          nextCursor: page.nextCursor,
          loadingMore: false,
        },
      })
    } catch (failure) {
      if (version !== pageVersion) return
      const current = get().explore
      if (current === undefined) return
      set({
        explore: {
          ...current, loadingMore: false,
          error: failure instanceof Error ? failure.message : String(failure),
        },
      })
    }
  }

  /**
   * 选中一条路由：字段来自 parsePathTemplate，预填来自 prefillValues（两者都只有一份实现）。
   * 换路由 = 上一份草稿作废：残留值只会在新模板里制造「看起来填过」的假象。
   *
   * `prefilled` 记的是「这次真的预填了没有」：example 缺省（262 条）或段数对不上时
   * prefillValues 返回空对象，表单要据此提示按官方文档填写，而不是给一排空 input 让人
   * 以为实例没提供任何信息（spec §4.5）。
   */
  const selectExploreRoute = (route: ExploreRouteView): void => {
    const explore = get().explore
    if (explore === undefined) return
    const template = parsePathTemplate(route.path)
    const draft = prefillValues(template, route.example, route.namespace)
    set({
      explore: {
        ...explore,
        selected: route,
        draft,
        prefilled: Object.keys(draft).length > 0,
        missing: [],
        builtUrl: undefined,
        building: false,
        receipt: undefined,
        error: undefined,
      },
    })
  }

  const setExploreDraftValue = (name: string, value: string): void => {
    const explore = get().explore
    if (explore === undefined) return
    set({
      explore: {
        ...explore,
        draft: { ...explore.draft, [name]: value },
        // 一改值，上一次拼出的地址与回执都不再对应当前表单：留着会让「添加」变成订旧地址。
        builtUrl: undefined,
        missing: [],
        receipt: undefined,
      },
    })
  }

  /**
   * 拼地址：客户端只做「必填是否为空」这一条本地拦截（服务端仍会拒，不作为唯一防线）。
   * 真正的模板拼接、可选段省略、通配拒绝都在宿主的 exploreBuildUrl 里（spec §4.5）。
   */
  const buildExploreAddress = async (): Promise<void> => {
    const explore = get().explore
    const route = explore?.selected
    if (explore === undefined || route === undefined || explore.building) return
    const template = parsePathTemplate(route.path)
    const missing: string[] = []
    for (const segment of template.segments) {
      if (segment.kind !== 'param' || segment.optional) continue
      if ((explore.draft[segment.name] ?? '').trim() === '' && !missing.includes(segment.name)) {
        missing.push(segment.name)
      }
    }
    if (missing.length > 0) {
      set({ explore: { ...explore, missing } })
      return
    }
    set({ explore: { ...explore, building: true, missing: [] } })
    // 回包落地前重判「用户还在看同一站点的同一条路由」。只比 path 不够：两个站点可以有
    // 同一条 path（如都是 `/`），切换站点后旧回包会把 A 的 URL 写进 B 的表单。
    // namespace 是站点的唯一键，必须与 path 一起比对。
    const sameRouteSelected = (current: ExploreState | undefined): current is ExploreState =>
      current !== undefined
      && current.selected?.namespace === route.namespace
      && current.selected?.path === route.path
    try {
      const result = await rpc<{ url?: string }>('exploreBuildUrl', {
        namespace: route.namespace,
        path: route.path,
        values: explore.draft,
      })
      const current = get().explore
      if (!sameRouteSelected(current)) return
      if (typeof result?.url !== 'string' || result.url === '') {
        throw new Error('exploreBuildUrl 回包缺少 url')
      }
      set({ explore: { ...current, building: false, builtUrl: result.url, receipt: undefined } })
    } catch (failure) {
      const current = get().explore
      if (!sameRouteSelected(current)) return
      set({ explore: { ...current, building: false } })
      // 与既有动作同一条错误通道：顶部错误条可见原因，不另造一套探索专用错误位。
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /**
   * 连续订阅（D6）：只调现有 addFeed，成功后不关视图、不清表单，只给回执。
   * 失败原因由 addFeed 写进既有 error 通道（订阅校验失败时它也会带回可读 reason）。
   */
  const addExploreSubscription = async (): Promise<void> => {
    const explore = get().explore
    if (explore === undefined || explore.builtUrl === undefined || explore.adding) return
    const url = explore.builtUrl
    set({ explore: { ...explore, adding: true } })
    const result = await addFeed(url)
    const current = get().explore
    // 用户可能在请求在飞时关掉探索：这时不许把一份新的 explore 状态写回来。
    if (current === undefined) return
    if (!result.ok) {
      set({ explore: { ...current, adding: false }, error: result.message })
      return
    }
    set({
      explore: {
        ...current,
        adding: false,
        // 已存在不是失败（addFeed 的既有语义），但回执不能写成「已添加」——那是撒谎。
        receipt: result.added > 0 ? '已添加 ✓' : '已存在 ✓',
      },
    })
  }

  return {
    openExplore, closeExplore, setExploreQuery, setExploreHideNsfw, hideExploreNamespace, loadMoreExplore,
    selectExploreRoute, setExploreDraftValue, buildExploreAddress, addExploreSubscription,
  }
}
