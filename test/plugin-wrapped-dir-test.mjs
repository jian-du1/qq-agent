// 扩展目录「多套一层」兼容性自测（plugin-loader.resolveSkillRoot）
//
// 背景（2026-11-02 真实事故）：从网盘/浏览器下载的插件包解出来常常多包一层同名目录
//     plugins\theme-mode\theme-mode\plugin.json
// 加载器只认 plugins\theme-mode\plugin.json，于是报「缺少 skill.json / plugin.json」，
// 界面上表现为"文件明明都在、版本却显示 0.0.0、插件不工作"，而报错完全不提
// "多套了一层"，排查成本极高（这两个插件就这么静默坏了很久）。
//
// 这里锁死四条边界：
//   A. 纯 wrapper（外层只有那个子目录）→ 必须能加载
//   B. 正常目录（清单在根）→ 必须照旧能加载（不能把老路径改坏）
//   C. 外层还躺着别的文件且子目录不同名 → **不能**猜，必须报「缺少清单」
//      （防止把"清单真的写错了"误判成 wrapper，反而掩盖真实错误）
//   D. 子目录名与外层同名 + 外层有杂文件（典型解压产物）→ 仍然认
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 数据目录必须隔离：加载器会间接 import src/config.js
process.env.QQ_AGENT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-wrapped-'));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LOADER_URL = pathToFileURL(path.join(ROOT, 'src', 'plugin-loader.js')).href;

let passed = 0;
const ok = (name, extra = '') => {
  passed += 1;
  console.log(`  ✓ ${name}${extra ? ' —— ' + extra : ''}`);
};

const MANIFEST = JSON.stringify({
  id: 'demo', name: '套层演示', version: '1.0.0', apiVersion: 1, capabilities: []
});
const ENTRY = 'export function setup() {}\n';

const cleanups = [];
async function runCase(files, { dataDir } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-wrapcase-'));
  cleanups.push(tmp);
  const prevData = process.env.QQ_AGENT_DATA_DIR;
  if (dataDir) process.env.QQ_AGENT_DATA_DIR = dataDir;
  fs.mkdirSync(path.join(tmp, 'skills'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  const { loadPlugins } = await import(LOADER_URL);
  process.env.QQ_AGENT_DATA_DIR = prevData;
  const res = await loadPlugins({
    log: () => {},
    roots: { skills: path.join(tmp, 'skills'), plugins: path.join(tmp, 'plugins') }
  });
  return {
    loaded: res.loaded.map((r) => r.id),
    failed: res.failed.map((r) => ({ id: r.id, error: String(r.error) }))
  };
}

console.log('=== 扩展目录「多套一层」兼容性 ===');

// ── A. 纯 wrapper ─────────────────────────────────────────────────────────
{
  const r = await runCase({
    'plugins/demo/demo/plugin.json': MANIFEST,
    'plugins/demo/demo/index.js': ENTRY
  });
  assert.deepEqual(r.loaded, ['demo'], `纯 wrapper 应当被识别，实际 failed=${JSON.stringify(r.failed)}`);
  assert.equal(r.failed.length, 0, '不应有失败项');
  ok('A 外层只有同名子目录 → 按内层加载成功');
}

// ── B. 正常目录（回归）────────────────────────────────────────────────────
{
  const r = await runCase({
    'plugins/demo/plugin.json': MANIFEST,
    'plugins/demo/index.js': ENTRY
  });
  assert.deepEqual(r.loaded, ['demo'], `正常目录必须照旧可用，实际 failed=${JSON.stringify(r.failed)}`);
  ok('B 清单在目录根 → 照旧加载（老路径没被改坏）');
}

// ── C. 不允许瞎猜 ─────────────────────────────────────────────────────────
{
  const r = await runCase({
    'plugins/demo/readme.txt': '说明文件',
    'plugins/demo/sub/plugin.json': JSON.stringify({ id: 'sub', name: '子', version: '1.0.0', apiVersion: 1 }),
    'plugins/demo/sub/index.js': ENTRY
  });
  assert.deepEqual(r.loaded, [], '外层有杂文件且子目录不同名时不应猜成 wrapper');
  assert.equal(r.failed.length, 1, '应当报一条失败');
  assert.match(r.failed[0].error, /缺少 skill\.json \/ plugin\.json/, `失败原因应是缺少清单，实际：${r.failed[0].error}`);
  ok('C 外层有杂文件 + 子目录不同名 → 不猜，报「缺少清单」');
}

// ── D. 同名子目录 + 杂文件（真实解压产物）────────────────────────────────
{
  const r = await runCase({
    'plugins/demo/README.md': '下载来源说明',
    'plugins/demo/demo/plugin.json': MANIFEST,
    'plugins/demo/demo/index.js': ENTRY
  });
  assert.deepEqual(r.loaded, ['demo'], `同名子目录应被认作 wrapper，实际 failed=${JSON.stringify(r.failed)}`);
  ok('D 同名子目录 + 外层杂文件 → 仍按内层加载');
}

for (const dir of cleanups) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 偶发占用，忽略 */ }
}

console.log(`\n扩展目录套层兼容：通过 ${passed} / 失败 0`);
process.exit(0);
