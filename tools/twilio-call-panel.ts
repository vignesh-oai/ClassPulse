import { z } from "zod/v3";
import { defineTool } from "../utils/define-tool";
import { getTwilioCallPanelOutput } from "../utils/twilio-integration";
import { logInfo } from "../utils/call-debug";

const twilioCallPanelInput = z.object({});

export default defineTool({
  name: "call-parent",
  title: "Open Parent Call Panel",
  description:
    "Open the teacher call panel to contact a student's parent about persistent absence and monitor a live transcript.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  input: twilioCallPanelInput,
  ui: "twilio-call",
  invoking: "Opening call panel",
  invoked: "Call panel ready",
  async handler() {
    logInfo("Tool invoked: call-parent");
    const panel = getTwilioCallPanelOutput();
    logInfo("Tool completed: call-parent", {
      status: panel.status,
      displayNumber: panel.displayNumber,
      logsWsUrl: panel.logsWsUrl,
    });
    return {
      content: [
        {
          type: "text",
          text: `Call panel ready for ${panel.parentName} (${panel.parentRelationship}) regarding ${panel.studentName}'s attendance.`,
        },
      ],
      structuredContent: panel,
    };
  },
});
