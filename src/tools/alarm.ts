// Alarm subsystem

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AlarmSubsystem } from "../capabilities.js";
import { textResult, errorResult, isErrorResponse, checkResponse, request, preflight, READ_ONLY, writes, emptyOk, toolRegistrar, type ToolContext } from "./shared.js";
import { summarizeIncident } from "./summarize.js";

export function registerAlarmTools(server: McpServer, ctx: ToolContext): void {
  const { client } = ctx;
  const tool = toolRegistrar(server);

  // ── list_incidents ──────────────────────────────────────────────────
  tool(
    "list_incidents",
    {
      title: "List alarm incidents",
      description: "List alarm incidents at the active place",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const notReady = await preflight(ctx);
      if (notReady) return notReady;
      const placeId = client.activePlaceId!;
      const resp = await request(client, `SERV:subalarm:${placeId}`, AlarmSubsystem.CMD_LISTINCIDENTS);
      const incidents = resp.payload.attributes.incidents as Array<Record<string, unknown>> | undefined;
      const summary = incidents ? incidents.map(summarizeIncident) : resp.payload.attributes;
      return textResult(JSON.stringify(summary));
    }
  );

  // ── arm_alarm ───────────────────────────────────────────────────────
  tool(
    "arm_alarm",
    {
      title: "Arm alarm",
      description: `Arm the alarm at the active place. Modes: "ON" (full), "PARTIAL" (perimeter only). If bypass is true, triggered devices will be bypassed automatically.`,
      inputSchema: {
        mode: z.enum(["ON", "PARTIAL"]).describe("Alarm mode: ON (full) or PARTIAL (perimeter only)"),
        bypass: z.boolean().default(false).describe("Bypass triggered devices if arming fails (default false)"),
      },
      annotations: writes({ destructive: false, idempotent: false }),
    },
    async ({ mode, bypass }) => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const placeId = client.activePlaceId!;
      const dest = `SERV:subalarm:${placeId}`;
      const msgType = bypass ? AlarmSubsystem.CMD_ARMBYPASSED : AlarmSubsystem.CMD_ARM;
      const resp = await client.sendRequest(dest, msgType, { mode });

      if (isErrorResponse(resp) && !bypass && resp.payload.attributes.code === "security.triggeredDevices") {
        return errorResult(`Cannot arm — triggered devices: ${resp.payload.attributes.message}\nUse bypass=true to arm anyway.`);
      }
      checkResponse(resp, msgType);

      return textResult(JSON.stringify(resp.payload));
    }
  );

  // ── disarm_alarm ──────────────────────────────────────────────────────
  tool(
    "disarm_alarm",
    {
      title: "Disarm alarm",
      description: "Disarm the alarm at the active place",
      inputSchema: {},
      annotations: writes({ destructive: true, idempotent: true }),
    },
    async () => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const placeId = client.activePlaceId!;
      const resp = await request(client, `SERV:subalarm:${placeId}`, AlarmSubsystem.CMD_DISARM);
      return emptyOk(resp, "Alarm disarmed.");
    }
  );
}
