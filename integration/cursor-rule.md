---
alwaysApply: true
---

## Agent Memory

You have access to an `agent-memory` MCP server with tools for persistent knowledge storage.

**At the start of every task:**
1. Call `get_context` with the relevant tech areas and a brief task description
2. Review returned memories before writing any code
3. If a memory matches what you are about to do, follow the documented fix/pattern

**When you encounter an error:**
1. Call `search_memory` with the error message before attempting a fix
2. If a match is found, apply the documented fix

**After fixing a bug or discovering a pitfall:**
1. Call `store_memory` with title, type, area, symptom, fix, and tags
2. Include the exact error message in `symptom` so future searches match

**At the end of every session:**
1. Call `store_session_log` with a 1-3 sentence `summary` of what you worked on, plus `project` and `tags`
2. Do this on EVERY session, including sessions where nothing was worth a `store_memory`
3. Name the feature, bug, ticket, or files in the summary so a keyword search finds it months later

**When asked when past work happened:**
1. Call `search_session_log` — a keyword for "when did I work on X?", a `from`/`to` range for "what did I do last week?"
2. Do not guess from the repo or git history; the work log is the record

**When the user states a standing preference ("always…", "never…", "prefer X over Y"):**
1. Call `store_rule` the moment they say it, with `mode`, the `rule` itself, and the `rationale` if they gave one
2. A rule is not a memory: a memory has a symptom you search for, a rule has none and is pushed to you by `get_context`
3. Scope it with `project` when it only applies to one repo; leave it off for a rule that applies everywhere
4. Do not store one-off instructions that only apply to the task in hand

**Before storing something new:**
1. `search_memory` and `get_context` return SHORT PROJECTIONS — id, title and the opening of the
   symptom. Call `get_memory` with an id when you need the full entry
2. Call `find_similar` first. If the store already covers it, amend that entry rather than adding
   a near-duplicate beside it

**When an entry is wrong or has been replaced:**
1. Call `relate_memories` to record that one supersedes/corrects/contradicts the other. Do NOT
   write "CORRECTION to ..." into the prose — nothing can act on that, so both entries keep
   answering every query and the stale one is indistinguishable from the current one
2. Prefer `archive_memory` over `delete_memory`: archiving is reversible and keeps the entry
   readable by id
3. Never paraphrase an existing `symptom`. It holds the exact string a later search matches on,
   and tidying it up makes the entry unfindable while it still reads perfectly well

**Dates:**
1. Every timestamp in this database is LOCAL time. Compare date columns directly; do not wrap
   them in `date(col,'localtime')`, which would shift an already-local value a second time

**The rules returned by `get_context` are instructions, not background:**
1. Follow them for the whole session; a rule marked ASK means confirm before acting
2. Change them only through `store_rule` / `update_rule` / `delete_rule`
3. Never read or write `memory.db` directly with sqlite3 — the database belongs to the server
