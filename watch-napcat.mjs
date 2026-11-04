// NapCat 看护 v3（只重启“真的死了”的进程，会话失效一律等扫码）
//
// ── 为什么改版（2026-11-02 晚实测）──────────────────────────────────────
// 掉线有两种，长得像、救法完全不同，v2 把它们混在一起处理，结果做了很多
// 无用功，还把用户正在扫的二维码反复作废：
//
//   ① 进程级：3000 端口都连不上 → 进程真崩了/被杀了 → 重启有用。
//   ② 会话级：端口活着、get_status 能回，但 online=false，QQ 日志里固定是
//        [KickedOffLine] [下线通知] 你的账号当前登录已失效，请重新登录。
//      实测：这种状态重启 100% 救不回来 —— 启动日志会连打两行
//        [NapCat] [WebUi] 自动快速登录失败: 登录态已失效，请重新登录。
//        [NapCat] [WebUi] 自动密码回退登录需要验证码，请在登录页面继续完成
//      然后就是二维码，必须人扫。重启只会：a) 多一次登录给风控送信号；
//      b) 把上一个还没扫的二维码作废掉（21:45 那次扫码白扫就是这么来的）。
//
// ── 现在的策略 ────────────────────────────────────────────────────────
//   A. 端口不通 → 按进程崩处理：重启（冷却 10 分钟、每小时最多 2 次）。
//   B. 端口通但离线 → 按会话失效处理：
//        等 90 秒（让腾讯把旧会话清干净）→ 调一次「快速登录」接口
//        （/api/QQLogin/SetQuickLogin，和 NapCat 自己启动时做的是同一件事，
//         纯本地票据、不需要验证码；10 分钟内最多试一次）
//        仍不行 → 进入「等扫码」模式。
//   C. 等扫码模式：**绝不重启、绝不杀进程**（保住二维码），每 60 秒看一次，
//        每 5 分钟把最新二维码链接写进 data\logs\qr-url.txt 并记一行日志；
//        90 分钟还没人扫才解除，允许再自动重启一次。
//   D. 「等扫码」状态写盘持久化：桌面面板重启看护也不丢，不会又把二维码打死。
// 全程不调密码登录 —— 密码登录必然触发验证码，是纯风控噪音。
//
// 用法：runtime\node.exe watch-napcat.mjs
//   环境变量：
//     QQAGENT_PREEMPT_MIN=100   主动重启的在线分钟数（默认 0 = 关闭）
//     QQAGENT_QUICK_LOGIN=0     禁用 A 步里的快速登录尝试（默认 1 = 允许）
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(HERE, 'data', 'logs', 'watch-napcat.log');
const LOCK = path.join(HERE, 'data', 'napcat-watch.lock');
const STATE_FILE = path.join(HERE, 'data', 'napcat-watch-state.json');
const QR_TXT = path.join(HERE, 'data', 'logs', 'qr-url.txt');
const QR_PNG_SRC = path.join(HERE, 'napcat', 'shell', 'napcat', 'cache', 'qrcode.png');
const QR_PNG_DST = path.join(HERE, 'data', 'logs', 'qrcode.png');

const OB = 'http://127.0.0.1:3000';
const WEBUI = 'http://127.0.0.1:6099';
const WEBUI_TOKEN = 'YOUR_WEBUI_TOKEN';
const BOT_UIN = '1000000001';

const CHECK_MS = 60_000;                    // 每 60 秒查一次
const DOWN_LIMIT = 3;                       // 连续 3 次不在线（约 3 分钟）再动手
const RESTART_GAP_MS = 10 * 60_000;         // 两次进程级重启之间至少隔 10 分钟
const MAX_RESTARTS_PER_HOUR = 2;            // 一小时最多重启 2 次
const PREEMPT_MIN = Number(process.env.QQAGENT_PREEMPT_MIN ?? 0);   // 主动换会话（默认关）
const KICK_GRACE_MS = 90_000;               // 刚掉线先等一下，别撞上还没清掉的旧会话
const WAIT_ONLINE_MS = 180_000;             // 重启后等它快速登录回来的上限
const QUICK_LOGIN_OK = String(process.env.QQAGENT_QUICK_LOGIN ?? '1') !== '0';
const QUICK_LOGIN_GAP_MS = 10 * 60_000;     // 快速登录重试间隔
const SCAN_WAIT_MS = 90 * 60_000;           // 等扫码最长等多久
const SCAN_LOG_EVERY_MS = 5 * 60_000;       // 等扫码期间多久记一行
const LINK_PROBE_MS = 5 * 60_000;           // 多久做一次「真联网」探针

// ── 持久化状态（跨看护重启保留「等扫码」）───────────────────────────────
const state = {
  needsScan: false,
  needsScanSince: 0,
  lastScanLogAt: 0,
  lastRestartAt: 0,
  lastQrShownAt: 0,
  lastQuickAt: 0,
  lastQrUrl: '',
  restarts: []
};
try {
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  if (raw && typeof raw === 'object') Object.assign(state, raw);
  if (!Array.isArray(state.restarts)) state.restarts = [];
} catch { /* 第一次跑没有状态文件，正常 */ }

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch { /* 写不了就算了，内存里继续 */ }
}

let fails = 0;
let sessionStartMs = 0;      // 当前这轮会话开始时间（估算）
let wasOnline = false;
let droppedAt = 0;
let webuiCred = '';
let lastLinkAt = 0;          // 上次「真联网」探针时间
let linkFails = 0;           // 假在线连续失败次数

function log(...a) {
  const line = '[' + new Date().toLocaleString('zh-CN', { hour12: false }) + '] ' + a.join(' ');
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + '\n');
  } catch { /* 日志写不了就算了 */ }
}

function notify(text) {
  try {
    const ps = 'Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('
      + JSON.stringify(text) + ", 'QQ 机器人', 'OK', 'Warning') | Out-Null";
    spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps],
      { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* ignore */ }
}

function fmtAge(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  return m >= 60 ? (Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分') : (m + ' 分钟');
}

// ── 单实例锁 ──────────────────────────────────────────────────────────
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
try {
  const old = Number(String(fs.readFileSync(LOCK, 'utf-8')).trim());
  if (old && old !== process.pid && pidAlive(old)) {
    console.log('看护已经在运行（PID ' + old + '），本进程退出');
    process.exit(0);
  }
} catch { /* 没有锁文件，正常启动 */ }
try {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, String(process.pid));
  process.on('exit', () => { try { fs.unlinkSync(LOCK); } catch { /* ignore */ } });
} catch { /* 锁写不了就退化为无锁 */ }

// ── OneBot 状态 ───────────────────────────────────────────────────────
/**
 * 一次探测拿两个信息：
 *   reachable = NapCat 进程还在（3000 端口有 HTTP 响应）
 *   online    = QQ 真的登录着
 * 「能连上但不在线」= 会话被腾讯作废，重启没用，只能等扫码。
 */
async function probe() {
  try {
    const res = await fetch(OB + '/get_status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000)
    });
    const j = await res.json();
    return { reachable: true, online: !!(j && j.data && j.data.online === true) };
  } catch {
    return { reachable: false, online: false };
  }
}

/** 等在线，最多 ms 毫秒；成功返回用时（秒），失败返回 -1 */
async function waitOnline(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 2000));
    const p = await probe();
    if (p.online) return Math.round((Date.now() - t0) / 1000);
  }
  return -1;
}

/**
 * WebUI（6099）还活着吗 —— 这才是「进程还在」的可靠信号。
 * 停在扫码登录页时 OneBot 的 3000 端口根本没起来，拿端口判死活会把
 * "等你扫码" 误判成 "进程崩了"，于是一遍遍重启、把刚出的二维码打死。
 */
async function webuiAlive() {
  try {
    const res = await fetch(WEBUI + '/webui', { signal: AbortSignal.timeout(5000) });
    return !!res && res.status < 500;
  } catch {
    return false;
  }
}

/** 问 WebUI：现在登录到哪一步了（停在二维码 / 已登录 / 问不到） */
async function loginState() {
  try {
    const j = await napcatApi('/api/QQLogin/CheckLoginStatus', {});
    const d = (j && j.data) || {};
    return {
      isLogin: d.isLogin === true,
      qrcode: String(d.qrcodeurl || ''),
      err: String(d.loginError || '')
    };
  } catch {
    return null;
  }
}

/**
 * 真联网探针。set_online_status 一定走服务器。
 * 返回 false = 内核到腾讯的长连接已经断了 —— 此时 get_status 仍会报
 * online=true，这就是「本地在线、手机显示离线、发消息报 网络连接异常
 * 1006514」的假在线，只能重启换一条新连接。
 */
async function linkAlive() {
  try {
    const res = await fetch(OB + '/set_online_status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 10, ext_status: 0, battery_status: 0 }),
      signal: AbortSignal.timeout(20000)
    });
    const j = await res.json();
    return !!(j && (j.status === 'ok' || j.status === 'async'));
  } catch {
    return false;
  }
}

// ── NapCat WebUI API（登录态相关）──────────────────────────────────────
async function webuiAuth() {
  if (webuiCred) return webuiCred;
  const hash = createHash('sha256').update(WEBUI_TOKEN + '.napcat').digest('hex');
  const res = await fetch(WEBUI + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hash }),
    signal: AbortSignal.timeout(8000)
  });
  const j = await res.json();
  const cred = j && j.data && j.data.Credential;
  if (!cred) throw new Error('WebUI 鉴权失败：' + JSON.stringify(j).slice(0, 160));
  webuiCred = cred;
  return cred;
}

async function napcatApi(pathname, body) {
  const cred = await webuiAuth();
  const res = await fetch(WEBUI + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cred },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(15000)
  });
  return await res.json();
}

/**
 * 会话失效后试一次「快速登录」。
 * 就是把 NapCat 启动时自动做的那件事手动重放一次（纯本地票据，不要验证码）。
 * 票据真的作废时会立刻返回「登录态已失效」，那就只能扫码了。
 */
async function tryQuickLogin() {
  if (!QUICK_LOGIN_OK) return { ok: false, message: '（已禁用快速登录尝试）' };
  if (Date.now() - state.lastQuickAt < QUICK_LOGIN_GAP_MS) {
    return { ok: false, message: '（' + Math.ceil((QUICK_LOGIN_GAP_MS - (Date.now() - state.lastQuickAt)) / 60000) + ' 分钟内已试过）' };
  }
  state.lastQuickAt = Date.now();
  saveState();
  try {
    const j = await napcatApi('/api/QQLogin/SetQuickLogin', { uin: BOT_UIN });
    const code = j && j.code;
    const msg = (j && (j.message || j.msg)) || '';
    if (code === 0) return { ok: true, message: '快速登录已受理' };
    return { ok: false, message: msg || JSON.stringify(j).slice(0, 120) };
  } catch (e) {
    return { ok: false, message: '快速登录接口异常：' + (e && e.message ? e.message : e) };
  }
}

/** 取当前二维码链接，落盘一份（人要能在任何地方看到/复制它） */
async function refreshQrInfo(why) {
  try {
    let j = await napcatApi('/api/QQLogin/CheckLoginStatus', {});
    let d = (j && j.data) || {};
    // 二维码过期时 NapCat 不一定自己刷（实测有时会在登录页停住），手动催一次
    if (!d.isLogin && (/过期/.test(String(d.loginError || '')) || !d.qrcodeurl)) {
      try {
        await napcatApi('/api/QQLogin/RefreshQRcode', {});
        j = await napcatApi('/api/QQLogin/CheckLoginStatus', {});
        d = (j && j.data) || {};
      } catch { /* 刷不出来就用旧的 */ }
    }
    const url = d.qrcodeurl || '';
    const err = d.loginError || '';
    let changed = false;
    if (url && url !== state.lastQrUrl) {
      state.lastQrUrl = url;
      changed = true;
      saveState();
    }
    try {
      fs.mkdirSync(path.dirname(QR_TXT), { recursive: true });
      const body = (url || '（暂无二维码链接）') + '\n'
        + '时间：' + new Date().toLocaleString('zh-CN', { hour12: false }) + '\n'
        + '来源：' + why + '\n'
        + (err ? '登录错误：' + err + '\n' : '')
        + '扫码方式：把上面链接复制到任意二维码生成网站，用『小助手』绑定的手机 QQ 扫。\n';
      fs.writeFileSync(QR_TXT, body);
    } catch { /* ignore */ }
    try {
      if (fs.existsSync(QR_PNG_SRC)) fs.copyFileSync(QR_PNG_SRC, QR_PNG_DST);
    } catch { /* ignore */ }
    return { url, err, changed };
  } catch (e) {
    return { url: '', err: '取二维码失败：' + (e && e.message ? e.message : e), changed: false };
  }
}

// ── 进程识别 / 启停 ───────────────────────────────────────────────────
/**
 * 找出本项目自己的 node 进程并按角色分类。
 * 为什么不用端口：NapCat 重连时端口监听会短暂消失，按端口找会扑空。
 */
function agentProcs() {
  try {
    const ps1 = path.join(HERE, 'scripts', 'agent-procs.ps1');
    const out = execSync(
      'powershell -NoProfile -ExecutionPolicy Bypass -File "' + ps1 + '" -Root "' + HERE + '"',
      { encoding: 'utf8', timeout: 25000, windowsHide: true }
    );
    const txt = out.trim();
    if (!txt) return null;
    const j = JSON.parse(txt);
    const norm = (v) => (Array.isArray(v) ? v : (v ? [v] : [])).map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const start = Number(j.napcatStart);
    return {
      console: norm(j.console),
      napcat: norm(j.napcat),
      watch: norm(j.watch),
      napcatStart: Number.isFinite(start) && start > 0 ? start : 0
    };
  } catch {
    return null;
  }
}

function napcatPidsByPort(consolePidValue) {
  const pids = new Set();
  let out = '';
  try {
    out = execSync('netstat -ano', { encoding: 'utf8', timeout: 20000, windowsHide: true });
  } catch {
    return [];
  }
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/.test(line)) continue;
    const m = line.match(/:(6099|6100|6101|6102|6103|6104|6105|3000|3001)\s/);
    if (!m) continue;
    const cols = line.trim().split(/\s+/);
    const pid = Number(cols[cols.length - 1]);
    if (Number.isFinite(pid) && pid > 0 && pid !== consolePidValue) pids.add(pid);
  }
  return [...pids];
}

function consolePid() {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', timeout: 20000, windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/.test(line)) continue;
      if (!/:3210\s/.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const pid = Number(cols[cols.length - 1]);
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch { /* ignore */ }
  return 0;
}

function stillAlive(pid) {
  try {
    const out = execSync('tasklist /FI "PID eq ' + pid + '" /NH', { encoding: 'utf8', timeout: 10000, windowsHide: true });
    return out.includes(String(pid));
  } catch {
    return false;
  }
}

/** 结束进程：先整棵树，不行再单杀，最后交给 PowerShell */
function killTree(pid) {
  const tries = [
    'taskkill /F /T /PID ' + pid,
    'taskkill /F /PID ' + pid,
    'powershell -NoProfile -Command "Stop-Process -Id ' + pid + ' -Force -ErrorAction SilentlyContinue"'
  ];
  for (const cmd of tries) {
    try {
      execSync(cmd, { stdio: 'ignore', timeout: 15000, windowsHide: true });
    } catch { /* 继续下一招 */ }
    if (!stillAlive(pid)) return true;
  }
  return !stillAlive(pid);
}

function startNapcat() {
  try {
    const vbs = path.join(HERE, 'bg-napcat-hidden.vbs');
    spawn('wscript.exe', ['//nologo', vbs], {
      cwd: HERE, detached: true, stdio: 'ignore', windowsHide: true
    }).unref();
    log('已重新拉起 NapCat（隐藏窗口）');
    sessionStartMs = Date.now();
    webuiCred = '';       // 新进程 = 新会话，旧凭据作废
  } catch (e) {
    log('拉起 NapCat 失败：', e && e.message ? e.message : e);
  }
}

function killAllNapcat(reason) {
  const cpid = consolePid();
  const cls = agentProcs();
  let pids = [];
  if (cls && cls.napcat.length) {
    pids = cls.napcat;
    log('按命令行识别到 NapCat 进程：' + pids.join(', '));
  } else {
    pids = napcatPidsByPort(cpid);
    if (pids.length) log('按端口兜底识别到 NapCat 进程：' + pids.join(', '));
  }
  if (!pids.length) {
    log('没找到 NapCat 进程（' + reason + '），直接重新拉起');
    return [];
  }
  for (const pid of pids) {
    const ok = killTree(pid);
    log('  ' + (ok ? '已结束' : '仍然活着（可能权限不足）') + ' PID ' + pid);
  }
  return pids;
}

// ── 等扫码模式 ────────────────────────────────────────────────────────
async function enterScanMode(why, loginError) {
  state.needsScan = true;
  state.needsScanSince = Date.now();
  state.lastScanLogAt = 0;
  saveState();
  log('进入「等扫码」模式（' + why + '）：接下来不再重启、不再杀进程，把二维码留着');

  const qr = await refreshQrInfo('进入等扫码模式');
  if (qr.url) log('当前二维码链接已写入 data\\logs\\qr-url.txt');

  if (Date.now() - state.lastQrShownAt > 60 * 60 * 1000) {
    state.lastQrShownAt = Date.now();
    saveState();
    try {
      spawn('cmd.exe', ['/c', 'start', '', WEBUI + '/webui?token=' + WEBUI_TOKEN],
        { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      log('已打开 WebUI（里面有会自动刷新的二维码）');
    } catch { /* ignore */ }
  } else {
    log('一小时内已经提示过扫码，这次只记日志（不再弹窗口）');
  }

  notify('小助手掉线了，而且这次不是崩溃 —— 是腾讯把登录会话作废了，只能扫码。\n\n'
    + (loginError ? '腾讯返回：' + loginError + '\n\n' : '')
    + (qr.url ? '二维码链接（复制到任意二维码网站生成图片，用小助手手机 QQ 扫）：\n' + qr.url + '\n\n' : '')
    + '也可以点桌面「QQ 机器人」→「打开 WebUI」直接扫。\n'
    + '扫完几秒内自动恢复，看护会继续盯着。');
}

/** 等扫码期间每轮做的事：不重启，只记录 + 刷新二维码链接 */
async function scanTick(waited) {
  if (Date.now() - state.lastScanLogAt >= SCAN_LOG_EVERY_MS) {
    state.lastScanLogAt = Date.now();
    saveState();
    const qr = await refreshQrInfo('等扫码中');
    log('等扫码中（已等 ' + fmtAge(waited) + '）'
      + (qr.err ? '｜登录错误：' + qr.err : '')
      + (qr.changed ? '｜二维码已刷新，链接见 data\\logs\\qr-url.txt' : ''));
  }
}

// ── 重启（只用于「进程真的没了」）──────────────────────────────────────
async function restartNapcat(what, cleanRetry = true) {
  const now = Date.now();
  if (now - state.lastRestartAt < RESTART_GAP_MS) {
    const waitMin = Math.max(1, Math.ceil((RESTART_GAP_MS - (now - state.lastRestartAt)) / 60000));
    log('冷却中，先不重启（约 ' + waitMin + ' 分钟后可再试）');
    return false;
  }
  state.restarts = state.restarts.filter((t) => now - t < 60 * 60 * 1000);
  if (state.restarts.length >= MAX_RESTARTS_PER_HOUR) {
    log('一小时内已重启 ' + state.restarts.length + ' 次，暂停自动重启');
    return false;
  }

  state.lastRestartAt = now;
  state.restarts.push(now);
  saveState();

  log('开始重启（' + what + '）');
  killAllNapcat(what);
  await new Promise((r) => setTimeout(r, 3000));
  startNapcat();

  let took = await waitOnline(WAIT_ONLINE_MS);
  if (took >= 0) {
    log('✅ 重启后已恢复在线（用时约 ' + took + ' 秒）');
    state.needsScan = false;
    saveState();
    return true;
  }

  // 第一次没回来：可能是残留进程赖着不走，彻底清一次再试
  if (cleanRetry) {
    log('第一次重启没恢复，做一次彻底清理再试');
    killAllNapcat('彻底清理');
    await new Promise((r) => setTimeout(r, 5000));
    startNapcat();
    took = await waitOnline(WAIT_ONLINE_MS);
    if (took >= 0) {
      log('✅ 彻底清理后恢复在线（用时约 ' + took + ' 秒）');
      state.needsScan = false;
      saveState();
      return true;
    }
  }

  await enterScanMode('进程重启后仍连不上 QQ', '');
  return false;
}

// ── 主循环 ────────────────────────────────────────────────────────────
async function main() {
  log('看护启动 v3.1：每 ' + CHECK_MS / 1000 + ' 秒检查一次；进程崩了才重启，会话失效/等着扫码只等不动手'
    + (PREEMPT_MIN > 0 ? '；在线满 ' + PREEMPT_MIN + ' 分钟主动换会话' : '（主动重启已关闭）')
    + '；在线时每 ' + LINK_PROBE_MS / 60000 + ' 分钟探一次真联网');
  if (state.needsScan) {
    log('注意：上次关机/重启时还处在「等扫码」状态（已等 ' + fmtAge(Date.now() - state.needsScanSince) + '），'
      + '这次不会自动重启，直接把二维码找出来给你');
    await refreshQrInfo('看护重启后恢复等扫码状态');
  }

  const cls0 = agentProcs();
  sessionStartMs = (cls0 && cls0.napcatStart) ? cls0.napcatStart : Date.now();
  if (cls0 && cls0.napcatStart) log('当前 NapCat 已运行 ' + fmtAge(Date.now() - cls0.napcatStart));

  await new Promise((r) => setTimeout(r, 20_000));   // 给刚启动的 NapCat 一点时间

  for (;;) {
    const st = await probe();

    if (st.online) {
      if (!wasOnline) {
        log('在线' + (state.needsScan ? '（扫码完成，恢复）' : ''));
        if (!sessionStartMs) sessionStartMs = Date.now();
        if (state.needsScan) { state.needsScan = false; saveState(); }
        droppedAt = 0;
      }
      wasOnline = true;
      fails = 0;

      // 假在线检测：get_status 只看本地登录态，链路死了它照样说 online。
      // 每 5 分钟真发一次「设置在线状态」探一探，连续 2 次失败就重启换连接。
      if (!lastLinkAt || Date.now() - lastLinkAt > LINK_PROBE_MS) {
        lastLinkAt = Date.now();
        if (await linkAlive()) {
          linkFails = 0;
        } else {
          linkFails += 1;
          log('在线但服务器连不上（假在线 ' + linkFails + '/2）');
          if (linkFails >= 2) {
            linkFails = 0;
            log('确认假在线：内核到腾讯的长连接已断，重启一次换新连接');
            const ok = await restartNapcat('假在线（本地显示在线、实际发不出消息）');
            if (ok) { sessionStartMs = Date.now(); droppedAt = 0; }
          }
        }
      }

      // A. 主动换会话（默认关）
      if (PREEMPT_MIN > 0 && sessionStartMs) {
        const age = Date.now() - sessionStartMs;
        if (age > PREEMPT_MIN * 60_000) {
          log('已在线 ' + fmtAge(age) + '，主动重启换一个新会话');
          const ok = await restartNapcat('在线满 ' + PREEMPT_MIN + ' 分钟');
          if (ok) sessionStartMs = Date.now();
        }
      }
    } else {
      if (wasOnline) {
        wasOnline = false;
        droppedAt = Date.now();
        const life = sessionStartMs ? fmtAge(Date.now() - sessionStartMs) : '未知时长';
        log('掉线了（这轮在线 ' + life + '；'
          + (st.reachable ? '端口还在 = 会话被腾讯作废' : '端口不通 = 进程没了或还没登录') + '）');
      }
      fails += 1;

      if (fails < DOWN_LIMIT) {
        log('离线检测 ' + fails + '/' + DOWN_LIMIT);
      } else {
        fails = 0;

        if (state.needsScan) {
          // 等扫码模式：绝不重启，只记录和刷新二维码
          const waited = Date.now() - state.needsScanSince;
          if (waited >= SCAN_WAIT_MS) {
            state.needsScan = false;
            saveState();
            log('等扫码已超过 ' + fmtAge(SCAN_WAIT_MS) + '，解除等待，允许再自动重启一次');
          } else {
            await scanTick(waited);
            await new Promise((r) => setTimeout(r, CHECK_MS));
            continue;
          }
        }

        // 掉线后先等一会儿，避免在腾讯还没清掉旧会话时动作
        const graceLeft = droppedAt ? KICK_GRACE_MS - (Date.now() - droppedAt) : 0;
        if (graceLeft > 0) {
          log('距离掉线还不到 ' + Math.round(KICK_GRACE_MS / 1000) + ' 秒，再等 ' + Math.ceil(graceLeft / 1000) + ' 秒');
        } else if (!st.reachable) {
          // OneBot 的 3000 没响应。这有三种可能，必须分开处理：
          //   ① 进程真没了          → 重启
          //   ② 进程活着、停在二维码 → 只能等扫码，绝不能重启
          //   ③ 进程活着、正在初始化 → 再等一会儿
          const webAlive = await webuiAlive();
          if (!webAlive) {
            const ok = await restartNapcat('进程没了');
            if (ok) { sessionStartMs = Date.now(); droppedAt = 0; }
          } else {
            const ls = await loginState();
            if (ls && !ls.isLogin && ls.qrcode) {
              await enterScanMode('进程在、但停在扫码登录页', ls.err);
            } else if (ls && ls.isLogin) {
              log('QQ 已登录、OneBot 端口还没起来（刚重启或正在初始化），继续等');
            } else if (droppedAt && Date.now() - droppedAt > 5 * 60_000) {
              const ok = await restartNapcat('端口迟迟不恢复、也问不到登录状态');
              if (ok) { sessionStartMs = Date.now(); droppedAt = 0; }
            } else {
              log('端口没起来，但进程还活着，先等（别把二维码打死）');
            }
          }
        } else {
          // 端口活着但离线 → 会话级失效
          const q = await tryQuickLogin();
          log('会话失效，试一次快速登录：' + (q.ok ? '受理' : '失败') + '（' + q.message + '）');
          if (q.ok) {
            const took = await waitOnline(90_000);
            if (took >= 0) {
              log('✅ 快速登录生效，已恢复在线（用时约 ' + took + ' 秒）');
              sessionStartMs = Date.now();
              droppedAt = 0;
              state.needsScan = false;
              saveState();
            } else {
              await enterScanMode('快速登录受理了但没上线', '');
            }
          } else {
            await enterScanMode('快速登录被拒：' + q.message, q.message);
          }
        }
      }
    }
    await new Promise((r) => setTimeout(r, CHECK_MS));
  }
}

main().catch((e) => {
  log('看护异常退出：', e && e.message ? e.message : e);
  process.exit(1);
});
