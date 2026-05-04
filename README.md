# Agent Memory MCP

A local MCP (Model Context Protocol) server that acts as a persistent memory database for coding agents. It stores bugs, patterns, gotchas, and learnings so agents never repeat the same mistakes.

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

## Database

Data is stored at `~/.agent-memory/memory.db` (SQLite with FTS5).

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

```bash
sqlite3 ~/.agent-memory/memory.db

-- List recent entries
SELECT id, title, area, severity FROM memories ORDER BY created_at DESC LIMIT 10;

-- Search by keyword
SELECT * FROM memories WHERE id IN (
  SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'LEFT JOIN'
);

-- Count by area
SELECT area, COUNT(*) FROM memories GROUP BY area;
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

The `integration/` folder contains skill files and rules that teach agents this workflow automatically.
