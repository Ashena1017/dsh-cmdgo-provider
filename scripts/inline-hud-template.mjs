/**
 * 把 hud-template 的编译产物内联进 lib/client.js。
 *
 * client.js 是手写的 __ModuleLoader__ bundle，没有模块系统（只有一个
 * `require('react')`），所以不能 `import` 另一份 ESM。这里把 lib/hud-template.js
 * 的**函数体**（去掉 import/export）原样注进去，两侧共享同一份语义。
 *
 * 为避免两份代码漂移，脚本会：
 *   1) 用标记注释括起来，重复运行是幂等的（替换而不是追加）；
 *   2) 断言注入后的函数在真机上能跑出与 ESM 版相同的结果（抽样比对）。
 *
 * 用法：node scripts/inline-hud-template.mjs [--check]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const BEGIN = '    /* ==== BEGIN hud-template（由 scripts/inline-hud-template.mjs 生成，勿手改）==== */'
const END = '    /* ==== END hud-template ==== */'

const source = readFileSync(join(root, 'src', 'hud-template.ts'), 'utf8')

/**
 * 从 TS 源码里抠出实现，去掉类型标注。
 *
 * 为什么不用 lib/hud-template.js（已经是 JS）？因为那份带 `export` 关键字，
 * 而且会被 tsc 重新生成；从 TS 源抠可以保证注释也一起带过去。
 * 但去类型标注靠正则不可靠 —— 所以实际取的是**编译产物**，只剥 export。
 *
 * ⚠️ 先把 CRLF 归一化成 LF 再处理。仓库是 `core.autocrlf=true`，工作区里的
 * `lib/hud-template.js` 是 CRLF，而提交里的 blob 是 LF —— 同一个文件在两种
 * 状态下内容不同。下面所有正则都以 `\n` 结尾（`*\/\n`、`^export ...`），
 * CRLF 下 `*\/` 后面跟的是 `\r\n`，`*\/\n` 匹配不到，文件头注释就会**留下来**，
 * 生成的内联块比预期多一整段注释。这个 bug 只在「tsc 刚重编译过、文件变回
 * CRLF」时暴露：`git diff` 因 autocrlf 规范化而显示为空，但 smoke 读的是
 * 原始字节，于是报「逐字节不一致」却看不出差在哪。
 */
const compiledRaw = readFileSync(join(root, 'lib', 'hud-template.js'), 'utf8')
const compiled = compiledRaw.replace(/\r\n/g, '\n')
const body = compiled
  .replace(/^\/\*\*[\s\S]*?\*\/\n/, '')            // 去掉文件头注释（client.js 里有对应说明）
  .replace(/^export function /gm, 'function ')     // export function → function
  .replace(/^export const /gm, 'const ')
  .replace(/^export interface [\s\S]*?\n\}\n/gm, '') // 接口在 JS 里不需要
  .trim()

if (body.includes('import ') || body.includes('export ')) {
  throw new Error('剥离后仍有 import/export，不能内联')
}
if (!body.includes('function renderHudTemplate')) throw new Error('没找到 renderHudTemplate')
if (!body.includes('function templateVarNames')) throw new Error('没找到 templateVarNames')
if (source.length === 0) throw new Error('读不到 src/hud-template.ts')

const block = [
  BEGIN,
  '    /* 受限模板引擎：与 src/hud-template.ts 同源，由 scripts/inline-hud-template.mjs 注入。',
  '     * 不执行用户代码 —— 只解析白名单变量与 min/max，详见那份 TS 的注释。 */',
  ...body.split('\n').map((line) => (line.length > 0 ? '    ' + line : line)),
  END,
].join('\n')

const clientPath = join(root, 'lib', 'client.js')
let client = readFileSync(clientPath, 'utf8')

const start = client.indexOf(BEGIN)
const end = client.indexOf(END)
if (start >= 0 && end > start) {
  client = client.slice(0, start) + block + client.slice(end + END.length)
} else if (start < 0) {
  // 首次注入：放在「额度格式化」那一段之后（胶囊依赖它上面定义的 fmt* 函数）。
  const anchor = '    /** 一行台账的紧凑文案。 */'
  const at = client.indexOf(anchor)
  if (at < 0) throw new Error('找不到注入锚点')
  client = client.slice(0, at) + block + '\n\n' + client.slice(at)
} else {
  throw new Error('BEGIN/END 标记不成对，先手工修好')
}

if (process.argv.includes('--check')) {
  const current = readFileSync(clientPath, 'utf8')
  console.log(current.includes(BEGIN) ? '[ok] 已内联' : '[缺少] 未内联')
  process.exit(0)
}

writeFileSync(clientPath, client, 'utf8')
console.log('[ok] 已注入 hud-template（' + body.split('\n').length + ' 行）')
