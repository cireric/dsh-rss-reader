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
  // 上限守卫（2026-10-11 修复轮 1 重写）：守卫已从 `maxChars <= 0` 改成 `!(maxChars > 0)`，
  // 为的是把 NaN 一起挡在外面 —— 挡住「整个清单」的那条与挡 NaN 的那条是同一处代码，分成两条变异。
  // ① 去掉「上限非法」这半 ⇒ 上限 0 / 负数会被当成「必须清到 0 字符」，把全部缓存清空。
  { id: 'retention-非法上限保护', file: 'lib/retention.js',
    // from 照**编译产物**的实际形状写（docs/pitfalls.md 一、1.4）：lib/retention.js:47，独立实测 OCCURRENCES=1。
    from: 'if (!(maxChars > 0) || total <= maxChars)',
    to: 'if (total <= maxChars)' },
  // ② 把 `!(maxChars > 0)` 退回成 `maxChars <= 0` ⇒ NaN 穿过守卫（NaN <= 0 为 false），
  //   而 `total <= NaN` 同样是 false ⇒ 判定一路走进淘汰循环，**清空全部条目**。
  //   Task 9 把闸门从单源改成全库之后，同一个洞的爆炸半径从一个源变成了整库。
  //   非等价变异：NaN 下旧守卫返回整份淘汰名单，新守卫返回空。
  { id: 'retention-NaN 上限不得清空', file: 'lib/retention.js',
    from: 'if (!(maxChars > 0) || total <= maxChars)',
    to: 'if (maxChars <= 0 || total <= maxChars)' },
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
  // 闸门必须认**现行**的 blocks 形态（2026-07 事故：只统计 paragraphs ⇒ 字符数恒为 0 ⇒ 闸门永不触发）。
  // ⚠️ 2026-10-11 修复轮 1 改写锚点：字符计数已随「清算原料」一起搬进 store-sqlite 的
  // articleCharsFromBody（原锚 `chars: articleCharsOf(record.article),` 已从 lib/refresh.js
  // 消失 ⇒ 报「未应用」；docs/pitfalls.md 二、2.7：未应用比幸存更隐蔽，因为它等于这条根本没跑）。
  // 语义不变，仍是「退回只数 paragraphs」。from 照**编译产物**的实际形状写（pitfalls 一、1.4）：
  // lib/store-sqlite.js:296，独立实测 OCCURRENCES=1。
  { id: 'refresh-缓存闸门认 blocks', file: 'lib/store-sqlite.js',
    from: "if (typeof fields['text'] === 'string') {",
    to: "if (false) {" },
  // 全局预算的承重点（2026-10-11 任务 9）：这份名单必须覆盖**全库**。
  // 退回成「只看一个源」（等价于把它改回 2026-10-11 之前的逐源闸门）⇒ 200 源各有 8M 字符的名额，
  // 上限形同虚设；而每个源单独看又都没超自己的份额，连「哪一源超了」都判不出来。
  // 判据由 tests/refresh.test.mjs 的「全局预算：每源都没超上限，但合计超了 ⇒ 必须跨源清」看着
  // （实测：三个源各 1000 字符、上限 1500，旧实现三条全留 = 3 ≠ 1）。
  // ⚠️ from 照**编译产物**的实际形状写（docs/pitfalls.md 一、1.4）：lib/refresh.js:79 的
  // `const entries = store.listArticleCacheEntries();` 独立实测 OCCURRENCES=1。
  // ⚠️ 2026-10-11 修复轮 1 改写锚点：闸门已改走 store 的清算原料方法（原锚 `store.allItems()`
  // 随那轮改动从产物里消失 ⇒ 原锚会变「未应用」，比幸存更隐蔽）。语义不变，仍是**退回单源**。
  //
  // ⚠️⚠️ **修复轮 2：这一行曾经是假通过（2026-10-11，评审抓出）**
  //   当时的 `to` 写了 `urls[0]` —— 而 `urls` 是 `refreshFeeds` 的参数，**不在 `capArticleCache`
  //   的作用域里**（实测 lib/refresh.js：该函数签名是 `async function capArticleCache(store, maxChars)`）。
  //   于是变异抛 `ReferenceError: urls is not defined`：门槛照样报「应用」+「被抓到」、幸存者仍是 0，
  //   **但没有一条断言真的看见了「按源名单」**（实测：7 条翻红里 7 条都是同一个 ReferenceError）。
  //   ⇒ **崩溃式失败不是被抓住**：它把缺陷复现换成了「模块起不来」，门槛分辨不出来。
  //   修法：只用 `capArticleCache` 作用域内**确实存在**的东西重造「按源名单」——`store` 在参数里，
  //   所以 `store.listFeeds()[0]?.[0]` 取第一个源再按 feedId 过滤。
  //   实测：`ℹ fail 2`（恰是那两条跨源用例）、`ReferenceError` 出现 0 次。
  //   **给下一个改这一行的人**：改完必须在隔离副本里跑，并**逐条看翻红的是哪几条**；
  //   只要输出里出现 ReferenceError / SyntaxError，一律不算抓住（docs/pitfalls.md 二、2.7b）。
  { id: 'refresh-正文闸门退回单源', file: 'lib/refresh.js',
    from: 'const entries = store.listArticleCacheEntries();',
    to: "const entries = store.listArticleCacheEntries().filter((entry) => store.item(entry.id)?.feedId === store.listFeeds()[0]?.[0])" },
  // 同一处代码的第二条承重点：**必须走只交出 { id, chars, fetchedAt } 的那条取数路径**。
  // 退回「把整表读出来再挑出带正文的」会把每份正文都解出来留在堆里 —— 实测 10 万条 × 8.8 KB
  // 时堆峰值 1865 MB，而 spec §9.3 的验收线是 ≤ 300 MB（超 6.2 倍）。这条守的是**内存契约**：
  // 淘汰名单两条路径算出来一样，所以纯行为断言看不见它，得从取数方式上钉。
  // ⚠️ `to` 里只用产物**已经 import 过**的 articleCharsOf —— 照源码写一个产物里没有的名字，
  // 变异的失败模式会从「缺陷复现」退化成「加载失败」，那不是被抓住（docs/pitfalls.md 二、2.7）。
  { id: 'refresh-正文闸门改走整表', file: 'lib/refresh.js',
    from: 'const entries = store.listArticleCacheEntries();',
    to: 'const entries = store.allItems().filter(([, record]) => record.article !== undefined).map(([id, record]) => ({ id, chars: record.article.paragraphs?.reduce((sum, paragraph) => sum + paragraph.length, 0) ?? 0, fetchedAt: record.article?.fetchedAt ?? \'\' }));' },
  // ── 陈旧度调度（2026-10-11 任务 10）───────────────────────────────────────────
  // 三条各守一处**承重**判定，判据都在 tests/refresh.test.mjs 的新用例里（逐条实测见下）：
  //   ① 排序方向 ⇒ 调度会去抓「最新的那几个」（本任务要修的病象原封不动）
  //   ② 上限守卫 ⇒ 0 / NaN 被当成「必须为空」，即**每一轮一个源都不抓**，全量静默停摆
  //   ③ 接线 ⇒ 挑对了子集却没交给 refreshFeeds，200 源照样一轮全抓（本任务最可能的失效形态）
  // from 一律照**编译产物的实际形状**写（docs/pitfalls.md 一、1.4），OCCURRENCES 均独立实测 = 1。
  // ── 失败源不得饿死健康源（2026-10-11 任务 10 修复轮 1，评审实测抓出的真缺陷）─────────────
  // 这一族守的是**排序键的取值口径**。from 照编译产物形状写、OCCURRENCES 均独立实测 = 1
  // （lib/refresh.js:40 的回落链、:201 的失败分支写入）。
  { id: 'refresh-调度键退回只看成功', file: 'lib/refresh.js',
    // lib/refresh.js:40。这就是**修复前的那份代码**：键退回 lastFetchedAt（= 上次成功）。
    // 永久失败的源永远拿不到它 ⇒ 永远最旧 ⇒ 这类源 ≥ K 个时每轮选中同一批，健康源全停更。
    // 实测 2 条翻红（纯函数复刻 200/20/K=20 与真装配 3 源 / 1 个 500 / K=1），RefErr 0 次。
    from: "    return record.lastAttemptedAt ?? record.lastFetchedAt ?? '';",
    to: "    return record.lastFetchedAt ?? '';" },
  { id: 'refresh-失败的尝试不盖时间', file: 'lib/refresh.js',
    // lib/refresh.js:201（失败分支）。键的口径对了、但失败分支忘了盖时间 —— 两者必须同时成立。
    // ⚠️ 实测**只有 1 条**翻红：真装配那条。纯函数复刻层怎么改都测不到「失败分支有没有盖」，
    // 所以这条变异证明的正是「纯函数层断言不够、必须走真装配」这件事。谁想删掉那条真装配用例，
    // 先看这条变异会不会幸存。
    from: '            lastAttemptedAt: stamp,\n            lastFailure: result.reason,',
    to: '            lastFailure: result.reason,' },
  { id: 'refresh-陈旧度不再回落', file: 'lib/refresh.js',
    // lib/refresh.js:40 的另一半：去掉对 lastFetchedAt 的回落。已有库（Task 2 迁移过来的记录）
    // 只有 lastFetchedAt、没有 lastAttemptedAt ⇒ 去掉回落后它们全被当成「从未尝试过」，
    // 旧订阅会在装载后一次性涌到最前面。非等价变异（老记录与新记录的排序结果不同）。
    // 实测 2 条翻红（陈旧度排序、饥饿不变式），RefErr 0 次。
    from: "    return record.lastAttemptedAt ?? record.lastFetchedAt ?? '';",
    to: "    return record.lastAttemptedAt ?? '';" },
  // ⚠️ 刻意**没有**给 304 分支（:221）与 200 分支（:303）的 lastAttemptedAt 写入各加一条变异：
  // 那两条是**等价变异**。两个成功分支里 lastFetchedAt 与 lastAttemptedAt 盖的是**同一个 stamp**，
  // 删掉 lastAttemptedAt 之后排序键回落到 lastFetchedAt ⇒ 取值逐字相同 ⇒ 没有任何输入会改变结果。
  // 它们幸存不是测试缺口（判定方法见本文件「正文容器收窄」那条的完整推导）。反过来说：
  // **只有失败分支那条写入是不可回落的**（它没有 lastFetchedAt 可回落）—— 判据就在上面。
  { id: 'refresh-陈旧度排序倒退', file: 'lib/refresh.js',
    // lib/refresh.js:71，独立实测 OCCURRENCES=1。排序倒退后取到的是**最新**的 K 个，
    // 而未抓过的源（staleness key = ''，码位最小）从「最前」翻到「最后」⇒ 新建的源再也排不上
    // 第一轮。实测 3 条翻红：陈旧度排序、饥饿不变式、接线（refreshNow 用例）。
    from: 'if (a < b)', to: 'if (a > b)' },
  { id: 'refresh-每轮上限失效', file: 'lib/refresh.js',
    // lib/refresh.js:55，独立实测 OCCURRENCES=1。整条守卫失效后 limit=0/负数/NaN 会一路走进
    // slice(0, 0) ⇒ 返回空列表 ⇒ **每一轮一个源都不抓**（所有源永久停更的那个静默失效）。
    // 实测 1 条翻红（「上限 <= 0 视为未配置」），正是守卫那一条。
    //
    // ⚠️ 刻意**没有**「limit ≥ 源数时返回全部」那条变异：它与本守卫的另一半同处一行，但
    //   是**等价变异**——把这一半去掉后仍走 .slice(0, limit)，而 limit ≥ length 时 slice 本来就
    //   返回全部，没有任何输入会改变结果。它幸存的不是测试缺口（判定先例：本文件
    //   「正文容器收窄」那条的完整推导）。它是快路径，不是行为分支。
    from: 'if (!(limit > 0) || limit >= feeds.length)', to: 'if (false)' },
  { id: 'refresh-取源退回全量', file: 'lib/index.js',
    // lib/index.js:178，独立实测 OCCURRENCES=1。退回「全量交出去」= 本任务要修的病象原样保留
    // （200 源 × 15s ÷ 并发 = 600s 一轮），而 selectStalestFeeds 自身的单测**全绿** ——
    // 这条证明「接线」那一层必须有独立断言看着（挑选对了却没生效是本仓库反复踩到的形态）。
    // 实测 1 条翻红（refreshNow 每轮只抓 K 个）。
    from: 'const subscriptions = selectStalestFeeds(target.listFeeds(), config.refreshFeedsPerRound);',
    to: 'const subscriptions = target.listFeeds().map(([feedId]) => feedId);' },
  { id: 'config-每轮取源默认无界', file: 'lib/config.js',
    // lib/config.js:20，独立实测 OCCURRENCES=1。把默认值改成 0 之后**别的用例全绿** —— 因为
    // selectStalestFeeds 把 0 解读成「未配置 ⇒ 抓全部」（那是安全侧），于是「一轮 600s」这条
    // 缺陷就借默认值回来了，而且没有任何断言会喊。这正是本任务最容易被回退的形态，所以
    // 单独拿 tests/refresh.test.mjs 的「默认值必须是个具体条数」看着它。
    from: 'refreshFeedsPerRound: z.number().default(20)',
    to: 'refreshFeedsPerRound: z.number().default(0)' },
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
    // ⚠️ `to` 必须**保留展开运算符**：2026-10-11 终检评审 B1 修好分类器后，这条被当场抓成
    //   「崩了（SyntaxError）」—— 它原先写成不带 `...` 的对象字面量，而在对象字面量里少一个 `...`
    //   会让那对花括号被解析成**块语句** ⇒ 产物**加载期**就语法错、整个 client 组一起红。
    //   **那正是这个分类器要堵的假通过**：崩了被当成「抓到」，而没有任何断言真的看见「角标无视
    //   showUnread」。补回 `...` 后红条数才代表这条变异的本义（实测 3 条翻红）。
    from: '...showUnread ? { "data-rss-nav-badge": String(unread) } : {},',
    to: '...{ "data-rss-nav-badge": String(unread) },' },
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
  // texts.fetched_at 的 NOT NULL（2026-10-11 终检评审 C1）：DDL 漏掉这个约束时读侧三处都走
  // `requiredText(row.article_fetched_at, ...)`，一条 NULL 行会让 item / listItems / allItems
  // **同时**抛。本版自己的写入口写不出 NULL（articleRecordSchema.fetchedAt 必填），所以这条
  // 是「不可达但可能」的那类守卫 —— 判据不能是行为断言（喂不进 NULL），只能是声明。
  // 判据：tests/storage-skeleton.test.mjs 与 tests/store-sqlite.test.mjs 的「texts.fetched_at
  // 声明 NOT NULL」，前者查 PRAGMA、后者断言直插 NULL 必须抛。
  // ⚠️ from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4）：lib/storage/db.js 里
  // `fetched_at TEXT NOT NULL\n  );` 独立实测 OCCURRENCES=1。
  { id: 'storage-正文抓取时间可空', file: 'lib/storage/db.js',
    from: 'fetched_at TEXT NOT NULL',
    to: 'fetched_at TEXT' },
  // ── SQLite 版 ReaderStore（2026-10-11 大规模存储任务 3）───────────────────────────
  // 这一族是「换实现之后，旧实现的每一条承诺是否还在」的承重点，而它们的失效大半**安静**：
  // 列表顺序变了、并发已读被抹掉、正文被级联删掉 —— 界面上都只是「好像少了点什么」。
  // 每条 from 均照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4），
  // 并已独立实测 OCCURRENCES=1（在 /tmp 隔离副本里跑过一轮：11/11 全部被抓到）。
  { id: 'store-listItems 退回 JS 全表过滤', file: 'lib/store-sqlite.js',
    // 这是**扫描族的结构性修复**（spec §3.1）：退回「读全表再在 JS 里过滤」后行为完全一样，
    // 只有 SQL 的形状变了 —— 所以判据是 tests/store-sqlite.test.mjs 里录 prepared SQL 的那条。
    from: 'listItems: (feedId) => sql(SELECT_ITEM_BY_FEED).all(feedId).map((row) => {',
    to: 'listItems: (feedId) => sql(SELECT_ALL_ITEMS).all().map((row) => {' },
  { id: 'store-排序退回 published_at', file: 'lib/store-sqlite.js',
    // publishedAt 是可选字段：直接对它排序会让缺发布时间的条目落进 SQL 的 NULL 段
    // （SQLite 中 NULL 最小），列表顺序与迁移前不一致（Review Focus 2）。
    // 判据：tests/store-sqlite.test.mjs 的「缺 publishedAt 的行按 fetchedAt 归位」。
    from: "const ITEM_ORDER = ' ORDER BY i.recency DESC, i.id ASC';",
    to: "const ITEM_ORDER = ' ORDER BY i.published_at DESC, i.id ASC';" },
  { id: 'store-updateItem 抹掉并发已读态', file: 'lib/store-sqlite.js',
    // 这条守的是**接口存在的理由**（src/store.ts:21-31）：fn 算出的记录被原地覆盖时若丢了
    // 窗口期内并发写进去的 readAt，表现就是 2026-10-10 用户实测的「详情页逐篇读，已读状态丢失」。
    // 判据：tests/store-sqlite.test.mjs 的「原子读改写」那条。
    from: 'const next = itemRecordSchema.parse(fn(toItemRecord(row)));',
    to: 'const next = itemRecordSchema.parse({ ...fn(toItemRecord(row)), readAt: undefined });' },
  { id: 'store-updateItem 缺失键顺手创建', file: 'lib/store-sqlite.js',
    // 「写一次就等于创建」会让调用方失去「这条还在不在」的信号（src/store.ts:29）。
    // 判据：tests/store-sqlite.test.mjs 的「对缺失键拒绝」那条。
    from: "throw new Error('updateItem 拒绝：条目 ' + itemId + ' 不在库里。",
    to: "sql(UPSERT_ITEM).run(itemId, itemId, '', '', null, '2026-10-11T00:00:00.000Z', null, null, 0, 0, null); return; throw new Error('updateItem 拒绝：条目 ' + itemId + ' 不在库里。" },
  // ⚠️ **两条「本该有」的变异实测是等价变异，按 AGENTS.md 不入门槛**（2026-10-11 差分实测）：
  //
  // ① 「写条目改用 INSERT OR REPLACE」：REPLACE 会先删旧行、触发 texts 的 ON DELETE CASCADE，
  //    看着必然丢正文 —— 但 `writeItem` 在同一事务里紧接着调 `writeArticle`，正文当场写回。
  // ② 「deleteItem 只删 items、不删 texts」：`PRAGMA foreign_keys` 实测为 1，级联已代劳。
  //
  // 判据是**差分实验**：9 步操作序列（写带正文 → 覆写不带 → 再写带 → 两次 update → 两次 delete
  // → 另一条 save+update），逐条比对可观测状态（store 读回的记录 + items/texts 行数），
  // 三种实现（ON CONFLICT / INSERT OR REPLACE / 只删 items）的输出**逐字节相同**。
  // 它们幸存不是测试缺口 —— 与「正文容器收窄」那条同一个判定方法（见本文件顶部注释）。
  // 判据测试仍在（tests/store-sqlite.test.mjs 的正文级联与孤儿两条），只是它们无法区分这三种写法。
  { id: 'store-版本握手失效', file: 'lib/store-sqlite.js',
    // 顺序颠倒（先建 store、后 migrateSchema）若不在构造时拦下，症状是「插件装载成功、
    // 第一次刷新才失败」——那时用户已经白等了一轮网络。
    // 判据：tests/store-sqlite.test.mjs 的「没盖章的库当场响亮失败」。
    from: 'if (onDisk !== SCHEMA_VERSION) {',
    to: 'if (false) {' },
  { id: 'store-读偏好不校验形状', file: 'lib/store-sqlite.js',
    // src/store.ts:41-45 的承诺是「返回的保证是可信形状」；不校验就把媒介里的垃圾透给调用方去兜。
    // 判据：tests/store-sqlite.test.mjs 的「坏值逐字段回落」。
    from: 'viewPreferences: () => sanitizeViewPreferences(readConfigFile(configPath).viewPreferences, isKnownFeed),',
    to: 'viewPreferences: () => readConfigFile(configPath).viewPreferences,' },
  { id: 'store-写偏好覆盖掉订阅映射', file: 'lib/store-sqlite.js',
    // config.json 是用户订阅的**唯一**可备份副本：写偏好时若不先把旧文件读出来，
    // 一次「切了个 filter」就会把订阅列表清空 —— 且不抛错、不留痕。
    // 判据：tests/store-sqlite.test.mjs 的「写偏好不许动订阅映射」。
    from: 'const current = readConfigFile(configPath);\n            writeConfigFile(configPath, { ...current, viewPreferences: safe });',
    to: 'writeConfigFile(configPath, { feeds: {}, version: 1, viewPreferences: safe });' },
  { id: 'store-缺席字段写成 undefined 键', file: 'lib/store-sqlite.js',
    // readAt === undefined 是本仓库对「未读」的定义（src/shared.ts:62）。多一个 undefined 值
    // 的键会让 .strict() 的读侧校验与 isUnread 同时失准 —— 「所有条目看起来都没读过」。
    // 判据：tests/store-sqlite.test.mjs 的「可选字段缺席时不留 null / undefined 键」。
    // ⚠️ from 必须**连 if 一起**纳入：只改 `record.readAt = readAt;` 那一行的话，替换出来的是
    // `if (x) if (x) a; else b;` —— 内层 else 永远轮不到执行，等于什么都没改（第一版就是这么写的，
    // 它「幸存」是**变异没生效**，不是测试缺口；docs/pitfalls.md 二、2.7 记的正是这类坑）。
    from: 'if (readAt !== undefined)\n        record.readAt = readAt;',
    to: 'record.readAt = readAt;' },
  { id: 'store-deleteFeed 先删游标后写 config', file: 'lib/store-sqlite.js',
    // 退订要动**两处介质**：config.json（文件）与 cursors（库）。它们没有共同事务，
    // 中间失败无法一起回滚 —— 所以「先做哪一步」本身就是正确性，不是风格。
    // 反过来（先删游标）时，config 写不进去（文件损坏 / 磁盘满）会留下「源还在订阅列表里、
    // 游标却没了」：下一轮刷新把整份 feed 当新内容重新导入，用户看到的是已读条目**集体变未读**。
    // 这个顺序最坏只是一条孤儿游标，无害。
    // 判据：tests/store-sqlite.test.mjs 的「deleteFeed 先写 config、后删游标」——
    // 它把 configPath 指成一个目录让写入必失败，再断言**游标仍在**；顺序调换后那条当场翻红。
    // from 照**编译产物**逐字抄，已独立核对 OCCURRENCES=1（docs/pitfalls.md 一、1.4）。
    from: [
      '            writeFeeds(configPath, (feeds) => {',
      '                const next = { ...feeds };',
      '                delete next[feedId];',
      '                return next;',
      '            });',
      '            runInTransaction(() => {',
      '                sql(DELETE_CURSOR).run(feedId);',
      '            });',
    ].join('\n'),
    to: [
      '            runInTransaction(() => {',
      '                sql(DELETE_CURSOR).run(feedId);',
      '            });',
      '            writeFeeds(configPath, (feeds) => {',
      '                const next = { ...feeds };',
      '                delete next[feedId];',
      '                return next;',
      '            });',
    ].join('\n') },
  { id: 'store-老形态正文静默丢正文', file: 'lib/store-sqlite.js',
    // 库里没有存 paragraphs 的列。放开这道闸后，一条「只有 paragraphs、没有 blocks」的老记录会被
    // **当成长度为零的新记录**写下去：items 行落库、正文行被删掉，用户在详情页看到正文凭空消失，
    // 而测试若只断言「写入没抛错」就全绿。转换口径只有 domain.ts 的 normalizeLegacyArticle 一处。
    // 判据：tests/store-sqlite.test.mjs 的「拒绝写入老形态正文」。
    from: 'if (article !== undefined && article.blocks === undefined && article.paragraphs !== undefined) {\n            throw new Error(',
    to: 'if (false) {\n            throw new Error(' },
  { id: 'store-正文 fetchedAt 不落列', file: 'lib/store-sqlite.js',
    // article.fetchedAt 是 refresh.ts:118 的正文缓存淘汰排序键，缺了整表退化成不可判。
    // 判据：tests/store-sqlite.test.mjs 的「item 把 texts 的正文按 blocks 还原」。
    from: 'article.title ?? null, article.fetchedAt);',
    to: 'article.title ?? null, null);' },
  // ── 一次性迁移（2026-10-11 大规模存储任务 4，cutover）────────────────────────────
  // 迁移是**单向门**：跑完之后插件只认自持存储，而老文件是用户订阅在 config.json 之外的
  // 唯一副本。这五条的失效大半**安静** —— 最坏的一条（认不出就当没有）会让用户看到
  // 「订阅全没了」而套件全绿，所以它们必须各自有人看着。
  // 每条 from 均照**编译产物** lib/storage/migrate.js 的真实形状逐字抄，
  // 并已独立核对 OCCURRENCES=1（docs/pitfalls.md 一、1.4）。
  { id: 'migrate-已迁移仍重放老文件', file: 'lib/storage/migrate.js',
    // 闸门一失效 ⇒ config.json 已经在了还去拿老文件覆盖一遍。判据不是「重复行」（id 是主键，
    // upsert 看不出重复），而是 tests/migrate.test.mjs 的「config.json 写不进去时…」那条：
    // 库里那 3 行、订阅映射都会被一份旧的老文件回退。
    from: '    if (configAlreadyMigrated(configPath)) {',
    to: '    if (false) {' },
  { id: 'migrate-中断后重放条目', file: 'lib/storage/migrate.js',
    // 闸门二失效 ⇒ 「库提交了、config.json 没写成」的中断被当成首次迁移，整份老文件重放一遍：
    // 用户在这之后退订的源、清理掉的条目全部复活，且**没有任何断言会翻红**（除非有这个用例）。
    // 判据：tests/migrate.test.mjs 的「中断后重入：…只补配置，不重放条目」。
    from: '    if (existingItems > 0) {',
    to: '    if (false) {' },
  { id: 'migrate-读不出来当成首次安装', file: 'lib/storage/migrate.js',
    // Review Focus 1 的**缺陷本体**：只认「文件不存在」是首装，其余读失败（EISDIR / EACCES /
    // 越过 512 MiB 字符串墙 / 损坏）一律响亮抛错。放开之后，一次读取失败会静静建出一个空库 ——
    // 那在用户眼里就是「我的订阅全没了」。
    // 判据：tests/migrate.test.mjs 的「域文件读不出来（路径是目录）⇒ 抛错」与「域文件损坏」两条。
    from: '        if (errnoOf(error) === \'ENOENT\')\n            return undefined;',
    to: '        return undefined;' },
  { id: 'migrate-老正文形态不折成 blocks', file: 'lib/storage/migrate.js',
    // 库里没有存 paragraphs 的列。少了这一步，第一条老形态记录会让 store 当场拒绝整份迁移
    // （响亮，可接受）；真正危险的是有人反过来「修」成「当没有正文」—— 那用户在详情页看到的
    // 就是正文凭空消失。这里钉的是「必须过 normalizeLegacyArticle」这个位置本身。
    // 判据：tests/migrate.test.mjs 的「从域文件导入…」那条（含 i-3 老形态夹具）。
    from: 'normalizeLegacyArticle(record),',
    to: 'record,' },
  { id: 'migrate-不校验域名', file: 'lib/storage/migrate.js',
    // 别人的域文件形状完全不同（session_projcache / workspace …）。不校验就按本插件的形状
    // 解释它，等于把无关字段搬进用户的订阅库，且**没有任何断言会翻红**（除非有这个用例）。
    // 判据：tests/migrate.test.mjs 的「域文件不是本插件的（unit.name 不匹配）⇒ 抛错」。
    from: '    if (unit.name !== DOMAIN_NAME) {',
    to: '    if (false) {' },
  { id: `migrate-读不出来的 config 冒充已迁移`, file: `lib/storage/migrate.js`,
    // 收窄前的旧口径：路径上有东西就算「已迁移」。EACCES / EISDIR / ELOOP / EIO 于是全部
    // 冒充成「迁移过了」，一份**尚未迁移**的库被静默跳过，而消息说「config.json 已存在」——
    // 把人引向错误的排查方向。与 readLegacy 的口径必须一致：只有 ENOENT 算「没有」。
    // 判据：tests/migrate.test.mjs 的「config.json 路径存在但读不出来（EISDIR）⇒ 抛错」。
    from: [
      "        throw new Error('读取订阅文件 ' + path + ' 失败（它既不可读、也不表示「尚未迁移」，无法判断是否已迁移；' +",
      "            '已保留原文件，未做任何写入）：' + String(error), { cause: error });",
    ].join(String.fromCharCode(10)),
    to: '        return true;' },
  // ── 未读记账与列表取数改 SQL（2026-10-11 大规模存储任务 5）────────────────────────
  // 这一族的失效大半**安静**：账目少算一个源、0 未读的源丢键、清理多删了用户说「别动它」的条目
  // —— 界面上分别是「角标空白」「星标/保持未读的条目凭空消失」，都不报错。
  // 每条 from 均照**编译产物** lib/store-sqlite.js 的真实形状逐字抄，并已独立核对
  // OCCURRENCES=1（docs/pitfalls.md 一、1.4）。
  { id: 'unreadPerFeed-SQL 判据反过来', file: 'lib/store-sqlite.js',
    // 未读判据一旦写反（read_at IS NOT NULL），账目就变成「已读数」——而它与「各源之和 === 总未读」
    // 的关系看着仍然自洽（两边一起错），所以只有那条**与 shared.ts 逐键对账**的用例能抓到它。
    // 判据：tests/store-sqlite.test.mjs 的「unreadPerFeed：与 shared.ts 的唯一口径…逐键相等」。
    from: "const SELECT_UNREAD_PER_FEED = 'SELECT feed_id AS feed_id, COUNT(*) AS unread FROM items WHERE read_at IS NULL GROUP BY feed_id';",
    to: "const SELECT_UNREAD_PER_FEED = 'SELECT feed_id AS feed_id, COUNT(*) AS unread FROM items WHERE read_at IS NOT NULL GROUP BY feed_id';" },
  { id: 'unreadPerFeed-丢键域（0 未读的源不留键）', file: 'lib/store-sqlite.js',
    // 这是本仓库栽过两次的那条（任务 1 的键域、任务 5 的口径）：删掉「先按传进来的键铺 0」之后，
    // 只有**有未读的源**才留键，左栏那一行渲染出来是「角标空白」而不是「角标 0」——
    // 与「角标 0」在界面上无从分辨，是最贵的那类沉默失败。判据是 tests/unread-accounting.test.mjs
    // 的「标空之后 A 的键必须还在」与 tests/overview-scale.test.mjs 的键集断言。
    from: 'unread[feedId] = 0;',
    to: ';' },
  { id: 'cleanup-保持未读不再受保护', file: 'lib/store-sqlite.js',
    // 用户对 kept-unread 说的是「别动它」，与星标同级（store.ts 的 listCleanupCandidates 契约）。
    // 谓词里少了它，清理会**静默删掉**用户明确标了「保持未读」的条目 —— 不可逆的数据丢失。
    // 判据：tests/overview-scale.test.mjs 的「old-0-1 必须活下来」+ tests/store-sqlite.test.mjs 的候选集对账。
    from: 'AND i.kept_unread = 0',
    to: 'AND i.kept_unread >= 0' },
  { id: 'cleanup-星标不再受保护', file: 'lib/store-sqlite.js',
    // 星标是用户明确要留的东西（retention.ts 的 selectCleanup 也钉着它）。谓词里少了它，
    // 一次「清理」会把星标旧条目一起删掉，且**没有任何断言会翻红**（除非有这条）。
    from: 'AND i.starred = 0',
    to: 'AND i.starred >= 0' },
  { id: 'listRecent-负数上限下传给 SQLite', file: 'lib/store-sqlite.js',
    // SQLite 把 LIMIT -1 当「无上限」。删掉 JS 侧短路后，「取 300 条」在一处算错成负数时
    // 会静默变成「读回整表」——结果看着还挺对，只有耗时爆炸。
    // 判据：tests/store-sqlite.test.mjs 的「listRecent：… 负数上限 ⇒ 空列表」。
    from: 'if (limit <= 0)\n                return [];',
    to: 'if (false)\n                return [];' },
  // 列表窗口的「放大重取」（Task 5 自审发现）：残留行（退订后没清干净 / 手工改库）会先被取回来、
  // 再因为「所属源已退订」被挡掉，而它们**已经占掉了窗口**。少了这一步，右栏会静默少几条。
  // 判据：tests/endpoints-perfeed-unread.test.mjs 的「已退订源的残留条目…不许把列表的截断窗口占掉」。
  { id: 'overview-列表窗口不再放大重取', file: 'lib/endpoints.js',
    // 首轮取回的 5 条里 4 条是残留行 ⇒ 列表只剩 1 条，而用户看不出少在哪（原实现是先滤后截，不会少）。
    // ⚠️ 2026-10-11 任务 6：取数循环重写（多取一行以判断「后面还有没有」），原锚串消失 ⇒ 本条
    // 改锚到新产物的同一处判定（window 不再放大 = 残留行会被当成「已到底」）。
    from: 'exhausted = rows.length <= window;',
    to: 'exhausted = true;',
  },
  // ── 列表分页 keyset + 客户端契约（2026-10-11 大规模存储任务 6）────────────────────
  // 病象：overview 一次只回 maxItemsShown（默认 300）条且没有续页入口 ⇒ 10 万行下第 301 条之后
  // 在界面上**永远到不了**。这一族各守一个独立的失效面，且失效大半**安静**（少一条、重复一页、
  // 翻不完的循环、幽灵未读）——都不报错，只是数字/列表看着不对。
  // 每条 from 均照**编译产物**的真实形状逐字抄，并已独立核对 OCCURRENCES=1（docs/pitfalls.md 一、1.4）。
  { id: 'paging-续页谓词的 id 方向写反', file: 'lib/store-sqlite.js',
    // **缺陷本体**（spec §10.3 的实测）：分页的边界条件是「recency 降序、同 recency 内 id 升序」，
    // 于是下一页的第二个条件是 id **>** id0。方向写反（id < id0）在 recency 打平点上会**重复 + 漏**：
    // 实测 6 行每页 2 条返回 `a d e f`（a 重复、c 漏掉），正确是 `c d e f`。
    // 而 recency 打平是**常态**（同一轮抓取的条目共享 fetchedAt），所以这不是边角。
    //
    // ⚠️ 这里刻意不用行值比较 `(recency, id) < (?, ?)` 当变异体 —— 它的字典序展开**就是**这个方向
    // 错误（spec §10.3），但占位符只剩 2 个而调用方绑 4 个实参，node:sqlite 会抛
    // 「Too many parameter values」⇒ 那条变异会「因为绑定参数不匹配」被抓到，而不是因为断言看见了
    // 重复与漏（那是一条更弱的守卫）。本条把方向单独翻过来，绑定参数个数不变，于是**只有断言**能抓它。
    // 判据：tests/overview-paging.test.mjs 的「页边界正好压在 recency 打平组上」。
    from: "' WHERE i.recency < ? OR (i.recency = ? AND i.id > ?)'",
    to: "' WHERE i.recency < ? OR (i.recency = ? AND i.id < ?)'" },
  { id: 'paging-游标不校验形状（垃圾当第一页）', file: 'lib/shared.js',
    // 认不出的游标若被解出一个值，调用方就不再失败 —— 客户端回带的垃圾游标会被当成正常续页。
    // 判据：tests/overview-paging.test.mjs 的「游标认不出时响亮拒绝」与「游标编解码」两条。
    from: "if (!ISO_INSTANT.test(recency) || Number.isNaN(Date.parse(recency)))",
    to: 'if (false)' },
  { id: 'paging-端点不拒绝坏游标', file: 'lib/endpoints.js',
    // 「解不出就从第一页开始」会让翻页永远翻不完：每页都回同一批条目，界面无限追加重复行，
    // 而用户看到的是一份「永远滚不到底」的列表，不是一句报错。
    // 判据：tests/overview-paging.test.mjs 的「游标认不出时响亮拒绝（bad-request）」。
    from: `                    if (cursor === undefined) {
                        return fail('bad-request', '未知的续页游标（格式应为 "<recency>|<id>"）：' + raw);
                    }`,
    to: '                    if (cursor === undefined) return ok(buildOverview(false));' },
  { id: 'paging-到底也硬给续页游标', file: 'lib/endpoints.js',
    // 到底时还给游标 ⇒ 客户端一直显示「加载更多」，点下去得到空页（界面上的死按钮）。
    // 判据：tests/overview-paging.test.mjs 的「末页没有 nextCursor」。
    from: 'const nextCursor = lastDelivered >= 0 && (lastDelivered + 1 < rows.length || !exhausted)',
    to: 'const nextCursor = lastDelivered >= 0' },
  { id: 'paging-旧实现谓词的 id 方向写反', file: 'lib/store.js',
    // 与自持实现那条同一个失效面（P-7 把游标加在**接口**上 ⇒ 两份实现都得守）。只钉 SQL 一侧的话，
    // 两份谓词哪天分家不会有断言翻红 —— 而生产早已是 createSqliteStore，这份「不用的实现」会悄悄坏掉。
    // 判据：tests/overview-paging.test.mjs 的「旧实现（createStore）：listRecent 的游标谓词…」。
    from: 'return recency < cursor.recency || (recency === cursor.recency && itemId > cursor.id);',
    to: 'return recency < cursor.recency || (recency === cursor.recency && itemId < cursor.id);' },
  // 另三条同义性基线（2026-10-11 终检评审 G1）：`listRecent` 的游标谓词原先**是唯一一条**
  // 「旧实现 ↔ 自持实现」的对照用例，其余三条各自只被钉在「与自己的桩一致」上 ——
  // 两份实现悄悄分家时没有任何断言翻红，而生产早已是 createSqliteStore：坏掉的那份没人用。
  // 本轮在新用例里把**同一份夹具**喂给两边、逐字段 deepEqual（tests/overview-paging.test.mjs
  // 的「逐方法同义性」三条），下面三条变异各自指向其中一条。
  // ⚠️ from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4），OCCURRENCES 均独立实测 = 1。
  { id: 'store-旧实现每源账目不铺键域', file: 'lib/store.js',
    // 键域退回「条目里出现过的源」⇒ 0 未读的源丢键（左栏那一行的角标变空白而不是 0），
    // 与自持实现「先按 feeds 表铺 0」不再同义。
    // 判据：tests/overview-paging.test.mjs 的「逐方法同义性：unreadPerFeed…逐键相等」。
    from: 'unreadPerFeed: (feedIds) => countUnreadPerFeed(feedIds, [...items.entries()].map(([, record]) => record)),',
    to: 'unreadPerFeed: (feedIds) => countUnreadPerFeed([...items.entries()].map(([, record]) => record.feedId), [...items.entries()].map(([, record]) => record)),' },
  { id: 'store-旧实现正文清单字符数恒 0', file: 'lib/store.js',
    // 清算原料的 chars 退回 0 ⇒ 正文缓存闸门以为整库正文一文不值，淘汰名单算出来与自持实现不同
    //（chars 是 articleCharsOf 的第二处调用点，两处分家时这条要翻红）。
    // 判据：tests/overview-paging.test.mjs 的「逐方法同义性：listArticleCacheEntries…」。
    from: 'chars: articleCharsOf(record.article),',
    to: 'chars: 0,' },
  { id: 'store-旧实现候选集放过保持未读', file: 'lib/store.js',
    // 去掉「保持未读」的保护后，旧实现会把用户明确说「别动它」的条目交出去当清理候选 ——
    // 与 SQL 谓词（第四项 kept_unread = 0）不再同义，最终删除集也就跟着变宽。
    // 判据：tests/overview-paging.test.mjs 的「逐方法同义性：listCleanupCandidates…」。
    from: 'rows.filter((row) => !row.kept),',
    to: 'rows,' },
  { id: 'paging-续页不追加而是替换', file: 'lib/client.js',
    // 替换 ⇒ 翻到第二页时第一页整个消失（用户找不到刚读的那条）。
    // 判据：tests/nav-selection.test.mjs 的「续页是追加到列表尾部，不是替换」。
    from: 'items: [...state.items, ...overview.items],',
    to: 'items: overview.items,' },
  { id: 'paging-续页改按本地 items 派生账目', file: 'lib/client.js',
    // 缺陷本体在翻页处的复现：第二页开始又拿截断视图当真相 ⇒ 左栏各源之和 ≠ 顶栏总未读。
    // 判据：tests/nav-selection.test.mjs 的「每一页都以宿主回包为准整体覆盖账目」。
    from: 'applyAccount(overview);',
    to: 'set({ unread: overview.items.filter((i) => i.readAt === void 0).length, perFeedUnread: state.perFeedUnread });' },
  { id: 'paging-首屏游标不落 state', file: 'lib/client.js',
    // 首屏不记游标 ⇒ 界面上永远不出现「加载更多」，第 301 条之后仍然到不了（本任务的缺陷原样留下）。
    // 判据：tests/client-bundle.test.mjs 的「分页接线」+ tests/nav-selection.test.mjs 的分页族。
    from: 'nextCursor: overview.nextCursor,',
    to: 'nextCursor: void 0,' },
  { id: 'paging-客户端不回带游标', file: 'lib/client.js',
    // 回了 undefined ⇒ 宿主当成第一页，列表原地重复同一批 300 条（用户看到重复而不是报错）。
    // 判据：tests/nav-selection.test.mjs 的「续页是追加…」里的 pageCalls 断言。
    from: 'const overview = await callRpc("overview", { cursor });',
    to: 'const overview = await callRpc("overview", {});' },
  { id: 'paging-在途不挡重复请求', file: 'lib/client.js',
    // 连点堆请求：每次都要过一次 SQL + 一次 feeds 文件读，且会把同一页追加两遍。
    // 判据：tests/nav-selection.test.mjs 的「在途时忽略重复的 loadMore」。
    from: 'if (cursor === void 0 || state.loadingMore)',
    to: 'if (cursor === void 0)' },
  // ── 刷新日志按天分文件 + 保留 14 天（2026-10-11 大规模存储任务 7）────────────────────
  // 病象：日志是一个写到天荒地老的单文件（本机实测 503 KB），且与用户数据分居两处。
  // 修法：搬进 storages/rss-reader/，按 UTC 日期分文件，装载时 prune 掉超期的。
  //
  // ⚠️ 这一族「改坏」的代价与别处不同级：**prune 一旦宽了一个字符，删掉的就是用户的订阅真相
  // （config.json）或已读态/星标（rss.db）** —— 不可逆，且界面上只表现为「订阅少了一批」，
  // 不会报错。所以文件名判据与保留窗口边界各钉一条，两条 from 均照**编译产物**
  // lib/storage/log-file.js 的真实形状逐字抄，并已独立核对 OCCURRENCES=1（docs/pitfalls.md 一、1.4）。
  { id: 'log-文件名判据放宽成前缀匹配', file: 'lib/storage/log-file.js',
    // 正则放宽成 `/^reader-/` 后，捕获组 matched[1..3] 全是 undefined ⇒ Date.UTC(NaN,…) 是 NaN ⇒
    // dayMsOf 对**每一个**名字都返回 undefined ⇒ 判据里的 day === undefined 把全部条目跳过。
    // ⚠️ 所以它的真实失效**不是**「删掉 reader- 前缀的邻居」（那需要 dayMsOf 返回一个数字才会走到
    // unlinkSync），而是**保留策略被静默废掉**：从此一份日志都不会被清理，日志目录无限增长，
    // 而 pruner 每次都很「成功」地返回 0 —— 没有任何报错、没有任何日志线索。
    // 判据：tests/log-file.test.mjs 的「只删超期 reader-*.log（含超期邻居必须活着）」
    // 与「保留窗口是闭区间」——两份超期日志必须被删掉，放宽后它们全都留下。
    // lib/storage/log-file.js:29，独立实测 OCCURRENCES=1。
    from: 'const LOG_NAME = /^reader-(\\d{4})-(\\d{2})-(\\d{2})\\.log$/;',
    to: 'const LOG_NAME = /^reader-/;' },
  { id: 'log-认不出的名字被当成可删', file: 'lib/storage/log-file.js',
    // ⚠️ 本条曾被我按「等价变异」错误地排除过一轮，推导方向是反的：少了 `day === undefined ||` 之后，
    // 判据只剩 `if (day >= cutoff) continue`，而 undefined >= 数字 **恒为 false** ⇒ continue 不执行
    // ⇒ 直接落到 unlinkSync。凡是**认不出的名字**（config.json / rss.db / rss.db-wal / rss.db-shm /
    // notes.txt / reader-backup.log …）都会被当成超期日志删掉 —— 这正是整个模块存在的理由所在：
    // 用户的订阅真相与已读态，不可逆，且界面上只表现为「订阅少了一批」。
    // 判据：tests/log-file.test.mjs 的「只删超期 reader-*.log」与「认不出的名字既不删也不崩」
    // （两条各有一条 deepEqual 名字集合的断言，删掉邻居当场翻红）。
    // lib/storage/log-file.js:102，独立实测 OCCURRENCES=1。
    from: 'if (day === undefined || day >= cutoff)',
    to: 'if (day >= cutoff)' },
  { id: 'log-同名目录不再跳过（EISDIR 抬升为整次失败）', file: 'lib/storage/log-file.js',
    // 去掉「只删普通文件」这道闸后，一个名字恰好合形、且超期的**目录**会直接进 unlinkSync ⇒
    // EISDIR ⇒ 整次 prune 抛错。危害不是「删错东西」，而是**清理从此每次都失败**：
    // 用户会看到反复的清理告警，而真正该删的超期日志一个都删不掉（紧随其后的 unlinkSync 被跳过）。
    // 判据：tests/log-file.test.mjs 的「匹配到同名目录时跳过（EISDIR 不许升级成整次清理失败）」。
    // lib/storage/log-file.js，独立实测 OCCURRENCES=1。
    from: 'if (entry === undefined || !entry.isFile())',
    to: 'if (false)' },
  { id: 'log-保留窗口多留一天（边界偏移）', file: 'lib/storage/log-file.js',
    // keepDays 少减一天 ⇒ 窗口变成「今天 + 前 14 天」= 15 份。这类错**没有症状**：日志多留一份
    // 看起来永远是对的，只有钉在两侧的边界用例能抓到它（只断言「有老文件被删」的用例放走它）。
    // 判据：tests/log-file.test.mjs 的「保留窗口是闭区间：今天 + 前 13 天留，第 14 天前删」——
    // 它断言第 14 天前那份**必须**消失，同时第 13 天前那份**必须**还在。
    // lib/storage/log-file.js:96，独立实测 OCCURRENCES=1。
    from: 'const cutoff = today - (keepDays - 1) * DAY_MS;',
    to: 'const cutoff = today - keepDays * DAY_MS;' },
  // ⚠️ 本轮**刻意没加**的一条（实测判定为**等价变异**，按 AGENTS.md 不入门槛）：
  // 「prune 改成看 mtime」：mtime 判定需要 statSync，改动已经不止一处（要换掉整个循环体），
  // 而它表达的行为差异（文件名 vs 修改时间）已由「对认不出的文件名…且判据只看文件名不看 mtime」
  // 那条用例钉住（6 个认不出的名字 mtime 全设成 2000 年，混进 mtime 就会被一起删掉）。
  //
  // 📌 教训（修复轮 1/5）：本区块原先还排除过一条「删掉 day === undefined 这半边」，理由写的是
  // 「undefined >= cutoff 恒 false ⇒ 同样是 continue」。**这个推导是反的**：`continue` 的语义是
  // 「跳过」，条件为 false 恰恰意味着**不跳过**、继续往下走到 unlinkSync。我把「条件为假」
  // 错读成了「结果为跳过」。本条现已作为 'log-认不出的名字被当成可删' 正式入门槛。
  // 教训的教训：写下「这是等价变异」之前必须按**执行路径**推一遍（哪个分支被走到、走到哪里），
  // 而不是只看表达式的值像不像。docs/pitfalls.md 二、2.7 记的「未应用比幸存更隐蔽」是同一族错误
  // 的另一种形态 —— 两者都源于对「这条变异到底改变了哪次执行」没有真的验证。
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
  // ⚠️ **第四态：变异代码自己崩了**（2026-10-11 任务 9 修复轮 2，评审抓出）。
  // `to` 里若引用作用域外的名字、或产物里没有的符号，套件当然红 —— 但红的是 ReferenceError /
  // SyntaxError，**没有一条断言真的观察到这条变异想制造的缺陷**。
  // 旧版把它记成「被抓到」，于是汇总里「幸存 0 条」看起来一切正常，而判据其实**完全没被保护**。
  // 任务 9 真踩过两次（先产物没 import 的函数名 ⇒ SyntaxError，再作用域外的 urls ⇒ ReferenceError），
  // 两次都是「红，但不是被抓住」；docs/pitfalls.md 二、2.7b 记了这件事。
  // ⇒ 把「崩了」单列成一类并**计入失败清单**：它必须像幸存者一样逼人去修 `to`。
  //
  // ⚠️ **判据必须把「本条变异改过的那个文件」和「这两种错误名」关联起来**
  //   （实测踩到两次，两次的错法不同，都记在这儿）：
  //   ① 对整段输出做全文匹配 ⇒ **每一条**都判成「崩了」—— 真崩的那条会让整个套件里的所有
  //      文件都红，别的条目只要输出里出现 ReferenceError 就被误伤；
  //   ② 只在**错误那一行**里找文件名 ⇒ 一条都找不到 —— node 的 TAP 输出把
  //      「ReferenceError: ...」放在一行、**栈帧放在下一行**（实测：行 37 是错误、38 行才是
  //      `at file:///…/lib/refresh.js:79:104`）。
  //   ⇒ 判据是「被改过的那个文件名出现在崩溃块里」，才算「崩的是变异写入的代码」。
  //
  // ⚠️ **三个形状上的坑，都是 2026-10-11 终检评审 B1 在隔离副本里实测出来的**（改任一条都要重跑）：
  //
  //   ① 匹配的是**文件基名**（`m.file.split('/').pop()`），栈帧里带产物名就够 —— 而 **vm 加载的
  //      产物不给 `filename` 就永远匹配不上**：`lib/client.js` 由四个测试用 `vm.runInContext` 加载，
  //      不给 `filename` 时帧上是 `evalmachine.<anonymous>` ⇒ client 那一族（50 条）永远进不了
  //      分类器，那 50 行号称被守、其实没有被守。
  //      `实测`：在 `lib/client.js` 末尾注入 `MUTANT_BOOM_UNDEFINED_NAME();`（一个 ReferenceError）——
  //        · 撤掉 filename（= 修前）：帧 `at evalmachine.<anonymous>:3047:1`，`ℹ fail 91`，判 **crashed = false**；
  //        · 补上 filename：帧 `at client.js:3047:1`，同样 `ℹ fail 91`，判 **crashed = true**。
  //      ⇒ **修法在加载点**：四处都补了 `{ filename: BUNDLE_NAME }`（tests/client-bundle.test.mjs 的
  //      `BUNDLE_NAME`，另三处同源）。**新增任何 vm 加载点都要照抄那一行。**
  //
  //   ② 错误名必须**带 TAP 缩进**（正则写 `^\s+(ReferenceError|SyntaxError):`，是 `\s+` 不是 `\s*`）。
  //      两个会误判的形状都是**列 0**，各自实测：
  //      · client 在正常路径上会**记录**（不是抛出）`[rss-reader] 读取视图记忆失败…ReferenceError:
  //        fetch is not defined`（行首是日志前缀）；
  //      · `client-守卫改回环境全局` 那条**合法**变异，让按键处理器在 jsdom 的事件派发里抛
  //        ReferenceError —— jsdom 把它原样重播到列 0，而**断言仍然抓到了它**（scroll-dom.test.mjs:408
  //        的 `false !== true`）。那条变异只是恰好抛了个怪东西，`to` 本身没写错，不算「崩了」。
  //      真正的加载期崩溃一律由 TAP 缩进两格（实测：host / client 的 ReferenceError、vm 的
  //      SyntaxError，以及四条探针用例）。
  //
  //   ③ 窗口**向两边各取 6 行**。两种崩溃的行文形状不同（都实测过）：
  //      · ReferenceError：错误行**后面**的栈帧里印文件名（`at client.js:3047:1`）；
  //      · vm 编译期的 SyntaxError：**没有栈帧**，文件名印在错误行**前面**的源码回显里
  //        （`  client.js:3047` / `  const = ;` / `        ^` / 空行 / `  SyntaxError: …`）。
  //      只往后看会漏掉 SyntaxError，只往前看会漏掉 ReferenceError。
  const mutatedFile = m.file.split('/').pop()
  const outLines = res.out.split('\n')
  // ⚠️ `\s+`（不是 `\s*`）：见上面 ② 的两种列 0 形状。
  const errorAt = outLines.findIndex((line) => /^\s+(ReferenceError|SyntaxError):/.test(line))
  const stackMentionsMutatedFile = errorAt >= 0 && outLines
    .slice(Math.max(0, errorAt - 6), errorAt + 7)
    .some((line) => line.includes(mutatedFile))
  const crashed = errorAt >= 0 && stackMentionsMutatedFile
    ? outLines[errorAt].match(/\b(ReferenceError|SyntaxError)\b/)
    : null
  if (crashed) {
    console.log('  !  ' + m.id.padEnd(26) + ' 崩了（' + crashed[1] + '：变异 `to` 自己写错了，不算被抓住 —— 请改 `to`）')
    survivors.push(m.id + '（崩了：' + crashed[1] + '）')
    continue
  }
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
  console.error('-> 标「幸存」的是测试没覆盖到的判定（补一条会翻红的断言，或确认它是等价变异）；')
  console.error('   标「崩了」的：变异 `to` 自己写错了（ReferenceError / SyntaxError），那种红不算被抓住（docs/pitfalls.md 二、2.7b）。')
  process.exit(1)
}
console.log('全部被抓到。')
