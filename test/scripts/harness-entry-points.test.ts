import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * `sonar-project.properties`'s `sonar.coverage.exclusions` list, graded against reality.
 *
 * The exclusion is legitimate — the harness entry points drive the AGPL monorepo through a
 * `--nimbus-root` and cannot run in CI, so Sonar reads "never executed" as "0% covered" — but
 * a hand-maintained list of excluded files is the exact shape this repository keeps removing:
 * it agrees with the codebase the day it is written and silently stops agreeing later. Left
 * ungraded it becomes a place to park anything inconvenient, which is how a coverage gate
 * quietly stops meaning anything.
 *
 * So the expected set is DERIVED: a script is a harness entry point when it resolves a Nimbus
 * root. Adding one and forgetting to exclude it fails here; excluding a script that does not
 * need a checkout fails here too, in the other direction.
 */

/** A script that resolves a Nimbus checkout, and therefore cannot run in CI. */
function needsNimbusRoot(name: string): boolean {
  const src = readFileSync(join(repoRoot, "scripts", name), "utf8");
  return src.includes("resolveNimbusRoot") || src.includes("--nimbus-root");
}

function harnessEntryPoints(): string[] {
  return readdirSync(join(repoRoot, "scripts"))
    .filter((f) => f.endsWith(".ts"))
    .filter(needsNimbusRoot)
    .map((f) => `scripts/${f}`)
    .sort();
}

function declaredExclusions(): string[] {
  const props = readFileSync(join(repoRoot, "sonar-project.properties"), "utf8");
  const line = props.split("\n").find((l) => l.startsWith("sonar.coverage.exclusions="));
  expect(line, "sonar.coverage.exclusions is not declared at all").toBeDefined();
  return (line ?? "")
    .slice("sonar.coverage.exclusions=".length)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .sort();
}

describe("the Sonar coverage exclusion list", () => {
  it("finds harness entry points at all, so the comparison is not vacuous", () => {
    // Both sides of the assertion below are read off disk, so a broken read would compare
    // [] against [] and pass. Six qualify today.
    expect(harnessEntryPoints().length).toBeGreaterThanOrEqual(6);
  });

  it("names exactly the scripts that cannot run without a Nimbus checkout", () => {
    expect(declaredExclusions()).toEqual(harnessEntryPoints());
  });

  it("excludes nothing under scripts/_lib/, which is where measurable logic belongs", () => {
    // The split this exclusion depends on. `_lib` holds every decidable rule and is fully
    // covered; the entry points hold argv plumbing and `process.exit` dispatch. Excluding a
    // `_lib` module would let real logic in through the gap the entry points opened.
    expect(declaredExclusions().filter((p) => p.includes("_lib"))).toEqual([]);
  });

  it("excludes no file that a test actually imports", () => {
    // The strongest form of the claim: if something imports it, it is measurable, and
    // excluding it discards real signal rather than recording a constraint.
    const testFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".test.ts")) testFiles.push(full);
      }
    };
    walk(join(repoRoot, "test"));
    const imported = new Set<string>();
    for (const file of testFiles) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/from "[^"]*scripts\/([a-z0-9-]+\.ts)"/g)) {
        imported.add(`scripts/${m[1] as string}`);
      }
    }
    expect(declaredExclusions().filter((p) => imported.has(p))).toEqual([]);
  });
});
