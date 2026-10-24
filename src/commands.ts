/**
 * Command table: maps a CLI invocation onto an upstream Playwright MCP tool
 * call.
 *
 * The CLI is a thin shell over the same tool layer the MCP server uses, so
 * behaviour (aria refs, snapshot format, action semantics) stays identical.
 */

import path from 'path';

export type ToolCall = {
  tool: string;
  arguments: Record<string, any>;
};

export type CommandSpec = {
  name: string;
  usage: string;
  summary: string;
  /** Flags that consume the next argument; every other flag is boolean. */
  valueFlags?: string[];
  build: (positional: string[], flags: Record<string, string | boolean>) => ToolCall;
};

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function need(positional: string[], index: number, usage: string): string {
  const value = positional[index];
  if (value === undefined)
    throw new UsageError(`Missing argument. Usage: ${usage}`);
  return value;
}

function needFlag(flags: Record<string, string | boolean>, name: string, usage: string): string {
  const value = flags[name];
  if (typeof value !== 'string')
    throw new UsageError(`Missing --${name}. Usage: ${usage}`);
  return value;
}

function boolFlag(flags: Record<string, string | boolean>, name: string): boolean {
  const value = flags[name];
  if (value === undefined)
    return false;
  if (typeof value === 'boolean')
    return value;
  return value !== 'false' && value !== '0';
}

function numberFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const value = flags[name];
  if (typeof value !== 'string')
    return undefined;
  const parsed = Number(value);
  if (Number.isNaN(parsed))
    throw new UsageError(`--${name} must be a number, got "${value}"`);
  return parsed;
}

export const commands: CommandSpec[] = [
  {
    name: 'navigate',
    usage: 'navigate <url>',
    summary: 'Navigate the current tab to a URL',
    build: positional => ({ tool: 'browser_navigate', arguments: { url: need(positional, 0, 'navigate <url>') } }),
  },
  {
    name: 'back',
    usage: 'back',
    summary: 'Go back in the current tab history',
    build: () => ({ tool: 'browser_navigate_back', arguments: {} }),
  },
  {
    name: 'reload',
    usage: 'reload',
    summary: 'Reload the current page',
    build: () => ({ tool: 'browser_evaluate', arguments: { function: '() => location.reload()' } }),
  },
  {
    name: 'snapshot',
    usage: 'snapshot [--target <ref>] [--depth <n>] [--boxes]',
    summary: 'Print the accessibility snapshot (with [ref=eN] handles)',
    valueFlags: ['target', 'depth'],
    build: (positional, flags) => ({
      tool: 'browser_snapshot',
      arguments: {
        ...(typeof flags.target === 'string' ? { target: flags.target } : {}),
        ...(numberFlag(flags, 'depth') !== undefined ? { depth: numberFlag(flags, 'depth') } : {}),
        ...(boolFlag(flags, 'boxes') ? { boxes: true } : {}),
      },
    }),
  },
  {
    name: 'click',
    usage: 'click <target> [--double] [--button <left|right|middle>] [--modifiers <keys>]',
    summary: 'Click an element by ref (e.g. e12) or CSS selector',
    valueFlags: ['button', 'modifiers'],
    build: (positional, flags) => ({
      tool: 'browser_click',
      arguments: {
        target: need(positional, 0, 'click <target>'),
        ...(boolFlag(flags, 'double') ? { doubleClick: true } : {}),
        ...(typeof flags.button === 'string' ? { button: flags.button } : {}),
        ...(typeof flags.modifiers === 'string' ? { modifiers: flags.modifiers.split(',').map(m => m.trim()).filter(Boolean) } : {}),
      },
    }),
  },
  {
    name: 'hover',
    usage: 'hover <target>',
    summary: 'Hover over an element',
    build: positional => ({ tool: 'browser_hover', arguments: { target: need(positional, 0, 'hover <target>') } }),
  },
  {
    name: 'type',
    usage: 'type <target> <text> [--submit] [--slowly]',
    summary: 'Type text into an element',
    valueFlags: [],
    build: (positional, flags) => ({
      tool: 'browser_type',
      arguments: {
        target: need(positional, 0, 'type <target> <text>'),
        text: need(positional, 1, 'type <target> <text>'),
        ...(boolFlag(flags, 'submit') ? { submit: true } : {}),
        ...(boolFlag(flags, 'slowly') ? { slowly: true } : {}),
      },
    }),
  },
  {
    name: 'fill',
    usage: 'fill <target=value> [...] [--type <textbox|checkbox|radio|combobox|slider>]',
    summary: 'Fill several fields at once (target=value pairs; default type textbox)',
    valueFlags: ['type'],
    build: (positional, flags) => {
      if (!positional.length)
        throw new UsageError('Missing argument. Usage: fill <target=value> [<target=value> ...]');
      // browser_fill_form requires name and type alongside target and value.
      // The name is only a human-readable label for the permission prompt, so
      // the target doubles as the name.
      const type = typeof flags.type === 'string' ? flags.type : 'textbox';
      const fields = positional.map(entry => {
        const index = entry.indexOf('=');
        if (index === -1)
          throw new UsageError(`Expected <target>=<value>, got "${entry}"`);
        const target = entry.slice(0, index);
        return { target, name: target, type, value: entry.slice(index + 1) };
      });
      return { tool: 'browser_fill_form', arguments: { fields } };
    },
  },
  {
    name: 'press',
    usage: 'press <key>',
    summary: 'Press a key (Enter, ArrowLeft, a, ...)',
    build: positional => ({ tool: 'browser_press_key', arguments: { key: need(positional, 0, 'press <key>') } }),
  },
  {
    name: 'select',
    usage: 'select <target> <value>',
    summary: 'Select an option in a dropdown',
    build: positional => ({
      tool: 'browser_select_option',
      arguments: {
        target: need(positional, 0, 'select <target> <value>'),
        values: [need(positional, 1, 'select <target> <value>')],
      },
    }),
  },
  {
    name: 'screenshot',
    usage: 'screenshot [path] [--full] [--target <ref>] [--scale <css|device>] [--type <png|jpeg|webp>]',
    summary: 'Take a screenshot (defaults to the output directory)',
    valueFlags: ['target', 'scale', 'type'],
    build: (positional, flags) => ({
      tool: 'browser_take_screenshot',
      arguments: {
        ...(positional[0] ? { filename: positional[0] } : {}),
        ...(boolFlag(flags, 'full') ? { fullPage: true } : {}),
        ...(typeof flags.target === 'string' ? { target: flags.target } : {}),
        ...(typeof flags.scale === 'string' ? { scale: flags.scale } : {}),
        ...(typeof flags.type === 'string' ? { type: flags.type } : {}),
      },
    }),
  },
  {
    name: 'pdf',
    usage: 'pdf [path]',
    summary: 'Save the page as PDF',
    valueFlags: [],
    build: positional => ({
      tool: 'browser_pdf_save',
      arguments: { ...(positional[0] ? { filename: positional[0] } : {}) },
    }),
  },
  {
    name: 'eval',
    usage: 'eval <function>',
    summary: 'Evaluate a function in the page, e.g. "() => document.title"',
    build: positional => ({
      tool: 'browser_evaluate',
      arguments: { function: need(positional, 0, 'eval <function>') },
    }),
  },
  {
    name: 'run',
    usage: 'run <file.js>',
    summary: 'Run a Playwright snippet: async (page) => { ... }',
    build: positional => {
      const file = need(positional, 0, 'run <file.js>');
      return { tool: 'browser_run_code_unsafe', arguments: { filename: file } };
    },
  },
  {
    name: 'console',
    usage: 'console [--level <error|warning|info|debug>] [--all]',
    summary: 'Show console messages',
    valueFlags: ['level'],
    build: (positional, flags) => ({
      tool: 'browser_console_messages',
      arguments: {
        level: typeof flags.level === 'string' ? flags.level : 'info',
        ...(boolFlag(flags, 'all') ? { all: true } : {}),
      },
    }),
  },
  {
    name: 'network',
    usage: 'network [--filter <regexp>] [--static]',
    summary: 'List network requests',
    valueFlags: ['filter'],
    build: (positional, flags) => ({
      tool: 'browser_network_requests',
      arguments: {
        static: boolFlag(flags, 'static'),
        ...(typeof flags.filter === 'string' ? { filter: flags.filter } : {}),
      },
    }),
  },
  {
    name: 'request',
    usage: 'request <index> [--part <request-headers|request-body|response-headers|response-body>]',
    summary: 'Show details of one network request',
    valueFlags: ['part'],
    build: (positional, flags) => ({
      tool: 'browser_network_request',
      arguments: {
        index: Number(need(positional, 0, 'request <index>')),
        ...(typeof flags.part === 'string' ? { part: flags.part } : {}),
      },
    }),
  },
  {
    name: 'find',
    usage: 'find <text> [--regex <pattern>]',
    summary: 'Find text in the page snapshot',
    valueFlags: ['regex'],
    build: (positional, flags) => ({
      tool: 'browser_find',
      arguments: {
        ...(positional[0] ? { text: positional[0] } : {}),
        ...(typeof flags.regex === 'string' ? { regex: flags.regex } : {}),
      },
    }),
  },
  {
    name: 'wait',
    usage: 'wait [--time <seconds>] [--text <text>] [--text-gone <text>]',
    summary: 'Wait for time or for text to appear/disappear',
    valueFlags: ['time', 'text', 'text-gone'],
    build: (positional, flags) => ({
      tool: 'browser_wait_for',
      arguments: {
        ...(numberFlag(flags, 'time') !== undefined ? { time: numberFlag(flags, 'time') } : {}),
        ...(typeof flags.text === 'string' ? { text: flags.text } : {}),
        ...(typeof flags['text-gone'] === 'string' ? { textGone: flags['text-gone'] } : {}),
      },
    }),
  },
  {
    name: 'tabs',
    usage: 'tabs [list|new <url>|select <index>|close [index]]',
    summary: 'List or manage tabs',
    valueFlags: [],
    build: positional => {
      const action = positional[0] ?? 'list';
      const args: Record<string, any> = { action };
      const optionalIndex = () => {
        const raw = positional[1];
        if (raw === undefined)
          return undefined;
        const index = Number(raw);
        if (Number.isNaN(index))
          throw new UsageError(`Expected a tab index, got "${raw}"`);
        return index;
      };
      if (action === 'new')
        args.url = need(positional, 1, 'tabs new <url>');
      if (action === 'select') {
        const index = optionalIndex();
        if (index === undefined)
          throw new UsageError('Missing argument. Usage: tabs select <index>');
        args.index = index;
      }
      if (action === 'close') {
        // Omit the index to close the current tab (upstream default).
        const index = optionalIndex();
        if (index !== undefined)
          args.index = index;
      }
      return { tool: 'browser_tabs', arguments: args };
    },
  },
  {
    name: 'resize',
    usage: 'resize <width> <height>',
    summary: 'Resize the browser window',
    build: positional => ({
      tool: 'browser_resize',
      arguments: {
        width: Number(need(positional, 0, 'resize <width> <height>')),
        height: Number(need(positional, 1, 'resize <width> <height>')),
      },
    }),
  },
  {
    name: 'upload',
    usage: 'upload <path> [<path> ...]',
    summary: 'Upload files to the file chooser',
    build: positional => ({
      tool: 'browser_file_upload',
      arguments: { paths: positional.map(p => path.resolve(p)) },
    }),
  },
  {
    name: 'dialog',
    usage: 'dialog <accept|reject> [--text <prompt text>]',
    summary: 'Handle the pending dialog',
    valueFlags: ['text'],
    build: (positional, flags) => ({
      tool: 'browser_handle_dialog',
      arguments: {
        accept: need(positional, 0, 'dialog <accept|reject>').toLowerCase() !== 'reject',
        ...(typeof flags.text === 'string' ? { promptText: flags.text } : {}),
      },
    }),
  },
  {
    name: 'drag',
    usage: 'drag <startTarget> <endTarget>',
    summary: 'Drag one element onto another',
    build: positional => ({
      tool: 'browser_drag',
      arguments: {
        startTarget: need(positional, 0, 'drag <startTarget> <endTarget>'),
        endTarget: need(positional, 1, 'drag <startTarget> <endTarget>'),
      },
    }),
  },
  {
    name: 'emulate',
    usage: 'emulate [--color-scheme <light|dark>] [--reduced-motion <reduce|no-preference>]',
    summary: 'Emulate media features',
    valueFlags: ['color-scheme', 'reduced-motion', 'forced-colors', 'contrast', 'media'],
    build: (positional, flags) => ({
      tool: 'browser_emulate_media',
      arguments: {
        ...(typeof flags['color-scheme'] === 'string' ? { colorScheme: flags['color-scheme'] } : {}),
        ...(typeof flags['reduced-motion'] === 'string' ? { reducedMotion: flags['reduced-motion'] } : {}),
        ...(typeof flags['forced-colors'] === 'string' ? { forcedColors: flags['forced-colors'] } : {}),
        ...(typeof flags.contrast === 'string' ? { contrast: flags.contrast } : {}),
        ...(typeof flags.media === 'string' ? { media: flags.media } : {}),
      },
    }),
  },
  {
    name: 'cookies',
    usage: 'cookies [list|get <name>|set <name>=<value>|delete <name>|clear]',
    summary: 'Inspect or modify cookies',
    build: positional => {
      const action = positional[0] ?? 'list';
      if (action === 'list')
        return { tool: 'browser_cookie_list', arguments: {} };
      if (action === 'get')
        return { tool: 'browser_cookie_get', arguments: { name: need(positional, 1, 'cookies get <name>') } };
      if (action === 'set') {
        const entry = need(positional, 1, 'cookies set <name>=<value>');
        const index = entry.indexOf('=');
        if (index === -1)
          throw new UsageError('Expected <name>=<value>');
        return { tool: 'browser_cookie_set', arguments: { name: entry.slice(0, index), value: entry.slice(index + 1) } };
      }
      if (action === 'delete')
        return { tool: 'browser_cookie_delete', arguments: { name: need(positional, 1, 'cookies delete <name>') } };
      if (action === 'clear')
        return { tool: 'browser_cookie_clear', arguments: {} };
      throw new UsageError(`Unknown cookies action: ${action}`);
    },
  },
  {
    name: 'close',
    usage: 'close',
    summary: 'Close the current page',
    build: () => ({ tool: 'browser_close', arguments: {} }),
  },
];

export function findCommand(name: string): CommandSpec | undefined {
  return commands.find(command => command.name === name);
}

/**
 * Splits argv into positional arguments and flags.
 *
 * Flags listed in `valueFlags` consume the next argument; everything else is
 * a boolean switch.
 */
export function parseArgv(argv: string[], valueFlags: string[] = []): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const name = arg.slice(2);
    if (valueFlags.includes(name) && argv[i + 1] !== undefined) {
      flags[name] = argv[++i];
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}
