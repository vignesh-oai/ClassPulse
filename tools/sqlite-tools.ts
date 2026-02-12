import { z } from "zod/v3";
import type { ToolDefinition } from "../utils/define-tool";
import { defineTool } from "../utils/define-tool";
import {
  getSqliteConfig,
  getSqliteCatalog,
  getSqliteQueryManifest,
  runSqliteQuery,
  type SqliteQuerySpec,
} from "../utils/sqlite-bridge";

function makeCannedQueryDescription(spec: SqliteQuerySpec): string {
  let description = spec.title
    ? `${spec.title.replace(/\.$/, "")}.`
    : `Execute canned query '${spec.name}' provided in the metadata.`;
  if (spec.description) {
    description += ` ${spec.description.replace(/\.$/, "")}.`;
  }
  if (!spec.hide_sql) {
    description += ` SQL of the query:\n${spec.sql}`;
  }
  return description;
}

function createCatalogTool(
  prefix: string,
): ToolDefinition {
  return defineTool({
    name: `${prefix}sqlite_get_catalog`,
    title: "Get SQLite catalog",
    description:
      "Call this tool first. Returns the complete catalog of available databases, tables, and columns.",
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
    input: z.object({}),
    ui: "sqlite",
    invoking: "Reading the SQLite catalog",
    invoked: "SQLite catalog returned",
    async handler() {
      const catalog = getSqliteCatalog();
      return {
        content: [{ type: "text", text: catalog.text }],
        structuredContent: {
          tool: `${prefix}sqlite_get_catalog`,
          result: catalog.text,
        },
      };
    },
  });
}

function createExecuteTool(prefix: string): ToolDefinition {
  return defineTool({
    name: `${prefix}sqlite_execute`,
    title: "Execute SQLite query",
    description:
      "Execute arbitrary SQL against the configured SQLite database. Read-only by default; use canned query tools for documented SQL patterns.",
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    }
    ,
    input: z.object({
      sql: z.string().describe("SQL to execute."),
    }),
    ui: "sqlite",
    invoking: "Running a SQL query",
    invoked: "SQL query executed",
    async handler(input) {
      const result = runSqliteQuery(input.sql, {
        write: false,
      });
      return {
        content: [{ type: "text", text: result.text }],
        structuredContent: {
          tool: `${prefix}sqlite_execute`,
          result: result.text,
          sql: input.sql,
        },
      };
    },
  });
}

function createCannedQueryTools(prefix: string): ToolDefinition[] {
  let specs: SqliteQuerySpec[] = [];
  const manifest = getSqliteQueryManifest();
  specs = manifest.queries;

  return specs.map((spec) => {
    const toolName = `${prefix}${spec.name}`;
    const shape: Record<string, ReturnType<typeof z.string>> = {};
    for (const param of spec.params) {
      shape[param] = z.string().describe(`Value for ${param}`);
    }

    return defineTool({
      name: toolName,
      title: `Run SQL query ${spec.name}`,
      description: makeCannedQueryDescription(spec),
      annotations: {
        readOnlyHint: !spec.write,
        openWorldHint: false,
        destructiveHint: spec.write,
      },
      input: z.object(shape),
      ui: "sqlite",
      invoking: `Running canned SQLite query ${spec.name}`,
      invoked: `Canned query ${spec.name} executed`,
      async handler(input) {
        const result = runSqliteQuery(spec.sql, {
          parameters: input,
          write: spec.write,
        });

        return {
          content: [{ type: "text", text: result.text }],
          structuredContent: {
            tool: toolName,
            result: result.text,
            sql: spec.sql,
          },
        };
      },
    });
  });
}

export function createSqliteTools(): ToolDefinition[] {
  const config = getSqliteConfig();
  const prefix = config.prefix;

  return [
    createCatalogTool(prefix),
    createExecuteTool(prefix),
    ...createCannedQueryTools(prefix),
  ];
}
