/**
 * Offline test for CLI argument mapping: no browser, no daemon, no extension.
 *
 * Every command is turned into a tool call here, so mismatches between the CLI
 * syntax and the upstream tool schema show up without spinning up Chrome.
 *
 * Usage: node scripts/args-test.mjs
 */

import assert from 'assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseArgv, findCommand } = require('../dist/commands.js');
const { tools } = require('playwright-core/lib/coreBundle');

const CAPABILITIES = ['core', 'pdf', 'storage', 'vision', 'network'];
const toolByName = new Map(
  tools.filteredTools({ capabilities: CAPABILITIES }).map(tool => [tool.schema.name, tool]),
);

/** Maps a CLI argv onto a tool call and validates it against the tool schema. */
function call(argv) {
  const [name, ...rest] = argv;
  const command = findCommand(name);
  assert.ok(command, `unknown command: ${name}`);
  const { positional, flags } = parseArgv(rest, command.valueFlags ?? []);
  const { tool: toolName, arguments: args } = command.build(positional, flags);
  const tool = toolByName.get(toolName);
  assert.ok(tool, `unknown tool: ${toolName}`);
  const parsed = tool.schema.inputSchema.safeParse(args);
  assert.ok(
    parsed.success,
    `${argv.join(' ')} -> ${toolName}: ${JSON.stringify(parsed.error?.issues)}`,
  );
  return args;
}

// ─── every command must produce a schema-valid tool call ───────────────

const samples = [
  ['navigate', 'https://example.com'],
  ['back'],
  ['reload'],
  ['snapshot'],
  ['snapshot', '--depth', '2', '--boxes'],
  ['click', 'e12'],
  ['click', 'e12', '--double', '--button', 'right', '--modifiers', 'Shift,Control'],
  ['hover', 'e3'],
  ['type', 'e4', 'hello', '--submit'],
  ['fill', '#a=hello', '#b=world'],
  ['fill', '#agree=false', '--type', 'checkbox'],
  ['press', 'Enter'],
  ['select', 'e5', 'blue'],
  ['screenshot'],
  ['screenshot', 'shot.png', '--full', '--scale', 'device'],
  ['pdf'],
  ['eval', '() => document.title'],
  ['run', 'script.js'],
  ['console'],
  ['console', '--level', 'error', '--all'],
  ['network', '--filter', '/api/', '--static'],
  ['request', '1', '--part', 'response-body'],
  ['find', 'hello'],
  ['find', '--regex', '/err/i'],
  ['wait', '--time', '2'],
  ['wait', '--text', 'Done'],
  ['wait', '--text-gone', 'Loading'],
  ['tabs'],
  ['tabs', 'list'],
  ['tabs', 'new', 'https://example.com'],
  ['tabs', 'select', '1'],
  ['tabs', 'close'],
  ['tabs', 'close', '1'],
  ['resize', '1280', '720'],
  ['dialog', 'accept'],
  ['dialog', 'reject', '--text', 'hi'],
  ['drag', 'e1', 'e2'],
  ['emulate', '--color-scheme', 'dark'],
  ['cookies'],
  ['cookies', 'get', 'sid'],
  ['cookies', 'set', 'sid=abc'],
  ['cookies', 'delete', 'sid'],
  ['cookies', 'clear'],
  ['close'],
];

for (const argv of samples) {
  call(argv);
  console.log(`✓ ${argv.join(' ')}`);
}

// ─── specific regressions ─────────────────────────────────────────────

// browser_fill_form requires target + name + type + value; sending only
// target and value silently failed schema validation.
const fields = call(['fill', '#a=hello']).fields;
assert.deepStrictEqual(fields[0], { target: '#a', name: '#a', type: 'textbox', value: 'hello' });
console.log('✓ fill sends the required name/type fields');

// `tabs close` without an index closes the current tab.
assert.deepStrictEqual(call(['tabs', 'close']), { action: 'close' });
assert.deepStrictEqual(call(['tabs', 'close', '3']), { action: 'close', index: 3 });
console.log('✓ tabs close treats the index as optional');

// Invalid input must be rejected before reaching the browser.
assert.throws(() => call(['tabs', 'select']), /tabs select <index>/);
assert.throws(() => call(['tabs', 'close', 'abc']), /Expected a tab index/);
assert.throws(() => call(['fill', 'no-equals-sign']), /Expected <target>=<value>/);
console.log('✓ invalid arguments are rejected locally');

console.log('\nAll argument tests passed.');
