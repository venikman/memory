import type { DatabaseSync } from "node:sqlite";
import type { LLMClient } from "../llm/types.js";
import { IaStateStore } from "../memory/stateStore.js";
import { IaOrchestrator } from "../orchestrator/orchestrator.js";
import type { RunResult } from "../orchestrator/types.js";
import type { Scenario, ScenarioConfigName } from "./types.js";

export type ScenarioRunSummary = {
  config: ScenarioConfigName;
  runs: Array<{
    stepIndex: number;
    query: string;
    runId: string;
    toolCalls: number;
    cachedToolCalls: number;
    latencyMs: number;
    scores?: { correctness: number; completeness: number; relevance: number; quality: number } | null;
    questionLevelAcc?: boolean | null;
  }>;
  aggregate: {
    avgQuality: number | null;
    questionLevelAccRate: number | null;
    toolCallsTotal: number;
    cachedToolCallsTotal: number;
    p90LatencyMs: number | null;
  };
};

export class ScenarioRunner {
  private readonly datasetDb: DatabaseSync;
  private readonly llm: LLMClient | null;
  private readonly stateStoreFactory: (config: ScenarioConfigName) => IaStateStore;
  private readonly toolCacheNamespace: string | undefined;

  public constructor(opts: {
    datasetDb: DatabaseSync;
    llm: LLMClient | null;
    stateStoreFactory: (config: ScenarioConfigName) => IaStateStore;
    toolCacheNamespace?: string;
  }) {
    this.datasetDb = opts.datasetDb;
    this.llm = opts.llm;
    this.stateStoreFactory = opts.stateStoreFactory;
    this.toolCacheNamespace = opts.toolCacheNamespace;
  }

  public async runScenario(opts: {
    scenario: Scenario;
    userId: string;
    configs: ScenarioConfigName[];
    repeat?: number;
    onRun?: (result: RunResult) => void;
  }): Promise<ScenarioRunSummary[]> {
    const repeat = Math.max(1, opts.repeat ?? 2);
    const summaries: ScenarioRunSummary[] = [];

    for (const config of opts.configs) {
      const store = this.stateStoreFactory(config);
      const orchestrator = new IaOrchestrator({
        llm: this.llm,
        datasetDb: this.datasetDb,
        store,
        ...(this.toolCacheNamespace ? { toolCacheNamespace: this.toolCacheNamespace } : {})
      });

      const runs: ScenarioRunSummary["runs"] = [];
      for (let pass = 0; pass < repeat; pass++) {
        let session: import("../agents/types.js").SessionState = {};
        for (let i = 0; i < opts.scenario.steps.length; i++) {
          const step = opts.scenario.steps[i]!;
          const t0 = Date.now();
          const result = await orchestrator.runQuery({
            query: step.query,
            userId: opts.userId,
            config: { memoryMode: config, today: opts.scenario.today as any },
            session
          });
          opts.onRun?.(result);
          const latencyMs = Date.now() - t0;

          session = result.sessionState;

          const toolCalls = result.toolCalls?.length ?? 0;
          const cached = result.toolCalls?.filter((c) => c.cached).length ?? 0;
          const qAcc = result.scores
            ? result.scores.correctness > 0.8 && result.scores.completeness > 0.8 && result.scores.relevance > 0.8
            : null;

          runs.push({
            stepIndex: pass * opts.scenario.steps.length + i,
            query: step.query,
            runId: result.id,
            toolCalls,
            cachedToolCalls: cached,
            latencyMs,
            scores: result.scores ?? null,
            questionLevelAcc: qAcc
          });
        }
      }

      const qualities = runs.map((r) => r.scores?.quality).filter((q): q is number => typeof q === "number");
      const avgQuality = qualities.length ? qualities.reduce((a, b) => a + b, 0) / qualities.length : null;

      const qAccs = runs.map((r) => r.questionLevelAcc).filter((v): v is boolean => typeof v === "boolean");
      const questionLevelAccRate = qAccs.length ? qAccs.filter(Boolean).length / qAccs.length : null;

      const toolCallsTotal = runs.reduce((a, r) => a + r.toolCalls, 0);
      const cachedToolCallsTotal = runs.reduce((a, r) => a + r.cachedToolCalls, 0);

      const p90LatencyMs = percentile(runs.map((r) => r.latencyMs), 0.9);

      summaries.push({
        config,
        runs,
        aggregate: {
          avgQuality,
          questionLevelAccRate,
          toolCallsTotal,
          cachedToolCallsTotal,
          p90LatencyMs
        }
      });

      store.close();
    }

    return summaries;
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.floor((sorted.length - 1) * p);
  return sorted[idx] ?? null;
}
