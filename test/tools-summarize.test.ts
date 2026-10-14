import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeZwaveAddressArray, decodeZwaveKeys, summarizeDevice, summarizeHub, summarizePerson,
  summarizeScene, summarizeSubsystems, summarizeZwaveNetwork, zwaveNodeId,
} from "../src/tools/summarize.js";

/** Base64 hub address key whose first byte is the Z-Wave node ID */
const key = (node: number) => Buffer.from([node, 0, 0, 0]).toString("base64");

describe("Z-Wave decoding", () => {
  it("reads the node ID from byte 0 of a base64 key", () => {
    assert.equal(zwaveNodeId(key(5)), 5);
    assert.equal(zwaveNodeId(key(232)), 232);
    assert.equal(zwaveNodeId(""), null);
  });

  it("rekeys objects and decodes address arrays", () => {
    assert.deepEqual(decodeZwaveKeys({ [key(3)]: "a", [key(7)]: "b" }), { "3": "a", "7": "b" });
    assert.deepEqual(decodeZwaveAddressArray([key(1), 42, key(9)]), [1, 9]);
  });

  it("summarizes network info into node IDs and drops the graph blob", () => {
    const summary = summarizeZwaveNetwork(
      {
        metrics: { [key(2)]: { rtt: 10 } },
        neighbors: { [key(2)]: [key(1), key(3)] },
        route: { [key(3)]: { route: [key(2), key(1)], hops: 2 } },
        routing: { [key(2)]: "ok" },
        zombies: { [key(9)]: true },
        graph: "huge-blob",
      },
      { "2": "Porch Light" }
    );
    assert.deepEqual(summary, {
      nodeDeviceMap: { "2": "Porch Light" },
      metrics: { "2": { rtt: 10 } },
      neighbors: { "2": [1, 3] },
      route: { "3": { route: [2, 1], hops: 2 } },
      routing: { "2": "ok" },
      zombies: [9],
    });
  });
});

describe("summarizers", () => {
  it("summarizes a device by capability, with Z-Wave node and battery type", () => {
    const catalog = new Map([["prod-1", { batterySize: "CR123", batteryNum: 2 }]]);
    const summary = summarizeDevice(
      {
        "dev:name": "Front Door",
        "base:address": "DRIV:dev:1",
        "base:caps": ["base", "dev", "doorlock", "devpow", "cont"],
        "devadv:protocol": "ZWAV",
        "devadv:protocolid": key(14),
        "dev:productId": "prod-1",
        "doorlock:lockstate": "LOCKED",
        "cont:contact": "CLOSED",
        "devpow:source": "BATTERY",
        "devpow:battery": 80,
        "swit:state": "ON", // ignored: no swit capability
      },
      catalog
    ) as Record<string, unknown>;
    assert.equal(summary.name, "Front Door");
    assert.equal(summary.node, 14);
    assert.equal(summary.lock, "LOCKED");
    assert.equal(summary.contact, "CLOSED");
    assert.equal(summary.batt, 80);
    assert.equal(summary.battType, "2x CR123");
    assert.equal("switch" in summary, false);
  });

  it("omits battery for line-powered devices", () => {
    const summary = summarizeDevice({
      "base:caps": ["swit", "devpow"],
      "swit:state": "OFF",
      "devpow:source": "LINE",
      "devpow:battery": 0,
    }) as Record<string, unknown>;
    assert.equal(summary.switch, "OFF");
    assert.equal("batt" in summary, false);
  });

  it("rounds temperatures and thermostat setpoints to one decimal", () => {
    const summary = summarizeDevice({
      "base:caps": ["temp", "therm"],
      "temp:temperature": 21.11111111111111,
      "therm:heatsetpoint": 20,
      "therm:coolsetpoint": 22.200000762939453,
    }) as Record<string, unknown>;
    assert.equal(summary.temp, 21.1);
    assert.equal(summary.heat, 20);
    assert.equal(summary.cool, 22.2);
  });

  it("returns raw attributes when there is no hub or subsystem list", () => {
    assert.deepEqual(summarizeHub({ other: 1 }), { other: 1 });
    assert.deepEqual(summarizeSubsystems({ other: 1 }), { other: 1 });
  });

  it("summarizes a hub, person and scene", () => {
    const hub = summarizeHub({ hub: { "base:id": "ABC-1234", "hub:name": "Hub", "hubalarm:securityMode": "OFF" } }) as Record<string, unknown>;
    assert.equal(hub.id, "ABC-1234");
    assert.equal(hub.security, "OFF");
    assert.deepEqual(summarizePerson({ "person:firstName": "Ada", "person:lastName": "L", "person:email": "a@x" }), {
      name: "Ada L", email: "a@x", mobile: undefined, place: undefined,
    });
    assert.deepEqual(summarizeScene({ "scene:name": "Night", "base:address": "SERV:scene:1", "scene:enabled": false }), {
      name: "Night", addr: "SERV:scene:1", off: true,
    });
  });
});
