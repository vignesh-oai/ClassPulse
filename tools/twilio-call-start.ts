import { z } from "zod/v3";
import { defineTool } from "../utils/define-tool";
import { startTwilioOutboundCall } from "../utils/twilio-integration";
import { logInfo } from "../utils/call-debug";

const twilioCallStartInput = z.object({
  reasonSummary: z.string().trim().min(8).max(280).optional(),
  contextFromChat: z.string().trim().min(1).max(1400).optional(),
  absenceStats: z.string().trim().min(1).max(700).optional(),
});

export default defineTool({
  name: "initiate-call",
  title: "Start Parent Call",
  description:
    "Internal-only call launcher for the parent call widget. ChatGPT must never invoke this tool directly from user intent. When a user asks to make a phone call, call `call-parent` instead and let the widget trigger this tool with the collected reason/context briefing.",
  annotations: {
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: false,
  },
  input: twilioCallStartInput,
  ui: "twilio-call",
  invoking: "Starting call",
  invoked: "Call started",
  async handler(input) {
    logInfo("Tool invoked: initiate-call", {
      hasReasonSummary: Boolean(input.reasonSummary),
      hasContextFromChat: Boolean(input.contextFromChat),
      hasAbsenceStats: Boolean(input.absenceStats),
    });
    const started = await startTwilioOutboundCall(input);
    logInfo("Tool completed: initiate-call", {
      sessionId: started.sessionId,
      status: started.status,
      callSid: started.callSid,
      hasError: Boolean(started.errorMessage),
    });

    const message =
      started.status === "failed"
        ? `Call failed to start: ${started.errorMessage ?? "unknown error"}`
        : `Dialing ${started.parentName} (${started.parentRelationship}) about ${started.studentName}'s attendance.`;

    return {
      content: [{ type: "text", text: message }],
      structuredContent: started,
    };
  },
});
