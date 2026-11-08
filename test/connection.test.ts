import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BridgeClient } from "../src/bridge-client.js";
import { createEnsureConnected, type ConnectionConfig } from "../src/connection.js";
import { FakeBridgeServer, quietStderr, until, type BridgeRequest, type Reply } from "./helpers/ws-server.js";

describe("ensureConnected", () => {
  let server: FakeBridgeServer | undefined;
  let client: BridgeClient | undefined;
  before(quietStderr);
  afterEach(async () => {
    client?.disconnect();
    await server?.stop();
    server = client = undefined;
  });

  async function start(
    config: Omit<ConnectionConfig, "bridgeUrl">,
    reconnectDelays = [20, 40],
    respond?: (req: BridgeRequest) => Reply | undefined | null
  ) {
    server = new FakeBridgeServer(respond);
    const url = await server.start();
    client = new BridgeClient({ reconnectDelays });
    const ensureConnected = createEnsureConnected(client, { bridgeUrl: url, timeoutMs: 2000, ...config });
    return { server, client, ensureConnected };
  }

  it("shares one connect between concurrent calls", async () => {
    const { server, ensureConnected } = await start({ username: "user", password: "pass" });
    await Promise.all([ensureConnected(), ensureConnected(), ensureConnected()]);
    assert.equal(server.logins, 1);
    assert.equal(server.handshakes.length, 1);
    assert.equal(server.handshakes[0].cookie, "irisAuthToken=token-1");

    // Already connected: no new socket
    await ensureConnected();
    assert.equal(server.handshakes.length, 1);
  });

  it("retries on the next call after a failed connect", async () => {
    const { server, ensureConnected } = await start({ authToken: "late-token" });
    await assert.rejects(ensureConnected(), /401/);
    server.validTokens.add("late-token");
    await ensureConnected();
    assert.equal(server.connections, 1);
  });

  it("waits for an automatic reconnect instead of opening a second socket", async () => {
    const { server, client, ensureConnected } = await start({ authToken: "token-0" }, [100]);
    await ensureConnected();
    client.setActivePlace("place-1");

    server.dropConnection();
    await until(() => client.reconnecting, 2000, "reconnect scheduled");
    await Promise.all([ensureConnected(), ensureConnected()]);
    assert.equal(client.connected, true);
    assert.equal(server.handshakes.length, 2);
    // The active place was restored before the waiting call resumed
    assert.equal(server.requestsOf("sess:SetActivePlace").length, 1);
  });

  it("fails with a clear error when the reconnect does not complete in time", async () => {
    server = new FakeBridgeServer();
    const url = await server.start();
    client = new BridgeClient({ reconnectDelays: [20] });
    const ensureConnected = createEnsureConnected(client, { bridgeUrl: url, authToken: "token-0", timeoutMs: 150 });
    await ensureConnected();

    // Reconnect attempts reach the server but never get a session
    server.sendSession = false;
    server.dropConnection();
    await until(() => client!.reconnecting, 2000, "reconnect scheduled");
    await assert.rejects(ensureConnected(), /Timed out after 0.15s waiting for the bridge to reconnect/);
    assert.equal(server.handshakes.length, 2, "opened a socket alongside the reconnect");
  });

  it("selects the place in API-key mode before resolving, and keeps it across reconnects", async () => {
    const { server, client, ensureConnected } = await start({ apiKey: "api-key" });
    await ensureConnected();
    assert.equal(client.activePlaceId, "place-1");

    server.dropConnection();
    await until(() => client.reconnecting, 2000, "reconnect scheduled");
    await ensureConnected();
    assert.equal(server.handshakes.length, 2);
    assert.ok(server.handshakes.every((h) => h.path === "/apibus" && h.authorization === "Bearer api-key"));
    assert.equal(client.placeDestination, "SERV:place:place-1");
  });

  describe("ARCUS_PLACE_ID", () => {
    const refuseSetActivePlace = (req: BridgeRequest): Reply | undefined =>
      req.messageType === "sess:SetActivePlace" ? { messageType: "Error", attributes: { code: "UnauthorizedRequest" } } : undefined;

    it("selects no place when unset", async () => {
      const { server, client, ensureConnected } = await start({ authToken: "token-0" });
      await ensureConnected();
      assert.equal(client.activePlaceId, null);
      assert.equal(server.requestsOf("sess:SetActivePlace").length, 0);
    });

    it("makes the place active before resolving, and restores it after a reconnect", async () => {
      const { server, client, ensureConnected } = await start({ authToken: "token-0", placeId: "place-2" }, [50]);
      await ensureConnected();
      assert.equal(client.activePlaceId, "place-2");
      assert.deepEqual(server.requestsOf("sess:SetActivePlace").map((r) => r.attributes), [{ placeId: "place-2" }]);

      server.dropConnection();
      await until(() => client.reconnecting, 2000, "reconnect scheduled");
      await ensureConnected();
      assert.deepEqual(server.requestsOf("sess:SetActivePlace").map((r) => r.attributes.placeId), ["place-2", "place-2"]);
      assert.equal(client.activePlaceId, "place-2");
    });

    it("stays connected without a place when refused, and says why", async () => {
      const { server, client, ensureConnected } = await start({ username: "user", password: "pass", placeId: "nope" }, [20], refuseSetActivePlace);
      await ensureConnected();
      assert.equal(client.connected, true);
      assert.equal(client.activePlaceId, null);
      assert.match(client.placeProblem ?? "", /Arcus refused ARCUS_PLACE_ID nope: sess:SetActivePlace failed: .*UnauthorizedRequest/);

      // No login and reconnect on every later call
      await ensureConnected();
      assert.equal(server.logins, 1);
      assert.equal(server.connections, 1);
    });

    it("overrides the first place in API-key mode, if it's one of the key's places", async () => {
      server = new FakeBridgeServer();
      server.places.push({ placeId: "place-2", placeName: "Barn", accountId: "acct-1", role: "OWNER" });
      const url = await server.start();
      client = new BridgeClient({ reconnectDelays: [20] });
      await createEnsureConnected(client, { bridgeUrl: url, apiKey: "api-key", placeId: "place-2" })();
      assert.equal(client.activePlaceId, "place-2");
    });

    it("refuses a place that isn't one of the API key's places", async () => {
      const { client, ensureConnected } = await start({ apiKey: "api-key", placeId: "typo" });
      await ensureConnected();
      assert.equal(client.activePlaceId, null);
      assert.match(client.placeProblem ?? "", /ARCUS_PLACE_ID typo: not one of this API key's places/);
    });
  });

  describe("fresh connect after a reconnect gave up", () => {
    /** Connect, choose place-2 as set_active_place does, then lose the session for good */
    async function giveUpWithPlace(config: Omit<ConnectionConfig, "bridgeUrl">, respond?: (req: BridgeRequest) => Reply | undefined | null) {
      const started = await start(config, [20], respond);
      const { server, client, ensureConnected } = started;
      await ensureConnected();
      if (config.apiKey) {
        client.setActivePlace("place-2");
      } else {
        await client.sendRequest("SERV:sess:", "sess:SetActivePlace", { placeId: "place-2" });
        client.setActivePlace("place-2");
      }

      const token = config.apiKey ?? "token-0";
      server.validTokens.delete(token);
      server.dropConnection();
      await until(() => client.reconnecting, 2000, "reconnect scheduled");
      await assert.rejects(ensureConnected(), /was rejected/);
      server.validTokens.add(token);
      return started;
    }

    it("selects the active place again on the new session", async () => {
      const { server, client, ensureConnected } = await giveUpWithPlace({ authToken: "token-0" });
      await ensureConnected();
      const last = server.requestsOf("sess:SetActivePlace").at(-1)!;
      assert.equal(last.connection, server.connections);
      assert.equal(last.attributes.placeId, "place-2");
      assert.equal(client.activePlaceId, "place-2");
    });

    it("keeps the place chosen with set_active_place over ARCUS_PLACE_ID", async () => {
      const { server, client, ensureConnected } = await giveUpWithPlace({ authToken: "token-0", placeId: "place-1" });
      await ensureConnected();
      assert.equal(server.requestsOf("sess:SetActivePlace").at(-1)!.attributes.placeId, "place-2");
      assert.equal(client.activePlaceId, "place-2");
    });

    it("keeps the chosen place in API-key mode too", async () => {
      const { client, ensureConnected } = await giveUpWithPlace({ apiKey: "api-key", placeId: "place-1" });
      server!.places.push({ placeId: "place-2", placeName: "Barn", accountId: "acct-1", role: "OWNER" });
      await ensureConnected();
      assert.equal(client.activePlaceId, "place-2");
    });

    it("keeps the place and retries on the next call when Arcus refuses it", async () => {
      let refuse = false;
      const { server, client, ensureConnected } = await giveUpWithPlace({ authToken: "token-0", placeId: "place-1" }, (req) =>
        refuse && req.messageType === "sess:SetActivePlace" ? { messageType: "Error", attributes: { code: "UnauthorizedRequest" } } : undefined
      );
      refuse = true;
      await assert.rejects(ensureConnected(), /Could not select the active place place-2 again: .*UnauthorizedRequest/);
      assert.equal(client.activePlaceId, "place-2");
      assert.equal(client.connected, false);

      refuse = false;
      await ensureConnected();
      assert.equal(client.activePlaceId, "place-2");
      assert.equal(server.requestsOf("sess:SetActivePlace").at(-1)!.connection, server.connections);
    });

    it("keeps the place, not ARCUS_PLACE_ID, after a timeout selecting it", async () => {
      let silent = false;
      const { server, client, ensureConnected } = await giveUpWithPlace({ authToken: "token-0", placeId: "place-1", timeoutMs: 200 }, (req) =>
        silent && req.messageType === "sess:SetActivePlace" ? null : undefined
      );
      silent = true;
      await assert.rejects(ensureConnected(), /Timed out/);
      assert.equal(client.activePlaceId, "place-2");

      silent = false;
      await ensureConnected();
      assert.equal(client.activePlaceId, "place-2");
      assert.equal(server.requestsOf("sess:SetActivePlace").at(-1)!.attributes.placeId, "place-2");
    });
  });

  describe("expired token", () => {
    it("logs in again with the stored credentials when a reconnect gets a 401", async () => {
      const { server, client, ensureConnected } = await start({ username: "user", password: "pass" });
      const changes: boolean[] = [];
      client.onConnectionChange = (up) => changes.push(up);
      await ensureConnected();
      assert.equal(server.logins, 1);

      // The session's token expires, then the connection drops
      server.validTokens.delete("token-1");
      server.dropConnection();
      await until(() => changes.includes(true), 2000, "reconnect");
      await ensureConnected();
      assert.equal(server.logins, 2);
      assert.deepEqual(server.handshakes.map((h) => h.cookie), [
        "irisAuthToken=token-1",
        "irisAuthToken=token-1",
        "irisAuthToken=token-2",
      ]);
      assert.equal(server.connections, 2);
    });

    it("stops reconnecting with a clear error when a provided token is rejected", async () => {
      const { server, client, ensureConnected } = await start({ authToken: "token-0" }, [50]);
      await ensureConnected();

      server.validTokens.delete("token-0");
      server.dropConnection();
      await until(() => client.reconnecting, 2000, "reconnect scheduled");
      // A call waiting on the reconnect learns why it gave up
      await assert.rejects(ensureConnected(), /auth token was rejected \(HTTP 401\)/);
      assert.equal(client.reconnecting, false);
      assert.equal(server.logins, 0);
      // The next call tries afresh and reports the rejected token
      await assert.rejects(ensureConnected(), /rejected ARCUS_AUTH_TOKEN \(HTTP 401\)/);
      assert.equal(server.handshakes.length, 3);
    });

    it("does not try to log in when the API key is rejected", async () => {
      const { server, client, ensureConnected } = await start({ apiKey: "api-key" }, [50]);
      await ensureConnected();

      server.validTokens.delete("api-key");
      server.dropConnection();
      await until(() => client.reconnecting, 2000, "reconnect scheduled");
      await assert.rejects(ensureConnected(), /API key was rejected \(HTTP 401\)/);
      assert.equal(server.logins, 0);
      assert.equal(server.handshakes.length, 2);
    });
  });
});
