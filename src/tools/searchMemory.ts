import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchMemories } from "../db.js";
import type { MemoryEntry } from "../types.js";

const SNIPPET = 200;

/**
 * A projection, not the entry.
 *
 * This used to render every field of every hit, code_example included. At a ~4.5KB
 * mean body, a 28-hit query came to 130KB and blew the tool-output cap — no memories
 * reached the model at all, and the spill-to-file cost more than the task that
 * prompted the search. Retrieval is two steps now: find cheaply here, then call
 * get_memory on the one id that matters. ~300 bytes a row instead of ~4,500.
 */
function formatProjection(entry: MemoryEntry): string {
  const project = entry.project ? ` [${entry.project}]` : "";
  const body = entry.symptom.replace(/\s+/g, " ").trim();
  const snippet = body.length > SNIPPET ? `${body.slice(0, SNIPPET)}…` : body;
  return `- **${entry.id}** (${entry.type}/${entry.severity}) ${entry.title}${project} — ${entry.area}\n  ${snippet}`;
}

export function registerSearchMemory(server: McpServer): void {
  server.registerTool("search_memory", {
    description:
      "Search the memory database for relevant bugs, patterns, and learnings. " +
      "Use BEFORE starting work to check if the problem has been seen before. " +
      "Also use when you encounter an error to check if a fix is already known. " +
      "Returns a short projection of each hit (id, title, and the opening of the symptom); " +
      "call get_memory with an id for the full entry.",
    inputSchema: {
      query: z.string().describe("Free-text search query (error message, keyword, description)"),
      area: z.string().optional().describe("Filter by tech area: php, vue, mysql, docker, etc."),
      project: z.string().optional().describe("Filter by project name"),
      type: z.enum(["bug", "pattern", "gotcha", "solution", "learning"]).optional().describe("Filter by memory type"),
      tags: z.string().optional().describe("Filter by tags (comma-separated, matches ANY)"),
      limit: z.number().optional().describe("Max results to return (default 10)"),
      include_archived: z.boolean().optional().describe("Also return memories the curator has archived (default false)"),
    },
  }, async (args) => {
    const results = searchMemories(args.query, {
      area: args.area,
      project: args.project,
      type: args.type,
      tags: args.tags,
      limit: args.limit,
      include_archived: args.include_archived,
    });

    if (results.length === 0) {
      return { content: [{ type: "text", text: "No matching memories found." }] };
    }

    const formatted = results.map(formatProjection).join("\n");
    return {
      content: [{
        type: "text",
        text: `Found ${results.length} matching memories (call get_memory <id> for the full entry):\n\n${formatted}`,
      }],
    };
  });
}
