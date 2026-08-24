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
for how it is built, [`docs/ROADMAP.md`](./docs/ROADMAP.md) for where it is going,
[`docs/USAGE.md`](./docs/USAGE.md) for how to drive it, and
[`docs/SPEC-RULES.md`](./docs/SPEC-RULES.md) for the spec language in prose.

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

**The one carve-out: description strings.** All fourteen real-connector fixtures reproduce that
connector's `nimbus.extension.json` description and its tool descriptions verbatim — 12,688
characters across the corpus (derived, and pinned by `test/fixture-description-budget.test.ts`;
do not hand-edit either number). This is required, not sloppiness: `nimbus.extension.json`
and `src/server.ts` cannot byte-match the real connector without the exact string, and the
four protected 6/6 fixtures (`newrelic`, `datadog`, `grafana`, `sentry`) depend on it. Both
repositories are `nimbus-agent`-owned, which is what makes this a carve-out rather than an
exception to the rule above. It is bounded strictly to these description strings — it does
not extend to connector code, `shared/` source, or filter-file bodies, all of which stay
hand-written.

**`--from-connector` reads a connector directory and prints the spec that would regenerate
it — an authoring aid, not a vendoring path.** [`docs/LICENSING.md`](./docs/LICENSING.md) is
the full answer: why deriving a spec locally is not vendoring, and the one thing that stays
forbidden — a spec derived from a real Nimbus connector may never be committed to `fixtures/`.

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

**`bun run preflight --nimbus-root <path>` runs the eight gates marked **P** below**, in that
order, stopping at the first failure. Without `--nimbus-root` it reports the four that need the
monorepo as `SKIP` **by name**, keeps them in the report, and withholds the sentence a complete
run prints — see `scripts/_lib/preflight.ts`'s `fullyVerified`. It is the answer to "did I run
everything", and a gate no list names is a gate that silently stops being run.

| P | Command | What it proves | Needs |
| --- | --- | --- | --- |
| P | `bun test` | Unit + emitted-source typecheck | — |
| P | `bunx tsc --noEmit` | This repo typechecks | — |
| P | `bunx biome check src/ test/ scripts/` | This repo lints | — |
| P | `bun test --coverage` | `bunfig.toml`'s **per-file** floors, which a bare `bun test` never evaluates | — |
| P | `bun run diff:golden --nimbus-root <path>` | Emitted bytes match real connectors | Nimbus checkout |
|  | `bun run reach --nimbus-root <path>` | How much of the corpus the spec language reaches | Nimbus checkout |
| P | `bun run reach --baseline --nimbus-root <path>` | No connector lost a tier against `fixtures/reach-baseline.json` | Nimbus checkout |
| P | `bun run wiring:conformance --nimbus-root <path>` | The wiring skeleton still matches Nimbus's real sync interface | Nimbus checkout |
| P | `bun run acceptance <nimbus-root>` | A generated connector survives inside the monorepo | Nimbus checkout |
|  | `bun run standalone-acceptance <sdk-root>` | A standalone package builds and serves MCP, against an **unreleased SDK branch** | SDK checkout, built |
|  | `bun run standalone-acceptance --registry` | The same, against the **published** artifact | network |
|  | `bun run runtime:acceptance --registry` | Generated connectors make the right HTTP requests | network |

`acceptance` runs last of the four monorepo gates on a hard constraint, not a preference: it
generates `zzscratch` into `packages/mcp-connectors/` and removes it again, and `reach --baseline`
**refuses** (exit 2) against a dirty `packages/mcp-connectors`.

**Traps, each of which has bitten before:**

- **`--registry` and local-checkout mode answer different questions.** Local mode rewrites the
  SDK dependency to `file:`; only `--registry` can catch a `dist` missing from the published
  tarball's `files` array. Reporting a local run as though it were the registry run is a
  false green. A fixture whose declared SDK floor is not yet published reports `SKIP`, and a
  skipped run deliberately does **not** print the sentence a fully-verified run prints.
- **Generated `test/sandbox.test.ts` proves nothing.** It is wrapped in
  `describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])`, and that variable is set nowhere in
  Nimbus, so every such test in the monorepo is collected and skipped on every CI run. (The 79
  in `src/emit/sandbox-test.ts`'s header is a different number — the corpus connectors whose
  copy of the file is byte-identical, 79 of 94.) In THIS repository the three copies under
  `fixtures/snapshots/` are not collected at all; `bunfig.toml`'s `pathIgnorePatterns` keeps
  them out, and discovered they would fail rather than skip. "The generated connector passes
  its tests" is not an acceptance bar. The real bar is `tsc --noEmit` + `biome check` + a
  byte-diff.
- **Four gates can never run in CI** — `diff:golden`, `reach --baseline`, `wiring:conformance`
  and `acceptance`, each of which needs a checkout of the AGPL monorepo. They are local
  pre-merge gates, and `preflight` is the one command that names all four whether or not it
  could run them. Do not add a CI job that skips when the root is absent; a silently-skipping
  gate is the failure mode this repo keeps removing.
- **"Runs in CI" and "is in the merge gate" are different claims**, and conflating them has
  already put a false sentence into a source file. `ci.yml` is the merge gate and runs three
  commands. `standalone-acceptance --registry` and `runtime:acceptance --registry` **do** run in
  CI — in `acceptance.yml`, on a daily cron and on pull requests touching `src/`, `scripts/` or
  `fixtures/` — but neither is a required check, deliberately, because both install from npm and
  a registry outage must not red-X an unrelated pull request.
- **`reach` measures the spec language's coverage of the corpus and proves nothing about any
  individual generated connector that `diff:golden` does not already prove.** It too needs the
  AGPL monorepo and cannot run in CI. `reach --baseline` is the gate form: it fails when a
  connector *loses* a tier. Never re-record `fixtures/reach-baseline.json` to make a regression
  pass — the same rule `expectations.json` carries.
- **Coverage floors are per-file, not aggregate**, and `src/cli.ts` / `src/prompts.ts` are
  excluded from the metric because they are driven through `Bun.spawnSync` on the real binary,
  which Bun cannot instrument. Do **not** "raise coverage" by adding in-process tests that
  duplicate the subprocess ones — see `bunfig.toml`, which explains this at length.
- **A pure refactor can drop a file onto the floor with no test change.** Deleting a *covered*
  function from a file takes one off both halves of its ratio, and `(h-1)/(f-1) < h/f` whenever
  anything in that file is uncovered — so hoisting a shared helper OUT lowers the donor's
  function coverage. `src/emit/server/tools-rest.ts` sits at 90.91% functions today, tied with
  `src/format.ts` for the floor, and no test moved. Run `bun test --coverage` after a dedup, not
  only after adding code.

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
list in the same change. Three waves have been missed already — the count
`test/emitted-globals.test.ts`'s header records — and each was found late, which is why that
test asks the emitters rather than enumerating the names by hand.

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
src/spec.ts        zod schema + parseSpec, and the spec language's own parsers
                   (parsePathTemplate, resolveKeyedShape) that emit/ and derive/ share
src/validate.ts    identifier collision rules, RESERVED_IDENTIFIERS
src/types.ts       GeneratedFile — the { path: segments[], content } every emitter returns —
                   and displayPath, the one place those segments become a "/" string
src/license.ts     MONOREPO_LICENSE / DEFAULT_STANDALONE_LICENSE and validateLicense, the
                   --license SPDX-expression check (a syntax check, never a registry lookup)
src/emit/          one module per emitted file; emit/server/ splits by concern
src/derive/        the spec deriver — the inverse of src/emit/
src/openapi/       the OpenAPI document reader — the mirror of src/derive/, producing a
                   spec from a foreign document instead of from emitted source
src/format.ts      the Biome integration
src/optional-dep.ts
                   isMissingModule — tells a genuinely absent optionalDependency from one
                   that is installed but whose OWN import failed. src/format.ts and
                   src/derive/ast.ts both branch on it and must NOT degrade alike: a
                   missing formatter falls back to unformatted output, a missing parser
                   cannot fall back at all
src/golden/        fixture resolution, expectations, snapshots, the subprocess wrapper
src/cli.ts         arg parsing, the flag combinations, writeFiles
src/prompts.ts     the interactive spec questionnaire (excluded from coverage with cli.ts)
scripts/           the harnesses (each documented in its own header)
schema/            the published ConnectorSpec JSON Schema, generated by `bun run schema`
fixtures/          hand-written specs + expectations.json + reach-baseline.json + snapshots/
test/              mirrors src/, plus test/scripts/ and the repo-wide gates
                   (source-hygiene, coverage-gate, the two workflow guards)
docs/              ARCHITECTURE, ROADMAP, USAGE, and the project docs. The spec language is
                   documented in two halves: SPEC.md is generated from the schema (edit
                   scripts/_lib/build-spec-doc.ts, never the page), SPEC-RULES.md is the
                   hand-written prose — features, cross-field rules, what rejects a spec
```

**Where the reasoning lives.** Every per-stage design document and implementation plan has been
retired, `docs/superpowers/` with them, once their durable conclusions were folded into the docs
above and into the source comments that enforce them; git history has the originals, and nothing
tracked cites them. **Do not resurrect that directory and do not cite a document that is not on
disk** — a citation to a file nobody can open is worse than none, because it reads as evidence.
[`docs/README.md`](./docs/README.md)'s *Where the reasoning lives* is the map of where each kind
of thing went. In short: what the generator cannot do and why is
[`docs/ROADMAP.md`](./docs/ROADMAP.md)'s *Known limitations*; proposals measured and rejected are
its *Considered and declined*; harness behaviour is
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md); what a green check proves is
[`docs/TESTING.md`](./docs/TESTING.md); the deriver's vocabulary is
[`docs/GLOSSARY.md`](./docs/GLOSSARY.md). Corpus measurements sit in
[`docs/SPEC-RULES.md`](./docs/SPEC-RULES.md) next to the field they justify. **Do not restate live
numbers** — `diff:golden` is the answer, and a document repeating it goes stale silently.

The **one** exception is *The measured ceiling* in `docs/ROADMAP.md`, which states the corpus
regeneration counts on purpose. It earns it by carrying the date and the `packages/mcp-connectors`
tree it was measured against, so a reader can tell when it was true; a number without those two
is what the rule above forbids. If you re-measure it, move the date and the tree with it.
