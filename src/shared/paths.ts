import { join, dirname, basename, sep, resolve } from 'path';
import { homedir } from 'os';
import { existsSync, mkdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { SettingsDefaultsManager } from './SettingsDefaultsManager.js';
import { logger } from '../utils/logger.js';
import { detectWorktree } from '../utils/worktree.js';

// Get __dirname that works in both ESM (hooks) and CJS (worker) contexts
function getDirname(): string {
  // CJS context - __dirname exists
  if (typeof __dirname !== 'undefined') {
    return __dirname;
  }
  // ESM context - use import.meta.url
  return dirname(fileURLToPath(import.meta.url));
}

const _dirname = getDirname();

/**
 * Simple path configuration for claude-mem
 * Standard paths based on Claude Code conventions
 */

// Base directories
export const DATA_DIR = process.env.CLAUDE_MEM_DATA_DIR || SettingsDefaultsManager.get('CLAUDE_MEM_DATA_DIR');
// Note: CLAUDE_CONFIG_DIR is a Claude Code setting, not claude-mem, so leave as env var
export const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// Plugin installation directory - respects CLAUDE_CONFIG_DIR for users with custom Claude locations
export const MARKETPLACE_ROOT = join(CLAUDE_CONFIG_DIR, 'plugins', 'marketplaces', 'thedotmack');

// Data subdirectories
export const ARCHIVES_DIR = join(DATA_DIR, 'archives');
export const LOGS_DIR = join(DATA_DIR, 'logs');
export const TRASH_DIR = join(DATA_DIR, 'trash');
export const BACKUPS_DIR = join(DATA_DIR, 'backups');
export const MODES_DIR = join(DATA_DIR, 'modes');
export const USER_SETTINGS_PATH = join(DATA_DIR, 'settings.json');
export const DB_PATH = join(DATA_DIR, 'claude-mem.db');
export const VECTOR_DB_DIR = join(DATA_DIR, 'vector-db');

// Observer sessions directory - used as cwd for SDK queries
// Sessions here won't appear in user's `claude --resume` for their actual projects
export const OBSERVER_SESSIONS_DIR = join(DATA_DIR, 'observer-sessions');

// Claude integration paths
export const CLAUDE_SETTINGS_PATH = join(CLAUDE_CONFIG_DIR, 'settings.json');
export const CLAUDE_COMMANDS_DIR = join(CLAUDE_CONFIG_DIR, 'commands');
export const CLAUDE_MD_PATH = join(CLAUDE_CONFIG_DIR, 'CLAUDE.md');

/**
 * Get project-specific archive directory
 */
export function getProjectArchiveDir(projectName: string): string {
  return join(ARCHIVES_DIR, projectName);
}

/**
 * Get worker socket path for a session
 */
export function getWorkerSocketPath(sessionId: number): string {
  return join(DATA_DIR, `worker-${sessionId}.sock`);
}

/**
 * Ensure a directory exists
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

/**
 * Ensure all data directories exist
 */
export function ensureAllDataDirs(): void {
  ensureDir(DATA_DIR);
  ensureDir(ARCHIVES_DIR);
  ensureDir(LOGS_DIR);
  ensureDir(TRASH_DIR);
  ensureDir(BACKUPS_DIR);
  ensureDir(MODES_DIR);
}

/**
 * Ensure modes directory exists
 */
export function ensureModesDir(): void {
  ensureDir(MODES_DIR);
}

/**
 * Ensure all Claude integration directories exist
 */
export function ensureAllClaudeDirs(): void {
  ensureDir(CLAUDE_CONFIG_DIR);
  ensureDir(CLAUDE_COMMANDS_DIR);
}

/**
 * Get current project name from git root or cwd.
 * Includes parent directory to avoid collisions when repos share a folder name
 * (e.g., ~/work/monorepo → "work/monorepo" vs ~/personal/monorepo → "personal/monorepo").
 */
export function getCurrentProjectName(): string {
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    }).trim();
    return basename(dirname(gitRoot)) + '/' + basename(gitRoot);
  } catch (error) {
    logger.debug('SYSTEM', 'Git root detection failed, using cwd basename', {
      cwd: process.cwd()
    }, error as Error);
    const cwd = process.cwd();
    return basename(dirname(cwd)) + '/' + basename(cwd);
  }
}

/**
 * Find package root directory
 *
 * Works because bundled hooks are in plugin/scripts/,
 * so package root is always one level up (the plugin directory)
 */
export function getPackageRoot(): string {
  return join(_dirname, '..');
}

/**
 * Find commands directory in the installed package
 */
export function getPackageCommandsDir(): string {
  const packageRoot = getPackageRoot();
  return join(packageRoot, 'commands');
}

/**
 * Create a timestamped backup filename
 */
export function createBackupFilename(originalPath: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);

  return `${originalPath}.backup.${timestamp}`;
}

/**
 * Walk up from startDir looking for a .git file or directory.
 *
 * Returns the directory containing .git, or null if none found.
 */
function findGitRoot(startDir: string): string | null {
  let dir = startDir;
  while (true) {
    try {
      statSync(join(dir, '.git'));
      return dir;
    } catch {
      // not found, keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Workspace parent heuristic: if gitRoot's parent has CLAUDE.md or .claude/,
 * and the parent is NOT itself a git repo, treat the parent as the workspace root.
 *
 * This handles CC workspaces that contain a nested git repo
 * (e.g., ClaudeMem-ProjIso/ contains proj-claude-mem/ which is a git repo).
 *
 * Returns the workspace root if heuristic matches, otherwise returns gitRoot.
 */
function resolveWorkspaceRoot(gitRoot: string): string {
  const parent = dirname(gitRoot);
  if (parent === gitRoot) return gitRoot;

  const parentHasClaude =
    existsSync(join(parent, 'CLAUDE.md')) || existsSync(join(parent, '.claude'));
  const parentIsGitRepo = findGitRoot(parent) !== null && findGitRoot(parent) === parent;

  if (parentHasClaude && !parentIsGitRepo) {
    return parent;
  }
  return gitRoot;
}

/**
 * Resolve the per-project SQLite DB path for claude-mem.
 *
 * Resolution order:
 *   1. CLAUDE_MEM_PROJECT_DB_PATH env var (explicit override)
 *   2. Git worktree -> <parentRepo>/.claude/mem.db
 *   3. Git main repo -> <gitRoot>/.claude/mem.db
 *   4. Non-git directory -> <cwd>/.claude/mem.db
 *
 * Args:
 *     cwd: Working directory to resolve from. Defaults to process.cwd().
 *
 * Returns:
 *     Absolute path to the project-specific mem.db file.
 */
export function resolveProjectDbPath(cwd?: string): string {
  const override = process.env.CLAUDE_MEM_PROJECT_DB_PATH;
  if (override) return resolve(override);

  const effectiveCwd = resolve(cwd || process.cwd());
  const gitRoot = findGitRoot(effectiveCwd);

  if (!gitRoot) {
    return join(effectiveCwd, '.claude', 'mem.db');
  }

  const worktreeInfo = detectWorktree(gitRoot);
  if (worktreeInfo.isWorktree && worktreeInfo.parentRepoPath) {
    return join(worktreeInfo.parentRepoPath, '.claude', 'mem.db');
  }

  return join(resolveWorkspaceRoot(gitRoot), '.claude', 'mem.db');
}

/**
 * Resolve the canonical root path for a project.
 *
 * This is the key used in the project allowlist. Worktrees return their
 * parent repo root so all worktrees share the same enablement state.
 *
 * Resolution order:
 *   1. Git worktree -> <parentRepo>
 *   2. Git repo whose parent has CLAUDE.md or .claude/ (and parent is not a git repo)
 *      -> <parent> (workspace root heuristic for nested-repo workspaces)
 *   3. Git main repo -> <gitRoot>
 *   4. Non-git directory -> <cwd>
 */
export function resolveProjectRoot(cwd?: string): string {
  const effectiveCwd = resolve(cwd || process.cwd());
  const gitRoot = findGitRoot(effectiveCwd);

  if (!gitRoot) return effectiveCwd;

  const worktreeInfo = detectWorktree(gitRoot);
  if (worktreeInfo.isWorktree && worktreeInfo.parentRepoPath) {
    return resolve(worktreeInfo.parentRepoPath);
  }

  return resolveWorkspaceRoot(gitRoot);
}
