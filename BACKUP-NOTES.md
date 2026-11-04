# QQ Agent 备份说明

这是 `qq-agent`（本地 QQ 机器人）的源码备份，由备份脚本自动上传。

## 收录内容
- `src/` 控制台后端、`ui/` 控制台前端
- `skills/`（技能）与 `plugins/`（插件）全部源码
- `napcat-plugin-qzone/` NapCat 侧 QQ 空间插件（原始位置在 NapCat 安装目录里）
- `test/` 自测、`scripts/` 运维脚本、`doc/` 文档、`assets/`
- 启动/停止脚本、`watch-napcat.mjs` 掉线看护、`部署说明.md`（含全部踩坑记录）

## 刻意不收的内容
| 路径 | 原因 |
|---|---|
| `data/` | 真实聊天记录、群友记忆、表情库，以及**含 API Key 的 config.json** |
| `napcat/` | 800 MB 的 NapCat + QQ 内核二进制，可重新安装（patch 脚本已在仓库里） |
| `runtime/` | 打包的 Node 运行时 |
| `node_modules/` | 依赖，`package.json` 可还原 |
| `*.log` | 运行日志 |

## 隐私处理（重要）
上传前脚本做过内容脱敏，以下真实值已被替换成占位符，恢复时请自己填回：

| 占位符 | 原本是什么 |
|---|---|
| `1000000001` | 机器人（bot）QQ 号 |
| `1000000002` | 主人 QQ 号 |
| `1000000003` | 白名单里的另一个 QQ 号 |
| `小助手` | bot 的群昵称 |
| `YOUR_WEBUI_TOKEN` | NapCat WebUI 访问 token |
| `YOUR_PASSWORD_MD5` | QQ 密码的 MD5（`bg-napcat.cmd` 里已注释） |
| `YOUR_SNOWLUMA_PASSWORD` | SnowLuma 的登录密码 |
| `C:\Users\user` | 原来的 Windows 用户目录 |

需要跑起来的话至少要改：`bg-napcat.cmd` 里的账号、`watch-napcat.mjs` 里的 `BOT_UIN`、`launch-qqbot.ps1` 里的路径与 token。

## 恢复要点
1. 装 Node 22+，`npm install`。
2. NapCat 4.18.19 放到 `napcat/`，然后跑 `fix-napcat-patches.cmd` 重新打四处补丁，
   把 `napcat-plugin-qzone/` 复制回 `napcat/shell/napcat/plugins/`。
3. `data/` 自己从旧机器拷（配置里有模型 API Key，注意别外传）。
4. 详细步骤见 `部署说明.md`（§11 升级陷阱、§12 插件、§14 完整性标签、§16-21 掉线与看护）。
