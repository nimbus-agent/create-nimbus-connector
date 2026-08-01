/**
 * Coverage guard — the gate is two files agreeing, and neither says so on its own.
 *
 * `bunfig.toml` declares a per-file `coverageThreshold`, but Bun only evaluates it when the
 * run is invoked with `--coverage`. So CI running plain `bun test` would keep passing with
 * the thresholds present and never checked: the config would look like a gate, the workflow
 * would look like it ran one, and nothing would be enforced. That is the exact false-green
 * shape this repo has removed several times, so it is asserted rather than trusted.
 *
 * `coveragePathIgnorePatterns` is asserted for the opposite reason. It is the one exclusion
 * in bunfig.toml, and exclusions are how coverage numbers get faked. Pinning its contents
 * means adding a file to it is a visible, reviewed change to a test, not a quiet edit to a
 * config nobody re-reads.
 *
 * `Bun.YAML.parse` rather than a `yaml` dependency, and `Bun.TOML.parse` for bunfig, for the
 * same reason test/release-workflow-guard.test.ts gives: this project is Bun-only.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

type Step = { name?: string; run?: string };
type Workflow = { jobs: Record<string, { steps: Step[] }> };

const ci = Bun.YAML.parse(read(".github/workflows/ci.yml")) as Workflow;
const bunfig = Bun.TOML.parse(read("bunfig.toml")) as {
  test?: {
    coverageThreshold?: { lines?: number; functions?: number };
    coveragePathIgnorePatterns?: string[];
    coverageSkipTestFiles?: boolean;
  };
};

const ciSteps = Object.values(ci.jobs).flatMap((j) => j.steps);
const runLines = ciSteps.flatMap((s) => (s.run === undefined ? [] : [s.run]));

describe("coverage gate", () => {
  it("CI invokes bun test with --coverage, or the thresholds are never evaluated", () => {
    const testRuns = runLines.filter((r) => /\bbun test\b/.test(r));
    expect(testRuns.length).toBeGreaterThan(0);
    // Every `bun test` in CI must carry the flag. A second, uncovered invocation would
    // pass while contributing nothing, which is how the gate would come back false-green.
    for (const r of testRuns) {
      expect(r).toMatch(/\bbun test\b[^\n]*--coverage\b/);
    }
  });

  it("bunfig declares thresholds for both lines and functions", () => {
    const t = bunfig.test?.coverageThreshold;
    expect(t?.lines).toBeGreaterThan(0);
    expect(t?.functions).toBeGreaterThan(0);
  });

  it("counts the code under test, not the tests", () => {
    // Without this, every *.test.ts scores ~100% by construction and inflates the number
    // the threshold is compared against.
    expect(bunfig.test?.coverageSkipTestFiles).toBe(true);
  });

  it("excludes exactly the two files Bun structurally cannot instrument", () => {
    // src/cli.ts and src/prompts.ts are driven through Bun.spawnSync on the real binary.
    // Child-process execution is invisible to coverage, so leaving them in would drag the
    // per-file floor from 78% to 42.76% and make the threshold vacuous everywhere else.
    // Anything else appearing here is a coverage number being managed rather than earned.
    expect(bunfig.test?.coveragePathIgnorePatterns).toEqual(["src/cli.ts", "src/prompts.ts"]);
  });
});
