import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";
import { validateSpec } from "../validate.ts";
import { emitBiomeJson } from "./biome-json.ts";
import { emitManifest } from "./manifest.ts";
import { emitPackageJson } from "./package-json.ts";
import { emitReadme } from "./readme.ts";
import { emitSandboxTest } from "./sandbox-test.ts";
import { emitServer } from "./server/index.ts";
import { emitTsconfig } from "./tsconfig.ts";

export type GenerateTarget = "monorepo" | "standalone";
export type GenerateOptions = { target?: GenerateTarget };

/** Pure. Returns UNFORMATTED files — callers pass the result through formatAll(). */
export function generate(spec: ConnectorSpec, options: GenerateOptions = {}): GeneratedFile[] {
  const target = options.target ?? "monorepo";
  validateSpec(spec);
  return [
    emitServer(spec, target),
    emitSandboxTest(),
    emitPackageJson(spec, target),
    emitManifest(spec),
    emitTsconfig(target),
    emitReadme(spec, target),
    // Standalone only: a monorepo connector inherits the workspace root's biome.json,
    // so emitting one there would both be dead weight and break the six-file byte-diff.
    ...(target === "standalone" ? [emitBiomeJson()] : []),
  ];
}
