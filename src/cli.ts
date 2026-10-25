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

import { daemonStatus, sendRequest } from './client';
import { commands, findCommand, parseArgv, UsageError } from './commands';
import { daemonLogPath, DEFAULT_CAPABILITIES, runDaemon } from './daemon';
import { log, setLogLevel } from './log';
import {
  defaultUserDataDirForChannel,
  findBrowserExecutable,
  findPlaywrightExtensionProfile,
  isExtensionInstalledInProfile,
  playwrightExtensionId,
  playwrightExtensionInstallUrl,
} from './relay/chrome';
import { startStdioServer } from './session';

import type { LogLevel } from './log';
import type { ExtensionServerOptions } from './session';

const SESSION_VALUE_FLAGS = new Set([
  'browser',
  'executable-path',
  'user-data-dir',
  'profile-dir-name',
  'token',
  'client-name',
  'output-dir',
  'timeout',
  'log-level',
]);

type SessionFlags = {
  browser?: string;
  executablePath?: string;
  userDataDir?: string;
  profileDirName?: string;
  token?: string;
  clientName?: string;
  outputDir?: string;
  connectTimeoutMs?: number;
  logLevel?: LogLevel;
  json: boolean;
};

/**
 * Splits the argv into session-level flags (consumed here and forwarded to
 * the daemon) and the rest, which belongs to the command.
 */
function splitSessionFlags(argv: string[]): { session: SessionFlags; rest: string[] } {
  const session: SessionFlags = { json: false };
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq !== -1 ? arg.slice(2, eq) : arg.slice(2);
    let value: string | undefined = eq !== -1 ? arg.slice(eq + 1) : undefined;

    if (name === 'json') {
      session.json = true;
      continue;
    }
    if (!SESSION_VALUE_FLAGS.has(name)) {
      rest.push(arg);
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined)
        throw new UsageError(`Missing value for --${name}`);
    }
    switch (name) {
      case 'browser': session.browser = value; break;
      case 'executable-path': session.executablePath = value; break;
      case 'user-data-dir': session.userDataDir = value; break;
      case 'profile-dir-name': session.profileDirName = value; break;
      case 'token': session.token = value; break;
      case 'client-name': session.clientName = value; break;
      case 'output-dir': session.outputDir = value; break;
      case 'timeout': session.connectTimeoutMs = Number(value); break;
      case 'log-level': session.logLevel = value as LogLevel; break;
    }
  }

  return { session, rest };
}

function sessionOptions(session: SessionFlags): ExtensionServerOptions {
  return {
    browserChannel: session.browser ?? process.env.PLAYWRIGHT_MCP_BROWSER ?? 'chrome',
    executablePath: session.executablePath ?? process.env.PLAYWRIGHT_MCP_EXECUTABLE_PATH,
    profileDirName: session.profileDirName ?? process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME,
    userDataDir: session.userDataDir,
    // The token is resolved in the session layer: an explicit --token wins,
    // then the token stored in the browser profile, then the environment.
    // `--token ""` explicitly disables it.
    token: session.token,
    clientName: session.clientName ?? 'playwright-extension-cli',
    outputDir: session.outputDir,
    connectTimeoutMs: session.connectTimeoutMs,
    capabilities: DEFAULT_CAPABILITIES,
  };
}

/** Flags the daemon needs in order to reproduce this session. */
function daemonArgs(session: SessionFlags): string[] {
  const args: string[] = [];
  const options = sessionOptions(session);
  if (options.browserChannel) args.push('--browser', options.browserChannel);
  if (options.executablePath) args.push('--executable-path', options.executablePath);
  if (options.userDataDir) args.push('--user-data-dir', options.userDataDir);
  if (options.profileDirName) args.push('--profile-dir-name', options.profileDirName);
  if (options.token !== undefined) args.push('--token', options.token);
  if (options.clientName) args.push('--client-name', options.clientName);
  if (options.outputDir) args.push('--output-dir', options.outputDir);
  if (options.connectTimeoutMs !== undefined) args.push('--timeout', String(options.connectTimeoutMs));
  return args;
}

function printResult(result: any, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  const parts = (result?.content ?? []).filter((part: any) => part.type === 'text');
  if (!parts.length) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  process.stdout.write(parts.map((part: any) => part.text).join('\n') + '\n');
}

function usage(): string {
  const lines = [
    'playwright-extension-cli — drive your browser through the Playwright Chrome Extension',
    '',
    'Usage:',
    '  pwcli <command> [args] [options]',
    '',
    'Session commands:',
    '  connect                 Start the session (opens the extension connect page in Chrome)',
    '  disconnect              Tear the session down',
    '  status                  Show session state',
    '  tools                   List the available browser tools',
    '  doctor                  Check browser / profile / extension setup',
    '  mcp                     Serve the same tools as an MCP server over stdio',
    '',
    'Commands:',
  ];
  for (const command of commands)
    lines.push(`  ${command.usage.padEnd(58)} ${command.summary}`);
  lines.push(
    '',
    'Global options:',
    '  --json                        Print the raw tool result as JSON',
    '  --browser <channel>           chrome | msedge | chromium | ...',
    '  --executable-path <path>      Explicit browser executable',
    '  --user-data-dir <path>        Custom browser "User Data" directory',
    '  --profile-dir-name <name>     Chrome profile directory, e.g. "Default"',
    '  --token <token>               Extension token; "" ignores the env var',
    '  --client-name <name>          Name shown in the extension UI',
    '  --output-dir <path>           Directory for generated files',
    '  --timeout <ms>                How long to wait for the extension',
    '  --log-level <level>           error | warn | info | debug',
    '  -h, --help                    Show this help',
  );
  return lines.join('\n');
}

async function doctor(session: SessionFlags): Promise<void> {
  const options = sessionOptions(session);
  const channel = options.browserChannel!;
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

  process.stdout.write(lines.join('\n') + '\n');
}

async function listTools(): Promise<void> {
  const { tools } = require('playwright-core/lib/coreBundle');
  const list = tools.filteredTools({ capabilities: DEFAULT_CAPABILITIES });
  for (const tool of list)
    process.stdout.write(`${tool.schema.name.padEnd(34)} ${tool.capability}\n`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { session, rest } = splitSessionFlags(argv);

  if (session.logLevel)
    setLogLevel(session.logLevel);

  const commandName = rest[0];
  if (!commandName || commandName === '-h' || commandName === '--help' || commandName === 'help') {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (commandName === '--version' || commandName === 'version') {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    process.stdout.write(`${pkg.version}\n`);
    return;
  }

  switch (commandName) {
    case 'daemon': {
      await runDaemon(sessionOptions(session));
      return;
    }
    case 'doctor': {
      await doctor(session);
      return;
    }
    case 'tools': {
      await listTools();
      return;
    }
    case 'mcp': {
      const { session: running } = await startStdioServer(sessionOptions(session));
      const shutdown = async () => {
        const connected = await running.catch(() => undefined);
        await connected?.close().catch(() => {});
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
      return;
    }
    case 'status': {
      const status = await daemonStatus();
      if (session.json) {
        process.stdout.write(JSON.stringify(status, null, 2) + '\n');
        return;
      }
      if (!status.running) {
        process.stdout.write('running:   no session (start one with `pwcli connect`)\n');
        return;
      }
      process.stdout.write([
        `running:   yes`,
        `pid:       ${status.pid ?? '-'}`,
        `started:   ${status.startedAt ?? '-'}`,
        `extension: ${status.connected ? 'connected' : 'waiting for approval in Chrome'}`,
        ...(status.pages?.length ? [`pages:     ${status.pages.join(', ')}`] : []),
        `log:       ${daemonLogPath()}`,
      ].join('\n') + '\n');
      return;
    }
    case 'connect': {
      process.stderr.write('Starting the session; approve the extension connection in Chrome...\n');
      const deadline = Date.now() + (session.connectTimeoutMs ?? 120_000);
      let status = await sendRequest({ type: 'status' }, { daemonArgs: daemonArgs(session) });
      while (!status.connected && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 500));
        status = await sendRequest({ type: 'status' }, { daemonArgs: daemonArgs(session) });
      }
      if (!status.connected) {
        process.stderr.write('Timed out waiting for the extension to be approved.\n');
        process.exitCode = 1;
        return;
      }
      process.stdout.write('connected\n');
      return;
    }
    case 'disconnect': {
      await sendRequest({ type: 'disconnect' }, { daemonArgs: daemonArgs(session) });
      process.stdout.write('disconnected\n');
      return;
    }
  }

  const command = findCommand(commandName);
  if (!command) {
    process.stderr.write(`Unknown command: ${commandName}\n\n`);
    process.stderr.write(usage() + '\n');
    process.exitCode = 1;
    return;
  }

  const { positional, flags } = parseArgv(rest.slice(1), command.valueFlags ?? []);
  const call = command.build(positional, flags);

  const result = await sendRequest({
    type: 'tool',
    tool: call.tool,
    arguments: call.arguments,
    cwd: process.cwd(),
  }, { daemonArgs: daemonArgs(session) });

  printResult(result, session.json);
  if (result?.isError)
    process.exitCode = 1;
}

main().catch(error => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
