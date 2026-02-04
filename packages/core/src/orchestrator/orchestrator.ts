import { augmentQueryWithTimeContext, getTimeContext, type IsoDate } from "@ia/data";
import type { DatabaseSync } from "node:sqlite";
import { DataPresenterAgent } from "../agents/dataPresenterAgent.js";
import { InsightGeneratorAgent } from "../agents/insightGeneratorAgent.js";
import { ManagerAgent } from "../agents/managerAgent.js";
import type { SessionState } from "../agents/types.js";
import type { LLMClient } from "../llm/types.js";
import { MemoryEvaluator } from "../memory/evaluator.js";
import { MemoryLeverager } from "../memory/leverager.js";
import { IaStateStore } from "../memory/stateStore.js";
import { redactPII } from "../util/redact.js";
import { ulid } from "../util/ulid.js";
import type { RunConfig, RunResult } from "./types.js";

export class IaOrchestrator {
  private readonly llm: LLMClient | null;
  private readonly datasetDb: DatabaseSync;
  private readonly store: IaStateStore;
  private readonly toolCacheNamespace: string | undefined;
  private readonly leverager: MemoryLeverager;
  private readonly evaluator: MemoryEvaluator;

  public constructor(opts: { llm: LLMClient | null; datasetDb: DatabaseSync; store: IaStateStore; toolCacheNamespace?: string }) {
    this.llm = opts.llm;
    this.datasetDb = opts.datasetDb;
    this.store = opts.store;
    this.toolCacheNamespace = opts.toolCacheNamespace;
    this.leverager = new MemoryLeverager(this.store);
    this.evaluator = new MemoryEvaluator({ store: this.store, datasetDb: this.datasetDb });
    this.ensureDefaultDomainRules();
  }

  public async runQuery(params: { query: string; userId: string; config: RunConfig; session?: SessionState }): Promise<RunResult> {
    const runId = ulid();
    const createdAt = new Date().toISOString();
    const session: SessionState = params.session ?? {};

    const today = params.config.today ?? (new Date().toISOString().slice(0, 10) as IsoDate);
    const timeContext = getTimeContext(today);
    const augmentedQuery = augmentQueryWithTimeContext(params.query, timeContext);

    const latencies: Record<string, number> = {};
    const memoryInjected: RunResult["memoryInjected"] = {};

    const scopes = ["global", `user:${params.userId}`];

    const managerMem =
      params.config.memoryMode === "baseline"
        ? []
        : this.leverager.retrieve({ stage: "manager_route", query: params.query, scopes }).cards;
    if (managerMem.length) memoryInjected.manager_route = managerMem;

    const manager = new ManagerAgent(this.llm);
    const t0 = Date.now();
    const decision = await manager.decide({ query: params.query, augmentedQuery, memoryCards: managerMem });
    latencies.manager_route_ms = Date.now() - t0;

    if (decision.ood || !decision.route) {
      const responseText = redactPII("Out of scope: I can help with seller analytics (sales, traffic, benchmarks).");
      const result: RunResult = {
        id: runId,
        createdAt,
        query: params.query,
        augmentedQuery,
        userId: params.userId,
        ood: true,
        responseText,
        memoryInjected,
        latencies,
        sessionState: session
      };
      this.store.insertRun({
        id: runId,
        createdAt,
        userId: params.userId,
        config: params.config,
        query: params.query,
        augmentedQuery,
        ood: true,
        response: responseText,
        latencies,
        memoryInjected
      });
      return result;
    }

    const enableCache = params.config.memoryMode === "readwrite_cache";

    const workerMem =
      params.config.memoryMode === "baseline"
        ? []
        : this.leverager.retrieve({ stage: "workflow_plan", query: params.query, scopes, nowMs: Date.now() }).cards;
    if (workerMem.length) memoryInjected.workflow_plan = workerMem;

    const t1 = Date.now();
    let plan: unknown;
    let toolCalls: any[] | undefined;
    let responseText = "";
    let usedFallbackPlanner = false;
    let plannerRawText: string | undefined;

    if (decision.route === "data_presenter") {
      const agent = new DataPresenterAgent({
        llm: this.llm,
        store: this.store,
        datasetDb: this.datasetDb,
        enableCache,
        ...(this.toolCacheNamespace ? { cacheNamespace: this.toolCacheNamespace } : {})
      });
      const out = await agent.run({
        query: params.query,
        augmentedQuery,
        timeContext,
        session,
        memoryCards: workerMem
      });
      plan = out.plan;
      toolCalls = out.toolCalls;
      responseText = out.responseText;
      usedFallbackPlanner = out.usedFallbackPlanner;
      plannerRawText = out.plannerRaw;
      Object.assign(session, out.sessionState);
    } else {
      const genMem =
        params.config.memoryMode === "baseline"
          ? []
          : this.leverager.retrieve({ stage: "insight_generate", query: params.query, scopes }).cards;
      if (genMem.length) memoryInjected.insight_generate = genMem;

      const agent = new InsightGeneratorAgent({
        llm: this.llm,
        store: this.store,
        datasetDb: this.datasetDb,
        enableCache,
        ...(this.toolCacheNamespace ? { cacheNamespace: this.toolCacheNamespace } : {})
      });
      const out = await agent.run({
        query: params.query,
        augmentedQuery,
        timeContext,
        session,
        memoryCards: [...workerMem, ...genMem]
      });
      plan = out.plan;
      toolCalls = out.toolCalls;
      responseText = out.responseText;
      usedFallbackPlanner = out.usedFallbackPlanner;
      plannerRawText = out.plannerRaw;
    }

    latencies.worker_total_ms = Date.now() - t1;

    responseText = redactPII(responseText);

    const t2 = Date.now();
    const scores = this.evaluator.evaluate({ query: params.query, route: decision.route, toolCalls, today });
    latencies.eval_ms = Date.now() - t2;

    if (params.config.memoryMode === "readwrite" || params.config.memoryMode === "readwrite_cache") {
      const writes = this.evaluator.proposeMemoryWrites({
        userId: params.userId,
        query: params.query,
        augmentedQuery,
        route: decision.route,
        plan,
        toolCalls,
        response: responseText,
        scores
      });
      this.evaluator.applyMemoryWrites(writes);
      this.store.maintenance();
    }

    const result: RunResult = {
      id: runId,
      createdAt,
      query: params.query,
      augmentedQuery,
      userId: params.userId,
      route: decision.route,
      ood: false,
      responseText,
      planner: {
        usedFallback: usedFallbackPlanner,
        ...(usedFallbackPlanner && plannerRawText ? { rawText: plannerRawText } : {})
      },
      plan,
      toolCalls,
      scores,
      memoryInjected,
      latencies,
      sessionState: session
    };

    this.store.insertRun({
      id: runId,
      createdAt,
      userId: params.userId,
      config: params.config,
      query: params.query,
      augmentedQuery,
      route: decision.route,
      ood: false,
      plan,
      toolCalls,
      response: responseText,
      eval: scores,
      latencies,
      memoryInjected
    });

    return result;
  }

  private ensureDefaultDomainRules(): void {
    const now = new Date().toISOString();
    this.store.upsertMemoryItem({
      id: "domain_rule_calendar_week",
      scope: "global",
      kind: "domain_rule",
      text: "Weeks are calendar weeks (Mon–Sun). \"Last week\" refers to the previous calendar week; \"last month\" refers to the previous calendar month.",
      meta: { source: "default" },
      createdAt: now,
      lastUsedAt: now,
      useCount: 0,
      importance: 0.9,
      quality: 1,
      expiresAt: null
    });
  }
}
