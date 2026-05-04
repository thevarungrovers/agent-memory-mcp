import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { updateMemory as updateMemoryDb } from "../db.js";

export function registerUpdateMemory(server: McpServer): void {
  server.registerTool("update_memory", {
    description:
      "Update an existing memory entry with new or corrected information. " +
      "Use when you discover additional context about a known issue or need to refine a fix.",
    inputSchema: {
      id: z.string().describe("The memory ID to update"),
      title: z.string().optional().describe("Updated title"),
      type: z.enum(["bug", "pattern", "gotcha", "solution", "learning"]).optional().describe("Updated type"),
      project: z.string().optional().describe("Updated project"),
      area: z.string().optional().describe("Updated tech area"),
      trigger_context: z.string().optional().describe("Updated trigger context"),
      symptom: z.string().optional().describe("Updated symptom description"),
      root_cause: z.string().optional().describe("Updated root cause"),
      fix: z.string().optional().describe("Updated fix"),
      code_example: z.string().optional().describe("Updated code example"),
      tags: z.string().optional().describe("Updated tags"),
      severity: z.enum(["critical", "major", "minor", "info"]).optional().describe("Updated severity"),
    },
  }, async (args) => {
    const { id, ...updates } = args;
    const filteredUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, v]) => v !== undefined)
    );

    const result = updateMemoryDb(id, filteredUpdates);

    if (!result) {
      return {
        content: [{ type: "text", text: `No memory found with ID: ${id}` }],
      };
    }

    return {
      content: [{
        type: "text",
        text: `Memory updated successfully.\n\nID: ${result.id}\nTitle: ${result.title}\nUpdated at: ${result.updated_at}`,
      }],
    };
  });
}
