// 探测本机是否已安装 SnowLuma（只读，不下载、不安装、不修改它的任何文件）。
//
// 为什么是「探测」而不是「下载安装」：
//   SnowLuma 的 EULA 第 5.4 条明确禁止「将其并入第三方安装包」以及「通过自动化脚本部署」，
//   除非事先取得著作权人书面授权。所以 qq-bridge 不打包、不代装 SnowLuma，
//   只负责在用户自己装好之后把它的配置接起来。安装请走官方渠道：
//   https://github.com/SnowLuma/SnowLuma/releases
//
// 用法：node scripts/detect-snowluma.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();

// 候选根目录：常见安装位置 + 当前盘符的顶层 + 用户主目录下一层。为控制耗时，不做全盘递归。
const roots = new Set([
  HOME,
  path.join(HOME, 'Downloads'),
  path.join(HOME, 'Desktop'),
  process.env.LOCALAPPDATA,
  process.env.APPDATA,
  process.env.ProgramFiles,
  process.env['ProgramFiles(x86)'],
  ...'CDEFG'.split('').map((d) => `${d}:\\`),
].filter(Boolean));

const SKIP = new Set(['Windows', 'node_modules', '$Recycle.Bin', 'System Volume Information', 'ProgramData', 'Program Files', 'Program Files (x86)']);

/** 判定一个目录是不是 SnowLuma 发行包：有 package.json 且 name 是 @snowluma/runtime，或同时有 EULA.md + index.mjs。 */
function looksLikeSnowLuma(dir) {
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (String(pkg.name || '').includes('snowluma')) return { version: pkg.version || '?' };
    }
  } catch {}
  if (fs.existsSync(path.join(dir, 'EULA.md')) && fs.existsSync(path.join(dir, 'index.mjs'))) {
    return { version: '?' };
  }
  return null;
}

/** 找 onebot 配置：config/onebot_<QQ>.json */
function findOnebotConfig(dir) {
  const cfgDir = path.join(dir, 'config');
  if (!fs.existsSync(cfgDir)) return null;
  const hit = fs.readdirSync(cfgDir).find((f) => /^onebot_\d+\.json$/.test(f));
  return hit ? path.join(cfgDir, hit) : null;
}

function search(dir, depth, out) {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (SKIP.has(e.name)) continue;
    const full = path.join(dir, e.name);
    const hit = looksLikeSnowLuma(full);
    if (hit) { out.push({ dir: full, version: hit.version }); continue; }
    // 只在浅层继续下潜；顶层盘符允许 2 层，其他 1 层
    if (/\\$/.test(full)) search(full, 1, out);
    else search(full, depth - 1, out);
  }
}

const found = [];
for (const r of roots) {
  if (!fs.existsSync(r)) continue;
  search(r, 1, found);
}

// 去重（同一安装可能被多个根目录命中）
const uniq = new Map();
for (const f of found) uniq.set(f.dir.toLowerCase(), f);

console.log('=== SnowLuma 探测结果 ===');
if (uniq.size === 0) {
  console.log('❌ 未找到已安装的 SnowLuma。');
  console.log('');
  console.log('请自行安装（qq-bridge 不会代装，原因见 EULA 第 5.4 条）：');
  console.log('  官方发行版: https://github.com/SnowLuma/SnowLuma/releases');
  console.log('  当前本地已知可用的版本线: 1.14.x');
  console.log('');
  console.log('装好后把机器人 QQ 扫码登录一次，然后重跑本脚本。');
  process.exit(2);
}

for (const [dir, info] of uniq) {
  const ob = findOnebotConfig(dir);
  console.log(`✅ 找到 SnowLuma  ${info.version}`);
  console.log(`   目录: ${dir}`);
  if (ob) {
    let port = null, token = null, ws = null;
    try {
      const cfg = JSON.parse(fs.readFileSync(ob, 'utf8'));
      const s = cfg?.networks?.httpServers?.[0];
      port = s?.port ?? null;
      token = s?.accessToken ? '已设置' : '空';
      ws = s?.enableWebSocket === true;
    } catch {}
    console.log(`   配置: ${ob}`);
    console.log(`   httpServer 端口=${port ?? '未配置'}  accessToken=${token ?? '?'}  enableWebSocket=${ws === null ? '?' : ws}`);
    if (ws === false) console.log('   ⚠ enableWebSocket=false —— qq-bridge 的 wsUrl 会连不上，请在配置里打开它');
    if (!port) console.log('   ⚠ 没有 httpServers 条目，请参考 integrations/snowluma/onebot.example.json');
  } else {
    console.log('   配置: 未找到 config/onebot_<QQ>.json —— 请先扫码登录一次机器人 QQ');
  }
}

console.log('');
console.log('下一步：把端口与 accessToken 填进 qq-bridge 的 config.json 的 snowluma 字段，');
console.log('        然后运行 node scripts/check-onebot-status.mjs 验证连通。');
