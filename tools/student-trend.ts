import { z } from "zod/v3";
import { defineTool } from "../utils/define-tool";
import { getClassPulseStudentTrend } from "./class-pulse-db";

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function correlation(xs: number[], ys: number[]): number {
  const mx = mean(xs);
  const my = mean(ys);

  let numerator = 0;
  let dx = 0;
  let dy = 0;

  for (let i = 0; i < xs.length; i += 1) {
    const xv = xs[i] - mx;
    const yv = ys[i] - my;
    numerator += xv * yv;
    dx += xv * xv;
    dy += yv * yv;
  }

  if (dx === 0 || dy === 0) return 0;
  return numerator / Math.sqrt(dx * dy);
}

function describeSignal(attendanceDelta: number, gradeDelta: number): string {
  if (attendanceDelta > 1.2 && gradeDelta > 1.2) {
    return "Upward momentum";
  }
  if (attendanceDelta < -1.2 && gradeDelta < -1.2) {
    return "Concerning decline";
  }
  if (gradeDelta > 1.5 && attendanceDelta <= 1.2) {
    return "Grades recovering";
  }
  if (attendanceDelta > 1.5 && gradeDelta <= 1.2) {
    return "Attendance improving";
  }
  return "Mixed but stable";
}

const studentTrendInput = z.object({
  studentId: z.coerce
    .number()
    .int()
    .positive()
    .describe("Numeric student id (for example: 12)."),
});

export default defineTool({
  name: "student-trend",
  title: "Student Attendance vs Grades Trend",
  description:
    "Render a trend analysis chart showing attendance percentage and grade progression for a student.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  input: studentTrendInput,
  ui: "student-trend",
  invoking: "Analyzing student trend",
  invoked: "Trend analysis ready",
  async handler(input) {
    const trend = getClassPulseStudentTrend({
      studentId: input.studentId,
      months: 9,
    });
    const points = trend.points;
    if (points.length === 0) {
      return {
        content: [{ type: "text", text: `No attendance and grade history found for student ${trend.studentId}.` }],
        structuredContent: {
          studentId: trend.studentId,
          studentName: trend.studentName,
          points: [],
          analysis: {
            averageAttendance: 0,
            averageGrade: 0,
            attendanceDelta: 0,
            gradeDelta: 0,
            relationship: 0,
            signal: "No data",
          },
        },
      };
    }

    const attendanceSeries = points.map((point) => point.attendancePct);
    const gradeSeries = points.map((point) => point.gradeScore);

    const averageAttendance = round1(mean(attendanceSeries));
    const averageGrade = round1(mean(gradeSeries));
    const attendanceDelta = round1(
      attendanceSeries[attendanceSeries.length - 1] - attendanceSeries[0],
    );
    const gradeDelta = round1(gradeSeries[gradeSeries.length - 1] - gradeSeries[0]);
    const relationship = round1(correlation(attendanceSeries, gradeSeries));
    const signal = describeSignal(attendanceDelta, gradeDelta);

    const summary = `Analyzed ${points.length} months for ${trend.studentName} (ID ${trend.studentId}). Attendance ${attendanceDelta >= 0 ? "up" : "down"} ${Math.abs(attendanceDelta)} points and grades ${gradeDelta >= 0 ? "up" : "down"} ${Math.abs(gradeDelta)} points.`;

    return {
      content: [{ type: "text", text: summary }],
      structuredContent: {
        studentId: trend.studentId,
        studentName: trend.studentName,
        points,
        analysis: {
          averageAttendance,
          averageGrade,
          attendanceDelta,
          gradeDelta,
          relationship,
          signal,
        },
      },
    };
  },
});
