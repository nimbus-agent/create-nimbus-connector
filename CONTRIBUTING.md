# Contributing

Thanks for considering a contribution. This document covers what is specific to this repository; the [organisation-wide guidance](https://github.com/nimbus-agent/.github/blob/main/CONTRIBUTING.md), code of conduct, and security policy apply as well.

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
