import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { Product, ProductCatalog, SessionService } from "./capabilities.js";

export interface BridgeEvent {
  timestamp: number;
  messageType: string;
  source?: string;
  attributes: Record<string, unknown>;
}

export interface Place {
  placeId: string;
  placeName: string;
  accountId: string;
  role: string;
  [key: string]: unknown;
}

export interface SessionInfo {
  personId: string;
  places: Place[];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface BridgeMessage {
  type?: string;
  headers: {
    destination?: string;
    source?: string;
    correlationId?: string;
    isRequest?: boolean;
    [key: string]: unknown;
  };
  payload: {
    messageType: string;
    attributes: Record<string, unknown>;
    [key: string]: unknown;
  };
}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_EVENT_BUFFER = 100;
const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];

/** Throw if a response is an Error reply, which sendRequest resolves rather than rejects */
export function throwIfErrorResponse(resp: BridgeMessage, request: string): BridgeMessage {
  if (resp.payload?.messageType === "Error") {
    throw new Error(`${request} failed: ${JSON.stringify(resp.payload.attributes)}`);
  }
  return resp;
}

const debug = !!process.env.ARCUS_DEBUG;
function log(msg: string): void {
  process.stderr.write(`[bridge] ${msg}\n`);
}
function dbg(msg: string): void {
  if (debug) log(`DEBUG ${msg}`);
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private pending = new Map<string, PendingRequest>();
  private _session: SessionInfo | null = null;
  private _activePlaceId: string | null = null;
  private _events: BridgeEvent[] = [];
  private _productCatalog: Map<string, { batterySize: string; batteryNum: number }> | null = null;

  private _baseUrl: string | null = null;
  private _wsPath = "/websocket";
  private _authHeaders: Record<string, string> = {};
  private _autoPlace = false;
  private _reconnecting = false;
  private _reconnectAttempt = 0;
  private _intentionalClose = false;
  private _connected = false;

  /** Optional callback fired for every unsolicited (non-response) message */
  onEvent: ((event: BridgeEvent) => void) | null = null;

  /**
   * Optional callback fired when an established session drops (false) and when an
   * automatic reconnect is ready for requests again (true). Not fired for the initial connect.
   */
  onConnectionChange: ((connected: boolean) => void) | null = null;

  private _setConnected(connected: boolean): void {
    // Reset backoff only once the session is usable, not merely when the socket
    // opens, so a reconnect that keeps failing setup still backs off.
    if (connected) this._reconnectAttempt = 0;
    if (this._connected === connected) return;
    this._connected = connected;
    this.onConnectionChange?.(connected);
  }

  get session(): SessionInfo | null {
    return this._session;
  }

  get activePlaceId(): string | null {
    return this._activePlaceId;
  }

  get placeDestination(): string {
    if (!this._activePlaceId) throw new Error("No active place set. Call set_active_place first.");
    return `SERV:place:${this._activePlaceId}`;
  }

  get productCatalog(): Map<string, { batterySize: string; batteryNum: number }> | null {
    return this._productCatalog;
  }

  setActivePlace(placeId: string): void {
    this._activePlaceId = placeId;
  }

  async fetchProductCatalog(): Promise<void> {
    if (this._productCatalog) return;
    const resp = throwIfErrorResponse(
      await this.sendRequest("SERV:prodcat:", ProductCatalog.CMD_GETPRODUCTS, {}),
      ProductCatalog.CMD_GETPRODUCTS,
    );
    const products = resp.payload.attributes.products as Array<Record<string, unknown>> | undefined;
    const catalog = new Map<string, { batterySize: string; batteryNum: number }>();
    if (products) {
      for (const p of products) {
        const id = p[Product.ATTR_ID] as string | undefined;
        const size = p[Product.ATTR_BATTERYPRIMSIZE] as string | undefined;
        const num = p[Product.ATTR_BATTERYPRIMNUM] as number | undefined;
        if (id && size && size !== "NONE") {
          catalog.set(id, { batterySize: size, batteryNum: num ?? 1 });
        }
      }
    }
    this._productCatalog = catalog;
  }

  /** Drain all buffered events, returning and clearing the buffer. */
  drainEvents(): BridgeEvent[] {
    const events = this._events;
    this._events = [];
    return events;
  }

  /** Peek at buffered events without clearing the buffer. */
  peekEvents(): BridgeEvent[] {
    return [...this._events];
  }

  private bufferEvent(msg: BridgeMessage): void {
    const event: BridgeEvent = {
      timestamp: Date.now(),
      messageType: msg.payload.messageType,
      source: (msg.headers.source ?? msg.headers.destination) as string | undefined,
      attributes: msg.payload.attributes,
    };
    this._events.push(event);
    if (this._events.length > MAX_EVENT_BUFFER) {
      this._events = this._events.slice(-MAX_EVENT_BUFFER);
    }
    // Fire the onEvent callback
    if (this.onEvent) {
      this.onEvent(event);
    }
  }

  async login(baseUrl: string, username: string, password: string): Promise<string> {
    const url = `${baseUrl}/login`;
    dbg(`POST ${url} (username=${username})`);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      redirect: "manual",
    });

    dbg(`Login response: status=${res.status}`);
    if (!res.ok && res.status !== 302) {
      throw new Error(`Login failed with status ${res.status}`);
    }

    const setCookie = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
    for (const cookie of setCookie) {
      const match = cookie.match(/irisAuthToken=([^;]+)/);
      if (match) {
        this.token = match[1];
        dbg(`Got token: ${this.token.substring(0, 8)}...`);
        return this.token;
      }
    }

    throw new Error("Login response did not contain irisAuthToken cookie");
  }

  connect(baseUrl: string, token?: string): Promise<SessionInfo> {
    const authToken = token ?? this.token;
    if (!authToken) {
      throw new Error("No auth token available. Call login() first.");
    }

    this._baseUrl = baseUrl;
    this.token = authToken;
    this._wsPath = "/websocket";
    this._authHeaders = { Cookie: `irisAuthToken=${authToken}` };
    this._autoPlace = false;
    this._intentionalClose = false;

    return this._doConnect();
  }

  connectApiServer(baseUrl: string, apiKey: string): Promise<SessionInfo> {
    this._baseUrl = baseUrl;
    this._wsPath = "/apibus";
    this._authHeaders = { Authorization: `Bearer ${apiKey}` };
    this._autoPlace = true;
    this._intentionalClose = false;

    return this._doConnect();
  }

  get autoPlace(): boolean {
    return this._autoPlace;
  }

  private _doConnect(): Promise<SessionInfo> {
    const wsUrl = this._baseUrl!.replace(/^http/, "ws") + this._wsPath;
    dbg(`WebSocket connecting to ${wsUrl}`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl, {
        headers: { ...this._authHeaders },
      });

      this.ws.on("open", () => {
        log("WebSocket connected");
      });

      this.ws.on("ping", (data) => {
        dbg("ping received, sending pong");
        this.ws?.pong(data);
      });

      let settled = false;

      this.ws.on("message", (data) => {
        const raw = data.toString();
        dbg(`<-- ${raw.substring(0, 500)}${raw.length > 500 ? "..." : ""}`);

        let msg: BridgeMessage;
        try {
          msg = JSON.parse(raw);
        } catch {
          dbg("Failed to parse message as JSON");
          return;
        }

        // Handle SessionCreated (initial welcome)
        if (msg.payload?.messageType === "SessionCreated" && !settled) {
          settled = true;
          const attrs = msg.payload.attributes;
          this._session = {
            personId: attrs.personId as string,
            places: attrs.places as Place[],
          };
          log(`Session created — personId=${this._session.personId}, ${this._session.places.length} place(s)`);

          // Re-set active place after reconnect (skip for api-server mode)
          if (this._reconnecting && this._activePlaceId && !this._autoPlace) {
            const placeId = this._activePlaceId;
            const ws = this.ws;
            log(`Reconnected — re-setting active place ${placeId}`);
            this.sendRequest("SERV:sess:", SessionService.CMD_SETACTIVEPLACE, { placeId })
              .then((resp) => {
                throwIfErrorResponse(resp, SessionService.CMD_SETACTIVEPLACE);
                log("Active place restored after reconnect");
                this._setConnected(true);
              })
              .catch((err) => {
                // Without an active place the session is useless; close it so the
                // normal reconnect-with-backoff path retries.
                log(`Failed to restore active place: ${err.message} — closing to retry`);
                ws?.close();
              });
          } else if (this._reconnecting) {
            this._setConnected(true);
          } else {
            // Initial connect: the caller finishes setup, so don't notify
            this._connected = true;
          }
          this._reconnecting = false;

          resolve(this._session);
          return;
        }

        // Route responses to pending requests by correlationId
        const corrId = msg.headers?.correlationId;
        if (corrId && this.pending.has(corrId)) {
          dbg(`Response matched correlationId=${corrId}`);
          const entry = this.pending.get(corrId)!;
          clearTimeout(entry.timer);
          this.pending.delete(corrId);
          entry.resolve(msg);
        } else {
          dbg(`Unmatched message: type=${msg.payload?.messageType}`);
          this.bufferEvent(msg);
        }
      });

      this.ws.on("error", (err) => {
        log(`WebSocket error: ${err.message}`);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      this.ws.on("close", (code, reason) => {
        log(`WebSocket closed (code=${code}, reason=${reason.toString()})`);
        // Reject all pending requests
        for (const [id, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error("WebSocket closed"));
          this.pending.delete(id);
        }
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket closed before SessionCreated"));
        }

        this._session = null;
        this._setConnected(false);

        // Auto-reconnect unless intentionally closed
        if (!this._intentionalClose && this._baseUrl && (this.token || this._autoPlace)) {
          this._scheduleReconnect();
        }
      });
    });
  }

  private _scheduleReconnect(): void {
    const delay = RECONNECT_DELAYS[Math.min(this._reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this._reconnectAttempt++;
    this._reconnecting = true;
    log(`Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempt})...`);

    setTimeout(() => {
      if (this._intentionalClose) return;
      this._doConnect().then(
        () => log("Reconnected successfully"),
        (err) => {
          log(`Reconnect failed: ${err.message}`);
          if (!this._intentionalClose) {
            this._scheduleReconnect();
          }
        },
      );
    }, delay);
  }

  sendRequest(
    destination: string,
    messageType: string,
    attributes: Record<string, unknown> = {},
  ): Promise<BridgeMessage> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not connected");
    }

    const correlationId = randomUUID();

    const msg: BridgeMessage = {
      type: messageType,
      headers: {
        destination,
        correlationId,
        isRequest: true,
      },
      payload: {
        messageType,
        attributes,
      },
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${messageType}`));
      }, REQUEST_TIMEOUT_MS);

      this.pending.set(correlationId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });

      const payload = JSON.stringify(msg);
      dbg(`--> ${payload.substring(0, 500)}${payload.length > 500 ? "..." : ""}`);
      this.ws!.send(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(correlationId);
          reject(err);
        }
      });
    });
  }

  disconnect(): void {
    this._intentionalClose = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._session = null;
  }
}
