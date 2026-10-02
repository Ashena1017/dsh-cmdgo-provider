/**
 * 模型目录「搜索 + 厂家筛选」的本地冒烟测试（无浏览器）。
 *
 * 用**真实的上游目录**（74 个 id，逐一取自 src/models.ts 的模态表）当夹具，
 * 因为厂家归类最容易错的地方就是真实 id 的命名形状：
 *   - `vendor/model`（deepseek/…、zai-org/…）
 *   - `brand-N.N`（claude-…、gpt-…，没有前缀）
 *   - 同一厂家的**多个前缀写法**：`zai-org/GLM-5` 与 `z-ai/glm-5.3-flash`、
 *     `MiniMaxAI/MiniMax-M3` 与 `minimax/minimax-m3-free`
 * 最后一条是核心用例：不归并别名就会出现两个只差连字符的分组，
 * 按 zai 筛会漏掉一半 —— 正是用户举的那个例子。
 *
 * 与 smoke-client.mjs 的区别：这里需要 useState 真的生效（搜索框是受控输入），
 * 所以实现了一个带 hook 游标的最小 React 桩，而不是把 useState 变成空操作。
 *
 * 用法：node scripts/smoke-model-filter.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/* ---------------- 桩：带 hook 状态的 React ----------------
 * 只支持「在顶层组件里按固定顺序调用 hook」（Console 的实际用法）。
 * 子组件（ModelSwitch 等）不调用 hook，所以直接函数调用即可。 */

let cursor = 0
const hookValues = []
const hookDeps = []
const hookCleanup = []
let renderDepth = 0
let mounted = null

const depsChanged = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]))

function rerender() {
  if (renderDepth > 0) return   // 渲染中触发的 setState：本轮渲染结束后会被再次调用
  renderTop()
}

/** 渲染顶层组件（每次重置 hook 游标，模拟 React 的按序 hook 表）。 */
function renderTop() {
  cursor = 0
  renderDepth += 1
  try { return mounted() } finally { renderDepth -= 1 }
}

const React = {
  createElement: (type, props, ...children) => {
    const next = { ...(props || {}) }
    if (children.length === 1) next.children = children[0]
    else if (children.length > 1) next.children = children
    if (typeof type === 'function') return type(next)
    return { type, props: next }
  },
  Fragment: 'Fragment',
  useState: (init) => {
    const i = cursor
    cursor += 1
    if (!(i in hookValues)) hookValues[i] = typeof init === 'function' ? init() : init
    const set = (v) => {
      const prev = hookValues[i]
      const val = typeof v === 'function' ? v(prev) : v
      if (Object.is(val, prev)) return
      hookValues[i] = val
      rerender()
    }
    return [hookValues[i], set]
  },
  useEffect: (fn, deps) => {
    const i = cursor
    cursor += 1
    if (!depsChanged(hookDeps[i], deps)) return
    if (typeof hookCleanup[i] === 'function') hookCleanup[i]()
    hookDeps[i] = deps
    hookCleanup[i] = fn()
  },
  useCallback: (fn, deps) => {
    const i = cursor
    cursor += 1
    if (!depsChanged(hookDeps[i], deps)) return hookValues[i]
    hookDeps[i] = deps
    hookValues[i] = fn
    return fn
  },
  useRef: (init) => {
    const i = cursor
    cursor += 1
    if (!(i in hookValues)) hookValues[i] = { current: init }
    return hookValues[i]
  },
}

/* ---------------- 夹具：真实上游目录 ---------------- */

/** 74 个 id，逐一取自 src/models.ts 的 `"<id>": "text|image"` 模态表。 */
const CATALOG = [
  'claude-fable-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-opus-4-7',
  'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-4-6', 'claude-sonnet-5',
  'deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-flash-fast',
  'deepseek/deepseek-v4-flash-vision-exp', 'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4.1-flash',
  'google/gemini-3.1-flash-lite', 'google/gemini-3.5-flash', 'google/gemini-3.5-flash-lite',
  'google/gemini-3.6-flash', 'google/gemini-3.7-flash', 'google/gemini-3.8-flash',
  'gpt-5.3-codex', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.6-luna', 'gpt-5.6-sol',
  'gpt-5.6-terra', 'gpt-6-astra',
  'inclusionai/ling-3.0-flash-free', 'inclusionai/ling-3.0-flash-sante:free',
  'meituan/LongCat-2.0:free',
  'meta/muse-spark-1.1', 'meta/muse-spark-1.2', 'meta/muse-spark-1.2-contributor',
  'meta/muse-spark-1.3', 'meta/muse-spark-1.3-contributor',
  'minimax/minimax-m2.7-free', 'minimax/minimax-m3-free',
  'MiniMaxAI/MiniMax-M2.5', 'MiniMaxAI/MiniMax-M2.7', 'MiniMaxAI/MiniMax-M3',
  'moonshotai/Kimi-K2.5', 'moonshotai/Kimi-K2.6', 'moonshotai/Kimi-K2.7-Code',
  'moonshotai/Kimi-K2.7-Code-Highspeed', 'moonshotai/Kimi-K3',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'poolside/laguna-s-2.1-free',
  'Qwen/Qwen3.6-Max-Preview', 'Qwen/Qwen3.6-Plus', 'Qwen/Qwen3.7-Flash', 'Qwen/Qwen3.7-Max',
  'Qwen/Qwen3.7-Plus', 'Qwen/Qwen3.8-27B', 'Qwen/Qwen3.8-Flash', 'Qwen/Qwen3.8-Max',
  'Qwen/Qwen3.8-Max-0902',
  'sakana/fugu-ultra',
  'stepfun/Step-3.5-Flash', 'stepfun/Step-3.7-Flash',
  'tencent/Hy3', 'tencent/hy3-paid', 'tencent/hy4-preview',
  'thinkingmachines/inkling', 'thinkingmachines/inkling-small',
  'xai/grok-4.5', 'xai/grok-4.6',
  'xiaomi/mimo-v2.5', 'xiaomi/mimo-v2.5-pro',
  'z-ai/glm-5.3-flash',
  'zai-org/GLM-5', 'zai-org/GLM-5.1', 'zai-org/GLM-5.2', 'zai-org/GLM-5.2-Fast', 'zai-org/GLM-5.3',
]

const status = {
  ok: true,
  credentialRef: 'COMMANDCODE_API_KEY',
  credentialConfigured: true,
  modelCount: CATALOG.length,
  activeAccounts: 1,
  login: { status: 'idle' },
  accounts: [],
  models: CATALOG.slice(),
  pricing: {},
  prefs: { hiddenModels: [], hudEnabled: true },
}

const fetchedUrls = []
const posted = []
const fakeFetch = async (url, opts) => {
  fetchedUrls.push(String(url))
  if (opts && opts.body) {
    try { posted.push({ url: String(url), body: JSON.parse(opts.body) }) } catch (e) { /* 忽略 */ }
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(status) }
}

/* ---------------- 桩：window / document ---------------- */

let loaded = null
const styleNodes = new Map()
globalThis.window = {
  __ModuleLoader__: { load: (def) => { loaded = def } },
  open: () => {},
  confirm: () => true,
  innerWidth: 1440,
  innerHeight: 900,
}
globalThis.document = {
  getElementById: (id) => styleNodes.get(id) || null,
  createElement: () => {
    const el = { textContent: '' }
    let id = ''
    Object.defineProperty(el, 'id', { get: () => id, set: (v) => { id = v; styleNodes.set(v, el) } })
    return el
  },
  head: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.fetch = fakeFetch
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}
const navigatorStub = { clipboard: { writeText: async () => {} } }

/* ---------------- 执行 factory ---------------- */

const require_ = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}
new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'navigator', source)(
  globalThis.window, globalThis.document, globalThis.fetch, globalThis.setInterval, globalThis.clearInterval, navigatorStub,
)
if (loaded === null) throw new Error('__ModuleLoader__.load 未被调用')
const mod = loaded.factory(require_)

const regs = []
const fakeSlots = {
  inject: (name, cb) => { cb() },
  register: (def, component) => { regs.push({ def, component }); return () => {} },
}
mod.apply({
  get: (name) => (name === 'slots' ? fakeSlots : undefined),
})

const settingsEntry = regs.find((r) => r.def.name === 'settings.section')
if (!settingsEntry) throw new Error('settings.section 未注册')
mounted = () => settingsEntry.component({})

/* ---------------- 断言工具 ---------------- */

const failures = []
const check = (label, ok, extra) => {
  if (ok) { console.log('  ok  ' + label) } else { failures.push(label); console.log('  FAIL ' + label + (extra ? ' → ' + extra : '')) }
}

const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }

/** 递归收集满足谓词的节点。 */
const collect = (node, pred, out = []) => {
  if (Array.isArray(node)) { node.forEach((n) => collect(n, pred, out)); return out }
  if (node && typeof node === 'object' && node.props) {
    if (pred(node)) out.push(node)
    collect(node.props.children, pred, out)
  }
  return out
}

/** 渲染结果里所有模型开关的 id（按渲染顺序）。 */
const shownIds = (tree) => collect(tree, (n) => n.props.className === 'cmdgo-switch-name')
  .map((n) => n.props.children)

const findByClass = (tree, cls) => collect(tree, (n) => String(n.props.className || '').includes(cls))

const searchInput = (tree) => collect(tree, (n) => n.type === 'input' && n.props.type === 'search')[0]

/**
 * 厂家芯片的 { label, count, on, click }。
 * ⚠️ 必须排除 `cmdgo-vchip-n`（数量小标）：findByClass 是**子串**匹配，
 * 'cmdgo-vchip' 会把 'cmdgo-vchip-n' 一起选中，于是每个芯片被拆成
 * 两个条目（标签一个、数量一个），数出「40 个厂家」。
 */
const vendorChips = (tree) => findByClass(tree, 'cmdgo-vchip')
  .filter((n) => !String(n.props.className).includes('cmdgo-vchip-n'))
  .map((n) => {
    const kids = (Array.isArray(n.props.children) ? n.props.children : [n.props.children]).filter(Boolean)
    let label = ''
    let count = NaN
    kids.forEach((k) => {
      if (typeof k === 'string') { label += k; return }
      if (k && k.props && String(k.props.className || '').includes('cmdgo-vchip-n')) count = Number(k.props.children)
    })
    return { label, count, on: String(n.props.className).includes('on'), click: n.props.onClick }
  })

const type = async (tree, value) => {
  const input = searchInput(tree)
  if (!input) throw new Error('搜索框未渲染')
  input.props.onChange({ target: { value } })
  await settle()
  return renderTop()
}

/* ---------------- 开始 ---------------- */

console.log('[1] 目录与厂家分组')
let tree = renderTop()
await settle()
tree = renderTop()
check('渲染出搜索框', searchInput(tree) !== undefined)
const ids0 = shownIds(tree)
check('未筛选时列出全部 ' + CATALOG.length + ' 个模型', ids0.length === CATALOG.length, 'got ' + ids0.length)

const chips0 = vendorChips(tree)
const vendorOnly = chips0.filter((c) => c.label !== '全部')
check('厂家清单从当前目录现算：' + vendorOnly.length + ' 个厂家 + 1 个「全部」',
  chips0.length === vendorOnly.length + 1 && vendorOnly.length === 19,
  'got ' + chips0.length + ' → ' + chips0.map((c) => c.label).join(','))
check('芯片计数之和 = 目录总数', vendorOnly.reduce((s, c) => s + c.count, 0) === CATALOG.length,
  String(vendorOnly.reduce((s, c) => s + c.count, 0)))
check('「全部」芯片的计数 = 目录总数',
  chips0.find((c) => c.label === '全部').count === CATALOG.length)
const chipOf = (label) => chips0.find((c) => c.label === label)

// 核心用例：同一厂家的两种前缀写法必须归到一个分组，否则按 zai 筛会漏一半。
check('zai-org/* 与 z-ai/* 归并为同一个 ZAI 分组（共 6 个）',
  chipOf('ZAI') !== undefined && chipOf('ZAI').count === 6,
  'ZAI=' + (chipOf('ZAI') || {}).count)
check('不存在只差连字符的第二个 zai 分组',
  chips0.filter((c) => /^z-?ai$/i.test(c.label)).length === 1,
  chips0.map((c) => c.label).join(','))
check('MiniMaxAI/* 与 minimax/* 归并为 MiniMax（共 5 个）',
  chipOf('MiniMax') !== undefined && chipOf('MiniMax').count === 5,
  'MiniMax=' + (chipOf('MiniMax') || {}).count)
check('moonshotai/* 显示为 Moonshot（5 个）',
  chipOf('Moonshot') !== undefined && chipOf('Moonshot').count === 5)
// 无前缀的 claude-* / gpt-* 要按第一个 `-` 之前归类。
check('claude-*（无前缀）归为 Claude（8 个）', chipOf('Claude') !== undefined && chipOf('Claude').count === 8,
  'Claude=' + (chipOf('Claude') || {}).count)
check('gpt-*（无前缀）归为 GPT（8 个）', chipOf('GPT') !== undefined && chipOf('GPT').count === 8,
  'GPT=' + (chipOf('GPT') || {}).count)
check('Qwen/* 显示为 Qwen（9 个）', chipOf('Qwen') !== undefined && chipOf('Qwen').count === 9)
check('未知厂家按首字母大写展示（stepfun → StepFun）', chipOf('StepFun') !== undefined)
check('每个模型都恰好被归入一个分组（无遗漏）',
  vendorOnly.reduce((s, c) => s + c.count, 0) === CATALOG.length
  && vendorOnly.every((c) => c.count > 0))

console.log('[2] 按厂家筛选')
chipOf('ZAI').click()
await settle()
tree = renderTop()
const zaiIds = shownIds(tree)
check('点 ZAI 芯片后只列出该厂家', zaiIds.length === 6
  && zaiIds.every((id) => /^(zai-org|z-ai)\//.test(id)), zaiIds.join(','))
// 只归并、不误伤：这 6 个必须同时包含两种前缀写法，说明确实是并集而不是只匹配了一个前缀。
check('结果同时含两种前缀写法（z-ai/ 与 zai-org/）',
  zaiIds.some((id) => id.startsWith('z-ai/')) && zaiIds.some((id) => id.startsWith('zai-org/')),
  zaiIds.join(','))
check('选中芯片有 .on 选中态', vendorChips(tree).find((c) => c.label === 'ZAI').on === true)
// 再点一次 = 取消筛选，比回头找「全部」更省事。
vendorChips(tree).find((c) => c.label === 'ZAI').click()
await settle()
tree = renderTop()
check('再点一次同一芯片即取消筛选，恢复全部',
  shownIds(tree).length === CATALOG.length, 'got ' + shownIds(tree).length)

console.log('[3] 搜索（模型名 / 厂家名都能命中）')
tree = await type(tree, 'kimi')
check('搜索 kimi 命中 5 个 Kimi 系列',
  shownIds(tree).length === 5 && shownIds(tree).every((id) => /kimi/i.test(id)), shownIds(tree).join(','))
tree = await type(tree, 'glm')
check('搜索 glm 命中 6 个 GLM 系列（跨 z-ai / zai-org 两种前缀）',
  shownIds(tree).length === 6 && shownIds(tree).every((id) => /glm/i.test(id)), shownIds(tree).join(','))
// 厂家名也算命中目标：想找 zai 时更可能直接敲 zai。
tree = await type(tree, 'zai')
check('搜索 zai 按厂家名命中 6 个（不必先去下拉框挑厂家）',
  shownIds(tree).length === 6 && shownIds(tree).every((id) => /^(zai-org|z-ai)\//.test(id)), shownIds(tree).join(','))
tree = await type(tree, 'QWEN')
check('搜索大小写不敏感（QWEN → 9 个）', shownIds(tree).length === 9)
// 子串匹配：'mini' 会同时命中 MiniMax 与 gemini / gpt-5.4-mini —— 这是搜索的**正确**
// 行为（用户敲 mini 时未必只想要 MiniMax），所以断言「包含全部 5 个 MiniMax 型号」，
// 而不是「结果恰好 5 个」。
tree = await type(tree, 'mini')
const miniIds = shownIds(tree)
check('搜索 mini 命中全部 5 个 MiniMax（两种前缀都在内）',
  ['minimax/minimax-m2.7-free', 'minimax/minimax-m3-free', 'MiniMaxAI/MiniMax-M2.5',
    'MiniMaxAI/MiniMax-M2.7', 'MiniMaxAI/MiniMax-M3'].every((id) => miniIds.indexOf(id) >= 0),
  miniIds.join(','))
check('搜索 mini 也顺带命中 gemini 与 gpt-5.4-mini（子串匹配，符合预期）',
  miniIds.some((id) => /gemini/.test(id)) && miniIds.indexOf('gpt-5.4-mini') >= 0, miniIds.join(','))

console.log('[4] 无结果与清空')
tree = await type(tree, 'zzz-not-exist')
check('无匹配时不渲染任何模型行', shownIds(tree).length === 0)
check('无匹配时给出空状态提示', findByClass(tree, 'cmdgo-models-empty').length === 1)
// 空状态是单个字符串或字符串数组，用摊平的方式取文本（不要假定是数组）。
const emptyText = JSON.stringify(findByClass(tree, 'cmdgo-models-empty')[0].props.children)
check('空状态里回显搜索词', emptyText.includes('zzz-not-exist'), emptyText)
// 清空按钮只在有输入时出现。
const clearBtn = findByClass(tree, 'cmdgo-search-clear')[0]
check('有输入时出现清空按钮', clearBtn !== undefined)
clearBtn.props.onClick()
await settle()
tree = renderTop()
check('点清空后恢复全部 ' + CATALOG.length + ' 个', shownIds(tree).length === CATALOG.length)
check('清空后清空按钮消失', findByClass(tree, 'cmdgo-search-clear').length === 0)

console.log('[5] 搜索 + 厂家叠加')
tree = await type(tree, 'flash')
const flashAll = shownIds(tree).length
check('搜索 flash 命中多个厂家的 flash 型号（' + flashAll + ' 个）', flashAll > 3)
// 叠加厂家后必须是交集，而不是并集。
const deepseekChip = vendorChips(tree).find((c) => c.label === 'DeepSeek')
deepseekChip.click()
await settle()
tree = renderTop()
const both = shownIds(tree)
check('叠加 DeepSeek 后只留该厂家的 flash 型号（交集）',
  both.length > 0 && both.length < flashAll && both.every((id) => id.startsWith('deepseek/')),
  both.join(','))
check('叠加筛选后仍保留搜索词', searchInput(tree).props.value === 'flash')

console.log('[6] 批量按钮的作用范围（筛选时只动筛出来的）')
// 未筛选：按钮是全局语义，文案明确写「全部关闭」。
const globalBtn = collect(tree, (n) => n.type === 'button' && String(n.props.children) === '全部关闭')
check('筛选生效时批量按钮改文案为「关闭筛出的 N 个」',
  globalBtn.length === 0 && collect(tree, (n) => n.type === 'button' && /^关闭筛出的 \d+ 个$/.test(String(n.props.children))).length === 1,
  collect(tree, (n) => n.type === 'button' && /关闭/.test(String(n.props.children))).map((n) => n.props.children).join('|'))
check('筛选生效时提示按钮的作用范围',
  JSON.stringify(tree).includes('上面的按钮只作用于这些'))
// 真正点一下：只应发出筛出来的那几个 toggle，不能碰其它模型。
posted.length = 0
const closeScoped = collect(tree, (n) => n.type === 'button' && /^关闭筛出的 \d+ 个$/.test(String(n.props.children)))[0]
closeScoped.props.onClick()
await settle()
check('筛选中点批量只发出 ' + both.length + ' 个 /model/toggle（而不是 74 个）',
  posted.filter((p) => p.url.includes('/model/toggle')).length <= both.length,
  'sent ' + posted.filter((p) => p.url.includes('/model/toggle')).length)
check('筛选中点批量不调用全局 /model/hide-all',
  posted.every((p) => !p.url.includes('/model/hide-all')), posted.map((p) => p.url).join(','))
check('发出的 id 全部属于当前筛选结果',
  posted.filter((p) => p.url.includes('/model/toggle')).every((p) => both.indexOf(p.body.id) >= 0),
  posted.map((p) => p.body.id).join(','))
// 未筛选时仍走宿主的一次性接口（一次请求，而不是逐个）。
// ⚠️ 必须把**厂家筛选也清掉**：只清搜索词仍然算「筛选中」（filtering 为真），
// 按钮文案就还是「关闭筛出的 N 个」，拿不到「全部关闭」。
tree = await type(tree, '')
tree = renderTop()
const allChip = vendorChips(tree).find((c) => c.label === '全部')
if (allChip.on !== true) { allChip.click(); await settle(); tree = renderTop() }
check('清掉搜索与厂家筛选后恢复「全部关闭」语义',
  collect(tree, (n) => n.type === 'button' && String(n.props.children) === '全部关闭').length === 1,
  collect(tree, (n) => n.type === 'button' && /关闭/.test(String(n.props.children))).map((n) => n.props.children).join('|'))
posted.length = 0
const globalBtn2 = collect(tree, (n) => n.type === 'button' && String(n.props.children) === '全部关闭')[0]
globalBtn2.props.onClick()
await settle()
check('未筛选时走宿主一次性 /model/hide-all',
  posted.some((p) => p.url.includes('/model/hide-all')) && posted.filter((p) => p.url.includes('/model/toggle')).length === 0,
  posted.map((p) => p.url).join(','))

hookCleanup.forEach((fn) => { try { if (typeof fn === 'function') fn() } catch (e) { /* 忽略 */ } })

if (failures.length > 0) {
  console.error('\n冒烟失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\n模型筛选测试全部通过。')
