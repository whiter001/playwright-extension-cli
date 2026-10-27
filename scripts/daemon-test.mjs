/**
 * Browserless tests for session isolation, legacy daemon compatibility and
 * failed-session reporting. Protocol tests use fake daemons; the failure test
 * starts a real daemon with a browser channel that does not exist.
 *
 * Usage: node scripts/daemon-test.mjs
 */

import assert from 'assert';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { socketPath, statePath, daemonLogPath } = require('../dist/daemon.js');
const { identityMismatch, normalizeChannel, normalizeIdentity, samePath } = require('../dist/identity.js');
const { ensureDaemon, daemonStatus, sendRequest, listSessions } = require('../dist/client.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist', 'cli.js');

// ─── 1. every browser gets its own socket ──────────────────────────────

const channels = [
  'chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary',
  'msedge', 'msedge-beta', 'msedge-dev', 'msedge-canary',
  'chromium',
];

const endpoints = new Map();
for (const channel of channels) {
  const endpoint = socketPath(channel);
  assert.ok(!endpoints.has(endpoint), `${channel} reuses the socket of ${endpoints.get(endpoint)}`);
  endpoints.set(endpoint, channel);
}
console.log(`✓ ${channels.length} browser channels map to ${endpoints.size} distinct sockets`);

if (process.platform === 'win32') {
  assert.strictEqual(socketPath('chrome'), '\\\\.\\pipe\\playwright-mcp-cli-daemon');
  assert.strictEqual(socketPath('msedge'), '\\\\.\\pipe\\playwright-mcp-cli-daemon-msedge');
} else {
  assert.strictEqual(socketPath('chrome'), path.join(path.dirname(statePath()), 'daemon.sock'));
  assert.strictEqual(socketPath('msedge'), path.join(path.dirname(statePath()), 'daemon-msedge.sock'));
}
assert.notEqual(statePath('msedge'), statePath('chrome'), 'each channel has its own state file');
assert.notEqual(daemonLogPath('msedge'), daemonLogPath('chrome'), 'each channel has its own log file');
console.log('✓ sockets, state files and logs are namespaced per channel');

// ─── 2. the identity rules ─────────────────────────────────────────────

assert.strictEqual(normalizeChannel('MSEdge'), 'msedge', 'channels are normalized');
assert.strictEqual(normalizeChannel('  Chrome  '), 'chrome', 'channels are trimmed');
assert.strictEqual(normalizeChannel(''), 'chrome', 'an empty channel falls back to chrome');

assert.strictEqual(
  identityMismatch({ browserChannel: 'chrome' }, { browserChannel: 'chrome' }),
  undefined,
  'the same channel matches',
);
assert.match(
  identityMismatch({ browserChannel: 'msedge' }, { browserChannel: 'chrome' }),
  /browser channel is "chrome".*"msedge"/,
  'a different channel is reported',
);
assert.strictEqual(
  identityMismatch({ browserChannel: 'chrome' }, { browserChannel: 'chrome', profileDirName: 'Default' }),
  undefined,
  'an unpinned profile accepts whatever the session uses',
);
assert.match(
  identityMismatch({ browserChannel: 'chrome', profileDirName: 'Profile 1' }, { browserChannel: 'chrome', profileDirName: 'Default' }),
  /profile directory is "Default".*"Profile 1"/,
  'a different profile is reported',
);
assert.strictEqual(
  identityMismatch({ browserChannel: 'chrome', profileDirName: 'Default' }, { browserChannel: 'chrome', profileDirName: 'Default' }),
  undefined,
  'the same profile matches',
);
assert.match(
  identityMismatch({ browserChannel: 'chrome', profileDirName: 'Default' }, { browserChannel: 'chrome' }),
  /channel default/,
  'a pinned profile against a default session is reported',
);
assert.match(
  identityMismatch({ browserChannel: 'chrome', userDataDir: 'C:\\data\\a' }, { browserChannel: 'chrome', userDataDir: 'C:\\data\\b' }),
  /user data directory is "C:\\data\\b"/,
  'a different user data dir is reported',
);
if (process.platform === 'win32') {
  assert.ok(samePath('C:\\Data\\', 'c:\\data'), 'windows paths are compared case insensitively');
  assert.ok(samePath('C:/data/profile', 'C:\\data\\profile'), 'windows separators are equivalent');
  assert.ok(samePath('data/profile', 'data\\profile'), 'relative Windows paths use both separators');
  assert.strictEqual(identityMismatch({ browserChannel: 'chrome', profileDirName: 'default' }, { browserChannel: 'chrome', profileDirName: 'Default' }), undefined, 'Windows profile names are case insensitive');
  assert.ok(!samePath('C:\\', 'C:'), 'a drive root is not a drive-relative path');
} else {
  assert.ok(!samePath('/Data', '/data'), 'POSIX paths are case sensitive');
  assert.ok(!samePath('C:/Data', 'C:/data'), 'drive-like POSIX names remain case sensitive');
  assert.ok(!samePath('/data\\profile', '/data/profile'), 'POSIX backslashes are literal');
  assert.ok(!samePath('/', ''), 'the root is not an empty path');
}
assert.ok(samePath(path.join(root, 'data') + path.sep, path.join(root, 'data')));
assert.ok(samePath(path.join(root, 'data', '..', 'profile'), path.join(root, 'profile')));
const identityA = normalizeIdentity({ browserChannel: 'Chrome', userDataDir: './profile', executablePath: './browser', profileDirName: 'Default' }, path.join(root, 'a'));
const identityB = normalizeIdentity({ browserChannel: 'chrome', userDataDir: './profile' }, path.join(root, 'b'));
assert.strictEqual(identityA.browserChannel, 'chrome');
assert.strictEqual(identityA.userDataDir, path.join(root, 'a', 'profile'));
assert.strictEqual(identityA.executablePath, path.join(root, 'a', 'browser'));
assert.strictEqual(identityA.profileDirName, 'Default');
assert.match(identityMismatch(identityB, identityA), /user data directory/);
console.log('✓ platform path rules and startup-directory identities are respected');

// ─── 3. the client refuses to reuse a mismatched daemon ────────────────

const temp = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'pwcli-'));
const savedTempEnv = Object.fromEntries(['TMP', 'TEMP', 'TMPDIR'].map(name => [name, process.env[name]]));
for (const name of Object.keys(savedTempEnv))
  process.env[name] = temp;
const fakeDaemons = [];
const registryFiles = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cliEnv = { ...process.env };
for (const name of ['PLAYWRIGHT_MCP_BROWSER', 'PLAYWRIGHT_MCP_EXECUTABLE_PATH', 'PLAYWRIGHT_MCP_PROFILE_DIR_NAME'])
  delete cliEnv[name];

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result)
      return result;
    await sleep(25);
  }
  assert.fail(message);
}

async function startFakeDaemon(endpoint, identity, { closeProbe = false } = {}) {
  if (process.platform !== 'win32')
    fs.mkdirSync(path.dirname(endpoint), { recursive: true });
  const sockets = new Set();
  const requests = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim())
          continue;
        const request = JSON.parse(line);
        requests.push(request);
        if (closeProbe) {
          socket.destroy();
          return;
        }
        const result = request.type === 'disconnect' ? { disconnected: true }
          : request.type === 'tool' ? { content: [{ type: 'text', text: 'fake tool result' }] }
          : { running: true, pid: 4242, socketPath: endpoint, startedAt: new Date().toISOString(), clientName: 'fake', identity, connected: true, pages: [] };
        socket.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  const daemon = { server, sockets, requests };
  fakeDaemons.push(daemon);
  return daemon;
}

function fakeEndpoint(name) {
  if (process.platform === 'win32')
    return `\\\\.\\pipe\\pwcli-test-${name}-${process.pid}`;
  return path.join(temp, `${name}.sock`);
}

function runCli(args, { cwd = root, env = cliEnv } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    let timeoutError;
    const timer = setTimeout(() => {
      timeoutError = new Error(`pwcli ${args.join(' ')} timed out\n${stdout}\n${stderr}`);
      child.kill('SIGKILL');
    }, 15_000);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (timeoutError)
        reject(timeoutError);
      else
        resolve({ code, stdout, stderr });
    });
  });
}

let realDaemon;
let realDaemonClosed;
try {
  const chromeEndpoint = fakeEndpoint('chrome');
  const chromeServer = await startFakeDaemon(chromeEndpoint, { browserChannel: 'chrome' });
  for (let i = 0; i < 3; i++) {
    await assert.rejects(
      () => ensureDaemon({ socketPath: chromeEndpoint, expected: { browserChannel: 'msedge' } }),
      /browser channel is "chrome".*"msedge"/,
    );
    await waitUntil(() => chromeServer.sockets.size === 0, 'rejected requests must release all sockets');
  }
  console.log('✓ browser mismatches are rejected without leaking connections');

  const profileEndpoint = fakeEndpoint('profile');
  const profileServer = await startFakeDaemon(profileEndpoint, { browserChannel: 'chrome', profileDirName: 'Default' });
  const profileOptions = { socketPath: profileEndpoint, expected: { browserChannel: 'chrome', profileDirName: 'Profile 1' } };
  await assert.rejects(() => ensureDaemon(profileOptions), /profile directory is "Default".*"Profile 1"/);
  await assert.rejects(() => sendRequest({ type: 'disconnect' }, profileOptions), /profile directory/);
  assert.ok(!profileServer.requests.some(request => request.type === 'disconnect'), 'modern disconnect must still check identity');
  await waitUntil(() => profileServer.sockets.size === 0, 'profile mismatches must release all sockets');
  const matchingSocket = await ensureDaemon({ socketPath: chromeEndpoint, expected: { browserChannel: 'chrome' } });
  matchingSocket.destroy();
  await waitUntil(() => chromeServer.sockets.size === 0, 'matching connection can be closed');
  console.log('✓ profile mismatches are rejected and matching sessions are reused');

  const brokenEndpoint = fakeEndpoint('broken');
  const brokenServer = await startFakeDaemon(brokenEndpoint, { browserChannel: 'chrome' }, { closeProbe: true });
  await assert.rejects(() => ensureDaemon({ socketPath: brokenEndpoint, expected: { browserChannel: 'chrome' } }), /closed the connection/);
  await waitUntil(() => brokenServer.sockets.size === 0, 'failed probes must release the request socket');

  const legacyEndpoint = fakeEndpoint('legacy');
  const legacyServer = await startFakeDaemon(legacyEndpoint, undefined);
  const legacyOptions = { socketPath: legacyEndpoint, expected: { browserChannel: 'chrome' } };
  await assert.rejects(() => ensureDaemon(legacyOptions), /older version of pwcli/);
  await assert.rejects(() => sendRequest({ type: 'tool', tool: 'browser_snapshot' }, legacyOptions), /older version of pwcli/);
  assert.deepStrictEqual(await sendRequest({ type: 'disconnect' }, legacyOptions), { disconnected: true });
  assert.ok(legacyServer.requests.some(request => request.type === 'disconnect'));
  assert.ok(!legacyServer.requests.some(request => request.type === 'tool'));
  await waitUntil(() => legacyServer.sockets.size === 0, 'legacy rejection and disconnect must release sockets');
  console.log('✓ legacy daemons reject tools but accept disconnect for upgrade recovery');

  const legacyChannel = `test-legacy-${process.pid}`;
  const legacyCliEndpoint = process.platform === 'win32' ? socketPath(legacyChannel)
    : path.join(temp, 'playwright-mcp-cli', `daemon-${legacyChannel}.sock`);
  fs.mkdirSync(path.join(temp, 'playwright-mcp-cli'), { recursive: true });
  const legacyCliServer = await startFakeDaemon(legacyCliEndpoint, undefined);
  fs.writeFileSync(path.join(temp, 'playwright-mcp-cli', `daemon-${legacyChannel}.json`), JSON.stringify({ socketPath: legacyCliEndpoint }));
  for (const args of [['status', '--browser', legacyChannel], ['status']]) {
    const result = await runCli(args);
    assert.strictEqual(result.code, 0, result.stderr);
    assert.match(result.stdout, /browser:\s+unknown/);
    assert.match(result.stdout, /log:/);
  }
  const jsonStatus = await runCli(['status', '--json']);
  assert.strictEqual(jsonStatus.code, 0, jsonStatus.stderr);
  assert.strictEqual(JSON.parse(jsonStatus.stdout).length, 1);
  const disconnected = await runCli(['disconnect', '--browser', legacyChannel]);
  assert.strictEqual(disconnected.code, 0, disconnected.stderr);
  assert.ok(legacyCliServer.requests.some(request => request.type === 'disconnect'));
  console.log('✓ real CLI status and disconnect support legacy daemon responses');

  const callerA = path.join(temp, 'a');
  const callerB = path.join(temp, 'b');
  fs.mkdirSync(callerA);
  fs.mkdirSync(callerB);
  const pathChannel = `test-path-${process.pid}`;
  const pathEndpoint = socketPath(pathChannel);
  const pathServer = await startFakeDaemon(pathEndpoint, normalizeIdentity({ browserChannel: pathChannel, userDataDir: './profile' }, callerA));
  const accepted = await runCli(['snapshot', '--browser', pathChannel, '--user-data-dir', './profile'], { cwd: callerA, env: { ...cliEnv, TMP: os.tmpdir(), TEMP: os.tmpdir(), TMPDIR: os.tmpdir() } });
  assert.strictEqual(accepted.code, 0, accepted.stderr);
  assert.match(accepted.stdout, /fake tool result/);
  const toolCount = pathServer.requests.filter(request => request.type === 'tool').length;
  const rejected = await runCli(['snapshot', '--browser', pathChannel, '--user-data-dir', './profile'], { cwd: callerB, env: { ...cliEnv, TMP: os.tmpdir(), TEMP: os.tmpdir(), TMPDIR: os.tmpdir() } });
  assert.strictEqual(rejected.code, 1);
  assert.match(rejected.stderr, /user data directory/);
  assert.strictEqual(pathServer.requests.filter(request => request.type === 'tool').length, toolCount, 'a different directory must never send the tool request');
  console.log('✓ real CLI resolves relative paths in each caller directory before reuse');

  // ─── 4. a failed session must not take the daemon down ────────────────

  const failingChannel = `no-such-browser-${process.pid}`;
  const stateFile = statePath(failingChannel);
  registryFiles.push(stateFile);
  realDaemon = spawn(process.execPath, [cli, 'daemon', '--browser', failingChannel, '--user-data-dir', './profile'], {
    cwd: callerA,
    env: { ...cliEnv, TMP: os.tmpdir(), TEMP: os.tmpdir(), TMPDIR: os.tmpdir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let daemonOutput = '';
  realDaemon.stdout.on('data', data => { daemonOutput += data; });
  realDaemon.stderr.on('data', data => { daemonOutput += data; });
  realDaemonClosed = new Promise(resolve => realDaemon.once('close', resolve));
  let spawnError;
  realDaemon.once('error', error => { spawnError = error; });
  const failed = await waitUntil(async () => {
    assert.ifError(spawnError);
    assert.strictEqual(realDaemon.exitCode, null, daemonOutput);
    const status = await daemonStatus({ expected: { browserChannel: failingChannel } });
    return status.sessionError ? status : undefined;
  }, 'the failed session must report its error');
  assert.ok(failed.running);
  assert.match(failed.sessionError, /no-such-browser/);
  assert.ok(samePath(failed.identity.userDataDir, path.join(callerA, 'profile')), 'daemon records an absolute startup identity');
  await waitUntil(() => {
    try {
      return samePath(JSON.parse(fs.readFileSync(stateFile, 'utf-8')).identity.userDataDir, path.join(callerA, 'profile'));
    } catch {
      return false;
    }
  }, 'the state file must persist the normalized startup identity');
  await sleep(100);
  assert.strictEqual(realDaemon.exitCode, null, daemonOutput);
  assert.ok(!/triggerUncaughtException|unhandled/i.test(daemonOutput), daemonOutput);
  const listed = await listSessions();
  assert.ok(listed.some(status => status.pid === realDaemon.pid), 'failed daemon remains discoverable');
  assert.deepStrictEqual(await sendRequest({ type: 'disconnect' }, { expected: { browserChannel: failingChannel } }), { disconnected: true });
  await waitUntil(() => realDaemon.exitCode !== null || realDaemon.signalCode !== null, 'daemon must exit after disconnect');
  await realDaemonClosed;
  assert.strictEqual(realDaemon.exitCode, 0, daemonOutput);
  assert.ok(!fs.existsSync(stateFile), 'normal shutdown removes the registry file');
  console.log('✓ a real failed daemon retains its normalized identity and shuts down cleanly');
} finally {
  if (realDaemon && realDaemon.exitCode === null && realDaemon.signalCode === null) {
    realDaemon.kill('SIGKILL');
    await waitUntil(() => realDaemon.exitCode !== null || realDaemon.signalCode !== null, 'test daemon must exit after termination');
    await realDaemonClosed;
  }
  await Promise.all(fakeDaemons.map(async ({ server, sockets }) => {
    for (const socket of sockets)
      socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }));
  for (const file of registryFiles)
    fs.rmSync(file, { force: true });
  for (const [name, value] of Object.entries(savedTempEnv)) {
    if (value === undefined)
      delete process.env[name];
    else
      process.env[name] = value;
  }
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('\nSession isolation test passed.');
