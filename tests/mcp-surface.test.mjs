/**
 * Spawns the built server and does a real stdio handshake.
 *
 * This is the only check that catches a tool which was written but never wired into
 * index.ts: typecheck passes, the file exists, and the tool simply is not there.
 * Runs against a throwaway AGENT_MEMORY_DIR.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agent-memory-mcp-"));
const server = join(import.meta.dirname, "..", "dist", "index.js");

const proc = spawn(process.execPath, [server], {
  env: { ...process.env, AGENT_MEMORY_DIR: dir },
  stdio: ["pipe", "pipe", "pipe"],
});

const send = (msg) => proc.stdin.write(`${JSON.stringify(msg)}\n`);
let buffer = "";
const pending = new Map();

proc.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) > -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

const rpc = (method, params, id) =>
  new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

const init = await rpc("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "surface-test", version: "0" },
}, 1);
send({ jsonrpc: "2.0", method: "notifications/initialized" });

const listed = await rpc("tools/list", {}, 2);
const names = listed.result.tools.map((t) => t.name).sort();

const expected = [
  "archive_memory", "delete_memory", "delete_rule", "find_similar", "get_context",
  "get_memory", "list_memories", "list_rules", "relate_memories", "restore_memory",
  "search_memory", "search_session_log", "store_memory", "store_rule",
  "store_session_log", "update_memory", "update_rule",
].sort();

const missing = expected.filter((n) => !names.includes(n));
const extra = names.filter((n) => !expected.includes(n));

// A real call, so the test proves the tools work and not merely that they are listed.
const stored = await rpc("tools/call", {
  name: "store_memory",
  arguments: {
    title: "surface test", type: "gotcha", area: "testing",
    symptom: "a very specific error string: ENOTEMPTY", fix: "do the thing",
  },
}, 3);
const id = /ID: (\S+)/.exec(stored.result.content[0].text)?.[1];
const search = await rpc("tools/call", { name: "search_memory", arguments: { query: "ENOTEMPTY" } }, 4);
const full = await rpc("tools/call", { name: "get_memory", arguments: { id } }, 5);

proc.kill();
rmSync(dir, { recursive: true, force: true });

const searchText = search.result.content[0].text;
const fullText = full.result.content[0].text;

const checks = [
  [`server identifies itself (${init.result.serverInfo.name})`, init.result.serverInfo.name === "agent-memory"],
  [`advertises all ${expected.length} tools`, missing.length === 0],
  ["advertises nothing unexpected", extra.length === 0],
  ["store_memory returns an id", !!id],
  ["search_memory finds the exact error string", searchText.includes(id)],
  ["search_memory returns a projection, not the body", !searchText.includes("**Fix**")],
  ["get_memory returns the full body", fullText.includes("**Fix**") && fullText.includes("do the thing")],
];

let failed = 0;
for (const [label, pass] of checks) {
  process.stdout.write(`  ${pass ? "ok " : "FAIL"} ${label}\n`);
  if (!pass) failed++;
}
if (missing.length) process.stdout.write(`       missing: ${missing.join(", ")}\n`);
if (extra.length) process.stdout.write(`       extra: ${extra.join(", ")}\n`);
process.stdout.write(`\n${checks.length - failed}/${checks.length} surface checks passed\n`);
process.exit(failed ? 1 : 0);
