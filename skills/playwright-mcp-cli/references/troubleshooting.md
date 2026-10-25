# 排障

按现象查。命令一律用 `pwcli`。

## 会话相关

### `pwcli status` 显示 `extension: waiting for approval in Chrome`

会话起来了，但扩展还没连回来 —— 你还没在 Chrome 里点「允许」并选标签页。
去 Chrome 窗口看扩展连接页，授权后 `pwcli status` 会变成 `connected`。

### `pwcli connect` 超时（默认 120 秒）

依次排查：

1. **扩展装了吗**：`pwcli doctor`。`extension: NOT installed` 就是没装 ——
   去 Chrome 网上应用商店装 "Playwright MCP" 扩展，再重跑 `doctor`。
2. **装在别的 profile 了**：`doctor` 会打印它找到的 profile。如果你的日常 Chrome 用的是
   `Profile 1`，加 `--profile-dir-name "Profile 1"`。
3. **token 过期**：扩展重装 / profile 重置后环境变量里的 token 就不对了。
   不用手动改环境变量 —— CLI 会自动从 profile 里读最新的 token。
   实在要手动指定：`pwcli connect --token "<token>"`，token 从扩展状态页直接复制。
   想完全跳过 token 走手动授权：`pwcli connect --token ""`。
4. **超时太长**：`pwcli connect --timeout 300000`。

### 命令报「没有会话」

daemon 可能被杀了。`pwcli status` 确认后重新 `pwcli connect`。
需要看 daemon 日志时，路径在 `pwcli status` 的输出里（`log:` 那一行）。

### 端口 / socket 冲突

daemon 用 unix socket（Windows 上是命名管道）。残留进程用 `pwcli disconnect` 清；
实在不行按 `pwcli status` 给的 pid 结束进程。

## 元素定位相关

### 报「Element is not attached to the DOM」

ref 来自上一次快照，页面已经变了。**重新 `pwcli snapshot`** 再操作。

### `pwcli click e13` 说找不到元素

按顺序试：

1. 重新 `pwcli snapshot` —— ref 可能已经变了。
2. 元素在折叠面板 / tab 里，先 `pwcli click` 那个容器展开。
3. 元素在 iframe 里，先切到那个 frame（`pwcli eval` 或 `pwcli run` 更方便）。
4. 元素被遮挡：`pwcli hover e13` 看有没有 tooltip，或者用 `--target` 定位父容器。
5. 实在不行用 CSS 选择器：`pwcli click "button.primary"`。

### 快照太长，上下文被吃掉了

- `pwcli snapshot --depth 2` 限制层级。
- `pwcli snapshot --target e13` 只看目标元素的子树。
- 大范围抓数据改用 `pwcli eval` 批量抽取，别整页 snapshot。

## 脚本 / 转义相关

### PowerShell 里 URL 带 `&` 报错

`&` 在 PowerShell 里是命令分隔符。两个办法：

```powershell
pwcli navigate "https://example.com/search?q=a&b=c"   # 加引号
pwcli --% navigate https://example.com/search?q=a&b=c   # 或者停止解析
```

### `pwcli eval` 报语法错误

函数体要用箭头函数并整体加引号：

```bash
pwcli eval "() => document.title"
```

含 `$`、反引号时用单引号包住整个表达式，内部用双引号。

### `pwcli run` 报找不到文件

路径相对于当前工作目录解析。用绝对路径最稳。

## 环境相关

### `pwcli doctor` 说找不到浏览器可执行文件

指定一个：`pwcli doctor --executable-path "C:\Program Files\Google\Chrome\Application\chrome.exe"`。
或者换一个 channel：`--browser msedge`。

### 操作用的是另一个浏览器 / 另一个 profile

会话是 daemon 级别的。`pwcli disconnect` 之后用新的参数重新 `pwcli connect`：

```bash
pwcli disconnect
pwcli connect --browser msedge --profile-dir-name "Profile 1"
```

### 想同时跑两个会话

当前实现是**单会话**（一个 daemon、一个 socket）。要并行就分开跑：不同目录、不同
`--client-name` 的两个 CLI 进程目前会抢同一个 socket，不支持。

## 只想确认扩展还在不在

```bash
pwcli doctor
```

它会打印 channel、可执行文件、User Data 目录、找到的 profile，以及扩展装没装 —— 这是排障的第一步。
