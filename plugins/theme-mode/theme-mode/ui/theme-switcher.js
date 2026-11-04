// 主题切换器（theme-mode 插件前端 UI）· 设置弹窗版
// 由插件注入到 index.html：在 theme-mode 插件的「设置」弹窗内注入
// 「主题切换」区块（下拉 + 应用 + 删除）。
// 数据流全部走应用同源接口（无跨域、不受 CSP 影响）：
//   · 状态：GET /theme-mode-status.json（插件每次自检/切换后写入）
//   · 应用：POST /api/skills/theme-mode {settings:{theme}} → {enabled:true}
//            （enabled 会触发插件 activate → 读取新 theme → 改写 index.html）
//   · 还原：POST /api/skills/theme-mode {settings:{theme:''}} → {enabled:true}
//            （theme 为空 = 应用「原版主题」）
//   · 删除：POST /api/skills/theme-mode {settings:{deleteTheme}} → {enabled:true}
// 下拉列表自动识别插件内置与已安装的主题；「原版主题」固定在最前、不可删除。
(function () {
  'use strict';

  function style() {
    const s = document.createElement('style');
    s.textContent = `
.ely-sw-modal { display:flex; align-items:center; flex-wrap:wrap; gap:8px; margin:10px 0 14px; padding:12px; border:1px dashed rgba(242,166,200,.5); border-radius:12px; background:rgba(255,243,249,.05); }
.ely-sw-modal .ely-sw-label { font-size:13px; font-weight:600; color:#ffd9ea; margin-right:2px; }
[data-theme='light'] .ely-sw-modal .ely-sw-label { color:#8a3a66; }
.ely-sw-modal .ely-hint { font-size:11px; color:#a98ec4; width:100%; margin-top:6px; line-height:1.5; }
[data-theme='light'] .ely-sw-modal .ely-hint { color:#b27aa6; }
.ely-sw-modal select {
  height:28px; min-width:170px; padding:0 8px; border-radius:8px; outline:none;
  font-size:12.5px; cursor:pointer;
  background:#241239; color:#f2cfe4; border:1px solid #5c3a78;
}
[data-theme='light'] .ely-sw-modal select {
  background:#fff; color:#5b2a4e; border:1px solid #e6b3d2;
}
.ely-sw-modal select:disabled { opacity:.55; cursor:not-allowed; }
.ely-sw-modal button {
  height:28px; padding:0 16px; border-radius:8px; font-size:12.5px; cursor:pointer;
  border:1px solid #5c3a78; background:#3a2158; color:#ffd9ee;
  transition:filter .18s ease;
}
.ely-sw-modal button:hover { filter:brightness(1.18); }
[data-theme='light'] .ely-sw-modal button {
  background:#f7cfe4; color:#7a2a58; border:1px solid #e6a8cc;
}
.ely-sw-modal button.ely-del { background:transparent; color:#b98ab0; border-color:#5c3a78; }
[data-theme='light'] .ely-sw-modal button.ely-del { color:#b25a8c; border-color:#dca6c6; }
.ely-sw-modal button:disabled { opacity:.45; cursor:not-allowed; }
`;
    document.head.appendChild(s);
  }

  function skillPost(payload) {
    return fetch('/api/skills/theme-mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); });
  }

  function fetchStatus() {
    return fetch('/theme-mode-status.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; });
  }

  /** 找到 theme-mode 插件的设置弹窗（app 渲染的 .skill-modal）。 */
  function findModal() {
    const modals = document.querySelectorAll('.skill-modal');
    for (const m of modals) {
      const idEl = m.querySelector('.skill-modal__id');
      if (idEl && /theme-mode/.test(idEl.textContent)) return m;
    }
    return null;
  }

  /** 下拉：第一项固定「原版主题」（value=''，不可删除），其余自动识别状态文件里的主题。 */
  function fill(sel, st) {
    const themes = st && st.themes ? st.themes : {};
    const applied = st ? (st.appliedTheme || '') : '';
    sel.innerHTML = '';
    const o0 = document.createElement('option');
    o0.value = '';
    o0.textContent = '原版主题';
    if (!applied) o0.selected = true;
    sel.appendChild(o0);
    Object.keys(themes).forEach(function (id) {
      const t = themes[id];
      const bundled = t ? t.bundled : true;
      const name = (t && t.name) || id;
      const icon = (t && t.icon) || '';
      const o = document.createElement('option');
      o.value = id;
      o.textContent = (icon ? icon + ' ' : '') + name + (bundled ? '' : '（已删）');
      if (!bundled) o.disabled = true;
      if (applied === id) o.selected = true;
      sel.appendChild(o);
    });
    syncDelBtn(sel);
    return st;
  }

  function syncDelBtn(sel) {
    const del = document.querySelector('.ely-sw-modal button.ely-del');
    if (del) del.disabled = !sel || sel.value === '';
  }

  function refresh() {
    return fetchStatus().then(function (st) {
      const sel = document.querySelector('.ely-sw-modal select');
      const tip = document.querySelector('.ely-sw-modal .ely-tip');
      if (!sel) return;
      st = fill(sel, st);
      if (tip) {
        if (!st) {
          tip.textContent = '状态文件不可用（插件未运行？）';
        } else if (st.appliedTheme) {
          const tt = st.themes && st.themes[st.appliedTheme];
          tip.textContent = '当前：' + ((tt && tt.name) || st.appliedTheme);
        } else {
          tip.textContent = '当前：原版主题';
        }
      }
    }).catch(function () {
      const sel = document.querySelector('.ely-sw-modal select');
      const tip = document.querySelector('.ely-sw-modal .ely-tip');
      if (sel) fill(sel, null);
      if (tip) tip.textContent = '无法读取主题状态';
    });
  }

  function pollApplied(expect, tries) {
    if (tries <= 0) return Promise.resolve(false);
    return fetchStatus().then(function (st) {
      const cur = st && st.appliedTheme ? st.appliedTheme : '';
      if (cur === (expect || '')) return true;
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(pollApplied(expect, tries - 1)); }, 250);
      });
    }).catch(function () {
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(pollApplied(expect, tries - 1)); }, 250);
      });
    });
  }

  /** 应用：空值 = 还原原版；有值 = 应用对应主题。 */
  function apply() {
    const sel = document.querySelector('.ely-sw-modal select');
    const theme = sel ? sel.value : '';
    if (theme === null || theme === undefined) return;
    const btn = document.querySelector('.ely-sw-modal button.ely-apply');
    if (btn) btn.disabled = true;
    const done = function () { if (btn) btn.disabled = false; };
    skillPost({ settings: { theme: theme } })
      .then(function () { return skillPost({ enabled: true }); })
      .then(function () { return pollApplied(theme, 12); })
      .then(function (ok) {
        done();
        if (ok) {
          /* 带时间戳跳转：绕过本地缓存，确保加载插件改写后的 index.html（否则要重启才生效） */
          try {
            const u = new URL(location.href);
            u.searchParams.set('v', String(Date.now()));
            location.replace(u.href);
          } catch (e) { location.reload(); }
          return;
        }
        alert('应用失败：主题未切换。可能原因：该主题的插件内置副本已被删除，或当前处于还原状态（可先重启应用再试）。');
      })
      .catch(function () { done(); alert('应用失败：本地接口不可用'); });
  }

  /** 删除：原版（空值）不可删除。 */
  function del() {
    const sel = document.querySelector('.ely-sw-modal select');
    const theme = sel ? sel.value : '';
    if (!theme) return;
    const t = sel.selectedOptions && sel.selectedOptions[0];
    const label = t ? t.textContent.replace(/（已删）$/, '') : theme;
    if (!window.confirm('确定删除「' + label + '」主题的插件内置资源？\n删除后该主题将无法再切换或自愈补装（已应用的现状不受影响）。')) return;
    const btn = document.querySelector('.ely-sw-modal button.ely-del');
    if (btn) btn.disabled = true;
    const done = function () { if (btn) btn.disabled = false; };
    skillPost({ settings: { deleteTheme: theme } })
      .then(function () { return skillPost({ enabled: true }); })
      .then(function () { return skillPost({ settings: { deleteTheme: '' } }); })
      .then(function () { refresh(); done(); })
      .catch(function () { done(); alert('删除失败：本地接口不可用'); });
  }

  /** 往 theme-mode 设置弹窗里注入主题切换区块（幂等）。 */
  function injectIntoModal() {
    const modal = findModal();
    if (!modal) return;
    if (modal.querySelector('.ely-sw-modal')) return;
    const body = modal.querySelector('.skill-modal__body');
    if (!body) return;

    const wrap = document.createElement('div');
    wrap.className = 'ely-sw-modal';
    const lab = document.createElement('span');
    lab.className = 'ely-sw-label';
    lab.textContent = '主题切换';
    const sel = document.createElement('select');
    sel.className = 'ely-theme-select';
    sel.addEventListener('change', function () { syncDelBtn(sel); });
    const btnApply = document.createElement('button');
    btnApply.className = 'ely-apply';
    btnApply.textContent = '应用';
    btnApply.addEventListener('click', apply);
    const btnDel = document.createElement('button');
    btnDel.className = 'ely-del';
    btnDel.textContent = '删除';
    btnDel.addEventListener('click', del);
    const tip = document.createElement('span');
    tip.className = 'ely-tip';
    const hint = document.createElement('div');
    hint.className = 'ely-hint';
    hint.textContent = '下拉列表自动识别已安装的主题。选中后点「应用」立即切换（选择「原版主题」恢复默认外观）；「删除」会移除所选主题的插件内置副本，「原版主题」不可删除。';
    wrap.appendChild(lab);
    wrap.appendChild(sel);
    wrap.appendChild(btnApply);
    wrap.appendChild(btnDel);
    wrap.appendChild(tip);
    wrap.appendChild(hint);
    body.insertBefore(wrap, body.firstChild);

    refresh();
  }

  function watch() {
    const mo = new MutationObserver(function () { injectIntoModal(); });
    mo.observe(document.body, { childList: true, subtree: true });
    injectIntoModal(); // 若弹窗已开着
  }

  /* ── 插件启用/停用自动刷新监视器 ─────────────────────────────
     禁用插件（deactivate 还原原版）或启用插件（activate 应用主题）时，
     插件会改写 index.html 并更新 status 文件。这里轮询 status 文件，
     发现 appliedTheme 变化 → 自动带时间戳刷新一次，界面立即呈现
     原版/新主题，无需手动 F5。 */
  function watchPluginState() {
    let last = null;
    const timer = setInterval(function () {
      fetchStatus().then(function (st) {
        const cur = st && st.appliedTheme ? st.appliedTheme : '';
        if (last === null) { last = cur; return; }
        if (cur !== last) {
          last = cur;
          clearInterval(timer);
          try {
            const u = new URL(location.href);
            u.searchParams.set('v', String(Date.now()));
            location.replace(u.href);
          } catch (e) { location.reload(); }
        }
      }).catch(function () { /* 状态文件暂不可用：跳过本轮 */ });
    }, 1200);
    window.addEventListener('beforeunload', function () { clearInterval(timer); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { style(); watch(); watchPluginState(); });
  } else {
    style();
    watch();
    watchPluginState();
  }
})();
