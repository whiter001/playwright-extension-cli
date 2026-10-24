# playwright-mcp-cli

把 MCP client 接到**已安装的 Playwright Chrome Extension** 上，复用扩展的登录态 / 会话 / 标签页。

和 `npx @playwright/mcp@latest --extension` 的区别：**桥接层（relay）由本项目自己实现**，
MCP 工具层直接复用上游 `playwright-core` 的 bundle —— 所以工具名、aria ref 快照格式、
行为与官方完全一致，但连接过程、profile 探测、CLI 参数由你自己掌控。

```
MCP client ──stdio(JSON-RPC)──▶ playwright-mcp-cli
                                    │
                                    ├─ relay: WebSocket server (127.0.0.1)
                                    │    ├─ /cdp/<uuid>       ← Playwright CDP client
                                    │    └─ /extension/<uuid> ← Chrome Extension
                                    │
                                    └─ tools: playwright-core/lib/coreBundle
                                              (browser_snapshot / browser_click / ...)
```

## 快速开始

```bash
npm install
npm run build

# 自检：浏览器、profile、扩展是否就位
node dist/cli.js doctor
```

接入 MCP client：

```json
{
  "mcpServers": {
    "playwright-extension": {
      "command": "node",
      "args": ["/path/to/playwright-mcp-cli/dist/cli.js"]
    }
  }
}
```

首次调用时，CLI 会在 Chrome 里打开扩展的连接页（`chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html`），
选一个标签页即可授权。

## 命令行参数

| 参数 | 说明 | 环境变量 |
| --- | --- | --- |
| `--browser <channel>` | 浏览器渠道：`chrome` / `msedge` / `chromium` / `chrome-beta` … | `PLAYWRIGHT_MCP_BROWSER` |
| `--executable-path <path>` | 显式指定浏览器可执行文件 | `PLAYWRIGHT_MCP_EXECUTABLE_PATH` |
| `--user-data-dir <path>` | 自定义浏览器 User Data 目录 | — |
| `--profile-dir-name <name>` | Chrome profile 目录名，如 `Default` / `Profile 1` | `PLAYWRIGHT_MCP_PROFILE_DIR_NAME` |
| `--token <token>` | 扩展认证 token，跳过授权对话框 | `PLAYWRIGHT_MCP_EXTENSION_TOKEN` |
| `--client-name <name>` | 扩展 UI / 标签组里显示的名字，默认 `playwright-mcp-cli` | — |
| `--caps <a,b,c>` | 额外能力（`network,pdf,vision`…），`core` 恒开 | — |
| `--output-dir <path>` | 自动命名输出文件（截图 / PDF）的目录 | — |
| `--timeout <ms>` | 等待扩展连接的时长，`0` = 一直等（默认） | — |
| `--log-level <level>` | `error` / `warn` / `info` / `debug` | `PW_MCP_CLI_LOG` |

`playwright-mcp-cli doctor` 会打印：浏览器可执行文件、User Data 目录、装了扩展的 profile、以及扩展是否真的装在那个 profile 里。

> **注意**：带 `--token` 时扩展会跳过「选择标签页」界面，直接连接**连接页自身**
> （这是扩展 0.4.0 的既定行为）。要操作真实网页，请**不要**传 token，在连接页里手动选标签页。

## 工作原理

1. **找 profile**：读 `<User Data>/Local State` 的 `profile.last_used`，
   依次检查 `Default` / `Profile N` 下是否存在 `Extensions/mmlmfjhmonkocbjadbfplnigmagldckm`
   或 `Preferences` 里的扩展记录。
2. **起 relay**：在 `127.0.0.1` 上开一个 WebSocket server，两条路径各带一个随机 UUID
   （防止本机其它进程连上）。扩展强制要求 relay 必须是 loopback 地址。
3. **开连接页**：`spawn` 浏览器打开
   `chrome-extension://<id>/connect.html?mcpRelayUrl=ws://…&client=…&protocolVersion=2[&token=…]`。
   扩展用 `localStorage` 里的 `auth-token` 比对 token，然后**主动连回** relay。
4. **协议 v2**：扩展连上后先推 `chrome.tabs.onCreated`（每个标签页），最后推
   `extension.initialized`。relay 在这之前不处理 CDP 命令，
   保证 `Target.setAutoAttach` 拿到的是完整 tab 模型。
5. **CDP over relay**：`chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: 0, noDefaults: true })`。
   `noDefaults` 很关键 —— 不能去改用户日常浏览器的 acceptDownloads / 媒体模拟等默认值。
6. **工具层**：`tools.createConnection(config, contextGetter)` 把 relay 拿到的
   `BrowserContext` 注入上游 MCP server，工具集与官方 `playwright-mcp` 完全一致。

协议细节（命令 / 事件 / 消息帧）见 `src/relay/protocol.ts`。

## 代码结构

```
src/
  cli.ts              参数解析、doctor 子命令、信号处理
  server.ts           relay → connectOverCDP → createConnection 串联
  log.ts              stderr logger（stdout 留给 MCP）
  relay/
    protocol.ts       协议 v2 的类型定义
    browserModel.ts   chrome tab id ↔ CDP sessionId 映射、事件翻译
    relayV2.ts        chrome.* 方言 ↔ CDP 方言适配层
    cdpRelay.ts       WebSocket relay server
    wsServer.ts       带路径路由的最小 WS server
    chrome.ts         浏览器发现、profile 探测、连接页唤起
scripts/
  relay-test.mjs        离线 relay 测试（假扩展）
  manual-path-test.mjs  真扩展全链路测试
  setup-test-chrome.sh  准备隔离的测试 Chrome
  e2e.mjs               对着日常 Chrome 的端到端冒烟测试
```

## 开发与测试

```bash
npm run typecheck
npm run build

# 1) 离线 relay 测试（假扩展 + 裸 CDP 客户端，不需要 Chrome）
npm test

# 2) 手动选标签页的全链路测试（真扩展 + 隔离 Chrome 实例，无需人工点击）
npm run test:chrome      # 准备 /tmp/pw-test-profile 的 Chrome
npm run test:manual

# 3) 对着你自己日常用的 Chrome 跑（会在 Chrome 里打开连接页，需要点一下）
node scripts/e2e.mjs
node scripts/e2e.mjs --token <token>   # 全自动
```

`scripts/relay-test.mjs` 用一个假扩展实现协议 v2，断言 relay 的握手时序、
tab ↔ session 映射、命令路由与错误传播。

`scripts/manual-path-test.mjs` 会用 CDP 打开扩展的连接页并自己点掉
「Allow & select」，然后断言：扩展连回 relay、relay 挂上被选中的标签页、
上游 MCP 工具层能对真实页面跑出带 aria ref 的 `browser_snapshot`。

## 致谢与许可

- 工具层、协议与 relay 实现移植自 [microsoft/playwright](https://github.com/microsoft/playwright)
  的 `packages/playwright-core/src/tools/mcp/`（Apache-2.0）。
- 浏览器扩展本体由 Microsoft 维护，**本项目不修改扩展**，只按协议 v2 与它通信。
- 本项目同样以 Apache-2.0 发布。
