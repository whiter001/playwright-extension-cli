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

import { daemonStatus, listSessions, sendRequest } from './client';
import { commands, findCommand, parseArgv, UsageError } from './commands';
import { daemonLogPath, DEFAULT_CAPABILITIES, runDaemon } from './daemon';
import { log, setLogLevel } from './log';
import { installSkill, removeSkill, skillTargets } from './skill';
import { describeIdentity, normalizeIdentity } from './identity';
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
import type { SessionIdentity } from './identity';

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

/**
 * What the caller expects to drive.
 *
 * The channel picks the daemon, so it is always part of the identity. The
 * overrides only constrain the session when they were given explicitly — an
 * unset option means "whatever the running session uses". The paths are
 * resolved against the directory the command was typed in, so the same
 * session is recognized from anywhere.
 */
function expectedIdentity(session: SessionFlags): SessionIdentity {
  const options = sessionOptions(session);
  return normalizeIdentity({
    browserChannel: options.browserChannel!,
    executablePath: options.executablePath,
    userDataDir: options.userDataDir,
    profileDirName: options.profileDirName,
  });
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
    'Install commands:',
    '  install --skills        Install the agent skill for coding agents',
    '  uninstall --skills      Remove the agent skill again',
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

function skillUsage(command: 'install' | 'uninstall'): string {
  const installing = command === 'install';
  const lines = [
    `pwcli ${command} --skills[=<targets>] [--global] [--skills-dir <path>]`,
    '',
    installing
      ? 'Installs the bundled agent skill (SKILL.md + references/) into the skills'
      : 'Removes the agent skill from the skills folders of the coding agents.',
    installing
      ? 'folders of the coding agents that speak the Agent Skills format.'
      : 'Only a folder whose SKILL.md declares our own skill is deleted.',
    '',
    'Targets:',
  ];
  for (const target of skillTargets)
    lines.push(`  ${target.id.padEnd(12)} ${target.label}`);
  lines.push(
    '  all         every target above',
    '',
    'Options:',
    `  --skills[=<targets>]   ${installing ? 'Install' : 'Remove'} the skill. <targets> is a comma-separated`,
    '                         list of target ids' + (installing ? ' (default: detect the agents installed here)' : ' (default: every target)'),
    `  --global, -g           ${installing ? 'Install into' : 'Remove from'} the user-level folders instead of the project`,
    `  --skills-dir <path>    ${installing ? 'Install into' : 'Remove from'} a custom directory (overrides the targets)`,
  );
  return lines.join('\n');
}

type SkillCommandOptions = {
  requested: boolean;
  targets?: string[];
  globalScope: boolean;
  customDir?: string;
  /** The usage was printed and the command is done. */
  help: boolean;
};

/**
 * Parses the flags shared by `install --skills` and `uninstall --skills`.
 */
function parseSkillFlags(argv: string[], command: 'install' | 'uninstall'): SkillCommandOptions {
  let requested = false;
  let targets: string[] | undefined;
  let globalScope = false;
  let customDir: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '-h' || arg === '--help') {
      process.stdout.write(skillUsage(command) + '\n');
      return { requested: false, globalScope: false, help: true };
    }

    if (arg === '--global' || arg === '-g') {
      globalScope = true;
      continue;
    }

    if (arg === '--skills' || arg.startsWith('--skills=')) {
      requested = true;
      const values: string[] = [];
      if (arg.startsWith('--skills=')) {
        values.push(arg.slice('--skills='.length));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          values.push(next);
          i++;
        }
      }
      // Further non-flag words belong to the target list as well: shells hand
      // over `--skills=a,b` either as one argument or as several, and
      // PowerShell joins a comma separated list with spaces.
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-'))
        values.push(argv[++i]);

      for (const value of values) {
        for (const part of value.split(/[\s,]+/)) {
          const name = part.trim();
          if (name)
            targets = [...(targets ?? []), name];
        }
      }
      continue;
    }

    if (arg === '--skills-dir' || arg.startsWith('--skills-dir=')) {
      let value: string | undefined;
      if (arg.startsWith('--skills-dir='))
        value = arg.slice('--skills-dir='.length);
      else {
        value = argv[++i];
        if (value === undefined)
          throw new UsageError('Missing value for --skills-dir');
      }
      customDir = value;
      continue;
    }

    throw new UsageError(`Unknown option for \`${command}\`: ${arg}`);
  }

  return { requested, targets, globalScope, customDir, help: false };
}

async function installCommand(argv: string[], session: SessionFlags): Promise<void> {
  const { requested, targets, globalScope, customDir, help } = parseSkillFlags(argv, 'install');

  if (help)
    return;

  if (!requested) {
    process.stderr.write(skillUsage('install') + '\n');
    process.exitCode = 1;
    return;
  }

  const result = installSkill({ targets, global: globalScope, customDir, cwd: process.cwd() });

  if (session.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  const lines = [`Installed skill "${result.skill}" (${result.scope}):`];
  for (const entry of result.installed)
    lines.push(`  ${entry.id.padEnd(12)} ${entry.directory}  (${entry.files} files, ${entry.status})`);
  for (const warning of result.warnings)
    lines.push(`  warning: ${warning}`);
  lines.push('Restart the coding agent so it picks the skill up.');
  lines.push('Tip: "agents" covers Codex, Cursor, Gemini, Copilot and Kimi; Claude Code and CodeBuddy need their own folder.');
  process.stdout.write(lines.join('\n') + '\n');
}

async function uninstallCommand(argv: string[], session: SessionFlags): Promise<void> {
  const { requested, targets, globalScope, customDir, help } = parseSkillFlags(argv, 'uninstall');

  if (help)
    return;

  if (!requested) {
    process.stderr.write(skillUsage('uninstall') + '\n');
    process.exitCode = 1;
    return;
  }

  const result = removeSkill({ targets, global: globalScope, customDir, cwd: process.cwd() });

  if (session.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  const lines = [`Removed skill "${result.skill}" (${result.scope}):`];
  for (const entry of result.removed)
    lines.push(`  ${entry.id.padEnd(12)} ${entry.directory}  (${entry.files} files)`);
  for (const entry of result.skipped)
    lines.push(`  ${entry.id.padEnd(12)} ${entry.directory}  (skipped: ${entry.reason})`);
  process.stdout.write(lines.join('\n') + '\n');
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
    case 'install': {
      await installCommand(rest.slice(1), session);
      return;
    }
    case 'uninstall': {
      await uninstallCommand(rest.slice(1), session);
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
      // An explicit --browser narrows the report to that session; without it
      // every running session is listed, because they can run side by side.
      let sessions: any[];
      if (session.browser !== undefined) {
        const status = await daemonStatus({ expected: expectedIdentity(session) });
        sessions = status.running === false ? [] : [status];
      } else {
        sessions = await listSessions();
      }
      if (session.json) {
        process.stdout.write(JSON.stringify(sessions, null, 2) + '\n');
        return;
      }
      if (!sessions.length) {
        process.stdout.write('running:   no session (start one with `pwcli connect`)\n');
        return;
      }
      const blocks = sessions.map(status => {
        const identity = status.identity;
        return [
          `running:   yes`,
          `browser:   ${identity ? describeIdentity({ ...identity, profileDirName: status.profileDirectory ?? identity.profileDirName }) : 'unknown'}`,
          `pid:       ${status.pid ?? '-'}`,
          `started:   ${status.startedAt ?? '-'}`,
          `extension: ${status.connected ? 'connected' : status.sessionError ? `failed — ${status.sessionError}` : 'waiting for approval in the browser'}`,
          ...(status.pages?.length ? [`pages:     ${status.pages.join(', ')}`] : []),
          `log:       ${daemonLogPath(identity?.browserChannel)}`,
        ].join('\n');
      });
      process.stdout.write(blocks.join('\n\n') + '\n');
      return;
    }
    case 'connect': {
      process.stderr.write('Starting the session; approve the extension connection in the browser...\n');
      const deadline = Date.now() + (session.connectTimeoutMs ?? 120_000);
      let status = await sendRequest({ type: 'status' }, { daemonArgs: daemonArgs(session), expected: expectedIdentity(session) });
      while (!status.connected && Date.now() < deadline) {
        // A failed session has a reason — do not wait out the timeout for it.
        if (status.sessionError) {
          process.stderr.write(`The session failed: ${status.sessionError}\n`);
          process.exitCode = 1;
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        status = await sendRequest({ type: 'status' }, { daemonArgs: daemonArgs(session), expected: expectedIdentity(session) });
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
      await sendRequest({ type: 'disconnect' }, { daemonArgs: daemonArgs(session), expected: expectedIdentity(session) });
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
  }, { daemonArgs: daemonArgs(session), expected: expectedIdentity(session) });

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
