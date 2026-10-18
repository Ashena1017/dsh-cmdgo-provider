/**
 * 内联块与源码的一致性校验。
 *
 * 这是这个功能最脆的地方：client.js 里的引擎是**生成**的，改 src/hud-template.ts
 * 却忘了重跑内联脚本，两边的行为就会不一致 —— 而且不会有任何报错，只是
 * 某些模板在设置页预览正常、在胶囊上却是另一回事。
 *
 * 所以这里做两件事：
 *   1. 重新生成一遍内联块，与 client.js 里现有的逐字节比对；
 *   2. 用同一批用例分别跑「ESM 版」和「从 client.js 抠出来的那份」，
 *      断言输出完全相同（防的是脚本剥离代码时悄悄改坏语义）。
 */
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let fails = 0
const check = (label, ok, extra) => {
  if (ok) console.log('  ok  ' + label)
  else { fails += 1; console.log('  FAIL ' + label + (extra ? ' → ' + extra : '')) }
}

const BEGIN = '    /* ==== BEGIN hud-template（由 scripts/inline-hud-template.mjs 生成，勿手改）==== */'
const END = '    /* ==== END hud-template ==== */'
const client = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
const compiled = readFileSync(join(root, 'lib', 'hud-template.js'), 'utf8')

console.log('[1] 内联块存在且成对')
const beginCount = client.split(BEGIN).length - 1
const endCount = client.split(END).length - 1
check('BEGIN 恰好一次', beginCount === 1, 'got ' + beginCount)
check('END 恰好一次', endCount === 1, 'got ' + endCount)
if (beginCount !== 1 || endCount !== 1) { console.log('\n标记不成对，后续检查跳过。'); process.exit(1) }

const at = client.indexOf(BEGIN)
const to = client.indexOf(END) + END.length
const inlined = client.slice(at, to)

console.log('[2] 内联块与 lib/hud-template.js 同步')
// 用与内联脚本相同的规则重算一遍，逐字节比对。
// ⚠️ 两侧都先归一化成 LF：仓库 autocrlf=true，工作区文件是 CRLF，而 client.js
// 里的内联块是 LF（提交时规范化的）。不归一化就会拿苹果比橘子 —— 而且报错
// 只说「字节数不一致」，看不出是换行符差异。这与 inline-hud-template.mjs
// 的处理保持一致（那边也必须先归一化，否则 `*\/\n` 匹配不到 CRLF 的文件头）。
const norm = (s) => s.replace(/\r\n/g, '\n')
const body = norm(compiled)
  .replace(/^\/\*\*[\s\S]*?\*\/\n/, '')
  .replace(/^export function /gm, 'function ')
  .replace(/^export const /gm, 'const ')
  .trim()
const expected = [
  BEGIN,
  '    /* 受限模板引擎：与 src/hud-template.ts 同源，由 scripts/inline-hud-template.mjs 注入。',
  '     * 不执行用户代码 —— 只解析白名单变量与 min/max，详见那份 TS 的注释。 */',
  ...body.split('\n').map((line) => (line.length > 0 ? '    ' + line : line)),
  END,
].join('\n')
const inlinedNorm = norm(inlined)
check('逐字节一致（不一致 → 忘了重跑 scripts/inline-hud-template.mjs）',
  inlinedNorm === expected,
  'inlined ' + inlinedNorm.length + ' 字节 vs expected ' + expected.length + ' 字节')

console.log('[3] client.js 只内联了一次（重复注入会让后一份覆盖前一份）')
check('renderHudTemplate 在 client.js 里只定义一次',
  (client.match(/function renderHudTemplate/g) || []).length === 1,
  'got ' + (client.match(/function renderHudTemplate/g) || []).length)

/* 内联块里不能带 lib/hud-template.js 的**文件头注释**。
 *
 * 这条单独钉，是因为上面那条「逐字节一致」在 CRLF 下曾经假通过：正则
 * `*\/\n` 匹配不到 `*\/\r\n`，文件头注释留了下来，而比对两侧用了同一套
 * 有 bug 的规则，于是两边一致、测试却绿。现在比对前统一归一化，但**仍然
 * 要独立断言「注释没混进来」** —— 否则将来若有人再引入同类换行假设，
 * 两侧同时出错仍会互相掩盖。 */
const headerLine = '胶囊文字的**受限模板引擎**'
check('内联块里没有 lib/hud-template.js 的文件头注释',
  !inlined.includes(headerLine), '内联块里混进了文件头注释')
/* 反向：确认这段注释确实存在于编译产物里 —— 否则上面的断言可能因为
 * 注释被改名而永远通过（那就不再是门禁）。 */
check('（前提）编译产物里确实有那段文件头注释',
  norm(compiled).includes(headerLine), '编译产物里找不到，说明断言已失效')

console.log('[4] 抠出来的那份与 ESM 版行为一致')
// 把内联块包成一个可导入的模块，用同一批用例对拍。
const cases = [
  'CC {window} {pctTight}',
  '剩{min(a, b, c)}',
  'a{b}c',
  '\\{literal\\}',
  '${x}',
  '{nope}',
  '没闭合 {x',
  '{min(a)}',
  '{min(a, b, c, d, e, f, g, h, i)}',
  '{1+1}',
  '{constructor}',
  '{max(a, b)}',
  '',
]
const vars = [
  { name: 'window', label: '', get: () => '5H' },
  { name: 'pctTight', label: '', get: () => '80.0%' },
  { name: 'a', label: '', get: () => '$0.60' },
  { name: 'b', label: '', get: () => '$2.50' },
  { name: 'c', label: '', get: () => '$12.40' },
  { name: 'x', label: '', get: () => 'VAL' },
  { name: 'e', label: '', get: () => undefined },
]

const esm = await import(pathToFileURL(join(root, 'lib', 'hud-template.js')).href)

// 用内联块做一份临时模块。变量表要显式传进去，所以这里只需要函数本身。
const tmp = mkdtempSync(join(tmpdir(), 'cmdgo-inline-'))
const stubPath = join(tmp, 'inlined.mjs')
writeFileSync(stubPath, inlined
  .replace(/^ {4}/gm, '')
  .concat('\nexport { renderHudTemplate, templateVarNames };\n'), 'utf8')
const viaClient = await import(pathToFileURL(stubPath).href)

for (const tpl of cases) {
  const a = esm.renderHudTemplate(tpl, vars)
  const b = viaClient.renderHudTemplate(tpl, vars)
  check('行为一致：' + JSON.stringify(tpl),
    JSON.stringify(a) === JSON.stringify(b),
    'esm=' + JSON.stringify(a) + ' client=' + JSON.stringify(b))
}
{
  const a = JSON.stringify(esm.templateVarNames('{a} {b} {min(a,c)}'))
  const b = JSON.stringify(viaClient.templateVarNames('{a} {b} {min(a,c)}'))
  check('templateVarNames 一致', a === b, 'esm=' + a + ' client=' + b)
}
rmSync(tmp, { recursive: true, force: true })

console.log(fails === 0 ? '\n内联一致性校验通过。' : `\n${fails} 项失败。`)
process.exitCode = fails === 0 ? 0 : 1
