import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listMemories as listMemoriesDb } from "../db.js";
import type { MemoryEntry } from "../types.js";

function formatEntryCompact(entry: MemoryEntry): string {
  const project = entry.project ? ` [${entry.project}]` : "";
  return `- **${entry.id}** (${entry.type}/${entry.severity}) ${entry.title}${project} — ${entry.area}`;
}

export function registerListMemories(server: McpServer): void {
  server.registerTool("list_memories", {
    description:
      "List memory entries, optionally filtered by project, area, type, or severity. " +
      "Use to browse what is stored in the memory database.",
    inputSchema: {
      project: z.string().optional().describe("Filter by project name"),
      area: z.string().optional().describe("Filter by tech area"),
      type: z.enum(["bug", "pattern", "gotcha", "solution", "learning"]).optional().describe("Filter by type"),
      severity: z.enum(["critical", "major", "minor", "info"]).optional().describe("Filter by severity"),
      limit: z.number().optional().describe("Max results (default 20)"),
      offset: z.number().optional().describe("Offset for pagination"),
    },
  }, async (args) => {
    const results = listMemoriesDb({
      project: args.project,
      area: args.area,
      type: args.type,
      severity: args.severity,
      limit: args.limit,
      offset: args.offset,
    });

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: "No memories found matching the given filters." }],
      };
    }

    const formatted = results.map(formatEntryCompact).join("\n");
    return {
      content: [{
        type: "text",
        text: `${results.length} memories:\n\n${formatted}`,
      }],
    };
  });
}
