import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";

export type ToolName =
  | "list_products"
  | "top_products"
  | "timeseries"
  | "benchmark"
  | "compute_changes";

export type ToolExecutionContext = {
  datasetDb: DatabaseSync;
};

export type ToolDefinition<TArgs extends z.ZodTypeAny, TResult extends z.ZodTypeAny> = {
  name: ToolName;
  description: string;
  argsSchema: TArgs;
  resultSchema: TResult;
  examples?: Array<{ input: z.input<TArgs>; output: z.input<TResult> }>;
  execute(ctx: ToolExecutionContext, args: z.output<TArgs>): z.output<TResult>;
};

export type ToolCallRecord = {
  tool: ToolName;
  args: unknown;
  signature: string;
  cached: boolean;
  startedAt: string;
  durationMs: number;
  result: unknown;
};

