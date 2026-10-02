/**
 * 协议层的本地单元测试（直接跑编译产物 lib/protocol.js + lib/adapter.js，无宿主依赖）。
 *
 * 这里钉的是 issue #5 / #6 的两条不变量：
 *
 * [A] 工具调用双射（issue #5 —— 网关判「Tool result is missing」把会话卡死）：
 *     1. 孤儿调用（有 tool-call 没结果）→ 丢掉；
 *     2. 孤儿结果（有结果没调用）→ 也丢掉（反向孤儿同样破坏形状）；
 *     3. 同 id 重复 → 两侧各只发一次；
 *     4. 自愈点名（repair.dropToolCallIds）→ 两侧一起丢；
 *     5. 被丢掉的结果里嵌的图片不许单独发出去。
 *
 * [B] 流事件 → chunk：
 *     6. 缺 id 的 tool-call 按块下标合成唯一 id；
 *     7. 同一个调用的重复投递（id + 载荷相同）→ 丢掉，不让工具被执行两次；
 *     8. 同 id 但载荷不同 → 加后缀区分，保住这次真实调用；
 *     9. usage 的缓存读 / 写如实透传（缺失时省略，不编 0）。
 *
 * [C] x-session-id（issue #6）：
 *    10. 官方形状 `sess_<16 位小写十六进制>`；
 *    11. 同一会话稳定（续写 / 重试复用同一个 id），不同会话不同；
 *    12. 没有会话身份时退回进程级常量（CLI 语义），且同样是官方形状。
 *
 * 用法：node scripts/smoke-protocol.mjs
 */

import { buildRequest, eventToChunks, usageSummary } from '../lib/protocol.js'
import { cliSessionIdFor } from '../lib/adapter.js'

const failures = []
const check = (label, ok, extra) => {
  if (ok) console.log('  ok  ' + label)
  else { failures.push(label); console.log('  FAIL ' + label + (extra === undefined ? '' : ' → ' + extra)) }
}

const call = (id) => ({ type: 'tool-call', id, name: 'read_image', arguments: '{"path":"a.png"}' })
const result = (id, text = 'ok') => ({ type: 'tool-result', toolCallId: id, toolName: 'unknown', isError: false, content: [{ type: 'text', text }] })
const image = (attachmentId) => ({ type: 'image', attachment: { attachmentId, mediaType: 'image/png', bytes: 10, width: 2, height: 2 } })

const request = (messages, resolveImage, repair) => buildRequest(
  { provider: 'commandcode', model: 'deepseek-v4.1-flash', messages },
  resolveImage,
  repair,
)

/** 请求里的 assistant / tool 两侧 id。 */
function pairingOf(body) {
  const calls = []
  const results = []
  for (const message of body.params.messages) {
    if (message.role === 'assistant') {
      for (const part of message.content) if (part.type === 'tool-call') calls.push(part.toolCallId)
    } else if (message.role === 'tool') {
      for (const part of message.content) results.push(part.toolCallId)
    }
  }
  return { calls, results }
}

const rounds = (list) => list.join(',')

/* ---------- [A] 工具调用双射 ---------- */
console.log('[A] 工具调用双射（issue #5）')

const both = await request([
  { role: 'assistant', content: [call('call_01'), call('call_02')] },
  { role: 'user', content: [result('call_01'), result('call_02')] },
])
let p = pairingOf(both)
check('两个调用 + 两个结果都在', rounds(p.calls) === 'call_01,call_02' && rounds(p.results) === 'call_01,call_02', rounds(p.calls) + ' / ' + rounds(p.results))

const orphanCall = await request([
  { role: 'assistant', content: [call('call_01'), call('call_02')] },
  { role: 'user', content: [result('call_01')] },
])
p = pairingOf(orphanCall)
check('孤儿调用（call_02 无结果）被丢掉', rounds(p.calls) === 'call_01', rounds(p.calls))

const orphanResult = await request([
  { role: 'assistant', content: [call('call_01')] },
  { role: 'user', content: [result('call_01'), result('call_09')] },
])
p = pairingOf(orphanResult)
check('孤儿结果（call_09 无调用）被丢掉', rounds(p.results) === 'call_01', rounds(p.results))

const duplicated = await request([
  { role: 'assistant', content: [call('call_01'), call('call_01')] },
  { role: 'user', content: [result('call_01'), result('call_01')] },
])
p = pairingOf(duplicated)
check('同 id 重复调用只发一次', rounds(p.calls) === 'call_01', rounds(p.calls))
check('同 id 重复结果只发一次', rounds(p.results) === 'call_01', rounds(p.results))

const repaired = await request([
  { role: 'assistant', content: [call('call_01'), call('call_02')] },
  { role: 'user', content: [result('call_01'), result('call_02')] },
], undefined, { dropToolCallIds: new Set(['call_01']) })
p = pairingOf(repaired)
check('自愈点名 call_01：调用侧丢掉', rounds(p.calls) === 'call_02', rounds(p.calls))
check('自愈点名 call_01：结果侧同步丢掉', rounds(p.results) === 'call_02', rounds(p.results))

let resolvedImages = 0
const droppedImages = await request([
  { role: 'assistant', content: [call('call_01')] },
  { role: 'user', content: [{ ...result('call_09', ''), content: [image('att-dropped')] }] },
], async () => { resolvedImages += 1; return 'data:image/png;base64,AA==' })
const imageParts = droppedImages.params.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((part) => part.type === 'image')
check('被丢掉的结果里的图片不单独发出', imageParts.length === 0 && resolvedImages === 0, 'images=' + imageParts.length + ' resolved=' + resolvedImages)

/* ---------- [A2] 工具结果必须连续 ---------- */
console.log('[A2] 并行工具结果的连续性')

/**
 * 一个 assistant 步骤并行发起两个调用，两个结果里都嵌着图片（截图类工具）。
 *
 * 结果里嵌的图片会让序列化多吐一条 `user` 消息。它必须等**整段工具结果**发完再发：
 * 网关只在「tool-call 后面紧跟同 id 的 tool-result、中间不夹别的角色」时才认配对，
 * 夹一条 user 进去，后面的调用就被判 `Tool result is missing`，适配器只好把那个
 * 调用连同结果一起丢掉重发 —— 模型看到自己的调用凭空消失，经常就此不再调用工具，
 * 只吐一段推理然后 stop，turn 被记成 completed，界面像卡住（88 个 turn 里 8 个）。
 */
const parallelWithImages = await request([
  { role: 'assistant', content: [call('call_01'), call('call_02')] },
  { role: 'user', content: [{ ...result('call_01', ''), content: [image('att-1')] }] },
  { role: 'user', content: [{ ...result('call_02', ''), content: [image('att-2')] }] },
], async () => 'data:image/png;base64,AA==')
const roles = parallelWithImages.params.messages.map((m) => m.role)
const betweenTools = roles.slice(roles.indexOf('tool'), roles.lastIndexOf('tool') + 1).filter((r) => r !== 'tool')
check('并行工具结果之间不夹 user 消息', betweenTools.length === 0, roles.join(','))
check('两条图片占位都还在（只换顺序，不丢内容）', parallelWithImages.params.messages
  .flatMap((m) => Array.isArray(m.content) ? m.content : [])
  .filter((part) => part.type === 'image').length === 2)

/* ---------- [A3] harness 真实的工具结果形状 ---------- */
console.log('[A3] role=tool 消息形状（harness 真实形状）')

/**
 * `dsh-llm` 的 `ContentBlockMap` 里**没有** `tool-result` 这种块；harness 的工具结果
 * 是一条 `role: 'tool'` 的**消息**，`toolCallId` 在消息级，content 是普通块。
 *
 * 早先只认 `block.type === 'tool-result'`，于是 `resultIds` 恒为空 →
 * `serializeAssistant` 把每一个工具调用都当孤儿丢掉，工具输出也被拍平成普通 `user`
 * 正文。发出去的对话里模型**从来没有调用过工具**，于是每隔几步就「忘记」自己在干活，
 * 只吐一段推理或进度小结就收尾 —— 正是「干到一半停住、turn 记成 completed」。
 */
const realResult = (id, text = 'ok', isError = false) => ({
  role: 'tool',
  id: 'msg-' + id,
  source: { kind: 'tool', callId: id },
  toolCallId: id,
  isError,
  content: [{ type: 'text', text }],
})

const realWire = (await request([
  { role: 'assistant', content: [call('call_01')] },
  realResult('call_01', 'file contents'),
])).params.messages
const realCalls = realWire.filter((m) => m.role === 'assistant')
  .flatMap((m) => Array.isArray(m.content) ? m.content : [])
  .filter((part) => part.type === 'tool-call')
const realToolMessages = realWire.filter((m) => m.role === 'tool')
check('assistant 的工具调用没有被当成孤儿丢掉', realCalls.length === 1 && realCalls[0].toolCallId === 'call_01', 'calls=' + realCalls.length)
check('产出了一条 tool 消息', realToolMessages.length === 1 && realToolMessages[0].content[0].toolCallId === 'call_01', 'toolMessages=' + realToolMessages.length)
check('工具输出不再被重复拍平成 user 正文', !realWire.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('file contents')), JSON.stringify(realWire.map((m) => m.role)))
check('工具结果带上真实工具名', realToolMessages[0]?.content[0]?.toolName === 'read_image', String(realToolMessages[0]?.content[0]?.toolName))
check('工具结果紧跟 assistant，中间不夹别的角色', realWire.findIndex((m) => m.role === 'assistant') + 1 === realWire.findIndex((m) => m.role === 'tool'), JSON.stringify(realWire.map((m) => m.role)))

const errorOutput = (await request([
  { role: 'assistant', content: [call('call_01')] },
  realResult('call_01', 'boom', true),
])).params.messages.find((m) => m.role === 'tool')?.content[0]?.output
check('isError 映射成 error-text', errorOutput?.type === 'error-text' && errorOutput.value === 'boom', JSON.stringify(errorOutput))

const orphanWire = (await request([
  { role: 'assistant', content: [call('call_01')] },
  realResult('call_09', 'unpaired'),
])).params.messages
check('反向孤儿（有结果没调用）仍然丢掉', orphanWire.filter((m) => m.role === 'tool').length === 0)

/* ---------- [B] 流事件 → chunk ---------- */
console.log('[B] 流事件 → chunk')

const state = () => ({ blockIndex: 0 })
/** 块下标现在由 eventToChunks 自己分配（见 allocBlockIndex），调用方不再预推。 */
const push = (st, event) => eventToChunks(event, st)
const callDeltas = (chunks) => chunks.filter((chunk) => chunk.type === 'tool-call-delta')

let st = state()
const first = callDeltas(push(st, { type: 'tool-call', toolCallId: 'call_01', toolName: 'read_image', input: { path: 'a.png' } }))
const repeat = callDeltas(push(st, { type: 'tool-call', toolCallId: 'call_01', toolName: 'read_image', input: { path: 'a.png' } }))
check('首个调用发出', first.length === 1 && first[0].id === 'call_01')
check('完全相同的重复投递被丢掉（不执行两次工具）', repeat.length === 0)

st = state()
const differing = callDeltas(push(st, { type: 'tool-call', toolCallId: 'call_01', toolName: 'read_image', input: { path: 'a.png' } }))
const second = callDeltas(push(st, { type: 'tool-call', toolCallId: 'call_01', toolName: 'read_image', input: { path: 'b.png' } }))
check('同 id 不同载荷 → 加后缀区分', differing[0].id === 'call_01' && second[0].id === 'call_01-2', differing[0].id + ' / ' + second[0].id)

st = state()
const anonymous = callDeltas(push(st, { type: 'tool-call', toolName: 'read_image', input: {} }))
check('缺 id → 按块下标合成唯一 id', anonymous[0].id === 'call-1', String(anonymous[0].id))

/* ---------- [B2] tool-input-* 流（网关的真实形状） ---------- */
console.log('[B2] tool-input-* 流')

/**
 * harness `BlockAssembler` 的最小复刻：按 index 归块，块类型由**首次触碰**决定，
 * tool-call delta 的参数是纯字符串拼接。落进 text/reasoning 块的 tool-call delta
 * 会被静默丢掉——这正是「块下标必须专属」的原因。
 */
function toolCallsOf(chunks) {
  const partials = new Map()
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') {
      if (!partials.has(chunk.index)) partials.set(chunk.index, { blockType: chunk.blockType, args: '' })
      continue
    }
    if (chunk.type === 'tool-call-delta') {
      const partial = partials.get(chunk.index)
      if (partial === undefined || partial.blockType !== 'tool-call') continue
      partial.id = chunk.id
      if (chunk.name) partial.name = chunk.name
      partial.args += chunk.argumentsDelta
    }
  }
  return [...partials.values()]
    .filter((partial) => partial.blockType === 'tool-call')
    .map((partial) => ({ id: partial.id, name: partial.name, args: partial.args }))
}

const gatewayStream = (withTerminalCall) => {
  const events = [
    { type: 'start' },
    { type: 'reasoning-start', id: 'reasoning-0' },
    { type: 'reasoning-delta', id: 'reasoning-0', text: 'let me look' },
    { type: 'reasoning-end', id: 'reasoning-0' },
    { type: 'tool-input-start', id: 'call_07', toolName: 'read' },
    { type: 'tool-input-delta', id: 'call_07', delta: '{"file_path":' },
    { type: 'tool-input-delta', id: 'call_07', delta: '"a.txt"}' },
    { type: 'tool-input-end', id: 'call_07' },
  ]
  if (withTerminalCall) events.push({ type: 'tool-call', toolCallId: 'call_07', toolName: 'read', input: { file_path: 'a.txt' } })
  events.push({ type: 'finish-step', finishReason: 'tool-calls' })
  return events
}
const runStream = (events) => {
  const streamState = state()
  const chunks = []
  for (const event of events) chunks.push(...eventToChunks(event, streamState))
  return chunks
}

const normal = toolCallsOf(runStream(gatewayStream(true)))
check('汇总 tool-call 到达时只产出一个调用', normal.length === 1 && normal[0].id === 'call_07', JSON.stringify(normal))
check('参数不被拼接两遍', normal.length === 1 && normal[0].args === '{"file_path":"a.txt"}', normal[0] && normal[0].args)

const salvaged = toolCallsOf(runStream(gatewayStream(false)))
check('汇总 tool-call 缺席时仍从 tool-input-* 补出调用', salvaged.length === 1 && salvaged[0].id === 'call_07', JSON.stringify(salvaged))
check('补出的参数完整', salvaged.length === 1 && salvaged[0].args === '{"file_path":"a.txt"}', salvaged[0] && salvaged[0].args)

const splitIndices = runStream([
  { type: 'text-start', id: 'txt-0' },
  { type: 'text-delta', id: 'txt-0', text: 'running it' },
  { type: 'tool-input-start', id: 'call_08', toolName: 'read' },
  { type: 'tool-input-delta', id: 'call_08', delta: '{}' },
  { type: 'tool-input-end', id: 'call_08' },
  { type: 'text-delta', id: 'txt-0', text: ' now' },
  { type: 'tool-call', toolCallId: 'call_08', toolName: 'read', input: {} },
  { type: 'finish-step', finishReason: 'tool-calls' },
])
const textIdx = splitIndices.filter((c) => c.type === 'text-delta').map((c) => c.index)
const toolIdx = splitIndices.filter((c) => c.type === 'tool-call-delta').map((c) => c.index)
check('工具调用前后的文本都留在同一个 text 块', textIdx.length === 2 && textIdx[0] === textIdx[1], JSON.stringify(textIdx))
check('工具调用不占用 text 块的下标', toolIdx.every((index) => !textIdx.includes(index)), JSON.stringify({ textIdx, toolIdx }))

const withCache = usageSummary({ type: 'finish-step', usage: { inputTokens: 100, outputTokens: 20, inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 5 }, outputTokenDetails: { textTokens: 18, reasoningTokens: 2 } } })
check('usage 缓存读透传', withCache.cacheReadTokens === 60, String(withCache.cacheReadTokens))
check('usage 缓存写透传', withCache.cacheWriteTokens === 5, String(withCache.cacheWriteTokens))
check('usage 输入只算未命中部分', withCache.inputTokens === 40, String(withCache.inputTokens))
check('usage 推理 token 透传', withCache.reasoningTokens === 2, String(withCache.reasoningTokens))

const withoutCache = usageSummary({ type: 'finish', usage: { inputTokens: 7, outputTokens: 3 } })
check('网关没报缓存字段时不编 0', withoutCache.cacheReadTokens === undefined && withoutCache.cacheWriteTokens === undefined)

const usageChunks = eventToChunks({ type: 'finish', usage: { inputTokens: 100, outputTokens: 20, inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 60 } } }, state())
const usageChunk = usageChunks.find((chunk) => chunk.type === 'usage')
check('finish 事件仍产出 usage chunk', usageChunk !== undefined && usageChunk.usage.cacheReadTokens === 60)

/* ---------- [C] x-session-id ---------- */
console.log('[C] x-session-id（issue #6）')

const shape = /^sess_[0-9a-f]{16}$/
const cliShape = /^sess_[0-9a-f]{16}$/
const a = cliSessionIdFor('sess_abc123')
const b = cliSessionIdFor('sess_abc123')
const c = cliSessionIdFor('sess_other')
check('官方形状 sess_<16 hex>', shape.test(a), a)
check('同一会话稳定（续写/重试复用）', a === b)
check('不同会话不同 id', a !== c)
const fallback = cliSessionIdFor(undefined)
check('没有会话身份时退回进程级常量', cliShape.test(fallback) && fallback === cliSessionIdFor(''), fallback)
check('不再出现旧的 cli-<时间戳> 形状', !a.startsWith('cli-') && !fallback.startsWith('cli-'))

if (failures.length > 0) {
  console.error('\n协议测试失败 ' + failures.length + ' 项：\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log('\n协议测试全部通过。')
