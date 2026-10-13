import {
  getRelations, listAreas, listCurationCandidates, memoryStats, searchMemories,
} from "../db.js";
import { memorySimilarity } from "./similarity.js";
import type { MemoryEntry } from "../types.js";

/**
 * Builds the packet the curator model reasons over.
 *
 * The model gets no tools and no database access: it is handed this JSON, and it
 * returns decisions as JSON. That is deliberate three times over. It sidesteps the
 * recorded failure where an agent-memory MCP server spawned under launchd dies with
 * CONNECTION_CLOSED while the same invocation works from a terminal. It means no
 * allowlist mistake can give the model a write path. And it makes every decision
 * reviewable before anything is applied, rather than after.
 */

const NEIGHBOUR_LIMIT = 8;
/** Above this, a neighbour is close enough that the model needs to read it properly. */
const FULL_BODY_SIMILARITY = 0.25;
const FULL_BODIES_PER_CANDIDATE = 3;

export interface NeighbourView {
  id: string;
  title: string;
  type: string;
  severity: string;
  area: string;
  project: string | null;
  updated_at: string;
  similarity: number;
  relations: string[];
  symptom: string;
  root_cause?: string;
  fix?: string;
  tags?: string | null;
  truncated: boolean;
}

export interface Cluster {
  candidate: MemoryEntry & { relations: string[] };
  neighbours: NeighbourView[];
}

export interface CandidatePacket {
  mode: "nightly" | "sweep";
  window: { from: string | null; to: string | null };
  generated_at: string;
  corpus: ReturnType<typeof memoryStats>;
  budget: { archives_remaining: number };
  clusters: Cluster[];
}

function snippet(text: string, n: number): string {
  const body = (text ?? "").replace(/\s+/g, " ").trim();
  return body.length > n ? `${body.slice(0, n)}…` : body;
}

function describeRelations(id: string): string[] {
  return getRelations(id).map((r) =>
    r.from_id === id ? `${r.kind} ${r.to_id}` : `${r.from_id} ${r.kind} this`
  );
}

function buildCluster(candidate: MemoryEntry): Cluster {
  const raw = searchMemories(`${candidate.title} ${candidate.symptom} ${candidate.tags ?? ""}`, {
    limit: NEIGHBOUR_LIMIT,
    exclude_id: candidate.id,
  });

  const scored = raw
    .map((n) => ({ entry: n, similarity: Number(memorySimilarity(candidate, n).toFixed(3)) }))
    .sort((a, b) => b.similarity - a.similarity);

  let fullBodies = 0;
  const neighbours: NeighbourView[] = scored.map(({ entry, similarity }) => {
    const wantsFull = similarity >= FULL_BODY_SIMILARITY && fullBodies < FULL_BODIES_PER_CANDIDATE;
    if (wantsFull) fullBodies++;
    const base = {
      id: entry.id,
      title: entry.title,
      type: entry.type,
      severity: entry.severity,
      area: entry.area,
      project: entry.project,
      updated_at: entry.updated_at,
      similarity,
      relations: describeRelations(entry.id),
    };
    if (!wantsFull) {
      return { ...base, symptom: snippet(entry.symptom, 200), truncated: true };
    }
    return {
      ...base,
      symptom: entry.symptom,
      root_cause: entry.root_cause ?? undefined,
      fix: entry.fix,
      tags: entry.tags,
      truncated: false,
    };
  });

  return { candidate: { ...candidate, relations: describeRelations(candidate.id) }, neighbours };
}

export function buildPacket(opts: {
  mode: "nightly" | "sweep";
  since?: string;
  until?: string;
  area?: string;
  limit?: number;
  archivesRemaining: number;
}): CandidatePacket {
  const candidates =
    opts.mode === "sweep"
      // The sweep walks one area at a time rather than loading the corpus at once:
      // duplicates almost always share an area, so this clusters naturally and keeps
      // each pass bounded.
      ? listCurationCandidates({ area: opts.area, limit: opts.limit ?? 40, includeClean: true })
      : listCurationCandidates({ since: opts.since, until: opts.until, limit: opts.limit ?? 25 });

  return {
    mode: opts.mode,
    window: { from: opts.since ?? null, to: opts.until ?? null },
    generated_at: new Date().toISOString(),
    corpus: memoryStats(),
    budget: { archives_remaining: opts.archivesRemaining },
    clusters: candidates.map(buildCluster),
  };
}

export { listAreas };
