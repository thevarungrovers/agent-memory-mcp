/**
 * Schema + guard-trigger tests for the curation layer.
 *
 * Runs against a throwaway AGENT_MEMORY_DIR, never the live store. There is no test
 * runner in this repo by design; this is a plain script that throws on the first
 * failure. `npm run test:curation`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "agent-memory-test-"));
process.env.AGENT_MEMORY_DIR = dir;

const db = await import("../src/db.js");

let passed = 0;
function ok(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  process.stdout.write(`  ok  ${label}\n`);
}
function throws(label: string, fn: () => unknown, match: RegExp): void {
  try {
    fn();
  } catch (error) {
    if (!match.test(String(error))) throw new Error(`FAIL: ${label} — wrong error: ${error}`);
    passed++;
    process.stdout.write(`  ok  ${label}\n`);
    return;
  }
  throw new Error(`FAIL: ${label} — expected a refusal, got none`);
}

function newMemory(over: Partial<db.NewMemory> = {}): string {
  const id = randomUUID();
  db.insertMemory({
    id,
    title: "test memory",
    type: "gotcha",
    project: null,
    area: "testing",
    trigger_context: "running the suite",
    symptom: "fatal: not a git repository (or any of the parent directories): .git",
    root_cause: "cwd was outside the checkout",
    fix: "cd into the repo first, or pass -C <path> to git",
    code_example: null,
    tags: "git,cwd",
    severity: "major",
    ...over,
  });
  return id;
}

process.stdout.write("\nschema\n");
const stats0 = db.memoryStats();
ok("fresh db migrates and reports zero rows", stats0.active === 0);
ok("fts integrity-check passes on an empty index", db.ftsIntegrityCheck().ok);

// Idempotence: migrate() runs on every getDb(), and a second connection to the same
// file must not trip over columns or triggers that already exist.
const raw = (await import("better-sqlite3")).default;
const second = new raw(join(dir, "memory.db"));
ok("a second connection opens the migrated db cleanly", second.prepare("SELECT 1 x").get() !== undefined);
second.close();

process.stdout.write("\nsession writes (guards dormant)\n");
const a = newMemory();
ok("insert round-trips", db.getMemoryById(a)?.title === "test memory");
ok("new rows start dirty", db.getMemoryById(a)?.dirty === 1);
ok("new rows start unfrozen", db.getMemoryById(a)?.curator_edit_count === 0);
db.updateMemory(a, { symptom: "something else entirely" });
ok("a session may rewrite symptom freely", db.getMemoryById(a)?.symptom === "something else entirely");
ok("a session edit bumps updated_at", !!db.getMemoryById(a)?.updated_at);

process.stdout.write("\nrevision history\n");
const revs = (await import("better-sqlite3")).default;
const conn = new revs(join(dir, "memory.db"));
const revCount = conn.prepare("SELECT COUNT(*) n FROM memory_revisions WHERE memory_id = ?").get(a) as { n: number };
conn.close();
ok("the update was recorded column-wise in memory_revisions", revCount.n >= 1);

process.stdout.write("\ncurator guards\n");
const b = newMemory();
const runId = db.startCurationRun("nightly", "2026-10-13", "2026-10-13");
db.setCurationActor("curator", runId);
try {
  const original = db.getMemoryById(b)!;

  // A same-length paraphrase, so the shrink guard stays out of it and this isolates
  // the append-only rule. This is the realistic failure: prose that reads just as well
  // and has quietly dropped the exact string a future search would have matched on.
  throws(
    "symptom rewrite is refused (the FTS anchor)",
    () =>
      db.updateMemory(
        b,
        { symptom: "the git command failed because the working directory was not inside a repo" },
        "curator"
      ),
    /symptom is append-only/
  );

  db.updateMemory(b, { symptom: `${original.symptom}\n\nNOTE 2026-10-13: also fires inside a worktree.` }, "curator");
  ok("symptom append is allowed", db.getMemoryById(b)!.symptom.startsWith(original.symptom));
  ok("a curator edit does NOT bump updated_at", db.getMemoryById(b)!.updated_at === original.updated_at);
  ok("a curator edit stamps curated_at", db.getMemoryById(b)!.curated_at !== null);
  ok("a curator edit increments the edit count", db.getMemoryById(b)!.curator_edit_count === 1);

  // On its own row so the arithmetic is unambiguous: this fix is most of the prose,
  // and replacing it with a tidy one-liner is exactly how detail gets lost.
  const verbose = newMemory({
    fix: "Pin observed_on on BOTH joins and assert n against the digest before believing any earlier date. "
      + "Matching on ratios alone is NOT a match — the 4x-inflated version matched every ratio to 2dp.",
  });
  throws(
    "a >20% prose cut is refused",
    () => db.updateMemory(verbose, { fix: "Pin observed_on on both joins." }, "curator"),
    /more than 20%/
  );
  throws(
    "a severity downgrade is refused",
    () => db.updateMemory(b, { severity: "info" }, "curator"),
    /severity downgrades/
  );
  throws("a hard delete is refused", () => db.deleteMemory(b), /hard delete is not permitted/);

  // Two curator touches and the row freezes until a human edits it.
  db.updateMemory(b, { tags: "git,cwd,worktree" }, "curator");
  ok("second curator edit lands", db.getMemoryById(b)!.curator_edit_count === 2);
  throws(
    "a third curator edit is frozen out",
    () => db.updateMemory(b, { tags: "git,cwd,worktree,more" }, "curator"),
    /curated twice/
  );

  // A corrected memory is the content, not noise: it cannot be archived away.
  const parent = newMemory({ title: "the older, now-wrong belief" });
  const correction = newMemory({ title: "CORRECTION to the older belief" });
  db.addRelation(correction, parent, "corrects", "supersedes the agent-config-backup path", "curator");
  throws(
    "archiving a corrected memory is refused",
    () => db.archiveMemory(parent, "stale", null, "curator"),
    /cannot be archived/
  );
} finally {
  db.setCurationActor(null, null);
}

process.stdout.write("\nhuman override\n");
db.updateMemory(b, { tags: "git,cwd,worktree,human" });
ok("a human edit thaws the freeze", db.getMemoryById(b)!.curator_edit_count === 0);
ok("a human edit re-marks the row dirty", db.getMemoryById(b)!.dirty === 1);

process.stdout.write("\narchive round-trip\n");
const c = newMemory({ title: "a duplicate", area: "archivetest" });
db.archiveMemory(c, "duplicate_of", a);
ok("archived row is hidden from list_memories", !db.listMemories({ area: "archivetest" }).some((m) => m.id === c));
ok("archived row is hidden from search_memory", !db.searchMemories("duplicate").some((m) => m.id === c));
ok("archived row is hidden from get_context", !db.getContextMemories(["archivetest"]).some((m) => m.id === c));
ok("archived row is still readable by id", db.getMemoryById(c)?.archived_at !== null);
ok("archived row records what replaced it", db.getMemoryById(c)?.superseded_by === a);
ok("include_archived opts back in", db.listMemories({ area: "archivetest", include_archived: true }).some((m) => m.id === c));
db.restoreMemory(c);
ok("restore brings it back", db.listMemories({ area: "archivetest" }).some((m) => m.id === c));

process.stdout.write("\nthe UTC boundary\n");
// created_at/updated_at are UTC. The whole job hinges on the window being computed in
// LOCAL time: at 23:00 EDT the UTC date is already tomorrow, so a naive comparison
// matches nothing stored that evening and the run silently reviews an empty set.
const conn2 = new raw(join(dir, "memory.db"));
const t = conn2.prepare("SELECT date('now') utc, date('now','localtime') local").get() as {
  utc: string;
  local: string;
};
const localToday = t.local;
conn2.close();
ok(
  `rows stored now are found by a LOCAL-date window (${localToday})`,
  db.listMemories({ since: localToday, until: localToday, limit: 100 }).length > 0
);

process.stdout.write("\ncandidates + ledger\n");
ok("dirty rows surface as candidates", db.listCurationCandidates({ limit: 50 }).length > 0);
db.markCurated(a);
ok("marking curated clears dirty", db.getMemoryById(a)!.dirty === 0);
ok("a clean row drops out of the candidate set", !db.listCurationCandidates({ limit: 50 }).some((m) => m.id === a));
db.recordCurationAction({ run_id: runId, memory_id: a, verdict: "KEEP", tier: "applied", reason: "no change" });
ok("the ledger records the action", db.getCurationActions(runId).length === 1);
db.finishCurationRun(runId, "ok", { candidates: 1, applied: 1, proposed: 0 });
ok("the run closes", db.getCurationRun(runId)?.status === "ok");

process.stdout.write("\ncurator claim is scoped to a write, not a run\n");
{
  const { applyDecisions } = await import("../src/curation/apply.js");
  const target = newMemory({ title: "claim scope test" });
  const runId2 = db.startCurationRun("nightly", null, null);

  ok("no claim is held before applying", db.getCurationActor().actor === null);
  applyDecisions(runId2, [{ memory_id: target, verdict: "KEEP", rationale: "x" }]);
  // The claim must not outlive the write. Held across a whole run it would tag every
  // other process writing to this shared database as the curator: their edits land in
  // this run's revision history, so `undo --run` reverts a real session's work, and
  // they get judged by triggers meant only for the curator.
  ok("no claim is left behind after applying", db.getCurationActor().actor === null);

  // A write from "another process" while no claim is held must be unguarded and
  // unattributed, even though a curation run is open.
  db.updateMemory(target, { symptom: "a completely rewritten symptom from another session" });
  ok(
    "a concurrent session may still rewrite symptom freely",
    db.getMemoryById(target)!.symptom.startsWith("a completely rewritten")
  );
  const stray = db
    .getRevisionsForRun(runId2)
    .filter((r) => r.column_name === "symptom");
  ok("...and its edit is NOT attributed to the curation run", stray.length === 0);
}

process.stdout.write("\nerosion guard\n");
{
  const { checkTrailingInvariants, recordStatsPoint } = await import("../src/curation/apply.js");
  // Small corpora are exempt: a percentage on ten rows is noise, not erosion.
  recordStatsPoint();
  ok("a small corpus is exempt from the percentage check", checkTrailingInvariants().ok);

  // Now plant a baseline large enough to be meaningful, and far enough above the
  // present size to represent a month of quiet attrition.
  const { setState } = await import("../src/db.js");
  setState(
    "stats_history",
    JSON.stringify([{ date: new Date().toISOString().slice(0, 10), active: 200, prose_bytes: 900_000 }])
  );
  const check = checkTrailingInvariants();
  ok("a big drop against a real baseline is caught", !check.ok);
  ok("...and says which invariant broke", check.violations.some((v) => v.includes("active memories")));
  setState("stats_history", null);
}

process.stdout.write("\nNOTE and SUPERSEDE actually write\n");
{
  // Both used to be recorded as 'applied' while updateMemory silently dropped the
  // column, because neither was in its allowlist. The ledger said one thing and the
  // row another, and only reading the row back could tell.
  const { applyDecisions } = await import("../src/curation/apply.js");
  const noted = newMemory({ title: "noted" });
  const older = newMemory({ title: "older" });
  const newer = newMemory({ title: "newer" });
  const runId3 = db.startCurationRun("nightly", null, null);
  const out = applyDecisions(runId3, [
    { memory_id: noted, verdict: "NOTE", note: "still true on 2026-10", rationale: "x" },
    { memory_id: older, verdict: "SUPERSEDE", cites: newer, rationale: "newer has the root cause" },
  ]);
  ok("both verdicts applied", out.applied === 2);
  ok("the note landed on the row", (db.getMemoryById(noted)?.curator_note ?? "").includes("still true on 2026-10"));
  ok("superseded_by landed on the row", db.getMemoryById(older)?.superseded_by === newer);
}

process.stdout.write("\nsnapshot\n");
const snap = join(dir, "snap.db");
db.snapshotTo(snap);
const snapDb = new raw(snap, { readonly: true });
const snapCount = snapDb.prepare("SELECT COUNT(*) n FROM memories").get() as { n: number };
const integrity = snapDb.pragma("integrity_check") as { integrity_check: string }[];
snapDb.close();
ok("snapshot carries the rows", snapCount.n > 0);
ok("snapshot passes integrity_check", integrity[0].integrity_check === "ok");
ok("fts index is still consistent at the end", db.ftsIntegrityCheck().ok);

rmSync(dir, { recursive: true, force: true });
process.stdout.write(`\n${passed} checks passed\n`);
