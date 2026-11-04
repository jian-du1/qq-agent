// 图源 1：Pixivic / ShareMoe（pixivic.net → m.pixivic.net）—— 国内直连的 Pixiv 镜像
//
// ── 这个站现在叫什么、接口在哪（全部实测，不是猜的）──────────────────────
//   · pixivic.net 已改名 **ShareMoe（虾萌）**，是 Pixiv 的国内镜像，提供画作搜索/排行/壁纸
//   · 页面是 SPA（`#root`），真实接口地址藏在打包 JS 里：
//         apiBaseUrl  = https://pix.ipv4.host
//         imagePrefix = https://o.edcms.pw
//   · 图片地址必须**重写**：接口给的是 `i.pximg.net`（国内访问不了 + 防盗链 403），
//     去掉域名前缀拼到 imagePrefix 上才可用（实测 13/13 全部下载成功）：
//         https://o.edcms.pw + /c/540x540_70/img-master/.../xxx.jpg
//
// ── 哪些接口能用（实测结论，别再走弯路）──────────────────────────────────
//   ✅ /trendingTags                     热门标签 + 每标签的代表作品（匿名可用）
//   ✅ /ranks?page&pageSize&date&mode    排行榜（匿名可用，但见下面的坑）
//   ✅ /spotlights                       Pixivision 特辑
//   ❌ /illustrations?keyword=…          **401 账户未登录** —— 关键词搜索要登录
//   ❌ /search、/pixiv/search 等         空路由（那是前端路由，不是接口）
//
// ── 三个实测出来的坑 ──────────────────────────────────────────────────────
//   ① **/ranks 只对「2 天前及更早」的日期返回数据**。今天/昨天的排行还没生成，
//      请求会返回 `获取排行成功` 但 **data 为空** —— 只判断 message 会以为成功。
//      所以日期从"2 天前"开始往回随机取。
//   ② **每页实际只回 5~6 条**（虽然传 pageSize=30），且频繁请求会返回空。
//      所以翻页价值有限，主要靠"随机日期 + 随机标签"来保证多样性。
//   ③ 数据里混着**占位条目**（imageUrls 指向 `onedrive/files/xx/download/bilibili.jpg`），
//      必须剔除，否则会发出张无关的图。
//
// ── 关于按角色名搜（`#老婆 丛雨`）────────────────────────────────────────
// 搜索接口要登录，所以只能**在热门标签里匹配关键词**（原标签名与中文译名都匹配，
// 实测「原神」「初音」「明日方舟」都能命中）。匹配不到（如「丛雨」这种冷门角色）
// 就如实返回失败，由级联器换下一个源 —— 不猜、不编。

const API = 'https://pix.ipv4.host';
/** 图片镜像前缀：接口给的是 i.pximg.net，国内不可用，必须换成这个 */
const IMG_PREFIX = 'https://o.edcms.pw';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const HEADERS = { 'user-agent': UA, accept: 'application/json', referer: 'https://m.pixivic.net/' };

/**
 * 标签打分与排序（在 work-lookup.mjs 里实现）。
 * 走带版本号的动态导入：ESM 按 URL 缓存，**改了 work-lookup.mjs 必须升版本号**，
 * 否则这里拿到的还是旧版（这个坑本项目踩过多次）。
 */
const RANK_LIB_VERSION = 5;
const { rankWorks, scoreWork, lookupWorkHint, discoverWorkTags } = await import(`./work-lookup.mjs?v=${RANK_LIB_VERSION}`);

/**
 * 构造认证头。
 *
 * ⚠️ **服务端要的是裸 token，不能加 `Bearer `**。实测六种写法：
 *      裸 token                → 200 搜索成功 ✅
 *      Bearer <token>          → 401 token无效   ← 我一开始自作聪明加了前缀，错了
 *      bearer <token>          → 401 token无效
 *      URL 参数 ?Authorization= → 401 账户未登录（那是给 VIP 图片用的，不是接口认证）
 *      X-Token / token 头      → 401 账户未登录
 *    依据是它自己的前端：`y && v.set("Authorization", y)`，而 `y` 就是 localStorage 里
 *    存的那个 token 原值。所以这里**原样透传**，只在用户可能贴了 `Bearer ` 时去掉它。
 */
export function authHeaders(token) {
  const t = String(token ?? '').trim();
  if (!t) return {};
  // 用户可能从别处连 "Bearer " 一起复制进来，这里主动剥掉（服务端不接受带前缀的）
  return { Authorization: t.replace(/^Bearer\s+/i, '').trim() };
}

/** 给图片地址补上 VIP token（前端行为：searchParams.set("Authorization", token)）。 */
function withTokenQuery(url, token) {
  const t = String(token ?? '').trim();
  if (!t || !url) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has('Authorization')) u.searchParams.set('Authorization', t.replace(/^Bearer\s/i, ''));
    return u.href;
  } catch { return url; }
}

async function apiGet(path, { timeoutMs = 15000, token = '', log } = {}) {
  const res = await fetch(API + path, {
    headers: { ...HEADERS, ...authHeaders(token) },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!json) throw new Error(`Pixivic 接口返回非 JSON（HTTP ${res.status}）`);
  if (res.status === 401) throw new Error(String(json.message || 'Pixivic 接口需要登录'));
  if (!res.ok) throw new Error(`Pixivic 接口 HTTP ${res.status}`);
  if (json.message && !json.data) log?.(`Pixivic 提示：${json.message}`);
  return json;
}

/**
 * 用 token 走真正的关键词搜索（登录后的主力路径）。
 *
 * @param {object} opts
 *   sort      'popular' 时按收藏数排序（**接口原生支持**，实测有效）；
 *             不传则用接口默认顺序。
 *   beginDate / endDate  'YYYY-MM-DD'，限定发布时间窗口。
 *             ⚠️ 实测关键词搜索索引**滞后约 3~4 个月**（排行榜却是新的）：
 *                近 7/14/30/60 天窗口一律 0 条，近 120 天才开始有数据。
 *                所以调用方必须准备"窗口为空就退回无窗口"的兜底。
 * @returns {Promise<{ok:boolean, list:Array, reason?:string}>}
 */
export async function searchByKeyword(keyword, {
  token = '', page = 1, pageSize = 30, maxSanityLevel = 10, timeoutMs = 12000, log,
  sort = '', beginDate = '', endDate = ''
} = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return { ok: false, list: [], reason: '空关键词' };
  if (!String(token ?? '').trim()) return { ok: false, list: [], reason: '没有配 token' };
  const params = new URLSearchParams({
    keyword: kw, page: String(page), pageSize: String(pageSize), maxSanityLevel: String(maxSanityLevel)
  });
  if (sort) params.set('sort', sort);
  if (beginDate) params.set('beginDate', beginDate);
  if (endDate) params.set('endDate', endDate);
  try {
    const json = await apiGet(`/illustrations?${params}`, { timeoutMs, token, log });
    return { ok: true, list: listOf(json) };
  } catch (error) {
    return { ok: false, list: [], reason: String(error?.message || error).slice(0, 80) };
  }
}

/** 相对今天偏移 n 天的日期（YYYY-MM-DD）。 */
function dateBack(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

/**
 * 抓"本周排行榜"的作品，供调用方**在本地按角色标签筛**。
 *
 * ── 为什么只能这样 ──────────────────────────────────────────────────────
 * 实测 `/ranks?mode=week` 是**真正的周榜**、数据也新（能到昨天），
 * 但它**不支持按标签/keyword 筛选**：加上 `tag=` / `keyword=` 后返回结果
 * 与不加**完全一样**（服务端直接忽略）。所以只能整榜抓下来本地筛。
 * 实测翻 6 页约 182 条，就是"这一周的热门池"。
 * ⚠️ 覆盖有限：热门角色偶尔在榜（初音ミク 4 条、心月狐 2 条），
 *    冷门角色（今汐、守岸人）**0 条** —— 调用方必须有兜底，不能只靠这条路。
 * 日期只能取 2 天前或更早（当天/昨天返回空数据）。
 *
 * @returns {Promise<Array>} 作品数组（失败返回空数组）
 */
export async function fetchWeekRank({ token = '', pages = 6, pageSize = 30, timeoutMs = 12000, log } = {}) {
  if (!String(token ?? '').trim()) return [];
  const out = [];
  const seen = new Set();
  const date = dateBack(3);
  const maxPages = Math.max(1, Math.min(10, pages));
  for (let page = 1; page <= maxPages; page += 1) {
    try {
      const json = await apiGet(`/ranks?${new URLSearchParams({
        page: String(page), pageSize: String(pageSize), date, mode: 'week'
      })}`, { timeoutMs, token, log });
      const list = listOf(json);
      if (!list.length) break;
      for (const w of list) {
        const id = String(w?.id ?? '');
        if (id && !seen.has(id)) { seen.add(id); out.push(w); }
      }
    } catch (error) {
      log?.(`周榜第 ${page} 页抓取失败：${String(error?.message || error).slice(0, 50)}`);
      break;
    }
    await sleep(200);
  }
  if (out.length) log?.(`周榜（${date} 当周）抓到 ${out.length} 条作品`);
  return out;
}

/**
 * 带"热度 + 时间窗口"的关键词检索，内置**三级降级**。
 *
 * 用户要的是"按周热度排名后随机发"。实情是：
 *   ① 周榜仅约 182 条且不能按标签筛 —— 冷门角色命中率极低；
 *   ② 关键词搜索索引滞后 3~4 个月 —— 近 7/30/60 天窗口全是 0 条。
 * 所以按下面顺序尝试，取第一个有结果的：
 *   ① `近 N 天 + sort=popular` → 最接近"近期热度"（N 默认 120，实测能出数据的最小窗口）
 *   ② `sort=popular` 无窗口    → 退一步用全时段热度（保证有图）
 *   ③ 无 sort 无窗口           → 最后兜底（接口默认顺序）
 * 这样"有热度排名就按热度"能兑现，同时不会因窗口太窄而一张都发不出。
 *
 * @returns {Promise<{list:Array, how:string}>}
 */
export async function searchHot(keyword, {
  token = '', pages = 3, pageSize = 30, windowDays = 120, timeoutMs = 12000, log, respectWindow = true
} = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return { list: [], how: '' };
  const rounds = [];
  if (respectWindow) {
    rounds.push({
      label: `近 ${windowDays} 天 + 按收藏数排序`,
      opts: { sort: 'popular', beginDate: dateBack(windowDays), endDate: dateBack(0) }
    });
  }
  rounds.push({ label: '全时段按收藏数排序', opts: { sort: 'popular' } });
  rounds.push({ label: '接口默认顺序', opts: {} });

  for (const round of rounds) {
    const all = [];
    const seen = new Set();
    for (let i = 0; i < Math.max(1, pages); i += 1) {
      const page = 1 + Math.floor(Math.random() * 4);
      const r = await searchByKeyword(kw, { token, page, pageSize, timeoutMs, log, ...round.opts });
      if (r.ok && r.list.length) {
        for (const w of r.list) {
          const id = String(w?.id ?? '');
          if (id && !seen.has(id)) { seen.add(id); all.push(w); }
        }
      }
      await sleep(250);
    }
    if (all.length) {
      log?.(`Pixivic 热度检索「${kw}」→ ${round.label}，${all.length} 条`);
      return { list: all, how: round.label };
    }
    log?.(`Pixivic 热度检索「${kw}」在「${round.label}」下没有结果，降级重试`);
  }
  return { list: [], how: '' };
}

/**
 * 按"关键词分析结果"检索：用角色名与作品的多语言标签各搜一轮，合并去重。
 *
 * 为什么值得多搜几轮：不同语言标签的结果集**不一样**（实测「千恋万花」20 条、
 * 「Senren Banka」17 条，重合但不相等）。多轮搜索能显著扩大候选池，
 * 再靠标签打分筛掉跑偏的，准确性反而更高。
 *
 * @param {object} analysis analyzeKeyword 的结果（character / workTags / characterTags）
 * @returns {Promise<{ok:boolean, list:Array, queries:string[], reason?:string}>}
 */
export async function searchByAnalysis(keyword, analysis, { token = '', pages = 1, pageSize = 30, timeoutMs = 12000, log, maxQueries = 3 } = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return { ok: false, list: [], queries: [], reason: '空关键词' };

  // 查询词：角色名优先（最准），其次作品的各语言标签
  const queries = [];
  const push = (q) => {
    const s = String(q ?? '').trim();
    if (s && !queries.includes(s)) queries.push(s);
  };
  push(kw);
  for (const a of (analysis?.characterTags || [])) push(a);
  for (const t of (analysis?.workTags || [])) push(t);
  const useQueries = queries.slice(0, Math.max(1, maxQueries));

  const all = [];
  const seen = new Set();
  const used = [];
  for (const q of useQueries) {
    const page = 1 + Math.floor(Math.random() * Math.max(1, pages));
    const r = await searchByKeyword(q, { token, page, pageSize, timeoutMs, log });
    if (r.ok && r.list.length) {
      used.push(q);
      for (const w of r.list) {
        const id = String(w?.id ?? '');
        if (id && !seen.has(id)) { seen.add(id); all.push(w); }
      }
      log?.(`Pixivic 检索「${q}」第 ${page} 页 → ${r.list.length} 条（累计 ${all.length} 条去重后）`);
    } else if (!r.ok) {
      log?.(`Pixivic 检索「${q}」失败：${r.reason}`);
    }
    await sleep(350);
  }
  if (!all.length) {
    return { ok: false, list: [], queries: used, reason: `Pixivic 用 ${useQueries.length} 个查询词都没搜到结果` };
  }
  return { ok: true, list: all, queries: used };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 占位条目（实测混在 /ranks 数据里）：指向一个固定的 bilibili.jpg。 */
const PLACEHOLDER = /onedrive\/files\/\d+\/download\//i;

/** 不该出现在群里的内容标记。 */
const R18_TAG = /(R-?18|R18G|18禁|成人向|エロ|グロ|NSFW|grotesque)/i;

/** 把接口返回的图片地址重写成国内可直连的镜像地址。 */
export function rewriteImageUrl(raw) {
  const u = String(raw ?? '').trim();
  if (!u) return '';
  // 已经是镜像地址或占位图 → 原样返回（占位图由调用方剔除）
  if (PLACEHOLDER.test(u)) return u;
  if (/^https?:\/\/i\.pximg\.net\//i.test(u)) return IMG_PREFIX + '/' + u.replace(/^https?:\/\/i\.pximg\.net\//i, '');
  if (u.startsWith('//i.pximg.net/')) return IMG_PREFIX + '/' + u.slice('//i.pximg.net/'.length);
  return u;
}

/**
 * 生成一个作品的**多个尺寸变体地址**，按清晰度从高到低。
 *
 * ⚠️ 为什么需要多变体（真实事故）：
 *   群里发 `#老婆 原神` 报 `这张图下载失败了（HTTP 403）`。日志显示热门标签只命中
 *   1 张图（`pixivic:115586737`，2023 年的老作品），而我把地址重写成了 master1200
 *   ——**老图在镜像上不一定有这个变体**，缺了就 403。只有 1 个候选时没有退路，
 *   整条命令就失败了。
 *   所以同一张图要给出多个尺寸地址，下载时逐个试：master1200 → 原始路径 → large → medium。
 *
 * 实测各变体：master1200 = 960x1200 jpeg 489KB（最清晰）；
 *            large = 600x750 webp；medium = 432x540 jpeg（兜底，至少能发出来）。
 */
export function variantsOf(work) {
  const iu = work?.imageUrls;
  const first = Array.isArray(iu) ? iu[0] : iu;
  const large = String(first?.large || '');
  const medium = String(first?.medium || '');
  const square = String(first?.squareMedium || '');
  const raw = large || medium || String(first?.original || '') || square || String(work?.url || '');
  if (!raw) return [];

  const out = [];
  const push = (u) => {
    const w = rewriteImageUrl(u);
    if (w && !out.includes(w) && !PLACEHOLDER.test(w)) out.push(w);
  };

  // ① master1200：去掉 /c/<尺寸参数>/（最清晰，最常用）
  if (/\/img-master\//.test(raw)) push(raw.replace(/\/c\/[^/]+\//, '/'));
  // ② 原图路径：/img-master/ → /img-original/（部分老图只有这个）
  if (/\/img-master\//.test(raw)) push(raw.replace(/\/c\/[^/]+\//, '/').replace('/img-master/', '/img-original/'));
  // ③ large 原样（600x750 webp，几乎一定有）
  push(large);
  // ④ medium 兜底（432x540 jpeg）
  push(medium);
  // ⑤ 方形缩略图（最后手段，宁可小也别失败）
  push(square);
  return out;
}

/**
 * 取作品的图片地址（首选变体）。
 *
 * ── 尺寸档位的选择是实测出来的 ────────────────────────────────────────────
 * 同一作品四个字段的真实像素：
 *   medium       432x540  jpeg   40KB   ← 太小
 *   large        600x750  webp   75KB
 *   master1200   960x1200 jpeg  489KB   ← ✅ 优先
 *   original     （原图好几 MB，实测还会超时）
 * 但 master1200 **不一定存在**（老图），所以下载层会用 variantsOf() 逐个兜底。
 */
export function imageUrlOf(work) {
  const list = variantsOf(work);
  return list[0] || '';
}

/** 标签是否让人放心（R-18 一律丢）。 */
export function isSafeWork(work) {
  const tags = (Array.isArray(work?.tags) ? work.tags : [])
    .map((t) => `${t?.name ?? ''} ${t?.translatedName ?? ''}`).join(' ');
  const text = `${tags} ${work?.title ?? ''} ${work?.caption ?? ''}`;
  if (R18_TAG.test(text)) return false;
  if (Number(work?.xRestrict) === 1 || Number(work?.sanityLevel) >= 6) return false;
  if (Number(work?.illustType) === 2 || String(work?.type) === 'ugoira') return false;   // 动图
  return true;
}

/** 把作品整理成统一候选结构；不合适的返回 null。 */
export function toCandidate(work, creditLabel = 'Pixivic') {
  if (!work || !isSafeWork(work)) return null;
  const variants = variantsOf(work);
  if (!variants.length) return null;
  const url = variants[0];
  /* ⚠️ 镜像站 o.edcms.pw **要求 Referer 是 pixivic 自己**。
   *    实测四种组合：无头 403、带 pixiv Referer 403、带 m.pixivic.net 200、
   *    Referer 空串 403。早期想当然地以为"镜像站不需要 Referer"，
   *    结果挑选全部成功、下载全部 403。 */
  const referer = /edcms\.pw|ipv4\.host/i.test(url) ? 'https://m.pixivic.net/' : 'https://www.pixiv.net/';
  return {
    url,
    // 同图的其他尺寸地址：主地址 403/超时时逐个兜底（老图可能缺 master1200 变体）
    variants: variants.map((u) => ({ url: u, referer })),
    referer,
    file: String(work.id ?? url.split('/').pop() ?? '').slice(0, 60),
    title: String(work.title || work.illustTitle || '').slice(0, 60),
    author: String(work.artistPreView?.name || work.userName || '').trim(),
    pageUrl: work.id ? `https://www.pixiv.net/artworks/${work.id}` : 'https://m.pixivic.net/',
    key: `pixivic:${work.id ?? url}`
  };
}

/** 统一取出 data 里的列表（data 可能是数组，也可能是 {items|list|records}）。 */
export function listOf(json) {
  const d = json?.data;
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') {
    for (const k of ['items', 'list', 'records', 'rows', 'content']) {
      if (Array.isArray(d[k])) return d[k];
    }
  }
  return [];
}

/**
 * 热门标签（缓存 30 分钟：它变化不快，也少给站点添压力）。
 *
 * 另外维护一份**"标签里查不到"的短期记忆**：热门标签只有 59 个，覆盖不了多少角色，
 * 大部分关键词都会查不到。实测每次查不到都要白等（首次 17 秒才轮到下一个源），
 * 所以记住"这个词最近查过、没有"，短期内直接报失败，把时间让给真正能搜的源。
 */
const TAG_TTL_MS = 30 * 60 * 1000;
const TAG_MISS_TTL_MS = 10 * 60 * 1000;
let tagCache = { at: 0, list: [] };
let tagListFailedUntil = 0;          // 标签接口整体失败（站点抽风）时的退避
const tagMissCache = new Map();      // keyword -> 查不到的到期时间

async function trendingTags({ log } = {}) {
  if (Date.now() - tagCache.at < TAG_TTL_MS && tagCache.list.length) return tagCache.list;
  if (Date.now() < tagListFailedUntil) throw new Error('热门标签接口刚刚失败过，暂不重试');
  try {
    const json = await apiGet('/trendingTags', { log });
    const list = listOf(json);
    if (list.length) tagCache = { at: Date.now(), list };
    return list;
  } catch (error) {
    // 接口失败也给一段退避，避免每个关键词都去撞一次墙
    tagListFailedUntil = Date.now() + 3 * 60 * 1000;
    throw error;
  }
}

/** 排行日期：**必须用 2 天前或更早**（实测今天/昨天返回空数据）。 */
function pickRankDate() {
  const back = 2 + Math.floor(Math.random() * 12);        // 2~13 天前
  return new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);
}

const MODES = ['day', 'week', 'day_male', 'day_female', 'week_original', 'week_rookie', 'month'];

/**
 * 标准化的 pick。
 * @param {{keyword?:string, sentKeys?:Set<string>, count?:number, timeoutMs?:number, token?:string,
 *          analysis?:object, filterKeyword?:string, relaxed?:boolean, log?:Function}} opts
 *   keyword       = 角色名（`#老婆 {角色名} {关键词}` 里的第一段）
 *   analysis      = 关键词分析结果（角色/作品的多语言标签，见 work-lookup.mjs）
 *   filterKeyword = `#老婆 {角色名} {关键词}` 里的**第二段**：用来筛选这个角色的图。
 *                   它可能是作品名（鸣潮）、也可能是风格词（猫耳/白丝/和服）。
 *                   作品名会翻译成多语言标签参与筛选；风格词直接当标签/标题关键词用。
 *   relaxed       = 标签没命中的结果要不要留（用户选的是保留，命中的优先）
 */
export async function pick({ keyword = '', sentKeys = new Set(), count = 3, timeoutMs, token = '', analysis = null, filterKeyword = '', relaxed = true, weeklyFirst = false, log } = {}) {
  const word = String(keyword ?? '').trim();
  const filter = String(filterKeyword ?? '').trim();
  const t = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(6000, timeoutMs) : 18000;
  const candidates = [];
  let how = '';

  /* ── 筛选词的标签（`#老婆 {角色名} {关键词}` 的第二段）─────────────────
   * 两种情况都要能处理：
   *   ① 是作品名（鸣潮 / 命运石之门）→ 查本地提示表拿到该作品的多语言标签
   *      （`鳴潮`/`Wuthering Waves`），用它做"作品标签命中"判断；
   *   ② 是风格词（猫耳 / 白丝 / 和服）→ **单独搜一次该词**，拿到"确实带这个标签"
   *      的作品 id 集合，再用**交集**筛角色图。
   *
   * ⚠️ 为什么风格词必须单独搜（实测）：
   *    `今汐 猫耳` 组合检索只有 5/29 条带「猫耳」标签 —— 组合检索会**稀释**
   *    风格词（Pixiv 的检索把空格当加分而非强制）。而单独搜「猫耳」30 条里
   *    28 条标签含该词。所以取交集才准。
   * ⚠️ 而且「今汐」自己的标签里**根本没有**"猫耳"（那是风格标签，不在角色图上），
   *    所以只能靠"风格词的检索结果 ∩ 角色的检索结果"。 */
  const filterTags = [];
  let filterIdSet = null;
  if (filter) {
    const hint = lookupWorkHint(filter);
    if (hint) {
      for (const tg of hint.tags) filterTags.push(tg);
      log?.(`筛选词「${filter}」识别为作品《${hint.work}》，标签[${hint.tags.join(', ')}]`);
    } else {
      /* 本地表不认识的词（如「命运石之门」「猫耳」）→ **单独搜一次**。
       * 这一步同时解决两件事：
       *   ① 拿到"确实带这个词"的作品 id 集合 → 与角色结果**取交集**（最准）；
       *   ② 从结果的高频标签里反推它到底是不是作品名（是作品就会有
       *      `Steins;Gate` 这类高频标签），从而也能走"作品标签命中"那条路。
       * 实测必要性：`今汐 猫耳` 组合检索只有 5/29 条带「猫耳」标签（组合检索会
       * 稀释风格词），而单独搜「猫耳」30 条里 28 条带该标签 —— 取交集才准。 */
      try {
        /* 多翻几页：**一页只有 30 条，交集会小得可怜**（实测「今汐+猫耳」
         * 只搜 1 页时交集仅 3 张、「守岸人+和服」仅 1 张，池子太小用户会觉得
         * "就这几张"）。翻 3 页能显著扩大交集。 */
        const frAll = [];
        const frSeen = new Set();
        for (let i = 0; i < 3; i += 1) {
          const fr = await searchByKeyword(filter, {
            token, page: i + 1, pageSize: 30, timeoutMs: Math.min(t, 10000), log, sort: 'popular'
          });
          if (!fr.ok || !fr.list.length) break;
          for (const w of fr.list) {
            const id = String(w?.id ?? '');
            if (id && !frSeen.has(id)) { frSeen.add(id); frAll.push(w); }
          }
          await sleep(200);
        }
        if (frAll.length) {
          filterIdSet = new Set(frAll.map((w) => String(w?.id ?? '')).filter(Boolean));
          const discovered = discoverWorkTags(frAll, filter);
          for (const tg of discovered.tags) filterTags.push(tg);
          log?.(`筛选词「${filter}」单独检索到 ${filterIdSet.size} 条作品`
            + `${discovered.tags.length ? `，反推标签[${discovered.tags.join(', ')}]` : '（未反推出作品标签，按普通词处理）'}`);
        }
      } catch (error) {
        log?.(`筛选词「${filter}」单独检索失败：${String(error?.message || error).slice(0, 50)}`);
      }
      if (!filterTags.length) {
        filterTags.push(filter);
        log?.(`筛选词「${filter}」按普通标签/关键词处理`);
      }
    }
  }
  const filterNorm = (s) => String(s ?? '').trim().toLowerCase().replace(/[\s_\-＊*・]/g, '');
  const filterSet = new Set(filterTags.map(filterNorm).filter(Boolean));
  /** 这条作品是否符合筛选词（标签命中，或标题含该词）。 */
  const matchesFilter = (w) => {
    if (!filter) return true;
    for (const tg of (w?.tags || [])) {
      for (const raw of [tg?.name, tg?.translatedName]) {
        const s = filterNorm(raw);
        if (s && [...filterSet].some((f) => s === f || s.startsWith(f))) return true;
      }
    }
    const title = String(w?.title || '');
    if (title.includes(filter)) return true;
    return [...filterSet].some((f) => f.length >= 3 && title.toLowerCase().includes(f));
  };


  /* ── 关键词模式 ──────────────────────────────────────────────────────────
   * 两条路：
   *   ① 配了 token → 走**真正的关键词搜索**（`/illustrations?keyword=`），最准
   *   ② 没配 token → 只能靠 59 个热门标签匹配
   * 两条路都**绝不拿排行榜图充数**。
   *
   * ⚠️ "绝不充数"是真机踩出来的大坑（正是用户说的"不合本意的图片"）：
   *    早期写成"标签没命中就退化成随机排行榜图，至少给出一张像样的 Pixiv 图"，
   *    于是 `#老婆 今汐` 发出来的是「特異対策特務部隊携帯機」、`#老婆 菲比` 发的是「心」——
   *    **关键词被完全忽略**，而且因为"成功出了图"，级联器不会再去找真正对的源
   *    （萌娘百科/Bing 本来能搜到今汐）。
   *    结论：关键词模式下，源要么给出**确实相关**的图，要么如实报失败让下一个源接手。
   *    "随便给一张"比"没有"更糟。 */
  if (word) {
    // ① 有 token：真正的搜索（有 analysis 时按多语言标签扩大检索再筛）
    if (String(token ?? '').trim()) {
      /* ── 检索策略（按用户明确要求调整过）──────────────────────────────
       * 用户要的流程是：
       *   ① 先按**角色名**搜（拿到这个角色的所有图）
       *   ② 用**关键词**筛选（`#老婆 {角色名} {关键词}`）
       *   ③ 按**热度排序取前几十张**（不是只从周榜/月榜上榜的里面挑）
       *   ④ 在这批里**随机抽一张**
       *
       * ⚠️ 早先的版本是"先抓周榜再本地筛角色"，实测**图太少**：
       *    周榜全榜仅约 182 条，初音ミク只命中 4 条、今汐 0 条 ——
       *    从 4 张里随机，用户会觉得"就这几张"。所以改成上面的顺序。
       *
       * 热度排序：接口原生支持 `sort=popular`（按收藏数）。
       * ⚠️ 关键词搜索索引**滞后约 3~4 个月**：近 7/30/60 天窗口全是 0 条，
       *    近 120 天才开始有数据。所以先试近窗口（更接近"近期热度"），
       *    但如果拿到的候选**角色标签命中率过低**（说明这批图和角色不相关），
       *    就退到全时段热度 —— 宁可少一点"新"，也不能发错图。 */
      let sr = { ok: false, list: [] };
      let source = '';
      if (weeklyFirst) {
        const hot = await searchHot(word, {
          token, pages: 3, windowDays: 120, timeoutMs: Math.min(t, 12000), log
        });
        if (hot.list.length) {
          const hits = analysis?.ok
            ? hot.list.filter((w) => scoreWork(w, analysis, word).hitCharacter).length
            : hot.list.length;
          const ratio = hot.list.length ? hits / hot.list.length : 0;
          if (analysis?.ok && ratio < 0.3) {
            log?.(`「${hot.how}」只有 ${hits}/${hot.list.length} 条命中角色标签（${Math.round(ratio * 100)}%），`
              + '相关性不足 → 改用全时段热度检索');
          } else {
            sr = { ok: true, list: hot.list };
            source = hot.how;
          }
        }
      }
      if (!sr.ok || !sr.list.length) {
        const all = await searchHot(word, {
          token, pages: 3, windowDays: 0, respectWindow: false, timeoutMs: Math.min(t, 12000), log
        });
        if (all.list.length) {
          sr = { ok: true, list: all.list };
          source = all.how;
        } else if (analysis?.ok) {
          sr = await searchByAnalysis(word, analysis, {
            token, pages: 3, pageSize: 30, timeoutMs: Math.min(t, 12000), log, maxQueries: 3
          });
          source = '多语言标签检索';
        } else {
          sr = await searchByKeyword(word, {
            token, page: 1 + Math.floor(Math.random() * 5), pageSize: 30, timeoutMs: Math.min(t, 12000), log
          });
          source = '普通关键词检索';
        }
      }
      if (sr.ok && sr.list.length) {
        let list = sr.list;
        /* ── 补量：候选太少时多翻几页角色图 ────────────────────────────────
         * 实测「今汐+猫耳」只搜 3 页（约 86 条）时筛完只剩 4 张 ——
         * 池子太小，用户会觉得"就这几张"（他明确抱怨过）。
         * 多翻几页能显著扩大筛选后的池子。只在池子偏小时做，避免每次都多请求。 */
        if (filter && list.length < 120) {
          try {
            const more = [];
            const moreSeen = new Set(list.map((w) => String(w?.id ?? '')));
            for (let i = 0; i < 4; i += 1) {
              const r2 = await searchByKeyword(word, {
                token, page: 4 + i, pageSize: 30, timeoutMs: Math.min(t, 10000), log, sort: 'popular'
              });
              if (!r2.ok || !r2.list.length) break;
              for (const w of r2.list) {
                const id = String(w?.id ?? '');
                if (id && !moreSeen.has(id)) { moreSeen.add(id); more.push(w); }
              }
              await sleep(200);
            }
            if (more.length) {
              log?.(`角色候选只有 ${list.length} 条，补翻到 ${list.length + more.length} 条再筛`);
              list = [...list, ...more];
            }
          } catch (error) {
            log?.(`补量失败（不影响出图）：${String(error?.message || error).slice(0, 40)}`);
          }
        }
        /* ── 筛选词过滤（`#老婆 {角色名} {关键词}` 的第二段）──────────────
         * 两条路：
         *   · 带 id 集合（风格词）→ 用**交集**，最准（实测「今汐 猫耳」组合检索
         *     只有 5/29 条带猫耳标签，而交集能保证每张都真带这个标签）
         *   · 否则（作品名）→ 用标签/标题命中判断
         * ⚠️ 命中太少时不硬筛：宁可发角色的图，也不要因为关键词太冷门而发不出图。 */
        if (filter) {
          /* 先算"文本/标签命中"（这个判断更宽松，包含交集结果），
           * 再算"交集"（更严格）。两者都算出来再决定用哪个池子 ——
           * ⚠️ 早先的写法是"交集为空才退回标签命中"，结果交集**恰好 1~2 张**时
           *    会卡在极小的池子里（用户抱怨的"就这几张"），而交集为空时反而
           *    会退化成完全不筛。（实测「守岸人+和服」「今汐+猫耳」都撞上过。） */
          const byTag = list.filter(matchesFilter);
          const byId = filterIdSet && filterIdSet.size
            ? list.filter((w) => filterIdSet.has(String(w?.id ?? '')))
            : [];
          const MIN_FILTER_POOL = 12;
          let hit = [];
          let how = '';
          if (byId.length >= MIN_FILTER_POOL) {
            hit = byId; how = '交集（确实带该标签）';
          } else if (byTag.length >= MIN_FILTER_POOL) {
            hit = byTag; how = '标签/标题命中';
          } else if (byId.length || byTag.length) {
            // 两个都太小 → 合并去重，尽量把池子撑到十几张
            const merged = [];
            const seenIds = new Set();
            for (const w of [...byId, ...byTag]) {
              const id = String(w?.id ?? '');
              const k = id || `${w?.title}|${w?.createDate}`;
              if (seenIds.has(k)) continue;
              seenIds.add(k);
              merged.push(w);
            }
            hit = merged;
            how = `交集 ${byId.length} 张 + 标签命中 ${byTag.length} 张（都偏少，合并）`;
          }
          if (hit.length) {
            log?.(`筛选词「${filter}」筛出 ${hit.length}/${list.length} 条（${how}）`);
            list = hit;
          } else {
            log?.(`筛选词「${filter}」在 ${list.length} 条里一条都没命中 → 不按它筛（避免发不出图）`);
          }
          /* ── 最后一个兜底：池子仍然太小 → 用**作品标签**扩大角色搜索 ──────
           * 实测「心月狐+鸣潮」筛完只剩 1 张：因为心月狐的图常被标成
           * `心(鳴潮)` 这类**作品化的角色标签**，搜角色名本身搜不到多少。
           * 这时改成用作品标签（鳴潮 / Wuthering Waves）去搜，
           * 再从结果里挑标题或标签含角色名的 —— 能把池子撑起来。
           * 只在池子确实太小（< 8）时才做，避免每次都多请求。 */
          if (filter && list.length < 8 && analysis?.ok) {
            const workTagsForBroaden = (analysis.workTags || []).filter(Boolean);
            if (workTagsForBroaden.length) {
              const broad = [];
              const broadSeen = new Set(list.map((w) => String(w?.id ?? '')));
              for (const tg of workTagsForBroaden.slice(0, 3)) {
                const r3 = await searchByKeyword(tg, {
                  token, page: 1 + Math.floor(Math.random() * 2), pageSize: 30,
                  timeoutMs: Math.min(t, 10000), log, sort: 'popular'
                });
                if (!r3.ok || !r3.list.length) continue;
                for (const w of r3.list) {
                  const id = String(w?.id ?? '');
                  if (id && !broadSeen.has(id)) { broadSeen.add(id); broad.push(w); }
                }
                await sleep(200);
              }
              /* 从扩大后的结果里挑"和角色相关"的（标题含角色名，或标签含角色名） */
              const charNames = [word, analysis.character].filter(Boolean);
              const related = broad.filter((w) => {
                const title = String(w?.title || '');
                if (charNames.some((c) => title.includes(c))) return true;
                return (w?.tags || []).some((tg) => charNames.some((c) =>
                  String(tg?.name || '').includes(c) || String(tg?.translatedName || '').includes(c)));
              });
              const extra = (related.length ? related : broad).filter((w) => matchesFilter(w));
              if (extra.length) {
                log?.(`池子仅 ${list.length} 张 → 用作品标签[${workTagsForBroaden.slice(0, 3).join('/')}]`
                  + `扩大搜索，补入 ${extra.length} 张`);
                list = [...list, ...extra];
              } else {
                log?.(`用作品标签扩大搜索也没找到更多（当前 ${list.length} 张）`);
              }
            }
          }
        }
        /* 用标签打分筛掉跑偏的，并按「相关度 → 标题语言(中→英→日)」排序。
         * 实测标签比标题可靠得多：搜「今汐」时 87/88 条的标签含"今汐"，
         * 而不少图标题只写「無題」这类无意义内容。 */
        if (analysis?.ok) {
          const ranked = rankWorks(list, analysis, { keyword: word, relaxed });
          const hitChar = ranked.filter((x) => x.hitCharacter).length;
          const hitWork = ranked.filter((x) => x.hitWork).length;
          const zh = ranked.filter((x) => x.lang === 'zh').length;
          log?.(`Pixivic 标签筛选：${list.length} 条 → 保留 ${ranked.length} 条`
            + `（命中角色 ${hitChar}、命中作品 ${hitWork}、中文标题 ${zh}）`);
          // 把档位带上：后面按档位分层随机（排序会被随机挑选覆盖，所以必须带 tier）
          for (const x of ranked) {
            const c = toCandidate(x.work, 'Pixivic');
            if (c) {
              c.tier = x.score;
              c.lang = x.lang;
              // 热度作为同档内的次要依据（周榜/收藏排序已保证大致有序）
              c.hot = Number(x.work?.totalBookmarks ?? 0) || 0;
              candidates.push(c);
            }
          }
          if (!candidates.length) log?.('Pixivic 标签筛选后没有可用候选（宽松模式不该发生）');
        } else {
          for (const w of list) {
            const c = toCandidate(w, 'Pixivic');
            if (c) { c.hot = Number(w?.totalBookmarks ?? 0) || 0; candidates.push(c); }
          }
        }
        if (candidates.length) {
          how = `「${word}」${filter ? `+「${filter}」` : ''}检索`
            + `${source ? `（${source}）` : ''} → ${candidates.length} 张可用`;
          log?.(`Pixivic 搜索命中 ${candidates.length} 张：${how}`);
        }
      } else if (!sr.ok) {
        log?.(`Pixivic 搜索未成功（${sr.reason || '无结果'}），退回热门标签匹配`);
      } else {
        log?.(`Pixivic 搜索「${word}」没有结果，退回热门标签匹配`);
      }
    }

    // ② 没 token（或搜索没结果）：热门标签匹配
    if (!candidates.length) {
      // 最近查过、确实没有 → 直接报失败，不再重复查询（省下几秒让下一个源早点接手）
      const missUntil = tagMissCache.get(word) || 0;
      if (Date.now() < missUntil) {
        log?.(`Pixivic 热门标签里「${word}」刚刚查过没有 → 直接交给下一个图源`);
        return { ok: false, reason: `Pixivic 的热门标签里没有「${word}」` };
      }
      let tags = [];
      try {
        tags = await trendingTags({ log });
      } catch (error) {
        log?.(`Pixivic 热门标签获取失败：${String(error?.message || error).slice(0, 60)}`);
      }
      const lower = word.toLowerCase();
      const hits = tags.filter((x) => {
        const name = String(x?.name ?? '').toLowerCase();
        const trans = String(x?.translatedName ?? '').toLowerCase();
        return name.includes(lower) || trans.includes(lower);
      });
      if (!hits.length) {
        tagMissCache.set(word, Date.now() + TAG_MISS_TTL_MS);
        log?.(`Pixivic 热门标签里没有「${word}」→ 报失败，交给下一个图源（不拿排行榜图充数）`);
        return {
          ok: false,
          reason: `Pixivic 的热门标签里没有「${word}」（不配 token 时只能匹配热门标签；配了 token 才能任意关键词搜索）`
        };
      }
      how = `热门标签命中「${hits.map((h) => h.name).slice(0, 3).join('/')}」`;
      for (const hit of hits.slice(0, 3)) {
        const c = toCandidate(hit.illustration, 'Pixivic');
        if (c) candidates.push(c);
      }
      if (!candidates.length) {
        return { ok: false, reason: `Pixivic 命中了「${word}」的标签但没取到可用图片` };
      }
    }
  }

  // ── 无关键词：随机取排行榜（随机日期 + 随机 mode，保证每次不一样）──
  // 注意这里是 `!word` 而不是 `!candidates.length`：
  // 关键词模式在上面已经"命中就返回图、没命中就报失败"，
  // **不能**因为候选为空就掉进排行榜分支 —— 那正是"关键词被忽略"的根源。
  if (!word) {
    const tries = Math.max(1, Math.min(3, count));
    for (let i = 0; i < tries && candidates.length < 3; i += 1) {
      const date = pickRankDate();
      const mode = MODES[Math.floor(Math.random() * MODES.length)];
      const page = 1 + Math.floor(Math.random() * 3);
      try {
        const json = await apiGet(`/ranks?page=${page}&pageSize=30&date=${date}&mode=${mode}`, { timeoutMs: t, log });
        const list = listOf(json);
        if (!list.length) {
          log?.(`Pixivic 排行 ${date}/${mode} 没有数据（该日期排行可能未生成）`);
          await sleep(400);
          continue;
        }
        for (const w of list) {
          const c = toCandidate(w, 'Pixivic');
          if (c) candidates.push(c);
        }
        if (!how) how = `排行榜 ${date}/${mode}（${list.length} 条）`;
        log?.(`Pixivic 排行 ${date}/${mode} 取到 ${list.length} 条，可用 ${candidates.length} 张`);
      } catch (error) {
        log?.(`Pixivic 排行请求失败（${date}/${mode}）：${String(error?.message || error).slice(0, 60)}`);
      }
      await sleep(500);
    }
  }

  // ── 兜底：特辑（排行榜也没数据时）──
  if (!candidates.length) {
    try {
      const json = await apiGet('/spotlights?page=1&pageSize=20', { timeoutMs: t, log });
      for (const s of listOf(json)) {
        const c = toCandidate({ id: s.id, title: s.title, imageUrls: { large: s.thumbnail } }, 'Pixivic 特辑');
        if (c) candidates.push(c);
      }
      if (candidates.length) how = `Pixivision 特辑（${candidates.length} 张）`;
    } catch (error) {
      log?.(`Pixivic 特辑获取失败：${String(error?.message || error).slice(0, 60)}`);
    }
  }

  if (!candidates.length) {
    return {
      ok: false,
      reason: word ? `Pixivic 上没有和「${word}」相关的图（它的搜索需要登录，只能匹配热门标签）` : 'Pixivic 这次没取到可用的图'
    };
  }

  // 去重（接口可能重复返回同一作品）
  const uniq = [];
  const seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    uniq.push(c);
  }

  const fresh = uniq.filter((c) => !sentKeys.has(c.key));
  const reused = fresh.length === 0;
  const pool = reused ? uniq : fresh;

  /* ── 挑选：按热度排序取前 N 张，再在 N 张里随机抽一张 ──────────────────
   * 这是用户明确要求的流程：
   *   搜角色 → 关键词筛选 → **按热度排序取前几十张** → 随机抽一张。
   *
   * ⚠️ 演进过程（每一步都是实测踩出来的，别退回去）：
   *   ① 最早是"整池纯随机"：把上面的排序完全浪费了 ——
   *      实测「今汐」筛完有 41 个中文标题、49 条命中角色标签，
   *      纯随机却抽到日文标题的「フローヴァ」。
   *   ② 后来改成"只在最高相关度档里随机"，保证了相关性，但**池子可能很小**
   *      （有时只剩 1~4 张），用户会觉得"每次都是这几张"。
   *   ③ 现在：先按「相关度 → 标题语言(中→英→日) → 收藏数」排序，
   *      取前 HOT_POOL_SIZE 张，再在这 N 张里随机 ——
   *      既保证是热门好图，又有足够随机空间（用户要的"十几个或几十个"）。
   * 因为池子取前 N 张，所以"优先中文"是**排序偏好**而不是硬过滤，
   * 不会像以前那样把池子缩到只剩几张。 */
  const HOT_POOL_SIZE = 40;
  const hotOf = (c) => (Number.isFinite(c.hot) ? c.hot : 0);
  const LANG_RANK_PICK = { zh: 0, en: 1, jp: 2, other: 3 };
  const ranked = [...pool].sort((a, b) => {
    const ta = a.tier ?? -1;
    const tb = b.tier ?? -1;
    if (tb !== ta) return tb - ta;                      // ① 相关度
    const la = LANG_RANK_PICK[a.lang] ?? 9;
    const lb = LANG_RANK_PICK[b.lang] ?? 9;
    if (la !== lb) return la - lb;                      // ② 标题语言（中文优先）
    return hotOf(b) - hotOf(a);                         // ③ 收藏数（热度）
  });
  const hotPool = ranked.slice(0, HOT_POOL_SIZE);
  const pickPool = hotPool.length ? hotPool : pool;
  const chosen = pickPool[Math.floor(Math.random() * pickPool.length)];
  const tiers = pickPool.map((c) => c.tier ?? -1);
  const hots = pickPool.map(hotOf);
  log?.(`Pixivic 热度池：${pool.length} 张中取热度前 ${pickPool.length} 张随机`
    + `（相关度档 ${Math.min(...tiers)}~${Math.max(...tiers)}`
    + `${hots.some((x) => x > 0) ? `，收藏数 ${Math.min(...hots)}~${Math.max(...hots)}` : ''}）`);

  log?.(`Pixivic ${how} → 安全过滤后 ${uniq.length} 张 → 选中 ${chosen.key}（${chosen.lang || '?'}）`);
  return {
    ok: true, reused, pool: uniq.length,
    pick: {
      url: chosen.url, file: chosen.file, title: chosen.title,
      credit: chosen.author ? `Pixivic(Pixiv) · ${chosen.author}` : 'Pixivic(Pixiv)',
      pageUrl: chosen.pageUrl, key: chosen.key, referer: chosen.referer,
      // 选中的这张图的其他尺寸地址，供下载器兜底
      variants: chosen.variants
    },
    alternates: [
      // ① 先给**同一张图**的其他尺寸（老图缺 master1200 变体时靠这个救回来）
      ...(chosen.variants || []).filter((v) => v.url !== chosen.url)
        .map((v) => ({ url: v.url, referer: v.referer, file: chosen.file, title: chosen.title, credit: 'Pixivic(Pixiv)', pageUrl: chosen.pageUrl, key: chosen.key })),
      // ② 再给别的作品
      ...pool.filter((c) => c.key !== chosen.key).slice(0, 5).map((c) => ({
        url: c.url, file: c.file, title: c.title, credit: 'Pixivic(Pixiv)', pageUrl: c.pageUrl, key: c.key, referer: c.referer
      }))
    ]
  };
}

/** 站点自检（供插件启动日志用）。 */
export async function selfCheck({ log } = {}) {
  try {
    const json = await apiGet('/trendingTags', { timeoutMs: 12000, log });
    const n = listOf(json).length;
    return n > 0
      ? { ok: true, reason: `Pixivic 可用（热门标签 ${n} 个）` }
      : { ok: false, reason: 'Pixivic 接口通但没返回标签' };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 90) };
  }
}
