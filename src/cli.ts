#!/usr/bin/env node
/**
 * Copyright (c) Microsoft Corporation.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'fs';
import path from 'path';

import { log, setLogLevel } from './log';
import {
  defaultUserDataDirForChannel,
  findBrowserExecutable,
  findPlaywrightExtensionProfile,
  isExtensionInstalledInProfile,
  playwrightExtensionId,
  playwrightExtensionInstallUrl,
} from './relay/chrome';
import { startStdioServer } from './server';

import type { LogLevel } from './log';

type Options = {
  browserChannel?: string;
  executablePath?: string;
  userDataDir?: string;
  profileDirName?: string;
  token?: string;
  clientName?: string;
  capabilities?: string[];
  outputDir?: string;
  connectTimeoutMs?: number;
  logLevel?: LogLevel;
};

const USAGE = `
playwright-mcp-cli — bridge an MCP client to the Playwright Chrome Extension

Usage:
  playwright-mcp-cli [options]            Serve MCP over stdio (default)
  playwright-mcp-cli doctor [options]     Print extension/browser diagnostics

Options:
  --browser <channel>         Browser channel: chrome | msedge | chromium | chrome-beta | ...
                              (env PLAYWRIGHT_MCP_BROWSER, default: chrome)
  --executable-path <path>    Explicit browser executable
                              (env PLAYWRIGHT_MCP_EXECUTABLE_PATH)
  --user-data-dir <path>      Custom browser "User Data" directory
  --profile-dir-name <name>   Chrome profile directory, e.g. "Default" or "Profile 1"
                              (env PLAYWRIGHT_MCP_PROFILE_DIR_NAME)
  --token <token>             Extension auth token; skips the approval dialog.
                              Pass "" to ignore PLAYWRIGHT_MCP_EXTENSION_TOKEN
                              (env PLAYWRIGHT_MCP_EXTENSION_TOKEN)
  --client-name <name>        Name shown in the extension UI and tab group
                              (default: playwright-mcp-cli)
  --caps <a,b,c>              Extra tool capabilities, e.g. "network,pdf,vision"
                              (the "core" set is always enabled)
  --output-dir <path>         Directory for automatically named output files
  --timeout <ms>              How long to wait for the extension to connect
                              (0 = forever, default: 0)
  --log-level <level>         error | warn | info | debug (env PW_MCP_CLI_LOG)
  --version                   Print the version and exit
  -h, --help                  Show this help
`;

function parseArgs(argv: string[]): { command: 'serve' | 'doctor'; options: Options } {
  const options: Options = {};
  let command: 'serve' | 'doctor' = 'serve';

  const takeValue = (index: number, name: string): string => {
    const value = argv[index + 1];
    if (value === undefined)
      throw new Error(`Missing value for ${name}`);
    argv.splice(index + 1, 1);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const [name, inlineValue] = arg.startsWith('--') && eq !== -1
      ? [arg.slice(0, eq), arg.slice(eq + 1)]
      : [arg, undefined];
    const value = () => inlineValue ?? takeValue(i, name);

    switch (name) {
      case '--browser':
        options.browserChannel = value();
        break;
      case '--executable-path':
        options.executablePath = value();
        break;
      case '--user-data-dir':
        options.userDataDir = value();
        break;
      case '--profile-dir-name':
        options.profileDirName = value();
        break;
      case '--token':
        options.token = value();
        break;
      case '--client-name':
        options.clientName = value();
        break;
      case '--caps':
        options.capabilities = value().split(',').map(c => c.trim()).filter(Boolean);
        break;
      case '--output-dir':
        options.outputDir = value();
        break;
      case '--timeout':
        options.connectTimeoutMs = Number(value());
        break;
      case '--log-level':
        options.logLevel = value() as LogLevel;
        break;
      case 'doctor':
        command = 'doctor';
        break;
      default:
        if (name === '-h' || name === '--help') {
          process.stdout.write(USAGE);
          process.exit(0);
        }
        if (name === '--version') {
          const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
          process.stdout.write(`${pkg.version}\n`);
          process.exit(0);
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { command, options };
}

function applyEnv(options: Options): Options {
  return {
    ...options,
    browserChannel: options.browserChannel ?? process.env.PLAYWRIGHT_MCP_BROWSER ?? 'chrome',
    executablePath: options.executablePath ?? process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH,
    profileDirName: options.profileDirName ?? process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME,
    // An explicit empty token means "no token": it disables the env fallback
    // so a stale PLAYWRIGHT_MCP_EXTENSION_TOKEN cannot break the manual
    // approval flow.
    token: options.token !== undefined
      ? options.token
      : process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN,
    logLevel: options.logLevel ?? (process.env.PW_MCP_CLI_LOG as LogLevel | undefined),
  };
}

async function doctor(options: Options): Promise<void> {
  const channel = options.browserChannel ?? 'chrome';
  const executablePath = options.executablePath ?? findBrowserExecutable(channel);
  const userDataDir = options.userDataDir ?? defaultUserDataDirForChannel(channel);

  const lines: string[] = [];
  lines.push(`channel:          ${channel}`);
  lines.push(`executable:       ${executablePath ?? '(not found)'}`);
  lines.push(`user data dir:    ${userDataDir ?? '(unknown)'}`);
  lines.push(`extension id:     ${playwrightExtensionId}`);
  lines.push(`install url:      ${playwrightExtensionInstallUrl}`);

  if (!executablePath)
    lines.push('status:           FAIL — browser executable not found');
  else if (!userDataDir)
    lines.push('status:           FAIL — could not resolve the user data dir');
  else {
    const profileDirectory = options.profileDirName ?? await findPlaywrightExtensionProfile(userDataDir);
    if (!profileDirectory) {
      lines.push('profile:          (none with the extension installed)');
      lines.push('status:           FAIL — Playwright Extension is not installed in this profile');
    } else {
      const installed = await isExtensionInstalledInProfile(path.join(userDataDir, profileDirectory));
      lines.push(`profile:          ${profileDirectory}`);
      lines.push(`extension:        ${installed ? 'installed' : 'NOT installed'}`);
      lines.push(`status:           ${installed ? 'OK' : 'FAIL'}`);
    }
  }

  // stdout is free here: the doctor command does not speak MCP.
  process.stdout.write(lines.join('\n') + '\n');
}

async function main(): Promise<void> {
  const { command, options: parsed } = parseArgs(process.argv.slice(2));
  const options = applyEnv(parsed);
  if (options.logLevel)
    setLogLevel(options.logLevel);

  if (command === 'doctor') {
    await doctor(options);
    return;
  }

  const { session } = await startStdioServer(options);

  const shutdown = async () => {
    const connected = await session.catch(() => undefined);
    await connected?.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(error => {
  log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
