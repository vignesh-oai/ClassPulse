import { createRequire } from "node:module";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { URL } from "node:url";
import {
  createCallSession,
  getCallSession,
  getSessionIdByCallSid,
  getCallSessionSummary,
  listLogEventsSince,
  setCallSid,
  subscribeToCallLogs,
  unsubscribeFromCallLogs,
  updateCallStatus,
  type CallStatus,
  type LogSocket,
} from "./call-session-store";
import {
  logDebug,
  logError,
  logInfo,
  logWarn,
  redactPhone,
} from "./call-debug";
import { bridgeTwilioToRealtime } from "./twilio-realtime-bridge";
import { createViewerToken, verifyViewerToken } from "./viewer-token";

const DEFAULT_TO_E164 = "+16282897075";
const DEFAULT_STUDENT_NAME = "Sam";
const DEFAULT_PARENT_NAME = "Jerry";
const DEFAULT_PARENT_RELATIONSHIP = "father";
const DEFAULT_PARENT_NUMBER_LABEL = "Parent number on file";

function trimOrDefault(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : fallback;
}

function getTeacherCallContext(): {
  studentName: string;
  parentName: string;
  parentRelationship: string;
  parentNumberLabel: string;
} {
  const studentName = trimOrDefault(process.env.CALL_STUDENT_NAME, DEFAULT_STUDENT_NAME);
  const parentName = trimOrDefault(process.env.CALL_PARENT_NAME, DEFAULT_PARENT_NAME);
  const parentRelationship = trimOrDefault(
    process.env.CALL_PARENT_RELATIONSHIP,
    DEFAULT_PARENT_RELATIONSHIP,
  );
  const parentNumberLabel = trimOrDefault(
    process.env.CALL_PARENT_NUMBER_LABEL,
    `${parentName}'s number on file`,
  );

  return {
    studentName,
    parentName,
    parentRelationship,
    parentNumberLabel,
  };
}

type RuntimeWebSocket = LogSocket & {
  on: (event: string, callback: (...args: unknown[]) => void) => void;
  off?: (event: string, callback: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, callback: (...args: unknown[]) => void) => void;
  ping?: () => void;
};

type WebSocketServerLike = {
  handleUpgrade: (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    callback: (socket: RuntimeWebSocket) => void,
  ) => void;
};

type WebSocketServerCtor = new (options: {
  noServer: boolean;
}) => WebSocketServerLike;

type TwilioCall = {
  sid?: string;
  status?: string;
};

type TwilioClient = {
  calls: {
    create: (params: Record<string, unknown>) => Promise<TwilioCall>;
  };
};

type TwilioFactory = (accountSid: string, authToken: string) => TwilioClient;

type CallStartResult = {
  sessionId: string;
  displayNumber: string;
  studentName: string;
  parentName: string;
  parentRelationship: string;
  parentNumberLabel: string;
  status: "queued" | "ringing" | "in-progress" | "failed";
  logsWsUrl: string;
  viewerToken: string;
  reconnectSinceSeq: number;
  callSid: string | null;
  errorMessage?: string;
};

type TwilioIntegration = {
  handleRequest: (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ) => Promise<boolean>;
  handleUpgrade: (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    url: URL,
  ) => boolean;
};

type TwilioMappedStatus = Exclude<CallStatus, "ready">;

const localRequire = createRequire(import.meta.url);

function normalizeBaseUrl(rawUrl: string): string {
  return rawUrl.replace(/\/+$/, "");
}

function getPublicBaseUrl(): string {
  const configured = process.env.PUBLIC_URL?.trim();
  if (configured) {
    return normalizeBaseUrl(configured);
  }
  const port = Number(process.env.PORT ?? process.env.MCP_PORT ?? 8000);
  const effectivePort = Number.isFinite(port) ? port : 8000;
  return `http://localhost:${effectivePort}`;
}

function toWsBaseUrl(httpBaseUrl: string): string {
  if (httpBaseUrl.startsWith("https://")) {
    return `wss://${httpBaseUrl.slice("https://".length)}`;
  }
  if (httpBaseUrl.startsWith("http://")) {
    return `ws://${httpBaseUrl.slice("http://".length)}`;
  }
  return httpBaseUrl;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function mapTwilioStatus(status: string | null | undefined): TwilioMappedStatus {
  const normalized = (status ?? "").toLowerCase();

  if (normalized === "ringing") {
    return "ringing";
  }
  if (normalized === "in-progress" || normalized === "answered") {
    return "in-progress";
  }
  if (
    normalized === "queued" ||
    normalized === "initiated" ||
    normalized === "scheduled"
  ) {
    return "queued";
  }
  if (normalized === "completed") {
    return "completed";
  }
  return "failed";
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function safeParseJson(raw: unknown): Record<string, unknown> | null {
  try {
    const text =
      typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : String(raw);
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function twilioMediaMessagePreview(raw: unknown): string {
  if (typeof raw === "string") {
    return raw.slice(0, 160);
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8").slice(0, 160);
  }
  return String(raw).slice(0, 160);
}

function extractSessionIdFromTwilioStart(payload: Record<string, unknown>): string | null {
  const start = asRecord(payload.start);
  const customParameters = asRecord(start?.customParameters);
  const direct =
    asString(customParameters?.sessionId) ??
    asString(customParameters?.session_id) ??
    asString(customParameters?.SessionId) ??
    asString(customParameters?.SESSION_ID);
  if (direct) {
    return direct;
  }
  return null;
}

function detachMessageHandler(
  ws: RuntimeWebSocket,
  handler: (raw: unknown) => void,
): void {
  if (ws.off) {
    ws.off("message", handler);
    return;
  }
  ws.removeListener?.("message", handler);
}

function parsePositiveInt(raw: string | null): number {
  if (!raw) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const withDetails = error as Error & {
      code?: string | number;
      status?: number;
      moreInfo?: string;
      details?: unknown;
    };
    return {
      message: withDetails.message,
      name: withDetails.name,
      code: withDetails.code ?? null,
      status: withDetails.status ?? null,
      moreInfo: withDetails.moreInfo ?? null,
      details: withDetails.details ?? null,
    };
  }
  if (typeof error === "object" && error !== null) {
    return { rawError: error };
  }
  return {
    rawError: String(error),
  };
}

function getWebSocketServerCtor(): WebSocketServerCtor {
  const wsModule = localRequire("ws") as {
    WebSocketServer: WebSocketServerCtor;
  };
  return wsModule.WebSocketServer;
}

function getTwilioFactory(): TwilioFactory {
  return localRequire("twilio") as TwilioFactory;
}

async function readRawRequestBody(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk) => {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      reject(error);
    });
  });
}

function callStartPayload(
  sessionId: string,
  status: CallStartResult["status"],
  viewerToken: string,
  callSid: string | null,
  errorMessage?: string,
): CallStartResult {
  const context = getTeacherCallContext();
  return {
    sessionId,
    displayNumber: context.parentNumberLabel,
    studentName: context.studentName,
    parentName: context.parentName,
    parentRelationship: context.parentRelationship,
    parentNumberLabel: context.parentNumberLabel,
    status,
    logsWsUrl: `${toWsBaseUrl(getPublicBaseUrl())}/twilio/logs`,
    viewerToken,
    reconnectSinceSeq: 0,
    callSid,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function getTwilioConfig():
  | {
      accountSid: string;
      authToken: string;
      fromNumber: string;
      toNumber: string;
      publicBaseUrl: string;
    }
  | {
      error: string;
    } {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? "";
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() ?? "";
  const fromNumber = process.env.TWILIO_FROM_NUMBER?.trim() ?? "";
  const toNumber = process.env.TWILIO_TO_NUMBER_DEFAULT?.trim() || DEFAULT_TO_E164;

  if (!accountSid || !authToken || !fromNumber) {
    return {
      error:
        "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER.",
    };
  }

  return {
    accountSid,
    authToken,
    fromNumber,
    toNumber,
    publicBaseUrl: getPublicBaseUrl(),
  };
}

export function getTwilioCallPanelOutput(): {
  sessionId: null;
  displayNumber: string;
  studentName: string;
  parentName: string;
  parentRelationship: string;
  parentNumberLabel: string;
  status: "ready";
  logsWsUrl: string;
  reconnectSinceSeq: 0;
} {
  const context = getTeacherCallContext();
  return {
    sessionId: null,
    displayNumber: context.parentNumberLabel,
    studentName: context.studentName,
    parentName: context.parentName,
    parentRelationship: context.parentRelationship,
    parentNumberLabel: context.parentNumberLabel,
    status: "ready",
    logsWsUrl: `${toWsBaseUrl(getPublicBaseUrl())}/twilio/logs`,
    reconnectSinceSeq: 0,
  };
}

export function getTwilioCallStatusOutput(sessionId: string): {
  sessionId: string;
  callSid: string | null;
  displayNumber: string;
  studentName: string;
  parentName: string;
  parentRelationship: string;
  parentNumberLabel: string;
  status: CallStatus;
  startedAt: string;
  endedAt: string | null;
  terminalReason: string | null;
  lastSeq: number;
  transcript: Array<{
    itemId: string;
    speaker: "recipient" | "assistant";
    text: string;
    isFinal: boolean;
    seq: number;
    order: number;
    timestamp: string;
  }>;
} | null {
  const summary = getCallSessionSummary(sessionId);
  if (!summary) {
    return null;
  }
  const context = getTeacherCallContext();

  return {
    sessionId: summary.sessionId,
    callSid: summary.callSid,
    displayNumber: context.parentNumberLabel,
    studentName: context.studentName,
    parentName: context.parentName,
    parentRelationship: context.parentRelationship,
    parentNumberLabel: context.parentNumberLabel,
    status: summary.status,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    terminalReason: summary.terminalReason,
    lastSeq: summary.lastSeq,
    transcript: summary.transcript.map((item) => ({
      itemId: item.itemId,
      speaker: item.speaker,
      text: item.text,
      isFinal: item.isFinal,
      seq: item.seq,
      order: item.order,
      timestamp: item.timestamp,
    })),
  };
}

export async function startTwilioOutboundCall(): Promise<CallStartResult> {
  const session = createCallSession();
  const viewerToken = createViewerToken(session.sessionId);
  logInfo("Created call session", {
    sessionId: session.sessionId,
  });

  const config = getTwilioConfig();
  if ("error" in config) {
    logError("Twilio configuration error", {
      sessionId: session.sessionId,
      error: config.error,
    });
    updateCallStatus(session.sessionId, "failed", config.error);
    return callStartPayload(
      session.sessionId,
      "failed",
      viewerToken,
      session.callSid,
      config.error,
    );
  }

  let twilioFactory: TwilioFactory;
  try {
    twilioFactory = getTwilioFactory();
  } catch {
    const message = "Twilio SDK is not installed. Run `pnpm install` to add dependencies.";
    logError("Twilio SDK load failed", {
      sessionId: session.sessionId,
      error: message,
    });
    updateCallStatus(session.sessionId, "failed", message);
    return callStartPayload(
      session.sessionId,
      "failed",
      viewerToken,
      session.callSid,
      message,
    );
  }

  const twilioClient = twilioFactory(config.accountSid, config.authToken);
  const twimlUrl = `${config.publicBaseUrl}/twilio/twiml?sessionId=${encodeURIComponent(
    session.sessionId,
  )}`;
  const statusCallback = `${config.publicBaseUrl}/twilio/status?sessionId=${encodeURIComponent(
    session.sessionId,
  )}`;
  logInfo("Starting Twilio outbound call", {
    sessionId: session.sessionId,
    publicBaseUrl: config.publicBaseUrl,
    fromNumber: redactPhone(config.fromNumber),
    toNumber: redactPhone(config.toNumber),
    twimlUrl,
    statusCallback,
  });

  try {
    const call = await twilioClient.calls.create({
      to: config.toNumber,
      from: config.fromNumber,
      url: twimlUrl,
      statusCallback,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    });

    const callSid = call.sid ?? null;
    if (callSid) {
      setCallSid(session.sessionId, callSid);
    }

    const status = mapTwilioStatus(call.status);
    updateCallStatus(session.sessionId, status);
    logInfo("Twilio call created", {
      sessionId: session.sessionId,
      callSid,
      initialTwilioStatus: call.status ?? null,
      mappedStatus: status,
    });

    return callStartPayload(
      session.sessionId,
      status === "failed" || status === "completed" ? "queued" : status,
      viewerToken,
      callSid,
    );
  } catch (error) {
    const details = describeError(error);
    const errorMessage =
      typeof details.message === "string"
        ? details.message
        : "Twilio call creation failed with an unknown error.";
    logError("Twilio call creation failed", {
      sessionId: session.sessionId,
      error: errorMessage,
      details,
    });
    updateCallStatus(session.sessionId, "failed", errorMessage);

    return callStartPayload(
      session.sessionId,
      "failed",
      viewerToken,
      session.callSid,
      errorMessage,
    );
  }
}

export function createTwilioIntegration(): TwilioIntegration {
  let twilioMediaServer: WebSocketServerLike | null = null;
  let logsServer: WebSocketServerLike | null = null;

  try {
    const WebSocketServer = getWebSocketServerCtor();
    twilioMediaServer = new WebSocketServer({ noServer: true });
    logsServer = new WebSocketServer({ noServer: true });
    logInfo("Initialized Twilio WebSocket servers", {
      mediaPath: "/twilio/call",
      logsPath: "/twilio/logs",
    });
  } catch {
    logWarn(
      "WebSocket server dependency (`ws`) is not installed. Twilio media/log streams are unavailable until dependencies are installed.",
    );
  }

  const handleTwilioStatus = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (url.pathname !== "/twilio/status" || req.method !== "POST") {
      return false;
    }

    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || !getCallSession(sessionId)) {
      logWarn("Received Twilio status callback for unknown session", {
        sessionId,
        path: url.pathname,
      });
      res.writeHead(404).end("Unknown call session");
      return true;
    }

    const rawBody = await readRawRequestBody(req);
    const body = new URLSearchParams(rawBody);
    const callbackStatus = body.get("CallStatus");
    const callbackSid = body.get("CallSid");

    logInfo("Twilio status callback received", {
      sessionId,
      callSid: callbackSid,
      callStatus: callbackStatus,
      callDuration: body.get("CallDuration"),
      sequenceNumber: body.get("SequenceNumber"),
      timestamp: body.get("Timestamp"),
      from: redactPhone(body.get("From")),
      to: redactPhone(body.get("To")),
      answeredBy: body.get("AnsweredBy"),
      sipResponseCode: body.get("SipResponseCode"),
    });

    const callSid = callbackSid;
    if (callSid) {
      setCallSid(sessionId, callSid);
    }

    const mappedStatus = mapTwilioStatus(callbackStatus);
    const reason = callbackStatus
      ? `Twilio status: ${callbackStatus}`
      : undefined;
    logDebug("Mapped Twilio status callback", {
      sessionId,
      callbackStatus,
      mappedStatus,
      reason: reason ?? null,
    });
    updateCallStatus(sessionId, mappedStatus, reason ?? undefined);

    res.writeHead(204).end();
    return true;
  };

  const handleTwilioTwiML = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (url.pathname !== "/twilio/twiml") {
      return false;
    }
    if (req.method !== "GET" && req.method !== "POST") {
      return false;
    }

    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId || !getCallSession(sessionId)) {
      logWarn("TwiML requested for unknown session", {
        sessionId,
        method: req.method ?? null,
      });
      res.writeHead(404).end("Unknown call session");
      return true;
    }

    const wsUrl = `${toWsBaseUrl(getPublicBaseUrl())}/twilio/call`;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscape(wsUrl)}">
      <Parameter name="sessionId" value="${xmlEscape(sessionId)}" />
    </Stream>
  </Connect>
</Response>`;
    logInfo("Serving TwiML stream response", {
      sessionId,
      method: req.method ?? null,
      streamWsUrl: wsUrl,
      streamParameterSessionId: sessionId,
      userAgent: req.headers["user-agent"] ?? null,
    });

    res.writeHead(200, {
      "Content-Type": "text/xml; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(twiml);
    return true;
  };

  return {
    async handleRequest(req, res, url) {
      if (await handleTwilioTwiML(req, res, url)) {
        return true;
      }
      if (await handleTwilioStatus(req, res, url)) {
        return true;
      }
      return false;
    },
    handleUpgrade(req, socket, head, url) {
      if (url.pathname === "/twilio/call") {
        const requestedSessionId = url.searchParams.get("sessionId");
        logInfo("Upgrade request received for Twilio media stream", {
          path: url.pathname,
          sessionId: requestedSessionId,
          userAgent: req.headers["user-agent"] ?? null,
          origin: req.headers.origin ?? null,
          headBytes: head.length,
        });
        if (!twilioMediaServer) {
          logError("Twilio media upgrade rejected: media server unavailable");
          socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
          socket.destroy();
          return true;
        }

        twilioMediaServer.handleUpgrade(req, socket, head, (ws) => {
          const querySessionId =
            requestedSessionId && getCallSession(requestedSessionId)
              ? requestedSessionId
              : null;
          if (requestedSessionId && !querySessionId) {
            logWarn("Twilio media websocket received unknown query session id", {
              requestedSessionId,
            });
          }

          if (querySessionId) {
            logInfo("Twilio media websocket accepted", {
              sessionId: querySessionId,
              bindingSource: "query",
            });
            bridgeTwilioToRealtime({
              sessionId: querySessionId,
              twilioSocket: ws,
            });
            return;
          }

          logInfo("Twilio media websocket accepted pending start event session binding", {
            requestedSessionId,
          });

          let bridgeStarted = false;
          const pendingSessionTimer = setTimeout(() => {
            if (bridgeStarted) {
              return;
            }
            logWarn("Twilio media websocket session binding timeout", {
              requestedSessionId,
            });
            ws.close(1008, "Missing session binding");
          }, 10000);

          const onPendingStart = (raw: unknown) => {
            if (bridgeStarted) {
              return;
            }

            const payload = safeParseJson(raw);
            if (!payload) {
              logWarn("Twilio media pre-bridge message was not valid JSON", {
                messagePreview: twilioMediaMessagePreview(raw),
              });
              return;
            }

            const eventName = asString(payload.event);
            if (eventName !== "start") {
              return;
            }

            const start = asRecord(payload.start);
            const customSessionId = extractSessionIdFromTwilioStart(payload);
            const customSession =
              customSessionId && getCallSession(customSessionId)
                ? customSessionId
                : null;
            const callSid = asString(start?.callSid);
            const callSidSession = callSid ? getSessionIdByCallSid(callSid) : null;
            const resolvedSessionId = customSession ?? callSidSession ?? null;

            if (!resolvedSessionId) {
              logWarn("Twilio media websocket start event could not be mapped to a session", {
                requestedSessionId,
                customSessionId,
                callSid,
                customParameters: asRecord(start?.customParameters) ?? null,
              });
              ws.close(1008, "Unknown call session");
              return;
            }

            bridgeStarted = true;
            clearTimeout(pendingSessionTimer);
            detachMessageHandler(ws, onPendingStart);

            logInfo("Twilio media websocket session bound from start event", {
              requestedSessionId,
              resolvedSessionId,
              bindingSource: customSession ? "start.customParameters.sessionId" : "start.callSid",
              callSid,
            });
            bridgeTwilioToRealtime({
              sessionId: resolvedSessionId,
              twilioSocket: ws,
              initialTwilioStartEvent: payload,
            });
          };

          ws.on("message", onPendingStart);
          ws.on("close", () => {
            clearTimeout(pendingSessionTimer);
          });
          ws.on("error", () => {
            clearTimeout(pendingSessionTimer);
          });
        });
        return true;
      }

      if (url.pathname === "/twilio/logs") {
        logInfo("Upgrade request received for widget logs stream", {
          path: url.pathname,
          sessionId: url.searchParams.get("sessionId"),
          sinceSeq: url.searchParams.get("sinceSeq"),
          userAgent: req.headers["user-agent"] ?? null,
          origin: req.headers.origin ?? null,
          headBytes: head.length,
        });
        if (!logsServer) {
          logError("Logs stream upgrade rejected: logs server unavailable");
          socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
          socket.destroy();
          return true;
        }

        logsServer.handleUpgrade(req, socket, head, (ws) => {
          const sessionId = url.searchParams.get("sessionId");
          const viewerToken = url.searchParams.get("viewerToken");
          const sinceSeq = parsePositiveInt(url.searchParams.get("sinceSeq"));

          if (!sessionId || !viewerToken || !getCallSession(sessionId)) {
            logWarn("Logs websocket rejected for invalid session/token", {
              sessionId,
              hasViewerToken: Boolean(viewerToken),
            });
            ws.close(1008, "Invalid log stream session");
            return;
          }

          if (!verifyViewerToken(sessionId, viewerToken)) {
            logWarn("Logs websocket rejected for invalid viewer token", {
              sessionId,
            });
            ws.close(1008, "Invalid viewer token");
            return;
          }

          const subscriberId = subscribeToCallLogs(sessionId, ws);
          if (!subscriberId) {
            logWarn("Logs websocket rejected: session disappeared during subscribe", {
              sessionId,
            });
            ws.close(1008, "Unknown call session");
            return;
          }
          logInfo("Logs websocket accepted", {
            sessionId,
            subscriberId,
            sinceSeq,
          });

          const existingEvents = listLogEventsSince(sessionId, sinceSeq);
          logDebug("Replaying buffered log events to subscriber", {
            sessionId,
            subscriberId,
            replayCount: existingEvents.length,
          });
          for (const event of existingEvents) {
            if (ws.readyState === 1) {
              ws.send(JSON.stringify(event));
            }
          }

          const heartbeat = setInterval(() => {
            if (ws.readyState === 1) {
              ws.ping?.();
            }
          }, 20000);

          ws.on("close", () => {
            clearInterval(heartbeat);
            unsubscribeFromCallLogs(sessionId, subscriberId);
            logInfo("Logs websocket closed", {
              sessionId,
              subscriberId,
            });
          });

          ws.on("error", () => {
            clearInterval(heartbeat);
            unsubscribeFromCallLogs(sessionId, subscriberId);
            logWarn("Logs websocket error", {
              sessionId,
              subscriberId,
            });
          });

          const summary = getCallSessionSummary(sessionId);
          if (summary?.endedAt) {
            setTimeout(() => {
              if (ws.readyState === 1) {
                ws.close(1000, "Call session already ended");
              }
            }, 250);
          }
        });
        return true;
      }

      return false;
    },
  };
}
