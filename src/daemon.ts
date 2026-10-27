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
import { disconnectHint, normalizeChannel, normalizeIdentity } from './identity';

import type { ExtensionServerOptions } from './session';
import type { SessionIdentity } from './identity';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export const DEFAULT_CAPABILITIES = ['core', 'pdf', 'storage', 'vision', 'network'];

export function daemonDir(): string {
  return path.join(os.tmpdir(), 'playwright-extension-cli');
}

/**
 * True when the path lives in the Windows pipe namespace.
 *
 * Windows has no unix domain sockets: Node maps a path to a named pipe, and a
 * path with a drive letter and backslashes is not a valid pipe name, so
 * `bind()` fails with EACCES. The daemon therefore uses an explicit pipe name
 * there and a real socket file everywhere else.
 */
function isWindowsPipe(target: string): boolean {
  return process.platform === 'win32' && target.startsWith('\\\\.\\pipe\\');
}

/**
 * The socket of a browser channel.
 *
 * Sessions are isolated per browser: a Chrome session and an Edge session use
 * different sockets and therefore different daemons, so two agents can drive
 * two browsers at the same time.
 *
 * Chrome keeps the historical name so that a daemon started by an older
 * release stays reachable instead of being orphaned on a pipe nobody looks at
 * any more. Every other channel gets its own name.
 */
export function socketPath(channel: string = 'chrome'): string {
  const namespace = normalizeChannel(channel);
  if (namespace === 'chrome') {
    if (process.platform === 'win32')
      return '\\\\.\\pipe\\playwright-mcp-cli-daemon';
    return path.join(daemonDir(), 'daemon.sock');
  }
  if (process.platform === 'win32')
    return `\\\\.\\pipe\\playwright-mcp-cli-daemon-${namespace}`;
  return path.join(daemonDir(), `daemon-${namespace}.sock`);
}

export function legacySocketPath(channel: string = 'chrome'): string {
  const namespace = normalizeChannel(channel);
  if (process.platform === 'win32')
    return socketPath(namespace);
  return path.join(os.tmpdir(), 'playwright-mcp-cli', namespace === 'chrome' ? 'daemon.sock' : `daemon-${namespace}.sock`);
}

export function statePath(channel: string = 'chrome'): string {
  const namespace = normalizeChannel(channel);
  return path.join(daemonDir(), namespace === 'chrome' ? 'daemon.json' : `daemon-${namespace}.json`);
}

export function daemonLogPath(channel: string = 'chrome'): string {
  const namespace = normalizeChannel(channel);
  return path.join(daemonDir(), namespace === 'chrome' ? 'daemon.log' : `daemon-${namespace}.log`);
}

/**
 * The state files of all sessions that are currently registered.
 *
 * The state file is written when a daemon starts and removed when it stops,
 * so the directory listing is the list of sessions that may still be alive.
 */
export function statePaths(): string[] {
  const paths: string[] = [];
  const directories = [daemonDir(), path.join(os.tmpdir(), 'playwright-mcp-cli')];
  for (const directory of directories) {
    let entries: string[];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      continue;
    }
    paths.push(...entries
      .filter(entry => /^daemon(?:-[a-z0-9._-]+)?\.json$/i.test(entry))
      .map(entry => path.join(directory, entry)));
  }
  return paths;
}

/**
 * Masks the auth token in a URL.
 *
 * The extension's connect page carries the token in its query string, and the
 * status output is the kind of thing people paste into bug reports — so the
 * token never leaves the daemon in clear text.
 */
export function redactToken(url: string): string {
  return url.replace(/([?&]token=)[^&]*/i, '$1<redacted>');
}

export type DaemonState = {
  pid: number;
  socketPath: string;
  startedAt: string;
  clientName: string;
  /**
   * What this session drives. Clients compare it against their own request
   * before reusing the daemon, so a mismatched session is reported instead of
   * silently driving the wrong browser or profile.
   */
  identity: SessionIdentity;
  /** Profile the session actually attached to, known once the extension is up. */
  profileDirectory?: string;
  /** Why the session failed, when it did. */
  sessionError?: string;
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
  // The identity is normalized before the first await: the paths that are
  // recorded and the paths that are opened have to be the same ones.
  const identity = normalizeIdentity({
    browserChannel: options.browserChannel ?? 'chrome',
    executablePath: options.executablePath,
    userDataDir: options.userDataDir,
    profileDirName: options.profileDirName,
  });
  const channel = identity.browserChannel;
  const socket = options.socketPath ?? socketPath(channel);
  const isPipe = isWindowsPipe(socket);
  // The state and log files live in the temp directory; the socket itself may
  // live in the pipe namespace, which is not a directory we can create.
  await fs.promises.mkdir(daemonDir(), { recursive: true });
  if (!isPipe)
    await fs.promises.mkdir(path.dirname(socket), { recursive: true });

  if (await isSocketLive(socket))
    throw new Error(`Another "${channel}" session daemon is already listening on ${socket}. Run \`${disconnectHint(channel)}\` first.`);

  // A stale socket file from a crashed daemon would make bind() fail.
  if (!isPipe)
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

  const state: DaemonState = {
    pid: process.pid,
    socketPath: socket,
    startedAt: new Date().toISOString(),
    clientName: options.clientName ?? 'playwright-extension-cli',
    identity,
  };
  const stateFile = statePath(channel);
  const writeState = async () => {
    await fs.promises.writeFile(stateFile, JSON.stringify(state, null, 2));
  };
  await writeState();

  sessionPromise = connectToExtension({
    ...options,
    browserChannel: identity.browserChannel,
    executablePath: identity.executablePath,
    userDataDir: identity.userDataDir,
    profileDirName: identity.profileDirName,
  });
  sessionPromise.catch(error => {
    if (isRelayStopped(error)) {
      log.debug('Extension connection closed:', (error as Error).message);
    } else {
      // Remember the reason: "waiting for approval" would be a lie here.
      state.sessionError = (error as Error)?.message ?? String(error);
      log.error('Extension connection failed:', error);
    }
    void writeState();
  });

  sessionPromise.then(value => {
    session = value;
    connected = true;
    // The profile the session actually attached to is only known now.
    state.profileDirectory = value.identity.profileDirectory;
    void writeState();
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
  // The promise is only awaited when a tool request comes in, so a failed
  // session would otherwise reject it with nobody listening — and Node turns
  // that into an unhandled rejection, taking the whole daemon down.
  void clientPromise.catch(() => {});

  log.info(`daemon listening on ${socket} (pid ${process.pid})`);

  const shutdown = async () => {
    server.close();
    // A named pipe disappears with the process that owns it.
    if (!isPipe)
      await fs.promises.rm(socket, { force: true });
    await fs.promises.rm(stateFile, { force: true });
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
            pages = session.context.pages().map(page => redactToken(page.url()));
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
