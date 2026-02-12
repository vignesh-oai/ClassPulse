# MCP Tool Call to UI Widget Rendering Workflow

## 1) Startup Wiring

1. `/Users/vignesh/code/ClassPulse/index.ts` creates a widget catalog from `toolDefinitions`, creates the MCP server with that catalog, then starts SSE/HTTP transport and static asset serving.
2. `/Users/vignesh/code/ClassPulse/tools/index.ts` provides all tool definitions.
3. Each tool file (example: `/Users/vignesh/code/ClassPulse/tools/pizza-map.ts`) is declared with `defineTool(...)` and includes:
   - Zod `input`
   - `ui` widget name
   - `handler(input)` returning tool output
4. `/Users/vignesh/code/ClassPulse/utils/define-tool.ts` converts Zod input to MCP `inputSchema` once, so schemas stay single-source.

## 2) How Tool Metadata Gets UI Attached

1. `/Users/vignesh/code/ClassPulse/utils/widget-catalog.ts` builds descriptors for every tool.
2. It adds `_meta.openai/outputTemplate` (`ui://widget/<ui>.html`) plus invocation metadata.
3. It also maps resources/templates and loads widget HTML from `/Users/vignesh/code/ClassPulse/assets`.

Before any call, `listTools` and `listResources` already tell the client which widget template belongs to each tool.

## 3) Request Transport

1. `/Users/vignesh/code/ClassPulse/utils/start-sse-server.ts` exposes:
   - `/mcp` for SSE session
   - `/mcp/messages` for POST messages
   - `/assets/*` for static widget HTML/CSS/JS
2. Each client session gets an MCP server instance from `createMcpServer`.

## 4) From `call_tool` to Response

1. Client calls a tool over MCP (`callTool`).
2. `/Users/vignesh/code/ClassPulse/utils/create-mcp-server.ts` handles it:
   - finds tool invocation via catalog (`getToolInvocation`)
   - validates/parses args with Zod
   - runs the tool `handler`
3. Server returns handler output plus `_meta` invocation metadata (including output template linkage).
4. Client uses that metadata to render the widget template (`ui://widget/<ui>.html`), backed by built files in `/assets` (served either via static route or resource read path).

Tool logic runs in `tools/*.ts`; widget rendering instructions are injected by the catalog and returned with MCP metadata so the client can render the right UI automatically.
