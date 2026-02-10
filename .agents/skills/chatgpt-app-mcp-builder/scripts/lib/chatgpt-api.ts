const DEFAULT_CLIENT_BUILD_NUMBER = "4289963";
const DEFAULT_CLIENT_VERSION = "prod-f9b493a797e65f9ed16c05b6bc2c9e8ee5afd06b-p";
const DEFAULT_LANGUAGE = "en-US";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";
const DEFAULT_SEC_CH_UA = '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"';
const DEFAULT_SEC_CH_UA_PLATFORM = '"macOS"';
const DEFAULT_SEC_CH_UA_MOBILE = "?0";
const DEFAULT_SEC_FETCH_DEST = "empty";
const DEFAULT_SEC_FETCH_MODE = "cors";
const DEFAULT_SEC_FETCH_SITE = "same-origin";
const DEFAULT_PRIORITY = "u=1, i";

export const CHATGPT_CONNECTOR_CREATE_ENDPOINT =
  "https://chatgpt.com/backend-api/aip/connectors/mcp";
export const CHATGPT_CONNECTOR_LINK_CREATE_ENDPOINT =
  "https://chatgpt.com/backend-api/aip/connectors/links/noauth";
export const CHATGPT_CONNECTOR_REFRESH_ENDPOINT =
  "https://chatgpt.com/backend-api/aip/connectors/mcp/refresh_actions";
export const CHATGPT_CONNECTOR_LINKS_LIST_ENDPOINT =
  "https://chatgpt.com/backend-api/aip/connectors/links/list_accessible";
const CHATGPT_ACCOUNT_USER_SETTING_ENDPOINT =
  "https://chatgpt.com/backend-api/settings/account_user_setting";

const HEADER_ENV = {
  clientBuildNumber: "CHATGPT_APP_OAI_CLIENT_BUILD_NUMBER",
  clientVersion: "CHATGPT_APP_OAI_CLIENT_VERSION",
  language: "CHATGPT_APP_OAI_LANGUAGE",
  userAgent: "CHATGPT_APP_USER_AGENT",
  accountId: "CHATGPT_APP_ACCOUNT_ID",
  secChUa: "CHATGPT_APP_SEC_CH_UA",
  secChUaPlatform: "CHATGPT_APP_SEC_CH_UA_PLATFORM",
  secChUaMobile: "CHATGPT_APP_SEC_CH_UA_MOBILE",
  secFetchDest: "CHATGPT_APP_SEC_FETCH_DEST",
  secFetchMode: "CHATGPT_APP_SEC_FETCH_MODE",
  secFetchSite: "CHATGPT_APP_SEC_FETCH_SITE",
  priority: "CHATGPT_APP_PRIORITY",
} as const;

export type ChatgptHeaderOverrides = Partial<{
  clientBuildNumber: string;
  clientVersion: string;
  language: string;
  userAgent: string;
  accountId: string;
  secChUa: string;
  secChUaPlatform: string;
  secChUaMobile: string;
  secFetchDest: string;
  secFetchMode: string;
  secFetchSite: string;
  priority: string;
}>;

export type ConnectorCreateResult = {
  connectorId: string;
  connectorName: string;
  connectorStatus?: string;
  connectorServiceUrl?: string;
};

export type ConnectorLinkResult = {
  linkId: string;
  userId?: string;
  linkStatus?: string;
};

export type RefreshResult = {
  ok: boolean;
  status: number;
  statusText: string;
  actionsCount?: number;
  detail?: string;
};

export function normalizeToken(rawToken?: string) {
  const trimmed = (rawToken ?? "").trim();
  const unquoted = stripMatchingQuotes(trimmed);
  const bearerPrefix = /^bearer\s+/i;
  return {
    token: unquoted.replace(bearerPrefix, "").trim(),
    hadBearerPrefix: bearerPrefix.test(unquoted),
    wasQuoted: unquoted !== trimmed,
  };
}

export function normalizeMcpUrl(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("MCP URL is empty.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid MCP URL "${raw}".`);
  }

  if (url.protocol !== "https:") {
    throw new Error("MCP URL must start with https://");
  }

  const basePath = url.pathname.replace(/\/+$/, "");
  const withMcp = basePath.endsWith("/mcp") ? basePath : `${basePath}/mcp`;
  url.pathname = withMcp.startsWith("/") ? withMcp : `/${withMcp}`;

  const normalized = url.toString();
  return {
    value: normalized,
    changed: normalized !== trimmed,
  };
}

export function buildChatgptAccountUserSettingUrl(feature: string, value: string) {
  const url = new URL(CHATGPT_ACCOUNT_USER_SETTING_ENDPOINT);
  url.searchParams.set("feature", feature);
  url.searchParams.set("value", value);
  return url.toString();
}

export function buildChatgptTestUrl(connectorId: string, query: string) {
  const url = new URL("https://chatgpt.com/");
  url.searchParams.set("hints", `connector:${connectorId}`);
  url.searchParams.set("q", query);
  return url.toString();
}

export function buildChatgptHeaders(
  token: string,
  deviceId: string,
  overrides: ChatgptHeaderOverrides = {},
): Record<string, string> {
  const clientBuildNumber = resolveHeaderValue(
    overrides.clientBuildNumber,
    HEADER_ENV.clientBuildNumber,
    DEFAULT_CLIENT_BUILD_NUMBER,
  );
  const clientVersion = resolveHeaderValue(
    overrides.clientVersion,
    HEADER_ENV.clientVersion,
    DEFAULT_CLIENT_VERSION,
  );
  const language = resolveHeaderValue(overrides.language, HEADER_ENV.language, DEFAULT_LANGUAGE);
  const userAgent = resolveHeaderValue(
    overrides.userAgent,
    HEADER_ENV.userAgent,
    DEFAULT_USER_AGENT,
  );
  const accountId = resolveHeaderValue(overrides.accountId, HEADER_ENV.accountId, "");
  const secChUa = resolveHeaderValue(overrides.secChUa, HEADER_ENV.secChUa, DEFAULT_SEC_CH_UA);
  const secChUaPlatform = resolveHeaderValue(
    overrides.secChUaPlatform,
    HEADER_ENV.secChUaPlatform,
    DEFAULT_SEC_CH_UA_PLATFORM,
  );
  const secChUaMobile = resolveHeaderValue(
    overrides.secChUaMobile,
    HEADER_ENV.secChUaMobile,
    DEFAULT_SEC_CH_UA_MOBILE,
  );
  const secFetchDest = resolveHeaderValue(
    overrides.secFetchDest,
    HEADER_ENV.secFetchDest,
    DEFAULT_SEC_FETCH_DEST,
  );
  const secFetchMode = resolveHeaderValue(
    overrides.secFetchMode,
    HEADER_ENV.secFetchMode,
    DEFAULT_SEC_FETCH_MODE,
  );
  const secFetchSite = resolveHeaderValue(
    overrides.secFetchSite,
    HEADER_ENV.secFetchSite,
    DEFAULT_SEC_FETCH_SITE,
  );
  const priority = resolveHeaderValue(overrides.priority, HEADER_ENV.priority, DEFAULT_PRIORITY);

  const headers: Record<string, string> = {
    Accept: "*/*",
    "Accept-Language": language,
    Authorization: `Bearer ${token}`,
    Cookie: `oai-did=${deviceId}`,
    "Content-Type": "application/json",
    "OAI-Language": language,
    "OAI-Product-Sku": "CONNECTOR_SETTING",
    "OAI-Client-Build-Number": clientBuildNumber,
    "OAI-Client-Version": clientVersion,
    "OAI-Device-Id": deviceId,
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "User-Agent": userAgent,
    "sec-ch-ua": secChUa,
    "sec-ch-ua-mobile": secChUaMobile,
    "sec-ch-ua-platform": secChUaPlatform,
    "sec-fetch-dest": secFetchDest,
    "sec-fetch-mode": secFetchMode,
    "sec-fetch-site": secFetchSite,
    priority,
  };

  if (accountId) {
    headers["ChatGPT-Account-ID"] = accountId;
  }

  return headers;
}

export async function ensureDeveloperModeEnabled({
  token,
  deviceId,
  accountId,
}: {
  token: string;
  deviceId: string;
  accountId?: string;
}) {
  const endpoint = buildChatgptAccountUserSettingUrl("developer_mode", "true");
  const response = await fetch(endpoint, {
    method: "PATCH",
    headers: buildChatgptHeaders(token, deviceId, { accountId }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    const details = responseText.trim() ? `: ${truncate(responseText, 220)}` : "";
    throw new Error(
      `Unable to enable ChatGPT developer mode (${response.status} ${response.statusText})${details}`,
    );
  }
}

export async function createConnectorWithNameFallback({
  token,
  deviceId,
  accountId,
  baseName,
  description,
  mcpUrl,
}: {
  token: string;
  deviceId: string;
  accountId?: string;
  baseName: string;
  description?: string;
  mcpUrl: string;
}): Promise<ConnectorCreateResult> {
  const maxAttempts = 8;
  const attemptedNames = new Set<string>();
  let attempt = 0;
  let currentName = baseName.trim() || "chatgpt-app";

  while (attempt < maxAttempts) {
    attempt += 1;
    attemptedNames.add(currentName);

    const payload = {
      name: currentName,
      mcp_url: mcpUrl,
      description: description ?? "",
      logo_url: null,
      authTypeOverride: "NONE",
      skip_safety_checks: true,
      auth_request: { supported_auth: [], oauth_client_params: null },
    };

    const response = await fetch(CHATGPT_CONNECTOR_CREATE_ENDPOINT, {
      method: "POST",
      headers: buildChatgptHeaders(token, deviceId, { accountId }),
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    const parsed = safeJsonParse(responseText) as Record<string, unknown> | null;
    if (response.ok) {
      const connector = getObject(parsed?.connector);
      const connectorId = getTrimmedString(connector?.id);
      if (!connectorId) {
        throw new Error("ChatGPT connector response missing connector id.");
      }
      return {
        connectorId,
        connectorName: getTrimmedString(connector?.name) || currentName,
        connectorStatus: getTrimmedString(connector?.status),
        connectorServiceUrl: getTrimmedString(connector?.service),
      };
    }

    const isConflict =
      response.status === 409 && /already exists|connector with name/i.test(responseText);
    if (isConflict && attempt < maxAttempts) {
      currentName = nextConnectorName(baseName, attemptedNames);
      continue;
    }

    const detail = responseText.trim() ? `: ${truncate(responseText, 260)}` : "";
    throw new Error(
      `ChatGPT connector create failed (${response.status} ${response.statusText})${detail}`,
    );
  }

  throw new Error("ChatGPT connector create failed: exhausted name attempts.");
}

export async function linkConnectorWithRetry({
  token,
  deviceId,
  connectorId,
  connectorName,
  attempts = 6,
}: {
  token: string;
  deviceId: string;
  connectorId: string;
  connectorName: string;
  attempts?: number;
}): Promise<ConnectorLinkResult> {
  let delayMs = 750;
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await createConnectorLink({
      token,
      deviceId,
      connectorId,
      connectorName,
    });

    if (result.linkId) {
      return result;
    }

    lastError = result.error ?? lastError;
    if (!result.retryable || attempt === attempts) {
      break;
    }

    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 8000);
  }

  throw new Error(`Connector link failed: ${lastError}`);
}

export async function refreshConnectorActionsWithRetry({
  token,
  deviceId,
  linkId,
  attempts = 2,
}: {
  token: string;
  deviceId: string;
  linkId: string;
  attempts?: number;
}) {
  let lastResult: RefreshResult | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await refreshConnectorActions({ token, deviceId, linkId });
    lastResult = result;
    if (result.ok) {
      return result;
    }
    if (attempt < attempts) {
      await sleep(500);
    }
  }

  return lastResult ?? {
    ok: false,
    status: 0,
    statusText: "Unknown error",
  };
}

async function createConnectorLink({
  token,
  deviceId,
  connectorId,
  connectorName,
}: {
  token: string;
  deviceId: string;
  connectorId: string;
  connectorName: string;
}) {
  try {
    const response = await fetch(CHATGPT_CONNECTOR_LINK_CREATE_ENDPOINT, {
      method: "POST",
      headers: buildChatgptHeaders(token, deviceId),
      body: JSON.stringify({
        connector_id: connectorId,
        name: connectorName,
        action_names: [],
        tool_settings: { personalized: "NO_PERSONALIZATION" },
      }),
    });

    const responseText = await response.text();
    const payload = safeJsonParse(responseText) as Record<string, unknown> | null;
    const linkRecord = getObject(payload?.link) ?? payload;

    const linkId =
      getTrimmedString(payload?.link_id) ||
      getTrimmedString(payload?.linkId) ||
      getTrimmedString(linkRecord?.id) ||
      "";

    const owners = Array.isArray(linkRecord?.owners)
      ? (linkRecord?.owners as Array<Record<string, unknown>>)
      : [];
    const userOwner = owners.find(
      (entry) => getTrimmedString(entry?.type)?.toUpperCase() === "USER" && entry?.id,
    );

    const userId =
      getTrimmedString(userOwner?.id) ||
      getTrimmedString(payload?.user_id) ||
      getTrimmedString(linkRecord?.user_id);

    const linkStatus =
      getTrimmedString(linkRecord?.auth_status) ||
      getTrimmedString(linkRecord?.link_status) ||
      getTrimmedString(linkRecord?.status) ||
      getTrimmedString(payload?.auth_status) ||
      getTrimmedString(payload?.link_status) ||
      getTrimmedString(payload?.status);

    if (response.ok && linkId) {
      return {
        linkId,
        userId,
        linkStatus,
      };
    }

    const retryable = isRetryableLinkStatus(response.status);
    const detail = responseText.trim() ? truncate(responseText, 200) : undefined;

    return {
      linkId: "",
      error: `status ${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
      retryable,
    };
  } catch (error) {
    return {
      linkId: "",
      error: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}

async function refreshConnectorActions({
  token,
  deviceId,
  linkId,
}: {
  token: string;
  deviceId: string;
  linkId: string;
}): Promise<RefreshResult> {
  try {
    const response = await fetch(CHATGPT_CONNECTOR_REFRESH_ENDPOINT, {
      method: "POST",
      headers: buildChatgptHeaders(token, deviceId),
      body: JSON.stringify({ link_id: linkId }),
    });

    const responseText = await response.text();
    const payload = safeJsonParse(responseText) as Record<string, unknown> | null;

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      actionsCount: extractActionsCount(payload),
      detail: getTrimmedString(payload?.detail),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: error instanceof Error ? error.message : String(error),
    };
  }
}

function nextConnectorName(baseName: string, attemptedNames: Set<string>) {
  const normalizedBase = baseName.trim() || "chatgpt-app";
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${normalizedBase}-${index}`;
    if (!attemptedNames.has(candidate)) {
      return candidate;
    }
  }
  const randomSuffix = Math.random().toString(36).slice(2, 8);
  return `${normalizedBase}-${randomSuffix}`;
}

function extractActionsCount(payload: Record<string, unknown> | null) {
  if (!payload) {
    return 0;
  }
  const actions = payload.actions;
  if (Array.isArray(actions)) {
    return actions.length;
  }
  const connector = getObject(payload.connector);
  if (Array.isArray(connector?.actions)) {
    return connector.actions.length;
  }
  return 0;
}

function isRetryableLinkStatus(status: number) {
  if (status >= 500) {
    return true;
  }
  return status === 404 || status === 408 || status === 409 || status === 425 || status === 429;
}

function getObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getTrimmedString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function safeJsonParse(text: string) {
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function resolveHeaderValue(override: string | undefined, envKey: string, fallback: string) {
  if (override && override.trim()) {
    return override.trim();
  }
  const envValue = process.env[envKey];
  if (envValue && envValue.trim()) {
    return envValue.trim();
  }
  return fallback;
}

function stripMatchingQuotes(value: string) {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && last === first) {
    return value.slice(1, -1);
  }
  return value;
}

function truncate(value: string, maxLength = 250) {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  if (maxLength <= 3) {
    return trimmed.slice(0, maxLength);
  }
  return `${trimmed.slice(0, maxLength - 3)}...`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
