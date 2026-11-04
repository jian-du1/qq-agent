// 图片压缩（发 QQ 前把几 MB 的原图压到不易被拦的体积）
//
// ── 为什么要自己写 ────────────────────────────────────────────────────────
// 项目的 src/image-compress.js 依赖**系统 ffmpeg**，而本机没有装（实测
// `ffmpeg -version` 找不到），那条路会静默地"原样返回不压缩"。
// 本插件跑在 Electron 主进程里，所以用 Electron 自带的 nativeImage 做解码与
// 缩放 —— 不依赖任何外部程序，也不需要额外依赖。
//
// ── 实测数据（COS 板块原图）───────────────────────────────────────────────
// 单张 1.5~3.9MB，分辨率最高 5951x3971。QQ 对大图有拦截/压缩风险，
// 所以默认压到最长边 1600px、JPEG 质量 88，通常落在 300~700KB。

import { getElectron, electronUnavailableReason } from './electron.mjs';

export function compressAvailable() {
  return Boolean(getElectron());
}

export function compressUnavailableReason() {
  const why = electronUnavailableReason();
  return why || '图片压缩引擎不可用';
}

/**
 * 压缩一张图片到指定体积以内。
 *
 * 策略（逐级降级，直到满足体积或试完所有组合）：
 *   1. 最长边缩到 maxDim，JPEG 质量 targetQuality
 *   2. 还超 → 依次降质量
 *   3. 还超 → 依次缩尺寸
 *   4. 全都超 → 返回最小的一次（宁可发一张较小的图，也不要发不出去）
 *
 * ⚠️ 只做"变小"：压完比原图还大就保留原图（小图重编码会变大，这是常见坑）。
 *
 * @param {Buffer} buffer 原始图片字节
 * @returns {{buffer:Buffer, mime:string, compressed:boolean, width:number, height:number,
 *            beforeBytes:number, afterBytes:number, note:string}}
 */
export function compressImage(buffer, {
  maxDim = 1600,
  targetBytes = 1_500_000,
  targetQuality = 88,
  minDim = 720
} = {}) {
  const beforeBytes = buffer.length;
  const fallback = {
    buffer, mime: 'image/jpeg', compressed: false, width: 0, height: 0,
    beforeBytes, afterBytes: beforeBytes, note: '未压缩'
  };

  const mod = getElectron();
  if (!mod) return { ...fallback, note: `未压缩（${compressUnavailableReason()}）` };

  let image;
  try {
    image = mod.nativeImage.createFromBuffer(buffer);
  } catch (error) {
    return { ...fallback, note: `解码失败：${error?.message ?? error}` };
  }
  if (!image || image.isEmpty()) return { ...fallback, note: '解码失败（空图）' };

  const original = image.getSize();
  const longest = Math.max(original.width, original.height);

  // 尺寸与体积都达标 → 直接原样发（不做无谓的重编码）
  if (longest <= maxDim && beforeBytes <= targetBytes) {
    return {
      buffer, mime: 'image/jpeg', compressed: false,
      width: original.width, height: original.height,
      beforeBytes, afterBytes: beforeBytes, note: '原图已足够小'
    };
  }

  const dims = [maxDim];
  for (let d = Math.round(maxDim * 0.8); d >= minDim; d = Math.round(d * 0.8)) dims.push(d);
  const qualities = [targetQuality, 82, 76, 70, 62];

  let best = null;
  for (const dim of dims) {
    // 只缩不放：原图比目标小的时候不要放大（放大既糊又变大）
    const scale = longest > dim ? dim / longest : 1;
    const target = scale < 1
      ? image.resize({
        width: Math.max(1, Math.round(original.width * scale)),
        height: Math.max(1, Math.round(original.height * scale)),
        quality: 'best'
      })
      : image;
    const size = target.getSize();

    for (const quality of qualities) {
      let out;
      try { out = target.toJPEG(quality); } catch { continue; }
      if (!out?.length) continue;
      if (!best || out.length < best.buffer.length) {
        best = { buffer: out, width: size.width, height: size.height, quality };
      }
      if (out.length <= targetBytes) {
        // 压完反而更大，且原图本来就不超限 → 保留原图
        if (out.length >= beforeBytes && beforeBytes <= targetBytes) {
          return {
            buffer, mime: 'image/jpeg', compressed: false,
            width: original.width, height: original.height,
            beforeBytes, afterBytes: beforeBytes, note: '压缩无收益，保留原图'
          };
        }
        return {
          buffer: out, mime: 'image/jpeg', compressed: true,
          width: size.width, height: size.height,
          beforeBytes, afterBytes: out.length,
          note: `${original.width}x${original.height} → ${size.width}x${size.height} · 质量 ${quality}`
        };
      }
    }
  }

  if (!best) return { ...fallback, note: '压缩失败，保留原图' };
  return {
    buffer: best.buffer, mime: 'image/jpeg', compressed: true,
    width: best.width, height: best.height,
    beforeBytes, afterBytes: best.buffer.length,
    note: `已压到最小（质量 ${best.quality}），仍超过目标体积`
  };
}

/** 像素尺寸（不解码整图也能读 JPEG/PNG 头；拿不到返回 null）。 */
export function imageSize(buffer) {
  try {
    if (buffer.length > 24 && buffer[0] === 0x89 && buffer[1] === 0x50) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buffer.length) {
        if (buffer[i] !== 0xff) { i += 1; continue; }
        const marker = buffer[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buffer.readUInt16BE(i + 2);
        if (len < 2) return null;
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
        i += 2 + len;
      }
    }
  } catch { /* 读不出来就算了 */ }
  return null;
}

/**
 * 把"要内联进 HTML 的配图"压成小缩略图。
 *
 * 为什么必须单独一套参数：活动卡片要内联 14 张图，原图合计 1.3MB，
 * base64 后 HTML 到 2.2MB，URL 编码后 **超过 Chromium 的 data URL 上限
 * （2MB 量级）**，直接报 `ERR_INVALID_URL (-300)`。缩到 640px/质量 80 后
 * 合计约 200~400KB，两种加载方式都不会超限。
 *
 * 缩略图只用于卡片上的小图位（列表 74x50、卡池 74x74），640px 绰绰有余。
 */
export function compressThumb(buffer, { maxDim = 640, quality = 80, maxBytes = 150_000 } = {}) {
  const mod = getElectron();
  if (!mod) return { buffer, note: '未压缩（electron 不可用）' };
  try {
    const img = mod.nativeImage.createFromBuffer(buffer);
    if (!img || img.isEmpty()) return { buffer, note: '未压缩（解码失败）' };
    const size = img.getSize();
    const longest = Math.max(size.width, size.height);
    // ⚠️ 判断条件必须同时看**尺寸**和**体积**："体积不大就不缩"是错的 ——
    //    实测 14 张封面平均只有 99KB，但尺寸 1920x1080，于是整批被跳过，
    //    内联进 HTML 依然是 2.2MB（差点又撞上 data URL 上限）。
    if (longest <= maxDim && buffer.length <= maxBytes) {
      return { buffer, note: `已足够小（${size.width}x${size.height} ${Math.round(buffer.length / 1024)}KB）` };
    }

    const scale = longest > maxDim ? maxDim / longest : 1;
    const target = scale < 1
      ? img.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'best' })
      : img;
    const targetSize = target.getSize();
    for (const q of [quality, 72, 64, 56]) {
      const out = target.toJPEG(q);
      if (out?.length && out.length <= maxBytes) {
        return { buffer: out, note: `${size.width}x${size.height}→${targetSize.width}x${targetSize.height} q${q} ${Math.round(buffer.length / 1024)}→${Math.round(out.length / 1024)}KB` };
      }
    }
    // 体积仍超标：先试更低质量，实在不行保留原图（宁可大一点，也不要糊到看不清）
    const fallback = target.toJPEG(50);
    return fallback?.length && fallback.length < buffer.length
      ? { buffer: fallback, note: `${size.width}x${size.height}→${targetSize.width}x${targetSize.height} q50 ${Math.round(buffer.length / 1024)}→${Math.round(fallback.length / 1024)}KB` }
      : { buffer, note: `压缩无收益（保持原图 ${Math.round(buffer.length / 1024)}KB）` };
  } catch (error) {
    return { buffer, note: `未压缩（${String(error?.message || error).slice(0, 40)}）` };
  }
}
