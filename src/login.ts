/**
 * `lca-background-data login` — QR / device-flow sign-in, so a user can start querying
 * without registering for an API key first. Runs the deck OAuth device flow
 * (RFC 8628, scope `cortex_data`): prints a QR + authorize link, the user approves
 * on cortex.hiq.earth, and the flow returns their SSO accessToken. The visible
 * data scope equals that account's — including any commercial databases they
 * have entitlements for. `lca-background-data logout` deletes the stored credential.
 *
 * An API key (LCA_BACKGROUND_DATA_API_KEY) still wins when both are present; that is the
 * server-side / CI path.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { CortexClientError } from "./types.js";
import { VERSION } from "./version.js";

const OAUTH_BASE = (
  process.env.LCA_BACKGROUND_DATA_OAUTH_URL?.trim() || "https://x.hiqlcd.com/api/cortex/oauth"
).replace(/\/+$/, "");

export function credentialsPath(): string {
  return join(configHome() ?? join(homedir(), ".config"), "lca-background-data", "credentials.json");
}

function configHome(): string | undefined {
  const path = process.env.XDG_CONFIG_HOME?.trim();
  return path && isAbsolute(path) ? path : undefined;
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

/** Read only this CLI's selected identity store; never import another client's login. */
export function readStoredToken(): string {
  return tokenFrom(credentialsPath());
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
    // LCA Background Data CLI),agent_name 只是未收录时的回落。
    agent_id: "lca-background-data",
    agent_name: "LCA Background Data CLI",
    // 授权页同时说明 LCA / 组织知识读取，以及实际交付完整 SSO 登录态。
    // 这不是技术上限定权限的 token；组织读取仍由服务端逐次鉴权。
    scope: "cortex_data",
    client_skill: "lca-background-data",
    client_host: process.env.LCA_BACKGROUND_DATA_CLIENT_HOST?.trim() || "cli",
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
    mkdirSync(dirname(p), { recursive: true });
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
  throw new CortexClientError("upstream", "authorization timed out — run `lca-background-data login` again.");
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
