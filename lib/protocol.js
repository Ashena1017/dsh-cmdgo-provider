/**
 * Command Code Go wire protocol: translate between the harness LLM vocabulary
 * and Command Code's private `/alpha/generate` gateway.
 *
 * The Go plan is the only Command Code plan without Provider-API access, so
 * the standard OpenAI-compatible endpoints answer 403 `upgrade_required` for
 * a Go subscription. The CLI gateway at `POST /alpha/generate` is the
 * transport every Go-plan request must use. This module serializes the
 * gateway request body and parses its line-delimited JSON stream back into
 * harness `StreamChunk`s.
 *
 * The request envelope shape mirrors the `cmd` CLI (`command-code` npm
 * package) and the opencode commandcode-go provider plugin:
 * - `config.environment` is a plain string (`<os>-<arch>`), not an object.
 * - Gateway compatibility rides on the `x-command-code-version` header.
 *
 * @module commandcode-go/protocol
 */
import { platform, arch } from 'node:os';
/**
 * Gateway version pinned to a known-good Command Code CLI release. The gateway
 * checks the `x-command-code-version` header against the `User-Agent` version,
 * so both must track the same CLI release (here: the CLI installed in this
 * environment, v1.31.0 — request/response envelope verified unchanged).
 */
export const CC_VERSION = '1.31.0';
/** Last-resort output cap when a request carries no maxTokens (matches the adapter default). */
export const DEFAULT_MAX_TOKENS = 64_000;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** The flattened text of a message's content blocks. */
function flattenText(blocks) {
    return blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
}
function toolResultOutput(result) {
    const value = flattenText(result.content);
    return result.isError
        ? { type: 'error-text', value: value || 'Execution denied' }
        : { type: 'text', value: value || '(no output)' };
}
/**
 * 序列化一条 assistant 消息。
 *
 * `pairing` 是双射视图（见 {@link ToolPairing}）：**没有对应结果的工具调用必须丢掉**，
 * 同一个调用 id 只发一次，自愈点名过的 id 也丢掉。
 * 网关对「有 tool-call 却没有对应 tool 结果」是硬错误——实测返回
 * `{"type":"error","error":{"type":"server_error","message":"Tool result is missing for tool call …"}}`
 * 且不带 finish-step。长时间会话被压缩、或工具执行被中断时，历史里很容易出现这种
 * 孤儿调用；丢掉它比让整轮失败好。
 */
function serializeAssistant(message, pairing) {
    const parts = [];
    for (const block of message.content) {
        if (block.type === 'text') {
            parts.push({ type: 'text', text: block.text });
        }
        else if (block.type === 'reasoning') {
            parts.push({ type: 'reasoning', text: block.text });
        }
        else if (block.type === 'tool-call') {
            if (pairing !== undefined) {
                if (pairing.dropIds.has(block.id))
                    continue;
                if (!pairing.resultIds.has(block.id))
                    continue;
                if (pairing.emittedCalls.has(block.id))
                    continue;
                pairing.emittedCalls.add(block.id);
            }
            parts.push({
                type: 'tool-call',
                toolCallId: block.id,
                toolName: block.name,
                input: safeParseJson(block.arguments),
            });
        }
    }
    // 整条消息只剩被丢掉的孤儿工具调用时，空 assistant 消息同样会被网关拒绝。
    if (parts.length === 0)
        return undefined;
    return { role: 'assistant', content: parts };
}
/**
 * 遍历一条 harness 消息携带的工具结果。
 *
 * **harness 的真实形状是「一条 `role: 'tool'` 的消息 = 一个工具结果」**：
 * ```js
 * { role: 'tool', toolCallId, isError, content: [ {type:'text', …} ] }
 * ```
 * `toolCallId` 在**消息级**，content 是普通块 —— `dsh-llm` 的 `ContentBlockMap`
 * 里压根没有 `tool-result` 这种块（只有 text / reasoning / image / file /
 * tool-call / tool-addition / tool-removal）。
 *
 * 早先这里只认 `block.type === 'tool-result'`，于是：
 * - `resultIds` 恒为空 → `serializeAssistant` 把**每一个**工具调用都判成孤儿丢掉；
 * - 工具结果里也找不到 `tool-result` 块 → 不产出 `tool` 消息，输出文本被拍平成普通
 *   `user` 消息。
 * 结果发出去的对话里，模型**从来没有调用过工具**，工具输出全变成用户说的话。模型因此
 * 每隔几步就「忘记」自己在干活，只吐一段推理或进度小结就收尾 —— 这就是「干到一半停住、
 * turn 被记成 completed」。旧形状（content 里嵌 `tool-result` 块）继续兼容。
 */
function walkToolResults(message, visit) {
    if (message.role === 'tool') {
        const callId = message.toolCallId;
        if (typeof callId === 'string' && callId.length > 0) {
            visit({
                toolCallId: callId,
                content: Array.isArray(message.content) ? message.content : [],
                isError: message.isError === true,
            });
            return;
        }
    }
    const walk = (blocks) => {
        for (const block of blocks) {
            if (block.type === 'tool-result') {
                const legacy = block;
                const content = Array.isArray(legacy.content) ? legacy.content : [];
                visit({ toolCallId: legacy.toolCallId, content, isError: legacy.isError === true });
                walk(content);
            }
        }
    };
    if (Array.isArray(message.content))
        walk(message.content);
}
/** 收集全部工具结果的 toolCallId（含嵌在 tool-result 内容里的）。 */
function collectToolResultIds(messages) {
    const ids = new Set();
    for (const message of messages)
        walkToolResults(message, result => { ids.add(result.toolCallId); });
    return ids;
}
/** 收集全部工具调用 id（assistant 消息里声明的）。 */
function collectToolCallIds(messages) {
    const ids = new Set();
    const walk = (blocks) => {
        for (const block of blocks) {
            if (block.type === 'tool-call')
                ids.add(block.id);
            else if (block.type === 'tool-result') {
                const content = block.content;
                if (Array.isArray(content))
                    walk(content);
            }
        }
    };
    for (const message of messages) {
        if (Array.isArray(message.content))
            walk(message.content);
    }
    return ids;
}
/** assistant 声明过的工具调用 id → 工具名（工具结果要带上它对应的名字）。 */
function collectToolCallNames(messages) {
    const names = new Map();
    const walk = (blocks) => {
        for (const block of blocks) {
            if (block.type === 'tool-call')
                names.set(block.id, block.name);
            else if (block.type === 'tool-result') {
                const content = block.content;
                if (Array.isArray(content))
                    walk(content);
            }
        }
    };
    for (const message of messages) {
        if (Array.isArray(message.content))
            walk(message.content);
    }
    return names;
}
const NO_IDS = new Set();
/** 建立一条消息列表的双射视图。 */
function pairingFor(messages, dropIds) {
    return {
        resultIds: collectToolResultIds(messages),
        callIds: collectToolCallIds(messages),
        callNames: collectToolCallNames(messages),
        dropIds: dropIds ?? NO_IDS,
        emittedCalls: new Set(),
        emittedResults: new Set(),
    };
}
function safeParseJson(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
/**
 * Collect every image block in a message, descending into tool-result content
 * exactly like the harness's own `contentHasImage` does — but only for tool
 * results that survive serialization (`kept`), so an image never rides into the
 * request without the result that carried it.
 */
function collectImages(blocks, kept) {
    const found = [];
    for (const block of blocks) {
        if (block.type === 'image')
            found.push(block);
        else if (block.type === 'tool-result' && (kept === undefined || kept.has(block))) {
            found.push(...collectImages(block.content, kept));
        }
    }
    return found;
}
/**
 * 只取消息**顶层**的图片块，不深入工具结果。
 *
 * 工具结果里的图片跟着那个结果走（见 serializeUser 的 keptImages）：结果被丢掉时
 * 图片也必须一起丢，否则会凭空多出一条只含图片的 `user` 消息。
 */
function topLevelImages(blocks) {
    const found = [];
    for (const block of blocks) {
        if (block.type === 'image')
            found.push(block);
    }
    return found;
}
/** Placeholder used when an image is present but cannot be read. */
function omittedImageText(block) {
    return `[image omitted: attachment ${String(block.attachment.attachmentId).slice(0, 23)} could not be read]`;
}
/** Turn harness image blocks into gateway parts (or explicit placeholders). */
async function imageParts(blocks, resolveImage) {
    const parts = [];
    for (const block of blocks) {
        let dataUrl;
        if (resolveImage !== undefined) {
            try {
                dataUrl = await resolveImage(block);
            }
            catch (_imageResolutionFailure) {
                // 降级本身不该把整轮请求带走。失败原因由解析器自己记录
                // （见 index.ts 的 resolveImage）—— 这里静默，是为了不向纯序列化层
                // 引入 logger 依赖，不是为了掩盖问题。
                dataUrl = undefined;
            }
        }
        parts.push(dataUrl === undefined
            ? { type: 'text', text: omittedImageText(block) }
            : { type: 'image', image: dataUrl });
    }
    return parts;
}
async function serializeUser(message, resolveImage, pairing) {
    const isToolMessage = message.role === 'tool';
    const kept = [];
    const keptImages = [];
    walkToolResults(message, (result) => {
        if (pairing !== undefined) {
            if (pairing.dropIds.has(result.toolCallId))
                return;
            if (!pairing.callIds.has(result.toolCallId))
                return;
            if (pairing.emittedResults.has(result.toolCallId))
                return;
            pairing.emittedResults.add(result.toolCallId);
        }
        kept.push(result);
        // 结果里嵌的图片跟着**这个结果**走，不能因为结果被丢掉而单独发出去。
        keptImages.push(...collectImages(result.content));
    });
    const out = {};
    if (kept.length > 0) {
        out.tool = {
            role: 'tool',
            content: kept.map(result => ({
                type: 'tool-result',
                toolCallId: result.toolCallId,
                toolName: pairing?.callNames.get(result.toolCallId) ?? 'unknown',
                output: toolResultOutput(result),
            })),
        };
    }
    // `role: 'tool'` 的消息，content **就是结果本身的载荷**，已经被上面收进工具结果里了；
    // 再按顶层正文捞一遍会把它当成用户说的话重复发一次（旧实现就是这么漏的）。
    const text = isToolMessage ? '' : flattenText(message.content);
    // 顶层图片 + **保留下来的**工具结果里的图片。被丢掉的结果里的图片不进这个列表。
    const images = await imageParts([
        ...(isToolMessage ? [] : topLevelImages(message.content)),
        ...keptImages,
    ], resolveImage);
    if (text.length > 0 || images.length > 0) {
        const parts = [
            ...(text.length > 0 ? [{ type: 'text', text }] : []),
            ...images,
        ];
        const single = parts.length === 1 ? parts[0] : undefined;
        out.follow = {
            role: 'user',
            content: single !== undefined && single.type === 'text' ? single.text : parts,
        };
    }
    // 空消息也要占位，否则整轮会塌陷。
    if (out.tool === undefined && out.follow === undefined)
        out.follow = { role: 'user', content: '' };
    return out;
}
/**
 * Build the gateway request envelope for one harness call.
 *
 * @param options - harness call options.
 * @param resolveImage - optional resolver turning harness image attachments
 * into gateway data URLs. Without it images degrade to an explicit placeholder
 * instead of being dropped.
 * @param repair - optional self-heal instruction (see {@link RequestRepair}).
 */
export async function buildRequest(options, resolveImage, repair) {
    let system = options.system ?? '';
    const messages = [];
    // 先建立工具调用/结果的双射视图：孤儿调用、孤儿结果、重复 id 都在这里被丢掉
    // （见 ToolPairing 与 issue #5）。
    const pairing = pairingFor(options.messages, repair?.dropToolCallIds);
    // 工具结果里嵌的图片/文本会顺带生成一条 `user` 消息（见 serializeUser）。它必须
    // 等**整段工具结果**都发完再发：网关只在「assistant 的 tool-call 后面紧跟同 id 的
    // tool-result、中间不夹别的角色」时才认配对。夹一条 user 进去，后面那些调用就会
    // 被判成
    //   {"type":"error","error":{"type":"server_error",
    //    "message":"Tool result is missing for tool call …"}}
    // 适配器只好自愈：把那个调用**连同它的结果**一起丢掉再重发。模型于是看到自己上一轮
    // 的工具调用凭空消失，经常就此不再调用工具、只吐一段推理然后 stop —— harness 收到
    // 的 assistant 消息里既没有 text 也没有 tool-call，turn 就被记成 completed，界面像
    // 卡住了（实测 88 个 turn 里 8 个）。这里把顺序修正到发出前，从根上不触发那次自愈。
    const deferred = [];
    const flushDeferred = () => {
        if (deferred.length > 0)
            messages.push(...deferred.splice(0, deferred.length));
    };
    for (const message of options.messages) {
        if (message.role === 'system') {
            system += (system ? '\n\n' : '') + flattenText(message.content);
            continue;
        }
        if (message.role === 'assistant') {
            flushDeferred();
            const serialized = serializeAssistant(message, pairing);
            if (serialized !== undefined)
                messages.push(serialized);
            continue;
        }
        const { tool, follow } = await serializeUser(message, resolveImage, pairing);
        if (tool !== undefined) {
            messages.push(tool);
            if (follow !== undefined)
                deferred.push(follow);
        }
        else {
            flushDeferred();
            if (follow !== undefined)
                messages.push(follow);
        }
    }
    flushDeferred();
    const tools = (options.tools ?? [])
        .map((tool) => ({
        type: 'function',
        name: tool.name,
        ...tool.description === undefined ? {} : { description: tool.description },
        input_schema: tool.parameters,
    }));
    const params = {
        model: options.model,
        messages,
        tools,
        system,
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        stream: true,
    };
    if (options.temperature !== undefined)
        params.temperature = options.temperature;
    if (options.reasoningEffort !== undefined && options.reasoningEffort !== 'off') {
        params.reasoning_effort = options.reasoningEffort;
    }
    return {
        config: {
            workingDir: process.cwd(),
            date: new Date().toISOString().split('T')[0],
            environment: `${platform()}-${arch()}`,
            structure: [],
            isGitRepo: false,
            currentBranch: '',
            mainBranch: '',
            gitStatus: '',
            recentCommits: [],
        },
        memory: '',
        taste: '',
        skills: null,
        permissionMode: 'standard',
        params,
    };
}
/**
 * 为一条 `tool-call` 事件定一个**流内唯一**的 id。
 *
 * 网关不保证 id 存在，更不保证唯一，而 harness 的组装器是**按 block index**
 * 组装的（`dsh-llm` 的 BlockAssembler）：同一个 id 出现两次就会长出两个同 id 的
 * 调用块、两个同 id 的结果，网关随后判
 * `Tool result is missing for tool call …`（issue #5 的现场）。所以：
 *
 * - 缺 id → 按 block index 合成（与 harness 自己的 `call-<index>` 兜底同形）；
 * - 同 id 且载荷完全相同 → 判定为网关重复投递，返回 undefined（调用方丢弃该事件），
 *   这样不会让工具被执行两次；
 * - 同 id 但载荷不同 → 追加 `-2`/`-3` 后缀区分，保住这次真实调用。
 */
function resolveToolCallId(state, declared, fingerprint) {
    const seen = state.toolCallIds ?? (state.toolCallIds = new Map());
    const base = declared.length > 0 ? declared : `call-${state.blockIndex}`;
    let candidate = base;
    for (let suffix = 2;; suffix++) {
        const known = seen.get(candidate);
        if (known === undefined) {
            seen.set(candidate, fingerprint);
            return candidate;
        }
        if (known === fingerprint)
            return undefined;
        candidate = `${base}-${suffix}`;
    }
}
/**
 * 从 finish / usage 事件里取用量摘要。
 *
 * 字段解读沿用旧的 eventToChunks 逻辑：`inputTokens` 是**未命中缓存**的输入
 * （网关的 `noCacheTokens`，缺失时才用总量减缓存读）；缓存读/写按网关实际报的
 * 字段透传，缺失就省略（不编 0）。
 */
export function usageSummary(event) {
    const usage = isRecord(event.usage)
        ? event.usage
        : isRecord(event.totalUsage) ? event.totalUsage : undefined;
    if (usage === undefined)
        return undefined;
    const inputDetails = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined;
    const outputDetails = isRecord(usage.outputTokenDetails) ? usage.outputTokenDetails : undefined;
    const cacheRead = inputDetails?.cacheReadTokens;
    const cacheWrite = inputDetails?.cacheWriteTokens
        ?? inputDetails?.cacheCreationTokens
        ?? inputDetails?.cacheCreationInputTokens;
    const totalInput = usage.inputTokens;
    const noCache = inputDetails?.noCacheTokens;
    const inputTokens = noCache ?? (totalInput !== undefined && cacheRead !== undefined
        ? Math.max(0, totalInput - cacheRead)
        : totalInput) ?? 0;
    return {
        inputTokens,
        outputTokens: usage.outputTokens ?? outputDetails?.textTokens ?? 0,
        ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
        ...cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {},
        ...outputDetails?.reasoningTokens !== undefined ? { reasoningTokens: outputDetails.reasoningTokens } : {},
    };
}
/**
 * Extract the human message from a gateway stream error part.
 *
 * The gateway does NOT use the AI SDK's plain `errorText` shape here — the
 * observed form is `{"type":"error","error":{"type":"server_error","message":"…"}}`.
 * Both, plus a bare `message`, are handled so the real cause is never lost.
 *
 * @returns the message, or undefined when the part carries none.
 */
export function streamErrorText(event) {
    const direct = event.errorText ?? event.message;
    if (typeof direct === 'string' && direct.length > 0)
        return direct;
    const nested = event.error;
    if (typeof nested === 'string' && nested.length > 0)
        return nested;
    if (isRecord(nested)) {
        for (const key of ['message', 'errorText', 'detail']) {
            const value = nested[key];
            if (typeof value === 'string' && value.length > 0)
                return value;
        }
        // 再嵌一层（如 {error:{error:{message}}}）。
        const deeper = nested.error;
        if (isRecord(deeper) && typeof deeper.message === 'string' && deeper.message.length > 0) {
            return deeper.message;
        }
    }
    return undefined;
}
/**
 * Map a gateway stream error part to a stable harness failure code.
 *
 * Request-shape faults ("Tool result is missing", invalid parameters) must NOT
 * be classified as failover-worthy: retrying them on another account only
 * burns quota on a request that can never succeed.
 */
export function streamErrorCode(event, message) {
    const text = message.toLowerCase();
    if (/tool result is missing|invalid|malformed|unsupported|required|must be|too (long|large)/.test(text)) {
        return 'INVALID_REQUEST';
    }
    if (/rate ?limit|quota|too many requests|usage limit|exceeded/.test(text))
        return 'RATE_LIMIT';
    if (/unauthor|forbidden|invalid api key|expired/.test(text))
        return 'AUTH';
    if (/context|token limit|too many tokens/.test(text))
        return 'CONTEXT_WINDOW_EXCEEDED';
    if (/overload|unavailable|internal|server error|timeout|upstream/.test(text))
        return 'SERVER';
    const kind = isRecord(event.error) && typeof event.error.type === 'string' ? event.error.type.toLowerCase() : '';
    if (kind.includes('server'))
        return 'SERVER';
    if (kind.includes('auth'))
        return 'AUTH';
    return 'SERVER';
}
/** 网关事件里的工具调用 id（`tool-call` 用 toolCallId，`tool-input-*` 用 id）。 */
function eventToolId(event) {
    if (typeof event.toolCallId === 'string' && event.toolCallId.length > 0)
        return event.toolCallId;
    return typeof event.id === 'string' ? event.id : '';
}
/** 这条 `tool-input-*` 事件属于哪次调用（没登记过就是 undefined）。 */
function toolInputSlot(state, event) {
    if (state.toolInputs === undefined)
        return undefined;
    const declared = eventToolId(event);
    return declared.length > 0 ? state.toolInputs.get(declared) : undefined;
}
/** 文本是否是一段完整 JSON（兜底补发参数前的最后一道闸）。 */
function isCompleteJson(text) {
    try {
        JSON.parse(text);
        return true;
    }
    catch {
        return false;
    }
}
/** 每个内容流各占一个**专属**块下标：delta 永远落回自己那一块。 */
function allocBlockIndex(state) {
    state.blockIndex += 1;
    return state.blockIndex;
}
/**
 * Translate one gateway stream event into one or more harness StreamChunks.
 * @returns an empty array when the event has no harness representation.
 */
export function eventToChunks(event, state) {
    const chunks = [];
    switch (event.type) {
        case 'text-start': {
            state.textIndex = allocBlockIndex(state);
            chunks.push({ type: 'block-start', index: state.textIndex, blockType: 'text' });
            break;
        }
        case 'text-delta': {
            const text = typeof event.text === 'string' ? event.text : '';
            if (text.length === 0)
                break;
            // 没有 text-start 也要自己开一块：以前直接用共享的 blockIndex，一旦中间夹过
            // 工具调用，这段文本会落进 tool-call 块里被组装器**静默丢掉**。
            if (state.textIndex === undefined) {
                state.textIndex = allocBlockIndex(state);
                chunks.push({ type: 'block-start', index: state.textIndex, blockType: 'text' });
            }
            chunks.push({ type: 'text-delta', index: state.textIndex, text });
            break;
        }
        case 'reasoning-start': {
            state.reasoningIndex = allocBlockIndex(state);
            chunks.push({ type: 'block-start', index: state.reasoningIndex, blockType: 'reasoning' });
            break;
        }
        case 'reasoning-delta': {
            const text = typeof event.text === 'string' ? event.text : '';
            if (text.length === 0)
                break;
            if (state.reasoningIndex === undefined) {
                state.reasoningIndex = allocBlockIndex(state);
                chunks.push({ type: 'block-start', index: state.reasoningIndex, blockType: 'reasoning' });
            }
            chunks.push({ type: 'reasoning-delta', index: state.reasoningIndex, text });
            break;
        }
        // 网关把每次工具调用先以 tool-input-start → tool-input-delta* → tool-input-end
        // 流式吐出来，最后再补一条**汇总**的 tool-call。以前只认那条汇总事件，于是汇总
        // 事件一旦缺席，参数已经完整收到的调用会凭空消失。现在在 start 就占住块，顺便
        // 保证它绝不会和 text/reasoning 抢同一个下标。
        case 'tool-input-start': {
            const declared = eventToolId(event);
            const name = typeof event.toolName === 'string' ? event.toolName : '';
            const index = allocBlockIndex(state);
            const id = declared.length > 0 ? declared : `call-${index}`;
            const inputs = state.toolInputs ?? (state.toolInputs = new Map());
            inputs.set(declared.length > 0 ? declared : id, { index, id, name, buffered: '', delivered: false });
            chunks.push({ type: 'block-start', index, blockType: 'tool-call' });
            chunks.push({
                type: 'tool-call-delta',
                index,
                id: id,
                ...name.length > 0 ? { name } : {},
                argumentsDelta: '',
            });
            state.toolCallsEmitted = (state.toolCallsEmitted ?? 0) + 1;
            break;
        }
        case 'tool-input-delta': {
            const slot = toolInputSlot(state, event);
            if (slot === undefined)
                break;
            slot.buffered += typeof event.delta === 'string' ? event.delta
                : typeof event.inputTextDelta === 'string' ? event.inputTextDelta : '';
            break;
        }
        // 参数先攒着不发：汇总的 tool-call 才是权威值，只有它缺席时才在终态补发。
        case 'tool-input-end': {
            break;
        }
        case 'tool-call': {
            const input = event.input ?? event.args ?? event.arguments;
            const declared = eventToolId(event);
            const name = typeof event.toolName === 'string' ? event.toolName : '';
            const argumentsDelta = JSON.stringify(input ?? {});
            // 这次调用已经由 tool-input-start 占好块：只补参数，绝不再开第二个块——同一个
            // 调用长出两块，网关随后就判「缺结果」。
            const slot = declared.length > 0 ? state.toolInputs?.get(declared) : undefined;
            if (slot !== undefined) {
                if (!slot.delivered) {
                    const slotName = slot.name.length > 0 ? slot.name : name;
                    chunks.push({
                        type: 'tool-call-delta',
                        index: slot.index,
                        id: slot.id,
                        ...slotName.length > 0 ? { name: slotName } : {},
                        argumentsDelta,
                    });
                    slot.delivered = true;
                    state.toolCallsEmitted = (state.toolCallsEmitted ?? 0) + 1;
                }
                break;
            }
            const index = allocBlockIndex(state);
            // 先占下标再定 id：缺 id 时的兜底 `call-<块下标>` 才和 tool-input-start 那条
            // 路径同形。重复投递会白占一个下标，但下标只求唯一，留空洞无妨。
            const id = resolveToolCallId(state, declared, `${name}\u0000${argumentsDelta}`);
            // undefined = 同一个调用的重复投递，丢掉（见 resolveToolCallId）。
            if (id === undefined)
                break;
            chunks.push({ type: 'block-start', index, blockType: 'tool-call' });
            chunks.push({
                type: 'tool-call-delta',
                index,
                id: id,
                ...name.length > 0 ? { name } : {},
                argumentsDelta,
            });
            state.toolCallsEmitted = (state.toolCallsEmitted ?? 0) + 1;
            break;
        }
        // finish-step 是每个 step 的终态；finish 是整条流的终态。正常情况两者都到，
        // 但网关在某些路由/错误路径下只发 finish，因此两者都当终态处理，且只认第一个
        // ——否则一条完整的回答会因为缺 finish-step 被判成截断而整轮失败。
        case 'finish-step':
        case 'finish': {
            if (state.finished === true)
                break;
            state.finished = true;
            // 兜底：走了 tool-input-* 却始终没等到汇总的 tool-call 时，用攒下的参数把这次
            // 调用补出来。宁可让工具拿到一份非法参数（模型会看到 INVALID_ARGS 并自我纠正），
            // 也不要让这次调用凭空消失——那正是「turn 记成 completed、界面像卡住」的成因。
            if (state.toolInputs !== undefined) {
                for (const slot of state.toolInputs.values()) {
                    if (slot.delivered || slot.buffered.length === 0 || !isCompleteJson(slot.buffered))
                        continue;
                    chunks.push({
                        type: 'tool-call-delta',
                        index: slot.index,
                        id: slot.id,
                        ...slot.name.length > 0 ? { name: slot.name } : {},
                        argumentsDelta: slot.buffered,
                    });
                    slot.delivered = true;
                }
            }
            state.toolCallsEmitted = (state.toolCallsEmitted ?? 0) + chunks.filter(chunk => chunk.type === 'tool-call-delta').length;
            const usage = usageSummary(event);
            if (usage !== undefined)
                chunks.push({ type: 'usage', usage });
            const reason = event.finishReason ?? event.rawFinishReason ?? 'stop';
            const mapped = mapFinishReason(reason);
            // 记下终态语义，供适配器判断「自称有工具调用却一个都没给」的自相矛盾流。
            state.finishKind = mapped.kind;
            state.rawFinishReason = typeof reason === 'string' ? reason : undefined;
            chunks.push({ type: 'finish', reason: mapped });
            break;
        }
        // error / abort 由适配器转成 LlmError（要带上真实原因），这里不产出 chunk。
        case 'error':
        case 'abort': {
            break;
        }
    }
    return chunks;
}
/** Map the gateway finish-reason vocabulary to the harness FinishReason. */
function mapFinishReason(raw) {
    const reason = typeof raw === 'string' ? raw : 'stop';
    switch (reason) {
        case 'stop':
        case 'end_turn':
            return { kind: 'stop' };
        case 'tool_calls':
        case 'tool-calls':
            return { kind: 'tool-calls' };
        case 'length':
        case 'max_tokens':
        case 'max-output-tokens':
            return { kind: 'max-tokens' };
        default:
            return {
                kind: 'error',
                failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() },
            };
    }
}
function parseEventLine(line) {
    if (line.length === 0 || line.startsWith(':'))
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    return isRecord(parsed) && typeof parsed.type === 'string' ? parsed : undefined;
}
/**
 * Parse a line-delimited JSON byte stream from `/alpha/generate` into events.
 * Lines are bare JSON objects (the gateway sends no `data:` SSE prefix).
 */
export async function* parseEventStream(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            buffer += done ? '' : decoder.decode(value, { stream: !done });
            let newline;
            while ((newline = buffer.indexOf('\n')) !== -1) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                const event = parseEventLine(line);
                if (event !== undefined)
                    yield event;
            }
            if (done) {
                const tail = buffer.trim();
                const event = parseEventLine(tail);
                if (event !== undefined)
                    yield event;
                return;
            }
        }
    }
    finally {
        reader.releaseLock();
    }
}
/** Extract the human message from a gateway error body, when present. */
export function gatewayErrorMessage(body) {
    try {
        const parsed = JSON.parse(body);
        if (isRecord(parsed) && isRecord(parsed.error)) {
            const message = parsed.error.message;
            if (typeof message === 'string' && message.length > 0)
                return message;
        }
    }
    catch {
        // Not JSON; caller falls back to the HTTP status.
    }
    return undefined;
}
