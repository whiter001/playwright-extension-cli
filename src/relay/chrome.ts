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

/**
 * Chrome/Edge discovery and Playwright Extension profile resolution.
 *
 * Ported from microsoft/playwright:
 *   packages/playwright-core/src/tools/utils/extension.ts
 *   packages/utils/chromiumChannels.ts
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../log';

// Also pinned via the "key" field in the extension's manifest.json.
export const playwrightExtensionId = 'mmlmfjhmonkocbjadbfplnigmagldckm';

export const playwrightExtensionInstallUrl =
  `https://chromewebstore.google.com/detail/playwright-extension/${playwrightExtensionId}`;

// ─── User data directories ─────────────────────────────────────────────

const channelToUserDataDir = new Map<string, Record<string, string>>([
  ['chrome', {
    'linux': path.join(os.homedir(), '.config', 'google-chrome'),
    'darwin': path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome'),
    'win32': path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data'),
  }],
  ['chrome-beta', {
    'linux': path.join(os.homedir(), '.config', 'google-chrome-beta'),
    'darwin': path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome Beta'),
    'win32': path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome Beta', 'User Data'),
  }],
  ['chrome-dev', {
    'linux': path.join(os.homedir(), '.config', 'google-chrome-unstable'),
    'darwin': path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome Dev'),
    'win32': path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome Dev', 'User Data'),
  }],
  ['chrome-canary', {
    'linux': path.join(os.homedir(), '.config', 'google-chrome-canary'),
    'darwin': path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome Canary'),
    'win32': path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome SxS', 'User Data'),
  }],
  ['msedge', {
    'linux': path.join(os.homedir(), '.config', 'microsoft-edge'),
    'darwin': path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge'),
    'win32': path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Edge', 'User Data'),
  }],
  ['msedge-beta', {
    'linux': path.join(os.homedir(), '.config', 'microsoft-edge-beta'),
    'darwin': path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge Beta'),
    'win32': path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Edge Beta', 'User Data'),
  }],
  ['msedge-dev', {
    'linux': path.join(os.homedir(), '.config', 'microsoft-edge-dev'),
    'darwin': path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge Dev'),
    'win32': path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Edge Dev', 'User Data'),
  }],
  ['msedge-canary', {
    'linux': path.join(os.homedir(), '.config', 'microsoft-edge-canary'),
    'darwin': path.join(os.homedir(), 'Library', 'Application Support', 'Microsoft Edge Canary'),
    'win32': path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Edge SxS', 'User Data'),
  }],
  ['chromium', {
    'linux': path.join(os.homedir(), '.config', 'chromium'),
    'darwin': path.join(os.homedir(), 'Library', 'Application Support', 'Chromium'),
    'win32': path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Chromium', 'User Data'),
  }],
]);

export function defaultUserDataDirForChannel(channel: string): string | undefined {
  return channelToUserDataDir.get(channel)?.[process.platform];
}

export function isChromiumChannelName(channel: string): boolean {
  return channelToUserDataDir.has(channel);
}

// ─── Browser executables ───────────────────────────────────────────────

type ExecutableSpec = {
  darwin: string[];
  linux: string[];
  win32: string[];
};

const channelToExecutables = new Map<string, ExecutableSpec>([
  ['chrome', {
    'darwin': [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ],
    'linux': ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'],
    'win32': [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
  }],
  ['chrome-beta', {
    'darwin': ['/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta'],
    'linux': ['google-chrome-beta'],
    'win32': [path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome Beta', 'Application', 'chrome.exe')],
  }],
  ['chrome-dev', {
    'darwin': ['/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev'],
    'linux': ['google-chrome-unstable'],
    'win32': [path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome Dev', 'Application', 'chrome.exe')],
  }],
  ['chrome-canary', {
    'darwin': ['/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'],
    'linux': ['google-chrome-canary'],
    'win32': [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome SxS', 'Application', 'chrome.exe')],
  }],
  ['msedge', {
    'darwin': ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    'linux': ['microsoft-edge', 'microsoft-edge-stable'],
    'win32': [path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
  }],
  ['msedge-beta', {
    'darwin': ['/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta'],
    'linux': ['microsoft-edge-beta'],
    'win32': [path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge Beta', 'Application', 'msedge.exe')],
  }],
  ['msedge-dev', {
    'darwin': ['/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev'],
    'linux': ['microsoft-edge-dev'],
    'win32': [path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge Dev', 'Application', 'msedge.exe')],
  }],
  ['msedge-canary', {
    'darwin': ['/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary'],
    'linux': ['microsoft-edge-canary'],
    'win32': [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'Edge SxS', 'Application', 'msedge.exe')],
  }],
  ['chromium', {
    'darwin': ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
    'linux': ['chromium', 'chromium-browser'],
    'win32': [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Chromium', 'Application', 'chrome.exe')],
  }],
]);

export function findBrowserExecutable(channel: string): string | undefined {
  const spec = channelToExecutables.get(channel);
  if (!spec)
    return undefined;
  const candidates = spec[process.platform as 'darwin' | 'linux' | 'win32'] ?? [];
  if (process.platform === 'linux') {
    for (const name of candidates) {
      const resolved = findOnPath(name);
      if (resolved)
        return resolved;
    }
    return undefined;
  }
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && exists(candidate))
      return candidate;
  }
  return undefined;
}

function findOnPath(name: string): string | undefined {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir)
      continue;
    const candidate = path.join(dir, name);
    if (exists(candidate))
      return candidate;
  }
  return undefined;
}

// ─── Extension profile resolution ──────────────────────────────────────

export async function findPlaywrightExtensionProfile(userDataDir: string): Promise<string | undefined> {
  const profiles = await listProfileDirectories(userDataDir);
  const lastUsed = await readLastUsedProfile(userDataDir);
  const ordered = lastUsed && profiles.includes(lastUsed)
    ? [lastUsed, ...profiles.filter(profile => profile !== lastUsed)]
    : profiles;
  for (const profile of ordered) {
    if (await isExtensionInstalledInProfile(path.join(userDataDir, profile)))
      return profile;
  }
  return undefined;
}

async function listProfileDirectories(userDataDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.promises.readdir(userDataDir);
  } catch {
    return [];
  }
  const profiles = entries.filter(entry => entry === 'Default' || /^Profile \d+$/.test(entry));
  profiles.sort((a, b) => profileRank(a) - profileRank(b));
  return profiles;
}

function profileRank(profile: string): number {
  return profile === 'Default' ? -1 : parseInt(profile.slice('Profile '.length), 10);
}

async function readLastUsedProfile(userDataDir: string): Promise<string | undefined> {
  try {
    const localState = JSON.parse(await fs.promises.readFile(path.join(userDataDir, 'Local State'), 'utf-8'));
    const lastUsed = localState?.profile?.last_used;
    return typeof lastUsed === 'string' ? lastUsed : undefined;
  } catch {
    return undefined;
  }
}

export async function isExtensionInstalledInProfile(profileDir: string): Promise<boolean> {
  // Web store installs unpack into <profile>/Extensions/<id>; `--load-extension` only
  // leaves a settings record in the preferences.
  if (await pathExists(path.join(profileDir, 'Extensions', playwrightExtensionId)))
    return true;
  // `extensions.settings` lives in Preferences or Secure Preferences depending on the platform.
  for (const fileName of ['Preferences', 'Secure Preferences']) {
    if (await hasExtensionSettingsRecord(path.join(profileDir, fileName)))
      return true;
  }
  return false;
}

async function hasExtensionSettingsRecord(prefsPath: string): Promise<boolean> {
  let prefs: any;
  try {
    prefs = JSON.parse(await fs.promises.readFile(prefsPath, 'utf-8'));
  } catch {
    return false;
  }
  // Uninstalling leaves an orphaned empty settings record behind, so require a populated one.
  const record = prefs?.extensions?.settings?.[playwrightExtensionId];
  return !!record && typeof record === 'object' && Object.keys(record).length > 0;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

// ─── Connect page ──────────────────────────────────────────────────────

export type ExtensionProfile = {
  /** Directory that holds the browser profiles ("User Data"). */
  userDataDir?: string;
  /** Profile directory name, e.g. "Default" or "Profile 1". */
  profileDirectory?: string;
};

/**
 * Resolves which browser profile holds the Playwright Extension.
 *
 * When a custom executable path is used, the local profile layout is not
 * meaningful (e.g. a Windows chrome.exe driven from WSL2), so we skip
 * profile detection entirely.
 */
export async function resolveExtensionProfile(options: {
  channel: string;
  executablePath?: string;
  customUserDataDir?: string;
  profileDirName?: string;
}): Promise<ExtensionProfile> {
  const { channel, executablePath, customUserDataDir, profileDirName } = options;
  const userDataDir = customUserDataDir ?? (executablePath ? undefined : defaultUserDataDirForChannel(channel));
  const profileDirectory = profileDirName ?? (userDataDir ? await findPlaywrightExtensionProfile(userDataDir) : undefined);

  if (userDataDir && !executablePath && (!profileDirectory || !await isExtensionInstalledInProfile(path.join(userDataDir, profileDirectory)))) {
    throw new Error(
      `Playwright Extension not found in "${profileDirectory ? path.join(userDataDir, profileDirectory) : userDataDir}". ` +
      `Install it from ${playwrightExtensionInstallUrl}, or set the PLAYWRIGHT_MCP_EXECUTABLE_PATH environment variable ` +
      `to use a browser at a custom location.`
    );
  }
  return { userDataDir, profileDirectory };
}

export function buildConnectUrl(options: {
  relayUrl: string;
  clientName: string;
  protocolVersion: number;
  token?: string;
}): string {
  const url = new URL(`chrome-extension://${playwrightExtensionId}/connect.html`);
  url.searchParams.set('mcpRelayUrl', options.relayUrl);
  url.searchParams.set('client', JSON.stringify({ name: options.clientName, version: undefined }));
  url.searchParams.set('protocolVersion', options.protocolVersion.toString());
  if (options.token)
    url.searchParams.set('token', options.token);
  return url.toString();
}

// ─── Extension auth token ─────────────────────────────────────────────

/**
 * Reads the extension's auth token out of the browser profile.
 *
 * The extension keeps its token in `localStorage["auth-token"]` on the
 * `chrome-extension://<id>` origin, which Chrome stores in the profile's
 * `Local Storage/leveldb` LevelDB. The entries are raw key/value pairs with
 * no stable ordering and no clean separator, so we look for the extension id
 * and a 43 character base64url token in the same neighbourhood.
 *
 * The newest file wins: LevelDB file numbers increase with time and the
 * current WAL (`.log`) holds the most recent writes. Stale tokens from
 * earlier sessions survive in older files, hence the ordering.
 *
 * @param profileDir the profile directory, e.g. `<user data dir>/Default`
 */
export async function readExtensionToken(profileDir: string): Promise<string | undefined> {
  const leveldbDir = path.join(profileDir, 'Local Storage', 'leveldb');
  let entries: string[];
  try {
    entries = await fs.promises.readdir(leveldbDir);
  } catch {
    return undefined;
  }

  const files = entries
    .filter(name => name.endsWith('.ldb') || name.endsWith('.log'))
    .sort((a, b) => {
      const isLog = (name: string) => (name.endsWith('.log') ? 1 : 0);
      const number = (name: string) => parseInt(name.replace(/\D/g, ''), 10) || 0;
      return isLog(b) - isLog(a) || number(b) - number(a);
    });

  // The id is stored as one blob, but LevelDB encodes part of it, so the
  // readable fragments are separated by binary bytes. The observed layout
  // keeps "mmlmfjh", "ocbjadbfpln" and "gldckm" as plain text with a short
  // gap in front of each of the two latter ones.
  const idPattern = /mmlmfjh[\s\S]{0,16}ocbjadbfpln[\s\S]{0,16}gldckm/g;
  const tokenPattern = /[A-Za-z0-9_-]{43}/g;

  for (const file of files) {
    let data: Buffer;
    try {
      const stat = await fs.promises.stat(path.join(leveldbDir, file));
      if (stat.size > 64 * 1024 * 1024)
        continue;
      data = await fs.promises.readFile(path.join(leveldbDir, file));
    } catch {
      continue;
    }

    const text = data.toString('latin1');
    const candidates: { token: string; offset: number }[] = [];
    for (const idMatch of text.matchAll(idPattern)) {
      const idEnd = idMatch.index! + idMatch[0].length;
      // The value of a localStorage record follows its origin id, so the first
      // token after the id is the one that belongs to it. An origin can have
      // several records (auth-token, activeTab, ...), and only some of them
      // carry a token — hence the bounded distance and the "first one wins".
      const window = text.slice(idEnd, idEnd + 256);
      const value = window.match(tokenPattern);
      if (value)
        candidates.push({ token: value[0], offset: idMatch.index! });
    }
    if (candidates.length) {
      // Later offsets hold the newer value.
      candidates.sort((a, b) => b.offset - a.offset);
      return candidates[0].token;
    }
  }
  return undefined;
}

/**
 * Spawns a detached helper process.
 *
 * The 'error' listener is mandatory: without it a failed spawn (missing
 * executable, no permission) emits an unhandled 'error' event and takes the
 * whole daemon down.
 */
export function spawnDetached(command: string, args: string[]): void {
  try {
    const child = spawn(command, args, {
      windowsHide: true,
      detached: true,
      shell: false,
      stdio: 'ignore',
    });
    child.on('error', error => log.warn(`Failed to launch "${command}": ${error.message}`));
    child.unref();
  } catch (error: any) {
    log.warn(`Failed to launch "${command}": ${error?.message ?? error}`);
  }
}

/**
 * Extracts the macOS application name from a browser executable path, e.g.
 * `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` becomes
 * `Microsoft Edge`.
 */
export function macAppNameForExecutable(executablePath: string): string | undefined {
  return executablePath.match(/\/([^/]+)\.app\/Contents\/MacOS\//)?.[1];
}

export function openConnectPage(options: {
  executablePath: string;
  userDataDir?: string;
  profileDirectory?: string;
  channel: string;
  url: string;
}): void {
  const args: string[] = [];
  // The default profile dir is not passed explicitly, the browser resolves it on its own.
  if (options.userDataDir)
    args.push(`--user-data-dir=${options.userDataDir}`);
  if (options.profileDirectory)
    args.push(`--profile-directory=${options.profileDirectory}`);
  if (process.platform === 'linux' && options.channel === 'chromium')
    args.push('--no-sandbox');
  args.push(options.url);

  spawnDetached(options.executablePath, args);
}
