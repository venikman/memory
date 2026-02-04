import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { seedSellerAnalyticsData } from "@ia/data";
import { IaStateStore } from "../src/memory/stateStore.js";
import { MemoryEvaluator } from "../src/memory/evaluator.js";

describe("MemoryEvaluator", () => {
  it("scores perfect when tool call matches expected top_products", () => {
    const datasetDb = new DatabaseSync(":memory:");
    seedSellerAnalyticsData(datasetDb, { seed: 42, days: 120, startDate: "2025-10-01" });
    const store = new IaStateStore(":memory:");
    const evaluator = new MemoryEvaluator({ store, datasetDb });

    const query = "What were the sales for my top 10 products last month?";
    const toolCalls = [
      {
        tool: "top_products",
        args: { metric: "sales", startDate: "2026-01-01", endDate: "2026-01-31", limit: 10 },
        signature: "x",
        cached: false,
        startedAt: new Date().toISOString(),
        durationMs: 1,
        result: {
          rows: datasetDb
            .prepare(
              `
              SELECT p.id AS productId, p.name AS productName, SUM(o.sales) AS value
              FROM products p
              JOIN orders_daily o ON o.product_id = p.id
              WHERE o.date >= ? AND o.date <= ?
              GROUP BY p.id
              ORDER BY value DESC
              LIMIT 10
            `
            )
            .all("2026-01-01", "2026-01-31")
            .map((r: any) => ({ productId: r.productId, productName: r.productName, metric: "sales", metricValue: Number(r.value) }))
        }
      }
    ] as any;

    const scores = evaluator.evaluate({ query, route: "data_presenter", toolCalls, today: "2026-02-04" });
    assert.ok(scores);
    assert.ok(scores.quality > 0.95);
    store.close();
    datasetDb.close();
  });
});
