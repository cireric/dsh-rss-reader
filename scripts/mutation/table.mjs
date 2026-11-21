/**
 * 变异表：每条只改一处关键判定，`from` 必须命中一次（构建后逐条核 OCCURRENCES=1）。
 *
 * 刻意**不含等价变异** —— 例如 selectArticleEvictions 里把 total 与上限的比较从小于等于改成小于：
 * 两者在相等时的返回值同为「不清」，行为完全相同，它幸存不是测试缺口。等价变异混进来会让这道
 * 门槛变成狼来了（docs/pitfalls.md §2.7 / AGENTS.md「等价变异不入门槛」）。
 *
 * 这张表是**数据**，不含运行逻辑：加一条变异只改这里，不动 scripts/mutation/ 下的任何模块。
 */

export const MUTATIONS = [
  // ── 2026-11-15 缺陷修复轮：协议白名单 / 正文 base / 日志转义 / 同名多值 ──
  // 每一条都是「改坏关键判定，看有没有判据喊」。from 锚串取自 lib/ 产物的实际字节
  //（构建后逐条独立 grep 核对 OCCURRENCES=1，见 docs/pitfalls.md 一、1.4）。
  { id: 'link-协议白名单失效', file: 'lib/shared.js',
    judges: ['parse.test.mjs'],
    judgeTests: ['条目链接只放行 http/https：javascript: / data: / file: / mailto: 归一成空串，相对与合法链接不变'],
    from: "return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';",
    to: "return url.toString();" },
  // —— 内联语义（R5 02）——
  // 链接白名单在**抽取期**失效：javascript: 会变成可点的 link run（渲染期还有第二道，但抽取期
  // 这道是「不产生可点数据」的源头）。锚在 article-text.js：safeUrl 已从 article.ts 搬走。
  { id: 'inline-链接不走白名单', file: 'lib/article-text.js',
    judges: ['article.test.mjs'],
    judgeTests: ['内联：javascript: / data: / mailto: 退化成纯文本，不产生可点链接'],
    from: "return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.toString() : undefined;",
    to: "return resolved.toString();" },
  // text 仍走 htmlToText：带 runs 的块会出现「显示有链接、搜不到那个词」。这是本项最重要的
  // 那条变异——它守护的正是「text 由 runs 派生」这条决定（ADR-0007）。
  { id: 'inline-text 仍走 htmlToText', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['不变量：runs 拼接严格等于 text（含行内标签两侧是汉字的形态）'],
    from: '实际只有 38 字可读（应丢弃）。\n                const text = runsToText(runs);',
    to: '实际只有 38 字可读（应丢弃）。\n                const text = htmlToText(line);' },
  // 嵌套块被吞：列表项 / 引用 / 标题里嵌的 table / pre 会被内联解析当占位符丢弃（评审实测抓到的
  // 回归）。判据是「嵌在 li 里的表格文字必须还在」。
  { id: 'inline-嵌套块被占位符吞掉', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['内联：列表项 / 引用 / 标题里嵌的块不许静默消失'],
    from: 'return list + placeholdersOf(nested);',
    to: 'return list;' },
  // 单元格里的占位符没剥掉：读者在表格里看到 `B0`，并污染搜索索引与字符统计。
  { id: 'table-单元格漏出占位符', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['表格：单元格里嵌的块不许漏出内部占位符'],
    from: "htmlToText(inner.replace(/\\u0000B\\d+\\u0000/g, ' '))",
    to: 'htmlToText(inner)' },
  // 旧修订号的缓存被当命中：读者永远看到升级前的块（spec 验收 13）。
  { id: 'endpoint-旧修订号缓存当命中', file: 'lib/endpoints.js',
    judges: ['reading-progress.test.mjs'],
    judgeTests: ['article 端点：旧修订号的缓存被判过期 —— 回 cached:false 并重抓（不许静默给旧块）'],
    from: 'existing.article.revision === ARTICLE_REVISION',
    to: 'existing.article.revision !== ARTICLE_REVISION' },
  // 列表项链接没进模型正文：段落能带地址、列表只剩文字（审查实测抓到的缺口）。
  { id: 'tools-列表项链接丢失', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_read_article：列表项里的链接也摊成 [文字](地址)（不只是段落）'],
    from: "const itemGroups = markdownItemRunsOf(block['itemRuns'], listItems.length);",
    to: 'const itemGroups = undefined;' },
  // 列表 itemRuns 长度不校验：会把一组 run 硬套到第一项上（与客户端判据分家）。
  { id: 'tools-列表项 run 长度不校验', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_read_article：itemRuns 与 items 长度对不上时整份退回纯文本'],
    from: 'if (!Array.isArray(value) || value.length !== expectedLength)',
    to: 'if (!Array.isArray(value))' },
  // 抽取器版本退回 4（= 不抬版本）：旧缓存永远不重抓，R5 的核心承诺落空。
  { id: 'extract-版本不抬', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['抽取版本：常量必须由 article.ts 导出，且 endpoints 不得再写死数字'],
    from: 'const EXTRACTOR_REVISION = 5;',
    to: 'const EXTRACTOR_REVISION = 4;' },
  // 收敛出来的空格归「后一个 run」而不是空白自身所属的 run：链接的可点区域会比看起来宽
  // 判据见「标签外的空格不并入链接」与「标签内的空格属于链接」两条（真实站点上两种写法都存在）。
  { id: 'inline-空格并进链接', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['内联：标签外的空格不并入链接（真机实测踩到：链接可点区域比看起来宽）'],
    from: 'kept.push({ char: \' \', owner: pendingSpaceOwner });',
    to: 'kept.push({ char: \' \', owner: owners[index] });' },
  // 相邻同类 run 不合并：run 数会等于标签数，结构上限与体积守卫一起失效。
  { id: 'inline-相邻同类 run 不合并', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['内联：相邻同类 run 合并（否则 run 数等于标签数，结构上限形同虚设）'],
    from: 'if (last !== undefined && sameRunKind(last, source)) {',
    to: 'if (false) {' },
  // 占位符当普通文本：<li> 里嵌 <pre> 时内部占位符会进 items（既存缺陷回归）。
  { id: 'inline-占位符当普通文本', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['内联：占位符不许进 items / itemRuns（<li> 里嵌 <pre>）'],
    from: 'const BLOCK_SEPARATORS = /<br\\s*\\/?>|\\u0000B\\d+\\u0000/gi;',
    to: 'const BLOCK_SEPARATORS = /<br\\s*\\/?>/gi;' },
  // 门槛用假长度：38 个汉字嵌 6 个 <b> 的段落会被 htmlToText 数成 50 字而保留。
  { id: 'extract-门槛用假长度', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['门槛判可见字符数：38 个汉字 + 6 个 <b> 的段落被丢弃，再加 3 个字被保留'],
    from: '实际只有 38 字可读（应丢弃）。\n                const text = runsToText(runs);\n                if (text.length >= MIN_CONTENT_CHARS)',
    to: '实际只有 38 字可读（应丢弃）。\n                const text = htmlToText(line);\n                if (collapseWhitespace(htmlToText(line)).length >= MIN_CONTENT_CHARS)' },
  // 归一化放到切 run 之后：run 文本带原始换行缩进，严格相等当场破。
  { id: 'inline-归一化放到切 run 之后', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    // 判据必须是**字面期望值**那条：`runs.join === text` 在「text 由 runs 派生」之后是自证的，
    // 抓不到归一化放错位置（实测：只挂那条时本变异幸存）。
    judgeTests: ['归一化先于切 run：text 必须无换行、无连续空白（严格相等是自证的，这条才钉得住顺序）'],
    from: 'const normalized = normalizeRuns(raw);',
    to: 'const normalized = raw;' },
  // 渲染期白名单（R5 03）：抽取期已过 safeUrl，但历史脏数据可能带着 javascript: 落进缓存，
  // 所以渲染 link run 前必须再过一次 httpUrlOrEmpty。去掉它之后，脏链接会变成可点的 <a>
  // —— 判据是 tests/scroll-dom.test.mjs 的「非法链接退化成纯文本」（真 React + jsdom 的 DOM 断言）。
  { id: 'client-非法链接仍渲染 a', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['正文内联：非法链接退化成纯文本，不产生 <a>（渲染期白名单）'],
    from: 'const href = httpUrlOrEmpty(run.href);',
    to: 'const href = run.href;' },
  // 正文 base 回落到请求 URL：301 换路径后相对图片会解析到旧地址（P1-1 的病象）。
  { id: 'article-正文base回落到请求URL', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['正文 base 用重定向落点 finalUrl：相对图片按落点解析，而不是请求 URL'],
    from: 'extractArticle(result.body, result.finalUrl)',
    to: 'extractArticle(result.body, url)' },
  // 去掉落盘转义：message 里的换行会伪造日志行（发布前真机判据按行读）。
  { id: 'log-落盘不转义控制字符', file: 'lib/storage/log-file.js',
    judges: ['log-file.test.mjs'],
    from: 'escapeLogLine(message);',
    to: 'message;' },
  // 同名多值按值排序：?tag=a&tag=b 与 ?tag=b&tag=a 会被并成同一组提示。
  { id: 'dupes-同名多值按值排序', file: 'lib/duplicates.js',
    judges: ['duplicates.test.mjs'],
    judgeTests: ['P3-2 同名多值参数保持原序：顺序不同的 URL 不是同一个键'],
    from: 'params.sort((a, b) => a[0].localeCompare(b[0]));',
    to: 'params.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));' },
  // 渲染和键盘共用行序，折叠后仍生成子行会让导航无法跳过。
  { id: 'folder-折叠隐藏订阅行', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['文件夹展开与折叠同步键盘行序，汇总未读且保留订阅选择'],
    from: 'if (foldedFolders.has(folder)) continue;', to: 'if (false) continue;' },
  // 文件夹计数必须保留同组前面各源的未读数。
  { id: 'folder-未读汇总覆盖同组', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['C4-b 判定：行高量不到（offsetHeight=0）时按列表兜底 48 滚，而不是按 0 滚（量错对象的「有值但不正确」是实测事故）', '文件夹展开与折叠同步键盘行序，汇总未读且保留订阅选择'],
    from: '(unreadByFolder.get(feed.folder) ?? 0) + (perFeedUnread[feed.id] ?? 0)', to: '(perFeedUnread[feed.id] ?? 0)' },
  // 搜索刷新可能移动同一条目，跟随滚动必须响应新结果。
  { id: 'search-刷新后跟随同一选中项', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['刷新搜索后相同选中项移出视口时，列表跟随其新位置'],
    from: 'state.selectedId,\n\t\t\t\t\tstate.view,\n\t\t\t\t\tstate.searchRevision', to: 'state.selectedId, state.view' },
  // 刷新要重查已加载的页，否则深页选中的文章会被替换成第一条。
  { id: 'search-刷新保留已加载窗口', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs'],
    judgeTests: ['搜索刷新废弃旧续页，沿新游标恢复已加载窗口和选中项'],
    // 2026-11-15 重锚：搜索域搬进 search-actions.ts 后，store 侧只剩 `searchActions.load(..., loadedPages())`。
    // 2026-11-16 重锚：06c 把 load 搬进 list-actions.ts 后，搜索域只经 host 的 search 对象。
    from: 'await search.load(void 0, search.loadedPages())', to: 'await search.load()' },
  // 限页前必须检查字面命中，否则无关文章会抢占搜索分页。
  { id: 'search-只返回字面命中', file: 'lib/search-worker.js',
    judges: ['search.test.mjs'],
    judgeTests: ['本地搜索跨页稳定，按源、日期、星标和已读筛选，并只查当前缓存'],
    from: 'THEN (${match}) ELSE 0 END', to: 'THEN (1) ELSE 0 END' },
  // article-view.ts 随原站视图整条删除（2026-10-08），那条变异的目标已不存在。
  // 换成守护本次修复的两条判定：装饰性小图过滤、同一图重复去重。
  { id: 'article-装饰性小图过滤', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['装饰性小图判据：CDN 尺寸描述符 ≤200 就当头像/图标丢掉（2026-10-08 用户实测）', '抽取：装饰性小图与重复图都不进正文（sspai 那篇的回归）'],
    from: 'if (width > 0 && height > 0 && width <= DECORATIVE_IMAGE_MAX && height <= DECORATIVE_IMAGE_MAX)',
    to: 'if (false)' },
  { id: 'article-重复图去重', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['抽取：装饰性小图与重复图都不进正文（sspai 那篇的回归）'],
    from: 'if (count > MAX_SAME_IMAGE)', to: 'if (false)' },
  // 容器识别（2026-10-09）：它替代了「按尺寸/路径逐条猜杂图」的做法，失效就意味着站点头像与
  // 页脚二维码重新回到正文里 —— 正是用户截图里的现象，所以必须有人看着它。
  // ⚠️ 刻意**没有**「正文容器收窄」那条变异：它实测是**等价变异**，不是测试缺口。
  // 设子容器文本 c、父容器额外文本 x，子全为段落时子分数 = c、父分数 = c + 0.35x；
  // 要让收窄被接受需 c ≥ 0.9(c + 0.35x) ⇒ x ≤ 0.317c，而文本比阈值要求 c ≥ 0.5(c + x) ⇒ x ≤ c。
  // 后者被前者严格蕴含 ⇒ 去掉文本比检查后**没有任何输入**会改变结果，套件全绿是正确行为。
  { id: 'article-容器识别的整页兜底', file: 'lib/article.js',
    judges: ['article.test.mjs', 'overview-scale.test.mjs'],
    // 兜底失效 ⇒ 容器一旦选错就是「正文全丢」，这是本设计最危险的失效模式，必须有断言看住
    from: 'const blocks = focused.length > 0 ? focused : collectBlocks(scoped, baseUrl)',
    to: 'const blocks = focused' },
  { id: 'keys-r 归还刷新计数', file: 'lib/keys.js',
    judges: ['keys.test.mjs'],
    judgeTests: ['键位：r 刷新计数；w/W 已空出且不得被偷偷接管（2026-10-08）', '帮助表逐条反查：每一行声明的动作都必须与实现解析出来的完全一致', '帮助表反向覆盖：实现里能返回的动作，都必须出现在帮助表里'],
    from: "return 'refreshCount';", to: "return 'toggleRender';" },
  { id: 'client-A 的范围阈值过滤', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs'],
    judgeTests: ['A 的范围阈值：只标「早于所选范围」的条目（规格 §3.3 的 panic button）'],
    from: 'recencyOf(item) < before', to: 'true' },
  // ⚠️ 2026-11-13（M4 01）重锚：判据从 discoverAndValidate 收进 limitsForCandidate 之后，
  // 「options.limits」变成了参数「limits」—— 旧 from 会报**未应用**（比幸存更隐蔽，pitfalls 二、2.7）。
  // 语义不变，仍是「只要可信目标就全都继承」；覆盖面从 addFeed 的首个有效源**扩到**发现列表，
  // 两个调用方共用这一处判据。
  { id: 'subscribe-信任不跨源传播', file: 'lib/subscribe.js',
    judges: ['subscribe.test.mjs'],
    judgeTests: ['信任不跨源传播：同源候选继承可信目标、跨源候选一律不可信（安全边界）', '发现：同源候选继承可信目标；跨源候选一律不可信', '发现：一次重定向不能把候选升级成可信目标（落点只用于解析，不用于继承信任）'],
    from: 'const inherited = limits.trustedTarget === true && isSameOrigin(candidate, pageUrl);',
    to: 'const inherited = limits.trustedTarget === true;' },
  // ── M4 02：订阅健康（2026-11-13）────────────────────────────────────────────
  // 连败计数必须**跨轮累计**：恒为 1 的实现会让「连续失败 5 次」永远显示 1，用户看不出源烂了多久。
  // 判据在 tests/refresh.test.mjs（真 refreshFeeds 两轮失败 ⇒ 2）与 store-sqlite 的失败累计用例。
  { id: 'health-连败不累计', file: 'lib/feed-intent.js',
    judges: ['refresh.test.mjs', 'store-sqlite.test.mjs'],
    judgeTests: ['M4 02：连续两轮失败累计到 2，恢复成功后清零并清掉横幅', 'M4 02：失败累计 1→2，200 与 304 都清零；undefined（历史未知）与 0（零连败）不得混为一谈'],
    from: 'failureCount: (previous?.failureCount ?? 0) + 1,',
    to: 'failureCount: 1,' },
  // 200 与 304 都必须**显式写 0**（省略 = 退回「历史未知」，界面会把刚成功的源显示成「次数未知」）。
  // 两个分支各一条：它们是同一判定的两处实现，只改一处就只是半条规矩。
  { id: 'health-200 不清连败', file: 'lib/feed-intent.js',
    judges: ['store-sqlite.test.mjs'],
    judgeTests: ['M4 02：失败累计 1→2，200 与 304 都清零；undefined（历史未知）与 0（零连败）不得混为一谈', 'H4：refresh-success 清 lastFailure 且盖双时间戳（与旧白名单逐字段等价）'],
    from: '                contentRevision: intent.contentRevision,\n                // 成功即清零（不是「省略这个字段」）：省略等于退回「历史未知」，而这里我们**知道**刚成功。\n                failureCount: 0,',
    to: '                contentRevision: intent.contentRevision,\n                // 成功即清零（不是「省略这个字段」）：省略等于退回「历史未知」，而这里我们**知道**刚成功。\n                failureCount: previous?.failureCount,' },
  { id: 'health-304 不清连败', file: 'lib/feed-intent.js',
    judges: ['store-sqlite.test.mjs'],
    judgeTests: ['M4 02：失败累计 1→2，200 与 304 都清零；undefined（历史未知）与 0（零连败）不得混为一谈'],
    from: '                // 304 也是成功（源说内容没变）：连败计数同样归零，与 lastFailure 清零同一条理由。\n                failureCount: 0,',
    to: '                // 304 也是成功（源说内容没变）：连败计数同样归零，与 lastFailure 清零同一条理由。\n                failureCount: previous?.failureCount,' },
  // 「把源重新加一遍 = 修好了」是 M4 02 明确要修掉的假象：订阅落库不是抓取结果，不许清失败历史。
  { id: 'health-订阅落库抹掉失败历史', file: 'lib/feed-intent.js',
    judges: ['store-sqlite.test.mjs'],
    judgeTests: ['M4 02：upsert-subscription 保留失败历史 —— 重复添加 / OPML 重导不得清掉 lastFailure 与连败计数'],
    from: '                lastFailure: previous?.lastFailure,',
    to: '                lastFailure: undefined,' },
  // X 必须是「本轮实际尝试的源数」，不是订阅总数：退回 total 会让界面把「摸了 1/3」吹成「3/3」。
  // 判据在 refresh.test.mjs 的真装配（K=1 / 3 源，断言端点回包的 refresh.attempted === 1）。
  { id: 'health-X 报成订阅总数', file: 'lib/lifecycle.js',
    judges: ['refresh.test.mjs'],
    judgeTests: ['refreshNow 每轮只抓 refreshFeedsPerRound 个源，且下一轮换一批（接线 + 旋转）'],
    from: "return { outcome: 'ran', attempted: subscriptions.length, total };",
    to: "return { outcome: 'ran', attempted: total, total };" },
  // 「次数未知」不许写成「0 次」：老记录从来没记过计数，补 0 就是撒谎（domain.ts 的三态契约）。
  { id: 'health-未知次数写成 0', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['M4 02：管理页显示健康、连败次数、最近尝试与上次成功；历史未知写成「次数未知」而不是 0'],
    from: '" · 连续失败：" + (feed.failureCount === void 0 ? "次数未知" : feed.failureCount + " 次"),',
    to: '" · 连续失败：" + (feed.failureCount === void 0 ? "0 次" : feed.failureCount + " 次"),' },

  // ── M5 01：阅读偏好与预计时长（2026-11-16）────────────────────────────────
  // 归一化必须**放行档位内的值**：恒回落默认的实现会让「选了 20px，重开变回 16px」，
  // 而这条在类型上完全合法。判据在 tests/nav-persistence.test.mjs（档位原样通过 + 重开恢复）。
  { id: 'reading-字号档位恒回落', file: 'lib/preferences.js',
    judges: ['nav-persistence.test.mjs'],
    judgeTests: ['sanitizeViewPreferences：正文排版逐字段归一，档位外的值一律回落默认', '端点：saveViewPreferences 存下偏好，viewPreferences 原样读回'],
    from: "fontSize: READING_FONT_SIZES.includes(readingSource['fontSize'])\n            ? readingSource['fontSize']",
    to: "fontSize: READING_FONT_SIZES.includes(readingSource['fontSize'])\n            ? DEFAULT_READING_PREFERENCES.fontSize" },
  // 改字号必须落盘：setReading 漏掉 persistView 时界面当场是对的，只有「重开插件」才看得出。
  // 判据是 nav-persistence 的客户端层用例（改字号 → 重开后排版仍恢复）。
  { id: 'reading-改字号不落盘', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    judgeTests: ['改字号只动排版：导航、过滤与左栏显隐一项都不许被覆盖（重开后排版也恢复）'],
    from: "...patch\n\t\t\t\t} });\n\t\t\t\tpersistView();",
    to: "...patch\n\t\t\t\t} });" },
  // 时长必须中英各算一半：只数 CJK 时纯英文段落贡献 0 分钟（固定夹具里 200 词那一段就没了）。
  { id: 'reading-时长不计英文', file: 'lib/shared.js',
    judges: ['reading.test.mjs'],
    judgeTests: ['英文按 200 词/分：400 词 = 2 分钟，401 词 = 3 分钟', '中英混排：两套速率各算各的，加起来再向上取整', '列表项与标题都算正文；图片块整块不计（图注也不计 —— 估的是量级，不值得为它加一条分支）'],
    from: "                if (WORD_PATTERN.test(token))\n                    words += 1;",
    to: "                if (false)\n                    words += 1;" },
  // 界面必须标「估算」：速率是整数近似值，写成确定口吻就是撒谎。判据在 DOM 层的文案断言。
  { id: 'reading-时长不标估算', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['正文页阅读偏好：时长标「估算」、字号/栏宽落到正文、写盘发的是整份偏好', '文件夹展开与折叠同步键盘行序，汇总未读且保留订阅选择'],
    from: '" 分钟（估算）"',
    to: '" 分钟"' },
  // ── M5 02：已缓存正文的阅读进度（2026-11-16）────────────────────────────
  // 进度按 (条目 id + 正文内容标识) 恢复：**版本必须校验**，否则「正文换了」也会回到旧位置。
  // 判据在 tests/reading-progress.test.mjs 的「版本对不上就当没有」。
  { id: 'progress-版本不校验', file: 'lib/store-sqlite.js',
    judges: ['reading-progress.test.mjs'],
    judgeTests: ['阅读进度：按 (itemId, 内容标识) 存读，版本对不上就当没有'],
    from: "if (requiredText(row.version, 'reading_progress.version') !== contentVersion)\n                return undefined;",
    to: "if (false)\n                return undefined;" },
  // 比例是**用户数据**：越界值（5、1.7）必须夹到 [0,1]，认不出的（NaN/字符串）按 0。
  // 少了这道夹取，库里会攒出 scrollTop = 13500 这种恢复时必越界的值。
  { id: 'progress-写入不夹取', file: 'lib/shared.js',
    judges: ['reading-progress.test.mjs'],
    judgeTests: ['clampReadingRatio：只留 [0,1] 的有限数，认不出的一律当 0', '阅读进度：写入即夹取，条目不存在一律拒绝', 'saveReadingProgress 端点：缺参数 / 未知条目响亮失败，比例越界被夹住'],
    from: "return ratio >= 1 ? 1 : ratio;",
    to: "return ratio;" },
  // 缓存淘汰只清正文、不清进度 ⇒ 恢复会指向一段已经不存在的正文（同一份内容标识永远不会再出现，
  // 那条进度就永远读不到，但它仍然挡着「这一条没有进度」的判断）。判据在 tests/refresh.test.mjs。
  { id: 'progress-淘汰不清进度', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    judgeTests: ['正文缓存淘汰同时清掉阅读进度（M5 02 的「缓存淘汰可清理进度」）'],
    from: "await store.clearReadingProgress(itemId);",
    to: "void 0;" },
  // 离开正文（切换 / 卸载）必须落盘：少了这一句，界面完全正常，只有「重开」才看得出进度没记住。
  // 判据在 tests/scroll-dom.test.mjs 的真 DOM 用例（切换一次必须恰好写一次）。
  { id: 'progress-离开不落盘', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['阅读进度：切走再回来接着读、滚动不写盘、离开时落盘（M5 02）'],
    from: "onSaveProgress(itemId, contentVersion, readingRatioOf(box.scrollTop, box.scrollHeight, box.clientHeight));",
    to: "void 0;" },
  // 恢复侧同样要夹：库里的比例来自用户数据，而恢复时的内容高度与记录时不一定相同。
  // ⚠️ **刻意没有** restoreTopFor 的「去掉夹取」这条变异：它实测是**等价变异**，不是测试缺口。
  // 推导（两轮实测）：① 去掉外层的 clampScrollTop ⇒ 内层已把 safe 夹在 [0,1]，结果不变；
  // ② 去掉内层夹取 ⇒ 外层 clampScrollTop 把 safe*ceiling 再夹回 [0, ceiling]，结果仍不变；
  // ③ 两层都去掉 ⇒ 浏览器对 scrollTop 赋值本身就会夹到 [0, maxTop]（越界只是「停在底部」）。
  // 三个方向都改不出可观察的差别，所以这条入门槛只会变成狼来了。函数契约仍由
  // tests/reading-progress.test.mjs 的纯函数用例钉住（0.5→1350 / NaN→0 / 越界→maxTop）。
  // ── M5 03：跨源重复提示（2026-11-16）──────────────────────────────────────
  // 「同源不算」是这条提示的定义之一：同一链接在同一源里重复是 identity-repair 的活，
  // 在这里再报一次只是重复报警。判据在 tests/duplicates.test.mjs 的分组用例。
  { id: 'dupes-同源也算重复', file: 'lib/duplicates.js',
    judges: ['duplicates.test.mjs'],
    judgeTests: ['duplicateHintsOf：跨源同链接才算；同源、缺链接、仅标题相同都不算', 'duplicateHints 端点：候选来自别的页、别的源；同源那条不报；读/星标互不影响'],
    from: "row.id !== item.id && row.feedId !== item.feedId",
    to: "row.id !== item.id" },
  // 非 http(s) 的链接（javascript: / mailto: / data:）一律不参与判定：它们不是「可读的原文」，
  // 而且两个 null 链接会把不相干的文章连成一组。判据是归一化样本表里的那几条。
  { id: 'dupes-非 http(s) 链接参与判定', file: 'lib/duplicates.js',
    judges: ['duplicates.test.mjs'],
    judgeTests: ['linkKeyOf：归一化的每一个边界都有一条固定样本（改规则必须同时改这张表）'],
    from: "if (url.protocol !== 'http:' && url.protocol !== 'https:')\n        return '';",
    to: "if (false)\n        return '';" },
  // 候选必须**跨页**查（票据验收项）：退回「只用这一页的条目」时，另一页的兄弟永远看不到，
  // 而界面上只是「提示少了一条」，没有任何报错。判据是端点用例里 b1 不在这一页那一条。
  { id: 'dupes-只查这一页', file: 'lib/endpoints.js',
    judges: ['duplicates.test.mjs'],
    judgeTests: ['duplicateHints 端点：候选来自别的页、别的源；同源那条不报；读/星标互不影响'],
    from: "const candidates = keys.size === 0 ? [] : ctx.store.itemsByLinkKeys([...keys]);",
    to: "const candidates = visible;" },
  // 升级回填必须**归一化**：直接把 link 原样写进 link_key，老条目会因为 ?utm_/#fragment 而永远匹配不上。
  // 判据是 v2→v4 的升级用例（夹具链接带 utm 与 fragment）。
  { id: 'dupes-回填不归一', file: 'lib/storage/db.js',
    judges: ['duplicates.test.mjs'],
    judgeTests: ['v2→v4 升级：只加表与派生列，旧数据一行不动、link_key 回填到位（M5 03 的派生列）'],
    from: "update.run(linkKeyOf(link), id);",
    to: "update.run(link, id);" },
  // 整行是 role=button（点一下就选中 + 标读）：展开提示必须 stopPropagation，
  // 否则「点开看看别的来源」会顺手把这篇标成已读。判据在真 DOM 用例里。
  { id: 'dupes-展开顺手标读', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['跨源重复提示：行内可展开看别的来源，且展开不会把那篇标成已读（M5 03）'],
    from: "onClick: (event) => event.stopPropagation(),",
    to: "onClick: () => {}," },
  // ── M5 04：备份校验器（2026-11-14）──────────────────────────────────────────
  // 校验器是「恢复前唯一的一道闸」，它的三条判定各自要有人看着（判据在 tests/backup-verify.test.mjs）：
  // ① 完整性检查失效 ⇒ 「能打开但页结构坏了」的副本会被当成好备份恢复进去；
  // ② 版本区间放宽 ⇒ 别的插件版本写的库会被本版直接覆盖；
  // ③ 订阅丢失不报 ⇒ 只恢复了库、没恢复 config.json 的形态会被放行（= 订阅全没）。
  { id: 'backup-完整性检查失效', file: 'scripts/verify-backup.mjs',
    judges: ['backup-verify.test.mjs'],
    judgeTests: ['能打开但页结构坏了：必须由 integrity_check 拦住（损坏不都在打开时现形）'],
    from: "if (integrity !== 'ok')",
    to: "if (false)" },
  { id: 'backup-版本区间放行', file: 'scripts/verify-backup.mjs',
    judges: ['backup-verify.test.mjs'],
    judgeTests: ['未知版本：比当前版本新的库拒绝恢复（那是别的插件版本写的）'],
    from: "} else if (version < 1 || version > SCHEMA_VERSION) {",
    to: "} else if (version < 1) {" },
  { id: 'backup-订阅丢了不报', file: 'scripts/verify-backup.mjs',
    judges: ['backup-verify.test.mjs'],
    judgeTests: ['订阅丢了：库里有条目但 config.json 没有订阅 ⇒ 拒绝（与装载路径同一条判据）'],
    from: "if (items !== undefined && items > 0 && feedCount === 0) {",
    to: "if (false) {" },
  // M4 01：候选的相对链接必须按**重定向落点**解析。退回输入 URL 时，站点只要做过一次
  // 301（http→https、加斜杠、换域名），相对候选就被拼到错的 host 上；判据在 subscribe.test.mjs
  // 的「重定向后相对候选按最终页面 URL 解析」。OCCURRENCES 独立实测 = 1（lib/subscribe.js:142）。
  { id: 'discover-候选按最终页面 URL 解析', file: 'lib/subscribe.js',
    judges: ['subscribe.test.mjs'],
    judgeTests: ['发现：重定向后相对候选按**最终页面 URL** 解析', '发现：一次重定向不能把候选升级成可信目标（落点只用于解析，不用于继承信任）'],
    from: 'const declared = discoverFeedUrls(page.body, page.finalUrl);',
    to: 'const declared = discoverFeedUrls(page.body, userUrl);' },
  // 上面那条的**上游**：fetch 的成功回包必须真的交出落点（退回起始 URL 会让它永远拿到原地址）。
  // 这条只能由 fetch.test.mjs 审 —— subscribe.test.mjs 的 fetchImpl 是桩，改不到抓取层。
  { id: 'fetch-成功回包交出最终落点', file: 'lib/feed/fetch.js',
    judges: ['fetch.test.mjs'],
    judgeTests: ['成功回包交出最终落点：跟完重定向后是落点 URL，不是起始 URL'],
    from: 'finalUrl: current',
    to: 'finalUrl: url' },
  { id: 'discover-只认 rel=alternate', file: 'lib/feed/discover.js',
    judges: ['discover.test.mjs'],
    judgeTests: ['只认真正声明 feed 的 link：rel 不对 / type 不对都忽略'],
    from: 'if (!/\\balternate\\b/i.test(rel))', to: 'if (false)' },
  // ⚠️ 2026-10-18：judges 从 client-bundle 改到 keyboard-routing —— 那条变异锚的是 CLIENT 里的
  // 按键路由（`if (view === "list") store.setLayout("expanded")`）。旧 judges 指的 client-bundle 只走
  // 假 React 夹具，从不按 1 键 ⇒ 变异长期「幸存」。按键路由层的判据住在 tests/keyboard-routing.test.mjs。
  { id: 'client-1 键切展开视图', file: 'lib/client.js',
    judges: ['keyboard-routing.test.mjs'],
    judgeTests: ['C4-b 判定：列表页按 1 切 expanded、按 2 切回 list（切错方向时红）'],
    from: 'setLayout("expanded")', to: 'setLayout("list")' },
  { id: 'retention-星标保护', file: 'lib/retention.js',
    judges: ['refresh.test.mjs', 'retention.test.mjs'],
    judgeTests: ['裁剪保护星标：满上限时删未读，星标一条都不动', '裁剪：星标条目永不被删——哪怕它最旧、哪怕超额最多', '裁剪：星标占满时宁可超上限也不删（返回数量少于溢出量）', '裁剪：星标与保持未读的条目一律不动（其余按未读优先删）', '裁剪：全被星标/保持占满时，宁可超上限也不删'],
    from: 'const protectedFromPrune = (row) => row.starred || row.kept;',
    to: 'const protectedFromPrune = (row) => row.kept;' },
  { id: 'retention-未读优先级', file: 'lib/retention.js',
    judges: ['retention.test.mjs'],
    judgeTests: ['裁剪：优先删未读，且从最旧的开始', '裁剪：星标条目永不被删——哪怕它最旧、哪怕超额最多', '裁剪：未读用尽后才轮到已读（已读是最后手段）', '裁剪：星标与保持未读的条目一律不动（其余按未读优先删）'],
    from: 'return [...unread, ...read].slice(0, overflow).map((row) => row.id);',
    to: 'return [...read, ...unread].slice(0, overflow).map((row) => row.id);' },
  { id: 'retention-清理的星标保护', file: 'lib/retention.js',
    judges: ['overview-paging.test.mjs', 'retention.test.mjs', 'store-sqlite.test.mjs'],
    judgeTests: ['逐方法同义性：listCleanupCandidates 在两个适配器上得出同一个最终删除集（候选宽度可以不同）', '显式清理：四个条件缺一不可', 'listCleanupCandidates：SQL 只做成本筛选，判定由 selectCleanup 做出（候选 ⊇ 判定集）'],
    from: '.filter((row) => row.read && !row.starred && !row.kept && row.recency < cutoffIso)',
    to: '.filter((row) => row.read && !row.kept && row.recency < cutoffIso)' },
  { id: 'retention-清理的保持未读保护', file: 'lib/retention.js',
    judges: ['overview-paging.test.mjs', 'retention.test.mjs', 'store-sqlite.test.mjs'],
    judgeTests: ['逐方法同义性：listCleanupCandidates 在两个适配器上得出同一个最终删除集（候选宽度可以不同）', '显式清理：四个条件缺一不可', 'listCleanupCandidates：SQL 只做成本筛选，判定由 selectCleanup 做出（候选 ⊇ 判定集）'],
    // 「保持未读」是用户明确说的「别动它」，与星标同级。2026-11-14 起这条保护住在判据里
    // （此前只写在 SQL 谓词里，判据根本看不见 kept）。少了它，清理会静默删掉用户标记的条目。
    from: '.filter((row) => row.read && !row.starred && !row.kept && row.recency < cutoffIso)',
    to: '.filter((row) => row.read && !row.starred && row.recency < cutoffIso)' },
  // 上限守卫（2026-10-11 修复轮 1 重写）：守卫已从 `maxChars <= 0` 改成 `!(maxChars > 0)`，
  // 为的是把 NaN 一起挡在外面 —— 挡住「整个清单」的那条与挡 NaN 的那条是同一处代码，分成两条变异。
  // ① 去掉「上限非法」这半 ⇒ 上限 0 / 负数会被当成「必须清到 0 字符」，把全部缓存清空。
  { id: 'retention-非法上限保护', file: 'lib/retention.js',
    judges: ['refresh.test.mjs', 'retention.test.mjs'],
    judgeTests: ['全局预算：上限 <= 0 表示未配置，一条都不清（不是「整份清空」）', '正文缓存：未超上限不清；上限非法一律视为不清理', '全局正文预算：上限 <= 0 返回空（未配置 ≠ 整份清空）', '全局正文预算：上限是 NaN 时一条都不清（垃圾上限不得变成「清空整库」）'],
    // from 照**编译产物**的实际形状写（docs/pitfalls.md 一、1.4）：lib/retention.js:47，独立实测 OCCURRENCES=1。
    from: 'if (!(maxChars > 0) || total <= maxChars)',
    to: 'if (total <= maxChars)' },
  // ② 把 `!(maxChars > 0)` 退回成 `maxChars <= 0` ⇒ NaN 穿过守卫（NaN <= 0 为 false），
  //   而 `total <= NaN` 同样是 false ⇒ 判定一路走进淘汰循环，**清空全部条目**。
  //   Task 9 把闸门从单源改成全库之后，同一个洞的爆炸半径从一个源变成了整库。
  //   非等价变异：NaN 下旧守卫返回整份淘汰名单，新守卫返回空。
  { id: 'retention-NaN 上限不得清空', file: 'lib/retention.js',
    judges: ['retention.test.mjs'],
    judgeTests: ['全局正文预算：上限是 NaN 时一条都不清（垃圾上限不得变成「清空整库」）'],
    from: 'if (!(maxChars > 0) || total <= maxChars)',
    to: 'if (maxChars <= 0 || total <= maxChars)' },
  { id: 'list-scroll-视口内判定', file: 'lib/list-scroll.js',
    judges: ['list-scroll.test.mjs'],
    judgeTests: ['单调性：向下移动时目标滚动位置不减小（不会来回跳）'],
    from: 'if (rowTop >= currentTop && rowTop + rowHeight <= currentTop + containerHeight)',
    to: 'if (rowTop > currentTop && rowTop + rowHeight <= currentTop + containerHeight)' },
  { id: 'list-scroll-夹取保护', file: 'lib/list-scroll.js',
    judges: ['list-scroll.test.mjs'],
    judgeTests: ['滚动计算对非法输入免疫（NaN/0/负数不该把滚动条写坏）'],
    // 2026-11-17 重锚：同一行夹取在 clampScrollTop / edgeTopFor / restoreTopFor 出现 3 次，
    // 旧 from 只命中第一处（applyMutation 只 replace 一次）。带上函数签名后唯一。
    from: "export function clampScrollTop(value, maxTop) {\n    if (!Number.isFinite(value))\n        return 0;\n    const ceiling = Number.isFinite(maxTop) && maxTop > 0 ? maxTop : 0;",
    to: "export function clampScrollTop(value, maxTop) {\n    if (!Number.isFinite(value))\n        return 0;\n    const ceiling = maxTop;" },
  { id: 'item-id-guid 优先级', file: 'lib/feed/item-id.js',
    judges: ['parse.test.mjs'],
    judgeTests: ['条目 id 稳定派生：同一输入恒等，不同 guid 不同 id', '身份解析：没有重复时逐条结果与 deriveItemId 完全一致（不改变既有行为）'],
    from: 'const basis = item.id?.trim() || item.link?.trim() ||',
    to: 'const basis = item.link?.trim() ||' },
  { id: 'keys-大写 R', file: 'lib/keys.js',
    judges: ['keys.test.mjs', 'overview-scale.test.mjs'],
    judgeTests: ['键位：r 刷新计数；w/W 已空出且不得被偷偷接管（2026-10-08）', '帮助表逐条反查：每一行声明的动作都必须与实现解析出来的完全一致'],
    from: "case 'r':\n        case 'R':",
    to: "case 'r':" },
  { id: 'keys-大写 F', file: 'lib/keys.js',
    judges: ['keys.test.mjs'],
    judgeTests: ['订阅管理键：f 与 F 都要认（标签写的是「F」）', '帮助表逐条反查：每一行声明的动作都必须与实现解析出来的完全一致'],
    from: "case 'f':\n        case 'F':",
    to: "case 'f':" },
  { id: 'refresh-正文升级判定', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    judgeTests: ['正文升级：内容版本落后时，该源第一轮必须绕开条件请求（否则永远回填不了）'],
    from: 'const needsContentUpgrade = (previous?.contentRevision ?? 1) < CONTENT_REVISION;',
    to: 'const needsContentUpgrade = (previous?.contentRevision ?? 1) > CONTENT_REVISION;' },
  { id: 'refresh-正文不得降级覆盖', file: 'lib/refresh.js',
    judges: ['overview-scale.test.mjs', 'refresh.test.mjs'],
    judgeTests: ['正文回填的反面：源变短时不得用更短的正文覆盖更完整的正文'],
    from: 'if (existing !== undefined && (summary?.length ?? 0) > (existing.summary?.length ?? 0))',
    to: 'if (existing !== undefined)' },
  // 闸门必须认**现行**的 blocks 形态（2026-07 事故：只统计 paragraphs ⇒ 字符数恒为 0 ⇒ 闸门永不触发）。
  // ⚠️ 2026-10-11 修复轮 1 改写锚点：字符计数已随「清算原料」一起搬进 store-sqlite 的
  // articleCharsFromBody（原锚 `chars: articleCharsOf(record.article),` 已从 lib/refresh.js
  // 消失 ⇒ 报「未应用」；docs/pitfalls.md 二、2.7：未应用比幸存更隐蔽，因为它等于这条根本没跑）。
  // 语义不变，仍是「退回只数 paragraphs」。from 照**编译产物**的实际形状写（pitfalls 一、1.4）：
  // lib/store-sqlite.js:296，独立实测 OCCURRENCES=1。
  { id: 'refresh-缓存闸门认 blocks', file: 'lib/store-sqlite.js',
    judges: ['overview-paging.test.mjs', 'overview-scale.test.mjs', 'store-sqlite.test.mjs'],
    judgeTests: ['逐方法同义性：listCleanupCandidates 在两个适配器上得出同一个最终删除集（候选宽度可以不同）', '逐方法同义性：listArticleCacheEntries 与旧实现逐条相等（只交出 { id, chars, fetchedAt }）', '10 万行：cleanup 的候选集由 SQL 选（不再全表），且释放量与删除数如实', 'listCleanupCandidates：SQL 只做成本筛选，判定由 selectCleanup 做出（候选 ⊇ 判定集）', 'listArticleCacheEntries：只交出 { id, chars, fetchedAt }，且 chars 与 articleCharsOf 同口径'],
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
    judges: ['refresh.test.mjs'],
    judgeTests: ['全局预算：每源都没超上限，但合计超了 ⇒ 必须跨源清（按源清算的漏网形态）', '全局预算：清掉的是跨源最旧的那条，不能只盯着清单里的某一个源'],
    from: 'const entries = store.listArticleCacheEntries();',
    to: "const entries = store.listArticleCacheEntries().filter((entry) => store.item(entry.id)?.feedId === store.listFeeds()[0]?.[0])" },
  // 同一处代码的第二条承重点：**必须走只交出 { id, chars, fetchedAt } 的那条取数路径**。
  // 退回「把整表读出来再挑出带正文的」会把每份正文都解出来留在堆里 —— 实测 10 万条 × 8.8 KB
  // 时堆峰值 1865 MB，而 spec §9.3 的验收线是 ≤ 300 MB（超 6.2 倍）。这条守的是**内存契约**：
  // 淘汰名单两条路径算出来一样，所以纯行为断言看不见它，得从取数方式上钉。
  // ⚠️ `to` 里只用产物**已经 import 过**的 articleCharsOf —— 照源码写一个产物里没有的名字，
  // 变异的失败模式会从「缺陷复现」退化成「加载失败」，那不是被抓住（docs/pitfalls.md 二、2.7）。
  { id: 'refresh-正文闸门改走整表', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    judgeTests: ['正文缓存闸门：现行的 blocks 形态同样要被统计到（2026-10-07 修回归）'],
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
    judges: ['refresh.test.mjs'],
    judgeTests: ['永久失败的源不得饿死健康源：S ≥ K 时每一轮都还能抓到新的健康源（复刻真实写规则）', '真装配：1 个源恒 500 时，K=1 的轮转仍能摸到另外两个健康源（失败分支必须盖尝试时间）'],
    // lib/refresh.js:40。这就是**修复前的那份代码**：键退回 lastFetchedAt（= 上次成功）。
    // 永久失败的源永远拿不到它 ⇒ 永远最旧 ⇒ 这类源 ≥ K 个时每轮选中同一批，健康源全停更。
    // 实测 2 条翻红（纯函数复刻 200/20/K=20 与真装配 3 源 / 1 个 500 / K=1），RefErr 0 次。
    from: "    return record.lastAttemptedAt ?? record.lastFetchedAt ?? '';",
    to: "    return record.lastFetchedAt ?? '';" },
  { id: 'refresh-失败的尝试不盖时间', file: 'lib/feed-intent.js',
    judges: ['refresh.test.mjs', 'teardown-race.test.mjs'],
    judgeTests: ['真装配：1 个源恒 500 时，K=1 的轮转仍能摸到另外两个健康源（失败分支必须盖尝试时间）', '启动刷新在飞时 teardown：不得把库关在正在写的刷新底下（无「装载失败 / database is not open」）', '面板触发（RPC）的在飞刷新同样受 teardown 保护：不得写在已关闭的句柄上'],
    // H4 重锚（2026-10-18）：合并规则搬进 feed-intent.js 的 refresh-failure 分支（失败分支忘了盖
    // 时间 ⇒ 防饿死失效）。键的口径（调度键退回只看成功）与这里必须同时成立，各自一条变异。
    // 锚照产物 :53-54 实际字节（无缩进前缀的子串匹配；to = 删掉盖时间那行）。
    from: '            lastAttemptedAt: intent.stamp,\n                lastFailure: intent.reason,',
    to: '                lastFailure: intent.reason,' },
  { id: 'refresh-陈旧度不再回落', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    judgeTests: ['selectStalestFeeds：按 lastAttemptedAt ?? lastFetchedAt 升序取最旧的 K 个，未抓过的排最前（无限陈旧）', '陈旧度调度的饥饿不变式：源数 > K 时，连续轮次内每个源都会被选中（旋转覆盖全部）'],
    // lib/refresh.js:40 的另一半：去掉对 lastFetchedAt 的回落。已有库（Task 2 迁移过来的记录）
    // 只有 lastFetchedAt、没有 lastAttemptedAt ⇒ 去掉回落后它们全被当成「从未尝试过」，
    // 旧订阅会在装载后一次性涌到最前面。非等价变异（老记录与新记录的排序结果不同）。
    // 实测 2 条翻红（陈旧度排序、饥饿不变式），RefErr 0 次。
    from: "    return record.lastAttemptedAt ?? record.lastFetchedAt ?? '';",
    to: "    return record.lastAttemptedAt ?? '';" },
  // ⚠️ 刻意**没有**给 304 分支与 200 分支的 lastAttemptedAt 写入各加一条变异：
  // 那两条是**等价变异**。两个成功分支里 lastFetchedAt 与 lastAttemptedAt 盖的是**同一个 stamp**，
  // 删掉 lastAttemptedAt 之后排序键回落到 lastFetchedAt ⇒ 取值逐字相同 ⇒ 没有任何输入会改变结果。
  // （H4 后分支搬进 lib/feed-intent.js；同理也**没有**给 200 分支的 contentRevision: intent.contentRevision
  // 加变异——它恒等于调用方传入的 CONTENT_REVISION，改成字面量才是真变异，锚在调用方的写法上无意义。）
  // 它们幸存不是测试缺口（判定方法见本文件「正文容器收窄」那条的完整推导）。反过来说：
  // **只有失败分支那条写入是不可回落的**（它没有 lastFetchedAt 可回落）—— 判据就在上面。
  { id: 'refresh-陈旧度排序倒退', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    judgeTests: ['selectStalestFeeds：按 lastAttemptedAt ?? lastFetchedAt 升序取最旧的 K 个，未抓过的排最前（无限陈旧）', '陈旧度调度的饥饿不变式：源数 > K 时，连续轮次内每个源都会被选中（旋转覆盖全部）', 'refreshNow 每轮只抓 refreshFeedsPerRound 个源，且下一轮换一批（接线 + 旋转）', '永久失败的源不得饿死健康源：S ≥ K 时每一轮都还能抓到新的健康源（复刻真实写规则）', '真装配：1 个源恒 500 时，K=1 的轮转仍能摸到另外两个健康源（失败分支必须盖尝试时间）'],
    // lib/refresh.js:71，独立实测 OCCURRENCES=1。排序倒退后取到的是**最新**的 K 个，
    // 而未抓过的源（staleness key = ''，码位最小）从「最前」翻到「最后」⇒ 新建的源再也排不上
    // 第一轮。实测 3 条翻红：陈旧度排序、饥饿不变式、接线（refreshNow 用例）。
    from: 'if (a < b)', to: 'if (a > b)' },
  { id: 'refresh-每轮上限失效', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    judgeTests: ['selectStalestFeeds：上限 <= 0 视为「未配置」⇒ 返回全部，不许解读成「一个都不抓」'],
    // lib/refresh.js:55，独立实测 OCCURRENCES=1。整条守卫失效后 limit=0/负数/NaN 会一路走进
    // slice(0, 0) ⇒ 返回空列表 ⇒ **每一轮一个源都不抓**（所有源永久停更的那个静默失效）。
    // 实测 1 条翻红（「上限 <= 0 视为未配置」），正是守卫那一条。
    //
    // ⚠️ 刻意**没有**「limit ≥ 源数时返回全部」那条变异：它与本守卫的另一半同处一行，但
    //   是**等价变异**——把这一半去掉后仍走 .slice(0, limit)，而 limit ≥ length 时 slice 本来就
    //   返回全部，没有任何输入会改变结果。它幸存的不是测试缺口（判定先例：本文件
    //   「正文容器收窄」那条的完整推导）。它是快路径，不是行为分支。
    from: 'if (!(limit > 0) || limit >= feeds.length)', to: 'if (false)' },
  // ⚠️ 2026-10-15（H2）只改了 file：这条的代码搬进 lib/lifecycle.js，from 逐字未变（
  //   产物 lib/lifecycle.js:126，独立实测 OCCURRENCES=1）。
  { id: 'refresh-取源退回全量', file: 'lib/lifecycle.js',
    judges: ['refresh.test.mjs'],
    judgeTests: ['refreshNow 每轮只抓 refreshFeedsPerRound 个源，且下一轮换一批（接线 + 旋转）', '真装配：1 个源恒 500 时，K=1 的轮转仍能摸到另外两个健康源（失败分支必须盖尝试时间）'],
    // 退回「全量交出去」= 本任务要修的病象原样保留
    // （200 源 × 15s ÷ 并发 = 600s 一轮），而 selectStalestFeeds 自身的单测**全绿** ——
    // 这条证明「接线」那一层必须有独立断言看着（挑选对了却没生效是本仓库反复踩到的形态）。
    // 实测 1 条翻红（refreshNow 每轮只抓 K 个）。
    from: 'const subscriptions = selectStalestFeeds(target.listFeeds(), config.refreshFeedsPerRound);',
    to: 'const subscriptions = target.listFeeds().map(([feedId]) => feedId);' },
  { id: 'config-每轮取源默认无界', file: 'lib/config.js',
    judges: ['refresh.test.mjs'],
    judgeTests: ['refreshFeedsPerRound 的默认值必须是个具体条数（0 / Infinity = 把「一轮 600s」放回来）'],
    // lib/config.js:20，独立实测 OCCURRENCES=1。把默认值改成 0 之后**别的用例全绿** —— 因为
    // selectStalestFeeds 把 0 解读成「未配置 ⇒ 抓全部」（那是安全侧），于是「一轮 600s」这条
    // 缺陷就借默认值回来了，而且没有任何断言会喊。这正是本任务最容易被回退的形态，所以
    // 单独拿 tests/refresh.test.mjs 的「默认值必须是个具体条数」看着它。
    from: 'refreshFeedsPerRound: z.number().default(20)',
    to: 'refreshFeedsPerRound: z.number().default(0)' },
  { id: 'domain-rebuildItem 的 omit', file: 'lib/domain.js',
    judges: ['domain.test.mjs', 'refresh.test.mjs', 'unread-accounting.test.mjs'],
    from: 'if (change.omit?.includes(field) === true)',
    to: 'if (false)' },
  { id: 'item-id-撞车即不可信', file: 'lib/feed/item-id.js',
    judges: ['parse.test.mjs'],
    judgeTests: ['身份解析：id 重复且 URL 也相同 ⇒ 是源里重复列出的同一条，保持同一个 id 交给下游去重'],
    from: 'new Set(group.map((index) => linkOf[index])).size < 2', to: 'false' },
  // 身份分叉（2026-10-09，用户实测「同一篇文章两条」）：这四条判定是修复的全部承重点，
  // 少一条就退回病象——所以逐个改坏，看 tests/identity.test.mjs 有没有人喊。
  { id: 'item-id-链接反查认回老身份', file: 'lib/feed/item-id.js',
    judges: ['identity.test.mjs'],
    judgeTests: ['分叉回归：源把 guid 换成同一篇文章的另一种写法 ⇒ 不得变成两条（用户实测的病象）', '分叉回归：guid 整条消失（退到链接派生）也不得变成两条', '撞车兜底仍生效，且被认回的那条不被同响应里的另一条挤掉（不变量 2 与认回身份的交互）'],
    from: 'known?.idOf(linkOf[index])', to: 'undefined' },
  { id: 'item-id-退级不得再用源 id', file: 'lib/feed/item-id.js',
    judges: ['parse.test.mjs'],
    judgeTests: ['身份解析：同一响应里 id 重复但 URL 不同 ⇒ 不信源给的 id，退到 URL（不变量 2）', '身份解析：三条里两条同 URL、一条不同 ⇒ 只重算撞车组，同 URL 的仍是同一条'],
    from: 'if (options.includeSourceId !== false)', to: 'if (true)' },
  { id: 'item-id-认回身份要有旁证', file: 'lib/feed/item-id.js',
    judges: ['identity.test.mjs'],
    judgeTests: ['身份不得被抢：源拿老文章的 guid 发新文章 ⇒ 新文章必须换身份，不许顶掉老条目'],
    from: 'return record === undefined || corroborates(record, items[index]);', to: 'return true;' },
  { id: 'identity-幸存者取最早一条', file: 'lib/identity-repair.js',
    judges: ['identity.test.mjs'],
    judgeTests: ['身份修复：同源同链接的重复被合并，用户状态与正文一律保住', '身份修复：链接为空的条目不参与合并（否则一堆空链接会被揉成一条）'],
    from: 'a.fetchedAt === b.fetchedAt ? a.id.localeCompare(b.id) : a.fetchedAt.localeCompare(b.fetchedAt))',
    to: 'a.fetchedAt === b.fetchedAt ? a.id.localeCompare(b.id) : b.fetchedAt.localeCompare(a.fetchedAt))' },
  { id: 'identity-空链接不参与合并', file: 'lib/identity-repair.js',
    judges: ['identity.test.mjs'],
    judgeTests: ['身份修复：同源同链接的重复被合并，用户状态与正文一律保住', '身份修复：幂等，再跑一次无事可做（每次打开域都会跑）', '身份修复：链接为空的条目不参与合并（否则一堆空链接会被揉成一条）', '身份修复：幸存者判据与遍历顺序无关（同刻按 id 定序）'],
    from: "const link = row.link.trim();\n        if (link === '')",
    to: "const link = row.link.trim();" },
  { id: 'identity-合并保住已读态', file: 'lib/identity-repair.js',
    judges: ['identity.test.mjs'],
    judgeTests: ['身份修复：同源同链接的重复被合并，用户状态与正文一律保住'],
    from: 'readAt: keep.readAt ?? extra.readAt,', to: 'readAt: extra.readAt,' },
  { id: 'identity-合并保住星标', file: 'lib/identity-repair.js',
    judges: ['identity.test.mjs'],
    judgeTests: ['身份修复：同源同链接的重复被合并，用户状态与正文一律保住'],
    from: 'starred: keep.starred || extra.starred,', to: 'starred: keep.starred,' },
  { id: 'retention-保持未读不裁剪', file: 'lib/retention.js',
    judges: ['retention.test.mjs'],
    judgeTests: ['裁剪：星标与保持未读的条目一律不动（其余按未读优先删）', '裁剪：全被星标/保持占满时，宁可超上限也不删'],
    from: 'row.starred || row.kept',
    to: 'row.starred' },
  { id: 'fetch-重定向目标不可信', file: 'lib/feed/fetch.js',
    judges: ['fetch.test.mjs'],
    judgeTests: ['出网策略：重定向的目标一律按不可信处理（哪怕起始地址可信）'],
    from: 'const hopBlocked = await resolvedBlockedReason(next, false);',
    to: 'const hopBlocked = await resolvedBlockedReason(next, trusted);' },
  { id: 'fetch-解析层内网拦截', file: 'lib/feed/fetch.js',
    judges: ['fetch.test.mjs'],
    judgeTests: ['出网策略：域名解析到内网地址也要拒（rebinding 的前置拦截）'],
    from: 'const privateAddress = addresses.find((address) => isPrivateHost(address));',
    to: 'const privateAddress = undefined;' },
  { id: 'client-键解析短路', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'scroll-dom.test.mjs'],
    from: 'const action = resolveReaderKey(event.key, event.shiftKey);',
    to: "const action = 'none';" },
  { id: 'client-可见性守卫恒真', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'scroll-dom.test.mjs'],
    // ⚠️ 2026-10-15（C1）重锚：键盘路由搬进 keyboard-routing.ts 后，bundle 里这行是 ctx.root。
    from: 'if (ctx.root === null || ctx.root.getClientRects().length === 0)',
    to: 'if (true)' },
  { id: 'client-不注册监听器', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'scroll-dom.test.mjs'],
    from: 'document.addEventListener("keydown", onKeyDown);',
    to: ';' },
  // 滚动容器这一族（2026-10-09 修）。变异目标是**按键时刻现取容器**这条机制：
  // 它一旦退回「渲染期取一次」，详情页就会重新变成静默 no-op，而旧的假 React 夹具对此全绿。
  // 判据由 tests/scroll-dom.test.mjs 用真实 React + jsdom 看着（那一层才能表达这个失效）。
  { id: 'client-容器退回渲染期捕获', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    // ⚠️ 2026-10-15（C1）重锚：搬进 keyboard-routing.ts 后是 ctx.root。
    from: 'const container = ctx.root === null ? null : ctx.root.querySelector(selector);',
    to: 'const container = null;' },
  // ⚠️ 变异模式必须照**编译产物**的实际形状写（多行 if、单引号），
  // 照源码格式写会「未应用」——那等于这条变异根本没跑，比幸存更隐蔽。
  { id: 'client-容器选择器不分视图', file: 'lib/list-scroll.js',
    judges: ['list-scroll.test.mjs'],
    judgeTests: ['容器选择器：列表/正文各一个，其他视图没有容器（订阅管理页不该刷警告）'],
    from: "return '[' + SCROLL_ATTR + '=\"article\"]';",
    to: "return '[' + SCROLL_ATTR + '=\"list\"]';" },
  { id: 'client-正文行高量错对象', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['详情页 n/p 按「正文一行」滚动，而不是回落到列表行高（48px = 一行半）', '正文页阅读偏好：时长标「估算」、字号/栏宽落到正文、写盘发的是整份偏好'],
    from: 'const sample = box.querySelector("p") ?? box;',
    to: 'const sample = box;' },
  { id: 'client-半页退化成整页', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['详情页 d / shift+d 翻半页（整屏的一半，且夹得住边界）'],
    from: "? halfPageTop(box.scrollTop, box.clientHeight, maxTop, direction)",
    to: "? pageTop(box.scrollTop, box.clientHeight, maxTop, direction)" },
  { id: 'client-换文章不归零', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['切换文章后阅读位置归零（DOM 节点被复用，scrollTop 不会自己重置）', '阅读进度：切走再回来接着读、滚动不写盘、离开时落盘（M5 02）'],
    from: 'box.scrollTop = 0;',
    to: 'box.scrollTop = box.scrollTop;' },
  // 导航轴（2026-10-10 两列布局任务 2）。这三条是「源 x filter 叠加」的全部承重点：
  // 叠加判定失效 ⇒ 退化成只看 filter；不重落选中 ⇒ j/k 在看不见的条目上无反应；
  // perFeedUnread 不落 state ⇒ 左栏角标无数据。判据由 tests/nav-selection.test.mjs 看着。
  { id: 'client-导航轴叠加失效', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs', 'nav-selection.test.mjs', 'scroll-dom.test.mjs'],
    from: 'if (state.navSelection.kind === "feed" && item.feedId !== state.navSelection.feedId) return false;',
    to: ';' },
  { id: 'client-切源不重落选中', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'nav-selection.test.mjs', 'scroll-dom.test.mjs'],
    // 2026-11-16 重锚：06a 把 relocateSelection 搬进 list-actions.ts 后，闭包里只剩 get()。
    from: 'set({ selectedId: get().items.filter(inScope)[0]?.id });',
    to: ';' },
  { id: 'client-perFeedUnread 不落 state', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs', 'scroll-dom.test.mjs', 'unread-accounting.test.mjs'],
    // 2026-11-17 重锚：perFeedUnread 的写入在 applyOverview 与搜索分支各一处；
    // 旧 from 只命中第一处。带上 applyOverview 的整段 set 后唯一。
    from: "\t\t\t\tset({\n\t\t\t\t\titems: overview.items,\n\t\t\t\t\tfeeds: overview.feeds,\n\t\t\t\t\tfolders: overview.folders,\n\t\t\t\t\ttags,\n\t\t\t\t\tunread: overview.unread,\n\t\t\t\t\tperFeedUnread: overview.perFeedUnread,",
    to: "\t\t\t\tset({\n\t\t\t\t\titems: overview.items,\n\t\t\t\t\tfeeds: overview.feeds,\n\t\t\t\t\tfolders: overview.folders,\n\t\t\t\t\ttags,\n\t\t\t\t\tunread: overview.unread,\n\t\t\t\t\tperFeedUnread: {}," },
  // setFilter 的「源 x filter」语义（评审 Important 2）。既有 setFilter 用例全跑在 virtual 状态
  // 下、源条件恒真 ⇒ 这条路径零覆盖。退回「只按 filter 算第一条」后，已选中某源时切 filter
  // 会把 selectedId 送到源外条目 —— 判据是 tests/nav-selection.test.mjs 的第 6 条用例。
  { id: 'client-setFilter 丢掉源条件', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs'],
    judgeTests: ['已选中某源时切 filter：selectedId 落在该源内第一条，而不是全表第一条', '「源 × filter 叠加」下打开虚拟视图行：filter 生效，而生效的导航项仍是那个源（叠加不塌缩）'],
    // ⚠️ 2026-10-10 任务 6 返工：setFilter 提出具名函数并顺带同步 navCursor，产物形状随之变化，
    // 本条 from 原为 'set({ filter });\n...relocateSelection();' ⇒ 变成「未应用」。
    // 照新产物重写（独立实测 OCCURRENCES=1），语义仍是原来的那条：**丢掉源条件**、selectedId 落全表第一条。
    from: '\t\t\t\tset({\n\t\t\t\t\tfilter,\n\t\t\t\t\tnavCursor: {\n\t\t\t\t\t\tkind: "filter",\n\t\t\t\t\t\tfilter\n\t\t\t\t\t}\n\t\t\t\t});\n\t\t\t\trelocateSelection();',
    to: '\t\t\t\tset({\n\t\t\t\t\tfilter,\n\t\t\t\t\tnavCursor: {\n\t\t\t\t\t\tkind: "filter",\n\t\t\t\t\t\tfilter\n\t\t\t\t\t}\n\t\t\t\t});\n\t\t\t\tconst list = filter === "all" ? state.items : state.items.filter((i) => filter === "unread" ? i.readAt === void 0 : i.starred);\n\t\t\t\tset({ selectedId: list[0]?.id });' },
  // 「再选同源 = 取消」与「virtual 归位 filter」（评审 Minor 2）：两条判定各一条变异。
  // 前者失效 ⇒ 左栏点亮的项再点一次不回聚合视图；后者失效 ⇒ 虚拟视图留着一套过滤器残留，
  // 变成与 filter 并存的第二套过滤状态（本任务实现时第一遍就漏了后者，靠测试才抓到）。
  { id: 'client-再选同源不取消', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs', 'scroll-dom.test.mjs'],
    judgeTests: ['再选中同一个源 = 取消选中，回到虚拟视图', '点击某个源：右栏列表只剩该源条目'],
    from: 'if (sameNavSelection(current, next) || next.kind === "virtual") set({',
    to: 'if (next.kind === "virtual") set({' },
  { id: 'client-virtual 不归位 filter', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs'],
    judgeTests: ['虚拟视图与既有 setFilter 等价，不留两套状态'],
    from: 'navSelection: { kind: "virtual" },\n\t\t\t\t\tfilter: "all"',
    to: 'navSelection: { kind: "virtual" }' },
  // 切作用域必须退出正文（R2 票 03，2026-11-19）：selectNav（源/文件夹/标签，含「再选同一个 = 取消」）
  // 与 setFilter（未读/星标/全部）共用这一个入口。去掉它，正文里切作用域会继续显示作用域外的旧文章。
  // 判据是 scroll-dom 的四条「正文视图下…」用例；搜索提交自己回列表，不由本条承担（也不重复实现）。
  { id: 'client-切源不回列表', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: [
      '正文视图下点另一个源：回到列表、旧文章不再显示，且不额外标读/取数',
      '正文视图下再点同一个源（取消选中）：同样回到列表',
      '正文视图下点文件夹 / 标签：同样回到列表、清空旧文章',
      '正文视图下切「未读 / 星标」过滤：回到列表',
    ],
    from: '\t\t\tconst leaveArticleForScope = () => {\n\t\t\t\tif (get().view === "article") set({\n\t\t\t\t\tview: "list",\n\t\t\t\t\tarticle: void 0\n\t\t\t\t});\n\t\t\t};',
    to: '\t\t\tconst leaveArticleForScope = () => {};' },
  // 每源未读数的**键域**（2026-10-10）。左栏角标按 feeds 表逐行渲染，键域必须严格 = feeds 表：
  // 删掉「以 feeds 表铺 0」后，0 未读的源会丢键，那一行变成「角标空白」而不是「角标 0」——
  // 界面上无从分辨，是最贵的那类沉默失败。非等价变异：丢键后取值变 undefined，两条测试会红。
  // ⚠️ 2026-10-10 任务 9：本条原锚在 lib/endpoints.js 的 'perFeedUnread[feed.id] = 0;'。
  // 该循环已收敛进 shared.ts 的 countUnreadPerFeed（口径唯一化的同一件事），产物随之变化 ⇒
  // 原锚变「未应用」（docs/pitfalls.md 二、2.7：未应用比幸存更隐蔽）。照新产物重写，
  // 独立实测 lib/shared.js:41 OCCURRENCES=1，语义仍是原来那条：**丢键域**（0 未读的源不留键）。
  { id: 'endpoints-perFeedUnread 键域铺 0', file: 'lib/unread.js',
    judges: ['overview-paging.test.mjs', 'store-sqlite.test.mjs'],
    judgeTests: ['逐方法同义性：unreadPerFeed 与旧实现逐键相等（0 未读的源两边都留 0 值键）', 'unreadPerFeed：与 unread.ts 的唯一口径在同一夹具上逐键相等，且键域 = 传入的 feeds 表（Ruling P-6）'],
    from: 'unread[feedId] = 0;', to: ';' },
  // 左栏（2026-10-10 两列布局任务 3）。这两条是本任务新增的关键判定，各一条变异：
  // 角标门失效 ⇒ 规格不变量 8 的「三者同消」在左栏漏掉（隐藏计数后左栏还留着数字）；
  // 角标数据源换回 items 派生 ⇒ items 按 maxItemsShown 截断，角标与顶栏总数对不上。
  // 判据由 tests/scroll-dom.test.mjs 的「隐藏未读计数时左栏角标也消失」看着。
  { id: 'client-左栏角标无视 showUnread', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['隐藏未读计数时左栏角标也消失（GR spec 不变量 8）'],
    // ⚠️ `to` 必须**保留展开运算符**：2026-10-11 终检评审 B1 修好分类器后，这条被当场抓成
    //   「崩了（SyntaxError）」—— 它原先写成不带 `...` 的对象字面量，而在对象字面量里少一个 `...`
    //   会让那对花括号被解析成**块语句** ⇒ 产物**加载期**就语法错、整个 client 组一起红。
    //   **那正是这个分类器要堵的假通过**：崩了被当成「抓到」，而没有任何断言真的看见「角标无视
    //   showUnread」。补回 `...` 后红条数才代表这条变异的本义（实测 3 条翻红）。
    // 2026-11-20 重锚（R1 评审 P1）：角标条件加上了「账目已知」（unreadKnown）。
    from: '...showUnread && unreadKnown ? { "data-rss-nav-badge": String(unread) } : {},',
    to: '...{ "data-rss-nav-badge": String(unread) },' },
  { id: 'client-左栏角标改用派生', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['左栏渲染：虚拟视图三行 + 每个订阅源一行', '隐藏未读计数时左栏角标也消失（GR spec 不变量 8）'],
    from: 'const unread = perFeedUnread[feed.id];',
    to: 'const unread = 0;' },
  // 折叠必须「不占宽度」（任务 3 的精确取值）：退回「渲染但宽 0」会留下一条右边框的缝，
  // 而要求是「收起 = 这一列不存在」。判据由 scroll-dom 的左栏用例看着（左栏容器应整个消失）。
  { id: 'client-折叠时左栏仍渲染', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['过滤三连只显示一处：左栏可见时顶栏不重复（收起左栏则回落到顶栏）', '折叠左栏：容器整个从 DOM 消失（不是 width:0 留一条缝）', 'u 键折叠/展开左栏：走真实按键路径，且正文页不接管（与 o 键同一条裁决）'],
    // from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4 记的那条坑；本次实测踩到）：
    // 产物是 `children: [state.navVisible && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FeedNav, {`
    // （lib/client.js:1931，行首 6 个 tab），不是源码里的 `{state.navVisible && (<FeedNav`。
    // 该串是产物里唯一的 navVisible 条件：另两处是默认值 navVisible: true 与 !state.navVisible。
    // 改成恒真 ⇒ 折叠后左栏仍然渲染，`[data-rss-nav]` 还在 DOM 里 —— 折叠的判据就是「这个容器整个消失」。
    // 2026-11-17 重锚：state.navVisible 还有 !state.navVisible 那一处；带上 children 前缀后唯一。
    from: "children: [state.navVisible && /* @__PURE__ */",
    to: "children: [true && /* @__PURE__ */" },
  // 滚动键只作用右栏（2026-10-10 两列布局任务 4）。左栏同样 `overflowY: auto`，
  // 所以「按键不会去滚左栏」不取决于它能不能滚，而取决于**它不带 data-rss-scroll** 这个标记判定：
  // 一旦左栏也被打上该属性，querySelector 取到的第一个匹配就是它（FeedNav 在文档序里靠前），
  // n/p/空格 便去滚左栏而右栏纹丝不动 —— 读者看到的是「按键毫无反应」。
  // 判据由 tests/scroll-dom.test.mjs 的「滚动不误命中左栏」看着（纯函数层看不见这层错位）。
  { id: 'client-左栏也被标成滚动容器', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['滚动不误命中左栏：n/p 与空格只滚右栏', 'C4-b 判定：行高量不到（offsetHeight=0）时按列表兜底 48 滚，而不是按 0 滚（量错对象的「有值但不正确」是实测事故）', '刷新搜索后相同选中项移出视口时，列表跟随其新位置', '文件夹浏览：空目录可见，进入后只显示成员条目，空目录有明确空状态'],
    // from 照**编译产物**的真实形状写：lib/client.js:634 的 `"data-rss-nav": "",` 是全产物唯一一处
    // （左栏容器只此一个，见 docs/pitfalls.md 一、1.4）。
    from: '"data-rss-nav": "",',
    to: '"data-rss-nav": "", "data-rss-scroll": "list",' },
  // 按键守卫不许依赖环境全局（2026-10-09）。变异回 instanceof 后，
  // 判据是 tests/scroll-dom.test.mjs 的「本 realm 没有 HTMLElement 时快捷键照样能用」。
  { id: 'client-守卫改回环境全局', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['按键守卫不依赖环境全局：本 realm 没有 HTMLElement 时，快捷键照样能用'],
    from: 'function isElementNode(node) {',
    to: 'function isElementNode(node) { return node instanceof HTMLElement;' },
  // 右下角「回顶部 / 去底部」（2026-10-09）。两条各钉一个方向：
  // 反了或都不动，tests/scroll-dom.test.mjs 的箭头用例必须翻红。
  { id: 'client-去底部反成回顶部', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['右下角箭头按钮：上方回顶部、下方去底部（作用在真实滚动容器上）', '点「↓去底部」后内容长高（懒加载图片进场）：必须继续贴底，而不是差一截', '用户自己滚走后就解除「贴底」：不该把读者硬拽回去', '文件夹展开与折叠同步键盘行序，汇总未读且保留订阅选择'],
    from: 'function edgeTopFor(maxTop, edge) {',
    to: 'function edgeTopFor(maxTop, edge) { return 0;' },
  { id: 'client-箭头按钮不接容器', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['切换文章后阅读位置归零（DOM 节点被复用，scrollTop 不会自己重置）', '右下角箭头按钮：上方回顶部、下方去底部（作用在真实滚动容器上）', '点「↓去底部」后内容长高（懒加载图片进场）：必须继续贴底，而不是差一截', '用户自己滚走后就解除「贴底」：不该把读者硬拽回去', '阅读进度：切走再回来接着读、滚动不写盘、离开时落盘（M5 02）'],
    from: 'boxRef.current = node;',
    to: 'boxRef.current = null;' },
  // 「点 ↓ 之后贴住底部」（2026-10-09，用户实测：新文章首点到不了底）。
  // 病因是懒加载图片进场把内容撑高，而 scrollTop 留在原地；判据在 scroll-dom 的第 10 条用例。
  { id: 'client-到底后不贴住底部', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['点「↓去底部」后内容长高（懒加载图片进场）：必须继续贴底，而不是差一截'],
    from: 'if (pinnedRef.current)',
    to: 'if (false)' },
  // 用户滚走必须解除贴底 —— 少了它会把读者的滚动硬拽回底部。
  { id: 'client-用户滚走不解除贴底', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['用户自己滚走后就解除「贴底」：不该把读者硬拽回去'],
    from: 'if (Math.abs(box.scrollTop - expectedTopRef.current) > 2)',
    to: 'if (false)' },
  // 键盘流（2026-10-10 两列布局任务 6）：u 归还 GR 原义「左栏显隐」、向上半页改由 shift+d 接盘。
  // 两条都是**决策级**判定（改坏 = 用户肌肉记忆与界面标签当场对不上），各一条变异。
  // 判据：tests/keys.test.mjs 的「u 归还 GR 原义」「半页：d 向下、shift+d 向上」；
  // 接线面另有 tests/scroll-dom.test.mjs 的「u 键折叠/展开左栏」看着。
  { id: 'keys-u 改回向上半页', file: 'lib/keys.js',
    judges: ['keys.test.mjs'],
    judgeTests: ['半页：d 向下、shift+d 向上（u 于 2026-10-10 归还 GR 原义）', 'u 归还 GR 原义：左栏显隐', '帮助表逐条反查：每一行声明的动作都必须与实现解析出来的完全一致'],
    // from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4）：lib/keys.js:40 的
    // `        case 'u': return 'toggleNav';` 是全产物唯一一处（独立实测 OCCURRENCES=1）。
    from: "case 'u': return 'toggleNav';",
    to: "case 'u': return 'halfPageUp';" },
  { id: 'keys-shift+d 不接盘上半页', file: 'lib/keys.js',
    judges: ['keys.test.mjs'],
    judgeTests: ['半页：d 向下、shift+d 向上（u 于 2026-10-10 归还 GR 原义）', '向上半页改由 shift+d 承担', '帮助表逐条反查：每一行声明的动作都必须与实现解析出来的完全一致'],
    // lib/keys.js:38，同样唯一（独立实测 OCCURRENCES=1）。
    // 改成恒向下半页 ⇒ 上半页再无入口，「接盘」这句话在键位层就落空。
    from: "case 'd': return shift === true ? 'halfPageUp' : 'halfPageDown';",
    to: "case 'd': return 'halfPageDown';" },
  // 接线面（四条）：键位**解析对了但 client 没接线**这一层是本仓库多次踩到的形态
  // （任务 6 若只写 keys 断言就会漏）。判据都是 tests/scroll-dom.test.mjs 里走真实按键路径的新用例。
  { id: 'client-u 键不接左栏显隐', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['u 键折叠/展开左栏：走真实按键路径，且正文页不接管（与 o 键同一条裁决）', '左栏折叠时 shift+n/p/o 不生效：不许改一个看不见的导航'],
    from: 'run(() => store.toggleNav());',
    to: 'run(() => {});' },
  // ── 返工新增（2026-10-10，按规格 §2.4 把「移动」与「打开」拆开）──────────────────────
  // 第一版把两者合成一步（移动即 selectNav 打开它），shift+o 因此只剩「取消」，规格无从满足。
  // 拆开之后这条分工有三个独立的承重点，各一条变异：
  //   ① 移动键不许去改作用域（改回「移动即打开」）
  //   ② 移动不许顺带换 filter（半塌缩：光标走了、生效的也走了）
  //   ③ 打开键必须真的落到作用域（光标算对了却不动右栏 = shift+o 变摆设）
  { id: 'client-shift+n 改成「移动即打开」', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['shift+n / shift+p 在左栏导航里移动选中（不是右栏文章列表的 j/k）', 'shift+o 打开光标所在行 = 等价于点击它（虚拟视图 → setFilter，源 → selectNav）', '文件夹展开与折叠同步键盘行序，汇总未读且保留订阅选择', '标签行纳入 Shift+N/P/O 的可见行序，空标签也可到达'],
    // from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4）。lib/client.js:2002，
    // 独立实测 OCCURRENCES=1。改回第一版行为后，press('N', true) 当场换掉右栏列表，
    // 判据「shift+n 移动光标时不改变右栏列表内容与 filter」立刻翻红。
    from: 'run(() => store.moveNavCursor(action === "navNext" ? 1 : -1));',
    to: 'run(() => { store.moveNavCursor(action === "navNext" ? 1 : -1); const n = store.get().navCursor; if (n.kind === "feed") store.selectNav({ kind: "feed", feedId: n.feedId }); else store.setFilter(n.filter); });' },
  { id: 'client-移动光标顺带换 filter', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs', 'scroll-dom.test.mjs'],
    judgeTests: ['moveNavCursor 只动光标：navSelection / filter / selectedId / visible() 一律不变', 'openNavCursor 才落作用域：源行 → selectNav；虚拟视图行 → setFilter（等同鼠标点击）', 'shift+n / shift+p 在左栏导航里移动选中（不是右栏文章列表的 j/k）', 'shift+o 打开光标所在行 = 等价于点击它（虚拟视图 → setFilter，源 → selectNav）'],
    // lib/client.js:598，独立实测 OCCURRENCES=1。这是「移动」那半边更隐蔽的半塌缩形态：
    // 光标确实走了、可 filter 也跟着走（读者看到右栏内容变了）。整条判定的要点是「光标变了而
    // 生效视图没变」，半塌缩同样得被守。
    from: 'set({ navCursor: next });',
    // 2026-11-15 重锚：变异体落在 nav-actions.ts 的作用域里，那里没有 state 绑定（只有 get()）。
    to: 'set({ navCursor: next, filter: next.kind === "filter" ? next.filter : get().filter });' },
  { id: 'client-打开光标不动作用域', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs', 'scroll-dom.test.mjs'],
    judgeTests: ['「源 × filter 叠加」下打开虚拟视图行：filter 生效，而生效的导航项仍是那个源（叠加不塌缩）', 'shift+o 打开光标所在行 = 等价于点击它（虚拟视图 → setFilter，源 → selectNav）'],
    // lib/client.js:618，独立实测 OCCURRENCES=1。这是「打开」那半边：光标算对了却落不到作用域。
    from: 'setFilter(cursor.filter);',
    to: ';' },
  // 未读账目守恒（2026-10-10 两列布局任务 5）。这两条守的是**客户端**这一侧的每源账目：
  // 左栏角标读 state.perFeedUnread、顶栏读 state.unread（index.tsx:374 / :385），
  // 只动一边就会出现「角标还写着 3、顶栏已经 2」——界面上自相矛盾且无报错。
  // 判据是 tests/unread-accounting.test.mjs 的两条客户端用例（修前实测 2 条翻红）。
  { id: 'client-markRead 不动每源账目', file: 'lib/client.js',
    judges: ['unread-accounting.test.mjs'],
    judgeTests: ['客户端：打开一条的回包到达前，该源角标已当场 -1（乐观更新不许丢）'],
    // 2026-11-16 重锚：06b 把六个账目动作搬进 list-actions.ts，闭包里只剩 get()。
    from: '[target.feedId]: Math.max(0, (get().perFeedUnread[target.feedId] ?? 0) - 1)',
    // 2026-11-16 评审修复：搬家后 list-actions 里没有 state（原 to 会 ReferenceError，属「崩了」假通过）。
    to: '[target.feedId]: get().perFeedUnread[target.feedId]' },
  // 增量助手是 markAllRead / undoMarkAll 的账目来源。把「按宿主下发的键铺 0」删掉后，
  // 重算结果只剩空表 ⇒ 0 未读的源丢键，左栏那一行的角标变「空白」而不是「0」——
  // 与任务 1 裁决的键域契约（键域严格 = feeds 表）同一条，是最贵的那类沉默失败。
  { id: 'client-每源账目丢键域', file: 'lib/client.js',
    judges: ['overview-scale.test.mjs', 'unread-accounting.test.mjs'],
    judgeTests: ['客户端：按下「全部标已读」的回包到达前，角标已按本批当场收起（乐观更新不许丢）'],
    from: 'const next = { ...state.perFeedUnread };',
    to: 'const next = {};' },
  // 严禁退回「按本地 items 整体重算」：客户端只拿得到 maxItemsShown（300）条，
  // 宿主按每源 500 条的**全量表**记账（src/config.ts）。整体重算会把截断之外的账抹掉，
  // 角标 0 / 顶栏 17 —— 正是任务 1 拒绝「客户端派生 perFeedUnread」的同一条理由。
  // 判据是 tests/unread-accounting.test.mjs 的两条截断用例（修前实测 2 条翻红）。
  { id: 'client-每源账目整体重算', file: 'lib/client.js',
    judges: ['unread-accounting.test.mjs'],
    judgeTests: ['客户端：按下「全部标已读」的回包到达前，角标已按本批当场收起（乐观更新不许丢）'],
    from: 'next[feedId] = Math.max(0, next[feedId] + delta);',
    to: 'next[feedId] = Math.max(0, state.items.filter((i) => i.feedId === feedId && i.readAt === void 0).length);' },
  // ── 视图记忆持久化（2026-10-10 两列布局任务 7）────────────────────────────────
  // 这一族的判据几乎全在 tests/nav-persistence.test.mjs（那边同时钉了「老域没有 global
  // 也能打开」这条必须实测的路径）。每条 from 都照**编译产物的实际形状**写、并已独立实测
  // OCCURRENCES=1（docs/pitfalls.md 一、1.4 / 二、2.7 记的就是照源码猜 from 的后果）。
  // ① 读侧的形状校验失效 ⇒ 认不出的值被原样吃到 state 里（「回落」这条承诺当场作废）
  { id: 'persist-读侧不校验形状', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    judgeTests: ['持久化值不可信时（未知 feedId / 非法 shape）回落默认值且不抛错'],
    from: '(isKnownFeed === void 0 || isKnownFeed(selection["feedId"]))',
    to: 'true' },
  // ② filter 枚举校验失效 ⇒ 非法 filter 被当成真的过滤条件用（右栏内容与按钮状态各说各话）
  { id: 'persist-filter 不校验枚举', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    judgeTests: ['持久化值不可信时（未知 feedId / 非法 shape）回落默认值且不抛错'],
    from: 'FILTERS.includes(filterRaw) ? filterRaw : DEFAULT_VIEW_PREFERENCES.filter',
    to: 'filterRaw ?? DEFAULT_VIEW_PREFERENCES.filter' },
  // ③ 恢复不许盖掉用户在异步窗口里做的手势（时序守卫）。
  // R2 起这条判据同时看守阅读位置：选中（j/k、点行、打开条目）与滚动都算「用户已动手」，
  // 迟到的恢复必须整份让位。此前为 R2 单独加过一条同 from/to 的 client-恢复覆盖用户手势，
  // 它是同一条判定的第二份条目（重复变异），判据已并入这里，不再各守一半。
  { id: 'persist-恢复盖掉用户手势', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs', 'scroll-dom.test.mjs'],
    judgeTests: [
      '恢复是异步的：用户在它到达之前的手势不会被旧记忆盖掉（整份让位）',
      '阅读位置：恢复到达前用户先选了另一行 ⇒ 恢复整份让位，不把选中拽回去',
      'R2-01 恢复迟到：用户先选的行不被覆盖',
      '列表滚动位置：恢复到达前用户已滚动 ⇒ 选中与滚动都不被旧记忆覆盖',
      'R2-02 恢复到达前用户已滚动：旧记忆的选中与滚动都不许覆盖用户手势',
    ],
    from: 'if (viewTouched) return;',
    to: ';' },
  // ④ 恢复必须真的落到 state —— 只读了记忆却不用它，等于功能没接上（最隐蔽的形态）
  { id: 'persist-恢复不落到 state', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'nav-persistence.test.mjs', 'overview-scale.test.mjs'],
    judgeTests: ['分页接线：续页游标在时渲染「加载更多」，点它真的取下一页（并追加到当前列表）', '记住上次选中的导航项、filter 与左栏显隐，重开后恢复', '选中的标签会记住：重开后回到同一个标签，而不是静默掉回「全部」', '改字号只动排版：导航、过滤与左栏显隐一项都不许被覆盖（重开后排版也恢复）', '持久化值不可信时（未知 feedId / 非法 shape）回落默认值且不抛错'],
    // 2026-11-16 重锚：视图记忆改成 host 注入的 viewMemory（load 已搬进 list-actions.ts）。
    from: 'if (!viewMemory.restored()) viewMemory.apply(preferences);',
    to: ';' },
  // ⑫ R2-01 阅读位置：恢复只读不写。恢复时调一次 persistView 会把「读」与「写」耦合成环
  // （读到的旧值覆盖用户刚做的动作），也让每次打开面板都白热一次存储。
  { id: 'client-恢复写盘', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    judgeTests: [
      '阅读位置：重开面板选中上次那一行，且恢复本身不写盘',
      '阅读位置：上次那一条不在当前页 ⇒ 不选中，也不额外取数',
    ],
    // from 照构建产物 lib/client.js 的实际形状写（tsdown 把 if 块压成了一行）。
    from: 'if (prefs.lastItemId !== void 0) set({ selectedId: state.items.some((item) => item.id === prefs.lastItemId) ? prefs.lastItemId : void 0 });',
    to: 'if (prefs.lastItemId !== void 0) set({ selectedId: state.items.some((item) => item.id === prefs.lastItemId) ? prefs.lastItemId : void 0 });\n\t\t\t\tpersistView();' },
  // ⑫b R2-02 列表滚动位置：滚动必须走去抖写手，不能每帧直接写盘。
  { id: 'client-滚动不去抖', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs', 'scroll-dom.test.mjs'],
    judgeTests: [
      '列表滚动位置：滚动去抖写一次，保存内容含 lastListScrollTop',
      'R2-02 列表滚动去抖：连续滚动只写一次，关面板 flush 最后一处位置',
    ],
    // from 照构建产物 lib/client.js 的实际形状写（多行一组，单独锚 scheduleViewWrite() 会在
    // rememberSelection 里再命中一次）。改动为当场 persistView：滚动立刻写盘、且置「用户已动手」。
    from: 'const value = validListScrollTop(top);\n\t\t\t\tif (value === void 0) return;\n\t\t\t\tif (value === lastListScrollTop) return;\n\t\t\t\tlastListScrollTop = value;\n\t\t\t\tlistScrollTouched = true;\n\t\t\t\tviewTouched = true;\n\t\t\t\tscheduleViewWrite();',
    to: 'const value = validListScrollTop(top);\n\t\t\t\tif (value === void 0) return;\n\t\t\t\tif (value === lastListScrollTop) return;\n\t\t\t\tlastListScrollTop = value;\n\t\t\t\tlistScrollTouched = true;\n\t\t\t\tviewTouched = true;\n\t\t\t\tpersistView();' },
  // ⑫c R2-02 列表滚动位置：写入口是**整份覆盖写**，少带这一位就会被下一次导航抹掉
  // （用户切一下源/过滤，重开面板就回到顶部 —— 本项最容易踩的坑）。
  { id: 'persist-整份写丢滚动位置', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs', 'scroll-dom.test.mjs'],
    judgeTests: [
      '列表滚动位置：滚动去抖写一次，保存内容含 lastListScrollTop',
      'R2-02 列表滚动去抖：连续滚动只写一次，关面板 flush 最后一处位置',
    ],
    from: 'if (lastListScrollTop !== void 0) preferences.lastListScrollTop = lastListScrollTop;',
    to: ';' },
  // ⑫d R2-01 阅读位置：整份写漏掉 lastItemId ⇒ 一次普通导航（切源/过滤/左栏显隐）就把
  // 「上次停在哪一行」抹掉。判据是选中变化写盘与普通导航整份写两条用例。
  { id: 'persist-整份写丢选中位置', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    judgeTests: [
      '阅读位置：选中变化去抖写一次，保存内容含 lastItemId',
    ],
    from: 'if (state.selectedId !== void 0) preferences.lastItemId = state.selectedId;',
    to: ';' },
  // ⑫e R2-01 阅读位置：面板卸载 = 会话结束。宿主只建一次 store，卸载时不复位恢复标志，
  // 第二次挂载的 load 就永远不再读记忆 —— 切走再回来看着像「位置没记住」。
  { id: 'persist-卸载不复位会话', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs', 'scroll-dom.test.mjs'],
    judgeTests: [
      '阅读位置：同一个 store 卸载后再挂载（会话结束）会重新读记忆',
      'R2 同一个 store 卸载后再挂载：第二次仍恢复选中与滚动',
    ],
    from: 'viewRestored = false;\n\t\t\t\tviewTouched = false;\n\t\t\t\tlistScrollTouched = false;\n\t\t\t\trestoredListScrollTop = void 0;',
    to: ';' },
  // ⑫f R2-02 列表滚动位置：恢复值必须在 store 里按当前可滚范围夹取，并把**夹取后的值**
  // 记为上次位置；否则真浏览器为程序化写回派发的 scroll 会被当成用户滚动，排出一次写盘。
  { id: 'persist-取恢复值不夹取', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs', 'scroll-dom.test.mjs'],
    judgeTests: [
      '列表滚动位置：取恢复值时按当前可滚范围夹取，夹取后的写回不排写',
      'R2-02 保存的滚动位置超过当前可滚范围：夹到最近有效位置，且程序化写回不排写',
    ],
    from: 'const clamped = clampScrollTop(saved, maxTop);\n\t\t\t\tlastListScrollTop = clamped;\n\t\t\t\treturn clamped;',
    to: 'lastListScrollTop = saved;\n\t\t\t\treturn saved;' },
  // ⑤ 写盘串行化失效 ⇒ 后发的先到会让记忆回退成更早的状态
  { id: 'persist-写盘不串行化', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    judgeTests: ['写盘串行化：前一次慢、后一次快时，最终的记忆是「后一次动作」'],
    // 2026-11-15 重锚：阶段 4 的 deps 接缝把 callRpc 换成了 deps.rpc。
    from: 'viewWriteChain = viewWriteChain.then(() => deps.rpc("saveViewPreferences", { preferences }))',
    to: 'viewWriteChain = deps.rpc("saveViewPreferences", { preferences })' },
  // ⑥ 宿主写侧不归一再落库 ⇒ 认不出的原值进媒介（存储里攒垃圾，只被读侧遮住）
  { id: 'persist-宿主写侧不归一', file: 'lib/store.js',
    judges: ['nav-persistence.test.mjs'],
    judgeTests: ['真实 createStore：读侧校验坏值、写侧归一后才落库（生产路径，不是桩）'],
    // 2026-11-14 重锚：视图偏好新增了第三个判据（isKnownTag），旧 from 报「未应用」。
    from: 'const safe = sanitizeViewPreferences(preferences, (feedId) => feeds.get(feedId) !== undefined, isKnownFolder, (tagId) => tags.get(tagId) !== undefined);',
    to: 'const safe = preferences;' },
  // ⑦ 宿主读侧不校验 ⇒ 媒介里的坏值被透出去（回落承诺的第二道闸失效）
  { id: 'persist-宿主读侧不校验', file: 'lib/store.js',
    judges: ['nav-persistence.test.mjs', 'overview-scale.test.mjs'],
    judgeTests: ['真实 createStore：读侧校验坏值、写侧归一后才落库（生产路径，不是桩）'],
    from: 'viewPreferences: () => sanitizeViewPreferences(global.get(), (feedId) => feeds.get(feedId) !== undefined, isKnownFolder, (tagId) => tags.get(tagId) !== undefined),',
    to: 'viewPreferences: () => global.get(),' },
  // ⑧⑨⑩ 三个关键动作各自写一次盘：**三个调用点各一条**，否则任一条漏写都会被另一条的
  // 整份写入盖过去（persistView 落的是整个 state）。判据在「记住上次选中的导航项…」里
  // 逐个动作各断言一次。三条 from 各自唯一：产物里 persistView() 共 3 处，下面分别锚在
  // 「后随 applyOverview」「后随 /**」「前随 set({ navVisible: … })」上（均实测 OCCURRENCES=1）。
  // ⚠️ 2026-11-16（M5 03）重锚：原先锚在 `};` 之后紧跟 `const applyOverview` 的地方，而跨源提示的
  // refreshDuplicateHints 现在插在两者之间 ⇒ 旧 from 报「未应用」。改成锚 setFilter 独有的
  // 「relocateSelection + persistView + resetSearchPage」三连（实测 OCCURRENCES=1）。
  { id: 'persist-setFilter 不写盘', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    judgeTests: ['记住上次选中的导航项、filter 与左栏显隐，重开后恢复', '写盘串行化：前一次慢、后一次快时，最终的记忆是「后一次动作」'],
    from: "\t\t\t\t\tfilter,\n\t\t\t\t\tnavCursor: {\n\t\t\t\t\t\tkind: \"filter\",\n\t\t\t\t\t\tfilter\n\t\t\t\t\t}\n\t\t\t\t});\n\t\t\t\trelocateSelection();\n\t\t\t\tpersistView();",
    to: "\t\t\t\t\tfilter,\n\t\t\t\t\tnavCursor: {\n\t\t\t\t\t\tkind: \"filter\",\n\t\t\t\t\t\tfilter\n\t\t\t\t\t}\n\t\t\t\t});\n\t\t\t\trelocateSelection();" },
  { id: 'persist-selectNav 不写盘', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    judgeTests: ['记住上次选中的导航项、filter 与左栏显隐，重开后恢复', '选中的标签会记住：重开后回到同一个标签，而不是静默掉回「全部」', '写盘串行化：前一次慢、后一次快时，最终的记忆是「后一次动作」'],
    from: 'relocateSelection();\n\t\t\t\tpersistView();\n\t\t\t\tsearchActions.reset();\n\t\t\t\tconst scopeChanged = current.kind === "folder" || next.kind === "folder" || current.kind === "tag" || next.kind === "tag";',
    to: 'relocateSelection();\n\t\t\t\tresetSearchPage();\n\t\t\t\tconst scopeChanged = current.kind === "folder" || next.kind === "folder" || current.kind === "tag" || next.kind === "tag";' },
  { id: 'persist-toggleNav 不写盘', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    judgeTests: ['记住上次选中的导航项、filter 与左栏显隐，重开后恢复', '写盘失败必须可见：进 error 而不是被吞掉', '恢复是异步的：用户在它到达之前的手势不会被旧记忆盖掉（整份让位）', '只在关键动作时写盘：移动光标（每次按键）不产生写入'],
    // 2026-11-15 重锚：导航动作搬进 nav-actions.ts 后，state. 变成 get()。
    from: 'set({ navVisible: !get().navVisible });\n\t\t\t\tpersistView();',
    to: 'set({ navVisible: !state.navVisible });' },
  // ── 标读回包的每源账目（2026-10-10 两列布局任务 9 收尾）──────────────────────────
  // 这一条守的是**缺陷本体**：客户端只拿得到 maxItemsShown（300）条 items，而宿主按每源 500 条的
  // 全量表记账。标读端点只回 unread 不回 perFeedUnread 时，客户端只能拿本地增量补每源账目；
  // 一旦本地看不见的漂移发生（另一个面板把某源标空），幽灵未读就留在基线里 ⇒ 左栏各源之和
  // 17 ≠ 顶栏 14（spec §4 不变量 1）。判据是 tests/unread-accounting.test.mjs 的
  // 「host：markRead / unmarkRead 的回包必须带 perFeedUnread」+ 两条「截断 + 外部漂移」用例。
  // from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4）。
  // ⚠️ 2026-10-15 端点注册表重构后重锚：账目合并从「每个 case 各写一遍」搬到**分发核一处**
  // （lib/endpoints.js:494-496），旧的 `...accountOf(target)` 串已从产物消失 ⇒ 原锚会变「未应用」
  // （比幸存更隐蔽）。语义不变：仍是「标读回包只带 unread、不带每源账目」。
  // 锚点唯一性实测 OCCURRENCES=1（`if (spec.carriesAccount === true` 在产物里只有分发核这一处）。
  // ⚠️ 2026-11-20（R1 04）重锚：回包多了可选的 unreadSplit，账目合并的 return 从一行变多行；
  // 旧锚 `return ok({ ...result.value, unread: account.unread, perFeedUnread: ... })` 已从产物消失。
  // 语义不变：仍是「标读回包只带 unread、不带每源账目」。
  { id: 'endpoints-标读回包不带每源账目', file: 'lib/endpoints.js',
    judges: ['overview-scale.test.mjs', 'unread-accounting.test.mjs'],
    judgeTests: ['10 万行：标读回包（accountOf）也不物化全表，回包与 overview 同口径', '10 万行：cleanup 的候选集由 SQL 选（不再全表），且释放量与删除数如实', 'host：markRead / unmarkRead 的回包必须带 perFeedUnread（客户端在截断场景下只能靠它）'],
    from: 'return ok({\n                    ...result.value,\n                    unread: account.unread,\n                    perFeedUnread: account.perFeedUnread,\n                    ...(account.unreadSplit === undefined ? {} : { unreadSplit: account.unreadSplit }),\n                });',
    to: 'return ok({\n                    ...result.value,\n                    unread: account.unread,\n                    ...(account.unreadSplit === undefined ? {} : { unreadSplit: account.unreadSplit }),\n                });' },
  // 客户端这一侧的承重点：回包到手必须**整体覆盖**。退回「只覆盖 unread」= 又用本地那份
  // 看不见全量的账当真相，与上面那条是同一个不变式的两端，各自都要有人看着。
  // from 照**编译产物**的真实形状写：lib/client.js:416-421 的 applyAccount，独立实测 OCCURRENCES=1。
  { id: 'client-标读回包不整体覆盖每源账目', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs', 'unread-accounting.test.mjs'],
    judgeTests: ['分页：每一页都以宿主回包为准整体覆盖账目，绝不在第二页开始派生', '截断场景下「全部标已读」：以宿主回包的 perFeedUnread 为准，守恒式不破', '截断场景下撤销：同样以宿主回包为准'],
    from: 'unread: account.unread,\n\t\t\t\t\tperFeedUnread: account.perFeedUnread',
    to: 'unread: account.unread' },
  // ⑨ 域 global 槽的 schema 必须拒绝 null。放宽它 ⇒ 存进去的 null 与「从未写过」不可区分，
  //    重开后静默变回 initial（spec.d.ts:83-89 记的那条 round-trip 缺陷）。defineDomain 的
  //    运行时检查会同时炸，所以这条变异下那次 open 直接抛错、用例翻红。
  { id: 'persist-global schema 接受 null', file: 'lib/domain.js',
    judges: ['domain.test.mjs', 'nav-persistence.test.mjs'],
    from: 'schema: z.unknown().refine((value) => value !== null),',
    to: 'schema: z.unknown(),' },
  // 过滤行的点亮条件（2026-10-10，两轮用户实测反馈合并）：
  //  ① 选源后**仍在生效**的过滤（未读/星标）必须继续点亮，否则读者以为过滤被清掉了，
  //     而右栏其实还在按它过滤 —— 功能与指示脱节，最难自察的一类；
  //  ② 三个标签必须**同等对待**：曾为 'all' 单独开过一个「不点亮」的口子，
  //     用户一眼当成 bug（两个亮、一个不亮）。一致性优先于省一次高亮。
  // 这条变异给 'all' 重新加上那个例外，①② 会同时被它守住。
  { id: 'client-过滤行对 all 特殊对待（三个标签不一致）', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['左栏渲染：虚拟视图三行 + 每个订阅源一行', '点击某个源：右栏列表只剩该源条目', '选了「未读」再选源：源与过滤两条轴各自生效，未读行仍亮着（用户实测反馈）', 'shift+n / shift+p 在左栏导航里移动选中（不是右栏文章列表的 j/k）'],
    from: 'const selected = filter === view.key;',
    to: 'const selected = filter === view.key && filter !== "all";' },
  // 失败标记必须只反映**最近一次**结果（2026-10-10 用户实测：横幅一直写「月光博客（HTTP 502）」，
  // 而日志里该源连续十几次都是 not-modified —— 502 只出现过一次、之后一路成功）。
  // 变异把 lastFailure 塞回 304 分支的写回对象：一旦恢复「展开 previous」的写法，标记就再没人清。
  { id: 'refresh-304 成功不残留上次失败标记', file: 'lib/feed-intent.js',
    judges: ['refresh.test.mjs'],
    judgeTests: ['304 走 not-modified：不发全量重抓，只更新抓取时间', '失败标记只反映最近一次：先 500 失败、再 304 成功 ⇒ 标记必须清掉'],
    // H4 重锚（2026-10-18）：变异把 lastFailure 塞回 304 分支的合并结果 —— 一旦恢复「展开 previous」
    // 的写法，标记就再没人清（月光博客横幅残留事故）。
    from: "case 'refresh-not-modified':",
    to: "case 'refresh-not-modified-disabled':" },
  // 正文写入必须**合并进当前记录**（2026-10-10 用户实测：详情页逐篇读，已读状态丢失）。
  // 退回「用抓取前的快照整体写回」会把窗口期内并发 markRead 写进去的 readAt 抹掉 —— 丢失更新。
  // 判据：tests/article-markread-race.test.mjs（并发 markRead + 正文写入，断言 readAt 存活）。
  // ⚠️ 2026-10-15 端点注册表重构后重锚：handler 内的闭包变量 `target` 改成了 ctx 入参 `ctx.store`
  // （switch case → ENDPOINTS.article.to），旧 from 串里的 `target.updateItem` 已不在产物中 ⇒
  // 原锚会变「未应用」（比幸存更隐蔽）。语义不变：仍是「用抓取前的快照整体写回覆盖并发写入」。
  { id: 'article-用旧快照整体写回覆盖并发写入', file: 'lib/endpoints.js',
    judges: ['article-markread-race.test.mjs'],
    judgeTests: ['正文写入期间并发 markRead：readAt 不得被陈旧快照覆盖'],
    from: 'await ctx.store.updateItem(itemId, (current) => ({ ...current, articleFailure: fetched.reason }));',
    to: 'await ctx.store.saveItem(itemId, { ...existing, articleFailure: fetched.reason });' },
  // 刷新期间的写同样必须合并进当前记录（2026-10-10 与 article 端点同类）：
  // 抓取/淘汰是长任务，期间用户完全可能标已读、加星；用快照整体写回会静默抹掉这些用户数据。
  // 判据：tests/refresh.test.mjs 的两条「并发标已读」用例（各自注入一次窗口内并发写）。
  { id: 'refresh-缓存淘汰用旧快照覆盖并发写入', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    judgeTests: ['正文缓存淘汰期间并发标已读：不得用旧快照整体写回（丢失更新）'],
    from: "await store.updateItem(itemId, (current) => rebuildItem(current, { omit: ['article', 'articleFailure'] }));",
    to: "await store.saveItem(itemId, rebuildItem(store.item(itemId), { omit: ['article', 'articleFailure'] }));" },
  { id: 'refresh-正文回填用旧快照覆盖并发写入', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    judgeTests: ['正文回填期间并发标已读：不得用旧快照整体写回（丢失更新）'],
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
    judges: ['keys.test.mjs'],
    judgeTests: ['? 是快捷键帮助（GR §3.8 第 255 行）', '帮助表逐条反查：每一行声明的动作都必须与实现解析出来的完全一致'],
    // lib/keys.js:65，产物里唯一一处。
    from: "case '?': return 'help';",
    to: "case '?': return 'none';" },
  { id: 'client-? 不接浮窗', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['? 开合帮助浮窗：浮窗逐行画出来自 keys.ts 的帮助表', 'Esc 关浮窗且不穿透：正文页里只收浮窗，不把文章一起关掉', '✕ 关闭；焦点落在浮窗里之后 ? 与 Esc 仍然有效（非模态不许被自己的守卫吃掉）', '非模态：浮窗开着时 j 仍然作用于背后的列表（这是拍板结论，不是默认行为）'],
    // lib/client.js:2470-2471。删掉 run(...) 之后 ? 既不 preventDefault 也不开浮窗 ——
    // 「被吞掉」与「毫无反应」是两种不同的病，都由这条变异造出来。
    // ⚠️ 2026-10-15（C1）重锚：搬进 keyboard-routing.ts 后是 ctx.setHelpOpen(!ctx.helpOpen)（函数式更新 → 直接取反）。
    from: 'run(() => ctx.setHelpOpen(!ctx.helpOpen));',
    to: 'run(() => {});' },
  { id: 'client-Esc 不先关浮窗', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    // lib/client.js:2491，唯一一处。改坏后：开着浮窗按 Esc 会去关文章，浮窗留在屏幕上。
    // ⚠️ 2026-10-15（C1）重锚：搬进 keyboard-routing.ts 后是 ctx.helpOpen。
    from: 'if (ctx.helpOpen) {',
    to: 'if (false) {' },
  { id: 'client-浮窗标成 dialog 角色', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['✕ 关闭；焦点落在浮窗里之后 ? 与 Esc 仍然有效（非模态不许被自己的守卫吃掉）'],
    // lib/client.js:2269，唯一一处。isTypingTarget 会把 [role=dialog] 内的按键全吞掉（含 Esc）——
    // 鼠标点过一次 ✕ 之后，? 与 Esc 双双失效。判据是「✕ 关闭；焦点落在浮窗里之后…」那条用例。
    from: 'role: "region",',
    to: 'role: "dialog",' },
  // ⚠️ 2026-10-15（C1）重锚：依赖数组现在多了 expanded（routeKey 的 o 键要读它），
  // 且 tsdown 把它展开成多行 tab 形态（含 }, [ 前缀）。
  // ⚠️ 2026-11-21（R6 04）再锚：依赖数组尾部又多了 imagesExpanded 与 expandedGroups
  // （`i` 键要读篇级覆盖、要清组覆盖），所以 from/to 一起延长到新的尾部。
  // 变异意图不变：拿掉 helpOpen ⇒ 按键处理器读到的永远是注册那一刻的 false。
  { id: 'client-helpOpen 不进依赖数组', file: 'lib/client.js',
    judges: ['overview-scale.test.mjs', 'scroll-dom.test.mjs'],
    // lib/client.js:2534-2538。少了 helpOpen，按键处理器读到的永远是注册那一刻的 false：
    // 浮窗开着按 Esc → 走「关文章」分支，浮窗留在屏幕上（与上面第三条同一个病象、不同根因）。
    from: '}, [\n\t\t\t\t\troot,\n\t\t\t\t\tstore,\n\t\t\t\t\texpanded,\n\t\t\t\t\thelpOpen,\n\t\t\t\t\timagesExpanded,\n\t\t\t\t\texpandedGroups\n\t\t\t\t]);',
    to: '}, [\n\t\t\t\t\troot,\n\t\t\t\t\tstore,\n\t\t\t\t\texpanded,\n\t\t\t\t\timagesExpanded,\n\t\t\t\t\texpandedGroups\n\t\t\t\t]);' },
  // ── 自持存储骨架（2026-10-11 大规模存储任务 2）─────────────────────────────────
  // 这三个模块是「下次装载还能不能读到用户数据」的全部承重点，而它们的失效**全都安静**：
  // 版本闸写错 ⇒ 好库被当成坏库拒掉，界面表现是「重启之后订阅全没了」；
  // 订阅文件的版本闸失效 ⇒ 认不出的格式被硬按 v1 解释；目录权限放宽 ⇒ 数据目录变成全机可读。
  // 三条 from 均照**编译产物的真实形状**写（docs/pitfalls.md 一、1.4），并已独立实测 OCCURRENCES=1。
  { id: 'storage-版本闸把好库一起拒了', file: 'lib/storage/db.js',
    judges: ['storage-skeleton.test.mjs'],
    judgeTests: ['openDatabase 能重开已经建好的库（第二次装载不许把好库当坏库拒绝）', 'config.json 缺失且库里有条目 ⇒ 装载必须响亮失败（订阅丢了不许静默变空面板）', 'P2-3 config.json 在但订阅为空、库里却有条目 ⇒ 响亮失败（与 verify-backup 同一条判据）'],
    // 删掉「且不是当前版本」这半边后，闸变成「非 0 即拒」⇒ **已经迁移好的库第二次装载就打不开**。
    // 判据：tests/storage-skeleton.test.mjs 的「openDatabase 能重开已经建好的库」。
    from: 'if (onDisk !== 0 && onDisk !== SCHEMA_VERSION && !UPGRADABLE_VERSIONS.has(onDisk)) {',
    to: 'if (onDisk !== 0 && !UPGRADABLE_VERSIONS.has(onDisk)) {' },
  { id: 'storage-订阅文件版本闸失效', file: 'lib/storage/config-file.js',
    judges: ['storage-skeleton.test.mjs', 'store-sqlite.test.mjs'],
    judgeTests: ['readConfigFile 对损坏/形状不对/版本不认的 config.json 一律抛错，不返回空订阅', 'saveViewPreferences 写前校验并落 config.json，且不碰订阅映射；config.json 读不出来时响亮失败'],
    // 版本不认时必须响亮失败（未来格式硬按 v1 解释会丢掉本版不认识的字段）。
    // 判据：tests/storage-skeleton.test.mjs 的「readConfigFile 对损坏/形状不对/版本不认的 config.json 一律抛错」。
    from: 'if (record.version !== CURRENT_CONFIG_VERSION) {',
    to: 'if (false) {' },
  { id: 'storage-目录权限放宽到 0777', file: 'lib/storage/paths.js',
    judges: ['storage-skeleton.test.mjs'],
    judgeTests: ['ensureStorageRoot 递归建出 0700 目录，且可重复调用'],
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
    judges: ['storage-skeleton.test.mjs', 'store-sqlite.test.mjs'],
    judgeTests: ['migrateSchema 物化 items/texts/cursors，recency = COALESCE(published_at, fetched_at)', 'texts.fetched_at 声明 NOT NULL：NULL 写不进去，且读路径确实消费这一列'],
    from: 'fetched_at TEXT NOT NULL',
    to: 'fetched_at TEXT' },
  // ── SQLite 版 ReaderStore（2026-10-11 大规模存储任务 3）───────────────────────────
  // 这一族是「换实现之后，旧实现的每一条承诺是否还在」的承重点，而它们的失效大半**安静**：
  // 列表顺序变了、并发已读被抹掉、正文被级联删掉 —— 界面上都只是「好像少了点什么」。
  // 每条 from 均照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4），
  // 并已独立实测 OCCURRENCES=1（在 /tmp 隔离副本里跑过一轮：11/11 全部被抓到）。
  { id: 'store-listItems 退回 JS 全表过滤', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    judgeTests: ['listItems 只返回该源的条目，且源条件是真的写在 SQL 里（spec §3.1 的扫描族修复）', 'allItems / listItems 按 recency 降序 + id 升序；缺 publishedAt 的行按 fetchedAt 归位（Review Focus 2）'],
    // 这是**扫描族的结构性修复**（spec §3.1）：把源条件从 SQL 挪走之后，选中哪些行不再由 SQL 决定
    // —— 所以判据是 tests/store-sqlite.test.mjs 里录 prepared SQL 的那条（行为层的「快」不可靠：
    // 一个把全表读回来再过滤的实现同样「快」）。
    // ⚠️ 本条 `to` 的字面实义：`SELECT_ALL_ITEMS.all().map(...)` —— **整表原样返回、连过滤都没有**
    //（不是「读全表再在 JS 里按 feedId 过滤」；那种写法会多一个谓词，与下面的 `to` 不同）。
    from: 'listItems: (feedId) => sql(SELECT_ITEM_BY_FEED).all(feedId).map((row) => {',
    to: 'listItems: (feedId) => sql(SELECT_ALL_ITEMS).all().map((row) => {' },
  { id: 'store-排序退回 published_at', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    judgeTests: ['listItems 只返回该源的条目，且源条件是真的写在 SQL 里（spec §3.1 的扫描族修复）', 'allItems / listItems 按 recency 降序 + id 升序；缺 publishedAt 的行按 fetchedAt 归位（Review Focus 2）', 'listRecent / unreadPerFeed / listCleanupCandidates 的排序、聚合与筛选真的写在 SQL 里（扫描族归零）'],
    // publishedAt 是可选字段：直接对它排序会让缺发布时间的条目落进 SQL 的 NULL 段
    // （SQLite 中 NULL 最小），列表顺序与迁移前不一致（Review Focus 2）。
    // 判据：tests/store-sqlite.test.mjs 的「缺 publishedAt 的行按 fetchedAt 归位」。
    from: "const ITEM_ORDER = ' ORDER BY i.recency DESC, i.id ASC';",
    to: "const ITEM_ORDER = ' ORDER BY i.published_at DESC, i.id ASC';" },
  { id: 'store-updateItem 抹掉并发已读态', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    judgeTests: ['updateItem 是原子读改写：窗口期内并发写进去的 readAt / 星标不被旧快照抹掉（Review Focus 4）'],
    // 这条守的是**接口存在的理由**（src/store.ts:21-31）：fn 算出的记录被原地覆盖时若丢了
    // 窗口期内并发写进去的 readAt，表现就是 2026-10-10 用户实测的「详情页逐篇读，已读状态丢失」。
    // 判据：tests/store-sqlite.test.mjs 的「原子读改写」那条。
    from: 'const next = itemRecordSchema.parse(fn(toItemRecord(row)));',
    to: 'const next = itemRecordSchema.parse({ ...fn(toItemRecord(row)), readAt: undefined });' },
  { id: 'store-updateItem 缺失键顺手创建', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    judgeTests: ['updateItem 对缺失键拒绝：写一次不等于创建（src/store.ts:29）'],
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
    judges: ['store-sqlite.test.mjs'],
    judgeTests: ['建 store 先做版本握手：没盖章的库当场响亮失败，不许等第一次写入才发现（顺序颠倒）'],
    // 顺序颠倒（先建 store、后 migrateSchema）若不在构造时拦下，症状是「插件装载成功、
    // 第一次刷新才失败」——那时用户已经白等了一轮网络。
    // 判据：tests/store-sqlite.test.mjs 的「没盖章的库当场响亮失败」。
    from: 'if (onDisk !== SCHEMA_VERSION) {',
    to: 'if (false) {' },
  { id: 'store-读偏好不校验形状', file: 'lib/store-sqlite.js',
    judges: ['nav-persistence.test.mjs', 'store-sqlite.test.mjs'],
    judgeTests: ['真实 createSqliteStore：读侧校验坏值、写侧归一后才落库（cutover 后的生产路径）', 'viewPreferences：标签被删之后回落虚拟视图（读侧校验，与已退订的源同一条）', 'viewPreferences 读侧一定给可信形状：坏值逐字段回落，已退订的源回落虚拟视图且不抛错'],
    // src/store.ts:41-45 的承诺是「返回的保证是可信形状」；不校验就把媒介里的垃圾透给调用方去兜。
    // 判据：tests/store-sqlite.test.mjs 的「坏值逐字段回落」。
    from: 'viewPreferences: () => {\n            const current = readConfigFile(configPath);\n            const knownFeeds = new Set(Object.keys(current.feeds));\n            const knownFolders = new Set(current.folders ?? []);\n            return sanitizeViewPreferences(current.viewPreferences, (feedId) => knownFeeds.has(feedId), (folder) => knownFolders.has(folder), isKnownTag);\n        },',
    to: 'viewPreferences: () => readConfigFile(configPath).viewPreferences,' },
  { id: 'store-写偏好覆盖掉订阅映射', file: 'lib/store-sqlite.js',
    judges: ['nav-persistence.test.mjs', 'store-sqlite.test.mjs'],
    judgeTests: ['真实 createSqliteStore：读侧校验坏值、写侧归一后才落库（cutover 后的生产路径）', 'saveViewPreferences 写前校验并落 config.json，且不碰订阅映射；config.json 读不出来时响亮失败'],
    // config.json 是用户订阅的**唯一**可备份副本：写偏好时若不先把旧文件读出来，
    // 一次「切了个 filter」就会把订阅列表清空 —— 且不抛错、不留痕。
    // 判据：tests/store-sqlite.test.mjs 的「写偏好不许动订阅映射」。
    // 2026-11 M2 02：saveViewPreferences 改走 updateConfig（统一「读 → 改 → 原子写」），
    // 旧锚串消失 ⇒ 照编译产物重锚；语义不变：把「带旧 feeds 的整份写回」改成「空 feeds」。
    from: 'updateConfig(configPath, (current) => ({ ...current, viewPreferences: safe }));',
    to: 'updateConfig(configPath, () => ({ feeds: {}, version: 1, viewPreferences: safe }));' },
  { id: 'store-缺席字段写成 undefined 键', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    judgeTests: ['saveItem 覆盖整条；可选字段缺席时不留 null / undefined 键（.strict() 与 isUnread 都靠它）'],
    // readAt === undefined 是本仓库对「未读」的定义（src/shared.ts:62）。多一个 undefined 值
    // 的键会让 .strict() 的读侧校验与 isUnread 同时失准 —— 「所有条目看起来都没读过」。
    // 判据：tests/store-sqlite.test.mjs 的「可选字段缺席时不留 null / undefined 键」。
    // ⚠️ from 必须**连 if 一起**纳入：只改 `record.readAt = readAt;` 那一行的话，替换出来的是
    // `if (x) if (x) a; else b;` —— 内层 else 永远轮不到执行，等于什么都没改（第一版就是这么写的，
    // 它「幸存」是**变异没生效**，不是测试缺口；docs/pitfalls.md 二、2.7 记的正是这类坑）。
    from: 'if (readAt !== undefined)\n        record.readAt = readAt;',
    to: 'record.readAt = readAt;' },
  // ⚠️ 2026-11-14 撤掉「先删库后写 config」那条：补偿写回（下面的 catch）把这段代码改成了
  // writeFeeds → try/catch，顺序不再是两个相邻块，单 hunk 替换表达不了「把 config 写挪到最后」。
  // 顺序仍由**行为**钉住：tests/store-sqlite.test.mjs 的「config 写不进去时条目与游标一条都不许动」——
  // 谁把库操作挪到 config 前面，那条当场翻红。下面这条守的是另一半（失败后写回）。
  { id: 'store-退订失败不写回订阅', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    judgeTests: ['deleteSubscription：库事务失败时把订阅原样写回（失败 = 什么都没发生）'],
    // 库事务失败时不把订阅写回 ⇒ config 已经删了、条目还在。退掉最后一个源时，下次装载会被
    // 「订阅映射丢了」的守卫判死，插件直接起不来（2026-11-14 评审发现的最坏形态）。
    // 判据：store-sqlite 的「deleteSubscription：库事务失败时把订阅原样写回」。
    // 2026-11-20 R3-04 重锚：退订失败的回写从 writeFeeds(() => before) 改成 updateConfig 整份回写
    // （顺序也要一起回滚）。守的仍是同一件事——失败后必须把订阅写回；锚点跟着编译产物走。
    from: `                    updateConfig(configPath, (current) => {
                        const restored = { ...current, feeds: before.feeds };
                        if (before.feedOrder === undefined)
                            delete restored.feedOrder;
                        else
                            restored.feedOrder = [...before.feedOrder];
                        return restored;
                    });
`,
    to: '' },
  { id: 'store-退订不删条目', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs', 'tag-endpoints.test.mjs'],
    judgeTests: ['listFeeds / feed / saveFeed / deleteSubscription 与旧实现同形（条件请求字段一个都不能丢）', 'deleteSubscription 先写 config、再删条目与游标：config 写不进去时库里一条都不许动（跨介质顺序）', '清理与退订生命周期：文章删除只清标签关联，标签本身保留'],
    // 退订只删订阅项与游标、把条目留下 ⇒ 用户退了订，条目还在库里占着（且成了孤儿）。
    // 判据：store-sqlite 的「i-1/i-2 必须跟着消失」与 tag-endpoints 的「removeFeed 后条目没了」。
    from: '                sql(DELETE_ITEMS_BY_FEED).run(feedId);\n',
    to: '' },
  { id: 'store-退订不删游标', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    judgeTests: ['listFeeds / feed / saveFeed / deleteSubscription 与旧实现同形（条件请求字段一个都不能丢）', 'deleteSubscription 先写 config、再删条目与游标：config 写不进去时库里一条都不许动（跨介质顺序）'],
    // 游标留下 ⇒ 下次重新订阅同一个源时 seen 还在，老条目被当成「见过」而跳过，用户看不到它们。
    // 判据：store-sqlite 的「cursor 必须跟着退订一起消失」。
    from: '                sql(DELETE_CURSOR).run(feedId);\n',
    to: '' },
  { id: 'cleanup-端点不复跑判据', file: 'lib/endpoints.js',
    judges: ['cleanup-endpoint.test.mjs'],
    // 端点直接把候选当删除集 ⇒ 星标与保持未读的条目被一起删掉。2026-11-14 之前的形态就是这个：
    // 判据看起来还在（listCleanupCandidates 里跑过），但端点这层没有第二道闸。
    // 判据：cleanup-endpoint 的「更宽的候选集上判据仍然生效」。
    from: '            const doomed = new Set(selectCleanup(candidates, cutoff));',
    to: '            const doomed = new Set(candidates.map((row) => row.id));' },
  { id: 'memory-候选回填星标', file: 'lib/memory-store.js',
    judges: ['store-contract.test.mjs'],
    // 把「候选行如实报真值」退化成按谓词回填 —— 判据（retention 的 selectCleanup）就再也看不见
    // 星标保护，清理会把星标条目删掉。这正是 2026-11-14 隔离实验实测过的那条路径。
    // 判据：契约用例「候选行携带的字段必须是真的」。
    from: '                    starred: record.starred === true,',
    to: '                    starred: false,' },
  { id: 'client-标签选中落盘成虚拟视图', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    judgeTests: ['选中的标签会记住：重开后回到同一个标签，而不是静默掉回「全部」'],
    // 就是 2026-11-14 之前的那个缺陷本身：投影把 tag 写回 virtual ⇒ 按标签筛选生效、落盘却成了
    // 「全部」，还顺手覆盖掉上次记住的源/文件夹。判据：nav-persistence 的
    // 「选中的标签会记住：重开后回到同一个标签」——它断言落盘那一份的 navSelection.kind === 'tag'。
    from: [
      '\t\t\t\tcase "tag": return {',
      '\t\t\t\t\tkind: "tag",',
      '\t\t\t\t\ttagId: selection.tagId',
      '\t\t\t\t};',
    ].join('\n'),
    to: '\t\t\t\tcase "tag": return { kind: "virtual" };' },
  { id: 'client-展开永不收起', file: 'lib/client.js',
    judges: ['keyboard-routing.test.mjs', 'scroll-dom.test.mjs'],
    judgeTests: ['o 键在列表页翻转展开：已展开则收起，否则展开当前行并标已读', 'o 键：同一行连按两次必须收起（依赖数组里的 expanded 是承重的）'],
    // 把「再按一次 = 收起」退化成「恒展开」——这正是 2026-11-14 之前行内 Enter/Space 的行为，
    // 也是 o 键在有它自己的 toggle 时不该有的样子。判据：keyboard-routing 的「已展开则收起」
    // 与 scroll-dom 的「Enter 必须收起」。
    from: '\t\t\treturn current === itemId ? void 0 : itemId;',
    to: '\t\t\treturn itemId;' },
  { id: 'client-activate 不标已读', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['C4-b 迁入：o 展开并触发 markRead 端点（副作用不能漏）', '行内 Enter / Space 与 o 同义：再按一次收起（GR 规范 o / enter = open/close）'],
    // activate 少了标已读 ⇒ 「打开即已读」整条规则消失，而界面上看不出任何异常（角标只是不减）。
    // 判据：scroll-dom 的「点击即标已读 —— store.activate 是唯一触发点」。
    // ⚠️ 2026-11-20 重锚：R2-01 让 activate 先 rememberSelection() 记阅读位置；旧锚
    //    （set + markRead 两行）已不存在。锚点改成「rememberSelection + markRead」两行，
    //    仍只命中一次，且判定语义不变（去掉的仍是 markRead）。
    from: '\t\t\t\trememberSelection();\n\t\t\t\tmarkRead(itemId);',
    to: '\t\t\t\trememberSelection();' },
  { id: 'store-viewPreferences 不校验标签', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    judgeTests: ['viewPreferences：标签被删之后回落虚拟视图（读侧校验，与已退订的源同一条）'],
    // 读侧丢掉 isKnownTag ⇒ 标签删了之后记忆里仍指向一个不存在的标签，界面打开一个空范围。
    // 判据：store-sqlite 的「标签被删之后回落虚拟视图」。
    from: '(folder) => knownFolders.has(folder), isKnownTag);',
    to: '(folder) => knownFolders.has(folder));' },
  { id: 'store-老形态正文静默丢正文', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    judgeTests: ['拒绝写入老形态正文（只有 paragraphs）：不许静默把正文丢掉（兼容读的保险，不再有正常调用方）'],
    // 库里没有存 paragraphs 的列。放开这道闸后，一条「只有 paragraphs、没有 blocks」的老记录会被
    // **当成长度为零的新记录**写下去：items 行落库、正文行被删掉，用户在详情页看到正文凭空消失，
    // 而测试若只断言「写入没抛错」就全绿。转换口径只有 domain.ts 的 normalizeLegacyArticle 一处。
    // 判据：tests/store-sqlite.test.mjs 的「拒绝写入老形态正文」。
    from: 'if (article !== undefined && article.blocks === undefined && article.paragraphs !== undefined) {\n            throw new Error(',
    to: 'if (false) {\n            throw new Error(' },
  { id: 'store-正文 fetchedAt 不落列', file: 'lib/store-sqlite.js',
    judges: ['overview-scale.test.mjs', 'store-sqlite.test.mjs'],
    // article.fetchedAt 是 refresh.ts:118 的正文缓存淘汰排序键，缺了整表退化成不可判。
    // 判据：tests/store-sqlite.test.mjs 的「item 把 texts 的正文按 blocks 还原」。
    from: 'article.title ?? null, article.fetchedAt);',
    to: 'article.title ?? null, null);' },
  // ── 订阅完整性闸（2026-10-11 大规模存储任务 4 的迁移下线后搬过来）──────────────
  // 这 6 条（原 `migrate-*`）随 src/storage/migrate.ts 一起删掉了：那条一次性迁移已经完成、
  // 老文件也已从真机删除，路由不再读它 ⇒ 它们的 `from` 在产物里不再存在，留着会被计成
  // 「未应用」而**记成幸存者**（docs/pitfalls.md 二、2.7）。判定本身没有消失，只是搬了家：
  //
  //   · 「认不出就响亮失败，绝不回落成空库」——现在由 assertSubscriptionsNotLost 承担：
  //     config.json 读不出来 ⇒ readConfigFile 带路径抛错；它不在而库里有条目 ⇒ 那次调用抛错。
  //   · 「库里有条目、但订阅文件没了」= 迁移闸门二的原语义，同一条调用（见下）。
  //   · 「老正文形态必须先折成 blocks」——老的那个调用方没了，但转换口径与拒写守卫都还在：
  //     domain.ts 的 normalizeLegacyArticle 由 tests/domain.test.mjs 钉，store-sqlite 的
  //     拒写由 tests/store-sqlite.test.mjs 的「拒绝写入老形态正文」钉（本节末尾那条变异守的就是它）。
  //   · 「不校验域名 / 读不出来当成首次安装」——判据的对象（老域文件的读取）已经不存在。
  //
  // ⚠️ from 照**编译产物**的实际形状写（docs/pitfalls.md 一、1.4）。
  // ⚠️ 2026-10-15（H2）只改了 file：守卫搬进 lib/lifecycle.js，from 逐字未变。
  { id: 'storage-订阅丢了却不报错', file: 'lib/lifecycle.js',
    judges: ['storage-skeleton.test.mjs'],
    judgeTests: ['config.json 缺失且库里有条目 ⇒ 装载必须响亮失败（订阅丢了不许静默变空面板）', 'P2-3 config.json 在但订阅为空、库里却有条目 ⇒ 响亮失败（与 verify-backup 同一条判据）'],
    // 把「订阅文件不在（且库里有条目）就抛错」改成「永远放行」⇒ 一次读取失败被静默当成
    // 首次安装，插件带着「有数据、没订阅」的库继续跑，用户看到订阅列表空白而日志里没有一行错。
    // 这正是迁移闸门二当初存在的原因，所以它必须仍然有人看着。
    // 判据：tests/storage-skeleton.test.mjs 的「config.json 缺失且库里有条目 ⇒ 装载必须响亮失败」。
    // ⚠️ 改法只动**值比较**那一半，不碰 configFileMissing：否则同一处里两个判定会被一起
    //    拆掉，翻红就分不清是哪一半在守（等价于把两条判据压成一条）。
    // ⚠️ `stored >= 0` 对任何非负数字恒真（0 与正数都早返回）—— 不是等价变异：条目非空时
    //    守卫的结论与后续行为都变（实测该用例翻红）。
    // ⚠️ from 必须写成**编译产物的两行形状**：tsc 会把 `if (stored === 0) return` 拆行，
    //    单行写法匹配不上 ⇒ 报「未应用」并被计成幸存者（docs/pitfalls.md 一、1.4 与二、2.7）。
    from: 'if (stored === 0)\n            return;',
    to: 'if (stored >= 0)\n            return;' },
  // ── 未读记账与列表取数改 SQL（2026-10-11 大规模存储任务 5）────────────────────────
  // 这一族的失效大半**安静**：账目少算一个源、0 未读的源丢键、清理多删了用户说「别动它」的条目
  // —— 界面上分别是「角标空白」「星标/保持未读的条目凭空消失」，都不报错。
  // 每条 from 均照**编译产物** lib/store-sqlite.js 的真实形状逐字抄，并已独立核对
  // OCCURRENCES=1（docs/pitfalls.md 一、1.4）。
  { id: 'unreadPerFeed-SQL 判据反过来', file: 'lib/store-sqlite.js',
    judges: ['overview-paging.test.mjs', 'store-sqlite.test.mjs'],
    judgeTests: ['逐方法同义性：unreadPerFeed 与旧实现逐键相等（0 未读的源两边都留 0 值键）', 'unreadPerFeed：与 unread.ts 的唯一口径在同一夹具上逐键相等，且键域 = 传入的 feeds 表（Ruling P-6）', 'listRecent / unreadPerFeed / listCleanupCandidates 的排序、聚合与筛选真的写在 SQL 里（扫描族归零）'],
    // 未读判据一旦写反（read_at IS NOT NULL），账目就变成「已读数」——而它与「各源之和 === 总未读」
    // 的关系看着仍然自洽（两边一起错），所以只有那条**与 shared.ts 逐键对账**的用例能抓到它。
    // 判据：tests/store-sqlite.test.mjs 的「unreadPerFeed：与 unread.ts 的唯一口径…逐键相等」。
    // R1 02 起这条 SQL 由 unreadPerFeedSql 拼装（同一段 WINDOW_FILTER 也供带窗账目）：
    // from 锚定编译产物里的首行字符串，判据仍在 read_at IS NULL 这一半。
    from: "const unreadPerFeedSql = (window) => 'SELECT i.feed_id AS feed_id, COUNT(*) AS unread FROM items i WHERE i.read_at IS NULL'",
    to: "const unreadPerFeedSql = (window) => 'SELECT i.feed_id AS feed_id, COUNT(*) AS unread FROM items i WHERE i.read_at IS NOT NULL'" },
  { id: 'unreadPerFeed-丢键域（0 未读的源不留键）', file: 'lib/store-sqlite.js',
    judges: ['overview-paging.test.mjs', 'overview-scale.test.mjs', 'store-sqlite.test.mjs'],
    judgeTests: ['逐方法同义性：unreadPerFeed 与旧实现逐键相等（0 未读的源两边都留 0 值键）', '10 万行：overview 不再物化全表，且账目守恒（键域 = feeds 表）', 'unreadPerFeed：与 unread.ts 的唯一口径在同一夹具上逐键相等，且键域 = 传入的 feeds 表（Ruling P-6）'],
    // 这是本仓库栽过两次的那条（任务 1 的键域、任务 5 的口径）：删掉「先按传进来的键铺 0」之后，
    // 只有**有未读的源**才留键，左栏那一行渲染出来是「角标空白」而不是「角标 0」——
    // 与「角标 0」在界面上无从分辨，是最贵的那类沉默失败。判据是 tests/unread-accounting.test.mjs
    // 的「标空之后 A 的键必须还在」与 tests/overview-scale.test.mjs 的键集断言。
    from: 'unread[feedId] = 0;',
    to: ';' },
  // ⚠️ 2026-11-14 撤掉两条（原 id：cleanup-保持未读不再受保护 / cleanup-星标不再受保护）：
  // 保护条款已从 SELECT_CLEANUP_ROWS 搬进 retention.ts 的 selectCleanup，谓词里不再有
  // `starred = 0` / `kept_unread = 0` 两串 —— 旧锚会报**未应用**（比幸存更隐蔽，pitfalls §2.7）。
  // 同一个缺陷现在由下面三条守：retention-清理的星标保护 / retention-清理的保持未读保护 /
  // cleanup-候选行的保持未读按谓词回填。按 AGENTS.md「等价变异不入门槛」，这里不补 SQL 谓词的宽容度变异：
  // 谓词现在只做成本筛选，放宽它只会让候选更宽、由判据挡回去，行为不变。
  { id: 'cleanup-候选行的保持未读按谓词回填', file: 'lib/store-sqlite.js',
    judges: ['overview-scale.test.mjs', 'store-sqlite.test.mjs', 'overview-paging.test.mjs'],
    judgeTests: ['逐方法同义性：listCleanupCandidates 在两个适配器上得出同一个最终删除集（候选宽度可以不同）', '10 万行：cleanup 的候选集由 SQL 选（不再全表），且释放量与删除数如实', 'listCleanupCandidates：SQL 只做成本筛选，判定由 selectCleanup 做出（候选 ⊇ 判定集）'],
    // 旧写法按谓词回填 `kept: false` —— SQL 一旦放宽，判据看见的仍是 false，用户说「别动它」的条目被删。
    // 2026-11-14 的隔离实验实测过这条路径；现在候选行必须照列读真实状态。
    from: "kept: booleanAt(row.kept_unread, 'items.kept_unread'),",
    to: 'kept: false,' },
  { id: 'cleanup-候选集直接当删除集', file: 'lib/endpoints.js',
    judges: ['overview-scale.test.mjs', 'overview-paging.test.mjs'],
    judgeTests: ['10 万行：cleanup 的候选集由 SQL 选（不再全表），且释放量与删除数如实'],
    // 跳过判据 = 让 SQL 的宽容度决定用户数据。SQL 现在只筛「已读 + 够旧」，
    // 星标与保持未读的旧条目都在候选里 —— 少了这一句，它们会被直接删掉。
    from: 'const doomed = new Set(selectCleanup(candidates, cutoff));',
    to: 'const doomed = new Set(candidates.map((row) => row.id));' },
  { id: 'listRecent-负数上限下传给 SQLite', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    judgeTests: ['listRecent：按 recency 降序 + id 升序取前 N 条，与 allItems 的前缀逐字相等（语义不变）'],
    // SQLite 把 LIMIT -1 当「无上限」。删掉 JS 侧短路后，「取 300 条」在一处算错成负数时
    // 会静默变成「读回整表」——结果看着还挺对，只有耗时爆炸。
    // 判据：tests/store-sqlite.test.mjs 的「listRecent：… 负数上限 ⇒ 空列表」。
    from: 'if (limit <= 0)\n                return [];',
    to: 'if (false)\n                return [];' },
  // 列表窗口的「放大重取」（Task 5 自审发现）：残留行（退订后没清干净 / 手工改库）会先被取回来、
  // 再因为「所属源已退订」被挡掉，而它们**已经占掉了窗口**。少了这一步，右栏会静默少几条。
  // 判据：tests/endpoints-perfeed-unread.test.mjs 的「已退订源的残留条目…不许把列表的截断窗口占掉」。
  { id: 'overview-列表窗口不再放大重取', file: 'lib/item-page.js',
    judges: ['endpoints-perfeed-unread.test.mjs', 'item-page.test.mjs'],
    judgeTests: [
      '已退订源的残留条目：既不进账目，也不许把列表的截断窗口占掉（退订后没清干净 / 手工改库）',
      '窗口放大：孤儿占掉的窗口必须被补回来，取回的条数始终是 window + 1',
    ],
    // 首轮取回的 5 条里 4 条是残留行 ⇒ 列表只剩 1 条，而用户看不出少在哪（原实现是先滤后截，不会少）。
    // ⚠️ 2026-10-11 任务 6：取数循环重写（多取一行以判断「后面还有没有」），原锚串消失 ⇒ 本条
    // 改锚到新产物的同一处判定（window 不再放大 = 残留行会被当成「已到底」）。
    // ⚠️ 2026-11-18 阶段 6：循环搬进 src/item-page.ts（ADR-0004），批次变量从 rows 改名 fetched
    // （rows 现在专指「要下发的行」）⇒ 随搬家重锚。
    // 2026-11-20 重锚（R1 评审 P2）：局部变量 windowSize 改名 fetchSize（时间窗参数也叫 window，两个名字易混）。
    from: 'exhausted = fetched.length <= fetchSize;',
    to: 'exhausted = true;',
  },
  // ── 列表分页 keyset + 客户端契约（2026-10-11 大规模存储任务 6）────────────────────
  // 病象：overview 一次只回 maxItemsShown（默认 300）条且没有续页入口 ⇒ 10 万行下第 301 条之后
  // 在界面上**永远到不了**。这一族各守一个独立的失效面，且失效大半**安静**（少一条、重复一页、
  // 翻不完的循环、幽灵未读）——都不报错，只是数字/列表看着不对。
  // 每条 from 均照**编译产物**的真实形状逐字抄，并已独立核对 OCCURRENCES=1（docs/pitfalls.md 一、1.4）。
  { id: 'paging-续页谓词的 id 方向写反', file: 'lib/store-sqlite.js',
    judges: ['overview-paging.test.mjs'],
    judgeTests: ['overview 分页：第 300 与第 301 条的边界不重不漏，末页没有 nextCursor', 'overview 分页：页边界正好压在 recency 打平组上时不重不漏（同批抓取是常态）', 'overview 续页：边界行随后被删掉也不影响翻页（游标是一对值，不是行引用）'],
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
    // ⚠️ 2026-11-18 阶段 6：三个范围变体共用一个 AFTER_CURSOR 片段（ADR-0004 决定 4），
    // 锚点从「某个 SELECT 的 WHERE 尾巴」改成「这个常量本身」。
    from: "const AFTER_CURSOR = '(i.recency < ? OR (i.recency = ? AND i.id > ?))'",
    to: "const AFTER_CURSOR = '(i.recency < ? OR (i.recency = ? AND i.id < ?))'" },
  { id: 'paging-游标不校验形状（垃圾当第一页）', file: 'lib/cursor.js',
    judges: ['overview-paging.test.mjs'],
    judgeTests: ['游标编解码：格式 "<recency>|<id>"，认不出的必须返回 undefined（不许当成从头开始）', 'overview：游标认不出时响亮拒绝（bad-request），绝不静默从头开始'],
    // 认不出的游标若被解出一个值，调用方就不再失败 —— 客户端回带的垃圾游标会被当成正常续页。
    // 判据：tests/overview-paging.test.mjs 的「游标认不出时响亮拒绝」与「游标编解码」两条。
    from: "if (!ISO_INSTANT.test(recency) || Number.isNaN(Date.parse(recency)))",
    to: 'if (false)' },
  { id: 'paging-端点不拒绝坏游标', file: 'lib/endpoints.js',
    judges: ['overview-paging.test.mjs', 'overview-scale.test.mjs'],
    judgeTests: ['overview：游标认不出时响亮拒绝（bad-request），绝不静默从头开始'],
    // 「解不出就从第一页开始」会让翻页永远翻不完：每页都回同一批条目，界面无限追加重复行，
    // 而用户看到的是一份「永远滚不到底」的列表，不是一句报错。
    // 判据：tests/overview-paging.test.mjs 的「游标认不出时响亮拒绝（bad-request）」。
    // ⚠️ 2026-10-15 端点注册表重构后重锚：overview 的 handler 体缩进从 20 格变 16 格
    // （switch case → ENDPOINTS.overview.to），且 `buildOverview` 多了 ctx 首参 ⇒ 旧 from 串失配。
    // 2026-11-16 阶段 5 核过：defineEndpoint 只换了表项的 opener，handler 体缩进不变 ⇒ 无需重锚。
    // ⚠️ 2026-11-18 阶段 6：围栏解码收进 item-page 的三态结果（ADR-0004）⇒ 锚点改成 malformed 那一臂。
    // 语义不变：认不出游标时**响亮拒绝**，而不是静默从第一页开始。
    from: "            if (parsed.status === 'malformed')\n                return fail('bad-request', '未知的续页游标（格式应为 \"<recency>|<id>\"）：' + raw);",
    to: "            if (parsed.status === 'malformed')\n                return ok(buildOverview(ctx, undefined, undefined, scope));" },
  { id: 'paging-到底也硬给续页游标', file: 'lib/item-page.js',
    judges: ['overview-paging.test.mjs', 'overview-scale.test.mjs', 'item-page.test.mjs'],
    judgeTests: [
      'overview 分页：第 300 与第 301 条的边界不重不漏，末页没有 nextCursor',
      '判尾：到底时不硬给续页游标；恰好取满也不算「还有下一页」',
    ],
    // 到底时还给游标 ⇒ 客户端一直显示「加载更多」，点下去得到空页（界面上的死按钮）。
    // 判据：tests/overview-paging.test.mjs 的「末页没有 nextCursor」。
    // ⚠️ 2026-11-18 阶段 6：判尾搬进 src/item-page.ts；批次变量改名 fetched。
    from: 'const nextCursor = lastDelivered >= 0 && (lastDelivered + 1 < fetched.length || !exhausted)',
    to: 'const nextCursor = lastDelivered >= 0' },
  // ── 一页条目：分页协议自己的失效面（2026-11-18 阶段 6 / ADR-0004）──────────────
  // 搬迁后这四条守的是**模块内部**的判定：围栏、孤儿过滤、判尾依据、JS 续页方向。
  // 每条都有一条只属于它的判据；from 照 lib/item-page.js 的产物形状逐字抄，已核 OCCURRENCES=1。
  { id: 'page-围栏不校验范围（跨范围游标被接受）', file: 'lib/item-page.js',
    judges: ['item-page.test.mjs', 'folder-browse.test.mjs', 'tag-browse.test.mjs'],
    judgeTests: [
      '栅栏：同范围可解，成员变动 / 别的范围失配，垃圾体是 malformed（三态不许合并）',
      '文件夹游标绑定范围与成员：无范围/别的文件夹/成员变动后的旧游标全部 bad-request',
      '标签游标绑定 id：无范围或别的标签游标都 bad-request',
    ],
    // 栅栏键（folder:<hash> / tag:<id>）长度固定 ⇒ 去掉前缀校验后，**别的文件夹/标签的游标**会被
    // 按当前前缀长度切片、恰好切出合法游标体 ⇒ 静默按错误的范围续页（成员变了、排序重排，用户看不出）。
    // 判据：文件夹/标签浏览的 bad-request 用例 + 模块围栏三态用例。
    from: "    if (!raw.startsWith(prefix))\n        return { status: 'mismatch' };",
    to: "    if (false)\n        return { status: 'mismatch' };" },
  { id: 'page-孤儿行照发（不按源集合过滤）', file: 'lib/item-page.js',
    judges: ['endpoints-perfeed-unread.test.mjs', 'item-page.test.mjs'],
    judgeTests: [
      '已退订源的残留条目：既不进账目，也不许把列表的截断窗口占掉（退订后没清干净 / 手工改库）',
      '窗口放大：孤儿占掉的窗口必须被补回来，取回的条数始终是 window + 1',
    ],
    // 退订残留 / 手工改库的行会直接出现在右栏，点开是一条「源已不存在」的条目 —— 访问期挡板失效。
    from: "            if (!knownFeedIds.has(row[1].feedId))\n                continue;",
    to: "            if (false)\n                continue;" },
  { id: 'page-判尾用「取不满」反推', file: 'lib/item-page.js',
    judges: ['item-page.test.mjs', 'overview-paging.test.mjs', 'folder-browse.test.mjs'],
    judgeTests: [
      '判尾：到底时不硬给续页游标；恰好取满也不算「还有下一页」',
      'overview 分页：第 300 与第 301 条的边界不重不漏，末页没有 nextCursor',
      '文件夹浏览先按成员筛选再限页：成员条目不会落到跨源首页之外',
    ],
    // 代码注释点名的那条错法：拿「这一页取满/取不满」反推还有没有下一页。恰好取满的末页会多给一个
    // 游标 ⇒ 界面上是「加载更多」死按钮，点下去得到空页。
    from: 'const nextCursor = lastDelivered >= 0 && (lastDelivered + 1 < fetched.length || !exhausted)',
    to: 'const nextCursor = lastDelivered >= 0 && rows.length >= pageSize' },
  { id: 'page-JS 续页谓词方向写反', file: 'lib/item-page.js',
    judges: ['item-page.test.mjs', 'overview-paging.test.mjs'],
    judgeTests: [
      'afterCursor：recency 降序、同 recency 内 id 升序的「严格之后」',
      '旧实现（createStore）：listRecent 的游标谓词与自持实现逐条同义',
    ],
    // JS 侧唯一一份续页谓词（两份适配器共用）：同 recency 内方向写反 ⇒ 打平点上重复 + 漏。
    from: '    return row.recency < cursor.recency || (row.recency === cursor.recency && row.id > cursor.id);',
    to: '    return row.recency < cursor.recency || (row.recency === cursor.recency && row.id < cursor.id);' },
  // ── 端点注册表（2026-10-15 H1 深化）─────────────────────────────────────────
  // 两条各守一个**横切**失效面：前者是「表与名字表分家」，后者是「守卫顺序被绕过」。
  // 判据都在 tests/endpoint-registry.test.mjs（新增文件，见该文件头注释）。
  { id: 'endpoint-表漏掉一个端点', file: 'lib/endpoints.js',
    judges: ['endpoint-registry.test.mjs'],
    judgeTests: ['注册表覆盖全部端点名字，不多不少', '金标准：toggleStar 回包含 starred 且翻转', 'carriesAccount：标记集合恰好是那 5 个端点（声明本身有判据）', 'carriesAccount：每个标记的端点走成功路径都带回未读账'],
    // 病象：表里少一个 key ⇒ 该端点名下落到 undefined ⇒ 用户点它得到 unknown-endpoint。
    // 类型层本该拦住（Record<Endpoint,…> 穷尽），但产物是 JS，运行时只有这条断言看得见。
    // ⚠️ 2026-11-16 阶段 5 重锚：表项从对象字面量改成 defineEndpoint({...})。
    from: '    toggleStar: defineEndpoint({',
    to: '    toggleStarX: defineEndpoint({' },
  // ── 端点入参声明（2026-11-16 阶段 5 / ADR-0003）────────────────────────────
  // 三条各守一个失效面：必需键被放宽、非空约束被放宽、解析失败被忽略。
  // 判据都在 tests/endpoint-payloads.test.mjs（不经 handler 的契约表 + 不触达 store 的信封用例）。
  { id: 'payload-必填键被放宽成可选', file: 'lib/endpoint-payloads.js',
    judges: ['endpoint-payloads.test.mjs'],
    judgeTests: ['入参声明：每条坏样本都被拒，并给出字段路径', '坏入参：统一 bad-request 信封、details.issues 指出字段，且不触达 store'],
    // 病象：saveViewPreferences 缺 preferences 时静默把默认视图写盘（本轮修掉的那个缺陷）。
    from: 'export const saveViewPreferencesPayload = z.object({ preferences: z.unknown() });',
    to: 'export const saveViewPreferencesPayload = z.object({ preferences: z.unknown().optional() });' },
  { id: 'payload-itemId 空串放行', file: 'lib/endpoint-payloads.js',
    judges: ['endpoint-payloads.test.mjs'],
    judgeTests: ['入参声明：每条坏样本都被拒，并给出字段路径'],
    // 病象：非空约束被放宽 ⇒ {itemId:''} 走到 not-found，用户看到「条目不存在」而不是坏入参。
    from: 'export const itemIdPayload = z.object({ itemId: z.string().min(1) });',
    to: 'export const itemIdPayload = z.object({ itemId: z.string() });' },
  { id: 'endpoint-入参解析失败被忽略', file: 'lib/endpoints.js',
    judges: ['endpoint-payloads.test.mjs'],
    judgeTests: ['坏入参：统一 bad-request 信封、details.issues 指出字段，且不触达 store'],
    // 病象：safeParse 失败被忽略 ⇒ handler 拿到 undefined，坏入参变成 internal（不再是一种信封）。
    from: '            if (!parsed.success) {',
    to: '            if (false) {' },
  { id: 'endpoint-未就绪守卫被绕过', file: 'lib/endpoints.js',
    judges: ['endpoint-registry.test.mjs'],
    judgeTests: ['not-ready 先于 unknown-endpoint：未就绪时任何名字都回 not-ready'],
    // 病象：守卫被绕过 ⇒ 存储没起来时先撞「未知端点」或直接抛错，而不是稳定回 not-ready。
    // 判据：endpoint-registry.test.mjs 的「not-ready 先于 unknown-endpoint」用例（三个名字都试）。
    from: "            if (!target)\n                return fail('not-ready', '存储域尚未就绪，稍后重试');",
    to: "            if (false)\n                return fail('not-ready', '存储域尚未就绪，稍后重试');" },
  // （2026-11-18 阶段 6 退役）原 `paging-旧实现谓词的 id 方向写反`：旧适配器的内联谓词已被
  // `src/item-page.ts` 的 `afterCursor` 取代（ADR-0004 决定 4），代码里不再有第二份可变异的方向判定。
  // 同一个失效面现在由 `page-JS 续页谓词方向写反` 施加，且它的 judges 里就有那条「旧实现 ↔ 自持实现
  // 逐条同义」用例 —— 旧适配器仍被钉住，只是不再各写一份变异。
  // 另三条同义性基线（2026-10-11 终检评审 G1）：`listRecent` 的游标谓词原先**是唯一一条**
  // 「旧实现 ↔ 自持实现」的对照用例，其余三条各自只被钉在「与自己的桩一致」上 ——
  // 两份实现悄悄分家时没有任何断言翻红，而生产早已是 createSqliteStore：坏掉的那份没人用。
  // 本轮在新用例里把**同一份夹具**喂给两边、逐字段 deepEqual（tests/overview-paging.test.mjs
  // 的「逐方法同义性」三条），下面三条变异各自指向其中一条。
  // ⚠️ from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4），OCCURRENCES 均独立实测 = 1。
  { id: 'store-旧实现每源账目不铺键域', file: 'lib/store.js',
    judges: ['overview-paging.test.mjs'],
    judgeTests: ['逐方法同义性：unreadPerFeed 与旧实现逐键相等（0 未读的源两边都留 0 值键）'],
    // 键域退回「条目里出现过的源」⇒ 0 未读的源丢键（左栏那一行的角标变空白而不是 0），
    // 与自持实现「先按 feeds 表铺 0」不再同义。
    // 判据：tests/overview-paging.test.mjs 的「逐方法同义性：unreadPerFeed…逐键相等」。
    from: 'unreadPerFeed: (feedIds, window) => countUnreadPerFeed(feedIds, [...items.entries()].map(([, record]) => record), window),',
    to: 'unreadPerFeed: (feedIds, window) => countUnreadPerFeed([...items.entries()].map(([, record]) => record.feedId), [...items.entries()].map(([, record]) => record), window),' },
  { id: 'store-旧实现正文清单字符数恒 0', file: 'lib/store.js',
    judges: ['overview-paging.test.mjs'],
    judgeTests: ['逐方法同义性：listArticleCacheEntries 与旧实现逐条相等（只交出 { id, chars, fetchedAt }）'],
    // 清算原料的 chars 退回 0 ⇒ 正文缓存闸门以为整库正文一文不值，淘汰名单算出来与自持实现不同
    //（chars 是 articleCharsOf 的第二处调用点，两处分家时这条要翻红）。
    // 判据：tests/overview-paging.test.mjs 的「逐方法同义性：listArticleCacheEntries…」。
    from: 'chars: articleCharsOf(record.article),',
    to: 'chars: 0,' },
  // ⚠️ 2026-11-14 撤掉（原 id：store-旧实现候选集放过保持未读）：旧实现里那句
  // `rows.filter((row) => !row.kept)` 已删（保护条款只留 selectCleanup 一处），锚随代码消失。
  // 它守的行为改由 retention-清理的保持未读保护 覆盖 —— 两个适配器都走同一个判据。
  { id: 'paging-续页不追加而是替换', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'nav-selection.test.mjs'],
    judgeTests: ['分页接线：续页游标在时渲染「加载更多」，点它真的取下一页（并追加到当前列表）', '分页：续页是追加到列表尾部，不是替换（第一页必须还在）', '分页：在途时忽略重复的 loadMore（防连点堆请求）'],
    // 替换 ⇒ 翻到第二页时第一页整个消失（用户找不到刚读的那条）。
    // 判据：tests/nav-selection.test.mjs 的「续页是追加到列表尾部，不是替换」。
    // 2026-11-16 重锚：06c 搬家后 loadMore 的闭包里只剩 get()。
    from: 'items: [...get().items, ...overview.items],',
    to: 'items: overview.items,' },
  { id: 'paging-续页改按本地 items 派生账目', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs'],
    judgeTests: ['分页：每一页都以宿主回包为准整体覆盖账目，绝不在第二页开始派生'],
    // 缺陷本体在翻页处的复现：第二页开始又拿截断视图当真相 ⇒ 左栏各源之和 ≠ 顶栏总未读。
    // 判据：tests/nav-selection.test.mjs 的「每一页都以宿主回包为准整体覆盖账目」。
    // 2026-11-20 重锚（R1 评审 P1）：账目落地现在要带上发请求时的档位。
    from: 'applyAccount(overview, request.window);',
    to: 'set({ unread: overview.items.filter((i) => i.readAt === void 0).length, perFeedUnread: state.perFeedUnread });' },
  { id: 'paging-首屏游标不落 state', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'nav-selection.test.mjs'],
    judgeTests: ['分页接线：续页游标在时渲染「加载更多」，点它真的取下一页（并追加到当前列表）', '分页：续页是追加到列表尾部，不是替换（第一页必须还在）', '分页：每一页都以宿主回包为准整体覆盖账目，绝不在第二页开始派生', '分页：在途时忽略重复的 loadMore（防连点堆请求）'],
    // 首屏不记游标 ⇒ 界面上永远不出现「加载更多」，第 301 条之后仍然到不了（本任务的缺陷原样留下）。
    // 判据：tests/client-bundle.test.mjs 的「分页接线」+ tests/nav-selection.test.mjs 的分页族。
    from: 'nextCursor: overview.nextCursor,',
    to: 'nextCursor: void 0,' },
  { id: 'paging-客户端不回带游标', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'nav-selection.test.mjs'],
    judgeTests: ['分页接线：续页游标在时渲染「加载更多」，点它真的取下一页（并追加到当前列表）', '分页：续页是追加到列表尾部，不是替换（第一页必须还在）', '分页：每一页都以宿主回包为准整体覆盖账目，绝不在第二页开始派生', '分页：在途时忽略重复的 loadMore（防连点堆请求）'],
    // 回了 undefined ⇒ 宿主当成第一页，列表原地重复同一批 300 条（用户看到重复而不是报错）。
    // 判据：tests/nav-selection.test.mjs 的「续页是追加…」里的 pageCalls 断言。
    // 2026-11-15 重锚：同上（deps.rpc）。
    // 2026-11-16 重锚：同上一族（deps.rpc → rpc、state.navSelection → 本地 nav 快照）。
    // 2026-11-20 重锚（R1-03 / 评审 P1）：续页载荷改为从「档位 + 载荷」成对取出的 request 展开。
    from: 'const overview = await rpc("overview", {\n\t\t\t\t\t\tcursor,\n\t\t\t\t\t\t...nav.kind === "folder" ? { folder: nav.folder } : {},\n\t\t\t\t\t\t...nav.kind === "tag" ? { tagId: nav.tagId } : {},\n\t\t\t\t\t\t...request.payload\n\t\t\t\t\t});',
    // 2026-11-16 评审修复：callRpc 在产物里不存在（只有 rpc / deps.callRpc）—— 改成真的打第一页。
    to: 'const overview = await rpc("overview", {});' },
  { id: 'paging-在途不挡重复请求', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs'],
    judgeTests: ['分页：在途时忽略重复的 loadMore（防连点堆请求）'],
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
    judges: ['log-file.test.mjs'],
    judgeTests: ['pruneOldLogs 只删超期的 reader-*.log，绝不碰 config.json / rss.db 及其边车', 'pruneOldLogs 的保留窗口是闭区间：今天 + 前 13 天留，第 14 天前删', 'pruneOldLogs 对认不出的文件名既不删也不崩，且判据只看文件名不看 mtime', 'pruneOldLogs 匹配到同名目录时跳过（EISDIR 不许升级成整次清理失败）'],
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
    judges: ['log-file.test.mjs', 'storage-skeleton.test.mjs'],
    judgeTests: ['pruneOldLogs 只删超期的 reader-*.log，绝不碰 config.json / rss.db 及其边车', 'pruneOldLogs 对认不出的文件名既不删也不崩，且判据只看文件名不看 mtime', 'config.json 缺失且库里有条目 ⇒ 装载必须响亮失败（订阅丢了不许静默变空面板）', 'P2-3 config.json 在但订阅为空、库里却有条目 ⇒ 响亮失败（与 verify-backup 同一条判据）'],
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
    judges: ['log-file.test.mjs'],
    judgeTests: ['pruneOldLogs 匹配到同名目录时跳过（EISDIR 不许升级成整次清理失败）'],
    // 去掉「只删普通文件」这道闸后，一个名字恰好合形、且超期的**目录**会直接进 unlinkSync ⇒
    // EISDIR ⇒ 整次 prune 抛错。危害不是「删错东西」，而是**清理从此每次都失败**：
    // 用户会看到反复的清理告警，而真正该删的超期日志一个都删不掉（紧随其后的 unlinkSync 被跳过）。
    // 判据：tests/log-file.test.mjs 的「匹配到同名目录时跳过（EISDIR 不许升级成整次清理失败）」。
    // lib/storage/log-file.js，独立实测 OCCURRENCES=1。
    from: 'if (entry === undefined || !entry.isFile())',
    to: 'if (false)' },
  { id: 'log-保留窗口多留一天（边界偏移）', file: 'lib/storage/log-file.js',
    judges: ['log-file.test.mjs'],
    judgeTests: ['pruneOldLogs 的保留窗口是闭区间：今天 + 前 13 天留，第 14 天前删'],
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
  //
  // ── teardown 的「abort → 等落定 → close」顺序（2026-10-13 真机缺陷修复）──────────────
  // 病象（真机日志，两次）：两次成功装载之间夹着 装载失败：Error: database is not open。
  // 根因：teardown 是「abort 之后同步 close」，而在途刷新（装载启动的那轮、或面板点的那轮）
  // 仍在写库 —— refreshNow 早在进入时就用 ready() 把 store 抓走了。
  // 承重点就是这个 wait：去掉它 ⇒ close 又跑到在途刷新前头。
  // 判据：tests/teardown-race.test.mjs 两条（两条走不同的 signal 来源：启动那轮带 controller.signal，
  // 面板那轮一个 signal 都没带 —— 后者正是旧代码完全挡不住的入口）。
  // from 照**编译产物**的实际形状写（docs/pitfalls.md 一、1.4）。
  // ⚠️ 2026-10-15（H2 生命周期 module）重锚：这条的代码从 lib/index.js 搬进了 lib/lifecycle.js，
  // 且产物里 `await Promise.all([generation, inFlight])` **出现两次**（:231 是「重复 stop 的空操作分支」，
  //   :252 才是 stop 主路径的等待）——`String.replace` 只改第一处，单行锚会改错地方 ⇒ 必须带上下文。
  // 现在锚串含 try/catch/log 三行，独立实测 OCCURRENCES=1。
  // ⚠️ `to` 里刻意**只用产物作用域内存在的东西**（Promise 是全局）：写成引用某个局外名字会退化成
  // ReferenceError，那种红不算被抓住（docs/pitfalls.md 二、2.7b）。
  // ── 生命周期 module（2026-10-15 H2）────────────────────────────────────────────
  // 搬动前这些判定只活在 src/index.ts 的 apply 闭包与注释里；搬进 lib/lifecycle.js 之后它们
  // 各有了一条可直测的判据（tests/lifecycle.test.mjs），下面三条把它们钉进变异门槛。
  { id: 'lifecycle-重复 stop 不再是空操作', file: 'lib/lifecycle.js',
    judges: ['lifecycle.test.mjs'],
    judgeTests: ['Review Focus 4：stop 重复调用是安全的空操作（不放宽断言、不吞错）'],
    // 病象：effect 重放或异常路径二次进入时，第二次 stop 抛错 ⇒ teardown 抛出去会让宿主把
    // 「资源已回收」报成失败（index.ts 的旧注释里就有这条纪律）。
    from: "if (stopped) {\n            await Promise.all([generation, inFlight]);\n            return;\n        }",
    to: "if (stopped) {\n            throw new Error('重复 stop');\n        }" },
  { id: 'lifecycle-停止后仍交出 store', file: 'lib/lifecycle.js',
    judges: ['lifecycle.test.mjs'],
    judgeTests: ['生命周期：start 走完装载链后 ready() 给出 store，停掉后给 undefined', 'Review Focus 1：start 期间 stop —— 不误关、不泄漏、且落定后不交出 store', 'Review Focus 4：stop 重复调用是安全的空操作（不放宽断言、不吞错）', 'Review Focus 3：stop 之后 refreshNow 报 not-ready，不许拿一个正在关的 store', 'Review Focus 2：重复 start 不会把状态搅乱（幂等：第二次不重跑装载链）'],
    // 病象：cancelled 没参与 ready() 判定 ⇒ 关停之后仍能把正在关的 store 交出去（悬垂句柄）。
    from: 'const ready = () => (cancelled ? undefined : store);',
    to: 'const ready = () => store;' },
  // ⚠️ 2026-10-15（H2）**撤回**一条变异：`lifecycle-守卫抛错不自己关库`。它打的是「守卫抛错时
  // 失败路径必须自己关掉句柄」（lifecycle.ts 的 catch 里那个 db.close()）。**实测这个失效面在
  // macOS 上不可观测**：按变异的改法删掉那个 close 之后，tests/lifecycle.test.mjs（7 条）与
  // tests/storage-skeleton.test.mjs 全绿 —— 删文件不因句柄而失败，重开同名库也不立刻撞
  // SQLITE_BUSY（SQLite 的句柄语义对文件删除不构成约束）。锚串本身是对的（OCCURRENCES=1、
  // 已应用），是**判据不存在**，不是锚写错。保留它只会永远幸存、制造噪声（docs/pitfalls.md
  // 二、2.7：幸存者要么补判据要么撤掉，不许为了清单好看留着）。**代码里的 close 仍在** ——
  // 它是正确性所需，缺的只是一个在本平台抓不到它的判据；该失效面记在 ledger 的「已知不可观测」一节。
  { id: 'teardown-不等在途刷新就关库', file: 'lib/lifecycle.js',
    judges: ['teardown-race.test.mjs'],
    judgeTests: ['启动刷新在飞时 teardown：不得把库关在正在写的刷新底下（无「装载失败 / database is not open」）', '面板触发（RPC）的在飞刷新同样受 teardown 保护：不得写在已关闭的句柄上'],
    from: "try {\n            await Promise.all([generation, inFlight]);\n        }\n        catch (error) {\n            log('等待在途刷新结束时出错",
    to: "try {\n            await Promise.resolve();\n        }\n        catch (error) {\n            log('等待在途刷新结束时出错" },
  // C3 未读账镜像（2026-10-16）：六动作共用「乐观 → RPC → 覆盖 / 回滚」管线。两条判据：
  // ① 成功路径必须拿宿主回包的账整体覆盖 —— 删掉 applyAccount 调用后，回包里的 unread /
  //   perFeedUnread 被整个丢掉（正是 C3 修的缺陷之一），toggleStar 之后账目停在乐观基线。
  //   client-bundle 的「C3：toggleStar 成功后账目以宿主回包为准落地」用它看守（hostTruth=5）。
  // ② 失败必须回滚到按下前 —— undoMarkAll 失败时只恢复 items/账目、不把 undo 条塞回去的话，
  //   「失败 = 撤销没发生」就不成立：条目已翻回未读、撤销条却没了，界面自相矛盾。
  //   client-bundle 的「C3：undoMarkAll 失败恢复撤销条并重新武装 5 秒窗口」用它看守。
  { id: 'client-回包账目必须落地', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs'],
    judgeTests: ['C3：toggleStar 成功后账目以宿主回包为准落地（旧实现把回包整个丢掉）'],
    // 2026-11-20 重锚（R1-03 / 评审 P1）：账目落地现在连发请求时的档位一起传（applyAccount(account, window)）。
    from: 'deps.applyAccount(await deps.callRpc(action.endpoint, payload), request.window);',
    to: 'void (await deps.callRpc(action.endpoint, payload));' },
  { id: 'client-撤销失败必须恢复撤销条', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs'],
    judgeTests: ['C3：undoMarkAll 失败恢复撤销条并重新武装 5 秒窗口（只塞回 state 会常驻）'],
    // from 照产物实测（7 个 tab，进了 rollback 的 if 块后缩进加深；2026-10-16 实测 5-tab 旧串让该变异「未应用」假幸存——锚串必须随产物形状走，docs/pitfalls.md 一、1.4 同款坑）
    from: 'set({ undo: { ids: undo.ids } });\n\t\t\t\t\t\t\tarmUndoExpiry();',
    to: 'armUndoExpiry();' },
  // ③ 身份 CAS：undoMarkAll 失败回滚只在撤销条仍是「本动作清掉后的空态」时才恢复 ——
  //   改成无条件恢复后，交错场景（撤销在飞时更晚的 A 已写下自己的撤销条）里旧 batch 会盖掉
  //   A2 的条目并把窗口重置。client-bundle 的「C3：撤销在飞…」用 shouldFail 时序闸门看守。
  { id: 'client-撤销条恢复带身份 CAS', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs'],
    judgeTests: ['C3：撤销在飞时更晚的 A 写下自己的撤销条，U 失败不得用旧 batch 盖掉它（身份 CAS）'],
    // 2026-11-16 重锚：同上（undo 状态随 06b 搬进 list-actions.ts）。
    from: 'if (get().undo === void 0) {',
    to: 'if (true) {' },
  // C4-b（2026-10-16）：候选清单「基线零覆盖」8 类判定的守门变异 —— 先经 --probes 反向
  // 复测确认幸存（无判据看守），补判定后逐条入正表。expand 不 markRead 已有判据（C1 轮），
  // 未入表。锚串照 lib/client.js 实际形状（tab 缩进 ×5；「未应用」假幸存 = 锚串过期的形态）。
  { id: 'client-probe-弹层守卫', file: 'lib/client.js',
    judges: ['keyboard-routing.test.mjs'],
    judgeTests: ['C4-b 判定：弹层开着时按键被弹层守卫挡住（closest dialog/modal）'],
    // from 照产物 :1448 的真实字节（双引号包 selector、内层转义引号）——首版锚到 :1439 注释里的单引号形状，「改了不生效的行」照样全绿（幸存清单教训：注释不是判定）。
    from: 'if (target.closest("[role=\\\"dialog\\\"], [aria-modal=\\\"true\\\"], dialog") !== null) return true;',
    to: 'if (false) return true;' },
  { id: 'client-probe-isContentEditable', file: 'lib/client.js',
    judges: ['keyboard-routing.test.mjs'],
    judgeTests: ['C4-b 判定：isContentEditable 的元素挡住按键'],
    from: 'target.isContentEditable', to: 'false' },
  // ⚠️ 2026-10-18：judges 从 scroll-dom 改到 client-bundle —— 实测该变异下 scroll-dom 全绿、
  // client-bundle 翻红 7 条（「未读筛选下打开条目…」那一族）。judges 指错文件不报错，
  // 只会让这条变异被**别的**文件判「幸存」。
  { id: 'client-probe-sticky 选中', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs'],
    judgeTests: ['未读筛选下打开条目：条目不该当场消失（sticky 选中），移开后才让位', '正文页 j/k：尊重当前过滤（未读筛选下不跳到已读条目）', '详情页按钮：尊重当前过滤（未读筛选下按钮也跳过已读条目）'],
    from: 'if (item.id === selectedId) return true', to: 'return inScope(item)' },
  { id: 'client-probe-openArticle 视图守卫', file: 'lib/client.js',
    judges: ['keyboard-routing.test.mjs'],
    judgeTests: ['C4-b 判定：正文视图里 V/openArticle 被视图守卫挡住'],
    from: 'case "openArticle":\n\t\t\t\t\tif (view !== "list") return;',
    to: 'case "openArticle":' },
  { id: 'client-probe-expandedView 守卫', file: 'lib/client.js',
    judges: ['keyboard-routing.test.mjs'],
    judgeTests: ['C4-b 判定：expandedView/listView 只在列表页切布局（正文/订阅管理不接管）'],
    from: 'case "expandedView":\n\t\t\t\t\tif (view === "list") store.setLayout("expanded");',
    to: 'case "expandedView":\n\t\t\t\t\tstore.setLayout("expanded");' },
  { id: 'client-probe-Esc 订阅页', file: 'lib/client.js',
    judges: ['keyboard-routing.test.mjs'],
    judgeTests: ['C4-b 判定：订阅管理页按 Esc 不得穿透成 toggleFeeds'],
    from: 'if (view === "feeds") {', to: 'if (false) {' },
  { id: 'client-probe-删 star', file: 'lib/client.js',
    judges: ['keyboard-routing.test.mjs'],
    judgeTests: ['C4-b 判定：s 键星标动作真实接线（star 分支删除时整条红）'],
    from: 'case "star":', to: 'case "star_never":' },
  // ── 文件夹目录与变更接口（M2 02）────────────────────────────────────────
  // 病象：文件夹改名只改了目录、没改成员归属；删除文件夹顺手把订阅也删了；
  // 旧配置读不出目录；OPML 重复导入把本地「未分类」重新套上分组 —— 这些都不会报错，
  // 只会在下一次重启或下一次导入时悄悄改变用户的分类结果。
  // 每条 from 均照**编译产物**的真实形状逐字抄（docs/pitfalls.md 一、1.4）。
  { id: 'folder-新名称不去空白', file: 'lib/folders.js',
    judges: ['folder-storage.test.mjs', 'folder-endpoints.test.mjs'],
    judgeTests: ['文件夹端点：增删改移的返回值与错误码（payload 形状在端点层拦住）', '空文件夹可创建，并在重启后保留（目录不是 feed.folder 的派生物）', '名称校验：空白、超长、重复精确拒绝；80 码点边界按 Unicode 计'],
    from: 'const name = raw.trim();', to: 'const name = raw;' },
  { id: 'folder-创建不拒重复', file: 'lib/folders.js',
    judges: ['folder-storage.test.mjs', 'folder-endpoints.test.mjs'],
    judgeTests: ['文件夹端点：增删改移的返回值与错误码（payload 形状在端点层拦住）', '名称校验：空白、超长、重复精确拒绝；80 码点边界按 Unicode 计'],
    from: 'if (folders.includes(name)) {', to: 'if (false) {' },
  { id: 'folder-创建空目录不落盘', file: 'lib/folders.js',
    judges: ['folder-storage.test.mjs', 'folder-endpoints.test.mjs'],
    from: 'return { ...file, folders: [...folders, name] };',
    to: 'return { ...file, folders };' },
  { id: 'folder-改名不拒碰撞', file: 'lib/folders.js',
    judges: ['folder-storage.test.mjs', 'folder-endpoints.test.mjs'],
    judgeTests: ['文件夹端点：增删改移的返回值与错误码（payload 形状在端点层拦住）', '改名原子更新目录与成员归属，重启后一致；碰撞拒绝且不改盘'],
    from: 'if (folders.includes(to)) {', to: 'if (false) {' },
  { id: 'folder-改名不更新成员归属', file: 'lib/folders.js',
    judges: ['folder-storage.test.mjs', 'folder-endpoints.test.mjs'],
    judgeTests: ['文件夹端点：增删改移的返回值与错误码（payload 形状在端点层拦住）', '改名原子更新目录与成员归属，重启后一致；碰撞拒绝且不改盘'],
    from: 'feeds[feedId] = folderOf(feed) === from ? { ...feed, folder: to } : feed;',
    to: 'feeds[feedId] = feed;' },
  { id: 'folder-删除清掉所有归属', file: 'lib/folders.js',
    judges: ['folder-storage.test.mjs', 'folder-endpoints.test.mjs'],
    judgeTests: ['删除文件夹只解除分类：订阅、条目、已读/星标/保持未读都在'],
    from: 'if (folderOf(feed) !== name) {', to: 'if (false) {' },
  { id: 'folder-移出不清归属', file: 'lib/folders.js',
    judges: ['folder-storage.test.mjs', 'folder-endpoints.test.mjs'],
    judgeTests: ['移动出入：进目录、同位置幂等、目标/源缺失失败、移出清字段'],
    from: 'if (target === undefined)\n        delete next.folder;\n    else\n        next.folder = target;',
    to: 'if (target === undefined)\n        next.folder = current.folder;\n    else\n        next.folder = target;' },
  { id: 'folder-旧配置不派生目录', file: 'lib/storage/config-file.js',
    judges: ['folder-storage.test.mjs'],
    judgeTests: ['旧配置没有 folders 字段：目录从 feed.folder 派生，读取不改写文件', '配置版本策略：v1 可选 folders 与成员分组取并集，写入不升版本', '视图记忆可保存文件夹选中；文件夹删除后回落虚拟视图'],
    from: 'folders: mergeFolderDirectory(explicitFolders, valid),',
    to: 'folders: mergeFolderDirectory(explicitFolders, {}),' },
  { id: 'folder-OPML已存在源套用分组', file: 'lib/feed-intent.js',
    judges: ['folder-endpoints.test.mjs'],
    judgeTests: ['OPML：新源继承分组，重复导入保留本地未分类，导出保持分组'],
    from: 'folder: previous === undefined ? initialFolder : previous.folder,',
    to: 'folder: initialFolder,' },
  { id: 'folder-刷新写入丢目录', file: 'lib/store-sqlite.js',
    judges: ['folder-storage.test.mjs'],
    judgeTests: ['横切不变量：刷新、订阅写入、偏好保存、退订都不得丢目录'],
    from: 'updateConfig(configPath, (current) => ({ ...current, feeds: change(current.feeds) }));',
    to: 'updateConfig(configPath, (current) => ({ version: 1, feeds: change(current.feeds) }));' },
  // ⚠️ 刻意没有「缺 folder 键当未分类」这条变异：它实测是**等价变异** —— 删掉缺键守卫后，
  // 紧接着的「folder 必须是字符串或 null」同样拒绝 undefined（只是错误文案不同），
  // 没有任何输入会改变可观察行为。等价变异不入门槛（AGENTS.md；判定方法同 pitfalls §1 的正文容器）。
  // ── M2 03：文件夹浏览 / 管理 / 搜索（2026-11）──────────────────────────
  // 这一族的失效大半是「静默少几条 / 静默跳回跨源 / 静默套错范围」，不会报错。
  // 每条 from 均照编译产物逐字抄，且用测试钉住可观察结果。
  { id: 'folder-浏览忽略来源范围', file: 'lib/store-sqlite.js',
    judges: ['folder-browse.test.mjs'],
    judgeTests: ['文件夹浏览先按成员筛选再限页：成员条目不会落到跨源首页之外'],
    from: 'const scoped = feedIds === undefined\n                ? undefined\n                : JSON.stringify([...new Set(feedIds)]);',
    to: 'const scoped = undefined;' },
  { id: 'folder-空范围回落全表', file: 'lib/item-page.js',
    judges: ['folder-browse.test.mjs', 'item-page.test.mjs'],
    judgeTests: [
      '空文件夹返回空列表与完整目录；不存在的文件夹明确 not-found',
      '范围映射：tag 范围只取带该标签的行并写入 tag 栅栏；空 folder 是空结果而不是全表',
    ],
    // ⚠️ 2026-11-18 阶段 6：取数调用搬进 src/item-page.ts（ADR-0004），锚点改成「范围 → listRecent
    // 参数」的映射。空成员列表若被当成「没有范围」，空文件夹会查出全库 —— M2 03 的硬要求。
    from: '            return { feedIds: scope.feedIds };',
    to: '            return { feedIds: scope.feedIds.length > 0 ? scope.feedIds : undefined };' },
  // （2026-11-18 阶段 6 退役）原 `folder-游标不校验范围`：围栏校验搬进 src/item-page.ts 后，
  // 它与 `page-围栏不校验范围（跨范围游标被接受）` 是**同一个失效面**（后者同时覆盖标签范围与模块三态），
  // 保留两条等于让一条变异替另一条作证。退役不是删除守卫：folder-browse 的 bad-request 用例仍在，
  // 且由 `page-围栏不校验范围` 施加变异。
  { id: 'folder-左栏不显示空目录', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['文件夹浏览：空目录可见，进入后只显示成员条目，空目录有明确空状态'],
    from: 'for (const name of folderNames) if (!folders.has(name)) folders.set(name, []);',
    to: 'for (const name of []) if (!folders.has(name)) folders.set(name, []);' },
  { id: 'folder-进入按钮变成折叠', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['文件夹浏览：空目录可见，进入后只显示成员条目，空目录有明确空状态', '当前浏览文件夹：改名迁移范围，删除回到跨源列表'],
    // 第一个 onSelectFolder 是「进入文件夹」按钮的点击处理器；改成折叠后点击文件夹名不会切范围。
    // 2026-11-17 重锚：onSelectFolder(row.folder) 在 onClick 与 onKeyDown 各一处；
    // 带上 onClick 前缀后唯一，保留「只坏鼠标路径」的原意。
    from: "onClick: (event) => {\n\t\t\t\t\t\t\t\t\t\tevent.stopPropagation();\n\t\t\t\t\t\t\t\t\t\tonSelectFolder(row.folder);", to: "onClick: (event) => {\n\t\t\t\t\t\t\t\t\t\tevent.stopPropagation();\n\t\t\t\t\t\t\t\t\t\tonToggleFolder(row.folder);" },
  { id: 'folder-改名不迁移选中', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['当前浏览文件夹：改名迁移范围，删除回到跨源列表'],
    // 2026-11-15 重锚：文件夹四动作搬进 src/client/folder-actions.ts 后，编译产物里先取 nav 快照再收窄。
    from: 'const selected = nav.kind === "folder" && nav.folder === from;',
    to: 'const selected = false;' },
  { id: 'folder-删除当前不回落', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['当前浏览文件夹：改名迁移范围，删除回到跨源列表'],
    from: 'if (selected) {\n\t\t\t\t\t\tset({\n\t\t\t\t\t\t\tnavSelection: { kind: "virtual" },',
    to: 'if (false) {\n\t\t\t\t\t\tset({\n\t\t\t\t\t\t\tnavSelection: { kind: "virtual" },' },
  { id: 'folder-搜索不按成员收窄', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['文件夹搜索：范围取成员交集，续页回带查询绑定游标'],
    from: 'const scopedFeedIds = folderIds === void 0 ? search.feedIds : search.feedIds === void 0 ? folderIds : search.feedIds.filter((feedId) => folderIds.includes(feedId));',
    to: 'const scopedFeedIds = search.feedIds;' },
  { id: 'folder-删除确认不说明未分类', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['文件夹管理：创建、改名、移动、删除二次确认与焦点恢复'],
    from: '"」？成员会变为未分类；不会退订，也不会删除文章。"',
    to: '"」？确认删除。"' },
  // ── M2 05：标签持久化与 v1→v2 迁移 ───────────────────────────────────
  { id: 'tag-v1不升级', file: 'lib/storage/db.js',
    judges: ['tag-storage.test.mjs'],
    judgeTests: ['v1→v4 升级：只加表与派生列，条目/正文/游标/阅读状态原样保留，且回填 link_key', '升级失败回滚：版本与新建 DDL 一起回滚，旧表数据不动，修复冲突后可重试'],
    from: 'if (onDisk === 1) {', to: 'if (false) {' },
  // ⚠️ 2026-11-16（M5 02）重锚：v1 的升级从「一次 applyDdl(TAGS_DDL)」改成
  // 「一次 applyDdl(TAGS_DDL + PROGRESS_DDL)」（两步 DDL 同一事务），旧 from 会报**未应用**。
  // 语义不变：v1 升上来必须把标签表建上。
  // ⚠️ 2026-11-16（M5 03）再重锚：v4 让 v1 的升级又多了一段 LINK_KEY_DDL。
  // 语义不变：v1 升上来必须把标签表建上。
  { id: 'tag-升级不建标签表', file: 'lib/storage/db.js',
    judges: ['tag-storage.test.mjs'],
    judgeTests: ['v1→v4 升级：只加表与派生列，条目/正文/游标/阅读状态原样保留，且回填 link_key', '升级失败回滚：版本与新建 DDL 一起回滚，旧表数据不动，修复冲突后可重试'],
    from: "applyDdl(db, 'v1→v4 升级', TAGS_DDL + PROGRESS_DDL + LINK_KEY_DDL, backfillLinkKeys);",
    to: "applyDdl(db, 'v1→v4 升级', PROGRESS_DDL + LINK_KEY_DDL, backfillLinkKeys);" },
  { id: 'tag-升级后版本仍为1', file: 'lib/storage/db.js',
    judges: ['tag-storage.test.mjs'],
    from: 'db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);', to: "db.exec('PRAGMA user_version = 1');" },
  { id: 'tag-重名误报bad-request', file: 'lib/store-sqlite.js',
    judges: ['tag-storage.test.mjs', 'tag-endpoints.test.mjs'],
    judgeTests: ['标签端点：创建/改名/列表/删除与错误码', '标签 CRUD：空标签可见、改名保 id 与关联、删标签不影响文章与阅读状态'],
    // 2026-11-17 重锚：同一句 conflict 在 create 与 rename 各一处；带上 INSERT_TAG 后唯一。
    from: "sql(INSERT_TAG).run(tag.id, tag.name, tag.createdAt);\n            }\n            catch (error) {\n                if (isUniqueTagNameError(error))\n                    throw new TagError('conflict', '标签已存在：' + safeName);",
    to: "sql(INSERT_TAG).run(tag.id, tag.name, tag.createdAt);\n            }\n            catch (error) {\n                if (isUniqueTagNameError(error))\n                    throw new TagError('bad-request', '标签已存在：' + safeName);" },
  { id: 'tag-空标签列表丢失', file: 'lib/store-sqlite.js',
    judges: ['tag-storage.test.mjs', 'tag-endpoints.test.mjs'],
    judgeTests: ['标签端点：创建/改名/列表/删除与错误码', '清理与退订生命周期：文章删除只清标签关联，标签本身保留', '标签 CRUD：空标签可见、改名保 id 与关联、删标签不影响文章与阅读状态'],
    from: 'FROM tags t LEFT JOIN item_tags it ON it.tag_id = t.id',
    to: 'FROM tags t JOIN item_tags it ON it.tag_id = t.id' },
  { id: 'tag-setItemTags不清旧', file: 'lib/store-sqlite.js',
    judges: ['tag-storage.test.mjs', 'tag-endpoints.test.mjs'],
    judgeTests: ['setItemTags：重复去重、混合无效回滚、空数组清空，列表计数同步', 'setItemTags 幂等且混合无效请求不留下部分关联'],
    from: 'runInTransaction(() => {\n                sql(DELETE_ITEM_TAGS).run(target);',
    to: 'runInTransaction(() => {\n                void target;' },
  { id: 'tag-setItemTags不校验标签', file: 'lib/store-sqlite.js',
    judges: ['tag-storage.test.mjs', 'tag-endpoints.test.mjs'],
    judgeTests: ['setItemTags：重复去重、混合无效回滚、空数组清空，列表计数同步', 'setItemTags 幂等且混合无效请求不留下部分关联'],
    from: 'for (const tagId of ids) {\n                if (sql(TAG_BY_ID).get(tagId) === undefined)\n                    throw new TagError(\'not-found\', \'标签不存在：\' + tagId);\n            }',
    to: 'for (const tagId of ids) { if (tagId.length < 0) sql(TAG_BY_ID).get(tagId); }' },
  { id: 'tag-合并丢loser标签', file: 'lib/store-sqlite.js',
    judges: ['tag-storage.test.mjs'],
    judgeTests: ['身份修复合并：幸存条目保留两侧标签并去重，loser 的关联不丢'],
    from: 'sql(COPY_ITEM_TAGS).run(keeperId, loserId);', to: 'void keeperId;' },
  { id: 'tag-改名返回新ID', file: 'lib/store-sqlite.js',
    judges: ['tag-storage.test.mjs'],
    judgeTests: ['标签 CRUD：空标签可见、改名保 id 与关联、删标签不影响文章与阅读状态'],
    from: 'return tagRecordSchema.parse({ ...toTagRecord(current), name: safeName });',
    to: 'return tagRecordSchema.parse({ ...toTagRecord(current), id: randomUUID(), name: safeName });' },
  // ── M2 06：标签浏览/搜索/界面接线 ─────────────────────────────────────
  { id: 'tag-浏览忽略tagId', file: 'lib/store-sqlite.js',
    judges: ['tag-browse.test.mjs'],
    judgeTests: ['标签浏览先按 id 筛选再限页：深页文章不漏，目录保留空标签'],
    // 2026-11-20 R1-01 重锚：六个取数变体收成 recentQuery 一处装配后，原锚串（`const rows = tagId !== undefined`）
    // 消失；同一个判定现在是「范围参数里到底放不放 tagId」——不放进条件就退化成跨源列表。
    from: '...(tagId === undefined ? {} : { tagId })', to: '...({})' },
  { id: 'tag-搜索忽略tagId', file: 'lib/search-worker.js',
    judges: ['tag-browse.test.mjs'],
    judgeTests: ['搜索 + 标签 + 未读取交集，搜索结果也带 tagIds'],
    from: 'if (query.tagId !== undefined) {', to: 'if (false) {' },
  // （2026-11-18 阶段 6 退役）原 `tag-浏览游标绑名称`：PageScope 的 tag 分支只携带 `id`
  // （判别联合，ADR-0004），「拿名字当栅栏键」在类型层面已不可表达 —— 没有东西可变异。
  // 守住它的是 `page-围栏不校验范围` 那条模块用例（值 = id 的栅栏键一旦错，跨标签游标立刻失配）。
  { id: 'tag-左栏丢空标签', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['标签浏览与编辑：左栏行、空标签、列表/正文共用标签栏，频繁切换不高亮成已读'],
    from: '...tags.map((tag) => ({',
    to: '...tags.filter((tag) => (tag.itemCount ?? 0) > 0).map((tag) => ({' },
  { id: 'tag-搜索请求漏tagId', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['标签 + 搜索：搜索请求携带标签 id，结果仍按标签范围显示'],
    from: '...tagId === void 0 ? {} : { tagId },',
    to: '...{},' },
  { id: 'tag-切换标签不重载', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['文件夹浏览：空目录可见，进入后只显示成员条目，空目录有明确空状态'],
    // 2026-11-15 重锚：导航动作搬进 nav-actions.ts 后，state.→get()、load()→reload()。
    from: 'if (!get().search && scopeChanged) reload();',
    to: 'if (false) load("overview");' },
  // ── M3 02：只读模型工具（rss_search / rss_list_feeds / rss_read_article）──────
  // 每条守一处**承重判定**，from 一律照 lib/tools.js 的编译形状写（docs/pitfalls.md 一、1.4），
  // OCCURRENCES 均独立实测 = 1。判据全在 tests/tools.test.mjs。
  // ① 上限夹取：PRD §8.2 的「硬上限 30」只在这里生效，去掉就是「调用方要多少给多少」。
  { id: 'tools-搜索上限不夹取', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_search：默认 10 条、超过 30 夹到 30、非法 limit 响亮失败'],
    from: 'const limit = Math.min(typeof rawLimit === \'number\' ? rawLimit : SEARCH_DEFAULT_ITEMS, SEARCH_MAX_ITEMS);',
    to: 'const limit = typeof rawLimit === \'number\' ? rawLimit : SEARCH_DEFAULT_ITEMS;' },
  // ② 游标栅栏：没有它，换一组筛选条件后拿旧页游标续页会**静默**从别处接着翻。
  // 2026-11-18 阶段 9：搜索端点与 agent 工具共用 src/cursor-fence.ts，栅栏不再是 tools 的私有判定。
  { id: 'fence-查询栅栏不校验条件', file: 'lib/cursor-fence.js',
    judges: ['tools.test.mjs', 'search.test.mjs'],
    judgeTests: ['rss_search：游标必须被查询条件栅栏住，换条件续页响亮失败', '本地搜索跨页稳定，按源、日期、星标和已读筛选，并只查当前缓存'],
    from: "    if (!raw.startsWith(key))\n        return { status: 'mismatch' };",
    to: "    if (false)\n        return { status: 'mismatch' };" },
  // ③ 片段截断：不截就是「一次搜索把整篇摘要灌进上下文」，PRD §8.2 的长度上限靠它兜。
  { id: 'tools-片段不截断', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_search：筛选条件原样进查询，结果按 PRD §8.2 的字段表投影', 'rss_read_article：四种 cached:false 各有可解释原因，命中时给正文并截断', '可变长字段按预算截断并逐字段标记（标题、源标题、链接、失败原因）'],
    from: "return { text: chars.slice(0, max).join(''), truncated: true };",
    to: 'return { text, truncated: false };' },
  // ④ 正文缓存版本：不校验就会把**旧抽取器**抓的正文当成当前正文交给模型（影子内容）。
  { id: 'tools-正文版本不校验', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_read_article：四种 cached:false 各有可解释原因，命中时给正文并截断'],
    from: 'if (article.revision !== EXTRACTOR_REVISION) {',
    to: 'if (article.revision === -1) {' },
  // ⑤ 未就绪：静默返回空列表会让模型把「存储没打开」当成「一条都没有」。
  { id: 'tools-未就绪静默返回空', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['未就绪：store 还没打开时三个工具都响亮失败，不返回空列表冒充结果'],
    from: "if (store === undefined)\n        throw new Error('RSS 阅读器尚未就绪（存储未打开），请稍后重试');",
    to: 'if (store === undefined)\n        return { listFeeds: () => [], unreadPerFeed: () => ({}), listFolders: () => [], listTags: () => [], feed: () => undefined, item: () => undefined };' },
  // ⑥ 未知源 id：不拒绝就等于允许模型用一个拼错的 id 搜索并拿到「空结果」。
  { id: 'tools-未知源不拒绝', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_search：未知源 id / 非真实日期 / 超长关键词都在查询前被拒'],
    from: 'if (feedId !== undefined && store.feed(feedId) === undefined) {',
    to: 'if (false) {' },
  // ⑦ 目录截断：源/文件夹/标签三个目录共用这一处判据，不截就是 300+ 条元数据一次灌进上下文。
  { id: 'tools-目录不截断', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_list_feeds：大目录按预算截断并如实报告（不静默丢源/目录/标签）'],
    from: 'return { total: items.length, truncated: items.length > max, items: items.slice(0, max) };',
    to: 'return { total: items.length, truncated: false, items };' },
  // ⑧ 每源未读：退回常量 0 会让模型看到的「未读」永远是空账（左栏与工具口径分裂）。
  { id: 'tools-每源未读恒零', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_list_feeds：三个目录各自成信封（total / truncated / items），带未读与健康'],
    from: 'unread: unread[id] ?? 0,',
    to: 'unread: 0,' },
  // ⑨ 日期验真：只查正则的话 2026-02-30 会被 Date 悄悄滚成 3 月 2 日，查询会返回一批「合理」结果。
  { id: 'tools-日期不验真', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_search：未知源 id / 非真实日期 / 超长关键词都在查询前被拒'],
    from: 'return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;',
    to: 'return true;' },
  // ⑩ 订阅归属：退订只删源与游标，残留条目仍在 items 表；不挡就会把已退订来源的正文继续发给模型。
  { id: 'tools-退订源残留照发', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_read_article：退订源的残留条目不得泄漏标题、链接或正文'],
    from: 'if (!subscribed.has(record.feedId)) {',
    to: 'if (false) {' },
  // ⑪ 参数类型：退回「类型不对就当没传」，query/feedId 类型错时会静默变成全库查询。
  { id: 'tools-参数类型静默回落', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_search：类型错误的参数明确失败，绝不退回全库查询'],
    from: "    if (typeof value !== 'string')\n        throw new Error(name + ' 必须是字符串');",
    to: "    if (typeof value !== 'string')\n        return undefined;" },
  // ── M3 03：写工具的授权与幂等 ─────────────────────────────────────────
  // ⑫ 无动作调用：不拦就回一个「成功」，调用方以为写了、其实什么都没发生。
  { id: 'tools-写工具无动作也放行', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_update_item：无动作 / 非布尔 / 未知条目 / 退订源条目一律拒绝'],
    from: 'if (setRead === undefined && setStarred === undefined) {',
    to: 'if (false) {' },
  // ⑬ 归属判据：退订源的残留条目不挡就会被 Agent 改写。
  { id: 'tools-写工具不查订阅归属', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_update_item：无动作 / 非布尔 / 未知条目 / 退订源条目一律拒绝'],
    from: 'if (!subscribed.has(existing.feedId)) {',
    to: 'if (false) {' },
  // ⑭ 幂等：已读条目再标已读若刷新时间戳，重试就会改写「最近已读」。
  { id: 'tools-已读重复写刷新时间戳', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_update_item：setRead / setStarred 显式动作生效，重复调用状态不变（幂等，不是 toggle）'],
    from: 'if (setRead === true && current.readAt === undefined) {',
    to: 'if (setRead === true) {' },
  // ⑮ 逐次审批：钩子若对写工具也放行，等于写工具没有任何授权门槛。
  { id: 'tools-写工具绕过审批', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['写工具的逐次审批：pre-execute 只对本工具 ask，其它工具必须放行（waterfall 不许漏 next）'],
    from: "        if (exec.name !== 'rss_update_item')",
    to: '        if (true)' },
  // ── R4：正文抓取失败时回退到订阅源内容（2026-11-19）────────────────────────
  // 回退是纯渲染判定，两条失效都很安静：① 永远不画回退 ⇒ 用户重新只剩一句错误；
  // ② 门槛失效 ⇒ 连 HN 的 "Comments" 都会被当成正文画出来。③ 段落切分退回整块则列表行与
  // 正文回退同时退化成一整段。判据都是用户可见文案 / 段落数，不钉实现形状。
  { id: 'client-回退内容永不渲染', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['正文失败回退：订阅源摘要够门槛时显示来源标注、原因行与全部段落，不显示阅读时长'],
    // 把回退判定短路成永不成立：正文区没有 blocks 时退回旧行为（只画 role="alert"）。
    // 判据：scroll-dom 的回退用例断言 role="note" 必须出现 —— 这条一改就翻红。
    // ⚠️ 2026-11-19 重锚：正文态收成 bodyState 之后，旧锚 `const fallback = …` 已不存在；
    //    锚点改到 `hasFallbackBody` 这一行（它是回退分支的唯一输入）。
    from: 'const hasFallbackBody = !hasRenderedBlocks && hasBodyText(fallbackParagraphs);',
    to: 'const hasFallbackBody = false && hasBodyText(fallbackParagraphs);' },
  { id: 'client-回退门槛失效', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['正文失败回退：摘要不到门槛时保持原错误块，不显示回退标签与重试'],
    // 去掉 hasBodyText 门槛：摘要只有 "Comments" 时也会渲染回退标签与段落。
    // 判据：scroll-dom 的「门槛不过」用例断言 role="note" 为 null —— 改后它会出现。
    // ⚠️ 2026-11-19 重锚：变量随正文态重构改名（summaryParagraphs → fallbackParagraphs）。
    from: 'hasBodyText(fallbackParagraphs)',
    to: 'true' },
  { id: 'html-段落不按换行切', file: 'lib/html-text.js',
    judges: ['article.test.mjs'],
    judgeTests: ['paragraphsOf：HTML 按段落切块（空值认作没有段落，实体先解码再切）'],
    // paragraphsOf 只回一整段：列表行展开与正文回退都会把多段拼成一块（用户可见的多段信息丢失）。
    // 判据：tests/article.test.mjs 的 paragraphsOf 用例逐段 deepEqual 三段。
    from: "return htmlToText(html).split('\\n');",
    to: 'return [htmlToText(html)];' },

  // ── R3：订阅源排序（2026-11-20 评审补条目）──────────────────────────────
  // spec「测试决策」列出的 5 条关键判定 + 退订回滚单独一条。from 全部按 lib/ 产物实际字节
  // 锚定（构建后逐条 grep 核对 OCCURRENCES=1，见 docs/pitfalls.md 1.4）。
  { id: 'feed-order-读侧丢弃未列出源', file: 'lib/feed-order.js',
    judges: ['feed-order.test.mjs'],
    judgeTests: ['派生：已列出的按数组序，未列出的按 feeds 键序追加；未知 id 与空串丢弃，重复保首次', '手改 feedOrder（故意与键序不同）后：读入与关掉重开都按它，且读取不改写文件'],
    // 派生不再追加键序尾部：没排过的源会从 listFeeds / overview 里整批消失（验收 4、13 翻红）。
    from: 'for (const feedId of Object.keys(feeds)) {',
    to: 'for (const feedId of []) {' },
  { id: 'feed-order-写侧落盘未知 id', file: 'lib/feed-order.js',
    judges: ['feed-order.test.mjs'],
    judgeTests: ['派生：已列出的按数组序，未列出的按 feeds 键序追加；未知 id 与空串丢弃，重复保首次', 'reorderFeeds 端点：回包是落盘后的有效顺序；未知 id 丢弃、重复保首次、未点名的按当前顺序排末尾'],
    // 归一不丢未知 id：请求里的垃圾会被写进 config.json（验收 3 的「文件里也没有它」翻红）。
    from: "if (feedId === '' || !Object.hasOwn(feeds, feedId) || seen.has(feedId))",
    to: "if (feedId === '' || seen.has(feedId))" },
  { id: 'feed-order-重排只落请求前缀', file: 'lib/feed-order.js',
    judges: ['feed-order.test.mjs'],
    judgeTests: ['reorderFeeds 端点：回包是落盘后的有效顺序；未知 id 丢弃、重复保首次、未点名的按当前顺序排末尾'],
    // 只落请求前缀：未点名的源下次要靠键序重新推导，同一份顺序长出两个来源（验收 4 翻红）。
    from: 'return [...named, ...deriveFeedOrder(order, feeds).filter((feedId) => !seen.has(feedId))];',
    to: 'return [...named];' },
  { id: 'feed-order-退订不清顺序', file: 'lib/feed-order.js',
    judges: ['feed-order.test.mjs'],
    judgeTests: ['withoutFeedOrder：删掉该 id 的全部出现，其余元素一格不动', '退订：落盘的 feedOrder 里不再有该 id，其它源的相对先后一格不动；重开保持'],
    // 退订不过滤：config.json 的 feedOrder 里永远留着已退订 id（验收 9 的文件级断言翻红）。
    from: 'return order.filter((entry) => entry !== feedId);',
    to: 'return [...order];' },
  { id: 'feed-order-退订回滚丢顺序', file: 'lib/store-sqlite.js',
    judges: ['feed-order.test.mjs'],
    judgeTests: ['退订的库事务失败：顺序回滚到与退订前逐字一致（含被删掉的那一项与它的原位置）'],
    // 回滚只写回 feeds：失败的退订把该源悄悄挪到末尾，整份文件也不再逐字一致（验收 9 回滚段翻红）。
    from: 'if (before.feedOrder === undefined)',
    to: 'if (true)' },
  // ── R1：显示窗（2026-11-20，01 票的宿主半边）────────────────────────────
  // spec「测试决策」列的 8 条里，01 票负责这 4 条（账目 / 拆分 / 客户端三条留给 02–04）。
  // from 全部按 lib/ 产物实际字节锚定（构建后逐条 grep 核对 OCCURRENCES=1，见 docs/pitfalls.md 1.4）。
  { id: '显示窗-用 recency 兜底', file: 'lib/store-sqlite.js',
    judges: ['time-window-endpoints.test.mjs'],
    judgeTests: ['窗口取数：只判 published_at 的半开区间；等于 from 的在、等于 to 的不在、无日期的不出现'],
    // 去掉 IS NOT NULL 守卫：没有发布日期的条目会退到 fetched_at，刚抓到的老文章被算成今天
    // （验收 6 的无日期探针翻红 —— 它的 fetchedAt 恰好落在窗内）。
    from: "const WINDOW_FILTER = '(i.published_at IS NOT NULL AND i.recency >= ? AND i.recency < ?)';",
    to: "const WINDOW_FILTER = '(i.recency >= ? AND i.recency < ?)';" },
  { id: '显示窗-栅栏不含窗口', file: 'lib/item-page.js',
    judges: ['time-window-endpoints.test.mjs', 'item-page.test.mjs'],
    judgeTests: ['窗口进栅栏：切档后的旧游标被响亮拒绝（两个方向），同窗口内正常续页', '窗口栅栏：同窗口往返可解；切窗口 / 带窗游标带回「全部」一律 mismatch'],
    // 前缀只拼 scope：切档后旧游标与当前窗口同前缀，游标静默续页（验收 7 翻红）。
    from: "return [scopeFenceOf(scope), window === undefined ? '' : windowFenceOf(window)]",
    to: 'return [scopeFenceOf(scope)]' },
  { id: '显示窗-日界用毫秒减法', file: 'lib/display-window.js',
    judges: ['display-window.test.mjs'],
    judgeTests: ['今天：本地今天午夜到本地明天午夜（不是 UTC 日界，也不是 24 小时前的此刻）', 'DST 春季：23 小时的自然日仍是「今天」，近 3 天 = 71 小时（不是毫秒减法）'],
    // 毫秒减法假设一天 24 小时：DST 那天 from 落在 23:00/01:00，窗口少看或多看一段（Seam 4 翻红）。
    from: 'const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));',
    to: 'const from = new Date(now.getTime() - (days - 1) * 86400000);' },
  { id: '显示窗-近 3 天算成 3 天前', file: 'lib/display-window.js',
    judges: ['display-window.test.mjs'],
    judgeTests: ['近 3 天 = 含今天在内的 3 个自然日（from 是今天 − 2 天的午夜）'],
    // d - 3 而不是 d - 2：近 3 天变成「今天 + 前 3 天」共 4 天（档位用例翻红）。
    from: 'now.getDate() - (days - 1)',
    to: 'now.getDate() - days' },
  // ── R1 02：账目按窗 ───────────────────────────────────────────────────
  { id: '显示窗-账目忽略窗口', file: 'lib/endpoints.js',
    judges: ['time-window-endpoints.test.mjs'],
    judgeTests: ['五个带账写端点：带窗回窗内账、不带窗回全量，各源之和恒等于总未读', '窗内标读 / 撤销：总数与所属源角标同步 ±1，全程不回全量'],
    // dispatch 合并账目时不传 EndpointOutcome.accountFrame：五个写端点回全量账，
    // 「窗内标读后数字被打回全量」在界面上正是本票要修的病象（验收 12 翻红）。
    // ⚠️ 2026-11-20（R1 04）重锚：视野从 accountWindow 扩成 accountFrame（窗口 + todayFrom），
    // 对应产物是 `accountOf(target, outcome.accountFrame)`。语义不变：dispatch 不传视野 ⇒ 账目回全量。
    from: 'const account = accountOf(target, outcome.accountFrame);',
    to: 'const account = accountOf(target);' },
  { id: '显示窗-账目SQL忽略窗口', file: 'lib/store-sqlite.js',
    judges: ['store-contract.test.mjs', 'time-window-endpoints.test.mjs'],
    judgeTests: ['unreadPerFeed：带窗时与窗口取数同一判据（无日期不进窗），键域不变、各源之和 = 窗内总数', 'overview 带窗账目：只算窗内未读，键域 = feeds 表（0 未读留键），各源之和 = 总未读'],
    // 自持实现的每源账目不再拼 WINDOW_FILTER：SQL 回全量，窗口只在列表取数上生效
    // —— 顶栏 / 每源角标与窗内列表从此对不上（只有带窗账目的对账用例能抓到）。
    from: `const unreadPerFeedSql = (window) => 'SELECT i.feed_id AS feed_id, COUNT(*) AS unread FROM items i WHERE i.read_at IS NULL'
    + (window === undefined ? '' : ' AND ' + WINDOW_FILTER)`,
    to: `const unreadPerFeedSql = (window) => 'SELECT i.feed_id AS feed_id, COUNT(*) AS unread FROM items i WHERE i.read_at IS NULL'` },
  // ── R1 03：客户端顶栏窗口控件 ─────────────────────────────────────────
  { id: '显示窗-客户端只给 overview 带窗', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs'],
    judgeTests: ['R1-03：列表取数 / 续页 / 四个镜像动作 / cleanup 带同一份窗口字段'],
    // 账目镜像不装饰动作载荷：视图停在「今天」时标一次读，回包的账被打回全量，窗内未读数
    // 立刻跳回全局数（spec 验收 12 的客户端半边）。判据是请求体断言 —— 它直接看 from/to。
    // 2026-11-20 重锚（R1 评审 P1）：镜像改为从 windowRequest() 一次取档位 + 载荷，并展开 request.payload。
    from: 'const payload = {\n\t\t\t\t\t...action.payload ?? {},\n\t\t\t\t\t...request.payload\n\t\t\t\t};',
    to: 'const payload = {\n\t\t\t\t\t...action.payload ?? {}\n\t\t\t\t};' },
  // R1 评审 P1：账目回包必须按「发请求时的档位」判断是否落地 —— 删掉这道闸，切档前发出的
  // 标读 / 星标回包晚到时会把旧窗口的账盖到新窗口名下（顶栏说「今天 4 条」，窗内其实只有 2 条）。
  // 判据直接断言回包落地后的 unread / perFeedUnread 仍是窗内值。
  { id: '显示窗-账目不按窗口丢弃过期回包', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['R1 评审 P1：切档前发出的 markRead 回包晚到 —— 不得把「全部」的账盖回「今天」'],
    from: 'if (window !== get().displayWindow) return;',
    to: ';' },
  { id: '显示窗-切档不失效在途续页', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['R1-03 在途续页：切档后旧回包不得把旧档条目追加进来（hold 控制回包顺序）'],
    // 整份重取不递增列表版本号：切档前发出的 loadMore 回包落地时仍被判「版本一致」，
    // 旧档条目被追加进新档列表（spec 验收 17 翻红）。
    from: 'nextListVersion();\n\t\t\t\t\tset(endpoint === "overview" ? {',
    to: 'set(endpoint === "overview" ? {' },
  { id: 'client-排序后不重载', file: 'lib/client.js',
    judges: ['feed-order-client.test.mjs'],
    judgeTests: ['moveFeedOrder：按当前 feeds 顺序整体推出 ids，成功后 reload 用宿主快照改行序'],
    // 成功后跳过 reload：界面停在旧顺序，直到下一次无关刷新（「屏幕旧、文件新」的另一种形态）。
    from: '\t\t\t\t\tawait rpc("reorderFeeds", { ids });\n\t\t\t\t\tawait reload();',
    to: '\t\t\t\t\tawait rpc("reorderFeeds", { ids });' },
  // ── R1 04：未读三联拆分 ────────────────────────────────────────────────
  { id: '显示窗-拆分漏无日期', file: 'lib/store-sqlite.js',
    judges: ['store-contract.test.mjs', 'time-window-endpoints.test.mjs'],
    judgeTests: ['unreadSplit：today / earlier / noDate 三分恒等于全量未读，只数未读且键域 = 传入的 feeds 表', 'unreadSplit：三分只数未读，且与请求是否带窗口无关；不带 todayFrom 的 overview / refresh 没有这个字段'],
    // 无日期桶恒为 0（`THEN 0 ELSE 0`）：三分之和小于全量未读，顶栏「共 X 条未读 · 今天 N ·
    // 更早 M · 无日期 K」的守恒式当场破掉。不删行、不改参数个数 —— 崩溃式变异是假通过。
    from: "' COALESCE(SUM(CASE WHEN i.published_at IS NULL THEN 1 ELSE 0 END), 0) AS no_date'",
    to: "' COALESCE(SUM(CASE WHEN i.published_at IS NULL THEN 0 ELSE 0 END), 0) AS no_date'" },

  // ── R5 04：表格块（抽取 / 渲染 / 三处字符统计）──
  // 表头恒为空：headerCells 一律 undefined ⇒ 三种表头形态全部退化成数据行，
  // 「表头显示两次 + 表头不加粗」当场可见。
  { id: 'table-表头恒为空', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['表格：<thead> 的行进 header，其余行进 rows；没有 align 属性时字段整体缺席'],
    from: "    const headerCells = headRows[0] ?? (implicitHeader ? firstBody : undefined);",
    to: "    const headerCells = undefined;" },
  // colspan 后不补空串：被跨的列不被占住 ⇒ **同一行里后面的单元格左移**到被跨列上。
  // ⚠️ 这里踩过两次「等价变异」，锚点必须选对（实测，2026-11-21）：
  //   ① 锚在 `line.push('')` 上、只删那一行 ⇒ 短行右补空串（pad 到 colCount）把差异补回来，
  //      `['项目','规格']` 补成 `['项目','规格','']`，与期望完全相同 —— 必然幸存；
  //   ② 锚在 `column += 1` 上 ⇒ 位置其实由 `line.push` 的**顺序**决定，`column` 只影响
  //      「被上方 rowspan 占住」那段的推进，本夹具没有 rowspan，于是也等价。
  // 真正决定「被跨列留空」的是**整个补空循环是否执行**：不跑它，`备注` 会落到第 3 列。
  // 所以锚点选循环的边界（`offset < cell.colspan` → `offset < 1`）。
  { id: 'table-合并单元格错位', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['表格：colspan 内容进起始列、被跨列留空；每行等长'],
    from: "        for (let offset = 1; offset < cell.colspan; offset += 1) {\n            line.push('');\n            declared.push(undefined);\n            column += 1;\n        }",
    to: "        for (let offset = 1; offset < 1; offset += 1) {\n            line.push('');\n            declared.push(undefined);\n            column += 1;\n        }" },
  // rowspan 不占位：后续行不知道那一列被占住 ⇒ 该行整体左移一格，与表头错位。
  // 这是「占位网格」存在的全部理由（spec 决策 17）。
  { id: 'table-rowspan 不占位', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['表格：rowspan 的后续行被占列留空且位置正确（不左移）'],
    from: "        for (let offset = 1; offset < span; offset += 1) {\n            for (let width = 0; width < cell.colspan; width += 1) {\n                const at = start + width;\n                while (nextBlocked.length <= at)\n                    nextBlocked.push(0);\n                nextBlocked[at] = Math.max(nextBlocked[at], span - 1);\n            }\n        }",
    to: "        for (let offset = 1; offset < 1; offset += 1) {\n            for (let width = 0; width < cell.colspan; width += 1) {\n                const at = start + width;\n                while (nextBlocked.length <= at)\n                    nextBlocked.push(0);\n                nextBlocked[at] = Math.max(nextBlocked[at], span - 1);\n            }\n        }" },
  // figure 吞掉表格：figure pass 只救 img，table / pre 区域原样丢弃 ⇒ 三种形态的内容都不见了。
  // 这条守护的是票据原文**不够**的那部分（`<figure><img><table>` 也会丢）。
  { id: 'figure-吞掉表格', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['表格：<figure> 里的表格不被吞（三种形态都要救回来）'],
    from: "            if (hit.name !== 'table' && hit.name !== 'pre')\n                continue;",
    to: "            if (true)\n                continue;" },
  // align 读 style：把 align 的来源换成 style="text-align:…"，于是「style 不被读」这条判据翻红
  // （spec 决策 19a 明确不解析 CSS）。
  { id: 'align-读 style', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    judgeTests: ['表格：align 只认 align 属性，style="text-align" 不读，全列未声明时字段整体缺席'],
    from: "        const declared = attrOf(tag, 'align');",
    to: "        const declared = attrOf(tag, 'style')?.replace(/^[^:]*:\\s*/, '').replace(/;.*$/, '');" },
  // 字符统计忽略表格：table 块既无 text 也无 items ⇒ 整张表算成 0 字符，
  // 大表格不占缓存额度、淘汰口径失真（而界面完全看不出来）。
  { id: 'chars-字符统计忽略表格', file: 'lib/retention.js',
    judges: ['retention.test.mjs', 'store-sqlite.test.mjs'],
    judgeTests: ['articleCharsOf：表格块不再算成 0 字符（否则大表格不占缓存额度）', '字符统计：SQL 侧算出的 articleChars 含表格，且等于 articleCharsOf（口径一致）'],
    from: "        if (block['kind'] === 'table')\n            return sum + tableToText(block).length;",
    to: "        if (block['kind'] === 'table')\n            return sum;" },

  // ── R5 05：模型正文的表格 / runs，与时长里的表格 ────────────────────────────
  // 三条都打在**新增分支本身**上，而不是「把它改坏成另一种错误」：去掉分支后，模型读到的正文里
  // 表格整块消失、链接退化成纯文字、含表格的文章时长偏小 —— 三件事在界面上都没有任何信号
  // （正文面板画的是 React 元素，时长标着「估算」），只有各自的字面断言能抓到。
  //
  // ⚠️ 这三条的失效是**静默**的：不会抛错、不会少一条结果，只是内容变少/数字变小。所以判据必须
  // 断言**字面输出**（`| 参数 | 标称值 |`、`[官方文档](https://…)`、具体分钟数），
  // 只断言「有输出」的用例三条全都放走。
  { id: 'tools-模型正文忽略表格', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_read_article：表格摊成 Markdown 表格，带 runs 的块按 runs 摊平且链接成 [文字](href)'],
    // 去掉 table 分支：表格块落到末尾的默认分支，`String(block.text ?? '')` 是空串，
    // 再被 `lines.filter(line => line !== '')` 滤掉 —— 整张表从模型可见正文里消失。
    // lib/tools.js 实测 OCCURRENCES=1（带上下文锚定，`lines.push(tableToMarkdown(block));` 只此一处）。
    from: "        if (kind === 'table') {\n            lines.push(tableToMarkdown(block));\n            continue;\n        }",
    to: "        if (false) {\n            lines.push(tableToMarkdown(block));\n            continue;\n        }" },
  { id: 'tools-模型正文忽略 runs', file: 'lib/tools.js',
    judges: ['tools.test.mjs'],
    judgeTests: ['rss_read_article：表格摊成 Markdown 表格，带 runs 的块按 runs 摊平且链接成 [文字](href)'],
    // 让 link 不再渲染成 `[文字](href)`：链接文字还在（所以「正文里有没有这个词」的用例放走它），
    // 丢的是**地址** —— 模型从此拿不到原文链接，而这正是 spec 决策 11 要求补的那条分支。
    // lib/tools.js 实测 OCCURRENCES=1。
    from: "        if (run['kind'] === 'link' && typeof href === 'string' && href !== '') {\n            parts.push('[' + text + '](' + href + ')');\n            continue;\n        }",
    to: "        if (false) {\n            parts.push('[' + text + '](' + href + ')');\n            continue;\n        }" },
  // 纯文本投影忽略表格：票据 05 字面列的 `blocksToText-忽略表格`。代码是 04 加的（`blockToText`
  // 的 table 分支），但**判据是 05 补的** —— 04 那轮没有任何用例断言 `blocksToText` 见过表格
  // （实测 grep 为空），所以这条此前无处可挂。去掉分支后表格块落到 `String(block['text'] ?? '')`
  // 得空串，搜索/字符统计/时长三处会一起少内容，而只有这一条断言逐字钉住投影形态。
  // lib/article-text.js 实测 OCCURRENCES=1。
  { id: 'blocksToText-忽略表格', file: 'lib/article-text.js',
    judges: ['article.test.mjs'],
    judgeTests: ['纯文本投影：表格块摊成「表头一行 + 每行一行」，不许算成空'],
    from: "    if (kind === 'table')\n        return tableToText(block);",
    to: "    if (false)\n        return tableToText(block);" },
  // 搜索投影忽略表格：票据 05 字面列的 `search-正文投影忽略 runs/table`。同样地，代码是 04 加的、
  // 判据在 04 的 search.test.mjs（表头词与单元格词各一条命中断言）。这里把它钉进门槛：去掉分支后
  // 表里的词一条都搜不到，而界面只表现为「搜不出东西」——没有报错、没有空状态差异。
  // lib/search-worker.js 实测 OCCURRENCES=1。
  { id: 'search-正文投影忽略 runs/table', file: 'lib/search-worker.js',
    judges: ['search.test.mjs'],
    judgeTests: ['搜索：表格里的词能命中（投影不再只看 text / items）'],
    from: "        if ('kind' in block && block.kind === 'table') {\n            return [tableToText(block)];\n        }",
    to: "        if (false) {\n            return [tableToText(block)];\n        }" },
  { id: 'time-时长忽略表格', file: 'lib/shared.js',
    judges: ['reading.test.mjs'],
    judgeTests: ['表格块算进时长：只有表格时不为 0，表格 + 段落时两半都算'],
    // 去掉 table 分支：表格块两个字段都没有 ⇒ 贡献 0 字 0 词。判据是**具体分钟数**：
    // 只有表格的夹具从 1 变成 0，表格 + 600 字的夹具从 3 变成 2。
    // lib/shared.js 实测 OCCURRENCES=1。
    from: "        if (block['kind'] === 'table')\n            texts.push(tableToText(block));",
    to: "        if (false)\n            texts.push(tableToText(block));" },
  // R6 01：正文图片不再外泄 Referer。删掉 referrerPolicy ⇒ 图片请求重新带上当前页 URL，
  // 第三方图床/CDN/跟踪像素就能读到「读者正在读哪一篇」。这条**独立于折叠/灯箱**：
  // 判据是产物里正文图片那处 props（client-bundle.test.mjs 按 ARTICLE_IMAGE_MAX_HEIGHT 定位，
  // 不认行号），所以并行票新增的 `<img>` 不会让它失效，也不会替它兜底。
  // lib/client.js 实测 OCCURRENCES=1（锚在 loading/decoding 两行的上下文上，单锚 referrerPolicy 也会命中）。
  { id: 'client-图片无 referrerPolicy', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs'],
    judgeTests: ['R6 01：产物里正文图片的 props 带 referrerPolicy: "no-referrer"'],
    from: "\t\t\t\t\t\tloading: \"lazy\",\n\t\t\t\t\t\tdecoding: \"async\",\n\t\t\t\t\t\treferrerPolicy: \"no-referrer\",",
    to: "\t\t\t\t\t\tloading: \"lazy\",\n\t\t\t\t\t\tdecoding: \"async\"," },
  // ── R6 02：图片折叠的决策层（分组纯函数 + expandImages 偏好） ───────────────
  // 这三条守的是**决策层**，不是渲染层：折叠/展开的 DOM 判据要等 03 才存在。
  // 因此 `client-默认值写成折叠` 这条在当前轮**还不能**由渲染用例抓住 —— 它只能由
  // 「偏好值本身」的判据抓（见该条注释）。这是本票已知的判据缺口，03 会补上真正的
  // 「默认展开 ⇒ DOM 里有 <img>」用例，那时这条变异才守到它字面上的那个行为。
  { id: 'client-默认值写成折叠', file: 'lib/preferences.js',
    judges: ['nav-persistence.test.mjs', 'store-sqlite.test.mjs'],
    // 把默认值翻成折叠。所有「reading 里必须带 expandImages: true」的断言会一起红：
    // 归一化后的 reading 与 DEFAULT_READING_PREFERENCES 都会变成 false。
    // lib/preferences.js 实测 OCCURRENCES=1（`expandImages: true,`）。
    from: '    expandImages: true,',
    to: '    expandImages: false,' },
  { id: 'prefs-图片偏好不校验类型', file: 'lib/preferences.js',
    judges: ['nav-persistence.test.mjs'],
    judgeTests: ['sanitizeViewPreferences：图片折叠偏好只判布尔，非布尔回落 true 且不带走同份记忆'],
    // 去掉 `typeof === 'boolean'` 那道闸：字符串 / 数字被原样采用（`"yes"` 会变成一个
    // 字符串真值、`0` 会悄悄关掉图片）。判据是**归一化后的确切值**，不是「有没有值」。
    // lib/preferences.js 实测 OCCURRENCES=1（带上下文锚定，`expandImages:` 只此一处）。
    from: "        expandImages: typeof readingSource['expandImages'] === 'boolean'\n            ? readingSource['expandImages']\n            : DEFAULT_READING_PREFERENCES.expandImages,",
    to: "        expandImages: readingSource['expandImages'] ?? DEFAULT_READING_PREFERENCES.expandImages," },
  { id: 'client-分组只认单张', file: 'lib/image-fold.js',
    judges: ['image-fold.test.mjs'],
    judgeTests: ['分组：连续三张图合成一组（一次展开三张，不是三组）'],
    // 分组函数恒返回单元素组：相邻的三张图变成三组。症状是「点一次提示只放出一张」，
    // 而提示文案「图片 3 张」与 DOM 里的图数对不上。判据在纯函数层（组数 + blockIndexes）。
    // lib/image-fold.js 实测 OCCURRENCES=1（带上下文锚定，`continue;` + `flush();` 只此一处）。
    from: "        if (isImageBlock(block)) {\n            indexes.push(at);\n            members.push(block);\n            continue;\n        }\n        // 任何非 img 块都是边界 —— 包括空 p。\n        flush();",
    to: "        if (isImageBlock(block)) {\n            indexes.push(at);\n            members.push(block);\n            flush();\n            continue;\n        }\n        // 任何非 img 块都是边界 —— 包括空 p。\n        flush();" },
  // ── R6 03：折叠渲染 + Aa 面板开关（渲染层的三条核心判定） ─────────────────────
  // 这三条守的是**渲染层**，与上面 02 的决策层变异互补：02 那三条即使全被抓住，也仍可能
  // 「判定说折叠、DOM 里却有 <img>」—— 那是本票验收 2 唯一的判据，只能在这里守。
  { id: 'client-折叠仍渲染 img', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: [
      '折叠偏好：单图带 caption ⇒ DOM 里没有 <img>，提示是「▸ 图片：<caption>」',
      '折叠偏好：连续三张图合成一组，提示是「▸ 图片 3 张」（不是三条单图提示）',
    ],
    // 折叠分支改成照样渲染 <img>（`fold.shouldRender` 恒真）：提示没了、图片照旧出现。
    // 症状正是本项要修的那件事——DOM 里有 <img> 就有请求、就有 Referer（spec 决策 7）。
    // 判据是「折叠时 DOM 里 <img> 数量为 0」，不依赖 display:none 这类浏览器实现细节。
    // lib/client.js 实测 OCCURRENCES=1（`fold.shouldRender(group.index)` 只此一处）。
    from: "if (fold.shouldRender(group.index)) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ArticleBlockView, { block }, index);\n\t\t\t\t\t\t\t\t\tif (group.blockIndexes[0] !== index) return null;",
    to: "if (true) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ArticleBlockView, { block }, index);\n\t\t\t\t\t\t\t\t\tif (group.blockIndexes[0] !== index) return null;" },
  { id: 'client-折叠提示可聚焦', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['折叠提示不在 Tab 序里：tabIndex < 0，且不是 BUTTON / SUMMARY / INPUT / SELECT / TEXTAREA、不是带 href 的链接'],
    // 提示改成 `<button>`：Tab 能选中它、且自带空格激活语义。
    // ⚠️ 这条**只可能**被验收 6（结构判据）抓住 —— jsdom 里普通 button 收到空格既不
    // preventDefault 也不 click（实测），所以「空格翻页」那条对它恒绿。两条形态各守一面。
    // lib/client.js 实测 OCCURRENCES=1（ImageFoldHint 的 jsx 元素名只此一处）。
    from: "function ImageFoldHint({ group, onExpand }) {\n\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"div\", {",
    to: "function ImageFoldHint({ group, onExpand }) {\n\t\t\treturn /* @__PURE__ */ (0, react_jsx_runtime.jsx)(\"button\", {" },
  { id: 'client-折叠提示吞空格', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['折叠提示不抢空格：向提示元素本身派发 keydown，正文仍按一屏翻页且图片仍折叠'],
    // 提示加 onKeyDown 里 preventDefault（照抄 Aa 面板 summary 那条先例）：
    // routeKey 的 `event.defaultPrevented` 守卫会提前 return ⇒ 翻页静默失效。
    // ⚠️ 这条**只可能**被验收 5 抓住，而验收 5 必须把事件派发到提示元素**本身**：
    // 夹具的 press() 派发到 document，抓不到这个缺陷（spec 验收 5 的实测记录）。
    // lib/client.js 实测 OCCURRENCES=1（ImageFoldHint 的 onClick 只此一处）。
    from: "onClick: () => {\n\t\t\t\t\tonExpand(group.index);\n\t\t\t\t},\n\t\t\t\tstyle: {\n\t\t\t\t\tmargin: \"0 0 1.1em\",\n\t\t\t\t\tpadding: \"6px 10px\",",
    to: "onClick: () => {\n\t\t\t\t\tonExpand(group.index);\n\t\t\t\t},\n\t\t\t\tonKeyDown: (event) => {\n\t\t\t\t\tif (event.key === \" \") event.preventDefault();\n\t\t\t\t},\n\t\t\t\tstyle: {\n\t\t\t\t\tmargin: \"0 0 1.1em\",\n\t\t\t\t\tpadding: \"6px 10px\"," },
  // ── R6 04：`i` 键切换整篇图片 ───────────────────────────────────────────────
  // 这四条守的是「一次按键收掉全篇」这条主路径的三个不同环节：
  //   ① `routeKey` 里写不写篇级覆盖（语义本身）；
  //   ② 状态有没有进 `KeyRoutingCtx`（按键与渲染的接线）；
  //   ③ 状态有没有进 effect 依赖数组（闭包捕获旧值）；
  //   ④ 动作在产物里是不是**字面量** return（反向覆盖正则看不看得见它）。
  // ①②③ 必须各有一条：03 的实测教训是「测试全绿但按键与渲染脱钩」与「第二次按不生效」
  // 是两种不同缺陷，一条变异守不住另一条。
  { id: 'client-i 键不改会话覆盖', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: [
      'i 键切换整篇图片：折叠偏好下按一次全部出现，再按一次全部消失（依赖数组没漏）',
      'i 清空组覆盖：先点开某一组再按 i，全篇统一到同一形态（不是「部分展开取反」）',
    ],
    // `i` 解析出动作、`routeKey` 也进了分支，但**不写**篇级覆盖（把那次写入抹成空操作）。
    // 症状正是本票要修的那件事：按 `i` 毫无反应，DOM 里的 `<img>` 一个都不变（spec 验收 4）。
    // 判据是「按一次 ⇒ 三张图全部出现」，不依赖 store 里的布尔值。
    // lib/client.js 实测 OCCURRENCES=1（`ctx.setImagesExpanded(!baseline)` 只此一处）。
    from: "\t\t\t\t\t\tctx.setImagesExpanded(!baseline);",
    to: "\t\t\t\t\t\tvoid baseline;" },
  { id: 'client-i 的状态不传给 routeKey', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['i 键切换整篇图片：折叠偏好下按一次全部出现，再按一次全部消失（依赖数组没漏）'],
    // 状态**没进** `KeyRoutingCtx`：`ctx.imagesExpanded` 永远是 undefined ⇒ 基线恒等于偏好，
    // 于是每次按 `i` 都写「!偏好」这同一个值 —— 第一次展开成功、第二次收不起来。
    // 这一条与「不改会话覆盖」不同：那个是分支里没写，这个是**按键读不到状态**（spec 验收 18）。
    // ⚠️ 只摘 `imagesExpanded`、**保留** `setImagesExpanded`：若把 setter 也摘掉，按下会抛
    // `TypeError: ctx.setImagesExpanded is not a function` —— 那是崩溃式假通过（pitfalls §2.7b），
    // 套件红了却没有任何断言真的观察到「按键与渲染脱钩」。
    // lib/client.js 实测 OCCURRENCES=1（ctx 字面量里那四行连续）。
    from: "\t\t\t\t\t\t\thelpOpen,\n\t\t\t\t\t\t\tsetHelpOpen,\n\t\t\t\t\t\t\timagesExpanded,\n\t\t\t\t\t\t\tsetImagesExpanded,",
    to: "\t\t\t\t\t\t\thelpOpen,\n\t\t\t\t\t\t\tsetHelpOpen,\n\t\t\t\t\t\t\tsetImagesExpanded," },
  { id: 'client-i 的状态不在依赖数组里', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: ['i 键切换整篇图片：折叠偏好下按一次全部出现，再按一次全部消失（依赖数组没漏）'],
    // 把 `imagesExpanded` 从 keydown effect 的依赖数组里拿掉：监听器闭包读到的是**注册那一刻**
    // 的 `undefined` ⇒ 第二次按 `i` 仍以为基线是偏好（折叠），于是又写一次「展开」，图片收不起来。
    // 这正是 2026-10-15「拿掉 expanded 后按 o 永远收不起来、当时 402 条测试全绿」的同族事故。
    // ⚠️ 判据必须是**连按两次**：只按一次时读旧值也得到正确结果，那条用例对它恒绿。
    // lib/client.js 实测 OCCURRENCES=1（依赖数组尾部那三行）。
    from: "\t\t\t\t\thelpOpen,\n\t\t\t\t\timagesExpanded,\n\t\t\t\t\texpandedGroups\n\t\t\t\t]);",
    to: "\t\t\t\t\thelpOpen,\n\t\t\t\t\texpandedGroups\n\t\t\t\t]);" },
  { id: 'keys-i 写成三元', file: 'lib/keys.js',
    judges: ['keys.test.mjs'],
    judgeTests: ["产物字节：lib/keys.js 里存在字面量 return 'toggleImages'（不许写成三元）"],
    // 把 `case 'i'` 的字面量 return 换成**三元**。这条守的是「反向覆盖正则看不看得见这个动作」：
    // `tests/keys.test.mjs` 的「帮助表反向覆盖」用 `return\s+'([A-Za-z]+)'` 从产物里抓动作名，
    // 三元里的返回值抓不到（实测它只抓到 21 个动作，漏掉 pageDown / pageUp / halfPageDown /
    // halfPageUp 这四个三元里的返回值）⇒ 反向覆盖对它**恒绿**，这是既存判据的漏洞。
    // 所以本条的判据必须是「断言产物字节里有字面量 `return 'toggleImages'`」（spec 验收 16）。
    //
    // ⚠️ 偏离 spec 给出的 `to`（`return view === 'article' ? … : …`）：`view` 在 `keys.ts` 的
    // 作用域里**不存在**，那样写一按下就是 `ReferenceError: view is not defined` ——
    // 崩溃式变异是假通过（pitfalls §2.7b）：套件红了，但没有任何断言真的观察到「产物里没有字面量」。
    // 改用 `key === 'i'` 这个**在作用域内**的条件，语义与原来完全等价（`i` 仍解析成 toggleImages），
    // 于是唯一变红的就是那条字节断言 —— 这恰好证明它是这条判据唯一的守门人。
    // lib/keys.js 实测 OCCURRENCES=1（`case 'i': return 'toggleImages';` 只此一处）。
    from: "        case 'i': return 'toggleImages';",
    to: "        case 'i': return key === 'i' ? 'toggleImages' : 'none';" },
  // ── R6 05：组级覆盖（点提示只展开那一组）─────────────────────────────────────
  // spec 已批的 14 条变异里**没有**组级覆盖的专属条目（spec「覆盖缺口（已知，未补）」），
  // 于是本票的核心判据「第二组仍折叠」在门槛里没有守门人：`client-i 键不改会话覆盖` 等四条
  // 守的都是**篇级**覆盖那一路，点提示这一路无论写成什么形态都不会被它们看见。
  //
  // 缺陷形态：点提示时写**篇级**覆盖而不是组覆盖 —— 读者指着第一组说「我要看这一组」，
  // 结果整篇的图都放出来了。这正是「鼠标路径与 `i` 各有语义」这条决定要防的那件事：
  // 两者若都写篇级覆盖，`i` 清空组覆盖就没有对象可清，两条路径的语义也就塌成一条。
  { id: 'client-点提示切整篇', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    judgeTests: [
      '点提示只展开那一组：组内 <img> 出现且 src 与原块一致，另一组仍折叠',
      '组覆盖优先于篇级覆盖：按 i 把整篇写成折叠后，点过的那一组仍然展开',
      '组覆盖不落盘：Esc 回列表后重开同一篇，回到偏好决定的初始形态',
    ],
    // 把 `expandImageGroup` 的函数式累加换成一次篇级覆盖写入（`setImagesExpanded(true)`）。
    // 保留 `useCallback` 的包装与空依赖数组：回调的身份语义不变，唯一变的是**它写了哪个状态**。
    // ⚠️ `setImagesExpanded` 必须真的在该作用域内可达（不是换一个「等价但不崩溃」的写法就完事）：
    // 它由同一个组件函数里更早的 `useState` 解构而来（产物 5793 行的
    // `const [imagesExpanded, setImagesExpanded] = useState(void 0)`，早于 5871 行的本函数），
    // 所以 `const` 的 TDZ 不成立，按下提示不会抛 `ReferenceError` —— 这是「语义等价于缺陷」
    // 而不是「崩溃式假通过」的前提（pitfalls §2.7b）。
    // 判据必须看**第二组仍折叠**：单组夹具对「展开这一组」与「展开整篇」恒绿，
    // 所以上面三条 judgeTests 用的都是两组夹具（1 张 + 2 张，中间夹一段文字）。
    // lib/client.js 实测 OCCURRENCES=1（整个 expandImageGroup 定义体只此一处）。
    from: "\t\t\t\tconst expandImageGroup = (0, react.useCallback)((groupIndex) => {\n\t\t\t\t\tsetExpandedGroups((current) => {\n\t\t\t\t\t\tif (current.has(groupIndex)) return current;\n\t\t\t\t\t\tconst next = new Set(current);\n\t\t\t\t\t\tnext.add(groupIndex);\n\t\t\t\t\t\treturn next;\n\t\t\t\t\t});\n\t\t\t\t}, []);",
    to: "\t\t\t\tconst expandImageGroup = (0, react.useCallback)((groupIndex) => {\n\t\t\t\t\tvoid groupIndex;\n\t\t\t\t\tsetImagesExpanded(true);\n\t\t\t\t}, []);" },
]
