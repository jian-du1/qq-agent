// 图片下载（带 Referer 与重试）
//
// ── 为什么不能直接把图片地址交给协议端去下 ─────────────────────────────────
// Pixiv 的图床对 Referer 有硬要求：不带 https://www.pixiv.net/ 会直接 403。
// 协议端拿到的消息段里没有 Referer 字段，所以只能由插件自己把图下下来，
// 再以 base64 内联发出去。
//
// ── 三个必须处理的坑（都是实测踩出来的）────────────────────────────────────
//   ① 防盗链不总是返回错误码：有的图床返回 200，但内容是一个 HTML 网页
//      → 所以必须校验 content-type 真的是 image/*，且体积不是"一张网页那么小"
//   ② 同一张图有多个尺寸变体，老图常常缺 master1200 那个变体（实测 403）
//      → 所以候选是一个列表，逐个试，**候选顺序就是重试顺序**
//   ③ 瞬时抖动（连接被重置）很常见 → 每个候选重试 attempts 次，退避递增

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 逐个候选下载，第一个成功的就返回。
 *
 * @param {Array<string|{url:string, referer?:string}>|string} candidates
 * @param {{attempts?:number, timeoutMs?:number, maxBytes?:number, log?:Function}} [opts]
 * @returns {Promise<Buffer>} 图片原始字节
 */
export async function downloadImage(candidates, {
  attempts = 3,
  timeoutMs = 30000,
  maxBytes = 24 * 1024 * 1024,
  log
} = {}) {
  const list = (Array.isArray(candidates) ? candidates : [candidates])
    .map((c) => (typeof c === 'string' ? { url: c } : c))
    .filter((c) => c && c.url);
  if (!list.length) throw new Error('没有可下载的图片地址');

  let lastError = null;

  for (let idx = 0; idx < list.length; idx += 1) {
    const { url, referer } = list[idx];
    for (let i = 1; i <= attempts; i += 1) {
      try {
        const headers = { 'user-agent': UA };
        // 候选自带的 Referer 优先（Pixiv 必须用它指定的值）；
        // 没有就用图片域名的 origin 兜底，能救回一部分防盗链。
        const ref = referer || (() => {
          try { return `${new URL(url).origin}/`; } catch { return ''; }
        })();
        if (ref) headers.referer = ref;

        const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const type = String(res.headers.get('content-type') || '');
        const buf = Buffer.from(await res.arrayBuffer());
        // 防盗链常见表现：200 + HTML 页面 —— 必须查出来，否则会把网页当图发出去
        if (!/^image\//i.test(type) || buf.length < 2048) {
          throw new Error(`不是图片（${type.split(';')[0] || '未知类型'} ${buf.length}B）`);
        }
        if (buf.length > maxBytes) {
          throw new Error(`图片过大（${Math.round(buf.length / 1024 / 1024)}MB）`);
        }
        if (idx > 0) log?.(`第 ${idx + 1} 个候选下载成功（前面的都失败了）`);
        return buf;
      } catch (error) {
        lastError = error;
        if (i < attempts) await sleep(350 * i);
      }
    }
    if (list.length > 1) {
      log?.(`候选 ${idx + 1}/${list.length} 下载失败（${lastError?.message}），换下一个`);
    }
  }

  throw lastError || new Error('图片下载失败');
}
