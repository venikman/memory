import { OpenRouter } from "@openrouter/sdk";
import type { LLMClient, LLMCompleteParams, LLMCompletion } from "./types.js";

export class OpenRouterLLMClient implements LLMClient {
  public readonly name = "openrouter";
  private readonly client: OpenRouter;
  private readonly defaultModel: string;

  public constructor(opts: { apiKey: string; model: string }) {
    this.client = new OpenRouter({ apiKey: opts.apiKey });
    this.defaultModel = opts.model;
  }

  public async complete(params: LLMCompleteParams): Promise<LLMCompletion> {
    const start = Date.now();
    const model = params.model ?? this.defaultModel;

    const result = this.client.callModel({
      model,
      instructions: params.instructions,
      input: params.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: params.temperature,
      maxOutputTokens: params.maxOutputTokens
    });

    const text = await result.getText();
    let raw: unknown;
    let usage:
      | {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
          costUsd?: number;
        }
      | null = null;

    try {
      const response = await result.getResponse();
      raw = response;
      if (response.usage && typeof response.usage.inputTokens === "number") {
        usage = {
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          totalTokens: response.usage.totalTokens,
          ...(typeof response.usage.cost === "number" ? { costUsd: response.usage.cost } : {})
        };
      }
    } catch {
      // ignore usage if getResponse fails
    }

    return {
      text,
      ...(usage ? { usage } : {}),
      latencyMs: Date.now() - start,
      ...(raw ? { raw } : {})
    };
  }
}
