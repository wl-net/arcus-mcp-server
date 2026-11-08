import { HandshakeError, describeErrorResponse, isErrorResponse, type BridgeClient, type SessionInfo } from "./bridge-client.js";
import { SessionService } from "./capabilities.js";

export interface ConnectionConfig {
  bridgeUrl: string;
  /** API server mode (bearer token over /apibus); takes precedence over the others */
  apiKey?: string;
  /** Client bridge mode with a pre-issued irisAuthToken */
  authToken?: string;
  /** Client bridge mode, logging in for an irisAuthToken */
  username?: string;
  password?: string;
  /** Place to make active on connect (ARCUS_PLACE_ID). Without it, none until set_active_place */
  placeId?: string;
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
  | "activePlaceId"
  | "setActivePlace"
  | "clearActivePlace"
  | "sendRequest"
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

    await choosePlace(session);
  }

  /**
   * Make a place active on a new session: the place that was active before, if the
   * bridge client gave up reconnecting (Arcus doesn't carry it over); otherwise
   * ARCUS_PLACE_ID; otherwise, in API-key mode, the key's first place.
   */
  async function choosePlace(session: SessionInfo): Promise<void> {
    const previous = bridge.activePlaceId;
    const placeId = previous ?? config.placeId ?? (bridge.autoPlace ? session.places[0]?.placeId : undefined);
    if (!placeId) return;
    const what = previous ? `the active place ${placeId}` : placeId === config.placeId ? `ARCUS_PLACE_ID ${placeId}` : `place ${placeId}`;

    // Set it before asking, so if the socket drops first the bridge client's reconnect restores it
    bridge.setActivePlace(placeId);

    let refusal: string | null = null;
    if (bridge.autoPlace) {
      // The API server makes the key's place active itself
      if (!session.places.some((p) => p.placeId === placeId)) refusal = "not one of this API key's places";
    } else {
      // A timeout or dropped socket rejects here and fails the connect, keeping the place
      const resp = await bridge.sendRequest("SERV:sess:", SessionService.CMD_SETACTIVEPLACE, { placeId });
      if (isErrorResponse(resp)) refusal = describeErrorResponse(resp, SessionService.CMD_SETACTIVEPLACE);
    }
    if (!refusal) {
      log(`Selected ${what}`);
      return;
    }

    if (previous && !bridge.autoPlace) {
      // Arcus accepted this place before, so retry it as the bridge client's reconnect
      // does: drop the session and keep the place for the next call
      bridge.disconnect();
      throw new Error(`Could not select ${what} again: ${refusal}`);
    }
    // A place Arcus has never accepted is most likely misconfigured. Stay connected so
    // list_places and set_active_place work, and tools that need a place say why
    bridge.clearActivePlace(`Arcus refused ${what}: ${refusal}`);
    log(`Arcus refused ${what}: ${refusal}`);
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
