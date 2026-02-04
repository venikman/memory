import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { formatIsoDate, parseIsoDate, type IsoDate } from "./time.js";

export type SellerAnalyticsDb = {
  db: DatabaseSync;
  path: string;
};

export type SellerAnalyticsSeedOptions = {
  seed: number;
  productCount?: number;
  days?: number;
  startDate?: IsoDate;
};

export const SELLER_ANALYTICS_DEFAULTS = {
  productCount: 40,
  days: 365,
  startDate: "2025-08-01" as IsoDate
} as const;

export const MetricSchema = z.enum(["sales", "units", "sessions", "conversion_rate"]);
export type Metric = z.infer<typeof MetricSchema>;

export type ListProductsFilters = {
  category?: string;
  limit?: number;
};

export type TopProductsArgs = {
  metric: Metric;
  startDate: IsoDate;
  endDate: IsoDate;
  limit: number;
};

export type TimeseriesArgs = {
  metric: Metric;
  productIds: string[];
  startDate: IsoDate;
  endDate: IsoDate;
  grain: "day";
};

export type BenchmarkArgs = {
  metric: Metric;
  category: string;
  startDate: IsoDate;
  endDate: IsoDate;
};

export type ProductRow = {
  id: string;
  name: string;
  category: string;
};

export type TopProductRow = {
  productId: string;
  productName: string;
  metric: Metric;
  metricValue: number;
};

export type TimeseriesPoint = {
  date: IsoDate;
  value: number;
};

export type TimeseriesRow = {
  productId: string;
  metric: Metric;
  points: TimeseriesPoint[];
};

export type BenchmarkRow = {
  category: string;
  metric: Metric;
  value: number;
};

export function openSellerAnalyticsDb(path: string): SellerAnalyticsDb {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  return { db, path };
}

export function initSellerAnalyticsSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders_daily (
      date TEXT NOT NULL,
      product_id TEXT NOT NULL,
      sales REAL NOT NULL,
      units INTEGER NOT NULL,
      PRIMARY KEY(date, product_id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS traffic_daily (
      date TEXT NOT NULL,
      product_id TEXT NOT NULL,
      sessions INTEGER NOT NULL,
      PRIMARY KEY(date, product_id),
      FOREIGN KEY(product_id) REFERENCES products(id)
    );

    CREATE TABLE IF NOT EXISTS benchmarks_daily (
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      sales REAL NOT NULL,
      units REAL NOT NULL,
      sessions REAL NOT NULL,
      conversion_rate REAL NOT NULL,
      PRIMARY KEY(date, category)
    );
  `);
}

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!;
}

function stableProductId(seed: number, index: number): string {
  const h = createHash("sha256").update(`${seed}:${index}`).digest("hex").slice(0, 12);
  return `P${h}`;
}

function stableProductName(rng: Rng, index: number): string {
  const adj = ["Prime", "Eco", "Ultra", "Mini", "Max", "Pro", "Smart", "Fresh", "Swift", "Zen"] as const;
  const noun = ["Widget", "Gadget", "Bottle", "Pack", "Kit", "Lamp", "Mixer", "Mug", "Chair", "Case"] as const;
  return `${pick(rng, adj)} ${pick(rng, noun)} ${index + 1}`;
}

export function seedSellerAnalyticsData(db: DatabaseSync, opts: SellerAnalyticsSeedOptions): void {
  const rng = mulberry32(opts.seed);
  const productCount = opts.productCount ?? SELLER_ANALYTICS_DEFAULTS.productCount;
  const days = opts.days ?? SELLER_ANALYTICS_DEFAULTS.days;
  const startDate = opts.startDate ?? SELLER_ANALYTICS_DEFAULTS.startDate;

  initSellerAnalyticsSchema(db);

  db.exec("DELETE FROM orders_daily;");
  db.exec("DELETE FROM traffic_daily;");
  db.exec("DELETE FROM benchmarks_daily;");
  db.exec("DELETE FROM products;");

  const categories = ["Home", "Beauty", "Electronics", "Sports", "Office"] as const;

  const insertProduct = db.prepare("INSERT INTO products(id, name, category) VALUES(?,?,?)");
  for (let i = 0; i < productCount; i++) {
    const id = stableProductId(opts.seed, i);
    const name = stableProductName(rng, i);
    const category = pick(rng, categories);
    insertProduct.run(id, name, category);
  }

  const products = db.prepare("SELECT id, category FROM products").all() as { id: string; category: string }[];

  const insertOrder = db.prepare(
    "INSERT INTO orders_daily(date, product_id, sales, units) VALUES(?,?,?,?)"
  );
  const insertTraffic = db.prepare(
    "INSERT INTO traffic_daily(date, product_id, sessions) VALUES(?,?,?)"
  );
  const insertBenchmark = db.prepare(
    "INSERT INTO benchmarks_daily(date, category, sales, units, sessions, conversion_rate) VALUES(?,?,?,?,?,?)"
  );

  const start = parseIsoDate(startDate);
  for (let d = 0; d < days; d++) {
    const date = formatIsoDate(new Date(start.getTime() + d * 24 * 60 * 60 * 1000));

    const byCategory: Record<string, { sales: number; units: number; sessions: number }> = {};
    for (const c of categories) byCategory[c] = { sales: 0, units: 0, sessions: 0 };

    for (const p of products) {
      const season = 1 + 0.25 * Math.sin((2 * Math.PI * d) / 30);
      const baseSessions = 40 + 200 * rng();
      const sessions = Math.max(0, Math.round(baseSessions * season * (0.7 + rng())));
      const conv = 0.01 + 0.08 * rng();
      const units = Math.max(0, Math.round(sessions * conv * (0.7 + rng())));
      const price = 8 + 60 * rng();
      const sales = Number((units * price * (0.85 + 0.3 * rng())).toFixed(2));

      insertTraffic.run(date, p.id, sessions);
      insertOrder.run(date, p.id, sales, units);

      const agg = byCategory[p.category] ?? (byCategory[p.category] = { sales: 0, units: 0, sessions: 0 });
      agg.sales += sales;
      agg.units += units;
      agg.sessions += sessions;
    }

    for (const c of categories) {
      const agg = byCategory[c]!;
      const conversion_rate = agg.sessions > 0 ? agg.units / agg.sessions : 0;
      insertBenchmark.run(
        date,
        c,
        Number(agg.sales.toFixed(2)),
        Number(agg.units.toFixed(2)),
        Number(agg.sessions.toFixed(2)),
        Number(conversion_rate.toFixed(6))
      );
    }
  }
}

export function listProducts(db: DatabaseSync, filters: ListProductsFilters = {}): ProductRow[] {
  const limit = Math.max(1, Math.min(500, filters.limit ?? 100));
  if (filters.category) {
    return db
      .prepare("SELECT id, name, category FROM products WHERE category = ? LIMIT ?")
      .all(filters.category, limit) as ProductRow[];
  }
  return db.prepare("SELECT id, name, category FROM products LIMIT ?").all(limit) as ProductRow[];
}

function metricSql(metric: Metric): { select: string; joinTraffic: boolean } {
  switch (metric) {
    case "sales":
      return { select: "SUM(o.sales) AS value", joinTraffic: false };
    case "units":
      return { select: "SUM(o.units) AS value", joinTraffic: false };
    case "sessions":
      return { select: "SUM(t.sessions) AS value", joinTraffic: true };
    case "conversion_rate":
      return { select: "CASE WHEN SUM(t.sessions)=0 THEN 0 ELSE SUM(o.units)*1.0/SUM(t.sessions) END AS value", joinTraffic: true };
  }
}

export function topProducts(db: DatabaseSync, args: TopProductsArgs): TopProductRow[] {
  const { select, joinTraffic } = metricSql(args.metric);
  const limit = Math.max(1, Math.min(100, args.limit));
  const base = `
    SELECT p.id AS productId, p.name AS productName, ${select}
    FROM products p
    JOIN orders_daily o ON o.product_id = p.id
    ${joinTraffic ? "JOIN traffic_daily t ON t.product_id = p.id AND t.date = o.date" : ""}
    WHERE o.date >= ? AND o.date <= ?
    GROUP BY p.id
    ORDER BY value DESC
    LIMIT ?
  `;
  const rows = db.prepare(base).all(args.startDate, args.endDate, limit) as Array<{
    productId: string;
    productName: string;
    value: number;
  }>;
  return rows.map((r) => ({
    productId: r.productId,
    productName: r.productName,
    metric: args.metric,
    metricValue: Number(r.value)
  }));
}

export function timeseries(db: DatabaseSync, args: TimeseriesArgs): TimeseriesRow[] {
  const { joinTraffic } = metricSql(args.metric);
  const idSet = args.productIds.filter(Boolean);
  if (idSet.length === 0) return [];

  const placeholders = idSet.map(() => "?").join(",");

  if (args.metric === "sales" || args.metric === "units") {
    const col = args.metric === "sales" ? "o.sales" : "o.units";
    const rows = db
      .prepare(
        `
        SELECT o.product_id as productId, o.date as date, ${col} as value
        FROM orders_daily o
        WHERE o.product_id IN (${placeholders})
          AND o.date >= ? AND o.date <= ?
        ORDER BY o.product_id, o.date
      `
      )
      .all(...idSet, args.startDate, args.endDate) as Array<{ productId: string; date: IsoDate; value: number }>;

    const byProduct = new Map<string, TimeseriesPoint[]>();
    for (const r of rows) {
      const list = byProduct.get(r.productId) ?? [];
      list.push({ date: r.date, value: Number(r.value) });
      byProduct.set(r.productId, list);
    }
    return [...byProduct.entries()].map(([productId, points]) => ({
      productId,
      metric: args.metric,
      points
    }));
  }

  const rows = db
    .prepare(
      `
      SELECT o.product_id as productId, o.date as date,
        o.units as units, t.sessions as sessions
      FROM orders_daily o
      JOIN traffic_daily t ON t.product_id = o.product_id AND t.date = o.date
      WHERE o.product_id IN (${placeholders})
        AND o.date >= ? AND o.date <= ?
      ORDER BY o.product_id, o.date
    `
    )
    .all(...idSet, args.startDate, args.endDate) as Array<{
    productId: string;
    date: IsoDate;
    units: number;
    sessions: number;
  }>;

  const byProduct = new Map<string, TimeseriesPoint[]>();
  for (const r of rows) {
    const list = byProduct.get(r.productId) ?? [];
    const value = args.metric === "sessions" ? Number(r.sessions) : r.sessions > 0 ? Number(r.units) / Number(r.sessions) : 0;
    list.push({ date: r.date, value: Number(value) });
    byProduct.set(r.productId, list);
  }
  return [...byProduct.entries()].map(([productId, points]) => ({
    productId,
    metric: args.metric,
    points
  }));
}

export function benchmark(db: DatabaseSync, args: BenchmarkArgs): BenchmarkRow {
  const rows = db
    .prepare(
      `
      SELECT AVG(${args.metric}) AS value
      FROM benchmarks_daily
      WHERE category = ?
        AND date >= ? AND date <= ?
    `
    )
    .get(args.category, args.startDate, args.endDate) as { value: number } | undefined;
  return { category: args.category, metric: args.metric, value: Number(rows?.value ?? 0) };
}

export type Changes = {
  startValue: number;
  endValue: number;
  absChange: number;
  pctChange: number;
};

export function computeChanges(points: TimeseriesPoint[]): Changes | null {
  if (points.length < 2) return null;
  const start = points[0]!;
  const end = points[points.length - 1]!;
  const absChange = end.value - start.value;
  const pctChange = start.value === 0 ? (end.value === 0 ? 0 : 1) : absChange / start.value;
  return {
    startValue: start.value,
    endValue: end.value,
    absChange,
    pctChange
  };
}
