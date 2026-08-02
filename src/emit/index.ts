import { DEFAULT_STANDALONE_LICENSE, MONOREPO_LICENSE } from "../license.ts";
import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";
import { validateSpec } from "../validate.ts";
import { emitBiomeJson } from "./biome-json.ts";
import { emitManifest } from "./manifest.ts";
import { emitPackageJson } from "./package-json.ts";
import { emitReadme } from "./readme.ts";
import { emitSandboxTest } from "./sandbox-test.ts";
import { emitSearchFilter } from "./search-filter.ts";
import { emitServer } from "./server/index.ts";
import { emitTsconfig } from "./tsconfig.ts";

export type GenerateTarget = "monorepo" | "standalone";
export type GenerateOptions = {
  target?: GenerateTarget;
  /** Standalone only. Omitted means DEFAULT_STANDALONE_LICENSE. Never valid for monorepo. */
  license?: string;
};

/** Pure. Returns UNFORMATTED files — callers pass the result through formatAll(). */
export function generate(spec: ConnectorSpec, options: GenerateOptions = {}): GeneratedFile[] {
  const target = options.target ?? "monorepo";

  // Fail loudly rather than silently dropping the value. A monorepo connector's license is
  // not a choice: the package lives inside the AGPL Nimbus repo, imports AGPL code through
  // ../../shared/*, and its package.json is byte-diffed against 94 real connectors.
  if (options.license !== undefined && target !== "standalone") {
    throw new Error(
      "license is only configurable for the standalone target; a monorepo-target connector " +
        `is ${MONOREPO_LICENSE} unconditionally.`,
    );
  }
  const license =
    target === "standalone" ? (options.license ?? DEFAULT_STANDALONE_LICENSE) : MONOREPO_LICENSE;

  validateSpec(spec);
  return [
    emitServer(spec, target),
    // Seventh file, emitted only for a spec with a search tool — a read-only spec never
    // reaches this branch, which is what keeps the six-file fixtures byte-safe.
    ...((): GeneratedFile[] => {
      const f = emitSearchFilter(spec, target);
      return f === undefined ? [] : [f];
    })(),
    emitSandboxTest(),
    emitPackageJson(spec, target, license),
    emitManifest(spec),
    emitTsconfig(target),
    emitReadme(spec, target, license),
    // Standalone only: a monorepo connector inherits the workspace root's biome.json,
    // so emitting one there would both be dead weight and break the six-file byte-diff.
    ...(target === "standalone" ? [emitBiomeJson()] : []),
  ];
}
