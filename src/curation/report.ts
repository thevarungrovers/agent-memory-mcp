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
 * Built to be scanned in two minutes and to be worth opening at all: the header line
 * carries everything needed to decide whether to read further, and the wrapper only
 * notifies when something actually changed. A report that arrives nightly saying
 * "nothing notable" trains you to stop reading it within a fortnight.
 */
export function renderReport(opts: {
  runId: string;
  canaries: CanaryDiff | null;
  before: { active: number; prose_bytes: number };
  ftsOk: boolean;
  proposals: { memory_id: string; verdict: string; detail: string; rationale: string | null }[];
}): { markdown: string; headline: string; notable: boolean } {
  const run = getCurationRun(opts.runId);
  const actions = getCurationActions(opts.runId);
  const revisions = getRevisionsForRun(opts.runId);
  const now = memoryStats();
  const trailing = checkTrailingInvariants();

  const applied = actions.filter((a) => a.tier === "applied");
  const proposed = actions.filter((a) => a.tier === "proposed");
  const refused = actions.filter((a) => a.tier === "refused");
  const archived = applied.filter((a) => a.verdict === "ARCHIVE");
  const changedRows = new Set(revisions.map((r) => r.memory_id));

  const pct = (a: number, b: number): string => (b === 0 ? "0.0%" : `${(((a - b) / b) * 100).toFixed(1)}%`);
  const kb = (n: number): string => `${(n / 1024).toFixed(0)}KB`;

  const canaryLine = opts.canaries
    ? `${opts.canaries.stable}/${opts.canaries.total} canaries stable`
    : "canaries not configured";

  const headline =
    `active ${opts.before.active}→${now.active} | prose ${kb(opts.before.prose_bytes)}→${kb(now.prose_bytes)} `
    + `(${pct(now.prose_bytes, opts.before.prose_bytes)}) | fts ${opts.ftsOk ? "PASS" : "FAIL"} | `
    + `${applied.length} applied, ${archived.length} archived, ${proposed.length} to review, ${refused.length} refused | ${canaryLine}`;

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

  if (applied.length) {
    lines.push("## Applied");
    lines.push("");
    for (const a of applied) {
      const m = getMemoryById(a.memory_id);
      lines.push(`- **${a.verdict}** \`${a.memory_id}\` — ${m?.title ?? "(gone)"}`);
      if (a.cites) lines.push(`  - cites \`${a.cites}\``);
      if (a.rationale) lines.push(`  - ${a.rationale}`);
    }
    lines.push("");
  }

  if (revisions.length) {
    lines.push("## What changed, verbatim");
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

  if (proposed.length) {
    lines.push("## Proposals — nothing was changed");
    lines.push("");
    lines.push("These needed a judgement no predicate can make, so they are yours.");
    lines.push("");
    for (const p of proposed) {
      const m = getMemoryById(p.memory_id);
      const why = opts.proposals.find((x) => x.memory_id === p.memory_id)?.detail;
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

  lines.push("## Undo");
  lines.push("");
  lines.push("```sh");
  lines.push(`agent-memory undo --run ${opts.runId}`);
  lines.push("```");
  lines.push("");
  lines.push("Reverts column by column from `memory_revisions`, and skips any row a real session has");
  lines.push("edited since — which a snapshot restore would silently overwrite.");
  lines.push("");

  const notable = applied.length > 0 || proposed.length > 0 || flags.length > 0 || refused.length > 0;
  return { markdown: lines.join("\n"), headline, notable };
}
