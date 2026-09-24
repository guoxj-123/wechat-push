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
 * 用法3（凭据与投递诊断）:
 *   node wb-push.js --cred-status           # 诊断凭据解析路径（不打印密钥）
 *   node wb-push.js --session-status        # 探测会话活跃度（getconfig），判断能否真正投递
 *   node wb-push.js --set-token "<token>" [userId]   # 手动写入本地凭据缓存
 *   node wb-push.js --recover-token         # 从 claw-state/历史 settings.json* 回收明文 token
 *
 * 微信 ClawBot 通道：
 *   协议：POST {base}/ilink/bot/sendmessage（与 WorkBuddy 内置 WeixinClawBotClient 一致）
 *   凭据解析顺序（先命中先用）：
 *     1) 环境变量 WBPUSH_WX_TOKEN / WBPUSH_WX_USER / WBPUSH_WX_BASE
 *        （可选 WBPUSH_WX_CONTEXT_TOKEN，被动回复场景需要）
 *     2) 本地凭据缓存 ~/.workbuddy/wb-push.credentials.json（0600）
 *     3) ~/.workbuddy/settings.json 中的明文凭据（旧版客户端仍为明文）
 *     4) claw-state 长轮询游标 ~/.workbuddy/claw-state/weixin/<accountId>_im.bot.cursor.json
 *        该文件内嵌当前绑定的 <accountId>@im.bot:<hex> 身份串（于 get_updates_buf 的
 *        base64 里），格式与 botToken 同构，由客户端每轮 getupdates 刷新——无需解密，
 *        且天然跟随重新绑定（文件名即账号），是加密客户端下最可靠的自动来源。
 *     5) 自动恢复：从历史 settings.json* 备份回收最新的明文 botToken（仅当账号一致）
 *
 *   ⚠️ WorkBuddy 5.6+ 把 settings.json 的 botToken / channelId 改为加密信封
 *      {"$wbEncrypted":1,"envelope":"<base64>"}。密钥由客户端原生层
 *      （WorkBuddy.exe!electron_browser_workbuddy_storage）在启动时通过
 *      IPC 下发给 CLI，外部脚本无法获取，故无法解密。
 *      旧版脚本会把对象直接拼进请求头，得到 "Bearer [object Object]"，iLink
 *      返回误导性的 errcode=-14 session timeout。本版改为显式识别信封并报错，
 *      并优先经第 4 条（claw-state）自动取得当前绑定的有效凭据。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------- 凭据 ----------
const WB_DIR = path.join(os.homedir(), '.workbuddy');
const CRED_CACHE_FILE = path.join(WB_DIR, 'wb-push.credentials.json');
const LIVE_SETTINGS_FILE = path.join(WB_DIR, 'settings.json');
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
// botToken 形如 xxxxxxxxxxxx@im.bot:0a1b2c3d...（<accountId>:<hex>）
const BOT_TOKEN_RE = /^[A-Za-z0-9_-]+@[A-Za-z0-9_.-]+:[0-9a-fA-F]{8,}$/;

// 诊断信息（--cred-status 与错误信息用；绝不写入密钥本身）
const credNotes = [];
function note(msg) { credNotes.push(msg); }

function isEncryptedEnvelope(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && v.$wbEncrypted !== undefined;
}

// 从指定 settings 文件里取 weixinClawBot 通道对象（不校验 enabled，便于备份回收）
function readChannelFrom(file) {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  const users = (settings.claw && settings.claw.users) ? settings.claw.users : {};
  for (const uid of Object.keys(users)) {
    const ch = users[uid] && users[uid].channels ? users[uid].channels.weixinClawBot : null;
    if (ch) return ch;
  }
  return null;
}

function readCredCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CRED_CACHE_FILE, 'utf8'));
    if (c && typeof c.botToken === 'string') return c;
  } catch (e) { /* 无缓存 */ }
  return null;
}

function writeCredCache(obj) {
  try {
    fs.writeFileSync(CRED_CACHE_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
    note('已写入凭据缓存 ' + CRED_CACHE_FILE);
    return true;
  } catch (e) {
    note('凭据缓存写入失败: ' + e.message);
    return false;
  }
}

// 从历史 settings.json* 备份里回收最新的「明文」token。
// 只接受与当前账号（accountId / channelId）一致的 token，避免回收成过期账号。
function recoverFromBackups(expectedAccount) {
  let files = [];
  try {
    files = fs.readdirSync(WB_DIR)
      .filter((f) => /^settings\.json($|\.)/.test(f))
      .map((f) => path.join(WB_DIR, f));
  } catch (e) { return null; }
  const cands = [];
  for (const f of files) {
    let ch, mtime;
    try { mtime = fs.statSync(f).mtimeMs; } catch (e) { continue; }
    ch = readChannelFrom(f);
    if (!ch) continue;
    const tok = ch.botToken;
    if (typeof tok !== 'string' || !BOT_TOKEN_RE.test(tok)) continue;
    if (expectedAccount && !tok.startsWith(expectedAccount + ':')) continue;
    cands.push({ file: path.basename(f), mtime, botToken: tok, userId: ch.userId, baseUrl: ch.baseUrl });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.mtime - a.mtime);
  return cands[0];
}

// ---------- claw-state 游标凭据回收（WorkBuddy 5.6+ 加密客户端下的主用来源） ----------
// 客户端长轮询 getupdates 时会把 <accountId>@im.bot:<hex> 身份串写进
// claw-state/weixin/<accountId>_im.bot.cursor.json 的 get_updates_buf（base64 包装）。
// 该串与 botToken 同构、可直接用作 Bearer 凭据，且由客户端持续刷新，
// 因此它既能自动跟随重新绑定，也不涉及任何解密。
const CLAW_STATE_DIR = path.join(WB_DIR, 'claw-state', 'weixin');
const CURSOR_TOKEN_RE = /[0-9a-fA-F]{6,}@[A-Za-z0-9_.-]+:[0-9a-fA-F]{8,}/g;
const CURSOR_FILE_RE = /_im\.bot\.cursor\.json$/;

function extractTokenFromCursor(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    const raw = String(c.get_updates_buf || '');
    if (!raw) return null;
    const text = Buffer.from(raw, 'base64').toString('utf8');
    const found = text.match(CURSOR_TOKEN_RE);
    if (!found) return null;
    for (const cand of found) if (BOT_TOKEN_RE.test(cand)) return cand;
    return null;
  } catch (e) { return null; }
}

// expectedAccount 形如 <botId>@im.bot；给了就只认同账号的游标文件，
// 避免在重新绑定后误取旧账号凭据。
function recoverFromClawState(expectedAccount) {
  let files = [];
  try {
    files = fs.readdirSync(CLAW_STATE_DIR)
      .filter((f) => CURSOR_FILE_RE.test(f))
      .map((f) => path.join(CLAW_STATE_DIR, f));
  } catch (e) { return null; }
  const want = expectedAccount ? String(expectedAccount).split('@')[0] : '';
  const cands = [];
  for (const f of files) {
    const base = path.basename(f);
    if (want && !base.startsWith(want + '_')) continue;
    let mtime;
    try { mtime = fs.statSync(f).mtimeMs; } catch (e) { continue; }
    const tok = extractTokenFromCursor(f);
    if (!tok) continue;
    if (expectedAccount && !tok.startsWith(expectedAccount + ':')) continue;
    cands.push({ file: 'claw-state/weixin/' + base, mtime, botToken: tok });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.mtime - a.mtime);
  return cands[0];
}

// 统一的「明文 token 回收」入口：先看 claw-state（当前绑定、时效最新），
// 再退回历史 settings.json* 备份。供 loadWeixinCreds 与 --recover-token 共用。
function recoverPlaintextToken(expectedAccount) {
  const cs = recoverFromClawState(expectedAccount);
  if (cs) return { ...cs, origin: 'claw-state' };
  const bk = recoverFromBackups(expectedAccount);
  if (bk) return { ...bk, origin: 'backup' };
  return null;
}

// 会话活跃度探测（--session-status）：getconfig 的 ret 是「能否主动投递」的可靠判据。
//   ret=0            → 会话活跃，主动推送可投递
//   ret=-4           → 该 bot 下无活跃会话，主动推送会被静默丢弃（sendmessage 仍返回 message_id）
//   errcode=-14      → 凭据本身无效（先跑 --cred-status）
// 注意：requestDeliveries 只记录文件/产物投递，不能用来判断文本会话是否活跃。
async function probeSession(creds) {
  const body = JSON.stringify({
    ilink_user_id: creds.userId,
    base_info: { channel_version: CHANNEL_VERSION }
  });
  console.log('[wb-push] 会话探测（getconfig）:');
  console.log('  凭据来源  : ' + creds.source);
  console.log('  目标 userId: ' + (creds.userId || '(空)'));
  console.log('  baseUrl   : ' + creds.baseUrl);
  let res, txt, json = {};
  try {
    res = await fetch(creds.baseUrl + '/ilink/bot/getconfig', {
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
    txt = await res.text();
  } catch (e) {
    console.log('  请求失败  : ' + e.message);
    return 1;
  }
  try { json = JSON.parse(txt); } catch (e) { /* 非 JSON */ }
  const ret = json.ret;
  const authCode = json.errcode;
  console.log('  返回值    : ' + 'ret=' + (ret === undefined ? '(缺失)' : ret) +
    (authCode ? (' errcode=' + authCode) : '') + (json.errmsg ? (' errmsg=' + json.errmsg) : ''));
  if (authCode === -14) {
    console.log('  判定      : 凭据无效/已过期（鉴权层）→ 先用 --cred-status 确认凭据来源');
    return 1;
  }
  if (ret === 0) {
    console.log('  判定      : 会话活跃 → 主动推送可投递');
    console.log('  typing_ticket: ' + (json.typing_ticket ? '已下发' : '未下发'));
    return 0;
  }
  if (ret === -4) {
    console.log('  判定      : 该 bot 下无活跃会话 → 主动推送会被静默丢弃（平台仍返回 message_id，退出码 0）');
    console.log('  处置      : 让用户在微信里给 clawbot 发一条消息以建立/刷新会话；');
    console.log('              若微信里找不到该会话，说明换绑未完成，需在 WorkBuddy 中重新扫码绑定');
    return 1;
  }
  console.log('  判定      : 未识别的返回码，请对照 references/ilink-protocol.md 的错误码表');
  return 1;
}

function loadWeixinCreds() {
  credNotes.length = 0;
  const baseUrlEnv = process.env.WBPUSH_WX_BASE || '';
  const ctxToken = process.env.WBPUSH_WX_CONTEXT_TOKEN || '';

  // 1) 环境变量
  if (process.env.WBPUSH_WX_TOKEN && process.env.WBPUSH_WX_USER) {
    return {
      botToken: process.env.WBPUSH_WX_TOKEN,
      userId: process.env.WBPUSH_WX_USER,
      baseUrl: (baseUrlEnv || DEFAULT_BASE_URL).replace(/\/$/, ''),
      contextToken: ctxToken,
      source: 'env'
    };
  }

  const live = readChannelFrom(LIVE_SETTINGS_FILE);
  let liveAccount = '';
  let liveUserId = '';
  let liveBaseUrl = DEFAULT_BASE_URL;
  let liveTokenState = 'missing';
  if (live) {
    liveAccount = typeof live.accountId === 'string' ? live.accountId
      : (typeof live.channelId === 'string' ? live.channelId : '');
    if (typeof live.userId === 'string') liveUserId = live.userId;
    if (typeof live.baseUrl === 'string' && live.baseUrl) liveBaseUrl = live.baseUrl;
    if (typeof live.botToken === 'string' && live.botToken) liveTokenState = 'plaintext';
    else if (isEncryptedEnvelope(live.botToken)) liveTokenState = 'encrypted';
  }
  note('settings.json: token=' + liveTokenState + (live ? '' : ' (无 weixinClawBot 通道)'));

  // 2) 本地凭据缓存
  const cache = readCredCache();
  if (cache && cache.botToken) {
    if (!liveAccount || cache.botToken.startsWith(liveAccount + ':')) {
      note('命中凭据缓存（' + (cache.source || 'unknown') + '，' + (cache.updatedAt || '无时间戳') + '）');
      return {
        botToken: cache.botToken,
        userId: cache.userId || liveUserId,
        baseUrl: (cache.baseUrl || liveBaseUrl).replace(/\/$/, ''),
        contextToken: ctxToken || cache.contextToken || '',
        source: 'cache'
      };
    }
    note('凭据缓存账号与当前账号不一致，已忽略');
  }

  // 3) settings.json 明文
  if (liveTokenState === 'plaintext' && live && live.enabled !== false) {
    note('使用 settings.json 明文凭据');
    return {
      botToken: live.botToken,
      userId: liveUserId,
      baseUrl: liveBaseUrl.replace(/\/$/, ''),
      contextToken: ctxToken,
      source: 'settings'
    };
  }

  // 4) 自动回收：claw-state 游标优先（当前绑定、客户端持续刷新），其次历史备份
  const rec = recoverPlaintextToken(liveAccount);
  if (rec) {
    const recUserId = rec.userId || liveUserId;
    note('回收来源: ' + rec.file + '（' + rec.origin + '，mtime ' + new Date(rec.mtime).toISOString() + '）');
    if (!recUserId) {
      note('回收到的凭据缺 userId，且 settings.json 中亦无 userId，无法使用');
    } else {
      if (rec.origin === 'backup') {
        // 备份是静态时点的，落缓存以备备份文件被清理后仍可用；
        // claw-state 由客户端持续刷新，故不落缓存，避免制造陈旧副本。
        writeCredCache({
          botToken: rec.botToken,
          userId: recUserId,
          baseUrl: (rec.baseUrl || liveBaseUrl),
          source: 'recovered:' + rec.file,
          updatedAt: new Date().toISOString()
        });
      }
      return {
        botToken: rec.botToken,
        userId: recUserId,
        baseUrl: (rec.baseUrl || liveBaseUrl).replace(/\/$/, ''),
        contextToken: ctxToken,
        source: rec.origin + ':' + rec.file
      };
    }
  }

  if (liveTokenState === 'encrypted') {
    note('settings.json 凭据为 $wbEncrypted 加密信封，外部脚本无法解密；claw-state 与历史备份中亦未找到可用明文 token');
  }
  return {
    botToken: '',
    userId: liveUserId,
    baseUrl: liveBaseUrl.replace(/\/$/, ''),
    contextToken: ctxToken,
    source: 'none',
    error:
      '无法获得可用的微信 ClawBot 明文凭据。\n' +
      'WorkBuddy 5.6+ 把 settings.json 里的 botToken 存成了加密信封（密钥在客户端原生层，脚本无法解密），\n' +
      '本脚本的自动回收（claw-state 游标 → 历史备份）也都没找到与当前账号匹配的明文 token。\n' +
      '解决方式（任选其一）：\n' +
      '  A) 让 WorkBuddy 客户端保持运行并至少完成一轮消息轮询，再重试——这会刷新\n' +
      '     ~/.workbuddy/claw-state/weixin/<accountId>_im.bot.cursor.json，脚本即可自动取到凭据；\n' +
      '  B) 定时任务改用客户端原生开关：编辑任务 → 打开「推送到微信」，任务输出由平台直接投递，无需脚本；\n' +
      '  C) 手动指定：WBPUSH_WX_TOKEN=<token> WBPUSH_WX_USER=<userId> node wb-push.js --send ...；\n' +
      '     或 node wb-push.js --set-token "<token>" "<userId>" 写入本地凭据缓存；\n' +
      '     或 node wb-push.js --recover-token 从 claw-state/历史备份回收（需账号一致）。'
  };
}

// 打印凭据诊断（不含密钥）
function printCredStatus(creds) {
  const mask = (t) => (!t ? '(空)' : t.length <= 12 ? t : t.slice(0, 8) + '…' + t.slice(-4) + ' (len ' + t.length + ')');
  console.log('[wb-push] 凭据解析路径:');
  for (const n of credNotes) console.log('  - ' + n);
  console.log('  最终来源: ' + creds.source);
  console.log('  botToken: ' + mask(creds.botToken));
  console.log('  userId  : ' + (creds.userId || '(空)'));
  console.log('  baseUrl : ' + creds.baseUrl);
  console.log('  context : ' + (creds.contextToken ? '有' : '无'));
  if (!creds.botToken) console.log('\n' + creds.error);
  return !!creds.botToken;
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
// 实测口径（2026-09-24 用有效凭据逐项探测）：
//   errcode=-14 鉴权层：凭据无效/过期；或请求头里塞了非字符串 token（如 [object Object]）
//   ret=-2      参数层：缺必填字段（实测缺 to_user_id → "invalid arguments"；sendtyping 缺 ilink_user_id → "ilink_user_id required"）
//   ret=-3      报文档位：字段齐全但仍被拒，多为缺少有效的 context_token（新版客户端报文带 context_token）
//   ret=-4      服务端业务：如 getconfig 无活跃会话 → "GetTypingTicket rpc failed"
function wxErrorHint(ret) {
  if (ret === -2) return ' —— 参数缺失/无效（必填字段没给全），核对 msg.to_user_id 等字段';
  if (ret === -3) return ' —— 报文被拒：常见原因是缺少有效的 context_token。请先在微信里给机器人发一条消息激活会话，再重试；或改用客户端原生的「推送到微信」开关';
  if (ret === -4) return ' —— 服务端业务失败：当前账号没有活跃会话（先给机器人发一条消息）';
  if (ret === -14) return ' —— 鉴权失败：凭据无效或已过期。若发送头里出现 "[object Object]" 说明读到了加密信封（用 --cred-status 诊断）';
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
    const err = new Error(creds.error || '未找到微信 ClawBot 明文凭据（settings.json 中无 enabled 的 weixinClawBot 通道）');
    err.code = 'CREDENTIAL_UNAVAILABLE';
    throw err;
  }
  const msg = {
    from_user_id: '',
    to_user_id: creds.userId,
    client_id: 'wbpush-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    message_type: 2,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text: text } }]
  };
  // 新版 iLink 对缺 context_token 的报文可能返回 ret=-3；有则带上（被动回复场景必须回传）
  if (creds.contextToken) msg.context_token = creds.contextToken;
  const payload = { msg: msg, base_info: { channel_version: CHANNEL_VERSION } };
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
  const msg = {
    from_user_id: '',
    to_user_id: creds.userId,
    client_id: 'wbpush-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    message_type: 2,
    message_state: 2,
    item_list: itemList
  };
  if (creds.contextToken) msg.context_token = creds.contextToken;
  const body = JSON.stringify({
    msg: msg,
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
      console.error('[wb-push] ' + (credsF.error || '未找到微信 ClawBot 明文凭据'));
      process.exit(3);
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
  } else if (mode === '--cred-status') {
    // 诊断凭据解析路径，不打印完整密钥
    const creds = loadWeixinCreds();
    const ok = printCredStatus(creds);
    process.exit(ok ? 0 : 3);
  } else if (mode === '--session-status') {
    // 探测会话活跃度：分诊「凭据问题」与「会话未建立」这两个都会表现为收不到消息的成因
    const credsS = loadWeixinCreds();
    if (!credsS.botToken) {
      console.error('[wb-push] ' + (credsS.error || '未找到微信 ClawBot 明文凭据'));
      process.exit(3);
    }
    process.exit(await probeSession(credsS));
  } else if (mode === '--set-token') {
    // 手动写入本地凭据缓存：--set-token "<botToken>" [userId]
    const token = (arg1 || '').trim();
    if (!BOT_TOKEN_RE.test(token)) {
      console.error('[wb-push] token 格式不合法，应形如 <accountId>@im.bot:<hex>（当前长度 ' + token.length + '）');
      process.exit(2);
    }
    let userId = (arg2 || '').trim();
    let baseUrl = DEFAULT_BASE_URL;
    const ch = readChannelFrom(LIVE_SETTINGS_FILE);
    if (ch) {
      if (!userId && typeof ch.userId === 'string') userId = ch.userId;
      if (typeof ch.baseUrl === 'string' && ch.baseUrl) baseUrl = ch.baseUrl;
      if (typeof ch.accountId === 'string' && !token.startsWith(ch.accountId + ':')) {
        console.error('[wb-push] 警告: token 账号前缀与 settings.json 的 accountId(' + ch.accountId + ') 不一致，仍按输入写入');
      }
    }
    if (!userId) {
      console.error('[wb-push] 缺少 userId，请用 --set-token "<token>" "<userId>" 显式给出');
      process.exit(2);
    }
    writeCredCache({ botToken: token, userId: userId, baseUrl: baseUrl, source: 'manual', updatedAt: new Date().toISOString() });
    console.log('[wb-push] 已写入凭据缓存: ' + CRED_CACHE_FILE + '（userId=' + userId + '）');
  } else if (mode === '--recover-token') {
    // 回收可用明文 token：claw-state 游标优先（当前绑定），其次历史 settings.json* 备份
    const ch = readChannelFrom(LIVE_SETTINGS_FILE);
    let acc = ch && typeof ch.accountId === 'string' ? ch.accountId : '';
    if (!acc && ch && typeof ch.channelId === 'string') acc = ch.channelId;
    if (!acc) {
      // 5.6+ 客户端下 accountId 可能缺失，或与 channelId 一样被加密：
      // 此时允许不带账号校验地扫描游标，取 mtime 最新者并明确告警。
      console.error('[wb-push] 警告: settings.json 无可读的 accountId，将按最新 mtime 选取 claw-state 游标凭据');
    }
    const rec = recoverPlaintextToken(acc);
    if (!rec) {
      console.error('[wb-push] 未在 claw-state 游标或历史 settings.json* 备份中找到' + (acc ? ('账号 ' + acc + ' 的') : '') + '明文 token');
      process.exit(3);
    }
    const recUserId = rec.userId || (ch && typeof ch.userId === 'string' ? ch.userId : '');
    if (!recUserId) {
      console.error('[wb-push] 来源 ' + rec.file + ' 无 userId，且 settings.json 中亦无，无法写入缓存');
      process.exit(3);
    }
    writeCredCache({
      botToken: rec.botToken,
      userId: recUserId,
      baseUrl: rec.baseUrl || (ch && ch.baseUrl) || DEFAULT_BASE_URL,
      source: 'recovered:' + rec.file,
      updatedAt: new Date().toISOString()
    });
    console.log('[wb-push] 已回收明文 token：来源 ' + rec.file + '（' + rec.origin + '，mtime ' + new Date(rec.mtime).toISOString() + (acc ? ('，账号 ' + acc) : '') + '）');
    console.log('[wb-push] 注意：若客户端此后重新扫码绑定过，回收到的 token 可能已轮换——优先依赖自动回收而非缓存。');
  } else {
    console.error('用法: node wb-push.js --hook <EventName> | --send "<标题>" "<内容>" | --send-file "<文件路径>" ["说明文本"]');
    console.error('      node wb-push.js --cred-status | --session-status | --recover-token | --set-token "<token>" "<userId>"');
    process.exit(2);
  }
}

main().catch((e) => {
  console.error('[wb-push] 发送失败: ' + e.message);
  // 凭据类失败统一退出码 3（区别于网络/协议失败的 1），便于自动化区分处置
  process.exit(e && e.code === 'CREDENTIAL_UNAVAILABLE' ? 3 : 1);
});
