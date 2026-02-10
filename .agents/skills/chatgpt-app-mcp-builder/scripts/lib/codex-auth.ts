import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type CodexCredentialStoreMode = "file" | "keyring" | "auto" | "unknown";

export type CodexAuthTokens = {
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
  accessTokenExpiresAt?: number;
  idTokenClaims?: {
    email?: string;
    exp?: number;
    planType?: string;
    workspaceId?: string;
  };
};

export type CodexAuthCacheResult = {
  codexHome: string;
  storeMode: CodexCredentialStoreMode;
  authPath: string;
  exists: boolean;
  tokens: CodexAuthTokens;
  warnings: string[];
};

export function resolveCodexHome(override?: string) {
  const trimmedOverride = (override ?? "").trim();
  if (trimmedOverride) {
    return path.resolve(trimmedOverride);
  }

  const fromEnv = (process.env.CODEX_HOME ?? "").trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  return path.join(os.homedir(), ".codex");
}

export async function readCodexAuthCache(
  codexHomeOverride?: string,
): Promise<CodexAuthCacheResult> {
  const codexHome = resolveCodexHome(codexHomeOverride);
  const configPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");
  const warnings: string[] = [];

  const storeMode = await readCredentialStoreMode(configPath);
  if (storeMode === "keyring") {
    warnings.push("Codex uses keyring auth. auth.json may be missing or stale.");
  }

  const authContents = await tryReadFile(authPath);
  if (authContents === null) {
    if (storeMode === "auto") {
      warnings.push("No Codex auth.json found. Credentials may be in keyring.");
    }
    return {
      codexHome,
      storeMode,
      authPath,
      exists: false,
      tokens: {},
      warnings,
    };
  }

  const parsed = safeJsonParse(authContents);
  if (!parsed || typeof parsed !== "object") {
    warnings.push("Unable to parse Codex auth cache.");
    return {
      codexHome,
      storeMode,
      authPath,
      exists: true,
      tokens: {},
      warnings,
    };
  }

  const record = parsed as Record<string, unknown>;
  const tokensRecord = (record.tokens ?? {}) as Record<string, unknown>;
  const accessToken = toNonEmptyString(tokensRecord.access_token);
  const refreshToken = toNonEmptyString(tokensRecord.refresh_token);
  const idToken = toNonEmptyString(tokensRecord.id_token);
  const accountId = toNonEmptyString(tokensRecord.account_id);

  const accessTokenExpiresAt = accessToken ? decodeJwtExp(accessToken) : undefined;
  const idTokenClaims = idToken ? decodeJwtClaims(idToken) : undefined;

  return {
    codexHome,
    storeMode,
    authPath,
    exists: true,
    tokens: {
      accessToken,
      refreshToken,
      idToken,
      accountId,
      accessTokenExpiresAt,
      idTokenClaims,
    },
    warnings,
  };
}

async function readCredentialStoreMode(configPath: string): Promise<CodexCredentialStoreMode> {
  const configContents = await tryReadFile(configPath);
  if (configContents === null) {
    return "auto";
  }

  const match = configContents.match(/^[ \t]*cli_auth_credentials_store[ \t]*=[ \t]*["']([^"']+)["']/m);
  const mode = (match?.[1] ?? "").trim().toLowerCase();
  if (mode === "file" || mode === "keyring" || mode === "auto") {
    return mode;
  }
  return mode ? "unknown" : "auto";
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

function toNonEmptyString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function decodeJwtExp(token: string) {
  const claims = decodeJwtClaims(token);
  if (!claims?.exp || typeof claims.exp !== "number") {
    return undefined;
  }
  return claims.exp * 1000;
}

function decodeJwtClaims(token: string) {
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  const payload = base64UrlDecode(parts[1]);
  if (!payload) {
    return undefined;
  }

  const parsed = safeJsonParse(payload);
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  return {
    exp: typeof record.exp === "number" ? record.exp : undefined,
    email: typeof record.email === "string" ? record.email : undefined,
    planType:
      typeof record.plan_type === "string"
        ? record.plan_type
        : typeof record.planType === "string"
          ? record.planType
          : undefined,
    workspaceId:
      typeof record.workspace_id === "string"
        ? record.workspace_id
        : typeof record.workspaceId === "string"
          ? record.workspaceId
          : undefined,
  };
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = padBase64(normalized);
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

function padBase64(value: string) {
  const remainder = value.length % 4;
  if (remainder === 0) {
    return value;
  }
  return value.padEnd(value.length + (4 - remainder), "=");
}
