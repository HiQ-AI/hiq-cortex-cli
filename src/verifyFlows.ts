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
import { readJsonArrayArg, relicPost, requireCredential } from "./relicClient.js";
import { CortexClientError } from "./types.js";

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
  const raw = readJsonArrayArg(text, "flows");
  if (raw) {
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
  requireCredential("Commercial sources return counts only without one.");
  return relicPost<VerifyFlowsResult>(
    "flows/verify",
    "verify-flows",
    { source, version, flows },
    (d): d is VerifyFlowsResult => typeof (d as VerifyFlowsResult)?.total === "number",
  );
}

export function formatVerifyFlows(r: VerifyFlowsResult): string {
  const out: string[] = [];
  out.push(
    `${r.source.code} ${r.source.version}: ${r.total} 个 id,找到 ${r.found},缺 ${r.missing},单位不符 ${r.unitMismatch}`,
  );
  if (r.restricted) {
    out.push("(该源是商业源,当前凭据没有它的数据包权益 —— 只回计数,不回逐条明细。计数照样算数;要看哪一行,需开通该库。)");
    return out.join("\n");
  }
  for (const f of r.flows) {
    const mark = !f.found ? "✗ 不存在" : f.unitMatches === false ? "⚠ 单位不符" : "✓";
    const detail = f.found ? [f.compartment, f.unit].filter(Boolean).join(" · ") : "";
    out.push(`  ${mark}  ${f.id}${detail ? `  ${detail}` : ""}`);
  }
  return out.join("\n");
}
