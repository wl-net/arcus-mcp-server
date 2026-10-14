import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeClient } from "../bridge-client.js";
import type { ToolContext } from "./shared.js";
import { registerPlaceTools } from "./places.js";
import { registerDeviceTools } from "./devices.js";
import { registerLockTools } from "./locks.js";
import { registerRuleTools } from "./rules.js";
import { registerSceneTools } from "./scenes.js";
import { registerAlarmTools } from "./alarm.js";
import { registerHubTools } from "./hub.js";
import { registerEventTools } from "./events.js";
import { registerMessageTools } from "./messages.js";

export function registerTools(
  server: McpServer,
  client: BridgeClient,
  ensureConnected: () => Promise<void>
): void {
  const ctx: ToolContext = { client, ensureConnected };
  registerPlaceTools(server, ctx);
  registerDeviceTools(server, ctx);
  registerLockTools(server, ctx);
  registerRuleTools(server, ctx);
  registerSceneTools(server, ctx);
  registerAlarmTools(server, ctx);
  registerHubTools(server, ctx);
  registerEventTools(server, ctx);
  registerMessageTools(server, ctx);
}
