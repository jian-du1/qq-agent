// QQ 空间评论解析：从说说 feed 的 HTML 里把评论（含楼中楼）抠出来。
//
// ── 为什么靠解析 HTML ──
// OneBot 空间动作里**没有任何"读评论"的接口**：get_qzone_feeds / get_qzone_msg_list
// 只返回评论数，不返回评论内容；唯一可能带评论的 msgdetail_v6 是协议端私有函数，
// 没暴露成动作。但实测发现：feed 返回的 html 字段里**带着完整的评论区**（含楼中楼），
// 所以只能从这里解析。这是目前唯一可行的读取途径。
//
// ── 实测结构（真实说说，raw 未压缩）──
//
//   <div class="comments-list ">
//     <li class="comments-item bor3" data-type="commentroot"
//         data-tid="19" data-uin="123456789" data-nick="群友A" data-who="1">
//       <div class="comments-item-bd">
//         <div class="comments-content">
//           <a class="nickname ...">群友A</a>&nbsp; : 测试
//           <div class="comments-op">
//             <span class=" ui-mr10 state" > 22:24 </span>
//             <a class="act-reply" data-param="...t2_uin=123456789&t2_tid=19...">回复</a>
//           </div>
//         </div>
//       </div>
//       <div class="comments-list mod-comments-sub">     ← 楼中楼容器（在父 li 内部！）
//         <ul>
//           <li class="comments-item bor3" data-type="replyroot"
//               data-tid="1" data-uin="123456789" data-nick="群友A" data-who="1">
//             ... <a class="nickname">群友A</a> 回复 群友A : 抓包测试 ...
//           </li>
//         </ul>
//       </div>
//     </li>
//   </div>
//
// ── 三个容易踩的坑（都实测踩过）──
// 1. **楼中楼嵌在父 li 内部**，所以"按 li 切片"会把子回复算进父评论的正文。
//    正确做法：按 li 顺序切片，但每条只取到它自己的 comments-op 为止；子回复因为
//    排在父之后，会被 li 顺序自然切出来，再靠"最近一个 commentroot"归到父名下。
// 2. **正文提取不能用贪婪匹配** —— comments-content 与 comments-op 常常在同一行、
//    而子回复容器在更后面，贪婪匹配会跨过父评论边界把子回复正文一起吞掉。
// 3. **昵称后面有「&nbsp; : 」分隔符**，只删昵称链接的话正文会以「: 」开头。
//
// ⚠️ 解析是**容错**的：QQ 改版会让正则失效。任何异常都返回空数组而不是抛错 ——
//    读不到评论应该是"这次没看到"，不该让整个工具崩掉。

/** 去掉 HTML 标签与实体，压缩空白。 */
function stripTags(s) {
  return String(s == null ? '' : s)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从一条 comments-item 的头部标签里取属性。 */
function attrs(head) {
  const get = (k) => {
    const m = new RegExp(k + '="([^"]*)"').exec(head);
    return m ? m[1] : '';
  };
  return { type: get('data-type'), tid: get('data-tid'), uin: get('data-uin'), nick: get('data-nick') };
}

/**
 * 抽正文。只在传入的**单条 li 区间**内找，且用非贪婪 —— 这样不会跨到子回复。
 * 楼中楼的正文前会有「回复 XXX」前缀，保留下来交给上层解析（用于识别在回谁）。
 */
function bodyOf(itemHtml) {
  const m = /<div class="comments-content">([\s\S]*?)<div class="comments-op"/.exec(itemHtml);
  if (!m) return '';
  // 去掉开头的昵称链接，以及它后面那个「&nbsp; : 」分隔符
  const seg = m[1].replace(/<a class="nickname[\s\S]*?<\/a>/i, ' ');
  return stripTags(seg).replace(/^[:：]\s*/, '');
}

function timeOf(itemHtml) {
  const m = /<span\s+class="\s*ui-mr10 state"\s*>([\s\S]*?)<\/span>/.exec(itemHtml);
  return m ? stripTags(m[1]) : '';
}

/**
 * 解析一段 feed html，返回评论列表（时间顺序，顶层在前、楼中楼紧跟其父之后）。
 *
 * @returns {Array<{tid,uin,nick,text,time,type,parentTid,replyToNick}>}
 */
export function parseComments(html) {
  const out = [];
  try {
    const src = String(html == null ? '' : html);
    const liRe = /<li class="comments-item[^"]*"([^>]*)>/g;
    const marks = [];
    let m;
    while ((m = liRe.exec(src)) !== null) marks.push({ index: m.index, head: m[1] });

    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].index;
      const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
      const chunk = src.slice(start, end);
      const a = attrs(marks[i].head);
      if (!a.tid) continue;
      out.push({
        tid: a.tid,
        uin: a.uin,
        nick: a.nick,
        text: bodyOf(chunk),
        time: timeOf(chunk),
        type: a.type || 'commentroot',
        parentTid: null,
        replyToNick: ''
      });
    }

    // 归父 + 解析「回复 XXX」前缀
    let currentRoot = null;
    for (const c of out) {
      if (c.type === 'commentroot') { currentRoot = c; c.parentTid = null; continue; }
      c.parentTid = currentRoot ? currentRoot.tid : null;
      const mm = /^回复\s*([^\s:：]+)\s*[:：]?\s*/.exec(c.text);
      if (mm) {
        c.replyToNick = mm[1];
        c.text = c.text.slice(mm[0].length).trim();
      }
    }
    return out;
  } catch {
    return [];   // 解析失败 = 这次没读到，不抛错
  }
}

/**
 * 从 get_qzone_feeds 的返回里取出所有说说及其评论。
 * @returns {Array<{tid,ownerUin,ownerNick,time,html,comments}>}
 */
export function postsFromFeeds(feeds) {
  const out = [];
  const list = Array.isArray(feeds) ? feeds : (feeds && typeof feeds === 'object' ? [feeds] : []);
  for (const f of list) {
    const html = String(f?.html == null ? '' : f.html);
    let tid = String(f?.key == null ? '' : f.key);
    if (!tid) {
      const m = /data-tid="([^"]+)"/.exec(html);
      if (m) tid = m[1];
    }
    if (!tid) continue;
    out.push({
      tid,
      ownerUin: String(f?.uin == null ? '' : f.uin),
      ownerNick: String(f?.nickname == null ? '' : f.nickname),
      time: Number(f?.time) || 0,
      html,
      comments: parseComments(html)
    });
  }
  return out;
}