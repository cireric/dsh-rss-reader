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
| `shift+o` | 打开导航内当前选中的项（等同点击） |
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
- 真机三步（dev_reload_package → reader.log 无装载失败 → curl overview 得 401）。

## 7. 待实现期决定（不阻塞，实现时定并回写本文）

- 视图记忆的持久化通道：storage domain 新键 vs 复用现有配置通道。
- 左栏源行的信息密度（标题截断规则、失败源标识是否复用 lastFailure）。
