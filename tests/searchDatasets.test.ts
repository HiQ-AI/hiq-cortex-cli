import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  datasetSearchBody,
  normalizeDatasetActivities,
  parseDatasetQueriesArg,
} from "../src/searchDatasets.js";

test("search-datasets parses a correlated batch without leaking caller identity into filters", async () => {
  const root = await mkdtemp(join(tmpdir(), "hiq-cortex-search-datasets-"));
  const path = join(root, "queries.json");
  try {
    await writeFile(path, JSON.stringify([
      { query: "电力,低压", locations: ["CN"], activityTypes: ["MARKET_TYPE"], identity: "row-4" },
      "天然气",
    ]));
    assert.deepEqual(parseDatasetQueriesArg(`@${path}`), [
      { query: "电力,低压", locations: ["CN"], activityTypes: ["MARKET_TYPE"], identity: "row-4" },
      { query: "天然气" },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("search-datasets validates filter arrays and identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "hiq-cortex-search-datasets-"));
  const path = join(root, "queries.json");
  try {
    await writeFile(path, JSON.stringify([{ query: "电力", locations: "CN" }]));
    assert.throws(() => parseDatasetQueriesArg(`@${path}`), /locations must be a JSON array/u);
    await writeFile(path, JSON.stringify([{ query: "电力", identity: "row\n5" }]));
    assert.throws(() => parseDatasetQueriesArg(`@${path}`), /query identity/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("search-datasets keeps only the authoring identity fields from relic", () => {
  const normalized = normalizeDatasetActivities([{
    activityRef: "a1_ref",
    activityUuid: "uuid-1",
    fallbackId: null,
    name: { zh_CN: "电力,低压" },
    referenceProduct: { name: { zh_CN: "电力" }, unit: "kWh" },
    datasets: [{
      id: "dataset-1",
      version: "1.5.0",
      datasetRef: "d1_ref",
      source: { code: "hiqlcd", version: "1.5.0" },
      systemModel: { code: "CUT_OFF" },
      location: { id: "CN", name: { zh_CN: "中国" } },
    }],
  }]);
  assert.deepEqual(normalized, [{
    activityRef: "a1_ref",
    activityUuid: "uuid-1",
    fallbackId: null,
    name: { zh_CN: "电力,低压" },
    referenceProduct: { name: { zh_CN: "电力" }, unit: "kWh" },
    datasets: [{
      datasetRef: "d1_ref",
      id: "dataset-1",
      version: "1.5.0",
      source: { code: "hiqlcd", version: "1.5.0" },
      model: "CUT_OFF",
      location: { id: "CN", name: { zh_CN: "中国" } },
    }],
  }]);
});

test("search-datasets uses the current relic v1 filter and cursor-page contract", () => {
  assert.deepEqual(datasetSearchBody(
    "hiqlcd",
    "1.5.0",
    "CUT_OFF",
    "zh_CN",
    { query: "电力,低压", locations: ["CN"], activityTypes: ["MARKET_TYPE"], identity: "row-4" },
    5,
  ), {
    locale: "zh_CN",
    query: "电力,低压",
    filters: {
      sources: [{ code: "hiqlcd", version: "1.5.0" }],
      models: ["CUT_OFF"],
      locations: ["CN"],
      activityTypes: ["MARKET_TYPE"],
    },
    page: { limit: 5 },
  });
});
