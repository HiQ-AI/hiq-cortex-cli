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
import { readFileSync } from "node:fs";
import { authHeaders, config, hasCredential } from "./config.js";
import { CortexClientError } from "./types.js";
import { VERSION } from "./version.js";

const TIMEOUT_MS = 60_000;
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
  if (text.startsWith("@")) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(text.slice(1), "utf-8"));
    } catch (err) {
      throw new CortexClientError("validation", `cannot read ${text.slice(1)}: ${(err as Error).message}`);
    }
    if (!Array.isArray(raw)) throw new CortexClientError("validation", "queries file must be a JSON array");
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
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${config.base}/api/relic/flows/search`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json", "User-Agent": `hiq-cortex-cli/${VERSION}` },
      body: JSON.stringify({ source, version, query: q.query, ...(q.compartment ? { compartment: q.compartment } : {}), limit }),
      signal: ctl.signal,
    });
  } catch (err) {
    throw new CortexClientError(
      "transport",
      (err as Error).name === "AbortError" ? "search-flows timed out after 60s" : `cannot reach relic: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
  const raw = await resp.text();
  if (resp.status === 401 || resp.status === 403) {
    throw new CortexClientError("config", `relic rejected this credential (HTTP ${resp.status}). Run \`hiq-cortex login\` again, or check HIQ_API_KEY. ${raw.slice(0, 200)}`);
  }
  if (!resp.ok) throw new CortexClientError("upstream", `search-flows failed: HTTP ${resp.status} ${raw.slice(0, 300)}`);
  let body: { data?: FlowSearchResult };
  try {
    body = JSON.parse(raw) as { data?: FlowSearchResult };
  } catch {
    throw new CortexClientError("upstream", `cannot parse relic response: ${raw.slice(0, 200)}`);
  }
  if (!body.data || !Array.isArray(body.data.flows)) throw new CortexClientError("upstream", `unexpected relic response shape: ${raw.slice(0, 200)}`);
  return body.data;
}

export async function runSearchFlows(source: string, version: string, queries: FlowSearchQuery[], limit: number): Promise<FlowSearchResult[]> {
  if (!hasCredential()) {
    throw new CortexClientError(
      "config",
      "No credential. Run `hiq-cortex login` (one browser click, no registration), or set HIQ_API_KEY=sk_… for server-side use.",
    );
  }
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
