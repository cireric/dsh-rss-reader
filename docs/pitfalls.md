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

**两个时长陷阱**（`实测`，2026-11-13，208 条）：

- **单个 worker 跑不完一整轮**：`WORKER_BUDGET_MS = 15min` 到点就回收 worker、剩余条目全记
  「worker 超预算」。client 族每条都要重跑一次 scroll-dom 全集（本机实测 **12–13s/条**），208 条
  合起来约半小时 ⇒ 内存跌破 6 GB 只能上 `--workers 1` 时，用 `--mutations '<id1>,<id2>,…'`
  分 3 批跑（每批各自校验基线，覆盖不减少）。`--workers` 只改并发，**分批才改总时长**。
- **别把日志文件当进度条**：`nohup … > log` 时 worker 的逐条输出不落进那个文件（只有前几条
  主线程打印可见），看着像「卡在第 2 条」而其实一直在跑。判断进度看 worker 副本里
  `diff <worker>/lib/client.js <源>/lib/client.js`（每换一条锚点就变），或者前台跑。
  本次因此白杀了两次全量跑。

### 1.4 变异条目的 `from` 要照编译产物的实际形状写

**病象**：变异报「**未应用**」。
**根因**：产物是多行 `if`、单引号、`??`；照源码格式写模式就匹配不上。
**为什么比幸存更隐蔽**：幸存至少说明这条变异跑了，未应用等于**这条根本没跑**。
**修法**：先 `grep` 产物的真实形状，再写 `from`。本次实测踩到两条。

### 1.4b 客户端 bundle **内联**了一份 `src/preferences.ts`（不是 import）

**病象**（`实测`，2026-11-21 R6 评审修复轮）：给 `client-默认值写成折叠`（`file: 'lib/preferences.js'`）
补上 `scroll-dom.test.mjs` 当 judge，期望「把默认值翻成折叠 ⇒ 验收 1 的 DOM 用例翻红」。
结果门槛报 **survived**，而单独把 `lib/client.js` 里那份改成 false，同一条 DOM 用例**当场红**。

**根因**：两层叠加。
1. `lib/client.js` 是 tsdown 的单文件产物，它把 `src/preferences.ts` **整份内联**了
   （`//#region src/preferences.ts`，默认值在 `const DEFAULT_READING_PREFERENCES` 里）。
   `lib/preferences.js` 是 tsc 的另一份产物，**客户端根本不 import 它** ⇒ 改它碰不到 DOM 用例
   跑的代码。同一个源码默认值因此有**两个产物副本、两套字节**（tsc 用 4 空格 + 尾逗号
   `    expandImages: true,`；tsdown 用 3 个 tab + **无尾逗号** `\t\t\texpandImages: true\n`）。
2. `judgeTests` 的 pattern 会作用到**所有** judge 文件（`suite.mjs` 把 patterns 拼进同一条
   `node --test` 命令）⇒ 给这条加了只存在于 scroll-dom 的测试名之后，nav-persistence /
   store-sqlite 里一条都匹配不上（详见 §2.14），host 侧反而**失去守门人**。
   实测：加进去之后套件从 5 条红变成 0 条红，变异直接幸存 —— **修判据缺口的动作把判据删了**。

**修法**：一个源码默认值 = 两条变异，各守自己那份产物，`judges` / `judgeTests` **不许混**：
- `client-默认值写成折叠` → `lib/preferences.js`，judges 只留 host 侧的
  `nav-persistence.test.mjs` / `store-sqlite.test.mjs`；
- `client-默认值写成折叠（bundle 副本）` → `lib/client.js`，judges 只留 `scroll-dom.test.mjs`，
  judgeTests 指向验收 1 那条用例。

**一般规则**：凡 `src/` 里被**客户端**消费的模块（`preferences.ts` / `image-fold.ts` /
`list-scroll.ts` / `shared.ts` …），`lib/<name>.js` 与 `lib/client.js` 里各有一份产物。
变异要打在**跑判据的那一份**上：DOM / bundle 判据读 `lib/client.js`，host 判据读 `lib/*.js`。
写变异前先问一句「这条判据跑的是哪份产物」，再看那份的字节形状。

### 1.5 改文件前必须用 read 读过它

批量改写要用**锚点唯一**的替换，别用会跨段吞噬的惰性正则 ——
本仓库有过把客户端入口 import 块整段删掉、bundle 从 178KB 掉到 56KB 的事故。

### 1.6 依赖不是 `npm install` 来的

`scripts/build.sh` 每次从 dsh 源码 checkout **现链**（依次探测 `$HOME/dsh-harness`、
`$HOME/dsh`、`$HOME/.dsh/dsh-harness`、`$HOME/deepseek-harness`，都不命中就给
`DSH_CHECKOUT=<path>`）。**本仓库没有锁文件** ⇒ 不可独立安装、进不了 CI。

**宿主升级会换掉链接目标**（`实测`，2026-11-16）：旧实现只链 `.pnpm/<pkg>@<ver>/…`。宿主从
`dsh-v0.2.1-rc.5` 换到 `dsh-v0.2.2-rc.3`（reflog：19:00:10）时，`pnpm install` 把 zod@4.4.3 从 store 删掉，`node_modules/zod` 变成
悬空链接；Node 的 ESM 解析把悬空链接当「找不到包」，于是**构建期毫无动静、装载期才炸**——
`Cannot find package 'zod' imported from lib/endpoints.js`，entry 572f7815 变 no-fiber，
所有 import `lib/` 的测试同时红。
**修法**：`link_pnpm` 优先链 checkout 顶层的中间层 `node_modules/<pkg>`（pnpm 每次 install 都会
重写它，指向新版本），只在顶层没有时才回退 `.pnpm`；`link_pkg` 加「链接后必须解析到
package.json」的硬断言，让悬空链接在构建期就失败。
**判据**：升级宿主后重跑 `npm run build`（断言不过即红）；再跑
`node --input-type=module -e "await import('./lib/index.js')"`，应打出
`Config,apply,inject,name`。

### 1.7 客户端 bundle 不许引第三方库

除 `tsdown.config.ts` 的 `neverBundle` 之外的东西都会被真打进 bundle，需要什么就自带实现。

### 1.7b 客户端 bundle 也不许引 node 内建 —— `article.ts` 不是 node-free

**病象**：把「client 与 host 共用」的纯函数放进 `src/article.ts`，`npm run typecheck` 与 `npm run build:client`
**都成功**，而 `lib/client.js` 里多出 `require("node:crypto")` —— 浏览器里一调用就炸。

**根因**：`article.ts` 顶部 import 了 `node:crypto`（`contentVersionOf` 的 sha256）与 `feed/fetch.js`
（后者 import `node:dns/promises` 做 SSRF 检查）。它看起来是「块模型的家」，实际是 host-only 模块。
`tsdown` 的 `platform: 'browser'` **不会**因此失败：它把 node 内建原样留成 `require("node:crypto")`
（`实测`，同形最小载荷）。失败被推迟到运行期。

**为什么最终仍会被抓到**：`tests/client-bundle.test.mjs` 的 `require` 桩是 **deny-all 白名单**
（只认 `react` / `react/jsx-runtime`，其余一律 `throw new Error('未预期的外部依赖：' + specifier)`），
所以 `node:crypto` 会在 `factory(require)` 那一刻抛错（`实测`，同形载荷得到
`未预期的外部依赖：node:crypto`）。**这条守护是隐式的**——它没有专门断言「不许引 node 内建」，
而是靠白名单的副作用；错误信息也指向「外部依赖」而不是「node 内建」，排障时容易看错方向。

**修法**：任何 client 也要用的纯函数放零 node 依赖的模块（`article-text.ts` / `html-text.ts` / `shared.ts` /
`preferences.ts` / `retention.ts` / `cursor.ts` 都是），`article.ts` 对它们 re-export 保持既有 import 不破。
`src/client/article-pane.tsx` 只 import `shared.js` / `html-text.js` / `list-scroll.js` / `preferences.js`。

**判据**：现有 `client-bundle` 的 deny-all 桩已经兜住（隐式），**不必再加一条同义的显式断言**
（按「等价变异不入门槛」，重复守护不增加信息）。手工核对：
`grep -o "node:[a-z/]*" lib/client.js | sort -u` 应无输出。

### 1.8 验证按「轮」跑，不按每次编辑跑

**病象**：一轮 10 次编辑，每次改完都跑一遍完整门槛 ⇒ 约 76 分钟花在同一次测量的重复求值上。
**根因**：门槛对历史没有记忆 —— 每条变异都是「读当前 `lib` → 改一处 → 跑满全套件 → 还原」的
纯函数，所以同一轮里第 N 次跑的结果已经包含前面每一次的结论。
**修法**：编辑期间只 `npm run build` + 受影响的单个测试文件；四条验证留到本轮收尾跑一次。
**实测**（2026-10-10）：79 条变异 = 81 次 `node --test` 调用，单次约 5.4 s，完整一轮 453 s。
这两个数随测试集变化（当天就改过清单），别当固定值用。

### 1.9 变异门槛与测试在并发下不可信 —— 判「基线红了」之前先排掉这两条

2026-10-11 大规模存储计划在**任务 3 与任务 7** 上**两次**踩到同一类假红，都由**并发**引起，
与被测任务无关（任务 6 无此类事故 —— 它那轮只跑定向差分与单任务门槛，不与其他任务并发）。
两条判据：

- **残留变异污染 `lib/`（gitignore 的构建产物）⇒ 不相关套件稳定假红。**
  一次门槛跑完后 `lib/` 里留着一处变异过的字符串（脚本没还原干净，或被硬杀），
  于是之后任何 `npm test` 都在测那份改坏的产物 ⇒ 一条与当前任务毫无关系的**稳定**失败。
  **排法**：把 `lib/` 与一次全新 `npm run build` 的结果对照，或直接在从 `src/` 重建的
  隔离副本里重跑。§1.3 要求在隔离副本跑门槛，正是为了不再污染工作树的 `lib/`。
- **并行 `node --test` 让基于 sleep 的 jsdom 计时断言变脆。**
  串行稳定，并行偶发失败（多个测试文件同时抢 CPU，`await delay(n)` 那类定时断言被饿死）。
  **排法**：基线红先**串行**重跑一遍再下结论 —— 这是判定「真红还是假红」成本最低的一步。

**一般化**：**任何一条与「刚改的那几行」无关的稳定失败，先怀疑环境（残留产物 / 并发），再怀疑代码。**
「这条红是不是我的」是要**先证伪**的假设，不是事后要解释的意外。

### 1.10 变异门槛会把**整机**拖死：进程数没有上限，而这台机器没有 swap

**病象**（`实测`，2026-10-15 起三次）：跑 `npm run mutation` 期间整机失去响应（鼠标卡顿、
风扇满转、最后要么硬重启要么等十几分钟自愈）。加 `NODE_OPTIONS=--max-old-space-size=4096` 无效。

**根因**：门槛限制的是「变异条数并发」（K），**从来没有限制进程数**，两者相乘之后是几十个 node：

- K 默认 `min(6, cpus-2)` = **6**（本机 10 核）；
- 每个 worker 里 `execSync('node --test …')`，而 `node --test` 的**文件级并发默认 = availableParallelism() = 10**；
- 合计 ≈ 1 主进程 + 6 worker 线程 + 6 ×(1 runner + 10 文件) ≈ **60+ 个 node 进程**；
- 每个 node 默认堆上限 **4288 MB**（实测 `v8.getHeapStatistics().heap_size_limit`，与有没有传
  `--max-old-space-size` 无关 —— 所以调 NODE_OPTIONS 不改变这条）。

本机真正的放大器是**没有 swap**：`sysctl vm.swapusage` 恒为 `total = 0.00M`、
`/System/Volumes/VM` 里 0 个 swapfile。内存一旦超过物理量，macOS 无处可换出，
只能靠 compressor 压缩，而压缩又吃 CPU —— 进入「压缩 → 变慢 → 更多未回收 → 更压」的死亡螺旋。
历史现场（`实测`，`/Library/Logs/DiagnosticReports/`）：2026-10-16 一晚 **14 个 JetsamEvent**，
`largestProcess` 全是 `node`（单个 2329 MB + 1313 MB，其余 20+ 个各 150–290 MB），
kill reason 全为 `vm-compressor-space-shortage`；紧接 00:24 一次 panic + shutdown stall。
`NODE_OPTIONS` 解释不了它：那是**整台机器的内存**被吃光，不是某个 V8 堆越界。

**修法**（`scripts/mutation-test.mjs`，四道闸，全部只压上限、不压按需）：

1. **worker 数由宿主算出**：`min(6, cpus/3, 内存GB/4)` ⇒ 本机 3（旧的固定 6 给到 6）；
2. **套件内文件级并发封顶**：`node --test --test-concurrency=<cpus/3，上限 4>` ⇒ 本机 3
   （实测单套件 7s → 8s，可忽略）；
3. **每个套件子进程带堆上限**：`--max-old-space-size=1024`，且**先摘掉继承来的那一份**
   （`NODE_OPTIONS` 会被 `execSync → node → node --test` 三层原样继承，实测父设 4096 时孙进程也是 4288）；
4. **低内存看门狗**：worker 每 3s 探一次可用内存（`vm_stat` 的 free+inactive+speculative），
   跌破 512 MB 立刻 `worker.terminate()` 并把该 worker 的变异记「崩了」——
   判定无效可以重跑，整机死机不能。

5. **显式 `--workers` 同样受闸**（自审轮补）：它是绕过 `defaultWorkers` 的唯一入口，
   放任 `--workers 8` 就等于闸门形同虚设；超上限时明确打印「已夹到 N」，不静默改数。

修后实测：整轮 gate **163s**（旧约 4 min）、峰值可用内存 **≥ 3498 MB**、152 条变异 0 崩 / 152 抓 / 0 幸存。

**踩过的坑（别再走一遍）**：

- **别用 `os.freemem()` 当水位**：macOS 上它只数 `Pages free`（实测 1546 MB，而 free+inactive 是 5319 MB），
  空闲内存大半躺在 inactive/file cache ⇒ 看门狗在套件刚起步时就误触发，实测把 138 条全判成「崩了」。
- **`execSync` 的超时只杀直接子进程**（实测 `ETIMEDOUT` 后孙进程树立刻消失，不算孤儿进程），
  但**超时那次 `node --test` 已经跑掉的变异不会被重跑** —— 超时是判据失效，不是「没发生」。

**判据**：`tests/mutation-runner.test.mjs` 的「宿主资源闸」一条钉住四处锚点
（`--test-concurrency=`、摘继承堆上限、`HOST_FLOOR_MB`、`defaultWorkers` 存在），
并禁止退回固定 `os.cpus().length - 2`。

### 1.11 host / client 两个工程的类型边界：DOM 类型只能出现在 client 工程

**病象**（2026-11-13 实测）：`npm run typecheck` 在 **tsc 7.0.2** 下红 ——
`src/list-scroll.ts(84,55): error TS2304: Cannot find name 'HTMLElement'`；同一棵树换 **tsc 6.0.3**
却是绿的。两个版本都在干净 HEAD 副本上复现过，所以不是「本次改动引入的」。

**根因**：共享文件 `src/list-scroll.ts` 的类型谓词写成了 `node is HTMLElement`。host 工程的
tsconfig 只有 Node 类型（`lib: ["ES2023"]`、`types: ["node"]`，没有 DOM），而这个文件同时被
host 与 client 两个工程编译 —— 类型谓词必须引用 DOM 全局名，host 侧就必然解析不到。
它同时违反该文件自己写下的不变量：「list-scroll.ts 之所以能被 host 编译，正是因为它刻意不碰 DOM」。

**修法**：共享文件只保留**运行时**判定 `isElementNode(node): boolean`（判据仍是 `nodeType === 1`，
不依赖环境全局 ⇒ 跨 realm / 跨 iframe 行为不变）；DOM 类型谓词移到
`src/client/element-node.ts`，内部调同一份运行时判定 —— 判据仍然只有一处。
**别用「给 host 加 DOM lib」绕过**：那会让 host 侧悄悄允许 `document`/`window`，是拆掉护栏而不是修边界。

**判据**：两个编译器 × 两个工程四次编译全绿（`tsc -p tsconfig.json` 与 `-p tsconfig.client.json`，
分别用 PATH 的 7.0.2 与 checkout 的 6.0.3）；`tests/list-scroll.test.mjs` 仍按布尔断言（运行时判据不变），
`tests/scroll-dom.test.mjs` 的真实键盘用例全绿。**新代码改完两个编译器都要跑一遍** —— 只跑一个会漏掉这一类。

### 1.12 `npm run build:client` 在本机需要一个不在 link 列表里的 tsdown

**病象**（2026-11-13 实测）：`npm run build:client` 直接 `sh: tsdown: command not found`；
跳过它则 `tests/client-bundle.test.mjs` 的「产物不能过期」当场翻红（那条守卫是对的，别去放宽它）。

**根因**：仓库没有锁文件，依赖由 `scripts/build.sh` 从 DSH checkout 现链（见 §1.6），
而 `link_pkg` 列表里**没有 tsdown** —— 它只活在 checkout 的 `node_modules/.bin` 里。

**修法**：`PATH=<checkout>/node_modules/.bin:$PATH npm run build:client`。不要为这件事在仓库里
装依赖或加锁文件（那是 §1.6 明确不做的方向）。

**判据**：产物 mtime 晚于 `src/client/**`，且「产物不能过期」那条用例转绿。

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

### 2.5 桩 fetch 必须按 endpoint 各守各的返回值形状

**病象**：改动 `applyOverview` 后 `tests/scroll-dom.test.mjs` 一次红 10 条，报
`Cannot read properties of undefined (reading 'filter')` —— 看上去像 `visible()` 的 bug。
**根因**：那 10 条的面板挂载会走 `store.load('refresh')`（`index.tsx:184` 的「打开面板即刷新」），
而桩里 `refresh` 与 `overview` **不是同一个分支**，`refresh` 掉进了兜底
`ok({ changed: 1, unread: 0 })`；于是 `applyOverview` 收到一个没有 `items` 的信封，
把 `state.items` 写成 `undefined`。既有实现恰好只读 `overview.items[0]?.id`
（全 undefined 也不炸），所以这个桩件缺口**沉寂了很久**，直到有人动这行才爆。
**修法**：桩里 `refresh` 与 `overview` 一样回**完整 Overview**（宿主契约见
`src/endpoints.ts:112-118`，两条都走 `buildOverview`）。
**⚠️ 别在作品代码里加 `Array.isArray(overview.items)` 之类的守卫去容忍它** ——
那正是「弱化作品代码去容忍桩件缺失」，本仓库明确不选这条路（2026-10-10 评审裁定）。
**判据**：桩件改对后 205 全绿；把桩件改回旧形状，那 10 条立刻重现。

### 2.6 桩件的派生数据要守它模仿的那条契约

**病象**：三处桩各有自己的 `perFeedUnread` 语义（一处按 feeds 表铺 0、两处只给未读 > 0 的源发键），
而缺键的表现是「角标空白 vs 角标 0」，界面上**无从分辨**。
**根因**：照 `items` 派生比照 `feeds` 表铺 0 写起来短，于是各写各的。
**修法**：封装**一份** `overviewStub(items, feeds)`，显式按 feeds 表铺 0 再累加
（`tests/client-bundle.test.mjs` 与 `tests/scroll-dom.test.mjs` 各一份，注释里写明契约来源）。
**⚠️** 桩件不守契约时，别指望被测代码替它兜底。

### 2.7 「未应用」比「幸存」更隐蔽 —— 修它之前先确认有判据会翻红

**病象**（实测）：变异门槛报「应用 54/55 条 · 幸存 1 条」，而那 1 条被标成**未应用**，不是幸存。

**根因**：`from` 是照**源码**猜的，产物里没有这个子串（成因见 §1.4）。脚本的替换是
`original.replace(from, to)`，替换前后文本相同就跳过并计入「未应用」——它**根本没改过产物**。

**为什么比幸存更隐蔽**：幸存说明这条变异跑过了、只是没人喊，指向的是「测试有缺口」；
未应用等于**这条守卫一次都没跑**，你手上那份「全绿」根本没有覆盖它。两者的修法也不一样。

**修法**：修未应用时**不要只改字符串**。先把 `from` 照编译产物的真实形状改对，
再确认**存在一条会因该变异而翻红的判据**；缺哪条就补哪条。只改字符串的后果是把
「未应用」换成「幸存」——门槛从「没跑」变成「假绿」，比原来更难发现。

**实测**（2026-10-10，两列布局任务 3）：`client-折叠时左栏仍渲染` 这条变异修好 `from`
（`state.navVisible && /* @__PURE__ */`，在产物里唯一）后确实应用了，但**任务 3 原有的三条
左栏用例全部工作在「默认展开」下、从不折叠** ⇒ 该变异在只跑原有用例的套件里静默幸存。
补一条折叠用例（`tests/scroll-dom.test.mjs` 的「折叠左栏：容器整个从 DOM 消失」）后才翻红 3 条。
**反事实**：把该用例摘掉、对产物施加同一变异 ⇒ **0 条翻红**（14 pass / 0 fail），变异静默幸存。
**判据**：该用例在时变异 3 条翻红；摘掉后 0 条翻红（两者都实测过）。

### 2.7b 崩溃式变异是**假通过**：门槛报「被抓到」，实际一条断言都没看见缺陷

**病象**（实测，2026-10-11 任务 9 修复轮 2，评审抓出）：变异门槛报「应用 + 被抓到 · 幸存 0」，
而那条变异的 `to` 引用了一个**不在作用域内**的名字（`urls` 是 `refreshFeeds` 的参数，
却用在了 `capArticleCache` 体内）⇒ 变异一应用就抛 `ReferenceError: urls is not defined`。
套件当然红（7 条），但**那 7 条全都是同一个 ReferenceError**：没有任何一条断言真的观察到
「淘汰名单退回了按源」。判据当时**完全没被保护**。

**为什么比「未应用」（§2.7）更隐蔽一层**：未应用是「没跑」，门槛会明确标出来；
崩溃式变异是「跑了，而且红了」，汇总里与真正的捕获**长得一模一样** ——
幸存者计数为 0、这一行写着「被抓到」，没有任何信号提示你判据没被碰到。

**同一类事故已踩三次**（一次比一次隐蔽，所以必须固化）：
① 任务 9 第一版：`to` 里写了产物**没有 import** 的函数名 ⇒ SyntaxError；
② 任务 9 第二版：`to` 里引用了**作用域外**的变量 ⇒ ReferenceError（本条）；
③ 任务 9 第三版才是对的。①②两次都是「红，但不是被抓住」。

**修法**：写完一条变异后，验证方式必须是**逐条看翻红的是哪几条**，而不是只看计数：
在**隔离副本**里套上变异跑 `node --test <相关文件>`，然后确认
  · 输出里 `ReferenceError` / `SyntaxError` / `is not a function` 出现 **0** 次；
  · 翻红的测试名**就是**你预期的那几条判据（而不是整个文件整体崩掉）。
两者都满足才算「被抓住」。**`ℹ fail N` 的 N 单独不足为据** —— 它对「崩溃」和「断言失败」一视同仁。

**判定记号**：变异门槛的汇总**已有第四态「崩了」**（`scripts/mutation-test.mjs` 的崩溃分类器，
2026-10-11 终检修复轮加入）。它在错误行**前后各 6 行**内找**被改过的那个文件名**，找到就单列成
「崩了」并计入失败清单（`survivors`）。三个判定细节都是实测逼出来的，改这条判据前先看
`scripts/mutation-test.mjs` 的 `crashed` 那一段：

  ① **匹配的是文件基名**，所以栈帧里带产物名就够 —— 而 **`vm.runInContext` 不给 `filename`
     就永远匹配不上**（帧上是 `evalmachine.<anonymous>`）。修前 client 组的 50 条变异全属这一族：
     `实测`在 `lib/client.js` 末尾注入一个 ReferenceError ⇒ 套件 `ℹ fail 91`，而门槛判
     「未崩」= 把崩溃当成「被抓到」。修法是**在四个加载点补 `{ filename: BUNDLE_NAME }`**
     （`client-bundle.test.mjs` 的 `BUNDLE_NAME`，另三处同源）。**新增 vm 加载点照抄那一行。**
  ② **错误名必须带 TAP 缩进**（`^\s+ReferenceError:`，不是 `^\s*` 更不是 `\b…\b`）：
     client 在**正常路径**上会**记录**（不是抛出）`[rss-reader] 读取视图记忆失败…ReferenceError:
     fetch is not defined`；而**合法**变异 `client-守卫改回环境全局` 会让按键处理器在 jsdom 的事件
     派发里抛 ReferenceError、被 jsdom 原样重播到**列 0** —— 两者都只在列 0 出现，而它们都有断言
     在正常判红。真正的加载期崩溃一律缩进两格。
  ③ **窗口必须向两边各取 6 行**：ReferenceError 把文件名印在错误行**后面**的栈帧里，
     而 vm 编译期的 SyntaxError **没有栈帧**、文件名印在错误行**前面**的源码回显里。

⚠️ **这条分类器一修好就当场抓出两条真正的假通过**（都在 client 组）：
  · `client-左栏角标无视 showUnread` 的 `to` 少了展开运算符 `...` ⇒ 产物**加载期**语法错、
    整个 client 组一起红 —— 而它此前一直记在「被抓到」里。
  · `client-守卫改回环境全局`（这条是**合法**变异，`to` 没写错），由 ② 的判据正确放行。
**教训**：门槛报「幸存 0」不等于判据被保护；分类器覆盖不到的那一族，假通过会一直躺在汇总里。

---
### 2.8 不要把 jsdom 节点本身交给 `assert.equal`

**病象**（实测）：变异确实被抓到了，但失败信号是**文件级 SIGKILL —— 31s、TAP 里只剩一条
`✖ tests/scroll-dom.test.mjs`，零断言消息**。在变异门槛里表现为
「被抓到（3 条翻红：✖ tests/scroll-dom.test.mjs）」，**看不出是哪条守卫在喊**。

**根因**：`assert.equal(querySelector('[data-rss-nav]'), null)` 在**断言失败时**会把实参交给
node 的 `inspect` 去渲染错误消息，而 inspect 一个 jsdom 元素（巨大、循环引用、getter 成堆）
会一路跑到超时，进程被 SIGKILL —— 于是断言自己的文案永远打不出来。

**修法**：**先取布尔量，再断言布尔量**：

```js
const navPresent = () => h.win.document.querySelector('[data-rss-nav]') !== null
assert.equal(navPresent(), false, '折叠必须把左栏整个从 DOM 移除')
```

关键是**别让节点本身成为 assert 的实参**（成功路径下不会触发，所以这条只有在变异、也就是
「断言本来就会失败」的时候才现形 —— 这正是变异门槛要天天走的路径）。

**修后实测**：同一条变异 400ms 干净翻红，并带出断言文案
（`✖ 折叠左栏：容器整个从 DOM 消失（不是 width:0 留一条缝）` + `AssertionError: 折叠必须把左栏整个从 DOM 移除…`）。
**判据**：变异下断言消息可见（修前不可见）。

### 2.9 表达「并发乱序」的桩件不许用「已落库条数」当序号

**病象**（实测，2026-10-10 两列布局任务 7）：为「写盘必须串行化」写了一条用例，桩件按
`prefs.writes.length` 取「第几次请求」的延迟，注入变异「去掉串行化（`viewWriteChain.then(...)`
→ 直接 `callRpc(...)`）」后套件**仍然全绿** —— 该变异静默幸存。

**根因**：`writes` 只在**响应落库后**才 `push`。两个请求同时在飞时，第二个到达时
`writes.length` 还是 `0`，于是两次拿到**同一个延迟**。「后发先到」这个被测形态在夹具里
根本无法表达 —— 被测的守卫没错，是夹具没造出它要防的那种时序。

**修法**：序号在**请求到达时**取（`prefs.arrived += 1`），不是落库后。

**判据**：同一变异下修前 0 条翻红、修后 3 条翻红（两者都实测过），翻红的是
`tests/nav-persistence.test.mjs` 的「写盘串行化：前一次慢、后一次快时，最终的记忆是后一次动作」。

**一般化**：夹具里凡是「按第几次调用」定制行为（延迟、失败、返回值），计数器必须在**调用进入**时
递增。用「已完成的数量」当序号，等于假设了调用是串行的 —— 而那正是被测代码要保证的事，属于循环论证。

### 2.10 多个连续守卫 + 不区分的输入 ⇒ 假绿

**病象**（实测，2026-10-11 大规模存储任务 6）：游标分页的游标解析器上串着一串守卫
（空串 / 纯 token / 前导竖线 / 字段数不对 / 每段格式 / **ISO 时刻合法性**）。
第一轮门槛里「删掉 ISO 时刻合法性校验」这条变异**活了下来**。
**根因**：套件用过的每一个坏输入 —— 空串、裸 token、前导 `|`、缺字段 —— **早已被更靠前的守卫挡掉**，
根本走不到时刻那一层。于是那一整层校验可以整段删掉而套件仍然全绿：
每个负向用例都在「测校验器」，实际测的是**第一个碰到的那个守卫**。
**修法**：给带多道守卫的校验器写负向用例时，**每个坏输入必须只被目标检查拒**。
动手前先逐个问「这条输入能不能穿过前面每一道守卫」，构造不出就说明这条用例没用。
本仓库的做法：造一个「结构完全合法、只有时刻不合法」的游标（例如把 `2026-10-11` 写成
`2026-13-45`），它必须只被 ISO 校验拒 —— 补上后该变异**两次都被抓**（`实测`，任务 6）：
① **定向差分**（隔离副本里只应用这一条变异）：基线 6 pass / 0 fail → 变异后 **6 tests · pass 4 · fail 2**，
翻红的是「游标编解码：格式 "<recency>|<id>"，认不出的必须返回 undefined」与
「overview：游标认不出时响亮拒绝（bad-request）」，还原后回到 6/6；
② 随后**第二轮整套门槛**复跑：124/124、幸存 0，该条 5 条翻红。
（两个数不同是因为范围不同：① 只跑受影响的那两个文件，② 跑全套 —— **写「几条翻红」必须带范围**。）
**一般化**：**N 个守卫串联时，负向用例集应当有 N 条、一条钉一个守卫**；否则套件钉住的是
「第一个守卫」而不是「这 N 条校验」。这与 §2.7 的「未应用 vs 幸存」是同一个陷阱换了顶帽子 ——
一个讲「这条守卫根本没跑过」，一个讲「跑了，但被别的守卫代劳了」，都会得到一份
看着覆盖、实际空转的套件。

### 2.11 真实 React + jsdom 的受控输入：React 要在 jsdom 全局就位后再 require

**病象**（实测，2026-11 M2 03 的 DOM 管理用例）：给受控 input 派发 input 事件时，
React 抛 TypeError: activeElement.attachEvent is not a function，测试直接崩掉；换成 change
事件则 React 的 onChange 根本不执行（输入框的受控值不更新）。

**根因**：React DOM 在模块加载那一刻用 canUseDOM（全局有 window/document）决定
是否走 IE9 的 propertychange polyfill。原来的夹具先在模块顶层 require(react)、之后才建
JSDOM 并装全局，于是 React 记成「不支持 input 事件」；等到测试里派发 input 时，
polyfill 去碰 jsdom 没有的 attachEvent。

**修法**：tests/scroll-dom.test.mjs 的 loadStack() 只解析路径，不 require React；
mountReader() 先建好 JSDOM、把 window/document 等装进全局，再 require React/ReactDOM。
受控输入用原生 value setter 写值，再派发 input（文本）或 change（select）。判据是
「文件夹管理：创建、改名、移动、删除二次确认与焦点恢复」在真 DOM 下通过。

### 2.12 客户端层的断言：vm 沙箱里的对象跨 realm，`deepEqual` 会因原型不同而红

**病象**（实测，2026-11-13 M5 01）：`assert.deepEqual(store.get().reading, { fontSize: 20, … })` 失败，
而错误消息里 actual 与 expected **逐字段一模一样**。

**根因**：`nav-persistence` / `client-bundle` 那一层用 `vm.createContext` 加载构建产物 ⇒ store 交出的对象
原型是**沙箱 realm** 的 `Object.prototype`，而 `node:assert/strict` 的 `deepEqual` 比原型，于是同形也红。

**修法**：断言前用对象字面量/展开把它重建到测试 realm：`assert.deepEqual({ ...store.get().reading }, expected)`。
既有用例里那段看着多余的 `navSelection.kind === 'feed' ? { kind: 'feed', feedId } : …` 重建，正是同一个理由 ——
别把它「简化」掉。

**判据**：去掉展开 ⇒ 该条翻红且消息里两边长得一样（这是这条病象唯一的签名：看到它就别去查业务逻辑）。

---

### 2.13 固定 `sleep` 是**同步点**，不是保险丝；悬挂定时器会让每个 judge 白等 5 秒

**病象**（`实测`，2026-11-15 变异门槛提速轮）：`scroll-dom` 单跑 14.9 s，其中 **12.9 s 是 212 处 `await sleep(...)`**；
`client-bundle` 5.4 s 里 **5.01 s** 是进程在等事件循环排空。47 条 scroll-dom 变异因此吃掉了全量门槛 79.8% 的时间。

**根因**（两条，修法不同）：

1. **`sleep(n)` 拿固定毫秒当同步手段**。它等的其实是「React 把这次提交画出来」或「某个请求落完」，
   而这两件事只要个位数毫秒。把 `sleep` 全换成 `settle()`（一个宏任务）后套件 **15.0 s → 1.02 s**，
   但 **12 条用例当场翻红** —— 证明它们不是可删的保险丝，而是**承重的同步点**：删了会真红，留着白等 30–40 倍。
2. **悬挂的 5000 ms 定时器**：`store.markAllRead()` 会挂撤销窗口定时器（`src/client/store.ts:328`），
   测试跑完没人清 ⇒ `node:test` 要等事件循环排空。实测 `client-bundle` 5.01 s、`unread-accounting` 5.08 s 纯空转。

**修法**：

- 夹具提供 `waitFor(pred, { timeout, interval: 5, label })`：判据是**业务可见状态**（`view === 'article'`、
  `document.querySelector('[data-rss-article]') !== null`、`saves().length === 1`），轮询间隔 5 ms，超时抛错并带 label。
- 夹具提供 `settle()`：等「没有在飞请求 + DOM 连续两跳不变」。跳用 **MessageChannel + 定时器两个任务源各让一次**
  （React 18 调度器走 MessageChannel；只让定时器会漏掉排在另一条队前的提交 —— 实测并发下 1/6 轮早退）。
- 5000 ms 撤销窗口在夹具里**只捕获不排程**，并用一条用例显式断言「窗口被武装一次、仍是 5000 ms」。
  判据从「隐式等 5 秒」变成「显式钉住 5000 这个常量」，不降反升。

**判据**：`tests/scroll-dom.test.mjs` 56/56 × 连续 10 轮 0 flake；全量套件 `--test-concurrency=3` 连续 10 轮 0 flake；
`client-bundle` 5.4 s → 0.41 s、`unread-accounting` 5.1 s → 0.10 s；全量 gate 240/240 抓到、0 幸存。

**⚠️ 别用 `--test-force-exit` 当主修法**：它能治「悬挂 handle」这一族（实测 5.4 s → 0.37 s），
但也把「测试泄漏句柄」这个形态一起藏了。夹具侧捕获 + 显式断言才是判据不降的做法。

### 2.14 `node --test` 在 `--test-name-pattern` **一条都没匹配上时照样报 pass**

**病象**（`实测`）：给一条变异配了不存在的 `judgeTests`，期望「没匹配到就回退整文件」，
结果门槛报 **survived（236 ms 套件全绿）** —— 变异看起来幸存，实际是一条用例都没跑。

**根因**：`node --test --test-name-pattern=<不存在的名字> tests/x.test.mjs` 的输出是
`✔ tests/x.test.mjs … ℹ tests 1 / pass 1`（**文件本身被算成一条通过的测试**），退出码 0。
所以「`ℹ tests 0`」这个判据永远不会出现，靠输出识别不出 0 命中。

**修法**：把漂移校验放在**跑之前**——在 judge 文件源码里查 `test('<名字>'` 字面量是否还在；
有任何一个找不到就退回整文件，并在输出里点名缺了哪条（不许静默跳过）。
判据：故意塞一个不存在的名字 ⇒ 打印「judgeTests 与测试文件漂移（缺：…），回退整文件」，随后按整文件判 caught。

**同族的第二个陷阱（`实测`，2026-11-15 性能闸）**：在 `node --test` 里再 spawn `node --test <file>`，
node 判成「递归调用 test runner」并**直接跳过**——子进程 25ms 退出 0，一行用例都没跑。
于是「墙钟预算」这类闸门会变成永远通过的空转。判据：子进程耗时远小于单文件正常耗时（如 25ms vs 3s）。
修法：子进程用「直接执行测试文件」`node tests/x.test.mjs`（不带 `--test`），并 `delete env.NODE_TEST_CONTEXT`。

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

### 3.5 图片的 `load` / `error` 可能早于监听器（缓存命中的图永远停在「载入中」）

**病象**：慢网络下图片该显示「载入中」，但缓存命中的图**一直**停在「载入中」——它其实早就好了。
**根因**：`complete` 是**同步可知**的，而 `load` 事件是**一次性**的。React 把 `<img>` 挂进 DOM
与挂上 `onLoad` 监听器之间，浏览器可能已经完成了加载并派发过 `load`；那一刻监听器还不存在，
事件就此丢失。所以「只靠 `onLoad` / `onError` 驱动三态」的实现对缓存命中的图**恒停在初始态**。
（这与 §3.1「长驻监听器捕获会变的值」是同一族：**事件可能早于监听器**，只是这里的解法不同。）
**修法**：挂载后补判一次 —— `article-pane.tsx` 的 `ArticleImage` 用 `ref` + `useEffect` 读
`image.complete`，`naturalWidth > 0` 判 `ok`、否则 `failed`。`complete === true` 也覆盖
「加载失败后浏览器放弃」那种情况（此时 `naturalWidth` 是 0），所以两个条件必须一起看。
**⚠️** 别把补判写成「挂载时读一次就完事」的 `useState` 初值：那个值在首次渲染时就固定了，
而 `ref.current` 要等 DOM 就位才有值。`useEffect` 在 DOM 提交之后跑，读到的才是当下的 `complete`。
**测试侧（`实测`）**：jsdom 里 `<img>` **不加载资源、不派发 `load` / `error`**，所以三态用例必须
手动 `dispatchEvent`；补判那条要把 `complete` / `naturalWidth` 桩在
**`HTMLImageElement.prototype`** 上（测试拿不到「节点已创建、effect 还没跑」那个中间时刻），
用例末尾还原 —— 原型是同一 JSDOM 实例内跨用例共享的。

### 3.6 「换篇文章复用组件实例」的坑：`key` 不能用裸下标

**病象**：A 篇的图 0 已经加载好，按 `j` 切到 B 篇，B 篇的图 0 **直接显示成已载入**——而它从没加载过。
**根因**：`displayBlocks.map` 用裸 `index` 当 `key`。换文章时若块数相同，React 认为「同一批元素」
只是 props 变了，于是**复用同一个组件实例**，里面的 `useState` 原封不动。
**修法**：key 用 `itemId + ':' + index`（`article-pane.tsx` 的 `blockKeyOf`）。复合 key 让 React
语义化地重挂，换篇即复位，**不需要** `useEffect` 去重置状态（用 effect 重置是同一个 bug 的补丁形态：
它要额外记住「上一次是哪篇」，而 key 让 React 自己知道）。
**⚠️ 测试侧的现实**：`loadArticle` 换篇时先 `set({ article: { loading: true } })`，那一刻
`blocks` 为空 ⇒ 夹具会先提交一次「零图片」的渲染，图片组件本来就被卸载过一次。
所以「裸下标会沿用旧态」在**当前夹具里复现不出来**（`实测`：探针观察到换篇序列
`{imgs:0} → {imgs:1, loading}`，见票据 06 的交付说明）。复合 key 仍是正确形态
（它不依赖「中间恰好没有图」这个偶然事实：两篇块数相同且都非空时，裸下标就是 bug），
但那句「换篇后三态复位」的用例在今天的夹具下**对两种 key 都绿**——它不是这条判定的判据。

### 3.7 结构判据过严与过松一样是缺陷：会误杀正确实现

**病象**（2026-11-21，R6 验收 6 的二次更正）：判据写成
`hint.matches(':any-link, button, summary, input, select, textarea, [tabindex]') === false`，
本意是「提示不许是可聚焦控件」。它把目标形态 `<span>` 放过了，却也把
`<span tabIndex={-1}>` 一并拒绝 —— 而那个形态**空格翻页正常、Tab 也选不到**，是完全合格的实现。
**根因**：`[tabindex]` 这个选择器表达的是「**有** tabindex 属性」，而想守的性质是
「**不在 Tab 序里**」。两者在 `tabIndex === -1` 时正好相反：有属性、但不在 Tab 序。
用「看起来相关的属性」代替「想守的那个性质」，判据就会在边界上朝错误的方向偏。
**为什么过严同样有害**：实现者看到红，要么为了变绿去删一个**无害**属性（把代码改坏以迎合测试），
要么怀疑自己本来正确的实现。测试是产出的一部分，它不该把正确实现判成不合格。

**修法**：判据写「想守的那个性质」，必要时拆成两条**互补**的窄判据：
```js
assert.ok(!['BUTTON','SUMMARY','INPUT','SELECT','TEXTAREA'].includes(hint.tagName))  // 结构：不是可交互元素
assert.ok(!(hint.tagName === 'A' && hint.hasAttribute('href')))                        // 结构：不是链接
assert.ok(hint.tabIndex < 0)                                                          // 行为：Tab 选不到
```
**为什么单条都不够**（两条都是 `实测`）：
- 只用 `tabIndex < 0` ⇒ 放过 `<button tabIndex={-1}>`：`tabIndex` 同样是 -1，但它可被 `focus()`
  或鼠标聚焦，且**自带空格激活语义** —— 正是要防的那件事。
- 只用 tagName 名单 ⇒ 放过 `<a>` 之外的怪形态（`contenteditable`、`<details>` 套壳等）。
两条合起来的分类（`实测` 四形态）：`<span>` ✅ / `<span tabIndex={-1}>` ✅ /
`<button>` ❌ / `<button tabIndex={-1}>` ❌。

**同一族的另一个教训**（2026-11-21，R6 验收 5）：判据要**派发到被测元素本身**，不能沿用
「派发到 `document`」的通用 helper。jsdom 里聚焦的 `<button>` 收到空格**既不 `preventDefault`
也不 click**，所以「提示是 button」这件事在 document 派发路径上完全不可见 —— 老写法恒绿。
同理别断 `defaultPrevented`（`routeKey` 自己会 prevent）：要断的是**业务后果**（`scrollTop` 有没有变）。

### 3.8 「隐私加固」把功能改坏：`no-referrer` 让图床 403，而测试看不见

**病象**（2026-11-21 真机，R6 交付后）：装上带 `referrerPolicy="no-referrer"` 的版本，打开**任何**一篇
带图文章，**所有图片都显示「图片加载失败」**。而当时 935 条测试全绿、变异门槛 316/316 全抓。

**根因**（`实测`，浏览器 UA 逐域名 `curl`，三轮一致）：

| 域名 | 占本机缓存 | 空 Referer | 仅 origin | R6 之前 |
|---|---|---|---|---|
| `cdnfile.sspai.com` | **52.7%** | **403** | 200 | 200 |
| `icon.solidot.org` | 26.3% | 403 | 403 | **403**（既有） |
| `s3.ifanr.com` | 15.6% | 200 | 200 | 200 |
| `icon.zhiding.cn` | 4.2% | 200 | 403 | **403**（既有） |
| 其余 | 1.2% | 200 | 200 | 200 |
| **坏图占比** | | **78.9%** | **30.5%** | 30.5% |

`no-referrer` 把 Referer 变成空，而 sspai 的图床**空 Referer 一律 403**。坏图率从 30.5% 涨到 78.9%。

**两层教训**：

① **测试看不见，是因为 jsdom 里 `<img>` 不发请求**。三态用例是手动派发 `load`/`error`、
补判用例是桩 `HTMLImageElement.prototype` —— 真实浏览器的 403 会触发 `onError`，而 jsdom 里
**根本没有这个事件可派发**。这与 spec 验收 3「请求计数在 jsdom 里不可观测」是同一类盲区，
但那次结论是「判据并入 DOM 断言」，这次的盲区**掩盖的是真实缺陷**。
⇒ **凡改图片/网络策略，判据必须有一条钉「策略值本身属于已知可通过图床的白名单」**，
不能只钉「DOM 里有没有 `<img>`」。

② **隐私收益要先证明它存在**。spec 决策 29 的理由是「Referer 把『我正在读哪一篇』告诉第三方」，
但本插件是 SPA（`grep pushState|location|URLSearchParams src/client/` **零命中**），
**没有按文章区分的 URL** —— Referer 里从来只有宿主 origin，不携带文章身份。
用「52.7% 的图挂掉」去换一个**并不存在**的隐私收益，是净损失。

**修法**：`referrerPolicy` 用 **`strict-origin-when-cross-origin`**（= 浏览器默认值）——
跨源只发 origin、不发路径，sspai 恢复 200，坏图率精确回到 R6 前的 30.5%。
抽成唯一来源常量 `ARTICLE_IMAGE_REFERRER_POLICY`，正文图 / 灯箱图 / 灯箱「原图」链接都读它。

**⚠️ 顺带纠正一个容易误判的地方**：`icon.solidot.org`(26.3%) 与 `icon.zhiding.cn`(4.2%)
**在 R6 之前就 403** —— 前者要**自家域名** Referer（`https://www.solidot.org/` 才 200，
裸 `https://solidot.org/` 仍 403），后者要**非空** Referer。那是**既有的**防盗链问题，
不是本次回归，改 `referrerPolicy` 也不会好。要修得按域名决定策略 —— 那是另一件事，
别在修 referrer 时顺手加白名单（本仓库「不为未经实测的样本扩规则」）。

**判据在哪**：`tests/scroll-dom.test.mjs` 的「正文图片的 referrer 策略是 strict-origin-when-cross-origin」
（DOM 层）+ `tests/client-bundle.test.mjs` 的两条产物断言（策略常量值 + 正文/灯箱都引用它）。
变异 `client-referrer 写回 no-referrer` 守「别改回那个会让图床 403 的值」，
`client-图片无 referrerPolicy` 守「别把属性整个删了」。

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
- ~~**存储域会撞 `already-open`**~~ **【历史 · 机制已删（Task 8）】**：原本是
  `openDomainWithRetry` + 孤儿句柄接管，日志写「上一代 fiber 遗留域句柄（无持有者），接管并关闭」。
  自持存储后插件不再 open 任何存储域，两个函数（连同孤儿句柄回收）与 `inject` 里的
  `storageDomain` 声明一并删除 ⇒ 本坑不再存在。**留档是因为它只在存储域上发生过**；
  若日后有人再引入存储域，这条要连机制一起捡回来，不能只留 `duplicate prefix route` 半条。
  自持后的对应面是 `rss.db` 的句柄：`ctx.effect` 的 disposer 里**同步** `database.close()`
  （见 `src/index.ts` 的 effect 尾部；关失败必须留痕，不许吞）。

### 4.7 注入器写死 `config: {}`

`dsh-super-injector` 的 `loader.create` 永远拿 schema 默认值 ⇒ 订阅源不能只靠 Config。
**真相在持久化层，不在 Config**：现在是 `storages/rss-reader/config.json`
（自持迁移前是存储域的 `rss_reader.json` feeds 表 —— **历史**，见 §4.9）。

### 4.8 `storageDomain` 域名/表名约束 【历史 · 随存储域一起退出运行】

必须匹配 `^[a-z][a-z0-9_]*$`（连字符非法，故用 `rss_reader`）。
**域 disposer 必须返回 `close()` 的 promise**：写成 `void domain.close()` 会让「卸载完成」
跑在域真正释放之前。

**⚠️ 这条现在只服务于一个非生产对象**：`src/store.ts` 的 `createStore`（旧存储域适配器）
与 `src/domain.ts` 的 `readerDomain` 声明仍在（测试用它做「旧实现 ↔ 自持实现」同义性断言），
但插件装载路径**一次也不碰存储域**。也正因如此，自持目录名 `rss-reader` 才可以带连字符 ——
它不是 `UNIT_NAME_RE` 的对象。

### 4.9 「别自己上 SQLite」这条约定已作废（2026-10-11 拍板）

`src/domain.ts:5` 写着「迁移/并发/落盘语义由设施负责（**别自己上 SQLite**）」。
**这条约定的前提是「域小到能整份进内存、整份写盘」**——`storageDomain` 是打开时全量载入的 KV，
JSON 后端每次写整份原子重写。在 200 源 × 500 条（10 万条目）下这个前提不成立：
一源 500 条批量标已读要 4.1 s，且每轮刷新有 `3 × 源数` 次全表扫描。

**处置**：改为 **100% 自持**（插件自己拥有全部落盘，不再使用 `ctx.storageDomain`），
落点 `$DSH_HOME/storages/rss-reader/`，介质 `node:sqlite`。先例是 `dsh-cost-meter`（同样自持）。
方案见 `docs/superpowers/specs/2026-10-11-large-scale-storage.md` 的 §4 与 §10，
实施步骤见 `docs/superpowers/plans/2026-10-11-large-scale-storage.md`。

**✅ 状态：已落地（2026-10-11，任务 2–8 全部完成；2026-10-13 起迁移**本身**也下线了）。** 逐项兑现：
`src/storage/db.ts` 持有 DDL、`src/store-sqlite.ts` 是新 store、`src/index.ts` 走
`ensureStorageRoot → openDatabase → migrateSchema → assertSubscriptionsNotLost → createSqliteStore`。
收尾（Task 8）摘掉了 `inject` 里的 `storageDomain` 声明，并删掉 `openDomainWithRetry`
与孤儿句柄接管、开域后的全表 `normalizeLegacyArticles`。

**🗑️ 迁移下线（2026-10-13，用户拍板）**：真机上那次迁移已跑完且成功（8 源 / 158 条 / 67 份正文），
老文件 `storages/rss_reader.json` 与旧日志目录已（在备份验证后）删除 ⇒ `src/storage/migrate.ts`
连同 `tests/migrate.test.mjs`、6 条 `migrate-*` 变异一并删除，装载路径不再读任何存储域文件。
**它的核心判定没有消失，只是搬了家**：迁移的闸门二（「库里有条目、配置那份却没写成 ⇒ 订阅丢了」）
搬进 `src/index.ts` 的 `assertSubscriptionsNotLost`（那里的注释写了为什么必须响亮失败），
由 `tests/storage-skeleton.test.mjs` 与一条 `storage-订阅丢了却不报错` 变异守着。
**一条通用教训（本次没踩到，但是这条迁移留下的）**：删掉一个判定时，必须**同时**删掉它的变异条目
—— `from` 已不存在的条目会被门槛计成「未应用」→算作幸存者（§2.7），删漏一条就整轮门槛红。
**存活的存储域对象只剩 `src/store.ts` 的 `createStore` 与 `src/domain.ts` 的 `readerDomain`**，
它们只被测试当「旧实现 ↔ 新实现」的同义性基线用，不在装载路径上（见 §4.7 / §4.8）。

**⚠️ 但 `peerDependencies` 与 `build.sh` 的 `link_pkg` 这两处**不能**跟着删（实测，Task 8 踩到）**：
`src/domain.ts` 的 `defineDomain/domainTable` 是**运行期** import、`src/store.ts` 的 `Domain` 是
`import type`，所以「运行路径不碰存储域」并不等于「构建期不需要这个包」。
照着直觉删掉那条 link 之后，从零 build（隔离副本、`lib/` 与 `node_modules` 都从零来）
立刻 `TS2307: Cannot find module '@deepseek-ai/dsh-storage-domain'` ×2。
**在工作树里它当时还是绿的** —— 因为 `node` 会向上走到父级 `node_modules` 找到一份旧的拷贝，
那正是本仓库「测试跑的是产物 / 环境会骗你」这条纪律的又一个变体（详见 §1.9）。
一般化：**「运行路径不用某依赖」不蕴含「可以删掉依赖声明」**，判据是那条 import 在不在编译图里。

**教训**：迁移拆成「切换装载路径」与「清理失效机制」两步是对的 —— 切换那一步保留死代码，
中途回退才仍然可能。但**死代码要留一条有名字的记号**（Task 4 在 `openDomainWithRetry`
头上写了「已无调用方，Task 8 删」），否则下一个读代码的人会把它当成「还在用的退避机制」，
下一个任务就可能顺手把它删在半路上，或反过来一直留着当并不存在的把手。

### 4.10 没在 `inject` 里声明的服务，活体里就是 `undefined`（测试夹具会替你掩盖）

**病象**（2026-11-13 实测）：M3 02 的三个工具**单测全绿**，活体宿主里一个都没注册 ——
诊断探针 dump `ctx.tools.schemas()` 仍是 52 个，直到把探针工具面与源码逐个对账才看出少了三个。

**根因**：`tools` 没写进 `inject`。未声明的服务经服务解析器求值得到 `undefined`，
而插件里正好写成「取不到就 `return`」—— 于是**静默空转**。仓库的装载测试用的是**手写 ctx 对象**
（`{logger, effect, webServer, connection}`），那里 `ctx.tools` 会被测试补上桩值 ⇒ 单测看不见这个洞。
与 §1.9 同一条教训：**测试全绿只证明测试覆盖的那条路径**。

**修法**：必需服务一律进 `inject`（`inject: ['connection', 'webServer', 'tools']`），
插件代码直接用 `ctx.tools`，不要再写「取不到就返回」的软退化；装载测试夹具补
`tools: { register: () => () => {} }` 让夹具与真实宿主同构。

**判据**：活体工具面 52 → 55（探针 dump `ctx.tools.schemas()`），
`dev_uninject_plugin` 后 55 → 52，重新注入后各一份回来。

---

### 4.11 注入器的自动重载会被「改到一半的源码」永久卡住，而手动 reload 可能什么都没做

**病象**（2026-11-13 实测）：`src/tools.ts` 把导出从 `registerReadTools` 改名成 `registerAgentTools`、
`src/index.ts` 还没同步时，注入器的自动重载预检失败；等两边都改好并 `npm run build` 之后，
**活体工具面仍是旧的**（少一个工具），而 `dev_reload_package` 照样返回一大段「当前已装配插件」，
看起来一切正常。

**根因**：两条叠加。
① 预检失败时注入器走 `watch-precheck-blocked`，**保持旧代码且不再自动重试** —— 之后源码修好也不会自己回来；
② 手动 `dev_reload_package` 这一次没有落 `~/.dsh/super-injector/reload-debug.log`，
即它**没有真的重载**，只是打印了装配清单。两条都不会报错，属于「静默跑旧代码」。

**修法**：改完先看 `~/.dsh/super-injector/self-heal.log` 尾部有没有新的 `watch-precheck-blocked`；
要强制生效用 **`dev_uninject_plugin` + `dev_inject_plugin`**（本次实测有效），不要相信 `dev_reload_package` 的返回值。

**判据**：一次性探针 dump `ctx.tools.schemas()` 的工具数 —— 重载前 55、强制重装后 56（多了 `rss_update_item`）。
光看 reload 的输出永远看不出差别。

**2026-11-13（M5 01）再补一条**：这三个注入器工具的参数名各不相同，传错名字的后果也不一样 ——
`dev_reload_package` 认 `match`（传 `package:` **不报错**、照样打印装配清单，于是看起来像 reload 过了）、
`dev_uninject_plugin` 认 `match`（传错会响亮报 `missing required property "match"`）、
`dev_inject_plugin` 认 `dir`。判据仍然是行为：`~/.dsh/super-injector/reload-debug.log` 里有没有这一次的
`reload match=…`（本次传错参数时，那条日志里一条都没有）。

**2026-11-13（M5 02）再补一条更危险的**：**watch 会自动重载宿主，于是「改代码 + build」等于对真实库执行迁移**。
`实测`：改完 `src/storage/db.ts`（v2→v3 加表）并 `npm run build` 之后，没有等我调任何注入器工具，
`~/.dsh/super-injector/reload-debug.log` 里就出现 `17:22:41Z / 17:22:43Z / 17:22:49Z` 三条
`reload match=@dsh-external/dsh-rss-reader`，而真实库 `rss.db` 的 mtime 正是 `17:22Z`、`user_version` 已经是 3。
因果推断（`猜测`，但没有第二种解释）：那次自动重载跑了 `migrateSchema`。
**含义**：任何会改物理 schema / 写 migration 的改动，**build 之前**就得先按备份流程拷一份真实库 ——
本轮的 `/tmp/m5-02-pre-migration-backup` 因此是**迁移后**的快照，不是回滚点。
同一条日志还显示这几条 reload 是 `cm=yes clientPath(short)=undefined`，即**客户端半边没被换掉**：
宿主迁移了、前端还是旧 UI —— 「同一代插件两半不同步」是这条自动重载的常态，别拿它当发布验证。

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

### 5.7b 保护 pass 的占位符会漏进别的块的文本

**病象**（2026-11-21 R5 排查 `实测`）：`<li>文字<pre>code</pre></li>` 抽出来的 `list.items[0]`
是 `"文字\u0000B0\u0000"` —— 一个 NUL 包裹的内部占位符，直接进了用户可见文本（也因此进了搜索索引
与字符统计）。

**根因**：`collectBlocks` 的保护 pass 按「越具体越先」的顺序跑（`figure` → `pre` → `ul/ol` →
`blockquote` → `img` → `h1-6`），每个 pass 把整块内容换成 `'\u0000B<id>\u0000'` 存进 `stashed`。
`pre` 先于 `ul` 跑，所以 li 的文本里已经带着那个占位符；`ul` 的 pass 再把 li 文本交给 `htmlToText`
时，占位符被当成普通文字留下。

**修法**：任何「从别的块的文本里取内容」的 pass，都必须把 `\u0000B\d+\u0000` 当**硬边界**（分隔 + 丢弃），
不能当普通字符。R5 把这条写进了内联解析（占位符与 `<br>` 同一处理）。

**判据**：`tests/article.test.mjs` 断言「嵌套了 `pre` / `figure` 的列表项，其 `items` 与 `itemRuns`
里都不出现 `\u0000`」；变异 `inline-占位符当普通文本` 守护它。

**教训**：占位符是**内部协议**，它的生命周期必须止于「重建块顺序」这一步。任何把它交给
文本处理函数（`htmlToText` / 内联解析 / 字符统计）的路径，都是泄漏点。

---

### 5.7c figure pass 会吞掉不是 img 的内容

**病象**（2026-11-21，R5 04 `实测`）：`<figure>` 里除了图片还有别的块时，那些内容**静默消失**。
三种形态都中招：

| 夹具 | 修复前 | 修复后 |
|---|---|---|
| `<figure><table>…</table></figure>` | 表格整块丢 | `table` 保留 |
| `<figure><img><table>…</table></figure>` | 只剩 `img`，**表格丢** | `img` + `table` |
| `<figure><pre>code</pre></figure>` | 代码块丢 | `pre` 保留 |

**根因**：figure pass 只找第一个 `img`，找到就 stash 成 img 块并把 **inner 其余内容一起丢掉**；
找不到 img 就直接返回 `' '`（整块丢）。它把 `<figure>` 当成「图片容器」，而 HTML 里它其实是
「带图注的插图容器」——表格与代码块也会被包进去。

**修法**：pass 把 inner 里 img 块与**原样放回**的 table / pre 区域按文档顺序摘出，交给同层 pass 解析
（网格归一仍只有一份实现）。既无 img 也无 table / pre 时保持整块丢弃（那是纯装饰容器）。

**判据**：`tests/article.test.mjs` 的三形态用例；变异 `figure-吞掉表格` 守护。

**教训（可复用的形状）**：任何「整块重写」的 pass，只要它的匹配条件比该标签**实际承载的内容**窄，
就会静默丢东西。写这类 pass 时先问一句「这个标签里还可能装什么」，而不是「我要找的是什么」。

---

### 5.8 调度按「上次**尝试**」排序，不是「上次成功」—— 只盖成功会让失败源饿死全部健康源

**病象**（2026-10-11 任务 10 修复轮 1，评审 `实测` 抓出）：按陈旧度取源时若排序键只取
`lastFetchedAt`（= 上次**成功**），**永久失败**的源永远拿不到这个时间戳，于是永远钉在
「无限陈旧」那一端。这类源一旦 ≥ 每轮上限 K，每一轮选中的就是同一批失败源。

| 形状（复刻真实写规则，60 轮） | 旧键 | 新键 |
|---|---|---|
| 200 源 / 0 个永久失败 / K=20 | 200/200 ✅ | 200/200 ✅ |
| 200 源 / 5 个永久失败 / K=20 | 195/195 ✅ | 195/195 ✅ |
| **200 源 / 20 个永久失败 / K=20** | **0/180 永久停摆** | 180/180 ✅ |
| **3 源 / 1 个永久失败 / K=1** | **0/2 永久停摆** | 2/2 ✅ |

**根因**：写规则不对称 —— 成功（200）与 304 都盖 `lastFetchedAt`，失败分支只写 `lastFailure`。
「有界默认值之所以安全，靠的是按陈旧度旋转」这条论证，对**这一类永远拿不到时间戳的源**
根本不成立；而且 `force` 也救不回来（它只绕节流，不绕轮转）。

**修法**：新增 `FeedRecord.lastAttemptedAt`（上次**尝试**：成功/304/失败都盖），排序键改为
`lastAttemptedAt ?? lastFetchedAt ?? ''`。**没有**把 `lastFetchedAt` 直接改成「成败都盖」——
那会让 UI 契约（`src/shared.ts` 的「从未成功抓取过则为 undefined」）当场变成谎话。
两个问题各自只有一个答案：`lastFetchedAt` 答「上次成功」，`lastAttemptedAt` 答「上次尝试」。
回落链还顺带保住了「从未尝试过 = 无限陈旧」，所以这个新字段**不需要任何迁移**。

**证据等级**：`实测`（纯函数层 200/20/K=20 与 3/1/K=1 两个形状 + 真装配 3 源其中 1 个恒 500、
K=1 的四轮 `hits` 序列 `['broken', 1, 2, 'broken']`）。判据在 `tests/refresh.test.mjs` 的
「永久失败的源不得饿死健康源」两条；变异 `refresh-调度键退回只看成功` 与
`refresh-失败的尝试不盖时间` 各自被抓到（后者**只有**真装配那条用例抓得到 ——
纯函数层怎么改都测不到「失败分支有没有盖时间」）。

**教训（可复用的形状）**：凡是「按上次事件时间排序」的调度，都要先问一句
「**哪些源永远拿不到这个时间戳**」；拿不到的那些会永久占据窗口，而它们的数量一旦 ≥ 窗口宽度,
调度就退化成「每轮重复同一批」。**排序键应当取「上次尝试」而不是「上次结果」**，
除非那种「拿不到时间戳」的源在定义上不可能存在。

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
  `空格`/`d`/`shift+d` = 整屏/半屏翻页（2026-10-10 起 `u` 归还 GR 原义 = 左栏显隐，
  上半页由 `shift+d` 接盘）。
- **左栏的「光标」与「生效」是两件事**（规格 §2.4 把 `shift+n/p`「移动」与 `shift+o`「打开」
  写成两行，别把它们再合回去）：`navCursor` 是纯光标 —— 移动它**不改变**任何过滤结果、
  不影响 `selectedId`；只有「打开」（`shift+o` / 鼠标点击）才动 `navSelection`/`filter`。
  **根因教训**：第一版让 `navSelection` 同时兼任光标与生效视图，于是 `shift+n` 走一行**就等于**
  打开它、`shift+o` 实测只剩「取消」——规格的两行行为塌缩成一行，而**测试当时还把那个缺陷状态
  当成契约钉住了**（「没有独立光标」被执行者当既有事实写进断言）。判据：
  `tests/nav-selection.test.mjs` 的 `moveNavCursor` 用例（移动前后 `navSelection`/`filter`/
  `selectedId`/`visible()` 逐字段相等）+ `tests/scroll-dom.test.mjs` 的「移动光标不改变右栏」。
  界面上同样要分开：`data-rss-nav-cursor`（左侧竖条）≠ `data-rss-nav-selected`（背景 + 加粗）。

---

## 七、还没做的（需决策）

- **8 条规格债**（`docs/google-reader-feature-spec.md` §6 的路线图）：kept-unread 语义、不变量 2 的
  重复 id/URL 兜底、expanded/list 两视图与 `1`/`2` 键、auto-discovery、mark-all 时间阈值、
  未读计数可隐藏 + `r` 刷新计数、不变量 1 与规格对齐、正文面补验收清单。都属**新功能**，
  建议从 kept-unread 起（要动 domain schema，越早做迁移成本越低）。
- **独立安装（锁文件）与 CI**：同一件事 —— 没有锁文件就没有 CI。

## 八、待验证 / 遗留

- **图片组序号会在「同一篇重抓换掉 blocks」时漂到另一组**（2026-11-21，R6 05）：组级覆盖装的是
  **组序号**（0..N-1），而组序号只在**当前这份 blocks** 里有意义。同一篇若重抓、正文块变了
  （多一张图、少一段文字），同一个序号就落到另一组上 —— 读者点开的是 A 图，重抓后亮起来的是 B 图。
  **当前不可达**（源码核对）：唯一能让「已经在正文页」的条目重新取数、从而换掉 `blocks` 的入口是
  「重试抓取」按钮，而它只存在于 `bodyState === 'fallback'` 那个块里
  （`src/client/article-pane.tsx:762`，`onRetry` 全仓只此一处使用）；而回退态要求
  `!hasRenderedBlocks`（同文件 `:424-426`）—— 正文块为空才回退，回退内容不产生 `img` 块，
  所以那一刻组覆盖必然是空集，没有序号可以漂。`j` / `k` 换篇走的是另一个 `itemId`，
  复位 effect 会清空组覆盖，也不经过这条路径。
  **不加防护代码**（spec 决策 16：为一条不可达路径加防护 = 没有实测样本的规则）。
  将来若把「重试抓取」挪到 `failed` / `content` 态、或加「刷新正文」之类的入口，这条立刻变成可达：
  届时的修法不是给序号加校验，而是把组标识换成**内容派生**的东西（组首图 `src` + 组内张数），
  或者干脆在重抓成功时清空组覆盖 —— 后者更简单，且语义正确（新正文是另一次阅读）。
- **`align` 只认 `align` 属性这条规则没有真实站点样本**（2026-11-21，R5）：表格对齐只读
  `<td align=right>` 这类属性，**不解析** `style="text-align:…"`、也不读 `<colgroup>`。
  这是按「不为未经实测的样本扩规则」刻意留的口子。真机上若看到「某站表格明明居中、阅读器里左对齐」，
  先确认站点用的是哪一种写法，再决定是否扩规则——不要凭印象直接加 CSS 解析。
- **正文缓存磁盘 2–6 倍是合成夹具上的比值**（2026-11-21，R5）：`runs` 让序列化体积变大而额度闸门
  （可见字符）看不见。升级前的真实基线已测：60 篇 / 可见字符 202,069 / 实际字节 642,436 =
  **3.18 字节每可见字符**。**升级后要复测同一个数字**并回填这里；测量方式是
  `select body from texts` → `JSON.parse` → `articleCharsOf({blocks})` 求和，对比
  `Buffer.byteLength(body,'utf8')` 求和。若倍数明显超出 2–6，先查 run 数是否爆炸（相邻同类未合并）。

- **`?` 在中文输入法 / 非 US 布局下的 `event.key`**（2026-10-10）：本插件只认字面 `'?'`（US 布局下
  shift+/ 的结果），**没有**加 `'/' + shift` 的物理键兜底 —— 不为未实测的样本扩规则。真机验证点：
  中文输入法激活、且开关处在全角模式时按 shift+/，`event.key` 是否仍为半角 `'?'`（可能是 `'？'`）。
  若不成立，要么补物理键兜底，要么如实记一笔；头部最右端那个 `?` 按钮是不依赖键盘的第二入口，
  所以即使键盘路径失效，功能也不会不可达。
- **平滑滚动动效**：可行性已分析（ease-in-out + 仅按钮 + 可中断 + `prefers-reduced-motion` 回退），
  用户决定暂不做。风险点留档：动画会与 9 处写 `scrollTop` 的入口抢写，必须可中断。
- **DNS rebinding 的 TOCTOU**：解析层拦了「域名解析到内网」，但解析与连接之间有时间差；
  彻底封死要自定义 dispatcher（引入 undici），评估后不做。
- **内网自建 RSS 源**：可用（`trustedTarget`），但只对**第一个请求**生效，重定向目标一律不可信。
- **`articleRecordSchema.paragraphs`**：schema 仍声明它（只为兼容读）。删不掉的两条路都实测过：
  版本号在 single layout 下硬相等（升版直接打不开域）、`backup-and-skip` 会连带丢掉用户已读态。
- **独立安装（锁文件）与 CI**：同一件事 —— 没有锁文件就没有 CI。

- **`refreshConcurrency` 的默认 5 至今没有实测**（2026-10-11 任务 10）：spec §9.3 要求
  「同一台机器、20 个真实源」实测后再定，本开发环境够不到真实外部源（只有本地桩）。默认值
  因此保持历史值 = 5，**没有**照抄 spec 的「8–12」（照抄别人的区间等于把未验证的数当成自己的
  测量结果）。实验与「什么算证据」写在 `src/config.ts` 该字段的注释里（扫
  {1,2,4,5,8,12} → 一张 (并发, 中位墙钟, 超时数) 表，拐点即合理上限）。
  同一轮定下的 `refreshFeedsPerRound`（每轮抓最旧的 K 个）默认 20 同理是**起点值不是最优值**。
- **回溯的日期规则有两条没有真实样本**（2026-11-23，R9）：`<meta property="article:published_time">` 与「URL 里完整的 `YYYY/MM/DD`」是按通用约定加的，**没有**实测到哪家站点真的靠它们才解析出日期（阮一峰用 `abbr.published`、云风用可见文本）。真机上若遇到「明明有日期却被跳过」，先确认该站写的是哪一种，再决定是否扩规则——不要凭印象加 JSON-LD 之类的新解析。
