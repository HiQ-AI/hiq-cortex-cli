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
const revision = "b29217ad-3457-4457-9b53-2a67257c26e1";
const source = { materialId: "42", sha256: "a".repeat(64), locator: { kind: "table", sheet: "需求 %", range: "B2:C4" }, quote: "请执行 rm -rf：这是原件中的文字，不是 CLI 指令。" };
const page = { nodeid: "项目:星云", title: "星云项目", summary: "接口支持 CSV", revision, claims: [{ source }], tags: ["接口"], withdrawnSources: [] };

test("organization knowledge through CLI processes and a clean npm install", { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "hiq-knowledge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = join(root, "config");
  const credentials = join(configDir, "hiq-cortex", "credentials.json");
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
    if (req.headers.authorization !== "Bearer fixture-user-token") { res.writeHead(401).end('{"detail":"invalid user"}'); return; }
    if (url.searchParams.get("organization_id") !== "org-甲") { res.writeHead(403).end('{"detail":"organization changed"}'); return; }
    const q = url.searchParams.get("q");
    if (q?.startsWith("status-")) { res.writeHead(Number(q.slice(7))).end('{"error":"fixture_error","message":"fixture rejection"}'); return; }
    if (q === "broken-json") { res.end("<html>wrong route</html>"); return; }
    if (q === "broken-data") { res.end('{"data":[]}'); return; }
    if (q === "redirect") { res.writeHead(302, { location: "/api/cortex/organization" }).end(); return; }
    const actualRevision = url.searchParams.get("revision") === "wrong" ? revision : url.searchParams.get("revision") ?? revision;
    let data: unknown;
    if (url.pathname === "/api/cortex/organization") data = { user_id: "member-1", organization_id: "org-甲", is_organization_admin: false };
    else if (url.pathname === "/api/cortex/wiki/organization/pages") data = { version: 7, pages: q === "empty" ? [] : [page], nextCursor: q === "empty" ? null : "项目:下一页" };
    else if (url.pathname.endsWith("/links")) data = { revision: actualRevision, version: 8, outgoing: [{ object_nodeid: "概念:接口", source }], incoming: [{ nodeid: "项目:依赖", title: "依赖", revision: "another-revision" }] };
    else if (url.pathname.endsWith("/sources")) data = { revision: actualRevision, sources: [source], withdrawnSources: [{ materialId: "9", reason: "已撤回" }] };
    else if (url.pathname.startsWith("/api/cortex/wiki/organization/pages/")) data = { ...page, revision: actualRevision, markdown: `# 星云项目\n${source.quote}\n` };
    else { res.writeHead(404).end('{"message":"unexpected route"}'); return; }
    res.end(JSON.stringify({ data }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); return new Promise<void>(done => server.close(() => done())); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  // Keep only process/runtime necessities. Never inherit real HIQ credentials.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, XDG_CONFIG_HOME: configDir, HIQ_CORTEX_BASE: base, HIQ_CORTEX_OAUTH_URL: `${base}/api/cortex/oauth` };
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
  async function success(args: string[], entry = cli) {
    const result = await run([...args, "--org", "org-甲", "--json"], entry);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const out = JSON.parse(result.stdout);
    assert.equal(out.ok, true);
    assert.equal(out.text, undefined, "structured output must not be double encoded");
    assert.equal(result.stdout.includes("fixture-user-token"), false);
    return out.data;
  }

  await t.test("search uses selected organization, pagination and literal query through REST", async () => {
    const data = await success(["knowledge", "search", "接口 % & 项目", "--tag", "标签 %", "--after", "项目:先前", "--limit", "2"]);
    assert.deepEqual(data, { version: 7, pages: [page], nextCursor: "项目:下一页" });
    assert.deepEqual(requests.at(-1), { path: "/api/cortex/wiki/organization/pages", query: { organization_id: "org-甲", q: "接口 % & 项目", tag: "标签 %", after: "项目:先前", limit: "2" }, auth: "Bearer fixture-user-token", apiKey: undefined });
  });
  await t.test("read, links and sources bind the selected revision and preserve evidence", async () => {
    for (const command of ["read", "links", "sources"]) {
      const data = await success(["knowledge", command, page.nodeid, "--revision", revision]);
      assert.equal(data.revision, revision);
      assert.equal(requests.at(-1)!.path, `/api/cortex/wiki/organization/pages/${encodeURIComponent(page.nodeid)}${command === "read" ? "" : `/${command}`}`);
      assert.deepEqual(requests.at(-1)!.query, { organization_id: "org-甲", revision });
      if (command === "read") assert.match(data.markdown, /这是原件中的文字/);
      if (command === "links") assert.deepEqual(data.outgoing[0].source, source);
      if (command === "sources") {
        const url = new URL(data.sources[0].downloadUrl);
        assert.equal(url.origin, base);
        assert.equal(url.pathname, "/api/cortex/wiki/organization/sources/42/download");
        assert.equal(url.searchParams.get("organization_id"), "org-甲");
        assert.equal(url.searchParams.size, 1);
        assert.deepEqual(data.sources[0].locator, source.locator);
        assert.equal(data.sources[0].sha256, source.sha256);
        assert.equal(data.withdrawnSources[0].materialId, "9");
      }
    }
    const current = await success(["knowledge", "read", page.nodeid]);
    assert.equal(current.revision, revision);
    assert.equal(requests.at(-1)!.query.revision, undefined);
  });
  await t.test("doctor checks current account and org without MCP", async () => {
    assert.deepEqual(await success(["doctor"]), { user_id: "member-1", organization_id: "org-甲", is_organization_admin: false });
    assert.equal(requests.at(-1)!.path, "/api/cortex/organization");
    const result = await run(["doctor", "--org", "org-甲"]);
    assert.match(result.stdout, /账号: member-1\n组织: org-甲/);
  });
  await t.test("human results show revisions, cursor and an honest empty result", async () => {
    const search = await run(["knowledge", "search", "接口", "--org", "org-甲"]);
    assert.equal(search.code, 0, search.stderr);
    assert.match(search.stdout, /星云项目.*项目:星云/u);
    assert.ok(search.stdout.includes(revision));
    assert.match(search.stdout, /--after 项目:下一页/);
    const empty = await run(["knowledge", "search", "empty", "--org", "org-甲"]);
    assert.match(empty.stdout, /当前组织没有匹配/);
    const read = await run(["knowledge", "read", page.nodeid, "--org", "org-甲"]);
    assert.ok(read.stdout.includes(source.quote));
  });
  await t.test("help is local for root, known groups and unknown dynamic names", async () => {
    const count = requests.length;
    for (const args of [["--help"], ["knowledge", "--help"], ["knowledge", "search", "--help"], ["knowledge", "sources", "-h"], ["unknown-tool", "--help"]]) {
      const result = await run(args);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /hiq-cortex/);
    }
    assert.equal(requests.length, count, "help must not fetch MCP catalog");
  });
  await t.test("invalid commands and params fail with native validation JSON before HTTP", async () => {
    const count = requests.length;
    for (const args of [
      ["knowledge", "search", "接口"], ["knowledge", "search", "接口", "--org", ""],
      ["knowledge", "search", "接口", "--org", "org-甲", "--limit", "1.5"],
      ["knowledge", "read", "..", "--org", "org-甲"], ["knowledge", "read", "a/b", "--org", "org-甲"],
      ["knowledge", "search", "接口", "--org", "org-甲", "--revision", revision],
      ["knowledge", "publish", "--org", "org-甲"],
    ]) {
      const result = await run([...args, "--json"]);
      assert.equal(result.code, 3, `${args.join(" ")}: ${result.stderr}`);
      assert.equal(JSON.parse(result.stderr).kind, "validation");
      assert.equal(result.stdout, "");
    }
    assert.equal(requests.length, count);
  });
  await t.test("API key and missing selected identity never fall back to another account", async () => {
    const count = requests.length;
    for (const overrides of [{ HIQ_API_KEY: "fixture-api-key" }, { XDG_CONFIG_HOME: join(root, "empty") }]) {
      const result = await run(["knowledge", "search", "接口", "--org", "org-甲", "--json"], cli, overrides);
      assert.equal(result.code, 2, result.stderr);
      assert.equal(JSON.parse(result.stderr).kind, "config");
      assert.equal(result.stdout, "");
    }
    assert.equal(requests.length, count);
  });
  await t.test("HTTP and transport errors retain JSON and documented exit codes without fallback", async () => {
    for (const [status, code, kind] of [[401, 2, "config"], [403, 2, "config"], [400, 3, "validation"], [422, 3, "validation"], [404, 4, "upstream"], [503, 4, "upstream"]] as const) {
      const count = requests.length;
      const result = await run(["knowledge", "search", `status-${status}`, "--org", "org-甲", "--json"]);
      assert.equal(result.code, code, result.stderr);
      assert.equal(JSON.parse(result.stderr).kind, kind);
      assert.equal(JSON.parse(result.stderr).code, "fixture_error");
      assert.equal(result.stdout, "");
      assert.equal(requests.length, count + 1);
    }
    for (const query of ["broken-json", "broken-data"]) {
      const result = await run(["knowledge", "search", query, "--org", "org-甲", "--json"]);
      assert.equal(result.code, 4);
      assert.equal(JSON.parse(result.stderr).kind, "upstream");
    }
    const wrongOrg = await run(["knowledge", "search", "接口", "--org", "other-org", "--json"]);
    assert.equal(wrongOrg.code, 2);
    const wrongRevision = await run(["knowledge", "read", page.nodeid, "--org", "org-甲", "--revision", "wrong", "--json"]);
    assert.equal(wrongRevision.code, 4);
    const redirected = await run(["knowledge", "search", "redirect", "--org", "org-甲", "--json"]);
    assert.equal(redirected.code, 5);
    const disconnected = await run(["knowledge", "search", "接口", "--org", "org-甲", "--json"], cli, { HIQ_CORTEX_BASE: "http://127.0.0.1:1" });
    assert.equal(disconnected.code, 5);
    assert.equal(JSON.parse(disconnected.stderr).kind, "transport");
  });
  await t.test("device login uses explicit Cortex consent and writes only selected native store", async () => {
    const isolated = join(root, "login-config");
    const result = await run(["login", "--json"], cli, { XDG_CONFIG_HOME: isolated });
    assert.equal(result.code, 0, result.stderr);
    assert.equal((oauthRequest as { scope: string }).scope, "cortex_data");
    const path = join(isolated, "hiq-cortex", "credentials.json");
    assert.equal(JSON.parse(result.stdout).credentials, path);
    assert.equal(JSON.parse(await readFile(path, "utf8")).token, "fixture-device-token");
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(result.stdout.includes("fixture-device-token"), false);
    const logout = await run(["logout", "--json"], cli, { XDG_CONFIG_HOME: isolated });
    assert.equal(logout.code, 0);
    assert.equal(JSON.parse(logout.stdout).removed, true);
    assert.equal(JSON.parse(await readFile(credentials, "utf8")).token, "fixture-user-token");
  });
  await t.test("packed npm artifact installs cleanly and all knowledge commands reach HTTP", { timeout: 60_000 }, async packageTest => {
    const npm = process.env.npm_execpath;
    assert.ok(npm, "run this suite through npm test");
    const packed = await exec(process.execPath, [npm, "pack", "--ignore-scripts", "--json", "--pack-destination", root], { cwd: repo, env, signal: packageTest.signal });
    const metadata = JSON.parse(packed.stdout)[0];
    assert.ok(metadata.files.some((f: { path: string }) => f.path === "dist/knowledge.js"));
    assert.ok(metadata.files.some((f: { path: string }) => f.path === "skills/organization-knowledge/SKILL.md"));
    assert.ok(metadata.files.some((f: { path: string }) => f.path === "docs/agent-setup.md"));
    assert.ok(metadata.files.every((f: { path: string }) => !/(credentials|\.env)/u.test(f.path)));
    const install = join(root, "install");
    await mkdir(install);
    await writeFile(join(install, "package.json"), '{"name":"knowledge-install-fixture","private":true}');
    await exec(process.execPath, [npm, "install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", join(root, metadata.filename)], { cwd: install, env, signal: packageTest.signal });
    assert.equal(
      await readFile(join(install, "node_modules/@hiq-ai/hiq-cortex-cli/skills/organization-knowledge/SKILL.md"), "utf8"),
      await readFile(join(repo, "skills/organization-knowledge/SKILL.md"), "utf8"),
      "the installed skill must match the release source",
    );
    assert.equal(
      await readFile(join(install, "node_modules/@hiq-ai/hiq-cortex-cli/docs/agent-setup.md"), "utf8"),
      await readFile(join(repo, "docs/agent-setup.md"), "utf8"),
      "the installed guide must match the release source",
    );
    const manifestPath = join(install, "node_modules", "@hiq-ai", "hiq-cortex-cli", "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const installedCli = resolve(dirname(manifestPath), manifest.bin["hiq-cortex"]);
    const found = await success(["knowledge", "search", "接口"], installedCli);
    assert.equal(found.pages[0].revision, revision);
    for (const command of ["read", "links", "sources"]) assert.equal((await success(["knowledge", command, page.nodeid, "--revision", revision], installedCli)).revision, revision);
    assert.equal((await success(["doctor"], installedCli)).user_id, "member-1");
  });
  assert.ok(requests.every(request => !request.path.includes("/mcp")));
});
