# Apps SDK Pizzaz Examples

Focused Apps SDK + MCP example centered on Pizzaz widgets.

## Project layout

- `index.ts` - MCP server entrypoint (SSE + tool wiring)
- `tools/` - MCP tool definitions (one file per tool)
- `tools/sqlite-tools.ts` - helper to create catalog, execution, and metadata-driven canned-query tools.
- `utils/` - generic MCP server plumbing/helpers
- `utils/sqlite-bridge.ts` - Python bridge for SQLite metadata + query execution.
- `ui/` - React widget source code
- `assets/` - built widget HTML/JS/CSS output
- `ui/sqlite/` - widget used by the SQLite tools.
- `build-all.mts` - widget production build script
- `vite.config.mts` - local widget dev server config
- `samples/sqlite/` - sample `titanic.db` + `titanic.yml` for canned queries

## Prerequisites

- Node.js 18+
- pnpm
- Python 3 with `sqlite3` and `pyyaml` (for metadata parsing)

## Install

```bash
pnpm install
```

Optional local config:

```bash
cp .env.example .env
```

- `MCP_PORT` controls MCP server port (default `8000`)

## OpenAI Docs MCP

Recommend installing the OpenAI developer docs MCP server.

Server URL (streamable HTTP): `https://developers.openai.com/mcp`

```bash
codex mcp add openaiDeveloperDocs --url https://developers.openai.com/mcp
codex mcp list
```

Alternative config in `~/.codex/config.toml`:

```toml
[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"
```

Add this instruction to AGENTS guidance when working with OpenAI platform topics:

```text
Always use the OpenAI developer documentation MCP server if you need to work with the OpenAI API, ChatGPT Apps SDK, Codex,… without me having to explicitly ask.
```

## Smooth local dev

Run everything with one command:

```bash
pnpm run dev
```

This does:

- initial asset build
- UI rebuild watch on `ui/**`
- MCP server watch/restart on backend changes
- serves widget assets from MCP server at `/assets/*`
- serves latest widget template HTML from disk on each resource read, so UI-only
  changes are reflected without restarting MCP

To expose MCP publicly, run ngrok separately:

```bash
pnpm run dev
# in another terminal:
ngrok http 8000
```

## Common commands

Build widget assets:

```bash
pnpm run build
```

Run MCP server:

```bash
pnpm run mcp:start
```

## SQLite MCP tools

The SQLite integration is loaded from `tools/sqlite-tools.ts` and `utils/sqlite-bridge.ts`.

It provides:

- `<prefix>sqlite_get_catalog` - returns the catalog of available databases/tables/columns.
- `<prefix>sqlite_execute` - executes arbitrary SQL in read-only mode.
- `<query name>` for each query in metadata (`databases.<db>.queries`) - built as individual tools.

The active tool prefix comes from `MCP_SQLITE_PREFIX` (defaults to empty). Query names are read from the metadata keys; avoid `sqlite_*` keys to prevent collisions.

Configuration is controlled via environment variables:

- `MCP_SQLITE_DB` - SQLite file path (default `samples/sqlite/titanic.db`).
- `MCP_SQLITE_METADATA` - metadata YAML/JSON path (default `samples/sqlite/titanic.yml`).
- `MCP_SQLITE_PREFIX` - optional string prepended to catalog and execute tool names.
- `MCP_SQLITE_PYTHON` - Python executable, default `python3`.

A typical setup uses:

```bash
cp .env.example .env
# Then adjust .env values and run
pnpm run dev
```

Once running, call `sqlite_get_catalog` first to discover generated canned-query tools and their parameters.

Run MCP server in watch mode:

```bash
pnpm run mcp:dev
```

Run Vite UI dev server only:

```bash
pnpm run dev:vite
```

Optional separate static asset serving (not needed for normal MCP dev):

```bash
BASE_URL=http://localhost:4444 pnpm run build
pnpm run serve
```

## MCP endpoints

Default (`MCP_PORT=8000`):

- `GET /mcp`
- `POST /mcp/messages?sessionId=...`
- `GET /assets/*`

## ChatGPT connector (local)

Run the MCP app locally:

```bash
pnpm run dev
```

In a separate terminal, expose it with ngrok:

```bash
ngrok http 8000
```

Then add this MCP URL in ChatGPT developer mode:

```text
https://<your-tunnel-domain>/mcp
```

## Twilio + Realtime call widget

This repo now includes a Twilio calling widget (`twilio-call`) that can:

- start an outbound attendance follow-up call to a configured parent number
- bridge bidirectional audio between Twilio Media Streams and OpenAI Realtime API
- stream a live transcript (partial + final turns) into the ChatGPT iframe widget
- render teacher-facing context (student + parent profile) with a live interaction waveform

### Required environment variables

Copy `.env.example` to `.env` and set:

- `PUBLIC_URL` to your externally reachable URL (ngrok HTTPS URL for local dev)
- `OPENAI_API_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`

Optional overrides:

- `TWILIO_TO_NUMBER_DEFAULT` (defaults to `+16282897075`)
- `OPENAI_REALTIME_MODEL`
- `OPENAI_REALTIME_VOICE`
- `OPENAI_REALTIME_TRANSCRIPTION_MODEL`
- `OPENAI_REALTIME_PROMPT_TEMPLATE` (defaults to `prompts/teacher-parent-absence-call.jinja`)
- `OPENAI_REALTIME_SYSTEM_PROMPT`
- `CALL_VIEWER_TOKEN_SECRET`
- `CALL_STUDENT_NAME`
- `CALL_PARENT_NAME`
- `CALL_PARENT_RELATIONSHIP`
- `CALL_PARENT_NUMBER_LABEL`
- `CALL_SCHOOL_NAME`
- `CALL_TEACHER_ROLE`

### Local run flow

1. Start the app:

```bash
pnpm run dev
```

2. Expose the app publicly:

```bash
ngrok http 8000
```

3. Set `PUBLIC_URL` in `.env` to your ngrok URL, then restart `pnpm run dev`.
4. Add `https://<your-ngrok-domain>/mcp` in ChatGPT developer mode.
5. Ask ChatGPT to open the Twilio call panel (`twilio-call-panel`).
6. Click **Call** in the widget to start dialing and watch the transcript stream live.

## Deploy note

If assets are hosted elsewhere, override `BASE_URL` when building:

```bash
BASE_URL=https://your-server.com pnpm run build
```
