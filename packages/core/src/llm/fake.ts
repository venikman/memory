import type { LLMClient, LLMCompleteParams, LLMCompletion } from "./types.js";

export type FakeLlmMode = "always-correct" | "baseline-confused";

// A deterministic stub used for tests. It can improve when "MEMORY:" cards are present.
export class FakeLLMClient implements LLMClient {
  public readonly name = "fake";
  private readonly mode: FakeLlmMode;

  public constructor(mode: FakeLlmMode) {
    this.mode = mode;
  }

  public async complete(params: LLMCompleteParams): Promise<LLMCompletion> {
    const start = Date.now();
    const input = (params.instructions ?? "") + "\n" + params.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    const hasMemory = input.includes("MEMORY CARD");

    // Very small planner-like behavior: output a JSON plan.
    if (input.includes("OUTPUT_JSON_PLAN")) {
      const startDate = "2026-01-01";
      const endDate = "2026-01-31";

      const wantsSessionsThose = /those products/i.test(input) && /traffic|sessions/i.test(input);
      if (wantsSessionsThose) {
        const productIds = extractSelectedProductIds(input) ?? ["P_demo_1", "P_demo_2"];
        const plan = {
          route: "data_presenter",
          timeRange: { startDate, endDate },
          steps: [
            {
              tool: "timeseries",
              args: { metric: "sessions", productIds, startDate, endDate, grain: "day" }
            }
          ]
        };
        return { text: JSON.stringify(plan), latencyMs: Date.now() - start, raw: null };
      }

      const wantsSalesTop10 = /top\s+10\s+products/i.test(input) && /sales/i.test(input) && /last month/i.test(input);
      const metric = wantsSalesTop10 ? "sales" : /traffic|sessions/i.test(input) ? "sessions" : "sales";

      // baseline-confused intentionally picks wrong metric unless memory is present.
      const chosenMetric =
        this.mode === "baseline-confused" && !hasMemory ? (metric === "sales" ? "units" : metric) : metric;

      const plan = {
        route: /why|benchmark|perform/i.test(input) ? "insight_generator" : "data_presenter",
        timeRange: { startDate, endDate },
        steps: [
          {
            tool: "top_products",
            args: { metric: chosenMetric, startDate, endDate, limit: 10 }
          }
        ]
      };
      return { text: JSON.stringify(plan), latencyMs: Date.now() - start, raw: null };
    }

    // Generic assistant response.
    return {
      text: hasMemory ? "Using memory, here is a better answer." : "Here is an answer.",
      latencyMs: Date.now() - start,
      raw: null
    };
  }
}

function extractSelectedProductIds(input: string): string[] | null {
  const match = input.match(/selectedProductIds=(\[[^\]]*\])/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!) as unknown;
    if (!Array.isArray(parsed)) return null;
    const ids = parsed.filter((x) => typeof x === "string");
    return ids.length ? (ids as string[]) : null;
  } catch {
    return null;
  }
}
