import { z } from "zod";

export const ScenarioStepSchema = z.object({
  id: z.string().optional(),
  query: z.string()
});

export const ScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  seed: z.number().int(),
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  steps: z.array(ScenarioStepSchema).min(1)
});

export type Scenario = z.infer<typeof ScenarioSchema>;

export type ScenarioConfigName = "baseline" | "read" | "readwrite" | "readwrite_cache";

