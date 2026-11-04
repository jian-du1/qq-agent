/**
 * upstream.js —— 和 WorkBuddy 网关说话：发一次对话请求，把失败翻译成人能看懂的话。
 *
 * 分类顺序是上游 DSH 插件（dingminhua/dsh-connect-workbuddy v5.6.2）实测出来的，
 * 顺序不能换：排队响应可能搭 200/429/500 三种状态码，所以「先认队列、再按状态码归类」。
 *
 * 本模块只负责「发出去 + 出错了为什么」，不做重试、不做回退（那是调用方的策略）。
 */

const LIB_QUERY = new URL(import.meta.url).search;
const { chatHeaders } = await import(`./vault.js${LIB_QUERY}`);

/** 一次 WorkBuddy 调用失败的分类。 */
export class UpstreamError extends Error {
  /**
   * @param {string} kind hard_credit | session_dead | policy_reject | channel_reject |
   *   model_busy | model_queue | soft_rate | not_found | server | client | network | bad_response
   * @param {object} info
   */
  constructor(kind, info = {}) {
    super(info.message ?? kind);
    this.name = 'UpstreamError';
    this.kind = kind;
    /** 建议回给 QQ Agent 的 HTTP 状态码（QQ Agent 会把 body 一起显示在报错里）。 */
    this.status = info.status ?? 502;
    this.upstreamCode = info.code ?? null;
    this.resetAt = info.resetAt ?? null;
    this.queue = info.queue ?? null;
    this.rawText = info.rawText ?? '';
    /** 该失败是否值得「换个方式再试一次」（渠道校验/网络抖动/排队）。 */
    this.retriable = info.retriable === true;
  }
}

const KIND_STATUS = {
  hard_credit: 402,
  soft_rate: 429,
  model_busy: 429,
  model_queue: 429,
  session_dead: 401,
  policy_reject: 403,
  channel_reject: 400,
  not_found: 502,
  server: 502,
  client: 400,
  network: 502,
  bad_response: 502,
};

const KIND_TEXT = {
  hard_credit: 'WorkBuddy 额度/积分已用完',
  soft_rate: 'WorkBuddy 触发频率限制',
  model_busy: 'WorkBuddy 该模型当前繁忙（不是账号问题）',
  model_queue: 'WorkBuddy 正在排队',
  session_dead: 'WorkBuddy 登录已失效',
  policy_reject: 'WorkBuddy 服务端策略拒绝了这次请求',
  channel_reject: 'WorkBuddy 网关的渠道校验拦截了这次请求（11128，不是账号/额度/网络问题）',
  not_found: 'WorkBuddy 上没有这个模型（可能当前账号没开通）',
  server: 'WorkBuddy 上游异常',
  client: 'WorkBuddy 拒绝了请求参数',
  network: '连不上 WorkBuddy',
  bad_response: 'WorkBuddy 返回了无法解析的响应',
};

/** 把上游一坨错误 JSON 压成一句可读的话。 */
function describeBody(text) {
  const raw = String(text ?? '').trim();
  if (raw === '') return '上游没有返回内容';
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    data = null;
  }
  if (data && typeof data === 'object') {
    const pieces = [];
    for (const key of ['msg', 'message', 'displayTips', 'displayMsg', 'error']) {
      const value = data[key];
      if (typeof value === 'string' && value.trim() !== '') pieces.push(value.trim());
      else if (value && typeof value === 'object') {
        const nested = value.message ?? value.msg;
        if (typeof nested === 'string' && nested.trim() !== '') pieces.push(nested.trim());
      }
    }
    if (pieces.length) return [...new Set(pieces)].join('；').slice(0, 400);
  }
  return raw.replace(/\s+/g, ' ').slice(0, 400);
}

/** 从上流错误体里抠业务码（`"code":6020`；避免误匹配 requestId 里的数字）。 */
function businessCode(text) {
  const match = String(text ?? '').match(/"code"\s*:\s*(\d{3,6})/);
  return match ? Number(match[1]) : null;
}

/** 解析排队响应：{"code":6020,"data":{"queue_position":N,"queue_size":M}}。 */
function parseQueue(text, code) {
  if (code === 6020 || code === 6021 || code === 6022) {
    let data = null;
    try {
      data = JSON.parse(String(text)).data ?? null;
    } catch {
      data = null;
    }
    return {
      code,
      position: Number(data?.queue_position) || null,
      size: Number(data?.queue_size) || null,
      // 6020 排队中 / 6021 队列满 / 6022 个人同时请求数超限
      text:
        code === 6020
          ? `前面还有 ${Number(data?.queue_position) || '若干'} 个请求在排队`
          : code === 6021
            ? '排队队列已满'
            : '你的同时请求数超过了 WorkBuddy 的上限',
    };
  }
  const lower = String(text ?? '').toLowerCase();
  if (/queue_position|queue_size|排队/.test(lower) && /429|500|503/.test(lower) === false) {
    return { code, position: null, size: null, text: '请求在排队' };
  }
  return null;
}

/** 从 429 的正文里取「几点重置」，容错几种写法。 */
function parseResetAt(text) {
  const match = String(text ?? '').match(
    /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC\s*([+-])(\d{1,2})/,
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s, sign, offsetHours] = match;
  const signFactor = sign === '-' ? -1 : 1;
  const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return base - signFactor * Number(offsetHours) * 60 * 60 * 1000;
}

/**
 * 给一次失败下结论。
 *
 * @param {number} status HTTP 状态码
 * @param {string} text 响应正文
 * @param {object} [extra] { hasHttpResponse?: boolean }
 * @returns {UpstreamError}
 */
export function classifyFailure(status, text, extra = {}) {
  const code = businessCode(text);
  const body = String(text ?? '');
  const lower = body.toLowerCase();
  const detail = describeBody(body);
  const resetAt = parseResetAt(body);
  const fail = (kind, message, opts = {}) =>
    new UpstreamError(kind, {
      status: KIND_STATUS[kind] ?? 502,
      code,
      resetAt,
      message,
      rawText: body.slice(0, 2000),
      ...opts,
    });

  if (extra.hasHttpResponse === false) {
    return fail('network', `${KIND_TEXT.network}：${extra.message ?? '网络请求失败'}`);
  }
  // 1) 队列必须最先认（队列响应可能搭 200/429/500）
  const queue = parseQueue(body, code);
  if (queue) {
    return fail('model_queue', `${KIND_TEXT.model_queue}：${queue.text}${code ? `（业务码 ${code}）` : ''}`, {
      queue,
      retriable: true,
    });
  }
  // 2) 额度
  if (status === 402 || code === 14018 || /积分|额度|credit|quota/i.test(detail) && status !== 429 && status !== 500) {
    return fail('hard_credit', `${KIND_TEXT.hard_credit}：${detail}`);
  }
  // 3) 登录/会话
  if (code === 12153 || lower.includes('offline user session') || (status === 401 && !/openresty|apisix|authorization required/.test(lower))) {
    return fail('session_dead', `${KIND_TEXT.session_dead}：${detail}。打开 WorkBuddy 客户端重新登录一次即可恢复。`);
  }
  // 4) 策略拒绝
  if (code === 11140 || lower.includes('request illegal')) {
    return fail('policy_reject', `${KIND_TEXT.policy_reject}：${detail}`);
  }
  // 5) 渠道校验（11128 家族）
  if (code === 11128 || lower.includes('unapproved channel') || lower.includes('渠道校验')) {
    return fail('channel_reject', `${KIND_TEXT.channel_reject}：${detail}`, { retriable: true });
  }
  // 6) 模型繁忙
  if (code === 14003) return fail('model_busy', `${KIND_TEXT.model_busy}：${detail}`, { retriable: true });
  // 7) 频率限制
  if (status === 429 || code === 6004) {
    const when = resetAt ? `，将在 ${new Date(resetAt).toLocaleString('zh-CN', { hour12: false })} 重置` : '';
    return fail('soft_rate', `${KIND_TEXT.soft_rate}${when}：${detail}`);
  }
  // 8) 模型不存在
  if (status === 404) return fail('not_found', `${KIND_TEXT.not_found}：${detail}`);
  // 9) 服务端 / 客户端
  if (status >= 500) return fail('server', `${KIND_TEXT.server}（HTTP ${status}）：${detail}`, { retriable: true });
  if (status >= 400) return fail('client', `${KIND_TEXT.client}（HTTP ${status}）：${detail}`);
  if (code !== null) return fail('client', `${KIND_TEXT.client}（业务码 ${code}）：${detail}`);
  return fail('bad_response', `${KIND_TEXT.bad_response}：${detail}`);
}

/**
 * 真正发一次对话请求，返回 fetch 的 Response（body 是 SSE 流）。
 * 注意：上游只有流式，这里永远发 stream:true。
 *
 * @param {object} options
 * @param {object} options.region REGIONS 里的一项
 * @param {string} options.token
 * @param {string} [options.accountId]
 * @param {object} options.body 已经过 wire.prepareBody 改写的请求体
 * @param {number} [options.timeoutMs] 首字节超时（上游 chatStream 自身没有超时，必须自己加）
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Response>}
 */
export async function openChatStream({ region, token, accountId, body, timeoutMs = 180000, signal }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  try {
    const response = await fetch(`${region.chatBase}/v2/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(region, token, { accountId }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    throw new UpstreamError('network', {
      status: KIND_STATUS.network,
      message: aborted
        ? `${KIND_TEXT.network}：请求超时（${Math.round(timeoutMs / 1000)} 秒内没有响应）`
        : `${KIND_TEXT.network}：${error?.cause?.message ?? error?.message ?? error}`,
      rawText: '',
      hasHttpResponse: false,
    });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 读一小段正文用于判错（不改动流本身：失败时 body 都很小）。
 */
export async function readFailureBody(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export { KIND_TEXT };
