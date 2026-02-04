import type { IaStateStore } from "../memory/stateStore.js";
import { toolRegistry } from "../tools/registry.js";
import { toolSignature } from "../tools/signature.js";
import type { ToolCallRecord } from "../tools/types.js";
import type { WorkflowPlan } from "./types.js";

export type ExecutorOptions = {
  enableCache: boolean;
  cacheNamespace?: string;
};

export class WorkflowExecutor {
  private readonly store: IaStateStore;
  private readonly datasetDb: import("node:sqlite").DatabaseSync;
  private readonly enableCache: boolean;
  private readonly cacheNamespace: string | undefined;

  public constructor(opts: { store: IaStateStore; datasetDb: import("node:sqlite").DatabaseSync; options: ExecutorOptions }) {
    this.store = opts.store;
    this.datasetDb = opts.datasetDb;
    this.enableCache = opts.options.enableCache;
    this.cacheNamespace = opts.options.cacheNamespace;
  }

  public execute(plan: WorkflowPlan): { toolCalls: ToolCallRecord[]; resultsByTool: Record<string, unknown> } {
    const toolCalls: ToolCallRecord[] = [];
    const resultsByTool: Record<string, unknown> = {};

    for (const step of plan.steps.slice(0, 6)) {
      const sig = toolSignature(step.tool, step.args, this.cacheNamespace);
      const startedAt = new Date().toISOString();
      const t0 = Date.now();

      if (this.enableCache) {
        const cached = this.store.getToolCache(sig);
        if (cached) {
          const durationMs = Date.now() - t0;
          const record: ToolCallRecord = {
            tool: step.tool,
            args: step.args,
            signature: sig,
            cached: true,
            startedAt,
            durationMs,
            result: cached.result
          };
          toolCalls.push(record);
          resultsByTool[step.tool] = cached.result;
          continue;
        }
      }

      const def = toolRegistry[step.tool];
      const result = def.execute({ datasetDb: this.datasetDb }, step.args as any);
      const durationMs = Date.now() - t0;

      if (this.enableCache) {
        this.store.setToolCache(step.tool, sig, step.args, result);
      }

      const record: ToolCallRecord = {
        tool: step.tool,
        args: step.args,
        signature: sig,
        cached: false,
        startedAt,
        durationMs,
        result
      };
      toolCalls.push(record);
      resultsByTool[step.tool] = result;
    }

    return { toolCalls, resultsByTool };
  }
}
