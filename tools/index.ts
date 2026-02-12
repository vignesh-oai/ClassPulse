import type { ToolDefinition } from "../utils/define-tool";
import classPulseAddStudentTool from "./class-pulse-add-student";
import classPulseMarkAttendanceTool from "./class-pulse-mark-attendance";
import classPulseRosterTool from "./class-pulse-roster";
import classPulseRemoveStudentTool from "./class-pulse-remove-student";
import studentTrendTool from "./student-trend";
import twilioCallPanelTool from "./twilio-call-panel";
import twilioCallStartTool from "./twilio-call-start";
import twilioCallStatusTool from "./twilio-call-status";
import twilioCallSummaryTool from "./twilio-call-summary";

export const toolDefinitions: ToolDefinition[] = [
  studentTrendTool,
  twilioCallPanelTool,
  twilioCallStartTool,
  twilioCallStatusTool,
  twilioCallSummaryTool,
  classPulseRosterTool,
  classPulseMarkAttendanceTool,
  classPulseAddStudentTool,
  classPulseRemoveStudentTool,
];
