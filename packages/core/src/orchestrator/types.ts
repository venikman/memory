import type { IsoDate } from "@ia/data";
import type { SessionState } from "../agents/types.js";
import type { EvalScores } from "../memory/evaluator.js";
import type { MemoryCard } from "../memory/types.js";
import type { ToolCallRecord } from "../tools/types.js";

export type MemoryMode = "baseline" | "read" | "readwrite" | "readwrite_cache";

export type RunConfig = {
  memoryMode: MemoryMode;
  llmModel?: string;
  today?: IsoDate;
};

export type RunResult = {
  id: string;
  createdAt: string;
  query: string;
  augmentedQuery: string;
  userId: string;
  route?: string;
  ood: boolean;
  responseText: string;
  planner?: {
    usedFallback: boolean;
    rawText?: string;
  };
  plan?: unknown;
  toolCalls?: ToolCallRecord[];
  scores?: EvalScores | null;
  memoryInjected: {
    manager_route?: MemoryCard[];
    workflow_plan?: MemoryCard[];
    insight_generate?: MemoryCard[];
  };
  latencies: Record<string, number>;
  sessionState: SessionState;
};
