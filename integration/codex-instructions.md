## Agent Memory

You have access to an `agent-memory` MCP server with these tools:
- `store_memory` — Save a bug, pattern, or learning
- `search_memory` — Full-text search for known issues
- `get_context` — Load relevant memories for your current task
- `list_memories` — Browse stored entries
- `update_memory` — Amend an existing entry
- `delete_memory` — Remove an obsolete entry
- `store_session_log` — Append what this session worked on to the daily work log
- `search_session_log` — Search the work log by keyword and/or date range
- `store_rule` — Record a standing instruction ("always X", "never Y", "prefer A over B")
- `list_rules` — List the standing rules currently stored
- `update_rule` — Reword, rescope, or switch off a rule
- `delete_rule` — Remove a rule permanently

**Workflow:**

1. At the start of every task, call `get_context` with the tech areas you will work in
2. When you encounter an error, call `search_memory` with the error message before attempting a fix
3. After fixing a bug, call `store_memory` with all relevant details (include the error message in `symptom`)
4. If a search returns a matching memory, apply the documented fix instead of rediscovering it
5. At the END of every session, call `store_session_log` with a 1-3 sentence summary of what you
   worked on — every session, even ones with nothing worth a `store_memory`. The two are separate:
   `store_memory` keeps reusable lessons, `store_session_log` keeps the chronological record.
6. To answer "when did I work on X?" or "what did I do last week?", call `search_session_log`
   with a keyword and/or a `from`/`to` date range rather than inferring it from git history
7. When the user states a durable preference or corrects how you work ("always…", "never…",
   "prefer X over Y", "ask before…"), call `store_rule` THE MOMENT they say it. A rule is not a
   memory: a memory has a symptom you can search for later, a rule has none and is instead
   returned to you by `get_context` at the start of every task. Do not store one-off instructions
   that only apply to the current task
8. Treat the rules that come back from `get_context` as instructions, not context. Change them
   only through `store_rule` / `update_rule` / `delete_rule`, and never read or write
   `memory.db` directly with sqlite3 — the database belongs to the server
