import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeClient } from "./bridge-client.js";
import { createEnsureConnected } from "./connection.js";
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

/** Connect to the bridge lazily (on first tool call), or wait out an automatic reconnect. */
export const ensureConnected = createEnsureConnected(bridgeClient, {
  bridgeUrl: BRIDGE_URL,
  apiKey: API_KEY,
  authToken: AUTH_TOKEN,
  username: USERNAME,
  password: PASSWORD,
});

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
