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

import { daemonLogPath, socketPath } from './daemon';

import type { DaemonRequest, DaemonResponse } from './daemon';

export type SendOptions = {
  /** Arguments forwarded to the daemon when it has to be started. */
  daemonArgs?: string[];
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

function spawnDaemon(args: string[]): void {
  fs.mkdirSync(path.dirname(daemonLogPath()), { recursive: true });
  const logFd = fs.openSync(daemonLogPath(), 'a');
  const child = spawn(process.execPath, [cliEntry(), 'daemon', ...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();
}

export async function ensureDaemon(options: SendOptions = {}): Promise<net.Socket> {
  const path = socketPath();
  const existing = await tryConnect(path, 500);
  if (existing)
    return existing;

  spawnDaemon(options.daemonArgs ?? []);

  const deadline = Date.now() + (options.startTimeoutMs ?? 20_000);
  while (Date.now() < deadline) {
    await sleep(200);
    const socket = await tryConnect(path, 500);
    if (socket)
      return socket;
  }
  throw new Error(`The daemon did not start in time. See ${daemonLogPath()}`);
}

/**
 * Sends one newline-delimited request and waits for the newline-delimited
 * response.
 *
 * Every way the connection can end must settle the promise: a daemon that is
 * killed closes the socket with a normal FIN, which emits `close` but no
 * `error` — without a `close` handler the CLI would hang forever.
 */
function roundTrip(socket: net.Socket, payload: object): Promise<any> {
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
      `The daemon closed the connection unexpectedly. See ${daemonLogPath()}`
    ))));
    socket.write(JSON.stringify(payload) + '\n');
  });
}

export async function sendRequest(
  request: Omit<DaemonRequest, 'id'>,
  options: SendOptions = {},
): Promise<any> {
  const socket = await ensureDaemon(options);
  return await roundTrip(socket, { ...request, id: 1 });
}

export async function daemonStatus(options: SendOptions = {}): Promise<any> {
  const socket = await tryConnect(socketPath(), 500);
  if (!socket)
    return { running: false };
  return await roundTrip(socket, { id: 1, type: 'status' });
}
