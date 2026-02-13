import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolRequest,
  type ListResourceTemplatesRequest,
  type ListResourcesRequest,
  type ListToolsRequest,
  type ReadResourceRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type { WidgetCatalog } from "./widget-catalog";
import { logError, logInfo, logWarn } from "./call-debug";

type CreateMcpServerOptions = {
  name: string;
  version: string;
  widgetCatalog: WidgetCatalog;
};

export function createMcpServer(options: CreateMcpServerOptions): Server {
  const server = new Server(
    {
      name: options.name,
      version: options.version,
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  server.setRequestHandler(
    ListResourcesRequestSchema,
    async (_request: ListResourcesRequest) => ({
      resources: options.widgetCatalog.resources,
    }),
  );

  server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request: ReadResourceRequest) => {
      const content = options.widgetCatalog.getResourceContent(
        request.params.uri,
      );

      if (!content) {
        throw new Error(`Unknown resource: ${request.params.uri}`);
      }

      return {
        contents: [content],
      };
    },
  );

  server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async (_request: ListResourceTemplatesRequest) => ({
      resourceTemplates: options.widgetCatalog.resourceTemplates,
    }),
  );

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (_request: ListToolsRequest) => ({
      tools: options.widgetCatalog.tools,
    }),
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request: CallToolRequest) => {
      const startedAt = Date.now();
      const toolName = request.params.name;
      const rawArguments = request.params.arguments ?? {};
      const argumentKeys =
        rawArguments && typeof rawArguments === "object"
          ? Object.keys(rawArguments)
          : [];

      logInfo("MCP tool call received", {
        toolName,
        argumentKeys,
      });

      const invocation = options.widgetCatalog.getToolInvocation(
        toolName,
      );

      if (!invocation) {
        logWarn("MCP tool call rejected: unknown tool", { toolName });
        throw new Error(`Unknown tool: ${toolName}`);
      }

      try {
        const input = invocation.tool.input.parse(rawArguments);
        const result = await invocation.tool.handler(input);

        logInfo("MCP tool call completed", {
          toolName,
          durationMs: Date.now() - startedAt,
          contentItems: result.content.length,
          structuredKeys: Object.keys(result.structuredContent ?? {}),
        });

        return {
          ...result,
          _meta: invocation.meta,
        };
      } catch (error) {
        logError("MCP tool call failed", {
          toolName,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  );

  return server;
}
