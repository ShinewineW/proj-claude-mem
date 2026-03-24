// tests/shared/allowlist-first-resolution.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { resolve, join, sep } from 'path';
import { writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { homedir } from 'os';

// Test helper: write a temporary allowlist file
const TEST_DATA_DIR = join(homedir(), '.claude-mem-test-allowlist-first');
const TEST_ALLOWLIST_PATH = join(TEST_DATA_DIR, 'enabled-projects.json');

function writeTestAllowlist(entries: Record<string, object>) {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  writeFileSync(TEST_ALLOWLIST_PATH, JSON.stringify(entries, null, 2));
}

function cleanupTestAllowlist() {
  try { unlinkSync(TEST_ALLOWLIST_PATH); } catch {}
}

describe('findContainingProject', () => {
  beforeEach(() => {
    process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR;
  });
  afterEach(() => {
    cleanupTestAllowlist();
    delete process.env.CLAUDE_MEM_DATA_DIR;
  });

  it('returns exact match when cwd equals allowlist entry', async () => {
    writeTestAllowlist({ '/a/b': { enabledAt: '2026-01-01T00:00:00.000Z' } });
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');
    expect(findContainingProject('/a/b')).toBe('/a/b');
  });

  it('returns parent entry when cwd is child path', async () => {
    writeTestAllowlist({ '/a/b': { enabledAt: '2026-01-01T00:00:00.000Z' } });
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');
    expect(findContainingProject('/a/b/c/d')).toBe('/a/b');
  });

  it('rejects prefix collision (ClaudeMem vs ClaudeMem-ProjIso)', async () => {
    writeTestAllowlist({ '/a/b': { enabledAt: '2026-01-01T00:00:00.000Z' } });
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');
    expect(findContainingProject('/a/b-extra/c')).toBeNull();
  });

  it('returns longest match for nested enabled projects', async () => {
    writeTestAllowlist({
      '/a': { enabledAt: '2026-01-01T00:00:00.000Z' },
      '/a/b/c': { enabledAt: '2026-01-01T00:00:00.000Z' },
    });
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');
    expect(findContainingProject('/a/b/c/d')).toBe('/a/b/c');
  });

  it('returns null when no match', async () => {
    writeTestAllowlist({ '/a/b': { enabledAt: '2026-01-01T00:00:00.000Z' } });
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');
    expect(findContainingProject('/tmp/x')).toBeNull();
  });

  it('returns null for empty allowlist', async () => {
    writeTestAllowlist({});
    const { findContainingProject } = await import('../../src/shared/project-allowlist.js');
    expect(findContainingProject('/a/b')).toBeNull();
  });
});

describe('resolveProjectContext', () => {
  beforeEach(() => {
    process.env.CLAUDE_MEM_DATA_DIR = TEST_DATA_DIR;
  });
  afterEach(() => {
    cleanupTestAllowlist();
    delete process.env.CLAUDE_MEM_DATA_DIR;
  });

  it('returns resolved project when cwd is inside enabled project', async () => {
    writeTestAllowlist({ '/a/b': { enabledAt: '2026-01-01T00:00:00.000Z' } });
    const { resolveProjectContext } = await import('../../src/shared/project-allowlist.js');
    const result = resolveProjectContext('/a/b/c/d');
    expect(result).not.toBeNull();
    expect(result!.projectRoot).toBe(resolve('/a/b'));
    expect(result!.dbPath).toBe(join(resolve('/a/b'), '.claude', 'mem.db'));
    expect(result!.projectName).toBe('b');
  });

  it('returns null when cwd is outside all enabled projects', async () => {
    writeTestAllowlist({ '/a/b': { enabledAt: '2026-01-01T00:00:00.000Z' } });
    const { resolveProjectContext } = await import('../../src/shared/project-allowlist.js');
    expect(resolveProjectContext('/tmp/unrelated')).toBeNull();
  });
});
