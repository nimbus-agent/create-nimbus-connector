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
 * The one thing that CANNOT live here is the changelog gate. CHANGELOG.md's Unreleased
 * section is *supposed* to hold notes for most of a release cycle, so a test asserting it
 * is empty would fail every pull request between writing a note and cutting the release.
 * The emptiness check therefore has to run only on the release commit — a step inside
 * release.yml — and what this file guards is that the step still exists and still runs
 * before the publish. Its LOGIC is a different question and lives in a different file:
 * scripts/_lib/changelog-gate.ts, exercised by test/scripts/changelog-gate.test.ts. The
 * split matters, because for a while only this half existed and the rule underneath could
 * be deleted outright with every assertion here still passing.
 *
 * Not every describe below is a release fact. This file is also where the repository-wide
 * workflow invariants live, having no other home: one Bun pin everywhere, harden-runner first
 * in every job, every action SHA-pinned, a bounded `timeout-minutes` on every job, a per-ref
 * concurrency group on every workflow with `cancel-in-progress` stated rather than defaulted,
 * the license-boundary gate, the CLA token's narrowing, and the two static-analysis gates that
 * fail open. The ones that can read the workflow
 * DIRECTORY rather than a list of filenames do, so a workflow added later inherits them
 * without anyone remembering to enrol it — which is exactly how the Bun pin came to be
 * checked in only two of the four files that state it.
 *
 * `Bun.YAML.parse` rather than a `yaml` dependency: this project is Bun-only and Bun has
 * shipped a YAML parser since 1.2.21 (present on the pinned 1.3.14). Adding an npm
 * package to read a file would be a strange way to guard a Bun-only project.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UNRELEASED_PLACEHOLDER } from "../scripts/_lib/changelog-gate.ts";

const repoRoot = join(import.meta.dir, "..");
const read = (path: string): string => readFileSync(join(repoRoot, path), "utf8");
const readJson = <T>(path: string): T => JSON.parse(read(path)) as T;

/** A workflow step: exactly one of `run`/`uses`, plus the inputs we grade. */
type Step = {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
};

type Job = {
  if?: string;
  outputs?: Record<string, string>;
  steps?: Step[];
  env?: Record<string, string>;
  "timeout-minutes"?: number;
};

type Workflow = {
  jobs: Record<string, Job>;
  env?: Record<string, string>;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
};

/** Every environment variable name a workflow sets, at any of the three levels. */
const envNames = (w: Workflow): string[] => [
  ...Object.keys(w.env ?? {}),
  ...Object.values(w.jobs).flatMap((job) => [
    ...Object.keys(job.env ?? {}),
    ...(job.steps ?? []).flatMap((step) => Object.keys(step.env ?? {})),
  ]),
];

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
const dependabot = Bun.YAML.parse(read(".github/workflows/dependabot-auto-merge.yml")) as Workflow;
const cla = Bun.YAML.parse(read(".github/workflows/cla.yml")) as Workflow;

/**
 * Every workflow in the directory, parsed — discovered rather than listed.
 *
 * A guard that names the files it reads goes blind to the file added after it, which is
 * precisely how the Bun pin below came to be checked in two of the four workflows that
 * state it. Reading the directory means a new workflow inherits the repo-wide invariants
 * without anyone remembering to enrol it.
 */
const workflows: { file: string; workflow: Workflow }[] = readdirSync(
  join(repoRoot, ".github", "workflows"),
)
  .filter((f) => f.endsWith(".yml"))
  .sort()
  .map((file) => ({
    file,
    workflow: Bun.YAML.parse(read(join(".github", "workflows", file))) as Workflow,
  }));

/** Every job in the repository, tagged with the workflow it came from. */
const allJobs = workflows.flatMap(({ file, workflow }) =>
  Object.entries(workflow.jobs).map(([jobId, job]) => ({ file, jobId, job })),
);

/** Every `oven-sh/setup-bun` step in the repository, with the Bun it pins. */
const bunPins = allJobs.flatMap(({ file, jobId, job }) =>
  (job.steps ?? [])
    .filter((s) => s.uses?.startsWith("oven-sh/setup-bun@"))
    .map((s) => ({ file, jobId, version: s.with?.["bun-version"] })),
);

/** The manifest key for a single-package repo: release-please's root path. */
const ROOT = ".";

/**
 * The literal CHANGELOG.md's Unreleased section carries when it holds nothing, and the
 * string release.yml's changelog gate grades that section against. Transcribed here rather
 * than imported, so this file grades the other two statements of it instead of agreeing
 * with one of them; all three are asserted below.
 */
const CHANGELOG_PLACEHOLDER = "*Nothing pending.*";

/** The command that gate is. Its rule is scripts/_lib/changelog-gate.ts, tested separately. */
const CHANGELOG_GATE_COMMAND = "bun scripts/check-changelog.ts";

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

  it("refuses to publish while the changelog's Unreleased section still holds notes", () => {
    // CHANGELOG.md's Unreleased section is hand-written, and release-please inserts its
    // generated section BELOW it rather than above — so the notes do not move on their own
    // and the move is manual. It was missed on 0.4.0, 0.5.0 and 0.6.0, each of which shipped
    // with its own notes still filed as unreleased, and nothing in the repository noticed.
    //
    // Matched on what the step RUNS rather than on its name, for the same reason the
    // pack-and-execute assertion is: a rename must not make this guard blind to the step
    // being deleted. `invokes` rather than `includes`, so the sentence in the comment block
    // above the step that names the script cannot satisfy this on its own.
    const gateIndex = stepIndex("publish", (s) => invokes(s, CHANGELOG_GATE_COMMAND));
    const publishIndex = stepIndex("publish", (s) => invokes(s, "npm publish"));
    expect(
      gateIndex,
      `the publish job must run \`${CHANGELOG_GATE_COMMAND}\`, which grades CHANGELOG.md's ` +
        `Unreleased section against its ${CHANGELOG_PLACEHOLDER} placeholder`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      gateIndex,
      "the changelog check must run BEFORE the publish — npm cannot unpublish after 72h, " +
        "so a check that runs afterwards reports a wrong changelog instead of preventing it",
    ).toBeLessThan(publishIndex);
  });

  it("runs the changelog gate before the ten minutes of typecheck, lint, test and pack", () => {
    // Not decoration on the ordering above. The gate needs no `bun install` and costs a
    // second; placed after the long steps it would still prevent the publish, but every
    // release that trips it would burn ten minutes first. That is the difference between a
    // cheap gate and one people start wanting to skip.
    const gateIndex = stepIndex("publish", (s) => invokes(s, CHANGELOG_GATE_COMMAND));
    // `findIndex` returns -1 for a step that is not there, and -1 is less than every real
    // index — so without this, deleting the gate outright would satisfy both orderings below.
    expect(gateIndex, "the changelog gate step must exist to be ordered").toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeLessThan(stepIndex("publish", (s) => invokes(s, "bun run typecheck")));
    expect(gateIndex).toBeLessThan(stepIndex("publish", (s) => invokes(s, "npm pack")));
  });

  it("checks the changelog against the placeholder that file actually documents", () => {
    // One fact in three files: CHANGELOG.md's convention header names the literal so a reader
    // knows what to leave behind, scripts/_lib/changelog-gate.ts grades against it, and this
    // is an independent transcription of both. Rename it in one place and the gate would
    // grade against a string nothing will ever contain again — a gate that fails every
    // release for the wrong reason, or (if inverted) never fires. The header names the
    // literal on purpose so this assertion holds while notes ARE pending, which is the normal
    // mid-development state and must not fail CI.
    expect(read("CHANGELOG.md")).toContain(CHANGELOG_PLACEHOLDER);
    expect(UNRELEASED_PLACEHOLDER).toBe(CHANGELOG_PLACEHOLDER);
  });

  it("never authenticates with a token", () => {
    // release.yml authenticates solely through npm trusted publishing (GitHub OIDC).
    // A NODE_AUTH_TOKEN here would be a *silent* fallback: if the OIDC binding were
    // ever removed or misconfigured, publishing would keep working via the token and
    // nothing would report that the guarantee had been lost. Failing closed is the
    // entire value of the binding, so the absence of a token is a property worth
    // asserting rather than a thing to remember.
    //
    // The one-time bootstrap publish that claimed the name on npm deliberately DID
    // carry a token — a trusted-publisher binding cannot be configured for a package
    // that does not exist yet. That workflow was deleted once the binding was in
    // place, so no such file is in .github/workflows/ today; this assertion is scoped
    // to release.yml, the only workflow that publishes.
    // Structural, not textual. release.yml *documents* its own absence of a token in a
    // comment ("No NODE_AUTH_TOKEN: the trusted-publisher binding authenticates ..."),
    // so a `toContain` on the file body matches the explanation and fails on a correct
    // workflow. That is the same mention-vs-use trap `invokes()` above exists for, and
    // the first version of this assertion fell into it.
    // Proves the detector is not vacuous before trusting its negative: a broken
    // envNames() returning [] would satisfy the assertion below while seeing nothing.
    expect(envNames(release)).toContain("PUBLISHED_VERSION");

    expect(envNames(release)).not.toContain("NODE_AUTH_TOKEN");
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

describe("the dependency-review gate", () => {
  const workflow = workflows.find((w) => w.file === "dependency-review.yml")?.workflow;
  const step = Object.values(workflow?.jobs ?? {})
    .flatMap((j) => j.steps ?? [])
    .find((s) => s.uses?.startsWith("actions/dependency-review-action@"));
  const denied = (step?.with?.["deny-licenses"] ?? "").split(",").map((s) => s.trim());

  it("runs on every pull request", () => {
    // The action reads the dependency-graph diff between base and head, which only exists
    // for a pull_request event. On any other trigger it needs base-ref/head-ref and would
    // grade nothing here.
    expect(workflow, ".github/workflows/dependency-review.yml must exist").toBeDefined();
    expect(Object.keys(workflow?.on ?? {})).toContain("pull_request");
  });

  it("denies every SPDX spelling of AGPL and GPL", () => {
    // This repository's number-one invariant is a license boundary: MIT generator, AGPL-only
    // monorepo, and no source may cross. test/license.test.ts guards the license string the
    // generator EMITS — it says nothing about this repo's own dependency tree, which is what
    // an AGPL transitive dependency would poison. It matters most on Dependabot's pull
    // requests: dependabot-auto-merge.yml merges patch and minor without a human.
    //
    // Both the deprecated bare ids and the -only/-or-later forms, because a package can
    // declare either and the action compares the declared expression against this list.
    // Every id below was checked against spdx-license-ids (current + deprecated) and parsed
    // with spdx-expression-parse: the action THROWS on an id it cannot parse, so a typo here
    // is loud rather than silently unmatched.
    expect(step, "the workflow must run actions/dependency-review-action").toBeDefined();
    for (const id of [
      "AGPL-1.0",
      "AGPL-1.0-only",
      "AGPL-1.0-or-later",
      "AGPL-3.0",
      "AGPL-3.0-only",
      "AGPL-3.0-or-later",
      "GPL-1.0",
      "GPL-1.0-only",
      "GPL-1.0-or-later",
      "GPL-2.0",
      "GPL-2.0-only",
      "GPL-2.0-or-later",
      "GPL-3.0",
      "GPL-3.0-only",
      "GPL-3.0-or-later",
    ]) {
      expect(denied, `deny-licenses must list ${id}`).toContain(id);
    }
  });

  it("never downgrades itself to a warning", () => {
    // `warn-only: true` makes the action always exit 0. That is the exact false-green shape
    // this repository keeps deleting: a required check that reports success while the thing
    // it checks is broken.
    expect(step?.with?.["warn-only"]).toBeUndefined();
    // allow-licenses and deny-licenses are mutually exclusive — the action refuses both —
    // and an allow-list would replace the denial above rather than add to it.
    expect(step?.with?.["allow-licenses"]).toBeUndefined();
    expect(step?.with?.["license-check"]).toBeUndefined();
  });

  it("grants nothing beyond contents: read", () => {
    const granted = {
      ...(workflow?.permissions ?? {}),
      ...Object.fromEntries(
        Object.values(workflow?.jobs ?? {}).flatMap((j) =>
          Object.entries((j as Job & { permissions?: Record<string, string> }).permissions ?? {}),
        ),
      ),
    };
    expect(granted).toEqual({ contents: "read" });
  });
});

describe("the CLA workflow", () => {
  const mintStep = (cla.jobs["cla-assistant"]?.steps ?? []).find((s) =>
    s.uses?.startsWith("actions/create-github-app-token@"),
  );

  it("mints the App token with only the permission the CLA action uses", () => {
    // This token is handed to contributor-assistant/github-action — a third-party action —
    // on a `pull_request_target` trigger that any external contributor can fire by opening a
    // pull request. Without `permission-*` inputs, create-github-app-token mints a token
    // carrying the App INSTALLATION's whole permission set, which is far wider than the one
    // call the action makes with it.
    //
    // Read from the action's source at the pinned SHA rather than inferred: `getPATOctokit()`
    // is imported in exactly one module, src/persistence/persistence.ts, where it backs
    // `repos.getContent` and `repos.createOrUpdateFileContents` on the signatures file. Every
    // other API call — the PR comment and the workflow re-run — goes through
    // `getDefaultOctokitClient()`, i.e. GITHUB_TOKEN, governed by this job's own
    // `permissions:` block. So the App token needs `contents: write` and nothing else.
    //
    // Exact equality, not `toContain`: a permission added later should have to argue for
    // itself here rather than arrive as a passing diff.
    expect(mintStep, "cla-assistant must mint an App token").toBeDefined();
    expect(
      Object.keys(mintStep?.with ?? {})
        .filter((k) => k.startsWith("permission-"))
        .sort(),
    ).toEqual(["permission-contents"]);
    expect(mintStep?.with?.["permission-contents"]).toBe("write");
  });

  it("scopes the App token to the repository that holds the signatures, and no other", () => {
    // `repositories` was `${{ github.event.repository.name }},.github`, which also handed
    // this repository's contents to the third-party action. persistence.ts always addresses
    // `input.getRemoteRepoName()` — pinned to `.github` by the `remote-repository-name`
    // input below — so the second entry was never reachable by the token's only consumer.
    expect(mintStep?.with?.repositories).toBe(".github");
    expect(
      (cla.jobs["cla-assistant"]?.steps ?? []).find((s) =>
        s.uses?.startsWith("contributor-assistant/github-action@"),
      )?.with?.["remote-repository-name"],
      "the narrowing above is only sound while the signatures live in a remote repository",
    ).toBe(".github");
  });

  it("keeps the job name that branch protection requires as a status check", () => {
    // The one assertion here whose failure mode is a repository nobody can merge into.
    //
    // contributor-assistant publishes no status and no check run of its own — setupClaCheck.ts
    // at the pinned SHA ends in `core.info(...)` or `core.setFailed(...)` and nothing else — so
    // the ONLY thing branch protection can require is this job's own conclusion, under this
    // job's own name. Rename the key and the required context names a check no workflow
    // produces: every pull request then sits at "Expected — Waiting for status to be reported"
    // with every visible check green, which is exactly how PR #94 stalled while `cla` was
    // required and nothing in this repository had ever posted it.
    //
    // The name is duplicated into the branch ruleset by hand and cannot be read back from
    // here, so this test is the whole coupling. Changing it means changing the ruleset in the
    // same breath.
    expect(
      Object.keys(cla.jobs),
      "`cla-assistant` is a required status check on main — renaming the job renames the " +
        "required context and blocks every pull request until the ruleset is edited to match",
    ).toContain("cla-assistant");
  });

  it("cannot skip the required job on a pull request", () => {
    // A skipped job reports `skipped`, and branch protection counts that as satisfied. So a
    // condition that can skip `cla-assistant` on a `pull_request_target` event does not turn
    // the check red — it turns it green, for every pull request, silently. That is the same
    // false-green shape as a gate that no-ops when its input is missing, and it is worth a
    // test precisely because the failure produces no signal at all.
    //
    // Asserted as "the PR arm is an unconditional disjunct": the `issue_comment` arm may
    // narrow all it likes, because those runs attach to the default branch rather than to any
    // pull request head and can satisfy nothing.
    const condition = (cla.jobs["cla-assistant"]?.if ?? "").replace(/\s+/g, " ");
    expect(condition, "cla-assistant must have a condition to grade").not.toBe("");
    expect(
      condition.split("||").map((arm) => arm.trim()),
      "one arm of the condition must be the bare `pull_request_target` event test, so the " +
        "required check always runs for real against a pull request head",
    ).toContain("github.event_name == 'pull_request_target'");
  });
});

/** The CodeQL config both the workflow and the assertions below must be talking about. */
const CODEQL_CONFIG = ".github/codeql/codeql-config.yml";

const stepsOf = (file: string, prefix: string): Step[] =>
  Object.values(workflows.find((w) => w.file === file)?.workflow.jobs ?? {})
    .flatMap((j) => j.steps ?? [])
    .filter((s) => s.uses?.startsWith(prefix));

describe("the static-analysis gates", () => {
  // Both settings asserted here FAIL OPEN. Delete either and every workflow stays green
  // while analysing less — no red check, no diff anyone has to argue with. That is the
  // property worth a test: a weakening that produces a failure needs no guard, and a
  // weakening that produces silence is the only kind this repository has ever shipped.

  it("makes SonarCloud's verdict fail the workflow rather than only a web page", () => {
    // Without `sonar.qualitygate.wait` the scanner uploads its report and exits 0 whatever
    // the gate then concludes, so the workflow is green while findings pile up unread. They
    // reached 87 that way once. The bound gate ("Sonar way") grades `new_*` metrics only, so
    // this blocks a pull request that makes its own diff worse — not one that merely fails to
    // fix the backlog.
    const scan = stepsOf("sonar.yml", "SonarSource/sonarqube-scan-action@")[0];
    expect(scan, "sonar.yml must run the SonarSource scan action").toBeDefined();
    expect(scan?.with?.args ?? "").toContain("-Dsonar.qualitygate.wait=true");
  });

  it("never lets the sonar job skip itself on a missing token", () => {
    // sonar.yml's header rejects `if: env.SONAR_TOKEN != ''` at length, and until now that
    // rejection was prose — the exact shape test/measurement-hygiene.test.ts exists because of.
    // A token-presence guard fails open twice over: the workflow goes green while analysing
    // nothing, and it stays green forever if the secret is never added, so the one signal that
    // the prerequisite is unmet is the one it deletes.
    //
    // The job's `if` is allowed to skip the runs where GitHub structurally withholds the
    // Actions secret store — a fork's pull request, and a Dependabot-triggered one. Those are
    // conditions on WHO triggered the run, checkable from the event payload alone. Reading the
    // secret is a different thing, and this asserts the difference rather than the wording:
    // the condition may say anything at all except "is the token set".
    const sonar = workflows.find((w) => w.file === "sonar.yml")?.workflow;
    expect(sonar, "sonar.yml must exist").toBeDefined();
    const condition = sonar?.jobs?.["sonar"]?.if ?? "";
    expect(condition, "the sonar job must carry a condition").not.toBe("");
    expect(condition).not.toContain("SONAR_TOKEN");
    expect(condition).not.toContain("secrets.");

    // And the push-to-main run stays unguarded, which is what makes a missing secret loud:
    // widen the skip to cover `push` and forgetting SONAR_TOKEN produces silence instead of a
    // red main. Pinned as a substring for the same reason the scanner arg above is — the
    // property is one clause of an expression no test can evaluate.
    expect(condition).toContain("github.event_name != 'pull_request'");
  });

  it("runs CodeQL's security-extended suite without dropping the default one", () => {
    const config = Bun.YAML.parse(read(CODEQL_CONFIG)) as {
      queries?: { uses?: string }[];
      "disable-default-queries"?: boolean;
    };
    expect(config.queries?.map((q) => q.uses)).toContain("security-extended");
    // `disable-default-queries` REPLACES the default suite rather than extending it. Set
    // alongside the line above, the config would read as "more queries" while running fewer.
    expect(config["disable-default-queries"]).toBeUndefined();
  });

  it("grades the CodeQL config the workflow actually loads", () => {
    // The assertion above reads CODEQL_CONFIG by path. Point codeql.yml's `config-file` input
    // at anything else and it grades a file no scan reads — the same "a guard that reads only
    // the file agreeing with it" failure that let release.yml run a bare `bun test` for the
    // whole life of a rule requiring --coverage.
    const init = stepsOf("codeql.yml", "github/codeql-action/init@")[0];
    expect(init?.with?.["config-file"]).toBe(CODEQL_CONFIG);
  });
});

describe("runner hardening", () => {
  it("hardens the runner as the first step of every job in every workflow", () => {
    // harden-runner installs an eBPF egress monitor into the runner; anything that runs
    // before it is unobserved, so its position is part of what it is worth — not a style
    // point. cla.yml was the only workflow without it, and the one where the audit log is
    // worth most: it is the `pull_request_target` workflow that hands a minted App token to
    // a third-party action, on a trigger an external contributor controls.
    expect(
      allJobs.length,
      "the collector must find jobs — an empty list satisfies the loop below silently",
    ).toBeGreaterThanOrEqual(9);
    for (const { file, jobId, job } of allJobs) {
      expect(job.steps?.[0]?.uses, `${file} / ${jobId}: first step`).toStartWith(
        "step-security/harden-runner@",
      );
    }
  });

  it("pins every action to a full-length commit SHA", () => {
    // The org requires it, and nothing else in the repository checked. A moving tag is a
    // supply-chain hole that reads as a normal `uses:` line.
    const uses = allJobs.flatMap(({ file, jobId, job }) =>
      (job.steps ?? []).flatMap((s) =>
        s.uses === undefined ? [] : [{ file, jobId, ref: s.uses }],
      ),
    );
    expect(uses.length).toBeGreaterThanOrEqual(20);
    for (const u of uses) {
      expect(u.ref, `${u.file} / ${u.jobId}`).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});

describe("the runner budget", () => {
  it("gives every job a timeout-minutes", () => {
    // GitHub's default is 360 minutes. A job that hangs — a harness waiting on a token that
    // never expires, a `bun install` against a registry that accepted the connection and then
    // stopped answering — holds a runner for six hours before anything notices, and on a repo
    // with concurrency groups that also blocks the next push to the same ref. Every job carries
    // one today; nothing made that true, which is the same shape as the Bun pin below.
    expect(
      allJobs.length,
      "the collector must find jobs — an empty list satisfies the loop below silently",
    ).toBeGreaterThanOrEqual(9);
    for (const { file, jobId, job } of allJobs) {
      const limit = job["timeout-minutes"];
      expect(limit, `${file} / ${jobId} must declare timeout-minutes`).toBeDefined();
      expect(typeof limit, `${file} / ${jobId}: timeout-minutes must be a number`).toBe("number");
      // An upper bound as well as a lower one: `timeout-minutes: 360` is the default written
      // out longhand, which passes a presence check while changing nothing. The longest job
      // here is CodeQL at 30.
      expect(limit, `${file} / ${jobId}: timeout-minutes ${limit}`).toBeGreaterThan(0);
      expect(limit, `${file} / ${jobId}: timeout-minutes ${limit}`).toBeLessThanOrEqual(60);
    }
  });

  it("gives every workflow a per-ref concurrency group", () => {
    expect(workflows.length, "the collector must find workflows").toBeGreaterThanOrEqual(7);
    for (const { file, workflow } of workflows) {
      const group = workflow.concurrency?.group;
      expect(group, `${file} must declare a concurrency group`).toBeDefined();
      // A constant group is a repository-wide lock: every run of that workflow queues behind
      // every other, whatever ref it is for. The interpolation is what makes the group per-ref
      // (or per-pull-request, in the two `pull_request_target` workflows), so it is the part
      // worth asserting rather than mere presence.
      expect(group, `${file}: concurrency group "${group}" is constant`).toContain("${{");
    }
  });

  it("never cancels a run that publishes or posts a verdict", () => {
    // cancel-in-progress is right for a check and wrong for a release: cancelling release.yml
    // mid-publish can leave a tag pushed with no npm artifact behind it, and this org's release
    // tags are immutable, so the recovery is to abandon the version. The three that must not
    // cancel are the one that publishes and the two that run on `pull_request_target` and
    // report a per-PR verdict a cancelled run would leave un-posted.
    const NEVER_CANCEL = ["cla.yml", "dependabot-auto-merge.yml", "release.yml"];
    for (const file of NEVER_CANCEL) {
      const found = workflows.find((w) => w.file === file);
      expect(found, `${file} is missing — update this list or restore the workflow`).toBeDefined();
      expect(found?.workflow.concurrency?.["cancel-in-progress"], `${file}`).toBe(false);
    }
    // Stated explicitly everywhere, not only in the three above: an omitted key is `false` by
    // default, so a check workflow that meant to cancel and forgot the line queues superseded
    // runs instead of dropping them, with nothing in the diff to point at.
    for (const { file, workflow } of workflows) {
      expect(
        workflow.concurrency?.["cancel-in-progress"],
        `${file} must state cancel-in-progress explicitly`,
      ).toBeTypeOf("boolean");
    }
  });
});

describe("the Bun pin", () => {
  it("is one version, stated the same way in every workflow that installs Bun", () => {
    // The pin is one fact written in four files, and until this guard existed only two of
    // them were read — `bunVersion(release, "publish")` against `bunVersion(ci, "check")`,
    // above. acceptance.yml runs the two harnesses that actually EXECUTE generated
    // connectors, the strongest checks in this repo, and it could drift to a Bun no pull
    // request was ever tested against with nothing to say so; sonar.yml computes the
    // coverage the per-file threshold is graded on, on a Bun of its own. Verified by
    // mutation: acceptance.yml at 1.3.13 passes every other test in this repository.
    expect(
      bunPins.map((p) => p.file),
      "the collector must see every workflow that pins Bun — a collector that sees nothing " +
        "satisfies the equality below while asserting nothing",
    ).toEqual(expect.arrayContaining(["acceptance.yml", "ci.yml", "release.yml", "sonar.yml"]));

    const canonical = bunVersion(ci, "check");
    expect(canonical, "ci.yml's check job is the canonical pin").toBeDefined();
    for (const pin of bunPins) {
      // An absent `bun-version` is not the neutral case: setup-bun then resolves `latest`,
      // which is the same drift with no line in the diff to point at.
      expect(pin.version, `${pin.file} (${pin.jobId}) must pin bun-version`).toBeDefined();
      expect(
        pin.version,
        `${pin.file} (${pin.jobId}) pins Bun ${pin.version}, ci.yml pins ${canonical}`,
      ).toBe(canonical);
    }
  });
});

describe("dependabot auto-merge workflow", () => {
  // `pull_request_target` runs with the BASE repository's permissions and secrets.
  // Combined with checking out the pull request's code, that is the canonical GitHub
  // Actions privilege-escalation shape: untrusted code executing with write access to
  // the repository it is proposing changes to.
  //
  // This workflow is safe *because* it never checks anything out — it reads metadata
  // and calls the API. That is a property of the file, not of anyone's intention, so
  // it is asserted here: a future edit that adds a checkout step fails this test
  // rather than shipping quietly.
  it("never checks out code, because it runs as pull_request_target", () => {
    const triggers = Object.keys(dependabot.on ?? {});
    expect(triggers).toContain("pull_request_target");

    const steps = Object.values(dependabot.jobs).flatMap((j) => j.steps ?? []);
    expect(steps.length).toBeGreaterThan(0); // not vacuous: there are steps to inspect
    expect(steps.filter((s) => s.uses?.startsWith("actions/checkout"))).toHaveLength(0);
  });

  it("grants nothing workflow-wide", () => {
    // Job-scoped permissions only, so the metadata step cannot write anything.
    expect(dependabot.env === undefined || Object.keys(dependabot.env).length === 0).toBe(true);
    expect(Object.keys(dependabot.jobs)).toHaveLength(1);
  });
});
