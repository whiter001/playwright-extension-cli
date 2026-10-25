/**
 * End-to-end smoke test: drives the CLI as a real MCP client.
 *
 * Usage:
 *   node scripts/e2e.mjs [--token <token>] [--caps network,pdf]
 *
 * The CLI opens the Playwright Extension connect page in Chrome; approve the
 * connection there (or pick a tab) while this script waits.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const passthrough = process.argv.slice(2);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/cli.js', 'mcp', ...passthrough],
  cwd: process.cwd(),
  stderr: 'inherit',
  env: { ...process.env },
});

const client = new Client({ name: 'playwright-extension-cli-e2e', version: '1.0.0' }, { capabilities: {} });

console.log('[e2e] connecting...');
await client.connect(transport);
console.log('[e2e] connected');

const { tools } = await client.listTools();
console.log(`[e2e] ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);

const snapshot = await client.callTool(
  { name: 'browser_snapshot', arguments: {} },
  undefined,
  { timeout: 300_000 },
);
const text = (snapshot.content ?? [])
  .filter(part => part.type === 'text')
  .map(part => part.text)
  .join('\n');
console.log(`[e2e] browser_snapshot -> ${text.length} chars`);
console.log(text.slice(0, 1500));

await client.close();
console.log('[e2e] done');
process.exit(0);
