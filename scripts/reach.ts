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

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "../src/emit/index.ts";
import {
  biomeVersion,
  formatAll,
  formatterAvailable,
  formatterUnavailableReason,
  initFormatter,
} from "../src/format.ts";
import { checkBiomeVersion } from "../src/golden/biome-version.ts";
import { resolveNimbusRoot } from "../src/golden/resolve.ts";
import { parseSpec } from "../src/spec.ts";
import { validateSpec } from "../src/validate.ts";
import { deriveSpec } from "./_lib/derive/index.ts";
import {
  type ConnectorResult,
  histogram,
  selectConnectors,
  summaryLines,
  tierFor,
} from "./_lib/reach.ts";
import { assertComparable, compareBaseline } from "./_lib/reach-baseline.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(scriptDir, "..", "fixtures", "reach-baseline.json");

export function parseArgs(argv: readonly string[]): {
  names: string[];
  nimbusRoot?: string;
  baseline: boolean;
  verbose: boolean;
} {
  const names: string[] = [];
  let nimbusRoot: string | undefined;
  let baseline = false;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--nimbus-root") nimbusRoot = argv[++i];
    else if (a === "--baseline") baseline = true;
    else if (a === "--verbose") verbose = true;
    else if (a?.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
    else if (a !== undefined) names.push(a);
  }
  return { names, nimbusRoot, baseline, verbose };
}

/** Exported for scripts/reach-baseline.ts, so the two commands cannot measure differently. */
export function connectorDirs(root: string): string[] {
  const dir = join(root, "packages", "mcp-connectors");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "shared")
    .map((e) => e.name)
    .sort();
}

/**
 * Reads the real connector, normalising line endings on THAT side only — the same asymmetry
 * scripts/_lib/golden-diff.ts's diffAgainstReal uses, and for the same reason: normalise what
 * this repository does not control, compare verbatim what it produces. Normalising the
 * generated side too would mask a CRLF leak from the emitter rather than surface it.
 *
 * Safe because .gitattributes pins `* text=auto eol=lf`, so the working tree is LF even under
 * core.autocrlf=true. Verified on Windows: all six emitted files are LF-only, including
 * README.md, which formatAll does not touch.
 *
 * Every one of the 94 connectors carries a `node_modules/` from `bun install`, not from git —
 * it is not part of the connector's authored source, and it is where this walk must not go:
 * on Windows the workspace-package entries under it are junctions, and Bun's `Dirent.isDirectory()`
 * reports the link itself rather than its target, so treating one as a file and reading it
 * throws EISDIR. Skipped by name rather than by resolving link targets, since no real connector
 * has ever had reason to name a source directory `node_modules`.
 */
function readReal(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (sub: string): void => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const rel = sub === "" ? entry.name : `${sub}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else out.set(rel, readFileSync(join(dir, rel), "utf8").replaceAll("\r\n", "\n"));
    }
  };
  walk("");
  return out;
}

/**
 * Runs git, reporting *why* it produced nothing.
 *
 * `error` is what separates "git is not installed" from "this directory is not a checkout".
 * Collapsing both to an empty string sends a developer whose PATH is missing git off to check
 * their --nimbus-root, which is the wrong problem and the wrong fix.
 */
export function git(root: string, args: string[]): { value: string; error: string } {
  try {
    return {
      value: execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim(),
      error: "",
    };
  } catch (err) {
    return { value: "", error: err instanceof Error ? err.message : String(err) };
  }
}

/** Exported for scripts/reach-baseline.ts. One measurement loop, two commands. */
export function measure(name: string, root: string): ConnectorResult {
  const dir = join(root, "packages", "mcp-connectors", name);
  const real = readReal(dir);
  const server = real.get("src/server.ts");
  const manifest = real.get("nimbus.extension.json");
  if (server === undefined || manifest === undefined) {
    return {
      name,
      tier: "blocked",
      blockers: [
        { kind: server === undefined ? "no-server" : "no-manifest", detail: dir, line: 0 },
      ],
    };
  }

  const derivation = deriveSpec({ server, manifest });
  if (!derivation.ok) return { name, tier: "blocked", blockers: derivation.blockers };

  // parseSpec and validateSpec ARE the `emits` tier boundary: a derived spec that trips
  // RESERVED_IDENTIFIERS is genuinely not generatable today, and counting it is the point.
  try {
    const spec = parseSpec(derivation.spec);
    validateSpec(spec);
    const generated = formatAll(generate(spec));
    return { name, tier: tierFor({ derivation, generated, real }), blockers: [] };
  } catch (err) {
    return {
      name,
      tier: "blocked",
      blockers: [
        {
          kind: "rejected-by-validate",
          detail: err instanceof Error ? err.message : String(err),
          line: 0,
        },
      ],
    };
  }
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
  const refusal = assertComparable({
    commit: head.value,
    dirty: status.value !== "",
    gitError: head.error,
  });
  if (refusal !== undefined) {
    console.log(`\n${refusal}`);
    process.exit(2);
  }

  const stored = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Parameters<
    typeof compareBaseline
  >[0];
  const { refusal: mismatch, regressions } = compareBaseline(stored, results, head.value);
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
