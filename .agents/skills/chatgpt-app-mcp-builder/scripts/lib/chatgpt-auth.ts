import {
  createAuthDotJson,
  readAuthStore,
  writeAuthStore,
  type ChatgptAuthDotJson,
  type ChatgptIdTokenClaims,
  type ChatgptTokenData,
} from "./auth-store";

export const DEFAULT_ISSUER = "https://auth.openai.com";
export const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const DEFAULT_SCOPE = "openid profile email offline_access";

const TOKEN_REFRESH_INTERVAL_DAYS = 8;
const REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const REFRESH_TOKEN_URL_OVERRIDE_ENV = "CHATGPT_APP_REFRESH_TOKEN_URL_OVERRIDE";
const CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV = "CODEX_REFRESH_TOKEN_URL_OVERRIDE";

export type ResolveAccessTokenResult = {
  token?: string;
  refreshed: boolean;
  authPath: string;
  auth: ChatgptAuthDotJson | null;
  error?: string;
};

export async function resolveAccessTokenFromStore({
  homeOverride,
  refreshIfStale = true,
  log = false,
}: {
  homeOverride?: string;
  refreshIfStale?: boolean;
  log?: boolean;
}): Promise<ResolveAccessTokenResult> {
  const store = await readAuthStore(homeOverride);
  const auth = store.auth;
  if (!auth?.tokens?.accessToken) {
    return {
      token: undefined,
      refreshed: false,
      authPath: store.authPath,
      auth,
      error: store.exists ? "Auth store missing tokens." : undefined,
    };
  }

  if (!refreshIfStale) {
    return {
      token: auth.tokens.accessToken,
      refreshed: false,
      authPath: store.authPath,
      auth,
    };
  }

  const isStale = isRefreshStale(auth.lastRefresh);
  if (!isStale) {
    return {
      token: auth.tokens.accessToken,
      refreshed: false,
      authPath: store.authPath,
      auth,
    };
  }

  if (!auth.tokens.refreshToken) {
    return {
      token: auth.tokens.accessToken,
      refreshed: false,
      authPath: store.authPath,
      auth,
      error: "Auth store is stale but has no refresh token.",
    };
  }

  try {
    if (log) {
      console.log(`Refreshing tokens from ${auth.issuer || DEFAULT_ISSUER}...`);
    }
    const refreshed = await refreshAuthStoreTokens({ homeOverride, log });
    return {
      token: refreshed.tokens?.accessToken,
      refreshed: true,
      authPath: store.authPath,
      auth: refreshed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      token: auth.tokens.accessToken,
      refreshed: false,
      authPath: store.authPath,
      auth,
      error: message,
    };
  }
}

export async function refreshAuthStoreTokens({
  homeOverride,
  log = false,
}: {
  homeOverride?: string;
  log?: boolean;
}) {
  const store = await readAuthStore(homeOverride);
  const auth = store.auth;
  if (!auth?.tokens?.refreshToken) {
    throw new Error("No refresh token available in auth store.");
  }

  const issuer = auth.issuer || DEFAULT_ISSUER;
  const clientId = auth.clientId || DEFAULT_CLIENT_ID;

  if (log) {
    console.log(`Refreshing tokens via ${issuer}...`);
  }

  const refreshed = await tryRefreshToken({
    refreshToken: auth.tokens.refreshToken,
    clientId,
  });

  const idToken = refreshed.idToken ?? auth.tokens.idToken;
  const nextTokens: ChatgptTokenData = {
    idToken,
    accessToken: refreshed.accessToken ?? auth.tokens.accessToken,
    refreshToken: refreshed.refreshToken ?? auth.tokens.refreshToken,
    accountId: auth.tokens.accountId,
    idTokenClaims: idToken ? parseIdTokenClaims(idToken) : auth.tokens.idTokenClaims,
  };

  const nextAuth = createAuthDotJson({
    issuer,
    clientId,
    openaiApiKey: auth.openaiApiKey,
    tokens: nextTokens,
    source: "refresh",
    lastRefresh: Date.now(),
  });

  await writeAuthStore({ homeOverride, auth: nextAuth });
  return nextAuth;
}

export function parseIdTokenClaims(idToken: string): ChatgptIdTokenClaims | undefined {
  const payload = decodeJwtPayload(idToken);
  if (!payload) {
    return undefined;
  }

  const email = toNonEmptyString(payload.email);
  const exp = toNumber(payload.exp);
  const authClaims = extractAuthClaims(payload);
  const chatgptPlanType = toNonEmptyString(authClaims?.chatgpt_plan_type);
  const chatgptAccountId = toNonEmptyString(authClaims?.chatgpt_account_id);
  const chatgptUserId = toNonEmptyString(authClaims?.chatgpt_user_id);

  return {
    email,
    exp,
    chatgptPlanType,
    chatgptAccountId,
    chatgptUserId,
  };
}

function extractAuthClaims(payload: Record<string, unknown>) {
  const auth = payload["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") {
    return undefined;
  }
  return auth as Record<string, unknown>;
}

function isRefreshStale(lastRefresh?: number) {
  if (!lastRefresh) {
    return true;
  }
  const ageMs = Date.now() - lastRefresh;
  const maxAgeMs = TOKEN_REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
  return ageMs >= maxAgeMs;
}

async function tryRefreshToken({
  refreshToken,
  clientId,
}: {
  refreshToken: string;
  clientId: string;
}) {
  const endpoint = refreshTokenEndpoint();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const code = extractRefreshErrorCode(text);
    const detail = code ? `${response.status} (${code})` : `${response.status}`;
    throw new Error(`Failed to refresh token: ${detail}`);
  }

  const json = (await response.json()) as Record<string, unknown>;
  return {
    idToken: toNonEmptyString(json.id_token),
    accessToken: toNonEmptyString(json.access_token),
    refreshToken: toNonEmptyString(json.refresh_token),
  };
}

function extractRefreshErrorCode(body: string) {
  if (!body.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const err = parsed.error;
    if (typeof err === "string") {
      return err;
    }
    if (err && typeof err === "object") {
      const code = (err as Record<string, unknown>).code;
      return typeof code === "string" ? code : undefined;
    }
    const code = parsed.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

function refreshTokenEndpoint() {
  const override =
    (process.env[REFRESH_TOKEN_URL_OVERRIDE_ENV] ?? "").trim() ||
    (process.env[CODEX_REFRESH_TOKEN_URL_OVERRIDE_ENV] ?? "").trim();
  return override || REFRESH_TOKEN_URL;
}

function decodeJwtPayload(token: string) {
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  const payload = base64UrlDecode(parts[1]);
  if (!payload) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const remainder = normalized.length % 4;
  const padded =
    remainder === 0 ? normalized : normalized.padEnd(normalized.length + (4 - remainder), "=");
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function toNonEmptyString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
