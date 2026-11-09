// dsh-freetime —— 让 DSH 自己定时跑「自由时间」，完全不需要 qq-bridge。
//
// 设计：本插件随 DSH 启动而加载，自己维护一个定时器；到点就 spawn 一次
//   dsh --profile <profile> "<freetime prompt>"
// 以 headless 会话跑一轮（和 dsh-bili-scroll 用的是同一条已验证过的路子）。
// 所以只要 DSH 开着，自由时间就会自己跑；bridge 开不开都不影响。
//
// 与 bridge 版的分工：
//   - bridge 里的 socialV2.freeTime 应当关掉，避免两套调度器重复开窗。
//   - 这里每轮是独立会话，靠 diary MCP 的 read_browse / read_entries 读回前几天内容接上。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'dsh-freetime';

const HARNESS = path.join(process.env.APPDATA ?? '', 'dsh-desktop', 'harness');
const HOME = path.join(HARNESS, 'freetime');
const PROJECT = 'E:/qqai/qq-bridge-main';
const ROLE_FILE = path.join(PROJECT, 'roles', '好友学习.md');
const CHAT_DIR = path.join(PROJECT, 'state', 'qq-chat');

const DEFAULTS = {
  enabled: true,
  mode: 'rpc',           // 'rpc' = 每轮都投进同一个 DSH 会话（默认）；'headless' = 老办法，每轮新开会话
  sessionKey: 'freetime', // rpc 模式下的会话槽位名，对应 <项目>/state/round-sessions.json 里的键
  runnerPath: '',        // 留空 = <workdir>/src/round-runner.mjs
  nodeBin: '',           // 留空 = 用当前 DSH 进程自己的 node
  everyMs: 1800000,      // 每 30 分钟
  windowMs: 600000,      // 名义窗口 10 分钟（只用于提示词里的时长说明）
  profile: 'freetime',    // headless 模式专用 profile（dsh-base + dsh-headless + diary/web-search MCP）
  workdir: PROJECT,
  dshBin: '',            // 留空 = 用 PATH 上的 dsh
  peakValleyOnly: true,
  noonWindow: false,     // 工作日 12:00-14:00
  nightWindow: true,     // 工作日 18:00-次日 09:00；周末全天
  chatTailLines: 60,     // 注入提示词的 QQ 流水行数
  logMaxBytes: 512 * 1024,
};

function ensureHome() {
  fs.mkdirSync(HOME, { recursive: true });
}

function loadConfig() {
  ensureHome();
  const file = path.join(HOME, 'config.json');
  let user = {};
  try {
    if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return { ...DEFAULTS, ...user };
}

function log(msg) {
  try {
    ensureHome();
    const file = path.join(HOME, 'freetime.log');
    const line = `${new Date().toISOString()} ${msg}\n`;
    fs.appendFileSync(file, line, 'utf8');
    // 简单滚动，避免日志无限增长
    const st = fs.statSync(file);
    if (st.size > DEFAULTS.logMaxBytes) {
      const keep = fs.readFileSync(file, 'utf8').split('\n').slice(-400).join('\n');
      fs.writeFileSync(file, keep, 'utf8');
    }
  } catch {}
}

/** 上海时区的 YYYY-MM-DD / HH:MM。 */
function stamp(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t)?.value ?? '';
  return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` };
}

/** 现在是否处在谷时（DeepSeek 优惠时段）。 */
function isOffPeak(c, now = new Date()) {
  const day = now.getDay(); // 0=周日 6=周六
  if (day === 0 || day === 6) return true;
  const h = now.getHours();
  if (c.noonWindow && h >= 12 && h < 14) return true;
  if (c.nightWindow && (h >= 18 || h < 9)) return true;
  return false;
}

function readRoleCard() {
  try {
    const raw = fs.readFileSync(ROLE_FILE, 'utf8').trim();
    return raw ? raw.slice(0, 12000) : '';
  } catch {
    return '';
  }
}

/** 今天私聊流水（含双方），取最后 N 行。bridge 没跑时为空的。 */
function readChatTail(c) {
  try {
    const { date } = stamp();
    const file = path.join(CHAT_DIR, `${date}.md`);
    if (!fs.existsSync(file)) return '';
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, c.chatTailLines)).join('\n');
  } catch {
    return '';
  }
}

function buildPrompt(c) {
  const { time } = stamp();
  const roleCard = readRoleCard();
  const min = Math.round(c.windowMs / 60000);
  const chat = readChatTail(c);
  const roleLine = roleCard
    ? `【当前角色】好友学习（角色卡全文如下，请按它的人设、语气和习惯说话）\n\n${roleCard}\n\n`
    : '';
  const chatBlock = chat
    ? `【今天私聊里刚聊过的（实时流水）】\n${chat}\n\n` +
      '⚠️ 上面这些你要**先读一遍再决定**：有你参与过的对话、有人问到你在意的事、或聊到你想记下来的内容，就写进今天的日记（带上你的感受和想法）；纯粹没营养的闲聊别硬塞。\n\n'
    : '';
  return (
    `${roleLine}【自由时间】现在是 ${time}，没人找你，这 ${min} 分钟是你自己的。\n` +
    `⚠️ 必须产出**有效内容**：至少认真看完 2 条东西、各记一条 log_browse，最后写一篇有实质内容的日记。不要刷两下就收工。\n\n` +
    chatBlock +
    '可以这样（顺序不强制）：\n' +
    '1. 先调 mcp__diary__read_bili_report 读今天的「刷B站」日报——它已经替你刷过一轮、读过字幕，里面有视频标题/UP/为什么值得。**把它当素材而不是成品**：先理解它讲了什么，再用人格设定的口吻重写成「你今天看了什么、哪条让你停下来、你怎么想」，不要照搬它的列表和「为什么值得」栏目；\n' +
    '2. 用 mcp__web-search-safe__web_search 找话题（优先时事新闻、以及你人格里本来就关心的事）；\n' +
    '3. 看到有意思的就用 mcp__web-search-safe__web_fetch 抓正文；它提示「需要浏览器」时就切 ego_navigate + ego_snapshot；\n' +
    '4. B 站想深看：bili_search → bili_subtitle → bili_comments → bili_frames；\n' +
    '5. **每看完一条就调 mcp__diary__log_browse**，第一人称写当时的想法（为什么点进去、看到什么、觉得有意思还是无聊、联想到什么、接下来想看什么）；\n' +
    '6. 最后用 mcp__diary__write_entry 写今天这篇日记：把 B站 日报里的见闻 + 今天私聊聊过的事，按你自己的人格和说话习惯揉进叙述里。格式照旧（时间 + 小标题 + 正文段落）。\n\n' +
    '可以用 mcp__diary__read_browse / mcp__diary__read_entries 看看今天已经看过什么、写过什么，别重复。\n' +
    '这一轮做完就直接结束。'
  );
}

function runRound(c) {
  const prompt = buildPrompt(c);
  const useRpc = String(c.mode || 'rpc').trim() !== 'headless';
  if (useRpc && runViaRpc(c, prompt)) return;
  runHeadless(c, prompt);
}

/**
 * 推荐路径：把这一轮投进**同一个** DSH 会话（round-runner 通过 DSH RPC 投递）。
 * 好处：上下文累积、侧边栏不再每轮多一个「好友学习角色扮演」；
 * 而且这一轮跑在 web profile 里，能用上 ego 浏览器等全部工具。
 */
function runViaRpc(c, prompt) {
  const runner = String(c.runnerPath || '').trim()
    || path.join(String(c.workdir || PROJECT), 'src', 'round-runner.mjs');
  if (!fs.existsSync(runner)) {
    log(`[freetime] 找不到 ${runner}，回退 headless 模式`);
    return false;
  }
  const promptFile = path.join(HOME, 'prompt-last.txt');
  try {
    ensureHome();
    fs.writeFileSync(promptFile, prompt, 'utf8');
  } catch (e) {
    log(`[freetime] 写提示词失败: ${e?.message ?? e}`);
    return false;
  }
  const nodeBin = String(c.nodeBin || '').trim() || process.execPath || 'node';
  const args = [
    runner,
    '--key', String(c.sessionKey || 'freetime'),
    '--prompt-file', promptFile,
    '--cwd', String(c.workdir || PROJECT),
    '--timeout', String(Math.max(600000, Number(c.windowMs || 600000) * 2)),
  ];
  log(`[freetime] 开始一轮（rpc，复用会话 ${c.sessionKey || 'freetime'}）`);
  let child;
  try {
    child = spawn(nodeBin, args, { cwd: c.workdir || PROJECT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    log(`[freetime] 启动 round-runner 失败: ${e?.message ?? e}`);
    return false;
  }
  let out = '';
  child.stdout?.on('data', (b) => { out += b.toString(); if (out.length > 4000) out = out.slice(-4000); });
  child.stderr?.on('data', (b) => { out += b.toString(); if (out.length > 4000) out = out.slice(-4000); });
  child.on('error', (e) => log(`[freetime] 子进程错误: ${e?.message ?? e}`));
  child.on('exit', (code) => {
    log(`[freetime] 本轮结束 code=${code} 输出尾部: ${out.slice(-600).replace(/\s+/g, ' ')}`);
  });
  return true;
}

function runHeadless(c, prompt) {
  const bin = String(c.dshBin || '').trim() || 'dsh';
  const args = ['--profile', String(c.profile || 'web'), prompt];
  log(`[freetime] 开始一轮 -> ${bin} ${args[0]} ${args[1]}`);
  let child;
  try {
    child = spawn(bin, args, {
      cwd: c.workdir || PROJECT,
      windowsHide: true,
      shell: true, // Windows 上 dsh 是 .cmd，需要 shell
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    log(`[freetime] 启动失败: ${e?.message ?? e}`);
    return;
  }
  let out = '';
  child.stdout?.on('data', (b) => { out += b.toString(); if (out.length > 4000) out = out.slice(-4000); });
  child.stderr?.on('data', (b) => { out += b.toString(); if (out.length > 4000) out = out.slice(-4000); });
  child.on('error', (e) => log(`[freetime] 进程错误: ${e?.message ?? e}`));
  child.on('exit', (code) => {
    log(`[freetime] 本轮结束 code=${code} 输出尾部: ${out.slice(-600).replace(/\s+/g, ' ')}`);
  });
}

export function apply(ctx) {
  try {
    ctx?.logger?.info?.('[dsh-freetime] 已加载');
  } catch {}

  const tick = () => {
    const c = loadConfig();
    if (!c.enabled) return;
    if (!isOffPeak(c)) {
      log('[freetime] 非谷时，跳过');
      return;
    }
    runRound(c);
  };

  const scheduleNext = () => {
    const c = loadConfig();
    const every = Math.max(300000, Number(c.everyMs) || 1800000);
    const now = Date.now();
    const next = Math.ceil(now / every) * every;
    const delay = Math.max(5000, next - now);
    log(`[freetime] 下次窗口约 ${Math.round(delay / 60000)} 分钟后`);
    const t = setTimeout(() => {
      try { tick(); } catch (e) { log(`[freetime] tick 异常: ${e?.message ?? e}`); }
      scheduleNext();
    }, delay);
    t.unref?.();
  };

  scheduleNext();
  log('[freetime] 调度器已启动（随 DSH 加载，不需要 qq-bridge）');
}
