// 主题模式（爱莉希雅 / 女仆工坊）· 多主题保险插件 v2
//
// 背景：QQ Agent 的扩展系统（plugins/ / skills/）只管机器人的对话行为，没有任何
// 前端接口（官方文档明确 ui/*.js 由人工维护），主题只能往控制台展示层注入。
// 本插件作为「保险」兜底，并升级为多主题管理器：
//   1. 自带两套主题源文件（ui/）：elysia（爱莉希雅粉色妖精）、maid-atelier
//      （深海女仆工坊）。每次 QQ Agent 启动（插件激活）自动自检：当前主题
//      文件缺失/损坏 → 从内置副本补拷；index.html 引用丢失/被别的主题占用 → 修复。
//   2. 可随时切换主题（apply <theme>）：切换 = 先摘掉所有已注入的主题引用，
//      再注入目标主题的引用（文件都放 ui/ 下，互不覆盖）。
//   3. 可删除插件内置的某套主题资源（delete <theme>）：从本插件的 ui/ 内置副本
//      中移除，之后该主题不能再被 apply/自愈补装（不影响已安装的现状）。
//   4. 设置 mode=off 时还原 index.html（优先用原始备份整份还原，无备份则摘掉
//      注入行）并删除全部主题文件；mode=on 时按 settings.theme 应用默认主题。
//   5. 提供 theme-mode.status / list / apply / restore / delete 五个能力，并注册
//      「主题模式」聊天工具，模型在用户提到 主题/皮肤/换肤/女仆/爱莉希雅 时调用。
//
// 路径约定：ROOT 复用核心 config.js 的唯一真源（与 conversation-memory 一致），
// 不自行拼路径，避免多实例/便携场景下算错根目录。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ROOT 复用核心 config.js 的唯一真源，但**不能写死 ../../**：
// 插件目录多套一层（plugins/theme-mode/theme-mode/index.js，解压时常见）时，
// '../../src/config.js' 会指到 plugins/src/ 并报 Cannot find module。
// 改成从本文件所在目录向上找 src/config.js —— 两种目录结构下都对。
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
function findAppRoot(start) {
  let d = start;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(d, 'src', 'config.js'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  throw new Error('theme-mode：向上 6 层都没找到 src/config.js，无法确定 QQ Agent 根目录');
}
const { ROOT } = await import(pathToFileURL(path.join(findAppRoot(PLUGIN_DIR), 'src', 'config.js')).href);

const UI_DIR = path.join(ROOT, 'ui');
const INDEX = path.join(UI_DIR, 'index.html');
const SRC_UI = path.join(PLUGIN_DIR, 'ui');
const ORIGINAL_BACKUP = path.join(UI_DIR, 'index.html.bak-before-theme-mode');
const LEGACY_BACKUP = path.join(UI_DIR, 'index.html.bak-before-maid-atelier');
const TOOL_ID = 'theme-mode';
/** 主题切换器前端脚本（两套主题共用，随 index.html 注入，供顶栏下拉 UI 使用）。 */
const SWITCHER_FILE = 'theme-switcher.js';
/** 切换器 UI 读取的状态快照（由本插件每次自检/切换后写入 ui/，同源可读）。 */
const STATUS_FILE = 'theme-mode-status.json';

/** 内置主题注册表：id → 名称/文件/素材目录/注入标记。 */
const THEMES = {
  elysia: {
    name: '爱莉希雅粉色妖精',
    icon: '🌸',
    cssFile: 'theme-elysia.css',
    jsFile: 'theme-elysia.js',
    artDir: 'elysia',
    link: '  <link rel="stylesheet" href="/theme-elysia.css" />',
    script: '  <script defer src="/theme-elysia.js"></script>',
    comment: '  <!-- 爱莉希雅粉色妖精主题（展示层覆盖）。删掉这两行即恢复原样式 -->'
  },
  'maid-atelier': {
    name: '深海女仆工坊',
    icon: '🎀',
    cssFile: 'theme-maid-atelier.css',
    jsFile: 'theme-maid-atelier.js',
    artDir: 'maid-atelier',
    link: '  <link rel="stylesheet" href="/theme-maid-atelier.css" />',
    script: '  <script defer src="/theme-maid-atelier.js"></script>',
    comment: '  <!-- 深海女仆工坊主题（展示层覆盖）。删掉这两行即恢复原样式 -->'
  }
};

/**
 * 自动发现插件 ui/ 目录里的新主题（约定：目录名 = 主题 id，且 ui/ 根下存在
 * theme-<id>.css 与 theme-<id>.js；可选 <id>/theme.json 提供 {name, icon}）。
 * 静态注册表（THEMES）优先级更高，同 id 不会被发现结果覆盖。
 */
function discoverThemes() {
  const out = {};
  let entries = [];
  try { entries = fs.readdirSync(SRC_UI, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const id = e.name;
    if (THEMES[id]) continue;
    const cssFile = 'theme-' + id + '.css';
    const jsFile = 'theme-' + id + '.js';
    if (!fileExists(path.join(SRC_UI, cssFile)) || !fileExists(path.join(SRC_UI, jsFile))) continue;
    let name = id, icon = '🎨';
    const manifest = path.join(SRC_UI, id, 'theme.json');
    if (fileExists(manifest)) {
      try {
        const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (m && m.name) name = String(m.name);
        if (m && m.icon) icon = String(m.icon);
      } catch { /* 清单坏了不致命，用目录名兜底 */ }
    }
    out[id] = {
      name, icon, cssFile, jsFile, artDir: id,
      link: '  <link rel="stylesheet" href="/' + cssFile + '" />',
      script: '  <script defer src="/' + jsFile + '"></script>',
      comment: '  <!-- ' + name + '主题（展示层覆盖）。删掉这两行即恢复原样式 -->'
    };
  }
  return out;
}

/** 合并注册表：静态内置 + 自动发现。 */
function allThemes() {
  return Object.assign({}, THEMES, discoverThemes());
}

let api = null;

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  return {
    mode: String(raw.mode ?? 'on').trim().toLowerCase(),
    theme: String(raw.theme ?? '').trim(),
    deleteTheme: String(raw.deleteTheme ?? '').trim()
  };
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

/** css/js 是否缺失或损坏（损坏 = 小于 1KB，正常文件都在 30KB 以上）。 */
function broken(p) {
  if (!fileExists(p)) return true;
  try { return fs.statSync(p).size < 1024; } catch { return true; }
}

/** 主题素材目录是否缺失或为空。 */
function artBroken(t) {
  const art = path.join(UI_DIR, t.artDir);
  if (!fileExists(art)) return true;
  try { return fs.readdirSync(art).length === 0; } catch { return true; }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function readIndex() {
  if (!fileExists(INDEX)) throw new Error('未找到 ui/index.html（QQ Agent 目录结构不识别）');
  return fs.readFileSync(INDEX, 'utf8');
}

/** 摘掉 index.html 里所有主题注入（注释 + link + script），跨主题通用。
    兼容带缓存版本戳的引用（如 /theme-elysia.css?v=xxx）。 */
function stripThemeRefs(html) {
  const before = html;
  html = html.replace(/^\s*<!--.*展示层覆盖.*-->\s*$/gm, '');
  html = html.replace(/^\s*<link rel="stylesheet" href="\/theme-[^"]+\.css[^"]*" \/>\s*$/gm, '');
  html = html.replace(/^\s*<script defer src="\/theme-(?!host|switcher)[^"]+\.js[^"]*"><\/script>\s*$/gm, '');
  html = html.replace(/\r?\n(\r?\n)+/g, '\r\n');
  return html !== before ? html : before;
}

/** 确保切换器脚本已同步到 ui/ 且已注入 index.html（两套主题共用，幂等）。 */
function ensureSwitcher(html) {
  const src = path.join(SRC_UI, SWITCHER_FILE);
  const dst = path.join(UI_DIR, SWITCHER_FILE);
  if (fileExists(src) && !fileExists(dst)) fs.copyFileSync(src, dst);
  let out = html;
  if (!out.includes(SWITCHER_FILE)) {
    const scriptTag = `  <script defer src="/${SWITCHER_FILE}"></script>`;
    if (out.includes('</body>')) {
      out = out.replace('</body>', `${scriptTag}\r\n</body>`);
    } else if (out.includes('</html>')) {
      out = out.replace('</html>', `${scriptTag}\r\n</html>`);
    }
  }
  return out;
}

/** 写状态快照给切换器下拉 UI（同源静态文件，失败静默）。 */
function syncStatusFile() {
  try {
    const s = status();
    fs.writeFileSync(path.join(UI_DIR, STATUS_FILE), JSON.stringify({
      mode: s.mode,
      defaultTheme: s.defaultTheme,
      appliedTheme: s.appliedTheme,
      backupExists: s.backupExists,
      missing: s.missing,
      themes: Object.fromEntries(Object.entries(s.themes).map(([id, t]) => [id, {
        id: t.id, name: t.name, icon: t.icon, bundled: t.bundled, ready: t.ready
      }]))
    }, null, 1), 'utf8');
  } catch (error) {
    api?.warn?.('写主题状态快照失败：' + (error?.message ?? error));
  }
}

/** 备份：采用 or 生成唯一原始备份。兼容旧插件留下的 maid 备份。 */
function ensureOriginalBackup() {
  if (!fileExists(ORIGINAL_BACKUP)) {
    if (fileExists(LEGACY_BACKUP)) fs.copyFileSync(LEGACY_BACKUP, ORIGINAL_BACKUP);
    else if (fileExists(INDEX)) fs.copyFileSync(INDEX, ORIGINAL_BACKUP);
  }
  return fileExists(ORIGINAL_BACKUP);
}

function themeOf(tid) {
  const t = allThemes()[tid];
  if (!t) throw new Error(`未知主题：${tid}（可用：${Object.keys(allThemes()).join(' / ')}）`);
  return t;
}

function themeBundled(tid) {
  const t = allThemes()[tid];
  if (!t) return false;
  return fileExists(path.join(SRC_UI, t.cssFile)) && fileExists(path.join(SRC_UI, t.jsFile)) &&
         fileExists(path.join(SRC_UI, t.artDir)) && !artBrokenIn(t);
}

function artBrokenIn(t) {
  const art = path.join(SRC_UI, t.artDir);
  if (!fileExists(art)) return true;
  try { return fs.readdirSync(art).length === 0; } catch { return true; }
}

/** 当前 index.html 应用的是哪套主题（按引用行判断），没有则 null。 */
function appliedTheme(html) {
  for (const [id, t] of Object.entries(allThemes())) {
    if (html.includes(t.cssFile) || html.includes(t.jsFile)) return id;
  }
  return null;
}

/** 单主题状态。 */
function themeStatus(tid) {
  const t = allThemes()[tid];
  const cssOk = !broken(path.join(UI_DIR, t.cssFile));
  const jsOk = !broken(path.join(UI_DIR, t.jsFile));
  const artOk = !artBroken(t);
  return {
    id: tid,
    name: t.name,
    icon: t.icon,
    bundled: themeBundled(tid),
    cssOk,
    jsOk,
    artOk,
    ready: cssOk && jsOk && artOk
  };
}

/** 全局状态（能力 / 工具 / 自检日志共用）。 */
function status() {
  const indexExists = fileExists(INDEX);
  let html = '';
  if (indexExists) { try { html = fs.readFileSync(INDEX, 'utf8'); } catch { html = ''; } }
  const applied = appliedTheme(html);
  const themes = {};
  for (const id of Object.keys(allThemes())) themes[id] = themeStatus(id);
  const missing = [];
  if (!applied) {
    missing.push('index.html 未注入任何主题');
  } else {
    const ts = themes[applied];
    if (!ts.ready) missing.push(`${ts.name}：文件不完整`);
  }
  return {
    mode: settings().mode,
    defaultTheme: settings().theme,
    appRoot: ROOT,
    uiDir: UI_DIR,
    indexExists,
    backupExists: fileExists(ORIGINAL_BACKUP) || fileExists(LEGACY_BACKUP),
    appliedTheme: applied,
    themes,
    missing
  };
}

/** 安装 / 自愈：备份 → 补拷目标主题文件 → 摘掉所有旧引用 → 注入目标引用。幂等。 */
function ensureInstalled(tid) {
  const t = themeOf(tid);
  if (!fileExists(INDEX)) throw new Error('未找到 ui/index.html');
  ensureOriginalBackup();
  // 1) 先补拷主题文件（缺失或损坏都修复；内置副本被删则无法自愈，仅报缺）
  //    必须先补文件再读 mtime：否则文件缺失时 statSync 直接抛错，自愈永远失败。
  if (!themeBundled(tid)) throw new Error(`主题「${t.name}」的内置副本已被删除，无法补装。请先 restore 或重新安装插件。`);
  if (broken(path.join(UI_DIR, t.cssFile))) fs.copyFileSync(path.join(SRC_UI, t.cssFile), path.join(UI_DIR, t.cssFile));
  if (broken(path.join(UI_DIR, t.jsFile))) fs.copyFileSync(path.join(SRC_UI, t.jsFile), path.join(UI_DIR, t.jsFile));
  if (artBroken(t)) copyDir(path.join(SRC_UI, t.artDir), path.join(UI_DIR, t.artDir));
  /* 缓存版本戳 = 主题 CSS 的修改时间；改主题文件后刷新页面即自动绕过浏览器缓存 */
  let cacheV = String(Math.floor(Date.now()));
  try { cacheV = String(Math.floor(fs.statSync(path.join(UI_DIR, t.cssFile)).mtimeMs || 0)); } catch { /* 保留兜底时间戳 */ }
  const linkTag = t.link.replace('</style>', '').replace(/href="\/theme-[^"]+\.css"/, 'href="/' + t.cssFile + '?v=' + cacheV + '"');
  const scriptTag = t.script.replace(/src="\/theme-[^"]+\.js"/, 'src="/' + t.jsFile + '?v=' + cacheV + '"');
  // 2) index.html：摘旧引用 → 注入新引用（幂等）
  let html = readIndex();
  html = stripThemeRefs(html);
  let changed = false;
  if (!html.includes(t.cssFile)) {
    const anchor = '  <link rel="stylesheet" href="/style.css" />';
    if (html.includes(anchor)) {
      html = html.replace(anchor, `${anchor}\r\n${t.comment}\r\n${linkTag}`);
    } else if (html.includes('</head>')) {
      html = html.replace('</head>', `${t.comment}\r\n${linkTag}\r\n</head>`);
    } else {
      throw new Error('index.html 结构不识别（找不到 </head>），已中止且未改动');
    }
    changed = true;
  }
  if (!html.includes(t.jsFile)) {
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${scriptTag}\r\n</body>`);
      changed = true;
    }
    // 找不到 </body> 只影响「素材来源」按钮，不影响主题外观，跳过即可
  }
  // 3) 切换器脚本：同步 + 注入（两套主题共用）
  const htmlAfter = ensureSwitcher(html);
  if (htmlAfter !== html) changed = true;
  html = htmlAfter;
  if (changed) fs.writeFileSync(INDEX, html, 'utf8');
  const s = status();
  syncStatusFile();
  return s;
}

/** 还原：优先整份还原原始备份，无备份则摘掉注入行；然后删除全部主题文件。 */
function ensureRemoved() {
  // 不再整份还原旧备份：备份拍摄于本插件安装前，缺少后续版本新增的功能区与其它
  // 插件的注入（如主题接口的 theme-host），整份覆盖会丢掉它们。只摘本插件引用。
  if (fileExists(INDEX)) {
    let html = readIndex();
    let out = stripThemeRefs(html);
    // 切换器是共用 UI：还原到原版后也要能打开下拉切回主题
    out = ensureSwitcher(out);
    if (out !== html) fs.writeFileSync(INDEX, out, 'utf8');
  }
  for (const t of Object.values(allThemes())) {
    for (const f of [t.cssFile, t.jsFile]) {
      const p = path.join(UI_DIR, f);
      if (fileExists(p)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
    }
    const art = path.join(UI_DIR, t.artDir);
    if (fileExists(art)) { try { fs.rmSync(art, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
  // 保留切换器脚本与状态文件：原版状态下设置面板仍能打开下拉，随时切回其它主题。
  const s = status();
  syncStatusFile();
  return s;
}

/** 还原原版外观但保留主题文件：只摘掉 index.html 里的注入引用（切回主题时可复用）。 */
function ensureOriginalOnly() {
  if (fileExists(INDEX)) {
    let html = readIndex();
    let out = stripThemeRefs(html);
    // 切换器是共用 UI：还原到原版后也要能打开下拉切回主题
    out = ensureSwitcher(out);
    if (out !== html) fs.writeFileSync(INDEX, out, 'utf8');
  }
  const s = status();
  syncStatusFile();
  return s;
}

/** 删除某套主题的插件内置副本（不动已安装现状；之后再 apply 会提示缺副本）。 */
function deleteBundledTheme(tid) {
  const t = themeOf(tid);
  const applied = appliedTheme(readIndexSafe());
  for (const f of [t.cssFile, t.jsFile]) {
    const p = path.join(SRC_UI, f);
    if (fileExists(p)) { try { fs.unlinkSync(p); } catch { /* ignore */ } }
  }
  const art = path.join(SRC_UI, t.artDir);
  if (fileExists(art)) { try { fs.rmSync(art, { recursive: true, force: true }); } catch { /* ignore */ } }
  const s = status();
  s.deletedTheme = tid;
  s.warning = applied === tid ? `「${t.name}」当前正被使用，已删除其插件内置副本：之后该主题若文件丢失将无法自愈补装，仍可 restore 回原版。` : `已删除插件内置的「${t.name}」主题资源。`;
  syncStatusFile();
  return s;
}

function readIndexSafe() {
  if (!fileExists(INDEX)) return '';
  try { return fs.readFileSync(INDEX, 'utf8'); } catch { return ''; }
}

/** 给工具 / 日志用的人话摘要。 */
function summarize(s) {
  const parts = [`主题模式：${s.mode}`, `默认主题：${s.defaultTheme || '原版'}`];
  if (s.appliedTheme) {
    const t = allThemes()[s.appliedTheme];
    const ts = s.themes[s.appliedTheme];
    parts.push(`当前主题：${t.name}${ts.ready ? '（已就绪）' : `（文件不完整：${s.missing.join('、')}）`}`);
  } else {
    parts.push(`当前未应用主题${s.missing.length ? `（${s.missing.join('、')}）` : ''}`);
  }
  const bundled = Object.values(s.themes).filter((x) => x.bundled).map((x) => x.name);
  parts.push(`插件内置：${bundled.length ? bundled.join('、') : '无'}`);
  parts.push(s.backupExists ? '有原始备份' : '无原始备份');
  return parts.join('；');
}

function listSummary(s) {
  const rows = Object.values(s.themes).map((t) => {
    const statusTxt = t.bundled ? '内置' : '已删';
    const appliedTxt = s.appliedTheme === t.id ? ' ← 当前应用' : '';
    return `${t.icon} ${t.name}（${t.id}）：${statusTxt}${t.ready ? '' : '（文件不全）'}${appliedTxt}`;
  });
  return rows.join('\n');
}

async function toolExecute(args) {
  const action = String(args?.action ?? 'status');
  const theme = String(args?.theme ?? '');
  try {
    if (action === 'apply') {
      const s = theme ? ensureInstalled(theme) : ensureRemoved();
      api?.log?.(`[主题模式] apply ${theme || '(原版)'} → ${summarize(s)}`);
      return { content: summarize(s), isError: false };
    }
    if (action === 'restore') {
      const s = ensureRemoved();
      api?.log?.(`[主题模式] restore → ${summarize(s)}`);
      return { content: summarize(s), isError: false };
    }
    if (action === 'list') {
      const s = status();
      return { content: listSummary(s), isError: false };
    }
    if (action === 'delete') {
      if (!theme) throw new Error('delete 需要指定 theme（' + Object.keys(allThemes()).join(' / ') + '）');
      const s = deleteBundledTheme(theme);
      api?.log?.(`[主题模式] delete ${theme} → ${s.warning}`);
      return { content: s.warning + '\n' + listSummary(s), isError: false };
    }
    const s = status();
    return { content: summarize(s), isError: false };
  } catch (error) {
    return { content: `主题模式操作失败：${error?.message ?? error}`, isError: true };
  }
}


// ── 生命周期 ──────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
  try {
    a?.registerTool?.({
      id: TOOL_ID,
      name: '主题切换',
      description: '管理控制台主题皮肤。群友提到「主题/皮肤/换肤」时用：action=status 查状态；list 列主题；apply 应用（theme 缺省=默认主题）；restore 还原原版；delete 删插件内置副本（需 theme）。',
      category: 'system',
      icon: '🌸',
      defaultEnabled: true,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'list', 'apply', 'restore', 'delete'],
            description: '要执行的动作'
          },
          theme: {
            type: 'string',
            enum: Object.keys(allThemes()).length ? Object.keys(allThemes()) : [],
            description: '目标主题（apply / delete 用；apply 缺省时用默认主题）'
          }
        },
        required: ['action']
      },
      execute: async (ctx, args) => toolExecute(args)
    });
  } catch (error) {
    a?.warn?.('主题模式工具注册失败：' + (error?.message ?? error));
  }
  syncStatusFile();
}

export function activate() {
  const cfg = settings();
  try {
    if (cfg.mode === 'off') {
      const s = ensureRemoved();
      api?.log?.(`[主题模式] 已按设置关闭主题：${summarize(s)}`);
    } else {
      // 前端「删除」按钮：settings.deleteTheme 非空 → 删插件内置副本（幂等）
      if (cfg.deleteTheme) {
        try {
          const t = allThemes()[cfg.deleteTheme];
          deleteBundledTheme(cfg.deleteTheme);
          api?.log?.(`[主题模式] 已删除插件内置副本 ${cfg.deleteTheme}${t ? `（${t.name}）` : ''}`);
        } catch (error) {
          api?.warn?.('删除内置副本失败：' + (error?.message ?? error));
        }
      }
      // 主题为空 = 保持/还原原版外观；指定主题 = 应用 + 启动自检补装。
      // 内置副本刚被删时跳过自检（ensureInstalled 会因缺副本抛错）。
      if (!cfg.theme) {
        // 原版外观只摘引用、不删主题文件：防止后续切回主题时文件已丢失，
        // 也避免「配置为空 → 每次激活删文件」的误删循环。
        const s = ensureOriginalOnly();
        api?.log?.(`[主题模式] 启动自检完成（原版外观）：${summarize(s)}`);
      } else if (cfg.theme !== cfg.deleteTheme) {
        const s = ensureInstalled(cfg.theme);
        api?.log?.(`[主题模式] 启动自检完成（${cfg.theme}）：${summarize(s)}`);
      }
    }
  } catch (error) {
    api?.warn?.('主题模式启动自检失败：' + (error?.message ?? error));
  } finally {
    syncStatusFile();
  }
}

export function deactivate() {
  // 停用插件 = 还原原版外观（摘掉所有主题注入 + 删除已装主题文件）。
  // 重新启用时 activate() 会按 settings.theme 重新补装并应用。
  try {
    const s = ensureRemoved();
    api?.log?.(`[主题模式] 插件已停用，已自动回退原版外观：${summarize(s)}`);
  } catch (error) {
    api?.warn?.('主题模式停用回退失败：' + (error?.message ?? error));
  } finally {
    syncStatusFile();
  }
}

export function available() {
  return true;
}

// ── 能力 ─────────────────────────────────────────────────────────────────

export const providers = {
  'theme-mode.status': () => status(),
  'theme-mode.list': () => status(),
  'theme-mode.apply': (args) => ensureInstalled(String(args?.theme ?? '') || settings().theme),
  'theme-mode.restore': () => ensureRemoved(),
  'theme-mode.delete': (args) => deleteBundledTheme(String(args?.theme ?? ''))
};

export const hooks = {};