# AGENTS.md — dsh-cmdgo-provider 开发须知

CommandCode **Go 套餐**的 DSH 供应商插件：Go 订阅没有 Provider API（OpenAI 兼容端点
回 403 `upgrade_required`），所有请求必须走 CLI 私有网关 `POST /alpha/generate`。本
文档是给在这个仓库里干活的 agent 的——下面每一条几乎都对应一个真实 issue 或一次
真机翻车，改代码前先读完。

## 命令

```bash
bun run build        # bash scripts/build.sh：tsc → lib/（lib/client.js 是手写 bundle，不经 tsc）
bun run typecheck    # tsc -p tsconfig.json --noEmit —— 门禁，改动后必须 exit 0
bun run smoke        # 9 个 scripts/smoke-*.mjs 串行，全部 exit 0 才算过
```
没有测试框架：回归全靠 `scripts/smoke-*.mjs`（Node 直跑、自写断言）。**改行为必须
同步补断言**，`smoke` 绿了才算完；`smoke` 跑的是 `lib/` 产物，所以**先 build 再
smoke**，只跑 smoke 会测到旧代码。

### 构建环境（本机没有全局 node_modules 时）

`scripts/build.sh` 需要 `DSH_CHECKOUT` 指向一棵含 `@deepseek-ai/*` peer 的宿主树
（它会把 peer junction 进包内 `node_modules/`，typescript 也从那里找）。本机开发
可用任意一棵装了 dsh 的树，例如：

```bash
DSH_CHECKOUT=/path/to/host/node_modules/.. bun run build
```

注意 `node_modules/@deepseek-ai/` 下的链接**不要提交**，也**不要为了跑测试把
`cordis`/`dsh-settings` 链到另一棵版本不同的树**——tsc 会看到两份 cordis 类型直接
报错，运行时也会 realm 错乱。settings 投影测试用 `DSH_HOST_MODULES` 环境变量指向
宿主树，它会自己临时建链、跑完自己拆。

## 目录速览

| 文件 | 职责 |
| --- | --- |
| `src/protocol.ts` | 网关请求信封与 NDJSON 事件流解析（**最大也最容易出事的一块**） |
| `src/adapter.ts` | `LlmAdapter`：流式传输、账号故障转移、历史自愈、空回合守卫 |
| `src/index.ts` | 插件装配：settings 两代契约、供应商注册、HTTP 路由、额度 HUD 数据 |
| `src/models.ts` | 公开目录扫描 + Go 档位两层判定 + 官方目录的费率解析 |
| `src/prefs.ts` | 用户偏好（模型可见性黑名单 + HUD 开关与位置 + 配色方案），落 `~/.dsh/cmdgo-prefs.json`；落盘走 `this.writing` 串行链 |
| `src/pool.ts` | 多账号池（round-robin / 冷却 / 收编） |
| `src/usage.ts` / `meter.ts` / `request-stats.ts` | 额度、调用计量、缓存台账（纯只读聚合） |
| `src/oauth.ts` | `cmd login` 的 OAuth 提取（本机回调服务器） |
| `lib/client.js` | 手写 `__ModuleLoader__` bundle（浏览器端 HUD），**不经 tsc**，改它要同步 `scripts/smoke-client.mjs` |

## 硬性约束（违反 = 出过真 issue）

1. **工具调用/结果必须严格双射**（#5）：assistant 里每个 `tool-call` 恰好一条同 id
   结果，反之亦然。历史压缩/工具中断会制造孤儿，序列化前必须丢（`ToolPairing`）。
   网关对坏形状是硬错误，且坏形状会**每轮重发**，会话永久卡死。
2. **DSH 0.2.x 的历史带独立 `role: 'tool'` 消息**（#10）：配对前先归一化成内部
   user + tool-result 表示，否则结果被降级成 user 文本、有效调用被当孤儿删掉，
   模型看到坏历史就提前收尾。旧版嵌套 `tool-result` 块也要继续兼容。
3. **半截回答绝不重放**：流一旦产出 chunk，错误只能如实上抛，不能换账号重试
   （`stream()` 里 `yielded` 守卫）。自愈重试用**同一个账号**（不烧别的号），
   真正的账号故障转移才换号。
4. **只修「这一轮真的发出去的调用」**（#5）：网关点名的 id 不在请求里时不要自愈
   重发，纯烧额度。
5. **reasoning 不算「可见输出」**（#9）：只有 reasoning、没有正文也没有工具调用的
   回合要抛 `EMPTY_RESPONSE`（宿主默认可重试码里有它）。但**已经流出的 reasoning
   保留**（真实内容不回收），**用量照常上报**（那一轮网关确实计费了）。
6. **错误分类决定是否烧额度**（#5/#6）：`INVALID_REQUEST` / `PERMISSION` /
   `CONTEXT_WINDOW_EXCEEDED` 绝不能进 `FAILOVER_CODES`——必然失败的请求换号重试
   只会白烧别的账号。网关的 error 事件是流的真实终止原因，别把它盖成
   "stream ended without finish-step"。
7. **`x-session-id` 必须是官方 `sess_<16 hex>` 形状且按会话稳定**（#6）：同一对话
   复用同一 id（缓存亲和），不同对话互不串味。请求指纹（UA / x-command-code-version
   / x-cli-environment / x-taste-learning / x-project-slug）对齐官方 CLI v1.31.0，
   改任何一个都可能被网关识别。
8. **HTTP 路由必须带浏览器信任闸门**：`/api/cmdgo/*` 优先复用 `connection` 服务的
   `requestRejection`，缺席时用 `browserTrustRejection()` 兜底；POST 只收 JSON
   Content-Type。这套路由此前无鉴权，恶意页面能跨站触发扣额度的操作。
9. **effect 挂在注入回调的作用域 ctx 上**（0.1.2 教训）：挂外层 ctx 时 entry 移除
   不触发 disposer，路由会变成清不掉的孤儿。
10. **CSS 选择器必须按真实 DOM 结构写，并用渲染树验证**：`lib/client.js` 里
    `<select>` 的样式曾经挂在 `.cmdgo-search select` 下，而 select 实际是
    `.cmdgo-search` 的**兄弟**（同在 `.cmdgo-filter` 里）—— 整段 `appearance:none`
    + 自绘箭头静默失效，下拉框一直是原生外观，谁都没发现。只 grep CSS 文本的
    断言测不出这种事，`smoke-client.mjs` 现在会真实渲染一次设置页再校验结构。
11. **改配色只许动深色块，浅色取值视为冻结**：`--cmdgo-*` 的浅色值必须与改造前
    逐条相等（`smoke-client.mjs` 用 WCAG 相对亮度逐对校验）。深色是新增的一套，
    每段文字对各自底色都必须过 AA。
12. **组件里所有 Hook 必须在第一个条件 `return` 之前**：`QuotaHudPill` 曾把
    `if (hud.provider !== PROVIDER) return null` 插在两个 Hook 中间，首帧 provider
    未知只走 2 个 Hook、effect 写入后走 3 个，React 抛
    `Rendered more hooks than during the previous render`，**连带整块输入区渲染中断**
    （表现为模型选择器点不动），装上插件第一次加载就触发。`smoke-client.mjs` 用静态
    断言兜底：`QuotaHudSlot` / `QuotaHudPill` 第一个 `return` 之后不允许再出现任何
    `React.useXxx`。桩里的 `useEffect` 是立即执行、不计数 Hook，测不出"数量变化"
    —— 这类问题只有真实渲染器（react-test-renderer）或静态断言能拦。
13. **多个槽位靠"都注册 + 组件内判空"切换，不要动态 register/unregister**：
    胶囊位置（`header` / `composer`）两个槽都注册，`QuotaHudSlot` 读
    `prefs.hudPosition` 决定渲不渲染。动态注册要刷新页面才生效，用户会以为没点上；
    而且槽注册是宿主的生命周期资源，运行时反复注册容易留下清不掉的订阅。
    与之配套：**收起浮层的 effect 要放在槽包装里而非胶囊里** —— 胶囊可能因为门禁
    根本不渲染，那个 effect 就永远不跑，会留一个关不掉的悬空面板。
13. **偏好落盘必须串行**：`prefs.persist()` 是「写临时文件 + rename」两步，并发保存
    各自 rename、后完成者赢，会把用户先做的操作覆盖回去（30 次双写里稳定复现 5–10 次）。
    现在整段 read-modify-write 挂在 `this.writing` 链尾，且单个任务失败不污染后续。
    payload 在**轮到写时**才生成，不在入队时固化。
14. **批量操作期间要封住单行**：批量走「逐个 POST」的循环，`modelBusy === '*'` 不等于
    任何 id，若不加 `disabled` 就会叠进新的单行请求，落盘顺序和点击顺序不一致；
    同时 `toggleModel` 用 `inflightModels` 做同步去重（`modelBusy` 是 state，
    快速双击时第二次点击在它生效前就进来了）。
15. **胶囊模板永远不能执行用户代码**：模板来自设置页文本框（也能被直接改
    `~/.dsh/cmdgo-prefs.json`），用 `eval` / `new Function` 跑它就等于开了一条
    在这颗胶囊上下文里执行任意 JS 的通道。所以 `src/hud-template.ts` 是**只读白名单**
    解析：变量查表 + `min`/`max` 聚合，没有副作用、没有分支循环、读不到表外的东西。
    `scripts/smoke-hud-template.mjs` 的 `[6]` 节固定了一批注入尝试
    （`constructor` / `process` / `require(...)` / 构造器链），它们全部必须被拒。
16. **模板语法错误要在渲染层回报，不在写盘层拦**：服务端 `/hud/template` 只校验
    「是字符串 + 截断到 300 字符」，语法对错由渲染层返回 `{error, unknown}` 给设置页
    就地显示。理由：校验放服务端会让用户打字打到一半就被 400，而 400 的信息量远不如
    「哪一段错了」。**胶囊侧遇到语法错误必须退回内置排版**——宁可显示老样子，也不能
    变成空白或一段红字。模板为空字符串 / 纯空白 = 内置排版（老观感一字不变）。
    设置页空模板时的**占位提示与预览都显示内置排版的真实文字**（由
    `hudBuiltinSegments()` 与胶囊共用同一套分段，不另写一份），不用一段示例模板
    当占位 —— 用户要看到的是"现在长什么样"，不是"可以写成什么样"。
17. **`lib/client.js` 里的模板引擎是生成代码**：它不能 `import` ESM，所以由
    `scripts/inline-hud-template.mjs` 把 `lib/hud-template.js` 的编译产物注进
    `client.js` 的 BEGIN/END 标记之间。**改完 `src/hud-template.ts` 必须重跑内联脚本**
    （`npm run inline:hud-template`，`build.sh` 里也接了），否则两边行为会静默分叉。
    `scripts/smoke-hud-template-inline.mjs` 做逐字节比对 + 同一批用例对拍，专门防这个。
18. **模板变量的口径必须与胶囊、tooltip 一致**：`hudTemplateContext()` 复用
    `hudTotals` / `hudTightest` / `hudCalls`，不另算一套。注意两个刻意的语义差别：
    金额（`remain*`）是**跨账号合计**（池子可累加），百分比（`pct*` / `left*`）是
    **该窗口最紧的那个账号**（百分比不能平均，平均会盖掉"某个账号已打满"）。
    `min()` 输出胜出参数的**原样文本**（`$0.60` 而不是 `0.6`），格式化只做一次。
19. **百分比必须同时给「已用」和「剩余」两套**（`pct*` / `left*`）。模板语言刻意
    没有算术，`100-pct5h` 不是合法表达式，所以「还剩百分之多少」只能由变量直接
    给出 —— 只给 `pct*` 等于让这个需求无法表达。`left*` 必须从**同一个**
    `hudWorstOf` / `hudTightest` 结果算 `1 - percent`，不能另取一次数据：两套
    百分比若来自不同账号，`pctTight + leftTight` 就不等于 100%，用户会看到自相
    矛盾的数字。`smoke-client.mjs` 里钉了这条不变量。
20. **额度变量是一张 2×2 矩阵，不是一串平行变量**：剩余/已用 × 金额/百分比，
    每格再分 5H / 周 / 月 / 最紧四列（`HUD_TEMPLATE_ROWS` × `HUD_TEMPLATE_COLUMNS`）。
    设置页按矩阵渲染（grid，四列对齐），表头列名与行标题都要在 —— 位置本身就是
    线索，少一个象限（比如「已用金额」）就等于用户表达不了那个需求。加变量时
    **必须同时给 `group` 和 `col`**，否则矩阵里会出现空格子且列会错位；
    `smoke-client.mjs` 校验「每行恰好四格 + 四行列顺序一致」。`remainTotal`
    已删除：它就是「月」那一列的剩余金额，留着会让人以为是另一个口径。
    **`total*`（总金额）排在最后一行**，它是 `剩余 + 已用` 推出来的汇总，不是
    宿主直接给的原始一档；也必须与同一列的 `remain*` / `used*` **同源相加**
    （见 `hudTotalsTotal`），否则用户拿计算器核对会发现差一分钱。宿主认不出
    套餐（报不出 `used`）时整列给 `—`，不能拿「剩余」冒充「总额」。
21. **浮层的展开位置必须跟着胶囊走**：胶囊有两档槽（会话头部 / composer），
    面板只有一个 `shell.overlay`。头部档用 CSS 钉右上角没问题，composer 档必须
    **量胶囊的 `getBoundingClientRect()` 再定位**，否则用户点屏幕底部的胶囊、
    面板从屏幕顶部落下来，中间隔着整个会话（已报障两次）。定位用
    `translateY(-100%)` 把下沿贴到胶囊上方，不要自己算面板高度（高度随账号数变）；
    `max-height` 取「胶囊上方剩余空间」，量不到胶囊就退回右上角而不是钉到 (0,0)。
    几何抽在纯函数 `hudPanelAnchorStyle(anchor, vw)` 里，`smoke-client.mjs` 的
    `[4i]` 直接调它断言（冒烟桩没有布局引擎，只能这么测）。

## 版本兼容（最容易踩的坑）

本插件的 dev type-peer 是**旧版** `dsh-llm`（见 `node_modules/` 链接），而线上宿主
可能是 0.1.5 ~ 0.2.x 任何一代。**类型按旧 peer 解析 ≠ 运行时只跑旧宿主**：

- **settings 两代契约**（#8）：0.1.5/0.1.6 有 `settings.installSection`，
  0.1.7+ 删掉了它、改成 `configure({ auto: false })` + schema 上的 volatile 投影，
  命名空间键从插件自报的 `NS` 变成 **loader entry id**（`ctx.fiber.entry?.options.id`）。
  运行时按方法存在性分派，两个方法都写成可选。**installSection 的 throw 会被
  cordis 的 inject 回调静默吞掉**——设置页整块消失、stderr 无输出，用户不可能自己
  定位，所以任何「拿不到就跳过」的分支都要留下 error/warn 日志。
- **volatile 需要 `@deepseek-ai/schemastery` 3.18.3+**：3.18.2 及更早没有运行时。
  按能力探测（`typeof schema.volatile === 'function'`），别按 peer 最低版假设。
  volatile 字段解析出来是 `{ get() }` 持有器，用
  `Symbol.for('cosmokit.volatile.write')` 判定（跨 realm/ESM-CJS 共享），**不要
  静态 import cosmokit**（可选 peer 缺席时不该让插件链接失败）。
- **`loader/volatile-update` 事件**：0.1.7 的 volatile 快照是原地更新的稳定引用，
  按 config 对象身份做键的缓存永远不会自己失效。监听这个事件才能让「设置页改了
  值要生效」成立。事件名按字符串写（旧宿主的类型表里没有它）。
- **peer 范围**：`>=0.1.0-rc.6 <0.2.0 || ^0.2.0-rc.1`。两个 semver 坑记牢：
  预发布版本**小于**同号稳定版（`>=0.1.7` 会拒掉 `0.1.7-rc.2`，下限要写
  `>=0.1.7-rc.1`）；上限 `<0.2.0` 会在 0.2.0 稳定版发布时**拒装**（rc 时代反而能装，
  定时炸弹）。`dsh-app-boot` 只检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`
  两类 peer，判定带 `includePrerelease: true`。
- **类型收窄时的版本边界**：`options.messages` 在旧 peer 下没有 `role: 'tool'`，
  直接 `message.role === 'tool'` 会被 tsc 判成不可达（TS2367）。在跨版本的那一处
  显式 cast（叠加可选字段），并让归一化的输入输出都用放宽的本地视图。

## 门禁与验证习惯

- 改 `src/protocol.ts` / `src/adapter.ts`：必跑 `smoke-protocol`、`smoke-repair`、
  `smoke-empty-turn`；动到请求形状时用**假的 fetch**（参照 `smoke-repair.mjs` 的
  `ndjson()` + `queue` 模式）断言网关实际收到的 body，而不是断言自己刚写的代码。
- 改 settings / 装配：`smoke-settings`（六种宿主装配的桩）+
  `smoke-settings-projection`（真实 `dsh-settings.describe()`，需
  `DSH_HOST_MODULES`，缺席自动跳过）。
- 改 `lib/client.js`（HUD）：`smoke-client`（React/DOM 桩）。它是手写 bundle，
  tsc 管不到，别指望编译器帮你。
- 改胶囊模板（`src/hud-template.ts`）：`smoke-hud-template`（语法/安全语义）+
  `smoke-hud-template-inline`（内联块与源码一致）+
  `smoke-hud-template-route`（真实 handler 的边界校验与落盘）+
  `smoke-client` 的 `[3d]`/`[6]` 两节（胶囊与设置页的真实结构）。
  只改客户端的话前三条里至少跑 `smoke-hud-template-inline`——它是唯一能发现
  「忘了重跑内联脚本」的地方。
- **发布前**：`bun run build && bun run typecheck && bun run smoke` 三条全绿再动
  版本号。版本号只改 `package.json`（发版由维护者 pack/publish）。
- 修 issue 时在 commit message 里带上 issue 号与机制（现有 git log 是范例风格），
  README 的「排错」节同步补条目——用户是照那个清单自救的。

## 已知环境噪音（不是你的 bug）

- `tsconfig.json` 的 `paths` 指向 `node_modules/@deepseek-ai/*`，链接缺失时
  `bun run` 会报 `Cannot find module`——先修 `DSH_CHECKOUT` 再跑。
- `smoke-settings-projection.mjs` 没给 `DSH_HOST_MODULES` 时打印「跳过」并 exit 0，
  这是设计行为（可选依赖），不是测试挂了。
