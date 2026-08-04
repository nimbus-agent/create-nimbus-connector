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
import { takeValue } from "../src/cli.ts";
import { formatterAvailable, formatterUnavailableReason, initFormatter } from "../src/format.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import { selectConnectors } from "./_lib/reach.ts";
import { assertComparable, buildBaseline, connectorsTreeRefusal } from "./_lib/reach-baseline.ts";
// measure, connectorDirs and git are imported rather than reimplemented: two copies of the
// measurement loop would let the baseline and the check that reads it disagree, which is the
// single failure this file must not have.
import { connectorDirs, git, measure } from "./reach.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(scriptDir, "..", "fixtures", "reach-baseline.json");

/**
 * This command always measures and records the FULL corpus — that is its entire point, and
 * `--baseline`/connector names on `bun run reach` exist precisely to compare a run against what
 * this one wrote. Reusing reach.ts's permissive `parseArgs` here (as this file used to) silently
 * dropped anything besides `--nimbus-root`: `bun run reach:baseline newrelic` or `bun run
 * reach:baseline --verbose` looked like they did something scoped and instead quietly rewrote
 * the whole baseline. There is no scoped-baseline format this command could honor, so an
 * unsupported flag or a positional name is refused rather than ignored.
 */
export function parseArgs(argv: readonly string[]): { nimbusRoot?: string } {
  let nimbusRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--nimbus-root") {
      nimbusRoot = takeValue(argv, ++i, "--nimbus-root");
    } else {
      throw new Error(
        `reach:baseline accepts only --nimbus-root; got "${a}". It always measures and records ` +
          "the full corpus — there is no flag to scope it to a subset of connectors. Use " +
          "`bun run reach --baseline` to compare an existing baseline against a subset instead.",
      );
    }
  }
  return { nimbusRoot };
}

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
  // A failed `git status` must not be read as "clean" — see scripts/reach.ts's identical fix
  // for why status.error, not just head.error, has to reach assertComparable.
  const refusal = assertComparable({
    commit: head.value,
    dirty: status.value !== "",
    gitError: head.error !== "" ? head.error : status.error,
  });
  if (refusal !== undefined) {
    console.log(refusal);
    process.exit(2);
  }

  // Keyed on the tree object of packages/mcp-connectors, not on HEAD — see reach-baseline.ts's
  // assertComparable docstring.
  const connectorsTree = git(root, ["rev-parse", "HEAD:packages/mcp-connectors"]);
  const treeRefusal = connectorsTreeRefusal(connectorsTree.error);
  if (treeRefusal !== undefined) {
    console.log(treeRefusal);
    process.exit(2);
  }
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
