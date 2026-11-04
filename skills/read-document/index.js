// 文档阅读技能（read-document）
//
// 让机器人能读电脑里的 PDF / Word(.docx) / PowerPoint(.pptx)，并把内容用在对话里。
//
// 设计要点：
//   · 零外部依赖：docx / pptx 本质是 zip + xml，用 node:zlib 手写最小 unzip 即可；
//     只有 PDF 需要真正的解析器，那部分用 vendor/ 里自带的 pdf.js（纯 ESM，无需 worker）。
//   · 全部本地读取，不联网、不花额外 token（除了把文本喂给模型那一次）。
//   · 长文档不硬塞：一次读一段，返回里明确给出"要继续读就传 offset"，让模型自己续读。
//   · 结果一律返回文本；图片型 PDF 会明确说明"没有可提取的文字"，不假装读到了内容。

import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 与项目内其它模块同一约定：以模块自身位置为锚点，不用 process.cwd()。
// index.js 在 <安装目录>/resources/app/skills/read-document/，往上四层即安装目录，
// 与 src/config.js 的 DATA_DIR 同款推导：默认 <安装目录>/data/（QQ_AGENT_DATA_DIR
// 显式覆盖，QQ_AGENT_PROFILE 加实例后缀）。
const DATA_ROOT = (() => {
  if (typeof process !== 'undefined' && String(process.env?.QQ_AGENT_DATA_DIR ?? '').trim()) {
    return path.resolve(String(process.env.QQ_AGENT_DATA_DIR).trim());
  }
  const suffix = /^\d+$/.test(String(process.env?.QQ_AGENT_PROFILE ?? '')) ? `-${process.env.QQ_AGENT_PROFILE}` : '';
  return path.resolve(HERE, '..', '..', '..', '..', `data${suffix}`);
})();

const SUPPORTED = new Set(['.pdf', '.docx', '.pptx', '.doc', '.ppt']);
const READABLE = new Set(['.pdf', '.docx', '.pptx']);
// 能列出来但读不了的旧版二进制格式：需要给出"请另存为"的明确指引
const LEGACY = new Set(['.doc', '.ppt']);

let cfg = () => ({});

export function setup(api) {
  cfg = api.config;

  api.registerTool({
    id: 'doc_list',
    name: '列出文档',
    description:
      '列出本机「文档文件夹」里可读的 PDF / Word / PowerPoint 文件（文件名、大小、修改时间）。'
      + '当用户问"有哪些文档""我放的文件你看到了吗""帮我看看那几份材料"却没说具体文件名时，先调用它。',
    category: 'utility',
    icon: '📁',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '可选。只列出文件名包含这个词的文档，例如"期末""报告"。' }
      },
      required: []
    },
    async execute(_ctx, args) {
      const s = settings();
      const keyword = String(args?.keyword ?? '').trim().toLowerCase();
      let files = listDocuments(s.documentsDir);
      if (keyword) files = files.filter((f) => f.name.toLowerCase().includes(keyword));

      if (!files.length) {
        return {
          content: keyword
            ? `文档文件夹里没有文件名包含「${args.keyword}」的可读文档。`
            : '文档文件夹里还没有可读的文档。'
              + `请把 PDF / Word(.docx) / PowerPoint(.pptx) 文件放进：${s.documentsDir}`
        };
      }

      const lines = files.slice(0, 60).map((f) =>
        `· ${f.name}（${f.ext.slice(1).toUpperCase()}，${fmtSize(f.size)}${f.mtime ? `，改于 ${f.mtime}` : ''}）`);
      const more = files.length > 60 ? `\n…还有 ${files.length - 60} 个未列出。` : '';
      return { content: `文档文件夹里共 ${files.length} 个可读文档：\n${lines.join('\n')}${more}\n\n要用内容时调用 doc_read，参数 name 传文件名。` };
    }
  });

  api.registerTool({
    id: 'doc_read',
    name: '读文档',
    description:
      '读取一份 PDF / Word(.docx) / PowerPoint(.pptx) 的正文并返回纯文本。'
      + '当用户说"读一下这份材料""总结这个 PDF""这份报告讲了什么""PPT 里写了什么"时使用。'
      + '参数 name 可以是文档文件夹里的文件名，也可以是文件的完整路径（例如用户在别处放的文件）。'
      + '内容很长时只返回一段，返回结果里会给出继续读的 offset。',
    category: 'utility',
    icon: '📄',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '文件名（如"年度报告.pdf"）或文件完整路径。' },
        offset: { type: 'number', description: '从第几个字符开始读。要接着上一次读时，把上次返回提示里的 offset 填进来。默认 0。' },
        maxChars: { type: 'number', description: '这次最多返回多少字符。默认用设置里的值（约 12000）。' }
      },
      required: ['name']
    },
    async execute(_ctx, args) {
      const s = settings();
      const raw = String(args?.name ?? '').trim();
      if (!raw) return err('缺少参数 name：请告诉我要读哪个文件。');

      const resolved = resolveDoc(raw, s.documentsDir);
      if (resolved.error) return err(resolved.error);
      const { file, name } = resolved;

      const ext = path.extname(file).toLowerCase();
      if (!READABLE.has(ext)) {
        if (LEGACY.has(ext)) {
          return err(`「${name}」是旧版 .doc/.ppt 格式，读不了。`
            + '请在 Word / PowerPoint 里「另存为」成 .docx / .pptx 再读（.doc/.ppt 是二进制老格式，没有可靠的纯 JS 解析方式）。');
        }
        return err(`「${name}」不是支持的文档格式（${ext || '无扩展名'}）。`
          + '只能读 PDF、Word(.docx)、PowerPoint(.pptx)。');
      }

      let stat;
      try {
        stat = fs.statSync(file);
      } catch (error) {
        return err(`读不到文件信息：${error?.message ?? error}`);
      }
      const maxMB = num(s.maxFileMB, 50, 1, 500);
      if (stat.size > maxMB * 1024 * 1024) {
        return err(`文件太大（${fmtSize(stat.size)}，上限 ${maxMB}MB），读不动。可以先把不需要的部分拆出来。`);
      }

      let doc;
      try {
        if (ext === '.pdf') doc = await readPdf(file, s);
        else if (ext === '.docx') doc = await readDocx(file);
        else doc = await readPptx(file);
      } catch (error) {
        return err(`解析「${name}」失败：${error?.message ?? error}`);
      }
      const text = (doc.text || '').replace(/\r\n/g, '\n').trim();
      if (!text) {
        const hint = ext === '.pdf'
          ? '这份 PDF 里没有可提取的文字 —— 它很可能是扫描件/图片型 PDF（整页是图片）。这种情况需要先做 OCR 才能读，本技能不带 OCR。'
          : '这份文件里没有找到正文文字。';
        return err(`「${name}」读出来了，但内容是空的：${hint}`);
      }

      const total = text.length;
      const cap = num(args?.maxChars, s.maxChars, 500, 60000);
      let offset = Math.floor(num(args?.offset, 0, 0, total));
      // offset 越界时回退到 0，而不是返回空串让模型以为文件是空的
      if (offset >= total) offset = 0;
      const chunk = text.slice(offset, offset + cap);
      const pageInfo = doc.pages ? `，共 ${doc.pages} 页` : (doc.slides ? `，共 ${doc.slides} 张幻灯片` : '');

      let head = `【${name}】${pageInfo}，正文共 ${total} 字`;
      head += offset > 0 ? `（本次从第 ${offset} 字开始）` : '';

      const cur = offset + chunk.length;
      let tail = '';
      if (cur < total) {
        tail = `\n\n…本次读到第 ${cur} 字，还有 ${total - cur} 字没读。`
          + `需要继续就读：doc_read(name="${name}", offset=${cur})。`
          + '不要凭空猜测没读到的部分。';
      }
      if (doc.note) tail += `\n（提示：${doc.note}）`;

      return {
        content: `${head}\n----------------\n${chunk}${tail}\n\n`
          + '（以上是文件原文。请按用户的要求回答或总结；除非用户明确要求，不要把原文整段复述出来。）'
      };
    }
  });
}

export function available() {
  // 纯本地能力，无外部依赖；文件不存在时由工具自己给出明确提示。
  return true;
}

// ── 设置 ────────────────────────────────────────────────────────────────────

function settings() {
  const c = safeCfg();
  const rawDir = String(c.documentsDir ?? '').trim();
  const documentsDir = rawDir
    ? (path.isAbsolute(rawDir) ? rawDir : path.resolve(DATA_ROOT, rawDir))
    : path.join(DATA_ROOT, 'documents');
  return {
    documentsDir,
    maxChars: num(c.maxChars, 12000, 500, 60000),
    maxPages: num(c.maxPages, 25, 1, 200),
    maxFileMB: num(c.maxFileMB, 50, 1, 500)
  };
}

function safeCfg() {
  try { return cfg() || {}; } catch { return {}; }
}

function num(v, dflt, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function err(message) {
  return { content: message, isError: true };
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// ── 找文件 ──────────────────────────────────────────────────────────────────

/** 定位用户说的那个文件：先当文件名在文档文件夹里找，再当路径试。 */
function resolveDoc(raw, documentsDir) {
  const cleaned = raw.replace(/^["'「『]+|["'」』]+$/g, '').trim();
  // 1) 文档文件夹里的同名文件（最常见）
  const inDir = path.resolve(documentsDir, cleaned);
  if (isInside(documentsDir, inDir) && fs.existsSync(inDir) && fs.statSync(inDir).isFile()) {
    return { file: inDir, name: path.basename(inDir) };
  }
  // 2) 模糊匹配：用户只记得大概名字（去扩展名 + 忽略大小写 + 包含即算）
  const key = cleaned.toLowerCase();
  const keyNoExt = key.replace(/\.(pdf|docx|pptx)$/, '');
  const all = listDocuments(documentsDir);
  const exact = all.filter((f) => f.name.toLowerCase() === key);
  const partial = all.filter((f) => {
    const n = f.name.toLowerCase();
    return n.includes(key) || (keyNoExt.length >= 2 && n.replace(/\.(pdf|docx|pptx)$/, '').includes(keyNoExt));
  });
  const pick = exact[0] || (partial.length === 1 ? partial[0] : null);
  if (pick) return { file: pick.full, name: pick.name };
  if (partial.length > 1) {
    return { error: `文档文件夹里有 ${partial.length} 个文件都像「${cleaned}」：${partial.map((f) => f.name).join('、')}。请让用户说清楚是哪一个。` };
  }
  // 3) 当作完整/相对路径
  if (path.isAbsolute(cleaned) || /^[a-zA-Z]:[\\/]/.test(cleaned)) {
    const abs = path.resolve(cleaned);
    if (fs.existsSync(abs)) {
      if (fs.statSync(abs).isFile()) return { file: abs, name: path.basename(abs) };
      return { error: `「${abs}」是一个文件夹，不是文件。` };
    }
    return { error: `找不到文件「${cleaned}」。可用 doc_list 看看文档文件夹里有什么。` };
  }
  return { error: `在文档文件夹里找不到「${cleaned}」。可用 doc_list 列出所有可读文档。` };
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function listDocuments(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!SUPPORTED.has(ext)) continue;
    const full = path.join(dir, e.name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    out.push({
      name: e.name,
      full,
      ext,
      size: st.size,
      mtime: st.mtime ? st.mtime.toISOString().slice(0, 10) : ''
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

// ── docx ────────────────────────────────────────────────────────────────────

async function readDocx(file) {
  const entries = unzip(fs.readFileSync(file));
  const parts = [];
  // 顺序：正文 → 页眉 → 页脚。页眉页脚常有有用的抬头信息（单位/文号）。
  const wanted = ['word/document.xml', 'word/header1.xml', 'word/header2.xml', 'word/footer1.xml', 'word/footer2.xml'];
  for (const key of wanted) {
    const buf = entries.get(key);
    if (!buf) continue;
    const body = xmlToPlainText(buf.toString('utf8'));
    if (body.trim()) parts.push(body.trim());
  }
  return { text: parts.join('\n\n') };
}

/**
 * 把 docx / pptx 里的 DrawingML XML 转成纯文本。
 *
 * ⚠️ 三个必须用 \b 词边界的地方（少了就会把 XML 标签当正文吐出来）：
 *   <w:p ...>  vs <w:pPr>   —— 不写 \b，w:pPr 会被当成段落开头
 *   <a:p ...>  vs <a:pPr>
 *   <w:t ...>  vs <w:tab/>  —— 不写 \b，tab 标签会被当成文本节点
 */
function xmlToPlainText(xml) {
  if (!xml) return '';
  let out = xml.replace(/<!--[\s\S]*?-->/g, '');
  // 段落结束 → 换行（w:p 是 Word，a:p 是 PowerPoint）
  out = out.replace(/<\/w:p>/g, '\n').replace(/<\/a:p>/g, '\n');
  // 表格行/单元格用制表符与换行分隔，保留基本可读性
  out = out.replace(/<\/w:tc>/g, '\t').replace(/<\/w:tr>/g, '\n');
  // 显式换行/分页/制表符
  out = out.replace(/<w:br\b[^>]*\/?>/g, '\n').replace(/<w:tab\b[^>]*\/?>/g, '\t');
  // 只取文本节点：标签名后必须跟空白/斜杠/右尖括号，避免误吞 <w:tbl> 之类
  out = out.replace(/<(?:w|a):t(?:\s[^>]*)?>([\s\S]*?)<\/(?:w|a):t>/g, '$1');
  // 剥掉所有剩下的标签
  out = out.replace(/<[^>]+>/g, '');
  // PowerPoint 的 <a:t> 里会混进"按需生成的动画样式"文本（style.visibilityppt_xppt_y、
  // .rotationppt_hppt_w 这类），它是渲染指令不是正文，且会重复几十次把内容冲掉。
  // 注意：去掉 "style" 后可能留下 ".visibilityppt_xppt_y" 这样的残尾，
  // 所以这里连"孤立的前导点 + 单词"一起清，而不是只删 style. 本身。
  out = out.replace(/style\./g, '');
  out = out.replace(/\.?(?:visibility|rotation|flipH|flipV)\w*/gi, '');
  out = unescapeXml(out);
  // 清理：行内多余空白压成一个空格，行首行尾去空白，连续空行压成一个
  out = out.split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => safeChar(parseInt(d, 10)))
    .replace(/&amp;/g, '&');   // & 必须最后替换，否则 &amp;lt; 会被还原成 <
}

function safeChar(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

// ── pptx ────────────────────────────────────────────────────────────────────

async function readPptx(file) {
  const entries = unzip(fs.readFileSync(file));
  const names = [...entries.keys()];
  const slideNames = names
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNo(a) - slideNo(b));

  if (!slideNames.length) return { text: '', slides: 0 };

  const chunks = [];
  for (const n of slideNames) {
    const idx = slideNo(n);
    const body = xmlToPlainText(entries.get(n).toString('utf8'));
    // 备注页也读：很多 PPT 的讲解内容都在备注里
    const note = entries.get(`ppt/notesSlides/notesSlide${idx}.xml`);
    const noteText = note ? xmlToPlainText(note.toString('utf8')) : '';
    const parts = [`── 第 ${idx} 张 ──`, body];
    if (noteText) parts.push(`（备注）${noteText}`);
    chunks.push(parts.filter(Boolean).join('\n'));
  }
  return { text: chunks.join('\n\n'), slides: slideNames.length };
}

function slideNo(name) {
  const m = /slide(\d+)\.xml$/.exec(name);
  return m ? Number(m[1]) : 0;
}

// ── pdf（走 vendor 里的 pdf.js）─────────────────────────────────────────────

let pdfjsPromise = null;

function loadPdfjs() {
  if (!pdfjsPromise) {
    const entry = path.join(HERE, 'vendor', 'pdf.mjs');
    pdfjsPromise = import(pathToFileURL(entry).href).catch((error) => {
      pdfjsPromise = null;   // 允许下次重试，而不是永久缓存一个失败
      throw new Error(`PDF 解析引擎加载失败（${path.basename(entry)}）：${error?.message ?? error}`);
    });
  }
  return pdfjsPromise;
}

async function readPdf(file, s) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(fs.readFileSync(file));

  const task = pdfjs.getDocument({
    data,
    // 不启 worker：技能里没有 worker 线程可用的上下文，同线程解析最稳。
    disableWorker: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0
  });
  const doc = await task.promise;

  const totalPages = doc.numPages;
  const pageLimit = Math.min(totalPages, num(s.maxPages, 25, 1, 200));
  // 每页平均分到的字符预算，避免前几页把预算吃光导致后面完全读不到
  const perPage = Math.max(400, Math.ceil(num(s.maxChars, 12000, 500, 60000) / pageLimit));

  const pages = [];
  try {
    for (let i = 1; i <= pageLimit; i++) {
      let text = '';
      try {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        text = joinTextItems(tc.items);
        try { page.cleanup(); } catch { /* 清理失败不影响结果 */ }
      } catch (error) {
        text = `（第 ${i} 页读取失败：${error?.message ?? error}）`;
      }
      pages.push(`── 第 ${i} 页 ──\n${text.slice(0, perPage)}`);
    }
  } finally {
    try { await doc.destroy(); } catch { /* 忽略 */ }
  }

  const note = pageLimit < totalPages
    ? `这份 PDF 共 ${totalPages} 页，本次只读了前 ${pageLimit} 页（受设置 maxPages 限制）。要读更多请调大设置，或分次读。`
    : '';

  return { text: pages.join('\n\n'), pages: totalPages, note };
}

/**
 * pdf.js 的 textContent.items 拼接。
 * ⚠️ 必须跳过 item.type !== 'text' 的项（marked-content 标记没有 str），
 *    并且过滤落单的代理项 —— 拼接断裂的代理对会产出 U+FFFD，让整段中文变乱码。
 */
function joinTextItems(items) {
  let out = '';
  for (const it of items || []) {
    if (!it || it.type === 'beginMarkedContent' || it.type === 'endMarkedContent') continue;
    const s = typeof it.str === 'string' ? it.str : '';
    if (!s) continue;
    out += s;
    if (it.hasEOL) out += '\n';
  }
  return out;
}

// ── 最小 ZIP 读取（docx / pptx 就是 zip）───────────────────────────────────
//
// 只支持 store(0) 与 deflate(8) —— Office 文件固定用这两种。
// 用中央目录定位条目（本地头里的 size 在流式写入时可能是 0，靠它读会截断）。
function unzip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) {
    // D0 CF 11 E0 = OLE2 复合文档（老版 .doc/.ppt/.xls 就是这种二进制格式）。
    // 常见于"把 .doc 直接改后缀成 .docx"，比笼统的"文件损坏"更有用。
    if (buf.length >= 4 && buf.readUInt32LE(0) === 0xe011cfd0) {
      throw new Error('这是旧版二进制格式（.doc/.ppt）改成的 .docx/.pptx。请用 Word/PowerPoint 打开后「另存为」真正的 .docx/.pptx。');
    }
    throw new Error('不是有效的 zip 容器（找不到中央目录结尾）—— 文件可能损坏或不是 .docx/.pptx');
  }

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('zip 中央目录损坏');
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (localOff + 30 <= buf.length && buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      let data = null;
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) {
        try { data = zlib.inflateRawSync(raw); } catch { data = null; }   // 单个坏条目不影响其它
      }
      if (data) out.set(name, data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

// ── 可选生命周期 ────────────────────────────────────────────────────────────
// 本技能没有定时器/监听器，activate / deactivate 都无事可做，
// 因此不导出 —— loader 对缺失的生命周期是允许的（它用 typeof 判断）。
