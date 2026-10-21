import { existsSync } from "node:fs";
import {
  ftsIntegrityCheck, getCurationActor, getDb, getMemoryById, getRelations,
  getState, listCurationRuns, listDamagedMemories, listOpenProposals, listRecentActions, memoryStats,
} from "../db.js";
import { checkTrailingInvariants } from "../curation/apply.js";
import { diffCanaries, loadBaseline, loadCanaries, runCanaries } from "../curation/canary.js";
import { memorySimilarity } from "../curation/similarity.js";
import { planRepair } from "./repair.js";
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

function card(m: MemoryEntry | null): MemoryCard | null {
  if (!m) return null;
  return {
    id: m.id, title: m.title, type: m.type, severity: m.severity, area: m.area, project: m.project,
    archived_at: m.archived_at, superseded_by: m.superseded_by, created_at: m.created_at, updated_at: m.updated_at,
  };
}

/** Full ids, and the 8-hex short form the curator likes to write in prose. */
const ID_PATTERN = /\b[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/g;

function ackKey(key: string): string {
  return `ack:${key}`;
}

function acked(key: string): boolean {
  return getState(ackKey(key)) !== null;
}

export { ackKey };

// ---- Proposals, regrouped by the job they ask of you.
//
// The ledger holds one row per note the curator wrote, and the first version of this
// page showed exactly that: one card per note. On the real store that was fifty cards
// in which ten asked for the same merge, six reported the same write bug, and a third
// asked for nothing at all — the curator explaining why it had KEPT an entry. So the
// notes are sorted by what they want done, notes about the same job are folded into
// one card, and every card leads with what it wants and why it could not do it itself.

export type DecisionKind = "duplicate" | "merge" | "repair" | "link" | "other";

export interface EntryView extends MemoryCard {
  snippet: string;
  /** Repair cards: what is wrong with this row. */
  problems?: string[];
  /** Repair cards: null when the dashboard can fix it itself, else why it cannot. */
  manual?: string | null;
  /** Merge cards: word overlap with the suggested main entry, 0–1. */
  overlap?: number;
  /** Merge cards: ticked to fold by default. Low-overlap entries a note merely named are not. */
  fold?: boolean;
}

export interface CuratorNote {
  date: string;
  about: string | null;
  text: string;
}

export interface DecisionCard {
  key: string;
  kind: DecisionKind;
  /** What it wants, in one line. */
  headline: string;
  /** Why it is asking you instead of doing it. */
  why: string;
  entries: EntryView[];
  /** Merge cards: the entry the notes most often name as the one to keep. */
  suggested_main: string | null;
  similarity: number | null;
  notes: CuratorNote[];
  action_ids: string[];
  times: number;
  first_seen: string;
  last_seen: string;
  buttons: ButtonSpec[];
}

export interface QuietGroup {
  key: string;
  verdict: string;
  action_ids: string[];
  last_seen: string;
  memory: MemoryCard | null;
  text: string | null;
}

export interface DecisionQueue {
  sections: Record<DecisionKind, DecisionCard[]>;
  /** Notes that ask for nothing: the curator explaining a KEEP under the PROPOSE label. */
  explain: QuietGroup[];
  /** Links waiting for the next curator run, which applies them without asking. */
  queuedLinks: QuietGroup[];
  obsolete: QuietGroup[];
  dryrun: QuietGroup[];
  total: number;
}

type OpenRow = ReturnType<typeof listOpenProposals>[number];

/**
 * Words that ask something of a reader. Deliberately narrow: "merged", "flagged" and
 * "fold" turn up in plain description ("the merged-but-not-live family", "already
 * flagged in its own first line") and made explanations read as requests.
 */
const ASKS = /\b(propos(?:e|es|ing|al)|suggest(?:s|ed|ion)?|recommend\w*|a human (?:should|must|consolidat\w*|picks?)|human should|should (?:look|be)|worth fixing|backfill|re-?raise)\b/i;
const MERGE = /\b(consolidat\w*|merge|merging|fold(?:ing)? (?:into|the)|canonical|re-?stor(?:ed|e of)|re-?learn\w*|near-identical|same gotcha|re-record\w*|true (?:re-learned )?duplicate)\b/i;
const REPAIR = /(swallow|markup|parameter name=|leak\w*|malformed|serializ|field-boundary|tags\s*=\s*NULL|tags NULL|lost their tags|tag list|ended up inside|write-path|write bug|writer-side|ingest defect|code example ended)/i;

function snippetOf(m: MemoryEntry): string {
  const body = (m.symptom ?? "").replace(/\s+/g, " ").trim();
  return body.length > 220 ? `${body.slice(0, 220)}…` : body;
}

function entryView(m: MemoryEntry): EntryView {
  return { ...card(m)!, snippet: snippetOf(m) };
}

function short(title: string, n = 70): string {
  return title.length > n ? `${title.slice(0, n)}…` : title;
}

/** The sentence of a rationale that actually asks for something, when no `ask` was written. */
function extractAsk(text: string): string | null {
  const sentences = text.split(/(?<=[.;])\s+(?=[A-Z])/);
  const hit = sentences.find((s) => ASKS.test(s));
  return hit ? hit.trim() : null;
}

/** Ids a note names, resolved to rows; short prefixes count only when unambiguous. */
function namedRows(text: string | null): MemoryEntry[] {
  if (!text) return [];
  const byPrefix = getDb().prepare("SELECT * FROM memories WHERE id LIKE ? LIMIT 2");
  const out = new Map<string, MemoryEntry>();
  for (const token of new Set(text.match(ID_PATTERN) ?? [])) {
    const rows = token.length === 36
      ? [getMemoryById(token)].filter(Boolean) as MemoryEntry[]
      : (byPrefix.all(`${token}%`) as MemoryEntry[]);
    if (rows.length === 1) out.set(rows[0].id, rows[0]);
  }
  return [...out.values()];
}

function whyArchive(row: OpenRow, similarity: number | null): string {
  if ((row.run_notes ?? "").startsWith("backfill")) {
    return "It came from the one-time backlog pass, which never removes anything without you.";
  }
  if (row.reason === "stale" || row.reason === "no_longer_relevant") {
    return "\"Stale\" is a judgement no check can confirm, so the curator never archives for that reason on its own.";
  }
  if (row.reason === "duplicate_of" && similarity !== null && similarity < 0.9) {
    return `The two overlap ${Math.round(similarity * 100)}%. It only archives on its own above 90%, because entries that look alike often describe different situations.`;
  }
  return "It had used up its limit of archives for the night or the month.";
}

function noteOf(row: OpenRow): CuratorNote {
  const m = getMemoryById(row.memory_id);
  return { date: row.created_at.slice(0, 10), about: m?.title ?? null, text: row.ask ? `${row.ask}\n\n${row.rationale ?? ""}` : row.rationale ?? "" };
}

function span(rows: OpenRow[]): Pick<DecisionCard, "action_ids" | "times" | "first_seen" | "last_seen" | "notes"> {
  const sorted = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
  // A note asked on several nights is one question; count the passes, show the latest.
  const nights = new Set(sorted.map((r) => r.run_id));
  const latestPerKey = new Map<string, OpenRow>();
  for (const r of sorted) latestPerKey.set(`${r.memory_id}|${r.verdict}`, r);
  return {
    action_ids: sorted.map((r) => r.id),
    times: nights.size,
    first_seen: sorted[0].created_at,
    last_seen: sorted[sorted.length - 1].created_at,
    notes: [...latestPerKey.values()].map(noteOf),
  };
}

function quiet(rows: OpenRow[]): QuietGroup[] {
  const groups = new Map<string, OpenRow[]>();
  for (const r of rows) {
    const k = `${r.memory_id}|${r.verdict}|${r.cites ?? ""}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.entries()].map(([key, rs]) => {
    const last = rs[rs.length - 1];
    return {
      key, verdict: last.verdict, action_ids: rs.map((r) => r.id), last_seen: last.created_at,
      memory: card(getMemoryById(last.memory_id)), text: last.ask ?? last.rationale,
    };
  });
}

/**
 * Title-word overlap with the main entry at or above which a merge row starts ticked.
 * Titles, not whole bodies: copies of one lesson are titled alike and differ in the
 * war story underneath, so body overlap ranked an unrelated entry above a true copy.
 */
const MERGE_TICK = 0.1;

const STOP = new Set(["the", "and", "for", "with", "not", "but", "from", "that", "this", "its", "are", "pass", "always", "every"]);
function titleWords(t: string): Set<string> {
  return new Set(t.toLowerCase().split(/[^a-z0-9_.-]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
}
function titleSimilarity(a: string, b: string): number {
  const x = titleWords(a), y = titleWords(b);
  let inter = 0;
  for (const w of x) if (y.has(w)) inter++;
  return inter / Math.max(1, x.size + y.size - inter);
}

function buildMergeCards(rows: OpenRow[]): { cards: DecisionCard[]; loners: OpenRow[] } {
  // Two notes are about the same merge when they name at least two of the same entries.
  const ids = rows.map((r) => new Set([r.memory_id, ...namedRows(`${r.ask ?? ""} ${r.rationale ?? ""}`).map((m) => m.id)]));
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      let shared = 0;
      for (const id of ids[i]) if (ids[j].has(id)) shared++;
      // Two shared entries, or — for a note that names nobody but itself — its own entry
      // being part of the other note's group.
      if (shared >= Math.min(2, ids[i].size, ids[j].size)) parent[find(i)] = find(j);
    }
  }
  const clusters = new Map<number, number[]>();
  rows.forEach((_, i) => clusters.set(find(i), [...(clusters.get(find(i)) ?? []), i]));

  const cards: DecisionCard[] = [];
  const loners: OpenRow[] = [];
  for (const members of clusters.values()) {
    const mrows0 = members.map((i) => rows[i]);
    const span0 = new Set(members.flatMap((i) => [...ids[i]]));
    // A "merge" that names only its own entry has nothing to merge with on this page.
    if (span0.size < 2) { loners.push(...mrows0); continue; }
    cards.push(mergeCard(members));
  }
  return { cards, loners };

  function mergeCard(members: number[]): DecisionCard {
    const mrows = members.map((i) => rows[i]);
    const all = new Set(members.flatMap((i) => [...ids[i]]));
    const entries = [...all].map((id) => getMemoryById(id)).filter(Boolean) as MemoryEntry[];
    entries.sort((a, b) => a.created_at.localeCompare(b.created_at));

    // The entry the notes put forward as the keeper: named in a sentence about keeping,
    // canonicalising or folding into, most often. Falls back to the most-named entry.
    const keepVotes = new Map<string, number>();
    const anyVotes = new Map<string, number>();
    for (const r of mrows) {
      const text = `${r.ask ?? ""} ${r.rationale ?? ""}`;
      for (const s of text.split(/(?<=[.;:—])\s+/)) {
        const named = namedRows(s);
        const keeps = /\b(canonical|keep|onto|into|under it|under|survivor|best of them|most (?:complete|current))\b/i.test(s);
        for (const m of named) {
          anyVotes.set(m.id, (anyVotes.get(m.id) ?? 0) + 1);
          if (keeps && named.length <= 2) keepVotes.set(m.id, (keepVotes.get(m.id) ?? 0) + 1);
        }
      }
    }
    const top = (votes: Map<string, number>): string | null =>
      [...votes.entries()].filter(([id]) => entries.some((e) => e.id === id && !e.archived_at))
        .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const main = top(keepVotes) ?? top(anyVotes) ?? entries.filter((e) => !e.archived_at).at(-1)?.id ?? null;
    const mainRow = entries.find((e) => e.id === main);
    const active = entries.filter((e) => !e.archived_at).length;
    // A note's list of "the same gotcha" ids is not always right — one named the CI
    // checks entry among the gh-repo copies. Overlap with the main entry is shown on
    // each row, and only rows that clearly share its words start ticked.
    const views: EntryView[] = entries.map((e) => {
      const overlap = mainRow && e.id !== mainRow.id ? Number(titleSimilarity(e.title, mainRow.title).toFixed(2)) : 1;
      return { ...entryView(e), overlap, fold: e.id !== main && !e.archived_at && overlap >= MERGE_TICK };
    });
    views.sort((a, b) => (a.id === main ? -1 : b.id === main ? 1 : (b.overlap ?? 0) - (a.overlap ?? 0)));

    return {
      key: `merge:${mrows[0].id}`,
      kind: "merge" as const,
      headline: `${active} entries teach the same lesson${mainRow ? `: “${short(mainRow.title)}”` : ""}`,
      why: "Merging means choosing which details survive. The curator never does that on its own, and it could read only some of these in full.",
      entries: views,
      suggested_main: main,
      similarity: null,
      ...span(mrows),
      buttons: [
        { action: "merge.apply", label: "Keep the main one, mark the rest as replaced by it", kind: "primary", params: { mode: "supersede" } },
        { action: "merge.apply", label: "Keep the main one, archive the rest", kind: "danger", params: { mode: "archive" }, confirm: "Archive every unticked entry in favour of the main one?" },
        { action: "proposal.done", label: "I merged them myself" },
        { action: "proposal.dismiss", label: "Leave them as they are" },
      ],
    };
  }
}

export function buildDecisions(): DecisionQueue {
  const sections: Record<DecisionKind, DecisionCard[]> = { duplicate: [], merge: [], repair: [], link: [], other: [] };
  const explain: OpenRow[] = [];
  const queuedLinks: OpenRow[] = [];
  const obsolete: OpenRow[] = [];
  const dryrun: OpenRow[] = [];
  const merges: OpenRow[] = [];
  const repairs: OpenRow[] = [];
  const archives = new Map<string, OpenRow[]>();
  const links = new Map<string, OpenRow[]>();
  const others = new Map<string, OpenRow[]>();

  for (const r of listOpenProposals()) {
    const memory = getMemoryById(r.memory_id);
    const cited = r.cites ? getMemoryById(r.cites) : null;
    const text = `${r.ask ?? ""} ${r.rationale ?? ""}`;
    const linked = (r.verdict === "RELATE" || r.verdict === "SUPERSEDE") && r.cites !== null
      && getRelations(r.memory_id).some((x) => x.from_id === r.cites || x.to_id === r.cites);

    if (!memory || linked
      || (r.verdict === "ARCHIVE" && (memory.archived_at !== null || (r.cites !== null && (!cited || cited.archived_at !== null))))) {
      obsolete.push(r);
    } else if (r.verdict === "KEEP" || r.verdict === "RETAG" || r.verdict === "NOTE") {
      // Dry runs before 2026-10-15 recorded these as proposals. KEEP asks for nothing;
      // RETAG and NOTE cannot be replayed because the tags and note text were never stored.
      dryrun.push(r);
    } else if (r.verdict === "ARCHIVE") {
      const k = `${r.memory_id}|${r.cites ?? ""}`;
      archives.set(k, [...(archives.get(k) ?? []), r]);
    } else if (r.verdict === "RELATE") {
      // Not a decision: the next live run applies it (settleLinkProposals).
      queuedLinks.push(r);
    } else if (r.verdict === "SUPERSEDE") {
      const k = `${r.memory_id}|${r.cites}|${r.verdict}`;
      links.set(k, [...(links.get(k) ?? []), r]);
    } else if (REPAIR.test(text)) {
      repairs.push(r);
    } else if (MERGE.test(text) && ASKS.test(text)) {
      merges.push(r);
    } else if (r.ask || ASKS.test(text)) {
      const k = r.memory_id;
      others.set(k, [...(others.get(k) ?? []), r]);
    } else {
      explain.push(r);
    }
  }

  for (const [, rows] of archives) {
    const last = rows[rows.length - 1];
    const m = getMemoryById(last.memory_id)!;
    const c = last.cites ? getMemoryById(last.cites) : null;
    const sim = c ? Number(memorySimilarity(m, c).toFixed(2)) : null;
    sections.duplicate.push({
      key: `dup:${last.id}`,
      kind: "duplicate",
      headline: c ? `Archive “${short(m.title)}” — “${short(c.title)}” already covers it` : `Archive “${short(m.title)}” (${(last.reason ?? "").replace(/_/g, " ")})`,
      why: whyArchive(last, sim),
      entries: [entryView(m), ...(c ? [entryView(c)] : [])],
      suggested_main: c?.id ?? null,
      similarity: sim,
      ...span(rows),
      buttons: [
        { action: "proposal.archive", label: c ? "Archive it, keep the other" : "Archive it", kind: "primary", params: { memory_id: m.id, reason: last.reason ?? (c ? "duplicate_of" : "no_longer_relevant"), cites: c?.id ?? null } },
        ...(c ? [{ action: "proposal.relate", label: "Keep both, link them", params: { memory_id: m.id, cites: c.id, kind: "refines" } }] : []),
        { action: "proposal.dismiss", label: "Keep both" },
      ],
    });
  }

  const merged = buildMergeCards(merges);
  sections.merge = merged.cards;
  for (const r of merged.loners) others.set(r.memory_id, [...(others.get(r.memory_id) ?? []), r]);

  const damaged = listDamagedMemories();
  if (damaged.length || repairs.length) {
    const rows = damaged.map((d) => {
      const m = getMemoryById(d.id)!;
      return { ...entryView(m), problems: d.problems, manual: planRepair(m).manual };
    });
    const auto = rows.filter((r) => !r.manual).length;
    sections.repair.push({
      key: "repair",
      kind: "repair",
      headline: damaged.length
        ? `${damaged.length} ${damaged.length === 1 ? "entry was" : "entries were"} saved broken — text from one field spilled into another, or the tags were lost`
        : "The curator reported broken entries, but none are broken any more",
      why: "Fixing them means rewriting an entry's symptom or code, which the curator is never allowed to do. "
        + (auto ? `${auto} can be repaired here mechanically — the spilled text is moved back into its own field, nothing is reworded, and every change can be undone. ` : "")
        + "This list is read from the entries themselves and shrinks as they are fixed.",
      entries: rows,
      suggested_main: null,
      similarity: null,
      ...(repairs.length ? span(repairs) : { action_ids: [], times: 0, first_seen: "", last_seen: "", notes: [] }),
      buttons: [
        ...(auto ? [{ action: "repair.applyAll", label: `Repair all ${auto} automatically`, kind: "danger" as const,
          confirm: `Move the spilled text back into its own field on ${auto} entries?` }] : []),
        ...(repairs.length ? [{ action: "proposal.done", label: "Clear the curator's notes about this", params: { note: "repair list" } }] : []),
      ],
    });
  }

  for (const [, rows] of links) {
    const last = rows[rows.length - 1];
    const m = getMemoryById(last.memory_id)!;
    const c = getMemoryById(last.cites!)!;
    if (!c) { obsolete.push(...rows); continue; }
    const sup = last.verdict === "SUPERSEDE";
    sections.link.push({
      key: `link:${last.id}`,
      kind: "link",
      headline: sup ? `Mark “${short(m.title)}” as replaced by “${short(c.title)}”` : `Link “${short(m.title)}” ↔ “${short(c.title)}”`,
      why: "Suggested during a trial run, before the curator was allowed to make changes, so it was never applied.",
      entries: [entryView(m), entryView(c)],
      suggested_main: null,
      similarity: Number(memorySimilarity(m, c).toFixed(2)),
      ...span(rows),
      buttons: [
        sup
          ? { action: "proposal.supersede", label: "Mark replaced", kind: "primary", params: { memory_id: m.id, cites: c.id } }
          : { action: "proposal.relate", label: "Link them", kind: "primary", params: { memory_id: m.id, cites: c.id, kind: "refines" } },
        { action: "proposal.dismiss", label: "Skip" },
      ],
    });
  }

  for (const [, rows] of others) {
    const last = rows[rows.length - 1];
    const m = getMemoryById(last.memory_id)!;
    const text = last.rationale ?? "";
    sections.other.push({
      key: `other:${last.id}`,
      kind: "other",
      headline: last.ask ?? extractAsk(text) ?? short(text, 160),
      why: "None of the curator's own actions can do this, so it is asking you.",
      entries: [entryView(m), ...namedRows(`${last.ask ?? ""} ${text}`).filter((x) => x.id !== m.id).map(entryView)],
      suggested_main: null,
      similarity: null,
      ...span(rows),
      buttons: [
        { action: "proposal.done", label: "Done", kind: "primary" },
        { action: "proposal.dismiss", label: "Not worth doing" },
      ],
    });
  }

  const total = Object.values(sections).reduce((n, s) => n + s.length, 0);
  return { sections, explain: quiet(explain), queuedLinks: quiet(queuedLinks), obsolete: quiet(obsolete), dryrun: quiet(dryrun), total };
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
  const proposals = buildDecisions();
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
