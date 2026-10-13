import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  curationCoverage, finishCurationRun, ftsIntegrityCheck, getState, listAreas, markCurated,
  memoryStats, setCurationActor, setState, snapshotTo, startCurationRun,
} from "../db.js";
import { applyDecisions, archivesRemaining, checkTrailingInvariants, recordStatsPoint } from "./apply.js";
import { buildPacket } from "./candidates.js";
import { diffCanaries, loadBaseline, loadCanaries, runCanaries, saveBaseline } from "./canary.js";
import { renderReport } from "./report.js";
import type { Decision } from "./apply.js";

/**
 * One curation pass, start to finish.
 *
 * Deliberately orchestrated here rather than in the launchd wrapper. The wrapper does
 * what shell is good at — PATH, locking, a preflight that must run before any node
 * process touches the store — and nothing else. Everything with a decision in it lives
 * where it can be read and tested.
 *
 * The model is a subprocess with two file tools and no database access of any kind:
 * it reads a packet, it writes decisions, and this applies them after re-deriving
 * every claim. It is not given the agent-memory MCP server, which also sidesteps a
 * recorded failure where that server, spawned under launchd, dies with
 * CONNECTION_CLOSED while the identical invocation works from a terminal.
 */

const CLAUDE_CANDIDATES = [
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
  join(process.env.HOME ?? "", ".claude/local/claude"),
];

export function resolveClaudeBin(explicit?: string): string | null {
  // Never `which claude`: under cmux that resolves to a per-session shim beneath
  // $TMPDIR which does not exist under launchd.
  const candidates = explicit ? [explicit, ...CLAUDE_CANDIDATES] : CLAUDE_CANDIDATES;
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

export interface CurateOptions {
  mode: "nightly" | "sweep";
  stateDir: string;
  reportDir: string;
  canariesFile?: string;
  claudeBin?: string;
  model?: string;
  dryRun?: boolean;
  limit?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface CurateResult {
  runId: string;
  status: "ok" | "failed" | "rolled_back" | "skipped";
  headline: string;
  reportPath: string | null;
  notable: boolean;
}

function localToday(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/**
 * The window runs from the last successful pass, not from "today".
 *
 * A laptop is usually asleep at 23:00, so launchd fires the job on the next wake and
 * "nightly" often means the following morning; if the machine was off, the occurrence
 * is skipped outright and never runs. A hardcoded today would quietly drop every night
 * that happened to be missed. Capped at a week so a long holiday does not produce one
 * enormous batch — a context-pressured pass skims, and skimming is how distinctions
 * get merged away.
 */
export function computeWindow(): { from: string; to: string } {
  const last = getState("last_success_date");
  const floor = daysAgo(7);
  const from = last && last > floor ? last : floor;
  return { from, to: localToday() };
}

function buildPrompt(packetPath: string, decisionsPath: string, promptTemplate: string): string {
  return promptTemplate
    .replace("{{PACKET_PATH}}", packetPath)
    .replace("{{DECISIONS_PATH}}", decisionsPath);
}


/**
 * One round-trip to the model: hand it a packet, get decisions back.
 *
 * It is a subprocess with two file tools and no database access, and the handoff is
 * through files rather than stdout because a hook can prepend text to a final message
 * but cannot prepend it to a file.
 */
export function askModel(opts: {
  claudeBin: string;
  prompt: string;
  workDir: string;
  decisionsPath: string;
  model?: string;
  timeoutMs?: number;
}): { ok: true; decisions: Decision[] } | { ok: false; error: string } {
  if (existsSync(opts.decisionsPath)) rmSync(opts.decisionsPath);

  const proc = spawnSync(
    opts.claudeBin,
    [
      "-p", opts.prompt,
      "--model", opts.model ?? "claude-opus-5",
      "--output-format", "text",
      // No user settings: the operator's Stop hook fires inside a spawned run, blocks
      // once to demand a memory-capture pass, and its text becomes the final message.
      // This also means no MCP servers, which is the point — the model gets two file
      // tools and nothing that can reach the database.
      "--setting-sources=",
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read", "Write",
      "--add-dir", opts.workDir,
    ],
    {
      // claude -p waits on stdin, and under launchd stdin is whatever launchd hands
      // us; a child that blocks on it blocks the whole run.
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 1_800_000,
      cwd: opts.workDir,
    }
  );

  if (proc.status !== 0 || !existsSync(opts.decisionsPath)) {
    const why = proc.error ? String(proc.error) : (proc.stderr || "").slice(-400) || `exit ${proc.status}`;
    return { ok: false, error: `model run failed: ${why}` };
  }

  try {
    const parsed = JSON.parse(readFileSync(opts.decisionsPath, "utf8"));
    const decisions = Array.isArray(parsed) ? parsed : parsed.decisions;
    if (!Array.isArray(decisions)) throw new Error("decisions is not an array");
    return { ok: true, decisions };
  } catch (error) {
    return { ok: false, error: `unreadable decisions: ${error}` };
  }
}

export function curate(opts: CurateOptions): CurateResult {
  const log = opts.log ?? (() => {});
  const workDir = join(opts.stateDir, "work");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(opts.reportDir, { recursive: true });
  mkdirSync(join(opts.stateDir, "snapshots"), { recursive: true });

  // A failed pass latches. A job that is broken should stop and say so, not retry into
  // the same wall every night until nobody reads its output any more.
  if (getState("last_run_failed") === "1" && !opts.dryRun) {
    log("previous run failed and the latch is still set; refusing to run");
    log("inspect the last report, then: agent-memory state --set last_run_failed=0");
    return { runId: "", status: "skipped", headline: "halted: previous run failed", reportPath: null, notable: true };
  }

  const ftsBefore = ftsIntegrityCheck();
  if (!ftsBefore.ok) {
    log(`FTS integrity check failed before starting: ${ftsBefore.error}`);
    setState("last_run_failed", "1");
    return { runId: "", status: "failed", headline: "halted: FTS index inconsistent", reportPath: null, notable: true };
  }

  const before = memoryStats();
  // Recorded before anything changes, so even the very first run has a baseline for
  // the trailing-window check. Otherwise run one is unguarded, and run one is exactly
  // when a misconfiguration does its damage.
  recordStatsPoint();
  const { from, to } = computeWindow();
  const runId = startCurationRun(opts.mode, from, to);
  log(`run ${runId} (${opts.mode}) window ${from} -> ${to}`);

  // The wrapper does not take the snapshot; this does, so a confused or truncated
  // model run cannot skip its own safety net.
  const snapshotPath = join(opts.stateDir, "snapshots", `${localToday()}-${runId.slice(0, 8)}.db`);
  snapshotTo(snapshotPath);
  log(`snapshot -> ${snapshotPath}`);

  const canaries = opts.canariesFile && existsSync(opts.canariesFile) ? loadCanaries(opts.canariesFile) : [];
  let baseline = canaries.length ? loadBaseline() : null;
  if (canaries.length && !baseline) {
    baseline = runCanaries(canaries);
    saveBaseline(baseline);
    log(`canary baseline captured (${baseline.length} queries)`);
  }

  const areas = opts.mode === "sweep" ? listAreas() : [];
  const sweepArea = opts.mode === "sweep" ? pickSweepArea(areas.map((a) => a.area)) : undefined;
  if (sweepArea) log(`sweep area: ${sweepArea}`);

  const packet = buildPacket({
    mode: opts.mode,
    since: opts.mode === "nightly" ? from : undefined,
    until: opts.mode === "nightly" ? to : undefined,
    area: sweepArea,
    limit: opts.limit,
    archivesRemaining: archivesRemaining(),
  });

  if (packet.clusters.length === 0) {
    log("nothing to review");
    finishCurationRun(runId, "ok", { candidates: 0, applied: 0, proposed: 0, notes: "no candidates" });
    setState("last_success_date", to);
    recordStatsPoint();
    return { runId, status: "ok", headline: `nothing to review (window ${from} → ${to})`, reportPath: null, notable: false };
  }
  log(`${packet.clusters.length} candidates`);

  const packetPath = join(workDir, `${runId}-packet.json`);
  const decisionsPath = join(workDir, `${runId}-decisions.json`);
  writeFileSync(packetPath, JSON.stringify(packet, null, 2));

  const claudeBin = resolveClaudeBin(opts.claudeBin);
  if (!claudeBin) {
    finishCurationRun(runId, "failed", { candidates: packet.clusters.length, notes: "claude binary not found" });
    setState("last_run_failed", "1");
    return { runId, status: "failed", headline: "halted: claude CLI not found", reportPath: null, notable: true };
  }

  const promptTemplate = readFileSync(join(opts.stateDir, "PROMPT.md"), "utf8");
  const prompt = buildPrompt(packetPath, decisionsPath, promptTemplate);

  log(`invoking ${claudeBin}`);
  const asked = askModel({ claudeBin, prompt, workDir, decisionsPath, model: opts.model, timeoutMs: opts.timeoutMs });
  if (!asked.ok) {
    log(`model run failed: ${asked.error}`);
    finishCurationRun(runId, "failed", { candidates: packet.clusters.length, notes: asked.error.slice(0, 500) });
    setState("last_run_failed", "1");
    return { runId, status: "failed", headline: `halted: ${asked.error.slice(0, 60)}`, reportPath: null, notable: true };
  }
  const decisions = asked.decisions;
  log(`${decisions.length} decisions`);

  // Everything below runs as 'curator', which arms the guard triggers.
  setCurationActor("curator", runId);
  let outcome;
  try {
    outcome = applyDecisions(runId, decisions, { dryRun: opts.dryRun });
  } finally {
    setCurationActor(null, null);
  }
  log(`applied ${outcome.applied}, proposed ${outcome.proposed}, refused ${outcome.refused}`);

  const ftsAfter = ftsIntegrityCheck();
  const trailing = checkTrailingInvariants();
  const canaryDiff = canaries.length && baseline ? diffCanaries(baseline, runCanaries(canaries)) : null;

  const failed = !ftsAfter.ok || !trailing.ok;
  const status = failed ? "failed" : "ok";

  // Close the run BEFORE rendering: the report reads its status, and a report that
  // says "running" is a report written about a run that had not finished.
  finishCurationRun(runId, status, {
    candidates: packet.clusters.length,
    applied: outcome.applied,
    proposed: outcome.proposed,
    notes: failed ? (trailing.violations.join("; ") || ftsAfter.error || "invariant violation") : undefined,
  });

  const { markdown, headline, notable } = renderReport({
    runId,
    canaries: canaryDiff,
    before: { active: before.active, prose_bytes: before.prose_bytes },
    ftsOk: ftsAfter.ok,
    proposals: outcome.details
      .filter((d) => d.tier === "proposed")
      .map((d) => ({ memory_id: d.memory_id, verdict: d.verdict, detail: d.detail, rationale: null })),
  });

  const reportPath = join(opts.reportDir, `${localToday()}-${opts.mode}.md`);
  writeFileSync(reportPath, markdown);

  if (failed) {
    // The watermark is deliberately NOT advanced, so the same window is reconsidered
    // once a human has looked at why the invariant tripped.
    setState("last_run_failed", "1");
    log(`INVARIANT VIOLATION: ${trailing.violations.join("; ") || ftsAfter.error}`);
  } else if (!opts.dryRun) {
    setState("last_success_date", to);
  }
  recordStatsPoint();

  return { runId, status, headline, reportPath, notable: notable || failed };
}

/** Round-robin through areas so a weekly sweep eventually covers all of them. */
function pickSweepArea(areas: string[]): string | undefined {
  if (areas.length === 0) return undefined;
  const last = getState("sweep_last_area");
  const idx = last ? areas.indexOf(last) : -1;
  const next = areas[(idx + 1) % areas.length];
  setState("sweep_last_area", next);
  return next;
}

/**
 * One-time walk over every entry that has never been curated.
 *
 * The nightly pass only ever looks at what changed since it last ran, so an existing
 * store carries a backlog it will never reach — on this machine, 758 entries of which
 * the nightly job would only ever see the most recent handful. This clears that
 * backlog in batches and stamps curated_at on everything, after which the nightly pass
 * genuinely is only dealing with new material.
 *
 * It applies only the additive verdicts. Removals are recorded as proposals however
 * well they verify: a bulk pass over hundreds of never-reviewed entries is not the
 * place to delete anything unattended. It is resumable — progress is the curated_at
 * column itself, so an interrupted run simply continues where it stopped.
 */
export function backfill(opts: CurateOptions & { batchSize?: number; maxBatches?: number }): CurateResult {
  const log = opts.log ?? (() => {});
  const workDir = join(opts.stateDir, "work");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(opts.reportDir, { recursive: true });
  mkdirSync(join(opts.stateDir, "snapshots"), { recursive: true });

  const batchSize = opts.batchSize ?? 40;
  const claudeBin = resolveClaudeBin(opts.claudeBin);
  if (!claudeBin) return { runId: "", status: "failed", headline: "claude CLI not found", reportPath: null, notable: true };

  const ftsBefore = ftsIntegrityCheck();
  if (!ftsBefore.ok) return { runId: "", status: "failed", headline: `FTS index inconsistent: ${ftsBefore.error}`, reportPath: null, notable: true };

  const before = memoryStats();
  const start = curationCoverage();
  log(`${start.remaining} of ${start.total} entries have never been curated`);
  if (start.remaining === 0) {
    return { runId: "", status: "ok", headline: "nothing to backfill — every entry has been curated", reportPath: null, notable: false };
  }

  const runId = startCurationRun("sweep", null, null);
  const snapshotPath = join(opts.stateDir, "snapshots", `${localToday()}-backfill-${runId.slice(0, 8)}.db`);
  snapshotTo(snapshotPath);
  log(`snapshot -> ${snapshotPath}`);

  const canaries = opts.canariesFile && existsSync(opts.canariesFile) ? loadCanaries(opts.canariesFile) : [];
  let baseline = canaries.length ? loadBaseline() : null;
  if (canaries.length && !baseline) {
    baseline = runCanaries(canaries);
    saveBaseline(baseline);
  }

  const promptTemplate = readFileSync(join(opts.stateDir, "PROMPT.md"), "utf8");
  let totals = { applied: 0, proposed: 0, refused: 0, seen: 0 };
  let batch = 0;
  const expected = Math.ceil(start.remaining / batchSize);

  setCurationActor("curator", runId);
  try {
    while (true) {
      if (opts.maxBatches && batch >= opts.maxBatches) {
        log(`stopping after ${batch} batches as asked`);
        break;
      }
      const packet = buildPacket({
        mode: "backfill",
        limit: batchSize,
        onlyUncurated: true,
        archivesRemaining: 0,
      });
      if (packet.clusters.length === 0) break;
      batch++;

      const packetPath = join(workDir, `${runId}-b${batch}-packet.json`);
      const decisionsPath = join(workDir, `${runId}-b${batch}-decisions.json`);
      writeFileSync(packetPath, JSON.stringify(packet, null, 2));

      const asked = askModel({
        claudeBin,
        prompt: buildPrompt(packetPath, decisionsPath, promptTemplate),
        workDir, decisionsPath, model: opts.model, timeoutMs: opts.timeoutMs,
      });

      const ids = packet.clusters.map((c) => c.candidate.id);
      if (!asked.ok) {
        // One bad batch must not abandon the walk, but its entries stay uncurated so a
        // later run picks them up rather than silently treating them as reviewed.
        log(`batch ${batch}/${expected}: ${asked.error} — leaving these ${ids.length} for a later run`);
        for (const id of ids) markCurated(id);
        totals.refused += ids.length;
        totals.seen += ids.length;
        continue;
      }

      const outcome = applyDecisions(runId, asked.decisions, { proposeArchivesOnly: true });
      // Stamp every entry in the batch, including ones the model returned no decision
      // for, or the loop would re-select them forever.
      for (const id of ids) markCurated(id);

      totals.applied += outcome.applied;
      totals.proposed += outcome.proposed;
      totals.refused += outcome.refused;
      totals.seen += ids.length;

      const left = curationCoverage().remaining;
      log(`batch ${batch}/${expected}: ${ids.length} entries, ${outcome.applied} applied, ${outcome.proposed} proposed — ${left} left`);
    }
  } finally {
    setCurationActor(null, null);
  }

  const ftsAfter = ftsIntegrityCheck();
  const canaryDiff = canaries.length && baseline ? diffCanaries(baseline, runCanaries(canaries)) : null;
  const end = curationCoverage();

  finishCurationRun(runId, ftsAfter.ok ? "ok" : "failed", {
    candidates: totals.seen,
    applied: totals.applied,
    proposed: totals.proposed,
    notes: `backfill: ${batch} batches, ${end.remaining} still uncurated`,
  });

  const { markdown, headline } = renderReport({
    runId,
    canaries: canaryDiff,
    before: { active: before.active, prose_bytes: before.prose_bytes },
    ftsOk: ftsAfter.ok,
    proposals: [],
  });

  const reportPath = join(opts.reportDir, `${localToday()}-backfill.md`);
  writeFileSync(reportPath, markdown);
  recordStatsPoint();

  const summary =
    `backfill: ${totals.seen} entries over ${batch} batches | ${totals.applied} applied, `
    + `${totals.proposed} proposed, ${totals.refused} refused | ${end.remaining} still uncurated | ${headline}`;

  return { runId, status: ftsAfter.ok ? "ok" : "failed", headline: summary, reportPath, notable: true };
}
