# 踩坑与开发经验

> 一处一份内容：本文件是**踩坑记录与开发经验**的唯一归属。README 只做简介，
> `AGENTS.md` 只放必须遵守的规则。改代码前先扫一遍这里的标题。

每条都写：**病象 → 根因 → 修法 → 判据在哪**。没有实测样本的一律不进本文件（写「待验证」也行）。

---

## 一、工程流程（改代码前先看这节）

### 1.1 测试跑的是 `lib/` 产物，不是 `src/`

**病象**：改完源码跑 `npm test` 全绿，真机行为却没变。
**根因**：测试 `import … from '../lib/…'`，测的是上一次构建的产物。
**修法**：改完先 `npm run build`（动过 `src/client/**` 再加 `npm run build:client`）再测。
**判据**：`tests/client-bundle.test.mjs` 有一条「产物不能过期」的守护测试（**只管 client 侧**；
host 侧 `lib/*.js` 没有这种守护，旧产物会静默通过）。

### 1.2 `npm run build` 只编 host

改过 `src/client/**` 必须另跑 `npm run build:client`，否则 `lib/client.js` 是旧的。
本次开发中已两次因此得到假绿/假红。

### 1.3 变异门槛必须在隔离副本里跑

**病象**：在源目录直接跑 `npm run mutation`，等于把带变异的代码热载进正在运行的插件。
**根因**：该脚本会**临时把 `lib/` 改坏再还原**（含 SSRF 拦截那几条），而注入器的 watch 按
`lib` 指纹自动重载。
**修法**：复制到 `/tmp`（软链 `node_modules`）再跑。硬杀会留下带变异的 `lib` ⇒
隔离副本重跑前**必须从源目录重新拷 `lib`**，否则基线直接红（本次实测踩到两次）。

### 1.4 变异条目的 `from` 要照编译产物的实际形状写

**病象**：变异报「**未应用**」。
**根因**：产物是多行 `if`、单引号、`??`；照源码格式写模式就匹配不上。
**为什么比幸存更隐蔽**：幸存至少说明这条变异跑了，未应用等于**这条根本没跑**。
**修法**：先 `grep` 产物的真实形状，再写 `from`。本次实测踩到两条。

### 1.5 改文件前必须用 read 读过它

批量改写要用**锚点唯一**的替换，别用会跨段吞噬的惰性正则 ——
本仓库有过把客户端入口 import 块整段删掉、bundle 从 178KB 掉到 56KB 的事故。

### 1.6 依赖不是 `npm install` 来的

`scripts/build.sh` 每次从 dsh 源码 checkout **现链**（依次探测 `$HOME/dsh-harness`、
`$HOME/dsh`、`$HOME/.dsh/dsh-harness`、`$HOME/deepseek-harness`，都不命中就给
`DSH_CHECKOUT=<path>`）。**本仓库没有锁文件** ⇒ 不可独立安装、进不了 CI。

### 1.7 客户端 bundle 不许引第三方库

除 `tsdown.config.ts` 的 `neverBundle` 之外的东西都会被真打进 bundle，需要什么就自带实现。

---

## 二、测试与夹具

### 2.1 假 React 夹具测不出「跨渲染的闭包/生命周期」缺陷

**病象**：带 bug 的产物在 `npm test` 下 **175/175 全绿**，而用户在详情页按空格毫无反应。
**根因**：`client-bundle.test.mjs` 的自写假 React 里 `useEffect: (fn) => { fn() }`
**完全忽略依赖数组**，且所有 ref 回调共用**同一个桩节点** —— 这一类失效在那套夹具里
**根本无法表达**。
**修法**：另起一层 `tests/scroll-dom.test.mjs`，用**真实 React 18 + jsdom** 渲染**真实构建产物**，
派发真实 `KeyboardEvent` / `MouseEvent`。
**⚠️** 别为省事把这类用例挪回 bundle 夹具 —— 它在那里永远全绿。

### 2.2 jsdom 的能力缺口要显式补，别误读成代码的宽容

- **无布局引擎**：`getClientRects()` 恒为空数组 ⇒ 面板可见性守卫会直接 return（实测踩到），
  测试里显式覆写。
- **`scrollHeight`/`clientHeight` 恒为 0**：夹具用 `arm()` 装可控几何。
- **没有 `ResizeObserver`**（实测 `undefined`）：装受控桩才能复现「内容长高」（见 §4.3）。
- **有 `requestAnimationFrame`**（`pretendToBeVisual` 下真走时钟），
  **没有 `Element.prototype.scrollTo`**、不支持 `scrollBehavior` ⇒ 平滑滚动只能自己逐帧写。

### 2.3 真实依赖怎么找

`jsdom` 在 checkout 根（可 `require.resolve`）；`react` / `react-dom` 只在
`node_modules/.pnpm` 下，按 `build.sh` 同样的 glob 方式定位。解析不到时**跳过而不是失败**
（那是环境能力，不是本仓库的缺陷），但要在 `console.warn` 里说清原因。

### 2.4 测试夹具桩件缺 hook 会让整组测试报错

给假 React 加 `useRef` 前，组件一引入 `useRef` 整套夹具全红（`is not a function`）。
桩件要跟组件用到的 hook 同步。

---

## 三、客户端 / React

### 3.1 长驻监听器不许捕获「会变的值」

**病象**（用户实测）：列表页空格翻页正常，按 `V` 进详情页后 **空格 / `n` / `p` 全部静默 no-op**。
**根因**：keydown 监听器挂在 `document` 上、依赖数组是 `[root, store]`，而滚动容器存在
`useState` 里 ⇒ 进详情页时 `setArticleBox` 引发的重渲染**不会重跑 effect**，
闭包里那个值恒为 `null`。
**修法**：容器统一标 `data-rss-scroll`（取值集中在 `list-scroll.ts` 的 `scrollSelectorFor`），
**按键时刻按标记现取**。用 `useRef` 句柄也行（身份稳定），但**现取**还多覆盖一种情况：
容器换了节点。
**⚠️** 别改回 `useState` —— 那会让下一个滚动容器以完全相同的方式再坏一次。

### 3.2 按键路径不许指望「环境里恰好有某个全局」

**病象**：`instanceof HTMLElement` 里的标识符必须在 **bundle 所在 realm 的全局作用域**里存在；
缺失时按键处理器第一行抛 `ReferenceError`，**被事件派发吞掉** ⇒ 所有快捷键全哑、
控制台什么都没有（实测：删掉全局后 `prevented=false`）。
**修法**：判定只看节点自身的形状 —— `list-scroll.ts` 的 `isElementNode`（`nodeType === 1`）。
**⚠️** `root` **不在这一类里**：它来自 `useState` 且在依赖数组 `[root, store]` 中，
root 一变 effect 就重注册监听 —— 别把它也改成「现取」，那是没有依据的改动。

### 3.3 「滚到底」不等于「停在底部」

**病象**（用户实测）：新文章**首次**点 ↓ 到不了底、差一小段；先点 ↑ 再点 ↓ 就正常。
**根因**：正文图片 `loading="lazy"` 且**没有固有尺寸**（抽取层只回传 `src`/`alt`），
点 ↓ 那一刻算出的 `scrollHeight` 只是**当时的**；图片随后进场加载把内容撑高，
而 `scrollTop` 留在原地。
**修法**：点 ↓ 后**钉住底部**（`article-pane.tsx` 的 `pinnedRef` + `ResizeObserver`
盯**正文内容那层** —— 不是滚动容器本身：容器是 `flex:1` 固定高，内容变高它不变）。
用户滚走 / 点 ↑ / 换文章即解除（判定是「我们写进去的值 vs 实际值差 > 2px」）。
**⚠️** 别把钉住扩到键盘翻页：`n/p`、空格是**增量**滚动，没有「该停在底部」这个意图。

### 3.4 批量替换与产物新鲜度

见 §1.1 / §1.5。客户端改动后 `lib/client.js` 的 mtime 若早于 `src`，跑的就是旧代码。

---

## 四、宿主 / 平台约束

### 4.1 不要改回 `ctx.shortcuts`

平台规则禁止无修饰键的绑定（`packages/client/shortcuts/src/client/configuration.ts:100`：
`modifiers` 为空或全为 `shift` 即返回 `modifier-required`，而 `registry.register` 对每个
profile 都跑这个校验，不通过直接 `throw`）。`j/k/o/s/m/A` 全是裸键，注册即抛错 ——
**2026-10-06 实测：这一条把整个 client 半炸掉**，导致 DSH 重新加载时 GUI 报错。
**代价（已知副作用）**：监听挂在 `document` 上 ⇒ 面板可见时裸键的监听面是整个文档，
在对话里按 `j`/`k` 而焦点不在输入框时也会被阅读器接管。

### 4.2 侧栏座位：`sidebar.panellist` 的 id 必须同名于 `main` 的 key

注册项只有 `id/order/label`，没有「开右栏」的口子；缺 main 条目**点选即抛错**。
试过两次别的形态都被否决并移除：① `sidebar.footer.action` 底部入口；
② 把 `main` 做成转发器开进右栏（实测转发不生效）。

### 4.3 徽标座位必须显式 `priority: -1`

`sidebar.toggle.badge` 是 **single** 且已被官方 `DesktopUpdateIndicator` 以默认优先级 0 占用；
slots 规则是「同一 cell **同优先级**的第二次注册直接抛错」
（`ui-slots/src/index.ts:1134-1140`），而「cell 内**最低**优先级的条目渲染」。
默认优先级注册 = 抛错并炸掉 client 半（实测）。代价：桌面版会顶掉官方更新提示点
（Web 上官方那个本来就不渲染，无损失）。

### 4.4 浏览器半 ↔ 主进程半的通道

**不**走 `ctx.connection.rpc.handle`：它把 owner 绑定到 connection 插件自己的 ctx，
而那个 ctx 解析不到 `webServer`，实测抛 `cannot get property "webServer" without inject`，
且全仓库无产品插件使用它。
本插件用 `ctx.webServer.register({kind:'prefix', path:'/rss-reader-api'})`，
handler 里调 `ctx.connection.requestRejection(req)` 套用**同一套** Host/Origin 与浏览器鉴权。

### 4.5 入口必须导出 `Config`（schema 本体）

宿主/注入器靠它给 config 补默认值。漏了它，注入路径下配置全字段 undefined ——
抓取在 `AbortSignal.timeout(undefined)` 上抛错、正文缓存闸门把缓存整份清空、
清理端点抛 `RangeError`。插件现在也会在 apply 首行自己解析一次并留诊断日志，但那是**兜底**，
不该被当成理由。

### 4.6 热重载的两个坑

- **可能留下上一代的 HTTP 路由**：新一代注册撞 `duplicate prefix route` 后插件直接不可用。
  `webServer` 没有「列出/注销路由」的公开 API，插件无法自救。恢复：
  `dev_clear_routes {prefix:'/rss-reader-api'}` → `dev_inject_plugin`（或重启 DSH）。
- **存储域会撞 `already-open`**：已有有界接管（`openDomainWithRetry` + 孤儿句柄回收），
  日志写「上一代 fiber 遗留域句柄（无持有者），接管并关闭」。

### 4.7 注入器写死 `config: {}`

`dsh-super-injector` 的 `loader.create` 永远拿 schema 默认值 ⇒ 订阅源不能只靠 Config，
**必须以存储域为准**。

### 4.8 `storageDomain` 域名/表名约束

必须匹配 `^[a-z][a-z0-9_]*$`（连字符非法，故用 `rss_reader`）。
**域 disposer 必须返回 `close()` 的 promise**：写成 `void domain.close()` 会让「卸载完成」
跑在域真正释放之前。

---

## 五、数据与解析

### 5.1 条目身份会「分叉」，且分叉是**写进存储的**

**病象**（用户实测「同一篇文章两条」）：本机库 162 条里 **40 组**重复（爱范儿 20、云风 15、
土木坛子 5），每组两条同一 `feedId`、同一 `link`、只是 id 不同；老的带已读态、新的未读，
未读计数虚高。
**根因**：身份按「源 id → 链接 → 标题签名」派生，而**依据本身会变** ——
爱范儿的 guid 从 `?p=1682933&utm_…` 换成永久链接、土木坛子是 `?p=17644` → `/archives/17644`、
云风（Atom）换了 entry id 写法。
**修法**（三处缺一不可）：
① **候选身份表** `itemIdCandidates`；② **落库前认回** `resolveItemIds` 的 known 索引
+ `corroborates` 旁证；③ **存量合并** `identity-repair.ts`（打开域时跑，幂等）。
留痕：「认回 N 条老身份」写进刷新摘要。
**⚠️** 别把「撞车退级」改回用源给的 id（`demotedCandidates`）—— 退完还用同一个 id 等于原地踏步。

### 5.2 去重窗口 ≠ 保留量

`maxSeenPerFeed`（默认 5000，只存 id）远大于 `maxItemsPerFeed`（默认 500，入 items 表）。
窗口若跟着保留量一起截短，被裁掉的老条目会在下次抓取时**重新变成未读**。

### 5.3 正文：取更长的那一份 + 抽取器版本必须同行

**病象**：正文拿到的比源里能给的少得多。
**根因**：同一份 feed 里 `content:encoded` 常常是全文、`description` 只是摘要；旧实现固定摘要优先。
**修法**：解析层取「去掉标签后更长的那一份」。实测 GitHub Blog 10 条从 2,346 → **127,522 字符**。
**缓存闸门**：正文缓存进 items 表，命中要求版本相等 ⇒ **`EXTRACTOR_REVISION` 与抽取逻辑必须同文件**
（`src/article.ts`）。上一版写死在 `endpoints.ts`、与逻辑分居两地，正是它漂移的原因
（病象：改了抽取规则但已缓存文章永远显示旧块）。`tests/article.test.mjs` 有断言钉住
「endpoints 不得再写死数字」。

### 5.4 正文容器识别：先认容器、再抽块

**病象**：正文里混进站点头像、页脚二维码。
**根因**：在整页范围找块 —— 这类图**没有任何可判别的 URL 特征**，逐条规则注定漏。
**修法**：`pickContentRoot` 只看容器自身的可测量形状（文本量 × 非链接占比 × 段落占比加成），
不看 class 名、不猜路径关键词；三层兜底保证最坏情况是「回到改动前的样子」。
**实测效果**：少数派 iPhone Duo 图片块 28 → 18、爱范儿 Surface 30 → 23，正文段落一字未少。
**仍缺**：正文里的超长截图（客户端图片限高兜住）、按站点清文末相关阅读（样本不够，未定判据）。

### 5.5 `htmlEntities: true` 不能省

fast-xml-parser 默认不解数字字符引用，`&#8217;` 会原样留在正文里（实测）。

### 5.6 图片的三条要点（`pickImageUrl`）

① **懒加载属性优先于 `src`**（真实站点常把 `src` 写成占位图甚至 1×1 gif，真地址在
`data-src` / `data-original`）；② **`srcset` 取描述符最大的候选**，优先于 `src`；
③ **只放行 http/https**（`data:` 可能是跟踪像素、`javascript:` 是注入面）。
**另注**：图片无固有尺寸是 §3.3 那个 bug 的成因之一。

### 5.7 块顺序按文档位置重建

各类块是分批处理的，边处理边入列会得到"处理顺序"（实测段落被挤到末尾、图片跑到最前）。

---

## 六、产品侧决定（改动前先看，别当 bug 改回去）

- **`j/k` 在列表页只移动选中、不标已读；在正文页切文章、标已读**。已读只由「打开条目」触发，
  四条打开路径语义一致（列表点击 / `o` / `V` / 正文页 `j``k`），另有显式 `m` 反选。
  这对应 **Google Reader 的 list view 语义**，是有意选择。
- **`v` 与 `V` 是刻意区分的一对**：`v` = 系统浏览器打开原站，`V` = 阅读器内读正文。
  别把 `v` 改回不标已读。
- **不做内嵌原站页面（iframe）**：两条路都不可接受 —— 严格沙箱 ⇒ 现代站点只剩裸 HTML
  （实测 `sspai.com`）；放宽沙箱 ⇒ 发布者脚本跑在 DSH 页面上下文里。正文只走抽取视图，
  看原样走新标签页。`frameable` 现在只作诊断信息保留。
- **未读筛选下「钉住当前条目」**：「打开即已读」与「未读筛选」天然冲突，规则是当前选中的条目
  即使已读也保留在列表里，移开即让位（用整表过滤，不会跳到列表首尾）。
- **星标不是永久保存**：裁剪排序是「发布时间，缺则抓取时间」；星标与未读不再被**自动**删除，
  但显式清理之外的**自然裁剪仍会删已读条目** —— 容量与历史的取舍。
- **键盘两条正交轴**：`j/k` = 换条目，`n/p` = 看不动（滚动视野但不改选中），
  `空格`/`d`/`u` = 整屏/半屏翻页。

---

## 七、还没做的（需决策）

- **8 条规格债**（`docs/google-reader-feature-spec.md` §6 的路线图）：kept-unread 语义、不变量 2 的
  重复 id/URL 兜底、expanded/list 两视图与 `1`/`2` 键、auto-discovery、mark-all 时间阈值、
  未读计数可隐藏 + `r` 刷新计数、不变量 1 与规格对齐、正文面补验收清单。都属**新功能**，
  建议从 kept-unread 起（要动 domain schema，越早做迁移成本越低）。
- **独立安装（锁文件）与 CI**：同一件事 —— 没有锁文件就没有 CI。

## 八、待验证 / 遗留

- **平滑滚动动效**：可行性已分析（ease-in-out + 仅按钮 + 可中断 + `prefers-reduced-motion` 回退），
  用户决定暂不做。风险点留档：动画会与 9 处写 `scrollTop` 的入口抢写，必须可中断。
- **DNS rebinding 的 TOCTOU**：解析层拦了「域名解析到内网」，但解析与连接之间有时间差；
  彻底封死要自定义 dispatcher（引入 undici），评估后不做。
- **内网自建 RSS 源**：可用（`trustedTarget`），但只对**第一个请求**生效，重定向目标一律不可信。
- **`articleRecordSchema.paragraphs`**：schema 仍声明它（只为兼容读）。删不掉的两条路都实测过：
  版本号在 single layout 下硬相等（升版直接打不开域）、`backup-and-skip` 会连带丢掉用户已读态。
- **独立安装（锁文件）与 CI**：同一件事 —— 没有锁文件就没有 CI。
