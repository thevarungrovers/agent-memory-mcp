import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchMemories } from "../db.js";
import type { MemoryEntry } from "../types.js";

function formatEntry(entry: MemoryEntry): string {
  const parts = [
    `### [${entry.id}] ${entry.title}`,
    `- **Type**: ${entry.type} | **Area**: ${entry.area} | **Severity**: ${entry.severity}`,
  ];
  if (entry.project) parts.push(`- **Project**: ${entry.project}`);
  if (entry.trigger_context) parts.push(`- **Trigger**: ${entry.trigger_context}`);
  parts.push(`- **Symptom**: ${entry.symptom}`);
  if (entry.root_cause) parts.push(`- **Root cause**: ${entry.root_cause}`);
  parts.push(`- **Fix**: ${entry.fix}`);
  if (entry.code_example) parts.push(`- **Code**:\n\`\`\`\n${entry.code_example}\n\`\`\``);
  if (entry.tags) parts.push(`- **Tags**: ${entry.tags}`);
  return parts.join("\n");
}

export function registerSearchMemory(server: McpServer): void {
  server.registerTool("search_memory", {
    description:
      "Search the memory database for relevant bugs, patterns, and learnings. " +
      "Use BEFORE starting work to check if the problem has been seen before. " +
      "Also use when you encounter an error to check if a fix is already known.",
    inputSchema: {
      query: z.string().describe("Free-text search query (error message, keyword, description)"),
      area: z.string().optional().describe("Filter by tech area: php, vue, mysql, docker, etc."),
      project: z.string().optional().describe("Filter by project name"),
      type: z.enum(["bug", "pattern", "gotcha", "solution", "learning"]).optional().describe("Filter by memory type"),
      tags: z.string().optional().describe("Filter by tags (comma-separated, matches ANY)"),
      limit: z.number().optional().describe("Max results to return (default 10)"),
    },
  }, async (args) => {
    const results = searchMemories(args.query, {
      area: args.area,
      project: args.project,
      type: args.type,
      tags: args.tags,
      limit: args.limit,
    });

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: "No matching memories found." }],
      };
    }

    const formatted = results.map(formatEntry).join("\n\n---\n\n");
    return {
      content: [{
        type: "text",
        text: `Found ${results.length} matching memories:\n\n${formatted}`,
      }],
    };
  });
}
