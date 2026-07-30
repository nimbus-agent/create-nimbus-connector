import type { GeneratedFile } from "../types.ts";

export function emitTsconfig(): GeneratedFile {
  const cfg = {
    extends: "../../../tsconfig.base.json",
    compilerOptions: { types: ["bun"] },
    include: ["src/**/*"],
    exclude: ["node_modules", "dist"],
  };
  return { path: ["tsconfig.json"], content: `${JSON.stringify(cfg, undefined, 2)}\n` };
}
