// Rules and rule templates

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Base, Rule, RuleService, RuleTemplate } from "../capabilities.js";
import { textResult, request, preflight, READ_ONLY, writes, emptyOk, toolRegistrar, type ToolContext } from "./shared.js";
import { summarizeRule } from "./summarize.js";

export function registerRuleTools(server: McpServer, ctx: ToolContext): void {
  const { client } = ctx;
  const tool = toolRegistrar(server);

  // ── list_rules ──────────────────────────────────────────────────────
  tool(
    "list_rules",
    {
      title: "List rules",
      description: "List all rules at the active place",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const notReady = await preflight(ctx);
      if (notReady) return notReady;
      const placeId = client.activePlaceId!;
      const resp = await request(client, "SERV:rule:", RuleService.CMD_LISTRULES, { placeId });
      const rules = resp.payload.attributes.rules as Array<Record<string, unknown>> | undefined;
      const summary = rules ? rules.map(summarizeRule) : resp.payload.attributes;
      return textResult(JSON.stringify(summary));
    }
  );

  // ── delete_rule ────────────────────────────────────────────────────
  tool(
    "delete_rule",
    {
      title: "Delete rule",
      description: "Delete a rule at the active place",
      inputSchema: {
        ruleAddress: z.string().describe("Rule address (e.g. SERV:rule:place-id.1)"),
      },
      annotations: writes({ destructive: true, idempotent: true }),
    },
    async ({ ruleAddress }) => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const resp = await request(client, ruleAddress, Rule.CMD_DELETE);
      return emptyOk(resp, "Rule deleted.");
    }
  );

  // ── enable_rule ──────────────────────────────────────────────────────
  tool(
    "enable_rule",
    {
      title: "Enable rule",
      description: "Enable a rule at the active place",
      inputSchema: {
        ruleAddress: z.string().describe("Rule address (e.g. SERV:rule:place-id.1)"),
      },
      annotations: writes({ destructive: false, idempotent: true }),
    },
    async ({ ruleAddress }) => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const resp = await request(client, ruleAddress, Rule.CMD_ENABLE);
      return emptyOk(resp, "Rule enabled.");
    }
  );

  // ── disable_rule ─────────────────────────────────────────────────────
  tool(
    "disable_rule",
    {
      title: "Disable rule",
      description: "Disable a rule at the active place",
      inputSchema: {
        ruleAddress: z.string().describe("Rule address (e.g. SERV:rule:place-id.1)"),
      },
      // Can switch off security/safety automations
      annotations: writes({ destructive: true, idempotent: true }),
    },
    async ({ ruleAddress }) => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const resp = await request(client, ruleAddress, Rule.CMD_DISABLE);
      return emptyOk(resp, "Rule disabled.");
    }
  );

  // ── list_rule_templates ─────────────────────────────────────────────
  tool(
    "list_rule_templates",
    {
      title: "List rule templates",
      description: "List available rule templates at the active place. With no category, returns category names and counts. With a category, returns templates in that category.",
      inputSchema: {
        category: z.string().optional().describe("Filter by category name (e.g. \"Security Alarm\", \"Doors & Locks\"). Omit to list categories."),
      },
      annotations: READ_ONLY,
    },
    async ({ category }) => {
      const notReady = await preflight(ctx);
      if (notReady) return notReady;
      const placeId = client.activePlaceId!;

      if (!category) {
        // Return categories and counts
        const resp = await request(client, "SERV:rule:", RuleService.CMD_GETCATEGORIES, { placeId });
        return textResult(JSON.stringify(resp.payload.attributes.categories));
      }

      // Return templates filtered by category
      const resp = await request(client, "SERV:rule:", RuleService.CMD_LISTRULETEMPLATES, { placeId });
      const templates = resp.payload.attributes.ruleTemplates as Array<Record<string, unknown>> | undefined;
      const summary = templates
        ? templates
            .filter((t) => t[RuleTemplate.ATTR_SATISFIABLE] && (t[RuleTemplate.ATTR_CATEGORIES] as string[] | undefined)?.includes(category))
            .map((t) => ({
              id: t[Base.ATTR_ID],
              template: t[RuleTemplate.ATTR_TEMPLATE],
              categories: t[RuleTemplate.ATTR_CATEGORIES],
              premium: t[RuleTemplate.ATTR_PREMIUM],
            }))
        : resp.payload.attributes;
      return textResult(JSON.stringify(summary));
    }
  );

  // ── resolve_rule_template ──────────────────────────────────────────
  tool(
    "resolve_rule_template",
    {
      title: "Resolve rule template",
      description: "Resolve a rule template's variables, returning the valid options for each selector (devices, persons, values, etc.)",
      inputSchema: {
        templateId: z.string().describe("Rule template ID (e.g. button-chime, 61da3b)"),
      },
      annotations: READ_ONLY,
    },
    async ({ templateId }) => {
      const notReady = await preflight(ctx);
      if (notReady) return notReady;
      const placeId = client.activePlaceId!;
      const resp = await request(client, `SERV:ruletmpl:${templateId}`, RuleTemplate.CMD_RESOLVE, { placeId });
      const selectors = resp.payload.attributes.selectors as Record<string, unknown> | undefined;
      if (!selectors) {
        return textResult(JSON.stringify(resp.payload));
      }
      // Summarize selectors: show name/address pairs for LIST types
      const summary: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(selectors)) {
        const sel = val as Record<string, unknown>;
        if (sel.type === "LIST" && Array.isArray(sel.options)) {
          summary[key] = {
            type: "LIST",
            options: (sel.options as Array<[string, string]>).map(([name, addr]) => ({ name, addr })),
          };
        } else {
          summary[key] = sel;
        }
      }
      return textResult(JSON.stringify(summary));
    }
  );

  // ── create_rule ────────────────────────────────────────────────────
  tool(
    "create_rule",
    {
      title: "Create rule",
      description: `Create a rule from a template. Use list_rule_templates to find available templates and their variables. The context maps template variables (e.g. "button", "switch", "contact") to device/person addresses.`,
      inputSchema: {
        templateId: z.string().describe("Rule template ID (e.g. button-chime, 61da3b)"),
        name: z.string().describe("Name for the rule"),
        description: z.string().describe("Description of the rule"),
        context: z
          .record(z.string(), z.string())
          .describe("Template variable mappings (e.g. {\"button\": \"DRIV:dev:abc-123\"})"),
      },
      annotations: writes({ destructive: false, idempotent: false }),
    },
    async ({ templateId, name, description, context }) => {
      const notReady = await preflight(ctx, { write: true });
      if (notReady) return notReady;
      const placeId = client.activePlaceId!;
      const resp = await request(
        client,
        `SERV:ruletmpl:${templateId}`,
        RuleTemplate.CMD_CREATERULE,
        { placeId, name, description, context }
      );
      return textResult(JSON.stringify(resp.payload));
    }
  );
}
