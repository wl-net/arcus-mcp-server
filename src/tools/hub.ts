// Hub, Z-Wave/Zigbee networks and admin-only hub debug

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { Device, DeviceAdvanced, HubAdvanced, HubDebug, HubZigbee, HubZwave, Place } from "../capabilities.js";
import { textResult, request, preflight, getHubAddress, READ_ONLY, writes, emptyOk, toolRegistrar, type ToolContext } from "./shared.js";
import { summarizeHub, zwaveNodeId, summarizeZwaveNetwork } from "./summarize.js";

export function registerHubTools(server: McpServer, ctx: ToolContext): void {
  const { client } = ctx;
  const tool = toolRegistrar(server);

  // ── get_hub ────────────────────────────────────────────────────────────
  tool(
    "get_hub",
    {
      title: "Get hub",
      description: "Get hub status at the active place",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const notReady = await preflight(ctx);
      if (notReady) return notReady;
      const resp = await request(client, client.placeDestination, Place.CMD_GETHUB);
      return textResult(JSON.stringify(summarizeHub(resp.payload.attributes)));
    }
  );

  // ── reboot_hub ──────────────────────────────────────────────────────────
  tool(
    "reboot_hub",
    {
      title: "Reboot hub",
      description: "Reboot the hub at the active place. The hub will go offline temporarily.",
      inputSchema: {},
      annotations: writes({ destructive: true, idempotent: false }),
    },
    async () => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await request(client, hub.address, HubAdvanced.CMD_REBOOT);
      return emptyOk(resp, `Hub ${hub.id} is rebooting.`);
    }
  );

  // ── zwave_network_info ──────────────────────────────────────────────────
  tool(
    "zwave_network_info",
    {
      title: "Z-Wave network info",
      description: "Get Z-Wave network information including node metrics, neighbors, routing, and zombie nodes",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const notReady = await preflight(ctx);
      if (notReady) return notReady;
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const [resp, devResp] = await Promise.all([
        request(client, hub.address, HubZwave.CMD_NETWORKINFORMATION),
        request(client, client.placeDestination, Place.CMD_LISTDEVICES),
      ]);

      // Build node ID → device name map from Z-Wave devices
      const devices = devResp.payload.attributes.devices as Array<Record<string, unknown>> | undefined;
      const nodeNames: Record<string, string> = {};
      if (devices) {
        for (const d of devices) {
          if (d[DeviceAdvanced.ATTR_PROTOCOL] === "ZWAV") {
            const rawId = d[DeviceAdvanced.ATTR_PROTOCOLID];
            const name = d[Device.ATTR_NAME];
            if (rawId != null && name != null) {
              const nodeId = zwaveNodeId(String(rawId));
              if (nodeId != null) {
                nodeNames[String(nodeId)] = String(name);
              }
            }
          }
        }
      }

      return textResult(JSON.stringify(summarizeZwaveNetwork(resp.payload.attributes, nodeNames)));
    }
  );

  // ── zwave_heal ────────────────────────────────────────────────────────
  tool(
    "zwave_heal",
    {
      title: "Heal Z-Wave network",
      description: "Start a Z-Wave network heal. WARNING: interferes with normal Z-Wave operation during healing.",
      inputSchema: {
        block: z.boolean().default(false).describe("Block Z-Wave device control during heal (faster but disruptive)"),
      },
      annotations: writes({ destructive: false, idempotent: false }),
    },
    async ({ block }) => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await request(client, hub.address, HubZwave.CMD_HEAL, { block });
      return emptyOk(resp, "Z-Wave network heal started.");
    }
  );

  // ── zwave_cancel_heal ─────────────────────────────────────────────────
  tool(
    "zwave_cancel_heal",
    {
      title: "Cancel Z-Wave heal",
      description: "Cancel any Z-Wave network heal in progress",
      inputSchema: {},
      annotations: writes({ destructive: false, idempotent: true }),
    },
    async () => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await request(client, hub.address, HubZwave.CMD_CANCELHEAL);
      return emptyOk(resp, "Z-Wave heal cancelled.");
    }
  );

  // ── zwave_remove_zombie ───────────────────────────────────────────────
  tool(
    "zwave_remove_zombie",
    {
      title: "Remove Z-Wave zombie node",
      description: "Remove a zombie node from the Z-Wave network",
      inputSchema: {
        node: z.number().describe("Z-Wave node ID to remove (must be a zombie node)"),
      },
      annotations: writes({ destructive: true, idempotent: true }),
    },
    async ({ node }) => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await request(client, hub.address, HubZwave.CMD_REMOVEZOMBIE, { node });
      return emptyOk(resp, `Zombie node ${node} removed.`);
    }
  );

  // ── Zigbee and hub debug reads: hub address → one request → raw attributes
  function hubRead(name: string, title: string, description: string, messageType: string): void {
    hubCommand(name, title, description, messageType, READ_ONLY);
  }

  function hubCommand(
    name: string, title: string, description: string, messageType: string, annotations: ToolAnnotations
  ): void {
    const write = annotations.readOnlyHint !== true;
    tool(name, { title, description, inputSchema: {}, annotations }, async () => {
      const notReady = await preflight(ctx, { write });
      if (notReady) return notReady;
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await request(client, hub.address, messageType);
      return textResult(JSON.stringify(resp.payload.attributes));
    });
  }

  hubRead("zigbee_network_info", "Zigbee network info", "Get Zigbee network information", HubZigbee.CMD_NETWORKINFORMATION);
  hubRead("zigbee_get_stats", "Zigbee radio stats", "Get Zigbee radio statistics", HubZigbee.CMD_GETSTATS);
  // A scan has the radio sweep channels, so it sits behind the write gate
  hubCommand(
    "zigbee_scan", "Zigbee scan", "Scan the Zigbee network for devices and channel information",
    HubZigbee.CMD_SCAN, writes({ destructive: false, idempotent: true })
  );

  // ── Admin-only tools (ARCUS_ENABLE_ADMIN=1) ────────────────────────
  if (process.env.ARCUS_ENABLE_ADMIN) {
    hubRead("hub_syslog", "Hub syslog", "Get hub system log", HubDebug.CMD_GETSYSLOG);
    hubRead("hub_bootlog", "Hub boot log", "Get hub boot log", HubDebug.CMD_GETBOOTLOG);
    hubRead("hub_processes", "Hub processes", "Get running processes on the hub", HubDebug.CMD_GETPROCESSES);
    hubRead("hub_load", "Hub load", "Get system load on the hub", HubDebug.CMD_GETLOAD);
    hubRead("hub_agent_db", "Hub agent database", "Get hub agent database", HubDebug.CMD_GETAGENTDB);

    tool(
      "hub_files",
      {
        title: "Hub files",
        description: "Get file listing from the hub",
        inputSchema: {
          paths: z.array(z.string()).describe("List of file/directory paths to return"),
        },
        annotations: READ_ONLY,
      },
      async ({ paths }) => {
        const notReady = await preflight(ctx);
        if (notReady) return notReady;
        const hub = await getHubAddress(client);
        if ("isError" in hub) return hub;
        const resp = await request(client, hub.address, HubDebug.CMD_GETFILES, { paths });
        return textResult(JSON.stringify(resp.payload.attributes));
      }
    );
  }
}
