---
name: agent-memory
description: >-
  Query and store knowledge in the agent memory database using MCP tools.
  Use when fixing bugs, encountering errors, starting tasks, or when the user
  mentions memory, remember, learning, known issue, or past bug.
---

# Agent Memory

You have access to a persistent memory database via the `agent-memory` MCP server.
It stores bugs, patterns, gotchas, and learnings across all projects and sessions.

## When To Use

### At the start of every task

Call `get_context` with the tech areas you will work in:

```
get_context({ areas: ["php", "mysql"], project: "lufa-yii2", task_description: "migrating order controller" })
```

Review the returned memories before writing any code.

### When you encounter an error

Call `search_memory` with the error message or symptom:

```
search_memory({ query: "Cannot read properties of undefined reading map" })
search_memory({ query: "LEFT JOIN returns 0 rows", area: "mysql" })
```

If a match is found, apply the documented fix instead of guessing.

### After fixing a bug or discovering a pitfall

Call `store_memory` with all relevant details:

```
store_memory({
  title: "Vue v-model on Vuetify v-select requires itemValue prop",
  type: "gotcha",
  area: "vue",
  symptom: "v-select emits entire object instead of ID value",
  root_cause: "Vuetify v-select defaults to returning the whole item object",
  fix: "Add item-value=\"id\" prop to v-select when binding to an ID field",
  tags: "vue,vuetify,v-select,v-model",
  severity: "minor"
})
```

### When refining a known fix

Call `update_memory` if you discover the fix was incomplete or wrong:

```
update_memory({ id: "abc-123", fix: "Updated fix with additional edge case handling" })
```

### At the end of every session

Call `store_session_log` with what you worked on. This is a SEPARATE concern from
`store_memory`: memories are reusable lessons, the work log is the chronological record
of what happened. Log every session, including ones that produced no memory at all.

```
store_session_log({
  summary: "Migrated the order controller to Yii2 and fixed the vite manifest path",
  project: "lufa-development-yii2",
  tags: "yii2,vite,orders"
})
```

### When asked when past work happened

Call `search_session_log` instead of guessing from git history:

```
search_session_log({ query: "vite manifest" })                      // when did I work on X?
search_session_log({ from: "2026-09-01", to: "2026-09-07" })        // what did I do last week?
search_session_log({ query: "orders", project: "lufa-development-yii2" })
```

Results come back grouped by date, newest first.

### When the user states a standing preference

Call `store_rule` the moment they say it — "always X", "never Y", "prefer A over B",
"ask before Z". This is NOT a memory: a memory has a symptom you can search for later,
a rule has none, which is why rules are returned to you by `get_context` instead.

```
store_rule({
  rule: "Never force-push a branch that is already pushed",
  mode: "never",
  rationale: "it rewrites history teammates have already pulled",
  priority: "critical",
  tags: "git,branching"
})
```

Scope it with `project` when it applies to one repo only. To change or retire one, use
`update_rule` (with `active: false` to park it) or `delete_rule` — never edit the database.

## Rules

1. Always search before attempting a fix for any non-trivial error
2. Always store after fixing a bug that took more than one attempt
3. Include the actual error message in the `symptom` field so future searches match
4. Use specific, searchable `tags` -- prefer `vue,vuetify,v-select` over `frontend`
5. Set `severity` to `critical` for bugs that cause data loss or security issues
6. Set `project` only for project-specific issues; omit for general knowledge
7. Always call `store_session_log` before finishing, even when there is no memory to store
8. Never rewrite an existing work-log row -- the log is append-only, one row per session
9. Treat the standing rules returned by `get_context` as instructions for the whole session, not background
10. Never open `~/.agent-memory/memory.db` with sqlite3 to read or write -- go through the MCP tools

## Good Memory Entry Checklist

- Title is a single sentence describing the problem
- Symptom contains the error message or exact observable behavior
- Fix is actionable (someone can apply it without further research)
- Tags are specific enough to narrow search results
- Code example shows the wrong way AND the right way (when applicable)
