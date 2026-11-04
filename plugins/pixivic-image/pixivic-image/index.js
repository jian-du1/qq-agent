// Pixivic 图片检索（确定性型插件 / plugins/pixivic-image）
//
// ── 功能 ────────────────────────────────────────────────────────────────
//   群或私聊发「#pix 角色名 提示词」
//     → 到 Pixivic（https://m.pixivic.net/ ，Pixiv 国内镜像）搜索该角色
//     → 按提示词标签筛选
//     → 在候选池里随机挑一张，压缩后发出来
//   例：#pix 心月狐 鸣嘲   → 搜「心月狐」，筛「鸣嘲」标签，随机发一张
//
//   提示词是**可选**的：「#pix 心月狐」也照常出图，只是跳过标签筛选，
//   直接按角色名搜、按原有规则（热度池随机）发一张。也兼容「#pix+心月狐」
//   这种用加号连写的写法。
//
// ── 为什么是插件（确定性型）而不是技能（LLM 型）──────────────────────────
//   按 skill-development.md §0 的三问：
//     第一问「触发时机能用 if 描述吗」：#pix 是**死的字面前缀**，
//       `if (消息以 "#pix " 开头)` 完全可写 → 插件。
//     第二问「漏一次的代价」：群友发了命令却没反应，等于命令契约被违反，
//       不能"这次算了下次再说" → 插件。
//     第三问「参数从哪来」：参数按**空格位置**切分（第一段角色名、其余是提示词），
//       是格式解析，不是从人话里抠语义 → 插件。
//   三问一致 → 插件。这也和项目里既有的 command-anime（#老婆 角色名 作品）同构。
//   做成技能的话，模型可能选择不调用 → 命令时灵时不灵，正是文档警告的失败模式。
//
// ── 三条必须守住的约束（全部踩过，别改）─────────────────────────────────
//   ① 钩子超时 5 秒（DEFAULT_HOOK_TIMEOUT_MS）→ 网络请求一律扔后台，钩子立刻返回
//   ② 钩子的 ctx **没有** sender / onebot / store / session
//      → 发送只能走 lib/protocol.mjs 直连 SnowLuma 的 HTTP 接口
//   ③ 热重载只重载 index.js，lib/*.mjs 会命中 ESM 缓存
//      → 子模块一律 `?v=LIB_VERSION` 动态导入；改了 lib 必须把版本号加一

import fs from 'node:fs';
import path from 'node:path';

/* 改了任何 lib/*.mjs 之后**必须把这个数字加一**，否则热重载拿到的还是旧缓存。 */
const LIB_VERSION = 1;

const lib = (name) => import(`./lib/${name}?v=${LIB_VERSION}`);
const protocolLib = await lib('protocol.mjs');
const pixivicLib = await lib('source-pixivic.mjs');
const compressLib = await lib('compress.mjs');
const downloadLib = await lib('download.mjs');

const { sendGroupMessage, sendPrivateMessage, textSegment, imageSegment, probeProtocol } = protocolLib;
const { pick } = pixivicLib;
const { compressImage } = compressLib;
const { downloadImage } = downloadLib;

/* ══════════════════════════════════════════════════════════════════════
 * 配置
 * ════════════════════════════════════════════════════════════════════ */

const PLUGIN_ID = 'pixivic-image';

const DEFAULTS = {
  commandPrefix: '#',
  triggerWord: 'pix',
  pixivicToken: '',
  strictTag: true,
  autoSend: true,
  sendCaption: true,
  cooldownSeconds: 20,
  maxDim: 1600,
  targetKb: 1200
};

/** 认识的前缀符号（用户把前缀改成别的时，仍容忍这些常见符号）。 */
const PREFIX_CHARS = ['#', '/', '!', '！', '.'];

let cfg = () => ({});
let log = () => {};
let warn = () => {};
/** 宿主给的 api 对象（setup 时存下）。热重载/多实例下模块级变量可能没被赋值。 */
let hostApi = null;

/* ── 必定可见的诊断日志（api.log 不进核心日志文件，出问题看不见）────────── */
function dataPath(name) {
  const base = String(process.env.QQ_AGENT_DATA_DIR || '').trim()
    || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local', 'Programs', 'QQ Agent', 'data');
  return path.join(base, name);
}

let fileLogBroken = false;
function dlog(message) {
  const line = `${new Date().toISOString()} ${message}`;
  try { log(`[诊断] ${message}`); } catch { /* ignore */ }
  if (!fileLogBroken) {
    try { fs.appendFileSync(dataPath('pixivic-image.log'), `${line}\n`); } catch { fileLogBroken = true; }
  }
  try { process.stdout.write(`[pixivic-image] ${message}\n`); } catch { /* ignore */ }
}

function describeError(error) {
  if (!error) return '未知错误';
  const message = String(error?.message || error);
  const where = String(error?.stack || '').split('\n')[1]?.trim() || '';
  return where ? `${message} @ ${where}` : message;
}

function shortError(error) {
  const t = String(error?.message || error || '未知错误');
  return t.length > 120 ? `${t.slice(0, 120)}…` : t;
}

/* ══════════════════════════════════════════════════════════════════════
 * 生命周期
 * ════════════════════════════════════════════════════════════════════ */

export function setup(api) {
  hostApi = api || null;
  cfg = api.config;
  log = api.log || (() => {});
  warn = api.warn || (() => {});

  const s = readSettings();
  dlog(`加载完成：命令=${s.commandPrefix}${s.triggerWord}  严格标签=${s.strictTag}  冷却=${s.cooldownSeconds}s`);
  const { token, from } = resolveToken(s);
  dlog(`token=${token ? `${token.length} 字符（${from}）` : `未配置（${from}）`}`);
  logTokenExpiry(token);

  probeProtocol()
    .then((r) => {
      dlog(r.ok ? `协议端自检：${r.detail}` : `❌ 协议端不可用（发不出图）：${r.detail}`);
      if (!r.ok) warn(`发图通道不可用：${r.detail}`);
    })
    .catch((error) => dlog(`协议端自检异常：${describeError(error)}`));
}

/** 依赖自检：必须同步返回（返回 Promise 会被当成"可用"）。 */
export function available() {
  return true;
}

/* ══════════════════════════════════════════════════════════════════════
 * 钩子
 * ════════════════════════════════════════════════════════════════════ */

export const hooks = {
  'before-context'(ctx = {}) {
    try {
      const entries = Array.isArray(ctx?.triggerEntries) ? ctx.triggerEntries : [];
      if (!entries.length) return;
      if (ctx.proactive) return;                       // 机器人主动发言时不响应命令

      const s = readSettings(ctx);
      for (const entry of entries) {
        if (!entry || entry.self) continue;            // 不响应自己发的消息
        const hit = parseCommand(String(entry.text ?? ''), s);
        if (!hit) continue;

        dlog(`命令命中：角色=${JSON.stringify(hit.character)} 提示词=${JSON.stringify(hit.filter)}`
          + ` chat=${ctx.chatKey} 原文=${JSON.stringify(hit.raw).slice(0, 40)}`);
        // 把命令改写成"系统正在自动执行"的说明，模型读了就不会再自己动手/复述
        entry.text = buildDirective(hit);
        startJob(hit, ctx, s);                         // 后台执行，钩子立刻返回
        break;
      }
    } catch (error) {
      dlog(`❌ 钩子处理异常：${describeError(error)}`);
      warn(`Pixivic 指令处理失败：${String(error?.message || error)}`);
    }
  }
};

/* ══════════════════════════════════════════════════════════════════════
 * 配置读取
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 从宿主拿本插件设置。
 *
 * ⚠️ 比"直接用模块级 cfg() 的返回值"多绕一层，是为了绕开一个很难查的真机故障：
 *    热重载后出现过"钩子读到的设置是空的"（跑钩子的那份实例的 setup 可能压根没被
 *    调用过），所有设置静默退回默认值、日志表面正常。所以按
 *    ctx.api → setup 存的 api → 模块级 cfg → 磁盘 的顺序兜底。
 */
function settingsFrom(ctx) {
  const fromCtx = ctx && (ctx.api || ctx.host || ctx.pluginApi);
  for (const candidate of [fromCtx, hostApi]) {
    if (candidate && typeof candidate.config === 'function') {
      try {
        const v = candidate.config();
        if (v && typeof v === 'object' && Object.keys(v).length) return v;
      } catch { /* 试下一个来源 */ }
    }
  }
  try {
    const v = typeof cfg === 'function' ? cfg() : null;
    if (v && typeof v === 'object' && Object.keys(v).length) return v;
  } catch { /* 试下一个来源 */ }
  return settingsFromDisk() || {};
}

let diskCfgCache = { at: 0, data: null };
function settingsFromDisk() {
  if (Date.now() - diskCfgCache.at < 3000 && diskCfgCache.data) return diskCfgCache.data;
  try {
    const all = JSON.parse(fs.readFileSync(dataPath('config.json'), 'utf8'));
    const mine = all?.skills?.[PLUGIN_ID];
    if (mine && typeof mine === 'object' && Object.keys(mine).length) {
      diskCfgCache = { at: Date.now(), data: mine };
      return mine;
    }
  } catch { /* 读不到就走别的来源 */ }
  return null;
}

/**
 * Pixivic 的 token 兜底：本插件没填时，沿用 command-anime 里已配好的那份。
 *
 * 为什么这么做：Pixivic 的搜索接口需要登录，不填 token 只能匹配它的 59 个热门标签，
 * 冷门角色一律搜不到（而表面上看不出任何异常）。用户已经在 command-anime 里填过一次，
 * 再让他为同一个站点填第二遍没有意义 —— 所以这里直接沿用，并在日志里写明来源。
 * 本插件设置里填了值就以本插件为准（可随时覆盖）。
 */
const SIBLING_PLUGIN_ID = 'command-anime';
let siblingTokenCache = { at: 0, value: null };
function tokenFromSibling() {
  if (siblingTokenCache.value !== null && Date.now() - siblingTokenCache.at < 5000) {
    return siblingTokenCache.value;
  }
  let value = '';
  try {
    const all = JSON.parse(fs.readFileSync(dataPath('config.json'), 'utf8'));
    const t = all?.skills?.[SIBLING_PLUGIN_ID]?.pixivicToken;
    if (typeof t === 'string') value = t.trim();
  } catch { /* 读不到就当没有 */ }
  siblingTokenCache = { at: Date.now(), value };
  return value;
}

function resolveToken(s) {
  if (s.pixivicToken) return { token: s.pixivicToken, from: '本插件设置' };
  const t = tokenFromSibling();
  if (t) return { token: t, from: '沿用 command-anime 的 token' };
  return { token: '', from: '未配置（只能匹配热门标签）' };
}

/**
 * 把 token 的到期时间写进日志。
 *
 * 为什么需要：Pixivic 的 token 是短寿命的 JWT（实测只有 6 天）。过期后**任意关键词搜索
 * 都会失败**，而现象只是"搜不到图"，很容易被当成插件坏了。启动时把到期时间打出来，
 * 一眼就能看出"是不是又该换 token 了"。token 不是 JWT 时静默跳过（不猜）。
 */
function logTokenExpiry(token) {
  if (!token) return;
  try {
    const payload = String(token).split('.')[1];
    if (!payload) return;
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!json?.exp) return;
    const expMs = Number(json.exp) * 1000;
    const days = (expMs - Date.now()) / 86400000;
    const when = new Date(expMs).toLocaleString('zh-CN', { hour12: false });
    if (days <= 0) dlog(`⚠️ Pixivic token 已于 ${when} 过期，需重新登录后更新（否则只能匹配热门标签）`);
    else dlog(`Pixivic token 有效期至 ${when}（剩余 ${days.toFixed(1)} 天）`);
  } catch { /* 不是 JWT 就不猜 */ }
}

function readSettings(ctx) {
  const c = settingsFrom(ctx);
  const str = (key, fallback) => (typeof c?.[key] === 'string' ? c[key] : fallback);
  const bool = (key, fallback) => (typeof c?.[key] === 'boolean' ? c[key] : fallback);
  const num = (key, fallback, lo, hi) => {
    const n = Number(c?.[key]);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  };

  // 前缀：允许 '#/!！.' 单字符；显式留空 = 命令不带前缀；非法值回落默认
  const rawPrefix = str('commandPrefix', DEFAULTS.commandPrefix).trim();
  const commandPrefix = rawPrefix === ''
    ? ''
    : (PREFIX_CHARS.includes(rawPrefix) ? rawPrefix : DEFAULTS.commandPrefix);
  const triggerWord = (str('triggerWord', DEFAULTS.triggerWord).trim() || DEFAULTS.triggerWord).toLowerCase();

  return {
    commandPrefix,
    triggerWord,
    pixivicToken: str('pixivicToken', '').trim(),
    strictTag: bool('strictTag', DEFAULTS.strictTag),
    autoSend: bool('autoSend', DEFAULTS.autoSend),
    sendCaption: bool('sendCaption', DEFAULTS.sendCaption),
    cooldownSeconds: num('cooldownSeconds', DEFAULTS.cooldownSeconds, 0, 600),
    maxDim: num('maxDim', DEFAULTS.maxDim, 640, 4096),
    targetKb: num('targetKb', DEFAULTS.targetKb, 200, 8000)
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 命令解析
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 解析「<前缀><命令词> 角色名 提示词」。
 *
 *   '#pix 心月狐 鸣嘲'  → { character:'心月狐', filter:'鸣嘲' }
 *   '#pix 心月狐'       → { character:'心月狐', filter:'' }（不筛提示词，照常出图）
 *   '#pix+心月狐'       → { character:'心月狐', filter:'' }（加号连写也认）
 *   '#pix'              → { character:'', filter:'' }（回一条用法提示）
 *   别的消息            → null（不响应）
 *
 * 容错：允许连写多个前缀（##pix）、允许命令词后不空格（#pix心月狐）、
 *       允许用加号连写角色名（#pix+心月狐）。
 * 参数一律按**空格位置**切分 —— 第一段是角色名，其余合并为提示词；
 * 提示词为空时下游会跳过标签筛选，直接按角色名检索。
 *
 * @returns {{raw:string, character:string, filter:string}|null}
 */
export function parseCommand(text, s) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  // ① 去前缀（连写多个前缀也认，例如 ##pix）
  let body = raw;
  if (s.commandPrefix) {
    let i = 0;
    while (i < body.length && (body[i] === s.commandPrefix || PREFIX_CHARS.includes(body[i]))) i += 1;
    body = body.slice(i);
  } else {
    body = body.replace(/^[#/!！.]/, '');
  }
  if (!body) return null;

  // ② 命令词必须是开头那一段（且不能是中文，避免误伤普通聊天）
  const m = body.match(/^([A-Za-z0-9_]+)\s*([\s\S]*)$/);
  if (!m) return null;
  if (m[1].toLowerCase() !== s.triggerWord) return null;

  // ③ 参数按空格位置切分
  //    兼容「#pix+心月狐」：这里的加号只是连写符，不该被当成角色名的一部分。
  const args = m[2].replace(/^\s*[+＋]\s*/, '');
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  return {
    raw,
    character: tokens[0] || '',
    filter: tokens.slice(1).join(' ')
  };
}

/** 把用户命令改写成"系统正在自动执行"的说明，避免模型再自己动手或复述。 */
function buildDirective(hit) {
  const target = hit.character
    ? (hit.filter ? `角色「${hit.character}」、并筛选标签「${hit.filter}」` : `角色「${hit.character}」`)
    : '随机一张图';
  return `【指令·Pixivic】有人发了「${hit.raw}」。系统正在自动执行：从 Pixivic 检索${target}的图，随机选一张发到群里。`
    + '这是确定性动作，**不要调用任何工具、不要自己编内容、也不要复述本段文字**；'
    + '图片会由系统直接发出。若这次没能发出，系统会把失败原因发到群里。'
    + '你保持安静即可——除非群友接着问了其它问题。';
}

/* ══════════════════════════════════════════════════════════════════════
 * 发送（钩子的 ctx 没有 sender/onebot，只能走协议端 HTTP）
 * ════════════════════════════════════════════════════════════════════ */

let lastImageAt = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendSegments(ctx, segments) {
  const kind = String(ctx?.kind || '').trim() || 'group';
  const chatId = String(ctx?.chatId || '').trim();
  if (!chatId) throw new Error('拿不到会话号，无法发送');
  return kind === 'private' ? sendPrivateMessage(chatId, segments) : sendGroupMessage(chatId, segments);
}

async function sendTextNow(ctx, text) {
  await sendSegments(ctx, [textSegment(String(text ?? ''))]);
}

async function sendImageNow(ctx, dataUrl, note) {
  // 两张图之间留间隔，避免连发被风控
  const gap = 1100 - (Date.now() - lastImageAt);
  if (gap > 0) await sleep(gap);
  lastImageAt = Date.now();
  await sendSegments(ctx, [imageSegment(dataUrl)]);

  const caption = String(note ?? '').trim();
  if (caption) {
    try {
      await sleep(400);
      await sendSegments(ctx, [textSegment(caption.slice(0, 300))]);
    } catch (error) {
      dlog(`说明文字发送失败（图已发出）：${describeError(error)}`);
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 后台任务
 * ════════════════════════════════════════════════════════════════════ */

/** 同会话进行中的任务（防连点）与命令级冷却。 */
const inflight = new Map();
const lastRun = new Map();

/**
 * 冷却/进行中时的回执。
 * ⚠️ 必须防刷屏：群里几个人同时发命令时，每条都回一句会瞬间刷屏，
 *    所以同会话两次回执之间至少隔 COOLDOWN_NOTICE_GAP_MS。
 */
const COOLDOWN_NOTICE_GAP_MS = 8000;
const lastCooldownNotice = new Map();

/**
 * 失败提示的节流：同类失败（如 token 过期）5 分钟内只往群里说一次。
 * 否则群里每发一次 #pix 就刷一条"搜不了"，很快就会被嫌弃。
 */
const FAIL_NOTICE_GAP_MS = 5 * 60 * 1000;
const lastFailNotice = new Map();

function sendCooldownNotice(ctx, leftMs, key) {
  const now = Date.now();
  const last = lastCooldownNotice.get(key) || 0;
  if (now - last < COOLDOWN_NOTICE_GAP_MS) {
    dlog(`冷却回执被节流（距上次 ${Math.round((now - last) / 1000)} 秒）`);
    return;
  }
  lastCooldownNotice.set(key, now);
  const secs = Math.max(1, Math.ceil(leftMs / 1000));
  sendTextNow(ctx, `正在冷却时间，剩余 ${secs} 秒`)
    .catch((error) => dlog(`冷却回执发送失败：${describeError(error)}`));
}

function startJob(hit, ctx, s) {
  const key = `${ctx.chatKey}|pix`;

  // 先判冷却、再判"任务进行中"：两种被挡下的情况都要给用户回执，
  // 否则连发第二条时会完全没反馈（像是坏了）。
  const cooldownMs = s.cooldownSeconds * 1000;
  if (cooldownMs > 0) {
    const left = cooldownMs - (Date.now() - (lastRun.get(key) || 0));
    if (left > 0) {
      dlog(`跳过：冷却中（剩 ${Math.ceil(left / 1000)} 秒）→ 回执告知用户`);
      sendCooldownNotice(ctx, left, key);
      return;
    }
  }
  if (inflight.has(key)) {
    dlog('跳过：已有任务在进行 → 回执告知用户');
    sendCooldownNotice(ctx, cooldownMs || 5000, key);
    return;
  }
  lastRun.set(key, Date.now());
  dlog(`任务开始：chat=${ctx.chatKey}`);

  const wrapped = Promise.resolve(runPix(ctx, s, hit))
    .catch((error) => {
      dlog(`❌ 任务异常：${describeError(error)}`);
      warn(`Pixivic 出图任务异常：${error?.stack || error?.message || error}`);
      return { ok: false, message: `出错了：${shortError(error)}` };
    })
    .then(async (result) => {
      inflight.delete(key);
      if (result?.ok) { dlog('任务结束：成功'); return; }
      if (result?.silent) { dlog('任务结束：静默跳过（已提示过同类问题）'); return; }
      dlog(`任务结束：失败 → ${String(result?.message || '').slice(0, 120)}`);

      // 同类失败 5 分钟内只提示一次，避免刷屏
      const failKey = `${ctx.chatKey}|${String(result?.message || '').slice(0, 40)}`;
      const now = Date.now();
      if (now - (lastFailNotice.get(failKey) || 0) < FAIL_NOTICE_GAP_MS) {
        dlog('同类失败提示 5 分钟内已发过，本次静默跳过');
        return;
      }
      lastFailNotice.set(failKey, now);

      try {
        await sendTextNow(ctx, result?.message || '这次没成功，稍后再试。');
        dlog('失败原因已发到群里');
      } catch (error) {
        dlog(`❌ 发送失败提示也失败了：${describeError(error)}`);
      }
    });

  inflight.set(key, wrapped);
}

/**
 * 完整出图链路：检索 → 下载 → 压缩 → 发送。
 * @returns {Promise<{ok:boolean, message?:string, silent?:boolean}>}
 */
async function runPix(ctx, s, hit) {
  // 1) 只写了命令、没给角色名 → 回用法
  if (!hit.character) {
    return {
      ok: false,
      message: '用法：#pix 角色名 [提示词]（提示词可省略，省略就不筛标签），例如「#pix 心月狐 鸣嘲」或「#pix 心月狐」。'
    };
  }

  // 2) 检索（Pixivic）
  //    提示词是**可选**的：没有提示词时跳过标签筛选，直接按角色名检索，
  //    后面的下载/压缩/发送/去重规则与"有提示词"完全一致。
  const { token, from } = resolveToken(s);
  const hasFilter = Boolean(String(hit.filter || '').trim());
  dlog(`检索：角色「${hit.character}」 标签「${hasFilter ? hit.filter : '（无，跳过筛选）'}」`
    + ` 严格筛选=${hasFilter ? s.strictTag : '不适用'} token=${token ? `${token.length} 字符（${from}）` : `无（${from}）`}`);

  let r;
  try {
    r = await pick({
      keyword: hit.character,
      filterKeyword: hasFilter ? hit.filter : '',
      // 没有提示词 → 没有"筛不筛"的问题，保持宽松（所有候选都可选）；
      // 有提示词 → strictTag=true 时 relaxed=false：只发真正命中标签的图。
      relaxed: hasFilter ? !s.strictTag : true,
      token,
      log: dlog
    });
  } catch (error) {
    return { ok: false, message: `检索失败：${shortError(error)}` };
  }

  if (!r?.ok || !r.pick) {
    const reason = String(r?.reason || '');

    // 登录凭据过期是"账号的事"，不是插件坏了。
    // 群里只发一句短的（技术细节刷到群里没意义），完整修复步骤写进日志。
    if (/过期|未登录|需要登录/.test(reason)) {
      dlog('❌ Pixivic 登录凭据已过期。修复步骤：'
        + '① 浏览器打开 https://m.pixivic.net/ 重新登录（邮箱验证码 + 人机验证，不用手机号）；'
        + '② 按 F12 → Application → Local Storage → 复制 sharemoe.auth.token 的值；'
        + '③ 填到「Pixivic 图片检索」插件设置里的「Pixivic 登录 token」（或填到 command-anime 的 token 栏，本插件会自动沿用）。');
      return { ok: false, message: 'Pixivic 的登录凭据过期了，暂时搜不了图（需要更新一次 token）。' };
    }

    return {
      ok: false,
      message: reason
        ? `没找到图：${reason}`
        : (hasFilter ? '这次没找到能发的图，换个角色名或提示词再试。' : '这次没找到能发的图，换个角色名再试。')
    };
  }
  dlog(`命中 ${r.pool} 张候选，选中「${String(r.pick.file || '').slice(0, 50)}」`
    + `${r.reused ? '（发过的已排除，本轮重开）' : ''}`);

  // 3) 下载：候选顺序就是重试顺序（同图的其他尺寸 → 别的作品）
  const candidates = [
    r.pick,
    ...(r.pick.variants || []).filter((v) => v.url !== r.pick.url),
    ...(r.alternates || [])
  ];
  let image;
  try {
    image = await downloadImage(candidates, { log: dlog });
  } catch (error) {
    return { ok: false, message: `这张图下载失败了（${shortError(error)}），再发一次试试。` };
  }

  // 4) 压缩（electron 不可用时自动保留原图）
  const compressed = compressImage(image, {
    maxDim: s.maxDim,
    targetBytes: s.targetKb * 1024,
    log: dlog
  });

  const caption = [
    r.pick.title ? `「${String(r.pick.title).slice(0, 40)}」` : '',
    `角色：${hit.character}`,
    hasFilter ? `标签：${hit.filter}` : '',
    compressed.compressed
      ? `已压缩 ${Math.round(compressed.beforeBytes / 1024)}KB → ${Math.round(compressed.afterBytes / 1024)}KB`
      : '',
    `图源：${r.pick.credit || 'Pixivic'}`,
    r.pick.pageUrl || ''
  ].filter(Boolean).join(' · ');

  // 5) 发送（关掉 autoSend 时只检索不发送，便于排查）
  if (!s.autoSend) {
    dlog(`[调试] autoSend=false，未发送。内容：${caption}`);
    return { ok: true };
  }
  try {
    await sendImageNow(ctx, `data:${compressed.mime};base64,${compressed.buffer.toString('base64')}`,
      s.sendCaption ? caption : '');
  } catch (error) {
    dlog(`❌ 发送失败：${describeError(error)}`);
    return { ok: false, message: `图没能发出来（${shortError(error)}）。稍后再试。` };
  }

  dlog(`✅ 已发 1 张：${compressed.note}`);
  return { ok: true };
}
