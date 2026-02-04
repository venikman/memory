import { z } from "zod";

export const MemoryKindSchema = z.enum([
  "tool_template",
  "query_pattern",
  "domain_rule",
  "insight_pattern",
  "failure_case",
  "user_preference"
]);

export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export type MemoryItem = {
  id: string;
  scope: string; // "global" | `user:${id}`
  kind: MemoryKind;
  text: string;
  meta: Record<string, unknown>;
  createdAt: string; // ISO timestamp
  lastUsedAt: string; // ISO timestamp
  useCount: number;
  importance: number; // 0..1
  quality: number; // 0..1
  expiresAt: string | null;
  dedupeKey: string;
};

export type MemorySearchHit = MemoryItem & { bm25: number; ftsRank: number };

export type MemoryCard = {
  id: string;
  kind: MemoryKind;
  scope: string;
  score: number;
  text: string;
};
