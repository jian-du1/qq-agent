import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';

export const LIMITS = Object.freeze({ zipBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, files: 100 });
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const BANNED_EXT = /\.(exe|dll|bat|cmd|ps1|vbs|sh)$/i;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
let crcTable;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let i = 0; i < 8; i++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buffer) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function safeName(raw) {
  const name = raw.replace(/\\/g, '/');
  if (!name || name.startsWith('/') || /[\x00-\x1f<>:"|?*]/.test(name)) throw new Error('安装包包含非法路径：' + name);
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((s) => !s || s === '.' || s === '..' || /[. ]$/.test(s) || RESERVED.test(s))) {
    throw new Error('安装包包含不安全或不兼容的路径：' + name);
  }
  if (BANNED_EXT.test(name)) throw new Error('安装包包含禁止的文件类型：' + name);
  return name;
}

// Parse ZIP without executing any of its contents. Bound inflate output before allocating it.
export function readPluginZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > LIMITS.zipBytes) {
    throw new Error('安装包不是有效 ZIP，或超过 8MB');
  }
  const range = (off, size) => {
    if (!Number.isInteger(off) || off < 0 || size < 0 || off + size > buffer.length) throw new Error('ZIP 文件截断或结构损坏');
  };
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 ZIP 目录');
  const count = buffer.readUInt16LE(eocd + 10);
  if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6) || count !== buffer.readUInt16LE(eocd + 8)) {
    throw new Error('不支持分卷 ZIP');
  }
  if (!count || count > 200 || count === 65535) throw new Error('ZIP 条目数量异常');
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdStart = buffer.readUInt32LE(eocd + 16);
  range(cdStart, cdSize);
  if (cdStart + cdSize !== eocd) throw new Error('不支持 ZIP64 或异常的 ZIP 目录');
  const files = [];
  const seen = new Set();
  let total = 0;
  let pos = cdStart;
  for (let i = 0; i < count; i++) {
    range(pos, 46);
    if (buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('ZIP 目录条目损坏');
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const crc = buffer.readUInt32LE(pos + 16);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const rawSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const mode = (buffer.readUInt32LE(pos + 38) >>> 16) & 0xf000;
    const local = buffer.readUInt32LE(pos + 42);
    range(pos + 46, nameLen + extraLen + commentLen);
    if (pos + 46 + nameLen + extraLen + commentLen > eocd) throw new Error('ZIP 目录越界');
    if (flags & 1) throw new Error('不支持加密 ZIP');
    if (mode === 0xa000) throw new Error('安装包不能包含符号链接');
    if (method !== 0 && method !== 8) throw new Error('不支持这种 ZIP 压缩方式');
    const rawName = buffer.subarray(pos + 46, pos + 46 + nameLen);
    const name = safeName(rawName.toString('utf8'));
    const unique = name.replace(/\/$/, '').toLowerCase();
    if (seen.has(unique)) throw new Error('ZIP 包含重名路径：' + name);
    seen.add(unique);
    range(local, 30);
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP 文件头损坏');
    const localNameLen = buffer.readUInt16LE(local + 26);
    const localExtraLen = buffer.readUInt16LE(local + 28);
    range(local + 30, localNameLen + localExtraLen);
    if (!buffer.subarray(local + 30, local + 30 + localNameLen).equals(rawName)) throw new Error('ZIP 文件头与目录中的路径不一致');
    if (buffer.readUInt16LE(local + 8) !== method || buffer.readUInt16LE(local + 6) !== flags) throw new Error('ZIP 文件头与目录中的压缩参数不一致');
    const start = local + 30 + localNameLen + localExtraLen;
    range(start, compressedSize);
    if (start + compressedSize > cdStart) throw new Error('ZIP 数据与目录重叠');
    if (!name.endsWith('/')) {
      total += rawSize;
      if (total > LIMITS.totalBytes || files.length >= LIMITS.files) throw new Error('安装包超过 100 个文件或解压后超过 32MB');
      const raw = buffer.subarray(start, start + compressedSize);
      const data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(1, rawSize) });
      if (data.length !== rawSize || crc32(data) !== crc) throw new Error('ZIP 文件校验失败：' + name);
      files.push({ name, data });
    } else if (rawSize !== 0) throw new Error('ZIP 目录条目包含数据');
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (pos !== eocd || !files.length) throw new Error('ZIP 目录异常或安装包为空');
  return files;
}

export function inspectExtensionPackage(buffer, expected = {}) {
  const files = readPluginZip(buffer);
  // Locate the manifest rather than stripping exactly one directory level.
  const candidates = files.filter((f) => /(^|\/)(plugin|skill)\.json$/.test(f.name));
  if (candidates.length !== 1) throw new Error('安装包必须包含唯一一个扩展清单，不能混装多个扩展');
  const manifestFile = candidates[0];
  const kind = manifestFile.name.endsWith('plugin.json') ? 'plugin' : 'skill';
  const label = kind === 'plugin' ? '插件' : '技能';
  if (expected.type && expected.type !== kind) throw new Error('这是' + label + '包，与市场条目类型不一致');
  let manifest;
  try { manifest = JSON.parse(manifestFile.data.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error(kind + '.json 不是有效的 UTF-8 JSON'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !ID_RE.test(manifest.id || '')
    || RESERVED.test(manifest.id) || /[. ]$/.test(manifest.id)) {
    throw new Error('扩展清单缺少有效 id');
  }
  if (Number(manifest.apiVersion || 1) !== 1) throw new Error('扩展需要不支持的 API 版本');
  if (expected.id && manifest.id !== expected.id) throw new Error('安装包 id 与市场校验结果不一致');
  if (expected.version && String(manifest.version || '') !== String(expected.version)) throw new Error('安装包版本与市场校验结果不一致，请刷新后重试');
  const slash = manifestFile.name.lastIndexOf('/');
  const prefix = slash < 0 ? '' : manifestFile.name.slice(0, slash + 1);
  const selected = files.filter((f) => f.name.startsWith(prefix)).map((f) => ({ name: f.name.slice(prefix.length), data: f.data }));
  if (!selected.some((f) => f.name === 'index.js')) throw new Error(label + '目录缺少 index.js');
  for (const file of selected) {
    if (file.name.split('/').some((s) => s === 'node_modules' || s === 'data') || file.name === 'entry.json') {
      throw new Error('扩展目录包含不应随扩展安装的文件：' + file.name);
    }
  }
  const omitted = files.filter((f) => !f.name.startsWith(prefix));
  // Outer wrapper may contain readme/images/metadata, but never another executable component.
  if (omitted.some((f) => /\.(js|mjs|cjs|json)$/i.test(f.name) && !/^(?:.*\/)?(?:entry|package)\.json$/i.test(f.name))) {
    throw new Error('包装目录外存在代码，无法安全判断完整扩展范围');
  }
  return {
    kind,
    manifest,
    files: selected,
    nestingDepth: prefix ? prefix.split('/').filter(Boolean).length : 0,
    omittedFiles: omitted.length,
    totalBytes: selected.reduce((sum, f) => sum + f.data.length, 0)
  };
}

export function inspectPluginPackage(buffer, expected = {}) {
  return inspectExtensionPackage(buffer, { ...expected, type: expected.type || 'plugin' });
}

export function findInstalledPlugin(pluginsDir, id) {
  if (!fs.existsSync(pluginsDir)) return '';
  for (const entry of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(pluginsDir, entry.name);
    for (const name of ['skill.json', 'plugin.json']) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8').replace(/^\uFEFF/, ''));
        if (manifest.id === id) return dir;
      } catch { /* Not an installed manifest. */ }
    }
  }
  return '';
}

function assertChild(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('目标目录越界');
}

export function installInspectedExtension(inspected, { pluginsDir, skillsDir, stagingDir }) {
  const kind = inspected.kind || 'plugin';
  const modulesDir = kind === 'skill' ? skillsDir : kind === 'plugin' ? pluginsDir : null;
  if (!modulesDir) throw new Error('扩展安装目录或类型不正确');
  const id = inspected.manifest.id;
  if (!ID_RE.test(id) || RESERVED.test(id) || /[. ]$/.test(id)) throw new Error('扩展 id 不合法');
  const alreadyInstalled = () => [pluginsDir, skillsDir].some((dir) => dir && findInstalledPlugin(dir, id));
  fs.mkdirSync(modulesDir, { recursive: true });
  if (alreadyInstalled()) throw new Error('已安装同 id 扩展，请到原有技能或插件页管理');
  const target = path.resolve(modulesDir, id);
  assertChild(modulesDir, target);
  if (fs.existsSync(target)) throw new Error('同名目录已经存在，未覆盖任何文件');
  fs.mkdirSync(stagingDir, { recursive: true });
  const stage = path.resolve(stagingDir, 'package-' + randomUUID());
  assertChild(stagingDir, stage);
  fs.mkdirSync(stage);
  try {
    for (const f of inspected.files) {
      const dest = path.resolve(stage, ...f.name.split('/'));
      assertChild(stage, dest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.data, { flag: 'wx' });
    }
    // Recheck after staging, then publish the complete directory in one same-volume rename.
    if (fs.existsSync(target) || alreadyInstalled()) throw new Error('扩展已被另一次操作安装，请刷新列表');
    fs.renameSync(stage, target);
    return { kind, id, dir: target, nestingDepth: inspected.nestingDepth, fileCount: inspected.files.length };
  } catch (error) {
    assertChild(stagingDir, stage);
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

export function installInspectedPlugin(inspected, options) {
  if (inspected.kind && inspected.kind !== 'plugin') throw new Error('这不是插件包');
  return installInspectedExtension(inspected, options);
}
