import type { DatabaseSync } from "node:sqlite";
import { type IsoDate, getTimeContext } from "@ia/data";
import { toolRegistry } from "../tools/registry.js";
import type { ToolCallRecord } from "../tools/types.js";
import type { IaStateStore, RunRecord } from "./stateStore.js";
import type { MemoryKind } from "./types.js";
import { ulid } from "../util/ulid.js";

export type EvalScores = {
  correctness: number;
  completeness: number;
  relevance: number;
  quality: number;
  notes?: string[];
};

export type EvaluatorConfig = {
  storeGoodThreshold?: number;
  storeFailureThreshold?: number;
};

export class MemoryEvaluator {
  private readonly store: IaStateStore;
  private readonly datasetDb: DatabaseSync;
  private readonly cfg: Required<EvaluatorConfig>;

  public constructor(opts: { store: IaStateStore; datasetDb: DatabaseSync; config?: EvaluatorConfig }) {
    this.store = opts.store;
    this.datasetDb = opts.datasetDb;
    this.cfg = {
      storeGoodThreshold: opts.config?.storeGoodThreshold ?? 0.8,
      storeFailureThreshold: opts.config?.storeFailureThreshold ?? 0.5
    };
  }

  public evaluate(run: { query: string; route?: string; toolCalls?: ToolCallRecord[]; today: IsoDate }): EvalScores | null {
    const spec = inferEvalSpec(run.query, run.today);
    if (!spec) return null;

    if (spec.type === "top_products") {
      return evaluateTopProducts({
        datasetDb: this.datasetDb,
        toolCalls: run.toolCalls ?? [],
        spec
      });
    }

    if (spec.type === "timeseries") {
      return evaluateTimeseries({ toolCalls: run.toolCalls ?? [], spec });
    }

    if (spec.type === "why_drop_wow") {
      return evaluateWhyDropWoW({ datasetDb: this.datasetDb, toolCalls: run.toolCalls ?? [], spec });
    }

    return null;
  }

  public proposeMemoryWrites(run: {
    userId: string;
    query: string;
    augmentedQuery?: string;
    route?: string;
    plan?: unknown;
    toolCalls?: ToolCallRecord[];
    response?: string;
    scores?: EvalScores | null;
  }): Array<{ scope: string; kind: MemoryKind; text: string; meta: Record<string, unknown>; importance: number; quality: number }> {
    const quality = run.scores?.quality;
    if (quality == null) return [];

    const scope = `user:${run.userId}`;
    const writes: Array<{ scope: string; kind: MemoryKind; text: string; meta: Record<string, unknown>; importance: number; quality: number }> = [];

    const canonical = canonicalizeQuery(run.query);

    if (quality >= this.cfg.storeGoodThreshold) {
      writes.push({
        scope,
        kind: "query_pattern",
        text: `Query pattern: ${canonical}`,
        meta: { route: run.route },
        importance: 0.35,
        quality
      });

      const topTool = (run.toolCalls ?? []).find((t) => t.tool === "top_products");
      if (topTool) {
        writes.push({
          scope,
          kind: "tool_template",
          text: `Tool template for "${canonical}": use top_products with args=${JSON.stringify(topTool.args)}`,
          meta: { tool: "top_products", args: topTool.args, route: run.route },
          importance: 0.45,
          quality
        });
      }
    } else if (quality <= this.cfg.storeFailureThreshold) {
      const note = run.scores?.notes?.join(" ") ?? "Run quality was low.";
      writes.push({
        scope,
        kind: "failure_case",
        text: `Failure case for "${canonical}": ${note}`,
        meta: { route: run.route, plan: run.plan, toolCalls: run.toolCalls },
        importance: 0.4,
        quality
      });
    } else {
      writes.push({
        scope,
        kind: "query_pattern",
        text: `Query pattern: ${canonical}`,
        meta: { route: run.route },
        importance: 0.2,
        quality
      });
    }

    return writes;
  }

  public applyMemoryWrites(writes: Array<{ scope: string; kind: MemoryKind; text: string; meta: Record<string, unknown>; importance: number; quality: number }>): void {
    const now = new Date().toISOString();
    for (const w of writes) {
      this.store.upsertMemoryItem({
        id: ulid(),
        scope: w.scope,
        kind: w.kind,
        text: w.text,
        meta: w.meta,
        createdAt: now,
        lastUsedAt: now,
        useCount: 0,
        importance: w.importance,
        quality: w.quality,
        expiresAt: null
      });
    }
  }
}

type EvalSpec =
  | {
      type: "top_products";
      metric: "sales" | "units" | "sessions" | "conversion_rate";
      limit: number;
      startDate: IsoDate;
      endDate: IsoDate;
    }
  | {
      type: "timeseries";
      metric: "sales" | "units" | "sessions" | "conversion_rate";
      startDate: IsoDate;
      endDate: IsoDate;
    }
  | {
      type: "why_drop_wow";
      metric: "sales" | "units" | "sessions" | "conversion_rate";
      thisWeekStart: IsoDate;
      thisWeekEnd: IsoDate;
      lastWeekStart: IsoDate;
      lastWeekEnd: IsoDate;
    };

function inferEvalSpec(query: string, today: IsoDate): EvalSpec | null {
  const q = query.toLowerCase();
  const ctx = getTimeContext(today);

  const limitMatch = q.match(/top\s+(\d+)\s+products/);
  const limit = limitMatch ? Math.max(1, Math.min(100, Number(limitMatch[1]))) : 10;

  let metric: Extract<EvalSpec, { type: "top_products" }>["metric"] = "sales";
  if (q.includes("traffic") || q.includes("sessions")) metric = "sessions";
  else if (q.includes("units")) metric = "units";
  else if (q.includes("conversion")) metric = "conversion_rate";

  if (q.includes("top") && q.includes("products") && (q.includes("last month") || q.includes("this month") || q.includes("last week"))) {
    const range =
      q.includes("last month")
        ? { startDate: ctx.lastMonthStart, endDate: ctx.lastMonthEnd }
        : q.includes("this month")
          ? { startDate: ctx.thisMonthStart, endDate: ctx.thisMonthEnd }
          : { startDate: ctx.lastWeekStart, endDate: ctx.lastWeekEnd };
    return { type: "top_products", metric, limit, ...range };
  }

  if ((q.includes("traffic") || q.includes("sessions")) && q.includes("those products")) {
    const range =
      q.includes("last month")
        ? { startDate: ctx.lastMonthStart, endDate: ctx.lastMonthEnd }
        : q.includes("this month")
          ? { startDate: ctx.thisMonthStart, endDate: ctx.thisMonthEnd }
          : q.includes("last week")
            ? { startDate: ctx.lastWeekStart, endDate: ctx.lastWeekEnd }
            : { startDate: ctx.lastMonthStart, endDate: ctx.lastMonthEnd };
    return { type: "timeseries", metric: "sessions", ...range };
  }

  if (q.includes("why") && q.includes("drop") && q.includes("wow")) {
    return {
      type: "why_drop_wow",
      metric,
      thisWeekStart: ctx.thisWeekStart,
      thisWeekEnd: ctx.thisWeekEnd,
      lastWeekStart: ctx.lastWeekStart,
      lastWeekEnd: ctx.lastWeekEnd
    };
  }

  return null;
}

function evaluateTopProducts(opts: {
  datasetDb: DatabaseSync;
  toolCalls: ToolCallRecord[];
  spec: Extract<EvalSpec, { type: "top_products" }>;
}): EvalScores {
  const expected = toolRegistry.top_products.execute(
    { datasetDb: opts.datasetDb },
    {
      metric: opts.spec.metric,
      startDate: opts.spec.startDate,
      endDate: opts.spec.endDate,
      limit: opts.spec.limit
    }
  ).rows;

  const call = opts.toolCalls.find((c) => c.tool === "top_products");
  if (!call) {
    return { correctness: 0, completeness: 0, relevance: 0, quality: 0, notes: ["Missing top_products call."] };
  }

  const actualRows = (call.result as any)?.rows as Array<{ productId: string; metricValue: number }> | undefined;
  if (!actualRows || actualRows.length === 0) {
    return { correctness: 0, completeness: 0, relevance: 0.2, quality: 0.07, notes: ["Empty tool result."] };
  }

  const n = Math.min(opts.spec.limit, expected.length, actualRows.length);
  let matches = 0;
  for (let i = 0; i < n; i++) {
    const e = expected[i]!;
    const a = actualRows[i]!;
    const idOk = e.productId === a.productId;
    const valOk = nearlyEqual(e.metricValue, a.metricValue, 0.01);
    if (idOk && valOk) matches++;
  }
  const correctness = n > 0 ? matches / n : 0;
  const completeness = Math.min(1, actualRows.length / opts.spec.limit);

  const args = call.args as any;
  const relevance =
    args &&
    args.metric === opts.spec.metric &&
    args.startDate === opts.spec.startDate &&
    args.endDate === opts.spec.endDate
      ? 1
      : 0.4;

  const quality = (correctness + completeness + relevance) / 3;
  const notes: string[] = [];
  if (relevance < 1) notes.push("Time range or metric differed from expected.");
  if (correctness < 1) notes.push(`Top list mismatch: ${matches}/${n} rows match.`);
  return { correctness, completeness, relevance, quality, notes };
}

function evaluateWhyDropWoW(opts: {
  datasetDb: DatabaseSync;
  toolCalls: ToolCallRecord[];
  spec: Extract<EvalSpec, { type: "why_drop_wow" }>;
}): EvalScores {
  const hasTimeseries = opts.toolCalls.some((c) => c.tool === "timeseries");
  const hasChanges = opts.toolCalls.some((c) => c.tool === "compute_changes");

  const topCalls = opts.toolCalls.filter((c) => c.tool === "top_products");
  const thisWeek = topCalls.find((c) =>
    argsMatchTopProducts(c.args, opts.spec.metric, opts.spec.thisWeekStart, opts.spec.thisWeekEnd)
  );
  const lastWeek = topCalls.find((c) =>
    argsMatchTopProducts(c.args, opts.spec.metric, opts.spec.lastWeekStart, opts.spec.lastWeekEnd)
  );
  const hasTopComparison = Boolean(thisWeek && lastWeek);

  const relevance = hasTopComparison || (hasTimeseries && hasChanges) ? 1 : 0.5;

  // Completeness: either we compared the same metric across two adjacent weeks, or we ran a series+changes analysis.
  let completeness = 0;
  if (hasTopComparison) completeness = 0.8;
  if (hasTimeseries) completeness = Math.max(completeness, 0.5);
  if (hasChanges) completeness = Math.max(completeness, 0.3);
  if (hasTimeseries && hasChanges) completeness = Math.max(completeness, 0.9);

  // Correctness: if we have the expected weekly leader calls, verify the leader productIds.
  let correctness = 0.2;
  const notes: string[] = [];

  if (hasTopComparison && thisWeek && lastWeek) {
    const expectedThis = toolRegistry.top_products.execute(
      { datasetDb: opts.datasetDb },
      { metric: opts.spec.metric, startDate: opts.spec.thisWeekStart, endDate: opts.spec.thisWeekEnd, limit: 1 }
    ).rows[0]?.productId;
    const expectedLast = toolRegistry.top_products.execute(
      { datasetDb: opts.datasetDb },
      { metric: opts.spec.metric, startDate: opts.spec.lastWeekStart, endDate: opts.spec.lastWeekEnd, limit: 1 }
    ).rows[0]?.productId;

    const actualThis = firstTopProductId(thisWeek);
    const actualLast = firstTopProductId(lastWeek);

    const checks: Array<{ label: string; expected: string | undefined; actual: string | undefined }> = [
      { label: "thisWeek", expected: expectedThis, actual: actualThis },
      { label: "lastWeek", expected: expectedLast, actual: actualLast }
    ];

    const comparable = checks.filter((c) => c.expected && c.actual);
    const matches = comparable.filter((c) => c.expected === c.actual).length;
    correctness = comparable.length ? matches / comparable.length : 0.6;

    for (const c of comparable) {
      if (c.expected !== c.actual) notes.push(`Top product mismatch for ${c.label}.`);
    }
  } else if (hasTimeseries && hasChanges) {
    correctness = 0.6;
  }

  if (!hasTopComparison && !(hasTimeseries && hasChanges)) {
    notes.push("Missing top_products comparison for last week vs this week.");
  }

  if (hasTopComparison) {
    if (!hasTimeseries && !hasChanges) notes.push("No timeseries/compute_changes drilldown; used weekly comparisons only.");
  } else {
    if (!hasTimeseries) notes.push("Missing timeseries call.");
    if (!hasChanges) notes.push("Missing compute_changes call.");
  }

  const quality = (correctness + completeness + relevance) / 3;
  return { correctness, completeness, relevance, quality, notes };
}

function argsMatchTopProducts(args: unknown, metric: string, startDate: IsoDate, endDate: IsoDate): boolean {
  if (!args || typeof args !== "object") return false;
  const a = args as any;
  return a.metric === metric && a.startDate === startDate && a.endDate === endDate;
}

function firstTopProductId(call: ToolCallRecord): string | undefined {
  const rows = (call.result as any)?.rows as Array<{ productId: string }> | undefined;
  return rows?.[0]?.productId;
}

function evaluateTimeseries(opts: { toolCalls: ToolCallRecord[]; spec: Extract<EvalSpec, { type: "timeseries" }> }): EvalScores {
  const call = opts.toolCalls.find((c) => c.tool === "timeseries");
  if (!call) {
    return { correctness: 0, completeness: 0, relevance: 0, quality: 0, notes: ["Missing timeseries call."] };
  }

  const args = call.args as any;
  const relevance =
    args &&
    args.metric === opts.spec.metric &&
    args.startDate === opts.spec.startDate &&
    args.endDate === opts.spec.endDate
      ? 1
      : 0.4;

  const series = (call.result as any)?.series as Array<{
    productId: string;
    points: Array<{ date: string; value: number }>;
  }> | undefined;
  if (!series || series.length === 0) {
    return { correctness: 0, completeness: 0.2, relevance, quality: (0 + 0.2 + relevance) / 3, notes: ["Empty series."] };
  }

  const expectedCount = Array.isArray(args?.productIds) ? args.productIds.length : series.length;
  const completeness = expectedCount > 0 ? Math.min(1, series.length / expectedCount) : 0.5;

  let inRangePoints = 0;
  let totalPoints = 0;
  for (const s of series) {
    for (const p of s.points ?? []) {
      totalPoints++;
      if (p.date >= opts.spec.startDate && p.date <= opts.spec.endDate) inRangePoints++;
    }
  }
  const correctness = totalPoints > 0 ? inRangePoints / totalPoints : 0.5;

  const quality = (correctness + completeness + relevance) / 3;
  const notes: string[] = [];
  if (relevance < 1) notes.push("Metric or time range differed from expected.");
  if (correctness < 1) notes.push("Some points were outside the expected range.");
  return { correctness, completeness, relevance, quality, notes };
}

function nearlyEqual(a: number, b: number, relTol: number): boolean {
  const diff = Math.abs(a - b);
  if (a === b) return true;
  const denom = Math.max(1, Math.abs(a), Math.abs(b));
  return diff / denom <= relTol;
}

function canonicalizeQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replaceAll(/\d{4}-\d{2}-\d{2}/g, "<date>")
    .replaceAll(/\b\d+\b/g, "<n>")
    .replaceAll(/\s+/g, " ");
}
