// 取 Electron 主进程 API（render.mjs 与 compress.mjs 共用）
//
// ── 为什么单独抽一个文件，而且这么啰嗦 ────────────────────────────────────
// 真实事故：插件加载器用 `import(url + '?t=' + 时间戳)` 做热重载。带查询串的
// URL 会让 `createRequire(import.meta.url)` 的解析基准漂移（实测 Require stack
// 指向了开发工作区而不是安装目录），于是 `require('electron')` 报
// Cannot find module —— 渲染与压缩双双被判为不可用，表现是"群里发命令没反应"，
// 而且**完全静默**（不报错、日志里也查不到）。
//
// 所以这里不信任 import.meta.url，改为锚定**应用自身的位置**：
//   1) process.execPath 旁边的 resources/app（安装版的真实布局）
//   2) 环境变量 QQ_AGENT_APP_DIR（兜底，便于非常规部署）
//   3) 当前工作目录
// 对每个基准都试 `require('electron')` —— Electron 运行时把它注册成内置模块，
// 所以只要基准落在应用内就能命中。

import { createRequire } from 'node:module';
import path from 'node:path';

let cached = null;
let tried = false;
let reason = '';
/** 命中的解析基准，排查时很有用。 */
let resolvedFrom = '';

function candidates() {
  const out = [];
  const execDir = path.dirname(String(process.execPath || ''));
  if (execDir && execDir !== '.' && execDir !== path.sep) {
    out.push(path.join(execDir, 'resources', 'app'));
    out.push(execDir);
  }
  const fromEnv = String(process.env.QQ_AGENT_APP_DIR || '').trim();
  if (fromEnv) out.push(fromEnv);
  try { out.push(process.cwd()); } catch { /* ignore */ }
  return [...new Set(out)];
}

/** @returns {object|null} Electron 主进程 API；拿不到返回 null */
export function getElectron() {
  if (tried) return cached;
  tried = true;

  const notes = [];
  for (const root of candidates()) {
    for (const base of [path.join(root, 'package.json'), path.join(root, 'index.js')]) {
      try {
        const mod = createRequire(base)('electron');
        // 内置模块在非 Electron 运行时里会解析成 npm 包（一个字符串路径），
        // 所以必须确认真的是主进程 API，而不是"解析成功但拿错了东西"。
        if (mod && typeof mod.BrowserWindow === 'function') {
          cached = mod;
          resolvedFrom = base;
          return cached;
        }
        notes.push(`${root}: 拿到了 electron 但不是主进程 API`);
        break;
      } catch (error) {
        notes.push(`${root}: ${String(error?.message || error).split('\n')[0].slice(0, 60)}`);
      }
    }
  }
  reason = `拿不到 electron 模块（试了 ${notes.length} 个解析基准：${notes.slice(0, 2).join('；')}）`;
  return null;
}

/** 不可用时的人类可读原因（可用时为空串）。 */
export function electronUnavailableReason() {
  getElectron();
  return reason;
}

export function electronResolvedFrom() {
  getElectron();
  return resolvedFrom;
}
