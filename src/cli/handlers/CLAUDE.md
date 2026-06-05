# CLI Handlers — Hook Event Entry Points

Each handler corresponds to a Claude Code hook event. Most follow the same pattern:
1. `ensureWorkerRunning()` → graceful no-op if worker down (exception: `observation.ts` skips this pre-flight by design — relies on the `fetchWithTimeout` catch path, P2)
2. `ctx = input._projectContext ?? resolveProjectContext(cwd)` → allowlist-first project resolution
3. HTTP request to Worker with `ctx.dbPath` in body (POST) or query param (GET)

| File | Hook Event | Purpose |
|------|-----------|---------|
| `session-init.ts` | UserPromptSubmit (CC) / beforeSubmitPrompt (Cursor) | Init SDK session, increment prompt counter, save user prompt |
| `context.ts` | SessionStart (CC) / beforeSubmitPrompt (Cursor) | Fetch context from worker, inject into system message |
| `observation.ts` | PostToolUse (CC) / afterMCPExecution + afterShellExecution (Cursor) | Send tool usage to worker for observation extraction |
| `stop.ts` | Stop (CC) | Composite: runs `summarize` (phase 1) then `session-complete` (phase 2) in-process — only handler wired to the CC Stop event |
| `summarize.ts` | stop (Cursor) | Parse transcript, request summary generation. On CC, invoked by `stop.ts` phase 1 (not wired directly) |
| `session-complete.ts` | — | Mark session complete, trigger cleanup. Invoked by `stop.ts` phase 2 (not wired directly) |
| `user-message.ts` | — (vestigial) | Display formatted context to user via stderr. Registered in factory but no hook event dispatches to it |
| `file-edit.ts` | afterFileEdit (Cursor) | Capture file edits as observations |
| `index.ts` | — | Factory: returns handler by event type |

**Error strategy**: Worker unavailable → exit 0 (silent). Validation failure → throw (blocks).

**Allowlist guard**: In `hook-command.ts`, not in handlers — gates all events before dispatch.
