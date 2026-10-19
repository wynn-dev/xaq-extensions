// W1 owns this; identical copy until rebase
import type { z } from "zod";
import type { GoogleClient } from "./google.ts";
export type Risk = "read" | "write" | "risky";
export interface ToolOutput { text: string; structured?: Record<string, unknown> }
export interface ExtTool<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string; title: string; description: string; input: S; risk: Risk;
  target?: string; // JSON Pointer into args, for "always allow for this target"
  run(args: z.infer<z.ZodObject<S>>, g: GoogleClient): Promise<ToolOutput>;
}
