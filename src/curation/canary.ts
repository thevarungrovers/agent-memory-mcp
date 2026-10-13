import { readFileSync } from "node:fs";
import { getState, searchMemories, setState } from "../db.js";

/**
 * A fixed set of real queries whose top results are pinned, run before and after each
 * curation pass.
 *
 * This is the only end-to-end check that the store still answers the questions it used
 * to. Every other rail watches an individual edit; this watches the property anyone
 * actually cares about. It catches the three failures that are otherwise invisible in
 * a per-action report: prose normalised until an entry stops matching its own error
 * string, an archive that removed the one entry a question depended on, and an FTS
 * index gone stale. Rollback is only ever as good as detection.
 */

export interface Canary {
  name: string;
  query: string;
  area?: string;
  project?: string;
}

export interface CanaryResult {
  name: string;
  query: string;
  top: string[];
}

export function loadCanaries(path: string): Canary[] {
  return JSON.parse(readFileSync(path, "utf8")) as Canary[];
}

export function runCanaries(canaries: Canary[]): CanaryResult[] {
  return canaries.map((c) => ({
    name: c.name,
    query: c.query,
    top: searchMemories(c.query, { area: c.area, project: c.project, limit: 3 }).map((m) => m.id),
  }));
}

export function saveBaseline(results: CanaryResult[]): void {
  setState("canary_baseline", JSON.stringify({ saved_at: new Date().toISOString(), results }));
}

export function loadBaseline(): CanaryResult[] | null {
  const raw = getState("canary_baseline");
  if (!raw) return null;
  return (JSON.parse(raw) as { results: CanaryResult[] }).results;
}

export interface CanaryDiff {
  stable: number;
  total: number;
  changed: { name: string; was: string[]; now: string[] }[];
}

export function diffCanaries(baseline: CanaryResult[], current: CanaryResult[]): CanaryDiff {
  const byName = new Map(baseline.map((r) => [r.name, r]));
  const changed: CanaryDiff["changed"] = [];
  let stable = 0;

  for (const now of current) {
    const was = byName.get(now.name);
    if (!was) continue;
    if (was.top.join(",") === now.top.join(",")) stable++;
    else changed.push({ name: now.name, was: was.top, now: now.top });
  }
  return { stable, total: current.length, changed };
}
