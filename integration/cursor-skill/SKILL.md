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

## Rules

1. Always search before attempting a fix for any non-trivial error
2. Always store after fixing a bug that took more than one attempt
3. Include the actual error message in the `symptom` field so future searches match
4. Use specific, searchable `tags` -- prefer `vue,vuetify,v-select` over `frontend`
5. Set `severity` to `critical` for bugs that cause data loss or security issues
6. Set `project` only for project-specific issues; omit for general knowledge

## Good Memory Entry Checklist

- Title is a single sentence describing the problem
- Symptom contains the error message or exact observable behavior
- Fix is actionable (someone can apply it without further research)
- Tags are specific enough to narrow search results
- Code example shows the wrong way AND the right way (when applicable)
