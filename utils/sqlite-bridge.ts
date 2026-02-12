import { spawnSync } from "node:child_process";
import path from "node:path";

type SqliteBridgeCatalogQuery = {
  params: string[];
  queries: Record<
    string,
    {
      sql: string;
      title?: string;
      description?: string;
      write: boolean;
      hide_sql: boolean;
    }
  >;
};

type SqliteBridgeCatalogResponse = {
  text: string;
};

type SqliteBridgeExecuteResponse = {
  text: string;
};

type SqliteBridgeConfig = {
  sqliteFile: string;
  metadataFile?: string;
  prefix: string;
  pythonExecutable: string;
};

type SqliteBridgeManifestResponse = {
  queries: {
    name: string;
    title?: string;
    description?: string;
    sql: string;
    params: string[];
    write: boolean;
    hide_sql: boolean;
  }[];
};

const PYTHON_BRIDGE = String.raw`
from __future__ import annotations

import html
import json
import re
import sqlite3
import sys
from pathlib import Path

try:
    import yaml
except Exception:
    yaml = None


def _load_metadata(path: str | None):
    if not path:
        return {}
    metadata_path = Path(path)
    if not metadata_path.exists():
        raise FileNotFoundError(f"Metadata file not found: {metadata_path}")
    if yaml is None:
        # Keep bridge functional even when optional YAML dependency is missing.
        # In that case we skip metadata-driven catalogs/canned queries.
        return {}
    payload = yaml.safe_load(metadata_path.read_text(encoding="utf-8")) or {}
    return payload if isinstance(payload, dict) else {}


def _list_tables(conn: sqlite3.Connection, database_name: str):
    try:
        return [row[1] for row in conn.execute(f"pragma {database_name}.table_list")]
    except Exception:
        return [
            row[0]
            for row in conn.execute(
                f"SELECT name FROM {database_name}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        ]


def _get_catalog(sqlite_file: str, metadata_file: str | None):
    metadata = _load_metadata(metadata_file)
    database_metadata = metadata.get("databases", {}) if isinstance(metadata, dict) else {}
    if not isinstance(database_metadata, dict):
        raise ValueError("Metadata root key 'databases' must be a mapping.")

    catalog = {
        key: value
        for key, value in metadata.items()
        if key != "databases" and isinstance(key, str)
    }
    catalog.setdefault("databases", {})

    connection = sqlite3.connect(f"file:{sqlite_file}?mode=ro", uri=True)
    try:
        for _, database_name, database_path in connection.execute("pragma database_list"):
            database_stem = Path(database_path).stem
            database_meta = database_metadata.get(database_stem, {})
            if not isinstance(database_meta, dict):
                database_meta = {}
            database_entry = {
                key: value
                for key, value in database_meta.items()
                if key not in {"tables", "queries"}
            }
            if not database_entry.get("title"):
                database_entry["title"] = database_stem

            tables_entry = {}
            for table_name in _list_tables(connection, database_name):
                table_meta = database_meta.get("tables", {}).get(table_name, {})
                if not isinstance(table_meta, dict):
                    table_meta = {}
                if table_meta.get("hidden"):
                    continue

                columns = {}
                table_meta_columns = table_meta.get("columns", {})
                if not isinstance(table_meta_columns, dict):
                    table_meta_columns = {}

                for column_name in [
                    row[1] for row in connection.execute(f"pragma {database_name}.table_info({table_name})")
                ]:
                    columns[column_name] = table_meta_columns.get(
                        column_name, ""
                    )
                table_entry = {
                    key: value for key, value in table_meta.items() if key != "columns"
                }
                table_entry["columns"] = columns
                tables_entry[table_name] = table_entry

            queries_entry = {}
            for query_slug, query_metadata in database_meta.get("queries", {}).items():
                if not isinstance(query_metadata, dict):
                    continue
                queries_entry[query_slug] = {
                    key: value
                    for key, value in query_metadata.items()
                    if value is not None
                }
            database_entry["tables"] = tables_entry
            database_entry["queries"] = queries_entry
            catalog["databases"][database_name] = database_entry

        return {"text": json.dumps(catalog)}
    finally:
        connection.close()


def _extract_sql_params(sql: str) -> list[str]:
    return sorted(set(re.findall(r":(\w+)", sql)))


def _execute(sqlite_file: str, sql: str, parameters: dict | None, write: bool = False):
    args = parameters if isinstance(parameters, dict) else {}
    connection = sqlite3.connect(
        f"file:{sqlite_file}?mode={'rw' if write else 'ro'}", uri=True
    )
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        cursor = connection.execute(sql, args)
        if cursor.description is None:
            if write:
                connection.commit()
            return {"text": "Statement executed successfully"}

        header = "".join(f"<th>{html.escape(str(col[0]))}</th>" for col in cursor.description)
        rows_html = f"<tr>{header}</tr>"
        for row in cursor.fetchall():
            row_html = "".join(f"<td>{html.escape(str(cell))}</td>" for cell in row)
            rows_html += f"<tr>{row_html}</tr>"
        return {"text": f"<table>{rows_html}</table>"}
    finally:
        connection.close()


def _query_manifest(metadata_file: str | None):
    metadata = _load_metadata(metadata_file)
    database_metadata = metadata.get("databases", {}) if isinstance(metadata, dict) else {}
    if not isinstance(database_metadata, dict):
        raise ValueError("Metadata root key 'databases' must be a mapping.")

    queries = []
    for _, db_meta in database_metadata.items():
        if not isinstance(db_meta, dict):
            continue
        for query_slug, query_data in db_meta.get("queries", {}).items():
            if not isinstance(query_data, dict):
                continue
            if query_slug.startswith("sqlite_"):
                raise ValueError(
                    f"Cannot start query slug with 'sqlite_': {query_slug}"
                )
            query = {
                "name": query_slug,
                "title": query_data.get("title"),
                "description": query_data.get("description"),
                "sql": query_data.get("sql", ""),
                "write": bool(query_data.get("write", False)),
                "hide_sql": bool(query_data.get("hide_sql", False)),
            }
            query["params"] = _extract_sql_params(query["sql"])
            queries.append(query)

    return {"queries": queries}


def main(payload):
    action = payload.get("action")
    sqlite_file = payload.get("sqlite_file")
    if not sqlite_file:
        raise ValueError("sqlite_file is required")
    metadata_file = payload.get("metadata_file")

    if action == "catalog":
        return _get_catalog(sqlite_file, metadata_file)
    if action == "execute":
        return _execute(
            sqlite_file=sqlite_file,
            sql=payload.get("sql", ""),
            parameters=payload.get("parameters"),
            write=bool(payload.get("write")),
        )
    if action == "query_manifest":
        return _query_manifest(metadata_file)

    raise ValueError(f"Unknown action: {action}")


if __name__ == "__main__":
    payload = json.loads(sys.argv[1] if len(sys.argv) > 1 else "{}")
    output = main(payload)
    print(json.dumps(output))
`;

const SQL_BRIDGE_ERROR_PREFIX = "[sqlite bridge]";

function getConfigValue(value: string | undefined): string | undefined {
  const maybeValue = value?.trim();
  if (!maybeValue) return undefined;
  return path.resolve(process.cwd(), maybeValue);
}

function runPythonBridge<T>(payload: object): T {
  const config = getSqliteConfig();
  const command = config.pythonExecutable;
  const child = spawnSync(command, ["-c", PYTHON_BRIDGE, JSON.stringify(payload)], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });

  if (child.error) {
    throw new Error(`${SQL_BRIDGE_ERROR_PREFIX} ${child.error.message}`);
  }

  if ((child.status ?? 0) !== 0) {
    const details = (child.stderr || child.stdout || "").trim();
    throw new Error(
      `${SQL_BRIDGE_ERROR_PREFIX} python bridge failed with status ${child.status}: ${details || "unknown error"}`,
    );
  }

  const output = (child.stdout || "").trim();
  if (!output) {
    throw new Error(`${SQL_BRIDGE_ERROR_PREFIX} No output from bridge`);
  }

  return JSON.parse(output) as T;
}

export function getSqliteConfig(): SqliteBridgeConfig {
  return {
    sqliteFile: path.resolve(
      process.cwd(),
      getConfigValue(process.env.MCP_SQLITE_DB) ??
        "samples/sqlite/titanic.db",
    ),
    metadataFile:
      getConfigValue(process.env.MCP_SQLITE_METADATA) ??
      getConfigValue("samples/sqlite/titanic.yml"),
    prefix: process.env.MCP_SQLITE_PREFIX?.trim() || "",
    pythonExecutable: process.env.MCP_SQLITE_PYTHON || "python3",
  };
}

export function getSqliteCatalog(): SqliteBridgeCatalogResponse {
  const config = getSqliteConfig();
  return runPythonBridge<SqliteBridgeCatalogResponse>({
    action: "catalog",
    sqlite_file: config.sqliteFile,
    metadata_file: config.metadataFile,
  });
}

export function runSqliteQuery(sql: string, options: {
  sqliteFile?: string;
  metadataFile?: string;
  parameters?: Record<string, unknown>;
  write?: boolean;
} = {}): SqliteBridgeExecuteResponse {
  const config = getSqliteConfig();
  return runPythonBridge<SqliteBridgeExecuteResponse>({
    action: "execute",
    sqlite_file: options.sqliteFile ?? config.sqliteFile,
    metadata_file: options.metadataFile ?? config.metadataFile,
    sql,
    parameters: options.parameters ?? {},
    write: options.write ?? false,
  });
}

export function getSqliteQueryManifest(): SqliteBridgeManifestResponse {
  const config = getSqliteConfig();
  return runPythonBridge<SqliteBridgeManifestResponse>({
    action: "query_manifest",
    sqlite_file: config.sqliteFile,
    metadata_file: config.metadataFile,
  });
}

export type SqliteQuerySpec = SqliteBridgeManifestResponse["queries"][number];
