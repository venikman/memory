import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { seedSellerAnalyticsData } from "@ia/data";
import { FakeLLMClient } from "../src/llm/fake.js";
import { IaStateStore } from "../src/memory/stateStore.js";
import { ScenarioRunner } from "../src/scenarios/runner.js";

describe("ScenarioRunner (memory effect with fake LLM)", () => {
  it("improves quality when memory read is enabled", async () => {
    const datasetDb = new DatabaseSync(":memory:");
    seedSellerAnalyticsData(datasetDb, { seed: 42, days: 120, startDate: "2025-10-01" });

    const llm = new FakeLLMClient("baseline-confused");

    const scenario = {
      id: "t",
      title: "t",
      seed: 42,
      today: "2026-02-04",
      steps: [{ query: "What were the sales for my top 10 products last month?" }]
    } as const;

    const runner = new ScenarioRunner({
      datasetDb,
      llm,
      stateStoreFactory: () => new IaStateStore(":memory:")
    });

    const [baseline, read] = await runner.runScenario({
      scenario: scenario as any,
      userId: "demo",
      configs: ["baseline", "read"],
      repeat: 1
    });

    assert.ok(baseline?.aggregate.avgQuality != null);
    assert.ok(read?.aggregate.avgQuality != null);
    assert.ok(read.aggregate.avgQuality > baseline.aggregate.avgQuality);
    datasetDb.close();
  });
});
