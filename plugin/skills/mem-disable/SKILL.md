---
name: mem-disable
description: Use when user invokes /mem-disable to stop claude-mem memory recording for a project.
---

# mem-disable

Disable claude-mem memory recording for a project directory.

## Steps

### Step 0: Check plugin installation — REQUIRED

Before anything else, verify that the claude-mem plugin is installed locally. Read `~/.claude/plugins/installed_plugins.json` and check whether `claude-mem@thedotmack` exists as a key in the `plugins` object.

If the file doesn't exist, is unreadable, or the key is missing:
```
✗ claude-mem plugin is not installed.
  Install it first: claude plugin install claude-mem@thedotmack
```
**Stop here. Do NOT proceed to any subsequent step.**

### Step 1: Detect candidate path

Run the following to find a candidate workspace root:

```bash
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -n "$GIT_ROOT" ]; then
  PARENT=$(dirname "$GIT_ROOT")
  if ([ -f "$PARENT/CLAUDE.md" ] || [ -d "$PARENT/.claude" ]) && \
     ! git -C "$PARENT" rev-parse --show-toplevel >/dev/null 2>&1; then
    echo "$PARENT"
  else
    echo "$GIT_ROOT"
  fi
else
  echo "$PWD"
fi
```

### Step 2: Ask user to confirm — REQUIRED

Show the detected path and ask explicitly:

```
Detected workspace root: <detected_path>

Is this the correct project to disable memory recording for?
If not, please provide the correct absolute path.
```

**Do NOT proceed until the user responds.** If the user provides a different path, use that instead.

### Step 3: Check allowlist

Read `~/.claude-mem/enabled-projects.json`.

If file doesn't exist, or confirmed path is not a key:
```
ℹ claude-mem is already disabled for: <confirmed_path>
```
Stop here.

### Step 4: Remove entry and write back

Delete only the confirmed path's key. Preserve all other entries. Do NOT delete the file even if it becomes `{}`.

### Step 5: Confirm to user

```
✓ claude-mem disabled for: <confirmed_path>
Recording stopped. Existing observations in <confirmed_path>/.claude/mem.db are preserved.
Run /mem-enable to resume recording.

⚠️  Restart required: Please close and reopen this CC session.
   Hooks are registered at session start — the current session will continue recording until restarted.
```

## Rules

- NEVER skip the confirmation step, even if the detected path looks correct
- NEVER delete mem.db — existing observations are always preserved
- NEVER delete the allowlist file — only remove the specific key
