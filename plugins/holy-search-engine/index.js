// 神圣搜索引擎（确定性型 / plugins/）—— 原「搜索查询词卫生」，v1.1.0 改名重发
// 改名原因：旧 id（search-query-hygiene）已上传过市场，重发需换 id。
// 功能与旧版一致，另修了 isBetter 的「新旧结果相同也判为可替换」缺陷。
//
// 问题：Bing（以及多数引擎）对中文查询里的疑问尾巴、冗余词、通用词处理很差——
//   会**退化成只看头一个字**，或者把圈子内部的说法当成外部商业名词。
//
// 实测（cn.bing.com，2026-10）：
//   「性转马尔福 是什么」→ 性（汉语文字）_百度百科 / 正确性爱的全过程
//   「寻血猎犬 是什么梗」 → 寻（汉语文字）_百度百科 / 寻的意思 - 汉语国学
//   「哈吉米 是什么梗」   → 哈尔滨工业大学研究生招生信息网
//   「菲比啾比 是什么」   → 菲（有机化合物）_百度百科
//   「洁神 是什么梗 什么意思」→ 青岛洁神科技股份有限公司官网   ← 商名污染
//   只留关键词就完全正确：
//   「性转马尔福」→ 马尔福性转图走红（搜狐）
//   「寻血猎犬」  → 寻血猎犬（动物）_百度百科 / 寻血猎犬 - 萌娘百科
//   「哈基米」    → 哈基米（网络流行语）_百度百科
//   「菲比啾比」  → 菲比 - 萌娘百科 / 火爆全网的菲比啾比…
//
// 做法：用 after-tool 钩子接住 web_search 的返回，判定它是否像"查字/跑偏/商名污染"；
//   是的话按**逐步降噪**的顺序重搜（最多 3 次），把结果换成更干净的那一份。
//   对模型完全透明 —— 不改配置、不改核心代码、不增加模型往返。
//
// 为什么用 after-tool 而不是 before-tool：
//   before-tool 只能返回 {block:true} 否决一次调用，**改不了 argsRaw**
//   （见 orchestrator.js：argsRaw 是个字符串，钩子里改不动它）。
//
// 成本：只在"判定可疑"时重搜。实测单次搜索返回约 535 字符 ≈ 284 tokens，
//   按实测口径约 +0.0004 元/次（空闲时段），可忽略。

import { parseBingResults, sanitizeQuery } from '../../src/web-search.js';
import { getConfig } from '../../src/config.js';

const DEFAULTS = {
  enabled: true,
  autoRefetch: true,
  addSiteHint: true,
  maxResults: 6,
  maxRetries: 3,
  searchUrl: '',
  logDetail: false
};

// ── 疑问尾巴 / 搜索口语（从长到短排序，保证长尾巴先被剥掉）────────────────
const TAIL_PATTERNS = [
  /是什么梗[啊呀呢吧？?。！!]*$/,
  /是什么游戏[啊呀呢吧？?。！!]*$/,
  /是什么东西[啊呀呢吧？?。！!]*$/,
  /是什么意思[啊呀呢吧？?。！!]*$/,
  /是什么[啊呀呢吧？?。！!]*$/,
  /谁啊[啊呀呢吧？?。！!]*$/,
  /是谁[啊呀呢吧？?。！!]*$/,
  /是啥[啊呀呢吧？?。！!]*$/,
  /干嘛的[啊呀呢吧？?。！!]*$/,
  /啥意思[啊呀呢吧？?。！!]*$/,
  /什么意思[啊呀呢吧？?。！!]*$/,
  /什么梗[啊呀呢吧？?。！!]*$/,
  /啥梗[啊呀呢吧？?。！!]*$/,
  /什么来头[啊呀呢吧？?。！!]*$/,
  /什么来路[啊呀呢吧？?。！!]*$/,
  /求科普[啊呀呢吧？?。！!]*$/,
  /科普一下[啊呀呢吧？?。！!]*$/,
  /介绍一下[啊呀呢吧？?。！!]*$/,
  /怎么回事[啊呀呢吧？?。！!]*$/,
  /咋回事[啊呀呢吧？?。！!]*$/,
  /怎么来的[啊呀呢吧？?。！!]*$/,
  /从哪来的[啊呀呢吧？?。！!]*$/,
  /哪来的[啊呀呢吧？?。！!]*$/,
  /是什么时候[啊呀呢吧了？?。！!]*$/
];
// 夹在中间的疑问片段（实测她写成「夏亚 是谁 梗」这种语序）
const MID_QUESTION_PATTERNS = [
  /什么梗/g, /啥梗/g, /什么意思/g, /啥意思/g, /是什么东西/g,
  /是什么游戏/g, /是什么/g, /是谁/g, /是啥/g, /谁啊/g,
  /什么来头/g, /什么来路/g, /求科普/g, /科普一下/g, /介绍一下/g,
  /怎么回事/g, /咋回事/g, /怎么来的/g, /从哪来的/g, /哪来的/g
];
const LEAD_PATTERNS = [
  /^(帮我|帮忙|麻烦|请你|请|你)?\s*(搜一下|搜索一下|搜搜|搜索|搜|查一下|查询一下|查询|查查|查|找一下|找找|找)\s*/,
  /^(我想知道|想知道|问一下|请问)\s*/
];
// 冗余词：写进查询会把结果泛化。"出处"单独看是有用的，但在"X 梗 出处"里
// 真正起作用的是 X，多了"梗"字反而把结果拉向泛泛的梗列表——所以两个都先剥掉，
// 由重搜策略在需要时再试带"出处"的版本。
const NOISE_TOKENS = ['梗', '出处', '来历', '来源', '什么', '意思', '含义'];

// 出现这些词，基本可以断定是"查字/查词"而不是查这个词
const DICT_MARKERS = [
  '汉语文字', '汉语汉字', '汉典', '汉语国学', '康熙笔画', '说文解字',
  '拼音', '部首', '笔画', '字典', '字的解释', '的意思,', '组词'
];
// 商业/机构名污染：查梗或 slang 时返回这些 = 搜错了实体
// （实测「洁神 是什么梗」→「青岛洁神科技股份有限公司官网」）
const COMMERCE_MARKERS = [
  '官网', '有限公司', '股份有限公司', '科技', '集团', '商城', '专卖',
  '旗舰店', '批发', '厂家', '股份', '招聘', '股票', '下载安装'
];
// 只认**梗/游戏百科**类站点。故意不含 baike.baidu.com：
// 「洁（汉语文字）_百度百科」这种查字条目也挂在百度百科下，
// 把它当"权威来源"会让垃圾结果被判定为"值得替换"（实测踩过这个坑）。
const WIKI_HOSTS = ['mzh.moegirl.org.cn', 'moegirl.org.cn', 'zh.moegirl.org.cn',
  'huijiwiki.com', 'wiki.biligame.com', 'wikipedia.org'];
// 梗义查询的判据：用户是在问"这词什么意思/什么梗/哪来的"
const MEANING_INTENT = /梗|什么意思|啥意思|意思|出处|来历|来源|是什么|是谁|是啥|科普/;

let api = null;
let stats = {
  checked: 0, suspect: 0, refetched: 0, replaced: 0,
  lastQuery: '', lastClean: '', lastReason: '', lastAction: '—', lastAt: 0
};

function cfg() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  return { ...DEFAULTS, ...raw };
}

// ── 纯函数区（单测直接驱动，不碰网络）─────────────────────────────────────

function stripNoiseTokens(text) {
  let out = String(text ?? '');
  for (const token of NOISE_TOKENS) {
    // 只剥独立的词，不碰长词内部（避免把"什么"从正常词里抠掉时误伤）
    out = out.split(/\s+/).filter((w) => w !== token).join(' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** 剥掉疑问尾巴与搜索口语，留下真正的关键词。 */
export function cleanQuery(query) {
  let text = sanitizeQuery(query);
  if (!text) return '';
  for (const lead of LEAD_PATTERNS) text = text.replace(lead, '');
  let changed = true;
  let guard = 0;
  while (changed && guard < 8) {
    changed = false;
    guard += 1;
    for (const tail of TAIL_PATTERNS) {
      const next = text.replace(tail, '').trim();
      if (next && next !== text) { text = next; changed = true; break; }
    }
  }
  text = stripNoiseTokens(text);
  // 清掉夹在中间的疑问片段（"夏亚 是谁 梗" → "夏亚"）
  for (const mid of MID_QUESTION_PATTERNS) text = text.replace(mid, ' ');
  text = text.replace(/\s+/g, ' ');
  text = stripNoiseTokens(text);
  text = text.replace(/^[的了吗呢啊呀、，,\s]+/, '').replace(/[的了吗呢啊呀、，,\s]+$/, '').trim();
  return text || sanitizeQuery(query);
}

/**
 * 逐步降噪的查询变体：越靠后越"净"。
 * 实测「糯糯 是什么」这种通用词，加限定词反而更容易命中（"糯糯 梗"）。
 * @returns {string[]} 依次尝试的查询词
 */
export function queryVariants(query) {
  const raw = sanitizeQuery(query);
  const clean = cleanQuery(query);
  const out = [];
  const push = (q) => {
    const v = String(q ?? '').trim();
    if (v && !out.includes(v)) out.push(v);
  };
  push(clean);
  if (clean !== raw) {
    // 通用词补一个"梗"字能显著提升命中（实测「哈气」→「哈气 梗」）
    if (!/梗|意思|出处/.test(raw)) push(`${clean} 梗`);
    push(`${clean} 出处`);
  }
  return out;
}

/** 单个 CJK 字（Bing 退化成"查字"时的典型标题形态）。 */
function isSingleCjk(text) {
  return /^[\u4e00-\u9fff]$/.test(String(text ?? '').trim());
}

/**
 * 一条结果集是否"像查字/跑偏/商名污染"。
 * @param {Array} results
 * @param {string} [query] 原始查询词；给了才能在"问梗义"时对商名结果加罚
 * @returns {{suspect: boolean, score: number, reason: string}}
 */
export function detectSuspect(results, query = '') {
  if (!Array.isArray(results) || !results.length) {
    return { suspect: true, score: 0, reason: '没有解析到任何结果' };
  }
  const wantsMeaning = MEANING_INTENT.test(String(query ?? ''));
  let score = 0;
  const reasons = [];
  // 前几条标题完全相同 = 引擎在复读同一个结果（实测「哈气 是什么」返回两条一模一样的哈工大）
  const titles = results.slice(0, 3).map((r) => String((r && (r.title || r.name)) || '').trim()).filter(Boolean);
  if (titles.length >= 2 && new Set(titles).size === 1) {
    score += 2;
    reasons.push('前几条结果标题完全重复');
  }
  for (const r of results.slice(0, 3)) {
    const title = String((r && (r.title || r.name)) || '');
    const url = String((r && r.url) || '');
    const snippet = String((r && r.snippet) || '');
    if (isSingleCjk(title)) { score += 2; reasons.push(`标题是单字「${title.trim()}」`); }
    for (const marker of DICT_MARKERS) {
      if (title.includes(marker) || snippet.includes(marker)) {
        score += 1; reasons.push(`字典词条特征「${marker}」`); break;
      }
    }
    // 问梗义却返回商业实体 = 搜错了东西（「洁神」→ 青岛洁神科技）
    if (wantsMeaning) {
      for (const marker of COMMERCE_MARKERS) {
        if (title.includes(marker) || url.includes(marker)) {
          score += 2; reasons.push(`问梗却返回商业实体「${marker}」`); break;
        }
      }
    }
  }
  const uniq = new Set(reasons);
  return {
    suspect: score >= 1,
    score,
    reason: [...uniq].slice(0, 2).join('；') || '无可疑特征'
  };
}

/** 从 URL 里取主机名（容错：解析失败就返回空串）。 */
function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); }
  catch { return ''; }
}

/** 结果集里有没有梗/游戏百科这类权威词条（用于判断"重搜结果更好"）。 */
export function hasWikiSource(results) {
  return (results || []).some((r) => {
    const host = hostOf((r && r.url) || '');
    if (!host) return false;
    return WIKI_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  });
}

/** 结果里有没有真正的"梗义"证据（梗站/知乎/新闻里解释这个说法）。 */
export function hasMemeEvidence(results) {
  return (results || []).some((r) => {
    const hay = `${String((r && r.title) || '')} ${String((r && r.snippet) || '')}`;
    return /梗|什么梗|网络用语|流行语|出处|为什么火|走红|爆火|科普/.test(hay);
  });
}

/** 结果集是否"至少是干净的"（不跑偏、且不是查字条目）——干净才值得采纳。 */
function isCleanish(results, query = '') {
  if (!Array.isArray(results) || !results.length) return false;
  if (detectSuspect(results, query).suspect) return false;
  return !(results || []).slice(0, 3).some((r) => {
    const title = String((r && (r.title || r.name)) || '');
    return DICT_MARKERS.some((m) => title.includes(m));
  });
}

/**
 * 两组结果是否"实质相同"（前 3 条的标题或 URL 高度重叠）。
 *
 * 为什么需要：若新旧结果其实是同一批（降噪后引擎仍返回同样内容，如「洁神」），
 * 就不该替换 —— 换了也等于没换，还会多算一次"已替换"。
 */
function isSameResults(a, b) {
  const key = (arr) => (arr || []).slice(0, 3)
    .map((r) => String((r && (r.title || r.name)) || '').trim() || String((r && r.url) || '').trim())
    .filter(Boolean);
  const ka = key(a);
  const kb = key(b);
  if (!ka.length || !kb.length) return false;
  const setB = new Set(kb);
  return ka.some((k) => setB.has(k));
}

/** 重搜后值不值得替换掉原结果。 */
export function isBetter(newResults, oldResults, query = '') {
  if (!Array.isArray(newResults) || !newResults.length) return false;
  const hasOld = Array.isArray(oldResults) && oldResults.length > 0;

  // ① 新旧实质相同 → 绝不替换（原本的漏洞：只要新结果有 wiki 源就直接 return true，
  //    导致 isBetter(GOOD, GOOD) 也为 true —— 多算一次替换、白跑一趟）
  if (hasOld && isSameResults(newResults, oldResults)) return false;

  const newClean = isCleanish(newResults, query);
  const oldClean = hasOld ? isCleanish(oldResults, query) : false;

  if (newClean) {
    // ② 旧结果干净 且 新结果不更"权威" → 没必要换。
    //    权威增量 = 新结果里有 wiki 源/梗义证据，而旧结果里没有。
    if (oldClean) {
      const newAuth = hasWikiSource(newResults) || hasMemeEvidence(newResults);
      const oldAuth = hasWikiSource(oldResults) || hasMemeEvidence(oldResults);
      return newAuth && !oldAuth;
    }
    // ③ 新的干净、旧的脏/为空 → 换
    return true;
  }

  // ④ 新的不干净：只有"分数明显更低"才换，同分绝不换
  //（否则会拿同一批噪音换来换去——「洁神」降噪前后是同一批查字结果）
  const d = detectSuspect(newResults, query);
  const oldD = detectSuspect(oldResults, query);
  return d.score < oldD.score;
}

function parseArgs(argsRaw) {
  if (argsRaw && typeof argsRaw === 'object') return { ...argsRaw };
  try { return JSON.parse(String(argsRaw ?? '{}')) || {}; } catch { return {}; }
}

function serialize(results) {
  return JSON.stringify({ results }, null, 1);
}

function log(msg) {
  if (cfg().logDetail) api?.log?.(msg);
}

// ── 网络区（可注入 fetcher，便于离线测试）────────────────────────────────

/** 懒加载核心的 searchUrl（读不到就用兜底）。 */
function coreSearchUrl(fallback) {
  try {
    const c = getConfig();
    const url = String((c && c.webSearch && c.webSearch.searchUrl) || '');
    if (url) return url;
  } catch { /* 核心配置读不到就用兜底 */ }
  return fallback;
}

async function defaultFetcher(url) {
  const doFetch = (typeof api?.fetch === 'function') ? api.fetch : globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('没有可用的 fetch（插件缺少 web_fetch 权限？）');
  const res = await doFetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9'
    }
  });
  if (!res || !res.ok) throw new Error(`搜索服务 HTTP ${res && res.status}`);
  return await res.text();
}

/** 跑一次搜索。失败返回错误标记而不是抛错（钩子里不能拖垮对话）。 */
export async function runSearch(keyword, options = {}) {
  const clean = sanitizeQuery(keyword);
  if (!clean) return { error: '关键词为空', results: [] };
  const s = { ...cfg(), ...options };
  const base = s.searchUrl || coreSearchUrl('https://cn.bing.com/search');
  const limit = Math.max(1, Math.min(10, Number(s.maxResults) || 6));
  const fetcher = options.fetcher || defaultFetcher;
  try {
    const url = new URL(base);
    url.searchParams.set('q', clean);
    const html = await fetcher(url.toString());
    const results = parseBingResults(html, limit);
    return { results, keyword: clean };
  } catch (error) {
    return { error: String((error && error.message) || error), results: [], keyword: clean };
  }
}

/**
 * 逐步降噪重搜：依次试 queryVariants 里的变体，取第一个明显更好的结果。
 * @returns {{best: Array, usedKeyword: string, tried: number, usedHint: boolean}}
 */
export async function refetchProgressively(rawQuery, before, options = {}) {
  const s = { ...cfg(), ...options };
  const variants = queryVariants(rawQuery);
  const maxTries = Math.max(1, Math.min(4, Number(s.maxRetries) || 3));
  let best = [];
  let usedKeyword = '';
  let tried = 0;
  let usedHint = false;

  for (const keyword of variants.slice(0, maxTries)) {
    tried += 1;
    const r = await runSearch(keyword, options);
    const cand = r.results || [];
    if (isBetter(cand, best.length ? best : before, rawQuery)) {
      best = cand;
      usedKeyword = keyword;
    }
    // 已经足够好（不跑偏、且有梗义或百科证据）就不再试
    if (best.length && !detectSuspect(best, rawQuery).suspect) break;
    if (best.length && (hasWikiSource(best) || hasMemeEvidence(best))) break;
  }

  // 还不行 → 试一次「site:萌娘百科 关键词」，角色/梗类问题最准。
  // ⚠️ 只有当"清洗确实改变了查询"才值得试——否则（比如短词/群内绰号原样查询）
  //    站点限定只会把同一批噪音再拉一遍，白花一次请求。
  const cleanChanged = cleanQuery(rawQuery) !== sanitizeQuery(rawQuery);
  if (s.addSiteHint !== false && cleanChanged && (!best.length || detectSuspect(best, rawQuery).suspect)) {
    const base = usedKeyword || cleanQuery(rawQuery);
    const hinted = await runSearch(`site:zh.moegirl.org.cn ${base}`, options);
    tried += 1;
    if (isBetter(hinted.results, best.length ? best : before, rawQuery)) {
      best = hinted.results;
      usedKeyword = `${base}（萌娘百科站内限定）`;
      usedHint = true;
    }
  }
  return { best, usedKeyword, tried, usedHint };
}

// ── 钩子 ──────────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
  api?.log?.('神圣搜索引擎已就绪：检测查字/跑偏/商名污染 → 逐步降噪重搜');
}

export function available() {
  const s = cfg();
  if (s.enabled === false) return { ok: false, reason: '设置里已关闭' };
  return true;
}

export function deactivate() {
  stats = { checked: 0, suspect: 0, refetched: 0, replaced: 0, lastQuery: '', lastClean: '', lastReason: '', lastAction: '—', lastAt: 0 };
}

export const hooks = {
  async 'after-tool'(ctx = {}) {
    try {
      const s = cfg();
      if (s.enabled === false) return;
      if (ctx.toolName !== 'web_search') return;
      const result = ctx.result;
      if (!result || typeof result.content !== 'string') return;
      if (result.isError) return;

      stats.checked += 1;
      const args = parseArgs(ctx.argsRaw);
      const rawQuery = String(args.query ?? '');
      const clean = cleanQuery(rawQuery);
      stats.lastQuery = rawQuery;
      stats.lastClean = clean;

      // 解析原结果
      let parsed = null;
      try { parsed = JSON.parse(result.content); } catch { parsed = null; }
      const before = (parsed && Array.isArray(parsed.results)) ? parsed.results : [];

      const judged = detectSuspect(before, rawQuery);
      if (!judged.suspect) { stats.lastReason = '正常'; stats.lastAction = '不介入'; return; }
      stats.suspect += 1;
      stats.lastReason = judged.reason;
      if (s.autoRefetch === false) { stats.lastAction = '只提示'; return; }

      // 只在"降噪后确有变化"时重搜，避免拿同样的词再问一遍
      if (!clean || clean === sanitizeQuery(rawQuery)) { stats.lastAction = '关键词无变化，跳过'; return; }

      stats.refetched += 1;
      const { best, usedKeyword, tried, usedHint } = await refetchProgressively(rawQuery, before, s);

      if (!isBetter(best, before, rawQuery)) {
        stats.lastAction = `重搜 ${tried} 次仍不理想，保留原结果`;
        log(`重搜不理想：${rawQuery} → ${clean}`);
        return;
      }

      const note = `（原查询「${rawQuery}」结果疑似跑偏：${judged.reason}；已自动降噪为「${usedKeyword}」重搜 ${tried} 次）`;
      result.content = `${serialize(best)}\n${note}`;
      stats.replaced += 1;
      stats.lastAction = `已降噪重搜${usedHint ? '（含站点限定）' : ''}`;
      stats.lastAt = Date.now();
      log(`已修复：${rawQuery} → ${usedKeyword}（${judged.reason}）`);
    } catch (error) {
      try { api?.warn?.('holy-search-engine 处理失败（已忽略）：', (error && error.message) || error); } catch { /* ignore */ }
    }
  }
};

export const providers = {
  'status.holy-search-engine': () => {
    const s = cfg();
    const at = stats.lastAt ? new Date(stats.lastAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
    return {
      icon: '🧹',
      title: '神圣搜索引擎',
      priority: 42,
      lines: [
        ['状态', s.enabled === false ? '已关闭' : '运行中'],
        ['检查 / 判定可疑', `${stats.checked} / ${stats.suspect} 次`],
        ['自动重搜 / 已替换', `${stats.refetched} / ${stats.replaced} 次`],
        ['最近一次', stats.lastAction + (stats.lastQuery ? `（${stats.lastQuery} → ${stats.lastClean}）` : '')],
        ['替换时间', at]
      ]
    };
  }
};

/** 测试用：清空统计。 */
export function _resetForTest() {
  stats = { checked: 0, suspect: 0, refetched: 0, replaced: 0, lastQuery: '', lastClean: '', lastReason: '', lastAction: '—', lastAt: 0 };
}

/** 测试用：暴露纯函数与统计。 */
export const _internals = {
  cleanQuery, queryVariants, detectSuspect, hasWikiSource, hasMemeEvidence, isBetter,
  isSingleCjk, stripNoiseTokens, isCleanish, isSameResults, _stats: () => stats
};
