/**
 * Glue between the CDP relay, the upstream MCP tool layer and the CLI.
 *
 * The MCP tool layer is *not* re-implemented here: we reuse the very same
 * bundle that `@playwright/mcp` uses (`playwright-core/lib/coreBundle`),
 * which ships browser_snapshot / browser_click / browser_navigate / ... and
 * the upstream aria-ref snapshot format.
 */

import { spawn } from 'child_process';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium } from 'playwright-core';

import { log } from './log';
import { isRelayStopped, CDPRelayServer } from './relay/cdpRelay';
import { VERSION } from './relay/protocol';
import {
  buildConnectUrl,
  findBrowserExecutable,
  macAppNameForExecutable,
  openConnectPage,
  readExtensionToken,
  resolveExtensionProfile,
  spawnDetached,
} from './relay/chrome';

import type { Browser, BrowserContext } from 'playwright-core';
import type { ResolvedSessionIdentity } from './identity';

// `playwright-core/lib/coreBundle` is the same bundle @playwright/mcp exposes
// as `createConnection`. It is an internal path, hence the explicit require.
const { tools } = require('playwright-core/lib/coreBundle') as {
  tools: {
    createConnection: (config?: any, contextGetter?: () => Promise<BrowserContext>) => Promise<any>;
  };
};

export type ExtensionServerOptions = {
  /** Browser channel used to find the executable and the profile dir. */
  browserChannel?: string;
  /** Explicit browser executable path. */
  executablePath?: string;
  /** Custom user data dir (browsers "User Data" folder). */
  userDataDir?: string;
  /** Chrome profile directory name, e.g. "Default" or "Profile 1". */
  profileDirName?: string;
  /** Extension auth token — skips the manual approval dialog. */
  token?: string;
  /** Name shown in the extension UI / tab group. */
  clientName?: string;
  /** Extra tool capabilities on top of the always-on `core` set. */
  capabilities?: string[];
  /** Directory for automatically named output files (screenshots, pdfs). */
  outputDir?: string;
  /** How long to wait for the extension to connect. 0 = wait forever. */
  connectTimeoutMs?: number;
};

export type ExtensionSession = {
  browser: Browser;
  context: BrowserContext;
  relay: CDPRelayServer;
  /** What this session ended up driving, once the paths are resolved. */
  identity: ResolvedSessionIdentity;
  close: () => Promise<void>;
};

/**
 * Resolves the extension auth token.
 *
 * Precedence:
 *   1. `--token <value>` — explicit; `--token ""` forces "no token"
 *   2. the token stored in the browser profile (auto-discovered)
 *   3. `PLAYWRIGHT_MCP_EXTENSION_TOKEN`
 *   4. none — the user approves the connection manually
 *
 * The profile wins over the environment variable because the environment
 * value is a copy that goes stale as soon as the extension is reinstalled or
 * the profile is reset.
 */
async function resolveToken(
  options: ExtensionServerOptions,
  userDataDir: string | undefined,
  profileDirectory: string | undefined,
): Promise<string | undefined> {
  if (options.token !== undefined) {
    log.info(options.token ? 'Using the token passed on the command line.' : 'Token explicitly disabled.');
    return options.token || undefined;
  }

  if (userDataDir && profileDirectory) {
    const discovered = await readExtensionToken(path.join(userDataDir, profileDirectory));
    if (discovered) {
      log.info('Using the extension token discovered in the browser profile.');
      return discovered;
    }
  }

  const fromEnv = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  if (fromEnv) {
    log.info('Using PLAYWRIGHT_MCP_EXTENSION_TOKEN from the environment.');
    return fromEnv;
  }

  log.info('No token — approve the connection in the browser.');
  return undefined;
}

/**
 * Waits for the extension to attach.
 *
 * The connect page is opened by spawning the browser executable. When another
 * browser instance is already running, the URL is handed over to it — and if
 * that hand-over fails (another instance with a different profile eats the
 * command line), the page never shows up. In that case we retry through the
 * OS handler, which targets the browser that is actually running.
 */
async function establishWithFallback(
  relay: CDPRelayServer,
  connectUrl: string,
  options: ExtensionServerOptions,
  executablePath: string,
): Promise<void> {
  const firstAttemptMs = 8_000;
  try {
    await relay.establishExtensionConnection(firstAttemptMs);
    return;
  } catch (error) {
    log.warn('The extension did not connect yet; retrying through the system handler.');
    openConnectPageViaSystem(connectUrl, executablePath);
    // Pass the value through untouched: `undefined` lets the relay apply its
    // own default (30s with a token, wait forever without one). Substituting 0
    // here would disable that guard and hang forever on a bad token.
    await relay.establishExtensionConnection(options.connectTimeoutMs);
  }
}

/**
 * Opens the connect page through the OS handler, for the case where handing
 * the URL to an already running browser instance does not work.
 *
 * The browser matters: a `chrome-extension://` page only loads in the browser
 * that has the extension installed, so we derive the macOS application name
 * from the executable we resolved rather than assuming Chrome.
 */
function openConnectPageViaSystem(url: string, executablePath: string): void {
  if (process.platform === 'darwin') {
    const appName = macAppNameForExecutable(executablePath);
    if (appName)
      spawnDetached('/usr/bin/open', ['-a', appName, url]);
    else
      spawnDetached('/usr/bin/open', [url]);
  } else if (process.platform === 'win32') {
    spawnDetached('cmd', ['/c', 'start', '""', url]);
  } else {
    spawnDetached('xdg-open', [url]);
  }
}

/**
 * Opens the Playwright Extension connect page, waits for the extension to
 * attach, and returns a browser connected over CDP through the relay.
 */
export async function connectToExtension(options: ExtensionServerOptions = {}): Promise<ExtensionSession> {
  const channel = options.browserChannel ?? 'chrome';
  const clientName = options.clientName ?? 'playwright-extension-cli';

  // The *user supplied* executable path disables profile detection (the local
  // profile layout may not apply), but the discovered one is what we spawn.
  const userExecutablePath = options.executablePath;
  const executablePath = userExecutablePath ?? findBrowserExecutable(channel);
  if (!executablePath) {
    throw new Error(
      `Could not find a "${channel}" executable. Install ${channel} or pass --executable-path.`
    );
  }

  const { userDataDir, profileDirectory } = await resolveExtensionProfile({
    channel,
    executablePath: userExecutablePath,
    customUserDataDir: options.userDataDir,
    profileDirName: options.profileDirName,
  });
  log.info(`Using ${channel} profile "${profileDirectory ?? '(default)'}"${userDataDir ? ` in ${userDataDir}` : ''}`);

  const token = await resolveToken(options, userDataDir, profileDirectory);
  const relay = new CDPRelayServer({
    protocolVersion: VERSION,
    token,
    // With a token the extension either connects or rejects the token
    // outright, so waiting forever would hide the failure. Without a token
    // the user has to approve the connection manually — that can take
    // arbitrarily long.
    connectTimeoutMs: options.connectTimeoutMs ?? (token ? 30_000 : 0),
  });
  await relay.start();

  const connectUrl = buildConnectUrl({
    relayUrl: relay.extensionEndpoint(),
    clientName,
    protocolVersion: VERSION,
    token,
  });
  log.info(`Opening the Playwright Extension connect page for "${clientName}"...`);
  openConnectPage({ executablePath, userDataDir, profileDirectory, channel, url: connectUrl });

  try {
    await establishWithFallback(relay, connectUrl, options, executablePath);
    const browser = await chromium.connectOverCDP(relay.cdpEndpoint(), {
      // The relay lives on the same host, so skip proxy handling.
      isLocal: true,
      // The extension may take a while to hand over the first tab.
      timeout: 0,
      // Do not override the user's daily-driver browser defaults.
      noDefaults: true,
    } as any);
    browser.on('disconnected', () => relay.stop());

    const context = browser.contexts()[0];
    if (!context)
      throw new Error('The extension did not expose a browser context.');

    return {
      browser,
      context,
      relay,
      identity: {
        browserChannel: channel,
        executablePath,
        userDataDir,
        profileDirectory,
      },
      // NOTE: never call browser.close() here. On a CDP-attached browser that
      // closes the *user's* tabs (Playwright closes every page of the default
      // context before disconnecting). Dropping the relay is enough: the
      // extension sees the socket close, detaches the debugger and cleans up
      // its tab group.
      close: async () => {
        relay.stop();
      },
    };
  } catch (error) {
    relay.stop();
    throw error;
  }
}

/**
 * Wires the upstream MCP tool layer to an already connected browser context
 * and returns a client that can call the tools.
 */
export async function createToolClient(
  context: BrowserContext,
  options: ExtensionServerOptions = {},
): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = await tools.createConnection({
    // Tells the config resolver to keep the attached (non-isolated) context.
    extension: true,
    capabilities: options.capabilities,
    outputDir: options.outputDir,
    browser: { isolated: false },
  }, async () => context);
  await server.connect(serverTransport);

  const client = new Client({ name: options.clientName ?? 'playwright-extension-cli', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

export type RunningServer = {
  /** Resolves once the extension is attached and the browser is usable. */
  session: Promise<ExtensionSession>;
};

/**
 * Serves the upstream Playwright MCP tool set over stdio.
 *
 * The extension handshake starts in the background so that the MCP transport
 * is up immediately; the first tool call waits for the extension to attach.
 */
export async function startStdioServer(options: ExtensionServerOptions = {}): Promise<RunningServer> {
  const session = connectToExtension(options);
  session.catch(error => {
    if (isRelayStopped(error))
      log.debug('Extension connection closed:', (error as Error).message);
    else
      log.error('Extension connection failed:', error);
  });

  const config = {
    extension: true,
    capabilities: options.capabilities,
    outputDir: options.outputDir,
    browser: { isolated: false },
  };

  const server = await tools.createConnection(config, async () => {
    const { context } = await session;
    return context;
  });
  await server.connect(new StdioServerTransport());
  log.info('MCP server ready on stdio.');

  return { session };
}
