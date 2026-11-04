// 表情包配图：从 aigengtu 图库挑图，给说说配图用。
//
// 图库来源与 reply-meme 技能同一个（gallery-index.json）。协议端会自己把图片直链
// 抓下来上传到空间相册，所以这里只负责"挑"。
//
// 为什么只放 aigengtu 的图：见 safe-topic.js 的 isAllowedImageUrl。放开任意 URL
// 等于开了一条把任意外链搬进自己空间的通道。
//
// ── 这个图库的真实构成（实测，约 1416 张）────────────────────────────────
//
//   约 1000 张  标题形如 `DeepSeek娘『<角色台词>』<情绪>表情包`
//                『』里是**图上印的台词**，后面那截才是描述，例：
//                「DeepSeek娘『真当我是便宜货啊』气鼓鼓表情包」
//   约 400 张   标题形如 `DeepSeek娘<动作/情绪的连写>表情包`
//                例：「DeepSeek娘下班瘫家玩手机快乐摸鱼表情包」
//   一小批      标题毫无信息量（就是「DeepSeek娘表情包」），**必须排除** ——
//                否则搜任何词都能"命中"它，模型会拿到一张跟内容毫无关系的图
//                还以为匹配上了。过滤后可用约 764 张。
//
// 分类极度倾斜：DeepSeek娘 占绝大多数，"配图搭不搭"实际等于
// **"表情配不配得上这条说说的情绪"**。
//
// ── 踩过的坑（都实机暴露过）──────────────────────────────────────────────
//
// 1. **关键词匹配失败时静默退回全库**：模型传"游戏"，图库里没这个词，代码不吭声
//    地从全库随机挑几张，还告诉模型"挑一张搭的"。模型只能瞎选。
//    现在：匹配不到就明确报 matchedKeyword=false，并给出图库真实标签供换词重试。
// 2. **匹配字段是整个标题**：`DeepSeek娘` 这个前缀出现在**每一张**标题里，
//    于是搜任何东西都可能因为前缀而"命中"。现在只匹配**去掉前后缀后的描述段**。
// 3. **无信息量的标题参与匹配**：见上，现在直接剔除。
// 4. **候选顺序随机**：模型倾向选第一条，结果挑中信息最少的那张
//    （「内容描述:（无描述）/ 图上台词: 摸鱼」），而候选里明明有更贴的。
//    现在按**信息量**排序（见 scoreEntry）。
// 5. **描述的『』里可能装的是元数据**（时间戳、文件名、水印），剥完只剩数字字母。
//    这种参与匹配会污染结果，现在要求描述/台词**必须含中文**才算有效。

const INDEX_URL = 'https://aigengtu.com/gallery-index.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 图库前缀（每一张标题都有，不含信息）。 */
const NAME_PREFIX = /^DeepSeek(?:女仆鲸娘|女仆娘|鲸娘|模型娘化|娘|鲸鱼娘)?/;
/** 无信息量的纯占位标题：只有角色名 +「表情包」。 */
const PLACEHOLDER = /^(?:DeepSeek)?(?:女仆鲸娘|女仆娘|鲸娘|模型娘化|娘|鲸鱼娘)?(?:表情包)?$/;

/**
 * 把图库标题拆成「描述段」—— 只保留有信息的那部分。
 *
 *   `DeepSeek娘『真当我是便宜货啊』气鼓鼓表情包`
 *      → label = '真当我是便宜货啊'（图上台词）
 *        desc  = '气鼓鼓'          （情绪/场景，真正的匹配维度）
 *
 *   `DeepSeek娘下班瘫家玩手机快乐摸鱼表情包`
 *      → label = ''  desc = '下班瘫家玩手机快乐摸鱼'
 *
 * 没有信息量的（`DeepSeek娘表情包`）返回 null，调用方直接丢掉。
 */
export function parseTitle(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return null;

  const m = /『([^』]*)』/.exec(t);
  let label = m ? m[1].trim() : '';
  let desc = t
    .replace(NAME_PREFIX, '')
    .replace(/『[^』]*』/g, '')
    .replace(/《[^》]*》/g, '')
    .replace(/表情包\s*$/, '')
    .replace(/^[：:、,，\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!desc && !label) return null;
  if (PLACEHOLDER.test(desc)) desc = '';
  // 必须含中文才算有效（挡掉时间戳/文件名/水印那类元数据）
  if (desc && !/[\u4e00-\u9fa5]/.test(desc)) desc = '';
  if (label && !/[\u4e00-\u9fa5]/.test(label)) label = '';
  if (!desc && !label) return null;

  return { label, desc };
}

/** 从图库条目里抽出一条可用的（original 必须是白名单域名下的表情包图片）。 */
function toEntry(value) {
  if (!value || typeof value.original !== 'string') return null;
  if (!/https?:\/\/img\.aigengtu\.com\/meme\/\d+\.(webp|png|jpe?g|gif)$/i.test(value.original)) return null;
  const parsed = parseTitle(value.name || value.alt || '');
  return {
    original: value.original,
    raw: String(value.name || '').trim(),
    label: parsed ? parsed.label : '',
    desc: parsed ? parsed.desc : '',
    // 占位图：标题只有角色名 + 一个纯数字 ID（『1000382598』），没有可用的文字信息。
    // 这类图**不能参与关键词匹配**（标签是空的，搜什么都命中不了它），但**按角色浏览
    // 时可以用** —— 它确实是那个角色的图，只是图库没告诉我们图上写了什么。
    // 实测这部分有 652 张（DeepSeek娘 分类 1390 张里有 738 张是有标签的），
    // 全排除会让"发张鲸鱼娘图"的候选池白白少掉近一半。
    placeholder: !parsed,
    category: String(value.category || '').trim()
  };
}

/**
 * 在描述段 + 台词里找关键词（大小写不敏感）。
 *
 * ⚠️ 占位图（`placeholder`）直接返回 false —— 它的 desc/label 都是空串，任何关键词
 *    都不该"命中"它。否则传空字符串之类的边界输入会让整库都算命中。
 */
function matches(entry, kw) {
  if (entry.placeholder) return false;
  const k = kw.toLowerCase();
  return entry.desc.toLowerCase().includes(k) || entry.label.toLowerCase().includes(k);
}

/**
 * 给候选打分：**信息越具体的越靠前**。
 * 排序不该是随机的，应该把"更能说明自己是什么"的图放前面。
 */
function scoreEntry(e, kw) {
  let s = 0;
  const desc = String(e.desc || '');
  const label = String(e.label || '');
  const k = String(kw || '').toLowerCase();

  // 占位图（标题只有角色名 + ID）：内容不可预期，浏览时排到最后。
  // 它仍在候选池里（提供多样性），但不该挤掉那些"知道自己在说什么"的图。
  if (e.placeholder) return -100;

  if (desc) s += 4;                                          // 有描述
  if (desc && k && desc.toLowerCase().includes(k)) s += 6;   // 描述命中关键词
  if (label && k && label.toLowerCase().includes(k)) s += 2; // 台词命中（较弱）
  if (desc.length >= 6 && desc.length <= 20) s += 3;         // 描述长度适中
  if (desc && desc.length <= 3) s -= 3;                      // 描述太短，没信息
  if (!desc && label.length <= 3) s -= 4;                    // 只有一句超短台词，最差
  return s;
}

/**
 * 排序 + 分类均衡。
 * 先按信息量降序，再在同分段内做分类均衡 —— 既保证好候选在前，
 * 又避免清一色 DeepSeek娘（图库里它占绝大多数）。
 */
function rankAndBalance(pool, limit, kw) {
  const scored = pool.map((e) => ({ e, s: scoreEntry(e, kw) })).sort((a, b) => b.s - a.s);
  const picked = [];
  const usedCat = new Map();
  const rest = scored.slice();

  while (picked.length < limit && rest.length) {
    const best = rest[0].s;
    let idx = 0;
    let bestPenalty = Infinity;
    for (let i = 0; i < rest.length && rest[i].s === best; i++) {
      const cat = rest[i].e.category || '(未分类)';
      const penalty = usedCat.get(cat) || 0;
      if (penalty < bestPenalty) { bestPenalty = penalty; idx = i; }
    }
    const chosen = rest.splice(idx, 1)[0].e;
    const cat = chosen.category || '(未分类)';
    usedCat.set(cat, (usedCat.get(cat) || 0) + 1);
    picked.push(chosen);
  }
  return picked;
}

/**
 * 从图库里抽一批**真实的标签文本**给模型看。
 *
 * 早期版本这里做的是 n-gram 词频统计（"出现 ≥3 次的 2~4 字片段"），结果全是
 * `10(225) 00(223)` 这种垃圾 —— 因为台词里混着 `001.webp` 之类的文件名，
 * 数字和英文被切成了碎片。词表要能读懂才有用，碎片反而误导模型。
 *
 * 现在直接给**完整、可读的标签**，让模型自己归纳该用什么词。
 * 这比任何预先设计的词表都准 —— 而且图库加图后自动跟着变。
 */
function sampleLabels(all, n = 14) {
  const pool = all.map((e) => {
    if (e.desc && e.label) return e.desc + '（台词：' + e.label.slice(0, 16) + '）';
    return e.desc || e.label;
  }).filter((s) => s && /[\u4e00-\u9fa5]/.test(s));
  const picked = [];
  const seen = new Set();
  for (let i = 0; i < pool.length * 2 && picked.length < n; i++) {
    const v = pool[Math.floor(Math.random() * pool.length)];
    if (seen.has(v)) continue;
    seen.add(v);
    picked.push(v);
  }
  return picked;
}

/**
 * 取一批表情包候选。
 *
 * @param {Function} fetchImpl 注入的 fetch（受 skill.json 的 web_fetch 权限门禁）
 * @param {{keyword?:string, category?:string, limit?:number, digest?:boolean}} opts
 */
export async function pickMemes(fetchImpl, opts) {
  const o = opts || {};
  const keyword = o.keyword || '';
  const category = o.category || '';
  const limit = o.limit || 30;
  const digest = !!o.digest;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let raw;
  try {
    const res = await fetchImpl(INDEX_URL, { headers: { 'User-Agent': UA, accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    raw = await res.json();
  } finally { clearTimeout(timer); }

  // 索引结构：{ gallery: { <分类>: { name, images: [...] } } }。
  // 兼容「分类 → 数组」的旧形态，免得图库方改一次结构就静默失效。
  const gallery = raw && raw.gallery;
  if (!gallery || typeof gallery !== 'object') return { items: [], error: '图库索引结构不认识' };

  const all = [];
  for (const cat of Object.keys(gallery)) {
    const node = gallery[cat];
    const list = Array.isArray(node) ? node
      : (node && Array.isArray(node.images)) ? node.images
      : (node && Array.isArray(node.items)) ? node.items
      : null;
    if (!list) continue;
    for (const v of list) {
      const e = toEntry(v);
      if (e) { e.category = e.category || cat; all.push(e); }
    }
  }
  if (!all.length) return { items: [], error: '图库里没有可用图片' };

  const vocabulary = digest ? sampleLabels(all.filter((e) => !e.placeholder)) : undefined;
  const cat = String(category).trim();
  const kw = String(keyword).trim();

  let pool = all;
  if (cat) {
    const byCat = pool.filter((e) => e.category === cat);
    if (byCat.length) pool = byCat;
  }

  let hit = true;
  // 是否把"占位图"（标题只有角色名+ID）也算进候选。
  //
  // 判据：**有没有给关键词**。
  //   · 给了关键词 → 只从有标签的图里选。占位图标签为空，放进候选池毫无意义
  //     （它永远匹配不上），只会稀释结果。
  //   · 没给关键词（按角色浏览 / 随机来一张）→ 纳入。这些图确实是该角色的图，
  //     只是图库没记录图上写了什么；排除它们会让候选池白白少掉近一半
  //     （DeepSeek娘 1390 张里只有 738 张有标签）。
  const allowPlaceholder = !kw;
  if (!allowPlaceholder) pool = pool.filter((e) => !e.placeholder);

  if (kw) {
    const byKw = pool.filter((e) => matches(e, kw));
    if (byKw.length) {
      pool = byKw;
    } else {
      // ⚠️ 关键：**不再静默退回全库**。明确告诉调用方"没这个词"。
      hit = false;
      pool = [];
    }
  }

  if (!hit) {
    return {
      items: [],
      total: all.length,
      matched: 0,
      matchedKeyword: false,
      vocabulary,
      keyword: kw
    };
  }

  return {
    items: rankAndBalance(pool, Math.max(1, limit), kw),
    total: all.length,
    matched: pool.length,
    matchedKeyword: true,
    // 本次候选里含多少张"无标签"的图 —— 让调用方（和模型）知道结果里可能混有
    // 说不清内容的图。给关键词时为 0。
    placeholderIncluded: allowPlaceholder ? pool.filter((e) => e.placeholder).length : 0,
    vocabulary,
    keyword: kw
  };
}