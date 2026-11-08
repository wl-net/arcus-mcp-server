import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { unknownFeatures } from "../src/tools/shared.js";
import { FakeBridgeClient, startTools, text, withEnv, type Harness, type SentRequest } from "./tools-harness.js";

const PLACE = {
  placeId: "place-1", name: "Home", role: "OWNER",
  streetAddress1: "1 Main St", streetAddress2: "Apt 2", city: "Springfield", state: "IL", zip: "62701",
};

const PERSON = {
  "base:address": "SERV:person:p1",
  "person:firstName": "Ada",
  "person:lastName": "L",
  "person:email": "ada@example.com",
  "person:mobileNumber": "555-0100",
  "person:hasPin": true,
};

function respond(req: SentRequest) {
  switch (req.messageType) {
    case "person:ListAvailablePlaces":
      return { messageType: "person:ListAvailablePlacesResponse", attributes: { places: [PLACE] } };
    case "place:ListPersons":
      return { messageType: "place:ListPersonsResponse", attributes: { persons: [PERSON] } };
    case "base:GetAttributes":
      return { messageType: "base:GetAttributesResponse", attributes: { ...PERSON, "place:streetAddress1": "1 Main St" } };
    case "sess:SetActivePlace":
      return { messageType: "sess:SetActivePlaceResponse", attributes: { placeId: "place-1" } };
    default:
      return undefined;
  }
}

const PERSONAL_VALUES = ["1 Main St", "Apt 2", "Springfield", "62701", "ada@example.com", "555-0100"];

async function callAll(h: Harness): Promise<Record<string, string>> {
  h.fake.events.push({
    messageType: "base:ValueChange",
    source: "SERV:person:p1",
    timestamp: Date.now(),
    attributes: { "person:mobileNumber": "555-0100", "person:firstName": "Ada" },
  });
  const out: Record<string, string> = {};
  for (const [name, args] of [
    ["list_places", {}],
    ["list_persons", {}],
    ["set_active_place", { placeId: "place-1" }],
    ["get_device", { deviceAddress: "SERV:person:p1" }],
    ["send_message", { destination: "SERV:person:p1", messageType: "base:GetAttributes" }],
    ["list_events", {}],
  ] as const) {
    const result = await h.call(name, args);
    assert.equal(result.isError, undefined, `${name}: ${text(result)}`);
    out[name] = text(result);
  }
  return out;
}

describe("personal info", () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it("leaves out addresses, emails and phone numbers by default", async () => {
    await withEnv({ FEATURES: undefined, ARCUS_ENABLE_WRITE: "1" }, async () => {
      h = await startTools(new FakeBridgeClient(respond));
      const out = await callAll(h);
      for (const [name, body] of Object.entries(out)) {
        for (const value of PERSONAL_VALUES) assert.ok(!body.includes(value), `${name} returned ${value}`);
      }
      assert.deepEqual(JSON.parse(out.list_places), [{ placeId: "place-1", name: "Home", role: "OWNER" }]);
      assert.deepEqual(JSON.parse(out.list_persons), [{ name: "Ada L", addr: "SERV:person:p1", pin: true }]);
      assert.match(out.list_events, /"person:firstName":"Ada"/);
    });
  });

  it("includes them with FEATURES=personal_info", async () => {
    await withEnv({ FEATURES: "sirens, Personal_Info", ARCUS_ENABLE_WRITE: "1" }, async () => {
      h = await startTools(new FakeBridgeClient(respond));
      const out = await callAll(h);
      assert.deepEqual(JSON.parse(out.list_places), [PLACE]);
      assert.equal(JSON.parse(out.list_persons)[0].email, "ada@example.com");
      assert.equal(JSON.parse(out.set_active_place).person.mobile, "555-0100");
      assert.match(out.get_device, /1 Main St/);
      assert.match(out.send_message, /ada@example.com/);
      assert.match(out.list_events, /555-0100/);
    });
  });

  it("reports unknown feature names", () => {
    assert.deepEqual(unknownFeatures("personal_info,sirens  bogus"), ["sirens", "bogus"]);
    assert.deepEqual(unknownFeatures(undefined), []);
  });
});
