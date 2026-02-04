import type { MemoryCard, MemorySearchHit } from "./types.js";
import type { IaStateStore } from "./stateStore.js";

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

export type MemoryStage = "manager_route" | "workflow_plan" | "insight_generate";

export type MemoryLeveragerOptions = {
  k?: number;
  maxCardChars?: number;
};

export class MemoryLeverager {
  private readonly store: IaStateStore;
  private readonly k: number;
  private readonly maxCardChars: number;

  public constructor(store: IaStateStore, opts: MemoryLeveragerOptions = {}) {
    this.store = store;
    this.k = opts.k ?? 6;
    this.maxCardChars = opts.maxCardChars ?? 600;
  }

  public retrieve(params: {
    stage: MemoryStage;
    query: string;
    entities?: string[];
    scopes: string[];
    nowMs?: number;
  }): { cards: MemoryCard[]; hits: Array<{ id: string; score: number }> } {
    const retrievalQuery = buildRetrievalQuery(params.query, params.entities ?? []);
    const nowMs = params.nowMs ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const kinds = kindsForStage(params.stage);
    const hits = this.store.searchMemory({
      query: retrievalQuery,
      scopes: params.scopes,
      ...(kinds ? { kinds } : {}),
      limit: 30,
      nowIso
    });

    const scored = hits
      .map((h) => ({ hit: h, score: scoreHit(h, nowMs) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.k);

    const cards = scored.map(({ hit, score }) => renderCard(hit, score, this.maxCardChars));
    this.store.markMemoryUsed(scored.map((s) => s.hit.id), nowIso);

    return {
      cards,
      hits: scored.map(({ hit, score }) => ({ id: hit.id, score }))
    };
  }
}

function buildRetrievalQuery(query: string, entities: string[]): string {
  const clean = query.replaceAll(/\s+/g, " ").trim().toLowerCase();
  const phraseHints: string[] = [];
  if (clean.includes("last month")) phraseHints.push("\"last month\"");
  if (clean.includes("last week")) phraseHints.push("\"last week\"");
  if (clean.includes("top") && clean.includes("products")) phraseHints.push("\"top products\"");

  const tokens = [
    ...phraseHints,
    ...tokenize(clean),
    ...entities.flatMap((e) => tokenize(e.toLowerCase()))
  ]
    .filter((t) => t.length >= 3)
    .filter((t) => !STOPWORDS.has(t));

  const unique = [...new Set(tokens)].slice(0, 12);
  if (unique.length === 0) return clean;
  return unique.join(" OR ");
}

const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "show",
  "what",
  "were",
  "last",
  "this",
  "that",
  "those",
  "month",
  "week",
  "products",
  "product",
  "top"
]);

function tokenize(text: string): string[] {
  return text.match(/[a-z0-9_]+/g) ?? [];
}

function scoreHit(hit: MemorySearchHit, nowMs: number): number {
  const ftsRank = hit.ftsRank; // 0..1
  const lastUsedMs = Date.parse(hit.lastUsedAt);
  const ageMs = Number.isFinite(lastUsedMs) ? Math.max(0, nowMs - lastUsedMs) : TWO_WEEKS_MS;
  const recency = Math.exp(-ageMs / TWO_WEEKS_MS);
  const importance = hit.importance;
  const use = Math.log1p(hit.useCount);
  return 0.55 * ftsRank + 0.25 * recency + 0.15 * importance + 0.05 * use;
}

function renderCard(hit: MemorySearchHit, score: number, maxChars: number): MemoryCard {
  const header = `MEMORY CARD [${hit.kind}] (${hit.scope})`;
  const body = hit.text.replaceAll(/\s*\n\s*/g, "\n").trim();
  const signals = `Signals: q=${hit.quality.toFixed(2)} imp=${hit.importance.toFixed(2)} used=${hit.useCount} last=${hit.lastUsedAt.slice(0, 10)}`;
  const raw = [header, body, signals].join("\n");
  const text = raw.length > maxChars ? raw.slice(0, maxChars - 1) + "…" : raw;
  return { id: hit.id, kind: hit.kind, scope: hit.scope, score, text };
}

function kindsForStage(stage: MemoryStage): string[] | undefined {
  switch (stage) {
    case "manager_route":
      return ["domain_rule", "query_pattern", "user_preference"];
    case "workflow_plan":
      return ["tool_template", "query_pattern", "domain_rule", "failure_case", "user_preference"];
    case "insight_generate":
      return ["insight_pattern", "user_preference", "domain_rule", "failure_case", "query_pattern"];
  }
}
