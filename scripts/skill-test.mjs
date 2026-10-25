/**
 * Offline test for the skill installer: no browser, no daemon, no extension.
 *
 * It covers three things:
 *   1) the bundled skill is a valid Agent Skills package,
 *   2) the command reference inside the skill has not drifted from the code,
 *   3) `pwcli install --skills` puts the files where it says it does.
 *
 * Usage: node scripts/skill-test.mjs
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { commands } = require('../dist/commands.js');
const { bundledSkillDir, installSkill, resolveSkillTargets, skillTargets } = require('../dist/skill.js');

const SKILL_NAME = 'playwright-extension-cli';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pwcli-skill-'));
const project = path.join(temp, 'project');
const home = path.join(temp, 'home');
fs.mkdirSync(project);
fs.mkdirSync(home);

function cleanup() {
  fs.rmSync(temp, { recursive: true, force: true });
}

// ─── the bundled skill is a valid Agent Skills package ─────────────────

const source = bundledSkillDir();
assert.ok(source.endsWith(path.join('skills', SKILL_NAME)), `unexpected source dir: ${source}`);

const skillMd = fs.readFileSync(path.join(source, 'SKILL.md'), 'utf-8');
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
assert.ok(frontmatter, 'SKILL.md must start with YAML frontmatter');

const name = /^name:\s*(.+)$/m.exec(frontmatter[1])?.[1].trim();
const description = /^description:\s*(.+)$/m.exec(frontmatter[1])?.[1].trim();

assert.equal(name, SKILL_NAME, 'the name must match the folder name');
assert.ok(name.length >= 1 && name.length <= 64, 'the name must be 1-64 characters');
assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name), 'the name must be lowercase alphanumeric with hyphens');
assert.ok(description && description.length >= 1, 'the description is required');
assert.ok(description.length <= 1024, 'the description must be at most 1024 characters');
console.log('✓ SKILL.md has valid frontmatter');

// ─── the skill documents every command the CLI has ─────────────────────

const reference = fs.readFileSync(path.join(source, 'references', 'commands.md'), 'utf-8');
for (const command of commands)
  assert.ok(reference.includes(`pwcli ${command.name}`), `command not documented: ${command.name}`);
for (const name of ['connect', 'disconnect', 'status', 'doctor', 'tools', 'mcp', 'install'])
  assert.ok(reference.includes(`pwcli ${name}`), `session command not documented: ${name}`);
console.log(`✓ all ${commands.length} commands are documented in references/commands.md`);

// ─── installation puts the files where it says it does ─────────────────

const projectInstall = installSkill({ targets: ['agents'], cwd: project, homeDir: home, env: {} });
assert.equal(projectInstall.scope, 'project');
assert.equal(projectInstall.installed.length, 1);
assert.equal(projectInstall.installed[0].id, 'agents');
assert.ok(fs.existsSync(path.join(project, '.agents', 'skills', SKILL_NAME, 'SKILL.md')));
assert.ok(fs.existsSync(path.join(project, '.agents', 'skills', SKILL_NAME, 'references', 'commands.md')));
console.log('✓ project scope installs into .agents/skills');

const userInstall = installSkill({ targets: ['claude'], global: true, cwd: project, homeDir: home, env: {} });
assert.equal(userInstall.scope, 'user');
assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', SKILL_NAME, 'SKILL.md')));
console.log('✓ global scope installs into the home directory');

const customInstall = installSkill({ customDir: path.join(temp, 'custom'), cwd: project, homeDir: home, env: {} });
assert.equal(customInstall.scope, 'custom');
assert.ok(fs.existsSync(path.join(temp, 'custom', SKILL_NAME, 'SKILL.md')));
console.log('✓ a custom directory is honoured');

// Re-running is a no-op, and a locally edited skill is replaced again.
const again = installSkill({ targets: ['agents'], cwd: project, homeDir: home, env: {} });
assert.equal(again.installed[0].status, 'unchanged');

const installedSkill = path.join(project, '.agents', 'skills', SKILL_NAME, 'SKILL.md');
fs.writeFileSync(installedSkill, 'local edit\n');
const replaced = installSkill({ targets: ['agents'], cwd: project, homeDir: home, env: {} });
assert.equal(replaced.installed[0].status, 'replaced');
assert.ok(replaced.warnings.length > 0, 'replacing a modified skill must warn');
assert.equal(fs.readFileSync(installedSkill, 'utf-8'), skillMd);
console.log('✓ re-installing is idempotent and restores the bundled copy');

// ─── target resolution ─────────────────────────────────────────────────

const aliased = installSkill({ targets: ['codex'], cwd: project, homeDir: home, env: {} });
assert.equal(aliased.installed[0].id, 'agents', 'codex is an alias for agents');

const all = installSkill({ targets: ['all'], cwd: project, homeDir: home, env: {} });
assert.equal(all.installed.length, skillTargets.length);

assert.throws(() => installSkill({ targets: ['nope'], cwd: project, homeDir: home }), /Unknown skill target/);
console.log('✓ targets, aliases and typos are handled');

// Without an explicit target the installer looks at the machine first.
const detectHome = path.join(temp, 'detect-home');
const emptyProject = path.join(temp, 'empty-project');
fs.mkdirSync(detectHome);
fs.mkdirSync(emptyProject);
assert.equal(resolveSkillTargets(undefined, { cwd: emptyProject, homeDir: detectHome })[0].id, 'claude');
fs.mkdirSync(path.join(detectHome, '.kimi-code'), { recursive: true });
assert.deepStrictEqual(
  resolveSkillTargets(undefined, { cwd: emptyProject, homeDir: detectHome }).map(target => target.id),
  ['kimi'],
);

// A project folder that already holds skills wins over the home directory.
const detectProject = path.join(temp, 'detect-project');
fs.mkdirSync(path.join(detectProject, '.agents', 'skills'), { recursive: true });
assert.deepStrictEqual(
  resolveSkillTargets(undefined, { cwd: detectProject, homeDir: detectHome }).map(target => target.id),
  ['agents'],
);

// Kimi keeps its own user folder in KIMI_CODE_HOME when that is set.
const kimiHome = path.join(temp, 'kimi-home');
const kimi = installSkill({ targets: ['kimi'], global: true, cwd: project, homeDir: home, env: { KIMI_CODE_HOME: kimiHome } });
assert.equal(kimi.installed[0].directory, path.join(kimiHome, 'skills', SKILL_NAME));
console.log('✓ KIMI_CODE_HOME is respected');

// ─── the CLI itself ────────────────────────────────────────────────────

function runCli(args) {
  return spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf-8' });
}

const cliTarget = path.join(temp, 'cli-target');
const installed = runCli(['install', '--skills=agents', '--skills-dir', cliTarget]);
assert.equal(installed.status, 0, installed.stderr);
assert.match(installed.stdout, /Installed skill "playwright-extension-cli"/);
assert.ok(fs.existsSync(path.join(cliTarget, SKILL_NAME, 'SKILL.md')));
console.log('✓ `pwcli install --skills --skills-dir <path>` works end to end');

const unknown = runCli(['install', '--skills=nope']);
assert.notEqual(unknown.status, 0);
assert.match(unknown.stderr, /Unknown skill target/);

const bare = runCli(['install']);
assert.notEqual(bare.status, 0);
assert.match(bare.stderr, /pwcli install --skills/);

const help = runCli(['install', '--help']);
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /Targets:/);
console.log('✓ bad input fails loudly and --help explains the targets');

cleanup();
console.log('\nAll skill tests passed.');
