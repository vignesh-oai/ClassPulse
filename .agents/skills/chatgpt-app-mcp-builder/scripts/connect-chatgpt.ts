#!/usr/bin/env node
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getBooleanOption, getStringOption, parseArgs } from "./lib/args";
import {
  createConnectorWithNameFallback,
  ensureDeveloperModeEnabled,
  linkConnectorWithRetry,
  normalizeMcpUrl,
  normalizeToken,
} from "./lib/chatgpt-api";
import { resolveAccessTokenFromStore } from "./lib/chatgpt-auth";
import {
  mergeRepoConfig,
  readRepoConfig,
  resolveRepoConfigPath,
  writeRepoConfig,
  type RepoConfig,
} from "./lib/repo-config";

async function main() {
  const { options } = parseArgs();
  if (getBooleanOption(options, "help") || getBooleanOption(options, "h")) {
    printHelp();
    return;
  }

  const repoRoot = path.resolve(getStringOption(options, "repo") ?? process.cwd());
  const configPath = resolveRepoConfigPath(repoRoot, getStringOption(options, "config"));
  const currentConfig = await readRepoConfig(configPath);

  const auth = await resolveAccessTokenFromStore({ refreshIfStale: true, log: true });
  if (!auth.token) {
    const detail = auth.error ? ` (${auth.error})` : "";
    throw new Error(`No ChatGPT login found${detail}. Run auth-user.ts first.`);
  }
  if (auth.refreshed) {
    console.log("Refreshed ChatGPT token from central auth store.");
  }

  const normalizedToken = normalizeToken(auth.token);
  if (!normalizedToken.token) {
    throw new Error("Invalid access token in auth store.");
  }

  const accountId =
    auth.auth?.tokens?.accountId ?? auth.auth?.tokens?.idTokenClaims?.chatgptAccountId;

  const deviceId = currentConfig.deviceId || randomUUID();
  const connectorName =
    getStringOption(options, "name") ||
    currentConfig.connectorName ||
    guessConnectorName(repoRoot);
  const connectorDescription =
    getStringOption(options, "description") ?? currentConfig.connectorDescription ?? "";

  const linkOnlyConnectorId = getStringOption(options, "link-only");
  if (linkOnlyConnectorId) {
    await linkExistingConnector({
      connectorId: linkOnlyConnectorId,
      connectorName,
      token: normalizedToken.token,
      deviceId,
      repoConfigPath: configPath,
      currentConfig,
    });
    return;
  }

  const mcpUrlInput = getStringOption(options, "mcp-url") || currentConfig.mcpUrl;
  if (!mcpUrlInput) {
    throw new Error(
      "Missing MCP URL. Pass --mcp-url <https://.../mcp> or set mcpUrl in chatgpt-app.local.json.",
    );
  }
  const normalizedMcpUrl = normalizeMcpUrl(mcpUrlInput);
  if (normalizedMcpUrl.changed) {
    console.log(`Normalized MCP URL: ${normalizedMcpUrl.value}`);
  }

  const skipDeveloperMode = getBooleanOption(options, "skip-developer-mode");
  if (!skipDeveloperMode) {
    console.log("Ensuring ChatGPT developer mode is enabled...");
    await ensureDeveloperModeEnabled({
      token: normalizedToken.token,
      deviceId,
      accountId,
    });
  }

  console.log("Creating ChatGPT connector...");
  const created = await createConnectorWithNameFallback({
    token: normalizedToken.token,
    deviceId,
    accountId,
    baseName: connectorName,
    description: connectorDescription,
    mcpUrl: normalizedMcpUrl.value,
  });

  console.log(`Created connector ${created.connectorName} (${created.connectorId}).`);
  console.log("Linking connector to your ChatGPT account...");
  const linked = await linkConnectorWithRetry({
    token: normalizedToken.token,
    deviceId,
    connectorId: created.connectorId,
    connectorName: created.connectorName,
  });

  const nextConfig = mergeRepoConfig(currentConfig, {
    mcpUrl: normalizedMcpUrl.value,
    connectorName: created.connectorName,
    connectorDescription,
    connectorId: created.connectorId,
    linkId: linked.linkId,
    linkStatus: linked.linkStatus,
    userId: linked.userId,
    deviceId,
    lastUpdatedAt: new Date().toISOString(),
  });
  await writeRepoConfig(configPath, nextConfig);

  printConnectorSummary({
    configPath,
    connectorId: created.connectorId,
    connectorName: created.connectorName,
    connectorStatus: created.connectorStatus,
    connectorServiceUrl: created.connectorServiceUrl,
    linkId: linked.linkId,
    linkStatus: linked.linkStatus,
    userId: linked.userId,
    mcpUrl: normalizedMcpUrl.value,
  });
}

async function linkExistingConnector({
  connectorId,
  connectorName,
  token,
  deviceId,
  repoConfigPath,
  currentConfig,
}: {
  connectorId: string;
  connectorName: string;
  token: string;
  deviceId: string;
  repoConfigPath: string;
  currentConfig: RepoConfig;
}) {
  console.log(`Linking existing connector ${connectorId}...`);
  const linked = await linkConnectorWithRetry({
    token,
    deviceId,
    connectorId,
    connectorName,
  });

  const nextConfig = mergeRepoConfig(currentConfig, {
    connectorId,
    connectorName,
    linkId: linked.linkId,
    linkStatus: linked.linkStatus,
    userId: linked.userId,
    deviceId,
    lastUpdatedAt: new Date().toISOString(),
  });
  await writeRepoConfig(repoConfigPath, nextConfig);

  printConnectorSummary({
    configPath: repoConfigPath,
    connectorId,
    connectorName,
    linkId: linked.linkId,
    linkStatus: linked.linkStatus,
    userId: linked.userId,
    mcpUrl: nextConfig.mcpUrl,
  });
}

function printConnectorSummary({
  configPath,
  connectorId,
  connectorName,
  connectorStatus,
  connectorServiceUrl,
  linkId,
  linkStatus,
  userId,
  mcpUrl,
}: {
  configPath: string;
  connectorId: string;
  connectorName: string;
  connectorStatus?: string;
  connectorServiceUrl?: string;
  linkId?: string;
  linkStatus?: string;
  userId?: string;
  mcpUrl?: string;
}) {
  console.log("");
  console.log("Connector ready");
  console.log(`Connector ID: ${connectorId}`);
  console.log(`Connector name: ${connectorName}`);
  if (connectorStatus) {
    console.log(`Connector status: ${connectorStatus}`);
  }
  if (connectorServiceUrl) {
    console.log(`Connector service URL: ${connectorServiceUrl}`);
  }
  if (mcpUrl) {
    console.log(`MCP URL: ${mcpUrl}`);
  }
  if (linkId) {
    console.log(`Link ID: ${linkId}`);
  }
  if (linkStatus) {
    console.log(`Link status: ${linkStatus}`);
  }
  if (userId) {
    console.log(`User ID: ${userId}`);
  }
  console.log(`Saved: ${configPath}`);
}

function guessConnectorName(repoRoot: string) {
  const base = path.basename(repoRoot);
  return base || "chatgpt-app";
}

function printHelp() {
  console.log(`Usage:
  connect-chatgpt.ts [options]

Options:
  --repo <path>              Target app repo (default: current directory)
  --config <path>            Repo config path (default: chatgpt-app.local.json)
  --mcp-url <url>            HTTPS MCP URL (auto-normalized to end with /mcp)
  --name <name>              Connector name (default: config.connectorName or repo name)
  --description <text>       Connector description
  --link-only <connectorId>  Link an existing connector without creating a new one
  --skip-developer-mode      Skip developer mode enable API call
  --help                     Show this message

Notes:
  - Uses central auth store at ~/.chatgpt-app/auth.json
  - Writes connector/link/device ids to repo config file
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
