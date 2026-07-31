import type { GeneratedFile } from "../types.ts";
import type { GenerateTarget } from "./index.ts";

const STANDALONE_COMPILER_OPTIONS = {
  target: "ESNext",
  module: "ESNext",
  moduleResolution: "bundler",
  lib: ["ESNext"],
  types: ["bun"],

  strict: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noPropertyAccessFromIndexSignature: true,
  forceConsistentCasingInFileNames: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  allowUnreachableCode: false,
  allowUnusedLabels: false,

  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  resolveJsonModule: true,
  isolatedModules: true,
  skipLibCheck: true,

  noEmit: true,
};

export function emitTsconfig(target: GenerateTarget): GeneratedFile {
  const cfg =
    target === "standalone"
      ? {
          compilerOptions: STANDALONE_COMPILER_OPTIONS,
          include: ["src/**/*"],
          exclude: ["node_modules", "dist"],
        }
      : {
          extends: "../../../tsconfig.base.json",
          compilerOptions: { types: ["bun"] },
          include: ["src/**/*"],
          exclude: ["node_modules", "dist"],
        };
  return { path: ["tsconfig.json"], content: `${JSON.stringify(cfg, undefined, 2)}\n` };
}
