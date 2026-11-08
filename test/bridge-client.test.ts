import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { BridgeClient, throwIfErrorResponse } from "../src/bridge-client.js";
import { FakeBridgeServer, delay, quietStderr, until, type Reply, type BridgeRequest } from "./helpers/ws-server.js";

const unauthorized: Reply = { messageType: "Error", attributes: { code: "UnauthorizedRequest" } };

describe("BridgeClient", () => {
  let server: FakeBridgeServer | undefined;
  let client: BridgeClient | undefined;
  before(quietStderr);
  afterEach(async () => {
    // Stop the client first so it doesn't try to reconnect to the stopped server
    client?.disconnect();
    await server?.stop();
    server = client = undefined;
  });

  async function start(respond?: (req: BridgeRequest) => Reply | undefined | null, personalInfo = false) {
    server = new FakeBridgeServer(respond);
    const url = await server.start();
    client = new BridgeClient({ reconnectDelays: [20, 40], personalInfo });
    return { server, client, url };
  }

  describe("requests", () => {
    it("resolves Error replies, which throwIfErrorResponse turns into errors", async () => {
      const { client, url } = await start((req) => (req.messageType === "place:ListDevices" ? unauthorized : undefined));
      await client.connect(url, "token-0");

      const resp = await client.sendRequest("SERV:place:place-1", "place:ListDevices");
      assert.throws(() => throwIfErrorResponse(resp, "place:ListDevices"), /place:ListDevices failed: .*UnauthorizedRequest/);

      const ok = await client.sendRequest("SERV:place:place-1", "place:GetHub");
      assert.equal(throwIfErrorResponse(ok, "place:GetHub"), ok);
    });

    it("buffers events with the sender's address as the source", async () => {
      const { server, client, url } = await start();
      await client.connect(url, "token-0");

      server.send({ source: "DRIV:dev:d1", destination: "SERV:place:place-1" }, "base:ValueChange", { "swit:state": "ON" });
      server.send({ destination: "SERV:place:place-1" }, "base:Added", {});
      await until(() => client.peekEvents().length === 2, 2000, "events");
      const [change, added] = client.drainEvents();
      assert.equal(change.source, "DRIV:dev:d1");
      assert.deepEqual(change.attributes, { "swit:state": "ON" });
      assert.equal(added.source, "SERV:place:place-1", "falls back to the destination without a source");
    });
  });

  describe("personal info", () => {
    const person = { "person:firstName": "Ada", "person:email": "ada@example.com", "person:mobileNumber": "555-0100" };
    const places = [{ placeId: "place-1", name: "Home", streetAddress1: "1 Main St", city: "Springfield", state: "IL" }];
    const respond = (req: BridgeRequest): Reply | undefined =>
      req.messageType === "person:ListAvailablePlaces"
        ? { messageType: "person:ListAvailablePlacesResponse", attributes: { places } }
        : { messageType: "base:GetAttributesResponse", attributes: person };

    it("is dropped from replies and events by default", async () => {
      const { server, client, url } = await start(respond);
      await client.connect(url, "token-0");

      const attrs = await client.sendRequest("SERV:person:p1", "base:GetAttributes");
      assert.deepEqual(attrs.payload.attributes, { "person:firstName": "Ada" });
      const list = await client.sendRequest("SERV:person:p1", "person:ListAvailablePlaces");
      assert.deepEqual(list.payload.attributes, { places: [{ placeId: "place-1", name: "Home" }] });

      server.send({ source: "SERV:person:p1" }, "base:ValueChange", { "person:mobileNumber": "555-0199" });
      await until(() => client.peekEvents().length === 1, 2000, "event");
      assert.deepEqual(client.drainEvents()[0].attributes, {});
    });

    it("is kept with personalInfo", async () => {
      const { server, client, url } = await start(respond, true);
      await client.connect(url, "token-0");

      const attrs = await client.sendRequest("SERV:person:p1", "base:GetAttributes");
      assert.deepEqual(attrs.payload.attributes, person);
      const list = await client.sendRequest("SERV:person:p1", "person:ListAvailablePlaces");
      assert.deepEqual(list.payload.attributes, { places });

      server.send({ source: "SERV:person:p1" }, "base:ValueChange", { "person:mobileNumber": "555-0199" });
      await until(() => client.peekEvents().length === 1, 2000, "event");
      assert.deepEqual(client.drainEvents()[0].attributes, { "person:mobileNumber": "555-0199" });
    });
  });

  describe("product catalog", () => {
    const remote = { "product:id": "aa159b", "product:batteryPrimSize": "AAA", "product:batteryPrimNum": 2 };
    const sensor = { "product:id": "7b8fd3", "product:batteryPrimSize": "CR2", "product:batteryPrimNum": 1 };

    it("loads non-browsable products with GetAllProducts", async () => {
      const { server, client, url } = await start((req) => {
        if (req.messageType === "prodcat:GetAllProducts") return { messageType: "prodcat:GetAllProductsResponse", attributes: { products: [remote, sensor] } };
        if (req.messageType === "prodcat:GetProducts") return { messageType: "prodcat:GetProductsResponse", attributes: { products: [sensor] } };
        return undefined;
      });
      await client.connect(url, "token-0");

      await client.fetchProductCatalog();
      assert.deepEqual(client.productCatalog?.get("aa159b"), { batterySize: "AAA", batteryNum: 2 });
      assert.equal(server.requestsOf("prodcat:GetAllProducts")[0]?.destination, "SERV:prodcat:");
      assert.equal(server.requestsOf("prodcat:GetProducts").length, 0);
    });

    it("falls back to GetProducts when GetAllProducts returns Error", async () => {
      const { server, client, url } = await start((req) => {
        if (req.messageType === "prodcat:GetAllProducts") return { messageType: "Error", attributes: { code: "UnsupportedMessageType" } };
        if (req.messageType === "prodcat:GetProducts") return { messageType: "prodcat:GetProductsResponse", attributes: { products: [sensor] } };
        return undefined;
      });
      await client.connect(url, "token-0");

      await client.fetchProductCatalog();
      assert.deepEqual(client.productCatalog?.get("7b8fd3"), { batterySize: "CR2", batteryNum: 1 });
      assert.equal(client.productCatalog?.has("aa159b"), false);
      assert.equal(server.requestsOf("prodcat:GetProducts").length, 1);
    });

    it("throws when both requests return Error", async () => {
      const { client, url } = await start((req) => (req.messageType.startsWith("prodcat:") ? unauthorized : undefined));
      await client.connect(url, "token-0");

      await assert.rejects(client.fetchProductCatalog(), /prodcat:GetProducts failed: .*UnauthorizedRequest/);
      assert.equal(client.productCatalog, null);
    });
  });

  describe("reconnect", () => {
    it("re-sends SetActivePlace after a drop and reports connected", async () => {
      const { server, client, url } = await start();
      const changes: boolean[] = [];
      client.onConnectionChange = (up) => changes.push(up);
      await client.connect(url, "token-0");
      client.setActivePlace("place-1");

      server.dropConnection();
      await until(() => changes.includes(true), 2000, "reconnect");
      assert.deepEqual(changes, [false, true]);
      assert.equal(server.connections, 2);
      const [restore] = server.requestsOf("sess:SetActivePlace");
      assert.equal(restore.connection, 2);
      assert.deepEqual(restore.attributes, { placeId: "place-1" });
      assert.equal(client.connected, true);
      assert.equal(client.reconnecting, false);
    });

    it("closes and retries a reconnect whose SetActivePlace returns Error", async () => {
      // Connection 2 rejects the active place, 3 accepts it
      const { server, client, url } = await start((req) =>
        req.messageType === "sess:SetActivePlace" && req.connection === 2 ? unauthorized : undefined);
      const changes: boolean[] = [];
      client.onConnectionChange = (up) => changes.push(up);
      await client.connect(url, "token-0");
      client.setActivePlace("place-1");

      server.dropConnection();
      await until(() => changes.includes(true), 2000, "reconnect");
      assert.deepEqual(changes, [false, true]);
      assert.equal(server.connections, 3);
      assert.deepEqual(server.requestsOf("sess:SetActivePlace").map((r) => r.connection), [2, 3]);
    });

    it("keeps a single reconnect chain while attempts keep failing", async () => {
      const { server, client, url } = await start();
      await client.connect(url, "token-0");

      // Accept upgrades but never send SessionCreated, then drop each attempt
      server.sendSession = false;
      server.dropConnection();
      for (let i = 2; i <= 4; i++) {
        await until(() => server.connections === i, 2000, `attempt ${i}`);
        server.dropConnection();
      }
      await delay(150);
      // A chain that doubled on every failure would have made many more attempts
      assert.ok(server.connections <= 6, `made ${server.connections} connections`);
      assert.equal(client.reconnecting, true);
    });

    it("reconnects in API-key mode over /apibus with the bearer token and keeps the active place", async () => {
      const { server, client, url } = await start();
      const changes: boolean[] = [];
      client.onConnectionChange = (up) => changes.push(up);
      await client.connectApiServer(url, "api-key");
      client.setActivePlace("place-1");

      server.dropConnection();
      await until(() => changes.includes(true), 2000, "reconnect");
      assert.equal(server.connections, 2);
      assert.deepEqual(server.handshakes.map((h) => [h.path, h.authorization]), [
        ["/apibus", "Bearer api-key"],
        ["/apibus", "Bearer api-key"],
      ]);
      // The API server has no session-level active place to restore
      assert.equal(server.requestsOf("sess:SetActivePlace").length, 0);
      assert.equal(client.activePlaceId, "place-1");
      assert.equal(client.placeDestination, "SERV:place:place-1");
    });

    it("does not start a reconnect loop when the initial connect fails", async () => {
      const { server, client, url } = await start();
      await assert.rejects(client.connect(url, "bad-token"), /401/);
      await delay(100);
      assert.equal(server.handshakes.length, 1);
      assert.equal(client.reconnecting, false);
    });
  });

  describe("disconnect", () => {
    it("rejects pending requests", async () => {
      const { client, url } = await start(() => null);
      await client.connect(url, "token-0");
      const pending = client.sendRequest("SERV:place:place-1", "place:ListDevices");
      client.disconnect();
      await assert.rejects(pending, /Disconnected/);
      assert.equal(client.connected, false);
    });

    it("cancels a pending reconnect", async () => {
      server = new FakeBridgeServer();
      const url = await server.start();
      client = new BridgeClient({ reconnectDelays: [100] });
      await client.connect(url, "token-0");

      server.dropConnection();
      await until(() => client!.reconnecting, 2000, "reconnect scheduled");
      client.disconnect();
      await delay(200);
      assert.equal(server.handshakes.length, 1);
      assert.equal(client.reconnecting, false);
    });
  });
});
