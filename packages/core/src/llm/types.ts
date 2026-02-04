export type LLMRole = "user" | "assistant";

export type LLMMessage = {
  role: LLMRole;
  content: string;
};

export type LLMUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
};

export type LLMCompletion = {
  text: string;
  usage?: LLMUsage;
  latencyMs: number;
  raw?: unknown;
};

export type LLMCompleteParams = {
  instructions?: string;
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
};

export interface LLMClient {
  readonly name: string;
  complete(params: LLMCompleteParams): Promise<LLMCompletion>;
}

