import {
  addRelation, archiveMemory, curatorRelationsBetween, deleteRelation, finishCurationRun,
  getCurationAction, getCurationActions, getCurationRun, getDb, getMemoryById, getRelationById,
  listDamagedMemories, markActionUndone, rebuildFts, resolveProposals, restoreMemory, revertMemoryInRun, revertRun,
  setCurationActor, setState, updateMemory,
} from "../db.js";
import { loadCanaries, runCanaries, saveBaseline } from "../curation/canary.js";
import { ackKey } from "./model.js";
import { applyRepair, planRepair } from "./repair.js";
import type { ArchiveReason, RelationKind } from "../types.js";

/**
 * Every button on the dashboard lands here. Each one is a write a human chose to make,
 * so it goes through the same db.ts functions as the MCP tools, as a 'session' writer —
 * never as the curator. That keeps the curator's guard triggers out of the way of a
 * human's decision, and keeps the human's edits out of `undo --run`.
 */

const REASONS: ArchiveReason[] = ["duplicate_of", "superseded_by", "stale", "no_longer_relevant"];
const KINDS: RelationKind[] = ["supersedes", "corrects", "contradicts", "duplicate_of", "refines"];
const MUTATING = new Set(["RETAG", "NOTE", "RELATE", "SUPERSEDE", "ARCHIVE"]);

export interface ActResult {
  ok: boolean;
  message: string;
}

type Params = Record<string, unknown>;

function str(p: Params, key: string, required = true): string | null {
  const v = p[key];
  if (typeof v === "string" && v.trim()) return v.trim();
  if (required) throw new Error(`missing ${key}`);
  return null;
}

function ids(p: Params): string[] {
  const v = p.ids;
  if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === "string")) {
    throw new Error("missing ids");
  }
  return v as string[];
}

function requireMemory(id: string, label = "memory") {
  const m = getMemoryById(id);
  if (!m) throw new Error(`no ${label} with id ${id}`);
  return m;
}

function doArchive(memoryId: string, reasonRaw: string | null, citesRaw: string | null, note: string | null): string {
  const m = requireMemory(memoryId);
  if (m.archived_at) throw new Error("already archived");
  const reason = (reasonRaw ?? (citesRaw ? "duplicate_of" : "no_longer_relevant")) as ArchiveReason;
  if (!REASONS.includes(reason)) throw new Error(`unknown reason ${reason}`);
  if ((reason === "duplicate_of" || reason === "superseded_by") && !citesRaw) {
    throw new Error(`${reason} needs the id of the memory that replaces it`);
  }
  if (citesRaw) {
    const c = requireMemory(citesRaw, "cited memory");
    if (c.archived_at) throw new Error("the cited memory is itself archived");
    if (c.id === m.id) throw new Error("a memory cannot replace itself");
  }
  archiveMemory(memoryId, reason, citesRaw, "session");
  if (citesRaw) {
    addRelation(citesRaw, memoryId, reason === "duplicate_of" ? "duplicate_of" : "supersedes", note, "dashboard");
  }
  return `archived "${m.title}" (${reason})`;
}

function doSupersede(memoryId: string, cites: string): string {
  const m = requireMemory(memoryId);
  const c = requireMemory(cites, "cited memory");
  if (c.id === m.id) throw new Error("a memory cannot supersede itself");
  addRelation(cites, memoryId, "supersedes", null, "dashboard");
  updateMemory(memoryId, { superseded_by: cites }, "session");
  return `"${m.title}" is now marked superseded by "${c.title}"`;
}

function doRelate(memoryId: string, cites: string, kindRaw: string | null): string {
  const m = requireMemory(memoryId);
  const c = requireMemory(cites, "cited memory");
  const kind = (kindRaw ?? "refines") as RelationKind;
  if (!KINDS.includes(kind)) throw new Error(`unknown relation ${kind}`);
  const r = addRelation(memoryId, cites, kind, null, "dashboard");
  return r ? `linked: "${m.title}" ${kind} "${c.title}"` : "that link already exists";
}

/** Revert one applied curator action: the row's columns, and any link it drew. */
function undoChange(actionId: string): string {
  const a = getCurationAction(actionId);
  if (!a || a.tier !== "applied") throw new Error("no applied action with that id");
  if (a.resolution === "undone") throw new Error("already undone");
  if (!MUTATING.has(a.verdict)) throw new Error(`${a.verdict} changed nothing, so there is nothing to undo`);

  let what: string;
  if (a.verdict === "ARCHIVE") {
    const m = requireMemory(a.memory_id);
    if (!m.archived_at) {
      what = "it was already active";
    } else {
      restoreMemory(a.memory_id);
      if (a.cites && m.superseded_by === a.cites) updateMemory(a.memory_id, { superseded_by: null }, "session");
      what = `restored "${m.title}"`;
    }
  } else {
    const r = revertMemoryInRun(a.run_id, a.memory_id);
    what = r.skipped ? `columns left alone (${r.skipped})` : `${r.reverted} column change(s) reverted`;
  }

  let unlinked = 0;
  if (a.cites) {
    for (const rel of curatorRelationsBetween(a.memory_id, a.cites)) {
      if (deleteRelation(rel.id)) unlinked++;
    }
  }
  markActionUndone(actionId, "undone from dashboard");
  return `${what}${unlinked ? `, ${unlinked} link(s) removed` : ""}`;
}

/**
 * One transaction per button, so a click that does two things — archive the row and
 * answer the proposal — can never land half-done.
 */
export function act(action: string, p: Params, ctx: { canariesFile: string | null }): ActResult {
  try {
    return getDb().transaction(() => dispatch(action, p, ctx))();
  } catch (error) {
    return { ok: false, message: String(error).replace(/^Error:\s*/, "") };
  }
}

function dispatch(action: string, p: Params, ctx: { canariesFile: string | null }): ActResult {
  switch (action) {
    // ---- Proposals: do what it says, or answer it without doing anything.
    case "proposal.archive": {
      const msg = doArchive(str(p, "memory_id")!, str(p, "reason", false), str(p, "cites", false), str(p, "note", false));
      resolveProposals(ids(p), "applied", "archived from dashboard");
      return { ok: true, message: msg };
    }
    case "proposal.supersede": {
      const msg = doSupersede(str(p, "memory_id")!, str(p, "cites")!);
      resolveProposals(ids(p), "applied", "superseded from dashboard");
      return { ok: true, message: msg };
    }
    case "proposal.relate": {
      const msg = doRelate(str(p, "memory_id")!, str(p, "cites")!, str(p, "kind", false));
      resolveProposals(ids(p), "applied", "linked from dashboard");
      return { ok: true, message: msg };
    }
    case "proposal.done": {
      const n = resolveProposals(ids(p), "applied", str(p, "note", false) ?? "handled by hand");
      return { ok: true, message: `marked ${n} proposal(s) handled` };
    }
    case "proposal.dismiss": {
      const n = resolveProposals(ids(p), "dismissed", str(p, "note", false));
      return { ok: true, message: `dismissed ${n} proposal(s)` };
    }

    case "merge.apply": {
      // Keep one entry and point every other ticked entry at it — as "replaced by"
      // (all stay searchable) or archived. The entries to fold are chosen on the card;
      // the curator's own warning is that some copies hold a detail the main one lacks.
      const main = requireMemory(str(p, "main")!, "main entry");
      if (main.archived_at) throw new Error("the main entry is archived — pick another");
      const others = Array.isArray(p.others) ? (p.others as unknown[]).filter((x): x is string => typeof x === "string") : [];
      if (!others.length) throw new Error("tick at least one entry to fold into the main one");
      const mode = str(p, "mode", false) === "archive" ? "archive" : "supersede";
      let n = 0;
      for (const id of others) {
        if (id === main.id) continue;
        const m = requireMemory(id);
        if (m.archived_at) continue;
        if (mode === "archive") doArchive(id, "duplicate_of", main.id, "merged from dashboard");
        else doSupersede(id, main.id);
        n++;
      }
      resolveProposals(ids(p), "applied", `merged into ${main.id}`);
      return { ok: true, message: `${n} ${n === 1 ? "entry" : "entries"} ${mode === "archive" ? "archived" : "marked replaced"} in favour of "${main.title}"` };
    }

    case "repair.apply": {
      const plan = applyRepair(str(p, "memory_id")!);
      return { ok: true, message: `repaired "${plan.title}": ${Object.keys(plan.changes).join(", ")}` };
    }
    case "repair.applyAll": {
      let fixed = 0;
      for (const d of listDamagedMemories()) {
        const m = getMemoryById(d.id);
        if (!m || planRepair(m).manual) continue;
        applyRepair(d.id);
        fixed++;
      }
      return { ok: true, message: `repaired ${fixed} ${fixed === 1 ? "entry" : "entries"}` };
    }

    // ---- Changes the curator already made.
    case "change.undo":
      return { ok: true, message: undoChange(str(p, "action_id")!) };

    case "run.undo": {
      const runId = str(p, "run_id")!;
      if (!getCurationRun(runId)) throw new Error("no such run");
      const { reverted, skipped } = revertRun(runId);
      for (const a of getCurationActions(runId)) {
        if (a.tier === "applied" && MUTATING.has(a.verdict) && a.resolution !== "undone") {
          markActionUndone(a.id, "whole run undone from dashboard");
        }
      }
      return {
        ok: true,
        message: `reverted ${reverted.length} memories${skipped.length ? `; skipped ${skipped.length} edited since` : ""}`,
      };
    }
    case "run.markFailed": {
      const run = getCurationRun(str(p, "run_id")!);
      if (!run) throw new Error("no such run");
      if (run.status !== "running") throw new Error(`run is ${run.status}, not running`);
      finishCurationRun(run.id, "failed", {
        candidates: run.candidates, applied: run.applied, proposed: run.proposed,
        notes: "never finished; marked failed from the dashboard",
      });
      return { ok: true, message: "run marked failed" };
    }

    // ---- Health.
    case "state.clearLatch":
      setState("last_run_failed", "0");
      return { ok: true, message: "the curator will run again tonight" };
    case "state.releaseActor":
      setCurationActor(null, null);
      return { ok: true, message: "guard claim released" };
    case "fts.rebuild":
      rebuildFts();
      return { ok: true, message: "search index rebuilt" };
    case "canary.accept": {
      if (!ctx.canariesFile) throw new Error("no canary file configured");
      const results = runCanaries(loadCanaries(ctx.canariesFile));
      saveBaseline(results);
      return { ok: true, message: `baseline saved for ${results.length} canaries` };
    }
    case "ack":
      setState(ackKey(str(p, "key")!), new Date().toISOString());
      return { ok: true, message: "noted" };

    // ---- Direct edits from the memory panel.
    case "memory.archive":
      return { ok: true, message: doArchive(str(p, "memory_id")!, str(p, "reason", false), str(p, "cites", false), str(p, "note", false)) };
    case "memory.restore": {
      const m = restoreMemory(str(p, "memory_id")!);
      if (!m) throw new Error("not archived, or no such memory");
      return { ok: true, message: `restored "${m.title}"` };
    }
    case "memory.supersede":
      return { ok: true, message: doSupersede(str(p, "memory_id")!, str(p, "cites")!) };
    case "memory.relate":
      return { ok: true, message: doRelate(str(p, "memory_id")!, str(p, "cites")!, str(p, "kind", false)) };
    case "relation.delete": {
      const rel = getRelationById(str(p, "relation_id")!);
      if (!rel) throw new Error("no such link");
      deleteRelation(rel.id);
      return { ok: true, message: `removed the ${rel.kind} link` };
    }

    default:
      throw new Error(`unknown action ${action}`);
  }
}

