import { z } from "zod";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { insertSessionLog } from "../db.js";

export function registerStoreSessionLog(server: McpServer): void {
  server.registerTool("store_session_log", {
    description:
      "Append what this session worked on to the daily work log. " +
      "Call this ONCE at the end of every session, alongside store_memory. " +
      "This is a separate concern from store_memory: store_memory keeps reusable fixes and gotchas, " +
      "while this keeps a chronological record of what was worked on so it can be recalled by date later. " +
      "Log the session even when nothing reusable was learned and there is no memory to store.",
    inputSchema: {
      summary: z.string().describe("What was worked on, in 1-3 sentences. Name the feature, bug, ticket, or files so a keyword search finds it months later"),
      project: z.string().optional().describe("Project or repo name (omit for cross-project work)"),
      work_date: z.string().optional().describe("Local calendar day as 'YYYY-MM-DD'. Defaults to today; pass it only to backfill an earlier day"),
      tags: z.string().optional().describe("Comma-separated tags for search (e.g. 'migration,orders,yii2')"),
    },
  }, async (args) => {
    const entry = insertSessionLog({
      id: randomUUID(),
      work_date: args.work_date ?? null,
      project: args.project ?? null,
      summary: args.summary,
      tags: args.tags ?? null,
    });

    return {
      content: [{
        type: "text",
        text: `Session logged.\n\nID: ${entry.id}\nDate: ${entry.work_date}\nProject: ${entry.project ?? "(none)"}`,
      }],
    };
  });
}
