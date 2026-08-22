/**
 * Shared HTTP path for the relic-backed authoring commands (`verify-flows`,
 * `search-flows`, `verify-datasets`). They all go straight to `/api/relic/*` —
 * the edge passes the credential through and relic checks it itself; no MCP
 * tool involved. One place for credential gating, timeout, auth-rejection and
 * envelope unwrapping so the three commands cannot drift on error semantics.
 */
import { readFileSync } from "node:fs";
import { authHeaders, config, hasCredential } from "./config.js";
import { CortexClientError } from "./types.js";
import { VERSION } from "./version.js";

const TIMEOUT_MS = 60_000;

export function requireCredential(extra = ""): void {
  if (hasCredential()) return;
  throw new CortexClientError(
    "config",
    "No credential. Run `hiq-cortex login` (one browser click, no registration), " +
      "or set HIQ_API_KEY=sk_… for server-side use." +
      (extra ? ` ${extra}` : ""),
  );
}

/**
 * POST `/api/relic/<path>` and return the unwrapped `data`. `isShape` guards the
 * envelope so a proxy HTML page or a changed contract fails loudly, not as NaN.
 */
export async function relicPost<T>(
  path: string,
  label: string,
  body: unknown,
  isShape: (d: unknown) => d is T,
): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(`${config.base}/api/relic/${path}`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json", "User-Agent": `hiq-cortex-cli/${VERSION}` },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (err) {
    throw new CortexClientError(
      "transport",
      (err as Error).name === "AbortError"
        ? `${label} timed out after ${TIMEOUT_MS / 1000}s`
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
    throw new CortexClientError("upstream", `${label} failed: HTTP ${resp.status} ${raw.slice(0, 300)}`, code);
  }
  let parsed: { data?: unknown };
  try {
    parsed = JSON.parse(raw) as { data?: unknown };
  } catch {
    throw new CortexClientError("upstream", `cannot parse relic response: ${raw.slice(0, 200)}`);
  }
  if (!isShape(parsed.data)) {
    throw new CortexClientError("upstream", `unexpected relic response shape: ${raw.slice(0, 200)}`);
  }
  return parsed.data;
}

/** Parse a `@file` JSON-array argument or return null when the arg is inline. */
export function readJsonArrayArg(arg: string, what: string): unknown[] | null {
  if (!arg.startsWith("@")) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(arg.slice(1), "utf-8"));
  } catch (err) {
    throw new CortexClientError("validation", `cannot read ${arg.slice(1)}: ${(err as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new CortexClientError("validation", `${what} file must be a JSON array`);
  return raw;
}
