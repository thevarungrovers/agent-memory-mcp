import { existsSync } from "node:fs";
import {
  ftsIntegrityCheck, getCurationActor, getDb, getMemoryById, getRelations,
  getState, listCurationRuns, listOpenProposals, listRecentActions, memoryStats,
} from "../db.js";
import { checkTrailingInvariants } from "../curation/apply.js";
import { diffCanaries, loadBaseline, loadCanaries, runCanaries } from "../curation/canary.js";
import { memorySimilarity } from "../curation/similarity.js";
import type { CurationAction, MemoryEntry } from "../types.js";

/**
 * What the dashboard shows, assembled from the ledger and the live rows on every
 * request. Nothing here is read from the markdown reports: those are a per-night
 * narrative, and the reason this page exists is that a question asked in Tuesday's
 * report and again in Wednesday's had no single place to be answered.
 */

/** Verdicts that leave a row different from how they found it. KEEP does not. */
const MUTATING = new Set(["RETAG", "NOTE", "RELATE", "SUPERSEDE", "ARCHIVE"]);

export interface ButtonSpec {
  /** The action name POSTed to /api/act. */
  action: string;
  label: string;
  /** primary = the recommended answer; danger = asks for confirmation first. */
  kind?: "primary" | "danger" | "plain";
  params?: Record<string, unknown>;
  confirm?: string;
}

export interface AttentionItem {
  key: string;
  level: "critical" | "warning" | "info";
  title: string;
  detail: string;
  memories?: string[];
  buttons: ButtonSpec[];
}

export interface MemoryCard {
  id: string;
  title: string;
  type: string;
  severity: string;
  area: string;
  project: string | null;
  archived_at: string | null;
  superseded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProposalGroup {
  key: string;
  action_ids: string[];
  verdict: string;
  reason: string | null;
  rationale: string | null;
  times: number;
  first_seen: string;
  last_seen: string;
  memory: MemoryCard | null;
  cites: MemoryCard | null;
  similarity: number | null;
  /** Other memory ids the rationale names — consolidation proposals list several. */
  mentioned: MemoryCard[];
  buttons: ButtonSpec[];
}

function card(m: MemoryEntry | null): MemoryCard | null {
  if (!m) return null;
  return {
    id: m.id, title: m.title, type: m.type, severity: m.severity, area: m.area, project: m.project,
    archived_at: m.archived_at, superseded_by: m.superseded_by, created_at: m.created_at, updated_at: m.updated_at,
  };
}

/** Full ids, and the 8-hex short form the curator likes to write in prose. */
const ID_PATTERN = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/g;

function resolveMentioned(text: string | null, exclude: Set<string>): MemoryCard[] {
  if (!text) return [];
  const out = new Map<string, MemoryCard>();
  const byPrefix = getDb().prepare("SELECT * FROM memories WHERE id LIKE ? LIMIT 2");
  for (const token of new Set(text.match(ID_PATTERN) ?? [])) {
    let m: MemoryEntry | null = null;
    if (token.length === 36) {
      m = getMemoryById(token);
    } else {
      // Only a prefix that names exactly one row counts; an ambiguous one is dropped
      // rather than guessed.
      const rows = byPrefix.all(`${token}%`) as MemoryEntry[];
      if (rows.length === 1) m = rows[0];
    }
    if (m && !exclude.has(m.id)) out.set(m.id, card(m)!);
  }
  return [...out.values()];
}

function ackKey(key: string): string {
  return `ack:${key}`;
}

function acked(key: string): boolean {
  return getState(ackKey(key)) !== null;
}

export { ackKey };

function proposalButtons(g: { verdict: string; reason: string | null; memory: MemoryCard | null; cites: MemoryCard | null }): ButtonSpec[] {
  const b: ButtonSpec[] = [];
  const m = g.memory;
  const c = g.cites && !g.cites.archived_at ? g.cites : null;

  if (m && !m.archived_at) {
    if (g.verdict === "ARCHIVE") {
      const reason = g.reason ?? (c ? "duplicate_of" : "no_longer_relevant");
      b.push({
        action: "proposal.archive", label: c ? "Archive (keep the cited one)" : `Archive (${reason})`,
        kind: "primary", params: { reason, cites: c?.id ?? null },
      });
    }
    if (g.verdict === "SUPERSEDE" && c) {
      b.push({ action: "proposal.supersede", label: "Mark superseded by cited", kind: "primary", params: { cites: c.id } });
    }
    if (g.verdict === "RELATE" && c) {
      b.push({ action: "proposal.relate", label: "Link the two", kind: "primary", params: { cites: c.id, kind: "refines" } });
    }
    if (g.verdict !== "ARCHIVE" && c) {
      // Offered for every other verdict, PROPOSE included: a consolidation proposal is
      // most often answered by retiring the weaker row in favour of the cited one.
      b.push({ action: "proposal.archive", label: "Archive in favour of cited", params: { reason: "superseded_by", cites: c.id } });
    }
    if (g.verdict !== "SUPERSEDE" && g.verdict !== "RELATE" && c) {
      b.push({ action: "proposal.relate", label: "Just link them", params: { cites: c.id, kind: "refines" } });
    }
  }
  b.push({ action: "proposal.done", label: "I handled it", params: {} });
  b.push({ action: "proposal.dismiss", label: g.verdict === "ARCHIVE" ? "Keep it — dismiss" : "Dismiss", params: {} });
  return b;
}

export function buildProposals(): { open: ProposalGroup[]; obsolete: ProposalGroup[]; noop: ProposalGroup[] } {
  const groups = new Map<string, { rows: (CurationAction & { run_started_at: string })[] }>();
  for (const a of listOpenProposals()) {
    const key = `${a.memory_id}|${a.verdict}|${a.cites ?? ""}`;
    const g = groups.get(key) ?? { rows: [] };
    g.rows.push(a);
    groups.set(key, g);
  }

  const open: ProposalGroup[] = [];
  const obsolete: ProposalGroup[] = [];
  const noop: ProposalGroup[] = [];

  for (const [key, { rows }] of groups) {
    const latest = rows[rows.length - 1];
    const memory = getMemoryById(latest.memory_id);
    const cited = latest.cites ? getMemoryById(latest.cites) : null;
    const exclude = new Set([latest.memory_id, latest.cites ?? ""]);
    const base = {
      key,
      action_ids: rows.map((r) => r.id),
      verdict: latest.verdict,
      reason: latest.reason,
      rationale: latest.rationale,
      times: rows.length,
      first_seen: rows[0].created_at,
      last_seen: latest.created_at,
      memory: card(memory),
      cites: card(cited),
      similarity: memory && cited ? Number(memorySimilarity(memory, cited).toFixed(2)) : null,
      mentioned: resolveMentioned(latest.rationale, exclude),
    };

    // The question no longer has an answer to give: the row is gone or already
    // archived, or the row it would be archived in favour of has itself gone.
    const linked = (latest.verdict === "RELATE" || latest.verdict === "SUPERSEDE") && latest.cites !== null
      && getRelations(latest.memory_id).some((r) => r.from_id === latest.cites || r.to_id === latest.cites);
    const gone = !memory || memory.archived_at !== null || linked
      || (latest.verdict === "ARCHIVE" && latest.cites !== null && (!cited || cited.archived_at !== null));
    if (gone) {
      obsolete.push({ ...base, buttons: [{ action: "proposal.dismiss", label: "Clear", params: { note: "obsolete" } }] });
      continue;
    }
    // Dry runs before 2026-10-15 recorded every decision as a proposal under its real
    // verdict. A live run never proposes these three: it applies them or refuses them.
    // KEEP asks for nothing, and RETAG / NOTE cannot be replayed because the ledger
    // never stored the tags or the note text — only the rationale.
    if (latest.verdict === "KEEP" || latest.verdict === "RETAG" || latest.verdict === "NOTE") {
      noop.push({ ...base, buttons: [{ action: "proposal.dismiss", label: "Clear", params: { note: "no-op" } }] });
      continue;
    }
    open.push({ ...base, buttons: proposalButtons(base) });
  }

  // Removals first — they are the ones with a cost if left — then most-repeated.
  const rank = (g: ProposalGroup): number => (g.verdict === "ARCHIVE" ? 0 : g.verdict === "PROPOSE" ? 1 : 2);
  open.sort((a, b) => rank(a) - rank(b) || b.times - a.times || a.first_seen.localeCompare(b.first_seen));
  return { open, obsolete, noop };
}

export function buildAttention(canariesFile: string | null): AttentionItem[] {
  const items: AttentionItem[] = [];
  const runs = listCurationRuns(30);

  if (getState("last_run_failed") === "1") {
    const lastFailed = runs.find((r) => r.status === "failed");
    items.push({
      key: "latch",
      level: "critical",
      title: "The curator is halted — a previous run failed",
      detail: `It will refuse every scheduled run until this is cleared.${lastFailed ? ` Last failure (${lastFailed.started_at}): ${lastFailed.notes ?? "no notes"}` : ""} Clear it once you know why it failed; undo the run first if its changes look wrong.`,
      buttons: [
        { action: "state.clearLatch", label: "Resume the curator", kind: "primary" },
        ...(lastFailed ? [{
          action: "run.undo", label: "Undo that run", kind: "danger" as const,
          params: { run_id: lastFailed.id }, confirm: "Revert every change that run made?",
        }] : []),
      ],
    });
  }

  for (const r of runs) {
    if (r.status !== "running") continue;
    const ageMin = (Date.now() - Date.parse(r.started_at.replace(" ", "T"))) / 60_000;
    if (ageMin < 120) continue;
    items.push({
      key: `stuck:${r.id}`,
      level: "warning",
      title: `A ${r.mode} run has said "running" for ${Math.round(ageMin / 60)}h`,
      detail: `Started ${r.started_at}. The process almost certainly died without closing its run.`,
      buttons: [{ action: "run.markFailed", label: "Mark it failed", kind: "primary", params: { run_id: r.id } }],
    });
  }

  const actor = getCurationActor();
  if (actor.actor === "curator" && !runs.some((r) => r.status === "running")) {
    items.push({
      key: "actor",
      level: "warning",
      title: "The curator's guard claim was never released",
      detail: "No run is in progress, but the database still believes the curator is writing. Every write is being judged by the curator's guards and attributed to its run.",
      buttons: [{ action: "state.releaseActor", label: "Release it", kind: "primary" }],
    });
  }

  const fts = ftsIntegrityCheck();
  if (!fts.ok) {
    items.push({
      key: "fts",
      level: "critical",
      title: "The search index is inconsistent with the rows",
      detail: fts.error ?? "",
      buttons: [{ action: "fts.rebuild", label: "Rebuild the index", kind: "primary" }],
    });
  }

  const trailing = checkTrailingInvariants();
  if (!trailing.ok) {
    items.push({
      key: "erosion",
      level: "critical",
      title: "The store has shrunk faster than the curator is allowed to shrink it",
      detail: trailing.violations.join("; "),
      buttons: runs[0] ? [{
        action: "run.undo", label: "Undo the latest run", kind: "danger",
        params: { run_id: runs[0].id }, confirm: "Revert every change the latest run made?",
      }] : [],
    });
  }

  if (canariesFile && existsSync(canariesFile)) {
    const baseline = loadBaseline();
    if (baseline) {
      const diff = diffCanaries(baseline, runCanaries(loadCanaries(canariesFile)));
      if (diff.changed.length && !acked(`canary:${diff.changed.map((c) => `${c.name}=${c.now.join(",")}`).join(";")}`)) {
        items.push({
          key: "canary",
          level: "warning",
          title: `${diff.changed.length} pinned ${diff.changed.length === 1 ? "query returns" : "queries return"} different top results`,
          detail: diff.changed.map((c) => `"${c.name}": was [${c.was.map((x) => x.slice(0, 8)).join(", ")}] now [${c.now.map((x) => x.slice(0, 8)).join(", ")}]`).join(" · "),
          memories: [...new Set(diff.changed.flatMap((c) => [...c.was, ...c.now]))],
          buttons: [{ action: "canary.accept", label: "These results are right — new baseline", kind: "primary" }],
        });
      }
    }
  }

  // An archive of something written less than a month ago is the shape a wrong
  // duplicate call takes: two fresh entries that look alike and are not.
  for (const a of listRecentActions("applied", 14)) {
    if (a.verdict !== "ARCHIVE" || a.resolution === "undone" || acked(`young:${a.id}`)) continue;
    const m = getMemoryById(a.memory_id);
    if (!m || !m.archived_at) continue;
    if (Date.parse(m.created_at.replace(" ", "T")) < Date.parse(a.created_at.replace(" ", "T")) - 30 * 86_400_000) continue;
    items.push({
      key: `young:${a.id}`,
      level: "warning",
      title: "Archived an entry less than 30 days old",
      detail: `"${m.title}" — ${a.rationale ?? ""}`,
      memories: [a.memory_id, ...(a.cites ? [a.cites] : [])],
      buttons: [
        { action: "change.undo", label: "Restore it", kind: "primary", params: { action_id: a.id } },
        { action: "ack", label: "The archive is right", params: { key: `young:${a.id}` } },
      ],
    });
  }

  for (const a of listRecentActions("refused", 14)) {
    if (acked(`refused:${a.id}`)) continue;
    const m = getMemoryById(a.memory_id);
    items.push({
      key: `refused:${a.id}`,
      level: "info",
      title: `A guard refused a ${a.verdict}`,
      detail: `${m ? `"${m.title}" — ` : ""}${a.rationale ?? ""}`,
      memories: [a.memory_id],
      buttons: [{ action: "ack", label: "Seen it", params: { key: `refused:${a.id}` } }],
    });
  }

  const last = getState("last_success_date");
  if (last) {
    const days = Math.floor((Date.now() - Date.parse(`${last}T00:00:00`)) / 86_400_000);
    if (days > 2) {
      items.push({
        key: "silent",
        level: "warning",
        title: `No successful curator run for ${days} days`,
        detail: `Last success: ${last}. Check curator/state/logs/curator.log, or run: bash scripts/run-curator.sh nightly`,
        buttons: [],
      });
    }
  }

  const order = { critical: 0, warning: 1, info: 2 };
  return items.sort((a, b) => order[a.level] - order[b.level]);
}

export interface ChangeRow {
  action_id: string;
  run_id: string;
  verdict: string;
  created_at: string;
  rationale: string | null;
  undone: boolean;
  memory: MemoryCard | null;
  cites: MemoryCard | null;
  buttons: ButtonSpec[];
}

export function buildRecentChanges(days = 14): ChangeRow[] {
  return listRecentActions("applied", days)
    .filter((a) => MUTATING.has(a.verdict))
    .map((a) => {
      const undone = a.resolution === "undone";
      return {
        action_id: a.id, run_id: a.run_id, verdict: a.verdict, created_at: a.created_at,
        rationale: a.rationale, undone,
        memory: card(getMemoryById(a.memory_id)),
        cites: card(a.cites ? getMemoryById(a.cites) : null),
        buttons: undone ? [] : [{
          action: "change.undo", label: a.verdict === "ARCHIVE" ? "Restore" : "Undo", kind: "plain" as const,
          params: { action_id: a.id },
        }],
      };
    });
}

export function buildRuns(limit = 30) {
  return listCurationRuns(limit).map((r) => ({
    ...r,
    buttons: r.status === "ok" || r.status === "failed" ? [{
      action: "run.undo", label: "Undo whole run", kind: "danger" as const,
      params: { run_id: r.id }, confirm: `Revert every change the ${r.mode} run of ${r.started_at} made? Rows edited since are skipped.`,
    }] : [],
  }));
}

export function buildMemory(id: string) {
  const m = getMemoryById(id);
  if (!m) return null;
  const relations = getRelations(id).map((r) => {
    const other = r.from_id === id ? r.to_id : r.from_id;
    return {
      ...r,
      direction: r.from_id === id ? "out" : "in",
      other: card(getMemoryById(other)),
    };
  });
  const revisions = getDb()
    .prepare("SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY changed_at DESC LIMIT 20")
    .all(id);
  return { memory: m, relations, revisions };
}

export function buildOverview(canariesFile: string | null) {
  const stats = memoryStats();
  const runs = listCurationRuns(1);
  const proposals = buildProposals();
  return {
    generated_at: new Date().toISOString(),
    stats,
    last_run: runs[0] ?? null,
    last_success_date: getState("last_success_date"),
    halted: getState("last_run_failed") === "1",
    attention: buildAttention(canariesFile),
    proposals,
    changes: buildRecentChanges(),
    runs: buildRuns(),
  };
}
