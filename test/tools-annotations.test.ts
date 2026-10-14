import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { FakeBridgeClient, startTools, withEnv, type Harness } from "./tools-harness.js";

// Tool names are part of the public interface (README, docs, client configs)
const EXPECTED_TOOLS = [
  "list_places", "set_active_place", "list_history", "list_persons", "list_subsystems",
  "list_devices", "get_device", "get_devices", "device_command", "identify_device", "search_devices",
  "doorlock_buzz_in", "doorlock_authorize_person", "doorlock_deauthorize_person",
  "list_rules", "delete_rule", "enable_rule", "disable_rule", "list_rule_templates", "resolve_rule_template", "create_rule",
  "list_scenes", "fire_scene",
  "list_incidents", "arm_alarm", "disarm_alarm",
  "get_hub", "reboot_hub", "zwave_network_info", "zwave_heal", "zwave_cancel_heal", "zwave_remove_zombie",
  "zigbee_network_info", "zigbee_get_stats", "zigbee_scan",
  "hub_syslog", "hub_bootlog", "hub_processes", "hub_load", "hub_agent_db", "hub_files",
  "list_events", "list_care_status",
  "send_message",
];

const DESTRUCTIVE = [
  "device_command", "doorlock_buzz_in", "doorlock_authorize_person", "doorlock_deauthorize_person",
  "delete_rule", "disable_rule", "fire_scene", "disarm_alarm", "reboot_hub", "zwave_remove_zombie", "send_message",
];

describe("tool annotations", () => {
  let h: Harness;
  let tools: Map<string, Tool>;
  before(async () => {
    h = await withEnv({ ARCUS_ENABLE_ADMIN: "1" }, () => startTools(new FakeBridgeClient()));
    tools = new Map((await h.mcp.listTools()).tools.map((t) => [t.name, t]));
  });
  after(() => h.close());

  it("registers exactly the expected tools", () => {
    assert.deepEqual([...tools.keys()].sort(), [...EXPECTED_TOOLS].sort());
  });

  it("gives every tool a title, description and complete annotations", () => {
    for (const tool of tools.values()) {
      const a = tool.annotations;
      assert.ok(tool.title, `${tool.name} title`);
      assert.ok(tool.description, `${tool.name} description`);
      assert.ok(a, `${tool.name} annotations`);
      assert.equal(typeof a.readOnlyHint, "boolean", `${tool.name} readOnlyHint`);
      assert.equal(typeof a.openWorldHint, "boolean", `${tool.name} openWorldHint`);
      if (!a.readOnlyHint) {
        assert.equal(typeof a.destructiveHint, "boolean", `${tool.name} destructiveHint`);
        assert.equal(typeof a.idempotentHint, "boolean", `${tool.name} idempotentHint`);
      }
    }
  });

  it("marks security-sensitive and irreversible tools destructive", () => {
    for (const name of DESTRUCTIVE) {
      assert.equal(tools.get(name)!.annotations!.destructiveHint, true, name);
    }
    const destructive = [...tools.values()].filter((t) => t.annotations!.destructiveHint).map((t) => t.name);
    assert.deepEqual(destructive.sort(), [...DESTRUCTIVE].sort());
  });

  it("marks lookups read-only but not list_events, which drains the buffer", () => {
    for (const name of ["list_devices", "get_device", "get_hub", "list_care_status", "zwave_network_info", "hub_files"]) {
      assert.equal(tools.get(name)!.annotations!.readOnlyHint, true, name);
    }
    for (const name of ["list_events", "set_active_place", "identify_device", "arm_alarm", "search_devices"]) {
      assert.equal(tools.get(name)!.annotations!.readOnlyHint, false, name);
    }
  });

  it("only marks the raw message escape hatch open-world", () => {
    const openWorld = [...tools.values()].filter((t) => t.annotations!.openWorldHint).map((t) => t.name);
    assert.deepEqual(openWorld, ["send_message"]);
  });
});
