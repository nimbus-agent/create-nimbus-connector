/**
 * Release guard — every fact this repo is forced to state twice must state it the same way.
 *
 * Publishing spans four files that GitHub and release-please give us no way to keep in
 * sync: `package.json`, `.release-please-manifest.json`, `release-please-config.json` and
 * `.github/workflows/release.yml`. Each duplicated value below is one fact written in two
 * places because there is no single place to write it, and each one fails *silently* when
 * it drifts — the release goes green and ships the wrong thing, or skips the publish and
 * says nothing. So the relationships are asserted here, at every commit, and drift fails
 * on the PR that introduces it rather than on the release that suffers from it.
 *
 * npm cannot unpublish after 72 hours. That is the whole reason this file exists at the
 * *test* layer instead of as a step inside the release job.
 *
 * `Bun.YAML.parse` rather than a `yaml` dependency: this project is Bun-only and Bun has
 * shipped a YAML parser since 1.2.21 (present on the pinned 1.3.14). Adding an npm
 * package to read a file would be a strange way to guard a Bun-only project.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");
const readJson = <T>(path: string): T => JSON.parse(read(path)) as T;

/** A workflow step: exactly one of `run`/`uses`, plus the inputs we grade. */
type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
};

type Job = {
  if?: string;
  outputs?: Record<string, string>;
  steps?: Step[];
};

type Workflow = { jobs: Record<string, Job> };

type PackageJson = {
  name: string;
  version: string;
  repository?: { url?: string };
};

type ReleasePleaseConfig = {
  packages: Record<string, { "release-type"?: string; "package-name"?: string }>;
};

const pkg = readJson<PackageJson>("package.json");
const manifest = readJson<Record<string, string>>(".release-please-manifest.json");
const config = readJson<ReleasePleaseConfig>("release-please-config.json");
const release = Bun.YAML.parse(read(".github/workflows/release.yml")) as Workflow;
const ci = Bun.YAML.parse(read(".github/workflows/ci.yml")) as Workflow;

/** The manifest key for a single-package repo: release-please's root path. */
const ROOT = ".";

const releaseSteps = (jobId: string): Step[] => release.jobs[jobId]?.steps ?? [];

const stepIndex = (jobId: string, predicate: (step: Step) => boolean): number =>
  releaseSteps(jobId).findIndex(predicate);

/**
 * Does this step's script *invoke* `command`, as opposed to merely mentioning it?
 *
 * Anchored to the start of a line, because these scripts are heavily commented and a
 * substring search does not survive that: the pack-and-execute step explains why it uses
 * `npm pack` rather than `bun pm pack` "because that is the packer `npm publish` will
 * use" — and a naive `run.includes("npm publish")` matched that comment, found the wrong
 * step, and reported the publish as happening before itself. Caught by these very tests.
 *
 * Scans lines rather than building a `RegExp` from `command`. The callers pass literals, so
 * a dynamic pattern was never exploitable here — but constructing a regex from an argument
 * is a security finding on sight (Sonar rated it, correctly, without knowing the inputs),
 * and a plain string comparison expresses the same rule without the question arising.
 */
const invokes = (step: Step, command: string): boolean =>
  (step.run ?? "").split("\n").some((line) => {
    const code = line.replace(/^[ \t]+/, "");
    if (!code.startsWith(command)) return false;
    // Word boundary, so `npm pack` does not match a hypothetical `npm packfoo`.
    const next = code.charAt(command.length);
    return next === "" || !/[\w$]/.test(next);
  });

const publishStep = (): Step | undefined =>
  releaseSteps("publish").find((s) => invokes(s, "npm publish"));

/** The `bun-version` input of whichever step in `job` pins Bun, from either workflow. */
function bunVersion(workflow: Workflow, jobId: string): string | undefined {
  const step = (workflow.jobs[jobId]?.steps ?? []).find((s) =>
    s.uses?.startsWith("oven-sh/setup-bun@"),
  );
  return step?.with?.["bun-version"];
}

describe("release-please configuration", () => {
  it("tracks the version package.json actually declares", () => {
    // THE load-bearing assertion, and the only one whose failure is invisible until it is
    // too late. release-please computes the next version from the manifest, not from
    // package.json. Hand-editing package.json to 0.2.0 while the manifest still says
    // 0.1.0 makes the next release PR "bump 0.1.0 -> 0.1.1" and rewrite package.json
    // backwards — a version that is lower than the one already on disk, published under
    // a tag that names neither.
    expect(
      manifest[ROOT],
      ".release-please-manifest.json must record the version package.json declares — " +
        "release-please releases from the manifest, so a hand-edited package.json " +
        "version silently desyncs the next release",
    ).toBe(pkg.version);
  });

  it("names the package npm will actually receive", () => {
    // release-please writes changelogs and tag/PR titles from `package-name`. A mismatch
    // is cosmetic on the PR and permanent in the changelog.
    expect(config.packages[ROOT]?.["package-name"]).toBe(pkg.name);
  });

  it("releases the repository root as a node package", () => {
    expect(config.packages[ROOT]?.["release-type"]).toBe("node");
  });

  it("declares exactly one package, at the root", () => {
    // This is what entitles release.yml to read *unprefixed* outputs (`release_created`
    // rather than `<path>--release_created`): release-please-action only emits the bare
    // names for a root component. Move this package into a subdirectory and the outputs
    // silently become undefined — which stringifies to '', never equals 'true', and so
    // skips the publish job without failing anything.
    expect(Object.keys(config.packages)).toEqual([ROOT]);
    expect(Object.keys(manifest)).toEqual([ROOT]);
  });
});

describe("the release workflow", () => {
  it("gates publish on the output the release-please job actually exports", () => {
    // Two halves of one wire, in two jobs. If either name changes alone the publish job
    // is skipped in silence: GitHub does not error on an `if:` that references an output
    // nobody set.
    expect(release.jobs["release-please"]?.outputs?.release_created).toBe(
      "${{ steps.release.outputs.release_created }}",
    );
    expect(release.jobs.publish?.if).toBe("needs.release-please.outputs.release_created == 'true'");
  });

  it("scopes the release-bot token to this repository", () => {
    // The App token is scoped to a repository *by name*. Scoped to the wrong one, the
    // token mints fine and release-please 403s on the push — which reads as a broken App
    // installation rather than a typo. The repository and the package share a name here.
    const step = releaseSteps("release-please").find((s) =>
      s.uses?.startsWith("actions/create-github-app-token@"),
    );
    expect(step?.with?.repositories).toBe(pkg.name);
  });

  it("validates the artifact on the same Bun that CI validates every PR with", () => {
    // The published `bin` is TypeScript run by Bun, so the Bun that proves the tarball
    // works is part of the guarantee. Letting the two workflows drift means the release
    // gate runs on a Bun no PR was ever tested against.
    const pinned = bunVersion(release, "publish");
    expect(pinned, "release.yml's publish job must pin bun-version").toBeDefined();
    expect(pinned).toBe(bunVersion(ci, "check"));
  });

  it("proves the packed tarball runs before it publishes it", () => {
    // Matched on the `run:` body rather than the step name, so a cosmetic rename cannot
    // make this guard go blind to the step being deleted outright.
    const packIndex = stepIndex("publish", (s) => invokes(s, "npm pack"));
    const publishIndex = stepIndex("publish", (s) => invokes(s, "npm publish"));
    expect(
      packIndex,
      "the publish job must pack the tarball and execute the installed bin — `bin` points " +
        'at ./src/cli.ts and `files` is ["src", "README.md"], so a bad `files` array ' +
        "produces a package that installs and then cannot run, and no test in this repo " +
        "would notice because they all run against the working tree",
    ).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThanOrEqual(0);
    expect(
      packIndex,
      "the pack-and-execute check must run BEFORE the publish — npm cannot unpublish " +
        "after 72h, so a check that runs afterwards reports damage instead of preventing it",
    ).toBeLessThan(publishIndex);
  });

  it("requires OIDC and a trusted-publishing npm before it publishes", () => {
    const preflightIndex = stepIndex(
      "publish",
      (s) => s.run?.includes("ACTIONS_ID_TOKEN_REQUEST_TOKEN") === true,
    );
    const publishIndex = stepIndex("publish", (s) => invokes(s, "npm publish"));
    expect(preflightIndex).toBeGreaterThanOrEqual(0);
    expect(preflightIndex).toBeLessThan(publishIndex);
  });

  it("publishes with provenance", () => {
    // The entire point of the Node/npm exception in an otherwise Bun-only project.
    // Dropping the flag publishes successfully and unattested, which is exactly the
    // failure that looks like success.
    const step = publishStep();
    expect(step?.run).toContain("--provenance");
    expect(step?.run).toContain("--access public");
  });
});

describe("provenance metadata", () => {
  // npm refuses to generate provenance when package.json's repository does not match the
  // repository the workflow is running in ("Provenance generation in GitHub Actions
  // requires 'repository.url' to be set"), and the post-publish verifier grades the
  // signed attestation against `expected-repo`. Three statements of one fact.
  const expectedRepo = releaseSteps("publish").find((s) =>
    s.uses?.includes("verify-npm-provenance"),
  )?.with?.["expected-repo"];

  it("the workflow verifies provenance against a repository it names", () => {
    expect(expectedRepo).toBeDefined();
  });

  it("package.json's repository url points at that same repository", () => {
    expect(pkg.repository?.url).toBe(`git+https://github.com/${expectedRepo}.git`);
  });

  it("the published package name is the one the verifier checks", () => {
    const step = releaseSteps("publish").find((s) => s.uses?.includes("verify-npm-provenance"));
    expect(step?.with?.package).toBe(pkg.name);
  });
});
