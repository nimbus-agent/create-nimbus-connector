import { defaultLicenseFor } from "../license.ts";
import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";
import { BIOME_VERSION } from "./biome-json.ts";
import type { GenerateTarget } from "./index.ts";

/**
 * `license` defaults to the target's own default — AGPL-3.0-only for monorepo (fixed, the
 * package sits inside an AGPL repo and is byte-locked against 94 real connectors),
 * UNLICENSED for standalone. Only generate() may override it, and only for standalone;
 * that invariant is enforced there.
 */
export function emitPackageJson(
  spec: ConnectorSpec,
  target: GenerateTarget,
  license: string = defaultLicenseFor(target),
): GeneratedFile {
  const standalone = target === "standalone";
  // search-filter and matchesResult land in connector-kit in SDK 1.15.0 — the next minor
  // after 1.14.0, which is what main carries today. The Stage D plan predicted 1.12.0 and
  // was overtaken: 1.12.0, 1.13.0 and 1.14.0 all shipped while this stage was being built
  // and none of them carries search-filter.ts, so ^1.12.0 would resolve 1.14.x and the
  // emitted `import { matchesResult } from "@nimbus-dev/sdk/connector-kit"` would not
  // resolve. Only a spec that names those symbols needs the floor; raising it for everyone
  // would strand users on a version they have no reason to need.
  const standaloneSdkRange = spec.tools.some((t) => t.impl === "search") ? "^1.15.0" : "^1.11.0";
  const pkg = {
    name: `nimbus-mcp-${spec.name}`,
    version: "0.1.0",
    private: false,
    license,
    type: "module",
    scripts: {
      ...(standalone ? { dev: "bun run --watch src/server.ts" } : {}),
      ...(standalone ? { build: "bun build src/server.ts --outdir dist --target bun" } : {}),
      typecheck: "tsc --noEmit",
      lint: "biome check src/",
      test: "bun test",
      clean: "rm -rf dist",
    },
    dependencies: {
      "@modelcontextprotocol/sdk": "1.30.0",
      "@nimbus-dev/sdk": standalone ? standaloneSdkRange : "^1.8.1",
      zod: "^4.4.2",
    },
    // A monorepo connector gets biome and tsc from the workspace root's node_modules/.bin.
    // A standalone package has no root: without these two, `bun run lint` and
    // `bun run typecheck` fail with "command not found" on a clean registry install.
    devDependencies: {
      ...(standalone ? { "@biomejs/biome": `^${BIOME_VERSION}` } : {}),
      "@types/bun": "latest",
      ...(standalone ? { typescript: "^5.6.0" } : {}),
    },
  };
  return { path: ["package.json"], content: `${JSON.stringify(pkg, undefined, 2)}\n` };
}
