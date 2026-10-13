import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  finishCurationRun, ftsIntegrityCheck, getState, listAreas, memoryStats,
  setCurationActor, setState, snapshotTo, startCurationRun,
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
  const proc = spawnSync(
    claudeBin,
    [
      "-p", prompt,
      "--model", opts.model ?? "claude-opus-5",
      "--output-format", "text",
      // No user settings: the operator's Stop hook fires inside a spawned run, blocks
      // once to demand a memory-capture pass, and its text becomes the final message.
      // This also means no MCP servers, which is the point — the model gets two file
      // tools and nothing that can reach the database.
      "--setting-sources=",
      "--permission-mode", "acceptEdits",
      "--allowedTools", "Read", "Write",
      "--add-dir", workDir,
    ],
    {
      // claude -p waits on stdin, and under launchd stdin is whatever launchd hands
      // us; a child that blocks on it blocks the whole run.
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 1_800_000,
      cwd: workDir,
    }
  );

  if (proc.status !== 0 || !existsSync(decisionsPath)) {
    const why = proc.error ? String(proc.error) : (proc.stderr || "").slice(-500) || `exit ${proc.status}`;
    log(`model run failed: ${why}`);
    finishCurationRun(runId, "failed", { candidates: packet.clusters.length, notes: why.slice(0, 500) });
    setState("last_run_failed", "1");
    return { runId, status: "failed", headline: `halted: model run failed (${proc.status})`, reportPath: null, notable: true };
  }

  let decisions: Decision[];
  try {
    const parsed = JSON.parse(readFileSync(decisionsPath, "utf8"));
    decisions = Array.isArray(parsed) ? parsed : parsed.decisions;
    if (!Array.isArray(decisions)) throw new Error("decisions is not an array");
  } catch (error) {
    log(`could not parse decisions: ${error}`);
    finishCurationRun(runId, "failed", { candidates: packet.clusters.length, notes: String(error).slice(0, 300) });
    setState("last_run_failed", "1");
    return { runId, status: "failed", headline: "halted: unreadable decisions", reportPath: null, notable: true };
  }
  log(`${decisions.length} decisions`);

  // Everything below runs as 'curator', which arms the guard triggers.
  setCurationActor("curator", runId);
  let outcome;
  try {
    outcome = opts.dryRun
      ? applyDecisions(runId, decisions.map((d) => ({ ...d, verdict: "PROPOSE" as const })))
      : applyDecisions(runId, decisions);
  } finally {
    setCurationActor(null, null);
  }
  log(`applied ${outcome.applied}, proposed ${outcome.proposed}, refused ${outcome.refused}`);

  const ftsAfter = ftsIntegrityCheck();
  const trailing = checkTrailingInvariants();
  const canaryDiff = canaries.length && baseline ? diffCanaries(baseline, runCanaries(canaries)) : null;

  const failed = !ftsAfter.ok || !trailing.ok;
  const status = failed ? "failed" : "ok";

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

  finishCurationRun(runId, status, {
    candidates: packet.clusters.length,
    applied: outcome.applied,
    proposed: outcome.proposed,
    notes: failed ? (trailing.violations.join("; ") || ftsAfter.error || "invariant violation") : undefined,
  });

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
