import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeClient } from "./bridge-client.js";

const SESS_DEST = "SERV:sess:";

// Destructive message types that should never be sent
const BLOCKED_MESSAGE_TYPES = new Set([
  // Account
  "account:Delete",
  // Hub
  "hub:Delete",
  "hub:Deregister",
  "hubadv:FactoryReset",
  // Place
  "place:Delete",
  "place:RemoveDevice",
  "place:RemovePerson",
  // Person
  "person:Delete",
  "person:RemoveFromPlace",
  "person:ChangePin",
  "person:SetPassword",
  "person:ChangePassword",
  // Device
  "device:Remove",
  "device:ForceRemove",
  // Other
  "scene:Delete",
  "rule:Delete",
  "base:Remove",
]);

// ── Response summarizers ───────────────────────────────────────────────

function summarizeHub(attrs: Record<string, unknown>): unknown {
  const hub = attrs.hub as Record<string, unknown> | undefined;
  if (!hub) return attrs;
  return {
    id: hub["base:id"],
    name: hub["hub:name"],
    model: hub["hub:model"],
    state: hub["hub:state"],
    connectionState: hub["hubconn:state"],
    firmwareVersion: hub["hubadv:agentver"],
    osVersion: hub["hubadv:osver"],
    powerSource: hub["hubpow:source"],
    battery: hub["hubpow:Battery"],
    securityMode: hub["hubalarm:securityMode"],
    alarmState: hub["hubalarm:alarmState"],
    zwaveDevices: hub["hubzwave:numDevices"],
    zigbeeChannel: hub["hubzigbee:channel"],
  };
}

function summarizeSubsystems(attrs: Record<string, unknown>): unknown {
  const subs = attrs.subsystems as Array<Record<string, unknown>> | undefined;
  if (!subs) return attrs;
  return subs.map((s) => ({
    name: s["subs:name"],
    address: s["base:address"],
    state: s["subs:state"],
    available: s["subs:available"],
  }));
}

function summarizePerson(attrs: Record<string, unknown>): unknown {
  return {
    name: `${attrs["person:firstName"]} ${attrs["person:lastName"]}`,
    email: attrs["person:email"],
    mobile: attrs["person:mobileNumber"],
    currentPlace: attrs["person:currPlace"],
  };
}

function summarizeDevice(d: Record<string, unknown>): unknown {
  const caps = d["base:caps"] as string[] | undefined;
  const summary: Record<string, unknown> = {
    name: d["dev:name"],
    address: d["base:address"],
    type: d["dev:devtypehint"],
    vendor: d["dev:vendor"],
    model: d["dev:model"],
    connection: d["devconn:state"],
    protocol: d["devadv:protocol"],
  };

  // Include capability-specific state
  if (caps?.includes("swit")) summary.switchState = d["swit:state"];
  if (caps?.includes("dim")) summary.brightness = d["dim:brightness"];
  if (caps?.includes("temp")) summary.temperature = d["temp:temperature"];
  if (caps?.includes("humid")) summary.humidity = d["humid:humidity"];
  if (caps?.includes("therm")) {
    summary.hvacMode = d["therm:hvacmode"];
    summary.heatSetpoint = d["therm:heatsetpoint"];
    summary.coolSetpoint = d["therm:coolsetpoint"];
  }
  if (caps?.includes("cont")) summary.contact = d["cont:contact"];
  if (caps?.includes("mot")) summary.motion = d["mot:motion"];
  if (caps?.includes("doorlock")) summary.lockState = d["doorlock:lockstate"];
  if (caps?.includes("glass")) summary.glassBreak = d["glass:break"];
  if (caps?.includes("pres")) summary.presence = d["pres:presence"];
  if (caps?.includes("devpow") && d["devpow:source"] === "BATTERY") {
    summary.battery = d["devpow:battery"];
  }

  return summary;
}

function summarizeIncident(i: Record<string, unknown>): unknown {
  return {
    address: i["base:address"],
    alert: i["incident:alert"],
    alertState: i["incident:alertState"],
    confirmed: i["incident:confirmed"],
    cancelled: i["incident:cancelled"],
    cancelledBy: i["incident:cancelledBy"],
    startTime: i["incident:startTime"],
    endTime: i["incident:endTime"],
    monitored: i["incident:monitored"],
  };
}

function summarizeScene(s: Record<string, unknown>): unknown {
  const actions = s["scene:actions"] as Array<Record<string, unknown>> | undefined;
  return {
    name: s["scene:name"],
    address: s["base:address"],
    enabled: s["scene:enabled"],
    template: s["scene:template"],
    actions: actions?.map((a) => a.name),
    lastFired: s["scene:lastFireTime"],
  };
}

function summarizeRule(r: Record<string, unknown>): unknown {
  return {
    name: r["rule:name"],
    address: r["base:address"],
    description: r["rule:description"],
    state: r["rule:state"],
    template: r["rule:template"],
  };
}

export function registerTools(
  server: McpServer,
  client: BridgeClient,
  ensureConnected: () => Promise<void>
): void {
  // ── list_places ──────────────────────────────────────────────────────
  server.tool(
    "list_places",
    "List all places (homes/locations) accessible to the logged-in user",
    {},
    async () => {
      await ensureConnected();
      const personId = client.session?.personId;
      if (!personId) {
        return { content: [{ type: "text", text: "Not connected to bridge" }], isError: true };
      }
      const resp = await client.sendRequest(
        `SERV:person:${personId}`,
        "person:ListAvailablePlaces",
        {}
      );
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes.places, null, 2) }] };
    }
  );

  // ── set_active_place ─────────────────────────────────────────────────
  server.tool(
    "set_active_place",
    "Set the active place. Must be called before device or scene operations.",
    { placeId: z.string().describe("The place ID to activate (UUID)") },
    async ({ placeId }) => {
      await ensureConnected();

      // Phase 1: SetActivePlace + GetAttributes (person) in parallel
      const personId = client.session?.personId;
      const [resp, personResp] = await Promise.all([
        client.sendRequest(SESS_DEST, "sess:SetActivePlace", { placeId }),
        personId
          ? client.sendRequest(`SERV:person:${personId}`, "base:GetAttributes", {})
          : Promise.resolve(null),
      ]);
      client.setActivePlace(placeId);

      // Phase 2: After SetActivePlaceResponse, send GetHub + ListSubsystems
      const placeDest = client.placeDestination;
      const [hubResp, subsResp] = await Promise.all([
        client.sendRequest(placeDest, "place:GetHub", {}),
        client.sendRequest("SERV:subs:", "subs:ListSubsystems", { placeId }),
      ]);

      const summary = {
        place: resp.payload.attributes,
        ...(personResp ? { person: summarizePerson(personResp.payload.attributes) } : {}),
        hub: summarizeHub(hubResp.payload.attributes),
        subsystems: summarizeSubsystems(subsResp.payload.attributes),
      };

      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── list_history ────────────────────────────────────────────────────
  server.tool(
    "list_history",
    "List recent history entries at the active place",
    {
      limit: z.number().default(10).describe("Number of entries to return (default 10)"),
    },
    async ({ limit }) => {
      await ensureConnected();
      const resp = await client.sendRequest(client.placeDestination, "place:ListHistoryEntries", { limit });
      const results = resp.payload.attributes.results as Array<Record<string, unknown>> | undefined;
      const summary = results
        ? results.map((e) => ({
            timestamp: e.timestamp,
            key: e.key,
            subjectName: e.subjectName,
            shortMessage: e.shortMessage,
            longMessage: e.longMessage,
          }))
        : resp.payload.attributes;
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── list_persons ────────────────────────────────────────────────────
  server.tool(
    "list_persons",
    "List all persons at the active place",
    {},
    async () => {
      await ensureConnected();
      const resp = await client.sendRequest(client.placeDestination, "place:ListPersons", {});
      const persons = resp.payload.attributes.persons as Array<Record<string, unknown>> | undefined;
      const summary = persons
        ? persons.map((p) => ({
            name: `${p["person:firstName"]} ${p["person:lastName"]}`,
            address: p["base:address"],
            email: p["person:email"],
            mobile: p["person:mobileNumber"],
            owner: p["person:owner"],
            hasPin: p["person:hasPin"],
            hasLogin: p["person:hasLogin"],
          }))
        : resp.payload.attributes;
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── list_devices ─────────────────────────────────────────────────────
  server.tool(
    "list_devices",
    "List all devices at the active place",
    {},
    async () => {
      await ensureConnected();
      const resp = await client.sendRequest(client.placeDestination, "place:ListDevices", {});
      const devices = resp.payload.attributes.devices as Array<Record<string, unknown>> | undefined;
      const summary = devices ? devices.map(summarizeDevice) : resp.payload.attributes;
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── get_device ───────────────────────────────────────────────────────
  server.tool(
    "get_device",
    "Get full state and attributes of a specific device",
    { deviceAddress: z.string().describe("Device address (e.g. DRIV:dev:abc-123)") },
    async ({ deviceAddress }) => {
      await ensureConnected();
      const resp = await client.sendRequest(
        deviceAddress,
        "base:GetAttributes",
        {}
      );
      return { content: [{ type: "text", text: JSON.stringify(resp.payload, null, 2) }] };
    }
  );

  // ── device_command ───────────────────────────────────────────────────
  server.tool(
    "device_command",
    `Send a command to a device. Examples:
- Turn on switch: commandName="swit:SetAttributes", attributes={"swit:state":"ON"}
- Lock door: commandName="doorlock:SetAttributes", attributes={"doorlock:lockstate":"LOCKED"}
- Set thermostat: commandName="therm:SetAttributes", attributes={"therm:heatsetpoint":72}
- Dim light: commandName="dim:SetAttributes", attributes={"dim:brightness":50}`,
    {
      deviceAddress: z.string().describe("Device address (e.g. DRIV:dev:abc-123)"),
      commandName: z.string().describe("Command message type (e.g. swit:SetAttributes)"),
      attributes: z
        .record(z.string(), z.unknown())
        .default({})
        .describe("Command attributes as key-value pairs"),
    },
    async ({ deviceAddress, commandName, attributes }) => {
      await ensureConnected();
      if (BLOCKED_MESSAGE_TYPES.has(commandName)) {
        return { content: [{ type: "text", text: `Blocked: "${commandName}" is a destructive operation and is not allowed.` }], isError: true };
      }
      const resp = await client.sendRequest(deviceAddress, commandName, attributes);
      return { content: [{ type: "text", text: JSON.stringify(resp.payload, null, 2) }] };
    }
  );

  // ── list_rules ──────────────────────────────────────────────────────
  server.tool(
    "list_rules",
    "List all rules at the active place",
    {},
    async () => {
      await ensureConnected();
      const placeId = client.activePlaceId;
      if (!placeId) {
        return { content: [{ type: "text", text: "No active place set. Call set_active_place first." }], isError: true };
      }
      const resp = await client.sendRequest("SERV:rule:", "rule:ListRules", { placeId });
      const rules = resp.payload.attributes.rules as Array<Record<string, unknown>> | undefined;
      const summary = rules ? rules.map(summarizeRule) : resp.payload.attributes;
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── delete_rule ────────────────────────────────────────────────────
  server.tool(
    "delete_rule",
    "Delete a rule at the active place",
    {
      ruleAddress: z.string().describe("Rule address (e.g. SERV:rule:place-id.1)"),
    },
    async ({ ruleAddress }) => {
      await ensureConnected();
      const resp = await client.sendRequest(ruleAddress, "rule:Delete", {});
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? "Rule deleted." : JSON.stringify(resp.payload, null, 2) }] };
    }
  );

  // ── list_rule_templates ─────────────────────────────────────────────
  server.tool(
    "list_rule_templates",
    "List available rule templates at the active place. With no category, returns category names and counts. With a category, returns templates in that category.",
    {
      category: z.string().optional().describe("Filter by category name (e.g. \"Security Alarm\", \"Doors & Locks\"). Omit to list categories."),
    },
    async ({ category }) => {
      await ensureConnected();
      const placeId = client.activePlaceId;
      if (!placeId) {
        return { content: [{ type: "text", text: "No active place set. Call set_active_place first." }], isError: true };
      }

      if (!category) {
        // Return categories and counts
        const resp = await client.sendRequest("SERV:rule:", "rule:GetCategories", { placeId });
        return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes.categories, null, 2) }] };
      }

      // Return templates filtered by category
      const resp = await client.sendRequest("SERV:rule:", "rule:ListRuleTemplates", { placeId });
      const templates = resp.payload.attributes.ruleTemplates as Array<Record<string, unknown>> | undefined;
      const summary = templates
        ? templates
            .filter((t) => t["ruletmpl:satisfiable"] && (t["ruletmpl:categories"] as string[] | undefined)?.includes(category))
            .map((t) => ({
              id: t["base:id"],
              template: t["ruletmpl:template"],
              categories: t["ruletmpl:categories"],
              premium: t["ruletmpl:premium"],
            }))
        : resp.payload.attributes;
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── resolve_rule_template ──────────────────────────────────────────
  server.tool(
    "resolve_rule_template",
    "Resolve a rule template's variables, returning the valid options for each selector (devices, persons, values, etc.)",
    {
      templateId: z.string().describe("Rule template ID (e.g. button-chime, 61da3b)"),
    },
    async ({ templateId }) => {
      await ensureConnected();
      const placeId = client.activePlaceId;
      if (!placeId) {
        return { content: [{ type: "text", text: "No active place set. Call set_active_place first." }], isError: true };
      }
      const resp = await client.sendRequest(
        `SERV:ruletmpl:${templateId}`,
        "ruletmpl:Resolve",
        { placeId }
      );
      const selectors = resp.payload.attributes.selectors as Record<string, unknown> | undefined;
      if (!selectors) {
        return { content: [{ type: "text", text: JSON.stringify(resp.payload, null, 2) }] };
      }
      // Summarize selectors: show name/address pairs for LIST types
      const summary: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(selectors)) {
        const sel = val as Record<string, unknown>;
        if (sel.type === "LIST" && Array.isArray(sel.options)) {
          summary[key] = {
            type: "LIST",
            options: (sel.options as Array<[string, string]>).map(([name, addr]) => ({ name, address: addr })),
          };
        } else {
          summary[key] = sel;
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── create_rule ────────────────────────────────────────────────────
  server.tool(
    "create_rule",
    `Create a rule from a template. Use list_rule_templates to find available templates and their variables. The context maps template variables (e.g. "button", "switch", "contact") to device/person addresses.`,
    {
      templateId: z.string().describe("Rule template ID (e.g. button-chime, 61da3b)"),
      name: z.string().describe("Name for the rule"),
      description: z.string().describe("Description of the rule"),
      context: z
        .record(z.string(), z.string())
        .describe("Template variable mappings (e.g. {\"button\": \"DRIV:dev:abc-123\"})"),
    },
    async ({ templateId, name, description, context }) => {
      await ensureConnected();
      const placeId = client.activePlaceId;
      if (!placeId) {
        return { content: [{ type: "text", text: "No active place set. Call set_active_place first." }], isError: true };
      }
      const resp = await client.sendRequest(
        `SERV:ruletmpl:${templateId}`,
        "ruletmpl:CreateRule",
        { placeId, name, description, context }
      );
      return { content: [{ type: "text", text: JSON.stringify(resp.payload, null, 2) }] };
    }
  );

  // ── list_incidents ──────────────────────────────────────────────────
  server.tool(
    "list_incidents",
    "List alarm incidents at the active place",
    {},
    async () => {
      await ensureConnected();
      const placeId = client.activePlaceId;
      if (!placeId) {
        return { content: [{ type: "text", text: "No active place set. Call set_active_place first." }], isError: true };
      }
      const resp = await client.sendRequest(
        `SERV:subalarm:${placeId}`,
        "subalarm:ListIncidents",
        {}
      );
      const incidents = resp.payload.attributes.incidents as Array<Record<string, unknown>> | undefined;
      const summary = incidents ? incidents.map(summarizeIncident) : resp.payload.attributes;
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── list_scenes ──────────────────────────────────────────────────────
  server.tool(
    "list_scenes",
    "List all scenes at the active place",
    {},
    async () => {
      await ensureConnected();
      const placeId = client.activePlaceId;
      if (!placeId) {
        return { content: [{ type: "text", text: "No active place set. Call set_active_place first." }], isError: true };
      }
      const resp = await client.sendRequest("SERV:scene:", "scene:ListScenes", { placeId });
      const scenes = resp.payload.attributes.scenes as Array<Record<string, unknown>> | undefined;
      const summary = scenes ? scenes.map(summarizeScene) : resp.payload.attributes;
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── arm_alarm ───────────────────────────────────────────────────────
  server.tool(
    "arm_alarm",
    `Arm the alarm at the active place. Modes: "ON" (full), "PARTIAL" (perimeter only). If bypass is true, triggered devices will be bypassed automatically.`,
    {
      mode: z.enum(["ON", "PARTIAL"]).describe("Alarm mode: ON (full) or PARTIAL (perimeter only)"),
      bypass: z.boolean().default(false).describe("Bypass triggered devices if arming fails (default false)"),
    },
    async ({ mode, bypass }) => {
      await ensureConnected();
      const placeId = client.activePlaceId;
      if (!placeId) {
        return { content: [{ type: "text", text: "No active place set. Call set_active_place first." }], isError: true };
      }
      const dest = `SERV:subalarm:${placeId}`;
      const msgType = bypass ? "subalarm:ArmBypassed" : "subalarm:Arm";
      const resp = await client.sendRequest(dest, msgType, { mode });

      if (resp.payload.messageType === "Error" && !bypass) {
        const code = resp.payload.attributes.code as string;
        if (code === "security.triggeredDevices") {
          return {
            content: [{
              type: "text",
              text: `Cannot arm — triggered devices: ${resp.payload.attributes.message}\nUse bypass=true to arm anyway.`,
            }],
            isError: true,
          };
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(resp.payload, null, 2) }] };
    }
  );

  // ── disarm_alarm ──────────────────────────────────────────────────────
  server.tool(
    "disarm_alarm",
    "Disarm the alarm at the active place",
    {},
    async () => {
      await ensureConnected();
      const placeId = client.activePlaceId;
      if (!placeId) {
        return { content: [{ type: "text", text: "No active place set. Call set_active_place first." }], isError: true };
      }
      const resp = await client.sendRequest(`SERV:subalarm:${placeId}`, "subalarm:Disarm", {});
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? "Alarm disarmed." : JSON.stringify(resp.payload, null, 2) }] };
    }
  );

  // ── get_hub ────────────────────────────────────────────────────────────
  server.tool(
    "get_hub",
    "Get hub status at the active place",
    {},
    async () => {
      await ensureConnected();
      const resp = await client.sendRequest(client.placeDestination, "place:GetHub", {});
      return { content: [{ type: "text", text: JSON.stringify(summarizeHub(resp.payload.attributes), null, 2) }] };
    }
  );

  // ── reboot_hub ──────────────────────────────────────────────────────────
  server.tool(
    "reboot_hub",
    "Reboot the hub at the active place. The hub will go offline temporarily.",
    {},
    async () => {
      await ensureConnected();
      const hubResp = await client.sendRequest(client.placeDestination, "place:GetHub", {});
      const hub = hubResp.payload.attributes.hub as Record<string, unknown> | undefined;
      if (!hub) {
        return { content: [{ type: "text", text: "No hub found at active place." }], isError: true };
      }
      const hubAddress = hub["base:address"] as string;
      const hubId = hub["base:id"] as string;
      const resp = await client.sendRequest(hubAddress, "hubadv:Reboot", {});
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? `Hub ${hubId} is rebooting.` : JSON.stringify(resp.payload, null, 2) }] };
    }
  );

  // ── list_subsystems ────────────────────────────────────────────────────
  server.tool(
    "list_subsystems",
    "List all subsystems at the active place",
    {},
    async () => {
      await ensureConnected();
      const placeId = client.activePlaceId;
      if (!placeId) {
        return { content: [{ type: "text", text: "No active place set. Call set_active_place first." }], isError: true };
      }
      const resp = await client.sendRequest("SERV:subs:", "subs:ListSubsystems", { placeId });
      return { content: [{ type: "text", text: JSON.stringify(summarizeSubsystems(resp.payload.attributes), null, 2) }] };
    }
  );

  // ── fire_scene ───────────────────────────────────────────────────────
  server.tool(
    "fire_scene",
    "Execute (fire) a scene",
    { sceneAddress: z.string().describe("Scene address (e.g. SERV:scene:abc-123)") },
    async ({ sceneAddress }) => {
      await ensureConnected();
      const resp = await client.sendRequest(sceneAddress, "scene:Fire", {});
      return { content: [{ type: "text", text: JSON.stringify(resp.payload, null, 2) }] };
    }
  );

  // ── list_events ─────────────────────────────────────────────────────
  server.tool(
    "list_events",
    "Drain buffered platform events (device state changes, alarm triggers, etc.) received since the last call. Returns and clears the buffer.",
    {},
    async () => {
      await ensureConnected();
      const events = client.drainEvents();
      if (events.length === 0) {
        return { content: [{ type: "text", text: "No new events." }] };
      }
      const summary = events.map((e) => ({
        timestamp: new Date(e.timestamp).toISOString(),
        type: e.messageType,
        source: e.source,
        attributes: e.attributes,
      }));
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  // ── send_message (escape hatch) ──────────────────────────────────────
  server.tool(
    "send_message",
    "Send an arbitrary message to the Arcus platform (advanced/escape hatch)",
    {
      destination: z.string().describe("Message destination (e.g. SERV:sess:, DRIV:dev:abc)"),
      messageType: z.string().describe("Message type (e.g. sess:SetActivePlace)"),
      attributes: z
        .record(z.string(), z.unknown())
        .default({})
        .describe("Message attributes"),
    },
    async ({ destination, messageType, attributes }) => {
      await ensureConnected();
      if (BLOCKED_MESSAGE_TYPES.has(messageType)) {
        return { content: [{ type: "text", text: `Blocked: "${messageType}" is a destructive operation and is not allowed.` }], isError: true };
      }
      const resp = await client.sendRequest(destination, messageType, attributes);
      return { content: [{ type: "text", text: JSON.stringify(resp.payload, null, 2) }] };
    }
  );
}
