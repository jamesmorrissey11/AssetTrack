# AssetTrack schema catalog MCP server

This development-only MCP server discovers AssetTrack SQLite databases under
`services/*/data/`, opens them read-only, and introspects their current schemas
for Copilot. It does not cache schemas or expose write tools.

## Run

From the repository root:

```bash
npm install
npm run dev:catalog
```

The Streamable HTTP endpoint is `http://localhost:5010/mcp`. `npm run dev`
starts it alongside the seven application services.

Configuration:

- `PORT` sets the HTTP port (default `5010`).
- `ASSETTRACK_REPO_ROOT` sets the AssetTrack repository root used for database
  discovery (default: the current working directory).

## Tools

- `list_databases` lists each discovered database, its owning service, and its
  repository-relative path.
- `get_schema` returns live tables, views, columns, foreign keys, indexes, and
  SQL definitions. Pass an optional database identifier to limit the result.
- `find_data` searches table, view, and column names for a case-insensitive
  term. It searches schema metadata only, not stored row values.
