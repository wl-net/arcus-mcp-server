import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeClient } from "./bridge-client.js";
import {
  Account, AlarmIncident, AlarmSubsystem, Base, Contact, Device, DeviceAdvanced,
  DeviceConnection, DevicePower, Dimmer, DoorLock, Glass, Hub, HubAdvanced,
  HubAlarm, HubConnection, HubDebug, HubPower, HubZigbee, HubZwave, Identify,
  Motion, PairingSubsystem, Person, PersonService, Place, Presence, RelativeHumidity,
  Rule, RuleService, RuleTemplate, Scene, SceneService, SessionService, Subsystem,
  SubsystemService, Switch, Temperature, Thermostat,
} from "./capabilities.js";

const SESS_DEST = "SERV:sess:";
const WRITE_ENABLED = !!process.env.ARCUS_ENABLE_WRITE;
const ADMIN_ENABLED = !!process.env.ARCUS_ENABLE_ADMIN;

// Destructive message types that should never be sent
const BLOCKED_MESSAGE_TYPES = new Set([
  Account.CMD_DELETE,
  Hub.CMD_DELETE,
  "hub:Deregister",
  HubAdvanced.CMD_FACTORYRESET,
  Place.CMD_DELETE,
  "place:RemoveDevice",
  "place:RemovePerson",
  Person.CMD_DELETE,
  Person.CMD_REMOVEFROMPLACE,
  Person.CMD_CHANGEPIN,
  "person:SetPassword",
  PersonService.CMD_CHANGEPASSWORD,
  Device.CMD_REMOVE,
  Device.CMD_FORCEREMOVE,
  Scene.CMD_DELETE,
  Rule.CMD_DELETE,
  "base:Remove",
]);

// ── Response summarizers ───────────────────────────────────────────────

function summarizeHub(attrs: Record<string, unknown>): unknown {
  const hub = attrs.hub as Record<string, unknown> | undefined;
  if (!hub) return attrs;
  return {
    id: hub[Base.ATTR_ID],
    name: hub[Hub.ATTR_NAME],
    model: hub[Hub.ATTR_MODEL],
    state: hub[Hub.ATTR_STATE],
    conn: hub[HubConnection.ATTR_STATE],
    fw: hub[HubAdvanced.ATTR_AGENTVER],
    os: hub[HubAdvanced.ATTR_OSVER],
    power: hub[HubPower.ATTR_SOURCE],
    batt: hub[HubPower.ATTR_BATTERY],
    security: hub[HubAlarm.ATTR_SECURITYMODE],
    alarm: hub[HubAlarm.ATTR_ALARMSTATE],
    zwave: hub[HubZwave.ATTR_NUMDEVICES],
    zigbeeCh: hub[HubZigbee.ATTR_CHANNEL],
  };
}

function summarizeSubsystems(attrs: Record<string, unknown>): unknown {
  const subs = attrs.subsystems as Array<Record<string, unknown>> | undefined;
  if (!subs) return attrs;
  return subs.map((s) => ({
    name: s[Subsystem.ATTR_NAME],
    address: s[Base.ATTR_ADDRESS],
    state: s[Subsystem.ATTR_STATE],
    available: s[Subsystem.ATTR_AVAILABLE],
  }));
}

function summarizePerson(attrs: Record<string, unknown>): unknown {
  return {
    name: `${attrs[Person.ATTR_FIRSTNAME]} ${attrs[Person.ATTR_LASTNAME]}`,
    email: attrs[Person.ATTR_EMAIL],
    mobile: attrs[Person.ATTR_MOBILENUMBER],
    place: attrs[Person.ATTR_CURRPLACE],
  };
}

function summarizeDevice(d: Record<string, unknown>, catalog?: Map<string, { batterySize: string; batteryNum: number }> | null): unknown {
  const caps = d[Base.ATTR_CAPS] as string[] | undefined;
  const proto = d[DeviceAdvanced.ATTR_PROTOCOL] as string | undefined;
  const summary: Record<string, unknown> = {
    name: d[Device.ATTR_NAME],
    addr: d[Base.ATTR_ADDRESS],
    type: d[Device.ATTR_DEVTYPEHINT],
    vendor: d[Device.ATTR_VENDOR],
    model: d[Device.ATTR_MODEL],
    conn: d[DeviceConnection.ATTR_STATE],
    proto,
  };
  if (proto === "ZWAV") {
    const rawId = d[DeviceAdvanced.ATTR_PROTOCOLID];
    if (rawId != null) {
      const nodeId = zwaveNodeId(String(rawId));
      if (nodeId != null) summary.node = nodeId;
    }
  }

  if (caps?.includes(Switch.NAMESPACE)) summary.switch = d[Switch.ATTR_STATE];
  if (caps?.includes(Dimmer.NAMESPACE)) summary.dim = d[Dimmer.ATTR_BRIGHTNESS];
  if (caps?.includes(Temperature.NAMESPACE)) summary.temp = d[Temperature.ATTR_TEMPERATURE];
  if (caps?.includes(RelativeHumidity.NAMESPACE)) summary.humid = d[RelativeHumidity.ATTR_HUMIDITY];
  if (caps?.includes(Thermostat.NAMESPACE)) {
    summary.mode = d[Thermostat.ATTR_HVACMODE];
    summary.heat = d[Thermostat.ATTR_HEATSETPOINT];
    summary.cool = d[Thermostat.ATTR_COOLSETPOINT];
  }
  if (caps?.includes(Contact.NAMESPACE)) summary.contact = d[Contact.ATTR_CONTACT];
  if (caps?.includes(Motion.NAMESPACE)) summary.motion = d[Motion.ATTR_MOTION];
  if (caps?.includes(DoorLock.NAMESPACE)) summary.lock = d[DoorLock.ATTR_LOCKSTATE];
  if (caps?.includes(Glass.NAMESPACE)) summary.glass = d[Glass.ATTR_BREAK];
  if (caps?.includes(Presence.NAMESPACE)) summary.presence = d[Presence.ATTR_PRESENCE];
  if (caps?.includes(DevicePower.NAMESPACE) && d[DevicePower.ATTR_SOURCE] === DevicePower.SOURCE_BATTERY) {
    summary.batt = d[DevicePower.ATTR_BATTERY];
    if (catalog) {
      const productId = d[Device.ATTR_PRODUCTID] as string | undefined;
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
    addr: i[Base.ATTR_ADDRESS],
    alert: i[AlarmIncident.ATTR_ALERT],
    state: i[AlarmIncident.ATTR_ALERTSTATE],
    confirmed: i[AlarmIncident.ATTR_CONFIRMED],
    cancelled: i[AlarmIncident.ATTR_CANCELLED],
    cancelledBy: i[AlarmIncident.ATTR_CANCELLEDBY],
    start: i[AlarmIncident.ATTR_STARTTIME],
    end: i[AlarmIncident.ATTR_ENDTIME],
    monitored: i[AlarmIncident.ATTR_MONITORED],
  };
}

function summarizeScene(s: Record<string, unknown>): unknown {
  const summary: Record<string, unknown> = {
    name: s[Scene.ATTR_NAME],
    addr: s[Base.ATTR_ADDRESS],
  };
  if (s[Scene.ATTR_ENABLED] === false) summary.off = true;
  return summary;
}

function summarizeRule(r: Record<string, unknown>): unknown {
  return {
    name: r[Rule.ATTR_NAME],
    addr: r[Base.ATTR_ADDRESS],
    desc: r[Rule.ATTR_DESCRIPTION],
    state: r[Rule.ATTR_STATE],
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
  const hubResp = await client.sendRequest(client.placeDestination, Place.CMD_GETHUB, {});
  const hub = hubResp.payload.attributes.hub as Record<string, unknown> | undefined;
  if (!hub) {
    return { content: [{ type: "text" as const, text: "No hub found at active place." }], isError: true };
  }
  return { address: hub[Base.ATTR_ADDRESS] as string, id: hub[Base.ATTR_ID] as string };
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
        Person.CMD_LISTAVAILABLEPLACES,
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
        client.sendRequest(SESS_DEST, SessionService.CMD_SETACTIVEPLACE, { placeId }),
        personId
          ? client.sendRequest(`SERV:person:${personId}`, Base.CMD_GETATTRIBUTES, {})
          : Promise.resolve(null),
      ]);
      client.setActivePlace(placeId);

      // Phase 2: After SetActivePlaceResponse, send GetHub + ListSubsystems
      const placeDest = client.placeDestination;
      const [hubResp, subsResp] = await Promise.all([
        client.sendRequest(placeDest, Place.CMD_GETHUB, {}),
        client.sendRequest("SERV:subs:", SubsystemService.CMD_LISTSUBSYSTEMS, { placeId }),
      ]);

      const subs = subsResp.payload.attributes.subsystems as Array<Record<string, unknown>> | undefined;
      const summary = {
        place: resp.payload.attributes,
        ...(personResp ? { person: summarizePerson(personResp.payload.attributes) } : {}),
        hub: summarizeHub(hubResp.payload.attributes),
        subsystems: subs?.map((s) => s[Subsystem.ATTR_NAME]) ?? [],
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
      const resp = await client.sendRequest(client.placeDestination, Place.CMD_LISTHISTORYENTRIES, { limit });
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
      const resp = await client.sendRequest(client.placeDestination, Place.CMD_LISTPERSONS, {});
      const persons = resp.payload.attributes.persons as Array<Record<string, unknown>> | undefined;
      const summary = persons
        ? persons.map((p) => ({
            name: `${p[Person.ATTR_FIRSTNAME]} ${p[Person.ATTR_LASTNAME]}`,
            addr: p[Base.ATTR_ADDRESS],
            email: p[Person.ATTR_EMAIL],
            mobile: p[Person.ATTR_MOBILENUMBER],
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
        client.sendRequest(client.placeDestination, Place.CMD_LISTDEVICES, {}),
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
        Base.CMD_GETATTRIBUTES,
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
            const resp = await client.sendRequest(addr, Base.CMD_GETATTRIBUTES, {});
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
      const resp = await client.sendRequest(deviceAddress, Identify.CMD_IDENTIFY, {});
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
      const resp = await client.sendRequest(deviceAddress, DoorLock.CMD_BUZZIN, {});
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
      const resp = await client.sendRequest(deviceAddress, DoorLock.CMD_AUTHORIZEPERSON, { personId });
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
      const resp = await client.sendRequest(deviceAddress, DoorLock.CMD_DEAUTHORIZEPERSON, { personId });
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
      const resp = await client.sendRequest("SERV:rule:", RuleService.CMD_LISTRULES, { placeId });
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
      const resp = await client.sendRequest(ruleAddress, Rule.CMD_DELETE, {});
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
      const resp = await client.sendRequest(ruleAddress, Rule.CMD_ENABLE, {});
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
      const resp = await client.sendRequest(ruleAddress, Rule.CMD_DISABLE, {});
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
        const resp = await client.sendRequest("SERV:rule:", RuleService.CMD_GETCATEGORIES, { placeId });
        return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes.categories) }] };
      }

      // Return templates filtered by category
      const resp = await client.sendRequest("SERV:rule:", RuleService.CMD_LISTRULETEMPLATES, { placeId });
      const templates = resp.payload.attributes.ruleTemplates as Array<Record<string, unknown>> | undefined;
      const summary = templates
        ? templates
            .filter((t) => t[RuleTemplate.ATTR_SATISFIABLE] && (t[RuleTemplate.ATTR_CATEGORIES] as string[] | undefined)?.includes(category))
            .map((t) => ({
              id: t[Base.ATTR_ID],
              template: t[RuleTemplate.ATTR_TEMPLATE],
              categories: t[RuleTemplate.ATTR_CATEGORIES],
              premium: t[RuleTemplate.ATTR_PREMIUM],
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
        RuleTemplate.CMD_RESOLVE,
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
        RuleTemplate.CMD_CREATERULE,
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
        AlarmSubsystem.CMD_LISTINCIDENTS,
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
      const resp = await client.sendRequest("SERV:scene:", SceneService.CMD_LISTSCENES, { placeId });
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
      const msgType = bypass ? AlarmSubsystem.CMD_ARMBYPASSED : AlarmSubsystem.CMD_ARM;
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
      const resp = await client.sendRequest(`SERV:subalarm:${placeId}`, AlarmSubsystem.CMD_DISARM, {});
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
      const resp = await client.sendRequest(client.placeDestination, Place.CMD_GETHUB, {});
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
      const hubResp = await client.sendRequest(client.placeDestination, Place.CMD_GETHUB, {});
      const hub = hubResp.payload.attributes.hub as Record<string, unknown> | undefined;
      if (!hub) {
        return { content: [{ type: "text", text: "No hub found at active place." }], isError: true };
      }
      const hubAddress = hub[Base.ATTR_ADDRESS] as string;
      const hubId = hub[Base.ATTR_ID] as string;
      const resp = await client.sendRequest(hubAddress, HubAdvanced.CMD_REBOOT, {});
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
        client.sendRequest(hub.address, HubZwave.CMD_NETWORKINFORMATION, {}),
        client.sendRequest(client.placeDestination, Place.CMD_LISTDEVICES, {}),
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
      const resp = await client.sendRequest(hub.address, HubZwave.CMD_HEAL, { block });
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
      const resp = await client.sendRequest(hub.address, HubZwave.CMD_CANCELHEAL, {});
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
      const resp = await client.sendRequest(hub.address, HubZwave.CMD_REMOVEZOMBIE, { node });
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
      const resp = await client.sendRequest(hub.address, HubZigbee.CMD_NETWORKINFORMATION, {});
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
      const resp = await client.sendRequest(hub.address, HubZigbee.CMD_GETSTATS, {});
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
      const resp = await client.sendRequest(hub.address, HubZigbee.CMD_SCAN, {});
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
      const resp = await client.sendRequest(hub.address, HubDebug.CMD_GETSYSLOG, {});
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes) }] };
    });

    server.tool("hub_bootlog", "Get hub boot log", {}, async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, HubDebug.CMD_GETBOOTLOG, {});
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes) }] };
    });

    server.tool("hub_processes", "Get running processes on the hub", {}, async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, HubDebug.CMD_GETPROCESSES, {});
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes) }] };
    });

    server.tool("hub_load", "Get system load on the hub", {}, async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, HubDebug.CMD_GETLOAD, {});
      return { content: [{ type: "text", text: JSON.stringify(resp.payload.attributes) }] };
    });

    server.tool("hub_agent_db", "Get hub agent database", {}, async () => {
      const noPlace = requirePlace(client);
      if (noPlace) return noPlace;
      await ensureConnected();
      const hub = await getHubAddress(client);
      if ("isError" in hub) return hub;
      const resp = await client.sendRequest(hub.address, HubDebug.CMD_GETAGENTDB, {});
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
      const resp = await client.sendRequest(hub.address, HubDebug.CMD_GETFILES, { paths });
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
      const resp = await client.sendRequest("SERV:subs:", SubsystemService.CMD_LISTSUBSYSTEMS, { placeId });
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

      const startResp = await client.sendRequest(dest, PairingSubsystem.CMD_STARTPAIRING, attrs);
      const searchResp = await client.sendRequest(dest, PairingSubsystem.CMD_SEARCH, {
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
      const resp = await client.sendRequest(sceneAddress, Scene.CMD_FIRE, {});
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
