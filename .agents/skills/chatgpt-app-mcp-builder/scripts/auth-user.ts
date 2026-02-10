#!/usr/bin/env node
import {
  clearAuthStore,
  createAuthDotJson,
  readAuthStore,
  resolveAuthPath,
  writeAuthStore,
} from "./lib/auth-store";
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_ISSUER,
  parseIdTokenClaims,
  refreshAuthStoreTokens,
} from "./lib/chatgpt-auth";
import { readCodexAuthCache } from "./lib/codex-auth";
import { runLoginServer } from "./lib/login-server";
import { getBooleanOption, getStringOption, parseArgs } from "./lib/args";
import { normalizeToken } from "./lib/chatgpt-api";

async function main() {
  const { options } = parseArgs();

  if (getBooleanOption(options, "help") || getBooleanOption(options, "h")) {
    printHelp();
    return;
  }

  const home = getStringOption(options, "home");
  const codexHome = getStringOption(options, "codex-home");
  const issuer = getStringOption(options, "issuer") ?? DEFAULT_ISSUER;
  const clientId = getStringOption(options, "client-id") ?? DEFAULT_CLIENT_ID;

  const status = getBooleanOption(options, "status");
  const logout = getBooleanOption(options, "logout");
  const refresh = getBooleanOption(options, "refresh");
  const fromCodex = getBooleanOption(options, "from-codex") || Boolean(codexHome);
  const tokenInput = getStringOption(options, "token");

  if (status) {
    await printStatus({ home, codexHome, includeCodex: fromCodex });
    return;
  }

  if (logout) {
    const cleared = await clearAuthStore(home);
    const authPath = resolveAuthPath(home).authPath;
    if (cleared) {
      console.log(`Cleared auth store: ${authPath}`);
    } else {
      console.log(`No auth store found at: ${authPath}`);
    }
    return;
  }

  if (refresh) {
    await refreshAuthStoreTokens({ homeOverride: home, log: true });
    console.log(`Tokens refreshed. Store: ${resolveAuthPath(home).authPath}`);
    return;
  }

  if (tokenInput) {
    await saveManualToken({ home, issuer, clientId, tokenInput });
    return;
  }

  if (fromCodex) {
    await importFromCodex({ home, codexHome, issuer, clientId });
    return;
  }

  await runBrowserLogin({
    home,
    issuer,
    clientId,
    workspaceId: getStringOption(options, "workspace-id"),
    openBrowser: getBooleanOption(options, "open-browser", true),
    port: getStringOption(options, "port"),
  });
}

async function saveManualToken({
  home,
  issuer,
  clientId,
  tokenInput,
}: {
  home?: string;
  issuer: string;
  clientId: string;
  tokenInput: string;
}) {
  const normalized = normalizeToken(tokenInput).token;
  if (!normalized) {
    throw new Error("Invalid token. Provide only the token value.");
  }

  const auth = createAuthDotJson({
    issuer,
    clientId,
    tokens: { accessToken: normalized },
    source: "manual",
    lastRefresh: Date.now(),
  });

  const result = await writeAuthStore({ homeOverride: home, auth });
  console.log(`Token saved to ${result.authPath}`);
}

async function importFromCodex({
  home,
  codexHome,
  issuer,
  clientId,
}: {
  home?: string;
  codexHome?: string;
  issuer: string;
  clientId: string;
}) {
  const codex = await readCodexAuthCache(codexHome);
  for (const warning of codex.warnings) {
    console.warn(`Warning: ${warning}`);
  }

  const accessToken = codex.tokens.accessToken?.trim();
  if (!accessToken) {
    throw new Error(
      `Unable to find a ChatGPT access token in Codex auth cache (${codex.authPath}).`,
    );
  }

  const idTokenClaims = codex.tokens.idToken ? parseIdTokenClaims(codex.tokens.idToken) : undefined;
  const auth = createAuthDotJson({
    issuer,
    clientId,
    tokens: {
      idToken: codex.tokens.idToken,
      accessToken,
      refreshToken: codex.tokens.refreshToken,
      accountId: idTokenClaims?.chatgptAccountId ?? codex.tokens.accountId,
      idTokenClaims,
    },
    source: "codex-cache",
    lastRefresh: Date.now(),
  });

  const result = await writeAuthStore({ homeOverride: home, auth });
  console.log(`Imported Codex auth into ${result.authPath}`);
}

async function runBrowserLogin({
  home,
  issuer,
  clientId,
  workspaceId,
  openBrowser,
  port,
}: {
  home?: string;
  issuer: string;
  clientId: string;
  workspaceId?: string;
  openBrowser: boolean;
  port?: string;
}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Interactive login requires a TTY. Use --from-codex or --token in non-interactive environments.",
    );
  }

  const numericPort = port ? Number.parseInt(port, 10) : undefined;
  if (port && (!Number.isFinite(numericPort) || numericPort! <= 0)) {
    throw new Error(`Invalid --port value: ${port}`);
  }

  const loginServer = await runLoginServer({
    issuer,
    clientId,
    workspaceId,
    openBrowser,
    port: numericPort,
  });

  console.log(`Login server: http://localhost:${loginServer.actualPort}`);
  console.log("Open this URL if browser did not open automatically:");
  console.log(loginServer.authUrl);

  const tokens = await loginServer.blockUntilDone();
  const idTokenClaims = tokens.idToken ? parseIdTokenClaims(tokens.idToken) : undefined;

  const auth = createAuthDotJson({
    issuer,
    clientId,
    openaiApiKey: tokens.openaiApiKey,
    tokens: {
      idToken: tokens.idToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accountId: idTokenClaims?.chatgptAccountId,
      idTokenClaims,
    },
    source: "browser",
    lastRefresh: Date.now(),
  });

  const result = await writeAuthStore({ homeOverride: home, auth });
  console.log(`Login complete. Auth store: ${result.authPath}`);
  if (idTokenClaims?.email) {
    console.log(`Account: ${maskEmail(idTokenClaims.email)}`);
  }
}

async function printStatus({
  home,
  codexHome,
  includeCodex,
}: {
  home?: string;
  codexHome?: string;
  includeCodex: boolean;
}) {
  const store = await readAuthStore(home);
  for (const warning of store.warnings) {
    console.warn(`Warning: ${warning}`);
  }

  console.log("Auth store status");
  console.log(`Path: ${store.authPath}`);
  console.log(`Exists: ${store.exists ? "yes" : "no"}`);

  const accessToken = store.auth?.tokens?.accessToken;
  if (accessToken) {
    console.log(`Access token: yes (${summarizeToken(accessToken)})`);
    if (store.auth?.lastRefresh) {
      console.log(`Last refresh: ${new Date(store.auth.lastRefresh).toISOString()}`);
    }
    if (store.auth?.source) {
      console.log(`Source: ${store.auth.source}`);
    }
    const email = store.auth?.tokens?.idTokenClaims?.email;
    if (email) {
      console.log(`Account: ${maskEmail(email)}`);
    }
  } else {
    console.log("Access token: no");
  }

  if (!includeCodex) {
    return;
  }

  const codex = await readCodexAuthCache(codexHome);
  for (const warning of codex.warnings) {
    console.warn(`Warning: ${warning}`);
  }

  console.log("");
  console.log("Codex cache status");
  console.log(`Codex home: ${codex.codexHome}`);
  console.log(`Store mode: ${codex.storeMode}`);
  console.log(`Auth path: ${codex.authPath}`);
  console.log(`Exists: ${codex.exists ? "yes" : "no"}`);

  if (codex.tokens.accessToken) {
    console.log(`Access token: yes (${summarizeToken(codex.tokens.accessToken)})`);
    if (codex.tokens.idTokenClaims?.email) {
      console.log(`Account: ${maskEmail(codex.tokens.idTokenClaims.email)}`);
    }
  } else {
    console.log("Access token: no");
  }
}

function summarizeToken(token: string) {
  const dotCount = (token.match(/\./g) ?? []).length;
  const jwt = dotCount === 2 ? "yes" : "no";
  return `length=${token.length}, jwt=${jwt}`;
}

function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  if (!name || !domain) {
    return email;
  }
  if (name.length <= 2) {
    return `${name[0] ?? "*"}*@${domain}`;
  }
  return `${name[0]}${"*".repeat(Math.max(1, name.length - 2))}${name[name.length - 1]}@${domain}`;
}

function printHelp() {
  console.log(`Usage:
  auth-user.ts [options]

Options:
  --from-codex               Import tokens from Codex auth cache
  --token <token>            Save a manually provided bearer token
  --status                   Print auth status
  --refresh                  Refresh tokens using refresh token
  --logout                   Remove central auth store
  --home <path>              Override CHATGPT_APP_HOME (default ~/.chatgpt-app)
  --codex-home <path>        Override CODEX_HOME for --from-codex
  --issuer <url>             OAuth issuer (default ${DEFAULT_ISSUER})
  --client-id <id>           OAuth client id (default ${DEFAULT_CLIENT_ID})
  --workspace-id <id>        Restrict browser login to one workspace
  --port <number>            Callback port (default 1455)
  --no-open-browser          Do not auto-open browser during interactive login
  --help                     Show this message
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
