// 给 NapCat 的 napcat.mjs 重新打上本机需要的补丁。
//
// 为什么需要：在 NapCat WebUI 里点「升级」会整个替换 napcat.mjs，
// 把下面三处本机补丁冲掉，然后就出现「登录成功 → 崩溃重拉 → 又出二维码」的死循环。
// 升级之后跑一次这个脚本即可。
//
// 三处补丁：
//   1. 账号数据目录改用项目内的 napcat/qqdata（NAPCAT_DATA_OVERRIDE），
//      否则会去写 Documents\Tencent Files，被系统拒绝（EPERM）。
//   2. dataPath getter 同样认这个环境变量（双保险）。
//   3. mkdir "<data>/NapCat/temp" 失败时不抛错，退回系统 TEMP。
//
// 用法：  runtime\node.exe reapply-napcat-patches.mjs
// 幂等：已经打过会直接告诉你「无需处理」。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, 'napcat', 'shell', 'napcat', 'napcat.mjs');

if (!fs.existsSync(target)) {
  console.error('[ERROR] 找不到 napcat.mjs：' + target);
  process.exit(1);
}

let src = fs.readFileSync(target, 'utf8');
const before = src.length;
const report = [];

// 已经全部打过？四个标记都要在，缺一个就继续往下补
if (src.includes('NAPCAT_DATA_OVERRIDE') && src.includes('napcat-temp') && src.includes('napcat-plugin-qzone')) {
  console.log('[OK] 四处补丁都已经在，无需处理。');
  process.exit(0);
}

// ── 补丁 1：数据目录覆盖（调用点）──────────────────────────────────────
const re1 = /(?:const|let) \[m, h\] = zEe\(o\);/g;
if (re1.test(src)) {
  src = src.replace(re1, 'let [m, h] = zEe(o); if (process.env.NAPCAT_DATA_OVERRIDE) m = process.env.NAPCAT_DATA_OVERRIDE;');
  report.push('1. 数据目录覆盖（zEe 调用点）');
} else if (!src.includes('NAPCAT_DATA_OVERRIDE')) {
  report.push('1. ⚠ 没找到 zEe 调用点（版本可能变了，需人工确认）');
}

// ── 补丁 2：dataPath getter ────────────────────────────────────────────
const re2 = /return e \|\| \(e = (?:xe|ve)\.resolve\([^"]*"\.\/\.config\/QQ"\), ([A-Za-z_$]+)\.mkdirSync\(e, \{ recursive: !0 \}\)\), e;/;
const m2 = re2.exec(src);
if (m2 && !src.includes('return process.env.NAPCAT_DATA_OVERRIDE')) {
  const fsmod = m2[1];
  src = src.replace(re2,
    'if (process.env.NAPCAT_DATA_OVERRIDE) { try { ' + fsmod + '.mkdirSync(process.env.NAPCAT_DATA_OVERRIDE, { recursive: !0 }); } catch {} '
    + 'return process.env.NAPCAT_DATA_OVERRIDE; } '
    + 'return e || (e = ' + (m2[0].includes('ve.resolve') ? 've' : 'xe') + '.resolve(ft.homedir(), "./.config/QQ"), ' + fsmod + '.mkdirSync(e, { recursive: !0 })), e;');
  report.push('2. dataPath getter 认 NAPCAT_DATA_OVERRIDE');
}

// ── 补丁 3：NapCat/temp 的 mkdir 容错 ──────────────────────────────────
const re3 = /const s = ((?:xe|ve)\.join\(o, "NapCat", "temp"\));\s*([A-Za-z_$]+)\.mkdirSync\(s, \{ recursive: !0 \}\);/;
const m3 = re3.exec(src);
if (m3) {
  const fsmod = m3[2];
  src = src.replace(re3,
    'let s = ' + m3[1] + ';\n'
    + 'try { ' + fsmod + '.mkdirSync(s, { recursive: !0 }); } catch (e1) { s = ' + (m3[1].startsWith('ve') ? 've' : 'xe')
    + '.join(process.env.TEMP || process.env.TMP || process.cwd(), "napcat-temp"); try { ' + fsmod + '.mkdirSync(s, { recursive: !0 }); } catch (e2) {} }');
  report.push('3. NapCat/temp mkdir 容错');
} else if (!src.includes('napcat-temp')) {
  report.push('3. ⚠ 没找到 NapCat/temp 的 mkdir（版本可能变了）');
}

// ── 补丁 4：插件白名单放行本机的 napcat-plugin-qzone ───────────────────
// 4.18.19 的 PluginLoader 只认官方插件 id，第三方插件会被直接 Rejected
// （日志：not in official plugin whitelist）。这里把自己的插件 id 加进判断。
const re4 = /isOfficialPlugin\(e\)\s*\{\s*return (_?[A-Za-z0-9_$]+)\.has\(e\);\s*\}/;
const m4 = re4.exec(src);
if (m4 && !src.includes('|| e === "napcat-plugin-qzone"')) {
  src = src.replace(re4, 'isOfficialPlugin(e) { return ' + m4[1] + '.has(e) || e === "napcat-plugin-qzone"; }');
  report.push('4. 插件白名单放行 napcat-plugin-qzone');
} else if (!src.includes('napcat-plugin-qzone')) {
  report.push('4. ⚠ 没找到 isOfficialPlugin（版本可能变了）');
}

if (report.length === 0) {
  console.log('[WARN] 一个补丁都没打上，可能版本结构变了，请人工检查。');
  process.exit(1);
}

const bak = target + '.bak-' + Date.now();
fs.copyFileSync(target, bak);
fs.writeFileSync(target, src, 'utf8');
console.log('[OK] 已重新打补丁：');
for (const r of report) console.log('   - ' + r);
console.log('   备份：' + path.basename(bak));
console.log('   文件大小：' + before + ' -> ' + src.length);
console.log('\n现在重启 NapCat（start-napcat.cmd 或 debug-napcat.cmd）让它生效。');
