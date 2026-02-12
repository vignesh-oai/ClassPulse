import { z } from "zod/v3";
import { defineTool } from "../utils/define-tool";
import { getTwilioCallPanelOutput } from "../utils/twilio-integration";
import { logInfo } from "../utils/call-debug";

const twilioCallPanelInput = z.object({
  reasonSummary: z
    .string()
    .trim()
    .min(8)
    .max(280)
    .describe(
      "Required. A short reason for the parent call. Include the main attendance concern in 1-2 sentences.",
    ),
  contextFromChat: z
    .string()
    .trim()
    .min(1)
    .max(1400)
    .optional()
    .describe(
      "Optional. Any relevant context from the chat thread that should guide the conversation with the parent.",
    ),
  absenceStats: z
    .string()
    .trim()
    .min(1)
    .max(700)
    .optional()
    .describe(
      "Optional. Known absence statistics (counts, dates, rates, trend) if available in the chat context.",
    ),
});

export default defineTool({
  name: "call-parent",
  title: "Open Parent Call Panel",
  description:
    "Open the teacher call panel to contact a student's parent about persistent absence and monitor a live transcript. Always pass `reasonSummary`, and include `contextFromChat` plus `absenceStats` whenever available from the chat.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  input: twilioCallPanelInput,
  ui: "twilio-call",
  invoking: "Opening call panel",
  invoked: "Call panel ready",
  async handler(input) {
    logInfo("Tool invoked: call-parent", {
      hasReasonSummary: Boolean(input.reasonSummary),
      hasContextFromChat: Boolean(input.contextFromChat),
      hasAbsenceStats: Boolean(input.absenceStats),
    });
    const panel = getTwilioCallPanelOutput(input);
    logInfo("Tool completed: call-parent", {
      status: panel.status,
      displayNumber: panel.displayNumber,
      logsWsUrl: panel.logsWsUrl,
      hasContextFromChat: Boolean(panel.contextFromChat),
      hasAbsenceStats: Boolean(panel.absenceStats),
    });
    return {
      content: [
        {
          type: "text",
          text: `Call panel ready for ${panel.parentName} (${panel.parentRelationship}) regarding ${panel.studentName}'s attendance. Reason: ${panel.reasonSummary}`,
        },
      ],
      structuredContent: panel,
    };
  },
});
