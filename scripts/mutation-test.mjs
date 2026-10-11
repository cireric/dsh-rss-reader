/**
 * 变异测试：把已经修好的关键判定**逐个改坏**，看测试套件是否见红。
 *
 * 为什么值得固化：这次评审里最有价值的产出不是「测试全绿」，而是**量出了绿的可信边界**——
 * 只断言 store 的客户端测试让三条接线变异全部幸存（P1-5 之前）；正文缓存闸门因为喂的是废弃的
 * 数据形态而永不触发（P0-3 之前）。这两类问题「跑测试」发现不了，只有「改坏它看有没有人喊」
 * 才能发现。
 *
 * 用法：npm run mutation（需先 npm run build + npm run build:client —— 改的是 lib/ 产物）。
 * 判据：**每一条变异都必须被抓到**；有幸存者就以非零码退出，并指出是哪条漏了。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ROOT = process.cwd()

/**
 * 每条只改一处。刻意**不含等价变异** —— 例如 selectArticleEvictions 里把 total 与上限的
 * 比较从小于等于改成小于：两者在相等时的返回值同为「不清」，行为完全相同，它幸存不是测试
 * 缺口。等价变异混进来会让这道门槛变成狼来了。
 */
const MUTATIONS = [
  // article-view.ts 随原站视图整条删除（2026-10-08），那条变异的目标已不存在。
  // 换成守护本次修复的两条判定：装饰性小图过滤、同一图重复去重。
  { id: 'article-装饰性小图过滤', file: 'lib/article.js',
    from: 'if (width > 0 && height > 0 && width <= DECORATIVE_IMAGE_MAX && height <= DECORATIVE_IMAGE_MAX)',
    to: 'if (false)' },
  { id: 'article-重复图去重', file: 'lib/article.js',
    from: 'if (count > MAX_SAME_IMAGE)', to: 'if (false)' },
  // 容器识别（2026-10-09）：它替代了「按尺寸/路径逐条猜杂图」的做法，失效就意味着站点头像与
  // 页脚二维码重新回到正文里 —— 正是用户截图里的现象，所以必须有人看着它。
  // ⚠️ 刻意**没有**「正文容器收窄」那条变异：它实测是**等价变异**，不是测试缺口。
  // 设子容器文本 c、父容器额外文本 x，子全为段落时子分数 = c、父分数 = c + 0.35x；
  // 要让收窄被接受需 c ≥ 0.9(c + 0.35x) ⇒ x ≤ 0.317c，而文本比阈值要求 c ≥ 0.5(c + x) ⇒ x ≤ c。
  // 后者被前者严格蕴含 ⇒ 去掉文本比检查后**没有任何输入**会改变结果，套件全绿是正确行为。
  { id: 'article-容器识别的整页兜底', file: 'lib/article.js',
    // 兜底失效 ⇒ 容器一旦选错就是「正文全丢」，这是本设计最危险的失效模式，必须有断言看住
    from: 'const blocks = focused.length > 0 ? focused : collectBlocks(scoped, baseUrl)',
    to: 'const blocks = focused' },
  { id: 'keys-r 归还刷新计数', file: 'lib/keys.js',
    from: "return 'refreshCount';", to: "return 'toggleRender';" },
  { id: 'client-A 的范围阈值过滤', file: 'lib/client.js',
    from: 'recencyOf(item) < before', to: 'true' },
  { id: 'subscribe-信任不跨源传播', file: 'lib/subscribe.js',
    from: 'const inherited = options.limits.trustedTarget === true && isSameOrigin(candidate, pageUrl);',
    to: 'const inherited = options.limits.trustedTarget === true;' },
  { id: 'discover-只认 rel=alternate', file: 'lib/feed/discover.js',
    from: 'if (!/\\balternate\\b/i.test(rel))', to: 'if (false)' },
  { id: 'client-1 键切展开视图', file: 'lib/client.js',
    from: 'setLayout("expanded")', to: 'setLayout("list")' },
  { id: 'retention-星标保护', file: 'lib/retention.js',
    from: 'const protectedFromPrune = (row) => row.starred || row.kept;',
    to: 'const protectedFromPrune = (row) => row.kept;' },
  { id: 'retention-未读优先级', file: 'lib/retention.js',
    from: 'return [...unread, ...read].slice(0, overflow).map((row) => row.id);',
    to: 'return [...read, ...unread].slice(0, overflow).map((row) => row.id);' },
  { id: 'retention-清理的星标保护', file: 'lib/retention.js',
    from: '.filter((row) => row.read && !row.starred && row.recency < cutoffIso)',
    to: '.filter((row) => row.read && row.recency < cutoffIso)' },
  { id: 'retention-非法上限保护', file: 'lib/retention.js',
    from: 'if (maxChars <= 0 || total <= maxChars)',
    to: 'if (total <= maxChars)' },
  { id: 'list-scroll-视口内判定', file: 'lib/list-scroll.js',
    from: 'if (rowTop >= currentTop && rowTop + rowHeight <= currentTop + containerHeight)',
    to: 'if (rowTop > currentTop && rowTop + rowHeight <= currentTop + containerHeight)' },
  { id: 'list-scroll-夹取保护', file: 'lib/list-scroll.js',
    from: 'const ceiling = Number.isFinite(maxTop) && maxTop > 0 ? maxTop : 0;',
    to: 'const ceiling = maxTop;' },
  { id: 'item-id-guid 优先级', file: 'lib/feed/item-id.js',
    from: 'const basis = item.id?.trim() || item.link?.trim() ||',
    to: 'const basis = item.link?.trim() ||' },
  { id: 'keys-大写 R', file: 'lib/keys.js',
    from: "case 'r':\n        case 'R':",
    to: "case 'r':" },
  { id: 'keys-大写 F', file: 'lib/keys.js',
    from: "case 'f':\n        case 'F':",
    to: "case 'f':" },
  { id: 'refresh-正文升级判定', file: 'lib/refresh.js',
    from: 'const needsContentUpgrade = (previous?.contentRevision ?? 1) < CONTENT_REVISION;',
    to: 'const needsContentUpgrade = (previous?.contentRevision ?? 1) > CONTENT_REVISION;' },
  { id: 'refresh-正文不得降级覆盖', file: 'lib/refresh.js',
    from: 'if (existing !== undefined && (summary?.length ?? 0) > (existing.summary?.length ?? 0))',
    to: 'if (existing !== undefined)' },
  { id: 'refresh-缓存闸门认 blocks', file: 'lib/refresh.js',
    from: 'chars: articleCharsOf(record.article),',
    to: 'chars: (record.article?.paragraphs ?? []).reduce((sum, paragraph) => sum + paragraph.length, 0),' },
  { id: 'domain-rebuildItem 的 omit', file: 'lib/domain.js',
    from: 'if (change.omit?.includes(field) === true)',
    to: 'if (false)' },
  { id: 'item-id-撞车即不可信', file: 'lib/feed/item-id.js',
    from: 'new Set(group.map((index) => linkOf[index])).size < 2', to: 'false' },
  // 身份分叉（2026-10-09，用户实测「同一篇文章两条」）：这四条判定是修复的全部承重点，
  // 少一条就退回病象——所以逐个改坏，看 tests/identity.test.mjs 有没有人喊。
  { id: 'item-id-链接反查认回老身份', file: 'lib/feed/item-id.js',
    from: 'known?.idOf(linkOf[index])', to: 'undefined' },
  { id: 'item-id-退级不得再用源 id', file: 'lib/feed/item-id.js',
    from: 'if (options.includeSourceId !== false)', to: 'if (true)' },
  { id: 'item-id-认回身份要有旁证', file: 'lib/feed/item-id.js',
    from: 'return record === undefined || corroborates(record, items[index]);', to: 'return true;' },
  { id: 'identity-幸存者取最早一条', file: 'lib/identity-repair.js',
    from: 'a.fetchedAt === b.fetchedAt ? a.id.localeCompare(b.id) : a.fetchedAt.localeCompare(b.fetchedAt))',
    to: 'a.fetchedAt === b.fetchedAt ? a.id.localeCompare(b.id) : b.fetchedAt.localeCompare(a.fetchedAt))' },
  { id: 'identity-空链接不参与合并', file: 'lib/identity-repair.js',
    from: "const link = row.link.trim();\n        if (link === '')",
    to: "const link = row.link.trim();" },
  { id: 'identity-合并保住已读态', file: 'lib/identity-repair.js',
    from: 'readAt: keep.readAt ?? extra.readAt,', to: 'readAt: extra.readAt,' },
  { id: 'identity-合并保住星标', file: 'lib/identity-repair.js',
    from: 'starred: keep.starred || extra.starred,', to: 'starred: keep.starred,' },
  { id: 'retention-保持未读不裁剪', file: 'lib/retention.js',
    from: 'row.starred || row.kept',
    to: 'row.starred' },
  { id: 'fetch-重定向目标不可信', file: 'lib/feed/fetch.js',
    from: 'const hopBlocked = await resolvedBlockedReason(next, false);',
    to: 'const hopBlocked = await resolvedBlockedReason(next, trusted);' },
  { id: 'fetch-解析层内网拦截', file: 'lib/feed/fetch.js',
    from: 'const privateAddress = addresses.find((address) => isPrivateHost(address));',
    to: 'const privateAddress = undefined;' },
  { id: 'client-键解析短路', file: 'lib/client.js',
    from: 'const action = resolveReaderKey(event.key, event.shiftKey);',
    to: "const action = 'none';" },
  { id: 'client-可见性守卫恒真', file: 'lib/client.js',
    from: 'if (root === null || root.getClientRects().length === 0)',
    to: 'if (true)' },
  { id: 'client-不注册监听器', file: 'lib/client.js',
    from: 'document.addEventListener("keydown", onKeyDown);',
    to: ';' },
  // 滚动容器这一族（2026-10-09 修）。变异目标是**按键时刻现取容器**这条机制：
  // 它一旦退回「渲染期取一次」，详情页就会重新变成静默 no-op，而旧的假 React 夹具对此全绿。
  // 判据由 tests/scroll-dom.test.mjs 用真实 React + jsdom 看着（那一层才能表达这个失效）。
  { id: 'client-容器退回渲染期捕获', file: 'lib/client.js',
    from: 'const container = root === null ? null : root.querySelector(selector);',
    to: 'const container = null;' },
  // ⚠️ 变异模式必须照**编译产物**的实际形状写（多行 if、单引号），
  // 照源码格式写会「未应用」——那等于这条变异根本没跑，比幸存更隐蔽。
  { id: 'client-容器选择器不分视图', file: 'lib/list-scroll.js',
    from: "return '[' + SCROLL_ATTR + '=\"article\"]';",
    to: "return '[' + SCROLL_ATTR + '=\"list\"]';" },
  { id: 'client-正文行高量错对象', file: 'lib/client.js',
    from: 'const sample = box.querySelector("p") ?? box;',
    to: 'const sample = box;' },
  { id: 'client-半页退化成整页', file: 'lib/client.js',
    from: "? halfPageTop(box.scrollTop, box.clientHeight, maxTop, direction)",
    to: "? pageTop(box.scrollTop, box.clientHeight, maxTop, direction)" },
  { id: 'client-换文章不归零', file: 'lib/client.js',
    from: 'box.scrollTop = 0;',
    to: 'box.scrollTop = box.scrollTop;' },
  // 导航轴（2026-10-10 两列布局任务 2）。这三条是「源 x filter 叠加」的全部承重点：
  // 叠加判定失效 ⇒ 退化成只看 filter；不重落选中 ⇒ j/k 在看不见的条目上无反应；
  // perFeedUnread 不落 state ⇒ 左栏角标无数据。判据由 tests/nav-selection.test.mjs 看着。
  { id: 'client-导航轴叠加失效', file: 'lib/client.js',
    from: 'if (state.navSelection.kind === "feed" && item.feedId !== state.navSelection.feedId) return false;',
    to: ';' },
  { id: 'client-切源不重落选中', file: 'lib/client.js',
    from: 'set({ selectedId: state.items.filter(inScope)[0]?.id });',
    to: ';' },
  { id: 'client-perFeedUnread 不落 state', file: 'lib/client.js',
    from: 'perFeedUnread: overview.perFeedUnread,',
    to: 'perFeedUnread: {},' },
  // setFilter 的「源 x filter」语义（评审 Important 2）。既有 setFilter 用例全跑在 virtual 状态
  // 下、源条件恒真 ⇒ 这条路径零覆盖。退回「只按 filter 算第一条」后，已选中某源时切 filter
  // 会把 selectedId 送到源外条目 —— 判据是 tests/nav-selection.test.mjs 的第 6 条用例。
  { id: 'client-setFilter 丢掉源条件', file: 'lib/client.js',
    // ⚠️ 2026-10-10 任务 6 返工：setFilter 提出具名函数并顺带同步 navCursor，产物形状随之变化，
    // 本条 from 原为 'set({ filter });\n...relocateSelection();' ⇒ 变成「未应用」。
    // 照新产物重写（独立实测 OCCURRENCES=1），语义仍是原来的那条：**丢掉源条件**、selectedId 落全表第一条。
    from: '\t\t\t\tset({\n\t\t\t\t\tfilter,\n\t\t\t\t\tnavCursor: {\n\t\t\t\t\t\tkind: "filter",\n\t\t\t\t\t\tfilter\n\t\t\t\t\t}\n\t\t\t\t});\n\t\t\t\trelocateSelection();',
    to: '\t\t\t\tset({\n\t\t\t\t\tfilter,\n\t\t\t\t\tnavCursor: {\n\t\t\t\t\t\tkind: "filter",\n\t\t\t\t\t\tfilter\n\t\t\t\t\t}\n\t\t\t\t});\n\t\t\t\tconst list = filter === "all" ? state.items : state.items.filter((i) => filter === "unread" ? i.readAt === void 0 : i.starred);\n\t\t\t\tset({ selectedId: list[0]?.id });' },
  // 「再选同源 = 取消」与「virtual 归位 filter」（评审 Minor 2）：两条判定各一条变异。
  // 前者失效 ⇒ 左栏点亮的项再点一次不回聚合视图；后者失效 ⇒ 虚拟视图留着一套过滤器残留，
  // 变成与 filter 并存的第二套过滤状态（本任务实现时第一遍就漏了后者，靠测试才抓到）。
  { id: 'client-再选同源不取消', file: 'lib/client.js',
    from: 'if (next.kind === "feed" && current.kind === "feed" && current.feedId === next.feedId || next.kind === "virtual") set({',
    to: 'if (next.kind === "virtual") set({' },
  { id: 'client-virtual 不归位 filter', file: 'lib/client.js',
    from: 'navSelection: { kind: "virtual" },\n\t\t\t\t\tfilter: "all"',
    to: 'navSelection: { kind: "virtual" }' },
  // 每源未读数的**键域**（2026-10-10）。左栏角标按 feeds 表逐行渲染，键域必须严格 = feeds 表：
  // 删掉「以 feeds 表铺 0」后，0 未读的源会丢键，那一行变成「角标空白」而不是「角标 0」——
  // 界面上无从分辨，是最贵的那类沉默失败。非等价变异：丢键后取值变 undefined，两条测试会红。
  // ⚠️ 2026-10-10 任务 9：本条原锚在 lib/endpoints.js 的 'perFeedUnread[feed.id] = 0;'。
  // 该循环已收敛进 shared.ts 的 countUnreadPerFeed（口径唯一化的同一件事），产物随之变化 ⇒
  // 原锚变「未应用」（docs/pitfalls.md 二、2.7：未应用比幸存更隐蔽）。照新产物重写，
  // 独立实测 lib/shared.js:41 OCCURRENCES=1，语义仍是原来那条：**丢键域**（0 未读的源不留键）。
  { id: 'endpoints-perFeedUnread 键域铺 0', file: 'lib/shared.js',
    from: 'unread[feedId] = 0;', to: ';' },
  // 左栏（2026-10-10 两列布局任务 3）。这两条是本任务新增的关键判定，各一条变异：
  // 角标门失效 ⇒ 规格不变量 8 的「三者同消」在左栏漏掉（隐藏计数后左栏还留着数字）；
  // 角标数据源换回 items 派生 ⇒ items 按 maxItemsShown 截断，角标与顶栏总数对不上。
  // 判据由 tests/scroll-dom.test.mjs 的「隐藏未读计数时左栏角标也消失」看着。
  { id: 'client-左栏角标无视 showUnread', file: 'lib/client.js',
    from: '...showUnread ? { "data-rss-nav-badge": String(unread) } : {},',
    to: '{ "data-rss-nav-badge": String(unread) },' },
  { id: 'client-左栏角标改用派生', file: 'lib/client.js',
    from: 'const unread = perFeedUnread[feed.id];',
    to: 'const unread = 0;' },
  // 折叠必须「不占宽度」（任务 3 的精确取值）：退回「渲染但宽 0」会留下一条右边框的缝，
  // 而要求是「收起 = 这一列不存在」。判据由 scroll-dom 的左栏用例看着（左栏容器应整个消失）。
  { id: 'client-折叠时左栏仍渲染', file: 'lib/client.js',
    // from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4 记的那条坑；本次实测踩到）：
    // 产物是 `children: [state.navVisible && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FeedNav, {`
    // （lib/client.js:1931，行首 6 个 tab），不是源码里的 `{state.navVisible && (<FeedNav`。
    // 该串是产物里唯一的 navVisible 条件：另两处是默认值 navVisible: true 与 !state.navVisible。
    // 改成恒真 ⇒ 折叠后左栏仍然渲染，`[data-rss-nav]` 还在 DOM 里 —— 折叠的判据就是「这个容器整个消失」。
    from: 'state.navVisible && /* @__PURE__ */',
    to: 'true && /* @__PURE__ */' },
  // 滚动键只作用右栏（2026-10-10 两列布局任务 4）。左栏同样 `overflowY: auto`，
  // 所以「按键不会去滚左栏」不取决于它能不能滚，而取决于**它不带 data-rss-scroll** 这个标记判定：
  // 一旦左栏也被打上该属性，querySelector 取到的第一个匹配就是它（FeedNav 在文档序里靠前），
  // n/p/空格 便去滚左栏而右栏纹丝不动 —— 读者看到的是「按键毫无反应」。
  // 判据由 tests/scroll-dom.test.mjs 的「滚动不误命中左栏」看着（纯函数层看不见这层错位）。
  { id: 'client-左栏也被标成滚动容器', file: 'lib/client.js',
    // from 照**编译产物**的真实形状写：lib/client.js:634 的 `"data-rss-nav": "",` 是全产物唯一一处
    // （左栏容器只此一个，见 docs/pitfalls.md 一、1.4）。
    from: '"data-rss-nav": "",',
    to: '"data-rss-nav": "", "data-rss-scroll": "list",' },
  // 按键守卫不许依赖环境全局（2026-10-09）。变异回 instanceof 后，
  // 判据是 tests/scroll-dom.test.mjs 的「本 realm 没有 HTMLElement 时快捷键照样能用」。
  { id: 'client-守卫改回环境全局', file: 'lib/client.js',
    from: 'function isElementNode(node) {',
    to: 'function isElementNode(node) { return node instanceof HTMLElement;' },
  // 右下角「回顶部 / 去底部」（2026-10-09）。两条各钉一个方向：
  // 反了或都不动，tests/scroll-dom.test.mjs 的箭头用例必须翻红。
  { id: 'client-去底部反成回顶部', file: 'lib/client.js',
    from: 'function edgeTopFor(maxTop, edge) {',
    to: 'function edgeTopFor(maxTop, edge) { return 0;' },
  { id: 'client-箭头按钮不接容器', file: 'lib/client.js',
    from: 'boxRef.current = node;',
    to: 'boxRef.current = null;' },
  // 「点 ↓ 之后贴住底部」（2026-10-09，用户实测：新文章首点到不了底）。
  // 病因是懒加载图片进场把内容撑高，而 scrollTop 留在原地；判据在 scroll-dom 的第 10 条用例。
  { id: 'client-到底后不贴住底部', file: 'lib/client.js',
    from: 'if (pinnedRef.current)',
    to: 'if (false)' },
  // 用户滚走必须解除贴底 —— 少了它会把读者的滚动硬拽回底部。
  { id: 'client-用户滚走不解除贴底', file: 'lib/client.js',
    from: 'if (Math.abs(box.scrollTop - expectedTopRef.current) > 2)',
    to: 'if (false)' },
  // 键盘流（2026-10-10 两列布局任务 6）：u 归还 GR 原义「左栏显隐」、向上半页改由 shift+d 接盘。
  // 两条都是**决策级**判定（改坏 = 用户肌肉记忆与界面标签当场对不上），各一条变异。
  // 判据：tests/keys.test.mjs 的「u 归还 GR 原义」「半页：d 向下、shift+d 向上」；
  // 接线面另有 tests/scroll-dom.test.mjs 的「u 键折叠/展开左栏」看着。
  { id: 'keys-u 改回向上半页', file: 'lib/keys.js',
    // from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4）：lib/keys.js:40 的
    // `        case 'u': return 'toggleNav';` 是全产物唯一一处（独立实测 OCCURRENCES=1）。
    from: "case 'u': return 'toggleNav';",
    to: "case 'u': return 'halfPageUp';" },
  { id: 'keys-shift+d 不接盘上半页', file: 'lib/keys.js',
    // lib/keys.js:38，同样唯一（独立实测 OCCURRENCES=1）。
    // 改成恒向下半页 ⇒ 上半页再无入口，「接盘」这句话在键位层就落空。
    from: "case 'd': return shift === true ? 'halfPageUp' : 'halfPageDown';",
    to: "case 'd': return 'halfPageDown';" },
  // 接线面（四条）：键位**解析对了但 client 没接线**这一层是本仓库多次踩到的形态
  // （任务 6 若只写 keys 断言就会漏）。判据都是 tests/scroll-dom.test.mjs 里走真实按键路径的新用例。
  { id: 'client-u 键不接左栏显隐', file: 'lib/client.js',
    from: 'run(() => store.toggleNav());',
    to: 'run(() => {});' },
  // ── 返工新增（2026-10-10，按规格 §2.4 把「移动」与「打开」拆开）──────────────────────
  // 第一版把两者合成一步（移动即 selectNav 打开它），shift+o 因此只剩「取消」，规格无从满足。
  // 拆开之后这条分工有三个独立的承重点，各一条变异：
  //   ① 移动键不许去改作用域（改回「移动即打开」）
  //   ② 移动不许顺带换 filter（半塌缩：光标走了、生效的也走了）
  //   ③ 打开键必须真的落到作用域（光标算对了却不动右栏 = shift+o 变摆设）
  { id: 'client-shift+n 改成「移动即打开」', file: 'lib/client.js',
    // from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4）。lib/client.js:2002，
    // 独立实测 OCCURRENCES=1。改回第一版行为后，press('N', true) 当场换掉右栏列表，
    // 判据「shift+n 移动光标时不改变右栏列表内容与 filter」立刻翻红。
    from: 'run(() => store.moveNavCursor(action === "navNext" ? 1 : -1));',
    to: 'run(() => { store.moveNavCursor(action === "navNext" ? 1 : -1); const n = store.get().navCursor; if (n.kind === "feed") store.selectNav({ kind: "feed", feedId: n.feedId }); else store.setFilter(n.filter); });' },
  { id: 'client-移动光标顺带换 filter', file: 'lib/client.js',
    // lib/client.js:598，独立实测 OCCURRENCES=1。这是「移动」那半边更隐蔽的半塌缩形态：
    // 光标确实走了、可 filter 也跟着走（读者看到右栏内容变了）。整条判定的要点是「光标变了而
    // 生效视图没变」，半塌缩同样得被守。
    from: 'set({ navCursor: next });',
    to: 'set({ navCursor: next, filter: next.kind === "filter" ? next.filter : state.filter });' },
  { id: 'client-打开光标不动作用域', file: 'lib/client.js',
    // lib/client.js:618，独立实测 OCCURRENCES=1。这是「打开」那半边：光标算对了却落不到作用域。
    from: 'setFilter(cursor.filter);',
    to: ';' },
  // 未读账目守恒（2026-10-10 两列布局任务 5）。这两条守的是**客户端**这一侧的每源账目：
  // 左栏角标读 state.perFeedUnread、顶栏读 state.unread（index.tsx:374 / :385），
  // 只动一边就会出现「角标还写着 3、顶栏已经 2」——界面上自相矛盾且无报错。
  // 判据是 tests/unread-accounting.test.mjs 的两条客户端用例（修前实测 2 条翻红）。
  { id: 'client-markRead 不动每源账目', file: 'lib/client.js',
    from: '[target.feedId]: Math.max(0, (state.perFeedUnread[target.feedId] ?? 0) - 1)',
    to: '[target.feedId]: state.perFeedUnread[target.feedId]' },
  // 增量助手是 markAllRead / undoMarkAll 的账目来源。把「按宿主下发的键铺 0」删掉后，
  // 重算结果只剩空表 ⇒ 0 未读的源丢键，左栏那一行的角标变「空白」而不是「0」——
  // 与任务 1 裁决的键域契约（键域严格 = feeds 表）同一条，是最贵的那类沉默失败。
  { id: 'client-每源账目丢键域', file: 'lib/client.js',
    from: 'const next = { ...state.perFeedUnread };',
    to: 'const next = {};' },
  // 严禁退回「按本地 items 整体重算」：客户端只拿得到 maxItemsShown（300）条，
  // 宿主按每源 500 条的**全量表**记账（src/config.ts）。整体重算会把截断之外的账抹掉，
  // 角标 0 / 顶栏 17 —— 正是任务 1 拒绝「客户端派生 perFeedUnread」的同一条理由。
  // 判据是 tests/unread-accounting.test.mjs 的两条截断用例（修前实测 2 条翻红）。
  { id: 'client-每源账目整体重算', file: 'lib/client.js',
    from: 'next[feedId] = Math.max(0, next[feedId] + delta);',
    to: 'next[feedId] = Math.max(0, state.items.filter((i) => i.feedId === feedId && i.readAt === void 0).length);' },
  // ── 视图记忆持久化（2026-10-10 两列布局任务 7）────────────────────────────────
  // 这一族的判据几乎全在 tests/nav-persistence.test.mjs（那边同时钉了「老域没有 global
  // 也能打开」这条必须实测的路径）。每条 from 都照**编译产物的实际形状**写、并已独立实测
  // OCCURRENCES=1（docs/pitfalls.md 一、1.4 / 二、2.7 记的就是照源码猜 from 的后果）。
  // ① 读侧的形状校验失效 ⇒ 认不出的值被原样吃到 state 里（「回落」这条承诺当场作废）
  { id: 'persist-读侧不校验形状', file: 'lib/client.js',
    from: '(isKnownFeed === void 0 || isKnownFeed(selection["feedId"]))',
    to: 'true' },
  // ② filter 枚举校验失效 ⇒ 非法 filter 被当成真的过滤条件用（右栏内容与按钮状态各说各话）
  { id: 'persist-filter 不校验枚举', file: 'lib/client.js',
    from: 'FILTERS.includes(filterRaw) ? filterRaw : DEFAULT_VIEW_PREFERENCES.filter',
    to: 'filterRaw ?? DEFAULT_VIEW_PREFERENCES.filter' },
  // ③ 恢复不许盖掉用户在异步窗口里做的手势（时序守卫）
  { id: 'persist-恢复盖掉用户手势', file: 'lib/client.js',
    from: 'if (viewTouched) return;',
    to: ';' },
  // ④ 恢复必须真的落到 state —— 只读了记忆却不用它，等于功能没接上（最隐蔽的形态）
  { id: 'persist-恢复不落到 state', file: 'lib/client.js',
    from: 'if (!viewRestored) applyRestoredView(preferences);',
    to: ';' },
  // ⑤ 写盘串行化失效 ⇒ 后发的先到会让记忆回退成更早的状态
  { id: 'persist-写盘不串行化', file: 'lib/client.js',
    from: 'viewWriteChain = viewWriteChain.then(() => callRpc("saveViewPreferences", { preferences }))',
    to: 'viewWriteChain = callRpc("saveViewPreferences", { preferences })' },
  // ⑥ 宿主写侧不归一再落库 ⇒ 认不出的原值进媒介（存储里攒垃圾，只被读侧遮住）
  { id: 'persist-宿主写侧不归一', file: 'lib/store.js',
    from: 'const safe = sanitizeViewPreferences(preferences, (feedId) => feeds.get(feedId) !== undefined);',
    to: 'const safe = preferences;' },
  // ⑦ 宿主读侧不校验 ⇒ 媒介里的坏值被透出去（回落承诺的第二道闸失效）
  { id: 'persist-宿主读侧不校验', file: 'lib/store.js',
    from: 'viewPreferences: () => sanitizeViewPreferences(global.get(), (feedId) => feeds.get(feedId) !== undefined),',
    to: 'viewPreferences: () => global.get(),' },
  // ⑧⑨⑩ 三个关键动作各自写一次盘：**三个调用点各一条**，否则任一条漏写都会被另一条的
  // 整份写入盖过去（persistView 落的是整个 state）。判据在「记住上次选中的导航项…」里
  // 逐个动作各断言一次。三条 from 各自唯一：产物里 persistView() 共 3 处，下面分别锚在
  // 「后随 applyOverview」「后随 /**」「前随 set({ navVisible: … })」上（均实测 OCCURRENCES=1）。
  { id: 'persist-setFilter 不写盘', file: 'lib/client.js',
    from: 'relocateSelection();\n\t\t\t\tpersistView();\n\t\t\t};\n\t\t\tconst applyOverview',
    to: 'relocateSelection();\n\t\t\t};\n\t\t\tconst applyOverview' },
  { id: 'persist-selectNav 不写盘', file: 'lib/client.js',
    from: 'relocateSelection();\n\t\t\t\tpersistView();\n\t\t\t};\n\t\t\t/**',
    to: 'relocateSelection();\n\t\t\t};\n\t\t\t/**' },
  { id: 'persist-toggleNav 不写盘', file: 'lib/client.js',
    from: 'set({ navVisible: !state.navVisible });\n\t\t\t\tpersistView();',
    to: 'set({ navVisible: !state.navVisible });' },
  // ── 标读回包的每源账目（2026-10-10 两列布局任务 9 收尾）──────────────────────────
  // 这一条守的是**缺陷本体**：客户端只拿得到 maxItemsShown（300）条 items，而宿主按每源 500 条的
  // 全量表记账。标读端点只回 unread 不回 perFeedUnread 时，客户端只能拿本地增量补每源账目；
  // 一旦本地看不见的漂移发生（另一个面板把某源标空），幽灵未读就留在基线里 ⇒ 左栏各源之和
  // 17 ≠ 顶栏 14（spec §4 不变量 1）。判据是 tests/unread-accounting.test.mjs 的
  // 「host：markRead / unmarkRead 的回包必须带 perFeedUnread」+ 两条「截断 + 外部漂移」用例。
  // from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4）：lib/endpoints.js:132，独立实测
  // OCCURRENCES=1（另一处同串在 unmarkRead 分支，靠后随的 case 名区分）。
  { id: 'endpoints-标读回包不带每源账目', file: 'lib/endpoints.js',
    from: "return ok({ changed, ...accountOf(target) });\n                }\n                case 'unmarkRead': {",
    to: "return ok({ changed, unread: accountOf(target).unread });\n                }\n                case 'unmarkRead': {" },
  // 客户端这一侧的承重点：回包到手必须**整体覆盖**。退回「只覆盖 unread」= 又用本地那份
  // 看不见全量的账当真相，与上面那条是同一个不变式的两端，各自都要有人看着。
  // from 照**编译产物**的真实形状写：lib/client.js:416-421 的 applyAccount，独立实测 OCCURRENCES=1。
  { id: 'client-标读回包不整体覆盖每源账目', file: 'lib/client.js',
    from: 'unread: account.unread,\n\t\t\t\t\tperFeedUnread: account.perFeedUnread',
    to: 'unread: account.unread' },
  // ⑨ 域 global 槽的 schema 必须拒绝 null。放宽它 ⇒ 存进去的 null 与「从未写过」不可区分，
  //    重开后静默变回 initial（spec.d.ts:83-89 记的那条 round-trip 缺陷）。defineDomain 的
  //    运行时检查会同时炸，所以这条变异下那次 open 直接抛错、用例翻红。
  { id: 'persist-global schema 接受 null', file: 'lib/domain.js',
    from: 'schema: z.unknown().refine((value) => value !== null),',
    to: 'schema: z.unknown(),' },
  // 过滤行的点亮条件（2026-10-10，两轮用户实测反馈合并）：
  //  ① 选源后**仍在生效**的过滤（未读/星标）必须继续点亮，否则读者以为过滤被清掉了，
  //     而右栏其实还在按它过滤 —— 功能与指示脱节，最难自察的一类；
  //  ② 三个标签必须**同等对待**：曾为 'all' 单独开过一个「不点亮」的口子，
  //     用户一眼当成 bug（两个亮、一个不亮）。一致性优先于省一次高亮。
  // 这条变异给 'all' 重新加上那个例外，①② 会同时被它守住。
  { id: 'client-过滤行对 all 特殊对待（三个标签不一致）', file: 'lib/client.js',
    from: 'const selected = filter === view.key;',
    to: 'const selected = filter === view.key && filter !== "all";' },
  // 失败标记必须只反映**最近一次**结果（2026-10-10 用户实测：横幅一直写「月光博客（HTTP 502）」，
  // 而日志里该源连续十几次都是 not-modified —— 502 只出现过一次、之后一路成功）。
  // 变异把 lastFailure 塞回 304 分支的写回对象：一旦恢复「展开 previous」的写法，标记就再没人清。
  { id: 'refresh-304 成功不残留上次失败标记', file: 'lib/refresh.js',
    from: 'url: feedId,\n            title: previous?.title,',
    to: 'url: feedId,\n            lastFailure: previous?.lastFailure,\n            title: previous?.title,' },
  // 正文写入必须**合并进当前记录**（2026-10-10 用户实测：详情页逐篇读，已读状态丢失）。
  // 退回「用抓取前的快照整体写回」会把窗口期内并发 markRead 写进去的 readAt 抹掉 —— 丢失更新。
  // 判据：tests/article-markread-race.test.mjs（并发 markRead + 正文写入，断言 readAt 存活）。
  { id: 'article-用旧快照整体写回覆盖并发写入', file: 'lib/endpoints.js',
    from: 'await target.updateItem(itemId, (current) => ({ ...current, articleFailure: fetched.reason }));',
    to: 'await target.saveItem(itemId, { ...existing, articleFailure: fetched.reason });' },
  // 刷新期间的写同样必须合并进当前记录（2026-10-10 与 article 端点同类）：
  // 抓取/淘汰是长任务，期间用户完全可能标已读、加星；用快照整体写回会静默抹掉这些用户数据。
  // 判据：tests/refresh.test.mjs 的两条「并发标已读」用例（各自注入一次窗口内并发写）。
  { id: 'refresh-缓存淘汰用旧快照覆盖并发写入', file: 'lib/refresh.js',
    from: "await store.updateItem(itemId, (current) => rebuildItem(current, { omit: ['article', 'articleFailure'] }));",
    to: "await store.saveItem(itemId, rebuildItem(store.item(itemId), { omit: ['article', 'articleFailure'] }));" },
  { id: 'refresh-正文回填用旧快照覆盖并发写入', file: 'lib/refresh.js',
    from: "await store.updateItem(itemId, (current) => ({ ...current, summary }));",
    to: "await store.saveItem(itemId, { ...store.item(itemId), summary });" },
  // ── 快捷键帮助浮窗（2026-10-10）──────────────────────────────────────────────
  // 病象：头部一行塞满键位（读者记不住、界面也挤），而它必须与 keys.ts 逐字同步，
  // 同步只靠人记 —— 本仓库为「标签与实现各说各话」付过两次学费。
  // 修法：提示行收进「?」浮窗，浮窗内容逐行渲染 src/keys.ts 的 READER_KEY_HELP（唯一来源）。
  // 这五条各守一个**独立**的失效面，缺一条就退回某种「按了没反应」：
  //   ① 键位层：? 解析成 help（否则浮窗再无键盘入口）
  //   ② 接线层：解析对了但 client 没接 —— 本仓库反复踩到的形态
  //   ③ 优先级：帮助开着时 Esc 必须先关浮窗（否则正文页按 Esc 会「浮窗与文章一起消失」）
  //   ④ 角色：浮窗若标成 dialog，面板自己的按键守卫会把从浮窗内发出的键全吞掉（含 Esc）
  //   ⑤ 依赖数组：helpOpen 不进依赖 ⇒ 闭包读到注册那一刻的 false ⇒ 症状同 ③ 但根因不同
  // 判据：tests/keys.test.mjs 的「? 是快捷键帮助」「帮助表逐条反查」「帮助表反向覆盖」；
  // tests/scroll-dom.test.mjs 的「? 开合帮助浮窗」「Esc 关浮窗且不穿透」「✕ 关闭；焦点落在浮窗里…」。
  // 每条 from 均照**编译产物的真实形状**写（docs/pitfalls.md 一、1.4），并已独立核对出现次数。
  { id: 'keys-? 不认帮助键', file: 'lib/keys.js',
    // lib/keys.js:65，产物里唯一一处。
    from: "case '?': return 'help';",
    to: "case '?': return 'none';" },
  { id: 'client-? 不接浮窗', file: 'lib/client.js',
    // lib/client.js:2470-2471。删掉 run(...) 之后 ? 既不 preventDefault 也不开浮窗 ——
    // 「被吞掉」与「毫无反应」是两种不同的病，都由这条变异造出来。
    from: 'run(() => setHelpOpen((open) => !open));',
    to: 'run(() => {});' },
  { id: 'client-Esc 不先关浮窗', file: 'lib/client.js',
    // lib/client.js:2491，唯一一处。改坏后：开着浮窗按 Esc 会去关文章，浮窗留在屏幕上。
    from: 'if (helpOpen) {',
    to: 'if (false) {' },
  { id: 'client-浮窗标成 dialog 角色', file: 'lib/client.js',
    // lib/client.js:2269，唯一一处。isTypingTarget 会把 [role=dialog] 内的按键全吞掉（含 Esc）——
    // 鼠标点过一次 ✕ 之后，? 与 Esc 双双失效。判据是「✕ 关闭；焦点落在浮窗里之后…」那条用例。
    from: 'role: "region",',
    to: 'role: "dialog",' },
  { id: 'client-helpOpen 不进依赖数组', file: 'lib/client.js',
    // lib/client.js:2534-2538。少了 helpOpen，按键处理器读到的永远是注册那一刻的 false：
    // 浮窗开着按 Esc → 走「关文章」分支，浮窗留在屏幕上（与上面第三条同一个病象、不同根因）。
    from: '\t\t\t\t\troot,\n\t\t\t\t\tstore,\n\t\t\t\t\thelpOpen',
    to: '\t\t\t\t\troot,\n\t\t\t\t\tstore' },
  // ── 自持存储骨架（2026-10-11 大规模存储任务 2）─────────────────────────────────
  // 这三个模块是「下次装载还能不能读到用户数据」的全部承重点，而它们的失效**全都安静**：
  // 版本闸写错 ⇒ 好库被当成坏库拒掉，界面表现是「重启之后订阅全没了」；
  // 订阅文件的版本闸失效 ⇒ 认不出的格式被硬按 v1 解释；目录权限放宽 ⇒ 数据目录变成全机可读。
  // 三条 from 均照**编译产物的真实形状**写（docs/pitfalls.md 一、1.4），并已独立实测 OCCURRENCES=1。
  { id: 'storage-版本闸把好库一起拒了', file: 'lib/storage/db.js',
    // 删掉「且不是当前版本」这半边后，闸变成「非 0 即拒」⇒ **已经迁移好的库第二次装载就打不开**。
    // 判据：tests/storage-skeleton.test.mjs 的「openDatabase 能重开已经建好的库」。
    from: 'if (onDisk !== 0 && onDisk !== SCHEMA_VERSION) {',
    to: 'if (onDisk !== 0) {' },
  { id: 'storage-订阅文件版本闸失效', file: 'lib/storage/config-file.js',
    // 版本不认时必须响亮失败（未来格式硬按 v1 解释会丢掉本版不认识的字段）。
    // 判据：tests/storage-skeleton.test.mjs 的「readConfigFile 对损坏/形状不对/版本不认的 config.json 一律抛错」。
    from: 'if (record.version !== CURRENT_CONFIG_VERSION) {',
    to: 'if (false) {' },
  { id: 'storage-目录权限放宽到 0777', file: 'lib/storage/paths.js',
    // 库里是用户的订阅与已读态；权限放宽后同机其他账户可读，而这一点在界面上完全不可见。
    // 判据：tests/storage-skeleton.test.mjs 的「ensureStorageRoot 递归建出 0700 目录」。
    from: 'mkdirSync(root, { recursive: true, mode: 0o700 });',
    to: 'mkdirSync(root, { recursive: true, mode: 0o777 });' },
]

function runSuite() {
  try {
    const out = execSync('node --test tests/*.test.mjs 2>&1', { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
    return { ok: true, out: out }
  } catch (error) {
    return { ok: false, out: String(error.stdout || '') + String(error.stderr || '') }
  }
}

const baseline = runSuite()
if (!baseline.ok) {
  console.error('基线不是绿的 —— 先修好再跑变异。')
  console.error(baseline.out.split('\n').filter((l) => /^\s*(✖|not ok)/.test(l)).slice(0, 5).join('\n'))
  process.exit(2)
}
console.log('基线绿。逐条改坏关键判定，看套件是否见红：')
console.log('')

const backups = new Map()
for (const path of new Set(MUTATIONS.map((m) => ROOT + '/' + m.file))) backups.set(path, readFileSync(path, 'utf8'))

const survivors = []
let applied = 0
for (const m of MUTATIONS) {
  const path = ROOT + '/' + m.file
  const original = backups.get(path)
  const mutated = original.replace(m.from, m.to)
  if (mutated === original) {
    console.log('  ?  ' + m.id.padEnd(26) + ' 未应用（产物里形状与预期不符，请同步更新本条）')
    survivors.push(m.id + '（未应用）')
    continue
  }
  applied += 1
  writeFileSync(path, mutated)
  let res
  try { res = runSuite() } finally { writeFileSync(path, original) }
  const fails = res.out.split('\n').filter((l) => /^\s*✖/.test(l)).map((l) => l.trim().replace(/\s*\(\d.*$/, ''))
  if (res.ok) {
    console.log('  x  ' + m.id.padEnd(26) + ' 幸存（套件仍然全绿）')
    survivors.push(m.id)
  } else {
    console.log('  v  ' + m.id.padEnd(26) + ' 被抓到（' + fails.length + ' 条翻红：' + (fails[0] || '').slice(0, 44) + '）')
  }
}

const after = runSuite()
console.log('')
console.log('应用 ' + applied + '/' + MUTATIONS.length + ' 条 · 幸存 ' + survivors.length + ' 条 · 恢复后基线 ' + (after.ok ? '仍然绿' : '没恢复干净！'))
if (survivors.length > 0) {
  console.error('幸存清单：' + survivors.join('、'))
  console.error('-> 这些都是测试没覆盖到的判定：补一条会翻红的断言，或确认它是等价变异。')
  process.exit(1)
}
console.log('全部被抓到。')
