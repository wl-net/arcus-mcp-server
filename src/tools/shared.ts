// Guards, error handling and registration helpers shared by every tool area

import type { z, ZodRawShape, ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { BridgeClient, BridgeMessage } from "../bridge-client.js";
import {
  Account, Base, Device, Hub, HubAdvanced, Person, PersonService, Place, Rule, Scene,
} from "../capabilities.js";

// Destructive message types that should never be sent
export const BLOCKED_MESSAGE_TYPES = new Set([
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

// ── Guards and error handling ─────────────────────────────────────────

export const WRITE_BLOCKED_MSG = "Write operations are disabled. Set ARCUS_ENABLE_WRITE=1 to enable device commands, alarm control, and other actions.";

export type ToolError = CallToolResult & { isError: true };

/** Shared state every tool handler needs */
export interface ToolContext {
  client: BridgeClient;
  ensureConnected: () => Promise<void>;
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(text: string): ToolError {
  return { content: [{ type: "text", text }], isError: true };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True if Arcus answered the request with an Error message */
export function isErrorResponse(resp: BridgeMessage): boolean {
  return resp.payload?.messageType === "Error";
}

/** Readable description of an Error reply, e.g. "doorlock:BuzzIn failed: Lock is jammed (code: lock.jammed)" */
export function describeErrorResponse(resp: BridgeMessage, request: string): string {
  const attrs = resp.payload.attributes ?? {};
  const { code, message } = attrs;
  if (code == null && message == null) return `${request} failed: ${JSON.stringify(attrs)}`;
  return `${request} failed: ${message ?? "(no message)"}${code != null ? ` (code: ${code})` : ""}`;
}

/**
 * sendRequest resolves (rather than rejects) when Arcus replies with an Error
 * message. Throw instead, so the tool wrapper reports it with isError.
 */
export function checkResponse(resp: BridgeMessage, request: string): BridgeMessage {
  if (isErrorResponse(resp)) throw new Error(describeErrorResponse(resp, request));
  return resp;
}

/** Send a request and throw if Arcus replies with an Error */
export async function request(
  client: BridgeClient,
  destination: string,
  messageType: string,
  attributes: Record<string, unknown> = {}
): Promise<BridgeMessage> {
  return checkResponse(await client.sendRequest(destination, messageType, attributes), messageType);
}

/**
 * Wrap a tool handler so anything it throws (Error replies, timeouts,
 * "WebSocket is not connected", connect failures) becomes an isError result.
 */
export function withErrorHandling<A extends unknown[]>(
  handler: (...args: A) => Promise<CallToolResult>
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    try {
      return await handler(...args);
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  };
}

/**
 * Common pre-flight checks. Order matters: the write gate first (no point
 * connecting for a call that will be refused), then connect, then the active
 * place, since API-key mode selects the place while connecting.
 */
export async function preflight(
  ctx: ToolContext,
  opts: { write?: boolean; place?: boolean } = {}
): Promise<ToolError | null> {
  if (opts.write && !process.env.ARCUS_ENABLE_WRITE) return errorResult(WRITE_BLOCKED_MSG);
  await ctx.ensureConnected();
  if (opts.place !== false && !ctx.client.activePlaceId) {
    return errorResult("No active place set. Call set_active_place first.");
  }
  return null;
}

export function blockedMessage(messageType: string): ToolError | null {
  if (!BLOCKED_MESSAGE_TYPES.has(messageType)) return null;
  return errorResult(`Blocked: "${messageType}" is a destructive operation and is not allowed.`);
}

/** Run fn, turning anything it throws (synchronously or not) into { error } */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function getHubAddress(client: BridgeClient): Promise<{ address: string; id: string } | ToolError> {
  const hubResp = await request(client, client.placeDestination, Place.CMD_GETHUB);
  const hub = hubResp.payload.attributes.hub as Record<string, unknown> | undefined;
  if (!hub) {
    return errorResult("No hub found at active place.");
  }
  return { address: hub[Base.ATTR_ADDRESS] as string, id: hub[Base.ATTR_ID] as string };
}

// ── Tool annotations ──────────────────────────────────────────────────
// Hints for clients deciding what to auto-approve or confirm. Every tool acts
// on the user's own Arcus account, so openWorldHint is false unless noted.

export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/** Annotations for a tool that changes state */
export function writes(opts: { destructive: boolean; idempotent: boolean; openWorld?: boolean }): ToolAnnotations {
  return {
    readOnlyHint: false,
    destructiveHint: opts.destructive,
    idempotentHint: opts.idempotent,
    openWorldHint: opts.openWorld ?? false,
  };
}

export interface ToolConfig<Args extends ZodRawShape> {
  title: string;
  description: string;
  inputSchema: Args;
  annotations: ToolAnnotations;
}

/** Text for a command whose success reply is EmptyMessage */
export function emptyOk(resp: BridgeMessage, okText: string): CallToolResult {
  return textResult(resp.payload.messageType === "EmptyMessage" ? okText : JSON.stringify(resp.payload));
}

/** A tool() function for server that runs every handler through withErrorHandling */
export function toolRegistrar(server: McpServer) {
  return function tool<Args extends ZodRawShape>(
    name: string,
    config: ToolConfig<Args>,
    handler: (args: z.objectOutputType<Args, ZodTypeAny>) => Promise<CallToolResult>
  ): void {
    server.registerTool(name, config, withErrorHandling(handler) as never);
  };
}
