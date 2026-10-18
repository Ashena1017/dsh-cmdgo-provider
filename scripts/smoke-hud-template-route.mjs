/**
 * `/api/cmdgo/hud/template` 路由的宿主侧测试。
 *
 * 为什么需要单独一份：客户端那边（smoke-client.mjs）用的是**假 fetch**，
 * 它证明了"界面会按返回值更新"，但完全没有碰过真实的 handler。而这个功能
 * 唯一一处服务端校验（必须是字符串、超长要截断）正好就在 handler 里 ——
 * 不驱动它，就等于没测。
 *
 * 顺带把「老偏好文件没有 hudTemplate 键」这条兼容路径也钉住：那是最容易
 * 在重构里丢掉的一条（丢了的表现是所有人升级后模板凭空消失）。
 *
 * 用法：node scripts/smoke-hud-template-route.mjs
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

let fails = 0
const check = (label, ok, extra) => {
  if (ok) console.log('  ok  ' + label)
  else { fails += 1; console.log('  FAIL ' + label + (extra === undefined ? '' : ' → ' + extra)) }
}

/**
 * prefs 落在 `homedir()` 下，不是 DSH_HOME —— 所以先把 HOME 指向临时目录，
 * 否则这个测试会去改用户真实的 ~/.dsh/cmdgo-prefs.json。
 * （必须在本文件 import lib/index.js **之前**生效？不必：路径在构造时才解析。）
 */
const home = await mkdtemp(join(tmpdir(), 'cmdgo-route-'))
process.env.HOME = home
process.env.USERPROFILE = home

/* ---------------- 宿主桩 ---------------- */

/**
 * 造一个能跑起 `apply()` 的最小 ctx。
 *
 * 路由挂在 `ctx.inject(['webServer'], ...)` 里，所以 inject 必须**真的调用回调**
 * 并把 register 收下来 —— 收不到 route 这个测试就等于没跑。
 * 其余服务（credentials / llm / settings）能给就给最小可用形状：插件对它们
 * 都有「缺席就退化」的路径，缺一个不影响路由本身。
 */
const makeCtx = () => {
  const state = { route: null, disposed: [] }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    fiber: { id: 'cmdgo-provider' },
    effect(fn) { const d = fn(); if (typeof d === 'function') state.disposed.push(d) },
    on() { return () => {} },
    provide() {},
    plugin() {},
    get(name) {
      if (name === 'webServer') return { register: (r) => { state.route = r; return () => {} } }
      return undefined
    },
    inject(names, cb) { if (names.includes('webServer')) cb(ctx) },
    llm: {
      registerConfigurableProviders: () => () => {},
      registerAdapter: () => ({ replace: () => {} }),
    },
  }
  return { ctx, state }
}

const { ctx, state } = makeCtx()
apply(ctx, { apiKeyEnv: 'COMMANDCODE_API_KEY' })
await new Promise((r) => setTimeout(r, 60))
const route = state.route
check('注册了 /api/cmdgo 路由',
  route !== null && route.path === '/api/cmdgo' && typeof route.handler === 'function')

/* ---------------- 请求 / 响应桩 ---------------- */

const call = async (method, path, body, headers) => {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = {
    method,
    url: path,
    headers: Object.assign({ 'content-type': 'application/json', host: '127.0.0.1:1' }, headers || {}),
    on: (event, cb) => {
      if (event === 'data' && payload !== '') cb(Buffer.from(payload, 'utf8'))
      if (event === 'end') cb()
    },
  }
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    end(data) { this.body = data || '' },
  }
  await route.handler(req, res)
  let parsed = null
  try { parsed = JSON.parse(res.body) } catch (e) { parsed = null }
  return { status: res.statusCode, json: parsed, raw: res.body }
}

/* ---------------- 用例 ---------------- */

console.log('[1] 保存模板')
{
  const r = await call('POST', '/api/cmdgo/hud/template', { template: 'CC {pctTight}' })
  check('返回 200', r.status === 200, String(r.status) + ' ' + r.raw.slice(0, 120))
  // 注意形状：偏好类接口把 prefs.snapshot() **摊平**在顶层（不是嵌在 prefs 下），
  // 与 GET /status 的 `{prefs:{...}}` 不同。客户端 saveHudTemplate 读的也是顶层。
  check('回传快照里带着刚存的模板',
    r.json !== null && r.json.hudTemplate === 'CC {pctTight}',
    JSON.stringify(r.json))
  check('回传的顶层就是偏好快照（hiddenModels/hudEnabled 等同级）',
    r.json !== null && Array.isArray(r.json.hiddenModels) && typeof r.json.hudEnabled === 'boolean',
    JSON.stringify(r.json))
}
{
  const r = await call('POST', '/api/cmdgo/hud/template', { template: '' })
  check('空串 = 恢复内置排版，也返回 200', r.status === 200 && r.json.hudTemplate === '',
    r.raw.slice(0, 120))
}

console.log('[2] 边界校验')
{
  const r = await call('POST', '/api/cmdgo/hud/template', { template: 42 })
  check('非字符串 → 400', r.status === 400, String(r.status) + ' ' + r.raw.slice(0, 120))
}
{
  const r = await call('POST', '/api/cmdgo/hud/template', {})
  check('缺 template 字段 → 400', r.status === 400, String(r.status))
}
{
  const r = await call('POST', '/api/cmdgo/hud/template', { template: null })
  check('null → 400（不把 null 当空串）', r.status === 400, String(r.status))
}
{
  const long = 'x'.repeat(500)
  const r = await call('POST', '/api/cmdgo/hud/template', { template: long })
  check('超长模板被截断到 300 字符', r.status === 200 && r.json.hudTemplate.length === 300,
    r.json ? String(r.json.hudTemplate.length) : '?')
}

console.log('[3] 语法错误**不**在服务端拦（要在设置页里讲清楚）')
{
  // 关键取舍：服务端只存字符串。把语法校验放这里会让用户打字打到一半就被 400，
  // 而 400 的信息量远不如设置页里那行"第几个字符错了"。
  const bad = '没闭合 {remainMonth'
  const r = await call('POST', '/api/cmdgo/hud/template', { template: bad })
  check('语法错误的模板照存不误（返回 200）', r.status === 200, String(r.status))
  check('原样保存，没有被"顺手修好"', r.json.hudTemplate === bad, JSON.stringify(r.json.hudTemplate))
}

console.log('[4] GET /status 带出模板偏好')
{
  const r = await call('GET', '/api/cmdgo/status')
  check('200 且 prefs.hudTemplate 存在',
    r.status === 200 && r.json && r.json.prefs && typeof r.json.prefs.hudTemplate === 'string',
    JSON.stringify(r.json && r.json.prefs))
}

console.log('[5] 落盘格式')
{
  const text = await readFile(join(home, '.dsh', 'cmdgo-prefs.json'), 'utf8')
  const parsed = JSON.parse(text)
  check('偏好文件里有 hudTemplate 键', typeof parsed.hudTemplate === 'string', text.slice(0, 200))
  check('其它偏好没被这次写入弄丢（hudEnabled 等仍在）',
    typeof parsed.hudEnabled === 'boolean' && Array.isArray(parsed.hiddenModels), text.slice(0, 200))
}

console.log('[6] 老偏好文件没有 hudTemplate 键 → 走内置排版')
{
  // 直接写一份"旧版"文件，再让插件重新读。
  await writeFile(join(home, '.dsh', 'cmdgo-prefs.json'),
    JSON.stringify({ version: 1, hiddenModels: [], hudEnabled: true }, null, 2), 'utf8')
  // 重新 apply 一份新 ctx（构造时会读盘）。
  const second = makeCtx()
  apply(second.ctx, { apiKeyEnv: 'COMMANDCODE_API_KEY' })
  await new Promise((r) => setTimeout(r, 60))
  const route2 = second.state.route
  check('第二份实例也注册了路由', route2 !== null && typeof route2.handler === 'function')

  const req = {
    method: 'GET', url: '/api/cmdgo/status', headers: { host: '127.0.0.1:1' },
    on: (ev, cb) => { if (ev === 'end') cb() },
  }
  const res = { statusCode: 0, headers: {}, body: '', setHeader() {}, end(d) { this.body = d || '' } }
  await route2.handler(req, res)
  const json = JSON.parse(res.body)
  check('缺键 → hudTemplate 是空串（客户端据此用内置排版）',
    json.prefs.hudTemplate === '', JSON.stringify(json.prefs))
  check('其它偏好照常读出（hudEnabled=true）', json.prefs.hudEnabled === true)
}

console.log('[7] 未知 action 仍然是 404（没有把路由表写坏）')
{
  const r = await call('POST', '/api/cmdgo/hud/nonsense', {})
  check('404', r.status === 404, String(r.status))
}

state.disposed.forEach((fn) => { try { fn() } catch (e) { /* 忽略 */ } })
console.log(fails === 0 ? '\n模板路由测试全部通过。' : `\n${fails} 项失败。`)
process.exitCode = fails === 0 ? 0 : 1