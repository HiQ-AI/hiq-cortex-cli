/**
 * `verify-flows` — check elementary-flow ids (and optionally their units) against
 * the catalog relic actually serves for a given source coordinate.
 *
 * Why this exists: dataset authoring fills in elementary-flow ids, and the only
 * local check used to be "is the id in a bundled spreadsheet snapshot" — a table
 * that is neither the one LCIA runs on nor carries units. Identity is the
 * composite (name, compartment, unit); a uuid alone cannot tell `sm3` from `m3`,
 * and a wrong id is silent downstream (characterisation factors match by uuid
 * and simply skip). This command asks relic's `/flows/verify`, the same
 * (code, version, flow_id) space the calculation reads.
 *
 * Goes straight to `/api/relic/*` — the edge passes the credential through and
 * relic checks it itself. No MCP tool involved.
 */
import { readFileSync } from "node:fs";
import { authHeaders, config, hasCredential } from "./config.js";
import { CortexClientError } from "./types.js";
import { VERSION } from "./version.js";

const TIMEOUT_MS = 60_000;
const MAX_FLOWS = 5000;

export interface VerifyFlowItem {
  id: string;
  unit?: string;
}

export interface VerifiedFlow {
  id: string;
  found: boolean;
  compartment: string | null;
  unit: string | null;
  /** null when either side has no unit — the server does not guess. */
  unitMatches: boolean | null;
}

export interface VerifyFlowsResult {
  restricted: boolean;
  source: { code: string; version: string };
  total: number;
  found: number;
  missing: number;
  unitMismatch: number;
  /** Empty when `restricted` — commercial sources return counts only without entitlement. */
  flows: VerifiedFlow[];
}

/** Parse `--flows`: inline `id[:unit],id[:unit]` or `@file` (JSON array of {id, unit?} or of strings). */
export function parseFlowsArg(arg: string): VerifyFlowItem[] {
  const text = arg.trim();
  if (!text) throw new CortexClientError("validation", "--flows is empty");
  let items: VerifyFlowItem[];
  if (text.startsWith("@")) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(text.slice(1), "utf-8"));
    } catch (err) {
      throw new CortexClientError("validation", `cannot read ${text.slice(1)}: ${(err as Error).message}`);
    }
    if (!Array.isArray(raw)) throw new CortexClientError("validation", "flows file must be a JSON array");
    items = raw.map((x) =>
      typeof x === "string"
        ? { id: x }
        : { id: String((x as VerifyFlowItem)?.id ?? ""), unit: (x as VerifyFlowItem)?.unit || undefined },
    );
  } else {
    items = text.split(",").map((tok) => {
      const [id, unit] = tok.split(":");
      return { id: id.trim(), unit: unit?.trim() || undefined };
    });
  }
  items = items.filter((i) => i.id);
  if (!items.length) throw new CortexClientError("validation", "no flow ids given");
  if (items.length > MAX_FLOWS) throw new CortexClientError("validation", `at most ${MAX_FLOWS} flows per call`);
  return items;
}

export async function runVerifyFlows(source: string, version: string, flows: VerifyFlowItem[]): Promise<VerifyFlowsResult> {
  if (!hasCredential()) {
    throw new CortexClientError(
      "config",
      "No credential. Run `hiq-cortex login` (one browser click, no registration), " +
        "or set HIQ_API_KEY=sk_… for server-side use. Commercial sources return counts only without one.",
    );
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${config.base}/api/relic/flows/verify`, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/json",
        "User-Agent": `hiq-cortex-cli/${VERSION}`,
      },
      body: JSON.stringify({ source, version, flows }),
      signal: ctl.signal,
    });
  } catch (err) {
    throw new CortexClientError(
      "transport",
      (err as Error).name === "AbortError"
        ? "verify-flows timed out after 60s"
        : `cannot reach relic: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
  const raw = await resp.text();
  if (resp.status === 401 || resp.status === 403) {
    throw new CortexClientError(
      "config",
      `relic rejected this credential (HTTP ${resp.status}). Run \`hiq-cortex login\` again, or check HIQ_API_KEY. ${raw.slice(0, 200)}`,
    );
  }
  if (!resp.ok) {
    let code: string | undefined;
    try {
      code = (JSON.parse(raw) as { error?: { code?: string } }).error?.code;
    } catch {
      /* not JSON */
    }
    throw new CortexClientError("upstream", `verify-flows failed: HTTP ${resp.status} ${raw.slice(0, 300)}`, code);
  }
  let body: { data?: VerifyFlowsResult };
  try {
    body = JSON.parse(raw) as { data?: VerifyFlowsResult };
  } catch {
    throw new CortexClientError("upstream", `cannot parse relic response: ${raw.slice(0, 200)}`);
  }
  if (!body.data || typeof body.data.total !== "number") {
    throw new CortexClientError("upstream", `unexpected relic response shape: ${raw.slice(0, 200)}`);
  }
  return body.data;
}

export function formatVerifyFlows(r: VerifyFlowsResult): string {
  const out: string[] = [];
  out.push(
    `${r.source.code} ${r.source.version}: ${r.total} 个 id,找到 ${r.found},缺 ${r.missing},单位不符 ${r.unitMismatch}`,
  );
  if (r.restricted) {
    out.push("(该源需数据包权益才回逐条明细;当前只有计数。`hiq-cortex login` 后重试。)");
    return out.join("\n");
  }
  for (const f of r.flows) {
    const mark = !f.found ? "✗ 不存在" : f.unitMatches === false ? "⚠ 单位不符" : "✓";
    const detail = f.found ? [f.compartment, f.unit].filter(Boolean).join(" · ") : "";
    out.push(`  ${mark}  ${f.id}${detail ? `  ${detail}` : ""}`);
  }
  return out.join("\n");
}
