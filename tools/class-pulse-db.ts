import path from "node:path";
import { runSqliteQuery } from "../utils/sqlite-bridge";

export type AttendanceStatus = "present" | "absent" | "unmarked";

export type ClassPulseStudent = {
  id: number;
  firstName: string;
  lastName: string;
  status: AttendanceStatus;
  markedAt: string;
};

export type ClassPulseRosterSummary = {
  total: number;
  present: number;
  absent: number;
  unmarked: number;
};

export type ClassPulseRosterPayload = {
  classDate: string;
  students: ClassPulseStudent[];
  summary: ClassPulseRosterSummary;
};

export type ClassPulseTrendPoint = {
  period: string;
  periodKey: string;
  attendancePct: number;
  gradeScore: number;
};

export type ClassPulseStudentTrend = {
  studentId: number;
  studentName: string;
  points: ClassPulseTrendPoint[];
};

export const CLASS_PULSE_DB_PATH = path.resolve(
  process.cwd(),
  "samples/sqlite/class-pulse.db",
);

const ROSTER_QUERY = `
  SELECT
    s.id,
    s.first_name AS firstName,
    s.last_name AS lastName,
    COALESCE(a.status, 'unmarked') AS status,
    COALESCE(a.marked_at, '') AS markedAt
  FROM students s
  LEFT JOIN attendance a
    ON a.student_id = s.id
    AND a.class_date = :classDate
  WHERE s.is_active = 1
  ORDER BY
    CASE
      WHEN lower(trim(s.first_name || ' ' || s.last_name)) = 'sam altman' THEN 0
      WHEN lower(trim(s.first_name || ' ' || s.last_name)) = 'chelsea hu' THEN 1
      ELSE 2
    END,
    s.last_name COLLATE NOCASE,
    s.first_name COLLATE NOCASE
`;

const UPSERT_ATTENDANCE_QUERY = `
  INSERT INTO attendance (
    student_id,
    class_date,
    status,
    marked_at
  ) VALUES (
    :studentId,
    :classDate,
    :status,
    datetime('now')
  )
  ON CONFLICT(student_id, class_date) DO UPDATE SET
    status = excluded.status,
    marked_at = excluded.marked_at
`;

const ADD_STUDENT_QUERY = `
  INSERT INTO students (
    first_name,
    last_name,
    is_active,
    created_at
  ) VALUES (
    :firstName,
    :lastName,
    1,
    datetime('now')
  )
`;

const REMOVE_STUDENT_QUERY = `
  DELETE FROM students
  WHERE id = :studentId
`;

const STUDENT_LOOKUP_QUERY = `
  SELECT
    id,
    first_name AS firstName,
    last_name AS lastName
  FROM students
  WHERE id = :studentId
    AND is_active = 1
  LIMIT 1
`;

const STUDENT_TREND_QUERY = `
  WITH RECURSIVE months(offset, month_start) AS (
    SELECT
      0,
      date('now', 'start of month', printf('-%d months', :months - 1))
    UNION ALL
    SELECT
      offset + 1,
      date(month_start, '+1 month')
    FROM months
    WHERE offset + 1 < :months
  ),
  attendance_by_month AS (
    SELECT
      strftime('%Y-%m', class_date) AS periodKey,
      ROUND(
        100.0 * SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) / COUNT(*),
        1
      ) AS attendancePct
    FROM attendance
    WHERE student_id = :studentId
      AND class_date >= date('now', 'start of month', printf('-%d months', :months - 1))
      AND class_date < date('now', 'start of month', '+1 month')
    GROUP BY strftime('%Y-%m', class_date)
  ),
  grades_by_month AS (
    SELECT
      grade_month AS periodKey,
      ROUND(AVG(grade_score), 1) AS gradeScore
    FROM student_grades
    WHERE student_id = :studentId
      AND grade_month >= strftime('%Y-%m', date('now', 'start of month', printf('-%d months', :months - 1)))
      AND grade_month <= strftime('%Y-%m', date('now', 'start of month'))
    GROUP BY grade_month
  )
  SELECT
    strftime('%Y-%m', months.month_start) AS periodKey,
    COALESCE(attendance_by_month.attendancePct, 0) AS attendancePct,
    COALESCE(grades_by_month.gradeScore, 0) AS gradeScore
  FROM months
  LEFT JOIN attendance_by_month
    ON attendance_by_month.periodKey = strftime('%Y-%m', months.month_start)
  LEFT JOIN grades_by_month
    ON grades_by_month.periodKey = strftime('%Y-%m', months.month_start)
  ORDER BY months.month_start
`;

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseHtmlRows(rawHtml: string): string[][] {
  const tableMatch = rawHtml.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];

  const rowsMatch = tableMatch[1].match(/<tr>([\s\S]*?)<\/tr>/gi);
  if (!rowsMatch) return [];

  return rowsMatch.map((row) => {
    const colsMatch = row.match(/<t[hd]>([\s\S]*?)<\/t[hd]>/gi);
    if (!colsMatch) return [];
    return colsMatch.map((col) => {
      const match = col.match(/<t[hd]>([\s\S]*?)<\/t[hd]>/i);
      const value = match?.[1] ?? "";
      return decodeHtml(value.replace(/<[^>]+>/g, ""));
    });
  });
}

function normalizeClassDate(input?: string): string {
  const maybeDate = input?.trim();
  if (maybeDate && /^\d{4}-\d{2}-\d{2}$/.test(maybeDate)) {
    return maybeDate;
  }
  return new Date().toISOString().slice(0, 10);
}

function coerceAttendanceStatus(value: string): AttendanceStatus {
  if (value === "present" || value === "absent") {
    return value;
  }
  return "unmarked";
}

function normalizeMonthLabel(periodKey: string): string {
  const parts = periodKey.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return periodKey;
  }
  return new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

export function getClassPulseRoster(classDate?: string): {
  classDate: string;
  students: ClassPulseStudent[];
} {
  const normalizedDate = normalizeClassDate(classDate);
  const result = runSqliteQuery(ROSTER_QUERY, {
    sqliteFile: CLASS_PULSE_DB_PATH,
    parameters: { classDate: normalizedDate },
    write: false,
  });
  const rows = parseHtmlRows(result.text);
  if (rows.length === 0) {
    return { classDate: normalizedDate, students: [] };
  }
  const headers = rows[0].map((value) => value.toLowerCase());
  const bodyRows = rows.slice(1);
  const idxId = headers.indexOf("id");
  const idxFirstName = headers.indexOf("firstname");
  const idxLastName = headers.indexOf("lastname");
  const idxStatus = headers.indexOf("status");
  const idxMarkedAt = headers.indexOf("markedat");

  const students: ClassPulseStudent[] = [];
  for (const row of bodyRows) {
    const id = Number(row[idxId]);
    if (!Number.isFinite(id) || id <= 0) {
      continue;
    }
    students.push({
      id,
      firstName: row[idxFirstName] ?? "",
      lastName: row[idxLastName] ?? "",
      status: coerceAttendanceStatus(row[idxStatus] ?? "unmarked"),
      markedAt: row[idxMarkedAt] ?? "",
    });
  }

  return {
    classDate: normalizedDate,
    students,
  };
}

export function markClassPulseAttendance(args: {
  studentId: number;
  classDate?: string;
  status: AttendanceStatus;
}) {
  const normalizedDate = normalizeClassDate(args.classDate);
  const normalizedStudentId = Number(args.studentId);
  if (!Number.isFinite(normalizedStudentId) || normalizedStudentId <= 0) {
    throw new Error("studentId must be a positive number.");
  }
  if (args.status !== "present" && args.status !== "absent") {
    throw new Error("status must be either present or absent.");
  }

  runSqliteQuery(UPSERT_ATTENDANCE_QUERY, {
    sqliteFile: CLASS_PULSE_DB_PATH,
    write: true,
    parameters: {
      studentId: normalizedStudentId,
      classDate: normalizedDate,
      status: args.status,
    },
  });

  return getClassPulseRoster(normalizedDate);
}

export function addClassPulseStudent(args: { firstName: string; lastName: string }) {
  const firstName = args.firstName.trim();
  const lastName = args.lastName.trim();
  if (!firstName || !lastName) {
    throw new Error("firstName and lastName are required.");
  }

  runSqliteQuery(ADD_STUDENT_QUERY, {
    sqliteFile: CLASS_PULSE_DB_PATH,
    write: true,
    parameters: { firstName, lastName },
  });
}

export function removeClassPulseStudent(args: { studentId: number }) {
  const studentId = Number(args.studentId);
  if (!Number.isFinite(studentId) || studentId <= 0) {
    throw new Error("studentId must be a positive number.");
  }

  runSqliteQuery(REMOVE_STUDENT_QUERY, {
    sqliteFile: CLASS_PULSE_DB_PATH,
    write: true,
    parameters: { studentId },
  });
}

export function getClassPulseStudentTrend(args: {
  studentId: number;
  months?: number;
}): ClassPulseStudentTrend {
  const studentId = Number(args.studentId);
  if (!Number.isFinite(studentId) || studentId <= 0) {
    throw new Error("studentId must be a positive number.");
  }

  const months = Math.max(3, Math.min(24, Math.floor(args.months ?? 9)));
  const studentLookup = runSqliteQuery(STUDENT_LOOKUP_QUERY, {
    sqliteFile: CLASS_PULSE_DB_PATH,
    parameters: { studentId },
    write: false,
  });
  const studentRows = parseHtmlRows(studentLookup.text);
  if (studentRows.length < 2) {
    throw new Error(`Student ${studentId} was not found in the active roster.`);
  }

  const studentHeaders = studentRows[0].map((value) => value.toLowerCase());
  const student = studentRows[1];
  const idxFirstName = studentHeaders.indexOf("firstname");
  const idxLastName = studentHeaders.indexOf("lastname");
  const studentName = `${student[idxFirstName] ?? ""} ${student[idxLastName] ?? ""}`.trim();

  const trendResult = runSqliteQuery(STUDENT_TREND_QUERY, {
    sqliteFile: CLASS_PULSE_DB_PATH,
    parameters: {
      studentId,
      months,
    },
    write: false,
  });
  const trendRows = parseHtmlRows(trendResult.text);
  if (trendRows.length < 2) {
    return {
      studentId,
      studentName: studentName || `Student ${studentId}`,
      points: [],
    };
  }

  const trendHeaders = trendRows[0].map((value) => value.toLowerCase());
  const idxPeriodKey = trendHeaders.indexOf("periodkey");
  const idxAttendance = trendHeaders.indexOf("attendancepct");
  const idxGrade = trendHeaders.indexOf("gradescore");

  const points: ClassPulseTrendPoint[] = trendRows.slice(1).map((row) => {
    const periodKey = row[idxPeriodKey] ?? "";
    const attendancePct = Number(row[idxAttendance] ?? 0);
    const gradeScore = Number(row[idxGrade] ?? 0);

    return {
      periodKey,
      period: normalizeMonthLabel(periodKey),
      attendancePct: Number.isFinite(attendancePct) ? attendancePct : 0,
      gradeScore: Number.isFinite(gradeScore) ? gradeScore : 0,
    };
  });

  return {
    studentId,
    studentName: studentName || `Student ${studentId}`,
    points,
  };
}

export function summarizeRoster(students: ClassPulseStudent[]): ClassPulseRosterSummary {
  const summary = {
    present: 0,
    absent: 0,
    unmarked: 0,
  };

  for (const student of students) {
    if (student.status === "present") {
      summary.present += 1;
    } else if (student.status === "absent") {
      summary.absent += 1;
    } else {
      summary.unmarked += 1;
    }
  }

  return {
    total: students.length,
    ...summary,
  };
}

export function createRosterPayload(classDate?: string, students?: ClassPulseStudent[]): ClassPulseRosterPayload {
  const normalizedDate = normalizeClassDate(classDate);
  const roster = students ?? getClassPulseRoster(normalizedDate).students;
  return {
    classDate: normalizedDate,
    students: roster,
    summary: summarizeRoster(roster),
  };
}
