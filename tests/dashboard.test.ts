/**
 * The dashboard's model and every button behind it, against a throwaway store — plus a
 * real HTTP round trip, because the token and Host checks are the only thing standing
 * between a website open in the same browser and an archive button.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const dir = mkdtempSync(join(tmpdir(), "agent-memory-dash-"));
process.env.AGENT_MEMORY_DIR = dir;

const db = await import("../src/db.js");
const { act } = await import("../src/dashboard/actions.js");
const { buildOverview, buildProposals } = await import("../src/dashboard/model.js");
const { startDashboard } = await import("../src/dashboard/server.js");

let passed = 0;
function ok(label: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  process.stdout.write(`  ok  ${label}\n`);
}

function mk(title: string, over: Partial<db.NewMemory> = {}): string {
  const id = randomUUID();
  db.insertMemory({
    id, title, type: "gotcha", project: null, area: "git", trigger_context: null,
    symptom: `${title} symptom`, root_cause: null, fix: "fix", code_example: null, tags: "t", severity: "major", ...over,
  });
  return id;
}
const ctx = { canariesFile: null };

const dup = mk("duplicate entry");
const survivor = mk("surviving entry");
const consolidate = mk("one of eight");
const relA = mk("relate a");
const relB = mk("relate b");
const kept = mk("kept");

// Two nights asking the same thing, plus one of each other shape.
const night1 = db.startCurationRun("nightly", "2026-10-19", "2026-10-19");
const night2 = db.startCurationRun("nightly", "2026-10-20", "2026-10-20");
db.recordCurationAction({ run_id: night1, memory_id: dup, verdict: "ARCHIVE", tier: "proposed", reason: "duplicate_of", cites: survivor, rationale: "same" });
db.recordCurationAction({ run_id: night2, memory_id: dup, verdict: "ARCHIVE", tier: "proposed", reason: "duplicate_of", cites: survivor, rationale: "same again" });
db.recordCurationAction({ run_id: night2, memory_id: consolidate, verdict: "PROPOSE", tier: "proposed", rationale: `merge with ${survivor.slice(0, 8)} and ${dup}` });
db.recordCurationAction({ run_id: night1, memory_id: relA, verdict: "RELATE", tier: "proposed", cites: relB, rationale: "siblings" });
db.recordCurationAction({ run_id: night1, memory_id: kept, verdict: "KEEP", tier: "proposed", rationale: "fine" });
db.recordCurationAction({ run_id: night1, memory_id: kept, verdict: "RETAG", tier: "proposed", rationale: "add a tag" });
db.finishCurationRun(night1, "ok", {});
db.finishCurationRun(night2, "ok", {});

process.stdout.write("\nproposal queue\n");
let p = buildProposals();
const archiveGroup = p.open.find((g) => g.verdict === "ARCHIVE")!;
ok("a question asked on two nights appears once", p.open.filter((g) => g.verdict === "ARCHIVE").length === 1);
ok("...and says it was asked twice", archiveGroup.times === 2 && archiveGroup.action_ids.length === 2);
ok("removals sort first", p.open[0].verdict === "ARCHIVE");
ok("dry-run KEEP and RETAG go to the leftovers bucket", p.noop.length === 2 && p.open.every((g) => g.verdict !== "KEEP" && g.verdict !== "RETAG"));
const propose = p.open.find((g) => g.verdict === "PROPOSE")!;
ok("ids named in a rationale are resolved, short and full", propose.mentioned.length === 2);

process.stdout.write("\nanswering\n");
let r = act("proposal.archive", { ids: archiveGroup.action_ids, memory_id: dup, reason: "duplicate_of", cites: survivor }, ctx);
ok("archive in favour of the cited entry", r.ok);
ok("the row is archived and points at its survivor", db.getMemoryById(dup)?.archived_at !== null && db.getMemoryById(dup)?.superseded_by === survivor);
ok("a duplicate_of link was drawn", db.getRelations(dup).some((x) => x.kind === "duplicate_of" && x.from_id === survivor));
ok("both nights' proposals are answered", archiveGroup.action_ids.every((id) => db.getCurationAction(id)?.resolution === "applied"));
ok("the second click fails cleanly", !act("proposal.archive", { ids: archiveGroup.action_ids, memory_id: dup, reason: "duplicate_of", cites: survivor }, ctx).ok);
ok("archiving needs a replacement for duplicate_of", !act("memory.archive", { memory_id: kept, reason: "duplicate_of" }, ctx).ok);

const relGroup = buildProposals().open.find((g) => g.verdict === "RELATE")!;
ok("link the two", act("proposal.relate", { ids: relGroup.action_ids, memory_id: relA, cites: relB, kind: "refines" }, ctx).ok);
ok("...the link exists", db.getRelations(relA).some((x) => x.to_id === relB && x.kind === "refines"));

ok("dismiss", act("proposal.dismiss", { ids: propose.action_ids }, ctx).ok);
p = buildProposals();
ok("the open queue is empty", p.open.length === 0);
ok("a failed action leaves nothing half-done", !act("proposal.archive", { ids: ["nope"], memory_id: "missing" }, ctx).ok);

process.stdout.write("\na dismissed question stays answered\n");
{
  const night3 = db.startCurationRun("sweep", null, null);
  const again = db.recordCurationAction({ run_id: night3, memory_id: consolidate, verdict: "PROPOSE", tier: "proposed", rationale: "merge, again" });
  ok("re-asking it is answered on arrival", db.getCurationAction(again)?.resolution === "dismissed");
  ok("...so the queue stays empty", buildProposals().open.length === 0);
  // Timestamps have one-second resolution; a real edit comes long after the dismissal.
  await new Promise((r) => setTimeout(r, 1100));
  db.updateMemory(consolidate, { fix: "a human rewrote the fix" });
  const third = db.recordCurationAction({ run_id: night3, memory_id: consolidate, verdict: "PROPOSE", tier: "proposed", rationale: "merge, after the edit" });
  ok("once the row is edited, the question is fair to ask again", db.getCurationAction(third)?.resolved_at === null);
  act("proposal.dismiss", { ids: [third] }, ctx);
  db.finishCurationRun(night3, "ok", {});
}

process.stdout.write("\nundoing what the curator applied\n");
{
  const { applyDecisions } = await import("../src/curation/apply.js");
  const a = mk("applied target");
  const b = mk("applied cited");
  const run = db.startCurationRun("nightly", null, null);
  applyDecisions(run, [
    { memory_id: a, verdict: "RETAG", tags: "t,extra", rationale: "add extra" },
    { memory_id: b, verdict: "RELATE", cites: a, rationale: "related" },
  ]);
  db.finishCurationRun(run, "ok", {});
  const changes = buildOverview(null).changes;
  const retag = changes.find((c) => c.verdict === "RETAG")!;
  const relate = changes.find((c) => c.verdict === "RELATE")!;
  ok("recent changes lists what the curator did", Boolean(retag && relate));
  ok("undo a retag", act("change.undo", { action_id: retag.action_id }, ctx).ok && db.getMemoryById(a)?.tags === "t");
  ok("undo a link removes it", act("change.undo", { action_id: relate.action_id }, ctx).ok
    && !db.getRelations(b).some((x) => x.created_by === "curator"));
  ok("an undone change cannot be undone twice", !act("change.undo", { action_id: retag.action_id }, ctx).ok);
  ok("...and is shown as undone", buildOverview(null).changes.find((c) => c.action_id === retag.action_id)?.undone === true);
}

process.stdout.write("\nneeds attention\n");
db.setState("last_run_failed", "1");
ok("a set latch is the top item", buildOverview(null).attention[0]?.key === "latch");
ok("one click clears it", act("state.clearLatch", {}, ctx).ok && db.getState("last_run_failed") === "0");
db.setCurationActor("curator", "x");
ok("a stuck guard claim is flagged", buildOverview(null).attention.some((a) => a.key === "actor"));
act("state.releaseActor", {}, ctx);
ok("...and released", db.getCurationActor().actor === null);

process.stdout.write("\nhttp\n");
{
  const port = 4790 + Math.floor(Math.random() * 9);
  const server = await startDashboard({ port, canariesFile: null });
  const base = `http://127.0.0.1:${port}`;
  const page = await (await fetch(`${base}/`)).text();
  const token = /const TOKEN = "([0-9a-f]+)"/.exec(page)?.[1] ?? "";
  ok("the page carries a token", token.length === 48);
  ok("an API call without it is refused", (await fetch(`${base}/api/overview`)).status === 401);
  const post = await fetch(`${base}/api/act`, {
    method: "POST", body: JSON.stringify({ action: "state.clearLatch" }),
    headers: { "x-dashboard-token": token, "content-type": "text/plain" },
  });
  ok("a non-JSON POST is refused", post.status === 415);
  const overview = await fetch(`${base}/api/overview`, { headers: { "x-dashboard-token": token } });
  ok("with it, the overview loads", overview.status === 200 && Array.isArray((await overview.json()).runs));
  server.close();
}

rmSync(dir, { recursive: true, force: true });
process.stdout.write(`\n${passed} checks passed\n`);
