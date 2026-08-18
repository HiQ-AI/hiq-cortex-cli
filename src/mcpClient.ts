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
    throw new CortexClientError(
      "transport",
      `cannot reach the Cortex API (${config.mcpUrl}): ${(err as Error).message}`,
    );
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
