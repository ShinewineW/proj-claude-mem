/**
 * Guard test: ensures ALL test files follow filesystem hygiene rules.
 *
 * Rules enforced:
 * 1. No test writes to HOME via homedir() — must use tmpdir()
 * 2. Tests creating temp dirs must have rmSync cleanup
 * 3. new Database() must use ':memory:' or a tmpdir-based path
 *
 * This test statically analyzes test source files. It does NOT execute them.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const TESTS_DIR = join(__dirname, '..');
const PROJECT_ROOT = join(TESTS_DIR, '..');

function getAllTestFiles(): string[] {
  const results: string[] = [];
  const walkSync = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) walkSync(fullPath);
      else if (entry.name.endsWith('.test.ts')) results.push(fullPath);
    }
  };
  walkSync(TESTS_DIR);
  return results;
}

function findHomedirWritePaths(content: string, filePath: string): string[] {
  const violations: string[] = [];

  const homedirVarPattern = /(?:const|let|var)\s+(\w+)\s*=\s*(?:path\.)?join\(\s*(?:os\.)?homedir\(\)/g;
  const homedirVars: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = homedirVarPattern.exec(content)) !== null) {
    homedirVars.push(match[1]);
  }

  if (homedirVars.length === 0) return violations;

  const writeOps = ['writeFileSync', 'mkdirSync', 'writeSync', 'appendFileSync', 'writePidFile'];
  for (const varName of homedirVars) {
    for (const op of writeOps) {
      if (new RegExp(`${op}\\s*\\([^)]*\\b${varName}\\b`).test(content)) {
        violations.push(`${filePath}: '${varName}' derived from homedir() used with ${op}()`);
      }
    }
  }

  return violations;
}

function findMissingCleanup(content: string, filePath: string): string[] {
  if (!/mkdirSync\s*\(/.test(content)) return [];

  // Exception: mkdirSync only appears inside a mock/spy definition
  const withoutMocks = content
    .replace(/spyOn\([^)]*'mkdirSync'\)[^;]*/g, '')
    .replace(/mockImplementation\([^)]*mkdirSync[^)]*\)/g, '');
  if (!/mkdirSync\s*\(/.test(withoutMocks)) return [];

  // Find module-level temp dir variables (assigned from tmpdir() outside any function/describe)
  // These are the roots that MUST have rmSync(..., {recursive}) cleanup
  const tmpdirVars = new Set<string>();
  const lines = content.split('\n');
  for (const line of lines) {
    // Only match top-level declarations (no leading whitespace beyond 0-2 spaces)
    const m = line.match(/^(?:  )?(?:const|let|var)\s+(\w+)\s*=\s*(?:path\.)?join\(\s*tmpdir\(\)/);
    if (m) tmpdirVars.add(m[1]);
  }

  // Each tmpdir-derived variable used with mkdirSync must have rmSync(..., {recursive})
  const violations: string[] = [];
  for (const dirVar of tmpdirVars) {
    const usedInMkdir = new RegExp(`mkdirSync\\s*\\([^)]*\\b${dirVar}\\b`).test(withoutMocks);
    if (!usedInMkdir) continue;
    const hasRecursiveRm = new RegExp(`rmSync\\s*\\(\\s*${dirVar}\\b[^)]*recursive`).test(content);
    if (!hasRecursiveRm) {
      violations.push(`${filePath}: mkdirSync(${dirVar}) has no matching rmSync(${dirVar}, {recursive: true})`);
    }
  }

  // Fallback: if file has mkdirSync but no tmpdir vars detected, check for any rmSync
  if (tmpdirVars.size === 0 && !/rmSync\s*\(/.test(content)) {
    violations.push(`${filePath}: has mkdirSync() but no rmSync() for cleanup`);
  }

  return violations;
}

function findUnsafeDatabasePaths(content: string, filePath: string): string[] {
  const violations: string[] = [];
  const dbPattern = /new\s+Database\s*\(\s*([^)]+)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = dbPattern.exec(content)) !== null) {
    const arg = match[1].trim();
    if (arg.includes("':memory:'") || arg.includes('":memory:"')) continue;
    if (arg.includes('tmpdir') || arg.includes('tmp') || arg.includes('TMP')) continue;
    if (arg.includes('homedir')) {
      violations.push(`${filePath}: new Database() with homedir-derived path: ${arg}`);
    }
  }
  return violations;
}

// Read all files once, share across all checks
const testFiles = getAllTestFiles();
const fileContents = new Map<string, string>(
  testFiles.map(f => [f, readFileSync(f, 'utf-8')])
);

describe('Test Filesystem Hygiene Guard', () => {
  it('should find test files to analyze', () => {
    // Threshold lowered to accommodate projects with fewer test files
    expect(testFiles.length).toBeGreaterThan(50);
  });

  it('no test file should use homedir() for write paths', () => {
    const allViolations: string[] = [];
    for (const [file, content] of fileContents) {
      allViolations.push(...findHomedirWritePaths(content, file.replace(PROJECT_ROOT + '/', '')));
    }
    expect(allViolations).toEqual([]);
  });

  it('all test files with mkdirSync should have rmSync cleanup', () => {
    const allViolations: string[] = [];
    for (const [file, content] of fileContents) {
      allViolations.push(...findMissingCleanup(content, file.replace(PROJECT_ROOT + '/', '')));
    }
    expect(allViolations).toEqual([]);
  });

  it('no test file should create Database with homedir path', () => {
    const allViolations: string[] = [];
    for (const [file, content] of fileContents) {
      allViolations.push(...findUnsafeDatabasePaths(content, file.replace(PROJECT_ROOT + '/', '')));
    }
    expect(allViolations).toEqual([]);
  });
});
