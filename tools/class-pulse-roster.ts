import { z } from "zod/v3";
import { defineTool } from "../utils/define-tool";
import {
  createRosterPayload,
  getClassPulseRoster,
} from "./class-pulse-db";

const classPulseRosterInput = z.object({
  classDate: z
    .string()
    .describe("Class date to display in YYYY-MM-DD format. Defaults to today.")
    .optional(),
});

export default defineTool({
  name: "class-pulse-roster",
  title: "View class roster",
  description:
    "Render the class roster for a selected date and show attendance status per student.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  input: classPulseRosterInput,
  ui: "class-pulse-roster",
  invoking: "Loading the class roster",
  invoked: "Class roster loaded",
  async handler(input) {
    const { classDate, students } = getClassPulseRoster(input.classDate);
    const payload = createRosterPayload(classDate, students);
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  },
});
