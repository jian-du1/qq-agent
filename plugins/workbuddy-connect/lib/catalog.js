/**
 * catalog.js —— WorkBuddy 的模型目录。
 *
 * 上游 `GET /v3/config` 返回账号能用哪些模型、各模型的上下文/额度倍率/是否支持工具调用。
 * 这既用于把设置里填错的模型名纠正成真实存在的 id，也用于插件设置页/状态工具展示。
 *
 * 要点（实测 + 上游 DSH 插件源码）：
 *   · 目录接口要用 **App 身份**（`WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0`），
 *     和聊天用的 CLI 身份不同 —— 同一 token 换 UA 就能多看到一批模型；
 *   · 丢弃 disabled、maxInputTokens/maxOutputTokens 非正数的条目，并剔除
 *     `auto` / `default-model` 这类路由别名（它们不是真模型）；
 *   · `data.agents` 里 name==='cli' 的那份列表才是**聊天通道**认的模型，
 *     目录里有但不在其中的模型，聊天时可能 404。
 */

const LIB_QUERY = new URL(import.meta.url).search;
const { REGIONS } = await import(`./vault.js${LIB_QUERY}`);

const PRODUCT_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0';

/** 目录缓存的有效期：10 分钟。目录变化不频繁，但换模型/开会员后要能较快看到。 */
const CATALOG_TTL_MS = 10 * 60 * 1000;

const ROUTER_IDS = new Set(['auto', 'default-model']);

function catalogHeaders(region, token) {
  const headers = {
    accept: 'application/json, text/plain, */*',
    'x-requested-with': 'XMLHttpRequest',
    'user-agent': PRODUCT_UA,
    authorization: `Bearer ${token}`,
  };
  if (region.id === 'global') {
    headers['x-product'] = 'SaaS';
    headers.connection = 'close';
  } else {
    // 国内版目录接口带 Origin/Referer，不带 X-Product（实测如此）
    headers.origin = region.origin;
    headers.referer = `${region.origin}/`;
  }
  return headers;
}

function normalizeModel(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  if (id === '' || ROUTER_IDS.has(id)) return null;
  if (raw.disabled === true) return null;
  const maxInputTokens = Number(raw.maxInputTokens) || 0;
  const maxOutputTokens = Number(raw.maxOutputTokens) || 0;
  if (maxInputTokens <= 0 || maxOutputTokens <= 0) return null;
  return {
    id,
    name: String(raw.name ?? id),
    description: String(raw.descriptionZh ?? raw.descriptionEn ?? ''),
    credits: typeof raw.credits === 'string' ? raw.credits : '',
    maxInputTokens,
    maxOutputTokens,
    supportsImages: raw.supportsImages === true,
    supportsToolCall: raw.supportsToolCall === true,
    onlyReasoning: raw.onlyReasoning === true,
    reasoning: raw.reasoning ?? null,
  };
}

/**
 * 模型目录缓存（按区域）。
 */
export class Catalog {
  /**
   * @param {{log?: (msg: string) => void, ttlMs?: number}} [options]
   */
  constructor({ log = () => {}, ttlMs = CATALOG_TTL_MS } = {}) {
    this.log = log;
    this.ttlMs = ttlMs;
    /** regionId → {models, cliIds:Set, fetchedAt} */
    this.cache = new Map();
    /** regionId → 正在进行的请求，避免并发拉重复 */
    this.inflight = new Map();
  }

  /** 缓存里是否已有该区域目录。 */
  has(regionId) {
    return this.cache.has(regionId);
  }

  /** 同步取缓存（没有就返回 null）。端点在 provider 里是同步调用的，需要它。 */
  peek(regionId) {
    return this.cache.get(regionId) ?? null;
  }

  /**
   * 取某区域的目录（有缓存用缓存）。
   * @param {{id: string, chatBase: string, origin: string}} region
   * @param {string} token
   */
  async get(region, token) {
    const cached = this.cache.get(region.id);
    if (cached && Date.now() - cached.fetchedAt < this.ttlMs) return cached;
    const pending = this.inflight.get(region.id);
    if (pending) return pending;
    const task = this.#fetch(region, token).finally(() => this.inflight.delete(region.id));
    this.inflight.set(region.id, task);
    return task;
  }

  async #fetch(region, token) {
    const url = `${region.chatBase}/v3/config`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(url, { headers: catalogHeaders(region, token), signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!response.ok || !data || Number(data.code) !== 0) {
      // 国内版有降级接口：/v2/enterprises/personal/models
      if (region.id === 'cn' && response.ok !== false) {
        const fallback = await this.#fetchPersonalModels(region, token);
        if (fallback) return fallback;
      }
      throw new Error(
        `拉取 WorkBuddy 模型目录失败（HTTP ${response.status}${data?.code !== undefined ? `，业务码 ${data.code}` : ''}）：${String(data?.msg ?? text ?? '').slice(0, 160) || '空响应'}`,
      );
    }
    return this.#ingest(region, data.data ?? {});
  }

  async #fetchPersonalModels(region, token) {
    try {
      const response = await fetch(`${region.chatBase}/v2/enterprises/personal/models`, {
        headers: catalogHeaders(region, token),
      });
      const data = await response.json();
      if (!response.ok || Number(data?.code) !== 0) return null;
      return this.#ingest(region, data.data ?? {});
    } catch {
      return null;
    }
  }

  #ingest(region, payload) {
    const models = [];
    const seen = new Set();
    for (const raw of Array.isArray(payload.models) ? payload.models : []) {
      const model = normalizeModel(raw);
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      models.push(model);
    }
    // data.agents 里 name==='cli' 的模型顺序 = 聊天通道认可的列表
    const cliIds = new Set();
    for (const agent of Array.isArray(payload.agents) ? payload.agents : []) {
      if (String(agent?.name ?? '').toLowerCase() !== 'cli') continue;
      for (const entry of Array.isArray(agent.models) ? agent.models : []) {
        const id = typeof entry === 'string' ? entry : String(entry?.id ?? entry?.name ?? '');
        if (id) cliIds.add(id);
      }
      break;
    }
    const entry = { models, cliIds, fetchedAt: Date.now(), region: region.id };
    this.cache.set(region.id, entry);
    this.log(`已加载 ${region.label} 模型目录：${models.length} 个模型${cliIds.size ? `（聊天通道 ${cliIds.size} 个）` : ''}`);
    return entry;
  }

  /**
   * 把设置里写的模型名解析成真实可用的 id。
   * 规则：目录里有就原样用；没有就退回 preferred；再没有就挑第一个支持工具调用的。
   *
   * @param {string} regionId
   * @param {string} wanted 设置里的首选模型
   * @param {string} [fallbackDefault]
   * @returns {{id: string, corrected: boolean, reason?: string}}
   */
  resolve(regionId, wanted, fallbackDefault = 'deepseek-v4.1-flash') {
    const cached = this.cache.get(regionId);
    const target = String(wanted ?? '').trim();
    if (!cached) {
      // 目录还没拿到：先信设置（第一次请求时异步补目录，下一次就会纠正）
      return { id: target || fallbackDefault, corrected: false };
    }
    const ids = new Set(cached.models.map((model) => model.id));
    if (target && ids.has(target)) return { id: target, corrected: false };
    if (ids.has(fallbackDefault)) {
      return {
        id: fallbackDefault,
        corrected: true,
        reason: target ? `模型「${target}」不在当前账号的可用列表里，已改用 ${fallbackDefault}` : `未指定模型，使用默认 ${fallbackDefault}`,
      };
    }
    const firstToolModel = cached.models.find((model) => model.supportsToolCall) ?? cached.models[0];
    return {
      id: firstToolModel?.id ?? fallbackDefault,
      corrected: true,
      reason: `模型「${target || fallbackDefault}」不可用，已改用账号可用模型 ${firstToolModel?.id ?? fallbackDefault}`,
    };
  }

  /** 给 /v1/models 与状态工具用的精简清单。 */
  list(regionId) {
    const cached = this.cache.get(regionId);
    if (!cached) return [];
    return cached.models.map((model) => ({
      id: model.id,
      name: model.name,
      credits: model.credits,
      context: model.maxInputTokens,
      tools: model.supportsToolCall,
      images: model.supportsImages,
      chat: cached.cliIds.size === 0 || cached.cliIds.has(model.id),
    }));
  }
}

/** 供外部构造「目录没拿到时的保底清单」。 */
export const FALLBACK_MODELS = [
  { id: 'deepseek-v4.1-flash', label: 'Deepseek-V4.1-Flash（默认，便宜、支持工具）' },
  { id: 'deepseek-v4-pro', label: 'Deepseek-V4-Pro（更强、更贵）' },
  { id: 'glm-5.3', label: 'GLM-5.3' },
  { id: 'kimi-k3-1', label: 'Kimi-K3-1' },
  { id: 'minimax-m3', label: 'MiniMax-M3' },
];

export { REGIONS };
