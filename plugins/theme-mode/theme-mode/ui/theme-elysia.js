/* ══════════════════════════════════════════════════════════════════════════

   爱莉希雅 · 粉色妖精主题 · 交互层（theme-elysia.js）

   ──────────────────────────────────────────────────────────────────────────

   全部是"只加不改"，不碰 ui/app/*.js 一行。

     1. 会话左栏按群号分组（可折叠）；存档 / 记忆保持平铺（每个群只有一个，分组无意义）

     2. 分组"打开 / 收起"时缎带从左往右淡入，铺在文字底下不遮字

     3. 再点一次已选中的项 = 退出（会话 / 存档 / 记忆 / 技能 / 插件都一样）

     4. 技能 / 插件右栏：名字 + 版本号小字 / 简介 / 设置直接写在下面；

        右上角徽章（点它启用/停用）+ 上传（放最右）

     5. 打开右侧内容时从底部弹出来（不是闪现）

     6. 左栏外壳：四角包边 + 底部「绶带 → 设置按钮（settings-frame 画框）」

     7. 静音应用写的占位提示（"← …" / "加载中…"），真实报错照旧显示

   ⚠️ 所有装饰都是**同步**跑在 MutationObserver 回调里的（回调里先 disconnect、改完再 observe）。

   之前用 setTimeout 延迟才套壳，那正是"交互时闪一下未修改画面"的原因。

   ══════════════════════════════════════════════════════════════════════════ */

(function () {

  'use strict';

  /* ══ 素材基址自适应 ══════════════════════════════════════════════════════

     本主题有两种安装布局，同一个包会被两种宿主安装：

       A. 「主题接口」独立主题包  →  ui/themes/elysia/ ，素材走 /themes/elysia/assets/
       B. 「主题模式」插件内置主题 →  ui/elysia/        ，素材走 /elysia/

     原先 CSS 与 JS 都把路径写死成其中一种，于是另一种布局下必然 404：
     左上角品牌图标（--art-brand）只剩一圈描边、里面空白，四角花纹、
     会话徽章、右侧立绘、系统壁纸也一起丢。这里启动时探测一次真实可用的
     基址，同时改写 5 个 CSS 变量和 JS 内部用到的路径。

     ══════════════════════════════════════════════════════════════════════ */

  const ASSET_BASES = ['/themes/elysia/assets/', '/elysia/'];

  const ART_FILES = {
    '--art-corner': 'corner.webp',
    '--art-shield': 'shield.webp',
    '--art-palace-night': 'palace-night.webp',
    '--art-palace-day': 'palace-day.webp',
    '--art-brand': 'brand-icon.webp'
  };

  /* 每个素材文件单独解析，不共用一个"目录探测结果"。
     原因：两种安装布局的素材并不总是成套出现 —— 比如插件布局下
     /elysia/ 有全套，而手工补过 /themes/elysia/assets/ 的机器可能只有
     5 张 CSS 变量图、没有 figure-right-anim.webp。共用一个基准会让立绘
     跟着品牌图一起走错目录。 */
  const assetResolved = Object.create(null);

  let assetBase = ASSET_BASES[0];

  function assetUrl(file) {
    return assetResolved[file] || (ASSET_BASES[0] + file);
  }

  function paintAssetVars() {
    const root = document.documentElement;
    for (const k of Object.keys(ART_FILES)) {
      root.style.setProperty(k, 'url("' + assetUrl(ART_FILES[k]) + '")');
    }
  }

  function probeOne(file, done) {
    if (Object.prototype.hasOwnProperty.call(assetResolved, file)) {
      if (done) done(assetResolved[file]);
      return;
    }
    let i = 0;
    const step = () => {
      if (i >= ASSET_BASES.length) {
        assetResolved[file] = ASSET_BASES[0] + file;
        if (done) done(assetResolved[file]);
        return;
      }
      const url = ASSET_BASES[i++] + file;
      const probe = new Image();
      probe.onload = () => {
        assetResolved[file] = url;
        if (done) done(url);
      };
      probe.onerror = step;
      probe.src = url;
    };
    step();
  }

  function probeAssetBase(done) {
    const files = Object.keys(ART_FILES).map((k) => ART_FILES[k]);
    if (files.indexOf('figure-right-anim.webp') < 0) files.push('figure-right-anim.webp');
    let left = files.length;
    const tick = () => {
      paintAssetVars();
      if (--left <= 0) {
        const brand = assetUrl('brand-icon.webp');
        assetBase = brand.slice(0, brand.length - 'brand-icon.webp'.length);
        if (done) done(assetBase);
      }
    };
    files.forEach((f) => probeOne(f, tick));
  }

  paintAssetVars();

  const $ = (sel, root) => (root || document).querySelector(sel);

  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* undefined = 还没选过（自动选第一个）；null = 用户主动点了"返回"（什么都不选） */

  const moduleSel = { skill: undefined, plugin: undefined };

  const collapsed = { session: new Set() };

  const railCollapsed = new Set();

  const paneOpen = { 'session-detail': false, 'chat-detail': false, 'memory-detail': false };

  /* 上一次的选中项：用来判断"选中项是否真的变了"，只在那时播一次淡入/淡出 */

  const lastSelKey = { chat: null, memory: null };

  const pendingFadeOut = { session: null, chat: null, memory: null };

  let decorating = false;

  function appState() {

    try { return typeof state !== 'undefined' ? state : null; } catch (e) { return null; }

  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function decorateExclusively(obs, target, opts, fn) {

    if (decorating) return;

    decorating = true;

    try {

      if (obs && target) obs.disconnect();

      try { fn(); } finally { if (obs && target) obs.observe(target, opts); }

    } finally {

      decorating = false;

    }

  }

  /* 每一步互相隔离：任何一步抛异常都不能拖垮其它步骤。

     （曾经因为一处异常让 bindObservers 后半段整段没执行 → 存档/记忆的观察器没注册。） */

  function guard(label, fn) {

    try {

      fn();

    } catch (e) {

      try { window.__maidErr = label + ': ' + (e && e.message ? e.message : String(e)); } catch (_) { /* 忽略 */ }

      try { console.warn('[elysia] ' + label + ' 失败：', e); } catch (_) { /* 忽略 */ }

    }

  }

  /* ══ 1. 会话左栏：按群号分组（可折叠） ═══════════════════════════════ */

  function chatKeyOfSession(sessionId) {

    const st = appState();

    if (!st || !Array.isArray(st.sessions)) return '';

    const s = st.sessions.find((x) => String(x.id) === String(sessionId));

    return s ? String(s.chatKey || '') : '';

  }

  function labelOfChatKey(key) {

    try {

      const name = typeof chatNameOf === 'function' ? chatNameOf(key) : '';

      if (typeof formatChatTitle === 'function') return formatChatTitle(key, name);

    } catch (e) { /* 忽略 */ }

    const m = /^group:(\d+)$/.exec(key);

    if (m) return '群 ' + m[1];

    const p = /^private:(\d+)$/.exec(key);

    if (p) return '私聊 ' + p[1];

    return key || '未知来源';

  }

  const SESSION_BOX = { boxId: 'session-items', itemSel: '.session-item' };

  function decorateSessionList() {

    const box = document.getElementById(SESSION_BOX.boxId);

    if (!box) return;

    const items = $$(SESSION_BOX.itemSel, box);

    if (!items.length) return;

    const groups = new Map();

    for (const el of items) {

      const key = chatKeyOfSession(el.dataset.id) || '__unknown__';

      if (!groups.has(key)) groups.set(key, []);

      groups.get(key).push(el);

    }

    /* 一次性建好整棵分组树再换入 —— 应用每次重绘都会重建列表（活跃会话时可达 12 次/秒），

       逐个 append 会造成多次样式/布局失效，用 fragment 只碰一次。 */

    const frag = document.createDocumentFragment();

    for (const [key, els] of groups) {

      const g = document.createElement('div');

      g.className = 'ely-group' + (collapsed.session.has(key) ? ' collapsed' : '');

      const head = document.createElement('button');

      head.type = 'button';

      head.className = 'ely-group-head';

      head.title = '点击收起 / 展开这个群';

      const nm = document.createElement('span');

      nm.className = 'ely-group-name';

      nm.textContent = labelOfChatKey(key);

      const ct = document.createElement('span');

      ct.className = 'ely-group-count';

      ct.textContent = els.length + ' 条';

      head.appendChild(nm);

      head.appendChild(ct);

      head.addEventListener('click', (e) => {

        e.preventDefault();

        e.stopPropagation();

        /* 收起 = 无缎带，展开 = 显示缎带；中间那段"从左往右淡入"由 CSS 过渡完成 */

        if (collapsed.session.has(key)) collapsed.session.delete(key);

        else collapsed.session.add(key);

        g.classList.toggle('collapsed');

        /* 展开时子页"弹出"（只在这一次挂类，应用重绘不会重放） */

        if (!g.classList.contains('collapsed')) {

          g.classList.remove('ely-pop');

          void g.offsetWidth;

          g.classList.add('ely-pop');

          setTimeout(() => g.classList.remove('ely-pop'), 820);

        }

      });

      const sub = document.createElement('div');

      sub.className = 'ely-group-list';

      for (const el of els) sub.appendChild(el);

      g.appendChild(head);

      g.appendChild(sub);

      frag.appendChild(g);

    }

    box.replaceChildren(frag);

    injectHitRate();

  }

  /* 命中率 = 缓存命中 token / 输入 token（与后端 llm.cacheHitRate 同公式）。

     数据来自全局 state.sessions（每条 summary 带 usage.cachedTokens/promptTokens）。 */

  function hitRateOf(s) {

    const u = s && s.usage;

    const p = Number(u && u.promptTokens) || 0;

    const c = Number(u && u.cachedTokens) || 0;

    if (!p) return null;

    return Math.min(1, Math.max(0, c / p));

  }

  function injectHitRate() {

    const box = document.getElementById(SESSION_BOX.boxId);

    if (!box) return;

    const app = appState();

    const byId = new Map();

    if (app && Array.isArray(app.sessions)) {

      for (const s of app.sessions) if (s && s.id) byId.set(s.id, s);

    }

    for (const el of $$(SESSION_BOX.itemSel, box)) {

      const rate = hitRateOf(byId.get(el.dataset.id));

      const meta = el.querySelector('.session-meta');

      if (!meta) continue;

      let hit = meta.querySelector('.ely-hit');

      if (rate == null) { if (hit) hit.remove(); continue; }

      const text = (rate * 100).toFixed(0) + '%';

      if (hit) { if (hit.textContent !== text) hit.textContent = text; continue; }

      const rounds = Array.from(meta.children).find((n) => /轮/.test(n.textContent || ''));

      if (!rounds) continue;

      hit = document.createElement('span');

      hit.className = 'ely-hit';

      hit.textContent = text;

      hit.title = '缓存命中率';

      rounds.after(hit);

    }

  }

  /* ══ 1.5 前方会话运行中 · 排队提示条 ══════════════════════════════════

     数据全部来自全局 state（无需后端改动）：

       running  = state.status.orchestrator.running（正在运行的 chat 数）

       waiting  = state.sessions 里 status === 'waiting' 的会话数（排队中）

     只有「有会话正在运行」时才显示；插在 session-items 之前（list-head 之下），

     应用重绘列表只动 session-items 内部，banner 挂在父容器不受影响。 */

  let queueBanner = null;

  function queueRunningCount() {

    const st = appState();

    if (!st) return 0;

    const o = st.status && st.status.orchestrator;

    return Array.isArray(o && o.running) ? o.running.length : 0;

  }

  function queueWaitingCount() {

    const st = appState();

    if (!st || !Array.isArray(st.sessions)) return 0;

    let n = 0;

    for (const s of st.sessions) if (s && s.status === 'waiting') n++;

    return n;

  }

  function updateQueueBanner() {

    const box = document.getElementById(SESSION_BOX.boxId);

    if (!box) return;

    const running = queueRunningCount();

    if (!running) {

      if (queueBanner && queueBanner.isConnected) queueBanner.remove();

      queueBanner = null;

      return;

    }

    if (!queueBanner || !queueBanner.isConnected) {

      queueBanner = document.createElement('div');

      queueBanner.className = 'ely-queue-banner';

      const dot = document.createElement('span');

      dot.className = 'ely-queue-dot';

      const tx = document.createElement('span');

      tx.className = 'ely-queue-text';

      queueBanner.appendChild(dot);

      queueBanner.appendChild(tx);

      box.parentNode.insertBefore(queueBanner, box);

    }

    const text = '前方会话运行中，已排队 ' + queueWaitingCount() + ' 条';

    const tx = queueBanner.querySelector('.ely-queue-text');

    if (tx.textContent !== text) tx.textContent = text;

  }

  /* 500ms 轻轮询：waiting/running 变化由后端推 state，轮询读到即刷新；不依赖重绘时机 */

  setInterval(updateQueueBanner, 500);

  /* ══ 1.6 会话详情 · Token / 成本统计 + 执行轨迹 ══════════════════════

     汇总数字全部来自 state.sessionDetail.usage（真实），成本用

     state.status.cost.prices 同公式复算（fresh*in + cached*cached + out*out）。

     执行轨迹取自应用已渲染的 .msg-flow .tool-flow 步骤；每步输出 token 按

     该步文本长度占 messages 总长的比例估算（标注 ≈，非精确值）。 */

  function elyCostYuan(usage, prices) {

    const p = Number(usage && usage.promptTokens) || 0;

    const c = Number(usage && usage.cachedTokens) || 0;

    const o = Number(usage && usage.completionTokens) || 0;

    const f = Math.max(0, p - c);

    const pi = Number(prices && prices.in) || 0;

    const pc = Number(prices && prices.cached) || 0;

    const po = Number(prices && prices.out) || 0;

    return (f * pi + c * pc + o * po) / 1e6;

  }

  function fmtTok(n) {

    n = Number(n) || 0;

    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';

    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';

    return String(n);

  }

  function fmtDur(ms) {

    if (ms == null || isNaN(Number(ms))) return null;

    ms = Number(ms);

    if (ms < 1000) return (ms / 1000).toFixed(1) + ' 秒';

    const s = ms / 1000;

    const h = Math.floor(s / 3600);

    const m = Math.floor((s % 3600) / 60);

    const sec = Math.round(s % 60);

    if (h > 0) return h + '时' + m + '分' + sec + '秒';

    if (m > 0) return m + '分' + sec + '秒';

    return (Math.round(s * 10) / 10) + ' 秒';

  }

  function fmtClock(dt) {

    try {

      const d = dt instanceof Date ? dt : new Date(dt);

      if (isNaN(d.getTime())) return '—';

      const p = (x) => String(x).padStart(2, '0');

      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());

    } catch (e) { return '—'; }

  }

  function isDrawCall(c) {

    const n = String(c && c.name || '');

    if (/^(get|fetch|download|read|view|load|ocr|probe|query)[_ ]/i.test(n)) return false;

    const a = (c && c.args) || {};

    return /image|gen|draw|seedream|画图|生图|绘图|edit/i.test(n) || !!(a.model || a.provider || a.provider_id);

  }

  /* 绘图模式：有参考图或 image_edit → 图生图；其余 → 文生图 */
  function drawModeOf(c) {
    const n = String((c && c.name) || '');
    if (/image_edit/i.test(n)) return 'image';
    if (/image_gen/i.test(n)) return 'text';
    const a = (c && c.args) || {};
    const ref = a.image_reference_url_list || a.images || a.reference || a.ref || a.reference_url || a.image_urls;
    if (ref) {
      if (Array.isArray(ref) ? ref.length : String(ref).trim()) return 'image';
    }

    return 'text';
  }

  /* 生图模型名：优先用价格表里配置的 model；否则取工具参数 */
  function drawModelOf(prices, c) {
    const pt = priceTableOf(prices, drawModeOf(c));
    if (pt && pt.model) return String(pt.model);
    const a = (c && c.args) || {};
    return String(a.model || a.provider || a.provider_id || a.provider_name || '未知绘图 AI');
  }

  /* 绘图价格显示开关：默认显示；localStorage elysia-draw-show = '0' 时关闭（总价与轨迹/明细卡不计绘图费用） */
  function showDrawOf() {
    try { return localStorage.getItem('elysia-draw-show') !== '0'; } catch (e) { return true; }
  }

  function stepTokFee(inTok, outTok, cachedRatio, prices) {

    if (!prices) return null;

    const inCached = Math.round(inTok * cachedRatio);

    const inFresh = inTok - inCached;

    return (inFresh * prices.in + inCached * prices.cached + outTok * prices.out) / 1e6;

  }

  function statCell(label, value) {

    const d = document.createElement('div');

    d.className = 'ely-stat-cell';

    const l = document.createElement('span');

    l.className = 'ely-stat-label';

    l.textContent = label;

    const v = document.createElement('span');

    v.className = 'ely-stat-value';

    v.textContent = value;

    d.appendChild(l);

    d.appendChild(v);

    return d;

  }

  function decorateSessionDetail() {

    const el = document.getElementById('session-detail');

    if (!el) return;

    const st = appState();

    const d = st && st.sessionDetail;

    const header = el.querySelector('.detail-header');

    const mf = el.querySelector('.msg-flow');

    /* 幂等：清掉旧注入再重建 */

    for (const k of ['ely-stat-card', 'ely-trace-card', 'ely-tool-card']) {

      const old = el.querySelector('.' + k);

      if (old) old.remove();

    }

    /* 0) 头部 sub：删除「模型 / N 次调用 · tok 入出总 / N 轮工具 / 联网搜索 N 次」冗余行（保留 触发 / 开始·结束） */

    if (header) {

      const sub = header.querySelector('.sub');

      if (sub) {

        for (const sp of Array.from(sub.children)) {

          const tx = (sp.textContent || '').replace(/\s+/g, ' ').trim();

          if (!tx) continue;

          if (/\d+ 次调用/.test(tx) || /轮工具/.test(tx) || /联网搜索/.test(tx) || /^模型\s/.test(tx)) sp.remove();

        }

      }

    }

    if (!header || !d || !mf) return;

    const u = d.usage || {};

    const prices = (st.status && st.status.cost && st.status.cost.prices) || null;

    const fresh = Math.max(0, (u.promptTokens || 0) - (u.cachedTokens || 0));

    const costYuan = prices

      ? (fresh * prices.in + (u.cachedTokens || 0) * prices.cached + (u.completionTokens || 0) * prices.out) / 1e6

      : null;

    const hit = u.promptTokens ? Math.round((u.cachedTokens || 0) / u.promptTokens * 100) : 0;

    const sub = header.querySelector('.sub');

    /* 工具调用序列（来自 messages，天然按执行顺序；同一工具多次调用各占一条） */

    const calls = [];

    for (const m of (Array.isArray(d.messages) ? d.messages : [])) {

      if (m && m.toolCall) calls.push(m.toolCall);

    }

    /* 绘图费用合计（用于两张卡的头部总费用：总花费 = tok 成本 + 绘图费用） */

    let drawTotal = 0;

    {

      let dp0 = {};

      try { dp0 = JSON.parse(localStorage.getItem('elysia-draw-prices') || '{}') || {}; } catch (e) { dp0 = {}; }

      for (const c of calls) {

        const a0 = c.args || {};

        if (!isDrawCall(c)) continue;

        const ai0 = drawModelOf(dp0, c);

        const cnt0 = Math.max(1, Number(a0.count || a0.n || 1) || 1);

        const unit0 = drawUnitOf(dp0, ai0, sizeTierOf(a0.size), drawModeOf(c));

        if (showDrawOf() && unit0 != null) drawTotal += unit0 * cnt0;

      }

    }
    const cells = [

      ['总 Tok 数', fmtTok(u.totalTokens)],

      ['输入 Tok', fmtTok(u.promptTokens)],

      ['缓存 Tok', fmtTok(u.cachedTokens)],

      ['未缓存 Tok', fmtTok(fresh)],

      ['缓存命中率', hit + '%'],

      ['输出 Tok', fmtTok(u.completionTokens)],

      ['推理 Tok', fmtTok(u.extra && u.extra.reasoningTokens)],

      ['调用次数', (u.calls || 0) + ' 次'],

      ['会话轮次', (d.rounds || 0) + ' 轮'],

      ['工具轮次', (d.rounds || 0) + ' 轮'],

      ['联网次数', (Number(d.webSearchCount) || 0) + ' 次'],

      ['预估成本', costYuan != null ? '¥' + (costYuan + drawTotal).toFixed(4) + (drawTotal > 0 ? '（含绘图 ¥' + drawTotal.toFixed(4) + '）' : '') : '—']

    ];

    const card = document.createElement('div');

    card.className = 'ely-stat-card';

    card.innerHTML = '<div class="ely-stat-title">本次会话统计<span class="ely-stat-sub">· ' + esc(d.model || '-') + ' · ' + (u.calls || 0) + ' 次调用</span></div>'

      + '<div class="ely-stat-grid">'

      + cells.map((c) => '<div class="ely-stat-cell"><div class="ely-stat-label">' + c[0] + '</div><div class="ely-stat-value">' + c[1] + '</div></div>').join('')

      + '</div>';

    (sub ? sub : header).after(card);

    /* 1) 执行轨迹卡：每步标注时间（时分秒）+ 耗时 + tok 估算 + 费用估算；头部合计总用时/总 Tok/约花费（含绘图） */

    if (el) {

      const domSteps = Array.from((mf || el).querySelectorAll('.tool-flow'));

      const trace = document.createElement('div');

      trace.className = 'ely-trace-card';

      const traceRows = [];

      let ci = 0;

      const promptTokT = u.promptTokens || 0;

      const compTokT = u.completionTokens || 0;

      const cachedRatioT = promptTokT ? (u.cachedTokens || 0) / promptTokT : 0;

      const totalArgsLenT = calls.reduce((s, c) => s + (c.args ? JSON.stringify(c.args).length : 0), 0) || 1;

      const totalResLenT = calls.reduce((s, c) => s + (c.result ? String(c.result).length : 0), 0) || 1;

      /* 思考步信息：推理 tok 按思考步数均分；用时按会话总时长 × 推理占比估算（无精确记录）；费用按输出价估算 */

      const thinkCount = domSteps.filter(s => s.classList.contains('think-flow')).length;

      const reasoningTok = (u.extra && u.extra.reasoningTokens) || 0;

      let sessionDurMs = null;

      let startClock = null;

      {

        const subH = header.querySelector('.sub');

        const txH = subH ? (subH.textContent || '') : '';

        const m = txH.match(/开始\s*(\d{1,2}):(\d{2}):(\d{2})[\s\S]*?结束\s*(\d{1,2}):(\d{2}):(\d{2})/);

        if (m) {

          sessionDurMs = Math.max(0, ((+m.at(4)) * 3600 + (+m.at(5)) * 60 + (+m.at(6)) - ((+m.at(1)) * 3600 + (+m.at(2)) * 60 + (+m.at(3)))) * 1000);

          startClock = String(m.at(1)).padStart(2, '0') + ':' + m.at(2) + ':' + m.at(3);

        }

      }

      /* 思考汇总（头部总计用）：费用按输出价估算、用时按会话时长 × 推理占比估算 */

      const thinkFeeR = reasoningTok > 0 && prices ? reasoningTok * prices.out / 1e6 : 0;

      const thinkDurEst = reasoningTok > 0 && sessionDurMs != null ? sessionDurMs * reasoningTok / (u.totalTokens || 1) : 0;

      /* 无独立思考块但有推理 tok 时，在轨迹顶部合成一条「深度思考」汇总步 */

      if (reasoningTok > 0 && thinkCount === 0) {

        const feeR = prices ? reasoningTok * prices.out / 1e6 : null;

        const durEst = sessionDurMs != null ? sessionDurMs * reasoningTok / (u.totalTokens || 1) : null;

        const mp = [];

        if (startClock) mp.push(startClock);

        mp.push('推理≈' + fmtTok(reasoningTok) + ' tok');

        if (feeR != null) mp.push('费用≈¥' + feeR.toFixed(4));

        traceRows.unshift('<div class="ely-trace-step"><span class="ely-trace-no">01</span>'

          + '<span class="ely-trace-text">🧠 深度思考（不发送）</span>'

          + '<span class="ely-trace-dur">' + (durEst != null ? ' · ' + fmtDur(durEst) : '') + '</span></div>'

          + (mp.length ? '<div class="ely-trace-meta">' + esc(mp.join(' · ')) + '</div>' : ''));

      }

      for (const stepEl of domSteps) {

        const sum = stepEl.querySelector('summary');

        if (!sum) continue;

        const ico = sum.querySelector('.tool-ico');

        const nameEl = sum.querySelector('.tool-name-flow');

        const labelEl = sum.querySelector('.tool-label');

        const badge = sum.querySelector('.badge');

        const nameTxt = nameEl ? (nameEl.textContent || '').trim() : '';

        const labelTxt = labelEl ? (labelEl.textContent || '').trim() : '';

        const isThink = stepEl.classList.contains('think-flow') || nameTxt === '思考';

        const isSent = stepEl.classList.contains('sent-flow') || nameTxt === '已发送到 QQ';

        const isFinish = stepEl.classList.contains('finish-flow') || nameTxt === 'finish';

        const isTool = !isThink && !isSent && !isFinish;

        let durTxt = '', metaTxt = '';

        if (isTool && ci < calls.length) {

          const c = calls[ci++];

          const inTok = Math.round(promptTokT * JSON.stringify(c.args || {}).length / totalArgsLenT);

          const outTok = Math.round(compTokT * (c.result ? String(c.result).length : 0) / totalResLenT);

          const fee = prices ? stepTokFee(inTok, outTok, cachedRatioT, prices) : null;

          durTxt = ' · ' + (c.ms != null ? fmtDur(c.ms) : '—');

          const clockTxt = c.at ? fmtClock(new Date(c.at)) : null;

          let feeTxt = fee != null ? '费用≈¥' + fee.toFixed(4) : '费用 —';

          const isDrawS = isDrawCall(c);

          if (isDrawS && showDrawOf()) {

            const a1 = c.args || {};

            const dp1 = (() => { try { return JSON.parse(localStorage.getItem('elysia-draw-prices') || '{}') || {}; } catch (e) { return {}; } })();

            const ai1 = drawModelOf(dp1, c);

            const cnt1 = Math.max(1, Number(a1.count || a1.n || 1) || 1);

            const unit1 = drawUnitOf(dp1, ai1, sizeTierOf(a1.size), drawModeOf(c));

            if (unit1 != null) {

              const dc = unit1 * cnt1;

              feeTxt = fee != null ? ('费用≈¥' + (fee + dc).toFixed(4) + '（tok ¥' + fee.toFixed(4) + ' + 绘图 ¥' + dc.toFixed(4) + '）') : ('费用≈¥' + dc.toFixed(4) + '（绘图）');

            }
            else {
              feeTxt = fee != null ? ('费用≈¥' + fee.toFixed(4) + '（tok ¥' + fee.toFixed(4) + ' + 绘图 ¥？？？）') : '绘图 ¥？？？';
            }

          }

          metaTxt = (clockTxt ? clockTxt + ' · ' : '') + '输入≈' + fmtTok(inTok) + '/输出≈' + fmtTok(outTok) + ' tok · ' + feeTxt;

        } else if (isThink && thinkCount) {

          const stepReason = Math.round(reasoningTok / thinkCount);

          if (stepReason > 0) {

            const feeR = prices ? stepReason * prices.out / 1e6 : null;

            const durEst = sessionDurMs != null ? sessionDurMs * stepReason / (u.totalTokens || 1) : null;

            const parts = [];

            if (startClock) parts.push(startClock);

            parts.push('推理≈' + fmtTok(stepReason) + ' tok');

            if (feeR != null) parts.push('费用≈¥' + feeR.toFixed(4));

            metaTxt = parts.join(' · ');

            if (durEst != null) durTxt = ' · ' + fmtDur(durEst);

          }

        }

        const subTxt = badge ? ' ' + badge.textContent.trim() : (isSent ? '' : '');

        traceRows.push('<div class="ely-trace-step"><span class="ely-trace-no">' + String(traceRows.length + 1).padStart(2, '0') + '</span>'

          + '<span class="ely-trace-text">' + esc((ico ? ico.textContent + ' ' : '') + nameTxt + (labelTxt ? ' ' + labelTxt : '') + subTxt) + '</span>'

          + '<span class="ely-trace-dur">' + esc(durTxt) + '</span></div>'

          + (metaTxt ? '<div class="ely-trace-meta">' + esc(metaTxt) + '</div>' : ''));

      }

      if (traceRows.length) {

        const msSumT = calls.reduce((s, c) => s + (c.ms != null ? Number(c.ms) : 0), 0) + thinkDurEst;
        const thinkNoteTok = reasoningTok > 0 ? '（思考 +' + fmtTok(reasoningTok) + ' tok）' : '';
        const thinkNoteFee = reasoningTok > 0 ? '（思考 +¥' + thinkFeeR.toFixed(4) + '）' : '';
        const totTxt = '· 总用时 ' + (msSumT ? fmtDur(msSumT) : '—')
          + ' · 总 Tok ' + fmtTok(u.totalTokens) + thinkNoteTok
          + ' · 约 ¥' + (costYuan != null ? (costYuan + drawTotal).toFixed(4) : '—') + thinkNoteFee
          + (drawTotal > 0 ? '（含绘图 ¥' + drawTotal.toFixed(4) + '）' : '');

        trace.innerHTML = '<div class="ely-stat-title">执行轨迹（' + traceRows.length + ' 步）<span class="ely-card-total">' + esc(totTxt) + '</span></div>' + traceRows.join('');

        card.after(trace);

      }

    }

    /* 2) 调用工具卡：每次工具调用一条明细（时间/耗时/输入输出 tok 估算/tok费用，绘图工具加「tok费用 + 绘图费用 = 总费用」/参数/结果） */

    if (calls.length) {

      const tcard = document.createElement('div');

      tcard.className = 'ely-tool-card';

      /* 工具输入/输出 token 估算：按参数字符/结果字符在总字符里的占比 × 会话输入/输出 tok（与执行轨迹卡同口径，标注 ≈） */

      const promptTok = u.promptTokens || 0;

      const compTok = u.completionTokens || 0;

      const cachedRatio = promptTok ? (u.cachedTokens || 0) / promptTok : 0;

      const totalArgsLen = calls.reduce((s, c) => s + (c.args ? JSON.stringify(c.args).length : 0), 0) || 1;

      const totalResLen = calls.reduce((s, c) => s + (c.result ? String(c.result).length : 0), 0) || 1;

      /* 绘图价格表：localStorage「elysia-draw-prices」= { 模型名: 元/张 } */

      let drawPrices = {};

      try { drawPrices = JSON.parse(localStorage.getItem('elysia-draw-prices') || '{}') || {}; } catch (e) { drawPrices = {}; }

      const rows = calls.map((c, i) => {

        const name = c.name || '未知工具';

        const ok = !c.isError;

        const durTxt = c.ms != null ? fmtDur(c.ms) : '—';

        const atTxt = c.at ? fmtClock(new Date(c.at)) : '无记录';

        const args = c.args || {};

        const argsLen = JSON.stringify(args).length;

        const resLen = c.result ? String(c.result).length : 0;

        const inTok = Math.round(promptTok * argsLen / totalArgsLen);

        const outTok = Math.round(compTok * resLen / totalResLen);

        const fee = prices ? stepTokFee(inTok, outTok, cachedRatio, prices) : null;

        const feeTxt = fee != null ? '费用 ≈ ¥' + fee.toFixed(4) : '费用 —';

        const isDraw = isDrawCall(c);

        let drawLine = '', totalLine = '';

        if (isDraw && showDrawOf()) {

          const ai = drawModelOf(drawPrices, c);

          const cnt = Math.max(1, Number(args.count || args.n || 1) || 1);

          const tier = sizeTierOf(args.size);

          const unit = drawUnitOf(drawPrices, ai, tier);

          if (unit != null) {

            const drawCost = unit * cnt;

            drawLine = '<div class="ely-tool-meta">🎨 绘图 AI：' + esc(ai) + '（' + esc(tier) + ' 档） · 费用 ¥' + drawCost.toFixed(4) + '（' + unit + ' 元/张 × ' + cnt + ' 张）</div>';

            totalLine = '<div class="ely-tool-fee-total">合计 ≈ ¥' + (fee != null ? (fee + drawCost).toFixed(4) : drawCost.toFixed(4))

              + ' ＝ ¥' + (fee != null ? fee.toFixed(4) : '—') + '（tok）＋ ¥' + drawCost.toFixed(4) + '（绘图）</div>';

          } else {
            drawLine = '<div class="ely-tool-meta">🎨 绘图 AI：' + esc(ai) + '（' + esc(tier) + ' 档） · 绘图价格未设置 ¥？？？ · <a href="javascript:void(0)" class="ely-price-link">点此设置</a></div>';
            if (fee != null) totalLine = '<div class="ely-tool-fee-total">合计 ≈ ¥' + fee.toFixed(4) + '（tok）＋ 绘图 ¥？？？</div>';
          }

        }

        const resultTxt = String(c.result || '（无返回内容）').slice(0, 120);

        return '<div class="ely-tool-row">'

          + '<div class="ely-tool-head">' + esc('#' + (i + 1) + ' ' + name)

          + '<span class="ely-tool-status ' + (ok ? 'ok' : 'err') + '">' + (ok ? '成功' : '失败') + '</span>'

          + '<span class="ely-tool-dur">' + esc(durTxt) + '</span></div>'

          + '<div class="ely-tool-meta">时间 ' + esc(atTxt)

          + ' · 输入 ≈ ' + fmtTok(inTok) + ' / 输出 ≈ ' + fmtTok(outTok) + ' tok · ' + feeTxt + '</div>'

          + drawLine + totalLine

          + '<div class="ely-tool-args">参数 ' + esc(JSON.stringify(args).slice(0, 160)) + '</div>'

          + '<div class="ely-tool-result">结果 ' + esc(resultTxt) + ' <span class="ely-tool-len">（' + resLen + ' 字）</span></div>'

          + '</div>';

      }).join('');

      const priceBtn = '<button type="button" class="ely-price-btn" title="设置各绘图 AI 的单价（元/张），工具卡自动计算费用">⚙ 绘图价格设置</button>';

      const msSum = calls.reduce((s, c) => s + (c.ms != null ? Number(c.ms) : 0), 0);

      const totTxt = '· 总用时 ' + (msSum ? fmtDur(msSum) : '—')

        + ' · 总 Tok ' + fmtTok(u.totalTokens)

        + ' · 约 ¥' + (costYuan != null ? (costYuan + drawTotal).toFixed(4) : '—')

        + (drawTotal > 0 ? '（含绘图 ¥' + drawTotal.toFixed(4) + '）' : '');

      tcard.innerHTML = '<div class="ely-stat-title">调用工具明细（' + calls.length + ' 次）<span class="ely-card-total">' + esc(totTxt) + '</span>'

        + priceBtn + '</div>' + rows;

      const traceEl = el.querySelector('.ely-trace-card');

      (traceEl ? traceEl : card).after(tcard);

      const pb = tcard.querySelector('.ely-price-btn');

      if (pb) pb.addEventListener('click', () => openDrawPriceModal());

      for (const a of tcard.querySelectorAll('.ely-price-link')) {

        a.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); openDrawPriceModal(); });

      }

    }

    /* 工具条目美化：只加类，不改应用结构 */

    for (const tf of (mf || el).querySelectorAll('.tool-flow')) {

      if (!tf.classList.contains('ely-tool-decorated')) tf.classList.add('ely-tool-decorated');

    }

  }

  /* 绘图价格档位：由尺寸长边判断（>=4096→4k，>=2048→2k，否则默认） */

  function sizeTierOf(size) {

    const s = String(size || '').toLowerCase();

    let longEdge = 0;

    const m = s.match(/(\d+)\s*x\s*(\d+)/);

    if (m) longEdge = Math.max(Number(m[1]), Number(m[2]));

    else {

      const n = Number(s);

      if (!isNaN(n) && n > 0) longEdge = n;

    }

    if (longEdge >= 4096) return '4k';

    if (longEdge >= 2048) return '2k';

    return '默认';

  }

  /* 价格表：新结构 { text:{默认,2k,4k}, image:{默认,2k,4k} }；兼容旧结构 { 模型名:{档位:单价} }（当作文生图） */
  function priceTableOf(prices, mode) {
    if (!prices || typeof prices !== 'object') return null;
    let t = prices[mode === 'image' ? 'image' : 'text'];
    if (t && typeof t === 'object') return t;
    if (mode === 'image') {
      const t2 = prices.text;
      if (t2 && typeof t2 === 'object') return t2;
    }
    for (const k of Object.keys(prices)) {
      if (k === 'text' || k === 'image' || k === 'model') continue;
      const v = prices[k];
      if (v && typeof v === 'object') return v;
    }
    return null;
  }

  /* 取某绘图 AI 在指定档位的单价；先精确档，无则回落默认档，再无返回 null（未设置 → 界面显示 ¥？？？） */
  function drawUnitOf(prices, ai, tier, mode) {
    const entry = priceTableOf(prices, mode);
    if (!entry) return null;
    if (tier !== '默认' && entry[tier] != null && Number(entry[tier]) > 0) return Number(entry[tier]);
    if (entry['默认'] != null) return Number(entry['默认']);
    return null;
  }

  /* 绘图价格设置弹窗：模型名 + 档位（默认/2k/4k…，留空=默认）+ 单价（元/张），保存到 localStorage */

  function openDrawPriceModal() {
    const KEY = 'elysia-draw-prices';
    let prices = {};
    try { prices = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { prices = {}; }
    if (!prices.text && !prices.image) {
      for (const k of Object.keys(prices)) {
        if (k === 'model') continue;
        const v = prices[k];
        if (v && typeof v === 'object') { prices = { text: v }; break; }
      }
    }
    const old = document.getElementById('ely-price-modal');
    if (old) old.remove();
    const modal = document.createElement('div');
    modal.id = 'ely-price-modal';
    modal.className = 'ely-price-modal';
    const t0 = prices.text || {};
    const i0 = prices.image || {};
    const val = (o, k) => (o[k] != null ? String(o[k]) : '');
    const sumHtml = (o, label) => {
      let s = '';
      for (const k of Object.keys(o)) {
        if (o[k] == null) continue;
        if (o[k] === 0 && k !== '默认') continue;
        if (k === 'model') { s += '<span>模型:' + esc(String(o[k])) + '</span>'; continue; }
        s += '<span>' + esc(k) + ':¥' + esc(String(o[k])) + '</span>';
      }
      return s ? '<div class="ely-price-sum">' + label + '：' + s + '</div>' : '';
    };
    modal.innerHTML = '<div class="ely-price-box">'
      + '<div class="ely-price-title">绘图价格设置</div>'
      + '<div class="ely-price-tip">价格全局共用（所有聊天一致）。文生图 / 图生图分开设置；图生图未设置时默认按文生图价格；2k/4k 档填 0 表示沿用默认档价格；都没设置时工具照常运行，费用显示 ¥？？？。</div>'
      + '<div class="ely-price-row"><label class="ely-price-check"><input type="checkbox" id="ely-pm-show-draw"' + (showDrawOf() ? ' checked' : '') + ' /> 显示绘图价格（预估成本与工具明细总价计入绘图费用）</label></div>'
      + '<div class="ely-price-group"><div class="ely-price-gtitle">🎨 文生图（text-to-image）</div><div class="ely-price-row">生图模型 <input id="ely-pm-text-model" type="text" value="' + esc(val(t0, 'model')) + '" placeholder="如 seedream 5.0" /></div>'
      + '<div class="ely-price-row">默认档 <input id="ely-pm-text-default" type="number" min="0" step="0.0001" value="' + esc(val(t0, '默认')) + '" placeholder="元/张" />'
      + '2k <input id="ely-pm-text-2k" type="number" min="0" step="0.0001" value="' + esc(val(t0, '2k')) + '" placeholder="0=默认价" />'
      + '4k <input id="ely-pm-text-4k" type="number" min="0" step="0.0001" value="' + esc(val(t0, '4k')) + '" placeholder="0=默认价" /></div></div>'
      + '<div class="ely-price-group"><div class="ely-price-gtitle">🖼️ 图生图（image-to-image）<span class="ely-price-hint">（未设置默认用文生图价格）</span></div><div class="ely-price-row">生图模型 <input id="ely-pm-image-model" type="text" value="' + esc(val(i0, 'model')) + '" placeholder="如 seedream 5.0" /></div>'
      + '<div class="ely-price-row">默认档 <input id="ely-pm-image-default" type="number" min="0" step="0.0001" value="' + esc(val(i0, '默认')) + '" placeholder="元/张" />'
      + '2k <input id="ely-pm-image-2k" type="number" min="0" step="0.0001" value="' + esc(val(i0, '2k')) + '" placeholder="0=默认价" />'
      + '4k <input id="ely-pm-image-4k" type="number" min="0" step="0.0001" value="' + esc(val(i0, '4k')) + '" placeholder="0=默认价" /></div></div>'
      + sumHtml(t0, '文生图已设') + sumHtml(i0, '图生图已设')
      + '<div class="ely-price-btns"><button type="button" id="ely-pm-save">保存</button><button type="button" id="ely-pm-close">关闭</button></div></div>';
    document.body.appendChild(modal);
    const collect = (prefix) => {
      const out = {};
      const g = (k, id, isTxt) => { const el = document.getElementById(id); if (el) { if (isTxt) { const v = String(el.value).trim(); if (v) out[k] = v; } else { const v = parseFloat(el.value); if (!isNaN(v) && v >= 0) out[k] = v; } } };
      g('默认', prefix + '-default'); g('2k', prefix + '-2k'); g('4k', prefix + '-4k'); g('model', prefix + '-model', true);
      return out;
    };
    const save = () => {
      const next = {};
      const tt = collect('ely-pm-text');
      const ii = collect('ely-pm-image');
      if (Object.keys(tt).length) next.text = tt;
      if (Object.keys(ii).length) next.image = ii;
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* 配额满时静默 */ }
      const sd = modal.querySelector('#ely-pm-show-draw');
      if (sd) { try { localStorage.setItem('elysia-draw-show', sd.checked ? '1' : '0'); } catch (e) { /* ignore */ } }
      openDrawPriceModal();
    };
    modal.querySelector('#ely-pm-save').addEventListener('click', save);
    modal.querySelector('#ely-pm-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    for (const id of ['ely-pm-text-default', 'ely-pm-text-2k', 'ely-pm-text-4k', 'ely-pm-image-default', 'ely-pm-image-2k', 'ely-pm-image-4k']) {
      const el = modal.querySelector('#' + id);
      if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    }
  }

/* ══ 2. 再点一次已选中的项 = 退出 ═══════════════════════════════════ */

  const EMPTY_HINT = {};

  function captureEmptyHints() {

    for (const id of ['session-detail', 'chat-detail', 'memory-detail']) {

      if (EMPTY_HINT[id]) continue;

      const el = document.getElementById(id);

      if (el && el.querySelector('.empty-hint')) EMPTY_HINT[id] = el.innerHTML;

    }

  }

  /* 静音占位提示（"← …" 与 "加载中…"）；加载失败等真实提示照旧 */

  function silenceHints() {

    for (const id of ['session-detail', 'chat-detail', 'memory-detail']) {

      const el = document.getElementById(id);

      if (!el) continue;

      for (const h of $$(':scope > .empty-hint', el)) {

        const t = (h.textContent || '').trim();

        h.classList.toggle('ely-silent', t.indexOf('←') === 0 || t.indexOf('加载中') === 0);

      }

      /* 打开内容时从底部弹出来（只在"空 → 有内容"那一次挂动画，重绘不重放） */

      const open = !el.querySelector('.empty-hint');

      if (open && !paneOpen[id]) {

        el.classList.add('ely-rise');

        setTimeout(() => el.classList.remove('ely-rise'), 900);

      }

      paneOpen[id] = open;

    }

  }

  function deselect(kind) {

    const st = appState();

    const paneId = kind === 'session' ? 'session-detail' : kind === 'chat' ? 'chat-detail' : 'memory-detail';

    const pane = document.getElementById(paneId);

    /* 先记住"刚要取消的那一项"，列表重绘后拿它播淡出 */

    if (kind === 'session') {

      pendingFadeOut.session = st ? st.currentSessionId : null;

      if (st) { st.currentSessionId = null; st.sessionDetail = null; }

      try { lastDetailFp = null; } catch (e) { /* 名字不存在就算了 */ }

    } else if (kind === 'chat') {

      pendingFadeOut.chat = st ? st.currentChatKey : null;

      if (st) st.currentChatKey = null;

    } else {

      pendingFadeOut.memory = st ? st.currentMemoryChatKey : null;

      if (st) st.currentMemoryChatKey = null;

    }

    /* 列表立刻重绘（行上的缎带淡出由观察器补挂） */

    try {

      if (kind === 'session' && typeof renderSessionList === 'function') renderSessionList();

      else if (kind === 'chat' && typeof renderChatList === 'function') renderChatList();

      else if (kind === 'memory' && typeof renderMemoryList === 'function') renderMemoryList();

    } catch (e) { /* 忽略 */ }

    /* 右侧内容：先淡出再清空（顺序很重要 —— 直接清空就没得淡了） */

    if (pane && EMPTY_HINT[paneId]) {

      if (pane.querySelector('.empty-hint')) {

        pane.innerHTML = EMPTY_HINT[paneId];

      } else {

        pane.classList.add('ely-exit');

        setTimeout(() => {

          pane.classList.remove('ely-exit');

          if (EMPTY_HINT[paneId]) pane.innerHTML = EMPTY_HINT[paneId];

          silenceHints();

        }, 240);

      }

    }

    silenceHints();

  }

  const DESELECT_SPECS = [

    { kind: 'session', boxId: 'session-items', itemSel: '.session-item' },

    { kind: 'chat', boxId: 'chat-items', itemSel: '.chat-item' },

    { kind: 'memory', boxId: 'memory-items', itemSel: '.chat-item' }

  ];

  function wireDeselect(spec) {

    const box = document.getElementById(spec.boxId);

    if (!box || box.dataset.maidDeselect === '1') return;

    box.dataset.maidDeselect = '1';

    box.addEventListener('click', (e) => {

      const item = e.target && e.target.closest ? e.target.closest(spec.itemSel) : null;

      if (!item) return;

      if (e.target.closest('button')) return;            /* 记忆条目里的删除按钮等放行 */

      if (!item.classList.contains('selected')) return;  /* 未选中 → 交给应用去选中 */

      e.stopPropagation();

      e.preventDefault();

      deselect(spec.kind);

    }, true);

  }

  /* ══ 3. 左栏外壳：四角包边 + 底部「绶带 → 设置」 ═════════════════════ */

  function makeFrame() {

    const f = document.createElement('div');

    f.className = 'ely-frame';

    f.setAttribute('aria-hidden', 'true');

    for (const c of ['tl', 'tr', 'br', 'bl']) {

      const i = document.createElement('i');

      i.className = 'ely-corner ' + c;

      f.appendChild(i);

    }

    return f;

  }

  function makeRailDock() {

    const dock = document.createElement('div');

    dock.className = 'ely-rail-dock';

    const swag = document.createElement('div');

    swag.className = 'ely-rail-swag';

    const btn = document.createElement('button');

    btn.type = 'button';

    btn.className = 'ely-rail-goto';

    btn.textContent = '设置';

    btn.title = '跳到设置页';

    btn.addEventListener('click', () => {

      const tab = $('.tab[data-tab="settings"]');

      if (tab) { tab.click(); return; }

      try { if (typeof switchTab === 'function') switchTab('settings'); } catch (e) { /* 忽略 */ }

    });

    dock.appendChild(swag);

    dock.appendChild(btn);

    return dock;

  }

  /* 存档 / 记忆：行已收成"一行缎带"（和会话母群号头同尺寸），所以

     · 把"最后一条消息"挂到 title 上做悬浮提示，信息不丢

     · 把记忆的删除按钮搬到整行最右

     应用每次重绘都会重建这些行，所以由观察器反复补挂（幂等）。 */

  function tidyChatRows(boxId, kind) {

    const box = document.getElementById(boxId);

    if (!box) return;

    for (const item of $$('.chat-item', box)) {

      const sub = $('.chat-item-sub', item);

      const meta = $('.session-meta', item);

      if (!item.title) {

        const t = [sub && sub.textContent.trim(), meta && meta.textContent.trim()].filter(Boolean).join(' · ');

        if (t) item.title = t;

      }

      /* 记忆的 meta 是"更新于 09-30 23:56" —— 前缀与日期都很占宽（左栏只有 264px），

         只留时间；完整信息已经在 title 上。

         ⚠️ 只能改 span 自己的文本，不能改 .session-meta 的 textContent（那会把 span 全清掉）。 */

      for (const sp of $$('.session-meta > span', item)) {

        let t = sp.textContent.trim().replace(/^更新于\s*/, '');

        const m = /^(\d{2}-\d{2})\s+(\d{2}:\d{2})$/.exec(t);

        if (m) t = m[2];

        sp.textContent = t;

      }

      /* 删除按钮：收成一个小 ✕ 放到整行最右，给群号腾出宽度 */

      const del = $('.chat-item-title button', item);

      if (del && del.parentElement !== item) {

        del.classList.add('ely-row-del');

        del.textContent = '✕';

        del.title = '删除这个会话的记忆';

        item.appendChild(del);

      }

    }

    /* 缎带淡入 / 淡出：只在"选中项真的变了"时挂一次。

       ⚠️ 应用是整块 innerHTML 重绘的，新行一出生就带着 .selected，transition 不会有起始态，

       所以必须用一次性动画类；取消选中时还要靠 pendingFadeOut 把上一行找回来播淡出。 */

    if (!kind) return;

    const selEl = $('.chat-item.selected', box);

    const selKey = selEl ? selEl.dataset.key : null;

    if (selEl && selKey !== lastSelKey[kind]) {

      selEl.classList.add('ely-fade-in');

      setTimeout(() => selEl.classList.remove('ely-fade-in'), 560);

    }

    if (!selEl && pendingFadeOut[kind]) {

      const escKey = String(pendingFadeOut[kind]).replace(/["\\]/g, '\\$&');

      const prev = sel('.chat-item[data-key="' + escKey + '"]', box);

      if (prev) {

        prev.classList.add('ely-fade-out');

        setTimeout(() => prev.classList.remove('ely-fade-out'), 420);

      }

    }

    lastSelKey[kind] = selKey;

    pendingFadeOut[kind] = null;

  }

  function injectChrome() {

    captureEmptyHints();

    /* 按反馈：会话/存档/记忆的左栏不再要四角包边（ely-frame 只给设置页左栏保留） */

    for (const pane of $$('.settings-sidebar')) {

      if (!pane.querySelector(':scope > .ely-frame')) pane.appendChild(makeFrame());

    }

    for (const pane of $$('.list-pane')) {

      if (!pane.querySelector(':scope > .ely-rail-dock')) pane.appendChild(makeRailDock());

    }

    for (const spec of DESELECT_SPECS) wireDeselect(spec);

    tidyChatRows('chat-items', 'chat');

    tidyChatRows('memory-items', 'memory');

    silenceHints();

  }

  /* ══ 4. 技能 / 插件：左栏可折叠分类，右栏详情 + 内联设置 ═════════════ */

  const MODULE_META = {

    skill: { box: 'skills-page', tab: 'skills' },

    plugin: { box: 'plugins-page', tab: 'plugins' }

  };

  let lastPanel = { skill: null, plugin: null };

  function sel(expr, root) { try { return $(expr, root); } catch (e) { return null; } }

  function cardOf(root, id) {

    const escId = (window.CSS && CSS.escape) ? CSS.escape(id) : String(id).replace(/["\\]/g, '\\$&');

    return sel('.mcard[data-skill-id="' + escId + '"]', root);

  }

  function railVisibleItems(box) {

    return $$('.ely-rail-item', box).filter((b) => {

      if (b.style.display === 'none') return false;

      const grp = b.closest('.ely-rail-group');

      return !(grp && grp.classList.contains('collapsed'));

    });

  }

  function applyModuleSelection(kind) {

    const meta = MODULE_META[kind];

    const box = document.getElementById(meta.box);

    if (!box || box.dataset.maidMaster !== '1') return;

    const wrap = $('.ely-master-body .usage-wrap', box) || $('.usage-wrap', box);

    const cards = $$('.mcard', wrap || box);

    const railItems = $$('.ely-rail-item', box);

    if (moduleSel[kind] === null) {                    /* 用户点了"返回" */

      for (const b of railItems) b.classList.remove('on');

      removePanel(kind);

      return;

    }

    const pool = railVisibleItems(box);

    let cur = moduleSel[kind];

    if (!cur || !cards.some((c) => c.dataset.skillId === cur) || !pool.some((b) => b.dataset.skillId === cur)) {

      cur = pool.length ? pool[0].dataset.skillId : (cards[0] && cards[0].dataset.skillId) || null;

    }

    moduleSel[kind] = cur;

    for (const b of railItems) b.classList.toggle('on', b.dataset.skillId === cur);

    buildModulePanel(kind);

  }

  function removePanel(kind) {

    const box = document.getElementById(MODULE_META[kind].box);

    const p = box && $('.ely-mod-panel', box);

    if (p && !p.classList.contains('ely-fading')) {

      /* 退出时淡出，而不是"啪"地消失 */

      p.classList.add('ely-fading');

      setTimeout(() => p.remove(), 320);

    }

    lastPanel[kind] = null;

  }

  function buildModulePanel(kind) {

    const meta = MODULE_META[kind];

    const box = document.getElementById(meta.box);

    if (!box) return;

    const body = $('.ely-master-body', box);

    const wrap = $('.usage-wrap', body);

    if (!body || !wrap) return;

    const id = moduleSel[kind];

    const old = $('.ely-mod-panel', body);

    if (!id) { if (old) old.remove(); return; }

    const card = cardOf(wrap, id);

    if (!card) { if (old) old.remove(); return; }

    const nameEl = $('.mcard-name', card);

    const verEl = $('.skill-card__ver', card);

    const ver = verEl ? verEl.textContent.trim() : '';

    const name = (nameEl ? nameEl.textContent : id).replace(ver, '').trim() || id;

    const desc = ($('.mcard-desc', card) || {}).textContent || '';

    const status = ($('.mcard-status code', card) || {}).textContent || '';

    const err = ($('.mcard-err', card) || {}).textContent || '';

    const toolIds = $$('.mcard-tool-id', card).map((e) => e.textContent.trim());

    const broken = card.classList.contains('mcard-broken') || card.classList.contains('mcard-dep');

    const on = card.classList.contains('mcard-on');

    const panel = document.createElement('div');

    panel.className = 'ely-mod-panel';

    panel.dataset.skillId = id;

    const head = document.createElement('div');

    head.className = 'ely-mod-head';

    const nm = document.createElement('span');

    nm.className = 'ely-mod-name';

    nm.textContent = name;

    head.appendChild(nm);

    if (ver) {

      const vr = document.createElement('span');

      vr.className = 'ely-mod-ver';

      vr.textContent = ver;

      head.appendChild(vr);

    }

    /* 右上角：徽章 + 上传（上传在最右） */

    const acts = document.createElement('div');

    acts.className = 'ely-mod-acts';

    const badge = document.createElement('button');

    badge.type = 'button';

    badge.className = 'ely-badge ' + (broken ? 'err' : on ? 'on' : 'off');

    badge.textContent = broken ? '未就绪' : on ? '已启用' : '已停用';

    badge.title = broken ? '依赖未满足，暂不能启用' : '点击启用 / 停用这个模块';

    badge.addEventListener('click', () => {

      badge.disabled = true;

      card.click();                     /* 复用应用自己的开关逻辑 */

      setTimeout(() => { badge.disabled = false; }, 700);

    });

    acts.appendChild(badge);

    const upload = $('.mcard-upload', card);

    if (upload) acts.appendChild(upload);

    panel.appendChild(head);

    panel.appendChild(acts);

    if (toolIds.length) {

      const tl = document.createElement('div');

      tl.className = 'ely-mod-tools';

      for (const t of toolIds) {

        const c = document.createElement('code');

        c.textContent = t;

        tl.appendChild(c);

      }

      panel.appendChild(tl);

    }

    if (desc) {

      const d = document.createElement('div');

      d.className = 'ely-mod-desc';

      d.textContent = desc;

      panel.appendChild(d);

    }

    if (status) {

      const s = document.createElement('div');

      s.className = 'ely-mod-status';

      s.textContent = status;

      panel.appendChild(s);

    }

    if (err) {

      const e2 = document.createElement('div');

      e2.className = 'ely-mod-err';

      e2.textContent = err;

      panel.appendChild(e2);

    }

    /* 设置直接写在下面（复用应用自己的设置表单渲染器） */

    const setBox = document.createElement('div');

    setBox.className = 'ely-inline-settings';

    const st = appState();

    const skill = st && Array.isArray(st.skills) ? st.skills.find((x) => x.id === id) : null;

    if (skill && typeof renderSkillSettingsModal === 'function') {

      try {

        const built = renderSkillSettingsModal(skill);

        if (built && built.html) {

          setBox.innerHTML = '<div class="ely-inline-title">设置</div>' + built.html;

          wireInlineSettings(setBox, id);

        } else if (built && built.error) {

          setBox.innerHTML = '<div class="ely-inline-title">设置</div><div class="ely-mod-status">' + esc(built.error) + '</div>';

        }

      } catch (e) { /* 渲染失败就不显示设置区 */ }

    }

    panel.appendChild(setBox);

    if (old) old.replaceWith(panel);

    else {

      const usageHead = $('.usage-head', wrap);

      if (usageHead) usageHead.after(panel);

      else wrap.prepend(panel);

    }

    if (lastPanel[kind] !== id) {

      panel.classList.add('ely-rise');

      setTimeout(() => panel.classList.remove('ely-rise'), 900);

    }

    lastPanel[kind] = id;

  }

  /* 内联保存：字段收集规则照抄应用自己的弹窗保存逻辑 */

  function wireInlineSettings(root, skillId) {

    const save = root.querySelector('#skset-save');

    if (save) {

      save.addEventListener('click', async () => {

        const settings = {};

        root.querySelectorAll('[data-key]').forEach((el) => {

          const key = el.dataset.key;

          const type = el.dataset.type;

          if (type === 'boolean') settings[key] = el.checked;

          else if (type === 'number') {

            const n = Number(el.value);

            if (el.value.trim() !== '' && Number.isFinite(n)) settings[key] = n;

          } else if (type === 'enum') settings[key] = el.value;

          else settings[key] = el.value;

        });

        try {

          if (typeof api !== 'function') throw new Error('控制台接口不可用');

          const r = await api('/api/skills/' + encodeURIComponent(skillId), { method: 'POST', body: JSON.stringify({ settings }) });

          const st = appState();

          if (st && Array.isArray(st.skills)) {

            const idx = st.skills.findIndex((x) => x.id === skillId);

            if (idx >= 0 && r && r.skill) {

              st.skills[idx] = { ...st.skills[idx], ...r.skill, settings: r.settings || {}, configSchema: st.skills[idx].configSchema };

            }

            if (r && r.config) st.config = r.config;

          }

          if (typeof loadSkillsStatus === 'function') await loadSkillsStatus();

          if (typeof renderModulePage === 'function') { renderModulePage('skill'); renderModulePage('plugin'); }

          save.textContent = '已保存 ✓';

          setTimeout(() => { save.textContent = '保存'; }, 1700);

        } catch (e) {

          save.textContent = '保存失败';

          setTimeout(() => { save.textContent = '保存'; }, 2200);

        }

      });

    }

    root.querySelectorAll('[data-skill-action]').forEach((btn) => {

      btn.addEventListener('click', async () => {

        const key = btn.dataset.skillAction;

        btn.disabled = true;

        try {

          if (typeof api !== 'function') throw new Error('不可用');

          await api('/api/skills/' + encodeURIComponent(skillId) + '/action/' + encodeURIComponent(key), { method: 'POST', body: '{}' });

          btn.textContent = '已执行 ✓';

        } catch (e) {

          btn.textContent = '执行失败';

        }

        setTimeout(() => { btn.disabled = false; }, 900);

      });

    });

    root.querySelectorAll('input[type="checkbox"][data-type="boolean"]').forEach((cb) => {

      cb.addEventListener('change', () => {

        const span = cb.parentElement && cb.parentElement.querySelector('.st-text');

        if (span) span.textContent = cb.checked ? '已开启' : '已关闭';

      });

    });

  }

  function buildRailList(box, wrap, kind) {

    const list = $('.ely-rail-list', box);

    if (!list) return;

    list.textContent = '';

    let itemsWrap = list;

    for (const node of $$('.usage-h3, .mcard', wrap)) {

      if (node.classList.contains('usage-h3')) {

        const catName = node.textContent.trim();

        const grp = document.createElement('div');

        grp.className = 'ely-rail-group' + (railCollapsed.has(catName) ? ' collapsed' : '');

        const cat = document.createElement('button');

        cat.type = 'button';

        cat.className = 'ely-rail-cat';

        cat.textContent = catName;

        cat.title = '点击收起 / 展开这一分类';

        const inner = document.createElement('div');

        inner.className = 'ely-rail-items';

        cat.addEventListener('click', () => {

          if (railCollapsed.has(catName)) railCollapsed.delete(catName);

          else railCollapsed.add(catName);

          grp.classList.toggle('collapsed');

        });

        grp.appendChild(cat);

        grp.appendChild(inner);

        list.appendChild(grp);

        itemsWrap = inner;

        continue;

      }

      const id = node.dataset.skillId;

      if (!id) continue;

      const nameEl = $('.mcard-name', node);

      const verEl = $('.skill-card__ver', node);

      const ver = verEl ? verEl.textContent.trim() : '';

      const descEl = $('.mcard-desc', node);

      const state = node.classList.contains('mcard-on') ? 'on'

        : (node.classList.contains('mcard-broken') || node.classList.contains('mcard-dep') || node.classList.contains('mcard-err')) ? 'err'

          : 'off';

      const btn = document.createElement('button');

      btn.type = 'button';

      btn.className = 'ely-rail-item';

      btn.dataset.skillId = id;

      const dot = document.createElement('span');

      dot.className = 'ely-rail-state ' + state;

      const nm = document.createElement('span');

      nm.className = 'ely-rail-name';

      nm.textContent = (nameEl ? nameEl.textContent : id).replace(ver, '').trim() || id;

      const sb = document.createElement('span');

      sb.className = 'ely-rail-sub';

      sb.textContent = descEl ? descEl.textContent.trim() : '';

      btn.appendChild(dot);

      btn.appendChild(nm);

      btn.appendChild(sb);

      btn.addEventListener('click', () => {

        /* 再点已选中的 → 返回（什么都不选） */

        moduleSel[kind] = moduleSel[kind] === id ? null : id;

        applyModuleSelection(kind);

      });

      itemsWrap.appendChild(btn);

    }

  }

  function decorateModulePage(kind) {

    const meta = MODULE_META[kind];

    const box = document.getElementById(meta.box);

    if (!box) return;

    /* ⚠️ 不能用 dataset 判断"已装饰过"：应用整页重绘不会换掉容器元素本身，

       所以 dataset 还在、里面的 rail/body 已经被清掉了 —— 必须看结构是否还在。 */

    const railAlive = box.querySelector(':scope > .ely-master-rail');

    const bodyAlive = box.querySelector(':scope > .ely-master-body');

    if (box.dataset.maidMaster === '1' && railAlive && bodyAlive) {

      const wrap = $('.ely-master-body .usage-wrap', box) || $('.usage-wrap', box);

      if (wrap) buildRailList(box, wrap, kind);

      applyModuleSelection(kind);

      return;

    }

    const wrap = $('.usage-wrap', box);

    if (!wrap || !$('.mcard', wrap)) return;   /* 空态保持应用原样 */

    const rail = document.createElement('aside');

    rail.className = 'ely-master-rail';

    const list = document.createElement('div');

    list.className = 'ely-rail-list';

    const tools = document.createElement('div');

    tools.className = 'ely-master-tools';

    const row1 = document.createElement('div');

    row1.className = 'ely-tool-row';

    const addBtn = document.getElementById(meta.tab + '-add-btn');

    const refBtn = document.getElementById(meta.tab + '-refresh-btn');

    if (addBtn) { addBtn.classList.add('ely-add-btn'); row1.appendChild(addBtn); }

    if (refBtn) row1.appendChild(refBtn);

    const row2 = document.createElement('div');

    row2.className = 'ely-tool-row';

    const search = document.getElementById('module-search-' + meta.tab);

    if (search) row2.appendChild(search);

    tools.appendChild(row1);

    tools.appendChild(row2);

    rail.appendChild(tools);

    rail.appendChild(list);

    const body = document.createElement('div');

    body.className = 'ely-master-body';

    box.appendChild(rail);

    box.appendChild(body);

    body.appendChild(wrap);              /* 原样搬运，应用的监听器全部保留 */

    box.classList.add('ely-master-host');

    box.dataset.maidMaster = '1';

    lastPanel[kind] = null;

    buildRailList(box, wrap, kind);

    if (search) {

      search.addEventListener('input', () => {

        const q = search.value.trim().toLowerCase();

        const cards = $$('.mcard', wrap);

        for (const b of $$('.ely-rail-item', box)) {

          const card = cards.find((c) => c.dataset.skillId === b.dataset.skillId);

          const hay = ((card && card.dataset.search) || '').toLowerCase();

          b.style.display = (!q || hay.indexOf(q) >= 0) ? '' : 'none';

        }

        applyModuleSelection(kind);

      });

    }

    applyModuleSelection(kind);

  }

  /* ══ 5. 设置页：立即保存 ═════════════════════════════════════════════ */

  function injectSaveDock() {

    const view = document.getElementById('view-settings');

    if (!view || $('.ely-save-dock', view)) return;

    const dock = document.createElement('div');

    dock.className = 'ely-save-dock';

    const btn = document.createElement('button');

    btn.type = 'button';

    btn.className = 'btn btn-small ely-save-btn';

    btn.textContent = '立即保存';

    btn.title = '设置本来就是自动保存（改动后约 0.6 秒落盘）；这个按钮用于立刻落盘并确认结果';

    const tip = document.createElement('span');

    tip.className = 'ely-save-tip';

    dock.appendChild(btn);

    dock.appendChild(tip);

    view.appendChild(dock);

    let tipTimer = null;

    const say = (text, ok) => {

      tip.textContent = text;

      tip.classList.toggle('ok', !!ok);

      tip.classList.add('show');

      if (tipTimer) clearTimeout(tipTimer);

      tipTimer = setTimeout(() => tip.classList.remove('show'), 2600);

    };

    btn.addEventListener('click', async () => {

      const form = document.getElementById('settings-form');

      const bound = form && form.__settingsBound;

      if (!bound || typeof bound.flushSave !== 'function') { say('当前没有可保存的设置页', false); return; }

      try {

        bound.flushSave();

        say('保存中…', false);

        await sleep(1100);

        say('✓ 已保存', true);

      } catch (e) {

        say('保存失败：' + (e && e.message ? e.message : e), false);

      }

    });

  }

  /* ══ 6. 侧栏宽度对齐 + 署名按钮 ═════════════════════════════════════ */

  /* 左栏宽度：应用把宽度写成行内 flex-basis/width，CSS 侧用 !important 统一交给 --ely-rail，

     这里再把应用的值读出来同步过去 —— 所以拖拽照样能用，四条左栏也始终一致。

     按反馈"压细一点点"：应用默认值 288 映射为 264；用户自己拖过的其它值一律尊重。 */

  const RAIL_DEFAULT = 288;

  const RAIL_TARGET = 264;

  function syncRailWidth(pane) {

    const el = pane || $('.list-pane');

    if (!el) return;

    let cur = parseInt(el.style.getPropertyValue('--list-w'), 10);

    if (cur === RAIL_DEFAULT) cur = RAIL_TARGET;

    if (Number.isFinite(cur) && cur >= 180 && cur <= 520) {

      document.documentElement.style.setProperty('--ely-rail', cur + 'px');

    }

  }

  function observeRailWidth() {

    const panes = $$('.list-pane');

    for (const pane of panes) {

      if (pane.dataset.maidRailObs !== '1') {

        pane.dataset.maidRailObs = '1';

        new MutationObserver(() => syncRailWidth(pane)).observe(pane, { attributes: true, attributeFilter: ['style'] });

      }

    }

    syncRailWidth(panes[0] || null);

  }

  /* ══ 6.5 右侧立绘：DOM 图 + 伪 Live2D + 今日花费点击气泡 ═══════ */

  function todayCost() {

    try {

      const el = $$('#topbar .muted, #topbar .stat').find((e) => /今日/.test(e.textContent));

      if (!el) return null;

      const t = el.textContent.trim();

      const runs = /(\d+)\s*次运行/.exec(t);

      const tok = /([\d.]+[kKmM]?)\s*tok/.exec(t);

      const fee = /(?:¥|￥)([\d.]+)/.exec(t);

      const cache = /缓存\s*([\d.]+)%/.exec(t);

      return {

        runs: runs ? runs[1] : '—',

        tok: tok ? tok[1] : '—',

        fee: fee ? fee[1] : '—',

        cache: cache ? cache[1] : '—'

      };

    } catch (e) { return null; }

  }

  /* 全局立绘：fixed 固定在 body 下，可拖到页面任意位置；

     只在「会话 / 存档 / 记忆」处于收起（空状态）时显示。 */

  function figDefaultRect(wrap) {

    const w = wrap ? wrap.offsetWidth : 150;

    const h = wrap ? wrap.offsetHeight : 150;

    const vw = document.documentElement.clientWidth || window.innerWidth;

    const vh = document.documentElement.clientHeight || window.innerHeight;

    return {

      x: Math.max(8, vw - w - 16),

      y: Math.max(8, vh - h - 16)

    };

  }

  function figSavedPos() {

    return (window.__elyFigPos = window.__elyFigPos || {}).global || null;

  }

  function figSetPos(wrap, x, y) {

    wrap.style.left = Math.round(x) + 'px';

    wrap.style.top = Math.round(y) + 'px';

  }

  function figureVisible() {

    /* 用量 / 技能 / 插件 / SnowLuma / 设置：这几个页面不显示小人。

       用应用自己的 .tab.active 判断当前页（比 view 容器更可靠）。 */

    const tab = $('.tab.active');

    if (tab) {

      const dt = String(tab.getAttribute('data-tab') || '');

      if (['usage', 'skills', 'plugins', 'snowluma', 'settings'].indexOf(dt) >= 0) return false;

    }

    const panes = $$('.detail-pane').filter((p) => p.offsetParent !== null);

    if (!panes.length) return false;

    return !!panes[0].querySelector('.empty-hint');

  }

  /* 切页强制刷新立绘显隐：tab 栏事件委托（rAF + 200ms 双刷新，

     覆盖 view class 切换的瞬态与观察器时序） */

  function bindTabClickRefresh() {

    const tabs = document.getElementById('tabs');

    if (!tabs || tabs.dataset.elyTab === '1') return;

    tabs.dataset.elyTab = '1';

    tabs.addEventListener('click', (e) => {

      if (!(e.target && e.target.closest && e.target.closest('.tab'))) return;

      const refresh = () => {

        const w = document.getElementById('ely-fig-global');

        if (w) w.style.display = figureVisible() ? '' : 'none';

      };

      requestAnimationFrame(refresh);

      setTimeout(refresh, 200);

    });

  }

  function injectFigure() {

    let wrap = document.getElementById('ely-fig-global');

    if (!wrap) {

      wrap = document.createElement('div');

      wrap.id = 'ely-fig-global';

      wrap.className = 'ely-fig-wrap ely-fig-global';

      const img = document.createElement('img');

      img.className = 'ely-fig';

      img.src = assetUrl('figure-right-anim.webp') + '?v=13';

      img.alt = '';

      img.draggable = false;

      /* 兜底：万一解析到的那份目录里没有动图，切到另一个基准再试一次 */
      img.addEventListener('error', () => {
        const cur = String(img.getAttribute('src') || '');
        const alt = ASSET_BASES.filter((b) => cur.indexOf(b) !== 0);
        if (alt.length && !img.dataset.elyFigRetry) {
          img.dataset.elyFigRetry = '1';
          img.src = alt[0] + 'figure-right-anim.webp?v=13';
        }
      });

      const bubble = document.createElement('div');

      bubble.className = 'ely-fig-bubble';

      const titleEl = document.createElement('div');

      titleEl.className = 'ely-fig-bubble-title';

      titleEl.textContent = '今日花费';

      const feeEl = document.createElement('div');

      feeEl.className = 'ely-fig-bubble-fee';

      const subEl = document.createElement('div');

      subEl.className = 'ely-fig-bubble-sub';

      const render = () => {

        const t = todayCost();

        feeEl.textContent = t ? '¥' + t.fee : '——';

        subEl.textContent = t ? (t.runs + ' 次运行 · ' + t.tok + ' tok · 缓存 ' + t.cache + '%') : '暂无数据';

      };

      render();

      bubble.appendChild(titleEl);

      bubble.appendChild(feeEl);

      bubble.appendChild(subEl);

      let dragState = null;

      img.addEventListener('pointerdown', (e) => {

        if (e.button !== 0) return;

        dragState = { sx: e.clientX, sy: e.clientY, ox: wrap.offsetLeft, oy: wrap.offsetTop, moved: false };

        try { img.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }

        img.classList.add('dragging');

        e.stopPropagation();

      });

      img.addEventListener('pointermove', (e) => {

        if (!dragState) return;

        if (!dragState.moved && (Math.abs(e.clientX - dragState.sx) + Math.abs(e.clientY - dragState.sy) > 6)) {

          dragState.moved = true;

        }

        const nx = dragState.ox + (e.clientX - dragState.sx);

        const ny = dragState.oy + (e.clientY - dragState.sy);

        const clX = Math.max(0, Math.min(Math.max(0, window.innerWidth - wrap.offsetWidth), nx));

        const clY = Math.max(0, Math.min(Math.max(0, window.innerHeight - wrap.offsetHeight), ny));

        figSetPos(wrap, clX, clY);

      });

      const endDrag = () => {

        const wasDragging = !!dragState;

        const wasMoved = dragState && dragState.moved;

        dragState = null;

        img.classList.remove('dragging');

        if (wasDragging && !wasMoved) {

          render();              /* 每次点开都刷新一次最新花费 */

          wrap.classList.toggle('open');

        } else if (wasMoved) {

          (window.__elyFigPos = window.__elyFigPos || {}).global = { x: wrap.offsetLeft, y: wrap.offsetTop };

        }

      };

      img.addEventListener('pointerup', endDrag);

      img.addEventListener('pointercancel', endDrag);

      wrap.appendChild(img);

      wrap.appendChild(bubble);

      document.body.appendChild(wrap);

      const saved = figSavedPos();

      if (saved) {

        figSetPos(wrap, saved.x, saved.y);

      } else {

        /* 布局可能还没稳定：下一帧再摆到默认右下角 */

        requestAnimationFrame(() => {

          const d = figDefaultRect(wrap);

          figSetPos(wrap, d.x, d.y);

        });

      }

    }

    wrap.style.display = figureVisible() ? '' : 'none';

  }

  /* 重置按钮：挂在会话左栏「群发 / 清空」旁边，点击恢复默认右下角位置 */

  function injectFigReset() {

    if (document.getElementById('ely-fig-reset-btn')) return;

    const clearBtn = document.getElementById('session-clear-btn');

    if (!clearBtn || !clearBtn.parentElement) return;

    const btn = document.createElement('button');

    btn.id = 'ely-fig-reset-btn';

    btn.className = 'list-head-btn';

    btn.type = 'button';

    btn.textContent = '小人复位';

    btn.title = '把右下角小人移回默认位置';

    btn.addEventListener('click', (e) => {

      e.stopPropagation();

      if (window.__elyFigPos) delete window.__elyFigPos.global;

      const wrap = document.getElementById('ely-fig-global');

      if (wrap) {

        const def = figDefaultRect(wrap);

        figSetPos(wrap, def.x, def.y);

      }

    });

    clearBtn.parentElement.appendChild(btn);

    // 壁纸按钮依赖小人复位按钮已挂载；已存壁纸只在首次加载时生效一次

    if (!document.getElementById('ely-wallpaper-btn')) injectWallpaperBtn();

    if (!window.__elyWallpaperApplied) { applySavedWallpapers(); window.__elyWallpaperApplied = true; }

  }

  /* 壁纸自定义按钮：挂在「小人复位」旁边，打开上传/应用/重置对话框 */

  function injectWallpaperBtn() {

    if (document.getElementById('ely-wallpaper-btn')) return;

    const resetBtn = document.getElementById('ely-fig-reset-btn');

    if (!resetBtn || !resetBtn.parentElement) return;

    const btn = document.createElement('button');

    btn.id = 'ely-wallpaper-btn';

    btn.className = 'list-head-btn';

    btn.type = 'button';

    btn.textContent = '壁纸自定义';

    btn.title = '自定义白天 / 夜晚背景';

    btn.addEventListener('click', (e) => {

      e.stopPropagation();

      openWallpaperModal();

    });

    resetBtn.parentElement.appendChild(btn);

  }

  /* ══ 壁纸自定义：支持图片（含 GIF/WebP/APNG 动图）与视频（MP4/WebM），

     统一以 Blob 存 IndexedDB（省内存、无 base64 膨胀） ══ */

  const WALLPAPER_DAY = 'elysia-bg-day';

  const WALLPAPER_NIGHT = 'elysia-bg-night';

  function wpDB() {

    return new Promise((resolve, reject) => {

      try {

        const req = indexedDB.open('elysia-wallpapers', 1);

        req.onupgradeneeded = () => {

          if (!req.result.objectStoreNames.contains('wp')) req.result.createObjectStore('wp');

        };

        req.onsuccess = () => resolve(req.result);

        req.onerror = () => reject(req.error);

      } catch (e) { reject(e); }

    });

  }

  async function wpGet(key) {

    try { const db = await wpDB(); return await new Promise((res, rej) => {

      const r = db.transaction('wp', 'readonly').objectStore('wp').get(key);

      r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);

    }); } catch { return null; }

  }

  async function wpPut(key, val) {

    try { const db = await wpDB(); await new Promise((res, rej) => {

      const r = db.transaction('wp', 'readwrite').objectStore('wp').put(val, key);

      r.onsuccess = () => res(); r.onerror = () => rej(r.error);

    }); return true; } catch { return false; }

  }

  async function wpDel(key) {

    try { const db = await wpDB(); await new Promise((res, rej) => {

      const r = db.transaction('wp', 'readwrite').objectStore('wp').delete(key);

      r.onsuccess = () => res(); r.onerror = () => rej(r.error);

    }); } catch { /* ignore */ }

  }

  /* 兼容旧版 localStorage（dataURL 字符串）与 IndexedDB 旧字符串数据 */

  function readWallpaperLegacy(key) {

    try { return localStorage.getItem(key); } catch { return null; }

  }

  function writeWallpaperLegacy(key, val) {

    try { val ? localStorage.setItem(key, val) : localStorage.removeItem(key); } catch { /* 忽略 */ }

  }

  function dataURLToBlob(d) {

    const m = d.split(',');

    const head = m[0] || 'data:image/png;base64';

    const b64 = m[1] || '';

    const mime = (head.match(/^data:([^;]+)/) || [])[1] || 'image/png';

    const bin = atob(b64);

    const u8 = new Uint8Array(bin.length);

    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);

    return new Blob([u8], { type: mime });

  }

  /* 统一返回 { blob, kind: 'image'|'video' } | null */

  async function readWallpaper(key) {

    const idb = await wpGet(key);

    if (idb) {

      if (typeof idb === 'string') return { blob: dataURLToBlob(idb), kind: 'image' };

      if (idb && idb.blob) return { blob: idb.blob, kind: idb.kind === 'video' ? 'video' : 'image' };

      return null;

    }

    const legacy = readWallpaperLegacy(key);

    if (legacy) {

      const obj = { blob: dataURLToBlob(legacy), kind: 'image' };

      await wpPut(key, obj);

      writeWallpaperLegacy(key, null);

      return obj;

    }

    return null;

  }

  async function writeWallpaper(key, val) {

    if (val) { const ok = await wpPut(key, { blob: val.blob, kind: val.kind }); if (ok) writeWallpaperLegacy(key, null); }

    else { await wpDel(key); writeWallpaperLegacy(key, null); }

  }

  function wpIsNight() {

    return document.documentElement.getAttribute('data-theme') !== 'light';

  }

  function wpSystemSrc(night) {

    return assetUrl(night ? 'palace-night.webp' : 'palace-day.webp');

  }

  /* 渲染背景：自定义 Blob → img/video；无自定义 → 系统 webp */

  function renderWpBg(wp, isNight) {

    if (window.__elyWpUrl) { try { URL.revokeObjectURL(window.__elyWpUrl); } catch {} window.__elyWpUrl = null; }

    const oldV = document.getElementById('ely-wp-bg-video');

    const oldI = document.getElementById('ely-wp-bg');

    if (oldV) oldV.remove();

    if (oldI) oldI.remove();

    const baseStyle = 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:-2;pointer-events:none;';

    if (!wp) {

      const img = document.createElement('img');

      img.id = 'ely-wp-bg';

      img.style.cssText = baseStyle;

      img.src = wpSystemSrc(isNight);

      document.body.appendChild(img);

      return;

    }

    if (wp.kind === 'video') {

      const v = document.createElement('video');

      v.id = 'ely-wp-bg-video';

      v.style.cssText = baseStyle;

      v.autoplay = true; v.muted = true; v.loop = true; v.playsInline = true;

      window.__elyWpUrl = URL.createObjectURL(wp.blob);

      v.src = window.__elyWpUrl;

      document.body.appendChild(v);

      try { v.play(); } catch { /* 静音自动播放一般允许 */ }

      return;

    }

    const img = document.createElement('img');

    img.id = 'ely-wp-bg';

    img.style.cssText = baseStyle;

    window.__elyWpUrl = URL.createObjectURL(wp.blob);

    img.src = window.__elyWpUrl;

    document.body.appendChild(img);

  }

  async function applyWallpaperVar(kind) {

    const day = await readWallpaper(WALLPAPER_DAY);

    const night = await readWallpaper(WALLPAPER_NIGHT);

    const isNight = wpIsNight();

    renderWpBg(isNight ? night : day, isNight);

  }

  /* 白天/夜晚切换时同步背景 */

  function watchThemeForWp() {

    if (window.__elyWpThemeWatch) return;

    window.__elyWpThemeWatch = true;

    const mo = new MutationObserver(() => { applyWallpaperVar('day'); });

    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  }

  /* 文件处理：图片动图原样、png/jpeg 压缩、视频原样 */

  function processWallpaper(file, cb) {

    const type = String(file.type || '').toLowerCase();

    if (/mp4|webm|mov|m4v|ogv|mkv/.test(type)) {

      cb({ blob: file, kind: 'video' });

      return;

    }

    if (/gif|webp|apng|avif|svg/.test(type)) {

      cb({ blob: file, kind: 'image' });

      return;

    }

    /* png/jpeg 静态图：canvas 压缩成 WebP */

    const reader = new FileReader();

    reader.onload = () => {

      const img = new Image();

      img.onload = () => {

        const maxW = 1920;

        const scale = Math.min(1, maxW / (img.width || 1));

        const w = Math.max(1, Math.round(img.width * scale));

        const h = Math.max(1, Math.round(img.height * scale));

        const c = document.createElement('canvas');

        c.width = w; c.height = h;

        c.getContext('2d').drawImage(img, 0, 0, w, h);

        c.toBlob((b) => cb({ blob: b, kind: 'image' }), 'image/webp', 0.85);

      };

      img.src = reader.result;

    };

    reader.readAsDataURL(file);

  }

  /* 视频压缩：canvas 抽帧 + MediaRecorder 录成指定码率的 WebM（无音轨）。

     level：压缩档位对象 {rate, maxW}，如 {rate:3500000, maxW:1600}；

     rate=目标视频码率(bps)，maxW=画面最长边上限（按档位适配分辨率，避免低码率配大画面发糊）。 */

  async function compressVideoBlob(blob, level) {

    const bitrate = (level && level.rate) || 1500000;

    const maxW = (level && level.maxW) || 1280;

    const v = document.createElement('video');

    v.muted = true; v.playsInline = true; v.preload = 'auto';

    const url = URL.createObjectURL(blob);

    v.src = url;

    await new Promise((res, rej) => {

      v.onloadedmetadata = res;

      v.onerror = () => { URL.revokeObjectURL(url); rej(new Error('无法读取视频')); };

    });

    const vw = v.videoWidth || 1280;

    const vh = v.videoHeight || 720;

    const scale = Math.min(1, maxW / vw);

    const w = Math.max(2, Math.round(vw * scale) & ~1);

    const h = Math.max(2, Math.round(vh * scale) & ~1);

    const c = document.createElement('canvas');

    c.width = w; c.height = h;

    const ctx = c.getContext('2d');

    ctx.fillStyle = '#000';

    ctx.fillRect(0, 0, w, h);

    const stream = c.captureStream(30);

    if (!window.MediaRecorder) { URL.revokeObjectURL(url); throw new Error('当前环境不支持视频压缩'); }

    let mime = '';

    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) mime = 'video/webm;codecs=vp9';

    else if (MediaRecorder.isTypeSupported('video/webm')) mime = 'video/webm';

    const opts = { videoBitsPerSecond: bitrate || 1500000 };

    if (mime) opts.mimeType = mime;

    const rec = new MediaRecorder(stream, opts);

    const chunks = [];

    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

    const stopped = new Promise((res) => { rec.onstop = () => res(new Blob(chunks, { type: rec.mimeType || 'video/webm' })); });

    let raf = 0;

    const draw = () => { try { ctx.drawImage(v, 0, 0, w, h); } catch (e) {} raf = requestAnimationFrame(draw); };

    rec.start(500);

    try { await v.play(); } catch (e) { cancelAnimationFrame(raf); rec.stop(); URL.revokeObjectURL(url); throw new Error('视频无法播放'); }

    draw();

    await new Promise((res) => { v.addEventListener('ended', res); v.addEventListener('error', res); });

    cancelAnimationFrame(raf);

    try { ctx.drawImage(v, 0, 0, w, h); } catch (e) {}

    rec.stop();

    const out = await stopped;

    URL.revokeObjectURL(url);

    if (!out.size) throw new Error('压缩结果为空');

    return { blob: out, kind: 'video' };

  }

  /* 压缩提示：浮动在壁纸自定义窗口上方（页面顶部），3.5 秒自动消失 */

  function wpToast(msg) {

    let t = document.getElementById('ely-wp-toast');

    if (!t) {

      t = document.createElement('div');

      t.id = 'ely-wp-toast';

      t.className = 'ely-wp-toast';

      document.body.appendChild(t);

    }

    t.textContent = msg;

    t.style.display = '';

    clearTimeout(t._timer);

    t._timer = setTimeout(() => { t.style.display = 'none'; }, 3500);

  }

  /* 读取视频时长（秒） */

  function videoDuration(blob) {

    return new Promise((res, rej) => {

      const v = document.createElement('video');

      v.preload = 'metadata';

      const url = URL.createObjectURL(blob);

      v.onloadedmetadata = () => { const d = v.duration || 0; URL.revokeObjectURL(url); res(d); };

      v.onerror = () => { URL.revokeObjectURL(url); rej(new Error('无法读取视频时长')); };

      v.src = url;

    });

  }

  /* 四档压缩选择弹窗：按时长 × 码率估算压缩后大小；档位越低体积越小，

     档位越高分辨率上限与码率越大（极致≈原画）。 */

  const COMPRESS_LEVELS = [

    { rate: 800000,  maxW: 960,  name: '低（流畅）' },

    { rate: 1500000, maxW: 1280, name: '中（均衡）' },

    { rate: 3500000, maxW: 1600, name: '高（高清）' },

    { rate: 6000000, maxW: 1920, name: '极致（极清）' }

  ];

  function openCompressModal(wp, onPick) {

    let modal = document.getElementById('ely-compress-modal');

    if (!modal) {

      modal = document.createElement('div');

      modal.id = 'ely-compress-modal';

      modal.className = 'ely-wallpaper-modal';

      const opts = COMPRESS_LEVELS.map((l, i) =>

        '<label class="ely-compress-opt">' +

        '<input type="radio" name="ely-cmp" value="' + i + '"' + (i === 2 ? ' checked' : '') + '/>' +

        '<span>' + l.name + '</span><span class="ely-compress-est">…</span>' +

        '</label>').join('');

      modal.innerHTML =

        '<div class="ely-wallpaper-box">' +

        '  <div class="ely-wallpaper-head">选择压缩档位<button type="button" class="ely-compress-close">×</button></div>' +

        '  <div class="ely-compress-body">' +

        '    <div class="ely-compress-info">读取视频信息…</div>' +

        '    <div class="ely-compress-tip">低=体积最小 · 高=画质优先 · 极致≈原画；分辨率随档位自动适配</div>' +

        '    <div class="ely-compress-opts">' + opts + '</div>' +

        '  </div>' +

        '  <div class="ely-compress-actions">' +

        '    <button type="button" class="ely-compress-cancel">取消</button>' +

        '    <button type="button" class="ely-compress-ok">开始压缩</button>' +

        '  </div>' +

        '</div>';

      document.body.appendChild(modal);

      modal.querySelector('.ely-compress-close').addEventListener('click', () => { modal.style.display = 'none'; });

      modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

      modal.querySelector('.ely-compress-cancel').addEventListener('click', () => { modal.style.display = 'none'; });

      modal.querySelector('.ely-compress-ok').addEventListener('click', () => {

        const val = modal.querySelector('input[name="ely-cmp"]:checked');

        const level = COMPRESS_LEVELS[val ? parseInt(val.value, 10) : 2] || COMPRESS_LEVELS[2];

        modal.style.display = 'none';

        onPick(level);

      });

    }

    modal.style.display = '';

    (async () => {

      const info = modal.querySelector('.ely-compress-info');

      const ests = modal.querySelectorAll('.ely-compress-est');

      try {

        const dur = await videoDuration(wp.blob);

        const mins = Math.floor(dur / 60);

        const secs = Math.round(dur % 60);

        info.textContent = '视频时长：' + (mins ? mins + ' 分 ' : '') + secs + ' 秒（预计压缩后体积）';

        ests.forEach((el, i) => {

          const mb = dur * COMPRESS_LEVELS[i].rate / 8 / 1048576;

          el.textContent = '约 ' + (mb < 0.1 ? '<0.1' : mb.toFixed(1)) + ' MB';

        });

      } catch (e) {

        info.textContent = '无法读取视频时长，仍可按档位压缩';

      }

    })();

  }

  function openWallpaperModal() {

    let modal = document.getElementById('ely-wallpaper-modal');

    if (modal) { modal.style.display = ''; return; }

    modal = document.createElement('div');

    modal.id = 'ely-wallpaper-modal';

    modal.className = 'ely-wallpaper-modal';

    modal.innerHTML =

      '<div class="ely-wallpaper-box">' +

      '  <div class="ely-wallpaper-head">壁纸自定义<button type="button" class="ely-wallpaper-close">×</button></div>' +

      '  <div class="ely-wallpaper-row" data-kind="day">' +

      '    <div class="ely-wallpaper-label">白天背景（图片/动图/视频）</div>' +

      '    <input type="file" accept="image/*,video/*" class="ely-wallpaper-file" />' +

      '    <div class="ely-wallpaper-preview"></div>' +

      '    <div class="ely-wallpaper-actions">' +

      '      <button type="button" class="ely-wallpaper-compress">压缩</button>' +

      '      <button type="button" class="ely-wallpaper-apply">应用</button>' +

      '      <button type="button" class="ely-wallpaper-reset">重置</button>' +

      '    </div>' +

      '  </div>' +

      '  <div class="ely-wallpaper-row" data-kind="night">' +

      '    <div class="ely-wallpaper-label">夜晚背景（图片/动图/视频）</div>' +

      '    <input type="file" accept="image/*,video/*" class="ely-wallpaper-file" />' +

      '    <div class="ely-wallpaper-preview"></div>' +

      '    <div class="ely-wallpaper-actions">' +

      '      <button type="button" class="ely-wallpaper-compress">压缩</button>' +

      '      <button type="button" class="ely-wallpaper-apply">应用</button>' +

      '      <button type="button" class="ely-wallpaper-reset">重置</button>' +

      '    </div>' +

      '  </div>' +

      '</div>';

    document.body.appendChild(modal);

    modal.querySelector('.ely-wallpaper-close').addEventListener('click', () => { modal.style.display = 'none'; });

    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

    modal.querySelectorAll('.ely-wallpaper-row').forEach((row) => {

      const kind = row.dataset.kind;

      const key = kind === 'day' ? WALLPAPER_DAY : WALLPAPER_NIGHT;

      const fileEl = row.querySelector('.ely-wallpaper-file');

      const preview = row.querySelector('.ely-wallpaper-preview');

      let pending = null;

      let previewUrl = null;

      const renderPreview = (wp) => {

        if (previewUrl) { try { URL.revokeObjectURL(previewUrl); } catch {} previewUrl = null; }

        if (!wp) { preview.innerHTML = '<span class="ely-wallpaper-none">（当前为系统自带壁纸）</span>'; return; }

        const url = URL.createObjectURL(wp.blob);

        previewUrl = url;

        const mb = (wp.blob.size / 1048576).toFixed(1);

        if (wp.kind === 'video') preview.innerHTML = '<video src="' + url + '" muted autoplay loop playsinline style="max-width:100%;max-height:130px;display:block"></video><div class="ely-wallpaper-size">当前壁纸：' + mb + ' MB</div>';

        else preview.innerHTML = '<img src="' + url + '" alt="preview" style="max-width:100%;max-height:130px" /><div class="ely-wallpaper-size">当前壁纸：' + mb + ' MB</div>';

      };

      const refresh = async () => {

        if (pending) renderPreview(pending);

        else renderPreview(await readWallpaper(key));

      };

      refresh();

      fileEl.addEventListener('change', () => {

        const f = fileEl.files && fileEl.files[0];

        if (!f) return;

        processWallpaper(f, (data) => { pending = data; refresh(); });

      });

      row.querySelector('.ely-wallpaper-apply').addEventListener('click', async () => {

        if (!pending) return;

        await writeWallpaper(key, pending);

        await applyWallpaperVar(kind);

        refresh();

      });

      row.querySelector('.ely-wallpaper-reset').addEventListener('click', async () => {

        pending = null;

        fileEl.value = '';

        await writeWallpaper(key, null);

        await applyWallpaperVar(kind);

        refresh();

      });

      row.querySelector('.ely-wallpaper-compress').addEventListener('click', async () => {

        let wp = pending;

        if (!wp) wp = await readWallpaper(key);

        if (!wp) { wpToast('请先导入视频再压缩'); return; }

        if (wp.kind !== 'video') { wpToast('仅支持压缩视频文件'); return; }

        openCompressModal(wp, async (level) => {

          const btn = row.querySelector('.ely-wallpaper-compress');

          const applyBtn = row.querySelector('.ely-wallpaper-apply');

          const oldText = btn.textContent;

          btn.disabled = true;

          applyBtn.disabled = true; // 压缩期间禁止应用（防止把压缩中的原视频应用上去）

          btn.textContent = '压缩中…（约等于视频时长）';

          try {

            const before = wp.blob.size;

            const out = await compressVideoBlob(wp.blob, level);

            pending = out;

            refresh();

            const mb = (n) => (n / 1048576).toFixed(1);

            wpToast('压缩完成：' + mb(before) + ' MB → ' + mb(out.blob.size) + ' MB（已转 WebM，点「应用」生效）');

          } catch (e) {

            wpToast('压缩失败：' + (e && e.message ? e.message : e));

          } finally {

            btn.disabled = false;

            applyBtn.disabled = false;

            btn.textContent = oldText;

          }

        });

      });

    });

  }

  /* 进入页面即应用已存的自定义壁纸 */

  async function applySavedWallpapers() {

    await applyWallpaperVar('day');

    await applyWallpaperVar('night');

    watchThemeForWp();

  }

  /* ══ 7. 观察器：全部同步执行（不再延迟 → 不再闪未修改画面） ═════════

     写法要点：**先注册完所有 id 的观察器，再各自做一次初始装饰**，

     且初始装饰逐个 guard —— 以前是"注册一个就跑一次装饰"，一旦某次装饰抛异常，

     后面所有观察器就都注册不上了（存档/记忆因此一直没有观察器）。 */

  const OBS_SPECS = [

    { id: SESSION_BOX.boxId, run: () => decorateSessionList() },

    { id: 'chat-items', run: () => tidyChatRows('chat-items', 'chat') },

    { id: 'memory-items', run: () => tidyChatRows('memory-items', 'memory') },

    { id: 'skills-page', run: () => decorateModulePage('skill') },

    { id: 'plugins-page', run: () => decorateModulePage('plugin') },

    { id: 'session-detail', run: () => { silenceHints(); injectFigure(); decorateSessionDetail(); } },

    { id: 'chat-detail', run: () => { silenceHints(); injectFigure(); } },

    { id: 'memory-detail', run: () => { silenceHints(); injectFigure(); } },

    {

      id: 'view-settings',

      deep: true,

      attr: true,

      run: () => {

        /* 设置左栏每次切换分区都会整块重建（innerHTML），会把注入的四角包边、

           保存按钮一起清掉 —— 两样都要补挂。 */

        injectChrome();

        injectSaveDock();

        injectFigure();

        /* 人设区：补 ✎ 修改当前人设 / 💾 保存为自定义人设两个按钮，
           并把「选择人设」换成带行内 ✎ / 🗑 的主题列表弹窗 */
        guard('bindPersonaControls', bindPersonaControls);

      }

    },

    { id: 'view-sessions', attr: true, run: () => injectFigure() },

    { id: 'view-chats', attr: true, run: () => injectFigure() },

    { id: 'view-memory', attr: true, run: () => injectFigure() },

    { id: 'view-usage', attr: true, run: () => injectFigure() },

    { id: 'view-skills', attr: true, run: () => injectFigure() },

    { id: 'view-plugins', attr: true, run: () => injectFigure() },

    { id: 'view-snowluma', attr: true, run: () => injectFigure() }

  ];

  /* ══ 6. 人设管理：✎ 修改 / 🗑 删除 / ＋ 新建 / 💾 保存为自定义人设 ═══════════
     （2026-10-20 新增，1.0.10）

     为什么由主题来做：
       主程序的人设区只有「点击行 → 选中」这一个动作，没有就地改名/删除的入口。而且
       渲染人设行的代码（renderPersonaRows）随主程序版本走，主题改不到它 —— 所以
       主题干脆自己画一份列表弹窗（openElyPersonaList），结构、按钮、选中态全部
       由主体掌控，主程序以后怎么改都不影响。设置页底部那排按钮则用"克隆节点"
       的方式把主程序绑的监听换掉，再用自己的一套接上（见 bindPersonaControls）。

     默认人设（小鲸鱼）锁定：
       它是 roleText 为空时的兜底，也是删掉自定义人设后的回退目标，被改掉或删掉
       就没有可复原的锚点了。所以「✎ 修改 / 🗑 删除」对它都是 disabled，只保留
       「另存为自定义人设」这条路。

     依赖：主程序的全局 esc / api / state（三个都是 00-core.js、05-memory-settings.js
     里的顶层声明，按普通 script 加载，主题能直接引用）。
     */

  /* 人设列表由主题自绘（openElyPersonaList），不再扫描主程序的 .mm-model 行 ——
     那个 class 随主程序版本变，主题改不到，所以不依赖任何列表选择器。 */
  const ELY_DEFAULT_PERSONA_ID = 'xiaojingyu';

  /** 默认人设 id 判定（与主程序 isDefaultPersona 同语义）。 */
  function isDefaultPersonaId(id) {
    if (!id) return false;
    const st = appState();
    const wanted = (st && st.defaultPersonaId) || ELY_DEFAULT_PERSONA_ID;
    return id === wanted;
  }

  /** 人设模板表：主程序 loadSettings 拉下来的 state.personaTemplates（{ id: {name,text,customRules,builtin} }）。 */
  function personaTable() {
    const st = appState();
    const map = (st && st.personaTemplates) || {};
    /* 主程序 05-memory-settings.js 的 loadSettings 只回填 { name, text, builtin }，
       丢掉了 customRules —— 直接拿它去编辑会把「管理员附加规则」清空。
       这里惰性补齐：state.config 就是 /api/config 的顶层（customPersonas 在那儿），
       custom_N 的 N 就是数组下标。 */
    try {
      const cfgRoot = st && st.config ? (st.config.config || st.config) : null;
      const cfgs = cfgRoot && Array.isArray(cfgRoot.customPersonas) ? cfgRoot.customPersonas : null;
      if (cfgs) {
        for (const k of Object.keys(map)) {
          const t = map[k];
          if (!t || Object.prototype.hasOwnProperty.call(t, 'customRules')) continue;
          const idx = String(k).indexOf('custom_') === 0 ? Number(String(k).slice(7)) : -1;
          t.customRules = idx >= 0 && cfgs[idx] ? (cfgs[idx].customRules || '') : '';
        }
      }
    } catch (_) { /* 忽略：拿不到就按空规则处理 */ }
    return map;
  }

  /** 该人设的原始角色设定文本（用于编辑框预填）。 */
  function personaRawText(id) {
    const t = personaTable()[id];
    return t && typeof t.text === 'string' ? t.text : '';
  }

  /** 设置页当前的角色设定文本框（主题各处共用，避免重复写 getElementById）。 */
  function roleNowEl() { return document.getElementById('cfg-roletext'); }

  /**
   * 重新拉一遍人设模板表，写进主程序的 state.personaTemplates。
   *
   * 为什么不直接调 loadSettings()：它是 05-memory-settings.js 里的顶层函数，
   * 主程序并没有把它挂到 window 上（window.loadSettings 为 undefined），
   * 调了只会静默什么都不发生。这里只走 api() + 覆盖 personaTemplates ——
   * 模板表是唯一被人设 UI 读取的数据源，改完/删完把它刷新就够，不用惊动整页。
   */
  async function reloadPersonaTemplates() {
    if (typeof api !== 'function') throw new Error('控制台接口不可用');
    const res = await api('/api/persona-templates');
    const list = Array.isArray(res) ? res
      : ((res && (res.templates || res.items || res.list)) || []);
    const map = {};
    for (const t of list) {
      if (!t || t.id == null) continue;
      map[t.id] = {
        name: t.name || '',
        text: t.text || '',
        customRules: t.customRules || '',
        builtin: !!t.builtin
      };
    }
    const st = appState();
    if (st) st.personaTemplates = map;
    return map;
  }

  /* ── 兜底弹窗：主程序模态框取不到时自己画一个（只依赖全局 api / esc） ── */

  function elyDialog({ head, body, foot }) {
    const wrap = document.createElement('div');
    wrap.className = 'ely-dlg-mask';
    wrap.innerHTML =
      '<div class="ely-dlg" role="dialog" aria-modal="true">' +
        '<div class="ely-dlg-head">' + (head || '') + '</div>' +
        '<div class="ely-dlg-body">' + (body || '') + '</div>' +
        '<div class="ely-dlg-foot">' + (foot || '') + '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    const close = () => { try { wrap.remove(); } catch (_) { /* 忽略 */ } };
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    return { root: wrap, close };
  }

  function elyConfirm(message) {
    return new Promise((resolve) => {
      const d = elyDialog({
        head: '确认',
        body: '<div class="ely-dlg-text">' + message + '</div>',
        foot: '<button type="button" class="ely-dlg-btn" data-act="no">取消</button>' +
              '<button type="button" class="ely-dlg-btn ely-dlg-danger" data-act="yes">确定删除</button>'
      });
      d.root.querySelectorAll('.ely-dlg-btn').forEach((b) => b.addEventListener('click', () => {
        const yes = b.dataset.act === 'yes';
        d.close();
        resolve(yes);
      }));
    });
  }

  /* ── 保存：改 = PUT 覆盖自定义人设；另存 = POST 新建 ── */

  async function personaSave(id, payload) {
    if (typeof api !== 'function') throw new Error('控制台接口不可用');
    if (id) {
      return api('/api/persona-templates/' + encodeURIComponent(id), {
        method: 'PUT', body: JSON.stringify(payload)
      });
    }
    return api('/api/persona-templates', { method: 'POST', body: JSON.stringify(payload) });
  }

  /**
   * 编辑 / 另存弹窗。
   *   id = 'custom_N' → 修改；id 为空或默认/内置 → 另存为自定义人设。
   * 预填规则与主程序一致：编辑「当前正在用的那个」时带编辑器里的最新内容，
   * 编辑别的条目时带它自己的文本，绝不用别人的内容覆盖它。
   */
  function openElyPersonaEdit(id, onSaved) {
    const tbl = personaTable();
    const tpl = id ? tbl[id] : null;
    const isDefault = isDefaultPersonaId(id);
    const isEdit = !!id && String(id).indexOf('custom_') === 0 && !!tpl && !isDefault;
    const inUseId = (() => {
      const st = appState();
      const roleEl = document.getElementById('cfg-roletext');
      const roleNow = roleEl ? roleEl.value : ((st && st.config && st.config.persona && st.config.persona.roleText) || '');
      const hit = Object.keys(tbl).find((k) => { const t = tbl[k]; return t && t.text === roleNow; });
      return hit || '';
    })();
    const inUse = !!id && id === inUseId;
    const seedText = isEdit && !inUse ? (tpl.text || '') : (personaRawText(inUseId) || (tpl ? tpl.text : '') || '');
    const seedRules = isEdit && !inUse
      ? ((tpl && tpl.customRules) || '')
      : (((tbl[inUseId] && tbl[inUseId].customRules) || (tpl && tpl.customRules) || ''));
    const exists = (n) => Object.keys(tbl).some((k) => tbl[k] && tbl[k].name === n);
    let seedName = tpl ? tpl.name : '';
    if (!isEdit) {
      const base = (tpl ? tpl.name : '自定义人设') + ' 副本';
      seedName = base;
      for (let i = 2; exists(seedName); i += 1) seedName = base + ' ' + i;
    }
    const head = isEdit
      ? '修改人设 · ' + esc(tpl.name)
      : '保存为自定义人设' + (tpl ? '（基于' + (isDefault ? '默认' : '内置') + '「' + esc(tpl.name) + '」）' : '');
    const hint = isEdit
      ? (inUse ? '保存会覆盖这个自定义人设，其它模板不受影响。'
               : '保存会覆盖自定义人设「' + esc(tpl.name) + '」。当前在用的不是它，不受影响。')
      : (isDefault ? '「' + esc(tpl.name) + '」是默认人设，不能直接修改：这里会新建一个自定义人设。'
                   : '会新建一个自定义人设，原有模板原样保留。');

    const d = elyDialog({
      head: esc(head),
      body:
        '<div class="ely-dlg-field"><label>人设名称</label>' +
          '<input type="text" id="ely-pn-name" maxlength="50" value="' + esc(seedName) + '" /></div>' +
        '<div class="ely-dlg-field"><label>角色设定</label>' +
          '<textarea id="ely-pn-text" rows="14">' + esc(seedText) + '</textarea></div>' +
        '<div class="ely-dlg-field"><label>管理员附加规则（可选）</label>' +
          '<textarea id="ely-pn-rules" rows="4">' + esc(seedRules) + '</textarea></div>' +
        '<div class="ely-dlg-hint" id="ely-pn-hint">' + hint + '</div>',
      foot: '<button type="button" class="ely-dlg-btn" id="ely-pn-cancel">取消</button>' +
            '<button type="button" class="ely-dlg-btn ely-dlg-primary" id="ely-pn-ok">' +
              (isEdit ? '保存修改' : '保存为自定义人设') + '</button>'
    });
    const nameEl = d.root.querySelector('#ely-pn-name');
    const textEl = d.root.querySelector('#ely-pn-text');
    const rulesEl = d.root.querySelector('#ely-pn-rules');
    const hintEl = d.root.querySelector('#ely-pn-hint');
    const okEl = d.root.querySelector('#ely-pn-ok');
    d.root.querySelector('#ely-pn-cancel').addEventListener('click', d.close);

    okEl.addEventListener('click', async () => {
      const name = (nameEl.value || '').trim();
      const text = (textEl.value || '').trim();
      const customRules = (rulesEl.value || '').trim();
      if (!name) { hintEl.textContent = '人设名称不能为空'; nameEl.focus(); return; }
      if (!text) { hintEl.textContent = '角色设定不能为空'; textEl.focus(); return; }
      const dup = Object.keys(tbl).some((k) => k !== id && tbl[k] && tbl[k].name === name);
      if (dup && !isEdit) { hintEl.textContent = '已存在同名人设「' + name + '」，换个名字'; nameEl.focus(); return; }
      okEl.disabled = true;
      try {
        const savedId = (await personaSave(isEdit ? id : '', { name, text, customRules }))
          || (isEdit ? id : '');
        d.close();
        // 重拉模板表（改完名字/内容后，其它地方读的是这张表）
        await reloadPersonaTemplates();
        const t2 = personaTable();

        /* 回填设置页：改的是"当前正在用的那个"时，编辑器内容和「选择人设」显示名
           都得跟着变，否则会出现"名字改好了但输入框还挂着旧名"的错位。
           改完之后把 id 交回给调用方，由它判断是否需要重选。 */
        const roleElNow = document.getElementById('cfg-roletext');
        const pickElNow = document.getElementById('cfg-persona-pick');
        const rulesElNow = document.getElementById('cfg-customrules');
        const stillSame = roleElNow && t2[savedId] && roleElNow.value === (t2[savedId].text || '');
        const isCur = isEdit ? (inUse || stillSame) : false;

        if (isEdit && t2[savedId]) {
          // 名称永远是这一条自己的，直接对齐（覆盖保存 = 编辑器内容没变，只是改了名/规则）
          if (pickElNow) pickElNow.value = t2[savedId].name || name;
          // 若是正在用的那条，把编辑器里的设定/规则同步成本次保存的值
          if (isCur && roleElNow) {
            roleElNow.value = t2[savedId].text || text;
            if (rulesElNow) rulesElNow.value = t2[savedId].customRules || '';
            roleElNow.dispatchEvent(new Event('input', { bubbles: true }));
          }
        } else if (!isEdit) {
          // 新建：不动当前编辑器，只提示（用户可能只是存个备用模板）
        }
        if (typeof onSaved === 'function') { try { onSaved(savedId, t2[savedId]); } catch (_) {} }
        elySay(isEdit ? '人设「' + name + '」已更新' : '已保存为自定义人设「' + name + '」');
      } catch (e) {
        okEl.disabled = false;
        hintEl.textContent = (isEdit ? '保存失败：' : '另存失败：') + (e && e.message ? e.message : String(e));
      }
    });
  }

  /** 轻提示：主程序有 say() 就用它，没有就用主题自己的小浮条。 */
  function elySay(msg, ok) {
    try {
      if (typeof say === 'function') { say(msg, ok !== false); return; }
    } catch (_) { /* 落到下面的浮条 */ }
    let tip = document.getElementById('ely-persona-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'ely-persona-tip';
      tip.className = 'ely-persona-tip';
      document.body.appendChild(tip);
    }
    tip.textContent = msg;
    tip.classList.add('show');
    clearTimeout(elySay._t);
    elySay._t = setTimeout(() => { try { tip.classList.remove('show'); } catch (_) {} }, 2200);
  }

  /* ── 列表行注入：每行尾部补 ✎ / 🗑 ── */

  /**
   * 主题版人设列表弹窗：从设置页底部那两个输入框 / 按钮出发，
   * 自己画一份「所有模板 + 每行 ✎ 修改 / 🗑 删除」的列表。
   *
   * 为什么不用主程序的 .mm-model 行：主程序渲染人设行的那段代码（renderPersonaRows）
   * 只随主程序版本走，主题改不到；而且不同版本 class 不一样（model-modal-left /
   * mm-model / 直接是按钮）。这里自己按 state.personaTemplates 现画一份，
   * 结构、按钮、选中态全部由主题掌控，主程序以后怎么改都不影响。
   */
  function openElyPersonaList(opts) {
    const o = opts || {};
    const tbl = personaTable();
    const ids = Object.keys(tbl);
    const roleEl = document.getElementById('cfg-roletext');
    const roleNow = roleEl ? roleEl.value
      : ((appState() && appState().config && appState().config.persona
          && appState().config.persona.roleText) || '');
    const inUseId = ids.find((k) => tbl[k] && tbl[k].text === roleNow) || '';

    const rowsHtml = ids.length
      ? ids.map((id) => {
          const t = tbl[id] || {};
          const isCustom = String(id).indexOf('custom_') === 0;
          const isDefault = isDefaultPersonaId(id);
          const isOn = id === inUseId;
          const nm = esc(t.name || id);
          const tag = isDefault ? '默认' : (t.builtin ? '内置' : '自定义');
          // 默认人设整行锁死：它是 roleText 为空时的兜底，删了/改了就没有回退锚点
          const editTitle = isDefault
            ? '默认人设不能修改；请用「💾 保存为自定义人设」另存一份'
            : '修改' + (isCustom ? '自定义' : '内置') + '人设「' + nm + '」'
              + (isCustom ? '' : '（内置模板不可覆盖，改完会另存为自定义人设）');
          const delTitle = isDefault ? '默认人设不能删除'
            : (isCustom ? '删除自定义人设「' + nm + '」' : '内置人设不可删除');
          return (
            '<div class="ely-pn-row' + (isOn ? ' is-checked' : '') + (isDefault ? ' is-locked' : '') +
              '" data-id="' + esc(id) + '">' +
              '<span class="ely-pn-check">' + (isOn ? '✓' : '') + '</span>' +
              '<span class="ely-persona-name">' + nm + '</span>' +
              '<span class="ely-pn-tag">' + tag + '</span>' +
              '<span class="ely-persona-ops">' +
                '<button type="button" class="ely-pn-btn" data-act="edit"' + (isDefault ? ' disabled' : '') +
                  ' title="' + editTitle + '">✎ 修改</button>' +
                '<button type="button" class="ely-pn-btn ely-pn-danger" data-act="del"' +
                  (isCustom && !isDefault ? '' : ' disabled') +
                  ' title="' + delTitle + '">🗑 删除</button>' +
              '</span>' +
            '</div>'
          );
        }).join('')
      : '<div class="ely-dlg-hint" style="padding:10px 2px">还没有任何人设模板，点右下角「＋ 新建人设」建一个。</div>';

    const d = elyDialog({
      head: '选择人设 · 共 ' + ids.length + ' 个' +
            (inUseId ? '（当前：' + esc(tbl[inUseId].name || inUseId) + '）' : ''),
      body: '<div class="ely-pn-list" id="ely-pn-list">' + rowsHtml + '</div>' +
            '<div class="ely-dlg-hint">点整行 = 选用这一套；行尾 ✎ 改名字/设定/附加规则，🗑 删除自定义人设。' +
            '默认人设（小鲸鱼）锁定不可改删，可另存一份。</div>',
      foot: '<button type="button" class="ely-dlg-btn" id="ely-pn-close">关闭</button>' +
            '<button type="button" class="ely-dlg-btn ely-dlg-primary" id="ely-pn-new">＋ 新建人设</button>'
    });

    const list = d.root.querySelector('#ely-pn-list');
    d.root.querySelector('#ely-pn-close').addEventListener('click', d.close);
    d.root.querySelector('#ely-pn-new').addEventListener('click', () => {
      d.close();
      openElyPersonaEdit('');
    });

    /* 行点击 = 选用；按钮点击 stopPropagation 走自己的逻辑 */
    list.querySelectorAll('.ely-pn-row').forEach((row) => {
      const id = row.dataset.id;

      row.addEventListener('click', () => {
        const t = tbl[id];
        if (!t) return;
        /* 目标字段：默认是设置页那三个；弹窗里调用时由 o.pickId / o.roleId / o.rulesId 指定 */
        const pkId = o.pickId || 'cfg-persona-pick';
        const rlId = o.roleId || 'cfg-roletext';
        const ruId = o.rulesId || 'cfg-customrules';
        const pickEl = document.getElementById(pkId);
        const roleElNow = document.getElementById(rlId);
        const rulesElNow = document.getElementById(ruId);
        if (roleElNow) roleElNow.value = t.text || '';
        if (rulesElNow) rulesElNow.value = t.customRules || '';
        if (pickEl) pickEl.value = t.name || '';
        /* 让主程序的自动保存跟着走（它监听 cfg-roletext 的 input） */
        if (roleElNow) {
          roleElNow.dispatchEvent(new Event('input', { bubbles: true }));
          roleElNow.dispatchEvent(new Event('change', { bubbles: true }));
        }
        d.close();
        if (typeof o.onPick === 'function') { try { o.onPick(id, t); } catch (_) { /* 忽略 */ } }
        elySay('已选用人设「' + (t.name || id) + '」');
      });

      const editBtn = row.querySelector('[data-act="edit"]');
      if (editBtn) editBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isDefaultPersonaId(id)) {
          elySay('默认人设不能修改，请用「💾 保存为自定义人设」另存一份', false);
          return;
        }
        d.close();
        openElyPersonaEdit(id);
      });

      const delBtn = row.querySelector('[data-act="del"]');
      if (delBtn) delBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (isDefaultPersonaId(id)) { elySay('默认人设不能删除', false); return; }
        if (String(id).indexOf('custom_') !== 0) { elySay('内置人设不可删除', false); return; }
        const nm = (tbl[id] && tbl[id].name) || id;
        if (!(await elyConfirm('确定删除自定义人设「' + esc(nm) + '」？<br><span style="opacity:.72">删除后无法恢复。</span>'))) return;
        try {
          if (typeof api !== 'function') throw new Error('控制台接口不可用');
          await api('/api/persona-templates/' + encodeURIComponent(id), { method: 'DELETE', body: '{}' });
          d.close();
          // 重拉模板表；若删的正是当前在用的那个，编辑器里还留着已被删掉的文本 ——
          // 主程序只按 roleText 反查模板，查不到就当"未选中"，不会自己回退。这里补上回退。
          await reloadPersonaTemplates();
          const t2 = personaTable();
          const defId = (appState() && appState().defaultPersonaId) || ELY_DEFAULT_PERSONA_ID;
          if (id === inUseId && roleNowEl() && t2[defId]) {
            const rEl = roleNowEl();
            rEl.value = t2[defId].text || '';
            const rlEl = document.getElementById('cfg-customrules');
            if (rlEl) rlEl.value = t2[defId].customRules || '';
            const pkEl = document.getElementById('cfg-persona-pick');
            if (pkEl) pkEl.value = t2[defId].name || '';
            rEl.dispatchEvent(new Event('input', { bubbles: true }));
          }
          elySay('已删除人设「' + nm + '」');
          // 列表重开一次，让用户继续操作剩下的人设
          setTimeout(() => guard('persona-reopen', () => openElyPersonaList(o)), 120);
        } catch (err) {
          elySay('删除失败：' + (err && err.message ? err.message : String(err)), false);
        }
      });
    });
  }

  /**
   * 设置页「人设」区按钮的绑定（**只加不改**）。
   *
   * 主程序原版已经自带两个按钮，且逻辑完整：
   *   ＋ 添加人设（#new-persona-btn，主程序自绑 openPersonaCreateModal）
   *   删除当前自定义人设（#del-persona-btn，选中 custom_N 时显示）
   * 那两个保持原样，主题一根手指都不碰 —— 不克隆、不换节点、不重绑监听。
   *
   * 主题只补主程序没有的两个：
   *   ✎ 修改当前人设（#edit-persona-btn）
   *   💾 保存为自定义人设（#save-persona-as-btn）
   * 这两个由主题自己创建并插进主程序那排按钮里，主程序不认识也无所谓。
   *
   * 这样原版主题、女仆主题都完全不受影响：主题不加载时，人设区就是原版的样子。
   */
  function bindPersonaControls() {
    try {
      window.__elyPersonaDiag = window.__elyPersonaDiag || {};
      window.__elyPersonaDiag.calls = (window.__elyPersonaDiag.calls || 0) + 1;
      window.__elyPersonaDiag.lastPickFound = !!document.getElementById('cfg-persona-pick');
      window.__elyPersonaDiag.lastAt = new Date().toISOString();
    } catch (_) { /* 忽略 */ }
    const pickEl = document.getElementById('cfg-persona-pick');
    if (!pickEl) return;                       // 不在人设分区

    const roleEl = document.getElementById('cfg-roletext');

    /* ── ① 自己创建 ✎ / 💾 两个按钮（幂等：已存在就不重复建） ── */
    const btnBar = pickEl.parentNode;          // 主程序那排 flex 容器
    /* 插入锚点：主程序原版顺序是 [选择人设输入框][＋ 添加人设][删除当前自定义人设]。
       主题的两个按钮要塞进「添加」和「删除」之间，最终顺序才是
       添加 → 修改 → 保存 → 删除。删除按钮带 .hidden，不能按可见性找，按 id 找。 */
    const insertSlot = () => {
      const delB = document.getElementById('del-persona-btn');
      if (delB && delB.parentNode === btnBar) return delB;          // 插到删除之前
      const newB = document.getElementById('new-persona-btn');
      if (newB && newB.parentNode === btnBar) return newB.nextSibling;
      return null;                                                  // 追加到末尾
    };
    const mkBtn = (id, text, title) => {
      /* 幂等兜底：先在按钮排里找（重渲染后原节点可能已被主程序整块替换，
         全局 getElementById 不一定命中，但容器里那一份一定是活的） */
      let b = btnBar.querySelector('#' + id) || document.getElementById(id);
      if (!b) {
        b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-small';
        b.id = id;
        b.textContent = text;
        b.title = title;
        const slot = insertSlot();
        if (slot) btnBar.insertBefore(b, slot);
        else btnBar.appendChild(b);
      }
      return b;
    };
    const editBtn = mkBtn('edit-persona-btn', '✎ 修改当前人设',
      '修改当前选中的自定义人设（内置人设会另存为自定义人设）');
    const saveBtn = mkBtn('save-persona-as-btn', '💾 保存为自定义人设',
      '把下方这套角色设定另存成一个新的自定义人设模板（不覆盖原来的人设）');
    /* 视口里若还挂着一份脱离容器的旧按钮（整块重建后的孤儿），清掉避免视觉叠影 */
    [['edit-persona-btn', editBtn], ['save-persona-as-btn', saveBtn]].forEach(([bid, keep]) => {
      document.querySelectorAll('#' + bid).forEach((n) => {
        if (n !== keep && n.parentNode && !btnBar.contains(n)) { try { n.parentNode.removeChild(n); } catch (_) { /* 忽略 */ } }
      });
    });
    /* 已存在但位置错了（历史版本插错过）→ 纠正顺序 */
    (() => {
      const slot = insertSlot();
      if (!slot) return;
      if (editBtn.parentNode === btnBar && editBtn.nextSibling !== saveBtn) {
        btnBar.insertBefore(editBtn, saveBtn);
      }
      if (saveBtn.parentNode === btnBar && saveBtn.nextSibling !== slot) {
        btnBar.insertBefore(saveBtn, slot);
      }
    })();

    /* 主题重渲染后节点会换，用 dataset 打标记避免重复绑监听 */
    const mark = (el) => {
      if (!el || el.dataset.__elyBound === '1') return null;
      el.dataset.__elyBound = '1';
      return el;
    };

    /** 当前编辑器内容对应哪个模板 id（取不到返回空串）。 */
    const curIdNow = () => {
      const tbl = personaTable();
      const roleNow = roleEl ? roleEl.value : '';
      return Object.keys(tbl).find((k) => tbl[k] && tbl[k].text === roleNow) || '';
    };

    /* ── ② ✎ 修改当前人设 ── */
    const eBtn = mark(editBtn);
    if (eBtn) eBtn.addEventListener('click', () => {
      const curId = curIdNow();
      if (!curId) {
        // 内容对不上任何模板 → 相当于"把现在这套存成一个新人设"
        openElyPersonaEdit('');
        return;
      }
      if (isDefaultPersonaId(curId)) {
        elySay('默认人设不能直接修改，会另存为自定义人设', true);
        openElyPersonaEdit('');
        return;
      }
      openElyPersonaEdit(curId);
    });

    /* ── ③ 💾 保存为自定义人设 ── */
    const sBtn = mark(saveBtn);
    if (sBtn) sBtn.addEventListener('click', () => {
      const roleNow = roleEl ? roleEl.value : '';
      if (!roleNow) { elySay('「角色设定」还空着，先写点内容再另存', false); return; }
      openElyPersonaEdit('');
    });

    /* ── ③b 分群模式（「为所有的群聊/私聊使用同一个人设」未勾选）──
       这时主程序把 #persona-unified-box 整块 display:none，上面的 ✎ / 💾 按钮
       虽然建好了却在隐藏容器里 —— 用户看到的是 #persona-perchat-box。

       实测该容器高 76px、宽 932px，只装得下原来那一个「⚙ 全局人设设置」按钮，
       所以这里不硬塞进那一行，而是自己起一行，并给那行加 flex-wrap，超宽自动换行。

       同时接管两个原生弹窗里的 pick 输入框与「＋ 添加人设」：
         #gp-pick  / #gp-new-btn   → openGlobalPersonaModal()
         #pcp-pick / #pcp-new-btn  → openPerChatPersonaModal(chatKey)
       把列表换成本主题那套带行内 ✎ / 🗑 的，并各补一个「💾 保存为自定义人设」，
       因为这两个原生弹窗里根本没有保存为模板的入口。 */
    (function bindPerChatPersona() {
      const unifiedBox = document.getElementById('persona-unified-box');
      const perChatBox = document.getElementById('persona-perchat-box');
      if (!perChatBox) return;                                  /* 不在人设分区 */

      /* 统一模式（unifiedBox 可见）时把分群那套清掉，避免两处各挂一份 */
      const unifiedOn = !!(unifiedBox && unifiedBox.style && unifiedBox.style.display !== 'none');
      if (unifiedOn) {
        const old = document.getElementById('ely-pc-bar');
        if (old && old.parentNode) { try { old.parentNode.removeChild(old); } catch (_) { /* 忽略 */ } }
        return;
      }

      /* 分群模式下没有 #cfg-roletext，真正的全局人设内容在
         state.config.persona 里 —— 这是主程序 /api/config 落盘的那一份。 */
      const cfgPersona = () => {
        try { return (appState().config && appState().config.persona) || {}; } catch (_) { return {}; }
      };
      const curGlobalText = () => {
        const per = cfgPersona();
        if (per.roleText) return per.roleText;
        const el = roleNowEl();
        return el ? el.value : '';
      };
      const curGlobalId = () => {
        const tbl = personaTable();
        const roleNow = curGlobalText();
        if (!roleNow) return '';
        return Object.keys(tbl).find((k) => tbl[k] && tbl[k].text === roleNow) || '';
      };

      /* 自己起一行，挂在「⚙ 全局人设设置」那个 .field 的后面 */
      const globalBtn = document.getElementById('open-global-persona-btn');
      const hostField = globalBtn && globalBtn.closest ? globalBtn.closest('.field') : null;
      let bar = document.getElementById('ely-pc-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'ely-pc-bar';
        bar.className = 'ely-pc-bar';
        bar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;'
          + 'margin:0 0 12px 0;padding:10px 12px;border-radius:12px;'
          + 'background:rgba(242,166,200,.10);border:1px solid rgba(242,166,200,.28)';
        if (hostField && hostField.parentNode) hostField.parentNode.insertBefore(bar, hostField.nextSibling);
        else perChatBox.insertBefore(bar, perChatBox.firstChild);
      }

      const mkPC = (pid, text, title) => {
        let bt = bar.querySelector('#' + pid);
        if (!bt) {
          bt = document.createElement('button');
          bt.type = 'button';
          bt.className = 'btn btn-small ely-pc-btn';
          bt.id = pid;
          bt.textContent = text;
          bt.title = title;
          bar.appendChild(bt);
        }
        return bt;
      };

      const pcNew = mkPC('ely-pc-new-btn', '＋ 添加人设', '新建一个自定义人设模板');
      const pcPick = mkPC('ely-pc-pick-btn', '📋 人设列表', '打开人设列表：点整行选用，行尾 ✎ 修改 / 🗑 删除');
      const pcEdit = mkPC('ely-pc-edit-btn', '✎ 修改', '修改当前正在使用的人设（默认/内置人设会另存为自定义人设）');
      const pcSave = mkPC('ely-pc-save-btn', '💾 保存为', '把当前这套人设另存成新的自定义人设模板（不覆盖原来的人设）');
      const pcDel = mkPC('ely-pc-del-btn', '🗑 删除', '删除当前正在使用的自定义人设（默认人设不可删）');

      /* 分群模式中「选中某个人设」= 改 config.persona.roleText，走主程序的配置接口 */
      const setGlobalPersona = async (tpl) => {
        const per = cfgPersona();
        const next = { ...per, roleText: tpl.text || '', customRules: tpl.customRules || '' };
        try {
          if (typeof api === 'function') {
            await api('/api/config', { method: 'POST', body: JSON.stringify({ persona: next }) });
          }
        } catch (_) { /* 忽略：下面同步内存与 DOM */ }
        try {
          const st = appState();
          if (st && st.config) st.config.persona = next;
        } catch (_) { /* 忽略 */ }
        const rEl = roleNowEl();
        if (rEl) { rEl.value = next.roleText; rEl.dispatchEvent(new Event('input', { bubbles: true })); }
      };

      const bNew = mark(pcNew);
      if (bNew) bNew.addEventListener('click', () => openElyPersonaEdit(''));

      const bPick = mark(pcPick);
      if (bPick) bPick.addEventListener('click', () => openElyPersonaList({ onPick: (id, tpl) => setGlobalPersona(tpl) }));

      const bEdit = mark(pcEdit);
      if (bEdit) bEdit.addEventListener('click', () => {
        const id = curGlobalId();
        if (!id) { openElyPersonaEdit(''); return; }
        if (isDefaultPersonaId(id)) {
          elySay('默认人设不能直接修改，会另存为自定义人设', true);
          openElyPersonaEdit('');
          return;
        }
        openElyPersonaEdit(id);
      });

      const bSave = mark(pcSave);
      if (bSave) bSave.addEventListener('click', () => {
        if (!curGlobalText()) { elySay('当前这套人设是空的，先有内容才能另存', false); return; }
        openElyPersonaEdit('');
      });

      const bDel = mark(pcDel);
      if (bDel) bDel.addEventListener('click', async () => {
        const id = curGlobalId();
        if (!id) { elySay('当前人设对不上任何自定义模板，删不了', false); return; }
        if (isDefaultPersonaId(id)) { elySay('默认人设不能删除', false); return; }
        if (String(id).indexOf('custom_') !== 0) { elySay('内置人设不可删除', false); return; }
        const t = personaTable()[id] || {};
        const nm = t.name || id;
        if (!(await elyConfirm('确定删除自定义人设「' + esc(nm) + '」？<br>'
            + '<span style="opacity:.72">删除后当前人设会回退到默认人设。</span>'))) return;
        try {
          if (typeof api !== 'function') throw new Error('控制台接口不可用');
          await api('/api/persona-templates/' + encodeURIComponent(id), { method: 'DELETE', body: '{}' });
          await reloadPersonaTemplates();
          const t2 = personaTable();
          const defId = (appState() && appState().defaultPersonaId) || ELY_DEFAULT_PERSONA_ID;
          if (t2[defId]) await setGlobalPersona(t2[defId]);
          elySay('已删除人设「' + nm + '」，已切回默认人设');
          setTimeout(() => guard('persona-perchat-resync', bindPersonaControls), 60);
        } catch (err) {
          elySay('删除失败：' + (err && err.message ? err.message : String(err)), false);
        }
      });

      /* 按钮态：默认人设时「修改 / 删除」变灰 */
      const syncPC = () => {
        const id = curGlobalId();
        const locked = isDefaultPersonaId(id);
        if (pcEdit) {
          pcEdit.disabled = !id;
          pcEdit.title = locked ? '默认人设不能修改，请用「💾 保存为」另存一份'
            : (id ? '修改人设「' + ((personaTable()[id] || {}).name || id) + '」'
                  : '当前人设不是模板，点它会新建一个');
        }
        if (pcDel) {
          pcDel.disabled = locked || !id;
          pcDel.title = locked ? '默认人设不能删除'
            : (id ? '删除人设「' + ((personaTable()[id] || {}).name || id) + '」' : '当前人设不是自定义模板');
        }
        if (pcSave) pcSave.disabled = !curGlobalText();
      };
      syncPC();

      /* ── 接管原生弹窗的 pick / ＋添加人设 ──
         弹窗是点按钮时才同步建 DOM，先接一手 click，再在微任务里换掉弹窗内的节点。 */
      const hookModal = (openBtnId, pickId, newBtnId, roleId, rulesId, onPickWrite) => {
        const openBtn = document.getElementById(openBtnId);
        if (!openBtn || openBtn.dataset.__elyHook === '1') return;
        openBtn.dataset.__elyHook = '1';
        openBtn.addEventListener('click', () => {
          setTimeout(() => {
            try {
              /* 1) ＋ 添加人设 → 主题新建弹窗 */
              const nb = document.getElementById(newBtnId);
              if (nb && nb.dataset.__elyAddBound !== '1') {
                nb.dataset.__elyAddBound = '1';
                nb.addEventListener('click', (e) => {
                  e.preventDefault();
                  e.stopImmediatePropagation();
                  openElyPersonaEdit('');
                }, true);
              }
              /* 2) 按钮行末尾补一个「💾 保存为自定义人设」 */
              const saveId = 'ely-' + newBtnId + '-save';
              if (nb && nb.parentNode && !nb.parentNode.querySelector('#' + saveId)) {
                const sb = document.createElement('button');
                sb.type = 'button';
                sb.className = 'btn btn-small ely-pc-btn';
                sb.id = saveId;
                sb.textContent = '💾 保存为自定义人设';
                sb.title = '把弹窗里这套内容另存成新的自定义人设模板（不覆盖原来的人设）';
                sb.addEventListener('click', () => {
                  const el = document.getElementById(roleId);
                  if (!el || !el.value.trim()) { elySay('角色设定还是空的，先写点内容', false); return; }
                  openElyPersonaEdit('');
                });
                nb.parentNode.appendChild(sb);
              }
              /* 3) pick 输入框 → 主题人设列表（行内 ✎ / 🗑） */
              const pk = document.getElementById(pickId);
              if (pk && pk.dataset.__elyBound !== '1') {
                const fresh = pk.cloneNode(true);
                fresh.dataset.__elyBound = '1';
                fresh.readOnly = true;
                try { pk.parentNode.replaceChild(fresh, pk); } catch (_) { /* 忽略 */ }
                fresh.addEventListener('click', (e) => {
                  e.preventDefault();
                  e.stopImmediatePropagation();
                  openElyPersonaList({ pickId, roleId, rulesId, onPick: onPickWrite });
                }, true);
              }
            } catch (_) { /* 忽略：拿不到就沿用主程序原生行为 */ }
          }, 0);
        }, true);
      };

      /* 全局人设设置弹窗：选中即写回 config.persona，和上面那排按钮行为一致 */
      hookModal('open-global-persona-btn', 'gp-pick', 'gp-new-btn', 'gp-roletext', 'gp-customrules',
        (id, tpl) => { setGlobalPersona(tpl); });

      /* 分会话独立人设弹窗：点哪个会话就挂哪个（主程序按钮没有固定 id，用事件委托） */
      if (perChatBox.dataset.__elyChatHook !== '1') {
        perChatBox.dataset.__elyChatHook = '1';
        perChatBox.addEventListener('click', (ev) => {
          const hit = ev.target && ev.target.closest ? ev.target.closest('.persona-chat-btn') : null;
          if (!hit) return;
          setTimeout(() => {
            try {
              const nb = document.getElementById('pcp-new-btn');
              if (nb && nb.dataset.__elyAddBound !== '1') {
                nb.dataset.__elyAddBound = '1';
                nb.addEventListener('click', (e) => {
                  e.preventDefault();
                  e.stopImmediatePropagation();
                  openElyPersonaEdit('');
                }, true);
              }
              if (nb && nb.parentNode && !nb.parentNode.querySelector('#ely-pcp-save')) {
                const sb = document.createElement('button');
                sb.type = 'button';
                sb.className = 'btn btn-small ely-pc-btn';
                sb.id = 'ely-pcp-save';
                sb.textContent = '💾 保存为自定义人设';
                sb.title = '把弹窗里这套内容另存成新的自定义人设模板（不覆盖原来的人设）';
                sb.addEventListener('click', () => {
                  const el = document.getElementById('pcp-roletext');
                  if (!el || !el.value.trim()) { elySay('角色设定还是空的，先写点内容', false); return; }
                  openElyPersonaEdit('');
                });
                nb.parentNode.appendChild(sb);
              }
              const pk = document.getElementById('pcp-pick');
              if (pk && pk.dataset.__elyBound !== '1') {
                const fresh = pk.cloneNode(true);
                fresh.dataset.__elyBound = '1';
                fresh.readOnly = true;
                try { pk.parentNode.replaceChild(fresh, pk); } catch (_) { /* 忽略 */ }
                fresh.addEventListener('click', (e) => {
                  e.preventDefault();
                  e.stopImmediatePropagation();
                  openElyPersonaList({
                    pickId: 'pcp-pick',
                    roleId: 'pcp-roletext',
                    rulesId: 'pcp-customrules',
                    onPick: (id, tpl) => {
                      const r = document.getElementById('pcp-roletext');
                      if (r) r.value = tpl.text || '';
                      const ru = document.getElementById('pcp-customrules');
                      if (ru) ru.value = tpl.customRules || '';
                    }
                  });
                }, true);
              }
            } catch (_) { /* 忽略 */ }
          }, 0);
        }, true);
      }
    })();

    /* ── ④ 「选择人设」输入框：改成主题自绘的列表弹窗（带行内 ✎ / 🗑） ──
       这一处要接管：主程序原生弹窗只有"点行选中"，没有行内操作。
       接管方式是把 readonly 输入框换成自己处理 click（主程序 also 绑了 click，
       所以先剥掉它——用 cloneNode 换一份干净的，只影响这一个输入框）。 */
    let pick = pickEl;
    if (pick.dataset.__elyBound !== '1') {
      const fresh = pickEl.cloneNode(true);
      fresh.dataset.__elyBound = '1';
      fresh.readOnly = true;
      try {
        pickEl.parentNode.replaceChild(fresh, pickEl);
        pick = fresh;
      } catch (_) {
        /* 换节点失败：退化为直接在原节点上加监听（原版监听会一起触发，但功能不丢） */
        pick = pickEl;
        pick.dataset.__elyBound = '1';
      }
      pick.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        openElyPersonaList({});
      }, true);
    }

    /* ── ⑤ 按钮可用态 ── */
    const syncElyBtns = () => {
      if (sBtn) {
        const roleNow = roleEl ? roleEl.value : '';
        sBtn.disabled = !roleNow;
        sBtn.title = roleNow
          ? '把下方这套角色设定另存成一个新的自定义人设模板（不覆盖原来的人设）'
          : '「角色设定」还没有内容';
      }
    };
    syncElyBtns();
    if (roleEl && roleEl.dataset.__elySyncBound !== '1') {
      roleEl.dataset.__elySyncBound = '1';
      roleEl.addEventListener('input', syncElyBtns);
    }

    /* ── ⑥ 「＋ 添加人设」：#new-persona-btn ──
       原版 07 给它绑了 openPersonaCreateModal()，能用，但那是主程序自绘的
       model-modal，跟主题的列表/编辑弹窗不是一套视觉。这里在**捕获阶段**先接一手：
       自己的弹窗能开就用自己的；万一炸了就把事件放行回原版监听，功能不丢。 */
    const newBtn = document.getElementById('new-persona-btn');
    if (newBtn && newBtn.dataset.__elyAddBound !== '1') {
      newBtn.dataset.__elyAddBound = '1';
      newBtn.addEventListener('click', (e) => {
        try {
          e.preventDefault();
          e.stopImmediatePropagation();
          openElyPersonaEdit('');
        } catch (err) {
          /* 自己的弹窗挂了 → 放行给原版 openPersonaCreateModal */
          newBtn.dataset.__elyAddBound = '';
          try { newBtn.click(); } catch (_) { /* 忽略 */ }
          try {
            window.__maidErr = 'persona-add: ' + (err && err.message ? err.message : String(err));
          } catch (_) { /* 忽略 */ }
        }
      }, true);
    }

    /* ── ⑦ 「🗑 删除当前自定义人设」：#del-persona-btn ──
       原版按钮带 .hidden，只在「当前选中项是 custom_N」时由 07 的
       syncPersonaButtons 显出来。原版的删除流程不回退编辑器里的名字框，
       这里接管并补上完整回退 + 模板表刷新。 */
    const delBtn2 = document.getElementById('del-persona-btn');
    if (delBtn2 && delBtn2.dataset.__elyDelBound !== '1') {
      delBtn2.dataset.__elyDelBound = '1';
      delBtn2.addEventListener('click', async (e) => {
        const curId = curIdNow();
        /* 不是自定义人设 → 放行给原版（原版会直接 return） */
        if (!curId || String(curId).indexOf('custom_') !== 0 || isDefaultPersonaId(curId)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const t = personaTable()[curId] || {};
        const nm = t.name || curId;
        if (!(await elyConfirm('确定删除自定义人设「' + esc(nm) + '」？<br>' +
            '<span style="opacity:.72">删除后无法恢复。</span>'))) return;
        try {
          if (typeof api !== 'function') throw new Error('控制台接口不可用');
          await api('/api/persona-templates/' + encodeURIComponent(curId), { method: 'DELETE', body: '{}' });
          await reloadPersonaTemplates();
          /* 删掉的是当前在用的那套 → 三个字段一起回退到默认人设 */
          const t2 = personaTable();
          const defId = (appState() && appState().defaultPersonaId) || ELY_DEFAULT_PERSONA_ID;
          const roleElNow = roleNowEl();
          if (t2[defId] && roleElNow) {
            roleElNow.value = t2[defId].text || '';
            const rlEl = document.getElementById('cfg-customrules');
            if (rlEl) rlEl.value = t2[defId].customRules || '';
            const pkEl = document.getElementById('cfg-persona-pick');
            if (pkEl) pkEl.value = t2[defId].name || '';
            roleElNow.dispatchEvent(new Event('input', { bubbles: true }));
          }
          elySay('已删除人设「' + nm + '」，已切回默认人设');
          guard('persona-resync', syncElyBtns);
        } catch (err) {
          elySay('删除失败：' + (err && err.message ? err.message : String(err)), false);
        }
      }, true);
    }

    try {
      var _pk = document.getElementById('cfg-persona-pick');
      window.__elyPersonaDiag = window.__elyPersonaDiag || {};
      window.__elyPersonaDiag.bound = {
        edit: !!document.getElementById('edit-persona-btn'),
        save: !!document.getElementById('save-persona-as-btn'),
        del: !!document.getElementById('del-persona-btn'),
        newBtn: !!document.getElementById('new-persona-btn'),
        pick: !!_pk,
        pickIsTheirs: !!(_pk && _pk.dataset && _pk.dataset.__elyBound === '1')
      };
    } catch (_) { /* 忽略 */ }
  }

  function bindObservers() {

    const pending = [];

    for (const spec of OBS_SPECS) {

      const el = document.getElementById(spec.id);

      if (!el || el.dataset.maidObs === '1') continue;

      /* 先打标记再装饰：即使初始装饰抛异常，观察器也已经生效 */

      el.dataset.maidObs = '1';

      const opts = { childList: true };

      if (spec.deep) opts.subtree = true;

      if (spec.attr) opts.attributes = true;

      const obs = new MutationObserver(() => decorateExclusively(obs, el, opts, spec.run));

      obs.observe(el, opts);

      pending.push({ label: spec.id, fn: () => decorateExclusively(obs, el, opts, spec.run) });

    }

    for (const p of pending) guard(p.label, p.fn);

  }

  /* ══ 启动 ═══════════════════════════════════════════════════════════ */

  function boot() {

    guard('observeRailWidth', observeRailWidth);

    guard('injectChrome', injectChrome);

    guard('injectFigReset', injectFigReset);

    guard('bindTabClickRefresh', bindTabClickRefresh);

    guard('bindObservers', bindObservers);

  }


  /* 探测完成后：已挂上去的立绘 / 壁纸若指向旧基址，就地纠正 */
  probeAssetBase(() => {

    const fig = document.querySelector('#ely-fig-global .ely-fig');

    if (fig) {
      const want = assetUrl('figure-right-anim.webp') + '?v=13';
      if (fig.getAttribute('src') !== want) fig.src = want;
    }

    try { if (typeof applyWallpaperVar === 'function') applyWallpaperVar('day'); } catch (e) { /* 静默 */ }

  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);

  else boot();

  [400, 1200, 2600, 5000].forEach((ms) => setTimeout(() => {

    guard('observeRailWidth', observeRailWidth);

    guard('injectChrome', injectChrome);

    guard('bindObservers', bindObservers);

    guard('list-retry', () => {

      const sBox = document.getElementById(SESSION_BOX.boxId);

      if (sBox && !sBox.querySelector('.ely-group')) decorateSessionList();

      guard('injectHitRate', injectHitRate);

      for (const kind of ['skill', 'plugin']) {

        const box = document.getElementById(MODULE_META[kind].box);

        if (box && !box.querySelector('.ely-master-rail')) decorateModulePage(kind);

      }

    });

    guard('injectSaveDock', injectSaveDock);

    /* 人设区补挂：设置页整体重渲染后是全新 DOM，里面的 ✎ / 💾 按钮没了，
       要在这里再补一次（幂等）；同时也接住启动时错过观察器触发的情况 */
    guard('bindPersonaControls', bindPersonaControls);

    guard('injectFigReset', injectFigReset);

    guard('injectFigure', injectFigure);

    guard('silenceHints', silenceHints);

  }, ms));

})();

