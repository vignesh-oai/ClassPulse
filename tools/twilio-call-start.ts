import { z } from "zod/v3";
import { defineTool } from "../utils/define-tool";
import { startTwilioOutboundCall } from "../utils/twilio-integration";
import { logInfo } from "../utils/call-debug";

const twilioCallStartInput = z.object({});

export default defineTool({
  name: "initiate-call",
  title: "Start Parent Call",
  description:
    "Internal-only call launcher for the parent call widget. ChatGPT must never invoke this tool directly from user intent. When a user asks to make a phone call, call `call-parent` instead and let the widget trigger this tool.",
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
    logInfo("Tool invoked: initiate-call");
    const started = await startTwilioOutboundCall();
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
