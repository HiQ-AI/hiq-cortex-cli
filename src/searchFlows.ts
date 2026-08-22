/**
 * `search-flows` — elementary-flow candidates for dataset authoring.
 *
 * Asks relic `/flows/search` for each query: BM25 over names/synonyms/CAS/formula plus a
 * bge-m3 vector branch (when the library was built with embeddings), fused by RRF. This is
 * the candidate source for column H in UPR authoring — the bundled spreadsheet is an
 * offline fallback, not the catalog the calculation reads.
 *
 * Batch shape: the endpoint takes one query; this command loops with small concurrency and
 * returns one entry per query in input order, so a script can read it back by position.
 */
import { readJsonArrayArg, relicPost, requireCredential } from "./relicClient.js";
import { CortexClientError } from "./types.js";

const CONCURRENCY = 4;
const MAX_QUERIES = 500;

export interface FlowSearchQuery {
  query: string;
  compartment?: string;
}

export interface FlowCandidate {
  id: string;
  name: Record<string, string> | null;
  compartment: string | null;
  unit: string | null;
  scores: { bm25: number | null; vector: number | null; fused: number };
}

export interface FlowSearchResult {
  restricted: boolean;
  source: { code: string; version: string };
  query: string;
  branches: { bm25: boolean; vector: boolean };
  total: number;
  flows: FlowCandidate[];
}

/** `--queries`: inline `a,b,c` (no compartment) or `@file` (JSON array of strings or {query, compartment?}). */
export function parseQueriesArg(arg: string): FlowSearchQuery[] {
  const text = arg.trim();
  if (!text) throw new CortexClientError("validation", "--queries is empty");
  let items: FlowSearchQuery[];
  const raw = readJsonArrayArg(text, "queries");
  if (raw) {
    items = raw.map((x) =>
      typeof x === "string"
        ? { query: x }
        : { query: String((x as FlowSearchQuery)?.query ?? ""), compartment: (x as FlowSearchQuery)?.compartment || undefined },
    );
  } else {
    items = text.split(",").map((q) => ({ query: q.trim() }));
  }
  items = items.filter((i) => i.query);
  if (!items.length) throw new CortexClientError("validation", "no queries given");
  if (items.length > MAX_QUERIES) throw new CortexClientError("validation", `at most ${MAX_QUERIES} queries per call`);
  return items;
}

async function searchOne(source: string, version: string, q: FlowSearchQuery, limit: number): Promise<FlowSearchResult> {
  return relicPost<FlowSearchResult>(
    "flows/search",
    "search-flows",
    { source, version, query: q.query, ...(q.compartment ? { compartment: q.compartment } : {}), limit },
    (d): d is FlowSearchResult => Array.isArray((d as FlowSearchResult)?.flows),
  );
}

export async function runSearchFlows(source: string, version: string, queries: FlowSearchQuery[], limit: number): Promise<FlowSearchResult[]> {
  requireCredential();
  const out: FlowSearchResult[] = new Array(queries.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queries.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= queries.length) return;
      out[i] = await searchOne(source, version, queries[i], limit);
    }
  });
  await Promise.all(workers);
  return out;
}

export function formatSearchFlows(results: FlowSearchResult[]): string {
  const out: string[] = [];
  for (const r of results) {
    const br = `${r.branches.bm25 ? "bm25" : ""}${r.branches.bm25 && r.branches.vector ? "+" : ""}${r.branches.vector ? "vector" : ""}` || "none";
    out.push(`${r.query}  [${r.source.code} ${r.source.version} · ${br}]`);
    if (r.restricted) {
      out.push("  (商业源,当前凭据无数据包权益 —— 只回计数,不回候选)");
      continue;
    }
    if (!r.flows.length) out.push("  (无候选)");
    for (const f of r.flows) {
      const name = f.name ? Object.values(f.name)[0] : "";
      const sc = [f.scores.bm25 != null ? `bm25 ${f.scores.bm25.toFixed(2)}` : null, f.scores.vector != null ? `vec ${f.scores.vector.toFixed(2)}` : null].filter(Boolean).join(" · ");
      out.push(`  ${f.id}  ${name}  ${[f.compartment, f.unit].filter(Boolean).join(" · ")}  (${sc})`);
    }
  }
  return out.join("\n");
}
