import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addRelation, getMemoryById, getRelations } from "../db.js";

/**
 * Records that one memory supersedes, corrects, contradicts, duplicates or refines
 * another — the convention agents have been expressing in prose ("CORRECTION to
 * [[...]]"), where nothing can act on it and both entries keep answering queries.
 *
 * A corrects/contradicts edge also makes the target archive-immune, enforced by a
 * trigger: a correction read without the belief it corrects loses the reason the
 * wrong belief was plausible, which is usually the useful half.
 */
export function registerRelateMemories(server: McpServer): void {
  server.registerTool("relate_memories", {
    description:
      "Link two memories: 'supersedes', 'corrects', 'contradicts', 'duplicate_of' or 'refines'. " +
      "Use instead of writing 'CORRECTION to ...' into the prose, so the relationship is queryable. " +
      "Call with only from_id to list what a memory is already linked to.",
    inputSchema: {
      from_id: z.string().describe("The newer or correcting memory"),
      to_id: z.string().optional().describe("The older/corrected memory. Omit to just list existing relations"),
      kind: z
        .enum(["supersedes", "corrects", "contradicts", "duplicate_of", "refines"])
        .optional()
        .describe("How from_id relates to to_id"),
      note: z.string().optional().describe("One line on what changed, for a human reading the pair later"),
    },
  }, async (args) => {
    const from = getMemoryById(args.from_id);
    if (!from) return { content: [{ type: "text", text: `No memory found with id ${args.from_id}.` }] };

    if (!args.to_id) {
      const existing = getRelations(args.from_id);
      if (existing.length === 0) return { content: [{ type: "text", text: `${args.from_id} has no relations.` }] };
      const lines = existing.map((r) => `- ${r.from_id} ${r.kind} ${r.to_id}${r.note ? ` — ${r.note}` : ""}`);
      return { content: [{ type: "text", text: `${existing.length} relations:\n${lines.join("\n")}` }] };
    }

    if (!args.kind) return { content: [{ type: "text", text: "kind is required when to_id is given." }] };
    if (args.to_id === args.from_id) return { content: [{ type: "text", text: "A memory cannot relate to itself." }] };
    if (!getMemoryById(args.to_id)) return { content: [{ type: "text", text: `No memory found with id ${args.to_id}.` }] };

    const relation = addRelation(args.from_id, args.to_id, args.kind, args.note ?? null);
    if (!relation) {
      return { content: [{ type: "text", text: `${args.from_id} ${args.kind} ${args.to_id} was already recorded.` }] };
    }

    const immune = args.kind === "corrects" || args.kind === "contradicts"
      ? `\n${args.to_id} is now archive-immune: the pair is the content.`
      : "";
    return {
      content: [{ type: "text", text: `Recorded: ${args.from_id} ${args.kind} ${args.to_id}.${immune}` }],
    };
  });
}
