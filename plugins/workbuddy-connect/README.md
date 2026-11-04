# WorkBuddy 额度接入（workbuddy-connect）

把 QQ Agent 机器人的「大脑」接到 **WorkBuddy**（腾讯 CodeBuddy 国内版 / workbuddy.ai 国际版）的模型额度上。
机器人的人格、工具、记忆、上下文全都不变，只是每次模型调用从「DeepSeek 官方 API 按 token 扣钱」
变成「消耗 WorkBuddy 账号里的额度」。

> 移植自 DeepSeek Harness 插件 **dsh-connect-workbuddy v5.6.2**（作者 dingminhua，MIT）。
> 功能对齐：同样的网关协议适配、同样的错误翻译、同样的渠道校验自救；区别在于宿主从 DSH 换成了
> QQ Agent，并且不需要任何 Electron 原生模块（只读本机明文凭据库）。
> **账号池不在移植范围内**：原插件的多账号表格/排序/签到/扫码加号依赖 DSH 的自定义设置卡片，
> QQ Agent 的扩展机制只支持简单设置表单。本插件的能力上限是「每区域一个账号 + 双区域兜底」，
> 详见第五节。

---

## 一、为什么做成「插件」而不是「技能」

项目的判定标准（README「扩展开发」第 0 节 + `src/skills/manifest.js` 的 `DIR_KIND`）：

| | `plugins/`（确定性型） | `skills/`（LLM 型） |
|---|---|---|
| 谁决定执行 | 核心在固定时机**必然调用** | 模型自己判断要不要用 |
| 能做什么 | 提供能力（providers）/ 钩子（hooks） | 注册工具 + 提示词片段 |
| 典型例子 | 定时抓取、缓存优化、**改写请求地址** | 查天气、查热梗、发图 |

「把每次模型调用的目标地址换掉，并做协议转译」这件事：

* 不需要模型做任何判断（更不该让模型决定要不要省钱）；
* 必须**必然发生**，否则等于没接；
* 技能体系根本碰不到「请求发往哪里」—— 技能只能影响模型能调哪些工具。

所以只能是 `plugins/`。核心提供的挂载点是能力 **`llm.endpoint-pick`**
（`src/llm.js:274-294`）：每次发请求前同步询问，返回 `{baseUrl, apiKey, model}` 就改写这次调用的目标。

---

## 二、安装 / 卸载

* 安装位置：`<QQ Agent>/resources/app/plugins/workbuddy-connect/`
  文件：`plugin.json`、`index.js`、`lib/*.js`、`README.md`
* 项目开了热重载（`src/plugin-loader.js`，fs.watch + 500ms 防抖），文件落盘即自动加载，
  **不需要重启 QQ Agent，也不需要刷新页面**（刷新一下技能/插件页能看到新条目）。
* 卸载：在 QQ Agent 的「插件」页点删除，或直接删掉这个目录。删掉后机器人立刻回到官方 API 配置。
* 开关：插件页的启用开关 = `config.skills['workbuddy-connect'].enabled`；
  插件设置里的「接管机器人的模型调用」= `takeover`，用来临时切回官方 API 而保留插件。

---

## 三、它怎么工作

```
QQ Agent (src/llm.js)
   │  ① 发请求前问能力 llm.endpoint-pick
   ▼
workbuddy-connect  →  返回 { baseUrl: http://127.0.0.1:<port>/v1, model }
   │
   │  ② POST /v1/chat/completions （QQ Agent 原样的 OpenAI 请求，stream:false）
   ▼
lib/shim.js（本机中转，只监听 127.0.0.1）
   │  ③ lib/wire.js 改写：developer→system、首条补 system、tool_choice 压成字符串、强制 stream:true、
   │                    只保留上游认识的字段、加 stream_options.include_usage
   │  ④ lib/vault.js 取凭据（读 ~/.dsh/workbuddy-vault，快过期自动 refreshToken 续期）
   │  ⑤ lib/catalog.js 校模型（目录里有才发，否则回落到默认模型并在控制台说明）
   ▼
WorkBuddy 网关  POST https://copilot.tencent.com/v2/chat/completions （国内版）
                POST https://www.workbuddy.ai/v2/chat/completions    （国际版）
   │  ⑥ 返回 SSE（上游只肯流式）
   ▼
lib/sse.js 聚合：content / reasoning_content / tool_calls[].arguments 分片合并 / usage / finish_reason
   │  ⑦ 模型偶尔把工具调用写成正文 DSML 标记 → 恢复成真正的 tool_calls（只在请求声明过该工具时）
   ▼
QQ Agent 拿到一次性 JSON，照常执行工具、生成回复
```

失败时（排队/限流/登录过期/网络）：

1. **换区域兜底**（`regionFallback` 开、`region=auto` 且两个区域都登录了）：额度尽 / 限流 / 登录失效 /
   上游 5xx 时，同一个请求自动换另一个区域的账号重试一次，成功就不打扰你；
2. 队列（6020/6021/6022）按设置重试有限次；
3. 渠道校验（11128）→ 给每个消息开头垫中性头，**重试一次**（这是上游 DSH 插件实测出来的自救手段）；
4. 仍然失败且「失败回退官方 API」开着 → 用 QQ Agent 配置页里的 `api.baseUrl/apiKey` 原样再发一次，
   这一次走 DeepSeek 余额（控制台会写明「已回退」）；
5. 关掉回退则直接把中文错误原因报给机器人（控制台会看到「模型请求失败：WorkBuddy …」）。

---

## 四、设置项

| 设置 | 默认 | 说明 |
|---|---|---|
| `enabled` | 开 | 插件总开关（插件页）。关掉等于不加载。 |
| `takeover` | 开 | 是否接管模型调用。关掉 = 插件继续加载但机器人用官方 API。 |
| `region` | `auto` | **下拉选择**：`auto`（自动，优先国内版，失败可换区）/ `cn`（只用国内版）/ `global`（只用国际版）。两区账号与额度互不相通；显式选了区域就严格按选的来（不会兜底），选到本机没登录的区域会提示「没有找到登录凭据」。 |
| `model` | `deepseek-v4.1-flash` | WorkBuddy 模型 id，**优先于 QQ Agent 页面上的模型**。填错会自动回落并在控制台提示。 |
| `port` | `39321` | 本地中转端口（只监听 127.0.0.1）。被占用会自动顺延并在控制台写明实际端口。 |
| `fallbackToNative` | 开 | WorkBuddy 失败时用官方 API 保底。关掉则失败即报错（更容易发现 WorkBuddy 的问题）。 |
| `regionFallback` | 开 | 双区域兜底：仅 `region=auto` 时生效。国内版额度尽/限流/登录失效时，同一请求自动换本机登录的国际版账号再发一次；两区都失败才走 `fallbackToNative`。 |
| `requestTimeoutSec` | `180` | 流式的「空闲超时」：多久没有新内容就断开。 |
| `queueRetries` | `1` | 排队时额外重试次数（每次间隔 4 秒）。 |
| `maxTokensCap` | `0` | 单次回复输出的硬上限，0 = 不干预。 |
| `includeReasoning` | 开 | 把 `reasoning_content` 交回 QQ Agent（配合「显示思考」可见）。 |
| `debugLog` | 关 | 每次请求写一行诊断日志（模型、耗时、有无思考/工具）。不记对话内容与密钥。 |

**当前可用模型**：由 WorkBuddy 账号决定，问机器人「workbuddy 有哪些模型」或看
`http://127.0.0.1:39321/v1/models`。常用：`deepseek-v4.1-flash`（默认，便宜、支持工具调用）、
`deepseek-v4-pro`、`glm-5.3`、`kimi-k3-1`、`minimax-m3`、`glm-4.6v`（看图）。

---

## 五、凭据从哪来（不需要你做任何事）

插件读本机已经存在的 WorkBuddy 登录凭据：

```
~/.dsh/workbuddy-vault/cn/<accountId>.json      国内版
~/.dsh/workbuddy-vault/global/<accountId>.json  国际版
```

这是 DeepSeek Harness 的 WorkBuddy 插件登录后留下的**明文**凭据文件。本插件：

* **只读**它，不改不删；
* 续期后的新 token 写进自己的缓存 `<DATA_DIR>/workbuddy-connect-auth.json`（因为 refreshToken 会轮换，
  这条链只能有一方维护）；
* 绝不复制、上传或显示 token（状态接口只显示账号昵称与到期时间）。

**选哪个账号（没有账号池）**：

1. 每个区域**只用一个账号**：同一区域登录过多个号时，取「凭据到期最晚」的那个，其余忽略；
2. 区域由设置 `region` 决定：`auto` 优先国内版；显式写 `cn` / `global` 就只用那一个；
3. **双区域兜底**（`regionFallback`，默认开，仅 auto 生效）：国内版报「额度尽 / 限流 / 登录失效 /
   上游 5xx」时，同一个请求自动换国际版账号再发一次 —— 成功就当你没换过；两区都失败才走
   `fallbackToNative`；
4. **续期失败自愈**：DSH 的 WorkBuddy 插件或 WorkBuddy 桌面端可能先刷新了同一个账号、把 refreshToken
   轮换掉，我们缓存里那份随即作废。续期失败时会先回读一次凭据库，发现 refreshToken 变了就用新的重试
   一次（只重试一次，不会反复撞上游）。

本机登录了哪些账号，问机器人「workbuddy 额度状态」或打开 `http://127.0.0.1:<端口>/healthz` 的
`accounts` 字段就能看到（只有区域、昵称、到期时间，不含 token）。`auto` 的实际行为：

| 情形 | auto 怎么走 |
|---|---|
| 只登录了国内版 | 只用国内版；国内版失败后直接回退官方 API |
| 国内版 + 国际版都登录 | 优先国内版；国内版不可用（额度尽/限流/登录失效/上游 5xx）时自动换国际版重试一次 |
| 只登录了国际版 | 直接用国际版 |
| 一个都没登录 | 插件不接管，机器人继续走官方 API，控制台提示先登录 WorkBuddy |

没有凭据时：插件照样加载，但不接管，控制台提示「先用 WorkBuddy 客户端登录一次」，
机器人的对话不受影响（继续走官方 API）。

**想换账号**：在 WorkBuddy 客户端里退出再登录另一个号即可，插件下次续期/重扫就会用新账号
（或在插件页点一下禁用→启用触发重载）。注意 DSH 的 WorkBuddy 插件和本插件共用同一个凭据库，
不要同时在两边对同一个号做「退出登录」这类操作。

**可以放心分享这个插件目录**：`plugin.json` / `index.js` / `lib/*.js` / `README.md` 里**不含任何**
账号、昵称、邮箱、token、Cookie 或 API Key，凭据只在运行时从本机凭据库读取，续期缓存写在
`data/` 目录（不在插件目录里）。整个目录直接打包/上传到 GitHub 不会泄露你的 WorkBuddy 登录信息。

---

## 六、验证它真的在跑（三步，任选）

1. **看插件页**：`插件` 页应出现「WorkBuddy 额度接入」，状态「运行中」，可点开设置改模型。
2. **看中转状态**：浏览器打开 `http://127.0.0.1:39321/healthz`（只读，不含密钥），能看到
   `"running":true`、当前区域/模型、以及已发现的账号。
3. **问机器人**：「你现在用的什么模型？」→ 它应调用 `workbuddy_status` 工具回答，
   显示「已接管模型调用」、模型 `deepseek-v4.1-flash`、成功次数等。
   或者跟它正常聊两句，然后在 healthz 里看 `stats.ok` 增加。

> 控制台的连通性测试（设置页「测试 API」）也会走这条链路：返回的模型名应该是
> `deepseek-v4.1-flash` 而不是 `deepseek-flash`，说明中转生效。

---

## 六点五、v1.2.0 修了什么（热重载不再中断接管）

v1.1.0 及以前：QQ Agent 每次「重扫扩展」（装/删扩展、点插件页的刷新、以及启动时的一次扫描）都会把插件实例整个换掉。旧实例退出时会**停掉本地中转**，新实例马上重新绑同一个端口——这段时间里核心必然有一两次请求找不到中转，就静默回退到了官方 API。重扫连着来几次（实测一次装扩展触发了 27 次重扫），端口更可能被"绑过又没完全释放"卡住，新实例启动失败，于是插件**长期**不接管，而且当时插件日志只走控制台、不落盘，看起来就像"突然自己坏了"。

v1.2.0 起：

- 中转服务改成**进程级单例**：热重载只是把控制权交给新实例，服务不停、端口不断，正在处理的请求不受影响；
- `deactivate` 会区分原因，只有「禁用插件」「改端口」「应用退出」才真的关掉中转；
- 增加 5 秒一次的自检看门狗：发现中转挂了会自动重建（并把原因写日志）；
- 启动端口改为「先反复等首选端口释放，再顺延」，避免重扫风暴把 8 个端口一次耗光；
- 插件自己的日志改走应用日志文件（`data/logs/qq-agent-*.log`，带 `[workbuddy-connect]` 前缀），失败不再无声。

升级后如果还想确认：装/删任意扩展、点插件页刷新几次，然后 `POST /api/test/api` 看返回的 `model` 是不是 `deepseek-v4.1-flash` —— 是就说明接管还在。

## 七、排障对照表

> 日志在哪：插件自己的诊断行打在**应用控制台**（启动 QQ Agent 的窗口 / 开发者工具），前缀 `[skill:workbuddy-connect]`；
> 插件「加载成功/加载失败」由宿主打印，同时写进 `data/logs/qq-agent-*.log`（搜 `workbuddy-connect`）。
> 不想翻日志的话，打开 `http://127.0.0.1:39321/healthz` 或问机器人「workbuddy 状态」，信息是一样的。

| 现象 | 原因 | 处理 |
|---|---|---|
| 插件页显示加载失败 | 入口/语法错误 | 把页面上「错误原因」原文发出来；本机开发时可看 `data/logs/qq-agent-*.log` 的 `[skill] ❌ workbuddy-connect：…` |
| 机器人还是用 DeepSeek | `takeover` 关了 / 没找到凭据 / 中转没起来 | 先看 healthz（`running` 与 `takeover`），再看控制台日志；凭据问题按上面第五节登录一次 |
| 回话慢或报「排队」 | WorkBuddy 高峰期排队 | 正常，会自动重试 `queueRetries` 次；也可调大设置 |
| 报「WorkBuddy 登录已失效」 | token 过期且续期失败 | 打开 WorkBuddy 客户端重新登录 |
| 报「渠道校验（11128）」 | 提示词被网关拦（极少见） | 插件已自动垫中性头重试一次；仍失败会在控制台写明具体是哪条消息被拦 |
| 报「没有找到本区域的登录凭据」 | `region` 设成了没登录的那一区 | 改回 `auto`，或在对应版本客户端登录 |
| 模型名被自动改掉 | 设置里的模型名不在账号可用列表 | 看控制台的「已改用 …」提示，改成可用模型 |
| 想彻底退回官方 API | — | 插件页关掉开关（或删目录），立即生效 |

---

## 八、已知限制 / 没在真机上验过的点

* **图片输入**：消息里的 `image_url` 原样透传，但没实测过 WorkBuddy 对图片格式/大小的限制；
  如果发图后报 400，把原因发出来即可（大概率是选了个不支持看图的模型，换 `glm-4.6v` 这类）。
* **计费/余额查询**：插件不查 WorkBuddy 剩余额度（上游把余额放在另一个计费接口里），
  额度消耗请以 WorkBuddy 客户端为准。
* **回退目标**：失败回退用的是 `data/config.json` 里 `api.baseUrl/apiKey`（QQ Agent 当前主 API）。
  如果你在 UI 里临时切了别的 provider，回退仍走主 API。
* **没有账号池**：原 DSH 插件的「账号池」（多账号表格、按积分/到期排序、失败自动换号、签到、扫码加号、导入导出）在 QQ Agent 里做不了 —— 宿主扩展机制只支持设置表单，没有挂自定义界面的地方。本插件的能力上限是：**每区域用一个账号 + 双区域兜底**。同一区域登录了多个 WorkBuddy 账号时，只取凭据到期最晚的那个，其余忽略。
* **队列重试**：上游建议不要高频重试；默认只重试 1 次，失败就走回退，避免把账号打进限流。

---

## 九、目录结构

```
plugins/workbuddy-connect/
├── plugin.json          清单：元数据、默认设置、设置页 schema
├── index.js             生命周期（setup/activate/deactivate）、能力 llm.endpoint-pick、状态工具
├── lib/
│   ├── wire.js          请求体改写（角色/首条 system/tool_choice/白名单/强制流式/渠道校验识别）
│   ├── sse.js           SSE 聚合、usage 归一、DSML 工具调用恢复
│   ├── upstream.js      发请求 + 失败分类（顺序与上游 DSH 插件一致）+ 中文错误翻译
│   ├── shim.js          本机 HTTP 中转：路由、队列重试、11128 自救、回退官方 API、统计
│   ├── vault.js         凭据发现 / JWT 解析 / 过期判断 / refreshToken 续期 / 缓存
│   └── catalog.js       模型目录（/v3/config）拉取、缓存、模型名纠正
└── README.md            本文件
```

## 十、协议备忘（排障时最常撞的坑）

* 上游**没有非流式**：`stream:false` 直接 400，所以必须自己聚合 SSE。
* `tool_choice` 只认字符串；对象形式 400。`developer` 角色 400；首条不是 system → 11128。
* 三连头 `X-Conversation-{ID,Request-ID,Message-ID}` 必须都带且互不相同。
* 不带 `stream_options:{include_usage:true}` 就没有 `usage`，QQ Agent 的统计会全 0。
* 聊天用 CLI 身份 `CLI/2.63.2 CodeBuddy/2.63.2`；目录/生图用 App 身份
  `WorkBuddy/5.8.3 … CLI/2.161.0`。换错 UA 会少看到模型或被判非官方客户端。
* 错误分类顺序不可换：队列（6020/6021/6022）→ 额度 → 登录 → 策略 → 渠道 → 模型忙 → 429 → 404 → 5xx/4xx。
* 429 的重置时间在响应正文里（`将在 … UTC+8 重置`），响应头里没有 Retry-After。
* 登录续期：`POST /v2/plugin/auth/token/refresh`，头 `X-Refresh-Token` + `X-Auth-Refresh-Source: workbuddy`；
  refreshToken 会轮换，必须立刻写回。
* 模型偶尔把工具调用写成正文 DSML 标记（`<｜DSML｜invoke name="…">`），不恢复的话机器人会「只说话不干活」。
