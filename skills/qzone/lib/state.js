// 空间技能的本地状态：发布配额 + 评论去重。
//
// ── 为什么要落盘 ──
// 模型每次运行都**没有上一次的记忆**。所以两类东西必须持久化：
//   ① 发布频率 —— 不然它会忘记"这周已经发过两条了"，一直发。
//   ② 评论去重 —— 评论是异步来的。不记下来就会把同一条评论反复回一遍，
//      而**在别人空间里刷屏比在群里严重得多**。
//
// ── 两张评论表的分工 ──
//   repliedComments —— 已经回过的。回过就不再回同一条。
//   seenComments    —— 看过了、但决定不回。避免每次都被重新推荐（免得反复骚扰模型）。
// 同一条评论**不该同时出现在两张表里**：回过了就从 seen 里删掉。早期版本漏了这步，
// 状态文件里出现"既已回又未回"的重复记录，排查时很误导（读取时会顺手清一遍）。

import fs from 'node:fs';
import path from 'node:path';

export class QzoneState {
  constructor({ dir } = {}) {
    this.dir = dir || path.join(process.env.QQ_AGENT_DATA_DIR || path.join(process.cwd(), 'data'), 'Qzone');
    this.file = path.join(this.dir, 'state.json');
    this.data = this.#read();
  }

  #read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const replied = (raw?.repliedComments && typeof raw.repliedComments === 'object') ? raw.repliedComments : {};
      const seen = (raw?.seenComments && typeof raw.seenComments === 'object') ? raw.seenComments : {};
      // 历史清理：早期版本会把同一条评论同时写进两张表（先标 seen，之后回复了却没从
      // seen 删掉）。读取时顺手清一遍，免得状态文件越积越乱。
      for (const k of Object.keys(seen)) if (replied[k]) delete seen[k];
      return {
        posts: Array.isArray(raw?.posts) ? raw.posts : [],
        repliedComments: replied,
        seenComments: seen,
        lastAttempt: Number(raw?.lastAttempt) || 0
      };
    } catch {
      return { posts: [], repliedComments: {}, seenComments: {}, lastAttempt: 0 };
    }
  }

  #write() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch (e) {
      console.warn('[qzone] 状态写入失败:', e?.message ?? e);
      return false;
    }
  }

  recent(days = 7, countedOnly = true) {
    const since = Date.now() - days * 86400000;
    return this.data.posts
      .filter((p) => Number(p?.ts) >= since && (!countedOnly || p?.counted !== false))
      .sort((a, b) => b.ts - a.ts);
  }

  /**
   * ★ 本机补丁 2026-10-17：最近 days 天用过的配图 URL 集合（用于"别配重复的图"）。
   *   含 forced（用户点名要发）的那几条 —— 它们同样占用了那张图。
   */
  recentImages(days = 7) {
    const set = new Set();
    for (const p of this.recent(days, false)) {
      const u = String(p?.image || '').trim();
      if (u) set.add(u);
    }
    return set;
  }

  recentTopics(n = 6) {
    return this.recent(30, false)
      .slice(0, n)
      .map((p) => String(p?.title || p?.content || '').slice(0, 40))
      .filter(Boolean);
  }

  canPost(o) {
    const cfg = o || {};
    const maxPerWeek = cfg.maxPerWeek != null ? cfg.maxPerWeek : 3;
    const minGapDays = cfg.minGapDays != null ? cfg.minGapDays : 2;
    const cooldownHours = cfg.cooldownHours != null ? cfg.cooldownHours : 18;

    const week = this.recent(7, true);
    const weekCount = week.length;
    const last = this.data.posts.filter((p) => p?.counted !== false).sort((a, b) => b.ts - a.ts)[0];

    const gates = [];
    if (weekCount >= maxPerWeek) {
      gates.push({ at: (week[week.length - 1]?.ts || 0) + 7 * 86400000, why: '本周已发满 ' + maxPerWeek + ' 条' });
    }
    if (last) {
      const gapAt = last.ts + minGapDays * 86400000;
      if (gapAt > Date.now()) gates.push({ at: gapAt, why: '距上次不足 ' + minGapDays + ' 天' });
      const coolAt = last.ts + cooldownHours * 3600000;
      if (coolAt > Date.now()) gates.push({ at: coolAt, why: '还在 ' + cooldownHours + ' 小时冷却里' });
    }

    if (!gates.length) return { allowed: true, weekCount, maxPerWeek, nextAllowedAt: null };
    const next = Math.max.apply(null, gates.map((g) => g.at));
    return { allowed: false, reason: gates.map((g) => g.why).join('；'), weekCount, maxPerWeek, nextAllowedAt: next };
  }

  recordPost(p) {
    const o = p || {};
    this.data.posts.push({
      ts: Date.now(),
      content: String(o.content || '').slice(0, 500),
      title: String(o.title || '').slice(0, 120),
      tid: o.tid != null ? String(o.tid) : null,
      source: String(o.source || ''),
      mood: String(o.mood || ''),
      // ★ 本机补丁 2026-10-17：**记下这条说说用的配图**。
      //   原来不记 → 没有任何"这张图最近用过"的依据 → 隔一两天又配同一张。
      image: String(o.image || ''),
      counted: o.counted !== false
    });
    if (this.data.posts.length > 200) this.data.posts = this.data.posts.slice(-200);
    return this.#write();
  }

  markAttempt() {
    this.data.lastAttempt = Date.now();
    return this.#write();
  }

  // ── 评论回复的「已读 / 已回」追踪 ──────────────────────────────────────

  #ck(postTid, commentTid) { return String(postTid) + ':' + String(commentTid); }

  hasReplied(postTid, commentTid) {
    return !!this.data.repliedComments[this.#ck(postTid, commentTid)];
  }

  wasSeen(postTid, commentTid) {
    return !!this.data.seenComments[this.#ck(postTid, commentTid)];
  }

  markReplied(postTid, commentTid, extra) {
    const key = this.#ck(postTid, commentTid);
    this.data.repliedComments[key] = Object.assign({ ts: Date.now() }, extra || {});
    delete this.data.seenComments[key];
    this.#pruneComments();
    return this.#write();
  }

  markSeen(list) {
    const now = Date.now();
    const arr = Array.isArray(list) ? list : [];
    for (const it of arr) {
      if (!it || !it.postTid || !it.commentTid) continue;
      const k = this.#ck(it.postTid, it.commentTid);
      if (!this.data.repliedComments[k]) this.data.seenComments[k] = { ts: now };
    }
    this.#pruneComments();
    return this.#write();
  }

  #pruneComments() {
    const cap = 1000;
    for (const key of ['repliedComments', 'seenComments']) {
      const table = this.data[key];
      const keys = Object.keys(table);
      if (keys.length <= cap) continue;
      keys
        .sort((a, b) => (Number(table[a]?.ts) || 0) - (Number(table[b]?.ts) || 0))
        .slice(0, keys.length - cap)
        .forEach((k) => { delete table[k]; });
    }
  }
}