# Agent Memory MCP

A local MCP (Model Context Protocol) server that acts as a persistent memory database for coding agents. It stores bugs, patterns, gotchas, and learnings so agents never repeat the same mistakes, keeps a daily work log, and holds the standing rules an agent should obey in every session.

Works with **Cursor IDE**, **OpenAI Codex CLI**, **Claude Desktop**, and any MCP-compatible client.

## How It Works

```
┌─────────────┐                        ┌──────────────────────┐
│  Cursor IDE  │── stdio ──────────────►│                      │
├─────────────┤                        │  agent-memory-mcp    │
│  Codex CLI   │── stdio ──────────────►│                      │
├─────────────┤                        │  SQLite + FTS5       │
│  Claude      │── stdio ──────────────►│  ~/.agent-memory/    │
└─────────────┘                        └──────────────────────┘
```

Each agent spawns its own process instance. All instances read/write the same SQLite database at `~/.agent-memory/memory.db`. SQLite WAL mode ensures safe concurrent access.

## Requirements

- Node.js 18+
- macOS, Linux, or Windows

## Installation

```bash
git clone https://github.com/YOUR_USERNAME/agent-memory-mcp.git
cd agent-memory-mcp
npm install
npm run build
```

## Agent Integration

### Cursor IDE

Add to `~/.cursor/mcp.json` (inside the `mcpServers` object):

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["/absolute/path/to/agent-memory-mcp/dist/index.js"]
    }
  }
}
```

Optionally, install the Cursor skill for better agent behavior:

```bash
cp -r integration/cursor-skill ~/.cursor/skills/agent-memory
```

And add the rule to your projects:

```bash
cp integration/cursor-rule.md your-project/.cursor/rules/agent-memory.md
```

### OpenAI Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-memory]
command = "node"
args = ["/absolute/path/to/agent-memory-mcp/dist/index.js"]
```

Then append memory instructions to your Codex instructions file:

```bash
cat integration/codex-instructions.md >> ~/.codex/instructions.md
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["/absolute/path/to/agent-memory-mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop after editing the config.

### Any MCP-Compatible Client

Any tool supporting MCP stdio transport can use this server by spawning:

```bash
node /path/to/agent-memory-mcp/dist/index.js
```

The server communicates via JSON-RPC over stdin/stdout following the MCP specification.

## Tools

### store_memory

Store a bug, pattern, gotcha, or learning.

| Parameter       | Required | Description                                                              |
| --------------- | -------- | ------------------------------------------------------------------------ |
| title           | Yes      | Short one-line description                                               |
| type            | Yes      | `bug`, `pattern`, `gotcha`, `solution`, or `learning`                    |
| area            | Yes      | Tech area: `php`, `vue`, `mysql`, `docker`, `python`, `typescript`, etc. |
| symptom         | Yes      | The error message or observable problem                                  |
| fix             | Yes      | The correct solution or workaround                                       |
| project         | No       | Project name (omit for global memories)                                  |
| trigger_context | No       | What you were doing when this surfaced                                   |
| root_cause      | No       | Why it happened                                                          |
| code_example    | No       | Code showing wrong vs right approach                                     |
| tags            | No       | Comma-separated tags for search                                          |
| severity        | No       | `critical`, `major` (default), `minor`, or `info`                        |

### search_memory

Full-text search across all memory entries.

| Parameter | Required | Description                                            |
| --------- | -------- | ------------------------------------------------------ |
| query     | Yes      | Free-text search (error message, keyword, description) |
| area      | No       | Filter by tech area                                    |
| project   | No       | Filter by project                                      |
| type      | No       | Filter by type                                         |
| tags      | No       | Filter by tags (comma-separated, matches ANY)          |
| limit     | No       | Max results (default 10)                               |

### get_context

Smart retrieval for the current task. Returns critical/major entries for the given areas plus FTS matches against the task description.

| Parameter        | Required | Description                                           |
| ---------------- | -------- | ----------------------------------------------------- |
| areas            | Yes      | Array of tech areas: `["php", "vue", "mysql"]`        |
| task_description | No       | What you are about to do (used for semantic matching) |
| project          | No       | Current project name                                  |

### list_memories

Browse entries with optional filters.

| Parameter | Required | Description              |
| --------- | -------- | ------------------------ |
| project   | No       | Filter by project        |
| area      | No       | Filter by area           |
| type      | No       | Filter by type           |
| severity  | No       | Filter by severity       |
| limit     | No       | Max results (default 20) |
| offset    | No       | Pagination offset        |

### update_memory

Update an existing entry.

| Parameter   | Required | Description                                |
| ----------- | -------- | ------------------------------------------ |
| id          | Yes      | The memory ID to update                    |
| (any field) | No       | Any field from store_memory can be updated |

### delete_memory

Remove an obsolete entry.

| Parameter | Required | Description             |
| --------- | -------- | ----------------------- |
| id        | Yes      | The memory ID to delete |

### store_session_log

Append one session to the daily work log. See [Daily Work Log](#daily-work-log).

| Parameter | Required | Description                                                                |
| --------- | -------- | -------------------------------------------------------------------------- |
| summary   | Yes      | What was worked on, in 1-3 sentences                                       |
| project   | No       | Project or repo name (omit for cross-project work)                         |
| work_date | No       | Local day `YYYY-MM-DD`. Defaults to today; pass only to backfill an earlier day |
| tags      | No       | Comma-separated tags for search                                            |

### search_session_log

Search the daily work log. Results are grouped by date, newest first.

| Parameter | Required | Description                                                       |
| --------- | -------- | ----------------------------------------------------------------- |
| query     | No       | Free-text keyword. Omit to list every session in the date range   |
| from      | No       | Earliest local date `YYYY-MM-DD` (inclusive)                      |
| to        | No       | Latest local date `YYYY-MM-DD` (inclusive)                        |
| project   | No       | Filter by project or repo name                                    |
| limit     | No       | Max sessions (default 20)                                         |

### store_rule

Record a standing instruction that applies to every future session. See [Standing Rules](#standing-rules).

| Parameter | Required | Description                                                                 |
| --------- | -------- | --------------------------------------------------------------------------- |
| rule      | Yes      | The instruction, imperative and one line                                    |
| mode      | Yes      | `always`, `never`, `prefer`, or `ask`                                       |
| rationale | No       | Why the user wants it — a rule with a reason survives edge cases            |
| project   | No       | Scope to one repo (omit for everywhere)                                     |
| area      | No       | Scope to one tech area: `git`, `sql`, `vue`                                 |
| priority  | No       | `critical`, `high`, or `normal` (default)                                   |
| tags      | No       | Comma-separated tags                                                        |

### list_rules

List stored rules. Active ones are injected automatically, so this is for finding an ID or auditing.

| Parameter        | Required | Description                                            |
| ---------------- | -------- | ------------------------------------------------------ |
| project          | No       | Global rules plus the ones scoped to this project      |
| area             | No       | Filter by tech area                                    |
| mode             | No       | Filter by instruction shape                            |
| priority         | No       | Filter by priority                                     |
| include_inactive | No       | Include switched-off rules (default false)             |
| limit            | No       | Max rules (default 100)                                |

### update_rule

Reword, rescope, or switch off a rule.

| Parameter   | Required | Description                                             |
| ----------- | -------- | ------------------------------------------------------- |
| id          | Yes      | The rule ID (from `list_rules`)                         |
| active      | No       | `false` suspends the rule without losing its wording    |
| (any field) | No       | Any field from `store_rule` can be updated              |

### delete_rule

Remove a rule permanently. Prefer `update_rule` with `active: false` when merely pausing it.

| Parameter | Required | Description           |
| --------- | -------- | --------------------- |
| id        | Yes      | The rule ID to delete |

## Daily Work Log

Separate from the memory entries above, the server keeps a chronological log of what
was worked on, so you can later ask "when did I work on X?" or "what did I do last week?"
without reading everything.

It is deliberately a different concern from `store_memory`:

|                | `memories`                             | `session_log`                       |
| -------------- | -------------------------------------- | ----------------------------------- |
| Answers        | "has this bug been seen before?"       | "when did I work on X?"             |
| Written        | when something reusable is learned     | once at the end of every session    |
| Shape          | one row per lesson, amendable          | append-only, one row per session    |
| Search index   | `memories_fts`                         | `session_log_fts` (separate)        |

The two FTS indexes are kept apart on purpose — work-log prose would otherwise
dilute every `search_memory` result.

Many short sessions in one day is the expected shape. Nothing is ever read then
rewritten: each session appends its own row, and rows are grouped by date at query
time. `work_date` is stored as a **local** calendar day (`date('now','localtime')`)
rather than derived from the UTC `created_at`, so an evening session is filed under
the day you actually worked, not the next one.

## Standing Rules

The third concern, and the one the other two cannot serve: an instruction the user
wants obeyed from now on. "Never force-push a shared branch." "Prefer pnpm over npm."

A memory is something *learned* — it has a symptom, and it is found by searching for
that symptom when you hit it. A rule has no symptom, and searching is exactly what
fails it: nothing prompts an agent to look up "always prefer X" in the second before
it reaches for Y. So rules are not searched at all. They are **pushed**:

|           | `memories`                      | `rules`                                 |
| --------- | ------------------------------- | --------------------------------------- |
| Is        | something learned               | something instructed                    |
| Found by  | searching for the symptom       | never searched — injected wholesale     |
| Written   | after a bug or discovery        | the moment the user states a preference |
| Index     | `memories_fts`                  | none needed; a dozen rows, read in full |

Two delivery paths, because each surface guarantees something different:

- **`get_context`** returns active rules ahead of the memories. Cursor and Codex are
  instructed to call it at the start of every task, so that is where a rule reaches them.
- **A `SessionStart` hook** (Claude Code) injects them before the first prompt, which
  covers the sessions where `get_context` is never called at all.

Keep the set small. Rules are pushed into every session, so they compete for attention
with everything else in context — ten sharp rules beat sixty, and `update_rule` with
`active: false` parks one without losing its wording.

### Session hook (Claude Code)

A hook is a shell command and cannot call an MCP tool, so the CLI is the tool-equivalent
path into the same storage — no second copy of the SQL:

```bash
node /path/to/agent-memory-mcp/dist/cli.js rules --cwd "$PWD" --format hook
```

`--cwd` resolves the project by walking up to the nearest `.git`, so a session started
in a subdirectory still gets that repository's rules. With no rules stored it prints
nothing and exits 0. Register it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "~/.claude/hooks/rules-inject.sh", "timeout": 10 }] }
    ]
  }
}
```

## Database

Data is stored at `~/.agent-memory/memory.db` (SQLite with FTS5). Three independent
tables live there: `memories` (indexed by `memories_fts`), `session_log` (indexed by
`session_log_fts`), and `rules` (no index — it is read in full, never searched).

### Storage Setup

After building, run the interactive setup to choose where data lives:

```bash
npm run setup
```

You will be prompted to choose:

- **Google Drive** (macOS only) — symlinks `~/.agent-memory/` to your Google Drive folder. Data syncs automatically across machines.
- **Local** — stores data at `~/.agent-memory/` on disk (default).

You can re-run `npm run setup` at any time to switch between the two.

#### New machine setup

If you previously chose Google Drive:

1. Install Google Drive Desktop and sign in with the same account
2. Clone this repo, `npm install && npm run build`
3. Run `npm run setup` and select Google Drive — it will find your existing data

If Google Drive becomes unavailable (e.g. app not installed), the server automatically falls back to local storage instead of crashing.

### Manual Inspection

Read-only, and only for inspection. Every write — and every read an agent acts on —
belongs in the MCP tools or the CLI above; a second path to these rows drifts from the
first, and this is a WAL database that may be sitting on cloud-synced storage.

```bash
sqlite3 -readonly ~/.agent-memory/memory.db

-- List recent entries
SELECT id, title, area, severity FROM memories ORDER BY created_at DESC LIMIT 10;

-- Search by keyword
SELECT * FROM memories WHERE id IN (
  SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'LEFT JOIN'
);

-- Count by area
SELECT area, COUNT(*) FROM memories GROUP BY area;

-- Rules currently in force
SELECT mode, rule, project FROM rules WHERE active = 1;

-- Sessions per day, most recent first
SELECT work_date, COUNT(*) FROM session_log GROUP BY work_date ORDER BY work_date DESC;

-- When did I work on X?
SELECT s.work_date, s.project, s.summary FROM session_log s
  JOIN session_log_fts f ON s.rowid = f.rowid
  WHERE session_log_fts MATCH 'vite' ORDER BY s.work_date DESC;
```

### Backup

The database is a single file. Back it up however you prefer:

```bash
cp ~/.agent-memory/memory.db ~/.agent-memory/memory.db.bak
```

Or add `~/.agent-memory/` to your backup tool (Time Machine, rsync, etc.).

## Development

```bash
npm run dev          # Run with tsx (hot reload)
npm run build        # Build with tsup
npm run typecheck    # Type-check without emitting
npm start            # Run the built version
```

## How Agents Should Use This

1. **At the start of every task**: Call `get_context` with the relevant areas
2. **When encountering an error**: Call `search_memory` with the error message
3. **After fixing a bug**: Call `store_memory` with all relevant details
4. **When a fix is refined**: Call `update_memory` to improve the entry
5. **When the user states a durable preference**: Call `store_rule` immediately — not at the end of the session, by which point the wording is lost
6. **At the end of every session**: Call `store_session_log` with what was worked on

The `integration/` folder contains skill files and rules that teach agents this workflow automatically.
