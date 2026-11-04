// 纯 Node 的加密 ZIP 打包器（零依赖）。
//
// 为什么自己写：这机器上没有 7-Zip / WinRAR / Bandizip，项目 node_modules 里也没有 zip 库。
// 为什么选 ZipCrypto 而不是 AES：
//   · ZipCrypto 是传统 ZIP 加密，**Windows 资源管理器双击就能输密码解压**，7-Zip/WinRAR/
//     Bandizip/手机解压软件全兼容 —— 群友拿到就能开；
//   · AES-256 需要 WinZip AE-x 规范，Win10 自带解压打不开，群友大概率卡在"文件损坏"。
// 代价：ZipCrypto 强度不高（可被已知明文攻击），适合"防手滑/防随手转发"，不适合存机密。
//
// 实现取舍：
//   · 只用 STORE（不压缩）。PDF/JPEG 本身已压缩，deflate 收益通常 1~3%，却要多占一倍的
//     内存/一遍 IO；这里按 1MB 分块流式处理，几百 MB 的整本 PDF 也不会把内存吃爆。
//   · 先扫一遍算 CRC32（ZIP 头要求 CRC 在数据之前），再写第二遍。两遍都是流式。
//   · 中文密码：按 UTF-8 取字节，7-Zip/WinRAR/Bandizip 能正确解；但 Windows 资源管理器
//     对非 ASCII 密码可能按 ANSI 处理而解不开，所以设置项里提示"建议用字母数字"。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* ───────────────────────── CRC32 ───────────────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC32 单步（不做最终取反）—— ZipCrypto 的密钥更新也用它。 */
function crcStep(crc, byte) {
  return (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;
}

function crcInit() {
  return 0xffffffff;
}

function crcFinal(crc) {
  return (crc ^ 0xffffffff) >>> 0;
}

/* ───────────────────── ZipCrypto 加密器 ───────────────────── */

function makeCipher(password) {
  const pw = Buffer.from(String(password || ''), 'utf8');
  let k0 = 0x12345678;
  let k1 = 0x23456789;
  let k2 = 0x34567890;
  const update = (byte) => {
    k0 = crcStep(k0, byte);
    k1 = (Math.imul((k1 + (k0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    k2 = crcStep(k2, (k1 >>> 24) & 0xff);
  };
  for (const b of pw) update(b);
  return {
    update,
    streamByte() {
      const t = (k2 | 2) & 0xffff;
      return ((Math.imul(t, t ^ 1) >>> 8) & 0xff);
    },
    /** 原地加密一块数据（调用方已把 block 复制出来）。 */
    encrypt(block) {
      for (let i = 0; i < block.length; i += 1) {
        const p = block[i];
        block[i] = p ^ this.streamByte();
        update(p);
      }
      return block;
    },
  };
}

/* ───────────────────────── 小工具 ───────────────────────── */

function dosDateTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}

function writeChunk(stream, buf) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { stream.removeListener('error', onError); reject(e); };
    stream.once('error', onError);
    const ok = stream.write(buf, () => { stream.removeListener('error', onError); resolve(); });
    // ok=false 时 write 回调仍会在 flush 后触发，所以这里不用额外处理 drain
    void ok;
  });
}

/** 一遍读完：算 CRC32 + 字节数（ZIP 头要求先有 CRC）。 */
function scanFile(filePath, chunkSize = 1 << 20) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let crc = crcInit();
    let size = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkSize, null);
      if (n <= 0) break;
      for (let i = 0; i < n; i += 1) crc = crcStep(crc, buf[i]);
      size += n;
    }
    return { crc: crcFinal(crc), size };
  } finally {
    fs.closeSync(fd);
  }
}

/** 第二遍：流式写数据（必要时逐字节加密）。
 *  ⚠️ 必须走调用方给的 writeFn（它负责累计 offset）——2026-10-23 踩过：
 *  直接 stream.write 会让 offset 少算数据段的字节，中央目录里的 local header
 *  offset 全错，解压时报 "Bad magic number for file header"。 */
async function writeFileData(writeFn, filePath, cipher, chunkSize = 1 << 20) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkSize, null);
      if (n <= 0) break;
      const slice = Buffer.from(buf.subarray(0, n)); // 复制：加密会原地改
      if (cipher) cipher.encrypt(slice);
      await writeFn(slice);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/* ───────────────────────── 主入口 ───────────────────────── */

/**
 * 把若干文件打成一个 zip（可选密码）。
 *
 * @param {object} opts
 * @param {string} opts.outPath      输出 .zip 路径（已存在会被覆盖）
 * @param {Array<{filePath:string, entryName?:string}>} opts.entries 要打包的文件
 * @param {string} [opts.password]   留空 = 不加密
 * @param {Date}   [opts.mtime]      条目时间（默认取文件 mtime）
 * @returns {Promise<{ok:boolean, outPath?:string, bytes?:number, encrypted?:boolean, entries?:number, error?:string}>}
 */
export async function createZip({ outPath, entries, password = '', mtime = null }) {
  const list = (Array.isArray(entries) ? entries : [])
    .map((e) => ({ filePath: String(e?.filePath || ''), entryName: String(e?.entryName || '') }))
    .filter((e) => e.filePath);
  if (!list.length) return { ok: false, error: '没有要打包的文件' };
  if (!outPath) return { ok: false, error: '没有输出路径' };

  for (const e of list) {
    if (!fs.existsSync(e.filePath)) return { ok: false, error: `文件不存在：${e.filePath}` };
    if (!e.entryName) e.entryName = path.basename(e.filePath);
    // 条目名统一用 / 分隔（ZIP 规范）
    e.entryName = e.entryName.split(path.sep).join('/');
  }

  const pwd = String(password || '');
  const encrypted = pwd.length > 0;

  // 先算好所有条目的 CRC / 大小 / 时间（写头需要）
  const prepared = [];
  for (const e of list) {
    const { crc, size } = scanFile(e.filePath);
    let stamp = mtime;
    if (!stamp) {
      try { stamp = fs.statSync(e.filePath).mtime; } catch { stamp = new Date(); }
    }
    prepared.push({ ...e, crc, size, ...dosDateTime(stamp) });
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmpPath = `${outPath}.part`;
  const stream = fs.createWriteStream(tmpPath, { flags: 'w' });
  const central = [];
  let offset = 0;

  const write = async (buf) => {
    offset += buf.length;
    await writeChunk(stream, buf);
  };

  try {
    for (const e of prepared) {
      const nameBuf = Buffer.from(e.entryName, 'utf8');
      const needsUtf8 = /[^\x00-\x7f]/.test(e.entryName);
      // bit0 = 加密，bit11 = 文件名是 UTF-8
      const flags = (encrypted ? 0x0001 : 0) | (needsUtf8 ? 0x0800 : 0);
      const method = 0; // STORE
      const csize = e.size + (encrypted ? 12 : 0);
      const localOffset = offset;

      const header = Buffer.concat([
        u32(0x04034b50),
        u16(20),          // version needed
        u16(flags),
        u16(method),
        u16(e.time),
        u16(e.date),
        u32(e.crc),
        u32(csize),
        u32(e.size),
        u16(nameBuf.length),
        u16(0),
        nameBuf,
      ]);
      await write(header);

      if (encrypted) {
        // 12 字节加密头：11 字节随机 + 1 字节校验（CRC 最高字节）
        const cipher = makeCipher(pwd);
        const head = crypto.randomBytes(11);
        const check = (e.crc >>> 24) & 0xff;
        const plain = Buffer.concat([head, Buffer.from([check])]);
        await write(cipher.encrypt(Buffer.from(plain)));
        await writeFileData(write, e.filePath, cipher);
      } else {
        await writeFileData(write, e.filePath, null);
      }

      central.push({
        nameBuf, flags, method, time: e.time, date: e.date,
        crc: e.crc, csize, size: e.size, localOffset,
      });
    }

    // 中央目录
    const cdStart = offset;
    for (const c of central) {
      await write(Buffer.concat([
        u32(0x02014b50),
        u16(20),          // version made by
        u16(20),          // version needed
        u16(c.flags),
        u16(c.method),
        u16(c.time),
        u16(c.date),
        u32(c.crc),
        u32(c.csize),
        u32(c.size),
        u16(c.nameBuf.length),
        u16(0),           // extra len
        u16(0),           // comment len
        u16(0),           // disk start
        u16(0),           // internal attrs
        u32(0),           // external attrs
        u32(c.localOffset),
        c.nameBuf,
      ]));
    }
    const cdSize = offset - cdStart;

    await write(Buffer.concat([
      u32(0x06054b50),
      u16(0), u16(0),
      u16(central.length), u16(central.length),
      u32(cdSize), u32(cdStart),
      u16(0),
    ]));

    await new Promise((resolve, reject) => {
      stream.end((err) => (err ? reject(err) : resolve()));
    });
    fs.renameSync(tmpPath, outPath);

    return {
      ok: true,
      outPath,
      bytes: fs.statSync(outPath).size,
      encrypted,
      entries: central.length,
    };
  } catch (error) {
    try { stream.destroy(); } catch { /* ignore */ }
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return { ok: false, error: `打包失败：${error?.message ?? error}` };
  }
}

/* ─────────────────── 文件名构造（含 Windows 非法字符清洗） ─────────────────── */

/**
 * 生成压缩包文件名：`JM<id>-密码：<pwd>.zip`，关闭同步密码时为 `JM<id>.zip`。
 *
 * ⚠️ Windows 文件名不允许 `: \ / * ? " < > |`，而用户要求的格式里带「密码:」，
 *    所以半角冒号会被换成全角「：」（视觉一致、合法）。密码里其它非法字符也会被替换。
 */
export function buildZipName(albumId, { password = '', includePassword = false } = {}) {
  const id = String(albumId ?? '').replace(/[^\w-]/g, '') || 'unknown';
  const pwd = String(password || '');
  if (!includePassword || !pwd) return `JM${id}.zip`;
  const safePwd = pwd
    .replace(/[:\\/*?"<>|]/g, (ch) => (ch === ':' ? '：' : '_'))
    .replace(/[\r\n\t]+/g, '')
    .slice(0, 40);
  return `JM${id}-密码：${safePwd}.zip`;
}

/** 文件名里是否含 Windows 不允许的字符（给设置页提示用）。 */
export function hasIllegalNameChars(text) {
  return /[:\\/*?"<>|]/.test(String(text || ''));
}
