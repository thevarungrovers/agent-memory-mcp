import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDb } from "./db.js";
import { registerStoreMemory } from "./tools/storeMemory.js";
import { registerSearchMemory } from "./tools/searchMemory.js";
import { registerGetContext } from "./tools/getContext.js";
import { registerListMemories } from "./tools/listMemories.js";
import { registerUpdateMemory } from "./tools/updateMemory.js";
import { registerDeleteMemory } from "./tools/deleteMemory.js";
import { registerGetMemory } from "./tools/getMemory.js";
import { registerArchiveMemory } from "./tools/archiveMemory.js";
import { registerRestoreMemory } from "./tools/restoreMemory.js";
import { registerFindSimilar } from "./tools/findSimilar.js";
import { registerRelateMemories } from "./tools/relateMemories.js";
import { registerStoreSessionLog } from "./tools/storeSessionLog.js";
import { registerSearchSessionLog } from "./tools/searchSessionLog.js";
import { registerStoreRule } from "./tools/storeRule.js";
import { registerListRules } from "./tools/listRules.js";
import { registerUpdateRule } from "./tools/updateRule.js";
import { registerDeleteRule } from "./tools/deleteRule.js";

const server = new McpServer(
  { name: "agent-memory", version: "1.0.0" },
  {
    instructions:
      "This server provides persistent memory for coding agents. " +
      "Use get_context at the start of tasks to load relevant known issues. " +
      "Use search_memory when you encounter an error to check for known fixes. " +
      "get_context and search_memory return SHORT PROJECTIONS — id, title and the opening of the " +
      "symptom — so they stay inside the tool-output budget; call get_memory with an id when you need " +
      "the full entry. " +
      "Use store_memory after fixing a bug or discovering a pitfall to prevent recurrence. " +
      "Separately, use store_session_log once at the end of every session to record what was worked on, " +
      "and search_session_log to answer questions about when past work happened. " +
      "Rules are a third, distinct concern: store_rule records a standing instruction the user wants obeyed " +
      "in every future session (\"always X\", \"never Y\", \"prefer A over B\"). Call it the moment the user states one. " +
      "Active rules are returned by get_context and injected at session start, so you do not need to ask for them. " +
      "Housekeeping: prefer archive_memory over delete_memory — archiving is reversible and keeps the " +
      "entry readable by id. When one memory corrects or replaces another, record it with " +
      "relate_memories instead of writing 'CORRECTION to ...' into the prose, so the relationship is " +
      "queryable and both entries stop competing in search results. find_similar surfaces overlapping " +
      "entries before you add a near-duplicate. " +
      "All of this data lives in one SQLite database that only this server should write to: " +
      "read and change it through these tools, never with sqlite3 or a direct connection.",
  }
);

getDb();

registerStoreMemory(server);
registerSearchMemory(server);
registerGetContext(server);
registerListMemories(server);
registerGetMemory(server);
registerUpdateMemory(server);
registerDeleteMemory(server);
registerArchiveMemory(server);
registerRestoreMemory(server);
registerFindSimilar(server);
registerRelateMemories(server);
registerStoreSessionLog(server);
registerSearchSessionLog(server);
registerStoreRule(server);
registerListRules(server);
registerUpdateRule(server);
registerDeleteRule(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
