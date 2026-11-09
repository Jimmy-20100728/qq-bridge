// 一次性维护脚本：把 SnowLuma 的真实端口与 token 同步进 qq-bridge 的 config.json。
// 用法：node scripts/sync-snowluma-config.mjs [路径到 onebot_<QQ>.json]
// 说明：SnowLuma 的 httpServer 与 wsServer 各自签发 token，两者不同，所以分别写入
//       accessToken（HTTP API）与 wsAccessToken（WebSocket）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const CONFIG = path.join(REPO, 'config.json');

const arg = process.argv[2];
let onebot = arg;
if (!onebot) {
  // 自动找：<snowluma>/config/onebot_<QQ>.json，从 qq-bridge 的 config.json 的 snowluma.homeDir 或常见路径
  const candidates = [];
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    if (c.snowluma?.homeDir) candidates.push(c.snowluma.homeDir);
  } catch {}
  candidates.push(path.join(os.homedir(), 'snowluma'), 'E:/qqai/snowluma', 'D:/qqai/snowluma', 'C:/snowluma');
  for (const dir of candidates) {
    const cfgDir = path.join(dir, 'config');
    if (!fs.existsSync(cfgDir)) continue;
    const hit = fs.readdirSync(cfgDir).find((f) => /^onebot_\d+\.json$/.test(f));
    if (hit) { onebot = path.join(cfgDir, hit); break; }
  }
}

if (!onebot || !fs.existsSync(onebot)) {
  console.error('❌ 找不到 SnowLuma 的 onebot_<QQ>.json，请把路径作为参数传进来。');
  process.exit(2);
}

const sl = JSON.parse(fs.readFileSync(onebot, 'utf8'));
const http = sl?.networks?.httpServers?.[0];
const ws = sl?.networks?.wsServers?.[0];
if (!http) {
  console.error('❌ SnowLuma 配置里没有 httpServers 条目，先按 integrations/snowluma/onebot.example.json 配一个。');
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
cfg.snowluma = cfg.snowluma || {};
cfg.snowluma.httpUrl = `http://127.0.0.1:${http.port}`;
cfg.snowluma.accessToken = http.accessToken || '';
if (ws) {
  cfg.snowluma.wsUrl = `ws://127.0.0.1:${ws.port}`;
  cfg.snowluma.wsAccessToken = ws.accessToken || '';
} else {
  // 没有独立 wsServer 时，只能靠 httpServer 的 enableWebSocket 同端口升级
  cfg.snowluma.wsUrl = `ws://127.0.0.1:${http.port}`;
  cfg.snowluma.wsAccessToken = http.accessToken || '';
  if (http.enableWebSocket !== true) {
    console.warn('⚠ httpServer 没有 enableWebSocket，也没有 wsServers —— WebSocket 会连不上。');
  }
}
// ── 写入前先验活 ────────────────────────────────────────────────────────────
// 血泪教训：磁盘上的 onebot_<QQ>.json 可能和**正在运行的** SnowLuma 实例不一致。
// 见过一种情况：文件里是 token A + wsServer 3001，但运行中的实例仍然只认 token B、
// 只在 3000 上提供服务（配置是启动后又被改过）。这时盲目按文件写 config.json，
// 桥接就会一直 `code=1006` 重连，看起来像是「刚才还好好的，一改就坏了」。
// 所以这里先用即将写入的值打一次只读接口，验不过就不写，并告诉用户该重启谁。
const { httpUrl, accessToken } = cfg.snowluma;
let live = { ok: false, detail: '' };
try {
  const res = await fetch(`${httpUrl}/get_login_info`, {
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    signal: AbortSignal.timeout(4000),
  });
  const body = await res.json().catch(() => null);
  live = {
    ok: res.ok && body?.status === 'ok',
    detail: body?.data?.nickname ? `昵称=${body.data.nickname}` : `HTTP ${res.status} ${body?.wording ?? ''}`.trim(),
  };
} catch (e) {
  live = { ok: false, detail: e.message };
}

if (!live.ok) {
  console.error('❌ 验活失败，未写入 config.json（保留原值）。');
  console.error(`   试过 ${httpUrl}/get_login_info → ${live.detail}`);
  console.error('');
  console.error('这通常意味着：运行中的 SnowLuma 和你磁盘上的 onebot 配置不一致。');
  console.error('  1) 先在 SnowLuma 里确认/保存配置，然后**重启 SnowLuma**（配置只在启动时加载）；');
  console.error('  2) 重启后再跑一次本脚本；');
  console.error('  3) 若重启后仍失败，说明磁盘那份不是它在用的那份，检查是不是有多个安装目录。');
  process.exit(3);
}

fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
console.log('✅ 已同步 SnowLuma 配置（已验活）');
console.log(`   来源: ${onebot}`);
console.log(`   在线: ${live.detail}`);
console.log(`   httpUrl=${cfg.snowluma.httpUrl}  accessToken=${cfg.snowluma.accessToken ? '已写入' : '空'}`);
console.log(`   wsUrl  =${cfg.snowluma.wsUrl}  wsAccessToken=${cfg.snowluma.wsAccessToken ? '已写入' : '空'}`);
