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
const body = compiled
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
check('逐字节一致（不一致 → 忘了重跑 scripts/inline-hud-template.mjs）',
  inlined === expected,
  'inlined ' + inlined.length + ' 字节 vs expected ' + expected.length + ' 字节')

console.log('[3] client.js 只内联了一次（重复注入会让后一份覆盖前一份）')
check('renderHudTemplate 在 client.js 里只定义一次',
  (client.match(/function renderHudTemplate/g) || []).length === 1,
  'got ' + (client.match(/function renderHudTemplate/g) || []).length)

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
