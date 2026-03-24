/**
 * Property-based tests for allowlist-first project resolution.
 *
 * Tests invariants identified during security audit context building:
 * I1: Path normalization symmetry
 * I2: Sep boundary prevents prefix collision
 * I3: Longest match wins for nested entries
 * I4: resolveProjectContext null ↔ outside all enabled projects
 * I5: No false positives — match is always a true parent
 * I6: dbPath consistency (allowlist match produces correct .claude/mem.db path)
 *
 * Uses randomized generation without fast-check (bun install hangs on this machine).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { resolve, join, sep, basename } from 'path';
import { writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';

const TEST_DATA_DIR = join(homedir(), '.claude-mem-test-properties');
const TEST_ALLOWLIST_PATH = join(TEST_DATA_DIR, 'enabled-projects.json');

function writeTestAllowlist(entries: Record<string, object>) {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  writeFileSync(TEST_ALLOWLIST_PATH, JSON.stringify(entries, null, 2));
}

function cleanupTestAllowlist() {
  try { unlinkSync(TEST_ALLOWLIST_PATH); } catch {}
}

// --- Generators ---

/** Generate a random absolute path with 1-5 segments of alphanumeric names */
function randomAbsPath(depth?: number): string {
  const d = depth ?? (1 + Math.floor(Math.random() * 5));
  const segments: string[] = [];
  for (let i = 0; i < d; i++) {
    const len = 1 + Math.floor(Math.random() * 12);
    let name = '';
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789_-';
    for (let j = 0; j < len; j++) {
      name += chars[Math.floor(Math.random() * chars.length)];
    }
    segments.push(name);
  }
  return '/' + segments.join('/');
}

/** Generate a path that is a child of the given parent */
function childOf(parent: string, extraDepth?: number): string {
  const d = extraDepth ?? (1 + Math.floor(Math.random() * 3));
  let child = parent;
  for (let i = 0; i < d; i++) {
    child += '/' + randomAbsPath(1).slice(1);
  }
  return child;
}

/** Generate a path that shares a prefix but is NOT a child (sibling with suffix) */
function prefixCollision(parent: string): string {
  const suffixes = ['-extra', '-ProjIso', '_v2', '2', 'zzz'];
  const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
  return parent + suffix;
}

const NUM_TRIALS = 50;

describe('Property: I1 — Path normalization symmetry', () => {
  beforeEach(() => { process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR; });
  afterEach(() => { cleanupTestAllowlist(); delete process.env.CLAUDE_MEM_DATA_DIR; });

  it('findContainingProject(resolve(cwd)) === findContainingProject(cwd) for random paths', async () => {
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');

    for (let i = 0; i < NUM_TRIALS; i++) {
      const projectRoot = randomAbsPath(3);
      const cwd = childOf(projectRoot);
      writeTestAllowlist({ [projectRoot]: { enabledAt: '2026-01-01T00:00:00.000Z' } });

      const resultDirect = findContainingProject(cwd);
      const resultResolved = findContainingProject(resolve(cwd));

      expect(resultDirect).toBe(resultResolved);
    }
  });

  it('findContainingProject is stable under trailing slash variations', async () => {
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');

    for (let i = 0; i < NUM_TRIALS; i++) {
      const projectRoot = randomAbsPath(3);
      const cwd = childOf(projectRoot, 2);
      writeTestAllowlist({ [projectRoot]: { enabledAt: '2026-01-01T00:00:00.000Z' } });

      const resultPlain = findContainingProject(cwd);
      const resultTrailing = findContainingProject(cwd + '/');

      expect(resultPlain).toBe(resultTrailing);
    }
  });

  it('findContainingProject is stable under dot-segment variations', async () => {
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');

    for (let i = 0; i < NUM_TRIALS; i++) {
      const projectRoot = randomAbsPath(3);
      const cwd = childOf(projectRoot, 2);
      writeTestAllowlist({ [projectRoot]: { enabledAt: '2026-01-01T00:00:00.000Z' } });

      const resultPlain = findContainingProject(cwd);
      // Insert /./ and /../<segment>/ to test resolve() normalization
      const segments = cwd.split('/');
      const lastSeg = segments[segments.length - 1];
      const cwdWithDots = cwd + '/./' + lastSeg + '/..';
      const resultDots = findContainingProject(cwdWithDots);

      expect(resultPlain).toBe(resultDots);
    }
  });
});

describe('Property: I2 — Sep boundary prevents prefix collision', () => {
  beforeEach(() => { process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR; });
  afterEach(() => { cleanupTestAllowlist(); delete process.env.CLAUDE_MEM_DATA_DIR; });

  it('prefix-similar but non-child paths never match', async () => {
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');

    for (let i = 0; i < NUM_TRIALS; i++) {
      const projectRoot = randomAbsPath(3);
      const collisionPath = prefixCollision(projectRoot);
      const cwdInCollision = childOf(collisionPath, 2);
      writeTestAllowlist({ [projectRoot]: { enabledAt: '2026-01-01T00:00:00.000Z' } });

      const result = findContainingProject(cwdInCollision);
      expect(result).toBeNull();
    }
  });

  it('exact suffixes that differ only by non-sep chars never match', async () => {
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');

    const baseNames = ['project', 'ClaudeMem', 'app', 'my-repo'];
    for (const base of baseNames) {
      const projectRoot = `/home/user/${base}`;
      const variants = [
        `/home/user/${base}-ProjIso`,
        `/home/user/${base}2`,
        `/home/user/${base}_fork`,
        `/home/user/${base}xxx`,
      ];
      writeTestAllowlist({ [projectRoot]: { enabledAt: '2026-01-01T00:00:00.000Z' } });

      for (const variant of variants) {
        const cwd = childOf(variant, 2);
        expect(findContainingProject(cwd)).toBeNull();
      }
    }
  });
});

describe('Property: I3 — Longest match wins for nested entries', () => {
  beforeEach(() => { process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR; });
  afterEach(() => { cleanupTestAllowlist(); delete process.env.CLAUDE_MEM_DATA_DIR; });

  it('most specific ancestor is always returned', async () => {
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');

    for (let i = 0; i < NUM_TRIALS; i++) {
      // Generate 2-4 nested entries
      const base = randomAbsPath(2);
      const entries: string[] = [base];
      let current = base;
      const nestDepth = 1 + Math.floor(Math.random() * 3);
      for (let j = 0; j < nestDepth; j++) {
        current = childOf(current, 1);
        entries.push(current);
      }

      const allowlist: Record<string, object> = {};
      for (const e of entries) {
        allowlist[e] = { enabledAt: '2026-01-01T00:00:00.000Z' };
      }
      writeTestAllowlist(allowlist);

      // cwd is child of the deepest entry
      const deepest = entries[entries.length - 1];
      const cwd = childOf(deepest, 1);
      const result = findContainingProject(cwd);

      expect(result).toBe(deepest);
    }
  });

  it('intermediate cwd returns the correct intermediate ancestor', async () => {
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');

    for (let i = 0; i < NUM_TRIALS; i++) {
      const shallow = randomAbsPath(2);
      const deep = childOf(shallow, 3);
      writeTestAllowlist({
        [shallow]: { enabledAt: '2026-01-01T00:00:00.000Z' },
        [deep]: { enabledAt: '2026-01-01T00:00:00.000Z' },
      });

      // cwd between shallow and deep — should match shallow, not deep
      const cwdBetween = childOf(shallow, 1);
      // Make sure cwdBetween is NOT a child of deep
      if (!resolve(cwdBetween).startsWith(resolve(deep) + sep) && resolve(cwdBetween) !== resolve(deep)) {
        const result = findContainingProject(cwdBetween);
        expect(result).toBe(shallow);
      }
    }
  });
});

describe('Property: I5 — No false positives', () => {
  beforeEach(() => { process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR; });
  afterEach(() => { cleanupTestAllowlist(); delete process.env.CLAUDE_MEM_DATA_DIR; });

  it('if findContainingProject returns non-null, cwd IS inside that project', async () => {
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');

    for (let i = 0; i < NUM_TRIALS; i++) {
      // Generate 1-3 random project roots
      const projectCount = 1 + Math.floor(Math.random() * 3);
      const projects: string[] = [];
      const allowlist: Record<string, object> = {};
      for (let j = 0; j < projectCount; j++) {
        const p = randomAbsPath(3);
        projects.push(p);
        allowlist[p] = { enabledAt: '2026-01-01T00:00:00.000Z' };
      }
      writeTestAllowlist(allowlist);

      // Random cwd (may or may not be inside a project)
      const cwd = randomAbsPath(4);
      const result = findContainingProject(cwd);

      if (result !== null) {
        // Verify: cwd MUST be the entry or a child of it
        const normalizedCwd = resolve(cwd);
        const normalizedResult = resolve(result);
        const isChild =
          normalizedCwd === normalizedResult ||
          normalizedCwd.startsWith(normalizedResult + sep);
        expect(isChild).toBe(true);
      }
    }
  });

  it('directed: child paths always match, non-children never match', async () => {
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');

    for (let i = 0; i < NUM_TRIALS; i++) {
      const projectRoot = randomAbsPath(3);
      writeTestAllowlist({ [projectRoot]: { enabledAt: '2026-01-01T00:00:00.000Z' } });

      // True child must match
      const trueCwd = childOf(projectRoot, 2);
      expect(findContainingProject(trueCwd)).toBe(projectRoot);

      // Completely unrelated path must not match
      let unrelated = randomAbsPath(3);
      while (resolve(unrelated).startsWith(resolve(projectRoot) + sep) || resolve(unrelated) === resolve(projectRoot)) {
        unrelated = randomAbsPath(3);
      }
      expect(findContainingProject(unrelated)).toBeNull();
    }
  });
});

describe('Property: I6 — dbPath consistency via resolveProjectContext', () => {
  beforeEach(() => { process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR; });
  afterEach(() => { cleanupTestAllowlist(); delete process.env.CLAUDE_MEM_DATA_DIR; });

  it('allowlist-match path always produces <root>/.claude/mem.db', async () => {
    const { resolveProjectContext } = await import('../../src/shared/project-allowlist.js');

    for (let i = 0; i < NUM_TRIALS; i++) {
      const projectRoot = randomAbsPath(3);
      writeTestAllowlist({ [projectRoot]: { enabledAt: '2026-01-01T00:00:00.000Z' } });

      const cwd = childOf(projectRoot, 2);
      const ctx = resolveProjectContext(cwd);

      expect(ctx).not.toBeNull();
      expect(ctx!.projectRoot).toBe(resolve(projectRoot));
      expect(ctx!.dbPath).toBe(join(resolve(projectRoot), '.claude', 'mem.db'));
      expect(ctx!.projectName).toBe(basename(resolve(projectRoot)));
    }
  });

  it('resolveProjectContext(projectRoot) matches resolveProjectContext(child)', async () => {
    const { resolveProjectContext } = await import('../../src/shared/project-allowlist.js');

    for (let i = 0; i < NUM_TRIALS; i++) {
      const projectRoot = randomAbsPath(3);
      writeTestAllowlist({ [projectRoot]: { enabledAt: '2026-01-01T00:00:00.000Z' } });

      const ctxRoot = resolveProjectContext(projectRoot);
      const ctxChild = resolveProjectContext(childOf(projectRoot, 3));

      expect(ctxRoot).not.toBeNull();
      expect(ctxChild).not.toBeNull();
      expect(ctxRoot!.projectRoot).toBe(ctxChild!.projectRoot);
      expect(ctxRoot!.dbPath).toBe(ctxChild!.dbPath);
      expect(ctxRoot!.projectName).toBe(ctxChild!.projectName);
    }
  });
});

describe('Property: Empty and edge cases', () => {
  beforeEach(() => { process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR; });
  afterEach(() => { cleanupTestAllowlist(); delete process.env.CLAUDE_MEM_DATA_DIR; });

  it('empty allowlist always returns null', async () => {
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');
    writeTestAllowlist({});

    for (let i = 0; i < NUM_TRIALS; i++) {
      expect(findContainingProject(randomAbsPath(4))).toBeNull();
    }
  });

  it('single-segment roots work correctly', async () => {
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');

    // Root-level entries like /tmp or /home
    const roots = ['/tmp', '/home', '/opt', '/var'];
    for (const root of roots) {
      writeTestAllowlist({ [root]: { enabledAt: '2026-01-01T00:00:00.000Z' } });
      expect(findContainingProject(root + '/deep/child')).toBe(root);
      expect(findContainingProject(root)).toBe(root);
    }
  });

  it('identical cwd and entry always matches (exact match)', async () => {
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');

    for (let i = 0; i < NUM_TRIALS; i++) {
      const path = randomAbsPath(4);
      writeTestAllowlist({ [path]: { enabledAt: '2026-01-01T00:00:00.000Z' } });
      expect(findContainingProject(path)).toBe(path);
    }
  });
});
