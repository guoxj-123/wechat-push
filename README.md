# 微信推送（wechat-push）

> 让 WorkBuddy 的任务进展，直达你的微信 📱

[![version](https://img.shields.io/badge/version-1.2.0-blue)](https://github.com/guoxj-123/wechat-push/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
![platform](https://img.shields.io/badge/platform-WorkBuddy-lightgrey)

---

> ## 📢 v1.2.0 更新（2026-09-24）
>
> **修复 WorkBuddy 5.6+ 用户推送失效的问题。**
> 5.6 起客户端把 `settings.json` 里的凭据改为加密存储，外部脚本无法解密，
> 旧版会把凭据对象拼成 `Bearer [object Object]`，服务端返回误导性的
> `errcode=-14 session timeout`，**消息发不出去**。
> v1.2.0 已自动适配（改从客户端轮询游标取材），**无需手工干预**。
>
> 同时新增 `--cred-status` / `--session-status` 两条诊断命令，
> 用于区分「凭据解析失败」与「会话未建立」——这两类问题的表现相同、成因不同。
>
> - 完整变更 → [CHANGELOG.md](CHANGELOG.md)
> - 所有版本 → [Releases](https://github.com/guoxj-123/wechat-push/releases)
> - **正在用 1.0.0？** → 见 [更新到新版本](#更新到新版本)

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
- 🔑 **自动适配加密凭据**：WorkBuddy 5.6+ 把 `settings.json` 里的凭据改为加密信封，
  外部无法解密。本 skill 会自动改从客户端轮询游标取材，**无需手工处理**
- 🧭 **内建分诊工具**：`--cred-status` / `--session-status` 两条命令分离
  「凭据问题」与「会话问题」，不必盲试
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

## 安装

### 前置条件

1. 已安装 **WorkBuddy 客户端**（Windows 版已验证；脚本仅依赖 Node 内置模块，
   理论上跨平台可用，但仅 Windows 路径经过实测）。
2. 已在 WorkBuddy 中**绑定微信 ClawBot 通道**——微信里能看到名为 `clawbot` 的机器人，
   且 `~/.workbuddy/settings.json` 中存在 `claw.users.*.channels.weixinClawBot` 配置。

### 方式一：把仓库地址发给 WorkBuddy（推荐）

不需要手动下载、解压或复制。在 WorkBuddy 对话框里直接说：

> 到这个仓库帮我安装 skill，装到 `~/.workbuddy/skills/wechat-push`：
> https://github.com/guoxj-123/wechat-push

WorkBuddy 会自行完成下载、解压、放置。装好后**重启一次 WorkBuddy**，让它重新扫描技能目录。

### 方式二：下载 ZIP 手动安装

1. 打开仓库页 → 绿色 **`Code`** 按钮 → **`Download ZIP`**
2. 解压，得到 `wechat-push-main` 文件夹 → **把它重命名为 `wechat-push`**
3. 把整个 `wechat-push` 文件夹复制到 `~/.workbuddy/skills/`（即
   `C:\Users\<你的用户名>\.workbuddy\skills\`）
4. 重启 WorkBuddy

> **第 2 步的重命名不能省。** GitHub 的 ZIP 会把顶层目录命名为「仓库名-分支名」，
> 而 WorkBuddy 按目录名索引 skill；目录名与 `name` 字段不一致会导致文档中的
> 路径引用失配。

### 方式三：已有本地目录

若你已经把本目录放在本地某处，把它的**绝对路径**发给 WorkBuddy 即可：

> 安装这个 skill：`<本目录的绝对路径>`

路径要指到**能看到 `SKILL.md` 的那一层文件夹**。

### 验证安装

安装后，在对话里说一句：

> 用微信 ClawBot 推送，给我发一条「通道已打通」

微信收到即安装成功。没收到请看下方 [排障](#排障)。

**仓库文件清单**（10 个文件，缺一不可）：

```text
wechat-push/
├── SKILL.md                      # 技能主体（WorkBuddy 读取此文件）
├── README.md                     # 本文件
├── 安装指南.md                    # 面向非技术用户的分步安装向导
├── CHANGELOG.md                  # 版本变更记录
├── LICENSE                       # MIT
├── .gitignore                    # 凭据兜底忽略规则
├── references/
│   └── ilink-protocol.md         # iLink 协议参考与排障手册
└── scripts/
    ├── wb-push.js                # 核心推送脚本（文本 / 图片 / 视频 / 文件）
    ├── wb-push-long.py           # 长文本分段助手（>1500 字）
    └── wb-audit-watch.js         # 审计日志守护进程（批量删除防护提醒）
```

---

## 更新到新版本

Skill 本身没有自动更新机制。升级方式与安装相同——**重新走一遍安装流程覆盖旧目录**即可：

1. 让 WorkBuddy 重新拉取并覆盖：说「把这个仓库的最新版本安装/更新到
   `~/.workbuddy/skills/wechat-push`」，并附上仓库地址；
2. 或手动下载新版 ZIP，改名后替换 `~/.workbuddy/skills/wechat-push` 整个目录；
3. **重启 WorkBuddy**。

**升级不会影响你的凭据与 hook 配置**——凭据在 `~/.workbuddy/settings.json`，
hook 配置也在那里，均位于 skill 目录之外，覆盖 skill 不会触及。

> ⚠️ **若 skill 在新版本中改过名字**（目录名变更），旧目录不会自动清除，
> 需手动删除旧目录，否则可能出现两个同名 skill。变更记录见 [CHANGELOG.md](CHANGELOG.md)。

---

## 定时任务：优先用客户端原生开关

**这是最容易被忽略的一点。** 如果你的目标是「让定时任务把结果发到微信」，有两条路，
且优先级不同：

| 需求 | 推荐做法 |
|------|---------|
| **纯文本结果**（日报 / 播报 / 简报） | 用 **WorkBuddy 客户端原生开关**：编辑任务 → 打开「推送到微信」（`pushToWeChat`）。任务最终输出由平台投递，**不需要本脚本、不需要凭据** |
| **主动推送文件 / 图片**，或 **hook 式即时通知** | 用本脚本。原生通道只在「请求投递」时携带文件 |

原生开关的优势是它由平台侧管理凭据，不受客户端凭据加密影响。纯文本场景优先用它。

**无人值守使用脚本时**有两条硬规则：

1. **node、python 和脚本一律写绝对路径**——脚本能在任意工作目录下运行，无需 `npm install`。
2. **只有说明文本受 1500 字上限约束**，文件本身永不截断。一个文件 + 一条说明
   消耗共享配额的 2 条消息。

**退出码**（用于判定无人值守运行的结果）：

| 退出码 | 含义 |
|--------|------|
| `0` | 已受理（注意：**受理 ≠ 送达**，见下方「静默失败」） |
| `1` | 网络 / 协议 / 业务失败 |
| `2` | 用法错误 |
| `3` | **凭据不可用**（settings 为加密信封，且无本地缓存 / 可回收备份） |

---

## 诊断命令

`wb-push.js` 提供 4 个诊断与维护开关。**它们不打印密钥本身**，可安全用于排查。

```bash
node scripts/wb-push.js --cred-status      # ① 凭据解析路径
node scripts/wb-push.js --session-status   # ② 会话活跃度（能否真正投递）
node scripts/wb-push.js --recover-token    # ③ 从 claw-state / 历史备份回收凭据写入缓存
node scripts/wb-push.js --set-token "<token>" "<userId>"   # ④ 手工写入凭据缓存
```

**「收不到消息」按四步分诊，不要跳步：**

| 步骤 | 命令 / 判据 | 结论 |
|------|------------|------|
| ① 凭据是否解析成功 | `--cred-status` | 来源为 `none` → 凭据问题 |
| ② 凭据是否被服务端认可 | 看 `--send` 是否返回 `errcode=-14` | 返回 `-14` → 凭据无效/格式错 |
| ③ **会话是否存在** | `--session-status` | `ret=0` 可投递；`ret=-4` **无活跃会话，消息必被丢弃** |
| ④ 内容是否超长 | 统计正文字符数 | >1500 → 静默截断，改分段 |

**第 ③ 步最容易被漏掉**：凭据有效、接口返回 [`message_id`]，消息仍可能不投递。
`ret=-4` 时依次处理：让用户在微信里给 `clawbot` 发一条消息 → 仍不行则
**在 WorkBuddy 中重新扫码绑定**（绑定完成后 `--cred-status` 会自动取到新凭据）。

**凭据解析顺序**（`--cred-status` 可查看实际来源）：

1. 环境变量 `WBPUSH_WX_TOKEN` / `WBPUSH_WX_USER`
2. 本地凭据缓存 `~/.workbuddy/wb-push.credentials.json`（写入权限 `0600`）
3. `~/.workbuddy/settings.json` 中的**明文**凭据（旧版客户端）
4. **claw-state 轮询游标**（加密客户端下的主用来源）
5. 自动回收：从历史 `settings.json*` 备份中查找最新明文凭据

第 4、5 条均做**账号一致性校验**：重新扫码绑定会更换 `accountId`，旧来源会被拒绝，
而 claw-state 会立即给出新账号的凭据。

---

## 操作示例

```bash
# 手动发送一条测试
node scripts/wb-push.js --send "测试标题" "测试内容"

# 推送图片 / 文件
node scripts/wb-push.js --send-image "C:/path/pic.png" "配图"
node scripts/wb-push.js --send-file  "C:/path/report.xlsx" "周报"

# 推送长文本（>1500 字，自动分段）
python scripts/wb-push-long.py "report.md" --title "日报"
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

⚠️ **先读这一点**：本通道有**三种静默失败**，其共同特征是
**脚本显示「已发送」、退出码为 0，但你手机上收不到**。因此
**「已发送」不等于送达**——唯一可靠的确认是你亲眼看到。
按上方 [诊断命令](#诊断命令) 的四步分诊定位。

| 现象 | 原因 / 处理 |
|------|-------------|
| 完全收不到 | 检查 hook 路径是否用了正斜杠（反斜杠会被 bash 吃掉）；再用 `--cred-status` 看凭据是否解析成功 |
| `ret=-2 prepare failed` | 主动推送配额用尽或会话过期 → 让用户给微信 clawbot 发任意消息刷新。注意 `ret=-2` **不专指配额**，参数缺失也可能返回它 |
| `errcode=-14 session timeout` | 鉴权错误走 `errcode`、业务错误走 `ret`，是两套字段。**别急着重新扫码**：先用 `--cred-status` 看凭据来源——请求头里塞进非字符串 token（如读到 `$wbEncrypted` 信封 → `Bearer [object Object]`）也会报这个错 |
| 脚本显示「已发送」，微信却没收到 | 三种静默失败：① 凭据/登录态无效；② 会话不活跃或**会话根本未建立**（换绑后常见）；③ 超 1500 字被静默截断。分诊顺序见上 |
| 发了几条后突然断 | 账号限速约 7 条/5 分钟，单会话配额约 10 条，稍等或刷新会话 |
| 手动 `--send` 能收到，但「任务完成」收不到 | 会话不活跃时 `sendmessage` 仍返回 `message_id`（不报错）但消息**不投递**；脚本会误记 `lastStopPushAt`，导致后续 Stop 被 5 分钟节流跳过。处理：① 让用户给微信 clawbot 发任意消息激活会话；② 清空 `~/.workbuddy/wb-push.state.json`（内容写 `{}`）解除节流 |

完整的接口细节、错误码对照与限额说明见 [`references/ilink-protocol.md`](references/ilink-protocol.md)。
非技术用户的图文步骤见 [`安装指南.md`](安装指南.md)。

## 版本历史

见 [CHANGELOG.md](CHANGELOG.md)。当前版本 **1.2.0**。

## License

MIT
