/**
 * Rewrites fixtures/reach-baseline.json from a fresh measurement.
 *
 * Separate from scripts/reach.ts on the scripts/snapshot-update.ts precedent: the thing that
 * rewrites recorded expectations is its own command, so it cannot be reached by adding a flag to
 * the command that checks them.
 */

import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import { selectConnectors } from "./_lib/reach.ts";
import {
  BASELINE_PATH,
  buildBaseline,
  parseArgs,
  requireDeriveToolchain,
  resolveComparableTree,
} from "./_lib/reach-baseline.ts";
// measure, connectorDirs and git are imported rather than reimplemented: two copies of the
// measurement loop would let the baseline and the check that reads it disagree, which is the
// single failure this file must not have.
import { connectorDirs, git, measure } from "./reach.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));

async function main(argv: readonly string[]): Promise<void> {
  await requireDeriveToolchain();

  const { nimbusRoot } = parseArgs(argv);
  const root = resolveNimbusRoot({ flag: nimbusRoot, env: process.env["NIMBUS_ROOT"], scriptDir });

  const comparable = resolveComparableTree(root, git);
  if ("refusal" in comparable) {
    console.log(comparable.refusal);
    process.exit(2);
  }
  const { connectorsTree, head } = comparable;

  const results = selectConnectors([], connectorDirs(root)).map((name) => measure(name, root));
  const baseline = buildBaseline(connectorsTree, results);
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, undefined, 2)}\n`);

  console.log(`Wrote ${BASELINE_PATH}`);
  console.log(`  measured at Nimbus HEAD ${head}`);
  console.log(`  connectorsTree ${connectorsTree}`);
  console.log(`  ${results.length} connectors recorded`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
