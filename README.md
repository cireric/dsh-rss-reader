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
| `refreshOnStart` | true | 装载时刷新一次 |
| `logFile` | `$DSH_HOME/state/dsh-rss-reader/reader.log` | 刷新日志（宿主内证据通道） |

> 注入器（dsh-super-injector）的 `loader.create` 写死 `config: {}`，注入的插件永远拿 schema
> 默认值——所以订阅源不能只靠 Config，必须以存储域为准（M2 界面 / M4 OPML 写同一张表）。

## 键盘流（M3）与过滤

| 键 | 动作 |
|---|---|
| `j` / `k` | 下一条 / 上一条（移动即把**新选中**的条目标已读——已定的 Google Reader 手感） |
| `o` | 打开选中条目的原站（新标签页） |
| `s` | 切换星标 |
| `m` | 切换已读（可反选） |
| `A` | 把**当前过滤下**的未读全部标为已读，并给 5 秒撤销窗口 |

**作用域**：命令走 `ctx.shortcuts`，`regions: ['page']` 使其在输入框内不触发；`resolve()`
再要求阅读器根节点（`[data-dsh-rss-reader]`）持有 `document.activeElement`——所以只有
「阅读器是当前焦点面」时才响应，不会和对话抢键。点侧栏图标后面板会自动取焦；点进对话即失效。

**过滤**：全部 / 未读 / 星标。星标此前只写不读，M3 起有地方看了。

**未读徽标**：注册在 `sidebar.toggle.badge`（侧栏折叠按钮内的非交互提示）。它是 **single 座位**，
官方占用者是 Desktop 的更新提示——后注册者遮蔽前者，**Web 上官方那个本来就不渲染，无损失**；
若将来跑桌面版，这里会顶掉更新提示（已知取舍）。徽标数据源与面板共用同一个 store：
客户端装载时拉一次，之后每次面板刷新都会更新（**不加定时器**）。

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
