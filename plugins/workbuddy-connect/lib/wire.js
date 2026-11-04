/**
 * wire.js —— 请求/响应在「QQ Agent 的形状」和「WorkBuddy 网关的形状」之间互相翻译。
 *
 * 两边的差异全部来自实测（见 README「上游协议备忘」）：
 *   · WorkBuddy 只接受 stream:true，收到 stream:false 直接 400；
 *   · 它的 tool_choice 只认字符串（auto / required / 工具名），OpenAI 的对象形式会 400；
 *   · 它拒收 developer 角色，也拒收「开头不是 system」的消息列表；
 *   · 它会用业务码 11128 拦掉「不像官方客户端发出来的」提示词（特征是消息开头）；
 *   · 它返回的是 SSE，而 QQ Agent 只吃一次性 JSON（stream:false 的响应体）。
 *
 * 本模块只做纯函数，不碰网络、不读配置，方便直接测。
 */

/** 躲渠道校验时垫在最前面的中性开头（实测 200）。 */
export const NEUTRAL_HEAD = 'You are a helpful assistant.\n\n';

/** 网关 11128 渠道校验认得的开头（小写比较）。移植自上游的指纹表。 */
const CHANNEL_FINGERPRINTS = [
  'you are an ai agent powered by deepseek harness',
  "you are claude code, anthropic's official cli for claude",
];

/** 上游请求体的白名单：其它字段（thinking / reasoning_effort / extra 等）一律不转发。 */
const PASSTHROUGH_KEYS = [
  'model',
  'messages',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'max_tokens',
  'stop',
];

/** 取一段文本的第一个非空行（渠道校验读的就是它）。 */
function firstNonEmptyLine(text) {
  for (const line of String(text).split('\n')) {
    if (line.trim() !== '') return line.trim();
  }
  return '';
}

/** 一条消息里所有可被渠道校验读到的文本片段。 */
function textPartsOf(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (part && typeof part === 'object' && typeof part.type === 'string' && part.type === 'text') {
      if (typeof part.text === 'string') out.push(part.text);
    }
  }
  return out;
}

/** 在每条被扫描的消息的每个文本片段前面垫中性开头（就地修改）。 */
function neutralizeOpenings(messages) {
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role ?? '').toLowerCase();
    if (role !== 'system' && role !== 'assistant' && role !== 'developer') continue;
    if (typeof message.content === 'string') {
      message.content = NEUTRAL_HEAD + message.content;
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text' && typeof part.text === 'string') part.text = NEUTRAL_HEAD + part.text;
    }
  }
}

/** 把 developer 改写成 system（上游不认 developer）。 */
function normalizeRoles(messages) {
  for (const message of messages) {
    if (message && typeof message === 'object' && message.role === 'developer') message.role = 'system';
  }
}

/** 保证列表以 system 开头；上游要求首条是 system 才按「客户端」放行。 */
function ensureSystemHead(obj) {
  const messages = obj.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;
  const head = messages[0];
  if (head && typeof head === 'object' && String(head.role ?? '').toLowerCase() === 'system') return;
  messages.unshift({ role: 'system', content: 'You are a helpful assistant.' });
}

/** 把 OpenAI 的 tool_choice 各种写法压成上游要的字符串。 */
function normalizeToolChoice(obj) {
  const dropTools = () => {
    delete obj.tools;
    delete obj.functions;
  };
  if (!('tool_choice' in obj)) return;
  const choice = obj.tool_choice;
  if (typeof choice === 'string') {
    if (choice.trim().toLowerCase() === 'none') {
      delete obj.tool_choice;
      dropTools();
    }
    return;
  }
  if (choice && typeof choice === 'object' && !Array.isArray(choice)) {
    const type = typeof choice.type === 'string' ? choice.type.trim().toLowerCase() : '';
    if (type === 'none') {
      delete obj.tool_choice;
      dropTools();
    } else if (type === 'auto' || type === 'required') {
      obj.tool_choice = type;
    } else if (type === 'function') {
      const name = String(choice.function?.name ?? choice.name ?? '').trim();
      obj.tool_choice = name || 'auto';
    } else {
      delete obj.tool_choice;
    }
    return;
  }
  delete obj.tool_choice;
}

/** 只留上游认识的字段；stream 恒为 true（上游不收 stream:false）。 */
function whitelist(obj) {
  const out = {};
  for (const key of PASSTHROUGH_KEYS) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  if (Array.isArray(out.tools) && out.tools.length === 0) delete out.tools;
  out.stream = true;
  return out;
}

/**
 * 把 QQ Agent 的一段请求体 JSON 改成能发给 WorkBuddy 的形状。
 *
 * @param {string} rawJson 原始请求体（非 JSON 时原样返回给调用方处理）
 * @param {{forceNeutral?: boolean}} [options] forceNeutral=true 时刻意给所有开头垫中性头（11128 后的一次性自救）
 * @returns {{ok: true, body: object} | {ok: false, reason: string}}
 */
export function prepareBody(rawJson, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { ok: false, reason: '请求体不是合法 JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: '请求体不是 JSON 对象' };
  }
  if (!Array.isArray(parsed.messages) || parsed.messages.length === 0) {
    return { ok: false, reason: '请求体缺少 messages' };
  }
  normalizeRoles(parsed.messages);
  ensureSystemHead(parsed);
  if (options.forceNeutral) neutralizeOpenings(parsed.messages);
  normalizeToolChoice(parsed);
  return { ok: true, body: whitelist(parsed) };
}

/** 判断一段上游失败响应是否属于渠道校验（11128 家族）。 */
export function isChannelReject(status, text) {
  const body = String(text ?? '');
  if (body.includes('"code":11128') || body.includes('"code": 11128')) return true;
  const lower = body.toLowerCase();
  return lower.includes('unapproved channel') || lower.includes('渠道校验');
}
