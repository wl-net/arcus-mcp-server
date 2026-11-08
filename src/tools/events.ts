// Buffered platform events

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { textResult, READ_ONLY, writes, toolRegistrar, type ToolContext } from "./shared.js";

export function registerEventTools(server: McpServer, ctx: ToolContext): void {
  const { client, ensureConnected } = ctx;
  const tool = toolRegistrar(server);

  // ── list_events ─────────────────────────────────────────────────────
  tool(
    "list_events",
    {
      title: "List events",
      description: "Drain buffered platform events (device state changes, alarm triggers, etc.) received since the last call. Returns and clears the buffer. Excludes noisy subcare/subsafety events — use list_care_status for those.",
      inputSchema: {},
      // Not read-only: draining the buffer hides these events from later calls
      annotations: writes({ destructive: false, idempotent: false }),
    },
    async () => {
      await ensureConnected();
      const events = client.drainEvents();
      // Filter out subcare/subsafety noise
      const CARE_PREFIXES = ["subcare:", "subsafety:"];
      const filtered = events.filter(
        (e) => !CARE_PREFIXES.some((p) => e.messageType.startsWith(p))
      );
      if (filtered.length === 0) {
        return textResult(`No new events. (${events.length - filtered.length} care/safety events filtered)`);
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
      return textResult(header + JSON.stringify(summary));
    }
  );

  // ── list_care_status ──────────────────────────────────────────────────
  tool(
    "list_care_status",
    {
      title: "Care/safety status",
      description: "Get the latest care/safety subsystem status from buffered events. Shows triggered devices, inactive devices, and care behaviors without the noisy per-update spam.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      await ensureConnected();
      // Peek at events but don't drain — list_events handles that
      const events = client.peekEvents();
      const CARE_PREFIXES = ["subcare:", "subsafety:"];
      const careEvents = events.filter(
        (e) => CARE_PREFIXES.some((p) => e.messageType.startsWith(p))
      );
      if (careEvents.length === 0) {
        return textResult("No care/safety events buffered.");
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
      return textResult(`${careEvents.length} care/safety events buffered (showing ${latest.size} latest unique):\n${JSON.stringify(summary)}`);
    }
  );
}
