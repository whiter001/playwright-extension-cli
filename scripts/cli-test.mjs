/**
 * End-to-end test of the CLI itself: runs `pwcli` as a real command line
 * tool, against the isolated Chrome instance that has the Playwright
 * Extension installed.
 *
 * The "Allow & select" click is done over CDP, so no human is needed.
 *
 * Prerequisites: scripts/setup-test-chrome.sh has been run.
 *
 * Usage: node scripts/cli-test.mjs
 */

import assert from 'assert';
import { execFileSync, spawn } from 'child_process';
import http from 'http';

import { WebSocket } from 'ws';

const CHROME_DEBUG_PORT = 9333;
const PROFILE = '/tmp/pw-test-profile';

function runCli(args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli.js', ...args], {
      cwd: process.cwd(),
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`pwcli ${args.join(' ')} timed out\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function chromeTargets() {
  const response = await fetch(`http://127.0.0.1:${CHROME_DEBUG_PORT}/json/list`);
  return await response.json();
}

async function cdpEval(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  const value = await new Promise((resolve, reject) => {
    ws.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.id === 1) {
        ws.close();
        message.error ? reject(new Error(message.error.message)) : resolve(message.result?.result?.value);
      }
    });
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
    setTimeout(() => reject(new Error('CDP evaluate timed out')), 10_000);
  });
  return value;
}

async function approveExtensionConnection() {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    const targets = await chromeTargets();
    target = targets.find(t => t.type === 'page' && (t.url || '').includes('connect.html'));
    if (!target)
      await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(target, 'the extension connect page never appeared');
  for (let i = 0; i < 40; i++) {
    const clicked = await cdpEval(target, `(() => {
      const buttons = [...document.querySelectorAll('button')].filter(b => /allow/i.test(b.textContent));
      if (!buttons.length) return 'no-allow-button';
      let button = buttons[0];
      for (const b of buttons) {
        const row = b.closest('li') || b.parentElement;
        if (row && row.textContent.includes('example.com')) { button = b; break; }
      }
      button.click();
      return 'clicked';
    })()`);
    if (String(clicked).startsWith('clicked'))
      return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('could not click "Allow & select"');
}

// ─── 0. make sure we start from a clean slate ─────────────────────────

await runCli(['disconnect']).catch(() => {});
await new Promise(resolve => setTimeout(resolve, 1000));

// ─── 1. no session yet ────────────────────────────────────────────────

const statusBefore = await runCli(['status']);
assert.match(statusBefore.stdout, /no session/, 'status should report no session');
console.log('✓ status reports no session');

// ─── 2. a command starts the daemon and waits for the approval ────────

const navigate = runCli(['navigate', 'https://example.com', '--user-data-dir', PROFILE, '--token', ''], { timeoutMs: 180_000 });
await new Promise(resolve => setTimeout(resolve, 2500));
await approveExtensionConnection();
const navigated = await navigate;
assert.strictEqual(navigated.code, 0, `navigate failed:\n${navigated.stdout}\n${navigated.stderr}`);
assert.match(navigated.stdout, /example\.com/, 'navigate should report the page url');
console.log('✓ navigate drove the browser through the extension');

// ─── 3. the session survives across invocations ───────────────────────

const snapshot = await runCli(['snapshot', '--user-data-dir', PROFILE, '--token', '']);
assert.strictEqual(snapshot.code, 0, `snapshot failed:\n${snapshot.stderr}`);
assert.match(snapshot.stdout, /ref=/, 'snapshot should contain aria refs');
console.log('✓ snapshot reuses the running session');

// ─── 4. more commands ─────────────────────────────────────────────────

const tabs = await runCli(['tabs', '--user-data-dir', PROFILE, '--token', '']);
assert.strictEqual(tabs.code, 0, `tabs failed:\n${tabs.stderr}`);
assert.match(tabs.stdout, /example\.com/, 'tabs should list the page');
console.log('✓ tabs lists the connected page');

const evalResult = await runCli(['eval', '() => document.title', '--user-data-dir', PROFILE, '--token', '']);
assert.strictEqual(evalResult.code, 0, `eval failed:\n${evalResult.stderr}`);
assert.match(evalResult.stdout, /Example Domain/, 'eval should return the page title');
console.log('✓ eval returns page data');

const jsonResult = await runCli(['eval', '() => 1 + 1', '--json', '--user-data-dir', PROFILE, '--token', '']);
const parsed = JSON.parse(jsonResult.stdout);
assert.ok(parsed.content?.length, '--json should return the raw tool result');
console.log('✓ --json returns the raw tool result');

// ─── 4b. fill regression: browser_fill_form needs name and type ──────

// A local page: Chrome refuses top-level `data:` navigation, so serve the
// form over HTTP instead.
const formServer = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>form</title><input id="a"><input id="b">');
});
await new Promise(resolve => formServer.listen(0, '127.0.0.1', resolve));
const formUrl = `http://127.0.0.1:${formServer.address().port}/`;

const formNav = await runCli(['navigate', formUrl, '--user-data-dir', PROFILE, '--token', '']);
assert.strictEqual(formNav.code, 0, `navigate to the form failed:\n${formNav.stdout}\n${formNav.stderr}`);

const filled = await runCli(['fill', '#a=hello', '#b=world', '--user-data-dir', PROFILE, '--token', '']);
assert.strictEqual(filled.code, 0, `fill failed:\n${filled.stdout}\n${filled.stderr}`);

const readback = await runCli([
  'eval', '() => [...document.querySelectorAll("input")].map(i => i.value).join(",")',
  '--user-data-dir', PROFILE, '--token', '',
]);
assert.match(readback.stdout, /hello,world/, `fill did not reach the inputs:\n${readback.stdout}`);
console.log('✓ fill writes into the form fields');
formServer.close();

// ─── 5. status and disconnect ─────────────────────────────────────────

const statusAfter = await runCli(['status']);
assert.match(statusAfter.stdout, /running:\s+yes/, 'status should report the session');
assert.match(statusAfter.stdout, /extension:\s+connected/, 'status should report the extension');
console.log('✓ status reports the live session');

const disconnect = await runCli(['disconnect', '--user-data-dir', PROFILE, '--token', '']);
assert.strictEqual(disconnect.code, 0, `disconnect failed:\n${disconnect.stderr}`);

await new Promise(resolve => setTimeout(resolve, 1000));
const statusFinal = await runCli(['status']);
assert.match(statusFinal.stdout, /no session/, 'the session should be gone after disconnect');
console.log('✓ disconnect tears the session down');

console.log('\nCLI end-to-end test passed.');
teardown();
process.exit(0);

/**
 * Kills the isolated Chrome instance. A second Chrome instance with a
 * different --user-data-dir hijacks the command line hand-over on macOS,
 * which breaks URL opening in the user's own browser.
 */
function teardown() {
  try {
    execFileSync('pkill', ['-f', `user-data-dir=${PROFILE}`]);
  } catch {
    // nothing to kill
  }
}
