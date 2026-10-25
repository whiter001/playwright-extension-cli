/**
 * Session identity.
 *
 * Two pwcli sessions point at different browsers as soon as any of these
 * differ:
 *
 *   - the browser channel (chrome / msedge / chromium / ...)
 *   - an explicitly pinned browser executable
 *   - an explicitly pinned "User Data" directory
 *   - an explicitly pinned profile directory
 *
 * The channel decides which daemon holds the session (see `socketPath()`), so
 * Chrome and Edge sessions can run side by side. The remaining fields cannot
 * be expressed in a path, so they are compared when a session is reused: a
 * caller that asks for `Profile 1` must not silently end up on the daemon that
 * serves `Default`.
 */

import path from 'path';

/** What a session points at. Undefined means "use the channel default". */
export type SessionIdentity = {
  /** Browser channel, e.g. "chrome" or "msedge". */
  browserChannel: string;
  /** Explicit browser executable. */
  executablePath?: string;
  /** Explicit "User Data" directory. */
  userDataDir?: string;
  /** Explicit profile directory, e.g. "Default" or "Profile 1". */
  profileDirName?: string;
};

/**
 * What a session ended up driving, after the channel defaults were resolved.
 *
 * The profile is named `profileDirectory` here because it is a directory
 * inside the user data dir, while `profileDirName` is the option a caller
 * passes on the command line.
 */
export type ResolvedSessionIdentity = {
  browserChannel: string;
  executablePath?: string;
  userDataDir?: string;
  profileDirectory?: string;
};

/** Fields that only constrain the session when the caller pins them. */
const OVERRIDE_FIELDS: { key: keyof SessionIdentity; label: string }[] = [
  { key: 'executablePath', label: 'browser executable' },
  { key: 'userDataDir', label: 'user data directory' },
  { key: 'profileDirName', label: 'profile directory' },
];

/**
 * Normalizes a channel name for comparison and for use in a path.
 *
 * Channels are plain identifiers ("chrome", "msedge-beta"), but the value can
 * come from an environment variable, so it is sanitized before it reaches a
 * socket name.
 */
export function normalizeChannel(channel: string | undefined): string {
  const normalized = (channel ?? 'chrome')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'chrome';
}

/**
 * Drops the trailing separators of a path.
 *
 * The root keeps its separator: "/" is not "" and "C:\" is not "C:".
 */
function stripTrailingSeparators(value: string, separator: string): string {
  let result = value;
  while (result.length > 1 && result.endsWith(separator)) {
    const shorter = result.slice(0, -1);
    // A drive root keeps its separator.
    if (/^[a-zA-Z]:$/.test(shorter))
      return shorter + separator;
    result = shorter;
  }
  return result;
}

/**
 * Compares two paths.
 *
 * On Windows the paths are case insensitive, "/" and "\" mean the same thing,
 * and a trailing separator does not make two paths different. On POSIX the
 * case matters and a backslash is a regular character in a file name.
 */
export function samePath(a: string, b: string): boolean {
  const windows = process.platform === 'win32';
  const normalize = (value: string) => {
    if (!windows)
      return stripTrailingSeparators(path.posix.normalize(value), '/');
    // path.win32.normalize() already turns "/" into "\".
    const normalized = path.win32.normalize(value);
    return stripTrailingSeparators(normalized, '\\').toLowerCase();
  };
  return normalize(a) === normalize(b);
}

/**
 * The command that ends the session of a channel.
 *
 * Chrome is the default channel, so it needs no flag; every other channel
 * has to be named explicitly.
 */
export function disconnectHint(channel: string | undefined): string {
  const normalized = normalizeChannel(channel);
  return normalized === 'chrome' ? 'pwcli disconnect' : `pwcli disconnect --browser ${normalized}`;
}

/**
 * Normalizes an identity so that two spellings of the same session compare
 * equal.
 *
 * The executable and the user data dir are paths: they are resolved against
 * the directory the caller started in, so the same session is recognized no
 * matter which directory the command was typed in. The profile name is not a
 * path — it is the name of a directory inside the user data dir — so it is
 * left alone.
 */
export function normalizeIdentity(identity: SessionIdentity, cwd: string = process.cwd()): SessionIdentity {
  const resolve = (value: string | undefined) => value ? path.resolve(cwd, value) : undefined;
  return {
    browserChannel: normalizeChannel(identity.browserChannel),
    executablePath: resolve(identity.executablePath),
    userDataDir: resolve(identity.userDataDir),
    profileDirName: identity.profileDirName,
  };
}

/**
 * Returns a human readable reason when the running session does not match the
 * requested one, or undefined when they are compatible.
 *
 * Only the fields the caller pinned are compared: a caller that did not ask
 * for a specific profile accepts whatever profile the running session uses.
 */
export function identityMismatch(expected: SessionIdentity, actual: SessionIdentity): string | undefined {
  const expectedChannel = normalizeChannel(expected.browserChannel);
  const actualChannel = normalizeChannel(actual.browserChannel);
  if (expectedChannel !== actualChannel)
    return `the browser channel is "${actualChannel}", but "${expectedChannel}" was requested`;

  for (const { key, label } of OVERRIDE_FIELDS) {
    const wanted = expected[key];
    if (wanted === undefined)
      continue;
    const running = actual[key];
    if (running === undefined)
      return `the ${label} should be "${wanted}", but the running session uses the channel default`;
    if (!samePath(wanted, running))
      return `the ${label} is "${running}", but "${wanted}" was requested`;
  }
  return undefined;
}

/** Short one-line description of an identity, used in log and status output. */
export function describeIdentity(identity: SessionIdentity): string {
  const parts = [normalizeChannel(identity.browserChannel)];
  if (identity.profileDirName)
    parts.push(`profile "${identity.profileDirName}"`);
  if (identity.executablePath)
    parts.push(`executable "${identity.executablePath}"`);
  if (identity.userDataDir)
    parts.push(`user data "${identity.userDataDir}"`);
  return parts.join(', ');
}
