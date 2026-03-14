/**
 * Local file fallback queue for when the worker service is unreachable.
 *
 * Writes observation and summarize entries as individual JSON files to a
 * fallback directory. A replay mechanism (Task 2b) later reads these files
 * and sends them to the worker once it becomes available again.
 */
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './paths.js';

const DEFAULT_FALLBACK_DIR = join(DATA_DIR, 'fallback');
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface FallbackEntry {
  type: 'observation' | 'summarize';
  sessionId: string;
  cwd: string;
  dbPath: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface FallbackFileEntry {
  entry: FallbackEntry;
  filepath: string;
}

export function getDefaultFallbackDir(): string {
  return DEFAULT_FALLBACK_DIR;
}

export function writeFallbackEntry(entry: FallbackEntry, dir: string = DEFAULT_FALLBACK_DIR): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `${entry.timestamp}-${rand}.json`;
  writeFileSync(join(dir, filename), JSON.stringify(entry));
}

export function readFallbackEntries(dir: string = DEFAULT_FALLBACK_DIR): FallbackFileEntry[] {
  if (!existsSync(dir)) return [];
  const entries: FallbackFileEntry[] = [];

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const filepath = join(dir, file);
    try {
      const content = readFileSync(filepath, 'utf8');
      const parsed = JSON.parse(content) as FallbackEntry;
      entries.push({ entry: parsed, filepath });
    } catch {
      // Malformed file — delete silently (logging would require logger dependency in shared module)
      try { unlinkSync(filepath); } catch { /* ignore deletion failure */ }
    }
  }

  return entries;
}

export function deleteFallbackFile(filepath: string): void {
  try { unlinkSync(filepath); } catch { /* ignore */ }
}

export function cleanupStaleFallbacks(
  dir: string = DEFAULT_FALLBACK_DIR,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS
): number {
  if (!existsSync(dir)) return 0;
  const now = Date.now();
  let removed = 0;

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const filepath = join(dir, file);
    try {
      const stat = statSync(filepath);
      if (now - stat.mtimeMs > maxAgeMs) {
        unlinkSync(filepath);
        removed++;
      }
    } catch { /* ignore */ }
  }

  return removed;
}
