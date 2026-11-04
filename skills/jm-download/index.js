// 禁漫漫画下载（jm-suomingor）—— 异步任务版
// ---------------------------------------------------------------------------
// 类型：**技能**（LLM 型），放 skills/。插件注册的工具不会进模型的工具列表，
// 只有 skills/ 里的模块才有这待遇（doc/extend_development/plugin-development.md 第 6 节）。
//
// 一次请求的完整链路（全部异步，不阻塞模型回合）：
//   群友发 jm123456
//     └─ 钩子识别 ID → 提示模型调用工具
//          └─ 工具：权限校验 → 入队 → **立即返回**（模型马上能继续说话）
//               └─ 后台任务：
//                    ① engine 下载原图（纯 Node，零依赖）
//                    ② 现查 scramble_id
//                    ③ pdf.js → Python+Pillow 还原竖切并合成 PDF（可选增强）
//                    ④ upload.js 上传到「提出请求的那个会话」
//                    ⑤ 发消息汇报；记录留痕，失败可见
//
// 设计取舍（都踩过坑，写下来免得以后改错）：
//   · 不在模型回合里同步下载：一本 300 页要几十秒到几分钟，会把模型请求挂住、
//     白烧 token，还可能撞上大模型调用超时（群友连发几本直接卡死）。
//   · 工具的 execute(ctx) 里**没有** triggerEntries，所以"谁在下指令"只能靠
//     before-tool 钩子里记下来的 callerLog（文档 skill-development.md 第 5 节）。
//   · 任务持久化到 data/<技能 id>/tasks.json：热重载/重启后仍能看到历史与失败记录。
//   · 所有 catch 都打日志：静默吞异常会让"装好了没反应"变成无头案。
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as engine from './engine.js';
import * as pdfBridge from './pdf.js';
import { uploadFile, groupQuota, deleteGroupFile, humanSize } from './upload.js';
// 加密 ZIP 打包（2026-10-23）：PDF 合成后先打成 .zip 再上传，可选密码。
import { createZip, buildZipName } from './zip.js';
// 每日更新采集器（2026-10-06）：collect 给 cron 用，digest 给「更新JM」工具用
import { collect as collectDaily, buildDigestFromState, sendDigest, loadDigestItems, renderDigestImage, sendDigestImage, renderAlbumImage, cleanTitle, fetchSiteCover } from './daily_updates.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TASKS_FILE = () => path.join(downloadRoot(), 'tasks.json');

// ───────────────────── 技能 id（不要硬编码！）─────────────────────
// 宿主用 **skill.json 的 id** 给工具加前缀，并截到 24 字符：
//     toolId = `<skill.json 的 id>__<工具名>`
// 所以提示词/钩子里让模型"调用哪个工具"的字符串必须由这个 id 算出来，
// 否则一改 id（例如市场里重名被迫换名）模型就会去调用不存在的工具。
// 数据目录同理，跟着 id 走 —— 换 id 不会串到别的技能的存档里。
const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ID = (() => {
  // 以 skill.json 为准；读不到就退回目录名（市场安装时目录名 = id）
  try {
    const id = String(JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'skill.json'), 'utf8'))?.id || '').trim();
    if (/^[a-z0-9][a-z0-9._-]*$/.test(id)) return id;
  } catch { /* 落到目录名 */ }
  return path.basename(SKILL_DIR) || 'jm-suomingor';
})();
const DATA_SUBDIR = SKILL_ID;
/** 拼出带前缀的真实工具 id，例如 toolId('download_album')。 */
const toolId = (name) => `${SKILL_ID}__${name}`;

// ───────────────────────── 模块级状态 ─────────────────────────
// ⚠️ 热重载会重新 import 本文件，这些变量会被重置（正常行为）。

let api = null;
const activeTasks = new Map(); // albumId -> task
  // ── 任务队列（2026-10-15 改）────────────────────────────────────────────
  // 原来：每个会话只允许一本在跑，第二条车牌直接被拒；对话一结束，模型也不会再补交
  // 后面的 —— 结果"一次发多个链接 = 只下第一个"。
  // 现在：所有牌子先进这个有序队列，单个 worker 一本一本跑；对话结不结束都照跑，
  // 进程重启后从磁盘把没跑完的接着跑。
  const taskQueue = [];        // 待处理 albumId（有序）
  let queueBusy = false;       // 是否已有 worker 在跑

  const queueFile = () => path.join(downloadRoot(), 'queue.json');

  /** 队列落盘（只存可序列化字段；sender/onebot 重启后重取） */
  function saveQueue() {
    try {
      fs.mkdirSync(downloadRoot(), { recursive: true });
      const items = taskQueue.map((id) => {
        const t = activeTasks.get(id) || {};
        return { albumId: id, chatKey: t.chatKey || '', kind: t.kind || '', who: t.who || '', whoName: t.whoName || '', addedAt: t.addedAt || Date.now() };
      });
      fs.writeFileSync(queueFile(), JSON.stringify(items, null, 1), 'utf8');
    } catch (error) { warn(`队列落盘失败（不影响运行）：${error?.message ?? error}`); }
  }

  /** 启动时把没跑完的队列读回来 */
  function loadQueue() {
    try {
      if (!fs.existsSync(queueFile())) return 0;
      const items = JSON.parse(fs.readFileSync(queueFile(), 'utf8'));
      let n = 0;
      for (const it of (Array.isArray(items) ? items : [])) {
        const albumId = String(it?.albumId || '').trim();
        if (!/^\d{5,9}$/.test(albumId) || activeTasks.has(albumId)) continue;
        activeTasks.set(albumId, {
          albumId, chatKey: String(it.chatKey || ''), kind: String(it.kind || ''),
          who: String(it.who || ''), whoName: String(it.whoName || ''),
          control: { paused: false, deleted: false, child: null },
          stage: 'queued', startedAt: Date.now(), addedAt: Number(it.addedAt) || Date.now(),
          sender: null, onebot: null,
        });
        taskQueue.push(albumId);
        n++;
      }
      if (n) log(`队列恢复：接回 ${n} 本没跑完的（${taskQueue.map((i) => 'JM' + i).join('、')}）`);
      return n;
    } catch (error) { warn(`队列恢复失败：${error?.message ?? error}`); return 0; }
  }

  /** 单个 worker：取队首跑，跑完接着下一个 */
  async function pump() {
    if (queueBusy) return;
    const nextId = taskQueue[0];
    if (!nextId) { saveQueue(); return; }
    queueBusy = true;
    const task = activeTasks.get(nextId);
    try {
      taskQueue.shift();
      if (!task || task.control?.deleted) { activeTasks.delete(nextId); return; }
      task.stage = 'running';
      task.startedAt = Date.now();
      if (!task.onebot) task.onebot = currentOnebotRef;
      log(`开始处理队列任务 JM${nextId}（队列里还剩 ${taskQueue.length} 本）`);
      saveQueue();
      await runJob(task);
    } catch (error) {
      if (!task?.control?.deleted) warn(`排队任务异常（已记录）JM${nextId}：${error?.stack ?? error}`);
    } finally {
      activeTasks.delete(nextId);
      if (task?.chatKey && activeByChat.get(task.chatKey) === nextId) activeByChat.delete(task.chatKey);
      queueBusy = false;
      saveQueue();
      void cleanupGroupFiles();
      if (taskQueue.length) void pump();
    }
  }

  /** 说明：一次一个 ID。多个车牌由模型分多次调用，全部进同一队列 */
const activeByChat = new Map(); // chatKey -> albumId（每个会话同时只跑一本）
const callerLog = new Map(); // sessionId/chatKey -> { candidates, at }
const pendingHint = new Map(); // sessionId/chatKey -> { id, who, at }

// 「今日JM」指令命中标记：sessionId/chatKey -> { who, at }
const pendingToday = new Map();
// 「更新JM」指令命中标记：sessionId/chatKey -> { who, at }
const pendingUpdate = new Map();
// 「开启JM/关闭JM」群开关指令命中标记：sessionId/chatKey -> { action, who, at }
const pendingGroupCmd = new Map();
const controlRequests = new Map(); // session/chat -> { action, id, who, at }
const firstSubmitters = new Map(); // `${chatKey}:${albumId}` -> { id, name, at }

// 2026-10-06：原来是一张手写的 152 字对照表，实测漏得很厉害 ——
//   獵奇/女僕裝/項圈/妖精/蓮/潛/別/檔 全都转不过来，群友看到的还是繁体。
// 现在用 OpenCC（npm 包 opencc-js，1.4.2）做真正的繁转简；
// 装不上时自动退回下面那张小表，保证功能不因缺依赖而挂掉。
let openccConvert = null;
try {
  const OpenCC = await import('opencc-js');
  const factory = OpenCC.Converter || OpenCC.default?.Converter;
  if (factory) {
    // tw→cn 比 t→cn 更贴合站点上的台湾用语（例：裡→里、妳→你）
    openccConvert = factory({ from: 'tw', to: 'cn' });
  }
} catch (error) {
  console.warn(`[jm-suomingor] opencc-js 不可用，退回内置小表：${error?.message ?? error}`);
}

const TRAD_TO_SIMP = new Map(Object.entries({
  '麗':'丽','組':'组','藝':'艺','體':'体','語':'语','譯':'译','畫':'画','圖':'图','書':'书','學':'学','術':'术','與':'与','為':'为','這':'这','個':'个','們':'们','來':'来','發':'发','後':'后','過':'过','點':'点','時':'时','間':'间','長':'长','開':'开','關':'关','門':'门','風':'风','雲':'云','電':'电','腦':'脑','愛':'爱','夢':'梦','薔':'蔷','壞':'坏','專':'专','傳':'传','說':'说','從':'从','將':'将','對':'对','於':'于','無':'无','萬':'万','號':'号','臺':'台','裏':'里','貓':'猫','鳥':'鸟','龍':'龙','劍':'剑','戰':'战','勝':'胜','敗':'败','強':'强','經':'经','濟':'济','線':'线','網':'网','區':'区','頁':'页','會':'会','讓':'让','實':'实','現':'现','應':'应','該':'该','種':'种','樣':'样','頭':'头','見':'见','聽':'听','讀':'读','寫':'写','舊':'旧','簡':'简','單':'单','處':'处','係':'系','還':'还','沒':'没','帶':'带','絕':'绝','極':'极','視':'视','覺':'觉','氣':'气','陰':'阴','陽':'阳','獸':'兽','兒':'儿','兩':'两','內':'内','劃':'划','劉':'刘','廣':'广','東':'东','滿':'满','給':'给','華':'华','麥':'麦','黃':'黄','聖':'圣','騎':'骑','機':'机','貝':'贝','類':'类','館':'馆','醫':'医','藥':'药','練':'练','緩':'缓','難':'难','雜':'杂','親':'亲','遠':'远','違':'违','導':'导','響':'响','繪':'绘','訂':'订','閱':'阅','價':'价','錢':'钱','貴':'贵','賣':'卖','買':'买','顯':'显','標':'标','題':'题','記':'记','錄':'录','總':'总','結':'结','預':'预','備':'备','運':'运','動':'动','際':'际','稱':'称','則':'则','復':'复','製':'制','續':'续','斷':'断','業':'业','創':'创','作':'作','漢':'汉','測':'测','試':'试','繁':'繁',
}));

function toSimplified(value) {
  const text = String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (openccConvert) {
    try { return openccConvert(text); } catch { /* 退回小表 */ }
  }
  return [...text].map((ch) => TRAD_TO_SIMP.get(ch) || ch).join('');
}

function controlKey(ctx) { return callerKey(ctx); }

// ───────────────────── 日语标题翻译（2026-10-06）─────────────────────
// 群友要求"本子的名字也翻译"。繁→简用 OpenCC 就够，但日语标题（例：
// 「ホモであることを認めない系男子」）需要真正的翻译，只能走模型。
//
// 设计要点：
//   · 结果**按原文缓存到磁盘**（jp-cache.json）。同一本子只翻一次，
//     列表每次刷新不会重复烧 token —— 否则「今日JM」一点就是几十次调用。
//   · 只在标题**确实含假名**时才翻。纯中文/纯英文标题直接跳过（省钱且更快）。
//   · 批量翻（一次请求多本），翻译失败不影响主流程，退回原文。
//   · 翻完写回 metadata.json，下次主流程直接读译文，不用再调模型。
const KANA_RE = /[\u3040-\u309f\u30a0-\u30ff]/;
const JP_CACHE_FILE = () => path.join(APP_ROOT, 'data', DATA_SUBDIR, 'jp-cache.json');
let jpCache = null;
let jpCacheLoaded = false;

async function loadJpCache() {
  if (jpCacheLoaded) return jpCache;
  try {
    jpCache = JSON.parse(await fsp.readFile(JP_CACHE_FILE(), 'utf8'));
  } catch { jpCache = {}; }
  jpCacheLoaded = true;
  return jpCache;
}

async function saveJpCache() {
  try {
    await fsp.mkdir(path.dirname(JP_CACHE_FILE()), { recursive: true });
    await fsp.writeFile(JP_CACHE_FILE(), JSON.stringify(jpCache, null, 2), 'utf8');
  } catch (error) {
    warn(`日语翻译缓存写入失败：${error?.message ?? error}`);
  }
}

const hasKana = (s) => KANA_RE.test(String(s || ''));

/** 读 agent 的全局模型配置（技能自己的 cfg() 里没有 API key）。 */
function agentModelConfig() {
  try {
    // 2026-10-15 修：原来固定读 APP_ROOT/data/config.json —— 那是技能自己的数据目录，
    // 全局配置其实在安装根的 data/（或 QQ_AGENT_DATA_DIR 指向处），所以这个读取一直 ENOENT，
    // 日语翻译等功能一直处于「没有可用的模型配置」状态。
    const cfgCandidates = [
      process.env.QQ_AGENT_DATA_DIR ? path.join(process.env.QQ_AGENT_DATA_DIR, 'config.json') : '',
      path.resolve(APP_ROOT, '..', '..', 'data', 'config.json'),
      path.join(APP_ROOT, 'data', 'config.json'),
    ].filter(Boolean);
    const cfgPath = cfgCandidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (!cfgPath) throw new Error('找不到全局配置 config.json（试过：' + cfgCandidates.join(' / ') + '）');
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const c = JSON.parse(raw);
    const p = c?.api || {};
    const pid = p.provider;
    const key = (c?.dshProviderKeys || {})[pid] || p.apiKey || '';
    return { baseUrl: p.baseUrl || '', apiKey: key || '', model: p.model || '' };
  } catch (error) {
    warn(`读取全局模型配置失败：${error?.message ?? error}`);
    return { baseUrl: '', apiKey: '', model: '' };
  }
}

/** 调模型批量翻译日文标题。返回 { 原文: 译文 }。失败返回空对象。 */
async function translateTitles(texts) {
  const c = cfg();
  if (c.translateTitles === false) return {};
  const list = [...new Set(texts.filter((t) => t && hasKana(toSimplified(t))))];
  if (!list.length) return {};

  // 技能设置可覆盖；没配就用 agent 的全局模型
  const g = agentModelConfig();
  const baseUrl = String(c.translateBaseUrl || g.baseUrl || '').replace(/\/$/, '');
  const apiKey = c.translateApiKey || g.apiKey;
  const model = c.translateModel || g.model;
  if (!baseUrl || !apiKey || !model) {
    warn('日语翻译跳过：没有可用的模型配置');
    return {};
  }

  const prompt = [
    '把下面每条日文漫画标题翻译成简体中文。规则：',
    '1. 只翻译日文部分，已有的中文/英文/罗马音原样保留',
    '2. 方括号 [] 里通常是作者、社团、汉化组名 —— **原样保留，不要翻译**',
    '3. 圆括号 () 里的作品名（如 ブルーアーカイブ）用中文常用译名（蔚蓝档案）',
    '4. 逐行输出，格式严格为「序号|译文」，不要编号以外的任何解释',
    '',
    ...list.map((t, i) => `${i + 1}. ${t}`),
  ].join('\n');

  const out = {};
  // ⚠️ max_tokens 必须给足：deepseek-v4.1-flash 这类"推理型"模型会先花
  //    1200+ token 做思考，然后才输出正文。给 320 的话预算全被思考吃掉，
  //    content 直接是空的 —— 表现就是"翻译静默失败、标题还是日文"。
  //    实测：max_tokens=320 → content 空；1500 / 3000 → 正常。
  const maxTokens = Math.max(2048, 1600 + list.length * 150);
  // 中转站网关会偶发 502/504（不是我们的问题），重试几次就好
  const ATTEMPTS = 3;
  let lastError = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(120000),
      });
      const text = await res.text();
      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
      }
      const parsed = JSON.parse(text);
      const choice = parsed?.choices?.[0];
      const content = choice?.message?.content || '';
      // content 为空时别静默吞掉 —— 绝大多数情况是 max_tokens 被"思考"吃光了
      if (!content.trim()) {
        const reasoning = parsed?.usage?.completion_tokens_details?.reasoning_tokens;
        throw new Error(`模型没返回正文（finish=${choice?.finish_reason}，思考用了 ${reasoning ?? '?'} token，max_tokens=${maxTokens}）`);
      }
      for (const line of content.split('\n')) {
        const m = line.match(/^\s*(\d+)\s*[|｜]\s*(.+?)\s*$/);
        if (!m) continue;
        const idx = Number(m[1]) - 1;
        if (idx >= 0 && idx < list.length) out[list[idx]] = m[2].trim();
      }
      log(`日语标题翻译完成：${Object.keys(out).length}/${list.length} 条（第 ${attempt} 次尝试）`);
      return out;
    } catch (error) {
      lastError = error?.message ?? String(error);
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 1200 * attempt));
    }
  }
  warn(`日语标题翻译失败（已试 ${ATTEMPTS} 次，退回原文）：${lastError}`);
  return out;
}

/**
 * 给一批标题补译文。会读写磁盘缓存，并把译文回填到传入的对象上。
 * 任何一步失败都不抛错 —— 翻译只是锦上添花，绝不能拖垮下载/列表。
 */
async function ensureTranslatedTitles(items) {
  // items: [{ key, title, apply(translated) }]
  try {
    const cache = await loadJpCache();
    const need = [];
    for (const it of items) {
      const t = String(it.title || '').trim();
      if (!t || !hasKana(t)) continue;
      if (cache[t]) { it.apply(cache[t]); continue; }
      need.push(t);
    }
    if (!need.length) return;
    // 一次最多翻 25 条，避免 prompt 过大
    const fresh = await translateTitles(need.slice(0, 25));
    let changed = false;
    for (const [src, dst] of Object.entries(fresh)) {
      if (dst && dst !== src) { cache[src] = dst; changed = true; }
    }
    if (changed) await saveJpCache();
    for (const it of items) {
      const t = String(it.title || '').trim();
      if (cache[t]) it.apply(cache[t]);
    }
  } catch (error) {
    warn(`标题翻译流程出错（忽略）：${error?.message ?? error}`);
  }
}

function parseControl(text) {
  const raw = String(text || '').replace(/@\S+\s*/g, '').trim();
  const m = raw.match(/^(暂停下载|继续下载|删除\s*JM)\s*[-_:#：]?\s*(?:JM)?(\d{2,9})$/i);
  if (!m) return null;
  return { action: m[1].startsWith('暂停') ? 'pause' : m[1].startsWith('继续') ? 'resume' : 'delete', id: engine.normalizeAlbumId(m[2]) };
}

function isPaused(task) { return task?.control?.paused === true; }
async function waitIfPaused(task) {
  if (!task?.control) return;
  while (task.control.paused && !task.control.deleted) await new Promise((resolve) => setTimeout(resolve, 800));
  if (task.control.deleted) throw new Error('任务已被删除，停止处理');
}

function ensureAlive(task) {
  if (task?.control?.deleted) throw new Error('任务已被删除，停止处理');
}

/** 找一个本子的本地目录（jm-<id>/ 下唯一子目录）。 */
async function albumDirOf(albumId) {
  const base = path.join(downloadRoot(), `jm-${albumId}`);
  try {
    const subs = (await fsp.readdir(base, { withFileTypes: true })).filter((e) => e.isDirectory());
    if (subs.length === 1) return path.join(base, subs[0].name);
    if (!fs.existsSync(base)) return '';
    return base;
  } catch {
    return '';
  }
}

/** 删除本子的本地目录。 */
async function removeLocalAlbum(albumId) {
  const base = path.join(downloadRoot(), `jm-${albumId}`);
  if (!fs.existsSync(base)) return { ok: true, removed: 0, freed: 0 };
  const before = await dirSize(base).catch(() => ({ bytes: 0, files: 0 }));
  await fsp.rm(base, { recursive: true, force: true });
  return { ok: true, removed: before.files, freed: before.bytes };
}

/** 删除这个本子之前上传到群里的文件（按文件名前缀匹配，跨重启也尽量能删）。 */
async function removeGroupFiles(albumId, onebot, chatKey) {
  const results = [];
  if (!onebot) return results;
  const groups = [...uploadedGroupFiles.entries()].filter(([, item]) => {
    const key = String(item?.chatKey || '');
    return (!chatKey || key === String(chatKey)) && String(item?.name || '').startsWith(`JM${albumId}`);
  });
  for (const [key, item] of groups) {
    uploadedGroupFiles.delete(key);
    const [, groupId] = String(item.chatKey).split(':');
    const r = await deleteGroupFile(onebot, groupId, item.fileId);
    results.push({ name: item.name, ok: r.ok });
  }
  return results;
}

/**
 * 执行一条控制指令。返回要发到会话里的文本。
 * @param {object} opts { action, albumId, onebot, chatKey }
 */
async function performControl({ action, albumId, onebot, chatKey }) {
  const task = activeTasks.get(albumId);
  if (action === 'pause') {
    if (!task) return `JM${albumId} 当前没有正在处理的任务，不用暂停。`;
    if (task.control?.paused) return `JM${albumId} 本来就处于暂停状态。`;
    if (!task.control) task.control = { paused: false, deleted: false, child: null };
    task.control.paused = true;
    task.control.pausedAt = Date.now();
    log(`JM${albumId} 已暂停（群指令）`);
    return `⏸ JM${albumId} 已暂停下载。发「继续下载 JM${albumId}」就能接着跑。`;
  }
  if (action === 'resume') {
    if (!task) return `JM${albumId} 当前没有正在处理的任务。`;
    if (!task.control?.paused) return `JM${albumId} 没有暂停，正在正常处理。`;
    task.control.paused = false;
    log(`JM${albumId} 已继续（群指令）`);
    return `▶️ JM${albumId} 已继续下载，接着刚才的进度跑。`;
  }
  // delete：终止任务 + 杀掉 Python 子进程 + 删本地目录 + 尽量删已传的群文件
  const wasActive = Boolean(task);
  if (task) {
    if (!task.control) task.control = { paused: false, deleted: false, child: null };
    task.control.paused = false; // 先解除暂停，让等待循环能退出
    task.control.deleted = true;
    { const qi = taskQueue.indexOf(task.albumId); if (qi >= 0) taskQueue.splice(qi, 1); saveQueue(); }
try { task.control.child?.kill('SIGKILL'); } catch { /* ignore */ }
  }
  // 本地目录：先删图片目录里的独立子目录，再兜底删 jm-<id> 根
  const dir = await albumDirOf(albumId);
  let local = { ok: false, removed: 0, freed: 0 };
  if (dir) {
    try {
      local = await removeLocalAlbum(albumId);
    } catch (error) {
      warn(`删除本地目录失败 JM${albumId}：${error?.message ?? error}`);
    }
  }
  let groupResults = [];
  try {
    groupResults = await removeGroupFiles(albumId, onebot, chatKey);
  } catch (error) {
    warn(`删除群文件失败 JM${albumId}：${error?.message ?? error}`);
  }
  taskHistory = taskHistory.filter((h) => String(h.id) !== String(albumId)).concat(
    taskHistory.filter((h) => String(h.id) === String(albumId)).map((h) => ({ ...h, ok: false, stage: 'deleted', error: '群指令删除' })),
  ).slice(0, 50);
  void saveHistory();
  log(`JM${albumId} 已删除（群指令）：本地 ${local.removed} 个文件，群文件 ${groupResults.length} 个`);
  // 精简：只说"删干净了"，不报文件个数/释放多少空间这类细节
  const parts = [
    `🗑 JM${albumId} 已删除`,
    local.removed ? '本地文件已清理' : '',
    groupResults.length ? `群文件已删 ${groupResults.filter((r) => r.ok).length}/${groupResults.length} 个` : '',
  ].filter(Boolean);
  return parts.join('，') + '。';
}


// 「今日JM」触发词：今日JM / 今天的JM / 今天有啥JM / JM列表 / 禁漫列表 等常见说法
const TODAY_JM_RE = /^(?:(?:今日|今天|本日)\s*(?:的|有(?:啥|什么|哪些))?\s*)?(?:JM|jm|Jm|禁漫|本子)\s*(?:列表|清单|目录|有哪些|有啥|有什么|都有啥|都有什么)?$/;
// 「更新JM」触发词：更新JM / JM更新 / 更新列表 / 今日更新 / 今天有什么更新 / 日更 等
// 注意与「今日JM」（本地书架）区分：这里匹配的是「更新」字样（站点当日新上架/新章节）
const UPDATE_JM_RE = /^(?:(?:今日|今天|本日|最近|最新)\s*(?:的)?\s*)?(?:JM|jm|Jm|禁漫|本子)?\s*(?:更新|日更|新更)(?:列表|清单|目录|了|有啥|有什么|有哪些|啥)?(?:JM|jm|Jm|禁漫|本子)?$/;
let taskHistory = []; // 最近的任务记录（持久化）
let historyLoaded = false;
let cleanupTimer = null;
let workerCache = { at: 0, result: null };

// ───────────────────────── 配置 ─────────────────────────

function num(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function cfg() {
  const c = api?.config?.() || {};
  return {
    enabled: c.enabled !== false,
    downloadDir: String(c.downloadDir ?? '').trim(),
    domains: String(c.domains ?? '').trim(),
    maxPages: num(c.maxPages, 500, 1, 5000),
    multiChapter: c.multiChapter !== false,
    concurrency: num(c.concurrency, 4, 1, 8),
    timeoutSeconds: num(c.timeoutSeconds, 30, 5, 300),
    restore: c.restore !== false,
    outputFormat: String(c.outputFormat || 'pdf').toLowerCase() === 'images' ? 'images' : 'pdf',
    deleteImagesAfterPdf: c.deleteImagesAfterPdf === true,
    pdfQuality: num(c.pdfQuality, 85, 30, 95),
    pdfMaxDim: num(c.pdfMaxDim, 0, 0, 6000),
    uploadMode: ['off', 'request', 'group', 'private'].includes(String(c.uploadMode))
      ? String(c.uploadMode)
      : 'request',
    rejectOversize: c.rejectOversize === true,
    maxUploadMB: num(c.maxUploadMB, 600, 1, 4096),
    checkQuota: c.checkQuota !== false,
    // ── 加密压缩包（2026-10-23）──────────────────────────────────────────
    // 成品 PDF 会先打成 zip 再上传；是否打包、是否加密、密码是否写进文件名，都由这四项决定。
    zipEnabled: c.zipEnabled !== false,
    zipPasswordEnabled: c.zipPasswordEnabled === true,
    zipPassword: String(c.zipPassword ?? '').trim(),
    zipPasswordInName: c.zipPasswordInName !== false,
    allowIds: String(c.allowIds ?? '').trim(),
    // PDF 成品缓存按小时控制；默认 12 小时，支持同一个 @JMXXX 重复请求时直接重发。
    keepHours: num(c.keepHours, 12, 0, 24 * 365),
    // ── 本地成品复用（2026-10-10 本地新增）────────────────────────────────
    // 与 keepHours 的分工：
    //   · keepHours      = 「刚下完的成品」快速通道，只认 **PDF** 且只在 N 小时内有效，
    //                      过期就重新下载 —— 这是原版行为。
    //   · localReuseDays = 「本地已有的这本」更宽的复用：**不限文件类型**（PDF 或纯图片目录
    //                      都算）、N 天内下过就直接发，不再联网下载。
    // 为什么需要后者（原版缺失导致的功能回退）：
    //   本子内容不会变，下过一次就一直有效。而 keepHours 只管 12 小时 ——
    //   12 小时后再要同一本，哪怕 139MB 就在磁盘上躺着，也会**重新下载一整本**。
    //   更糟的是 outputFormat=images 时（只存图不合成 PDF），findCachedPdf 永远不命中，
    //   于是每次请求都重下。旧版 jm-comic 有这套"本地已有就直接发"的逻辑，本版没有。
    //
    // ⚠️ 默认 **0（关闭）**，要显式打开才生效。理由：这套复用的判定比 keepHours 宽得多，
    //    开着会让"同一个 ID 必定重新下载"的既有假设失效 —— 自检里就有多个场景
    //    共用同一个临时下载目录、靠"每次都重新下载"来隔离，默认打开会让它们互相污染
    //    （实测 59 项里 5 项因此失败）。所以：代码默认保守，需要的人在设置里开。
    //    使用者本机已在 config 里设为 30。
    localReuseDays: num(c.localReuseDays, 0, 0, 3650),
    keepDays: num(c.keepDays, 0, 0, 365),
    groupFileKeepDays: num(c.groupFileKeepDays, 0, 0, 365),
    pythonPath: String(c.pythonPath ?? '').trim(),
    progress: c.progress !== false,
    // 日语标题翻译（2026-10-06）：默认开；可关掉避免烧 token
    translateTitles: c.translateTitles !== false,
    translateBaseUrl: String(c.translateBaseUrl ?? '').trim(),
    translateApiKey: String(c.translateApiKey ?? '').trim(),
    translateModel: String(c.translateModel ?? '').trim(),
    proxy: String(c.proxy ?? '').trim(),
  };
}

/** 下载根目录：优先配置，其次 resources/app/data/<技能 id>。 */
function downloadRoot() {
  return cfg().downloadDir || path.join(APP_ROOT, 'data', DATA_SUBDIR);
}


/** 在 keepHours 内复用已有 PDF；命中后每次请求都会重新发送。 */
async function findCachedPdf(albumId, keepHours) {
  const hours = Number(keepHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  const base = path.join(downloadRoot(), `jm-${albumId}`);
  const cutoff = Date.now() - hours * 3600000;
  const found = [];
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf') {
        try {
          const st = await fsp.stat(full);
          if (st.size > 1024 && st.mtimeMs >= cutoff) {
            found.push({ path: full, dir: path.dirname(full), mtimeMs: st.mtimeMs, bytes: st.size });
          }
        } catch {}
      }
    }
  }
  await walk(base);
  if (!found.length) return null;
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const hit = found[0];
  let meta = {};
  try { meta = JSON.parse(await fsp.readFile(path.join(hit.dir, 'metadata.json'), 'utf8')); } catch {}
  return { ...hit, meta };
}

/**
 * 本地成品复用（2026-10-10 本地新增，见配置里 localReuseDays 的说明）。
 *
 * 与 findCachedPdf 的区别：
 *   · 不限时间窗（用 localReuseDays，默认 30 天，比 keepHours 的 12 小时宽得多）
 *   · **不限文件类型** —— 目录里有 PDF 就发 PDF；只有图片（outputFormat=images，
 *     或开了「合成 PDF 后删除原图」以外的情况）就把图片目录原样当作成品
 *   · 会读 metadata.json 补齐书名/作者/标签，让汇报文字和简介卡都正常
 *
 * @returns {Promise<null | {kind:'pdf'|'images', path:string, dir:string, bytes:number, meta:object, files?:string[]}>}
 */
async function findLocalArtifact(albumId, reuseDays) {
  const days = Number(reuseDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  const base = path.join(downloadRoot(), `jm-${albumId}`);
  if (!fs.existsSync(base)) return null;
  const cutoff = Date.now() - days * 86400000;

  const pdfs = [];
  const images = [];
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      let st;
      try { st = await fsp.stat(full); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      if (ext === '.pdf' && st.size > 1024) pdfs.push({ path: full, dir: path.dirname(full), mtimeMs: st.mtimeMs, bytes: st.size });
      else if (['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'].includes(ext) && st.size > 1024) {
        images.push({ path: full, mtimeMs: st.mtimeMs, bytes: st.size });
      }
    }
  }
  await walk(base);

  // metadata.json 在 jm-<id>/ 根或子目录里，两处都找一下
  let meta = {};
  for (const cand of [path.join(base, 'metadata.json'), path.join(await albumDirOf(albumId), 'metadata.json')]) {
    try { meta = JSON.parse(await fsp.readFile(cand, 'utf8')); break; } catch { /* 继续找 */ }
  }

  // PDF 优先：它已经是「一本打包好的成品」
  if (pdfs.length) {
    pdfs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const hit = pdfs[0];
    return { kind: 'pdf', path: hit.path, dir: hit.dir, bytes: hit.bytes, meta };
  }
  // 没有 PDF 但有图片：按目录当作成品（只有图片也能发）
  if (images.length) {
    images.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    const dir = path.dirname(images[0].path);
    const bytes = images.reduce((a, b) => a + b.bytes, 0);
    return { kind: 'images', path: dir, dir, bytes, meta, files: images.map((x) => x.path) };
  }
  return null;
}

function fetchImpl() {
  if (typeof api?.fetch === 'function') return api.fetch;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  return null;
}

const log = (...a) => api?.log?.(...a);
const warn = (...a) => api?.warn?.(...a);

/** 建一个绑定当前配置的引擎客户端。 */
function client() {
  return engine.createClient({
    fetchImpl: fetchImpl(),
    timeoutMs: () => cfg().timeoutSeconds * 1000,
    domains: cfg().domains,
    warn,
    proxy: cfg().proxy,
  });
}

// ───────────────────────── Python 能力探测（带缓存）─────────────────────────

function detectWorker(force = false) {
  const c = cfg();
  if (!force && workerCache.result && Date.now() - workerCache.at < 60000) return workerCache.result;
  const result = c.restore || c.outputFormat === 'pdf'
    ? pdfBridge.detect(c.pythonPath)
    : { ok: false, error: '未启用还原/PDF' };
  workerCache = { at: Date.now(), result };
  return result;
}

// ───────────────────────── 任务持久化 ─────────────────────────

async function loadHistory() {
  if (historyLoaded) return;
  historyLoaded = true;
  try {
    const raw = await fsp.readFile(TASKS_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) taskHistory = parsed.slice(0, 50);
  } catch {
    taskHistory = [];
  }
}

async function saveHistory() {
  try {
    await fsp.mkdir(downloadRoot(), { recursive: true });
    await fsp.writeFile(TASKS_FILE(), JSON.stringify(taskHistory.slice(0, 50), null, 2), 'utf8');
  } catch (error) {
    warn(`任务记录写入失败（不影响下载）：${error?.message ?? error}`);
  }
}

function pushHistory(entry) {
  taskHistory.unshift({ ...entry, at: new Date().toISOString() });
  taskHistory = taskHistory.slice(0, 50);
  void saveHistory();
}

// ───────────────────────── 权限 ─────────────────────────

/**
 * 谁能触发。留空 = 所有人；填了 QQ 号 → 只有管理员/群主/白名单能触发。
 * 注意：工具的 ctx 里没有发送者，只能读 before-tool 钩子记下的 callerLog。
 */
async function checkPermission(ctx) {
  const c = cfg();
  if (!c.allowIds) return { ok: true };

  const allow = new Set(
    c.allowIds.split(/[\s,;，、]+/).map((s) => s.trim()).filter(Boolean),
  );
  const caller = lookupCaller(ctx);
  const candidate = caller && Date.now() - caller.at < 120000 ? caller.candidates?.[0] : null;

  if (!candidate?.id) {
    return {
      ok: false,
      reason: '这个技能设置了「允许触发的 QQ」，但我认不出是谁在下指令。'
        + '请让有权限的人在消息里 @ 一下我再说一次。',
    };
  }
  if (allow.has(candidate.id)) return { ok: true, caller: candidate };

  if (String(ctx?.kind) === 'group' && ctx?.onebot) {
    try {
      const info = await ctx.onebot.call('get_group_member_info', {
        group_id: Number(ctx.chatId),
        user_id: Number(candidate.id),
        no_cache: true,
      });
      const role = String(info?.role || 'member');
      if (role === 'owner' || role === 'admin') return { ok: true, caller: candidate, role };
    } catch (error) {
      warn(`权限校验时查群身份失败（按拒绝处理）：${error?.message ?? error}`);
    }
  }
  return { ok: false, reason: `这个技能只对管理员或白名单 QQ 开放。要放开请把 ${candidate.id} 加进「允许触发的 QQ」。` };
}

// ───────────────────────── 群白名单（机主自由选群）─────────────────────────
// 机主在群里发「开启JM」/「关闭JM」即可按群开关；「JM群列表」看名单；
// 「JM所有群开放」恢复默认（所有群可用）。
// 规则：
//   · enabled-groups.json 为空/不存在 = 所有群都可用（默认，向后兼容）
//   · 一旦有群被开启 = 白名单模式，只有名单里的群（+ 所有私聊）可用
const GROUPS_FILE = () => path.join(downloadRoot(), 'enabled-groups.json');

function loadGroupState() {
  try {
    const s = JSON.parse(fs.readFileSync(GROUPS_FILE(), 'utf8'));
    if (s && typeof s === 'object' && s.groups && typeof s.groups === 'object') return s;
  } catch { /* 没有文件 = 默认全开 */ }
  return { groups: {} };
}

function saveGroupState(state) {
  try {
    fs.mkdirSync(path.dirname(GROUPS_FILE()), { recursive: true });
    fs.writeFileSync(GROUPS_FILE(), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2));
  } catch (error) {
    warn(`群白名单写入失败（不影响本次回复）：${error?.message ?? error}`);
  }
}

/** 这个会话能不能用 JM 功能。私聊不受白名单限制。 */
function isChatAllowed(chatKey) {
  const st = loadGroupState();
  const ids = Object.keys(st.groups || {}).filter(Boolean);
  if (!ids.length) return true;
  const key = String(chatKey || '');
  if (key.startsWith('private:')) return true;
  const gid = key.startsWith('group:') ? key.slice('group:'.length) : key;
  return Boolean(st.groups[gid]);
}

/** 门禁：返回空串=放行；否则返回给群友看的提示文本。 */
function gateChat(chatKey) {
  if (isChatAllowed(chatKey)) return '';
  return '本群还没有开启 JM 漫画功能。让群主/管理员在群里 @我 说「开启JM」即可开通；'
    + '机主也可以说「JM所有群开放」恢复全部群可用。';
}

// ───────────────────────── 下载一个本子 ─────────────────────────

/**
 * 下载整本（不含 PDF/上传）。返回结构供后续步骤复用。
 * @param {object} job { albumId, chatKey, onProgress }
 */
async function downloadAlbum({ albumId, chatKey, onProgress, control }) {
  const c = cfg();
  const task = { control };
  const api0 = client();
  const album = await api0.albumInfo(albumId);

  const chapters = album.series.length
    ? (c.multiChapter ? album.series : album.series.slice(0, 1))
    : [{ id: album.id, name: album.name, sort: 1 }];

  const albumDir = path.join(downloadRoot(), `jm-${album.id}`, engine.sanitizeSegment(`${album.id}-${album.name}`, `JM${album.id}`));
  await fsp.mkdir(albumDir, { recursive: true });

  const totals = { total: 0, ok: 0, fail: 0, pages: 0 };
  const failed = [];
  const chapterResults = [];

  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    let photo;
    try {
      photo = await api0.photoInfo(chapter.id);
    } catch (error) {
      failed.push({ chapter: chapter.id, error: `章节信息读取失败：${error?.message ?? error}` });
      onProgress?.({ stage: 'download', chapter: i + 1, chapters: chapters.length, ...totals });
      continue;
    }
    if (!photo.images.length) {
      failed.push({ chapter: chapter.id, error: '这一章没有图片（可能已被删除）' });
      onProgress?.({ stage: 'download', chapter: i + 1, chapters: chapters.length, ...totals });
      continue;
    }

    let names = photo.images.map((n, idx) => engine.imageFileName(n, idx + 1));
    let skipped = 0;
    if (names.length > c.maxPages) {
      skipped = names.length - c.maxPages;
      names = names.slice(0, c.maxPages);
    }

    const chapterDir = chapters.length > 1
      ? path.join(
          albumDir,
          engine.sanitizeSegment(
            // 实测：/album 的 series[].name 常常是空串，真正的章节名在 /chapter 的 name 里
            `${String(chapter.sort || i + 1).padStart(3, '0')}-${chapter.name || photo.name || ''}`,
            `ch-${chapter.id}`,
          ),
        )
      : albumDir;
    await fsp.mkdir(chapterDir, { recursive: true });

    const pages = [];
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= names.length) return;
        await waitIfPaused(task);
        const target = path.join(chapterDir, names[idx]);
        totals.total += 1;
        try {
          if (fs.existsSync(target) && (await fsp.stat(target)).size > 1024) {
            totals.ok += 1; // 之前下过（同一 ID 重发时补下）
          } else {
            const buf = await api0.fetchImage(photo.id || chapter.id, names[idx]);
            await fsp.writeFile(target, buf);
            totals.ok += 1;
          }
          pages[idx] = target;
        } catch (error) {
          totals.fail += 1;
          failed.push({ chapter: chapter.id, error: `${names[idx]}：${error?.message ?? error}` });
        }
        totals.pages += 1;
        if (totals.pages % 5 === 0) {
          onProgress?.({ stage: 'download', chapter: i + 1, chapters: chapters.length, ...totals });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(c.concurrency, names.length)) }, worker));
    onProgress?.({ stage: 'download', chapter: i + 1, chapters: chapters.length, ...totals });

    chapterResults.push({
      id: photo.id || chapter.id,
      name: chapter.name || photo.name || `第${i + 1}话`,
      sort: chapter.sort || i + 1,
      skipped,
      pages: pages.filter(Boolean),
    });
  }

  // scramble_id 每次现查（写死会把本来正常的图弄花）
  let scrambleId = 0;
  if (c.restore && chapterResults.length) {
    scrambleId = await api0.fetchScrambleId(chapterResults[0].id);
  }

  return { album, albumDir, chapters: chapterResults, totals, failed, scrambleId };
}

// ───────────────────────── 主任务 ─────────────────────────

async function runJob(job) {
  const c = cfg();
  const { albumId, chatKey, kind, sender, onebot, who, whoName } = job;
  const say = (text) => sendText(sender, onebot, chatKey, text);
  /** 单本「简介」信息卡：图 + 一句话说明，发当前会话。 */
  const sendAlbumCard = async (ob, key, imagePath) => {
    if (!ob?.sendSegments) return false;
    const [k, id] = String(key || '').split(':');
    if (!k || !id) return false;
    try {
      await ob.sendSegments(k, id, [
        { type: 'text', data: { text: `📥 JM${albumId} 的简介` } },
        { type: 'image', data: { file: `file://${imagePath}` } },
      ]);
      return true;
    } catch (error) {
      warn(`简介卡片发送失败：${error?.message ?? error}`);
      return false;
    }
  };
  await waitIfPaused(job);

  await loadHistory();
  await fsp.mkdir(downloadRoot(), { recursive: true });

  let lastReport = 0;
  const report = (text) => {
    if (!c.progress) return;
    const now = Date.now();
    if (now - lastReport < 12000) return; // 报太勤会把发言配额吃光
    lastReport = now;
    void say(text);
  };

  const record = { id: albumId, chatKey, who, ok: false, stage: 'download', startedAt: Date.now() };

  try {
    // ① 复用：先看 keepHours 内的 PDF 快通道，再看更宽的「本地已有的这本」
    //    （2026-10-10 本地新增，见 findLocalArtifact 与 localReuseDays 的说明）
    const cachedPdf = c.outputFormat === 'pdf' ? await findCachedPdf(albumId, c.keepHours) : null;
    const localArt = cachedPdf ? null : await findLocalArtifact(albumId, c.localReuseDays);
    const reused = cachedPdf || localArt;

    // 复用时构造一份与 downloadAlbum 同形的 dl，让下游（翻译/PDF/上传/简介卡/汇报）
    // 一行都不用改 —— 图片目录也能当成"成品"发出去。
    const dl = reused
      ? {
          cachedPdf: cachedPdf || undefined,
          localArtifact: localArt || undefined,
          album: {
            id: albumId,
            name: reused.meta?.name || `JM${albumId}`,
            description: reused.meta?.description || '',
            authors: reused.meta?.authors || [],
            tags: reused.meta?.tags || [],
          },
          albumDir: reused.dir,
          chapters: Array.from(
            { length: Math.max(1, Number(reused.meta?.chapters) || 1) },
            (_, i) => ({ name: `第${i + 1}话`, pages: [] }),
          ),
          totals: {
            total: Number(reused.meta?.pages) || 0,
            ok: Number(reused.meta?.pagesOk || reused.meta?.pages) || 0,
            fail: 0,
          },
          failed: [],
          scrambleId: 0,
        }
      : (await (async () => {
          await say(`🔍 开始处理 JM${albumId}…`);
          return downloadAlbum({
            albumId,
            chatKey,
            control: job.control,
            onProgress: (p) => {
              if (p.stage === 'download' && p.total > 0) {
                report(`📥 下载中：第 ${p.chapter}/${p.chapters} 话，已存 ${p.ok}/${p.total} 张（失败 ${p.fail}）`);
              }
            },
          });
        })());
    if (cachedPdf) await say(`📦 JM${albumId} 命中最近 ${c.keepHours} 小时内的 PDF，直接重新发送，不重新下载。`);
    else if (localArt) {
      await say(localArt.kind === 'pdf'
        ? `📦 JM${albumId} 本地已经有这本（${(localArt.bytes / 1048576).toFixed(1)} MB），直接发送，不重新下载。`
        : `📦 JM${albumId} 本地已经有这本的图片（${(localArt.files || []).length} 张），直接发送，不重新下载。`);
    }
    record.title = toSimplified(dl.album.name);
    record.description = toSimplified(dl.album.description || '');
    record.pages = dl.totals.total;
    record.pagesOk = dl.totals.ok;
    record.dir = dl.albumDir;
    if (!dl.totals.ok) {
      throw new Error(`一张图都没下下来（失败 ${dl.totals.fail} 张）。多半是站点限速或网络问题，稍后重发同一个 ID 会接着补下。`);
    }

    // ② 生成 PDF（可选增强）
    // ②.4 日语标题翻译（2026-10-06）：必须放在**生成 PDF 文件名之前**，
    // 否则群文件会继续用日文原名（群友点开是「ホモであることを認めない系男子」）。
    // 翻了就写进 metadata，报名字/群文件名/以后的列表全都用中文，且不用重复翻。
    // 注：baseName/jpName 提到外层作用域，下面写 metadata 时要用。
    const baseName = toSimplified(dl.album.name);
    let jpName = '';
    if (c.translateTitles !== false) {
      await ensureTranslatedTitles([{
        title: baseName,
        apply: (t) => { jpName = toSimplified(String(t || '').trim()); },
      }]);
      if (jpName && jpName !== baseName) {
        log(`标题翻译：${baseName} -> ${jpName}`);
        dl.album.name = jpName;
      }
    }

    let deliverPath = '';
    let deliverName = '';
    /** 合成时按页分好的卷（每一卷都是独立合法的 PDF）。>1 时逐卷上传。 */
    let deliverParts = [];
    let pdfInfo = null;
    const wantPdf = c.outputFormat === 'pdf';
    const worker = wantPdf ? detectWorker() : { ok: false, error: '输出格式设为「原始图片」' };

    // ── 缓存成品"大到必须分卷"时不能直接交付（2026-10-14 修）──────────────────
    // 缓存里躺着的是**整本** PDF（1.6 GB 这种）；直接交付 → 上传前按字节切成
    // .partNofM.pdf → 用户拿到一堆打不开的文件。所以：只要"需要上传 + 超过单文件上限
    // + 原图还在"，就跳过缓存，走下面的按页分卷合成。
    const uploadLimitBytes = c.maxUploadMB * 1024 * 1024;
    // ⚠️⚠️ 这里**绝对不能写 `dest`**（2026-10-14 实测踩爆）：
    //     `const dest` 在下面（约 1087 行）才声明，在这之前引用会抛
    //     "Cannot access 'dest' before initialization"（暂时性死区），
    //     后果是**每个任务一下载完就崩**（图白下，用户只看到"❌ 处理失败"）。
    //     resolveUploadTarget 是 function 声明（会提升），且只依赖 c/chatKey/kind，
    //     所以这里就地算一次，别去碰那个还没初始化的绑定。
    const destNow = resolveUploadTarget(c, chatKey, kind);
    const needUpload = Boolean(destNow) && c.uploadMode !== 'off';
    const mustReflow = (bytesVal) => needUpload && !c.rejectOversize && Number(bytesVal) > uploadLimitBytes;
    const imagesAvailable = () => {
      const pages = dl.chapters.flatMap((ch) => ch.pages || []);
      if (!pages.length) return false;
      let checked = 0;
      for (const p of pages) {
        if (++checked > 50) break;                     // 抽样 50 张，够判断了
        try { if (!fs.existsSync(p)) return false; } catch { return false; }
      }
      return true;
    };
    const reflowInsteadOfCache = (bytesVal, label) => {
      if (!mustReflow(bytesVal) || !imagesAvailable() || !worker.ok) return false;
      record.cacheHit = false;
      warn(`${label} ${humanSize(Number(bytesVal))} 超过单文件上限 ${c.maxUploadMB} MB，改按页重新分卷（缓存成品无法按页切）`);
      return true;
    };

    if (wantPdf && dl.cachedPdf && !reflowInsteadOfCache(dl.cachedPdf.bytes, '缓存成品')) {
      record.stage = 'pdf';
      const cachedInfo = dl.cachedPdf;
      pdfInfo = { ok: true, output: cachedInfo.path, bytes: cachedInfo.bytes, pages: Number(cachedInfo.meta?.pages) || dl.totals.total, pagesOk: Number(cachedInfo.meta?.pagesOk || cachedInfo.meta?.pages) || dl.totals.ok, restored: Number(cachedInfo.meta?.pdf?.restored) || 0 };
      deliverPath = cachedInfo.path;
      deliverName = path.basename(cachedInfo.path);
      record.cacheHit = true;
      record.pdf = { bytes: pdfInfo.bytes, pages: pdfInfo.pages, pagesOk: pdfInfo.pagesOk, restored: pdfInfo.restored, cached: true };
    } else if (wantPdf && dl.localArtifact && dl.localArtifact.kind === 'pdf' && !reflowInsteadOfCache(dl.localArtifact.bytes, '本地成品')) {
      // 2026-10-10 本地新增：keepHours 之外、但本地已有 PDF —— 直接交付，不重新合成。
      // （没有这一支的话会掉进下面的 worker.ok 分支，拿已经不存在的图片去重新合成 PDF。）
      record.stage = 'pdf';
      const info = dl.localArtifact;
      pdfInfo = { ok: true, output: info.path, bytes: info.bytes, pages: Number(info.meta?.pages) || dl.totals.total, pagesOk: Number(info.meta?.pagesOk || info.meta?.pages) || dl.totals.ok, restored: Number(info.meta?.pdf?.restored) || 0 };
      deliverPath = info.path;
      deliverName = path.basename(info.path);
      record.cacheHit = true;
      record.pdf = { bytes: pdfInfo.bytes, pages: pdfInfo.pages, pagesOk: pdfInfo.pagesOk, restored: pdfInfo.restored, cached: true };
    } else if (wantPdf && worker.ok) {
      record.stage = 'pdf';
      await say(`🖼 下载完成（${dl.totals.ok} 张），正在${c.restore ? '还原竖切并' : ''}合成 PDF…`);
      const pdfName = `${engine.sanitizeSegment(`JM${dl.album.id}-${dl.album.name}`, `JM${dl.album.id}`)}.pdf`;
      const outPath = path.join(dl.albumDir, pdfName);
      // ── 分几卷：必须在**合成时**决定（2026-10-14 修的真实故障）────────────────
      // 旧做法：合成一个整本 PDF → 上传前按**字节**切片成 .partNofM.pdf。
      // 切出来的东西不是 PDF：第 1 卷有 %PDF 头但 trailer 被截断、第 2..N 卷连头都没有，
      // 实测头尾字节 = 乱码 → 用户那边"文件打不开"，第 1 卷被阅读器硬撑开还花屏。
      // 现在：预估整本大小 → 交给 worker 按**连续页**切成 N 份，每份都是独立合法 PDF。
      //   预估系数 3.0：实测 JM518074（7187 张 webp / 823 MB → PDF 1678 MB）膨胀 **2.04×**，
      //   取 3.0 是留安全余量 —— 估少了会有一卷超过 maxUploadMB，就掉回上面那条
      //   "字节分卷"的应急路径（那些卷打不开），所以宁可多切几卷。
      let wantParts = 1;
      if (destNow && c.uploadMode !== 'off') {
        let srcBytes = 0;
        for (const ch of dl.chapters) {
          for (const p of ch.pages || []) {
            try { srcBytes += fs.statSync(p).size; } catch { /* 个别缺文件不影响估算 */ }
          }
        }
        if (srcBytes > 0) wantParts = Math.max(1, Math.min(30, Math.ceil((srcBytes * 3.0) / uploadLimitBytes)));
      }
      const task = {
        album_id: dl.album.id,
        control: job.control,
        title: dl.album.name,
        scramble_id: dl.scrambleId,
        descramble: c.restore,
        output: outPath,
        quality: c.pdfQuality,
        max_dim: c.pdfMaxDim,
        parts: wantParts,
        // ⚠️ 每一章都要带上它自己的 aid（= 该章的 photo id）！
        //    站点的 get_num(aid, page) 里 aid 是**章节号**（页面上写着 `var aid = 518598`），
        //    多章节本子里每章的 aid 都不同 —— 用专辑号算出来的切块数只有第 1 章碰巧对，
        //    其余章节全部错切（2026-10-14 用户报"画面还是错乱的"就是这么来的）。
        chapters: dl.chapters.map((ch) => ({ name: ch.name, pages: ch.pages, aid: ch.id })),
      };
      const res = await pdfBridge.runTask({
        python: worker.python,
        task,
        timeoutMs: Math.max(180000, dl.totals.total * 4000),
        onProgress: (p) => {
          if (p.stage === 'descramble') {
            report(`🎨 还原中：${p.done}/${p.total}（失败 ${p.fail}）`);
          } else if (p.stage === 'pdf') {
            report(p.total > 1 ? `📄 正在写入 PDF（${p.done}/${p.total} 卷）…` : '📄 正在写入 PDF…');
          }
        },
      });
      if (res.ok) {
        pdfInfo = res;
        deliverPath = res.output;
        deliverName = path.basename(res.output);
        if (Array.isArray(res.outputs) && res.outputs.length > 1) {
          deliverParts = res.outputs.map((o) => o.output);
        }
        record.pdf = { bytes: res.bytes, pages: res.pages, pagesOk: res.pagesOk, restored: res.restored, parts: deliverParts.length || 1 };
      } else if (task?.control?.deleted) {
        throw new Error('任务已被删除，停止处理');
      } else {
        // 降级：PDF 没成，但图已经下来了，不能算整体失败
        warn(`PDF 生成失败（已降级为原样图片）：${res.error}`);
        record.pdfError = res.error;
      }
    } else if (wantPdf) {
      record.pdfError = worker.error;
      warn(`PDF 不可用（降级为原样图片）：${worker.error}`);
    }

    // ②.6 打包成 ZIP（2026-10-23）
    //   · 只在「输出格式 = pdf」且真的拿到 PDF 时执行；纯图片模式不上传文件，也就没有 zip。
    //   · 多卷（超长本按页分卷）时**全部塞进同一个 zip**（用户选择：要一个包）。
    //     整包可能超过单文件上限，这时不再按字节切 —— 切开的 zip 解不开，只会变成一堆
    //     打不开的文件（下面上传段对此有专门处理）。
    //   · 已经打过、且比所有源 PDF 都新的同名 zip，直接复用（重启/重复请求不重复打包）。
    //   · 「是否生成压缩包」关掉时整段跳过：成品仍是 .pdf，上传逻辑保持原样。
    const zipPassword = c.zipPasswordEnabled && c.zipPassword ? c.zipPassword : '';
    if (c.zipEnabled && wantPdf && deliverPath) {
      record.stage = 'zip';
      const sources = deliverParts.length > 1 ? deliverParts.slice() : [deliverPath];
      const entries = sources.map((p) => ({
        filePath: p,
        // ⚠️ 用 PDF 自己的文件名（`JM<号>-<作品名>.pdf`），不要只写 JM 号 ——
        //    群友解压后要一眼看出这是哪一本（2026-10-23 用户要求）。
        entryName: path.basename(p) || `JM${dl.album.id}.pdf`,
      }));
      const zipName = buildZipName(dl.album.id, { password: zipPassword, includePassword: c.zipPasswordInName });
      const zipPath = path.join(dl.albumDir, zipName);
      const zipExistsFresh = () => {
        try {
          if (!fs.existsSync(zipPath)) return false;
          const zt = fs.statSync(zipPath).mtimeMs;
          return sources.every((p) => {
            try { return fs.statSync(p).mtimeMs <= zt; } catch { return false; }
          });
        } catch { return false; }
      };
      if (!zipExistsFresh()) {
        await say(zipPassword ? '🗜 正在打包成加密压缩包…' : '🗜 正在打包成压缩包…');
        const zr = await createZip({ outPath: zipPath, entries, password: zipPassword });
        if (!zr.ok) throw new Error(`压缩包生成失败：${zr.error}`);
        log(`JM${dl.album.id} 已打包：${zipName}（${humanSize(zr.bytes)}，加密=${zr.encrypted ? '是' : '否'}，${zr.entries} 个文件）`);
      } else {
        log(`JM${dl.album.id} 复用已有压缩包：${zipName}`);
      }
      const zipBytes = fs.statSync(zipPath).size;
      record.zip = {
        name: zipName,
        password: zipPassword,
        encrypted: Boolean(zipPassword),
        bytes: zipBytes,
        entries: entries.length,
      };
      deliverPath = zipPath;
      deliverName = zipName;
      deliverParts = [];
    }

    // ②.5 写 metadata.json（书架工具要靠它显示本子名；也必须早于"删除原图"）
    // ⚠️ 这里踩过一次：v2 重写时把这个写入漏掉了，metadata.json 只被读、从不被写，
    //    于是 library 工具一直拿目录名硬猜本子名，而"删除原图"也少了要保护的文件。
    try {
      const meta = {
        id: dl.album.id,
        name: toSimplified(dl.album.name),
        description: toSimplified(dl.album.description || '').slice(0, 500),
        authors: (dl.album.authors || []).map(toSimplified),
        tags: (dl.album.tags || []).map(toSimplified),
        firstSubmitter: (() => {
          const s = firstSubmitters.get(`${chatKey}:${albumId}`) || (whoName ? { id: who || '', name: whoName } : null);
          // 名字和 QQ 号都没有 → 存 null，别把 "群友" 这种占位名永久写进存档
          if (!s || !(s.name || s.id)) return null;
          return { id: s.id || '', name: s.name || '', at: s.at || Date.now() };
        })(),
        chapters: dl.chapters.length,        pages: dl.totals.total,
        pagesOk: dl.totals.ok,
        downloadedAt: new Date().toISOString(),
        dir: dl.albumDir,
        // 名字被翻译过时留一份日文原文，方便回溯/纠错（没翻就不写这个字段）
        ...(jpName && jpName !== baseName ? { nameOriginal: baseName } : {}),
        pdf: pdfInfo ? { bytes: pdfInfo.bytes, pages: pdfInfo.pages, pagesOk: pdfInfo.pagesOk, restored: pdfInfo.restored } : null,
        // 压缩包信息：**不写密码明文**，只留名字与是否加密（要密码看聊天消息或文件名）
        zip: record.zip ? { name: record.zip.name, encrypted: record.zip.encrypted, bytes: record.zip.bytes } : null,
        pdfError: record.pdfError || '',
        deletedImages: false,
        note: '图片为站点原始文件；较新的本子带站点防爬的竖切打乱，本技能会按站点返回的 scramble_id 还原。',
      };
      await fsp.writeFile(path.join(dl.albumDir, 'metadata.json'), JSON.stringify(meta, null, 2), 'utf8');
    } catch (error) {
      warn(`metadata.json 写入失败（不影响下载）：${error?.message ?? error}`);
    }

    if (!deliverPath) {
      record.stage = 'images';
      deliverPath = '';
    }

    ensureAlive(job);

    // ③ 上传（若开启「合成 PDF 后删除原图」，这里只是收尾顺序的前半段 —— 见 ④）
    const dest = resolveUploadTarget(c, chatKey, kind);
    let uploadNote = '';
    let deliveryConfirmed = false;
    if (c.uploadMode === 'off') {
      deliveryConfirmed = true;
      uploadNote = '（当前设置不上传文件，图片已存在本地）';
    } else if (!dest) {
      uploadNote = '（当前设置不上传文件，图片已存在本地）';
    } else if (!deliverPath) {
      uploadNote = '⚠️ 没有生成可上传的文件（PDF 不可用），图片已存在本地';
    } else {
      record.stage = 'upload';
      const size = fs.statSync(deliverPath).size;
      const limit = c.maxUploadMB * 1024 * 1024;
      if (deliverParts.length > 1) {
        // ── 合成时就按页分好的卷：每一卷都是**独立合法 PDF**，可直接打开 ────────
        const totalBytes = deliverParts.reduce((a, p) => { try { return a + fs.statSync(p).size; } catch { return a; } }, 0);
        uploadNote = `📦 共 ${humanSize(totalBytes)}，已按页分成 ${deliverParts.length} 卷上传（**每卷都能单独打开**）`;
        let sent = 0;
        for (const part of deliverParts) {
          const r = await uploadFile({
            onebot, chatKey: dest, filePath: part, name: path.basename(part),
            publish: c.uploadMode !== 'off', checkQuota: c.checkQuota,
          });
          if (r.ok) {
            sent += 1;
            deliveryConfirmed = true;
            rememberGroupFile(dest, r.fileId, path.basename(part));
          } else {
            uploadNote += `\n第 ${sent + 1} 卷上传失败：${r.error}`;
            break;
          }
        }
        if (sent === deliverParts.length) {
          deliveryConfirmed = true;
          uploadNote += '，全部成功';
        }
      } else if (size > limit && !record.zip) {
        if (c.rejectOversize) {
          uploadNote = `⚠️ 文件 ${humanSize(size)} 超过单文件上限 ${c.maxUploadMB} MB，按设置没有上传（可调大上限或允许分卷）`;
        } else {
          // 应急路径：只会在"缓存里已有的整本 PDF 超大"或"预估失准"时走到。
          // ⚠️ 字节分卷出来的文件**不是完整 PDF**（打不开），所以必须把这话说明白 ——
          //    2026-10-14 就是因为这里静默地切了字节，用户拿到 9 个打不开的文件。
          const parts = splitForUpload(deliverPath, limit);
          uploadNote = `⚠️ 单文件 ${humanSize(size)} 超过 ${c.maxUploadMB} MB，已按**字节**切成 ${parts.length} 卷 —— `
            + '这些卷**不是完整 PDF，必须合并后才能打开**。建议把「单文件上限」调大，或重新下载（会改按页分卷）。';
          let sent = 0;
          for (const part of parts) {
            const r = await uploadFile({
              onebot, chatKey: dest, filePath: part, name: path.basename(part),
              publish: c.uploadMode !== 'off', checkQuota: c.checkQuota,
            });
            if (r.ok) {
              sent += 1;
              deliveryConfirmed = true;
              rememberGroupFile(dest, r.fileId, path.basename(part));
            } else {
              uploadNote += `\n第 ${sent + 1} 卷上传失败：${r.error}`;
              break;
            }
          }
          if (sent === parts.length) {
            deliveryConfirmed = true;
            uploadNote += `，全部成功`;
          }
        }
      } else {
        // 单文件上传。⚠️ 压缩包超限也走这里：**不按字节切** —— 切开的 zip 解不开，
        // 只会让群友拿到一堆"文件损坏"。宁可整包试一次，失败了明确告诉他本地路径。
        const zipTooBig = Boolean(record.zip) && size > limit;
        const r = await uploadFile({
          onebot, chatKey: dest, filePath: deliverPath, name: deliverName || path.basename(deliverPath),
          checkQuota: c.checkQuota,
        });
        if (r.ok) {
          deliveryConfirmed = true;
          rememberGroupFile(dest, r.fileId, deliverName || path.basename(deliverPath));
          uploadNote = dest.startsWith('group:')
            ? `📎 已上传到本群群文件：${deliverName || path.basename(deliverPath)}（${humanSize(size)}）${r.note ? `\nℹ️ ${r.note}` : ''}`
            : `📎 已发送文件：${deliverName || path.basename(deliverPath)}（${humanSize(size)}）`;
          if (zipTooBig) {
            uploadNote = `⚠️ 压缩包 ${humanSize(size)} 超过单文件上限 ${c.maxUploadMB} MB，已按**整包**上传（没有切分）。\n` + uploadNote;
          }
        } else {
          uploadNote = zipTooBig
            ? `⚠️ 压缩包 ${humanSize(size)} 超过单文件上限 ${c.maxUploadMB} MB，上传失败：${r.error}\n压缩包已留在本地：${deliverPath}`
            : `⚠️ 文件上传失败（已自动重试，原图已保留）：${r.error}`;
        }
      }
    }

    // ④ 按需删除原图（省空间模式）
    // 顺序说明：删除排在"上传"之后 —— 上传用的是 PDF 而不是原图，
    //          放在这里还能保证"上传失败时原图仍在"，便于重发补传。
    const wantCleanup = c.deleteImagesAfterPdf && c.outputFormat === 'pdf' && Boolean(pdfInfo) && deliveryConfirmed;

    let cleanup = null;
    if (wantCleanup) {
      cleanup = await deleteImages(dl.albumDir);
      record.deletedImages = cleanup.files;
      record.freedBytes = cleanup.freed;
      log(`已删除原图 ${cleanup.files} 个（释放 ${humanSize(cleanup.freed)}），只保留 PDF：${dl.albumDir}`);
      // 在 metadata 里留痕：这本的原图已被删除（事后能说清"为什么只剩 PDF"）
      try {
        const metaPath = path.join(dl.albumDir, 'metadata.json');
        const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
        meta.deletedImages = true;
        meta.deletedAt = new Date().toISOString();
        meta.freedBytes = cleanup.freed;
        await fsp.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
      } catch (error) {
        warn(`metadata 更新删除标记失败（不影响结果）：${error?.message ?? error}`);
      }
    } else if (c.deleteImagesAfterPdf && !pdfInfo) {
      // 用户开了省空间，但 PDF 没生成 → 明确说明"没删"，避免他以为删了
      warn(`设置了「合成 PDF 后删除原图」，但本次 PDF 未生成 → 已保留原图，未做删除`);
    }

    // ⑤ 汇报
    // 2026-10-06 晚：简介也改成信息卡图片（与「更新JM」/「今日JM」同一套卡片风格）：
    //   封面 + 标题 + JM 编号徽章 + 作者/标签/规模 + 底部通栏简介。
    // 文字消息只保留"交付状态"类信息（首次发车/上传结果/失败说明）。
    const displayName = toSimplified(dl.album.name);
    let cardSent = false;
    try {
      const cover = firstPageImage(dl.albumDir) || await fetchSiteCover(String(dl.album.id));
      const payload = {
        id: String(dl.album.id),
        title: cleanTitle(displayName) || displayName,
        authors: (dl.album.authors || []).map((a) => toSimplified(String(a).trim())).filter(Boolean),
        tags: (dl.album.tags || []).map((t) => toSimplified(String(t).trim())).filter(Boolean),
        kind: `${dl.chapters.length} 话 · ${dl.totals.ok} 张`,
        pdf: pdfInfo ? `PDF ${pdfInfo.pages} 页（${humanSize(pdfInfo.bytes)}）` : '',
        desc: toSimplified(String(dl.album.description || '')).slice(0, 400),
        cover,
      };
      const imagePath = await renderAlbumImage({ payload });
      cardSent = await sendAlbumCard(onebot, chatKey, imagePath);
    } catch (error) {
      warn(`简介卡片渲染/发送失败，降级文字版：${error?.message ?? error}`);
    }

    const lines = [];
    if (!cardSent) {
      lines.push(`✅ 「${displayName}」（JM${dl.album.id}）处理好啦`);
      if (dl.album.description) lines.push(`简介：${toSimplified(dl.album.description).slice(0, 500)}`);
    } else {
      lines.push('✅ 处理好啦（简介见上图）');
    }
    const submitter = firstSubmitters.get(`${chatKey}:${albumId}`) || (whoName ? { id: who || '', name: whoName } : null);
    // 首次发车：昵称 + QQ 号（认不出人时整行不发，也不显示空占位）
    const subName = String(submitter?.name || '').trim();
    const subId = String(submitter?.id || '').trim();
    if (subName && subId) lines.push(`首次发车：${subName}(${subId})`);
    else if (subName || subId) lines.push(`首次发车：${subName || subId}`);
    if (record.pdfError) lines.push(`PDF 没生成：${record.pdfError}`);
    // 密码一项：没密码时按约定显示「无」
    if (record.zip) lines.push(record.zip.encrypted ? `🔒 解压密码：${record.zip.password}` : '🔒 解压密码：无');
    if (uploadNote) lines.push(uploadNote);
    if (dl.totals.fail > 0) lines.push(`有 ${dl.totals.fail} 张没下下来，重发同一个 ID 会接着补下。`);
    await say(lines.join('\n'));

    // 运维细节只写日志
    if (cleanup) log(`已删除原图 ${cleanup.files} 个（释放 ${humanSize(cleanup.freed)}），只保留 PDF：${dl.albumDir}`);
    else if (c.deleteImagesAfterPdf && !pdfInfo) log(`设置了「合成 PDF 后删除原图」，但本次 PDF 未生成 → 已保留原图`);
    if (pdfInfo) log(`JM${dl.album.id} 完成：${pdfInfo.pages} 页/${humanSize(pdfInfo.bytes)}，目录 ${dl.albumDir}`);

    record.stage = 'done';
    record.ok = true;
    record.finishedAt = Date.now();
    pushHistory(record);
    return record;
  } catch (error) {
    if (job?.control?.deleted) {
      // 群指令删除：不报"处理失败"，不发消息，只留一条痕迹
      record.stage = 'deleted';
      record.error = '群指令删除';
      record.finishedAt = Date.now();
      pushHistory(record);
      log(`JM${albumId} 已按群指令删除（不作为失败处理）`);
      return record;
    }
    record.stage = 'failed';
    record.error = humanize(error?.message ?? String(error));
    record.finishedAt = Date.now();
    pushHistory(record);
    await say(`❌ JM${albumId} 处理失败：${record.error}`);
    warn(`JM${albumId} 任务失败：${error?.stack ?? error}`);
    return record;
  }
}

/** 上传目标：按设置决定传到哪个会话。 */
function resolveUploadTarget(c, chatKey, kind) {
  if (c.uploadMode === 'off') return '';
  if (c.uploadMode === 'request') return chatKey; // 在哪个会话提出就传回哪里
  if (c.uploadMode === 'group') return String(kind) === 'group' ? chatKey : '';
  if (c.uploadMode === 'private') return String(kind) === 'private' ? chatKey : '';
  return chatKey;
}

/**
 * 删除某一本的所有原始图片，只保留 PDF 与 metadata.json（"省空间"模式）。
 *
 * 三道保险，缺一不可：
 *   ① 调用方必须已确认 PDF 生成成功（PDF 失败时绝不删，否则等于白下）
 *   ② 目标路径必须在 albumDir 之内（解析后 path.relative 校验，防误删）
 *   ③ 只删图片后缀的文件（不碰 .pdf / .partNofM / metadata.json）
 *
 * @returns {Promise<{freed:number, files:number, dirs:number}>} 释放的字节数与文件数
 */
async function deleteImages(albumDir) {
  const result = { freed: 0, files: 0, dirs: 0 };
  if (!albumDir || !fs.existsSync(albumDir)) return result;

  const rootResolved = path.resolve(albumDir);
  // ⚠️ 必须用严格版（isImageFileName）：suffixOf() 会把 .pdf/.json 回退成 '.jpg'，
  //    用它做删除判断会把 PDF 和 metadata.json 一起删掉（实测踩过）。
  const isImage = (name) => engine.isImageFileName(name);
  const isPart = (name) => /\.part\d+of\d+\.[a-z0-9]+$/i.test(name);

  // 先删文件，再自底向上清理空目录
  async function walk(dir, depth = 0) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const target = path.join(dir, e.name);
      // 保险②：必须仍在本子目录之内
      const rel = path.relative(rootResolved, path.resolve(target));
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        warn(`跳过可疑路径（不在本子目录内）：${target}`);
        continue;
      }
      if (e.isDirectory()) {
        await walk(target, depth + 1);
        continue;
      }
      // 保险③：只删图片，且分卷文件不动
      if (!isImage(e.name) || isPart(e.name)) continue;
      // 保险④：白名单永不动（万一上面的后缀判定哪天又出错，这一条兜底）
      if (/\.pdf$/i.test(e.name) || e.name.toLowerCase() === 'metadata.json') {
        warn(`跳过受保护文件：${e.name}`);
        continue;
      }
      try {
        const size = (await fsp.stat(target)).size;
        await fsp.unlink(target);
        result.freed += size;
        result.files += 1;
      } catch (error) {
        warn(`删除原图失败（已跳过）：${e.name} — ${error?.message ?? error}`);
      }
    }
    // 目录空了就删掉（最后只留下 PDF 与 metadata.json 所在的根目录）
    if (depth > 0) {
      try {
        if ((await fsp.readdir(dir)).length === 0) {
          await fsp.rmdir(dir);
          result.dirs += 1;
        }
      } catch {
        /* 非空或已被删，忽略 */
      }
    }
  }

  await walk(rootResolved);
  return result;
}

/** 分卷（超过单文件上限时）。 */
function splitForUpload(filePath, maxBytes) {
  const size = fs.statSync(filePath).size;
  const parts = Math.max(2, Math.ceil(size / maxBytes));
  const chunk = Math.ceil(size / parts);
  const ext = (filePath.match(/\.[a-zA-Z0-9]{1,6}$/) || [''])[0];
  const stem = ext ? filePath.slice(0, -ext.length) : filePath;
  const out = [];
  const fd = fs.openSync(filePath, 'r');
  try {
    for (let i = 0; i < parts; i++) {
      const start = i * chunk;
      const len = Math.min(chunk, size - start);
      if (len <= 0) break;
      const target = `${stem}.part${i + 1}of${parts}${ext}`;
      const buf = Buffer.allocUnsafe(len);
      fs.readSync(fd, buf, 0, len, start);
      fs.writeFileSync(target, buf);
      out.push(target);
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

function humanize(msg) {
  const s = String(msg);
  if (/所有禁漫域名都连不上/.test(s)) return s;
  if (/album_missing|本子.*不存在|章节.*不存在/.test(s)) return `这本子不存在或已被删除（原文：${s}）`;
  if (/Restricted Access|ip地区|HTTP 403/.test(s)) return `站点拒绝了本机 IP（可能需要挂代理，或在设置里换域名）。原文：${s}`;
  if (/超时|TimeoutError/.test(s)) return `请求超时（可能是网络慢或被限速）。可以调大「单次请求超时」。原文：${s}`;
  return s;
}

// ───────────────────────── 发消息 ─────────────────────────

async function sendText(sender, onebot, chatKey, text) {
  try {
    if (!chatKey || !text) return false;
    if (sender?.sendTextBatch) {
      await sender.sendTextBatch(chatKey, [text]);
      return true;
    }
    const [kind, id] = String(chatKey).split(':');
    if (onebot?.sendSegments) {
      await onebot.sendSegments(kind, id, [{ type: 'text', data: { text: String(text) } }]);
      return true;
    }
    return false;
  } catch (error) {
    warn(`发消息失败（不影响任务）：${error?.message ?? error}`);
    return false;
  }
}

// ───────────────────────── 群文件到期删除 ─────────────────────────

const uploadedGroupFiles = new Map(); // `${groupId}:${fileId}` -> { name, at, onebot }

function rememberGroupFile(chatKey, fileId, name) {
  if (!String(chatKey).startsWith('group:') || !fileId) return;
  uploadedGroupFiles.set(`${chatKey}:${fileId}`, { chatKey, fileId, name, at: Date.now() });
}

async function cleanupGroupFiles() {
  const days = cfg().groupFileKeepDays;
  if (!days) return;
  const deadline = Date.now() - days * 86400000;
  for (const [key, item] of uploadedGroupFiles) {
    if (item.at > deadline) continue;
    uploadedGroupFiles.delete(key);
    const onebot = currentOnebotRef;
    if (!onebot) continue;
    const [, groupId] = String(item.chatKey).split(':');
    const r = await deleteGroupFile(onebot, groupId, item.fileId);
    log(`群文件到期清理：${item.name} → ${r.ok ? '已删除' : `删除失败 ${r.error}`}`);
  }
}

// 清理群文件需要一个 onebot 客户端；任务跑完时在上下文里取一个最可靠的
let currentOnebotRef = null;

// ───────────────────────── 本地文件清理 ─────────────────────────

async function cleanupLocal() {
  const days = cfg().keepDays;
  if (!days) return { removed: 0 };
  const root = downloadRoot();
  if (!fs.existsSync(root)) return { removed: 0 };
  const deadline = Date.now() - days * 86400000;
  let removed = 0;
  try {
    const groups = await fsp.readdir(root, { withFileTypes: true });
    for (const g of groups) {
      if (!g.isDirectory() || !/^jm-\d+$/.test(g.name)) continue;
      const gp = path.join(root, g.name);
      for (const item of await fsp.readdir(gp, { withFileTypes: true })) {
        const target = path.join(gp, item.name);
        try {
          const st = await fsp.stat(target);
          if (st.mtimeMs < deadline) {
            await fsp.rm(target, { recursive: true, force: true });
            removed += 1;
          }
        } catch {
          /* 单个失败不影响其它 */
        }
      }
      // 组目录空了就删掉
      try {
        if ((await fsp.readdir(gp)).length === 0) await fsp.rmdir(gp);
      } catch {
        /* ignore */
      }
    }
  } catch (error) {
    warn(`本地清理出错（已跳过）：${error?.message ?? error}`);
  }
  return { removed };
}

// ───────────────────────── 指令来源 ─────────────────────────

/**
 * 2026-10-06 修复「首次发车：群友」：
 *
 * 原来的键只取 sessionId，但**同一个群每轮对话都是新 session**。
 * 于是场景一变就认不出人：
 *   · 群友在私聊里发 JM123 → 归属记在 private:xxx 的 session 上；
 *   · 同一个本子后来在群里被引用（命中 12 小时 PDF 缓存）→ 群 session 查自己的
 *     键查不到 → first 为 null → 落到字面占位符 "群友"，
 *     结果所有人都被记成同一个"群友"。
 *
 * 现在改成**按会话（chatKey）记**，session 只作为兜底：
 * 同一个群里不管换多少轮 session，认到的都是同一个人。
 */
function callerKeys(ctx = {}) {
  const keys = [];
  const chat = String(ctx?.chatKey || '');
  const sess = String(ctx?.sessionId || '');
  if (chat) keys.push(`chat:${chat}`);
  if (sess) keys.push(`sess:${sess}`);
  return keys;
}

/** 兼容旧调用：取第一个（最优先）的键。 */
const callerKey = (ctx) => callerKeys(ctx)[0] || '';

function recordCallers(ctx = {}) {
  try {
    const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
    const keys = callerKeys(ctx);
    if (!keys.length || !entries.length) return;

    const candidates = [];
    // 2026-10-06 修复「首次发车认错人」：
    //   原来 first = 批次里**最早**的一条非自己消息 —— 但触发器批次里
    //   经常先有别人插话（"脑子?"），于是把旁观者记成了发车的人。
    //   真正下指令的是 **@了机器人** 的那条；没有 @ 才退回最早的一条。
    const atMe = entries.filter((e) => e && !e.self && e.atMe === true
      && (e.senderId || e.senderName));
    const firstReal = entries.find((e) => e && !e.self && (e.senderId || e.senderName));
    const first = atMe[0] || firstReal;

    for (const e of entries) {
      if (e?.atMe === true) candidates.push({ id: String(e.senderId || ''), name: String(e.senderName || '') });
    }
    const last = entries[entries.length - 1];
    if (last && !last.self) candidates.push({ id: String(last.senderId || ''), name: String(last.senderName || '') });
    // 兜底：连 @ 都没有时，把最早说话的人也放进候选
    if (firstReal) candidates.push({ id: String(firstReal.senderId || ''), name: String(firstReal.senderName || '') });

    const rec = {
      first: first ? { id: String(first.senderId || ''), name: String(first.senderName || '') } : null,
      candidates,
      at: Date.now()
    };
    for (const k of keys) callerLog.set(k, rec);
  } catch (error) {
    warn(`记录指令来源失败：${error?.message ?? error}`);
  }
}

/** 读回指令来源：先按会话找，再退回本 session。 */
function lookupCaller(ctx = {}) {
  for (const k of callerKeys(ctx)) {
    const hit = callerLog.get(k);
    if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit;
  }
  return null;
}

// ───────────────────────── 生命周期 ─────────────────────────

export function setup(injected) {
  api = injected;
  void loadHistory();
  workerCache = { at: 0, result: null };

  // ── 工具 1：下载 ──────────────────────────────────────────────────────────
  api.registerTool({
    id: 'download_album',
    name: '下载禁漫漫画',
    category: 'media',
    icon: '📚',
    description:
      '把一本禁漫天堂（JMComic）漫画按 ID 下载到机器人本地，并（按设置）还原竖切、合成 PDF、'
      + '上传到「提出请求的这个会话」。'
      + '当群友发来漫画 ID（如 123456、jm123456、JM-123456）或 album 链接并希望下载时使用。'
      + '参数 album_id 传纯数字 ID（从对方消息里取，不要自己编）。'
      + '只在对方明确想下载时调用；消息里随便出现一个数字不要调用，拿不准先问一句。'
      + '这个工具是**异步顺序队列**：调用后立刻返回，任务按顺序一本一本跑；队列挂在机器人身上，**跟这次对话结不结束无关**，重启也接着跑。多个车牌请分多次调用（一次一个 ID），不要重复提交同一个。'
      + '不要因为看不到结果就重复调用同一个 ID。',
    parameters: {
      type: 'object',
      properties: {
        album_id: {
          type: ['integer', 'string'],
          description: '禁漫漫画 ID，纯数字，例如 123456（6~7 位）。也可传整条链接，工具会自己提取数字。**一次只传一个**：对方一次发了好几个车牌，就分几次调用本工具，它们会依次排队、按顺序一本一本下完。',
        },
      },
      required: ['album_id'],
    },
    async execute(ctx, args) {
      const chatKey = String(ctx?.chatKey || '');
      const albumId = engine.normalizeAlbumId(args?.album_id);
      try {
        const c = cfg();
        if (!c.enabled) {
          return { content: '漫画下载功能被关掉了（技能设置里的「启用下载功能」）。请让管理员打开。', isError: true };
        }
        const denied = gateChat(chatKey);
        if (denied) return { content: denied, isError: true };
        if (!albumId) {
          return { content: '没有拿到有效的漫画 ID：album_id 必须是纯数字（例如 123456）。请从对方消息里取出数字再试。', isError: true };
        }
        if (activeTasks.has(albumId)) {
          const t = activeTasks.get(albumId);
          return { content: `JM${albumId} 已经在处理中（阶段：${t.stage}，已开始 ${Math.round((Date.now() - t.startedAt) / 1000)} 秒）。不要重复调用。` };
        }
        if (!chatKey) return { content: '拿不到会话信息，无法在群里汇报结果。请在群聊里再试一次。', isError: true };

        // 权限（工具的 ctx 里没有发送者，用钩子记下的 callerLog）
        const perm = await checkPermission(ctx);
        if (!perm.ok) return { content: perm.reason, isError: true };


        const c2 = cfg();
        // 2026-10-06：查不到人时**不要**再写死 "群友" 进存档 ——
        // 那会把所有认不出的人都写成同一个名字，而且会永久落盘。
        // 宁可为空（显示层会跳过这一行），也不要写进一个假名字。
        const caller = lookupCaller(ctx);
        const firstCaller = caller?.first || perm.caller || { id: '', name: '' };
        const attributionKey = `${chatKey}:${albumId}`;
        if (!firstSubmitters.has(attributionKey)) {
          firstSubmitters.set(attributionKey, {
            id: firstCaller.id || '',
            name: firstCaller.name || '',
            at: Date.now()
          });
          if (!firstCaller.name) {
            warn(`JM${albumId} 没能认出首次发车的人（caller 为空）→ 这次先留空，不写占位名`);
          }
        }
        const task = {
          albumId,
          chatKey,
          kind: String(ctx?.kind || ''),
          who: firstCaller.id || '',
          whoName: firstCaller.name || '',
          control: { paused: false, deleted: false, child: null },
          stage: 'queued',
          startedAt: Date.now(),
          sender: ctx?.sender ?? null,
          onebot: ctx?.onebot ?? null,
        };
        activeTasks.set(albumId, task);
          activeByChat.set(chatKey, albumId);
          if (ctx?.onebot) currentOnebotRef = ctx.onebot;
          // 进有序队列：由 pump() 一本一本跑（对话结束、进程重启都不影响）
          taskQueue.push(albumId);
          saveQueue();
          void pump();

        const worker = detectWorker();
        const plan = [
          c2.outputFormat === 'pdf' ? '合成 PDF' : '保留图片',
          c2.restore && worker.ok ? '还原竖切' : '',
          c2.uploadMode === 'off' ? '不上传' : '上传到本会话',
        ].filter(Boolean).join(' + ');

        return {
          content:
            `JM${albumId} 已经排上队开始处理了（${plan}）。`
            + '已进队列，会按顺序一本一本跑；**跟这次对话结不结束无关**，跑完自动把结果发到群里。'
            + (activeTasks.size > 1 ? `当前队列/处理中一共 ${activeTasks.size} 本。` : '')
            + '不要重复提交同一个 ID；只用一句话告诉群友「已排队，按顺序处理」即可。',
        };
      } catch (error) {
        activeTasks.delete(albumId);
        if (activeByChat.get(chatKey) === albumId) activeByChat.delete(chatKey);
        warn(`入队失败 JM${albumId}：${error?.message ?? error}`);
        return { content: `排任务失败：${error?.message ?? error}`, isError: true };
      }
    },
  });

  // ── 工具 2：查任务状态 ────────────────────────────────────────────────────
  api.registerTool({
    id: 'control',
    name: '控制JM任务（暂停/继续/删除）',
    category: 'media',
    icon: '🎮',
    description:
      '控制一个正在处理的禁漫任务：action 填 "pause" 暂停下载、"resume" 继续下载、"delete" 删除（终止任务并清掉本地文件与已上传的群文件）。'
      + 'album_id 传纯数字 ID。群友发「暂停下载 JM123」「继续下载 JM123」「删除JM123」这类指令时使用。'
      + '结果由工具自己发到群里；调用一次就够，不要重复调用，也不要自己再编一条结果。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['pause', 'resume', 'delete'],
          description: 'pause=暂停下载，resume=继续下载，delete=删除（任务+本地文件+群文件）',
        },
        album_id: {
          type: ['integer', 'string'],
          description: '禁漫漫画 ID，纯数字，例如 123456。',
        },
      },
      required: ['action', 'album_id'],
    },
    async execute(ctx, args) {
      try {
        const chatKeyEarly = String(ctx?.chatKey || '');
        const deniedEarly = gateChat(chatKeyEarly);
        if (deniedEarly) return { content: deniedEarly, isError: true };
        const action = String(args?.action || '').toLowerCase();
        const albumId = engine.normalizeAlbumId(args?.album_id);
        if (!['pause', 'resume', 'delete'].includes(action)) {
          return { content: 'action 只能是 pause / resume / delete。', isError: true };
        }
        if (!albumId) return { content: 'album_id 必须是纯数字 ID（如 123456）。', isError: true };
        const chatKey = String(ctx?.chatKey || '');
        const text = await performControl({ action, albumId, onebot: ctx?.onebot ?? null, chatKey });
        // 结果直接发到当前会话（跟 today_list 一样自己发，避免模型复述丢消息）
        const sent = await sendText(ctx?.sender, ctx?.onebot, chatKey, text);
        return {
          content: sent
            ? `结果已直接发到群里（${text}）。你**不要**再复述这条结果，也不要重复调用本工具。`
            : `${text}\n（注意：这条结果没能自动发出去，请原样转告群友。）`,
        };
      } catch (error) {
        warn(`控制指令执行失败：${error?.message ?? error}`);
        return { content: `控制指令执行失败：${error?.message ?? error}`, isError: true };
      }
    },
  });

  // ── 工具：JM 群开关（机主自由选择哪些群可用）──────────────────────────────
  // 群主/管理员（或 allowIds 白名单 QQ）在目标群里说「开启JM」「关闭JM」即可；
  // 「JM群列表」查看；「JM所有群开放」恢复默认（所有群可用）。
  api.registerTool({
    id: 'group_toggle',
    name: '管理JM群开关',
    category: 'media',
    icon: '🔐',
    description:
      '按群开启/关闭 JM 漫画功能，或查看已开启的群。'
      + '当有人说「开启JM」「关闭JM」「JM群列表」「JM所有群开放」时使用。'
      + 'action 参数：on=开启当前群，off=关闭当前群，list=查看名单，all=恢复所有群开放。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'on / off / list / all', enum: ['on', 'off', 'list', 'all'] },
      },
      required: ['action'],
    },
    async execute(ctx, args) {
      const action = String(args?.action || 'list').toLowerCase();
      const chatKey = String(ctx?.chatKey || '');
      const [kind, chatId] = chatKey.split(':');
      const st = loadGroupState();
      const reply = async (text) => {
        const sent = await sendText(ctx?.sender, ctx?.onebot, chatKey, text);
        return {
          content: sent
            ? `结果已直接发到会话（${text}）。你**不要**再复述，也不要重复调用本工具。`
            : `${text}\n（注意：这条结果没能自动发出去，请原样转告。）`,
        };
      };

      if (action === 'list') {
        const ids = Object.keys(st.groups || {}).filter(Boolean);
        const text = ids.length
          ? `📋 已开启 JM 的群（${ids.length} 个）：\n${ids.map((gid, i) => {
              const g = st.groups[gid] || {};
              return `${i + 1}. ${gid}${g.name ? '「' + g.name + '」' : ''}`;
            }).join('\n')}\n\n在目标群里发「开启JM」新增、「关闭JM」移除；「JM所有群开放」恢复所有群可用。`
          : '当前所有群都可用 JM（未开启白名单模式）。\n在目标群里发「开启JM」即开启白名单模式并加入该群。';
        return reply(text);
      }

      // on/off/all 都是"改权限"的操作：只允许 群主/管理员/allowIds 白名单
      if (kind !== 'group') {
        return { content: '开启/关闭是按群生效的。请到目标群里发「开启JM」或「关闭JM」。', isError: true };
      }
      const c = cfg();
      const allow = new Set(String(c.allowIds || '').split(/[\s,;，、]+/).map((s) => s.trim()).filter(Boolean));
      const caller = lookupCaller(ctx);
      const candidate = caller && Date.now() - caller.at < 120000 ? caller.candidates?.[0] : null;
      if (!candidate?.id) {
        return { content: '认不出是谁在下指令。请 @我 再说一次「开启JM」/「关闭JM」。', isError: true };
      }
      let role = '';
      try {
        const info = await ctx.onebot.call('get_group_member_info', {
          group_id: Number(chatId), user_id: Number(candidate.id), no_cache: true,
        });
        role = String(info?.role || 'member');
      } catch (error) {
        warn(`查询群身份失败：${error?.message ?? error}`);
      }
      const isAllow = allow.size > 0 && allow.has(candidate.id);
      if (!isAllow && role !== 'owner' && role !== 'admin') {
        return {
          content: `只有群主/管理员（或白名单 QQ）能开关 JM 功能（你是 ${role || '普通成员'}）。`,
          isError: true,
        };
      }

      if (action === 'on') {
        let gname = '';
        try {
          const gi = await ctx.onebot.call('get_group_info', { group_id: Number(chatId) });
          gname = String(gi?.group_name || '');
        } catch { /* 拿不到群名就不显示 */ }
        st.groups[chatId] = { by: candidate.id, name: gname, at: new Date().toISOString() };
        saveGroupState(st);
        const wasFirst = Object.keys(st.groups).filter(Boolean).length === 1;
        const extra = wasFirst
          ? '\n（已进入白名单模式：从现在起只有已开启的群能用 JM，私聊不受影响。「JM所有群开放」可恢复。）'
          : '';
        return reply(`✅ 已在本群${gname ? `「${gname}」` : ''}开启 JM 功能${extra}`);
      }
      if (action === 'off') {
        const had = Boolean(st.groups[chatId]);
        delete st.groups[chatId];
        saveGroupState(st);
        const rest = Object.keys(st.groups).filter(Boolean).length;
        const extra = rest === 0 ? '\n（名单已清空：恢复为所有群都可用 JM。）' : '';
        return reply(had
          ? `✅ 已在本群关闭 JM 功能。群友再发 JM 请求会被婉拒。${extra}`
          : `本群本来就没有开启 JM。${extra}`);
      }
      if (action === 'all') {
        st.groups = {};
        saveGroupState(st);
        return reply('✅ 已恢复默认：所有群都可用 JM。');
      }
      return { content: 'action 只能是 on / off / list / all。', isError: true };
    },
  });

  api.registerTool({
    id: 'task_status',
    name: '查询漫画下载进度',
    category: 'media',
    icon: '⏳',
    description:
      '查询正在处理的漫画下载任务，以及最近的处理记录（成功/失败原因）。'
      + '当群友问「下好了吗」「刚才那个怎么没动静」「为什么失败了」时使用。无参数。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        await loadHistory();
        const chatKey = String(ctx?.chatKey || '');
        const denied = gateChat(chatKey);
        if (denied) return { content: denied, isError: true };
        const lines = [];

        const waitingList = taskQueue.map((id) => activeTasks.get(id)).filter((t) => t && (!chatKey || t.chatKey === chatKey));
          if (waitingList.length) lines.push(`排队中 ${waitingList.length} 本（按此顺序）：${waitingList.map((t) => 'JM' + t.albumId).join('、')}`);
          const mine = [...activeTasks.values()].filter((t) => t.stage !== 'queued' && (!chatKey || t.chatKey === chatKey));
        if (mine.length) {
          lines.push(`正在处理 ${mine.length} 本：`);
          for (const t of mine) {
            lines.push(`· JM${t.albumId}（${t.stage}，已 ${Math.round((Date.now() - t.startedAt) / 1000)} 秒）`);
          }
        } else {
          lines.push('当前没有正在处理的任务（排队情况看上一行）。');
        }

        const recent = taskHistory.filter((h) => !chatKey || h.chatKey === chatKey).slice(0, 5);
        if (recent.length) {
          lines.push('', '最近记录：');
          for (const h of recent) {
            const when = String(h.at || '').slice(5, 16).replace('T', ' ');
            lines.push(h.ok
              ? `· ${when} JM${h.id}「${toSimplified(h.title || '')}」成功，${h.pagesOk || 0}/${h.pages || 0} 张`
              : `· ${when} JM${h.id} 失败（${h.stage}）：${h.error || '未知原因'}`);
          }
        }
        return { content: lines.join('\n') };
      } catch (error) {
        warn(`查询任务状态失败：${error?.message ?? error}`);
        return { content: `查询失败：${error?.message ?? error}`, isError: true };
      }
    },
  });

  // ── 工具 3：本地收藏 ──────────────────────────────────────────────────────
  // ── 工具 5：今日JM 列表（编号 + 漫画名 + 作者/页数/标签）────────────────────
  api.registerTool({
    id: 'today_list',
    name: '今日JM',
    category: 'media',
    icon: '📋',
    description:
      '把机器人本地已下载的禁漫漫画做成一张信息图发到会话'
      + '（封面卡片网格：JM编号+标题+页数+作者+标签，一张图看完；删除过的本子会自动消失）。'
      + '当群友说「今日JM」「今天的JM」「今天有什么JM」「JM列表」「本地有哪些漫画」时使用。无参数。'
      + '内容由工具直接发到会话，返回后你不要再复述、不要重复调用。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      // today_list_selfsend
      // ⚠️ 这个工具**自己把消息发出去**，不靠模型再说一轮。
      //    原因：config.api.maxRounds = 1，模型只有一轮 —— 它调完工具后循环就结束了，
      //    根本没有第二次机会把工具结果发出来（会话会以 noreply 收尾，用户什么也看不到）。
      //    下载工具也是同样的思路：后台自己发消息，工具只负责入队。
      const chatKey = String(ctx?.chatKey || '');
      try {
        const denied = gateChat(chatKey);
        if (denied) return { content: denied, isError: true };
        const root = downloadRoot();
        const emptyText = fs.existsSync(root)
          ? '本地漫画列表是空的。把漫画编号发给我就能下。'
          : '本地还没有任何漫画。把漫画编号发给我就能下。';

        // 图片版（主路径）：本地书架信息图
        if (fs.existsSync(root)) {
          try {
            const items = await buildTodayItems(root);
            if (!items.length) {
              const sent = await sendText(ctx?.sender, ctx?.onebot, chatKey, emptyText);
              return { content: sent ? '已把「本地还没有漫画」发到群里。你不要再复述，也不要重复调用本工具。' : emptyText };
            }
            const payload = {
              title: `📚 今日JM 本地书架 ${items.length} 本`,
              subtitle: `${new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)}（东八区）· 已删除的本子自动移出`,
              footnote: `共 ${items.length} 本 · 发漫画编号即可下载`,
              items,
            };
            const imagePath = await renderDigestImage({ payload, outPath: path.join(root, '..', 'today-list.jpg') });
            const sent = await sendDigestImage({ onebot: ctx?.onebot, chatKey, payload, imagePath });
            if (sent === true) {
              return {
                content: `今日JM 信息图已直接发到群里（本地书架 ${items.length} 本，一张图）。`
                  + '你**不要**再复述清单内容，不要调用 send_message 重复发送，也不要重复调用本工具。',
              };
            }
            warn(`今日JM 信息图发送失败，降级文字版：${sent?.error ?? sent}`);
          } catch (imgErr) {
            warn(`今日JM 信息图路径失败，降级文字版：${imgErr?.message ?? imgErr}`);
          }
        }

        // 兜底：文字版（原实现）
        const built = fs.existsSync(root) ? await buildTodayList(root) : { text: '', count: 0 };
        const fallback = built.text || emptyText;
        const sent = await sendText(ctx?.sender, ctx?.onebot, chatKey, fallback);
        return {
          content: sent
            ? '今日JM 列表已经直接发给群友了（工具自己发的）。你**不要**再复述一遍列表，'
              + '也不要调用 send_message 重复发送，更不要重复调用本工具。'
            : fallback,
        };
      } catch (error) {
        warn(`生成今日JM列表失败：${error?.message ?? error}`);
        return { content: `生成今日JM列表失败：${error?.message ?? error}`, isError: true };
      }
    },
  });

  // ── 工具：「更新JM」每日更新清单（站点当日新上架/新章节，带类型与封面）──
  api.registerTool({
    id: 'daily_updates',
    name: '更新JM',
    category: 'media',
    icon: '🆕',
    description:
      '列出禁漫今天新更新（新上架/新章节）的漫画清单，做成一张信息图发到会话'
      + '（封面网格卡片：编号+ID+标题+类型+标签，一张图看完）。'
      + '数据由采集器每 30 分钟自动抓取，无需联网等待。'
      + '当群友说「更新JM」「JM更新」「更新列表」「今日更新」「今天有什么更新」「日更」时使用。无参数。'
      + '内容由工具直接发到会话，返回后你不要再复述、不要重复调用。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      // daily_updates_selfsend：与 today_list 相同的理由 —— config.api.maxRounds = 1，
      // 工具必须自己把成品发出去，不能指望模型再转述一轮。
      const chatKey = String(ctx?.chatKey || '');
      try {
        const denied = gateChat(chatKey);
        if (denied) return { content: denied, isError: true };
        const payload = await loadDigestItems({ simplify: toSimplified, translate: ensureTranslatedTitles });
        if (!payload.items.length) {
          const text = '今天还没有采集到禁漫更新（每 30 分钟自动抓一次，先等等再看）。';
          const sent = await sendText(ctx?.sender, ctx?.onebot, chatKey, text);
          return {
            content: sent
              ? '已把「今天暂无更新」发到群里。你**不要**再复述，也不要重复调用本工具。'
              : text,
          };
        }
        // 主路径：一张信息图（封面网格卡片）
        try {
          const full = {
            title: `📥 今日禁漫更新 ${payload.items.length} 本`,
            subtitle: `${payload.date} · 截至 ${payload.until} · 发漫画编号即可下载`,
            footnote: `共 ${payload.items.length} 本（站点当日新上架/新章节）`,
            items: payload.items,
          };
          const imagePath = await renderDigestImage({ payload: full });
          const sent = await sendDigestImage({ onebot: ctx?.onebot, chatKey, payload: full, imagePath });
          if (sent === true) {
            return {
              content: `每日更新信息图已直接发到群里（${payload.items.length} 本，一张图）。`
                + '你**不要**再复述清单内容，不要调用 send_message 重复发送，也不要重复调用本工具。',
            };
          }
          throw new Error(sent?.error || '会话上下文里没有可用的 onebot 发送通道');
        } catch (imgErr) {
          // 兜底：信息图渲染/发送失败 → 降级文字清单 + 封面
          warn(`信息图路径失败，降级文字版：${imgErr?.message ?? imgErr}`);
          const digest = await buildDigestFromState({ simplify: toSimplified, translate: ensureTranslatedTitles });
          const sent = await sendDigest({ onebot: ctx?.onebot, chatKey, digest });
          if (sent === true) {
            return {
              content: `每日更新清单已发到群里（文字版，${digest.count} 本）。`
                + '你**不要**再复述清单内容，也不要重复调用本工具。',
            };
          }
          return {
            content: `清单发送失败。把下面的清单文本原样发给群友：\n${digest.text}`,
          };
        }
      } catch (error) {
        warn(`生成每日更新清单失败：${error?.message ?? error}`);
        return { content: `生成每日更新清单失败：${error?.message ?? error}`, isError: true };
      }
    },
  });

  api.registerTool({
    id: 'library',
    name: '查看本地漫画收藏',
    category: 'media',
    icon: '🗂️',
    description:
      '列出机器人本地已经下载好的禁漫漫画（每本一行：ID、名称、图片数、时间）。'
      + '当群友问「本地有哪几本」「收藏里有没有 xxx」时使用。无参数。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const denied = gateChat(String(ctx?.chatKey || ''));
        if (denied) return { content: denied, isError: true };
        const root = downloadRoot();
        if (!fs.existsSync(root)) return { content: `本地还没有任何漫画（目录 ${root} 还不存在）。` };
        const entries = await scanLibrary(root);
        if (!entries.length) return { content: '本地收藏是空的。群友把漫画 ID 发给我就能下。' };
        entries.sort((a, b) => b.mtime - a.mtime);
        const lines = entries.slice(0, 30).map((e) => {
          const when = new Date(e.mtime).toISOString().slice(0, 16).replace('T', ' ');
          return `· JM${e.id}「${e.name}」${e.pages ? `${e.pages} 张 · ` : ''}${e.pdf ? '有 PDF · ' : ''}${when}`;
        });
        return {
          content: `本地收藏共 ${entries.length} 本（列出最近 ${Math.min(30, entries.length)} 本）：\n${lines.join('\n')}\n\n目录：${root}`,
        };
      } catch (error) {
        warn(`读取本地收藏失败：${error?.message ?? error}`);
        return { content: `读取本地收藏失败：${error?.message ?? error}`, isError: true };
      }
    },
  });

  // ── 工具 4：存储与能力自检 ────────────────────────────────────────────────
  api.registerTool({
    id: 'storage',
    name: '查看存储与能力状态',
    category: 'system',
    icon: '🔧',
    description:
      '查看这个技能的环境状态：下载目录占用、是否具备还原/PDF 能力（Python + Pillow）、'
      + '当前群的群文件配额。当群友问「支持 PDF 吗」「磁盘满了吗」「群文件还有空间吗」时使用。无参数。',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      try {
        const denied = gateChat(String(ctx?.chatKey || ''));
        if (denied) return { content: denied, isError: true };
        const c = cfg();
        const root = downloadRoot();
        const usage = await dirSize(root);
        const worker = detectWorker(true);
        const lines = [
          `下载目录：${root}`,
          `已占用：${humanSize(usage.bytes)}（${usage.files} 个文件）`,
          `清理策略：本地保留 ${c.keepDays || '不'} 天${c.groupFileKeepDays ? `，群文件 ${c.groupFileKeepDays} 天后自动删除` : ''}`,
          `输出格式：${c.outputFormat === 'pdf' ? 'PDF' : '原始图片'}${c.restore ? '（开启竖切还原）' : ''}`,
          `合成 PDF 后删除原图：${c.deleteImagesAfterPdf ? '已开启（PDF 失败时会自动保留原图）' : '未开启'}`,
          `还原/PDF 能力：${worker.ok
            ? `可用（Python ${worker.python.split(/[\\/]/).pop()}，Pillow ${worker.pillow}）`
            : `不可用 —— ${worker.error}。会降级为原样保存图片。`}`,
          `上传模式：${{ off: '不上传', request: '传回提出请求的会话', group: '只传群', private: '只传私聊' }[c.uploadMode]}`,
          `单文件上限：${c.maxUploadMB} MB${c.rejectOversize ? '（超限拒绝）' : '（超限自动分卷）'}`,
          `允许触发：${c.allowIds ? `仅管理员/白名单（${c.allowIds}）` : '所有人'}`,
        ];
        if (String(ctx?.kind) === 'group' && ctx?.onebot) {
          const q = await groupQuota(ctx.onebot, ctx.chatId);
          lines.push(q.ok
            ? `本群群文件：${q.fileCount}/${q.limitCount} 个，已用 ${humanSize(q.usedSpace)} / ${humanSize(q.totalSpace)}`
            : `本群群文件配额查询失败：${q.error}`);
        }
        return { content: lines.join('\n') };
      } catch (error) {
        warn(`存储自检失败：${error?.message ?? error}`);
        return { content: `自检失败：${error?.message ?? error}`, isError: true };
      }
    },
  });

  // 定时清理（本地 + 群文件）。activate 里起，deactivate 里必须清掉。
  log(`禁漫漫画下载技能已加载（目录：${downloadRoot()}，输出：${cfg().outputFormat}）`);
}

export function activate() {
  // 队列恢复：把上次没跑完的接着跑（"脱离对话"的关键一步）
  try { if (loadQueue()) void pump(); } catch (error) { warn(`队列恢复异常：${error?.message ?? error}`); }
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(() => {
    void cleanupLocal();
    void cleanupGroupFiles();
  }, 6 * 3600 * 1000);
  // 启动时先跑一次，别等 6 小时
  setTimeout(() => {
    void cleanupLocal();
  }, 20000);
  log('已启动：定时清理与任务队列就绪');
}

export function deactivate() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  log('已停用：定时清理已停止（正在进行的下载任务不会被中断）');
}

export function dispose() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = null;
  activeTasks.clear();
  activeByChat.clear();
  callerLog.clear();
  pendingHint.clear();
  uploadedGroupFiles.clear();
  currentOnebotRef = null;
}

// ───────────────────────── 目录统计 / 收藏扫描 ─────────────────────────

async function dirSize(root) {
  let bytes = 0;
  let files = 0;
  async function walk(p) {
    let entries = [];
    try {
      entries = await fsp.readdir(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const target = path.join(p, e.name);
      if (e.isDirectory()) {
        await walk(target);
      } else {
        try {
          bytes += (await fsp.stat(target)).size;
          files += 1;
        } catch {
          /* ignore */
        }
      }
    }
  }
  await walk(root);
  return { bytes, files };
}

/**
 * 「今日JM」：列出本地已下载的漫画，每个编号后标注漫画名、作者、页数、标签。
 * 纯本地读取（data/<技能 id>/<id>/<子目录>/metadata.json），不联网、不受站点波动影响。
 *
 * 排序：按下载时间倒序（最近下的在前）。
 * 每本一行：
 *   · JM350234「董卓 上+下」— 作者：孫笑川 等 · 50 页 · 标签：中文/劇情向 · 有PDF
 */
/**
 * 本地书架的结构化条目（给信息图渲染用）。
 * 与 buildTodayList 同源（scanLibrary 实时扫描 → 删除过的本子自然消失），
 * 共用「繁→简 + 日文标题翻译」流程。返回 [{ id, title, kind, tags, cover }]
 */
async function buildTodayItems(root, { limit = 50 } = {}) {
  const entries = await scanLibrary(root);
  if (!entries.length) return [];

  const detail = new Map();
  for (const e of entries) {
    detail.set(String(e.id), e.meta || null);
  }
  const stamp = (e) => {
    const iso = detail.get(String(e.id))?.downloadedAt;
    const t = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(t) ? t : Number(e.mtime || 0);
  };
  entries.sort((a, b) => stamp(b) - stamp(a));
  const shown = entries.slice(0, limit);

  // 日语标题翻译（与文字版同一份磁盘缓存，翻过一次就不再花 token）
  await ensureTranslatedTitles(shown.map((e) => {
    const meta = detail.get(String(e.id)) || {};
    const zh = toSimplified(String(meta.name || e.name || '').trim());
    return { title: zh, apply: (t) => { const x = toSimplified(String(t || '').trim()); if (x) meta.name = x; } };
  }));

  const mapped = shown.map((e) => {
    const meta = detail.get(String(e.id)) || {};
    const rawName = toSimplified(String(meta.name || e.name || ('JM' + e.id)).trim());
    const name = cleanTitle(rawName) || rawName;
    const pages = Number(meta.pages || e.pages || 0);
    const authors = Array.isArray(meta.authors)
      ? meta.authors.map((a) => toSimplified(String(a).trim())).filter((a) => a && a !== 'N/A')
      : [];
    const tags = Array.isArray(meta.tags)
      ? meta.tags.map((t) => toSimplified(String(t).trim())).filter(Boolean)
      : [];
    return {
      id: String(e.id),
      title: name,
      kind: [pages ? `${pages} 页` : '', e.pdf ? 'PDF' : ''].filter(Boolean).join('·'),
      tags: [...authors.slice(0, 2), ...tags.slice(0, 3)],
      cover: firstPageImage(e.dir),
    };
  });
  // 封面兜底：本地图被「合成 PDF 后删原图」清掉时，从站点拉（daily-covers 有缓存）
  for (const it of mapped) {
    if (it.cover) continue;
    try {
      it.cover = await fetchSiteCover(it.id);
    } catch { /* 拉不到就显示"无封面"占位 */ }
  }
  return mapped;
}

/**
 * 找目录里的第一张页面图当卡片缩略图（本地书架没有独立封面文件）。
 * 递归找（≤3 层）：章节本子的图片在 <章节子目录>/00001.webp 里。
 */
function firstPageImage(dir, depth = 0) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const images = entries
      .filter((x) => x.isFile() && /\.(jpe?g|png|webp)$/i.test(x.name))
      .map((x) => x.name)
      .sort();
    for (const f of images) {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 4096) return p;
    }
    if (depth < 3) {
      const dirs = entries
        .filter((x) => x.isDirectory())
        .map((x) => x.name)
        .sort();
      for (const d of dirs) {
        const hit = firstPageImage(path.join(dir, d), depth + 1);
        if (hit) return hit;
      }
    }
  } catch { /* 目录读不了就算了 */ }
  return '';
}

async function buildTodayList(root, { limit = 50 } = {}) {    const entries = await scanLibrary(root);
    if (!entries.length) return { text: '', count: 0 };

    // 尽量读取 metadata.json 拿作者/标签；读不到就用目录名/路径兜底
    const detail = new Map();
    for (const e of entries) {
        let meta = e.meta || null;
        if (!meta) {
            try {
                const dir = e.dir || e.path || '';
                if (dir) {
                    meta = JSON.parse(await fsp.readFile(path.join(dir, 'metadata.json'), 'utf8'));
                }
            } catch {
                meta = null;
            }
        }
        detail.set(String(e.id), meta);
    }

    const stamp = (e) => {
        const iso = detail.get(String(e.id))?.downloadedAt;
        const t = iso ? Date.parse(iso) : NaN;
        return Number.isFinite(t) ? t : Number(e.mtime || 0);
    };
    entries.sort((a, b) => stamp(b) - stamp(a));
    const shown = entries.slice(0, limit);

    // 日语标题翻译（2026-10-06）：标题含假名才翻，结果按原文缓存到磁盘。
    // 把译文写回 meta.name，后面的渲染逻辑就能直接用上。
    await ensureTranslatedTitles(shown.map((e) => {
        const meta = detail.get(String(e.id)) || {};
        const zh = toSimplified(String(meta.name || e.name || '').trim());
        return {
            title: zh,
            apply: (translated) => {
                const t = toSimplified(String(translated || '').trim());
                if (t) meta.name = t;
            },
        };
    }));

    const lines = shown.map((e) => {
        const meta = detail.get(String(e.id)) || {};
        // 2026-10-06：这里有三个坑一起修
        //   ① name/authors/tags/description 之前是从磁盘**原样**读出来的，
        //      没再过 toSimplified，于是列表里全是繁体（简介尤其明显）；
        //   ② "首次发车" 只给了昵称、没给 QQ 号；
        //   ③ 行太长。现在统一化简 + 补 QQ 号。
        const rawName = toSimplified(String(meta.name || e.name || ('JM' + e.id)).trim());
        // 去掉常见的汉化组/翻译组前缀，避免每行都被 [xxx漢化組] 顶满
        // 例："[禁漫漢化組](C108)[餃子部]妄想秘話" -> "妄想秘話"
        let name = rawName
            .replace(/^\s*(?:\[[^\]]*\]|\([^)]*\)|【[^】]*】)+\s*/g, '')
            .replace(/\s*\[[^\]]*?(?:漢化|汉化|翻譯|翻译|漢化組|字幕|掃圖|嵌字)[^\]]*?\]\s*/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
        if (!name) name = rawName;
        // 仍然过长就截断，保证一行可读
        const shortName = name.length > 42 ? name.slice(0, 42) + '…' : name;
        const authors = Array.isArray(meta.authors)
            ? meta.authors.map((a) => toSimplified(String(a).trim())).filter((a) => a && a !== 'N/A')
            : [];
        const tags = Array.isArray(meta.tags)
            ? meta.tags.map((t) => toSimplified(String(t).trim())).filter(Boolean)
            : [];
        const pages = Number(meta.pages || e.pages || 0);

        const bits = [];
        if (authors.length) bits.push('作者：' + authors.slice(0, 3).join('、') + (authors.length > 3 ? ' 等' : ''));
        if (pages) bits.push(pages + ' 页');
        if (tags.length) bits.push('标签：' + tags.slice(0, 5).join('/') + (tags.length > 5 ? ' 等' : ''));
        if (e.pdf) bits.push('有 PDF');
        // 首次发车：昵称后面带上 QQ 号，方便认人（两者都没有就整段省掉）
        const fsName = toSimplified(String(meta?.firstSubmitter?.name || '').trim());
        const fsId = String(meta?.firstSubmitter?.id || '').trim();
        let submitter = '';
        if (fsName && fsId) submitter = `${fsName}(${fsId})`;
        else if (fsName) submitter = fsName;
        else if (fsId) submitter = fsId;
        const desc = toSimplified(String(meta?.description || '').trim());
        let line = '· JM' + e.id + '「' + shortName + '」' + (bits.length ? '— ' + bits.join(' · ') : '');
        if (submitter) line += '（首次发车：' + submitter + '）';
        if (desc) line += '\n   简介：' + (desc.length > 90 ? desc.slice(0, 90) + '…' : desc);
        return line;
    });

    const head = '本地漫画共 ' + entries.length + ' 本'
        + (entries.length > shown.length ? '（列出最近 ' + shown.length + ' 本）' : '') + '：';
    return {
        text: head + '\n' + lines.join('\n') + '\n\n想下载哪本，直接发编号（如 jm350234）即可。',
        count: entries.length,
    };
}

async function scanLibrary(root) {
  const out = [];
  let groups = [];
  try {
    groups = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    const groupPath = path.join(root, g.name);
    let subs = [];
    try {
      subs = await fsp.readdir(groupPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue;
      const dir = path.join(groupPath, sub.name);
      let meta = null;
      try {
        meta = JSON.parse(await fsp.readFile(path.join(dir, 'metadata.json'), 'utf8'));
      } catch {
        meta = null;
      }
      let mtime = Date.now();
      let pdf = false;
      try {
        mtime = (await fsp.stat(dir)).mtimeMs;
        pdf = (await fsp.readdir(dir)).some((f) => f.toLowerCase().endsWith('.pdf'));
      } catch {
        /* ignore */
      }
      const m = String(sub.name).match(/^(\d+)-(.*)$/);
      out.push({
        id: meta?.id || (m ? m[1] : String(g.name).replace(/^jm-/, '')),
        name: meta?.name || (m ? m[2] : sub.name),
        pages: Number(meta?.pagesOk || meta?.pages || 0) || 0,
        pdf,
        mtime,
        dir,            // 供「今日JM」读取 metadata.json 里的作者/标签
        meta,           // 已经解析好的完整元数据，避免二次读盘
      });
    }
  }
  return out;
}

// ───────────────────────── 钩子 ─────────────────────────
// ⚠️ 只有 5 个钩子名有效；工具的 ctx 里没有 triggerEntries，"谁在下指令"只能在这里记。

export const hooks = {
  async 'before-tool'(ctx = {}) {
    try {
      recordCallers(ctx);
    } catch (error) {
      warn(`before-tool 钩子出错（已跳过）：${error?.message ?? error}`);
    }
  },

  /** 组装提示词前：本轮出现"像漫画 ID"的内容时，记下来并在消息正文里补一句。 */
  async 'before-context'(ctx = {}) {
    try {
      recordCallers(ctx);
      if (!api || cfg().enabled === false) return;
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];

      // ── 「开启JM / 关闭JM / JM群列表 / JM所有群开放」群开关指令 ─────────────
      // 由 group_toggle 工具执行（权限校验在工具里做：群主/管理员/白名单）。
      // 注意：这条必须放在最前面 —— 未开启的群里也要能发「开启JM」来开通。
      const GROUP_ON_RE = /^(?:开启|打开|开通)\s*(?:JM|jm|Jm|禁漫)$/;
      const GROUP_OFF_RE = /^(?:关闭|停用)\s*(?:JM|jm|Jm|禁漫)$/;
      const GROUP_LIST_RE = /^(?:JM|jm|Jm|禁漫)群(?:列表|名单)$/;
      const GROUP_ALL_RE = /^(?:JM|jm|Jm|禁漫)所有群(?:开放|全开)?$/;
      for (const e of entries) {
        if (!e || e.self) continue;
        const raw = String(e.text || '').replace(/@\S+\s*/g, '').trim();
        if (!GROUP_ON_RE.test(raw) && !GROUP_OFF_RE.test(raw) && !GROUP_LIST_RE.test(raw) && !GROUP_ALL_RE.test(raw)) continue;
        const action = GROUP_ON_RE.test(raw) ? 'on'
          : GROUP_OFF_RE.test(raw) ? 'off'
            : GROUP_LIST_RE.test(raw) ? 'list' : 'all';
        const who = String(e.senderName || e.senderId || '群友');
        pendingGroupCmd.set(callerKey(ctx), { action, who, at: Date.now() });
        const actionText = action === 'on' ? '开启JM' : action === 'off' ? '关闭JM' : action === 'list' ? 'JM群列表' : 'JM所有群开放';
        e.text = `${actionText}（${who} 触发的固定指令）：请立刻调用工具 ${toolId('group_toggle')}，action 填 "${action}"。`
          + '工具会自己把结果发到会话，你**不要**再复述、不要补充、不要重复调用。';
        log(`JM 群开关指令命中：${actionText}（来自 ${who}）`);
        return;
      }

      const chatAllowed = isChatAllowed(String(ctx.chatKey || ''));

      // ── 「暂停下载 / 继续下载 / 删除JM」控制指令 ────────────────────────────
      // 命中就改写成强指令，让模型调用 control 工具执行（工具自己发确认），
      // 避免模型自由发挥或误把"暂停下载"当成聊天内容。
      for (const e of entries) {
        if (!e || e.self) continue;
        const cmd = parseControl(e.text);
        if (!cmd) continue;
        const who = String(e.senderName || e.senderId || '群友');
        if (!chatAllowed) {
          e.text = '（固定回复，原样发出，不要改动）：本群还没有开启 JM 漫画功能，暂停/继续/删除也用不了。'
            + '群主/管理员在群里 @我 说「开启JM」即可开通。';
          log(`JM 控制指令被群白名单拦下（${who}）`);
          return;
        }
        controlRequests.set(callerKey(ctx), { ...cmd, who, at: Date.now() });
        const actionText = cmd.action === 'pause' ? '暂停下载' : cmd.action === 'resume' ? '继续下载' : '删除JM';
        e.text = `${actionText}（${who} 触发的固定指令）：请立刻调用工具 ${toolId('control')}，`
          + `action 填 "${cmd.action}"，album_id 填 ${cmd.id}。`
          + '工具会自己把结果发到群里，你**不要**再复述、不要补充、不要重复调用。';
        log(`JM 控制指令命中：${actionText} JM${cmd.id}（来自 ${who}）`);
        return;
      }

      // ── 「今日JM」精确匹配 ────────────────────────────────────────────────
      // 命中就把本轮消息改写成一条强指令，让模型直接调 today_list 并原样输出，
      // 文案固定、行为确定，不依赖模型自由发挥。
      for (const e of entries) {
        if (!e || e.self) continue;
        const raw = String(e.text || '').replace(/@\S+\s*/g, '').trim();
        if (!TODAY_JM_RE.test(raw)) continue;
        const who = String(e.senderName || e.senderId || '群友');
        if (!chatAllowed) {
          e.text = '（固定回复，原样发出，不要改动）：本群还没有开启 JM 漫画功能。'
            + '群主/管理员在群里 @我 说「开启JM」即可开通。';
          log(`今日JM 指令被群白名单拦下（${who}）`);
          return;
        }
        pendingToday.set(callerKey(ctx), { who, at: Date.now() });
        e.text = '今日JM（' + who + ' 触发的固定指令）：请立刻调用工具 ' + toolId('today_list') + '，'
          + '然后把工具返回的文本原样发出来——不要改写、不要总结、不要补充、不要加开头结尾。';
        log('今日JM 指令命中（来自 ' + who + '）');
        return;
      }

      // ── 「更新JM」精确匹配 ────────────────────────────────────────────────
      // 站点当日更新清单（与「今日JM」本地书架区分：这里匹配「更新」字样）
      for (const e of entries) {
        if (!e || e.self) continue;
        const raw = String(e.text || '').replace(/@\S+\s*/g, '').trim();
        if (!UPDATE_JM_RE.test(raw)) continue;
        const who = String(e.senderName || e.senderId || '群友');
        if (!chatAllowed) {
          e.text = '（固定回复，原样发出，不要改动）：本群还没有开启 JM 漫画功能。'
            + '群主/管理员在群里 @我 说「开启JM」即可开通。';
          log(`更新JM 指令被群白名单拦下（${who}）`);
          return;
        }
        pendingUpdate.set(callerKey(ctx), { who, at: Date.now() });
        e.text = '更新JM（' + who + ' 触发的固定指令）：请立刻调用工具 ' + toolId('daily_updates') + '。'
          + '工具会自己把清单和封面发到群里，你**不要**再复述、不要补充、不要重复调用。';
        log('更新JM 指令命中（来自 ' + who + '）');
        return;
      }

      let hit = null;
      for (const e of entries) {
        if (!e || e.self) continue;
        const text = String(e.text || '');
        // ① 明确写了 jm / JM 前缀，或发了 album/photo 链接 —— 高置信（数字要带边界）
        const jmPrefix = text.match(/(?:^|[^0-9a-zA-Z])(?:jm|JM|Jm)[\s\-_:：#]*(\d{2,9})(?!\d)/);
        const albumLink = text.match(/\/(?:album|photo)\/(\d{2,9})(?!\d)/);
        let m = jmPrefix || albumLink;
        // 明确的 JM 前缀/album 链接就是下载请求，不再交给模型自由猜测。
        let strong = Boolean(m);
        // ② 只有 @ 了机器人 + 一句纯数字 —— 也认为是"让我下这本"
        if (!m && e.atMe === true) {
          const bare = text.replace(/@\S+\s*/g, '').trim().match(/^#?(\d{2,9})$/);
          if (bare) {
            m = bare;
            strong = true;
          }
        }
        if (m && strong) hit = { id: m[1], who: String(e.senderName || e.senderId || '群友'), entry: e };
      }
      if (!hit) return;
      // 未开启的群：ID 不当下载请求处理（数字就是普通数字），也不再提示模型。
      if (!isChatAllowed(String(ctx.chatKey || ''))) return;

      // 两条路都走：① 直接改本轮消息文本；② 留到 before-llm-messages 补 system 消息
      const note = `（这条消息里的 ${hit.id} 看起来是禁漫漫画 ID，来自 ${hit.who}。）`;
      const target = hit.entry;
      if (target && !String(target.text || '').includes('禁漫漫画 ID')) target.text = `${String(target.text || '')}${note}`;
      pendingHint.set(callerKey(ctx), {
        id: hit.id,
        who: hit.who,
        at: Date.now(),
        explicitDownload: /(?:^|[^0-9a-zA-Z])(?:jm|JM|Jm)[\s\-_:：#]*\d{2,9}(?!\d)|\/(?:album|photo)\/\d{2,9}(?!\d)/.test(String(hit.entry?.text || '')),
      });
    } catch (error) {
      warn(`before-context 钩子出错（已跳过）：${error?.message ?? error}`);
    }
  },

  /** 即将发给模型之前：把 ID 提示补成一条 system 消息（messages 是引用，可原地改）。 */
  async 'before-llm-messages'(ctx = {}) {
    try {
      const gcmd = pendingGroupCmd.get(callerKey(ctx));
      if (gcmd && Date.now() - gcmd.at < 120000) {
        pendingGroupCmd.delete(callerKey(ctx));
        if (Array.isArray(ctx.messages)) {
          const actionText = gcmd.action === 'on' ? '开启JM' : gcmd.action === 'off' ? '关闭JM'
            : gcmd.action === 'list' ? 'JM群列表' : 'JM所有群开放';
          ctx.messages.push({
            role: 'system',
            content: `[${SKILL_ID}] 本轮是「${actionText}」固定指令（来自 ${gcmd.who}）：`
              + `立刻调用 ${toolId('group_toggle')}，action 填 "${gcmd.action}"。`
              + '结果由工具自己发送，不要复述、不要重复调用。',
          });
        }
      }
      const today = pendingToday.get(callerKey(ctx));
      if (today && Date.now() - today.at < 120000) {
        pendingToday.delete(callerKey(ctx));
        if (Array.isArray(ctx.messages)) {
          ctx.messages.push({
            role: 'system',
            content: `[${SKILL_ID}] 本轮是「今日JM」固定指令：调用 ${toolId('today_list')}，`
              + '并把返回文本原样发出（不改写/不总结/不补充）。',
          });
        }
      }
      const upd = pendingUpdate.get(callerKey(ctx));
      if (upd && Date.now() - upd.at < 120000) {
        pendingUpdate.delete(callerKey(ctx));
        if (Array.isArray(ctx.messages)) {
          ctx.messages.push({
            role: 'system',
            content: `[${SKILL_ID}] 本轮是「更新JM」固定指令（来自 ${upd.who}）：`
              + `立刻调用 ${toolId('daily_updates')}，清单和封面由工具自己发送，`
              + '不要复述、不要重复调用。',
          });
        }
      }
      const ctrl = controlRequests.get(callerKey(ctx));
      if (ctrl && Date.now() - ctrl.at < 120000) {
        controlRequests.delete(callerKey(ctx));
        if (Array.isArray(ctx.messages)) {
          ctx.messages.push({
            role: 'system',
            content: `[${SKILL_ID}] 本轮是固定的「${ctrl.action}」控制指令（来自 ${ctrl.who}）：`
              + `立刻调用 ${toolId('control')}，action 填 "${ctrl.action}"，album_id 填 ${ctrl.id}。`
              + '结果由工具自己发送；不要重复调用、不要自己编回复。',
          });
        }
      }
      const rec = pendingHint.get(callerKey(ctx));
      if (!rec || Date.now() - rec.at > 120_000) return;
      pendingHint.delete(callerKey(ctx));
      if (!Array.isArray(ctx.messages)) return;
      const content =
        `[${SKILL_ID}] 本轮消息里出现了禁漫漫画 ID ${rec.id}（来自 ${rec.who}）。`
        + (rec.explicitDownload
          ? '这是明确的下载指令，必须现在调用工具 '
            + `${toolId('download_album')}，album_id 填 ${rec.id}；不要先追问确认，也不要只聊天。`
          : '如果对方是想让你下载这本漫画（或你上一轮已经答应帮他下），现在就调用工具 '
            + `${toolId('download_album')}，album_id 填 ${rec.id}；如果只是顺口提到的数字，不要调用，先问一句确认。`)
        + '这个工具是异步的，调用后会立刻返回，不要重复调用。';
      if (ctx.messages.some((m) => String(m?.content || '').includes(`[${SKILL_ID}] 本轮消息里出现了禁漫漫画 ID ${rec.id}`))) return;
      ctx.messages.push({ role: 'system', content });
    } catch (error) {
      warn(`before-llm-messages 钩子出错（已跳过）：${error?.message ?? error}`);
    }
  },
};

// ───────────────────────── 可用性自检 ─────────────────────────

export function available() {
  const c = cfg();
  if (!c.enabled) return { ok: false, reason: '技能设置里的「启用下载功能」是关的' };
  if (!fetchImpl()) return { ok: false, reason: '当前运行环境没有可用的 fetch，无法联网下载' };
  const root = downloadRoot();
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch (error) {
    return { ok: false, reason: `下载目录不可写（${root}）：${error?.message ?? error}` };
  }
  // Python/Pillow 缺失只是降级，不算不可用 —— 这里把状态说清楚，UI 里能看到
  const worker = detectWorker();
  if (c.outputFormat === 'pdf' && c.restore && !worker.ok) {
    return {
      ok: true,
      reason: '',
      detail: `PDF/还原不可用（${worker.error}），会降级为「原样保存图片」。装好 Pillow 或在设置里填 Python 路径即可启用。`,
    };
  }
  return { ok: true, detail: worker.ok ? `PDF/还原可用（Pillow ${worker.pillow}）` : '' };
}

export function promptSections() {
  const c = cfg();
  const worker = detectWorker();
  const bits = [];
  if (c.outputFormat === 'pdf' && worker.ok) {
    bits.push(`下载完成后会${c.restore ? '还原竖切并' : ''}合成 PDF`);
  } else {
    bits.push('下载完成后保留原始图片（不生成 PDF）');
  }
  if (c.uploadMode === 'off') bits.push('不会上传文件，只保存在机器人本地');
  else bits.push('会把文件上传到提出请求的那个会话（群文件 / 私聊文件）');
  if (c.allowIds) bits.push('只有管理员或白名单 QQ 才能触发下载');

  return [{
    id: `${SKILL_ID}-rules`,
    title: '禁漫漫画下载',
    priority: 50,
    content:
      '本群开了「禁漫漫画下载」技能。规则：\n'
      + `1. 有人发来禁漫漫画 ID（纯数字，如 123456，也常写成 jm123456 或 /album/123456）并想下载时，`
      + `调用 ${toolId('download_album')}，把数字放进 album_id。\n`
      + '2. 只在对方明确想下载时调用；群里随便出现的数字不要调用，拿不准先问一句确认。\n'
      + '3. 这个工具是**异步**的：调用后立刻返回，下载/还原/合成/上传都在后台跑，完成后会自动发消息。'
      + '**不要因为没立刻看到结果就重复调用同一个 ID。**\n'
      + `4. 群友说「今日JM」「今天有什么JM」「JM列表」时，调用 ${toolId('today_list')}，`
      + '并把返回文本**原样发出**（不改写、不总结、不补充）。\n'
      + `5. 群友说「更新JM」「JM更新」「今日更新」「日更」时，调用 ${toolId('daily_updates')}，`
      + '清单和封面由工具自己发送，你不要再复述（注意与「今日JM」本地书架区分：有「更新」二字的是看站点当日新上架）。\n'
      + `6. JM 功能按群开关：有人说「开启JM」「关闭JM」「JM群列表」「JM所有群开放」时，调用 ${toolId('group_toggle')}（结果由工具自己发，不要复述）。\n`
      + `7. 对方问进度或「怎么没动静」时，调用 ${toolId('task_status')}；问「本地有哪几本」用 ${toolId('library')}；`
      + `问「支持 PDF 吗 / 磁盘满了吗 / 群文件还有空间吗」用 ${toolId('storage')}。\n`
      + `8. JM 功能按群开关：有人说「开启JM」「关闭JM」「JM群列表」「JM所有群开放」时，调用 ${toolId('group_toggle')}（结果由工具自己发，不要复述）。\n`
      + '9. 你只需要用一两句话简短回应（本子名 + 页数 + 是否开始处理），**不要复述目录、不要罗列文件名**。\n'
      + '10. 失败时把工具返回的原因如实转达，并给出可照做的下一步，不要编造成功。\n'
      + '11. 这是成人向内容，只在群友主动索要时处理，不要主动推荐、不要描述内容。\n'
      + `当前设置：${bits.join('；')}。`,
  }];
}

// ───────────────────────── 能力（供其它技能查询）─────────────────────────
//
// 用途：`voice-tts` 的「自动配音」判定里要知道"这个会话是不是正在下载漫画" ——
// 下载期间进度消息很多（「开始处理」「下载中 5/8 张」…），一条条配成语音既吵又浪费 GPU。
// 使用者在 2026-10-10 明确要求：**jm 下载期间不要配音**（文字照常发，只是不补语音）。
//
// ⚠️ 这一段是从旧的 `jm-comic` 技能搬过来的（2026-10-10 换成 jm-suomingor 时漏了，
//    导致那条联动静默失效：voice-tts 那边照旧查 `jm.download-active`，
//    而新技能不提供这个能力 → 查询落空 → 一律放行 → 下载期间又开始配音了）。
//    能力名、返回结构都保持**与旧版完全一致**，这样 voice-tts 那边一行都不用改。
//
// 为什么走能力而不是互相 import：本项目的能力注册表就是为"扩展之间不硬编码名字"设计的。
// voice-tts 用 `api.capability('jm.download-active', {chatKey})` 软依赖取用 ——
// 没装本技能时自然拿不到（返回 undefined），不需要任何 if 判断对方是否存在。
//
// `activeByChat` 恰好就是"会话 → 正在下载的本子"的活映射：入队时 `set`、
// 任务 `finally` 里 `delete` —— 所以"下载一结束就恢复配音"是天然成立的，不需要定时器。
//
// 两个能力都提供：
//   · jm.download-active  精确查询某个会话（voice-tts 用这个）
//   · jm.muted-chats      当前正在下载的全部会话快照（排查/兜底用）
export const providers = {
  'jm.download-active': ({ chatKey } = {}) => {
    const key = String(chatKey || '');
    if (!key) return { active: false, albumId: '', chats: [...activeByChat.keys()] };
    const albumId = activeByChat.get(key) || '';
    return { active: Boolean(albumId), albumId: String(albumId), chats: [...activeByChat.keys()] };
  },
  'jm.muted-chats': () => ({
    chats: [...activeByChat.keys()],
    count: activeByChat.size,
  }),
};

