// 收到的 QQ 文件 → 自动落到「文档文件夹」，让 read-document 技能能直接读。
//
// 背景：read-document 只从 data/documents 里找文件，而群里/私聊发来的文件
// 只在协议端本机缓存里（NapCat 的 nt_data\File\...），模型拿不到路径。
// 这里在消息入库时顺手把文件复制过去，文件名沿用原文件名。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const DOCUMENTS_DIR = path.join(DATA_DIR, 'documents');

// 与 read-document 技能的 maxFileMB 默认值对齐
const MAX_BYTES = 50 * 1024 * 1024;
const ALLOWED = new Set(['.pdf', '.docx', '.pptx', '.doc', '.ppt', '.txt', '.md', '.csv', '.xlsx', '.json']);

/** 文件名清洗：去路径分隔符、控制字符、Windows 非法字符，防目录穿越。 */
export function safeFileName(raw, fallback = 'file') {
  let name = String(raw ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  name = name.replace(/^\.+/, '').slice(0, 120);
  if (!name) name = fallback;
  return name;
}

/**
 * 把消息里的 file 段落到文档目录。
 * @returns {Promise<Array<{name:string, ok:boolean, why?:string}>>}
 */
export async function saveIncomingFiles(onebot, media) {
  const files = (media || []).filter((m) => m && m.kind === 'file');
  if (!files.length) return [];
  const out = [];
  for (const m of files) {
    const fallbackName = safeFileName(m.name || m.file, 'file');
    const ext = path.extname(fallbackName).toLowerCase();
    if (!ALLOWED.has(ext)) { out.push({ name: fallbackName, ok: false, why: '类型不在可读范围' }); continue; }
    try {
      // 1) 让协议端把本机缓存路径给我（NapCat: get_file）
      let src = '';
      const params = {};
      if (m.fileId) params.file_id = m.fileId;
      if (m.file) params.file = m.file;
      if (Object.keys(params).length) {
        const r = await onebot.call('get_file', params).catch(() => null);
        src = String(r?.file || r?.path || '');
      }
      if (!src || !fs.existsSync(src)) { out.push({ name: fallbackName, ok: false, why: '协议端没有本机缓存' }); continue; }
      const st = fs.statSync(src);
      if (!st.isFile()) { out.push({ name: fallbackName, ok: false, why: '不是普通文件' }); continue; }
      if (st.size > MAX_BYTES) { out.push({ name: fallbackName, ok: false, why: `超过 ${Math.round(MAX_BYTES / 1048576)}MB` }); continue; }

      // 2) 复制到 data/documents（重名加序号，不覆盖已有文件）
      fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });
      let dest = path.join(DOCUMENTS_DIR, fallbackName);
      if (fs.existsSync(dest)) {
        const base = path.basename(fallbackName, ext);
        for (let i = 2; i < 1000; i += 1) {
          const cand = path.join(DOCUMENTS_DIR, `${base}(${i})${ext}`);
          if (!fs.existsSync(cand)) { dest = cand; break; }
        }
      }
      fs.copyFileSync(src, dest);
      out.push({ name: path.basename(dest), ok: true });
    } catch (error) {
      out.push({ name: fallbackName, ok: false, why: String(error?.message ?? error) });
    }
  }
  return out;
}
