# dsh-cmdgo-provider 本地 fork · dsh 0.2.0 适配记录

> 时间：2026-09-29
> 位置：`C:\Users\Loner\.dsh\profiles\web\commandcode-go\`
> 上一份记录：[`DSH-0.1.7-适配说明.md`](DSH-0.1.7-适配说明.md)
> 本 fork 版本号：`0.9.1-dsh017.2`（上一版 `0.9.1-dsh017.1`）

---

## 一、结论先行

**改的只有 `package.json` 里 6 条 peer 范围，`lib/` 与 `src/` 一行未动。**

原因是实测：dsh 0.2.0-rc.1 对 cmdgo 用到的**每一个**宿主 API 都保持逐字节不变。
这是有证据的，不是推断——见第三节。

### 唯一的真实故障：peer 范围写死 `<0.2.0`

```
@deepseek-ai/dsh-{credentials,launch-environment,llm,settings,timeout,util-values}
  旧: >=0.1.0-rc.6 <0.2.0
  新: >=0.1.0-rc.6 <0.2.0 || ^0.2.0-rc.1
```

`dsh-app-boot` 的 `evaluatePluginCompatibility()` 只检查 `@deepseek-ai/dsh` 与
`@deepseek-ai/dsh-*` 这两类 peer，用
`semver.satisfies(runtimeVersion, range, { includePrerelease: true })`
判定；不兼容时安装与启动都会拒绝，除非写精确版本豁免。

**一个反直觉的实测结果**：旧范围在 `0.2.0-rc.1` 上其实是**通过**的——
因为 `>=0.1.0-rc.6 <0.2.0` 的 `<0.2.0` 不含预发布语义时，`0.2.0-rc.1 < 0.2.0` 成立。
真正会被拒的是**将来的稳定版 `0.2.0`**。所以这次改动是"提前把路铺好"，
而不是"修复当前故障"：

| 运行时 | 旧范围 | 新范围 |
|---|---|---|
| 0.1.5-rc.1 / 0.1.6-rc.1 / 0.1.7-rc.2 | PASS | PASS |
| 0.2.0-rc.1 | PASS | PASS |
| **0.2.0（稳定版）** | **FAIL** | PASS |

验证方式是用 0.2.0 自己的 `evaluatePluginCompatibility()` 传入真实 manifest 实跑，
而不是手写 semver 判断。

---

## 二、为什么代码不用改（证据）

### 1. 类型定义逐字节相同

对 cmdgo 实际 import 的包，比对 0.1.7-rc.2 与 0.2.0-rc.1 的**全部** `.d.ts`：

| 包 | 相同 | 差异 |
|---|---|---|
| `dsh-settings` | 4 | 0 |
| `dsh-llm` | 16 | 0 |
| `dsh-host-webserver` | 2 | 0 |
| `dsh-attachment` | 6 | 0 |
| `dsh-client-connection` | 16 | 0 |
| `dsh-client-ui-slots` | 3 | 0 |

### 2. 实现文件也逐字节相同

| 包 | .js 文件数 | 差异 |
|---|---|---|
| `dsh-settings` | 5 | 0 |
| `dsh-llm` | 18 | 0 |
| `dsh-host-webserver` | 1 | 0 |
| `dsh-attachment` | 7 | 0 |
| `dsh-client-connection` | 2 | 0 |
| `dsh-credentials` | 8 | 0 |
| `dsh-timeout` | 2 | 0 |
| `dsh-launch-environment` | 2 | 0 |
| `dsh-util-values` | 2 | **1** |

`dsh-util-values` 的唯一差异在**内部**函数 `hasIntrinsicConstructor`，
是跨 realm 原生构造器识别的加固；cmdgo 用的 `deepEqualJson` 导出与语义未变：

```diff
- return constructor.name === name && ... && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`
+ return constructor.name === name && ... && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(name === "Array" ? Array : Object)
```

### 3. 客户端模块系统两版完全相同

`dsh-client-modules` 的 `lib/index.js`（41704B）与 `lib/client.js`（40277B）
在 0.1.7-rc.2 与 0.2.0-rc.1 上 **MD5 相同**。插件 bundle 的加载路径没变。

### 4. 契约探针 15/15 通过

在装好 `dsh@0.2.0-rc.1` 的解析环境里逐项 import cmdgo 使用的每个符号：

```
PASS  @deepseek-ai/schemastery            -> default
PASS  @deepseek-ai/cosmokit               -> isVolatile
PASS  @deepseek-ai/dsh-llm                -> assertUsableApiKey / LlmError / resolveRetryPolicy
PASS  @deepseek-ai/dsh-llm                -> RetryPolicySchema / attributionHeaders
PASS  @deepseek-ai/dsh-llm                -> CONTEXT_WINDOW_EXCEEDED_CODE / isContextWindowExceededError
PASS  @deepseek-ai/dsh-credentials        -> credentialRef
PASS  @deepseek-ai/dsh-launch-environment -> launchEnvironmentOf
PASS  @deepseek-ai/dsh-util-values        -> deepEqualJson
PASS  @deepseek-ai/dsh-timeout            -> idleWatchdog / timeoutOf
PASS  schemastery 运行时 .volatile() 可用      ← 0.1.7 适配的核心前提，0.2.0 仍在
```

### 5. peer 解析指向会跟着升级

`profiles/node_modules/@deepseek-ai/*` 全部 **244 项都是指向全局 dsh 安装的
junction**（`C:\Users\Loner\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\*`）。
升级全局 dsh 后这些链接自动指向新版本，**不存在残留的 0.1.7 副本**。

---

## 三、真机验证结果

### 组合树（不启动）

| 运行时 | 退出码 | 错误/告警行 | 5 个插件 |
|---|---|---|---|
| `0.1.7-rc.2` | 0 | 0 | 全部 OK |
| `0.2.0-rc.1` | 0 | 0 | 全部 OK |

### 插件自带 smoke 套件

6/6 通过：`smoke-protocol` / `smoke-repair` / `smoke-go-plan` /
`smoke-request-stats` / `smoke-meter` / `smoke-client`。

### 真实启动 + HTTP 实证（最强证据）

用 `dsh@0.2.0-rc.1` 实际启动 web profile：

```
dsh web: http://127.0.0.1:7805/?token=...
stderr: (全空 —— 无 activation failure)

GET /api/cmdgo/status -> HTTP 200 (6989B)
  ok      = True
  账号数  = 1
  模型数  = 53
  prefs   = {"hiddenModels":[...51 个...],"hudEnabled":false}
```

插件不仅在组合树里"存在"，其 **HTTP 路由、额度链路、模型目录、
prefs 黑名单全部在 0.2.0 宿主里实际工作**。

---

## 四、注意事项

1. **`patchReload: live` 不会重载已加载的模块**。改 `package.json` 的 peer
   范围后需**重启 `dsh web`** 才生效（本次未重启宿主，改动在下次启动生效）。
2. 六个 smoke 测试会写**真实** `~/.dsh/cmdgo-*.json`（`pool.ts`/`meter.ts`/`prefs.ts`
   用 `homedir()` 而非 `DSH_HOME`）。测试前已备份，实测仅 `cmdgo-meter.json`
   的 `updatedAt` 被更新，业务数据未变。
3. 本 fork 仍未处理上游其余问题；`@jiesou/dsh-commandcode-go-provider`
   的 provider id 同为 `commandcode`，**不能共存**。
4. 上游 npm `latest` 冻结在 0.9.1，不会覆盖本地 link 内容。
5. 建议给上游提 issue：`peerDependencies` 的 `<0.2.0` 上限会在 dsh 0.2.0
   稳定版发布时直接拒装。

---

## 五、回滚

只改了一个文件，回滚即把 6 条 peer 改回：

```
">=0.1.0-rc.6 <0.2.0"
```

并把 `version` 改回 `0.9.1-dsh017.1`。`lib/` 与 `src/` 从未改动，
无需重新构建。

---

## 六、补记（2026-10-03）：peer 下限收到 `0.1.7-rc.1`

第一节当时只加了 `|| ^0.2.0-rc.1` 把**上限**铺好（`<0.2.0` 会在 0.2.0 稳定版拒装），
**下限**仍留着上游的 `>=0.1.0-rc.6`。把下限也按实际改掉：

```
6 条 @deepseek-ai/dsh-* peer（credentials / launch-environment / llm / settings / timeout / util-values）
  旧: >=0.1.0-rc.6 <0.2.0 || ^0.2.0-rc.1
  新: >=0.1.7-rc.1  <0.2.0 || ^0.2.0-rc.1
```

**为什么下限是 0.1.7 而不是 0.1.0-rc.6**：0.1.7 是 settings 的**破坏性更新**
（删除 `installSection`，改为投影 Loader 配置 + volatile 表单，见
[`DSH-0.1.7-适配说明.md`](DSH-0.1.7-适配说明.md)），本 fork 的代码正是为它改的，
且真机验证只做过 **0.1.7-rc.2 / 0.2.0-rc.1（本轮补 0.2.0-rc.2）**；
`0.1.0-rc.6 ~ 0.1.6` 走的是 legacy `installSection` 分支，本 fork 从未复验，
继续宣称支持只是继承上游的声明。

**为什么写 `0.1.7-rc.1` 而不是 `0.1.7`**：dsh 的判定是
`semver.satisfies(runtimeVersion, range, { includePrerelease: true })`
（`@deepseek-ai/dsh-app-boot/lib/index.js:300`，只检查 `@deepseek-ai/dsh` 与
`@deepseek-ai/dsh-*` 两类 peer）。预发布版**小于**同号稳定版，实测：

```
semver 7.8.5（dsh 自带）
  0.1.7-rc.2 满足 ">=0.1.7"   -> false   ← 写 >=0.1.7 会把 rc 运行时判成不兼容
  0.1.7-rc.2 满足 ">=0.1.7-rc.1" -> true
  "^0.2.0-rc.1" 归一化        -> >=0.2.0-rc.1 <0.3.0-0
  0.2.0-rc.2 满足新范围        -> true
```

**兼容矩阵**（同一函数、同一 semver，非手写判断）：

| 运行时 | 旧范围 `>=0.1.0-rc.6 <0.2.0` | 现范围 `>=0.1.7-rc.1 <0.2.0 \|\| ^0.2.0-rc.1` |
|---|---|---|
| 0.1.0-rc.6 | PASS | **FAIL（刻意收紧）** |
| 0.1.5-rc.1 / 0.1.6-rc.1 | PASS | **FAIL（刻意收紧）** |
| 0.1.7-rc.1 / 0.1.7-rc.2 / 0.1.7 / 0.1.8 | PASS | PASS |
| 0.2.0-rc.1 / **0.2.0-rc.2（当前使用）** | PASS | PASS |
| 0.2.0（稳定版）/ 0.2.1 | **FAIL** | PASS |
| 0.3.0-rc.1 | FAIL | FAIL（`<0.3.0-0` 挡住预发布） |

即：**真机验证过的区间 = `0.1.7-rc.1` ~ `0.2.x`**，其中 `0.2.0-rc.2` 是当前实际运行的版本。

**回滚 / 放宽**：若要重新支持 0.1.5/0.1.6，把 6 条下限改回 `>=0.1.0-rc.6` 即可——
legacy `installSection` 分支仍在代码里，未删。

**本次改动的范围**：只有 `package.json`（6 条 peer + 描述里的版本说明 + 版本号
`0.9.1-dsh017.2` → `0.9.1-dsh017.3`）与本补记，`lib/` 与 `src/` 一行未动，无需重新构建。
改完需**重启 `dsh web`**（`patchReload: live` 不重载已加载的模块），
否则运行中的进程仍按旧 manifest 判定。

## 七、补记（2026-10-03）：版本号改为 `0.9.1-dsh020.2`

上一节的 `dsh017` 后缀写的是**适配起点**（0.1.7），但当前真机跑的是 `0.2.0-rc.2`，
插件市场里显示 `v0.9.1-dsh017.3 · 本地开发` 会让人以为它只服务 0.1.7
（0.1.7 只是**下限**，上限已经实测到 0.2.x）。故把后缀改成**当前运行版本**：

```
0.9.1-dsh017.3  →  0.9.1-dsh020.2      （dsh 0.2.0-rc.2）
```

- 命名规则：`0.9.1-dsh<主>.<次><补丁>.<rc>` —— `020.2` = `0.2.0-rc.2`。
- **semver 方向是升级**，不是降级：预发布标识符逐字符比较，`...-dsh017.3 < ...-dsh020.2`。
- 改动只有 `package.json` 的 `version` 一行，`peerDependencies` 的区间、
  `lib/`、`src/` 全部未动，**无需重新构建**。
- 插件市场（`dshmarket`）每次扫描都**实时读** profile 下
  `node_modules/<插件>/package.json`（即本地 junction 指向的本仓库），
  所以改完**刷新市场页面**即可看到新版本号，不必重启 `dsh web`，也没有版本缓存要清。
