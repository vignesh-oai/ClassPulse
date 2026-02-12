type LogDetails = Record<string, unknown> | undefined;

function now(): string {
  return new Date().toISOString();
}

function verboseEnabled(): boolean {
  const value = process.env.CALL_DEBUG_VERBOSE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function emit(level: "INFO" | "WARN" | "ERROR" | "DEBUG", message: string, details?: LogDetails): void {
  const prefix = `[call-debug] ${now()} ${level}`;
  if (details && Object.keys(details).length > 0) {
    console.log(`${prefix} ${message}`, details);
    return;
  }
  console.log(`${prefix} ${message}`);
}

export function logInfo(message: string, details?: LogDetails): void {
  emit("INFO", message, details);
}

export function logWarn(message: string, details?: LogDetails): void {
  emit("WARN", message, details);
}

export function logError(message: string, details?: LogDetails): void {
  emit("ERROR", message, details);
}

export function logDebug(message: string, details?: LogDetails): void {
  if (!verboseEnabled()) {
    return;
  }
  emit("DEBUG", message, details);
}

export function redactPhone(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  const digits = raw.replace(/\D/g, "");
  if (digits.length <= 4) {
    return raw;
  }
  return `***${digits.slice(-4)}`;
}

export function truncate(value: string | null | undefined, maxChars = 120): string | null {
  if (!value) {
    return null;
  }
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}…`;
}
