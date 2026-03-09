/**
 * Project Allowlist - Per-project opt-in for claude-mem recording
 *
 * Allowlist stored at: ~/.claude-mem/enabled-projects.json
 * Key: absolute path to git root (or cwd for non-git dirs)
 * Value: { enabledAt: ISO timestamp }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { DATA_DIR } from './paths.js';

export const ENABLED_PROJECTS_PATH = join(DATA_DIR, 'enabled-projects.json');

interface AllowlistEntry {
  enabledAt: string;
}

interface Allowlist {
  [projectRoot: string]: AllowlistEntry;
}

function readAllowlist(): Allowlist {
  if (!existsSync(ENABLED_PROJECTS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(ENABLED_PROJECTS_PATH, 'utf-8')) as Allowlist;
  } catch {
    return {};
  }
}

function writeAllowlist(data: Allowlist): void {
  mkdirSync(dirname(ENABLED_PROJECTS_PATH), { recursive: true });
  writeFileSync(ENABLED_PROJECTS_PATH, JSON.stringify(data, null, 2));
}

export function isProjectEnabled(projectRoot: string): boolean {
  const allowlist = readAllowlist();
  return Object.prototype.hasOwnProperty.call(allowlist, projectRoot);
}

export function enableProject(projectRoot: string): void {
  const allowlist = readAllowlist();
  allowlist[projectRoot] = { enabledAt: new Date().toISOString() };
  writeAllowlist(allowlist);
}

export function disableProject(projectRoot: string): void {
  const allowlist = readAllowlist();
  if (!Object.prototype.hasOwnProperty.call(allowlist, projectRoot)) return;
  delete allowlist[projectRoot];
  writeAllowlist(allowlist);
}

export function listEnabledProjects(): Allowlist {
  return readAllowlist();
}
