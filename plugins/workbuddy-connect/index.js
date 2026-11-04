/**
 * workbuddy-connect —— 把机器人的模型调用接到 WorkBuddy 额度上（确定性型插件 / API v1）
 *
 * ── 它做什么 ──────────────────────────────────────────────────────────────
 * QQ Agent 原来把对话直接发给配置页里填的 OpenAI 兼容网关（本机是 DeepSeek 官方
 * api.deepseek.com，按 token 计费）。本插件在本地起一个小中转，通过核心提供的
 * `llm.endpoint-pick` 能力把每次模型调用的地址换到本地中转，再由中转按 WorkBuddy
 * 网关的要求（强制流式、字符串 tool_choice、对话三连头、首条必须 system）发给
 * WorkBuddy，最后把 SSE 拼回一次性 JSON 还给 QQ Agent。
 *
 * 效果：同样的机器人、同样的工具和人格，消耗的是 WorkBuddy 账号里的额度。
 *
 * ── 为什么是插件，不是技能 ────────────────────────────────────────────────
 * 判据（README「扩展开发」+ src/skills/manifest.js 的 DIR_KIND）：
 *   plugins/ 确定性型 —— 提供能力/钩子，由核心在固定时机**必然调用**；
 *   skills/  LLM 型   —— 注册工具，要不要用由模型自己判断。
 * 「把请求地址换掉并转译协议」这件事一个 token 的模型判断都不需要，也不该让模型
 * 决定要不要省钱 —— 所以必须是插件。技能里做不了这件事：技能的工具体系只影响
 * 「模型能调哪些工具」，碰不到请求发往哪里。
 *
 * ── 依赖的宿主能力 / 数据 ────────────────────────────────────────────────
 *   · 能力 `llm.endpoint-pick`：核心在发请求前同步询问，返回 {baseUrl, apiKey, model}
 *     即改写本次调用的目标（src/llm.js:274-294）。返回 null 表示不接管。
 *   · 数据 <DATA_DIR>/workbuddy-connect-auth.json：本插件续期后的 token 缓存
 *     （只写自己的文件，不动 DSH 插件的凭据库）。
 *   · 设置：来自插件 manifest 的 settings/configSchema，UI 改完即时生效（每次现读）。
 *
 * ── 静默失效风险清单（都已在代码里处理）────────────────────────────────
 *   · 中转没起来还返回 baseUrl → 全部对话失败：只在 server.listening 时才接管。
 *   · 上游只认 stream:true → wire.js 强制改写。
 *   · 不带 stream_options.include_usage 就没 usage → shim 补上。
 *   · 失败时悄悄回退官方 API 会让用户以为在用 WorkBuddy → 回退写日志 + 状态工具可见。
 *   · **热重载**：QQ Agent 每次重扫（装扩展、改文件、点刷新）都会把插件重新 setup 一遍，
 *     并先 deactivate 旧实例。v1.1.0 在 deactivate 里直接停中转，新实例又要抢同一个端口；
 *     多个重扫并发时会连环抢端口，最后新实例启动失败 → 静默不再接管，机器人悄悄回到
 *     官方 API（2026-10-23 实际踩到：装扩展期间 27 次重扫后失效）。v1.2.0 改成：
 *     ① 中转存进 globalThis 单例，重载时新实例**接管正在跑的中转**（不重新 bind 端口）；
 *     ② deactivate 收到 reason='reload' 时只停看门狗，不停中转；
 *     ③ 每 5 秒看门狗自检，接管该生效却没就绪就自动重建，不需要重启 QQ Agent；
 *     ④ 所有生命周期/失败都写进应用日志（logger，落盘 data/logs），别再"静默"。
 */

import { DATA_DIR, getConfig } from '../../src/config.js';
import { logger } from '../../src/logger.js';

const MODULE_ID = 'workbuddy-connect';
const BUILD_TAG = 'v1.2.0';

/**
 * 同级 lib 模块必须用「带版本号的动态 import」加载：插件热重载只给入口文件加了 ?t=…，
 * 静态 import 会被 Node 的 ESM 缓存永久钉在首次加载的版本 —— 改了代码却还在跑旧逻辑，
 * 而且不报错。这里每次 setup 都换一个新版本号，lib 内部再用 import.meta.url 的查询串往下传。
 */
let lib = null;

async function loadLib() {
  const version = Date.now();
  const [vault, catalog, shim] = await Promise.all([
    import(`./lib/vault.js?v=${version}`),
    import(`./lib/catalog.js?v=${version}`),
    import(`./lib/shim.js?v=${version}`),
  ]);
  return {
    REGIONS: vault.REGIONS,
    CredentialStore: vault.CredentialStore,
    Catalog: catalog.Catalog,
    WorkBuddyShim: shim.WorkBuddyShim,
  };
}

/**
 * 跨热重载单例：中转服务、凭据缓存、目录缓存都挂在这里。
 * 热重载会重新求值本模块，模块级变量全部重置 —— 只有 globalThis 上的状态能活下来。
 */
const SINGLETON_KEY = Symbol.for('qq-agent.workbuddy-connect');
const shared = (globalThis[SINGLETON_KEY] ??= {
  shim: null,
  credentials: null,
  catalog: null,
  /** 启动时请求的端口（顺延后的实际端口记录在 shim.port） */
  requestedPort: 0,
  ready: false,
  readyError: '',
  /** 最近一次被记录过的失败原因，避免热重载/看门狗反复刷屏 */
  lastWarnAt: 0,
  lastStartError: '',
  startedAt: 0,
  /** 当前活动实例的钩子（设置/日志/回退目标），重载后会被新实例覆盖 */
  hooks: null,
  /** 进行中的启动 Promise（并发请求共用同一次启动） */
  starting: null,
  /** 自检看门狗定时器 */
  watchdog: null,
});

/** 出厂默认值（与 plugin.json 的 settings 保持一致，缺项时用它兜底）。 */
const DEFAULTS = {
  enabled: true,
  takeover: true,
  region: 'auto',
  model: 'deepseek-v4.1-flash',
  port: 39321,
  fallbackToNative: true,
  regionFallback: true,
  requestTimeoutSec: 180,
  queueRetries: 1,
  maxTokensCap: 0,
  includeReasoning: true,
  debugLog: false,
};

let cfg = () => ({});

/** 日志：既进控制台也落盘（data/logs），热重载后仍然只有一份，不会因为实例更替而丢线索。 */
function writeLog(level, message) {
  const text = String(message);
  try {
    if (typeof logger?.[level] === 'function') logger[level](MODULE_ID, text);
    else console.log(`[${MODULE_ID}] ${text}`);
  } catch {
    try { console.log(`[${MODULE_ID}] ${text}`); } catch { /* ignore */ }
  }
}

function log(message) {
  writeLog('info', message);
  // 同时转发给当前实例的 api.log（保持兼容，控制台里能看到 [skill:...] 前缀）
  try { shared.hooks?.log?.(message); } catch { /* ignore */ }
}

function warn(message) {
  writeLog('warn', message);
  try { shared.hooks?.warn?.(message); } catch { /* ignore */ }
}

function bool(value, dflt) {
  if (value === undefined || value === null || value === '') return dflt;
  if (typeof value === 'string') return !['false', '0', 'no', 'off'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function int(value, dflt, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** 设置：每次现读，UI 改完立刻生效（不需要重启）。 */
function settings() {
  const raw = (typeof cfg === 'function' ? cfg() : null) || {};
  const pick = (key) => (raw[key] === undefined || raw[key] === null ? DEFAULTS[key] : raw[key]);
  const region = String(pick('region') ?? 'auto').trim().toLowerCase();
  return {
    enabled: bool(pick('enabled'), DEFAULTS.enabled),
    takeover: bool(pick('takeover'), DEFAULTS.takeover),
    region: ['auto', 'cn', 'global'].includes(region) ? region : 'auto',
    model: String(pick('model') ?? '').trim() || DEFAULTS.model,
    port: int(pick('port'), DEFAULTS.port, 1024, 65535),
    fallbackToNative: bool(pick('fallbackToNative'), DEFAULTS.fallbackToNative),
    regionFallback: bool(pick('regionFallback'), DEFAULTS.regionFallback),
    requestTimeoutSec: int(pick('requestTimeoutSec'), DEFAULTS.requestTimeoutSec, 20, 600),
    queueRetries: int(pick('queueRetries'), DEFAULTS.queueRetries, 0, 5),
    maxTokensCap: int(pick('maxTokensCap'), DEFAULTS.maxTokensCap, 0, 128000),
    includeReasoning: bool(pick('includeReasoning'), DEFAULTS.includeReasoning),
    debugLog: bool(pick('debugLog'), DEFAULTS.debugLog),
  };
}

/** QQ Agent 自己配置的 API（WorkBuddy 不可用时的回退目标）。 */
function nativeTarget() {
  try {
    const api = getConfig()?.api ?? {};
    return { baseUrl: String(api.baseUrl ?? ''), apiKey: String(api.apiKey ?? '') };
  } catch (error) {
    warn(`读取 QQ Agent 的 API 配置失败（不影响 WorkBuddy 主链路）：${error?.message ?? error}`);
    return {};
  }
}

/** 同一类失败最多每 60 秒写一条，避免每个模型调用都刷日志。 */
function warnThrottled(message, force = false) {
  const now = Date.now();
  if (!force && now - shared.lastWarnAt < 60_000) return;
  shared.lastWarnAt = now;
  warn(message);
}

/** 懒启动：第一次需要时再起中转服务；端口或开关变化后会自动重建。 */
async function ensureShim() {
  if (!lib) lib = await loadLib();
  const s = settings();
  if (!s.enabled || !s.takeover) return null;

  // 端口设置被改过：拆掉旧中转，重建到新端口（被占用顺延的情况不算改动）
  if (shared.shim?.running && shared.requestedPort && s.port !== shared.requestedPort) {
    log(`中转端口设置变化（${shared.requestedPort} → ${s.port}），正在重建中转服务`);
    await stopShim();
  }
  // 已经在跑：直接复用（热重载后新实例接管旧中转，绝不重复 bind 同一端口）
  if (shared.shim?.running) {
    shared.ready = true;
    shared.readyError = '';
    return shared.shim;
  }
  // 并发调用（同一轮里多个模型请求同时发现"没就绪"）共用同一次启动
  if (shared.starting) return shared.starting;

  shared.requestedPort = s.port;
  const starting = (async () => {
    const credentials = new lib.CredentialStore({
      cacheDir: DATA_DIR,
      log: (msg) => log(msg),
    });
    credentials.load();
    if (credentials.availableRegions().length === 0) {
      shared.ready = false;
      shared.readyError =
        '没有找到本机 WorkBuddy 登录凭据（~/.dsh/workbuddy-vault 为空）。插件已加载但不接管模型调用，机器人继续用官方 API；用 WorkBuddy 客户端登录一次即可自动启用。';
      if (shared.readyError !== shared.lastStartError) {
        shared.lastStartError = shared.readyError;
        warn(shared.readyError);
      }
      return null;
    }
    const catalog = new lib.Catalog({ log: (msg) => log(msg) });
    const shim = new lib.WorkBuddyShim({
      credentials,
      catalog,
      // 这四个钩子每次都从 shared 现取：热重载后新实例换了设置读取器，旧中转也跟着用新的
      getSettings: () => shared.hooks?.settings?.() ?? settings(),
      log: (msg) => log(msg),
      warn: (msg) => warn(msg),
      nativeTarget: () => shared.hooks?.nativeTarget?.() ?? nativeTarget(),
    });
    const port = await shim.start(s.port);
    shared.shim = shim;
    shared.credentials = credentials;
    shared.catalog = catalog;
    shared.ready = true;
    shared.readyError = '';
    shared.lastStartError = '';
    log(
      `WorkBuddy 接入已就绪（${BUILD_TAG}）：中转 http://127.0.0.1:${port}/v1，默认模型 ${s.model}，` +
        `账号 ${credentials.describe().map((entry) => `${entry.regionLabel}/${entry.account}`).join('、')}`,
    );
    // 后台预热目录（失败不影响对话，下一次请求会自己再试）
    const regions = credentials.availableRegions();
    const regionId = regions.includes('cn') ? 'cn' : regions[0];
    if (regionId) {
      credentials
        .ensureToken(regionId)
        .then(({ token }) => catalog.get(lib.REGIONS[regionId], token))
        .then(() => {
          const resolved = catalog.resolve(regionId, s.model);
          if (resolved.corrected) warn(resolved.reason ?? '模型已自动纠正');
          else log(`模型可用：${resolved.id}`);
        })
        .catch((error) => warn(`预热模型目录失败（对话时再试）：${error?.message ?? error}`));
    }
    return shim;
  })();

  shared.starting = starting;
  starting.then(
    () => { if (shared.starting === starting) shared.starting = null; },
    () => { if (shared.starting === starting) shared.starting = null; },
  );
  try {
    return await starting;
  } catch (error) {
    shared.ready = false;
    shared.readyError = `WorkBuddy 中转服务启动失败：${error?.message ?? error}`;
    if (shared.readyError !== shared.lastStartError) {
      shared.lastStartError = shared.readyError;
      warn(shared.readyError);
    }
    return null;
  }
}

/** 停掉中转（禁用/换端口/卸载时）。 */
async function stopShim() {
  const shim = shared.shim;
  shared.shim = null;
  shared.requestedPort = 0;
  shared.ready = false;
  if (shim) {
    try {
      await shim.stop();
      log('WorkBuddy 中转服务已停止');
    } catch (error) {
      warn(`停止中转服务时出错：${error?.message ?? error}`);
    }
  }
}

/** 自检看门狗：接管该生效却没有中转在跑时自动重建（不需要重启 QQ Agent）。 */
function startWatchdog() {
  stopWatchdog();
  shared.startedAt = Date.now();
  const timer = setInterval(() => {
    try {
      const s = settings();
      if (!s.enabled || !s.takeover) return;
      if (shared.shim?.running) return;
      ensureShim().catch(() => {});
    } catch { /* ignore */ }
  }, 5000);
  timer.unref?.();
  shared.watchdog = timer;
}

function stopWatchdog() {
  if (shared.watchdog) {
    try { clearInterval(shared.watchdog); } catch { /* ignore */ }
    shared.watchdog = null;
  }
}

/**
 * 核心在每次模型调用前同步询问「这次发去哪」。
 * 只有中转真的在监听、且开关打开时才接管；否则返回 null，让核心用原来的地址。
 */
function pickEndpoint(args = {}) {
  const s = settings();
  if (!s.enabled || !s.takeover) return null;
  if (!shared.ready || !shared.shim?.running) {
    // 还没就绪：这一轮不接管（避免把对话打到半启动的服务上），后台立刻重建
    ensureShim().catch(() => {});
    warnThrottled(
      `WorkBuddy 接管暂未生效：${shared.readyError || '本地中转还没就绪'}。这一次对话走了官方 API，` +
        '插件正在后台自动重建中转（每 5 秒重试一次），不需要重启 QQ Agent。',
    );
    return null;
  }
  const requestedModel = String(args?.model ?? '').trim();
  const model = s.model || requestedModel || DEFAULTS.model;
  if (shared.requestedPort && s.port !== shared.requestedPort) {
    // 端口设置刚改过：这一轮先不接管（避免打到马上要关掉的服务），后台重建后下一轮生效
    ensureShim().catch(() => {});
    return null;
  }
  if (s.debugLog) {
    warnThrottled(`接管本次调用：模型 ${model} → ${shared.shim.baseUrl}`, true);
  }
  return {
    baseUrl: shared.shim.baseUrl,
    // 中转不校验 API Key（只监听本机回环），随便给一个非空值即可
    apiKey: 'workbuddy-local',
    model,
  };
}

// ───────────────────────────── 生命周期 ─────────────────────────────

export async function setup(api) {
  if (typeof api?.config === 'function') cfg = api.config;
  const instanceLog = typeof api?.log === 'function' ? api.log : null;
  const instanceWarn = typeof api?.warn === 'function' ? api.warn : null;
  shared.hooks = {
    settings: () => settings(),
    log: (message) => { try { instanceLog?.(message); } catch { /* ignore */ } },
    warn: (message) => { try { instanceWarn?.(message); } catch { /* ignore */ } },
    nativeTarget: () => nativeTarget(),
  };
  lib = await loadLib();
  registerStatusTool(api);
  log(`WorkBuddy 额度接入已加载（${BUILD_TAG}）｜移植自 dsh-connect-workbuddy v5.6.2`);
}

export async function activate() {
  const s = settings();
  shared.startedAt = Date.now();
  if (!s.enabled) {
    log('插件当前是禁用状态（enabled=false），不会接管模型调用');
    stopWatchdog();
    return;
  }
  if (!s.takeover) {
    log('已加载但「接管模型调用」关闭：机器人仍走官方 API，随时可以打开接管');
    stopWatchdog();
    return;
  }
  startWatchdog();
  await ensureShim();
}

/**
 * 热重载（reason='reload'）时**不要**停中转：新实例会接管同一个中转服务。
 * 停掉的话新实例要重新 bind 同一端口，多个重扫并发时会连环抢端口失败，
 * 表现就是「插件还在、但机器人悄悄走回官方 API」。
 */
export async function deactivate(context = {}) {
  stopWatchdog();
  if (context?.reason === 'reload') {
    if (shared.shim?.running) log('热重载：保留正在运行的本地中转，交给新实例接管');
    return;
  }
  await stopShim();
}

/** 卸载/删除插件时彻底收尾（loader 会调 dispose）。 */
export function dispose() {
  stopWatchdog();
  stopShim().catch(() => {});
}

/** 插件本身永远可以加载；能不能接管由设置和凭据决定（见 status 工具）。 */
export function available() {
  return true;
}

// ───────────────────────────── 能力 / 工具 ─────────────────────────────

export const providers = {
  /**
   * 核心的模型请求入口（src/llm.js:274-294）。
   * 返回 {baseUrl, apiKey, model} 即接管这次调用；返回 null 表示不干预。
   */
  'llm.endpoint-pick': (args) => pickEndpoint(args),
};

/** 给机器人一个自查工具：问它「WorkBuddy 现在什么状态」时能答上来。 */
function registerStatusTool(api) {
  if (typeof api?.registerTool !== 'function') return;
  api.registerTool({
    id: 'workbuddy_status',
    name: 'WorkBuddy 额度状态',
    description:
      '查看机器人当前的大脑是不是 WorkBuddy、用的是哪个区域和模型、本地中转是否正常、本机登录了几个 WorkBuddy 账号、最近一次调用成功还是失败（以及失败原因）。用户问「你现在用的是什么模型/额度」「workbuddy 好用吗」「怎么切回 deepseek」时调用它。',
    category: 'utility',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const s = settings();
      const shim = shared.shim;
      const status = shim ? shim.status() : null;
      const lines = [];
      lines.push(`WorkBuddy 接入：${s.enabled ? (s.takeover ? '已接管模型调用' : '已加载但未接管（仍在用官方 API）') : '已停用'}`);
      lines.push(`插件版本：${BUILD_TAG}；运行状态：${shared.ready ? '正常' : shared.readyError || '未就绪'}`);
      if (status) {
        lines.push(`本地中转：http://127.0.0.1:${status.port}/v1（只监听本机）`);
        lines.push(`本次进程内调用：成功 ${status.stats.ok} 次，失败 ${status.stats.failed} 次，回退官方 API ${status.stats.fallbacks} 次，换区重试 ${status.stats.failovers ?? 0} 次`);
        if (status.stats.lastLatencyMs) lines.push(`最近一次耗时：${status.stats.lastLatencyMs}ms（模型 ${status.stats.lastModel || s.model}）`);
        if (status.stats.lastError) lines.push(`最近一次失败原因：${status.stats.lastError}`);
      }
      if (status?.accounts?.length) {
        lines.push(
          `本机 WorkBuddy 账号：${status.accounts
            .map((entry) => `${entry.regionLabel}/${entry.account}${entry.expiresAt ? `（凭据到期 ${new Date(entry.expiresAt).toLocaleString('zh-CN', { hour12: false })}）` : ''}`)
            .join('；')}`,
        );
      } else {
        lines.push('本机 WorkBuddy 账号：没找到（需要在 WorkBuddy 客户端登录一次）');
      }
      const cached = shared.catalog?.list(s.region === 'auto' ? 'cn' : s.region) ?? [];
      if (cached.length) lines.push(`当前区域可用模型：${cached.slice(0, 8).map((model) => model.id).join('、')}${cached.length > 8 ? ' 等' : ''}`);
      lines.push(`设置里的模型：${s.model}；失败回退官方 API：${s.fallbackToNative ? '开' : '关'}；国内版失败自动换国际版：${s.region === 'auto' && s.regionFallback ? '开' : '关（或已固定区域）'}`);
      return { content: lines.join('\n'), isError: false };
    },
  });
}

export const __internals = {
  settings,
  DEFAULTS,
  state: shared,
  ensureShim,
  stopShim,
  pickEndpoint,
  BUILD_TAG,
};
