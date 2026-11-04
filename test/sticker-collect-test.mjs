// 本地表情收藏、发送回退与目录隔离回归。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createChecker, sleep } from './_harness.mjs';

// ── 环境：临时数据目录（必须在 import src 模块之前设好）──────────────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-sticker-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.mkdirSync(path.join(dataDir, 'sticker-images'), { recursive: true });

// 1x1 PNG 夹具
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
const fixtureCache = path.join(dataDir, 'cache-src.png');
fs.writeFileSync(fixtureCache, PNG);

// ── mock OneBot（HTTP API，行为按场景切换）──────────────────────────────
const scenario = {
  getImage: {},            // get_image 返回体
  rejectFileRef: false,    // send_group_msg 拒收 file:/// 形态
  rejectAll: false         // send_group_msg 全拒（测两种形态都失败的报错）
};
const calls = [];          // { action, body }
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const action = String(req.url || '').replace(/^\//, '');
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
    const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (action !== 'expired.jpg') calls.push({ action, body });
    if (action === 'get_image') return reply({ status: 'ok', retcode: 0, data: scenario.getImage });
    if (action === 'send_group_msg') {
      const seg = (body.message || []).find((s) => s.type === 'image') || {};
      const ref = String(seg?.data?.file || '');
      if (scenario.rejectAll || (scenario.rejectFileRef && ref.toLowerCase().startsWith('file:///'))) {
        return reply({ status: 'failed', retcode: 100, wording: '不支持的文件形态' });
      }
      return reply({ status: 'ok', retcode: 0, data: { message_id: 9001 } });
    }
    if (action === 'expired.jpg') { res.writeHead(400); res.end('expired'); return; }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: '未知动作' }));
  });
});
const mockPort = await new Promise((r) => mock.listen(0, '127.0.0.1', () => r(mock.address().port)));
const base = `http://127.0.0.1:${mockPort}`;

const { OneBotClient } = await import('../src/onebot.js');
const { StickerManager, localStickerPath } = await import('../src/sticker-manager.js');
const { normalizeStickerEntry, loadStickerStore, saveStickerStore } = await import('../src/stickers.js');
const { SendQueue } = await import('../src/sender.js');

const onebot = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: base, accessToken: '', httpToken: '', onEvent: () => {} });
const callsOf = (action) => calls.filter((c) => c.action === action);
const fileUriOf = (p) => `file:///${p.replace(/\\/g, '/')}`;

const c = createChecker('本地表情收藏链');

await c.check('消息缓存图片转存到本地，保留备注且仅调用 get_image', async () => {
  calls.length = 0;
  scenario.getImage = { file: fixtureCache };
  const sm = new StickerManager(onebot);
  const saved = await sm.collect('1001', { url: '', file: 'CACHEID.jpg', note: '小蓝鲸举牌' });
  assert.equal(saved.localNote, '小蓝鲸举牌');
  assert.equal(saved.persistFailed, false);
  assert.ok(localStickerPath(saved.url));
  assert.deepEqual(calls.map(c => c.action), ['get_image']);
});

await c.check('本地同步不调用协议端，也不丢失现有条目', async () => {
  calls.length = 0;
  const sm = new StickerManager(onebot);
  const result = await sm.sync(true);
  assert.ok(result.entries.some(e => e.id === 'collected_1001'));
  assert.deepEqual(calls, []);
});

await c.check('normalize 保留已有图片元数据', () => {
  const n = normalizeStickerEntry({ id: 'x', emojiId: 'E9', qqFile: 'a.jpg', persistFailed: true, localFile: 'file:///t.png' });
  assert.equal(n.emojiId, 'E9');
  assert.equal(n.qqFile, 'a.jpg');
  assert.equal(n.persistFailed, true);
  assert.equal(n.localFile, 'file:///t.png');
});

await c.check('转存失败如实标记，不声称有永久图片', async () => {
  scenario.getImage = {};
  const sm = new StickerManager(onebot);
  const saved = await sm.collect('2002', { url: `${base}/expired.jpg`, file: 'NOCACHE.jpg' });
  assert.equal(saved.url, `${base}/expired.jpg`);
  assert.equal(saved.localFile, '');
  assert.equal(saved.persistFailed, true);
});

await c.check('重复收藏更新本地图片，不新增条目', async () => {
  scenario.getImage = { file: fixtureCache };
  const sm = new StickerManager(onebot);
  const count = sm.entries.length;
  const saved = await sm.collect('1001', { file: 'CACHEID.jpg', note: '新的备注' });
  assert.equal(sm.entries.length, count);
  assert.equal(saved.localNote, '新的备注');
  assert.ok(localStickerPath(saved.url));
});

// ── 5. 搬家自愈 ─────────────────────────────────────────────────────────
await c.check('搬家自愈：旧绝对路径按文件名重定位到受控目录（构造时自动修好）', () => {
  const pic = path.join(dataDir, 'sticker-images', 'moved.png');
  fs.writeFileSync(pic, PNG);
  saveStickerStore([{ id: 'collected_5005', resId: 'collected_5005', source: 'ai', url: fileUriOf('C:/somewhere/old-deploy/sticker-images/moved.png') }]);
  // 旧路径直接查：受控目录内存在同名文件 → 自愈解析应命中
  assert.ok(localStickerPath(fileUriOf('C:/somewhere/old-deploy/sticker-images/moved.png')), 'localStickerPath 应按文件名自愈');
  // 构造时 healLocalPaths 应把条目 url 重写到受控目录
  const sm = new StickerManager(onebot);
  const e = sm.entries.find((x) => x.id === 'collected_5005');
  const norm = (s) => String(s).replace(/\\/g, '/').toLowerCase();
  assert.ok(norm(e.url).includes(norm(path.join(dataDir, 'sticker-images'))), `url 应重写到受控目录：${e.url}`);
  assert.ok(localStickerPath(e.url), '自愈后应过发送闸');
});

// ── 6. sender：本地 file:/// 被拒 → base64 回退 ──────────────────────────
const fakeStore = { appendSelf() {} };

await c.check('本地表情 file:/// 被协议端拒收时，自动转 base64 重发成功', async () => {
  calls.length = 0;
  scenario.rejectFileRef = true;
  const pic = path.join(dataDir, 'sticker-images', 'send-me.png');
  fs.writeFileSync(pic, PNG);
  const sq = new SendQueue({ onebot, store: fakeStore });
  const r = await sq.sendSticker('group:123', { id: 'collected_6006', url: fileUriOf(pic) });
  assert.equal(r.message_id, 9001);
  const sends = callsOf('send_group_msg');
  const refs = sends.map((s) => String(s?.body?.message?.[0]?.data?.file || ''));
  assert.equal(sends.length, 2, `应先试 file 形态再试 base64（实发 ${sends.length} 次：${JSON.stringify(refs).slice(0, 120)}）`);
  assert.ok(refs[0].startsWith('file:///'), `第一次应是 file:///${' '}，实际 ${refs[0].slice(0, 60)}`);
  assert.ok(refs[1].startsWith('base64://'), `第二次应是 base64 内联，实际 ${refs[1].slice(0, 30)}`);
});

await c.check('两种形态都被拒时报错含双方原因（不再是哑抛）', async () => {
  scenario.rejectAll = true;
  const sq = new SendQueue({ onebot, store: fakeStore });
  const pic = path.join(dataDir, 'sticker-images', 'send-me.png');
  await assert.rejects(
    () => sq.sendSticker('group:123', { id: 'collected_6007', url: fileUriOf(pic) }),
    (e) => /两种形态都发不出去/.test(String(e.message)) && /base64=/.test(String(e.message)),
    '错误应同时带上 file 与 base64 两次失败的原因'
  );
});

mock.close();
fs.rmSync(dataDir, { recursive: true, force: true });
await sleep(50);
console.log('');
process.exit(c.finish() ? 0 : 1);
