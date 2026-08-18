/**
 * Thin MCP client for the Cortex tool endpoint.
 *
 * Why MCP and not REST: the query capabilities (lookup / aggregate / indicators /
 * hotspot / EPD) are published there as tools with JSON Schemas, which lets the
 * CLI generate its subcommands and flags at runtime — no schema copy in this
 * package to drift when the server adds a field. Search is the one exception
 * (REST + SSE, see search.ts).
 *
 * This is an implementation detail. Users never see an MCP endpoint.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import { authHeaders, config, hasCredential } from "./config.js";
import { CortexClientError } from "./types.js";
import { VERSION } from "./version.js";

/** Aggregations over big cohorts are the slow path; be generous. */
const REQUEST_TIMEOUT_MS = 120_000;

let clientPromise: Promise<Client> | undefined;

function requireCredential(): void {
  if (!hasCredential()) {
    throw new CortexClientError(
      "config",
      "No credential. Run `hiq-cortex login` (one browser click, no registration), " +
        "or set HIQ_API_KEY=sk_… for server-side use.",
    );
  }
}

export function getClient(): Promise<Client> {
  requireCredential();
  if (!clientPromise) {
    clientPromise = connect().catch((err) => {
      clientPromise = undefined; // don't cache a rejected promise
      throw err;
    });
  }
  return clientPromise;
}

/** 认出「凭据被拒」:优先看 SDK 带出来的 HTTP 状态,没有就从响应体文本里认
 *  401/403。只认这两个码 —— 其余一律算连接问题,宁可少判也不误判。 */
function isAuthRejection(err: unknown, msg: string): boolean {
  const e = err as { status?: number; code?: number } | undefined;
  if (e?.status === 401 || e?.status === 403) return true;
  if (e?.code === 401 || e?.code === 403) return true;
  return /\b(401|403)\b/.test(msg);
}

async function connect(): Promise<Client> {
  const client = new Client(
    { name: "hiq-cortex-cli", version: VERSION },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(new URL(config.mcpUrl), {
    requestInit: {
      headers: {
        ...authHeaders(),
        // Some CDNs reject default HTTP-client UAs (observed: error 1010).
        "User-Agent": `hiq-cortex-cli/${VERSION}`,
      },
    },
  });
  try {
    await client.connect(transport);
  } catch (err) {
    const msg = (err as Error).message;
    // 「连不上」和「凭据被拒」要分开报:前者让人查网络,后者让人重新登录。
    // 都塞进 transport 的话,过期的凭据会被说成网络故障。
    if (isAuthRejection(err, msg)) {
      throw new CortexClientError(
        "config",
        `the Cortex API rejected this credential (401/403). Run \`hiq-cortex login\` again, ` +
          `or check HIQ_API_KEY. Server said: ${msg}`,
      );
    }
    throw new CortexClientError("transport", `cannot reach the Cortex API (${config.mcpUrl}): ${msg}`);
  }
  return client;
}

export async function listTools(): Promise<Tool[]> {
  const client = await getClient();
  const res = await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS });
  return res.tools ?? [];
}

/** Call one tool; returns its text payload (the tools return JSON strings). */
export async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const client = await getClient();
  let res;
  try {
    res = await client.callTool({ name, arguments: args }, undefined, {
      timeout: REQUEST_TIMEOUT_MS,
    });
  } catch (err) {
    throw new CortexClientError("upstream", `${name} failed: ${(err as Error).message}`);
  }
  const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text ?? "";
  if (res.isError) throw new CortexClientError("upstream", text || `${name} returned an error`);
  return text;
}
