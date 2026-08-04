/**
 * Measures how much of the Nimbus connector corpus this generator can regenerate.
 *
 * Reads the monorepo at runtime from a path, exactly as scripts/diff-golden.ts does, and for the
 * same reason: that repository is AGPL-3.0-only and this one is MIT, so it is never vendored.
 * Consequently this CANNOT run in CI. Do not add a job that skips when the root is absent — a
 * silently-skipping gate is the failure mode this repo keeps removing.
 *
 * No derived spec is ever written to disk. The output is a number and a histogram.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  biomeVersion,
  formatterAvailable,
  formatterUnavailableReason,
  initFormatter,
} from "../src/format.ts";
import { checkBiomeVersion } from "../src/golden/biome-version.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import {
  type ConnectorResult,
  histogram,
  measure as measureFiles,
  parseArgs,
  selectConnectors,
  summaryLines,
  walkConnector,
} from "./_lib/reach.ts";
import {
  assertComparable,
  baselineScopeRefusal,
  compareBaseline,
  connectorsTreeRefusal,
} from "./_lib/reach-baseline.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(scriptDir, "..", "fixtures", "reach-baseline.json");

/**
 * Deliberately NOT `localeCompare`, which is what SonarCloud's S2871 message suggests.
 * `src/golden/expectations.ts` already rejected it for this codebase and says why: it is
 * locale- and ICU-dependent, so it can order the same two names differently on two machines.
 * Only display order is at stake here, and a comparator that varies by runner is the property
 * to avoid. Code-unit order is what the default `.sort()` already did — this makes it explicit.
 */
const byCodeUnit = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/** Exported for scripts/reach-baseline.ts, so the two commands cannot measure differently. */
export function connectorDirs(root: string): string[] {
  const dir = join(root, "packages", "mcp-connectors");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "shared")
    .map((e) => e.name)
    .sort(byCodeUnit);
}

/**
 * Runs git, reporting *why* it produced nothing.
 *
 * `error` is what separates "git is not installed" from "this directory is not a checkout".
 * Collapsing both to an empty string sends a developer whose PATH is missing git off to check
 * their --nimbus-root, which is the wrong problem and the wrong fix.
 *
 * `Bun.spawnSync` rather than node:child_process's execFileSync, matching how every other
 * script in this repo shells out (src/golden/run.ts, scripts/runtime-acceptance.ts): this is
 * a Bun-only project, so reaching for the node compatibility layer here bought nothing.
 */
export function git(root: string, args: string[]): { value: string; error: string } {
  try {
    const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) {
      const stderr = r.stderr.toString().trim();
      return { value: "", error: stderr === "" ? `git exited ${String(r.exitCode)}` : stderr };
    }
    return { value: r.stdout.toString().trim(), error: "" };
  } catch (err) {
    // Bun throws rather than returning a non-zero exit code when the binary is absent, which
    // is the "git is not installed" case assertComparable reports differently.
    return { value: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Exported for scripts/reach-baseline.ts. One measurement loop, two commands — the same reason
 * the module-level comment on that file's import gives: two copies would let the baseline and
 * the check that reads it disagree.
 *
 * The read (walkConnector) is wrapped here, not left to throw: the design states "One malformed
 * connector must never abort a 94-connector run," and an unwrapped call took the whole sweep
 * down on a single dangling symlink or permissions error before this wrap existed. Everything
 * after a successful read is decidable from (name, files) alone and lives in _lib/reach.ts's
 * measure(), which is what makes it unit-testable without a Nimbus checkout.
 */
export function measure(name: string, root: string): ConnectorResult {
  const dir = join(root, "packages", "mcp-connectors", name);
  let files: ReadonlyMap<string, string>;
  try {
    files = walkConnector(dir);
  } catch (err) {
    return {
      name,
      tier: "blocked",
      blockers: [
        { kind: "read-error", detail: err instanceof Error ? err.message : String(err), line: 0 },
      ],
    };
  }
  return measureFiles(name, files);
}

async function main(argv: readonly string[]): Promise<void> {
  await initFormatter();
  if (!formatterAvailable()) {
    throw new Error(
      "@biomejs/biome is required here — this harness byte-compares, and unformatted output " +
        `would produce spurious diffs that read as reach regressions. ${formatterUnavailableReason()}`,
    );
  }

  const { names, nimbusRoot, baseline, verbose } = parseArgs(argv);

  const scopeRefusal = baselineScopeRefusal(names, baseline);
  if (scopeRefusal !== undefined) {
    console.log(`\n${scopeRefusal}`);
    process.exit(2);
  }

  const root = resolveNimbusRoot({ flag: nimbusRoot, env: process.env["NIMBUS_ROOT"], scriptDir });

  const selected = selectConnectors(names, connectorDirs(root));

  const resolvedBiome = biomeVersion();
  console.log(`Nimbus root: ${root}   (${selected.length} connectors)`);
  console.log(`Biome:       ${resolvedBiome}`);
  const warning = checkBiomeVersion(root, resolvedBiome);
  if (warning !== undefined) console.log(warning);
  console.log();

  const results = selected.map((name) => measure(name, root));

  for (const line of summaryLines(results)) console.log(line);
  console.log("\nBlocked by, most common first:");
  for (const bucket of histogram(results)) {
    console.log(`  ${String(bucket.count).padStart(3)}  ${bucket.kind}`);
    if (verbose) console.log(`       ${bucket.examples.join(", ")}`);
  }
  console.log("\n(no derived spec written)");

  if (verbose || names.length > 0) {
    console.log();
    for (const r of results) console.log(`  ${r.tier.padEnd(18)} ${r.name}`);
  }

  if (!baseline) return;

  const head = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--porcelain", "--", "packages/mcp-connectors"]);
  // A failed `git status` must not be read as "clean": status.value === "" either way, so
  // status.error (not just head.error) has to reach assertComparable or a non-zero exit here
  // makes the dirty gate silently disappear.
  const refusal = assertComparable({
    commit: head.value,
    dirty: status.value !== "",
    gitError: head.error !== "" ? head.error : status.error,
  });
  if (refusal !== undefined) {
    console.log(`\n${refusal}`);
    process.exit(2);
  }

  // Keyed on the tree object of packages/mcp-connectors — the only path this harness reads —
  // not on HEAD: see reach-baseline.ts's assertComparable docstring for why a commit SHA is the
  // wrong key.
  const connectorsTree = git(root, ["rev-parse", "HEAD:packages/mcp-connectors"]);
  const treeRefusal = connectorsTreeRefusal(connectorsTree.error);
  if (treeRefusal !== undefined) {
    console.log(`\n${treeRefusal}`);
    process.exit(2);
  }
  const stored = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Parameters<
    typeof compareBaseline
  >[0];
  const { refusal: mismatch, regressions } = compareBaseline(stored, results, connectorsTree.value);
  if (mismatch !== undefined) {
    console.log(`\n${mismatch}`);
    process.exit(2);
  }
  for (const r of regressions) console.log(`\nREGRESSED  ${r.name}   ${r.from} -> ${r.to}`);
  if (regressions.length > 0) {
    console.log(
      `\n${regressions.length} connector(s) lost a tier. If the corpus moved, re-baseline; ` +
        "do not edit fixtures/reach-baseline.json to make this pass.",
    );
    process.exit(1);
  }
  console.log("\nNo connector lost a tier.");
}

// Guarded exactly as scripts/diff-golden.ts is, so importing this module cannot run the harness.
if (import.meta.main) {
  await main(process.argv.slice(2));
}
