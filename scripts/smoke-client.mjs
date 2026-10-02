/**
 * lib/client.js 的本地冒烟测试（无浏览器）。
 *
 * client.js 是手写的 __ModuleLoader__ bundle，不参与 tsc，因此用一个最小
 * 的 React/DOM/fetch 桩把 factory 跑起来，验证：
 *   1. 三个槽都注册了（设置页 / composer 模型选择器左侧的订阅胶囊 / 帧级浮层面板）；
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

const React = {
  createElement: render,
  Fragment: 'Fragment',
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c) },
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
}

/* ---------------- 桩：模型目录（composer 的模型门禁） ---------------- */

/**
 * 模拟宿主 `ctx.modelDirectories.directoryFor(sessionId)` 交出的 `ModelDirectory`：
 * 公开面是 `store`（快照 + subscribe/getSnapshot）与 `load()`。
 * `current.provider` 就是「用户当前选中的模型属于哪个 provider」。
 */
const modelStore = {
  state: { current: { provider: 'deepseek', model: 'deepseek-v4.1-flash' }, status: 'ready' },
  listeners: new Set(),
  getSnapshot() { return this.state },
  subscribe(fn) { this.listeners.add(fn); return () => { this.listeners.delete(fn) } },
  emit() { this.listeners.forEach((fn) => fn()) },
}

/** 切换「当前选中的 provider」，模拟用户在模型选择器里换模型。 */
const selectProvider = (provider) => {
  modelStore.state = { current: { provider, model: 'm' }, status: 'ready' }
  modelStore.emit()
}

const resolveDirectory = () => ({ store: modelStore, load: async () => modelStore.state })

/* ---------------- 桩：宿主 /status 快照 ---------------- */

const status = {
  ok: true,
  credentialRef: 'COMMANDCODE_API_KEY',
  credentialConfigured: true,
  modelCount: 12,
  activeAccounts: 2,
  login: { status: 'idle' },
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
const fakeFetch = async (url) => {
  fetchedUrls.push(String(url))
  if (!String(url).startsWith('/api/cmdgo/')) throw new Error('unexpected url ' + url)
  return { ok: true, status: 200, text: async () => JSON.stringify(status) }
}

/* ---------------- 桩：window / document ---------------- */

let loaded = null
const styleNodes = new Map()
globalThis.window = {
  __ModuleLoader__: { load: (def) => { loaded = def } },
  open: () => {},
  // 面板按触发点定位要用到视口尺寸（单击胶囊时量 getBoundingClientRect）。
  innerWidth: 1440,
  innerHeight: 900,
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
/** 宿主 `ctx`：slots + 模型目录服务（胶囊的模型门禁要用）。 */
const fakeCtx = {
  get: (name) => {
    if (name === 'slots') return fakeSlots
    if (name === 'modelDirectories') return { directoryFor: () => ({ store: modelStore, load: async () => modelStore.state }) }
    return undefined
  },
}
mod.apply(fakeCtx)

/**
 * 按宿主的真实渲染路径渲染一个槽条目：先跑该条目的 `inject(sessionId)` 业务面，
 * 再把结果与 session 标准件一起摊进组件 props（renderer 的 runInject 就是这么做的）。
 */
const renderEntry = (entry, sessionId) => {
  const injected = typeof entry.def.inject === 'function' ? entry.def.inject(sessionId) : {}
  return entry.component({ sessionId, ...injected })
}

/**
 * 把一棵「渲染结果」摊平成可见文本，用于断言用户实际看到的字。
 *
 * 胶囊的可见文案可能由多层 children 组成，`JSON.stringify` 命中它既要拼对结构
 * 又要拼对转义，脆弱且难读；这里只关心「屏幕上连起来是什么」，
 * 所以递归取 children 里的字符串常量即可。
 */
const visibleText = (node) => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(visibleText).join('')
  if (typeof node === 'object' && node.props) {
    const kids = node.props.children
    if (typeof node.type === 'function') return visibleText(node.type(node.props))
    return visibleText(kids)
  }
  return ''
}

/**
 * 递归收集渲染结果里 className 含 needle 的节点（用于断言「不该出现的样式」）。
 */
const findByClass = (node, needle, out = []) => {
  if (Array.isArray(node)) { node.forEach((n) => findByClass(n, needle, out)); return out }
  if (node && typeof node === 'object' && node.props) {
    if (String(node.props.className || '').includes(needle)) out.push(node)
    findByClass(node.props.children, needle, out)
  }
  return out
}

console.log('[1] 槽注册')
check('注册了 3 个条目', regs.length === 3, 'got ' + regs.length)
const bySlot = Object.fromEntries(regs.map((r) => [r.def.name, r]))
check('settings.section 存在', bySlot['settings.section'] !== undefined)
check('订阅胶囊注册在 composer 的模型选择器左侧（conversation.input.right）',
  bySlot['conversation.input.right'] !== undefined
  && bySlot['conversation.input.right'].def.id === 'commandcode-go-quota')
check('胶囊不再占用会话头部工具区',
  bySlot['conversation.session.header.utilities'] === undefined)
check('shell.overlay 面板已注册',
  bySlot['shell.overlay'] !== undefined
  && bySlot['shell.overlay'].def.id === 'commandcode-go-quota-panel')

/* 面板挂载时经 useEffect → refresh() 写入共享快照；等 microtask 落地。 */
console.log('[2] 面板首帧与轮询')
const panelEl = bySlot['shell.overlay'].component({})
check('面板关闭时不渲染（只做轮询）', panelEl === null)
for (let i = 0; i < 12; i += 1) await Promise.resolve()

console.log('[3] 模型门禁：只有选中 CommandCode 的模型才显示胶囊')
// 目录初始选中 deepseek → 胶囊必须整颗不渲染（用户明确要求的行为）。
selectProvider('deepseek')
const pillOther = renderEntry(bySlot['conversation.input.right'], 'sess_xyz')
check('选中非 CommandCode 模型时不渲染胶囊', pillOther === null, JSON.stringify(pillOther))
// 切到本插件模型 → 胶囊出现。
selectProvider('commandcode')
const pill = renderEntry(bySlot['conversation.input.right'], 'sess_xyz')
check('选中 commandcode 模型时渲染出胶囊', pill !== null && pill.type === 'button', JSON.stringify(pill))
const pillText = JSON.stringify(pill)
const pillSeen = visibleText(pill)
check('胶囊用品牌全称而不是 CC 缩写', pillSeen.includes('Command Code'), pillSeen)
check('胶囊不再用 Σ / ≈n次 这类缩写',
  !pillSeen.includes('\u03a3') && !pillSeen.includes('\u2248'), pillSeen)
// 文案要能一眼读懂：最紧的是哪条窗口、用了多少、还剩多少。
// 夹具里 alice 的 5H 已用 80%、剩余 $0.60，是全账号里最紧的一条。
check('胶囊写清最紧窗口与用量「最紧:5H 「用80.0% 剩$0.60」」',
  pillSeen.includes('最紧:5H \u300c用80.0% \u5269$0.60\u300d'), pillSeen)
// 括号必须用 CJK 角括号「」，不是半角 ()/全角 （）：
// 实测「」与中文同回退字体，偏差 +0.50px，而 ()/（） 都来自 Consolas、偏差 +1.00px。
check('括号用 CJK 角括号「」（而非 ()/（））',
  pillSeen.includes('\u300c') && pillSeen.includes('\u300d')
  && !/[()（）]/.test(pillSeen), pillSeen)
check('胶囊带上该窗口的剩余额度「剩$0.60」', pillSeen.includes('\u5269$0.60'), pillSeen)
check('两段之间用空格分隔（不再用 ·）', pillSeen.includes('用80.0% \u5269$0.60'), pillSeen)
// 用量段是**纯文本**：不分段上色、也不加粗。胶囊是常驻的低干扰指示，
// 红/黄会持续抢注意力，还会和「状态点」的红黄语义撞车（那个点说的是账号池健康度）。
check('用量段没有内部分段 span（不再按严重度上色）',
  (() => {
    const num = findByClass(pill, 'cmdgo-hud-num')[0]
    return num !== undefined && typeof num.props.children === 'string'
  })(),
  JSON.stringify(findByClass(pill, 'cmdgo-hud-num')[0]?.props.children))
check('不再出现 cmdgo-hud-sev / money / brk 这些上色与分组 span',
  findByClass(pill, 'cmdgo-hud-sev').length === 0
  && findByClass(pill, 'cmdgo-hud-money').length === 0
  && findByClass(pill, 'cmdgo-hud-brk').length === 0)
check('余的是最紧那条窗口的剩余（不是账号月合计 $4）',
  pillSeen.includes('\u5269$0.60') && !pillSeen.includes('\u5269$4.00'), pillSeen)
// 悬停提示保留精确数字与合计/次数（胶囊删掉的信息在这里仍可查）。
check('title 保留精确剩余与账号名',
  pillText.includes('剩余 $0.60') && pillText.includes('alice'), pillText)
// 再切回去 → 立刻收起（订阅要真的转发 onChange）。
selectProvider('deepseek')
check('切回其它模型后胶囊再次隐藏',
  renderEntry(bySlot['conversation.input.right'], 'sess_xyz') === null)
selectProvider('commandcode')

console.log('[3b] 「最紧」按剩余金额排，不按百分比')
// 用摊平后的可见文本断言（胶囊用量段是嵌套 span，比 JSON 结构稳）。
const renderPillText = () => {
  const pill = renderEntry(bySlot['conversation.input.right'], 'sess_xyz')
  return pill === null ? '(胶囊未渲染)' : visibleText(pill)
}
// 胶囊读的是共享快照（由 shell.overlay 的面板轮询写入），改了 status 必须让
// 面板重跑一次 refresh 才能把新快照写进 store —— 抽个小工具避免到处重复。
const applyAccounts = async (accounts) => {
  status.accounts = accounts
  bySlot['shell.overlay'].component({})
  for (let i = 0; i < 12; i += 1) await Promise.resolve()
}
const savedAccts = status.accounts
// 构造一组「百分比最高的条 ≠ 剩余金额最少的条」的账号，才能区分两种口径：
//   月 已用 20%（余 $40）  ← 百分比最低，但钱最多（不该被选中）
//   5H 已用 90%（余 $0.30）← 百分比最高 + 钱最少
//   周 已用 50%（余 $0.05）← 钱最少但百分比不是最高 → **只有按钱排才会选中它**
await applyAccounts([{
  id: 'a1', ref: 'R', userName: 'u', keyName: 'k', addedAt: 1, enabled: true,
  failCount: 0, cooling: false, configured: true,
  usage: {
    ok: true, plan: { name: 'Go' }, limited: true,
    monthly: { remaining: 40, total: 50, used: 10, percent: 0.2, extra: 0 },
    fiveHour: { used: 2.7, cap: 3, remaining: 0.3, percent: 0.9, exceeded: false },
    weekly: { used: 3, cap: 6, remaining: 0.05, percent: 0.5, exceeded: false },
  },
}])
let t3b = renderPillText()
check('选中的是剩余金额最少的「周 剩$0.05」（而非百分比最高的 5H 90%）',
  t3b.includes('最紧:周') && t3b.includes('\u5269$0.05'), t3b)
check('同一条里同时给出该窗口的百分比 用50.0%',
  t3b.includes('最紧:周 \u300c用50.0% \u5269$0.05\u300d'), t3b)
// 月末余额缺失（宿主未识别套餐，monthly 既无 remaining 也无 percent）：
// 这条窗口没有任何可信数字，不能参与比较、更不能被当成「剩 $0」抢走最紧。
// 此时应在**可信的** 5H（余 $2.25）与周（余 $1.50）里按钱选出周。
await applyAccounts([{
  id: 'a1', ref: 'R', userName: 'u', keyName: 'k', addedAt: 1, enabled: true,
  failCount: 0, cooling: false, configured: true,
  usage: {
    ok: true, plan: { name: 'Command Code' }, limited: true,
    monthly: { purchased: 0, free: 0, extra: 0 },
    fiveHour: { used: 0.75, cap: 3, remaining: 2.25, percent: 0.25, exceeded: false },
    weekly: { used: 4.5, cap: 6, remaining: 1.5, percent: 0.75, exceeded: false },
  },
}])
t3b = renderPillText()
check('月末余额缺失时不选中「月」，也不编出「剩$0」',
  t3b.includes('最紧:周') && !t3b.includes('最紧:月') && !t3b.includes('\u5269$0.00'), t3b)
check('在可信的两条里仍按金额选出更少的周（$1.50 < $2.25）',
  t3b.includes('用75.0% \u5269$1.50'), t3b)
// 5H/周 没有 cap：宿主按 cap=0 算出 remaining=0，但那是「上限未知」不是「用光」。
// 一旦这种假的 0 参与金额比较，就会永远霸占「最紧」——必须排除。
await applyAccounts([{
  id: 'a1', ref: 'R', userName: 'u', keyName: 'k', addedAt: 1, enabled: true,
  failCount: 0, cooling: false, configured: true,
  usage: {
    ok: true, plan: { name: 'Go' }, limited: true,
    monthly: { remaining: 5, total: 10, used: 5, percent: 0.5, extra: 0 },
    fiveHour: { used: 0, cap: 0, remaining: 0, exceeded: false },
    weekly: { used: 0, cap: 0, remaining: 0, exceeded: false },
  },
}])
t3b = renderPillText()
check('cap=0 的假 remaining=0 不参与金额比较（否则永远霸占最紧）',
  t3b.includes('最紧:月 \u300c用50.0% \u5269$5.00\u300d'), t3b)
// 金额与百分比**都**缺失：不该渲染出一对空括号 「」 —— 那会让人以为
// 数字还在加载。此时只留窗口名（最紧:月）。
await applyAccounts([{
  id: 'a1', ref: 'R', userName: 'u', keyName: 'k', addedAt: 1, enabled: true,
  failCount: 0, cooling: false, configured: true,
  usage: {
    ok: true, plan: { name: 'Command Code' }, limited: true,
    monthly: { remaining: 2, total: 10, percent: 0.8, extra: 0 },
  },
}])
t3b = renderPillText()
check('两段都缺时不渲染空括号「」', !t3b.includes('\u300c\u300d'), t3b)
check('两段都缺时仍显示窗口名', t3b.includes('最紧:月'), t3b)
await applyAccounts(savedAccts)

console.log('[4] 面板渲染（多账号逐条额度）')
const open = bySlot['shell.overlay'].component({})
// 面板用共享 store 的 open 开关；直接改不到，改用组件内部 effect 打开：
// 通过胶囊点击把 open 置位（onClick 是纯函数，可直接调用）。
// currentTarget 带 getBoundingClientRect：模拟真实点击时量到的胶囊位置。
pill.props.onClick({
  stopPropagation: () => {},
  currentTarget: { getBoundingClientRect: () => ({ top: 760, right: 1120, width: 210 }) },
})
const panelOpen = bySlot['shell.overlay'].component({})
check('打开后面板渲染出浮层', panelOpen !== null && panelOpen.props.className === 'cmdgo-hud')
// 面板必须贴在胶囊正上方（视口高 900，胶囊顶边 760 → bottom = 900-760+8 = 148）。
check('面板按胶囊位置向上展开',
  panelOpen.props.style?.bottom === '148px', JSON.stringify(panelOpen.props.style))
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

console.log('[4f] 胶囊只留「最紧」一段（合计与次数移出胶囊）')
const pillReady = renderEntry(bySlot['conversation.input.right'], 'sess_xyz')
const t4f = JSON.stringify(pillReady)
// 只断言**可见文本**（children），不能连 title 一起断言：title 按设计保留
// 完整信息（含 ≈ 次数），拿整份 JSON 去否定 '≈' 必然误报。
const t4fVisible = visibleText(pillReady)
check('胶囊仍显示最紧窗口与用量', t4fVisible.includes('最紧:5H \u300c用80.0% \u5269$0.60\u300d'), t4fVisible)
check('胶囊可见文本里只有角括号、没有 ()/（）',
  t4fVisible.includes('\u300c') && t4fVisible.includes('\u300d')
  && !/[()（）]/.test(t4fVisible), t4fVisible)
// 用户明确要求胶囊只留最紧那段：合计与理论次数不再挤进胶囊，
// 但它们仍必须在 title 与面板里查得到（下面的断言负责守住这一点）。
check('胶囊不再显示合计 Σ', !t4fVisible.includes('\u03a3'), t4fVisible)
check('胶囊不再显示理论次数 ≈n次', !t4fVisible.includes('\u2248'), t4fVisible)
check('合计与次数仍可在 title 里查到',
  t4f.includes('\u5408\u8ba1\u5269\u4f59 $13.00') && t4f.includes('\u7406\u8bba\u8c03\u7528\u6b21\u6570 \u2248 260 \u6b21'), t4f)
check('面板仍给出理论次数', t4e.includes('\u2248 260 \u6b21'))

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
// composer 里的胶囊会把 sessionId 写进共享 store，面板据此带 ?sessionId= 拉本会话台账。
const pillSession = renderEntry(bySlot['conversation.input.right'], 'sess_xyz')
const t4hPill = JSON.stringify(pillSession)
// 胶囊里那个紧凑指示器：一个 cmdgo-hud-cache span，文案形如「缓存86%」
// （不再用看不懂的 ⤢ 箭头）。
const compactCache = Array.isArray(pillSession.props.children)
  && pillSession.props.children.some((child) => child && child.props
    && child.props.className === 'cmdgo-hud-num cmdgo-hud-cache'
    && typeof child.props.children === 'string' && child.props.children === '\u7f13\u5b5886%')
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
// 字体统一：数字段**不能**自带等宽 font-family（否则中英混排会错位 + 轻重不一），
// 而应继承 .cmdgo-hud-pill 的 font:inherit（即 DSH 的 UI 栈）。
const hudCss = (styleNodes.get('cmdgo-hud-style') || {}).textContent || ''
const numRule = (hudCss.match(/\.cmdgo-hud-num\{[^}]*\}/) || [''])[0]
check('.cmdgo-hud-num 不含等宽 font-family（统一走 UI 栈）',
  numRule.length > 0 && !/font-family\s*:/.test(numRule), numRule)
check('.cmdgo-hud-num 仍保留 tabular-nums（数字等宽、宽度不抖）',
  /font-variant-numeric\s*:\s*tabular-nums/.test(numRule), numRule)
check('胶囊各段都是常规字重（无 600/bold）',
  !/\.cmdgo-hud-(num|brand|pill)\{[^}]*font-weight\s*:\s*(600|700|bold)/.test(hudCss)
  && /\.cmdgo-hud-num\{[^}]*font-weight\s*:\s*400/.test(hudCss), hudCss.slice(0, 0) || numRule)

/* ---- 额度行字号：余额数字必须是行内最大的字 ----
   原来整行一律 10.5px，钱读不清（用户报障「余额数字太小」）。
   这些断言把「钱最大」这个意图钉住，避免以后被无意改回小字。
   列宽同时必须 ≥ 内容自然宽度，否则右对齐的定宽列会**折行**（行高翻倍，
   比溢出更难看）——下面用 fmtMoney 真能产出的最宽值「剩$99.99」校验。 */
const consoleCss = (styleNodes.get('cmdgo-console-style') || {}).textContent || ''
const ruleOf = (css, sel) => (css.match(new RegExp(sel.replace('.', '\\.') + '\\{([^}]*)\\}')) || ['', ''])[1]
const px = (rule, prop) => {
  const m = rule.match(new RegExp(prop + '\\s*:\\s*([\\d.]+)px'))
  return m ? Number(m[1]) : null
}
const rowFont = px(ruleOf(consoleCss, '.cmdgo-qrow'), 'font-size')
const remFont = px(ruleOf(consoleCss, '.cmdgo-qrem'), 'font-size')
const pctFont = px(ruleOf(consoleCss, '.cmdgo-qpct'), 'font-size')
check('额度行基础字号放大到 12px（原 10.5px）', rowFont === 12, String(rowFont))
check('剩余金额字号 14px，是行内最大的字',
  remFont === 14 && remFont > pctFont && pctFont > rowFont,
  'rem=' + remFont + ' pct=' + pctFont + ' row=' + rowFont)
check('百分比也比基础字号大（13px）', pctFont === 13, String(pctFont))
// 列宽：剩余额度列必须容下最宽现实值。等宽栈下「剩$99.99」(7 字符) 比
// 「剩$9999」(6 字符) 宽 —— fmtMoney 在 <100 时保留两位小数，所以前者才是上界。
const remW = px(ruleOf(consoleCss, '.cmdgo-qrem'), 'width')
check('剩余额度列宽 ≥ 66px（容得下 14px 的「剩$99.99」≈61.2px，并留字体回退余量）',
  remW !== null && remW >= 66, String(remW))
const hudRemRule = (hudCss.match(/\.cmdgo-hud \.cmdgo-qrem\{([^}]*)\}/) || ['', ''])[1]
const hudRemW = px(hudRemRule, 'width')
check('浮层里剩余额度列也 ≥ 64px（否则会折行）',
  hudRemW !== null && hudRemW >= 64, String(hudRemW))
// 重置列同理：12px 下「12h59m 后重置」≈82.2px，原来的 78 会被折行。
check('设置页重置列 ≥ 94px（容得下 12px 的「12h59m 后重置」≈82.2px）',
  px(ruleOf(consoleCss, '.cmdgo-qreset'), 'width') >= 94,
  String(px(ruleOf(consoleCss, '.cmdgo-qreset'), 'width')))
check('浮层重置列 ≥ 86px',
  px((hudCss.match(/\.cmdgo-hud \.cmdgo-qreset\{([^}]*)\}/) || ['', ''])[1], 'width') >= 86)
// 进度条跟着字一起长高，否则 12px 文字配 7px 细条会显得头重脚轻。
check('进度条加高到 9px（配合放大后的字号）',
  px(ruleOf(consoleCss, '.cmdgo-qbar'), 'height') === 9,
  String(px(ruleOf(consoleCss, '.cmdgo-qbar'), 'height')))
check('渲染次数 > 0', renders > 0)

/* 清掉注册的 effect 清理函数，避免桩里的订阅残留。 */
/* ---- 设置页跟随主题（深色）----
   原设置页写死浅色，在深色主题下是一块白斑（用户报障）。
   关键不变量有两条，都必须守住：
     1. 规则体里不能再有硬编码颜色（否则深色下就是白斑）；
     2. **浅色取值必须与改造前逐像素一致** —— 这次只是"加深色支持"。
   第 2 条用一个不变量表达：每处 var(--cmdgo-x,<兜底>) 的兜底，
   必须等于该变量在 .cmdgo 里的浅色定义。兜底写的就是"这个位置原来是什么颜色"，
   一旦有人把两个不同色值的字面量并到同一个变量上（我第一版就这么错过 8 处），
   浅色会被悄悄改掉而深色看着正常，极难发现 —— 这条断言专门守它。 */
const darkBlock = (consoleCss.match(/body\[data-ds-dark-theme\] \.cmdgo\{([\s\S]*?)\n\}/) || ['', ''])[1]
check('存在深色主题覆盖块（body[data-ds-dark-theme] .cmdgo）', darkBlock.length > 0)
check('深色块用的是宿主主题 token（--dsw-alias-*）',
  (darkBlock.match(/--dsw-alias-/g) || []).length >= 25,
  String((darkBlock.match(/--dsw-alias-/g) || []).length))
// 深色下 hero 不能直接用 --cmdgo-ink（那个在深色下接近纯白，会糊一整块亮斑）
check('hero 有独立的深色取值（不复用 ink）',
  /--cmdgo-hero-bg:\s*var\(--dsw-alias-bg-layer-3\)/.test(darkBlock)
  && /--cmdgo-hero-ink:\s*var\(--dsw-alias-label-primary\)/.test(darkBlock),
  (darkBlock.match(/--cmdgo-hero-[a-z-]+:[^;]+/g) || []).join(' '))
check('声明 color-scheme，让原生控件（下拉/滚动条）也走深色',
  /color-scheme:dark/.test(darkBlock) && /color-scheme:light/.test(consoleCss))

// 规则体里不该再有硬编码颜色：剔掉变量定义区与 var 兜底后再找。
const bodyOnly = consoleCss
  .replace(/var\(--cmdgo-[a-z-]+,[^)]*\)/g, 'VAR')
  .replace(/^\s*--cmdgo-[a-z-]+:[^;]*;.*$/gm, '')
const ALLOW = new Set(['#ff2e63', '#21d4fd', '#2bd576', '#f5b52e',
  'rgba(43,213,118,.8)', 'rgba(245,181,46,.8)', 'rgba(255,255,255,.04)'])
const hardColors = [...new Set([...bodyOnly.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map((m) => m[0]))]
  .filter((c) => !ALLOW.has(c))
check('规则体里没有硬编码颜色（深色下才不会留白斑）',
  hardColors.length === 0, hardColors.join(' '))

// 浅色等价性：兜底 == 该变量的浅色定义。
const lightDefs = {}
for (const m of (consoleCss.match(/\.cmdgo\{([\s\S]*?)\n\}/) || ['', ''])[1]
  .matchAll(/(--cmdgo-[a-z-]+)\s*:\s*([^;]+);/g)) lightDefs[m[1]] = m[2].trim()
/** 取 var(--cmdgo-x,<兜底>) 的兜底；兜底可能含括号（rgba(...)），需括号配平。 */
const usedVars = []
{
  const re = /var\(--cmdgo-([a-z-]+),/g
  let m
  while ((m = re.exec(consoleCss)) !== null) {
    let i = m.index + m[0].length
    let depth = 1
    const start = i
    for (; i < consoleCss.length; i += 1) {
      if (consoleCss[i] === '(') depth += 1
      else if (consoleCss[i] === ')') { depth -= 1; if (depth === 0) break }
    }
    usedVars.push({ name: '--cmdgo-' + m[1], fallback: consoleCss.slice(start, i).trim() })
  }
}
const drifted = [...new Set(usedVars
  .filter(({ name, fallback }) => (lightDefs[name] || '').toLowerCase() !== fallback.toLowerCase())
  .map(({ name, fallback }) => name + '(兜底' + fallback + '≠浅色' + (lightDefs[name] || '未定义') + ')'))]
check('浅色取值与改造前逐像素一致（每处兜底 == 该变量的浅色定义）',
  drifted.length === 0, drifted.join(' '))
check('变量确实被用上了（不是定义了却没人引用）',
  usedVars.length >= 100, String(usedVars.length))
// HUD 面板复用 .cmdgo-qrow 等规则，但**不在 .cmdgo 里**，取不到变量；
// 因此每处 var() 都必须带兜底，否则 HUD 会掉色。
check('每处 var(--cmdgo-*) 都带浅色兜底（HUD 复用这些规则时会取不到变量）',
  usedVars.every(({ fallback }) => fallback.length > 0),
  usedVars.filter(({ fallback }) => fallback.length === 0).map((v) => v.name).join(' '))

cleanups.forEach((fn) => { try { fn() } catch (e) { /* 忽略 */ } })

if (failures.length > 0) {
  console.error('\n冒烟失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\n冒烟全部通过。')
