/**
 * Rewrites fixtures/reach-baseline.json from a fresh measurement.
 *
 * Separate from scripts/reach.ts on the scripts/snapshot-update.ts precedent: the thing that
 * rewrites recorded expectations is its own command, so it cannot be reached by adding a flag to
 * the command that checks them.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatterAvailable, formatterUnavailableReason, initFormatter } from "../src/format.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import { selectConnectors } from "./_lib/reach.ts";
import { assertComparable, buildBaseline } from "./_lib/reach-baseline.ts";
// measure, connectorDirs, git and parseArgs are imported rather than reimplemented: two copies
// of the measurement loop would let the baseline and the check that reads it disagree, which is
// the single failure this file must not have.
import { connectorDirs, git, measure, parseArgs } from "./reach.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(scriptDir, "..", "fixtures", "reach-baseline.json");

async function main(argv: readonly string[]): Promise<void> {
  await initFormatter();
  if (!formatterAvailable()) {
    throw new Error(
      "@biomejs/biome is required here — this harness byte-compares, and unformatted output " +
        `would produce spurious diffs that read as reach regressions. ${formatterUnavailableReason()}`,
    );
  }

  const { nimbusRoot } = parseArgs(argv);
  const root = resolveNimbusRoot({ flag: nimbusRoot, env: process.env["NIMBUS_ROOT"], scriptDir });

  const head = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--porcelain", "--", "packages/mcp-connectors"]);
  const refusal = assertComparable({
    commit: head.value,
    dirty: status.value !== "",
    gitError: head.error,
  });
  if (refusal !== undefined) {
    console.log(refusal);
    process.exit(2);
  }

  // Keyed on the tree object of packages/mcp-connectors, not on HEAD — see reach-baseline.ts's
  // assertComparable docstring.
  const connectorsTree = git(root, ["rev-parse", "HEAD:packages/mcp-connectors"]);
  const results = selectConnectors([], connectorDirs(root)).map((name) => measure(name, root));
  const baseline = buildBaseline(connectorsTree.value, results);
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, undefined, 2)}\n`);

  console.log(`Wrote ${BASELINE_PATH}`);
  console.log(`  measured at Nimbus HEAD ${head.value}`);
  console.log(`  connectorsTree ${connectorsTree.value}`);
  console.log(`  ${results.length} connectors recorded`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
