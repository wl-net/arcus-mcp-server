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
const AUTH_TOKEN = process.env.ARCUS_AUTH_TOKEN;
const USERNAME = AUTH_TOKEN ? undefined : requireEnv("ARCUS_USERNAME");
const PASSWORD = AUTH_TOKEN ? undefined : requireEnv("ARCUS_PASSWORD");

const bridgeClient = new BridgeClient();

/** Connect to the bridge lazily (on first tool call). */
let connectPromise: Promise<void> | null = null;
export function ensureConnected(): Promise<void> {
  if (bridgeClient.session) return Promise.resolve();
  if (!connectPromise) {
    connectPromise = (async () => {
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
      const session = await bridgeClient.connect(BRIDGE_URL, token);
      process.stderr.write(
        `[arcus] Connected — personId=${session.personId}, ${session.places.length} place(s)\n`
      );
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
