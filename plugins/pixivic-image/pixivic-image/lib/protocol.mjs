// 通过 SnowLuma 协议端的 HTTP 接口发送消息
//
// ── 为什么不用 ctx.sender / ctx.onebot ────────────────────────────────────
// 实测（两次真实事故）：**before-context 钩子的 ctx 里既没有 sender 也没有 onebot**。
//   第一次：ctx.sender.sendImage → Cannot read properties of undefined
//   第二次：ctx.onebot.sendImage → ctx.onebot 不可用
// 钩子只拿到 { chatKey, kind, chatId, chatName, model, provider, visionEnabled,
// searchEnabled, proactive, sessionId }；完整的 ctx（含 sender/onebot/store/memory）
// 只在**工具执行**时才组装。而插件的 setup(api) 拿到的是能力白名单，也没有它们。
//
// 所以本插件直接调协议端自己的 HTTP 接口 —— 这是唯一稳定、不依赖上下文注入的通道，
// 而且它是核心同款接口（同一份 SnowLuma 配置），不引入任何新依赖。
//
// 权衡：绕过了核心发送队列的限频/去重/留档 → 由插件自己节流（见 index.js 的
// sendImageNow），并且不谎称"已留档"。

import fs from 'node:fs';
import path from 'node:path';

/** 配置缓存：端口与 token 很少变，改配置后重启即可（避免每条消息都读盘）。 */
let cached = null;

function configFile() {
  const base = String(process.env.QQ_AGENT_DATA_DIR || '').trim()
    || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Local', 'Programs', 'QQ Agent', 'data');
  return path.join(base, 'config.json');
}

/** 读 SnowLuma 的 HTTP 地址与 token（token 只用于请求头，绝不写日志）。 */
function endpoint() {
  if (cached) return cached;
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    const sl = cfg.snowluma || {};
    const url = String(sl.httpUrl || '').trim().replace(/\/+$/, '');
    const token = String(sl.httpAccessToken || sl.accessToken || '').trim();
    cached = url ? { url, token } : { url: '', token: '', error: '配置里没有 snowluma.httpUrl' };
  } catch (error) {
    cached = { url: '', token: '', error: `读配置失败：${error?.message ?? error}` };
  }
  return cached;
}

/** 供启动自检调用：返回 { ok, detail } —— detail 里**不含** token。 */
export async function probeProtocol({ timeoutMs = 8000 } = {}) {
  const { url, token, error } = endpoint();
  if (!url) return { ok: false, detail: error || '未配置协议端地址' };
  try {
    const res = await fetch(`${url}/get_login_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs)
    });
    const json = await res.json().catch(() => null);
    if (res.status === 401 || json?.retcode === 1401) {
      return { ok: false, detail: `协议端拒绝：token 不对（HTTP ${res.status}）。检查 SnowLuma 的 access token。` };
    }
    if (!res.ok || json?.status !== 'ok') {
      return { ok: false, detail: `协议端返回异常：HTTP ${res.status} ${String(json?.wording || '').slice(0, 60)}` };
    }
    return { ok: true, detail: `已连上协议端（登录号 ${json.data?.user_id ?? '?'}）` };
  } catch (error) {
    return { ok: false, detail: `连不上协议端 ${url}：${String(error?.cause?.code || error?.message || error).slice(0, 80)}` };
  }
}

/**
 * 调一个 OneBot action（协议端 HTTP 透传）。
 * 列表接口失败要明确区分"token 错"和"网络不通" —— 这两种原因的修法完全不同。
 */
export async function callAction(action, params = {}, { timeoutMs = 30000 } = {}) {
  const { url, token, error } = endpoint();
  if (!url) throw new Error(error || '未配置协议端地址');
  let res;
  try {
    res = await fetch(`${url}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(params ?? {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    throw new Error(`连不上协议端（${String(err?.cause?.code || err?.message || err).slice(0, 60)}）`);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  if (res.status === 401 || json?.retcode === 1401) {
    throw new Error('协议端拒绝了请求：access token 不对（去 SnowLuma 配置里核对）');
  }
  if (!json) throw new Error(`协议端返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  if (json.status !== 'ok' && json.retcode !== 0) {
    throw new Error(`协议端返回失败：retcode=${json.retcode} ${String(json.wording || '').slice(0, 80)}`);
  }
  return json.data;
}

/** 发一条群消息（消息段数组）。 */
export async function sendGroupMessage(groupId, message, { timeoutMs = 30000 } = {}) {
  const gid = Number(String(groupId).trim());
  if (!Number.isInteger(gid) || gid <= 0) throw new Error(`群号不合法：${groupId}`);
  return callAction('send_group_msg', { group_id: gid, message }, { timeoutMs });
}

/** 发一条私聊消息（消息段数组）。 */
export async function sendPrivateMessage(userId, message, { timeoutMs = 30000 } = {}) {
  const uid = Number(String(userId).trim());
  if (!Number.isInteger(uid) || uid <= 0) throw new Error(`QQ 号不合法：${userId}`);
  return callAction('send_private_msg', { user_id: uid, message }, { timeoutMs });
}

/** 纯文字段。 */
export function textSegment(text) {
  return { type: 'text', data: { text: String(text ?? '') } };
}

/** 图片段（base64 内联，data URL 或裸 base64 都接受）。 */
export function imageSegment(dataUrlOrBase64, { asDataUrl = true } = {}) {
  const raw = String(dataUrlOrBase64 ?? '');
  const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
  if (!base64) throw new Error('图片数据为空');
  return { type: 'image', data: { file: asDataUrl ? `base64://${base64}` : base64 } };
}
