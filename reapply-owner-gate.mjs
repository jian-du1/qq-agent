// 重放「主人@门禁」补丁（owner-gate）
//
// 背景：QQ Agent 的插件钩子（before-context / before-llm-messages …）都跑在
// **会话已经创建之后**，拿不到"要不要唤醒"这一层，所以无法做成零 token 的插件。
// 唯一能做到"零 token"的位置是 orchestrator.onIncoming 的触发判定，因此这里是
// 一个核心补丁，而不是插件。
//
// 作用：群聊里只有「主人 + @机器人（或被拍一拍）」才会创建会话、调用模型；
//       其余消息当场标已读，不消耗任何 token。私聊不受影响。
//
// 升级 QQ Agent 后重跑一次即可（幂等：补丁已在就跳过）：
//   runtime\node.exe reapply-owner-gate.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, 'src', 'config.js');
const ORCH = path.join(HERE, 'src', 'orchestrator.js');

const log = (...a) => console.log('[owner-gate]', ...a);

// ── 补丁 1：config.js 默认值 ──
const CFG_ANCHOR = '  blocklist: {},';
const CFG_ADD = `  blocklist: {},
  // 主人@门禁（本地补丁 owner-gate）：群聊里只有「主人 + @机器人」才允许唤醒会话。
  // 命中在 onIncoming 的判定阶段，不建会话、不调模型 —— 零 token。
  // ids 支持逗号/空格/中文逗号分隔；私聊不受影响（私聊本来就没有 @ 的概念）。
  ownerOnlyReply: {
    enabled: false,
    ids: ''
  },`;

// ── 补丁 2：orchestrator.js 门禁 + import ──
const IMPORT_OLD = "import { buildSystemPrompt, buildUserPrompt, resolveContextTier } from './prompt.js';";
const IMPORT_NEW = "import { buildSystemPrompt, buildUserPrompt, resolveContextTier, isAtMe } from './prompt.js';";

const GATE_ANCHOR = "    if (!String(cfg.api.model || '').trim()) return;";
const GATE_ADD = `    if (!String(cfg.api.model || '').trim()) return;

    // ── 补丁 owner-gate（本地）────────────────────────────────────────────
    // 群聊里只认「主人 + @我（或拍一拍我）」：不满足就当场标已读并返回，
    // 不建会话、不组装提示词、不调模型 —— 零 token。
    // 配置：config.ownerOnlyReply = { enabled, ids }，私聊不受影响。
    {
      const oor = cfg.ownerOnlyReply;
      if (oor && oor.enabled === true && String(chatKey).startsWith('group:')) {
        const owners = String(oor.ids || '')
          .split(/[,，、;；\\s]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        const cand = entry || (this.store.peekUnread(chatKey, 1) || [])[0] || null;
        const senderId = String(cand?.senderId ?? '');
        const atMe = cand
          ? (typeof cand.atMe === 'boolean'
              ? cand.atMe === true
              : isAtMe(String(cand.text ?? ''), {
                  selfNickname: cfg.persona?.selfNickname || this.onebot.selfNickname || '',
                  botName: cfg.persona?.botName || '',
                  selfId: cfg.onebot?.selfId || this.onebot.selfId || ''
                }))
          : false;
        const pokeMe = cand?.isPoke === true;
        if (!(owners.includes(senderId) && (atMe || pokeMe))) {
          if (entry) this.store.markEntryRead(chatKey, entry.id);
          else this.store.markAllRead(chatKey);
          this.emit('chat-update', chatKey);
          return;
        }
      }
    }
`;

function patch(file, jobs) {
  let src = fs.readFileSync(file, 'utf8');
  let changed = 0;
  for (const job of jobs) {
    if (src.includes(job.marker)) {
      log(`已存在，跳过：${job.name}`);
      continue;
    }
    if (!src.includes(job.anchor)) {
      log(`⚠ 找不到锚点，跳过：${job.name}`);
      continue;
    }
    src = src.replace(job.anchor, job.replace);
    changed += 1;
    log(`已打补丁：${job.name}`);
  }
  if (changed) {
    fs.writeFileSync(file, src, 'utf8');
    log(`写回：${path.relative(HERE, file)}`);
  }
  return changed;
}

const c1 = patch(CONFIG, [
  { name: 'config.js 默认值 ownerOnlyReply', marker: 'ownerOnlyReply', anchor: CFG_ANCHOR, replace: CFG_ADD }
]);

const c2 = patch(ORCH, [
  { name: 'orchestrator.js import isAtMe', marker: 'resolveContextTier, isAtMe', anchor: IMPORT_OLD, replace: IMPORT_NEW },
  { name: 'orchestrator.js owner-gate', marker: '补丁 owner-gate', anchor: GATE_ANCHOR, replace: GATE_ADD }
]);

const total = c1 + c2;
log(total ? `完成，共改动 ${total} 处。重启控制台生效。` : '四处补丁都已经在，无需处理。');
