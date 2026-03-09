---
name: mem-enable
description: Use when user invokes /mem-enable to opt the current project into claude-mem memory recording.
---

# mem-enable

Enable claude-mem memory recording for a project directory.

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

Is this the correct project to enable memory recording for?
If not, please provide the correct absolute path.
```

**Do NOT proceed until the user responds.** If the user provides a different path, use that instead.

### Step 3: Check if already enabled

Read `~/.claude-mem/enabled-projects.json` (treat missing or corrupt file as `{}`).

If the confirmed path is already a key:
```
✓ claude-mem already enabled for: <path>
```
Stop here.

### Step 4: Write to allowlist

Add entry:
```json
{
  "<confirmed_path>": {
    "enabledAt": "<current ISO 8601 timestamp>"
  }
}
```
Preserve all existing entries. Create `~/.claude-mem/` if it doesn't exist.

### Step 5: Confirm to user

```
✓ claude-mem enabled for: <confirmed_path>
Observations will be stored in: <confirmed_path>/.claude/mem.db

⚠️  Restart required: Please close and reopen this CC session.
   Hooks are registered at session start — the current session will not record until restarted.
```

## Rules

- NEVER skip the confirmation step, even if the detected path looks correct
- NEVER delete existing entries when adding a new one
- NEVER modify mem.db
