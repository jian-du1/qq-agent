// 〔刷B站页签〕—— bili-observer-diary 插件的设置页（仿 dsh-bili-scroll）
//
// 为什么是顶层页签而不是设置分区：
//   这个页除了设置，还要放「扫码登录」的二维码、登录态、现在刷一轮 ——
//   都是需要实时刷新的交互，放在设置表单里会被整页重渲染打断。
//
// 数据流：
//   /api/skills          → 插件状态 + 掩码后的 settings
//   /api/config          → 保存后的非密文字段（补齐）
//   POST /api/config     → 保存 patch.skills['bili-observer-diary']
//   /api/skills/:id/action/:action → 插件 runAction（扫码/状态/刷一轮/重排）

'use strict';

function biliScrollSkill() {
  return (state.skills || []).find((s) => s.id === 'bili-observer-diary') || null;
}

async function refreshBiliScrollTab() {
  let skill = biliScrollSkill();
  if (!skill) {
    try {
      const d = await api('/api/skills');
      state.skills = d.skills || [];
      state.skillsSummary = d.summary || {};
      skill = biliScrollSkill();
    } catch { return; }
  }
  const on = !!(skill && skill.loaded && skill.enabled);
  const tab = document.getElementById('bili-observer-diary-tab');
  if (tab) tab.hidden = !on;
  if (!on && state.tab === 'bili-observer-diary') switchTab('settings');
}

function biliPageSettings() {
  const st = biliScrollSkill() || {};
  const fresh = (state.config?.skills || {})['bili-observer-diary'] || {};
  return { ...(st.settings || {}), ...fresh };
}

/* ── 人设选择 ─────────────────────────────────────────────────────────── */

// 人设模板平时由设置页 loadSettings 填进 state.personaTemplates；
// 直接打开「刷B站」时可能还没拉过，这里补一次（与设置页同一接口 / 同一套 id）。
async function ensureBiliPersonaTemplates() {
  if (Object.keys(state.personaTemplates || {}).length) return;
  try {
    const d = await api('/api/persona-templates');
    state.personaTemplates = {};
    for (const t of d.templates || []) {
      state.personaTemplates[t.id] = { name: t.name, text: t.text, builtin: !!t.builtin };
    }
  } catch { /* 拉不到就先只显示"跟随全局" */ }
}

function biliPersonaOptions(selectedId) {
  const sid = String(selectedId || '');
  const opts = ['<option value="">跟随全局人设</option>'];
  for (const [id, p] of Object.entries(state.personaTemplates || {})) {
    opts.push(`<option value="${esc(id)}"${id === sid ? ' selected' : ''}>${esc(p.name || id)}</option>`);
  }
  return opts.join('');
}

function biliGlobalPersonaName() {
  const roleText = String(state.config?.persona?.roleText || '');
  const hit = Object.values(state.personaTemplates || {}).find((p) => p.text === roleText);
  return hit?.name || '自定义';
}

/* ── 页面渲染 ─────────────────────────────────────────────────────────── */

function renderBiliScrollPage() {
  const v = biliPageSettings();
  const mode = String(v.scheduleMode || 'daily');
  const hasTemplates = Object.keys(state.personaTemplates || {}).length > 0;
  return `
  <div class="bili-wrap">
    <div class="bili-head">
      <div>
        <h2>刷B站</h2>
        <div class="muted">仿 dsh-bili-scroll：定时刷 B 站 → 挑值得的 → 评论区 <b>@ 主人</b> → 私信汇报；主人 @ 你时自动回一句</div>
      </div>
      <div class="bili-head-actions">
        <button class="btn btn-small" id="bili-save-btn">保存设置</button>
        <span class="muted" id="bili-save-msg"></span>
      </div>
    </div>

    <div class="bili-card" id="bili-login-card">
      <div class="bili-card-main">
        <div class="bili-card-title">B站账号</div>
        <div class="muted" id="bili-login-info">登录状态读取中…</div>
      </div>
      <div class="bili-card-actions">
        <button class="btn btn-small btn-primary" id="bili-login-btn">扫码登录</button>
        <button class="btn btn-small" id="bili-logout-btn" hidden>退出登录</button>
      </div>
    </div>
    <div class="bili-qr-box" id="bili-qr-box" hidden>
      <img id="bili-qr-img" alt="B站登录二维码" />
      <div class="muted" id="bili-qr-msg">用手机 B 站「扫一扫」扫描二维码；确认时选「记住我」</div>
    </div>

    <div class="bs-status" id="bs-status">正在读取状态…</div>
    <div class="bs-actions">
      <button class="btn btn-small btn-primary" id="bs-run">现在刷一轮</button>
      <button class="btn btn-small" id="bs-dry">演练一轮（不评论/不发）</button>
      <button class="btn btn-small" id="bs-check">刷新登录态</button>
      <button class="btn btn-small" id="bs-unblock">解除评论暂停</button>
      <button class="btn btn-small" id="bs-journal-now">现在发观察日志</button>
      <button class="btn btn-small" id="bs-mention-check">查一次B站@</button>
      <button class="btn btn-small" id="bs-pm-check">查一次B站私信</button>
      <button class="btn btn-small" id="bs-bilipm-test">测试B站私信</button>
      <span id="bs-action-msg" class="muted"></span>
    </div>

    <div id="bili-form">
      <div class="bs-subhead">人设</div>
      <div class="field"><label>刷B站用的人设</label>
        <select id="bs-persona"${hasTemplates ? '' : ' disabled'}>${biliPersonaOptions(v.personaId)}</select></div>
      <div class="hint">${hasTemplates
        ? `挑视频、写评论、回评论都用这个人设的语气；选「跟随全局人设」就跟着「设置 → 人设」走（现在是：<b>${esc(biliGlobalPersonaName())}</b>）。`
        : '人设列表没读出来（接口暂时不可用），这里先别改；刷新页面重试。'}</div>

      <div class="bs-subhead">什么时候刷</div>
      <div class="field-row">
        <div class="field"><label>什么时候刷</label>
          <select id="bs-mode">
            <option value="daily" ${mode === 'daily' ? 'selected' : ''}>每天固定时间</option>
            <option value="interval" ${mode === 'interval' ? 'selected' : ''}>随机间隔</option>
          </select></div>
        <div class="field"><label>每天几点（daily 模式）</label><input type="text" id="bs-daily" value="${esc(v.dailyAt || '20:00')}" placeholder="20:00" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>最短间隔（分钟）</label><input type="number" id="bs-min" value="${esc(v.minMinutes ?? 180)}" /></div>
        <div class="field"><label>最长间隔（分钟）</label><input type="number" id="bs-max" value="${esc(v.maxMinutes ?? 360)}" /></div>
        <div class="field"><label>静默时段</label><input type="text" id="bs-quiet" value="${esc(v.quietHours || '')}" placeholder="0-7" /></div>
      </div>
      <div class="field"><label>关注关键词（一行一个；留空 = 用热门 + 排行榜）</label>
        <textarea id="bs-keywords" class="persona-role-text" style="min-height:70px">${esc(v.keywords || '')}</textarea></div>
      <div class="field-row">
        <div class="field"><label>一轮最多看几个候选</label><input type="number" id="bs-cands" value="${esc(v.maxCandidates ?? 10)}" /></div>
        <div class="field"><label>一轮最多挑几个</label><input type="number" id="bs-picks" value="${esc(v.maxPicks ?? 2)}" /></div>
        <div class="field"><label>每天最多挑几个</label><input type="number" id="bs-perday" value="${esc(v.maxPerDay ?? 3)}" /></div>
        <div class="field"><label>最低播放量</label><input type="number" id="bs-minviews" value="${esc(v.minViews ?? 10000)}" /></div>
      </div>
      <div class="field"><label>最多看多久之前的视频（天，0 = 不限）</label>
        <input type="number" id="bs-maxagedays" value="${esc(v.maxAgeDays ?? 30)}" /></div>
      <div class="hint">只挑这个时间范围内发布的视频；搜索/热门/排行榜都会按发布时间过滤。默认 30 天。</div>

      <div class="bs-subhead">B站评论（需要先扫码登录）</div>
      <div class="checkbox-row"><input type="checkbox" id="bs-comment" ${v.commentEnabled !== false ? 'checked' : ''} />
        <label for="bs-comment">发 B 站评论并 @ 主人</label></div>
      <div class="field-row">
        <div class="field"><label>每轮最多发几条评论</label><input type="number" id="bs-commentmax" value="${esc(v.commentMax ?? 1)}" /></div>
        <div class="field"><label>评论里 @ 谁（B站昵称）</label><input type="text" id="bs-atname" value="${esc(v.atBiliName || '')}" placeholder="和 B 站显示的用户名一致" /></div>
      </div>
      <div class="hint">评论开头会自动拼「@昵称 」；同一视频只评论一次，每轮最多 5 条。这里填<b>主人</b>的 B 站昵称（不是扫码那个 AI 号的名字）；留空不评论，也认不出主人。没扫码登录时不会评论。</div>

      <div class="bs-subhead">B站评论区互动</div>
      <div class="checkbox-row"><input type="checkbox" id="bs-mention" ${v.mentionReply !== false ? 'checked' : ''} />
        <label for="bs-mention">主人在评论区 @ 我时，自动回一句</label></div>
      <div class="field-row">
        <div class="field"><label>多久查一次（分钟）</label><input type="number" id="bs-mentionpoll" value="${esc(v.mentionPollMinutes ?? 3)}" /></div>
        <div class="field"><label>每天最多回几条</label><input type="number" id="bs-mentionmax" value="${esc(v.mentionMaxPerDay ?? 10)}" /></div>
        <div class="field"><label>主人的 B 站 UID（可选）</label><input type="text" id="bs-ownermid" value="${esc(v.ownerBiliMid || '')}" placeholder="个人主页链接里的数字" /></div>
      </div>
      <div class="checkbox-row"><input type="checkbox" id="bs-mentionnotify" ${v.mentionNotify !== false ? 'checked' : ''} />
        <label for="bs-mentionnotify">回复后用 QQ 私信告诉我</label></div>
      <div class="hint">只认上面「评论里 @ 谁」填的主人 B 站昵称（填了 UID 就按 UID 认，更准）；<b>必须先扫码登录</b>。扫码登录的要是 <b>AI 自己的 B 站号</b>，主人用另一个 B 站号 @ 它才会触发；同一个号自己 @ 自己会被当成自己、不回复。回复前会先看这个视频的 AI 概要 / 字幕 / 热评；同一条评论只回一次，按人设口吻、一句话；主人回复你发过的评论也会接住。</div>
      <div class="checkbox-row"><input type="checkbox" id="bs-stranger" ${v.strangerReply !== false ? 'checked' : ''} />
        <label for="bs-stranger">陌生人的 @ / 回复我的评论，敷衍回一句（不透露隐私）</label></div>
      <div class="field-row">
        <div class="field"><label>陌生人评论每天最多回几条</label><input type="number" id="bs-strangermax" value="${esc(v.strangerMaxPerDay ?? 8)}" /></div>
        <div class="field"><label>同一陌生人冷却（分钟）</label><input type="number" id="bs-strangercooldown" value="${esc(v.strangerCooldownMinutes ?? 30)}" /></div>
      </div>

      <div class="bs-subhead">B站动态</div>
      <div class="checkbox-row"><input type="checkbox" id="bs-bilidyn" ${v.biliDynEnabled !== false ? 'checked' : ''} />
        <label for="bs-bilidyn">刷完把这一轮的感想发成一条 B站动态</label></div>
      <div class="hint">动态会自动附上这轮挑中的视频链接，B 站会把它显示成可点的 BV 卡片。</div>

      <div class="bs-subhead">B站观察日志</div>
      <div class="checkbox-row"><input type="checkbox" id="bs-journal" ${v.journalEnabled !== false ? 'checked' : ''} />
        <label for="bs-journal">每天定时发一条【b站观察日志Day N】</label></div>
      <div class="field-row">
        <div class="field"><label>每天几点发</label><input type="text" id="bs-journalat" value="${esc(v.journalAt || '23:00')}" placeholder="23:00" /></div>
      </div>
      <div class="hint">到点用当天刷到/评论/发过的内容写一篇日记动态；当天没内容就写一句安静的感想。Day N 按成功发布次数递增。</div>

      <div class="bs-subhead">私信汇报</div>
      <div class="checkbox-row"><input type="checkbox" id="bs-pm" ${v.pmEnabled !== false ? 'checked' : ''} />
        <label for="bs-pm">刷完把结果私信到 QQ</label></div>
      <div class="checkbox-row"><input type="checkbox" id="bs-bilipm" ${v.biliPmEnabled !== false ? 'checked' : ''} />
        <label for="bs-bilipm">同时用 B站私信发给主人（也要填上面的主人 B站 UID）</label></div>
      <div class="field-row">
        <div class="field"><label>私信发给谁</label><input type="text" id="bs-target" value="${esc(v.targetChat || '')}" placeholder="留空 = 主人私聊；group:群号 / private:QQ号" /></div>
        <div class="field"><label>发到群里时 @ 主人</label>
          <label class="switch" style="padding:0"><input type="checkbox" id="bs-atowner" ${v.atOwner ? 'checked' : ''} /><span class="track"><span class="thumb"></span></span></label></div>
      </div>

      <div class="bs-subhead">B站私信互动</div>
      <div class="checkbox-row"><input type="checkbox" id="bs-pmreply" ${v.pmReplyEnabled !== false ? 'checked' : ''} />
        <label for="bs-pmreply">回复 B站私信（主人正常聊、陌生人敷衍一句）</label></div>
      <div class="field-row">
        <div class="field"><label>多久查一次（分钟）</label><input type="number" id="bs-pmpoll" value="${esc(v.pmPollMinutes ?? 3)}" /></div>
        <div class="field"><label>每天最多回几条（总数）</label><input type="number" id="bs-pmmax" value="${esc(v.pmMaxPerDay ?? 10)}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>其中陌生人每天最多回几条</label><input type="number" id="bs-pmstrangermax" value="${esc(v.pmStrangerMaxPerDay ?? 5)}" /></div>
        <div class="field"><label>同一陌生人冷却（分钟）</label><input type="number" id="bs-pmcooldown" value="${esc(v.pmUserCooldownMinutes ?? 30)}" /></div>
      </div>
      <div class="hint">只回文字私信；陌生人只敷衍一句，不透露 QQ/隐私/账号/主人。需要扫码登录。</div>

      <div class="checkbox-row"><input type="checkbox" id="bs-report" ${v.writeReport !== false ? 'checked' : ''} />
        <label for="bs-report">写日报文件（data/bili-observer-diary/reports/）</label></div>
      <div class="checkbox-row"><input type="checkbox" id="bs-dryrun" ${v.dryRun ? 'checked' : ''} />
        <label for="bs-dryrun">演练模式（不评论、不回复、不发动态/私信、不发 QQ 消息）</label></div>
      <div class="hint" style="margin-top:8px">登录凭证只存在本机 <code>data/bili-observer-diary/credential.json</code>，不进配置、也不会回显。</div>
    </div>
  </div>`;
}

/* ── 保存 ─────────────────────────────────────────────────────────────── */

let biliSaveTimer = null;

function readBiliForm() {
  const form = document.getElementById('bili-form');
  if (!form) return null;
  const val = (id, dflt = '') => document.getElementById(id)?.value ?? dflt;
  const num = (id, dflt) => {
    const n = Number(document.getElementById(id)?.value);
    return Number.isFinite(n) ? n : dflt;
  };
  const chk = (id, dflt = false) => {
    const el = document.getElementById(id);
    return el ? !!el.checked : dflt;
  };
  const out = {
    personaId: (() => {
      const sel = document.getElementById('bs-persona');
      // 人设列表没读出来时下拉是禁用的，保留原值，别把用户选过的人设清空
      if (sel && sel.disabled) return String(biliPageSettings().personaId || '').trim();
      return String(sel?.value ?? '').trim();
    })(),
    scheduleMode: val('bs-mode', 'daily') === 'interval' ? 'interval' : 'daily',
    dailyAt: String(val('bs-daily', '20:00')).trim() || '20:00',
    minMinutes: num('bs-min', 180),
    maxMinutes: num('bs-max', 360),
    quietHours: String(val('bs-quiet', '')).trim(),
    keywords: String(val('bs-keywords', '')).trim(),
    maxCandidates: num('bs-cands', 10),
    maxPicks: num('bs-picks', 2),
    maxPerDay: num('bs-perday', 3),
    minViews: num('bs-minviews', 10000),
    maxAgeDays: num('bs-maxagedays', 30),
    commentEnabled: chk('bs-comment', true),
    commentMax: num('bs-commentmax', 1),
    atBiliName: String(val('bs-atname', '')).trim(),
    mentionReply: chk('bs-mention', true),
    strangerReply: chk('bs-stranger', true),
    strangerMaxPerDay: num('bs-strangermax', 8),
    strangerCooldownMinutes: num('bs-strangercooldown', 30),
    mentionPollMinutes: num('bs-mentionpoll', 3),
    mentionMaxPerDay: num('bs-mentionmax', 10),
    mentionNotify: chk('bs-mentionnotify', true),
    ownerBiliMid: String(val('bs-ownermid', '')).replace(/\D/g, ''),
    biliPmEnabled: chk('bs-bilipm', true),
    biliDynEnabled: chk('bs-bilidyn', true),
    journalEnabled: chk('bs-journal', true),
    journalAt: String(val('bs-journalat', '23:00')).trim() || '23:00',
    pmReplyEnabled: chk('bs-pmreply', true),
    pmPollMinutes: num('bs-pmpoll', 3),
    pmMaxPerDay: num('bs-pmmax', 10),
    pmStrangerMaxPerDay: num('bs-pmstrangermax', 5),
    pmUserCooldownMinutes: num('bs-pmcooldown', 30),
    pmEnabled: chk('bs-pm', true),
    targetChat: String(val('bs-target', '')).trim(),
    atOwner: chk('bs-atowner', false),
    writeReport: chk('bs-report', true),
    dryRun: chk('bs-dryrun', false)
  };
  // 旧版本把 B 站 Cookie 存在 config 里；改用扫码登录后，保存时顺手清掉旧明文
  if (Object.prototype.hasOwnProperty.call(biliPageSettings(), 'cookie')) out.cookie = '';
  return out;
}

async function saveBiliNow() {
  const s = readBiliForm();
  if (!s) return;
  const msg = document.getElementById('bili-save-msg');
  try {
    const res = await api('/api/config', { method: 'POST', body: JSON.stringify({ skills: { 'bili-observer-diary': s } }) });
    if (res?.config) state.config = res.config;
    const skill = biliScrollSkill();
    if (skill) skill.settings = { ...(skill.settings || {}), ...s };
    if (msg) msg.textContent = '已自动保存';
    biliAction('reschedule', {}).catch(() => {});
  } catch (e) {
    if (msg) msg.textContent = `保存失败：${e.message}`;
  }
}

function scheduleBiliSave() {
  if (biliSaveTimer) clearTimeout(biliSaveTimer);
  biliSaveTimer = setTimeout(() => { biliSaveTimer = null; saveBiliNow(); }, 700);
}

function flushBiliSave() {
  if (biliSaveTimer) {
    clearTimeout(biliSaveTimer);
    biliSaveTimer = null;
    saveBiliNow();
  }
}

/* ── 插件动作 ─────────────────────────────────────────────────────────── */

function biliAction(name, body) {
  return api(`/api/skills/bili-observer-diary/action/${name}`, {
    method: 'POST',
    body: JSON.stringify(body || {})
  });
}

function setBiliMsg(text) {
  const el = document.getElementById('bs-action-msg');
  if (el) el.textContent = text;
}

async function runBiliAction(name, body, label) {
  setBiliMsg(`${label}…`);
  try {
    const r = await biliAction(name, body);
    if (name === 'check') {
      setBiliMsg(r.loggedIn
        ? `已登录：${r.uname || '?'}${r.hasCsrf ? '' : '（缺少 bili_jct，发不了评论）'}`
        : `未登录：${r.reason || '请扫码登录'}`);
    } else if (name === 'mention') {
      if (r.skipped) setBiliMsg(`没查/没回：${r.reason || ''}`);
      else setBiliMsg(`查了 ${r.checked ?? 0} 条通知，新 @ ${r.newCount ?? 0} 条`
        + `${r.replied ? `，回了 ${r.replied} 条` : ''}${r.dryRun ? '（演练，没有真发）' : ''}`
        + `${r.errors?.length ? `（有 ${r.errors.length} 个接口报错）` : ''}`);
    } else if (name === 'pm') {
      if (r.skipped) setBiliMsg(`没查/没回：${r.reason || ''}`);
      else setBiliMsg(`查了 ${r.sessions ?? 0} 个会话，回了 ${r.replied ?? 0} 条私信`
        + `${r.strangerReplied ? `（陌生人 ${r.strangerReplied} 条）` : ''}${r.dryRun ? '（演练）' : ''}`);
    } else if (name === 'unblock') {
      setBiliMsg(r.ok ? '已解除评论暂停（账号仍被风控的话，评论还会被隐藏）' : `失败：${r.error || '未知原因'}`);
    } else if (name === 'journal') {
      if (r.skipped) setBiliMsg(`没发：${r.reason || ''}`);
      else if (r.ok) setBiliMsg(`已发观察日志 Day ${r.day}${r.dynId ? `（动态 ${r.dynId}）` : ''}`);
      else setBiliMsg(`观察日志失败：${r.error || '未知原因'}`);
    } else if (name === 'bili-pm-test') {
      setBiliMsg(r.ok
        ? `B站私信已发出${r.receiver ? `（UID ${r.receiver}）` : ''}，去 B 站「消息」看看`
        : `B站私信失败：${r.error || '未知原因'}`);
    } else if (r.ok === false) {
      setBiliMsg(`失败：${r.error || '未知原因'}`);
    } else if (r.skipped) {
      setBiliMsg(`跳过了：${r.reason || ''}`);
    } else {
      const c = (r.comments || []).filter((x) => x.ok).length;
      setBiliMsg(`挑了 ${(r.picks || []).length} 个${c ? `、B站评论 ${c} 条` : ''}${r.sent ? '，已私信' : ''}`);
    }
    await refreshBiliStatus();
  } catch (e) {
    setBiliMsg(`失败：${e.message}`);
  }
}

async function refreshBiliStatus() {
  const el = document.getElementById('bs-status');
  if (!el) return;
  try {
    const r = await biliAction('status', {});
    const s = r?.status || {};
    const lines = [];
    lines.push(`状态：${s.enabled ? '开着' : '关着'} · ${s.scheduleMode === 'daily'
      ? `每天 ${s.dailyAt}` : `每 ${s.minMinutes}~${s.maxMinutes} 分钟随机`}`
      + ` · 下次 ${s.nextAt ? new Date(s.nextAt).toLocaleString('zh-CN', { hour12: false }) : '—'}`);
    lines.push(`今日已挑 ${s.dayPicks ?? 0} / ${s.maxPerDay ?? '?'} · B站：${s.loggedIn ? `已登录（${s.uname || '?'}）` : '未登录'}`);
    lines.push(`人设：${s.personaName || '全局人设'}${s.personaSource === 'global' ? '（跟随全局）' : '（刷B站专用）'}`);
    if (s.lastResult?.keywords?.keywords) {
      const kw = s.lastResult.keywords;
      lines.push(`关键词：${kw.keywords} 个 · 上轮搜索命中 ${kw.matched} 条，入选 ${kw.picked} 条`);
    }
    if (s.memory) {
      lines.push(`B站记忆：刷过 ${s.memory.videos ?? 0} 个 / 评论 ${s.memory.comments ?? 0} 条 / 动态 ${s.memory.dynamics ?? 0} 条（跨人设共用）`);
    }
    if (s.mentionEnabled !== false) {
      const cap = s.mentionMaxPerDay === 0 ? '不限' : (s.mentionMaxPerDay ?? '?');
      lines.push(`B站@回复：开 · 今日 ${s.mentionDayCount ?? 0} / ${cap} · 每 ${s.mentionPollMinutes ?? 3} 分钟查一次`);
      const lm = s.lastMention;
      if (lm?.at) {
        lines.push(`最近回复：${new Date(lm.at).toLocaleString('zh-CN', { hour12: false })}`
          + ` · 主人「${String(lm.source || '只 @ 了你').slice(0, 24)}」→「${String(lm.reply || '').slice(0, 30)}」`);
      }
    } else {
      lines.push('B站@回复：关');
    }
    lines.push(`B站私信：${s.biliPmEnabled !== false ? '开' : '关'}`
      + `${s.biliPmReceiver ? `（发给 UID ${s.biliPmReceiver}）` : '（还没填主人 UID）'}`);
    if (s.lastResult?.biliPm && !s.lastResult.biliPm.skipped) {
      lines.push(`上次B站私信：${s.lastResult.biliPm.ok ? '成功' : `失败（${String(s.lastResult.biliPm.error || '').slice(0, 40)}）`}`);
    }
    lines.push(`B站动态：${s.biliDynEnabled !== false ? '开' : '关'}`
      + `${s.lastDynamic?.at ? ` · 最近 ${new Date(s.lastDynamic.at).toLocaleString('zh-CN', { hour12: false })}「${String(s.lastDynamic.text || '').slice(0, 18)}」` : ''}`);
    if (s.journalEnabled !== false) {
      const todayK = new Date().toLocaleDateString('sv-SE');
      const nextJ = s.nextJournalAt ? new Date(s.nextJournalAt).toLocaleString('zh-CN', { hour12: false }) : '—';
      lines.push(`观察日志：Day ${s.journalDay ?? 0} · 每天 ${s.journalAt || '23:00'} · 下次 ${nextJ}`
        + `${s.journalLastDate === todayK ? ' · 今天已发' : ''}`);
    } else {
      lines.push('观察日志：关');
    }
    lines.push(`B站私信回复：${s.pmReplyEnabled !== false ? '开' : '关'} · 今日 ${s.pmDayCount ?? 0} / ${s.pmMaxPerDay ?? '?'}`
      + `（陌生人 ${s.pmStrangerDayCount ?? 0} / ${s.pmStrangerMaxPerDay ?? '?'}）· 每 ${s.pmPollMinutes ?? 3} 分钟查一次`);
    lines.push(`陌生人评论：${s.strangerReply !== false ? '敷衍回' : '关'} · 今日 ${s.strangerDayCount ?? 0} / ${s.strangerMaxPerDay ?? '?'}`);
    if (Number(s.commentBlockedUntil) > Date.now()) {
      lines.push(`⚠️ B站评论：上次被隐藏，暂停评论到 ${new Date(s.commentBlockedUntil).toLocaleString('zh-CN', { hour12: false })}`);
    }
    if (s.lastRunAt) {
      const picks = (s.lastResult?.picks || []).map((p) => p.title).filter(Boolean).slice(0, 2).join('；');
      const cs = (s.lastResult?.comments || []).filter((x) => x.ok).length;
      lines.push(`上次：${new Date(s.lastRunAt).toLocaleString('zh-CN', { hour12: false })}`
        + `${picks ? ` · ${picks}` : ''}${cs ? ` · 评论 ${cs} 条` : ''}`);
    }
    if (!s.loggedIn && s.loginReason) lines.push(`登录提示：${s.loginReason}`);
    el.textContent = lines.join('\n');
    renderBiliLoginState(s);
  } catch (e) {
    el.textContent = `读取状态失败：${e.message}`;
  }
}

function renderBiliLoginState(s) {
  const info = document.getElementById('bili-login-info');
  const loginBtn = document.getElementById('bili-login-btn');
  const outBtn = document.getElementById('bili-logout-btn');
  if (!info) return;
  if (s.loggedIn) {
    info.textContent = `已登录：${s.uname || 'B站用户'}${s.mid ? `（mid ${s.mid}）` : ''}${s.hasCsrf ? '' : ' · 缺少 bili_jct，发不了评论'}`;
    if (loginBtn) loginBtn.hidden = true;
    if (outBtn) outBtn.hidden = false;
  } else {
    info.textContent = `未登录${s.loginReason ? `：${s.loginReason}` : ''} · 扫码登录后才能读字幕 / 发评论`;
    if (loginBtn) loginBtn.hidden = false;
    if (outBtn) outBtn.hidden = true;
  }
}

/* ── 扫码登录 ─────────────────────────────────────────────────────────── */

let biliPollTimer = null;

function stopBiliLoginPoll() {
  if (biliPollTimer) { clearInterval(biliPollTimer); biliPollTimer = null; }
}

async function startBiliLogin() {
  stopBiliLoginPoll();
  const box = document.getElementById('bili-qr-box');
  const img = document.getElementById('bili-qr-img');
  const msg = document.getElementById('bili-qr-msg');
  const info = document.getElementById('bili-login-info');
  if (info) info.textContent = '正在获取二维码…';
  try {
    const r = await biliAction('login-start', {});
    if (!r.ok || !r.image) throw new Error(r.error || '没拿到二维码');
    if (box) box.hidden = false;
    if (img) { img.src = r.image; img.hidden = false; }
    if (msg) msg.textContent = '用手机 B 站「扫一扫」扫描二维码；确认时选「记住我」（长期）';
    if (info) info.textContent = '等待扫码…';
    pollBiliLogin(r.key, r.expiresIn || 180);
  } catch (e) {
    if (info) info.textContent = `二维码获取失败：${e.message}`;
  }
}

function pollBiliLogin(key, expiresIn) {
  stopBiliLoginPoll();
  const deadline = Date.now() + expiresIn * 1000;
  biliPollTimer = setInterval(async () => {
    const img = document.getElementById('bili-qr-img');
    if (!img) { stopBiliLoginPoll(); return; }
    if (Date.now() > deadline) {
      stopBiliLoginPoll();
      const msg = document.getElementById('bili-qr-msg');
      if (msg) msg.textContent = '二维码已过期，请点「扫码登录」重新获取';
      return;
    }
    try {
      const r = await biliAction('login-poll', { key });
      const msg = document.getElementById('bili-qr-msg');
      if (r.state === 'ok') {
        stopBiliLoginPoll();
        if (msg) msg.textContent = `登录成功：${r.uname || ''}`;
        const box = document.getElementById('bili-qr-box');
        setTimeout(() => { if (box) box.hidden = true; }, 1500);
        refreshBiliStatus();
      } else if (r.state === 'scanned') {
        if (msg) msg.textContent = '已扫码，请在手机上点确认…';
      } else if (r.state === 'expired') {
        stopBiliLoginPoll();
        if (msg) msg.textContent = '二维码已过期，请重新获取';
      } else if (msg) {
        msg.textContent = '等待扫码…';
      }
    } catch (e) {
      stopBiliLoginPoll();
      const msg = document.getElementById('bili-qr-msg');
      if (msg) msg.textContent = `查询失败：${e.message}`;
    }
  }, 2000);
}

/* ── 绑定与载入 ───────────────────────────────────────────────────────── */

function bindBiliPage() {
  const form = document.getElementById('bili-form');
  if (!form) return;
  form.addEventListener('input', scheduleBiliSave);
  form.addEventListener('change', scheduleBiliSave);
  document.getElementById('bili-save-btn')?.addEventListener('click', () => {
    if (biliSaveTimer) { clearTimeout(biliSaveTimer); biliSaveTimer = null; }
    saveBiliNow();
  });

  document.getElementById('bs-run')?.addEventListener('click', async () => {
    if (!(await uiConfirm('现在刷一轮？\n会真的读 B 站；如果开了评论，会用你扫码登录的 B 站账号发评论并 @ 主人，然后私信你。'))) return;
    flushBiliSave();
    await new Promise((r) => setTimeout(r, 700));
    runBiliAction('scroll', { dry: false }, '正在刷');
  });
  document.getElementById('bs-dry')?.addEventListener('click', () => {
    flushBiliSave();
    setTimeout(() => runBiliAction('scroll', { dry: true }, '演练中'), 700);
  });
  document.getElementById('bs-check')?.addEventListener('click', () => runBiliAction('check', {}, '校验中'));
  document.getElementById('bs-unblock')?.addEventListener('click', () => runBiliAction('unblock', {}, '解除中'));
  document.getElementById('bs-journal-now')?.addEventListener('click', async () => {
    if (!(await uiConfirm('现在发一条【b站观察日志】动态？\n会用今天的刷B站记录写一篇日记。'))) return;
    flushBiliSave();
    setTimeout(() => runBiliAction('journal', {}, '写观察日志中'), 700);
  });
  document.getElementById('bs-mention-check')?.addEventListener('click', () => runBiliAction('mention', {}, '检查B站@中'));
  document.getElementById('bs-pm-check')?.addEventListener('click', () => runBiliAction('pm', {}, '检查B站私信中'));
  document.getElementById('bs-bilipm-test')?.addEventListener('click', () => runBiliAction('bili-pm-test', {}, '发B站私信中'));

  document.getElementById('bili-login-btn')?.addEventListener('click', startBiliLogin);
  document.getElementById('bili-logout-btn')?.addEventListener('click', async () => {
    if (!(await uiConfirm('退出 B 站登录？\n本机的登录凭证会被删除，字幕和评论都会停止工作。'))) return;
    try {
      await biliAction('login-out', {});
      const msg = document.getElementById('bili-qr-msg');
      if (msg) msg.textContent = '已退出登录';
      await refreshBiliStatus();
    } catch (e) {
      setBiliMsg(`退出失败：${e.message}`);
    }
  });
}

let biliPageLoading = false;

async function loadBiliScrollPage() {
  const page = document.getElementById('bili-observer-diary-page');
  if (!page || biliPageLoading) return;
  biliPageLoading = true;
  try {
    try { if (!state.config) state.config = await api('/api/config'); } catch { /* ignore */ }
    try {
      const d = await api('/api/skills');
      state.skills = d.skills || [];
      state.skillsSummary = d.summary || {};
    } catch { /* ignore */ }
    await ensureBiliPersonaTemplates();
    page.innerHTML = renderBiliScrollPage();
    bindBiliPage();
    refreshBiliStatus();
  } finally {
    biliPageLoading = false;
  }
}

// 兼容没有核心 switchTab 钩子的旧版本：自己监听页签点击来渲染页面。
// 新版核心也会调用 loadBiliScrollPage，biliPageLoading 会挡住重复渲染。
document.addEventListener('click', (ev) => {
  const tab = ev.target?.closest?.('.tab');
  if (!tab) return;
  if (tab.dataset?.tab === 'bili-observer-diary') setTimeout(() => loadBiliScrollPage(), 30);
  else stopBiliLoginPoll();
}, true);

// 启动后决定页签显隐（插件没装/停用就不出现）；之后每次切页签也会复核。
// 启动那几秒后端可能还没就绪，所以前 30 秒每 3 秒重试一次，成功/放弃后停。
let biliTabProbe = null;
let biliTabTries = 0;
function probeBiliTab() {
  biliTabTries += 1;
  refreshBiliScrollTab().catch(() => {}).finally(() => {
    const tab = document.getElementById('bili-observer-diary-tab');
    const settled = tab && tab.hidden === false;
    if (settled || biliTabTries >= 10) {
      if (biliTabProbe) { clearInterval(biliTabProbe); biliTabProbe = null; }
    }
  });
}
setTimeout(probeBiliTab, 600);
biliTabProbe = setInterval(probeBiliTab, 3000);
window.addEventListener('beforeunload', () => flushBiliSave());
