import {
  addRelation, archiveMemory, getCurationActions, getDb, getMemoryById, markCurated,
  memoryStats, recordCurationAction, setState, getState, updateMemory,
} from "../db.js";
import { literalFingerprint, memorySimilarity } from "./similarity.js";
import type { ArchiveReason, MemoryEntry, RelationKind } from "../types.js";

/**
 * Applies the model's decisions, after re-deriving every claim it is allowed to act on.
 *
 * The division of labour is the point: the model proposes, this verifies, and the
 * guard triggers in the schema refuse anything that gets past both. Nothing here
 * trusts a field the model filled in — a similarity score is recomputed, a cited id
 * is looked up, a budget is counted from the ledger.
 */

/** Deliberately not stated in the prompt. A budget a model can see becomes a target. */
const NIGHTLY_ARCHIVE_CAP = 3;
const MONTHLY_ARCHIVE_CAP = 10;
/** Near-total overlap. Below this, a merge or duplicate-archive is a proposal only. */
const DUPLICATE_THRESHOLD = 0.9;

export type Verdict = "KEEP" | "RETAG" | "NOTE" | "RELATE" | "SUPERSEDE" | "ARCHIVE" | "PROPOSE";

export interface Decision {
  memory_id: string;
  verdict: Verdict;
  reason?: ArchiveReason;
  cites?: string;
  relation_kind?: RelationKind;
  tags?: string;
  note?: string;
  rationale: string;
}

export interface ApplyOutcome {
  applied: number;
  proposed: number;
  refused: number;
  details: { memory_id: string; verdict: string; tier: string; detail: string }[];
}

function archivesInLastMonth(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) n FROM curation_actions
       WHERE verdict = 'ARCHIVE' AND tier = 'applied'
         AND date(created_at) >= date('now', 'localtime', '-30 days')`
    )
    .get() as { n: number };
  return row.n;
}

export function archivesRemaining(): number {
  return Math.max(0, Math.min(NIGHTLY_ARCHIVE_CAP, MONTHLY_ARCHIVE_CAP - archivesInLastMonth()));
}

function tagsAreAppendOnly(oldTags: string | null, newTags: string): boolean {
  const before = new Set((oldTags ?? "").split(",").map((t) => t.trim()).filter(Boolean));
  const after = new Set(newTags.split(",").map((t) => t.trim()).filter(Boolean));
  for (const t of before) if (!after.has(t)) return false;
  return true;
}

function fingerprintPreserved(before: MemoryEntry, after: MemoryEntry): boolean {
  const a = literalFingerprint(before);
  const b = literalFingerprint(after);
  for (const token of a) if (!b.has(token)) return false;
  return true;
}

export function applyDecisions(runId: string, decisions: Decision[], dryRun = false): ApplyOutcome {
  const db = getDb();
  const outcome: ApplyOutcome = { applied: 0, proposed: 0, refused: 0, details: [] };
  let budget = archivesRemaining();

  // A dry run records what WOULD have happened under its real verdict, rather than
  // rewriting everything to PROPOSE — the point of a dry run is to see the judgement
  // you are being asked to trust, and "PROPOSE" for all 25 tells you nothing.
  if (dryRun) {
    for (const d of decisions) {
      recordCurationAction({
        run_id: runId, memory_id: d.memory_id, verdict: d.verdict, tier: "proposed",
        reason: d.reason ?? null, cites: d.cites ?? null, rationale: d.rationale,
      });
      outcome.proposed++;
      outcome.details.push({ memory_id: d.memory_id, verdict: d.verdict, tier: "proposed", detail: "dry run" });
    }
    return outcome;
  }

  const note = (d: Decision, tier: "applied" | "proposed" | "refused", detail: string): void => {
    outcome[tier === "applied" ? "applied" : tier === "proposed" ? "proposed" : "refused"]++;
    outcome.details.push({ memory_id: d.memory_id, verdict: d.verdict, tier, detail });
  };

  for (const d of decisions) {
    const before = getMemoryById(d.memory_id);
    if (!before) {
      note(d, "refused", "no such memory");
      continue;
    }

    // One transaction per decision, with the ledger row written inside it. A crash can
    // never leave an action applied but unrecorded, or recorded but not applied.
    const run = db.transaction(() => {
      switch (d.verdict) {
        case "KEEP": {
          markCurated(d.memory_id);
          recordCurationAction({ run_id: runId, memory_id: d.memory_id, verdict: "KEEP", tier: "applied", rationale: d.rationale });
          note(d, "applied", "left as is");
          return;
        }

        case "RETAG": {
          if (!d.tags) return note(d, "refused", "no tags given");
          if (!tagsAreAppendOnly(before.tags, d.tags)) {
            return note(d, "refused", "retag would drop an existing tag");
          }
          updateMemory(d.memory_id, { tags: d.tags }, "curator");
          const after = getMemoryById(d.memory_id)!;
          if (!fingerprintPreserved(before, after)) {
            throw new Error("retag dropped a literal token");
          }
          markCurated(d.memory_id);
          recordCurationAction({ run_id: runId, memory_id: d.memory_id, verdict: "RETAG", tier: "applied", rationale: d.rationale });
          return note(d, "applied", `tags -> ${d.tags}`);
        }

        case "NOTE": {
          if (!d.note) return note(d, "refused", "no note given");
          // Appended, never overwriting a fact: the curator has no ground truth to
          // check a claim against, so it annotates rather than corrects.
          const stamped = `[curated ${new Date().toISOString().slice(0, 10)}] ${d.note}`;
          const merged = before.curator_note ? `${before.curator_note}\n${stamped}` : stamped;
          updateMemory(d.memory_id, { curator_note: merged }, "curator");
          markCurated(d.memory_id);
          recordCurationAction({ run_id: runId, memory_id: d.memory_id, verdict: "NOTE", tier: "applied", rationale: d.rationale });
          return note(d, "applied", "note appended");
        }

        case "RELATE":
        case "SUPERSEDE": {
          if (!d.cites) return note(d, "refused", "no cited memory");
          const target = getMemoryById(d.cites);
          if (!target) return note(d, "refused", `cited memory ${d.cites} does not exist`);

          const kind: RelationKind = d.verdict === "SUPERSEDE" ? "supersedes" : (d.relation_kind ?? "refines");
          // SUPERSEDE reads "this candidate is superseded by cites", so the edge runs
          // from the newer entry to the older one.
          const from = d.verdict === "SUPERSEDE" ? d.cites : d.memory_id;
          const to = d.verdict === "SUPERSEDE" ? d.memory_id : d.cites;
          addRelation(from, to, kind, d.rationale.slice(0, 200), "curator");

          if (d.verdict === "SUPERSEDE") {
            // Stamped, not archived. A correction read without the belief it corrects
            // loses the reason the wrong belief was plausible.
            updateMemory(d.memory_id, { superseded_by: d.cites }, "curator");
          }
          markCurated(d.memory_id);
          recordCurationAction({ run_id: runId, memory_id: d.memory_id, verdict: d.verdict, tier: "applied", cites: d.cites, rationale: d.rationale });
          return note(d, "applied", `${from} ${kind} ${to}`);
        }

        case "ARCHIVE": {
          const reason = d.reason;
          // Reasons with no machine-checkable predicate are proposals, never actions.
          if (reason !== "duplicate_of" && reason !== "superseded_by") {
            recordCurationAction({ run_id: runId, memory_id: d.memory_id, verdict: "ARCHIVE", tier: "proposed", reason: reason ?? null, cites: d.cites ?? null, rationale: d.rationale });
            return note(d, "proposed", `'${reason ?? "unstated"}' has no verifiable test — left for review`);
          }
          if (!d.cites) return note(d, "refused", `${reason} requires the id that replaces it`);
          const target = getMemoryById(d.cites);
          if (!target || target.archived_at) {
            return note(d, "refused", `cited memory ${d.cites} is missing or itself archived`);
          }
          if (budget <= 0) {
            recordCurationAction({ run_id: runId, memory_id: d.memory_id, verdict: "ARCHIVE", tier: "proposed", reason, cites: d.cites, rationale: d.rationale });
            return note(d, "proposed", "archive budget exhausted");
          }
          if (reason === "duplicate_of") {
            // Recomputed here, never taken from the model's claim.
            const score = memorySimilarity(before, target);
            if (score < DUPLICATE_THRESHOLD) {
              recordCurationAction({ run_id: runId, memory_id: d.memory_id, verdict: "ARCHIVE", tier: "proposed", reason, cites: d.cites, rationale: d.rationale });
              return note(d, "proposed", `overlap ${score.toFixed(2)} is below ${DUPLICATE_THRESHOLD} — may be a real distinction`);
            }
          }
          archiveMemory(d.memory_id, reason, d.cites, "curator");
          addRelation(d.cites, d.memory_id, reason === "duplicate_of" ? "duplicate_of" : "supersedes", d.rationale.slice(0, 200), "curator");
          budget--;
          recordCurationAction({ run_id: runId, memory_id: d.memory_id, verdict: "ARCHIVE", tier: "applied", reason, cites: d.cites, rationale: d.rationale });
          return note(d, "applied", `archived in favour of ${d.cites}`);
        }

        case "PROPOSE":
        default: {
          recordCurationAction({ run_id: runId, memory_id: d.memory_id, verdict: d.verdict === "PROPOSE" ? "PROPOSE" : d.verdict, tier: "proposed", cites: d.cites ?? null, rationale: d.rationale });
          return note(d, "proposed", "for review");
        }
      }
    });

    try {
      run();
    } catch (error) {
      // A guard trigger fired, or a post-edit invariant failed. The transaction rolled
      // back, so the refusal is the whole outcome for this decision.
      outcome.refused++;
      outcome.details.push({ memory_id: d.memory_id, verdict: d.verdict, tier: "refused", detail: String(error).replace(/^Error:\s*/, "") });
      recordCurationAction({ run_id: runId, memory_id: d.memory_id, verdict: d.verdict, tier: "refused", rationale: String(error).slice(0, 300) });
    }
  }

  return outcome;
}

// ---- Trailing-window invariants. A per-run cap cannot see slow erosion: three
// defensible archives a night is ninety a month, and every individual report looks
// fine. These compare against history instead.

interface StatsPoint { date: string; active: number; prose_bytes: number }

export function recordStatsPoint(): void {
  const stats = memoryStats();
  const history: StatsPoint[] = JSON.parse(getState("stats_history") ?? "[]");
  history.push({ date: new Date().toISOString().slice(0, 10), active: stats.active, prose_bytes: stats.prose_bytes });
  setState("stats_history", JSON.stringify(history.slice(-90)));
}

/**
 * Below this, a percentage is noise rather than a signal: on a ten-row store one
 * entirely correct archive is a 10% drop. Erosion is a large-corpus failure, and in a
 * small one the per-run archive cap is the bound that matters.
 */
const EROSION_FLOOR = 20;

export function checkTrailingInvariants(): { ok: boolean; violations: string[]; baseline: StatsPoint | null } {
  const history: StatsPoint[] = JSON.parse(getState("stats_history") ?? "[]");
  const now = memoryStats();
  const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const baseline = history.find((p) => p.date >= cutoff) ?? history[0] ?? null;
  if (!baseline) return { ok: true, violations: [], baseline: null };
  if (baseline.active < EROSION_FLOOR) return { ok: true, violations: [], baseline };

  const violations: string[] = [];
  if (now.active < baseline.active * 0.95) {
    violations.push(`active memories ${baseline.active} -> ${now.active} (>5% drop since ${baseline.date})`);
  }
  if (now.prose_bytes < baseline.prose_bytes * 0.9) {
    violations.push(`prose ${baseline.prose_bytes} -> ${now.prose_bytes} bytes (>10% drop since ${baseline.date})`);
  }
  return { ok: violations.length === 0, violations, baseline };
}

export { getCurationActions };
