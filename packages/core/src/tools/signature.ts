import { createHash } from "node:crypto";
import { stableStringify } from "../util/json.js";
import type { ToolName } from "./types.js";

export function toolSignature(tool: ToolName, args: unknown, namespace?: string): string {
  const stable = stableStringify(args);
  const ns = namespace ? `${namespace}::` : "";
  const hash = createHash("sha256").update(`${ns}${tool}:${stable}`).digest("hex");
  return `${tool}:${hash}`;
}
