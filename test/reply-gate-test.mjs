// 回复门槛（replyGate）一致性测试。
//
// 这个模块的价值全在"一处配置驱动三处行为"，所以测试也必须锁住三者同源：
//   ① 引擎触发档位   store.contextSliderPos / store.keywords / contextTier
//   ② 主人门禁       ownerOnlyReply.enabled / ids
//   ③ 提示词文案     gateRuleText()（prompt.js 直接注入系统提示）
// 任何一处与 mode 脱钩（比如 mode=at-owner 但门禁还是关的）都会造成
// "配置放宽了、模型还装死"或"配置收紧了、模型仍逢话就接"的调试地狱。
//
// 另外锁住两条迁移路径：
//   · 老配置（没有 replyGate）→ 从档位滑条 + 门禁开关反推 mode
//   · customRules 里手写的【回复门槛】段落 → 迁移时剥掉（否则提示词里两份规则打架）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}: ${e.message}`); }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── 1. 纯函数层（不碰磁盘）──────────────────────────────────────────────
const {
  GATE_MODES, GATE_LABELS, GATE_HINTS, normalizeGate,
  gateSliderPos, gateToLegacy, gateFromLegacy, gateRuleText
} = await import('../src/reply-gate.js');

check('四种模式都有标签与解释文案（UI 下拉不会渲染出空白项）', () => {
  for (const m of GATE_MODES) {
    assert.ok(GATE_LABELS[m], `${m} 缺 GATE_LABELS`);
    assert.ok(GATE_HINTS[m], `${m} 缺 GATE_HINTS`);
  }
  assert.equal(Object.keys(GATE_LABELS).length, GATE_MODES.length);
});

check('normalizeGate：非法 mode 回落 at-any，主人号只留数字 QQ 号', () => {
  assert.equal(normalizeGate({ mode: '乱写' }).mode, 'at-any');
  assert.equal(normalizeGate(null).mode, 'at-any');
  const g = normalizeGate({ mode: 'at-owner', ownerIds: ['1000000002', '昵称', '12', ' 1000000003 '] });
  assert.deepEqual(g.ownerIds, ['1000000002', '1000000003'], '3 位以下或非数字必须被过滤');
  // 逗号/中文逗号/顿号/空格都能拆
  assert.deepEqual(normalizeGate({ ownerIds: '1:2' }).ownerIds, [], '非数字整串应被过滤');
  assert.deepEqual(normalizeGate({ keywords: '肥鱼，小助手、摸鱼 鱼' }).keywords, ['肥鱼', '小助手', '摸鱼', '鱼']);
  assert.equal(normalizeGate({ poke: false }).poke, false);
  assert.equal(normalizeGate({}).poke, true, 'poke 默认开');
});

check('gateSliderPos / gateToLegacy：mode → 档位档与门禁', () => {
  assert.equal(gateSliderPos({ mode: 'at-any' }), 5);
  assert.equal(gateSliderPos({ mode: 'at-owner' }), 5);
  assert.equal(gateSliderPos({ mode: 'at-keyword' }), 15);
  assert.equal(gateSliderPos({ mode: 'all' }), 95);

  const owner = gateToLegacy({ mode: 'at-owner', ownerIds: ['1000000002'] });
  assert.equal(owner.ownerOnlyReply.enabled, true);
  assert.equal(owner.ownerOnlyReply.ids, '1000000002');
  assert.deepEqual(owner.keywords, [], '主人模式下不该灌关键词');

  const kw = gateToLegacy({ mode: 'at-keyword', keywords: ['肥鱼'], ownerIds: ['1000000002'] });
  assert.equal(kw.ownerOnlyReply.enabled, false);
  assert.deepEqual(kw.keywords, ['肥鱼']);
  assert.equal(kw.contextSliderPos, 15);

  const all = gateToLegacy({ mode: 'all', keywords: ['肥鱼'] });
  assert.equal(all.contextSliderPos, 95);
  assert.deepEqual(all.keywords, [], '全响应模式不需要关键词表');
});

check('gateFromLegacy：老字段反推出最接近的 mode', () => {
  assert.equal(gateFromLegacy({ contextSliderPos: 95 }).mode, 'all');
  assert.equal(gateFromLegacy({ contextSliderPos: 91 }).mode, 'all', '>90 即全响应');
  assert.equal(gateFromLegacy({ contextSliderPos: 15 }).mode, 'at-keyword');
  assert.equal(gateFromLegacy({ contextSliderPos: 60 }).mode, 'at-keyword', '3 档随机没有对应门槛语义，归到关键词档');
  assert.equal(gateFromLegacy({ contextSliderPos: 5, ownerOnlyReply: { enabled: true, ids: '1000000002' } }).mode, 'at-owner');
  assert.equal(gateFromLegacy({ contextSliderPos: 5, ownerOnlyReply: { enabled: false } }).mode, 'at-any');
  assert.equal(gateFromLegacy({}).mode, 'at-any');
  assert.equal(gateFromLegacy({ contextSliderPos: 'abc' }).mode, 'at-any', '脏值不能算出 NaN 档');
});

check('gateRuleText：文案与 mode 对齐，且都写明私聊不受限', () => {
  const any = gateRuleText({ mode: 'at-any' }, { botName: '小助手' });
  assert.match(any, /任何人|群友/, 'at-any 必须说明不挑人');
  assert.match(any, /私聊不受此限/);
  assert.doesNotMatch(any, /主人（QQ 号/, 'at-any 不该出现主人门禁话术');

  const owner = gateRuleText({ mode: 'at-owner', ownerIds: ['1000000002'] }, { botName: '小助手' });
  assert.match(owner, /1000000002/);
  assert.match(owner, /私聊不受此限/);

  const emptyOwner = gateRuleText({ mode: 'at-owner', ownerIds: [] }, { botName: '小助手' });
  assert.match(emptyOwner, /谁都不回/, '主人号为空时必须明说后果');

  const kw = gateRuleText({ mode: 'at-keyword', keywords: ['肥鱼'] }, { botName: '小助手' });
  assert.match(kw, /肥鱼/);

  const all = gateRuleText({ mode: 'all' }, { botName: '小助手' });
  assert.match(all, /不要求有人 @ 你|任何消息都可能/);
  assert.match(all, /私聊不受此限/);
});

// ── 2. 配置层（临时数据目录，不碰真实 data/）────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-test-'));
const cfgPath = path.join(tmp, 'config.json');
// 造一份"升级前"的老配置：没有 replyGate，规则散在三处
const legacyRules = [
  '【回复门槛 —— 优先级高于以上所有人设】',
  '群聊里只有在被 @ 且 @ 我的人是主人时才允许发言。',
  '例外：主人在私聊里直接跟我说话时，正常回复。',
  '',
  '其他规则：不要说脏话，别提"作为AI"。'
].join('\n');
fs.writeFileSync(cfgPath, JSON.stringify({
  store: { contextSliderPos: 5, contextTier: 1, keywords: ['小助手'] },
  ownerOnlyReply: { enabled: true, ids: '1000000002' },
  persona: { customRules: legacyRules, extra: '保留我' }
}, null, 2));

process.env.QQ_AGENT_DATA_DIR = tmp;
const configMod = await import(pathToFileURL(path.join(ROOT, 'src', 'config.js')).href);

check('loadConfig 迁移：老配置反推出 at-owner，并剥掉手写的【回复门槛】段落', () => {
  const c = configMod.getConfig();
  assert.equal(c.replyGate.mode, 'at-owner');
  assert.deepEqual(c.replyGate.ownerIds, ['1000000002']);
  assert.equal(c.replyGate.poke, true);
  assert.doesNotMatch(String(c.persona.customRules), /【回复门槛/, '旧门槛段落必须被剥掉，否则提示词里两份规则打架');
  assert.match(String(c.persona.customRules), /不要说脏话/, '不能把门槛段落之后的其他自定义规则一起删掉');
});

check('updateConfig(replyGate)：派生档位 + 门禁 + tier 三处同步', () => {
  let c = configMod.updateConfig({ replyGate: { mode: 'at-owner', ownerIds: ['1000000002'], keywords: ['肥鱼'], poke: false } });
  assert.equal(c.store.contextSliderPos, 5);
  assert.equal(c.store.contextTier, 1, 'pos=5 必须派生出 1 档（仅艾特）');
  assert.equal(c.ownerOnlyReply.enabled, true, '主人模式必须打开门禁');
  assert.equal(c.ownerOnlyReply.ids, '1000000002');
  assert.deepEqual(c.store.keywords, [], '主人模式清空关键词');
  assert.equal(c.replyGate.poke, false);

  c = configMod.updateConfig({ replyGate: { mode: 'at-keyword', keywords: ['肥鱼', '小助手'], ownerIds: ['1000000002'] } });
  assert.equal(c.store.contextSliderPos, 15);
  assert.equal(c.store.contextTier, 2, 'pos=15 必须派生出 2 档（+关键词）');
  assert.deepEqual(c.store.keywords, ['肥鱼', '小助手']);
  assert.equal(c.ownerOnlyReply.enabled, false, '关键词模式必须关掉主人门禁（否则群友 @ 也被拦）');

  c = configMod.updateConfig({ replyGate: { mode: 'all' } });
  assert.equal(c.store.contextSliderPos, 95);
  assert.equal(c.store.contextTier, 4);
  assert.equal(c.ownerOnlyReply.enabled, false);

  c = configMod.updateConfig({ replyGate: { mode: 'at-any' } });
  assert.equal(c.store.contextSliderPos, 5);
  assert.equal(c.store.contextTier, 1);
  assert.equal(c.ownerOnlyReply.enabled, false);
});

check('反向同步：用户直接拖档位滑条 → replyGate.mode 跟着改（不会两套真相）', () => {
  let c = configMod.updateConfig({ store: { contextSliderPos: 95 } });
  assert.equal(c.replyGate.mode, 'all', '滑到 4 档必须变成"所有消息都回"');

  c = configMod.updateConfig({ store: { contextSliderPos: 5 } });
  assert.equal(c.replyGate.mode, 'at-any');

  c = configMod.updateConfig({ store: { contextSliderPos: 15, keywords: ['摸鱼'] } });
  assert.equal(c.replyGate.mode, 'at-keyword');
  assert.deepEqual(c.replyGate.keywords, ['摸鱼']);
});

check('落盘一致性：config.json 里的 replyGate 与内存一致（重启后不丢）', () => {
  const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const mem = configMod.getConfig();
  assert.deepEqual(onDisk.replyGate, mem.replyGate);
  assert.equal(onDisk.store.contextSliderPos, mem.store.contextSliderPos);
  assert.equal(onDisk.ownerOnlyReply.enabled, mem.ownerOnlyReply.enabled);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(fail ? `\n回复门槛：通过 ${pass} / 失败 ${fail}` : `\n回复门槛：通过 ${pass} / 失败 0`);
process.exit(fail ? 1 : 0);
