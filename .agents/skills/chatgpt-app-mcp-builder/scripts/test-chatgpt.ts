#!/usr/bin/env node
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getBooleanOption, getStringOption, parseArgs } from "./lib/args";
import {
  buildChatgptTestUrl,
  normalizeToken,
  refreshConnectorActionsWithRetry,
} from "./lib/chatgpt-api";
import { resolveAccessTokenFromStore } from "./lib/chatgpt-auth";
import { openUrlInBrowser } from "./lib/browser";
import {
  mergeRepoConfig,
  readRepoConfig,
  resolveRepoConfigPath,
  writeRepoConfig,
} from "./lib/repo-config";

async function main() {
  const { options, positionals } = parseArgs();
  if (getBooleanOption(options, "help") || getBooleanOption(options, "h")) {
    printHelp();
    return;
  }

  const repoRoot = path.resolve(getStringOption(options, "repo") ?? process.cwd());
  const configPath = resolveRepoConfigPath(repoRoot, getStringOption(options, "config"));
  const config = await readRepoConfig(configPath);

  const connectorId =
    getStringOption(options, "connector-id") || config.connectorId || process.env.CHATGPT_APP_CONNECTOR_ID;
  if (!connectorId) {
    throw new Error(
      "Missing connector id. Run connect-chatgpt.ts first, set connectorId in config, or pass --connector-id.",
    );
  }

  const query =
    resolveQuery({
      direct: getStringOption(options, "query") || positionals.join(" "),
      pickLabel: getStringOption(options, "pick"),
      configQueries: config.testQueries,
    }) || "";

  if (!query.trim()) {
    throw new Error(
      "Missing query. Pass one directly, use --pick <label>, or add testQueries to chatgpt-app.local.json.",
    );
  }

  const explicitRefresh = options.refresh !== undefined;
  const shouldRefresh = explicitRefresh
    ? getBooleanOption(options, "refresh", false)
    : config.refreshBeforeTest ?? false;

  let nextConfig = config;
  if (shouldRefresh) {
    const linkId = config.linkId;
    if (!linkId) {
      throw new Error(
        "Refresh requested but linkId is missing in config. Re-run connect-chatgpt.ts or set linkId.",
      );
    }

    const auth = await resolveAccessTokenFromStore({ refreshIfStale: true, log: true });
    if (!auth.token) {
      const detail = auth.error ? ` (${auth.error})` : "";
      throw new Error(`No ChatGPT login found${detail}. Run auth-user.ts first.`);
    }

    const normalizedToken = normalizeToken(auth.token);
    if (!normalizedToken.token) {
      throw new Error("Invalid access token in auth store.");
    }

    const deviceId = config.deviceId || randomUUID();
    const refreshResult = await refreshConnectorActionsWithRetry({
      token: normalizedToken.token,
      deviceId,
      linkId,
    });

    if (refreshResult.ok) {
      const suffix =
        typeof refreshResult.actionsCount === "number"
          ? ` (${refreshResult.actionsCount} actions)`
          : "";
      console.log(`Connector actions refreshed${suffix}.`);
    } else {
      const detail = refreshResult.detail ? `: ${refreshResult.detail}` : "";
      console.warn(
        `Refresh failed after retry (${refreshResult.status} ${refreshResult.statusText}${detail}). Continuing...`,
      );
    }

    nextConfig = mergeRepoConfig(config, {
      deviceId,
      lastUpdatedAt: new Date().toISOString(),
    });
    await writeRepoConfig(configPath, nextConfig);
  }

  const url = buildChatgptTestUrl(connectorId, query);
  const shouldOpen = getBooleanOption(options, "open", true);
  if (shouldOpen) {
    const opened = await openUrlInBrowser(url);
    if (opened) {
      console.log("Opened ChatGPT in your browser.");
    } else {
      console.log("Unable to open browser automatically.");
    }
  }

  console.log(`Connector ID: ${connectorId}`);
  console.log(`Query: ${query}`);
  console.log(`URL: ${url}`);
  console.log(`Config: ${configPath}`);

  if (!nextConfig.testQueries?.length) {
    console.log(
      "Tip: add testQueries to chatgpt-app.local.json so running this script without a query picks a saved prompt.",
    );
  }
}

function resolveQuery({
  direct,
  pickLabel,
  configQueries,
}: {
  direct?: string;
  pickLabel?: string;
  configQueries?: Array<{ label?: string; query: string }>;
}) {
  const directQuery = (direct ?? "").trim();
  if (directQuery) {
    return directQuery;
  }

  if (!Array.isArray(configQueries) || configQueries.length === 0) {
    return "";
  }

  if (pickLabel) {
    const target = pickLabel.trim().toLowerCase();
    const match = configQueries.find((entry) => (entry.label ?? "").trim().toLowerCase() === target);
    if (!match) {
      throw new Error(`No test query found with label: ${pickLabel}`);
    }
    return (match.query ?? "").trim();
  }

  return (configQueries[0]?.query ?? "").trim();
}

function printHelp() {
  console.log(`Usage:
  test-chatgpt.ts [query] [options]

Options:
  --repo <path>              Target app repo (default: current directory)
  --config <path>            Repo config path (default: chatgpt-app.local.json)
  --connector-id <id>        Override connector id
  --query <text>             Query text (alternative to positional query)
  --pick <label>             Pick a saved test query by label from config
  --refresh                  Refresh connector actions before opening URL
  --no-refresh               Skip refresh explicitly
  --no-open                  Do not open browser; print URL only
  --help                     Show this message

Behavior:
  - If query is omitted, uses first entry in config.testQueries
  - If refresh flag is omitted, uses config.refreshBeforeTest
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
