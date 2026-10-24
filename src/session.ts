/**
 * Glue between the CDP relay, the upstream MCP tool layer and the CLI.
 *
 * The MCP tool layer is *not* re-implemented here: we reuse the very same
 * bundle that `@playwright/mcp` uses (`playwright-core/lib/coreBundle`),
 * which ships browser_snapshot / browser_click / browser_navigate / ... and
 * the upstream aria-ref snapshot format.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium } from 'playwright-core';

import { log } from './log';
import { CDPRelayServer } from './relay/cdpRelay';
import { VERSION } from './relay/protocol';
import {
  buildConnectUrl,
  findBrowserExecutable,
  openConnectPage,
  resolveExtensionProfile,
} from './relay/chrome';

import type { Browser, BrowserContext } from 'playwright-core';

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
  close: () => Promise<void>;
};

/**
 * Opens the Playwright Extension connect page, waits for the extension to
 * attach, and returns a browser connected over CDP through the relay.
 */
export async function connectToExtension(options: ExtensionServerOptions = {}): Promise<ExtensionSession> {
  const channel = options.browserChannel ?? 'chrome';
  const clientName = options.clientName ?? 'playwright-mcp-cli';

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

  const relay = new CDPRelayServer({
    protocolVersion: VERSION,
    token: options.token,
    // With a token the extension either connects or rejects the token
    // outright, so waiting forever would hide the failure. Without a token
    // the user has to approve the connection manually — that can take
    // arbitrarily long.
    connectTimeoutMs: options.connectTimeoutMs ?? (options.token ? 30_000 : 0),
  });
  await relay.start();

  const connectUrl = buildConnectUrl({
    relayUrl: relay.extensionEndpoint(),
    clientName,
    protocolVersion: VERSION,
    token: options.token,
  });
  log.info(`Opening the Playwright Extension connect page for "${clientName}"...`);
  openConnectPage({ executablePath, userDataDir, profileDirectory, channel, url: connectUrl });

  try {
    await relay.establishExtensionConnection();
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
      close: async () => {
        relay.stop();
        await browser.close().catch(() => {});
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

  const client = new Client({ name: options.clientName ?? 'playwright-mcp-cli', version: '1.0.0' }, { capabilities: {} });
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
  session.catch(error => log.error('Extension connection failed:', error));

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
