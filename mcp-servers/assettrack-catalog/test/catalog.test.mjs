import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  discoverDatabases,
  readSchema,
  searchSchema,
  selectDatabase,
} from "../src/catalog.mjs";

async function createFixture() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "assettrack-catalog-"));
  const dataDirectory = path.join(repoRoot, "services", "assets-svc", "data");
  const databasePath = path.join(dataDirectory, "assets.db");
  await mkdir(dataDirectory, { recursive: true });

  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE assets (
      id INTEGER PRIMARY KEY,
      asset_tag TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL
    );
    CREATE VIEW active_assets AS
      SELECT id, asset_tag FROM assets WHERE status = 'active';
  `);
  database.close();

  return { repoRoot, databasePath };
}

test("discovers databases and identifies their owning service", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.repoRoot, { recursive: true, force: true }));

  const databases = await discoverDatabases(fixture.repoRoot);

  assert.equal(databases.length, 1);
  assert.equal(databases[0].name, "assets-svc/assets.db");
  assert.equal(databases[0].service, "assets-svc");
  assert.equal(databases[0].relativePath, "services/assets-svc/data/assets.db");
  assert.equal(selectDatabase(databases, "assets.db"), databases[0]);
});

test("reads tables, views, columns, and indexes without opening a writable connection", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.repoRoot, { recursive: true, force: true }));
  const [databaseInfo] = await discoverDatabases(fixture.repoRoot);

  const schema = readSchema(databaseInfo);

  assert.deepEqual(schema.objects.map((object) => object.name), ["assets", "active_assets"]);
  const assets = schema.objects.find((object) => object.name === "assets");
  assert.deepEqual(assets.columns.map((column) => column.name), ["id", "asset_tag", "status"]);
  assert.equal(assets.indexes.length, 1);
  assert.deepEqual(assets.indexes[0].columns, ["asset_tag"]);

  const readOnlyDatabase = new DatabaseSync(fixture.databasePath, { readOnly: true });
  assert.throws(() => readOnlyDatabase.exec("INSERT INTO assets(asset_tag, status) VALUES ('x', 'active')"));
  readOnlyDatabase.close();
});

test("find_data matches object and column names case-insensitively", async (context) => {
  const fixture = await createFixture();
  context.after(() => rm(fixture.repoRoot, { recursive: true, force: true }));
  const [databaseInfo] = await discoverDatabases(fixture.repoRoot);
  const schema = readSchema(databaseInfo);

  const objectMatches = searchSchema(schema, "ACTIVE");
  const columnMatches = searchSchema(schema, "tag");

  assert.equal(objectMatches.length, 1);
  assert.equal(objectMatches[0].object, "active_assets");
  assert.equal(objectMatches[0].objectNameMatched, true);
  assert.deepEqual(columnMatches.map((match) => match.object), ["assets", "active_assets"]);
  assert.deepEqual(columnMatches[0].columns.map((column) => column.name), ["asset_tag"]);
});
