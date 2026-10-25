/**
 * The daemon owns the browser session.
 *
 * A CLI invocation is one-shot, but the Playwright Extension connection is
 * not: the extension keeps a WebSocket open to the relay, and the relay only
 * survives as long as the process holding it. So the connection lives in a
 * long-lived daemon, and CLI invocations talk to it over a unix socket.
 *
 *   pwcli daemon        # internal: starts the relay, opens the connect page
 *   pwcli <command>     # client: sends one tool call to the daemon
 */

import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { log } from './log';
import { isRelayStopped } from './relay/cdpRelay';
import { connectToExtension, createToolClient } from './session';

import type { ExtensionServerOptions } from './session';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export const DEFAULT_CAPABILITIES = ['core', 'pdf', 'storage', 'vision', 'network'];

export function daemonDir(): string {
  return path.join(os.tmpdir(), 'playwright-extension-cli');
}

export function socketPath(): string {
  return path.join(daemonDir(), 'daemon.sock');
}

export function statePath(): string {
  return path.join(daemonDir(), 'daemon.json');
}

export function daemonLogPath(): string {
  return path.join(daemonDir(), 'daemon.log');
}

export type DaemonState = {
  pid: number;
  socketPath: string;
  startedAt: string;
  clientName: string;
};

export type DaemonRequest = {
  id: number;
  type: 'tool' | 'status' | 'disconnect';
  tool?: string;
  arguments?: Record<string, any>;
  cwd?: string;
};

export type DaemonResponse = {
  id: number;
  ok: boolean;
  result?: any;
  error?: string;
};

export type DaemonOptions = ExtensionServerOptions & {
  socketPath?: string;
};

/**
 * Starts the daemon. Resolves once the socket is accepting connections; the
 * extension handshake continues in the background.
 */
/**
 * Checks whether some process is already accepting connections on `socketPath`.
 *
 * A stale socket file (left behind by a crashed daemon) refuses connections;
 * a live one accepts. We must not delete a live daemon's socket out from under
 * it: that daemon would keep the browser attached while becoming unreachable.
 */
function isSocketLive(socketPath: string): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.connect(socketPath);
    let settled = false;
    const done = (live: boolean) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      probe.destroy();
      resolve(live);
    };
    const timer = setTimeout(() => done(false), 500);
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
  });
}

export async function runDaemon(options: DaemonOptions = {}): Promise<void> {
  const socket = options.socketPath ?? socketPath();
  await fs.promises.mkdir(path.dirname(socket), { recursive: true });

  if (await isSocketLive(socket))
    throw new Error(`Another session daemon is already listening on ${socket}. Run \`pwcli disconnect\` first.`);

  // A stale socket file from a crashed daemon would make bind() fail.
  await fs.promises.rm(socket, { force: true });

  let connected = false;
  let session: Awaited<ReturnType<typeof connectToExtension>> | undefined;
  // Assigned right after the socket is bound.
  let sessionPromise: Promise<Awaited<ReturnType<typeof connectToExtension>>> | undefined;
  let clientPromise: Promise<Client> | undefined;

  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim())
          void handleLine(line, socket);
      }
    });
    socket.on('error', error => log.debug('client socket error:', error));
  });

  // Bind before touching the browser. If another daemon already holds the
  // socket we fail here, without having opened a stray connect page in Chrome.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  sessionPromise = connectToExtension(options);
  sessionPromise.catch(error => {
    if (isRelayStopped(error))
      log.debug('Extension connection closed:', (error as Error).message);
    else
      log.error('Extension connection failed:', error);
  });

  sessionPromise.then(value => {
    session = value;
    connected = true;
  }).catch(() => {});

  // The MCP tool layer is wired up over an in-memory transport pair, so the
  // daemon reuses the exact upstream tool implementations without exposing
  // them over stdio.
  clientPromise = sessionPromise.then(async session => {
    const client = await createToolClient(session.context, {
      ...options,
      capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
    });
    log.info('tool layer ready');
    return client;
  });
 
  const state: DaemonState = {
    pid: process.pid,
    socketPath: socket,
    startedAt: new Date().toISOString(),
    clientName: options.clientName ?? 'playwright-extension-cli',
  };
  await fs.promises.writeFile(statePath(), JSON.stringify(state, null, 2));

  log.info(`daemon listening on ${socket} (pid ${process.pid})`);

  const shutdown = async () => {
    server.close();
    await fs.promises.rm(socket, { force: true });
    await fs.promises.rm(statePath(), { force: true });
    // The session may still be waiting for the user to approve the extension
    // in Chrome. Blocking teardown on it would leave the daemon alive forever
    // after SIGTERM, so give it a moment and otherwise just exit.
    const resolved = session ?? await Promise.race([
      sessionPromise?.catch(() => undefined) ?? Promise.resolve(undefined),
      new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 1_000)),
    ]);
    await resolved?.close().catch(() => {});
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  async function handleLine(line: string, clientSocket: net.Socket): Promise<void> {
    let request: DaemonRequest;
    try {
      request = JSON.parse(line);
    } catch (error) {
      clientSocket.write(JSON.stringify({ id: 0, ok: false, error: 'invalid request' }) + '\n');
      return;
    }

    const respond = (response: DaemonResponse) => {
      if (!clientSocket.destroyed)
        clientSocket.write(JSON.stringify(response) + '\n');
    };

    try {
      if (request.type === 'status') {
        // Probe the browser: the extension can go away at any time.
        let pages: string[] = [];
        if (session) {
          try {
            pages = session.context.pages().map(page => page.url());
          } catch {
            connected = false;
          }
        }
        respond({ id: request.id, ok: true, result: { running: true, ...state, connected, pages } });
        return;
      }
      if (request.type === 'disconnect') {
        respond({ id: request.id, ok: true, result: { disconnected: true } });
        await shutdown();
        return;
      }
      if (request.type === 'tool') {
        if (!clientPromise) {
          respond({ id: request.id, ok: false, error: 'The daemon is still starting up.' });
          return;
        }
        const client = await clientPromise;
        // Relative file names are resolved against the workspace root, which
        // for a CLI is the directory the user invoked it from.
        if (request.cwd)
          process.chdir(request.cwd);
        const result = await client.callTool({
          name: request.tool!,
          arguments: request.arguments ?? {},
        });
        respond({ id: request.id, ok: true, result });
        return;
      }
      respond({ id: request.id, ok: false, error: `unknown request type: ${request.type}` });
    } catch (error: any) {
      respond({ id: request.id, ok: false, error: error?.message ?? String(error) });
    }
  }
}
