## Agent Memory

You have access to an `agent-memory` MCP server with these tools:
- `store_memory` — Save a bug, pattern, or learning
- `search_memory` — Full-text search for known issues
- `get_context` — Load relevant memories for your current task
- `list_memories` — Browse stored entries
- `update_memory` — Amend an existing entry
- `delete_memory` — Remove an obsolete entry

**Workflow:**

1. At the start of every task, call `get_context` with the tech areas you will work in
2. When you encounter an error, call `search_memory` with the error message before attempting a fix
3. After fixing a bug, call `store_memory` with all relevant details (include the error message in `symptom`)
4. If a search returns a matching memory, apply the documented fix instead of rediscovering it
