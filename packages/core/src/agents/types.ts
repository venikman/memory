import { z } from "zod";
import type { ToolName } from "../tools/types.js";

export const RouteSchema = z.enum(["data_presenter", "insight_generator"]);
export type Route = z.infer<typeof RouteSchema>;

export const PlanStepSchema = z.object({
  tool: z.custom<ToolName>((v) => typeof v === "string"),
  args: z.unknown()
});

export type PlanStep = {
  tool: ToolName;
  args: unknown;
};

export const WorkflowPlanSchema = z.object({
  route: RouteSchema,
  timeRange: z
    .object({
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    })
    .optional(),
  steps: z.array(PlanStepSchema).min(1),
  notes: z.string().optional()
});

export type WorkflowPlan = z.infer<typeof WorkflowPlanSchema>;

export type SessionState = {
  selectedProductIds?: string[];
};

