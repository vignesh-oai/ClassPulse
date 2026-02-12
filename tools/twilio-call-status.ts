import { z } from "zod/v3";
import { defineTool } from "../utils/define-tool";
import { getTwilioCallStatusOutput } from "../utils/twilio-integration";
import { logInfo, logWarn } from "../utils/call-debug";

const twilioCallStatusInput = z.object({
  sessionId: z.string().min(1).describe("Call session id returned by twilio-call-start."),
});

export default defineTool({
  name: "twilio-call-status",
  title: "Get Parent Call Status",
  description:
    "Get the latest parent-call status and transcript snapshot for an active teacher attendance follow-up call.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  input: twilioCallStatusInput,
  ui: "twilio-call",
  invoking: "Checking call status",
  invoked: "Call status updated",
  async handler(input) {
    logInfo("Tool invoked: twilio-call-status", {
      sessionId: input.sessionId,
    });
    const summary = getTwilioCallStatusOutput(input.sessionId);

    if (!summary) {
      logWarn("Tool result: twilio-call-status session not found", {
        sessionId: input.sessionId,
      });
      return {
        content: [
          {
            type: "text",
            text: `No call session found for id ${input.sessionId}.`,
          },
        ],
        structuredContent: {
          sessionId: input.sessionId,
          found: false,
        },
      };
    }

    logInfo("Tool completed: twilio-call-status", {
      sessionId: input.sessionId,
      status: summary.status,
      callSid: summary.callSid,
      lastSeq: summary.lastSeq,
      transcriptItems: summary.transcript.length,
    });

    return {
      content: [
        {
          type: "text",
          text: `Call ${summary.sessionId} is currently ${summary.status}.`,
        },
      ],
      structuredContent: {
        found: true,
        ...summary,
      },
    };
  },
});
