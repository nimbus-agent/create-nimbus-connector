# Corpus reach measurement — design

**Date:** 2026-08-03
**Status:** implemented — see scripts/reach.ts, scripts/reach-baseline.ts and scripts/_lib/reach*.ts
**Roadmap item:** Stage E's final task — *"Raise the measured regeneration coverage of the
94-connector corpus, and publish the number with its method"* — and the measurement half of
Stage F's `--from-connector`.

## The problem

Every reach number this project has published was counted by hand, and
[`docs/ROADMAP.md`](../../ROADMAP.md)'s *Measuring reach* section records three consecutive
wrong answers to a question far narrower than the corpus-wide one: **12** from pattern-matching
helper names, **7** from a line-range script blind to arrow-form extractors, **9** from asking a
structural question when the goal was a semantic one. Each error was a method error, and the
last understated reach by more than half.

The corpus-wide question is the same question with 94 connectors instead of 40 filter files, and
there is no reason to expect a fourth hand count to fare better. Worse, the number is not the
only output being lost: **which shape blocks the most connectors** is what should be choosing
the next stage's work, and today that is chosen by intuition.

This harness answers both mechanically.

## What it is, and what it is not

`bun run reach` derives a spec from each connector in a Nimbus checkout, regenerates, compares
against the real bytes, and prints how far it got — as a report, with an opt-in regression gate.

**It never writes a derived spec to disk.** `CLAUDE.md` states that `fixtures/*.spec.json` are
hand-written *specifically* so that no spec in this repository is extracted from AGPL connector
source. A tool that emitted a spec file an author could commit as a fixture would walk straight
into that; derivation therefore happens in memory and its output is a number, not a file. The
authoring-aid form of `--from-connector` is a separate feature with a separate licensing answer,
deliberately not designed here.

Like `diff:golden` and `wiring:conformance`, it reads the monorepo at runtime from a path and
**cannot run in CI**. It is a local pre-merge instrument. No CI job should be added that skips
when the root is absent.

## The bar

Four tiers per connector. The **headline is `server-identical`**.

| Tier | Meaning |
| --- | --- |
| `blocked` | the totality rule failed — carries its blockers |
| `emits` | spec derived, `parseSpec` **and** `validateSpec` accept, `generate()` returns files |
| `server-identical` | the emitted `src/server.ts` byte-matches the real one — **headline** |
| `all-identical` | every emitted file byte-matches |

`server.ts` is the headline because every emitter risk lives in that file. `all-identical` is
reported but cannot be the headline: it is permanently capped by gaps no spec field can close —
hand-authored READMEs and `*-mapping.ts` bodies, both recorded under
[Known limitations](../../ROADMAP.md#known-limitations) — so it would measure content gaps rather
than the spec language.

`validateSpec` sits inside `emits` deliberately. A derived spec that trips
`RESERVED_IDENTIFIERS`, or the at-most-one-extractor rule, is genuinely not generatable today,
and counting it as such is what separates *expressible* from *generatable* — the distinction the
roadmap currently draws in prose for `readwise` alone. This harness draws it mechanically for
all 94.

**No number is predicted here.** `bun run reach` is the answer, and a design document that
guesses at it would go stale silently — the same rule the roadmap applies to itself.

## Architecture

Follows the `diff:golden` split, for the reason `scripts/_lib/golden-diff.ts`'s header gives:
`bunfig.toml` enforces `coverageThreshold` **per file**, and Bun reports a file the moment a test
imports it, so everything a test touches must be decidable from its arguments.

This is the plan-of-record, not as-built — see the *Status* line above and the executed plan's
own post-execution note. What actually shipped:

```text
scripts/reach.ts               thin shell: args, resolve root, enumerate, print; import.meta.main guarded
scripts/reach-baseline.ts      rewrites the baseline; its own strict arg parsing (--nimbus-root
                                only — no scoped-baseline flag exists to honor), shares the
                                measurement pipeline with scripts/reach.ts
scripts/_lib/reach.ts          tiering, verdict lines, histogram — pure, tested
scripts/_lib/reach-baseline.ts baseline build/compare and the refusals around it — pure, tested
scripts/_lib/derive/
  ast.ts                        @babel/parser wrapper — shipped in place of the planned parse.ts
  claims.ts                     the claim-tracking walker — shipped in place of the planned parse.ts
  blockers.ts                   blocker kind/detail formatting
  manifest.ts                   spec fields recoverable from nimbus.extension.json
  server/args.ts                 \  one recognizer module per src/emit/server/ module this plan
  server/env.ts                   \ actually built a recognizer for, named to match
  server/fetch-helper.ts          /
  server/path-template.ts        /
  server/tools-hand.ts          /
  server/index.ts               frame recognition — the hand-rolled McpServer/registrar/
                                 transport/connect wiring src/emit/server/index.ts's wiring() writes
  index.ts                     deriveSpec(files) -> Derivation
fixtures/reach-baseline.json   per-connector tier + the connectorsTree it was measured against
```

**Not built — plan 2's territory:** `server/body.ts`, `server/query.ts`, `server/search.ts`,
`server/tools-rest.ts`, and a top-level `search-filter.ts` (recognizers for
`src/emit/search-filter.ts`). No recognizer in this plan derives a spec through those emitter
paths; a connector that uses them blocks today, by design — see *No escape hatch* below.

Plan 2 is [`2026-08-04-completing-the-recognizer-set-design.md`](./2026-08-04-completing-the-recognizer-set-design.md).

**~~The deriver lives under `scripts/_lib/`, not `src/`.~~ Superseded — it lives under
`src/derive/` and ships.** `package.json`'s `files` is `["src", "README.md"]`, so anything under
`src/` ships to npm; a dev-only deriver there would put unreachable code and an unresolvable
`@babel/parser` import into every published tarball. That reasoning expired when `--from-connector`
made the code reachable: it moved to `src/derive/` deliberately, and `@babel/parser` is an
`optionalDependency` that `src/derive/ast.ts` imports dynamically, so a consumer without it loses
that one flag and nothing else. The current rule is in
[`.claude/commands/cnc-reach-deriver.md`](../../../.claude/commands/cnc-reach-deriver.md); struck
rather than deleted, per this document's amend-don't-rewrite convention.

Only `src/server.ts`, `src/search-filter.ts` and `nimbus.extension.json` get recognizers. The
other emitted files — `README.md`, `package.json`, `tsconfig.json`, `biome.json`,
`test/sandbox.test.ts` — carry no spec information that is not already recoverable from those
three, so they need none. They participate in the `all-identical` tier only.

**One recognizer module per emitter module, named to match.** This makes the coupling reviewable:
a pull request that adds a path to `src/emit/server/tools.ts` without touching
`scripts/_lib/derive/server/tools.ts` is visibly incomplete, rather than surfacing months later
as a number that drifted down for no stated reason.

### Parser

`@babel/parser`, as a **devDependency**. MIT, pure JavaScript, no runtime dependencies and no
native binary. Called as
`parse(source, { sourceType: "module", plugins: ["typescript"] })` — connector source carries
type annotations and generics, which the base parser rejects outright. No `jsx` or `decorators`
plugin: neither appears in the corpus, and a plugin list longer than the syntax in play only
widens what parses without widening what is recognized.

The existing `typescript` devDependency cannot do this: it is `^7.0.2`, the native port, and it
exposes no AST — `createSourceFile`, `SyntaxKind` and `forEachChild` are all `undefined`.
Verified, not assumed.

A regex or line-range scanner is ruled out by evidence rather than taste: two of the three wrong
counts came from exactly that, and the roadmap names the mechanism — *"a check for `String(`
also matches inside `nestedString(`, and a check for `.join(` fires on helpers that are exact
re-implementations of `tagText`."*

## The deriver

```ts
type Blocker = { kind: string; detail: string; line: number };
type Derivation =
  | { ok: true; spec: ConnectorSpec }
  | { ok: false; blockers: Blocker[] };
```

**Claiming.** Each matcher recognizes one construct the emitter can produce, claims the statement
subtree it recognized, and returns the spec fields that would have produced it. Statement
granularity is the unit because statements are what the emitter writes.

A claim is a **`[start, end)` byte range** taken from the Babel node, not a statement index. Two
consequences, both required rather than incidental:

- **A matcher may claim several statements at once**, which it must, because the emitter writes
  multi-statement constructs: the hoisted argument consts that precede a handler, the
  `const u = new URL(...)` / `u.searchParams.set(...)` / return trio of the query branch, and the
  `token` / `cachedToken` / `tokenExpiresAt` bindings the client-credentials branch emits
  together. A matcher that could only claim one statement would leave the others unclaimed and
  fail every connector using those branches.
- **Coverage is containment, not identity.** A statement is covered when its range lies inside
  some claimed range, so nested statements inside a claimed arrow-function body need no separate
  claim, and the walker needs no notion of which list a node came from.

**The totality rule.** After every matcher has run, walk each top-level and function-body
statement in `src/server.ts`. Any statement not covered by a claim fails the connector. **There
is no ignore-the-rest path.** This is the whole difference between this harness and the method
that produced 12, then 7, then 9: a scrape is silent about what it does not recognize, and
silence reads as absence. The totality rule converts every unrecognized construct into a visible
blocker, which caps the reported number at what can actually be proven.

The cost is accepted knowingly: the first number this prints will be **lower** than a scrape
would report, and that is the point.

**Blockers are discovered, not enumerated.** An unclaimed statement's `kind` is a normalized
descriptor of its syntactic head — `import-from:./tools.ts`, `call:makeQueryFilter`,
`method-call:.join`, `member-call:searchParams.append`. The histogram is a group-by over those
strings. Nothing needs to know in advance that "multi-file" and "CLI-backed" are categories; they
emerge as `import-from:./tools.ts` and `call:safeCliArg`. A shape nobody has named yet appears as
its own bucket instead of vanishing.

**Near-misses stay visible.** When a statement fails to claim, the blocker's `detail` records the
offending sub-expression, so an inlined default like `p.pageSize ?? 50` lands in the histogram as
its own bucket rather than inside a general "unknown" pile. The rule is not weakened; the report
is made specific enough to act on.

### No escape hatch

There is no "hand-written block" claim, and there will not be one. A connector whose
`src/server.ts` contains a construct the spec language cannot express **is** blocked, permanently
if the construct is one this generator has declined to support — `zoom`, which does not use
`makeQueryFilter` at all, is the clearest case. That is not a shortcoming of the measurement; it
is the measurement. An escape hatch would let unrecognized code count as recognized, which is the
same silence the totality rule exists to remove, reintroduced under a friendlier name.

This does mean the histogram mixes two populations: constructs the spec language could grow to
express, and constructs it never will. **The harness does not attempt to separate them**, because
that separation is a judgement recorded in `docs/ROADMAP.md`'s *Known limitations* and *Considered
and declined*, and a copy of it in code would go stale exactly the way a restated number does.
Reading the histogram against those two lists is the maintainer's step, and it is a short one:
the buckets are named after the constructs those sections already name.

The corollary is worth stating plainly, since it sets expectations for anyone trying to move the
number: `server-identical` is not a tier every connector can eventually reach. Some are
permanently blocked, by decisions already made and written down.

## Output

```
bun run reach [--nimbus-root <path>] [--baseline] [--verbose] [names...]
bun run reach:baseline [--nimbus-root <path>]
```

Default output is the tier summary and the blocker histogram. Per-connector lines print only when
names are given, under `--verbose`, or for regressions under `--baseline` — a 94-line dump by
default is a report nobody reads twice.

**It reuses `checkBiomeVersion`.** This harness byte-compares, so it inherits `diff:golden`'s
dependency on the formatter matching the one the monorepo used: the same banner, the same
warning, and the same hard failure when Biome is unavailable, because unformatted output would
produce spurious diffs indistinguishable from reach regressions.

Formatting costs nothing worth designing around, and the reason is worth recording so it is not
re-litigated: `formatAll` does **not** shell out. `src/format.ts` loads `@biomejs/js-api` with the
`@biomejs/wasm-nodejs` backend once, in-process, and calls `formatContent` on strings — no child
process, no CLI, no temp files. Scaling from `diff:golden`'s fixtures to 94 connectors multiplies
the number of in-process calls and nothing else.

## The baseline

`fixtures/reach-baseline.json` records each connector's tier and `connectorsTree` — the tree
object of `packages/mcp-connectors`, obtained with `git -C <root> rev-parse
HEAD:packages/mcp-connectors` — **not** the Nimbus commit. That was the plan-of-record key, and
implementation refused it: keying on `HEAD` made `--baseline` refuse a corpus that had not moved
the moment the commit did — a merge, a revert, or an unrelated change elsewhere in the monorepo
all move `HEAD` while leaving `packages/mcp-connectors` byte-identical. Keying on that
subtree's own object id means two different commits that happen to carry the same
`packages/mcp-connectors` compare cleanly, which is the actual invariant this harness needs:
same bytes measured, same baseline valid, regardless of which commit produced them.

`--baseline` compares and exits non-zero on any tier regression. **Comparing across trees is
refused, not warned about** — a verdict spanning two corpora is precisely the false green this
repository is organized against. If the root is not a git checkout, `--baseline` and
`reach:baseline` both refuse; the plain report still works.

**`--baseline` always compares the full corpus, never a subset.** Combining it with connector
names on the command line is refused rather than honored: `compareBaseline` reads every
baselined connector absent from the current run as having regressed to `blocked`, so scoping the
run while comparing against the full baseline would invent regressions for every connector left
out, not report a smaller true result. There is no scoped-baseline format that would make
"regressed" mean the same thing across both a full and a partial run, so this refuses instead of
inventing one. The same reasoning makes `reach:baseline` (which always writes the FULL corpus)
refuse any argument besides `--nimbus-root`, rather than silently ignoring one.

**A dirty checkout is refused on the same grounds.** A commit SHA describes a tree, and if the
working tree differs from it, the baseline would file measurements of bytes that exist nowhere
under a SHA that claims otherwise — a false green with a paper trail, which is worse than no
record. Both `--baseline` and `reach:baseline` refuse when
`git -C <root> status --porcelain -- packages/mcp-connectors` is non-empty.

Scoped to that path deliberately: it is the only tree this harness reads, and refusing on
unrelated dirt elsewhere in the monorepo — a stray build artifact, an in-progress change to the
gateway — would make the gate annoying enough to be worked around, which is the failure mode that
ends with someone passing `--force`.

The file follows `fixtures/expectations.json`'s rule: it is re-baselined when the corpus moves,
never edited to make a run pass.

## Testing

The centrepiece is a hermetic round-trip that needs no checkout and **runs in CI**:

> For each `fixtures/*.spec.json`: `generate(spec)` → feed the **emitted** `src/server.ts` back
> through `deriveSpec` → assert it derives, and that `generate(derived)` is byte-identical to
> `generate(spec)`.

That gives the deriver a corpus covering every emitter path, composed entirely of bytes this
repository wrote — no connector source in `test/`, consistent with why
`test/emit/emitted-typecheck.test.ts` compiles against a stand-in written here.

It also converts the recognizer-tracks-emitter coupling from a convention into a failing test:
add an emitter path without its recognizer and the round-trip breaks on whichever fixture
exercises it — and "every emitter path is exercised by a fixture" is already this repository's
rule.

Around it:

- per-matcher unit tests over hand-written TypeScript source strings **authored here**
- totality-rule tests asserting an unclaimed statement yields the expected blocker `kind`
- pure tests for tiering, verdict lines, the histogram, and baseline comparison — including the
  SHA-mismatch refusal and the empty-set refusal

## Failure handling

One malformed connector must never abort a 94-connector run. A parse error, a missing
`src/server.ts` and a missing `nimbus.extension.json` each become a `blocked` verdict with kind
`parse-error`, `no-server` or `no-manifest` — visible in the histogram, not a stack trace.

Two conditions halt the run instead: Biome unavailable, and an empty connector set, which throws
rather than reporting a vacuous pass, exactly as `selectFixtures` does today.

## Consequences for other documents

- `docs/ROADMAP.md` Stage E's final task becomes satisfiable, and *Measuring reach* gains a
  method that is a command rather than an essay. The three wrong-number post-mortems stay: they
  are why the totality rule exists.
- `docs/ARCHITECTURE.md` gains `reach` in the harness list, marked — like `diff:golden` and
  `wiring:conformance` — as unable to run in CI.
- `CLAUDE.md`'s gate table gains a row stating what `reach` proves and what it does not: it
  measures the spec language's coverage of the corpus, and proves nothing about any individual
  generated connector that `diff:golden` does not already prove.

## Explicitly out of scope

- **Writing a derived spec to disk.** Separate feature, separate licensing answer.
- **Typechecking the 94 generated packages.** The `emits` tier stops at `generate()` returning
  files. A package that emits but fails `tsc` is a generator bug, and `diff:golden` already
  catches those on the fixtures — paying minutes per run, plus the monorepo's installed
  dependencies, to restate that would make the harness too expensive to run casually, which is
  how an instrument stops being used.
- **Deriving Gateway sync files.** A non-goal of the generator itself.
