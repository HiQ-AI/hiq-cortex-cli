import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("..", import.meta.url));
test("CLI identity, login lifecycle and local package integrity", { timeout: 120_000 }, async t => {
  const expectedVersion = JSON.parse(await readFile(join(repo, "package.json"), "utf8")).version;
  const root = await mkdtemp(join(tmpdir(), "lca-background-data-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const credentials = join(configDir, "lca-background-data", "credentials.json");
  await mkdir(dirname(credentials), { recursive: true });
  await writeFile(credentials, JSON.stringify({ token: "fixture-user-token" }), { mode: 0o600 });
  const requests: { path: string; query: Record<string, string>; auth: string | undefined; apiKey: string | undefined }[] = [];
  let oauthRequest: unknown;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    if (url.pathname.startsWith("/api/cortex/oauth/")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      if (url.pathname.endsWith("device_authorization")) {
        oauthRequest = JSON.parse(body);
        res.end(JSON.stringify({ device_code: "fixture-device", user_code: "TEST-ONLY", verification_uri_complete: "https://example.invalid/approve", interval: 0 }));
      } else res.end(JSON.stringify({ access_token: "fixture-device-token", owner: "member-1", scope: "cortex_data" }));
      return;
    }
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, apiKey: req.headers["x-api-key"] as string | undefined });
    res.setHeader("content-type", "application/json");
    res.writeHead(404).end('{"message":"unexpected route"}');
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(done => server.close(() => done())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  // Keep only process/runtime necessities. Never inherit real HIQ credentials.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: configDir, LCA_BACKGROUND_DATA_BASE: base, LCA_BACKGROUND_DATA_OAUTH_URL: `${base}/api/cortex/oauth` };
  const cli = join(repo, "dist", "cli.js");
  async function run(args: string[], entry = cli, overrides: Record<string, string> = {}) {
    try {
      const result = await exec(process.execPath, [entry, ...args], { env: { ...env, ...overrides }, timeout: 12_000, signal: t.signal });
      return { code: 0, ...result };
    } catch (error) {
      const e = error as Error & { code: number; stdout: string; stderr: string };
      if (typeof e.code !== "number") throw error;
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  }
  await t.test("help stays local and exposes only LCA commands", async () => {
    for (const args of [["--help"], ["search", "--help"], ["doctor", "--help"]]) {
      const result = await run(args);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /lca-background-data/);
      assert.doesNotMatch(result.stdout, /knowledge|--org/u);
    }
    assert.equal(requests.length, 0);
  });
  await t.test("new identity ignores old credential stores and environment names", async () => {
    for (const dir of [join(root, ".hiq"), join(root, ".config", "hiq-cortex")]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "credentials.json"), JSON.stringify({ token: "fixture-old-identity-token" }));
    }
    const before = requests.length;
    const result = await run(["doctor"], cli, {
      XDG_CONFIG_HOME: "", HIQ_API_KEY: "fixture-old-api-key", HIQ_CORTEX_BASE: "http://127.0.0.1:1",
    });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stdout, /lca-background-data login/);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-old|127\.0\.0\.1:1|hiq-cortex/);
    assert.equal(requests.length, before, "missing credentials must not contact a service");
    const version = await run(["version"]);
    assert.equal(version.code, 0);
    assert.equal(version.stdout.trim(), expectedVersion);
  });
  await t.test("new API key overrides only the new native identity store", async () => {
    const result = await run(["search-datasets", "--source", "hiqlcd", "--ver", "1.5.0", "--queries", "fixture"], cli, {
      LCA_BACKGROUND_DATA_API_KEY: "fixture-new-api-key", HIQ_API_KEY: "fixture-old-api-key",
    });
    assert.notEqual(result.code, 0, "fixture endpoint deliberately rejects the query");
    assert.equal(requests.at(-1)?.apiKey, "fixture-new-api-key");
    assert.equal(requests.at(-1)?.auth, undefined);
  });
  await t.test("device login uses explicit consent and writes only selected native store", async () => {
    const isolated = join(root, "login-config");
    const result = await run(["login", "--json"], cli, { XDG_CONFIG_HOME: isolated });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(oauthRequest, {
      agent_id: "lca-background-data", agent_name: "LCA Background Data CLI", scope: "cortex_data",
      client_skill: "lca-background-data", client_host: "cli", client_version: expectedVersion,
    });
    const path = join(isolated, "lca-background-data", "credentials.json");
    assert.equal(JSON.parse(result.stdout).credentials, path);
    assert.equal(JSON.parse(await readFile(path, "utf8")).token, "fixture-device-token");
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(result.stdout.includes("fixture-device-token"), false);
    const logout = await run(["logout", "--json"], cli, { XDG_CONFIG_HOME: isolated });
    assert.equal(logout.code, 0);
    assert.equal(JSON.parse(logout.stdout).removed, true);
    assert.equal(JSON.parse(await readFile(credentials, "utf8")).token, "fixture-user-token");
  });
  await t.test("packed LCA CLI installs cleanly without Wiki assets", { timeout: 60_000 }, async packageTest => {
    const npm = process.env.npm_execpath;
    assert.ok(npm, "run this suite through npm test");
    // An incremental checkout can still contain the removed module's output.
    await writeFile(join(repo, "dist", "knowledge.js"), "// obsolete build artifact\n");
    await exec(process.execPath, [npm, "run", "build"], { cwd: repo, env, signal: packageTest.signal });
    const packed = await exec(process.execPath, [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: repo, env, signal: packageTest.signal });
    const metadata = JSON.parse(packed.stdout)[0];
    assert.ok(metadata.files.every((f: { path: string }) => !/knowledge|skills\//u.test(f.path)));
    assert.ok(metadata.files.every((f: { path: string }) => !/(credentials|\.env)/u.test(f.path)));
    const install = join(root, "install");
    await mkdir(install);
    await writeFile(join(install, "package.json"), '{"name":"cortex-install-fixture","private":true}');
    await exec(process.execPath, [npm, "install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", join(root, metadata.filename)], { cwd: install, env, signal: packageTest.signal });
    const manifestPath = join(install, "node_modules", "@hiq-ai", "lca-background-data", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.name, "@hiq-ai/lca-background-data");
    assert.equal(manifest.private, true);
    assert.deepEqual(Object.keys(manifest.bin), ["lca-background-data"]);
    const installedCli = resolve(dirname(manifestPath), manifest.bin["lca-background-data"]);
    const help = await run(["--help"], installedCli);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /search-datasets|verify-flows/u);
    assert.doesNotMatch(help.stdout, /knowledge|--org/u);
  });
  assert.ok(requests.every(request => !request.path.includes("/mcp")));
});
