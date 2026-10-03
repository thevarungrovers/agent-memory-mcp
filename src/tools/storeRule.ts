import { z } from "zod";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { insertRule } from "../db.js";

export function registerStoreRule(server: McpServer): void {
  server.registerTool("store_rule", {
    description:
      "Store a standing instruction the user wants obeyed in every future session: " +
      "\"always X\", \"never Y\", \"prefer A over B\", \"ask before Z\". " +
      "Call this the MOMENT the user states a durable preference or corrects how you work — " +
      "not at the end of the session, by which point the wording is already lost. " +
      "This is NOT store_memory: a memory is something learned, found by searching for its symptom, " +
      "while a rule has no symptom and is pushed into every session automatically. " +
      "A one-off instruction for the current task is neither — do not store it.",
    inputSchema: {
      rule: z.string().describe("The instruction itself, imperative and one line: 'Never force-push a shared branch'"),
      mode: z.enum(["always", "never", "prefer", "ask"]).describe("Shape of the instruction: 'never' forbids, 'always' requires, 'prefer' picks a default, 'ask' requires confirmation first"),
      rationale: z.string().optional().describe("Why the user wants this — a rule with a reason survives edge cases a bare imperative does not"),
      project: z.string().optional().describe("Project or repo name to scope the rule to. Omit for a rule that applies everywhere"),
      area: z.string().optional().describe("Tech area if the rule only applies to one: git, sql, vue, docker"),
      priority: z.enum(["critical", "high", "normal"]).optional().describe("'critical' for rules whose violation is destructive or hard to undo (default 'normal')"),
      tags: z.string().optional().describe("Comma-separated tags (e.g. 'git,branching')"),
    },
  }, async (args) => {
    const entry = insertRule({
      id: randomUUID(),
      rule: args.rule,
      mode: args.mode,
      project: args.project ?? null,
      area: args.area ?? null,
      rationale: args.rationale ?? null,
      priority: args.priority ?? "normal",
      tags: args.tags ?? null,
    });

    if (!entry) {
      return {
        content: [{
          type: "text",
          text: `That rule is already stored for this scope — nothing to do. Use list_rules to see it, or update_rule to change its wording.`,
        }],
      };
    }

    const scope = entry.project ? `project '${entry.project}'` : "all projects";
    return {
      content: [{
        type: "text",
        text: `Rule stored and in force from the next session on.\n\nID: ${entry.id}\n${entry.mode.toUpperCase()}: ${entry.rule}\nScope: ${scope} | Priority: ${entry.priority}`,
      }],
    };
  });
}
