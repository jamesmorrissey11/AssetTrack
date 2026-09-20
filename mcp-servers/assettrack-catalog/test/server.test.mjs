import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { createApp } from "../src/server.mjs";

test("serves exactly the three read-only catalog tools over Streamable HTTP", async (context) => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "assettrack-catalog-http-"));
  const dataDirectory = path.join(repoRoot, "services", "auth-svc", "data");
  await mkdir(dataDirectory, { recursive: true });
  const database = new DatabaseSync(path.join(dataDirectory, "auth.db"));
  database.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL)");
  database.close();

  const httpServer = createApp({ repoRoot }).listen(0, "127.0.0.1");
  await new Promise((resolve) => httpServer.once("listening", resolve));
  const address = httpServer.address();
  const client = new Client({ name: "catalog-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );

  context.after(async () => {
    await client.close();
    await new Promise((resolve, reject) =>
      httpServer.close((error) => error ? reject(error) : resolve()));
    await rm(repoRoot, { recursive: true, force: true });
  });

  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["find_data", "get_schema", "list_databases"],
  );

  const result = await client.callTool({
    name: "find_data",
    arguments: { term: "user" },
  });
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.matches[0].database, "auth-svc/auth.db");
  assert.equal(payload.matches[0].object, "users");
});
