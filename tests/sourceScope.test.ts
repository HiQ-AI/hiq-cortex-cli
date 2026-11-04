import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SOURCE_CODES, SourceScope, scopedInvocation } from "../src/sourceScope.js";

const exec = promisify(execFile);

test("scopes reject unsupported tools, mixed sources and missing provenance", () => {
  for (const code of SOURCE_CODES) {
    const scope = new SourceScope(code);
    assert.equal(scope.sources(), code);
    assert.equal(scope.source(code), code);
    assert.throws(() => scope.sources(`${code},other`), /conflicts/);
    for (const tool of ["lookup_datasets", "aggregate_datasets", "aggregate_indicators", "process_hotspot", "epd_search", "future_tool"]) {
      assert.throws(() => scope.tool(tool), /no supported source-scoped contract/);
    }
    assert.throws(() => scope.result({ total: 1 }), /no verifiable source coordinate/);
    assert.throws(() => scope.result({ source: { code }, datasets: [{ source: { code: "other" } }] }), /conflicts/);
    scope.result({ datasets: [{ src: code, ver: "1", model: "CUT_OFF", restricted: true }] }, true);
    assert.throws(() => scope.result({ datasets: [{ src: "other" }] }, true), /conflicts/);
    assert.throws(() => scope.result({ datasets: [{}] }, true), /without a verifiable source/);
  }
  const epd = new SourceScope("epd");
  epd.tool("epd_search");
  epd.tool("epd_peer_benchmark");
  assert.throws(() => epd.tool("lookup_datasets"), /no supported/);
  assert.throws(() => epd.command("search-datasets"), /not available/);
  assert.throws(() => scopedInvocation(["scoped", "invented", "search"]), /Unknown source/);
  assert.deepEqual(scopedInvocation(["version"]), { argv: ["version"] });
});

test("real CLI rejects cross-source requests before HTTP and rejects contaminated responses", async t => {
  const root = await mkdtemp(join(tmpdir(), "environmental-source-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  let returnedSource = "hiqlcd";
  const server = createServer(async (req, res) => {
    requests++;
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url === "/api/relic/sources") {
      res.end(JSON.stringify({ data: [{ code: "hiqlcd", versions: [] }, { code: "ecoinvent", versions: [] }], meta: { apiVersion: "1" } }));
      return;
    }
    if (req.url === "/api/relic/epd/search") {
      assert.deepEqual(JSON.parse(body), { query: "concrete", filters: { ptSources: ["eco"] }, page: { limit: 1, cursor: "opaque-cursor" } });
      res.end(JSON.stringify({ data: [{ epd_key: "published-declaration", source: { pt_source: "eco", commercial: true }, headline: { restricted: true } }], page: { cursor: "next-page" } }));
      return;
    }
    assert.equal(req.url, "/api/relic/search");
    assert.deepEqual(JSON.parse(body).filters.sources, [{ code: "hiqlcd", version: "1" }]);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: [{ activityRef: "activity", activityUuid: null, fallbackId: null,
      name: { en_US: "electricity" }, referenceProduct: null,
      datasets: [{ id: "dataset", version: "1", datasetRef: "ref", source: { code: returnedSource, version: "1" }, systemModel: { code: "CUT_OFF" }, location: null }],
    }] }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: root, USERPROFILE: root,
    XDG_CONFIG_HOME: root, QUERYING_LCA_DATASETS_BASE: `http://127.0.0.1:${address.port}`, QUERYING_LCA_DATASETS_API_KEY: "fixture-only" };
  const run = async (args: string[], authenticated = true) => {
    try { return { code: 0, ...await exec(process.execPath, [cli, ...args], { env: { ...env, QUERYING_LCA_DATASETS_API_KEY: authenticated ? "fixture-only" : undefined }, signal: t.signal }) }; }
    catch (error) { const e = error as { code: number; stdout: string; stderr: string }; return e; }
  };
  const args = ["scoped", "hiqlcd", "search-datasets", "--source", "hiqlcd", "--ver", "1", "--queries", "electricity", "--json"];
  const valid = await run(args);
  assert.equal(valid.code, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).data[0].activities[0].datasets[0].source.code, "hiqlcd");
  const before = requests;
  const mixed = [...args]; mixed[4] = "ecoinvent";
  const denied = await run(mixed);
  assert.equal(denied.code, 3, denied.stderr);
  assert.equal(requests, before);
  for (const command of [["call", "lookup_datasets", "--args", '{"dataset_keys":"opaque"}'], ["aggregate-datasets"]]) {
    const deniedTool = await run(["scoped", "hiqlcd", ...command, "--json"]);
    assert.equal(deniedTool.code, 3, deniedTool.stderr);
    assert.equal(requests, before);
  }
  const sources = await run(["scoped", "hiqlcd", "sources", "--json"], false);
  assert.equal(sources.code, 0, sources.stderr);
  assert.deepEqual(JSON.parse(sources.stdout).data.map((source: { code: string }) => source.code), ["hiqlcd"]);
  const epd = await run(["scoped", "epd", "epd-search", "--query", "concrete", "--publishers", "eco", "--limit", "1", "--cursor", "opaque-cursor", "--json"], false);
  assert.equal(epd.code, 0, epd.stderr);
  const declaration = JSON.parse(epd.stdout);
  assert.equal(declaration.data[0].headline.restricted, true);
  assert.equal(declaration.data[0].source.pt_source, "eco");
  assert.equal(declaration.page.cursor, "next-page");
  returnedSource = "ecoinvent";
  const contaminated = await run(args);
  assert.equal(contaminated.code, 4, contaminated.stderr);
  assert.equal(contaminated.stdout, "");
  assert.match(contaminated.stderr, /Response source conflicts/);
});
