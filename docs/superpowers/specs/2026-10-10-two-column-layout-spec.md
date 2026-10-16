# 阅读区两列布局功能说明书

> **本文用途**：钉住「主栏阅读区改两列布局（左=订阅导航，右=文章列表）」的需求与行为语义。
> 每条决策都经用户拍板（2026-10-09 本会话），实现与测试以本文为准。
> 史料依据在 `docs/google-reader-feature-spec.md`（下称 GR spec），本文只引用不重述。

## 0. 现状与差距（源码核对）

- 当前是**单列**：顶栏 + 文章列表滚动容器（src/client/index.tsx:364-539）。
- 视图三态 `'list' | 'article' | 'feeds'`（src/client/store.ts:48）；filter 只有
  `'all' | 'unread' | 'starred'`（store.ts:11）——**没有按单个订阅浏览的视图**。
- 订阅只出现在管理页 FeedsView（无导航语义、无未读数，src/client/feeds-view.tsx:104-121）。
- `FeedView` 无 per-feed 未读字段（src/shared.ts:28-35）；overview 的 items 经
  `items.slice(0, config.maxItemsShown)` 截断后下发（src/endpoints.ts:80），而顶栏总未读
  数对全量计算（endpoints.ts:81）——**客户端从 items 派生 per-feed 未读会与总数对不上**。

## 1. 布局模型

| 决策点 | 结论 |
|---|---|
| 列数 | **二段式**起步：左=订阅导航，右=文章列表（含就地展开摘要）；组件与状态模型**预留三段式演进**（正文独立成列），本期不做 |
| 左栏宽度 | 固定约 240px，不做拖拽调宽 |
| 左栏显隐 | `u` 键整体切换；折叠时**完全收起**（不占宽度） |
| 左栏内容 | 顶部虚拟视图三行（全部 / 未读 / 星标，对应现有 filter）+ 订阅源平铺 + 每源未读数角标 |
| 文件夹/标签 | **不做**（GR spec §6 落点表列中期） |
| 样式 | 沿用现有约定：inline style + 前缀类 + `color-mix(in srgb, currentColor N%, transparent)` 跟随宿主主题，不碰宿主视觉 token（src/client/index.tsx:51 注释） |

## 2. 交互语义

### 2.1 选中与过滤叠加（GR 语义）

- 点左栏某源 → 右栏文章列表切换为该源条目；顶栏 filter（全部/未读/星标）**继续生效**，
  即「源 × filter」双条件叠加（GR spec §3.2 导航与筛选并存的行为）。
- 实现语义：`visible()` 过滤条件在现有 filter 之上加 feedId 匹配。
- 再点已选中的源 = 取消选中，回到聚合视图。

### 2.2 视图记忆

- 记住上次选中的导航项（虚拟视图或具体源）+ filter + 左栏显隐状态，持久化到 storage domain
  （宿主侧，非 domain schema 之外的新机制）；面板重开后恢复，而非回 `all` 初始态
  （现状：src/client/index.tsx:183 打开即 load，一切导航态在内存）。
- **落点（2026-10-10 实现期决定）**：`rss_reader` 域的 **global 单例槽**，**不新增表、不动 version**。
  global 与 tables 并列、不是表，因此既不触发「表集合」变更也与版本无关 ⇒ 老用户不升级数据。
  形状归一化统一在 `src/shared.ts` 的 `sanitizeViewPreferences`（读写两端都过），
  媒介层的 schema 只保证「非 null」（`null` 是「从未写过」的哨兵，见 §7）。
- **不记忆 navCursor**（键盘光标）：它是「焦点在哪行」的瞬时指向，不是「上次看到哪儿」；
  恢复时按既有规则落到生效的那一行（与鼠标点源、shift+o 打开源行同一规则）。
- **写盘时机**：只在三个离散动作后各写一次（`setFilter` / `selectNav` / `toggleNav`），
  不做防抖定时器（那会给面板引入常驻资源，与「卸载不留残余」冲突）。移动光标不写盘。

### 2.3 未读数

- per-feed 未读数由 **host 在 overview 端点计算**，payload 新增
  `perFeedUnread: Record<string, number>`（feedId → 未读数），在 src/endpoints.ts:56-72
  的单次全量遍历里累加。
- **不**从客户端 items 派生（截断后与总数不一致，见 §0）。
- per-feed 数之和与顶栏总未读数**必须相等**（不变量，见 §4）。
- 未读计数可隐藏的既有约定继续适用（GR spec §5 不变量 8：隐藏时徽标同消）。

### 2.4 键盘流（GR spec §3.8）

| 键 | 行为 |
|---|---|
| `shift+n` / `shift+p` | 在左栏导航内下/上移动选中（跨虚拟视图与源） |
| `shift+o` | 打开导航内当前选中的项（等同点击）。虚拟视图行 = 只切 filter、**保留源作用域**（与鼠标点顶栏 filter 同一路径，见 §2.1 叠加）；源行 = selectNav |
| `u` | 显隐左栏 |
| j/k/o/v/V/r/1/2/Esc | 现有语义**不变**；Esc 回退链在源视图下同样回到列表态 |

沿用现有按键架构约束：不走 ctx.shortcuts（平台禁无修饰键），document 挂载 +
输入框守卫 + 面板可见守卫（src/client/index.tsx:122/253 的既有模式）。

### 2.5 配套行为

- 左栏选中项高亮；源行含未读数角标。
- 切换源时右栏列表就地刷新，不整页重建、不丢滚动容器（滚动语义见 §3）。
- 「全部标记已读」对**当前视图**生效（聚合视图=全部源；源视图=该源）——复用现有
  mark-all 阈值与撤销窗口语义，不新造机制。

## 3. 滚动容器语义（改造时必须同步更新）

现状「列表/正文各一个滚动容器，其他视图没有容器」（tests/list-scroll.test.mjs:64）。
左栏常驻后：

- `scrollSelectorFor` 语义更新为：右栏列表容器（list/feed 视图共用）、正文容器、
  左栏自身（不做滚动贴底类操作，仅保证不误命中）。
- 「无容器视图不刷警告」不变量（tests/scroll-dom.test.mjs:299）在 FeedsView 管理页
  下保持成立。

## 4. 不变量（测试钉这些，不钉实现）

1. **未读账目守恒**：左栏各源未读之和 === 顶栏总未读数 === `Overview.unread`。
2. **过滤叠加**：源视图下 filter 按钮可见且生效；「未读」filter 在源视图下只显示该源未读。
3. **视图记忆**：面板卸载重开后，导航选中项 / filter / 左栏显隐恢复为上次状态。
4. **键位不回归**：j/k/o/v/V/r/1/2/Esc 在两列布局下行为与单列时一致（现有测试不改断言，
   只改容器选择器等实现耦合处时须逐一说明理由）。
5. **u 键折叠**：左栏收起后右栏占满整宽；再按恢复，宽度与选中态不变。
6. **Refresh ≠ 抓取**（GR spec §5 不变量 1）：切换视图/刷新计数不触发网络抓取。

## 5. 明确不做（本期边界）

- 文件夹/标签层级（GR spec §6 列中期）
- 三段式正文列（仅预留结构，不实现）
- 左栏拖拽调宽、favicon、窄屏阈值自动折叠（后续增强候选）
- per-feed 未读数进 domain schema（只在 endpoint payload 层，不动 schema 版本）

## 6. 验收

- 仓库完成定义全套：build / build:client / typecheck / test / mutation（隔离副本）。
- 新增测试：未读账目守恒（§4.1）、叠加过滤（§4.2）、导航键 shift+n/p/o/u 语义、视图记忆。
- 关键判定改动各补一条变异（非等价变异，判定方法见 scripts/mutation-test.mjs）。
- 真机三步（dev_reload_package → `$DSH_HOME/storages/rss-reader/reader-$(date -u +%F).log` 无装载失败
  → curl overview 得 401）。`state/dsh-rss-reader/reader.log` 是自持前的旧路径，**永远不再写**。

## 7. 已决定（实现期定案，回写本文）

### 7.1 视图记忆的持久化通道 → **storage domain 的 global 单例槽**

原先摆着两条路（domain 新增键 / 复用 Config），两者都不好：加表要动 schema，塞 Config 会把 UI 状态
混进订阅源配置面。实际选了第三条 —— `DomainSpec.global`（`lib/types/spec.d.ts:64-65`，
句柄 `domain.global.get()/set()` 见 `lib/types/domain.d.ts:14-30`）：

| 决定 | 值 |
|---|---|
| 落点 | `readerDomain.global`（schema = `z.unknown()` 且拒绝 `null`；`initial` = `DEFAULT_VIEW_PREFERENCES`） |
| 新增表 | **无**（`tables` 仍是 feeds / items / cursors） |
| version | **仍为 1**（single layout 是硬相等检查，升版会让老用户打不开域） |
| 通道 | 复用既有 HTTP 路由 + `requestRejection` 准入，新增两个端点 `viewPreferences` / `saveViewPreferences` |

**为什么媒介层 schema 不写严格形状**：`invalid-record` 是**开域失败**，不是「这一项读不出来」——
把严格形状写在 schema 里，等于让一条存坏的偏好把整个面板锁死。所以分两层：媒介层只管非 null，
形状归一化在读写两端各做一次（`sanitizeViewPreferences`），坏值一律回落默认。

**「老域能否打开」已实测**（这是本任务唯一必须先实测的推测）：构造真实老文件两种形态
（无 `global` 键 / `global: null`），经真实 `JsonStorageBackend` + `DomainFacility` 打开 ⇒
两者都成功，`global.get()` 回落到 `initial`，原有表记录原样在；首次 `set` 后文件被就地补上
`global` 且 `version` 仍是 1。判据固化在 `tests/nav-persistence.test.mjs`。

### 7.2 左栏源行的信息密度

- 标题：单行 + `text-overflow: ellipsis`（不做两行展开）——左栏是导航而不是内容区，
  宽度固定 240px 下两行会让行高不齐、键盘「一行」的语义与视觉行数错位。
- 失败源：**本期不单独标识**。`FeedView.lastFailure` 已经有数据，但「失败源长什么样」需要实测
  样本才能定（本仓库约定：不为未经实测的样本扩规则，见 `docs/pitfalls.md` 八）。
  现状：失败信息仍只在订阅管理页（FeedsView）逐条列出。