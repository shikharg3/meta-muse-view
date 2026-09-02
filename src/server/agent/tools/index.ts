/**
 * The tool registry.
 *
 * One module per domain, collected here. This file is the ONLY place that knows the full set, so
 * adding a capability is a new file plus one line — not surgery on a switch every other domain
 * shares. Order matters only for how the list reads to the model; keep the everyday data tools first.
 *
 * `toolsFor` filters by role before the definitions ever reach the model. Showing a tool the caller
 * cannot run would be worse than hiding it: the model would offer the capability and then fail.
 */
import { listClients, getClientStats } from "./clients";
import {
  getOverview,
  listActiveCampaigns,
  searchEntitiesTool,
  listAccounts,
  getAdSets,
} from "./performance";
import { alertTools } from "./alerts";
import { healthTools } from "./health";
import { trendTools } from "./trends";
import { budgetTools } from "./budget";
import { infraTools } from "./infra";
import { activityTools } from "./activity";
import { attributionTools } from "./attribution";
import { scheduleTools } from "./schedules";
import { meetsRole, type AgentTool, type ToolContext } from "./kit";
import type { AnthropicTool } from "../anthropic";

export const REGISTRY: AgentTool[] = [
  listClients,
  getClientStats,
  getOverview,
  listActiveCampaigns,
  getAdSets,
  searchEntitiesTool,
  listAccounts,
  ...trendTools,
  ...budgetTools,
  ...alertTools,
  ...healthTools,
  ...activityTools,
  ...infraTools,
  ...attributionTools,
  ...scheduleTools,
];

const BY_NAME = new Map(REGISTRY.map((t) => [t.definition.name, t]));

/** Definitions the caller is allowed to use, in registry order. */
export const toolsFor = (ctx: ToolContext): AnthropicTool[] =>
  REGISTRY.filter((t) => meetsRole(ctx.role, t.requires)).map((t) => t.definition);

/** Human label for the UI trace; falls back to the raw name for an unknown tool. */
export const toolLabel = (name: string): string => BY_NAME.get(name)?.label ?? name;

/**
 * Execute a tool by name. Always resolves — errors come back as data so the model can react to them
 * (ask a clarifying question, try another tool) instead of the turn dying.
 */
export async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const tool = BY_NAME.get(name);
  if (!tool) return { error: `Unknown tool: ${name}` };
  if (!meetsRole(ctx.role, tool.requires)) {
    return {
      error: `That needs ${tool.requires} access. Tell the user you can't run this for them.`,
    };
  }
  try {
    return await tool.run(input, ctx);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export { resolveClient } from "./kit";
export type { AgentTool, ToolContext } from "./kit";
