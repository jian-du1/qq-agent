// 应用运行时边界：只连接，不安装、启动或读取外部协议端账号目录。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-onebot-boundary-'));
process.env.QQ_AGENT_DATA_DIR = data;
try {
  const { getConfig } = await import('../src/config.js');
  assert.deepEqual(Object.keys(getConfig().onebot).sort(), ['accessToken', 'httpAccessToken', 'httpUrl', 'wsUrl']);
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  assert.doesNotMatch(app, /node:child_process|tokenCandidates|readFileSync\([^\n]*onebot_/);
  const routes = fs.readFileSync(path.join(root, 'src/routes.js'), 'utf8');
  assert.doesNotMatch(routes, /pattern:\s*['"][^'"]*\/(?:launch|stop|open-webui)['"]/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(!pkg.build.files.includes('**/*'));
  assert.deepEqual(pkg.build.files.filter(p => !p.startsWith('!')).sort(),
    ['LICENSE', 'assets/**/*', 'electron/**/*', 'package.json', 'src/**/*', 'ui/**/*']);
  for (const name of ['.gitignore', '.zcodeignore']) {
    const patterns = fs.readFileSync(path.join(root, name), 'utf8').split(/\r?\n/);
    for (const pattern of ['/runtime/', '**/config/', '**/data/', '**/logs/']) {
      assert.ok(patterns.includes(pattern), `${name} must protect external runtime ${pattern}`);
    }
  }
  const html = fs.readFileSync(path.join(root, 'ui/index.html'), 'utf8');
  assert.equal((html.match(/class="rdot"/g) || []).length, 2);
  // 在完全隔离的副本里验证未知旧配置凭据清理，不接触本地项目/外部账号文件。
  const sandbox = path.join(data, 'sanitizer');
  fs.mkdirSync(path.join(sandbox, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(sandbox, 'data'));
  fs.mkdirSync(path.join(sandbox, 'tmp'));
  fs.mkdirSync(path.join(sandbox, 'external-engine', 'config'), { recursive: true });
  const script = path.join(sandbox, 'scripts', 'sanitize-release.mjs');
  fs.copyFileSync(path.join(root, 'scripts', 'sanitize-release.mjs'), script);
  const configPath = path.join(sandbox, 'data', 'config.json');
  const fixture = { obsoleteConnection: { accessToken: 'test-token', httpAccessToken: 'test-http-token', webuiPassword: 'test-password', dir: 'unchanged' }, extra: [{ secret: 'test-secret', enabled: true }] };
  fs.writeFileSync(configPath, JSON.stringify(fixture));
  const externalPath = path.join(sandbox, 'external-engine', 'config', 'account.json');
  fs.writeFileSync(externalPath, JSON.stringify({ accessToken: 'external-token' }));
  const env = { ...process.env, QQ_AGENT_DATA_DIR: path.join(sandbox, 'data'), TMPDIR: path.join(sandbox, 'tmp'), TEMP: path.join(sandbox, 'tmp'), TMP: path.join(sandbox, 'tmp') };
  execFileSync(process.execPath, [script, '--dry-run'], { env, stdio: 'pipe' });
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), fixture);
  execFileSync(process.execPath, [script], { env, stdio: 'pipe' });
  const sanitized = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(sanitized.obsoleteConnection, { accessToken: '', httpAccessToken: '', webuiPassword: '', dir: 'unchanged' });
  assert.deepEqual(sanitized.extra, [{ secret: '', enabled: true }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(externalPath, 'utf8')), { accessToken: 'external-token' });
  console.log('外部 OneBot 边界：配置、无进程管理、无账号发现、打包 allowlist、两项就绪状态全部通过。');
} finally {
  fs.rmSync(data, { recursive: true, force: true });
}
