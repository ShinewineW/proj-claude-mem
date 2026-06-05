# Project-Level Skills

This directory contains skills **for developing and maintaining the claude-mem project itself**, not skills that are released as part of the plugin.

## Distinction

**Project Skills** (`.claude/skills/`):
- Used by developers working on claude-mem
- Not included in the plugin distribution
- Project-specific workflows (version bumps, release management, etc.)
- Not synced to plugin installations

**Plugin Skills** (`plugin/skills/`):
- Released as part of the claude-mem plugin
- Available to all users who install the plugin
- General-purpose memory search functionality
- Deployed via `bun run build-and-sync` (rsync to marketplace + cache)

## Skills in This Directory

None currently. This directory holds only this `CLAUDE.md`; add project-development skills here as described below.

## Adding New Skills

**For claude-mem development** → Add to `.claude/skills/`
**For end users** → Add to `plugin/skills/` (gets distributed with plugin)