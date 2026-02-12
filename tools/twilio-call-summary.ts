import { z } from "zod/v3";
import { defineTool } from "../utils/define-tool";
import { getTwilioCallSummaryOutput } from "../utils/twilio-integration";
import { logInfo, logWarn } from "../utils/call-debug";

const twilioCallSummaryInput = z.object({
  sessionId: z
    .string()
    .min(1)
    .describe("Call session id returned by initiate-call."),
});

export default defineTool({
  name: "summarise-call",
  title: "Summarize Parent Call",
  description:
    "Generate a concise attendance follow-up summary and action items from the parent call transcript.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  input: twilioCallSummaryInput,
  ui: "twilio-call",
  invoking: "Summarizing call",
  invoked: "Summary ready",
  async handler(input) {
    logInfo("Tool invoked: summarise-call", {
      sessionId: input.sessionId,
    });

    const summary = await getTwilioCallSummaryOutput(input.sessionId);
    if (!summary) {
      logWarn("Tool result: summarise-call session not found", {
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
          found: false,
          sessionId: input.sessionId,
        },
      };
    }

    logInfo("Tool completed: summarise-call", {
      sessionId: input.sessionId,
      status: summary.status,
      source: summary.source,
      transcriptItems: summary.transcriptItems,
    });

    return {
      content: [
        {
          type: "text",
          text: summary.summary,
        },
      ],
      structuredContent: {
        found: true,
        ...summary,
      },
    };
  },
});
