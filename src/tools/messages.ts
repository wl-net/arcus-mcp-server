// Raw message escape hatch

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SessionService } from "../capabilities.js";
import { textResult, request, preflight, blockedMessage, writes, toolRegistrar, type ToolContext } from "./shared.js";

export function registerMessageTools(server: McpServer, ctx: ToolContext): void {
  const { client } = ctx;
  const tool = toolRegistrar(server);

  // ── send_message (escape hatch) ──────────────────────────────────────
  tool(
    "send_message",
    {
      title: "Send raw message",
      description: "Send an arbitrary message to the Arcus platform (advanced/escape hatch)",
      inputSchema: {
        destination: z.string().describe("Message destination (e.g. SERV:sess:, DRIV:dev:abc)"),
        messageType: z.string().describe("Message type (e.g. sess:SetActivePlace)"),
        attributes: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Message attributes"),
      },
      // Arbitrary destinations, not just this account's devices
      annotations: writes({ destructive: true, idempotent: false, openWorld: true }),
    },
    async ({ destination, messageType, attributes }) => {
      const blocked = blockedMessage(messageType);
      if (blocked) return blocked;
      const notReady = await preflight(ctx, { write: true, place: false });
      if (notReady) return notReady;
      const resp = await request(client, destination, messageType, attributes);
      // Keep the local active place in step, or later tools would target the old place
      if (messageType === SessionService.CMD_SETACTIVEPLACE && typeof attributes.placeId === "string") {
        client.setActivePlace(attributes.placeId);
      }
      return textResult(JSON.stringify(resp.payload));
    }
  );
}
