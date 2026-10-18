/**
 * hud-template 的单测：模板语义的契约。
 *
 * 重点是「不该发生的事」：不执行代码、不穿透白名单、脏模板不炸 UI。
 */
import { renderHudTemplate, templateVarNames } from '../lib/hud-template.js'

let fails = 0
const check = (label, ok, extra) => {
  if (ok) console.log('  ok  ' + label)
  else { fails += 1; console.log('  FAIL ' + label + (extra ? ' → ' + extra : '')) }
}

/** 一组固定变量的桩：模拟"数据齐了"的正常情况。 */
const vars = [
  { name: 'remain5h', label: '5H 剩余额度', get: () => '$0.60' },
  { name: 'remainWeek', label: '周剩余额度', get: () => '$2.50' },
  { name: 'remainMonth', label: '月剩余额度', get: () => '$12.40' },
  { name: 'pct5h', label: '5H 百分比', get: () => '80.0%' },
  { name: 'pctWeek', label: '周百分比', get: () => '41.7%' },
  { name: 'pctMonth', label: '月百分比', get: () => '12.4%' },
  { name: 'pctMin', label: '最紧百分比', get: () => '80.0%' },
  { name: 'pctTight', label: '最紧百分比(无符号)', get: () => '80.0' },
  { name: 'window', label: '最紧窗口名', get: () => '5H' },
  { name: 'account', label: '最紧账号', get: () => 'alice' },
  { name: 'totalMonth', label: '月合计', get: () => '$13.00' },
  { name: 'calls', label: '理论次数', get: () => '260' },
  { name: 'count', label: '账号数', get: () => '2' },
]

console.log('[1] 基本插值')
{
  const r = renderHudTemplate('CC ${window} ${pctMin}', vars)
  check('两个变量', r.text === 'CC 5H 80.0%', r.text)
  check('无未知变量', r.unknown.length === 0, JSON.stringify(r.unknown))
  check('无语法错误', r.error === undefined, r.error)
}
{
  const r = renderHudTemplate('纯文字没有变量', vars)
  check('没有变量时原样输出', r.text === '纯文字没有变量', r.text)
}
{
  const r = renderHudTemplate('', vars)
  check('空模板返回空串（调用方据此用默认排版）', r.text === '' && r.error === undefined)
}

console.log('[2] 花括号与转义')
// 反斜杠在源码里要写两层、在 shell 里还要再叠一层，很容易测出"假失败"。
// 这里统一用 BS / D 显式拼，测的就是字符串本身，不掺转义层数的问题。
const BS = String.fromCharCode(92)
const D = String.fromCharCode(36)
{
  check('单花括号也能插值（{x} 等价于 ${x}）', renderHudTemplate('{pctMin}', vars).text === '80.0%')
  check('两种写法混用', renderHudTemplate(D + '{pctMin} {window}', vars).text === '80.0% 5H')
  check('BS+{ 输出字面量 {', renderHudTemplate('a' + BS + '{b', vars).text === 'a{b')
  check('BS+} 输出字面量 }', renderHudTemplate('a' + BS + '}b', vars).text === 'a}b')
  // 转义只作用于紧邻的那一个字符，所以「字面量 ${x}」要把三个字符都转义。
  // 这条语义是刻意的：逐字符转义可预测，不需要记住"某个组合会整体失效"。
  check('BS+$ 只转义 $ 本身（后面的 {pctMin} 仍是插值）',
    renderHudTemplate(BS + D + '{pctMin}', vars).text === D + '80.0%')
  check('三个字符都转义才输出完整字面量 ${pctMin}',
    renderHudTemplate(BS + D + BS + '{pctMin' + BS + '}', vars).text === D + '{pctMin}')
}
{
  check('$ 后面不是 { 时按字面量', renderHudTemplate('花 $5', vars).text === '花 $5')
  check('孤立的 } 按字面量输出', renderHudTemplate('a}b', vars).text === 'a}b')
}

console.log('[3] 未知变量要能看见')
{
  const r = renderHudTemplate('${nope} 和 ${window}', vars)
  check('未知变量渲染成 ?', r.text === '? 和 5H', r.text)
  check('回报未知变量名', r.unknown.length === 1 && r.unknown[0] === 'nope', JSON.stringify(r.unknown))
}
{
  const r = renderHudTemplate('${a} ${a}', vars)
  check('重复的未知变量只报一次', r.unknown.length === 1, JSON.stringify(r.unknown))
}

console.log('[4] 数据未到 → 破折号')
{
  const empty = [{ name: 'x', label: 'X', get: () => undefined }]
  check('undefined → —', renderHudTemplate('${x}', empty).text === '—')
  const nul = [{ name: 'x', label: 'X', get: () => null }]
  check('null → —', renderHudTemplate('${x}', nul).text === '—')
  const blank = [{ name: 'x', label: 'X', get: () => '' }]
  check('空串 → —', renderHudTemplate('${x}', blank).text === '—')
  const zero = [{ name: 'x', label: 'X', get: () => 0 }]
  check('0 保持不变（不是"没有值"）', renderHudTemplate('${x}', zero).text === '0')
}

console.log('[5] min / max')
{
  const r = renderHudTemplate('${min(pct5h, pctWeek, pctMonth)}', vars)
  // 80.0 / 41.7 / 12.4 → 12.4
  check('min 取百分比最小值', r.text === '12.4%', r.text)
}
{
  const r = renderHudTemplate('${max(pct5h, pctWeek)}', vars)
  check('max 取百分比最大值', r.text === '80.0%', r.text)
}
{
  // 金额：$0.60 / $2.50 / $12.40 → 赢的是 $0.60
  const r = renderHudTemplate('${min(remain5h, remainWeek, remainMonth)}', vars)
  check('min 保留胜出值的原样格式（$ 与精度）', r.text === '$0.60', r.text)
}
{
  const r = renderHudTemplate('${min(pct5h)}', vars)
  check('min 单参数报错', typeof r.error === 'string' && r.error.includes('至少需要两个参数'), r.error)
}
{
  const r = renderHudTemplate('${min(pct5h, pctWeek)}', vars)
  check('支持嵌套外的正常调用', r.error === undefined, r.error)
}
{
  const r = renderHudTemplate('${min(max(pct5h, pctWeek), pctMonth)}', vars)
  // 内层 max(80.0%, 41.7%) = 80.0%，外层 min(80.0%, 12.4%) = 12.4%（格式化已在最内层完成）
  check('支持嵌套 min(max(...), ...)', r.error === undefined && r.text === '12.4%', r.text + ' / ' + r.error)
}
{
  const many = Array.from({ length: 10 }, (_, i) => 'pct5h').join(', ')
  check('超过 8 个参数报错', String(renderHudTemplate('${min(' + many + ')}', vars).error).includes('参数太多'))
}

console.log('[6] 安全：不能执行代码')
{
  // 这些都是「如果用了 eval 就会出事」的写法，必须被拒
  const attacks = [
    '${constructor}',
    '${process}',
    '${globalThis}',
    '${require("fs")}',
    '${alert(1)}',
    '${min.constructor("return 1")()}',
    '${x.constructor}',
    '${1+1}',
    '${(() => 1)()}',
    '${`${1}`}',
    '${run(pct5h)}',
  ]
  for (const t of attacks) {
    const r = renderHudTemplate(t, vars)
    const blocked = r.error !== undefined || r.text === '?' || r.unknown.length > 0
    check('拒绝 ' + t, blocked, 'text=' + JSON.stringify(r.text) + ' error=' + r.error)
  }
}
{
  // 用真的 setTimeout 侧信道：模板里若被执行，这里会被置位
  let pwned = false
  const evil = [{ name: 'boom', label: 'B', get: () => { pwned = true; return 'x' } }]
  renderHudTemplate('${boom.constructor.constructor("pwned=true")()}', evil)
  check('构造器链走不通（boom.get 未被当作属性访问）', pwned === false)
}
{
  const r = renderHudTemplate('${' + 'min('.repeat(10) + 'pct5h,pctWeek' + ')'.repeat(10) + '}', vars)
  check('嵌套过深被拒', typeof r.error === 'string', r.error)
}

console.log('[7] 语法错误不炸 UI')
{
  const r = renderHudTemplate('没闭合 ${pct5h', vars)
  check('未闭合 → error 有值', typeof r.error === 'string', r.error)
  check('未闭合 → 原样返回模板（让用户看见自己写的）', r.text === '没闭合 ${pct5h', r.text)
}
{
  const r = renderHudTemplate('${}', vars)
  check('空表达式渲染成空串', r.error === undefined && r.text === '', r.text + ' / ' + r.error)
}
{
  const r = renderHudTemplate('${pct5h} ${oops}', vars)
  check('部分未知不阻挡其它变量', r.text === '80.0% ?', r.text)
  check('未知变量不影响无 error', r.error === undefined, r.error)
}

console.log('[8] templateVarNames')
{
  check('提取变量名', JSON.stringify(templateVarNames('${a} ${b}')) === '["a","b"]')
  check('去重保序', JSON.stringify(templateVarNames('${b} ${a} ${b}')) === '["b","a"]')
  check('聚合函数名也算进去（设置页要能高亮）',
    JSON.stringify(templateVarNames('${min(a, b)}')) === '["min","a","b"]')
  check('非字符串安全', JSON.stringify(templateVarNames(null)) === '[]')
}

console.log('[9] 你举的那个例子')
{
  // 注意用户原话里 `{pctTight}` 是单花括号 —— 在这里按字面量处理，所以演示
  // 用的是正确写法 `${...}`。
  const r = renderHudTemplate(
    'CC 最紧 剩${min(remain5h, remainWeek, remainMonth)} ${pctTight}%可用',
    vars,
  )
  console.log('    输出:', JSON.stringify(r.text))
  check('能表达「最紧的剩余额度」', r.text === 'CC 最紧 剩$0.60 80.0%可用', r.text)
  check('没有语法错误', r.error === undefined, r.error)
}

console.log(fails === 0 ? '\n模板测试全部通过。' : `\n${fails} 项失败。`)
process.exitCode = fails === 0 ? 0 : 1
