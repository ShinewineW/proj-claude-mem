---
name: mem-timeline
description: "claude-mem: Generate a project history report analyzing the entire development timeline. Use when asked for timeline report, project history, development journey, or full project report."
---

# mem-timeline

Generate a comprehensive narrative analysis of a project's entire development history using claude-mem's persistent memory timeline.

## When to Use

Use when users ask for:

- "Write a timeline report"
- "Journey into [project]"
- "Analyze my project history"
- "Full project report"
- "Summarize the entire development history"
- "What's the story of this project?"

## Prerequisites

The claude-mem worker must be running (port read from `~/.claude-mem/worker.port`, default 37777). The project must have claude-mem observations recorded.

## Workflow

### Step 1: Determine the Project Name

Ask the user which project to analyze if not obvious from context. The project name is typically the directory name of the project (e.g., "tokyo", "my-app"). If the user says "this project", use the current working directory's basename.

**Worktree Detection:** Before using the directory basename, check if the current directory is a git worktree. In a worktree, the data source is the **parent project**, not the worktree directory itself. Run:

```bash
git_dir=$(git rev-parse --git-dir 2>/dev/null)
git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null)
if [ "$git_dir" != "$git_common_dir" ]; then
  # We're in a worktree — resolve the parent project name
  parent_project=$(basename "$(dirname "$git_common_dir")")
  echo "Worktree detected. Parent project: $parent_project"
else
  parent_project=$(basename "$PWD")
fi
echo "$parent_project"
```

If a worktree is detected, use `$parent_project` (the basename of the parent repo) as the project name for all API calls. Inform the user: "Detected git worktree. Using parent project '[name]' as the data source."

### Step 2: Fetch the Full Timeline

Use Bash to fetch the complete timeline from the claude-mem worker API:

```bash
WORKER_PORT=$(cat ~/.claude-mem/worker.port 2>/dev/null || echo "37777")
curl -s "http://localhost:${WORKER_PORT}/api/context/inject?project=PROJECT_NAME&full=true"
```

This returns the entire compressed timeline -- every observation, session boundary, and summary across the project's full history. The response is pre-formatted markdown optimized for LLM consumption.

**Token estimates:** The full timeline size depends on the project's history:
- Small project (< 1,000 observations): ~20-50K tokens
- Medium project (1,000-10,000 observations): ~50-300K tokens
- Large project (10,000-35,000 observations): ~300-750K tokens

If the response is empty or returns an error, the worker may not be running or the project name may be wrong. Try `curl -s "http://localhost:${WORKER_PORT}/api/search?query=*&limit=1"` to verify the worker is healthy.

### Step 3: Estimate Token Count

Before proceeding, estimate the token count of the fetched timeline (roughly 1 token per 4 characters). Report this to the user:

```
Timeline fetched: ~X observations, estimated ~Yk tokens.
This analysis will consume approximately Yk input tokens + ~5-10k output tokens.
Proceed? (y/n)
```

Wait for user confirmation before continuing if the timeline exceeds 100K tokens.

### Step 3.5: Resolve the Database Path

Before launching the subagent, resolve the per-project SQLite database path. Run:

```bash
if [ -n "$CLAUDE_MEM_PROJECT_DB_PATH" ]; then
  echo "$CLAUDE_MEM_PROJECT_DB_PATH"
else
  git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null)
  git_dir=$(git rev-parse --git-dir 2>/dev/null)
  if [ -n "$git_common_dir" ]; then
    if [ "$git_dir" != "$git_common_dir" ]; then
      echo "$(dirname "$git_common_dir")/.claude/mem.db"
    else
      echo "$(git rev-parse --show-toplevel)/.claude/mem.db"
    fi
  else
    echo "$PWD/.claude/mem.db"
  fi
fi
```

Store the resolved path as `$DB_PATH`. Verify the file exists before proceeding. If it doesn't exist, warn the user and stop.

### Step 4: Analyze with a Subagent

Deploy an Agent (using the Agent tool) with the full timeline and the following analysis prompt. Pass the ENTIRE timeline as context to the agent. Substitute `$DB_PATH` (resolved in Step 3.5) and `$PROJECT_NAME` into the prompt before sending.

**Agent prompt:**

```
You are a technical historian analyzing a software project's complete development timeline from claude-mem's persistent memory system. The timeline below contains every observation, session boundary, and summary recorded across the project's entire history.

The project's claude-mem SQLite database is at: $DB_PATH
Use `sqlite3 "$DB_PATH"` to run queries for the Token Economics & Memory ROI section. The database has an "observations" table with columns: id, memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch, source_tool, source_input_summary.

Write a comprehensive narrative report titled "Journey Into [PROJECT_NAME]" that covers:

## Required Sections

1. **Project Genesis** -- When and how the project started. What were the first commits, the initial vision, the founding technical decisions? What problem was being solved?

2. **Architectural Evolution** -- How did the architecture change over time? What were the major pivots? Why did they happen? Trace the evolution from initial design through each significant restructuring.

3. **Key Breakthroughs** -- Identify the "aha" moments: when a difficult problem was finally solved, when a new approach unlocked progress, when a prototype first worked. These are the observations where the tone shifts from investigation to resolution.

4. **Work Patterns** -- Analyze the rhythm of development. Identify debugging cycles (clusters of bug fixes), feature sprints (rapid observation sequences), refactoring phases (architectural changes without new features), and exploration phases (many discoveries without changes).

5. **Technical Debt** -- Track where shortcuts were taken and when they were paid back. Identify patterns of accumulation (rapid feature work) and resolution (dedicated refactoring sessions).

6. **Challenges and Debugging Sagas** -- The hardest problems encountered. Multi-session debugging efforts, architectural dead-ends that required backtracking, platform-specific issues that took days to resolve.

7. **Memory and Continuity** -- How did persistent memory (claude-mem itself, if applicable) affect the development process? Were there moments where recalled context from prior sessions saved significant time or prevented repeated mistakes?

8. **Token Economics & Memory ROI** -- Quantitative analysis of how memory recall saved work:
   - Query the database directly for these metrics using `sqlite3 "$db_path"`
   - Count total discovery_tokens across all observations (the original cost of all work)
   - Count sessions that had context injection available (sessions after the first)
   - Calculate the compression ratio: average discovery_tokens vs average read_tokens per observation
   - Identify the highest-value observations (highest discovery_tokens -- these are the most expensive decisions, bugs, and discoveries that memory prevents re-doing)
   - Identify explicit recall events (observations where source_tool contains "search", "smart_search", "get_observations", "timeline", or where narrative mentions "recalled", "from memory", "previous session")
   - Estimate passive recall savings: each session with context injection receives ~50 observations. Use a 30% relevance factor (conservative estimate that 30% of injected context prevents re-work). Savings = sessions_with_context × avg_discovery_value_of_50_obs_window × 0.30
   - Estimate explicit recall savings: ~10K tokens per explicit recall query
   - Calculate net ROI: total_savings / total_read_tokens_invested
   - Present as a table with monthly breakdown
   - Highlight the top 5 most expensive observations by discovery_tokens -- these represent the highest-value memories in the system (architecture decisions, hard bugs, implementation plans that cost 100K+ tokens to produce originally)

   Use these SQL queries as a starting point:
   ```sql
   -- Total discovery tokens
   SELECT SUM(discovery_tokens) FROM observations WHERE project = '$parent_project';

   -- Sessions with context available (not the first session)
   SELECT COUNT(DISTINCT memory_session_id) FROM observations WHERE project = '$parent_project';

   -- Average tokens per observation
   SELECT AVG(discovery_tokens) as avg_discovery, AVG(LENGTH(title || COALESCE(subtitle,'') || COALESCE(narrative,'') || COALESCE(facts,'')) / 4) as avg_read FROM observations WHERE project = '$parent_project' AND discovery_tokens > 0;

   -- Top 5 most expensive observations (highest-value memories)
   SELECT id, title, discovery_tokens FROM observations WHERE project = '$parent_project' ORDER BY discovery_tokens DESC LIMIT 5;

   -- Monthly breakdown
   SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as obs, SUM(discovery_tokens) as total_discovery, COUNT(DISTINCT memory_session_id) as sessions FROM observations WHERE project = '$parent_project' GROUP BY month ORDER BY month;

   -- Explicit recall events
   SELECT COUNT(*) FROM observations WHERE project = '$parent_project' AND (source_tool LIKE '%search%' OR source_tool LIKE '%timeline%' OR source_tool LIKE '%get_observations%' OR narrative LIKE '%recalled%' OR narrative LIKE '%from memory%' OR narrative LIKE '%previous session%');
   ```

9. **Timeline Statistics** -- Quantitative summary:
   - Date range (first observation to last)
   - Total observations and sessions
   - Breakdown by observation type (features, bug fixes, discoveries, decisions, changes)
   - Most active days/weeks
   - Longest debugging sessions

10. **Lessons and Meta-Observations** -- What patterns emerge from the full history? What would a new developer learn about this codebase from reading the timeline? What recurring themes or principles guided development?

## Writing Style

- Write as a technical narrative, not a list of bullet points
- Use specific observation IDs and timestamps when referencing events (e.g., "On Dec 14 (#26766), the root cause was finally identified...")
- Connect events across time -- show how early decisions created later consequences
- Be honest about struggles and dead ends, not just successes
- Target 3,000-6,000 words depending on project size
- Use markdown formatting with headers, emphasis, and code references where appropriate

## Important

- Analyze the ENTIRE timeline chronologically -- do not skip early history
- Look for narrative arcs: problem -> investigation -> solution
- Identify turning points where the project's direction fundamentally changed
- Note any observations about the development process itself (tooling, workflow, collaboration patterns)

Here is the complete project timeline:

[TIMELINE CONTENT GOES HERE]
```

### Step 5: Save the Report

Save the agent's output as a markdown file. Default location:

```
./journey-into-PROJECT_NAME.md
```

Or if the user specified a different output path, use that instead.

### Step 6: Report Completion

Tell the user:
- Where the report was saved
- The approximate token cost (input timeline + output report)
- The date range covered
- Number of observations analyzed

## Error Handling

- **Empty timeline:** "No observations found for project 'X'. Check the project name with: `curl -s 'http://localhost:${WORKER_PORT}/api/search?query=*&limit=1'`"
- **Worker not running:** "The claude-mem worker is not responding on port $WORKER_PORT. Start it with your usual method or check `ps aux | grep worker-service`."
- **Timeline too large:** For projects with 50,000+ observations, the timeline may exceed context limits. The current endpoint returns all observations; for extremely large projects, the user may want to analyze in time-windowed segments.

## Example

User: "Write a journey report for the tokyo project"

1. Fetch: `curl -s "http://localhost:37777/api/context/inject?project=tokyo&full=true"`
2. Estimate: "Timeline fetched: ~34,722 observations, estimated ~718K tokens. Proceed?"
3. User confirms
4. Deploy analysis agent with full timeline
5. Save to `./journey-into-tokyo.md`
6. Report: "Report saved. Analyzed 34,722 observations spanning Oct 2025 - Mar 2026 (~718K input tokens, ~8K output tokens)."
