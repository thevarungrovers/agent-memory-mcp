import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { updateRule as updateRuleDb } from "../db.js";
import type { RuleEntry } from "../types.js";

export function registerUpdateRule(server: McpServer): void {
  server.registerTool("update_rule", {
    description:
      "Change a standing instruction: reword it, rescope it, or switch it off with active=false. " +
      "Prefer this over store_rule when the user is refining a rule they already have, " +
      "and prefer active=false over delete_rule when a rule is merely suspended — " +
      "a switched-off rule keeps its wording and rationale for when it comes back.",
    inputSchema: {
      id: z.string().describe("The rule ID to update (from list_rules)"),
      rule: z.string().optional().describe("Updated instruction text"),
      mode: z.enum(["always", "never", "prefer", "ask"]).optional().describe("Updated instruction shape"),
      rationale: z.string().optional().describe("Updated reason"),
      project: z.string().optional().describe("Updated project scope"),
      area: z.string().optional().describe("Updated tech area"),
      priority: z.enum(["critical", "high", "normal"]).optional().describe("Updated priority"),
      active: z.boolean().optional().describe("false switches the rule off without deleting it; true switches it back on"),
      tags: z.string().optional().describe("Updated tags"),
    },
  }, async (args) => {
    // db.updateRule already skips undefined fields, so the spread needs no filtering;
    // `active` is the one field whose wire type (boolean) differs from its column type.
    const { id, active, ...rest } = args;
    const updates: Partial<Omit<RuleEntry, "id" | "created_at">> = { ...rest };
    if (active !== undefined) updates.active = active ? 1 : 0;

    const result = updateRuleDb(id, updates);

    if (!result) {
      return { content: [{ type: "text", text: `No rule found with ID: ${id}` }] };
    }

    const state = result.active === 1 ? "active" : "switched off";
    return {
      content: [{
        type: "text",
        text: `Rule updated (${state}).\n\nID: ${result.id}\n${result.mode.toUpperCase()}: ${result.rule}`,
      }],
    };
  });
}
