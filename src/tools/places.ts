// Places, people and history

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Base, Person, Place, SessionService, Subsystem, SubsystemService } from "../capabilities.js";
import { textResult, errorResult, checkResponse, request, preflight, attempt, READ_ONLY, writes, toolRegistrar, type ToolContext } from "./shared.js";
import { summarizeHub, summarizeSubsystems, summarizePerson } from "./summarize.js";

const SESS_DEST = "SERV:sess:";

export function registerPlaceTools(server: McpServer, ctx: ToolContext): void {
  const { client } = ctx;
  const tool = toolRegistrar(server);

  // ── list_places ──────────────────────────────────────────────────────
  tool(
    "list_places",
    {
      title: "List places",
      description: "List all places (homes/locations) accessible to the logged-in user",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const notReady = await preflight(ctx, { place: false });
      if (notReady) return notReady;
      const personId = client.session?.personId;
      if (!personId) return errorResult("Not connected to bridge");
      const resp = await request(client, `SERV:person:${personId}`, Person.CMD_LISTAVAILABLEPLACES);
      return textResult(JSON.stringify(resp.payload.attributes.places));
    }
  );

  // ── set_active_place ─────────────────────────────────────────────────
  tool(
    "set_active_place",
    {
      title: "Set active place",
      description: "Set the active place. Must be called before device or scene operations.",
      inputSchema: { placeId: z.string().describe("The place ID to activate (UUID)") },
      // Changes session state only, not the home
      annotations: writes({ destructive: false, idempotent: true }),
    },
    async ({ placeId }) => {
      const notReady = await preflight(ctx, { place: false });
      if (notReady) return notReady;

      // Phase 1: SetActivePlace + GetAttributes (person) in parallel
      const personId = client.session?.personId;
      const [resp, person] = await Promise.all([
        client.sendRequest(SESS_DEST, SessionService.CMD_SETACTIVEPLACE, { placeId }),
        personId
          ? attempt(() => request(client, `SERV:person:${personId}`, Base.CMD_GETATTRIBUTES))
          : Promise.resolve(null),
      ]);
      // Only switch the local place once Arcus has accepted it
      checkResponse(resp, SessionService.CMD_SETACTIVEPLACE);
      client.setActivePlace(placeId);

      // Phase 2: After SetActivePlaceResponse, send GetHub + ListSubsystems.
      // The place is already active, so report failures here inline rather
      // than failing the whole call.
      const placeDest = client.placeDestination;
      const [hub, subsystems] = await Promise.all([
        attempt(async () => summarizeHub((await request(client, placeDest, Place.CMD_GETHUB)).payload.attributes)),
        attempt(async () => {
          const subsResp = await request(client, "SERV:subs:", SubsystemService.CMD_LISTSUBSYSTEMS, { placeId });
          const subs = subsResp.payload.attributes.subsystems as Array<Record<string, unknown>> | undefined;
          return subs?.map((s) => s[Subsystem.ATTR_NAME]) ?? [];
        }),
      ]);

      const summary = {
        place: resp.payload.attributes,
        ...(person && !("error" in person) ? { person: summarizePerson(person.payload.attributes) } : {}),
        hub,
        subsystems,
      };

      return textResult(JSON.stringify(summary));
    }
  );

  // ── list_history ────────────────────────────────────────────────────
  tool(
    "list_history",
    {
      title: "List history",
      description: "List recent history entries at the active place",
      inputSchema: {
        limit: z.number().default(10).describe("Number of entries to return (default 10)"),
      },
      annotations: READ_ONLY,
    },
    async ({ limit }) => {
      const notReady = await preflight(ctx);
      if (notReady) return notReady;
      const resp = await request(client, client.placeDestination, Place.CMD_LISTHISTORYENTRIES, { limit });
      const results = resp.payload.attributes.results as Array<Record<string, unknown>> | undefined;
      const summary = results
        ? results.map((e) => ({
            ts: e.timestamp,
            key: e.key,
            subject: e.subjectName,
            msg: e.shortMessage,
          }))
        : resp.payload.attributes;
      return textResult(JSON.stringify(summary));
    }
  );

  // ── list_persons ────────────────────────────────────────────────────
  tool(
    "list_persons",
    {
      title: "List persons",
      description: "List all persons at the active place",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const notReady = await preflight(ctx);
      if (notReady) return notReady;
      const resp = await request(client, client.placeDestination, Place.CMD_LISTPERSONS);
      const persons = resp.payload.attributes.persons as Array<Record<string, unknown>> | undefined;
      const summary = persons
        ? persons.map((p) => ({
            name: `${p[Person.ATTR_FIRSTNAME]} ${p[Person.ATTR_LASTNAME]}`,
            addr: p[Base.ATTR_ADDRESS],
            email: p[Person.ATTR_EMAIL],
            mobile: p[Person.ATTR_MOBILENUMBER],
            pin: p["person:hasPin"],
          }))
        : resp.payload.attributes;
      return textResult(JSON.stringify(summary));
    }
  );

  // ── list_subsystems ────────────────────────────────────────────────────
  tool(
    "list_subsystems",
    {
      title: "List subsystems",
      description: "List all subsystems at the active place",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const notReady = await preflight(ctx);
      if (notReady) return notReady;
      const placeId = client.activePlaceId!;
      const resp = await request(client, "SERV:subs:", SubsystemService.CMD_LISTSUBSYSTEMS, { placeId });
      return textResult(JSON.stringify(summarizeSubsystems(resp.payload.attributes)));
    }
  );
}
