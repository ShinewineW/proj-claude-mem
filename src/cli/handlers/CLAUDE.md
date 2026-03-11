# CLI Handlers — Hook Event Entry Points

Each handler corresponds to a Claude Code hook event. All follow the same pattern:
1. `ensureWorkerRunning()` → graceful no-op if worker down
2. `dbPath = resolveProjectDbPath(cwd)` → per-project DB path
3. HTTP request to Worker with `dbPath` in body (POST) or query param (GET)

| File | Hook Event | Purpose |
|------|-----------|---------|
| `session-init.ts` | UserPromptSubmit | Init SDK session, increment prompt counter, save user prompt |
| `context.ts` | SessionStart | Fetch context from worker, inject into system message |
| `observation.ts` | PostToolUse | Send tool usage to worker for observation extraction |
| `user-message.ts` | SessionStart | Display formatted context to user via stderr |
| `summarize.ts` | Stop (phase 1) | Parse transcript, request summary generation |
| `session-complete.ts` | Stop (phase 2) | Mark session complete, trigger cleanup |
| `file-edit.ts` | afterFileEdit (Cursor) | Capture file edits as observations |
| `index.ts` | — | Factory: returns handler by event type |

**Error strategy**: Worker unavailable → exit 0 (silent). Validation failure → throw (blocks).

**Allowlist guard**: In `hook-command.ts`, not in handlers — gates all events before dispatch.
