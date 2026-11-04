/**
 * shim.js —— 本机中转服务：QQ Agent ⇄ WorkBuddy 的协议适配层。
 *
 * QQ Agent 的模型调用只认「一次性 JSON（stream:false 的响应体）」，而 WorkBuddy
 * 只有 SSE 流。所以插件在 127.0.0.1 起一个小 HTTP 服务：QQ Agent 把请求发给它，
 * 它按 WorkBuddy 的规矩改写请求体、带齐对话三连头、读 SSE 拼回一条完整消息。
 *
 * 路由（QQ Agent 只用到前两个）：
 *   GET  /healthz                     状态（排障用，不暴露密钥）
 *   GET  /v1/models                   模型清单（OpenAI 形状）
 *   POST /v1/chat/completions         主路径
 *
 * 设计约束：
 *   · 只监听 127.0.0.1 —— 这相当于把本机的 WorkBuddy 额度借给本机进程用，
 *     绝不能监听 0.0.0.0（那等于把额度暴露到局域网）。
 *   · 不做自动无限重试：队列/限流重试有上限，且失败后按设置回退官方 API。
 *   · 错误一律翻译成中文短句塞进 `error.message`，QQ Agent 会把这句话显示给用户。
 */

import http from 'node:http';

// 同级模块用「带着自己 URL 查询串」的动态 import：插件热重载时入口会带 ?t=…，
// 这样日志里真能换上新代码；写成静态 import 会被 Node 的 ESM 缓存永久钉在首次加载的版本。
const LIB_QUERY = new URL(import.meta.url).search;
const { prepareBody } = await import(`./wire.js${LIB_QUERY}`);
const { UpstreamFrameError, normalizeUsage, readSse, recoverToolsFromMarkup, toolNamesOf } = await import(
  `./sse.js${LIB_QUERY}`
);
const { UpstreamError, classifyFailure, openChatStream } = await import(`./upstream.js${LIB_QUERY}`);
const { REGIONS } = await import(`./vault.js${LIB_QUERY}`);

const REQUEST_BODY_LIMIT = 32 * 1024 * 1024; // 带图片的历史可能很大
const HEADER_TIMEOUT_MS = 60_000;            // 等上游响应头（含连接）的超时
const QUEUE_RETRY_DELAY_MS = 4_000;

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function errorPayload(message, kind, code) {
  return { error: { message, type: kind, code: code ?? null } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * 给流加「空闲超时」：上游 chatStream 自身没有超时，模型卡住时会把请求挂死。
 * 每收到一块数据就重置计时；超时就 abort 掉 fetch 并抛错。
 */
async function* idleGuard(stream, idleMs, onIdle) {
  const iterator = stream[Symbol.asyncIterator]();
  for (;;) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        onIdle();
        reject(
          new UpstreamError('network', {
            status: 502,
            message: `WorkBuddy 长时间没有返回新内容（超过 ${Math.round(idleMs / 1000)} 秒），已断开这次请求。`,
            hasHttpResponse: false,
          }),
        );
      }, idleMs);
    });
    let result;
    try {
      result = await Promise.race([iterator.next(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (result.done) return;
    yield result.value;
  }
}

/**
 * 一次请求的完整处理流程。
 */
export class WorkBuddyShim {
  /**
   * @param {object} options
   * @param {import('./vault.js').CredentialStore} options.credentials
   * @param {import('./catalog.js').Catalog} options.catalog
   * @param {() => object} options.getSettings 现读插件设置
   * @param {(msg: string) => void} [options.log]
   * @param {(msg: string) => void} [options.warn]
   * @param {() => ({baseUrl?: string, apiKey?: string})} [options.nativeTarget] 回退目标（QQ Agent 自己的 API 配置）
   */
  constructor({ credentials, catalog, getSettings, log = () => {}, warn = () => {}, nativeTarget }) {
    this.credentials = credentials;
    this.catalog = catalog;
    this.getSettings = getSettings;
    this.log = log;
    this.warn = warn;
    this.nativeTarget = nativeTarget;
    this.server = null;
    this.port = 0;
    this.startedAt = Date.now();
    this.stats = {
      requests: 0,
      ok: 0,
      failed: 0,
      fallbacks: 0,
      failovers: 0,
      retries: 0,
      lastLatencyMs: 0,
      lastErrorAt: 0,
      lastError: '',
      lastModel: '',
      lastRegion: '',
    };
    /** 目录/凭据初始化中，避免重复拉 */
    this.priming = null;
  }

  /** 启动 HTTP 服务；端口被占用时顺延最多 8 个。 */
  async start(preferredPort) {
    if (this.server?.listening) return this.port;
    const bind = (port) =>
      new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
          this.#handle(req, res).catch((error) => {
            this.warn(`处理请求时出现未捕获异常：${error?.message ?? error}`);
            try {
              if (!res.headersSent) jsonResponse(res, 500, errorPayload(`插件内部错误：${error?.message ?? error}`, 'internal'));
              else res.end();
            } catch {
              /* 连接可能已断开 */
            }
          });
        });
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve(server);
        });
      });

    // 尝试顺序：首选端口多试几次（热重载时旧中转可能正在 close，等一下端口就释放了），
    // 仍占不到再顺延到后续端口。以前是"占不到立刻换下一个端口"，一次重扫风暴就能把
    // 8 个端口全耗光，最后启动失败 → 静默不接管。
    const attempts = [];
    for (let i = 0; i < 6; i += 1) attempts.push({ port: Number(preferredPort), delay: 200 });
    for (let offset = 1; offset <= 7; offset += 1) attempts.push({ port: Number(preferredPort) + offset, delay: 150 });
    let lastError = null;
    for (const attempt of attempts) {
      try {
        this.server = await bind(attempt.port);
        this.port = attempt.port;
        this.server.on('error', (error) => this.warn(`中转服务出错：${error?.message ?? error}`));
        if (attempt.port !== Number(preferredPort)) this.log(`端口 ${preferredPort} 被占用，中转服务改用 ${attempt.port}`);
        return attempt.port;
      } catch (error) {
        lastError = error;
        if (error?.code !== 'EADDRINUSE') break;
        await new Promise((resolve) => setTimeout(resolve, attempt.delay));
      }
    }
    throw new Error(`中转服务启动失败：${lastError?.message ?? '未知错误'}`);
  }

  async stop() {
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (!server) return;
    await new Promise((resolve) => {
      server.close(() => resolve());
      // QQ Agent 的 fetch 会保持 keep-alive 连接，不主动断开的话 close() 要等连接超时，
      // 端口就一直占着 —— 热重载时正是这个窗口让新实例绑不上端口。
      try { server.closeAllConnections?.(); } catch { /* ignore */ }
      try { server.closeIdleConnections?.(); } catch { /* ignore */ }
    });
  }

  /** baseUrl 交给 QQ Agent 的格式：它会自己拼 /chat/completions。 */
  get baseUrl() {
    return `http://127.0.0.1:${this.port}/v1`;
  }

  get running() {
    return Boolean(this.server?.listening);
  }

  status() {
    const settings = this.getSettings();
    return {
      running: this.running,
      port: this.port,
      baseUrl: this.running ? this.baseUrl : null,
      region: settings.region,
      model: settings.model,
      takeover: settings.takeover,
      stats: { ...this.stats, since: this.startedAt },
      accounts: this.credentials.describe(),
    };
  }

  // ───────────────────────────── 路由 ─────────────────────────────

  async #handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && path === '/healthz') {
      return jsonResponse(res, 200, this.status());
    }
    if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
      return this.#handleModels(res);
    }
    if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
      return this.#handleChat(req, res);
    }
    return jsonResponse(res, 404, errorPayload(`未知路径：${req.method} ${path}`, 'not_found'));
  }

  async #handleModels(res) {
    try {
      const settings = this.getSettings();
      const { regionId, token } = await this.#primaryRoute(settings);
      const catalog = await this.catalog.get(REGIONS[regionId], token);
      const data = this.catalog.list(regionId).map((model) => ({
        id: model.id,
        object: 'model',
        created: 0,
        owned_by: `workbuddy-${regionId}`,
        name: model.name,
        chat: model.chat,
      }));
      if (!data.length) throw new Error('目录为空');
      return jsonResponse(res, 200, { object: 'list', data });
    } catch (error) {
      // 目录拿不到也不能让 QQ Agent 的模型下拉框空着：至少给出设置里那个模型
      const settings = this.getSettings();
      return jsonResponse(res, 200, {
        object: 'list',
        data: [{ id: settings.model, object: 'model', created: 0, owned_by: 'workbuddy' }],
      });
    }
  }

  /**
   * 选区域（按尝试顺序返回）：设置里指定就只按指定来；auto 时优先国内版，
   * 若开着「双区域兜底」且另一个区域也有账号，就把它排在后面当备用。
   */
  #regionCandidates(settings) {
    const available = new Set(this.credentials.availableRegions());
    const wanted = String(settings.region ?? 'auto').toLowerCase();
    if (wanted === 'cn' || wanted === 'global') {
      if (available.has(wanted)) return [wanted];
      throw new UpstreamError('session_dead', {
        status: 401,
        message: `设置里指定了${REGIONS[wanted].label}，但本机没有找到该区域的 WorkBuddy 登录凭据。打开对应版本的 WorkBuddy 客户端登录一次，或把「用哪个 WorkBuddy 版本」改成 auto。`,
      });
    }
    const preferred = available.has('cn') ? 'cn' : available.has('global') ? 'global' : null;
    if (!preferred) {
      throw new UpstreamError('session_dead', {
        status: 401,
        message: '没有找到本机的 WorkBuddy 登录凭据（~/.dsh/workbuddy-vault 下没有可用账号）。先用 WorkBuddy 客户端登录一次即可。',
      });
    }
    if (settings.regionFallback === false) return [preferred];
    const others = ['cn', 'global'].filter((id) => id !== preferred && available.has(id));
    return [preferred, ...others];
  }

  /** 哪类失败值得换另一个区域的账号重试（同一个请求体换区才有意义）。 */
  #canFailover(kind) {
    return (
      kind === 'session_dead' ||
      kind === 'hard_credit' ||
      kind === 'soft_rate' ||
      kind === 'model_busy' ||
      kind === 'server'
    );
  }

  /** 取主区域并拿到它的有效 token（目录、状态这类单次查询用）。 */
  async #primaryRoute(settings) {
    const [regionId] = this.#regionCandidates(settings);
    const { token } = await this.credentials.ensureToken(regionId);
    return { regionId, token };
  }

  /** 主路径：改写请求体 → 调上游 → 聚合 SSE → 一次性 JSON 返回。 */
  async #handleChat(req, res) {
    const startedAt = Date.now();
    const settings = this.getSettings();
    this.stats.requests += 1;
    let rawBody;
    try {
      rawBody = await readBody(req);
    } catch (error) {
      this.stats.failed += 1;
      return jsonResponse(res, 413, errorPayload(`读取请求体失败：${error?.message ?? error}`, 'client'));
    }
    const prepared = prepareBody(rawBody);
    if (!prepared.ok) {
      this.stats.failed += 1;
      return jsonResponse(res, 400, errorPayload(`请求体不合法：${prepared.reason}`, 'client'));
    }
    const body = prepared.body;

    try {
      const candidates = this.#regionCandidates(settings);
      let lastFailure = null;
      for (let index = 0; index < candidates.length; index += 1) {
        const regionId = candidates[index];
        try {
          const payload = await this.#attemptRegion({ settings, body, regionId });
          this.stats.ok += 1;
          this.stats.lastLatencyMs = Date.now() - startedAt;
          if (settings.debugLog) {
            const message = payload.choices?.[0]?.message ?? {};
            this.log(
              `请求成功：region=${regionId} model=${payload.model} 耗时=${this.stats.lastLatencyMs}ms ` +
                `思考=${message.reasoning_content ? '有' : '无'} 工具=${(message.tool_calls ?? []).length}`,
            );
          }
          return jsonResponse(res, 200, payload);
        } catch (error) {
          const failure =
            error instanceof UpstreamError
              ? error
              : new UpstreamError('bad_response', { status: 502, message: `WorkBuddy 接入层异常：${error?.message ?? error}` });
          const next = candidates[index + 1];
          if (next && this.#canFailover(failure.kind)) {
            this.stats.failovers += 1;
            lastFailure = failure;
            this.warn(
              `WorkBuddy ${REGIONS[regionId].label}不可用（${failure.kind}：${String(failure.message).slice(0, 120)}），` +
                `自动改用${REGIONS[next].label}账号重试一次`,
            );
            continue;
          }
          throw failure;
        }
      }
      throw lastFailure ?? new UpstreamError('bad_response', { status: 502, message: '没有可用的 WorkBuddy 账号' });
    } catch (error) {
      const failure =
        error instanceof UpstreamError
          ? error
          : new UpstreamError('bad_response', { status: 502, message: `WorkBuddy 接入层异常：${error?.message ?? error}` });
      this.stats.failed += 1;
      this.stats.lastErrorAt = Date.now();
      this.stats.lastError = failure.message;

      // 回退：WorkBuddy 不可用时，用 QQ Agent 自己配置的官方 API 再发一次
      if (settings.fallbackToNative && failure.kind !== 'client') {
        const served = await this.#fallbackToNative(res, rawBody, failure);
        if (served) {
          this.stats.fallbacks += 1;
          this.stats.lastLatencyMs = Date.now() - startedAt;
          return undefined;
        }
      }
      this.warn(`WorkBuddy 调用失败：${failure.message}`);
      return jsonResponse(res, failure.status, errorPayload(failure.message, failure.kind, failure.upstreamCode));
    }
  }

  /** 用指定区域跑一次完整对话：解析模型 → 调上游 → 聚合 → 还原工具调用 → 组装响应。 */
  async #attemptRegion({ settings, body, regionId }) {
    const { token } = await this.credentials.ensureToken(regionId);
    const region = REGIONS[regionId];
    const account = this.credentials.account(regionId);

    // 模型解析：设置里指定了就用设置里的（用户意图），否则沿用请求里的
    const wanted = String(settings.model ?? '').trim() || String(body.model ?? '');
    let resolved = wanted;
    try {
      const catalog = await this.catalog.get(region, token);
      const pick = this.catalog.resolve(regionId, wanted);
      resolved = pick.id;
      if (pick.corrected) this.warn(pick.reason ?? '模型已自动纠正');
    } catch (error) {
      // 目录挂掉不影响对话：直接按设置/请求里的模型发，错了上游会报
      this.warn(`模型目录不可用（继续用 ${resolved}）：${error?.message ?? error}`);
    }
    body.model = resolved;
    if (Number(settings.maxTokensCap) > 0) {
      body.max_tokens = Math.min(Number(body.max_tokens) || Number(settings.maxTokensCap), Number(settings.maxTokensCap));
    }
    // 不带这个参数上游就不回 usage
    body.stream_options = { include_usage: true };

    this.stats.lastModel = resolved;
    this.stats.lastRegion = regionId;

    const result = await this.#callUpstream({ settings, region, regionId, token, account, body });
    if (!result.toolCalls.length) {
      // 有些模型把工具调用写进正文（DSML 标记），恢复成真正的 tool_calls
      const recovered = recoverToolsFromMarkup(result.content, toolNamesOf(body));
      if (recovered.toolCalls.length) {
        result.toolCalls = recovered.toolCalls;
        result.content = recovered.content;
        result.finishReason = 'tool_calls';
        this.log(`模型把工具调用写成了正文标记，已恢复 ${recovered.toolCalls.length} 个调用`);
      } else if (recovered.content !== result.content) {
        result.content = recovered.content;
      }
    }

    const message = {
      role: 'assistant',
      content: result.toolCalls.length ? null : result.content,
    };
    if (settings.includeReasoning && result.reasoning !== '') message.reasoning_content = result.reasoning;
    if (result.toolCalls.length) message.tool_calls = result.toolCalls;

    return {
      id: result.id,
      object: 'chat.completion',
      created: result.created,
      model: result.model || resolved,
      choices: [{ index: 0, message, finish_reason: result.finishReason }],
      usage: normalizeUsage(result.usage) ?? {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }

  /** 真正发上游；队列重试 + 渠道校验自救都在这里。 */
  async #callUpstream({ settings, region, regionId, token, account, body }) {
    const maxQueueRetries = Math.max(0, Number(settings.queueRetries) || 0);
    const idleMs = Math.max(20, Number(settings.requestTimeoutSec) || 180) * 1000;
    let neutralized = false;
    let queueAttempt = 0;

    for (;;) {
      const controller = new AbortController();
      let response;
      try {
        response = await openChatStream({
          region,
          token,
          accountId: account?.accountId,
          body,
          timeoutMs: HEADER_TIMEOUT_MS,
          signal: controller.signal,
        });
      } catch (error) {
        throw error instanceof UpstreamError ? error : classifyFailure(0, String(error?.message ?? error), { hasHttpResponse: false });
      }

      if (!response.ok) {
        const text = await response.text();
        const failure = classifyFailure(response.status, text);
        // 渠道校验：把每个开头垫上中性头再试一次（一次性自救，不无限重试）
        if (failure.kind === 'channel_reject' && !neutralized) {
          neutralized = true;
          this.stats.retries += 1;
          const retried = prepareBody(JSON.stringify(body), { forceNeutral: true });
          if (retried.ok) {
            body = retried.body;
            body.stream_options = { include_usage: true };
            this.log('WorkBuddy 渠道校验拦截了提示词，已垫中性开头重试一次');
            continue;
          }
        }
        if (failure.kind === 'model_queue' && queueAttempt < maxQueueRetries) {
          queueAttempt += 1;
          this.stats.retries += 1;
          this.log(`WorkBuddy 排队中，${QUEUE_RETRY_DELAY_MS / 1000} 秒后重试（第 ${queueAttempt} 次）`);
          await new Promise((resolve) => setTimeout(resolve, QUEUE_RETRY_DELAY_MS));
          continue;
        }
        throw failure;
      }

      const contentType = String(response.headers.get('content-type') ?? '');
      if (!contentType.includes('text/event-stream')) {
        // 上游偶尔会 200 + JSON 错误体
        const text = await response.text();
        throw classifyFailure(200, text);
      }

      // 先判「流被截断/无 [DONE]」是不是致命：readSse 容忍 EOF，这里接受半截答案
      try {
        return await readSse(idleGuard(response.body, idleMs, () => controller.abort()));
      } catch (error) {
        if (error instanceof UpstreamFrameError) {
          const failure = classifyFailure(200, JSON.stringify(error.frame));
          if (failure.kind === 'model_queue' && queueAttempt < maxQueueRetries) {
            queueAttempt += 1;
            this.stats.retries += 1;
            await new Promise((resolve) => setTimeout(resolve, QUEUE_RETRY_DELAY_MS));
            continue;
          }
          throw failure;
        }
        throw error instanceof UpstreamError
          ? error
          : new UpstreamError('bad_response', { status: 502, message: `读取 WorkBuddy 流式响应失败：${error?.message ?? error}` });
      }
    }
  }

  /**
   * WorkBuddy 不可用时的保底：直接按 QQ Agent 原生配置再发一次（同一份请求体）。
   * 返回 true 表示已经把响应写回去了。
   */
  async #fallbackToNative(res, rawBody, failure) {
    const target = this.nativeTarget?.() ?? {};
    const baseUrl = String(target.baseUrl ?? '').trim();
    const apiKey = String(target.apiKey ?? '').trim();
    if (baseUrl === '' || baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost')) return false;
    try {
      // QQ Agent 的 api.baseUrl 不带 /chat/completions（它自己拼），这里补上
      const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: rawBody,
        signal: AbortSignal.timeout(180_000),
      });
      const text = await response.text();
      this.log(`WorkBuddy 失败（${failure.kind}），已回退到 QQ Agent 自己的 API：HTTP ${response.status}`);
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
      });
      res.end(text);
      return true;
    } catch (error) {
      this.warn(`回退官方 API 也失败：${error?.message ?? error}`);
      return false;
    }
  }
}
