---
name: wechat-push
display_name: 微信推送
display_name_en: WeChat Push
description: 从 WorkBuddy 向用户微信推送「任务完成」「需要确认」通知（经 ClawBot / iLink 通道）。当用户希望 WorkBuddy 通知其微信，或需要安装、配置、调试微信 ClawBot 推送 hook 与 iLink sendmessage / getuploadurl API 时使用。支持文本、图片、视频、文件四类消息的主动推送。定时任务请优先用客户端原生「推送到微信」开关。
description_zh: 把 WorkBuddy 的任务完成与确认请求通知推送到微信，支持文本、图片、视频、文件
description_en: Push WorkBuddy task-completion and approval notifications to WeChat, with text, image, video and file support
category: 办公效率
version: 1.2.0
author: 看见星光
---

# 微信推送（wechat-push）

通过 ClawBot（iLink）机器人通道，把 WorkBuddy 的通知推送到用户微信。通知以聊天消息的形式，
由用户在微信里已绑定的机器人（名为 `clawbot`）发出。

## ⚠️ 先看这里：定时任务优先用平台原生「推送到微信」

**2026-09-24 起，WorkBuddy 5.6+ 把 `settings.json` 里的 `botToken`/`channelId` 改为加密信封**
（`{"$wbEncrypted":1,"envelope":"<base64>"}`）。密钥由客户端原生层
（`WorkBuddy.exe` 的 `electron_browser_workbuddy_storage` 绑定）在启动时经 IPC 下发给 CLI
进程，**外部脚本拿不到，因此无法解密**——本脚本已不再尝试解密
（老版本会把对象拼成 `Bearer [object Object]`，iLink 返回误导性的 `errcode=-14 session timeout`）。

**好消息：不需要解密也能拿到凭据。** 客户端长轮询时会把自己的
`<accountId>@im.bot:<hex>` 身份串（与 `botToken` 同构）写进
`~/.workbuddy/claw-state/weixin/<accountId>_im.bot.cursor.json`。该文件明文、由客户端持续
刷新、文件名即账号，因此**天然跟随重新绑定**。自 v1.1.1 起脚本自动读取它（解析顺序第 4 条），
日常无需任何手工操作。

所以：

| 需求 | 推荐做法 |
| --- | --- |
| **定时任务把结果发到微信** | 用**客户端原生开关**：编辑自动化任务 → 打开「推送到微信」。任务最终输出由平台投递（`POST /v2/backgroundagent/wechatmpProxy/push`，凭据由客户端/服务端管理），**不需要本脚本**。可在界面或 `automation_update` 更新 `pushToWeChat: true` |
| 需要即时/主动通知（hook、任务完成提醒） | 用本脚本 `--send`（v1.1.1 起凭据自动解析，开箱可用） |
| 需要把文件/图片主动送到微信 | 用本脚本 `--send-file` / `--send-image`（原生通道只在「请求投递」时带文件） |

凭据解析顺序（`node scripts/wb-push.js --cred-status` 可诊断）：

1. 环境变量 `WBPUSH_WX_TOKEN` / `WBPUSH_WX_USER`（可选 `WBPUSH_WX_BASE`、`WBPUSH_WX_CONTEXT_TOKEN`）
2. 本地凭据缓存 `~/.workbuddy/wb-push.credentials.json`（0600）
3. `~/.workbuddy/settings.json` 中的**明文**凭据（旧版客户端）
4. **claw-state 轮询游标**（加密客户端下的主用来源）：从
   `~/.workbuddy/claw-state/weixin/<accountId>_im.bot.cursor.json` 的 `get_updates_buf`
   中提取当前绑定的身份串；**仅当账号前缀与当前 `accountId` 一致**时才采纳
5. 自动回收：从历史 `settings.json*` 备份里找最新的明文 `botToken`（同样要求账号一致）

> 第 4、5 条都做账号一致性校验：重新扫码绑定会换 `accountId`，旧来源会被正确拒绝，
> 而 claw-state 会立刻给出新账号的凭据。

诊断与维护凭据：

```bash
node scripts/wb-push.js --cred-status              # ① 凭据解析路径，不打印密钥
node scripts/wb-push.js --session-status           # ② 会话活跃度探测（能否真正投递）
node scripts/wb-push.js --recover-token            # 从 claw-state/历史备份回收凭据写入缓存
node scripts/wb-push.js --set-token "<token>" "<userId>"   # 手工写入缓存
```

> 两条诊断命令覆盖了「收不到消息」的两大独立成因：**① 凭据解析失败**（走不通鉴权）、
> **② 会话未建立**（鉴权通过、消息仍被静默丢弃）。先看 ①，再看 ②，不要混判。

> 若第 4 条也拿不到（claw-state 目录被清理、或客户端从未完成过一轮轮询），
> 保持客户端运行片刻使其轮询一次即可恢复；或改用原生「推送到微信」。

## 适用场景

- 用户希望把「任务完成」或「需要确认」通知推到微信。
- 需要向微信发送**长文本**（日报、报告、超过 1500 字）——用分段助手
  `scripts/wb-push-long.py`，见 §1b。
- 需要向微信发送**图片 / 视频 / 文件**——见 §1c。
- 安装或修复 `~/.workbuddy/settings.json` 里的推送 hook。
- 在 WorkBuddy 任务中手动发送一条微信通知。
- 排查 `ret=-2 prepare failed` / `errcode=-14 session timeout` / 配额 / 静默失败问题
  （**用户反馈「没收到」时，直接跳到 §收不到消息：四步分诊**；不知从哪下手时看
  §静默失败的三种形态）。

## 使用方法

> 下文 `<skill>` 指本 skill 的安装目录，默认是
> `~/.workbuddy/skills/wechat-push/`。

### 1. 手动发送

```bash
node <skill>/scripts/wb-push.js --send "标题" "内容"
```

脚本本身不含任何密钥。它会自动从
`~/.workbuddy/settings.json` → `claw.users.*.channels.weixinClawBot`
读取凭据（`botToken`、`userId`、`baseUrl`）。也可用环境变量覆盖：
`WBPUSH_WX_TOKEN` / `WBPUSH_WX_USER` / `WBPUSH_WX_BASE`。

另有一个可选的 `WBPUSH_WX_CHANNEL_VERSION`（默认 `cbc-1.0.0`，与 WorkBuddy
客户端内置实现对齐）。服务端当前不校验该字段，正常无需设置；
仅当将来服务端开始校验、需要临时改版本号时用它覆盖。

内容也可以走 stdin（第二个参数为空时，脚本会读 stdin）：

```bash
cat report.md | node <skill>/scripts/wb-push.js --send "今日报告"
```

**⚠️ 关键限制——1500 字截断**：`--send` 内部会执行
`truncate(desp, 1500)`。超过 1500 字的内容会被**静默截断，且不报任何错**，
而脚本照样打印「已发送」。凡超过约 1500 字，必须分段（见 §1b）。
stdin 输入同样受此限制。

### 1b. 长文本（>1500 字）：改用分段助手

```bash
python <skill>/scripts/wb-push-long.py <文件路径> --title "标题"
```

- 逐段发送，段间有 `--gap`（默认 2 秒）延迟，以避开约 7 条 / 5 分钟的限流。
  标题会自动编号为 `标题 (1/3)`。
- **标题去重（v1.0.2 起）**：正文首行若与消息标题语义重复，会被自动剥离。
  - 传了 `--title`：正文首行若为「短行且非列表项、非 `#` 标题」，视为重复摘要，从正文剥离。
  - 未传 `--title`：取正文首行作消息标题，并从正文剥离该行。
  - 避免出现「消息标题 + 正文首行摘要」两行重复。
- **条目感知切分（v1.0.1 起）**：识别 `1. ` / `1、` / `- ` / `• ` 等条目起始行，
  把每条当**原子单位**——放不下就把**整条**移到下一段，**绝不从条目内部夹断**。
  `##` 小标题会自动吸附到紧随内容之前（吸附后超限则放弃吸附，避免浪费一整段）。
  仅当单条自身超长（罕见）时才按句号边界续拆，续段统一加前缀 `（接上条）`，
  让接收方知道这是同一条的延续而非新条目。
- 需要 PATH 上有 `python` 和 `node`；会自动扫描
  `~/.workbuddy/binaries/node/versions/*/node.exe` 取**最新版本**（不写死版本号，
  以免 WorkBuddy 升级内置 Node 后失效），再回退到 PATH 上的 `node`。

可选参数：`--title`、`--max <字符数>`、`--gap <秒数>`。

### 1c. 发送媒体（图片 / 视频 / 文件）

```bash
node <skill>/scripts/wb-push.js --send-file "<文件路径>" ["说明文本"]
node <skill>/scripts/wb-push.js --send-image "<图片路径>" ["说明文本"]
```

- `--send-file` 按扩展名推断类型：图片
  （`.jpg/.jpeg/.png/.gif/.webp/.bmp`）、视频（`.mp4/.mov/.avi`），
  其余一律按文件发送。`--send-image` 则强制按图片类型发送，不看扩展名。
- 媒体消息**不受** 1500 字截断限制。单文件上限 100 MB。
- 完整链路：
  1. `POST /ilink/bot/getuploadurl`，带
     `filekey / media_type / to_user_id / rawsize / rawfilemd5 / filesize / no_need_thumb / aeskey`
     （`media_type`：1=图片，2=视频，3=文件，4=语音）。
  2. 用 AES-128-ECB 加密文件（16 字节随机密钥，PKCS#7 填充），再把密文 `POST` 到 CDN
     （`Content-Type: application/octet-stream`）——地址取返回的 `upload_full_url`，
     或拼 `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=<upload_param>&filekey=<filekey>`。
     响应头 `x-encrypted-param` 就是下载凭据。
  3. `POST /ilink/bot/sendmessage`，用 `image_item` {media, mid_size} /
     `video_item` {media, video_size} / `file_item` {media, file_name, len}
     （item 类型：2=图片，4=文件，5=视频——注意与上传时的 `media_type` 不同）。
     `media` = `{ encrypt_query_param, aes_key: base64(十六进制形式的 aeskey 字符串), encrypt_type: 1 }`。
- 若同时给了说明文本，会在约 1.2 秒后单独推一条文字消息。
- 平台限制同样适用（需活跃会话，单会话约 10 条，约 7 条 / 5 分钟）。

### 2. 通过 hook 自动推送

hook 命令由 **Git Bash** 执行（Windows 上强制，不支持 cmd.exe / PowerShell），
而 hook 子进程**继承 WorkBuddy 进程的 PATH**，内置 Node 目录就在其中。
**所以命令里直接写 `node` 即可，不需要查任何绝对路径：**

```json
{
  "hooks": {
    "PermissionRequest": [
      { "hooks": [ { "type": "command",
          "command": "node \"<skill>/scripts/wb-push.js\" --hook PermissionRequest" } ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "command",
          "command": "node \"<skill>/scripts/wb-push.js\" --hook Stop" } ] }
    ]
  }
}
```

`<skill>` 换成真实绝对路径（如 `C:/Users/<你>/.workbuddy/skills/wechat-push`）。

**⚠️ 唯一需要注意的地方：反斜杠。** `C:\Users\...` 里的反斜杠会被 bash 当转义符吃掉，
导致 exit 127 静默失败（无报错、无输出）。必须写成「正斜杠 + 双引号」。

**万一 `node` 找不到**（罕见）：把开头的 `node` 换成绝对路径
（`~/.workbuddy/binaries/node/versions/<版本>/node.exe`，正斜杠形式）。
但绝对路径在 WorkBuddy 升级内置 Node 后会随版本号变化而失效，**优先用 `node`**。

> ⚠️ **两种环境要分清**（常见的误判点）：
> - **WorkBuddy 内部**（智能体调用脚本、hook 执行）→ `node` 可用；
> - **用户自己的 cmd / PowerShell** → **`node` 不可用**，因为内置 Node 只在
>   WorkBuddy 进程内可见（它不在持久化的系统 PATH 里）。
>   要在外部终端自测，只能写绝对路径，或自行安装系统版 Node。

配好后自测：`node <skill>/scripts/wb-push.js --send "测试" "内容"`，
能收到说明通道正常；再结束一轮对话，验证 `Stop` 的自动推送是否到位。

### 3. 通知行为（可在脚本内配置）

- `Stop` → 只发一条 `✅ 任务完成`（不带回复内容 / 目录 / 会话 id）。
  做了 5 分钟节流，最多每 5 分钟推一次，以保护 iLink 配额
  （约 10 条/会话、7 条/5 分钟的限制由所有推送共享）。
- `PermissionRequest` → 只对**高风险**操作推送（删除 / 破坏类命令、
  系统修改类命令、写入系统目录）。普通读写静默跳过；
  高风险确认**永不节流**（最高优先级）。过滤规则调整见脚本里的 `isHighRisk()`。
- `Notification` → 捕获权限提示类通知，同样按高风险规则过滤。

### 4. 批量删除防护提示（沙箱层）

WorkBuddy 的「批量删除」防护提示（一次删除 ≥50 个文件）在沙箱层触发，
**完全不经过 CLI hook**。用审计日志守护进程来覆盖它：

```bash
node <skill>/scripts/wb-audit-watch.js
```

它每 2 秒扫描一次 `~/.workbuddy/audit-log/**/*.jsonl`，寻找
`file-safety.bulk-delete.needs-approval` 事件（以及任何 `*.needs-approval`），
再通过 wb-push.js 推送到微信。细节：

- 去重键：`commandHash|eventType|timestamp`——spool 里的事件**没有 id**
  字段（id 只在合并进日账时才生成）。
- 全量扫描（不用偏移）：spool 文件会被审计系统频繁重写，偏移追踪不可靠。
  文件本身很小，全量扫描开销很低。
- 单实例锁（`~/.workbuddy/wb-audit-watch.lock`，内容 `pid|version`）；
  版本号更高者会自动接管旧进程。
- 开机自启：往 Windows 启动文件夹丢一个 `.vbs` 启动器，以隐藏窗口运行脚本
  （任务计划程序 / cscript 可能被安全策略拦截）。
- 状态 / 日志：`~/.workbuddy/wb-audit-watch.state.json` /
  `~/.workbuddy/wb-audit-watch.log`。

### 5. 自动化集成——无人值守推送

**先分清两类需求：**

- **纯文本结果（日报/播报/简报）** → 用客户端原生开关
  `pushToWeChat: true`（界面：「编辑任务 → 推送到微信」）。任务最终输出由平台投递，
  无需凭据、无需脚本。2026-09-24 起密码学凭据外部不可解密，这条是唯一稳定的路。
- **需要主动推文件/图片，或 hook 式即时通知** → 才用本脚本，并且必须先解决明文凭据。

当自动化任务需要把生成的文件送达微信时，模式是：

```
生成报告 → wb-push.js --send-file <路径> "<摘要>"
```

典型流程：

- 报告生成脚本产出文件，并把绝对路径打印到 stdout（如末行输出
  `REPORT_PATH=<绝对路径>`）；
- 自动化接着执行 `--send-file "$REPORT_PATH" "<3 行摘要>"`；
- 每次运行追加一行到自己的运行日志，便于事后核对。

无人值守运行的规则：

1. **node、python 和脚本一律用绝对路径。** `wb-push.js` 只依赖
   Node 内置模块（`fs`/`path`/`os`/`crypto`），凭据按文首的解析顺序取
   （环境变量 → 本地凭据缓存 → settings.json 明文 → claw-state 游标 → 备份回收），所以它能在**任意** cwd
   下运行——无需 npm install、无需相对路径。*报告生成器*才是有依赖的部分（例如需要
   `openpyxl`；`~/.workbuddy/binaries/python/versions/` 下的托管 Python 已自带）。
   **无人值守时若凭据解析失败，脚本直接以退出码 3 结束并打印补救步骤，
   不会再把 `[object Object]` 当 token 发出去。**
2. **只有说明文本受 1500 字上限约束**——摘要保持 ≤3 行。文件本身永不截断。
   一个文件 + 一条说明，消耗共享配额的 **2** 条消息。
3. **非零退出码 = 真实可检测的失败。** 退出码取值：`0` 已受理；`1` 网络 / 协议 / 业务失败；
   `2` 用法错误；`3` **凭据不可用**（settings 为加密信封，且无本地缓存 / 可回收备份）。
   `ret=-2` 会在 4 秒后重试一次再以 1 结束；CDN 上传失败最多重试 3 次。这些都要落到日志里。
4. **静默不投递无法检测。** 会话不活跃（用户约 24 小时内没给机器人发过消息）时，
   仍可能返回一个正常的 `message_id`，但消息实际不到达。所以定时任务的「成功」
   只代表*已被受理*。日志写 `送达状态不可验证`，永远不要写「已送达」。
   其余两种静默失败形态见 §静默失败的三种形态。
5. 实际后果：只要用户一天没跟机器人说过话，每日定时任务就会静默降级。
   如果这很重要，自己给机器人发条消息，或者加个健康探测
   （`getconfig` 返回 `ret=-4 GetTypingTicket rpc failed` 通常是征兆）。

## 平台能力——把文件送进微信的两条独立通道

两条互不相同的通道都能把文件送达——别搞混：

1. **主动推送（本脚本）。** 从**任意**会话都能工作，包括桌面端发起的会话。
   上传到微信 CDN，然后发送 `image_item` / `video_item` / `file_item`。
2. **请求投递（WorkBuddy Claw 层）。** **只在用户从微信发起的会话里**生效；
   该会话的产物 / 文件会跟随回复一起送达。
   桌面端发起的会话走这条路什么也送不到。

**所以需要主动把文件推到微信时，用通道 1。**

**排查清单——在告诉用户「这个通道发不了文件」之前：**

1. 读 `~/.workbuddy/settings.json` → `claw.users.<uid>.requestDeliveries`；按
   `updatedAt` 排序，找最近的 `weixinClawBot` 条目、看是否有 `"status":"delivered"`。
2. 查 daemon 日志 `~/.workbuddy/logs/daemon.log`，看是否有与那个 `updatedAt`
   同一秒的 `wb:conversations:artifacts` / `:files` 调用。
3. 只有两者都不存在，才去探索其它通道。

通道 2 生效时，日志里会出现 `wb:conversations:artifacts` + `wb:conversations:files`
调用，紧跟着 `settings.json` 的 `requestDeliveries` 新增一条
`...-weixinClawBot-<id>` 条目并翻转为 `"status": "delivered"`——之后用户就能在
微信里看到该文件的文件卡片。也就是说，**请求过程中智能体访问 / 产出的文件可以
自动投递**，不需要 `wecom-cli`、不需要企业微信、不需要调用上传接口。

注意 iLink 配额规则依然生效：需要活跃会话（用户约 24 小时内给机器人发过消息），
否则投递会被静默丢弃。

## 平台限制（重要）

iLink 机器人只能在用户会话活跃时主动推送：

- 用户必须在约 24 小时内给机器人发过消息。
- 单会话下行配额约 10 条；账号限速约 7 条 / 5 分钟。
- 超限时 `sendmessage` 返回 `{"ret":-2,"errmsg":"prepare failed"}`。
  ⚠️ `ret=-2` **不专指配额**：实测它同时用于「参数缺失/无效」
  （缺 `to_user_id` → `invalid arguments`；`sendtyping` 缺 `ilink_user_id` →
  `ilink_user_id required`）。判错时不要只看数字。
- 恢复：让用户给微信机器人发任意一条消息，即可刷新配额 / 会话。
  这个限制无法从脚本侧绕过。
- **静默不投递陷阱**：会话不活跃时（用户约 24 小时内没给机器人发过消息），
  `sendmessage` 可能仍返回一个 `message_id`（不报错），但消息**并未投递**。
  脚本会把它当成功，并记录 `lastStopPushAt`，导致后续 `Stop` 推送被节流 5 分钟。
  处理：让用户给机器人发消息激活会话，然后往
  `~/.workbuddy/wb-push.state.json` 写入 `{}` 清掉节流状态。

### 静默失败的三种形态

这个通道的主要问题不是「失败」，而是**失败时不报错**。排查任何
「明明发送成功却没收到」的问题，逐条对照下面三种形态。

**① 响应字段名不一致，错误被判成成功。**
同一个 `sendmessage` 接口用**两套**错误字段：

| 错误类别 | 字段 | 实例 |
|---|---|---|
| 业务错误（配额、会话不活跃） | `ret` | `{"ret":-2,"errmsg":"prepare failed"}` |
| 鉴权 / 会话错误（凭据、登录态） | `errcode` | `{"errcode":-14,"errmsg":"session timeout"}` |

两类错误不会同时出现。**如果只判断 `json.ret`**，`errcode` 类错误会完全绕过
错误分支，落到「无 `message_id` 也视为已接受」→ 打印「已发送」、退出码 0。
换句话说：**凭据即使完全无效，也可能表现得像成功。**

> 本脚本已同时判断 `ret` 与 `errcode`；且当响应里既无 `message_id`、
> 也无显式成功码（`ret` / `errcode` 为 0）时，会向 stderr 打一条
> 「无法确认投递」警告，不再静默宣称成功。
> 用无效凭据可复现该分支：
> `WBPUSH_WX_TOKEN=invalid WBPUSH_WX_USER=any node <skill>/scripts/wb-push.js --send t t`
> （应以退出码 1 失败，而非报「已发送」。）

**② 会话不活跃 / 会话根本未建立 → 返回正常 `message_id`，但实际未投递。**
前者是「用户近 24h 没给 bot 发过消息」；后者更隐蔽——**换绑后新 bot 凭据已下发（能鉴权、
能拿到 `message_id`），但用户与该 bot 的会话尚未建立**。（2026-09-24 实测：WorkBuddy 5.6.2
升级触发 ClawBot 换绑，客户端日志出现 `claw:weixinQrWait`，此后所有主动推送均被静默丢弃。）
两者的判别与处置见下方「四步分诊」。

**③ 内容超 1500 字 → 静默截断。** 脚本照常打印「已发送」。见 §1「1500 字截断」。

**结论：本通道没有可信的「送达凭证」。** 退出码 0、`message_id`、无报错，
都只说明**平台受理了请求**，不等于消息到了用户手上。唯一可靠的确认是
**用户亲眼在微信里看到那条消息**。写日志时据此用词——写「已受理」，
不要写「已送达」。

### 收不到消息：四步分诊（按序执行，不要跳步）

用户反馈「没收到」时，逐条排除，每步都有确定的命令或判据：

| 步骤 | 命令 / 判据 | 结论 |
| --- | --- | --- |
| ① 凭据是否解析成功 | `node scripts/wb-push.js --cred-status` | 来源为 `none` → 凭据问题，按 §文首解析顺序处理 |
| ② 凭据是否被服务端认可 | 看 `--send` 是否返回 `errcode=-14` | 返回 `-14` → 凭据无效/格式错（**不是**「登录态过期」，别急着重扫码） |
| ③ **会话是否存在** | `node scripts/wb-push.js --session-status` | `ret=0` → 可投递；`ret=-4` → **无活跃会话，消息必被丢弃** |
| ④ 内容是否超长 | 统计正文字符数 | >1500 → 静默截断，改分段（§1b） |

第 ③ 步是本通道最容易被漏掉的一环。`ret=-4` 时按以下顺序处置：

1. 让用户在微信里给 clawbot 发一条消息（建立/刷新会话），再重跑 `--session-status` 确认转为 `ret=0`；
2. 若用户**在微信里找不到 clawbot 会话**，说明换绑流程未完成 → 让用户在 WorkBuddy 中**重新扫码绑定**；
3. 绑定完成后 `--cred-status` 会自动从 claw-state 取到新凭据，无需手工传参。

> **反例（易踩）**：`settings.json` 的 `requestDeliveries` 里出现 `"status":"delivered"`
> **不能**用来证明文本会话活跃——该记录只对应**文件/产物**的投递。判断文本会话活跃度
> 只有 `getconfig` 的 `ret` 值可靠。

### 错误码实测口径（2026-09-24 逐项探测）

用有效凭据对同一接口发不同报文得到的对照表，排查时按此判读：

| 现象 | 真实含义 | 处理 |
| --- | --- | --- |
| `errcode=-14 session timeout` | **鉴权层**：凭据无效/过期；或请求头里塞进了非字符串 token（旧版读到 `$wbEncrypted` 信封 → `Bearer [object Object]`）。错误文案会误导成「会话超时」 | 先 `--cred-status` 确认凭据来源，别急着重新扫码；v1.1.1 起 claw-state 会自动提供当前绑定的凭据 |
| `ret=-2 invalid arguments` | **参数层**：缺必填字段（实测缺 `to_user_id`） | 核对 `msg.to_user_id` |
| `ret=-3 invalid arguments` | **报文档位**：字段齐全仍被拒。实测三种诱因：① 缺有效 `context_token`；② 用的是已换绑/退役 bot 账号的 token（重新扫码后 `accountId` 变了）；③ `message_type`/`item_list` 枚举不符 | 先给机器人发消息激活会话；确认 token 归属账号与当前 `accountId` 一致 |
| `ret=-4 GetTypingTicket rpc failed` | **业务层**：该 bot 下没有活跃会话（`getconfig` 探测的返回） | 让用户给机器人发一条消息；找不到会话则重新扫码绑定（见 §四步分诊第 ③ 步） |
| 鉴权通过但无法投递 | 旧 token 仍被服务器「认识」，只是绑定的会话已不存在；或新 bot 会话尚未建立 | 换绑后旧 token 作废；用 `--session-status` 确认会话状态 |

**换绑会换账号**：每次微信扫码绑定都会生成新的 `accountId`（形如
`xxxxxxxxxxxx@im.bot`，可在 `settings.json` 里读到明文），旧的 botToken 随之作废。
所以「备份里的明文 token」只在未换绑时才有回收价值；而 **claw-state 游标会自动跟到新账号**
（文件名即 `accountId`），换绑后无需任何手工操作。

完整协议与错误处理见 `references/ilink-protocol.md`。
