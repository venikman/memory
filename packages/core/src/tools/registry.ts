import { z } from "zod";
import {
  MetricSchema,
  benchmark,
  computeChanges,
  listProducts,
  timeseries,
  topProducts
} from "@ia/data";
import type { ToolDefinition, ToolExecutionContext, ToolName } from "./types.js";

const IsoDateSchema = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const s = v.trim();
  // Accept full ISO timestamps by trimming to YYYY-MM-DD.
  return s.length >= 10 ? s.slice(0, 10) : s;
}, z.string().regex(/^\d{4}-\d{2}-\d{2}$/));

function normalizeMetricInput(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s = v.trim().toLowerCase();
  if (s === "revenue" || s === "gmv") return "sales";
  if (s === "traffic" || s === "visits" || s === "visit") return "sessions";
  if (s === "conversion" || s === "cvr") return "conversion_rate";
  return s;
}

const MetricCoercedSchema = z.preprocess(normalizeMetricInput, MetricSchema);

function normalizeIntInput(v: unknown): unknown {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s) return v;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : v;
}

function normalizeArgsObject(v: unknown): Record<string, unknown> | unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  return { ...(v as Record<string, unknown>) };
}

export const toolRegistry: Record<ToolName, ToolDefinition<any, any>> = {
  list_products: {
    name: "list_products",
    description: "List products, optionally filtered by category.",
    argsSchema: z.object({
      category: z.string().optional(),
      limit: z.preprocess(normalizeIntInput, z.number().int().min(1).max(500)).optional()
    }),
    resultSchema: z.object({
      products: z.array(z.object({ id: z.string(), name: z.string(), category: z.string() }))
    }),
    execute: (ctx: ToolExecutionContext, args) => ({ products: listProducts(ctx.datasetDb, args) })
  },
  top_products: {
    name: "top_products",
    description: "Return the top N products by a metric over a date range.",
    argsSchema: z.preprocess((v) => {
      const obj = normalizeArgsObject(v) as Record<string, unknown> | unknown;
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
      const o = obj as Record<string, unknown>;

      // Key aliases
      if (o.limit == null && o.n != null) o.limit = o.n;
      if (o.limit == null && o.topN != null) o.limit = o.topN;
      if (o.startDate == null && o.start_date != null) o.startDate = o.start_date;
      if (o.endDate == null && o.end_date != null) o.endDate = o.end_date;

      // Value aliases
      if (o.metric != null) o.metric = normalizeMetricInput(o.metric);
      if (o.limit != null) o.limit = normalizeIntInput(o.limit);
      return o;
    }, z.object({
      metric: MetricCoercedSchema,
      startDate: IsoDateSchema,
      endDate: IsoDateSchema,
      limit: z.preprocess(normalizeIntInput, z.number().int().min(1).max(100))
    })),
    resultSchema: z.object({
      rows: z.array(
        z.object({
          productId: z.string(),
          productName: z.string(),
          metric: MetricSchema,
          metricValue: z.number()
        })
      )
    }),
    execute: (ctx: ToolExecutionContext, args) => ({ rows: topProducts(ctx.datasetDb, args) })
  },
  timeseries: {
    name: "timeseries",
    description: "Return a per-day time series for one or more products over a date range.",
    argsSchema: z.preprocess((v) => {
      const obj = normalizeArgsObject(v) as Record<string, unknown> | unknown;
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
      const o = obj as Record<string, unknown>;

      if (o.productIds == null && o.product_ids != null) o.productIds = o.product_ids;
      if (o.startDate == null && o.start_date != null) o.startDate = o.start_date;
      if (o.endDate == null && o.end_date != null) o.endDate = o.end_date;
      if (o.metric != null) o.metric = normalizeMetricInput(o.metric);
      if (o.grain === "daily") o.grain = "day";
      if (typeof o.productIds === "string") o.productIds = [o.productIds];
      return o;
    }, z.object({
      metric: MetricCoercedSchema,
      productIds: z.array(z.string()).min(1),
      startDate: IsoDateSchema,
      endDate: IsoDateSchema,
      grain: z.literal("day")
    })),
    resultSchema: z.object({
      series: z.array(
        z.object({
          productId: z.string(),
          metric: MetricSchema,
          points: z.array(z.object({ date: IsoDateSchema, value: z.number() }))
        })
      )
    }),
    execute: (ctx: ToolExecutionContext, args) => ({ series: timeseries(ctx.datasetDb, args) })
  },
  benchmark: {
    name: "benchmark",
    description: "Return a benchmark (category average) for a metric over a date range.",
    argsSchema: z.preprocess((v) => {
      const obj = normalizeArgsObject(v) as Record<string, unknown> | unknown;
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
      const o = obj as Record<string, unknown>;
      if (o.startDate == null && o.start_date != null) o.startDate = o.start_date;
      if (o.endDate == null && o.end_date != null) o.endDate = o.end_date;
      if (o.metric != null) o.metric = normalizeMetricInput(o.metric);
      return o;
    }, z.object({
      metric: MetricCoercedSchema,
      category: z.string(),
      startDate: IsoDateSchema,
      endDate: IsoDateSchema
    })),
    resultSchema: z.object({
      category: z.string(),
      metric: MetricSchema,
      value: z.number()
    }),
    execute: (ctx: ToolExecutionContext, args) => benchmark(ctx.datasetDb, args)
  },
  compute_changes: {
    name: "compute_changes",
    description: "Compute absolute and percent change for a time series.",
    argsSchema: z.object({
      points: z.array(z.object({ date: IsoDateSchema, value: z.number() })).min(2)
    }),
    resultSchema: z.object({
      startValue: z.number(),
      endValue: z.number(),
      absChange: z.number(),
      pctChange: z.number()
    }).nullable(),
    execute: (_ctx, args) => computeChanges(args.points)
  }
};
