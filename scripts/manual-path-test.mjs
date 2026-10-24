/**
 * Manual-path test: exercises the real Playwright Extension against an
 * isolated Chrome instance, with no human in the loop.
 *
 * The extension is loaded in a throw-away Chrome profile (see README), so the
 * script can open the extension's connect page, click "Allow & select" over
 * CDP, and then verify that the relay picks the tab up.
 *
 * Prerequisites:
 *   - a Chrome instance on 127.0.0.1:9333 with the Playwright Extension
 *     loaded (see scripts/setup-test-chrome.sh)
 *   - a page open in that instance (the script opens example.com itself)
 *
 * Usage: node scripts/manual-path-test.mjs
 */

import assert from 'assert';
import { createRequire } from 'module';

import { WebSocket } from 'ws';

const require = createRequire(import.meta.url);

const { chromium } = await import('playwright-core');
const { CDPRelayServer } = await import('../dist/relay/cdpRelay.js');
const { buildConnectUrl } = await import('../dist/relay/chrome.js');

const CHROME_DEBUG_PORT = 9333;
const TEST_PAGE = 'https://example.com/';

const chromeTargets = async () => {
  const response = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/list`);
  return await response.json();
};

async function cdpEval(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  const result = await new Promise((resolve, reject) => {
    const id = 1;
    ws.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.id === id) {
        ws.close();
        message.error ? reject(new Error(message.error.message)) : resolve(message.result?.result?.value);
      }
    });
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
    setTimeout(() => reject(new Error('CDP evaluate timed out')), 10_000);
  });
  return result;
}

// ─── 1. relay ──────────────────────────────────────────────────────────

const relay = new CDPRelayServer({ protocolVersion: 2 });
await relay.start();
console.log(`relay: ${relay.extensionEndpoint()}`);

// ─── 2. open the extension connect page in the test browser ───────────

const connectUrl = buildConnectUrl({
  relayUrl: relay.extensionEndpoint(),
  clientName: 'pw-mcp-cli-test',
  protocolVersion: 2,
});
await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/new?${encodeURIComponent(connectUrl)}`, { method: 'PUT' });

let connectTarget;
for (let i = 0; i < 40 && !connectTarget; i++) {
  const targets = await chromeTargets();
  connectTarget = targets.find(t => t.type === 'page' && (t.url || '').includes('connect.html'));
  if (!connectTarget)
    await new Promise(resolve => setTimeout(resolve, 250));
}
assert.ok(connectTarget, 'the extension connect page did not open');
console.log('✓ extension connect page opened');

// ─── 3. click "Allow & select" on the test page row ───────────────────

let clicked;
for (let i = 0; i < 40; i++) {
  clicked = await cdpEval(connectTarget, `(() => {
    const buttons = [...document.querySelectorAll('button')].filter(b => /allow/i.test(b.textContent));
    if (!buttons.length) return 'no-allow-button';
    let button = buttons[0];
    for (const b of buttons) {
      const row = b.closest('li') || b.parentElement;
      if (row && row.textContent.includes('example.com')) { button = b; break; }
    }
    button.click();
    return 'clicked:' + button.textContent.trim();
  })()`);
  if (String(clicked).startsWith('clicked:'))
    break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
assert.match(String(clicked), /^clicked:/, `unexpected click result: ${clicked}`);
console.log(`✓ clicked "${clicked}"`);

// ─── 4. the relay must pick the extension up ──────────────────────────

await relay.establishExtensionConnection();
console.log('✓ extension connected to the relay');

// ─── 5. the CDP client must see the picked tab ─────────────────────────

const browser = await chromium.connectOverCDP(relay.cdpEndpoint(), {
  isLocal: true,
  timeout: 0,
  noDefaults: true,
});
const context = browser.contexts()[0];
assert.ok(context, 'no browser context');
const page = context.pages()[0];
assert.ok(page, 'no page attached');
await page.waitForLoadState('domcontentloaded').catch(() => {});
assert.match(page.url(), /example\.com/, `unexpected page url: ${page.url()}`);
console.log(`✓ attached to the picked tab: ${page.url()}`);

// ─── 6. and the page must be really drivable ──────────────────────────

const title = await page.title();
assert.match(title, /Example Domain/, `unexpected title: ${title}`);
const bodyText = await page.locator('body').innerText();
assert.match(bodyText, /documentation examples|Learn more|Example Domain/i, 'unexpected page content');
console.log('✓ the attached page is fully drivable');

// ─── 7. the upstream MCP tool layer must drive it end to end ──────────

const { tools } = require('playwright-core/lib/coreBundle');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mcpServer = await tools.createConnection({ extension: true, browser: { isolated: false } }, async () => context);
await mcpServer.connect(serverTransport);

const client = new Client({ name: 'manual-path-test', version: '1.0.0' }, { capabilities: {} });
await client.connect(clientTransport);

const { tools: toolList } = await client.listTools();
assert.ok(toolList.some(t => t.name === 'browser_snapshot'), 'browser_snapshot is missing');
console.log(`✓ MCP tool layer exposes ${toolList.length} tools`);

const snapshot = await client.callTool(
  { name: 'browser_snapshot', arguments: {} },
  undefined,
  { timeout: 60_000 },
);
const snapshotText = (snapshot.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
assert.match(snapshotText, /Example Domain|documentation examples/i, `unexpected snapshot:\n${snapshotText.slice(0, 400)}`);
assert.match(snapshotText, /ref=/, 'the snapshot should carry aria refs');
console.log('✓ browser_snapshot returned the real page with aria refs');
console.log(snapshotText.split('\n').slice(0, 14).join('\n'));

await client.close();
await browser.close().catch(() => {});
relay.stop();
console.log('\nManual-path test passed.');
process.exit(0);
