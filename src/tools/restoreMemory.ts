import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getMemoryById, restoreMemory } from "../db.js";

export function registerRestoreMemory(server: McpServer): void {
  server.registerTool("restore_memory", {
    description:
      "Bring an archived memory back into the active set. Use when a curation pass archived " +
      "something that turned out to still matter.",
    inputSchema: {
      id: z.string().describe("The memory ID to restore"),
    },
  }, async (args) => {
    const existing = getMemoryById(args.id);
    if (!existing) return { content: [{ type: "text", text: `No memory found with id ${args.id}.` }] };
    if (!existing.archived_at) return { content: [{ type: "text", text: `Memory ${args.id} is not archived.` }] };

    const result = restoreMemory(args.id);
    return {
      content: [{ type: "text", text: `Restored ${result!.id}.\nTitle: ${result!.title}` }],
    };
  });
}
