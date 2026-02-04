import { augmentQueryWithTimeContext, type IsoDate, type TimeContext } from "@ia/data";
import { z } from "zod";
import type { LLMClient } from "../llm/types.js";
import type { MemoryCard } from "../memory/types.js";
import { toolRegistry } from "../tools/registry.js";
import type { ToolName } from "../tools/types.js";
import { safeJsonParse } from "../util/json.js";
import type { Route, SessionState, WorkflowPlan } from "./types.js";
import { WorkflowPlanSchema } from "./types.js";

export type PlannerInput = {
  route: Route;
  query: string;
  augmentedQuery: string;
  timeContext: TimeContext;
  session: SessionState;
  memoryCards: MemoryCard[];
  model?: string;
};

export class WorkflowPlanner {
  private readonly llm: LLMClient | null;

  public constructor(llm: LLMClient | null) {
    this.llm = llm;
  }

  public async plan(input: PlannerInput): Promise<{ plan: WorkflowPlan; rawText?: string; usedFallback: boolean }> {
    const fallback = heuristicPlan(input);
    if (!this.llm) return { plan: fallback, usedFallback: true };

    const toolDocs = renderToolDocs();
    const instructions = [
      "You are a workflow planner for a tabular data-insights agent.",
      "Your job: produce a minimal executable plan as STRICT JSON.",
      "The JSON MUST be parseable by JSON.parse (no trailing commas, no comments).",
      "Use ONLY these tools. Each step must be one tool call with args matching the tool schema.",
      "",
      "OUTPUT_JSON_PLAN",
      "",
      `Route: ${input.route}`,
      "",
      "Tool registry:",
      toolDocs,
      "",
      input.session.selectedProductIds?.length
        ? `Working memory: selectedProductIds=${JSON.stringify(input.session.selectedProductIds)}`
        : "Working memory: none",
      ...(input.memoryCards.length ? ["", "Relevant long-term memory:", ...input.memoryCards.map((c) => c.text)] : []),
      "",
      "Return ONLY JSON that matches this TypeScript shape:",
      `{"route":"data_presenter"|"insight_generator","timeRange":{"startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD"},"steps":[{"tool":ToolName,"args":object}],"notes"?:string}`,
      "",
      "Rules:",
      "- Resolve relative time ranges using the injected time context.",
      "- If query mentions \"those products\", use selectedProductIds.",
      "- Keep max 6 steps.",
      "- Prefer top_products for top-N, timeseries for trends, benchmark for category baselines, compute_changes for change rates."
    ].join("\n");

    const res = await this.llm.complete({
      instructions,
      messages: [{ role: "user", content: input.augmentedQuery }],
      temperature: 0,
      maxOutputTokens: 700,
      ...(input.model ? { model: input.model } : {})
    });

    const parsed = parsePlan(res.text);
    if (parsed.ok) return { plan: parsed.plan, rawText: res.text, usedFallback: false };
    return { plan: fallback, rawText: res.text, usedFallback: true };
  }
}

function parsePlan(text: string): { ok: true; plan: WorkflowPlan } | { ok: false; error: string } {
  const trimmed = text.trim();
  const candidates = extractJsonObjectCandidates(trimmed);
  if (candidates.length === 0) return { ok: false, error: "No JSON object found." };

  let lastError = "";
  for (const candidate of candidates) {
    const cleaned = stripTrailingCommas(candidate.trim());
    const parsed = safeJsonParse<unknown>(cleaned);
    if (!parsed.ok) {
      lastError = parsed.error.message;
      continue;
    }

    const validated = WorkflowPlanSchema.safeParse(parsed.value);
    if (!validated.success) {
      lastError = validated.error.message;
      continue;
    }

    // Validate each step against tool schemas.
    for (const step of validated.data.steps) {
      const toolName = step.tool as ToolName;
      const def = (toolRegistry as any)[toolName];
      if (!def) return { ok: false, error: `Unknown tool: ${toolName}` };
      const argsResult = def.argsSchema.safeParse(step.args);
      if (!argsResult.success) return { ok: false, error: `Invalid args for ${toolName}: ${argsResult.error.message}` };
      (step as any).args = argsResult.data;
    }
    return { ok: true, plan: validated.data };
  }

  return { ok: false, error: lastError || "Failed to parse JSON plan." };
}

function renderToolDocs(): string {
  const lines: string[] = [];
  for (const [name, def] of Object.entries(toolRegistry)) {
    lines.push(`- ${name}: ${def.description}`);
    lines.push(`  argsSchema: ${def.argsSchema.toString()}`);
  }
  return lines.join("\n");
}

function stripTrailingCommas(json: string): string {
  // Common LLM failure mode: trailing commas in arrays/objects.
  // Safe: won't touch commas inside strings.
  return json.replace(/,\s*([}\]])/g, "$1");
}

function extractJsonObjectCandidates(text: string): string[] {
  // Try to extract *any* balanced {...} object from the output, in order.
  // This is more robust than slicing first "{" to last "}" when the model emits multiple blocks.
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let quote: "\"" | "'" | null = null;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (quote && ch === quote) {
        inString = false;
        quote = null;
      }
      continue;
    }

    if (ch === "\"" || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (ch === "}") {
      if (depth > 0) depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return out;
}

function heuristicPlan(input: PlannerInput): WorkflowPlan {
  const q = input.query.toLowerCase();
  const range = resolveRange(q, input.timeContext);
  const limitMatch = q.match(/top\s+(\d+)/);
  const limit = limitMatch ? Math.max(1, Math.min(100, Number(limitMatch[1]))) : 10;

  let metric: any = "sales";
  if (q.includes("traffic") || q.includes("sessions")) metric = "sessions";
  else if (q.includes("units")) metric = "units";
  else if (q.includes("conversion")) metric = "conversion_rate";

  const looksLikeWhyDropWoW = q.includes("wow") && q.includes("drop") && q.includes("why");
  if (looksLikeWhyDropWoW) {
    const thisWeek = { startDate: input.timeContext.thisWeekStart, endDate: input.timeContext.thisWeekEnd };
    const lastWeek = { startDate: input.timeContext.lastWeekStart, endDate: input.timeContext.lastWeekEnd };
    const wideLimit = 50;
    return {
      route: input.route,
      timeRange: thisWeek,
      steps: [
        { tool: "top_products", args: { metric: "sales", ...lastWeek, limit: wideLimit } },
        { tool: "top_products", args: { metric: "sales", ...thisWeek, limit: wideLimit } },
        { tool: "top_products", args: { metric: "sessions", ...lastWeek, limit: wideLimit } },
        { tool: "top_products", args: { metric: "sessions", ...thisWeek, limit: wideLimit } },
        { tool: "top_products", args: { metric: "units", ...lastWeek, limit: wideLimit } },
        { tool: "top_products", args: { metric: "units", ...thisWeek, limit: wideLimit } }
      ],
      notes: "Heuristic WoW drop analysis: compare this week vs last week across sales/sessions/units for all products."
    };
  }

  if (q.includes("those products") && input.session.selectedProductIds?.length) {
    return {
      route: input.route,
      timeRange: range,
      steps: [
        {
          tool: "timeseries",
          args: {
            metric,
            productIds: input.session.selectedProductIds,
            startDate: range.startDate,
            endDate: range.endDate,
            grain: "day"
          }
        }
      ],
      notes: "Heuristic plan for referenced products."
    };
  }

  if (q.includes("top") && q.includes("products")) {
    return {
      route: input.route,
      timeRange: range,
      steps: [
        {
          tool: "top_products",
          args: { metric, startDate: range.startDate, endDate: range.endDate, limit }
        }
      ],
      notes: "Heuristic top_products plan."
    };
  }

  // Fallback to listing products.
  return {
    route: input.route,
    timeRange: range,
    steps: [{ tool: "list_products", args: { limit: 20 } }],
    notes: "Heuristic fallback plan."
  };
}

function resolveRange(queryLower: string, ctx: TimeContext): { startDate: IsoDate; endDate: IsoDate } {
  if (queryLower.includes("last month")) return { startDate: ctx.lastMonthStart, endDate: ctx.lastMonthEnd };
  if (queryLower.includes("this month")) return { startDate: ctx.thisMonthStart, endDate: ctx.thisMonthEnd };
  if (queryLower.includes("last week")) return { startDate: ctx.lastWeekStart, endDate: ctx.lastWeekEnd };
  if (queryLower.includes("this week")) return { startDate: ctx.thisWeekStart, endDate: ctx.thisWeekEnd };
  // default: last month (gives stable demo results)
  return { startDate: ctx.lastMonthStart, endDate: ctx.lastMonthEnd };
}
