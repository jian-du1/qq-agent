/**
 * sse.js —— 把 WorkBuddy 的 SSE 流拼回 QQ Agent 要的一次性 JSON。
 *
 * QQ Agent 的 src/llm.js 用 `stream:false` 发请求，然后直接 `JSON.parse(响应体)`，
 * 再从 `data.choices[0].message` 拿内容、`finish_reason` 判不判工具调用。
 * WorkBuddy 上游只肯返回 SSE（`data: {...}\n\n` … `data: [DONE]`），所以必须在这里
 * 把每个增量帧合并成一条完整消息。
 *
 * 实测帧形状（2026-10-23，deepseek-v4.1-flash）：
 *   {"id","model","object":"chat.completion.chunk","created",
 *    "choices":[{"index":0,"delta":{"role","content","reasoning_content",
 *      "tool_calls":[{"index":0,"id"?,"type"?,"function":{"name","arguments"}}]},"finish_reason":""}],
 *    "usage":null}
 * 末帧带 usage 与 finish_reason:"tool_calls"，随后 `data: [DONE]`。
 * 工具名和 id 只在第一帧出现，arguments 之后按字符串碎片补齐，靠 index 归并。
 */

/** 上游流里夹带的错误帧（排队/限流/渠道校验等）：有 code 没有 choices。 */
export class UpstreamFrameError extends Error {
  constructor(frame) {
    const code = Number(frame?.code) || 0;
    const msg = String(frame?.msg ?? frame?.message ?? '上游返回了错误帧');
    super(msg);
    this.name = 'UpstreamFrameError';
    this.code = code;
    this.frame = frame;
  }
}

function normalizeFinishReason(reason, hasCalls) {
  const text = String(reason ?? '').trim();
  if (text === '' || text === 'null' || text === 'undefined') return hasCalls ? 'tool_calls' : 'stop';
  if (text === 'tool_calls' || text === 'function_call') return 'tool_calls';
  return text;
}

/**
 * 读完 SSE 流，返回合并后的消息片段。
 *
 * @param {ReadableStream<Uint8Array>|AsyncIterable<Uint8Array>} stream
 * @returns {Promise<{id: string, model: string, created: number, content: string,
 *   reasoning: string, finishReason: string, usage: object|null,
 *   toolCalls: Array<{id: string, type: string, function: {name: string, arguments: string}}>}>}
 */
export async function readSse(stream) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let id = '';
  let model = '';
  let created = 0;
  let content = '';
  let reasoning = '';
  let finishReason = '';
  let usage = null;
  /** index → {id, name, args} */
  const calls = new Map();

  const handle = (line) => {
    const text = line.replace(/\r$/, '');
    if (!text.startsWith('data:')) return false;
    const payload = text.slice(5).trim();
    if (payload === '') return false;
    if (payload === '[DONE]') return true;
    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      return false; // 半截帧/心跳，忽略
    }
    if (!frame || typeof frame !== 'object') return false;
    if (frame.id) id = String(frame.id);
    if (frame.model) model = String(frame.model);
    if (frame.created) created = Number(frame.created) || created;
    if (frame.usage && typeof frame.usage === 'object') usage = frame.usage;
    if (!Array.isArray(frame.choices) || frame.choices.length === 0) {
      if (frame.code !== undefined || frame.msg !== undefined) throw new UpstreamFrameError(frame);
      return false;
    }
    for (const choice of frame.choices) {
      const delta = choice?.delta ?? {};
      if (typeof delta.content === 'string') content += delta.content;
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (choice?.finish_reason) finishReason = String(choice.finish_reason);
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index = Number.isInteger(call?.index) ? call.index : 0;
          const slot = calls.get(index) ?? { id: '', name: '', args: '' };
          if (call.id) slot.id = String(call.id);
          const fn = call.function ?? call;
          if (fn?.name) slot.name = String(fn.name);
          if (typeof fn?.arguments === 'string') slot.args += fn.arguments;
          calls.set(index, slot);
        }
      }
    }
    return false;
  };

  const iterator = stream[Symbol.asyncIterator]();
  let done = false;
  while (!done) {
    const next = await iterator.next();
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (handle(line)) {
        done = true;
        break;
      }
    }
  }
  if (!done && buffer.trim() !== '') handle(buffer);

  const toolCalls = [...calls.keys()]
    .sort((a, b) => a - b)
    .map((index) => calls.get(index))
    .filter((call) => call.name !== '')
    .map((call, order) => ({
      id: call.id || `call_wb_${Date.now().toString(36)}_${order}`,
      type: 'function',
      function: { name: call.name, arguments: call.args || '{}' },
    }));

  return {
    id: id || `chatcmpl_wb_${Date.now().toString(36)}`,
    model,
    created: created || Math.floor(Date.now() / 1000),
    content,
    reasoning,
    finishReason: normalizeFinishReason(finishReason, toolCalls.length > 0),
    usage,
    toolCalls,
  };
}

/** usage 里的缓存命中字段归一成 QQ Agent 认识的形状（保留上游原字段不删）。 */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const cached =
    Number(usage.prompt_cache_hit_tokens) ||
    Number(usage.cached_tokens) ||
    Number(usage.prompt_tokens_details?.cached_tokens) ||
    0;
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
  };
  const reasoningTokens = Number(usage.completion_tokens_details?.reasoning_tokens) || 0;
  if (reasoningTokens) out.completion_tokens_details = { reasoning_tokens: reasoningTokens };
  return out;
}

// ─────────────────────────── DSML 兜底恢复 ───────────────────────────

/** 全角竖线 ｜ 的十六进制，DSML 标记里两种竖线、单双竖线都出现过。 */
const BARS = '(?:\\uFF5C|\\|){1,2}';
const MARK = `<${BARS}DSML${BARS}`;
const CLOSE = `</${BARS}DSML${BARS}`;

const INVOKE_RE = new RegExp(`${MARK}\\s*invoke\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)${CLOSE}\\s*invoke\\s*>`, 'g');
const PARAM_RE = new RegExp(`${MARK}\\s*parameter\\s+name="([^"]+)"[^>]*>([\\s\\S]*?)${CLOSE}\\s*parameter\\s*>`, 'g');
const LOOSE_MARK_RE = new RegExp(`${MARK}[^>]{0,40}>`, 'g');

/**
 * 模型偶尔会把工具调用写成文本标记（DSML）而不是真正的 tool_calls。
 * 这里只认最标准的形态，且只在**本次请求声明过这个工具**时恢复，避免误判。
 *
 * @param {string} content 合并后的文本
 * @param {Iterable<string>} allowedNames 本次请求 tools 里出现的工具名
 * @returns {{content: string, toolCalls: Array<object>}}
 */
export function recoverToolsFromMarkup(content, allowedNames) {
  const text = String(content ?? '');
  const allowed = new Set(allowedNames ?? []);
  const recovered = [];
  let matched = false;
  const withoutBlocks = text.replace(INVOKE_RE, (_all, name, inner) => {
    if (!allowed.has(name)) return _all;
    const args = {};
    for (const match of inner.matchAll(PARAM_RE)) {
      args[match[1]] = match[2].trim();
    }
    matched = true;
    recovered.push({
      id: `call_dsml_${recovered.length}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });
    return '';
  });
  if (!matched) {
    // 有标记但没有完整块：至少别把标记漏给用户看。
    LOOSE_MARK_RE.lastIndex = 0;
    if (LOOSE_MARK_RE.test(text)) {
      return { content: text.replace(LOOSE_MARK_RE, '').trim(), toolCalls: [] };
    }
    return { content: text, toolCalls: [] };
  }
  return { content: withoutBlocks.replace(/\n{3,}/g, '\n\n').trim(), toolCalls: recovered };
}

/** 从请求体里取本次声明的工具名，供 DSML 恢复做白名单。 */
export function toolNamesOf(body) {
  if (!Array.isArray(body?.tools)) return [];
  return body.tools
    .map((tool) => tool?.function?.name ?? tool?.name)
    .filter((name) => typeof name === 'string' && name !== '');
}
