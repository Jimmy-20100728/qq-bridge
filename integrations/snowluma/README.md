# SnowLuma 接入说明

SnowLuma 是**独立第三方项目**（[SnowLuma/SnowLuma](https://github.com/SnowLuma/SnowLuma)），
有自己的 EULA，**本仓库不打包它、也不代装它**。

> 它的 EULA 第 5.4 条原文：「不得复制、修改、单独再分发或再许可该组件。**将其并入第三方安装包**或
> Docker 镜像、**通过自动化脚本部署**，或者将其用于任何商业用途，均须事先取得书面授权。」
>
> 所以把它塞进 qq-bridge 的发布包里、或者写脚本自动下载安装，都是不允许的。
> 正确做法：**你自己去官方 releases 下载安装**，qq-bridge 只负责在你装好之后把配置接起来。

## 一、安装 SnowLuma（这一步必须你手动做）

1. 从官方发版页下载对应平台的发行包：<https://github.com/SnowLuma/SnowLuma/releases>
   （本项目实测可用的是 `1.14.x` 系列；更新的 2.x 未验证。）
2. 解压到任意目录，例如 `E:\qqai\snowluma`。
3. 运行目录里的 `launcher.bat`，**扫码登录你的机器人 QQ**。
   这一步之后才会生成 `config/onebot_<QQ号>.json`。
4. 确认它已经在跑（日志里会有 `OneBot.HTTP ... listening 127.0.0.1:3000`）。

装好后用这条命令确认 qq-bridge 能看见它：

```bash
node scripts/detect-snowluma.mjs
```

它会打出安装目录、版本、`config/onebot_<QQ>.json` 路径，以及 httpServer 的端口 / token 是否已配，
还会提醒 `enableWebSocket` 是不是关着的。

## 二、两端点：HTTP 给「发」，WS 给「收」

SnowLuma 默认给两个端点，**各签发一份不同的 accessToken**，别混用：

| 用途 | 默认地址 | qq-bridge 的 config.json 字段 | 用哪个 token |
| --- | --- | --- | --- |
| HTTP API（发消息、查信息） | `http://127.0.0.1:3000` | `snowluma.httpUrl` | `snowluma.accessToken` |
| WebSocket（收消息） | `ws://127.0.0.1:3001` | `snowluma.wsUrl` | `snowluma.wsAccessToken` |

> 也可以只用一个端口：把 httpServer 的 `enableWebSocket` 打开、不配 wsServers，
> 这时 WS 走 `ws://127.0.0.1:3000`，两个字段填同一个 token 即可。

## 三、把配置同步进 qq-bridge（不用手抄 token）

```bash
node scripts/sync-snowluma-config.mjs
```

它会自动找到 `config/onebot_<QQ>.json`，把端口和**两份** token 分别写进 `config.json` 的
`httpUrl / accessToken / wsUrl / wsAccessToken`。找不到就手动传路径：

```bash
node scripts/sync-snowluma-config.mjs "E:\qqai\snowluma\config\onebot_123456789.json"
```

然后验证连通：

```bash
node scripts/check-onebot-status.mjs
```

## 四、让 agent 自己开关 SnowLuma（可选）

填了 `launcherPath`（启动脚本）与 `homeDir`（SnowLuma 安装目录）后，
`src/mcp-host-server.js` 提供的工具可以让 QQ 里的 agent 自己重启 SnowLuma ——
它卡死时非常有用（见下）。这两个字段留空 = 禁用该能力。

## 五、典型故障

### 能收不能发

**症状**：QQ 消息照常进来（未读在涨），但 agent 发的消息超时；SnowLuma 进程还在、WebUI 也能开。

**根因**：SnowLuma 的 OneBot HTTP 服务卡住，连接被挂成 `CLOSE_WAIT`。

```powershell
netstat -ano | Select-String ':3000' | Select-String 'CLOSE_WAIT'
```

出现一堆 `CLOSE_WAIT` 就是它。**重启 SnowLuma 即可**（登录态不丢）。重启后
`get_login_info` 应该几十毫秒返回；如果还是慢，那才是真掉线。

### `fetch failed` / `401`

- `fetch failed` → 端口不对，或 SnowLuma 根本没在跑（先看有没有进程在监听 3000）。
- `401` → token 不对。**注意 SnowLuma 每次在 WebUI 里重置 token 都会变**，重置后必须重跑
  `node scripts/sync-snowluma-config.mjs`。

### WS 连上但收不到消息

`wsUrl` 指错了。指到 httpServer 端口时，需要那个端口 `enableWebSocket: true`；
否则要指到独立的 `wsServers` 端口（默认 3001），并且用 **wsServer 自己的 token**。

### ⚠️ 最重要的一条：磁盘配置 ≠ 正在运行的实例

SnowLuma **只在启动时读一次** `config\onebot_<QQ>.json`。如果那份文件在启动之后被改过
（改端口、重置 token、开关 WebSocket），运行中的进程仍然用**内存里的旧值**。

所以「把 config.json 对齐成磁盘文件的样子」是危险操作，会直接让桥接 `code=1006` 无限重连，
而 SnowLuma 表面上一切正常。判断实际能用什么，只有两个办法：

- 用 `sync-snowluma-config.mjs`（它写入前会先拿目标 token 打一次 `get_login_info`，
  不通就拒绝写入——这就是为了防止上面这个坑）；
- 或者手动确认：`netstat -ano | findstr :3001`（端口没在听就是没用），
  以及拿 token 试 `curl -H "Authorization: Bearer <token>" http://127.0.0.1:3000/get_login_info`。

改了 SnowLuma 配置就**重启 SnowLuma**，然后重跑 sync。

## 六、合规提醒

SnowLuma 与腾讯/QQ 无隶属关系，仅供学习与技术研究。用它登录非本人账号、批量骚扰、
或违反《QQ 用户协议》的行为与本项目无关，请自行承担后果。
