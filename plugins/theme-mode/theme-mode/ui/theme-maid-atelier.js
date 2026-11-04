/* ══════════════════════════════════════════════════════════════════════════
   深海女仆工坊主题 · 交互层（theme-maid-atelier.js）
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
      try { console.warn('[maid-atelier] ' + label + ' 失败：', e); } catch (_) { /* 忽略 */ }
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
      g.className = 'maid-group' + (collapsed.session.has(key) ? ' collapsed' : '');

      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'maid-group-head';
      head.title = '点击收起 / 展开这个群';
      const nm = document.createElement('span');
      nm.className = 'maid-group-name';
      nm.textContent = labelOfChatKey(key);
      const ct = document.createElement('span');
      ct.className = 'maid-group-count';
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
          g.classList.remove('maid-pop');
          void g.offsetWidth;
          g.classList.add('maid-pop');
          setTimeout(() => g.classList.remove('maid-pop'), 820);
        }
      });

      const sub = document.createElement('div');
      sub.className = 'maid-group-list';
      for (const el of els) sub.appendChild(el);

      g.appendChild(head);
      g.appendChild(sub);
      frag.appendChild(g);
    }
    box.replaceChildren(frag);
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
        h.classList.toggle('maid-silent', t.indexOf('←') === 0 || t.indexOf('加载中') === 0);
      }
      /* 打开内容时从底部弹出来（只在"空 → 有内容"那一次挂动画，重绘不重放） */
      const open = !el.querySelector('.empty-hint');
      if (open && !paneOpen[id]) {
        el.classList.add('maid-rise');
        setTimeout(() => el.classList.remove('maid-rise'), 900);
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
        pane.classList.add('maid-exit');
        setTimeout(() => {
          pane.classList.remove('maid-exit');
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
    f.className = 'maid-frame';
    f.setAttribute('aria-hidden', 'true');
    for (const c of ['tl', 'tr', 'br', 'bl']) {
      const i = document.createElement('i');
      i.className = 'maid-corner ' + c;
      f.appendChild(i);
    }
    return f;
  }

  function makeRailDock() {
    const dock = document.createElement('div');
    dock.className = 'maid-rail-dock';
    const swag = document.createElement('div');
    swag.className = 'maid-rail-swag';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'maid-rail-goto';
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
        del.classList.add('maid-row-del');
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
      selEl.classList.add('maid-fade-in');
      setTimeout(() => selEl.classList.remove('maid-fade-in'), 560);
    }
    if (!selEl && pendingFadeOut[kind]) {
      const escKey = String(pendingFadeOut[kind]).replace(/["\\]/g, '\\$&');
      const prev = sel('.chat-item[data-key="' + escKey + '"]', box);
      if (prev) {
        prev.classList.add('maid-fade-out');
        setTimeout(() => prev.classList.remove('maid-fade-out'), 420);
      }
    }
    lastSelKey[kind] = selKey;
    pendingFadeOut[kind] = null;
  }

  function injectChrome() {
    captureEmptyHints();
    for (const pane of $$('.list-pane, .settings-sidebar')) {
      if (!pane.querySelector(':scope > .maid-frame')) pane.appendChild(makeFrame());
      if (pane.classList.contains('list-pane') && !pane.querySelector(':scope > .maid-rail-dock')) {
        pane.appendChild(makeRailDock());
      }
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
    return $$('.maid-rail-item', box).filter((b) => {
      if (b.style.display === 'none') return false;
      const grp = b.closest('.maid-rail-group');
      return !(grp && grp.classList.contains('collapsed'));
    });
  }

  function applyModuleSelection(kind) {
    const meta = MODULE_META[kind];
    const box = document.getElementById(meta.box);
    if (!box || box.dataset.maidMaster !== '1') return;
    const wrap = $('.maid-master-body .usage-wrap', box) || $('.usage-wrap', box);
    const cards = $$('.mcard', wrap || box);
    const railItems = $$('.maid-rail-item', box);

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
    const p = box && $('.maid-mod-panel', box);
    if (p && !p.classList.contains('maid-fading')) {
      /* 退出时淡出，而不是"啪"地消失 */
      p.classList.add('maid-fading');
      setTimeout(() => p.remove(), 320);
    }
    lastPanel[kind] = null;
  }

  function buildModulePanel(kind) {
    const meta = MODULE_META[kind];
    const box = document.getElementById(meta.box);
    if (!box) return;
    const body = $('.maid-master-body', box);
    const wrap = $('.usage-wrap', body);
    if (!body || !wrap) return;
    const id = moduleSel[kind];
    const old = $('.maid-mod-panel', body);
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
    panel.className = 'maid-mod-panel';
    panel.dataset.skillId = id;

    const head = document.createElement('div');
    head.className = 'maid-mod-head';
    const nm = document.createElement('span');
    nm.className = 'maid-mod-name';
    nm.textContent = name;
    head.appendChild(nm);
    if (ver) {
      const vr = document.createElement('span');
      vr.className = 'maid-mod-ver';
      vr.textContent = ver;
      head.appendChild(vr);
    }

    /* 右上角：徽章 + 上传（上传在最右） */
    const acts = document.createElement('div');
    acts.className = 'maid-mod-acts';
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'maid-badge ' + (broken ? 'err' : on ? 'on' : 'off');
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
      tl.className = 'maid-mod-tools';
      for (const t of toolIds) {
        const c = document.createElement('code');
        c.textContent = t;
        tl.appendChild(c);
      }
      panel.appendChild(tl);
    }
    if (desc) {
      const d = document.createElement('div');
      d.className = 'maid-mod-desc';
      d.textContent = desc;
      panel.appendChild(d);
    }
    if (status) {
      const s = document.createElement('div');
      s.className = 'maid-mod-status';
      s.textContent = status;
      panel.appendChild(s);
    }
    if (err) {
      const e2 = document.createElement('div');
      e2.className = 'maid-mod-err';
      e2.textContent = err;
      panel.appendChild(e2);
    }

    /* 设置直接写在下面（复用应用自己的设置表单渲染器） */
    const setBox = document.createElement('div');
    setBox.className = 'maid-inline-settings';
    const st = appState();
    const skill = st && Array.isArray(st.skills) ? st.skills.find((x) => x.id === id) : null;
    if (skill && typeof renderSkillSettingsModal === 'function') {
      try {
        const built = renderSkillSettingsModal(skill);
        if (built && built.html) {
          setBox.innerHTML = '<div class="maid-inline-title">设置</div>' + built.html;
          wireInlineSettings(setBox, id);
        } else if (built && built.error) {
          setBox.innerHTML = '<div class="maid-inline-title">设置</div><div class="maid-mod-status">' + esc(built.error) + '</div>';
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
      panel.classList.add('maid-rise');
      setTimeout(() => panel.classList.remove('maid-rise'), 900);
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
    const list = $('.maid-rail-list', box);
    if (!list) return;
    list.textContent = '';
    let itemsWrap = list;

    for (const node of $$('.usage-h3, .mcard', wrap)) {
      if (node.classList.contains('usage-h3')) {
        const catName = node.textContent.trim();
        const grp = document.createElement('div');
        grp.className = 'maid-rail-group' + (railCollapsed.has(catName) ? ' collapsed' : '');
        const cat = document.createElement('button');
        cat.type = 'button';
        cat.className = 'maid-rail-cat';
        cat.textContent = catName;
        cat.title = '点击收起 / 展开这一分类';
        const inner = document.createElement('div');
        inner.className = 'maid-rail-items';
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
      btn.className = 'maid-rail-item';
      btn.dataset.skillId = id;
      const dot = document.createElement('span');
      dot.className = 'maid-rail-state ' + state;
      const nm = document.createElement('span');
      nm.className = 'maid-rail-name';
      nm.textContent = (nameEl ? nameEl.textContent : id).replace(ver, '').trim() || id;
      const sb = document.createElement('span');
      sb.className = 'maid-rail-sub';
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
    const railAlive = box.querySelector(':scope > .maid-master-rail');
    const bodyAlive = box.querySelector(':scope > .maid-master-body');
    if (box.dataset.maidMaster === '1' && railAlive && bodyAlive) {
      const wrap = $('.maid-master-body .usage-wrap', box) || $('.usage-wrap', box);
      if (wrap) buildRailList(box, wrap, kind);
      applyModuleSelection(kind);
      return;
    }

    const wrap = $('.usage-wrap', box);
    if (!wrap || !$('.mcard', wrap)) return;   /* 空态保持应用原样 */

    const rail = document.createElement('aside');
    rail.className = 'maid-master-rail';
    const list = document.createElement('div');
    list.className = 'maid-rail-list';

    const tools = document.createElement('div');
    tools.className = 'maid-master-tools';
    const row1 = document.createElement('div');
    row1.className = 'maid-tool-row';
    const addBtn = document.getElementById(meta.tab + '-add-btn');
    const refBtn = document.getElementById(meta.tab + '-refresh-btn');
    if (addBtn) { addBtn.classList.add('maid-add-btn'); row1.appendChild(addBtn); }
    if (refBtn) row1.appendChild(refBtn);
    const row2 = document.createElement('div');
    row2.className = 'maid-tool-row';
    const search = document.getElementById('module-search-' + meta.tab);
    if (search) row2.appendChild(search);
    tools.appendChild(row1);
    tools.appendChild(row2);
    rail.appendChild(tools);
    rail.appendChild(list);

    const body = document.createElement('div');
    body.className = 'maid-master-body';

    box.appendChild(rail);
    box.appendChild(body);
    body.appendChild(wrap);              /* 原样搬运，应用的监听器全部保留 */
    box.classList.add('maid-master-host');
    box.dataset.maidMaster = '1';
    lastPanel[kind] = null;

    buildRailList(box, wrap, kind);

    if (search) {
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        const cards = $$('.mcard', wrap);
        for (const b of $$('.maid-rail-item', box)) {
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
    if (!view || $('.maid-save-dock', view)) return;
    const dock = document.createElement('div');
    dock.className = 'maid-save-dock';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-small maid-save-btn';
    btn.textContent = '立即保存';
    btn.title = '设置本来就是自动保存（改动后约 0.6 秒落盘）；这个按钮用于立刻落盘并确认结果';
    const tip = document.createElement('span');
    tip.className = 'maid-save-tip';
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

  /* 左栏宽度：应用把宽度写成行内 flex-basis/width，CSS 侧用 !important 统一交给 --maid-rail，
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
      document.documentElement.style.setProperty('--maid-rail', cur + 'px');
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

  /* 署名按钮：**放在设置左栏「！？群群？！」下面**（按反馈从顶栏挪过来，并改名"主题素材来源"）。
     设置左栏每次切换分区都会整块重建，所以由观察器反复补挂（幂等）。 */
  const SOURCE_REPO = 'https://github.com/Small-tailqwq/dsh-deep-whale/tree/main/maid-atelier';
  function injectSourceButton() {
    const side = document.querySelector('.settings-sidebar');
    if (!side) return;
    if (side.querySelector('.maid-source-btn')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-menu-item maid-source-btn';
    btn.textContent = '主题素材来源';
    btn.title = '本主题美术素材来自 maid-atelier（CC BY-NC-SA 4.0 · 署名·非商业·相同方式共享）—— 点击查看来源仓库';
    btn.addEventListener('click', () => {
      try { window.open(SOURCE_REPO, '_blank', 'noopener'); } catch (e) { /* 外链由主进程接管 */ }
    });
    const egg = side.querySelector('#qrcode-egg-btn');
    if (egg && egg.parentElement) egg.after(btn);
    else side.appendChild(btn);
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
    { id: 'session-detail', run: () => silenceHints() },
    { id: 'chat-detail', run: () => silenceHints() },
    { id: 'memory-detail', run: () => silenceHints() },
    {
      id: 'view-settings',
      deep: true,
      run: () => {
        /* 设置左栏每次切换分区都会整块重建（innerHTML），会把注入的四角包边、
           保存按钮、「主题素材来源」一起清掉 —— 三样都要补挂。 */
        injectChrome();
        injectSaveDock();
        injectSourceButton();
      }
    }
  ];

  function bindObservers() {
    const pending = [];
    for (const spec of OBS_SPECS) {
      const el = document.getElementById(spec.id);
      if (!el || el.dataset.maidObs === '1') continue;
      /* 先打标记再装饰：即使初始装饰抛异常，观察器也已经生效 */
      el.dataset.maidObs = '1';
      const opts = spec.deep ? { childList: true, subtree: true } : { childList: true };
      const obs = new MutationObserver(() => decorateExclusively(obs, el, opts, spec.run));
      obs.observe(el, opts);
      pending.push({ label: spec.id, fn: () => decorateExclusively(obs, el, opts, spec.run) });
    }
    for (const p of pending) guard(p.label, p.fn);
  }

  /* ══ 启动 ═══════════════════════════════════════════════════════════ */
  function boot() {
    guard('injectSourceButton', injectSourceButton);
    guard('observeRailWidth', observeRailWidth);
    guard('injectChrome', injectChrome);
    guard('bindObservers', bindObservers);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  [400, 1200, 2600, 5000].forEach((ms) => setTimeout(() => {
    guard('injectSourceButton', injectSourceButton);
    guard('observeRailWidth', observeRailWidth);
    guard('injectChrome', injectChrome);
    guard('bindObservers', bindObservers);
    guard('list-retry', () => {
      const sBox = document.getElementById(SESSION_BOX.boxId);
      if (sBox && !sBox.querySelector('.maid-group')) decorateSessionList();
      for (const kind of ['skill', 'plugin']) {
        const box = document.getElementById(MODULE_META[kind].box);
        if (box && !box.querySelector('.maid-master-rail')) decorateModulePage(kind);
      }
    });
    guard('injectSaveDock', injectSaveDock);
    guard('silenceHints', silenceHints);
  }, ms));
})();
