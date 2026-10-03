import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getActiveRules, getContextMemories } from "../db.js";
import type { MemoryEntry, RuleEntry } from "../types.js";

function formatEntry(entry: MemoryEntry): string {
  const parts = [
    `### [${entry.id}] ${entry.title}`,
    `- **Type**: ${entry.type} | **Area**: ${entry.area} | **Severity**: ${entry.severity}`,
  ];
  if (entry.trigger_context) parts.push(`- **Trigger**: ${entry.trigger_context}`);
  parts.push(`- **Symptom**: ${entry.symptom}`);
  if (entry.root_cause) parts.push(`- **Root cause**: ${entry.root_cause}`);
  parts.push(`- **Fix**: ${entry.fix}`);
  if (entry.code_example) parts.push(`- **Code**:\n\`\`\`\n${entry.code_example}\n\`\`\``);
  if (entry.tags) parts.push(`- **Tags**: ${entry.tags}`);
  return parts.join("\n");
}

/**
 * Rules ride along with every get_context call. The SessionStart hook pushes them
 * too, but that hook is Claude Code only — for Cursor and Codex, which talk to this
 * same server, get_context is the one call their instructions guarantee at task
 * start, so it is where a standing instruction has to appear.
 */
function formatRule(entry: RuleEntry): string {
  const scope = entry.project ? ` *[${entry.project}]*` : "";
  const why = entry.rationale ? ` — *${entry.rationale}*` : "";
  return `- **${entry.mode.toUpperCase()}**${scope}: ${entry.rule}${why}`;
}

export function registerGetContext(server: McpServer): void {
  server.registerTool("get_context", {
    description:
      "Get all relevant memories for the current work context. " +
      "Call this at the START of every task to load known bugs and patterns for the areas you will be working in.",
    inputSchema: {
      areas: z.array(z.string()).describe("Tech areas involved in this task: ['php', 'vue', 'mysql', etc.]"),
      task_description: z.string().optional().describe("Brief description of what you are about to do (used for semantic matching)"),
      project: z.string().optional().describe("Current project name"),
    },
  }, async (args) => {
    const results = getContextMemories(args.areas, args.task_description, args.project);
    const rules = getActiveRules(args.project ?? null);

    const rulesBlock = rules.length > 0
      ? `## Standing rules — obey these for the whole session\n\n${rules.map(formatRule).join("\n")}\n\n`
        + `Change them only through store_rule / update_rule / delete_rule; never edit memory.db directly.\n\n---\n\n`
      : "";

    if (results.length === 0) {
      return {
        content: [{
          type: "text",
          text: `${rulesBlock}No relevant memories found for areas: ${args.areas.join(", ")}. Proceed without prior context.`,
        }],
      };
    }

    const formatted = results.map(formatEntry).join("\n\n---\n\n");
    return {
      content: [{
        type: "text",
        text: `${rulesBlock}Found ${results.length} relevant memories for your current task:\n\n${formatted}`,
      }],
    };
  });
}
