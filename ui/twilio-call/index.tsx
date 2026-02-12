import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@openai/apps-sdk-ui/components/Button";
import { useWidgetProps } from "../hooks/use-widget-props";
import { useWidgetState } from "../hooks/use-widget-state";
import samPortrait from "./sam-schoolgirl.png";
import "./styles.css";

type CallStatus =
  | "ready"
  | "queued"
  | "ringing"
  | "in-progress"
  | "completed"
  | "failed";

type WidgetToolOutput = {
  sessionId: string | null;
  displayNumber: string;
  studentName: string;
  parentName: string;
  parentRelationship: string;
  parentNumberLabel: string;
  status: CallStatus;
  logsWsUrl: string | null;
  viewerToken?: string | null;
  reconnectSinceSeq?: number;
  errorMessage?: string;
};

type TranscriptLine = {
  itemId: string;
  speaker: "recipient" | "assistant";
  text: string;
  isFinal: boolean;
  seq: number;
  order: number;
};

type CallWidgetState = {
  sessionId: string | null;
  status: CallStatus;
  lastSeq: number;
  transcript: TranscriptLine[];
  logsWsUrl: string | null;
  viewerToken: string | null;
  errorMessage: string | null;
  isConnecting: boolean;
  studentName: string;
  parentName: string;
  parentRelationship: string;
  parentNumberLabel: string;
};

type CallLogEvent =
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
      speaker: "recipient" | "assistant";
      textDelta: string;
      timestamp: string;
      order?: number;
    }
  | {
      type: "transcript.final";
      seq: number;
      itemId: string;
      speaker: "recipient" | "assistant";
      fullText: string;
      timestamp: string;
      order?: number;
    }
  | {
      type: "session.end";
      seq: number;
      reason: string;
      timestamp: string;
    };

const DEFAULT_STUDENT_NAME = "Sam";
const DEFAULT_PARENT_NAME = "Jerry";
const DEFAULT_PARENT_RELATIONSHIP = "father";
const DEFAULT_PARENT_NUMBER_LABEL = "Jerry's number on file";

const DEFAULT_TOOL_OUTPUT: WidgetToolOutput = {
  sessionId: null,
  displayNumber: DEFAULT_PARENT_NUMBER_LABEL,
  studentName: DEFAULT_STUDENT_NAME,
  parentName: DEFAULT_PARENT_NAME,
  parentRelationship: DEFAULT_PARENT_RELATIONSHIP,
  parentNumberLabel: DEFAULT_PARENT_NUMBER_LABEL,
  status: "ready",
  logsWsUrl: null,
  viewerToken: null,
  reconnectSinceSeq: 0,
};

function isTerminalStatus(status: CallStatus): boolean {
  return status === "completed" || status === "failed";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStatus(value: unknown): CallStatus | null {
  if (
    value === "ready" ||
    value === "queued" ||
    value === "ringing" ||
    value === "in-progress" ||
    value === "completed" ||
    value === "failed"
  ) {
    return value;
  }
  return null;
}

function prettyRelationship(raw: string): string {
  if (!raw) {
    return "Parent";
  }
  const normalized = raw.trim();
  if (normalized.length === 0) {
    return "Parent";
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function parseCallStartPayload(value: unknown): WidgetToolOutput | null {
  const fromRoot = asRecord(value);
  const structuredContent = asRecord(fromRoot?.structuredContent);
  let candidate = structuredContent ?? fromRoot;

  if (!candidate) {
    return null;
  }

  const maybeResultString = asString(candidate.result);
  if (maybeResultString) {
    try {
      const parsedResult = JSON.parse(maybeResultString) as Record<string, unknown>;
      candidate = asRecord(parsedResult) ?? candidate;
    } catch {
      // Keep original candidate if result is plain text.
    }
  }

  if (!candidate) {
    return null;
  }

  const sessionId = asString(candidate.sessionId);
  const displayNumber = asString(candidate.displayNumber) ?? DEFAULT_PARENT_NUMBER_LABEL;
  const status = asStatus(candidate.status);
  const logsWsUrl = asString(candidate.logsWsUrl);
  const viewerToken = asString(candidate.viewerToken);

  if (!sessionId || !status || !logsWsUrl || !viewerToken) {
    return null;
  }

  const studentName = asString(candidate.studentName) ?? DEFAULT_STUDENT_NAME;
  const parentName = asString(candidate.parentName) ?? DEFAULT_PARENT_NAME;
  const parentRelationship =
    asString(candidate.parentRelationship) ?? DEFAULT_PARENT_RELATIONSHIP;
  const parentNumberLabel =
    asString(candidate.parentNumberLabel) ?? displayNumber ?? DEFAULT_PARENT_NUMBER_LABEL;

  return {
    sessionId,
    displayNumber,
    studentName,
    parentName,
    parentRelationship,
    parentNumberLabel,
    status,
    logsWsUrl,
    viewerToken,
    reconnectSinceSeq: asNumber(candidate.reconnectSinceSeq) ?? 0,
    errorMessage: asString(candidate.errorMessage) ?? undefined,
  };
}

function parseLogEvent(raw: string): CallLogEvent | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const eventType = asString(parsed.type);
    const seq = asNumber(parsed.seq);
    if (!eventType || seq == null) {
      return null;
    }

    if (eventType === "status") {
      const status = asStatus(parsed.status);
      const timestamp = asString(parsed.timestamp) ?? new Date().toISOString();
      if (!status) {
        return null;
      }
      return { type: "status", seq, status, timestamp };
    }

    if (eventType === "transcript.delta") {
      const itemId = asString(parsed.itemId);
      const speaker = asString(parsed.speaker);
      const textDelta = asString(parsed.textDelta);
      const timestamp = asString(parsed.timestamp) ?? new Date().toISOString();
      if (
        !itemId ||
        (speaker !== "recipient" && speaker !== "assistant") ||
        textDelta == null
      ) {
        return null;
      }
      return {
        type: "transcript.delta",
        seq,
        itemId,
        speaker,
        textDelta,
        timestamp,
        order: asNumber(parsed.order) ?? undefined,
      };
    }

    if (eventType === "transcript.final") {
      const itemId = asString(parsed.itemId);
      const speaker = asString(parsed.speaker);
      const fullText = asString(parsed.fullText) ?? "";
      const timestamp = asString(parsed.timestamp) ?? new Date().toISOString();
      if (!itemId || (speaker !== "recipient" && speaker !== "assistant")) {
        return null;
      }
      return {
        type: "transcript.final",
        seq,
        itemId,
        speaker,
        fullText,
        timestamp,
        order: asNumber(parsed.order) ?? undefined,
      };
    }

    if (eventType === "session.end") {
      return {
        type: "session.end",
        seq,
        reason: asString(parsed.reason) ?? "Call ended",
        timestamp: asString(parsed.timestamp) ?? new Date().toISOString(),
      };
    }

    return null;
  } catch {
    return null;
  }
}

function sortTranscript(lines: TranscriptLine[]): TranscriptLine[] {
  return [...lines].sort((left, right) => {
    if (left.order !== right.order) {
      return left.order - right.order;
    }
    return left.seq - right.seq;
  });
}

function applyLogEvent(state: CallWidgetState, event: CallLogEvent): CallWidgetState {
  if (event.seq <= state.lastSeq) {
    return state;
  }

  if (event.type === "status") {
    return {
      ...state,
      status: event.status,
      lastSeq: event.seq,
      isConnecting: false,
    };
  }

  if (event.type === "session.end") {
    return {
      ...state,
      lastSeq: event.seq,
      isConnecting: false,
      errorMessage: state.errorMessage ?? event.reason,
    };
  }

  const updatedTranscript = [...state.transcript];
  const existingIndex = updatedTranscript.findIndex(
    (line) => line.itemId === event.itemId && line.speaker === event.speaker,
  );

  if (event.type === "transcript.delta") {
    if (existingIndex >= 0) {
      const existing = updatedTranscript[existingIndex];
      updatedTranscript[existingIndex] = {
        ...existing,
        text: `${existing.text}${event.textDelta}`,
        isFinal: false,
        seq: event.seq,
        order: event.order ?? existing.order,
      };
    } else {
      updatedTranscript.push({
        itemId: event.itemId,
        speaker: event.speaker,
        text: event.textDelta,
        isFinal: false,
        seq: event.seq,
        order: event.order ?? updatedTranscript.length,
      });
    }
  }

  if (event.type === "transcript.final") {
    if (existingIndex >= 0) {
      const existing = updatedTranscript[existingIndex];
      updatedTranscript[existingIndex] = {
        ...existing,
        text: event.fullText,
        isFinal: true,
        seq: event.seq,
        order: event.order ?? existing.order,
      };
    } else {
      updatedTranscript.push({
        itemId: event.itemId,
        speaker: event.speaker,
        text: event.fullText,
        isFinal: true,
        seq: event.seq,
        order: event.order ?? updatedTranscript.length,
      });
    }
  }

  return {
    ...state,
    transcript: sortTranscript(updatedTranscript),
    lastSeq: event.seq,
    isConnecting: false,
  };
}

function statusBadgeClass(status: CallStatus): string {
  if (status === "in-progress") {
    return "bg-emerald-500/15 text-emerald-700 border-emerald-700/20";
  }
  if (status === "ringing" || status === "queued") {
    return "bg-amber-500/15 text-amber-700 border-amber-700/20";
  }
  if (status === "completed") {
    return "bg-slate-500/15 text-slate-700 border-slate-700/20";
  }
  if (status === "failed") {
    return "bg-rose-500/15 text-rose-700 border-rose-700/20";
  }
  return "bg-sky-500/15 text-sky-700 border-sky-700/20";
}

function transcriptSpeakerLabel(
  speaker: TranscriptLine["speaker"],
  parentName: string,
): string {
  if (speaker === "assistant") {
    return "School Assistant";
  }
  return parentName;
}

function App() {
  const toolOutput = useWidgetProps<WidgetToolOutput>(DEFAULT_TOOL_OUTPUT);
  const [widgetState, setWidgetState] = useWidgetState<CallWidgetState>(() => ({
    sessionId: toolOutput.sessionId,
    status: toolOutput.status ?? "ready",
    lastSeq: toolOutput.reconnectSinceSeq ?? 0,
    transcript: [],
    logsWsUrl: toolOutput.logsWsUrl ?? null,
    viewerToken: toolOutput.viewerToken ?? null,
    errorMessage: toolOutput.errorMessage ?? null,
    isConnecting: false,
    studentName: toolOutput.studentName ?? DEFAULT_STUDENT_NAME,
    parentName: toolOutput.parentName ?? DEFAULT_PARENT_NAME,
    parentRelationship: toolOutput.parentRelationship ?? DEFAULT_PARENT_RELATIONSHIP,
    parentNumberLabel: toolOutput.parentNumberLabel ?? toolOutput.displayNumber,
  }));

  const effectiveState =
    widgetState ??
    ({
      sessionId: toolOutput.sessionId,
      status: toolOutput.status ?? "ready",
      lastSeq: toolOutput.reconnectSinceSeq ?? 0,
      transcript: [],
      logsWsUrl: toolOutput.logsWsUrl ?? null,
      viewerToken: toolOutput.viewerToken ?? null,
      errorMessage: toolOutput.errorMessage ?? null,
      isConnecting: false,
      studentName: toolOutput.studentName ?? DEFAULT_STUDENT_NAME,
      parentName: toolOutput.parentName ?? DEFAULT_PARENT_NAME,
      parentRelationship: toolOutput.parentRelationship ?? DEFAULT_PARENT_RELATIONSHIP,
      parentNumberLabel:
        toolOutput.parentNumberLabel ?? toolOutput.displayNumber ?? DEFAULT_PARENT_NUMBER_LABEL,
    } as CallWidgetState);

  const [waveStep, setWaveStep] = useState(0);

  const sessionId = effectiveState.sessionId;
  const logsWsUrl = effectiveState.logsWsUrl;
  const viewerToken = effectiveState.viewerToken;

  const logsSocketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const manualDisconnectRef = useRef(false);
  const lastSeqRef = useRef(effectiveState.lastSeq);
  const statusRef = useRef<CallStatus>(effectiveState.status);
  const stateRef = useRef<CallWidgetState>(effectiveState);

  useEffect(() => {
    lastSeqRef.current = effectiveState.lastSeq;
    statusRef.current = effectiveState.status;
    stateRef.current = effectiveState;
  }, [effectiveState]);

  useEffect(() => {
    const intervalMs =
      effectiveState.status === "in-progress"
        ? 120
        : effectiveState.isConnecting || effectiveState.status === "ringing"
          ? 170
          : 280;

    const timer = window.setInterval(() => {
      setWaveStep((current) => current + 1);
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [effectiveState.isConnecting, effectiveState.status]);

  const waveBars = useMemo(() => {
    const isActive =
      effectiveState.status === "in-progress" ||
      effectiveState.status === "ringing" ||
      effectiveState.isConnecting;
    const transcriptIntensity = Math.min(1, effectiveState.transcript.length / 8);
    const base = isActive ? 0.18 : 0.06;

    return Array.from({ length: 24 }, (_, index) => {
      const phase = waveStep * 0.45 + index * 0.87 + effectiveState.lastSeq * 0.16;
      const primary = (Math.sin(phase) + 1) / 2;
      const secondary = (Math.cos(phase * 1.7) + 1) / 2;
      const pulse = (Math.sin((effectiveState.lastSeq + index) * 0.55) + 1) / 2;
      const amplitude = base + primary * 0.42 + secondary * 0.23 + transcriptIntensity * 0.2 * pulse;
      return Math.min(1, amplitude);
    });
  }, [effectiveState.isConnecting, effectiveState.lastSeq, effectiveState.status, effectiveState.transcript.length, waveStep]);

  const closeSocket = useCallback(() => {
    if (logsSocketRef.current) {
      try {
        logsSocketRef.current.close();
      } catch {
        logsSocketRef.current = null;
      }
      logsSocketRef.current = null;
    }
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connectLogStream = useCallback(() => {
    if (!sessionId || !logsWsUrl || !viewerToken) {
      return;
    }

    closeSocket();

    let streamUrl: URL;
    try {
      streamUrl = new URL(logsWsUrl);
      streamUrl.searchParams.set("sessionId", sessionId);
      streamUrl.searchParams.set("viewerToken", viewerToken);
      streamUrl.searchParams.set("sinceSeq", String(lastSeqRef.current));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid logs websocket URL";
      setWidgetState((current) => ({
        ...(current ?? stateRef.current),
        isConnecting: false,
        errorMessage: `Log stream URL error: ${message}`,
      }));
      return;
    }

    setWidgetState((current) => ({
      ...(current ?? stateRef.current),
      isConnecting: true,
    }));

    let socket: WebSocket;
    try {
      socket = new WebSocket(streamUrl.toString());
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to open transcript websocket";
      setWidgetState((current) => ({
        ...(current ?? stateRef.current),
        isConnecting: false,
        errorMessage: `Transcript stream blocked: ${message}`,
      }));
      reconnectAttemptsRef.current += 1;
      const delayMs = Math.min(5000, 400 * 2 ** reconnectAttemptsRef.current);
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        connectLogStream();
      }, delayMs);
      return;
    }
    logsSocketRef.current = socket;

    socket.onopen = () => {
      reconnectAttemptsRef.current = 0;
      setWidgetState((current) => ({
        ...(current ?? stateRef.current),
        isConnecting: false,
      }));
    };

    socket.onmessage = (message) => {
      const raw = typeof message.data === "string" ? message.data : null;
      if (!raw) {
        return;
      }
      const parsedEvent = parseLogEvent(raw);
      if (!parsedEvent) {
        return;
      }
      setWidgetState((current) => {
        const base = current ?? stateRef.current;
        return applyLogEvent(base, parsedEvent);
      });
    };

    socket.onclose = () => {
      logsSocketRef.current = null;
      if (manualDisconnectRef.current || isTerminalStatus(statusRef.current)) {
        return;
      }

      reconnectAttemptsRef.current += 1;
      const delayMs = Math.min(5000, 400 * 2 ** reconnectAttemptsRef.current);
      clearReconnectTimer();
      reconnectTimerRef.current = window.setTimeout(() => {
        connectLogStream();
      }, delayMs);
    };

    socket.onerror = () => {
      setWidgetState((current) => ({
        ...(current ?? stateRef.current),
        errorMessage: "Log stream connection error. Reconnecting...",
      }));
    };
  }, [
    clearReconnectTimer,
    closeSocket,
    logsWsUrl,
    sessionId,
    setWidgetState,
    viewerToken,
  ]);

  useEffect(() => {
    manualDisconnectRef.current = false;

    if (sessionId && logsWsUrl && viewerToken) {
      connectLogStream();
    }

    return () => {
      manualDisconnectRef.current = true;
      clearReconnectTimer();
      closeSocket();
    };
  }, [
    clearReconnectTimer,
    closeSocket,
    connectLogStream,
    logsWsUrl,
    sessionId,
    viewerToken,
  ]);

  const onStartCall = useCallback(async () => {
    setWidgetState((current) => ({
      ...(current ?? stateRef.current),
      isConnecting: true,
      errorMessage: null,
    }));

    try {
      const result = await window.openai?.callTool?.("twilio-call-start", {});
      const parsed = parseCallStartPayload(result);

      if (!parsed) {
        throw new Error("Unable to parse twilio-call-start result.");
      }

      setWidgetState((current) => {
        const base = current ?? stateRef.current;
        return {
          ...base,
          sessionId: parsed.sessionId,
          status: parsed.status,
          logsWsUrl: parsed.logsWsUrl,
          viewerToken: parsed.viewerToken ?? null,
          errorMessage: parsed.errorMessage ?? null,
          isConnecting: false,
          lastSeq: parsed.reconnectSinceSeq ?? base.lastSeq,
          transcript: [],
          studentName: parsed.studentName,
          parentName: parsed.parentName,
          parentRelationship: parsed.parentRelationship,
          parentNumberLabel: parsed.parentNumberLabel,
        };
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Call start failed with an unknown error.";
      setWidgetState((current) => ({
        ...(current ?? stateRef.current),
        status: "failed",
        errorMessage: message,
        isConnecting: false,
      }));
    }
  }, [setWidgetState]);

  const canStartCall = useMemo(
    () =>
      !effectiveState.isConnecting &&
      !isTerminalStatus(effectiveState.status) &&
      effectiveState.status !== "in-progress" &&
      effectiveState.status !== "ringing" &&
      effectiveState.status !== "queued",
    [effectiveState.isConnecting, effectiveState.status],
  );

  return (
    <div className="twilio-call-widget antialiased border border-slate-900/10 rounded-2xl overflow-hidden text-slate-900">
      <div className="twilio-hero px-4 py-4 border-b border-slate-900/10">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-xs uppercase tracking-[0.16em] text-slate-600">Attendance Outreach</div>
            <div className="text-xl font-semibold text-slate-900">Parent Call Assistant</div>
          </div>
          <div
            className={`text-xs rounded-full border px-2.5 py-1 font-medium ${statusBadgeClass(
              effectiveState.status,
            )}`}
          >
            {effectiveState.status}
          </div>
        </div>

        <div className="twilio-profile-panel rounded-xl border border-slate-900/10 bg-white/90 p-3 flex gap-3 items-center">
          <img
            src={samPortrait}
            alt={`${effectiveState.studentName} student profile`}
            className="w-20 h-20 rounded-xl object-cover border border-slate-900/10"
          />
          <div className="min-w-0 grid gap-1">
            <div className="text-xs uppercase tracking-wide text-slate-500">Student</div>
            <div className="text-base font-semibold truncate">{effectiveState.studentName}</div>
            <div className="text-xs uppercase tracking-wide text-slate-500 mt-1">Parent Contact</div>
            <div className="text-sm text-slate-800 truncate">
              {effectiveState.parentName} ({prettyRelationship(effectiveState.parentRelationship)})
            </div>
            <div className="text-xs text-slate-600 truncate">Calling: {effectiveState.parentNumberLabel}</div>
          </div>
        </div>
      </div>

      <div className="px-4 py-3 border-b border-slate-900/10 bg-white">
        <Button
          color="primary"
          variant="solid"
          disabled={!canStartCall}
          onClick={() => void onStartCall()}
          block
        >
          {effectiveState.isConnecting ? "Connecting..." : `Call ${effectiveState.parentName}`}
        </Button>
        {effectiveState.errorMessage && (
          <p className="mt-2 text-xs text-rose-700">{effectiveState.errorMessage}</p>
        )}
      </div>

      <div className="px-4 py-3 border-b border-slate-900/10 bg-slate-50/80">
        <div className="text-xs uppercase tracking-[0.15em] text-slate-500 mb-2">Live Interaction</div>
        <div className="twilio-wave-chart" aria-label="Live conversation activity waveform">
          {waveBars.map((amplitude, index) => (
            <span
              key={`wave-${index}`}
              className="twilio-wave-bar"
              style={{
                height: `${Math.round(8 + amplitude * 40)}px`,
                opacity: 0.4 + amplitude * 0.6,
              }}
            />
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-600">
          Visual activity updates as the assistant and {effectiveState.parentName} exchange dialogue.
        </p>
      </div>

      <div className="px-4 py-3 bg-slate-50">
        <div className="text-xs uppercase tracking-[0.15em] text-slate-500 mb-2">Live Transcript</div>
        <div className="twilio-call-transcript max-h-72 overflow-auto rounded-xl border border-slate-900/10 bg-white px-3 py-2 space-y-2">
          {effectiveState.transcript.length === 0 && (
            <p className="text-sm text-slate-500">
              Transcript will stream here once the parent call starts.
            </p>
          )}
          {effectiveState.transcript.map((line) => (
            <div key={`${line.speaker}:${line.itemId}`} className="text-sm">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-0.5">
                {transcriptSpeakerLabel(line.speaker, effectiveState.parentName)}
              </div>
              <p
                className={
                  line.isFinal
                    ? "text-slate-900"
                    : "text-slate-700 italic opacity-85"
                }
              >
                {line.text || "..."}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("twilio-call-root");
if (root) {
  createRoot(root).render(<App />);
}
