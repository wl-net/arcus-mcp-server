// Scenes

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Scene, SceneService } from "../capabilities.js";
import { textResult, request, preflight, READ_ONLY, writes, toolRegistrar, type ToolContext } from "./shared.js";
import { summarizeScene } from "./summarize.js";

export function registerSceneTools(server: McpServer, ctx: ToolContext): void {
  const { client } = ctx;
  const tool = toolRegistrar(server);

  // ── list_scenes ──────────────────────────────────────────────────────
  tool(
    "list_scenes",
    {
      title: "List scenes",
      description: "List all scenes at the active place",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const notReady = await preflight(ctx);
      if (notReady) return notReady;
      const placeId = client.activePlaceId!;
      const resp = await request(client, "SERV:scene:", SceneService.CMD_LISTSCENES, { placeId });
      const scenes = resp.payload.attributes.scenes as Array<Record<string, unknown>> | undefined;
      const summary = scenes ? scenes.map(summarizeScene) : resp.payload.attributes;
      return textResult(JSON.stringify(summary));
    }
  );

  // ── fire_scene ───────────────────────────────────────────────────────
  tool(
    "fire_scene",
    {
      title: "Fire scene",
      description: "Execute (fire) a scene",
      inputSchema: { sceneAddress: z.string().describe("Scene address (e.g. SERV:scene:abc-123)") },
      // Scenes can unlock doors or change security modes
      annotations: writes({ destructive: true, idempotent: false }),
    },
    async ({ sceneAddress }) => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const resp = await request(client, sceneAddress, Scene.CMD_FIRE);
      return textResult(JSON.stringify(resp.payload));
    }
  );
}
