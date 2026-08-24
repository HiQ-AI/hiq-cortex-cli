/**
 * `search-datasets` — deterministic catalog candidates for dataset authoring.
 *
 * This is intentionally different from `search`: `/api/relic/search` performs a direct catalog
 * lookup and returns canonical dataset handles in well under a second in the normal case. It does
 * not ask an LLM to translate, rank or verify a material description. Authoring workflows should
 * start here, then use the slower semantic `search` command only for rows with no defensible direct
 * candidate.
 */
import { opaqueIdentity, readJsonArrayArg, relicPost, requireCredential } from "./relicClient.js";
import { CortexClientError } from "./types.js";

const CONCURRENCY = 4;
const MAX_QUERIES = 500;

export interface DatasetSearchQuery {
  query: string;
  locations?: string[];
  activityTypes?: string[];
  /** Opaque caller correlation id. It is never sent to relic. */
  identity?: string;
}

type RelicName = Record<string, string> | { value: string; lang: string | null };

interface RelicDataset {
  id: string;
  version: string;
  datasetRef: string;
  source: { code: string; version: string };
  systemModel: { code: string };
  location: { id: string; name?: RelicName } | null;
}

interface RelicActivity {
  activityRef: string;
  activityUuid: string | null;
  fallbackId: string | null;
  name: RelicName;
  referenceProduct: { name: RelicName; unit: string | null } | null;
  datasets: RelicDataset[];
}

export interface DatasetCandidate {
  datasetRef: string;
  id: string;
  version: string;
  source: { code: string; version: string };
  model: string;
  location: { id: string; name?: RelicName } | null;
}

export interface DatasetActivityCandidate {
  activityRef: string;
  activityUuid: string | null;
  fallbackId: string | null;
  name: RelicName;
  referenceProduct: { name: RelicName; unit: string | null } | null;
  datasets: DatasetCandidate[];
}

export interface DatasetSearchResult {
  query: string;
  source: { code: string; version: string };
  model: string;
  activities: DatasetActivityCandidate[];
  identity?: string;
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new CortexClientError("validation", `${label} must be a JSON array of strings`);
  const items = value.map((item) => String(item).trim()).filter(Boolean);
  if (items.length > 50) throw new CortexClientError("validation", `${label} accepts at most 50 values`);
  return items.length ? items : undefined;
}

/** `--queries`: inline `a,b,c` or `@file` (JSON array of strings or query objects). */
export function parseDatasetQueriesArg(arg: string): DatasetSearchQuery[] {
  const text = arg.trim();
  if (!text) throw new CortexClientError("validation", "--queries is empty");
  const raw = readJsonArrayArg(text, "queries");
  let items: DatasetSearchQuery[];
  if (raw) {
    items = raw.map((value) =>
      typeof value === "string"
        ? { query: value }
        : {
            query: String((value as DatasetSearchQuery)?.query ?? ""),
            locations: stringArray((value as DatasetSearchQuery)?.locations, "query locations"),
            activityTypes: stringArray((value as DatasetSearchQuery)?.activityTypes, "query activityTypes"),
            identity: opaqueIdentity((value as DatasetSearchQuery)?.identity, "query identity"),
          },
    );
  } else {
    items = text.split(",").map((query) => ({ query: query.trim() }));
  }
  items = items.map((item) => ({ ...item, query: item.query.trim() })).filter((item) => item.query);
  if (!items.length) throw new CortexClientError("validation", "no queries given");
  if (items.length > MAX_QUERIES) throw new CortexClientError("validation", `at most ${MAX_QUERIES} queries per call`);
  return items;
}

function isRelicDataset(value: unknown): value is RelicDataset {
  const dataset = value as RelicDataset;
  return typeof dataset?.datasetRef === "string" &&
    typeof dataset?.id === "string" &&
    typeof dataset?.source?.code === "string" &&
    typeof dataset?.systemModel?.code === "string";
}

function isRelicActivities(value: unknown): value is RelicActivity[] {
  return Array.isArray(value) && value.every((activity: RelicActivity) =>
    typeof activity?.activityRef === "string" &&
    (typeof activity?.activityUuid === "string" || activity?.activityUuid === null) &&
    (typeof activity?.fallbackId === "string" || activity?.fallbackId === null) &&
    Array.isArray(activity?.datasets) &&
    activity.datasets.every(isRelicDataset),
  );
}

export function normalizeDatasetActivities(activities: RelicActivity[]): DatasetActivityCandidate[] {
  return activities.map((activity) => ({
    activityRef: activity.activityRef,
    activityUuid: activity.activityUuid,
    fallbackId: activity.fallbackId,
    name: activity.name,
    referenceProduct: activity.referenceProduct,
    datasets: activity.datasets.map((dataset) => ({
      datasetRef: dataset.datasetRef,
      id: dataset.id,
      version: dataset.version,
      source: { code: dataset.source.code, version: dataset.source.version },
      model: dataset.systemModel.code,
      location: dataset.location ? { id: dataset.location.id, ...(dataset.location.name ? { name: dataset.location.name } : {}) } : null,
    })),
  }));
}

async function searchOne(
  source: string,
  version: string,
  model: string,
  locale: string,
  query: DatasetSearchQuery,
  limit: number,
): Promise<DatasetSearchResult> {
  const activities = await relicPost<RelicActivity[]>(
    "search",
    "search-datasets",
    datasetSearchBody(source, version, model, locale, query, limit),
    isRelicActivities,
  );
  return {
    query: query.query,
    source: { code: source, version },
    model,
    activities: normalizeDatasetActivities(activities),
    ...(query.identity ? { identity: query.identity } : {}),
  };
}

export function datasetSearchBody(
  source: string,
  version: string,
  model: string,
  locale: string,
  query: DatasetSearchQuery,
  limit: number,
): Record<string, unknown> {
  return {
    locale,
    query: query.query,
    filters: {
      sources: [{ code: source, version }],
      models: [model],
      ...(query.locations ? { locations: query.locations } : {}),
      ...(query.activityTypes ? { activityTypes: query.activityTypes } : {}),
    },
    page: { limit },
  };
}

export async function runSearchDatasets(
  source: string,
  version: string,
  model: string,
  locale: string,
  queries: DatasetSearchQuery[],
  limit: number,
): Promise<DatasetSearchResult[]> {
  requireCredential();
  if (!model.trim()) throw new CortexClientError("validation", "--model is empty");
  if (!locale.trim()) throw new CortexClientError("validation", "--locale is empty");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new CortexClientError("validation", "--limit must be an integer from 1 to 20");
  }
  const out: DatasetSearchResult[] = new Array(queries.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queries.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= queries.length) return;
      out[index] = await searchOne(source, version, model, locale, queries[index], limit);
    }
  });
  await Promise.all(workers);
  return out;
}

function displayName(names: RelicName | undefined, locale: string): string {
  if (!names) return "";
  if ("value" in names) return names.value;
  return names[locale] ?? names.zh_CN ?? names.en_US ?? names._ ?? "";
}

export function formatSearchDatasets(results: DatasetSearchResult[], locale = "zh_CN"): string {
  const lines: string[] = [];
  for (const result of results) {
    lines.push(`${result.query}  [${result.source.code} ${result.source.version} · ${result.model}]`);
    if (!result.activities.length) {
      lines.push("  (无直接目录候选)");
      continue;
    }
    for (const activity of result.activities) {
      const product = displayName(activity.referenceProduct?.name, locale);
      lines.push(`  ${displayName(activity.name, locale)}  ${product}${activity.referenceProduct?.unit ? ` · ${activity.referenceProduct.unit}` : ""}`);
      for (const dataset of activity.datasets) {
        lines.push(`    ${dataset.datasetRef}  ${dataset.location?.id ?? "-"}`);
      }
    }
  }
  return lines.join("\n");
}
