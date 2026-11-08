import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactPersonal } from "../src/redact.js";
import { parseFeatures } from "../src/features.js";

describe("redactPersonal", () => {
  it("drops contact details, location and billing attributes at any depth", () => {
    const person = {
      "base:address": "SERV:person:p1",
      "person:firstName": "Ada",
      "person:email": "ada@example.com",
      "person:mobileNumber": "555-0100",
      "person:hasPin": true,
    };
    assert.deepEqual(redactPersonal({ persons: [person] }), {
      persons: [{ "base:address": "SERV:person:p1", "person:firstName": "Ada", "person:hasPin": true }],
    });
    assert.deepEqual(
      redactPersonal({
        "hub:name": "Hub",
        "hub4g:phoneNumber": "555-0101",
        "hub4g:imei": "35-209900-176148-1",
        "hubnet:externalip": "203.0.113.7",
        "hubwifi:wifiBssid": "00:11:22:33:44:55",
        "account:billingCCType": "VISA",
        "place:streetAddress1": "1 Main St",
        "place:tzId": "America/Chicago",
      }),
      { "hub:name": "Hub", "place:tzId": "America/Chicago" }
    );
  });

  it("drops the unprefixed address fields of place lists and invitations", () => {
    const place = {
      placeId: "place-1", name: "Home", role: "OWNER", primary: true,
      streetAddress1: "1 Main St", streetAddress2: "Apt 2", city: "Springfield", state: "IL", zipCode: "62701",
    };
    const invitation = {
      code: "ABC123", placeId: "place-1", placeName: "Home", inviteeFirstName: "Bob", inviteeEmail: "bob@example.com",
      streetAddress1: "1 Main St", city: "Springfield", stateProv: "IL", zipCode: "62701",
    };
    const suggestion = { line1: "1 Main St", line2: "", city: "Springfield", state: "IL", zip: "62701" };
    assert.deepEqual(redactPersonal({ places: [place], invitations: [invitation], suggestions: [suggestion] }), {
      places: [{ placeId: "place-1", name: "Home", role: "OWNER", primary: true }],
      invitations: [{ code: "ABC123", placeId: "place-1", placeName: "Home", inviteeFirstName: "Bob" }],
      suggestions: [{}],
    });
  });

  it("keeps state and city outside address records", () => {
    const subsystem = { name: "Alarm", state: "ACTIVE", city: "not an address" };
    assert.deepEqual(redactPersonal({ subsystems: [subsystem] }), { subsystems: [subsystem] });
  });

  it("leaves scalars and nulls alone", () => {
    assert.equal(redactPersonal("text"), "text");
    assert.equal(redactPersonal(null), null);
    assert.deepEqual(redactPersonal({ a: null, b: [1, "x"] }), { a: null, b: [1, "x"] });
  });
});

describe("parseFeatures", () => {
  it("accepts commas, spaces and any case, and reports unknown names", () => {
    const unknown: string[] = [];
    const features = parseFeatures(" Personal_Info,sirens  bogus", (name) => unknown.push(name));
    assert.deepEqual([...features], ["personal_info"]);
    assert.deepEqual(unknown, ["sirens", "bogus"]);
  });

  it("is empty when FEATURES is unset or blank", () => {
    const warn = () => assert.fail("no warning expected");
    assert.equal(parseFeatures(undefined, warn).size, 0);
    assert.equal(parseFeatures(" , ", warn).size, 0);
  });
});
