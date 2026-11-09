// 只读 HTTP(S) 安全抓取工具：供 qq-bridge / MCP 共用。
// 设计目标与 mcp-web-search-safe 一致：
// - 仅 http/https
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址
// - 域名先 DNS 解析并检查全部解析结果，避免 DNS rebinding
// - 手动跟随重定向，每一跳重新校验
// - 响应体限量读取，每次请求有包含响应体的总时限
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';

const dnsLookup = dns.promises.lookup;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  let h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  const family = net.isIP(h);
  // DNS 返回值也必须是有效 IP；不能把非法地址当成公网地址。
  if (!family || h.includes('%')) return true;
  if (family === 6) h = new URL(`http://[${h}]/`).hostname.slice(1, -1);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    // 本地 NAT64 前缀的 IPv4 位布局不等同 /96；整个本地前缀均不可供公网抓取。
    if (h.startsWith('64:ff9b:1:')) return true;
    const embedded = parseEmbeddedIpv4(h);
    if (embedded) return isPrivateIp(embedded);
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }

  return true;
}

export async function resolveSafeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await withTimeout(dnsLookup(h, { all: true, verbatim: true }), 5000, `DNS 解析 ${h}`);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

export async function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname);
  return { url, ip };
}

const REQUEST_TIMEOUT_MS = 30000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// 裸 'Mozilla/5.0' 会被大量站点（百度百科、知乎、Bing、维基镜像等）判定为爬虫并返回
// 空白页或反爬页，表现为「网页打不开」。这里给一套完整的桌面 Chrome 请求头；
// accept-encoding 固定 identity，避免收到压缩体后需要额外解压（拿不到正文反而更难排查）。
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function buildHeaders(url, binary) {
  const origin = `${url.protocol}//${url.host}`;
  const headers = {
    host: url.host,
    'user-agent': BROWSER_UA,
    accept: binary
      ? 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'accept-encoding': 'identity',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'upgrade-insecure-requests': '1',
    referer: origin + '/',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': binary ? 'image' : 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-user': '?1',
    connection: 'keep-alive',
  };
  return headers;
}

function validateLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 必须为正整数`);
}

// 使用已校验的 IP 发起请求，保留原始 Host/SNI，禁止重新解析 DNS。
// 总时限包含 TCP/TLS、响应头和响应体；仅 socket idle timeout 无法阻止慢速滴流。
function requestOnce(url, ip, limit, binary = false) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let response;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      const error = new Error(`请求超时：${url.hostname}`);
      finish(error);
      req?.destroy(error);
      response?.destroy();
    }, REQUEST_TIMEOUT_MS);
    const mod = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    try {
      req = mod.request({
        hostname: ip,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        headers: buildHeaders(url, binary),
        servername: url.protocol === 'https:' && !net.isIP(hostname) ? hostname : undefined,
        rejectUnauthorized: url.protocol === 'https:',
        timeout: REQUEST_TIMEOUT_MS,
      }, (res) => {
        response = res;
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('响应体读取中断')));
        res.on('close', () => {
          if (!res.complete) finish(new Error('响应体读取中断'));
        });
        if (settled) { res.destroy(); return; }
        const statusCode = res.statusCode || 0;
        if (REDIRECT_STATUSES.has(statusCode)) {
          finish(null, { statusCode, redirect: String(res.headers.location || '') });
          // 不下载重定向正文：攻击者可以发送无限正文消耗连接和带宽。
          res.destroy();
          return;
        }
        const chunks = [];
        // 字符集：优先 Content-Type 的 charset；没有就扣住前若干字节，嗅探 <meta charset>。
        // 之前硬编码 UTF-8，GBK/GB2312 的中文站会整篇乱码（表现为「看不到内容」）。
        const headerCharset = charsetFromContentType(res.headers['content-type']);
        const makeDecoder = (label) => {
          try { return new TextDecoder(label || 'utf-8'); } catch { return new TextDecoder('utf-8'); }
        };
        let decoder = binary ? null : (headerCharset ? makeDecoder(headerCharset) : null);
        let heldChunks = [];
        let size = 0;
        const appendText = (text) => {
          if (!text) return;
          const points = Array.from(text);
          const remaining = limit - size;
          if (remaining <= 0) return;
          chunks.push(points.slice(0, remaining).join(''));
          size += Math.min(points.length, remaining);
          if (size >= limit) {
            finish(null, { statusCode, body: chunks.join(''), truncated: true });
            res.destroy();
          }
        };
        const resolveDecoder = (final) => {
          if (decoder) return;
          const buf = Buffer.concat(heldChunks);
          const head = buf.toString('latin1', 0, Math.min(buf.length, 2048));
          const m = /charset\s*=\s*["']?([\w-]+)/i.exec(head);
          if (m) decoder = makeDecoder(m[1]);
          else if (final || buf.length >= 1536) decoder = makeDecoder('');
          if (!decoder) return;
          appendText(decoder.decode(buf, { stream: !final }));
          heldChunks = [];
        };
        res.on('data', (chunk) => {
          if (settled) return;
          if (!binary) {
            if (!decoder) { heldChunks.push(chunk); resolveDecoder(false); return; }
            appendText(decoder.decode(chunk, { stream: true }));
            return;
          }
          size += chunk.length;
          if (size > limit) {
            finish(new Error(`图片超过大小限制（${limit} 字节）`));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          if (binary) { finish(null, { statusCode, buffer: Buffer.concat(chunks) }); return; }
          resolveDecoder(true);
          if (decoder) appendText(decoder.decode());
          finish(null, { statusCode, body: chunks.join(''), truncated: false });
        });
      });
      req.on('timeout', () => {
        const error = new Error(`请求超时：${url.hostname}`);
        finish(error);
        req.destroy(error);
        response?.destroy();
      });
      req.on('error', (error) => finish(error));
      req.end();
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

// 瞬时故障重试：超时 / 连接重置 / 5xx 常见于网关抖动，重试一次能救回不少页面。
async function requestWithRetry(url, ip, limit, binary = false, attempts = 2) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await requestOnce(url, ip, limit, binary);
      if (i + 1 < attempts && result.statusCode >= 500) {
        lastError = new Error(`HTTP ${result.statusCode}`);
        await new Promise((r) => setTimeout(r, 600));
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      const msg = String(error?.message ?? error);
      const transient = /超时|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|中断|EPIPE/.test(msg);
      if (i + 1 >= attempts || !transient) throw error;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw lastError ?? new Error('请求失败');
}

/** 从 Content-Type 里取 charset（gb2312/gbk 统一按 gbk 解）。 */
function charsetFromContentType(ct) {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(String(ct || ''));
  if (!m) return '';
  const cs = m[1].toLowerCase();
  if (cs === 'gb2312' || cs === 'gbk' || cs === 'gb18030') return cs;
  if (cs === 'utf8') return 'utf-8';
  return cs;
}

export async function safeFetch(urlString, maxChars = 50000) {
  validateLimit(maxChars, 'maxChars');
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestWithRetry(url, ip, maxChars);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: result.truncated,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 仅接受 DSH 支持的四种图片格式：PNG/JPEG/GIF/WebP。 */
export function looksLikeImageBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

/** 抓取图片字节并返回 Buffer（带 SSRF 防护，且校验确实为图片）。 */
export async function safeFetchBuffer(urlString, maxBytes = 4 * 1024 * 1024) {
  validateLimit(maxBytes, 'maxBytes');
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestWithRetry(url, ip, maxBytes, true);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`图片抓取失败：HTTP ${result.statusCode}`);
    }
    if (!looksLikeImageBuffer(result.buffer)) {
      throw new Error(`抓取内容不是有效图片（PNG/JPEG/GIF/WebP）`);
    }
    return { url: url.toString(), statusCode: result.statusCode, buffer: result.buffer };
  }
  throw new Error('重定向次数过多，已停止');
}
