# Contributing

Thanks for considering a contribution. This document covers what is specific to this repository; the [organisation-wide guidance](https://github.com/nimbus-agent/.github/blob/main/CONTRIBUTING.md), code of conduct, and security policy apply as well.

## Questions

There is one Discussions board for the whole organisation — on the [Nimbus repository](https://github.com/nimbus-agent/Nimbus/discussions) — and no satellite repo has its own, so a question belongs there rather than in whichever repo looked closest. That includes "would you accept a PR that does X?", which is a great deal cheaper asked before the PR than after it.

Anything concrete about *this* repository stays here as an issue: a generator that emits the wrong bytes, a spec that should validate and doesn't, a fixture that stopped matching.

## Before your first PR

You will be asked to sign the [Individual CLA](https://github.com/nimbus-agent/.github/blob/main/CLA/ICLA.md) by commenting on your pull request. Contributing on behalf of an employer? See the [Corporate CLA](https://github.com/nimbus-agent/.github/blob/main/CLA/CCLA.md).

## Setup

**Bun only.** There is no Node, npm, or pnpm path through this project — not in `src/`, `scripts/`, `test/`, or the connectors it generates. The single exception is `release.yml`, which uses `npm publish --provenance` because that is the only way to attach a sigstore attestation, and it says so where it does it.

```bash
bun install
```

## The gates

One command runs the whole local sequence:

```bash
bun run preflight --nimbus-root /path/to/Nimbus
```

It executes eight gates in order, stops at the first failure, and — the part that matters — when you give it no `--nimbus-root` it reports the four gates that need the Nimbus monorepo as **`SKIP`, by name**, and deliberately does not print the sentence a fully-verified run prints. A preflight that quietly omitted four gates would be the exact false green this project exists to remove.

The eight, in the order it runs them:

| Gate | Needs a Nimbus checkout |
| --- | --- |
| `bun test` | no |
| `bunx tsc --noEmit` | no |
| `bunx biome check src/ test/ scripts/` | no |
| `bun test --coverage` — the per-file floors, which a bare `bun test` never evaluates | no |
| `bun run diff:golden --nimbus-root <path>` | **yes** |
| `bun run reach --baseline --nimbus-root <path>` | **yes** |
| `bun run wiring:conformance --nimbus-root <path>` | **yes** |
| `bun run acceptance <path>` | **yes** |

Run an individual gate directly when you are iterating on the thing it checks.

## CI's permanent ceiling — the four gates you have to run yourself

**CI runs three of those eight, and that will never change.** The four in the table above need a checkout of the Nimbus monorepo. That monorepo is AGPL-3.0-only; this repository is MIT. Vendoring it here was refused — see [`docs/LICENSING.md`](./docs/LICENSING.md) for the whole boundary — so the harnesses read it at runtime from a path you pass, and a CI runner has no such path.

**This is not a backlog item, and the tempting fix is refused explicitly**: do not add a CI job that skips when the root is absent. A job that is green because it did nothing is worse than a job that is absent, because the absent one is visible. [`docs/TESTING.md`](./docs/TESTING.md) states, per emitted shape, exactly what a green CI run does and does not prove.

What each of the four answers that nothing else can:

| Gate | The question only it answers |
| --- | --- |
| `diff:golden` | Do the emitted bytes match a real hand-written connector? |
| `reach --baseline` | Has any connector in the 94-connector corpus lost a derivation tier? |
| `wiring:conformance` | Does the emitted Gateway skeleton still match Nimbus's real `Syncable`? |
| `acceptance` | Does a generated connector survive the monorepo's own `tsc`, `biome` and README audit? |

If you change anything under `src/emit/`, run them before opening a PR and say in the PR that you did. `diff:golden` fails on divergence **in either direction**: a fixture that starts matching *more* files is as much a failure as one that matches fewer, because both mean the recorded expectation in `fixtures/expectations.json` is now stale. `reach --baseline` behaves the same way about `fixtures/reach-baseline.json` — a tier that *improved* is a result to state, not to quietly re-record.

Two further harnesses need the npm registry rather than the monorepo, so they **do** run in CI — in `acceptance.yml`, daily and on pull requests touching `src/`, `scripts/` or `fixtures/` — but neither is a required check, because a registry outage must not red-X an unrelated pull request. Run them yourself when you change standalone emission:

```bash
bun run standalone-acceptance --registry          # against the published @nimbus-dev/sdk
bun run standalone-acceptance /path/to/nimbus-sdk # against a local SDK checkout
bun run runtime:acceptance --registry             # what the connectors actually send
```

## The licensing boundary

This repository is MIT. The Nimbus monorepo it generates connectors for is AGPL-3.0-only. **No connector source from that monorepo may be copied into this repository** — not into `src/`, `test/`, `fixtures/`, or documentation. The fixtures are hand-written specs, and the golden harness reads the monorepo at runtime instead. A PR that vendors monorepo source will be asked to remove it regardless of how small the excerpt is.

## Commits

Conventional commits, because release-please reads them to decide the next version and to build the changelog. `feat:` and `fix:` produce releases; `chore:`, `ci:`, `docs:`, `test:` and `refactor:` do not.

Pull requests are squash-merged, so the PR title becomes the commit subject — give it the same conventional-commit shape.

## Tests that assert nothing

This project exists partly because a suite of 79 tests in the monorepo silently skipped on an environment variable that was set nowhere, reporting success while asserting nothing. Please avoid recreating that:

- a test that would still pass if the code under test were deleted is worse than no test;
- prefer asserting on real values and error paths over on "it did not throw";
- if you add a conditional skip, say in a comment what sets the condition and where.

## SonarCloud coverage

SonarCloud reported **0.0% coverage on new code** on every pull request for a long time — not because the code was untested, but because **Automatic Analysis cannot ingest a coverage report** and none was ever uploaded. `.github/workflows/sonar.yml` replaces it with a CI-based analysis that runs `bun test --coverage --coverage-reporter=lcov` and uploads `coverage/lcov.info`.

The two modes are mutually exclusive — SonarCloud **refuses** a CI analysis while Automatic Analysis is enabled — so switching has an order, and getting it wrong leaves the project with no analysis at all:

1. Add a `SONAR_TOKEN` repository or organization secret (SonarCloud → My Account → Security → Generate Token). Without it the scanner fails with *"Not authorized or project not found"* before it ever reaches the analysis-mode question.
2. Turn Automatic Analysis off: SonarCloud → the project → Administration → Analysis Method.
3. Re-run the `sonar` check on the pull request. It should now pass.
4. Merge.

Both switches precede the merge deliberately. The alternative — merge first, then disable — means merging a pull request whose own checks are red, which is a habit worth not starting. The cost is a window of minutes between steps 2 and 3 where `main` has no analysis; the pull request's own run covers the code going into it.

`bunfig.toml`'s per-file `coverageThreshold` still applies during that run, so the gate does not become advisory just because a reporter was added.

### If you are contributing from a fork

**The `sonar` check will show as skipped on your pull request, and that is expected — it is not something you did.** GitHub withholds repository secrets from pull requests opened from a fork, so `SONAR_TOKEN` is unavailable and the scanner cannot authenticate. Until this was handled the check failed outright on every external contribution, which meant a red mark nobody could act on.

**Your coverage is still enforced.** `ci.yml` runs `bun test --coverage` on your pull request, and `bunfig.toml`'s per-file floors apply there. What you lose is the SonarCloud *report*, not the gate — a maintainer sees the analysis once the change is on `main`.

Nothing about this makes the scan optional for the repository itself: pushes to `main` and pull requests from branches in this repository run it unguarded, so a missing or expired `SONAR_TOKEN` still turns `main` red on the next merge.

## Coverage floors

Coverage is enforced **per file, not in aggregate** — an average lets one well-covered file hide an uncovered one. `src/cli.ts` and `src/prompts.ts` are excluded from the metric because both are driven through `Bun.spawnSync` on the real binary, which Bun cannot instrument; spawning the real binary is the better test, since it proves the shipped entry point works.

**Do not raise coverage by adding in-process tests that duplicate the subprocess ones.** That moves the number without adding assurance, which is the false-green pattern this project keeps removing. Raise the floor only when a real gap closes. `bunfig.toml` explains this at the point of enforcement.
