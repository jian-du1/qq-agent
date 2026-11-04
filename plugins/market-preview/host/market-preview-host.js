(() => {
  'use strict';
  if (window.__marketPreviewHost) return;
  const ID = 'market-preview';
  const TAB = 'market-preview';
  const ACTION = '/api/skills/' + ID + '/action/market';
  const KINDS = {
    plugin: { label: '插件', external: 'plugin-market/', install: '安装插件' },
    skill: { label: '技能', external: 'skill-market/', install: '安装技能' },
    persona: { label: '人设', external: 'persona-plaza/', install: '添加人设' }
  };
  let kind = 'plugin';
  let loadSequence = 0, loadingKind;
  let stripNote;
  const kindButtons = new Map();
  const sortButtons = new Map();
  const sortModes = { plugin: 'updated', skill: 'updated', persona: 'updated' };
  const addedPersonas = new Set();
  const savedPersonas = new Map();
  const events = new AbortController();
  let view, page, grid, notice, refreshButton, countLabel, healthTimer, bootTimer;
  let searchInput, clearSearchButton, searchTimer, layoutFrame, masonryObserver;
  let scrollArea, moreHint;
  let cardEvents = new AbortController();
  let items = [];
  let visibleItems = [];
  let renderedCount = 0;
  let lastQuery = '';
  const BATCH_SIZE = 12;
  let searchIndex = new Map();
  let installed = new Map();
  let loading = false;
  let installing = false;
  let modal;
  const updatedDate = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', timeZone: 'Asia/Shanghai' });
  const downloadNumber = new Intl.NumberFormat('zh-CN');

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function button(label, className, handler, signal = events.signal) {
    const node = element('button', className, label);
    node.type = 'button';
    node.addEventListener('click', handler, { signal });
    return node;
  }
  async function request(route, options = {}) {
    if (typeof api === 'function') return api(route, options);
    const headers = { 'content-type': 'application/json' };
    if (typeof CONSOLE_MARKER !== 'undefined') headers['x-console-token'] = CONSOLE_MARKER;
    const response = await fetch(route, { ...options, headers: { ...headers, ...options.headers } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '请求失败：HTTP ' + response.status);
    return data;
  }
  function action(op, args = {}) {
    return request(ACTION, { method: 'POST', body: JSON.stringify({ op, ...args }) });
  }
  function external() { window.open('https://www.kondius.cn/qq-agent/' + KINDS[kind].external, '_blank', 'noopener'); }
  function say(text, error = false) {
    notice.textContent = text;
    notice.classList.toggle('mp-error', error);
    notice.hidden = !text;
  }
  function dateLabel(value) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? '近期更新' : updatedDate.format(date) + '更新';
  }
  function resetCards() {
    cardEvents.abort();
    cardEvents = new AbortController();
    masonryObserver?.disconnect();
  }
  function empty(text) {
    resetCards();
    visibleItems = [];
    renderedCount = 0;
    moreHint.hidden = true;
    grid.style.height = 'auto';
    grid.classList.remove('mp-laid-out');
    grid.replaceChildren(element('div', 'mp-empty', text));
  }
  function scheduleLayout() {
    if (!layoutFrame) layoutFrame = requestAnimationFrame(layoutMasonry);
  }
  function layoutMasonry() {
    layoutFrame = null;
    if (!grid?.isConnected || !grid.clientWidth) return;
    const cards = [...grid.querySelectorAll('.mp-card')];
    if (!cards.length) return;
    const style = getComputedStyle(grid);
    const columns = Math.max(1, Number(style.getPropertyValue('--mp-columns')) || 3);
    const gap = Number.parseFloat(style.getPropertyValue('--mp-gap')) || 8;
    const step = (grid.clientWidth + gap) / columns;
    const heights = Array(columns).fill(0);
    // Read every height before writing positions to avoid repeated forced layouts.
    const cardHeights = cards.map((card) => card.offsetHeight);
    cards.forEach((card, index) => {
      const column = heights.indexOf(Math.min(...heights));
      const transform = 'translate(' + (column * step) + 'px,' + heights[column] + 'px)';
      if (card.style.transform !== transform) card.style.transform = transform;
      heights[column] += cardHeights[index] + gap;
      card.classList.remove('mp-card-pending');
    });
    const height = Math.max(...heights) - gap + 'px';
    if (grid.style.height !== height) grid.style.height = height;
    grid.classList.add('mp-laid-out');
    maybeLoadMore();
  }
  function maybeLoadMore() {
    if (layoutFrame || modal || !scrollArea?.clientHeight || renderedCount >= visibleItems.length) return;
    const remaining = scrollArea.scrollHeight - scrollArea.scrollTop - scrollArea.clientHeight;
    if (remaining < 240) appendBatch();
  }
  function appendBatch(size = BATCH_SIZE) {
    if (renderedCount >= visibleItems.length) return;
    const end = Math.min(visibleItems.length, renderedCount + size);
    const cards = visibleItems.slice(renderedCount, end).map((item, index) => createCard(item, renderedCount + index));
    renderedCount = end;
    grid.append(...cards);
    moreHint.hidden = false;
    moreHint.textContent = renderedCount < visibleItems.length ? '向下滚动查看更多' + KINDS[kind].label : '全部' + KINDS[kind].label + '已显示';
    masonryObserver?.observe(grid);
    masonryObserver?.observe(scrollArea);
    cards.forEach((card) => masonryObserver?.observe(card));
    scheduleLayout();
  }
  function normalizeSearch(value) { return String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN'); }
  function clearSearch() {
    clearTimeout(searchTimer);
    searchInput.value = '';
    clearSearchButton.hidden = true;
    render();
    searchInput.focus();
  }
  function setInstalling(value) {
    installing = value;
    if (searchInput) searchInput.disabled = value;
    if (clearSearchButton) clearSearchButton.disabled = value;
    if (refreshButton) refreshButton.disabled = value || loading;
    for (const node of kindButtons.values()) node.disabled = value;
    updateSortButtons();
  }
  function updateSortButtons() {
    for (const [key, node] of sortButtons) {
      node.hidden = kind === 'persona' && key === 'downloads';
      node.disabled = installing || loading;
      node.classList.toggle('mp-sort-active', key === sortModes[kind]);
      node.setAttribute('aria-pressed', String(key === sortModes[kind]));
    }
  }
  function selectSort(mode) {
    if (loading || installing || sortModes[kind] === mode || (kind === 'persona' && mode === 'downloads')) return;
    sortModes[kind] = mode;
    updateSortButtons();
    render();
  }
  function updateKindLabels() {
    const label = KINDS[kind].label;
    searchInput.placeholder = kind === 'persona' ? '搜索人设名称、作者或关键词' : '搜索' + label + '标题';
    searchInput.setAttribute('aria-label', '搜索' + label);
    scrollArea.setAttribute('aria-label', label + '列表');
    stripNote.textContent = kind === 'persona' ? '确认后新增 · 自动选择并保存' : '确认后安装 · 默认启用';
    for (const [key, node] of kindButtons) {
      node.classList.toggle('mp-kind-active', key === kind);
      node.setAttribute('aria-pressed', String(key === kind));
    }
    updateSortButtons();
  }
  function selectKind(next) {
    if (installing || kind === next) return;
    kind = next;
    clearTimeout(searchTimer);
    searchInput.value = '';
    clearSearchButton.hidden = true;
    items = [];
    searchIndex.clear();
    scrollArea.scrollTop = 0;
    lastQuery = '';
    updateKindLabels();
    say('');
    countLabel.textContent = '正在加载…';
    empty('正在加载' + KINDS[kind].label + '列表…');
    load(false);
  }
  function mount() {
    const tabs = document.getElementById('tabs');
    const layout = document.getElementById('layout');
    if (!tabs || !layout || typeof switchTab !== 'function') return false;
    const tab = button('市场', 'tab', () => {
      switchTab(TAB);
      load(false);
    });
    tab.dataset.tab = TAB;
    tab.title = '浏览插件、技能和人设市场';
    const anchor = tabs.querySelector('[data-tab="themes"]') || tabs.querySelector('[data-tab="plugins"]');
    if (anchor) anchor.after(tab); else tabs.appendChild(tab);
    view = element('section', 'view');
    view.id = 'view-' + TAB;
    page = element('div', 'mp-page');
    page.id = 'market-preview-page';
    const hero = element('header', 'mp-hero');
    const intro = element('div', 'mp-intro');
    intro.append(element('h1', 'mp-title', '给机器人添一点新本领'));
    const tools = element('div', 'mp-toolbar');
    tools.append(button('外部市场 ↗', 'mp-button mp-secondary', external));
    refreshButton = button('刷新列表', 'mp-button', () => load(true));
    tools.append(refreshButton);
    hero.append(intro, tools);
    const searchRow = element('div', 'mp-search-row');
    const searchBox = element('div', 'mp-search-box');
    const searchIcon = element('span', 'mp-search-icon');
    searchIcon.setAttribute('aria-hidden', 'true');
    searchIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10.8" cy="10.8" r="7.2"/><path d="m16 16 5 5"/></svg>';
    searchInput = element('input', 'mp-search-input');
    searchInput.type = 'search';
    searchInput.placeholder = '搜索插件标题';
    searchInput.setAttribute('aria-label', '搜索插件');
    searchInput.autocomplete = 'off';
    searchInput.maxLength = 200;
    searchInput.addEventListener('input', () => {
      clearSearchButton.hidden = !searchInput.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(render, 100);
    }, { signal: events.signal });
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); clearSearch(); }
    }, { signal: events.signal });
    clearSearchButton = button('×', 'mp-search-clear', clearSearch);
    clearSearchButton.setAttribute('aria-label', '清空搜索');
    clearSearchButton.hidden = true;
    searchBox.append(searchIcon, searchInput, clearSearchButton);
    searchRow.append(searchBox);
    const strip = element('div', 'mp-strip');
    const kinds = element('div', 'mp-kinds');
    kinds.setAttribute('role', 'group');
    kinds.setAttribute('aria-label', '市场类型');
    for (const [key, info] of Object.entries(KINDS)) {
      const node = button(info.label, 'mp-kind', () => selectKind(key));
      node.dataset.marketKind = key;
      kindButtons.set(key, node);
      kinds.append(node);
    }
    strip.append(kinds);
    countLabel = element('span', 'mp-count', '正在加载…');
    countLabel.setAttribute('role', 'status');
    countLabel.setAttribute('aria-live', 'polite');
    stripNote = element('span', 'mp-strip-note');
    const sort = element('div', 'mp-sort');
    sort.setAttribute('role', 'group');
    sort.setAttribute('aria-label', '市场排序');
    sort.append(element('span', 'mp-sort-label', '排序'));
    for (const [key, label] of [['updated', '最近更新'], ['downloads', '下载量']]) {
      const node = button(label, 'mp-sort-button', () => selectSort(key));
      node.dataset.marketSort = key;
      node.title = key === 'downloads' ? '下载量从高到低，同下载量时最近更新优先' : '更新时间从新到旧';
      sortButtons.set(key, node);
      sort.append(node);
    }
    strip.append(countLabel, sort, stripNote);
    notice = element('div', 'mp-notice');
    notice.hidden = true;
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    grid = element('div', 'mp-grid');
    const fixed = element('div', 'mp-fixed');
    fixed.append(hero, searchRow, strip, notice);
    scrollArea = element('div', 'mp-scroll');
    scrollArea.id = 'market-preview-scroll';
    scrollArea.tabIndex = 0;
    scrollArea.setAttribute('role', 'region');
    scrollArea.setAttribute('aria-label', '插件列表');
    updateKindLabels();
    moreHint = element('div', 'mp-more-hint');
    moreHint.hidden = true;
    scrollArea.append(grid, moreHint);
    scrollArea.addEventListener('scroll', maybeLoadMore, { passive: true, signal: events.signal });
    // Wheel gestures over the fixed search/header should scroll the list too.
    view.addEventListener('wheel', (event) => {
      if (modal || event.ctrlKey || !event.deltaY || scrollArea.contains(event.target)) return;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scrollArea.clientHeight : 1;
      event.preventDefault();
      scrollArea.scrollBy({ top: event.deltaY * unit, behavior: 'auto' });
      maybeLoadMore();
    }, { passive: false, signal: events.signal });
    page.append(fixed, scrollArea);
    view.append(page);
    layout.append(view);
    if (typeof ResizeObserver === 'function') masonryObserver = new ResizeObserver(scheduleLayout);
    window.addEventListener('resize', scheduleLayout, { signal: events.signal });
    document.fonts?.ready.then(scheduleLayout).catch(() => {});
    empty('打开市场页后加载插件列表。');
    return true;
  }
  function render({ preservePosition = false } = {}) {
    const keywords = normalizeSearch(searchInput.value).trim().split(/\s+/).filter(Boolean);
    const filtered = keywords.length ? items.filter((item) => keywords.every((word) => searchIndex.get(item.id)?.includes(word))) : items.slice();
    filtered.sort((a, b) => {
      const recent = (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
      return kind !== 'persona' && sortModes[kind] === 'downloads'
        ? (Number(b.downloads) || 0) - (Number(a.downloads) || 0) || recent
        : recent;
    });
    const query = keywords.join(' ');
    const keepPosition = preservePosition && query === lastQuery;
    const limit = keepPosition ? Math.max(BATCH_SIZE, renderedCount) : BATCH_SIZE;
    lastQuery = query;
    if (!keepPosition) scrollArea.scrollTop = 0;
    countLabel.textContent = keywords.length ? '找到 ' + filtered.length + ' 项 / 共 ' + items.length + ' 项' : '全部 ' + items.length + ' 项';
    if (!items.length) { empty('暂时没有可用的' + KINDS[kind].label + '。'); return; }
    if (!filtered.length) { empty('没有找到匹配的' + KINDS[kind].label + '，试试其他关键词。'); return; }
    resetCards();
    visibleItems = filtered;
    renderedCount = 0;
    grid.classList.remove('mp-laid-out');
    grid.replaceChildren();
    appendBatch(limit);
  }
  function createCard(item, index) {
      const card = element('article', 'mp-card mp-card-pending');
      card.dataset.marketId = item.id;
      const head = element('div', 'mp-card-head');
      const symbol = element('div', 'mp-symbol mp-symbol-' + (index % 3), Array.from(item.name)[0]);
      symbol.setAttribute('aria-hidden', 'true');
      const titles = element('div', 'mp-card-titles');
      titles.append(element('span', 'mp-category', item.categoryName), element('h2', 'mp-card-title', item.name));
      head.append(symbol, titles);
      const description = element('p', 'mp-description', item.description);
      const meta = element('div', 'mp-meta');
      meta.append(element('span', '', item.author));
      if (kind !== 'persona') meta.append(element('span', '', 'v' + (item.version || '未知')));
      meta.append(element('span', '', dateLabel(item.updatedAt)));
      if (kind !== 'persona') {
        const downloads = element('span', 'mp-downloads', '下载量 ' + downloadNumber.format(item.downloads || 0));
        downloads.title = '官网市场的口令安装下载次数（同设备去重）';
        meta.append(downloads);
      }
      const footer = element('div', 'mp-card-footer');
      footer.append(button(kind === 'persona' ? '查看人设' : '查看说明', 'mp-text-button', () => showDescription(item), cardEvents.signal));
      const status = kind === 'persona' ? null : installed.get(item.id);
      const added = kind === 'persona' && addedPersonas.has(item.id);
      const retrySelection = kind === 'persona' && savedPersonas.has(item.id) && !added;
      const installButton = button(status ? '已安装' : added ? '已添加' : retrySelection ? '选择并保存' : KINDS[kind].install,
        'mp-button mp-install', () => kind === 'persona' ? preparePersona(item, installButton) : prepare(item, installButton), cardEvents.signal);
      installButton.disabled = Boolean(status) || added || installing;
      if (status) installButton.title = '已安装，可在原有「' + KINDS[kind].label + '」页管理';
      if (added) installButton.title = '已新增到设置 → 人设，可在那里选择';
      footer.append(installButton);
      card.append(head, description, meta, footer);
      return card;
  }
  async function load(force) {
    if ((loading && loadingKind === kind) || installing) return;
    const requestedKind = kind;
    const sequence = ++loadSequence;
    loadingKind = kind;
    loading = true;
    updateSortButtons();
    refreshButton.disabled = true;
    refreshButton.textContent = '正在刷新…';
    if (!items.length) empty('正在加载' + KINDS[kind].label + '列表…');
    try {
      const [catalog, statuses] = await Promise.all([
        action('list', { force, kind: requestedKind }), request('/api/skills')
      ]);
      if (sequence !== loadSequence || events.signal.aborted) return;
      installed = new Map((statuses.skills || []).map((s) => [s.id, s]));
      items = catalog.items || [];
      searchIndex = new Map(items.map((item) => [item.id, normalizeSearch(requestedKind === 'persona'
        ? [item.id, item.name, item.author, item.description, item.category, item.categoryName].join(' ')
        : item.name)]));
      say('');
      render({ preservePosition: !force });
    } catch (error) {
      if (sequence !== loadSequence || events.signal.aborted) return;
      say(error.message + '。可以使用「外部市场」继续访问。', true);
      if (!items.length) empty('市场暂时无法连接，请稍后刷新。');
    } finally {
      if (sequence === loadSequence) {
        loading = false;
        updateSortButtons();
        refreshButton.disabled = installing;
        refreshButton.textContent = '刷新列表';
      }
    }
  }
  function dialog(title) {
    if (modal) modal.close();
    const previouslyFocused = document.activeElement;
    const overlay = element('div', 'mp-overlay');
    const panel = element('section', 'mp-dialog');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'mp-dialog-title');
    const top = element('div', 'mp-dialog-head');
    const heading = element('h2', '', title);
    heading.id = 'mp-dialog-title';
    const closeButton = button('×', 'mp-close', () => current.close());
    closeButton.setAttribute('aria-label', '关闭');
    top.append(heading, closeButton);
    const body = element('div', 'mp-dialog-body');
    const message = element('div', 'mp-dialog-message');
    message.hidden = true;
    message.setAttribute('role', 'status');
    const footer = element('div', 'mp-dialog-footer');
    panel.append(top, body, message, footer);
    overlay.append(panel);
    document.body.append(overlay);
    const keyboard = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); current.close(); }
      if (event.key !== 'Tab') return;
      const focusable = [...panel.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),textarea:not(:disabled)')];
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    overlay.addEventListener('keydown', keyboard, true);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) current.close(); });
    const current = {
      body, footer, message, locked: false, onClose: null,
      close() {
        if (current.locked) return;
        overlay.remove();
        if (modal === current) modal = null;
        current.onClose?.();
        if (previouslyFocused?.isConnected) previouslyFocused.focus();
        if (!events.signal.aborted) scheduleLayout();
      },
      status(text, error = false) {
        message.hidden = !text;
        message.textContent = text;
        message.classList.toggle('mp-error', error);
      },
      lock(value) {
        current.locked = value;
        closeButton.disabled = value;
        panel.querySelectorAll('button').forEach((b) => { b.disabled = value; });
      }
    };
    modal = current;
    closeButton.focus();
    return current;
  }
  function showDescription(item) {
    if (kind === 'persona') return showPersona(item);
    const box = dialog(item.name);
    box.body.append(element('div', 'mp-dialog-meta', item.author + (kind === 'persona' ? '' : ' · v' + item.version) + ' · ' + item.categoryName));
    box.body.append(element('div', 'mp-full-description', item.description));
    box.footer.append(button('关闭', 'mp-button mp-secondary', () => box.close()));
    if (kind === 'persona' ? !addedPersonas.has(item.id) : !installed.has(item.id)) {
      const installButton = button(kind === 'persona' && savedPersonas.has(item.id) ? '选择并保存' : KINDS[kind].install, 'mp-button', () => {
        box.close();
        if (kind === 'persona') preparePersona(item, installButton);
        else prepare(item, installButton);
      });
      box.footer.append(installButton);
    }
  }
  async function showPersona(item) {
    const box = dialog(item.name);
    box.body.append(element('div', 'mp-dialog-meta', item.author + ' · ' + item.categoryName));
    const content = element('div', 'mp-full-description mp-persona-content', '正在读取人设正文…');
    content.setAttribute('aria-label', '人设正文');
    box.body.append(content);
    box.footer.append(button('关闭', 'mp-button mp-secondary', () => box.close()));
    try {
      const { persona } = await action('persona-preview', { id: item.id });
      if (modal !== box || events.signal.aborted) return;
      content.textContent = persona.text;
      if (!addedPersonas.has(item.id)) {
        const installButton = button(savedPersonas.has(item.id) ? '选择并保存' : '添加人设', 'mp-button', () => {
          box.close();
          preparePersona(item, installButton);
        });
        box.footer.append(installButton);
      }
    } catch (error) {
      if (modal !== box || events.signal.aborted) return;
      content.textContent = '人设正文暂时无法读取，请关闭后重试。';
      box.status(error.message, true);
    }
  }
  async function prepare(item, trigger) {
    if (installing) return;
    setInstalling(true);
    const oldLabel = trigger.textContent;
    trigger.disabled = true;
    trigger.textContent = '检查安装包…';
    try {
      const preview = await action('preview', { code: item.installCode, id: item.id, kind });
      const plugin = preview.extension;
      const label = KINDS[preview.kind].label;
      const box = dialog('安装这个' + label + '？');
      box.onClose = () => { action('discard', { ticket: preview.ticket }).catch(() => {}); };
      box.body.append(element('h3', 'mp-confirm-name', plugin.name));
      box.body.append(element('div', 'mp-dialog-meta', plugin.author + ' · v' + plugin.version));
      box.body.append(element('p', 'mp-confirm-description', plugin.description || item.description));
      const summary = element('div', 'mp-package-summary');
      summary.append(element('div', '', '文件已检查 · ' + plugin.fileCount + ' 个文件'));
      if (plugin.nestingDepth > 1) summary.append(element('div', '', '已识别多层包装目录，安装时会自动整理。'));
      summary.append(element('div', 'mp-enable-note', '✓ 安装后默认启用'));
      box.body.append(summary, element('p', 'mp-consent-note', '将运行这个' + label + '的代码。之后可在「' + label + '」页关闭或删除。'));
      if (plugin.requires?.length) box.body.append(element('p', 'mp-requires', '依赖能力：' + plugin.requires.join('、')));
      box.footer.append(button('取消', 'mp-button mp-secondary', () => box.close()));
      box.footer.append(button('安装并启用', 'mp-button', () => install(preview, box)));
    } catch (error) { say(error.message, true); }
    finally {
      setInstalling(false);
      trigger.disabled = false;
      trigger.textContent = oldLabel;
    }
  }
  async function waitLoaded(id, expectedKind, rescanned = false) {
    for (let n = 0; n < 20; n++) {
      const data = await request('/api/skills');
      const found = data.skills?.find((s) => s.id === id && s.kind === expectedKind);
      if (found) {
        if (!found.loaded) throw new Error(found.reason || '扩展加载失败');
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!rescanned) {
      // Atomic publication already triggers the host watcher. Avoid overlapping
      // a manual full reload with it; rescan only if the watcher missed the package.
      await request('/api/skills/reload', { method: 'POST', body: '{}' });
      return waitLoaded(id, expectedKind, true);
    }
    throw new Error('扩展文件已安装，但没有出现在加载列表中');
  }
  async function install(preview, box) {
    if (installing || box.locked) return;
    setInstalling(true);
    box.lock(true);
    box.status('正在安装…');
    let result;
    try {
      result = await action('install', { ticket: preview.ticket, kind: preview.kind, confirmed: true });
      box.onClose = null;
      box.status('正在加载并启用…');
      await waitLoaded(result.id, result.kind);
      const enabled = await request('/api/skills/' + encodeURIComponent(result.id), {
        method: 'POST', body: JSON.stringify({ enabled: true })
      });
      box.lock(false);
      box.close();
      setInstalling(false);
      await load(false);
      say(enabled.skill?.active
        ? '已安装并启用「' + preview.extension.name + '」，可在「' + KINDS[result.kind].label + '」页管理。'
        : '已安装并打开开关；暂未生效：' + (enabled.skill?.reason || '请到「' + KINDS[result.kind].label + '」页检查配置'), !enabled.skill?.active);
    } catch (error) {
      box.lock(false);
      box.status((result ? '文件已安装，加载或自动启用失败：' : '安装失败：') + error.message, true);
      if (result) {
        box.onClose = null;
        box.footer.replaceChildren(button('关闭', 'mp-button mp-secondary', () => { box.close(); load(false); }));
        say('「' + preview.extension.name + '」已落盘，请在「' + KINDS[result.kind].label + '」页查看加载状态。', true);
      }
    } finally { setInstalling(false); }
  }
  async function preparePersona(item, trigger) {
    if (installing) return;
    setInstalling(true);
    const oldLabel = trigger.textContent;
    trigger.disabled = true;
    trigger.textContent = '读取提示词…';
    try {
      const saved = savedPersonas.get(item.id);
      const persona = saved || (await action('persona-preview', { id: item.id })).persona;
      if (events.signal.aborted) return;
      const box = dialog(saved ? '选择这个人设？' : '添加并使用这个人设？');
      box.onClose = () => {
        if (savedPersonas.has(item.id) && !addedPersonas.has(item.id)) {
          render({ preservePosition: true });
          say('人设已添加，但当前选择尚未保存。可点击「选择并保存」重试。', true);
        }
      };
      box.body.append(element('div', 'mp-dialog-meta', persona.author));
      const nameLabel = element('label', 'mp-persona-label', '人设名称');
      nameLabel.htmlFor = 'mp-persona-name';
      const nameInput = element('input', 'mp-persona-name');
      nameInput.id = 'mp-persona-name';
      nameInput.type = 'text';
      nameInput.maxLength = 50;
      nameInput.value = persona.name;
      nameInput.disabled = Boolean(saved);
      const textLabel = element('label', 'mp-persona-label', '角色设定');
      textLabel.htmlFor = 'mp-persona-text';
      const textInput = element('textarea', 'mp-persona-text');
      textInput.id = 'mp-persona-text';
      textInput.readOnly = true;
      textInput.value = persona.text;
      box.body.append(nameLabel, nameInput, textLabel, textInput);
      if (persona.name !== persona.originalName) {
        box.body.append(element('p', 'mp-consent-note', '原名称：' + persona.originalName + '。本机人设名称最多 50 字，可在上方调整。'));
      }
      box.body.append(element('p', 'mp-enable-note', '新增后自动选择为全局人设并保存，原有人设条目保留。'));
      box.footer.append(button('取消', 'mp-button mp-secondary', () => box.close()));
      box.footer.append(button(saved ? '选择并保存' : '确认添加并使用', 'mp-button', () => addPersona(persona, nameInput, box)));
    } catch (error) { if (!events.signal.aborted) say(error.message, true); }
    finally {
      setInstalling(false);
      trigger.disabled = false;
      trigger.textContent = oldLabel;
    }
  }
  async function addPersona(persona, nameInput, box) {
    if (installing || box.locked) return;
    const name = savedPersonas.get(persona.id)?.name || nameInput.value.trim();
    if (!name || name.length > 50) { box.status('请输入 1～50 字的人设名称。', true); return; }
    setInstalling(true);
    box.lock(true);
    nameInput.disabled = true;
    box.status('正在添加…');
    try {
      if (!savedPersonas.has(persona.id)) {
        // Append first, preserving every existing template. Remember success so
        // a failed selection can be retried without appending the same item again.
        const result = await request('/api/persona-templates', {
          method: 'POST', body: JSON.stringify({ name, text: persona.text })
        });
        if (result.ok !== true) throw new Error(result.error || '人设添加失败');
        savedPersonas.set(persona.id, { ...persona, name });
      }
      box.status('正在选择并保存…');
      await waitForSettingsSave();
      const selected = await request('/api/config', {
        method: 'POST', body: JSON.stringify({ persona: { roleText: persona.text, customRules: '' } })
      });
      if (selected.ok !== true || selected.config?.persona?.roleText !== persona.text
        || selected.config?.persona?.customRules !== '') throw new Error(selected.error || '人设选择未能保存');
      // Match the host picker, which derives selection from the saved role text.
      // Refresh stale hidden editors too, so later autosaves keep the new choice.
      if (typeof state !== 'undefined') state.config = selected.config;
      const roleEditor = document.getElementById('cfg-roletext');
      const rulesEditor = document.getElementById('cfg-customrules');
      const picker = document.getElementById('cfg-persona-pick');
      if (roleEditor) roleEditor.value = persona.text;
      if (rulesEditor) rulesEditor.value = '';
      if (picker) picker.value = name;
      addedPersonas.add(persona.id);
      box.onClose = null;
      box.lock(false);
      box.close();
      setInstalling(false);
      render({ preservePosition: true });
      say('已新增并选择人设「' + name + '」，设置已保存。'
        + (selected.config.personaUnified === false ? '已单独配置人设的会话继续沿用各自设置。' : ''));
      if (typeof loadSettings === 'function') loadSettings().catch(() => {});
    } catch (error) {
      box.lock(false);
      const saved = savedPersonas.has(persona.id);
      nameInput.disabled = saved;
      box.status((saved ? '人设已添加，自动选择保存失败：' : '添加失败：') + error.message, true);
      if (saved) box.footer.replaceChildren(
        button('关闭', 'mp-button mp-secondary', () => box.close()),
        button('重试选择并保存', 'mp-button', () => addPersona(persona, nameInput, box))
      );
    } finally { setInstalling(false); }
  }
  async function waitForSettingsSave() {
    for (let n = 0; n < 100; n++) {
      if (typeof settingsGuard === 'undefined' || !settingsGuard.pending) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('设置仍在保存，请稍后重试');
  }
  function teardown() {
    clearTimeout(bootTimer);
    clearInterval(healthTimer);
    clearTimeout(searchTimer);
    cancelAnimationFrame(layoutFrame);
    masonryObserver?.disconnect();
    cardEvents.abort();
    events.abort();
    if (modal) { modal.locked = false; modal.close(); }
    if (view?.classList.contains('active') && typeof switchTab === 'function') switchTab('plugins');
    document.querySelector('#tabs [data-tab="' + TAB + '"]')?.remove();
    view?.remove();
    delete window.__marketPreviewHost;
  }
  async function health() {
    try {
      const data = await request('/api/skills');
      if (!data.skills?.some((s) => s.id === ID && s.active)) teardown();
    } catch { /* A failed request must not interfere with the rest of the console. */ }
  }
  async function boot(attempt = 0) {
    try {
      const data = await request('/api/skills');
      if (!data.skills?.some((s) => s.id === ID && s.active)) return;
      // QQ Agent loads its core scripts dynamically after DOMContentLoaded.
      // Wait for switchTab to exist rather than silently losing the page tab.
      if (!mount()) {
        if (attempt < 40) bootTimer = setTimeout(() => boot(attempt + 1), 150);
        else console.warn('[market-preview] 控制台页面接口未就绪，页面未挂载');
        return;
      }
      window.__marketPreviewHost = {
        get count() { return items.length; },
        get dialogOpen() { return Boolean(modal); },
        get busy() { return installing; }
      };
      healthTimer = setInterval(health, 15000);
    } catch (error) {
      if (attempt < 40) bootTimer = setTimeout(() => boot(attempt + 1), 150);
      else console.warn('[market-preview] 页面未挂载：', error.message);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
