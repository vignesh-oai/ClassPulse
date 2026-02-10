import fs from "node:fs/promises";
import path from "node:path";

export const DEFAULT_REPO_CONFIG_FILE = "chatgpt-app.local.json";

export type TestQuery = {
  label?: string;
  query: string;
};

export type RepoConfig = {
  mcpUrl?: string;
  connectorName?: string;
  connectorDescription?: string;
  connectorId?: string;
  linkId?: string;
  linkStatus?: string;
  userId?: string;
  deviceId?: string;
  refreshBeforeTest?: boolean;
  testQueries?: TestQuery[];
  lastUpdatedAt?: string;
};

export function resolveRepoConfigPath(repoRoot: string, configOverride?: string) {
  const trimmed = (configOverride ?? "").trim();
  if (!trimmed) {
    return path.join(repoRoot, DEFAULT_REPO_CONFIG_FILE);
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return path.join(repoRoot, trimmed);
}

export async function readRepoConfig(configPath: string): Promise<RepoConfig> {
  const contents = await tryReadFile(configPath);
  if (contents === null) {
    return {};
  }

  const parsed = safeJsonParse(contents);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config file is not a JSON object: ${configPath}`);
  }

  return normalizeRepoConfig(parsed as Record<string, unknown>);
}

export async function writeRepoConfig(configPath: string, config: RepoConfig) {
  const directory = path.dirname(configPath);
  await fs.mkdir(directory, { recursive: true });

  const normalized = normalizeRepoConfig(config as unknown as Record<string, unknown>);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  await fs.writeFile(configPath, serialized, "utf8");
}

export function mergeRepoConfig(current: RepoConfig, updates: RepoConfig): RepoConfig {
  return normalizeRepoConfig({
    ...current,
    ...updates,
  } as Record<string, unknown>);
}

function normalizeRepoConfig(raw: Record<string, unknown>): RepoConfig {
  const normalized: RepoConfig = {
    mcpUrl: toNonEmptyString(raw.mcpUrl),
    connectorName: toNonEmptyString(raw.connectorName),
    connectorDescription: toOptionalString(raw.connectorDescription),
    connectorId: toNonEmptyString(raw.connectorId),
    linkId: toNonEmptyString(raw.linkId),
    linkStatus: toNonEmptyString(raw.linkStatus),
    userId: toNonEmptyString(raw.userId),
    deviceId: toNonEmptyString(raw.deviceId),
    refreshBeforeTest: toOptionalBoolean(raw.refreshBeforeTest),
    testQueries: normalizeTestQueries(raw.testQueries),
    lastUpdatedAt: toNonEmptyString(raw.lastUpdatedAt),
  };
  return {
    ...raw,
    ...normalized,
  } as RepoConfig;
}

function normalizeTestQueries(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const resolved = value
    .map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const query = toNonEmptyString(record.query);
      if (!query) {
        return null;
      }
      const label = toNonEmptyString(record.label);
      return {
        ...(label ? { label } : {}),
        query,
      } satisfies TestQuery;
    })
    .filter((entry): entry is TestQuery => Boolean(entry));

  return resolved.length > 0 ? resolved : undefined;
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

function toOptionalString(value: unknown) {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return String(value);
  }
  return value;
}

function toOptionalBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}
