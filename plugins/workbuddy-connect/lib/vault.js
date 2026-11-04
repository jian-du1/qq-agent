/**
 * vault.js —— WorkBuddy 账号凭据：找、验、续期、缓存。
 *
 * 凭据来源有两个（都不需要用户做任何操作）：
 *   1. 本机已登录的 WorkBuddy 桌面端 / DSH 插件留下的凭据库：
 *        ~/.dsh/workbuddy-vault/<region>/<accountId>.json
 *      结构 { version, accountId, refreshedAtMs, auth:{ accessToken, refreshToken,
 *             expiresAt, refreshExpiresAt, lastRefreshTime, domain } }
 *   2. 本插件自己续期后的缓存（因为续期会轮换 refreshToken，而那条链只归我们维护）：
 *        <DATA_DIR>/workbuddy-connect-auth.json
 *
 * 只读第 1 个来源、只写自己的缓存 —— 不去改 DSH 插件的文件，两个插件可以共存。
 * accessToken 是 JWT，exp 字段就是过期时间；过期前 5 分钟主动续期。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 两个区域：账号与额度互不相通，请求头、来源域名、配置接口路径都不同。 */
export const REGIONS = {
  cn: {
    id: 'cn',
    label: '国内版',
    chatBase: 'https://copilot.tencent.com',
    origin: 'https://www.codebuddy.cn',
  },
  global: {
    id: 'global',
    label: '国际版',
    chatBase: 'https://www.workbuddy.ai',
    origin: 'https://www.workbuddy.ai',
  },
};

/** 客户端身份头：上游按 UA 区分「官方客户端」和「随便什么脚本」。 */
const PRODUCT_UA = 'WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0';
const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';

/** 距过期多久就续期（秒）。 */
const REFRESH_AHEAD_SEC = 300;

function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function accountLabel(account) {
  const jwt = account?.jwt ?? {};
  const nickname = String(jwt.nickname ?? jwt.preferred_username ?? '').trim();
  const uin = String(jwt.uin ?? jwt.phone_number ?? '').trim();
  return nickname || uin || String(account?.accountId ?? '').slice(0, 8);
}

function commonHeaders(region) {
  return {
    accept: 'application/json, text/plain, */*',
    'x-requested-with': 'XMLHttpRequest',
    origin: region.origin,
    referer: `${region.origin}/`,
    // 续期和配置接口用 CLI 身份（与上游 DSH 插件实测一致）
    'user-agent': CLIENT_UA,
  };
}

/** 对话类请求头：缺一个都可能被判成非官方客户端。 */
export function chatHeaders(region, token, opts = {}) {
  const headers = {
    ...commonHeaders(region),
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
  // 没有企业/部门信息时，用「明确声明没有」的头，而不是留着缺省
  headers['x-no-enterprise-id'] = '1';
  headers['x-no-department-info'] = '1';
  headers['x-product'] = 'SaaS';
  headers['x-conversation-id'] = opts.conversationId ?? cryptoRandomId();
  headers['x-conversation-request-id'] = opts.requestId ?? cryptoRandomId();
  headers['x-conversation-message-id'] = opts.messageId ?? cryptoRandomId();
  if (opts.accountId) headers['x-user-id'] = String(opts.accountId);
  else headers['x-no-user-id'] = '1';
  return headers;
}

function cryptoRandomId() {
  return globalThis.crypto?.randomUUID?.() ?? `wb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 扫描本机凭据库。返回每个区域下第一个可用账号（按文件修改时间新的优先）。
 * @param {string} [vaultRoot]
 */
export function scanVault(vaultRoot) {
  const root = vaultRoot || path.join(os.homedir(), '.dsh', 'workbuddy-vault');
  const found = [];
  for (const region of Object.values(REGIONS)) {
    const dir = path.join(root, region.id);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      continue;
    }
    const candidates = [];
    for (const name of files) {
      const file = path.join(dir, name);
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const auth = data?.auth ?? {};
        const token = String(auth.accessToken ?? '');
        if (token === '') continue;
        const jwt = decodeJwtPayload(token) ?? {};
        const exp = Number(auth.expiresAt) || Number(jwt.exp) || 0;
        candidates.push({
          region,
          accountId: String(data?.accountId ?? jwt.sub ?? name.replace(/\.json$/, '')),
          file,
          token,
          refreshToken: String(auth.refreshToken ?? ''),
          exp,
          refreshedAtMs: Number(data?.refreshedAtMs) || 0,
          jwt,
          label: accountLabel({ jwt, accountId: data?.accountId }),
        });
      } catch {
        // 坏文件跳过，不影响别的账号
      }
    }
    candidates.sort((a, b) => b.exp - a.exp || b.refreshedAtMs - a.refreshedAtMs);
    if (candidates.length) found.push({ region, accounts: candidates });
  }
  return found;
}

/**
 * 凭据管理：负责「拿到一个当前有效的 accessToken」。
 * 内部状态只有内存 + 一个缓存文件；失败时给出人能看懂的中文原因。
 */
export class CredentialStore {
  /**
   * @param {object} deps
   * @param {string} deps.cacheDir 本插件的数据目录（DATA_DIR）
   * @param {string} [deps.vaultRoot] 覆盖凭据库位置（一般不用）
   * @param {(msg: string) => void} [deps.log]
   * @param {() => number} [deps.now]
   */
  constructor({ cacheDir, vaultRoot, log = () => {}, now = () => Date.now() } = {}) {
    this.cacheFile = path.join(cacheDir, 'workbuddy-connect-auth.json');
    this.vaultRoot = vaultRoot;
    this.log = log;
    this.now = now;
    /** regionId → {accountId, token, refreshToken, exp, label} */
    this.accounts = new Map();
    /** regionId → 正在进行的续期 Promise，避免并发刷新把 refreshToken 用废 */
    this.refreshing = new Map();
    this.cacheDir = cacheDir;
  }

  /** 读缓存文件 + 扫描凭据库，构造内存里的账号表。 */
  load() {
    this.accounts.clear();
    let cache = {};
    try {
      cache = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) ?? {};
    } catch {
      cache = {};
    }
    for (const entry of scanVault(this.vaultRoot)) {
      const cached = cache?.regions?.[entry.region.id];
      // 缓存里的账号仍与凭据库存的是同一个账号时，优先用缓存（它的 refreshToken 才是最新的）
      const pick =
        cached && cached.accountId && cached.accountId === entry.accounts[0].accountId
          ? { ...entry.accounts[0], token: cached.accessToken || entry.accounts[0].token, refreshToken: cached.refreshToken || entry.accounts[0].refreshToken, exp: Number(cached.expiresAt) || entry.accounts[0].exp }
          : entry.accounts[0];
      this.accounts.set(entry.region.id, pick);
    }
    return this.accounts;
  }

  saveCache() {
    const regions = {};
    for (const [id, account] of this.accounts) {
      regions[id] = {
        accountId: account.accountId,
        accessToken: account.token,
        refreshToken: account.refreshToken,
        expiresAt: account.exp,
        savedAt: this.now(),
      };
    }
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(
        this.cacheFile,
        JSON.stringify({ version: 1, regions }, null, 2),
        { mode: 0o600 },
      );
    } catch (error) {
      this.log(`保存账号缓存失败（不影响本次对话）：${error?.message ?? error}`);
    }
  }

  /** 当前可用的区域列表（只判断「有没有账号」，不判断有效性）。 */
  availableRegions() {
    return [...this.accounts.keys()];
  }

  /** 取某个区域的账号（不刷新）。 */
  account(regionId) {
    return this.accounts.get(regionId) ?? null;
  }

  /** 该账号的 token 是否快过期/已过期。 */
  needsRefresh(account) {
    if (!account) return true;
    if (!account.token) return true;
    if (!account.exp) return false; // 没有 exp 信息，先当有效，失败后自然会走续期/报错
    return account.exp * 1000 - this.now() < REFRESH_AHEAD_SEC * 1000;
  }

  /**
   * 拿一个当前有效的 token；必要时续期。
   * @param {string} regionId
   * @returns {Promise<{token: string, account: object, region: object}>}
   */
  async ensureToken(regionId) {
    const region = REGIONS[regionId];
    if (!region) throw new Error(`未知区域：${regionId}`);
    const account = this.account(regionId);
    if (!account) {
      throw new Error(
        `没有找到${region.label}的 WorkBuddy 登录凭据（不需要本插件做什么：先用 WorkBuddy 客户端登录一次即可，凭据会自动落进 ~/.dsh/workbuddy-vault/${regionId}/）。`,
      );
    }
    if (!this.needsRefresh(account) && account.token) return { token: account.token, account, region };
    const token = await this.refresh(regionId);
    return { token, account, region };
  }

  /**
   * 用 refreshToken 续期。refreshToken 会轮换，所以成功后立刻写回缓存。
   * 并发调用共享同一个 Promise，避免同一 refreshToken 被用两次而作废。
   */
  refresh(regionId) {
    const inFlight = this.refreshing.get(regionId);
    if (inFlight) return inFlight;
    const task = this.#refreshWithHeal(regionId).finally(() => this.refreshing.delete(regionId));
    this.refreshing.set(regionId, task);
    return task;
  }

  /**
   * 续期失败时先回读一次凭据库再试：WorkBuddy 桌面端或 DSH 的 WorkBuddy 插件
   * 可能刚刷新过同一个账号，refreshToken 已经轮换，我们缓存里那份自然作废。
   */
  async #refreshWithHeal(regionId) {
    const before = this.account(regionId)?.refreshToken ?? '';
    try {
      return await this.#doRefresh(regionId);
    } catch (error) {
      const fresh = this.#rereadFromVault(regionId);
      if (fresh && fresh.refreshToken && fresh.refreshToken !== before) {
        this.log(
          `${REGIONS[regionId].label}凭据库里的 refreshToken 已更新（可能被 WorkBuddy 客户端或 DSH 插件刷新过），用新的再试一次`,
        );
        return await this.#doRefresh(regionId);
      }
      throw error;
    }
  }

  /** 不信缓存，重新从凭据库读某个区域的最新账号并换上。 */
  #rereadFromVault(regionId) {
    const entry = scanVault(this.vaultRoot).find((item) => item.region.id === regionId);
    const latest = entry?.accounts?.[0];
    if (!latest) return null;
    this.accounts.set(regionId, latest);
    return latest;
  }

  async #doRefresh(regionId) {
    const region = REGIONS[regionId];
    const account = this.account(regionId);
    if (!account) throw new Error(`没有找到${region.label}的 WorkBuddy 登录凭据`);
    if (!account.refreshToken) {
      throw new Error(`${region.label}的 WorkBuddy 登录凭据已过期，且没有可续期的 refreshToken。打开 WorkBuddy 客户端重新登录一次即可。`);
    }
    const url = `${region.chatBase}/v2/plugin/auth/token/refresh`;
    const headers = {
      ...commonHeaders(region),
      'content-type': 'application/json',
      'x-refresh-token': account.refreshToken,
      'x-auth-refresh-source': 'workbuddy',
      'user-agent': CLIENT_UA,
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let response;
    try {
      response = await fetch(url, { method: 'POST', headers, body: '{}', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    const code = Number(data?.code);
    const payload = data?.data ?? {};
    const newToken = String(payload.accessToken ?? '');
    if (!response.ok || (Number.isFinite(code) && code !== 0) || newToken === '') {
      const detail = String(data?.msg ?? text ?? '').slice(0, 200);
      throw new Error(
        `${region.label} WorkBuddy 登录续期失败（HTTP ${response.status}${Number.isFinite(code) ? `，业务码 ${code}` : ''}）：${detail || '上游没有返回原因'}。打开 WorkBuddy 客户端重新登录一次即可恢复。`,
      );
    }
    const jwt = decodeJwtPayload(newToken) ?? {};
    account.token = newToken;
    if (payload.refreshToken) account.refreshToken = String(payload.refreshToken);
    const expiresAt = Number(jwt.exp) || Math.floor((this.now() + 3600 * 1000) / 1000);
    account.exp = expiresAt;
    account.jwt = jwt;
    this.accounts.set(regionId, account);
    this.saveCache();
    this.log(`${region.label} WorkBuddy 登录已续期（账号 ${account.label || account.accountId.slice(0, 8)}）`);
    return newToken;
  }

  /** 供状态页展示：每个区域的账号与到期时间（不返回 token 本身）。 */
  describe() {
    const out = [];
    for (const [id, account] of this.accounts) {
      const region = REGIONS[id];
      out.push({
        region: id,
        regionLabel: region?.label ?? id,
        account: account.label || account.accountId,
        expiresAt: account.exp ? new Date(account.exp * 1000).toISOString() : null,
        source: account.file,
      });
    }
    return out;
  }
}
