import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

/** Silence the bridge client's stderr logging for the rest of the test file (set ARCUS_DEBUG to keep it) */
export function quietStderr(): void {
  if (process.env.ARCUS_DEBUG) return;
  process.stderr.write = (() => true) as typeof process.stderr.write;
}

/** Poll until a condition holds, or fail after a timeout */
export async function until(condition: () => boolean, timeoutMs = 3000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BridgeRequest {
  messageType: string;
  destination: string;
  attributes: Record<string, unknown>;
  connection: number;
}

export interface Reply {
  messageType: string;
  attributes: Record<string, unknown>;
}

/** Return undefined to fall back to an EmptyMessage reply, or null to send no reply at all */
type Responder = (req: BridgeRequest) => Reply | undefined | null;

export const OK: Reply = { messageType: "EmptyMessage", attributes: {} };

export interface Handshake {
  path: string;
  cookie?: string;
  authorization?: string;
}

/**
 * A fake Arcus bridge / API server: POST /login hands out irisAuthToken cookies,
 * the WebSocket upgrade checks the cookie or bearer token, sends SessionCreated on
 * connect, and answers each request with the responder's reply.
 */
export class FakeBridgeServer {
  readonly requests: BridgeRequest[] = [];
  /** Every WebSocket upgrade attempt, accepted or not */
  readonly handshakes: Handshake[] = [];
  /** Accepted WebSocket connections */
  connections = 0;
  logins = 0;
  /** Tokens (cookie or bearer) the server accepts; rejected handshakes get a 401 */
  readonly validTokens = new Set<string>(["token-0", "api-key"]);
  /** When false, the server accepts upgrades but never sends SessionCreated */
  sendSession = true;
  places = [{ placeId: "place-1", placeName: "Home", accountId: "acct-1", role: "OWNER" }];

  private sockets: WebSocket[] = [];
  private http!: Server;
  private wss!: WebSocketServer;

  constructor(private respond: Responder = () => undefined) {}

  async start(): Promise<string> {
    this.http = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/login") {
        req.resume();
        const token = `token-${++this.logins}`;
        this.validTokens.add(token);
        res.writeHead(200, { "Set-Cookie": `irisAuthToken=${token}; Path=/; HttpOnly` });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({
      server: this.http,
      verifyClient: (info: { req: IncomingMessage }, cb: (ok: boolean, code?: number) => void) => {
        const cookie = info.req.headers.cookie;
        const authorization = info.req.headers.authorization;
        this.handshakes.push({ path: info.req.url ?? "", cookie, authorization });
        const token = cookie?.match(/irisAuthToken=([^;]+)/)?.[1] ?? authorization?.replace(/^Bearer /, "");
        cb(!!token && this.validTokens.has(token), 401);
      },
    });
    this.wss.on("connection", (ws) => {
      const connection = ++this.connections;
      this.sockets.push(ws);
      if (this.sendSession) {
        ws.send(JSON.stringify({
          headers: {},
          payload: { messageType: "SessionCreated", attributes: { personId: "person-1", places: this.places } },
        }));
      }
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        const req: BridgeRequest = {
          messageType: msg.payload.messageType,
          destination: msg.headers.destination,
          attributes: msg.payload.attributes,
          connection,
        };
        this.requests.push(req);
        const reply = this.respond(req);
        if (reply === null) return;
        ws.send(JSON.stringify({ headers: { correlationId: msg.headers.correlationId }, payload: reply ?? OK }));
      });
    });
    await new Promise<void>((resolve) => this.http.listen(0, "127.0.0.1", () => resolve()));
    const { port } = this.http.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** Send an unsolicited message on the latest connection */
  send(headers: Record<string, unknown>, messageType: string, attributes: Record<string, unknown>): void {
    this.sockets[this.sockets.length - 1].send(JSON.stringify({ headers, payload: { messageType, attributes } }));
  }

  /** Drop the latest connection abruptly */
  dropConnection(): void {
    this.sockets[this.sockets.length - 1].terminate();
  }

  requestsOf(messageType: string): BridgeRequest[] {
    return this.requests.filter((r) => r.messageType === messageType);
  }

  async stop(): Promise<void> {
    for (const ws of this.sockets) ws.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    this.http.closeAllConnections();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }
}
