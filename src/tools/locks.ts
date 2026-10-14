// Door locks

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DoorLock } from "../capabilities.js";
import { request, preflight, writes, emptyOk, toolRegistrar, type ToolContext } from "./shared.js";

export function registerLockTools(server: McpServer, ctx: ToolContext): void {
  const { client } = ctx;
  const tool = toolRegistrar(server);

  // ── doorlock_buzz_in ──────────────────────────────────────────────────
  tool(
    "doorlock_buzz_in",
    {
      title: "Buzz in (unlock door)",
      description: "Temporarily unlock a door lock (auto-relocks in 30 seconds)",
      inputSchema: {
        deviceAddress: z.string().describe("Door lock device address (e.g. DRIV:dev:abc-123)"),
      },
      annotations: writes({ destructive: true, idempotent: false }),
    },
    async ({ deviceAddress }) => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const resp = await request(client, deviceAddress, DoorLock.CMD_BUZZIN);
      return emptyOk(resp, "Door unlocked (will auto-relock in 30 seconds).");
    }
  );

  // ── doorlock_authorize_person ────────────────────────────────────────
  tool(
    "doorlock_authorize_person",
    {
      title: "Authorize person on lock",
      description: "Authorize a person's PIN on a door lock",
      inputSchema: {
        deviceAddress: z.string().describe("Door lock device address (e.g. DRIV:dev:abc-123)"),
        personId: z.string().describe("Person ID to authorize (use list_persons to find IDs)"),
      },
      // Grants physical access, so treated as destructive
      annotations: writes({ destructive: true, idempotent: true }),
    },
    async ({ deviceAddress, personId }) => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const resp = await request(client, deviceAddress, DoorLock.CMD_AUTHORIZEPERSON, { personId });
      return emptyOk(resp, `Person ${personId} authorized on lock.`);
    }
  );

  // ── doorlock_deauthorize_person ────────────────────────────────────
  tool(
    "doorlock_deauthorize_person",
    {
      title: "Deauthorize person from lock",
      description: "Deauthorize a person's PIN from a door lock",
      inputSchema: {
        deviceAddress: z.string().describe("Door lock device address (e.g. DRIV:dev:abc-123)"),
        personId: z.string().describe("Person ID to deauthorize (use list_persons to find IDs)"),
      },
      annotations: writes({ destructive: true, idempotent: true }),
    },
    async ({ deviceAddress, personId }) => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const resp = await request(client, deviceAddress, DoorLock.CMD_DEAUTHORIZEPERSON, { personId });
      return emptyOk(resp, `Person ${personId} deauthorized from lock.`);
    }
  );
}
