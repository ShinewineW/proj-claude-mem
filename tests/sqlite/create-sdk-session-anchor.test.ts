import { describe, test, expect } from "bun:test";
import { spawnSync } from "bun";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isWorkerAnchor } from "../../src/shared/observer-anchor.js";
import { SessionStore } from "../../src/services/sqlite/SessionStore.js";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;

// Each probe runs createSDKSession in a FRESH bun subprocess — the only way to
// test the birth-time flag read hermetically: immune to the cross-file
// mock.module leakage that pollutes the parent test process, with the flag /
// DATA_DIR pinned deterministically via the subprocess env (评审 R2-2).
//
// NOTE (评审 R11-2 deep): session birth reads the flag via observer-anchor's own
// NON-CREATING read (env > settings.json READ-ONLY > default) — it does NOT call
// SettingsDefaultsManager.loadFromFile, so it never creates or rewrites a
// settings file. The throwaway CLAUDE_MEM_DATA_DIR below is therefore pure
// isolation (never touch the real ~/.claude-mem), not a workaround for
// loadFromFile's creation side effect. A sentinel prefix isolates the probe's
// JSON from any incidental stdout.
const SENTINEL = "CM_PROBE_JSON:";
const PROBE = `
const { SessionStore } = await import(process.env.REPO_ROOT + "/src/services/sqlite/SessionStore.js");
const store = new SessionStore(":memory:"); // runs real migrations → real sdk_sessions
const id1 = store.createSDKSession("content-sub", "proj", "hi");
const a1 = store.getDatabase().prepare("SELECT memory_session_id AS m FROM sdk_sessions WHERE id = ?").get(id1).m;
const id2 = store.createSDKSession("content-sub", "proj", "hi");
const a2 = store.getDatabase().prepare("SELECT memory_session_id AS m FROM sdk_sessions WHERE id = ?").get(id2).m;
console.log("${SENTINEL}" + JSON.stringify({ id1, id2, a1, a2 }));
`;

interface ProbeResult {
  id1: number; id2: number; a1: string | null; a2: string | null;
  settingsCreated: boolean; // did the birth read create <dataDir>/settings.json?
}

// Run the birth probe in a subprocess against a throwaway DATA_DIR.
//   flagEnv:      value for CLAUDE_MEM_OBSERVER_RESUME env (omit = unset → file/default branch)
//   settingsFile: if given, pre-write <dataDir>/settings.json with this content
//                 (exercises the settings.json read branch — the manual-toggle production path)
function probe(opts: { flagEnv?: string; settingsFile?: string } = {}): ProbeResult {
  const dataDir = mkdtempSync(join(tmpdir(), "cm-anchor-probe-"));
  if (opts.settingsFile !== undefined) {
    writeFileSync(join(dataDir, "settings.json"), opts.settingsFile, "utf-8");
  }
  const env: Record<string, string> = { ...process.env, REPO_ROOT, CLAUDE_MEM_DATA_DIR: dataDir };
  delete env.CLAUDE_MEM_OBSERVER_RESUME; // start unset; only set when flagEnv is given
  if (opts.flagEnv !== undefined) env.CLAUDE_MEM_OBSERVER_RESUME = opts.flagEnv;
  try {
    const res = spawnSync({ cmd: [process.execPath, "-e", PROBE], env, stdout: "pipe", stderr: "pipe" });
    if (res.exitCode !== 0) throw new Error(`anchor probe failed: ${res.stderr.toString()}`);
    const line = res.stdout.toString().split("\n").find((l) => l.startsWith(SENTINEL));
    if (!line) throw new Error(`anchor probe: no ${SENTINEL} line in stdout: ${res.stdout.toString()}`);
    const parsed = JSON.parse(line.slice(SENTINEL.length));
    // Read existence BEFORE the finally cleanup deletes the dir.
    const settingsCreated = existsSync(join(dataDir, "settings.json"));
    return { ...parsed, settingsCreated };
  } finally {
    rmSync(dataDir, { recursive: true, force: true }); // hygiene: mkdtemp ↔ rmSync
  }
}

describe("createSDKSession anchor minting (subprocess-hermetic, 评审 R2-2 / R11-2 / R13-2)", () => {
  // --- env-var branch (highest precedence) ---
  test("new mode (env flag=false): new row gets a cm- worker anchor", () => {
    expect(isWorkerAnchor(probe({ flagEnv: "false" }).a1)).toBe(true);
  });

  test("legacy (env flag=true): new row keeps NULL anchor — SDK will seed (评审 R1-6)", () => {
    expect(probe({ flagEnv: "true" }).a1).toBeNull();
  });

  // --- settings.json branch (评审 R13-2: the real manual-toggle production path) ---
  test("settings.json flat 'true' (no env) → legacy NULL anchor", () => {
    const r = probe({ settingsFile: JSON.stringify({ CLAUDE_MEM_OBSERVER_RESUME: "true" }) });
    expect(r.a1).toBeNull();
  });

  test("settings.json legacy nested { env: { …'true' } } (no env) → legacy NULL anchor", () => {
    const r = probe({ settingsFile: JSON.stringify({ env: { CLAUDE_MEM_OBSERVER_RESUME: "true" } }) });
    expect(r.a1).toBeNull();
  });

  test("settings.json 'false' (no env) → new-mode cm- anchor", () => {
    const r = probe({ settingsFile: JSON.stringify({ CLAUDE_MEM_OBSERVER_RESUME: "false" }) });
    expect(isWorkerAnchor(r.a1)).toBe(true);
  });

  test("env var outranks settings.json (env 'true' beats file 'false') → NULL", () => {
    const r = probe({ flagEnv: "true", settingsFile: JSON.stringify({ CLAUDE_MEM_OBSERVER_RESUME: "false" }) });
    expect(r.a1).toBeNull();
  });

  // --- idempotency (folded into the hermetic probe, 评审 R11-2: it already calls
  //     createSDKSession TWICE, so no in-process call that would hit the settings read) ---
  test("idempotent: second call returns same id, anchor unchanged", () => {
    const r = probe({ flagEnv: "false" });
    expect(r.id2).toBe(r.id1);
    expect(r.a2).toBe(r.a1);
    expect(isWorkerAnchor(r.a1)).toBe(true);
  });

  // --- non-creating guarantee (评审 R11-2 deep / R13): the crux of the 15-caller fix ---
  test("non-creating read: missing settings.json is NOT created at session birth", () => {
    // Empty temp DATA_DIR + no env + no seed → the "file missing → default(false)"
    // branch. Birth mints a cm- anchor AND must not create <dataDir>/settings.json
    // (guards real ~/.claude-mem across the 15 in-process store.createSDKSession callers).
    const r = probe({});
    expect(isWorkerAnchor(r.a1)).toBe(true);
    expect(r.settingsCreated).toBe(false);
  });
});
