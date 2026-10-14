// Devices and pairing

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Base, Identify, PairingSubsystem, Place } from "../capabilities.js";
import { textResult, errorMessage, isErrorResponse, request, preflight, blockedMessage, READ_ONLY, writes, emptyOk, toolRegistrar, type ToolContext } from "./shared.js";
import { summarizeDevice } from "./summarize.js";

export function registerDeviceTools(server: McpServer, ctx: ToolContext): void {
  const { client } = ctx;
  const tool = toolRegistrar(server);

  // ── list_devices ─────────────────────────────────────────────────────
  tool(
    "list_devices",
    {
      title: "List devices",
      description: "List all devices at the active place. Temperatures (temp) and thermostat setpoints (heat, cool) are in °C.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const notReady = await preflight(ctx);
      if (notReady) return notReady;
      const [resp] = await Promise.all([
        request(client, client.placeDestination, Place.CMD_LISTDEVICES),
        client.fetchProductCatalog(),
      ]);
      const devices = resp.payload.attributes.devices as Array<Record<string, unknown>> | undefined;
      const catalog = client.productCatalog;
      const summary = devices ? devices.map((d) => summarizeDevice(d, catalog)) : resp.payload.attributes;
      return textResult(JSON.stringify(summary));
    }
  );

  // ── get_device ───────────────────────────────────────────────────────
  tool(
    "get_device",
    {
      title: "Get device",
      description: "Get full state and attributes of a specific device",
      inputSchema: { deviceAddress: z.string().describe("Device address (e.g. DRIV:dev:abc-123)") },
      annotations: READ_ONLY,
    },
    async ({ deviceAddress }) => {
      const notReady = await preflight(ctx);
      if (notReady) return notReady;
      const resp = await request(client, deviceAddress, Base.CMD_GETATTRIBUTES);
      return textResult(JSON.stringify(resp.payload.attributes));
    }
  );

  // ── get_devices ──────────────────────────────────────────────────────
  tool(
    "get_devices",
    {
      title: "Get devices",
      description: "Get full state and attributes of multiple devices in one call",
      inputSchema: {
        deviceAddresses: z
          .array(z.string())
          .describe("Array of device addresses (e.g. [\"DRIV:dev:abc-123\", \"DRIV:dev:def-456\"])"),
      },
      annotations: READ_ONLY,
    },
    async ({ deviceAddresses }) => {
      const notReady = await preflight(ctx);
      if (notReady) return notReady;
      await client.fetchProductCatalog();
      const catalog = client.productCatalog;
      // Per-address failures are reported inline so one bad address doesn't sink the batch
      const results = await Promise.all(
        deviceAddresses.map(async (addr) => {
          try {
            const resp = await client.sendRequest(addr, Base.CMD_GETATTRIBUTES, {});
            if (isErrorResponse(resp)) {
              return { addr, error: resp.payload.attributes.message ?? resp.payload.attributes.code };
            }
            return { ...(summarizeDevice(resp.payload.attributes, catalog) as Record<string, unknown>), addr };
          } catch (err) {
            return { addr, error: errorMessage(err) };
          }
        })
      );
      return textResult(JSON.stringify(results));
    }
  );

  // ── device_command ───────────────────────────────────────────────────
  tool(
    "device_command",
    {
      title: "Send device command",
      description: `Send a command to a device. Examples:
- Turn on switch: commandName="base:SetAttributes", attributes={"swit:state":"ON"}
- Lock door: commandName="base:SetAttributes", attributes={"doorlock:lockstate":"LOCKED"}
- Set thermostat heat to 21°C (70°F): commandName="base:SetAttributes", attributes={"therm:heatsetpoint":21}
- Dim light: commandName="base:SetAttributes", attributes={"dim:brightness":50}
Thermostat setpoints and temperatures are always in °C; convert from °F first.`,
      inputSchema: {
        deviceAddress: z.string().describe("Device address (e.g. DRIV:dev:abc-123)"),
        commandName: z.string().describe("Command message type (e.g. base:SetAttributes)"),
        attributes: z
          .record(z.string(), z.unknown())
          .default({})
          .describe("Command attributes as key-value pairs"),
      },
      annotations: writes({ destructive: true, idempotent: false }),
    },
    async ({ deviceAddress, commandName, attributes }) => {
      const blocked = blockedMessage(commandName);
      if (blocked) return blocked;
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const resp = await request(client, deviceAddress, commandName, attributes);
      return textResult(JSON.stringify(resp.payload));
    }
  );

  // ── identify_device ──────────────────────────────────────────────────
  tool(
    "identify_device",
    {
      title: "Identify device",
      description: "Flash LED or play sound on a device to physically identify it",
      inputSchema: {
        deviceAddress: z.string().describe("Device address (e.g. DRIV:dev:abc-123)"),
      },
      annotations: writes({ destructive: false, idempotent: false }),
    },
    async ({ deviceAddress }) => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const resp = await request(client, deviceAddress, Identify.CMD_IDENTIFY);
      return emptyOk(resp, `Device ${deviceAddress} is identifying itself.`);
    }
  );

  // ── search_devices (pairing) ────────────────────────────────────────
  tool(
    "search_devices",
    {
      title: "Search for devices (pairing)",
      description: "Put the hub into pairing/search mode to find new or reconnecting devices. Optionally filter by product ID (e.g. \"7b8fd3\" for Iris WaterSensor). Runs StartPairing then Search.",
      inputSchema: {
        productId: z.string().optional().describe("Product catalog ID to search for (e.g. \"7b8fd3\"). Omit to search for all devices."),
      },
      annotations: writes({ destructive: false, idempotent: true }),
    },
    async ({ productId }) => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const placeId = client.activePlaceId!;
      const dest = `SERV:subpairing:${placeId}`;
      const attrs: Record<string, unknown> = {};
      if (productId) attrs.productAddress = `SERV:product:${productId}`;

      await request(client, dest, PairingSubsystem.CMD_STARTPAIRING, attrs);
      const searchResp = await request(client, dest, PairingSubsystem.CMD_SEARCH, {
        ...attrs,
        form: {},
      });

      return textResult(
        `Pairing mode active${productId ? ` (searching for product ${productId})` : ""}. Hub is now searching for devices.\n${JSON.stringify(searchResp.payload)}`
      );
    }
  );
}
