import { HandshakeError, type BridgeClient, type SessionInfo } from "./bridge-client.js";

export interface ConnectionConfig {
  bridgeUrl: string;
  /** API server mode (bearer token over /apibus); takes precedence over the others */
  apiKey?: string;
  /** Client bridge mode with a pre-issued irisAuthToken */
  authToken?: string;
  /** Client bridge mode, logging in for an irisAuthToken */
  username?: string;
  password?: string;
  /** How long a connect, or a wait for an automatic reconnect, may take before failing */
  timeoutMs?: number;
}

type Bridge = Pick<
  BridgeClient,
  | "connected"
  | "reconnecting"
  | "autoPlace"
  | "login"
  | "connect"
  | "connectApiServer"
  | "setActivePlace"
  | "waitForConnection"
  | "disconnect"
>;

const DEFAULT_TIMEOUT_MS = 30_000;

function log(msg: string): void {
  process.stderr.write(`[arcus] ${msg}\n`);
}

/**
 * Build the ensureConnected() that tools call before talking to the bridge. The
 * bridge connects lazily on first use; concurrent callers share one connect, and
 * while the bridge client is reconnecting on its own callers wait for that rather
 * than opening a second socket. A failed connect is not cached, so the next call
 * retries.
 */
export function createEnsureConnected(bridge: Bridge, config: ConnectionConfig): () => Promise<void> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let inFlight: Promise<void> | null = null;

  async function connect(): Promise<void> {
    try {
      await connectOnce();
    } catch (err) {
      if (err instanceof HandshakeError && err.isAuthFailure) {
        const what = config.apiKey ? "ARCUS_API_KEY" : config.authToken ? "ARCUS_AUTH_TOKEN" : "the login token";
        throw new Error(`The bridge rejected ${what} (HTTP ${err.status})`);
      }
      throw err;
    }
  }

  async function connectOnce(): Promise<void> {
    let session: SessionInfo;
    if (config.apiKey) {
      log(`Connecting to API server at ${config.bridgeUrl}...`);
      session = await bridge.connectApiServer(config.bridgeUrl, config.apiKey);
    } else {
      let token: string;
      if (config.authToken) {
        log("Using provided auth token");
        token = config.authToken;
      } else {
        log(`Logging in to ${config.bridgeUrl}...`);
        token = await bridge.login(config.bridgeUrl, config.username!, config.password!);
        log("Login successful");
      }

      log("Connecting WebSocket...");
      session = await bridge.connect(config.bridgeUrl, token);
    }

    log(`Connected — personId=${session.personId}, ${session.places.length} place(s)`);

    // Auto-set place in API server mode. The bridge client keeps it across reconnects.
    if (bridge.autoPlace && session.places.length > 0) {
      const place = session.places[0];
      bridge.setActivePlace(place.placeId);
      log(`Auto-selected place: ${place.placeName} (${place.placeId})`);
    }
  }

  function connectWithTimeout(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Drop the half-open socket so it can't take over after we've given up
        bridge.disconnect();
        reject(new Error(`Timed out after ${timeoutMs / 1000}s connecting to ${config.bridgeUrl}`));
      }, timeoutMs);
    });
    return Promise.race([connect(), timeout]).finally(() => clearTimeout(timer));
  }

  return function ensureConnected(): Promise<void> {
    // Check inFlight first: the bridge reports connected as soon as the session
    // exists, before connect() has finished setup such as selecting the place
    if (inFlight) return inFlight;
    if (bridge.connected) return Promise.resolve();
    inFlight = (bridge.reconnecting ? bridge.waitForConnection(timeoutMs) : connectWithTimeout()).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
