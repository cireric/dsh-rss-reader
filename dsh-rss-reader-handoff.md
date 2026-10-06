# dsh-rss-reader 交接简报

> 交接件（临时件：不被其他文档引用，可整份重写）。核对日期 2026-10-05。
> 目标：在新项目里实现「Google Reader 式阅读流」的 DSH 插件。范围按**选项 C = 最小验证**，不是一步到位的完整阅读器。

## 1. 一句话目标

做一个 DSH 插件，让你在 DSH Web GUI 里**读** RSS：订阅源列表 + 条目流 + 未读态 + 键盘流。
**不是**再造一个 RSS 聚合/每日简报插件——社区已有 10 个，全是这个形态，别重复。

## 2. 为什么只做最小验证

- Google Reader 的价值一半在**未读态 + 键盘流**，不在三栏布局。先证明这一半成立。
- **预先登记的失败条件**（先定死，避免沉没成本）：自己用 2 天。若在 DSH 里读 RSS 没有比「直接开网页 / 用已有 digest 插件」更快，就停，不进入三栏与全文抓取。

## 3. 验收标准（可测，不是感觉）

1. 能导入一份真实 OPML（≥20 个源），保存时逐源抓取校验，坏源单独标注、不阻断其余。
2. 抓取后有条目流：跨源合并、按时间倒序（river of news），显示未读计数。
3. **未读态持久化**：标记已读后重启 DSH，状态仍在。
4. 键盘流可用：`j`/`k` 上下移动、`o` 展开/折叠选中条目、`v` 打开原站、`s` 星标、`m` 切换已读、`A` 全部标记已读。
   > ⚠️ 本条原先写作「`o` 打开原站」，与 Google Reader 实际语义不符（GR：`o`/Enter 展开、`v` view original）。
   > 已查证并按 GR 修正（出处见 §17）。
5. 增量抓取：重复抓取不重复产出（游标或去重集合），且**不发全量重抓**（用 ETag / Last-Modified 条件请求）。
6. 卸载插件后不留残余订阅器/定时器（`ctx.effect` 释放）。

## 4. 社区参考插件（本次调研产出；★ 与版本核对于 2026-10-05）

目录：`https://awesome-dsh-plugin.com/plugins.json`（4412 条），精确命中 RSS/Atom/OPML 的插件 10 个。

| 插件 | 作者 | ★ | 形态 | 对我们的价值 |
|---|---|---|---|---|
| [@hyzyn/dsh-rss](https://github.com/hyzyn/dsh-plugin-kit/tree/main/packages/rss) | hyzyn | 46 | 每日 digest 注入 systemPrompt + 侧栏「今日值得读」弹窗 | **UI 与降级设计最值得抄**；它没有未读态 |
| [dsh-rss](https://github.com/STARDUSTLC666/dsh-rss) | STARDUSTLC666 | 4 | 9 个模型工具 + 设置里的可视化订阅面板 | **架构参照首选**（模块划分、解析、代理、迁移） |
| [dsh-rss-monitor](https://github.com/hgl011091/dsh-rss-monitor) | hgl011091 | 1 | 定时监控 + 关键词过滤 + 邮件通知 + 设置四页签 | 通知向，不必抄 |
| [rss-digest](https://github.com/JohnXu22786/rss-digest) | JohnXu22786 | 1 | 定时抓取 + 精确/近似去重 + LLM 日报 + CLI | 去重策略可参考 |
| [dsh-rss-daily](https://github.com/shangjian2023/dsh-rss-daily) | shangjian2023 | 2 | 46 源 + 主编式编辑 + webhook 推 IM | 推送向，不必抄 |
| [dsh-hotspots](https://github.com/qys0012/dsh-hotspots) | qys0012 | — | **侧边栏入口 + 三视图 + 来源筛选 + 已读标记 + 快捷键**（热点，非 RSS） | **最该抄的 DSH 原生 UI 样板**：证明「侧栏入口 + 已读态 + 快捷键」在 DSH 里已被跑通 |

### 4.1 dsh-rss（STARDUSTLC666）的模块划分 —— 直接借鉴

```
src/parser.ts         RSS 2.0 / RSS 1.0(RDF) / Atom 三格式归一化
src/opml.ts           OPML 导入导出（限 1 MiB、嵌套 ≤64 层）
src/network.ts / proxy-fetch.ts / system-proxy.ts / public-dns.ts
                      网络层：超时、体积上限、代理、VPN Fake-IP 兼容
src/subscriptions.ts  订阅列表 + 读取游标 + 每源 5000 去重 ID
src/settings.ts / legacy-settings.ts  配置存储与旧 settings.yaml 迁移
src/catalog.ts        推荐源目录（预览后才订阅）
src/tools.ts / web.ts 模型工具 / Web 面板
test/fixtures/        rss2.xml / rdf.xml / atom.xml / notafeed.html
```

### 4.2 从参考插件抄来的设计决策（已是真机验证过的）

- **解析**：RSS2.0 / RSS1.0(RDF) / Atom 三格式归一；实体解码、CDATA、`content:encoded`、`dc:creator`；相对链接按源地址解析成绝对；日期 `RFC822 / ISO8601 → ISO8601 UTC`，另存 `pubDateRaw`。
- **安全**：不解析 DTD/外部实体（XXE）；响应体积上限（5 MB）；抓取超时可配。
- **降级**：单源失败就地降级，只标注它自己，其余照常出（hyzyn）。
- **订阅项校验**：保存前真实抓取一次，抓不到就提示且不保存（两家都有）。

## 5. DSH 底座接口（**已在源码核对，可直接依赖**）

| 接口 | 用途 | 证据 |
|---|---|---|
| `ctx.sidebarRightTabs` + 键控座位 `sidebar.right.pane.tab` | **两阶段注册一个右栏标签页**：类型注册进前者，body 按同一 kind 注册进后者 | `packages/client/ui-sidebar-right/src/client/index.ts` 顶部注释；活例 `ui-sidebar-documentpreview` |
| 槽位 `sidebar.panellist` | **侧边栏图标入口**（全局面板图标） | `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:3041` |
| 槽位 `sidebar.toggle.badge` | 侧栏折叠按钮里的**非交互通知徽标**（未读数就放这） | 同上 :3794 |
| 槽位 `settings.section` / `settings.plugins.tab` / `plugins.bundle.config` | 设置面（注意：设置面位置随 DSH 版本迁移过，见 §8） | slot-catalog.ts:2650 / :2600 / :1843 |
| `ctx.shortcuts` | 应用级键盘命令，按设备 profile（web/desktop × macos/windows/linux）声明默认键 | `packages/client/shortcuts/README.md` |
| `ctx.storageDomain` | **schema 校验的 KV 域**：同步读 + 写入落盘后发 `domain/changed`；不碰后端 | `packages/storage/storage-domain/README.md` |
| `ctx.webServer.register({kind:'exact'\|'prefix', path, handler})` | 自托管 HTTP 路由（handler 独占响应）——备选路线：独立 `/reader` 页 | `packages/host/webserver/src/index.ts:166` |
| `ctx.effect(fn, label)` | 注册即副作用，卸载自动撤销 | `dsh-plugin-dev` 技能硬规则 #2 |

> ⚠️ **不要直接依赖 `@deepseek-ai/dsh-client-ui-dockkit`**：它是内部引擎，README 明说「发布只因 Sidebar 静态链接，不是稳定 API」。用 `ctx.sidebarRight` 暴露的操作。

### 5.1 与上一轮判断的自我更正

上一轮我建议「别碰 shell 布局，一律自托管 `/reader` 页」。核对 slot-catalog 后更正：**DSH 有受支持的标签页扩展路径**（`sidebarRightTabs` 两阶段注册 + `sidebar.right.pane.tab` 座位），`ui-sidebar-documentpreview` 就是活例。所以原生面板是主路径，`webServer.register` 是**备选**（用于想要完全自控布局、或想脱离宿主主题时）。两条都留，别一开始就上自托管。

## 6. 建议架构（三件，别多）

1. **fetch/parse（host 半）**：条件请求（ETag/Last-Modified）+ 三格式解析 + 超时/体积上限 + 去重。
2. **store（host 半）**：`ctx.storageDomain` 声明域，别自己上 SQLite——省掉迁移、并发与落盘语义。
   草案：
   ```
   feeds:   { id, url, title, folder?, etag?, lastModified?, lastFetchedAt?, failure? }
   items:   { id, feedId, title, link, publishedAt, summary, read: bool, starred: bool, fetchedAt }
   cursor:  { feedId: { seen: string[], cursorAt } }   // 只存去重键，不做永久归档
   ```
3. **UI（client 半）**：`sidebar.panellist` 图标 → 打开 `sidebarRight` 标签页；条目流 + 未读徽标 + 快捷键。

**明确不做（YAGNI，等 §3 过线再说）**：全文抓取（Readability）、社会化分享、文件夹多层嵌套、移动端布局、多用户/鉴权、全文检索索引。

## 7. MVP 里程碑

- **M0 骨架**：`dev_scaffold_plugin` → `dev_build_plugin` → `dev_inject_plugin`，跑通「插件能在 DSH 里出现一个入口」。
- **M1 数据面**：storageDomain + 抓取 + 解析 + 去重；用 CLI/模型工具先验证数据正确（先别做 UI）。
- **M2 阅读面**：panellist 入口 + 右栏标签页 + 条目流 + 未读态（含持久化）。
- **M3 键盘面**：shortcuts 接 `j/k/o/s/m/A` + 未读徽标。
- **M4 订阅管理**：OPML 导入导出 + 保存前抓取校验。

每步的验证方式写进提交说明，不接受「看起来对」。

## 8. 已知坑（都是参考插件真机踩出来的，别重踩）

- **设置面的位置会漂**：hyzyn 记录它的设置面在 `0.1.5` / `0.1.6` / `0.2.0-rc.1` 三处迁移过。⇒ 设置逻辑与展示层分离。
- **CSS token 陷阱**：进度条流光要用 `--dsw-alias-state-business-primary`（强调色，实测 `#4176e6`）；`--dsw-alias-brand-primary` 是品牌墨色（近黑），用错渲染成黑线。
- **绝对定位浮层必须显式写 `position:absolute`**：漏掉会让 `left/bottom/transform` 全失效，浮层退化成流式元素，把列表顶下去（实测 +38 px）。
- **刷新要有过渡层**：stale-while-revalidate（旧内容压暗可读）+ 180 ms 消抖（毫秒级请求不闪）+ 刷新后恢复搜索框焦点与滚动位置。
- **AI 摘要的 maxTokens 要留推理预算**：推理 token 与正文**共享**上限，太小会 `finish=max-tokens` 判失败；hyzyn 实测 200/1024/4096 三档，只有 4096 全成。失败原因要带回具体原因分布，别只说「N 条失败」。
- **缓存键**：hyzyn 用 `sha1(link|id|title)`，TTL 30 天，超 500 条按写入时间淘汰。
- **去重不是归档**：dsh-rss 每源只留 5000 个去重 ID。做阅读器时「已读态」必须绑到**条目 ID 的稳定派生**上，否则条目滚出窗口后已读态丢失。
- **代理/Fake-IP**：VPN 环境 DNS 返回 `198.18.0.0/15` 时需 DoH 回查并校验真实公网地址（dsh-rss 有完整实现，可直接抄思路）。
- **OPML 要有上限**：1 MiB / 嵌套 ≤64 层。

## 9. 未决问题（新项目开工前先定）

1. **读在哪**：右栏标签页（原生，随宿主主题；空间受限）vs 自托管 `/reader` 独立页（布局自由；脱离宿主）。建议 M2 先做右栏，手感不够再评估。
2. **全文抓取**：只存 feed 摘要 + 跳原站，还是抓正文？建议先不做。
3. **已读态粒度**：只记 item id 集合，还是带时间戳以便「最近已读」视图？

## 10. 证据分级与复核清单

**分级**
- **实测（源码）**：§5 全部接口与行号 —— 读的是 `/Users/eric/Project/tests/deepseek-harness` checkout。
- **文档/README**：§4 各插件的形态与决策、§8 的坑 —— 来自各自 README / USAGE.md。
- **未经实测（当作假设）**：我**没有安装运行任何一个 RSS 插件**；「设计优秀」是按 README 完整度与 star 数判的，不是亲手用过。§3 的验收标准是我提的草案，不是社区共识。

**开工前复核（30 秒）**
```bash
# 1) 目录与 star（数会变，别当常量）
curl -sSL https://awesome-dsh-plugin.com/plugins.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("count",j.count,"updated",j.updated);j.plugins.filter(p=>/\\brss\\b|\\batom\\b|\\bopml\\b/i.test(p.name+JSON.stringify(p.description))).forEach(p=>console.log(p.name,p.stars))})'
# 2) 槽位键名是否仍存在（版本升级会变）
grep -n "key: 'sidebar.panellist'\|key: 'sidebar.right.pane.tab'\|key: 'sidebar.toggle.badge'" \
  /Users/eric/Project/tests/deepseek-harness/packages/extensions/cordis-client-runner/src/client/slot-catalog.ts
# 3) 标签页两阶段注册的权威说明
sed -n '1,30p' /Users/eric/Project/tests/deepseek-harness/packages/client/ui-sidebar-right/src/client/index.ts
```

## 11. 参考链接

- 社区目录：<https://awesome-dsh-plugin.com> ｜ registry：<https://awesome-dsh-plugin.com/plugins.json>
- 插件市场（本机已装）：`dshmarket`（设置 → Plugin Market）
- 插件开发权威规范：技能 `dsh-plugin-dev`（`~/.dsh/skills/dsh-plugin-dev`）
- 槽位目录（机器可读）：`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`

---

## 12. M0 施工记录（2026-10-05）

已跑通：**骨架装配完成，入口在 DSH 里成立**。包名 `@dsh-external/dsh-rss-reader`。

| 步骤 | 命令 | 结果 |
|---|---|---|
| 脚手架 | `dev_scaffold_plugin`（hybrid） | 生成 8 个文件 |
| 构建 | `dev_build_plugin` | host ✓ ／ client ✓ ／ tgz ✓ |
| 注入 | `dev_inject_plugin` | junction 进 web profile，loader entry `[active]` |

**我改掉了脚手架的两处生成物**（原样不适合本项目）：

1. **host 半原本是 daemon-loop**（timer + LLM 自主循环，每 60s 醒来读 self-heal.log、必要时调 LLM）
   → 换成不含定时器与 LLM 的最小骨架。一个 RSS 阅读器不该自带一个会唤醒模型的守护循环。
2. **client 半原本注册到 `conversation.view`** → 换成 `sidebar.panellist` 图标 + 同 id 的 `main`
   面板（ui-sidebar README §Global panel entries；活例 `ui-plugin-manager`、`ui-schedule`）。

**验证（可复现）**

- `npm test` → 2 passed。直接加载**构建产物** `lib/client.js`，断言：bundle id 正确；`inject=['slots']`；
  注册了 `sidebar.panellist` 与 `main`，且 **`main.key === panellist.id`**（不一致时浏览器里点击会抛错）。
- `dev_reload_package` → `before [active] → after [active]`，client ✓：装载/卸载循环无残留。
- loader entry：`[active] e8f6a1d5 (@dsh-external/dsh-rss-reader) [injected]`。

**未验证（据实标注，不许当已验证）**：GUI 里图标是否已渲染成可见元素。本机 `dsh web` 用一次性 token 鉴权
（401 “dsh web authentication required; reopen the URL printed by dsh web”），该 token 不进会话记录，
因此没有用浏览器实机核验 DOM。**请刷新页面确认侧栏底部出现「RSS 阅读器」图标。**

**已知缺口**：client 半（`.tsx`）只经 tsdown 转译，未参与 tsc 类型检查（`tsconfig.json` 排除 `src/client`）；
补法写在 README「已知缺口」。

**下一步 M1（数据面）**：开工前先定 §9.3 的已读态粒度——建议存 `readAt` 时间戳（未读 = `readAt == null`），
多一个字段换掉日后迁移整张已读表。定了再动 `storageDomain` 与抓取。

---

## 13. M1 施工记录（2026-10-06）

数据面完成并在**真实宿主**里跑通；**无模型工具、无定时器**（理由见 §12 末尾同一原则）。

**落地**：`src/feed/{fetch,parse,date,item-id}.ts` + `src/{domain,store,refresh,index}.ts`。
订阅源以存储域 `rss_reader` 为准（Config.feeds 只做幂等种子）；域落盘 `$DSH_HOME/storages/rss_reader.json`。

**证据**

| 验证项 | 手段 | 结果 |
|---|---|---|
| 三格式归一 / 日期 / 实体 / 相对链接 | `npm test`（fixture） | 22 passed |
| 抓取边界：304 / 超时 / 体积上限 / GBK | `npm test`（本地 HTTP 服务器） | 全过，不依赖外网 |
| 去重、保留量裁剪、**已读态不被重复抓取回退** | `npm test`（内存 store） | 全过 |
| 真实网络端到端 | 宿主内日志 | 4 源首抓 53 条；再抓 HN +1、其余 304 |
| 订阅源持久 | `rss_reader.json` | feeds 4 / items 54 / cursors 4，未读 54 |
| 卸载不留残余 | `dev_reload_package` | 单 entry、日志 0 异常 |

**踩坑（都已修）**

1. `htmlEntities: true` 不能省——库默认不解析 `&#8217;` 这类数字字符引用。
2. 注入器 `loader.create({config:{}})` 写死空配置 → 订阅源改以存储域为准，Config 降级为种子。
3. 域 disposer 必须**返回** `close()` 的 promise，`void domain.close()` 会让新 fiber 撞 `already-open`。
4. **注入器侧未修**：reload 路径吞 dispose 失败（`super-injector/src/index.ts:1296-1300`），
   且自愈与 reload 并发造 fiber → 上一代域句柄变孤儿、名字永久占用（实测插件卡在 `[failed]`）。
   本插件用设施公开诊断面 `ctx.storageDomain.get()` 有界接管。**建议修注入器**（reload 前真正 await 并存证 dispose 失败）。

**遗留数据（据实说明）**：验证期间往 `rss_reader` 域里种了 4 个真实源（HN / GitHub Blog / 少数派 / 阮一峰）
共 54 条未读。M2 正好拿它当真实数据渲染；不要可直接删 `$DSH_HOME/storages/rss_reader.json`。

**下一步 M2（阅读面）**：`sidebar.panellist` 图标改开**右栏标签页**（`ctx.sidebarRightTabs` 两阶段注册
+ `sidebar.right.pane.tab` + `sidebar.right.pane.tab.title`，活例 `ui-sidebar-documentpreview`），
面板体换成跨源按时间倒序的条目流 + 未读计数（`readAt` 为空即未读）。

---

## 14. M2 施工记录（2026-10-06）

阅读面落地：右栏标签页 + 条目流 + 未读态 + 打开面板刷新。

**已定与落实**（均按用户「先按建议处理」）：① 右栏标签页；② 打开条目即标已读（`readAt`）；③ M2 带鼠标写入口（点击展开并标已读）；④ 行密度＝标题+源+相对时间；⑤ 打开面板刷新 + 最小间隔 10 分钟（配置项），仍无定时器。

**两处偏离方案，都有实测依据**

1. **入口最终定为主栏**：`sidebar.panellist` 的注册项只有 `id/order/label`，且其 id 必须寻址同名 `main` 座位（README 原文），**天生开不了右栏标签页**。其间试过两版并都被用户实际使用否决、已全部移除：
   - ① `sidebar.footer.action` 底部入口（用户：「不需要」）；
   - ② `main` 面板做转发器、把阅读器开进右栏（`ctx.sidebarRight.openTab` + `ctx.layout.selectPanel(null)`）——实测**转发不生效**，只留下一个点了没反应的兜底按钮（用户：「像原来那样即可（不需要又在右栏打开）」）。
   结论：图标 → `main` 面板直接渲染阅读器；右栏标签页那套（类型/body/chip 标题）与 `sidebarRight`/`layout`/`sidebarRightTabs` 注入一并删除，client 的 `inject` 回到 `['slots']`。
2. **通道不走 Connection RPC**：`ctx.connection.rpc.handle` 内部 `owner = connection 插件自己的 ctx`，该 ctx 解析不到 `webServer` → 抛 `cannot get property "webServer" without inject`；全仓库亦无产品插件用它（只有测试与 gateway）。改用 `ctx.webServer.register` + `ctx.connection.requestRejection`（宿主接口自述就是「把 Connection 的检查套用到别的 Web 路由」）。

**踩坑（都已修）**

- `apply` 里 `await` 之后再 `ctx.effect` 会抛 `cannot create effect on inactive context`（栈：`Fiber._reload → apply`）。⇒ apply 必须同步登记所有 effect，异步装配放进 effect 体内。
- 宿主信封 `ConnectionRpcFailure` 要求 `details` 字段（技能文档样板落后于源码，少了它 tsc 直接拒）。
- `ctx.connection` 的 rpc 落物理路由时经 `owner.webServer`，故与 webServer 有隐式耦合。

**已验证（宿主侧）**：entry `[active]`；重载前后均 active、无被吞错误；启动刷新正常（4 源，304 生效）；`/rss-reader-api` 探测 **401**、对照路由 **404**（路由存在且受同一套鉴权保护）。

**待验证（需用户看实物）**：浏览器里的两件事——侧栏底部「RSS」能否打开右栏标签页、条目流是否渲染并能在点击后标已读且重启仍在。若底部入口不出现，首要怀疑 client 半 apply 失败（`inject` 未满足）。

---

## 15. M3 施工记录（2026-10-06）

键盘面 + 未读徽标，按用户「M3 按建议执行」落地的五条：

1. ~~**j/k 移动即标已读**（Google Reader 手感）~~ → **2026-10-06 用户实际使用后修正：
   `j`/`k` 只移动选中，不标已读**。已读只由「打开条目」（`o`/Enter/点击）与显式 `m` 触发。
   核实后更正表述：这**不是**偏离 GR——GR 只有 **expanded view + 默认开启的 Scroll tracking**
   才扫过即已读（可在 Preferences 关掉），**list view 下同样是打开才标已读**（出处见 §18）。
   本插件取的是 list view 那一套。
2. **A 的范围 = 当前过滤下的未读**，并给 5 秒撤销窗口（客户端计时，非宿主定时器）。
3. **星标可见**：加过滤条 全部 / 未读 / 星标（此前 starred 只写不读，是死字段）。
4. **快捷键作用域**：走 `ctx.shortcuts` 的 `regions: ['page']` + `resolve()` 判据
   （阅读器根节点是否持有 `document.activeElement`）——原生机制，未自造 DOM 拦截。
5. **徽标刷新**：与面板共用 store，装载拉一次 + 每次面板刷新后更新；无定时器。

**host 侧新增**：`ItemView.starred`；端点 `markRead`（改收 `itemIds[]`）、`unmarkRead`（服务撤销）、
`toggleStar`。清理 readAt 时显式重建记录（zod `.strict()` 下不塞 undefined 键）。

**验证**：构建通过；23 条测试全绿（新增契约测试：徽标座位 + 六个命令的 id/默认键/regions/resolve）；
重载前后均 `[active]`、无被吞错误、启动刷新正常。**浏览器侧待用户刷新后实测**
（键盘、过滤、撤销、折叠态徽标）。

**已知取舍**：徽标座位是 single，桌面版会顶掉官方的更新提示点（Web 无此 UI，故无损）。

---

## 16. 事故与根因：M3 的 client 半启动即崩（2026-10-06）

**症状**：用户重启 DSH 后进不去、报错；手动删掉注入器注册表里本插件的条目才恢复。插件 host 半
在此之前一直健康（13:09:45 还在正常刷新）⇒ 炸的是**加载时**，不是运行时。

**根因（两处，都是宿主「加载期校验、失败即响亮抛错」的设计被打穿）**

1. **未读徽标撞车**：`sidebar.toggle.badge` 是 **single** 座位，已被官方 `DesktopUpdateIndicator`
   以默认优先级 0 占用；我按默认优先级注册 ⇒ `ui-slots/src/index.ts:1134-1140`「同 cell 同优先级
   的第二次注册抛错」。**上一轮我把这条规则读成了「后注册者遮蔽前者」，是误读。**
2. **裸键绑定非法**：`ctx.shortcuts.register` 对每个 profile 校验默认键，`configuration.ts:100`
   规定 `modifiers` 为空或全为 `shift` 即 `modifier-required` ⇒ `registry.ts:94` 直接
   `throw 'Reserved shortcut default'`。j/k/o/s/m/A 恰全是裸键，**六个命令一个都注册不上**。

第一条先抛，client 半 `apply` 当场中断；而注入器在启动时会自动装回本插件，于是崩在启动路径上。

**修复**

- 键盘改为**阅读器根节点上的 DOM keydown 监听**（根节点持焦 ⇒ 只在阅读器激活时响应，也不截获输入框），
  彻底不碰 `shortcuts` 的绑定校验；client `inject` 收窄回 `['slots']`。
- 徽标改注册为 `{ name: 'sidebar.toggle.badge', priority: -1 }`：显式与官方差开优先级（同优先级才是抛错），
  且因「最低优先级渲染」而生效。
- 契约测试补回归护栏：徽标 `priority` 必须存在且 ≠ 0；测试的桩 ctx **不再提供 `shortcuts`**
  （谁再引入 `ctx.shortcuts.register` 会当场炸测试）。

**验证**：23 条测试全绿；重新注入运行期 `host ✓ client ✓`、entry `[active]`、启动刷新正常、
无新的被吞错误。

**仍未验证（据实标注）**：**浏览器侧的真实加载**我无法自测（GUI 需鉴权 token）。修复依据是把两处
校验规则逐行读准 + 契约测试反证不再调用 `shortcuts`；剩余风险是「还有我没读到的加载期校验」。
若刷新页面后 GUI 仍报错，请把浏览器控制台的首条报错发我。

---

## 17. 正文取法与按键对齐（2026-10-06）

用户问「能否阅读全文 / 只能打开链接吗」，核对后发现**不是能力问题，是我的实现丢了全文**：

1. **解析层字段优先级写反**：RSS 取 `description ?? content:encoded`、Atom 取 `summary ?? content`
   ——**优先摘要、丢掉全文**。实测同一份 feed 里 GitHub Blog 的 `content:encoded` 有 3,826–548,104
   字符，`description` 只有 231–286。改为 `fullest()`：取**去标签后更长的那一份**。
   实测效果：GitHub Blog 10 条 2,346 → **127,522 字符**（单条最长 48,893），已读态 7 条未动。
2. **展示层截断 + 纯文本**：去掉 400 字上限；HTML 转成**段落数组**渲染（块级标签换行、去标签、
   收敛空白），全程当文本 → 无 XSS 面、不引 sanitizer 依赖。上限交给存储层 `maxContentChars`
   （默认 50,000：正文优先后个别源会给几十万字符的整页 dump，而存储域打开时全量载入内存）。
3. **老条目回填需要一次全量**：回填只在源返回 200 时跑，而源通常回 304（实测第一次重载后
   GitHub Blog 仍是 2,346 字符 —— 回填根本没机会跑）。故加 `contentRevision`：源记录缺该字段
   或落后时，**第一轮**抓取绕开条件请求拿 200，升级后立即恢复增量。
4. **按键对齐 Google Reader**：`o`（或 Enter）展开/折叠、`v` 打开原站。出处：Google Reader
   Cheat Sheet、中文整理页与 Karina Myers 的按键表三份独立资料一致（`o/enter: expand/collapse`、
   `v: view original`）。交接件 §3.4 原写法有误，已在原处标注并修正。

**测试**：28 条（新增：RSS/Atom 的正文优先、正文回填保已读、正文上限、升级轮绕开条件请求）。

---

## 18. 按键语义核实 + 刷新加载态（2026-10-06）

**用户质疑我「GR 里 j/k 扫过即已读」这句未经查证的断言。核实结果：**

- **`o` = expand/collapse item、`v` = view original** —— 一手证据：Google Reader 官方博客
  [J-walking with Reader](http://googlereader.blogspot.com/2008/02/j-walking-with-reader.html)（2008）
  按真实按键次数排的 Top-10：`j next item / k previous item / m mark as read-unread / o expand/collapse item /
  v view original / s star item`。与 cheat sheet 的 `o/enter: expand/collapse (list only)` 一致。
  ⇒ 本插件 M2 时按交接件 §3.4 写成「`o` 打开原站」是错的，已改。
- **`j`/`k` 与已读**：不是无条件的「扫过即已读」。GoogleReaderHelp 官方视频（2009）：
  *"the default setting is to mark items as read as you scroll past them … toggle by unchecking
  **Scroll tracking**"*；StackExchange（2010）：*"In **expanded view**, mark items as read when you
  scroll past them（Preferences 可取消）… **If you use list view instead, posts won't be marked as
  read until you click to open them**"*。
  ⇒ 用户要的「打开才算已读」= **GR 的 list view 语义**，属于 GR 的既有模式之一，**不是偏离**。
  我上一轮把它写成「刻意偏离」是错的（当时那句依据本身就没核实），已在 README 与 §15 更正。
- 顺带：GR 里 **`j`/`k` 本身不"展开"条目**——expanded view 下每条本来就是展开的，j/k 只移动；
  list view 下才由 `o` 就地展开/折叠（cheat sheet 标注 "(list only)"）。

**刷新按钮与加载态（用户要求优化）**：180ms 消抖后才显示加载态（毫秒级请求不闪）→ 按钮图标旋转
+ 文案「刷新中…」+ 禁用 → 头部下方 2px 不确定进度条 → 列表压暗 0.6 但**仍可读**（SVR）。
**明确不做全屏遮罩**：刷新期间用户多半还在读旧内容，遮罩只会打断阅读并制造闪烁；「旧内容压暗可读
+ 完成后自动重渲染」是这套 UI 的正解（handoff §8 早记录过这条教训）。

---

## 19. 右栏方案不可行的根因与 D 方案（2026-10-06）

**C 步（V 开右栏标签页）实测失败，根因是宿主的硬约束，不是快捷键冲突：**

探针日志 8 条都长这样：`{"step":"openTab","hasService":true,"beforeKind":null,
"error":"sidebarRight: no session surface is mounted"}`。能被记录即证明按键到达了处理函数，
**排除了「shift+V 与浏览器/系统快捷键冲突」**。

- 守卫在 `packages/client/ui-sidebar-right/src/client/service.ts:720-730`：`openTab` / `close` /
  `openResource` 等**所有写操作**都要求「屏幕上有会话」，否则抛 `no session surface is mounted`。
- 会话是否「在屏幕上」由主栏决定（`service.ts:303` ← `sessions.onScreen`）。官方测试注释写得
  很直白（`ui-sidebar-right/tests/apply.client.spec.ts:216-218`）：**「A global panel takes the
  Conversation's place: no Session is on screen.」**
- **我们的阅读器就是主栏面板**：它一打开就把会话挤掉 ⇒ 右栏没有可写入目标。
- 官方唯一两处 `openTab` 调用（`ui-schedule/src/client/index.ts:198,225`）都在**会话侧座位**
  （`conversation.chat.turnTail`、`conversation.session.header.utilities`），不在主栏面板里。

⇒ **从阅读器（主栏面板）开右栏标签页在当前结构下做不到。** 我早先记的「转发器不生效」是同一个坑，
当时只记了现象、没追到这条守卫——这是可行性分析没有落到源码级验证的代价。

**D 方案（已实施）**：正文**在主栏内**打开，不碰右栏。

- `V`：抓原站 + 抽正文 + 在主栏内换成阅读视图；`Esc`（或「← 返回列表」）回列表。
- 抽取在**宿主侧**（`src/article.ts`）：段落纯文本回传 ⇒ 客户端不注入 HTML（无 XSS 面），
  且抽取逻辑能用固定夹具做单测（7 条），并已用真实页面验证（13,490 字符 / 38 段；
  版式不支持时如实报错，不编造）。
- 缓存挂在条目记录上（`item.article`）：第二次打开不跑网络；失败原因存 `item.articleFailure`，
  重开可见；同一篇 30 秒冷却防请求风暴（`articleCooldownMs`）。
- 列表在正文视图下用 `display:none` 隐藏而不是卸载 ⇒ 返回时滚动位置还在。

**探针已撤除**：C 步的客户端探针、`probe` 端点与嵌套 `inject` 注册整块删除（源码与产物均已核对为 0），
同批的 bug 修复与客户端作用域闸门保留。

---

## 20. 正文「原样输出」的边界与抽取修正（2026-10-06）

用户反馈：抽取版读起来「样式全变样，代码尤其差」。核实后分两件事处理。

**① 「直接开原样页面」能不能做，取决于站点策略（实测，不是推断）**

| 站点 | 判定 | 依据头 |
|---|---|---|
| mihai.dinculescu.dev / sspai.com / ruanyifeng.com / news.ycombinator.com | 允许被嵌 | 无 `X-Frame-Options`、无 `frame-ancestors` |
| github.blog | **拒绝** | `X-Frame-Options: SAMEORIGIN` |
| developer.mozilla.org | **拒绝** | `X-Frame-Options: DENY` |

⇒ 实现为**两个视图**：默认抽取版（任何站点可读），站点允许时可切「原站视图」（iframe 原样渲染）。
不可嵌的站点按钮置灰并说明原因（不假装可用）。判定函数 `isFrameable(headers)` 有单测覆盖
（SAMEORIGIN / DENY / allowall / `frame-ancestors 'none' | *` / 无策略）。

**② 代码块与段落边界（两个真 bug，都是"夹具过了、真页面露馅"）**

- **代码块被整块丢弃**：原实现只收 `<p>`，`<pre>` 内容既不入段、又被 `script/style` 之外的长度门槛
  杀掉 ⇒ 代码全没了。改为 `<pre>` 单列一路：`preToText` **保留换行与缩进**（不能复用
  `htmlToText`，它逐行 trim，实测把 4 空格缩进抹平——单测当场抓到），不适用长度门槛，客户端
  按等宽 + `pre-wrap` 渲染。
- **段落配对正则在真实站点上命中 0**：`mihai.dinculescu.dev` 的页面 `<p` 出现 **34 次**而
  `</p>` 出现 **0 次**（HTML 允许省略闭合标签）⇒ `<p>…</p>` 配对正则一段都收不到，只是被
  「退化路径按行取全文」兜住才没崩。改为**按块级边界切分**（闭合标签、**开始标签**、`<br>`），
  代码块用占位符保护后再切；只在完全抽不到时才走按行兜底。
  实测：同一篇从「2 段 / 最长 2,383 字符」变为「47 段 / 最长 977 / 中位 251」。

**方法教训**：这两条都是**夹具通过、真页面失败**——只用夹具验证抽取逻辑会漏掉真实 HTML 的畸形
（省略闭合标签）。此后抽取类改动必须同时跑真页面统计，并检查段数/最长段这类量级指标。

---

## 21. 已读语义统一 + 客户端行为终于可测（2026-10-06）

**用户提问**：列表页按 `V`（系统浏览器打开原站）后该条目算不算已读？

**核实结果**：这是一处**真实不一致**，不是设计选择——

| 打开路径 | 改动前 | 改动后 |
|---|---|---|
| 列表点击 / `o` | 标已读 | 标已读 |
| `V` 内置详情页 | 标已读 | 标已读 |
| **`v` 系统浏览器** | **不标已读** | **标已读** |

同一类动作（打开条目）三条路径语义应当相同；GR 的 `v`（view original）也是阅读动作，不与已读冲突。
已在 README 与代码注释里写明「这是刻意统一，别改回去」。

**顺带补上的能力（比这个改动本身更重要）**：客户端行为此前**只能靠读代码确认**，而历史上
故障几乎都出在接线上。本轮把 `createReaderStore` 导出（去掉未使用的 `ctx` 参数，confirm 过
`createReader` 内 ctx 只剩注释提及），于是测试可以**驱动真实 store**：桩 `fetch` + 桩
`window.open`，断言「按 v 之后 `window.open` 与 `markRead` 都发生了」。新增 4 条：

- 三条打开路径的已读语义；
- **空链接不误伤**（不打开、不标已读）；
- **产物过期即失败**（源码比 `lib/client.js` 新时直接报错）——因为本轮踩到：`scripts/build.sh`
  只编译 host，client 由 tsdown 产出，**只跑 build.sh + 测试会在不知不觉中测旧产物**。

反向验证：去掉 `void markRead(item.id)` → 测试当场失败；还原 → 49/49 全绿。

---

## 22. 保留策略三件事（2026-10-06 用户确认后实施）

用户问「磁盘缓存会留多久、有没有定期清理」。核实：**没有任何时间过期或定时清理**，只有容量规则。
顺带查出两个缺口，用户全部确认修复：

1. **裁剪不保护星标/已读**（改动前是无差别删最旧——星标条目照样被删）。
2. **按需正文缓存无体积上限**。
3. 需要一个**显式清理入口**（而不是定时器——验收项之一就是不残留定时器）。

**实施**（策略全部抽到 `src/retention.ts` 的纯函数，因为这些都是「删数据」的规则）：

| 函数 | 规则 |
|---|---|
| `selectPrunable` | 每源裁剪：**先删未读、再删已读、星标永不删**；星标占满时宁可超上限 |
| `selectArticleEvictions` | 正文缓存超限时从最旧清起；上限非法（≤0/非有限）视为不清理 |
| `selectCleanup` | 显式清理：**已读 + 未星标 + 严格早于阈值**，三者缺一不可 |

**接线**：`refresh.ts` 的 `prune` 换用 `selectPrunable`；每次成功抓取后跑 `capArticleCache`
（只清 `article` 字段，显式重建记录以保住 readAt/starred）；host 新增 `cleanup` 端点 + 两个
Config（`maxArticleCacheChars` 8M、`cleanupAfterDays` 30）；客户端顶栏加「清理旧条目」按钮
（二次确认 + 结果提示条，0 条也要如实说「没有可清理的」）。

**测试**：策略层 9 条（边界、星标保护、单调/刚好达标、阈值严格性）+ 端到端 2 条（星标保护、
缓存闸门），共 60 条全绿。

**本轮踩的坑（两处，都是我的）**：
- 测试里换了服务器端口 ⇒ `feedId` 变了 ⇒ 裁剪/清理作用在另一个源上，测试失败。改用
  **同一服务器 + 可变响应体**。
- `maxArticleCacheChars` 首次插进了 `index.ts` 的 Config 而非 `RefreshOptions`，tsc 报
  TS2353/TS2339 才发现——**又一次是我没核对替换结果**。

---

## 23. M4 施工记录：订阅管理（2026-10-06）

原始定义（§7）：**OPML 导入导出 + 保存前抓取校验**；对应验收标准 §3.1。

**实现**（全部新增逻辑都做成可测形态）：

| 模块 | 职责 | 测试 |
|---|---|---|
| `src/opml.ts` | 解析/生成 OPML（纯函数） | 9 条：属性大小写不敏感、嵌套分组 `a/b`、重复项、坏 URL、非 OPML 输入、**导出→导入往返一致** |
| `src/subscribe.ts` | 逐源校验编排 | 5 条：**坏源不阻断其余**、结果顺序与输入一致、**并发峰值受控**、304 不算通过、空输入 |
| host `opmlImport`/`opmlExport`/`addFeed`/`removeFeed` | 端点与落库 | 端到端（见下） |
| `src/client` `FeedsView` | 界面：导入/导出/加源/退订 + 坏源逐条红显 | 浏览器侧待实测 |

**关键判据**：「是不是可订阅的 feed」用**解析结果**判定，不用 HTTP 状态——实测有站点对任意路径都回 200 HTML，
只看状态码会把网页当订阅存下来。

**§3.1 端到端验收（真跑，不是声称）**：构造 21 源 OPML（含 3 个故意坏源）→
**16 通过 / 4 失败，耗时 4.6 秒**，坏源逐条给出可读原因：
`www.zhihu.com/rss`（不是可识别 feed）、`example.com/`（不是可识别 feed）、
`github.com/this-path-should-404-x`（HTTP 404）、`danluu.com/atom.xml`（响应超体积上限 5 MiB）。
**没有一条坏源阻断其余源**。

**幂等验收**：同一份 OPML 导入两次 ⇒ 第二次「新增 0、已存在 3」，源数与分组不变；坏源始终不入库。

**顺带**：`store` 新增 `deleteFeed`（退订时连带删游标），条目由端点一并删除，避免孤儿数据。

**遗留（据实标注）**：界面部分（文件选择器、坏源报告渲染）**我无法自测**，需用户实测；
§3.3「重启后未读态仍在」仍缺冷启动证据（属 A 项）。
