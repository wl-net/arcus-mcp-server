import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeClient } from "./bridge-client.js";
import { registerTools } from "./tools.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`Error: ${name} environment variable is required\n`);
    process.exit(1);
  }
  return value;
}

const BRIDGE_URL = requireEnv("ARCUS_BRIDGE_URL");
const API_KEY = process.env.ARCUS_API_KEY;
const AUTH_TOKEN = API_KEY ? undefined : process.env.ARCUS_AUTH_TOKEN;
const USERNAME = API_KEY || AUTH_TOKEN ? undefined : requireEnv("ARCUS_USERNAME");
const PASSWORD = API_KEY || AUTH_TOKEN ? undefined : requireEnv("ARCUS_PASSWORD");

const bridgeClient = new BridgeClient();

/** Connect to the bridge lazily (on first tool call). Resets if connection drops. */
let connectPromise: Promise<void> | null = null;
export function ensureConnected(): Promise<void> {
  if (bridgeClient.session) return Promise.resolve();
  // Reset promise if session was lost (reconnection in progress)
  connectPromise = null;
  if (!connectPromise) {
    connectPromise = (async () => {
      let session;
      if (API_KEY) {
        process.stderr.write(`[arcus] Connecting to API server at ${BRIDGE_URL}...\n`);
        session = await bridgeClient.connectApiServer(BRIDGE_URL, API_KEY);
      } else {
        let token: string;
        if (AUTH_TOKEN) {
          process.stderr.write("[arcus] Using provided auth token\n");
          token = AUTH_TOKEN;
        } else {
          process.stderr.write(`[arcus] Logging in to ${BRIDGE_URL}...\n`);
          token = await bridgeClient.login(BRIDGE_URL, USERNAME!, PASSWORD!);
          process.stderr.write("[arcus] Login successful\n");
        }

        process.stderr.write("[arcus] Connecting WebSocket...\n");
        session = await bridgeClient.connect(BRIDGE_URL, token);
      }

      process.stderr.write(
        `[arcus] Connected — personId=${session.personId}, ${session.places.length} place(s)\n`
      );

      // Auto-set place in API server mode
      if (bridgeClient.autoPlace && session.places.length > 0) {
        const place = session.places[0];
        bridgeClient.setActivePlace(place.placeId);
        process.stderr.write(`[arcus] Auto-selected place: ${place.placeName} (${place.placeId})\n`);
      }
    })();
  }
  return connectPromise;
}

const mcpServer = new McpServer({
  name: "arcus-mcp-server",
  version: "1.0.0",
});

registerTools(mcpServer, bridgeClient, ensureConnected);

async function main(): Promise<void> {
  // Start MCP transport immediately — bridge connects on first tool call
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  process.stderr.write("[arcus] MCP server running on stdio\n");
}

// Graceful shutdown
function shutdown(): void {
  process.stderr.write("[arcus] Shutting down...\n");
  bridgeClient.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  process.stderr.write(`[arcus] Fatal: ${err}\n`);
  process.exit(1);
});
