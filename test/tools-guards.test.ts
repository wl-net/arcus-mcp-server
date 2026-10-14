import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BLOCKED_MESSAGE_TYPES, WRITE_BLOCKED_MSG } from "../src/tools/shared.js";
import { FakeBridgeClient, startTools, text, withEnv, type Harness } from "./tools-harness.js";

describe("tool guards", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("refuses writes before connecting when ARCUS_ENABLE_WRITE is unset", async () => {
    await withEnv({ ARCUS_ENABLE_WRITE: undefined }, async () => {
      h = await startTools(new FakeBridgeClient());
      for (const [name, args] of [
        ["doorlock_buzz_in", { deviceAddress: "DRIV:dev:1" }],
        ["disarm_alarm", {}],
        ["send_message", { destination: "SERV:sess:", messageType: "sess:Ping" }],
      ] as const) {
        const result = await h.call(name, args);
        assert.equal(result.isError, true, name);
        assert.equal(text(result), WRITE_BLOCKED_MSG);
      }
      assert.equal(h.connectCalls, 0);
      assert.equal(h.fake.requests.length, 0);
    });
  });

  it("allows reads without ARCUS_ENABLE_WRITE", async () => {
    await withEnv({ ARCUS_ENABLE_WRITE: undefined }, async () => {
      h = await startTools(new FakeBridgeClient());
      const result = await h.call("list_scenes");
      assert.equal(result.isError, undefined);
    });
  });

  it("never sends blocked message types, even with writes enabled", async () => {
    await withEnv({ ARCUS_ENABLE_WRITE: "1" }, async () => {
      h = await startTools(new FakeBridgeClient());
      for (const messageType of BLOCKED_MESSAGE_TYPES) {
        const viaSend = await h.call("send_message", { destination: "SERV:x:", messageType });
        assert.equal(viaSend.isError, true);
        assert.match(text(viaSend), /Blocked: .* is a destructive operation/);

        const viaDevice = await h.call("device_command", { deviceAddress: "DRIV:dev:1", commandName: messageType });
        assert.equal(viaDevice.isError, true);
        assert.match(text(viaDevice), /Blocked/);
      }
      assert.equal(h.fake.requests.length, 0);
    });
  });

  it("covers the account, hub, place, person, device, scene and rule deletions", () => {
    for (const t of ["account:Delete", "hub:Delete", "place:Delete", "person:Delete", "dev:Remove", "dev:ForceRemove", "scene:Delete", "rule:Delete", "hubadv:FactoryReset"]) {
      assert.ok(BLOCKED_MESSAGE_TYPES.has(t), t);
    }
  });

  it("connects before checking for an active place (API-key mode picks it while connecting)", async () => {
    const fake = new FakeBridgeClient();
    fake.activePlaceId = null;
    h = await startTools(fake, async () => {
      fake.activePlaceId = "auto-place";
    });
    const result = await h.call("list_scenes");
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual(fake.sent("scene:ListScenes")[0]?.attributes, { placeId: "auto-place" });
  });

  it("reports a missing active place after connecting", async () => {
    const fake = new FakeBridgeClient();
    fake.activePlaceId = null;
    h = await startTools(fake);
    const result = await h.call("list_devices");
    assert.equal(result.isError, true);
    assert.match(text(result), /No active place set/);
    assert.equal(h.connectCalls, 1);
  });

  it("reports a failed connect as an error result", async () => {
    h = await startTools(new FakeBridgeClient(), async () => {
      throw new Error("Login failed with status 401");
    });
    const result = await h.call("list_places");
    assert.equal(result.isError, true);
    assert.equal(text(result), "Login failed with status 401");
  });

  it("registers admin tools only with ARCUS_ENABLE_ADMIN", async () => {
    const adminTools = ["hub_syslog", "hub_bootlog", "hub_processes", "hub_load", "hub_agent_db", "hub_files"];
    await withEnv({ ARCUS_ENABLE_ADMIN: undefined }, async () => {
      h = await startTools(new FakeBridgeClient());
      const names = (await h.mcp.listTools()).tools.map((t) => t.name);
      for (const name of adminTools) assert.ok(!names.includes(name), name);
      await h.close();
    });
    await withEnv({ ARCUS_ENABLE_ADMIN: "1" }, async () => {
      h = await startTools(new FakeBridgeClient());
      const names = (await h.mcp.listTools()).tools.map((t) => t.name);
      for (const name of adminTools) assert.ok(names.includes(name), name);
    });
  });
});
