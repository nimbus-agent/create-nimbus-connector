/**
 * The decision logic behind `bun run diff:golden`: which fixtures get compared, which
 * generated files count as byte-identical to the real connector, and what the verdict line
 * says.
 *
 * Lifted out of scripts/diff-golden.ts on the scripts/_lib/stdio-rpc.ts precedent, and for a
 * reason that is measured rather than stylistic. bunfig.toml enforces `coverageThreshold`
 * PER FILE, and Bun only puts a file in the coverage report once something imports it — so
 * the moment a test reached into diff-golden.ts the whole harness entered the report and had
 * to clear the 78% line floor. It cannot: `main()` needs a checkout of the Nimbus monorepo,
 * a separate AGPL-3.0-only repository CI does not have, which is why diff:golden is a script
 * you run before merging rather than a test. Measured at 73.60% lines with every helper
 * fully covered — a red `bun test --coverage` with zero failing tests.
 *
 * Splitting on that line is not a workaround, it is the same split the coverage floor is
 * describing: everything here is decided from its arguments and is tested; what stays in
 * diff-golden.ts is I/O against a checkout that only exists on a developer's machine.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { takeValue } from "../../src/cli.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll } from "../../src/format.ts";
import { type Comparison, classify, type Expectations } from "../../src/golden/expectations.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath, type GeneratedFile } from "../../src/types.ts";

const libDir = dirname(fileURLToPath(import.meta.url));
/** Same directory the harness used when these lived in scripts/diff-golden.ts. */
export const fixturesDir = join(libDir, "..", "..", "fixtures");
export const expectationsPath = join(fixturesDir, "expectations.json");

export function parseArgs(argv: readonly string[]): { names: string[]; nimbusRoot?: string } {
  const names: string[] = [];
  let nimbusRoot: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--nimbus-root") {
      nimbusRoot = takeValue(argv, ++i, "--nimbus-root");
    } else if (argv[i]?.startsWith("--")) {
      throw new Error(`Unknown flag: ${argv[i]}`);
    } else {
      names.push(argv[i]!);
    }
  }
  return { names, nimbusRoot };
}

export function unifiedDiff(expected: string, actual: string): string {
  const e = expected.split("\n");
  const a = actual.split("\n");
  const out: string[] = [];
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] !== a[i]) {
      if (e[i] !== undefined) out.push(`    - ${e[i]}`);
      if (a[i] !== undefined) out.push(`    + ${a[i]}`);
    }
  }
  return out.slice(0, 40).join("\n");
}

/** Parenthetical note appended after the identical-file count on a PASS line. */
export function passNote(expected: number, total: number, stubs: number): string {
  const parts: string[] = [];
  if (expected < total) parts.push("expected partial");
  if (stubs > 0) parts.push(`${stubs} stub tool(s)`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** Names the files that entered or left the identical set, so a FAIL is actionable. */
export function deltaNote(lost: readonly string[], gained: readonly string[]): string {
  const parts: string[] = [];
  if (lost.length > 0) parts.push(`no longer matching ${lost.join(", ")}`);
  if (gained.length > 0) parts.push(`newly matching ${gained.join(", ")}`);
  return parts.join("; ");
}

/**
 * The fixtures to compare, refusing both ways of ending up with none.
 *
 * An empty comparison set must never report success: that is the same silent-pass failure
 * mode this harness exists to prevent, just triggered by a hollow fixture list instead of a
 * missing monorepo.
 *
 * KNOWN DEAD BRANCH, left exactly as it shipped: the second throw cannot execute. When
 * `names` is non-empty `selected` IS `names`, so the early return always fires; reaching the
 * bottom implies `names.length === 0`, which the first throw already handles. A name that
 * matches nothing therefore falls through to readFixtureSpec, which reports it as a missing
 * spec file. Filtering `names` against `all` would make it reachable, but it would also
 * change what `diff:golden <typo>` does, so that is a maintainer's call rather than a
 * side effect of adding tests. See the test file for the pinned present-day behaviour.
 */
export function selectFixtures(names: readonly string[], all: readonly string[]): string[] {
  const selected = names.length > 0 ? names : all;
  if (selected.length > 0) return [...selected];
  if (names.length === 0) {
    throw new Error(
      `No fixtures found in ${fixturesDir} (expected files matching *.spec.json). ` +
        `Refusing to report a pass with nothing compared.`,
    );
  }
  throw new Error(
    `No fixture name(s) matched anything to run in ${fixturesDir}: ${names.join(", ")}`,
  );
}

/** Read and parse one fixture's spec, naming the fixture when the file is not there. */
export function readFixtureSpec(name: string, specPath: string): ReturnType<typeof parseSpec> {
  let specRaw: string;
  try {
    specRaw = readFileSync(specPath, "utf8");
  } catch {
    throw new Error(`No fixture named "${name}" — expected ${specPath}`);
  }
  return parseSpec(JSON.parse(specRaw));
}

/** Which generated files are byte-identical to the real connector, and what is wrong with the rest. */
export function diffAgainstReal(
  files: readonly GeneratedFile[],
  realDir: string,
): { identicalPaths: string[]; problems: string[] } {
  const identicalPaths: string[] = [];
  const problems: string[] = [];

  for (const f of files) {
    const rel = displayPath(f.path);
    let expectedContent: string;
    try {
      expectedContent = readFileSync(join(realDir, ...f.path), "utf8").replaceAll("\r\n", "\n");
    } catch {
      problems.push(`  MISSING  ${rel} — not present in the real connector`);
      continue;
    }
    if (expectedContent === f.content) {
      identicalPaths.push(rel);
    } else {
      problems.push(`  DIFF     ${rel}\n${unifiedDiff(expectedContent, f.content)}`);
    }
  }

  return { identicalPaths, problems };
}

/** The single console line for one fixture — PASS with its note, or FAIL with what moved. */
export function verdictLine(args: {
  name: string;
  identical: number;
  total: number;
  stubs: number;
  expectedCount: number;
  comparison: Comparison;
}): string {
  const { name, identical, total, stubs, expectedCount, comparison } = args;
  const head = `${name}  ${identical}/${total} files identical`;
  if (comparison.verdict === "pass") {
    return `PASS  ${head}${passNote(expectedCount, total, stubs)}`;
  }
  const stubNote = stubs > 0 ? `, ${stubs} stub tool(s)` : "";
  const advice =
    comparison.verdict === "regressed"
      ? ""
      : "; update fixtures/expectations.json and the gap it closes under " +
        "Known limitations in docs/ROADMAP.md";
  return (
    `FAIL  ${head}${stubNote} — ` +
    `${comparison.verdict}: ${deltaNote(comparison.lost, comparison.gained)}${advice}`
  );
}

/**
 * Generate one fixture, compare it to the real connector, and report the outcome.
 *
 * Does I/O, but it is the seam where the pure pieces above are composed and it is
 * deterministic given its three arguments: point `root` at a directory with no connector in
 * it and every file comes back MISSING, which is a real, assertable outcome rather than a
 * stand-in. Call `initFormatter()` first — `formatAll` needs it.
 */
export function compareFixture(
  name: string,
  root: string,
  expectations: Expectations,
): { failed: boolean; line: string; problems: string[] } {
  const specPath = join(fixturesDir, `${name}.spec.json`);
  const spec = readFixtureSpec(name, specPath);
  const files: GeneratedFile[] = formatAll(generate(spec));
  const realDir = join(root, "packages", "mcp-connectors", name);
  const stubs = spec.tools.filter((t) => t.impl === "stub").length;

  const { identicalPaths, problems } = diffAgainstReal(files, realDir);

  const expectedPaths = expectations[name];
  if (expectedPaths === undefined) {
    throw new Error(
      `No expectation declared for fixture "${name}" in ${expectationsPath}. ` +
        `Add an entry listing the file paths that are currently byte-identical (out of ` +
        `${files.length}) before running the harness — an undeclared fixture must not be able ` +
        "to pass by accident.",
    );
  }

  const comparison = classify(identicalPaths, expectedPaths);
  return {
    failed: comparison.verdict !== "pass",
    line: verdictLine({
      name,
      identical: identicalPaths.length,
      total: files.length,
      stubs,
      expectedCount: expectedPaths.length,
      comparison,
    }),
    problems,
  };
}
