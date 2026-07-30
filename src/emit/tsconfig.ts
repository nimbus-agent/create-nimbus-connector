import type { GeneratedFile } from "../types.ts";
import type { GenerateTarget } from "./index.ts";

export function emitTsconfig(target: GenerateTarget = "monorepo"): GeneratedFile {
  const cfg: Record<string, unknown> = {};

  // For monorepo, include extends first (to match original property order)
  if (target === "monorepo") {
    cfg.extends = "../../../tsconfig.base.json";
  }

  cfg.compilerOptions = { types: ["bun"] };
  cfg.include = ["src/**/*"];
  cfg.exclude = ["node_modules", "dist"];

  return { path: ["tsconfig.json"], content: `${JSON.stringify(cfg, undefined, 2)}\n` };
}
