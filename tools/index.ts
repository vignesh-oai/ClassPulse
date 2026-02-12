import type { ToolDefinition } from "../utils/define-tool";
import pizzaAlbumsTool from "./pizza-albums";
import pizzaCarouselTool from "./pizza-carousel";
import pizzaListTool from "./pizza-list";
import pizzaMapTool from "./pizza-map";
import pizzaShopTool from "./pizza-shop";
import classPulseAddStudentTool from "./class-pulse-add-student";
import classPulseMarkAttendanceTool from "./class-pulse-mark-attendance";
import classPulseRosterTool from "./class-pulse-roster";
import classPulseRemoveStudentTool from "./class-pulse-remove-student";
import { createSqliteTools } from "./sqlite-tools";
import twilioCallPanelTool from "./twilio-call-panel";
import twilioCallStartTool from "./twilio-call-start";
import twilioCallStatusTool from "./twilio-call-status";
import twilioCallSummaryTool from "./twilio-call-summary";

export const toolDefinitions: ToolDefinition[] = [
  pizzaMapTool,
  pizzaCarouselTool,
  pizzaAlbumsTool,
  pizzaListTool,
  pizzaShopTool,
  twilioCallPanelTool,
  twilioCallStartTool,
  twilioCallStatusTool,
  twilioCallSummaryTool,
  classPulseRosterTool,
  classPulseMarkAttendanceTool,
  classPulseAddStudentTool,
  classPulseRemoveStudentTool,
  ...createSqliteTools(),
];
