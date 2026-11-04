// 扩展管理面板（ext-admin）
//
// 让主人在 QQ 里管理「技能」与「插件」：列清单、看详情、启用/停用、删除。
//
// 实现要点（与文档 skill-development.md / skill-reference.md 对齐）：
//   · 只注册工具、不做钩子 → 用不用由模型判断，属于 LLM 型（skills/）；
//   · 所有动作都走应用自己的本地 HTTP 接口（/api/skills），
//     这样配置落盘、activate/deactivate、UI 状态刷新都由核成完成，不重复实现一遍；
//   · 删除没有现成接口，直接删目录再触发 /api/skills/reload（热重载同一条路）；
//   · 权限：只认 QQ 号（与 owner-identity 插件同一份配置），非主人一律拒绝。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = globalThis.__qqAgentRoot || path.resolve(HERE, '..', '..');
const SELF_ID = 'ext-admin';

let cfg = () => ({});
let getConfig = () => ({});
let configReady = null;
let apiRef = null;

/** 懒加载核心配置模块（setup 阶段是同步的，不能 await） */
function ensureConfig() {
  if (!configReady) {
    configReady = import(pathToFileURL(path.join(APP_ROOT, 'src', 'config.js')).href)
      .then((mod) => { getConfig = mod.getConfig; })
      .catch(() => { getConfig = () => ({}); });
  }
  return configReady;
}

const QQ_RE = /^\d{5,15}$/;

/** 主人号码列表：与 owner-identity 插件同一份配置（skills 段优先，其次 plugins 段）。 */
function ownerIds() {
  try {
    const c = getConfig() || {};
    const raw = c.skills?.['owner-identity']?.ids ?? c.plugins?.['owner-identity']?.ids ?? '';
    return String(raw).split(/[,，;；\s]+/).map((s) => s.trim()).filter((s) => QQ_RE.test(s));
  } catch { return []; }
}

/** 调用者的 QQ（核心在 ctx.callerId 里给，私聊=对方号，群聊=最后一条非自己发的消息的发送者）。
 *  旧核心没有 callerId 字段时退回「私聊用 chatId」；群聊认不出就拒绝（宁严不宽）。 */
function callerId(ctx) {
  const direct = String(ctx?.callerId ?? '').replace(/\D/g, '');
  if (direct) return direct;
  if (String(ctx?.kind ?? '') === 'private' && ctx?.chatId) return String(ctx.chatId).replace(/\D/g, '');
  return '';
}

/**
 * 主人判定：
 *   ① 优先用官方能力 message.owner-check（由「主人识别」插件提供）——
 *      这样开关、号码、人设全都以那个插件为准，不重复维护一份配置；
 *   ② 插件没装/没启用时，退回直接读它的配置段（effect 相同，避免整块功能失效）。
 * 返回 true / false；拿不到结论时返回 null。
 */
function isOwnerByCapability(uid) {
  if (!uid) return false;
  try {
    const r = apiRef?.capability?.('message.owner-check', { userId: uid });
    if (r && typeof r === 'object' && typeof r.isOwner === 'boolean') return r.isOwner;
  } catch { /* 能力提供方异常 → 走配置兜底 */ }
  return null;
}

function isOwner(uid) {
  const viaCap = isOwnerByCapability(uid);
  if (viaCap !== null) return viaCap;
  return ownerIds().includes(uid);
}

/** 权限闸：只在主人明确要求时才允许改动；否则返回一句拒绝文案。 */
function denyUnlessOwner(ctx, action) {
  const owners = ownerIds();
  const uid = callerId(ctx);
  if (!uid) {
    return `⛔ 认不出调用者是谁，${action}被拒绝（只能在正常聊天里由主人发起）。`;
  }
  const viaCap = isOwnerByCapability(uid);
  if (viaCap === false) {
    return `⛔ 只有主人能${action}（当前调用者 ${uid} 不在主人名单里）。`;
  }
  if (viaCap === null) {
    // 能力提供方不在（插件没装/停用）→ 用配置兜底，仍然按「没号码就不放行」处理
    if (!owners.length) {
      return `⛔ 还没配置主人，${action}被拒绝。\n`
        + '请到控制台「插件 → 主人识别（owner-identity）」里填主人 QQ 号，多个用逗号分隔。';
    }
    if (!owners.includes(uid)) {
      return `⛔ 只有主人能${action}（当前调用者 ${uid} 不在主人名单里）。`;
    }
  }
  return '';
}

function port() {
  try {
    const p = Number(getConfig()?.server?.port);
    if (Number.isFinite(p) && p > 0) return p;
  } catch { /* ignore */ }
  return 3210;
}

async function localApi(pathname, init = {}) {
  const url = `http://127.0.0.1:${port()}${pathname}`;
  const res = await fetch(url, {
    method: init.method || 'GET',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    throw new Error(`本地接口 ${pathname} 返回 HTTP ${res.status}${data?.error ? `：${data.error}` : ''}`);
  }
  return data;
}

const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function kindLabel(kind) { return kind === 'plugin' ? '插件' : '技能'; }

/** 单个扩展的一行摘要 */
function line(item) {
  const flag = item.active ? '✓' : (item.enabled ? '⚠' : '✗');
  const note = item.enabled ? '' : '（已停用）';
  return `${flag} ${item.id} v${item.version || '?'}　${item.name || ''}${note}`;
}

/** 为什么没生效：只挑有用的信息，避免把整个对象倒给模型 */
function problemOf(item) {
  if (item.active) return '';
  if (item.loaded === false) return item.loadError ? `加载失败：${item.loadError}` : '未加载';
  if (item.reason) return String(item.reason);
  if (item.code) return String(item.code);
  if (item.missingRequires?.length) return `缺少依赖能力：${item.missingRequires.join('、')}`;
  return item.enabled ? '未激活' : '已停用';
}

function fmtList(items, { onlyProblems = false } = {}) {
  const groups = new Map();
  for (const it of items) {
    const k = it.kind === 'plugin' ? 'plugin' : 'skill';
    if (!groups.has(k)) groups.set(k, []);
    if (onlyProblems && it.active) continue;
    groups.get(k).push(it);
  }
  const out = [];
  for (const [k, list] of groups) {
    if (!list.length) continue;
    out.push(`【${kindLabel(k)}（${k === 'plugin' ? 'plugins/' : 'skills/'}）】共 ${list.length} 个`);
    for (const it of list) {
      out.push('  ' + line(it));
      if (!it.active) out.push(`     ↳ ${problemOf(it)}`);
    }
  }
  return out.join('\n');
}

export function setup(api) {
  cfg = api.config;
  apiRef = api;

  // ── 0. 主人识别自检 ───────────────────────────────────────
  api.registerTool({
    id: 'check_owner',
    name: '看谁是主人',
    description:
      '用来确认「主人识别」是否生效：返回当前调用者的 QQ、判定结果（是不是主人）、以及主人名单。'
      + '当主人问「你认得我吗」「主人是谁」「为什么没权限」时使用。',
    category: 'system',
    icon: '🪪',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      await ensureConfig();
      const uid = callerId(ctx);
      const viaCap = isOwnerByCapability(uid);
      const owners = ownerIds();
      const pluginOn = (() => {
        try { return apiRef?.isSkillActive?.('owner-identity') !== false; } catch { return false; }
      })();
      const lines = [
        `当前调用者：${uid || '认不出（私聊里应该能认出来）'}`,
        `判定：${isOwner(uid) ? '✅ 是主人' : '❌ 不是主人'}`,
        `判定通道：${viaCap === null ? '配置兜底（主人识别插件未提供能力）' : 'message.owner-check 能力'}`,
        `主人识别插件：${pluginOn ? '已生效' : '未生效/未安装'}`,
        `主人名单：${owners.length ? owners.join('、') : '（空 —— 去「插件 → 主人识别」里填）'}`
      ];
      return { content: lines.join('\n') };
    }
  });

  // ── 1. 列清单 ─────────────────────────────────────────────
  api.registerTool({
    id: 'list_extensions',
    name: '列出扩展',
    description:
      '列出本机装的全部技能(skills/)与插件(plugins/)，含版本、启用状态、以及没生效的原因。'
      + '当主人问「装了哪些插件」「有哪些技能」「某某为什么没反应」时使用。',
    category: 'system',
    icon: '📦',
    parameters: {
      type: 'object',
      properties: {
        onlyProblems: { type: 'boolean', description: '只列出没生效/加载失败的。默认 false。' }
      }
    },
    async execute(ctx, args) {
      const denied = denyUnlessOwner(ctx, '查看扩展清单');
      if (denied) return { content: denied, isError: true };
      await ensureConfig();
      try {
        const data = await localApi('/api/skills');
        const items = Array.isArray(data?.skills) ? data.skills : [];
        const max = Math.max(10, Math.min(200, Number(cfg().maxList) || 60));
        const body = fmtList(items.slice(0, max), { onlyProblems: args?.onlyProblems === true });
        const s = data?.summary || {};
        const head = `共 ${s.total ?? items.length} 个扩展：生效 ${s.active ?? '?'}，停用 ${s.disabled ?? '?'}，异常 ${s.broken ?? '?'}`;
        const tail = items.length > max ? `\n（只显示了前 ${max} 个，其余省略）` : '';
        return { content: `${head}\n\n${body || '（没有符合条件的扩展）'}${tail}` };
      } catch (error) {
        return { content: `列清单失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 2. 详情 ───────────────────────────────────────────────
  api.registerTool({
    id: 'extension_detail',
    name: '扩展详情',
    description:
      '查看某一个技能/插件的详情：注册了哪些工具、提供了哪些能力、有哪些配置项、当前为什么可用/不可用。'
      + '当主人问「XX 插件能干什么」「XX 为什么不可用」时使用，需要扩展 id。',
    category: 'system',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '扩展 id，例如 steam-query。不确定就先调 list_extensions。' }
      },
      required: ['id']
    },
    async execute(ctx, args) {
      const denied = denyUnlessOwner(ctx, '查看扩展详情');
      if (denied) return { content: denied, isError: true };
      await ensureConfig();
      const id = String(args?.id ?? '').trim();
      if (!ID_RE.test(id)) return { content: `扩展 id 不合法：${id}`, isError: true };
      try {
        const data = await localApi('/api/skills');
        const item = (data?.skills || []).find((x) => x.id === id);
        if (!item) return { content: `没找到扩展 ${id}。先调 list_extensions 看看准确的 id。`, isError: true };
        const out = [
          `${item.name || id}（${id}）v${item.version || '?'}　${kindLabel(item.kind)}`,
          `状态：${item.active ? '生效中' : (item.enabled ? '已启用但未生效' : '已停用')}`,
          item.description ? `说明：${item.description}` : '',
          item.toolIds?.length ? `注册的工具：${item.toolIds.join('、')}` : '注册的工具：无',
          item.capabilities?.length ? `提供的能力：${item.capabilities.join('、')}` : '',
          item.requires?.length ? `依赖的能力：${item.requires.join('、')}` : '',
          item.hooks?.length ? `钩子：${item.hooks.join('、')}` : '',
          item.configSchema && Object.keys(item.configSchema).length
            ? `配置项：${Object.keys(item.configSchema).join('、')}`
            : '',
          !item.active ? `未生效原因：${problemOf(item)}` : ''
        ].filter(Boolean);
        return { content: out.join('\n') };
      } catch (error) {
        return { content: `查详情失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 3. 启用 / 停用 ────────────────────────────────────────
  api.registerTool({
    id: 'set_extension_enabled',
    name: '启用或停用扩展',
    description:
      '启用或停用某个技能/插件。停用后它注册的工具、提示词片段会一起失效（不会偷偷继续工作）。'
      + '仅主人可用。当主人说「把 XX 关了」「启用 XX」时使用。',
    category: 'system',
    icon: '🎚️',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '扩展 id' },
        enabled: { type: 'boolean', description: 'true=启用，false=停用' }
      },
      required: ['id', 'enabled']
    },
    async execute(ctx, args) {
      const want = args?.enabled === true;
      const denied = denyUnlessOwner(ctx, want ? '启用扩展' : '停用扩展');
      if (denied) return { content: denied, isError: true };
      await ensureConfig();
      const id = String(args?.id ?? '').trim();
      if (!ID_RE.test(id)) return { content: `扩展 id 不合法：${id}`, isError: true };
      try {
        const r = await localApi(`/api/skills/${encodeURIComponent(id)}`, {
          method: 'POST',
          body: { enabled: want }
        });
        if (r?.ok === false) return { content: `操作失败：${r.error || '未知原因'}`, isError: true };
        const now = r?.skill?.active ? '生效中' : (r?.skill?.enabled ? '已启用' : '已停用');
        return { content: `已${want ? '启用' : '停用'} ${id}，当前状态：${now}。` };
      } catch (error) {
        return { content: `操作失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 4. 删除（默认关闭，需在设置里打开）──────────────────────
  api.registerTool({
    id: 'remove_extension',
    name: '删除扩展',
    description:
      '彻底删除某个技能/插件的目录（不可恢复）。需要主人在设置里打开「允许删除扩展」，'
      + '并且调用时 confirm 必须为 true。当主人明确说「删掉 XX」「卸载 XX」时使用；'
      + '如果只是想让它别说话，用 set_extension_enabled 停用就够了。',
    category: 'system',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要删除的扩展 id' },
        confirm: { type: 'boolean', description: '必须显式传 true，表示确认删除' }
      },
      required: ['id', 'confirm']
    },
    async execute(ctx, args) {
      await ensureConfig();
      if (cfg().allowRemove !== true) {
        return {
          content: '⛔ 删除功能没开。主人可以在控制台「技能 → 扩展管理面板」设置里打开「允许删除扩展」；'
            + '只想让它别工作的话，用 set_extension_enabled 停用即可。',
          isError: true
        };
      }
      const denied = denyUnlessOwner(ctx, '删除扩展');
      if (denied) return { content: denied, isError: true };
      if (args?.confirm !== true) {
        return { content: '需要 confirm: true 才执行删除（这是防误删）。', isError: true };
      }
      const id = String(args?.id ?? '').trim();
      if (!ID_RE.test(id)) return { content: `扩展 id 不合法：${id}`, isError: true };
      if (id === SELF_ID) return { content: '不能删除扩展管理面板自己。', isError: true };

      try {
        const data = await localApi('/api/skills');
        const item = (data?.skills || []).find((x) => x.id === id);
        if (!item) return { content: `没找到扩展 ${id}。`, isError: true };
        const rel = String(item.dir || '');
        const target = path.resolve(APP_ROOT, rel);
        // 目录闸：只允许删 APP_ROOT/skills 或 APP_ROOT/plugins 下面的一级子目录
        const roots = [path.join(APP_ROOT, 'skills'), path.join(APP_ROOT, 'plugins')]
          .map((p) => path.resolve(p) + path.sep);
        if (!roots.some((r) => target.startsWith(r)) || path.dirname(target) === path.resolve(APP_ROOT)) {
          return { content: `拒绝删除：${rel} 不在 skills/ 或 plugins/ 下。`, isError: true };
        }
        if (!fs.existsSync(target)) return { content: `目录不存在：${rel}`, isError: true };

        fs.rmSync(target, { recursive: true, force: true });
        await localApi('/api/skills/reload', { method: 'POST', body: {} }).catch(() => null);
        return { content: `已删除 ${id}（${rel}），已通知重新扫描。若页面上还显示「已配置但未安装」，点一下清理即可。` };
      } catch (error) {
        return { content: `删除失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

/** 依赖的只是本机 HTTP 接口，永远认为可用；真正失败会在工具里回报原因。 */
export function available() {
  return { ok: true };
}
