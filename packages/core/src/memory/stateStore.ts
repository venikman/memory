import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { redactPII } from "../util/redact.js";
import { safeJsonParse, stableStringify } from "../util/json.js";
import { ulid } from "../util/ulid.js";
import type { ToolCallRecord } from "../tools/types.js";
import type { MemoryItem, MemoryKind, MemorySearchHit } from "./types.js";

export type RunRecord = {
  id: string;
  createdAt: string;
  userId: string;
  config: Record<string, unknown>;
  query: string;
  augmentedQuery?: string;
  route?: string;
  ood?: boolean;
  plan?: unknown;
  toolCalls?: ToolCallRecord[];
  response?: string;
  eval?: unknown;
  latencies?: Record<string, number>;
  memoryInjected?: unknown;
};

export class IaStateStore {
  public readonly db: DatabaseSync;
  public readonly path: string;

  public constructor(path: string) {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        user_id TEXT NOT NULL,
        config_json TEXT NOT NULL,
        query TEXT NOT NULL,
        augmented_query TEXT,
        route TEXT,
        ood INTEGER,
        plan_json TEXT,
        tool_calls_json TEXT,
        response TEXT,
        eval_json TEXT,
        latencies_json TEXT,
        memory_injected_json TEXT
      );

      CREATE TABLE IF NOT EXISTS memory_items (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        use_count INTEGER NOT NULL,
        importance REAL NOT NULL,
        quality REAL NOT NULL,
        expires_at TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS memory_items_dedupe
        ON memory_items(scope, kind, dedupe_key);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        text,
        kind,
        scope
      );

      CREATE TABLE IF NOT EXISTS tool_cache (
        signature TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        tool TEXT NOT NULL,
        args_json TEXT NOT NULL,
        result_json TEXT NOT NULL
      );
    `);
  }

  public close(): void {
    this.db.close();
  }

  public insertRun(run: RunRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO runs(
        id, created_at, user_id, config_json, query, augmented_query, route, ood,
        plan_json, tool_calls_json, response, eval_json, latencies_json, memory_injected_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    stmt.run(
      run.id,
      run.createdAt,
      run.userId,
      stableStringify(run.config),
      run.query,
      run.augmentedQuery ?? null,
      run.route ?? null,
      run.ood == null ? null : run.ood ? 1 : 0,
      run.plan == null ? null : stableStringify(run.plan),
      run.toolCalls == null ? null : stableStringify(run.toolCalls),
      run.response ?? null,
      run.eval == null ? null : stableStringify(run.eval),
      run.latencies == null ? null : stableStringify(run.latencies),
      run.memoryInjected == null ? null : stableStringify(run.memoryInjected)
    );
  }

  public static dedupeKey(kind: MemoryKind, text: string): string {
    const normalized = text
      .trim()
      .toLowerCase()
      .replaceAll(/\s+/g, " ")
      .slice(0, 2000);
    return createHash("sha256").update(`${kind}:${normalized}`).digest("hex");
  }

  public upsertMemoryItem(input: {
    id?: string;
    scope: string;
    kind: MemoryKind;
    text: string;
    meta?: Record<string, unknown>;
    createdAt?: string;
    lastUsedAt?: string;
    useCount?: number;
    importance?: number;
    quality?: number;
    expiresAt?: string | null;
    dedupeKey?: string;
  }): MemoryItem {
    const now = new Date().toISOString();
    const cleanedText = redactPII(input.text);
    const dedupeKey = input.dedupeKey ?? IaStateStore.dedupeKey(input.kind, cleanedText);

    const existing = this.db
      .prepare("SELECT id FROM memory_items WHERE scope=? AND kind=? AND dedupe_key=?")
      .get(input.scope, input.kind, dedupeKey) as { id: string } | undefined;

    const item: MemoryItem = {
      id: existing?.id ?? input.id ?? ulid(),
      scope: input.scope,
      kind: input.kind,
      text: cleanedText,
      meta: input.meta ?? {},
      createdAt: input.createdAt ?? now,
      lastUsedAt: input.lastUsedAt ?? now,
      useCount: input.useCount ?? 0,
      importance: clamp01(input.importance ?? 0.3),
      quality: clamp01(input.quality ?? 0.5),
      expiresAt: input.expiresAt ?? null,
      dedupeKey
    };

    if (existing) {
      this.db
        .prepare(
          `
          UPDATE memory_items
          SET text=?, meta_json=?, last_used_at=?, use_count=?, importance=?, quality=?, expires_at=?
          WHERE id=?
        `
        )
        .run(
          item.text,
          stableStringify(item.meta),
          item.lastUsedAt,
          item.useCount,
          item.importance,
          item.quality,
          item.expiresAt,
          item.id
        );
      this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(item.id);
      this.db.prepare("INSERT INTO memory_fts(id, text, kind, scope) VALUES(?,?,?,?)").run(
        item.id,
        item.text,
        item.kind,
        item.scope
      );
      return item;
    }

    this.db
      .prepare(
        `
        INSERT INTO memory_items(
          id, scope, kind, text, meta_json, dedupe_key, created_at, last_used_at,
          use_count, importance, quality, expires_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `
      )
      .run(
        item.id,
        item.scope,
        item.kind,
        item.text,
        stableStringify(item.meta),
        item.dedupeKey,
        item.createdAt,
        item.lastUsedAt,
        item.useCount,
        item.importance,
        item.quality,
        item.expiresAt
      );
    this.db
      .prepare("INSERT INTO memory_fts(id, text, kind, scope) VALUES(?,?,?,?)")
      .run(item.id, item.text, item.kind, item.scope);
    return item;
  }

  public getMemoryStats(): Array<{ kind: string; scope: string; count: number }> {
    return this.db
      .prepare("SELECT kind, scope, COUNT(*) as count FROM memory_items GROUP BY kind, scope ORDER BY count DESC")
      .all() as Array<{ kind: string; scope: string; count: number }>;
  }

  public searchMemory(opts: {
    query: string;
    scopes: string[];
    kinds?: string[];
    limit?: number;
    nowIso?: string;
  }): MemorySearchHit[] {
    const limit = Math.max(1, Math.min(50, opts.limit ?? 20));
    const nowIso = opts.nowIso ?? new Date().toISOString();
    const scopes = opts.scopes.length ? opts.scopes : ["global"];
    const scopePlaceholders = scopes.map(() => "?").join(",");

    const kinds = opts.kinds?.length ? opts.kinds : null;
    const kindClause = kinds ? `AND mi.kind IN (${kinds.map(() => "?").join(",")})` : "";

    const rows = this.db
      .prepare(
        `
        SELECT
          mi.id as id,
          mi.scope as scope,
          mi.kind as kind,
          mi.text as text,
          mi.meta_json as meta_json,
          mi.dedupe_key as dedupe_key,
          mi.created_at as created_at,
          mi.last_used_at as last_used_at,
          mi.use_count as use_count,
          mi.importance as importance,
          mi.quality as quality,
          mi.expires_at as expires_at,
          bm25(memory_fts) as bm25
        FROM memory_fts
        JOIN memory_items mi ON mi.id = memory_fts.id
        WHERE memory_fts MATCH ?
          AND (mi.expires_at IS NULL OR mi.expires_at > ?)
          AND mi.scope IN (${scopePlaceholders})
          ${kindClause}
        ORDER BY bm25 ASC
        LIMIT ${limit}
      `
      )
      .all(
        opts.query,
        nowIso,
        ...scopes,
        ...(kinds ? kinds : [])
      ) as Array<{
      id: string;
      scope: string;
      kind: string;
      text: string;
      meta_json: string;
      dedupe_key: string;
      created_at: string;
      last_used_at: string;
      use_count: number;
      importance: number;
      quality: number;
      expires_at: string | null;
      bm25: number;
    }>;

    return rows.map((r) => {
      const metaParsed = safeJsonParse<Record<string, unknown>>(r.meta_json);
      const meta = metaParsed.ok ? metaParsed.value : {};
      const ftsRank = 1 / (1 + Number(r.bm25));
      return {
        id: r.id,
        scope: r.scope,
        kind: r.kind as MemoryKind,
        text: r.text,
        meta,
        createdAt: r.created_at,
        lastUsedAt: r.last_used_at,
        useCount: Number(r.use_count),
        importance: Number(r.importance),
        quality: Number(r.quality),
        expiresAt: r.expires_at,
        dedupeKey: r.dedupe_key,
        bm25: Number(r.bm25),
        ftsRank
      };
    });
  }

  public markMemoryUsed(ids: string[], nowIso: string = new Date().toISOString()): void {
    const unique = [...new Set(ids)];
    const stmt = this.db.prepare("UPDATE memory_items SET last_used_at=?, use_count=use_count+1 WHERE id=?");
    for (const id of unique) stmt.run(nowIso, id);
  }

  public getToolCache(signature: string): { createdAt: string; result: unknown } | null {
    const row = this.db
      .prepare("SELECT created_at, result_json FROM tool_cache WHERE signature=?")
      .get(signature) as { created_at: string; result_json: string } | undefined;
    if (!row) return null;
    const parsed = safeJsonParse<unknown>(row.result_json);
    return { createdAt: row.created_at, result: parsed.ok ? parsed.value : row.result_json };
  }

  public setToolCache(tool: string, signature: string, args: unknown, result: unknown, nowIso?: string): void {
    const createdAt = nowIso ?? new Date().toISOString();
    this.db
      .prepare(
        `
        INSERT INTO tool_cache(signature, created_at, tool, args_json, result_json)
        VALUES(?,?,?,?,?)
        ON CONFLICT(signature) DO UPDATE SET created_at=excluded.created_at, result_json=excluded.result_json
      `
      )
      .run(signature, createdAt, tool, stableStringify(args), stableStringify(result));
  }

  public maintenance(nowIso: string = new Date().toISOString()): { expired: number } {
    const expiredRows = this.db
      .prepare("SELECT id FROM memory_items WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .all(nowIso) as Array<{ id: string }>;
    for (const r of expiredRows) {
      this.db.prepare("DELETE FROM memory_items WHERE id=?").run(r.id);
      this.db.prepare("DELETE FROM memory_fts WHERE id=?").run(r.id);
    }
    return { expired: expiredRows.length };
  }
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
