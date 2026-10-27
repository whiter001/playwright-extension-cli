/**
 * Client side of the daemon protocol.
 *
 * Every CLI invocation connects to the daemon over a unix socket, asks it to
 * run one tool call, and prints the result. If no daemon is running, one is
 * started in the background — the extension handshake then happens once, not
 * once per command.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

import { daemonLogPath, legacySocketPath, socketPath, statePaths } from './daemon';
import { disconnectHint, identityMismatch, normalizeChannel, normalizeIdentity } from './identity';

import type { DaemonRequest, DaemonResponse } from './daemon';
import type { SessionIdentity } from './identity';

export type SendOptions = {
  /** Arguments forwarded to the daemon when it has to be started. */
  daemonArgs?: string[];
  /**
   * What the caller expects to drive.
   *
   * A running daemon is only reused when it serves the same session, so a
   * mismatched browser or profile is reported instead of silently taking over
   * a session that belongs to somebody else.
   */
  expected?: SessionIdentity;
  /**
   * Connects to this daemon instead of the one that belongs to the channel.
   * Mostly useful for tests and for talking to a daemon that was started
   * with a custom socket.
   */
  socketPath?: string;
  /** How long to wait for the daemon to come up. */
  startTimeoutMs?: number;
};

function cliEntry(): string {
  const candidates = [
    path.join(__dirname, 'cli.js'),
    path.join(__dirname, '..', 'dist', 'cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate))
      return candidate;
  }
  return candidates[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tryConnect(path: string, timeoutMs: number): Promise<net.Socket | undefined> {
  return new Promise(resolve => {
    const socket = net.connect(path);
    let settled = false;
    const fail = () => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(undefined);
    };
    const timer = setTimeout(fail, timeoutMs);
    socket.once('error', fail);
    socket.once('connect', () => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('error', fail);
      resolve(socket);
    });
  });
}

function spawnDaemon(args: string[], channel: string): void {
  const logPath = daemonLogPath(channel);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, [cliEntry(), 'daemon', ...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();
}

/** The browser channel a request targets. */
function channelOf(options: SendOptions): string {
  return normalizeChannel(options.expected?.browserChannel);
}

/**
 * Checks that the daemon behind the socket serves the session the caller wants.
 *
 * The probe uses its own connection: a socket carries exactly one request.
 *
 * `allowLegacy` accepts a daemon that was started by an older release and
 * therefore does not report an identity. Only the disconnect command may use
 * it — every other command has to know which browser it is about to drive.
 */
async function assertSameSession(
  socket: string,
  expected: SessionIdentity | undefined,
  allowLegacy = false,
): Promise<void> {
  if (!expected)
    return;
  const probe = await tryConnect(socket, 500);
  if (!probe)
    throw new Error('The session daemon went away while it was being checked.');
  let status: any;
  try {
    status = await roundTrip(probe, { id: 1, type: 'status' }, normalizeChannel(expected.browserChannel));
  } finally {
    probe.destroy();
  }
  const actual: SessionIdentity | undefined = status?.identity;
  if (!actual) {
    if (allowLegacy)
      return;
    throw new Error(
      'The running session daemon does not report which browser it drives — it was started by an older ' +
      `version of pwcli. Run \`${disconnectHint(expected.browserChannel)}\` and connect again.`,
    );
  }
  const mismatch = identityMismatch(expected, actual);
  if (mismatch) {
    const channel = normalizeChannel(actual.browserChannel);
    throw new Error(
      `A "${channel}" session is already running with a different configuration: ${mismatch}. ` +
      `Run \`${disconnectHint(channel)}\` to end it first, or start the session with the options it already uses.`,
    );
  }
}

/**
 * Opens the request connection and checks the session behind it.
 *
 * A failed check destroys the socket: the caller never gets it, and a socket
 * that is left open would keep the daemon waiting for a request that never
 * comes.
 */
async function connectChecked(
  endpoint: string,
  expected: SessionIdentity | undefined,
  allowLegacy: boolean,
): Promise<net.Socket | undefined> {
  const socket = await tryConnect(endpoint, 500);
  if (!socket)
    return undefined;
  // The daemon may close the connection while it is being probed, and an
  // error without a listener would take the whole client down.
  socket.on('error', () => {});
  try {
    await assertSameSession(endpoint, expected, allowLegacy);
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return socket;
}

/**
 * Connects to the daemon of a channel, starting one when none is running.
 *
 * `allowLegacy` is only meant for the disconnect command: it accepts a daemon
 * from an older release that does not report its identity.
 */
async function ensureDaemonConnection(options: SendOptions, allowLegacy: boolean): Promise<net.Socket> {
  // The identity is normalized before the first await: the working directory
  // is captured here, so the paths do not depend on when the daemon answers.
  const cwd = process.cwd();
  const expected = options.expected ? normalizeIdentity(options.expected, cwd) : undefined;
  const channel = channelOf(options);
  const endpoint = options.socketPath ?? socketPath(channel);

  const existing = await connectChecked(endpoint, expected, allowLegacy);
  if (existing)
    return existing;
  if (options.socketPath === undefined && process.platform !== 'win32') {
    const legacy = await connectChecked(legacySocketPath(channel), expected, allowLegacy);
    if (legacy)
      return legacy;
  }

  spawnDaemon(options.daemonArgs ?? [], channel);

  const deadline = Date.now() + (options.startTimeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    await sleep(200);
    const started = await connectChecked(endpoint, expected, allowLegacy);
    if (started)
      return started;
  }
  throw new Error(`The daemon did not start in time. See ${daemonLogPath(channel)}`);
}

export async function ensureDaemon(options: SendOptions = {}): Promise<net.Socket> {
  return await ensureDaemonConnection(options, false);
}

/**
 * Sends one newline-delimited request and waits for the newline-delimited
 * response.
 *
 * Every way the connection can end must settle the promise: a daemon that is
 * killed closes the socket with a normal FIN, which emits `close` but no
 * `error` — without a `close` handler the CLI would hang forever.
 */
function roundTrip(socket: net.Socket, payload: object, channel = 'chrome'): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;

    const settle = (action: () => void) => {
      if (settled)
        return;
      settled = true;
      action();
    };

    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      const index = buffer.indexOf('\n');
      if (index === -1)
        return;
      let response: DaemonResponse;
      try {
        response = JSON.parse(buffer.slice(0, index));
      } catch (error: any) {
        socket.end();
        settle(() => reject(new Error(`Malformed response from the daemon: ${error?.message ?? error}`)));
        return;
      }
      socket.end();
      settle(() => {
        if (response.ok)
          resolve(response.result);
        else
          reject(new Error(response.error ?? 'Unknown daemon error'));
      });
    });
    socket.on('error', error => settle(() => reject(error)));
    socket.on('close', () => settle(() => reject(new Error(
      `The daemon closed the connection unexpectedly. See ${daemonLogPath(channel)}`
    ))));
    socket.write(JSON.stringify(payload) + '\n');
  });
}

export async function sendRequest(
  request: Omit<DaemonRequest, 'id'>,
  options: SendOptions = {},
): Promise<any> {
  // Only the disconnect command may talk to a daemon that does not report its
  // identity: every other command has to know which browser it drives.
  const socket = request.type === 'disconnect'
    ? await ensureDaemonConnection(options, true)
    : await ensureDaemon(options);
  return await roundTrip(socket, { ...request, id: 1 }, channelOf(options));
}

export async function daemonStatus(options: SendOptions = {}): Promise<any> {
  const channel = channelOf(options);
  let socket = await tryConnect(options.socketPath ?? socketPath(channel), 500);
  if (!socket && options.socketPath === undefined && process.platform !== 'win32')
    socket = await tryConnect(legacySocketPath(channel), 500);
  if (!socket)
    return { running: false };
  return await roundTrip(socket, { id: 1, type: 'status' }, channel);
}

/**
 * The status of every session that is currently running.
 *
 * Sessions are isolated per browser, so more than one can be alive at the
 * same time. The state files tell us which daemons to ask; the socket probe
 * tells us which of them are still there.
 */
export async function listSessions(): Promise<any[]> {
  const sessions: any[] = [];
  for (const file of statePaths()) {
    let state: any;
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue;
    }
    const socket = state?.socketPath;
    if (!socket)
      continue;
    const connection = await tryConnect(socket, 300);
    if (!connection)
      continue;
    try {
      sessions.push(await roundTrip(connection, { id: 1, type: 'status' }, normalizeChannel(state?.identity?.browserChannel)));
    } catch {
      // The daemon died between the probe and the request.
    }
  }
  return sessions;
}
