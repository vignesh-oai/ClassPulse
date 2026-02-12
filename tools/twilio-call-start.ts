import { z } from "zod/v3";
import { defineTool } from "../utils/define-tool";
import { startTwilioOutboundCall } from "../utils/twilio-integration";
import { logInfo } from "../utils/call-debug";

const twilioCallStartInput = z.object({});

export default defineTool({
  name: "twilio-call-start",
  title: "Start Parent Call",
  description:
    "Start the attendance follow-up call to a student's parent and stream live transcript updates in the teacher widget.",
  annotations: {
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: false,
  },
  input: twilioCallStartInput,
  ui: "twilio-call",
  invoking: "Starting call",
  invoked: "Call started",
  async handler() {
    logInfo("Tool invoked: twilio-call-start");
    const started = await startTwilioOutboundCall();
    logInfo("Tool completed: twilio-call-start", {
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
