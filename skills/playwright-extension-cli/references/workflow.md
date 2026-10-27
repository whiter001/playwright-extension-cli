# 常用工作流

三个可以直接抄的流程。每个流程都以「能复核的证据」收尾 —— 没有证据的结论不算结论。

## 一、验证一个 UI 改动

改完前端代码，想确认「真的生效了」，而不是「单元测试过了」。

```bash
# 1) 确认会话在
pwcli status

# 2) 打开改动的页面
pwcli navigate http://localhost:4321/en/pricing

# 3) 看清页面结构，拿到 ref
pwcli snapshot

# 4) 真实点一遍：点开价格档位、切换月付/年付、填表单
pwcli click e21
pwcli fill "#email=you@example.com"
pwcli click "#submit"

# 5) 等结果出现，别 sleep
pwcli wait --text "订单已提交"

# 6) 三件套取证
pwcli screenshot pricing-verified.png
pwcli console --level error
pwcli network --filter "/api/"
```

判定标准：

- `console --level error` 必须为空 —— 有报错就说「不通过」，别忽略。
- `network` 里失败的请求（4xx/5xx）要逐个看 `pwcli request <index>`。
- 截图要能看出改动的效果，否则重截。

## 二、带登录态取数

要抓登录后才能看的数据 —— 扩展的登录态就是为此准备的，**不需要**导出 cookie。

```bash
# 1) 打开一个已经登录的页面
pwcli navigate https://intranet.example.com/orders

# 2) 确认真的登录了（没登录会跳到登录页）
pwcli snapshot --depth 2
```

```bash
# 3) 翻页 + 抽取。抽取用 eval 一次拿一批，比逐条 snapshot 省得多
pwcli eval "() => [...document.querySelectorAll('tr.order')].map(tr => ({
  id: tr.dataset.id,
  amount: tr.querySelector('.amount')?.textContent?.trim(),
  status: tr.querySelector('.status')?.textContent?.trim(),
}))"
```

```bash
# 4) 翻到下一页再来一轮，直到没有下一页
pwcli click ".pagination .next"
pwcli wait --text "订单已提交"      # 或者用 --time 等接口回来
```

要点：

- **先验证登录态再动手**，否则会抓到登录页的 HTML 还以为订单是空的。
- 数据量大时优先 `eval` 批量抽取，不要一页页 snapshot —— snapshot 的内容会全进上下文。
- 抽出来的数据里有 token / 手机号 / 身份证号，落盘前先脱敏。

## 三、复现并定位一个前端报错

用户报「点某个按钮没反应」。目标不是复现，是找到**真正的错误源头**。

```bash
# 1) 复现
pwcli navigate https://example.com/checkout
pwcli snapshot
pwcli click e42

# 2) 抓控制台
pwcli console --all

# 3) 抓网络，看请求发出去了没有
pwcli network

# 4) 如果请求发出去了但响应不对，看细节
pwcli request 5 --part response-body
```

判定顺序：

| 现象 | 结论方向 |
| --- | --- |
| console 有异常堆栈 | 前端 JS 报错，看堆栈第一行属于哪个模块 |
| 没有请求发出 | 事件没绑上 / 被 `disabled` 拦住了 / 前置校验没过 |
| 请求发出但 4xx/5xx | 后端或鉴权问题，看 response-body |
| 请求 200 但页面没变 | 前端状态没更新，或改的不是这份构建产物 |

排错时用 `pwcli eval` 验证假设比反复点更省事：

```bash
pwcli eval "() => ({ hasHandler: !!document.querySelector('#submit').onclick, disabled: document.querySelector('#submit').disabled })"
```

## 四、跑一段自定义脚本

单条命令搞不定、需要自己写 Playwright 时，用 `pwcli run`：

```js
// script.js
async (page) => {
  const rows = await page.locator('tr.order').all();
  const out = [];
  for (const row of rows) {
    out.push({
      id: await row.getAttribute('data-id'),
      amount: (await row.locator('.amount').innerText()).trim(),
    });
  }
  return out;
}
```

```bash
pwcli run script.js
```

它跑在真实的浏览器上下文里，登录态、标签页都是现成的。

## 五、留证据的正确姿势

- 截图用 `--full` 拍整页，文件名带上场景和结论：`pricing-yearly-after.png`。
- 控制台和网络日志**每次都收**，哪怕当时看起来没问题 —— 出了事才看得出差别。
- PDF / storage state / cookie 文件含登录信息，不要提交进仓库。
