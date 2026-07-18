/**
 * Observer-anchor identity helpers (single source of truth for the
 * bypass/SDK decoupling). `memory_session_id` can be one of:
 *   - null            → legacy: SDK will seed its own resume id on system:init
 *   - a raw UUID / …  → legacy: SDK's own session id (resume handle + FK anchor)
 *   - "cm-<uuid>"     → NEW mode: claude-mem-minted STABLE anchor, never resumed,
 *                       never overwritten. Lets bypass store observations without
 *                       waiting for an SDK seed.
 *
 * The master switch CLAUDE_MEM_OBSERVER_RESUME is read ONCE at session birth
 * (mintInitialAnchor); every downstream decision is driven by isWorkerAnchor()
 * on the persisted anchor, so flipping the switch only affects NEW sessions.
 */
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { USER_SETTINGS_PATH } from "./paths.js";

export const WORKER_ANCHOR_PREFIX = "cm-";

// Default for the master switch. MUST match
// SettingsDefaultsManager.DEFAULTS.CLAUDE_MEM_OBSERVER_RESUME ("false");
// pinned by tests/shared/observer-resume-flag-defaults.test.ts.
const OBSERVER_RESUME_DEFAULT = false;

/** True iff `id` is a claude-mem-minted worker anchor (cm- prefix). */
export function isWorkerAnchor(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(WORKER_ANCHOR_PREFIX);
}

/** Mint a fresh stable worker anchor. Guaranteed != any contentSessionId
 *  (raw UUID, no prefix) and != any SDK / manual- id. */
export function mintWorkerAnchor(): string {
  return `${WORKER_ANCHOR_PREFIX}${randomUUID()}`;
}

/** Non-creating, `loadFromFile`-free flag read for the session-birth hot path
 *  (评审 R11-2 deep / R13-3). `createSDKSession → mintInitialAnchor()` runs in
 *  **15 in-process test files** + the production hot path, so this read must NOT:
 *    - create the settings file as a birth side effect
 *      (`SettingsDefaultsManager.loadFromFile` `writeFileSync`+`chmodSync` when the
 *      file is missing, and rewrites it on legacy-nested migration → real
 *      `~/.claude-mem` mutation in clean/CI envs), nor
 *    - call any `SettingsDefaultsManager` method at read time (it is `mock.module`'d
 *      by other test files; a leaked partial stub could crash or skew this call —
 *      the very cross-file pollution the subprocess probe was built to dodge).
 *  Precise scope (评审 R13-3): this is not "fully mock-independent" — the module
 *  still transitively imports `SettingsDefaultsManager` via `paths.ts`, but only
 *  for the `USER_SETTINGS_PATH` *string constant* (frozen at module load); the
 *  read itself invokes no `SettingsDefaultsManager` method, only `fs`.
 *  Precedence mirrors `loadFromFile`: env var > settings.json (READ-ONLY, flat or
 *  legacy `{env:{…}}`) > hardcoded default. Session birth is once-per-conversation,
 *  not a hot loop, so dropping the 5s TTL cache is fine (and removes the old
 *  "settings edit invisible for ≤5s" caveat — the next new session reads fresh). */
function readObserverResumeFlag(): boolean {
  const env = process.env.CLAUDE_MEM_OBSERVER_RESUME;
  if (env !== undefined) return env === "true";
  try {
    if (existsSync(USER_SETTINGS_PATH)) {
      const raw = JSON.parse(readFileSync(USER_SETTINGS_PATH, "utf-8"));
      // flat schema, or legacy nested { env: {...} } (matches loadFromFile)
      const flat = raw?.env && typeof raw.env === "object" ? raw.env : raw;
      const v = flat?.CLAUDE_MEM_OBSERVER_RESUME;
      if (v !== undefined) return v === "true";
    }
  } catch {
    /* missing/malformed settings → default (never throws on the birth path) */
  }
  return OBSERVER_RESUME_DEFAULT;
}

/** Whether the legacy resumable observer is enabled. With an explicit settings
 *  object → pure (used by unit tests). With no arg → the non-creating env >
 *  settings.json > default read above. Default false (= new decoupled mode).
 *  Not in viewer UI, not writable via POST /api/settings; GET /api/settings
 *  echoes it read-only (R1-2). */
export function observerResumeEnabled(settings?: {
  CLAUDE_MEM_OBSERVER_RESUME?: string;
}): boolean {
  if (settings) return settings.CLAUDE_MEM_OBSERVER_RESUME === "true";
  return readObserverResumeFlag();
}

/** Initial memory_session_id for a brand-new session row:
 *  null in legacy (resume ON, SDK seeds), a cm- anchor in new mode (resume OFF). */
export function mintInitialAnchor(settings?: {
  CLAUDE_MEM_OBSERVER_RESUME?: string;
}): string | null {
  return observerResumeEnabled(settings) ? null : mintWorkerAnchor();
}

/** True when a resume-failure error should clear the session's anchor.
 *  Extracted from the legacy stale-resume detection (SessionRoutes /
 *  WorkerService generator catch): only a real SDK-id anchor can be stale.
 *  A cm- worker anchor is never resumed, hence never stale — clearing it
 *  would orphan the FK anchor bypass/observer store under (评审 R1-1).
 *  NOTE: the 'aborted by user' substring is broad (watchdog aborts match),
 *  which is exactly why cm- anchors must be excluded here. */
export function shouldClearStaleAnchorOnResumeFailure(
  errorMessage: string,
  memorySessionId: string | null | undefined,
): boolean {
  return (
    (errorMessage.includes("aborted by user") ||
      errorMessage.includes("No conversation found")) &&
    !!memorySessionId &&
    !isWorkerAnchor(memorySessionId)
  );
}

/** THE production clear routine for overflow / stale-resume fresh starts
 *  (评审 R2-1: single behavioral choke point, wired into all three sites).
 *  Clears the anchor ONLY when it is a clearable legacy SDK id; a cm- worker
 *  anchor is preserved in both DB and memory (never resumed → never stale;
 *  clearing it would CASCADE-NULL the NOT NULL FK column of child rows).
 *  Always sets forceInit so the next spawn starts a fresh SDK subprocess.
 *  Returns true iff the anchor was cleared. */
export function resetSessionAnchorForFreshStart(
  store: { updateMemorySessionId(sessionDbId: number, id: string | null): void },
  session: { sessionDbId: number; memorySessionId: string | null; forceInit?: boolean },
): boolean {
  session.forceInit = true;
  if (session.memorySessionId && !isWorkerAnchor(session.memorySessionId)) {
    store.updateMemorySessionId(session.sessionDbId, null);
    session.memorySessionId = null;
    return true;
  }
  return false;
}
