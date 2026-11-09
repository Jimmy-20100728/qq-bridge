// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import { safeFetch } from './safe-fetch.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function bingSearch(query) {
  const url = new URL('https://cn.bing.com/search');
  url.searchParams.set('q', query);
  // 搜索也使用同一条受限传输链路，重定向必须重新校验，正文最多 512K 字符。
  const res = await safeFetch(url.toString(), 512000);
  if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`搜索服务 HTTP ${res.statusCode}`);
  const html = res.body;
  const results = [];
  const blocks = html.split('<li class="b_algo"').slice(1);
  for (const block of blocks) {
    const hrefMatch = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!hrefMatch) continue;
    const urlStr = decodeHtml(hrefMatch[1]);
    const titleMatch = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? decodeHtml(titleMatch[1]) : '';
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch ? decodeHtml(snippetMatch[1]) : '';
    if (urlStr && title) results.push({ title, url: urlStr, snippet });
    if (results.length >= 8) break;
  }
  return { query, results };
}

const server = new McpServer({ name: 'web-search-safe', version: '0.1.5' });

server.tool(
  'web_search',
  '只读搜索网络用语/梗/黑话的含义，返回 Bing 搜索结果（标题/URL/摘要）。仅用于理解词义，不执行任何本地操作。',
  { query: z.string().describe('要搜索确认的网络用语/黑话/梗') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await bingSearch(clean);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

// ── HTML → 干净正文 ──────────────────────────────────────────────────────
// 直接把 5 万字符 HTML 丢给模型，绝大部分 token 浪费在 <script>/<style>/导航上，
// 真正内容可能只有百分之几，体感就是「看不到内容」。这里剥成正文，
// 同样的字符预算能换回好几倍的实际信息量。
const BLOCK_TAGS = /<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dd|dt|header|footer|nav|main|aside|figure|figcaption)>/gi;

function htmlToText(html) {
  let s = String(html ?? '');
  // 去掉整个不该进正文的区块（含内容）
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<template[\s\S]*?<\/template>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // 块级元素换行，其余标签直接去掉
  s = s.replace(BLOCK_TAGS, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  // 实体
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
  // 空白归一：行内多空格压一个，连续空行压一个
  s = s.replace(/[ \t\u00a0]+/g, ' ');
  s = s.replace(/\s*\n\s*/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(String(html ?? ''));
  return m ? htmlToText(m[1]).replace(/\n+/g, ' ').trim() : '';
}

/** 页面是否像「要靠 JS 才能渲染」/ 被反爬挡住 —— 这种情况提示用真实浏览器。 */
function looksNeedsBrowser(text, rawHtml) {
  if (text.length >= 600) return false;
  return /<script|react|vue|__NEXT_DATA__|window\.__|加载中|请开启\s*JavaScript|安全验证|人机验证/i.test(rawHtml.slice(0, 4000));
}

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页并返回「干净正文」（已剥掉 script/style/标签，保留段落结构），最多约 20000 字。禁止访问内网/本机地址，不执行任何本地操作。若返回提示需要用浏览器，请改用 ego_browser 系列工具（ego_navigate + ego_snapshot）。',
  {
    url: z.string().describe('要抓取的 http(s) URL'),
    raw: z.boolean().optional().describe('可选：true 时返回原始 HTML（默认 false 返回干净正文）'),
  },
  async ({ url, raw }) => {
    try {
      const result = await safeFetch(url, 400000);
      const body = result.body || '';
      const isHtml = /<html|<body|<div|<!doctype/i.test(body.slice(0, 2000));
      if (raw === true || !isHtml) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              url: result.url,
              statusCode: result.statusCode,
              truncated: result.truncated,
              body: body.slice(0, 20000),
            }, null, 2),
          }],
        };
      }
      const text = htmlToText(body).slice(0, 20000);
      const title = extractTitle(body);
      const payload = {
        url: result.url,
        statusCode: result.statusCode,
        title,
        chars: text.length,
        text,
      };
      if (looksNeedsBrowser(text, body)) {
        payload.hint = '这个页面的正文几乎是空的，多半要执行 JS 才能渲染。请改用 ego_navigate + ego_snapshot 再试，或换别的来源。';
      }
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
