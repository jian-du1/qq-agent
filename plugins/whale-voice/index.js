// whale-voice —— 鲸鱼语音：把鲸鱼的文字回复念成语音发出来。
//
// 三种模式（mode）：
//   always  —— 每次回复都附加一条语音
//   keyword —— 仅当用户消息含关键词时念
//   dual    —— 文字回复 + 语音双发
//
// TTS 引擎：
//   主：Edge-TTS（微软在线 TTS，免费、无需 key、女声自然）。默认晓伊 zh-CN-XiaoyiNeural（可爱女声）。
//   备：Windows SAPI（PowerShell 调 System.Speech，慧慧女声 Huihui）。
//
// ── 架构说明（2026-10-06 修订）─────────────────────────────────────────────
// 原设计用 after-response 钩子发语音。但 orchestrator.js 里 skillContext（line 762）
// 只有 chatKey/kind/chatId/chatName/model/provider/...，**不含 sender 也不含 onebot**；
// 而 after-response 钩子的 ctx = { ...skillContext, response, session }（line 1016）——
// 同样没有 sender/onebot。sender.js / onebot.js 也都不导出单例，插件拿不到发送通道。
// 实测：钩子能触发，但 ctx.sender 永远为 undefined，语音永远发不出去。
//
// 修复方案（任务 STEP 5 允许的回退）：
//   「If the only way to get a working sender is to register a TOOL
//     (tools' ctx does include sender) instead of using a hook,
//     then switch to that approach.」
// 工具的 ctx（orchestrator.js line 907-921）确实含 sender + onebot + chatKey。
// 因此改为「工具 + 提示词」架构：
//   1. registerTool('speak') —— 工具 ctx 有 sender，能真正发语音。
//   2. promptSections —— 按 mode（always/keyword/dual）指示模型何时调用 speak。
//   3. after-response 钩子保留为**诊断**（验证钩子确实触发），不再承担发送。
//
// ⚠️ UX 变化：原 hook 架构是"必然触发"（每次回复都念）；现 tool 架构由模型决定
//    是否调用 speak。always/dual 模式靠 promptSections 强提示模型"每次回复后必须调用"，
//    但仍取决于模型配合。这是 hook 无法发送时的必要取舍。
//
// ⚠️ 热重载：本文件全量内联（不静态 import 子模块），改完即生效。
// ⚠️ 钩子/工具永不抛错：所有异常都 try/catch + 日志，绝不影响鲸鱼的文字回复。

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

let apiRef = null;
let cfgRef = () => ({});
let firstHookLogged = false;
// 文件可见日志：api.log 走 console.log（不落盘），这里动态 import app 的 logger，
// 让诊断行写进 data/logs/qq-agent-YYYY-MM-DD.log，方便用户验证。
// 拿不到就回退到 api.log（console，至少 console 能看到）。
let appLogger = null;

const EDGE_TTS_URL = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D3845C6C32';
const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D3845C6C32';

/** 双通道日志：logger（落盘）+ api.log（console），任一失败不影响另一个。 */
function logVisible(level, msg) {
  try {
    const fn = appLogger?.[level];
    if (typeof fn === 'function') fn.call(appLogger, 'whale-voice', msg);
  } catch { /* ignore */ }
  try {
    const api = apiRef;
    const fn = level === 'warn' ? api?.warn : (level === 'error' ? api?.error : api?.log);
    fn?.(`[whale-voice] ${msg}`);
  } catch { /* ignore */ }
}

export async function setup(api = {}) {
  apiRef = api;
  if (typeof api.config === 'function') cfgRef = api.config;
  // 动态 import logger（ESM 静态 import 不能 try/catch，这里用动态 import 容错）。
  // 路径：plugins/whale-voice/ → ../../src/logger.js = resources/app/src/logger.js
  try {
    const mod = await import('../../src/logger.js');
    appLogger = mod.logger;
  } catch (e) {
    // 拿不到 logger 不影响功能，只是诊断行不落盘
    try { api.warn?.(`[whale-voice] 无法加载 app logger（诊断行将只走 console）：${e?.message ?? e}`); } catch {}
  }
  logVisible('info', '鲸鱼语音插件已加载（架构：speak 工具 + promptSections；默认音色：晓伊 zh-CN-XiaoyiNeural，可爱女声）');
  // 注册 speak 工具：工具 ctx 含 sender + onebot + chatKey（orchestrator.js line 907-921），
  // 是唯一能真正发语音的执行路径。
  api.registerTool({
    id: 'speak',
    name: '发送语音',
    category: 'messaging',
    icon: '🐋',
    description: '把文字念成语音发出来（鲸鱼说话）。调用后会把 text 合成可爱女声（默认晓伊 zh-CN-XiaoyiNeural）并发到当前会话。always/dual 模式下每次文字回复后都应调用，把刚才回复的内容作为 text；keyword 模式下用户要求语音/念出来时调用。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要念出来的文字（建议把刚才回复的正文完整传入）' }
      },
      required: ['text']
    },
    async execute(ctx, args = {}) {
      const api = apiRef;
      if (!api) return { content: '插件未就绪', isError: true };
      const cfg = getCfg();
      let text = String(args?.text ?? '').trim();
      if (!text) {
        // 兜底：模型偶尔会忘记传 text，从 session 最近一条 assistant 文本取
        const msgs = Array.isArray(ctx?.session?.messages) ? ctx.session.messages : [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const t = msgs[i]?.content;
          if (typeof t === 'string' && t.trim()) { text = t.trim(); break; }
        }
        if (!text) return { content: '未提供要念的文字（请把回复内容作为 text 参数传入）', isError: true };
      }
      logVisible('info', `speak 工具触发：text="${text.slice(0, 40)}${text.length > 40 ? '…' : ''}"（${text.length}字）；chatKey=${ctx?.chatKey || '无'}；sender=${ctx?.sender ? '有' : '无'}`);
      try {
        // 后台 TTS + 发送，不阻塞模型继续回复
        voiceSendTask(ctx, text, cfg, api).catch((e) => {
          logVisible('warn', `后台语音发送失败（已忽略，不影响文字回复）：${e?.message ?? e}`);
        });
        return { content: '语音正在合成与发送中', isError: false };
      } catch (e) {
        logVisible('warn', `speak 执行出错：${e?.message ?? e}`);
        return { content: `语音发送失败：${e?.message ?? e}`, isError: true };
      }
    }
  });
}

function getCfg() {
  const c = (typeof cfgRef === 'function' ? cfgRef() : {}) || {};
  const kwRaw = typeof c.keywordList === 'string' && c.keywordList.trim()
    ? c.keywordList : '念\n说一句\n读\n语音\n鲸鱼说\n念一下';
  const list = kwRaw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return {
    mode: c.mode === 'keyword' || c.mode === 'dual' ? c.mode : 'always',
    voice: typeof c.voice === 'string' && c.voice.trim() ? c.voice.trim() : 'zh-CN-XiaoyiNeural',
    keywordList: list.length ? list : ['念', '说一句', '读', '语音', '鲸鱼说', '念一下'],
    rate: Number.isFinite(Number(c.rate)) ? Number(c.rate) : 0,
    pitch: typeof c.pitch === 'string' && c.pitch.trim() ? c.pitch.trim() : '+0Hz',
    useSapiFallback: c.useSapiFallback !== false,
    tempDir: typeof c.tempDir === 'string' && c.tempDir.trim() ? c.tempDir.trim() : os.tmpdir(),
  };
}

/** promptSections：按模式注入提示词，指示模型何时调用 speak 工具。 */
export function promptSections(_ctx = {}) {
  const cfg = getCfg();
  if (cfg.mode === 'keyword') {
    const kws = (cfg.keywordList || []).slice(0, 8).join('、');
    return [{
      id: 'whale-voice',
      title: '鲸鱼语音',
      priority: 50,
      content: `你有语音能力（speak 工具）。当用户消息含这些词时（${kws}），在文字回复之后调用 speak 工具，把你刚才回复的正文作为 text 参数，念成语音发出来。不含这些词时不要调用。`
    }];
  }
  // always / dual：每次回复后都念
  const dual = cfg.mode === 'dual';
  return [{
    id: 'whale-voice',
    title: '鲸鱼语音',
    priority: 70,
    content: `你有语音能力（speak 工具）。每次文字回复之后，都必须调用 speak 工具，把你刚才回复的正文作为 text 参数，念成可爱女声语音发出来${dual ? '（dual 模式：文字回复保留，语音跟随）' : '（always 模式）'}。即使回复很短也要调用。`
  }];
}

// markdown / 富文本 → 纯文本（TTS 不该念出 **、#、``` 之类）
function toPlain(text) {
  let s = String(text ?? '');
  s = s.replace(/```[\s\S]*?```/g, '（代码）');
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]+\)/g, '');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.replace(/^#{1,6}\s+/gm, '');
  s = s.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  s = s.replace(/_{1,3}([^_]+)_{1,3}/g, '$1');
  s = s.replace(/^>\s?/gm, '');
  s = s.replace(/^[-*+]\s+/gm, '');
  s = s.replace(/^\d+\.\s+/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function cleanForSsml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Edge-TTS（WebSocket 实现，纯 Node 无依赖）──
function edgeTts(text, cfg, api) {
  return new Promise((resolve) => {
    const WS = globalThis.WebSocket;
    if (typeof WS !== 'function') {
      logVisible('warn', '当前运行时没有全局 WebSocket，Edge-TTS 不可用，将回退 SAPI。');
      return resolve(null);
    }
    let ws;
    try {
      try {
        // Node 22+ / Electron 的 WebSocket：第 3 参可传 options.headers
        ws = new WS(EDGE_TTS_URL, undefined, {
          headers: {
            'Origin': 'https://speech.platform.bing.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0'
          }
        });
      } catch {
        // 退回双参（浏览器形态，不支持自定义 header）
        ws = new WS(EDGE_TTS_URL);
      }
    } catch (e) {
      logVisible('warn', `Edge-TTS WebSocket 构造失败：${e?.message ?? e}`);
      return resolve(null);
    }

    const chunks = [];
    let settled = false;
    const timer = setTimeout(() => { logVisible('warn', 'Edge-TTS 超时（15s），回退 SAPI。'); finish(null); }, 15000);
    const finish = (val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      resolve(val);
    };

    const iso = () => new Date().toISOString();
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${cfg.voice}'><prosody pitch='${cfg.pitch}' rate='${cfg.rate >= 0 ? '+' : ''}${cfg.rate}%' volume='+0%'>${cleanForSsml(text)}</prosody></voice></speak>`;
    const ctxObj = { context: { synthesis: { authentication: `TrustedClientToken=${EDGE_TOKEN}` } } };

    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      const cfgMsg = `X-Timestamp:${iso()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:synthesis.context\r\n\r\n${JSON.stringify(ctxObj)}`;
      try { ws.send(cfgMsg); } catch (e) { logVisible('warn', `Edge-TTS 发送 config 失败：${e?.message ?? e}`); finish(null); return; }
      const ssmlMsg = `X-Timestamp:${iso()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:ssml\r\n\r\n${JSON.stringify({ ...ctxObj, ssml })}`;
      try { ws.send(ssmlMsg); } catch (e) { logVisible('warn', `Edge-TTS 发送 ssml 失败：${e?.message ?? e}`); finish(null); }
    };

    ws.onmessage = (ev) => {
      const d = ev?.data;
      let buf = null;
      if (d instanceof ArrayBuffer) buf = Buffer.from(d);
      else if (Buffer.isBuffer(d)) buf = d;
      else if (d && typeof d === 'object' && d.byteLength) buf = Buffer.from(d);
      if (buf) {
        const marker = Buffer.from('Path:audio\r\n');
        const idx = buf.indexOf(marker);
        if (idx >= 0) chunks.push(buf.subarray(idx + marker.length));
        return;
      }
      if (typeof d === 'string') {
        if (d.includes('Path:turn.end')) {
          if (!chunks.length) { logVisible('warn', 'Edge-TTS 结束但无音频数据，回退 SAPI。'); finish(null); return; }
          finish(Buffer.concat(chunks));
          return;
        }
        if (/Path:response\.(error|fail)/i.test(d)) {
          logVisible('warn', `Edge-TTS 返回错误：${d.slice(0, 200)}`);
        }
      }
    };

    ws.onerror = (e) => { logVisible('warn', `Edge-TTS WebSocket 错误：${e?.message ?? 'unknown'}`); finish(null); };
    ws.onclose = () => { if (!settled) finish(chunks.length ? Buffer.concat(chunks) : null); };
  });
}

// ── Windows SAPI（PowerShell 调 System.Speech）──
function sapiTts(text, cfg, api) {
  return new Promise((resolve) => {
    const outPath = path.join(cfg.tempDir, `whale-voice-sapi-${randomUUID()}.wav`);
    const safeText = String(text).replace(/'/g, "''").replace(/\r?\n/g, ' ').slice(0, 4000);
    const safePath = outPath.replace(/'/g, "''");
    const sapiRate = Math.max(-10, Math.min(10, cfg.rate / 10));
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $s.SelectVoice('Microsoft Huihui Desktop') } catch {}; $s.Rate = ${sapiRate}; $s.SetOutputToWaveFile('${safePath}'); $s.Speak('${safeText}'); $s.Dispose()`;
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { logVisible('warn', `SAPI 启动 PowerShell 失败：${e?.message ?? e}`); resolve(null); });
    child.on('close', (code) => {
      if (code !== 0 || !existsSync(outPath)) { logVisible('warn', `SAPI 合成失败（code=${code}）${err.slice(0, 200)}`); resolve(null); return; }
      resolve({ filePath: outPath, format: 'wav' });
    });
  });
}

// ── TTS 主入口：先 Edge-TTS，失败回退 SAPI ──
async function tts(text, cfg, api) {
  const plain = toPlain(text);
  if (!plain.trim()) return null;

  try {
    const mp3 = await edgeTts(plain, cfg, api);
    if (mp3 && mp3.length) {
      const filePath = path.join(cfg.tempDir, `whale-voice-${randomUUID()}.mp3`);
      await fs.writeFile(filePath, mp3);
      return { filePath, format: 'mp3' };
    }
  } catch (e) {
    logVisible('warn', `Edge-TTS 异常：${e?.message ?? e}`);
  }

  if (cfg.useSapiFallback) {
    try {
      const r = await sapiTts(plain, cfg, api);
      if (r) return r;
    } catch (e) {
      logVisible('warn', `SAPI 异常：${e?.message ?? e}`);
    }
  }

  return null;
}

// 后台执行：TTS + 发送 + 清理（speak 工具的 ctx 含 sender + chatKey）
async function voiceSendTask(ctx, text, cfg, api) {
  let tempFile = null;
  try {
    const result = await tts(text, cfg, api);
    if (!result) { logVisible('warn', '语音合成失败（Edge-TTS 与 SAPI 均不可用），跳过语音，不影响文字回复。'); return; }
    tempFile = result.filePath;

    const sender = ctx?.sender;
    const chatKey = ctx?.chatKey;
    if (!sender || typeof sender.sendMedia !== 'function') {
      logVisible('warn', `speak 工具：ctx 缺 sender（sender=${sender ? '有' : '无'}），语音已合成但无法发送。`);
      return;
    }
    if (!chatKey) {
      logVisible('warn', 'speak 工具：ctx 缺 chatKey，跳过语音发送。');
      return;
    }
    await sender.sendMedia(chatKey, [{ type: 'record', data: { file: tempFile } }], { label: '语音' });
    logVisible('info', `语音已发送：${path.basename(tempFile)}（${result.format}，音色 ${cfg.voice}）`);
  } finally {
    if (tempFile) {
      const f = tempFile;
      // 延迟删除，给 NapCat/Lagrange 足够时间读取文件上传
      setTimeout(() => { try { fs.unlink(f).catch(() => {}); } catch {} }, 60000);
    }
  }
}

// ── after-response 钩子：仅诊断，不再承担发送 ──
// ctx 无 sender/onebot（orchestrator.js skillContext 不含这两项），发不了语音。
// 保留这条钩子是为了让用户能在日志里**验证钩子确实触发**（原 hook 架构的"不发"问题
// 不是钩子没触发，而是触发后 ctx.sender 为 undefined）。发送改由 speak 工具承担。
export const hooks = {
  'after-response': async (ctx) => {
    if (!firstHookLogged) {
      firstHookLogged = true;
      const keys = Object.keys(ctx || {}).join(',');
      const hasSender = ctx?.sender ? '有' : '无';
      const chatKey = ctx?.chatKey || ctx?.session?.chatKey || '无';
      logVisible('info', `after-response 触发；ctx 键=${keys}；sender=${hasSender}；chatKey=${chatKey}（钩子 ctx 无 sender，发送由 speak 工具承担）`);
    }
    try {
      // 钩子永不抛错：哪怕诊断行失败也不影响文字回复
    } catch (e) {
      try { logVisible('warn', `after-response 钩子异常（已忽略）：${e?.message ?? e}`); } catch {}
    }
  }
};

export function dispose() { /* 无长驻状态，WebSocket 已在 edgeTts 内部关闭 */ }
