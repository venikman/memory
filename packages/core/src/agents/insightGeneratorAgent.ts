import type { LLMClient } from "../llm/types.js";
import type { MemoryCard } from "../memory/types.js";
import type { IaStateStore } from "../memory/stateStore.js";
import type { ToolCallRecord } from "../tools/types.js";
import type { SessionState, WorkflowPlan } from "./types.js";
import { WorkflowPlanner } from "./workflowPlanner.js";
import { WorkflowExecutor } from "./workflowExecutor.js";

export type InsightGeneratorResult = {
  plan: WorkflowPlan;
  toolCalls: ToolCallRecord[];
  responseText: string;
  sessionState: SessionState;
  usedFallbackPlanner: boolean;
  plannerRaw?: string;
};

export class InsightGeneratorAgent {
  private readonly llm: LLMClient | null;
  private readonly planner: WorkflowPlanner;
  private readonly executor: WorkflowExecutor;

  public constructor(opts: {
    llm: LLMClient | null;
    store: IaStateStore;
    datasetDb: import("node:sqlite").DatabaseSync;
    enableCache: boolean;
    cacheNamespace?: string;
  }) {
    this.llm = opts.llm;
    this.planner = new WorkflowPlanner(opts.llm);
    this.executor = new WorkflowExecutor({
      store: opts.store,
      datasetDb: opts.datasetDb,
      options: { enableCache: opts.enableCache, ...(opts.cacheNamespace ? { cacheNamespace: opts.cacheNamespace } : {}) }
    });
  }

  public async run(params: {
    query: string;
    augmentedQuery: string;
    timeContext: import("@ia/data").TimeContext;
    session: SessionState;
    memoryCards?: MemoryCard[];
  }): Promise<InsightGeneratorResult> {
    const { plan, rawText, usedFallback } = await this.planner.plan({
      route: "insight_generator",
      query: params.query,
      augmentedQuery: params.augmentedQuery,
      timeContext: params.timeContext,
      session: params.session,
      memoryCards: params.memoryCards ?? []
    });

    const { toolCalls } = this.executor.execute(plan);

    const narrative = await this.generateNarrative(params.query, plan, toolCalls, params.memoryCards);
    return {
      plan,
      toolCalls,
      responseText: narrative,
      sessionState: params.session,
      usedFallbackPlanner: usedFallback,
      ...(rawText ? { plannerRaw: rawText } : {})
    };
  }

  private async generateNarrative(
    query: string,
    plan: WorkflowPlan,
    toolCalls: ToolCallRecord[],
    memoryCards?: MemoryCard[]
  ): Promise<string> {
    const header = plan.timeRange ? `Date range: ${plan.timeRange.startDate}..${plan.timeRange.endDate}` : "";
    const dataJson = JSON.stringify({ plan, toolCalls }, null, 2);

    if (!this.llm) {
      return [header, "Insights:", "- (LLM not configured)"].filter(Boolean).join("\n");
    }

    const instructions = [
      "You are an insight generator for a seller analytics assistant.",
      "Generate a concise diagnostic insight grounded ONLY in the provided data JSON.",
      "Do not invent columns or numbers.",
      "If a tool result has an empty rows/series array, treat it as 'no data returned for that range' (not zero).",
      "If the question is about a WoW drop and you have weekly totals for sales/units/sessions, decompose changes via:",
      "- conversion_rate = units / sessions",
      "- price = sales / units (when units > 0)",
      "Return a short bullet list plus 1-2 sentences of summary."
    ].join("\n");

    const res = await this.llm.complete({
      instructions,
      messages: [
        ...(memoryCards?.length
          ? [{ role: "user" as const, content: `CONTEXT (memory cards):\n${memoryCards.map((c) => c.text).join("\n\n")}` }]
          : []),
        { role: "user", content: `Question: ${query}\n${header}\n\nDATA_JSON:\n${dataJson}` }
      ],
      temperature: 0.3,
      maxOutputTokens: 600
    });

    return res.text.trim();
  }
}
