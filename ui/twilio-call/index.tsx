import { useCallback, useEffect, useMemo, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  FileText,
  Loader2,
  Maximize2,
  MessageSquareText,
  PhoneCall,
} from "lucide-react";
import { useDisplayMode } from "../hooks/use-display-mode";
import { useWidgetProps } from "../hooks/use-widget-props";
import { useWidgetState } from "../hooks/use-widget-state";
import studentPortrait from "./student-profile-boy.png";
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
  reasonSummary?: string;
  contextFromChat?: string | null;
  absenceStats?: string | null;
  status: CallStatus;
  logsWsUrl: string | null;
  viewerToken?: string | null;
  reconnectSinceSeq?: number;
  errorMessage?: string;
};

type AttendanceRisk = "low" | "medium" | "high" | "unknown";

type CallSummaryOutput = {
  sessionId: string;
  status: CallStatus;
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  attendanceRisk: AttendanceRisk;
  source: "openai" | "heuristic";
  generatedAt: string;
  transcriptItems: number;
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
  reasonSummary: string;
  contextFromChat: string | null;
  absenceStats: string | null;
  waveHistory: number[];
  callSummary: CallSummaryOutput | null;
  summaryLoading: boolean;
  summaryError: string | null;
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
    }
  | {
      type: "audio.level";
      seq: number;
      speaker: "recipient" | "assistant";
      level: number;
      timestamp: string;
    };

const DEFAULT_STUDENT_NAME = "Sam";
const DEFAULT_PARENT_NAME = "Jerry";
const DEFAULT_PARENT_RELATIONSHIP = "father";
const DEFAULT_PARENT_NUMBER_LABEL = "Jerry's number on file";
const DEFAULT_REASON_SUMMARY = "Attendance follow-up call about recent absences.";
const WAVE_BAR_COUNT = 28;
const EMPTY_WAVE_HISTORY = Array.from({ length: WAVE_BAR_COUNT }, () => 0);
const TRANSCRIPT_SCROLL_FOLLOW_THRESHOLD_PX = 28;

const DEFAULT_TOOL_OUTPUT: WidgetToolOutput = {
  sessionId: null,
  displayNumber: DEFAULT_PARENT_NUMBER_LABEL,
  studentName: DEFAULT_STUDENT_NAME,
  parentName: DEFAULT_PARENT_NAME,
  parentRelationship: DEFAULT_PARENT_RELATIONSHIP,
  parentNumberLabel: DEFAULT_PARENT_NUMBER_LABEL,
  reasonSummary: DEFAULT_REASON_SUMMARY,
  contextFromChat: null,
  absenceStats: null,
  status: "ready",
  logsWsUrl: null,
  viewerToken: null,
  reconnectSinceSeq: 0,
};

function createEmptyWaveHistory(): number[] {
  return [...EMPTY_WAVE_HISTORY];
}

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

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
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

function asAttendanceRisk(value: unknown): AttendanceRisk | null {
  if (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "unknown"
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
  const reasonSummary = asString(candidate.reasonSummary) ?? DEFAULT_REASON_SUMMARY;
  const contextFromChat = asString(candidate.contextFromChat) ?? null;
  const absenceStats = asString(candidate.absenceStats) ?? null;

  return {
    sessionId,
    displayNumber,
    studentName,
    parentName,
    parentRelationship,
    parentNumberLabel,
    reasonSummary,
    contextFromChat,
    absenceStats,
    status,
    logsWsUrl,
    viewerToken,
    reconnectSinceSeq: asNumber(candidate.reconnectSinceSeq) ?? 0,
    errorMessage: asString(candidate.errorMessage) ?? undefined,
  };
}

function parseCallSummaryPayload(value: unknown): CallSummaryOutput | null {
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

  const found = candidate.found;
  if (found === false) {
    return null;
  }

  const sessionId = asString(candidate.sessionId);
  const status = asStatus(candidate.status);
  const summary = asString(candidate.summary);
  const risk = asAttendanceRisk(candidate.attendanceRisk);
  const source = candidate.source;

  if (
    !sessionId ||
    !status ||
    !summary ||
    !risk ||
    (source !== "openai" && source !== "heuristic")
  ) {
    return null;
  }

  return {
    sessionId,
    status,
    summary,
    keyPoints: asStringArray(candidate.keyPoints),
    actionItems: asStringArray(candidate.actionItems),
    attendanceRisk: risk,
    source,
    generatedAt: asString(candidate.generatedAt) ?? new Date().toISOString(),
    transcriptItems: asNumber(candidate.transcriptItems) ?? 0,
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

    if (eventType === "audio.level") {
      const speaker = asString(parsed.speaker);
      const level = asNumber(parsed.level);
      if (
        (speaker !== "recipient" && speaker !== "assistant") ||
        level == null
      ) {
        return null;
      }
      return {
        type: "audio.level",
        seq,
        speaker,
        level: Math.max(0, Math.min(1, level)),
        timestamp: asString(parsed.timestamp) ?? new Date().toISOString(),
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

function pushWaveLevel(history: number[], nextLevel: number): number[] {
  const clamped = Math.max(0, Math.min(1, nextLevel));
  const combined = [...history, clamped];
  if (combined.length <= WAVE_BAR_COUNT) {
    return combined;
  }
  return combined.slice(combined.length - WAVE_BAR_COUNT);
}

function transcriptFallbackLevel(text: string, isFinal: boolean): number {
  const normalizedLength = Math.min(1, text.trim().length / 48);
  const base = isFinal ? 0.26 : 0.18;
  return Math.min(1, base + normalizedLength * 0.68);
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

  if (event.type === "audio.level") {
    return {
      ...state,
      waveHistory: pushWaveLevel(state.waveHistory, event.level),
      lastSeq: event.seq,
      isConnecting: false,
    };
  }

  const updatedTranscript = [...state.transcript];
  const existingIndex = updatedTranscript.findIndex(
    (line) => line.itemId === event.itemId && line.speaker === event.speaker,
  );
  let fallbackLevel = 0;

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
    fallbackLevel = transcriptFallbackLevel(event.textDelta, false);
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
    fallbackLevel = transcriptFallbackLevel(event.fullText, true);
  }

  return {
    ...state,
    transcript: sortTranscript(updatedTranscript),
    waveHistory: pushWaveLevel(state.waveHistory, fallbackLevel),
    lastSeq: event.seq,
    isConnecting: false,
  };
}

function statusBadgeClass(status: CallStatus): string {
  if (status === "in-progress") {
    return "bg-emerald-50 text-emerald-700 border-emerald-200";
  }
  if (status === "ringing" || status === "queued") {
    return "bg-amber-50 text-amber-700 border-amber-200";
  }
  if (status === "completed") {
    return "bg-sky-50 text-sky-700 border-sky-200";
  }
  if (status === "failed") {
    return "bg-rose-50 text-rose-700 border-rose-200";
  }
  return "bg-white text-slate-700 border-slate-200";
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
  const displayMode = useDisplayMode();
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
    reasonSummary: toolOutput.reasonSummary ?? DEFAULT_REASON_SUMMARY,
    contextFromChat: toolOutput.contextFromChat ?? null,
    absenceStats: toolOutput.absenceStats ?? null,
    waveHistory: createEmptyWaveHistory(),
    callSummary: null,
    summaryLoading: false,
    summaryError: null,
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
      reasonSummary: toolOutput.reasonSummary ?? DEFAULT_REASON_SUMMARY,
      contextFromChat: toolOutput.contextFromChat ?? null,
      absenceStats: toolOutput.absenceStats ?? null,
      waveHistory: createEmptyWaveHistory(),
      callSummary: null,
      summaryLoading: false,
      summaryError: null,
    } as CallWidgetState);

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
  const summaryRequestedSessionRef = useRef<string | null>(null);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);
  const followTranscriptRef = useRef(true);

  useEffect(() => {
    lastSeqRef.current = effectiveState.lastSeq;
    statusRef.current = effectiveState.status;
    stateRef.current = effectiveState;
  }, [effectiveState]);

  const onTranscriptScroll = useCallback(() => {
    const container = transcriptContainerRef.current;
    if (!container) {
      return;
    }
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    followTranscriptRef.current =
      distanceFromBottom <= TRANSCRIPT_SCROLL_FOLLOW_THRESHOLD_PX;
  }, []);

  useEffect(() => {
    const container = transcriptContainerRef.current;
    if (!container || !followTranscriptRef.current) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [effectiveState.transcript, effectiveState.status]);

  const waveBars = useMemo(() => {
    if (effectiveState.waveHistory.length >= WAVE_BAR_COUNT) {
      return effectiveState.waveHistory;
    }
    return [
      ...createEmptyWaveHistory().slice(
        0,
        WAVE_BAR_COUNT - effectiveState.waveHistory.length,
      ),
      ...effectiveState.waveHistory,
    ];
  }, [effectiveState.waveHistory]);

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

  const requestCallSummary = useCallback(
    async (targetSessionId: string) => {
      setWidgetState((current) => ({
        ...(current ?? stateRef.current),
        summaryLoading: true,
        summaryError: null,
      }));

      try {
        const result = await window.openai?.callTool?.("summarise-call", {
          sessionId: targetSessionId,
        });
        const parsedSummary = parseCallSummaryPayload(result);
        if (!parsedSummary) {
          throw new Error("Unable to parse summarise-call result.");
        }

        setWidgetState((current) => ({
          ...(current ?? stateRef.current),
          callSummary: parsedSummary,
          summaryLoading: false,
          summaryError: null,
        }));
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Summary generation failed with an unknown error.";
        setWidgetState((current) => ({
          ...(current ?? stateRef.current),
          summaryLoading: false,
          summaryError: message,
        }));
      }
    },
    [setWidgetState],
  );

  useEffect(() => {
    if (!sessionId || !isTerminalStatus(effectiveState.status)) {
      return;
    }
    if (summaryRequestedSessionRef.current === sessionId) {
      return;
    }
    summaryRequestedSessionRef.current = sessionId;
    void requestCallSummary(sessionId);
  }, [effectiveState.status, requestCallSummary, sessionId]);

  const onStartCall = useCallback(async () => {
    summaryRequestedSessionRef.current = null;
    setWidgetState((current) => ({
      ...(current ?? stateRef.current),
      isConnecting: true,
      errorMessage: null,
      callSummary: null,
      summaryLoading: false,
      summaryError: null,
      waveHistory: createEmptyWaveHistory(),
    }));

    try {
      const result = await window.openai?.callTool?.("initiate-call", {
        reasonSummary: effectiveState.reasonSummary,
        contextFromChat: effectiveState.contextFromChat ?? undefined,
        absenceStats: effectiveState.absenceStats ?? undefined,
      });
      const parsed = parseCallStartPayload(result);

      if (!parsed) {
        throw new Error("Unable to parse initiate-call result.");
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
          reasonSummary: parsed.reasonSummary ?? base.reasonSummary,
          contextFromChat: parsed.contextFromChat ?? base.contextFromChat,
          absenceStats: parsed.absenceStats ?? base.absenceStats,
          waveHistory: createEmptyWaveHistory(),
          callSummary: null,
          summaryLoading: false,
          summaryError: null,
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
  }, [
    effectiveState.absenceStats,
    effectiveState.contextFromChat,
    effectiveState.reasonSummary,
    setWidgetState,
  ]);

  const canStartCall = useMemo(
    () =>
      !effectiveState.isConnecting &&
      !isTerminalStatus(effectiveState.status) &&
      effectiveState.status !== "in-progress" &&
      effectiveState.status !== "ringing" &&
      effectiveState.status !== "queued",
    [effectiveState.isConnecting, effectiveState.status],
  );

  const requestFullscreen = useCallback(async () => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      if (window.openai?.requestDisplayMode) {
        await window.openai.requestDisplayMode({ mode: "fullscreen" });
        return;
      }
      await window.webplus?.requestDisplayMode?.({ mode: "fullscreen" });
    } catch (error) {
      console.error("Failed to request fullscreen display mode", error);
    }
  }, []);

  return (
    <div className="class-pulse-theme twilio-call-widget antialiased w-full max-w-4xl mx-auto rounded-2xl overflow-hidden border">
      <div className="twilio-hero px-4 py-4 border-b border-slate-900/10">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-xs uppercase tracking-[0.16em] text-slate-600">Attendance Outreach</div>
            <div className="text-xl font-semibold text-slate-900">Parent Call Assistant</div>
          </div>
          <div className="flex items-center gap-2">
            {displayMode !== "fullscreen" && (
              <button
                type="button"
                className="twilio-expand-button"
                onClick={() => void requestFullscreen()}
                aria-label="Expand widget"
                title="Expand"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            )}
            <div
              className={`text-xs rounded-full border px-2.5 py-1 font-medium ${statusBadgeClass(
                effectiveState.status,
              )}`}
            >
              {effectiveState.status}
            </div>
          </div>
        </div>

        <div className="twilio-profile-panel rounded-xl border border-slate-900/10 bg-white/90 p-3 flex gap-3 items-start">
          <img
            src={studentPortrait}
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
            <div className="mt-2 rounded-lg border border-slate-900/10 bg-slate-50/90 p-2 text-xs text-slate-700 space-y-1">
              <div className="uppercase tracking-wide text-[10px] text-slate-500">Call Brief</div>
              <p className="leading-relaxed text-slate-800">{effectiveState.reasonSummary}</p>
              {effectiveState.contextFromChat && (
                <p className="leading-relaxed">
                  <span className="font-semibold text-slate-700">Context:</span>{" "}
                  {effectiveState.contextFromChat}
                </p>
              )}
              {effectiveState.absenceStats && (
                <p className="leading-relaxed">
                  <span className="font-semibold text-slate-700">Absence stats:</span>{" "}
                  {effectiveState.absenceStats}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="twilio-action-panel px-4 py-3 border-b border-slate-900/10">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="twilio-call-icon-button"
            disabled={!canStartCall}
            aria-label={`Call ${effectiveState.parentName}`}
            onClick={() => void onStartCall()}
            title={canStartCall ? `Call ${effectiveState.parentName}` : "Call unavailable"}
          >
            {effectiveState.isConnecting ? (
              <Loader2 className="h-5 w-5 twilio-spin" />
            ) : (
              <PhoneCall className="h-5 w-5" />
            )}
          </button>
          <div className="min-w-0">
            <p className="text-sm font-medium text-slate-900">
              {effectiveState.isConnecting
                ? "Connecting call..."
                : isTerminalStatus(effectiveState.status)
                  ? `Call ${effectiveState.status}`
                  : `Call ${effectiveState.parentName}`}
            </p>
            <p className="text-xs text-slate-600">
              {canStartCall
                ? "Start attendance follow-up call"
                : "Live updates appear automatically while the call is active."}
            </p>
          </div>
        </div>
        {effectiveState.errorMessage && (
          <p className="mt-2 text-xs text-rose-700">{effectiveState.errorMessage}</p>
        )}
      </div>

      <div className="twilio-section px-4 py-3 border-b border-slate-900/10">
        <div className="twilio-section-title">
          <Activity className="h-4 w-4" />
          <span>Live Interaction</span>
        </div>
        <div className="twilio-wave-chart" aria-label="Live conversation activity waveform">
          {waveBars.map((amplitude, index) => (
            <span
              key={`wave-${index}`}
              className="twilio-wave-bar"
              style={{
                height: `${Math.round(6 + amplitude * 42)}px`,
                opacity: 0.28 + amplitude * 0.72,
              }}
            />
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-600 twilio-caption">
          Real activity bars from live audio/transcript events between the assistant and{" "}
          {effectiveState.parentName}.
        </p>
      </div>

      <div className="twilio-section px-4 py-3 border-b border-slate-900/10">
        <div className="twilio-section-title">
          <MessageSquareText className="h-4 w-4" />
          <span>Live Transcript</span>
        </div>
        <div
          ref={transcriptContainerRef}
          onScroll={onTranscriptScroll}
          className="twilio-call-transcript max-h-72 overflow-auto rounded-xl border border-slate-900/10 bg-white px-3 py-2 space-y-2"
        >
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

      <div className="twilio-section px-4 py-3 twilio-summary-section">
        <div className="twilio-section-title">
          <FileText className="h-4 w-4" />
          <span>Call Summary</span>
        </div>

        {!isTerminalStatus(effectiveState.status) && (
          <p className="text-sm text-slate-600">
            Summary will generate automatically as soon as the call finishes.
          </p>
        )}

        {effectiveState.summaryLoading && (
          <div className="twilio-summary-loading">
            <Loader2 className="h-4 w-4 twilio-spin" />
            <span>Generating summary...</span>
          </div>
        )}

        {effectiveState.callSummary && (
          <div className="space-y-3">
            <p className="text-sm text-slate-900 leading-relaxed">
              {effectiveState.callSummary.summary}
            </p>

            {effectiveState.callSummary.keyPoints.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
                  Key Points
                </div>
                <ul className="space-y-1">
                  {effectiveState.callSummary.keyPoints.map((point, index) => (
                    <li key={`kp-${index}`} className="text-sm text-slate-800 twilio-list-row">
                      <CheckCircle2 className="h-3.5 w-3.5 mt-0.5" />
                      <span>{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {effectiveState.callSummary.actionItems.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">
                  Follow-up Actions
                </div>
                <ul className="space-y-1">
                  {effectiveState.callSummary.actionItems.map((item, index) => (
                    <li key={`action-${index}`} className="text-sm text-slate-800 twilio-list-row">
                      <CheckCircle2 className="h-3.5 w-3.5 mt-0.5" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-xs text-slate-500">
              Risk: {effectiveState.callSummary.attendanceRisk} · Source:{" "}
              {effectiveState.callSummary.source}
            </p>
          </div>
        )}

        {effectiveState.summaryError && (
          <div className="twilio-summary-error">
            <AlertCircle className="h-4 w-4 mt-0.5" />
            <span>{effectiveState.summaryError}</span>
          </div>
        )}

        {isTerminalStatus(effectiveState.status) &&
          !effectiveState.summaryLoading &&
          !effectiveState.callSummary &&
          sessionId && (
            <button
              type="button"
              className="twilio-secondary-button mt-2"
              onClick={() => {
                summaryRequestedSessionRef.current = sessionId;
                void requestCallSummary(sessionId);
              }}
            >
              Retry Summary
            </button>
          )}
      </div>
    </div>
  );
}

const root = document.getElementById("twilio-call-root");
if (root) {
  createRoot(root).render(<App />);
}
