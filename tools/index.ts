import type { ToolDefinition } from "../utils/define-tool";
import pizzaAlbumsTool from "./pizza-albums";
import pizzaCarouselTool from "./pizza-carousel";
import pizzaListTool from "./pizza-list";
import pizzaMapTool from "./pizza-map";
import pizzaShopTool from "./pizza-shop";
<<<<<<< Updated upstream
import { createSqliteTools } from "./sqlite-tools";
=======
import twilioCallPanelTool from "./twilio-call-panel";
import twilioCallStartTool from "./twilio-call-start";
import twilioCallStatusTool from "./twilio-call-status";
>>>>>>> Stashed changes

export const toolDefinitions: ToolDefinition[] = [
  pizzaMapTool,
  pizzaCarouselTool,
  pizzaAlbumsTool,
  pizzaListTool,
  pizzaShopTool,
<<<<<<< Updated upstream
  ...createSqliteTools(),
=======
  twilioCallPanelTool,
  twilioCallStartTool,
  twilioCallStatusTool,
>>>>>>> Stashed changes
];
