import {
  getCurationActions, getCurationRun, getMemoryById, getRevisionsForRun, memoryStats,
} from "../db.js";
import { checkTrailingInvariants } from "./apply.js";
import type { CanaryDiff } from "./canary.js";

/**
 * The morning report, derived from the ledger and the revision history — never from
 * the model's own account of what it did. A run that died after four of nine clusters
 * can still narrate a confident summary; these numbers cannot.
 *
 * Built around one question, because once the curator applies its own decisions that
 * is the only question a reader has: WHAT DID IT CHANGE? So a verdict that mutates a
 * row and a verdict that leaves it exactly as it was are reported separately and
 * counted separately. They used to share a single "applied" bucket, where twenty
 * KEEPs buried the two archives that actually touched the corpus — the one shape of
 * report that trains you to stop opening it.
 */

/** Verdicts that leave the row different from how they found it. KEEP does not. */
const MUTATING = new Set(["RETAG", "NOTE", "RELATE", "SUPERSEDE", "ARCHIVE"]);

export interface ActionDetail {
  memory_id: string;
  verdict: string;
  /** What actually happened, as applyDecisions recorded it: "archived in favour of X". */
  detail: string;
  tier?: string;
}

export function renderReport(opts: {
  runId: string;
  canaries: CanaryDiff | null;
  before: { active: number; prose_bytes: number };
  ftsOk: boolean;
  /** Every decision's outcome, all tiers — the concrete effect behind each verdict. */
  details: ActionDetail[];
}): { markdown: string; headline: string; notable: boolean; changed: number } {
  const run = getCurationRun(opts.runId);
  const actions = getCurationActions(opts.runId);
  const revisions = getRevisionsForRun(opts.runId);
  const now = memoryStats();
  const trailing = checkTrailingInvariants();

  const applied = actions.filter((a) => a.tier === "applied");
  const changed = applied.filter((a) => MUTATING.has(a.verdict));
  const kept = applied.filter((a) => !MUTATING.has(a.verdict));
  const proposed = actions.filter((a) => a.tier === "proposed");
  const refused = actions.filter((a) => a.tier === "refused");
  const archived = changed.filter((a) => a.verdict === "ARCHIVE");
  const changedRows = new Set(revisions.map((r) => r.memory_id));

  const detailFor = (memoryId: string): string | undefined =>
    opts.details.find((d) => d.memory_id === memoryId)?.detail;

  const pct = (a: number, b: number): string => (b === 0 ? "0.0%" : `${(((a - b) / b) * 100).toFixed(1)}%`);
  const kb = (n: number): string => `${(n / 1024).toFixed(0)}KB`;

  const canaryLine = opts.canaries
    ? `${opts.canaries.stable}/${opts.canaries.total} canaries stable`
    : "canaries not configured";

  const headline =
    `active ${opts.before.active}→${now.active} | prose ${kb(opts.before.prose_bytes)}→${kb(now.prose_bytes)} `
    + `(${pct(now.prose_bytes, opts.before.prose_bytes)}) | fts ${opts.ftsOk ? "PASS" : "FAIL"} | `
    + `${changed.length} changed, ${archived.length} archived, ${kept.length} kept, `
    + `${proposed.length} to review, ${refused.length} refused | ${canaryLine}`;

  // Computed, not judged. Each of these is a shape that an individually reasonable
  // action takes when it is going wrong.
  const flags: string[] = [];
  if (!opts.ftsOk) flags.push("**FTS integrity check FAILED** — the search index is inconsistent.");
  if (!trailing.ok) for (const v of trailing.violations) flags.push(`**Trailing-window invariant**: ${v}`);
  if (opts.canaries?.changed.length) {
    for (const c of opts.canaries.changed) {
      flags.push(`Canary \`${c.name}\` moved: was [${c.was.join(", ")}] now [${c.now.join(", ")}]`);
    }
  }
  for (const a of archived) {
    const m = getMemoryById(a.memory_id);
    if (m && Date.parse(m.created_at) > Date.now() - 30 * 86_400_000) {
      flags.push(`Archived a memory less than 30 days old: \`${a.memory_id}\` — ${m.title}`);
    }
  }
  for (const id of changedRows) {
    const m = getMemoryById(id);
    if (m && m.curator_edit_count >= 2) flags.push(`\`${id}\` has now been curated twice and is frozen.`);
  }

  const lines: string[] = [];
  lines.push(`# Memory curation — ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push(`\`${headline}\``);
  lines.push("");
  lines.push(`Run \`${opts.runId}\` (${run?.mode ?? "?"}), window ${run?.window_from ?? "—"} → ${run?.window_to ?? "—"}, status **${run?.status ?? "?"}**.`);
  lines.push("");

  if (flags.length) {
    lines.push("## ⚠ Red flags");
    lines.push("");
    for (const f of flags) lines.push(`- ${f}`);
    lines.push("");
  }

  // THE SECTION THIS REPORT EXISTS FOR. First after the flags, and present even when
  // it is empty — "nothing was changed" is the answer on most nights and has to be
  // stated, not inferred from a missing heading.
  lines.push("## What changed");
  lines.push("");
  if (changed.length === 0 && kept.length === 0 && proposed.length > 0) {
    // A dry run lands here: every decision was recorded under its real verdict but
    // nothing was applied, so "0 entries were reviewed" would be both true and
    // thoroughly misleading with a page of proposals underneath it.
    lines.push(`Nothing was applied. All ${proposed.length} decisions below are proposals.`);
    lines.push("");
  } else if (changed.length === 0) {
    lines.push(`Nothing. ${kept.length} ${kept.length === 1 ? "entry was" : "entries were"} reviewed and left exactly as they were.`);
    lines.push("");
  } else {
    for (const a of changed) {
      const m = getMemoryById(a.memory_id);
      lines.push(`- **${a.verdict}** \`${a.memory_id}\` — ${m?.title ?? "(gone)"}`);
      const what = detailFor(a.memory_id);
      if (what) lines.push(`  - ${what}`);
      if (a.cites) lines.push(`  - cites \`${a.cites}\``);
      if (a.rationale) lines.push(`  - ${a.rationale}`);
    }
    lines.push("");
  }

  if (kept.length) {
    lines.push("## Reviewed, left alone");
    lines.push("");
    lines.push(`<details><summary>${kept.length} ${kept.length === 1 ? "entry" : "entries"} read and found correct</summary>`);
    lines.push("");
    for (const a of kept) {
      const m = getMemoryById(a.memory_id);
      lines.push(`- \`${a.memory_id}\` — ${m?.title ?? "(gone)"}`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  if (proposed.length) {
    lines.push("## Proposals — not applied");
    lines.push("");
    lines.push("These needed a judgement no predicate can make, so they are yours.");
    lines.push("");
    for (const p of proposed) {
      const m = getMemoryById(p.memory_id);
      const why = detailFor(p.memory_id);
      lines.push(`- **${p.verdict}** \`${p.memory_id}\` — ${m?.title ?? "(gone)"}`);
      if (why) lines.push(`  - ${why}`);
      if (p.cites) lines.push(`  - cites \`${p.cites}\``);
      if (p.rationale) lines.push(`  - ${p.rationale}`);
    }
    lines.push("");
  }

  if (refused.length) {
    lines.push("## Refused by a guard");
    lines.push("");
    for (const r of refused) {
      lines.push(`- **${r.verdict}** \`${r.memory_id}\` — ${r.rationale ?? ""}`);
    }
    lines.push("");
  }

  if (revisions.length) {
    lines.push("## Field-level diffs");
    lines.push("");
    lines.push("Nothing summarised — at a few edits a night this stays short on purpose.");
    lines.push("");
    for (const r of revisions) {
      lines.push(`<details><summary><code>${r.memory_id}</code> · ${r.column_name}</summary>`);
      lines.push("");
      lines.push("```diff");
      for (const l of String(r.old_value ?? "").split("\n")) lines.push(`- ${l}`);
      for (const l of String(r.new_value ?? "").split("\n")) lines.push(`+ ${l}`);
      lines.push("```");
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  }

  lines.push("## Undo");
  lines.push("");
  lines.push("```sh");
  lines.push(`agent-memory undo --run ${opts.runId}`);
  lines.push("```");
  lines.push("");
  lines.push("Reverts column by column from `memory_revisions`, and skips any row a real session has");
  lines.push("edited since — which a snapshot restore would silently overwrite.");
  lines.push("");

  const notable = changed.length > 0 || proposed.length > 0 || flags.length > 0 || refused.length > 0;
  return { markdown: lines.join("\n"), headline, notable, changed: changed.length };
}
