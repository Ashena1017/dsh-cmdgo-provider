/**
 * lib/client.js 的本地冒烟测试（无浏览器）。
 *
 * client.js 是手写的 __ModuleLoader__ bundle，不参与 tsc，因此用一个最小
 * 的 React/DOM/fetch 桩把 factory 跑起来，验证：
 *   1. 三个槽都注册了（设置页 / 会话头部胶囊 / 帧级浮层面板）；
 *   2. 胶囊在有账号快照时按「最紧的那条额度」渲染；
 *   3. 面板渲染出每个账号的名字与额度行。
 *
 * 用法：node scripts/smoke-client.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/* ---------------- 桩：React ---------------- */

const cleanups = []
let renders = 0

function render(type, props, ...children) {
  renders += 1
  const next = { ...(props || {}) }
  if (children.length === 1) next.children = children[0]
  else if (children.length > 1) next.children = children
  if (typeof type === 'function') return type(next)
  return { type, props: next }
}

/* useMemo 的缓存格。桩是单组件顺序渲染，一个格子够用。 */
let memoCell = { deps: undefined, value: undefined }

const React = {
  createElement: render,
  Fragment: 'Fragment',
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c) },  useCallback: (fn) => fn,
  /* useMemo 按依赖数组做真缓存：模板编辑器用它包住「变量表 + 渲染结果」，
   * 桩若每次重算就看不出记忆化是否生效（依赖数组写错也测不出来）。 */
  useMemo: (fn, deps) => {
    if (memoCell.deps !== undefined && deps !== undefined
      && memoCell.deps.length === deps.length
      && memoCell.deps.every((d, i) => d === deps[i])) {
      return memoCell.value
    }
    const value = fn()
    memoCell = { deps: deps === undefined ? undefined : [...deps], value }
    return value
  },
  // 必须尊重初值：toggleModel 的防重入集合是 useRef(new Set())，
  // 桩若一律给 null，点到模型开关时会 TypeError（而且只在冒烟里复现）。
  useRef: (init) => ({ current: init === undefined ? null : init }),
}

/* ---------------- 桩：预置快照 ---------------- *
 * 设置页（Console）的首帧 snap 是 null，只渲染骨架屏；要检查真实结构
 * （下拉框、配色分段控件等）必须让 useState(null) 返回一份快照。
 * 用 `nextSnapshot` 一次性覆盖并立刻复位，避免影响其它组件的首帧断言。
 */
let nextSnapshot = undefined
React.useState = (init) => {  let value = typeof init === 'function' ? init() : init
  if (value === null && nextSnapshot !== undefined) {
    value = nextSnapshot
    nextSnapshot = undefined
  }
  return [value, () => {}]
}

/* ---------------- 桩：宿主 /status 快照 ---------------- */

const status = {
  ok: true,
  credentialRef: 'COMMANDCODE_API_KEY',
  credentialConfigured: true,
  modelCount: 12,
  activeAccounts: 2,
  login: { status: 'idle' },
  // 模型目录与偏好：设置页的筛选条 / 芯片 / 配色控件都依赖这两块存在
  // （宿主真实 /status 一定会给；缺了整段不渲染，结构断言会直接失效）。
  models: ['zai/glm-4.6', 'kimi/k2-thinking', 'qwen/qwen3-max', 'claude-sonnet-4-5'],
  pricing: { 'zai/glm-4.6': { input: 0.435, output: 1.74, cacheRead: 0.0435 } },
  // hudTemplate 是 0.9.x 之后新增的偏好。这里刻意**先不给**（老宿主没有这个键），
  // 模板相关断言各自临时写值，顺带验证「缺键 → 内置排版」这条兼容路径。
  prefs: { hiddenModels: ['qwen/qwen3-max'], hudEnabled: true, theme: 'system' },
  accounts: [
    {
      id: 'acct-a', ref: 'COMMANDCODE_API_KEY_ACCT-A', userName: 'alice', keyName: 'cli-a',
      addedAt: 1, enabled: true, failCount: 0, cooling: false, configured: true,
      usage: {
        ok: true, fetchedAt: Date.now() - 5000, stale: false,
        plan: { name: 'Go' }, limited: true,
        monthly: { remaining: 4, total: 10, used: 6, percent: 0.6, purchased: 0, free: 0, extra: 0 },
        fiveHour: { used: 2.4, cap: 3, remaining: 0.6, percent: 0.8, exceeded: false },
        weekly: { used: 3, cap: 6, remaining: 3, percent: 0.5, exceeded: false },
      },
    },
    {
      id: 'acct-b', ref: 'COMMANDCODE_API_KEY_ACCT-B', userName: 'bob', keyName: 'cli-b',
      addedAt: 2, enabled: true, failCount: 0, cooling: false, configured: true,
      usage: {
        ok: true, fetchedAt: Date.now() - 1000, stale: false,
        plan: { name: 'Go' }, limited: true,
        monthly: { remaining: 9, total: 10, used: 1, percent: 0.1, purchased: 0, free: 0, extra: 0 },
        fiveHour: { used: 0.3, cap: 3, remaining: 2.7, percent: 0.1, exceeded: false },
      },
    },
  ],
  // 缓存台账（issue #6 补充诉求）：宿主按会话聚合后回给面板。
  cache: {
    last: {
      model: 'deepseek-v4.1-flash', at: Date.now() - 3000,
      inputTokens: 200, outputTokens: 20,
      cacheReadTokens: 1800, cacheWriteTokens: 100,
      cacheHitRate: 1800 / 2100, cacheReported: true,
    },
    total: { requests: 2, inputTokens: 200, outputTokens: 20, cacheReadTokens: 1800, cacheWriteTokens: 100, cacheReportedRequests: 2 },
    sessions: [{ label: 'abc12345', requests: 2, inputTokens: 200, outputTokens: 20, cacheReadTokens: 1800, cacheWriteTokens: 100, cacheReportedRequests: 2, model: 'deepseek-v4.1-flash', updatedAt: Date.now() - 3000 }],
    current: { label: 'abc12345', requests: 2, inputTokens: 200, outputTokens: 20, cacheReadTokens: 1800, cacheWriteTokens: 100, cacheReportedRequests: 2, model: 'deepseek-v4.1-flash', updatedAt: Date.now() - 3000 },
  },
}

const fetchedUrls = []
const fakeFetch = async (url, init) => {
  const target = String(url)
  fetchedUrls.push(target)
  if (!target.startsWith('/api/cmdgo/')) throw new Error('unexpected url ' + url)
  /* POST 的偏好类接口像真宿主那样**改写并回传**快照。
     以前所有请求都返回同一份 status，于是"保存后界面是否真的跟着变"这件事
     在冒烟里根本没走通 —— 客户端就算把返回值丢了也测不出来。 */
  let body = null
  try { body = init && init.body ? JSON.parse(init.body) : null } catch (e) { body = null }
  if (target.endsWith('/hud/template') && body && typeof body.template === 'string') {
    status.prefs.hudTemplate = body.template.slice(0, 300)
  }
  if (target.endsWith('/hud/toggle') && body && typeof body.enabled === 'boolean') {
    status.prefs.hudEnabled = body.enabled
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(status) }
}

/* ---------------- 桩：window / document ---------------- */

let loaded = null
const styleNodes = new Map()
globalThis.window = {
  __ModuleLoader__: { load: (def) => { loaded = def } },
  open: () => {},
}
globalThis.document = {
  getElementById: (id) => styleNodes.get(id) || null,
  // <style> 是先在元素上赋 id、再 appendChild，所以 id 赋值时就登记，
  // 这样第二次 ensureStyle() 能命中已有节点（与浏览器行为一致）。
  createElement: () => {
    const el = { textContent: '' }
    let id = ''
    Object.defineProperty(el, 'id', { get: () => id, set: (value) => { id = value; styleNodes.set(value, el) } })
    return el
  },
  head: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {},
}
globalThis.fetch = fakeFetch
globalThis.setInterval = () => 1
globalThis.clearInterval = () => {}
// Node 24 的 globalThis.navigator 只有 getter，不能赋值；源码只用它读剪贴板，
// 这里作为参数注入即可（对应浏览器里的 navigator）。
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

/* ---------------- 断言 ---------------- */

const failures = []
const check = (label, ok, extra) => {
  if (ok) { console.log('  ok  ' + label) } else { failures.push(label); console.log('  FAIL ' + label + (extra ? ' → ' + extra : '')) }
}

const regs = []
const fakeSlots = {
  inject: (name, cb) => { cb() },
  register: (def, component) => { regs.push({ def, component }); return () => {} },
}
// 模型目录桩。胶囊的 provider 门禁已经随「位置变更」一起拆出本 PR，客户端
// 不再读它；保留这个桩是因为 `ctx.get('modelDirectories')` 仍是宿主契约的一部分，
// 且要断言客户端**不再**注册需要它的 inject。
let selectedProvider = 'commandcode'
const fakeDirectories = {
  directoryFor: () => ({
    store: {
      getSnapshot: () => ({ current: selectedProvider === null ? null : { provider: selectedProvider } }),
      subscribe: () => () => {},
    },
    load: async () => {},
  }),
}
mod.apply({
  get: (name) => {
    if (name === 'slots') return fakeSlots
    if (name === 'modelDirectories') return fakeDirectories
    return undefined
  },
})

console.log('[1] 槽注册')
check('注册了 4 个条目（设置页 + 两个胶囊槽 + 面板）', regs.length === 4, 'got ' + regs.length)
const bySlot = Object.fromEntries(regs.map((r) => [r.def.name, r]))
check('settings.section 存在', bySlot['settings.section'] !== undefined)

/* 真实渲染一次设置页，拿到 DOM 树（先喂一份快照，否则只有骨架屏）。
   这一步以前缺失，代价是一整段 CSS 从未生效却没人发现：
   <select> 的样式写的是 `.cmdgo-search select`，而真实结构里 select 是
   `.cmdgo-search` 的**兄弟**（都在 `.cmdgo-filter` 里）。断言只 grep CSS 文本，
   所以"选择器命中不了任何元素"这件事测不出来。下面用真实树校验一遍。 */
nextSnapshot = status
const consoleTree = bySlot['settings.section'].component({})
nextSnapshot = undefined
/** 把渲染结果转成 { tag, cls, kids } 的轻量树，方便按结构查元素。 */
const toTree = (node) => {
  if (node === null || node === undefined || node === false) return null
  if (Array.isArray(node)) return node.map(toTree).filter(Boolean)
  if (typeof node !== 'object') return null
  const props = node.props || {}
  return {
    tag: node.type,
    cls: typeof props.className === 'string' ? props.className : '',
    kids: toTree(props.children),
  }
}
const tree = toTree(consoleTree)
const flat = []
const walk = (n) => {
  if (n === null || n === undefined) return
  if (Array.isArray(n)) { n.forEach(walk); return }
  flat.push(n)
  walk(n.kids)
}
walk(tree)
const hasCls = (node, name) => node.cls.split(/\s+/).indexOf(name) >= 0
check('设置页真实渲染出根节点（含 data-cmdgo-theme 属性）',
  consoleTree !== null && consoleTree.props
  && /^(light|dark)$/.test(String(consoleTree.props['data-cmdgo-theme'])),
  'data-cmdgo-theme = ' + String(consoleTree && consoleTree.props && consoleTree.props['data-cmdgo-theme']))
{
  // select 的父节点必须与 CSS 选择器一致（.cmdgo-filter），不能是 .cmdgo-search
  const selectNode = flat.find((n) => n.tag === 'select')
  const searchNode = flat.find((n) => hasCls(n, 'cmdgo-search'))
  const filterNode = flat.find((n) => hasCls(n, 'cmdgo-filter'))
  check('厂家下拉框是 .cmdgo-filter 的直接子节点（CSS 选择器必须按真实结构写）',
    selectNode !== undefined && filterNode !== undefined
    && Array.isArray(filterNode.kids) && filterNode.kids.some((k) => k && k.tag === 'select'),
    selectNode === undefined ? '没渲染出 select' : 'select 不在 .cmdgo-filter 下')
  check('下拉框不在 .cmdgo-search 里（旧 CSS 正是错设成它的后代，整段没生效）',
    searchNode === undefined || !Array.isArray(searchNode.kids)
    || !searchNode.kids.some((k) => k && k.tag === 'select'))
}
check('三条配色按钮都渲染出来（浅色 / 深色 / 跟随系统）',
  consoleTree !== null && ['浅色', '深色', '跟随系统'].every((label) => JSON.stringify(consoleTree).includes(label)))
// 配色控件必须落在 .cmdgo 之内：它靠 .cmdgo[data-cmdgo-theme=dark] 那套变量
// 上色，跑到分区外面就会拿到别的配色。
check('配色按钮在 .cmdgo 分区内（否则拿不到 --cmdgo-* 变量）',
  flat.some((n) => hasCls(n, 'cmdgo-seg')))
check('胶囊位置两个选项都渲染出来（会话右上角 / 模型选择器左侧）',
  consoleTree !== null
  && ['会话右上角', '模型选择器左侧'].every((label) => JSON.stringify(consoleTree).includes(label)))
check('胶囊位置控件是分段按钮（与配色控件同一交互语言）',
  flat.filter((n) => hasCls(n, 'cmdgo-seg')).length >= 2,
  '找到 ' + flat.filter((n) => hasCls(n, 'cmdgo-seg')).length + ' 组分段控件')
/* 状态行文案要跟位置走，且 composer 档沿用胶囊固定在左侧时的那一版措辞
 * （那里已经交代了位置和门禁，换说法会让老用户以为行为变了）。 */
check('header 档状态行说明「会话右上角」且点明与模型无关',
  JSON.stringify(consoleTree).includes('已显示：会话右上角显示 CommandCode Go 订阅胶囊（与当前模型无关）'))
{
  const savedPos = status.prefs.hudPosition
  status.prefs.hudPosition = 'composer'
  nextSnapshot = status
  const composerTree = bySlot['settings.section'].component({})
  nextSnapshot = undefined
  check('composer 档状态行沿用原措辞（模型选择器左侧 + 门禁说明）',
    JSON.stringify(composerTree).includes('已显示：模型选择器左侧显示 CommandCode Go 订阅胶囊（仅当选中本插件的模型时）'),
    '没找到预期文案')
  status.prefs.hudPosition = savedPos
}
check('胶囊槽：会话头部（header 档）',
  bySlot['conversation.session.header.utilities'] !== undefined
  && bySlot['conversation.session.header.utilities'].def.id === 'commandcode-go-quota')
// 位置做成选项后两个槽都注册，由 prefs.hudPosition 决定渲染哪一个。
check('胶囊槽：composer（composer 档，模型选择器左侧）',
  bySlot['conversation.input.right'] !== undefined
  && bySlot['conversation.input.right'].def.id === 'commandcode-go-quota-inline')
check('composer 槽带 resolveDirectory inject（模型门禁要用）',
  bySlot['conversation.input.right'].def.inject !== undefined)
{
  const injected = bySlot['conversation.input.right'].def.inject('sess_test')
  check('resolveDirectory 是函数且调用后拿到 store',
    typeof injected.resolveDirectory === 'function'
    && typeof injected.resolveDirectory().load === 'function')
}
check('header 槽不需要 inject（右上角与当前模型无关）',
  bySlot['conversation.session.header.utilities'].def.inject === undefined)
check('shell.overlay 面板已注册',
  bySlot['shell.overlay'] !== undefined
  && bySlot['shell.overlay'].def.id === 'commandcode-go-quota-panel')

/* 面板挂载时经 useEffect → refresh() 写入共享快照；等 microtask 落地。 */
console.log('[2] 面板首帧与轮询')
const panelEl = bySlot['shell.overlay'].component({})
check('面板关闭时不渲染（只做轮询）', panelEl === null)
for (let i = 0; i < 12; i += 1) await Promise.resolve()

console.log('[3] 胶囊渲染（取最紧的一条额度）')
/** 渲染某一档位置的胶囊；inject 结果按宿主行为并进 props。 */
const HEADER_SLOT = 'conversation.session.header.utilities'
const COMPOSER_SLOT = 'conversation.input.right'
const pillOf = (slotName, extra) => {
  const def = bySlot[slotName].def
  const injected = typeof def.inject === 'function' ? def.inject('sess_test') : {}
  return bySlot[slotName].component({ ...injected, ...(extra || {}) })
}
const pillProps = (extra) => ({ ...(extra || {}) })
const pill = pillOf(HEADER_SLOT)
check('胶囊渲染出按钮', pill !== null && pill.type === 'button')
const pillText = JSON.stringify(pill)
check('胶囊含账号数 ×2', pillText.includes('\u00d72'))
check('胶囊标的是最紧的 5H 80%（alice，不是 bob 的 10%）', pillText.includes('5H 80.0%'))

console.log('[3a] 胶囊的 Hook 顺序必须与 provider / 快照无关')
/* 真实事故（PR review 复现）：门禁的 `return null` 插在两个 Hook 中间，
 * 首帧 provider 未知只走 2 个 Hook、effect 写入后走 3 个，React 抛
 * 「Rendered more hooks than during the previous render」，连带整块输入区
 * 渲染中断。桩里的 useEffect 是立即执行、且没有 Hook 计数，测不出"数量变化"，
 * 所以这里改成**静态断言**：两个胶囊相关组件里第一个 return 之前不允许出现
 * 任何后续 React.useXxx 调用。 */
{
  for (const fn of ['QuotaHudSlot', 'QuotaHudPill']) {
    const src = source.slice(source.indexOf('function ' + fn))
    const body = src.slice(0, src.indexOf('\n    }'))
    const firstReturn = body.search(/\n\s*(if \([^\n]*\) )?return /)
    const afterReturn = firstReturn >= 0 ? body.slice(firstReturn) : ''
    const hookAfter = [...afterReturn.matchAll(/React\.use[A-Z]\w*/g)].map((m) => m[0])
    check(fn + ' 第一个 return 之后没有任何 Hook 调用',
      firstReturn >= 0 && hookAfter.length === 0,
      'firstReturn=' + firstReturn + ' 之后的 Hook: ' + JSON.stringify(hookAfter))
  }
}

console.log('[3b] HUD 隐藏开关作用于胶囊')
/* 「隐藏」靠共享 store 里的快照决定，所以先让面板轮询一次把快照写进 store，
 * 再渲染胶囊看结果。每次 component() 都是一次完整调用，等价于独立一帧。 */
{
  const settleNow = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }
  const pumpPanel = () => bySlot['shell.overlay'].component({})
  const saved = status.prefs.hudEnabled

  status.prefs.hudEnabled = false
  pumpPanel()
  await settleNow()
  const hiddenPill = pillOf(HEADER_SLOT)
  check('hudEnabled=false → 胶囊不渲染', hiddenPill === null, '竟然是 ' + JSON.stringify(hiddenPill))

  status.prefs.hudEnabled = true
  pumpPanel()
  await settleNow()
  const shownPill = pillOf(HEADER_SLOT)
  check('hudEnabled=true → 胶囊恢复', shownPill !== null && shownPill.type === 'button')

  status.prefs.hudEnabled = saved
  pumpPanel()
  await settleNow()
}

console.log('[3c] 位置偏好决定渲染哪一个槽')
{
  const settleNow = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }
  const pumpPanel = () => bySlot['shell.overlay'].component({})
  const savedPos = status.prefs.hudPosition
  const savedHud = status.prefs.hudEnabled
  status.prefs.hudEnabled = true

  // 默认（没有该字段）= header
  delete status.prefs.hudPosition
  pumpPanel(); await settleNow()
  check('缺字段 → 默认 header 档显示',
    pillOf(HEADER_SLOT) !== null && pillOf(COMPOSER_SLOT) === null)

  // header 档
  status.prefs.hudPosition = 'header'
  pumpPanel(); await settleNow()
  check('header 档：头部渲染、模型选择器左侧不渲染',
    pillOf(HEADER_SLOT) !== null && pillOf(COMPOSER_SLOT) === null)

  // composer 档 + 选中本插件 → 只渲染 composer
  selectedProvider = 'commandcode'
  status.prefs.hudPosition = 'composer'
  pumpPanel(); await settleNow()
  check('composer 档 + 选中本插件：只在模型选择器左侧渲染',
    pillOf(HEADER_SLOT) === null && pillOf(COMPOSER_SLOT) !== null)

  // composer 档 + 选中别的 provider → 两档都不渲染（门禁）
  selectedProvider = 'deepseek-account'
  pumpPanel(); await settleNow()
  check('composer 档 + 选中别的 provider：两档都不渲染（门禁生效）',
    pillOf(HEADER_SLOT) === null && pillOf(COMPOSER_SLOT) === null)

  // header 档 + 选中别的 provider → 仍然渲染（右上角与当前模型无关）
  selectedProvider = 'deepseek-account'
  status.prefs.hudPosition = 'header'
  pumpPanel(); await settleNow()
  check('header 档 + 选中别的 provider：仍然渲染（不受门禁影响）',
    pillOf(HEADER_SLOT) !== null)

  // 脏值 → 退回 header
  selectedProvider = 'commandcode'
  status.prefs.hudPosition = 'somewhere-else'
  pumpPanel(); await settleNow()
  check('脏位置值 → 退回 header 档',
    pillOf(HEADER_SLOT) !== null && pillOf(COMPOSER_SLOT) === null)

  status.prefs.hudPosition = savedPos
  status.prefs.hudEnabled = savedHud
  pumpPanel(); await settleNow()
}

console.log('[3d] 胶囊自定义模板')
{
  const settleNow = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }
  const pumpPanel = () => bySlot['shell.overlay'].component({})
  const savedTpl = status.prefs.hudTemplate
  const savedHud = status.prefs.hudEnabled
  status.prefs.hudEnabled = true
  status.prefs.hudPosition = 'header'
  /** 取胶囊里那段自定义文字（.cmdgo-hud-custom 的内容）；没有则返回 null。 */
  const customText = () => {
    const node = pillOf(HEADER_SLOT)
    if (node === null) return null
    const kids = Array.isArray(node.props.children) ? node.props.children : [node.props.children]
    const hit = kids.find((k) => k && k.props && String(k.props.className).includes('cmdgo-hud-custom'))
    return hit === undefined ? null : String(hit.props.children)
  }

  // 快照里的真实数字（见上面的 status 桩）：
  //   5H 合计 = 0.60 + 2.70 = 3.30，周 = 3.00，月 = 4 + 9 = 13.00
  //   最紧百分比：alice 5H 80%（周 50%、月 60%），bob 最高 10% → 5H 80.0%
  delete status.prefs.hudTemplate
  pumpPanel(); await settleNow()
  check('没有 hudTemplate 键（老宿主）→ 用内置排版，不出现自定义段',
    customText() === null, String(customText()))

  status.prefs.hudTemplate = ''
  pumpPanel(); await settleNow()
  check('空模板 → 内置排版', customText() === null)

  status.prefs.hudTemplate = 'CC 剩{remainMonth}'
  pumpPanel(); await settleNow()
  check('模板生效：{remainMonth} 渲染成合计金额', customText() === 'CC 剩$13.00', String(customText()))

  // 用户举的那个例子：跨窗口取最紧的剩余额度。
  // 注意 {pctTight} 自带 %（百分比变量都带），模板里不要再写一个。
  status.prefs.hudTemplate = 'CC 最紧 剩{min(remain5h, remainWeek, remainMonth)} {pctTight}可用'
  pumpPanel(); await settleNow()
  // min($3.30, $3.00, $13.00) → $3.00（胜出值保留自己的格式）
  check('min() 跨窗口取最紧金额，且保留格式',
    customText() === 'CC 最紧 剩$3.00 80.0%可用', String(customText()))

  // 三个窗口各自的百分比：取各窗口里最紧的那个账号
  status.prefs.hudTemplate = '{pct5h}/{pctWeek}/{pctMonth}'
  pumpPanel(); await settleNow()
  // 5H: alice 80% vs bob 10% → 80.0%；周: 只有 alice 50% → 50.0%；
  // 月: alice 60% vs bob 10% → 60.0%
  check('单窗口百分比取该窗口最紧的账号',
    customText() === '80.0%/50.0%/60.0%', String(customText()))

  /* 剩余百分比 = 1 − 已用百分比。模板没有算术（写不了 100-pct5h），
   * 所以必须由变量直接给出 —— 这条守的正是"用户能表达出「还剩多少」"。 */
  status.prefs.hudTemplate = '{left5h}/{leftWeek}/{leftMonth}'
  pumpPanel(); await settleNow()
  check('剩余百分比 = 1 − 已用百分比（同一账号口径）',
    customText() === '20.0%/50.0%/40.0%', String(customText()))
  status.prefs.hudTemplate = '{leftTight}'
  pumpPanel(); await settleNow()
  check('{leftTight} 与 {pctTight} 相加为 100%（最紧窗口还剩 20.0%）',
    customText() === '20.0%', String(customText()))
  /* 两套百分比必须来自**同一个**账号。混用口径会让「最紧」与「剩余」互相矛盾：
   * 比如已用取最紧账号、剩余取最松账号，两行数字加起来就不是 100%。 */
  status.prefs.hudTemplate = '{pctTight}+{leftTight}'
  pumpPanel(); await settleNow()
  check('最紧窗口的已用 + 剩余 = 100%（没有第二个数据源）',
    customText() === '80.0%+20.0%', String(customText()))

  // 数据缺失 → 破折号，而不是整颗胶囊消失
  status.prefs.hudTemplate = '{calls}'
  pumpPanel(); await settleNow()
  check('meter 缺失时 {calls} 渲染成 —（胶囊仍在）',
    customText() === '—' && pillOf(HEADER_SLOT) !== null, String(customText()))

  // 语法错误 → 退回内置排版，胶囊不能坏
  status.prefs.hudTemplate = '没闭合 {remainMonth'
  pumpPanel(); await settleNow()
  check('语法错误 → 退回内置排版（胶囊仍渲染出按钮）',
    customText() === null && pillOf(HEADER_SLOT) !== null, String(customText()))

  // 未知变量 → 渲染成 ?，看得见才改得对
  status.prefs.hudTemplate = 'x{nope}'
  pumpPanel(); await settleNow()
  check('未知变量渲染成 ?', customText() === 'x?', String(customText()))

  // 中文名字不是"未知变量"而是语法错误（变量名限定 ASCII 标识符）。
  // 这条守住错误的**分类**：两类问题在设置页给的是不同的提示。
  status.prefs.hudTemplate = 'x{剩余}'
  pumpPanel(); await settleNow()
  check('中文变量名算语法错误 → 退回内置排版',
    customText() === null && pillOf(HEADER_SLOT) !== null, String(customText()))

  // 模板为空字符串以外的"纯空白"也该走内置排版（否则胶囊只剩一个点）
  status.prefs.hudTemplate = '   '
  pumpPanel(); await settleNow()
  check('纯空白模板 → 内置排版', customText() === null, String(customText()))

  // 自定义模板不能把健康指示灯挤掉：那颗点是"能不能用"的信号，与文字无关
  status.prefs.hudTemplate = '{window}'
  pumpPanel(); await settleNow()
  {
    const node = pillOf(HEADER_SLOT)
    const kids = Array.isArray(node.props.children) ? node.props.children : []
    const dot = kids.find((k) => k && k.props && String(k.props.className).includes('cmdgo-hud-dot'))
    check('自定义模板下健康指示灯仍然渲染', dot !== undefined)
    check('自定义模板不渲染内置的 CC 标签段（文字已接管）',
      !kids.some((k) => k && k.props && k.props.className === 'cmdgo-hud-tag'))
  }

  /* 模板属于**胶囊内容**，与放在哪个槽无关。这条守的是"别把它实现到
   * QuotaHudSlot 里"—— 那样只有 header 档会生效，composer 档静默不认模板。 */
  status.prefs.hudPosition = 'composer'
  selectedProvider = 'commandcode'
  status.prefs.hudTemplate = 'COMPOSER-{pctTight}'
  pumpPanel(); await settleNow()
  {
    const node = pillOf(COMPOSER_SLOT)
    const kids = node === null ? [] : (Array.isArray(node.props.children) ? node.props.children : [])
    const tplSpan = kids.find((k) => k && k.props && String(k.props.className).includes('cmdgo-hud-custom'))
    check('composer 档同样应用自定义模板',
      tplSpan !== undefined && String(tplSpan.props.children) === 'COMPOSER-80.0%',
      tplSpan === undefined ? '没找到自定义段' : String(tplSpan.props.children))
  }
  status.prefs.hudPosition = 'header'

  status.prefs.hudTemplate = savedTpl
  status.prefs.hudEnabled = savedHud
  pumpPanel(); await settleNow()
}

console.log('[4] 面板渲染（多账号逐条额度）')
const open = bySlot['shell.overlay'].component({})
// 面板用共享 store 的 open 开关；直接改不到，改用组件内部 effect 打开：
// 通过胶囊点击把 open 置位（onClick 是纯函数，可直接调用）。
pill.props.onClick({ stopPropagation: () => {} })
const panelOpen = bySlot['shell.overlay'].component({})
check('打开后面板渲染出浮层', panelOpen !== null && panelOpen.props.className === 'cmdgo-hud')
const openText = JSON.stringify(panelOpen)
check('面板列出 alice 与 bob', openText.includes('alice') && openText.includes('bob'))
check('面板含 5H / 周 / 月 三行额度', openText.includes('5H') && openText.includes('周') && openText.includes('月'))
check('面板含「添加账号」入口', openText.includes('添加账号'))
check('面板含刷新全部', openText.includes('刷新全部'))

/* 合计与理论调用次数：宿主 meter 的三种状态都要如实渲染。 */
const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve() }
const renderPanel = () => bySlot['shell.overlay'].component({})

console.log('[4b] 合计剩余（全部账号额度相加）')
// 注意：open 是「打开前」那一帧（此时面板返回 null），要用打开后的 panelOpen。
const sumText = openText
check('面板含「合计剩余」', sumText.includes('合计剩余'))
// alice 月剩 4 + bob 月剩 9 = 13；5H 0.6+2.7=3.3；周 3+未上报=3
check('月合计 $13.00（4+9）', sumText.includes('$13.00（月）'), sumText.slice(sumText.indexOf('合计剩余'), sumText.indexOf('合计剩余') + 120))
check('5H 合计 $3.30', sumText.includes('5H $3.30'))
check('周合计 $3.00', sumText.includes('周 $3.00'))
check('标出有数据的账号数 2/2', sumText.includes('2/2 个账号有数据'))

console.log('[4c] 理论调用次数：无 meter（旧宿主）不编数字')
check('面板含「理论次数」', sumText.includes('理论次数'))
check('旧宿主提示需要 0.8.0', sumText.includes('需要宿主 0.8.0'))
check('旧宿主不显示次数', !sumText.includes('≈ '))

console.log('[4d] 理论调用次数：样本不足')
status.meter = { totalCalls: 2, attributedCalls: 0, consumed: 0, samples: 0, ready: false, updatedAt: 0 }
renderPanel()
await settle()
let t4d = JSON.stringify(renderPanel())
check('样本不足时如实说明', t4d.includes('样本不足'), 'no 样本不足')
check('样本不足时给出已计数', t4d.includes('已计 2 次调用'))
check('样本不足时不给次数', !t4d.includes('≈ '))

console.log('[4e] 理论调用次数：样本足够（实测 $0.05/次）')
status.meter = { totalCalls: 41, attributedCalls: 39, consumed: 1.95, perCall: 0.05, samples: 5, ready: true, updatedAt: Date.now() }
renderPanel()
await settle()
const panelReady = renderPanel()
const t4e = JSON.stringify(panelReady)
check('给出月合计理论次数 13/0.05 = 260', t4e.includes('≈ 260 次'), t4e.slice(t4e.indexOf('理论次数'), t4e.indexOf('理论次数') + 220))
check('给出 5H 窗口内次数 3.3/0.05 = 66', t4e.includes('5H 窗口内 ≈ 66 次'))
check('标注实测单价与样本数', t4e.includes('$0.05/次') && t4e.includes('样本 39 次调用'))

console.log('[4f] 胶囊同步显示合计与次数')
const pillReady = pillOf(HEADER_SLOT)
const t4f = JSON.stringify(pillReady)
check('胶囊含合计 Σ$13.0', t4f.includes('Σ$13.0'), t4f)
check('胶囊含 ≈260次', t4f.includes('≈260次'))
check('胶囊保留最紧百分比', t4f.includes('5H 80.0%'))

console.log('[4g] 剩余额度（美元）显示在百分比左侧')
// 文案区分：行内是「剩$0.60」（无空格），tooltip 里是「剩余 $0.60」（有空格）。
// 用无空格形式命中，才能确保断言的是左侧那一列而不是 title 属性。
const iRem = t4e.indexOf('剩$0.60')
const iPct = t4e.indexOf('80.0%')
check('alice 5H 显示 剩$0.60', iRem >= 0)
check('剩余额度排在百分比之前（即左侧）', iRem >= 0 && iPct >= 0 && iRem < iPct, 'iRem=' + iRem + ' iPct=' + iPct)
check('月度行也显示剩余 剩$4.00', t4e.includes('剩$4.00'))
check('第二个账号的 5H 剩余 剩$2.70', t4e.includes('剩$2.70'))
check('周行显示剩余 剩$3.00', t4e.includes('剩$3.00'))
// 真正验证「缺字段就不渲染」：把某窗口的 remaining 抹掉再看。
const savedWeekly = status.accounts[0].usage.weekly
status.accounts[0].usage.weekly = { used: 3, cap: 6, percent: 0.5 }
renderPanel()
await settle()
check('remaining 缺失时该列整体不渲染（不出现 剩$—）', !/剩\$—/.test(JSON.stringify(renderPanel())))
status.accounts[0].usage.weekly = savedWeekly

console.log('[4h] 缓存台账（issue #6 补充诉求）')
// 会话头部的胶囊会把 sessionId 写进共享 store，面板据此带 ?sessionId= 拉本会话台账。
const pillSession = pillOf(HEADER_SLOT, { sessionId: 'sess_xyz' })
const t4hPill = JSON.stringify(pillSession)
// 胶囊里那个紧凑指示器：一个 cmdgo-hud-num span，文案以命中率结尾（箭头字符不写死）。
const compactCache = Array.isArray(pillSession.props.children)
  && pillSession.props.children.some((child) => child && child.props
    && child.props.className === 'cmdgo-hud-num'
    && typeof child.props.children === 'string' && child.props.children.endsWith('86%'))
check('胶囊显示本会话缓存命中率', compactCache === true, t4hPill)
check('胶囊 tooltip 说明本会话缓存命中', t4hPill.includes('本会话缓存命中 86%'))
renderPanel()
await settle()
const t4h = JSON.stringify(renderPanel())
check('面板带 sessionId 拉取本会话台账',
  fetchedUrls.some((u) => u.includes('/status?sessionId=sess_xyz')), fetchedUrls.slice(-3).join(' | '))
check('面板含「缓存台账」', t4h.includes('缓存台账'))
check('面板含「本会话」行', t4h.includes('本会话（abc12345）'))
check('本会话行含命中率 86%', t4h.includes('命中 86%'), t4h.slice(t4h.indexOf('本会话'), t4h.indexOf('本会话') + 160))
check('本会话行含缓存读 1.8k', t4h.includes('缓存读 1.8k'))
check('本会话行含缓存写 100', t4h.includes('缓存写 100'))
check('面板含最近一次请求行', t4h.includes('最近一次（deepseek-v4.1-flash'))
check('面板含进程内累计', t4h.includes('进程内累计：2 次'))
check('累计标出报告缓存字段的请求数', t4h.includes('报告缓存字段 2/2'))
// 旧宿主（无 cache 字段）必须如实说明，而不是编数字。
const savedCache = status.cache
delete status.cache
renderPanel()
await settle()
const t4hOld = JSON.stringify(renderPanel())
check('旧宿主提示需要 0.9.0', t4hOld.includes('需要宿主 0.9.0'), t4hOld.slice(t4hOld.indexOf('缓存台账'), t4hOld.indexOf('缓存台账') + 120))
// 网关没报缓存字段时直说，不给 0%。
status.cache = {
  last: { model: 'm', at: Date.now(), inputTokens: 12, outputTokens: 3, cacheHitRate: 0, cacheReported: false },
  total: { requests: 1, inputTokens: 12, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, cacheReportedRequests: 0 },
  sessions: [],
}
renderPanel()
await settle()
const t4hNoCache = JSON.stringify(renderPanel())
check('网关未报缓存字段时如实说明', t4hNoCache.includes('网关未报缓存字段'), t4hNoCache.slice(t4hNoCache.indexOf('最近一次'), t4hNoCache.indexOf('最近一次') + 120))
status.cache = savedCache

console.log('[5] 样式注入')
check('HUD 样式独立注入且含主题变量',
  (styleNodes.get('cmdgo-hud-style') || {}).textContent?.includes('--dsw-alias-label-primary') === true,
  'style id missing')
check('设置页 .cmdgo-* 基础样式一并注入（面板复用 QuotaBlock）',
  (styleNodes.get('cmdgo-console-style') || {}).textContent?.includes('.cmdgo-qrow') === true)
/* composer 槽里那颗胶囊要整体下移，和模型选择器对齐。
 *
 * 这条断言守的是一个**只能靠肉眼发现**的偏移：宿主那行是 flex+align-items:center，
 * 两边的盒子中心一定重合，所以「盒子没对齐」这种错误在 DOM 层面根本看不出来。
 * 偏移来自宿主标签的墨迹——「DeepSeek V4.1 Flash (latest) High」的 g 和括号把墨迹
 * 往下拖了约 2.5px（设备像素），而我们胶囊里全是大写/数字。
 *
 * 用户报过两次「胶囊偏上」。第一版只挪文字（padding-top），文字对上了、框还留在
 * 行心，变成「框比自己的字高 2px」，所以改成整颗平移。这里锁三件事：
 *   1) 规则存在且用 position+top 做整体平移（不是 padding，那只会挪字）；
 *   2) 它被 [data-slot] 限定住 —— 会话头部的胶囊旁边是会话标题（字号完全不同），
 *      设置页预览里也没有 data-slot，两边都不该跟着动；
 *   3) 基础 .cmdgo-hud-pill 的 padding 仍是 0，证明平移没有泄漏到别处。 */
const hudCssText = (styleNodes.get('cmdgo-hud-style') || {}).textContent || ''
const composerNudge = /\[data-slot="conversation\.input\.right"\]\s*\.cmdgo-hud-pill\{([^}]*)\}/.exec(hudCssText)
check('composer 槽的胶囊整体下移（否则比模型选择器高约 2.5px）',
  composerNudge !== null
  && /position:\s*relative/.test(composerNudge[1])
  && /\btop:\s*[0-9.]+px/.test(composerNudge[1]),
  composerNudge === null ? '找不到 [data-slot="conversation.input.right"] .cmdgo-hud-pill' : composerNudge[1])
check('平移不能用 padding-top 实现（那只会挪文字，框仍留在行心）',
  composerNudge !== null && !/padding/.test(composerNudge[1]),
  composerNudge === null ? '规则缺失' : composerNudge[1])
const basePillRule = /\.cmdgo-hud-pill\{([^}]*)\}/.exec(hudCssText)
check('对齐补偿只作用于 composer 槽（基础 .cmdgo-hud-pill 仍是 padding:0 9px）',
  basePillRule !== null && /padding:0 9px/.test(basePillRule[1]),
  basePillRule === null ? '找不到基础 .cmdgo-hud-pill 规则' : basePillRule[1])
/* 原生控件的配色锚点。
   宿主在 :root 上按主题设 color-scheme，它会**继承**进本分区：深色主题下
   <select> 的弹出菜单与滚动条会渲染成深色，压在固定的白色卡片上（用户报障过）。
   .cmdgo 必须显式声明 light。这条断言防的是「哪天有人觉得这行没用顺手删掉」——
   删了在浅色主题下完全看不出来，只有深色主题的用户会看到一块深色菜单。 */
const consoleCss = (styleNodes.get('cmdgo-console-style') || {}).textContent || ''
check('.cmdgo 锚定 color-scheme:light（否则深色宿主下原生下拉/滚动条翻转成深色）',
  /\.cmdgo\{[^}]*color-scheme:light/.test(consoleCss),
  'CSS 里找不到 .cmdgo{…color-scheme:light…}')
check('模型列表滚动条显式配色（不用浏览器默认灰色块）',
  consoleCss.includes('.cmdgo-models::-webkit-scrollbar-thumb'))
check('厂家芯片横向滚动条与模型列表同色（两处并排不能有色差）',
  /\.cmdgo-vendors::-webkit-scrollbar-thumb\{[^}]*var\(--cmdgo-scroll-thumb,[^)]*\)/.test(consoleCss),
  '横向滚动条 thumb 没走同一个 --cmdgo-scroll-thumb')
/* 选中芯片不能是纯黑填充。
   纯黑填充在这套配色里只属于主按钮与主徽标；芯片是次级控件，一整块纯黑会在
   浅色卡片上成为最重的元素，把视线从模型列表抢走（用户明确反馈过"全黑不好看"）。
   选中态靠「浅灰底 + 硬黑描边 + ink 文字」三件事同时成立来区分，强度够了。 */
/* 选中芯片必须是**实心反相填充**，但不能是纯黑。
   这两条一起守一个已经翻过一次车的判断：
     v1 纯黑填充（#0a0a0c）→ 用户反馈"全黑不太好看"（强度等于主按钮，太硬）
     v2 浅灰底（#f1f1f4）   → 对白底只有 1.13 对比度，用户看不出哪个被选中
     v3 深灰填充（#3f3f46） → 实心感够、又比纯黑柔一层（与白字对比 10.44 vs 19.78）
   所以既不能退回浅灰（丢可辨识性），也不能退回纯黑（丢层级）。 */
/* 选中芯片：靠**形状信号**辨识，不靠灰度深浅。
   这里定格的是一次完整的排查结论 —— 填充方案试了四版全都不行：
     v1 #0a0a0c 纯黑   白字 19.78 → "全黑不太好看"
     v2 #f1f1f4 浅灰   底vs白 1.13 → "看不出被选中"
     v3 #3f3f46 深灰   白字 10.44 → "尤其的灰"
     v4 #6e6e79 中灰   白字  5.04 → "在白色背景配合下看起来更黑"
   根因是**同时对比**：一块中性灰挨着白底，感知上一定比色值更黑。所以不是
   "灰没选对"，而是"不该用灰度表达选中"。v5 改用对勾 + 加厚描边 + 加粗字。
   断言守的就是这个决定：
     - 底必须是极浅（不能再回到任何"填充"—— 那是已证伪的方向）
     - 描边必须是硬黑且 2px（形状信号的主体）
     - 必须有对勾（::before）
     - 文字与底仍要过 AA */

/* ---------------- 配色方案（浅色 / 深色 / 跟随系统） ----------------
 * 颜色全部收敛成 --cmdgo-* 语义变量：浅色在 .cmdgo 上声明，深色在
 * .cmdgo[data-cmdgo-theme=dark] 里覆盖。所以断言要**按方案解析变量**，
 * 而不是咬死某个十六进制字面量 —— 否则一改配色就要重写一遍断言，
 * 而真正该守的东西（对比度、两套都成立）反而测不到。
 */

/** 从 `--name:value` 声明串里抓某个变量。 */
const grabVar = (block, name) => {
  const m = new RegExp('(?:^|[;{\\s])' + name.replace(/-/g, '\\-') + ':\\s*([^;}]+)').exec(block)
  return m === null ? undefined : m[1].trim()
}
const lightRule = (/\.cmdgo\{([^}]*)\}/.exec(consoleCss) || [])[1] || ''
const darkRule = (/\.cmdgo\[data-cmdgo-theme=dark\]\{([^}]*)\}/.exec(consoleCss) || [])[1] || ''
/**
 * 把值解析成最终颜色。
 * `var(--cmdgo-x,兜底)` 会先查**当前方案**的变量表，查不到才用兜底 ——
 * 这正是 CSS 的行为，冒烟里必须模拟出来，否则测到的是兜底而不是实际配色。
 */
const resolveIn = (block, value) => {
  if (typeof value !== 'string') return undefined
  const m = /^var\((--cmdgo-[a-z-]+),([^)]+)\)$/.exec(value.trim())
  if (m === null) return /^#/.test(value.trim()) ? value.trim() : undefined
  const declared = grabVar(block, m[1])
  return declared !== undefined ? resolveIn(block, declared) : m[2].trim()
}
/** 深色 = 覆盖块优先，浅色块补缺（与 CSS 层叠一致）。 */
const DARK_RULE = darkRule + ';' + lightRule

/** WCAG 相对亮度 → 对比度。用真实公式，不靠肉眼估。 */
const srgb = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
/** 展开 3 位简写（#fff → #ffffff）；CSS 简写很常见，不展开会算错。 */
const expandHex = (hex) => hex.length === 4
  ? '#' + hex[1] + hex[1] + hex[2] + hex[2] + hex[3] + hex[3]
  : hex
const relLum = (hex) => {
  const full = expandHex(hex)
  const n = parseInt(full.slice(1), 16)
  return 0.2126 * srgb((n >> 16) & 255) + 0.7152 * srgb((n >> 8) & 255) + 0.0722 * srgb(n & 255)
}
const contrast = (a, b) => {
  const la = relLum(a), lb = relLum(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}
/** 取某条规则的某个属性值。⚠️ 属性名锚在 `;`/`{`/空白之后，否则
    `color` 会先命中 `border-color`。 */
const propOf = (selectorRe, prop) => {
  const m = selectorRe.exec(consoleCss)
  if (m === null) return undefined
  const hit = new RegExp('(?:^|[;{\\s])' + prop.replace(/-/g, '\\-') + ':([^;}]*)').exec(m[1])
  return hit === null ? undefined : hit[1].trim()
}

/* 主题块本身：两套变量必须齐全。缺一个就会有两处退回兜底字面量，
   在另一套配色下露出错色的边（这类问题肉眼很难逐处发现）。 */
const tokenNames = Array.from(new Set(Array.from(lightRule.matchAll(/(--cmdgo-[a-z-]+):/g)).map((m) => m[1])))
check('浅色变量声明齐全（>30 个）', tokenNames.length > 30, 'got ' + tokenNames.length)
const darkMissing = tokenNames.filter((n) => grabVar(darkRule, n) === undefined)
check('深色覆盖块覆盖了浅色的每一个变量（漏掉的会退回浅色兜底）',
  darkMissing.length === 0, '缺：' + darkMissing.join(', '))
check('深色块同时把 color-scheme 翻成 dark（否则原生下拉仍是浅色）',
  /\.cmdgo\[data-cmdgo-theme=dark\]\{[^}]*color-scheme:dark/.test(consoleCss))

/* 选中芯片：靠**形状信号**辨识，不靠灰度深浅。
   这里定格的是一次完整的排查结论 —— 填充方案试了四版全都不行：
     v1 #0a0a0c 纯黑   白字 19.78 → "全黑不太好看"
     v2 #f1f1f4 浅灰   底vs白 1.13 → "看不出被选中"
     v3 #3f3f46 深灰   白字 10.44 → "尤其的灰"
     v4 #6e6e79 中灰   白字  5.04 → "在白色背景配合下看起来更黑"
   根因是**同时对比**：一块中性灰挨着白底，感知上一定比色值更黑。所以不是
   "灰没选对"，而是"不该用灰度表达选中"。v5 改用对勾 + 加厚描边 + 加粗字。
   断言守的就是这个决定，且**两套配色都要成立**：
     - 底与卡片几乎同亮度（不能再回到"填充"—— 已证伪的方向）
     - 描边与未选中同粗细、颜色换成 ink（只换色不换尺寸）
     - 必须有对勾（::before）
     - 文字与底仍要过 AA */
const chipSel = /\.cmdgo-vchip\.on\{([^}]*)\}/
const chipBgRaw = propOf(chipSel, 'background')
const chipFgRaw = propOf(chipSel, 'color')
for (const [label, rule] of [['浅色', lightRule], ['深色', DARK_RULE]]) {
  const chipBg = resolveIn(rule, chipBgRaw)
  const chipFg = resolveIn(rule, chipFgRaw)
  const card = resolveIn(rule, 'var(--cmdgo-card,#fff)')
  check(label + '：选中芯片底色不是灰度填充（与卡片几乎同亮度）',
    chipBg !== undefined && card !== undefined && contrast(card, chipBg) < 1.2,
    `背景 ${chipBg} 对卡片 ${card} = ${chipBg && card ? contrast(card, chipBg).toFixed(2) : '?'}`)
  check(label + '：选中芯片文字与底对比度过 WCAG AA（≥4.5）',
    chipBg !== undefined && chipFg !== undefined && contrast(chipBg, chipFg) >= 4.5,
    `背景 ${chipBg} / 文字 ${chipFg} = ${chipBg && chipFg ? contrast(chipBg, chipFg).toFixed(2) : '?'}`)
}
/* 两套配色的**每一段文字**都要在它实际所在的面之上达到能读的下限。
 *
 * ⚠️ 这里刻意不写死 4.5。浅色是作者原本就定的配色，其中几处本来就低于
 * AA（#8a8a93 的弱化文字对白底 3.42、价格小标签 4.13、hero 副标题合成后
 * 4.06）—— 那些**不是本次改动引入的**，改掉它们等于顺手改了作者的视觉，
 * 超出这次 PR 的范围。
 *
 * 所以守的不变量是「**深色不得比浅色差**」：
 *   1. 深色下绝对值必须 ≥ 4.5 —— 深色这套是我们新写的，没有历史包袱，
 *      必须一次做对；
 *   2. 浅色本来就很高的那几对（纯黑对纯白 19.78），深色不可能也不该追平 ——
 *      那需要"纯白压近黑"，在大面积深色面板上会刺眼。所以设一个**够用的天花板**：
 *      深色只要 ≥ min(浅色, 7) 就算没退步。7 是"远超 AA"的水平，
 *      低于它就是真的把可读性做差了。
 */
const AA_PAIRS = [
  ['--cmdgo-ink', '--cmdgo-card', '正文'],
  ['--cmdgo-soft', '--cmdgo-card', '次级文字'],
  ['--cmdgo-muted', '--cmdgo-card', '弱化文字'],
  ['--cmdgo-strong', '--cmdgo-raise', '价格数字'],
  ['--cmdgo-price-label', '--cmdgo-raise', '价格小标签'],
  ['--cmdgo-off-ink', '--cmdgo-off', '关闭态胶囊'],
  ['--cmdgo-green', '--cmdgo-card', '成功 / 剩余额度'],
  ['--cmdgo-amber', '--cmdgo-card', '警告'],
  ['--cmdgo-red', '--cmdgo-card', '错误'],
  ['--cmdgo-hero-ink', '--cmdgo-hero-bg', 'hero 主文字'],
  ['--cmdgo-on-ink', '--cmdgo-ink', '反相按钮'],
]
const pairRatio = (rule, fgKey, bgKey) => {
  const fg = resolveIn(rule, 'var(' + fgKey + ',#000)')
  const bg = resolveIn(rule, 'var(' + bgKey + ',#fff)')
  if (fg === undefined || bg === undefined) return undefined
  return contrast(fg, bg)
}
{
  const badDark = []
  const regressed = []
  for (const [fgKey, bgKey, why] of AA_PAIRS) {
    const light = pairRatio(lightRule, fgKey, bgKey)
    const dark = pairRatio(DARK_RULE, fgKey, bgKey)
    if (dark === undefined) { badDark.push(`${why} 无法解析`); continue }
    if (dark < 4.5) badDark.push(`${why} = ${dark.toFixed(2)}`)
    if (light !== undefined && dark < Math.min(light, 7)) {
      regressed.push(`${why} 浅 ${light.toFixed(2)} → 深 ${dark.toFixed(2)}`)
    }
  }
  check('深色：每段文字对底色都过 WCAG AA（新配色没有历史包袱，必须一次做对）',
    badDark.length === 0, badDark.join('；'))
  check('深色：对比度不低于浅色（深色不能是"更糊的那一套"）',
    regressed.length === 0, regressed.join('；'))
}

check('选中芯片靠描边换色承载信号，且与未选中同粗细（防横向抖动）',
  /\.cmdgo-vchip\.on\{[^}]*border-color:var\(--cmdgo-ink[,)]/.test(consoleCss)
  // 未选中与选中必须同粗细：只换色不换粗细，外框尺寸才恒定。
  // 不写死具体像素值 —— 粗细是设计取舍（v5 用 2px、v6 回到 1px 都合理），
  // 真正的不变量是「两边一致」。
  && /\.cmdgo-vchip\{[^}]*border:1px solid/.test(consoleCss)
  && !/\.cmdgo-vchip\.on\{[^}]*border:2px/.test(consoleCss),
  '选中/未选中的描边粗细必须一致，否则切换筛选时整排芯片会抖 1px')
check('选中芯片带对勾（0/1 的二值信号，不依赖灰度比较）',
  /\.cmdgo-vchip\.on::before\{[^}]*content:'✓'/.test(consoleCss))
check('选中芯片文字加粗（第三层形状信号）',
  /\.cmdgo-vchip\.on\{[^}]*font-weight:700/.test(consoleCss))
const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
check('选中芯片暴露 aria-pressed（对勾只是视觉，读屏要靠它）',
  /'aria-pressed': modelVendorFilter === ''/.test(clientSource)
  && /'aria-pressed': modelVendorFilter === entry\[0\]/.test(clientSource))
check('选中态与 hover 可区分（hover 只改描边/文字，底仍是白）',
  /\.cmdgo-vchip:hover\{[^}]*border-color:var\(--cmdgo-ink[,)]/.test(consoleCss)
  && !/\.cmdgo-vchip:hover\{[^}]*background:/.test(consoleCss))
check('厂家下拉框接管原生外观（原生弹层在深色宿主下无法用 CSS 控制）',
  /\.cmdgo-filter select\{[^}]*appearance:none/.test(consoleCss),
  'CSS 里找不到 .cmdgo-filter select{…appearance:none…}')
check('下拉选项跟着主题走（Windows Chromium 会沿用 color 计算弹层）',
  /\.cmdgo-filter select option\{[^}]*background-color:var\(--cmdgo-field[,)]/.test(consoleCss)
  && /\.cmdgo-filter select option\{[^}]*color:var\(--cmdgo-ink[,)]/.test(consoleCss))
// 选择器必须与**真实 DOM 结构**一致：select 是 .cmdgo-filter 的子节点。
// 写成 `.cmdgo-search select` 时整段规则静默失效（下拉框退回原生外观），
// 而只 grep CSS 文本的断言照样通过 —— 上一轮就是这么漏掉的。
check('select 的 CSS 选择器与真实 DOM 一致（不是 .cmdgo-search 的后代）',
  !/\.cmdgo-search select/.test(consoleCss))

/* ---- 配色分段控件 ---- */
check('配色控件是三档分段按钮（浅色 / 深色 / 跟随系统）',
  /const THEME_MODES = \['light', 'dark', 'system'\]/.test(clientSource))
check('默认偏好是跟随系统（与宿主 ui-theme 的 DEFAULT_PREFERENCE 一致）',
  // themePrefOf 的兜底必须是 'system'：旧宿主没有 prefs.theme 时，
  // 面板要跟页面走，而不是钉死在某一套配色。
  /function themePrefOf\(snap\) \{[\s\S]{0,200}?\? value : 'system'/.test(clientSource),
  'themePrefOf 的兜底不是 system')
check('分段控件选中态是反相实心（本页唯一的"当前值"指示器，要一眼可辨）',
  /\.cmdgo-seg-btn\.on\{[^}]*background:var\(--cmdgo-ink[,)]/.test(consoleCss)
  && /\.cmdgo-seg-btn\.on\{[^}]*color:var\(--cmdgo-on-ink[,)]/.test(consoleCss))
check('分段控件暴露 aria-pressed（实心只是视觉）',
  /'aria-pressed': on \? 'true' : 'false'/.test(clientSource))
check('配色偏好以 data-cmdgo-theme 投影到根节点（CSS 只认这个属性）',
  /className: 'cmdgo', 'data-cmdgo-theme': scheme/.test(clientSource))
check('"跟随系统"跟的是宿主主题，不是只跟操作系统',
  /function hostScheme\(\)/.test(clientSource)
  && /getTheme\(\)/.test(clientSource)
  && /data-ds-dark-theme/.test(clientSource))
check('配色切换是乐观更新（先改本地再发请求），失败要回滚',
  /const pickTheme = async \(mode\)/.test(clientSource)
  && /setSnap\(before\)/.test(clientSource))
check('固定偏好下不订阅主题事件（否则宿主每次换主题都白重渲染一次）',
  /if \(themePrefOf\(snap\) !== 'system'\) return undefined;/.test(clientSource))

/* ---- 胶囊模板编辑器（设置页） ----
 *
 * 这一段要验的不是"有没有那个输入框"，而是三件容易做错的事：
 *   1. 预览用的必须是**真实快照**渲染 —— 预览与胶囊不一致等于骗人；
 *   2. 变量表的每个名字都真的能取到值（写错名字等于给了个坏按钮）；
 *   3. 语法错误/未知变量要就地说明，而不是静默吞掉。
 */
console.log('[6] 设置页的模板编辑器')
{
  /* 期望的清单**从源码里解出来**，而不是在测试里再抄一份：
   * 抄一份的话，加了变量却忘了同步，断言照样通过 —— 那正是这段要防的事。 */
  const varBlock = /const HUD_TEMPLATE_VARS = \[([\s\S]*?)\n    \];/.exec(source)
  const HUD_VAR_NAMES = varBlock === null
    ? []
    : [...varBlock[1].matchAll(/name: '([^']+)'/g)].map((m) => m[1])
  const HUD_VAR_GROUPS = varBlock === null
    ? []
    : [...varBlock[1].matchAll(/group: '([^']+)'/g)].map((m) => m[1])
  const HUD_VAR_COLS = varBlock === null
    ? []
    : [...varBlock[1].matchAll(/col: '([^']+)'/g)].map((m) => m[1])
  const rowBlock = /const HUD_TEMPLATE_ROWS = \[([\s\S]*?)\n    \];/.exec(source)
  const HUD_ROW_KEYS = rowBlock === null
    ? []
    : [...rowBlock[1].matchAll(/key: '([^']+)'/g)].map((m) => m[1])
  const colBlock = /const HUD_TEMPLATE_COLUMNS = \[([\s\S]*?)\n    \];/.exec(source)
  const HUD_COL_KEYS = colBlock === null
    ? []
    : [...colBlock[1].matchAll(/key: '([^']+)'/g)].map((m) => m[1])
  check('从源码解出了变量清单（清单为空说明正则失效，后面的断言会假通过）',
    HUD_VAR_NAMES.length >= 10, 'vars=' + HUD_VAR_NAMES.length)
  check('每个变量都归到了已声明的行，矩阵变量还带一个已声明的列',
    HUD_VAR_GROUPS.length === HUD_VAR_NAMES.length
    && HUD_VAR_GROUPS.every((g) => g === 'other' || HUD_ROW_KEYS.indexOf(g) >= 0),
    'groups=' + JSON.stringify(HUD_VAR_GROUPS))
  /* 矩阵变量（非 other）必须每行 4 个、每列都有 —— 缺一格就意味着那个
   * 「窗口 × 口径」组合用户点不到，而 2×2 矩阵的价值正在于四个象限都齐。 */
  const matrixGroups = HUD_VAR_GROUPS.filter((g) => g !== 'other')
  check('矩阵变量每一行都恰好四个列（窗口），没有缺格',
    HUD_ROW_KEYS.every((row) => HUD_VAR_GROUPS.filter((g) => g === row).length === HUD_COL_KEYS.length)
    && matrixGroups.length % HUD_COL_KEYS.length === 0,
    'rows=' + JSON.stringify(HUD_ROW_KEYS) + ' cols=' + JSON.stringify(HUD_COL_KEYS)
      + ' matrix=' + matrixGroups.length)
  check('矩阵的列顺序是 5H / 周 / 月 / 最紧',
    JSON.stringify(HUD_COL_KEYS) === JSON.stringify(['5h', 'week', 'month', 'tight']),
    JSON.stringify(HUD_COL_KEYS))
  check('四个象限都在：剩余金额 / 剩余百分比 / 已用金额 / 已用百分比',
    JSON.stringify(HUD_ROW_KEYS) === JSON.stringify(['remain', 'left', 'used', 'pct']),
    JSON.stringify(HUD_ROW_KEYS))
  check('示例区已移除（示例属于作者仓库的文档，不该出现在 PR 里）',
    !/HUD_TEMPLATE_PRESETS/.test(source) && !/cmdgo-tpl-presets/.test(source))

  const savedTpl = status.prefs.hudTemplate
  const renderConsole = (tpl) => {
    if (tpl === undefined) delete status.prefs.hudTemplate
    else status.prefs.hudTemplate = tpl
    nextSnapshot = status
    const node = bySlot['settings.section'].component({})
    nextSnapshot = undefined
    return node
  }
  /** 在渲染结果里按 className 找节点（浅层结构够用，编辑器是平铺的）。 */
  const findAll = (node, cls) => {
    const out = []
    const go = (n) => {
      if (n === null || n === undefined || typeof n !== 'object') return
      if (Array.isArray(n)) { n.forEach(go); return }
      const c = n.props && typeof n.props.className === 'string' ? n.props.className : ''
      if (c.split(/\s+/).indexOf(cls) >= 0) out.push(n)
      go(n.props ? n.props.children : null)
    }
    go(node)
    return out
  }

  const treeDefault = renderConsole(undefined)
  const textDefault = JSON.stringify(treeDefault)
  check('编辑器在 HUD 区块里渲染（有标签与输入框）',
    textDefault.includes('HUD 文字 // 自定义模板') && findAll(treeDefault, 'cmdgo-tpl-input').length === 1)
  check('没有模板时说明当前用内置排版',
    textDefault.includes('当前用内置排版'))
  /* 空模板时输入框的占位提示必须是**插件原有的那套文字**，而不是一段示例
   * 模板 —— 用户要看到的是"现在长什么样"，不是"你可以写成什么样"。
   * 用快照里的真实数字断言，顺便验证占位与胶囊共用同一套分段。 */
  const inputNode = findAll(treeDefault, 'cmdgo-tpl-input')[0]
  const placeholder = inputNode === undefined ? '' : String(inputNode.props.placeholder)
  check('空模板时占位提示显示内置排版的真实文字',
    placeholder.startsWith('CC 5H 80.0%') && placeholder.includes('Σ$13.0'),
    placeholder)
  check('占位提示里不含模板语法（说明它是成品文字而不是示例模板）',
    !/[{}]/.test(placeholder), placeholder)
  check('预览区显示内置排版的实际文字（不是「内置排版」四个字）',
    findAll(treeDefault, 'cmdgo-tpl-pill').length === 1
    && JSON.stringify(findAll(treeDefault, 'cmdgo-tpl-pill')).includes('Σ$13.0'))
  check('内置排版下不显示「恢复内置排版」按钮（没东西可恢复）',
    !textDefault.includes('恢复内置排版'))

  const treeVars = renderConsole('{pctTight}')
  const varBtns = findAll(treeVars, 'cmdgo-var')
  check('变量表列出了全部变量', varBtns.length === HUD_VAR_NAMES.length,
    'got ' + varBtns.length + '/' + HUD_VAR_NAMES.length)
  check('变量表每个条目都显示当前值（没有一个是空的）',
    varBtns.every((b) => {
      const span = findAll(b, 'cmdgo-var-val')
      return span.length === 1 && String(span[0].props.children).length > 0
    }))
  /* 矩阵渲染：表头 + 四个数据行 + 「其他」行。每个数据行必须恰好四个芯片
   * （缺格 = 那个「窗口 × 口径」组合点不到），且行内前缀一致（混进别的口径
   * 说明矩阵位置错了，位置就不再是线索）。 */
  const rowCaps = findAll(treeVars, 'cmdgo-var-cap').map((n) => String(n.props.children))
  check('变量表是矩阵：表头 + 四行数据 + 其他',
    JSON.stringify(rowCaps) === JSON.stringify(['', '剩余金额', '剩余百分比', '已用金额', '已用百分比', '其他']),
    JSON.stringify(rowCaps))
  const colCaps = findAll(treeVars, 'cmdgo-var-col').map((n) => String(n.props.children))
  check('表头列名是 5H / 周 / 月 / 最紧',
    JSON.stringify(colCaps) === JSON.stringify(['5H', '周', '月', '最紧']),
    JSON.stringify(colCaps))
  const rowSets = findAll(treeVars, 'cmdgo-var-set')
  const perRow = rowSets.map((r) => findAll(r, 'cmdgo-var').length)
  check('每行芯片数之和等于变量总数（矩阵不漏项）',
    perRow.reduce((a, b) => a + b, 0) === HUD_VAR_NAMES.length,
    JSON.stringify(perRow))
  /* 表头那一行是列名、不含芯片，所以数据行从 index 1 开始。 */
  check('四个数据行各四个芯片（每格都填满）',
    perRow.slice(1, 5).every((n) => n === 4), JSON.stringify(perRow))
  const namesInRow = (i) => findAll(rowSets[i], 'cmdgo-var')
    .map((b) => String(findAll(b, 'cmdgo-var-name')[0].props.children))
  check('第 1 行全是剩余金额（remain*）',
    namesInRow(1).length === 4 && namesInRow(1).every((n) => n.startsWith('remain')),
    JSON.stringify(namesInRow(1)))
  check('第 2 行全是剩余百分比（left*）',
    namesInRow(2).length === 4 && namesInRow(2).every((n) => n.startsWith('left')),
    JSON.stringify(namesInRow(2)))
  check('第 3 行全是已用金额（used*）—— 这是之前缺的那个象限',
    namesInRow(3).length === 4 && namesInRow(3).every((n) => n.startsWith('used')),
    JSON.stringify(namesInRow(3)))
  check('第 4 行全是已用百分比（pct*）',
    namesInRow(4).length === 4 && namesInRow(4).every((n) => n.startsWith('pct')),
    JSON.stringify(namesInRow(4)))
  /* 矩阵的每一列也必须同口径对齐：第 i 个芯片对应同一个窗口。
   * 这条守的是"位置即线索"——若列错位，看第 3 列第 2 行就不等于"月剩余百分比"。 */
  const colAligned = [1, 2, 3, 4].every((r) => {
    const names = namesInRow(r)
    return names.length === 4
      && names.every((n, i) => n.endsWith(['5h', 'Week', 'Month', 'Tight'][i]))
  })
  check('四行的列顺序一致（5h / Week / Month / Tight 对齐成网格）', colAligned,
    [1, 2, 3, 4].map(namesInRow).map((a) => a.join(',')).join(' | '))
  /* 变量表在"取不到值"时必须显示 — 而不是 undefined / 空白。
   * 前面的 [4e] 给 status 装过 meter，这里显式摘掉，否则 calls 有值、
   * 断言测不到"缺数据"这条路径（它才是真正会出问题的那条）。 */
  const savedMeter = status.meter
  delete status.meter
  const treeEmpty = renderConsole('{pctTight}')
  const emptyVars = findAll(treeEmpty, 'cmdgo-var')
  const callsVar = emptyVars.find((b) => JSON.stringify(b).includes('calls'))
  check('缺 meter 时 {calls} 在变量表里显示 —',
    callsVar !== undefined && JSON.stringify(callsVar).includes('—'),
    JSON.stringify(callsVar))
  check('变量表不出现 undefined / null 字样',
    !/undefined|null/.test(JSON.stringify(emptyVars)))
  status.meter = savedMeter

  /* 没有账号时四个金额格都该是 —，不能是 $0.00。
   * 「读到账号但额度花光」才是 $0.00；「还没读到账号」是另一件事，
   * 显示 $0.00 会让人以为额度用尽。 */
  const savedAccounts = status.accounts
  status.accounts = []
  const treeNoAcct = renderConsole('{remainMonth}')
  const noAcctVars = findAll(treeNoAcct, 'cmdgo-var')
  const moneyRows = ['remain5h', 'remainWeek', 'remainMonth', 'used5h', 'usedWeek', 'usedMonth']
    .map((n) => noAcctVars.find((b) => JSON.stringify(b).includes('"' + n + '"')))
  check('没有账号时四个金额格都显示 —（不是 $0.00）',
    moneyRows.every((b) => b !== undefined && JSON.stringify(b).includes('—')),
    JSON.stringify(moneyRows.map((b) => (b === undefined ? 'missing' : JSON.stringify(b)))))
  check('没有账号时金额格里不出现 $0.00',
    !/\$0\.00/.test(JSON.stringify(noAcctVars)),
    JSON.stringify(noAcctVars).slice(0, 300))
  status.accounts = savedAccounts

  // 预览必须是真渲染：模板写 {remainMonth} 就要看到 $13.00（快照里的真实合计）
  const treeReal = renderConsole('剩{remainMonth}')
  check('预览用真实快照渲染（不是占位文字）',
    JSON.stringify(findAll(treeReal, 'cmdgo-tpl-pill')).includes('剩$13.00'),
    JSON.stringify(findAll(treeReal, 'cmdgo-tpl-pill')))
  check('使用自定义模板时说明可清空恢复',
    JSON.stringify(treeReal).includes('清空内容并保存即可恢复内置排版'))

  const treeBad = renderConsole('没闭合 {remainMonth')
  check('语法错误就地红字说明（不静默吞掉）',
    JSON.stringify(treeBad).includes('语法错误'))
  /* 语法错误时预览退回内置排版的实际文字，而不是半成品（`没闭合 ?`）
   * 也不是一片空白 —— 空白会让人以为"清空就报错"。 */
  const badPill = JSON.stringify(findAll(treeBad, 'cmdgo-tpl-pill'))
  check('语法错误时预览不显示半成品（退回内置排版的实际文字）',
    badPill.includes('Σ$13.0') && !badPill.includes('没闭合'), badPill)

  const treeUnknown = renderConsole('{nope}')
  check('未知变量就地列出名字',
    JSON.stringify(treeUnknown).includes('不认识的变量') && JSON.stringify(treeUnknown).includes('nope'))

  // 保存按钮：没改动时禁用（避免无意义的写盘与"点了没反应"的错觉）
  const saveBtns = findAll(renderConsole('{pctTight}'), 'cmdgo-btn-primary')
    .filter((b) => String(b.props.children).includes('保存模板'))
  check('保存按钮存在，且未改动时是禁用的', saveBtns.length === 1 && saveBtns[0].props.disabled === true)

  status.prefs.hudTemplate = savedTpl
}

/* 清掉注册的 effect 清理函数，避免桩里的订阅残留。 */
cleanups.forEach((fn) => { try { fn() } catch (e) { /* 忽略 */ } })

if (failures.length > 0) {
  console.error('\n冒烟失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\n冒烟全部通过。')
