# 命令完整参考

`pwcli` 的全部命令、参数与示例。命令清单和仓库里的 `src/commands.ts` 一一对应
（`scripts/skill-test.mjs` 会检查这份文档没落后于代码）。

## 全局选项

这些选项可以放在任意命令前后：

| 选项 | 说明 |
| --- | --- |
| `--json` | 输出原始工具结果（JSON），便于脚本处理 |
| `--browser <channel>` | `chrome` / `msedge` / `chromium` / …（默认 `chrome`）；每个 channel 是独立会话 |
| `--executable-path <path>` | 指定浏览器可执行文件 |
| `--user-data-dir <path>` | 自定义 User Data 目录 |
| `--profile-dir-name <name>` | Chrome profile 目录名，如 `Default` / `Profile 1` |
| `--token <token>` | 扩展认证 token；`--token ""` 可忽略环境变量 |
| `--client-name <name>` | 扩展 UI / 标签组里显示的名字 |
| `--output-dir <path>` | 截图 / PDF 等自动命名文件的输出目录 |
| `--timeout <ms>` | 等待扩展连接的超时 |
| `--log-level <level>` | `error` / `warn` / `info` / `debug` |

`<target>` 可以是快照里的 `ref`（如 `e12`），也可以是 CSS 选择器。

## 会话命令

### `pwcli connect`

建立会话：打开扩展连接页，等你在浏览器里点「允许」并选一个标签页。
成功后由常驻 daemon 持有会话，后续命令都是毫秒级响应。

```bash
pwcli connect
pwcli connect --browser msedge        # 连 Edge，独立的会话
pwcli connect --timeout 180000        # 默认 120s 超时
```

**每个 browser channel 是独立的会话**：Chrome 和 Edge 可以同时连着，互不干扰。

### `pwcli disconnect`

结束会话并关闭 daemon。只结束 `--browser` 指向的那个会话。

### `pwcli status`

查看会话状态：pid、扩展是否连上、当前页面 URL、daemon 日志路径。

```bash
pwcli status                   # 列出全部正在运行的会话
pwcli status --browser msedge  # 只看 Edge 那个
pwcli status --json            # JSON 数组，每个会话一项
```

### `pwcli doctor`

自检：浏览器可执行文件、User Data 目录、profile 里的扩展安装情况。

```bash
pwcli doctor
```

输出里的 `extension: NOT installed` 表示这个 profile 里没装 Playwright MCP 扩展。

### `pwcli tools`

列出底层可用的浏览器工具及所属能力组。

### `pwcli mcp`

以 MCP server（stdio）方式暴露同一套工具，给 Claude Code / Cursor 这类 MCP 客户端用。

```bash
pwcli mcp
```

### `pwcli install`

把内置的 agent skill（`SKILL.md` + `references/`）装到编码代理的 skills 目录里，
让 agent 学会怎么用这个 CLI。详见仓库 README 的「安装 skill」一节。

```bash
pwcli install --skills                   # 自动检测本机已装的 agent
pwcli install --skills=claude,kimi       # 指定目标
pwcli install --skills=all               # 全部已知目标
pwcli install --skills --global          # 装到用户级目录
pwcli install --skills-dir ./skills      # 装到自定义目录
```

## 导航与页面

### `pwcli navigate <url>`

打开网址。

```bash
pwcli navigate https://example.com
```

### `pwcli back` / `pwcli reload`

后退 / 刷新当前页面。

### `pwcli find <text> [--regex <pattern>]`

在当前页面快照里找文本，用来快速定位目标元素的 ref。

```bash
pwcli find "登录"
pwcli find --regex "/错误|失败/i"
```

### `pwcli wait [--time <seconds>] [--text <text>] [--text-gone <text>]`

等待：固定时间、等文本出现、或等文本消失。

```bash
pwcli wait --text "订单已提交"
pwcli wait --text-gone "加载中"
pwcli wait --time 2
```

### `pwcli tabs [list|new <url>|select <index>|close [index]]`

标签页管理。`close` 不带 index 表示关闭当前标签页。

```bash
pwcli tabs
pwcli tabs new https://example.com
pwcli tabs select 1
pwcli tabs close 1
```

### `pwcli resize <width> <height>`

调整浏览器窗口尺寸，影响响应式布局的验证。

### `pwcli close`

关闭当前页面（不会关掉浏览器）。

## 交互命令

### `pwcli click <target> [--double] [--button <left|right|middle>] [--modifiers <keys>]`

点击元素。`--modifiers` 接受逗号分隔的组合键，例如 `Shift,Control`。

```bash
pwcli click e13
pwcli click e13 --double
pwcli click e13 --button right
pwcli click "#submit"
```

### `pwcli hover <target>`

悬停元素，用来触发下拉菜单、tooltip。

### `pwcli type <target> <text> [--submit] [--slowly]`

在元素里输入文本。`--submit` 输入后按 Enter，`--slowly` 逐字符输入（有些前端要真实键盘事件）。

```bash
pwcli type e4 "hello world"
pwcli type e4 "hello" --submit
```

### `pwcli fill <target=value> [...] [--type <textbox|checkbox|radio|combobox|slider>]`

一次填多个字段。`<type>` 对所有字段生效，默认 `textbox`；勾选框用 `--type checkbox`。

```bash
pwcli fill "#name=张三" "#email=a@b.com"
pwcli fill "#agree=false" --type checkbox
```

### `pwcli press <key>`

按键：`Enter`、`ArrowLeft`、`a`、`Control+C` …

### `pwcli select <target> <value>`

下拉选择（原生 `<select>`）。

```bash
pwcli select e5 blue
```

### `pwcli drag <startTarget> <endTarget>`

把一个元素拖到另一个元素上。

### `pwcli upload <path> [<path> ...]`

给文件选择框上传文件（路径会解析成绝对路径）。

### `pwcli dialog <accept|reject> [--text <prompt text>]`

处理挂起的 `alert` / `confirm` / `prompt` 弹窗。带 `--text` 时用于 prompt 的输入内容。

```bash
pwcli dialog accept
pwcli dialog reject
```

## 取证与排查命令

### `pwcli snapshot [--target <ref>] [--depth <n>] [--boxes]`

打印无障碍快照，元素带 `[ref=eN]` 句柄。`--target` 只看某个元素的子树，
`--depth` 限制层级，`--boxes` 额外打印元素边界框。

```bash
pwcli snapshot
pwcli snapshot --target e13
pwcli snapshot --depth 2
```

### `pwcli screenshot [path] [--full] [--target <ref>] [--scale <css|device>] [--type <png|jpeg|webp>]`

截图。不给路径时写到 `--output-dir` 下自动命名的文件。

```bash
pwcli screenshot
pwcli screenshot evidence.png --full
pwcli screenshot e13.png --target e13
```

### `pwcli pdf [path]`

把当前页面导出成 PDF。

### `pwcli console [--level <error|warning|info|debug>] [--all]`

控制台输出。默认只看 `info` 及以上，`--all` 给出全部级别。

```bash
pwcli console --level error
pwcli console --all
```

### `pwcli network [--filter <regexp>] [--static]`

列出网络请求。`--filter` 按正则过滤 URL，`--static` 连静态资源一起列出（默认过滤掉）。

```bash
pwcli network
pwcli network --filter "/api/"
```

### `pwcli request <index> [--part <request-headers|request-body|response-headers|response-body>]`

看单个请求的细节，index 取自 `pwcli network` 的输出。

```bash
pwcli request 3
pwcli request 3 --part response-body
```

### `pwcli eval <function>`

在页面上下文里执行一个函数并返回结果。

```bash
pwcli eval "() => document.title"
pwcli eval "() => document.querySelectorAll('a').length"
```

### `pwcli run <file.js>`

执行一个 Playwright 片段，文件内容是一个 `async (page) => { ... }` 函数。

```js
// script.js
async (page) => {
  await page.getByRole('button', { name: '订阅' }).click();
  return await page.title();
}
```

```bash
pwcli run script.js
```

### `pwcli cookies [list|get <name>|set <name>=<value>|delete <name>|clear]`

Cookie 操作。

```bash
pwcli cookies
pwcli cookies get sid
pwcli cookies set sid=abc
pwcli cookies delete sid
pwcli cookies clear
```

### `pwcli emulate [--color-scheme <light|dark>] [--reduced-motion <reduce|no-preference>] [--forced-colors <active|none>] [--contrast <more|less|no-preference>] [--media <print|screen>]`

模拟媒体特性，用来验证深色模式、减少动画、打印样式等。

```bash
pwcli emulate --color-scheme dark
pwcli emulate --reduced-motion reduce
```
