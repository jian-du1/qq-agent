/**
 * X（推特）技能 —— 挂在 x-worker 上。
 *
 * 分工：
 *   x-worker 负责「手」（浏览器、选择器、频次、安静时段、特关白名单）
 *   本技能负责「嘴」（把结果整理成模型能读的文字，把动作注册成工具）
 *
 * 控制台里那些数字（每天发几条、回几条、特关清单…）存在 qq-agent 的
 * config.skills['x-twitter']，但**拦截发生在 x-worker 里** —— 所以每次工具调用前
 * 都会把这份设置 sync 一次（内容没变就不发请求），worker 落盘保存，重启后还在。
 * 这样就算模型绕开技能直接打接口，额度也照样生效。
 */

const DEFAULTS = {
  workerUrl: 'http://127.0.0.1:8787',
  token: '',
  publishEnabled: 0,
  defaultLimit: 10,
  postsPerDay: 5,
  repliesPerDay: 25,
  minPostGapMinutes: 45,
  minReplyGapMinutes: 3,
  quietHours: '3-8',
  watchlist: '',
  watchDailyMax: 3,
  replyOnlyWatchlist: false,
  autoReplyWatchlist: false,
  readWatchFirst: true
};

let apiRef = null;

/** 控制台里存的是字符串/数字/布尔混着的，这里逐个收口，避免 NaN 让拦截逻辑失效 */
function int(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.round(n), min), max);
}

function bool(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return ['1', 'true', 'yes', 'on', '开'].includes(v.trim().toLowerCase());
  return false;
}

/** 清单支持「每行一个」「逗号分隔」「带 @」，统一拆成数组 */
function parseWatch(input) {
  let parts = input;
  if (typeof input === 'string') parts = input.split(/[\s,，、;；]+/);
  if (!Array.isArray(parts)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of parts) {
    const h = String(typeof raw === 'string' ? raw : (raw && raw.handle) || '')
      .trim()
      .replace(/^@+/, '');
    if (!/^[A-Za-z0-9_]{1,15}$/.test(h)) continue;
    if (seen.has(h.toLowerCase())) continue;
    seen.add(h.toLowerCase());
    out.push(h);
    if (out.length >= 20) break;
  }
  return out;
}

function conf() {
  // 加载器里 api.config 是**函数**（plugin-loader.js:95 → settingsOf(skillId)），
  // 老写法把它当对象展开，永远拿不到用户在控制台里改的值。
  const fromApi = apiRef && apiRef.config;
  const raw = (typeof fromApi === 'function' ? fromApi() : fromApi) || {};
  const m = { ...DEFAULTS, ...raw };
  return {
    workerUrl: String(m.workerUrl || DEFAULTS.workerUrl).trim() || DEFAULTS.workerUrl,
    token: String(m.token || ''),
    publishEnabled: bool(m.publishEnabled),
    defaultLimit: int(m.defaultLimit, DEFAULTS.defaultLimit, 1, 50),
    postsPerDay: int(m.postsPerDay, DEFAULTS.postsPerDay, 0, 100),
    repliesPerDay: int(m.repliesPerDay, DEFAULTS.repliesPerDay, 0, 500),
    minPostGapMinutes: int(m.minPostGapMinutes, DEFAULTS.minPostGapMinutes, 0, 1440),
    minReplyGapMinutes: int(m.minReplyGapMinutes, DEFAULTS.minReplyGapMinutes, 0, 600),
    quietHours: String(m.quietHours == null ? DEFAULTS.quietHours : m.quietHours).trim(),
    watchlist: parseWatch(m.watchlist),
    watchDailyMax: int(m.watchDailyMax, DEFAULTS.watchDailyMax, 1, 20),
    replyOnlyWatchlist: bool(m.replyOnlyWatchlist),
    autoReplyWatchlist: bool(m.autoReplyWatchlist),
    readWatchFirst: m.readWatchFirst === undefined ? true : bool(m.readWatchFirst)
  };
}

/* --------------------------------------------------------------- HTTP */

async function raw(pathname, { method = 'GET', body } = {}) {
  const c = conf();
  const url = `${String(c.workerUrl).replace(/\/+$/, '')}${pathname}`;
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (c.token) headers.authorization = `Bearer ${c.token}`;

  let res;
  try {
    // 用 api.fetch：它受 skill.json 的 web_fetch 权限门控，没声明就直接拒绝，
    // 免得技能绕过权限模型偷偷联网。测试里给的就是全局 fetch。
    const send = apiRef && typeof apiRef.fetch === 'function' ? apiRef.fetch : fetch;
    res = await send(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60000)
    });
  } catch (e) {
    return {
      ok: false,
      code: 'WORKER_DOWN',
      message: `连不上 x-worker（${url}）。检查两件事：x-worker 是否在跑；Chrome 是否用 scripts/start-chrome.ps1 启动（调试端口 9222）。原始错误：${e.message}`
    };
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { ok: false, code: 'BAD_RESPONSE', message: `x-worker 返回了非 JSON：${text.slice(0, 300)}` };
  }
  if (!res.ok) data.ok = false;
  return data;
}

/* ------------------------------------------------------- 设置同步 */

let syncState = { sig: '', at: 0 };

function settingsPayload(c) {
  return {
    limits: {
      postsPerDay: c.postsPerDay,
      repliesPerDay: c.repliesPerDay,
      minPostGapMinutes: c.minPostGapMinutes,
      minReplyGapMinutes: c.minReplyGapMinutes
    },
    quietHours: c.quietHours,
    watch: {
      list: c.watchlist,
      dailyMax: c.watchDailyMax,
      onlyWatch: c.replyOnlyWatchlist,
      readFirst: c.readWatchFirst
    }
  };
}

/**
 * 把控制台里的值推给 x-worker。
 * - 内容没变就不发请求（每次工具调用都推会白白多一次往返）
 * - 上次失败后一分钟内不重试，否则 worker 没起来时每个工具调用都要多等一次超时
 */
async function syncSettings(c) {
  const payload = settingsPayload(c);
  const sig = JSON.stringify(payload);
  if (sig === syncState.sig) return true;
  if (Date.now() - syncState.at < 60000) return false;
  const res = await raw('/settings', { method: 'PUT', body: payload });
  if (res.ok) {
    syncState = { sig, at: Date.now() };
    return true;
  }
  syncState = { ...syncState, at: Date.now() };
  return false;
}

/** 所有工具都走这里：先同步设置，再发请求 */
async function call(pathname, opts) {
  const c = conf();
  await syncSettings(c).catch(() => {});
  return raw(pathname, opts);
}

/* ------------------------------------------------------------ 展示 */

function errText(data) {
  const code = data.code || 'ERROR';
  return `X 操作被拒绝 [${code}]：${data.message || '未知原因'}`;
}

function shortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtTweet(t, i) {
  const who = t.author || t.handle || '?';
  const handle = t.handle && t.author ? ` (@${t.handle})` : '';
  const when = shortTime(t.time);
  const replies = Number.isFinite(t.replies) ? ` · ${t.replies} 回复` : '';
  const head = `${i + 1}. ${who}${handle}${when ? ` · ${when}` : ''}${replies}`;
  const body = (t.text || '（无文字，可能是纯图片/视频）').replace(/\n{3,}/g, '\n\n');
  return `${head}\n   ${body}\n   ${t.url || ''}`.trimEnd();
}

function fmtList(items) {
  if (!items || !items.length) return '（什么都没有，可能页面没加载出来或者被限流了）';
  return items.map(fmtTweet).join('\n\n');
}

function fmtQuota(q) {
  if (!q) return '';
  const lines = [
    `安全模式：${q.safeMode ? '开（只读，不能发）' : '关（可以发）'}`,
    `今天已发：${q.postsToday}/${q.postsPerDay} 条`,
    `最近一小时回复：${q.repliesLastHour}/${q.repliesPerHour} 条；今天累计 ${q.repliesToday}/${q.repliesPerDay}`,
    `安静时段：${q.quietHours || '无'}${q.inQuietHours ? '（现在就在里面，发不了）' : ''}`
  ];
  if (q.watch) {
    lines.push(
      q.watch.count
        ? `特关：${q.watch.count} 人（每人每天最多 ${q.watch.dailyMax} 条，今天特关累计 ${q.watch.repliesToday} 条）`
        : '特关：清单是空的'
    );
  }
  return lines.join('\n');
}

/** 从推文链接取作者 handle；/i/status/… 取不到就返回空串 */
function handleFromUrl(input) {
  const s = String(input || '');
  const m = s.match(/(?:https?:\/\/(?:www\.)?(?:x|twitter)\.com\/)?([A-Za-z0-9_]{1,15})\/status\/\d+/i);
  if (!m) return '';
  const h = m[1];
  return h === 'i' || h === 'web' ? '' : h;
}

function isWatch(c, handle) {
  const h = String(handle || '').toLowerCase();
  return Boolean(h) && c.watchlist.some((x) => x.toLowerCase() === h);
}

/* ------------------------------------------------------------ 工具 */

export function setup(api) {
  apiRef = api;

  api.registerTool({
    id: 'status',
    name: 'X 状态与额度',
    description:
      '查看 X 连接状态、今天还剩多少发布额度、特关设置是否生效。当用户问「推特还能用吗」「还能发几条」「为什么回不了这个人」时使用。',
    category: 'query',
    icon: '🐦',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const c = conf();
      const data = await call('/health');
      if (!data.ok) return { content: errText(data), isError: true };
      const cdp = data.cdp || {};
      const lines = [
        cdp.connected ? '浏览器：已接管' : `浏览器：未连接（${cdp.message || cdp.error || '未知'}）`,
        `发布开关：${c.publishEnabled ? '开' : '关（只能存草稿）'}`,
        fmtQuota(data.quota),
        `只回特关：${c.replyOnlyWatchlist ? '开（其他人回不了）' : '关'}；回特关免确认：${c.autoReplyWatchlist ? '开' : '关'}`,
        c.watchlist.length ? `清单：${c.watchlist.map((h) => `@${h}`).join('、')}` : '',
        `待发草稿：${data.drafts ?? 0} 条`
      ];
      return { content: lines.filter(Boolean).join('\n') };
    }
  });

  api.registerTool({
    id: 'read_home',
    name: '看 X 首页时间线',
    description:
      '读取 X 首页时间线（你关注的人的最新推文）。当用户说「看看推特上有什么」「时间线上有啥」时使用。只读，不会产生任何互动。',
    category: 'query',
    icon: '📰',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '取几条，默认 10，最大 50' }
      }
    },
    async execute(ctx, args) {
      const c = conf();
      const limit = Number(args?.limit) || c.defaultLimit;
      const data = await call(`/timeline?limit=${encodeURIComponent(limit)}`);
      if (!data.ok) return { content: errText(data), isError: true };

      // 「优先读特关」：把清单里这些人的推单独拉一份排在最前，并去重
      let watchBlock = '';
      if (c.readWatchFirst && c.watchlist.length) {
        const w = await raw(`/watch?limit=${encodeURIComponent(Math.min(limit, 10))}`);
        const items = (w && w.ok && w.items) || [];
        const ids = new Set(((data.items || []).map((t) => t.id)));
        const extra = items.filter((t) => !ids.has(t.id));
        if (extra.length) {
          watchBlock = `⭐ 特别关注的新推（${extra.length} 条）\n\n${fmtList(extra)}\n\n—— 以下是首页时间线 ——\n\n`;
        } else if (items.length) {
          watchBlock = '⭐ 特关的推都在下面的时间线里了。\n\n';
        }
      }
      return { content: `${watchBlock}${fmtList(data.items)}` };
    }
  });

  api.registerTool({
    id: 'read_watch',
    name: '看特关博主的推',
    description:
      '只读「特别关注的博主」清单里这些人最近的推文。当用户问「特关们发什么了」「我关注的那几个人最近说啥」时使用，比读整个时间线更省。',
    category: 'query',
    icon: '⭐',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '取几条，默认 10，最大 30' }
      }
    },
    async execute(ctx, args) {
      const c = conf();
      if (!c.watchlist.length) {
        return { content: '「特别关注的博主」清单是空的。让用户在 控制台 → 技能 → X（推特）→ 特别关注的博主 里填几个人。' };
      }
      const limit = Math.min(Number(args?.limit) || c.defaultLimit, 30);
      const data = await call(`/watch?limit=${encodeURIComponent(limit)}`);
      if (!data.ok) return { content: errText(data), isError: true };
      if (!data.count) {
        return { content: `特关清单里有 ${c.watchlist.length} 人（${c.watchlist.map((h) => '@' + h).join('、')}），但这会儿没搜到他们最近的推。可能都还没发新的，也可能搜索被限流了。` };
      }
      return { content: `⭐ 特关（${c.watchlist.map((h) => '@' + h).join('、')}）最近的推：\n\n${fmtList(data.items)}` };
    }
  });

  api.registerTool({
    id: 'search',
    name: '搜索 X',
    description:
      '在 X 上按关键词搜索最新推文。当用户想知道某个话题/名字在推特上怎么说时使用。只读。',
    category: 'query',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词，支持 X 的搜索语法（如 from:user、#tag）' },
        limit: { type: 'number', description: '取几条，默认 10，最大 50' }
      },
      required: ['query']
    },
    async execute(ctx, args) {
      const q = String(args?.query || '').trim();
      if (!q) return { content: '搜索词不能为空。', isError: true };
      const limit = Number(args?.limit) || conf().defaultLimit;
      const data = await call(`/search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`);
      if (!data.ok) return { content: errText(data), isError: true };
      return { content: `搜索「${q}」结果：\n\n${fmtList(data.items)}` };
    }
  });

  api.registerTool({
    id: 'read_thread',
    name: '读一条推文和它的回复',
    description:
      '打开某条推文，读正文和下面的回复。起草回复前必须先调这个，不然你不知道人家在说什么。参数可以是完整链接，也可以只是推文 ID。',
    category: 'query',
    icon: '🧵',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '推文链接（https://x.com/xxx/status/123）或纯数字 ID' },
        limit: { type: 'number', description: '回复最多读几条，默认 10' }
      },
      required: ['url']
    },
    async execute(ctx, args) {
      const url = String(args?.url || '').trim();
      if (!url) return { content: '链接不能为空。', isError: true };
      const limit = Number(args?.limit) || conf().defaultLimit;
      const data = await call(`/thread?url=${encodeURIComponent(url)}&limit=${encodeURIComponent(limit)}`);
      if (!data.ok) return { content: errText(data), isError: true };

      const parts = [];
      if (data.root) parts.push(`【主推】\n${fmtTweet(data.root, 0)}`);
      if (data.replies?.length) {
        parts.push(`【回复 ${data.replies.length} 条】\n${data.replies.map((t, i) => fmtTweet(t, i)).join('\n\n')}`);
      } else {
        parts.push('【暂无回复】');
      }
      return { content: parts.join('\n\n') };
    }
  });

  api.registerTool({
    id: 'draft_reply',
    name: '起草一条回复',
    description:
      '把你想好的回复存进草稿箱，不会发出去。当用户让你「回一句」「在这条下面说点什么」时，先用 read_thread 读懂，再用这个存草稿，然后把草稿内容和编号告诉用户，等他点头。例外：对象在「特别关注的博主」清单里且用户开了「回特关免确认」时，这条会直接发出去，返回里会写明。',
    category: 'web',
    icon: '✍️',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要回复的推文链接或 ID' },
        text: { type: 'string', description: '回复正文，一两句话，280 字以内' }
      },
      required: ['url', 'text']
    },
    async execute(ctx, args) {
      const url = String(args?.url || '').trim();
      const text = String(args?.text || '').trim();
      if (!url || !text) return { content: '链接和正文都要给。', isError: true };

      const c = conf();
      const data = await call('/drafts', { method: 'POST', body: { kind: 'reply', target: url, text } });
      if (!data.ok) return { content: errText(data), isError: true };

      const d = data.draft;
      const handle = handleFromUrl(url);

      // 特关 + 免确认：存完草稿立刻发出去（额度、间隔、安静时段仍由 worker 拦）
      if (c.autoReplyWatchlist && c.publishEnabled && isWatch(c, handle)) {
        const pub = await raw(`/drafts/${encodeURIComponent(d.id)}/publish`, { method: 'POST', body: {} });
        if (pub.ok) {
          return {
            content: `已自动发出（回复 @${handle}，特关免确认）：\n「${d.text}」\n\n${fmtQuota(pub.quota)}`
          };
        }
        return {
          content: `草稿 #${d.id} 已存（回复 @${handle}），但免确认发布被拦下了：${pub.code || 'ERROR'} — ${pub.message || '未知原因'}\n「${d.text}」\n\n要发的话让用户回「发 ${d.id}」。`
        };
      }

      const gate = c.publishEnabled ? '' : '\n（发布开关是关的，草稿现在只能看不能发）';
      let hint = '';
      if (handle && !isWatch(c, handle)) {
        if (c.replyOnlyWatchlist) {
          hint = `\n（「只回特关」开着，@${handle} 不在特关清单里 —— 这条就算用户点头也会被服务端拒绝，先说清楚）`;
        } else if (c.autoReplyWatchlist) {
          hint = `\n（@${handle} 不在特关清单里，所以这条要等用户点头）`;
        }
      }
      return {
        content: `草稿 #${d.id} 已存（回复 ${url}）：\n「${d.text}」\n\n要发的话，让用户回一句「发 ${d.id}」。${gate}${hint}`
      };
    }
  });

  api.registerTool({
    id: 'draft_post',
    name: '起草一条推文',
    description:
      '把你想发的推文存进草稿箱，不会发出去。当用户让你「帮我发条推」「写条推特」时用。存完把内容和编号告诉用户，等他点头。',
    category: 'web',
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '推文正文，280 字以内' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const text = String(args?.text || '').trim();
      if (!text) return { content: '内容不能为空。', isError: true };

      const c = conf();
      const data = await call('/drafts', { method: 'POST', body: { kind: 'post', target: '', text } });
      if (!data.ok) return { content: errText(data), isError: true };

      const d = data.draft;
      const gate = c.publishEnabled ? '' : '\n（发布开关是关的，草稿现在只能看不能发）';
      return { content: `草稿 #${d.id} 已存：\n「${d.text}」\n\n要发的话，让用户回一句「发 ${d.id}」。${gate}` };
    }
  });

  api.registerTool({
    id: 'publish',
    name: '发布草稿',
    description:
      '真正把某个草稿发到 X 上。只有在用户本轮明确说出「发 #编号」（编号来自 draft_post / draft_reply 的返回）时才允许调用。用户没有明确指定编号时，绝对不要调用这个工具，先问清楚。',
    category: 'web',
    icon: '🚀',
    parameters: {
      type: 'object',
      properties: {
        draftId: { type: 'string', description: '草稿编号，例如 a1b2c3' }
      },
      required: ['draftId']
    },
    async execute(ctx, args) {
      const id = String(args?.draftId || '').trim();
      if (!id) return { content: '要给草稿编号。', isError: true };

      if (!conf().publishEnabled) {
        return {
          content:
            '发布开关没开（控制台 → 技能 → X（推特）→ 允许发布 设成 1），所以这次没有发出去。草稿还在，编号 ' + id + '。',
          isError: true
        };
      }

      const data = await call(`/drafts/${encodeURIComponent(id)}/publish`, { method: 'POST', body: {} });
      if (!data.ok) return { content: errText(data), isError: true };

      const d = data.draft || {};
      return {
        content: `已发出（草稿 #${d.id}，${d.kind === 'reply' ? '回复' : '推文'}）：\n「${d.text}」\n\n剩余额度：${fmtQuota(data.quota)}`
      };
    }
  });
}

export function available() {
  return true;
}
