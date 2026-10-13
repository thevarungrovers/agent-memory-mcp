import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listMemories as listMemoriesDb } from "../db.js";
import type { MemoryEntry } from "../types.js";

function formatEntryCompact(entry: MemoryEntry): string {
  const project = entry.project ? ` [${entry.project}]` : "";
  const archived = entry.archived_at ? " *(archived)*" : "";
  // The date is here because without it there is no way to ask the store what it
  // learned today — every other read path renders no timestamp at all.
  const when = (entry.updated_at ?? "").slice(0, 10);
  return `- **${entry.id}** (${entry.type}/${entry.severity}) ${when} ${entry.title}${project} — ${entry.area}${archived}`;
}

export function registerListMemories(server: McpServer): void {
  server.registerTool("list_memories", {
    description:
      "List memory entries, optionally filtered by project, area, type, severity, or when they were last " +
      "updated. Use to browse what is stored, or with since/until to see what a given day produced.",
    inputSchema: {
      project: z.string().optional().describe("Filter by project name"),
      area: z.string().optional().describe("Filter by tech area"),
      type: z.enum(["bug", "pattern", "gotcha", "solution", "learning"]).optional().describe("Filter by type"),
      severity: z.enum(["critical", "major", "minor", "info"]).optional().describe("Filter by severity"),
      since: z
        .string()
        .optional()
        .describe("Only memories updated on or after this LOCAL date, YYYY-MM-DD (inclusive)"),
      until: z
        .string()
        .optional()
        .describe("Only memories updated on or before this LOCAL date, YYYY-MM-DD (inclusive)"),
      include_archived: z.boolean().optional().describe("Also list archived memories (default false)"),
      limit: z.number().optional().describe("Max results (default 20)"),
      offset: z.number().optional().describe("Offset for pagination"),
    },
  }, async (args) => {
    const results = listMemoriesDb({
      project: args.project,
      area: args.area,
      type: args.type,
      severity: args.severity,
      since: args.since,
      until: args.until,
      include_archived: args.include_archived,
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
