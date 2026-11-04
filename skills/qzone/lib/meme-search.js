// 空间配图：网图来源 —— **只保留 memecub**（2026-10-17 用户定稿）
//
// ── 为什么只剩这一个 ──────────────────────────────────────────────────
// 用户验收后的结论：「去掉不稳定的旧图源，
// 用那些还不如直接不配图。」删掉的是：
//   · 发表情(fabiaoqing)  —— 2015~2018 老梗 + 大量"提醒XX小助手"竖长条文字图
//   · 必应图片 / 百度图片  —— 全网混杂，返回大量"包图网/爱给网"那种素材站水印图
//   · 堆糖(duitang)       —— 图片社区，混进壁纸/摄影/书法，风格杂
//   · B站封面             —— 是视频封面不是表情包，还偶发 412 风控
//
// ── memecub 为什么留下 ────────────────────────────────────────────────
// memecub.com 是**专为 AI 做的表情包搜索引擎**（它自己提供 /llms.txt 与 /skill.md）：
//   ① 官方免 key 搜索 API：GET /api/v1/search?q=<词>&limit=N&min_size=150
//      字段齐全：title / title_zh / tags_zh / url / width / height / kind / license
//      → 尺寸现成（下载前就能过质量闸）、标题能判断贴合度
//   ② **安全过滤由它自己做**：色情、自残、政治人物、极端图像一律不入库；脏话默认隐藏
//   ③ 图统一在 gpic.code-nav.cn，单域名好白名单
//   ④ 有配额（响应头 x-quota-remaining，实测 15 → 0）；用完时走**标签页兜底**：
//      /zh/tag/<标签> 不在配额内，页面里带 JSON-LD（contentUrl 原图 + name 标题，20 条/页），
//      robots.txt 只禁 /api/、/search、/library、/login，/zh/tag/ 是允许的。
//
// ── 没有候选时怎么办 ──────────────────────────────────────────────────
// **直接发纯文字**。用户的原话是"宁可不配图也不要用不匹配的图"——
// 所以这个模块宁可返回空，也不去别的地方凑一张不搭的图。候选为空时上层会
// 明确告诉她"这条不配图"，而不是让她硬挑。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_BYTES = 5 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60 * 1000;   // memecub 有配额，缓存久一点省着用

/** 允许下载的图床：只认 memecub 的图床（不做任意 URL 代理）。 */
const HOST_ALLOW = [
  /(^|\.)code-nav\.cn$/i,   // gpic.code-nav.cn —— memecub 的图床
];

/** 搜索词黑名单：虽然 memecub 自己会过滤内容，请求侧也别递敏感词。 */
const BLOCKED_WORDS = [
  '政治', '时政', '政府', '党', '主席', '总书记', '总理', '领导人', '共产党', '中共',
  '台湾', '香港', '新疆', '西藏', '台独', '港独', '六四', '法轮', '翻墙', '维稳', '敏感',
  '色情', '裸', '露点', '色图', '黄图', '做爱', '约炮', '成人', '福利姬',
  '毒品', '赌博', '枪支', '炸弹', '自杀', '杀人', '血腥', '恐怖',
];

const searchCache = new Map();   // 关键词 -> { at, items }
let memecubQuotaLeft = null;     // 从响应头读到的剩余配额（null = 未知）
let tagVocab = null;             // 标签词表（从 /llms.txt 抓一次，给"没搜到"时提示用）
let tagVocabAt = 0;

export function memecubQuota() { return memecubQuotaLeft; }

function blocked(keyword) {
  const k = String(keyword || '').toLowerCase();
  for (const w of BLOCKED_WORDS) if (k.includes(w.toLowerCase())) return w;
  return '';
}

function unescapeHtml(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

/** GET 文本，带退避重试。 */
async function getText(fetchImpl, url, headers, tries = 3) {
  let lastErr = '';
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(i === 1 ? 15000 : 25000) });
      if (!res || res.status !== 200) { lastErr = 'HTTP ' + (res?.status ?? '?'); }
      else { const t = await res.text(); if (t) return { text: t, error: '' }; lastErr = '空响应'; }
    } catch (e) { lastErr = String(e?.message ?? e); }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return { text: '', error: lastErr };
}

/** memecub 标签页兜底（不消耗 API 配额）。 */
export async function searchMemecubTag(fetchImpl, { keyword, limit = 8 } = {}) {
  const tag = String(keyword || '').trim();
  if (!tag) return { items: [], error: '没有标签名' };
  const url = 'https://memecub.com/zh/tag/' + encodeURIComponent(tag);
  const { text, error } = await getText(fetchImpl, url, { 'User-Agent': UA, accept: 'text/html,application/xhtml+xml' });
  if (!text) return { items: [], error: '标签页取不到：' + error };
  const items = [];
  const seen = new Set();
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(text))) {
    let obj;
    try { obj = JSON.parse(m[1]); } catch { continue; }
    const graph = Array.isArray(obj?.['@graph']) ? obj['@graph'] : [obj];
    for (const node of graph) {
      for (const el of (node?.mainEntity?.itemListElement || [])) {
        const it = el?.item || {};
        const u = String(it.contentUrl || it.thumbnailUrl || '');
        if (!/^https?:/i.test(u) || seen.has(u)) continue;
        seen.add(u);
        const name = unescapeHtml(String(it.name || '')).replace(/\s+/g, ' ').trim().slice(0, 40);
        items.push({ url: u, desc: name || tag, origin: 'memecub', via: 'tag' });
      }
    }
  }
  return { items: items.slice(0, Math.max(1, limit)), total: items.length, via: 'tag', quota: memecubQuotaLeft };
}

/** memecub 官方搜索 API（首选）。配额用尽时自动转标签页。 */
export async function searchMemecubImages(fetchImpl, { keyword, limit = 8 } = {}) {
  const q = String(keyword || '').trim();
  if (!q) return { items: [], error: '没有关键词' };

  if (memecubQuotaLeft !== null && memecubQuotaLeft <= 0) {
    const fb = await searchMemecubTag(fetchImpl, { keyword: q, limit });
    return { ...fb, error: fb.items.length ? '' : 'memecub 配额已用完，这个词也没有对应标签' };
  }

  const n = Math.min(50, Math.max(1, Number(limit) || 8));
  const url = 'https://memecub.com/api/v1/search?q=' + encodeURIComponent(q) + '&limit=' + n + '&min_size=150';
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  } catch (e) { return { items: [], error: 'memecub 请求失败：' + (e?.message ?? e) }; }
  const left = Number(res?.headers?.get?.('x-quota-remaining'));
  if (Number.isFinite(left)) memecubQuotaLeft = left;
  if (!res || res.status !== 200) return { items: [], error: 'memecub HTTP ' + (res?.status ?? '?'), quota: memecubQuotaLeft };
  let data = [];
  try { data = JSON.parse(await res.text())?.data || []; } catch { return { items: [], error: 'memecub 返回不是 JSON' }; }

  const items = [];
  const seen = new Set();
  for (const x of data) {
    const u = String(x?.url || '');
    if (!/^https?:/i.test(u) || seen.has(u)) continue;
    const w = Number(x.width) || 0;
    const h = Number(x.height) || 0;
    // 下载前先按我们的闸筛（接口给的尺寸就是干这个用的）
    if (w && h) {
      if (Math.min(w, h) < 140) continue;
      const ratio = w / h;
      if (ratio < 0.5 || ratio > 1.8) continue;
    }
    if (x.private === true) continue;
    if (String(x.review_status || '') === 'rejected') continue;
    seen.add(u);
    const title = unescapeHtml(String(x.title_zh || x.title || '')).replace(/\s+/g, ' ').trim().slice(0, 40);
    const tags = Array.isArray(x.tags_zh) ? x.tags_zh.slice(0, 4).join('/') : '';
    items.push({
      url: u,
      desc: (title || q) + (tags ? '（' + tags + '）' : ''),
      origin: 'memecub',
      kind: String(x.kind || ''),
      size: w && h ? { w, h } : undefined,
    });
  }
  if (!items.length) {
    // 搜不到 → 用标签页兜底再试一次（同一个词，很多词就是标签）
    const fb = await searchMemecubTag(fetchImpl, { keyword: q, limit });
    if (fb.items.length) return fb;
  }
  return { items, total: items.length, quota: memecubQuotaLeft };
}

/** 标签词表（从 /llms.txt 抓，24 小时缓存一次）——用于"没搜到"时给她几个可用的词。 */
export async function memecubTags(fetchImpl) {
  if (tagVocab && Date.now() - tagVocabAt < 24 * 3600 * 1000) return tagVocab;
  const { text } = await getText(fetchImpl, 'https://memecub.com/llms.txt', { 'User-Agent': UA, accept: 'text/plain' }, 2);
  if (!text) return tagVocab || [];
  const out = [];
  for (const m of text.matchAll(/https:\/\/memecub\.com\/zh\/tag\/([^\s)\]]+)/g)) {
    const t = decodeURIComponent(m[1]);
    if (t && !out.includes(t)) out.push(t);
  }
  if (out.length) { tagVocab = out; tagVocabAt = Date.now(); }
  return tagVocab || [];
}

/**
 * 统一入口：按关键词取配图候选（只有一个来源：memecub）。
 * 返回 { items, error?, blocked?, quota? }；items 为空时上层应当**不配图**。
 */
export async function searchWebImages(fetchImpl, opts = {}) {
  const { keyword, limit = 8 } = opts;
  const q = String(keyword || '').trim();
  if (!q) return { items: [], error: '没有关键词' };
  const hit = blocked(q);
  if (hit) return { items: [], blocked: hit, error: `搜索词命中黑名单（${hit}），不搜` };

  const ck = q;
  const cached = searchCache.get(ck);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { items: cached.items.slice(0, limit), cached: true, quota: memecubQuotaLeft };

  const r = await searchMemecubImages(fetchImpl, { keyword: q, limit: Math.max(12, limit) });
  if (r.items.length) searchCache.set(ck, { at: Date.now(), items: r.items });
  return { items: r.items.slice(0, limit), total: r.total, error: r.error || '', blocked: r.blocked, quota: r.quota, via: r.via };
}

/** 从图片字节头读宽高（不依赖库）：JPEG / PNG / GIF / WebP。 */
export function imageSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) break;
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buf.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
  }
  return null;
}

/** 配图质量闸：短边 ≥ 140px、长宽比 0.5~1.8（挡竖长条文字图和超小表情）。 */
export function usableImage(buf) {
  const size = imageSize(buf);
  if (!size || !size.w || !size.h) return { ok: false, why: '读不出尺寸' };
  const shortSide = Math.min(size.w, size.h);
  const ratio = size.w / size.h;
  if (shortSide < 140) return { ok: false, why: `太小（${size.w}×${size.h}）`, size };
  if (ratio < 0.5) return { ok: false, why: `太窄长（${size.w}×${size.h}）`, size };
  if (ratio > 1.8) return { ok: false, why: `太扁长（${size.w}×${size.h}）`, size };
  return { ok: true, size };
}

/** 下载 + 过闸 + 落缓存。返回 { key, file, bytes, mime, ext, size }。失败抛错。 */
export async function cacheWebImage(fetchImpl, url, cacheDir) {
  const u = String(url || '');
  let host = '';
  try { host = new URL(u).hostname; } catch { throw new Error('非法地址'); }
  if (!HOST_ALLOW.some((re) => re.test(host))) throw new Error('图床不在白名单（' + host + '）');

  const res = await fetchImpl(u, {
    headers: { 'User-Agent': UA, accept: 'image/*', referer: 'https://memecub.com/' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res || res.status !== 200) throw new Error('下载失败 HTTP ' + (res?.status ?? '?'));
  const mime = String(res.headers.get('content-type') || '');
  if (!/^image\//i.test(mime)) throw new Error('不是图片（' + mime + '）');
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('空文件');
  if (buf.length > MAX_BYTES) throw new Error('图太大（' + Math.round(buf.length / 1024) + ' KB）');
  const quality = usableImage(buf);
  if (!quality.ok) throw new Error('图不合格：' + quality.why);

  const ext = (mime.includes('png') ? '.png' : mime.includes('gif') ? '.gif' : mime.includes('webp') ? '.webp' : '.jpg');
  const key = crypto.createHash('sha1').update(u).digest('hex').slice(0, 16);
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = path.join(cacheDir, key + ext);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return { key, file, bytes: buf.length, mime, ext, size: quality.size };
}

/** 回环中转地址（协议端从这里取图）。 */
export function relayUrl(port, key) {
  return `http://127.0.0.1:${Number(port) || 3210}/api/qzone-img/${key}`;
}

export const internals = { blocked, unescapeHtml, HOST_ALLOW, BLOCKED_WORDS, MAX_BYTES };
