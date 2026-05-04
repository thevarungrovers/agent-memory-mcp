import { z } from "zod";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { insertMemory } from "../db.js";

export function registerStoreMemory(server: McpServer): void {
  server.registerTool("store_memory", {
    description:
      "Store a bug, pattern, gotcha, or learning in the agent memory database. " +
      "Call this whenever you fix a bug, discover a pitfall, or learn something that should not be forgotten.",
    inputSchema: {
      title: z.string().describe("Short one-line description of the memory"),
      type: z.enum(["bug", "pattern", "gotcha", "solution", "learning"]).describe("Category of this memory entry"),
      project: z.string().optional().describe("Project name (omit for global/cross-project memories)"),
      area: z.string().describe("Tech area: php, vue, mysql, docker, yii2, python, typescript, etc."),
      trigger_context: z.string().optional().describe("What you were doing when this surfaced"),
      symptom: z.string().describe("The error message or observable problem"),
      root_cause: z.string().optional().describe("Why it happened (the underlying reason)"),
      fix: z.string().describe("The correct solution or workaround"),
      code_example: z.string().optional().describe("Code snippet showing wrong vs right approach"),
      tags: z.string().optional().describe("Comma-separated tags for search (e.g. 'sql,join,left-join')"),
      severity: z.enum(["critical", "major", "minor", "info"]).optional().describe("How impactful this issue is (defaults to 'major')"),
    },
  }, async (args) => {
    const id = randomUUID();
    const entry = insertMemory({
      id,
      title: args.title,
      type: args.type,
      project: args.project ?? null,
      area: args.area,
      trigger_context: args.trigger_context ?? null,
      symptom: args.symptom,
      root_cause: args.root_cause ?? null,
      fix: args.fix,
      code_example: args.code_example ?? null,
      tags: args.tags ?? null,
      severity: args.severity ?? "major",
    });

    return {
      content: [{
        type: "text",
        text: `Memory stored successfully.\n\nID: ${entry.id}\nTitle: ${entry.title}\nType: ${entry.type}\nArea: ${entry.area}\nSeverity: ${entry.severity}`,
      }],
    };
  });
}
