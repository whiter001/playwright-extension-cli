/**
 * Skill installation: copies the bundled agent skill (SKILL.md + references/)
 * into the skills folder of the coding agents that speak the Agent Skills
 * format.
 *
 * The spec defines the *file* (a folder with SKILL.md next to optional
 * references/, scripts/ and assets/), not where that folder lives — every
 * client picked its own layout. The table below records where the well-known
 * ones look, so one command can target any of them.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { UsageError } from './commands';

export const skillName = 'playwright-mcp-cli';

export type SkillScope = 'project' | 'user' | 'custom';

export type SkillTarget = {
  /** Id accepted on the command line. */
  id: string;
  /** Human readable agent name. */
  label: string;
  /** Folder that holds the skill, relative to the project root. */
  projectDir: string;
  /** Folder that holds the skill, relative to the home directory. */
  userDir: string;
  /** Home-relative folders that tell us the agent is installed. */
  detect: string[];
  /** Project-relative folders that tell us the agent is used here. */
  detectProject: string[];
  /** Alternative ids accepted on the command line. */
  aliases?: string[];
  /** When set, replaces the home-relative folder with `<value>/<basename>`. */
  homeEnvVar?: string;
};

/**
 * Where each agent looks for skills.
 *
 * Claude Code only reads `.claude/skills`, while Codex, GitHub Copilot,
 * Cursor, Gemini CLI and Kimi Code all read the shared `.agents/skills`
 * convention — that is why one copy is not enough for a team.
 */
export const skillTargets: SkillTarget[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    projectDir: '.claude/skills',
    userDir: '.claude/skills',
    detect: ['.claude'],
    detectProject: ['.claude/skills'],
  },
  {
    id: 'agents',
    label: '共享 .agents 约定（Codex / Copilot / Cursor / Gemini / Kimi）',
    projectDir: '.agents/skills',
    userDir: '.agents/skills',
    detect: ['.agents'],
    detectProject: ['.agents/skills'],
    aliases: ['codex', 'shared'],
  },
  {
    id: 'kimi',
    label: 'Kimi Code',
    projectDir: '.kimi-code/skills',
    userDir: '.kimi-code/skills',
    detect: ['.kimi-code', '.kimi'],
    detectProject: ['.kimi-code/skills'],
    homeEnvVar: 'KIMI_CODE_HOME',
  },
  {
    id: 'codebuddy',
    label: 'CodeBuddy',
    projectDir: '.codebuddy/skills',
    userDir: '.codebuddy/skills',
    detect: ['.codebuddy'],
    detectProject: ['.codebuddy/skills'],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    projectDir: '.cursor/skills',
    userDir: '.cursor/skills',
    detect: ['.cursor'],
    detectProject: ['.cursor/skills'],
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    projectDir: '.gemini/skills',
    userDir: '.gemini/skills',
    detect: ['.gemini'],
    detectProject: ['.gemini/skills'],
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    projectDir: '.github/skills',
    userDir: '.copilot/skills',
    detect: ['.copilot'],
    detectProject: ['.github/skills'],
  },
];

export function skillTargetIds(): string[] {
  return skillTargets.map(target => target.id);
}

/** True when the name is a target id, an alias, or `all`. */
export function isSkillTargetName(name: string): boolean {
  const key = name.trim().toLowerCase();
  if (key === 'all')
    return true;
  return skillTargets.some(target => target.id === key || (target.aliases ?? []).includes(key));
}

function findTarget(name: string): SkillTarget | undefined {
  const key = name.trim().toLowerCase();
  return skillTargets.find(target => target.id === key || (target.aliases ?? []).includes(key));
}

export type TargetEnvironment = {
  cwd: string;
  homeDir: string;
};

/**
 * Picks the targets to install into.
 *
 * With an explicit selection we honour it (and fail loudly on typos). Without
 * one we look at the machine: project folders first, then the home directory,
 * and fall back to Claude Code so the command always does something useful.
 */
export function resolveSkillTargets(selection: string[] | undefined, environment: TargetEnvironment): SkillTarget[] {
  if (selection && selection.length) {
    const resolved: SkillTarget[] = [];
    for (const name of selection) {
      if (name.trim().toLowerCase() === 'all') {
        for (const target of skillTargets)
          if (!resolved.includes(target))
            resolved.push(target);
        continue;
      }
      const target = findTarget(name);
      if (!target)
        throw new UsageError(`Unknown skill target "${name}". Available targets: ${skillTargetIds().join(', ')}, all`);
      if (!resolved.includes(target))
        resolved.push(target);
    }
    return resolved;
  }

  const projectHits = skillTargets.filter(target =>
    target.detectProject.some(marker => fs.existsSync(path.join(environment.cwd, marker))),
  );
  if (projectHits.length)
    return projectHits;

  const homeHits = skillTargets.filter(target =>
    target.detect.some(marker => fs.existsSync(path.join(environment.homeDir, marker))),
  );
  if (homeHits.length)
    return homeHits;

  return [skillTargets[0]];
}

/** The skill folder shipped inside the package. */
export function bundledSkillDir(): string {
  let dir = __dirname;
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, 'skills', skillName);
    if (fs.existsSync(path.join(candidate, 'SKILL.md')))
      return candidate;
    const parent = path.dirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  throw new Error(`Bundled skill not found: expected skills/${skillName}/SKILL.md above ${__dirname}.`);
}

export type InstalledSkill = {
  id: string;
  label: string;
  directory: string;
  files: number;
  status: 'created' | 'replaced' | 'unchanged';
};

export type InstallResult = {
  skill: string;
  scope: SkillScope;
  installed: InstalledSkill[];
  warnings: string[];
};

export type InstallOptions = {
  /** Target ids; `undefined` means "detect what is installed". */
  targets?: string[];
  /** Install into the user-level folders instead of the project folders. */
  global?: boolean;
  /** Install into this directory instead of any agent folder. */
  customDir?: string;
  cwd?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
};

function listFiles(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory())
      files.push(...listFiles(path.join(dir, entry.name), relative));
    else
      files.push(relative);
  }
  return files;
}

function sameContent(source: string, destination: string, files: string[]): boolean {
  const existing = listFiles(destination);
  if (existing.length !== files.length)
    return false;
  return files.every(relative => {
    const from = path.join(source, ...relative.split('/'));
    const to = path.join(destination, ...relative.split('/'));
    if (!fs.existsSync(to))
      return false;
    return fs.readFileSync(from).equals(fs.readFileSync(to));
  });
}

function copySkill(source: string, destination: string): { files: number; status: InstalledSkill['status'] } {
  const files = listFiles(source);
  const existed = fs.existsSync(destination);
  if (existed && sameContent(source, destination, files))
    return { files: files.length, status: 'unchanged' };

  // Replace wholesale so a renamed reference file does not linger next to the
  // new one. The folder only ever holds the bundled skill.
  fs.rmSync(destination, { recursive: true, force: true });
  for (const relative of files) {
    const from = path.join(source, ...relative.split('/'));
    const to = path.join(destination, ...relative.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  return { files: files.length, status: existed ? 'replaced' : 'created' };
}

function userDirFor(target: SkillTarget, homeDir: string, env: NodeJS.ProcessEnv): string {
  if (target.homeEnvVar) {
    const base = env[target.homeEnvVar];
    if (base)
      return path.join(base, path.basename(target.userDir));
  }
  return path.join(homeDir, target.userDir);
}

/**
 * Installs the bundled skill and reports what happened.
 *
 * Directories are de-duplicated by their resolved path, so asking for two
 * targets that share a folder (for example `agents` and `codex`) installs once.
 */
export function installSkill(options: InstallOptions = {}): InstallResult {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? os.homedir();
  const env = options.env ?? process.env;
  const source = bundledSkillDir();
  const warnings: string[] = [];

  if (options.customDir) {
    const base = path.resolve(cwd, options.customDir);
    const directory = path.join(base, skillName);
    const { files, status } = copySkill(source, directory);
    if (status === 'replaced')
      warnings.push(`${directory} 里已有不同内容的 skill，已用内置版本覆盖。`);
    return {
      skill: skillName,
      scope: 'custom',
      installed: [{ id: 'custom', label: path.basename(base), directory, files, status }],
      warnings,
    };
  }

  const scope: SkillScope = options.global ? 'user' : 'project';
  const targets = resolveSkillTargets(options.targets, { cwd, homeDir });
  const installed: InstalledSkill[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    const base = scope === 'user' ? userDirFor(target, homeDir, env) : path.resolve(cwd, target.projectDir);
    const directory = path.join(base, skillName);
    // Windows paths are case-insensitive: the same folder can be reached with
    // different spellings, so normalise before de-duplicating.
    const key = path.resolve(directory).toLowerCase();
    if (seen.has(key))
      continue;
    seen.add(key);

    const { files, status } = copySkill(source, directory);
    installed.push({ id: target.id, label: target.label, directory, files, status });
    if (status === 'replaced')
      warnings.push(`${target.label}: ${directory} 里已有不同内容的 skill，已用内置版本覆盖。`);
  }

  return { skill: skillName, scope, installed, warnings };
}
