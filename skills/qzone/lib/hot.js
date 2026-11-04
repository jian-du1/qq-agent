// 找选题：从 B 站热门拉一批内容，过滤成"能用于空间说说"的题材。
//
// ── 为什么是 B 站 ──
// 空间说说的话题**只能来自网络热点或模型自己的想法**，绝不能来自群聊（隐私）。
// 所以需要一个"公开的、轻松的、跟群聊无关"的素材源。B 站热门正合适：游戏/动画/
// 数码/搞笑为主，时政含量低。
//
// ── 实测的接口状况 ──
//   · ranking/v2（排行榜）→ 被风控拒绝（code=-352），不可用
//   · popular（热门）    → 正常，返回 20 条 {title, desc, tname, owner}
//   所以只用 popular。
//
// ── 两道过滤 ──
// 1. **题材白名单**：只保留游戏/动画/搞笑/数码/科技这类。B 站热门里也会有社会
//    新闻类内容，直接按 tname 剔除比事后检查更可靠（从源头断掉）。
// 2. **时政词过滤**：白名单保不干净的（比如游戏区标题里夹带时事），再过一遍
//    safe-topic 的词表。
//
// ⚠️ 只取 title/desc/tname，**不取 up 主名字** —— 取名字等于给了模型一个"人名"，
//    虽然提示词禁止它写人，但少给一个诱因更稳。

import { checkContent } from './safe-topic.js';

const POPULAR_URL = 'https://api.bilibili.com/x/web-interface/popular?ps=30&pn=1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 允许的题材（tname 里包含其一即可）。 */
const ALLOWED_TOPICS = [
  '游戏', '单机游戏', '网络游戏', '手机游戏', '电子竞技', '桌游',
  '动画', '番剧', '国创', '漫画', '特摄', '手办', 'cos',
  '搞笑', '鬼畜', '生活', '日常', '美食', '动物', '萌宠',
  '数码', '科技', '计算机', '科工机械', '软件应用', 'AI',
  '音乐', '舞蹈', '绘画', '设计', '创意',
  '篮球', '足球', '运动', '健身',
  '影视', '电影', '电视剧', '综艺', '纪录片'
];

/** 明确要排除的题材。 */
const BLOCKED_TOPICS = ['时事', '新闻', '社会', '政治', '军事', '财经', '法律', '三农'];

/**
 * 拉一批可用作选题的热点。
 * @param {Function} fetchImpl 注入的 fetch
 * @param {{limit?:number}} opts
 * @returns {{topics:Array, error?:string}}
 */
export async function fetchHotTopics(fetchImpl, opts) {
  const o = opts || {};
  const limit = Math.min(Math.max(Number(o.limit) || 12, 1), 30);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  let raw;
  try {
    const res = await fetchImpl(POPULAR_URL, {
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', accept: 'application/json' },
      signal: ctl.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    raw = await res.json();
  } finally { clearTimeout(timer); }

  if (raw && raw.code !== 0) {
    return { topics: [], error: 'B站接口返回 code=' + raw.code + '（可能被风控，过会儿再试）' };
  }
  const list = raw && raw.data && Array.isArray(raw.data.list) ? raw.data.list : null;
  if (!list) return { topics: [], error: 'B站返回结构不认识' };

  const out = [];
  for (const v of list) {
    const tname = String(v.tname || '');
    if (BLOCKED_TOPICS.some((b) => tname.includes(b))) continue;
    if (!ALLOWED_TOPICS.some((a) => tname.includes(a))) continue;

    const title = String(v.title || '').trim();
    const desc = String(v.desc || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;

    // 时政过滤：标题和简介都要干净
    if (!checkContent(title).ok) continue;
    if (desc && !checkContent(desc).ok) continue;

    out.push({
      标题: title,
      简介: desc && desc !== '-' ? desc.slice(0, 120) : '',
      题材: tname ? [tname] : []
    });
    if (out.length >= limit) break;
  }

  if (!out.length) return { topics: [], error: '这次没抓到合适的选题（都被题材/时政过滤掉了）' };
  return { topics: out };
}