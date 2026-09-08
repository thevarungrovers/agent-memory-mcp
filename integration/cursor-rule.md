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
