import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SQLITE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3"]);

async function findSqliteFiles(directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findSqliteFiles(entryPath));
    } else if (entry.isFile() && SQLITE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }

  return files;
}

export async function discoverDatabases(repoRoot) {
  const resolvedRoot = path.resolve(repoRoot);
  const servicesDirectory = path.join(resolvedRoot, "services");
  let services;

  try {
    services = await readdir(servicesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const databases = [];
  for (const service of services.filter((entry) => entry.isDirectory())) {
    const dataDirectory = path.join(servicesDirectory, service.name, "data");
    let files;
    try {
      files = await findSqliteFiles(dataDirectory);
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    for (const filePath of files) {
      const relativeToData = path.relative(dataDirectory, filePath);
      const fileStats = await stat(filePath);
      databases.push({
        name: path.posix.join(service.name, relativeToData.split(path.sep).join("/")),
        service: service.name,
        fileName: path.basename(filePath),
        relativePath: path.relative(resolvedRoot, filePath).split(path.sep).join("/"),
        filePath,
        sizeBytes: fileStats.size,
        modifiedAt: fileStats.mtime.toISOString(),
      });
    }
  }

  return databases.sort((left, right) => left.name.localeCompare(right.name));
}

export function selectDatabase(databases, requestedName) {
  const exactMatch = databases.find((database) =>
    database.name === requestedName || database.relativePath === requestedName);
  if (exactMatch) {
    return exactMatch;
  }

  const fileNameMatches = databases.filter((database) => database.fileName === requestedName);
  if (fileNameMatches.length === 1) {
    return fileNameMatches[0];
  }
  if (fileNameMatches.length > 1) {
    throw new Error(`Database name "${requestedName}" is ambiguous; use a service-qualified name.`);
  }

  throw new Error(`Database "${requestedName}" was not found.`);
}

function withReadOnlyDatabase(filePath, operation) {
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

function readColumns(database, objectName) {
  return database.prepare("SELECT * FROM pragma_table_xinfo(?) ORDER BY cid")
    .all(objectName)
    .map((column) => ({
      position: column.cid,
      name: column.name,
      type: column.type || null,
      notNull: Boolean(column.notnull),
      defaultValue: column.dflt_value,
      primaryKeyPosition: column.pk,
      hidden: column.hidden,
    }));
}

function readForeignKeys(database, tableName) {
  return database.prepare("SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq")
    .all(tableName)
    .map((foreignKey) => ({
      id: foreignKey.id,
      sequence: foreignKey.seq,
      referencedTable: foreignKey.table,
      fromColumn: foreignKey.from,
      toColumn: foreignKey.to,
      onUpdate: foreignKey.on_update,
      onDelete: foreignKey.on_delete,
      match: foreignKey.match,
    }));
}

function readIndexes(database, tableName) {
  return database.prepare("SELECT * FROM pragma_index_list(?) ORDER BY seq")
    .all(tableName)
    .map((index) => ({
      name: index.name,
      unique: Boolean(index.unique),
      origin: index.origin,
      partial: Boolean(index.partial),
      columns: database.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
        .all(index.name)
        .map((column) => column.name),
    }));
}

export function readSchema(databaseInfo) {
  return withReadOnlyDatabase(databaseInfo.filePath, (database) => {
    const objects = database.prepare(`
      SELECT name, type, sql
      FROM sqlite_schema
      WHERE type IN ('table', 'view')
        AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();

    return {
      database: {
        name: databaseInfo.name,
        service: databaseInfo.service,
        fileName: databaseInfo.fileName,
        relativePath: databaseInfo.relativePath,
        sizeBytes: databaseInfo.sizeBytes,
        modifiedAt: databaseInfo.modifiedAt,
      },
      objects: objects.map((object) => ({
        name: object.name,
        type: object.type,
        sql: object.sql,
        columns: readColumns(database, object.name),
        foreignKeys: object.type === "table" ? readForeignKeys(database, object.name) : [],
        indexes: object.type === "table" ? readIndexes(database, object.name) : [],
      })),
    };
  });
}

export function searchSchema(schema, term) {
  const normalizedTerm = term.toLocaleLowerCase();
  const matches = [];

  for (const object of schema.objects) {
    const objectMatches = object.name.toLocaleLowerCase().includes(normalizedTerm);
    const matchingColumns = object.columns
      .filter((column) => column.name.toLocaleLowerCase().includes(normalizedTerm))
      .map((column) => ({
        name: column.name,
        type: column.type,
        primaryKeyPosition: column.primaryKeyPosition,
      }));

    if (objectMatches || matchingColumns.length > 0) {
      matches.push({
        database: schema.database.name,
        service: schema.database.service,
        object: object.name,
        objectType: object.type,
        objectNameMatched: objectMatches,
        columns: matchingColumns,
      });
    }
  }

  return matches;
}
