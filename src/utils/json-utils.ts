// SPDX-License-Identifier: AGPL-3.0
/**
 * Atomic, symlink-safe JSON config writer.
 *
 * Ported from upstream thedotmack/claude-mem src/npx-cli/utils/paths.ts
 * (65607897, AGPL-3.0). A crash mid-write leaves old-or-new contents, never a
 * truncated config. rename(2) writes THROUGH a symlinked destination instead
 * of replacing the link — important because ~/.claude/settings.json is often a
 * symlink (dotfile managers / symlinked configs).
 *
 * Best-effort durability caveat: after the rename we fsync the parent directory
 * so the directory-entry change survives a crash. On some filesystems (Windows,
 * network mounts) or when the open/fsync is denied, the directory fsync may fail;
 * those errors are SILENTLY IGNORED (the file itself is already fsynced + renamed,
 * so contents are safe — only the cross-crash durability of the rename is
 * best-effort, not guaranteed, on all filesystems).
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { randomBytes } from 'crypto';

const IS_WINDOWS = process.platform === 'win32';

function ensureDirectoryExists(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function writeJsonFileAtomic(filepath: string, data: unknown): void {
  // POSIX rename(2) operates on the symlink itself, so an atomic rename over
  // a symlinked destination would replace the link rather than writing through
  // it. Resolve up front so temp + rename both live on the real target's fs.
  let resolved = filepath;
  try {
    if (lstatSync(filepath).isSymbolicLink()) {
      try {
        resolved = realpathSync(filepath);
      } catch {
        const linkTarget = readlinkSync(filepath);
        resolved = resolve(dirname(filepath), linkTarget);
      }
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw err;
    }
    // Destination doesn't exist yet - write directly to the literal path.
  }

  ensureDirectoryExists(dirname(resolved));

  const dir = dirname(resolved);
  const base = basename(resolved);
  const tmpPath = join(dir, `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const payload = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf-8');

  // Preserve existing mode if the destination already exists; otherwise let
  // the OS apply the standard new-file default.
  let mode: number | undefined;
  try {
    mode = statSync(resolved).mode & 0o777;
  } catch {
    // File doesn't exist yet — fall through to default mode.
  }

  let fd: number | undefined;
  try {
    fd = mode !== undefined ? openSync(tmpPath, 'w', mode) : openSync(tmpPath, 'w');

    // writeSync wraps POSIX write(2), which may short-write — loop until the
    // full payload is committed before fsync.
    let written = 0;
    while (written < payload.length) {
      const n = writeSync(fd, payload, written, payload.length - written);
      if (n === 0) {
        throw new Error(`writeSync stalled at ${written}/${payload.length} bytes`);
      }
      written += n;
    }

    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, resolved);

    // fsync the parent directory so the rename's directory-entry change
    // survives a crash. Best-effort: Windows can't fsync a directory and
    // some filesystems disallow it — skip silently in those cases (see the
    // durability caveat in the file-level doc comment).
    if (!IS_WINDOWS) {
      let dirFd: number | undefined;
      try {
        dirFd = openSync(dir, 'r');
        fsyncSync(dirFd);
      } catch {
        // Best-effort directory durability — see file-level doc comment.
      } finally {
        if (dirFd !== undefined) {
          try { closeSync(dirFd); } catch { /* ignore */ }
        }
      }
    }
  } catch (err) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore close-after-error */ }
    }
    try { unlinkSync(tmpPath); } catch { /* tempfile may not exist */ }
    throw err;
  }
}
