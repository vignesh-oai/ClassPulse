import crypto from "node:crypto";

const DEFAULT_TTL_SECONDS = 10 * 60;

type ViewerTokenPayload = {
  sessionId: string;
  exp: number;
};

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signingSecret(): string {
  return (
    process.env.CALL_VIEWER_TOKEN_SECRET?.trim() ||
    process.env.TWILIO_AUTH_TOKEN?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    "local-insecure-viewer-secret"
  );
}

function sign(payload: string): string {
  return crypto
    .createHmac("sha256", signingSecret())
    .update(payload)
    .digest("base64url");
}

export function createViewerToken(
  sessionId: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): string {
  const payload: ViewerTokenPayload = {
    sessionId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

export function verifyViewerToken(
  sessionId: string,
  token: string,
): boolean {
  const [encodedPayload, providedSignature] = token.split(".");
  if (!encodedPayload || !providedSignature) {
    return false;
  }

  const expectedSignature = sign(encodedPayload);
  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(providedSignature);

  if (
    expectedBuffer.length !== providedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return false;
  }

  try {
    const payload = JSON.parse(
      base64UrlDecode(encodedPayload),
    ) as ViewerTokenPayload;
    const now = Math.floor(Date.now() / 1000);
    return payload.sessionId === sessionId && payload.exp > now;
  } catch {
    return false;
  }
}
