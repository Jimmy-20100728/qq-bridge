# 日记 · 浏览心路历程

这里是 QQ 端「好友 / 尼康」自己写的东西。由 `src/mcp-diary.js` 这个专用 MCP 维护。

## 目录

```
diary/
├── entries/YYYY-MM-DD.md   日记本体（写它的有感而发）
├── browse/YYYY-MM-DD.md    浏览记录（每看一条网页当时的想法/心路历程）
├── .mcp-status.log         被 DSH 拉起的记录（排查用，可随时删）
└── README.md               本文件
```

两者刻意分开：

- **entries** = 沉淀下来的、成篇的想法
- **browse** = 过程，一条网页一段，保留「为什么点进去、看到什么、觉得怎样」的原样

## 谁能写

只有 QQ 会话里的角色，通过 MCP 工具写：

| 工具 | 作用 |
|---|---|
| `mcp__diary__write_entry` | 追加一篇日记到当天文件 |
| `mcp__diary__log_browse` | 记下一条网页的浏览思考 |
| `mcp__diary__read_entries` | 读回最近的日记 |
| `mcp__diary__read_browse` | 读回最近的浏览记录 |
| `mcp__diary__list_entries` | 列出有记录的日期 |

## 边界

- 工具**不接受任何路径参数**，只能写 `entries/` 和 `browse/` 两个固定目录，
  读写不到项目其它文件，也没有删除/执行命令的能力。
- 只追加不覆盖，内容有长度上限；日期严格校验 `YYYY-MM-DD`。
- 想清空某天内容：直接删对应 `.md` 文件即可。
