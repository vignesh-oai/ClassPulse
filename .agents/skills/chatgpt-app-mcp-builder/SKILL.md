---
name: chatgpt-app-mcp-builder
description: Build and operate ChatGPT Apps SDK starter-template connectors using standalone TypeScript executables. Use when working in chatgpt-app-template (or similar repos) to authenticate a user into the central auth store, create and link a ChatGPT connector, and run config-driven ChatGPT test queries.
---

# ChatGPT App MCP Builder

Use this skill when you need a lightweight alternative to a full framework/CLI for ChatGPT connector workflows.

## What this skill provides

- `scripts/auth-user.ts`
  - Authenticates a user and stores tokens in the central auth store (`~/.chatgpt-app/auth.json` by default).
- `scripts/connect-chatgpt.ts`
  - Creates and links a ChatGPT connector (or links an existing connector id).
  - Stores connector metadata in repo config.
- `scripts/test-chatgpt.ts`
  - Opens ChatGPT test URLs and optionally refreshes connector actions.
  - Supports saved test queries from repo config.

## Required context before running

- Target repo path (for example: `/Users/moustafa/code/chatgpt-app-template`).
- A running MCP URL for connector creation (for example: `https://<tunnel>/mcp`).
- Node 18+ and `pnpm`.

## Repo config

Default config file in the target repo:

- `chatgpt-app.local.json`

Example:

```json
{
  "mcpUrl": "https://example.ngrok-free.app/mcp",
  "connectorName": "chatgpt-app-template",
  "connectorDescription": "Local template connector",
  "refreshBeforeTest": true,
  "testQueries": [
    {
      "label": "Smoke",
      "query": "Summarize what this app can do in one paragraph."
    },
    {
      "label": "Widget path",
      "query": "Open the pizzaz carousel and explain what you rendered."
    }
  ]
}
```

After `connect-chatgpt.ts` runs, this file is updated with fields like:

- `connectorId`
- `linkId`
- `linkStatus`
- `userId`
- `deviceId`
- `lastUpdatedAt`

## Command workflow

1. Set a skill root and target repo:

```bash
SKILL_DIR=<absolute-path-to-this-skill>
APP_REPO=/Users/moustafa/code/chatgpt-app-template
```

2. Authenticate once (recommended path):

```bash
pnpm --dir "$APP_REPO" exec tsx "$SKILL_DIR/scripts/auth-user.ts" --from-codex
```

Alternative auth flows:

```bash
pnpm --dir "$APP_REPO" exec tsx "$SKILL_DIR/scripts/auth-user.ts" --token "<token>"
pnpm --dir "$APP_REPO" exec tsx "$SKILL_DIR/scripts/auth-user.ts" --status
```

3. Create and link connector:

```bash
pnpm --dir "$APP_REPO" exec tsx "$SKILL_DIR/scripts/connect-chatgpt.ts" \
  --repo "$APP_REPO" \
  --mcp-url "https://<your-tunnel>/mcp" \
  --name "chatgpt-app-template"
```

Link-only mode:

```bash
pnpm --dir "$APP_REPO" exec tsx "$SKILL_DIR/scripts/connect-chatgpt.ts" \
  --repo "$APP_REPO" \
  --link-only "<connector-id>"
```

4. Run tests via repo config:

```bash
pnpm --dir "$APP_REPO" exec tsx "$SKILL_DIR/scripts/test-chatgpt.ts" --repo "$APP_REPO"
```

Explicit query:

```bash
pnpm --dir "$APP_REPO" exec tsx "$SKILL_DIR/scripts/test-chatgpt.ts" \
  --repo "$APP_REPO" \
  --refresh \
  --query "Open the app and call the main tool."
```

Pick a saved query label:

```bash
pnpm --dir "$APP_REPO" exec tsx "$SKILL_DIR/scripts/test-chatgpt.ts" \
  --repo "$APP_REPO" \
  --pick "Smoke"
```

## Safety and troubleshooting

- Do not commit central auth tokens. They remain in `~/.chatgpt-app/auth.json`.
- Connector ids and link ids are safe to keep in repo config for local dev.
- If connector tools changed and ChatGPT is stale, rerun `test-chatgpt.ts --refresh`.
- If auth is missing/expired, rerun `auth-user.ts --from-codex` or browser login flow.
