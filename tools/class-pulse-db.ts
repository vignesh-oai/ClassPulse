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
  ORDER BY s.last_name COLLATE NOCASE, s.first_name COLLATE NOCASE
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
