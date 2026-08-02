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

These three run in CI on every pull request:

```bash
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
```

## The gate CI cannot run — please run it yourself

The most valuable test in this project **does not run in CI**, and that is a deliberate, documented limitation rather than an oversight.

`diff:golden` generates connector packages from the specs in `fixtures/` and byte-compares every file against the real connector in the Nimbus monorepo. That monorepo is AGPL-3.0-only; this repository is MIT. Vendoring it here was rejected in design decision D4, so the harness reads it at runtime from a local checkout — which a CI runner does not have.

```bash
bun run diff:golden --nimbus-root /path/to/Nimbus
bun run acceptance  /path/to/Nimbus
```

If you change anything under `src/emit/`, run these before opening a PR and say in the PR that you did. The harness fails on divergence **in either direction**: a fixture that starts matching *more* files is as much a failure as one that matches fewer, because both mean the recorded expectation in `fixtures/expectations.json` is now stale.

The standalone harness generates a package, installs it, builds it, and drives a real MCP `tools/list` handshake against both `src/server.ts` and the bundled `dist/server.js`:

```bash
bun run standalone-acceptance --registry          # against the published @nimbus-dev/sdk
bun run standalone-acceptance /path/to/nimbus-sdk # against a local SDK checkout
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

## Coverage floors

Coverage is enforced **per file, not in aggregate** — an average lets one well-covered file hide an uncovered one. `src/cli.ts` and `src/prompts.ts` are excluded from the metric because both are driven through `Bun.spawnSync` on the real binary, which Bun cannot instrument; spawning the real binary is the better test, since it proves the shipped entry point works.

**Do not raise coverage by adding in-process tests that duplicate the subprocess ones.** That moves the number without adding assurance, which is the false-green pattern this project keeps removing. Raise the floor only when a real gap closes. `bunfig.toml` explains this at the point of enforcement.
