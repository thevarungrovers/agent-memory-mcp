import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMemoryById, searchMemories } from "../db.js";
import type { MemoryEntry } from "../types.js";

const SNIPPET = 160;

function formatProjection(entry: MemoryEntry): string {
  const project = entry.project ? ` [${entry.project}]` : "";
  const body = entry.symptom.replace(/\s+/g, " ").trim();
  const snippet = body.length > SNIPPET ? `${body.slice(0, SNIPPET)}…` : body;
  return `- **${entry.id}** (${entry.type}/${entry.severity}) ${entry.title}${project} — ${entry.area}\n  ${snippet}`;
}

/**
 * Neighbours of one memory, for spotting redundancy.
 *
 * Takes the id rather than a query because the useful question is "what else do we
 * already have that covers this?", and answering it from the entry's own title and
 * symptom is both more faithful and harder to get wrong than retyping a query.
 */
export function registerFindSimilar(server: McpServer): void {
  server.registerTool("find_similar", {
    description:
      "Find memories that overlap with a given one — the first step before merging or superseding. " +
      "Pass a memory id (preferred) or free text. Returns projections; use get_memory for full bodies.",
    inputSchema: {
      id: z.string().optional().describe("Memory ID to find neighbours of"),
      text: z.string().optional().describe("Free text, when there is no id yet"),
      limit: z.number().optional().describe("Max neighbours to return (default 8)"),
    },
  }, async (args) => {
    let query = args.text ?? "";
    let excludeId: string | undefined;

    if (args.id) {
      const entry = getMemoryById(args.id);
      if (!entry) return { content: [{ type: "text", text: `No memory found with id ${args.id}.` }] };
      query = `${entry.title} ${entry.symptom} ${entry.tags ?? ""}`;
      excludeId = entry.id;
    }
    if (!query.trim()) {
      return { content: [{ type: "text", text: "Pass either id or text." }] };
    }

    const results = searchMemories(query, { limit: args.limit ?? 8, exclude_id: excludeId });
    if (results.length === 0) return { content: [{ type: "text", text: "No similar memories found." }] };

    return {
      content: [{
        type: "text",
        text: `${results.length} possible neighbours:\n\n${results.map(formatProjection).join("\n")}`,
      }],
    };
  });
}
