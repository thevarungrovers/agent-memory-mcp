import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getDb } from "./db.js";
import { registerStoreMemory } from "./tools/storeMemory.js";
import { registerSearchMemory } from "./tools/searchMemory.js";
import { registerGetContext } from "./tools/getContext.js";
import { registerListMemories } from "./tools/listMemories.js";
import { registerUpdateMemory } from "./tools/updateMemory.js";
import { registerDeleteMemory } from "./tools/deleteMemory.js";
import { registerStoreSessionLog } from "./tools/storeSessionLog.js";
import { registerSearchSessionLog } from "./tools/searchSessionLog.js";

const server = new McpServer(
  { name: "agent-memory", version: "1.0.0" },
  {
    instructions:
      "This server provides persistent memory for coding agents. " +
      "Use get_context at the start of tasks to load relevant known issues. " +
      "Use search_memory when you encounter an error to check for known fixes. " +
      "Use store_memory after fixing a bug or discovering a pitfall to prevent recurrence. " +
      "Separately, use store_session_log once at the end of every session to record what was worked on, " +
      "and search_session_log to answer questions about when past work happened.",
  }
);

getDb();

registerStoreMemory(server);
registerSearchMemory(server);
registerGetContext(server);
registerListMemories(server);
registerUpdateMemory(server);
registerDeleteMemory(server);
registerStoreSessionLog(server);
registerSearchSessionLog(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`Fatal error: ${error}\n`);
  process.exit(1);
});
