import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listRules as listRulesDb } from "../db.js";
import type { RuleEntry } from "../types.js";

function formatRule(entry: RuleEntry): string {
  const scope = entry.project ? ` *[${entry.project}]*` : "";
  const area = entry.area ? ` *(${entry.area})*` : "";
  const inactive = entry.active === 0 ? " — **INACTIVE**" : "";
  const parts = [`- **[${entry.id}]** \`${entry.mode}\`/${entry.priority}${scope}${area}${inactive}\n  ${entry.rule}`];
  if (entry.rationale) parts.push(`  - *Why*: ${entry.rationale}`);
  if (entry.tags) parts.push(`  - *Tags*: ${entry.tags}`);
  return parts.join("\n");
}

export function registerListRules(server: McpServer): void {
  server.registerTool("list_rules", {
    description:
      "List the standing instructions stored for this user. " +
      "Active rules are already injected at session start, so reach for this when you need a rule's ID " +
      "in order to change or remove one, when checking whether a rule already exists before storing it, " +
      "or when the user asks what rules they have.",
    inputSchema: {
      project: z.string().optional().describe("Show global rules plus the ones scoped to this project"),
      area: z.string().optional().describe("Filter by tech area"),
      mode: z.enum(["always", "never", "prefer", "ask"]).optional().describe("Filter by instruction shape"),
      priority: z.enum(["critical", "high", "normal"]).optional().describe("Filter by priority"),
      include_inactive: z.boolean().optional().describe("Include rules that have been switched off (default false)"),
      limit: z.number().optional().describe("Max rules to return (default 100)"),
    },
  }, async (args) => {
    const results = listRulesDb({
      project: args.project,
      area: args.area,
      mode: args.mode,
      priority: args.priority,
      include_inactive: args.include_inactive,
      limit: args.limit,
    });

    if (results.length === 0) {
      return { content: [{ type: "text", text: "No rules stored yet." }] };
    }

    return {
      content: [{
        type: "text",
        text: `${results.length} rule${results.length === 1 ? "" : "s"}:\n\n${results.map(formatRule).join("\n")}`,
      }],
    };
  });
}
