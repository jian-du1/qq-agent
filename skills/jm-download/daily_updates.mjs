// 每日更新采集 + 查看排版（jm-suomingor）
// ---------------------------------------------------------------------------
// 两个角色，一个文件：
//   ① 采集器：系统 cron 定期调用（不经宿主），抓禁漫「当日更新」写状态文件。
//   ② 排版/发送：index.js 的「更新JM」工具 import 本文件，把状态变成
//      文字清单 + 封面图发到会话。单测也可以命令行直接排版预览。
//
// 状态文件：data/<技能 id>/daily_updates.json
//   { "date": "2026-10-06", "items": [ { id, name, author, category,
//       categorySub, tags, updateAt, seenAt, cover } ], lastRun }
//   · 按 date 键存：过午夜后第一次采集自动重置 —— 「晚上 12 点清空重新积累」
//   · items 按 id 去重；同一天同一本只记一次（记首次发现时间）
//
// 命令行：
//   node daily_updates.mjs                  # 采集一轮（默认 3 页）
//   node daily_updates.mjs --pages 2        # 只抓前 2 页
//   node daily_updates.mjs --view           # 打印当日排版预览（不发送）
//
// 接口来源（2026-10-06 探测确认）：
//   · 列表 GET /latest?p=N —— 每页 80 条，按发布时间倒序，字段含 update_at（unix 秒）
//     （/albums 会被 "Not legal.albums" 拒掉，search 空词返回 0，/latest 是唯一可用列表口）
//   · 封面 GET /media/albums/<id>_3x4.jpg —— 与正文同批图片域名，带 v=时间戳 最稳
//   · tags 不在列表里，逐本调 /album?id= 补（失败不致命，tags 留空）
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as engine from './engine.js';
// 复用 pdf.js 的 Python 探测（见下方「图片版」一节的本地修复说明）。
// 同一个技能里两处跑 Python，必须用同一套探测逻辑，否则会出现
// "还原/PDF 能用、信息图却报找不到 Python"这种自相矛盾的现象。
import { findPython } from './pdf.js';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ID = (() => {
  try {
    const id = String(JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'skill.json'), 'utf8'))?.id || '').trim();
    if (/^[a-z0-9][a-z0-9._-]*$/.test(id)) return id;
  } catch { /* 落到目录名 */ }
  return path.basename(SKILL_DIR) || 'jm-suomingor';
})();

const HOST_ROOT = path.resolve(SKILL_DIR, '..', '..'); // qq-agent 根目录
const STATE_KEEP_DAYS = 3; // 状态归档保留天数（防文件无限增长）
const MAX_ITEMS = 300;     // 单日上限：超过不再追加（防异常刷爆）

function readHostSettings() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(HOST_ROOT, 'data', 'config.json'), 'utf8'));
    return c?.skills?.[SKILL_ID] ?? {};
  } catch {
    return {};
  }
}

/** 数据目录：尊重技能设置里的自定义下载目录（与 index.js 的 downloadRoot 同一套规则）。 */
export function dataRoot(settings = readHostSettings()) {
  const custom = String(settings.downloadDir ?? '').trim();
  return custom ? custom : path.join(HOST_ROOT, 'data', SKILL_ID);
}

export const stateFile = (settings) => path.join(dataRoot(settings), 'daily_updates.json');
export const coverDir = (settings) => path.join(dataRoot(settings), 'daily-covers');

/** 东八区的今天（服务器是 UTC，手动偏移 8 小时，不然日期会错位）。 */
export function todayKey(now = Date.now()) {
  const d = new Date(now + 8 * 3600000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
/** 今天 0 点（东八区）的 unix 秒。 */
export function todayStartTs(now = Date.now()) {
  return Math.floor(Date.parse(`${todayKey(now)}T00:00:00+08:00`) / 1000);
}

function readSettingsAndPaths() {
  const settings = readHostSettings();
  return { settings, statePath: stateFile(settings), coversPath: coverDir(settings) };
}

function loadState(statePath) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (s && typeof s === 'object' && Array.isArray(s.items)) return s;
  } catch { /* 没有/损坏都从空开始 */ }
  return { date: todayKey(), items: [] };
}

// ───────────────────────── 采集 ─────────────────────────

async function fetchLatestPage(client, page) {
  const r = await client.jmApi(`/latest?p=${encodeURIComponent(page)}`);
  return Array.isArray(r) ? r : (r?.list ?? r?.content ?? []);
}

/** 下载封面 /media/albums/<id>_3x4.jpg，多域名轮询。失败返回 ''（不致命）。 */
async function fetchCover(client, albumId, coversPath) {
  fs.mkdirSync(coversPath, { recursive: true });
  const target = path.join(coversPath, `${albumId}.jpg`);
  if (fs.existsSync(target) && fs.statSync(target).size > 1024) return target;
  const ts = Math.floor(Date.now() / 1000);
  for (const domain of engine.IMAGE_DOMAINS) {
    for (const q of [`?v=${ts}`, '']) {
      const res = await client.httpGet(
        `https://${domain}/media/albums/${albumId}_3x4.jpg${q}`,
        {
          headers: {
            'user-agent': engine.UA_APP,
            accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            referer: `https://${engine.IMAGE_DOMAINS[0]}/`,
            'accept-language': 'zh-CN,zh;q=0.9',
          },
          retries: 0,
        },
      );
      if (res.ok && res.buffer?.length > 1024) {
        const b = res.buffer;
        const looksLikeImage = (b[0] === 0xff && b[1] === 0xd8) || b[0] === 0x89 || (b[0] === 0x52 && b[1] === 0x49);
        if (!looksLikeImage) continue;
        fs.writeFileSync(target, b);
        return target;
      }
    }
  }
  return '';
}

/** 跨天时清掉昨天的封面（只保留今天的），防止目录无限膨胀。 */
function pruneOldCovers(keepIds, coversPath) {
  try {
    for (const f of fs.readdirSync(coversPath)) {
      if (!f.endsWith('.jpg')) continue;
      if (!keepIds.has(f.slice(0, -4))) fs.rmSync(path.join(coversPath, f), { force: true });
    }
  } catch { /* 目录不存在就算了 */ }
}

/**
 * 按 albumId 从站点拉封面（/media/albums/<id>_3x4.jpg），结果缓存在 daily-covers。
 * 供「今日JM」书架卡片兜底用：本地图被 PDF 合成清掉时，卡片还能有图。
 * @returns {Promise<string>} 本地 jpg 路径；失败返回 ''
 */
export async function fetchSiteCover(albumId) {
  const { coversPath, settings } = readSettingsAndPaths();
  try {
    const client = engine.createClient({
      fetchImpl: globalThis.fetch.bind(globalThis),
      timeoutMs: () => (Number(settings.timeoutSeconds) || 30) * 1000,
      domains: settings.domains || '',
      warn: () => {},
      proxy: settings.proxy || '',
    });
    return await fetchCover(client, String(albumId), coversPath);
  } catch {
    return '';
  }
}

/** 归档：把过期日期的状态压到 days 字段里，只保留最近 STATE_KEEP_DAYS 天。 */
function archiveOld(state, statePath) {
  try {
    const arch = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
    const days = arch.days && typeof arch.days === 'object' ? arch.days : {};
    if (arch.date && Array.isArray(arch.items) && arch.date !== state.date) {
      days[arch.date] = { count: arch.items.length, at: arch.lastRun ?? '' };
    }
    while (Object.keys(days).length > STATE_KEEP_DAYS) {
      const oldest = Object.keys(days).sort()[0];
      delete days[oldest];
    }
    state.days = days;
  } catch { /* 归档失败不影响主流程 */ }
}

/**
 * 采集一轮。
 * @returns {Promise<{added:number,total:number,error?:string}>}
 */
export async function collect({ pages = 3, quiet = false } = {}) {
  const { settings, statePath, coversPath } = readSettingsAndPaths();
  const client = engine.createClient({
    fetchImpl: globalThis.fetch.bind(globalThis),
    timeoutMs: () => (Number(settings.timeoutSeconds) || 30) * 1000,
    domains: settings.domains || '',
    warn: () => {},
    proxy: settings.proxy || '',
  });

  const state = loadState(statePath);
  const today = todayKey();
  if (state.date !== today) {
    // 「晚上 12 点清空重新积累」：跨天后旧状态归档，当天从零开始
    archiveOld(state, statePath);
    pruneOldCovers(new Set(), coversPath);
    state.date = today;
    state.items = [];
  }

  const known = new Set(state.items.map((x) => String(x.id)));
  const startTs = todayStartTs();
  const todayItems = [];
  let newestUpdateAt = 0;

  for (let page = 1; page <= pages; page++) {
    const list = await fetchLatestPage(client, page);
    if (!list.length) break;
    let allStale = true;
    for (const raw of list) {
      const upd = Number(raw?.update_at) || 0;
      if (upd >= startTs) allStale = false;
      if (upd >= startTs && upd > newestUpdateAt) newestUpdateAt = upd;
      const id = String(raw?.id ?? '').trim();
      if (!id || upd < startTs || known.has(id)) continue;
      todayItems.push({
        id,
        name: String(raw.name ?? '').trim(),
        author: String(raw.author ?? '').trim(),
        category: String(raw.category?.title ?? '').trim(),
        categorySub: String(raw.category_sub?.title ?? '').trim(),
        updateAt: upd,
      });
      known.add(id);
    }
    if (allStale) break; // 这一页全是昨天以前的，后面只会更旧
  }

  let added = 0;
  for (const item of todayItems) {
    if (state.items.length >= MAX_ITEMS) break;
    let tags = [];
    try {
      const detail = await client.albumInfo(item.id);
      tags = (detail.tags ?? []).slice(0, 8);
      if (!item.name) item.name = detail.name ?? '';
      if (!item.author) item.author = (detail.authors ?? [])[0] ?? '';
    } catch { /* 详情偶发失败就先记列表信息，tags 留空 */ }
    item.tags = tags;
    item.cover = await fetchCover(client, item.id, coversPath);
    item.seenAt = new Date().toISOString();
    state.items.push(item);
    added += 1;
  }

  state.lastRun = new Date().toISOString();
  state.newestUpdateAt = Math.max(state.newestUpdateAt || 0, newestUpdateAt);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
  if (!quiet || added) console.log(`[${today}] 采集完成：新增 ${added}，当日累计 ${state.items.length}`);
  return { added, total: state.items.length };
}

// ───────────────────────── 排版 ─────────────────────────

/** 去掉「[xxx漢化組](C108)」这类前缀/标签块，让标题干净可读。 */
export function cleanTitle(name) {
  let s = String(name ?? '');
  s = s
    .replace(/^\s*(?:\[[^\]]*\]|\([^)]*\)|【[^】]*】)+\s*/g, '')
    .replace(/\s*\[[^\]]*?(?:漢化|汉化|翻譯|翻译|漢化組|字幕|掃圖|嵌字|個人|汉化组)[^\]]*?\]\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return s || String(name ?? '').trim();
}

/**
 * 读状态并产出「已处理」的清单条目（繁→简、日文标题翻译、排序）。
 * 供文字版与图片版共用。
 * @returns {Promise<{date:string, until:string, items:Array<{id,title,kind,tags,cover,updateAt}>}>}
 */
export async function loadDigestItems({ simplify, translate } = {}) {
  const { statePath } = readSettingsAndPaths();
  const state = loadState(statePath);
  const today = todayKey();
  const simp = (s) => (typeof simplify === 'function' ? simplify(s) : String(s ?? ''));

  if (state.date !== today || !state.items.length) return { date: today, until: '', items: [] };

  // 按更新时间倒序（最新排最前）
  const items = [...state.items].sort((a, b) => Number(b.updateAt || 0) - Number(a.updateAt || 0));

  // 日语标题翻译（复用 index.js 的带缓存流程；失败/未传就跳过）
  if (typeof translate === 'function') {
    await translate(items.slice(0, 40).map((it) => {
      const zh = simp(String(it.name || '').trim());
      return { key: it.id, title: zh, apply: (t) => { if (t) it._name = t; } };
    }));
  }

  const hhmm = (ts) => {
    const d = new Date(Number(ts) * 1000 + 8 * 3600000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  };

  return {
    date: today,
    until: hhmm(state.newestUpdateAt || Math.floor(Date.now() / 1000)),
    items: items.map((it) => {
      const catParts = [it.category, it.categorySub].map((c) => simp(String(c ?? '').trim())).filter(Boolean);
      const kind = catParts[0] === catParts[1] ? catParts[0] : catParts.join('/'); // 「同人/同人」这种重复去掉
      return {
        id: String(it.id),
        title: cleanTitle(simp(String(it._name || it.name || `JM${it.id}`))),
        kind,
        tags: (it.tags ?? []).map((t) => simp(t)).filter(Boolean).slice(0, 5),
        cover: it.cover && fs.existsSync(it.cover) ? it.cover : '',
        updateAt: it.updateAt,
      };
    }),
  };
}

/**
 * 从状态文件构建当日更新清单（文字版）。
 * @param {object} opts
 * @param {Function} [opts.simplify]   繁→简（index.js 的 toSimplified）；不传就原样
 * @param {Function} [opts.translate]  index.js 的 ensureTranslatedTitles（日语标题）；不传就不翻
 * @param {number}   [opts.limit]      文字清单最多列几本（默认 40，防消息超长）
 * @returns {Promise<{text:string, coverPaths:string[], count:number, total:number}>}
 */
export async function buildDigestFromState({ simplify, translate, limit = 40 } = {}) {
  const { date, until, items: all } = await loadDigestItems({ simplify, translate });

  if (!all.length) {
    return { text: '今天还没有采集到禁漫更新（每 30 分钟自动抓一次，先等等再看）。', coverPaths: [], count: 0, total: 0 };
  }

  let budget = 3200; // QQ 文本消息长度保险
  const lines = [];
  const shown = all.slice(0, limit);
  for (let i = 0; i < shown.length; i++) {
    const it = shown[i];
    const short = it.title.length > 42 ? it.title.slice(0, 42) + '…' : it.title;
    const bits = [];
    if (it.kind) bits.push(it.kind);
    if (it.tags.length) bits.push(it.tags.join('/'));
    let line = `${i + 1}. JM${it.id}「${short}」`;
    if (bits.length) line += ` — ${bits.join(' · ')}`;
    line += `（${hhmmOf(it.updateAt)} 更新）`;
    if (budget - line.length < 0) { lines.push(`…（还有 ${all.length - i} 本没列全，稍后再发「更新JM」看增量）`); break; }
    budget -= line.length;
    lines.push(line);
  }

  const head = `📥 今日禁漫更新 ${all.length} 本（截至 ${until}）：`;
  const foot = '\n想下载哪本，直接发编号（如 jm1158362）即可。';
  const text = head + '\n' + lines.join('\n') + foot;

  const coverPaths = all.map((it) => it.cover).filter(Boolean);
  return { text, coverPaths, count: all.length, total: all.length };
}

const hhmmOf = (ts) => {
  const d = new Date(Number(ts) * 1000 + 8 * 3600000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

/**
 * 把清单发到会话：先文字，再一条封面消息（图片顺序 = 清单编号顺序）。
 * ⚠️ 2026-10-06 起「更新JM」默认走 renderDigestImage（一张信息图），
 * 本函数保留为兜底：Pillow 渲染失败时降级成 文字清单+封面。
 * @param {object} opts
 * @param {object} opts.onebot     钩子/工具上下文里的 onebot（要有 sendSegments）
 * @param {string} opts.chatKey    'group:123' / 'private:456'
 * @param {object} opts.digest     buildDigestFromState 的返回
 * @param {number} [opts.covers]   发几张封面（默认 10；封面多于该数会说明）
 */
export async function sendDigest({ onebot, chatKey, digest, covers = 10 }) {
  if (!onebot?.sendSegments) return false;
  const [kind, id] = String(chatKey || '').split(':');
  if (!kind || !id) return false;
  try {
    await onebot.sendSegments(kind, id, [{ type: 'text', data: { text: digest.text } }]);
    if (covers > 0 && digest.coverPaths.length) {
      const pick = digest.coverPaths.slice(0, covers);
      const segs = [{ type: 'text', data: { text: `📸 更新封面（顺序对应上面编号${digest.coverPaths.length > pick.length ? '，其余封面略' : ''}）：` } }];
      for (const p of pick) segs.push({ type: 'image', data: { file: `file://${p}` } });
      await onebot.sendSegments(kind, id, segs);
    }
    return true;
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

// ───────────────────────── 图片版（默认） ─────────────────────────
//
// ⚠️ 本地修复（2026-10-10）：原版这里写死
//       const PYTHON_CANDIDATES = ['python3', '/usr/bin/python3'];
//       const py = PYTHON_CANDIDATES[0];        // ← 永远只用 'python3'
//    在 Linux 上没问题（python3 通常存在），但**在 Windows 上会踩 Microsoft Store 的
//    应用执行别名**：PATH 里的 `python3` 指向一个占位 stub，一跑就报
//        「Python was not found; run without arguments to install from the Microsoft Store…」
//    退出码 9009 —— 于是**简介信息卡和「更新JM」信息图永远渲染不出来**，
//    每次都静默降级成文字版（调用方有 try/catch，所以不报错、只是卖点没了）。
//
//    修法：复用 `pdf.js` 里那套**本来就有**的 `findPython()`
//    （顺序：设置里的 pythonPath → py 启动器 → PATH 的 python → 常见安装位置，
//      并且会真的执行 `python -c "import sys;print(sys.version)"` 验证，
//      不会被 Microsoft Store 的占位 stub 骗过）。
//    这样「还原/PDF」与「信息图」两条路用同一个解释器 ——
//    原版两个模块各自猜 Python 本身就是隐患。
//
//    兜底仍保留 'python3'（万一探测也失败，例如 Linux 上的极端环境），
//    与原版的最终行为保持一致。

let cachedPython = null;      // { exe, version } | { exe, error }

/** 解析出可用的 Python 解释器（带缓存；同一个进程里只探一次）。 */
function resolvePythonExe() {
  if (cachedPython) return cachedPython;
  try {
    const configured = String(readHostSettings().pythonPath ?? '').trim();
    const found = findPython(configured);
    cachedPython = found.ok
      ? { exe: found.exe, version: found.version }
      : { exe: 'python3', error: found.error };   // 兜底：与原版行为一致
  } catch (error) {
    cachedPython = { exe: 'python3', error: String(error?.message ?? error) };
  }
  return cachedPython;
}

/** 起 Python 跑 daily_image.py 的通用壳子（JSON 从 stdin 喂，成功返回目标路径）。 */
async function spawnPythonRender(extraArgs, payload, target) {
  const resolved = resolvePythonExe();
  const py = resolved.exe;
  const script = path.join(SKILL_DIR, 'daily_image.py');
  const { spawn } = await import('node:child_process');
  await fs.promises.mkdir(path.dirname(target), { recursive: true });

  return new Promise((resolve, reject) => {
    const child = spawn(py, [script, ...extraArgs, target], {
      cwd: SKILL_DIR,
      stdio: ['pipe', 'ignore', 'pipe'],
      // ⚠️ 本地修复（2026-10-10）：必须显式要求 Python 用 UTF-8 读写标准流。
      //    Windows 上 Python 默认按**本地代码页**（简体中文系统是 GBK）解 stdin，
      //    而这里喂进去的是 UTF-8 字节的 JSON —— 结果是整段文字被按 GBK 误解码，
      //    渲染出来就是"看着像中文、其实全是错字"的乱码（数字和 ASCII 不受影响，
      //    所以只表现为中文标题/简介/标签全坏）。
      //    实测：不设时 sys.stdin.encoding = 'gbk'，解出的内容是 '{"text":"测试\ufffd…'；
      //    设成 utf-8 后完全正确。
      //    pdf.js 那侧**一直是设了的**（`PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1'`），
      //    所以下载/还原/合成 PDF 从来没错过 —— 只有信息图这条路漏了。
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let errOut = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stderr.on('data', (b) => { errOut += b.toString(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(target) && fs.statSync(target).size > 1024) resolve(target);
      else {
        // 报错里带上用的是哪个解释器 —— 否则"明明装了 Python 却说找不到"这种问题没法查
        reject(new Error(`daily_image.py 退出码 ${code}（解释器 ${py}）`
          + (errOut ? '：' + errOut.trim().slice(0, 200) : '')));
      }
    });
    child.stdin.end(JSON.stringify(payload), 'utf8');
  });
}

/**
 * 把处理后的清单渲染成一张信息图（封面网格卡片）。
 * 调 python3 + daily_image.py（Pillow），条目 JSON 从 stdin 喂进去。
 * @param {object} opts
 * @param {{title:string, subtitle:string, footnote:string, items:Array}} opts.payload
 * @param {string} [opts.outPath]   输出 jpg 路径（默认 dataRoot/daily-digest.jpg）
 * @returns {Promise<string>} 成功返回图片路径；失败抛错（调用方降级到文字版）
 */
export async function renderDigestImage({ payload, outPath } = {}) {
  const { coversPath } = readSettingsAndPaths();
  const target = outPath || path.join(path.dirname(coversPath), 'daily-digest.jpg');
  return spawnPythonRender([], payload, target);
}

/**
 * 单本「简介」信息卡（下载完成时发）。
 * @param {{id,title,authors,tags,kind,pdf,desc,cover}} payload
 * @param {string} [outPath] 默认 dataRoot/album-card.jpg
 * @returns {Promise<string>} 图片路径；失败抛错
 */
export async function renderAlbumImage({ payload, outPath } = {}) {
  const { coversPath } = readSettingsAndPaths();
  const target = outPath || path.join(path.dirname(coversPath), 'album-card.jpg');
  return spawnPythonRender(['--album'], payload, target);
}

/**
 * 「更新JM」/「今日JM」主发送路径：一张信息图 + 一句话说明。
 * @returns {Promise<true|{error:string}>}
 */
export async function sendDigestImage({ onebot, chatKey, payload, imagePath }) {
  if (!onebot?.sendSegments) return false;
  const [kind, id] = String(chatKey || '').split(':');
  if (!kind || !id) return false;
  const firstId = payload.items?.[0]?.id ?? '123456';
  const caption = [payload.title, payload.subtitle].filter(Boolean).join('\n')
    + `\n想下载哪本，直接发编号（如 jm${firstId}）即可。`;
  try {
    const segs = [{ type: 'text', data: { text: caption } }, { type: 'image', data: { file: `file://${imagePath}` } }];
    await onebot.sendSegments(kind, id, segs);
    return true;
  } catch (error) {
    return { error: error?.message ?? String(error) };
  }
}

// ───────────────────────── 命令行入口 ─────────────────────────

const argv = process.argv.slice(2);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const num = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 ? Number(argv[i + 1]) || dflt : dflt;
  };
  if (argv.includes('--view')) {
    buildDigestFromState()
      .then((d) => {
        console.log(d.text);
        console.log(`\n[封面 ${d.coverPaths.length} 张：${d.coverPaths.slice(0, 3).join(', ')}${d.coverPaths.length > 3 ? ' …' : ''}]`);
      })
      .catch((e) => { console.error(`排版失败：${e?.message ?? e}`); process.exit(1); });
  } else if (argv.includes('--image')) {
    // 渲染信息图预览：node daily_updates.mjs --image [--out /tmp/x.jpg]
    loadDigestItems()
      .then(async (base) => {
        if (!base.items.length) { console.log('今天还没有采集到更新'); return; }
        const payload = {
          title: `📥 今日禁漫更新 ${base.items.length} 本`,
          subtitle: `${base.date} · 截至 ${base.until} · 发漫画编号即可下载`,
          footnote: `共 ${base.items.length} 本（站点当日新上架/新章节）`,
          items: base.items,
        };
        const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : undefined;
        const p = await renderDigestImage({ payload, outPath: out });
        const st = fs.statSync(p);
        console.log(`已渲染 ${p}（${(st.size / 1024).toFixed(0)} KB）`);
      })
      .catch((e) => { console.error(`渲染失败：${e?.message ?? e}`); process.exit(1); });
  } else {
    collect({ pages: Math.min(8, Math.max(1, num('--pages', 3))), quiet: argv.includes('--quiet') })
      .then((r) => console.log('done', JSON.stringify(r)))
      .catch((e) => { console.error(`采集失败：${e?.message ?? e}`); process.exit(1); });
  }
}
