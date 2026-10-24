/**
 * Offline relay test: no Chrome, no extension, no user interaction.
 *
 * A fake extension speaks protocol v2 over the relay's /extension endpoint,
 * and a raw CDP client speaks over /cdp. The test asserts that:
 *   1. the relay waits for `extension.initialized` before serving CDP,
 *   2. `Target.setAutoAttach` makes the relay attach to the tab and emit
 *      `Target.attachedToTarget`,
 *   3. a session-scoped CDP command is routed to the right tab,
 *   4. a browser-scoped CDP command is routed through an attached tab,
 *   5. `Browser.getVersion` is answered locally.
 *
 * Usage: node scripts/relay-test.mjs
 */

import assert from 'assert';

import { WebSocket } from 'ws';

const { CDPRelayServer } = await import('../dist/relay/cdpRelay.js');

const FAKE_TAB = {
  id: 42,
  index: 0,
  windowId: 1,
  url: 'https://example.com/',
  title: 'Example',
  active: true,
  pinned: false,
};

const relay = new CDPRelayServer({ protocolVersion: 2 });
await relay.start();
console.log(`relay up: cdp=${relay.cdpEndpoint()} extension=${relay.extensionEndpoint()}`);

// ─── fake extension ────────────────────────────────────────────────────

const extension = new WebSocket(relay.extensionEndpoint());
const received = [];

await new Promise((resolve, reject) => {
  extension.on('open', resolve);
  extension.on('error', reject);
});

extension.on('message', data => {
  const message = JSON.parse(data.toString());
  received.push(message);

  if (message.method === 'chrome.debugger.attach')
    send(message.id, {});
  else if (message.method === 'chrome.debugger.detach')
    send(message.id, {});
  else if (message.method === 'chrome.debugger.sendCommand') {
    const [, cdpMethod] = message.params;
    if (cdpMethod === 'Target.getTargetInfo') {
      send(message.id, {
        targetInfo: {
          targetId: 'FAKE-TARGET-1',
          type: 'page',
          title: 'Example',
          url: 'https://example.com/',
          attached: false,
        },
      });
    } else if (cdpMethod === 'Runtime.evaluate') {
      send(message.id, { result: { type: 'string', value: 'evaluated' } });
    } else if (cdpMethod === 'Page.captureScreenshot') {
      extension.send(JSON.stringify({ id: message.id, error: 'Screenshots are not supported here' }));
    } else {
      send(message.id, {});
    }
  } else if (message.method === 'chrome.tabs.create') {
    send(message.id, { ...FAKE_TAB, id: 43 });
  } else if (message.method === 'chrome.tabs.remove') {
    send(message.id, {});
  } else {
    send(message.id, {});
  }
});

let nextId = 0;
function send(id, result) {
  extension.send(JSON.stringify({ id, result }));
}
function emit(method, params) {
  extension.send(JSON.stringify({ method, params }));
}

// ─── raw CDP client ────────────────────────────────────────────────────

const cdp = new WebSocket(relay.cdpEndpoint());
const events = [];
const pending = new Map();
let cdpId = 0;

await new Promise((resolve, reject) => {
  cdp.on('open', resolve);
  cdp.on('error', reject);
});

cdp.on('message', data => {
  const message = JSON.parse(data.toString());
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  } else if (message.method) {
    events.push(message);
  }
});

function command(method, params, sessionId) {
  const id = ++cdpId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    cdp.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

// The relay must not answer CDP commands before the extension handshake.
const versionBeforeHandshake = await command('Browser.getVersion', {});
assert.strictEqual(versionBeforeHandshake.product, 'Chrome/Extension-Bridge');
console.log('✓ Browser.getVersion is answered locally');

emit('chrome.tabs.onCreated', [FAKE_TAB]);
emit('extension.initialized', []);

await relay.establishExtensionConnection();
console.log('✓ extension handshake completed');

// Target.setAutoAttach must make the relay attach to the known tab.
await command('Target.setAutoAttach', { autoAttach: true, flatten: true });
await waitFor(() => events.some(e => e.method === 'Target.attachedToTarget'));

const attached = events.find(e => e.method === 'Target.attachedToTarget');
assert.ok(attached.params.sessionId.startsWith('pw-tab-'), 'expected a relay session id');
assert.strictEqual(attached.params.targetInfo.targetId, 'FAKE-TARGET-1');
console.log(`✓ Target.attachedToTarget emitted for session ${attached.params.sessionId}`);

// The extension must have been asked to attach the debugger to our tab.
const attachCall = received.find(m => m.method === 'chrome.debugger.attach');
assert.ok(attachCall, 'expected a chrome.debugger.attach call');
assert.deepStrictEqual(attachCall.params[0], { tabId: FAKE_TAB.id });
assert.strictEqual(attachCall.params[1], '1.3');
console.log('✓ chrome.debugger.attach forwarded with the right target');

// A session-scoped command must be routed to the owning tab.
const evaluated = await command('Runtime.evaluate', { expression: '1+1' }, attached.params.sessionId);
assert.deepStrictEqual(evaluated, { result: { type: 'string', value: 'evaluated' } });
const sendCommandCall = received.filter(m => m.method === 'chrome.debugger.sendCommand').pop();
assert.deepStrictEqual(sendCommandCall.params[0], { tabId: FAKE_TAB.id });
console.log('✓ session-scoped command routed to the owning tab');

// A browser-scoped command goes through any attached tab.
await command('Storage.getCookies', {});
const browserScoped = received.filter(m => m.method === 'chrome.debugger.sendCommand').pop();
assert.strictEqual(browserScoped.params[1], 'Storage.getCookies');
assert.strictEqual(browserScoped.params[0].tabId, FAKE_TAB.id);
console.log('✓ browser-scoped command routed through an attached tab');

// Unknown CDP methods are forwarded verbatim to the extension.
const forwarded = await command('NotAReal.method', { foo: 1 }, attached.params.sessionId);
assert.deepStrictEqual(forwarded, {});
const forwardedCall = received.filter(m => m.method === 'chrome.debugger.sendCommand').pop();
assert.strictEqual(forwardedCall.params[1], 'NotAReal.method');
console.log('✓ unknown CDP method is forwarded to the extension');

// An error raised by the extension must surface at the CDP client.
await assert.rejects(
  () => command('Page.captureScreenshot', {}, attached.params.sessionId),
  /Screenshots are not supported here/,
);
console.log('✓ extension error surfaces at the CDP client');

relay.stop();
extension.close();
cdp.close();
console.log('\nAll relay tests passed.');

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate())
      return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for condition');
}
