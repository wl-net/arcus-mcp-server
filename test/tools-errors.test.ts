import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FakeBridgeClient, errorReply, startTools, text, type FakeReply, type Harness, type SentRequest } from "./tools-harness.js";

const HUB = {
  messageType: "place:GetHubResponse",
  attributes: { hub: { "base:address": "SERV:hub:ABC-1234", "base:id": "ABC-1234" } },
};

/** Answer GetHub with a hub; everything else falls through to fn (default EmptyMessage) */
function withHub(fn: (req: SentRequest) => FakeReply | undefined = () => undefined) {
  return (req: SentRequest) => (req.messageType === "place:GetHub" ? HUB : fn(req));
}

describe("Arcus Error replies", () => {
  let savedWrite: string | undefined;
  let h: Harness | undefined;
  before(() => {
    savedWrite = process.env.ARCUS_ENABLE_WRITE;
    process.env.ARCUS_ENABLE_WRITE = "1";
  });
  after(() => {
    if (savedWrite === undefined) delete process.env.ARCUS_ENABLE_WRITE;
    else process.env.ARCUS_ENABLE_WRITE = savedWrite;
  });
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  // Tool, arguments, and the request that should fail
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["list_places", {}, "person:ListAvailablePlaces"],
    ["list_history", {}, "place:ListHistoryEntries"],
    ["list_persons", {}, "place:ListPersons"],
    ["list_subsystems", {}, "subs:ListSubsystems"],
    ["list_devices", {}, "place:ListDevices"],
    ["get_device", { deviceAddress: "DRIV:dev:1" }, "base:GetAttributes"],
    ["device_command", { deviceAddress: "DRIV:dev:1", commandName: "base:SetAttributes", attributes: { "swit:state": "ON" } }, "base:SetAttributes"],
    ["identify_device", { deviceAddress: "DRIV:dev:1" }, "ident:Identify"],
    ["search_devices", {}, "subpairing:StartPairing"],
    ["search_devices", {}, "subpairing:Search"],
    ["doorlock_buzz_in", { deviceAddress: "DRIV:dev:1" }, "doorlock:BuzzIn"],
    ["doorlock_authorize_person", { deviceAddress: "DRIV:dev:1", personId: "p1" }, "doorlock:AuthorizePerson"],
    ["doorlock_deauthorize_person", { deviceAddress: "DRIV:dev:1", personId: "p1" }, "doorlock:DeauthorizePerson"],
    ["list_rules", {}, "rule:ListRules"],
    ["delete_rule", { ruleAddress: "SERV:rule:place-1.1" }, "rule:Delete"],
    ["enable_rule", { ruleAddress: "SERV:rule:place-1.1" }, "rule:Enable"],
    ["disable_rule", { ruleAddress: "SERV:rule:place-1.1" }, "rule:Disable"],
    ["list_rule_templates", {}, "rule:GetCategories"],
    ["list_rule_templates", { category: "Doors & Locks" }, "rule:ListRuleTemplates"],
    ["resolve_rule_template", { templateId: "t1" }, "ruletmpl:Resolve"],
    ["create_rule", { templateId: "t1", name: "n", description: "d", context: {} }, "ruletmpl:CreateRule"],
    ["list_scenes", {}, "scene:ListScenes"],
    ["fire_scene", { sceneAddress: "SERV:scene:1" }, "scene:Fire"],
    ["list_incidents", {}, "subalarm:ListIncidents"],
    ["disarm_alarm", {}, "subalarm:Disarm"],
    ["get_hub", {}, "place:GetHub"],
    ["reboot_hub", {}, "place:GetHub"],
    ["reboot_hub", {}, "hubadv:Reboot"],
    ["zwave_network_info", {}, "hubzwave:NetworkInformation"],
    ["zwave_heal", {}, "hubzwave:Heal"],
    ["zwave_cancel_heal", {}, "hubzwave:CancelHeal"],
    ["zwave_remove_zombie", { node: 9 }, "hubzwave:RemoveZombie"],
    ["zigbee_network_info", {}, "hubzigbee:NetworkInformation"],
    ["zigbee_get_stats", {}, "hubzigbee:GetStats"],
    ["zigbee_scan", {}, "hubzigbee:Scan"],
    ["send_message", { destination: "SERV:x:", messageType: "x:Thing" }, "x:Thing"],
  ];

  for (const [tool, args, failing] of cases) {
    it(`${tool} reports an Error reply to ${failing} as isError`, async () => {
      const fake = new FakeBridgeClient((req) => {
        if (req.messageType === failing) return errorReply("request.denied", `${failing} was refused`);
        return req.messageType === "place:GetHub" ? HUB : undefined;
      });
      h = await startTools(fake);
      const result = await h.call(tool, args);
      assert.equal(result.isError, true, text(result));
      assert.equal(text(result), `${failing} failed: ${failing} was refused (code: request.denied)`);
    });
  }

  it("describes Error replies without code or message by their attributes", async () => {
    h = await startTools(new FakeBridgeClient(() => ({ messageType: "Error", attributes: { reason: "?" } })));
    const result = await h.call("list_scenes");
    assert.equal(result.isError, true);
    assert.equal(text(result), 'scene:ListScenes failed: {"reason":"?"}');
  });

  it("reports a disconnected socket and timeouts as isError", async () => {
    h = await startTools(new FakeBridgeClient(() => new Error("WebSocket is not connected")));
    let result = await h.call("doorlock_buzz_in", { deviceAddress: "DRIV:dev:1" });
    assert.equal(result.isError, true);
    assert.equal(text(result), "WebSocket is not connected");
    await h.close();

    h = await startTools(new FakeBridgeClient(() => Promise.reject(new Error("Request timed out after 30000ms: scene:Fire"))));
    result = await h.call("fire_scene", { sceneAddress: "SERV:scene:1" });
    assert.equal(result.isError, true);
    assert.match(text(result), /timed out/);
  });

  it("reports success when the command is accepted", async () => {
    h = await startTools(new FakeBridgeClient(withHub()));
    for (const [tool, args, expected] of [
      ["doorlock_buzz_in", { deviceAddress: "DRIV:dev:1" }, "Door unlocked (will auto-relock in 30 seconds)."],
      ["disarm_alarm", {}, "Alarm disarmed."],
      ["reboot_hub", {}, "Hub ABC-1234 is rebooting."],
    ] as const) {
      const result = await h.call(tool, args);
      assert.equal(result.isError, undefined, tool);
      assert.equal(text(result), expected);
    }
  });

  it("keeps get_devices' per-address errors inline", async () => {
    h = await startTools(new FakeBridgeClient((req) =>
      req.destination === "DRIV:dev:bad" ? errorReply("NotFound", "No such device") : { messageType: "base:GetAttributesResponse", attributes: { "dev:name": "Good" } }
    ));
    const result = await h.call("get_devices", { deviceAddresses: ["DRIV:dev:good", "DRIV:dev:bad"] });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(text(result)).map((d: Record<string, unknown>) => [d.addr, d.name ?? d.error]), [
      ["DRIV:dev:good", "Good"],
      ["DRIV:dev:bad", "No such device"],
    ]);
  });

  describe("set_active_place", () => {
    it("does not switch the local place when Arcus refuses", async () => {
      const fake = new FakeBridgeClient((req) =>
        req.messageType === "sess:SetActivePlace" ? errorReply("UnauthorizedRequest", "Not a member of this place") : undefined
      );
      h = await startTools(fake);
      const result = await h.call("set_active_place", { placeId: "other-place" });
      assert.equal(result.isError, true);
      assert.match(text(result), /sess:SetActivePlace failed: Not a member of this place \(code: UnauthorizedRequest\)/);
      assert.equal(fake.activePlaceId, "place-1");
      assert.equal(fake.sent("place:GetHub").length, 0);
    });

    it("switches the place on success and summarizes it", async () => {
      const fake = new FakeBridgeClient(withHub((req) => {
        if (req.messageType === "sess:SetActivePlace") return { messageType: "sess:SetActivePlaceResponse", attributes: { placeId: "other-place" } };
        if (req.messageType === "subs:ListSubsystems") return { messageType: "subs:ListSubsystemsResponse", attributes: { subsystems: [{ "subs:name": "Alarm" }] } };
        if (req.messageType === "base:GetAttributes") return { messageType: "base:GetAttributesResponse", attributes: { "person:firstName": "Ada", "person:lastName": "L" } };
        return undefined;
      }));
      h = await startTools(fake);
      const result = await h.call("set_active_place", { placeId: "other-place" });
      assert.equal(result.isError, undefined, text(result));
      assert.equal(fake.activePlaceId, "other-place");
      const summary = JSON.parse(text(result));
      assert.equal(summary.person.name, "Ada L");
      assert.equal(summary.hub.id, "ABC-1234");
      assert.deepEqual(summary.subsystems, ["Alarm"]);
      assert.equal(fake.sent("place:GetHub")[0].destination, "SERV:place:other-place");
    });

    it("reports follow-up failures inline once the place is set", async () => {
      const fake = new FakeBridgeClient((req) => {
        if (req.messageType === "place:GetHub") return errorReply("hub.missing", "No hub");
        if (req.messageType === "base:GetAttributes") return errorReply("denied", "nope");
        return undefined;
      });
      h = await startTools(fake);
      const result = await h.call("set_active_place", { placeId: "other-place" });
      assert.equal(result.isError, undefined);
      assert.equal(fake.activePlaceId, "other-place");
      const summary = JSON.parse(text(result));
      assert.deepEqual(summary.hub, { error: "place:GetHub failed: No hub (code: hub.missing)" });
      assert.equal("person" in summary, false);
    });
  });

  describe("arm_alarm", () => {
    it("explains triggered devices and suggests bypass", async () => {
      const fake = new FakeBridgeClient(() => errorReply("security.triggeredDevices", "Front Door"));
      h = await startTools(fake);
      const result = await h.call("arm_alarm", { mode: "ON" });
      assert.equal(result.isError, true);
      assert.equal(text(result), "Cannot arm — triggered devices: Front Door\nUse bypass=true to arm anyway.");
      assert.equal(fake.sent("subalarm:Arm").length, 1);
    });

    it("reports any other Error", async () => {
      h = await startTools(new FakeBridgeClient(() => errorReply("security.hubOffline", "Hub is offline")));
      const result = await h.call("arm_alarm", { mode: "PARTIAL" });
      assert.equal(result.isError, true);
      assert.equal(text(result), "subalarm:Arm failed: Hub is offline (code: security.hubOffline)");
    });

    it("reports Errors when bypassing, without suggesting bypass", async () => {
      const fake = new FakeBridgeClient(() => errorReply("security.triggeredDevices", "Front Door"));
      h = await startTools(fake);
      const result = await h.call("arm_alarm", { mode: "ON", bypass: true });
      assert.equal(result.isError, true);
      assert.equal(text(result), "subalarm:ArmBypassed failed: Front Door (code: security.triggeredDevices)");
      assert.equal(fake.sent("subalarm:ArmBypassed").length, 1);
    });

    it("returns the arm response on success", async () => {
      h = await startTools(new FakeBridgeClient(() => ({ messageType: "subalarm:ArmResponse", attributes: { delaySec: 30 } })));
      const result = await h.call("arm_alarm", { mode: "ON" });
      assert.equal(result.isError, undefined);
      assert.deepEqual(JSON.parse(text(result)), { messageType: "subalarm:ArmResponse", attributes: { delaySec: 30 } });
    });
  });
});
