import { describe, expect, it } from "vitest";
import { getTimeContext } from "../src/time.js";

describe("getTimeContext", () => {
  it("computes last month boundaries for 2026-02-04", () => {
    const ctx = getTimeContext("2026-02-04");
    expect(ctx.lastMonthStart).toBe("2026-01-01");
    expect(ctx.lastMonthEnd).toBe("2026-01-31");
    expect(ctx.thisWeekStart).toBe("2026-02-02");
    expect(ctx.thisWeekEnd).toBe("2026-02-08");
  });
});

