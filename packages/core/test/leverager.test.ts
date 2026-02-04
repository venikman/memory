import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IaStateStore } from "../src/memory/stateStore.js";
import { MemoryLeverager } from "../src/memory/leverager.js";

describe("MemoryLeverager", () => {
  it("retrieves matching domain_rule for last month queries", () => {
    const store = new IaStateStore(":memory:");
    const leverager = new MemoryLeverager(store, { k: 3 });

    const result = leverager.retrieve({
      stage: "workflow_plan",
      query: "Top 10 products last month by sales",
      scopes: ["global"]
    });

    // Orchestrator seeds a default domain rule at init; but here we didn't, so add one.
    if (result.cards.length === 0) {
      store.upsertMemoryItem({
        id: "rule1",
        scope: "global",
        kind: "domain_rule",
        text: "Last month refers to the previous calendar month.",
        meta: {},
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        useCount: 0,
        importance: 0.9,
        quality: 1,
        expiresAt: null
      });
    }

    const result2 = leverager.retrieve({
      stage: "workflow_plan",
      query: "Top 10 products last month by sales",
      scopes: ["global"]
    });

    assert.ok(result2.cards.length > 0);
    assert.ok(result2.cards[0]!.text.includes("MEMORY CARD"));
    store.close();
  });
});
