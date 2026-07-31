import { FORMATTER_CONFIG } from "../format.ts";
import type { GeneratedFile } from "../types.ts";

/**
 * The Biome release a generated standalone package pins. Shared with
 * src/emit/package-json.ts so the emitted `$schema` URL and the emitted
 * `@biomejs/biome` devDependency range cannot drift apart.
 */
export const BIOME_VERSION = "2.5.6";

/**
 * Standalone target only. A monorepo-target connector inherits the workspace root's
 * biome.json; a standalone package has no root, so without this file `biome check src/`
 * falls back to Biome's tab-indent defaults and reports a whole-file format diff against
 * the two-space output the generator just produced.
 *
 * The `formatter` and `javascript.formatter` blocks mirror the configuration applied in
 * src/format.ts exactly — the settings the generator itself formats with — so a freshly
 * generated package passes its own `lint` script with no edits.
 */
export function emitBiomeJson(): GeneratedFile {
  const cfg = {
    $schema: `https://biomejs.dev/schemas/${BIOME_VERSION}/schema.json`,
    formatter: FORMATTER_CONFIG.formatter,
    // Biome's own default, restated so the emitted `lint` script is a real lint gate and
    // its behaviour is visible in the generated file rather than implied by omission.
    //
    // noUnusedVariables IS in the recommended preset, but at severity "warn" — `biome check`
    // prints it and exits 0. An unused emitted local therefore already fails the generated
    // package's `typecheck` (its tsconfig sets noUnusedLocals) while silently passing its
    // `lint`. Raising it to "error" makes the two gates agree, and matches the Nimbus
    // monorepo root, which sets this same rule to "error" for connectors it hosts.
    linter: {
      enabled: true,
      rules: { recommended: true, correctness: { noUnusedVariables: "error" } },
    },
    javascript: FORMATTER_CONFIG.javascript,
  };
  return { path: ["biome.json"], content: `${JSON.stringify(cfg, undefined, 2)}\n` };
}
