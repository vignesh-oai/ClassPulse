import crypto from "node:crypto";
import { logDebug, logInfo, logWarn } from "./call-debug";

export type LogSocket = {
  readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
};

export type CallStatus =
  | "ready"
  | "queued"
  | "ringing"
  | "in-progress"
  | "completed"
  | "failed";

export type TranscriptSpeaker = "recipient" | "assistant";

export type CallLogEvent =
  | {
      type: "status";
      seq: number;
      status: CallStatus;
      timestamp: string;
    }
  | {
      type: "transcript.delta";
      seq: number;
      itemId: string;
      speaker: TranscriptSpeaker;
      textDelta: string;
      timestamp: string;
      order: number;
    }
  | {
      type: "transcript.final";
      seq: number;
      itemId: string;
      speaker: TranscriptSpeaker;
      fullText: string;
      timestamp: string;
      order: number;
    }
  | {
      type: "audio.level";
      seq: number;
      speaker: TranscriptSpeaker;
      level: number;
      timestamp: string;
    }
  | {
      type: "session.end";
      seq: number;
      reason: string;
      timestamp: string;
    };

export type TranscriptItem = {
  itemId: string;
  speaker: TranscriptSpeaker;
  text: string;
  isFinal: boolean;
  seq: number;
  timestamp: string;
  order: number;
};

type LogSubscriber = {
  id: string;
  socket: LogSocket;
};

export type CallSession = {
  sessionId: string;
  callSid: string | null;
  status: CallStatus;
  startedAt: string;
  endedAt: string | null;
  seq: number;
  transcriptItems: Map<string, TranscriptItem>;
  transcriptOrder: string[];
  logSubscribers: Map<string, LogSubscriber>;
  logEvents: CallLogEvent[];
  terminalReason: string | null;
};

type CallLogEventInput =
  | {
      type: "status";
      status: CallStatus;
      timestamp?: string;
    }
  | {
      type: "transcript.delta";
      itemId: string;
      speaker: TranscriptSpeaker;
      textDelta: string;
      order: number;
      timestamp?: string;
    }
  | {
      type: "transcript.final";
      itemId: string;
      speaker: TranscriptSpeaker;
      fullText: string;
      order: number;
      timestamp?: string;
    }
  | {
      type: "audio.level";
      speaker: TranscriptSpeaker;
      level: number;
      timestamp?: string;
    }
  | {
      type: "session.end";
      reason: string;
      timestamp?: string;
    };

const callSessions = new Map<string, CallSession>();
const callSidToSessionId = new Map<string, string>();
const TERMINAL_STATUSES = new Set<CallStatus>(["completed", "failed"]);
const MAX_LOG_EVENTS = 5000;

function nowIso(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function nextSequence(session: CallSession): number {
  session.seq += 1;
  return session.seq;
}

function ensureTranscriptOrder(
  session: CallSession,
  itemId: string,
  previousItemId?: string | null,
): number {
  if (!session.transcriptOrder.includes(itemId)) {
    if (previousItemId && session.transcriptOrder.includes(previousItemId)) {
      const previousIndex = session.transcriptOrder.indexOf(previousItemId);
      session.transcriptOrder.splice(previousIndex + 1, 0, itemId);
    } else {
      session.transcriptOrder.push(itemId);
    }
  }

  return session.transcriptOrder.indexOf(itemId);
}

function broadcastLogEvent(session: CallSession, event: CallLogEvent): void {
  const encoded = JSON.stringify(event);

  for (const subscriber of session.logSubscribers.values()) {
    if (subscriber.socket.readyState !== 1) {
      continue;
    }

    try {
      subscriber.socket.send(encoded);
    } catch {
      subscriber.socket.terminate();
    }
  }
}

function appendLogEvent(
  session: CallSession,
  event: CallLogEventInput,
): CallLogEvent {
  const timestamp = event.timestamp ?? nowIso();
  const seq = nextSequence(session);
  let nextEvent: CallLogEvent;

  if (event.type === "status") {
    nextEvent = {
      type: "status",
      seq,
      status: event.status,
      timestamp,
    };
  } else if (event.type === "transcript.delta") {
    nextEvent = {
      type: "transcript.delta",
      seq,
      itemId: event.itemId,
      speaker: event.speaker,
      textDelta: event.textDelta,
      timestamp,
      order: event.order,
    };
  } else if (event.type === "transcript.final") {
    nextEvent = {
      type: "transcript.final",
      seq,
      itemId: event.itemId,
      speaker: event.speaker,
      fullText: event.fullText,
      timestamp,
      order: event.order,
    };
  } else if (event.type === "audio.level") {
    nextEvent = {
      type: "audio.level",
      seq,
      speaker: event.speaker,
      level: event.level,
      timestamp,
    };
  } else {
    nextEvent = {
      type: "session.end",
      seq,
      reason: event.reason,
      timestamp,
    };
  }

  session.logEvents.push(nextEvent);
  if (session.logEvents.length > MAX_LOG_EVENTS) {
    session.logEvents.splice(0, session.logEvents.length - MAX_LOG_EVENTS);
  }
  logDebug("Appended call log event", {
    sessionId: session.sessionId,
    eventType: nextEvent.type,
    seq: nextEvent.seq,
  });

  broadcastLogEvent(session, nextEvent);
  return nextEvent;
}

function closeSubscribers(session: CallSession): void {
  const subscriberCount = session.logSubscribers.size;
  for (const subscriber of session.logSubscribers.values()) {
    if (subscriber.socket.readyState === 1) {
      subscriber.socket.close(1000, "Call session ended");
    } else {
      subscriber.socket.terminate();
    }
  }
  session.logSubscribers.clear();
  logInfo("Closed call log subscribers", {
    sessionId: session.sessionId,
    subscriberCount,
  });
}

function markTerminal(session: CallSession, reason: string): void {
  if (session.endedAt) {
    return;
  }

  session.endedAt = nowIso();
  session.terminalReason = reason;

  appendLogEvent(session, {
    type: "session.end",
    reason,
  });
  logInfo("Call session marked terminal", {
    sessionId: session.sessionId,
    status: session.status,
    reason,
  });

  setTimeout(() => {
    closeSubscribers(session);
  }, 1000);
}

function upsertTranscriptItem(
  session: CallSession,
  itemId: string,
  speaker: TranscriptSpeaker,
  previousItemId?: string | null,
): TranscriptItem {
  const existing = session.transcriptItems.get(itemId);
  if (existing) {
    return existing;
  }

  const order = ensureTranscriptOrder(session, itemId, previousItemId);
  const created: TranscriptItem = {
    itemId,
    speaker,
    text: "",
    isFinal: false,
    seq: 0,
    timestamp: nowIso(),
    order,
  };
  session.transcriptItems.set(itemId, created);
  return created;
}

export function createCallSession(): CallSession {
  const createdAt = nowIso();
  const session: CallSession = {
    sessionId: randomId("call"),
    callSid: null,
    status: "queued",
    startedAt: createdAt,
    endedAt: null,
    seq: 0,
    transcriptItems: new Map<string, TranscriptItem>(),
    transcriptOrder: [],
    logSubscribers: new Map<string, LogSubscriber>(),
    logEvents: [],
    terminalReason: null,
  };

  callSessions.set(session.sessionId, session);
  appendLogEvent(session, {
    type: "status",
    status: "queued",
  });
  logInfo("Created call session in store", {
    sessionId: session.sessionId,
    status: session.status,
  });

  return session;
}

export function getCallSession(sessionId: string): CallSession | undefined {
  return callSessions.get(sessionId);
}

export function setCallSid(sessionId: string, callSid: string): void {
  const session = callSessions.get(sessionId);
  if (!session) {
    logWarn("Attempted to set call sid on unknown session", {
      sessionId,
      callSid,
    });
    return;
  }
  const previousCallSid = session.callSid;
  if (previousCallSid && callSidToSessionId.get(previousCallSid) === sessionId) {
    callSidToSessionId.delete(previousCallSid);
  }
  session.callSid = callSid;
  callSidToSessionId.set(callSid, sessionId);
  logInfo("Stored call sid on session", {
    sessionId,
    callSid,
  });
}

export function getSessionIdByCallSid(callSid: string): string | null {
  return callSidToSessionId.get(callSid) ?? null;
}

export function updateCallStatus(
  sessionId: string,
  status: CallStatus,
  reason?: string,
): void {
  const session = callSessions.get(sessionId);
  if (!session) {
    logWarn("Attempted to update status on unknown session", {
      sessionId,
      status,
      reason: reason ?? null,
    });
    return;
  }

  // Preserve the first terminal outcome to avoid masking failures with
  // subsequent Twilio "completed" callbacks.
  if (session.endedAt) {
    logDebug("Ignoring status update for terminal session", {
      sessionId,
      currentStatus: session.status,
      nextStatus: status,
      reason: reason ?? null,
    });
    return;
  }

  const previousStatus = session.status;
  const changed = previousStatus !== status;
  session.status = status;
  logInfo("Updated call status", {
    sessionId,
    previousStatus,
    nextStatus: status,
    reason: reason ?? null,
  });

  if (changed || reason) {
    appendLogEvent(session, {
      type: "status",
      status,
    });
  }

  if (TERMINAL_STATUSES.has(status)) {
    markTerminal(session, reason ?? `Call ${status}`);
  }
}

export function recordTranscriptOrder(
  sessionId: string,
  itemId: string,
  previousItemId?: string | null,
): void {
  const session = callSessions.get(sessionId);
  if (!session) {
    return;
  }

  const existing = session.transcriptItems.get(itemId);
  const order = ensureTranscriptOrder(session, itemId, previousItemId);

  if (existing) {
    existing.order = order;
  }
}

export function appendTranscriptDelta(params: {
  sessionId: string;
  itemId: string;
  speaker: TranscriptSpeaker;
  textDelta: string;
  previousItemId?: string | null;
}): void {
  const session = callSessions.get(params.sessionId);
  if (!session || params.textDelta.length === 0) {
    return;
  }

  const item = upsertTranscriptItem(
    session,
    params.itemId,
    params.speaker,
    params.previousItemId,
  );

  item.text = `${item.text}${params.textDelta}`;
  item.isFinal = false;
  item.timestamp = nowIso();
  item.order = ensureTranscriptOrder(session, item.itemId, params.previousItemId);

  const event = appendLogEvent(session, {
    type: "transcript.delta",
    itemId: item.itemId,
    speaker: item.speaker,
    textDelta: params.textDelta,
    order: item.order,
  });

  item.seq = event.seq;
  item.timestamp = event.timestamp;
}

export function appendTranscriptFinal(params: {
  sessionId: string;
  itemId: string;
  speaker: TranscriptSpeaker;
  fullText: string;
  previousItemId?: string | null;
}): void {
  const session = callSessions.get(params.sessionId);
  if (!session) {
    return;
  }

  const item = upsertTranscriptItem(
    session,
    params.itemId,
    params.speaker,
    params.previousItemId,
  );

  item.text = params.fullText;
  item.isFinal = true;
  item.timestamp = nowIso();
  item.order = ensureTranscriptOrder(session, item.itemId, params.previousItemId);

  const event = appendLogEvent(session, {
    type: "transcript.final",
    itemId: item.itemId,
    speaker: item.speaker,
    fullText: params.fullText,
    order: item.order,
  });

  item.seq = event.seq;
  item.timestamp = event.timestamp;
}

export function appendAudioLevel(params: {
  sessionId: string;
  speaker: TranscriptSpeaker;
  level: number;
}): void {
  const session = callSessions.get(params.sessionId);
  if (!session) {
    return;
  }

  const clamped = Math.max(0, Math.min(1, params.level));
  appendLogEvent(session, {
    type: "audio.level",
    speaker: params.speaker,
    level: clamped,
  });
}

export function listLogEventsSince(
  sessionId: string,
  sinceSeq: number,
): CallLogEvent[] {
  const session = callSessions.get(sessionId);
  if (!session) {
    return [];
  }

  return session.logEvents.filter((event) => event.seq > sinceSeq);
}

export function subscribeToCallLogs(
  sessionId: string,
  socket: LogSocket,
): string | null {
  const session = callSessions.get(sessionId);
  if (!session) {
    logWarn("Failed to subscribe logs on unknown session", {
      sessionId,
    });
    return null;
  }

  const subscriberId = randomId("log_sub");
  session.logSubscribers.set(subscriberId, {
    id: subscriberId,
    socket,
  });
  logInfo("Subscribed call logs", {
    sessionId,
    subscriberId,
    subscriberCount: session.logSubscribers.size,
  });

  return subscriberId;
}

export function unsubscribeFromCallLogs(
  sessionId: string,
  subscriberId: string,
): void {
  const session = callSessions.get(sessionId);
  if (!session) {
    logWarn("Tried to unsubscribe unknown session subscriber", {
      sessionId,
      subscriberId,
    });
    return;
  }
  session.logSubscribers.delete(subscriberId);
  logInfo("Unsubscribed call logs", {
    sessionId,
    subscriberId,
    subscriberCount: session.logSubscribers.size,
  });
}

export function getCallSessionSummary(sessionId: string): {
  sessionId: string;
  callSid: string | null;
  status: CallStatus;
  startedAt: string;
  endedAt: string | null;
  terminalReason: string | null;
  lastSeq: number;
  transcript: TranscriptItem[];
} | null {
  const session = callSessions.get(sessionId);
  if (!session) {
    return null;
  }

  const transcript = Array.from(session.transcriptItems.values()).sort((a, b) => {
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    return a.seq - b.seq;
  });

  return {
    sessionId: session.sessionId,
    callSid: session.callSid,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    terminalReason: session.terminalReason,
    lastSeq: session.seq,
    transcript,
  };
}
