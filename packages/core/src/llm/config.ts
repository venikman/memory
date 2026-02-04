export type OpenRouterConfig = {
  provider: "openrouter";
  apiKey: string;
  model: string;
};

export type OpenAICompatConfig = {
  provider: "openai-compat";
  baseUrl: string;
  model: string;
  apiKey?: string;
};

export type LLMProviderConfig = OpenRouterConfig | OpenAICompatConfig;

export function loadDefaultLlmConfigFromEnv(): LLMProviderConfig | null {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const openRouterModel = process.env.OPENROUTER_MODEL ?? "grok-4.1-fast";
  if (openRouterKey) {
    return { provider: "openrouter", apiKey: openRouterKey, model: openRouterModel };
  }

  const baseUrl = process.env.OPENAI_BASE_URL;
  const openAiModel = process.env.OPENAI_MODEL;
  if (baseUrl && openAiModel) {
    const apiKey = process.env.OPENAI_API_KEY;
    return {
      provider: "openai-compat",
      baseUrl,
      model: openAiModel,
      ...(apiKey ? { apiKey } : {})
    };
  }

  return null;
}
