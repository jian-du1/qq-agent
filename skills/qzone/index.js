// QQ 空间技能：发说说 + 管评论。
//
// ══ 这个技能解决什么 ══
// 给模型一个"表达出口"（发 QQ 空间说说，公开可见），以及"回应别人"的能力
// （读自己说说下的评论并回复）。发不发、回不回都由模型自己判断，不是定时任务。
//
// ══ 五条硬保证（都是踩坑换来的，改代码前先读）══
//
// 1. **可见范围由代码写死，现在是「所有人可见」（ugc_right=1）**。2026-11-03 应用户
//    要求从「好友可见」改成公开。仍然不暴露给模型、也不做成可配项 —— 可见范围只由
//    代码决定。要再改就动下面那个常量 + skill.json 里的文案，别开成模型可调参数。
//
// 2. **说说话题只能来自网络热点或模型自己的想法，绝不能来自群聊**。空间是公开的
//    广播（所有人可见），把群聊写进去等于替群友做了"公开"这个决定。
//    防线有三层：提示词硬规矩 → 选题源只给网络热点 → mentionsPersonOrChat 兜底。
//
// 3. **时政一律不发**。checkContent 词表硬拦截，命中直接拒。
//
// 4. **评论只回自己的说说，且一条评论只回一次**。去重记录落盘，重启不丢 ——
//    在别人空间里刷屏比在群里严重得多。
//
// 5. **发不出真楼中楼**。协议端没有对应动作（实测 TRPC 端点也走不通），所以回复
//    评论时发的是**顶层评论**，靠开头 @ 对方标明在回谁。这是无奈之举，别再试了。
//
// ══ 关于 lib/ 下的模块（重要）══
// QQ Agent 的热重载**只给入口文件加时间戳**（plugin-loader.js: `import(entryUrl+'?t=...')`），
// index.js 内部的 `import ... from './lib/xxx.js'` **不带时间戳**，会被 Node 永久缓存。
// 所以：**改了 lib/ 下的文件，热重载不生效，必须重启 QQ Agent。**
// 表现很隐蔽：index.js 是新的、lib 是旧的，工具返回的字段名对但值是空的。
// 为此下面有 stateApi() 防御层和 meme 模块自检，异常时会明确报出来而不是静默失效。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QzoneState } from './lib/state.js';
import { checkContent, mentionsPersonOrChat, isAllowedImageUrl, blockedWordCount } from './lib/safe-topic.js';
import { fetchHotTopics } from './lib/hot.js';
import { pickMemes, parseTitle } from './lib/meme.js';
// ★ 本机补丁 2026-10-17：第二个图源 —— 网上抓图（发表情，有搜索/标签）。
//   用户要求：配图别只局限于鲸鱼娘。见 lib/meme-web.js 顶部的坑与安全边界。
// ★ 本机补丁 2026-10-17 晚：**换源**。原来用发表情(fabiaoqing)，用户反馈
//   「配图有点古老，非常像三流网站里没人用的那种」—— 实测确认那是 2015~2018 的老梗
//   （宝宝委屈、莫生气、干脆面猫、老电影截图）。改为**搜索引擎级**来源：
//   必应图片（主）+ 百度图片（兜底），搜什么词就出这个时代网上真实在用的图。
//   见 lib/meme-search.js 顶部（为什么只用引擎自己托管的图）。
import { searchWebImages, cacheWebImage, relayUrl } from './lib/meme-search.js';
import { postsFromFeeds } from './lib/comments.js';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ══ NapCat 空间扩展插件（HTTP）════════════════════════════════════════
// 背景：NapCat 没有 get_qzone_feeds / comment_qzone 这两个 OneBot 动作，
// 但本机装了一个 NapCat 插件 napcat-plugin-qzone，它用 QQ 内核的 cookie 直接访问
// QZone 网页接口，并通过自己的 HTTP 路由把数据吐出来。
// 所以这里不走 OneBot，改成打插件的本地 HTTP 路由。
//   取数据： GET  /plugin/napcat-plugin-qzone/api/feeds?count=N
//   发评论： POST /plugin/napcat-plugin-qzone/api/comment  {tid, content}
//   自检：   GET  /plugin/napcat-plugin-qzone/api/selftest
// 插件没装/没启用时，这里会明确说清楚，而不是报"网络错误"。
function napcatWebuiPort() {
  try {
    const j = JSON.parse(fs.readFileSync(APP_ROOT + '/napcat/shell/napcat/config/webui.json', 'utf-8'));
    const n = Number(j?.port);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* 读不到就用默认 */ }
  return 6099;
}

const QZONE_EXT = '/plugin/napcat-plugin-qzone/api';
const NO_QZONE_READ = '没连上 QQ 空间扩展插件（napcat-plugin-qzone）。\n'
  + '这个技能要靠那个插件才能读空间说说/评论，现在访问它的本地接口失败了。\n'
  + '排查：① NapCat 是否在跑；② 在 NapCat WebUI（http://127.0.0.1:6099/webui）的插件页确认「QQ空间扩展」已启用；'
  + '③ 如果刚升级过 NapCat，插件可能被禁用了，重新启用后重载即可。\n'
  + '在插件恢复之前，看/回评论都做不了，不要重试、也不要换参数再试。';

async function extGet(pathname, timeoutMs = 20000) {
  const url = `http://127.0.0.1:${napcatWebuiPort()}${QZONE_EXT}${pathname}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const j = await res.json();
  if (!j || j.status !== 'ok') throw new Error(j?.message || `插件返回异常（HTTP ${res.status}）`);
  return j.data;
}

async function extFeeds(count) {
  return extGet(`/feeds?count=${encodeURIComponent(count)}`);
}

async function extComment(tid, content) {
  const url = `http://127.0.0.1:${napcatWebuiPort()}${QZONE_EXT}/comment`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tid, content }),
    signal: AbortSignal.timeout(20000)
  });
  const j = await res.json();
  if (!j || j.status !== 'ok') throw new Error(j?.message || `插件返回异常（HTTP ${res.status}）`);
  return j.data;
}


/** 所有人可见（公开）。2026-11-03 起由用户指定；不暴露给模型，也不做成可配项 —— 可见范围只由代码决定。 */
const UGC_RIGHT_PUBLIC = 1;

let cfg = () => ({});
let log = () => {};
let fetchImpl = null;
let state = null;

function ok(payload) { return { content: JSON.stringify(payload, null, 1) }; }
function err(message) { return { content: String(message), isError: true }; }

function num(key, fallback, min, max) {
  const n = Number(cfg()[key]);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * 评论去重的防御层。
 *
 * 为什么需要：lib/state.js 可能因热重载缓存而停留在旧版（见文件顶部说明）。
 * 缺方法时退回内存实现 —— 代价是重启后丢失去重记录（可能重复回一条），
 * 但总好过整个功能报错不可用（实测就发生过：工具报 `state.hasReplied is not a function`，
 * 模型连试两次都失败，最后只能跟用户说"看不了、工具故障"）。
 */
function stateApi() {
  const mem = (state.__qzoneMemFallback || (state.__qzoneMemFallback = { replied: Object.create(null), seen: Object.create(null) }));
  const has = (name) => state && typeof state[name] === 'function';
  return {
    degraded: !has('hasReplied'),
    hasReplied: has('hasReplied') ? (p, c) => state.hasReplied(p, c) : (p, c) => !!mem.replied[p + ':' + c],
    wasSeen: has('wasSeen') ? (p, c) => state.wasSeen(p, c) : (p, c) => !!mem.seen[p + ':' + c],
    markReplied: has('markReplied')
      ? (p, c, x) => state.markReplied(p, c, x)
      : (p, c, x) => { mem.replied[p + ':' + c] = Object.assign({ ts: Date.now() }, x || {}); },
    markSeen: has('markSeen')
      ? (list) => state.markSeen(list)
      : (list) => { for (const it of (list || [])) mem.seen[it.postTid + ':' + it.commentTid] = { ts: Date.now() }; }
  };
}

/**
 * 检查「回复评论」的正文。
 *
 * 两道闸门都要过：checkContent（时政）**和** mentionsPersonOrChat（隐私）。
 * ⚠️ 早期版本只调了 checkContent，结果"刚才群里有人说这个"被放行并真的发了出去 ——
 *    回复评论这条路悄悄绕过了隐私闸门。所以两个检查缺一不可。
 *
 * 与发布说说的一处**刻意差异**：回复时开头会带 `@某人`，而 mentionsPersonOrChat 会
 * 盯着"XX说"这类表达。所以先把开头的 @提及剥掉再检查 —— 否则每句带 @ 的回复都会被
 * 误拦，而 @ 恰恰是用户明确要求要带上的。
 */
function checkReplyContent(content, nick) {
  let body = String(content == null ? '' : content);
  if (nick) {
    const esc = String(nick).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    body = body.replace(new RegExp('^@' + esc + '\\s*[:：]?\\s*'), '');
  }
  const political = checkContent(body);
  if (!political.ok) return { ok: false, hit: political.hit, kind: 'political' };
  const leak = mentionsPersonOrChat(body);
  if (leak) return { ok: false, hit: leak, kind: 'privacy' };
  return { ok: true, hit: null, kind: null };
}

/**
 * ★ 本机补丁 2026-10-17：安静时段判定（默认 1-7 点）。
 *
 * 用户要求："凌晨这段时间直接把主动说话功能禁用"。主机侧的"主动机会"循环已经停住，
 * 但 qzone 的两条提醒（去看看评论 / 发条说说）原来没有夜间守卫 —— 夜里只要有会话，
 * 她就可能被建议在凌晨发说说或回评论。这里把**整个 qzone 提醒**在夜间静音。
 * 技能不能 import src 里的函数，所以这里自带一份实现（逻辑与 orchestrator 的 quietHoursInfo 一致）。
 * @param {string} spec 形如 "1-7"，支持跨零点（"23-6"）；空/非法 = 不限制
 */
function qzoneInQuietHours(spec, now = new Date()) {
  const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(String(spec || '').trim());
  if (!m) return false;
  const from = Number(m[1]) % 24;
  const to = Number(m[2]) % 24;
  if (from === to) return false;
  const h = now.getHours();
  return from < to ? (h >= from && h < to) : (h >= from || h < to);
}

/**
 * 2026-11-03（用户："干脆不限制"）：设置里 `maxPerWeek = 0` 表示**不限周配额**。
 *
 * 实现上换算成一个近似无穷的大数，而不是去改 lib/state.js 里的比较 ——
 * lib 下的文件热重载不生效（见文件头那段说明），改它就得让用户重启 QQ Agent；
 * 而 index.js 改完立刻生效。state.js 的 `weekCount >= maxPerWeek` 用大数比较天然永远为假，
 * 语义和"没有上限"完全一致。
 */
const UNLIMITED_PER_WEEK = 1e9;
const isUnlimitedWeek = (n) => Number(n) >= UNLIMITED_PER_WEEK;
/** 给模型/日志看的文案：不限 or 具体数字 */
const maxPerWeekLabel = (n) => (isUnlimitedWeek(n) ? '不限' : String(n));

function rules() {
  return {
    maxPerWeek: (() => {
      const raw = Number(cfg().maxPerWeek);
      if (Number.isFinite(raw) && raw <= 0) return UNLIMITED_PER_WEEK;   // 0（或负数）= 不限
      return num('maxPerWeek', 3, 1, 21);                                 // 正数仍夹在 1~21
    })(),
    minGapDays: num('minGapDays', 2, 0, 30),
    cooldownHours: num('cooldownHours', 18, 0, 168),
    noticeGapHours: num('noticeGapHours', 6, 1, 168),
    // v1.4.3：默认 60 → 360 分钟（评论提醒会让当前轮多跑一次 LLM，没评论时纯浪费；空间评论不要求时效）
    commentNoticeGapMin: num('commentNoticeGapMin', 360, 5, 1440),
    // ★ 本机补丁 2026-10-17：配图冷却 —— 最近这么多天用过的图不再重复使用
    memeCooldownDays: num('memeCooldownDays', 7, 0, 60),
    webMemeCount: num('webMemeCount', 6, 1, 12),
    // ★ 本机补丁 2026-10-17（用户："说说都是刷什么视频，能不能偶尔也让 AI 完全自己编写一个"）：
    //   发空间提醒里"原创模式"的比例。0 = 永远走热点素材；1 = 永远自己写；默认 0.35（约三分之一原创）。
    originalRatio: num('originalRatio', 0.35, 0, 1),
    // ★ 安静时段：这段时间不注入任何 qzone 提醒（不去看评论、不建议发说说）
    quietHours: String(cfg().quietHours ?? '1-7'),
    // ★ 2026-10-17：B站/堆糖/必应/百度/发表情均已移除（过气或不稳），只留 memecub
    //
    // ⚠️ 踩坑记录：之前只在 skill.json 里加了 webMemecub，**忘了在 rules() 里定义**，
    //   而选图处写的是 `rules().webMemecub === 1 ? [...]  : []` → undefined 恒不等于 1
    //   → 实际选图时一个网图都不会取（端到端测试直接调库函数，绕过了这行，没抓到）。
    webMemecub: num('webMemecub', 1, 0, 1),
    consolePort: num('consolePort', 3210, 1, 65535)
  };
}
export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  fetchImpl = typeof api.fetch === 'function' ? (...a) => api.fetch(...a) : null;
  state = new QzoneState();

  // 陈旧模块自检：lib/ 下的文件热重载换不掉（见文件顶部说明）。异常时明确喊出来，
  // 免得又靠人肉排查"为什么字段全是空的"。
  try {
    if (!fetchImpl) log('[qzone] ⚠️ 缺少 web_fetch 权限：找选题和挑配图都会失败（发纯文字说说仍可用）');
    const probeOk = typeof parseTitle === 'function' && parseTitle('DeepSeek娘表情包') === null;
    if (!probeOk) log('[qzone] ⚠️ lib/meme.js 没加载成功（拿到旧版或缺失）—— 配图候选的描述会是空的。**重启 QQ Agent 可修复。**');
    const st = stateApi();
    if (st.degraded) log('[qzone] ⚠️ lib/state.js 是旧版（缺 hasReplied）—— 评论去重退化为内存模式，重启会丢。**重启 QQ Agent 可修复。**');
  } catch { /* 自检失败不影响技能加载 */ }

  // ── 工具一：找选题 ──────────────────────────────────────────────────────
  api.registerTool({
    id: 'fetch_qzone_topics',
    name: '找空间选题',
    description: '抓取当前网络热点作为发说说的选题素材。返回的都是已过滤的（只保留游戏/二次元/沙雕搞笑/科技玩梗这类，时政与社会新闻已剔除）。拿到后挑一个你真有想法的，写成自己的口吻再用 publish_qzone_post 发出。**注意：说说的话题只能来自这里或你自己的念头，不能写群里发生的事、不能提任何群友**。不要照抄标题，也不要罗列多条——挑一条说你自己的看法。没有合适的就如实说今天没什么好发的，别硬凑。',
    category: 'media',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回几条素材，默认 12' }
      }
    },
    async execute(ctx, args) {
      try {
        if (!fetchImpl) return err('本技能缺少网络权限（需要在 skill.json 声明 web_fetch）');
        const limit = Math.min(Math.max(Number(args.limit) || 12, 1), 30);
        const r = await fetchHotTopics(fetchImpl, { limit });
        if (r.error) return ok({ found: false, error: r.error, note: '没抓到选题，可以改天再发，或者写一条你自己想说的（同样不能碰群聊内容）。' });
        return ok({
          count: r.topics.length,
          topics: r.topics,
          note: '挑一条你真想吐槽/感慨的，写成自己的口吻（别写成新闻稿）。也可以都不用，写你自己想到的话题。'
        });
      } catch (error) {
        return err('找选题失败：' + (error?.message ?? error));
      }
    }
  });

  // ── 工具二：挑配图表情包 ────────────────────────────────────────────────
  api.registerTool({
    id: 'pick_qzone_meme',
    name: '找配图表情包',
    // ★ 本机补丁 2026-10-17：现在有两个图源，说明里必须讲清楚（否则模型不知道能搜网图）
    description: '从**两个图源**找配图：① DeepSeek娘图库（风格统一，每张有「图上台词」和「内容描述」）；'
      + '② **memecub（专为 AI 做的表情包搜索引擎）**——自带标签（哈基米/奶龙/吗喽/熊猫头…），'
      + '色情/政治人物等由它自己过滤掉，标题和尺寸都是现成的。'
      + '⚠️ **没有候选就直接不配图**：纯文字说说完全正常，硬配一张不搭的图比不配更糟。'
      + '默认两个图源都给候选（source=auto）；只想用图库传 source=gallery，只想用网图传 source=web。'
      + '每张候选都带「内容描述」，按它挑最贴合这条说说的那张。'
      + '用法：先想好这条说说是什么情绪/场景，把对应的词传给 keyword。'
      + '如果返回 matchedKeyword=false，说明图库里没有这个词——看返回的 vocabulary（图库真实标签），换个词再试，最多试两次；'
      + '**还是找不到就干脆不配图**，纯文字说说完全正常，绝对不要硬配一张不搭的图。'
      // ★ 本机补丁 2026-10-17：把"重复排除"写进说明，免得她以为图库出错
      + '⚠️ 图库里最近 7 天用过的图会被**自动排除**（避免说说配图重复）；如果精确命中的都被排除光了，就换个关键词，或者干脆发纯文字。'
      + '选定后把那条的 url 传给 publish_qzone_post 的 image 参数。',
    category: 'media',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '情绪或场景词，如"摸鱼""加班""气鼓鼓""委屈""无语"。不传则随机浏览图库。' },
        category: { type: 'string', description: '按图库分类筛选（基本都是 DeepSeek娘）' },
        limit: { type: 'integer', description: '返回几个候选，默认 6。**只看一张就够，不要一次挑好几张**。' },
        // ★ 本机补丁 2026-10-17
        source: { type: 'string', description: '图源：auto（默认，图库为主、网图补充）| gallery（只用 DeepSeek娘图库）| web（只用网图）', enum: ['auto', 'gallery', 'web'] }
      }
    },
    async execute(ctx, args) {
      try {
        if (!fetchImpl) return err('本技能缺少网络权限（需要在 skill.json 声明 web_fetch）');
        const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 20);
        const keyword = String(args.keyword || '').trim();
        // ★ 本机补丁 2026-10-17：网图来源（发表情）——搜同一个关键词，拿带标题的候选。
        //   注意：这里**只搜不下**，只把原始图址给模型；真正下载发生在 publish 那一步
        //   （见 publish_qzone_post 里的"网图先中转"），这样挑图时零下载、不浪费流量。
        const webPick = async (kw, n) => {
          if (!kw || rules().webMemecub !== 1) return { items: [], error: '网图来源未启用', skipped: [] };
          const want = Math.max(1, Number(n) || 6);
          // ★ 搜索词加「表情包」：不带的话搜「摸鱼」会返回一堆钓鱼/水族箱照片
          const q = /表情包|梗图|沙雕/.test(kw) ? kw : kw + ' 表情包';
          // ★ 2026-10-17 用户定稿：**只留 memecub**。
          //   删掉的（过气/不稳/素材站味）：发表情、必应图片、百度图片、堆糖、B站封面。
          //   没有候选时**直接不配图** —— 用户的原话是"宁可不配图也不要用不匹配的图"。
          const srcs = rules().webMemecub === 1 ? ['memecub'] : [];
          if (!srcs.length) log('[qzone] 网图来源已关闭（webMemecub=0），这条只用本地图库');
          const wr = await searchWebImages(fetchImpl, { keyword: q, limit: Math.min(14, want * 3), sources: srcs });
          if (wr.error) return { items: [], error: wr.error, skipped: [] };
          // ★ 本机补丁 2026-10-17：候选阶段就**下载 + 校验尺寸/长宽比**，只把合格的图
          //   交给模型。为什么必须这么做：实测发表情的结果里混着
          //     · 竖长条文字图（「提醒加班小助手…」那种）—— 配上去会被裁成一条
          //     · 4KB 超小表情 —— 糊
          //   下载过的图会进本地缓存，模型真选中它时不再是重复下载。
          const cacheDir = (process.env.QQ_AGENT_DATA_DIR || (process.cwd() + '/data')) + '/qzone/meme-cache';
          const items = [];
          const skipped = [];
          for (const x of wr.items) {
            if (items.length >= want) break;
            try {
              const c = await cacheWebImage(fetchImpl, x.url, cacheDir);
              items.push({
                来源: '网图（memecub）',
                内容描述: x.desc + '（' + c.size.w + '×' + c.size.h + '）',
                url: relayUrl(rules().consolePort, c.key)
              });
            } catch (e) {
              skipped.push(x.desc.slice(0, 12) + '（' + (e?.message ?? e) + '）');
            }
          }
          return { items, error: '', skipped };
        };
        const r = await pickMemes(fetchImpl, {
          keyword,
          category: String(args.category || ''),
          limit,
          digest: true
        });

        if (r.error) return ok({ found: false, error: r.error, note: '图库没读到，直接发纯文字说说，不配图也完全没问题。' });

        // 关键词命中太少时，扩到"该分类的全部图"再给一批。
        //
        // 为什么需要：图库里有约 652 张图只有「角色名 + 一个 ID」当标题（图库没记录
        // 图上写了什么），**它们不参与关键词匹配**。所以搜"鲸鱼娘"只能拿到 5 条，
        // 而 DeepSeek娘 分类实际上有 1390 张。用户说"发张鲸鱼娘的图"时，他要的是
        // **多样性**，不是那 5 条精确命中的。这里补一批"按角色浏览"的结果，
        // 顺便让模型有机会看到更多选择。
        let extra = [];
        if (r.items.length > 0 && r.items.length < 6) {
          const widest = r.items[0].category || String(args.category || '').trim();
          if (widest) {
            const wide = await pickMemes(fetchImpl, { category: widest, limit: limit, digest: false });
            const seen = new Set(r.items.map((e) => e.original));
            extra = (wide.items || []).filter((e) => !seen.has(e.original)).slice(0, limit);
          }
        }

        if (keyword && r.matchedKeyword === false) {
          // ★ 本机补丁 2026-10-17（用户要求"加点其他的配图"）：
          //   DeepSeek娘图库没有这个词时，**不要直接死路** —— 去网图（发表情）搜同一个词。
          //   网图是别处的表情包，跟图库不重复，选择面大得多。
          const web = await webPick(keyword, rules().webMemeCount);
          // 冷却过滤也要管这里：网图同样不能"最近 7 天发过还再发"
          const usedNow = rules().memeCooldownDays > 0 ? state.recentImages(rules().memeCooldownDays) : new Set();
          const freshWeb = web.items.filter((e) => !usedNow.has(String(e.url || '')));
          if (freshWeb.length) {
            return ok({
              found: true,
              matchedKeyword: true,
              keyword,
              source: 'web',
              candidates: freshWeb,
              note: 'DeepSeek娘图库里没有「' + keyword + '」，下面是从**网图库（memecub）**搜到的候选，'
                + '每条都带它自己的标题 —— 按「内容描述」挑一张**真正贴合这条说说**的；'
                + (web.skipped.length ? '（另有 ' + web.skipped.length + ' 张因尺寸/长宽比不合格被自动剔除）' : '')
            });
          }
          return ok({
            found: false,
            matchedKeyword: false,
            keyword,
            total: r.total,
            vocabulary: r.vocabulary,
            webError: web.error || '',
            note: '图库里没有包含「' + keyword + '」的表情包，网图那边也没搜到（' + (web.error || '无结果') + '）。'
              + '上面 vocabulary 是图库里**真实存在**的标签，挑一个贴近你这条说说情绪的再试（最多再试一次）；'
              + '如果都不搭，就**不要配图**了，直接发纯文字 —— 配一张驴唇不对马嘴的图比不配更糟。'
          });
        }

        // ★ 本机补丁 2026-10-17（用户反馈：说说配图隔一两天就重复）：
        //   排除"最近 memeCooldownDays 天已经用过"的图。原来既不记配图、也不查历史，
        //   全凭图库返回顺序，重复是必然的。
        const cd = rules().memeCooldownDays;
        let usedImgs = new Set();
        try { usedImgs = cd > 0 ? state.recentImages(cd) : new Set(); } catch { usedImgs = new Set(); }
        const keepFresh = (e) => !usedImgs.has(String(e.original || ''));
        // ★ 本机补丁 2026-10-17（用户反馈：配图和说说内容几乎无关）：
        //   extra 是"同类目下没有文字标签的图"，原来无论有没有关键词都会附上，
        //   还写着"想要点新鲜的就从后面挑" —— 这就是配图跑偏的源头。
        //   现在：**给了关键词 = 想要贴合内容 → 只给精确命中的**；
        //   只有"不给关键词、纯浏览"时才附上无标签图。
        if (keyword) extra = [];
        const matchedItems = r.items.filter(keepFresh);
        extra = extra.filter(keepFresh);
        if (usedImgs.size && r.items.length > 0 && matchedItems.length === 0) {
          return ok({
            found: false,
            matchedKeyword: true,
            keyword,
            cooldownDays: cd,
            usedRecently: [...usedImgs].slice(0, 5),
            note: `精确命中的 ${r.items.length} 张图最近 ${cd} 天都发过了（刚用过的图不该再配）`
              + '→ 换个关键词再试一次，或者这条直接发纯文字 —— 重复配图比不配图更糟。'
          });
        }

        // ★ 本机补丁 2026-10-17：图库命中时，再补一批网图候选 —— 图库 95% 是
        //   DeepSeek娘，只给图库等于"配图永远一个样"。source=gallery 可关掉这步。
        // v1.4.2 修复：这里原来判断 rules().webMemeEnabled —— rules() 里根本没这个字段
        //   （只有 webMemecub / webMemeCount），undefined === 1 恒假 → 图库命中时永远不补
        //   memecub 网图候选，新图源只有"图库查无此词"时才会被用到。
        const wantWeb = rules().webMemecub === 1 && String(args.source || 'auto') !== 'gallery';
        const webPickResult = wantWeb ? await webPick(keyword || '', rules().webMemeCount) : { items: [], error: '' };
        const webItems = webPickResult.items.filter((e) => !usedImgs.has(String(e.url || '')));

        const fmt = (e) => ({
          内容描述: e.desc || '（无描述）',
          图上台词: e.label || '（无）',
          分类: e.category,
          url: e.original
        });

        return ok({
          _memeModule: 'v1',
          count: matchedItems.length + extra.length + webItems.length,
          total: r.total,
          matched: r.matched,
          matchedKeyword: r.matchedKeyword,
          candidates: [...matchedItems.map(fmt), ...extra.map(fmt), ...webItems],
          note: (extra.length
            ? '前 ' + matchedItems.length + ' 条是精确命中关键词、且最近没用过的；后面 ' + extra.length + ' 条是同类目下**没有文字标签**的图。'
              + '⚠️ **要贴合说说内容，只能用前面精确命中的那几张**；后面没标签的图只能当「角色图」看，配上去多半跟正文无关（用户反馈过这个问题）。'
            : '从 candidates 里挑**一张**真正贴合这条说说情绪的，把它的 url 传给 publish_qzone_post 的 image 参数。')
            + '判断依据是「内容描述」和「图上台词」——如果没一张搭，就**不配图**，纯文字发。宁可没有配图，也不要配一张不搭的。'
        });
      } catch (error) {
        return err('找配图失败：' + (error?.message ?? error) + '（不配图也能发，直接发纯文字即可）');
      }
    }
  });
  // ── 工具三：发说说 ──────────────────────────────────────────────────────
  api.registerTool({
    id: 'publish_qzone_post',
    name: '发QQ空间说说',
    description: '把一段内容发到自己的 QQ 空间（说说）。可见范围固定为「所有人可见（公开）」，不可更改。内容必须是游戏、二次元、沙雕搞笑、科技玩梗这类轻松话题，并带上你自己的评价或吐槽。'
      + '**绝对不能写群里发生的事、不能提任何群友、不能引用群聊内容**（空间是公开的，写群聊等于泄露别人隐私——而且现在所有人可见，比好友可见严重得多）。'
      + '也不能涉及时政、社会新闻、灾难事故、民族宗教——工具会直接拒绝，被拒了别换说法重试，直接换话题。'
      + '用户明确要求你发（"发条说说""测试一下发空间"）时传 forced=true：这次不受频率限制、也不占本周配额。',
    category: 'media',
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '说说正文。用你平时说话的口吻，一两百字，别写成新闻稿。' },
        image: { type: 'string', description: '可选：配图 URL，从 pick_qzone_meme 拿。留空则发纯文字。' },
        topicTitle: { type: 'string', description: '可选：选题来源的标题，仅用于去重记录' },
        source: { type: 'string', description: '可选：素材来源，如"B站热门"' },
        mood: { type: 'string', description: '可选：这条的情绪，如"吐槽"' },
        forced: { type: 'boolean', description: '用户明确要求发时传 true（不受频率限制、不占配额）' }
      },
      required: ['content']
    },
    async execute(ctx, args) {
      try {
        const content = String(args.content || '').trim();
        if (!content) return err('说说正文不能为空');
        if (content.length > 1500) return err('说说太长了（' + content.length + ' 字），压到 500 字以内。');

        const forced = args.forced === true;
        const r = rules();

        // ★ 本机补丁 2026-10-17：**空间不在凌晨更新**（硬闸）。
        //
        // 用户反馈："我看了 QQ 空间都是凌晨发的"。数据核实 → 改动前 6 条说说
        // 全部落在 23:32~05:29，其中 4 条在凌晨 1~7 点，一条白天的都没有。
        // 链路是：凌晨的"主动机会"会话 → 注入"空间有阵子没更新了，现在是发条的好时机"
        // → 她凌晨发说说。提醒侧已经静音，但"她自己想发"这条路也得挡住，所以加这道硬闸。
        //
        // 例外：用户明确要求发（forced=true）时放行 —— 那是人在指挥，不是她半夜自己冒出来。
        if (!forced && qzoneInQuietHours(r.quietHours)) {
          return err('现在是凌晨（安静时段 ' + r.quietHours + ' 点），空间不在这个点更新 —— 白天有人在的时候再发。'
            + '如果用户就是要现在发（比如让你测试），让用户说一声，再用 forced=true 调一次。');
        }

        // 频率闸门（forced 跳过）
        const gate = state.canPost(r);
        if (!forced && !gate.allowed) {
          return err('现在还不能发：' + gate.reason + '。下次可发时间：'
            + (gate.nextAllowedAt ? new Date(gate.nextAllowedAt).toLocaleString('zh-CN', { hour12: false }) : '未知')
            + '。如实跟用户说就行，不要反复试。');
        }

        // 安全闸门：时政
        const safe = checkContent(content);
        if (!safe.ok) {
          return err('这条内容里有不能发的东西（命中：「' + safe.hit + '」）。空间不能出现时政、社会新闻、灾难事故、民族宗教相关的内容。换一个轻松话题重写，不要换个说法重试同一个话题。');
        }
        // 安全闸门：隐私兜底
        const leak = mentionsPersonOrChat(content);
        if (leak) {
          return err('这条内容提到了人或群聊（「' + leak + '」），不能发。空间是公开的（所有人可见），写群里的人和事等于把群友的聊天记录公开出去。'
            + '请改成只谈公共话题（游戏 / 动画 / 梗 / 科技），用自己的口吻写，不要出现任何群友、也不要复述群里聊了什么。');
        }

        // 配图（可选）
        let image = String(args.image || '').trim();
        let imageNote = '';
        // ★ 本机补丁 2026-10-30：挑图工具给模型的是 /api/qzone-img/<key> 这种本机中转地址，
        //   而 0.4.0 根本没有这个路由。这里把 key 还原成缓存里的真实文件，避免 404。
        {
          const m = /\/api\/qzone-img\/([0-9a-fA-F]+)/.exec(image || '');
          if (m) {
            const cacheDir = (process.env.QQ_AGENT_DATA_DIR || (process.cwd() + '/data')) + '/qzone/meme-cache';
            try {
              const hit = fs.readdirSync(cacheDir).find((f) => f.startsWith(m[1]));
              if (hit) {
                image = 'file:///' + path.join(cacheDir, hit).replace(/\\/g, '/');
                log('[qzone] 中转地址已还原成本地文件：' + image);
              } else {
                image = '';
                imageNote = '（配图缓存找不到，已改发纯文字）';
              }
            } catch {
              image = '';
              imageNote = '（配图缓存读取失败，已改发纯文字）';
            }
          }
        }
        // ★ 本机补丁 2026-10-30：网图下载到本地后，把**本地绝对路径**交给协议端。
        //   原来转成 http://127.0.0.1:3210/api/qzone-img/<key> 让协议端自己来取，
        //   但 QQ Agent 0.4.0 没有这个路由（全 src 搜不到），协议端去下载拿到 404，
        //   于是报「下载文件失败」，整条说说发不出去。
        //   NapCat 的 send_qzone_msg 支持本地路径，直接给文件最稳。
        if (image && /^https?:\/\//i.test(image) && /soutula\.com|mm\.bing\.net|bing\.net|baidu\.com/i.test(image)) {
          try {
            const cacheDir = (process.env.QQ_AGENT_DATA_DIR || (process.cwd() + '/data')) + '/qzone/meme-cache';
            const cached = await cacheWebImage(fetchImpl, image, cacheDir);
            // NapCat 的 send_qzone_msg 只认 URL（实测传纯路径会报「识别URL失败」），
            // 但 file:/// 形式的本地文件是认的 —— 已实测能正常上传。
            image = 'file:///' + String(cached.file).replace(/\\/g, '/');
            log('[qzone] 网图已下载：' + cached.file + '（' + cached.bytes + ' B）→ ' + image);
          } catch (e) {
            imageNote = '（网图下载失败，已改发纯文字：' + (e?.message ?? e) + '）';
            image = '';
          }
        }
        // 白名单只针对「还是 http 地址」的情况；本地文件不适用
        if (image && /^https?:\/\//i.test(image) && !isAllowedImageUrl(image)) {
          imageNote = '（给的配图地址不在允许的图床白名单里，已忽略，改发纯文字）';
          image = '';
        }

        const post = async (withImage) => ctx.onebot.call('send_qzone_msg', {
          content,
          ugc_right: UGC_RIGHT_PUBLIC,
          ...(withImage ? { images: [withImage] } : {})
        });

        let resp;
        let attached = !!image;
        try {
          resp = await post(image || null);
        } catch (e) {
          if (!image) { state.markAttempt(); return err('发布失败：' + (e?.message ?? e)); }
          // 配图失败就退回纯文字，别让整条说说发不出去
          imageNote = '（配图上传失败，已改发纯文字：' + (e?.message ?? e) + '）';
          attached = false;
          resp = await post(null);
        }

        const tid = resp?.tid ?? resp?.data?.tid ?? null;
        state.recordPost({
          content,
          title: args.topicTitle || '',
          tid,
          source: args.source || '',
          mood: args.mood || '',
          counted: !forced,
          image: attached ? image : ''   // ★ 本机补丁：记下配图，供「别重复」用
        });
        state.markAttempt();

        const gateAfter = state.canPost(r);
        const weekNow = forced ? gate.weekCount : gate.weekCount + 1;
        log('[qzone] 已发说说 长度=' + content.length + ' 配图=' + (attached ? '有' : '无') + ' tid=' + (tid ?? '未知')
          + (forced ? '（用户强制，不计数）' : '本周第 ' + weekNow + ' 条'));

        return ok({
          posted: true,
          visibility: '所有人可见（公开）',
          length: content.length,
          withImage: attached,
          ...(attached ? {} : { whyNoImage: imageNote || '这条没配图——没有合适的表情包，纯文字发。这是正常的，不需要补救。' }),
          forced,
          counted: !forced,
          tid: tid != null ? String(tid) : null,
          weekCount: weekNow,
          maxPerWeek: isUnlimitedWeek(r.maxPerWeek) ? null : r.maxPerWeek,
          unlimitedPerWeek: isUnlimitedWeek(r.maxPerWeek),
          nextAllowed: gateAfter.nextAllowedAt
            ? new Date(gateAfter.nextAllowedAt).toLocaleString('zh-CN', { hour12: false })
            : null,
          note: (imageNote ? imageNote + ' ' : '')
            + (forced ? '（这条是用户明确要求发的，没占本周配额，也不影响下次自动发的时间。）' : '')
            + '已经发出去了。回复里不要复述整段内容，也别播报"我发了条说说"这种机器话，正常接话或简单说一句就行。'
        });
      } catch (error) {
        return err('发布失败：' + (error?.message ?? error));
      }
    }
  });
  // ── 工具四：查看别人在说说下的评论 ──────────────────────────────────────
  //
  // 为什么要有这个：模型没有跨运行的记忆，而评论是异步到达的。不给它一个"去看看
  // 有没有人评论"的入口，它就永远不知道有人回了它 —— 也就谈不上回复。
  api.registerTool({
    id: 'qzone_check_comments',
    name: '查看空间评论',
    description: '查看机器人自己说说下面有没有新的评论（包括楼中楼里的回复）。返回还没回复过的评论和已经回复过的。'
      + '用户问"有人评论你吗""空间有什么动静""看看有没有人回你"时用它；系统提醒你空间有人评论时也用它。',
    category: 'media',
    icon: '💬',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多看几条说说，默认 10，最多 20' },
        tid: { type: 'string', description: '可选。指定某条说说的 id（tid），直接查这条下面的评论，不依赖「最近几条说说」列表。用户在聊某条具体动态、或那条已经不在最近列表里时用它。' },
        uin: { type: 'string', description: '可选。这条说说是谁发的（QQ号）。查机器人自己的说说可以不填。' }
      }
    },
    async execute(ctx, args) {
      try {
        const n = Math.min(Math.max(Number(args.limit) || 10, 1), 20);
        const wantTid = String(args.tid ?? '').trim();
        let posts;
        if (wantTid) {
          // 指定了 tid：直接查这条说说下的评论，不受「最近 N 条」限制
          let d;
          try {
            d = await extGet('/comments?tid=' + encodeURIComponent(wantTid)
              + (args.uin ? '&uin=' + encodeURIComponent(String(args.uin)) : ''));
          } catch (e) {
            return err(NO_QZONE_READ + '\n（具体错误：' + (e?.message ?? e) + '）');
          }
          posts = postsFromFeeds([{ key: wantTid, uin: String(args.uin || ctx.selfId || ''), html: d?.html || '' }]);
          if (!posts.length) return ok({ found: false, note: '这条说说没查到（id 不对 / 已删除 / 没权限）。如实说查不到就行。' });
        } else {
          let feeds;
          try {
            feeds = await extFeeds(n);
          } catch (e) {
            return err(NO_QZONE_READ + '\n（具体错误：' + (e?.message ?? e) + '）');
          }
          posts = postsFromFeeds(feeds?.feeds ?? feeds);
        }
        if (!posts.length) {
          return ok({ found: false, note: '这次没读到说说（可能动态流为空或接口抽风）。如实说没看到就行，不要编造评论内容。' });
        }
        const selfUin = String(ctx.selfId || '');
        const st = stateApi();
        const need = [];
        const done = [];
        for (const p of posts) {
          if (selfUin && p.ownerUin && p.ownerUin !== selfUin) continue;   // 只看机器人自己的说说
          for (const c of p.comments) {
            if (c.uin && selfUin && c.uin === selfUin) continue;           // 自己发的不算
            const item = {
              postTid: p.tid,
              评论id: c.tid,
              作者: c.nick,
              作者QQ: c.uin,
              时间: c.time,
              内容: c.text,
              类型: c.type === 'replyroot' ? '楼中楼回复' : '顶层评论',
              在回谁: c.replyToNick || undefined
            };
            if (st.hasReplied(p.tid, c.tid)) done.push(item);
            else if (!st.wasSeen(p.tid, c.tid)) need.push(item);
          }
        }
        // 标记为"已看过"：模型这次没回的话，下轮不再推荐（避免反复骚扰它）
        st.markSeen(need.map((x) => ({ postTid: x.postTid, commentTid: x.评论id })));
        return ok({
          count: need.length,
          needReply: need,
          alreadyReplied: done.slice(0, 10),
          note: need.length
            ? '上面 needReply 是还没回过的评论。挑值得回的，调 qzone_reply_comment 用一条长评论回掉（一次只回一条，不要连发）；不值得回的就别理，不用有心理负担。**别在聊天里播报你查评论这件事。**'
              + '想回哪条时把它的「评论id」当 commentTid、「作者」当 nickname 传过去（targetUin 填上便于识别，但它不会被发出去）。'
            : '没有新的评论需要回。**（这个结果只给你自己看 —— 不要在群里/私聊里说「没有新评论」「不用处理」这类话，也不要写进收尾总结）**'
        });
      } catch (error) {
        return err('查看评论失败：' + (error?.message ?? error));
      }
    }
  });

  // ── 工具五：回复评论 ────────────────────────────────────────────────────
  //
  // ⚠️⚠️ 绝对不要传 target_uin！⚠️⚠️
  //
  // 踩过的坑（实机，浪费了很多轮）：comment_qzone 的 target_uin 是
  // 「**这条说说属于谁的空间**」，不是"回复给谁"。我一开始想当然地把它当成"被回复者"，
  // 传了评论者的 QQ，于是 QZone 跑去**评论者的空间**找这条说说 —— 找不到，就回一句
  // 极具误导性的 `code=-10052 该条内容已被删除`。现象是"评论明明还在、却说过期了"，
  // 而同样的 tid 不传该参数就立刻成功。
  // 我们的场景永远是"回复机器人自己说说下的评论"，所以让它取默认值才对。
  api.registerTool({
    id: 'qzone_reply_comment',
    name: '回复空间评论',
    description: '在机器人的说说下面发一条评论，用来回应别人的评论。会在开头自动加上「@对方昵称」，这是故意的——'
      + '因为发不出真正的楼中楼，靠 @ 标明在回谁。一次只发一条长句，不要连发多条（会像刷屏）。'
      + 'commentTid / targetUin / nickname 都从 qzone_check_comments 的结果里拿。只回机器人自己说说下的评论，不能去别人的空间评论。',
    category: 'media',
    icon: '↩️',
    parameters: {
      type: 'object',
      properties: {
        postTid: { type: 'string', description: '说说 id（qzone_check_comments 结果里的 postTid）' },
        commentTid: { type: 'string', description: '要回复的那条评论的 id（结果里的「评论id」）' },
        targetUin: { type: ['integer', 'string'], description: '被回复者的 QQ 号（结果里的「作者QQ」）。**只用于识别在回谁，不会发给空间**。' },
        nickname: { type: 'string', description: '被回复者的昵称（结果里的「作者」），用于拼 @前缀' },
        content: { type: 'string', description: '回复正文。不要再自己带 @——工具会自动加。一两句话、一条说完，别分点。' }
      },
      required: ['postTid', 'commentTid', 'content']
    },
    async execute(ctx, args) {
      try {
        
        const postTid = String(args.postTid ?? '').trim();
        const commentTid = String(args.commentTid ?? '').trim();
        if (!postTid) return err('缺少 postTid：先用 qzone_check_comments 拿到说说 id。');
        if (!commentTid) return err('缺少 commentTid：先用 qzone_check_comments 拿到评论 id。');

        let body = String(args.content ?? '').trim();
        if (!body) return err('回复正文不能为空');
        if (body.length > 500) return err('回复太长了（' + body.length + ' 字）。评论要短，压到 200 字以内，一条说完。');
        body = body.replace(/^@[^\s:：]{1,20}\s*[:：]?\s*/, '');   // 模型自己带了 @ 就别加两遍

        const nick = String(args.nickname ?? '').trim().slice(0, 20);
        const text = nick ? '@' + nick + ' ' + body : body;

        const safe = checkReplyContent(text, nick);
        if (!safe.ok) {
          if (safe.kind === 'political') {
            return err('这条回复里有不能发的内容（命中：「' + safe.hit + '」）。空间评论同样不能出现时政、社会新闻、灾难事故、民族宗教相关的内容。换一句重写。');
          }
          return err('这条回复里提到了群聊或人（命中：「' + safe.hit + '」），不能发。'
            + '空间评论是公开的（所有人可见），写群里的人和事等于把群友的聊天记录公开出去。'
            + '请只回应对方评论本身的内容，不要提群里发生了什么、也不要复述别人的话。');
        }

        const st = stateApi();
        if (st.hasReplied(postTid, commentTid)) {
          return err('这条评论你已经回过了，不要重复回复。换一条，或者就不回了。');
        }

        const callComment = () => extComment(postTid, text);

        // 对 QZone 的「该条内容已被删除」做一次重试。
        // 实测这条报错经常是假警报（评论明明还在，重发立刻成功）—— 多半是后端状态
        // 同步延迟。只在 code=-10052 时重试：它表示"引用不存在、尚未写入"，
        // 重试不会产生重复评论。其它错误一律不重试，避免真的刷屏。
        let resp;
        try {
          resp = await callComment();
        } catch (e) {
          const msg = String(e?.message ?? e);
          if (!msg.includes('-10052')) throw e;
          log('[qzone] 回复遇到 -10052（该条内容已被删除），疑似同步延迟，2 秒后重试一次');
          await new Promise((r) => setTimeout(r, 2000));
          resp = await callComment();
        }

        const commentId = (resp && (resp.comment_id ?? resp.data?.comment_id)) || '';
        st.markReplied(postTid, commentTid, { nick, replyCommentId: commentId || null });
        log('[qzone] 已回复评论 post=' + postTid + ' cid=' + commentTid + ' to=' + (nick || '?') + ' len=' + text.length);

        return ok({
          replied: true,
          sentAs: text.slice(0, 200),
          commentId: commentId || null,
          hint: '已经回出去了。回复里不要再重复这段内容，也别播报"我回复了评论"，正常接话或结束即可。'
        });
      } catch (error) {
        const msg = String(error?.message ?? error);
        if (msg.includes('-10052')) {
          return err('回复失败：QQ 空间说「该条内容已被删除」（重试一次仍失败）。'
            + '这通常是它自己的状态同步延迟，不是真的删了 —— 也可能对方确实刚把评论删了。'
            + '不要反复重试。如实跟用户说一句"回的时候空间说评论没了"就行，不要说成工具故障。');
        }
        return err('回复评论失败：' + msg);
      }
    }
  });

  // ── 工具六：查状态 ──────────────────────────────────────────────────────
  api.registerTool({
    id: 'qzone_status',
    name: '查看空间状态',
    description: '查看 QQ 空间的发布状态：现在能不能发、下次什么时候能发、最近发过哪些。用户问"你空间发了吗""下次什么时候发""你都发过什么"时用它。',
    category: 'media',
    icon: '📊',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const r = rules();
        const gate = state.canPost(r);
        const recent = state.recent(30, false).slice(0, 8).map((p) => ({
          时间: new Date(p.ts).toLocaleString('zh-CN', { hour12: false }),
          标题: p.title || '',
          摘要: String(p.content || '').slice(0, 60),
          计入配额: p.counted !== false
        }));
        const st = stateApi();
        const replied = Object.keys(state.data?.repliedComments || {}).length;
        return ok({
          canPostNow: gate.allowed,
          reason: gate.allowed ? null : gate.reason,
          nextAllowed: gate.nextAllowedAt ? new Date(gate.nextAllowedAt).toLocaleString('zh-CN', { hour12: false }) : null,
          weekCount: gate.weekCount,
          maxPerWeek: isUnlimitedWeek(gate.maxPerWeek) ? null : gate.maxPerWeek,
          unlimitedPerWeek: isUnlimitedWeek(gate.maxPerWeek),
          visibility: '所有人可见（公开）',
          blockedWords: blockedWordCount(),
          repliedComments: replied,
          stateModule: st.degraded ? '旧版（去重退化为内存）' : '正常',
          recentPosts: recent
        });
      } catch (error) {
        return err('查状态失败：' + (error?.message ?? error));
      }
    }
  });
}
/**
 * 注入提醒。两段独立逻辑，各自有节流。
 *
 * ⚠️ 早期版本把两段写在一起，用 `if (!gate.allowed) return;` 提前退出 ——
 *    结果**发说说的配额用完后，评论提醒也永远不会触发**。所以现在两段分开走。
 *
 * 为什么需要"提醒"这种东西：模型不会自己想起来去看评论、也不会自己想起来发说说。
 * 到点了提一句，它才有机会做决定。但它**完全可以不做** —— 提醒里明确写了这点。
 */
export const hooks = {
  async 'before-llm-messages'(ctx) {
    // ★ 本机补丁 2026-10-17：安静时段不提醒、不主动说话（评论提醒 + 发说说提醒一起静音）
    if (qzoneInQuietHours(rules().quietHours)) return;
    if (!state) return;
    const messages = Array.isArray(ctx?.messages) ? ctx.messages : null;
    if (!messages?.length) return;
    const last = messages[messages.length - 1];
    const canAppend = last && typeof last.content === 'string';

    const now = Date.now();

    // ── ① 有人在说说下评论了吗？ ──
    // 评论是异步来的，模型平时不会自己想起来去看。所以定期提一句，让它调
    // qzone_check_comments 去看 —— 注意这里是**提醒它去查**，不是直接告诉它
    // "有人评论了"（hook 里不调接口：怕慢，且一次 OneBot 调用换一句提醒不划算）。
    //
    // ⚠️ 措辞刻意写成"顺路看一眼"而不是"你有个待办"，并且明确写出"大概率没有"。
    //    原因：这段文字每轮都进上下文，**出现本身就有权重**。早期版本写成任务口吻时，
    //    模型的结束总结里开始固定出现"空间无新评论需回"——它把查评论当成了例行公事。
    //    评论回复本来就不要求时效，宁可少提、提得轻。
    if (canAppend) {
      const cmtGapMs = rules().commentNoticeGapMin * 60000;
      const lastCmtCheck = Number(state.data.lastCommentCheck) || 0;
      if (now - lastCmtCheck >= cmtGapMs) {
        state.data.lastCommentCheck = now;
        try { state.markAttempt(); } catch { /* 节流失败不影响提醒 */ }
        last.content += '\n\n[顺带一提] 空间那边隔了挺久了 —— **花 10 秒**用 qzone_check_comments 扫一眼，'
          + '看有没有人评论或在楼中楼回你；有值得接的就用 qzone_reply_comment 回一条（会自动 @ 对方）。'
          + '真的没有就算了，不用回、不用提，也**别把它写进你的收尾总结里**（这个提醒隔很久才来一次）。'
          + '**不管结果如何都别在群里说**（不要说"没有新评论""不用处理"这类话 —— 那是在播报工具状态，不是聊天）。';
        log('[qzone] 已注入"去看看评论"提醒');
      }
    }

    // ── ② 是不是该发新说说了？ ──
    const r = rules();
    const gate = state.canPost(r);
    if (!gate.allowed) return;      // 配额/冷却没过 → 不发，但上面的评论提醒已经独立走过了

    const noticeGapMs = r.noticeGapHours * 3600000;
    const lastNotice = Number(state.data.lastNotice) || 0;
    if (now - lastNotice < noticeGapMs) return;
    state.data.lastNotice = now;
    try { state.markAttempt(); } catch { /* 节流失败不影响提醒 */ }

    const recent = state.recentTopics(6);
    // ★ 本机补丁 2026-10-17：两种模式 —— 原来的提醒只教"看热点"，于是每条说说都是"刷到个…"。
    //   现在按 originalRatio 概率切换：热点模式（照旧）／原创模式（完全她自己写）。
    const originalRatio = Math.max(0, Math.min(1, Number(r.originalRatio) || 0));
    const useOriginal = originalRatio > 0 && Math.random() < originalRatio;

    const head = '\n\n[系统提示·没人要求你做任何事] 你的 QQ 空间有阵子没更新了，'
      + (isUnlimitedWeek(r.maxPerWeek)
        ? '周配额不限制，'
        : '本周还没发满（上限 ' + r.maxPerWeek + ' 条），')
      + '现在是发一条的好时机。';
    const howto = useOriginal
      ? '★ 这一条**不要用网上的热点素材**（这次别调 fetch_qzone_topics）—— 写一条**完全你自己的**：'
        + '你**自己**刚想到的东西、你对某个事物的看法、或者你这边正在发生的变化，'
        + '写成你自己的口吻（一两百字，别写成总结）。'
        + '素材从**你自己这边**取：你此刻的状态、今天的生活规划、你手上正在忙的活 —— '
        + '那是「你的日子」，比转述别人的视频真实得多。\n'
        // ★ 本机补丁 2026-10-17（用户问：刚发生的事会不会透露别人的聊天记录）：
        //   **会** —— 「有人找我聊了会天」「有人私聊我」这类就是别人的事。代码层有
        //   mentionsPersonOrChat 兜底（实测 38/38），提示词这层也要把话说死。
        + '⛔ **不许把别人的事写进去**：别写谁找过你、谁问过你什么、谁跟你说了什么、'
        + '群里聊过什么 —— 空间是公开的（所有人可见），那等于替别人做了公开的决定。\n'
        + '要写就写**你自己**：你的状态、你的想法、你手上在忙的活、你这边发生的变化。\n'
        + '**别用「刷到」「看到有人」这类开头** —— 这条不是转述，是你自己在说话。\n'
        + '写完调 publish_qzone_post 发出去（公开可见，不用你设置）。'
      : '发的话：先调 fetch_qzone_topics 看看网上有什么热点，挑一条你真想吐槽/感慨的，'
        + '写成你自己的口吻（别写成新闻稿），再调 publish_qzone_post 发出去——可见范围是公开（所有人可见），不用你设置。';
    const nudge = head + howto
      + '想配图就先调 pick_qzone_meme，挑一张真搭的；**找不到搭的就别配图**，纯文字同样正常。'
      // 这段是隐私防线的关键：明确切断"群聊 → 说说"的联想
      + '**注意：说说的话题只能来自网络热点或你自己的想法，不要写群里刚聊的事、不要提任何群友、不要复述任何人的话。**'
      + '空间是公开的（所有人可见），把群聊写进去等于替群友做了公开的决定。'
      + '内容只能是游戏、二次元、沙雕搞笑、科技玩梗这类轻松话题，任何时政相关的一律不行。'
      + (recent.length ? '你最近发过这些，别重复：' + recent.join('；') + '。' : '')
      + '不想发也完全可以，那就当没看见这条提醒。'
      + '（这条只是提醒，发不发你自己判断。）';

    if (canAppend) last.content += nudge;
    log('[qzone] 已注入发空间提醒（本周 ' + gate.weekCount + '/' + maxPerWeekLabel(r.maxPerWeek) + '，' + (useOriginal ? '原创模式' : '热点模式') + '）');
  }
};