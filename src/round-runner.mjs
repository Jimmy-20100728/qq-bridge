#!/usr/bin/env node
/**
 * round-runner —— 往**一个固定的 DSH 会话**里投递一轮 prompt，代替 headless 那种
 * 「每跑一次就新开一个会话」的做法。
 *
 * 背景：headless 的 CLI 没有续聊参数（实测 `dsh --profile freetime --resume …`
 * 直接 `error: unknown option '--resume'`），所以想复用同一个会话，只能走 DSH 的 RPC。
 * 这里复用 src/dsh-client.js 里那套已经在 qq-bridge 上跑熟的客户端。
 *
 * 用法：
 *   node src/round-runner.mjs --key freetime --prompt-file <路径> [--cwd <目录>] [--timeout <毫秒>]
 *   node src/round-runner.mjs --key bili --prompt "……" [--preset <presetId>]
 *
 * 退出码：0 正常完成；2 参数/环境错误；3 超时；4 DSH 侧报错。
 * stdout 最后一行为本轮 assistant 的最终文本（调用方可以只取这一行）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchUrl } from './dsh-client.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');
const STATE_DIR = path.join(PROJECT, 'state');
const SESSION_FILE = path.join(STATE_DIR, 'round-sessions.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function log(msg) {
  process.stderr.write(`[round-runner] ${msg}\n`);
}

const args = parseArgs(process.argv.slice(2));
const key = String(args.key || '').trim();
if (!key) {
  log('缺少 --key（用于区分不同用途的会话，例如 freetime / bili）');
  process.exit(2);
}

const promptText = args['prompt-file']
  ? fs.readFileSync(String(args['prompt-file']), 'utf8')
  : String(args.prompt || '');
if (!promptText.trim()) {
  log('缺少 prompt：用 --prompt 或 --prompt-file 给出这一轮要做的事');
  process.exit(2);
}

const timeoutMs = Number(args.timeout) || 30 * 60 * 1000;
const cwd = path.resolve(String(args.cwd || PROJECT));
const wantedPreset = args.preset ? String(args.preset) : '';

/** 解析 DSH 地址与 token：优先自动发现（DSH Desktop 端口不固定），再退回 config.json。 */
function resolveDsh() {
  const cfg = readJsonSafe(path.join(PROJECT, 'config.json'), {});
  const found = discoverDshLaunchUrl();
  const baseUrl = String(found?.baseUrl || cfg?.dsh?.baseUrl || 'http://127.0.0.1:3080').replace(/\/+$/, '');
  const token = String(found?.token || cfg?.dsh?.authToken || '');
  return { baseUrl, token, cfg };
}

const { baseUrl, token, cfg } = resolveDsh();
if (!token) {
  log('拿不到 DSH 的 launch token：DSH 没在运行、或日志里还没出现过带 token 的地址');
  process.exit(2);
}

const api = new NodeApiClient(baseUrl, undefined, {
  token,
  header: cfg?.dsh?.authHeader || 'authorization',
  prefix: cfg?.dsh?.authPrefix || 'Bearer',
});

const sessionsState = readJsonSafe(SESSION_FILE, {});

async function sessionAlive(sessionId) {
  if (!sessionId) return false;
  try {
    const value = unwrap(await api.sessions.list({}), 'session.list');
    // 实测返回形状是 { items: [ { sessionId, updatedAt, ... } ] }（不是数组，也不是 .sessions）
    const list = Array.isArray(value) ? value : (value?.items ?? value?.sessions ?? []);
    return list.some((s) => String(s?.sessionId ?? s?.id ?? '') === String(sessionId));
  } catch (e) {
    // 列不出来不代表会话没了；交给 prompt 阶段去暴露真问题。
    log(`会话存在性检查失败（忽略）：${e?.message ?? e}`);
    return true;
  }
}

async function createSession() {
  const dir = cwd;
  fs.mkdirSync(dir, { recursive: true });
  const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
  const params = { workspaceId: ws.workspace.workspaceId };
  if (wantedPreset) params.agentPreset = wantedPreset;
  const created = unwrap(await api.sessions.create(params), 'session.create');
  log(`新会话 ${key} -> ${created.sessionId}（cwd=${dir}${wantedPreset ? `, preset=${wantedPreset}` : ''}）`);
  return created.sessionId;
}

/** 订阅事件流并等这一轮 turn/end；返回 { reason, text }。 */
async function runTurn(sessionId) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  timer.unref?.();
  const collector = createTurnCollector();

  let resolveEnded;
  const ended = new Promise((resolve) => { resolveEnded = resolve; });
  let markOpened;
  const openPromise = new Promise((resolve) => { markOpened = resolve; });

  (async () => {
    try {
      // 注意：mux 产出的是 envelope，真正的事件帧在 envelope.payload 里
      // （bridge.js 里是 `const frame = envelope.payload` 再判断 frame.type === 'session/event'）。
      for await (const envelope of api.events.mux({}, ac.signal, () => markOpened())) {
        const frame = envelope?.payload;
        if (!frame || frame.type !== 'session/event') continue;
        if (String(frame.sessionId) !== String(sessionId)) continue;
        const done = collector.push(frame.event);
        if (done) resolveEnded(done);
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      log(`事件流中断：${e?.message ?? e}`);
      resolveEnded(null);
    }
  })();

  // 等 WS 建好再 follow（follow 本身跨重连会重放，这里只是少绕一圈）
  await Promise.race([openPromise, new Promise((r) => setTimeout(r, 3000))]);
  api.events.follow(sessionId);

  const accepted = unwrap(
    await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] }),
    'session.prompt',
  );
  log(`prompt 已投递（turn=${accepted?.turn ?? '?'}）`);

  const result = await ended;
  clearTimeout(timer);
  ac.abort();
  if (!result) throw new Error('没有等到 turn 结束（超时或事件流断开）');
  return result;
}


let sessionId = sessionsState[key];
if (sessionId && !(await sessionAlive(sessionId))) {
  log(`记录的会话 ${sessionId} 已不存在，重新创建`);
  sessionId = null;
}

let result = null;
try {
  if (!sessionId) {
    sessionId = await createSession();
    sessionsState[key] = sessionId;
    writeJson(SESSION_FILE, sessionsState);
  } else {
    log(`复用会话 ${key} -> ${sessionId}`);
  }
  result = await runTurn(sessionId);
} catch (e) {
  const msg = String(e?.message ?? e);
  // 会话被删/不可用：丢掉映射，重建一次再试。
  if (/not found|no such session|unknown session|session.*(gone|closed)/i.test(msg)) {
    log(`投递失败（${msg}），重建会话后重试一次`);
    delete sessionsState[key];
    writeJson(SESSION_FILE, sessionsState);
    try {
      sessionId = await createSession();
      sessionsState[key] = sessionId;
      writeJson(SESSION_FILE, sessionsState);
      result = await runTurn(sessionId);
    } catch (e2) {
      log(`重试仍失败：${e2?.message ?? e2}`);
      process.exit(4);
    }
  } else if (/timeout|没有等到 turn 结束/i.test(msg)) {
    log(msg);
    process.exit(3);
  } else {
    log(`失败：${msg}`);
    process.exit(4);
  }
}

log(`回合结束：reason=${typeof result.reason === 'string' ? result.reason : JSON.stringify(result.reason)} 文本 ${result.text?.length ?? 0} 字`);
process.stdout.write(`${result.text ?? ''}\n`);
process.exit(0);
