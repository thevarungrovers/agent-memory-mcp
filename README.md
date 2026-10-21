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

Full-text search across all memory entries. Returns a **projection** of each hit — id,
title, type/severity, area and the first 200 characters of the symptom — not the whole
entry. Call `get_memory` for a full body.

> Why: this used to render every field of every hit, `code_example` included. At a
> ~4.5KB mean body a 28-hit query came to 130,500 characters and exceeded the
> tool-output cap, so no memories reached the model at all. Retrieval is two steps:
> find cheaply, read one.

| Parameter        | Required | Description                                            |
| ---------------- | -------- | ------------------------------------------------------ |
| query            | Yes      | Free-text search (error message, keyword, description) |
| area             | No       | Filter by tech area                                    |
| project          | No       | Filter by project                                      |
| type             | No       | Filter by type                                         |
| tags             | No       | Filter by tags (comma-separated, matches ANY)          |
| limit            | No       | Max results (default 10)                               |
| include_archived | No       | Also return archived entries (default false)           |

### get_memory

One entry in full, by id — including archived ones. The second half of the two-step
retrieval above.

| Parameter | Required | Description   |
| --------- | -------- | ------------- |
| id        | Yes      | The memory ID |

### get_context

Smart retrieval for the current task. Returns critical/major entries for the given areas plus FTS matches against the task description.

| Parameter        | Required | Description                                           |
| ---------------- | -------- | ----------------------------------------------------- |
| areas            | Yes      | Array of tech areas: `["php", "vue", "mysql"]`        |
| task_description | No       | What you are about to do (used for semantic matching) |
| project          | No       | Current project name                                  |

Returns projections, for the same reason `search_memory` does.

### list_memories

Browse entries with optional filters.

| Parameter | Required | Description              |
| --------- | -------- | ------------------------ |
| project          | No       | Filter by project                                        |
| area             | No       | Filter by area                                           |
| type             | No       | Filter by type                                           |
| severity         | No       | Filter by severity                                       |
| since            | No       | Only entries updated on/after this local date YYYY-MM-DD |
| until            | No       | Only entries updated on/before this local date           |
| include_archived | No       | Also list archived entries (default false)               |
| limit            | No       | Max results (default 20)                                 |
| offset           | No       | Pagination offset                                        |

### update_memory

Update an existing entry.

| Parameter   | Required | Description                                |
| ----------- | -------- | ------------------------------------------ |
| id          | Yes      | The memory ID to update                    |
| (any field) | No       | Any field from store_memory can be updated |

### delete_memory

Permanently remove an entry. **Prefer `archive_memory`** — it is reversible and keeps
the entry readable by id.

| Parameter | Required | Description             |
| --------- | -------- | ----------------------- |
| id        | Yes      | The memory ID to delete |

### archive_memory

Hide an entry from `search_memory`, `get_context` and `list_memories` while keeping it
readable by id and restorable. This is the soft delete the nightly curator uses.

| Parameter     | Required | Description                                                              |
| ------------- | -------- | ------------------------------------------------------------------------ |
| id            | Yes      | The memory ID to archive                                                 |
| reason        | Yes      | `duplicate_of`, `superseded_by`, `stale`, or `no_longer_relevant`        |
| superseded_by | No\*     | The entry that replaces this one. Required for the first two reasons      |

Reasons are an enum rather than free text because a free-text reason always succeeds —
"stale" will absorb anything asked of it. Only the two that can be machine-checked are
ever acted on by an unattended run.

### restore_memory

Bring an archived entry back.

| Parameter | Required | Description              |
| --------- | -------- | ------------------------ |
| id        | Yes      | The memory ID to restore |

### find_similar

Neighbours of an entry, for spotting redundancy before adding another near-duplicate.

| Parameter | Required | Description                        |
| --------- | -------- | ---------------------------------- |
| id        | No\*     | Memory ID to find neighbours of    |
| text      | No\*     | Free text, when there is no id yet |
| limit     | No       | Max neighbours (default 8)         |

\* One of `id` or `text` is required.

### relate_memories

Record that one entry supersedes, corrects, contradicts, duplicates or refines another.

Use this instead of writing "CORRECTION to ..." into the prose. That convention is how
this store decayed: nothing can act on it, so both entries keep answering every query
and the stale one is indistinguishable from the current one.

| Parameter | Required | Description                                                               |
| --------- | -------- | ------------------------------------------------------------------------- |
| from_id   | Yes      | The newer or correcting entry. Pass alone to list existing relations        |
| to_id     | No       | The older or corrected entry                                              |
| kind      | No\*     | `supersedes`, `corrects`, `contradicts`, `duplicate_of`, `refines`        |
| note      | No       | One line on what changed                                                  |

\* Required when `to_id` is given. A `corrects`/`contradicts` target becomes
archive-immune: a correction read without the belief it corrects loses the reason the
wrong belief was plausible.

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

## Nightly Curation

A store that is only ever appended to decays in a specific way. An agent that finds a
stale entry fixes it by **writing a new entry next to it**, because updating needs an id
nobody looks up — so both keep answering every query and the stale one is
indistinguishable from the current one. The same gotcha gets re-learned and re-stored by
sessions that did not find the existing entry. Entries accumulate about repositories
that no longer exist.

The curator is a scheduled pass that reads what changed, compares it against the rest of
the corpus, and merges, supersedes or archives. It is off until you install it.

```sh
npm run build
bash scripts/install-curator.sh              # nightly only
bash scripts/install-curator.sh nightly weekly
bash scripts/install-curator.sh --status
bash scripts/install-curator.sh --uninstall
```

Installing does not run anything — `RunAtLoad` is false, so the first pass is the next
23:00. To force one:

```sh
bash scripts/run-curator.sh nightly
```

### Dry runs

```sh
CURATOR_EXTRA_ARGS=--dry-run bash scripts/run-curator.sh nightly
```

Every decision is recorded as a proposal and nothing is changed. Read a few reports in
`curator/reports/` this way before trusting a new install unattended — they cost nothing
if its judgement turns out to be poor, which is the entire point of looking.

Leaving `--dry-run` in `curator/config.env` permanently is a trap worth naming: a dry
pass still exits 0 and still reports `ok`, so the only thing distinguishing it from a
working installation is the scorecard reading `0 changed, N to review`. If the corpus
never changes, check there first.

### The dashboard

```sh
npm run dashboard            # or: node dist/cli.js dashboard [--port 4777] [--no-open]
```

One local page over the curator's ledger, so you never have to read the reports to act
on them. Each night writes its own report, and a question the curator could not settle
used to be re-asked in a new file every night with nowhere to answer it. The dashboard
shows each question once, however many nights it was asked, and every item carries the
buttons that answer it:

- **Needs attention** — a set failure latch (*Resume the curator*), a run stuck in
  `running` (*Mark it failed*), a guard claim never released, an inconsistent search
  index (*Rebuild*), trailing-window erosion, moved canaries (*New baseline*), an archive
  of an entry under 30 days old (*Restore* / *The archive is right*), guard refusals.
- **Your decisions** — the curator's proposals, grouped by the job they ask of you rather
  listed one note at a time. Every card leads with what it wants and *why you* — why the
  curator could not do it itself — with its full reasoning folded underneath:
  - *Remove a duplicate* — the two entries side by side; archive, keep both, or link.
  - *Merge repeated entries* — every note about one re-stored lesson becomes one card
    listing the copies. Pick the entry to keep; ticked copies are marked replaced by it
    (or archived). Copies whose titles share little with the main one start unticked,
    because a note's list of "the same gotcha" ids is not always right.
  - *Fix broken entries* — rows where a tool call's XML leaked into a field
    (`…</fix>\n<root_cause>…`) and the later fields were never stored, read from the rows
    themselves. Most can be repaired in place: *Preview fix* shows exactly what moves,
    and *Repair* moves the spilled text back into its own field without rewording it.
    A conflict with text already in that field is left for you. Repairs are recorded in
    `memory_revisions` like any other edit.
  - *Mark entries replaced* — a newer entry supersedes an older one; both stay readable.
  - *Other suggestions* — anything else, headed by the curator's one-line `ask`.

  Links are never put to you: a link only cross-references two entries, so the curator
  applies it on its own — including any left waiting by a dry run, which the next live
  run settles before it does anything else. They appear under *Recent changes* with an
  undo, and until then as a collapsed "queued" line.

  Notes that ask for nothing (the curator explaining a KEEP), settled questions and the
  dry-run leftovers are collapsed underneath with a *Clear all*.
- **Recent changes** — what the curator did on its own in the last 14 days, each with an
  *Undo* that reverts that one change and any link it drew.
- **Runs** — every pass with its decisions, and *Undo whole run*.

Clicking an entry anywhere opens it in full, with archive / restore / supersede / link
controls and a search to pick the other entry by title or id.

Answers are stored on the ledger row (`curation_actions.resolved_at`, `resolution`). A
`PROPOSE` must carry an `ask` — one imperative sentence — and a note that only explains a
kept entry must be a `KEEP`; both are in `curator/PROMPT.md`.
A proposal you dismissed is answered automatically if the curator asks the identical
question again about a row nobody has edited since, and the nightly report counts it
instead of re-listing it. Every write goes through `db.ts` as a session writer, never as
the curator, so `undo --run` never reverts a decision you made by hand.

It binds to 127.0.0.1 only, and every API call needs a token minted at start-up and
embedded in the page it serves, so another website open in the same browser cannot drive
it. Like the scheduled job, it refuses to start when `~/.agent-memory` is a symlink to an
unmounted drive instead of replacing it with an empty store.

### What it changed

The report's first section after the red flags is **What changed**, and it is the
section the rest exists to support. It lists only the verdicts that left a row different
from how they found it, with the effect rather than the verdict — `archived in favour of
<id>`, `tags -> a,b,c` — and says "Nothing." outright on the nights nothing moved. The
entries it read and found correct are counted separately and collapsed; they are not
changes and do not belong in the same list.

### Notifications (optional)

Set a Discord webhook in `curator/config.env` and every run reports itself: the summary
line, what it changed, any red flags, and the path to the full report.

```sh
CURATOR_DISCORD_WEBHOOK="https://discord.com/api/webhooks/..."
CURATOR_NOTIFY_LEVEL=all        # all (default) | changes | errors | off
```

With no webhook set, every notification is a silent no-op — nothing warns, nothing
fails. Failures are announced whatever the level is set to, including the preflight ones
that happen before node is involved. `changes` drops the nights where nothing moved,
which is the setting to reach for when a nightly "nothing happened" has stopped being
read.

Values in `config.env` are sourced by bash, so quote anything containing a space:
`CURATOR_EXTRA_ARGS="--limit 10"`, never `CURATOR_EXTRA_ARGS=--limit 10` — unquoted,
bash runs the rest of the line as a command.

### How a pass works

1. **Preflight** — refuses to start if the store is not mounted (see below), if node
   cannot load `better-sqlite3`, or if the FTS index is already inconsistent.
2. **Snapshot** — `VACUUM INTO curator/state/snapshots/`, kept 14 days.
3. **Packet** — the entries that changed since the last successful pass, each with its
   nearest neighbours and a computed similarity score.
4. **Decide** — a `claude -p` subprocess with two file tools and *no database access of
   any kind*. It reads the packet, writes decisions as JSON.
5. **Apply** — every claim the model makes is re-derived before it is acted on.
6. **Verify** — FTS integrity, trailing-window invariants, and the canary set.
7. **Report** — `curator/reports/<date>-<mode>.md`, generated from the ledger, and
   posted to Discord if a webhook is configured.

The model never touches the database. That shape is doing three jobs: a nightly job
should not depend on an MCP server (one spawned under launchd has been seen to die with
`CONNECTION_CLOSED` while the identical invocation works from a terminal), no allowlist
mistake can hand the model a write path, and every decision is reviewable before it is
applied rather than after.

### What it is allowed to do on its own

Only things that can be checked:

| Applied | Proposed for you |
| ------- | ---------------- |
| Archive a **verified** duplicate — similarity recomputed at apply time | Anything below that similarity threshold |
| Stamp `superseded_by`, record relations | Archiving for "stale" or "no longer relevant" |
| Add tags (never remove one) | Merges, splits, anything else |
| Append a dated note | |

And things it structurally cannot do, enforced by SQLite triggers rather than by
instructions — no prompt, allowlist or CLI flag routes around them:

- **`symptom` and `code_example` are append-only.** An entry is findable because its
  symptom holds the exact string a later search matches — error text, flags, paths, line
  numbers. Paraphrasing them is the most damaging thing available here, because the
  entry still reads well and has quietly become unreachable.
- No edit that cuts more than 20% of the prose.
- No severity downgrade — otherwise "never archive a critical entry" is beaten by
  downgrading it first.
- No third edit to the same entry until a human touches it.
- No archiving an entry that something else corrects or contradicts: the pair is the
  content.
- No hard deletes.

Archive budgets are counted from the ledger and enforced in code. They are deliberately
**absent from the prompt** — a budget the model can see becomes a target.

### Canaries

`curator/canaries.json` holds real queries with their top-3 results pinned, re-run before
and after every pass. This is the only end-to-end check that the store still answers the
questions it used to, and it catches blandification, over-archiving and a stale index in
one line. Edit it to match the questions you actually ask.

```sh
node dist/cli.js canary                   # compare against the baseline
node dist/cli.js canary --save-baseline   # re-pin after deliberate changes
```

### Undoing a pass

```sh
node dist/cli.js undo --run <run_id>
```

Reverts column by column from `memory_revisions`, and **skips any entry a real session
has edited since** — which a snapshot restore would silently overwrite. The run id is at
the top of every report.

### If it fails

A failed pass latches: `last_run_failed` is set, the watermark is not advanced, and the
next scheduled run refuses to start. A job that is broken should stop and say so, not
retry into the same wall nightly. After looking at the report:

```sh
node dist/cli.js state --set last_run_failed=0
```

### Expect "nightly" to mean "next morning"

If the machine is asleep at 23:00, launchd fires the job on the next wake. If it was
powered off, the occurrence is skipped and never runs. Neither loses work, because the
window is computed from the last successful pass rather than from today — a hardcoded
"today" would silently skip every night the machine slept through. To actually run at
23:00: `sudo pmset repeat wakeorpoweron MTWRFSU 22:55:00`.

### CLI

```sh
agent-memory stats                                   # corpus size, prose bytes, areas
agent-memory memories --since 2026-10-13             # what a day produced
agent-memory snapshot --out backup.db                # consistent copy of a live WAL db
agent-memory curate --mode nightly [--dry-run]
agent-memory canary [--save-baseline]
agent-memory undo --run <id>
agent-memory state [--get k] [--set k=v]
agent-memory dashboard [--port 4777] [--no-open]     # review page with action buttons
```

## Database

Data is stored at `~/.agent-memory/memory.db` (SQLite with FTS5), or wherever
`AGENT_MEMORY_DIR` points. Three independent tables carry the content: `memories`
(indexed by `memories_fts`), `session_log` (indexed by `session_log_fts`), and `rules`
(no index — a dozen rows, read in full, never searched). The curator adds
`memory_relations`, `memory_revisions`, `curation_runs`, `curation_actions`,
`curation_state` and `curation_session`.

### Timestamps are local

**Every timestamp in this database is local time**, including a one-time backfill of
rows written before that was true. Compare them directly — `date(created_at)`, not
`date(created_at, 'localtime')`, which would shift an already-local value a second time.

A store that mixes UTC and local is a trap with no good outcome: a comparison is either
silently wrong for several hours a day, or correct only when every caller remembers a
modifier that is invisible when it is missing. For an evening job the failure is total —
once the UTC date rolls over, a query for "today" matches nothing written that evening,
returns no rows, and reports success.

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

> **This fallback is destructive for an unattended job.** When `~/.agent-memory` is a
> symlink whose target is not mounted, `resolveDataDir()` *unlinks the symlink* and
> creates an empty directory in its place — so a scheduled run while the drive is
> offline would destroy the only pointer to the real database and then operate on an
> empty one. `scripts/run-curator.sh` therefore tests for this in shell before starting
> any node process; `agent-memory stats` cannot be used for the check, because the CLI
> opens the database to answer it and springs the trap itself.

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

**Do not `cp` the database.** It runs in WAL mode, so copying `memory.db` while the
write-ahead log has uncommitted frames gives you a torn or stale file. Use:

```bash
agent-memory snapshot --out ~/backups/memory-$(date +%F).db
```

which is `VACUUM INTO` — a consistent copy of a live database. The curator takes one
before every pass and keeps 14 days in `curator/state/snapshots/`.

**Never run a bare `VACUUM` on the live file.** `id` is a `TEXT PRIMARY KEY`, so rowids
are implicit and *not stable across a vacuum*, while `memories_fts` is an
external-content index keyed on exactly those rowids. One vacuum silently scrambles
every index-to-row mapping, searches start returning the wrong entries, and nothing
reports it. If it ever happens:

```sql
INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
```

## Development

```bash
npm run dev          # Run with tsx (hot reload)
npm run build        # Build with tsup
npm run typecheck    # Type-check without emitting
npm start            # Run the built version

npm test             # All three suites below
npm run test:curation  # Schema, guard triggers, archive round-trip, localtime window
npm run test:surface   # Real MCP stdio handshake — catches a tool never registered
npm run test:flow      # A full curation pass against a stubbed model
```

There is no test runner; these are plain scripts that exit non-zero on the first
failure. They all run against a throwaway `AGENT_MEMORY_DIR` and never touch the live
store.

After any `src/` change: **`npm run build` and restart your MCP client.** `dist/` is
gitignored and clients are registered against `dist/index.js`, so the session that
builds a new tool cannot call it.

## How Agents Should Use This

1. **At the start of every task**: Call `get_context` with the relevant areas
2. **When encountering an error**: Call `search_memory` with the error message
3. **After fixing a bug**: Call `store_memory` with all relevant details
4. **When a fix is refined**: Call `update_memory` to improve the entry
5. **When the user states a durable preference**: Call `store_rule` immediately — not at the end of the session, by which point the wording is lost
6. **At the end of every session**: Call `store_session_log` with what was worked on

The `integration/` folder contains skill files and rules that teach agents this workflow automatically.
