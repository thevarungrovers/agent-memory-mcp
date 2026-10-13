import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { archiveMemory, getMemoryById } from "../db.js";

/**
 * A soft delete, and the only removal the curator is allowed. The row stops appearing
 * in every search path but stays readable by id and restorable by restore_memory.
 *
 * Reasons are an enum rather than free text because a free-text reason always
 * "succeeds" — "stale" will absorb anything asked of it. The two reasons that can be
 * machine-checked (duplicate_of, superseded_by) are the only ones a scheduled run may
 * act on unattended; the other two exist so a human can record a judgement call.
 */
export function registerArchiveMemory(server: McpServer): void {
  server.registerTool("archive_memory", {
    description:
      "Archive a memory: hide it from search_memory, get_context and list_memories while keeping it " +
      "readable by id and restorable. Prefer this over delete_memory — archiving is reversible. " +
      "Cite the memory that replaces this one in superseded_by whenever there is one.",
    inputSchema: {
      id: z.string().describe("The memory ID to archive"),
      reason: z
        .enum(["duplicate_of", "superseded_by", "stale", "no_longer_relevant"])
        .describe("Why it is being archived. duplicate_of and superseded_by require the cited id in superseded_by"),
      superseded_by: z
        .string()
        .optional()
        .describe("The id of the memory that replaces this one. Required for duplicate_of and superseded_by"),
    },
  }, async (args) => {
    if ((args.reason === "duplicate_of" || args.reason === "superseded_by") && !args.superseded_by) {
      return {
        content: [{ type: "text", text: `Reason '${args.reason}' requires superseded_by to name the memory that replaces this one.` }],
      };
    }
    if (args.superseded_by && !getMemoryById(args.superseded_by)) {
      return { content: [{ type: "text", text: `No memory found with id ${args.superseded_by}, so it cannot supersede anything.` }] };
    }

    const existing = getMemoryById(args.id);
    if (!existing) return { content: [{ type: "text", text: `No memory found with id ${args.id}.` }] };
    if (existing.archived_at) {
      return { content: [{ type: "text", text: `Memory ${args.id} was already archived at ${existing.archived_at}.` }] };
    }

    const result = archiveMemory(args.id, args.reason, args.superseded_by ?? null);
    if (!result) return { content: [{ type: "text", text: `Could not archive ${args.id}.` }] };

    const by = result.superseded_by ? `\nSuperseded by: ${result.superseded_by}` : "";
    return {
      content: [{
        type: "text",
        text: `Archived ${result.id} (${result.archive_reason}).\nTitle: ${result.title}${by}\nRestore with restore_memory.`,
      }],
    };
  });
}
