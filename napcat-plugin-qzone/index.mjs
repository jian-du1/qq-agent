// napcat-plugin-qzone —— 给 NapCat 补上 QQ 空间的「读取」与「评论」
//
// 为什么需要它：
//   NapCat 只实现了 send_qzone_msg / delete_qzone_msg 两个空间动作，
//   没有 get_qzone_feeds（读说说+评论）和 comment_qzone（发评论）。
//   QQ Agent 的 qzone 技能正好需要这两个，所以在这里补齐。
//
// 它怎么工作：
//   1. 用插件上下文里的 core（QQ 内核）取 skey / pskey —— 和 NapCat 自己发说说用的是同一套凭据；
//   2. 用这些 cookie 请求 QZone 的网页接口（emotion_cgi_msglist_v6 等），整理成 OneBot 风格 data；
//      再把评论渲染成 qzone 技能认识的 html（那条技能的解析器读 html 字段）；
//   3. 把两个动作塞进 ctx.actions，外部就能 POST /get_qzone_feeds、/comment_qzone。
//
// 注意：这些是腾讯的网页私有接口，没有公开文档，随时可能变。所以：
//   · 任何一步失败都返回结构化错误，不抛异常（免得把别的动作带崩）；
//   · /selftest 路由会把每一步的原始返回打出来，方便定位是哪一环变了。

import fs from 'node:fs';
import path from 'node:path';

let C = null;                 // 插件上下文
const TAG = '[qzone-ext]';
const log = (...a) => { try { C?.logger?.info?.(TAG, ...a); } catch { /* ignore */ } };
const warn = (...a) => { try { C?.logger?.warn?.(TAG, ...a); } catch { /* ignore */ } };

// ── 小工具 ────────────────────────────────────────────────────────────────
/** QZone 网页接口要的 bkn（g_tk）：对 pskey/skey 做 hash33 */
function hash33(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i += 1) h += (h << 5) + str.charCodeAt(i);
  return (h & 0x7fffffff) >>> 0;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function toNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/** 从 HTML/JSONP 里抠出 JSON 主体 */
function looseJson(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* 继续试 */ }
  const m = /^[^(]*\(([\s\S]*)\)\s*;?\s*$/.exec(t);
  if (m) { try { return JSON.parse(m[1]); } catch { /* 继续试 */ } }
  const i = t.search(/[[{]/);
  if (i >= 0) { try { return JSON.parse(t.slice(i)); } catch { /* 继续试 */ } }
  return null;
}

// ── 凭据 ──────────────────────────────────────────────────────────────────
async function getAuth() {
  const core = C?.core;
  const uin = String(core?.selfInfo?.uin ?? core?.selfInfo?.uid ?? '');
  let skey = '';
  let pskey = '';
  try { skey = (await core?.apis?.UserApi?.getSKey?.()) || ''; } catch (e) { warn('getSKey 失败', e?.message); }
  try {
    const ps = await core?.apis?.UserApi?.getPSkey?.(['qzone.qq.com']);
    pskey = ps?.domainPskeyMap?.get?.('qzone.qq.com') || ps?.domainPskeyMap?.['qzone.qq.com'] || '';
  } catch (e) { warn('getPSkey 失败', e?.message); }
  const gtk = hash33(pskey || skey);
  // QZone 网页接口认的是这几个：uin / p_uin 带 o 前缀，skey / p_skey 原样
  const cookie = `uin=o${uin}; skey=${skey}; p_uin=o${uin}; p_skey=${pskey};`;
  return { uin, skey, pskey, gtk, cookie };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function qzoneFetch(url, { method = 'GET', form = null, rawBody = null, rawBodyCharset = 'UTF-8', auth } = {}) {
  const headers = {
    Cookie: auth.cookie,
    'User-Agent': UA,
    Referer: `https://user.qzone.qq.com/${auth.uin}`,
    Accept: 'application/json, text/plain, */*'
  };
  let body;
  if (rawBody != null) {
    // 调用方自己拼好的表单串（用于编码探测：content 原样放进去，不二次编码）
    headers['Content-Type'] = `application/x-www-form-urlencoded; charset=${rawBodyCharset}`;
    body = rawBody;
  } else if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  return { status: res.status, text, json: looseJson(text) };
}

// ── 评论 → qzone 技能认识的 html ──────────────────────────────────────────
// 技能的正则要求：comments-list > li[data-type=commentroot|replyroot]，
// 属性 data-tid / data-uin / data-nick，正文在 div.comments-content 里，
// 且形状是「<a class="nickname">昵称</a>&nbsp; : 正文」。
function renderCommentsHtml(comments) {
  const items = [];
  for (const c of comments) {
    const type = c.parentTid ? 'replyroot' : 'commentroot';
    const bodyText = c.parentTid && c.replyToNick ? `回复 ${c.replyToNick} : ${c.text}` : c.text;
    items.push(
      `<li class="comments-item bor3" data-type="${type}" data-tid="${esc(c.tid)}" data-uin="${esc(c.uin)}" data-nick="${esc(c.nick)}" data-who="1">`
      + '<div class="comments-item-bd"><div class="comments-content">'
      + `<a class="nickname" href="#">${esc(c.nick)}</a>&nbsp; : ${esc(bodyText)}`
      + '</div><div class="comments-op">'
      + `<span class="state">${esc(c.timeText || '')}</span>`
      + '</div></div></li>'
    );
  }
  return `<div class="comments-list "><ul>${items.join('')}</ul></div>`;
}

function fmtTime(ts) {
  const n = toNum(ts);
  if (!n) return '';
  const d = new Date(n * 1000);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── QZone 接口：自己的说说（含评论）──────────────────────────────────────
async function fetchSelfFeeds({ pageNum = 1, count = 10, auth, hostUin = '' }) {
  const uin = auth.uin;
  const host = hostUin ? String(hostUin) : uin;
  const pos = Math.max(0, (pageNum - 1) * count);
  const url = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6'
    + `?uin=${uin}&ftype=0&sort=0&pos=${pos}&num=${count}&g_tk=${auth.gtk}`
    + `&hostUin=${host}&format=json&inCharset=utf-8&outCharset=utf-8&notice=0`
    + '&platform=jqmini&need_private_comment=1';
  const r = await qzoneFetch(url, { auth });
  const list = r.json?.msglist || [];
  return { rawStatus: r.status, code: r.json?.code ?? null, list, sample: r.text.slice(0, 400) };
}

/** 本机 OneBot HTTP 端口（从 napcat 的 onebot11_<uin>.json 里读，读不到就 3000） */
function onebotPort() {
  try {
    const cp = C?.core?.context?.pathWrapper?.configPath;
    const uin = String(C?.core?.selfInfo?.uin ?? '');
    if (cp && uin) {
      const f = path.join(cp, `onebot11_${uin}.json`);
      if (fs.existsSync(f)) {
        const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
        const p = j?.network?.httpServers?.[0]?.port;
        if (p) return Number(p);
      }
    }
  } catch { /* 忽略 */ }
  return 3000;
}

/** 好友列表（走本机 OneBot 的 get_friend_list） */
async function fetchFriendList(auth, limit = 8) {
  try {
    const port = onebotPort();
    const res = await fetch(`http://127.0.0.1:${port}/get_friend_list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const j = await res.json();
    const arr = Array.isArray(j?.data) ? j.data : [];
    return arr
      .map((f) => ({ uin: String(f?.user_id ?? ''), nick: String(f?.remark || f?.nickname || '') }))
      .filter((f) => /^\d{5,15}$/.test(f.uin))
      .slice(0, Math.max(1, limit));
  } catch {
    return [];
  }
}

/** 把 msglist 的一条转成技能要的结构 */
function normalizeSelfPost(m) {
  const comments = [];
  const cl = Array.isArray(m?.commentlist) ? m.commentlist : [];
  for (const c of cl) {
    const rootTid = String(c?.tid ?? c?.commentid ?? '');
    comments.push({
      tid: rootTid,
      uin: String(c?.uin ?? ''),
      nick: String(c?.nickname ?? c?.name ?? ''),
      text: String(c?.content ?? ''),
      timeText: fmtTime(c?.createTime ?? c?.created_time ?? c?.time),
      parentTid: null,
      replyToNick: ''
    });
    // 楼中楼：不同版本字段名不一样，能认几个认几个
    const subs = c?.list_3 || c?.replies || c?.replyList || c?.subComments || [];
    for (const s of Array.isArray(subs) ? subs : []) {
      const re = /^回复\s*([^\s:：]+)\s*[:：]?\s*/.exec(String(s?.content ?? ''));
      comments.push({
        tid: String(s?.tid ?? s?.commentid ?? ''),
        uin: String(s?.uin ?? ''),
        nick: String(s?.nickname ?? ''),
        text: String(s?.content ?? ''),
        timeText: fmtTime(s?.createTime ?? s?.created_time),
        parentTid: rootTid,
        replyToNick: re ? re[1] : ''
      });
    }
  }
  return {
    key: String(m?.tid ?? ''),
    tid: String(m?.tid ?? ''),
    uin: String(m?.uin ?? ''),
    nickname: String(m?.nickname ?? ''),
    time: toNum(m?.created_time ?? m?.createTime),
    content: String(m?.content ?? ''),
    commentTotal: toNum(m?.cmtnum),   // 说说上的评论总数（msglist 里的 commentlist 可能不全）
    commentCount: comments.length,
    html: renderCommentsHtml(comments),
    comments
  };
}

// ── QZone 接口：好友动态（尽力而为）──────────────────────────────────────
async function fetchFriendFeeds({ count = 10, auth }) {
  const uin = auth.uin;
  const url = 'https://user.qzone.qq.com/proxy/domain/ic2.qzone.qq.com/cgi-bin/feeds/feeds3_html_more'
    + `?uin=${uin}&scope=0&view=1&flag=1&filter=all&pagenum=1&count=${count}`
    + `&g_tk=${auth.gtk}&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=jqmini`;
  const r = await qzoneFetch(url, { auth });
  const arr = r.json?.data || [];
  const list = [];
  for (const f of arr) {
    const body = f?.body || f?.data || f;
    const tid = String(body?.tid ?? f?.tid ?? '');
    const u = String(body?.uin ?? f?.uin ?? '');
    const nick = String(body?.nickname ?? f?.nickname ?? '');
    if (!tid) continue;
    list.push({
      key: tid,
      tid,
      uin: u,
      nickname: nick,
      time: toNum(body?.created_time ?? f?.created_time ?? f?.abstime),
      content: String(body?.content ?? ''),
      commentCount: 0,
      html: '',            // 好友动态的评论要额外拉 msgdetail，先留空
      comments: []
    });
  }
  return { rawStatus: r.status, code: r.json?.code ?? null, list, sample: r.text.slice(0, 400) };
}

/** 拉某条说说的详情（含评论）—— 用于好友动态 */
async function fetchPostDetail({ tid, uin, auth }) {
  const url = 'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6'
    + `?uin=${auth.uin}&tid=${encodeURIComponent(tid)}&hostUin=${encodeURIComponent(uin || auth.uin)}`
    + `&num=20&pos=0&g_tk=${auth.gtk}&format=json&inCharset=utf-8&outCharset=utf-8&notice=0&platform=jqmini`;
  const r = await qzoneFetch(url, { auth });
  return r.json || null;
}

function commentsFromDetail(d) {
  const out = [];
  const cl = d?.commentlist || d?.data?.commentlist || [];
  for (const c of cl) {
    out.push({
      tid: String(c?.tid ?? ''), uin: String(c?.uin ?? ''), nick: String(c?.nickname ?? ''),
      text: String(c?.content ?? ''), timeText: fmtTime(c?.createTime), parentTid: null, replyToNick: ''
    });
  }
  return out;
}

// ── 动作实现 ──────────────────────────────────────────────────────────────
function reply(data, echo) {
  return { status: 'ok', retcode: 0, data, message: '', wording: '', echo: echo ?? '' };
}
function fail(msg, echo) {
  return { status: 'failed', retcode: 100, data: null, message: String(msg), wording: String(msg), echo: echo ?? '' };
}

async function actionGetFeeds(params = {}, echo = '') {
  try {
    const auth = await getAuth();
    if (!auth.skey && !auth.pskey) return fail('拿不到空间凭据（skey/pskey 都是空），可能未登录', echo);
    const pageNum = Math.max(1, toNum(params.page_num ?? params.pageNum) || 1);
    const count = Math.min(50, Math.max(1, toNum(params.count) || 10));
    const self = await fetchSelfFeeds({ pageNum, count, auth });
    const posts = (self.list || []).map(normalizeSelfPost).filter((p) => p.tid);

    // msglist 里带的 commentlist 只有前几条，而且可能是旧快照 —— 实测新发的评论读不到。
    // 所以只要「总数 > 拿到的条数」，就逐条调 msgdetail_v6 补全。
    for (const post of posts) {
      if (post.commentTotal > post.comments.length) {
        try {
          const detail = await fetchPostDetail({ tid: post.tid, uin: post.uin, auth });
          const fresh = commentsFromDetail(detail);
          if (fresh.length > post.comments.length) {
            post.comments = fresh;
            post.commentCount = fresh.length;
            post.html = renderCommentsHtml(fresh);
            post.enriched = true;
          }
        } catch (e) {
          post.enrichError = String(e?.message ?? e);
        }
      }
    }

    // 好友动态：参数带 friends=true 才拉。
    // 不用 feeds3_html_more（它返回的是 JS 字面量，不是 JSON，解析不了），
    // 改成「取好友列表 → 逐个用 msglist(hostUin=好友) 拉说说」，复用已经跑通的解析。
    let friendPosts = [];
    let friendInfo = null;
    if (params.friends === true || params.with_friends === true) {
      try {
        const friendLimit = Math.min(12, Math.max(1, toNum(params.friendLimit) || 6));
        const perFriend = Math.min(5, Math.max(1, toNum(params.perFriend) || 2));
        const friends = await fetchFriendList(auth, friendLimit);
        const picked = [];
        for (const fr of friends) {
          try {
            const ff = await fetchSelfFeeds({ pageNum: 1, count: perFriend, auth, hostUin: fr.uin });
            for (const m of (ff.list || [])) {
              const post = normalizeSelfPost(m);
              // ⚠️ 实测 msglist_v6 不认 hostUin —— 传谁进去拿回来的都是「自己」的说说。
              // 所以这里必须用返回的 uin 校验，不是对方发的一律丢掉，
              // 否则会把「自己的帖子」当成好友动态，甚至把评论评到自己头上。
              if (!post.tid) continue;
              if (String(post.uin) !== String(fr.uin)) continue;
              if (!post.nickname && fr.nick) post.nickname = fr.nick;
              picked.push(post);
            }
          } catch { /* 单个好友失败不影响整体 */ }
        }
        friendPosts = picked;
        friendInfo = { friends: friends.length, posts: picked.length };
      } catch (e) {
        friendInfo = { error: String(e?.message ?? e) };
      }
    }
    // 好友说说也要补评论（同样靠 msgdetail_v6）
    for (const post of friendPosts) {
      if (post.commentTotal > post.comments.length) {
        try {
          const detail = await fetchPostDetail({ tid: post.tid, uin: post.uin, auth });
          const fresh = commentsFromDetail(detail);
          if (fresh.length > post.comments.length) {
            post.comments = fresh;
            post.commentCount = fresh.length;
            post.html = renderCommentsHtml(fresh);
            post.enriched = true;
          }
        } catch { /* 忽略单条失败 */ }
      }
    }

    const feeds = [...posts, ...friendPosts];
    return reply({
      feeds,
      selfCount: posts.length,
      friendCount: friendPosts.length,
      friendInfo,
      auth: { uin: auth.uin, hasSkey: !!auth.skey, hasPSkey: !!auth.pskey, gtk: auth.gtk }
    }, echo);
  } catch (e) {
    return fail(`get_qzone_feeds 异常：${e?.message ?? e}`, echo);
  }
}

async function actionComment(params = {}, echo = '') {
  try {
    const auth = await getAuth();
    const tid = String(params.tid ?? '').trim();
    // rawContent：已经按某种编码准备好、要求原样放进 content 字段（不经过 URLSearchParams 二次编码）。
    // 这是给「编码探测」用的后门：中文在 QZone 那边变成 ?，需要逐个试编码方案。
    const rawContent = params.rawContent == null ? null : String(params.rawContent);
    const content = rawContent == null ? String(params.content ?? '').trim() : rawContent;
    if (!tid) return fail('缺少 tid', echo);
    if (!content) return fail('评论内容为空', echo);
    if (content.length > 2000) return fail('评论内容过长', echo);
    const url = 'https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds'
      + `?g_tk=${auth.gtk}`;
    // QZone 这个接口要的是一组「话题/对象」参数，少一个就回 code -10004 参数错误：
    //   topicId : <宿主uin>_<tid>
    //   feeds   : <t2_uin>宿主uin</t2_uin><t2_tid>说说tid</t2_tid>   ← 报错里那句 <t2_uin>0</t2_uin> 就是它为空
    // 另外 platform 用 qzone（不是 jqmini），ref/platqzone 也按网页版带齐。
    const form = {
      uin: auth.uin,
      hostUin: params.hostUin ? String(params.hostUin) : auth.uin,
      topicId: `${params.hostUin ? String(params.hostUin) : auth.uin}_${tid}`,
      feeds: `<t2_uin>${params.hostUin ? String(params.hostUin) : auth.uin}</t2_uin><t2_tid>${tid}</t2_tid>`,
      tid,
      content,
      format: 'json',
      platform: 'qzone',
      platqzone: 'qzone',
      ref: 'feeds',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      qzreferrer: `https://user.qzone.qq.com/${auth.uin}`
    };
    // 编码探测模式：content 由调用方按目标编码准备好（已 percent-encode），原样拼进表单，
    // 不走 URLSearchParams 的 UTF-8 编码。用来试 GBK / 双重编码这些方案。
    let r;
    if (rawContent != null) {
      delete form.content;
      const rest = new URLSearchParams(form).toString();
      const body = rest + '&content=' + rawContent;
      r = await qzoneFetch(url, {
        method: 'POST',
        rawBody: body,
        rawBodyCharset: String(params.rawCharset || 'UTF-8'),
        auth
      });
    } else {
      r = await qzoneFetch(url, { method: 'POST', form, auth });
    }
    const okCode = r.json?.code === 0 || r.json?.ret === 0 || r.json?.subcode === 0;
    if (!okCode) {
      return { ...fail(`评论失败：${JSON.stringify(r.json ?? r.text.slice(0, 200))}`, echo), data: { raw: r.json, status: r.status } };
    }
    return reply({ tid, ok: true, raw: r.json }, echo);
  } catch (e) {
    return fail(`comment_qzone 异常：${e?.message ?? e}`, echo);
  }
}

// ── 插件生命周期 ──────────────────────────────────────────────────────────
// 真正的实现放在 initImpl 里，对外导出的 plugin_init 整体包一层 try/catch：
// 这样插件自己出问题也只是少两个动作，绝不会把 NapCat 的启动带崩。
async function initImpl(ctx) {
  C = ctx;
  log('初始化，pluginPath =', ctx.pluginPath);

  const actions = ctx.actions;
  if (!actions || typeof actions.set !== 'function') {
    warn('ctx.actions 不可用，动作注册失败');
  } else {
    const reg = (name, handler) => {
      actions.set(name, {
        actionName: name,
        // HTTP 分发调 handle(params, adapterName, config, extra)；WS 分发调 websocketHandle(...)。
        // 两个都挂上，谁调都能用；echo 从 params 里取。
        handle: (params, ...rest) => handler(params || {}, params?.echo ?? rest?.[0] ?? ''),
        websocketHandle: (params, echo) => handler(params || {}, echo ?? params?.echo ?? '')
      });
      log('已注册动作', name);
    };
    reg('get_qzone_feeds', actionGetFeeds);
    reg('comment_qzone', actionComment);
  }

  // 自检路由（免鉴权，方便本机 curl）
  try {
    ctx.router.getNoAuth('/selftest', async (_req, res) => {
      const out = {};
      try {
        const auth = await getAuth();
        out.auth = {
          uin: auth.uin, hasSkey: !!auth.skey, hasPSkey: !!auth.pskey,
          gtk: auth.gtk, skeyLen: auth.skey.length, pskeyLen: auth.pskey.length
        };
        const self = await fetchSelfFeeds({ pageNum: 1, count: 3, auth });
        out.self = { status: self.rawStatus, code: self.code, got: self.list.length, sample: self.sample };
        const first = self.list[0];
        out.selfFirst = first ? {
          tid: first.tid, uin: first.uin, nick: first.nickname,
          keys: Object.keys(first),
          commentSample: JSON.stringify((first.commentlist || [])[0] || null).slice(0, 600)
        } : null;
        const ff = await fetchFriendFeeds({ count: 3, auth }).catch((e) => ({ error: String(e?.message ?? e) }));
        out.friends = ff.error ? ff : { status: ff.rawStatus, code: ff.code, got: ff.list.length, sample: ff.sample };
      } catch (e) {
        out.error = String(e?.message ?? e);
      }
      res.json({ code: 0, data: out });
    });
    // 数据路由（免鉴权）：QQ Agent 的 qzone 技能直接打这两个地址。
    // 走 HTTP 而不是 OneBot 动作，是因为 NapCat 的插件上下文拿不到动作表
    // （ctx.actions 为 undefined），插件注册不了新 API，只能自己开路由。
    ctx.router.getNoAuth('/feeds', async (req, res) => {
      const q = req.query || {};
      const out = await actionGetFeeds({
        count: Number(q.count) || 10,
        page_num: Number(q.page_num) || 1,
        friends: q.friends === '1' || q.friends === 'true'
      }, '');
      res.json(out);
    });

    // 指定 uin 的说说列表（等价于 SnowLuma 的 get_qzone_msg_list）——给 qzone-sweeper 用
    ctx.router.getNoAuth('/msglist', async (req, res) => {
      try {
        const q = req.query || {};
        const auth = await getAuth();
        const hostUin = String(q.uin || auth.uin);
        const num = Math.min(20, Math.max(1, Number(q.num) || 5));
        const r = await fetchSelfFeeds({ pageNum: 1, count: num, auth, hostUin });
        res.json({ status: 'ok', retcode: 0, data: { msglist: r.list || [] } });
      } catch (e) {
        res.json({ status: 'failed', retcode: 100, data: null, message: String(e?.message ?? e) });
      }
    });

    // 按说说 tid 直接查评论（不依赖「最近几条说说」列表）
    ctx.router.getNoAuth('/comments', async (req, res) => {
      try {
        const q = req.query || {};
        const auth = await getAuth();
        const tid = String(q.tid || '').trim();
        if (!tid) return res.json({ status: 'failed', retcode: 100, message: '缺少 tid' });
        const uin = String(q.uin || auth.uin);
        const d = await fetchPostDetail({ tid, uin, auth });
        if (!d) return res.json({ status: 'failed', retcode: 100, message: '拿不到这条说说的详情（可能已删除/无权限）' });
        const comments = commentsFromDetail(d);
        res.json({
          status: 'ok', retcode: 0,
          data: {
            tid, uin,
            content: String(d?.content ?? d?.conlist?.[0]?.con ?? ''),
            commentTotal: toNum(d?.cmtnum) || comments.length,
            comments,
            html: renderCommentsHtml(comments)
          }
        });
      } catch (e) {
        res.json({ status: 'failed', retcode: 100, message: String(e?.message ?? e) });
      }
    });

    ctx.router.postNoAuth('/comment', async (req, res) => {
      const b = req.body || {};
      const out = await actionComment({ tid: b.tid, content: b.content, hostUin: b.hostUin }, '');
      res.json(out);
    });

    log('已注册 /feeds 与 /comment 数据路由');
    log('已注册 /selftest 路由');
  } catch (e) {
    warn('注册 selftest 路由失败', e?.message);
  }

  log('就绪');
}

/**
 * 对外入口：整个初始化包一层 try/catch。
 * 设计原则——插件是「附加能力」，绝不能成为 NapCat 启动的失败点。
 */
export const plugin_init = async (ctx) => {
  try {
    await initImpl(ctx);
  } catch (e) {
    try { ctx?.logger?.error?.('[qzone-ext] 初始化失败（已忽略，不影响 NapCat）', e?.message ?? e); } catch { /* ignore */ }
  }
};

export const plugin_onevent = async () => { /* 本插件不处理事件 */ };
