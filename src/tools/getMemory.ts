import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMemoryById } from "../db.js";
import type { MemoryEntry } from "../types.js";

/**
 * The full body, in contrast to the projections search_memory and get_context now
 * return. This is the second half of a two-step retrieval: find cheaply, read one.
 */
function formatEntry(entry: MemoryEntry): string {
  const parts = [
    `### [${entry.id}] ${entry.title}`,
    `- **Type**: ${entry.type} | **Area**: ${entry.area} | **Severity**: ${entry.severity}`,
  ];
  if (entry.project) parts.push(`- **Project**: ${entry.project}`);
  parts.push(`- **Created**: ${entry.created_at} | **Updated**: ${entry.updated_at}`);
  if (entry.archived_at) {
    const why = entry.archive_reason ? ` (${entry.archive_reason})` : "";
    parts.push(`- **ARCHIVED**: ${entry.archived_at}${why}`);
  }
  if (entry.superseded_by) parts.push(`- **Superseded by**: ${entry.superseded_by}`);
  if (entry.trigger_context) parts.push(`- **Trigger**: ${entry.trigger_context}`);
  parts.push(`- **Symptom**: ${entry.symptom}`);
  if (entry.root_cause) parts.push(`- **Root cause**: ${entry.root_cause}`);
  parts.push(`- **Fix**: ${entry.fix}`);
  if (entry.curator_note) parts.push(`- **Curator notes**:\n${entry.curator_note}`);
  if (entry.code_example) parts.push(`- **Code**:\n\`\`\`\n${entry.code_example}\n\`\`\``);
  if (entry.tags) parts.push(`- **Tags**: ${entry.tags}`);
  return parts.join("\n");
}

export function registerGetMemory(server: McpServer): void {
  server.registerTool("get_memory", {
    description:
      "Read one memory in full by its id, including archived ones. " +
      "search_memory and get_context return short projections to stay inside the tool-output " +
      "budget; call this for the complete body of the one entry you actually need.",
    inputSchema: {
      id: z.string().describe("The memory ID, as printed by search_memory or list_memories"),
    },
  }, async (args) => {
    const entry = getMemoryById(args.id);
    if (!entry) {
      return { content: [{ type: "text", text: `No memory found with id ${args.id}.` }] };
    }
    return { content: [{ type: "text", text: formatEntry(entry) }] };
  });
}
