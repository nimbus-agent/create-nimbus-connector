# create-nimbus-connector — Claude Code Context

## What this is

An **MIT-licensed** CLI that generates a [Nimbus](https://github.com/nimbus-agent/Nimbus)
MCP connector package from a small JSON spec. Nimbus's `packages/mcp-connectors/` holds 94+
connectors built from one rigid shape; this turns that shape into
`bunx create-nimbus-connector <name>`.

It generates for two targets: **monorepo** (lives at `packages/mcp-connectors/<name>/`,
imports `../../shared/*`) and **standalone** (self-contained, imports
`@nimbus-dev/sdk/connector-kit`, runs anywhere).

Published to npm as `create-nimbus-connector`. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
for how it is built, [`docs/ROADMAP.md`](./docs/ROADMAP.md) for where it is going, and
[`docs/USAGE.md`](./docs/USAGE.md) for how to drive it.

## ⚠️ The licensing constraint — read this before copying anything

Three repos, three roles, and the split is load-bearing:

| Repo | License | Role |
| --- | --- | --- |
| `create-nimbus-connector` (here) | **MIT** | the generator |
| [`Nimbus`](https://github.com/nimbus-agent/Nimbus) | **AGPL-3.0-only** | the monorepo, 94+ connector packages |
| [`nimbus-sdk`](https://github.com/nimbus-agent/nimbus-sdk) | **MIT** | publishes `@nimbus-dev/sdk` |

**No connector source, and no `shared/` source, may be copied from Nimbus into this
repository.** Not into `src/`, not into `test/`, not into `fixtures/`. That is a licensing
violation, not a style preference.

This shapes the whole test strategy and explains things that otherwise look like
over-engineering:

- The golden-fixture harness **reads the monorepo at runtime** from a path you pass
  (`--nimbus-root`). It never vendors it, which is why `diff:golden` cannot run in CI.
- `fixtures/*.spec.json` are **hand-written specs**, not extracted from connectors.
- `test/emit/emitted-typecheck.test.ts` compiles emitted Gateway wiring against a stand-in
  written *here*, because the real interface cannot be vendored — and
  `scripts/wiring-conformance.ts` exists precisely because a local stand-in proves nothing
  about whether the skeleton still matches Nimbus.

## Bun-only

This CLI and every connector it generates are Bun-only. `src/cli.ts` carries a
`#!/usr/bin/env bun` shebang, generated manifests declare `"runtime": "bun"`, generated tests
import `bun:test`, and the standalone build script is `bun build --target bun`. There is no
Node, npm or pnpm path in this project or its output.

The one exception is publishing: `.github/workflows/release.yml` sets up Node and runs
`npm publish --provenance`, because that is the only way to attach a sigstore attestation to
an npm tarball.

## The gates, and which ones can lie

This repo's defining concern is **false greens** — checks that pass while asserting nothing.
Several exist because an earlier version of the check was vacuous. Know what each one is
worth before quoting it as evidence.

| Command | What it proves | Needs |
| --- | --- | --- |
| `bun test` | Unit + emitted-source typecheck | — |
| `bunx tsc --noEmit` | This repo typechecks | — |
| `bunx biome check src/ test/ scripts/` | This repo lints | — |
| `bun run diff:golden --nimbus-root <path>` | Emitted bytes match real connectors | Nimbus checkout |
| `bun run acceptance <nimbus-root>` | A generated connector survives inside the monorepo | Nimbus checkout |
| `bun run wiring:conformance --nimbus-root <path>` | The wiring skeleton still matches Nimbus's real sync interface | Nimbus checkout |
| `bun run standalone-acceptance <sdk-root>` | A standalone package builds and serves MCP, against an **unreleased SDK branch** | SDK checkout, built |
| `bun run standalone-acceptance --registry` | The same, against the **published** artifact | network |
| `bun run runtime:acceptance --registry` | Generated connectors make the right HTTP requests | network |

**Traps, each of which has bitten before:**

- **`--registry` and local-checkout mode answer different questions.** Local mode rewrites the
  SDK dependency to `file:`; only `--registry` can catch a `dist` missing from the published
  tarball's `files` array. Reporting a local run as though it were the registry run is a
  false green. A fixture whose declared SDK floor is not yet published reports `SKIP`, and a
  skipped run deliberately does **not** print the sentence a fully-verified run prints.
- **Generated `test/sandbox.test.ts` proves nothing.** It is wrapped in
  `describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])`, and that variable is set nowhere in
  Nimbus. All 79 such tests skip on every CI run. "The generated connector passes its tests"
  is not an acceptance bar. The real bar is `tsc --noEmit` + `biome check` + a byte-diff.
- **`diff:golden` and `wiring:conformance` cannot run in CI** — both need the AGPL monorepo.
  They are local pre-merge gates. Do not add a CI job that skips when the root is absent; a
  silently-skipping gate is the failure mode this repo keeps removing.
- **Coverage floors are per-file, not aggregate**, and `src/cli.ts` / `src/prompts.ts` are
  excluded from the metric because they are driven through `Bun.spawnSync` on the real binary,
  which Bun cannot instrument. Do **not** "raise coverage" by adding in-process tests that
  duplicate the subprocess ones — see `bunfig.toml`, which explains this at length.

## The byte-safety invariant

`newrelic`, `datadog`, `grafana` and `sentry` reproduce **6/6 files byte-for-byte** and must
stay there. Every new emitter path must be gated on a spec field those four never set. After
any emitter change, run `diff:golden` and confirm all four still report `6/6`.

`fixtures/expectations.json` lists, per fixture, the files expected to match. **Never edit it
to hide a mismatch.** A fixture that cannot match a file omits it from the list so the gap is
on screen on every run.

## Reserved identifiers

The emitter declares module-scope names in the output, so a spec may not reuse them.
`src/validate.ts`'s `RESERVED_IDENTIFIERS` is the authoritative list — reusing one is a
parse-time error rather than a generated package that fails its own typecheck.

When you add an emitter path that declares or imports a new module-scope name, add it to that
list in the same change. Two waves have been missed already, and both were found late.

## Conventions

- **Emitters return UNFORMATTED source.** `generate()` is pure; output goes through
  `formatAll()`, which runs the real Biome. Never hand-align indentation — Biome reindents.
  Do hand-manage *line breaks*, which Biome preserves.
- **Never commit on `main`.** Work on a branch.
- **Conventional Commits** drive release-please. A `feat:` bumps the minor, `fix:` the patch.
- Comments explain **why**, and cite the corpus measurement behind a choice where one exists.
  This codebase's comments carry reasoning, not restatement; match that.
- Before claiming anything works, run it. "Generated and it looked right" is not verification.

## Layout

```
src/spec.ts        zod schema + parseSpec — the spec language
src/validate.ts    identifier collision rules, RESERVED_IDENTIFIERS
src/emit/          one module per emitted file; emit/server/ splits by concern
src/format.ts      the Biome integration
src/golden/        fixture resolution, expectations, snapshots
src/cli.ts         arg parsing, prompts, writeFiles
scripts/           the harnesses (each documented in its own header)
fixtures/          hand-written specs + expectations.json + snapshots/
docs/superpowers/  per-stage design docs and implementation plans
```
