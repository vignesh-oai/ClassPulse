import { openUrlInBrowser } from "./browser";
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_ISSUER,
  DEFAULT_SCOPE,
  parseIdTokenClaims,
} from "./chatgpt-auth";
import { generatePkce, type PkceCodes } from "./pkce";
import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";

const DEFAULT_PORT = 1455;
const MAX_BIND_ATTEMPTS = 10;
const BIND_RETRY_DELAY_MS = 200;
const ORIGINATOR_ENV = "CHATGPT_APP_ORIGINATOR";
const DEFAULT_ORIGINATOR = "codex_cli_rs";

export type LoginServerOptions = {
  issuer?: string;
  clientId?: string;
  port?: number;
  openBrowser?: boolean;
  forceState?: string;
  workspaceId?: string;
  originator?: string;
};

export type LoginServerTokens = {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  openaiApiKey?: string;
};

export type LoginServer = {
  authUrl: string;
  actualPort: number;
  blockUntilDone: () => Promise<LoginServerTokens>;
  cancel: () => Promise<void>;
};

export async function runLoginServer(options: LoginServerOptions = {}): Promise<LoginServer> {
  const issuer = (options.issuer ?? DEFAULT_ISSUER).trim();
  const clientId = (options.clientId ?? DEFAULT_CLIENT_ID).trim();
  const requestedPort = options.port ?? DEFAULT_PORT;
  const openBrowser = options.openBrowser !== false;
  const pkce = generatePkce();
  const state = options.forceState?.trim() || generateState();

  const server = http.createServer();
  const actualPort = await bindServer(server, requestedPort);
  const redirectUri = `http://localhost:${actualPort}/auth/callback`;
  const originator = resolveOriginator(options.originator);
  const authUrl = buildAuthorizeUrl({
    issuer,
    clientId,
    redirectUri,
    pkce,
    state,
    workspaceId: options.workspaceId,
    originator,
  });

  if (openBrowser) {
    const opened = await openUrlInBrowser(authUrl);
    if (!opened) {
      console.log("Unable to open browser automatically. Use the printed URL.");
    }
  }

  let completed = false;
  let resolveDone: (tokens: LoginServerTokens) => void = () => undefined;
  let rejectDone: (error: unknown) => void = () => undefined;
  const done = new Promise<LoginServerTokens>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  server.on("request", (req, res) => {
    void handleRequest({
      req,
      res,
      issuer,
      clientId,
      redirectUri,
      pkce,
      state,
      workspaceId: options.workspaceId,
      onComplete: (tokens) => {
        if (completed) {
          return;
        }
        completed = true;
        resolveDone(tokens);
      },
      onError: (error) => {
        if (completed) {
          return;
        }
        completed = true;
        rejectDone(error);
      },
      onFinish: () => {
        server.close();
      },
    });
  });

  return {
    authUrl,
    actualPort,
    blockUntilDone: async () => done,
    cancel: async () => {
      try {
        await sendCancelRequest(actualPort);
      } finally {
        server.close();
      }
    },
  };
}

async function handleRequest({
  req,
  res,
  issuer,
  clientId,
  redirectUri,
  pkce,
  state,
  workspaceId,
  onComplete,
  onError,
  onFinish,
}: {
  req: IncomingMessage;
  res: ServerResponse;
  issuer: string;
  clientId: string;
  redirectUri: string;
  pkce: PkceCodes;
  state: string;
  workspaceId?: string;
  onComplete: (tokens: LoginServerTokens) => void;
  onError: (error: unknown) => void;
  onFinish: () => void;
}) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/auth/callback") {
    const params = url.searchParams;
    if (params.get("state") !== state) {
      respondText(res, 400, "State mismatch");
      return;
    }
    const code = params.get("code");
    if (!code) {
      respondText(res, 400, "Missing authorization code");
      return;
    }

    try {
      const tokens = await exchangeCodeForTokens({
        issuer,
        clientId,
        redirectUri,
        pkce,
        code,
      });

      const workspaceError = ensureWorkspaceAllowed(workspaceId, tokens.idToken);
      if (workspaceError) {
        respondText(res, 403, workspaceError);
        onError(new Error(workspaceError));
        onFinish();
        return;
      }

      let openaiApiKey: string | undefined;
      try {
        openaiApiKey = await obtainApiKey({ issuer, clientId, idToken: tokens.idToken });
      } catch {
        openaiApiKey = undefined;
      }

      respondHtml(res, 200, buildSuccessHtml());
      onComplete({ ...tokens, openaiApiKey });
      onFinish();
      return;
    } catch (error) {
      respondText(res, 500, `Token exchange failed: ${formatError(error)}`);
      onError(error);
      onFinish();
      return;
    }
  }

  if (pathname === "/cancel") {
    respondText(res, 200, "Login cancelled");
    onError(new Error("Login cancelled"));
    onFinish();
    return;
  }

  if (pathname === "/success") {
    respondHtml(res, 200, buildSuccessHtml());
    onFinish();
    return;
  }

  respondText(res, 404, "Not found");
}

function buildAuthorizeUrl({
  issuer,
  clientId,
  redirectUri,
  pkce,
  state,
  workspaceId,
  originator,
}: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  pkce: PkceCodes;
  state: string;
  workspaceId?: string;
  originator: string;
}) {
  const url = new URL("/oauth/authorize", issuer);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", DEFAULT_SCOPE);
  url.searchParams.set("code_challenge", pkce.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("state", state);
  url.searchParams.set("originator", originator);
  if (workspaceId?.trim()) {
    url.searchParams.set("allowed_workspace_id", workspaceId.trim());
  }
  return url.toString();
}

function generateState() {
  return randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function resolveOriginator(override?: string) {
  const fromOverride = (override ?? "").trim();
  if (fromOverride) {
    return fromOverride;
  }
  const fromEnv = (process.env[ORIGINATOR_ENV] ?? "").trim();
  if (fromEnv) {
    return fromEnv;
  }
  return DEFAULT_ORIGINATOR;
}

async function bindServer(server: http.Server, port: number) {
  let attempts = 0;
  let cancelAttempted = false;

  while (attempts < MAX_BIND_ATTEMPTS) {
    attempts += 1;
    try {
      await listen(server, port);
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Unable to determine bound port.");
      }
      return address.port;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE") {
        throw error;
      }

      if (!cancelAttempted) {
        cancelAttempted = true;
        try {
          await sendCancelRequest(port);
        } catch {
          // Best effort.
        }
      }

      await delay(BIND_RETRY_DELAY_MS);
    }
  }

  throw new Error(`Port 127.0.0.1:${port} is already in use.`);
}

function listen(server: http.Server, port: number) {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function sendCancelRequest(port: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(`http://127.0.0.1:${port}/cancel`, {
      method: "GET",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function exchangeCodeForTokens({
  issuer,
  clientId,
  redirectUri,
  pkce,
  code,
}: {
  issuer: string;
  clientId: string;
  redirectUri: string;
  pkce: PkceCodes;
  code: string;
}) {
  const endpoint = new URL("/oauth/token", issuer);
  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", redirectUri);
  body.set("client_id", clientId);
  body.set("code_verifier", pkce.codeVerifier);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`token endpoint returned status ${response.status}`);
  }

  const json = (await response.json()) as Record<string, unknown>;
  return {
    idToken: asRequiredString(json.id_token, "id_token"),
    accessToken: asRequiredString(json.access_token, "access_token"),
    refreshToken: asRequiredString(json.refresh_token, "refresh_token"),
  };
}

async function obtainApiKey({
  issuer,
  clientId,
  idToken,
}: {
  issuer: string;
  clientId: string;
  idToken: string;
}) {
  const endpoint = new URL("/oauth/token", issuer);
  const body = new URLSearchParams();
  body.set("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange");
  body.set("client_id", clientId);
  body.set("requested_token", "openai-api-key");
  body.set("subject_token", idToken);
  body.set("subject_token_type", "urn:ietf:params:oauth:token-type:id_token");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`api key exchange failed with status ${response.status}`);
  }

  const json = (await response.json()) as Record<string, unknown>;
  return asRequiredString(json.access_token, "access_token");
}

function ensureWorkspaceAllowed(expectedWorkspaceId: string | undefined, idToken: string) {
  if (!expectedWorkspaceId?.trim()) {
    return undefined;
  }

  const claims = parseIdTokenClaims(idToken);
  const actual = claims?.chatgptAccountId;
  if (!actual) {
    return "Workspace-restricted login requested but token had no chatgpt_account_id.";
  }
  if (actual !== expectedWorkspaceId) {
    return `Login is restricted to workspace id ${expectedWorkspaceId}.`;
  }
  return undefined;
}

function respondText(res: ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Connection", "close");
  res.end(body);
}

function respondHtml(res: ServerResponse, status: number, body: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Connection", "close");
  res.end(body);
}

function buildSuccessHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ChatGPT Login Complete</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        color: #0f172a;
        background: #ffffff;
      }
      .card {
        text-align: center;
        padding: 24px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 22px;
      }
      p {
        margin: 0;
        color: #64748b;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Signed in to ChatGPT</h1>
      <p>You can close this page now.</p>
    </div>
  </body>
</html>`;
}

function asRequiredString(value: unknown, field: string) {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(`Missing required token field: ${field}`);
}

function formatError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
