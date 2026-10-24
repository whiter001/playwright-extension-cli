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
 * Logger for the CLI.
 *
 * IMPORTANT: everything is written to stderr. stdout is reserved for the MCP
 * stdio transport and any stray byte there corrupts the JSON-RPC stream.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const levelOrder: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

function initialLevel(): LogLevel {
  const raw = (process.env.PW_MCP_CLI_LOG ?? '').toLowerCase();
  return (raw in levelOrder ? raw : 'info') as LogLevel;
}

let currentLevel: LogLevel = initialLevel();

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function emit(level: LogLevel, args: unknown[]): void {
  if (levelOrder[level] > levelOrder[currentLevel])
    return;
  const message = args.map(arg => typeof arg === 'string' ? arg : inspect(arg)).join(' ');
  process.stderr.write(`[pw-mcp-cli:${level}] ${message}\n`);
}

function inspect(value: unknown): string {
  if (value instanceof Error)
    return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  error: (...args: unknown[]) => emit('error', args),
  warn: (...args: unknown[]) => emit('warn', args),
  info: (...args: unknown[]) => emit('info', args),
  debug: (...args: unknown[]) => emit('debug', args),
};

export function logUnhandledError(error: unknown): void {
  log.error(error);
}
