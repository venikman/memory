import type { LLMClient } from "../llm/types.js";
import type { MemoryCard } from "../memory/types.js";
import type { Route } from "./types.js";

export type ManagerDecision = {
  ood: boolean;
  route?: Route;
  reason?: string;
};

export class ManagerAgent {
  private readonly llm: LLMClient | null;

  public constructor(llm: LLMClient | null) {
    this.llm = llm;
  }

  public async decide(params: {
    query: string;
    augmentedQuery: string;
    memoryCards?: MemoryCard[];
  }): Promise<ManagerDecision> {
    const heuristic = heuristicDecision(params.query);
    if (!this.llm || heuristic.confident) return heuristic.decision;

    const instructions = [
      "You are a manager agent for a tabular data insights assistant.",
      "Decide if the user query is in-scope (data insight on seller analytics) and route it:",
      "- data_presenter: descriptive analytics / tables / charts",
      "- insight_generator: diagnostic / summarization / benchmarking / recommendations",
      "Return ONLY valid JSON: {\"ood\": boolean, \"route\": \"data_presenter\"|\"insight_generator\", \"reason\": string }",
      ...(params.memoryCards?.length ? ["", "Relevant long-term memory:", ...params.memoryCards.map((c) => c.text)] : [])
    ].join("\n");

    const res = await this.llm.complete({
      instructions,
      messages: [{ role: "user", content: params.augmentedQuery }],
      temperature: 0
    });

    const parsed = safeParseJsonDecision(res.text);
    if (parsed) return parsed;
    return heuristic.decision;
  }
}

function heuristicDecision(query: string): { confident: boolean; decision: ManagerDecision } {
  const q = query.toLowerCase();
  const looksLikeData =
    /(sales|revenue|units|sessions|traffic|conversion|benchmark|top\s+\d+|month|week|yoy|mom|wow)/i.test(query);

  const ood = !looksLikeData || /(weather|recipe|love|movie|music|politics|medical)/i.test(query);
  if (ood) {
    return { confident: true, decision: { ood: true, reason: "Out of scope for seller analytics." } };
  }

  const route = /(why|perform|benchmark|recommend|improve|diagnostic|compare|insight)/i.test(query)
    ? "insight_generator"
    : "data_presenter";

  return { confident: true, decision: { ood: false, route, reason: "Heuristic in-scope." } };
}

function safeParseJsonDecision(text: string): ManagerDecision | null {
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
  const slice = trimmed.slice(jsonStart, jsonEnd + 1);
  try {
    const obj = JSON.parse(slice) as any;
    if (typeof obj?.ood !== "boolean") return null;
    if (obj.ood) return { ood: true, reason: typeof obj.reason === "string" ? obj.reason : undefined };
    if (obj.route !== "data_presenter" && obj.route !== "insight_generator") return null;
    return { ood: false, route: obj.route, reason: typeof obj.reason === "string" ? obj.reason : undefined };
  } catch {
    return null;
  }
}

