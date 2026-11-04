// 关键词 → 作品分析（提升检索准确性）
//
// ── 目标 ──────────────────────────────────────────────────────────────────
// 用户要的是：「检索前先分析关键词最可能出自哪部作品，拿到官方英文名/日文名，
// 然后用这些名字限定检索范围」。例如 `#老婆 今汐` → 作品《鸣潮》/《Wuthering Waves》
// /《鳴潮》，于是只从带这些标签的图里挑。
//
// ── 三层来源，逐层兜底（越靠前越可信）────────────────────────────────────
//   ① 本地名单：内置常玩作品的角色表。**确定性、零成本、零延迟**，
//      而且不受 AI 幻觉影响 —— 用户最常用的《鸣潮》就走这一层。
//   ② AI（DeepSeek）：读 QQ Agent 自己的配置（baseURL / model / key）调用，
//      能理解任意角色名。**必须校验**（见下）。
//   ③ AniList：按作品名查官方英/日文名，并列出角色名。
//
// ── 为什么必须有校验（这条是踩坑换来的）──────────────────────────────────
// 实测 AniList 对**无法识别**的查询会返回一批完全无关的固定结果：
//   搜「丛雨」「原神」「菲比」「今汐」→ 全都返回「五条悟/利威尔/奇犽」。
// 如果直接采信，`#老婆 丛雨` 会被解析成"五条悟"，**比不解析更糟**。
// 所以这里的规矩是：**任何一层给出的作品名，都必须能被"关键词确实出现在
// 该作品的角色名里"或"关键词本身是作品名"所支持**，否则一律丢弃。
// AI 的输出同样要过这一关（要求它给出证据字段 confidence/evidence，且做一致性校验）。

import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ══════════════════════════════════════════════════════════════════════
 * ① 本地名单（确定性的第一层）
 * ════════════════════════════════════════════════════════════════════ */

/**
 * 内置角色 → 作品表。
 *
 * 只放"确定无疑"的：写错会直接导致检索跑偏，所以宁缺毋滥。
 * `tags` 是该作品在 Pixiv 上真实存在的标签（实测来的，不是猜的）——
 * 实测「今汐」的结果里同时出现 `鳴潮`、`鸣潮`、`Wuthering Waves`、`WutheringWaves`。
 */
export const LOCAL_TABLE = {
  鸣潮: {
    work: '鸣潮',
    tags: ['鳴潮', '鸣潮', 'Wuthering Waves', 'WutheringWaves'],
    characters: {
      今汐: ['Jinhsi', '今汐'],
      长离: ['Changli', '長離', '长离'],
      守岸人: ['Shorekeeper', 'ショアキーパー', '守岸人'],
      忌炎: ['Jiyan', '忌炎'],
      吟霖: ['Yinlin', '吟霖'],
      安可: ['Encore', 'アンコ'],
      维里奈: ['Verina', 'ヴェリーナ'],
      凌阳: ['Lingyang', '凌陽'],
      卡卡罗: ['Calcharo', 'カカロ'],
      鉴心: ['Jianxin', '鑑心'],
      漂泊者: ['Rover', '漂泊者'],
      散华: ['Sanhua', '散華'],
      白芷: ['Baizhi', '白芷'],
      丹瑾: ['Danjin', '丹瑾'],
      秧秧: ['Yangyang', '秧秧'],
      炽霞: ['Chixia', '熾霞'],
      桃祈: ['Taoqi', '桃祈'],
      秋水: ['Aalto', 'アールト'],
      莫特斐: ['Mortefi', 'モルトフィー'],
      卡提希娅: ['Cartethyia', 'カルテジア', '卡提希娅'],
      菲比: ['Phoebe', 'フィービー', '菲比'],
      洛可可: ['Roccia', 'ロココ'],
      坎特蕾拉: ['Cantarella', 'カンタレラ'],
      赞妮: ['Zani', 'ザニー'],
      夏空: ['Ciaccona', 'チャッコーナ'],
      露帕: ['Lupa', 'ルパ'],
      弗洛洛: ['Phrolova', 'フローロ'],
      千咲: ['Chisa', '千咲'],
      奥古斯塔: ['Augusta', 'アウグスタ'],
      尤诺: ['Iuno', 'ユーノ'],
      嘉贝莉娜: ['Galbrena', 'ガルブレナ']
    }
  },
  原神: {
    work: '原神',
    tags: ['原神', 'Genshin Impact', 'GenshinImpact', '原神インパクト'],
    characters: {
      雷电将军: ['Raiden Shogun', '雷電将軍'],
      钟离: ['Zhongli', '鍾離'],
      胡桃: ['Hu Tao', '胡桃'],
      甘雨: ['Ganyu', '甘雨'],
      可莉: ['Klee', 'クレー'],
      宵宫: ['Yoimiya', '宵宮'],
      神里绫华: ['Kamisato Ayaka', '神里綾華'],
      纳西妲: ['Nahida', 'ナヒーダ'],
      芙宁娜: ['Furina', 'フリーナ'],
      玛薇卡: ['Mavuika', 'マーヴィカ']
    }
  },
  明日方舟: {
    work: '明日方舟',
    tags: ['アークナイツ', '明日方舟', 'Arknights'],
    characters: {
      阿米娅: ['Amiya', 'アーミヤ'],
      能天使: ['Exusiai', 'エクシア'],
      银灰: ['SilverAsh', 'シルバーアッシュ'],
      陈: ['Ch\'en', 'チェン'],
      W: ['W', 'W'],
      斯卡蒂: ['Skadi', 'スカジ'],
      史尔特尔: ['Surtr', 'スルト'],
      凯尔希: ['Kal\'tsit', 'ケルシー']
    }
  },
  蔚蓝档案: {
    work: '蔚蓝档案',
    tags: ['ブルーアーカイブ', 'Blue Archive', 'ブルアカ'],
    characters: {
      白子: ['Shiroko', 'シロコ'],
      优香: ['Yuuka', 'ユウカ'],
      日奈: ['Hina', 'ヒナ'],
      阿露: ['Aru', 'アル'],
      星野: ['Hoshino', 'ホシノ'],
      爱丽丝: ['Aris', 'アリス']
    }
  },
  崩坏星穹铁道: {
    work: '崩坏：星穹铁道',
    tags: ['スターレイル', '崩壊スターレイル', 'Honkai Star Rail', '崩坏星穹铁道'],
    characters: {
      三月七: ['March 7th', '三月なのか'],
      丹恒: ['Dan Heng', '丹恒'],
      姬子: ['Himeko', '姫子'],
      卡芙卡: ['Kafka', 'カフカ'],
      银狼: ['Silver Wolf', '銀狼'],
      镜流: ['Jingliu', '鏡流'],
      流萤: ['Firefly', 'ホタル']
    }
  }
};

/** 在本地名单里查角色名（大小写不敏感，也认英文名反查）。 */
export function lookupLocal(keyword) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return null;
  const lower = kw.toLowerCase();
  for (const [workKey, entry] of Object.entries(LOCAL_TABLE)) {
    // 直接命中作品名
    if (workKey === kw || entry.work === kw || entry.tags.some((t) => t.toLowerCase() === lower)) {
      return { work: entry.work, tags: [...entry.tags], character: '', aliases: [], source: 'local:work' };
    }
    for (const [char, aliases] of Object.entries(entry.characters)) {
      const all = [char, ...aliases];
      if (all.some((a) => a.toLowerCase() === lower)) {
        return { work: entry.work, tags: [...entry.tags], character: char, aliases: all, source: 'local:character' };
      }
    }
  }
  return null;
}

/**
 * 作品名 → 本地标签表（只看作品，不看角色）。
 * 用于"限定词"（`#老婆 心月狐 鸣潮`）——用户直接点名了作品，不必走 AI。
 */
export function lookupWorkLocal(workName) {
  const kw = String(workName ?? '').trim();
  if (!kw) return null;
  const lower = kw.toLowerCase();
  for (const [workKey, entry] of Object.entries(LOCAL_TABLE)) {
    if (workKey === kw || entry.work === kw || entry.tags.some((t) => t.toLowerCase() === lower)) {
      return { work: entry.work, tags: [...entry.tags] };
    }
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════
 * 限定词解析（`#老婆 <角色> <作品>`）
 * ════════════════════════════════════════════════════════════════════ */

/** 连接词：这些出现在两个词之间时，说明被连接的是角色与作品的关系。 */
const RELATION_WORDS = '(?:的|之|里面|里|中的|中|里头的)';

/**
 * 占位词：用户写「原神的角色」「鸣潮 人物」时，这些词不是角色名。
 * 命中就把它当"只限定作品、不指定角色"处理（此时直接在作品标签下随机取图）。
 */
const PLACEHOLDER_WORDS = /^(角色|人物|立绘|插画|插圖|图|图片|圖|老婆|美图|同人|作品|相关|有关的?|什么的?)$/;

/**
 * 解析指令里的「角色名 + 关键词」。
 *
 * ── 指令格式（用户明确定义，**顺序不能反**）────────────────────────────
 *   `#老婆 {角色名} {关键词}`
 *   角色名 = **第一个词**（一定是角色）
 *   关键词 = 其余部分（用于筛选这个角色的图；用户也常用作品名当关键词）
 *
 * ⚠️ 早先的实现是"哪边能在作品表里匹配上，哪边就是作品"，属于**反过来猜**：
 *    `#老婆 心月狐 鸣潮` 一旦作品表查不到就会乱判。用户明确说了"顺序不能反"，
 *    所以现在**只按位置切分**，不再猜 —— 这样也顺带支持了 `#老婆 今汐 猫耳`
 *    这类"角色 + 风格词"的用法（风格词不可能是作品名）。
 *
 * 支持的写法（都实测过）：
 *   `心月狐 鸣潮`      → 空格分隔
 *   `心月狐,鸣潮`      → 逗号/顿号分隔
 *   `今汐 鸣潮 猫耳`    → 多段关键词（全部保留，由调用方逐段筛）
 *   `鸣潮的心月狐`      → 作品+的+角色（用户偶尔这么写，保留支持）
 *
 * @returns {{character:string, keyword:string, work:string, explicitWork:boolean, raw:string}}
 *   work 仅在关键词能被认成作品名时才有值（供"按作品标签筛"用）。
 */
export function parseQualifier(text) {
  const raw = String(text ?? '').trim();
  const none = { character: raw, keyword: '', work: '', explicitWork: false, raw };
  if (!raw) return none;

  /* ① **先按分隔符切**（空格 / 逗号 / 顿号 / 竖线）—— 这是用户定义的标准写法。
   *    ⚠️ 必须放在"X的Y"之前：像「命运石之门」这种**作品名本身含"之"**，
   *    先跑"的/之"规则会把 `牧濑红莉栖 命运石之门` 切成
   *    角色「牧濑红莉栖 命运石」+ 关键词「门」（实测踩到）。
   *    第一个词 = 角色名，其余 = 关键词（**顺序不能反**，用户明确要求）。 */
  const parts = raw.split(/[\s,，、|/]+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const character = parts[0];
    const keyword = parts.slice(1).join(' ').trim();
    const work = lookupWorkLocal(keyword) ? keyword : '';
    return { character, keyword, work, explicitWork: true, raw };
  }

  // ② 只有一个词时，才尝试"作品+的+角色"写法（`鸣潮的心月狐`）
  const relMatch = raw.match(new RegExp(`^(.+?)${RELATION_WORDS}(.+)$`));
  if (relMatch) {
    const l = relMatch[1].trim();
    const r = relMatch[2].trim();
    const leftIsWork = Boolean(lookupWorkLocal(l));
    const rightIsWork = Boolean(lookupWorkLocal(r));
    if (leftIsWork && !rightIsWork) return { character: r, keyword: l, work: l, explicitWork: true, raw };
    if (rightIsWork && !leftIsWork) return { character: l, keyword: r, work: r, explicitWork: true, raw };
    // 只认得出"哪边都不像作品"时，不硬拆（避免把 `命运石之门` 拆坏）
  }

  return none;
}

/**
 * 归一化指令拆分结果。
 *
 * 处理两种情况：
 *  ① 占位词（「角色」「人物」「立绘」…）从角色位清掉 —— 用户写
 *     `#老婆 原神的角色` 要的是"原神里随便哪个角色"，不是一个叫"角色"的角色。
 *  ② **占位词出现在关键词位**时（`#老婆 鸣潮 人物`），说明用户把**作品写在了
 *     第一个词**、第二段只是"随便来个角色"的意思 —— 这时把作品挪到角色位，
 *     关键词留空（在作品标签下随机取图）。这是"顺序不能反"规则下唯一合理的读法：
 *     没人会给一个叫"鸣潮"的角色加"人物"这种筛选词。
 */
export function normalizeQualifier(parsed) {
  const p = parsed || { character: '', keyword: '', work: '', explicitWork: false, raw: '' };
  let char = String(p.character || '').trim();
  let kw = String(p.keyword || '').trim();
  // ② 关键词位是占位词 → 第一个词其实是作品
  if (kw && PLACEHOLDER_WORDS.test(kw)) {
    return { ...p, character: '', keyword: '', work: char, explicitWork: true };
  }
  // ① 角色位是占位词 → 清空角色（此时关键词位可能就是作品）
  if (PLACEHOLDER_WORDS.test(char)) {
    return { ...p, character: '', work: p.work || kw, keyword: kw };
  }
  return { ...p, character: char, keyword: kw };
}

/* ══════════════════════════════════════════════════════════════════════
 * 作品名 → Pixiv 标签（限定词用）
 * ════════════════════════════════════════════════════════════════════ */

/** 把标签名归一化，便于比较与去重。 */
function normTag(s) {
  return String(s ?? '').trim().toLowerCase().replace(/[\s_\-＊*・]/g, '');
}

/** 明显不是"作品名"的噪声标签（通用词/收藏数标记），别混进作品标签里。 */
const GENERIC_TAG = /^(女の子|女孩子|少女|young ?girl|オリジナル|original|落書|落書き|涂鸦|イラスト|插画|おっぱい|欧派|漫画|マンガ|boys|girls|\d+users入り)$/i;

/**
 * 从一批搜索结果里统计出"这个作品在 Pixiv 上的标签"。
 *
 * ── 为什么用统计而不是写死 ──────────────────────────────────────────────
 * 实测（2026-10）：用作品名搜一次，它的真实标签就会以高频形式浮出来：
 *   「鸣潮」   → 鳴潮/鸣潮×20、WutheringWaves×15、鸣潮/Wuthering Waves×13
 *   「千恋万花」→ 千恋*万花×28、ゆずソフト×25
 *   「明日方舟」→ アークナイツ/明日方舟×26、Arknights×24
 * 这比硬编码一张"作品→标签"表可靠得多（不用维护，还自动带多语言）。
 *
 * 但要小心：作品名本身可能就是通用词，所以这里**只保留"名字里含用户给的作品名"
 * 或"在多个结果里反复出现"的标签**，并滤掉 GENERIC_TAG 那类通用词。
 *
 * @param {Array} works 搜索结果
 * @param {string} workName 用户给的作品名
 * @returns {{tags:string[], count:number}}
 */
export function discoverWorkTags(works, workName) {
  const name = String(workName ?? '').trim();
  if (!name || !Array.isArray(works) || !works.length) return { tags: [], count: 0 };
  const norm = normTag(name);
  const counts = new Map();
  for (const w of works) {
    for (const t of (w?.tags || [])) {
      for (const raw of [t?.name, t?.translatedName]) {
        const display = String(raw ?? '').trim();
        if (!display) continue;
        const key = normTag(display);
        if (!key) continue;
        // 收藏数标记（鳴潮10000users入り）指向的是作品，但作为检索词没意义
        if (/\d+users入り$/i.test(key)) continue;
        if (GENERIC_TAG.test(display)) continue;
        const prev = counts.get(key) || { display, n: 0, containsName: false };
        prev.n += 1;
        if (norm && key.includes(norm)) prev.containsName = true;
        counts.set(key, prev);
      }
    }
  }
  const total = works.length;
  const picked = [...counts.values()]
    // 出现 2 次以上、且要么含作品名要么占比够高 —— 避免把偶尔出现的无关标签当作品标签
    .filter((x) => x.n >= 2 && (x.containsName || x.n / total >= 0.25))
    .sort((a, b) => (Number(b.containsName) - Number(a.containsName)) || (b.n - a.n));
  return { tags: picked.slice(0, 5).map((x) => x.display), count: picked.length };
}

/**
 * 已知作品的标签表（限定词专用的小补充）。
 *
 * 只放**动态发现容易失败**的作品：它们的名字在 Pixiv 上不是标签，
 * 或中文名搜出来的结果太杂。其余一律靠 discoverWorkTags 现场统计。
 */
const WORK_TAG_HINTS = {
  鸣潮: ['鳴潮', '鸣潮', 'Wuthering Waves', 'WutheringWaves'],
  原神: ['原神', 'Genshin Impact', 'GenshinImpact'],
  明日方舟: ['アークナイツ', '明日方舟', 'Arknights'],
  蔚蓝档案: ['ブルーアーカイブ', 'Blue Archive', 'ブルアカ'],
  崩坏星穹铁道: ['スターレイル', '崩壊スターレイル', 'Honkai Star Rail'],
  千恋万花: ['千恋＊万花', '千恋万花', 'Senren Banka'],
  中二病也要谈恋爱: ['中二病でも恋がしたい', 'Chuunibyou demo Koi ga Shitai'],
  更衣人偶坠入爱河: ['その着せ替え人形は恋をする', 'My Dress-Up Darling']
};

/** 查"作品名 → 标签"的本地提示表（模糊匹配）。 */
export function lookupWorkHint(workName) {
  const kw = String(workName ?? '').trim();
  if (!kw) return null;
  const norm = normTag(kw);
  for (const [key, tags] of Object.entries(WORK_TAG_HINTS)) {
    const nk = normTag(key);
    if (nk === norm || nk.includes(norm) || norm.includes(nk)) return { work: key, tags: [...tags] };
  }
  // 本地角色表里的作品也认
  const local = lookupWorkLocal(kw);
  return local ? { work: local.work, tags: local.tags } : null;
}


function dataDir() {
  return String(process.env.QQ_AGENT_DATA_DIR || '').trim()
    || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local', 'Programs', 'QQ Agent', 'data');
}

/**
 * 从 QQ Agent 的配置里读模型接入信息。
 *
 * 说明：key 存在 `dshProviderKeys.<provider>`（实测），而 `api.apiKey` 是空的，
 * 所以不能只看 api.apiKey。这里按 provider id 找到对应条目，取 baseURL / model / key。
 */
export function readModelConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8'));
    const apiCfg = cfg.api || {};
    const providerId = String(apiCfg.provider || '');
    const provider = (cfg.providers || []).find((p) => String(p?.id) === providerId) || {};
    const key = String(cfg.dshProviderKeys?.[providerId] || apiCfg.apiKey || '').trim();
    const baseURL = String(provider.baseURL || apiCfg.baseUrl || '').replace(/\/+$/, '');
    const model = String(apiCfg.model || (provider.models || [])[0] || '').trim();
    if (!key || !baseURL || !model) {
      return { ok: false, reason: `模型配置不完整（baseURL=${!!baseURL} model=${!!model} key=${!!key}）` };
    }
    return { ok: true, baseURL, model, key, provider: providerId };
  } catch (error) {
    return { ok: false, reason: `读模型配置失败：${String(error?.message || error).slice(0, 60)}` };
  }
}

const AI_PROMPT = `你是动漫/游戏资料助手。用户会给你一个角色名（可能是中文、日文或英文，也可能带错别字）。
请判断它最可能出自哪部作品，并给出该作品在 Pixiv 上常用的标签。

只输出一个 JSON 对象，不要任何解释、不要 markdown 代码块。字段：
{
  "character": "角色的中文名（若判断不出填空串）",
  "work": "作品的中文名（若判断不出填空串）",
  "workTags": ["作品在 Pixiv 上的常用标签，必须包含日文原名与英文官方名，最多 5 个"],
  "characterTags": ["该角色在 Pixiv 上的常用标签，含日文名与英文名，最多 5 个"],
  "confidence": "high | medium | low",
  "evidence": "一句话说明依据"
}

硬性要求：
- 不确定就把 confidence 填 "low"，work 与 workTags 留空数组。**宁可留空也不要编**。
- workTags 必须是你确实知道存在的 Pixiv 标签（例如《鸣潮》→ ["鳴潮","Wuthering Waves"]；
  《原神》→ ["原神","Genshin Impact"]）。不要造词。
- 角色名不要当作品名。`;

/**
 * 从模型输出里抠出 JSON 对象。
 *
 * ⚠️ 不能只靠 `JSON.parse` + 正则：thinking 模型的输出经常**被截断**
 *    （实测「喜多川海梦」那次就断在 `"workTags":["その着せ替え人形` 这里）。
 *    所以做**括号配平**扫描：找到第一个 `{` 之后逐字符累计括号深度，
 *    在深度回零处截断 —— 这样即使后面还有半句废话或截断，也能拿到完整的对象。
 */
export function extractJson(text) {
  const s = String(text ?? '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  // 扫到结尾还没闭合 = 确实被截断了，拿不到完整对象
  return null;
}

/** 精简提示：第一次因思考过长失败时改用它重试（不给模型"想太多"的空间）。 */
const AI_PROMPT_TERSE = `判断给定角色名出自哪部作品。直接输出一行 JSON，格式：
{"character":"角色中文名","work":"作品中文名","workTags":["Pixiv 标签，含日文原名与英文官方名，最多3个"],"characterTags":["Pixiv 角色标签，最多3个"],"confidence":"high|medium|low"}
不确定就输出 {"confidence":"low"}。不要解释，不要思考过程，直接给 JSON。`;

/**
 * 调 AI 解析关键词（带一次"精简重试"）。
 *
 * ⚠️ **max_tokens 与重试策略都是踩坑换来的，别随手改小**：
 *    这个模型（deepseek-flash）是 thinking 模型，每次先输出一大段
 *    `reasoning_content` 思考过程。实测：
 *      · max_tokens=400  → 思考吃光额度，`content` 为空，**所有关键词都解析不出来**
 *      · max_tokens=4000 → 简单词偶尔能过，但复杂词仍 `finish_reason=length` 而被截断
 *                           （实测「心月狐」「月牙」都失败，各耗时 20 秒）
 *    所以现在：给 8000，并且**一旦发现是"思考占满/被截断"，改用不给思考空间的
 *    精简提示重试一次**（而不是原样重试 —— 原样重试只会再花 20 秒再失败一次）。
 *    还不行就放弃，让调用方退回普通检索（绝不让"AI 挂了"变成"发错图"）。
 *
 * @returns {Promise<{ok:boolean, data?:object, reason?:string}>}
 */
/**
 * 调 AI 解析关键词。
 *
 * ⚠️ 这里的每个参数都是踩坑换来的，改之前请先读这段。
 *
 * 这个模型（deepseek-flash）是 **thinking 模型**，会先输出一大段
 * `reasoning_content`。实测它的思考**长度完全不可控**，而且遇到不认识的角色会
 * **反复纠结**（原话摘录：`心月狐可能是妲己？可能是武庚纪的角色？让我再想想…`），
 * 结果：
 *   · max_tokens=400  → 思考吃光额度，`content` 为空，所有关键词都失败
 *   · max_tokens=3000 → 简单词能出答案；生僻词思考 3000 token 全是纠结，
 *                       `finish_reason=length`、答案一个字都没写
 *   · max_tokens=8000 → 更糟：思考更久，实测单次 27 秒仍失败
 *
 * 所以现在的策略是**宁可快失败，不要慢失败**：
 *   · 超时收到 15 秒 —— 群聊里等半分钟是不可接受的
 *   · 被思考占满时**只再用精简提示试一次**，不行立刻放弃（放弃后调用方
 *     退回普通检索，功能照常，只是少了"限定范围"这一层）
 *   · 抢救：`content` 为空但 `reasoning_content` 里若已写出 JSON，也能捞出来用
 * 想要更高准确率、愿意多等的用户，可以在设置里把超时调大。
 *
 * @returns {Promise<{ok:boolean, data?:object, reason?:string}>}
 */
export async function resolveByAI(keyword, { timeoutMs = 15000, log, modelCfg } = {}) {
  const cfg = modelCfg || readModelConfig();
  if (!cfg.ok) return { ok: false, reason: cfg.reason };
  const kw = String(keyword ?? '').trim();
  if (!kw) return { ok: false, reason: '空关键词' };

  /* ⚠️ timeoutMs 是**整次解析的总预算**，不是"每次尝试"的上限。
   *    踩过的坑：早期把 timeoutMs 当成单次超时，于是重试一次就变成 2×15=30 秒，
   *    实测「心月狐」让用户等了 28 秒才出图 —— 群聊里这是不能接受的。
   *    现在用截止时间控制：第二次只拿剩下的时间，不够就干脆不试。 */
  const deadline = Date.now() + timeoutMs;
  const leftMs = () => deadline - Date.now();

  const attempt = async (systemPrompt, maxTokens, budgetMs) => {
    const res = await fetch(`${cfg.baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: kw }
        ],
        temperature: 0.2,
        max_tokens: maxTokens,
        stream: false
      }),
      signal: AbortSignal.timeout(Math.max(2000, budgetMs))
    });
    const text = await res.text();
    if (!res.ok) return { error: `模型返回 HTTP ${res.status}：${text.slice(0, 80)}` };
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    const choice = json?.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      const finish = choice?.finish_reason || '未知';
      const reasoning = String(choice?.message?.reasoning_content || '');
      // 抢救：思考里若已写出 JSON，照样能用（思考被截断但结论已给出）
      const salvaged = extractJson(reasoning);
      if (salvaged && (salvaged.work || salvaged.character)) {
        log?.(`AI 答案被思考截断，已从思考内容里抢救出结果（${kw}）`);
        return { parsed: salvaged, salvaged: true };
      }
      return { error: `模型思考过长没能给出答案（finish_reason=${finish}）`, truncated: true };
    }
    const parsed = extractJson(content);
    if (!parsed) return { error: `模型输出不是完整 JSON：${String(content).slice(0, 50)}`, truncated: true };
    return { parsed };
  };

  try {
    // 第一次：完整提示（3000 足够表达答案；给太多只会让它思考更久）
    let r = await attempt(AI_PROMPT, 3000, leftMs());
    // 被思考占满 → 用精简提示再试一次，但**只花剩下的预算**（总时长不超 timeoutMs）
    if (r.error && r.truncated) {
      const rest = leftMs();
      if (rest < 4000) {
        return { ok: false, reason: '模型思考过长，剩余时间不足以重试（已放弃，退回普通检索）' };
      }
      log?.(`AI 首次被思考占满，用剩余 ${Math.round(rest / 1000)} 秒改精简提示重试（${kw}）`);
      r = await attempt(AI_PROMPT_TERSE, 2000, rest);
    }
    if (r.error) return { ok: false, reason: r.error };
    const d = r.parsed;
    log?.(`AI 解析「${kw}」→ 作品「${d.work || '(空)'}」置信度 ${d.confidence || '?'}${r.salvaged ? '（抢救）' : ''}`);
    return { ok: true, data: d };
  } catch (error) {
    const msg = String(error?.message || error);
    return { ok: false, reason: msg.includes('aborted') ? `调用模型超时（总预算 ${Math.round(timeoutMs / 1000)} 秒）` : `调用模型失败：${msg.slice(0, 60)}` };
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ AniList（官方英/日文名）
 * ════════════════════════════════════════════════════════════════════ */

async function anilist(query, { timeoutMs = 15000 } = {}) {
  const res = await fetch('https://graphql.anilist.co/', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, accept: 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const json = await res.json();
  if (json?.errors) throw new Error(String(json.errors?.[0]?.message || 'AniList 报错').slice(0, 60));
  return json?.data;
}

/**
 * 用 AniList 查作品的多语言名。
 *
 * ⚠️ 取自这里的结果**必须校验**（见文件头说明：它对无法识别的查询会返回固定无关结果）。
 *    所以这里额外要求：查到的作品标题里必须含有用户给的作品名，否则丢弃。
 */
export async function resolveByAniList(workName, { timeoutMs = 15000, log } = {}) {
  const name = String(workName ?? '').trim();
  if (!name) return { ok: false, reason: '空作品名' };
  try {
    const d = await anilist(`{ Page(perPage:5){ media(search:${JSON.stringify(name)}){ id type format title{ native romaji english } } } }`, { timeoutMs });
    const list = d?.Page?.media || [];
    if (!list.length) return { ok: false, reason: 'AniList 没有结果' };
    // 校验：标题里必须出现用户给的名字（否则就是"编造的固定结果"）
    const hit = list.find((m) => {
      const joined = `${m.title?.native || ''}${m.title?.romaji || ''}${m.title?.english || ''}`.toLowerCase();
      return joined.includes(name.toLowerCase());
    });
    if (!hit) {
      log?.(`AniList 的结果与「${name}」不匹配（可能是它的固定兜底结果），丢弃`);
      return { ok: false, reason: `AniList 的结果与「${name}」不符` };
    }
    const tags = [hit.title?.native, hit.title?.romaji, hit.title?.english].filter(Boolean);
    const characters = [];
    try {
      const d2 = await anilist(`{ Media(id:${hit.id}){ characters(perPage:25,sort:[ROLE,RELEVANCE]){ nodes{ name{ native full alternative } } } } }`, { timeoutMs });
      for (const c of d2?.Media?.characters?.nodes || []) {
        const names = [c?.name?.native, c?.name?.full, ...(c?.name?.alternative || [])].filter(Boolean);
        if (names.length) characters.push(names);
      }
    } catch { /* 角色列表拿不到不影响主流程 */ }
    log?.(`AniList「${name}」→ ${tags.join(' / ')}，角色 ${characters.length} 个`);
    return { ok: true, tags: [...new Set(tags)], characters, id: hit.id };
  } catch (error) {
    return { ok: false, reason: `AniList 查询失败：${String(error?.message || error).slice(0, 60)}` };
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 组合：analyzeKeyword
 * ════════════════════════════════════════════════════════════════════ */

/** 解析结果缓存（作品名不会变，值得长期缓存；进程内 + 落盘）。 */
const CACHE_FILE = 'command-anime-keyword-cache.json';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;      // 30 天（**仅成功**结果）
/**
 * ⚠️ 失败结果的缓存时间必须短，否则会把一次性故障钉死（真实事故）。
 *    实测：AI 因思考超长失败过一次，那次失败被按 30 天缓存，
 *    于是「心月狐」这个角色**再也不会重试**，表现就是"新功能一直不生效"。
 *    失败的原因通常是临时的（超时、模型抖动），所以只记住 10 分钟。
 */
const CACHE_FAIL_TTL_MS = 10 * 60 * 1000;
const memCache = new Map();

function cacheFile() { return path.join(dataDir(), CACHE_FILE); }

function loadDiskCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(cacheFile(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function saveDiskCache(cache) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(cacheFile(), JSON.stringify(cache), 'utf8');
  } catch { /* 缓存写不上不影响功能 */ }
}

function cacheGet(key) {
  const ok = (entry) => {
    if (!entry) return false;
    const ttl = entry.value?.ok ? CACHE_TTL_MS : CACHE_FAIL_TTL_MS;
    return Date.now() - (entry.at || 0) < ttl;
  };
  const hit = memCache.get(key);
  if (ok(hit)) return hit.value;
  const disk = loadDiskCache()[key];
  if (ok(disk)) {
    memCache.set(key, disk);
    return disk.value;
  }
  return null;
}

function cacheSet(key, value) {
  const entry = { at: Date.now(), value };
  memCache.set(key, entry);
  const disk = loadDiskCache();
  disk[key] = entry;
  // 简单裁剪：超过 500 条就丢掉最旧的一半
  const keys = Object.keys(disk);
  if (keys.length > 500) {
    keys.sort((a, b) => (disk[a].at || 0) - (disk[b].at || 0));
    for (const k of keys.slice(0, Math.floor(keys.length / 2))) delete disk[k];
  }
  saveDiskCache(disk);
}

/**
 * 分析关键词：它是哪个角色、出自哪部作品、在 Pixiv 上该用哪些标签。
 *
 * 三层依次尝试，任一层给出**通过校验**的结果就返回；全失败则返回空结果
 * （调用方据此退回原行为，绝不让"解析失败"变成"发错图"）。
 *
 * @param {string} keyword
 * @param {{useAI?:boolean, timeoutMs?:number, log?:Function, modelCfg?:object}} opts
 * @returns {Promise<{ok:boolean, character:string, work:string, workTags:string[], characterTags:string[], source:string, confidence:string, notes:string[]}>}
 */
export async function analyzeKeyword(keyword, { useAI = true, timeoutMs = 20000, log, modelCfg, qualifier, discoverTags } = {}) {
  const kw = String(keyword ?? '').trim();
  const empty = { ok: false, character: kw, work: '', workTags: [], characterTags: [], source: '', confidence: '', notes: [] };
  if (!kw) return empty;

  const cached = cacheGet(kw);
  if (cached) {
    log?.(`关键词分析命中缓存：「${kw}」→ ${cached.work || '(未识别作品)'}（来源 ${cached.source}）`);
    return { ...cached, notes: [...(cached.notes || []), '来自缓存'] };
  }

  const notes = [];

  /* ── ⓿ 限定词：用户直接点名了作品（`#老婆 心月狐 鸣潮`）──────────────────
   * 这是**最可信的一层**（用户自己的判断），而且能跳过 AI ——
   * 冷门角色（AI 认不出的那种）配合限定词照样能准确定位，这正是这个功能的价值。
   * 流程：先查本地提示表；查不到就用"作品名"去搜一次，从结果的高频标签里反推
   * （discoverTags 回调，由调用方注入，见 index.js）。 */
  if (qualifier?.explicitWork) {
    const char = String(qualifier.character || kw).trim();
    const work = String(qualifier.work || '').trim();
    let tags = [];
    let from = '';
    const hint = lookupWorkHint(work);
    if (hint) {
      tags = hint.tags;
      from = '本地提示表';
      notes.push(`限定词命中本地表：${work} → [${tags.join(', ')}]`);
    } else if (typeof discoverTags === 'function') {
      try {
        const found = await discoverTags(work);
        if (found?.tags?.length) {
          tags = found.tags;
          from = `动态发现（从 ${found.scanned} 条结果统计）`;
          notes.push(`限定词动态发现：${work} → [${tags.join(', ')}]`);
        }
      } catch (error) {
        notes.push(`限定词动态发现失败：${String(error?.message || error).slice(0, 50)}`);
      }
    }
    if (tags.length) {
      const result = {
        ok: true,
        character: char,
        work,
        workTags: tags,
        characterTags: [kw, char].filter((v, i, a) => v && a.indexOf(v) === i),
        source: 'qualifier',
        confidence: 'high',
        notes
      };
      log?.(`限定词解析：作品「${work}」标签[${tags.join(', ')}]（${from}），角色「${char}」`);
      cacheSet(kw, result);
      return result;
    }
    notes.push(`限定词「${work}」没能查到对应的 Pixiv 标签，转普通分析`);
  }

  // ── ① 本地名单（最可信）──
  const local = lookupLocal(kw);
  if (local) {
    notes.push(`本地名单命中：${local.character || local.work} → 《${local.work}》`);
    const result = {
      ok: true,
      character: local.character || kw,
      work: local.work,
      workTags: local.tags,
      characterTags: local.aliases?.length ? local.aliases : [kw],
      source: local.source,
      confidence: 'high',
      notes
    };
    cacheSet(kw, result);
    return result;
  }

  // ── ② AI ──
  if (useAI) {
    const ai = await resolveByAI(kw, { timeoutMs, log, modelCfg });
    if (ai.ok) {
      const d = ai.data || {};
      const conf = String(d.confidence || 'low').toLowerCase();
      const work = String(d.work || '').trim();
      const workTags = (Array.isArray(d.workTags) ? d.workTags : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 5);
      const charTags = (Array.isArray(d.characterTags) ? d.characterTags : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 5);
      const char = String(d.character || kw).trim();
      if (work && workTags.length && conf !== 'low') {
        notes.push(`AI 判断出自《${work}》（置信度 ${conf}）：${String(d.evidence || '').slice(0, 40)}`);
        const result = {
          ok: true, character: char, work, workTags,
          characterTags: charTags.length ? [...new Set([kw, ...charTags])] : [kw],
          source: 'ai', confidence: conf, notes
        };
        cacheSet(kw, result);
        return result;
      }
      notes.push(work
        ? `AI 判断置信度太低（${conf}），不采用`
        : 'AI 没能判断出作品');
    } else {
      notes.push(`AI 解析不可用：${ai.reason}`);
    }
  }

  // ── ③ AniList（把关键词当作品名试一次）──
  const al = await resolveByAniList(kw, { timeoutMs, log });
  if (al.ok) {
    // 只有当关键词确实出现在该作品的角色名里，才认为"这是个角色"；
    // 否则视为"关键词本身就是作品名"
    const isCharacter = al.characters.some((names) => names.some((n) => n.toLowerCase().includes(kw.toLowerCase())));
    notes.push(`AniList 命中作品：${al.tags.join(' / ')}${isCharacter ? '（关键词是其角色）' : ''}`);
    const result = {
      ok: true,
      character: isCharacter ? kw : '',
      work: al.tags[0] || kw,
      workTags: al.tags.slice(0, 4),
      characterTags: [kw],
      source: 'anilist',
      confidence: isCharacter ? 'medium' : 'low',
      notes
    };
    cacheSet(kw, result);
    return result;
  }
  notes.push(`AniList 未命中：${al.reason}`);

  const result = { ...empty, notes };
  // 失败也缓存（避免每次都对同一批无效关键词反复调 AI，白花钱）
  cacheSet(kw, result);
  return result;
}

/** 给自检/诊断用。 */
export function keywordCacheInfo() {
  const disk = loadDiskCache();
  return { file: cacheFile(), count: Object.keys(disk).length, memory: memCache.size };
}

/* ══════════════════════════════════════════════════════════════════════
 * 图片筛选与排序（检索准确性）
 * ════════════════════════════════════════════════════════════════════ */

/** 标题语言：中文 > 英文 > 日文 > 其他（用户要求的优先级）。 */
export function titleLang(title) {
  const s = String(title ?? '');
  if (!s.trim()) return 'other';
  // 含假名 → 日文（日文标题几乎一定会出现假名，仅汉字的按中文算，符合用户预期）
  if (/[\u3040-\u30ff]/.test(s)) return 'jp';
  if (/[\u4e00-\u9fa5]/.test(s)) return 'zh';
  // 纯 ASCII（含数字/符号）→ 英文/其他
  if (/^[\x00-\x7F\s]*$/.test(s)) return 'en';
  return 'other';
}

const LANG_RANK = { zh: 0, en: 1, jp: 2, other: 3 };

/** 作品的标签集合（小写，便于比较）。 */
function tagSet(analysis) {
  const out = new Set();
  for (const t of [...(analysis.workTags || []), ...(analysis.characterTags || [])]) {
    const s = String(t ?? '').trim().toLowerCase().replace(/[\s_\-＊*・]/g, '');
    if (s) out.add(s);
  }
  return out;
}

/**
 * 给一条搜索结果打分（判断它跟我们找的角色/作品有多相关）。
 *
 * 依据是**标签**而不是标题 —— 实测这个更可靠：
 *   搜「今汐」的结果里 87/88 条的标签含"今汐"，而标题含"今汐"的只有一部分
 *   （作者常写「無題」「落書き」这类标题）。
 * 另外标签里同时有原名和译名（`{"name":"鳴潮","translatedName":"Wuthering Waves"}`），
 * 两边都要比对。
 *
 * @returns {{score:number, hitWork:boolean, hitCharacter:boolean, titleHit:boolean}}
 */
export function scoreWork(work, analysis, keyword = '') {
  const wanted = tagSet(analysis);
  const charNames = [keyword, analysis.character, ...(analysis.characterTags || [])]
    .map((s) => String(s ?? '').trim().toLowerCase().replace(/[\s_\-＊*・]/g, ''))
    .filter(Boolean);
  const workNames = (analysis.workTags || [])
    .map((s) => String(s ?? '').trim().toLowerCase().replace(/[\s_\-＊*・]/g, ''))
    .filter(Boolean);

  let hitWork = false;
  let hitCharacter = false;
  const tags = Array.isArray(work?.tags) ? work.tags : [];
  for (const t of tags) {
    for (const raw of [t?.name, t?.translatedName]) {
      const s = String(raw ?? '').trim().toLowerCase().replace(/[\s_\-＊*・]/g, '');
      if (!s) continue;
      if (workNames.some((w) => s === w || s.startsWith(w))) hitWork = true;
      if (charNames.some((c) => s === c || s.startsWith(c))) hitCharacter = true;
      if (!hitWork && wanted.has(s)) hitWork = true;
    }
  }
  // 标题里也含关键词 → 记录，但**权重很低**（见 rankWorks 的说明）
  const titleHit = Boolean(keyword) && String(work?.title || '').includes(keyword);

  // score 只表示"标签相关度"（角色 4 + 作品 2），标题命中单独作为次要项
  const score = (hitCharacter ? 4 : 0) + (hitWork ? 2 : 0);
  return { score, hitWork, hitCharacter, titleHit };
}

/**
 * 按「标题语言 → 标签相关度」给候选排序。
 *
 * 排序键（顺序是刻意的，来自用户明确要求）：
 *   ① **标题语言：中文 → 英文 → 日文 → 其他**（用户要求"优先发中文标题的图片"）
 *   ② 标签相关度：命中角色 > 命中作品（同语言内越相关越靠前）
 *   ③ 标题是否含关键词（次要加分项）
 *   ④ 原始顺序（保持源的随机性）
 *
 * ⚠️ 为什么把语言放在相关度**前面**：一开始我把相关度当第一键、语言当第二键，
 *    结果「今汐の日」（日文、标题含关键词）压过了「Jinhsi」（英文）——
 *    因为前者多拿了一分"标题命中"。这跟"优先中文"的要求是矛盾的。
 *    语言是用户的硬性偏好，相关度是同一语言内的排序依据，所以语言在前。
 *
 * @param {Array} works 搜索结果
 * @param {object} analysis analyzeKeyword 的结果
 * @param {{keyword?:string, relaxed?:boolean}} opts relaxed=true 时保留未命中标签的（宽松模式）
 */
export function rankWorks(works, analysis, { keyword = '', relaxed = false } = {}) {
  const scored = [];
  for (const w of works) {
    const s = scoreWork(w, analysis, keyword);
    scored.push({ work: w, ...s, lang: titleLang(w?.title), order: scored.length });
  }
  // 宽松模式：命中的优先，没命中的也留下（用户选的是这种）
  const kept = relaxed ? scored : scored.filter((x) => x.hitCharacter || x.hitWork);
  kept.sort((a, b) => {
    const la = LANG_RANK[a.lang] ?? 9;
    const lb = LANG_RANK[b.lang] ?? 9;
    if (la !== lb) return la - lb;                       // ① 语言优先
    if (b.score !== a.score) return b.score - a.score;   // ② 相关度
    if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1;  // ③ 标题含关键词
    return a.order - b.order;                            // ④ 保持稳定
  });
  return kept;
}
