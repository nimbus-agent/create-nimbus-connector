/**
 * Byte-diffs every generated fixture against the real connector in the Nimbus monorepo.
 *
 * What remains here is the part that cannot run without that checkout: argument resolution,
 * the Biome-version banner, and the per-fixture loop. Everything that decides PASS or FAIL
 * lives in scripts/_lib/golden-diff.ts, where it is unit-tested — see that file's header for
 * why the split falls exactly there.
 */

import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  biomeVersion,
  formatterAvailable,
  formatterUnavailableReason,
  initFormatter,
} from "../src/format.ts";
import { checkBiomeVersion } from "../src/golden/biome-version.ts";
import { loadExpectations } from "../src/golden/expectations.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import {
  compareFixture,
  expectationsPath,
  fixturesDir,
  parseArgs,
  selectFixtures,
} from "./_lib/golden-diff.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));

async function main(argv: readonly string[]): Promise<void> {
  await initFormatter();
  if (!formatterAvailable()) {
    throw new Error(
      "@biomejs/biome is required here — byte-exactness is the point of this check, and " +
        "unformatted output would produce spurious diffs that look like emitter regressions. " +
        formatterUnavailableReason(),
    );
  }

  const { names, nimbusRoot } = parseArgs(argv);
  const root = resolveNimbusRoot({
    flag: nimbusRoot,
    env: process.env["NIMBUS_ROOT"],
    scriptDir,
  });
  const expectations = loadExpectations(expectationsPath);

  const all = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".spec.json"))
    .map((f) => f.replace(/\.spec\.json$/, ""));
  const selected = selectFixtures(names, all);

  const resolvedBiomeVersion = biomeVersion();
  console.log(`Nimbus root: ${root}`);
  console.log(`Biome:       ${resolvedBiomeVersion}`);
  const versionWarning = checkBiomeVersion(root, resolvedBiomeVersion);
  if (versionWarning !== undefined) console.log(versionWarning);
  console.log();

  let failures = 0;

  for (const name of selected) {
    const { failed, line, problems } = compareFixture(name, root, expectations);
    if (failed) failures++;
    console.log(line);
    for (const p of problems) console.log(p);
  }

  if (failures > 0) {
    console.log(`\n${failures} fixture(s) deviate from their declared expectations.`);
    process.exit(1);
  }
  console.log("\nAll fixtures match their declared expectations.");
}

// Guarded exactly as src/cli.ts is, so importing this module cannot run the harness. Before
// the guard, importing it generated every fixture, required a Nimbus checkout, and could
// call process.exit. Running it as a program (`bun scripts/diff-golden.ts`) is unchanged:
// import.meta.main is true for the entry point.
if (import.meta.main) {
  await main(process.argv.slice(2));
}
