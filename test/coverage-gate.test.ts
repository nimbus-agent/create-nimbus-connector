/**
 * Coverage guard — the gate is two files agreeing, and neither says so on its own.
 *
 * `bunfig.toml` declares a per-file `coverageThreshold`, but Bun only evaluates it when the
 * run is invoked with `--coverage`. So a workflow running plain `bun test` keeps passing with
 * the thresholds present and never checked: the config looks like a gate, the workflow looks
 * like it ran one, and nothing is enforced. That is the exact false-green shape this repo has
 * removed several times, so it is asserted rather than trusted.
 *
 * The rule below reads the workflow DIRECTORY, and that widening is the point of this file's
 * own history. Its first version stated the rule as "every `bun test` in CI must carry the
 * flag" and then parsed `ci.yml` alone — the one workflow that already obeyed it. `release.yml`
 * ran a bare `bun test` for as long as the guard existed, so the suite that decides whether an
 * unpublishable version ships was the single invocation the coverage floor never graded. A
 * guard that reads only the file it agrees with is not a guard. Reading the directory also
 * means a workflow added later inherits the rule, the same reasoning
 * test/release-workflow-guard.test.ts gives for its own directory sweep.
 *
 * Workflows that never run the suite need no exemption and get none: acceptance.yml runs the
 * two harnesses, and cla.yml, codeql.yml, dependency-review.yml and dependabot-auto-merge.yml
 * run no Bun at all. None of them matches the collector, so the rule is expressed as "wherever
 * the suite runs" rather than as a list of files to skip — and adding a workflow that DOES run
 * the suite cannot arrive exempt.
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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");

type Step = { name?: string; run?: string };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const bunfig = Bun.TOML.parse(read("bunfig.toml")) as {
  test?: {
    coverageThreshold?: { lines?: number; functions?: number };
    coveragePathIgnorePatterns?: string[];
    coverageSkipTestFiles?: boolean;
  };
};

/**
 * Every shell line in `.github/workflows/` that INVOKES the test suite.
 *
 * Line-anchored rather than a substring search over the whole `run:` body, because these
 * scripts are heavily commented and `sonar.yml`'s header already explains that "ci.yml
 * already runs `bun test --coverage`". A body-level `includes` matches prose like that and
 * grades the wrong thing — the mention-vs-use trap `invokes()` in
 * test/release-workflow-guard.test.ts was written for, having already reported one step as
 * running before itself.
 *
 * `bun run test` counts too. package.json's `test` script is a bare `bun test`, so that
 * spelling reaches the suite with the thresholds unevaluated exactly as the direct form does,
 * and it would otherwise be the escape hatch left open by a rule that names only one of them.
 */
const suiteRuns = readdirSync(join(repoRoot, ".github", "workflows"))
  .filter((f) => f.endsWith(".yml"))
  .sort()
  .flatMap((file) => {
    const workflow = Bun.YAML.parse(read(join(".github", "workflows", file))) as Workflow;
    return Object.entries(workflow.jobs).flatMap(([jobId, job]) =>
      (job.steps ?? []).flatMap((step) =>
        (step.run ?? "")
          .split("\n")
          .map((line) => line.replace(/^[ \t]+/, ""))
          .filter((code) => /^bun (?:run )?test\b/.test(code))
          .map((code) => ({ file, jobId, code })),
      ),
    );
  });

describe("coverage gate", () => {
  it("every workflow that runs the suite runs it with --coverage", () => {
    // Non-vacuity, and an invariant in its own right. A collector that matched nothing would
    // satisfy the loop below while asserting nothing, and these three each have a reason to
    // run the suite that a silent deletion should not be allowed to remove: ci.yml is the
    // merge gate, sonar.yml computes the LCOV the coverage measure is read from, and
    // release.yml re-runs everything against the exact tree it is about to publish because it
    // fires independently of ci.yml on the same push.
    expect(
      [...new Set(suiteRuns.map((r) => r.file))],
      "the collector must find the workflows that run the suite",
    ).toEqual(expect.arrayContaining(["ci.yml", "release.yml", "sonar.yml"]));

    // `--coverage` as a whole word, not a prefix. `\b` after "coverage" is satisfied by the
    // hyphen in `--coverage-reporter=lcov`, so the obvious pattern accepts
    // `bun test --coverage-reporter=lcov` — a run that writes an LCOV file, evaluates no
    // threshold, and looks more coverage-aware than the bare command it replaced. sonar.yml
    // passes both flags, so that is one deletion away and this guard measured itself
    // accepting it.
    for (const r of suiteRuns) {
      expect(r.code, `${r.file} (${r.jobId}): \`${r.code}\``).toMatch(/(?:^|\s)--coverage(?:\s|$)/);
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
