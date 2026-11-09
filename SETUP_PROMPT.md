# SETUP_PROMPT —— 把 SnowLuma + freetime 插件接进 DSH

把下面 `---` 之间的**全部内容**复制给 DSH（新开一个会话，选能跑 bash / 改文件的模式）。
它会自己探测路径、改配置、逐项验证，最后给你一张验收表。

要人工做、不需要 DSH 的部分只有两件：**装 SnowLuma 并扫码登录**、**在 DSH 桌面版里把模型选成支持识图的**。

---

你是 DSH，现在要在一台 Windows 机器上把 qq-bridge 项目接入 DSH。请按顺序执行，**每一步都验证后再走下一步**，不要跳步、不要只报告"应该可以了"。这个项目的坑集中在四个地方，我在对应步骤里都标了，请严格照做。

## 0. 先探测环境（不要假设路径）

依次确定并记下来：

1. **仓库根目录**（下称 `REPO`）：本提示词所在文件的上一级，应含 `src\bridge.js`、`package.json`。
2. **DSH harness 目录**（下称 `HARNESS`）：通常是 `%APPDATA%\dsh-desktop\harness`。验证：里面有 `profiles\web\` 与 `.agent-presets\`。如果找不到，在系统里搜 `profiles\web\cordis.patch.yml`。
3. **node.exe 绝对路径**（下称 `NODE_EXE`）：`where.exe node` 的第一条结果，通常是 `C:\Program Files\nodejs\node.exe`。

> **坑 ③**：DSH 0.1.7 起 `resources\app` 被打包成 `app.asar`，**不再自带 node.exe**。任何 MCP 的 `command` 写成 `node` 或指向 DSH 安装目录都会导致 `SdkError: Connection closed` —— 而且**不报错到聊天里**，表现为 agent 静默空转。所以 `NODE_EXE` 必须是你探测到的绝对路径，全项目统一用它。

先输出一段探测结果（三个路径 + `node -v` + `dsh --version`），再继续。

## 1. 装依赖

```
cd REPO
npm install
node src/self-test.js
```

`self-test.js` 应当打印 `🎉 自测通过`。失败就停下，按它报的错修（401＝token 不对，ECONNREFUSED＝端口不对，两种情况见第 6 步）。

> 说明：`src/dsh-client.js` 的 `discoverDshLaunchUrl()` 会从 DSH 启动日志里同时发现 **端口和 token**。
> DSH Desktop 的端口**不固定**（实测出现过 3080 / 19387 / 43129），所以不要把这个地址写死。
> 想锁死端口，就在 `config.json` 的 `dsh` 里加 `"autoDiscoverUrl": false`。

## 2. 复制 agent preset 到两处

把 `REPO\dsh\agent-presets\qq-chat-v2\` 整个目录复制到：

- `HARNESS\.agent-presets\qq-chat-v2\`
- `HARNESS\profiles\web\qq-chat-v2\`（**注意是 profiles\web 根下，不是子目录**）

> **坑 ①**：DSH 0.1.7 起 agent preset 的模块解析基准从「preset 自己的目录」改成了「`profiles\web\`」。
> 只放 `.agent-presets` 会导致 `qq-tool-restrict never started`、所有会话 `resume failed`。
> **必须两处都放**（三处并存也行：仓库、`.agent-presets`、`profiles\web`）。

> **坑 ②**：`dsh-persona` 只注册了 `provider` / `model` 两个变量。preset 的 `agent.cordis.yml`
> 里只要出现未注册的变量（例如残留的 `suffix: Your working directory is {{cwd}}.`），
> 整轮装配会失败并报 `unknown prompt variable "{{cwd}}"`。请全局搜一遍并改成 `suffix: ''`：
>
> ```
> Select-String -Path HARNESS\.agent-presets\qq-chat-v2\*, HARNESS\profiles\web\qq-chat-v2\* -Pattern '\{\{\w+\}\}'
> ```
>
> 只剩注释里的 `{{cwd}}` 是正常的。

**preset 的 `agent.cordis.yml` 不热重载** —— 改完必须重启 DSH 才生效。先把第 3~5 步做完，最后一次重启。

## 3. 建 freetime profile

把 `REPO\extras\dsh-profiles\freetime\` 三个文件复制到 `HARNESS\profiles\freetime\`，然后替换占位符：

- `@@NODE_EXE@@` → 第 0 步的 `NODE_EXE`（注意 YAML 里是单引号包裹，反斜杠不用转义）
- `@@BRIDGE_DIR@@` → `REPO`（同上）

> 为什么单独一个 profile：`web` profile 是「起服务端」的桌面应用，不能带 prompt 跑一次性任务。
> 实测 `dsh --profile web "xxx"` 会报 `error: too many arguments. Expected 0 arguments but got 1`。
> 一次性任务必须用 `@deepseek-ai/dsh-headless` —— 见同目录 `package.json` 的 bundles。

验证：`dsh --profile freetime "只回复两个字：收到"`，应 exit=0 并输出「收到」。

## 4. 装 dsh-freetime 插件

源码在 `REPO\extras\dsh-freetime\`，目标装进 `HARNESS\profiles\web\`。

1. 把 `extras\dsh-freetime` 整个目录复制到**一个不会被 npm 删掉的稳定位置**（例如 `REPO\extras\dsh-freetime` 原地不动即可）。
2. 在 `HARNESS\profiles\web\package.json` 里：
   - `dependencies` 增 `"dsh-freetime": "link:<上一步的绝对路径，正斜杠>"`
   - `bundles` 数组里增一项 `dsh-freetime`（数组从 14 项变 15 项，**追加在末尾**）
3. 在 `HARNESS\profiles\web\node_modules\` 下建 junction 指向上一步的路径：
   ```
   cmd /c mklink /J "HARNESS\profiles\web\node_modules\dsh-freetime" "<插件目录>"
   ```
4. **重点**：执行完任何 `pnpm add` 之后，DSH 的 generation projection 会把插件实体剪掉，
   这时要重新把 junction 链回 `HARNESS\profiles\.generations\live\<generationId>\node_modules\`。
   判断依据：junction 存在但 `HARNESS\profiles\web\node_modules\dsh-freetime\index.js` 读不到 = 被剪了。

## 5. 往 web profile 挂 4 个 MCP

编辑 `HARNESS\profiles\web\cordis.patch.yml`，确保存在这 4 个 `@deepseek-ai/dsh-mcp-client` 条目，
`command` 一律是第 0 步探测到的 **`NODE_EXE` 绝对路径**，`args` 指向 `REPO\src\` 下的：

| serverName | args |
| --- | --- |
| `snowluma` | `REPO\src\mcp-snowluma.js` |
| `snowluma-host` | `REPO\src\mcp-host-server.js` |
| `web-search-safe` | `REPO\src\mcp-web-search-safe.js` |
| `diary` | `REPO\src\mcp-diary.js` |

> **坑 ③ 复查**：这四行的 `command` 只要有一个不是绝对路径，对应能力就会「静默消失」。
> 改完重启 DSH，然后确认日志有输出；`REPO\diary\.mcp-status.log` 里的 **spawn 时间戳**变了
> 才说明真的重启了 MCP。（`cordis.patch.yml` 热重载只在**配置值真的变了**时重新实例化 MCP，
> 改注释不算数。）

## 6. 写两个 config.json

**A. `REPO\config.json`**（参考同目录 `config.example.json`）。最少要保证：

```json
{
  "dsh": {
    "baseUrl": "http://127.0.0.1:<第 1 步自测通过的那个端口>",
    "model": "deepseek-flash",
    "reasoningEffort": "high"
  },
  "snowluma": {
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "<SnowLuma 的 httpServers[0].accessToken>",
    "wsUrl": "ws://127.0.0.1:3001",
    "wsAccessToken": "<SnowLuma 的 wsServers[0].accessToken —— 与上面那份不同>"
  }
}
```

> **坑 ④**：DSH 0.1.7 的模型目录只剩 `deepseek-flash`（支持识图，ctx 1M）和 `deepseek-v4-pro`（**纯文本**）。
> 老配置里的 `deepseek-v4-flash-vision-exp` 已不存在，选了会整轮失败。要识图就用 `deepseek-flash`。

**B. `HARNESS\freetime\config.json`**（不存在就新建目录）：

```json
{
  "enabled": true,
  "everyMs": 1800000,
  "windowMs": 600000,
  "profile": "freetime",
  "workdir": "<REPO，正斜杠>",
  "dshBin": "",
  "peakValleyOnly": true,
  "noonWindow": false,
  "nightWindow": true,
  "chatTailLines": 60
}
```

`profile` 必须是 `freetime`（不是 `web`，原因见第 3 步）。`loadConfig` 每 tick 重读，改这个文件不用重启 DSH。

**可选但推荐的两个键**（不写就是默认值，见下）：

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `mode` | `"rpc"` | 每轮投进**同一个** DSH 会话（`src/round-runner.mjs`，会话 id 记在 `REPO\state\round-sessions.json`）。写 `"headless"` 则退回「每轮新开会话」的老行为 |
| `sessionKey` | `"freetime"` | 复用哪个会话槽位；多个实例可各用各的 |

> 用了 `rpc` 就**不需要**第 3 步那个 headless profile 跑起来了（但它留着没坏处：`mode` 写 `headless` 时还要靠它）。
> `rpc` 模式跑在 web profile 里，所以能用到 ego 浏览器等全部工具。

## 7. SnowLuma（只能用户自己装，你不能代劳）

**不要**下载 SnowLuma，**不要**把它放进任何安装包，**不要**写脚本自动部署。
它的 EULA 第 5.4 条要求这些行为必须先取得著作权人书面授权（原文见
`REPO\integrations\snowluma\README.md`）。你只做三件事：

1. **告诉用户下载地址并等他装好**：
   `<https://github.com/SnowLuma/SnowLuma/releases>`，解压后运行 `launcher.bat`，
   **扫码登录机器人 QQ**（生成 `config/onebot_<QQ>.json` 之后才谈得上配置）。
   然后停下来等用户回话确认，不要替他操作。
2. 用户装好后探测：`node scripts/detect-snowluma.mjs`
   —— 给出安装目录、版本、onebot 配置路径、httpServer 端口 / token 状态、`enableWebSocket` 是否关闭。
3. 同步凭证（**不要手抄 token**，很容易抄错）：`node scripts/sync-snowluma-config.mjs`
   —— 把两份 token 分别写进 `config.json` 的 `accessToken`（HTTP）与 `wsAccessToken`（WS）。

> **SnowLuma 是两个端点、两份 token**：HTTP API `127.0.0.1:3000`、WebSocket `ws://127.0.0.1:3001`，
> 各自签发自己的 accessToken，**不能混用**。在它的 WebUI 里重置过 token 就必须重跑同步脚本，否则一直 401。
>
> 历史坑：`config.json` 里曾把 `wsUrl` 也写成 3000、且 token 是两份都不存在的旧值，
> 结果 `check-onebot-status` 一直 `fetch failed`。所以这里不手抄，一律用同步脚本。

最后 `node scripts/check-onebot-status.mjs` 验证连通（应返回机器人 QQ 昵称，耗时 < 200ms）。

## 7.5 刷B站插件（可选）：装完要打一个会话合并补丁

`dsh-bili-scroll` 是第三方插件，用 `dsh plugin --profile web add dsh-bili-scroll` 装。
它每跑一轮都起一个**独立的 headless 会话** ⇒ 侧栏一天多十几个同名对话，而且每轮都「初次见面」。
headless 本身支持 `--session-id`（插件自己的私信回复一直在用），所以打个补丁让它续用同一个会话：

```powershell
node REPO\scripts\patch-bili-session.mjs
```

- 脚本幂等：已打过会直接退出；找不到插件会打印候选路径让你用 `--file` 指定。
- 会话 id 落盘在 `<bili-duty 家目录>\duty-session.json`，第一轮跑完才生成。
- ⚠️ **插件升级会覆盖 `index.js`**，升级后重跑一次这个脚本即可。
- 打完补丁要重启 DSH 才生效（插件代码只在启动时加载）。

## 8. 验收（逐项跑，贴真实输出，不许写"应该没问题"）

| # | 命令 / 检查 | 通过标准 |
| --- | --- | --- |
| 1 | `node src/self-test.js` | `🎉 自测通过` |
| 2 | `dsh --profile freetime "只回复两个字：收到"` | exit=0，输出「收到」 |
| 3 | `dsh --profile freetime` 里调 `mcp__diary__list_entries` | 返回条目列表，不是 `Connection closed` |
| 4 | `HARNESS\profiles\web\node_modules\dsh-freetime\index.js` 存在且能 `Get-Content -TotalCount 3` | 读到内容（junction 没被剪） |
| 5 | `node scripts/detect-snowluma.mjs` + `node scripts/check-onebot-status.mjs` | 找到安装目录；返回机器人 QQ 昵称，耗时 < 200ms（401 就是 token 旧了，重跑同步脚本） |
| 6 | 重启 DSH 后看 `HARNESS\freetime\freetime.log` | 出现 `[freetime] 调度器已启动` 与 `下次窗口约 N 分钟后` |
| 7 | 私聊机器人发一句话 | 收到回复，且 `REPO\state\qq-chat\<今天>.md` 有双向记录 |

## 9. 故障对照表（先查这里，再动手）

| 症状 | 根因 | 处理 |
| --- | --- | --- |
| 所有会话 resume failed、`qq-tool-restrict never started` | preset 只放进 `.agent-presets` | 再复制一份到 `profiles\web\`（坑 ①） |
| `unknown prompt variable "{{cwd}}"` | preset 里有未注册变量 | 全改 `suffix: ''`（坑 ②） |
| `SdkError: Connection closed`，agent 静默不动 | MCP 的 `command` 不是 node.exe 绝对路径 | 改绝对路径（坑 ③） |
| 选不到旧模型 / 整轮失败 | 模型目录变了 | 用 `deepseek-flash` 或 `deepseek-v4-pro`（坑 ④） |
| `ECONNREFUSED` / `401` | DSH 换了端口 | 删掉 `config.json` 里写死的 baseUrl，或设 `autoDiscoverUrl: true` |
| 消息能收不能发 | SnowLuma OneBot HTTP 卡死 | `netstat -ano \| Select-String ':3000' \| Select-String 'CLOSE_WAIT'`，有就重启 SnowLuma |
| 插件装完不见了 | `pnpm add` 剪掉 generation projection | 重建 junction（第 4 步第 4 点） |
| `check-onebot-status` 报 401 | SnowLuma 的 token 变了（WebUI 重置过） | 重跑 `node scripts/sync-snowluma-config.mjs` |
| WS 连上但收不到消息 | `wsUrl` 指错端点 | 指到 `wsServers` 端口（默认 3001）并用 wsServer 自己的 token |
| 桥接不停 `code=1006` 重连，SnowLuma 看起来却正常 | 运行中的实例和磁盘 `onebot_*.json` 不一致（它只在启动时读一次配置） | 别去"对齐"磁盘文件。重启 SnowLuma，再跑 `sync-snowluma-config.mjs`（它会先验活再写） |

全部通过后，输出一张「环境路径 / 版本 / 验收结果」的汇总表，并告诉用户还需要人工做的只剩：扫码登录 SnowLuma、在 DSH 里选模型。

---

## 附：端口到底稳不稳定（给用户的结论）

**不稳定，别写死。** 官方 DSH Desktop 是「起服务时挑一个空闲端口」，实测同一台机器上出现过
`3080`、`19387`、`43129`，而且旧端口会直接没人监听。

所以 qq-bridge 从 v0.2.0 起不假设端口：

- `discoverDshLaunchUrl()` 从 DSH 启动日志里同时捞出 **baseUrl + token**，按日志修改时间从新到旧找；
- `loadConfig` 只在 `baseUrl` 是 loopback（`127.0.0.1` / `localhost` / `[::1]`）时才自动覆盖，
  你要是填了别的地址（走反向代理、远程 DSH）就不会被改；
- 想彻底固定端口：`"dsh": { "autoDiscoverUrl": false }`，然后自己给 DSH 传固定端口启动。

验证结果：修之前 `node src/self-test.js` 用默认 `3080` 直接 `fetch failed`；
修之后同一台机器自动发现到 `43129`，自测六项全绿。
