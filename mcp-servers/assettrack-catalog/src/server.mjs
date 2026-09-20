import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { z } from "zod";

import {
  discoverDatabases,
  readSchema,
  searchSchema,
  selectDatabase,
} from "./catalog.mjs";

function jsonResult(value) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(value, null, 2),
    }],
  };
}

function errorResult(error) {
  return {
    isError: true,
    content: [{
      type: "text",
      text: error instanceof Error ? error.message : String(error),
    }],
  };
}

export function createCatalogServer({
  repoRoot = process.env.ASSETTRACK_REPO_ROOT ?? process.cwd(),
} = {}) {
  const server = new McpServer({
    name: "assettrack-catalog",
    version: "1.0.0",
  });

  server.registerTool(
    "list_databases",
    {
      description: "List the live AssetTrack development SQLite databases and their owning services.",
      inputSchema: {},
    },
    async () => {
      const databases = await discoverDatabases(repoRoot);
      return jsonResult({
        repoRoot: path.resolve(repoRoot),
        databases: databases.map(({ filePath: _filePath, ...database }) => database),
      });
    },
  );

  server.registerTool(
    "get_schema",
    {
      description: "Read the live SQLite schema for every database, or for one database returned by list_databases.",
      inputSchema: {
        database: z.string().min(1).optional()
          .describe("Optional service-qualified database name, relative path, or unique file name."),
      },
    },
    async ({ database: requestedDatabase }) => {
      try {
        const databases = await discoverDatabases(repoRoot);
        const selectedDatabases = requestedDatabase
          ? [selectDatabase(databases, requestedDatabase)]
          : databases;
        return jsonResult({
          databases: selectedDatabases.map(readSchema),
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "find_data",
    {
      description: "Search live table, view, and column names across the AssetTrack SQLite schemas.",
      inputSchema: {
        term: z.string().trim().min(1).describe("Case-insensitive term to find in table, view, and column names."),
        database: z.string().min(1).optional()
          .describe("Optional database returned by list_databases to limit the search."),
      },
    },
    async ({ term, database: requestedDatabase }) => {
      try {
        const databases = await discoverDatabases(repoRoot);
        const selectedDatabases = requestedDatabase
          ? [selectDatabase(databases, requestedDatabase)]
          : databases;
        const matches = selectedDatabases.flatMap((database) =>
          searchSchema(readSchema(database), term));
        return jsonResult({ term, matches });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export function createApp(options = {}) {
  const app = express();
  const transports = new Map();

  app.use(express.json());

  app.post("/mcp", async (request, response) => {
    const sessionId = request.headers["mcp-session-id"];
    let transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;

    if (!transport && !sessionId && isInitializeRequest(request.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (initializedSessionId) => {
          transports.set(initializedSessionId, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          transports.delete(transport.sessionId);
        }
      };

      const server = createCatalogServer(options);
      await server.connect(transport);
    } else if (!transport) {
      response.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Missing or invalid MCP session.",
        },
        id: null,
      });
      return;
    }

    await transport.handleRequest(request, response, request.body);
  });

  const handleSessionRequest = async (request, response) => {
    const sessionId = request.headers["mcp-session-id"];
    const transport = typeof sessionId === "string" ? transports.get(sessionId) : undefined;
    if (!transport) {
      response.status(400).send("Missing or invalid MCP session.");
      return;
    }
    await transport.handleRequest(request, response);
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  return app;
}

export function startServer({
  port = Number.parseInt(process.env.PORT ?? "5010", 10),
  repoRoot = process.env.ASSETTRACK_REPO_ROOT ?? process.cwd(),
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535; received "${process.env.PORT}".`);
  }

  const app = createApp({ repoRoot });
  return app.listen(port, "0.0.0.0", () => {
    console.log(`AssetTrack catalog MCP server listening on http://localhost:${port}/mcp`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
