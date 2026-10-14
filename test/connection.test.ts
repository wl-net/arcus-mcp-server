import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BridgeClient } from "../src/bridge-client.js";
import { createEnsureConnected, type ConnectionConfig } from "../src/connection.js";
import { FakeBridgeServer, quietStderr, until } from "./helpers/ws-server.js";

describe("ensureConnected", () => {
  let server: FakeBridgeServer | undefined;
  let client: BridgeClient | undefined;
  before(quietStderr);
  afterEach(async () => {
    client?.disconnect();
    await server?.stop();
    server = client = undefined;
  });

  async function start(config: Omit<ConnectionConfig, "bridgeUrl">, reconnectDelays = [20, 40]) {
    server = new FakeBridgeServer();
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
