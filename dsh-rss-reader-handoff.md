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
4. 键盘流可用：`j`/`k` 上下移动、`o` 打开原站、`s` 星标、`m` 切换已读、`A` 全部标记已读。
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

1. **入口不能直接开右栏**：`sidebar.panellist` 的注册项只有 `id/order/label`，且其 id 必须寻址同名 `main` 座位（README 原文），**天生开不了右栏标签页**。（中途曾用 `sidebar.footer.action` 做入口，用户看过后明确否决，已删。）最终形态：`main` 面板做成**转发器**——挂载即 `ctx.sidebarRight.openTab` 开进右栏 + `ctx.layout.selectPanel(null)` 把主栏让回对话。
2. **通道不走 Connection RPC**：`ctx.connection.rpc.handle` 内部 `owner = connection 插件自己的 ctx`，该 ctx 解析不到 `webServer` → 抛 `cannot get property "webServer" without inject`；全仓库亦无产品插件用它（只有测试与 gateway）。改用 `ctx.webServer.register` + `ctx.connection.requestRejection`（宿主接口自述就是「把 Connection 的检查套用到别的 Web 路由」）。

**踩坑（都已修）**

- `apply` 里 `await` 之后再 `ctx.effect` 会抛 `cannot create effect on inactive context`（栈：`Fiber._reload → apply`）。⇒ apply 必须同步登记所有 effect，异步装配放进 effect 体内。
- 宿主信封 `ConnectionRpcFailure` 要求 `details` 字段（技能文档样板落后于源码，少了它 tsc 直接拒）。
- `ctx.connection` 的 rpc 落物理路由时经 `owner.webServer`，故与 webServer 有隐式耦合。

**已验证（宿主侧）**：entry `[active]`；重载前后均 active、无被吞错误；启动刷新正常（4 源，304 生效）；`/rss-reader-api` 探测 **401**、对照路由 **404**（路由存在且受同一套鉴权保护）。

**待验证（需用户看实物）**：浏览器里的两件事——侧栏底部「RSS」能否打开右栏标签页、条目流是否渲染并能在点击后标已读且重启仍在。若底部入口不出现，首要怀疑 client 半 apply 失败（`inject` 未满足）。
