import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@openai/apps-sdk-ui/components/Button";
import { useWidgetProps } from "../hooks/use-widget-props";
import { CalendarDays, Check, LineChart, Loader2, PlusCircle, Trash2, X } from "lucide-react";

type ClassPulseStudent = {
  id: number;
  firstName: string;
  lastName: string;
  status: "present" | "absent" | "unmarked";
  markedAt: string;
};

type ClassPulseSummary = {
  total: number;
  present: number;
  absent: number;
  unmarked: number;
};

type ClassPulsePayload = {
  classDate: string;
  students: ClassPulseStudent[];
  summary: ClassPulseSummary;
};

function normalizePayload(
  payload?: Partial<ClassPulsePayload> | null,
): ClassPulsePayload {
  const today = new Date().toISOString().slice(0, 10);
  const students = Array.isArray(payload?.students) ? payload.students : [];
  const summary = payload?.summary ?? {
    total: students.length,
    present: 0,
    absent: 0,
    unmarked: 0,
  };

  return {
    classDate:
      payload?.classDate && /^\d{4}-\d{2}-\d{2}$/.test(payload.classDate)
        ? payload.classDate
        : today,
    students: students.map((student) => ({
      id: Number(student?.id) || 0,
      firstName: student?.firstName || "Unknown",
      lastName: student?.lastName || "Student",
      status:
        student?.status === "present" || student?.status === "absent"
          ? student.status
          : "unmarked",
      markedAt: student?.markedAt || "",
    })),
    summary: {
      total: summary.total ?? students.length,
      present: summary.present ?? 0,
      absent: summary.absent ?? 0,
      unmarked: summary.unmarked ?? 0,
    },
  };
}

function parseToolPayload(raw: unknown): ClassPulsePayload | null {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed === "object" &&
        "students" in parsed &&
        "summary" in parsed
      ) {
        return normalizePayload(parsed as Partial<ClassPulsePayload>);
      }
    } catch {
      return null;
    }
  }

  if (typeof raw === "object" && raw !== null) {
    if ("students" in raw && "summary" in raw) {
      return normalizePayload(raw as Partial<ClassPulsePayload>);
    }
  }
  return null;
}

function rowTone(status: ClassPulseStudent["status"]) {
  if (status === "present") {
    return {
      rowBg: "var(--cp-present-bg)",
      border: "var(--cp-present-border)",
      accent: "var(--cp-present-accent)",
      dot: "var(--cp-present-accent)",
    } as const;
  }
  if (status === "absent") {
    return {
      rowBg: "var(--cp-absent-bg)",
      border: "var(--cp-absent-border)",
      accent: "var(--cp-absent-accent)",
      dot: "var(--cp-absent-accent)",
    } as const;
  }
  return {
    rowBg: "var(--cp-unmarked-bg)",
    border: "var(--cp-unmarked-border)",
    accent: "var(--cp-unmarked-accent)",
    dot: "var(--cp-unmarked-accent)",
  } as const;
}

function getButtonVariant(
  status: ClassPulseStudent["status"],
  target: "present" | "absent",
) {
  if (status === target) {
    return "solid";
  }
  if (status === "unmarked") {
    return "soft";
  }
  return "ghost";
}

function actionButtonClass(
  status: ClassPulseStudent["status"],
  action: "present" | "absent",
  isBusy: boolean,
) {
  if (isBusy) {
    return "bg-slate-100 text-slate-500 border border-slate-200";
  }
  if (status === action) {
    return action === "present"
      ? "bg-emerald-600 text-white border border-emerald-700 shadow-sm"
      : "bg-rose-600 text-white border border-rose-700 shadow-sm";
  }
  return action === "present"
    ? "bg-emerald-50 text-emerald-700 border border-emerald-200 hover:bg-emerald-100"
    : "bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100";
}

function App() {
  const toolPayload = useWidgetProps<Partial<ClassPulsePayload>>({});
  const [payload, setPayload] = useState<ClassPulsePayload>(() =>
    normalizePayload(toolPayload),
  );
  const [isBusyId, setIsBusyId] = useState<number | null>(null);
  const [isTrendBusyId, setIsTrendBusyId] = useState<number | null>(null);
  const [isBulkRemoving, setIsBulkRemoving] = useState(false);
  const [isRemovalMode, setIsRemovalMode] = useState(false);
  const [selectedRemovalIds, setSelectedRemovalIds] = useState<Set<number>>(new Set());
  const [newFirstName, setNewFirstName] = useState("");
  const [newLastName, setNewLastName] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPayload(normalizePayload(toolPayload));
  }, [toolPayload]);

  const openAi = window?.openai;
  const callTool = useCallback(
    async (name: string, args: Record<string, unknown>) => {
      if (typeof openAi?.callTool !== "function") {
        throw new Error("openai.callTool is not available in this host.");
      }
      const response = await openAi.callTool(name, args);
      return response.result ?? null;
    },
    [openAi],
  );

  const clearRemovalState = useCallback(() => {
    setIsRemovalMode(false);
    setSelectedRemovalIds(new Set());
  }, []);

  const refreshRoster = useCallback(
    async (classDate: string) => {
      const result = await callTool("class-pulse-roster", { classDate });
      const nextPayload = parseToolPayload(result);
      if (nextPayload) {
        setPayload(nextPayload);
      }
    },
    [callTool],
  );

  const handleMarkAttendance = useCallback(
    async (student: ClassPulseStudent, status: "present" | "absent") => {
      if (isRemovalMode) {
        setError("Finish or cancel remove selection before changing attendance.");
        return;
      }
      setIsBusyId(student.id);
      setError(null);
      try {
        const result = await callTool("class-pulse-mark-attendance", {
          studentId: student.id,
          classDate: payload.classDate,
          status,
        });
        const nextPayload = parseToolPayload(result);
        if (nextPayload) {
          setPayload(nextPayload);
          return;
        }
        setPayload((current) => ({
          ...current,
          students: current.students.map((item) =>
            item.id === student.id
              ? {
                  ...item,
                  status,
                  markedAt: new Date().toLocaleTimeString(),
                }
              : item,
          ),
        }));
      } catch (error_) {
        setError(
          error_ instanceof Error
            ? error_.message
            : "Failed to mark attendance.",
        );
      } finally {
        setIsBusyId(null);
      }
    },
    [callTool, isRemovalMode, payload.classDate],
  );

  const handleShowStudentTrend = useCallback(
    async (student: ClassPulseStudent) => {
      setIsTrendBusyId(student.id);
      setError(null);
      try {
        if (typeof openAi?.sendFollowUpMessage !== "function") {
          throw new Error("openai.sendFollowUpMessage is not available in this host.");
        }
        const studentName = `${student.firstName} ${student.lastName}`.trim();
        await openAi.sendFollowUpMessage({
          prompt: `Show me ${studentName} Student Attendance vs Grades Trend. Use the student-trend tool with studentId ${student.id} and render its widget.`,
        });
      } catch (error_) {
        setError(
          error_ instanceof Error
            ? error_.message
            : "Failed to load student trend.",
        );
      } finally {
        setIsTrendBusyId(null);
      }
    },
    [openAi],
  );

  const addStudent = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const firstName = newFirstName.trim();
      const lastName = newLastName.trim();
      if (!firstName || !lastName) {
        setError("First and last names are required.");
        return;
      }

      setIsAdding(true);
      setError(null);
      clearRemovalState();
      try {
        const result = await callTool("class-pulse-add-student", {
          firstName,
          lastName,
          classDate: payload.classDate,
        });
        const nextPayload = parseToolPayload(result);
        if (nextPayload) {
          setPayload(nextPayload);
        } else {
          await refreshRoster(payload.classDate);
        }
        setNewFirstName("");
        setNewLastName("");
      } catch (error_) {
        setError(
          error_ instanceof Error ? error_.message : "Failed to add student.",
        );
      } finally {
        setIsAdding(false);
      }
    },
    [callTool, clearRemovalState, newFirstName, newLastName, payload.classDate, refreshRoster],
  );

  const handleDateChange = useCallback(
    async (classDate: string) => {
      setPayload((current) => ({ ...current, classDate }));
      clearRemovalState();
      await refreshRoster(classDate);
    },
    [clearRemovalState, refreshRoster],
  );

  const toggleStudentForRemoval = useCallback((studentId: number) => {
    setSelectedRemovalIds((previous) => {
      const next = new Set(previous);
      if (next.has(studentId)) {
        next.delete(studentId);
      } else {
        next.add(studentId);
      }
      return next;
    });
  }, []);

  const confirmRemoveStudents = useCallback(async () => {
    if (selectedRemovalIds.size === 0) {
      return;
    }

    setError(null);
    setIsBulkRemoving(true);
    const ids = Array.from(selectedRemovalIds);
    try {
      await Promise.all(
        ids.map((studentId) =>
          callTool("class-pulse-remove-student", {
            studentId,
            classDate: payload.classDate,
          }),
        ),
      );
      await refreshRoster(payload.classDate);
      setSelectedRemovalIds(new Set());
      setIsRemovalMode(false);
    } catch (error_) {
      setError(
        error_ instanceof Error ? error_.message : "Failed to remove selected students.",
      );
      await refreshRoster(payload.classDate);
    } finally {
      setIsBulkRemoving(false);
    }
  }, [callTool, payload.classDate, refreshRoster, selectedRemovalIds]);

  const title = useMemo(() => `Class Pulse · ${payload.classDate}`, [payload.classDate]);

  return (
    <div
      className="class-pulse-theme antialiased w-full max-w-4xl mx-auto"
      style={{ color: "var(--cp-text)" }}
    >
      <div
        className="rounded-2xl border overflow-hidden"
        style={{
          borderColor: "var(--cp-border-strong)",
          backgroundColor: "var(--cp-bg-card)",
          boxShadow: "var(--cp-shadow-card)",
        }}
      >
        <div
          className="px-5 py-4 sm:px-6 border-b"
          style={{ borderColor: "var(--cp-border)", backgroundColor: "var(--cp-bg-muted)" }}
        >
          <div className="flex flex-col gap-2">
            <div className="inline-flex items-center gap-2 text-lg font-semibold">
              <CalendarDays className="h-5 w-5 text-emerald-700" aria-hidden="true" />
              {title}
            </div>
            <div className="text-sm" style={{ color: "var(--cp-text-muted)" }}>
              Build your day: mark attendance quickly and add new students for the roster.
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <label className="text-sm" style={{ color: "var(--cp-text-muted)" }} htmlFor="classDate">
              Class date
            </label>
            <input
              id="classDate"
              type="date"
              className="rounded-lg border px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
              style={{
                borderColor: "var(--cp-border-strong)",
                backgroundColor: "var(--cp-bg-card)",
              }}
              value={payload.classDate}
              onChange={(event) => handleDateChange(event.target.value)}
            />
            <div className="sm:ml-auto flex items-center gap-2">
              {!isRemovalMode ? (
                <Button
                  color="secondary"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    clearRemovalState();
                    setIsRemovalMode(true);
                  }}
                  className="inline-flex items-center gap-1.5 border"
                  style={{
                    backgroundColor: "var(--cp-bg-card)",
                    borderColor: "var(--cp-border)",
                  }}
                  aria-label="Enter remove mode"
                >
                  <Trash2 className="h-4 w-4" />
                  Remove
                </Button>
              ) : (
                <>
                  <span className="text-xs" style={{ color: "var(--cp-text-muted)" }}>
                    {selectedRemovalIds.size} selected
                  </span>
                  <Button
                    color="danger"
                    variant="solid"
                    size="sm"
                    onClick={confirmRemoveStudents}
                    disabled={selectedRemovalIds.size === 0 || isBulkRemoving}
                    className="inline-flex items-center gap-1.5"
                    aria-label="Confirm selected student removals"
                  >
                    <Trash2 className="h-4 w-4" />
                    {isBulkRemoving
                      ? "Removing..."
                      : `Confirm remove (${selectedRemovalIds.size})`}
                  </Button>
                  <Button
                    color="secondary"
                    variant="outline"
                    size="sm"
                    onClick={clearRemovalState}
                    disabled={isBulkRemoving}
                  >
                    Cancel
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>

        <div className="px-4 py-3 sm:px-5" style={{ backgroundColor: "var(--cp-bg-app)" }}>
          <div className="mb-3 flex items-center gap-3 text-sm">
            <span className="rounded-full px-3 py-1 border text-emerald-800 shadow-sm bg-emerald-50 border-emerald-200">
              Present {payload.summary.present}
            </span>
            <span className="rounded-full px-3 py-1 border text-rose-800 shadow-sm bg-rose-50 border-rose-200">
              Absent {payload.summary.absent}
            </span>
            <span className="rounded-full px-3 py-1 border text-amber-800 shadow-sm bg-amber-50 border-amber-200">
              Unmarked {payload.summary.unmarked}
            </span>
            <span
              className="rounded-full px-3 py-1 border ml-auto shadow-sm"
              style={{
                backgroundColor: "var(--cp-bg-card)",
                borderColor: "var(--cp-border)",
              }}
            >
              Total {payload.summary.total}
            </span>
          </div>

          {error ? <div className="mb-3 text-sm text-rose-700">{error}</div> : null}

          <div className="space-y-2">
            {payload.students.map((student) => {
              const tone = rowTone(student.status);
              const isSelectedForRemoval = selectedRemovalIds.has(student.id);
              return (
                <div
                  key={student.id}
                  className="rounded-xl border border-l-4 px-3 py-2.5 flex items-center gap-3 shadow-sm transition-all"
                  style={{
                    backgroundColor: tone.rowBg,
                    borderColor: tone.border,
                    borderLeftColor: tone.accent,
                  }}
                >
                  {isRemovalMode ? (
                    <button
                      type="button"
                      aria-label={`Select ${student.firstName} ${student.lastName} for removal`}
                      aria-pressed={isSelectedForRemoval}
                      onClick={() => toggleStudentForRemoval(student.id)}
                      className="h-5 w-5 rounded-md border flex items-center justify-center shrink-0 transition-colors"
                      style={{
                        borderColor: isSelectedForRemoval
                          ? "var(--cp-absent-accent)"
                          : "var(--cp-border-strong)",
                        backgroundColor: isSelectedForRemoval
                          ? "var(--cp-absent-accent)"
                          : "var(--cp-bg-card)",
                        color: isSelectedForRemoval ? "#ffffff" : "transparent",
                      }}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                  <div
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: tone.dot }}
                  />
                  <div
                    className="h-9 w-9 rounded-full flex items-center justify-center text-sm font-semibold"
                    style={{ backgroundColor: "var(--cp-bg-muted)", color: "var(--cp-text)" }}
                  >
                    {student.firstName[0]}
                    {student.lastName[0]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">
                      {student.firstName} {student.lastName}
                    </div>
                    <div className="text-xs" style={{ color: "var(--cp-text-muted)" }}>
                      {student.markedAt
                        ? `Last marked ${student.markedAt}`
                        : "Not marked"}
                    </div>
                  </div>
                  {!isRemovalMode ? (
                    <div className="flex items-center gap-2">
                      <Button
                        color="secondary"
                        variant={getButtonVariant(student.status, "present")}
                        size="sm"
                        onClick={() => handleMarkAttendance(student, "present")}
                        disabled={isBusyId === student.id}
                        aria-label={`Set ${student.firstName} ${student.lastName} present`}
                        className={actionButtonClass(
                          student.status,
                          "present",
                          isBusyId === student.id,
                        )}
                      >
                        {isBusyId === student.id ? (
                          "Saving..."
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <Check className="h-3.5 w-3.5" />
                            Present
                          </span>
                        )}
                      </Button>
                      <Button
                        color="secondary"
                        variant={getButtonVariant(student.status, "absent")}
                        size="sm"
                        onClick={() => handleMarkAttendance(student, "absent")}
                        disabled={isBusyId === student.id}
                        aria-label={`Set ${student.firstName} ${student.lastName} absent`}
                        className={actionButtonClass(
                          student.status,
                          "absent",
                          isBusyId === student.id,
                        )}
                      >
                        {isBusyId === student.id ? (
                          "Saving..."
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <X className="h-3.5 w-3.5" />
                            Absent
                          </span>
                        )}
                      </Button>
                      {student.status === "absent" ? (
                        <Button
                          color="secondary"
                          variant="ghost"
                          size="sm"
                          onClick={() => handleShowStudentTrend(student)}
                          disabled={isTrendBusyId === student.id}
                          aria-label={`Show me ${student.firstName} ${student.lastName} Student Attendance vs Grades Trend`}
                          title={`Show me ${student.firstName} ${student.lastName} Student Attendance vs Grades Trend`}
                          className="border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                        >
                          {isTrendBusyId === student.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <LineChart className="h-3.5 w-3.5" />
                          )}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {payload.students.length === 0 ? (
              <div
                className="rounded-xl border border-dashed px-3 py-6 text-center text-sm bg-white"
                style={{ borderColor: "var(--cp-border)", color: "var(--cp-text-muted)" }}
              >
                No students loaded for this date. Add students below to build the
                roster.
              </div>
            ) : null}
          </div>
        </div>

        <form
          className="border-t px-4 py-4 sm:px-5 flex flex-col sm:flex-row gap-2 sm:items-end"
          style={{ borderColor: "var(--cp-border)", backgroundColor: "var(--cp-bg-muted)" }}
          onSubmit={addStudent}
        >
          <div className="flex-1 min-w-0">
            <label className="text-xs font-medium" style={{ color: "var(--cp-text-muted)" }} htmlFor="firstName">
              First name
            </label>
            <input
              id="firstName"
              value={newFirstName}
              onChange={(event) => setNewFirstName(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
              style={{ borderColor: "var(--cp-border-strong)" }}
              placeholder="First"
            />
          </div>
          <div className="flex-1 min-w-0">
            <label className="text-xs font-medium" style={{ color: "var(--cp-text-muted)" }} htmlFor="lastName">
              Last name
            </label>
            <input
              id="lastName"
              value={newLastName}
              onChange={(event) => setNewLastName(event.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300"
              style={{ borderColor: "var(--cp-border-strong)" }}
              placeholder="Last"
            />
          </div>
          <Button
            type="submit"
            color="primary"
            variant="solid"
            size="sm"
            disabled={isAdding}
            className="bg-emerald-700 text-white border border-emerald-800 hover:bg-emerald-600"
          >
            {isAdding ? (
              "Adding..."
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <PlusCircle className="h-4 w-4" />
                Add student
              </span>
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}

const root = document.getElementById("class-pulse-roster-root");
if (root) {
  createRoot(root).render(<App />);
}
