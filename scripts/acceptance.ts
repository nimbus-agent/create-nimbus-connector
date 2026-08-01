import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFiles } from "../src/cli.ts";
import { generate } from "../src/emit/index.ts";
import {
  formatAll,
  formatterAvailable,
  formatterUnavailableReason,
  initFormatter,
} from "../src/format.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import { run } from "../src/golden/run.ts";
import { parseSpec } from "../src/spec.ts";
import { type Check, formatCheckLines } from "./_lib/checks.ts";

const NAME = "zzscratch";
const scriptDir = dirname(fileURLToPath(import.meta.url));

/**
 * Where the scratch connector is generated inside the monorepo.
 *
 * A function rather than a module-scope constant because the root is only known once argv
 * has been read, which now happens inside the entry point.
 */
export function scratchOutDir(root: string): string {
  return join(root, "packages", "mcp-connectors", NAME);
}

async function main(argv: readonly string[]): Promise<void> {
  const root = resolveNimbusRoot({
    flag: argv[0],
    env: process.env.NIMBUS_ROOT,
    scriptDir,
  });
  const outDir = scratchOutDir(root);

  const checks: Check[] = [];

  await initFormatter();
  if (!formatterAvailable()) {
    throw new Error(
      "@biomejs/biome is required here — byte-exactness is the point of this check, and " +
        "unformatted output would produce spurious diffs that look like emitter regressions. " +
        formatterUnavailableReason(),
    );
  }

  try {
    const spec = parseSpec(
      JSON.parse(await Bun.file(join(scriptDir, "..", "fixtures", `${NAME}.spec.json`)).text()),
    );
    await writeFiles(formatAll(generate(spec)), outDir);

    checks.push(
      { name: "tsc --noEmit", ...run(["bunx", "tsc", "--noEmit"], outDir) },
      {
        name: "biome check",
        ...run(["bunx", "biome", "check", `packages/mcp-connectors/${NAME}/src/`], root),
      },
      {
        name: "audit:package-readmes",
        ...run(["bun", "run", "audit:package-readmes"], root),
      },
    );
  } finally {
    // Runs even if generation threw or a check crashed. Never leave the monorepo dirty.
    await rm(outDir, { recursive: true, force: true });
  }

  const status = run(["git", "status", "--short", "packages/mcp-connectors/"], root);
  checks.push({
    name: "monorepo working tree clean",
    ok: status.output === "",
    output: status.output,
  });

  for (const line of formatCheckLines(checks)) console.log(line);

  if (checks.some((c) => !c.ok)) process.exit(1);
  console.log("\nAll acceptance checks passed.");
}

// Guarded exactly as src/cli.ts is. Every statement above used to run at module scope, so
// importing this file generated a connector into a monorepo the importer may not have,
// deleted a directory, and could call process.exit — which is why nothing here was testable.
// `bun scripts/acceptance.ts [nimbus-root]` is unchanged: argv is read here, at the entry
// point, rather than at import time.
if (import.meta.main) {
  await main(process.argv.slice(2));
}
