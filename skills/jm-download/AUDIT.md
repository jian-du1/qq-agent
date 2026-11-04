# 打包审查说明（按上传要求逐项）

> 本技能在 QQ Agent **进程内**运行（`plugin.json`: `type=skill`）。
> 审查时间：2026-10-16 ｜ 技能版本：**v2.3.2（优化版）** ｜ 包内文件：12 个（含本说明）

---

## 1. 入口代码

| 项 | 内容 |
|---|---|
| 入口 | `index.js`（`plugin.json`: `entry=index.js`、`apiVersion=1`）|
| 导出 | `setup` / `activate` / `deactivate` / `dispose` / `hooks` / `available` / `promptSections` / `providers` |
| 钩子用途 | 注册 `before-llm-messages` 等，把「下这本 / 今日JM / 更新JM / 暂停JM」这类**固定指令**直达工具，避免模型每轮空烧 |
| 宿主接口 | 只用扩展 API：`api.registerTool` / `api.config` / `api.log` / `api.capability`；不直接改宿主内部状态 |
| 动态代码 | 无 `eval`、无 `new Function`、无远程代码加载；无混淆、无压缩壳 |
| 可读性 | 全部源码明文（`index.js` 134.8 KB 含注释）|

## 2. 网络权限（全部出口清单）

**禁漫站点域名**（设置项 `domains` 可覆盖，填了则优先）：

- API：`www.cdnhjk.net`、`www.cdngwc.cc`、`www.cdngwc.net`、`www.cdngwc.club`
- 网页：`18comic.vip`、`18comic.org`、`jm-comic2.cc`、`jm-comic3.cc`

**可选出口**：

- 日语翻译：仅当你在设置里填了 `translateApiKey`/`translateBaseUrl` 时调用；默认沿用**宿主全局模型配置**（运行时从应用配置读取）。
- 代理：设置项 `proxy`，**默认直连**；代码里没有硬编码代理（历史上那个硬编码已在 2026-10-06 移除，仅注释保留说明）。

**没有**任何统计上报、遥测、回传、外部下载可执行文件的行为。

## 3. 外部可执行依赖

只依赖 **Python 3（含 Pillow）**，共两处调用：

| 调用点 | 脚本 | 用途 |
|---|---|---|
| `pdf.js` → `spawn(python, [jm_worker.py])` | `jm_worker.py` | 竖切还原 + 合成 PDF（流式、分批）|
| `daily_updates.mjs` → `spawn(py, [daily_image.py])` | `daily_image.py` | 「今日/更新JM」清单图渲染 |

解释器解析顺序：设置项 `python` → `C:\Python313/312/311` → `%LOCALAPPDATA%\Programs\Python\3xx` → `WindowsApps` → PATH。
除 Python 外**无**其它外部命令行依赖；不下载任何可执行文件。

## 4. 提示词

- `skill.json` 的 `prompt` 段 + `index.js` 的 `promptSections()`。
- 内容仅为「什么场景该调用本技能的工具」的引导（例如：群友发数字 ID / 「下这本」→ 调 `download_album`）。
- **不含**凭据、密钥、本机路径密钥、也不含让模型执行任意命令/读取任意文件的内容。

## 5. 凭据 / Cookie / 模型文件（本次重点）

- ✅ **未打包任何用户凭据**：API Key、Cookie、Token 一律**运行时**从应用配置读取（`translateApiKey`、全局模型 key 等），技能目录里不存在它们。
- ⚠️ **需要说明的三个常量**（`engine.js`）：
  - `APP_TOKEN_SECRET` / `APP_DATA_SECRET` = `185Hcomic3PAPP7R`
  - `APP_TOKEN_SECRET_2` = `18comicAPPContent`
  - 它们是**禁漫站点 APP 接口的公开协议常量**（用于按 `md5(时间戳+常量)` 生成请求签名、解密响应），**不是账号凭据、不是本机密钥**；删除后接口无法访问。若上传审核要求移除，可改为"设置项 + 留空则用内置默认值"的写法。
- ✅ **无模型文件**：无 `.safetensors/.ckpt/.pt/.pth/.onnx/.bin/.gguf` 等；全包**最大文件为 `index.js` 134.8 KB**，解压后合计约 268 KB。
- ✅ 无 `__pycache__`、无日志、无缓存、无下载内容（下载数据在应用 `data/` 目录，不在技能目录内）。

## 6. 文件清单

```
jm-download/
  index.js            134.8 KB   主逻辑：工具注册 + 指令直达 + 顺序队列 + 上传编排
  daily_updates.mjs    24.7 KB   「更新JM」日更清单（抓取/渲染/发送）
  engine.js            17.1 KB   站点接口客户端（签名、解密、分页、域名轮换）
  daily_image.py       14.4 KB   日更图渲染（Pillow）
  jm_worker.py         12.8 KB   竖切还原 + PDF 合成（Pillow，流式）
  pdf.js                9.4 KB   Python 桥（解释器探测 + 进程编排）
  skill.json            9.4 KB   清单：设置项 / 工具声明 / 提示词
  upload.js             9.2 KB   群文件上传（分卷、限速、失败重试）
  selftest.mjs         24.9 KB   自检脚本
  README.md            10.8 KB   使用说明
  plugin.json           0.8 KB   入口声明（type=skill, entry=index.js, apiVersion=1）
  AUDIT.md                       本文件
```

## 7. 安装方式

解压后得到 `jm-download/` 目录 → 整个放进 QQ Agent 的 `resources/app/skills/` 下 → 热重载会自动加载（控制台 → 技能页可看到并调设置）。
