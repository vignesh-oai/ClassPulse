import { z } from "zod/v3";
import { defineTool } from "../utils/define-tool";
import {
  createRosterPayload,
  markClassPulseAttendance,
} from "./class-pulse-db";

const classPulseMarkAttendanceInput = z.object({
  studentId: z.coerce
    .number()
    .int()
    .positive()
    .describe("Numeric student id to update."),
  classDate: z
    .string()
    .describe("Class date to mark attendance for in YYYY-MM-DD format.")
    .optional(),
  status: z
    .enum(["present", "absent"])
    .describe("Attendance status to set for this student."),
});

export default defineTool({
  name: "class-pulse-mark-attendance",
  title: "Mark student attendance",
  description: "Set a student's attendance status for a class date.",
  annotations: {
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: true,
  },
  input: classPulseMarkAttendanceInput,
  ui: "class-pulse-roster",
  invoking: "Updating attendance",
  invoked: "Attendance updated",
  async handler(input) {
    const roster = markClassPulseAttendance(input);
    const payload = createRosterPayload(roster.classDate, roster.students);
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  },
});
