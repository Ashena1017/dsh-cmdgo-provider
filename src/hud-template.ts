/**
 * 胶囊文字的**受限模板引擎**。
 *
 * 为什么不用 `eval` / `new Function` 跑用户写的表达式：模板来自设置页的文本框，
 * 能被改就等价于「在这颗胶囊的上下文里执行任意 JS」。那是一条完全不必要的
 * 代码执行通道 —— 一个显示字符串的功能，不该有这种能力。所以这里实现一套
 * 只读白名单的占位符语法：能力覆盖「自己拼一段带变量的文字」，但没有任何
 * 副作用、没有分支、没有循环、读不到白名单以外的东西。
 *
 * 语法（刻意做成一眼能看懂的形状）：
 *
 *   模板：`CC 剩 ${min(remain5h, remainWeek, remainMonth)} {pctTight}% 可用`
 *   输出：`CC 剩 $3.40 82.0% 可用`
 *
 * - `${...}` 和 `{...}` **都**是变量插值，等价。支持两种是因为两种直觉都很
 *   常见（JS 模板字符串习惯 / 手写习惯），让用户少踩一次坑。
 * - 花括号里只能是一个**变量表达式**，不会执行代码。
 * - `min(a, b, c)` / `max(a, b, c)` 取最小值 / 最大值，参数 2~8 个，
 *   参数本身也可以嵌套 `min`/`max`（深度上限 4），也接受数字字面量。
 * - 想输出字面量花括号就转义：`\{` `\}` `\$`。转义只作用于紧邻的那一个字符，
 *   所以「原样输出 `${x}`」要写成 `\$\{x\}`。
 * - 数字字面量可直接参与聚合：`min(0, pctTight)`。
 * - 未知变量 → 渲染成 `?` 并在结果里回报名字（设置页把可用的列出来），
 *   而不是整段静默消失 —— 用户改错了要能看见是哪个键写错了。
 * - 值为 undefined / null（数据还没到）→ 渲染成 `—`。
 *
 * @module cmdgo/hud-template
 */

/** 一个可被模板引用的变量。 */
export interface HudTemplateVar {
  /** 变量名（模板里写在 `${}` 中间的那个标识符）。 */
  name: string
  /** 中文说明，设置页的变量速查表用。 */
  label: string
  /** 取值函数；返回 undefined/null 时渲染成 `—`。 */
  get: () => string | number | undefined | null
}

/** 求值结果。 */
export interface HudTemplateResult {
  /** 渲染后的文字。 */
  text: string
  /** 命中的未知变量名（去重、按出现顺序）。非空说明模板有问题。 */
  unknown: string[]
  /** 语法错误信息；为空表示语法没问题。 */
  error?: string
}

/** 允许的聚合函数。少而明确，不做通用表达式求值。 */
const AGGREGATES = new Set(['min', 'max'])

/** 嵌套深度上限：`min(max(...), ...)` 这种套 4 层还没写完，就别再惯着了。 */
const MAX_DEPTH = 4

/** 变量名：字母开头的字母数字下划线。刻意不允许点号/中括号 —— 那会让人以为能取属性。 */
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/

/**
 * 求值一个 `${...}` 内部表达式。
 *
 * 不解析成 AST 再编译，而是一层一层递归求值 —— 表达式文法只有「变量」、
 * 「聚合函数」、「数字字面量」三种形态，AST 是多余的一层。
 */
function evalExpr(expr: string, vars: Map<string, HudTemplateVar>, depth: number, unknown: string[], literal: string[]): string {
  const src = expr.trim()
  if (src.length === 0) return ''
  if (depth > MAX_DEPTH) throw new Error('嵌套太深')

  // 剥掉转义符：`\x` → `x`。只影响字面量输出，不影响语法判定。
  const unescape = (s: string): string => s.replace(/\\([\s\S])/g, '$1')

  const call = /^([A-Za-z][A-Za-z0-9_]*)\s*\(([\s\S]*)\)$/.exec(src)
  if (call !== null) {
    const fn = call[1]
    if (!AGGREGATES.has(fn)) throw new Error('不支持的函数 ' + fn + '()')
    const args = splitArgs(call[2])
    if (args.length < 2) throw new Error(fn + '() 至少需要两个参数')
    if (args.length > 8) throw new Error(fn + '() 参数太多（最多 8 个）')
    const values: number[] = []
    /** 各参数的原始文本，用来判断「取到的那个值原本是什么样」（单位、精度）。 */
    const raws: string[] = []
    for (const arg of args) {
      const raw = evalExpr(arg, vars, depth + 1, unknown, literal)
      // 聚合函数只对数字有意义：`—`（数据未到）和未知变量都跳过，
      // 全部拿不到就整段输出 `—`，而不是把字符串塞进 Math.min。
      const n = Number(raw.replace(/[$,%]/g, '').replace(/,/g, ''))
      if (raw !== '—' && raw !== '?' && isFinite(n)) { values.push(n); raws.push(raw) }
    }
    if (values.length === 0) return '—'
    const picked = fn === 'min' ? Math.min(...values) : Math.max(...values)
    // 输出**胜出那个参数的原样文本**，而不是 String(数字)：
    // 用户写 `${min(remain5h, remainWeek)}` 时想看到 `$0.60`，不是 `0.6`。
    // 精度、货币符、百分号都跟着它自己的格式走，不做二次格式化。
    const at = values.indexOf(picked)
    if (at >= 0 && raws[at] !== undefined) return raws[at]
    return String(picked)
  }

  // 数字字面量：`min(0, pctTight)` 这种「至少显示 0」的写法很自然，值得支持。
  if (/^-?\d+(\.\d+)?$/.test(src)) return src

  if (!NAME_RE.test(src)) throw new Error('看不懂的变量 ' + JSON.stringify(unescape(src)))
  const found = vars.get(src)
  if (found === undefined) {
    // 纯字面量标记（由 renderHudTemplate 传入 `literal` 数组）也走这条：
    // 它既不在变量表里，也不该被报成「未知变量」。
    if (literal.indexOf(src) >= 0) return unescape(src)
    if (unknown.indexOf(src) < 0) unknown.push(unescape(src))
    return '?'
  }
  const value = found.get()
  if (value === undefined || value === null || value === '') return '—'
  return String(value)
}

/** 按逗号切参数，但要跳过嵌套括号里的逗号（`min(a, max(b, c))`）。 */
function splitArgs(src: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      out.push(src.slice(start, i))
      start = i + 1
    }
  }
  out.push(src.slice(start))
  return out
}

/**
 * 渲染模板。
 *
 * 语法错误**不**抛给调用方（那是 UI 里每帧都要跑的代码），而是把错误放进
 * 返回值并原样输出模板 —— 让用户看见自己写的东西、配上红字提示，比整颗
 * 胶囊变成空白好定位。
 *
 * @param template - 用户写的模板；空字符串表示"用默认排版"。
 * @param vars - 可用变量表。
 * @returns 渲染结果。
 */
export function renderHudTemplate(template: string, vars: readonly HudTemplateVar[]): HudTemplateResult {
  const unknown: string[] = []
  if (typeof template !== 'string' || template.length === 0) return { text: '', unknown }
  const table = new Map<string, HudTemplateVar>()
  for (const v of vars) table.set(v.name, v)

  let out = ''
  let i = 0
  while (i < template.length) {
    const ch = template[i]
    // 反斜杠转义：吃掉一个字符并原样输出，**不进插值分支**。
    // 先判转义再判 `{`/`${` 是关键 —— 否则 `\${x}` 会当成插值，
    // 用户没有任何办法输出字面量 `${`。
    if (ch === '\\' && i + 1 < template.length) {
      out += template[i + 1]
      i += 2
      continue
    }
    // `${` 与 `{` 都当作插值起点（语法糖，见文件头的说明）。
    const isDollar = ch === '$' && template[i + 1] === '{'
    if (isDollar || ch === '{') {
      const open = isDollar ? i + 1 : i
      // 找到配对的 `}`，允许内部再嵌套 `{}`。
      let depth = 1
      let j = open + 1
      while (j < template.length && depth > 0) {
        if (template[j] === '{') depth += 1
        else if (template[j] === '}') depth -= 1
        if (depth === 0) break
        j += 1
      }
      if (depth !== 0) {
        return { text: template, unknown, error: (isDollar ? '${' : '{') + ' 没有闭合' }
      }
      const expr = template.slice(open + 1, j)
      try {
        out += evalExpr(expr, table, 0, unknown, [])
      } catch (error) {
        return {
          text: template,
          unknown,
          error: (isDollar ? '${' : '{') + expr + '}：' + (error instanceof Error ? error.message : String(error)),
        }
      }
      i = j + 1
      continue
    }
    out += ch
    i += 1
  }
  return { text: out, unknown }
}

/**
 * 模板里用到的变量名（按出现顺序去重）。
 *
 * 设置页用它做「你用了哪些变量」的实时回显，也是"未知变量"高亮的数据源。
 */
export function templateVarNames(template: string): string[] {
  const names: string[] = []
  if (typeof template !== 'string') return names
  const seen = new Set<string>()
  for (const m of template.matchAll(/\$?\{([\s\S]*?)\}/g)) {
    const expr = m[1]
    for (const id of expr.matchAll(/[A-Za-z][A-Za-z0-9_]*/g)) {
      if (seen.has(id[0])) continue
      seen.add(id[0])
      names.push(id[0])
    }
  }
  return names
}
