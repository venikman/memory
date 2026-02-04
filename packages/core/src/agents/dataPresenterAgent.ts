import type { IsoDate } from "@ia/data";
import type { LLMClient } from "../llm/types.js";
import type { MemoryCard } from "../memory/types.js";
import type { IaStateStore } from "../memory/stateStore.js";
import type { ToolCallRecord } from "../tools/types.js";
import type { SessionState, WorkflowPlan } from "./types.js";
import { WorkflowPlanner } from "./workflowPlanner.js";
import { WorkflowExecutor } from "./workflowExecutor.js";

export type DataPresenterResult = {
  plan: WorkflowPlan;
  toolCalls: ToolCallRecord[];
  responseText: string;
  sessionState: SessionState;
  usedFallbackPlanner: boolean;
  plannerRaw?: string;
};

export class DataPresenterAgent {
  private readonly planner: WorkflowPlanner;
  private readonly executor: WorkflowExecutor;

  public constructor(opts: {
    llm: LLMClient | null;
    store: IaStateStore;
    datasetDb: import("node:sqlite").DatabaseSync;
    enableCache: boolean;
    cacheNamespace?: string;
  }) {
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
  }): Promise<DataPresenterResult> {
    const { plan, rawText, usedFallback } = await this.planner.plan({
      route: "data_presenter",
      query: params.query,
      augmentedQuery: params.augmentedQuery,
      timeContext: params.timeContext,
      session: params.session,
      memoryCards: params.memoryCards ?? []
    });

    const { toolCalls, resultsByTool } = this.executor.execute(plan);
    const nextSession: SessionState = { ...params.session };

    const top = (toolCalls.find((c) => c.tool === "top_products")?.result as any)?.rows as Array<{ productId: string }> | undefined;
    if (top?.length) nextSession.selectedProductIds = top.map((r) => r.productId).slice(0, 20);

    const responseText = renderDataPresenterResponse(plan, toolCalls, resultsByTool);

    return {
      plan,
      toolCalls,
      responseText,
      sessionState: nextSession,
      usedFallbackPlanner: usedFallback,
      ...(rawText ? { plannerRaw: rawText } : {})
    };
  }
}

function renderDataPresenterResponse(plan: WorkflowPlan, toolCalls: ToolCallRecord[], resultsByTool: Record<string, unknown>): string {
  const header = plan.timeRange ? `Date range: ${plan.timeRange.startDate}..${plan.timeRange.endDate}` : "Date range: (unspecified)";

  const top = (resultsByTool.top_products as any)?.rows as Array<{ productId: string; productName: string; metric: string; metricValue: number }> | undefined;
  if (top?.length) {
    const metric = top[0]?.metric ?? "metric";
    const lines = [
      header,
      `Top ${top.length} products by ${metric}:`,
      ...top.map((r, idx) => `${idx + 1}. ${r.productName} (${r.productId}): ${formatNumber(r.metricValue)}`)
    ];
    return lines.join("\n");
  }

  const series = (resultsByTool.timeseries as any)?.series as Array<{ productId: string; metric: string; points: Array<{ date: string; value: number }> }> | undefined;
  if (series?.length) {
    const lines = [header, `Timeseries (${series[0]?.metric ?? "metric"}) for ${series.length} products:`];
    for (const s of series) {
      const last = s.points[s.points.length - 1];
      lines.push(`- ${s.productId}: ${s.points.length} points (last ${last?.date}: ${formatNumber(last?.value ?? 0)})`);
    }
    return lines.join("\n");
  }

  const products = (resultsByTool.list_products as any)?.products as Array<{ id: string; name: string; category: string }> | undefined;
  if (products?.length) {
    return [header, "Products:", ...products.map((p) => `- ${p.name} (${p.id}) — ${p.category}`)].join("\n");
  }

  return [header, "No results."].join("\n");
}

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}
