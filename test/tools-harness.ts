// Drives the real tool registrations over the SDK's in-memory transport,
// backed by a fake BridgeClient that answers from a callback.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeClient, BridgeEvent, BridgeMessage } from "../src/bridge-client.js";
import { registerTools } from "../src/tools.js";

export interface SentRequest {
  destination: string;
  messageType: string;
  attributes: Record<string, unknown>;
}

/** A reply payload, or an Error to throw synchronously (as sendRequest does when disconnected) */
export type FakeReply = { messageType: string; attributes?: Record<string, unknown> } | Error | Promise<never>;

export const EMPTY = { messageType: "EmptyMessage", attributes: {} };

export function errorReply(code: string, message: string) {
  return { messageType: "Error", attributes: { code, message } };
}

/** Implements just the parts of BridgeClient the tools use */
export class FakeBridgeClient {
  session: { personId: string; places: unknown[] } | null = { personId: "person-1", places: [] };
  activePlaceId: string | null = "place-1";
  productCatalog = new Map<string, { batterySize: string; batteryNum: number }>();
  requests: SentRequest[] = [];
  events: BridgeEvent[] = [];

  constructor(public respond: (req: SentRequest) => FakeReply | undefined = () => undefined) {}

  get placeDestination(): string {
    if (!this.activePlaceId) throw new Error("No active place set. Call set_active_place first.");
    return `SERV:place:${this.activePlaceId}`;
  }

  setActivePlace(placeId: string): void {
    this.activePlaceId = placeId;
  }

  async fetchProductCatalog(): Promise<void> {}

  sendRequest(destination: string, messageType: string, attributes: Record<string, unknown> = {}): Promise<BridgeMessage> {
    const req = { destination, messageType, attributes };
    this.requests.push(req);
    const reply = this.respond(req) ?? EMPTY;
    if (reply instanceof Error) throw reply;
    if (reply instanceof Promise) return reply;
    return Promise.resolve({
      headers: { destination },
      payload: { messageType: reply.messageType, attributes: reply.attributes ?? {} },
    });
  }

  drainEvents(): BridgeEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  peekEvents(): BridgeEvent[] {
    return [...this.events];
  }

  sent(messageType: string): SentRequest[] {
    return this.requests.filter((r) => r.messageType === messageType);
  }
}

export interface Harness {
  fake: FakeBridgeClient;
  mcp: Client;
  connectCalls: number;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

/**
 * Register the tools against fake and connect an MCP client to them.
 * onConnect stands in for index.ts's ensureConnected.
 */
export async function startTools(
  fake: FakeBridgeClient,
  onConnect: () => Promise<void> = async () => {}
): Promise<Harness> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const harness = {
    fake,
    connectCalls: 0,
  } as Harness;
  registerTools(server, fake as unknown as BridgeClient, async () => {
    harness.connectCalls++;
    await onConnect();
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  harness.mcp = mcp;
  harness.call = async (name, args = {}) => (await mcp.callTool({ name, arguments: args })) as CallToolResult;
  harness.close = async () => {
    await mcp.close();
    await server.close();
  };
  return harness;
}

export function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** Set env vars for the duration of fn, restoring them afterwards */
export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
