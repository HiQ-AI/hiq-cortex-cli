/**
 * `hiq-cortex login` — QR / device-flow sign-in, so a user can start querying
 * without registering for an API key first. Runs the deck OAuth device flow
 * (RFC 8628, scope `lca_data`): prints a QR + authorize link, the user approves
 * on cortex.hiq.earth, and the flow returns their SSO accessToken. The visible
 * data scope equals that account's — including any commercial databases they
 * have entitlements for. `hiq-cortex logout` deletes the stored credential.
 *
 * An API key (HIQ_API_KEY) still wins when both are present; that is the
 * server-side / CI path.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CortexClientError } from "./types.js";
import { VERSION } from "./version.js";

const OAUTH_BASE = (
  process.env.HIQ_CORTEX_OAUTH_URL?.trim() || "https://x.hiqlcd.com/api/cortex/oauth"
).replace(/\/+$/, "");

export function credentialsPath(): string {
  return join(homedir(), ".config", "hiq-cortex", "credentials.json");
}

/** Where the Python client (`cortex.py login`) used to store its credential.
 *  Read-only fallback so people who signed in with the old script are not asked
 *  to scan again. We never write here. */
function legacyCredentialsPath(): string {
  return join(homedir(), ".hiq", "credentials.json");
}

function tokenFrom(path: string): string {
  try {
    const j = JSON.parse(readFileSync(path, "utf-8")) as { token?: unknown; access_token?: unknown };
    const v = j.token ?? j.access_token;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

/** Token from a previous `hiq-cortex login`, falling back to the old Python
 *  client's credential file. "" when neither exists — config.ts's fallback. */
export function readStoredToken(): string {
  return tokenFrom(credentialsPath()) || tokenFrom(legacyCredentialsPath());
}

interface DeviceAuthz {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in?: number;
  interval?: number;
}

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function runLogin(json: boolean): Promise<void> {
  const resp = await postJson(`${OAUTH_BASE}/device_authorization`, {
    // agent_id 是稳定机器标识;授权页对已知 id 显示本地化名(HiQ 数据集编辑器 CLI /
    // HiQ Cortex CLI),agent_name 只是未收录时的回落。
    agent_id: "hiq-cortex-cli",
    agent_name: "HiQ Cortex CLI",
    // 查询侧:授权页文案写的就是「查询 LCA 数据」,与本 CLI 的能力一致。
    scope: "lca_data",
    client_skill: "hiq-cortex-cli",
    client_host: process.env.HIQ_CORTEX_CLIENT_HOST?.trim() || "cli",
    client_version: VERSION,
  });
  if (!resp.ok) {
    throw new CortexClientError(
      "transport",
      `device_authorization failed: HTTP ${resp.status} ${await resp.text()}`,
    );
  }
  const d = (await resp.json()) as DeviceAuthz;
  const url = d.verification_uri_complete;

  // Progress/UI on stderr — stdout stays reserved for the final result.
  const qrcode = (await import("qrcode-terminal")).default;
  await new Promise<void>((resolve) => {
    qrcode.generate(url, { small: true }, (q: string) => {
      process.stderr.write(q + "\n");
      resolve();
    });
  });
  process.stderr.write(
    `Scan the QR code, or open the link to authorize (code ${d.user_code}):\n${url}\nWaiting for approval...\n`,
  );

  const deadline = Date.now() + (d.expires_in ?? 600) * 1000;
  const intervalMs = Math.max(d.interval ?? 5, 2) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const tr = await postJson(`${OAUTH_BASE}/token`, { device_code: d.device_code });
    if (tr.status === 428) continue; // authorization_pending — keep polling
    if (!tr.ok) {
      throw new CortexClientError("upstream", `authorization failed: HTTP ${tr.status} ${await tr.text()}`);
    }
    const tok = (await tr.json()) as { access_token: string; owner?: string; scope?: string };
    const p = credentialsPath();
    mkdirSync(join(homedir(), ".config", "hiq-cortex"), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify(
        { token: tok.access_token, owner: tok.owner ?? null, scope: tok.scope ?? null, obtained_at: new Date().toISOString() },
        null,
        2,
      ) + "\n",
    );
    chmodSync(p, 0o600);
    process.stdout.write(
      json
        ? JSON.stringify({ ok: true, owner: tok.owner ?? null, credentials: p }) + "\n"
        : `Signed in${tok.owner ? ` as ${tok.owner}` : ""}. Credentials stored at ${p}\n`,
    );
    return;
  }
  throw new CortexClientError("upstream", "authorization timed out — run `hiq-cortex login` again.");
}

export function runLogout(json: boolean): void {
  const p = credentialsPath();
  const had = existsSync(p);
  if (had) unlinkSync(p);
  process.stdout.write(
    json
      ? JSON.stringify({ ok: true, removed: had }) + "\n"
      : had
        ? "Signed out — stored credentials removed.\n"
        : "No stored credentials.\n",
  );
}
