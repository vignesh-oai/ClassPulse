import { z } from "zod/v3";
import { defineTool } from "../utils/define-tool";
import {
  addClassPulseStudent,
  createRosterPayload,
  getClassPulseRoster,
} from "./class-pulse-db";

const classPulseAddStudentInput = z.object({
  firstName: z
    .string()
    .trim()
    .min(1)
    .describe("Student first name."),
  lastName: z
    .string()
    .trim()
    .min(1)
    .describe("Student last name."),
  classDate: z
    .string()
    .describe("Class date to return attendance context for, in YYYY-MM-DD format.")
    .optional(),
});

export default defineTool({
  name: "class-pulse-add-student",
  title: "Add student",
  description: "Add a new student to the active roster.",
  annotations: {
    readOnlyHint: false,
    openWorldHint: false,
    destructiveHint: true,
  },
  input: classPulseAddStudentInput,
  ui: "class-pulse-roster",
  invoking: "Adding a student",
  invoked: "Student added",
  async handler(input) {
    addClassPulseStudent(input);
    const roster = getClassPulseRoster(input.classDate);
    const payload = createRosterPayload(roster.classDate, roster.students);
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  },
});
