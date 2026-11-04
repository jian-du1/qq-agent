import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { inspectExtensionPackage, findInstalledPlugin, installInspectedExtension } from './lib/plugin-package.js?v=0.3.0';
import { marketBase, marketKind, marketJson, marketExtensions, marketPersonas, verifyExtension, downloadPlugin, personaPreview } from './lib/market-client.js?v=0.3.3';

const ID = 'market-preview';
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(PLUGIN_DIR, '..', '..');
const UI_DIR = path.join(APP_ROOT, 'ui');
const UI_INDEX = path.join(UI_DIR, 'index.html');
const PLUGINS_DIR = path.join(APP_ROOT, 'plugins');
const SKILLS_DIR = path.join(APP_ROOT, 'skills');
const STAGING_DIR = path.join(APP_ROOT, '.market-preview-staging');
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(APP_ROOT, 'data');
const BEGIN = '<!-- market-preview:begin -->';
const END = '<!-- market-preview:end -->';
const HOST_FILES = ['market-preview-host.js', 'market-preview-host.css'];
const TICKET_TTL = 5 * 60 * 1000;
let api;
let mounted = false;
let reloadTimer;
let count = 0;
let busy = false;
const cache = new Map();
const tickets = new Map();

function log(message) { try { api?.log?.(message); } catch { /* Logging cannot break the console. */ } }
function cfg() { return api?.config?.() || {}; }
function source() { return marketBase(cfg().marketBase); }

export function stripHostBlock(html) {
  let out = String(html);
  while (true) {
    const start = out.indexOf(BEGIN);
    const end = out.indexOf(END);
    if (start < 0 && end < 0) return out;
    if (start < 0 || end < start) throw new Error('市场页面引用标记不完整');
    const nested = out.indexOf(BEGIN, start + BEGIN.length);
    if (nested >= 0 && nested < end) throw new Error('市场页面引用标记重复');
    let after = out.slice(end + END.length);
    if (after.startsWith('\r\n')) after = after.slice(2);
    else if (after.startsWith('\n')) after = after.slice(1);
    out = out.slice(0, start) + after;
  }
}

export function addHostBlock(html) {
  const original = String(html);
  const clean = stripHostBlock(original);
  if (!/<\/head>/i.test(clean) || !/id=["']tabs["']/.test(clean) || !/id=["']layout["']/.test(clean)) {
    throw new Error('控制台页面结构已变化，市场插件未挂载');
  }
  const eol = clean.includes('\r\n') ? '\r\n' : '\n';
  const block = [BEGIN, '<link rel="stylesheet" href="/market-preview-host.css" />',
    '<script defer src="/market-preview-host.js"></script>', END].join(eol);
  const start = original.indexOf(BEGIN);
  const end = original.indexOf(END, start);
  if (start >= 0 && original.indexOf(BEGIN, start + BEGIN.length) < 0) {
    // Keep this block in place. Moving it to the end competes with other UI
    // plugins and makes every ordinary extension reload look like a UI update.
    return original.slice(0, start) + block + original.slice(end + END.length);
  }
  return clean.replace(/<\/head>/i, (closingTag) => block + eol + closingTag);
}

function atomicWrite(file, contents) {
  const tmp = file + '.market-preview-' + randomUUID() + '.tmp';
  try { fs.writeFileSync(tmp, contents); fs.renameSync(tmp, file); }
  finally { try { fs.rmSync(tmp, { force: true }); } catch { /* Already renamed. */ } }
}

function installHost() {
  const html = fs.readFileSync(UI_INDEX, 'utf8');
  const next = addHostBlock(html);
  const backupDir = path.join(DATA_DIR, 'market-preview');
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, 'index-before-market.html');
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, html, { encoding: 'utf8', flag: 'wx' });
  let changed = false;
  for (const file of HOST_FILES) {
    const bytes = fs.readFileSync(path.join(PLUGIN_DIR, 'host', file));
    const dest = path.join(UI_DIR, file);
    let same = false;
    try { same = bytes.equals(fs.readFileSync(dest)); } catch { /* First mount. */ }
    if (!same) { atomicWrite(dest, bytes); changed = true; }
  }
  if (next !== html) { atomicWrite(UI_INDEX, Buffer.from(next, 'utf8')); changed = true; }
  mounted = true;
  return changed;
}

function removeHost() {
  let changed = false;
  if (fs.existsSync(UI_INDEX)) {
    const html = fs.readFileSync(UI_INDEX, 'utf8');
    const next = stripHostBlock(html);
    if (html !== next) { atomicWrite(UI_INDEX, Buffer.from(next, 'utf8')); changed = true; }
  }
  for (const file of HOST_FILES) {
    const target = path.resolve(UI_DIR, file);
    if (path.dirname(target) !== path.resolve(UI_DIR)) throw new Error('页面清理路径越界');
    if (fs.existsSync(target)) { fs.rmSync(target); changed = true; }
  }
  mounted = false;
  return changed;
}

function reloadConsole() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try {
      const { BrowserWindow } = await import('electron');
      for (const win of BrowserWindow.getAllWindows()) win.webContents.reloadIgnoringCache();
    } catch { /* Headless tests and web-console clients do not need an Electron refresh. */ }
  }, 200);
}

export function setup(a) { api = a; }

export function available() {
  try {
    source();
    if (!HOST_FILES.every((f) => fs.existsSync(path.join(PLUGIN_DIR, 'host', f)))) return { ok: false, reason: '市场插件包不完整' };
    if (!fs.existsSync(UI_INDEX)) return { ok: false, reason: '找不到控制台页面' };
    addHostBlock(fs.readFileSync(UI_INDEX, 'utf8'));
    return true;
  } catch (error) { return { ok: false, reason: String(error.message) }; }
}

export function activate() {
  try {
    if (installHost()) reloadConsole();
    log('内置市场已挂载；插件、技能与人设列表按需加载');
  } catch (error) { mounted = false; log('市场挂载失败：' + error.message); }
}

export function deactivate(context = {}) {
  tickets.clear();
  cache.clear();
  clearTimeout(reloadTimer);
  if (context.reason === 'reload') return;
  try { if (removeHost()) reloadConsole(); }
  catch (error) { log('市场页面清理失败：' + error.message); }
}

export function dispose() {
  tickets.clear();
  cache.clear();
  // deactivate performs the reversible UI cleanup; dispose also runs during hot reload.
}

export const providers = {
  'market.preview-state': () => ({ mounted, shown: count, busy })
};

function pruneTickets() {
  for (const [token, entry] of tickets) if (Date.now() - entry.at > TICKET_TTL) tickets.delete(token);
}

async function list(force, kind = 'plugin') {
  const base = source();
  marketKind(kind);
  const cached = cache.get(kind);
  if (!force && cached?.base === base && Date.now() - cached.at < 60000) return cached.result;
  const route = { plugin: '/plugins', skill: '/skills', persona: '/personas' }[kind];
  const data = await marketJson(api.fetch, base, route, {}, kind === 'persona' ? 8 * 1024 * 1024 : 2 * 1024 * 1024);
  const items = kind === 'persona' ? marketPersonas(data) : marketExtensions(data, kind);
  count = items.length;
  const result = { ok: true, kind, items, fetchedAt: new Date().toISOString() };
  cache.set(kind, { at: Date.now(), base, result });
  return result;
}

async function preview(args) {
  if (busy) throw new Error('正在检查或安装另一个扩展，请稍候');
  busy = true;
  try {
    const base = source();
    const kind = marketKind(args.kind || 'plugin');
    const verified = await verifyExtension(api.fetch, base, args.code, kind);
    if (args.id && args.id !== verified.id) throw new Error('市场条目已变化，请刷新后重试');
    if (verified.id === ID || findInstalledPlugin(PLUGINS_DIR, verified.id) || findInstalledPlugin(SKILLS_DIR, verified.id)) {
      throw new Error('已安装同 id 扩展；请到原有技能或插件页管理');
    }
    const bytes = await downloadPlugin(api.fetch, base, verified.code);
    const inspected = inspectExtensionPackage(bytes, verified);
    pruneTickets();
    while (tickets.size >= 2) tickets.delete(tickets.keys().next().value);
    const ticket = randomUUID();
    tickets.set(ticket, { at: Date.now(), base, inspected });
    const m = inspected.manifest;
    const extension = {
        id: m.id, name: String(m.name || verified.name || m.id), version: String(m.version || ''),
        author: String(m.author || verified.author || '社区作者'), description: String(m.description || ''),
        nestingDepth: inspected.nestingDepth, fileCount: inspected.files.length, totalBytes: inspected.totalBytes,
        requires: Array.isArray(m.requires) ? m.requires.map(String) : []
      };
    return { ok: true, ticket, kind, extension, ...(kind === 'plugin' ? { plugin: extension } : {}) };
  } finally { busy = false; }
}

function install(args) {
  if (args.confirmed !== true) throw new Error('需要先在确认窗口点击「安装并启用」');
  if (busy) throw new Error('另一个安装正在进行，请稍候');
  pruneTickets();
  const token = String(args.ticket || '');
  const entry = tickets.get(token);
  if (!entry || entry.base !== source()) throw new Error('安装确认已过期，请重新点击安装');
  if (args.kind && args.kind !== entry.inspected.kind) throw new Error('安装类型与确认内容不一致');
  busy = true;
  try {
    const result = installInspectedExtension(entry.inspected, { pluginsDir: PLUGINS_DIR, skillsDir: SKILLS_DIR, stagingDir: STAGING_DIR });
    tickets.delete(token);
    log('已安装' + result.kind + ' ' + result.id + '；包装层数 ' + result.nestingDepth);
    return { ok: true, ...result };
  } finally { busy = false; }
}

export async function runAction(key, args = {}) {
  if (key !== 'market') return { ok: false, error: '未知的市场动作' };
  if (!args.op) return { ok: true, message: '在控制台「市场」页浏览插件、技能与人设。扩展确认后安装并启用，人设新增后自动选择并保存。关闭本插件即可移除市场页。' };
  if (!api?.isSkillActive?.(ID)) return { ok: false, error: '市场插件已关闭或不可用，请使用原有市场入口' };
  try {
    if (args.op === 'state') return { ok: true, state: api.capability('market.preview-state') };
    if (args.op === 'list') return await list(args.force === true, args.kind || 'plugin');
    if (args.op === 'persona-preview') return { ok: true, persona: await personaPreview(api.fetch, source(), args.id) };
    if (args.op === 'preview') return await preview(args);
    if (args.op === 'install') return install(args);
    if (args.op === 'discard') { tickets.delete(String(args.ticket || '')); return { ok: true }; }
    return { ok: false, error: '未知的市场操作' };
  } catch (error) {
    log('市场操作失败：' + String(error.message));
    return { ok: false, error: String(error.message || error).slice(0, 600) };
  }
}
