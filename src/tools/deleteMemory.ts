import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deleteMemory as deleteMemoryDb } from "../db.js";

export function registerDeleteMemory(server: McpServer): void {
  server.registerTool("delete_memory", {
    description:
      "Delete a memory entry that is no longer relevant or was created in error. " +
      "Use when a previously stored memory is outdated or incorrect.",
    inputSchema: {
      id: z.string().describe("The memory ID to delete"),
    },
  }, async (args) => {
    const deleted = deleteMemoryDb(args.id);

    if (!deleted) {
      return {
        content: [{ type: "text", text: `No memory found with ID: ${args.id}` }],
      };
    }

    return {
      content: [{ type: "text", text: `Memory ${args.id} deleted successfully.` }],
    };
  });
}
