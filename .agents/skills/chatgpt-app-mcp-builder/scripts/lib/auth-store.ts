import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CHATGPT_APP_HOME_ENV = "CHATGPT_APP_HOME";
const AUTH_FILENAME = "auth.json";

export type ChatgptIdTokenClaims = {
  email?: string;
  exp?: number;
  chatgptPlanType?: string;
  chatgptAccountId?: string;
  chatgptUserId?: string;
};

export type ChatgptTokenData = {
  idToken?: string;
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
  idTokenClaims?: ChatgptIdTokenClaims;
};

export type ChatgptAuthDotJson = {
  version: 1;
  issuer: string;
  clientId: string;
  openaiApiKey?: string;
  tokens?: ChatgptTokenData;
  lastRefresh?: number;
  source?: string;
};

export type ReadAuthStoreResult = {
  homeDir: string;
  authPath: string;
  exists: boolean;
  auth: ChatgptAuthDotJson | null;
  warnings: string[];
};

export function resolveChatgptAppHome(override?: string) {
  const trimmedOverride = (override ?? "").trim();
  if (trimmedOverride) {
    return path.resolve(trimmedOverride);
  }

  const fromEnv = (process.env[CHATGPT_APP_HOME_ENV] ?? "").trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  return path.join(os.homedir(), ".chatgpt-app");
}

export function resolveAuthPath(homeOverride?: string) {
  const homeDir = resolveChatgptAppHome(homeOverride);
  const authPath = path.join(homeDir, AUTH_FILENAME);
  return { homeDir, authPath };
}

export async function readAuthStore(homeOverride?: string): Promise<ReadAuthStoreResult> {
  const { homeDir, authPath } = resolveAuthPath(homeOverride);
  const warnings: string[] = [];

  const contents = await tryReadFile(authPath);
  if (contents === null) {
    return { homeDir, authPath, exists: false, auth: null, warnings };
  }

  const parsed = safeJsonParse(contents);
  if (!parsed || typeof parsed !== "object") {
    warnings.push("Unable to parse auth store JSON.");
    return { homeDir, authPath, exists: true, auth: null, warnings };
  }

  const normalized = normalizeAuth(parsed as Record<string, unknown>, warnings);
  return { homeDir, authPath, exists: true, auth: normalized, warnings };
}

export async function writeAuthStore({
  homeOverride,
  auth,
}: {
  homeOverride?: string;
  auth: ChatgptAuthDotJson;
}) {
  const { homeDir, authPath } = resolveAuthPath(homeOverride);
  await fs.mkdir(homeDir, { recursive: true });

  const serialized = `${JSON.stringify(auth, null, 2)}\n`;
  await fs.writeFile(authPath, serialized, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.chmod(authPath, 0o600);
  } catch {
    // Best effort only.
  }

  return { homeDir, authPath, auth };
}

export async function clearAuthStore(homeOverride?: string) {
  const { authPath } = resolveAuthPath(homeOverride);
  try {
    await fs.unlink(authPath);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function createAuthDotJson({
  issuer,
  clientId,
  openaiApiKey,
  tokens,
  source,
  lastRefresh,
}: {
  issuer: string;
  clientId: string;
  openaiApiKey?: string;
  tokens?: ChatgptTokenData;
  source?: string;
  lastRefresh?: number;
}): ChatgptAuthDotJson {
  return {
    version: 1,
    issuer,
    clientId,
    openaiApiKey,
    tokens,
    lastRefresh: lastRefresh ?? Date.now(),
    source,
  };
}

async function tryReadFile(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function safeJsonParse(value: string) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeAuth(raw: Record<string, unknown>, warnings: string[]): ChatgptAuthDotJson {
  const issuer = toNonEmptyString(raw.issuer) ?? "https://auth.openai.com";
  const clientId =
    toNonEmptyString(raw.clientId) ??
    toNonEmptyString(raw.client_id) ??
    "app_EMoamEEZ73f0CkXaXp7hrann";

  const openaiApiKey =
    toNonEmptyString(raw.openaiApiKey) ??
    toNonEmptyString(raw.openai_api_key) ??
    toNonEmptyString(raw.OPENAI_API_KEY);

  const tokensRecord = (raw.tokens ?? {}) as Record<string, unknown>;
  const idToken =
    toNonEmptyString(tokensRecord.idToken) ?? toNonEmptyString(tokensRecord.id_token) ?? undefined;
  const accessToken =
    toNonEmptyString(tokensRecord.accessToken) ??
    toNonEmptyString(tokensRecord.access_token) ??
    undefined;
  const refreshToken =
    toNonEmptyString(tokensRecord.refreshToken) ??
    toNonEmptyString(tokensRecord.refresh_token) ??
    undefined;

  const accountId =
    toNonEmptyString(tokensRecord.accountId) ??
    toNonEmptyString(tokensRecord.account_id) ??
    undefined;

  let tokens: ChatgptTokenData | undefined;
  if (accessToken) {
    tokens = {
      idToken,
      accessToken,
      refreshToken,
      accountId,
      idTokenClaims: normalizeIdTokenClaims(
        tokensRecord.idTokenClaims ?? tokensRecord.id_token_claims,
      ),
    };
  } else if (raw.tokens) {
    warnings.push("Auth store is missing an access token.");
  }

  const lastRefresh =
    toNumber(raw.lastRefresh) ?? toNumber(raw.last_refresh) ?? (tokens ? Date.now() : undefined);

  return {
    version: 1,
    issuer,
    clientId,
    openaiApiKey,
    tokens,
    lastRefresh,
    source: toNonEmptyString(raw.source) ?? undefined,
  };
}

function normalizeIdTokenClaims(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    email: toNonEmptyString(record.email),
    exp: toNumber(record.exp),
    chatgptPlanType:
      toNonEmptyString(record.chatgptPlanType) ?? toNonEmptyString(record.chatgpt_plan_type),
    chatgptAccountId:
      toNonEmptyString(record.chatgptAccountId) ?? toNonEmptyString(record.chatgpt_account_id),
    chatgptUserId:
      toNonEmptyString(record.chatgptUserId) ?? toNonEmptyString(record.chatgpt_user_id),
  } satisfies ChatgptIdTokenClaims;
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
