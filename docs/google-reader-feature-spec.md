# Google Reader 功能说明书（史料还原版）

> **本文用途**：给出复刻 Google Reader（2005-10-07 上线 ~ 2013-07-01 关停）所需的**功能需求基准**——它有哪些功能、每个功能的行为语义、边界与陷阱。
> **本文不是**：本项目的实现说明或设计文档。全文只有 **§6** 一处越出「史料」边界，它是标注为 `[D]` 的复刻落点推断，其余各节不含任何项目相关判断。

---

## 0. 证据分级与取证缺口

| 等级 | 含义 | 本文使用的来源 |
|---|---|---|
| **A 官方一手** | Google 自己发布的产品文档与公告 | Reader Help Center（support.google.com/reader，经 web.archive.org 快照）、Official Google Reader Blog（googlereader.blogspot.com）、google.com/reader/about 常见问题 |
| **B 工程师一手** | Reader 团队成员撰写、描述服务端真实行为 | mihaip/google-reader-api（原 code.google.com/p/google-reader-api，作者 Mihai Parparita 为 Reader 工程师） |
| **C 二手** | 第三方整理，用于补时间线与边缘事实 | Wikipedia "Google Reader" 条目 |
| **D 推断** | 本文基于以上材料的推论 | **不可当史料引用** |

**取证缺口（如实声明，避免读者把本文当成完备史料）**

1. Wayback Machine 对部分帮助文章只返回归档站外壳页，以下 **6 篇正文未能取到**，本文只保留其标题级证据：*Sorting my reading list*（69980）、*About feeds and subscribing*（69967）、*Import subscription lists*（69982）、*Full story not showing in expanded view*（69969）、*Viewing a feed's original site*（69971）、*About RSS and Atom*（69986）。
2. 存在一处**官方材料自相矛盾**，见 §3.10 末尾注。
3. 2005 年首发博文正文与 2013 年关停公告正文均未取到；相关时间点以 Wikipedia 与官方博客索引日期为据（标注为【C】，或按标题级【A】）。**一处可交叉验证**：官方博客首帖标题为 *Google Reader: Two weeks*、日期 2005-10-21（【A】索引），与 Wikipedia 的上线日 2005-10-07 恰好相差两周，两个独立来源互证。
4. 官方帮助中心页脚标注的最后更新日期为 **2012-10-16**，即产品关停前约 5 个月——其内容**可能滞后于产品实际状态**。第 2 条那处矛盾正由此而来（见 §3.10）。
5. 部分正文经 **mcp-exa 取文通道**获得（而非 web_fetch 直取），例如 Takeout 数据清单（answer/3028851）；两通道同源同页，仅取证路径不同。
6. 附录 A 的目录树是按 2013-03 快照**人工重排**的层级还原，不是原站 DOM 的逐字复制；它用于定位文章编号，不作为结构证据。

---

## 1. 生命周期

| 时间 | 事件 | 证据 |
|---|---|---|
| 2001 | 工程师 Chris Wetherell 做新闻门户 JavaCollect（Reader 前身） | 【C】 |
| 2005-10-07 | Google Reader 经 Google Labs 上线 | 【C】 |
| 2006-05-04 | Reader 的 feed 可显示在 iGoogle（当时的 Google Personalized Homepage） | 【C】+【A】（博客 2006-05-04） |
| 2006-05-18 | 发布移动版界面（支持 XHTML / WAP 2.0 的设备） | 【C】 |
| 2006-09-28 | **大改版**：新增未读计数、"mark all as read"、文件夹导航、expanded view、一键分享 | 【A】博客 *Something looks... different.* |
| 2007-01-03 | 发布 **Trends 统计页** | 【A】博客 *I like big charts and I cannot lie* |
| 2007-01 | 支持内嵌 YouTube / Google Video 视频 | 【C】+【A】（博客 2007-01-30） |
| 2007-09 | 走出 Google Labs | 【C】 |
| 2007-12 | 分享策略变更：标记为 shared 的条目对 Google Talk 联系人自动可见（用户批评无法关闭） | 【C】 |
| 2008-05-12 | 面向 iPhone 的新版移动界面 | 【C】+【A】 |
| 2008-末 | 又一次大改版（负责人 Jenna Bilotta）：更干净的视觉、可折叠导航、"Friends" 导航、可隐藏未读计数、feed bundles | 【C】 |
| 2010-03 | 发布 Google Reader Play（幻灯片式浏览，**无需 Google 账号**） | 【C】 |
| 2010-06-01 | **下线 Gears 离线访问**；停止支持旧浏览器 | 【A】博客 *Spring Cleaning* / *Folder and tag renaming* |
| 2010-09-22 | 关闭 "track changes"（无 feed 的网页变更跟踪）功能 | 【A】（博客标题级） |
| 2010-12 | 发布 Android 版 Google Reader 应用 | 【C】 |
| 2011-10-31 | 新版设计上线；**下线 friending / following / shared link blogs**，分享迁至 Google+ | 【A】博客 *New in Reader: a fresh design, and Google+ sharing* |
| 2013-03-13 | 宣布关停（官方博客 *Powering Down Google Reader*） | 【A】 |
| 2013-03 | 移除 +1 按钮与点赞计数 | 【C】 |
| 2013-07-01 | 服务关停；建议用 Google Takeout 导出数据 | 【A】 |
| 2013-07-15 后 | 订阅数据被永久删除，且不可恢复 | 【A】google.com/reader/about |

---

## 2. 底层概念与数据模型

> 本节内容来自【B】。UI 上所有"奇怪的行为"几乎都能在这里找到解释，是复刻时最该先读的一节。

### 2.1 Stream（流）

Reader 把"一切可读的东西"统一建模为 **stream**，用字符串 ID 寻址：

| 形态 | 例子 | 含义 |
|---|---|---|
| Feed stream | `feed/http://googleblog.blogspot.com/atom.xml` | 一个抓取来的订阅源 |
| 系统标签 stream | `user/-/state/com.google/read` | 带某状态的条目集合 |
| 用户标签 stream | `user/-/label/Foo Bar` | 用户打的标签 |
| 订阅集合 stream | `user/-/state/com.google/reading-list` | 对应 UI 的 **All items** |

要点：

- `user/-/...` 中的 `-` 是"已认证用户自己"的简写。
- **文件夹与用户标签是同一套命名空间**（都是 `user/-/label/<name>`）——所以"文件夹"本质就是标签，不是独立实体。
- 标签名允许任意字符，**但排除这些**：`"` `^` `<` `>` `?` `&` `\` `/` `,`。
- stream ID 出现在 URL 路径里时也必须转义（`/` → `%2F`）。

常见系统标签（item 级）：`read`（已读）、`kept-unread`（保持未读，标为已读时移除）、`starred`（星标）、`broadcast`（分享）、`like`（喜欢）。
常见系统标签（订阅级）：`reading-list`（= All items）、`broadcast-friends`（= People you follow）。

### 2.2 Item 与 item ID 派生规则

条目的全局唯一 ID 派生顺序（**这是复刻去重与已读态绑定的关键**）：

1. 优先取 Atom 的 `<id>` 或 RSS 的 `<guid>`；
2. 没有则用条目的 URL；
3. 若两者都缺失，**或"不可信"**（例如同一份 feed 响应里出现两个相同 ID / 相同 URL），则用条目属性（title、body 等）的**签名**计算。

ID 内部是 64 位数字，对外有两种表示：

- **长格式**：`tag:google.com,2005:reader/item/` + **无符号 16 进制、左侧补 0 至定宽 16 字符**。
- **短格式**：同一数字的**有符号十进制**（可能为负）。

官方文档明确建议：**不要在两种格式间做转换**，把响应里的 ID 当字符串原样存取、原样回传。

### 2.3 决定 UI 行为的 API 参数

| 参数 | 语义 | 取值 / 上限 |
|---|---|---|
| `n` | 返回条数 | 取 ID 时上限 10000；取内容时上限 1000、默认 20 |
| `r` | 排序方式 | `n`=最新优先（倒序）、`o`=最旧优先、`a`=**magic**（个性化排序）、`c`=评论最新优先 |
| `xt` | 排除标签 | 最常用于"隐藏已读" |
| `nt` / `ot` | 时间窗（秒级时间戳） | — |
| `c` | 分页续传令牌 | 响应里的 continuation 原样回填 |
| `output` | 输出格式 | `json` / `xml`（内容接口另有 `atom`、`atom-hifi`） |
| `likes` / `comments` / `sharers` | 是否附带社交数据 | 默认 true |
| `trans` | 是否把响应翻译成用户显示语言 | 默认 false |
| `mediaRss` | 是否保留原 feed 的 MediaRSS 元素 | 默认 false |
| `client` / `hl` | 调用方标识 / 语言 | — |
| `T` | **ActionToken**（所有改状态请求必带） | 见下 |

**ActionToken**：`GET /reader/api/0/token` 取得，**有效期 30 分钟**；缺失或失效返回 401，并带响应头 `X-Reader-Google-Bad-Token: true`。

**改状态接口语义**：

- `edit-tag`：`a`=添加标签、`r`=移除标签、`i`=条目 ID、`s`=来源 stream。**均为可重复的并行数组**（一次批量操作多条）。
- `subscription/edit`：`ac` = `subscribe` | `unsubscribe` | `edit`；`a`/`r` = 加入/移出文件夹（**可重复 → 一个订阅可同时属于多个文件夹**）；`title` = 重命名订阅。

**认证**：OAuth（scope `https://www.google.com/reader/api/`）为首选；桌面端可走 ClientLogin（`service=reader`），令牌以 `Authorization: GoogleLogin auth=<value>` 头传递。

---

## 3. 功能域详述

### 3.1 订阅（Subscribing）

- **三种订阅途径**：① 在 "Add a subscription" 框里**按关键词搜索**（官方推荐的首选路径）；② 粘贴**站点首页 URL**——若站点开启了 **feed auto-discovery**，Reader 会自动找到其 feed；③ 粘贴 **feed URL** 本身。
- **找不到 feed 时的官方指引**：在页面上搜这些词——subscribe / syndicate / feed / rss / xml / atom；或直接找那个橙色 RSS 图标。
- **格式支持**：RSS 与 Atom 都吃；官方明确"两者皆可，任选其一"。
- **OPML 导入/导出**：Settings → Import/Export，可导出订阅列表、也可导入；这条路径同时用于**跨账号迁移订阅**（官方文档明确：该操作**只搬订阅**，**不搬** trends、followers、关注的人、文件夹、分享链接）。
- **私有 feed**：官方帮助目录有专门条目 *About subscribing to private feeds*。【A-标题级】
- **更新频率（重要语义）**：Reader **约每小时**检查一次订阅更新；订阅者少的 feed 更新频率可能更低。
  **点击 Refresh 按钮不会真的去抓取**——它只是把 Reader 已经收集到的新条目更新到屏幕上。
- **退订 / 推荐 feed / 从其他服务导出**：帮助目录有条目 *Unsubscribing from a feed*、*Recommending Feeds*、*Exporting subscriptions from other services*。【A-标题级】

### 3.2 导航与视图

- **左侧栏（sidebar）** 承载：订阅列表、文件夹、标签链接（打标签即生成侧栏入口）、未读计数、Explore 区。
- **未读计数**显示在 feed 标题后的括号里；用户**可隐藏未读计数**（2008 改版）【C】。
- **两种条目视图**：
  - **Expanded view（展开视图）**——含条目描述/正文摘录，可快速扫过数条；快捷键 `1`。
  - **List view（列表视图）**——只有标题行；快捷键 `2`。
- **顶部筛选**：可切换"查看全部条目"还是"只看新条目"。
- **Fullscreen 模式**：快捷键 `f`。
- **导航面板显隐**：2010-08 官方博客写的是 `shift + u`；2012-10 的帮助页写的是 `u`。**两份官方材料不一致**，且无法判定是快捷键发生过变更、还是其中一份写错。§3.8 的全表沿用较晚的帮助页（`u`），但此处应视为**未决**。
- **字体缩放**：`-` 缩小、`=` 放大（针对当前条目）。
- **刷新**：`r` 刷新导航里的未读计数。
- **favicon**：订阅列表可显示各源 favicon（默认关闭，设置项，2009-11 加入）【A】。
- **可折叠导航**、**feed bundles**（成组的推荐订阅包）为 2008 改版内容【C】。

### 3.3 阅读流与已读态

- **Scroll tracking（滚动即已读）**：在 feed 中**滚动经过的条目会自动标记为已读**，随后自动加载更多条目。该行为**可在 Settings 里取消勾选 "Scroll Tracking"** 关闭。Wikipedia 表述为"仅 expanded view 生效"【C】，帮助指南只描述行为未限定视图【A】。
- **已读态是双向标签**：快捷键 `m` 在"已读 / 未读"间切换；系统标签既有 `read` 也有 `kept-unread`（**保持未读**——被打上后，直到条目被真正标记为已读才移除）。
- **"Mark all as read" 带时间阈值菜单**（2009-08 加入）：可选择"只把**早于**某个时间范围的条目标为已读"，官方称之为"panic button"（致敬 Nick Bradbury）。
- **已读态跨客户端同步**：官方在停止 Gears 离线支持时明确，第三方客户端（NetNewsWire / FeedDemon / Liferea）**会同步订阅与已读态**，可继续提供离线阅读【A】。

### 3.4 条目动作（Actions）

| 动作 | 快捷键 | 说明 |
|---|---|---|
| Star（星标） | `s` | 切换星标状态 |
| Like（喜欢） | `l` | 切换喜欢状态；用于个性化排序信号 |
| Share（分享） | `shift-s` | 切换分享 |
| Share with note | `shift-d` | 分享并附注 |
| Tag（打标签） | `t` | 打开标签输入框；也可点条目末尾的 "Add tags" / "Edit tags" 链接 |
| Mark read/unread | `m` | 切换已读状态 |
| Mark all as read | `shift-a` | 标记当前视图全部为已读 |
| Email item | `e` | 打开邮件表单 |
| View original | `v` | 新窗口打开原文 |
| Send to… | `shift-t` | 发送到外部服务（见 §3.11） |
| 保持未读 | — | 条目下方链接之一（"keep as unread"） |

### 3.5 组织

- **文件夹 = 标签**（同命名空间，见 §2.1）；一个订阅**可以属于多个文件夹**（API 的 `a` 参数可重复）。
- **重命名文件夹与标签**（2010-06 上线，官方称其为投票最高需求之一）：可在设置页改，也可在订阅列表的右键菜单里改。
- **打标签会生成新的侧栏入口**，点进去即查看该标签下所有条目。
- 官方原始标签用法举例：`favs`（收藏）、`follow-up`（待跟进）。

### 3.6 排序与检索

- **搜索**：`/` 把光标移到搜索框；**搜索范围是"所有 feed、所有订阅的更新"**，不只是当前源【C】。（该页正文未取到，见 §0 缺口 1）
- **排序方式**（`r` 参数）：
  - 最新优先（倒序）/ 最旧优先（正序）；
  - **"Sort by magic"**——在任意 feed 或文件夹的 Settings 菜单里选择，Reader 会"尽力按最相关、最有趣"排序。其信号来源：**你的历史阅读行为（含 like 与 star）+ 全局信号**；官方强调该个性化排序**全自动且匿名**。
- **搜索订阅源**：侧栏 "Add a subscription" 框同时也是 feed 搜索框。

### 3.7 发现（Discover）

- **Explore 区**（侧栏）：含 **Recommended items** 与 **Recommended sources**，由算法从未知来源挑选"新鲜与上升中"的图片、视频与页面，生成 Popular items 后再按"你可能会喜欢"排序。
- **Popular items / Personalized ranking**（2009-10 上线）：popular 与 personalized 两套并行。
- **Recommended items 个性化**（2010-02）：在 Recommended items 区块内混入"专门为你挑选"的条目（长尾兴趣友好）。
- **Related feeds（More like this…）**：悬停任意订阅 → 菜单 → "More like this…"，也可在任意 feed 的预览页看到相关 feed。
- **Browse for stuff**：官方预编译的按主题分组的 **feed bundles**；2012 版另有 **From people you follow** 标签页。
- **Reader Play**（2010-03）：幻灯片式逐条浏览，条目来自各站点 feed，排序基于 Reader 用户的 like/share 数据；**无需 Google 账号即可访问**【C】。
- **Feed discovery 跳转**：`g` 然后 `d` 打开推荐页（无推荐时退回 browse 页）。

### 3.8 键盘流（官方全表，2012-10-16 版）

> 原表来自【A】帮助页 *Keyboard shortcuts*（answer/69973），逐条直译。

**Navigation**

| 键 | 名称 | 行为 |
|---|---|---|
| `j` / `k` | item down/up | 选中列表中的下/上一条 |
| `space` / `shift-space` | page down/up | 翻页 |
| `n` / `p` | scan down/up | **list view 下**选中下一条但**不展开**它 |
| `shift-n` / `shift-p` | navigation down/up | 在导航里选中下/上一个订阅或文件夹 |
| `shift-x` | navigation expand/collapse | 展开/折叠导航中选中的文件夹 |
| `o` / `enter` | open/close item | 在 list view 下展开/折叠选中条目 |
| `shift-o` | navigation open subscription | 打开导航中选中的订阅或文件夹 |
| `-` / `=` | zoom out / in | 缩小/放大当前条目字号 |

**Acting on Items**

| 键 | 名称 | 行为 |
|---|---|---|
| `s` | toggle star | 星标 / 取消星标 |
| `l` | toggle like | 喜欢 / 取消喜欢 |
| `shift-s` | toggle share | 分享 / 取消分享 |
| `shift-d` | share with note | 带附注分享 |
| `v` | view original | 新窗口打开原文 |
| `t` | tag an item | 打开标签输入框 |
| `m` | mark as read/unread | 切换已读状态 |
| `shift-a` | mark all as read | 当前视图全部标为已读 |
| `e` | email item | 打开邮件表单 |

**Jumping**（均为两段式：先 `g` 再按第二键）

| 组合 | 目标 |
|---|---|
| `g` `h` | 首页 |
| `g` `a` | All items |
| `g` `s` | Starred items |
| `g` `shift-s` | 你的分享条目 |
| `g` `u` | 按名字跳转到某个订阅 |
| `g` `t` | 按名字跳转到某个标签 |
| `g` `f` | 按名字跳转到某个好友的分享 |
| `g` `shift-f` | 所有好友的分享 |
| `g` `shift-t` | Trends |
| `g` `d` | Feed discovery |

**Application**

| 键 | 行为 |
|---|---|
| `r` | 刷新未读计数 |
| `f` | 全屏模式开关 |
| `u` | 订阅列表显隐 |
| `1` | 切到 expanded view |
| `2` | 切到 list view |
| `/` | 光标移到搜索框 |
| `a` | 打开 "Add a subscription" |
| `?` | 快捷键帮助 |

### 3.9 统计（Trends）

Trends 页（2007-01 上线，入口在 Home 页链接）包含：

- 阅读量随时间变化的图表（可看出某天的阅读高峰）。
- **订阅按多种维度排序**，用于识别"跟不上"的源；每行订阅旁边直接带**退订图标**。
- **Friends trends**（2009-05）：看谁分享最多、谁的分享你实际会读。
- **Clicked trends**（2010-08）：你最常点击的来源。
- **Lifetime read item count**（2010-08）：终身已读条目数；**只计"滚动经过或点击过"的条目，不计 mark all as read**；约 30 万条后为性能停止计数。
- 官方口径的规模感：平均 Reader 用户每天读约 105 条【A，2010-04】。

### 3.10 分享与社交（完整生命周期）

| 时期 | 形态 |
|---|---|
| 2006-03 ~ 2007 | 分享 = 生成一个包含你所有分享条目的**公开网页**，或通过邮件发链接 |
| 2007-12 | 改为：标记 shared 的条目**自动对 Google Talk 联系人可见**（用户批评无法 opt out） |
| 2008~2010 | 社交扩张期：选好友/分组、评论、like、following、好友趋势、按人搜索 |
| 2009-08 | 分享条目支持 **PubSubHubbub**，加速分发 |
| 2010-05 | 简化评论权限：**能看见就能评论**；公开分享者需在"继续公开并允许任何人评论"与"切换为受保护分享"间二选一 |
| 2011-01 | 评论控制增强 |
| 2011-10 | **下线 friending、following、Reader 内的分享链接博客**；分享迁往 Google+（+1 按钮） |
| 2013-03 | 随关停公告移除 +1 按钮与点赞计数 |

**注（官方材料矛盾处）**：2012-10-16 版帮助页仍列出 `l`（like）、`shift-s`（share）、`g` `f`（好友分享）等社交快捷键，而官方博客 2011-10-20 已宣布下线相关社交功能。无法判定该帮助页是滞后未更新、还是快捷键在 2012 年仍在。

**复刻取舍**：社交功能已在 §4 判定为「不做」，因此 §3.4 与 §3.8 中 like / share / 好友相关的快捷键条目**不应进入验收清单**——它们在 2013 年关停时刻是否仍然可用，史料无法确认。

### 3.11 邮件与外部出口

- **Email item**（`e`）：条目底部 Email 按钮 → 填收件人、可自定义主题与正文 → 对方收到邮件，含你的留言与文章链接。
- **收件人自动补全**：账号内有 Gmail 则从通讯录取词；没有 Gmail 也会记住你用过的地址并在下次自动补全。
- **发件人身份**：取 Google 账号的 **nickname** 作为发件人姓名（改的时候要改 nickname，只改 first/last name 无效）；**回信地址恒为账号主邮箱**，不支持次要邮箱或自定义 reply-to。
- **默认不保存副本**：从 Reader 发出的邮件默认不进 Gmail 的 Sent Mail；需要时勾选 "send me a copy of this email"。
- **Send to…**（2009-08）：一键发送到 Blogger / Twitter / Facebook 等；在设置页启用所需服务；**支持用 URL 模板自定义 "Send to" 目标**（面向高级用户）。
- **Atom 输出**：Reader 里你看到的一切都有对应的 Atom feed（2006-03 就有此设计），可用于把阅读列表嵌入别处。
- **Embed clips**：分享条目可作为嵌入片段放到其他页面，可选是否显示附注。

### 3.12 离线与移动

- **Gears 离线**（【C】）：Reader 是**第一个使用 Google Gears 的应用**；装插件后可离线下载**最多 2000 条**条目，恢复联网后同步。**2010-06-01 停止支持**（官方理由：使用者少、维护成本大、Gears 已被 HTML5 取代），官方转而在文档里推荐第三方桌面客户端承接离线需求。
- **移动端演进**（【C】+【A】）：
  - 2006-05-18：移动界面（XHTML / WAP 2.0）。
  - 2008-05-12：面向 iPhone 的新版移动界面。
  - 2009-07：移动端可定制；2009-05 起移动端可**发 notes**。
  - 2010-01：移动端再次更新。
  - 2010-12：Android 应用；2011-02 更新。
  - 移动版启动页可选显示订阅列表（"Feeds" start page）。

### 3.13 平台集成

- **iGoogle**（2006-05）：Reader 的 feed 可显示在个性化主页；2009-05 起可在 Reader 新用户页**从 iGoogle 导入订阅**。
- **Google Desktop gadget**（2009-05）：桌面小工具，20% 时间项目。
- **Chrome 扩展**（2009-12）：Google Reader Notifier，显示未读数。
- **Nintendo Wii**（2007-05）：官方博客演示在 Wii 上读 Reader（【C】亦提及 Wii 体验）。
- **Reader Play**（2010-03）：见 §3.7。
- **Google Buzz**（2010-02）：与 Buzz 集成（已死）。

### 3.14 发布者侧（Tips for Publishers）

官方帮助中心为**内容发布方**单列一章，说明 Reader 不只是读者工具，还有 feed 供给侧契约：

- *Feed 'best practices'*（69997）、*Technical Implementation of Feeds*（69998）、*Using feed 'auto-discovery'*（69999）、*Using 'Add to Google' buttons*（70000）、*Subscribers to my feed*（70001）、*Formatting for Google Reader*（78316）。【A-标题级】
- **订阅者统计**：feed 的订阅人数会公开出现在搜索结果等处（官方 2007-10 专门澄清过这个数字的含义）。

### 3.15 无障碍与多语言

- **ARIA**（2008-03）：Google 无障碍专家 T.V. Raman 参与，Reader 是早期采用 ARIA 的应用之一；2008-05 另有阅读辅助特性（"lens"）。
- **自动翻译**（2008-11）：可把外文 feed 自动翻译成你的语言——API 侧对应 `trans` 参数，两侧互证。
- **界面语言**：归档帮助中心页脚提供 **11 种语言**（de / en / es / fr / it / ja / ko / nl / pt-BR / zh-Hans / zh-Hant）。【A，页脚实测】

### 3.16 数据导出与谢幕

- **Takeout 导出内容清单**（2013-03，【A】answer/3028851）——这份清单本身就是**官方对"用户数据模型"的完整枚举**：
  - 订阅数据（官方原文为 **XML**；OPML 形态由【B】的 `reader/subscription/export` 接口佐证）
  - 以下为 **JSON**：
    - 你关注的人 / 关注你的人
    - 你 star 的条目
    - 你 like 的条目
    - 你 share 的条目 / 你关注的人 share 的条目
    - 你创建的 notes
    - 有评论的条目
- 2011-10 官方已把导出范围**扩展**到：订阅、分享条目、好友、likes、starred。
- **数据最终被永久删除**，2013-07-15 之后不可恢复。

---

## 4. 已移除 / 已死功能清单

> 复刻时**不应**默认纳入；列在这里是为了"知道边界在哪"。

| 功能 | 状态 | 理由 |
|---|---|---|
| Gears 离线访问 / 2000 条离线缓存 | 2010-06 移除 | 用得少、维护成本高、被 HTML5 取代 |
| track changes（无 feed 网站的变更跟踪） | 2010-09 关闭 | 【A-标题级】 |
| friending / following / 好友分享流 / 分享链接博客 | 2011-10 移除 | 迁往 Google+ |
| Like（喜欢）与 +1 按钮、点赞计数 | 2013-03 移除 | 随关停 |
| Google Buzz 集成 | 随 Buzz 死亡 | — |
| Wii / iGoogle / Desktop gadget 等集成 | 随宿主平台死亡 | — |

---

## 5. 对实现有约束的不变量（复刻时最容易踩错的地方）

| # | 不变量 | 依据 |
|---|---|---|
| 1 | **"Refresh" ≠ 重新抓取外部站点**；抓取是服务端按自己的节奏（约每小时）做，Refresh 只更新本地视图 | 【A】answer/70642 |
| 2 | **已读态绑定的是条目身份**，而条目身份是"派生"的：id → URL → 属性签名（同一响应内 id/URL 重复即视为不可信） | 【B】ItemId |
| 3 | **"保持未读"是独立状态**，不是"未读"的同义词（`kept-unread` vs 无 `read`） | 【B】StreamId |
| 4 | **文件夹 == 标签**（同一命名空间），且**一个订阅可属于多个文件夹** | 【B】StreamId / ApiSubscriptionEdit |
| 5 | 标签名有**保留字符集合**，写入前必须校验或转义 | 【B】StreamId |
| 6 | 排序至少有四种：最新 / 最旧 / **magic（个性化）** / 评论最新；magic 的信号是"历史阅读 + like + star + 全局信号" | 【A】164681 +【B】ApiStreamContents |
| 7 | **Mark all as read 支持时间阈值**（"只标早于 X 的"），不是只有全量一种 | 【A】2009-08-12 |
| 8 | **未读计数可隐藏**；计数刷新有独立快捷键 `r` | 【A】69973 +【C】 |
| 9 | 改状态请求需要**限时的 ActionToken（30 分钟）**，失效表现为 401 + 专用响应头 | 【B】ActionToken |
| 10 | 分页用**续传令牌**，不是页码；编号参数 `n` 在"取 ID"与"取内容"两条路径上**上限不同**（10000 vs 1000） | 【B】ApiStreamItemsIds / ApiStreamContents |
| 11 | 条目的**长/短 ID 格式不得互转**，原样存取 | 【B】ItemId |
| 12 | **外发行为有明确的隐私默认值**：Reader 邮件默认**不**存档到 Gmail 的 Sent Mail，需显式勾选才留副本 | 【A】70652 |

---

## 6. 与本项目的落点 [D 推断，非史料]

> 本节是基于前面史料对 @dsh-external/dsh-rss-reader 当前状态（M0-M2：订阅/条目/游标 + 未读态）的**建议**，不是 Google Reader 的事实。

| Google Reader 能力 | 建议归属 | 说明 |
|---|---|---|
| 订阅 + OPML 导入导出 + auto-discovery | 近期 | 已有订阅数据面，OPML 是低成本高价值项 |
| 未读态 / 保持未读（区分） | 近期 | 当前只有 readAt（已读时间戳），**`kept-unread` 语义缺失**，见不变量 3 |
| 已读态绑定稳定 item id | 已具备 | 与不变量 2 对齐；注意"重复 id/URL 不可信"的兜底分支 |
| expanded / list 两视图 + 键盘流 | 阅读面核心 | 快捷键表可直接作为验收清单 |
| 排序：最新 / 最旧 / magic | 中期 | magic 需行为信号，可先做前两种 |
| 标签（= 文件夹）+ 多归属 | 中期 | 与不变量 4/5 对齐 |
| Trends 统计 | 后期 | 依赖已读历史，天然适合放在已读态稳定之后 |
| 发现（Explore / bundles / 推荐） | 可裁剪 | 需要全局信号，单机插件无对应数据源 |
| 分享 / 社交 / +1 / Buzz | 不做 | 全是已死功能，见 §4 |
| Gears 离线 / 移动 App / Wii 等 | 不做 | 平台性历史产物 |

---

## 附录 A：官方帮助中心目录还原（2013-03 快照）

**顶层导航**（来自 help home 与 *Getting Started Guide*）：

```
How to
  Reading        Reading Your Feeds / Subscribing / Working Offline / Organizing / Google Reader for Mobile
  Sharing        Email / Sharing to Google+
Tips and Fixes   Tips for Publishers / Technical Implementation of Feeds / Using feed 'auto-discovery' /
                 Using 'Add to Google' buttons / Subscribers to my feed / Formatting for Google Reader /
                 Feed not updating in Reader
Troubleshooting  Embedded media doesn't appear in Google Reader / The sidebar in Google Reader is missing
                 or hidden / Missing subscriptions / Feed not updating in Reader / Google Reader is
                 displaying incorrectly / One of my feeds isn't updating / Google Reader system
                 requirements / Feed displaying incorrectly / Report a legal issue
Additional       Getting Started Guide / Google Reader Product Forum / Video tutorials / Known issues
```

**Subscribing**（topic 12011）：
3028851 How can I download my Reader data? · 69967 About feeds and subscribing · 69968 How to subscribe to feeds · 69982 Import subscription lists · 69986 About RSS and Atom · 70002 Finding feeds · 70642 How often Google Reader checks for updates · 181118 Transferring feeds between accounts
（同章另有标题级条目：Exporting subscriptions from other services · Unsubscribing from a feed · About subscribing to private feeds · Recommending Feeds · Google Reader extensions for Google Chrome）

**Reading Your Feeds**（topic 12012）：
69969 Full story not showing in expanded view · 69971 Viewing a feed's original site · 69973 **Keyboard shortcuts** · 69980 Sorting my reading list · 164681 Explore section and "magic" ranking
（同章另有标题级条目，**编号未在本次取证中确认**：Searching within feeds · About the dates displayed with feeds）

**Organizing**：69977 Using tags · Using Folders

**Email**（topic 12018）：
69992 Emailing an article to a friend · 70652 Saving emailed items · 78407 Editing the name and return address used on emailed items · 83000 Sharing to Google+

**Tips for Publishers**：69997 Feed 'best practices' · 69998 Technical Implementation of Feeds · 69999 Using feed 'auto-discovery' · 70000 Using 'Add to Google' buttons · 70001 Subscribers to my feed · 78316 Formatting for Google Reader

---

## 附录 B：官方博客里程碑（含 URL）

官方博客共 **108 篇**（2005-10-21 ~ 2013-07-02）。下表列出本文引用的关键篇目，**并标出每篇的实际取证深度**：

- **正文** = 已取到并逐段核对过博文正文（12 篇）
- **标题级** = 仅从官方 feed 索引确认了标题/日期/摘要，**正文未取到**（9 篇，其论断不得超出标题所示范围）

| 日期 | 标题 | 取证深度 | URL |
|---|---|---|---|
| 2005-10-21 | Google Reader: Two weeks（首帖） | googlereader.blogspot.com/2005/10/google-reader-two-weeks.html | 标题级 |
| 2006-03-21 | Reader learns to share | …/2006/03/reader-learns-to-share.html | 标题级 |
| 2006-04-07 | Labels: Better, stronger, faster | …/2006/04/labels-better-stronger-faster.html | 标题级 |
| 2006-07-19 | Your wish is our command（视图/排序） | …/2006/07/your-wish-is-our-command.html | 标题级 |
| 2006-09-28 | **Something looks... different.**（大改版） | …/2006/09/something-looks-different.html | 正文 |
| 2007-01-03 | **I like big charts and I cannot lie**（Trends） | …/2007/01/i-like-big-charts-and-i-cannot-lie.html | 正文 |
| 2007-09-05 | "We found it!"（搜索） | …/2007/09/we-found-it.html | 标题级 |
| 2007-11-29 | Attack of the interns（推荐 + 拖拽） | …/2007/11/attack-of-interns-recommendations-and.html | 标题级 |
| 2008-10-28 | We like it graphed（Trends 可视化） | …/2008/10/we-like-it-graphed.html | 标题级 |
| 2009-05-19 | Latest round of Reader improvements | …/2009/05/latest-round-of-reader-improvements.html | 正文 |
| 2009-08-12 | **A flurry of features for feed readers**（Send to / mark-all 阈值） | …/2009/08/flurry-of-features-for-feed-readers.html | 正文 |
| 2009-11-24 | Let your subscriptions' personality come through（favicon） | …/2009/11/let-your-subscriptions-personality-come.html | 正文 |
| 2010-02-18 | May we recommend...（推荐个性化 / 相关 feed） | …/2010/02/may-we-recommend.html | 正文 |
| 2010-04-09 | A veritable boatload of read items（阅读量统计） | …/2010/04/veritable-boatload-of-read-items.html | 正文 |
| 2010-05-24 | Spring Cleaning（评论权限 / 停止 Gears） | …/2010/05/spring-cleaning-comments-offline-and.html | 正文 |
| 2010-06-01 | Folder and tag renaming | …/2010/06/folder-and-tag-renaming.html | 正文 |
| 2010-08-26 | Fullscreen and more!（全屏 / clicked trends / 终身计数） | …/2010/08/fullscreen-and-more.html | 正文 |
| 2011-10-20 | Upcoming changes to Reader（社交下线预告） | …/2011/10/upcoming-changes-to-reader-new-look-new.html | 正文 |
| 2011-10-31 | New in Reader: a fresh design, and Google+ sharing | …/2011/10/new-in-reader-fresh-design-and-google.html | 标题级 |
| 2013-03-13 | **Powering Down Google Reader**（关停公告） | …/2013/03/powering-down-google-reader.html | 正文 |
| 2013-07-02 | A final farewell | …/2013/07/a-final-farewell.html | 标题级 |

---

## 附录 C：来源 URL 全表

| 来源 | URL | 等级 |
|---|---|---|
| 快捷键全表 | https://web.archive.org/web/20130215045601/http://support.google.com/reader/answer/69973?hl=en | A |
| Getting Started Guide | https://web.archive.org/web/20130215045601/http://support.google.com/reader/answer/113517?hl=en | A |
| Explore 与 magic 排序 | https://web.archive.org/web/20130215045601/http://support.google.com/reader/answer/164681?hl=en | A |
| Finding feeds | https://web.archive.org/web/20130215045601/http://support.google.com/reader/answer/70002?hl=en | A |
| 更新频率 / Refresh 语义 | https://web.archive.org/web/20130215045601/http://support.google.com/reader/answer/70642?hl=en | A |
| 邮件相关（69992 / 70652 / 78407） | …/reader/answer/69992 · 70652 · 78407 · ?hl=en | A |
| 账号间迁移订阅 | https://web.archive.org/web/20130215045601/http://support.google.com/reader/answer/181118?hl=en | A |
| Using tags | https://web.archive.org/web/20130215045601/http://support.google.com/reader/answer/69977?hl=en | A |
| Takeout 数据清单 | https://web.archive.org/web/20130315020336/http://support.google.com/reader/answer/3028851 | A |
| 关停 FAQ | https://web.archive.org/web/20210204222750/http://www.google.com/reader/about/ | A |
| 帮助中心目录 | https://web.archive.org/web/20130312135621/http://support.google.com/reader/?hl=en | A |
| 官方 Reader 博客（108 篇） | http://googlereader.blogspot.com/ · feeds/posts/summary?alt=json | A |
| 非官方 API 文档（10 篇 wiki） | https://github.com/mihaip/google-reader-api/tree/master/wiki | B |
| Wikipedia | https://en.wikipedia.org/wiki/Google_Reader | C |

> 归档链接使用 Wayback Machine 快照；原站（support.google.com/reader、google.com/reader）已于 2013 年后下线。
