// CS2赛事查询技能（LLM 型）—— 查最近赛程、近期赛果（大比分 + 地图小分）。
//
// 为什么是 skill 而不是 plugin：什么时候该查、查哪几天的比赛，只能由模型理解
// 用户的话来判断，没有"满足条件必然执行"的时机，故走 registerTool + prompt 引导。
// 零第三方依赖：原生 fetch + 正则解析。
//
// 数据来源（按优先级）：
//   主源   dust2.us  —— 赛程 /matches、赛果 /results（可抓、无反爬，但亚洲低级别赛事收录不全/滞后）
//   备用源 csapi.de   —— 免费 JSON API，主源挂掉时兜底
//   补查源 GGScore    —— 公开网页，无需 key。当用户【明确点名某战队】查赛果时，
//                        用 GGScore 队伍页精确核对最新成绩（它收录更全更实时，如 LVG 9/29 决赛）。
//
// 功能：
//   · 战队筛选：不填就全报；填了（如 猎鹰、绿龙、FaZe）就只报这些战队相关的赛程/赛果。
//   · 一线赛事开关：只看一线（EPL/Major/BLAST/IEM/PGL）可开关，默认开；关掉则报全部。
//   · 战队赛果：默认近两天，报大比分 + 每张地图小比分；有战队筛选时一线开关自动失效（非一线也报）。
//   · 新鲜度提示：点名战队时若该源最新比赛距今天超过 2 天，会明确提示可能漏了更新的比赛。

let cfg = () => ({});
let httpFetch = null;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 常见战队中英文对照（用于中文筛选词 → 匹配英文队名）
const TEAM_ALIASES = {
  '猎鹰': 'falcons', 'falcons': 'falcons', '猎鹰队': 'falcons',
  '绿龙': 'spirit', 'spirit': 'spirit', 'team spirit': 'spirit', '绿龙队': 'spirit',
  '天生赢家': 'natus vincere', 'navi': 'natus vincere', 'natus vincere': 'natus vincere', 'natus-vincere': 'natus vincere',
  '小蜜蜂': 'vitality', 'vitality': 'vitality', '蜜蜂': 'vitality',
  '老鼠': 'mouz', 'mouz': 'mouz', '大老鼠': 'mouz',
  '液体': 'liquid', 'liquid': 'liquid', 'team liquid': 'liquid',
  '黑豹': 'furia', 'furia': 'furia', '黑豹队': 'furia',
  '法泽': 'faze', 'faze': 'faze', 'faze clan': 'faze',
  '银河战舰': 'g2', 'g2': 'g2', 'g2 esports': 'g2',
  'the mongolz': 'mongolz', 'mongolz': 'mongolz', '蒙古': 'mongolz',
  '天禄': 'tyloo', 'tyloo': 'tyloo', 'tyloo队': 'tyloo',
  '永恒之火': 'eternal fire', 'eternal fire': 'eternal fire',
  'cloud9': 'cloud9', 'c9': 'cloud9', '云九': 'cloud9',
  'heroic': 'heroic', 'heroic队': 'heroic',
  'astro': 'astralis', 'astralis': 'astralis', '星队': 'astralis',
  'vp': 'virtus.pro', 'virtus.pro': 'virtus.pro', 'virtus pro': 'virtus.pro',
  'big': 'big', 'big队': 'big',
  'fnatic': 'fnatic', 'fnatic队': 'fnatic',
  'm80': 'm80', 'm80队': 'm80',
  '9z': '9z', '9z队': '9z',
  'aurora': 'aurora', '极光': 'aurora',
  'betboom': 'betboom', 'betboom队': 'betboom',
  '1win': '1win', '1win队': '1win',
  'shinden': 'shinden', 'shinden队': 'shinden',
  'legacy': 'legacy', 'legacy队': 'legacy',
  'parivision': 'parivision', 'parivision队': 'parivision',
  'k27': 'k27', 'k27队': 'k27',
  'baks': 'baks', 'baks队': 'baks',
  'sangal': 'sangal', 'sangal队': 'sangal',
  'kuusamo': 'kuusamo', 'kuusamo队': 'kuusamo',
  'lag': 'lag', 'lag队': 'lag',
  'marsborne': 'marsborne', 'marsborne队': 'marsborne',
  'iowa stormboar': 'iowa stormboar', 'stormboar': 'iowa stormboar',
  'without a roof': 'without a roof',
  'overtake sector': 'overtake sector',
  'olympus': 'olympus',
  'nemiga': 'nemiga',
  'hotu': 'hotu',
  'nemesis': 'nemesis',
  'private': 'private',
  'regain': 'regain',
  'b8': 'b8', 'b8队': 'b8',
  'luminosity': 'luminosity',
  'metanoia wolves': 'metanoia wolves',
  'mira': 'mira',
  'ex-oddik': 'ex-oddik',
  'gamerlegion': 'gamerlegion',
  'imperial': 'imperial',
  'complexity': 'complexity',
  '3dmax': '3dmax',
  'saw': 'saw',
  'paiN': 'pain', 'pain': 'pain',
  'monte': 'monte',
  'ence': 'ence',
  'apeks': 'apeks',
  'lvg': 'lynn vision', 'lynn vision': 'lynn vision', 'lynn vision gaming': 'lynn vision', 'lyg': 'lynn vision',
  'nexvoid': 'nexvoid',
  'rare atom': 'rare atom', 'ra': 'rare atom',
  'depo': 'depo',
  'the huns': 'the huns',
  '5star': '5star', 'five star': '5star',
  'kaleido': 'kaleido',
  'wings up': 'wings up', 'wings': 'wings up',
  'flyquest': 'flyquest',
  'bromo': 'bromo',
  'exodia': 'exodia',
  'yawara': 'yawara',
  'fokus': 'fokus',
  'upgrade': 'upgrade',
  'iberian soul': 'iberian soul', 'iberian soul': 'iberian soul',
  'marca registrada': 'marca registrada',
  'nutorious': 'nutorious',
  'betclic': 'betclic',
  'rare atom': 'rare atom',
  'vitalem aerem': 'vitalem aerem',
  'ur': 'ur'
};

// GGScore 常用战队队伍页 UUID（队伍页 URL 是 /team/{uuid}，无法由队名直接推导）
// 需要新增队伍时，到 ggscore.net/team 按字母找到对应队伍链接，把 uuid 加进来即可。
const GG_TEAM_UUID = {
  'lynn vision': '61cb5f65-fe2d-42ce-bdfa-bf56c5e7c682',
  'spirit': 'fa1cdc41-9ed6-4218-bd0c-a55991385434',
  'team spirit': 'fa1cdc41-9ed6-4218-bd0c-a55991385434',
  'falcons': '5c6426a8-e0a2-4b97-a36c-094192bc8035',
  'faze': '0c52b88d-09b3-4a95-9e32-b0a7891cfd10',
  'faze clan': '0c52b88d-09b3-4a95-9e32-b0a7891cfd10',
  'vitality': '1b66796b-193e-4597-8e1f-75a5a01d42d8',
  'team vitality': '1b66796b-193e-4597-8e1f-75a5a01d42d8',
  'nexvoid': '00000000-0000-0000-0000-000000000000' // 占位，若未收录则走列表页搜索
};

// 把毫秒时间戳转成用户时区的中文「M月D日 周X HH:MM」
function fmtTime(ms, tz) {
  const d = new Date(ms);
  try {
    const parts = new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, month: 'numeric', day: 'numeric',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d);
    const p = {};
    for (const x of parts) p[x.type] = x.value;
    const w = { 周一: '周一', 周二: '周二', 周三: '周三', 周四: '周四', 周五: '周五', 周六: '周六', 周日: '周日' }[p.weekday] || p.weekday;
    return `${Number(p.month)}月${Number(p.day)}日 ${w} ${p.hour}:${p.minute}`;
  } catch {
    return d.toISOString().replace('T', ' ').slice(0, 16);
  }
}

// 抓取整页文本（带 UA）
async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await httpFetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8' }
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const text = await res.text();
    return { text };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : (e?.message ?? String(e));
    return { error: `抓取失败：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

// 抓取 JSON（备用源 csapi.de 用）
async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await httpFetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept': 'application/json' }
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = await res.json();
    return { data };
  } catch (e) {
    const msg = e?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : (e?.message ?? String(e));
    return { error: `抓取失败：${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .trim();
}

// 一线赛事过滤：赛事名包含任一关键词即保留
function isTopEvent(eventName, topEvents) {
  const ev = String(eventName || '').toLowerCase();
  return topEvents.some((k) => k && ev.includes(k.toLowerCase()));
}
// 从设置读取关键词列表（逗号/顿号/空格分隔）
function readList(raw) {
  return String(raw || '')
    .split(/[,，、;；|\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
// 从设置读取战队筛选词
function readTeams(c) {
  return readList(c.filterTeams);
}
// 判断某个队名是否命中任一筛选词（队名匹配 或 别名映射匹配）
function matchTeam(teamName, filters) {
  const low = String(teamName || '').trim().toLowerCase();
  if (!low) return false;
  for (const f of filters) {
    const key = f.trim().toLowerCase();
    if (!key) continue;
    if (low.includes(key)) return true;
    const mapped = TEAM_ALIASES[key] || TEAM_ALIASES[f];
    if (mapped && low.includes(String(mapped).toLowerCase())) return true;
    for (const [alias, std] of Object.entries(TEAM_ALIASES)) {
      if (alias.toLowerCase() === key && low.includes(String(std).toLowerCase())) return true;
    }
  }
  return false;
}
function matchTeamsMatch(m, filters) {
  if (!filters.length) return true;
  return matchTeam(m.team1, filters) || matchTeam(m.team2, filters);
}

// 收集某个锚点开标签的所有出现位置
function anchors(html, pattern) {
  const out = [];
  const re = new RegExp(pattern, 'g');
  let m;
  while ((m = re.exec(html)) !== null) out.push(m.index);
  return out;
}

// 解析 /matches 页面：最近几天的赛程
function parseSchedule(html) {
  const groups = [];
  const ga = anchors(html, /<div class="matches-group-container">/g);
  for (let i = 0; i < ga.length; i++) {
    const g = html.slice(ga[i], (i + 1 < ga.length) ? ga[i + 1] : html.length);
    const day = (g.match(/data-date="(\d+)"/) || [])[1];
    const matches = [];
    const ma = anchors(g, /<div class="match text-ellipsis/g);
    for (let j = 0; j < ma.length; j++) {
      const f = g.slice(ma[j], (j + 1 < ma.length) ? ma[j + 1] : g.length);
      const et = (f.match(/data-item-entry-time="(\d+)"/) || [])[1];
      const teams = [...f.matchAll(/class="match-team-name text-ellipsis">([\s\S]*?)<\/div>/g)].map((m) => decodeEntities(m[1]));
      const ev = (f.match(/class="match-event">[\s\S]*?hidden="hidden">([\s\S]*?)<\/span>/) || [])[1];
      if (teams.length < 2) continue;
      matches.push({
        ts: et ? Number(et) : (day ? Number(day) : null),
        team1: teams[0], team2: teams[1],
        event: ev ? decodeEntities(ev) : '未知赛事'
      });
    }
    if (matches.length) groups.push({ dayTs: day ? Number(day) : null, matches });
  }
  const out = [];
  for (const g of groups) for (const m of g.matches) out.push(m);
  return out;
}

// 解析 /results 页面：按日期分组，含大比分
function parseResults(html) {
  const groups = [];
  const ga = anchors(html, /<div class="matches-group-container">/g);
  for (let i = 0; i < ga.length; i++) {
    const g = html.slice(ga[i], (i + 1 < ga.length) ? ga[i + 1] : html.length);
    const day = (g.match(/data-date="(\d+)"/) || [])[1];
    const matches = [];
    const ma = anchors(g, /<div class="match text-ellipsis/g);
    for (let j = 0; j < ma.length; j++) {
      const f = g.slice(ma[j], (j + 1 < ma.length) ? ma[j + 1] : g.length);
      const et = (f.match(/data-item-entry-time="(\d+)"/) || [])[1];
      const teams = [...f.matchAll(/class="match-team-name text-ellipsis">([\s\S]*?)<\/div>/g)].map((m) => decodeEntities(m[1]));
      const s1 = (f.match(/class="match-team match-result team-1">(\d+)<\/a>/) || [])[1];
      const s2 = (f.match(/class="match-team match-result team-2">(\d+)<\/a>/) || [])[1];
      const ev = (f.match(/class="match-event">[\s\S]*?hidden="hidden">([\s\S]*?)<\/span>/) || [])[1];
      const link = (f.match(/href="(\/matches\/\d+[^"]*)"/) || [])[1];
      if (teams.length < 2 || s1 == null) continue;
      matches.push({
        ts: et ? Number(et) : (day ? Number(day) : null),
        team1: teams[0], team2: teams[1],
        score1: Number(s1), score2: Number(s2),
        event: ev ? decodeEntities(ev) : '未知赛事',
        link: link || null
      });
    }
    if (matches.length) groups.push({ dayTs: day ? Number(day) : null, matches });
  }
  return groups;
}

// 抓 dust2.us 单场详情页，解析每张地图的小比分
async function parseMatchMaps(link, timeoutMs) {
  const got = await fetchText(`https://www.dust2.us${link}`, timeoutMs);
  if (got.error || !got.text) return null;
  const maps = [];
  const mre = /<div class="standard-box map-container[^"]*map-picked"[\s\S]*?<div class="map-container-map-name">([\s\S]*?)<\/div>[\s\S]*?<div class="map-container-score-left">(\d+)<\/div>[\s\S]*?<div class="map-container-score-right">(\d+)<\/div>/g;
  let m;
  while ((m = mre.exec(got.text)) !== null) maps.push(`${decodeEntities(m[1])} ${m[2]}:${m[3]}`);
  return maps;
}

// ── 备用源：csapi.de ────────────────────────────────────────────
async function csapiResults(c, filters, timeoutMs, days) {
  const latest = await fetchJson('https://api.csapi.de/matches/latest', timeoutMs);
  if (latest.error) return { error: `备用源不可用：${latest.error}` };
  let rows = [];
  const arr = Array.isArray(latest.data) ? latest.data : [];
  for (const m of arr) {
    const maps = Array.isArray(m?.maps) ? m.maps.map((mp) => `${mp.name} ${mp.team1_score}:${mp.team2_score}`) : [];
    const dateStr = m?.date;
    rows.push({
      ts: dateStr ? Date.parse(dateStr) : 0,
      team1: m?.team1?.name || '', team2: m?.team2?.name || '',
      score1: m?.team1?.score ?? null, score2: m?.team2?.score ?? null,
      event: m?.event || '', maps, link: null, _src: 'csapi'
    });
  }
  let matched = filters.length ? rows.filter((m) => matchTeamsMatch(m, filters)) : rows;
  if (filters.length && !matched.length) {
    const teamRows = [];
    const seenIds = new Set();
    for (const f of filters) {
      const lowF = f.trim().toLowerCase();
      if (!lowF) continue;
      const mapped = TEAM_ALIASES[lowF] || TEAM_ALIASES[f];
      const cands = [...new Set([mapped || lowF, lowF])];
      for (const cn of cands) {
        const search = await fetchJson(`https://api.csapi.de/teams/?name=${encodeURIComponent(cn)}`, timeoutMs);
        if (search.error || !Array.isArray(search.data)) continue;
        for (const t of search.data) {
          const id = t?.id; if (!id || seenIds.has(id)) continue;
          seenIds.add(id);
          const hist = await fetchJson(`https://api.csapi.de/teams/${id}/matchhistory`, timeoutMs);
          if (hist.error || !Array.isArray(hist.data)) continue;
          for (const m of hist.data) {
            const maps = Array.isArray(m?.maps) ? m.maps.map((mp) => `${mp.name} ${mp.team1_score}:${mp.team2_score}`) : [];
            const dateStr = m?.date;
            teamRows.push({
              ts: dateStr ? Date.parse(dateStr) : 0,
              team1: m?.team1?.name || '', team2: m?.team2?.name || '',
              score1: m?.team1?.score ?? null, score2: m?.team2?.score ?? null,
              event: m?.event || '', maps, link: null, _src: 'csapi'
            });
          }
        }
      }
    }
    if (teamRows.length) matched = teamRows.filter((m) => matchTeamsMatch(m, filters));
  }
  const now = new Date();
  const tzNow = new Date(now.toLocaleString('en-US', { timeZone: c?.timeZone || 'Asia/Shanghai' }));
  const startToday = Date.UTC(tzNow.getUTCFullYear(), tzNow.getUTCMonth(), tzNow.getUTCDate());
  const startFrom = startToday - days * 24 * 60 * 60 * 1000;
  const endUpTo = startToday - 1;
  let windowed = matched.filter((m) => m.ts >= startFrom && m.ts <= endUpTo);
  if (!windowed.length && matched.length) windowed = matched.slice(-10);
  let latestDate = null;
  if (matched.length) latestDate = Math.max(...matched.map((m) => m.ts));
  return { matches: windowed, latestDate, sourceNote: '备用源' };
}

// ── 补查源：GGScore（公开网页，无需 key；点名战队精确核对用）────────
// 队伍页 URL 是 /team/{uuid}。先用内置 uuid 表，找不到就在字母索引列表页里搜。
async function ggFindTeamUuid(filters, timeoutMs) {
  // 1) 优先内置表
  for (const f of filters) {
    const lowF = f.trim().toLowerCase();
    const mapped = TEAM_ALIASES[lowF] || TEAM_ALIASES[f];
    const keys = [...new Set([mapped, lowF].filter(Boolean))];
    for (const k of keys) {
      const u = GG_TEAM_UUID[k];
      if (u && !u.includes('00000000')) return { uuid: u, name: k };
    }
  }
  // 2) 内置表没有 → 在字母索引列表页搜索（队伍名排序，二分定位首字母所在页）
  //    简化：遍历所有页找匹配（最多 92 页，每页 50 队，按队伍名首字母可定位）
  for (let page = 1; page <= 92; page++) {
    const got = await fetchText(`https://ggscore.net/team?page=${page}`, timeoutMs);
    if (got.error || !got.text) continue;
    const rows = [...got.text.matchAll(/href="(\/team\/[0-9a-f-]{36})"[^>]*>\s*([^<]*?)<\/a>/g)];
    for (const r of rows) {
      const name = decodeEntities(r[2]).trim();
      if (matchTeam(name, filters)) return { uuid: r[1].split('/')[2], name };
    }
  }
  return null;
}

// 解析 GGScore 队伍页：最近比赛列表（日期、对阵、比分、事件、详情链接）
function ggParseTeam(html) {
  const out = [];
  const rows = html.split(/<tr class="border-b border-border\/60">/g).slice(1);
  for (const row of rows) {
    const dateRaw = (row.match(/<td class="whitespace-nowrap p-3 text-muted-foreground">([\s\S]*?)<\/td>/) || [])[1];
    const link = (row.match(/href="(\/match\/[0-9a-f-]{36})"/) || [])[1];
    const vs = (row.match(/<a class="font-medium[^"]*" href="[^"]*">([\s\S]*?)<\/a>/) || [])[1];
    const score = (row.match(/<td class="whitespace-nowrap p-3">(\d+)<!-- --> — <!-- -->(\d+)<\/td>/) || []);
    const ev = (row.match(/truncate p-3 text-muted-foreground">([\s\S]*?)<\/td>/) || [])[1];
    if (!dateRaw || !vs) continue;
    const clean = (s) => decodeEntities(String(s || '')).replace(/<!-- -->/g, '').replace(/\s+/g, ' ').trim();
    const dateStr = clean(dateRaw); // e.g. "Sep 29, 2026, 1:00 PM"
    // GGScore 页面时间按 UTC 显示（如 1:00 PM = UTC 13:00 = 北京时间 21:00），故按 UTC 解析
    const ts = Date.parse(`${dateStr} UTC`);
    const teams = clean(vs).split(' vs ').map((s) => s.trim());
    out.push({
      ts: isNaN(ts) ? 0 : ts,
      team1: teams[0] || '', team2: teams[1] || '',
      score1: score ? Number(score[1]) : null, score2: score ? Number(score[2]) : null,
      event: clean(ev), link: link ? `https://ggscore.net${link}` : null, _src: 'ggscore'
    });
  }
  return out;
}

// 抓 GGScore 单场详情页 meta description，提取地图小分
// 例："NEXVOID beat Lynn Vision 2–1 at ... on September 29, 2026 (BO3) · online. Maps: Ancient 13–11, Nuke 13–11, Inferno 19–16."
function ggParseMaps(html) {
  const desc = (html.match(/<meta name="description" content="([\s\S]*?)"\s*\/?>/i) || [])[1];
  if (!desc) return null;
  const maps = [];
  const mre = /\b(Ancient|Nuke|Inferno|Mirage|Dust2|Anubis|Overpass|Train|Vertigo|Cache|Office|Cobblestone|Basalt|Edin|Memento|Thera)\s+(\d+)[–-](\d+)\b/g;
  let m;
  while ((m = mre.exec(desc)) !== null) maps.push(`${m[1]} ${m[2]}:${m[3]}`);
  return maps;
}

// 用 GGScore 查某队最近赛果。返回 { matches, used, note }
async function ggTeamResults(filters, timeoutMs) {
  const team = await ggFindTeamUuid(filters, timeoutMs);
  if (!team) return { matches: [], used: false, note: 'GGScore 暂未收录该队伍页面' };
  const got = await fetchText(`https://ggscore.net/team/${team.uuid}`, timeoutMs);
  if (got.error || !got.text) return { matches: [], used: false, note: `GGScore 队伍页抓取失败：${got.error}` };
  let matches = ggParseTeam(got.text);
  // 过滤出含筛选队的
  if (filters.length) matches = matches.filter((m) => matchTeamsMatch(m, filters));
  // 为每场抓地图小分（只抓前几场）
  for (const m of matches.slice(0, 8)) {
    if (!m.link) continue;
    const pg = await fetchText(m.link, timeoutMs);
    if (pg.error || !pg.text) continue;
    const maps = ggParseMaps(pg.text);
    if (maps && maps.length) m.maps = maps;
  }
  return { matches, used: true, note: '' };
}

export function setup(api) {
  cfg = api.config;
  httpFetch = typeof api.fetch === 'function' ? (...args) => api.fetch(...args) : null;

  // ── 工具1：赛程 ──────────────────────────────────────────────
  api.registerTool({
    id: 'recent_schedule',
    name: 'CS2赛程查询',
    category: 'gaming',
    icon: '📅',
    description: '从 dust2.us 抓取 CS2 未来几天的比赛安排，返回每场比赛的星期、北京时间、对阵双方和赛事名。可用 teams 参数只查指定战队的比赛（支持中文如猎鹰/绿龙，或英文如 FaZe/Spirit）；用户未指定战队时按设置决定只看一线还是全部。用户问「最近有哪些CS比赛」「CS明天/后天谁打谁」「某战队有什么比赛」「猎鹰绿龙赛程」时使用。【队名对照】「绿龙」= Spirit（Team Spirit 俄罗斯队），绝不是 Lynn Vision/LVG；用户说绿龙请传 teams=Spirit。「猎鹰」=Falcons，「小蜜蜂」=Vitality。',
    parameters: {
      type: 'object',
      properties: {
        teams: { type: 'string', description: '可选，逗号分隔的战队名（中文或英文），只返回这些战队的比赛。例如「猎鹰,绿龙」或「FaZe,Spirit」。不传则按设置返回全部/一线。【重要】「绿龙」= Spirit，不是 Lynn Vision！用户说绿龙就传 Spirit。' },
        days: { type: 'number', description: '查未来几天，默认3，最多7' }
      }
    },
    async execute(_ctx, args = {}) {
      if (!httpFetch) return { content: '未启用网络权限（web_fetch），无法查询赛事。', isError: true };
      const c = cfg() || {};
      const timeoutMs = Math.min(30000, Math.max(3000, Number(c.timeoutMs) || 12000));
      const tz = c.timeZone || 'Asia/Shanghai';
      const days = Math.min(7, Math.max(1, Number(args?.days) || 3));
      const max = Math.min(20, Math.max(1, Number(c.maxResults) || 8));
      const topOnly = c.topOnly !== false;
      const topEvents = readList(c.topEvents);
      const filters = args?.teams ? readList(args.teams) : readTeams(c);
      const hasTeamFilter = filters.length > 0;

      const got = await fetchText('https://www.dust2.us/matches', timeoutMs);
      if (got.error) return { content: `查询赛程失败：${got.error}`, isError: true };

      const all = parseSchedule(got.text);
      const now = Date.now();
      const horizon = now + days * 24 * 60 * 60 * 1000;
      let upcoming = all
        .filter((x) => x.ts >= now && x.ts <= horizon)
        .sort((a, b) => a.ts - b.ts);

      if (hasTeamFilter) upcoming = upcoming.filter((m) => matchTeamsMatch(m, filters));
      if (!hasTeamFilter && topOnly && topEvents.length) {
        upcoming = upcoming.filter((x) => isTopEvent(x.event, topEvents));
      }
      upcoming = upcoming.slice(0, max);

      const scopeLabel = hasTeamFilter
        ? `战队「${filters.join('、')}」`
        : (topOnly && topEvents.length ? '一线赛事' : '全部赛事');
      if (!upcoming.length) {
        return { content: `未来 ${days} 天没有查到 ${scopeLabel} 的 CS2 赛程（数据源 dust2.us）。${hasTeamFilter ? '请确认战队名写法，或换别的队试试。' : '可在技能设置里关闭「只看一线赛事」查看全部。'}` };
      }

      const lines = upcoming.map((x) =>
        `· ${fmtTime(x.ts, tz)}｜${x.team1} VS ${x.team2}｜${x.event}`
      );
      return {
        content: `📅 CS2 未来 ${days} 天${scopeLabel}赛程（共 ${upcoming.length} 场）：\n${lines.join('\n')}\n\n（北京时间，来自 dust2.us）`
      };
    }
  });

  // ── 工具2：赛果（主源 dust2 + 备用 csapi + 点名战队时 GGScore 精确补查）──
  api.registerTool({
    id: 'recent_results',
    name: 'CS2近期赛果',
    category: 'gaming',
    icon: '🏆',
    description: '查询 CS2 最近几天已结束的比赛结果，返回对阵、大比分、赛事，并对前几场补充每张地图小比分。可用 teams 参数只查指定战队（中文或英文）；指定战队时一线过滤失效，非一线赛事也报。当用户明确点名某战队要精确查最新成绩时，除主源 dust2.us 外还会用 GGScore 队伍页核对（GGScore 收录更全）。用户问「昨天/前两天CS赛果」「某战队最近赛果比分」「LVG 9月29日赛果」时使用。【队名对照】「绿龙」= Spirit（Team Spirit 俄罗斯队），绝不是 Lynn Vision/LVG！用户说绿龙请传 teams=Spirit。「猎鹰」=Falcons，「小蜜蜂」=Vitality。',
    parameters: {
      type: 'object',
      properties: {
        teams: { type: 'string', description: '可选，逗号分隔的战队名（中文或英文），只返回这些战队的比赛。例如「猎鹰,绿龙」或「FaZe,Spirit」。不传则按设置返回全部/一线。【重要】「绿龙」= Spirit，不是 Lynn Vision！用户说绿龙就传 Spirit。' },
        days: { type: 'number', description: '查最近几天已结束的比赛，默认2，最多7' },
        withMaps: { type: 'boolean', description: '是否抓取地图小比分，默认 true' }
      }
    },
    async execute(_ctx, args = {}) {
      if (!httpFetch) return { content: '未启用网络权限（web_fetch），无法查询赛果。', isError: true };
      const c = cfg() || {};
      const timeoutMs = Math.min(30000, Math.max(3000, Number(c.timeoutMs) || 12000));
      const tz = c.timeZone || 'Asia/Shanghai';
      const max = Math.min(20, Math.max(1, Number(c.maxResults) || 8));
      const maxMaps = Math.min(8, Math.max(0, Number(c.maxMapResults) || 5));
      const wantMaps = args?.withMaps !== false;
      const topOnly = c.topOnly !== false;
      const topEvents = readList(c.topEvents);
      const days = Math.min(7, Math.max(1, Number(args?.days) || 2));
      const filters = args?.teams ? readList(args.teams) : readTeams(c);
      const hasTeamFilter = filters.length > 0;

      // ── 主源：dust2.us /results ──
      let recent = [];
      let usedSource = 'dust2.us';
      let mainError = null;
      let mainLatestDate = null;

      const got = await fetchText('https://www.dust2.us/results', timeoutMs);
      if (got.error) {
        mainError = got.error;
      } else {
        const groups = parseResults(got.text);
        const now = new Date();
        const tzNow = new Date(now.toLocaleString('en-US', { timeZone: tz }));
        const startToday = Date.UTC(tzNow.getUTCFullYear(), tzNow.getUTCMonth(), tzNow.getUTCDate());
        const startFrom = startToday - days * 24 * 60 * 60 * 1000;
        const endUpTo = startToday - 1;

        let windowed = [];
        for (const g of groups) {
          for (const m of g.matches) {
            if (m.ts >= startFrom && m.ts <= endUpTo) windowed.push(m);
          }
        }
        if (!windowed.length && groups.length) windowed = groups[0].matches;

        if (hasTeamFilter) windowed = windowed.filter((m) => matchTeamsMatch(m, filters));
        if (!hasTeamFilter && topOnly && topEvents.length) {
          windowed = windowed.filter((m) => isTopEvent(m.event, topEvents));
        }
        windowed = windowed.sort((a, b) => a.ts - b.ts);
        recent = windowed;
        if (hasTeamFilter) {
          const allTs = [];
          for (const g of groups) for (const m of g.matches) {
            if (matchTeamsMatch(m, filters) && m.ts) allTs.push(m.ts);
          }
          if (allTs.length) mainLatestDate = Math.max(...allTs);
        }
      }

      // ── 主源失败 或 主源查到为空 → 切备用源 csapi ──
      if (mainError || !recent.length) {
        const backup = await csapiResults(c, filters, timeoutMs, days);
        if (!backup.error && backup.matches.length) {
          recent = backup.matches;
          usedSource = 'csapi.de';
          if (!mainLatestDate && backup.latestDate) mainLatestDate = backup.latestDate;
        }
      }

      // ── 点名了战队 → 用 GGScore 队伍页精确补查最新成绩（收录更全）──
      let ggNote = '';
      let ggAdded = [];
      if (hasTeamFilter) {
        const gg = await ggTeamResults(filters, timeoutMs);
        if (gg.used) {
          if (gg.note) ggNote = gg.note;
          if (gg.matches.length) {
            // 合并 GGScore 里有、但主源/备用没有的比赛（按 match id 无法去重，用 ts+对阵 去重）
            const existing = new Set();
            for (const m of recent) existing.add(`${m.ts}|${m.team1}|${m.team2}`);
            ggAdded = gg.matches.filter((m) => !existing.has(`${m.ts}|${m.team1}|${m.team2}`));
            // GGScore 覆盖该队，作为最新来源提示
            usedSource = usedSource === 'dust2.us' ? 'dust2.us + GGScore' : `${usedSource} + GGScore`;
            if (ggAdded.length || !recent.length) {
              // 最新日期以 GGScore 为准（它更实时）
              const ggLatest = gg.matches.length ? Math.max(...gg.matches.map((m) => m.ts)) : null;
              if (ggLatest && (!mainLatestDate || ggLatest > mainLatestDate)) mainLatestDate = ggLatest;
            }
          } else if (!recent.length && gg.note) {
            ggNote = gg.note;
          }
        }
      }

      const scopeLabel = hasTeamFilter
        ? `战队「${filters.join('、')}」`
        : (topOnly && topEvents.length ? '一线赛事' : '全部赛事');
      // 时间降序取最近 max 场：保证 GGScore 补到的最新比赛优先显示，不被主源旧比赛挤掉
      const allRows = [...recent, ...ggAdded].sort((a, b) => b.ts - a.ts).slice(0, max);
      if (!allRows.length) {
        let msg = `最近 ${days} 天没有查到 ${scopeLabel} 已结束的 CS2 比赛（主源 dust2.us${usedSource.includes('csapi') ? '，备用源也已尝试' : ''}）。`;
        if (mainError) msg += `主源出错：${mainError}。`;
        if (ggNote) msg += `补充核对：${ggNote}。`;
        msg += hasTeamFilter ? '请确认战队名写法，或换别的队试试。' : '可在技能设置里关闭「只看一线赛事」查看全部。';
        return { content: msg };
      }

      // 补充地图小分
      let withMapCount = 0;
      const lines = [];
      for (const m of allRows) {
        let line = `· ${m.ts ? fmtTime(m.ts, tz) : '日期未知'}｜${m.team1} ${m.score1 == null ? '?' : m.score1}:${m.score2 == null ? '?' : m.score2} ${m.team2}｜${m.event || '未知赛事'}`;
        if (m.maps && m.maps.length) {
          line += `\n    地图：${m.maps.join('，')}`;
        } else if (wantMaps && m.link && withMapCount < maxMaps) {
          const maps = m.link.includes('dust2.us')
            ? await parseMatchMaps(m.link.replace('https://www.dust2.us', ''), timeoutMs)
            : null;
          if (m.link.includes('ggscore.net')) {
            const pg = await fetchText(m.link, timeoutMs);
            if (!pg.error && pg.text) {
              const gm = ggParseMaps(pg.text);
              if (gm && gm.length) { line += `\n    地图：${gm.join('，')}`; }
            }
          } else if (maps && maps.length) {
            line += `\n    地图：${maps.join('，')}`;
          }
          withMapCount++;
        }
        lines.push(line);
      }

      let header = `🏆 最近 ${days} 天${scopeLabel}CS2 赛果（共 ${allRows.length} 场）：`;
      let footer = `\n\n（来源：${usedSource}）`;
      // 新鲜度提示：点名战队时，若最新比赛距今天超过 2 天，提示可能漏了更新的
      if (hasTeamFilter && mainLatestDate) {
        const today0 = new Date();
        const tz0 = new Date(today0.toLocaleString('en-US', { timeZone: tz }));
        const startToday = Date.UTC(tz0.getUTCFullYear(), tz0.getUTCMonth(), tz0.getUTCDate());
        const diffDays = (startToday - mainLatestDate) / (24 * 60 * 60 * 1000);
        if (diffDays > 2) {
          const d = new Date(mainLatestDate);
          const p = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, month: 'numeric', day: 'numeric' }).formatToParts(d);
          const pm = {}; for (const x of p) pm[x.type] = x.value;
          footer += `\n⚠️ 提示：数据里「${filters.join('、')}」的最新比赛只到 ${Number(pm.month)}月${Number(pm.day)}日，可能还有更新的比赛数据源暂未收录，建议以赛事官方/直播平台为准。`;
        }
      }

      return { content: `${header}\n${lines.join('\n')}${footer}` };
    }
  });
}

/** 自检：没有网络权限时明确报出来。 */
export function available() {
  if (!httpFetch) return { ok: false, reason: '缺少 web_fetch 权限（清单里的 permissions 被删了？）' };
  return true;
}
