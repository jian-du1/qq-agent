import { LIMITS } from './plugin-package.js?v=0.3.0';

export function marketKind(value = 'plugin') {
  if (!['plugin', 'skill', 'persona'].includes(value)) throw new Error('不支持的市场类型');
  return value;
}

export function marketBase(value) {
  const url = new URL(value || 'https://www.kondius.cn/api/community');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('市场接口地址必须是没有账号信息的 HTTPS 地址');
  return url.href.replace(/\/+$/, '');
}

export async function readBounded(response, maxBytes) {
  if (!response.ok) throw new Error('市场服务返回 HTTP ' + response.status);
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('市场响应超过大小限制');
  }
  if (!response.body) throw new Error('市场响应没有内容');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('市场响应超过大小限制');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

export async function marketJson(fetcher, base, route, options = {}, maxBytes = 2 * 1024 * 1024) {
  const response = await fetcher(base + route, { ...options, signal: AbortSignal.timeout(30000), redirect: 'error' });
  const buffer = await readBounded(response, maxBytes);
  let data;
  try { data = JSON.parse(buffer.toString('utf8')); } catch { throw new Error('市场返回了无法识别的数据'); }
  if (data.ok === false) throw new Error(String(data.error || '市场请求失败').slice(0, 300));
  return data;
}

function downloadCount(value) {
  const count = typeof value === 'number' || typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(count) && count > 0 ? Math.min(Math.floor(count), Number.MAX_SAFE_INTEGER) : 0;
}

export function marketExtensions(data, kind = 'plugin') {
  if (!['plugin', 'skill'].includes(kind)) throw new Error('扩展类型不正确');
  if (!Array.isArray(data?.items)) throw new Error('市场列表格式已变化，请使用外部市场');
  const seen = new Set();
  return data.items
    .filter((x) => x && x.type === kind && (!x.status || x.status === 'approved')
      && /^[A-Z0-9]{4,12}$/.test(x.installCode || '') && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(x.id || ''))
    .sort((a, b) => (Date.parse(b.updatedAt || b.createdAt) || 0) - (Date.parse(a.updatedAt || a.createdAt) || 0))
    .filter((x) => { if (seen.has(x.id)) return false; seen.add(x.id); return true; })
    .map((x) => ({
      type: kind,
      id: x.id, name: String(x.name || x.id).slice(0, 160), version: String(x.version || '').slice(0, 40),
      author: String(x.author || '社区作者').slice(0, 80), category: String(x.category || 'utility').slice(0, 40),
      categoryName: String(x.categoryName || data.categories?.[x.category] || '工具').slice(0, 40),
      description: String(x.description || '暂无介绍').slice(0, 8000),
      updatedAt: String(x.updatedAt || x.createdAt || ''), installCode: x.installCode,
      downloads: downloadCount(x.downloads)
    }));
}

export function marketPlugins(data) { return marketExtensions(data, 'plugin'); }

export function marketPersonas(data) {
  if (!Array.isArray(data?.items)) throw new Error('人设列表格式已变化，请使用外部市场');
  const seen = new Set();
  const categories = { companion: '陪伴型', roleplay: '角色扮演', utility: '实用助手', custom: '自定义' };
  return data.items
    .filter((x) => x && (!x.status || x.status === 'approved') && typeof x.title === 'string' && x.title.trim()
      && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(x.id || '') && x.hasPrompt !== false
      && (x.hasPrompt === true || (typeof x.prompt === 'string' && x.prompt.trim())))
    .sort((a, b) => (Date.parse(b.updatedAt || b.createdAt) || 0) - (Date.parse(a.updatedAt || a.createdAt) || 0))
    .filter((x) => { if (seen.has(x.id)) return false; seen.add(x.id); return true; })
    .map((x) => ({ type: 'persona', id: x.id, name: x.title.trim().slice(0, 120),
      author: String(x.author || '社区作者').slice(0, 80), category: String(x.category || 'custom').slice(0, 40),
      categoryName: categories[x.category] || '自定义', description: String(x.description || '社区分享的人设').slice(0, 8000),
      updatedAt: String(x.updatedAt || x.createdAt || '') }));
}

// Retained for the read-only sample probe; the market page uses the full catalog.
export function latestPlugins(data, limit = 6) {
  const safeLimit = Math.min(8, Math.max(1, Math.round(Number(limit) || 6)));
  return marketPlugins(data).slice(0, safeLimit);
}

export async function verifyExtension(fetcher, base, code, kind = 'plugin') {
  if (!['plugin', 'skill'].includes(kind)) throw new Error('扩展类型不正确');
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(normalized)) throw new Error('安装口令格式不正确');
  const data = await marketJson(fetcher, base, '/install/verify', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ codes: [normalized] })
  });
  const hit = data.results?.find((x) => x.code === normalized);
  if (!hit?.ok || hit.type !== kind || !hit.id) throw new Error('口令无效、未通过审核，或不是所选类型的扩展');
  return { ...hit, code: normalized };
}

export function verifyPlugin(fetcher, base, code) { return verifyExtension(fetcher, base, code, 'plugin'); }

export async function personaPreview(fetcher, base, id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id || '')) throw new Error('人设标识不正确');
  const data = await marketJson(fetcher, base, '/personas/' + encodeURIComponent(id) + '/prompt');
  if (data.ok !== true || data.item?.id !== id || (data.item.status && data.item.status !== 'approved')
    || typeof data.item.title !== 'string' || !data.item.title.trim()
    || typeof data.prompt !== 'string' || !data.prompt.trim() || data.prompt.length > 120000) {
    throw new Error('人设内容无效或已变化，请刷新后重试');
  }
  const originalName = data.item.title.trim().slice(0, 120);
  return { id, name: originalName.slice(0, 50), originalName, text: data.prompt.trim(),
    author: String(data.item.author || '社区作者').slice(0, 80) };
}

export async function downloadPlugin(fetcher, base, code) {
  const response = await fetcher(base + '/install/' + encodeURIComponent(code) + '/download', {
    signal: AbortSignal.timeout(120000), redirect: 'error'
  });
  return readBounded(response, LIMITS.zipBytes);
}
