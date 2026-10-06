# @dsh-external/dsh-rss-reader

Google Reader 式阅读流：RSS/Atom 订阅 + 条目流 + 未读态 + 键盘流。
当前进度：**M0 入口 + M1 数据面 + M2 阅读面（宿主侧已验证）**。浏览器侧待看过实物再定优化。

## 入口：侧栏图标 → 主栏阅读器

侧栏图标「RSS 阅读器」是唯一入口，点击即在**主栏**打开阅读器。

`sidebar.panellist` 这个座位没有「开右栏」的口子（注册项只有 `id/order/label`），其 id 还必须
同名于 `main` 座位的 key，否则点选即抛错——所以成对注册、阅读器直接渲染在 `main` 面板。

> 试过两次别的形态，都被实际使用否决并已移除：① `sidebar.footer.action` 底部入口；
> ② 把 `main` 面板做成转发器、把阅读器开进右栏（实测转发不生效，只留下一个点了没反应的
> 兜底按钮，2026-10-06 回退）。

## 浏览器半 ↔ 主进程半

**不**走 `ctx.connection.rpc.handle`（技能文档推荐的那条）：它把 owner 绑定到 connection
插件自己的 ctx，而那个 ctx 解析不到 `webServer`，实测抛
`cannot get property "webServer" without inject`，且全仓库无产品插件使用它。

本插件改用宿主自有能力：`ctx.webServer.register({kind:'prefix', path:'/rss-reader-api'})`
承载通道，并在 handler 里调 `ctx.connection.requestRejection(req)` 套用**同一套**
Host/Origin 与浏览器鉴权（实测：未带 token 的请求得 401，不存在的路由得 404）。

## 架构（host 半已落地）

| 文件 | 职责 |
|---|---|
| `src/feed/fetch.ts` | 条件请求（ETag/Last-Modified → 304）、超时、体积上限、BOM/GBK 解码 |
| `src/feed/parse.ts` | RSS 2.0 / RSS 1.0(RDF) / Atom 三格式归一（fast-xml-parser） |
| `src/feed/date.ts` | 日期 → ISO8601 UTC（RFC822 手工兜底；认不出就返回 undefined，不编造） |
| `src/feed/item-id.ts` | 条目稳定 id（已读态绑在它上面） |
| `src/domain.ts` | `ctx.storageDomain` 域声明（zod schema）：feeds / items / cursors |
| `src/store.ts` | 域 → 窄接口适配器（编排层只依赖接口，测试用内存实现替换） |
| `src/refresh.ts` | 刷新编排：逐源抓取 → 解析 → 去重 → 入库 → 更新游标 |
| `src/index.ts` | Config + apply：开域、播种、刷新、日志 |
| `src/client/index.tsx` | 侧栏图标 `sidebar.panellist` + 同 id 主面板 `main`（M0 占位） |

数据落盘在宿主存储域的 JSON 后端：`$DSH_HOME/storages/rss_reader.json`。

## 数据模型

- `feeds`：key = 归一化 URL；存 title / etag / lastModified / lastFetchedAt / lastFailure。
- `items`：key = 稳定派生 id；存 feedId / title / link / publishedAt / summary / fetchedAt / **readAt** / starred。
- `cursors`：key = 归一化 URL；`seen` = 去重窗口（只存 id）。

**已读态粒度**：未读 = 无 `readAt`；已读 = 有 ISO 时间戳（2026-10-05 定）。

**去重窗口与实际保留量是两件事**：`maxSeenPerFeed`（默认 5000，只存 id）远大于
`maxItemsPerFeed`（默认 500，入 items 表）。窗口若跟着保留量一起截短，被裁掉的老条目
会在下次抓取时重新变成未读——测试 `去重窗口与保留量解耦` 钉的就是这条。

## 配置（Schemastery）

| 字段 | 默认 | 说明 |
|---|---|---|
| `feeds` | `[]` | **订阅源种子**，仅首次把订阅落进存储域（幂等）。订阅源的真相在存储域里 |
| `timeoutMs` | 15000 | 单源超时 |
| `maxBytes` | 5 MiB | 单次响应体积上限（流式累计，越界即取消） |
| `maxItemsPerFeed` | 500 | 每源保留条目数 |
| `maxSeenPerFeed` | 5000 | 每源去重窗口（只存 id） |
| `maxContentChars` | 50000 | 单条正文的存储上限（字符）。正文优先取 content 后，个别源会给几十万字符的整页 dump，而存储域是「打开时全量载入内存」的 KV，必须有闸门 |
| `maxArticleCacheChars` | 8000000 | **每个源的按需正文缓存总量上限**（字符）。超限从最旧的缓存开始清——只清 `article`，条目与已读/星标都保留；用户再打开该条会重新抓一次 |
| `cleanupAfterDays` | 30 | 显式清理的天数阈值：早于「现在 − 该天数」的条目才可被「清理旧条目」按钮删除 |
| `refreshOnStart` | true | 装载时刷新一次 |
| `logFile` | `$DSH_HOME/state/dsh-rss-reader/reader.log` | 刷新日志（宿主内证据通道） |

> 注入器（dsh-super-injector）的 `loader.create` 写死 `config: {}`，注入的插件永远拿 schema
> 默认值——所以订阅源不能只靠 Config，必须以存储域为准（M2 界面 / M4 OPML 写同一张表）。

## 能读到多少正文（2026-10-06 修）

**正文的取法**：同一份 feed 里 `content:encoded` / `content` 常常是全文，而 `description` /
`summary` 只是摘要（实测 GitHub Blog：前者 3,826–548,104 字符，后者 231–286）。因此解析层取
**「去掉标签后更长的那一份」**，而不是固定优先摘要——旧实现固定摘要优先，等于把到手的全文扔掉。

**实测效果**：修完后 GitHub Blog 的 10 条从 2,346 字符涨到 **127,522 字符**（单条最长 48,893），
而已读态一条没动。

**老条目的回填**：`refreshFeeds` 对「已见过但正文更长」的条目只更新正文，绝不碰 `readAt`/`starred`。
但只有源返回 200 时才会跑——而源通常回 304。因此源记录里加了 `contentRevision`（内容版本）：
版本落后时该源的**第一轮**抓取绕开条件请求去拿一次 200，升级完立即恢复增量（§3.5 不破）。

**仍然需要开原站的情况**：源本身只给摘要（少数派 / 阮一峰 / HN 实测都是如此）。那要靠正文抽取
（Readability 类）或按需抓原站——交接件 §6 列为「等 §3 过线再说」，尚未做。

## 键盘流（M3）与过滤

| 键 | 动作 |
|---|---|
| `j` / `k` | 下一条 / 上一条——**只移动选中，不标已读** |
| `o` | 展开 / 折叠选中条目**并标已读**（Google Reader 语义：`o`/Enter 展开，`v` 才开原站） |
| `v` | 打开选中条目的原站（新标签页） |
| `s` | 切换星标 |
| `m` | 切换已读（可反选） |
| `A` | 把**当前过滤下**的未读全部标为已读，并给 5 秒撤销窗口 |

**实现**：监听器挂在阅读器根节点（`[data-dsh-rss-reader]`）上，根节点持有焦点——所以只在
阅读器激活时响应，也不会截获别处的输入框。点侧栏图标后面板自动取焦；点进对话即失效。

> ⚠️ **不要改回 `ctx.shortcuts`**：平台规则禁止无修饰键的绑定
> （`packages/client/shortcuts/src/client/configuration.ts:100`——`modifiers` 为空或全为 `shift`
> 即返回 `modifier-required`，而 `registry.register` 对每个 profile 都跑这个校验，不通过直接
> `throw new Error('Reserved shortcut default: …')`）。j/k/o/s/m/A 全是裸键，注册即抛错——
> 2026-10-06 实测：这一条把整个 client 半炸掉，导致 DSH 重新加载时 GUI 报错。

**已读只由「打开条目」触发**——三条打开路径**语义一致**：列表点击 / `o`（内置展开）/`V`（内置详情页）/
`v`（系统浏览器打开原站）都会标已读；另有显式的 `m` 反选。`j`/`k` 只移动选中，不标已读。

> ⚠️ `v` 与 `V` 是**刻意区分**的一对：`v` = 用系统浏览器打开原站，`V` = 在阅读器内抓取并读正文。
> 二者都算「打开」。**别把 `v` 改回不标已读**——那会造成「内置打开算已读、外部打开不算」这种
> 只能读源码才发现的差异（2026-10-06 用户实测发现并纠正）。

> 这对应 **Google Reader 的 list view 语义**，不是偏离：GR 只有在 **expanded view + 默认开启的
> Scroll tracking** 下才「扫过即已读」（Settings → Preferences 可关该设置），**list view 下同样是
> 打开才标已读**。出处：GoogleReaderHelp 官方视频（2009）与 StackExchange 上的设置说明。
> ⚠️ 别当 bug 改回「移动即已读」——这是明确选定的模式。

**过滤**：全部 / 未读 / 星标。星标此前只写不读，M3 起有地方看了。

**未读徽标**：注册在 `sidebar.toggle.badge`（侧栏折叠按钮内的非交互提示），数据源与面板共用
同一个 store：客户端装载时拉一次，之后每次面板刷新都会更新（**不加定时器**）。

> ⚠️ **必须显式带 `priority: -1`**：该座位是 **single** 且已被官方 `DesktopUpdateIndicator` 以
> 默认优先级 0 占用；slots 的规则是「同一 cell **同优先级**的第二次注册直接抛错」（`ui-slots/src/index.ts:1134-1140`），
> 而「cell 内**最低**优先级的条目渲染」。默认优先级注册 = 抛错并炸掉 client 半（2026-10-06 实测）。
> 显式 -1 既避开抛错，又让本插件渲染——代价是桌面版会顶掉官方更新提示点（Web 上官方那个本来
> 就不渲染，无损失）。

## 保留与清理（2026-10-06 定）

**没有时间过期，也没有定期清理**——内容留在磁盘上，直到被容量规则挤掉，触发点是**下一次抓取**：

| 规则 | 默认 | 行为 |
|---|---|---|
| 每源条目数 | 500 | 超出后按源裁剪：**先删未读、再删已读，星标永不自动删**；全被星标占满时宁可超上限也不删 |
| 去重窗口 | 5000 id/源 | 记住见过的条目 id，避免被裁掉的旧条目重新变成未读 |
| 按需正文缓存 | 8M 字符/源 | 超限从最旧的缓存开始清（只清缓存，条目保留） |
| 显式清理 | 顶栏「清理旧条目」按钮 | 只删「**已读 + 未星标 + 早于 `cleanupAfterDays`**」的条目；带二次确认；**不设定时器** |

> ⚠️ 裁剪的排序是「发布时间，缺则抓取时间」，**星标不是永久保存**——在加这条规则之前，
> 星标条目会被无差别删掉（实测发现）。现在星标与未读不再被自动删除，但**显式清理之外的
> 自然裁剪仍会删已读条目**，这是容量与历史的取舍。

## 正文怎么读：抽取视图 / 原站视图

按 `V` 打开正文，顶栏可在两种视图间切换（`R` 键或按钮）：

| 视图 | 内容 | 何时可用 |
|---|---|---|
| **阅读视图**（默认） | 宿主抽取的**段落 + 代码块**（等宽、保留缩进、横向可滚） | 一直可用 |
| **原站视图** | 整页原样渲染（iframe）：原站样式、代码高亮、互动全在 | **仅当该站点允许被嵌入** |

> ⚠️ **「原样输出」不是我们能单方面决定的**：能不能嵌由对方服务器的
> `X-Frame-Options` / `Content-Security-Policy: frame-ancestors` 说了算，浏览器强制执行。
> 实测 6 个站点：`mihai.dinculescu.dev`、`sspai.com`、`ruanyifeng.com`、`news.ycombinator.com`
> **放行**；`github.blog`（SAMEORIGIN）与 `developer.mozilla.org`（DENY）**拒绝**。
> 站点拒绝时按钮置灰并说明原因，只能看抽取版或去原站。

**为什么默认是抽取版而不是默认原样**：抽取版零依赖、任何站点都能读、可选中可搜；原站视图受制于
上面的策略。两者都保留，用户按站点情况自己选。

**代码块**：宿主抽取时单独走 `preToText`，**保留内部换行与缩进**（不 trim），客户端据此判定为代码块
并用等宽 + `pre-wrap` 渲染——否则代码会被当普通段落折行，完全不可读。

## 刷新与加载态

刷新按钮在面板右上；按下后**不是**全屏遮罩，而是：

1. **180ms 消抖**：刷新常在毫秒级返回，立刻显示「刷新中」会闪一下——超过 180ms 才把加载态画出来；
2. 按钮图标旋转 + 文案变「刷新中…」+ 禁用（防重复点）；
3. 头部下方一条 2px **不确定进度条**；
4. 列表**压暗到 0.6 但仍可读**（stale-while-revalidate）——不遮罩，因为你此刻多半还在读旧内容。

完成后列表按 store 自动重渲染（条目流、未读数、徽标一起更新）。

## 命令

```bash
npm test                 # 22 条：解析/抓取边界/刷新编排/client bundle 契约（需先构建）
bash scripts/build.sh    # host：链接依赖 + tsc → lib/
npm run build:client     # client：tsdown → lib/client.js
npm run typecheck        # 仅覆盖 host 半（见「已知缺口」）
```

注入器环境内：`dev_build_plugin` → `dev_reload_package`（本阶段刷新由重载触发，**无定时器**）。

## 已知缺口与踩坑

- **client 半不参与类型检查**：tsconfig 排除 `src/client`，`.tsx` 只经 tsdown 转译。M2 落地真实 UI 时补。
- **`htmlEntities: true` 不能省**：fast-xml-parser 默认不解数字字符引用，`&#8217;` 会原样留在正文里（实测）。
- **storageDomain 域名/表名必须匹配 `^[a-z][a-z0-9_]*$`**（连字符非法，故用 `rss_reader`）。
- **域 disposer 必须返回 `close()` 的 promise**：写成 `void domain.close()` 会让「卸载完成」跑在域真正释放之前。
- **热重载竞态**（注入器侧，未修）：其 reload 路径 `try { await oldFiber.dispose() } catch {}` 吞掉 dispose 失败，
  且自愈路径会与 reload 并发造 fiber → 上一代的域句柄可能无人可及地残留，名字被永久占用。
  本插件对此有**有界接管**：退避重试仍 `already-open` 时，用设施公开的诊断面 `ctx.storageDomain.get(name)`
  取回并关闭该孤儿句柄（会写日志）。这是安全网，不是正常路径。
