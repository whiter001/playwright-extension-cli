# playwright-mcp-cli

用**命令行**驱动你日常用的浏览器 —— 通过已安装的 **Playwright Chrome Extension**，
复用扩展的登录态 / 会话 / 标签页。

底层动作复用上游 `playwright-core` 的 MCP 工具层，所以快照格式（`[ref=e12]`）、
点击语义、等待策略与官方 `playwright-mcp` 完全一致；**桥接层（relay）和会话管理由本项目自己实现**。

```
pwcli navigate https://example.com
pwcli snapshot
pwcli click e13
pwcli type e4 "hello"
pwcli screenshot shot.png
```

## 快速开始

```bash
npm install
npm run build

node dist/cli.js doctor      # 自检：浏览器 / profile / 扩展
node dist/cli.js connect     # 打开扩展连接页，在 Chrome 里选一个标签页
node dist/cli.js navigate https://example.com
```

`connect` 之后会话由一个**常驻 daemon** 持有，所以后续每条命令都是毫秒级响应，
不用反复授权。

## 命令

### 会话

| 命令 | 说明 |
| --- | --- |
| `connect` | 启动会话（打开扩展连接页，等你在 Chrome 里授权） |
| `disconnect` | 结束会话，关闭 daemon |
| `status` | 查看会话状态（pid / 扩展是否连上 / 当前页面） |
| `tools` | 列出可用的浏览器工具 |
| `doctor` | 检查浏览器 / profile / 扩展安装情况 |
| `mcp` | 以 MCP server（stdio）方式暴露同一套工具 |

### 浏览器

| 命令 | 说明 |
| --- | --- |
| `navigate <url>` | 打开网址 |
| `back` / `reload` | 后退 / 刷新 |
| `snapshot [--target <ref>] [--depth <n>] [--boxes]` | 打印无障碍快照（含 `[ref=eN]`） |
| `click <target> [--double] [--button <left\|right\|middle>]` | 点击元素（ref 或 CSS 选择器） |
| `hover <target>` | 悬停 |
| `type <target> <text> [--submit] [--slowly]` | 输入文本 |
| `fill <target=value> [...] [--type <type>]` | 一次填多个字段（默认 `textbox`，可传 `checkbox`/`radio`/`combobox`/`slider`） |
| `press <key>` | 按键（Enter / ArrowLeft / a …） |
| `select <target> <value>` | 下拉选择 |
| `drag <start> <end>` | 拖拽 |
| `screenshot [path] [--full] [--target <ref>] [--scale <css\|device>]` | 截图 |
| `pdf [path]` | 导出 PDF |
| `eval <function>` | 在页面里执行函数，如 `eval "() => document.title"` |
| `run <file.js>` | 执行 Playwright 片段：`async (page) => { ... }` |
| `console [--level <level>] [--all]` | 控制台输出 |
| `network [--filter <regexp>] [--static]` | 网络请求列表 |
| `request <index> [--part <part>]` | 单个请求的细节 |
| `find <text> [--regex <re>]` | 在快照里找文本 |
| `wait [--time <s>] [--text <t>] [--text-gone <t>]` | 等待 |
| `tabs [list\|new <url>\|select <i>\|close <i>]` | 标签页管理 |
| `resize <w> <h>` | 调整窗口大小 |
| `upload <path> [...]` | 上传文件 |
| `dialog <accept\|reject> [--text <t>]` | 处理弹窗 |
| `emulate [--color-scheme <light\|dark>] [--reduced-motion <reduce\|no-preference>]` | 媒体特性模拟 |
| `cookies [list\|get <n>\|set <n>=<v>\|delete <n>\|clear]` | Cookie 操作 |
| `close` | 关闭当前页面 |

`<target>` 可以是快照里的 `ref`（如 `e12`），也可以是 CSS 选择器。

### 全局选项

| 选项 | 说明 |
| --- | --- |
| `--json` | 输出原始工具结果（JSON），便于脚本处理 |
| `--browser <channel>` | `chrome` / `msedge` / `chromium` / …（默认 chrome） |
| `--executable-path <path>` | 指定浏览器可执行文件 |
| `--user-data-dir <path>` | 自定义 User Data 目录 |
| `--profile-dir-name <name>` | Chrome profile 目录名，如 `Default` / `Profile 1` |
| `--token <token>` | 扩展认证 token；`--token ""` 可忽略环境变量 |
| `--client-name <name>` | 扩展 UI / 标签组里显示的名字 |
| `--output-dir <path>` | 截图 / PDF 等自动命名文件的输出目录 |
| `--timeout <ms>` | 等待扩展连接的超时 |
| `--log-level <level>` | `error` / `warn` / `info` / `debug` |

## 工作原理

```
pwcli <command>
   │  unix socket
   ▼
daemon ── relay (WebSocket, 127.0.0.1)
             ├─ /extension/<uuid> ← Chrome Extension（主动连回）
             └─ /cdp/<uuid>      ← playwright.chromium.connectOverCDP
   │
   └─ 工具层：playwright-core/lib/coreBundle（上游 MCP 工具实现）
```

1. **找 profile**：读 `<User Data>/Local State` 的 `profile.last_used`，
   依次检查 `Default` / `Profile N` 下是否存在 `Extensions/mmlmfjhmonkocbjadbfplnigmagldckm`
   或 `Preferences` 里的扩展记录。
2. **起 relay**：在 `127.0.0.1` 上开一个 WebSocket server，两条路径各带随机 UUID
   （防止本机其它进程连上）。扩展强制要求 relay 必须是 loopback 地址。
3. **开连接页**：`spawn` 浏览器打开
   `chrome-extension://<id>/connect.html?mcpRelayUrl=ws://…&client=…&protocolVersion=2[&token=…]`，
   扩展用 `localStorage` 里的 `auth-token` 比对 token 后**主动连回** relay。
4. **协议 v2**：扩展先推 `chrome.tabs.onCreated`（每个标签页），最后推 `extension.initialized`。
   relay 在这之前不处理 CDP 命令，保证 `Target.setAutoAttach` 拿到的是完整 tab 模型。
5. **CDP over relay**：`chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: 0, noDefaults: true })`。
   `noDefaults` 很关键 —— 不能去改用户日常浏览器的 acceptDownloads / 媒体模拟等默认值。
6. **工具层**：`tools.createConnection(config, contextGetter)` 把 relay 拿到的 `BrowserContext`
   注入上游 MCP server；daemon 通过内存 transport 调用它，命令与 agent 走的是同一套实现。

**为什么需要 daemon**：扩展的 WebSocket 断了连接就没了 —— CLI 单次执行退出的话，
每次命令都要重新授权。所以连接常驻 daemon，命令通过 unix socket 走。

### 扩展 ID 与认证 token

| | 怎么来的 |
| --- | --- |
| **扩展 ID** | 硬编码常量 `mmlmfjhmonkocbjadbfplnigmagldckm`（`src/relay/chrome.ts`）。它由扩展 manifest 的 `key` 字段固定，升级不变。用于拼 `chrome-extension://<id>/connect.html` 和定位 profile 里的扩展目录。 |
| **token** | 扩展把它存在自己页面的 `localStorage["auth-token"]`（`chrome-extension://<id>` origin）。CLI 的解析顺序：**`--token <值>` → 从浏览器 profile 自动发现 → `PLAYWRIGHT_MCP_EXTENSION_TOKEN` 环境变量 → 无 token（手动授权）**。 |

自动发现的做法是读 profile 的 `Local Storage/leveldb`（Chrome 把扩展页面的 localStorage 存在这），
在扩展 ID 附近找那个 43 位 base64url token，取**最新**的文件（LevelDB 文件号随时间递增）。
这一步是为了避免环境变量里的 token 过期 —— 扩展重装 / profile 重置后环境变量不会自动更新。

**从哪手动拿 token**：点扩展图标打开状态页，上面直接显示 `PLAYWRIGHT_MCP_EXTENSION_TOKEN=...`。

> 注意：token 是通过 connect 页的 URL 参数传的，会进 Chrome 的历史记录。不想留痕就别用 token，
> 走手动授权即可（`--token ""` 可强制忽略环境变量）。

协议细节（命令 / 事件 / 消息帧）见 `src/relay/protocol.ts`。

## 开发与测试

```bash
npm run typecheck
npm run build

# 1) 离线测试：参数映射 + relay（假扩展），不需要 Chrome
npm test

# 2) 手动选标签页的全链路测试（真扩展 + 隔离 Chrome，CDP 自动点授权）
npm run test:chrome      # 准备 /tmp/pw-test-profile 的 Chrome
npm run test:manual

# 3) CLI 本身的端到端测试（真跑 pwcli 子命令）
npm run test:cli

# 4) 对着你日常用的 Chrome 跑 MCP server（需要在 Chrome 里点一下）
node scripts/e2e.mjs
```

`scripts/args-test.mjs` 遍历全部命令，把 CLI 参数映射成 tool 调用后**用上游 zod schema 校验**，
所以命令语法和工具 schema 对不上时会直接失败（`fill` 少传 `name`/`type` 这类 bug 就是它兜住的）。

`scripts/relay-test.mjs` 用一个假扩展实现协议 v2，断言 relay 的握手时序、
tab ↔ session 映射、命令路由与错误传播。

`scripts/manual-path-test.mjs` 与 `scripts/cli-test.mjs` 会用 CDP 打开扩展的连接页
并自己点掉「Allow & select」，然后断言扩展连回 relay、挂上被选中的真实标签页、
上游工具层能跑出带 aria ref 的 `browser_snapshot`，以及 CLI 各子命令的行为。

CI（`.github/workflows/ci.yml`）在 push / PR 上跑 `typecheck` + `npm test`——
这两个套件都不需要浏览器。需要真实 Chrome 的 `test:manual` / `test:cli` 留在本地跑。

`npm run build` 会先 `clean` 再编译：`tsc` 不会删除已删除源文件留下的旧产物，
不清理的话 `dist/` 里会一直躺着过期的 `.js`，而 `files: ["dist"]` 会把它们一起发布出去。

## 致谢与许可

- 工具层、协议与 relay 实现移植自 [microsoft/playwright](https://github.com/microsoft/playwright)
  的 `packages/playwright-core/src/tools/mcp/`（Apache-2.0）。
- 浏览器扩展本体由 Microsoft 维护，**本项目不修改扩展**，只按协议 v2 与它通信。
- 本项目同样以 Apache-2.0 发布。
