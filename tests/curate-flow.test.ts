/**
 * End-to-end curation pass with a stubbed model.
 *
 * The stub stands in for `claude -p`: it reads the packet and writes a decisions file,
 * exactly as the real one is asked to. That exercises every part of the pipeline that
 * can be wrong without spending tokens to find out — packet construction, the handoff
 * through files, predicate verification, budgets, the ledger, invariants and the report.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const root = join(import.meta.dirname, "..");
const dataDir = mkdtempSync(join(tmpdir(), "agent-memory-flow-"));
const home = mkdtempSync(join(tmpdir(), "curator-home-"));
process.env.AGENT_MEMORY_DIR = dataDir;

mkdirSync(join(home, "state"), { recursive: true });
writeFileSync(join(home, "PROMPT.md"), "packet: {{PACKET_PATH}}\ndecisions: {{DECISIONS_PATH}}\n");
writeFileSync(join(home, "canaries.json"), JSON.stringify([
  { name: "git-repo", query: "fatal not a git repository" },
]));

const db = await import("../src/db.js");

let failed = 0;
const ok = (label: string, cond: boolean): void => {
  process.stdout.write(`  ${cond ? "ok " : "FAIL"} ${label}\n`);
  if (!cond) failed++;
};

// --- Seed a corpus with the two shapes that matter: a true duplicate pair, and a
// pair that merely looks similar but encodes different situations.
const mk = (over: Record<string, unknown>): string => {
  const id = randomUUID();
  db.insertMemory({
    id, title: "t", type: "gotcha", project: null, area: "git",
    trigger_context: "ctx", symptom: "s", root_cause: null, fix: "f",
    code_example: null, tags: "git", severity: "major", ...over,
  } as Parameters<typeof db.insertMemory>[0]);
  return id;
};

const original = mk({
  title: "gh resolves this checkout to the wrong repo — pass --repo on every call",
  symptom: "gh pr list silently targets legacy-app instead of legacy-app-v2",
  fix: "Always pass --repo owner/name. A stale remote.upstream.gh-resolved=base is why.",
  tags: "gh,repo,git",
});
const trueDuplicate = mk({
  title: "gh resolves this checkout to the wrong repo — pass --repo on every call",
  symptom: "gh pr list silently targets legacy-app instead of legacy-app-v2",
  fix: "Always pass --repo owner/name. A stale remote.upstream.gh-resolved=base is why.",
  tags: "gh,repo,git",
});
const looksSimilar = mk({
  title: "gh resolves WORKTREES to the wrong repo — pass --repo there too",
  symptom: "Inside a git worktree, gh pr create targets the parent checkout's repo",
  fix: "A worktree has no remote of its own; gh walks up. Pass --repo explicitly.",
  tags: "gh,repo,worktree",
});
// Filler, so the corpus is a realistic size. The erosion guard compares percentages,
// and on a four-row store a single correct archive reads as a 25% collapse.
const filler = (i: number, what: string): string =>
  `${what} ${i}: ` + "a realistically sized body, because the prose invariant compares totals "
  + "and tiny filler rows would let one real memory dominate the corpus. ".repeat(3);
for (let i = 0; i < 25; i++) {
  mk({
    title: `unrelated memory ${i}`,
    area: "filler",
    symptom: filler(i, "symptom"),
    root_cause: filler(i, "cause"),
    fix: filler(i, "fix"),
  });
}

const keeper = mk({
  title: "fatal: not a git repository",
  symptom: "fatal: not a git repository (or any of the parent directories): .git",
  fix: "cd into the checkout first",
  tags: "git",
});

// --- The stub model. Writes decisions covering every verdict path, including two it
// should not be allowed to carry out.
const stub = join(home, "fake-claude");
writeFileSync(stub, `#!/usr/bin/env node
const fs = require("node:fs");
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const packetPath = /packet: (\\S+)/.exec(prompt)[1];
const decisionsPath = /decisions: (\\S+)/.exec(prompt)[1];
const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
if (!packet.clusters.length) { console.error("empty packet"); process.exit(1); }
const decisions = ${JSON.stringify("PLACEHOLDER")};
fs.writeFileSync(decisionsPath, JSON.stringify({ decisions: JSON.parse(decisions) }, null, 2));
`);

const decisions = [
  { memory_id: trueDuplicate, verdict: "ARCHIVE", reason: "duplicate_of", cites: original, rationale: "byte-identical to the original" },
  { memory_id: looksSimilar, verdict: "ARCHIVE", reason: "duplicate_of", cites: original, rationale: "looks the same to me" },
  { memory_id: keeper, verdict: "ARCHIVE", reason: "stale", cites: null, rationale: "feels old" },
  { memory_id: original, verdict: "RETAG", tags: "gh,repo,git,gh-resolved", rationale: "add the config key people search for" },
];
writeFileSync(stub, readFileSync(stub, "utf8").replace('"PLACEHOLDER"', JSON.stringify(JSON.stringify(decisions))));
chmodSync(stub, 0o755);

process.stdout.write("\ncuration pass\n");
const cli = join(root, "dist", "cli.js");
let out = "";
try {
  out = execFileSync(process.execPath, [cli, "curate", "--home", home, "--claude-bin", stub], {
    env: { ...process.env, AGENT_MEMORY_DIR: dataDir },
    encoding: "utf8",
  });
} catch (e) {
  out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
}
process.stdout.write(out.split("\n").map((l) => `    ${l}`).join("\n"));

// --- Reload: the CLI ran in its own process, so re-read through a fresh connection.
const check = Database;
const conn = new check(join(dataDir, "memory.db"), { readonly: true });
const row = (id: string): any => conn.prepare("SELECT * FROM memories WHERE id = ?").get(id);
const actions = conn.prepare("SELECT * FROM curation_actions ORDER BY created_at").all();

process.stdout.write("\nverification\n");
ok("the true duplicate was archived", row(trueDuplicate).archived_at !== null);
ok("it records what replaced it", row(trueDuplicate).superseded_by === original);
ok(
  "the look-alike with a different trigger was NOT archived",
  row(looksSimilar).archived_at === null
);
ok(
  "...it became a proposal instead",
  actions.some((a) => a.memory_id === looksSimilar && a.tier === "proposed")
);
ok("an unverifiable 'stale' reason was not acted on", row(keeper).archived_at === null);
ok(
  "...it too became a proposal",
  actions.some((a) => a.memory_id === keeper && a.tier === "proposed" && a.reason === "stale")
);
ok("the retag landed", row(original).tags.includes("gh-resolved"));
ok("the retag kept every original tag", ["gh", "repo", "git"].every((t) => row(original).tags.includes(t)));
ok("a curator edit did not bump updated_at", row(original).updated_at === row(original).created_at);
ok("the ledger recorded every decision", actions.length === 4);
ok("a relation was recorded for the archive",
  conn.prepare("SELECT COUNT(*) n FROM memory_relations WHERE to_id = ?").get(trueDuplicate).n === 1);
ok("revisions captured the change", conn.prepare("SELECT COUNT(*) n FROM memory_revisions").get().n > 0);

const run = conn.prepare("SELECT * FROM curation_runs ORDER BY started_at DESC LIMIT 1").get();
ok("the run closed ok", run.status === "ok");
ok("the watermark advanced", conn.prepare("SELECT value FROM curation_state WHERE key='last_success_date'").get() !== undefined);

const reportPath = join(home, "reports");
const reports = existsSync(reportPath) ? readFileSync(join(reportPath, `${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10)}-nightly.md`), "utf8") : "";
ok("a report was written", reports.length > 0);
ok("the report names the proposals", reports.includes("Proposals"));
// The report's reason to exist once the curator applies its own decisions: a section
// that says what it did to the corpus, in terms of the effect and not just the verdict.
ok("the report has a 'what changed' section", reports.includes("## What changed"));
ok("...naming the concrete effect, not just the verdict", reports.includes("archived in favour of"));
ok("...and the retag's new tag list", reports.includes("tags -> gh,repo,git,gh-resolved"));
ok(
  "a KEEP is not counted as a change",
  reports.includes("2 changed, 1 archived") && !/^- \*\*KEEP\*\*/m.test(
    reports.slice(reports.indexOf("## What changed"), reports.indexOf("## Proposals"))
  )
);
ok("the report carries an undo command", reports.includes("agent-memory undo --run"));
ok("report counts come from the ledger, not the model", reports.includes("1 archived"));

process.stdout.write("\nundo\n");
conn.close();
const undoOut = execFileSync(process.execPath, [cli, "undo", "--run", run.id], {
  env: { ...process.env, AGENT_MEMORY_DIR: dataDir }, encoding: "utf8",
});
const conn2 = new check(join(dataDir, "memory.db"), { readonly: true });
ok("undo restored the archived duplicate", conn2.prepare("SELECT archived_at FROM memories WHERE id = ?").get(trueDuplicate).archived_at === null);
ok("undo reverted the retag", !conn2.prepare("SELECT tags FROM memories WHERE id = ?").get(original).tags.includes("gh-resolved"));
conn2.close();
process.stdout.write(undoOut.split("\n").map((l) => `    ${l}`).join("\n"));

rmSync(dataDir, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
process.stdout.write(`\n${failed === 0 ? "all" : `${failed} FAILED —`} flow checks\n`);
process.exit(failed ? 1 : 0);
