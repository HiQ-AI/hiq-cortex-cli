/**
 * `search` — material / BOM line → candidate datasets.
 *
 * The only capability without an MCP tool: it is a REST endpoint that streams
 * SSE while a server-side workflow searches the catalogs and verifies each hit.
 * That verification is why it takes 20–40 seconds; it is not a hang, and
 * retrying in parallel only adds load.
 *
 * Server-side is also where the domain judgement lives — translating a BOM
 * line into LCA terminology, identifying production routes, ranking candidates.
 * This client just posts the user's own wording and relays what comes back.
 */
import { authHeaders, config, hasCredential } from "./config.js";
import { CortexClientError } from "./types.js";
import { VERSION } from "./version.js";

const SEARCH_TIMEOUT_MS = 180_000;

export interface SearchDataset {
  material?: string;
  key?: string;
  name?: string;
  link?: string;
  loc?: string;
  unit?: string;
  src?: string;
  ver?: string;
  model?: string;
  ref_product?: string;
  restricted?: boolean;
  fit?: string;
  gwp?: number;
  gwp_unit?: string;
  dqi?: unknown;
  [k: string]: unknown;
}

export interface SearchResult {
  status?: string;
  summary?: string;
  datasets?: SearchDataset[];
  restricted_count?: number;
  verified_count?: number;
  [k: string]: unknown;
}

/** Pull `data: {...}` payloads out of an SSE body. */
function* sseEvents(raw: string): Generator<Record<string, unknown>> {
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const body = line.slice(6).trim();
    if (!body.startsWith("{")) continue;
    try {
      yield JSON.parse(body) as Record<string, unknown>;
    } catch {
      /* partial frame — skip */
    }
  }
}

export async function runSearch(query: string, sources?: string): Promise<SearchResult> {
  if (!hasCredential()) {
    throw new CortexClientError(
      "config",
      "No credential. Run `hiq-cortex login` (one browser click, no registration), " +
        "or set HIQ_API_KEY=sk_… for server-side use.",
    );
  }
  const form = new URLSearchParams({ query });
  if (sources) form.set("sources", sources);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SEARCH_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(config.searchUrl, {
      method: "POST",
      headers: {
        ...authHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": `hiq-cortex-cli/${VERSION}`,
      },
      body: form.toString(),
      signal: ctl.signal,
    });
  } catch (err) {
    throw new CortexClientError(
      "transport",
      (err as Error).name === "AbortError"
        ? "search timed out after 180s — the server normally answers in 20–40s."
        : `cannot reach the search endpoint: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const raw = await resp.text();
  if (resp.status === 401 || resp.status === 403) {
    // 不是「服务端拒绝这次请求」(那是 upstream,改参数没用),是凭据本身不行 —— 
    // 该去重新登录,所以按 config 报。
    throw new CortexClientError(
      "config",
      `the search endpoint rejected this credential (HTTP ${resp.status}). ` +
        `Run \`hiq-cortex login\` again, or check HIQ_API_KEY. ${raw.slice(0, 200)}`,
    );
  }
  if (!resp.ok) {
    throw new CortexClientError("upstream", `search failed: HTTP ${resp.status} ${raw.slice(0, 300)}`);
  }
  for (const ev of sseEvents(raw)) {
    if (ev.event !== "WorkflowCompleted") continue;
    try {
      return JSON.parse(String(ev.content ?? "{}")) as SearchResult;
    } catch {
      throw new CortexClientError("upstream", `cannot parse search result: ${String(ev.content).slice(0, 200)}`);
    }
  }
  throw new CortexClientError(
    "upstream",
    "search did not complete. 20–40s is normal; if this persists, retry once.",
  );
}

/** Human-readable rendering. Every row carries its link — that is the whole
 *  point of showing results to a person, and the opaque `key` is not. */
export function formatSearch(r: SearchResult): string {
  const out: string[] = [];
  if (r.summary) out.push(r.summary, "");
  const rows = r.datasets ?? [];
  if (!rows.length) {
    out.push("没有找到候选数据集。换个说法或放宽关键词再试。");
    return out.join("\n");
  }
  for (const d of rows) {
    const basis = [d.src, d.ver, d.model, d.loc].filter(Boolean).join(" · ");
    const gwp =
      d.restricted
        ? "数值受限(该库需数据包权益)"
        : d.gwp !== undefined
          ? `${d.gwp} ${d.gwp_unit ?? ""}`.trim()
          : "无 headline GWP";
    out.push(
      `▸ ${d.name ?? "(无名)"}${d.fit ? `   [匹配度 ${d.fit}]` : ""}`,
      `  参考流: ${d.ref_product ?? "-"}${d.unit ? `   单位: ${d.unit}` : ""}`,
      `  基准:   ${basis || "-"}`,
      `  GWP:    ${gwp}`,
      `  链接:   ${d.link ?? "-"}`,
      "",
    );
  }
  const n = r.restricted_count ?? 0;
  if (n > 0) {
    out.push(
      `其中 ${n} 条来自需要数据包权益的商业库。免费库(BAFU / ELCD / EF / worldsteel / USLCI 等)`,
      `可能覆盖同一问题 —— 用 --sources 指定即可;要开通商业库见 https://carbonx.hiqlcd.com/price`,
    );
  }
  return out.join("\n");
}
