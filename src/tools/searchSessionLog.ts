import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchSessionLog as searchSessionLogDb } from "../db.js";
import type { SessionLogEntry } from "../types.js";

/**
 * Rows arrive ordered by work_date DESC, so grouping into a Map preserves that
 * order and each date is emitted once with its sessions underneath.
 */
function formatGroupedByDate(entries: SessionLogEntry[]): string {
  const groups = new Map<string, SessionLogEntry[]>();
  for (const entry of entries) {
    const existing = groups.get(entry.work_date);
    if (existing) {
      existing.push(entry);
    } else {
      groups.set(entry.work_date, [entry]);
    }
  }

  return Array.from(groups.entries())
    .map(([date, sessions]) => {
      const heading = `### ${date} — ${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
      const lines = sessions.map((session) => {
        const project = session.project ? ` **[${session.project}]**` : "";
        const tags = session.tags ? `\n  - *Tags*: ${session.tags}` : "";
        return `-${project} ${session.summary}${tags}`;
      });
      return `${heading}\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

export function registerSearchSessionLog(server: McpServer): void {
  server.registerTool("search_session_log", {
    description:
      "Search the daily work log to answer questions like \"when did I work on X?\" or \"what did I do last week?\". " +
      "Results are grouped by date, newest first. " +
      "Pass a keyword to find when something was worked on, a date range to see a period, or both. " +
      "Omit the keyword entirely to list every session in a date range.",
    inputSchema: {
      query: z.string().optional().describe("Free-text keyword to match against summary, project, and tags. Omit to list everything in the date range"),
      from: z.string().optional().describe("Earliest local date to include, 'YYYY-MM-DD' (inclusive)"),
      to: z.string().optional().describe("Latest local date to include, 'YYYY-MM-DD' (inclusive)"),
      project: z.string().optional().describe("Filter by project or repo name"),
      limit: z.number().optional().describe("Max sessions to return (default 20)"),
    },
  }, async (args) => {
    const results = searchSessionLogDb(args.query ?? null, {
      from: args.from,
      to: args.to,
      project: args.project,
      limit: args.limit,
    });

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: "No matching sessions found in the work log." }],
      };
    }

    const dayCount = new Set(results.map((entry) => entry.work_date)).size;
    return {
      content: [{
        type: "text",
        text: `Found ${results.length} session${results.length === 1 ? "" : "s"} across ${dayCount} day${dayCount === 1 ? "" : "s"}:\n\n${formatGroupedByDate(results)}`,
      }],
    };
  });
}
