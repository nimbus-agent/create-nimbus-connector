/**
 * Guards the acceptance workflow, on the same reasoning as test/coverage-gate.test.ts: a
 * workflow that exists but no longer invokes the thing it was created for still reports
 * green, and nobody reads a passing workflow's step list.
 *
 * These two harnesses are the only checks in the repo that execute generated connectors
 * rather than reading their text, so silently dropping one would remove the strongest
 * coverage while leaving every visible signal unchanged.
 *
 * `Bun.YAML.parse` rather than a `yaml` dependency — this project is Bun-only, and
 * test/release-workflow-guard.test.ts sets the precedent.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Step = { name?: string; run?: string };
type Workflow = {
  on: Record<string, unknown>;
  jobs: Record<string, { steps: Step[] }>;
};

const repoRoot = join(import.meta.dir, "..");
const workflow = Bun.YAML.parse(
  readFileSync(join(repoRoot, ".github", "workflows", "acceptance.yml"), "utf8"),
) as Workflow;

const runs = Object.values(workflow.jobs)
  .flatMap((j) => j.steps)
  .flatMap((s) => (s.run === undefined ? [] : [s.run]));

const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("acceptance workflow", () => {
  it("runs both harnesses that execute generated connectors", () => {
    expect(runs.some((r) => r.includes("standalone-acceptance"))).toBe(true);
    expect(runs.some((r) => r.includes("runtime:acceptance"))).toBe(true);
  });

  it("runs them against the published SDK, not a local checkout", () => {
    // --registry is what makes these answer "does the artifact on npm satisfy the
    // contract?". Without it they resolve a local SDK root, which no runner has.
    for (const r of runs.filter((x) => x.includes("acceptance"))) {
      expect(r).toContain("--registry");
    }
  });

  it("invokes scripts that exist", () => {
    // A renamed package script would turn every run into a loud failure rather than a
    // silent skip, but the failure would land on a schedule nobody is watching.
    for (const r of runs.filter((x) => x.startsWith("bun run "))) {
      const name = r.replace("bun run ", "").split(" ")[0]!;
      expect(Object.keys(pkg.scripts)).toContain(name);
    }
  });

  it("stays out of the pull-request merge gate's workflow", () => {
    // Deliberate: both reach the npm registry, so an outage would red-X unrelated pull
    // requests. If these ever move into ci.yml, that trade needs re-deciding, not
    // inheriting.
    // Parsed steps, not raw text: ci.yml *mentions* both harnesses in a comment explaining
    // where they run, and asserting on the file's characters would fail on the explanation
    // rather than on the behaviour.
    const ci = Bun.YAML.parse(
      readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8"),
    ) as Workflow;
    const ciRuns = Object.values(ci.jobs)
      .flatMap((j) => j.steps)
      .flatMap((s) => (s.run === undefined ? [] : [s.run]));
    expect(ciRuns.some((r) => r.includes("acceptance"))).toBe(false);
  });

  it("still runs on a schedule, so a published-SDK regression surfaces without a PR", () => {
    expect(workflow.on).toHaveProperty("schedule");
  });
});
