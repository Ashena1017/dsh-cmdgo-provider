# dsh-cmdgo-provider 本地 fork · dsh 0.1.7 适配记录

> 时间：2026-09-25
> 位置：`C:\Users\Loner\.dsh\profiles\web\commandcode-go\`
> 上游：`https://github.com/Ajwyunsx/dsh-cmdgo-provider` @ `6b74ff5`（v0.9.1）
> 本 fork 版本号：`0.9.1-dsh017.1`

---

## 一、为什么是 fork 而不是等上游

上游 0.9.1 发布于 2026-09-18，dsh 0.1.7 发布于 09-22/09-24，**插件早于 0.1.7**。
0.1.7 删除了 `settings.installSection`，插件在 `src/index.ts:686` 无保护地调用它。

实测（给插件插探针跑真机）：

```
[PROBE] settings inject block ENTERED
[PROBE] installSection THREW: settingsCtx.settings.installSection is not a function
```

这个 throw 被 cordis 的 inject 回调静默吞掉，所以**插件仍能启动**（provider 注册、
51 个模型、额度接口都正常），但**设置页那一块没了**。

---

## 二、改了哪三个文件（`git diff --ignore-cr-at-eol`）

```
 lib/index.js |  99 ++++++++++++++++++++------------
 package.json |  12 ++++--
 src/index.ts | 116 ++++++++++++++++++++++++++++------------
 3 files changed, 177 insertions(+), 50 deletions(-)
```

其余 `lib/*.js` 的 git 状态是 CRLF 噪音，内容与上游逐字节一致。

### 1. `Config` schema 加 `.volatile()`（`src/index.ts`）

0.1.7 的 settings 改为「投影 Loader 配置」：**只有带 `.volatile()` 的字段**才会被
`dsh-settings` 的 `volatileForm()` 选中并渲染成可编辑表单。

```ts
export const Config = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(...).volatile(),
  baseURL: z.string().default(...).volatile(),
  maxTokens: z.number()...default(...).volatile(),
  defaultContextWindow: z.number()...default(...).volatile(),
  retryPolicy: RetryPolicySchema.volatile(),
}) as unknown as z<Config>
```

**关键细节**：`.volatile()` 让运行时解析结果是 `{ get() }` 引用而不是裸值。
所以新增 `plainOptions()`，在读取边界统一取值：

```ts
function plainOptions(config: Config): Config {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, isVolatile(value) ? value.get() : value]),
  ) as Config
}
```

`resolveAdapterOptions()` 改用 `plainOptions(config)`。非 volatile 字段原样返回，
所以旧版运行时行为不变。

> schema 必须从 `@deepseek-ai/schemastery` 导入（profile 里是 3.18.4）。
> 裸 `schemastery@3.18.0` **没有运行时的 `.volatile()`**。

### 2. `installSection` → `configure({ auto: false })`

```ts
ctx.inject(['settings'], (settingsCtx) => {
  settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  // 兼容 0.1.5：它没有 configure()，只有已被 0.1.7 删除的 installSection
  const legacy = settingsCtx.settings as unknown as { installSection?: (...args: unknown[]) => void }
  if (typeof legacy.installSection === 'function') { /* 走老路 */ }
})
```

`auto: false` = 「本插件有自己的页面」（client.js 注册的 `settings.section`），
不要让 settings 再自动生成一个重复页面。

### 3. `settingsNs` 改为 entry id

```ts
const settingsNs = ctx.fiber?.entry?.options.id ?? NS   // 0.1.7 上是 'cmdgo-provider'
```

0.1.5 用插件自报的 `NS`（`'cmdgo'`）；0.1.7 的表单按 **entry id** 作键
（`dsh-settings` 的 `describe()`：`ns: entry.options.id`）。这个值同时传给
`registerConfigurableProviders`，Models 页靠它找回配置。

### 4. 配置热更新：`loader/volatile-update`

**这是最容易漏的一处。** volatile 字段是**原地更新**的稳定引用——`config` 对象
身份不变，所以插件里按 `raw` 身份做键的 `options()` 缓存**永远不会自己失效**。

0.1.7 的 loader 在提交新值后向拥有者 fiber 派发 `loader/volatile-update`：

```ts
ctx.on('loader/volatile-update', () => {
  cache = undefined
  ensureRegistrationFacts()
})
```

探针实测证明它必要：

```
[PROBE] volatile-update fired paths=[["maxTokens"]]
[PROBE] after clear: baseURL=https://api.commandcode.ai maxTokens=54321
```

### 5. `package.json`

- `dsh.client.inject` 去掉 `@deepseek-ai/dsh-client-runtime`（0.1.7 全树不存在）。
  真正的闸门是 `exports.inject = ['slots']`，`slots` 在 0.1.7 正常。
- 新增 peer `@deepseek-ai/cosmokit`（`isVolatile` 的来源）。

---

## 三、验证结果（真机，非推断）

在隔离 profile 里装同一份 link，用真 key 跑：

| 项 | 结果 |
|---|---|
| 冷启动 | stderr **全空**，无 activation failure |
| 模型目录 | `modelCount=51` |
| 额度链路 | `plan=Go 剩$4.3214/$10 已用56.8%`，5H `$3/$3`，周 `$6/$6` |
| 客户端清单 | `dsh-cmdgo-provider` 在 manifest，inject 全部可解析 |
| **设置页表单** | `settings/describe` → `cmdgo-provider` 存在，`autoGenerate: false`，describes 5 个字段 |
| **表单可写** | `settings/update` 改 `maxTokens` → revision 0→1，落盘到 `cordis.patch.yml` |
| **热更新生效** | `volatile-update` 触发，`options()` 重新解析出新值 |

设置页 schema 实测包含全部 5 个字段：
`apiKeyEnv` / `baseURL` / `maxTokens` / `defaultContextWindow` / `retryPolicy`
（`volatile` 标记被 `volatileForm` 按设计剥掉）。

---

## 三点五、本 fork 自加的功能：模型开关 + HUD 开关

上游没有的功能，按用户要求新增（对齐 `dsh-codearts-auth` 的 Jet Hub 模型开关）。

### 模型开关（黑名单制）

- **唯一过滤点**是 `adapter.listModels()`：关掉的模型只从 Models 页与 composer
  的选择器消失；`resolveModel()` 与请求路由**完全不受影响**。
  这个取舍很重要——若目录成员资格锁死请求，关掉一个正在用的模型会让那个会话直接报错。
- **黑名单**：只有被显式关闭的 id 进表。上游新增模型自动可见，用户不必逐个放行；
  反复开关也不会让文件膨胀（打开 = 删键，而不是写 `false`）。
- **落地**：`~/.dsh/cmdgo-prefs.json`，与 `cmdgo-accounts.json` / `cmdgo-meter.json`
  同目录，用 `homedir()` 而非 `DSH_HOME`。
- **即时生效**：开关后调 `registration.replace([PROVIDER])`，它会广播
  `llm/adapters-updated`，客户端的 `catalog.refresh()`（`dsh-client-ui-model-selection`）
  随即重取目录——不用刷新页面。

### HUD 开关

`prefs.hudEnabled` 为 `false` 时 `QuotaHudPill` 直接返回 `null`（不渲染胶囊）。
面板的数据轮询照常，只是入口收起——关掉胶囊不等于停止读额度。

### 新增接口（都在既有 `/api/cmdgo` 前缀下）

| 方法 | 作用 |
|---|---|
| `POST /api/cmdgo/model/toggle` | `{id, hidden}` 关/开单个模型 |
| `POST /api/cmdgo/model/hide-all` | 批量关闭**当前目录**里的全部模型 |
| `POST /api/cmdgo/model/show-all` | 清空黑名单。刻意**不看当前目录**直接清空——否则「曾关闭、后下线」的遗留键永远清不掉 |
| `POST /api/cmdgo/hud/toggle` | `{enabled}` 会话头部胶囊显示开关 |

`GET /api/cmdgo/status` 新增两个字段：`models`（完整目录，含已隐藏项）与
`prefs`（`{hiddenModels, hudEnabled}`）——设置页要能列出隐藏项才能把它们打开。

### 实测

```
BEFORE hide : commandcode group has 51 models
hide 4 real + 1 non-existent id
AFTER hide  : 47 models,  hidden ids still listed -> (empty)
show-all    : 51 models
hud/toggle  : {"ok":true,"hiddenModels":[],"hudEnabled":false}
restart     : hudEnabled 仍为 false（落盘生效）
```

### 涉及的新文件

`src/prefs.ts` → `lib/prefs.js`（`CmdgoPrefs` 类：加载 / 落盘 / 黑名单增删）。
测试时注意它与 `pool.ts` / `meter.ts` 一样写**真实** `~/.dsh/`，隔离 profile
里跑也会动到真文件——测前务必备份。

---

## 四、重新构建的方法

`lib/` 是 tsc 产物，但**上游 `src/` 在 0.1.7 类型下有 23 个预存错误**
（`adapter.ts` / `protocol.ts` 的 API 漂移）。这些错误**不影响 emit**——实测
tsc 仍产出与 npm 发布版**逐字节一致**的 `lib/*.js`。

重建步骤（隔离目录，避免污染插件目录）：

```powershell
$bd = "$env:TEMP\ccgo-build"
robocopy <plugin> $bd /E /XD node_modules .git
# 把 dsh 安装里的 @deepseek-ai/* junction 进 $bd\node_modules
# 再把 typescript + @types/node 装进一个 scratch 目录并 junction 进来
node "$bd\node_modules\typescript\bin\tsc" -p "$bd\tsconfig.json"
# 期望：仅 adapter.ts / protocol.ts 报错，index.ts 干净
Copy-Item "$bd\lib\*.js" <plugin>\lib\ -Force
```

> `lib/client.js` 是手写的 `__ModuleLoader__` bundle，**不参与 tsc**，不要动它。

改完记得清掉 `$bd`。插件目录本身**不应有 `node_modules`**——依赖由 profile 解析。

---

## 五、注意事项

1. **profile 里是 `link:` 依赖**，改 `lib/` 后需重启 `dsh web` 才生效
   （`patchReload: live` 只对 patch 文件热重载，不改已加载的模块）。
2. **上游已冻结**：npm `latest` 停在 0.9.1，插件不会再更新。
   任何未来的 `pnpm install` 都不会覆盖本地 link 的内容。
3. **`pool.js` / `meter.js` 用 `homedir()/.dsh`，不是 `DSH_HOME`**——
   测试时会在隔离 profile 里读写**真实**的 `~/.dsh/cmdgo-*.json`。测试前务必备份。
4. 与 `@jiesou/dsh-commandcode-go-provider` **provider id 都是 `commandcode`，不能共存**。
5. 未处理：上游 `peerDependencies` 范围写 `>=0.1.0-rc.6 <0.2.0`，会把 0.1.7
   放进来 → 安装不报错、启动才炸。已修正为本地 fork，值得给作者提 issue。
