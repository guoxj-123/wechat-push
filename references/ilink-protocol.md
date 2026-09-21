# iLink Bot 协议参考（微信 ClawBot 通道）

> ---
> ## ⚠️ 本文档非官方文档
>
> 本文档依据 WorkBuddy 客户端实现整理，用于说明本 skill 的调用方式与排障，
> **不代表腾讯官方文档，未经其确认**。其中不含任何密钥、证书、签名算法
> 或未公开的加密原语。
>
> 内容涉及微信官方的机器人接入服务（iLink Bot）。所整理的服务端点、鉴权方式、
> 媒体上传链路、枚举值与错误码，可能在服务端调整后失效，需自行排查。
>
> 本文档单独传播时，请一并遵守仓库根目录 `README.md` 顶部《使用前必读》。
> ---

WorkBuddy 内置的 `WeixinClawBotClient` 通过腾讯 iLink Bot 通道与微信个人号 Bot 通信。
本文档为该协议的精简实现说明，用于推送消息与排障。

## 认证

- Base URL：`https://ilinkai.weixin.qq.com`
- 所有运行时 API 均为 `POST /ilink/bot/<endpoint>`，JSON body（登录相关接口除外）。
- 凭据：`botToken`（扫码登录后下发，形如 `dxxxx@im.bot:xxxx`）、`userId`（形如 `xxxx@im.wechat`）。

## 请求头（缺一不可）

```
Content-Type: application/json
AuthorizationType: ilink_bot_token
Content-Length: <字节数>
X-WECHAT-UIN: <Base64 编码的随机 uint32>
Authorization: Bearer <botToken>
```

`X-WECHAT-UIN` 生成：

```js
const uint32 = crypto.randomBytes(4).readUInt32BE(0);
const uin = Buffer.from(String(uint32), 'utf-8').toString('base64');
```

## 通用 body 包装

每个请求 body 额外附带 `base_info`：

```json
{ "base_info": { "channel_version": "cbc-1.0.0" } }
```

> **关于 `channel_version`**
>
> 该字段用于声明客户端版本，WorkBuddy 客户端内置实现
> （`cli/dist/codebuddy.js` 的 `WechatApi.buildBaseInfo()`）当前取值 `cbc-1.0.0`。
>
> 服务端目前**不校验**该字段——`cbc-1.0.0`、任意其他字符串、空串均被正常受理。
> 因此它不构成失效风险点。脚本侧提供环境变量
> `WBPUSH_WX_CHANNEL_VERSION` 覆盖，以备将来服务端开始校验时无需改代码。

## 端点

### sendmessage（发送文本）

```
POST /ilink/bot/sendmessage
```

```json
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "<userId>",
    "client_id": "wbpush-<ts>-<rand>",
    "message_type": 2,
    "message_state": 2,
    "item_list": [ { "type": 1, "text_item": { "text": "消息内容" } } ]
  },
  "base_info": { "channel_version": "cbc-1.0.0" }
}
```

- `item_list` 的 `type`：`1=文本`、`2=图片`、`4=文件`、`5=视频`。
- 文本可省略 `context_token`（被动回复时必须回传，主动推送可空）。
- 成功：返回 `{}` 或 `{"message_id": <number>}`（`ret` 缺失或为 0 视为成功）。

### getuploadurl（媒体上传）

发送图片 / 视频 / 文件前，必须先把文件上传到微信 CDN。

```
POST /ilink/bot/getuploadurl
```

```json
{
  "filekey": "<32 位 hex，客户端随机 16 字节>",
  "media_type": 3,
  "to_user_id": "<userId>",
  "rawsize": 9270,
  "rawfilemd5": "<明文的 md5 hex>",
  "filesize": 9280,
  "no_need_thumb": true,
  "aeskey": "<16 字节 AES 密钥的 hex>",
  "base_info": { "channel_version": "cbc-1.0.0" }
}
```

- `media_type`：`1=图片`、`2=视频`、`3=文件`、`4=语音`（**与 item_list 的 type 不同，勿混用**）。
- `filesize` = AES-ECB 填充后长度 = `ceil((rawsize + 1) / 16) * 16`。
- 响应：`{ "upload_full_url"?: "...", "upload_param"?: "..." }`（至少返回其一）。
- 请求头同 sendmessage 的鉴权字段；**不需要** `X-WECHAT-UIN`。

**第 2 步：上传密文到 CDN**

- URL：优先 `upload_full_url`；否则拼
  `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=<upload_param>&filekey=<filekey>`
- 方法：`POST`，`Content-Type: application/octet-stream`，body 为 **AES-128-ECB 加密后的密文**
  （PKCS#7 填充）。
- 响应头 `x-encrypted-param` 即第 3 步 `media.encrypt_query_param` 的值。
- 单文件上限 100 MB；失败最多重试 3 次（4xx 属客户端错误，不重试）。

**第 3 步：组装媒体 item 并 sendmessage**

```json
{ "type": 4,
  "file_item": {
    "media": {
      "encrypt_query_param": "<x-encrypted-param>",
      "aes_key": "<base64(hex 字符串形式的 aeskey)>",
      "encrypt_type": 1
    },
    "file_name": "周报.xlsx",
    "len": "9270"
  } }
```

- 图片：`type=2` → `image_item: { media, mid_size: <filesize> }`
- 视频：`type=5` → `video_item: { media, video_size: <filesize> }`
- 文件：`type=4` → `file_item: { media, file_name, len: String(rawsize) }`
- 注意：`aes_key` 是 **base64(hex 字符串)**（32 字符 hex → base64），
  不是 base64(原始 16 字节)。接收方向两种编码都存在，发送方向统一用前者。

### getupdates（长轮询收消息，默认超时 35s）

```
POST /ilink/bot/getupdates
```

```json
{ "get_updates_buf": "<游标，首轮传空字符串>" }
```

响应：`{ "ret":0, "msgs":[...], "get_updates_buf":"<新游标>", "longpolling_timeout_ms": 35000 }`。

### getconfig / sendtyping

- `getconfig`：`{ "ilink_user_id":"<userId>", "context_token":"<可选>" }` → 返回账号配置（含 typing_ticket）。
- `sendtyping`：`{ "ilink_user_id", "typing_ticket", "status": 1|2 }`（1=输入中，2=取消）。

## 错误码

⚠️ **同一个 `sendmessage` 接口用两套错误字段**：

- **业务错误 → `ret`**：限流、配额耗尽、会话不活跃。
- **鉴权 / 会话错误 → `errcode`**：凭据无效、登录态过期。

两类错误不会同时出现；成功时返回 `ret:0` **且**带 `message_id`。
排查时必须**两个字段都看**——只看 `ret` 会把鉴权错误读成成功。

### `ret`（业务错误）

| ret | 含义 | 处理 |
|-----|------|------|
| 0 / 缺失 | 成功（需配合 `message_id` 判断） | — |
| -2 | 限流 或 配额耗尽 / 会话过期（两者报错相同） | 等 4 秒重试；仍失败则需用户给 bot 发消息刷新 |
| -14 | 会话过期（登录态丢失） | 重新扫码登录 |

### `errcode`（鉴权 / 会话错误）

| errcode | errmsg | 含义 | 处理 |
|---------|--------|------|------|
| 0 | — | 成功（可能不带 `message_id`） | — |
| -14 | `session timeout` | botToken 无效 / 已过期，或登录态失效 | 先让用户给 bot 发条消息；仍失败则重新扫码绑定 |

对照示例（payload 与请求头**完全同构**，唯一变量是 botToken 是否有效）：

| botToken | HTTP | 响应正文 |
|---|---|---|
| 有效 | 200 | `{"ret":0,"message_id":"7504211788252789000"}` |
| 无效随机串 | 200 | `{"errcode":-14,"errmsg":"session timeout"}` |

> **这张 API 的字段命名是混用的，不要假设所有端点都返回 `ret`。**
> 已观察到的分布：`sendmessage` 混用（业务 `ret` / 鉴权 `errcode`）、
> `getconfig` 用 `ret`、`getuploadurl` 用 `errcode`（本 skill 实现即按 `errcode` 判断）。
> 客户端必须两个字段都判，否则错误会「穿透」成败类成功——见 SKILL.md §静默失败的三种形态。

## 平台限制（主动推送）

- 只能对「活跃会话」主动推送：用户近 24h 内给 bot 发过消息。
- 单会话 token 下行配额约 **10 条**，超量返回 `ret=-2`。
- 账号级限速约 **7 条 / 5 分钟**（所有客户端共享）。
- 用户给 bot 发任意消息即刷新配额 / 活跃状态。

> 注：`ret=-2` 无法区分「限流」与「配额耗尽」，两者表现一致。
> 这些限制是平台级规则，无法从客户端脚本侧绕过。

### ⚠️ 会话不活跃时的「静默不投递」

会话不活跃（用户近 24h 未给 bot 发消息）时，`sendmessage` **可能仍返回
`message_id`（不报错）**，但消息不会真正投递到用户微信——这是该通道最需注意的一点：
无法从返回值判断是否送达。

对 `wb-push.js` 的影响：脚本会把这种「假成功」当作成功并写入
`~/.workbuddy/wb-push.state.json` 的 `lastStopPushAt`，导致后续 `Stop` 推送被
5 分钟节流跳过，表现为「手动 `--send` 能收到，但『任务完成』收不到」。

处理步骤：

1. 让用户给微信 clawbot 发任意消息，激活会话；
2. 清空节流状态：把 `~/.workbuddy/wb-push.state.json` 内容写为 `{}`。

> 提示：若 `getconfig` 返回 `{"ret":-4,"errmsg":"GetTypingTicket rpc failed"}`，
> 通常也指向会话不活跃，而非登录态丢失（登录态丢失在两个命名空间里都是 `-14`：
> 业务侧 `ret=-14`，鉴权侧 `errcode=-14 session timeout`）。

## 安全提示

- 不要在仓库中提交 `botToken` / `userId`。本 skill 的脚本运行时从
  `~/.workbuddy/settings.json` 或环境变量读取凭据。
- 同一 botToken 不要被多个长轮询实例同时占用，否则消息可能被抢走。
