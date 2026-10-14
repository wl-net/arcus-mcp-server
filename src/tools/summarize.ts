// Compact summaries of Arcus responses, and Z-Wave address decoding

import {
  AlarmIncident, Base, Contact, Device, DeviceAdvanced, DeviceConnection, DevicePower,
  Dimmer, DoorLock, Glass, Hub, HubAdvanced, HubAlarm, HubConnection, HubPower,
  HubZigbee, HubZwave, Motion, Person, Presence, RelativeHumidity, Rule, Scene,
  Subsystem, Switch, Temperature, Thermostat,
} from "../capabilities.js";

// ── Response summarizers ───────────────────────────────────────────────

export function summarizeHub(attrs: Record<string, unknown>): unknown {
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

export function summarizeSubsystems(attrs: Record<string, unknown>): unknown {
  const subs = attrs.subsystems as Array<Record<string, unknown>> | undefined;
  if (!subs) return attrs;
  return subs.map((s) => ({
    name: s[Subsystem.ATTR_NAME],
    address: s[Base.ATTR_ADDRESS],
    state: s[Subsystem.ATTR_STATE],
    available: s[Subsystem.ATTR_AVAILABLE],
  }));
}

export function summarizePerson(attrs: Record<string, unknown>): unknown {
  return {
    name: `${attrs[Person.ATTR_FIRSTNAME]} ${attrs[Person.ATTR_LASTNAME]}`,
    email: attrs[Person.ATTR_EMAIL],
    mobile: attrs[Person.ATTR_MOBILENUMBER],
    place: attrs[Person.ATTR_CURRPLACE],
  };
}

export function summarizeDevice(d: Record<string, unknown>, catalog?: Map<string, { batterySize: string; batteryNum: number }> | null): unknown {
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

export function summarizeIncident(i: Record<string, unknown>): unknown {
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

export function summarizeScene(s: Record<string, unknown>): unknown {
  const summary: Record<string, unknown> = {
    name: s[Scene.ATTR_NAME],
    addr: s[Base.ATTR_ADDRESS],
  };
  if (s[Scene.ATTR_ENABLED] === false) summary.off = true;
  return summary;
}

export function summarizeRule(r: Record<string, unknown>): unknown {
  return {
    name: r[Rule.ATTR_NAME],
    addr: r[Base.ATTR_ADDRESS],
    desc: r[Rule.ATTR_DESCRIPTION],
    state: r[Rule.ATTR_STATE],
  };
}

/** Extract Z-Wave node ID from a base64-encoded hub address key (node ID is byte 0) */
export function zwaveNodeId(base64Key: string): number | null {
  try {
    const buf = Buffer.from(base64Key, "base64");
    return buf.length > 0 ? buf[0] : null;
  } catch {
    return null;
  }
}

/** Rekey an object from base64 hub addresses to numeric Z-Wave node IDs */
export function decodeZwaveKeys<T>(obj: Record<string, T>): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, val] of Object.entries(obj)) {
    const nodeId = zwaveNodeId(key);
    result[nodeId != null ? String(nodeId) : key] = val;
  }
  return result;
}

/** Decode base64 address arrays in Z-Wave neighbor/route data to node ID arrays */
export function decodeZwaveAddressArray(arr: unknown[]): number[] {
  return arr
    .map((v) => (typeof v === "string" ? zwaveNodeId(v) : null))
    .filter((n): n is number => n != null);
}

export function summarizeZwaveNetwork(
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
