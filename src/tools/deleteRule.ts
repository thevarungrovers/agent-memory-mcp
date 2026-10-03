import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deleteRule as deleteRuleDb } from "../db.js";

export function registerDeleteRule(server: McpServer): void {
  server.registerTool("delete_rule", {
    description:
      "Permanently remove a standing instruction. " +
      "Only when the user says the rule is wrong or no longer applies — " +
      "if they are pausing it, use update_rule with active=false instead so the wording survives.",
    inputSchema: {
      id: z.string().describe("The rule ID to delete (from list_rules)"),
    },
  }, async (args) => {
    const deleted = deleteRuleDb(args.id);

    return {
      content: [{
        type: "text",
        text: deleted ? `Rule ${args.id} deleted.` : `No rule found with ID: ${args.id}`,
      }],
    };
  });
}
