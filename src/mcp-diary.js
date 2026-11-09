// 日记 / 浏览心路历程 MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 用途：让 QQ 端的角色能「自己上网 → 记下当时的想法 → 写日记 → 在 QQ 上分享」。
//
// 安全边界（刻意做得很窄，承接 qq-chat-v2 的「不给本地文件工具」原则）：
// - 只写两个固定子目录，**不接受任何路径参数**，无法写到别处、也无法读别的文件：
//     <项目根>/diary/entries/YYYY-MM-DD.md   日记
//     <项目根>/diary/browse/YYYY-MM-DD.md    浏览每条网页时的思考/心路历程
// - 只做「追加」和「读回自己写的内容」，没有删除、没有覆盖、没有命令执行。
// - 日期严格校验 YYYY-MM-DD，内容长度有上限，避免被灌注超长文本撑爆文件。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIARY_ROOT = path.join(path.resolve(__dirname, '..'), 'diary');
const ENTRIES_DIR = path.join(DIARY_ROOT, 'entries');
const BROWSE_DIR = path.join(DIARY_ROOT, 'browse');
const STATUS_FILE = path.join(DIARY_ROOT, '.mcp-status.log');

// 刷B站（dsh-bili-scroll）的日报目录。路径固定，同样不给调用方传参，
// 只读不写，避免这个 MCP 变成任意文件读取通道。
const BILI_OUT_DIR = path.join(
  process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
  'dsh-desktop', 'harness', 'bili-duty', 'out'
);

const MAX_TEXT = 4000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function ensureDirs() {
  for (const dir of [ENTRIES_DIR, BROWSE_DIR]) fs.mkdirSync(dir, { recursive: true });
}

/** 本地时区（Asia/Shanghai）的 YYYY-MM-DD 与 HH:MM。 */
function stamp(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

function clean(text, max = MAX_TEXT) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, max);
}

function appendTo(dir, date, chunk) {
  ensureDirs();
  const file = path.join(dir, `${date}.md`);
  const head = fs.existsSync(file) ? '' : `# ${date}\n\n`;
  fs.appendFileSync(file, head + chunk, 'utf8');
  return file;
}

function readFileSafe(dir, date) {
  const file = path.join(dir, `${date}.md`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}

function recentDates(dir, limit) {
  ensureDirs();
  return fs.readdirSync(dir)
    .filter((n) => DATE_RE.test(n.replace(/\.md$/, '')) && n.endsWith('.md'))
    .sort()
    .reverse()
    .slice(0, limit);
}

// 供人工/排查用：记录本 MCP 被拉起过（DSH 是否真的 spawn 了它）。
try {
  ensureDirs();
  fs.appendFileSync(STATUS_FILE, `${new Date().toISOString()} spawned pid=${process.pid}\n`, 'utf8');
} catch {}

const server = new McpServer({ name: 'diary', version: '0.1.0' });

// 任何工具内部异常都落盘到 diary/.mcp-error.log，并把原因回给模型，
// 避免出现「ok=false 但没有任何信息」的黑箱（这个 bug 曾经排查过很久）。
function logDiag(msg) {
  try {
    ensureDirs();
    fs.appendFileSync(path.join(DIARY_ROOT, '.mcp-error.log'), `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch {}
}
process.on('uncaughtException', (e) => logDiag('uncaughtException: ' + (e?.stack ?? e)));
process.on('unhandledRejection', (e) => logDiag('unhandledRejection: ' + (e?.stack ?? e)));

const tool = (name, desc, schema, handler) =>
  server.tool(name, desc, schema, async (args) => {
    try {
      return await handler(args);
    } catch (e) {
      logDiag(`tool ${name} 失败: ${e?.stack ?? e}`);
      return { content: [{ type: 'text', text: `工具内部错误：${e?.message ?? e}` }], isError: true };
    }
  });

tool(
  'write_entry',
  '写一篇日记（追加到今天的日记文件）。用你自己的话，别写成总结报告。',
  {
    content: z.string().describe('日记正文，用第一人称随手写，可长可短'),
    title: z.string().optional().describe('可选的小标题'),
    mood: z.string().optional().describe('可选，一句话形容当时心情'),
  },
  async ({ content, title, mood }) => {
    const body = clean(content);
    if (!body) return { content: [{ type: 'text', text: '内容为空，已拒绝。' }], isError: true };
    const { date, time } = stamp();
    const lines = [`## ${time}${mood ? ` · ${clean(mood, 40)}` : ''}`, ''];
    if (title) lines.push(`**${clean(title, 60)}**`, '');
    lines.push(body, '', '');
    const file = appendTo(ENTRIES_DIR, date, lines.join('\n'));
    return { content: [{ type: 'text', text: `已写入 ${path.basename(file)}（${time}）` }] };
  }
);

tool(
  'log_browse',
  '记录你看完一条网页时的思考过程（截图里那种第一人称自述：为什么会点进去、看到什么、觉得有意思还是无聊、联想到什么、下一步想看什么）。每看一条就记一条。想得久就写长一点，跟自言自语一样，别写成汇报。',
  {
    url: z.string().describe('网页地址'),
    thought: z.string().describe('当时的想法，第一人称，像自言自语；可以写很长，分几段也行'),
    title: z.string().optional().describe('网页标题'),
    verdict: z.string().optional().describe('可选：一句话结论，如「有意思」「无聊」「没看完」'),
  },
  async ({ url, thought, title, verdict }) => {
    const body = clean(thought);
    if (!body) return { content: [{ type: 'text', text: '想法为空，已拒绝。' }], isError: true };
    const { date, time } = stamp();
    let host = '';
    try { host = new URL(url).host; } catch {}
    // 格式贴近「思考过程」：时间 + 网页信息一行，然后正文按段落铺开。
    const paragraphs = body
      .split(/\n{1,}/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join('\n\n');
    const lines = [
      `## ${time}${verdict ? ` · ${clean(verdict, 30)}` : ''}`,
      '',
      `> ${clean(title || host || url, 200)}`,
      `> ${clean(url, 500)}`,
      '',
      paragraphs,
      '',
      '',
    ];
    const file = appendTo(BROWSE_DIR, date, lines.join('\n'));
    return { content: [{ type: 'text', text: `已记下（${time}）→ ${path.basename(file)}` }] };
  }
);

tool(
  'read_browse',
  '读回自己最近记的浏览思考，避免重复看同一个链接、也能接上之前的念头。',
  { limit: z.number().optional().describe('读最近几天，默认 2，最大 7') },
  async ({ limit }) => {
    const n = Math.min(7, Math.max(1, Math.round(Number(limit) || 2)));
    const dates = recentDates(BROWSE_DIR, n);
    if (!dates.length) return { content: [{ type: 'text', text: '（还没有浏览记录）' }] };
    const text = dates.map((f) => readFileSafe(BROWSE_DIR, f.replace(/\.md$/, '')) ?? '').join('\n');
    return { content: [{ type: 'text', text: text.slice(0, 12000) }] };
  }
);

tool(
  'read_bili_report',
  '读「刷B站」插件某天的日报（它每天替你刷一轮 B站，读字幕挑出值得的，写在 bili-duty\\out\\<日期>.md）。想把 B站 看到的东西写进日记，先调这个读出来。默认读今天。',
  { date: z.string().optional().describe('可选，YYYY-MM-DD；默认今天') },
  async ({ date }) => {
    if (date && !DATE_RE.test(date)) {
      return { content: [{ type: 'text', text: '日期格式应为 YYYY-MM-DD' }], isError: true };
    }
    const d = date || stamp().date;
    const file = path.join(BILI_OUT_DIR, `${d}.md`);
    if (!fs.existsSync(file)) {
      return { content: [{ type: 'text', text: `（${d} 还没有 B站 日报）` }] };
    }
    const raw = fs.readFileSync(file, 'utf8');
    const body = raw.length > 20000 ? `${raw.slice(0, 20000)}\n\n…（已截断）` : raw;
    return { content: [{ type: 'text', text: body }] };
  }
);

tool(
  'read_entries',
  '读回自己最近写的日记。',
  { limit: z.number().optional().describe('读最近几天，默认 3，最大 14') },
  async ({ limit }) => {
    const n = Math.min(14, Math.max(1, Math.round(Number(limit) || 3)));
    const dates = recentDates(ENTRIES_DIR, n);
    if (!dates.length) return { content: [{ type: 'text', text: '（还没有日记）' }] };
    const text = dates.map((f) => readFileSafe(ENTRIES_DIR, f.replace(/\.md$/, '')) ?? '').join('\n');
    return { content: [{ type: 'text', text: text.slice(0, 12000) }] };
  }
);

tool(
  'list_entries',
  '列出写过日记和浏览记录的日期。',
  {},
  async () => {
    const e = recentDates(ENTRIES_DIR, 60).map((f) => f.replace(/\.md$/, ''));
    const b = recentDates(BROWSE_DIR, 60).map((f) => f.replace(/\.md$/, ''));
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ diaryDates: e, browseDates: b }, null, 2),
      }],
    };
  }
);

await server.connect(new StdioServerTransport());
