'use strict';
/**
 * wb-audit-watch.js — 审计日志守护脚本
 *
 * 监听 WorkBuddy 审计日志（~/.workbuddy/audit-log/ 及 spool/ 子目录下的 *.jsonl），
 * 当出现「*.needs-approval」事件（如 file-safety.bulk-delete.needs-approval，
 * 即批量删除防护弹窗）时，立即通过 wb-push.js 推送到用户微信。
 *
 * 设计：每 2 秒全量读取所有 jsonl（文件都很小），按事件哈希去重。
 * 不依赖文件偏移——spool 文件会被审计系统频繁重写/合并，偏移追踪不可靠。
 *
 * 用法:
 *   node wb-audit-watch.js            # 常驻轮询（每 2 秒）
 *   node wb-audit-watch.js --once     # 单次扫描后退出（测试用）
 *   node wb-audit-watch.js --reset    # 只初始化（把现有事件标记为已见，不推送）
 *   环境变量 WB_AUDIT_DIR 可覆盖审计目录（测试用）
 *
 * 日志: ~/.workbuddy/wb-audit-watch.log
 * 状态: ~/.workbuddy/wb-audit-watch.state.json（seen 事件 id 集合）
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const AUDIT_DIR = process.env.WB_AUDIT_DIR || path.join(os.homedir(), '.workbuddy', 'audit-log');
const STATE_FILE = path.join(os.homedir(), '.workbuddy', 'wb-audit-watch.state.json');
const LOCK_FILE = path.join(os.homedir(), '.workbuddy', 'wb-audit-watch.lock');
const LOG_FILE = path.join(os.homedir(), '.workbuddy', 'wb-audit-watch.log');
// 与 wb-push.js 同处 scripts/ 目录，用 __dirname 定位，不依赖 skill 的安装位置。
// 注意：不要改用 HOME 下的绝对路径——skill 可被安装到任意目录。
const WB_PUSH = path.join(__dirname, 'wb-push.js');
const POLL_MS = 2000;
const MAX_SEEN = 800;
const VERSION = 'v3';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) { /* 忽略 */ }
  console.log(line);
}

// ---------- 单实例锁（带版本，可自动接管旧版本） ----------
function acquireLock() {
  try {
    const old = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    const [oldPid, oldVer] = old.split('|');
    const pid = parseInt(oldPid, 10);
    if (pid) {
      try {
        process.kill(pid, 0);
        // 旧进程还活着
        if (oldVer === VERSION) return false; // 同版本已在运行
        log('发现旧版本进程 ' + pid + '，尝试接管');
        try { process.kill(pid, 'SIGTERM'); } catch (e) { /* 忽略 */ }
        return new Promise((resolve) => setTimeout(() => {
          try { process.kill(pid, 0); return resolve(false); } catch (e) { /* 已退出 */ }
          fs.writeFileSync(LOCK_FILE, process.pid + '|' + VERSION);
          resolve(true);
        }, 1500));
      } catch (e) { /* 旧进程已死，可接管 */ }
    }
  } catch (e) { /* 无锁文件 */ }
  fs.writeFileSync(LOCK_FILE, process.pid + '|' + VERSION);
  return true;
}
function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* 忽略 */ }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(st) {
  try {
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(st));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) { /* 忽略 */ }
}

function listJsonl(dir) {
  const out = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.jsonl')) out.push(path.join(dir, name));
    }
    const spool = path.join(dir, 'spool');
    if (fs.existsSync(spool) && fs.statSync(spool).isDirectory()) {
      for (const name of fs.readdirSync(spool)) {
        if (name.endsWith('.jsonl')) out.push(path.join(spool, name));
      }
    }
  } catch (e) { /* 忽略 */ }
  return out;
}

function pushWechat(title, desc) {
  try {
    const r = spawnSync(process.execPath, [WB_PUSH, '--send', title, desc], {
      timeout: 25000,
      encoding: 'utf8'
    });
    return r.status === 0;
  } catch (e) {
    return false;
  }
}

function buildMessage(ev) {
  const et = String(ev.eventType || '');
  const mp = ev.messageParams || {};
  const count = Number(mp.count) || 0;
  const threshold = Number(mp.threshold) || 0;
  const targets = String(mp.targets || '').slice(0, 200);
  if (/bulk-delete/.test(et)) {
    return {
      title: '⚠️ WorkBuddy 需要你的确认',
      desc: '检测到批量删除：' + count + ' 个文件（阈值 ' + threshold + '）\n目标: ' + targets
    };
  }
  return {
    title: '⚠️ WorkBuddy 需要你的确认',
    desc: '事件: ' + et + '\n' + (targets ? '目标: ' + targets : '')
  };
}

function scanAll(state, pushEnabled) {
  let pushedCount = 0;
  for (const f of listJsonl(AUDIT_DIR)) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let ev;
      try { ev = JSON.parse(t); } catch (e) { continue; }
      const et = String(ev.eventType || '');
      if (!et || !et.endsWith('.needs-approval')) continue;
      // spool 里的实时事件没有 id（id 是合并到日账时才生成的），
      // 用 commandHash+eventType+timestamp 做稳定去重键；id 也记一份用于跨文件去重。
      const hashKey = 'h:' + String(ev.commandHash || '') + '|' + et + '|' + String(ev.timestamp || '');
      const seenById = ev.id && state.seen && state.seen[ev.id];
      const seenByHash = state.seen && state.seen[hashKey];
      if (seenById || seenByHash) continue;
      if (pushEnabled) {
        const m = buildMessage(ev);
        const ok = pushWechat(m.title, m.desc);
        log('检测到 ' + et + ' count=' + ((ev.messageParams || {}).count || 0) + ' pushed=' + ok);
        if (ok) pushedCount++;
      } else {
        log('reset 记录事件 ' + et);
      }
      if (!state.seen) state.seen = {};
      if (ev.id) state.seen[ev.id] = Date.now();
      state.seen[hashKey] = Date.now();
    }
  }
  // 修剪 seen
  if (state.seen) {
    const keys = Object.keys(state.seen);
    if (keys.length > MAX_SEEN) {
      const sorted = keys.map(k => [k, state.seen[k]]).sort((a, b) => b[1] - a[1]);
      const keep = sorted.slice(0, Math.floor(MAX_SEEN / 2));
      state.seen = {};
      for (const [k, v] of keep) state.seen[k] = v;
    }
  }
  return pushedCount;
}

async function main() {
  const once = process.argv.includes('--once');
  const reset = process.argv.includes('--reset');
  if (!once && !reset) {
    const got = await acquireLock();
    if (!got) {
      log('已有同版本实例在运行，退出');
      return;
    }
    process.on('exit', releaseLock);
  }
  log('守护启动（' + VERSION + '），审计目录: ' + AUDIT_DIR + (reset ? '（reset 模式）' : ''));
  if (reset) {
    const state = loadState();
    scanAll(state, false);
    saveState(state);
    log('reset 完成');
    return;
  }
  for (;;) {
    const state = loadState();
    try { scanAll(state, true); } catch (e) { log('扫描出错: ' + e.message); }
    saveState(state);
    if (once) break;
    await sleep(POLL_MS);
  }
}

main().catch((e) => {
  log('运行失败，已退出: ' + e.message);
  process.exit(1);
});
