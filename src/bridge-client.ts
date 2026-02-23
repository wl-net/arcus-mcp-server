import { randomUUID } from "node:crypto";
import WebSocket from "ws";

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

interface BridgeMessage {
  type?: string;
  headers: {
    destination?: string;
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
const SOURCE = "CLNT:mcp:1";
const MAX_EVENT_BUFFER = 100;
const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];

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

  private _baseUrl: string | null = null;
  private _reconnecting = false;
  private _reconnectAttempt = 0;
  private _intentionalClose = false;

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

  setActivePlace(placeId: string): void {
    this._activePlaceId = placeId;
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
    this._events.push({
      timestamp: Date.now(),
      messageType: msg.payload.messageType,
      source: msg.headers.destination as string | undefined,
      attributes: msg.payload.attributes,
    });
    if (this._events.length > MAX_EVENT_BUFFER) {
      this._events = this._events.slice(-MAX_EVENT_BUFFER);
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
    dbg(`Set-Cookie headers: ${JSON.stringify(setCookie)}`);
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
    this._intentionalClose = false;

    return this._doConnect();
  }

  private _doConnect(): Promise<SessionInfo> {
    const authToken = this.token!;
    const wsUrl = this._baseUrl!.replace(/^http/, "ws") + "/androidbus";
    dbg(`WebSocket connecting to ${wsUrl}`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl, {
        headers: { Cookie: `irisAuthToken=${authToken}` },
      });

      this.ws.on("open", () => {
        log("WebSocket connected");
        this._reconnectAttempt = 0;
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

          // Re-set active place after reconnect
          if (this._reconnecting && this._activePlaceId) {
            const placeId = this._activePlaceId;
            log(`Reconnected — re-setting active place ${placeId}`);
            this.sendRequest("SERV:sess:", "sess:SetActivePlace", { placeId }).then(
              () => log("Active place restored after reconnect"),
              (err) => log(`Failed to restore active place: ${err.message}`),
            );
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
          dbg(`Unmatched message: type=${msg.payload?.messageType} corrId=${corrId}`);
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

        // Auto-reconnect unless intentionally closed
        if (!this._intentionalClose && this._baseUrl && this.token) {
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
    attributes: Record<string, unknown> = {}
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
