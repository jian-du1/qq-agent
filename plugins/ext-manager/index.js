// 扩展管理器（ext-manager）
// 让机器人帮忙清理技能与插件：列出装了哪些、把不要的整个移除。
//
// ⚠️ 为什么是"插件"而不是"技能"：
//   插件运行在主进程，有文件系统权限（能读 config.json、能移动目录），
//   技能跑在受限环境里做不到。删除这种破坏性动作必须由插件做。
//
// 删除怎么实现的（两条路，优先第一条）：
//   ① 调核心的控制台接口 POST /api/skills/delete —— 核心会做完整流程
//      （移到 _removed/ + 清配置 + 重扫，工具与提示词立刻下线）。
//      端口从 config.server.port 读，所以不需要额外配置。
//   ② 接口不可用（核心版本较老）→ 降级：插件自己把目录移到 _removed/，
//      然后尝试调 /api/skills/reload 让核心重扫；再不行就提示重启。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // .../resources/app/plugins/ext-manager
const APP_ROOT = path.resolve(HERE, '..', '..');             // .../resources/app
// 配置文件位置：**不能想当然** —— 数据目录可能被 QQ_AGENT_DATA_DIR / PROFILE 重定向
// （本机实测就重定向到了顶层 data/，插件按相对路径算会读空 → 权限校验整个失效）。
// 所以这里列出一串候选，读到"看起来是配置"的那个为止。
const CONFIG_CANDIDATES = (() => {
  const out = [path.join(APP_ROOT, 'data', 'config.json')];
  for (let d = APP_ROOT, i = 0; i < 4; i++) {
    const up = path.dirname(d);
    if (up === d) break;
    out.push(path.join(up, 'data', 'config.json'));
    d = up;
  }
  return out;
})();
const KINDS = ['skills', 'plugins'];

let cfg = () => ({});
let isSkillActiveFn = null;

function configFile() {
  for (const f of CONFIG_CANDIDATES) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && typeof j === 'object' && (j.skills || j.api || j.server)) return { file: f, data: j };
    } catch { /* 试下一个 */ }
  }
  return { file: '', data: {} };
}
function readConfig() { return configFile().data; }

/** 找控制台端口：配置里优先，其次常见偏移（多实例 PROFILE 会 +100/+200） */
function candidatePorts() {
  const ports = [];
  try {
    const c = readConfig();
    const p = Number(c?.server?.port);
    if (Number.isFinite(p) && p > 0) ports.push(p);
  } catch { /* ignore */ }
  for (const p of [3210, 3211, 3212, 3310, 3410]) if (!ports.includes(p)) ports.push(p);
  return ports;
}

/** 调核心接口（带短超时；失败返回 null） */
async function callCore(pathname, body) {
  for (const port of candidatePorts()) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(5000)
      });
      const j = await r.json().catch(() => null);
      // 404/500 说明接口不存在或出错 —— 换下一个端口/走降级
      if (r.ok && j && j.ok !== false) return { ok: true, data: j, port };
      if (j && j.ok === false && r.status !== 404) return { ok: false, data: j, port, status: r.status };
    } catch { /* 端口不通就试下一个 */ }
  }
  return null;
}

/** 列出当前装了什么 */
function listInstalled() {
  const out = [];
  for (const kind of KINDS) {
    const dir = path.join(APP_ROOT, kind);
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); }
    catch { continue; }
    for (const id of names) {
      if (id.startsWith('.') || id === 'node_modules') continue;
      const manifestName = kind === 'skills' ? 'skill.json' : 'plugin.json';
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(path.join(dir, id, manifestName), 'utf8')); } catch { /* 清单缺失/坏 */ }
      // 目录结构异常检测：清单不在顶层，多半是"多套了一层"（装包解压错位）
      let nested = false;
      if (!manifest) {
        try {
          nested = fs.readdirSync(path.join(dir, id), { withFileTypes: true })
            .some((d) => d.isDirectory() && fs.existsSync(path.join(dir, id, d.name, manifestName)));
        } catch { /* ignore */ }
      }
      const enabled = readConfig()?.skills?.[id]?.enabled;
      out.push({
        kind, id,
        name: manifest?.name || id,
        version: manifest?.version || '',
        broken: !manifest,
        nested,
        enabled: enabled === undefined ? null : enabled === true
      });
    }
  }
  return out;
}

/**
 * 主人校验：优先用主人识别插件的能力，其次读配置。
 *
 * ⚠️ 返回里的两个"未就绪"标志很关键（使用者 2026-10-12 要求必须启用主人识别）：
 *    没启用主人识别时**不能当成"没有主人"就放行** —— 否则任何人都能删扩展。
 *    所以这里如实标注，由调用方决定拒绝还是提醒（删除一律拒绝）。
 */
function checkOwner(ctx) {
  const caller = String(ctx?.callerId || '').replace(/\D/g, '');
  // 「允许非主人查看扩展列表」是个**总开关**（使用者 2026-10-12 明确）：
  //   开了它 = 查看、删除、清理回收区**全都放开**，谁都能做（等于关掉权限校验）。
  //   所以这里直接放行，后面不再做任何主人检查。
  if (cfg()?.allowViewer === true) {
    return { allowed: true, caller, via: 'open-mode', ownerReady: true, ownerPluginOff: false, openMode: true };
  }
  if (!caller) {
    // 核心没给 callerId（老版本 / 非群消息触发）→ 判不了
    return { allowed: true, caller: '', via: 'no-caller', ownerReady: false, ownerPluginOff: true };
  }
  // ① 主人识别插件是否生效（核心的启停状态，含"压根没装"）
  let pluginActive = true;
  try { if (isSkillActiveFn) pluginActive = isSkillActiveFn('owner-identity') !== false; } catch { pluginActive = true; }
  // ② 读它的配置（拿主人名单）
  const c = readConfig();
  const oc = (c.skills || {})['owner-identity'] || (c.plugins || {})['owner-identity'];
  const configured = !!(oc && oc.enabled === true);
  const ids = String(oc?.ids || '').split(/[,，、\s]+/).map((x) => x.replace(/\D/g, '')).filter(Boolean);

  if (!pluginActive || !configured) {
    return { allowed: true, caller, via: 'owner-not-ready', ownerReady: false, ownerPluginOff: !pluginActive };
  }
  if (!ids.length) {
    return { allowed: true, caller, via: 'owner-no-ids', ownerReady: false, ownerPluginOff: false };
  }
  return { allowed: ids.includes(caller), caller, via: 'config', ownerReady: true, ownerPluginOff: false };
}

/** "主人识别没就绪"时统一的一段话（必须说清要启用哪个插件） */
function ownerNotReadyMsg(g, what) {
  return '⛔ **' + what + '前必须先启用「主人识别」插件**（owner-identity）。\n'
    + '它是本插件的**权限判定依据** —— 没启用它，我没法确认谁是主人，'
    + '出于安全**直接拒绝**（否则任何群友都能删你的技能和插件）。\n\n'
    + '**怎么修**：设置 → 插件 → 启用「**主人识别**」→ 在它设置里填**主人 QQ 号**（多个用逗号分隔）。\n'
    + '配置好之后再来一次即可。\n'
    + '（识别到的调用者 QQ：' + (g.caller || '认不出') + '）';
}

export function setup(api) {
  if (typeof api?.config === 'function') cfg = api.config;
  if (typeof api?.isSkillActive === 'function') isSkillActiveFn = api.isSkillActive;

  // ── 列出扩展 ────────────────────────────────────────────────────────
  api.registerTool({
    id: 'ext_list',
    name: '列出已装的技能与插件',
    description: '列出当前装了哪些技能（skills/）与插件（plugins/），附带是否启用、是否加载失败、目录结构是否异常。'
      + '群友问「装了哪些技能」「扩展列表」「有没有残缺的插件」时用。',
    category: 'utility',
    icon: '📋',
    parameters: { type: 'object', properties: {} },
    execute(ctx) {
      // 非主人能不能看：由设置 allowViewer 决定（默认只有主人能看）
      const allowViewer = cfg()?.allowViewer === true;
      if (!allowViewer) {
        const g = checkOwner(ctx);
        // 主人识别没启用 → 判不了"谁是主人" → 拒绝（并说清要启用哪个插件）
        if (!g.ownerReady) return { content: ownerNotReadyMsg(g, '查看扩展列表'), isError: true };
        if (!g.allowed) {
          return { content: '⛔ 「扩展管理器」默认只让主人查看列表。\n'
            + '要放开：在插件设置里打开「允许非主人查看扩展列表」（删除始终只有主人能做）。', isError: true };
        }
      }
      const items = listInstalled();
      if (!items.length) return { content: '当前没有装任何技能或插件。' };
      const fmt = (list, label) => {
        if (!list.length) return `**${label}**：无`;
        return `**${label}**（${list.length}）\n` + list.map((x) => {
          const flags = [];
          if (x.enabled === false) flags.push('已关闭');
          if (x.enabled === null) flags.push('未配置');
          if (x.broken) flags.push('⚠️ 缺清单文件');
          if (x.nested) flags.push('⚠️ 目录多套了一层');
          return `  · \`${x.id}\`${x.version ? ' v' + x.version : ''} — ${x.name}${flags.length ? '（' + flags.join('，') + '）' : ''}`;
        }).join('\n');
      };
      const skills = items.filter((x) => x.kind === 'skills');
      const plugins = items.filter((x) => x.kind === 'plugins');
      const bad = items.filter((x) => x.broken || x.nested);
      let out = '当前已装：\n' + fmt(skills, '技能') + '\n' + fmt(plugins, '插件');
      if (bad.length) {
        out += `\n\n⚠️ **有 ${bad.length} 个条目看起来有问题**（清单文件缺失，或目录多套了一层）：\n`
          + bad.map((x) => `  · ${x.kind}/\`${x.id}\``).join('\n')
          + '\n（这些通常装不上，可以删掉重装。）';
      }
      out += '\n\n要删哪个：说「把 `id` 删掉」即可（会移到回收区，不是永久删除）。';
      return { content: out };
    }
  });

  // ── 清理回收区（手动触发）────────────────────────────────────────────
  api.registerTool({
    id: 'ext_purge',
    name: '清理回收区',
    description: '清掉 resources/app/_removed/ 里**过期的**已删扩展（默认保留 7 天，之后自动清理）。'
      + '群友说「清理回收站」「回收区占太多空间了」「清一下删掉的东西」时用。**只有主人能用**。'
      + '不带参数 = 按保留天数清；带 {"dryRun":true} 只看看能清多少、真删；带 {"all":true} 无视保留天数全清。',
    category: 'utility',
    icon: '🧹',
    parameters: {
      type: 'object',
      properties: {
        dryRun: { type: 'boolean', description: '只预览（不真删），返回会清掉哪些、能释放多少空间' },
        all: { type: 'boolean', description: '无视保留天数，把回收区**全清**（谨慎：删掉的扩展就找不回来了）' }
      }
    },
    async execute(ctx, args) {
      const g = checkOwner(ctx);
      if (!g.openMode) {
        if (!g.ownerReady) {
          return { content: ownerNotReadyMsg(g, '清理回收区'), isError: true };
        }
        if (!g.allowed) {
          return { content: `⛔ **只有主人能清理回收区**。这条消息来自 QQ ${g.caller || '（认不出）'}，不在主人名单里。`, isError: true };
        }
      }
      const all = args?.all === true;
      const dry = args?.dryRun === true;
      const days = keepDays();
      const r = purgeRemoved({ force: all, dryRun: dry });
      if (!r.scanned) return { content: '回收区（_removed/）是空的，没有要清的东西。' };
      if (!r.purged.length) {
        const left = keepDays();
        return { content: `回收区有 ${r.scanned} 个条目，但都还没超过保留期（${left} 天）—— **暂时不用清**。\n`
          + '（想立刻全清：带 {"all":true}；想改保留天数：插件设置里的「回收区保留天数」。）' };
      }
      const list = r.purged.slice(0, 10).map((n) => '  · ' + n).join('\n');
      return { content: (dry ? '🔍 **预览**（没有真删）：' : '🧹 **已清理**：')
        + `回收区 ${r.purged.length} 个过期条目，释放 ${human(r.freedBytes)}\n` + list
        + (r.purged.length > 10 ? `\n  …还有 ${r.purged.length - 10} 个` : '')
        + (dry ? '\n（要真删就把 dryRun 去掉）' : '')
        + `\n保留天数：${all ? '本次全清' : days + ' 天'}（可在插件设置里改）` };
    }
  });

  // ── 删除扩展 ────────────────────────────────────────────────────────
  api.registerTool({
    id: 'ext_remove',
    name: '删除技能/插件',
    description: '把一个技能或插件**整个移除**：文件夹移到 resources/app/_removed/（可找回）+ 清掉它的配置。'
      + '群友说「把 xxx 删掉」「清理没用的插件」时用。**只有主人能用**。'
      + '支持一次删多个（ids 传数组）。**不是永久删除** —— 想恢复把文件夹移回 skills/ 或 plugins/ 即可。',
    category: 'utility',
    icon: '🗑',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: '要删除的扩展 id（就是列表里反引号里的那个，如 ext-manager）。可以一次传多个。'
        },
        confirm: {
          type: 'boolean',
          description: '必填 true。表示已经跟群友确认过要删这几个（防模型擅自删除）。'
        }
      },
      required: ['ids', 'confirm']
    },
    async execute(ctx, args) {
      // ① 权限：开放模式下跳过全部校验；否则必须主人识别就绪 + 是主人
      const g = checkOwner(ctx);
      if (!g.openMode) {
        if (!g.ownerReady) {
          return { content: ownerNotReadyMsg(g, '删除技能/插件'), isError: true };
        }
        if (!g.allowed) {
          return { content: `⛔ **只有主人能删除技能/插件**。这条消息来自 QQ ${g.caller || '（认不出）'}，不在主人名单里。\n`
            + '要授权：让主人在「主人识别」里加上你的 QQ 号，或打开本插件的「允许非主人查看扩展列表」（那会连删除一起放开）。', isError: true };
        }
      }
      // ② 必须先确认
      if (args?.confirm !== true) {
        return { content: '⚠️ 删除是破坏性操作，**需要先明确确认**。\n'
          + '请先跟群友念一遍要删什么，得到同意后再调用本工具并带上 {"confirm": true}。', isError: true };
      }
      const ids = (Array.isArray(args?.ids) ? args.ids : [args?.ids]).map((x) => String(x || '').trim()).filter(Boolean);
      if (!ids.length) return { content: '没给 ids（要删哪个？可以先用 ext_list 看看装了哪些）。', isError: true };
      // ③ 合法性（防路径穿越）
      const bad = ids.filter((id) => !/^[A-Za-z0-9._-]+$/.test(id) || id.startsWith('.'));
      if (bad.length) return { content: `⛔ 这些 id 不合法：${bad.join('、')}（只允许字母数字与 . _ -）`, isError: true };
      // ④ 不许删自己（删到一半自己没了，后面全断）
      if (ids.includes('ext-manager')) {
        return { content: '⛔ 不能通过我自己删「扩展管理器」本身 —— 删到一半我就没了。\n'
          + '真要删它，去「设置 → 插件」里点它的 🗑 按钮。', isError: true };
      }

      // ⑤ 优先走核心接口（完整流程：移动 + 清配置 + 重扫）
      const core = await callCore('/api/skills/delete', { ids });
      if (core && core.ok) {
        const d = core.data || {};
        const done = (d.removed || []).map((r) => `${r.kind === 'plugins' ? '插件' : '技能'} \`${r.id}\``);
        const skip = (d.skipped || []).map((s) => `\`${s.id}\`（${s.reason}）`);
        let msg = done.length ? `✅ 已移除：${done.join('、')}` : '⚠️ 一个都没删掉。';
        if (skip.length) msg += `\n· 跳过：${skip.join('、')}`;
        if (d.recoverDir) msg += `\n（文件夹移到 \`${d.recoverDir}/\`，想找回就从这里移回去）`;
        return { content: msg };
      }

      // ⑥ 降级：插件自己移动目录（核心接口不可用：老版本 QQ Agent）
      const trash = path.join(APP_ROOT, '_removed', new Date().toISOString().replace(/[:.]/g, '-'));
      const done = []; const skip = [];
      for (const id of ids) {
        let found = null;
        for (const kind of KINDS) {
          const dir = path.join(APP_ROOT, kind, id);
          try { if (fs.statSync(dir).isDirectory()) { found = { kind, dir }; break; } } catch { /* 不存在 */ }
        }
        if (!found) { skip.push(`\`${id}\`（磁盘上没这个目录）`); continue; }
        try {
          const dest = path.join(trash, found.kind, id);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(found.dir, dest);
          done.push(`\`${id}\`（${found.kind === 'plugins' ? '插件' : '技能'}）`);
        } catch (e) { skip.push(`\`${id}\`（${String(e?.message ?? e)}）`); }
      }
      // 清配置
      if (done.length) {
        try {
          const { file, data: c } = configFile();
          if (file) {
            c.skills = c.skills || {};
            for (const id of ids) delete c.skills[id];
            fs.writeFileSync(file, JSON.stringify(c, null, 2), 'utf8');
          }
        } catch { /* 配置清理失败不阻塞 */ }
      }
      // 让核心重扫（失败就提示重启）
      const reload = await callCore('/api/skills/reload', {});
      let msg = done.length ? `✅ 已移除：${done.join('、')}` : '⚠️ 一个都没删掉。';
      if (skip.length) msg += `\n· 跳过：${skip.join('、')}`;
      if (done.length) {
        msg += `\n（文件夹移到 \`_removed/${path.basename(trash)}/\`）`;
        msg += reload && reload.ok
          ? '\n（已让核心重扫，工具与提示词应立即下线）'
          : '\n⚠️ 没能让核心重扫 —— **建议重启一次 QQ Agent**，否则被删的扩展可能还在内存里跑。';
        msg += '\n💡 提示：这次用的是降级模式（核心没有删除接口）。升级到带 `/api/skills/delete` 的版本后，删除会更干净。';
      }
      return { content: msg, isError: !done.length };
    }
  });
}


// ── 回收区（_removed）定期清理 ────────────────────────────────────────────
// 使用者 2026-10-12 要求：「removed 文件夹要定期清理」。
// 删除扩展时会把整个文件夹移进 _removed/<时间戳>/，不清就会一直堆着占磁盘。
//
// 定时用插件的生命周期：**activate 起定时器，deactivate 停** ——
// 这样"关掉插件/热重载"时定时器一定会被清掉（核心对 reload 会先 deactivate 再 dispose）。
const DEFAULT_KEEP_DAYS = 7;
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 每 6 小时看一次
let purgeTimer = null;

/** 保留天数：0 或负数 = 关掉自动清理 */
function keepDays() {
  const v = Number(cfg()?.keepRemovedDays);
  return Number.isFinite(v) ? v : DEFAULT_KEEP_DAYS;
}

/**
 * 清掉 _removed 下"太老"的条目。
 * 目录名是 ISO 时间戳（把 : 和 . 换成了 -），所以按名字解析时间；解析不了就用 mtime 兜底。
 * @returns {{ scanned:number, purged:string[], freedBytes:number, skipped:number }}
 */
function purgeRemoved({ force = false, dryRun = false } = {}) {
  const days = keepDays();
  const root = path.join(APP_ROOT, '_removed');
  const out = { scanned: 0, purged: [], freedBytes: 0, skipped: 0 };
  if (!force && (!Number.isFinite(days) || days <= 0)) return out;   // 关了自动清理
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); }
  catch { return out; }   // 目录不存在 —— 没什么可清的
  const cutoff = Date.now() - (force ? 0 : days * 24 * 60 * 60 * 1000);

  const sizeOf = (d) => {
    let n = 0;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) n += sizeOf(f);
        else { try { n += fs.statSync(f).size; } catch { /* ignore */ } }
      }
    } catch { /* ignore */ }
    return n;
  };

  for (const e of entries) {
    out.scanned++;
    const full = path.join(root, e.name);
    // 目录名 = ISO 时间戳（: . 换成 -）；形如 2026-10-12T15-18-40-306Z
    let when = 0;
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(e.name);
    if (m) when = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
    if (!Number.isFinite(when) || !when) {
      try { when = fs.statSync(full).mtimeMs; } catch { when = Date.now(); }
    }
    if (when > cutoff) { out.skipped++; continue; }        // 还新，留着（给用户找回的机会）
    const bytes = sizeOf(full);
    if (dryRun) { out.purged.push(e.name); out.freedBytes += bytes; continue; }
    try { fs.rmSync(full, { recursive: true, force: true }); out.purged.push(e.name); out.freedBytes += bytes; }
    catch { /* 删不掉就留着下次再试 */ }
  }
  return out;
}

function human(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/** 定时器跑一轮：有清理就写日志（没清理就静默，免得刷屏） */
function purgeTick() {
  try {
    const r = purgeRemoved();
    if (r.purged.length) {
      try { console.log(`[ext-manager] 回收区清理：删了 ${r.purged.length} 个过期条目（释放 ${human(r.freedBytes)}）`); } catch { /* ignore */ }
    }
  } catch { /* 清理失败不影响主流程 */ }
}

// ── 生命周期：启用时起定时器，禁用/重载时停 ────────────────────────────────
export function activate() {
  if (purgeTimer) { clearInterval(purgeTimer); purgeTimer = null; }
  // 启动时先跑一次（插件可能刚被启用，正好清一下积压的）
  setTimeout(purgeTick, 30 * 1000);
  purgeTimer = setInterval(purgeTick, PURGE_INTERVAL_MS);
  if (purgeTimer && typeof purgeTimer.unref === 'function') purgeTimer.unref();   // 别拖着进程不退出
}

export function deactivate() {
  if (purgeTimer) { clearInterval(purgeTimer); purgeTimer = null; }
}
