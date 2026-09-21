# 微信推送（wechat-push）

> 让 WorkBuddy 的任务进展，直达你的微信 📱

---

> ## ⚠️ 使用前必读
>
> **本项目不是腾讯或 WorkBuddy 官方项目**，由第三方独立开发，未经其官方支持或认可。
>
> ### 关于所用接口
>
> 本 skill 通过**微信官方的机器人接入服务**（iLink Bot，`ilinkai.weixin.qq.com`）
> 向你的微信推送消息。你的绑定凭据由**你本人扫码、微信官方签发**，本 skill 只是复用它
> 调用同一接口。
>
> 该接口的调用方式（端点、请求头、媒体上传链路、枚举值、错误码）**依据 WorkBuddy
> 客户端实现整理，未经官方确认**——腾讯未公开相关 API 文档，本仓库也不代表其文档。
> 整理中不含任何密钥、证书、签名算法或未公开的加密原语。
>
> ### 使用须知
>
> - **接口可能随时变更**：该接口无公开文档、无版本承诺。腾讯调整后本 skill 可能停止工作，
>   需使用者自行排查或等待更新。
> - **请仅在个人范围内使用**：适用于个人自用场景，请勿用于批量营销、群发、代发等用途。
> - **凭据安全**：请勿在公开渠道分享你的 `botToken` / `userId`——泄露等同于把机器人交给他人。
> - **软件按原样提供**：本项目以 MIT 许可「原样」提供，不附带任何担保。因使用本软件
>   产生的账号限制、消息违规、数据丢失等后果，由使用者自行承担。
>
> 继续使用、复制或分发本仓库内容，即表示你已知悉并接受上述须知。

---

一个轻量级 WorkBuddy skill：当任务完成、或遇到需要你亲自确认的操作时，
通过你微信里的 ClawBot 机器人实时推送**聊天式通知**——不用守在电脑前，
打开手机微信就能掌握进度。除文本外，也支持主动推送图片 / 视频 / 文件。

**核心特性**

- ✅ **任务完成提醒**：每次对话回合结束，自动推送「✅ 任务完成」
- ⚠️ **确认请求提醒**：只对高风险操作推送（删除/危险命令/写入系统目录），
  普通读写查询静默过滤，不刷屏
- 🖼️ **图片 / 视频 / 文件**：`--send-image` / `--send-file` 可直接推送媒体
- 🛡️ **批量删除防护提醒**：WorkBuddy 的「批量删除确认」弹窗走沙箱层、不经过 hook，
  用配套的审计日志守护进程（`scripts/wb-audit-watch.js`）同样推送到微信
- 🔒 **零密钥入仓**：脚本运行时自动读取本机 WorkBuddy 配置（或环境变量），
  仓库内不含任何 token
- 📚 **协议参考与排障手册**：附 iLink 端点、错误码、平台限额与常见问题整理
  （**非官方文档**，详见顶部声明）

**工作原理**

WorkBuddy 系统 hook（`Stop` / `PermissionRequest`）→ `wb-push.js` →
iLink Bot API → 你的微信 ClawBot。

```text
任务结束 ──→ 系统 hook ──→ wb-push.js ──→ ilinkai.weixin.qq.com ──→ 微信 clawbot
                              │                                        │
                              └────────── 「✅ 任务完成」 ────────────────┘
```

---

## 快速开始

> **第一次安装？** 请先看 **[安装指南.md](安装指南.md)**——分步操作、每步都带验证方法，
> 照着做就能跑通。下面是给熟悉命令行的人看的速览版。

### 前置条件

1. 已在 WorkBuddy 里绑定微信 ClawBot 通道（微信里能看到名为 clawbot 的机器人，
   且 `~/.workbuddy/settings.json` 中存在 `claw.users.*.channels.weixinClawBot` 配置）。
2. **无需自行安装 Node.js**：WorkBuddy 客户端自带 Node 运行时（脚本使用原生 `fetch`，
   需 Node 18+，内置版本满足）。仅当你打算在 WorkBuddy 之外运行脚本时，才需自备 Node。

### 安装（作为 WorkBuddy skill）

**推荐方式**：把本目录的**绝对路径**发给 WorkBuddy，让它自己安装：

> 安装这个 skill：`<本目录的绝对路径>`

路径要指到**能看到 `SKILL.md` 的那一层文件夹**。WorkBuddy 会把它装进用户级技能目录
`~/.workbuddy/skills/`（所有项目通用），装好后重启一次 WorkBuddy 让其重新扫描技能目录。

**兜底方式**：手动把本目录整个复制到 `~/.workbuddy/skills/wechat-push/`，同样重启。

> **注意**：若你是从 GitHub 下载的 zip 包，解压后目录名可能带分支后缀
> （如 `wechat-push-main`）。请把**目录名改成 `wechat-push`**
> 再安装——否则 skill 名与目录名不一致，部分路径引用会失配。

**仓库文件清单**（9 个文件，缺一不可）：

```text
wechat-push/
├── SKILL.md                      # 技能主体（WorkBuddy 读取此文件）
├── README.md                     # 本文件
├── 安装指南.md                    # 面向非技术用户的分步安装向导
├── LICENSE                       # MIT
├── .gitignore                    # 凭据兜底忽略规则
├── references/
│   └── ilink-protocol.md         # iLink 协议参考与排障手册
└── scripts/
    ├── wb-push.js                # 核心推送脚本（文本 / 图片 / 视频 / 文件）
    ├── wb-push-long.py           # 长文本分段助手（>1500 字）
    └── wb-audit-watch.js         # 审计日志守护进程（批量删除防护提醒）
```

## 手动发送一条测试

```bash
node scripts/wb-push.js --send "测试标题" "测试内容"
```

## 发送图片 / 视频 / 文件

```bash
node scripts/wb-push.js --send-image "C:/path/pic.png" "配图"
node scripts/wb-push.js --send-file  "C:/path/report.xlsx" "周报"
```

## 配置自动推送（hooks）

hook 命令由 **Git Bash** 执行，其子进程**继承 WorkBuddy 进程的 PATH**（内置 Node 目录在其中）。
**直接写 `node` 即可，无需查绝对路径。** 编辑 `~/.workbuddy/settings.json`，加入：

```json
{
  "hooks": {
    "PermissionRequest": [
      { "hooks": [ { "type": "command",
          "command": "node \"C:/Users/<你>/.workbuddy/skills/wechat-push/scripts/wb-push.js\" --hook PermissionRequest" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command",
          "command": "node \"C:/Users/<你>/.workbuddy/skills/wechat-push/scripts/wb-push.js\" --hook Stop" } ] }
    ]
  }
}
```

> ⚠️ **唯一需要注意的地方是反斜杠**：`C:\Users\...` 里的反斜杠会被 bash 当转义符吃掉，
> 导致 exit 127 静默失败。必须写成「正斜杠 + 双引号」。
>
> 若 `node` 找不到（罕见），退回绝对路径
> `~/.workbuddy/binaries/node/versions/<版本>/node.exe`；但绝对路径会随 Node 升级失效。
>
> **注意**：`node` 只在 **WorkBuddy 内部**（智能体 / hook）可用。你自己开 cmd 或
> PowerShell 跑 `wb-push.js` 时 `node` 会报「不是内部或外部命令」——因为内置 Node
> 不在持久的系统 PATH 里。这正是本 skill 使用内置 Node、而非要求用户安装 Node 的原因。

## 通知行为

- `Stop`（任务完成）：每次对话回合结束推送一条 `✅ 任务完成`（无正文）。
- `PermissionRequest`（需要确认）：只对高风险操作推送
  （删除/危险命令、系统修改、写入系统目录），普通操作静默跳过。
  可在 `scripts/wb-push.js` 的 `isHighRisk()` 中调整过滤规则。

## 排障

| 现象 | 原因 / 处理 |
|------|-------------|
| 完全收不到 | 检查 hook 路径是否用了正斜杠；确认 `settings.json` 里有 clawbot 凭据 |
| `ret=-2 prepare failed` | 主动推送配额用尽或会话过期 → 让用户给微信 clawbot 发任意消息刷新 |
| `errcode=-14 session timeout` | 登录态无效或已过期（鉴权错误走 `errcode`，业务错误走 `ret`，是两套字段）→ 先让用户给 clawbot 发条消息；仍报错则重新扫码绑定 |
| 脚本显示「已发送」，微信却没收到 | 本通道有三种**静默失败**：① 凭据/登录态无效；② 会话不活跃，消息被静默丢弃；③ 超 1500 字被静默截断。**退出码 0 与「已发送」都不等于送达**，详见 SKILL.md §静默失败的三种形态 |
| 发了几条后突然断 | 账号限速约 7 条/5 分钟，单会话配额约 10 条，稍等或刷新会话 |
| 手动 `--send` 能收到，但「任务完成」收不到 | 会话不活跃时 `sendmessage` 仍返回 `message_id`（不报错）但消息**不投递**；脚本会误记 `lastStopPushAt`，导致后续 Stop 被 5 分钟节流跳过。处理：① 让用户给微信 clawbot 发任意消息激活会话；② 清空 `~/.workbuddy/wb-push.state.json`（内容写 `{}`）解除节流 |

详见 `references/ilink-protocol.md`。

## License

MIT
