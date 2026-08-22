/**
 * `verify-datasets` — check upstream dataset ids (UPR column I) against the
 * processes relic actually serves for a source coordinate: does the id exist,
 * under which system models, what is its reference unit, and is it still
 * published. The local catalog snapshot bundled with the skill can only answer
 * "is the id in the list"; a dataset that was withdrawn, or only exists under a
 * different system model, or carries a different reference unit than the row
 * uses, passes that check and breaks the linked model silently.
 *
 * Same shape as `verify-flows`: counts are always returned; per-row detail only
 * with an entitlement on commercial sources. Exit 2 when anything is missing,
 * unit-mismatched or unpublished.
 */
import { readJsonArrayArg, relicPost, requireCredential } from "./relicClient.js";
import { CortexClientError } from "./types.js";

const MAX_DATASETS = 5000;

export interface VerifyDatasetItem {
  id: string;
  /** Optional system model (CUT_OFF / CONSEQUENTIAL …); omitted = any model counts as found. */
  model?: string;
  /** Optional unit the row uses; compared to the dataset's reference unit (no conversion). */
  unit?: string;
}

export interface VerifiedDataset {
  id: string;
  found: boolean;
  /** Models matching the request (all of them when no model was asked for). */
  models: string[];
  /** Models the id exists under regardless of the requested model — non-empty with found=false means "wrong model". */
  availableModels: string[];
  name: string | null;
  refProductName: string | null;
  unit: string | null;
  unitMatches: boolean | null;
  published: boolean | null;
}

export interface VerifyDatasetsResult {
  restricted: boolean;
  source: { code: string; version: string };
  total: number;
  found: number;
  missing: number;
  unitMismatch: number;
  unpublished: number;
  datasets: VerifiedDataset[];
}

/** Parse `--datasets`: inline `id[:unit],…` or `@file` (JSON array of strings or {id, model?, unit?}). */
export function parseDatasetsArg(arg: string): VerifyDatasetItem[] {
  const text = arg.trim();
  if (!text) throw new CortexClientError("validation", "--datasets is empty");
  let items: VerifyDatasetItem[];
  const raw = readJsonArrayArg(text, "datasets");
  if (raw) {
    items = raw.map((x) =>
      typeof x === "string"
        ? { id: x }
        : {
            id: String((x as VerifyDatasetItem)?.id ?? ""),
            model: (x as VerifyDatasetItem)?.model || undefined,
            unit: (x as VerifyDatasetItem)?.unit || undefined,
          },
    );
  } else {
    items = text.split(",").map((tok) => {
      const [id, unit] = tok.split(":");
      return { id: id.trim(), unit: unit?.trim() || undefined };
    });
  }
  items = items.filter((i) => i.id);
  if (!items.length) throw new CortexClientError("validation", "no dataset ids given");
  if (items.length > MAX_DATASETS) throw new CortexClientError("validation", `at most ${MAX_DATASETS} datasets per call`);
  return items;
}

export async function runVerifyDatasets(
  source: string,
  version: string,
  datasets: VerifyDatasetItem[],
): Promise<VerifyDatasetsResult> {
  requireCredential("Commercial sources return counts only without one.");
  return relicPost<VerifyDatasetsResult>(
    "datasets/verify",
    "verify-datasets",
    { source, version, datasets },
    (d): d is VerifyDatasetsResult => typeof (d as VerifyDatasetsResult)?.total === "number",
  );
}

export function formatVerifyDatasets(r: VerifyDatasetsResult): string {
  const out: string[] = [];
  out.push(
    `${r.source.code} ${r.source.version}: ${r.total} 个 id,找到 ${r.found},缺 ${r.missing},单位不符 ${r.unitMismatch},已下架 ${r.unpublished}`,
  );
  if (r.restricted) {
    out.push("(该源是商业源,当前凭据没有它的数据包权益 —— 只回计数,不回逐条明细。计数照样算数;要看哪一行,需开通该库。)");
    return out.join("\n");
  }
  for (const d of r.datasets) {
    let mark: string;
    if (!d.found) mark = d.availableModels.length ? `✗ 模型不对(库里有 ${d.availableModels.join("/")})` : "✗ 不存在";
    else if (d.published === false) mark = "✗ 已下架";
    else if (d.unitMatches === false) mark = "⚠ 单位不符";
    else mark = "✓";
    const detail = d.found ? [d.name, d.models.join("/"), d.unit].filter(Boolean).join(" · ") : "";
    out.push(`  ${mark}  ${d.id}${detail ? `  ${detail}` : ""}`);
  }
  return out.join("\n");
}
