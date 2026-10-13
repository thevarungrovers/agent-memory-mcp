/**
 * The backlog walk must terminate and must leave nothing behind.
 *
 * This is the property the first version of the sweep got wrong: ordered by most
 * recently updated, it re-picked the same rows on every visit, so anything below the
 * per-run cap was unreachable no matter how many times it ran.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const root = join(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "agent-memory-backfill-"));
const home = mkdtempSync(join(tmpdir(), "curator-home-bf-"));
process.env.AGENT_MEMORY_DIR = dataDir;

mkdirSync(join(home, "state"), { recursive: true });
writeFileSync(join(home, "PROMPT.md"), "packet: {{PACKET_PATH}}\ndecisions: {{DECISIONS_PATH}}\n");
writeFileSync(join(home, "canaries.json"), "[]");

const db = await import("../src/db.js");

let failed = 0;
const ok = (label: string, cond: boolean): void => {
  process.stdout.write(`  ${cond ? "ok " : "FAIL"} ${label}\n`);
  if (!cond) failed++;
};

const body = (i: number, w: string): string =>
  `${w} ${i}: ` + "a realistically sized body so the prose invariant has something to compare. ".repeat(3);

const mk = (over: Record<string, unknown> = {}): string => {
  const id = randomUUID();
  db.insertMemory({
    id, title: `memory ${id.slice(0, 6)}`, type: "gotcha", project: null, area: "filler",
    trigger_context: "ctx", symptom: body(1, "symptom"), root_cause: null, fix: body(1, "fix"),
    code_example: null, tags: "t", severity: "major", ...over,
  } as Parameters<typeof db.insertMemory>[0]);
  return id;
};

const TOTAL = 47;
for (let i = 0; i < TOTAL; i++) mk({ symptom: body(i, "symptom"), fix: body(i, "fix") });

// A byte-identical pair, so an archive would verify perfectly. It still must not be
// applied by a bulk pass.
const original = mk({ title: "DUPLICATE SOURCE", symptom: body(999, "symptom"), fix: body(999, "fix") });
const dupe = mk({ title: "DUPLICATE SOURCE", symptom: body(999, "symptom"), fix: body(999, "fix") });

const stub = join(home, "stub-claude");
writeFileSync(stub, `#!/usr/bin/env node
const fs = require("node:fs");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const packet = JSON.parse(fs.readFileSync(/packet: (\\S+)/.exec(prompt)[1], "utf8"));
const decisions = packet.clusters.map((c) => {
  if (c.candidate.title === "DUPLICATE SOURCE" && c.neighbours.length) {
    const twin = c.neighbours.find((n) => n.title === "DUPLICATE SOURCE");
    if (twin) return { memory_id: c.candidate.id, verdict: "ARCHIVE", reason: "duplicate_of", cites: twin.id, rationale: "identical" };
  }
  return { memory_id: c.candidate.id, verdict: "KEEP", rationale: "fine" };
});
fs.writeFileSync(/decisions: (\\S+)/.exec(prompt)[1], JSON.stringify({ decisions }));
`);
chmodSync(stub, 0o755);

const cli = join(root, "dist", "cli.js");
const run = (args: string[]): string => {
  try {
    return execFileSync(process.execPath, [cli, "backfill", "--home", home, "--claude-bin", stub, ...args], {
      env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8",
    });
  } catch (e) {
    return `${(e as { stdout?: string }).stdout ?? ""}${(e as { stderr?: string }).stderr ?? ""}`;
  }
};

const conn = () => new Database(join(dataDir, "memory.db"), { readonly: true });
const uncurated = (): number => {
  const c = conn();
  const n = (c.prepare("SELECT COUNT(*) n FROM memories WHERE curated_at IS NULL AND archived_at IS NULL").get() as { n: number }).n;
  c.close();
  return n;
};

process.stdout.write(`\nstart: ${uncurated()} uncurated of ${TOTAL + 2}\n`);
ok("every seeded entry starts uncurated", uncurated() === TOTAL + 2);

process.stdout.write("\nresume after an interruption\n");
run(["--batch", "10", "--max-batches", "2"]);
const afterPartial = uncurated();
ok(`a partial run curates only what it processed (${afterPartial} left)`, afterPartial === TOTAL + 2 - 20);

process.stdout.write("\ncompleting the walk\n");
const out = run(["--batch", "10"]);
process.stdout.write(out.split("\n").filter((l) => l.includes("[backfill]")).map((l) => `    ${l}`).join("\n") + "\n");

ok("nothing is left uncurated", uncurated() === 0);

const c = conn();
const archived = (c.prepare("SELECT COUNT(*) n FROM memories WHERE archived_at IS NOT NULL").get() as { n: number }).n;
const proposedArchives = (c.prepare("SELECT COUNT(*) n FROM curation_actions WHERE verdict='ARCHIVE' AND tier='proposed'").get() as { n: number }).n;
const appliedArchives = (c.prepare("SELECT COUNT(*) n FROM curation_actions WHERE verdict='ARCHIVE' AND tier='applied'").get() as { n: number }).n;
c.close();

ok("a perfectly verifiable duplicate is still NOT archived by a bulk pass", archived === 0);
ok("...it is recorded as a proposal instead", proposedArchives >= 1);
ok("...and no archive was applied at all", appliedArchives === 0);
ok("re-running when everything is curated is a no-op", run([]).includes("nothing to backfill"));

rmSync(dataDir, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
process.stdout.write(`\n${failed === 0 ? "all" : `${failed} FAILED —`} backfill checks\n`);
process.exit(failed ? 1 : 0);
