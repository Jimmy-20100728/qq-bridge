#!/usr/bin/env node
/**
 * 给 dsh-bili-scroll（刷B站插件）打「值班轮续用同一个会话」补丁。
 *
 * 为什么要打：插件每跑一轮都是 `dsh --profile bili-duty <prompt>` 起的**独立会话**，
 *   侧栏一次多一个，而且这一轮完全不知道上一轮看过什么（判重、口味全废）。
 *   headless 本身支持 `--session-id <id>`（插件自己的「私信回复」早就这么用了），
 *   所以补丁只是：第一次跑完记下会话 id → 之后每轮带上 → 不再归档这条会话。
 *
 * 用法：
 *   node scripts/patch-bili-session.mjs             # 自动找插件并打补丁（幂等）
 *   node scripts/patch-bili-session.mjs --file <index.js>   # 指定文件
 *   node scripts/patch-bili-session.mjs --check     # 只检查是否已打过，不改文件
 *
 * ⚠️ 插件升级（dsh plugin add dsh-bili-scroll）会把 index.js 覆盖回原样 ⇒ 升级后重跑一次本脚本。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const MARK = 'duty-session.json'   // 打过补丁的标志串

const argOf = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : ''
}
const hasFlag = (name) => process.argv.includes(name)

/** 找插件 index.js：优先 --file，否则在 DSH harness 的 profiles\*\node_modules 下扫 */
function findIndexJs() {
  const explicit = argOf('--file')
  if (explicit) return path.resolve(explicit)
  const roots = [
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dsh-desktop', 'harness', 'profiles'),
    path.join(os.homedir(), '.dsh', 'profiles'),
  ]
  const hits = []
  for (const root of roots) {
    let profs = []
    try { profs = fs.readdirSync(root) } catch { continue }
    for (const p of profs) {
      const pkg = path.join(root, p, 'node_modules', 'dsh-bili-scroll', 'index.js')
      if (fs.existsSync(pkg)) hits.push(pkg)
    }
  }
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) {
    console.log('找到多份 dsh-bili-scroll，用 --file 指定要打哪一个：')
    hits.forEach((h, i) => console.log(`  [${i}] ${h}`))
    process.exit(2)
  }
  return ''
}

const file = findIndexJs()
if (!file) {
  console.log('没找到 dsh-bili-scroll 的 index.js。先装插件，或用 --file 指定路径。')
  process.exit(2)
}
console.log('目标：' + file)

const srcRaw = fs.readFileSync(file, 'utf8')
// 插件的 index.js 是 CRLF 的 → 内部一律按 LF 处理，写回时再还原，免得正则匹配不上
const useCrlf = srcRaw.includes('\r\n')
const src = useCrlf ? srcRaw.replace(/\r\n/g, '\n') : srcRaw
if (src.includes(MARK)) {
  console.log('已经是打过补丁的版本（含 ' + MARK + '）⇒ 什么都不用做 ✓')
  process.exit(0)
}
if (hasFlag('--check')) {
  console.log('还没打补丁。')
  process.exit(1)
}

// ── 三处改动 ───────────────────────────────────────────────────────────────
const edits = []

// ① 加「记住值班会话」的两个小工具 + 归档时别归档它
edits.push({
  name: '会话记忆工具 + 归档豁免',
  find: /( *)const archiveDutyBucket = \(since = 0, exclude = new Set\(\)\) => \{\n( *)try \{\n( *)const b = dutySessionBucket\(\)/,
  make: (m) => {
    const i = m[1]
    return [
      `${i}/* ⭐⭐ 本地补丁（qq-bridge）：值班轮续用同一个会话。`,
      `${i} *    以前每轮都是独立会话 ⇒ 侧栏一次多一个，且这一轮不知道上一轮看过什么。`,
      `${i} *    headless 支持 --session-id（私信回复那边就这么用），值班轮照抄同一套。 */`,
      `${i}const dutySessionFile = join(stateDir, '${MARK}')`,
      `${i}const readDutySession = () => {`,
      `${i}  try {`,
      `${i}    const j = JSON.parse(readFileSync(dutySessionFile, 'utf8'))`,
      `${i}    return j && typeof j.id === 'string' && j.id ? j.id : ''`,
      `${i}  } catch { return '' }`,
      `${i}}`,
      `${i}const writeDutySession = (id) => {`,
      `${i}  try { writeFileSync(dutySessionFile, JSON.stringify({ id, at: Date.now() }, null, 2), 'utf8') } catch { /* 写不了下次再认 */ }`,
      `${i}}`,
      ``,
      `${i}const archiveDutyBucket = (since = 0, exclude = new Set()) => {`,
      `${i}  try {`,
      `${i}    // ⭐ 本地补丁：值班轮续用的那条会话不能归档（归档了就续不上）`,
      `${i}    const _hold = readDutySession()`,
      `${i}    if (_hold && !exclude.has(_hold)) exclude = new Set([...exclude, _hold])`,
      `${i}    const b = dutySessionBucket()`,
    ].join('\n')
  },
})

// ② 起跑时带上 --session-id
edits.push({
  name: '起跑带上 --session-id',
  find: /( *)const args = \[\.\.\.dsh\.args, '--profile', effectiveProfile\(\)\]\n( *)if \(overlay\) args\.push\('--patch', overlay\)\n( *)args\.push\(promptFor\(why\)\)/,
  make: (m) => {
    const i = m[1]
    return [
      `${i}const args = [...dsh.args, '--profile', effectiveProfile()]`,
      `${m[2]}if (overlay) args.push('--patch', overlay)`,
      `${i}// ⭐ 本地补丁（qq-bridge）：续用同一个值班会话（首次跑完才知道 id，见下面的 exit 处理）`,
      `${i}const dutySid = readDutySession()`,
      `${i}if (dutySid) args.push('--session-id', dutySid)`,
      `${m[3]}args.push(promptFor(why))`,
    ].join('\n')
  },
})

// ③ 跑完记下这一轮开出来的会话 id
edits.push({
  name: '跑完记住会话 id',
  find: /( *)log\(`刷B站结束（\$\{why\}，code=\$\{code\}）`\)\n( *)\/\/ ⭐ 2026-10-25：这一轮刚生成的会话/,
  make: (m) => {
    const i = m[1]
    return [
      `${i}log(\`刷B站结束（\${why}，code=\${code}）\`)`,
      `${i}// ⭐ 本地补丁（qq-bridge）：第一次跑就记下这一轮开出来的会话，下一轮带着 --session-id 续它`,
      `${i}try {`,
      `${i}  if (!dutySid) {`,
      `${i}    const _newId = discoverDmSession(startedAt - 5000)`,
      `${i}    if (_newId) { writeDutySession(_newId); log('值班会话已记录：' + _newId.slice(0, 24) + '…（以后每轮都接着这个会话）') }`,
      `${i}  }`,
      `${i}} catch { /* 记不下来就下次再记 */ }`,
      `${m[2]}// ⭐ 2026-10-25：这一轮刚生成的会话`,
    ].join('\n')
  },
})

let out = src
const failed = []
for (const e of edits) {
  const m = out.match(e.find)
  if (!m) { failed.push(e.name); continue }
  out = out.replace(e.find, e.make(m))
}

if (failed.length) {
  console.log('❌ 这些改动没匹配上（插件源码结构变了，需要人工看一眼）：')
  failed.forEach((n) => console.log('   - ' + n))
  console.log('文件没有改动。')
  process.exit(3)
}

// 备份 + 落盘（备份用时间戳，万一要对照）
const bak = file + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
try { fs.copyFileSync(file, bak) } catch { /* 备份失败不阻止打补丁，但要出声 */ console.log('⚠️ 备份失败：' + bak) }
fs.writeFileSync(file, useCrlf ? out.replace(/\n/g, '\r\n') : out, 'utf8')
console.log('✓ 补丁已写入（原文件备份：' + path.basename(bak) + '）')
console.log('  生效方式：重启 DSH（插件代码只在启动时加载）。第一次跑完会生成 <插件家>/duty-session.json，')
console.log('  之后每轮都续同一个会话；侧栏里那条值班会话也不再被归档掉。')
