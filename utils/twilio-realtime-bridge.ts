import { createRequire } from "node:module";
import type { IncomingMessage } from "node:http";
import {
  appendAudioLevel,
  appendTranscriptDelta,
  appendTranscriptFinal,
  getCallSession,
  recordTranscriptOrder,
  setCallSid,
  updateCallStatus,
} from "./call-session-store";
import {
  logDebug,
  logError,
  logInfo,
  logWarn,
  truncate,
} from "./call-debug";
import { getRealtimeSystemPrompt } from "./realtime-prompt-template";

const DEFAULT_REALTIME_MODEL = "gpt-realtime";
const DEFAULT_REALTIME_VOICE = "marin";
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const WS_OPEN = 1;
const WS_CONNECTING = 0;
const PCMU_MAX_ABS_SAMPLE = 32124;
const AUDIO_LEVEL_SAMPLE_EVERY_FRAMES = 8;

type BridgeSocket = {
  readyState: number;
  send: (payload: string) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
};

type WsConstructor = new (
  url: string,
  options?: {
    headers?: Record<string, string>;
  },
) => BridgeSocket;

const localRequire = createRequire(import.meta.url);

function getWebSocketConstructor(): WsConstructor {
  return localRequire("ws") as WsConstructor;
}

type BridgeOptions = {
  sessionId: string;
  twilioSocket: BridgeSocket;
  initialTwilioStartEvent?: Record<string, unknown> | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
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

function previewRawMessage(raw: unknown, maxChars = 180): string {
  if (typeof raw === "string") {
    return truncate(raw, maxChars) ?? "";
  }
  if (Buffer.isBuffer(raw)) {
    return truncate(raw.toString("utf8"), maxChars) ?? "";
  }
  return truncate(String(raw), maxChars) ?? "";
}

function readUnexpectedResponseBody(
  response: IncomingMessage,
  onDone: (body: string) => void,
): void {
  const chunks: string[] = [];
  let completed = false;
  const finish = () => {
    if (completed) {
      return;
    }
    completed = true;
    onDone(chunks.join(""));
  };
  response.on("data", (chunk: unknown) => {
    if (typeof chunk === "string") {
      chunks.push(chunk);
      return;
    }
    if (Buffer.isBuffer(chunk)) {
      chunks.push(chunk.toString("utf8"));
      return;
    }
    chunks.push(String(chunk));
  });
  response.on("end", finish);
  response.on("error", finish);
}

function sendJson(socket: BridgeSocket, payload: Record<string, unknown>): void {
  if (socket.readyState !== WS_OPEN) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

function getRealtimeUrl(model: string): string {
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

function assistantItemId(event: Record<string, unknown>): string {
  const explicitId = asString(event.item_id);
  if (explicitId) {
    return explicitId;
  }

  const responseId = asString(event.response_id) ?? "response";
  const outputIndex = asNumber(event.output_index) ?? 0;
  return `assistant_${responseId}_${outputIndex}`;
}

function responseIdFromEvent(event: Record<string, unknown>): string | null {
  const explicitId = asString(event.response_id);
  if (explicitId) {
    return explicitId;
  }
  const response = asRecord(event.response);
  return asString(response?.id);
}

function base64DecodedByteLength(encoded: string): number {
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decoded = Math.floor((encoded.length * 3) / 4) - padding;
  return decoded > 0 ? decoded : 0;
}

function pcmuMillisecondsFromBase64(encoded: string): number {
  const bytes = base64DecodedByteLength(encoded);
  // PCMU is 8kHz with 8-bit samples => 8 bytes ~= 1 ms.
  return bytes / 8;
}

function pickTranscriptText(
  event: Record<string, unknown>,
  candidates: string[],
): string | null {
  for (const key of candidates) {
    const value = asString(event[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function decodeMuLawSample(muLawByte: number): number {
  const mu = (~muLawByte) & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function estimatePcmuLevel(encodedAudio: string): number | null {
  let frame: Buffer;
  try {
    frame = Buffer.from(encodedAudio, "base64");
  } catch {
    return null;
  }

  if (frame.length === 0) {
    return null;
  }

  let sumSquares = 0;
  for (const byte of frame) {
    const sample = decodeMuLawSample(byte);
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / frame.length);
  const normalized = Math.min(1, Math.max(0, rms / PCMU_MAX_ABS_SAMPLE));
  // Speech energy is typically low in normalized PCM space; scale for UI readability.
  return Math.min(1, normalized * 3.4);
}

export function bridgeTwilioToRealtime(options: BridgeOptions): void {
  const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
  if (!openAiApiKey) {
    updateCallStatus(options.sessionId, "failed", "OPENAI_API_KEY is not configured.");
    options.twilioSocket.close(1011, "Missing OPENAI_API_KEY");
    return;
  }

  const realtimeModel = process.env.OPENAI_REALTIME_MODEL?.trim() || DEFAULT_REALTIME_MODEL;
  const realtimeVoice = process.env.OPENAI_REALTIME_VOICE?.trim() || DEFAULT_REALTIME_VOICE;
  const callBrief = getCallSession(options.sessionId)?.callBrief ?? null;
  const realtimePrompt = getRealtimeSystemPrompt({
    reasonSummary: callBrief?.reasonSummary,
    contextFromChat: callBrief?.contextFromChat,
    absenceStats: callBrief?.absenceStats,
  });
  const transcriptionModel =
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() ||
    DEFAULT_TRANSCRIPTION_MODEL;

  const WebSocketCtor = getWebSocketConstructor();
  const realtimeUrl = getRealtimeUrl(realtimeModel);
  logDebug("Opening OpenAI Realtime websocket", {
    sessionId: options.sessionId,
    realtimeUrl,
  });
  const realtimeSocket = new WebSocketCtor(realtimeUrl, {
    headers: {
      Authorization: `Bearer ${openAiApiKey}`,
    },
  });

  let twilioStreamSid: string | null = null;
  let twilioStopped = false;
  let twilioStartHandled = false;
  let twilioInboundMediaFrames = 0;
  let realtimeOutboundMediaFrames = 0;
  let twilioInboundBytes = 0;
  let realtimeOutboundBytes = 0;
  let twilioAudioLevelFrames = 0;
  let realtimeAudioLevelFrames = 0;
  let activeResponseId: string | null = null;
  let activeAssistantItemId: string | null = null;
  let activeAssistantContentIndex = 0;
  let activeAssistantAudioMsSent = 0;
  let activeAssistantAudioStartedAtMs: number | null = null;
  let assistantOutputActive = false;
  let interruptControlEventCounter = 0;
  let lastInterruptControlEventSentAtMs: number | null = null;
  const pendingInterruptControlEventIds = new Set<string>();
  let recipientDeltaEvents = 0;
  let recipientFinalEvents = 0;
  let assistantDeltaEvents = 0;
  let assistantFinalEvents = 0;
  const bridgeStartedAtMs = Date.now();

  logInfo("Starting Twilio <-> Realtime bridge", {
    sessionId: options.sessionId,
    realtimeModel,
    realtimeVoice,
    transcriptionModel,
    hasCallBriefContext: Boolean(callBrief),
  });

  const closeRealtime = () => {
    if (realtimeSocket.readyState === WS_OPEN) {
      realtimeSocket.close(1000, "Twilio stream ended");
    } else if (realtimeSocket.readyState === WS_CONNECTING) {
      realtimeSocket.terminate();
    }
  };

  const closeTwilio = () => {
    if (options.twilioSocket.readyState === WS_OPEN) {
      options.twilioSocket.close(1000, "Realtime stream ended");
    } else if (options.twilioSocket.readyState === WS_CONNECTING) {
      options.twilioSocket.terminate();
    }
  };

  const clearAssistantPlaybackTracking = () => {
    activeAssistantItemId = null;
    activeAssistantContentIndex = 0;
    activeAssistantAudioMsSent = 0;
    activeAssistantAudioStartedAtMs = null;
    assistantOutputActive = false;
  };

  const sendInterruptControlEvent = (payload: Record<string, unknown>) => {
    const eventId = `interrupt_${Date.now()}_${String(interruptControlEventCounter++)}`;
    pendingInterruptControlEventIds.add(eventId);
    lastInterruptControlEventSentAtMs = Date.now();
    sendJson(realtimeSocket, {
      event_id: eventId,
      ...payload,
    });
  };

  const isRecoverableInterruptError = (
    errorRecord: Record<string, unknown> | null,
    event: Record<string, unknown>,
  ) => {
    const errorEventId = asString(errorRecord?.event_id) ?? asString(event.event_id);
    if (errorEventId && pendingInterruptControlEventIds.has(errorEventId)) {
      pendingInterruptControlEventIds.delete(errorEventId);
      return true;
    }

    const errorCode = asString(errorRecord?.code);
    const message = (
      asString(errorRecord?.message) ??
      asString(event.message) ??
      ""
    ).toLowerCase();
    const sentInterruptRecently =
      lastInterruptControlEventSentAtMs != null &&
      Date.now() - lastInterruptControlEventSentAtMs < 2500;
    if (
      sentInterruptRecently &&
      (errorCode === "response_cancel_not_active" ||
        errorCode === "conversation_item_not_found" ||
        errorCode === "conversation_item_already_completed")
    ) {
      return true;
    }
    return (
      errorCode === "invalid_request_error" &&
      (message.includes("response.cancel") || message.includes("conversation.item.truncate"))
    );
  };

  const estimatePlayedAssistantAudioMs = () => {
    if (!activeAssistantAudioStartedAtMs) {
      return activeAssistantAudioMsSent;
    }
    const elapsedMs = Math.max(0, Date.now() - activeAssistantAudioStartedAtMs);
    return Math.min(activeAssistantAudioMsSent, elapsedMs);
  };

  const interruptAssistantPlayback = (triggerEventType: string) => {
    const hasTrackedAssistantAudio = assistantOutputActive && activeAssistantAudioMsSent > 0;
    const canTruncateAssistantAudio =
      assistantOutputActive && Boolean(activeAssistantItemId) && hasTrackedAssistantAudio;
    if (!assistantOutputActive && !hasTrackedAssistantAudio) {
      return;
    }

    if (twilioStreamSid) {
      sendJson(options.twilioSocket, {
        event: "clear",
        streamSid: twilioStreamSid,
      });
    }

    if (assistantOutputActive && (activeResponseId || hasTrackedAssistantAudio)) {
      sendInterruptControlEvent({
        type: "response.cancel",
      });
    }

    if (activeAssistantItemId && canTruncateAssistantAudio) {
      sendInterruptControlEvent({
        type: "conversation.item.truncate",
        item_id: activeAssistantItemId,
        content_index: activeAssistantContentIndex,
        audio_end_ms: Math.max(0, Math.floor(estimatePlayedAssistantAudioMs())),
      });
    }

    logInfo("Interrupted assistant playback after user speech detection", {
      sessionId: options.sessionId,
      triggerEventType,
      responseId: activeResponseId,
      assistantItemId: activeAssistantItemId,
      assistantContentIndex: activeAssistantContentIndex,
      assistantAudioMsSent: Math.floor(activeAssistantAudioMsSent),
      assistantAudioMsEstimatedPlayed: Math.floor(estimatePlayedAssistantAudioMs()),
      twilioStreamSid,
    });

    activeResponseId = null;
    clearAssistantPlaybackTracking();
  };

  const handleTwilioStartEvent = (payload: Record<string, unknown>) => {
    if (twilioStartHandled) {
      logDebug("Ignoring duplicate Twilio start event", {
        sessionId: options.sessionId,
      });
      return;
    }

    const start = asRecord(payload.start);
    twilioStreamSid = asString(start?.streamSid) ?? asString(payload.streamSid);
    const callSid = asString(start?.callSid);
    if (callSid) {
      setCallSid(options.sessionId, callSid);
    }
    twilioStartHandled = true;
    updateCallStatus(options.sessionId, "in-progress");
    logInfo("Twilio media stream started", {
      sessionId: options.sessionId,
      streamSid: twilioStreamSid,
      callSid,
      mediaFormat: asRecord(start?.mediaFormat) ?? null,
      customParameters: asRecord(start?.customParameters) ?? null,
    });
  };

  realtimeSocket.on("open", () => {
    logInfo("OpenAI Realtime websocket opened", {
      sessionId: options.sessionId,
    });
    sendJson(realtimeSocket, {
      type: "session.update",
      session: {
        type: "realtime",
        instructions: realtimePrompt,
        audio: {
          input: {
            format: {
              type: "audio/pcmu",
            },
            turn_detection: {
              type: "server_vad",
              interrupt_response: true,
            },
            transcription: {
              model: transcriptionModel,
              language: "en",
            },
          },
          output: {
            format: {
              type: "audio/pcmu",
            },
            voice: realtimeVoice,
          },
        },
      },
    });
    logDebug("Sent Realtime session.update", {
      sessionId: options.sessionId,
      inputAudioFormat: "audio/pcmu",
      outputAudioFormat: "audio/pcmu",
      turnDetection: "server_vad",
      transcriptionModel,
      promptPreview: truncate(realtimePrompt, 140),
    });
  });

  realtimeSocket.on("message", (raw) => {
    const event = safeParseJson(raw);
    if (!event) {
      logWarn("Ignoring non-JSON Realtime message", {
        sessionId: options.sessionId,
        messagePreview: previewRawMessage(raw),
      });
      return;
    }

    const eventType = asString(event.type);
    if (!eventType) {
      return;
    }

    logDebug("Received Realtime event", {
      sessionId: options.sessionId,
      eventType,
    });

    if (eventType === "error") {
      const errorRecord = asRecord(event.error);
      const errorMessage =
        asString(errorRecord?.message) ??
        asString(event.message) ??
        "OpenAI Realtime returned an unknown error event.";
      if (isRecoverableInterruptError(errorRecord, event)) {
        logWarn("Ignoring recoverable Realtime interruption control error", {
          sessionId: options.sessionId,
          eventType,
          errorMessage,
          errorCode: asString(errorRecord?.code),
          errorEventId: asString(errorRecord?.event_id) ?? asString(event.event_id),
        });
        return;
      }
      logError("Realtime error event", {
        sessionId: options.sessionId,
        errorMessage,
        eventType,
        errorCode: asString(errorRecord?.code),
        rawEvent: event,
      });
      activeResponseId = null;
      clearAssistantPlaybackTracking();
      updateCallStatus(options.sessionId, "failed", errorMessage);
      closeTwilio();
      return;
    }

    if (eventType === "response.created") {
      activeResponseId = responseIdFromEvent(event);
      return;
    }

    if (eventType === "response.output_audio.done") {
      clearAssistantPlaybackTracking();
      return;
    }

    if (eventType === "response.done") {
      activeResponseId = null;
      clearAssistantPlaybackTracking();
      return;
    }

    if (eventType === "input_audio_buffer.speech_started") {
      interruptAssistantPlayback(eventType);
      logInfo("Realtime lifecycle event", {
        sessionId: options.sessionId,
        eventType,
      });
      return;
    }

    if (eventType === "response.output_audio.delta") {
      const payload = asString(event.delta);
      if (!payload || !twilioStreamSid) {
        return;
      }
      assistantOutputActive = true;
      const itemId = asString(event.item_id);
      const contentIndex = asNumber(event.content_index) ?? 0;
      const responseId = responseIdFromEvent(event);
      if (responseId) {
        activeResponseId = responseId;
      }
      if (itemId && (activeAssistantItemId !== itemId || activeAssistantContentIndex !== contentIndex)) {
        activeAssistantItemId = itemId;
        activeAssistantContentIndex = contentIndex;
        activeAssistantAudioMsSent = 0;
        activeAssistantAudioStartedAtMs = Date.now();
      }
      if (!activeAssistantAudioStartedAtMs) {
        activeAssistantAudioStartedAtMs = Date.now();
      }
      activeAssistantAudioMsSent += pcmuMillisecondsFromBase64(payload);

      sendJson(options.twilioSocket, {
        event: "media",
        streamSid: twilioStreamSid,
        media: {
          payload,
        },
      });
      realtimeOutboundMediaFrames += 1;
      realtimeOutboundBytes += payload.length;
      realtimeAudioLevelFrames += 1;
      if (realtimeAudioLevelFrames % AUDIO_LEVEL_SAMPLE_EVERY_FRAMES === 0) {
        const level = estimatePcmuLevel(payload);
        if (level != null) {
          appendAudioLevel({
            sessionId: options.sessionId,
            speaker: "assistant",
            level,
          });
        }
      }
      if (realtimeOutboundMediaFrames % 50 === 0) {
        logDebug("Forwarded Realtime audio frames to Twilio", {
          sessionId: options.sessionId,
          frameCount: realtimeOutboundMediaFrames,
          base64Bytes: realtimeOutboundBytes,
        });
      }
      return;
    }

    if (eventType === "conversation.item.input_audio_transcription.delta") {
      const itemId = asString(event.item_id) ?? `recipient_${Date.now()}`;
      const textDelta = pickTranscriptText(event, ["delta", "transcript", "text"]);
      if (!textDelta) {
        return;
      }
      appendTranscriptDelta({
        sessionId: options.sessionId,
        itemId,
        speaker: "recipient",
        textDelta,
      });
      recipientDeltaEvents += 1;
      logDebug("Recipient transcript delta", {
        sessionId: options.sessionId,
        itemId,
        deltaChars: textDelta.length,
        deltaPreview: truncate(textDelta, 80),
        deltaCount: recipientDeltaEvents,
      });
      return;
    }

    if (eventType === "conversation.item.input_audio_transcription.completed") {
      const itemId = asString(event.item_id) ?? `recipient_${Date.now()}`;
      const fullText = pickTranscriptText(event, ["transcript", "text", "delta"]) ?? "";
      appendTranscriptFinal({
        sessionId: options.sessionId,
        itemId,
        speaker: "recipient",
        fullText,
      });
      recipientFinalEvents += 1;
      logInfo("Recipient transcript finalized", {
        sessionId: options.sessionId,
        itemId,
        chars: fullText.length,
        textPreview: truncate(fullText, 120),
        finalCount: recipientFinalEvents,
      });
      return;
    }

    if (eventType === "response.output_audio_transcript.delta") {
      const itemId = assistantItemId(event);
      const textDelta = pickTranscriptText(event, ["delta", "transcript", "text"]);
      if (!textDelta) {
        return;
      }
      appendTranscriptDelta({
        sessionId: options.sessionId,
        itemId,
        speaker: "assistant",
        textDelta,
      });
      assistantDeltaEvents += 1;
      logDebug("Assistant transcript delta", {
        sessionId: options.sessionId,
        itemId,
        deltaChars: textDelta.length,
        deltaPreview: truncate(textDelta, 80),
        deltaCount: assistantDeltaEvents,
      });
      return;
    }

    if (eventType === "response.output_audio_transcript.done") {
      const itemId = assistantItemId(event);
      const fullText = pickTranscriptText(event, ["transcript", "text", "delta"]) ?? "";
      appendTranscriptFinal({
        sessionId: options.sessionId,
        itemId,
        speaker: "assistant",
        fullText,
      });
      assistantFinalEvents += 1;
      logInfo("Assistant transcript finalized", {
        sessionId: options.sessionId,
        itemId,
        chars: fullText.length,
        textPreview: truncate(fullText, 120),
        finalCount: assistantFinalEvents,
      });
      return;
    }

    if (eventType === "input_audio_buffer.committed") {
      const itemId = asString(event.item_id);
      if (!itemId) {
        return;
      }
      recordTranscriptOrder(
        options.sessionId,
        itemId,
        asString(event.previous_item_id),
      );
      logDebug("Recorded transcript order anchor", {
        sessionId: options.sessionId,
        itemId,
        previousItemId: asString(event.previous_item_id),
      });
      return;
    }

    if (
      eventType === "session.created" ||
      eventType === "session.updated" ||
      eventType === "response.created" ||
      eventType === "response.done" ||
      eventType === "response.output_audio.done" ||
      eventType === "input_audio_buffer.speech_stopped"
    ) {
      logInfo("Realtime lifecycle event", {
        sessionId: options.sessionId,
        eventType,
      });
    }
  });

  realtimeSocket.on("unexpected-response", (_request, responseRaw) => {
    const response = responseRaw as IncomingMessage;
    const statusCode = response.statusCode ?? null;
    const statusMessage = response.statusMessage ?? null;
    const headers = response.headers ?? null;

    readUnexpectedResponseBody(response, (body) => {
      logError("Realtime websocket upgrade rejected", {
        sessionId: options.sessionId,
        statusCode,
        statusMessage,
        headers,
        bodyPreview: truncate(body, 600),
      });
    });

    updateCallStatus(
      options.sessionId,
      "failed",
      `OpenAI Realtime upgrade rejected${statusCode ? ` (${statusCode})` : ""}.`,
    );
    closeTwilio();
  });

  realtimeSocket.on("error", (error) => {
    const message = error instanceof Error ? error.message : "unknown error";
    logError("Realtime websocket error", {
      sessionId: options.sessionId,
      error: message,
    });
    updateCallStatus(
      options.sessionId,
      "failed",
      `OpenAI Realtime websocket error: ${message}`,
    );
    activeResponseId = null;
    clearAssistantPlaybackTracking();
    closeTwilio();
  });

  realtimeSocket.on("close", (code, reasonRaw) => {
    const reason =
      typeof reasonRaw === "string"
        ? reasonRaw
        : Buffer.isBuffer(reasonRaw)
          ? reasonRaw.toString("utf8")
          : "";
    logWarn("Realtime websocket closed", {
      sessionId: options.sessionId,
      code,
      reason,
      elapsedMs: Date.now() - bridgeStartedAtMs,
      twilioInboundMediaFrames,
      twilioInboundBytes,
      realtimeOutboundMediaFrames,
      realtimeOutboundBytes,
      recipientDeltaEvents,
      recipientFinalEvents,
      assistantDeltaEvents,
      assistantFinalEvents,
    });
    if (!twilioStopped && code !== 1000) {
      const session = getCallSession(options.sessionId);
      if (session && !session.endedAt) {
        updateCallStatus(
          options.sessionId,
          "failed",
          `OpenAI Realtime websocket closed with code ${String(code)}${reason ? ` (${reason})` : ""}`,
        );
      }
    }
    activeResponseId = null;
    clearAssistantPlaybackTracking();
    closeTwilio();
  });

  options.twilioSocket.on("message", (raw) => {
    const payload = safeParseJson(raw);
    if (!payload) {
      logWarn("Ignoring non-JSON Twilio media message", {
        sessionId: options.sessionId,
        messagePreview: previewRawMessage(raw),
      });
      return;
    }

    const eventName = asString(payload.event);
    if (!eventName) {
      return;
    }

    logDebug("Received Twilio media event", {
      sessionId: options.sessionId,
      eventName,
    });

    if (eventName === "start") {
      handleTwilioStartEvent(payload);
      return;
    }

    if (eventName === "media") {
      const media = asRecord(payload.media);
      const encodedAudio = asString(media?.payload);
      if (!encodedAudio || realtimeSocket.readyState !== WS_OPEN) {
        if (!encodedAudio) {
          logWarn("Dropping Twilio media chunk without payload", {
            sessionId: options.sessionId,
          });
        } else {
          logWarn("Dropping Twilio media chunk because Realtime socket is not open", {
            sessionId: options.sessionId,
            realtimeReadyState: realtimeSocket.readyState,
          });
        }
        return;
      }
      sendJson(realtimeSocket, {
        type: "input_audio_buffer.append",
        audio: encodedAudio,
      });
      twilioInboundMediaFrames += 1;
      twilioInboundBytes += encodedAudio.length;
      twilioAudioLevelFrames += 1;
      if (twilioAudioLevelFrames % AUDIO_LEVEL_SAMPLE_EVERY_FRAMES === 0) {
        const level = estimatePcmuLevel(encodedAudio);
        if (level != null) {
          appendAudioLevel({
            sessionId: options.sessionId,
            speaker: "recipient",
            level,
          });
        }
      }
      if (twilioInboundMediaFrames % 50 === 0) {
        logDebug("Forwarded Twilio audio frames to Realtime", {
          sessionId: options.sessionId,
          frameCount: twilioInboundMediaFrames,
          base64Bytes: twilioInboundBytes,
        });
      }
      return;
    }

    if (eventName === "stop") {
      twilioStopped = true;
      const stop = asRecord(payload.stop);
      const reason =
        asString(stop?.reason) ??
        asString(stop?.callStatus) ??
        "Twilio media stream stopped";
      logInfo("Twilio media stream stop event", {
        sessionId: options.sessionId,
        reason,
        stopPayload: stop ?? null,
      });
      activeResponseId = null;
      clearAssistantPlaybackTracking();
      updateCallStatus(options.sessionId, "completed", reason);
      closeRealtime();
      return;
    }

    logDebug("Unhandled Twilio media event", {
      sessionId: options.sessionId,
      eventName,
      payload,
    });
  });

  options.twilioSocket.on("close", (code, reasonRaw) => {
    twilioStopped = true;
    const reason =
      typeof reasonRaw === "string"
        ? reasonRaw
        : Buffer.isBuffer(reasonRaw)
          ? reasonRaw.toString("utf8")
          : "";
    logWarn("Twilio media websocket closed", {
      sessionId: options.sessionId,
      code,
      reason,
      elapsedMs: Date.now() - bridgeStartedAtMs,
      twilioInboundMediaFrames,
      twilioInboundBytes,
      realtimeOutboundMediaFrames,
      realtimeOutboundBytes,
      recipientDeltaEvents,
      recipientFinalEvents,
      assistantDeltaEvents,
      assistantFinalEvents,
    });
    closeRealtime();
  });

  options.twilioSocket.on("error", (error) => {
    twilioStopped = true;
    const message = error instanceof Error ? error.message : "unknown error";
    logError("Twilio media websocket error", {
      sessionId: options.sessionId,
      error: message,
    });
    closeRealtime();
  });

  if (options.initialTwilioStartEvent) {
    logDebug("Applying buffered Twilio start event before live media forwarding", {
      sessionId: options.sessionId,
    });
    handleTwilioStartEvent(options.initialTwilioStartEvent);
  }
}
