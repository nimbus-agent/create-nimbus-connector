import { defaultLicenseFor } from "../license.ts";
import type { ConnectorSpec } from "../spec.ts";
import type { GeneratedFile } from "../types.ts";
import { BIOME_VERSION } from "./biome-json.ts";
import type { GenerateTarget } from "./index.ts";

/**
 * The monorepo target's runtime dependencies are not this generator's choice. package.json is
 * one of the files diff:golden byte-matches against the real connectors — newrelic, datadog,
 * grafana and sentry match all six — so these are the ranges that corpus declares. They move
 * when the corpus moves, never ahead of it: a newer release here drops package.json from those
 * four fixtures' match, which is the byte-safety invariant breaking, not a dependency update.
 */
const MONOREPO_DEPENDENCIES = {
  "@modelcontextprotocol/sdk": "1.30.0",
  "@nimbus-dev/sdk": "^1.8.1",
  zod: "^4.4.2",
};

/**
 * A standalone package matches no corpus, so its ranges ARE this generator's choice, and they
 * follow the latest release. They used to share the monorepo literals above, which held every
 * new standalone package on whatever the corpus pinned; splitting them is what lets one side
 * move without the other. The MCP SDK keeps the corpus's exact-pin style, so a generated
 * package installs the release `standalone-acceptance --registry` drove it against rather than
 * whichever 1.x is newest on the day.
 *
 * `@nimbus-dev/sdk` is the first release of the SDK's current major. An emitted package imports
 * two SDK modules, connector-kit (src/server.ts) and testing (test/sandbox.test.ts), and neither
 * changed between 1.34.0 — the newest release the old `^1.11.0` could resolve — and 2.0.0,
 * whose one breaking change is in the agents module. A caret range never crosses a major, so
 * that floor kept every new package on 1.x after 2.0.0 shipped. It used to be raised only for a
 * spec with a search tool, to `^1.15.0`, where search-filter and matchesResult arrived; 2.0.0
 * carries the search kit, so one floor now serves both. If an emitted import ever needs a
 * symbol newer than this floor, raise it for the specs that name that symbol, as the search
 * floor once was — not for everyone.
 */
const STANDALONE_DEPENDENCIES = {
  "@modelcontextprotocol/sdk": "1.32.0",
  "@nimbus-dev/sdk": "^2.0.0",
  zod: "^4.6.5",
};

/**
 * The compiler a standalone package's own `bun run typecheck` resolves: the range this
 * repository's own `typescript` devDependency declares, which test/emit/static.test.ts holds it
 * to exactly as it holds BIOME_VERSION to the Biome pin. TypeScript 7 removed only options the
 * emitted tsconfig never sets (an es5 target, node10/classic resolution, baseUrl,
 * amd/umd/system modules, interop flags set to false), and `standalone-acceptance --registry` is
 * what proves an emitted package still typechecks under it: no `bun test` compiles a standalone
 * `server.ts`.
 */
const STANDALONE_TYPESCRIPT_RANGE = "^7.0.2";

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
    dependencies: standalone ? STANDALONE_DEPENDENCIES : MONOREPO_DEPENDENCIES,
    // A monorepo connector gets biome and tsc from the workspace root's node_modules/.bin.
    // A standalone package has no root: without these two, `bun run lint` and
    // `bun run typecheck` fail with "command not found" on a clean registry install.
    devDependencies: {
      ...(standalone ? { "@biomejs/biome": `^${BIOME_VERSION}` } : {}),
      "@types/bun": "latest",
      ...(standalone ? { typescript: STANDALONE_TYPESCRIPT_RANGE } : {}),
    },
  };
  return { path: ["package.json"], content: `${JSON.stringify(pkg, undefined, 2)}\n` };
}
