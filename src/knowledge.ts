/** Read-only organization Wiki REST client. Content is returned as data, never executed. */
import { config } from "./config.js";
import { CortexClientError } from "./types.js";
import { VERSION } from "./version.js";

export interface KnowledgeOptions { org: string }
export type KnowledgeCommand = "search" | "read" | "links" | "sources";
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);

function endpoint(options: KnowledgeOptions, path: string, query: Record<string, string | undefined> = {}): URL {
  if (!options.org.trim()) throw new CortexClientError("validation", "--org 必须是已选择的组织 ID");
  const url = new URL(`${config.base}/api/cortex${path}`);
  url.searchParams.set("organization_id", options.org);
  for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
  return url;
}

async function getData(url: URL): Promise<JsonObject> {
  // API keys do not establish a current organization member. Do not silently
  // switch to another stored account while an explicit API key is selected.
  if (config.apiKey || !config.ssoToken) {
    throw new CortexClientError("config", "组织知识需要用户登录；取消 HIQ_API_KEY 后运行 hiq-cortex login。");
  }
  let response: Response;
  let raw: string;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${config.ssoToken}`, Accept: "application/json", "User-Agent": `hiq-cortex-cli/${VERSION}` },
      signal: AbortSignal.timeout(60_000),
      redirect: "error",
    });
    raw = await response.text();
  } catch (error) {
    throw new CortexClientError("transport", `无法读取组织知识：${(error as Error).message}`);
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { /* HTTP status still determines the error kind. */ }
  if (!response.ok) {
    const kind = response.status === 401 || response.status === 403 ? "config"
      : response.status === 400 || response.status === 422 ? "validation" : "upstream";
    const detail = object(body) && typeof body.message === "string" ? body.message
      : object(body) && typeof body.detail === "string" ? body.detail : "请求未完成";
    const code = object(body) && typeof body.error === "string" ? body.error : undefined;
    throw new CortexClientError(kind, `组织知识 HTTP ${response.status}：${detail}`, code);
  }
  if (!object(body) || !object(body.data)) throw new CortexClientError("upstream", "组织知识响应缺少 data 对象");
  return body.data;
}

export async function organizationIdentity(options: KnowledgeOptions): Promise<JsonObject> {
  const data = await getData(endpoint(options, "/organization"));
  if (typeof data.user_id !== "string" || data.organization_id !== options.org || typeof data.is_organization_admin !== "boolean") {
    throw new CortexClientError("upstream", "组织身份响应与所选组织不一致或不完整");
  }
  return data;
}

export async function readKnowledge(
  command: KnowledgeCommand,
  value: string,
  options: KnowledgeOptions & { revision?: string; tag?: string; after?: string; limit?: number },
): Promise<JsonObject> {
  let url: URL;
  if (command === "search") {
    if (!value.trim()) throw new CortexClientError("validation", "搜索内容不能为空");
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) {
      throw new CortexClientError("validation", "--limit 必须是 1 到 100 的整数");
    }
    url = endpoint(options, "/wiki/organization/pages", { q: value, tag: options.tag, after: options.after, limit: options.limit?.toString() });
  } else {
    if (!value || value === "." || value === ".." || /[\/\\\0]/u.test(value)) {
      throw new CortexClientError("validation", "页面 ID 必须是单个稳定身份，不能是文件路径");
    }
    const suffix = command === "read" ? "" : `/${command}`;
    url = endpoint(options, `/wiki/organization/pages/${encodeURIComponent(value)}${suffix}`, { revision: options.revision });
  }
  const data = await getData(url);
  const valid = command === "search" ? Array.isArray(data.pages) && typeof data.version === "number" && (data.nextCursor === null || typeof data.nextCursor === "string")
    : typeof data.revision === "string" && (command === "read" ? typeof data.markdown === "string"
      : command === "links" ? Array.isArray(data.incoming) && Array.isArray(data.outgoing) : Array.isArray(data.sources));
  if (!valid) throw new CortexClientError("upstream", `组织知识 ${command} 响应不完整`);
  if (options.revision !== undefined && data.revision !== options.revision) {
    throw new CortexClientError("upstream", "服务返回了其他页面版本，请重新读取所选 revision");
  }
  if (command === "sources") {
    data.sources = (data.sources as unknown[]).map(source => {
      if (!object(source) || typeof source.materialId !== "string" || !/^[1-9][0-9]*$/u.test(source.materialId)) {
        throw new CortexClientError("upstream", "组织知识来源缺少材料身份");
      }
      return { ...source, downloadUrl: endpoint(options, `/wiki/organization/sources/${source.materialId}/download`).toString() };
    });
  }
  return data;
}

export function formatKnowledge(command: KnowledgeCommand, data: JsonObject): string {
  if (command === "read") return `revision: ${data.revision}\n\n${data.markdown}`;
  if (command === "search") {
    const pages = data.pages as unknown[];
    const lines = [`知识版本: ${data.version}`];
    for (const page of pages) {
      if (!object(page)) throw new CortexClientError("upstream", "组织知识搜索返回了无效页面");
      lines.push(`\n${page.title}  [${page.nodeid}]`, `revision: ${page.revision}`, String(page.summary ?? ""));
    }
    if (!pages.length) lines.push("当前组织没有匹配的已发布知识。");
    if (data.nextCursor) lines.push(`\n下一页: --after ${data.nextCursor}`);
    return lines.join("\n");
  }
  return JSON.stringify(data, null, 2);
}
