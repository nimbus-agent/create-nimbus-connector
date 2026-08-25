# Testing — what a green check proves

This project's defining concern is the **false green**: a check that passes while asserting
nothing. Several of its gates exist because an earlier version of that gate was vacuous, and
several were rewritten more than once as the next hole opened — the history
`scripts/_lib/preflight.ts`'s header summarises before adding its own aggregator to the pile.

So the question *"is this emitter change safe to merge?"* has an answer, and it is not "CI is
green." The answer depends on **which of the six emitted shapes the change touches**, because
the six are not checked alike — one is compiled, one is only linted, and four are compiled
nowhere that `bun test` reaches. That reasoning used to be reconstructable only by reading
`CLAUDE.md`, `docs/ARCHITECTURE.md`, `bunfig.toml` and
`test/emit/emitted-typecheck.test.ts`'s header together, and those four disagreed at the
edges. This page is the reconciliation.

It is about **coverage of the emitted output**. How each harness is built and what it does
mechanically is [ARCHITECTURE § The verification layers](./ARCHITECTURE.md#the-verification-layers);
which command to run before pushing is [CLAUDE.md](../CLAUDE.md)'s *The gates, and which ones
can lie*.

**Every row below was checked against the file it names**, and the central claim was measured
with a probe rather than read off the test names. Where a claim could not be verified by
reading, it was verified by breaking the emitter on purpose and watching what noticed. A
matrix that is wrong is worse than no matrix, because it will be trusted.

## The six shapes

Every connector this generator emits is one of three **styles** (`hand-rolled`, `rest-kit`,
`read-only-kit`) crossed with one of two **targets** (`monorepo`, `standalone`). Those six
combinations take genuinely different code paths through `src/emit/server/index.ts`, and they
are not equally checked.

| Shape | What **compiles** it | What only **substring-asserts** it | What **byte-compares** it | What is left to a gate outside `bun test` |
| --- | --- | --- | --- | --- |
| `hand-rolled` × monorepo | nothing in `bun test` | `test/emit/server/tools-hand.test.ts`, `body.test.ts`, `fetch-helper.test.ts`, `env.test.ts`, `test/emit/generate.test.ts` | `test/derive/round-trip.test.ts` — emit → derive → re-emit, against itself | `diff:golden` (`newrelic`, `datadog`, `grafana`, `sentry` against the real connectors); `acceptance` (the monorepo's own `tsc`/`biome`). **Neither runs in CI.** |
| `hand-rolled` × standalone | nothing in `bun test` | `test/emit/generate.test.ts`; `emitted-typecheck.test.ts`'s *read helper emission is conditional on a call site* block, which is substring-only by its own admission | `test/golden/snapshots.test.ts` against `fixtures/snapshots/zzwrite/` and `.../zzwriteonly/` | `standalone-acceptance` (`zzstandalonehand`, `zzwrite`, `zzwriteonly` — the package's own `tsc` and `lint`); `runtime:acceptance`. Both run in `acceptance.yml`, **not** the merge gate. |
| `rest-kit` × monorepo | nothing in `bun test` | `test/emit/server/tools-rest.test.ts`, `fetch-helper.test.ts`, `env.test.ts`, `test/emit/generate.test.ts`, `test/cli-main.test.ts` (the real binary on `zzstandalone`, via `Bun.spawnSync`) | `test/derive/round-trip.test.ts` — `discord`, `zzstandalone` and `zzwriterest` (the rest-kit write path) fully, `google-meet` all files but `README.md` | `diff:golden` (`discord`, `google-meet`). **Does not run in CI.** |
| `rest-kit` × standalone | nothing in `bun test` | `test/emit/generate.test.ts`, `test/cli-main.test.ts` (`--standalone`, real binary) | `test/golden/snapshots.test.ts` against `fixtures/snapshots/zzwriterest/` | `standalone-acceptance` (`zzstandalone`, `zzwriterest`); `runtime:acceptance`. `acceptance.yml`, not the merge gate. |
| `read-only-kit` × monorepo | **`test/emit/emitted-typecheck.test.ts`** — real `tsc --noEmit`, four cases: search-only, stub filter, bespoke `fieldsOf` extractor, conditional query parameter. Each spreads `NIMBUS_COMPILER_OPTIONS` and then overrides `types` and `lib`, a local-only deviation the file names; only the wiring row below uses the constant unmodified | `test/emit/server/read-only-kit.test.ts`, `search.test.ts`, `env.test.ts`, `test/emit/search-filter.test.ts` | `test/derive/round-trip.test.ts` — `mercury`, `netlify`, `zendesk`, `dependencytrack`, `bitrise`, `codemagic`, `intercom`, `lever`, `zzreadonly`, `zzsearch`, `zzsearchstub`, `zzextract` | `diff:golden` (`mercury`, `zendesk`, `bitrise`, `codemagic`, `dependencytrack`, `netlify`, `intercom`, `lever`). **Does not run in CI.** |
| `read-only-kit` × standalone | **nothing, anywhere.** `test/emit/emitted-typecheck.test.ts` runs a real `biome check src/` under the emitted `biome.json` — a **lint**, not a typecheck | `test/emit/server/read-only-kit.test.ts`, `search.test.ts`, `test/emit/search-filter.test.ts` | **nothing.** No read-only-kit fixture declares a write tool, so none has a snapshot; `round-trip` runs at the monorepo target | `standalone-acceptance` (`zzsearch`, `zzsearchstub`, `zzextract`). `acceptance.yml`, not the merge gate. |

**The *substring-asserts* column is target-agnostic where it names a fragment renderer.**
`env.test.ts`, `fetch-helper.test.ts`, `body.test.ts`, `tools-hand.test.ts` and
`tools-rest.test.ts` contain neither the string "monorepo" nor "standalone": each calls a
fragment renderer directly, and those fragments are spliced into both targets. They are listed
against the monorepo rows for brevity, and cover the standalone row of the same style equally.

One emitted artifact is not a style × target cell and belongs beside them:

| Artifact | Compiled by | Executed by | Checked against the real interface by |
| --- | --- | --- | --- |
| `--gateway-wiring`'s sync/mapping pair (`emitWiring`) | `test/emit/emitted-typecheck.test.ts`, against `SYNC_TYPES_STANDIN` | `test/emit/wiring.test.ts` — writes the emitted source to a temp file and imports it, so the skeleton's `throw` is observed rather than inferred | `wiring:conformance` alone. The stand-in is **written here**, so the compile proves internal well-typedness and nothing about Nimbus. |

**One check spans all six cells and fits none of the columns.**
`test/emitted-globals.test.ts` generates every fixture at **both** targets, adds the Gateway
wiring and the branch shapes no fixture reaches, parses each emitted `.ts` file with Babel, and
subtracts every binding a module introduces from every identifier it references. What is left
is what the module expects the world to provide, and it must appear in
`src/validate.ts`'s `RESERVED_IDENTIFIERS`. It is not a compile, a substring assertion or a
byte comparison — it is the standing enforcement of CLAUDE.md's *Reserved identifiers* rule,
and it exists because that list had been kept by hand and had drifted three times.

### How to read the four columns

- **Compiles** means a real TypeScript compiler ran over the emitted file and had to resolve
  its imports. It is the only column that sees a **type** error. It is not the only thing that
  sees a declaration nothing reads: `src/emit/biome-json.ts` emits
  `correctness: { noUnusedVariables: "error" }`, so the standalone `biome check` case catches
  an unread declaration too — which is why `emitted-typecheck.test.ts`'s header scopes its
  "fails four of them" to the `TS6133` diagnostic specifically.
- **Substring-asserts** means `toContain` / `not.toContain` over emitted text. A substring
  assertion cannot see an identifier that is declared and never read, an unbalanced brace, or
  a type that does not fit. That blindness is the reason `emitted-typecheck.test.ts` exists at
  all; its header names the two defects that survived a whole branch behind it.
- **Byte-compares** covers two different things, and the difference matters. Against
  `fixtures/snapshots/` it is a comparison with checked-in ground truth. In
  `test/derive/round-trip.test.ts` it is a comparison of the emitter's output with the
  deriver's re-emission of it — self-consistency, which is strong (it fails on any emitted
  construct the deriver cannot recover) but says nothing about whether the bytes are *right*.
  Only `diff:golden` compares against a real hand-written connector.
- **Outside `bun test`** is where the compiles for the other five combinations live. Of the
  gates named in that column, `diff:golden` and `acceptance` need something CI does not have;
  `standalone-acceptance` and `runtime:acceptance` run in CI but not in the merge gate.

### Why the compile column cannot simply be filled in

`packageImportHead` in `src/emit/server/index.ts` returns `[]` for exactly one of the six
combinations: `read-only-kit` × monorepo. There, `runReadOnlyMcpConnector` in the monorepo's
`shared/` owns the `McpServer` and the stdio transport, so the emitted file's every import
resolves against small stand-ins written in this repository, and `tsc` can reach the checks
that matter.

The other five construct `new McpServer(...)` and `new StdioServerTransport()` directly.
Compiling them would mean stubbing the MCP SDK's surface — asserting against a shape this
project invented, which is how a check ends up green against a fiction. That is the same
reason the standalone case reaches for `biome check` instead: Biome's rules are syntactic and
need no resolvable imports, so it is the strongest gate available on emitted standalone source
without inventing the SDK.

So the gap is structural, not an oversight, and it is closed by installing the real
dependencies — which is what `standalone-acceptance` does, and why the fixture list in
`scripts/standalone-acceptance.ts` names all three styles rather than one.

## What `emitted-typecheck.test.ts` compiles, measured

The file's name promises more than it delivers, and the shortfall was measured, not assumed.

**The probe.** Emit `const zzProbeUnusedLocal: number = 1;` from the non-`read-only-kit`
branch of `wiring()` in `src/emit/server/index.ts` — a guaranteed `TS6133` under
`NIMBUS_COMPILER_OPTIONS`' `noUnusedLocals`, reaching `hand-rolled` and `rest-kit` at both
targets. **Every test in `emitted-typecheck.test.ts` still passes.** The identical line
emitted from the `read-only-kit` path fails the four `tsc` cases *and* the `biome check` case
— Biome's `noUnusedVariables` sees an unread declaration too, which is why that file's own
header scopes its "fails four of them" to the `TS6133` diagnostic specifically.

The full `bun test` does notice the first probe, but every failure it produces is in
`test/derive/` or `test/golden/snapshots.test.ts` — **byte comparisons, without exception**.
Not one of the emit suites' substring assertions moved. A defect that leaves the bytes
derivable therefore passes the entire suite, and one does:

**A second probe.** Emit `export const zzProbeTypeError: number = "not a number";` — a plain
`TS2322` — into `read-only-kit` × standalone `src/server.ts` only. It passes
`emitted-typecheck.test.ts` in full, including the real `biome check`, **and it passes the
entire `bun test` suite with zero failures.** An exported const is read by definition, so no
unused-variable rule fires; Biome has no type information; no snapshot covers that shape; and
`round-trip` runs at the monorepo target. `test/derive/frame-standalone.test.ts` parses that
exact file and recognizes its frame, which is not a byte comparison and does not care.

That is the concrete meaning of the last row of the matrix: **a type error in every
standalone read-only-kit connector this generator emits is invisible to the merge gate.**
`bun run standalone-acceptance` catches it, in `acceptance.yml`.

If you re-run either probe, restore the emitter afterwards and confirm `git status` is clean
before committing.

## What the coverage gate structurally cannot see

`bunfig.toml` sets a **per-file** `coverageThreshold`, not an aggregate one — an average lets
one well-covered file hide an uncovered one. Read that file before touching the numbers; it
explains each at length. Three things it cannot express, each of which has misled someone:

**1. A file no test imports never enters the report at all.** Coverage is measured over
modules the run loaded. A module nothing imports is not at 0% — it is absent, and the per-file
floor has nothing to compare. This is why most harnesses in `scripts/` split into a thin driver
plus a `scripts/_lib/` module: logic left inline behind an `import.meta.main` guard is logic no
floor is measuring. It is a convention, not an invariant — `scripts/snapshot-update.ts` imports
no `_lib` module at all and exports `loadExistingSnapshot` from the driver, and `reach.ts`,
`acceptance.ts`, `runtime-acceptance.ts` and `wiring-conformance.ts` each keep some exported
logic there too. `scripts/_lib/build-spec-doc.ts` and `scripts/_lib/preflight.ts` both state
this in their own headers (`scripts/_lib/build-schema.ts`'s states the *convention*, and its
own second load is a different one — a drift argument about regenerating by two routes), and
`scripts/_lib/preflight.ts` is the sharpest example: `verdict` is the one sentence a reader
quotes back as evidence, and `toCheck` — the PASS/FAIL/SKIP label for each gate — sat in the
driver until it was measured, where a constant `skipped: false` printed four never-run gates as
`PASS` with the whole suite green. Both are in `_lib` now, and both are asserted.

**2. Subprocess execution is invisible.** `src/cli.ts` and `src/prompts.ts` are driven through
`Bun.spawnSync` on the **real binary**, and Bun does not instrument child processes, so every
line `main()` executes reads as uncovered. Spawning the real binary is the better test — it
proves the shipped entry point works, which an in-process call does not — so the two files are
excluded from the **metric**, not from testing. `bunfig.toml` is explicit that the fix for this
is *not* to add in-process tests duplicating the subprocess ones: that moves the number without
adding assurance, which is the false-green pattern this repo keeps removing. Raise the floor
only when a real gap closes, as it did for `src/golden/resolve-root.ts` and
`src/derive/search-filter.ts` — the two that carried 0.88 → 0.90. `src/format.ts` is the file
that then **sets** the floor — alone on lines, but tied exactly by
`src/emit/server/tools-rest.ts` on functions, so both halves have to be re-measured before that
number moves. bunfig explains why format.ts's last eight lines cannot be closed
in-process. `test/coverage-gate.test.ts` pins
the exclusion list at exactly those two, so adding a third is a reviewed change to a test
rather than a quiet edit to a config nobody re-reads.

**3. Files generated into a temp directory and dynamically imported *are* measured.** They are
modules the run loaded, so they enter the report like any other file — and they fall under the
same per-file floor. `test/emit/wiring.test.ts` writes the emitted sync and mapping files to a
temp directory and imports them, and both appear in the `bun test --coverage` table by their
temp path. A future test that generates a partially-exercised file this way would drag the
per-file floor down from a path that is not in the repository.

`bunfig.toml` also carries `pathIgnorePatterns = ["fixtures/**"]`, which is about **test
discovery**, not coverage: the checked-in snapshots include each package's own
`test/sandbox.test.ts`, which imports `@nimbus-dev/sdk/testing` — not a dependency here. The
exclusion is scoped to `fixtures/**` rather than restricting discovery to `test/`, because a
`root` restriction would silently skip any future test placed elsewhere.

## Which gates can lie, and how

Each of these has bitten before. `CLAUDE.md`'s *The gates, and which ones can lie* is the
short form; this is what each one actually does.

### `--registry` and local-checkout mode answer different questions

`standalone-acceptance` has two modes and they are not ranked. Local mode rewrites the emitted
`@nimbus-dev/sdk` dependency to `file:<sdk-root>/sdks/typescript` and answers *"does an
unreleased SDK branch satisfy the contract?"* — a question that stays useful for every future
SDK change, since it can be pointed at a branch that is not on npm and cannot be.

`--registry` leaves the emitted dependency alone and installs from npm. It is the only check
that sees the artifact real consumers get: **a `dist` missing from the published `files` array
surfaces there and nowhere else**, because a local checkout has files the tarball may not.
`modeBanner` in `scripts/_lib/sdk-pkg.ts` prints which question the run answered; reporting a
local run as though it were the registry run is a false green.

A fixture whose declared SDK floor is not yet published reports **`SKIP`, not `FAIL`** — the
registry question is genuinely unanswerable for it, and answering "no" would be wrong. The skip
is narrow by construction: `isUnpublishedFloorFailure` in `scripts/_lib/checks.ts` requires
bun's own unresolvable-range message naming both the exact declared range and
`@nimbus-dev/sdk`, so an outage, a 500, a missing package or a frozen lockfile all still fail.
A skipped run deliberately does **not** print the sentence a fully-verified run prints.

### The generated `test/sandbox.test.ts` proves nothing

`src/emit/sandbox-test.ts` emits it wrapped in
`describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])`, and that variable is set **nowhere in
Nimbus**. So in the monorepo every such test is collected and skipped, on every CI run. "The
generated connector passes its tests" is not an acceptance bar and never has been. The real bar
for a generated package is `tsc --noEmit` + `biome check` + a byte-diff — which is exactly what
`acceptance` and `standalone-acceptance` run.

The `skipIf` is not what happens **in this repository**, and the difference is worth stating
because the two are easy to conflate. The three checked-in copies — `fixtures/snapshots/zzwrite/`,
`.../zzwriteonly/` and `.../zzwriterest/` — are never collected at all: `bunfig.toml`'s
`pathIgnorePatterns = ["fixtures/**"]` keeps them out of discovery, because they import
`@nimbus-dev/sdk/testing`, which is not a dependency here. Discovered, they would **fail** with
"Cannot find module" rather than skip. That exclusion is the one described under *What the
coverage gate structurally cannot see* above.

The file is still emitted byte-for-byte because the real connectors carry it, and
`fixtures/expectations.json` counts it among the files a locked fixture must reproduce.

### `reach` measures the language, not any connector

`bun run reach` derives a spec from each real connector and buckets it into a tier —
`blocked`, `emits`, `server-identical`, `all-identical`. That measures **how much of the corpus
the spec language reaches**. It proves nothing about any individual generated connector that
`diff:golden` does not already prove, and quoting a reach tier as evidence that a connector
regenerates correctly is quoting the wrong number. `bun run reach --baseline` is the useful
form: it fails when a connector *loses* a tier against `fixtures/reach-baseline.json`, keyed on
the git tree of `packages/mcp-connectors` so a corpus that did not change cannot be refused.
Like `diff:golden` it needs the AGPL monorepo.

### `fixtures/expectations.json` can be edited to hide a mismatch

It records, per fixture, **which** files must match — not how many, because a count reports
PASS when a change newly matches one file while breaking another. The harness fails in **both
directions**, so an unexpected improvement fails too, which is what keeps the documented gaps
from going stale. A fixture that cannot match a file omits it from the list, so the gap is on
screen on every run. Editing it to absorb a regression is the one edit that turns this gate
into decoration.

## CI's permanent ceiling

`ci.yml` — the merge gate — runs three commands: `bun test --coverage`, `bun run typecheck`,
`bun run lint`. It is not the only workflow that runs the suite: `sonar.yml` runs
`bun test --coverage --coverage-reporter=lcov` on every push to `main` and every same-repo pull
request, which is exactly why `test/coverage-gate.test.ts` grades the workflow **directory**
rather than `ci.yml` alone — a second workflow running the suite without `--coverage` would
execute it with the per-file floor silently switched off. `acceptance.yml` runs
`standalone-acceptance --registry` and
`runtime:acceptance --registry`, but it is deliberately **not** part of the merge gate and not
a required check: both install from npm, and a registry outage must not red-X a pull request
that changed nothing related. It is also path-filtered to `src/`, `scripts/`, `fixtures/`,
`package.json`, `bun.lock` and its own file, plus a daily schedule.

**Four gates need a checkout of the AGPL-3.0-only Nimbus monorepo and can never run in CI:**

| Gate | The question only it answers |
| --- | --- |
| `diff:golden` | Do the emitted bytes match a real hand-written connector? |
| `reach --baseline` | Has any connector in the corpus lost a tier? |
| `wiring:conformance` | Does the emitted Gateway skeleton still match Nimbus's real `Syncable`? |
| `acceptance` | Does a generated package survive the monorepo's `tsc`, `biome` and README audit? |

This is not fixable, and it is not a backlog item. This repository is MIT and the monorepo is
AGPL-3.0-only; the golden harness reads the monorepo **at runtime** from a path passed on the
command line precisely so that nothing is vendored. See [LICENSING.md](./LICENSING.md).

The tempting fix is refused explicitly, in [CLAUDE.md](../CLAUDE.md)'s *The gates, and which
ones can lie*: **do not add a CI job that skips when the root is absent; a silently-skipping
gate is the failure mode this repo keeps removing.** A job that is green because it did nothing
is worse than a job that is absent, because the absent one is visible.

So what CI proves is: this repository typechecks and lints, its unit and substring assertions
hold, the per-file coverage floor holds, `read-only-kit` × monorepo and the Gateway wiring pair
compile, and the standalone byte snapshots are unchanged. On a path-filtered run it also proves
the three standalone shapes typecheck, lint, build and serve MCP against the published SDK.
What only a local run proves is everything in the table above.

### `bun run preflight`

`bun run preflight --nimbus-root <path>` is the local runner. It executes all eight gates in
order — the four CI-runnable ones first because they are cheapest, the four monorepo ones last,
with `acceptance` last of those on a hard constraint (it generates `zzscratch` into
`packages/mcp-connectors/` and removes it again, and `reach --baseline` refuses to compare
against a dirty tree).

Without `--nimbus-root` it reports those four as **`SKIP`, by name**, keeps them in the report
rather than dropping them, and withholds the sentence a complete run prints. `fullyVerified` in
`scripts/_lib/preflight.ts` is true only when **every** gate passed — computing it as "nothing
failed" would let a skip read as a pass, which is the one bug an aggregator over these gates
must not have. It deliberately does not sniff for a sibling `Nimbus/` checkout, so
"preflight is fully verified" means one thing on every machine.

## Two gaps worth naming

Recorded here rather than implied, because both are places where a green run means less than it
looks like it does. They are also entered in
[ROADMAP § Known limitations](./ROADMAP.md#known-limitations), under *What the byte gates do not
reach*, alongside a third — that `read-only-kit` × standalone is byte-compared nowhere, which is
the last row of the matrix above stated as a limitation. That is the standing list; this is the
measurement behind it.

### No real-connector fixture declares a write tool

Every fixture transcribed from a real Nimbus connector — `newrelic`, `datadog`, `grafana`,
`sentry`, `mercury`, `zendesk`, `bitrise`, `codemagic`, `dependencytrack`, `discord`,
`google-meet`, `netlify`, `intercom`, `lever` — is read-only: not one has a tool with `effect: "write"` or a non-`GET`
`method`. This is a gate, not a claim with a date on it —
`test/fixture-write-tools.test.ts` derives the list from `expectations.json`'s non-`zz` keys and
fails the moment a real-connector fixture stops being read-only.

The consequence: **`diff:golden` has zero purchase on the Stage C emitter paths.** `method`,
`effect`, `body`, `hitlRequired` and the `<local>Send` write helper are exercised only by the
synthetic `zzwrite`, `zzwriteonly` and `zzwriterest` fixtures, which byte-match nothing — no
`packages/mcp-connectors/zz*` directory exists, so `compareFixture` reports every generated
file MISSING and their `fixtures/expectations.json` entries are empty lists. That is a pass
that compared against nothing, by design. What holds those paths in place instead is
`test/golden/snapshots.test.ts` against `fixtures/snapshots/`, `test/derive/round-trip.test.ts`,
and `standalone-acceptance` / `runtime:acceptance`. All real, none ground truth.

### `read-only-kit` + `client-credentials` has no fixture

[SPEC-RULES § OAuth](./SPEC-RULES.md#oauth-client-credentials) documents that
`read-only-kit` accepts a `client-credentials` env entry, emitting the module-scope token
exchange above the `runReadOnlyMcpConnector` call. No fixture declares that pair —
`zzwrite` is `hand-rolled` + `client-credentials`, and every `read-only-kit` fixture uses
`bearer`, `basic` or plain headers.

So it is a real, documented emitter path that `diff:golden` never exercises. The one place it
is checked is the standalone KIT-import ordering case in `test/emit/emitted-typecheck.test.ts`,
whose inline `zzfindinga` spec is `read-only-kit` + `client-credentials` with
`credentialsIn: "basic"` — and per the matrix above, that case is a `biome check`, not a
compile.
