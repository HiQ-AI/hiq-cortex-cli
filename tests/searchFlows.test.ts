import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bindFlowSearchIdentity, parseQueriesArg, type FlowSearchResult } from "../src/searchFlows.js";

const RESULT: FlowSearchResult = {
  restricted: false,
  source: { code: "hiqlcd", version: "1.5.0" },
  query: "Styrene",
  branches: { bm25: true, vector: true },
  total: 1,
  flows: [],
};

test("search-flows preserves opaque identity from @file-shaped input", async () => {
  const root = await mkdtemp(join(tmpdir(), "hiq-cortex-search-flows-"));
  const path = join(root, "queries.json");
  try {
    await writeFile(path, JSON.stringify([
      { query: "Styrene", compartment: "air", identity: "苯乙烯|大气排放#1" },
      { query: "Particulate matter" },
    ]));
    assert.deepEqual(parseQueriesArg(`@${path}`), [
      { query: "Styrene", compartment: "air", identity: "苯乙烯|大气排放#1" },
      { query: "Particulate matter", compartment: undefined, identity: undefined },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("search-flows rejects unsafe identity metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "hiq-cortex-search-flows-"));
  const path = join(root, "queries.json");
  try {
    await writeFile(path, JSON.stringify([{ query: "Styrene", identity: "row\nother" }]));
    assert.throws(() => parseQueriesArg(`@${path}`), /query identity/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("search-flows attaches caller identity only after the relic result", () => {
  const bound = bindFlowSearchIdentity(RESULT, {
    query: "Styrene",
    compartment: "air",
    identity: "苯乙烯|大气排放#1",
  });
  assert.deepEqual(bound, { ...RESULT, identity: "苯乙烯|大气排放#1" });
  assert.equal(RESULT.identity, undefined, "binding must not mutate the relic response");
});
