import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeClient } from "./bridge-client.js";

const SESS_DEST = "SERV:sess:";
const WRITE_ENABLED = !!process.env.ARCUS_ENABLE_WRITE;
const ADMIN_ENABLED = !!process.env.ARCUS_ENABLE_ADMIN;

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
    conn: hub["hubconn:state"],
    fw: hub["hubadv:agentver"],
    os: hub["hubadv:osver"],
    power: hub["hubpow:source"],
    batt: hub["hubpow:Battery"],
    security: hub["hubalarm:securityMode"],
    alarm: hub["hubalarm:alarmState"],
    zwave: hub["hubzwave:numDevices"],
    zigbeeCh: hub["hubzigbee:channel"],
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
    place: attrs["person:currPlace"],
  };
}

function summarizeDevice(d: Record<string, unknown>, catalog?: Map<string, { batterySize: string; batteryNum: number }> | null): unknown {
  const caps = d["base:caps"] as string[] | undefined;
  const proto = d["devadv:protocol"] as string | undefined;
  const summary: Record<string, unknown> = {
    name: d["dev:name"],
    addr: d["base:address"],
    type: d["dev:devtypehint"],
    vendor: d["dev:vendor"],
    model: d["dev:model"],
    conn: d["devconn:state"],
    proto,
  };
  if (proto === "ZWAV") {
    const rawId = d["devadv:protocolid"];
    if (rawId != null) {
      const nodeId = zwaveNodeId(String(rawId));
      if (nodeId != null) summary.node = nodeId;
    }
  }

  if (caps?.includes("swit")) summary.switch = d["swit:state"];
  if (caps?.includes("dim")) summary.dim = d["dim:brightness"];
  if (caps?.includes("temp")) summary.temp = d["temp:temperature"];
  if (caps?.includes("humid")) summary.humid = d["humid:humidity"];
  if (caps?.includes("therm")) {
    summary.mode = d["therm:hvacmode"];
    summary.heat = d["therm:heatsetpoint"];
    summary.cool = d["therm:coolsetpoint"];
  }
  if (caps?.includes("cont")) summary.contact = d["cont:contact"];
  if (caps?.includes("mot")) summary.motion = d["mot:motion"];
  if (caps?.includes("doorlock")) summary.lock = d["doorlock:lockstate"];
  if (caps?.includes("glass")) summary.glass = d["glass:break"];
  if (caps?.includes("pres")) summary.presence = d["pres:presence"];
  if (caps?.includes("devpow") && d["devpow:source"] === "BATTERY") {
    summary.batt = d["devpow:battery"];
    if (catalog) {
      const productId = d["dev:productId"] as string | undefined;
      if (productId) {
        const info = catalog.get(productId);
        if (info) summary.battType = `${info.batteryNum}x ${info.batterySize}`;
      }
    }
  }

  return summary;
}

function summarizeIncident(i: Record<string, unknown>): unknown {
  return {
    addr: i["base:address"],
    alert: i["incident:alert"],
    state: i["incident:alertState"],
    confirmed: i["incident:confirmed"],
    cancelled: i["incident:cancelled"],
    cancelledBy: i["incident:cancelledBy"],
    start: i["incident:startTime"],
    end: i["incident:endTime"],
    monitored: i["incident:monitored"],
  };
}

function summarizeScene(s: Record<string, unknown>): unknown {
  const summary: Record<string, unknown> = {
    name: s["scene:name"],
    addr: s["base:address"],
  };
  if (s["scene:enabled"] === false) summary.off = true;
  return summary;
}

function summarizeRule(r: Record<string, unknown>): unknown {
  return {
    name: r["rule:name"],
    addr: r["base:address"],
    desc: r["rule:description"],
    state: r["rule:state"],
  };
}

/** Extract Z-Wave node ID from a base64-encoded hub address key (node ID is byte 0) */
function zwaveNodeId(base64Key: string): number | null {
  try {
    const buf = Buffer.from(base64Key, "base64");
    return buf.length > 0 ? buf[0] : null;
  } catch {
    return null;
  }
}

/** Rekey an object from base64 hub addresses to numeric Z-Wave node IDs */
function decodeZwaveKeys<T>(obj: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, val] of Object.entries(obj)) {
    const nodeId = zwaveNodeId(key);
    result[nodeId != null ? String(nodeId) : key] = val;
  }
  return result;
}

/** Decode base64 address arrays in Z-Wave neighbor/route data to node ID arrays */
function decodeZwaveAddressArray(arr: unknown[]): number[] {
  return arr
    .map((v) => (typeof v === "string" ? zwaveNodeId(v) : null))
    .filter((n): n is number => n != null);
}

function summarizeZwaveNetwork(
  attrs: Record<string, unknown>,
  nodeNames: Record<string, string>
): unknown {
  const result: Record<string, unknown> = { nodeDeviceMap: nodeNames };

  // Metrics: decode keys
  const metrics = attrs.metrics as Record<string, unknown> | undefined;
  if (metrics) result.metrics = decodeZwaveKeys(metrics);

  // Neighbors: decode keys and value arrays
  const neighbors = attrs.neighbors as Record<string, unknown[]> | undefined;
  if (neighbors) {
    const decoded: Record<string, number[]> = {};
    for (const [key, val] of Object.entries(neighbors)) {
      const nodeId = zwaveNodeId(key);
      decoded[nodeId != null ? String(nodeId) : key] = decodeZwaveAddressArray(val);
    }
    result.neighbors = decoded;
  }

  // Route: decode keys and route arrays within values
  const route = attrs.route as Record<string, Record<string, unknown>> | undefined;
  if (route) {
    const decoded: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(route)) {
      const nodeId = zwaveNodeId(key);
      const entry: Record<string, unknown> = { ...val };
      if (Array.isArray(entry.route)) {
        entry.route = decodeZwaveAddressArray(entry.route);
      }
      decoded[nodeId != null ? String(nodeId) : key] = entry;
    }
    result.route = decoded;
  }

  // Routing: decode keys
  const routing = attrs.routing as Record<string, unknown> | undefined;
  if (routing) result.routing = decodeZwaveKeys(routing);

  // Zombies: decode keys
  const zombies = attrs.zombies as Record<string, unknown> | undefined;
  if (zombies) result.zombies = Object.keys(decodeZwaveKeys(zombies)).map(Number);

  // Skip 'graph' (large compressed blob, not useful as text)
  return result;
}

const WRITE_BLOCKED_MSG = "Write operations are disabled. Set ARCUS_ENABLE_WRITE=1 to enable device commands, alarm control, and other actions.";

type ToolError = { content: Array<{ type: "text"; text: string }>; isError: true };

function requireWrite(): ToolError | null {
  if (WRITE_ENABLED) return null;
  return { content: [{ type: "text" as const, text: WRITE_BLOCKED_MSG }], isError: true };
}

function requirePlace(client: BridgeClient): ToolError | null {
  if (client.activePlaceId) return null;
  return { content: [{ type: "text" as const, text: "No active place set. Call set_active_place first." }], isError: true };
}

async function getHubAddress(client: BridgeClient): Promise<{ address: string; id: string } | ToolError> {
  const hubResp = await client.sendRequest(client.placeDestination, "place:GetHub", {});
  const hub = hubResp.payload.attributes.hub as Record<string, unknown> | undefined;
  if (!hub) {
    return { content: [{ type: "text" as const, text: "No hub found at active place." }], isError: true };
  }
  return { address: hub["base:address"] as string, id: hub["base:id"] as string };
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
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes.places) }] };
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

      const subs = subsResp.payload.attributes.subsystems as Array<Record<string, unknown>> | undefined;
      const summary = {
        place: resp.payload.attributes,
        ...(personResp ? { person: summarizePerson(personResp.payload.attributes) } : {}),
        hub: summarizeHub(hubResp.payload.attributes),
        subsystems: subs?.map((s) => s["subs:name"]) ?? [],
      };

      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
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
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const resp = await client.sendRequest(client.placeDestination, "place:ListHistoryEntries", { limit });
      const results = resp.payload.attributes.results as Array<Record<string, unknown>> | undefined;
      const summary = results
        ? results.map((e) => ({
            ts: e.timestamp,
            key: e.key,
            subject: e.subjectName,
            msg: e.shortMessage,
          }))
        : resp.payload.attributes;
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
    }
  );

  // ── list_persons ────────────────────────────────────────────────────
  server.tool(
    "list_persons",
    "List all persons at the active place",
    {},
    async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const resp = await client.sendRequest(client.placeDestination, "place:ListPersons", {});
      const persons = resp.payload.attributes.persons as Array<Record<string, unknown>> | undefined;
      const summary = persons
        ? persons.map((p) => ({
            name: `${p["person:firstName"]} ${p["person:lastName"]}`,
            addr: p["base:address"],
            email: p["person:email"],
            mobile: p["person:mobileNumber"],
            pin: p["person:hasPin"],
          }))
        : resp.payload.attributes;
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
    }
  );

  // ── list_devices ─────────────────────────────────────────────────────
  server.tool(
    "list_devices",
    "List all devices at the active place",
    {},
    async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const [resp] = await Promise.all([
        client.sendRequest(client.placeDestination, "place:ListDevices", {}),
        client.fetchProductCatalog(),
      ]);
      const devices = resp.payload.attributes.devices as Array<Record<string, unknown>> | undefined;
      const catalog = client.productCatalog;
      const summary = devices ? devices.map((d) => summarizeDevice(d, catalog)) : resp.payload.attributes;
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
    }
  );

  // ── get_device ───────────────────────────────────────────────────────
  server.tool(
    "get_device",
    "Get full state and attributes of a specific device",
    { deviceAddress: z.string().describe("Device address (e.g. DRIV:dev:abc-123)") },
    async ({ deviceAddress }) => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const resp = await client.sendRequest(
        deviceAddress,
        "base:GetAttributes",
        {}
      );
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes) }] };
    }
  );

  // ── get_devices ──────────────────────────────────────────────────────
  server.tool(
    "get_devices",
    "Get full state and attributes of multiple devices in one call",
    {
      deviceAddresses: z
        .array(z.string())
        .describe("Array of device addresses (e.g. [\"DRIV:dev:abc-123\", \"DRIV:dev:def-456\"])"),
    },
    async ({ deviceAddresses }) => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      await client.fetchProductCatalog();
      const catalog = client.productCatalog;
      const results = await Promise.all(
        deviceAddresses.map(async (addr) => {
          try {
            const resp = await client.sendRequest(addr, "base:GetAttributes", {});
            if (resp.payload.messageType === "Error") {
              return { addr, error: resp.payload.attributes.message ?? resp.payload.attributes.code };
            }
            return { ...(summarizeDevice(resp.payload.attributes, catalog) as Record<string, unknown>), addr };
          } catch (err) {
            return { addr, error: (err as Error).message };
          }
        })
      );
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    }
  );

  // ── device_command ───────────────────────────────────────────────────
  server.tool(
    "device_command",
    `Send a command to a device. Examples:
- Turn on switch: commandName="base:SetAttributes", attributes={"swit:state":"ON"}
- Lock door: commandName="base:SetAttributes", attributes={"doorlock:lockstate":"LOCKED"}
- Set thermostat: commandName="base:SetAttributes", attributes={"therm:heatsetpoint":72}
- Dim light: commandName="base:SetAttributes", attributes={"dim:brightness":50}`,
    {
      deviceAddress: z.string().describe("Device address (e.g. DRIV:dev:abc-123)"),
      commandName: z.string().describe("Command message type (e.g. swit:SetAttributes)"),
      attributes: z
        .record(z.string(), z.unknown())
        .default({})
        .describe("Command attributes as key-value pairs"),
    },
    async ({ deviceAddress, commandName, attributes }) => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      if (BLOCKED_MESSAGE_TYPES.has(commandName)) {
        return { content: [{ type: "text", text: `Blocked: "${commandName}" is a destructive operation and is not allowed.` }], isError: true };
      }
      const resp = await client.sendRequest(deviceAddress, commandName, attributes);
      return { content: [{ type: "text", text: JSON.stringify(resp.payload) }] };
    }
  );

  // ── identify_device ──────────────────────────────────────────────────
  server.tool(
    "identify_device",
    "Flash LED or play sound on a device to physically identify it",
    {
      deviceAddress: z.string().describe("Device address (e.g. DRIV:dev:abc-123)"),
    },
    async ({ deviceAddress }) => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const resp = await client.sendRequest(deviceAddress, "ident:Identify", {});
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? `Device ${deviceAddress} is identifying itself.` : JSON.stringify(resp.payload) }] };
    }
  );

  // ── doorlock_buzz_in ──────────────────────────────────────────────────
  server.tool(
    "doorlock_buzz_in",
    "Temporarily unlock a door lock (auto-relocks in 30 seconds)",
    {
      deviceAddress: z.string().describe("Door lock device address (e.g. DRIV:dev:abc-123)"),
    },
    async ({ deviceAddress }) => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const resp = await client.sendRequest(deviceAddress, "doorlock:BuzzIn", {});
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? "Door unlocked (will auto-relock in 30 seconds)." : JSON.stringify(resp.payload) }] };
    }
  );

  // ── doorlock_authorize_person ────────────────────────────────────────
  server.tool(
    "doorlock_authorize_person",
    "Authorize a person's PIN on a door lock",
    {
      deviceAddress: z.string().describe("Door lock device address (e.g. DRIV:dev:abc-123)"),
      personId: z.string().describe("Person ID to authorize (use list_persons to find IDs)"),
    },
    async ({ deviceAddress, personId }) => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const resp = await client.sendRequest(deviceAddress, "doorlock:AuthorizePerson", { personId });
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? `Person ${personId} authorized on lock.` : JSON.stringify(resp.payload) }] };
    }
  );

  // ── doorlock_deauthorize_person ────────────────────────────────────
  server.tool(
    "doorlock_deauthorize_person",
    "Deauthorize a person's PIN from a door lock",
    {
      deviceAddress: z.string().describe("Door lock device address (e.g. DRIV:dev:abc-123)"),
      personId: z.string().describe("Person ID to deauthorize (use list_persons to find IDs)"),
    },
    async ({ deviceAddress, personId }) => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const resp = await client.sendRequest(deviceAddress, "doorlock:DeauthorizePerson", { personId });
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? `Person ${personId} deauthorized from lock.` : JSON.stringify(resp.payload) }] };
    }
  );

  // ── list_rules ──────────────────────────────────────────────────────
  server.tool(
    "list_rules",
    "List all rules at the active place",
    {},
    async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const placeId = client.activePlaceId!;
      const resp = await client.sendRequest("SERV:rule:", "rule:ListRules", { placeId });
      const rules = resp.payload.attributes.rules as Array<Record<string, unknown>> | undefined;
      const summary = rules ? rules.map(summarizeRule) : resp.payload.attributes;
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
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
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const resp = await client.sendRequest(ruleAddress, "rule:Delete", {});
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? "Rule deleted." : JSON.stringify(resp.payload) }] };
    }
  );

  // ── enable_rule ──────────────────────────────────────────────────────
  server.tool(
    "enable_rule",
    "Enable a rule at the active place",
    {
      ruleAddress: z.string().describe("Rule address (e.g. SERV:rule:place-id.1)"),
    },
    async ({ ruleAddress }) => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const resp = await client.sendRequest(ruleAddress, "rule:Enable", {});
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? "Rule enabled." : JSON.stringify(resp.payload) }] };
    }
  );

  // ── disable_rule ─────────────────────────────────────────────────────
  server.tool(
    "disable_rule",
    "Disable a rule at the active place",
    {
      ruleAddress: z.string().describe("Rule address (e.g. SERV:rule:place-id.1)"),
    },
    async ({ ruleAddress }) => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const resp = await client.sendRequest(ruleAddress, "rule:Disable", {});
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? "Rule disabled." : JSON.stringify(resp.payload) }] };
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
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const placeId = client.activePlaceId!;

      if (!category) {
        // Return categories and counts
        const resp = await client.sendRequest("SERV:rule:", "rule:GetCategories", { placeId });
        return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes.categories) }] };
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
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
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
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const placeId = client.activePlaceId!;
      const resp = await client.sendRequest(
        `SERV:ruletmpl:${templateId}`,
        "ruletmpl:Resolve",
        { placeId }
      );
      const selectors = resp.payload.attributes.selectors as Record<string, unknown> | undefined;
      if (!selectors) {
        return { content: [{ type: "text", text: JSON.stringify(resp.payload) }] };
      }
      // Summarize selectors: show name/address pairs for LIST types
      const summary: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(selectors)) {
        const sel = val as Record<string, unknown>;
        if (sel.type === "LIST" && Array.isArray(sel.options)) {
          summary[key] = {
            type: "LIST",
            options: (sel.options as Array<[string, string]>).map(([name, addr]) => ({ name, addr })),
          };
        } else {
          summary[key] = sel;
        }
      }
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
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
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const placeId = client.activePlaceId!;
      const resp = await client.sendRequest(
        `SERV:ruletmpl:${templateId}`,
        "ruletmpl:CreateRule",
        { placeId, name, description, context }
      );
      return { content: [{ type: "text", text: JSON.stringify(resp.payload) }] };
    }
  );

  // ── list_incidents ──────────────────────────────────────────────────
  server.tool(
    "list_incidents",
    "List alarm incidents at the active place",
    {},
    async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const placeId = client.activePlaceId!;
      const resp = await client.sendRequest(
        `SERV:subalarm:${placeId}`,
        "subalarm:ListIncidents",
        {}
      );
      const incidents = resp.payload.attributes.incidents as Array<Record<string, unknown>> | undefined;
      const summary = incidents ? incidents.map(summarizeIncident) : resp.payload.attributes;
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
    }
  );

  // ── list_scenes ──────────────────────────────────────────────────────
  server.tool(
    "list_scenes",
    "List all scenes at the active place",
    {},
    async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const placeId = client.activePlaceId!;
      const resp = await client.sendRequest("SERV:scene:", "scene:ListScenes", { placeId });
      const scenes = resp.payload.attributes.scenes as Array<Record<string, unknown>> | undefined;
      const summary = scenes ? scenes.map(summarizeScene) : resp.payload.attributes;
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
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
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const placeId = client.activePlaceId!;
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

      return { content: [{ type: "text", text: JSON.stringify(resp.payload) }] };
    }
  );

  // ── disarm_alarm ──────────────────────────────────────────────────────
  server.tool(
    "disarm_alarm",
    "Disarm the alarm at the active place",
    {},
    async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const placeId = client.activePlaceId!;
      const resp = await client.sendRequest(`SERV:subalarm:${placeId}`, "subalarm:Disarm", {});
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? "Alarm disarmed." : JSON.stringify(resp.payload) }] };
    }
  );

  // ── get_hub ────────────────────────────────────────────────────────────
  server.tool(
    "get_hub",
    "Get hub status at the active place",
    {},
    async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const resp = await client.sendRequest(client.placeDestination, "place:GetHub", {});
      return { content: [{ type: "text", text: JSON.stringify(summarizeHub(resp.payload.attributes)) }] };
    }
  );

  // ── reboot_hub ──────────────────────────────────────────────────────────
  server.tool(
    "reboot_hub",
    "Reboot the hub at the active place. The hub will go offline temporarily.",
    {},
    async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const hubResp = await client.sendRequest(client.placeDestination, "place:GetHub", {});
      const hub = hubResp.payload.attributes.hub as Record<string, unknown> | undefined;
      if (!hub) {
        return { content: [{ type: "text", text: "No hub found at active place." }], isError: true };
      }
      const hubAddress = hub["base:address"] as string;
      const hubId = hub["base:id"] as string;
      const resp = await client.sendRequest(hubAddress, "hubadv:Reboot", {});
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? `Hub ${hubId} is rebooting.` : JSON.stringify(resp.payload) }] };
    }
  );

  // ── zwave_network_info ──────────────────────────────────────────────────
  server.tool(
    "zwave_network_info",
    "Get Z-Wave network information including node metrics, neighbors, routing, and zombie nodes",
    {},
    async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const [resp, devResp] = await Promise.all([
        client.sendRequest(hub.address, "hubzwave:NetworkInformation", {}),
        client.sendRequest(client.placeDestination, "place:ListDevices", {}),
      ]);

      // Build node ID → device name map from Z-Wave devices
      const devices = devResp.payload.attributes.devices as Array<Record<string, unknown>> | undefined;
      const nodeNames: Record<string, string> = {};
      if (devices) {
        for (const d of devices) {
          if (d["devadv:protocol"] === "ZWAV") {
            const rawId = d["devadv:protocolid"];
            const name = d["dev:name"];
            if (rawId != null && name != null) {
              const nodeId = zwaveNodeId(String(rawId));
              if (nodeId != null) {
                nodeNames[String(nodeId)] = String(name);
              }
            }
          }
        }
      }

      return { content: [{ type: "text", text: JSON.stringify(summarizeZwaveNetwork(resp.payload.attributes, nodeNames)) }] };
    }
  );

  // ── zwave_heal ────────────────────────────────────────────────────────
  server.tool(
    "zwave_heal",
    "Start a Z-Wave network heal. WARNING: interferes with normal Z-Wave operation during healing.",
    {
      block: z.boolean().default(false).describe("Block Z-Wave device control during heal (faster but disruptive)"),
    },
    async ({ block }) => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, "hubzwave:Heal", { block });
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? "Z-Wave network heal started." : JSON.stringify(resp.payload) }] };
    }
  );

  // ── zwave_cancel_heal ─────────────────────────────────────────────────
  server.tool(
    "zwave_cancel_heal",
    "Cancel any Z-Wave network heal in progress",
    {},
    async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, "hubzwave:CancelHeal", {});
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? "Z-Wave heal cancelled." : JSON.stringify(resp.payload) }] };
    }
  );

  // ── zwave_remove_zombie ───────────────────────────────────────────────
  server.tool(
    "zwave_remove_zombie",
    "Remove a zombie node from the Z-Wave network",
    {
      node: z.number().describe("Z-Wave node ID to remove (must be a zombie node)"),
    },
    async ({ node }) => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, "hubzwave:RemoveZombie", { node });
      return { content: [{ type: "text", text: resp.payload.messageType === "EmptyMessage" ? `Zombie node ${node} removed.` : JSON.stringify(resp.payload) }] };
    }
  );

  // ── zigbee_network_info ───────────────────────────────────────────────
  server.tool(
    "zigbee_network_info",
    "Get Zigbee network information",
    {},
    async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, "hubzigbee:NetworkInformation", {});
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes) }] };
    }
  );

  // ── zigbee_get_stats ──────────────────────────────────────────────────
  server.tool(
    "zigbee_get_stats",
    "Get Zigbee radio statistics",
    {},
    async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, "hubzigbee:GetStats", {});
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes) }] };
    }
  );

  // ── zigbee_scan ───────────────────────────────────────────────────────
  server.tool(
    "zigbee_scan",
    "Scan the Zigbee network for devices and channel information",
    {},
    async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, "hubzigbee:Scan", {});
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes) }] };
    }
  );

  // ── Admin-only tools (ARCUS_ENABLE_ADMIN=1) ────────────────────────
  if (ADMIN_ENABLED) {
    server.tool("hub_syslog", "Get hub system log", {}, async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, "hubdebug:GetSyslog", {});
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes) }] };
    });

    server.tool("hub_bootlog", "Get hub boot log", {}, async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, "hubdebug:GetBootlog", {});
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes) }] };
    });

    server.tool("hub_processes", "Get running processes on the hub", {}, async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, "hubdebug:GetProcesses", {});
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes) }] };
    });

    server.tool("hub_load", "Get system load on the hub", {}, async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, "hubdebug:GetLoad", {});
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes) }] };
    });

    server.tool("hub_agent_db", "Get hub agent database", {}, async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, "hubdebug:GetAgentDb", {});
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes) }] };
    });

    server.tool("hub_files", "Get file listing from the hub", {
      paths: z.array(z.string()).describe("List of file/directory paths to return"),
    }, async ({ paths }) => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, "hubdebug:GetFiles", { paths });
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes) }] };
    });
  }

  // ── list_subsystems ────────────────────────────────────────────────────
  server.tool(
    "list_subsystems",
    "List all subsystems at the active place",
    {},
    async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const placeId = client.activePlaceId!;
      const resp = await client.sendRequest("SERV:subs:", "subs:ListSubsystems", { placeId });
      return { content: [{ type: "text", text: JSON.stringify(summarizeSubsystems(resp.payload.attributes)) }] };
    }
  );

  // ── search_devices (pairing) ────────────────────────────────────────
  server.tool(
    "search_devices",
    "Put the hub into pairing/search mode to find new or reconnecting devices. Optionally filter by product ID (e.g. \"7b8fd3\" for Iris WaterSensor). Runs StartPairing then Search.",
    {
      productId: z.string().optional().describe("Product catalog ID to search for (e.g. \"7b8fd3\"). Omit to search for all devices."),
    },
    async ({ productId }) => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const placeId = client.activePlaceId!;
      const dest = `SERV:subpairing:${placeId}`;
      const attrs: Record<string, unknown> = {};
      if (productId) attrs.productAddress = `SERV:product:${productId}`;

      const startResp = await client.sendRequest(dest, "subpairing:StartPairing", attrs);
      const searchResp = await client.sendRequest(dest, "subpairing:Search", {
        ...attrs,
        form: {},
      });

      return {
        content: [{
          type: "text",
          text: `Pairing mode active${productId ? ` (searching for product ${productId})` : ""}. Hub is now searching for devices.\n${JSON.stringify(searchResp.payload)}`,
        }],
      };
    }
  );

  // ── fire_scene ───────────────────────────────────────────────────────
  server.tool(
    "fire_scene",
    "Execute (fire) a scene",
    { sceneAddress: z.string().describe("Scene address (e.g. SERV:scene:abc-123)") },
    async ({ sceneAddress }) => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      const resp = await client.sendRequest(sceneAddress, "scene:Fire", {});
      return { content: [{ type: "text", text: JSON.stringify(resp.payload) }] };
    }
  );

  // ── list_events ─────────────────────────────────────────────────────
  server.tool(
    "list_events",
    "Drain buffered platform events (device state changes, alarm triggers, etc.) received since the last call. Returns and clears the buffer. Excludes noisy subcare/subsafety events — use list_care_status for those.",
    {},
    async () => {
      await ensureConnected();
      const events = client.drainEvents();
      // Filter out subcare/subsafety noise
      const CARE_PREFIXES = ["subcare:", "subsafety:"];
      const filtered = events.filter(
        (e) => !CARE_PREFIXES.some((p) => e.messageType.startsWith(p))
      );
      if (filtered.length === 0) {
        return { content: [{ type: "text", text: `No new events. (${events.length - filtered.length} care/safety events filtered)` }] };
      }
      // Group consecutive identical event types for conciseness
      const grouped: Array<{ type: string; source?: string; count: number; firstSeen: string; lastSeen: string; attributes: Record<string, unknown> }> = [];
      for (const e of filtered) {
        const last = grouped[grouped.length - 1];
        if (last && last.type === e.messageType && last.source === e.source) {
          last.count++;
          last.lastSeen = new Date(e.timestamp).toISOString();
          last.attributes = e.attributes; // keep latest
        } else {
          grouped.push({
            type: e.messageType,
            source: e.source,
            count: 1,
            firstSeen: new Date(e.timestamp).toISOString(),
            lastSeen: new Date(e.timestamp).toISOString(),
            attributes: e.attributes,
          });
        }
      }
      // Simplify single-occurrence entries
      const summary = grouped.map((g) =>
        g.count === 1
          ? { ts: g.firstSeen, type: g.type, src: g.source, attrs: g.attributes }
          : { type: g.type, src: g.source, n: g.count, from: g.firstSeen, to: g.lastSeen, attrs: g.attributes }
      );
      const careCount = events.length - filtered.length;
      const header = careCount > 0 ? `${filtered.length} events (${careCount} care/safety events filtered):\n` : "";
      return { content: [{ type: "text", text: header + JSON.stringify(summary) }] };
    }
  );

  // ── list_care_status ──────────────────────────────────────────────────
  server.tool(
    "list_care_status",
    "Get the latest care/safety subsystem status from buffered events. Shows triggered devices, inactive devices, and care behaviors without the noisy per-update spam.",
    {},
    async () => {
      await ensureConnected();
      // Peek at events but don't drain — list_events handles that
      const events = client.peekEvents();
      const CARE_PREFIXES = ["subcare:", "subsafety:"];
      const careEvents = events.filter(
        (e) => CARE_PREFIXES.some((p) => e.messageType.startsWith(p))
      );
      if (careEvents.length === 0) {
        return { content: [{ type: "text", text: "No care/safety events buffered." }] };
      }
      // Deduplicate: keep only the latest event per messageType+source
      const latest = new Map<string, typeof careEvents[0]>();
      for (const e of careEvents) {
        const key = `${e.messageType}|${e.source ?? ""}`;
        latest.set(key, e);
      }
      const summary = Array.from(latest.values()).map((e) => ({
        ts: new Date(e.timestamp).toISOString(),
        type: e.messageType,
        src: e.source,
        attrs: e.attributes,
      }));
      return { content: [{ type: "text", text: `${careEvents.length} care/safety events buffered (showing ${latest.size} latest unique):\n${JSON.stringify(summary)}` }] };
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
      const blocked = requireWrite();
      if (blocked) return blocked;
      await ensureConnected();
      if (BLOCKED_MESSAGE_TYPES.has(messageType)) {
        return { content: [{ type: "text", text: `Blocked: "${messageType}" is a destructive operation and is not allowed.` }], isError: true };
      }
      const resp = await client.sendRequest(destination, messageType, attributes);
      return { content: [{ type: "text", text: JSON.stringify(resp.payload) }] };
    }
  );
}
