/**
 * dsh-bridge —— 把本机 DSH（DeepSeek Harness）当成群里的「深度外援」。
 *
 * 形态：技能（skills/ 目录，清单名 skill.json）。
 *   按 QQ Agent 自己的口径（src/skills/manager.js:247-248）：
 *     · plugin = 确定性型，靠 providers/hooks 必然触发；
 *     · skill  = LLM 型，注册工具、由模型决定什么时候用。
 *   本模块不提供任何能力（providers），只注册工具 + 提供提示词段落 + 两个钩子，
 *   触发时机由机器人模型判断 —— 所以它是技能，不是插件。
 *
 * 它做四件事：
 *   1. 工具 dsh_agent：把任务派给 DSH，把结果收回来；按会话保存 DSH 的 sessionId，
 *      同一个群里连续几次提问共享同一段 DSH 对话；
 *   2. 实时直播：DSH 干活期间，把它「现在第几步、在跑什么命令、在读哪个文件」
 *      按节流发到会话里（长任务不再是一段沉默）；
 *   3. 屏幕照片：工具 screen_shot 随时能拍一张这台电脑的屏幕发到会话，
 *      长任务过程中也可以按间隔自动拍（主人限定，防止把屏幕泄到群里）；
 *   4. 选项选择：DSH 需要主人做决定时，在回答末尾写一行 [[选项]] A | B | C，
 *      本技能会把它变成编号选项发到群里；主人回复数字后，自动把这次选择交回
 *      同一段 DSH 对话继续做。
 *
 * 为什么不走「替换大脑」：QQ Agent 的扩展点只能在 llm.endpoint-pick /
 * llm.request-params 这类位置做局部改动（见 src/llm.js 注释里的边界），
 * 不能把整个对话交给另一个 agent 托管。所以这里采用「派活 + 取回结果」的
 * 桥接方式：群里照常用你自己的模型聊天，只有真正需要硬活时才叫 DSH。
 *
 * 实测（本机 DSH 0.2.0-rc.2、headless 档、deepseek-flash）：
 *   · 一次简单任务约 3 秒，带 --session-id 续聊能记住上一轮；
 *   · --json 的事件流逐步到达：session → turn_start → step_start →
 *     thinking → tool_call → tool_result → step_end(usage) → turn_end → final，
 *     所以「实时」是拿 tool_call 事件做的（最后一条 final.text 是最终答案）。
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';

/** 与 manifest 里的 settings 保持一致（manifest 的值会覆盖这里）。 */
const DEFAULTS = {
  dshDir: 'D:\\dsh',
  profile: 'headless',
  timeoutMs: 180000,
  maxContextChars: 6000,
  maxReplyChars: 4000,
  workspaceDir: '',
  ownerIds: '3421632653',
  allowFromAnyone: false,
  triggerWords: 'dsh,问dsh,外援',
  replyPrefix: '【DSH】',
  liveProgress: true,
  progressIntervalMs: 8000,
  progressMax: 10,
  screenShots: true,
  shotIntervalMs: 25000,
  shotMax: 8,
  shotMaxWidth: 1600,
  shotStyle: 'session',
  cardLines: 22
};

/** 注册到 QQ Agent 之后，模型看到的工具全名（skillId__toolId）。 */
const TOOL_FULL_ID = 'dsh-bridge__dsh_agent';
const SCREEN_TOOL_FULL_ID = 'dsh-bridge__screen_shot';
/** 需要「主人」才能调用的工具（before-tool 硬闸按这个集合判定）。 */
const GATED_TOOLS = new Set([TOOL_FULL_ID, SCREEN_TOOL_FULL_ID]);

/** 选项的有效期：超过这个时间主人再回数字，就不当选项处理了。 */
const OPTION_TTL_MS = 30 * 60 * 1000;

/** 技能目录：<QQ Agent 程序目录>\skills\dsh-bridge */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
/** 回退用的 QQ Agent data 目录（拿不到 app 提供的路径时才用）。 */
const FALLBACK_DATA_DIR = path.resolve(PLUGIN_DIR, '..', '..', 'data');
/** 工作目录被系统权限挡住时的备选位置（主人自己的主目录，一定有完全控制）。 */
const FALLBACK_WORKSPACE = path.join(os.homedir(), 'dsh-bridge-workspace');
/** 每个工作目录只做一次「权限确认」（进程内缓存，顺便给并发调用去重）。 */
const workspacePrep = new Map();

/** 只允许同时跑一个 DSH 任务：串行队列，避免抢会话、抢 CPU。 */
let queueTail = Promise.resolve();
/** 同一个群的会话文件写入也要排队（虽然已经串行，这里再兜一层）。 */
let writeTail = Promise.resolve();

/** setup() 时把「怎么读配置 / 怎么拿存储」放进这里，供模块级 hooks 使用。 */
let hookRuntime = null;

/**
 * 当前正在跑的 DSH 任务（同一时刻只有一个，见 enqueue）。
 *
 * 为什么要有它：主人打「停」的时候得能真的把进程按死。QQ Agent 在工具调用进行中
 * 不会再开新一轮对话，所以「停」不能只靠模型/钩子 —— 得由技能自己在任务运行期间
 * 盯着聊天记录（见 startLive 里的 watchStop）并直接杀掉子进程。
 */
let activeRun = null;

/** 主人说「停」：杀掉正在跑的 DSH（连它拉起的子进程一起）。返回是否真的按下了。 */
function cancelActiveRun() {
  const run = activeRun;
  if (!run || !run.child) return false;
  run.cancelled = true;
  const pid = run.child.pid;
  try {
    if (process.platform === 'win32' && pid) {
      // DSH 自己会拉起 pwsh 之类的子进程，只杀父进程会留下孤儿继续跑
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      run.child.kill('SIGTERM');
    }
  } catch {
    try { run.child.kill(); } catch { /* 已经退出了就算了 */ }
  }
  return true;
}

/**
 * 整条消息就是一个「停」命令吗？
 *
 * 必须卡得很死：只有「停」「停下」「别干了」这种单独一句话才算数，
 * 「停下来看看这个文件」不算 —— 否则正常对话会被误杀。
 */
function isStopCommand(text) {
  const t = String(text ?? '').trim().replace(/\s+/g, '');
  if (!t || t.length > 8) return false;
  return /^(?:快|赶紧|赶快|请|给我|先)?(?:停|停下|停止|停一下|别干了|别跑了|别做了|不用了|不要了|取消|算了|中止|中断)[啊呀吧了嘛呗哦。！!？?~～]*$/.test(t);
}

/** 运行期状态，供 state() 暴露给控制台。 */
const stats = {
  loadedAt: Date.now(),
  runs: 0,
  failures: 0,
  timeouts: 0,
  lastError: '',
  lastDurationMs: 0,
  lastFinishedAt: 0,
  progressSent: 0,
  shotsSent: 0,
  optionsSent: 0,
  stopped: 0,
  workspaceFallbacks: 0
};

// ── 小工具 ─────────────────────────────────────────────────────────────────

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  cfg.dshDir = String(cfg.dshDir || DEFAULTS.dshDir).trim() || DEFAULTS.dshDir;
  cfg.profile = String(cfg.profile || DEFAULTS.profile).trim() || DEFAULTS.profile;
  cfg.timeoutMs = Math.max(10000, Number(cfg.timeoutMs) || DEFAULTS.timeoutMs);
  cfg.maxContextChars = Math.max(0, Number(cfg.maxContextChars) || 0);
  cfg.maxReplyChars = Math.max(200, Number(cfg.maxReplyChars) || DEFAULTS.maxReplyChars);
  cfg.workspaceDir = String(cfg.workspaceDir || '').trim();
  cfg.ownerIds = String(cfg.ownerIds ?? DEFAULTS.ownerIds).trim();
  cfg.allowFromAnyone = cfg.allowFromAnyone === true;
  // 留空 = 用内置默认词（dsh / 问dsh / 外援），避免用户清空后功能静默失效
  cfg.triggerWords = String(cfg.triggerWords ?? '').trim() || DEFAULTS.triggerWords;
  cfg.replyPrefix = cfg.replyPrefix === undefined || cfg.replyPrefix === null ? DEFAULTS.replyPrefix : String(cfg.replyPrefix);
  // 实时直播
  cfg.liveProgress = cfg.liveProgress !== false;
  cfg.progressIntervalMs = clamp(cfg.progressIntervalMs ?? DEFAULTS.progressIntervalMs, 2000, 60000);
  cfg.progressMax = clamp(cfg.progressMax ?? DEFAULTS.progressMax, 0, 50);
  // 屏幕照片
  cfg.screenShots = cfg.screenShots !== false;
  cfg.shotIntervalMs = clamp(cfg.shotIntervalMs ?? DEFAULTS.shotIntervalMs, 5000, 300000);
  cfg.shotMax = clamp(cfg.shotMax ?? DEFAULTS.shotMax, 0, 30);
  cfg.shotMaxWidth = clamp(cfg.shotMaxWidth ?? DEFAULTS.shotMaxWidth, 320, 4096);
  // 「发什么图」：session = 把这次 DSH 会话画成一张快照图（默认，见文件末尾的长注释）；
  // desktop = 拍真实屏幕
  const style = String(cfg.shotStyle ?? DEFAULTS.shotStyle).trim().toLowerCase();
  cfg.shotStyle = style === 'desktop' ? 'desktop' : 'session';
  cfg.cardLines = clamp(cfg.cardLines ?? DEFAULTS.cardLines, 6, 60);
  return cfg;
}

function pickDataDir(candidate) {
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  return FALLBACK_DATA_DIR;
}

/** DSH 的启动方式。
 *  首选：直接用「DeepSeek Harness.exe」以 Node 模式跑它自己的 cli.js
 *        （就是 dsh.cmd 里那一行，但绕开 .cmd —— Windows 上 .cmd 不能被
 *          spawn 直接启动，必须过 shell，而 shell 会把中文参数交给 cmd 的
 *          代码页，很容易变乱码）。
 *  兜底：没有 exe 时才退回 dsh.cmd，此时只能 shell:true。
 *
 *  注意：cli.js 在 app.asar 里面，普通 Node 的 existsSync 看不到 asar 内部
 *  的文件（会返回 false），所以这里只检查 exe 是否存在，不能去 stat cli.js。
 */
function resolveDshExe(dshDir) {
  const exe = path.join(dshDir, 'DeepSeek Harness.exe');
  if (existsSync(exe)) {
    const cli = path.join(dshDir, 'resources', 'app.asar', 'dsh', 'node_modules',
      '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
    return { command: exe, args: ['--expose-internals', cli], shell: false, kind: 'electron-node' };
  }
  const cmd = path.join(dshDir, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  if (existsSync(cmd)) return { command: cmd, args: [], shell: true, kind: 'cmd-shim' };
  return null;
}

/** Windows 自带的 PowerShell（拍屏幕要用它调 .NET 的 System.Drawing）。 */
function resolvePowerShell() {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const candidates = [
    path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(sysRoot, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return 'powershell.exe';
}

function stripControl(text) {
  // 去掉控制字符（保留换行与制表），QQ 消息里出现裸控制字符会很难看
  return String(text ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function truncate(text, max) {
  const s = String(text ?? '');
  if (!max || s.length <= max) return s;
  return `${s.slice(0, max)}\n\n…（内容过长，已截断 ${s.length - max} 字）`;
}

function tail(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : s.slice(s.length - max);
}

function oneLine(text, max = 90) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function clock() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 把字节数说成人话。 */
function humanBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 判断一次失败是不是「--session-id 指向的会话不存在」。 */
function isStaleSession(result) {
  const blob = `${result?.message || ''}\n${result?.stderr || ''}`;
  return /does not exist|unknown session|session .{0,40}not found|会话.{0,20}(不存在|找不到)/i.test(blob);
}

/** 当前的 Windows 用户名（icacls 用）。 */
function currentUserName() {
  try {
    const name = os.userInfo().username;
    if (name) return name;
  } catch { /* 拿不到就退回环境变量 */ }
  return String(process.env.USERNAME || process.env.USER || '').trim();
}

/**
 * DSH 在 Windows 上会给它自己跑的命令加一层沙箱：启动时要往「工作目录」的权限表
 * 里写一条放行规则。如果这个目录的权限表里没有当前用户的「完全控制」，那次写入
 * 会被系统直接拒绝（ERROR_ACCESS_DENIED），DSH 只能报
 * `SetNamedSecurityInfoW failed (Win32 5): grantWrite(<目录>)`，于是**一条命令都跑不了**。
 *
 * 这里在派活前先把工作目录的权限写实：给当前用户补一条「完全控制」（他本来就是
 * 这个目录的主人，这只是把隐含的权限显式写出来）。只做一次、失败也照常继续 ——
 * 真出问题还有 callDsh 里的换目录重试兜底。
 */
function ensureWorkspaceAccess(workspace, log, warn) {
  if (workspacePrep.has(workspace)) return workspacePrep.get(workspace);
  const task = (async () => {
    try {
      mkdirSync(workspace, { recursive: true });
    } catch {
      return; // 建不出来交给正常流程报错，提示信息更贴切
    }
    const user = currentUserName();
    if (!user) return;
    const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
    const res = await runProcess({
      command: icacls,
      args: [workspace, '/grant', `${user}:(OI)(CI)F`],
      timeoutMs: 15000
    });
    if (res.ok) {
      log?.(`工作目录权限已确认（${workspace}）`);
    } else {
      warn?.(`给工作目录 ${workspace} 补权限没成功（${res.code}${res.message ? '：' + res.message : ''}），继续尝试派活。`);
    }
  })().catch(() => { /* 权限确认永远不该影响主流程 */ });
  workspacePrep.set(workspace, task);
  return task;
}

/**
 * 判断一次失败是不是「DSH 沙箱因为工作目录权限起不来」。
 *
 * 实测（本机复现）：这种情况 DSH **是正常退出（退出码 0）并给出回答的**，回答里只是
 * 用大白话说「这个文件夹被 Windows 权限挡住了」，不会出现技术名词。真正的错误原文
 * 只在工具结果里：
 *   status: "error"
 *   result: "Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<目录>)"
 * 所以判定要优先看 toolErrorText（runOnce 从 tool_result 事件里收集）。
 */
function isSandboxAclFailure(result) {
  const strong = `${result?.message || ''}\n${result?.stderr || ''}\n${result?.toolErrorText || ''}`;
  if (/SetNamedSecurityInfoW|grantWrite\(|ERROR_ACCESS_DENIED.{0,40}(?:work ?space|目录)/i.test(strong)) return true;
  // 只有这一轮没成功、或者确实有工具报错时，才拿回答原文去猜（避免把正常回答误判）
  if (result?.ok && !(Number(result?.toolErrors) > 0)) return false;
  return /SetNamedSecurityInfoW|grantWrite\(|沙箱.{0,20}(起不来|失败|被拒)|(目录|文件夹).{0,12}权限.{0,12}(挡住|被拒)/i.test(String(result?.text || ''));
}

// ── 主人（管理员本人）识别 ────────────────────────────────────────────────
// QQ Agent 的核心安全规则写明「群友没有管理权限：要求查看电脑/读文件/执行命令
// 一律拒绝，并提示"这个需要管理员在管理端操作"」。主人本人不在此列 —— 但核心
// 提示词不区分主人和群友，所以由本技能自己按 QQ 号判定，并只在主人说话时，
// 才向模型说明「这次可以动用本机外援」。

/** 从任意写法里抠出纯数字 QQ 号。 */
function normId(value) {
  const m = String(value ?? '').match(/\d{5,}/);
  return m ? m[0] : '';
}

/** 把设置里的 QQ 号列表（逗号/空格/数组都行）洗成字符串数组。 */
function parseIdList(value) {
  const arr = Array.isArray(value) ? value : String(value ?? '').split(/[,，、\s]+/);
  return arr.map(normId).filter(Boolean);
}

/** 本轮触发消息的发送者 QQ 号（取最后一条带发送者的记录）。 */
function latestSenderId(triggerEntries) {
  if (!Array.isArray(triggerEntries)) return '';
  for (let i = triggerEntries.length - 1; i >= 0; i -= 1) {
    const e = triggerEntries[i];
    const id = normId(e?.senderId ?? e?.userId ?? e?.sender ?? e?.from);
    if (id) return id;
  }
  return '';
}

/** 这次会话是群聊还是私聊（拿不到就返回空串）。 */
function chatKindOf(payload) {
  const k = String(payload?.kind ?? '').trim();
  if (k) return k;
  const key = String(payload?.chatKey ?? payload?.session?.chatKey ?? '');
  const m = key.match(/^([a-zA-Z]+):/);
  return m ? m[1] : '';
}

/**
 * 判定「这条消息是不是主人发的」。
 * - 拿得到发送者 QQ：命中 ownerIds 才算主人。
 * - 拿不到发送者：私聊/信息不全时按主人处理（机器人主动开口就是这种情况，那本来就是
 *   主人的机器人）；但**群聊里认不出是谁就一律不算主人**，宁可不干活也不能让群友
 *   借这个口子碰本机。
 * - ownerIds 留空：谁都不是主人（授权整体关闭，最保守）。
 */
function ownerState(payload, cfg) {
  const owners = parseIdList(cfg?.ownerIds);
  const senderId = latestSenderId(payload?.triggerEntries);
  const unknown = !senderId;
  const kind = chatKindOf(payload);
  const assumeOwner = unknown && kind !== 'group';
  const isOwner = owners.length > 0 && (assumeOwner || (!!senderId && owners.includes(senderId)));
  return { owners, senderId, unknown, kind, assumeOwner, isOwner };
}

/** 本轮触发消息的原文（触发词按它来匹配最准；没有就退回即将发出的最后一条用户消息）。 */
function triggerText(triggerEntries) {
  if (!Array.isArray(triggerEntries)) return '';
  return triggerEntries.map((e) => String(e?.text ?? '')).filter(Boolean).join('\n').trim();
}

/** 消息里是否出现触发词，返回命中的那个词。 */
function keywordHit(text, keywords) {
  const words = String(keywords ?? '').split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
  const hay = String(text ?? '').toLowerCase();
  return words.find((w) => hay.includes(w.toLowerCase())) || '';
}

function lastUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (Array.isArray(m.content)) {
      const joined = m.content
        .map((part) => (typeof part === 'string' ? part : (part?.type === 'text' ? part.text : '')))
        .filter(Boolean)
        .join(' ');
      if (joined) return joined;
    }
  }
  return '';
}

/** 把聊天上下文压缩成一段可读的文字，交给 DSH。 */
function buildContextDigest(messages, maxChars) {
  if (!maxChars || !Array.isArray(messages) || messages.length === 0) return '';
  const lines = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m || m.role === 'system') continue;
    const text = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.filter((p) => p?.type === 'text').map((p) => p.text).join(' ') : '');
    if (!text.trim()) continue;
    const who = m.role === 'user' ? (m.name || '用户') : '机器人';
    lines.unshift(`${who}: ${stripControl(text).trim()}`);
  }
  let digest = lines.join('\n');
  if (digest.length > maxChars) digest = `（更早的对话已省略）\n${tail(digest, maxChars)}`;
  return digest;
}

/** 把宿主的消息记录 / 触发消息统一成 {role,name,content}（字段名有几种写法，都认）。 */
function toContextMessage(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const text = stripControl(String(entry.text ?? entry.content ?? '')).trim();
  if (!text) return null;
  const self = entry.self === true || entry.fromSelf === true || entry.isSelf === true;
  const name = self ? '机器人' : String(entry.senderName || entry.name || entry.senderId || '群友');
  return { role: self ? 'assistant' : 'user', name, content: text };
}

/**
 * 取「最近这段对话」—— 这是 DSH 看懂指代的唯一依据。
 * 坑：宿主传给工具技能的 ctx 里**没有 messages 字段**（只有 chatKey/store/session…），
 * 之前直接读 ctx.messages，结果 digest 永远是空的：DSH 收到的只有模型自己写的那句
 * task，主人问「它呢」「这个呢」时它自然一脸茫然。真正拿得到聊天记录的是：
 *   1) ctx.store.recent(chatKey) —— 里头的消息记录，含主人刚说的那句（self:true 是机器人自己）；
 *   2) ctx.session.trigger —— 本轮触发消息（兜底）；
 *   3) ctx.messages —— 宿主将来若提供就直接用。
 */
function collectContextMessages(ctx, limit = 24) {
  if (Array.isArray(ctx?.messages) && ctx.messages.length) return ctx.messages.slice(-limit);
  const rows = [];
  try {
    const store = ctx?.store;
    const chatKey = ctx?.chatKey;
    if (store && typeof store.recent === 'function' && chatKey) {
      for (const entry of store.recent(chatKey, { limit, offset: 0, includeSelf: true }) || []) {
        const m = toContextMessage(entry);
        if (m) rows.push(m);
      }
    }
  } catch { /* 拿不到记录就退回触发消息 */ }
  if (!rows.length) {
    for (const entry of (Array.isArray(ctx?.session?.trigger) ? ctx.session.trigger : [])) {
      const m = toContextMessage(entry);
      if (m) rows.push(m);
    }
  }
  return rows;
}

// ── 把 DSH 的 tool_call 事件说成人话 ───────────────────────────────────────
// --json 事件流里 tool_call 长这样：
//   { type:'tool_call', tool:'pwsh', input:{ command:'...', description:'...' } }
// 这里只取「主人看得懂的一行」，绝不把整段脚本贴到群里。

function describeToolCall(tool, input) {
  const name = String(tool || '').trim() || '工具';
  const bag = input && typeof input === 'object' ? input : {};
  const pick = (...keys) => {
    for (const k of keys) {
      const v = bag[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (Array.isArray(v) && v.length && typeof v[0] === 'string') return v.join(' ');
    }
    return '';
  };
  const p = pick('path', 'file_path', 'filePath', 'filename', 'target', 'file');
  if (/pwsh|bash|shell|cmd|terminal|exec/i.test(name)) {
    const cmd = pick('command', 'cmd', 'command_line', 'script');
    const desc = pick('description');
    return cmd ? `跑命令：${oneLine(cmd, 100)}` : `跑命令${desc ? `：${oneLine(desc, 80)}` : ''}`;
  }
  if (/read|cat|view/i.test(name)) return `读文件：${oneLine(p, 90) || name}`;
  if (/write|edit|patch|create/i.test(name)) return `改文件：${oneLine(p, 90) || name}`;
  if (/glob|list|ls|find_files/i.test(name)) return `找文件：${oneLine(pick('pattern', 'glob', 'path'), 80) || name}`;
  if (/grep|search/i.test(name)) return `搜内容：${oneLine(pick('pattern', 'query', 'regex'), 80) || name}`;
  if (/fetch|http|curl|download/i.test(name)) return `取网页：${oneLine(pick('url', 'query'), 80) || name}`;
  if (/web|browse/i.test(name)) return `联网查：${oneLine(pick('query', 'url'), 80) || name}`;
  if (/task|agent|subagent/i.test(name)) return `派子任务：${oneLine(pick('description', 'prompt'), 70) || name}`;
  if (/screenshot|screen/i.test(name)) return '拍屏幕';
  return `用 ${name}${p ? `：${oneLine(p, 70)}` : ''}`;
}

// ── 选项协议：DSH 提问、主人回数字 ─────────────────────────────────────────
// DSH 的回答里如果出现单独一行 `[[选项]] A | B | C`，本技能就把它变成编号
// 选项发到群里，并把「待选择」记在 pending.json 里；主人回复「2」以后，
// before-llm-messages 钩子把选择注入模型上下文，让它把选择交回同一段对话。

/** 从 DSH 的回答里切出 [[选项]] 那一行。 */
function splitOptions(text) {
  const s = String(text ?? '');
  const re = /^[ \t]*\[\[[ \t]*选项[ \t]*\]\][ \t]*[:：]?[ \t]*(.+)$/im;
  const m = s.match(re);
  if (!m) return { text: s.trim(), options: [] };
  const options = String(m[1])
    .split(/[|｜]/)
    .map((x) => String(x)
      .replace(/^\s*(?:\d{1,2}|[一二两三四五六七八九十])\s*[.、．)）:：]\s*/, '')
      .replace(/^\s*\d{1,2}\s+/, '')
      .trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((x) => (x.length > 40 ? `${x.slice(0, 40)}…` : x));
  const cleaned = s.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text: cleaned, options };
}

const CN_NUM = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6 };

/** 主人的回复是不是「选项里的某一条」。 */
function matchChoice(text, options) {
  const raw = String(text ?? '').trim();
  if (!raw || !Array.isArray(options) || !options.length) return null;
  const t = raw.replace(/^[【\[]|[】\]]$/g, '').trim();
  // 「3」「选3」「第3个」「3.」「3、」「3号」
  const m = t.match(/^(?:我?选|我选第|选第|第)?\s*([1-9]|[一二两三四五六])\s*(?:个|项|号|条)?\s*[.。、,)）]?$/);
  if (m) {
    const n = CN_NUM[m[1]] || Number(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= options.length) {
      return { index: n - 1, how: 'number', raw };
    }
  }
  // 直接说了选项内容
  const idx = options.findIndex((o) => {
    const opt = String(o).trim();
    if (!opt) return false;
    if (t === opt) return true;
    return opt.length >= 3 && (t.includes(opt) || opt.includes(t)) && t.length >= 2;
  });
  if (idx >= 0) return { index: idx, how: 'text', raw };
  return null;
}

// ── 会话记忆 / 运行日志 / 待选选项 ─────────────────────────────────────────

function createStore(dataDir, log) {
  const scopedDataDir = pickDataDir(dataDir);
  const storeDir = path.join(scopedDataDir, 'dsh-bridge');
  const sessionsPath = path.join(storeDir, 'sessions.json');
  const logPath = path.join(storeDir, 'runs.ndjson');
  const pendingPath = path.join(storeDir, 'pending.json');
  const shotsDir = path.join(storeDir, 'shots');

  function ensureDir() {
    try {
      mkdirSync(storeDir, { recursive: true });
      return true;
    } catch (error) {
      log(`⚠️ 无法创建数据目录 ${storeDir}：${error.message}`);
      return false;
    }
  }

  function readJson(file, fallback) {
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(file, value) {
    const runWrite = () => {
      try {
        ensureDir();
        writeFileSync(file, JSON.stringify(value(), null, 2), 'utf8');
      } catch (error) {
        log(`⚠️ 写入 ${path.basename(file)} 失败：${error.message}`);
      }
    };
    writeTail = writeTail.then(runWrite, runWrite);
  }

  function readSessions() {
    return readJson(sessionsPath, {});
  }

  function get(chatKey) {
    if (!chatKey) return '';
    const hit = readSessions()[String(chatKey)];
    return hit && typeof hit.sessionId === 'string' ? hit.sessionId : '';
  }

  function set(chatKey, sessionId, extra = {}) {
    if (!chatKey || !sessionId) return;
    writeJson(sessionsPath, () => {
      const all = readSessions();
      all[String(chatKey)] = { sessionId: String(sessionId), updatedAt: Date.now(), ...extra };
      return all;
    });
  }

  function forget(chatKey) {
    if (!chatKey) return;
    writeJson(sessionsPath, () => {
      const all = readSessions();
      delete all[String(chatKey)];
      return all;
    });
  }

  function logRun(record) {
    if (!ensureDir()) return;
    try {
      appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      /* 运行日志失败不影响主流程 */
    }
  }

  // ── 待选选项 ──
  function setPending(chatKey, data) {
    if (!chatKey) return;
    writeJson(pendingPath, () => {
      const all = readJson(pendingPath, {});
      all[String(chatKey)] = { at: Date.now(), ...data };
      return all;
    });
  }

  function getPending(chatKey, ttlMs = OPTION_TTL_MS) {
    if (!chatKey) return null;
    const hit = readJson(pendingPath, {})[String(chatKey)];
    if (!hit || !Array.isArray(hit.options) || !hit.options.length) return null;
    if (ttlMs && Date.now() - Number(hit.at || 0) > ttlMs) return null;
    return hit;
  }

  function clearPending(chatKey) {
    if (!chatKey) return;
    writeJson(pendingPath, () => {
      const all = readJson(pendingPath, {});
      delete all[String(chatKey)];
      return all;
    });
  }

  function countPending() {
    return Object.keys(readJson(pendingPath, {})).length;
  }

  ensureDir();
  return {
    dir: storeDir, sessionsPath, logPath, pendingPath, shotsDir,
    get, set, forget, logRun,
    setPending, getPending, clearPending, countPending, ensureDir
  };
}

// ── 跑一个外部进程（PowerShell 用） ────────────────────────────────────────

function runProcess({ command, args, cwd, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ ok: false, code: 'SPAWN_THREW', message: error.message, stdout: '', stderr: '' });
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* 已退出 */ }
      resolve({ ok: false, code: 'TIMEOUT', message: `超过 ${Math.round(timeoutMs / 1000)} 秒没返回`, stdout: out, stderr: err });
    }, timeoutMs);
    child.stdout.on('data', (c) => { out = tail(out + c.toString('utf8'), 20000); });
    child.stderr.on('data', (c) => { err = tail(err + c.toString('utf8'), 8000); });
    child.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, code: 'SPAWN_ERROR', message: error.message, stdout: out, stderr: err });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const lastErr = String(err || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
      resolve({ ok: code === 0, code: `EXIT_${code}`, message: lastErr, stdout: out, stderr: err });
    });
  });
}

// ── 拍屏幕 ─────────────────────────────────────────────────────────────────
// 用 Windows 自带的 PowerShell 调 .NET。默认锚定 **DSH 自己的窗口**：
// 先按 exe 路径找出 DSH 的主窗口，用 PrintWindow 单独渲染它（被别的窗口
// 挡住也能拍，且拍到的永远是 DSH 而不是当时恰好在前台的那个程序）；DSH
// 窗口找不到或还最小化着（最多等 12 秒）才退回整块虚拟桌面。太宽时等比
// 缩小存成 PNG。脚本落在一个临时 .ps1 里 —— 这样不用把多行脚本塞进命令行
// 参数（Windows 的参数转义会把它搞坏），也方便排查。

const SHOT_SCRIPT = `param(
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$MaxWidth = 1600,
  [string]$WindowExe = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinShot {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

# 关键一步：先声明 DPI 感知，**再**去碰任何屏幕/窗口 API（WinForms 的 Screen
# 会把第一次量到的尺寸缓存起来，所以顺序不能反）。
# 原因：Windows PowerShell 5.1 默认是「不感知 DPI」，在 150% 缩放的机器上它量到
# 的是虚拟化尺寸（1707x1067），而 DSH（Electron）是按物理像素自绘的 —— 于是
# PrintWindow 把 2560 宽的画面画进 1294 宽的小位图里，右边和下边整块被裁掉，
# 这就是「照片拍不全 DSH」。声明感知后量到的是物理像素，位图和窗口一样大。
# PMv2(-4) 优先（Win10 1703+，多显示器/混合缩放最准），失败退回系统级感知。
$dpiAware = 'unaware'
try {
  if ([WinShot]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $dpiAware = 'per-monitor-v2' }
} catch { }
if ($dpiAware -eq 'unaware') {
  try { if ([WinShot]::SetProcessDPIAware()) { $dpiAware = 'system' } } catch { }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# 按 exe 路径找 DSH 主窗口。刚重启过时窗口可能还没建出来，所以最多等 12 秒。
# 被别的窗口挡住没关系（PrintWindow 照拍），但**最小化**的窗口得先恢复出来：
# 不然只能退回整屏截图，拍到的是桌面而不是 DSH —— 之前踩的就是这个坑。
# 用 SW_SHOWNOACTIVATE(4) 恢复，不抢当前焦点。
function Wait-DshWindow {
  param([string]$Exe, [int]$TimeoutMs = 12000)
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  while ((Get-Date) -lt $deadline) {
    $iconic = [IntPtr]::Zero
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
      try { if ($p.Path -ine $Exe) { continue } } catch { continue }
      $h = [IntPtr]$p.MainWindowHandle
      if ($h -eq [IntPtr]::Zero) { continue }
      if (-not [WinShot]::IsWindowVisible($h)) { continue }
      if ([WinShot]::IsIconic($h)) { if ($iconic -eq [IntPtr]::Zero) { $iconic = $h }; continue }
      return $h
    }
    # 一个没最小化的都没有：等一会儿（可能正在重启），一直等不到就用最小化的那个
    if ($iconic -ne [IntPtr]::Zero) { return $iconic }
    Start-Sleep -Milliseconds 400
  }
  return [IntPtr]::Zero
}

$kind = 'fullscreen'
$w = 0
$h = 0
$bmp = $null

if ($WindowExe -ne '') {
  $hWnd = Wait-DshWindow -Exe $WindowExe
  if ($hWnd -ne [IntPtr]::Zero) {
    # 最小化的窗口恢复成普通大小再量尺寸，否则量到的是 -32000 那种最小化坐标
    if ([WinShot]::IsIconic($hWnd)) {
      [void][WinShot]::ShowWindow($hWnd, 4)
      Start-Sleep -Milliseconds 500
    }
    $r = New-Object WinShot+RECT
    [void][WinShot]::GetWindowRect($hWnd, [ref]$r)
    $w = [int]($r.Right - $r.Left)
    $h = [int]($r.Bottom - $r.Top)
    if ($w -ge 64 -and $h -ge 64) {
      $bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $hdc = $g.GetHdc()
      # PW_RENDERFULLCONTENT(2)：Chromium 这类自绘窗口也能在被遮挡时单独渲染
      $ok = [WinShot]::PrintWindow($hWnd, $hdc, 2)
      $g.ReleaseHdc($hdc)
      $g.Dispose()
      if ($ok) {
        $kind = 'window'
      } else {
        $bmp.Dispose()
        $bmp = $null
        $w = 0
        $h = 0
      }
    } else {
      $w = 0
      $h = 0
    }
  }
  if ($null -eq $bmp) { $kind = 'fullscreen-nofallback' }
}

if ($null -eq $bmp) {
  $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $w = [int]$vs.Width
  $h = [int]$vs.Height
  if ($w -lt 8 -or $h -lt 8) { throw 'screen size looks invalid' }
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen([int]$vs.Left, [int]$vs.Top, 0, 0, (New-Object System.Drawing.Size -ArgumentList $w, $h))
  $g.Dispose()
}

if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) {
  $nw = $MaxWidth
  $nh = [int][Math]::Round($h * $MaxWidth / $w)
  $small = New-Object System.Drawing.Bitmap -ArgumentList $nw, $nh
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $nw, $nh)
  $g2.Dispose()
  $bmp.Dispose()
  $bmp = $small
  # 报出去的尺寸必须是「真正存下来的那张」的尺寸：下面那行 OK 是从 $w/$h 拼的，
  # 不更新的话日志会写 1941x1243 而文件其实是 320x205（排查时会被带偏）。
  $w = $nw
  $h = $nh
}
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ('OK ' + $kind + ' ' + $w + 'x' + $h + ' dpi=' + $dpiAware)
`;

/** 截图要锚定的目标：DSH 自己的 exe —— 按这个路径去认它的窗口。 */
function shotTargetExe() {
  const dir = String(process.env.DSH_DIR || '').trim() || DEFAULTS.dshDir;
  return resolveDshExe(dir)?.command || '';
}

/** 只保留最近的若干张截图，别把磁盘堆满。 */
function pruneShots(dir, keep = 30) {
  try {
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.png')).sort();
    while (files.length > keep) {
      const gone = files.shift();
      try { unlinkSync(path.join(dir, gone)); } catch { /* 占用中就留着 */ }
    }
  } catch { /* 目录不存在等情况直接忽略 */ }
}

// 坑：Windows PowerShell 5.1 读没有 BOM 的 .ps1 时按系统 ANSI（简中是 GBK）解码，
// 脚本里只要有中文注释或任何非 ASCII 字符就会整体解析失败（报 UnexpectedToken），
// 而 writeFileSync 默认不加 BOM。所以这里显式带上 UTF-8 BOM。
function writePsScript(file, script) {
  writeFileSync(file, `\uFEFF${script}`, 'utf8');
}

function readPsScript(file) {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

async function captureScreen({ storeDir, maxWidth, log, warn, source = 'dsh' }) {
  const shotsDir = path.join(storeDir, 'shots');
  try {
    mkdirSync(shotsDir, { recursive: true });
  } catch (error) {
    return { ok: false, message: `无法创建截图目录：${error.message}` };
  }
  const scriptPath = path.join(storeDir, 'shot.ps1');
  try {
    if (readPsScript(scriptPath) !== SHOT_SCRIPT) writePsScript(scriptPath, SHOT_SCRIPT);
  } catch (error) {
    return { ok: false, message: `无法写入截图脚本：${error.message}` };
  }

  const outPath = path.join(shotsDir, `shot-${stamp()}.png`);
  // source='dsh'（默认）：只拍 DSH 窗口；'fullscreen'：整个桌面，别的程序也不放过。
  const windowExe = source === 'fullscreen' ? '' : shotTargetExe();
  const res = await runProcess({
    command: resolvePowerShell(),
    args: [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, '-Out', outPath, '-MaxWidth', String(maxWidth || 0),
      '-WindowExe', windowExe
    ],
    timeoutMs: 30000
  });
  if (!res.ok || !existsSync(outPath)) {
    return { ok: false, message: res.message || res.stderr || res.code || '没有生成图片' };
  }
  let bytes = 0;
  try { bytes = statSync(outPath).size; } catch { /* 拿不到大小不影响 */ }
  if (!bytes) return { ok: false, message: '截图是空文件' };
  pruneShots(shotsDir, 30);
  // 脚本最后会回一行 `OK <window|fullscreen...> <宽>x<高> dpi=<per-monitor-v2|system|unaware>`
  const meta = /OK\s+(\S+)\s+(\d+)x(\d+)(?:\s+dpi=(\S+))?/.exec(String(res.stdout || ''));
  const kind = meta ? meta[1] : '';
  const width = meta ? Number(meta[2]) : 0;
  const height = meta ? Number(meta[3]) : 0;
  const dpi = meta && meta[4] ? meta[4] : 'unknown';
  const note = source === 'fullscreen'
    ? '整个桌面'
    : (kind === 'window' ? 'DSH 窗口' : '整个桌面（没找到 DSH 窗口）');
  log?.(`已拍下${note} ${width}x${height} dpi=${dpi} ${outPath}（${humanBytes(bytes)}）`);
  if (dpi === 'unaware') {
    // 没声明成 DPI 感知时只能拍到窗口的左上角一块（图会被裁），值得在日志里点出来
    warn?.(`这张截图是在「不感知 DPI」下拍的（${width}x${height}），可能只拍到窗口的一部分。`);
  }
  return { ok: true, path: outPath, bytes, source: note, width, height, dpi };
}

// ── 会话快照图（不依赖 DSH 窗口）────────────────────────────────────────────

/**
 * 为什么要有这个：无头模式的 DSH 根本没有窗口，而且它跑在自己的独立 profile 里，
 * 桌面端 GUI 里也看不到这次任务 —— 所以「拍 DSH 窗口」永远拍不到主人问的那个会话
 * （拍到的只是桌面端恰好开着的另一个会话），窗口一最小化还会退化成整屏桌面。
 * 改成让技能按执行过程自己画一张图：内容一定对得上、永远拍得到、不用叫出窗口。
 *
 * 脚本只负责画，中文全部走 JSON 文件（脚本保持纯 ASCII，避开 PowerShell 的编码坑）。
 */
const SESSION_CARD_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$Model,
  [Parameter(Mandatory=$true)][string]$Out
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$m = Get-Content -LiteralPath $Model -Raw -Encoding UTF8 | ConvertFrom-Json

# 字体：优先雅黑（中文必须先挑有中文的字体，否则全是方框）
$families = @()
try { $families = ([System.Drawing.Text.InstalledFontCollection]::new()).Families | ForEach-Object { $_.Name } } catch { }
$fontName = 'Arial'
foreach ($n in @('Microsoft YaHei UI','Microsoft YaHei','SimHei','SimSun','Arial')) {
  if ($families -contains $n) { $fontName = $n; break }
}
$fam = [System.Drawing.FontFamily]::new($fontName)

$W = [int]$m.width
if ($W -le 0) { $W = 1200 }
$PAD = 40
$contentW = $W - ($PAD * 2)

# 量文字用的离屏画布 + 字体缓存（逐字测宽要跑几千次，必须缓存）
$mbox = [System.Drawing.Bitmap]::new(8, 8)
$mg = [System.Drawing.Graphics]::FromImage($mbox)
$mg.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$script:fontCache = @{}

function Get-Fnt([single]$size, [string]$style) {
  $key = [string]$size + '|' + $style
  if (-not $script:fontCache.ContainsKey($key)) {
    $st = [System.Drawing.FontStyle]::Regular
    if ($style -eq 'bold') { $st = [System.Drawing.FontStyle]::Bold }
    $script:fontCache[$key] = [System.Drawing.Font]::new($fam, $size, $st, [System.Drawing.GraphicsUnit]::Pixel)
  }
  return $script:fontCache[$key]
}

function Measure-Str([string]$s, [single]$size, [string]$style) {
  if ($s.Length -eq 0) { return [single]0 }
  return $mg.MeasureString($s, (Get-Fnt $size $style), 100000).Width
}

# 按像素宽度逐字换行（中英混排没法用固定列数）
function Wrap-Str([string]$s, [single]$size, [single]$maxW, [string]$style) {
  $res = New-Object System.Collections.ArrayList
  foreach ($para in [regex]::Split($s, "\r?\n")) {
    if ($para.Length -eq 0) { [void]$res.Add(''); continue }
    $cur = ''
    foreach ($ch in $para.ToCharArray()) {
      $try = $cur + [string]$ch
      if (($cur.Length -gt 0) -and ((Measure-Str $try $size $style) -gt $maxW)) {
        [void]$res.Add($cur)
        $cur = [string]$ch
      } else {
        $cur = $try
      }
    }
    [void]$res.Add($cur)
  }
  return ,$res
}

# ── 排版：先把每一行摊成「一个视觉行」，算完高度再真正画 ──
$items = New-Object System.Collections.ArrayList
[void]$items.Add(@{k='title'; t=[string]$m.title; s=30; st='bold'; c='#FFFFFF'; h=46})
[void]$items.Add(@{k='body'; t=[string]$m.meta; s=17; st='regular'; c='#98A2B3'; h=26; ind=0; m=''; mc=''})
if ($m.note) { [void]$items.Add(@{k='body'; t=[string]$m.note; s=16; st='regular'; c='#6B7280'; h=24; ind=0; m=''; mc=''}) }
if ($m.statusText) { [void]$items.Add(@{k='body'; t=[string]$m.statusText; s=19; st='bold'; c=[string]$m.statusColor; h=34; ind=0; m=''; mc=''}) }
[void]$items.Add(@{k='gap'; h=14})
[void]$items.Add(@{k='body'; t=[string]$m.taskLabel; s=16; st='bold'; c='#6EA8FE'; h=30; ind=0; m=''; mc=''})
foreach ($l in (Wrap-Str ([string]$m.task) 21 $contentW 'regular')) {
  [void]$items.Add(@{k='body'; t=$l; s=21; st='regular'; c='#EDEFF3'; h=30; ind=0; m=''; mc=''})
}
[void]$items.Add(@{k='gap'; h=16})
[void]$items.Add(@{k='body'; t=[string]$m.timelineLabel; s=16; st='bold'; c='#6EA8FE'; h=30; ind=0; m=''; mc=''})

$mw = 26
foreach ($ln in $m.lines) {
  $col = [string]$ln.color
  $mk = [string]$ln.mark
  $wrapped = Wrap-Str ([string]$ln.text) 19 ($contentW - $mw) 'regular'
  $first = $true
  foreach ($wl in $wrapped) {
    $mark = ''
    $mc = ''
    if ($first) { $mark = $mk; $mc = [string]$ln.markColor }
    [void]$items.Add(@{k='body'; t=$wl; s=19; st='regular'; c=$col; h=27; ind=$mw; m=$mark; mc=$mc})
    $first = $false
  }
}

$H = $PAD
foreach ($it in $items) { $H += [int]$it.h }
$H += 32 + 46 + $PAD
if ($H -lt 420) { $H = 420 }
if ($H -gt 6000) { $H = 6000 }

$bmp = [System.Drawing.Bitmap]::new($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.ColorTranslator]::FromHtml('#0F1218'))
$g.FillRectangle(([System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#4C9AFF'))), 0, 0, $W, 6)

$center = [System.Drawing.StringFormat]::new()
$center.Alignment = [System.Drawing.StringAlignment]::Center
$center.LineAlignment = [System.Drawing.StringAlignment]::Center
$dark = [System.Drawing.ColorTranslator]::FromHtml('#0F1218')

$y = $PAD
foreach ($it in $items) {
  if ($it.k -eq 'gap') { $y += [int]$it.h; continue }
  $x = $PAD + [int]$it.ind
  if ($it.m -ne '') {
    $g.FillRectangle(([System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($it.mc))), $PAD, ($y + 4), 18, 18)
    $rect = [System.Drawing.RectangleF]::new($PAD, ($y + 4), 18, 18)
    $g.DrawString($it.m, (Get-Fnt 12 'bold'), ([System.Drawing.SolidBrush]::new($dark)), $rect, $center)
  }
  $g.DrawString($it.t, (Get-Fnt $it.s $it.st), ([System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($it.c))), $x, $y)
  $y += [int]$it.h
}

$g.DrawLine(([System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#232A36'), 1)), $PAD, ($y + 8), ($W - $PAD), ($y + 8))
$g.DrawString([string]$m.footer, (Get-Fnt 16 'regular'), ([System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#8A93A3'))), $PAD, ($y + 22))

$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
$mbox.Dispose()
Write-Output ('OK ' + $W + 'x' + $H + ' lines=' + $items.Count)
`;

/** 快照图里每类行的小方块与文字颜色。 */
const CARD_LINE_STYLES = {
  command: { mark: '命', markColor: '#4C9AFF', color: '#DCE7F5' },
  result: { mark: '果', markColor: '#3A4250', color: '#D7DCE5' },
  failure: { mark: '错', markColor: '#FF6B4A', color: '#FFC9BC' },
  thinking: { mark: '想', markColor: '#4B5563', color: '#9AA3B2' },
  answer: { mark: '答', markColor: '#FFD166', color: '#FFE9AE' },
  info: { mark: '·', markColor: '#3A4250', color: '#9AA3B2' }
};

const CARD_STATUS = {
  running: { text: '进行中：DSH 正在干活', color: '#6EA8FE' },
  ok: { text: '已完成', color: '#34C759' },
  stopped: { text: '已停止（主人喊停 / 超时）', color: '#FFD166' },
  fail: { text: '这一轮没干成', color: '#FF6B4A' },
  past: { text: '这是刚才那一轮的快照（已经结束）', color: '#8A93A3' },
  idle: { text: '还没跑过任务', color: '#8A93A3' }
};

/** 上一轮任务的快照数据（手动「看这次会话」时用它重画一张）。 */
let lastRunSnapshot = null;

function cardClock(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function cardDuration(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 60) return `${s} 秒`;
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/**
 * 把「这一轮任务」整理成画图用的数据（纯函数，好测）。
 * transcript 每项 { kind, text }，kind 见 CARD_LINE_STYLES。
 */
function buildCardModel({
  task, startedAt, step, transcript, workspace, sessionId, answer, status = 'running', maxLines = 22, width = 1200
} = {}) {
  const st = CARD_STATUS[status] || CARD_STATUS.running;
  const items = Array.isArray(transcript) ? transcript : [];
  const keep = Math.max(4, Math.min(200, Number(maxLines) || 22));
  const lines = [];
  for (const it of items.slice(-keep)) {
    const kind = String(it?.kind || 'info');
    const style = CARD_LINE_STYLES[kind] || CARD_LINE_STYLES.info;
    lines.push({
      mark: style.mark,
      markColor: style.markColor,
      color: style.color,
      text: oneLine(String(it?.text ?? ''), 400)
    });
  }
  if (!lines.length) lines.push({ ...CARD_LINE_STYLES.info, text: '（还没有动静）' });
  if (status === 'ok' && answer) {
    lines.push({ ...CARD_LINE_STYLES.answer, text: `最终答复：${oneLine(String(answer), 240)}` });
  }
  const started = Number(startedAt) || Date.now();
  return {
    width: Math.max(600, Math.min(2400, Number(width) || 1200)),
    title: 'DSH 会话快照',
    meta: `开始 ${cardClock(started)}　·　跑了 ${cardDuration(Date.now() - started)}　·　走到第 ${Number(step) || 0} 步`,
    note: '无头 DSH 没有窗口（桌面端里也看不到这次任务），所以这张图由技能按执行过程生成，不是截屏。想看真实屏幕就说「拍张屏幕照」。',
    statusText: st.text,
    statusColor: st.color,
    taskLabel: '任务',
    task: oneLine(String(task ?? ''), 600),
    timelineLabel: '执行过程（最近几行）',
    lines,
    footer: `工作目录 ${workspace || '（默认）'}　·　DSH 会话 ${sessionId || '新建（这一轮是第一句）'}　·　由 dsh-bridge 生成`
  };
}

/** 真渲染一张会话快照图，返回 { ok, path, width, height, bytes, source }。 */
async function renderSessionCard({ storeDir, model, log, warn }) {
  const shotsDir = path.join(storeDir, 'shots');
  try {
    mkdirSync(shotsDir, { recursive: true });
  } catch (error) {
    return { ok: false, message: `无法创建图片目录：${error.message}` };
  }
  const scriptPath = path.join(storeDir, 'card.ps1');
  const modelPath = path.join(storeDir, 'card-model.json');
  try {
    if (readPsScript(scriptPath) !== SESSION_CARD_SCRIPT) writePsScript(scriptPath, SESSION_CARD_SCRIPT);
    writeFileSync(modelPath, JSON.stringify(model), 'utf8');
  } catch (error) {
    return { ok: false, message: `无法写入快照脚本：${error.message}` };
  }

  const outPath = path.join(shotsDir, `card-${stamp()}.png`);
  const res = await runProcess({
    command: resolvePowerShell(),
    args: [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath, '-Model', modelPath, '-Out', outPath
    ],
    timeoutMs: 30000
  });
  if (!res.ok || !existsSync(outPath)) {
    warn?.(`会话快照没画出来：${res.message || res.stderr || res.code || '未知原因'}`);
    return { ok: false, message: res.message || res.stderr || res.code || '没有生成图片' };
  }
  let bytes = 0;
  try { bytes = statSync(outPath).size; } catch { /* 拿不到大小不影响 */ }
  if (!bytes) return { ok: false, message: '快照是空文件' };
  pruneShots(shotsDir, 30);
  const meta = /OK\s+(\d+)x(\d+)/.exec(String(res.stdout || ''));
  const width = meta ? Number(meta[1]) : 0;
  const height = meta ? Number(meta[2]) : 0;
  log?.(`已生成会话快照 ${width}x${height} ${outPath}（${humanBytes(bytes)}）`);
  return { ok: true, path: outPath, bytes, source: '会话快照', width, height };
}

// ── 真正跑一次 DSH ─────────────────────────────────────────────────────────

function runOnce({ exe, profile, prompt, sessionId, cwd, timeoutMs, log, onEvent }) {
  return new Promise((resolve) => {
    const args = [...exe.args, '--profile', profile, '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    args.push(prompt);

    let child;
    try {
      child = spawn(exe.command, args, {
        cwd,
        windowsHide: true,
        // 只有退回 dsh.cmd 时才需要 shell（Windows 上 .cmd 不能直接 spawn）
        shell: !!exe.shell,
        env: {
          ...process.env,
          // DSH 的启动器靠它用「DeepSeek Harness.exe」跑 Node 代码
          ELECTRON_RUN_AS_NODE: '1',
          // 群里的中文提示词在 Windows 控制台默认代码页下会乱码，强制 UTF-8
          PYTHONIOENCODING: 'utf-8'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      resolve({ ok: false, code: 'SPAWN_THREW', message: `启动 DSH 失败：${error.message}`, stderr: '' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let pending = '';
    let finished = false;
    const started = Date.now();
    // 把子进程挂到「正在跑的任务」上，主人的「停」才能按到它
    if (activeRun) activeRun.child = child;
    const releaseChild = () => {
      if (activeRun && activeRun.child === child) activeRun.child = null;
    };

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      releaseChild();
      try { child.kill(); } catch { /* 进程可能已退出 */ }
      resolve({
        ok: false,
        code: 'TIMEOUT',
        message: `DSH 超过 ${Math.round(timeoutMs / 1000)} 秒还没干完，已中止。可以在本技能的设置里调大「单次最长等待」。`,
        stderr: tail(stderr, 1500),
        durationMs: Date.now() - started
      });
    }, timeoutMs);

    /** 把已经收到的完整行喂给进度回调（回调自己吞错，绝不影响任务）。 */
    function feedEvents(text) {
      if (typeof onEvent !== 'function') return;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        let ev = null;
        try { ev = JSON.parse(t); } catch { continue; }
        try { onEvent(ev); } catch { /* 进度汇报不许拖垮任务 */ }
      }
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      // 防御：极端情况下事件流失控，别把内存吃了
      if (stdout.length > 4_000_000) stdout = stdout.slice(-2_000_000);
      feedEvents(text);
    });
    child.stderr.on('data', (chunk) => {
      stderr = tail(stderr + chunk.toString('utf8'), 16000);
      const line = chunk.toString('utf8').trim();
      if (line) log(`DSH: ${line.slice(0, 300)}`);
    });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      releaseChild();
      resolve({ ok: false, code: 'SPAWN_ERROR', message: `无法启动 DSH：${error.message}`, stderr: '' });
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // 主人喊停 → 进程是被我们自己 taskkill 掉的，不能当成「DSH 挂了」
      const stopped = Boolean(activeRun && activeRun.child === child && activeRun.cancelled);
      releaseChild();
      if (stopped) {
        resolve({
          ok: false,
          code: 'STOPPED',
          message: '主人喊停了，这一轮已经中止（它干到一半的东西不会继续）。',
          sessionId,
          durationMs: Date.now() - started
        });
        return;
      }

      const events = [];
      for (const line of stdout.split(/\r?\n/)) {
        const t = line.trim();
        if (!t.startsWith('{')) continue;
        try { events.push(JSON.parse(t)); } catch { /* 不是事件行，跳过 */ }
      }
      const first = events.find((e) => e.type === 'session');
      const finalEvent = events.filter((e) => e.type === 'final').pop();
      const textEvent = events.filter((e) => e.type === 'text' && typeof e.text === 'string').pop();
      const endStatus = events.filter((e) => e.type === 'status' && e.phase === 'turn_end').pop();
      const answer = String(finalEvent?.text ?? textEvent?.text ?? '').trim();
      const newSessionId = String(first?.sessionId ?? sessionId ?? '');
      const reason = endStatus?.reason?.kind || (code === 0 ? 'completed' : 'exit-' + String(code));
      const usage = events.filter((e) => e.usage).map((e) => e.usage).pop() || null;
      const stderrText = stderr.trim();
      const toolCalls = events.filter((e) => e.type === 'tool_call').length;
      // 失败的工具调用原文（沙箱起不来这类问题时，真正的错误只在工具结果里）
      const failedResults = events.filter((e) => {
        if (e.type !== 'tool_result') return false;
        const s = String(e.status ?? '').toLowerCase();
        return !['completed', 'success', 'ok', 'succeeded'].includes(s);
      });
      const toolErrorText = tail(
        failedResults.map((e) => stripControl(String(e.result ?? e.output ?? e.error ?? ''))).join('\n'),
        1500
      );

      if (code === 0 && answer) {
        resolve({
          ok: true,
          text: answer,
          sessionId: newSessionId,
          usage,
          toolCalls,
          toolErrors: failedResults.length,
          toolErrorText,
          durationMs: Date.now() - started
        });
        return;
      }

      const detail = (endStatus?.reason?.error?.message) || stderrText || (answer || '(空回答)');
      resolve({
        ok: false,
        code: code === 0 ? 'EMPTY_ANSWER' : 'EXIT_' + String(code),
        message: code === 0
          ? `DSH 这一轮没给出回答（结束原因：${reason}）。`
          : `DSH 退出码 ${code}（结束原因：${reason}）：${stripControl(detail).slice(0, 600)}`,
        sessionId: newSessionId,
        stderr: tail(stderrText, 1500),
        toolCalls,
        durationMs: Date.now() - started
      });
    });
  });
}

// ── 技能主体 ───────────────────────────────────────────────────────────────

export function setup(api) {
  const boundLog = (...args) => {
    const text = format(...args);
    try {
      if (typeof api?.log === 'function') api.log('%s', text);
      else console.log(text);
    } catch {
      /* 日志失败不影响主流程 */
    }
  };
  const boundWarn = (...args) => {
    const text = format(...args);
    try {
      if (typeof api?.warn === 'function') api.warn('%s', text);
      else console.warn(text);
    } catch {
      /* 同上 */
    }
  };

  let store = null;
  const getConfig = () => normalizeConfig(typeof api?.config === 'function' ? api.config() : null);

  // QQ Agent 的数据目录：优先问宿主，其次环境变量，最后按技能位置推。
  // 会话记忆、运行日志、截图、默认工作目录都放这里（不写进程序目录，升级不会被覆盖）。
  const appInfo = api?.app || api?.host || api?.env || null;
  const dataDir = pickDataDir(
    appInfo?.dataDir
    || appInfo?.paths?.data
    || process.env.QQ_AGENT_DATA_DIR
    || ''
  );
  const defaultWorkspace = path.join(dataDir, 'dsh-bridge-workspace');

  const getStore = () => {
    if (!store) store = createStore(dataDir, boundWarn);
    return store;
  };
  // 模块级 hooks 拿不到 api，这里把「读配置」「拿存储」的办法交出去
  hookRuntime = { getConfig, getStore };
  getStore(); // 启动即建目录，排障时能直接看到位置

  const getWorkspace = () => {
    const cfg = getConfig();
    return cfg.workspaceDir || defaultWorkspace;
  };
  const getExe = () => resolveDshExe(getConfig().dshDir);

  // 让「机器人当前所在的群」有机会被带上：工具参数里的 chatKey 由模型填，
  // 缺失时依次回退到运行期上下文里的 chatKey / 会话 id。
  function pickChatKey(ctx, args) {
    const candidate = args?.chatKey || ctx?.chatKey || ctx?.session?.chatKey || '';
    return candidate ? String(candidate) : 'global';
  }

  /** 工具上下文里的 sender 才是真发送通道（和内置工具走同一条队列/限频/存档）。 */
  function pushSent(ctx, entry) {
    try {
      ctx?.session?.sent?.push(entry);
      ctx?.emit?.('session-update', ctx?.session?.id);
    } catch { /* 记账失败不影响发送 */ }
  }

  async function sendTextToChat(ctx, chatKey, text) {
    const result = await ctx.sender.sendTextBatch(chatKey, [text], {});
    const first = result?.sent?.[0];
    pushSent(ctx, { type: 'text', text, at: first?.at || clock() });
    return first || null;
  }

  async function sendImageToChat(ctx, chatKey, file, note) {
    const result = await ctx.sender.sendImage(chatKey, { file }, { note });
    pushSent(ctx, { type: 'image', text: `[图片${note ? `:${String(note).slice(0, 40)}` : ''}]`, at: clock() });
    return result;
  }

  /**
   * 干活期间的「直播」：进度文字 + 屏幕照片。
   *
   * 三条硬约束（都是踩过的坑）：
   *   · 不能刷屏：进度消息按间隔节流、且有总条数上限；
   *   · 不能拖慢任务：所有发送都是 fire-and-forget，失败只记日志；
   *   · 不能泄密：屏幕照片只发给「主人本人触发」的任务（群友派活、或
   *     allowFromAnyone 打开时的群友派活，都不拍）。
   */
  function startLive({ ctx, chatKey, cfg, task, isOwner, log, warn }) {
    const canSend = !!ctx?.sender && typeof ctx.sender.sendTextBatch === 'function' && typeof ctx.sender.sendImage === 'function';
    const state = {
      started: Date.now(),
      closed: false,
      step: 0,
      textsSent: 0,
      shotsSent: 0,
      optionsSent: 0,
      lastTextAt: 0,
      lastText: '',
      busy: false,
      errors: 0,
      firstTimer: null,
      shotTimer: null,
      beatTimer: null,
      stopTimer: null,
      // 执行过程（画会话快照图用）：最近 200 条
      transcript: []
    };

    /** 记一行执行过程（画快照图的数据源，发送失败了也不影响它）。 */
    function pushTranscript(kind, text) {
      const clean = oneLine(String(text ?? ''), 400);
      if (!clean) return;
      state.transcript.push({ kind, text: clean });
      if (state.transcript.length > 200) state.transcript.splice(0, state.transcript.length - 200);
    }

    async function rawText(text, { force = false, kind = 'progress' } = {}) {
      if (state.closed || !canSend) return false;
      if (kind === 'progress') {
        if (!cfg.liveProgress || cfg.progressMax <= 0) return false;
        if (state.textsSent >= cfg.progressMax) return false;
        const elapsed = Date.now() - state.started;
        // 短任务别出声：第一句进度至少要跑到 5 秒才发
        if (!force && state.textsSent === 0 && elapsed < Math.min(5000, cfg.progressIntervalMs)) return false;
        if (!force && state.textsSent > 0 && Date.now() - state.lastTextAt < cfg.progressIntervalMs) return false;
      }
      const clean = oneLine(text, 200);
      if (!clean || clean === state.lastText) return false;
      state.lastText = clean;
      state.lastTextAt = Date.now();
      if (kind === 'progress') state.textsSent += 1;
      try {
        await sendTextToChat(ctx, chatKey, clean);
        if (kind === 'progress') stats.progressSent += 1;
        return true;
      } catch (error) {
        state.errors += 1;
        warn?.(`直播消息发送失败（${error.message}）`);
        return false;
      }
    }

    const wantsShots = () => cfg.screenShots && cfg.shotMax > 0;

    /**
     * 拍一张发出去。
     *   shotStyle='session'（默认）：画一张「这次任务的会话快照图」—— 内容一定对得上主人问的事。
     *   shotStyle='desktop'       ：真去截屏（看电脑实际在干什么）。
     * 两者都要主人本人派活才发（见上面「不能泄密」）。
     */
    async function shot(reason, { force = false } = {}) {
      if (state.closed || !canSend) return null;
      if (!wantsShots()) return null;
      // 两种图都只发给主人本人派活的任务（群友派活不拍，见上面「不能泄密」）
      if (!isOwner && !force) return null;
      if (state.shotsSent >= cfg.shotMax) return null;
      state.shotsSent += 1;

      let cap = null;
      if (cfg.shotStyle === 'session') {
        const model = buildCardModel({
          task,
          startedAt: state.started,
          step: state.step,
          transcript: state.transcript,
          workspace: state.workspace || '',
          sessionId: state.sessionId || '',
          status: 'running',
          maxLines: cfg.cardLines
        });
        cap = await renderSessionCard({ storeDir: getStore().dir, model, log, warn });
      } else {
        cap = await captureScreen({ storeDir: getStore().dir, maxWidth: cfg.shotMaxWidth, log, warn });
      }
      if (!cap.ok) {
        state.errors += 1;
        warn?.(`${cfg.shotStyle === 'session' ? '会话快照' : '屏幕照片'}没成：${cap.message}`);
        return null;
      }
      if (state.closed) return null;
      const note = cfg.shotStyle === 'session'
        ? (reason || '会话快照')
        : (reason || '屏幕照');
      try {
        await sendImageToChat(ctx, chatKey, cap.path, note);
        stats.shotsSent += 1;
        return cap;
      } catch (error) {
        state.errors += 1;
        warn?.(`图片发送失败（${error.message}）`);
        return null;
      }
    }

    async function sendOptions(question, options) {
      if (!canSend || !Array.isArray(options) || !options.length) return false;
      const head = question ? `【DSH 问你】${oneLine(question, 80)}\n` : '【DSH 问你】\n';
      const body = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
      const text = `${head}${body}\n\n回复数字即可（比如「2」），我接着让它做。`;
      try {
        await sendTextToChat(ctx, chatKey, text);
        state.optionsSent += 1;
        stats.optionsSent += 1;
        return true;
      } catch (error) {
        warn?.(`选项消息发送失败（${error.message}）`);
        return false;
      }
    }

    function onEvent(ev) {
      if (state.closed) return;
      const type = String(ev?.type || '');
      if (type === 'tool_call') {
        state.step += 1;
        const what = describeToolCall(ev.tool, ev.input);
        pushTranscript('command', `第 ${state.step} 步：${what}`);
        rawText(`🔧 ${what}（第 ${state.step} 步）`);
        return;
      }
      if (type === 'tool_result') {
        const status = String(ev?.status || '').toLowerCase();
        const okStatus = !status || ['completed', 'success', 'ok', 'succeeded'].includes(status);
        const body = oneLine(String(ev?.result ?? ev?.output ?? ev?.error ?? ''), 280);
        if (okStatus) {
          pushTranscript('result', body ? `这一步的产物：${body}` : '这一步做完了');
        } else {
          pushTranscript('failure', `第 ${state.step} 步没成功（${status}）${body ? '：' + body : ''}`);
          rawText(`⚠️ 第 ${state.step} 步没成功（${status}），它正在换个办法`);
        }
        return;
      }
      if (type === 'thinking' && ev?.text) pushTranscript('thinking', String(ev.text));
    }

    if (canSend) {
      // 第一句话：短任务别出声（跑完就直接给答案，多一句是噪音），
      // 跑过 5 秒还没完就报个到，让人知道它在干什么。
      state.firstTimer = setTimeout(() => {
        if (state.closed || state.textsSent > 0 || !cfg.liveProgress || cfg.progressMax <= 0) return;
        const head = `DSH 开始干活了：${oneLine(task, 40)}`;
        rawText(`🧠 ${head}`, { force: true, kind: 'progress' });
      }, Math.min(5000, Math.max(1000, cfg.progressIntervalMs)));
      state.firstTimer.unref?.();
      // 心跳：长时间没动静（比如在跑一条很慢的命令）时冒个泡，别让人以为卡死了
      state.beatTimer = setInterval(() => {
        if (state.closed || !cfg.liveProgress) return;
        const silent = Date.now() - (state.lastTextAt || state.started);
        if (silent < cfg.progressIntervalMs * 2) return;
        const sec = Math.round((Date.now() - state.started) / 1000);
        rawText(`⏳ DSH 还在干（第 ${state.step || 1} 步，已 ${sec} 秒）`, { kind: 'progress' });
      }, Math.max(3000, cfg.progressIntervalMs));
      state.beatTimer.unref?.();
      state.transcript.push({ kind: 'info', text: `任务：${oneLine(task, 200)}` });
    }

    // 「停」：任务跑着的时候主人随时能喊停。不能指望模型 —— 工具调用进行中 QQ Agent
    // 不会再开新一轮对话（钩子也来不及），所以这里自己盯着聊天记录、直接杀子进程。
    /** 看的必须是宿主的聊天记录（ctx.store），不是技能自己那个数据目录。 */
    function recentChatEntries() {
      const store = ctx?.store;
      if (!store) return [];
      try {
        if (typeof store.recent === 'function') return store.recent(chatKey, { limit: 12 }) || [];
        if (typeof store.peekUnread === 'function') return store.peekUnread(chatKey, 12) || [];
      } catch { /* 读不到就当没有新消息 */ }
      return [];
    }

    if (canSend && isOwner) {
      const owners = parseIdList(cfg.ownerIds);
      let lastSeenId = 0;
      try {
        for (const e of recentChatEntries()) {
          lastSeenId = Math.max(lastSeenId, Number(e?.id) || 0);
        }
      } catch { /* 读不到就从 0 开始，最多多认一条老消息 */ }
      state.stopTimer = setInterval(() => {
        if (state.closed) return;
        let entries = [];
        try { entries = recentChatEntries(); } catch { return; }
        for (const e of entries) {
          if (!e || e.self) continue;
          const id = Number(e.id) || 0;
          if (id <= lastSeenId) continue;
          lastSeenId = Math.max(lastSeenId, id);
          if (!owners.includes(String(e.senderId || ''))) continue;
          if (!isStopCommand(e.text)) continue;
          if (!activeRun || activeRun.cancelled) continue;
          log(`主人说「${oneLine(String(e.text), 20)}」，正在中止这一轮 DSH。`);
          cancelActiveRun();
          pushTranscript('info', '主人喊停了，这一轮中止。');
          rawText('🛑 好，停下来了。', { force: true, kind: 'note' });
        }
      }, 2000);
      state.stopTimer.unref?.();
    }

    return {
      state,
      onEvent,
      sendOptions,
      /** 发一条「不是进度」的通知（不受进度条数/间隔限制，但同样不刷屏）。 */
      async say(text) {
        return rawText(text, { force: true, kind: 'note' });
      },
      async startAutoShots() {
        if (!canSend || !isOwner || !cfg.screenShots || cfg.shotMax <= 0) return;
        state.shotTimer = setInterval(() => {
          if (state.closed) return;
          if (state.shotsSent >= cfg.shotMax) {
            clearInterval(state.shotTimer);
            state.shotTimer = null;
            return;
          }
          const sec = Math.round((Date.now() - state.started) / 1000);
          shot(`自动 · 已 ${sec}s`).catch(() => {});
        }, cfg.shotIntervalMs);
        state.shotTimer.unref?.();
      },
      close() {
        state.closed = true;
        if (state.firstTimer) { clearTimeout(state.firstTimer); state.firstTimer = null; }
        if (state.shotTimer) { clearInterval(state.shotTimer); state.shotTimer = null; }
        if (state.beatTimer) { clearInterval(state.beatTimer); state.beatTimer = null; }
        if (state.stopTimer) { clearInterval(state.stopTimer); state.stopTimer = null; }
        // 留一份快照数据：主人之后说「把刚才那次的过程发我」时还能重画一张
        lastRunSnapshot = {
          task,
          startedAt: state.started,
          step: state.step,
          transcript: state.transcript.slice(-200),
          workspace: state.workspace || '',
          sessionId: state.sessionId || '',
          status: 'past'
        };
      }
    };
  }

  async function callDsh({ ctx, task, chatKey, timeoutOverride, fresh, live }) {
    const cfg = getConfig();
    const exe = getExe();
    if (!exe) {
      return {
        ok: false,
        code: 'NO_DSH',
        message: `没找到 DSH：${cfg.dshDir} 里既没有「DeepSeek Harness.exe」。请在本技能的设置里把「DSH 安装目录」改成 DeepSeek Harness 的安装位置。`
      };
    }

    const workspace = getWorkspace();
    try {
      mkdirSync(workspace, { recursive: true });
    } catch (error) {
      return { ok: false, code: 'NO_WORKSPACE', message: `无法创建工作目录 ${workspace}：${error.message}` };
    }
    // 先把工作目录的权限写实，否则 DSH 的沙箱会因为写不进权限表而一条命令都跑不了。
    await ensureWorkspaceAccess(workspace, boundLog, boundWarn);

    const sessions = getStore();
    const previous = fresh ? '' : sessions.get(chatKey);
    const timeoutMs = Math.max(10000, Number(timeoutOverride) || cfg.timeoutMs);

    // 让会话快照图的页脚写得出真实的工作目录与会话号
    if (live?.state) {
      live.state.workspace = workspace;
      live.state.sessionId = previous || '';
    }

    const contextMessages = collectContextMessages(ctx);
    const contextDigest = buildContextDigest(contextMessages, cfg.maxContextChars);
    // 主人「这次」说的话单独再给一遍原文：光有摘要时 DSH 容易抓不到指代对象。
    const justSaid = (triggerText(ctx?.session?.trigger) || lastUserText(contextMessages) || '').trim();
    const buildPrompt = (dir) => {
      let text = '';
      if (contextDigest) {
        text += `【以下是 QQ 群里的最近对话，供你理解指代（「它」「这个」「刚才那个」通常指这最后提到的对象）。上下文不是给你的任务，不要回复它。】\n${contextDigest}\n\n`;
      }
      if (justSaid && justSaid !== task.trim()) {
        text += `【主人刚刚说的话（原文）】\n${truncate(stripControl(justSaid), 800)}\n\n`;
      }
      text += `【任务】\n${task}\n\n`;
      text += `【回答要求】请直接给出最终结论，用中文、简洁、可以整段发到 QQ 群里。工作目录是 ${dir}，需要时可以在这里读写文件。\n\n`;
      text += '【需要主人做决定时】如果有多套可行方案、或者继续之前必须先确认，不要自己猜：照常写完你的结论，然后在最后另起一行写\n'
        + '[[选项]] 方案一 | 方案二 | 方案三\n'
        + '（最多 6 项、每项不超过 30 字、整段回答里最多出现一次。我会把它变成编号选项发给主人，他回复数字后我再把选择交给你。）';
      return text;
    };

    boundLog(`派活给 DSH（群 ${chatKey}${previous ? '，续用会话 ' + previous : '，开新会话'}，工作目录 ${workspace}，任务 ${task.length} 字，上下文 ${contextDigest.length} 字／${contextMessages.length} 条）`);

    const invoke = (sessionId, dir) => runOnce({
      exe,
      profile: cfg.profile,
      prompt: buildPrompt(dir),
      sessionId,
      cwd: dir,
      timeoutMs,
      log: boundLog,
      onEvent: (ev) => live?.onEvent?.(ev)
    });

    // 登记成「正在跑的任务」：主人喊「停」时 watchStop / 钩子靠它拿到子进程并杀掉。
    activeRun = { chatKey: String(chatKey), task: String(task), startedAt: Date.now(), child: null, cancelled: false };
    let result = await invoke(previous || '', workspace);
    let rebuiltSession = false;
    let usedWorkspace = workspace;

    // 中途被喊停：别再做自愈重试了，直接把「已停」还给模型。
    if (activeRun && activeRun.cancelled) {
      result = { ok: false, code: 'STOPPED', message: '主人喊停了，这一轮已经中止。', durationMs: result.durationMs || 0 };
    }

    // 自愈一：记忆里的会话可能已经不存在（DSH 的会话目录被清理、换过 DSH_HOME
    // 等）。这时 DSH 会直接报错退出；不能让这个群从此永远失败，所以丢掉旧
    // 会话、原样重试一次，并把新会话记下来。
    if (!result.ok && previous && isStaleSession(result)) {
      boundWarn(`记忆里的 DSH 会话 ${previous} 已经不在了，自动开一段新会话重试。`);
      result = await invoke('', workspace);
      rebuiltSession = true;
    }

    // 自愈二：DSH 的沙箱起不来（工作目录的权限表写不进去）时，换到主人主目录下
    // 的工作目录重跑一次 —— 那里的权限一定是够的。注意这种情况 DSH 可能是「成功
    // 退出但一件活没干成」，所以这里不能加 !result.ok。换目录等于换会话，开新会话。
    if (isSandboxAclFailure(result) && usedWorkspace !== FALLBACK_WORKSPACE) {
      boundWarn(`DSH 的沙箱被工作目录 ${usedWorkspace} 的权限挡住了，自动换到 ${FALLBACK_WORKSPACE} 重跑一次。`);
      await ensureWorkspaceAccess(FALLBACK_WORKSPACE, boundLog, boundWarn);
      usedWorkspace = FALLBACK_WORKSPACE;
      stats.workspaceFallbacks += 1;
      if (live?.state) live.state.workspace = usedWorkspace;
      result = await invoke('', FALLBACK_WORKSPACE);
      rebuiltSession = true;
    }
    const workspaceNote = usedWorkspace === workspace
      ? ''
      : `它的工作目录被系统权限挡住了，已经自动换到 ${usedWorkspace} 重跑；如果愿意，可以在技能设置里把「工作目录」直接改成它。`;

    stats.runs += 1;
    stats.lastDurationMs = Number(result.durationMs) || 0;
    stats.lastFinishedAt = Date.now();
    if (result.ok) {
      sessions.set(chatKey, result.sessionId, {
        workspace: usedWorkspace,
        ...(rebuiltSession
          ? { note: workspaceNote ? '换过工作目录，这里是重新建立的会话' : '旧会话已失效，这里是重新建立的会话' }
          : {})
      });
    } else if (result.sessionId && result.code !== 'TIMEOUT') {
      sessions.set(chatKey, result.sessionId, { workspace: usedWorkspace });
    }
    result.workspace = usedWorkspace;
    stats.lastWorkspace = usedWorkspace;
    if (workspaceNote) {
      result.workspaceNote = workspaceNote;
      // 主人得知道「换地方了」，否则他会去原来的目录里找文件。
      await (live?.say?.(`⚠️ ${workspaceNote}`) ?? Promise.resolve(false));
    }

    // 选项协议：把 [[选项]] 那一行抠出来，变成编号选项发到群里，并记下待选。
    let optionsSent = false;
    let options = [];
    if (result.ok) {
      const parsed = splitOptions(result.text);
      result.text = parsed.text || result.text;
      options = parsed.options;
      if (options.length) {
        const question = String(result.text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '';
        optionsSent = await (live?.sendOptions?.(question, options) ?? Promise.resolve(false));
        if (optionsSent) {
          sessions.setPending(chatKey, {
            options,
            question: oneLine(question, 120),
            sessionId: result.sessionId || '',
            at: Date.now()
          });
        }
      }
    }

    sessions.logRun({
      at: new Date().toISOString(),
      chatKey,
      ok: !!result.ok,
      code: result.code || 'OK',
      durationMs: result.durationMs || 0,
      sessionId: result.sessionId || '',
      promptChars: task.length,
      contextChars: contextDigest.length,
      contextMsgs: contextMessages.length,
      answerChars: result.ok ? result.text.length : 0,
      toolCalls: Number(result.toolCalls) || 0,
      options: options.length,
      live: live ? { progress: live.state.textsSent, shots: live.state.shotsSent } : null,
      usage: result.usage || null
    });

    result.options = options;
    result.optionsSent = optionsSent;

    // 收尾再画一张「这一轮的结局」快照：只有之前真的发过图（说明任务够长、
    // 主人已经在看直播）时才补，短任务不打扰。这版图里带上最终答复。
    if (live && cfg.shotStyle === 'session' && cfg.screenShots
      && live.state.shotsSent > 0 && live.state.shotsSent < cfg.shotMax && !live.state.closed) {
      const cardStatus = result.code === 'STOPPED' ? 'stopped' : (result.ok ? 'ok' : 'fail');
      const model = buildCardModel({
        task,
        startedAt: live.state.started,
        step: live.state.step,
        transcript: live.state.transcript,
        workspace: usedWorkspace,
        sessionId: result.sessionId || live.state.sessionId || '',
        answer: result.ok ? result.text : '',
        status: cardStatus,
        maxLines: cfg.cardLines
      });
      const cap = await renderSessionCard({ storeDir: sessions.dir, model, log: boundLog, warn: boundWarn });
      if (cap.ok) {
        try {
          await sendImageToChat(ctx, chatKey, cap.path, cardStatus === 'ok'
            ? '这一轮的会话快照（含最终答复）'
            : (cardStatus === 'stopped' ? '已停止的会话快照' : '这一轮出错的会话快照'));
          live.state.shotsSent += 1;
          stats.shotsSent += 1;
        } catch (error) {
          boundWarn(`收尾快照发送失败（${error.message}）`);
        }
      }
    }

    activeRun = null;
    return result;
  }

  // ── 工具 1：把活派给 DSH ─────────────────────────────────────────────────
  const toolId = api.registerTool({
    id: 'dsh_agent',
    name: 'dsh_agent',
    description: [
      '把需要深度思考、写代码、改文件、查本机文件或目录、多步排查的任务派给本机的 DSH（DeepSeek Harness）智能体，',
      '返回它的最终回答。DSH 会真的在这台电脑上动手执行，因此任务要写清楚、可独立完成。',
      '它在干活的过程中会自己往群里发进度（第几步、在跑什么命令），需要主人拍板时会发编号选项 —— 这些你不用管。',
      '适合：「问 DSH」「让 DSH 看看/算一下/写个脚本」「看一下某个目录/文件」「深度分析」。',
      '不适合：闲聊、情绪陪伴、一句话能答完的常识问题。同一段对话（不传 chatKey 时按当前会话）会被沿用，',
      '所以可以让它接着上文继续做。注意：只有主人（管理员本人）能用它碰本机文件，其他人调用会被拒绝。'
    ].join(''),
    category: 'system',
    icon: '🧠',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: '要交给 DSH 的完整任务描述。一次只交一件事，写清楚目标、约束、期望的输出形式。'
        },
        chatKey: {
          type: 'string',
          description: '可选。要延续哪段 DSH 对话（一般填当前群的 chatKey）。留空 = 用当前群。'
        },
        fresh: {
          type: 'boolean',
          description: '可选。true = 这次不要延续旧对话，重新开一段（换话题、上次答案跑偏时用）。'
        },
        timeoutMs: {
          type: 'number',
          description: '可选。本次任务最长等待毫秒数，默认取本技能设置（一般 180000）。'
        }
      },
      required: ['task']
    },
    async execute(ctx, args = {}) {
      const task = String(args.task ?? '').trim();
      if (!task) {
        return { content: '任务内容是空的：需要在 task 参数里写清楚要 DSH 做什么。', isError: true };
      }
      if (task.length > 20000) {
        return { content: `任务太长（${task.length} 字）。请拆成几件小事分别交给 DSH。`, isError: true };
      }

      const cfg = getConfig();
      const chatKey = pickChatKey(ctx, args);
      // 屏幕照片只跟主人走：群友派活（allowFromAnyone）时绝不拍屏幕
      const owner = ownerState({
        triggerEntries: ctx?.session?.trigger,
        chatKey,
        kind: ctx?.kind
      }, cfg);

      const live = startLive({
        ctx, chatKey, cfg, task,
        isOwner: owner.isOwner,
        log: boundLog,
        warn: boundWarn
      });
      live.startAutoShots();

      let result;
      try {
        result = await enqueue(() => callDsh({
          ctx: { ...(ctx || {}), chatKey },
          task,
          chatKey,
          timeoutOverride: args.timeoutMs,
          fresh: args.fresh === true,
          live
        }));
      } finally {
        live.close();
      }

      if (!result.ok) {
        if (result.code === 'STOPPED') {
          stats.stopped += 1;
          return {
            content: '主人喊停了，这一轮已经中止（它干到一半的东西不会继续）。用一句话告诉他停了就行，不要再说别的。',
            isError: true
          };
        }
        stats.failures += 1;
        if (result.code === 'TIMEOUT') stats.timeouts += 1;
        stats.lastError = result.message || result.code;
        boundWarn(`DSH 任务失败（${result.code}）：${result.message}`);
        const extra = live.state.textsSent || live.state.shotsSent
          ? '（刚才群里的那些进度就是它干到哪儿了。）'
          : '';
        return {
          content: `DSH 这次没干成：${result.message}${extra}（若需要，可以把这条错误原样发给群主排查。）`,
          isError: true
        };
      }

      let text = stripControl(result.text);
      if (cfg.replyPrefix) text = `${cfg.replyPrefix}${text}`;
      text = truncate(text, cfg.maxReplyChars);
      if (result.optionsSent) {
        text += '\n\n（说明：需要主人拍板的那几项，我已经用编号选项直接发到群里了 —— 你不用再列一遍，'
          + '简短说一句让他挑一个就行；他回复数字后，选择会自动交回刚才那段对话继续做。）';
      }
      return { content: text, isError: false };
    }
  });

  // ── 工具 2：拍一张电脑屏幕的照片发到会话 ─────────────────────────────────
  const screenToolId = api.registerTool({
    id: 'screen_shot',
    name: 'screen_shot',
    description: [
      '拍一张照片发到当前会话里：默认拍这台电脑「此刻的真实屏幕」，也可以画一张「这次 DSH 任务」的过程快照图。',
      '默认（target="desktop"）是真实截屏：只拍 DSH 自己的窗口（被别的程序挡住也能拍到，画面里一定是 DSH），',
      '传 source="fullscreen" 连桌面上的其它程序一起拍。',
      '要「刚才那件事 DSH 干到哪儿了 / 把过程发我看看」时传 target="session"：会按执行过程画一张会话快照图',
      '（无头 DSH 没有窗口，所以那种图是画出来的，保证内容就是这次任务本身）。',
      '适合：主人说「看看我电脑现在什么情况」「屏幕上是什么」「截个图给我」「刚才那个跑到哪了」。',
      '只有主人（管理员本人）能用。拍完照片会直接发出去，你只需要用一句话说明拍了什么。'
    ].join(''),
    category: 'system',
    icon: '📷',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: '可选。照片的备注，会显示成图片说明，比如「测试跑完后的画面」。'
        },
        maxWidth: {
          type: 'number',
          description: '可选。照片最大宽度像素（默认取技能设置，一般 1600；越小发得越快）。'
        },
        source: {
          type: 'string',
          enum: ['dsh', 'fullscreen'],
          description: '可选。target="desktop" 时拍什么：dsh（默认，只拍 DSH 窗口）或 fullscreen（整个桌面）。'
        },
        target: {
          type: 'string',
          enum: ['desktop', 'session'],
          description: '可选。desktop（默认）= 真截屏看电脑现在的画面；session = 画一张「上一轮/这一轮 DSH 任务」的过程快照图。'
        }
      },
      required: []
    },
    async execute(ctx, args = {}) {
      const cfg = getConfig();
      const chatKey = pickChatKey(ctx, args);
      const owner = ownerState({
        triggerEntries: ctx?.session?.trigger,
        chatKey,
        kind: ctx?.kind
      }, cfg);
      if (!owner.isOwner) {
        return {
          content: '只有管理员本人（主人）能让我拍这台电脑的屏幕。',
          isError: true
        };
      }
      const target = args.target === 'session' ? 'session' : 'desktop';
      let cap = null;
      if (target === 'session') {
        const snap = lastRunSnapshot;
        const model = buildCardModel(snap
          ? { ...snap, maxLines: cfg.cardLines }
          : {
            task: '（手动拍的会话快照，但还没有跑过任务）',
            startedAt: Date.now(),
            step: 0,
            transcript: [],
            status: 'idle',
            maxLines: cfg.cardLines
          });
        cap = await renderSessionCard({ storeDir: getStore().dir, model, log: boundLog, warn: boundWarn });
      } else {
        cap = await captureScreen({
          storeDir: getStore().dir,
          maxWidth: clamp(args.maxWidth ?? cfg.shotMaxWidth, 320, 4096),
          source: args.source === 'fullscreen' ? 'fullscreen' : 'dsh',
          log: boundLog,
          warn: boundWarn
        });
      }
      if (!cap.ok) {
        stats.lastError = `拍照失败：${cap.message}`;
        return { content: `拍照失败：${cap.message}`, isError: true };
      }
      const fallbackNote = target === 'session' ? '这次任务的过程快照' : '当前屏幕';
      try {
        await sendImageToChat(ctx, chatKey, cap.path, args.note ? String(args.note) : fallbackNote);
        stats.shotsSent += 1;
      } catch (error) {
        return { content: `照片拍好了但没发出去：${error.message}`, isError: true };
      }
      return {
        content: `已经把${cap.source || '当前屏幕'}的照片发到会话里了（${humanBytes(cap.bytes)}，文件：${cap.path}）。用一句话告诉主人你拍了什么就行。`,
        isError: false
      };
    }
  });

  boundLog(`已加载：工具 ${toolId}、${screenToolId}（DSH 目录 ${getConfig().dshDir}，会话记忆 ${getStore().sessionsPath}，工作目录 ${getWorkspace()}）`);
  // 提前把工作目录的权限写实（不然第一次派活时 DSH 的沙箱会起不来）。不等结果。
  ensureWorkspaceAccess(getWorkspace(), boundLog, boundWarn);

  return {
    toolId,
    screenToolId,
    /**
     * 供控制台/其它模块查询的运行期状态。
     * 另外：设置里填了「直达关键词」时，可以在别处调用 matchesKeyword() 判断。
     */
    async state() {
      const cfg = getConfig();
      return {
        toolId,
        screenToolId,
        dshDir: cfg.dshDir,
        profile: cfg.profile,
        workspace: getWorkspace(),
        workspaceFallback: FALLBACK_WORKSPACE,
        lastWorkspace: stats.lastWorkspace || '',
        sessionsPath: getStore().sessionsPath,
        runsLogPath: getStore().logPath,
        pendingPath: getStore().pendingPath,
        shotsDir: getStore().shotsDir,
        pendingOptions: getStore().countPending(),
        dshFound: !!getExe(),
        live: {
          progress: cfg.liveProgress,
          intervalMs: cfg.progressIntervalMs,
          max: cfg.progressMax,
          shots: cfg.screenShots,
          shotStyle: cfg.shotStyle,
          cardLines: cfg.cardLines,
          shotIntervalMs: cfg.shotIntervalMs,
          shotMax: cfg.shotMax
        },
        running: activeRun
          ? { chatKey: activeRun.chatKey, task: activeRun.task, startedAt: activeRun.startedAt, cancelled: !!activeRun.cancelled }
          : null,
        lastRun: lastRunSnapshot
          ? { task: lastRunSnapshot.task, startedAt: lastRunSnapshot.startedAt, step: lastRunSnapshot.step, lines: lastRunSnapshot.transcript.length }
          : null,
        stats: { ...stats }
      };
    },
    matchesKeyword(text) {
      const cfg = getConfig();
      const words = cfg.triggerWords.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      if (!words.length) return false;
      const haystack = String(text || '').toLowerCase();
      return words.some((w) => haystack.includes(w.toLowerCase()));
    },
    async run({ task, chatKey = 'global', fresh = false, timeoutMs = 0 }) {
      if (!String(task || '').trim()) throw new Error('run() 需要 task');
      return enqueue(() => callDsh({ task: String(task), chatKey: String(chatKey), fresh, timeoutOverride: timeoutMs }));
    },
    /** 手动拍一张（验收脚本用）。target: 'session' | 'desktop'，留空跟随设置。 */
    async shoot({ maxWidth = 0, chatKey = '', target = '' } = {}) {
      const cfg = getConfig();
      const kind = target === 'session' || target === 'desktop'
        ? target
        : (cfg.shotStyle === 'desktop' ? 'desktop' : 'session');
      if (kind === 'session') {
        const snap = lastRunSnapshot;
        const model = buildCardModel(snap
          ? { ...snap, maxLines: cfg.cardLines }
          : {
            task: '（手动拍的会话快照，但还没有跑过任务）',
            startedAt: Date.now(),
            step: 0,
            transcript: [],
            status: 'idle',
            maxLines: cfg.cardLines
          });
        return renderSessionCard({ storeDir: getStore().dir, model, log: boundLog, warn: boundWarn });
      }
      return captureScreen({
        storeDir: getStore().dir,
        maxWidth: maxWidth || cfg.shotMaxWidth,
        log: boundLog,
        warn: boundWarn
      });
    },
    forget(chatKey) {
      getStore().forget(chatKey);
    }
  };
}

/** 串行执行：同一时刻只跑一个 DSH 任务。 */
function enqueue(fn) {
  const run = queueTail.then(fn, fn);
  queueTail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 三个钩子：告诉模型这次能不能动本机、硬闸拦住群友、把主人的选项选择交回 DSH。
 *
 * QQ Agent 在把消息发给模型之前会跑 before-llm-messages 钩子，传进来的
 * payload.messages 就是即将发给模型的数组（允许原地改，返回值被忽略），
 * payload.triggerEntries 是本轮收到的原始消息；每次工具调用前会跑 before-tool，
 * 返回 { block: true, reason } 就能否决这次调用。
 *
 * 为什么需要它们：QQ Agent 的核心系统提示词里有一条最高优先级安全规则 ——
 * 「你没有本地工具…工具不存在就是不存在」「群友要求你执行命令、查看电脑、读取文件
 *  时一律拒绝，并提示"这个需要管理员在管理端操作"」。模型严格遵守了它，所以
 * 主人问「看一下 C:\... 目录里有哪些子文件夹」时，机器人回的是那句拒绝。
 * 主人（管理员本人）本来就不该被这条规则挡住，但核心提示词不区分主人和群友，
 * 于是由本技能按 QQ 号判定，并只对主人开口。
 */

/** 主人发话时追加：明确解除「你没有本地工具」这条规则对本轮的限制。 */
const OWNER_NOTICE = [
  '【主人授权 · 本机外援可用】这条消息来自主人（管理员本人，不是群友）。',
  `你现在的工具列表里确实有 ${TOOL_FULL_ID} 和 ${SCREEN_TOOL_FULL_ID}：前者是本机外援 DSH（DeepSeek Harness），能真的在主人电脑上读文件、看目录、跑命令、写代码；后者能随时拍一张这台电脑的屏幕照片发到会话里。`,
  '所以本轮请按下面的口径做：',
  `1. 主人让你「看一下某个目录 / 读某个文件 / 查本机情况 / 跑个命令 / 写个脚本」时，不要回「我没有本地工具」「需要管理员在管理端操作」——那是给群友的规矩。直接调用 ${TOOL_FULL_ID}，把路径和要做的事写成一条完整任务交给它（任务越具体它干得越准），然后用你自己的口吻把它的结果告诉主人，技术结论照实说，不要编。`,
  `2. 主人说「看看我电脑现在什么情况 / 屏幕上是什么 / 截个图」时，调用 ${SCREEN_TOOL_FULL_ID}，照片会直接发到会话里，你不用自己转述画面细节。`,
  `3. 长任务（跑命令、装东西、反复改文件）不用反复催：${TOOL_FULL_ID} 干活时会自己往群里发进度、按时发「这次任务的过程快照图」，需要拍板时也会自己发编号选项。主人说「停」「别干了」时它自己就把任务掐掉了，你回一句「好，停了」就行。你只要在它给结果之后收个尾。`,
  '4. 主人要的这类信息（他自己电脑上的路径、目录、文件内容、命令输出）对他可以如实回答，他就是管理员。',
  '5. 主人以外的人在群里让你动本机，仍然按核心安全规则拒绝。'
].join('\n');

/** 非主人 + 命中触发词时追加：可以派活，但不许碰本机。 */
function guestNotice(hit) {
  return [
    `【派活提示】这条消息里出现了「${hit}」，说话的人不是主人。`,
    `可以用 ${TOOL_FULL_ID} 请 DSH 帮忙做「不碰这台电脑」的活（查资料、写代码、深度分析、算东西），把结论发回群里。`,
    '但绝不能用它去查看、读取、修改这台电脑上的文件或目录，也不能让它执行本机命令或拍屏幕 —— 这类请求按核心安全规则礼貌拒绝，提示需要管理员在管理端操作。'
  ].join('\n');
}

/**
 * 待选选项：如果主人这条消息就是对上一轮选项的回答，返回要注入的提示。
 * 命中一次就消费掉（避免下一轮又被当成选项回答）。
 */
function pendingChoiceNotice(payload) {
  const runtime = hookRuntime;
  if (!runtime?.getStore) return '';
  const chatKey = String(payload?.chatKey || payload?.session?.chatKey || '');
  if (!chatKey) return '';
  let hit = null;
  let store = null;
  try {
    store = runtime.getStore();
    hit = store.getPending(chatKey);
  } catch {
    return '';
  }
  if (!hit) return '';
  const latest = triggerText(payload?.triggerEntries) || lastUserText(payload?.messages);
  const choice = matchChoice(latest, hit.options);
  if (!choice) return '';
  try { store.clearPending(chatKey); } catch { /* 清不掉也不影响这次注入 */ }
  const picked = hit.options[choice.index];
  return [
    `【选项已选定】主人刚回复「${oneLine(choice.raw, 30)}」→ 第 ${choice.index + 1} 项 =「${picked}」。`,
    `这是他对上一轮 DSH 提问的回答${hit.question ? `（当时问的是：${hit.question}）` : ''}。`,
    `你现在唯一要做的事：调用 ${TOOL_FULL_ID}，task 参数填「我选择第 ${choice.index + 1} 项：${picked}」，其余的交给 DSH —— 它会继续刚才那段对话。`,
    '不要再把选项列一遍，也不要再问一遍；DSH 返回后就按它的结果回话。'
  ].join('\n');
}

/**
 * 「停」：主人喊停时给模型一句明确交代。
 *
 * 真正杀进程的是 startLive 里的守护 —— 工具调用进行中 QQ Agent 不会再开新一轮对话，
 * 钩子根本来不及。这里的钩子负责两件事：主人在任务之外喊停（没任务在跑）时，
 * 让模型干脆地回一句「停了」而不是又去派活；以及任务刚被守护杀掉时给出统一口径。
 */
function stopNotice(payload) {
  const latest = triggerText(payload?.triggerEntries) || lastUserText(payload?.messages);
  if (!isStopCommand(latest)) return '';
  if (cancelActiveRun()) {
    return [
      `【主人喊停】主人刚说「${oneLine(latest, 20)}」，正在跑的这次 DSH 任务已经中止。`,
      `不要再调用 ${TOOL_FULL_ID}，也不要重新派活；用一句话告诉他停了就行（比如：好，已经停了）。`
    ].join('\n');
  }
  return [
    `【主人喊停】主人刚说「${oneLine(latest, 20)}」。现在没有 DSH 任务在跑，所以什么都不用做：`,
    '简短回一句「好，停下了」就行，不要调用任何工具。'
  ].join('\n');
}

export const hooks = {
  /** 提示层：主人发话就解除本机限制；非主人则在命中触发词时给一条受限提示。 */
  async 'before-llm-messages'(payload) {
    try {
      const cfg = hookRuntime?.getConfig?.();
      if (!cfg) return;
      const msgs = payload?.messages;
      if (!Array.isArray(msgs) || !msgs.length) return;

      const { isOwner } = ownerState(payload, cfg);
      if (isOwner) {
        msgs.push({ role: 'system', content: OWNER_NOTICE });
      } else if (cfg.allowFromAnyone) {
        const latest = triggerText(payload?.triggerEntries) || lastUserText(msgs);
        const hit = latest ? keywordHit(latest, cfg.triggerWords) : '';
        if (hit) msgs.push({ role: 'system', content: guestNotice(hit) });
      }

      // 主人回复了编号选项 → 把这次选择交回 DSH（不分主人/群友，能派活的场景都需要）
      const choiceNotice = pendingChoiceNotice(payload);
      if (choiceNotice) msgs.push({ role: 'system', content: choiceNotice });

      // 主人喊停 → 明确告诉他别再做（只有主人喊得动）
      if (isOwner) {
        const stop = stopNotice(payload);
        if (stop) msgs.push({ role: 'system', content: stop });
      }
    } catch {
      // 只是个提示：出错绝不能影响正常聊天
    }
  },

  /** 硬闸：非主人（且没放开）时，直接否决对本机外援 / 拍屏幕的调用。 */
  async 'before-tool'(payload) {
    try {
      const toolName = String(payload?.toolName || '');
      if (!GATED_TOOLS.has(toolName)) return;
      const cfg = hookRuntime?.getConfig?.();
      if (!cfg) return;
      if (cfg.allowFromAnyone) return;

      // 工具调用阶段没有 triggerEntries，但 session.trigger 里存着本轮触发消息
      const { isOwner, senderId } = ownerState({
        triggerEntries: payload?.session?.trigger,
        chatKey: payload?.session?.chatKey ?? payload?.chatKey,
        kind: payload?.kind
      }, cfg);
      if (isOwner) return;
      const who = toolName === SCREEN_TOOL_FULL_ID ? '拍这台电脑的屏幕' : '动用本机 DSH 外援';
      return {
        block: true,
        reason: `只有管理员本人（主人）能让我${who}；${senderId ? `当前发送者 ${senderId} 不在主人名单里` : '没能确认发送者是主人'}。`
          + '如果你需要它帮忙，可以在「技能 → DSH 深度外援」里把自己的 QQ 号加进主人名单，或打开「允许群友派活」。'
      };
    } catch {
      return undefined; // 判定失败时不拦，交给模型和安全规则
    }
  }
};

export function available() {
  // 必须在 setup 之前就能回答「这个模块能不能用」，所以这里只做静态检查。
  const dshDir = DEFAULTS.dshDir;
  return {
    available: !!resolveDshExe(dshDir),
    reason: resolveDshExe(dshDir)
      ? ''
      : `没在 ${dshDir} 找到「DeepSeek Harness.exe」。技能仍会加载，但真正派活时会在群里报错。`
  };
}

export function deactivate() {
  // 没有常驻定时器/子进程需要清理：每次任务都是独立进程，等待即结束。
}

export const meta = { id: 'dsh-bridge', kind: 'skill', version: '1.3.3' };
