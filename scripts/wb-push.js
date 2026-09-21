'use strict';
/**
 * WorkBuddy 手机推送脚本（微信 ClawBot / ilinkai）
 *
 * 用法1（hook 模式，被 WorkBuddy settings.json 的 hooks 调用）:
 *   node wb-push.js --hook <EventName>
 *   从 stdin 读取 hook 事件的 JSON payload
 *
 * 用法2（手动模式，任务完成时由智能体调用）:
 *   node wb-push.js --send "<标题>" "<内容>"
 *   内容也支持从 stdin 读取
 *
 * 微信 ClawBot 通道：
 *   凭据自动从 ~/.workbuddy/settings.json 的 claw.users.*.channels.weixinClawBot 读取
 *   （botToken / userId / baseUrl）。也可用环境变量覆盖：
 *   WBPUSH_WX_TOKEN / WBPUSH_WX_USER / WBPUSH_WX_BASE
 *   协议：POST {base}/ilink/bot/sendmessage（与 WorkBuddy 内置 WeixinClawBotClient 一致）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------- 凭据 ----------
function loadWeixinCreds() {
  const env = {
    botToken: process.env.WBPUSH_WX_TOKEN || '',
    userId: process.env.WBPUSH_WX_USER || '',
    baseUrl: process.env.WBPUSH_WX_BASE || 'https://ilinkai.weixin.qq.com'
  };
  if (env.botToken && env.userId) return env;
  try {
    const sp = path.join(os.homedir(), '.workbuddy', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(sp, 'utf8'));
    const users = settings.claw && settings.claw.users ? settings.claw.users : {};
    for (const uid of Object.keys(users)) {
      const ch = users[uid] && users[uid].channels ? users[uid].channels.weixinClawBot : null;
      if (ch && ch.enabled && ch.botToken && ch.userId) {
        return {
          botToken: ch.botToken,
          userId: ch.userId,
          baseUrl: (ch.baseUrl || 'https://ilinkai.weixin.qq.com').replace(/\/$/, '')
        };
      }
    }
  } catch (e) { /* 读取失败时仅使用环境变量 */ }
  return env;
}

// ---------- 工具 ----------
function truncate(s, n) {
  s = String(s == null ? '' : s).trim();
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { buf += d; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', () => resolve(buf));
    setTimeout(() => resolve(buf), timeoutMs);
  });
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 把 iLink 的错误码翻译成「下一步该怎么做」。未收录的错误码返回空串，保持原始信息不干扰排查。
function wxErrorHint(ret) {
  if (ret === -2) return ' —— 配额用尽或会话不活跃，请在微信里给 clawbot 发任意一条消息刷新后重试';
  if (ret === -14) return ' —— 登录态无效或已过期：先在微信里给 clawbot 发一条消息激活会话，仍失败则重新扫码绑定';
  return '';
}

// ---------- 节流状态（仅限 Stop 完成通知） ----------
// iLink 平台限额：单会话下行配额约 10 条、账号约 7 条/5 分钟。
// 完成通知每回合都推会快速打满配额、饿死「确认请求」推送。
// 因此 Stop 做 5 分钟节流；PermissionRequest 不节流（优先级最高）。
const STATE_FILE = path.join(os.homedir(), '.workbuddy', 'wb-push.state.json');
const STOP_THROTTLE_MS = 5 * 60 * 1000;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(st) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(st)); } catch (e) { /* 忽略 */ }
}

// ---------- 高风险过滤（确认通知专用） ----------
// 确认通知只推「高风险操作」——删除/破坏类命令、系统修改类命令、
// 对系统目录的写入；普通读写/查询不发。
const SYSTEM_DIR_RE = /(^|[\\/'" ])(c:[\\/](windows|program files( \(x86\))?|system32)|[\\/](etc|usr|system|var|boot|bin|sbin|library)[\\/]|~?[\\/]\.ssh[\\/]|boot\.ini)/i;
const DANGER_CMDS = [
  'rm ', 'rm -', 'rmdir', 'del ', 'del/', '/s /q', '/f /q', 'erase', 'format ',
  'shred', 'remove-item', 'delete-item', 'diskpart', 'reg add', 'reg delete',
  'sc delete', 'taskkill', 'shutdown', 'restart-computer', 'stop-computer',
  'format-volume'
];
const WRITE_VERBS = ['cp ', 'copy', 'mv ', 'move', '>', 'tee', 'curl -o', 'wget -o',
  'out-file', 'set-content', 'add-content', 'new-item'];

// 命令类工具：只有这类工具的输入才做「危险命令」全文匹配。
// mcp__*（connector 工具）、Read/Write 等结构化工具的 tool_input 可能含
// 文档全文，全文里的普通文本（如 "rm"、Markdown 引用 ">"）会被误判为危险命令
// （例如 mcp__github__push_files 的 content 是整篇 README）。
const COMMAND_TOOLS = /^(bash|powershell|shell|cmd|execute|terminal)/i;

// 敏感路径：SSH/AWS/凭据文件。SYSTEM_DIR_RE 的 .ssh 匹配因前缀约束漏掉
// 绝对路径（如 C:/Users/x/.ssh/），故独立匹配。
const SENSITIVE_PATH_RE = /(\.ssh[\\/]|\.aws[\\/]|\.gnupg[\\/]|\.kube[\\/]|id_rsa|id_ed25519|known_hosts)/i;

function isHighRisk(toolName, toolInput) {
  const name = String(toolName || '');
  let inputStr = '';
  try { inputStr = JSON.stringify(toolInput || {}); } catch (e) { inputStr = String(toolInput || ''); }
  const lower = (name + ' ' + inputStr).toLowerCase();

  // 1) 文件类工具直接写入系统目录或敏感路径（如 SSH 密钥）
  if (/^(write|edit|notebookedit|create)/i.test(name)) {
    const fp = toolInput && (toolInput.file_path || toolInput.path || toolInput.filePath);
    if (fp && (SYSTEM_DIR_RE.test(String(fp)) || SENSITIVE_PATH_RE.test(String(fp)))) return true;
  }

  // 2) 命令类工具：删除/破坏类命令，或「写动词 + 系统目录」组合
  if (COMMAND_TOOLS.test(name)) {
    if (DANGER_CMDS.some((c) => lower.includes(c))) return true;
    if (WRITE_VERBS.some((v) => lower.includes(v)) && SYSTEM_DIR_RE.test(lower)) return true;
  }

  return false;
}

// ---------- channel_version ----------
// 发给 iLink 的 base_info.channel_version，用于声明「客户端版本」。
//
// 服务端不校验该字段——任意取值（含空串）均返回 HTTP 200 + message_id，
// 因此它不是失效风险点，无需在运行时去读客户端安装版本。
//
// WorkBuddy 客户端内置实现（cli/dist/codebuddy.js 的 WechatApi.buildBaseInfo）
// 当前使用 'cbc-1.0.0'。这里保持与之对齐；万一将来服务端开始校验，
// 可用环境变量覆盖而不必改代码：
//   WBPUSH_WX_CHANNEL_VERSION=cbc-1.0.0
const DEFAULT_CHANNEL_VERSION = 'cbc-1.0.0';
const CHANNEL_VERSION = process.env.WBPUSH_WX_CHANNEL_VERSION || DEFAULT_CHANNEL_VERSION;

// ---------- 通道：微信 ClawBot (ilinkai) ----------
async function sendWeixin(text) {
  const creds = loadWeixinCreds();
  if (!creds.botToken || !creds.userId) {
    throw new Error('未找到微信 ClawBot 凭据（settings.json 中无 enabled 的 weixinClawBot 通道）');
  }
  const payload = {
    msg: {
      from_user_id: '',
      to_user_id: creds.userId,
      client_id: 'wbpush-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      message_type: 2,
      message_state: 2,
      item_list: [{ type: 1, text_item: { text: text } }]
    },
    base_info: { channel_version: CHANNEL_VERSION }
  };
  const body = JSON.stringify(payload);
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(creds.baseUrl + '/ilink/bot/sendmessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
        'X-WECHAT-UIN': randomWechatUin(),
        Authorization: 'Bearer ' + creds.botToken
      },
      body,
      signal: AbortSignal.timeout(15000)
    });
    const respText = await res.text();
    if (!res.ok) throw new Error('微信通道 HTTP ' + res.status + ': ' + respText);
    let json = {};
    try { json = JSON.parse(respText); } catch (e) { /* 非 JSON 响应 */ }
    // 同一个 sendmessage 接口上有两套错误字段：
    //   业务错误 -> ret      例 {"ret":-2,"errmsg":"prepare failed"}（配额耗尽 / 会话不活跃）
    //   鉴权会话 -> errcode  例 {"errcode":-14,"errmsg":"session timeout"}（凭据无效 / 会话过期）
    // 只判断 ret 会漏掉 errcode 类错误，连「凭据完全无效」都会被当成「已发送」。两者都必须判。
    const bizRet = json.ret && json.ret !== 0 ? json.ret : 0;
    const authCode = json.errcode && json.errcode !== 0 ? json.errcode : 0;
    const errCode = bizRet || authCode;
    if (errCode) {
      const field = bizRet ? 'ret' : 'errcode';
      lastErr = new Error('微信通道 ' + field + '=' + errCode + ' ' + (json.errmsg || '') + wxErrorHint(errCode));
      if (errCode === -2 && attempt === 1) {
        // -2 = 限流或配额耗尽，等 4 秒重试一次
        await sleep(4000);
        continue;
      }
      throw lastErr;
    }
    if (json.message_id) return { channel: 'weixin', messageId: String(json.message_id) };
    // 既无 message_id 也无显式成功码 = 无法确认投递。绝不能静默宣称成功。
    if (!(json.ret === 0 || json.errcode === 0)) {
      console.error('[wb-push] 警告: 微信通道响应异常，无法确认投递 -> ' + respText.slice(0, 200));
    }
    return { channel: 'weixin' };
  }
  throw lastErr || new Error('微信通道未知错误');
}

// ---------- 通道：微信 ClawBot 媒体消息（图片 / 视频 / 文件） ----------
// 媒体消息投递的完整链路：
//   1) 本地读文件 → md5 / 密文长度 / 随机 filekey + aeskey(16B)
//   2) POST {base}/ilink/bot/getuploadurl  → 返回 CDN 上传地址
//   3) AES-128-ECB 加密后 POST 密文到 CDN，响应头 x-encrypted-param 即下载凭据
//   4) POST {base}/ilink/bot/sendmessage，item_list 用 image_item / video_item / file_item
// 注意两套枚举不同：上传用 media_type（image=1/video=2/file=3），发送用 item type（image=2/video=5/file=4）。
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
const MEDIA_MAX_BYTES = 100 * 1024 * 1024;
const UPLOAD_MEDIA_TYPE = { image: 1, video: 2, file: 3, voice: 4 };
const OUTBOUND_ITEM_TYPE = { image: 2, video: 5, file: 4 };
const UPLOAD_MAX_RETRIES = 3;

const EXT_TO_MIME = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain', '.csv': 'text/csv', '.md': 'text/markdown', '.json': 'application/json',
  '.zip': 'application/zip', '.tar': 'application/x-tar', '.gz': 'application/gzip', '.7z': 'application/x-7z-compressed',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo'
};

function getMimeFromFilename(f) {
  return EXT_TO_MIME[path.extname(f).toLowerCase()] || 'application/octet-stream';
}

function inferMediaType(filePath) {
  const mime = getMimeFromFilename(filePath);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

// AES-128-ECB 采用 PKCS#7 填充，密文长度向上取整到 16 的倍数（至少多 1 字节填充）
function aesEcbPaddedSize(n) { return Math.ceil((n + 1) / 16) * 16; }

function encryptAesEcb(plaintext, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

async function getUploadUrl(creds, params) {
  const base = creds.baseUrl.endsWith('/') ? creds.baseUrl : creds.baseUrl + '/';
  const url = new URL('ilink/bot/getuploadurl', base);
  const body = JSON.stringify({
    filekey: params.filekey,
    media_type: params.media_type,
    to_user_id: params.to_user_id,
    rawsize: params.rawsize,
    rawfilemd5: params.rawfilemd5,
    filesize: params.filesize,
    no_need_thumb: true,
    aeskey: params.aeskey,
    base_info: { channel_version: CHANNEL_VERSION }
  });
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
      Authorization: 'Bearer ' + creds.botToken
    },
    body,
    signal: AbortSignal.timeout(15000)
  });
  const respText = await res.text();
  if (!res.ok) throw new Error('getuploadurl HTTP ' + res.status + ': ' + respText);
  let data = {};
  try { data = JSON.parse(respText); } catch (e) { /* 非 JSON */ }
  if (data.errcode && data.errcode !== 0) {
    throw new Error('getuploadurl errcode=' + data.errcode + ' ' + (data.errmsg || ''));
  }
  const uploadFullUrl = (data.upload_full_url || '').trim();
  const uploadParam = data.upload_param;
  if (!uploadFullUrl && !uploadParam) {
    throw new Error('getuploadurl 未返回上传地址: ' + respText.slice(0, 300));
  }
  return { uploadFullUrl, uploadParam };
}

async function uploadMediaToCdn(creds, filePath, toUserId, mediaType) {
  const plaintext = await fs.promises.readFile(filePath);
  if (plaintext.length === 0) throw new Error('文件为空: ' + filePath);
  if (plaintext.length > MEDIA_MAX_BYTES) {
    throw new Error('文件过大: ' + plaintext.length + ' 字节（上限 ' + MEDIA_MAX_BYTES + '）');
  }
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskey = crypto.randomBytes(16);

  const up = await getUploadUrl(creds, {
    filekey,
    media_type: UPLOAD_MEDIA_TYPE[mediaType] || UPLOAD_MEDIA_TYPE.file,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString('hex')
  });

  const cdnUrl = up.uploadFullUrl
    ? up.uploadFullUrl
    : CDN_BASE_URL + '/upload?encrypted_query_param=' + encodeURIComponent(up.uploadParam)
      + '&filekey=' + encodeURIComponent(filekey);

  const ciphertext = encryptAesEcb(plaintext, aeskey);

  let downloadEncryptedQueryParam = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(cdnUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(ciphertext),
        signal: AbortSignal.timeout(60000)
      });
      if (resp.status >= 400 && resp.status < 500) {
        const errMsg = resp.headers.get('x-error-message') || (await resp.text().catch(() => ''));
        throw new Error('CDN 上传客户端错误 ' + resp.status + ': ' + errMsg);
      }
      if (resp.status !== 200) throw new Error('CDN 上传服务端错误: ' + resp.status);
      downloadEncryptedQueryParam = resp.headers.get('x-encrypted-param') || null;
      if (!downloadEncryptedQueryParam) throw new Error('CDN 响应缺少 x-encrypted-param 头');
      break;
    } catch (err) {
      lastErr = err;
      if (err instanceof Error && err.message.includes('客户端错误')) throw err;
      if (attempt < UPLOAD_MAX_RETRIES) await sleep(1000 * attempt);
    }
  }
  if (!downloadEncryptedQueryParam) throw lastErr || new Error('CDN 上传失败');

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString('hex'),
    fileSize: rawsize,
    fileSizeCiphertext: filesize
  };
}

function buildMediaItem(uploaded, mediaType, fileName) {
  // 与官方实现一致：aes_key 传 base64(hex 字符串)，encrypt_type 固定 1
  const aesKeyBase64 = Buffer.from(uploaded.aeskey).toString('base64');
  const media = {
    encrypt_query_param: uploaded.downloadEncryptedQueryParam,
    aes_key: aesKeyBase64,
    encrypt_type: 1
  };
  if (mediaType === 'image') {
    return {
      type: OUTBOUND_ITEM_TYPE.image,
      image_item: { media, mid_size: uploaded.fileSizeCiphertext }
    };
  }
  if (mediaType === 'video') {
    return {
      type: OUTBOUND_ITEM_TYPE.video,
      video_item: { media, video_size: uploaded.fileSizeCiphertext }
    };
  }
  return {
    type: OUTBOUND_ITEM_TYPE.file,
    file_item: {
      media,
      file_name: fileName || 'file',
      len: String(uploaded.fileSize)
    }
  };
}

async function sendWeixinItems(creds, itemList) {
  const body = JSON.stringify({
    msg: {
      from_user_id: '',
      to_user_id: creds.userId,
      client_id: 'wbpush-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      message_type: 2,
      message_state: 2,
      item_list: itemList
    },
    base_info: { channel_version: CHANNEL_VERSION }
  });
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(creds.baseUrl + '/ilink/bot/sendmessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        AuthorizationType: 'ilink_bot_token',
        'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
        'X-WECHAT-UIN': randomWechatUin(),
        Authorization: 'Bearer ' + creds.botToken
      },
      body,
      signal: AbortSignal.timeout(20000)
    });
    const respText = await res.text();
    if (!res.ok) throw new Error('微信通道 HTTP ' + res.status + ': ' + respText);
    let json = {};
    try { json = JSON.parse(respText); } catch (e) { /* 非 JSON 响应 */ }
    // 同 sendWeixin()：ret 与 errcode 两套错误字段都要判
    const bizRet = json.ret && json.ret !== 0 ? json.ret : 0;
    const authCode = json.errcode && json.errcode !== 0 ? json.errcode : 0;
    const errCode = bizRet || authCode;
    if (errCode) {
      const field = bizRet ? 'ret' : 'errcode';
      lastErr = new Error('微信通道 ' + field + '=' + errCode + ' ' + (json.errmsg || '') + wxErrorHint(errCode));
      if (errCode === -2 && attempt === 1) { await sleep(4000); continue; }
      throw lastErr;
    }
    if (json.message_id) return { channel: 'weixin', messageId: String(json.message_id) };
    if (!(json.ret === 0 || json.errcode === 0)) {
      console.error('[wb-push] 警告: 微信通道响应异常，无法确认投递 -> ' + respText.slice(0, 200));
    }
    return { channel: 'weixin' };
  }
  throw lastErr || new Error('微信通道未知错误');
}

async function sendWeixinFile(creds, filePath, mediaType) {
  const fileName = path.basename(filePath);
  const uploaded = await uploadMediaToCdn(creds, filePath, creds.userId, mediaType);
  const item = buildMediaItem(uploaded, mediaType, fileName);
  return sendWeixinItems(creds, [item]);
}

// ---------- 主推送：微信 ClawBot ----------
async function push(title, desp) {
  const text = title + (desp ? '\n\n' + desp : '');
  const r = await sendWeixin(text);
  console.error('[wb-push] 已通过微信 ClawBot 发送' + (r.messageId ? ' (msg ' + r.messageId + ')' : ''));
  return r;
}

async function main() {
  const mode = process.argv[2];
  const arg1 = process.argv[3] || '';
  const arg2 = process.argv[4] || '';

  if (mode === '--hook') {
    const raw = await readStdin(3000);
    let p = {};
    try { if (raw.trim()) p = JSON.parse(raw); } catch (e) { /* 忽略解析错误 */ }
    const ev = arg1 || 'Unknown';

    // 调试捕获：记录 PermissionRequest / Notification 的原始 payload（排查过滤规则用，限 200KB）
    if (ev === 'PermissionRequest' || ev === 'Notification') {
      try {
        const dbg = path.join(os.homedir(), '.workbuddy', 'wb-push.debug.log');
        let old = '';
        try { old = fs.readFileSync(dbg, 'utf8'); } catch (e) { /* 不存在 */ }
        if (old.length > 200 * 1024) old = old.slice(-100 * 1024);
        fs.writeFileSync(dbg, old + JSON.stringify({ at: new Date().toISOString(), ev, payload: p }) + '\n');
      } catch (e) { /* 忽略 */ }
    }

    let title = 'WorkBuddy 通知';
    let desp = '';
    if (ev === 'PermissionRequest') {
      // 只推高风险操作，普通读写/查询跳过。
      if (!isHighRisk(p.tool_name, p.tool_input)) {
        console.error('[wb-push] 普通操作跳过确认通知: ' + (p.tool_name || '未知'));
        return;
      }
      title = '⚠️ WorkBuddy 需要你的确认';
      let detail = '';
      try { detail = truncate(JSON.stringify(p.tool_input || {}), 400); } catch (e) { /* 忽略 */ }
      desp = '操作: ' + (p.tool_name || '未知') + '\n' + detail;
    } else if (ev === 'Notification') {
      // 权限提示类系统通知（Claude Code 风格 Notification hook）。
      // 部分沙箱层弹窗（如批量删除防护）可能走这个事件——先用捕获日志确认。
      const ntype = String(p.notification_type || '');
      const msg = String(p.message || '');
      if (!/permission|prompt|approval/i.test(ntype + ' ' + msg)) {
        console.error('[wb-push] 非权限类通知，跳过: ' + ntype);
        return;
      }
      const m = msg.match(/to\s+use\s+([A-Za-z_][\w.-]*)/i);
      const toolName = m ? m[1] : '';
      if (!isHighRisk(toolName, { message: msg })) {
        console.error('[wb-push] 普通操作跳过通知: ' + (toolName || ntype || '未知'));
        return;
      }
      title = '⚠️ WorkBuddy 需要你的确认';
      desp = truncate(msg, 400);
    } else if (ev === 'Stop') {
      // 每次对话回合结束自动推送（settings.json hooks.Stop）。
      // 只显示「✅ 任务完成」，不带回复内容/目录/会话。
      // 5 分钟节流：否则完成通知会打满 iLink 配额，把「确认请求」推送饿死。
      const msg = String(p.last_assistant_message || '').trim();
      if (!msg) { console.error('[wb-push] Stop 事件无回复内容，跳过'); return; }
      const st = loadState();
      const last = Number(st.lastStopPushAt) || 0;
      if (Date.now() - last < STOP_THROTTLE_MS) {
        console.error('[wb-push] Stop 节流跳过（距上次成功推送不足5分钟）');
        return;
      }
      const r = await push('✅ 任务完成', '');
      if (r && r.channel === 'weixin') {
        st.lastStopPushAt = Date.now();
        saveState(st);
      }
      return;
    } else {
      title = 'WorkBuddy 事件: ' + ev;
      desp = truncate(JSON.stringify(p), 400);
    }
    const sid = p.session_id || '';
    if (sid && ev !== 'Stop') desp += '\n\n会话: ' + sid;
    await push(title, desp);
  } else if (mode === '--send') {
    const title = arg1 || 'WorkBuddy 通知';
    let desp = arg2 || '';
    if (!desp) {
      const raw = await readStdin(1500);
      if (raw.trim()) desp = raw.trim();
    }
    await push(title, truncate(desp, 1500));
    console.log('[wb-push] 已发送: ' + title);
  } else if (mode === '--send-file' || mode === '--send-image') {
    const filePath = arg1;
    const caption = arg2 || '';
    if (!filePath) {
      console.error('用法: node wb-push.js --send-file "<文件路径>" ["说明文本"]');
      process.exit(2);
    }
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      console.error('[wb-push] 文件不存在: ' + abs);
      process.exit(1);
    }
    const credsF = loadWeixinCreds();
    if (!credsF.botToken || !credsF.userId) {
      console.error('[wb-push] 未找到微信 ClawBot 凭据（settings.json 中无 enabled 的 weixinClawBot 通道）');
      process.exit(1);
    }
    const mediaType = mode === '--send-image' ? 'image' : inferMediaType(abs);
    const sizeBytes = fs.statSync(abs).size;
    console.error('[wb-push] 上传中: ' + path.basename(abs) + ' (' + sizeBytes + ' 字节, 类型=' + mediaType + ')');
    const r = await sendWeixinFile(credsF, abs, mediaType);
    const label = mediaType === 'image' ? '图片' : mediaType === 'video' ? '视频' : '文件';
    console.error('[wb-push] 已发送' + label + ': ' + path.basename(abs) + (r.messageId ? ' (msg ' + r.messageId + ')' : ''));
    if (caption) {
      await sleep(1200);
      await push('📎 ' + path.basename(abs), caption);
    }
    console.log('[wb-push] 已发送' + label + ': ' + path.basename(abs));
  } else {
    console.error('用法: node wb-push.js --hook <EventName> | --send "<标题>" "<内容>" | --send-file "<文件路径>" ["说明文本"]');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error('[wb-push] 发送失败: ' + e.message);
  process.exit(1);
});
