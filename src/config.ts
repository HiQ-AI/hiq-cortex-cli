/**
 * Runtime config, read once at process start.
 *
 *   HIQ_API_KEY        — API key (sk_…) for server-side / CI use. Wins over a
 *                        stored `hiq-cortex login` credential.
 *   HIQ_CORTEX_BASE    — override the API base (default https://x.hiqlcd.com).
 *
 * Credential precedence matches every other HiQ client: host/CI env first,
 * then whatever `login` stored. Nothing is ever written back to the env.
 */
import { readStoredToken } from "./login.js";

const DEFAULT_BASE = "https://x.hiqlcd.com";

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface Config {
  /** API base, no trailing slash. */
  base: string;
  /** MCP endpoint for the tool-backed subcommands. */
  mcpUrl: string;
  /** REST search endpoint (SSE) — the one capability with no MCP tool. */
  searchUrl: string;
  /** OAuth device-flow base. */
  oauthUrl: string;
  /** `sk_…` API key, or "" when signing in via `login`. */
  apiKey: string;
  /** SSO token from a previous `login`, or "". */
  ssoToken: string;
}

const base = stripTrailingSlash(process.env.HIQ_CORTEX_BASE?.trim() || DEFAULT_BASE);

export const config: Config = {
  base,
  mcpUrl: `${base}/api/cortex/mcp`,
  searchUrl: `${base}/api/cortex/search`,
  oauthUrl: `${base}/api/cortex/oauth`,
  apiKey: process.env.HIQ_API_KEY?.trim() || "",
  ssoToken: readStoredToken(),
};

/** True when we have some way to authenticate. */
export function hasCredential(): boolean {
  return Boolean(config.apiKey || config.ssoToken);
}

/**
 * Auth headers. API key and SSO token are two different credentials and the
 * edge routes them differently — an API key goes in `X-API-Key`, a login
 * credential in `Authorization: Bearer`. Never send both.
 */
export function authHeaders(): Record<string, string> {
  if (config.apiKey) return { "X-API-Key": config.apiKey };
  if (config.ssoToken) return { Authorization: `Bearer ${config.ssoToken}` };
  return {};
}
