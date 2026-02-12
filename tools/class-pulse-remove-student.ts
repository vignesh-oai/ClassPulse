import { z } from "zod/v3";
import { defineTool } from "../utils/define-tool";
import {
  createRosterPayload,
  getClassPulseRoster,
  removeClassPulseStudent,
} from "./class-pulse-db";

const classPulseRemoveStudentInput = z.object({
  studentId: z
    .coerce
    .number()
    .int()
    .positive()
    .describe("Student id to remove from the roster."),
  classDate: z
    .string()
    .describe("Class date to return attendance context for in YYYY-MM-DD format.")
    .optional(),
});

export default defineTool({
  name: "class-pulse-remove-student",
  title: "Remove a student",
  description: "Remove a student from the active class roster.",
  annotations: {
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: true,
  },
  input: classPulseRemoveStudentInput,
  ui: "class-pulse-roster",
  invoking: "Removing student",
  invoked: "Student removed",
  async handler(input) {
    removeClassPulseStudent({ studentId: input.studentId });
    const roster = getClassPulseRoster(input.classDate);
    const payload = createRosterPayload(roster.classDate, roster.students);
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  },
});
