import type { LLMClient, LLMCompleteParams, LLMCompletion } from "./types.js";

type ChatCompletionResponse = {
  choices: Array<{ message: { role: string; content: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

export class OpenAICompatLLMClient implements LLMClient {
  public readonly name = "openai-compat";
  private readonly apiRoot: string;
  private readonly defaultModel: string;
  private readonly apiKey: string | undefined;

  public constructor(opts: { baseUrl: string; model: string; apiKey?: string }) {
    const baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiRoot = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    this.defaultModel = opts.model;
    this.apiKey = opts.apiKey;
  }

  public async complete(params: LLMCompleteParams): Promise<LLMCompletion> {
    const start = Date.now();
    const model = params.model ?? this.defaultModel;

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const messages = [
      ...(params.instructions ? [{ role: "system", content: params.instructions }] : []),
      ...params.messages.map((m) => ({ role: m.role, content: m.content }))
    ];

    const res = await fetch(`${this.apiRoot}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages,
        temperature: params.temperature ?? 0.2,
        max_tokens: params.maxOutputTokens ?? 800
      })
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenAI-compat request failed: ${res.status} ${res.statusText} ${text}`.trim());
    }

    const json = (await res.json()) as ChatCompletionResponse;
    const content = json.choices[0]?.message?.content ?? "";
    const usage =
      json.usage &&
      (json.usage.prompt_tokens != null || json.usage.completion_tokens != null || json.usage.total_tokens != null)
        ? {
            ...(json.usage.prompt_tokens != null ? { inputTokens: json.usage.prompt_tokens } : {}),
            ...(json.usage.completion_tokens != null ? { outputTokens: json.usage.completion_tokens } : {}),
            ...(json.usage.total_tokens != null ? { totalTokens: json.usage.total_tokens } : {})
          }
        : null;

    return {
      text: content,
      ...(usage ? { usage } : {}),
      latencyMs: Date.now() - start,
      raw: json
    };
  }
}
