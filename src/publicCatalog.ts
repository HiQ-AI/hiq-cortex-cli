import { relicRequest } from "./relicClient.js";
import { CortexClientError } from "./types.js";
import type { SourceScope } from "./sourceScope.js";

interface Source {
  code: string;
  versions: { version: string; models: { code: string }[] }[];
  [key: string]: unknown;
}
interface Envelope<T> {
  data: T[];
  meta?: unknown;
  page?: unknown;
}

export async function runSources(scope?: SourceScope): Promise<Envelope<Source>> {
  const envelope = await relicRequest<Envelope<Source>>("sources", "sources", undefined,
    (value): value is Envelope<Source> => Array.isArray((value as Envelope<Source>)?.data) &&
      (value as Envelope<Source>).data.every(source => typeof source?.code === "string" && Array.isArray(source.versions)), "GET");
  if (!scope) return envelope;
  if (scope.code === "epd") throw new CortexClientError("validation", "EPD publishers are separate from background dataset sources");
  const data = envelope.data.filter(source => source.code === scope.code);
  if (!data.length) throw new CortexClientError("upstream", `Source ${scope.code} is not published in the current catalog`);
  return { ...envelope, data };
}

export async function runEpdSearch(query: string, publishers: string | undefined, limit: number, cursor?: string): Promise<Envelope<Record<string, unknown>>> {
  if (!query.trim()) throw new CortexClientError("validation", "--query must not be empty");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CortexClientError("validation", "--limit must be an integer from 1 to 100");
  const ptSources = publishers?.split(",").map(value => value.trim()).filter(Boolean);
  return relicRequest<Envelope<Record<string, unknown>>>("epd/search", "epd-search", {
    query,
    filters: ptSources?.length ? { ptSources } : {},
    page: { limit, ...(cursor ? { cursor } : {}) },
  }, (value): value is Envelope<Record<string, unknown>> => Array.isArray((value as Envelope<Record<string, unknown>>)?.data) &&
    (value as Envelope<Record<string, unknown>>).data.every(record => typeof record?.epd_key === "string" &&
      typeof (record.source as { pt_source?: unknown })?.pt_source === "string"));
}
