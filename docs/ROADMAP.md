# create-nimbus-connector — Roadmap

`create-nimbus-connector` is the **MIT-licensed generator** for Nimbus MCP connectors. You
describe a connector as a small JSON spec; it emits a package that is byte-identical to what a
Nimbus author would have written by hand.

**North star:** make writing a Nimbus connector a *specification* task rather than a copying
task — for first-party and third-party authors alike, in any language Nimbus supports, with
the generated result provably indistinguishable from a hand-written one.

The gateway's product sequencing lives in the
[Nimbus roadmap](https://github.com/nimbus-agent/Nimbus/blob/main/docs/roadmap.md); the
authoring contract's lives in the
[SDK roadmap](https://github.com/nimbus-agent/nimbus-sdk/blob/main/docs/ROADMAP.md). This
document owns everything generator-shaped.

> **How to read this.** The **[pillars](#pillars)** are the durable areas of investment — the
> *what* and *why*. The **[stages](#stages)** are the execution plan, in order. Stages are
> ordering, not dates. Tasks are `[ ]` not started, `[~]` in progress, `[x]` done.
>
> **Measured results are deliberately not repeated here.** Fixture counts and pass rates move
> with the corpus, and a roadmap that restates them goes stale silently. `bun run diff:golden`
> is the live answer; [known limitations](#known-limitations) records the durable gaps.
>
> **The rule is about undated numbers, not about numbers.** [The measured ceiling](#the-measured-ceiling)
> states the corpus regeneration counts, with the date and the `packages/mcp-connectors` tree they
> were measured against; it is the only place in this *document* that does. A handful of source
> comments carry a measurement too, because the measurement is the rationale for the choice above
> it and deleting it would leave a decision with no stated reason. **A measurement should state its
> date, its tree, and the command that re-measures it** — a number carrying those can be checked;
> one without them is what the rule above forbids.
>
> **That is the standard, not a description of the tree.** This paragraph used to name
> `src/emit/wiring.ts`, `src/spec.ts` and `test/derive/frame.test.ts` as "the three" source
> comments carrying a measurement. A sweep found dozens across the repository, most of them
> undated, and `src/spec.ts` alone carries several — so the sentence was wrong about its own
> subject while stating the rule that forbids exactly that. It is no longer a count, and the
> inventory now lives where it can go red: `test/measurement-hygiene.test.ts` holds every file
> still carrying an undated measurement, refuses a new one, and refuses an entry that has been
> cleaned up but left in the list. **What it cannot do is tell a current number from a stale one**
> — nothing can, short of re-running the measurement, and both failures that prompted it were
> stale figures in comments that already existed.

---

## Pillars

### 1. Fidelity — the output is indistinguishable from hand-written

The generator earns trust by reproducing real connectors byte-for-byte, diffed against a live
Nimbus checkout. Where a diff is irreducible it becomes one of two things: a spec field the
template must expose, or a documented limitation that stays on screen. It never becomes an
edited expectation file.

This is also the pillar that constrains the others. `newrelic`, `datadog`, `grafana` and
`sentry` are locked at 6/6 files, and every new emitter path must be gated on a field those
four never set.

### 2. Coverage — the spec language reaches the whole corpus

Each stage has added a shape the previous one could not express: writes and HITL, OAuth
client-credentials, the `read-only-kit` registration style, search tools. The corpus is the
backlog, and the honest measure of coverage is how many of the 94 connectors could be
regenerated from a spec — not how many features the spec language has.

### 3. Honest verification — no gate that passes while asserting nothing

The strongest checks here exist because a weaker version of them was vacuous. Generated
`sandbox.test.ts` files skip on every CI run; the registry and local-checkout acceptance modes
answer different questions and one must never be reported as the other. Every gate states what
it proves and what it does not. This is a permanent pillar, not a phase.

### 4. Reach — third parties, not just the monorepo

Standalone generation makes a connector that runs anywhere with no Nimbus checkout, resolving
its helpers from the published SDK. The direction of travel is that an external author's
experience is the *default* one rather than the second target.

### 5. One scaffolder for the org

Today two tools scaffold Nimbus connectors. This one converges with and replaces the other —
see [Consolidation](#consolidation).

---

## Consolidation

The org currently ships two connector scaffolders: this one, and
[`@nimbus-dev/create-connector`](https://github.com/nimbus-agent/nimbus-sdk/tree/main/tools/create-connector)
in the SDK repository, which templates a greenfield TypeScript or Python project from fixed
templates rather than emitting source from a spec.

**The intent is that this repository becomes the single scaffolder** and
`@nimbus-dev/create-connector` is eventually retired. Two tools with near-identical names is a
choice users should not have to make.

That is a destination, and it has a price: **four preconditions**, only one of which is a
checkbox on this side. One is an emitter change this repository could make, one is a thing this
repository has decided not to do, one belongs to the SDK repository, and one is owned by
neither. What each is, what it costs, what it blocks and — since each rests on another
repository's state — the commit and date it was last checked against are in
**[CONSOLIDATION.md](./CONSOLIDATION.md)**, which also carries the side-by-side comparison of
the two tools.

Until they are met, both tools ship and the READMEs cross-link so an author can tell which one
they want. **Nothing here is a deprecation announcement**; it is a stated direction with its
conditions attached.

---

## Stages

### Stage A — monorepo-internal generation `[x]`

The generator, the six-file tree, `--dry-run`, and the golden-fixture diff harness.

### Stage B — standalone generation `[x]`

Connectors that run outside the monorepo, resolving helpers from
`@nimbus-dev/sdk/connector-kit`; the standalone acceptance harness; published to npm.

### Stage C — writes, HITL and OAuth `[x]`

`method`, `effect` and `body`; `hitlRequired` in the manifest; `client-credentials`; the
Gateway wiring skeleton and its conformance script.

### Stage D — the `read-only-kit` style and search tools `[x]`

The registration style 60 of the 94 connectors use, and search tools with their seventh emitted
file, `src/search-filter.ts`. The search kit shipped in `@nimbus-dev/sdk` 1.15.0, so
`standalone-acceptance --registry` verifies the search fixtures against the published artifact
rather than skipping them.

### Stage E — the corpus tail `[~]`

The shapes still unreachable, each already measured and documented as a limitation rather than
discovered later.

**Half-closed, stated accurately.** The stage's measurement half is done — the deriver is a
complete inverse of the emitter, every fixture round-trips, and every blocked corpus connector
has a named cause. The *raising* half is not: three bullets below are still `[ ]`, and the
headline count did not move. See [The measured ceiling](#the-measured-ceiling) for the number,
its denominator and which of those causes are permanent.

**An open bullet here is also a limitation today, and appears under
[Known limitations](#known-limitations) as one.** That pairing is deliberate, not a duplicate: the
two sections answer different questions — *what is planned* and *what an author will hit this
afternoon* — and deleting either entry leaves a reader who checked the wrong section with the wrong
answer. What is forbidden is **describing the construct twice**, because two descriptions drift and
the shorter one is trusted without being checked. So each construct is described in one place and
linked from the other: this stage owns the three still-open constructs and `query`'s closed
history, while *Known limitations* owns what `query` still does not reach, and the `[x]` bullet
points there rather than restating it. Which section owns a given construct is settled by where the
measurement lives, not by which is more prominent.

**A limitation with no bullet here is one no bullet would help** — a deliberate divergence, a rule
chosen over a spec field, or a gap this repository cannot close alone. That is a statement about
the individual entry and not about its category: `frame:tools-in-second-file` has a bullet below
and `frame:no-registrar` does not, though both are frame gaps and *The measured ceiling* groups
them on one row.

- [~] **Bespoke field extractors.** `filter.fields` now takes plain keys, `path` entries and
      tag entries, composing the primitives `shared/search-filter.ts` already exports instead
      of always emitting a throwing stub. Measured against the checkout at `f4e9d93d`, of the
      40 corpus filter files that hand-write an extractor, **26 can be expressed** and **14
      cannot** — "expressed" means the entry kinds can state the field list, not that the
      generator can actually emit the file. `readwise` is one of the 26 by that measure, but
      `src/validate.ts` separately rejects it because it declares two extractor-taking filters
      (`fieldsOf` and `bookFieldsOf`), and this generator allows at most one per connector (see
      [Known limitations](#known-limitations)). So **25** of the 26 are generatable today. The
      method, and why an earlier count said 9, are in [Measuring reach](#measuring-reach).

      Of the 26: **22** produce an identical haystack; **3** (`prefect`, `readwise`, `ramp`)
      differ only in whitespace. For `prefect` and `ramp`, a local helper filters empty parts
      before joining where the shared entry does not — `ramp` is the one where that is
      observable, since a query spanning an absent middle field would match the hand-written
      filter and not the generated one. `readwise` runs the opposite direction: its local
      `tagNames` does *not* filter empty parts, while the shared `tagNamesFromObjects` filters
      `name !== ""`, so there the generated haystack is the narrower one. **1** (`stackoverflow`)
      rests on an API assumption this repository cannot verify, and drops out if it is wrong.

      The 14 that cannot each have a named cause: a join over a non-`tags` array (`snyk`,
      `airflow`, `greenhouse`, `mendeley`, `wiz`), a numeric coercion (`databricks`, `dbt`),
      an alternate tag shape (`dagster` reads key *and* value, `zotero` reads `tag["tag"]`,
      `intercom` nests at `row.tags.tags[]`, `flagsmith` maps numbers through `String`),
      a conditional array search (`flux`), a per-item concatenation (`mlflow`), and `zoom`,
      which is hand-rolled and does not use `makeQueryFilter` at all.

      See [Known limitations](#known-limitations) for the separate question of byte-matching,
      which only `dependencytrack` currently achieves.
- [~] **Multi-file connectors.** **16** connectors carry `src/tools.ts` (e.g. `elasticsearch`,
      `storybook`) and `server.ts` imports it in 15 of them; the generator assumes one source
      file. Carrying the file and being *blocked by* it are different questions, and the answer
      is now the sharper of the two: the ones that are pure shims report as
      `frame:tools-in-second-file` under `bun run reach --verbose`, rather than as an
      `import-from:./tools.ts` statement blocker plus a per-connector `call:register<X>Tools`
      one. **How many is in [The measured ceiling](#the-measured-ceiling)**, with its date and
      corpus tree, rather than restated here where it would go stale unmarked. The label does
      **not** come from `recognizeFrame`, which *succeeds* for every one of them — they are a
      well-formed read-only-kit frame. It comes from `collapseSecondFileBlockers` (`src/derive/index.ts`),
      called from `deriveSharedStyleSpec` at the totality rule, after the env, fetch-helper and
      tool recognizers have already run. Those recognizers find nothing to do, because a shim's
      `src/server.ts` is nothing but the frame plus those two statements — so the unclaimed set
      is exactly the pair, and the label collapses it into the one thing the pair shares. The
      `frame:` prefix names the ceiling, not the stage that detected it.

      **Measured, and the answer closes the bullet.** `src/derive/server/second-file.ts` splices
      the registrar body out of `src/tools.ts` and the totality rule walks that file's remaining
      module-scope statements, so these connectors now report what is actually behind the frame.
      All eleven splice with zero refusals, and behind the frame are `zod` and `mcp-tool-kit.ts`
      value imports, hoisted helpers (`isRecord`, `strField`, `asArray`) and unrecognized
      registrations — every one a spec-language gap the emitter split would not touch. The
      headline `server-identical` count did not move, exactly as predicted. The histogram, with
      its date and corpus tree, is [The measured ceiling](#the-measured-ceiling); the decision it
      informed is in [Considered and declined](#considered-and-declined).

      **So the emitter split is not being built, and this bullet stays `[~]` rather than becoming
      `[x]`.** The measuring half is done and the raising half is declined, which is not the same
      as finished — five of the eleven are the CLI-backed connectors this stage lists separately,
      and their blockers are real work whoever wants it.

      **A real shim can still block, just under a different bucket.** `recognizeEnv`,
      `recognizeFetchHelper` and `claimSearchImports` all read `frame.verifyStatements`, which is
      `src/server.ts`'s alone — `applySecondFile` hands `src/tools.ts`'s own statements back
      separately, as `ForeignStatements`, walked against their own claim set. A shim whose fetch
      helper or env accessor is written in `tools.ts` rather than `server.ts` is therefore not
      unblocked by this change: its blocker moves from the collapsed `frame:tools-in-second-file`
      label to whatever `blockerFor` says about that statement in `tools.ts`'s own coordinates.
      Whether the corpus's sixteen behave that way, or turn out to be pure shims after all, is
      part of the same unmeasured number above.
- [x] **Conditional query parameters.** A `query` array on a tool — `new URL(...)` plus
      guarded `searchParams.set(...)`, the guard chosen by `omitWhen` — lets a parameter be
      sent only when an optional argument is present or non-empty. See
      [SPEC-RULES § Conditional query parameters](./SPEC-RULES.md#conditional-query-parameters-query)
      for the field and its rejections, and [Known limitations](#known-limitations) for what it
      still doesn't reach.
- [~] **Conditional endpoint selection.** `pathWhen` — an ordered array of `{ absent, path }`
      guards, with the tool's own `path` as the unguarded fallthrough — now exists in the spec
      language (`src/spec.ts`), is emitted as a guard ladder (`renderTool`, in
      `src/emit/server/tools-hand.ts`) and is read back by `recognizeConditionalPath`
      (`src/derive/server/conditional-path.ts`). Both halves are built **for read tools**, and
      both fixtures that exercise them (`zzcond`, `codemagic`) round-trip. A ladder over the
      *write* helper is emitted but deliberately never read back — see
      [Known limitations](#known-limitations) for why that asymmetry is a refusal rather than a
      gap. **The headline count did not move.**

      **The design predicted `codemagic` would go `blocked` → `server-identical`, taking the
      headline 6/94 → 7/94. It did not.** Measured 2026-08-09 against `packages/mcp-connectors`
      tree `67c7390a`: `bun run reach` still reports **6/94**, and `codemagic` is still `blocked`
      on `call:reg`. The prediction is recorded rather than deleted — it was written down in
      advance so that it could be wrong in public, and what it got wrong is the useful part.

      **The whole of the miss is one statement's position.** `codemagic_list` declares a
      defaulted `limit`, and the real connector writes `const limit = p.limit ?? 50;` *after* its
      guard, where the guarded branch (`/apps`) has no use for it. `renderTool` writes every hoist
      before the ladder, and `splitHoists` (`src/derive/server/hoists.ts`) takes a hoist run only
      off the *front* of a handler block — so the emitted bytes differ by those two lines, and the
      deriver refuses the rung run outright rather than reading a shorter ladder. Nothing else
      about the connector's `src/server.ts` is unreached:
      `bun run diff:golden` reports it identical apart from those two lines, both ladders, the
      search tool, the `x-auth-token` accessor and the `CODEMAGIC_API` fetch helper included. The
      isolation is exact rather than inferred — moving that one statement in a *generated* (MIT)
      `codemagic` reproduces the real connector's blocker report label-for-label and line-for-line
      (`call:reg` at lines 27, 45, 60, plus the two downstream search imports).

      **The byte diff is a wider claim than the tier, and the two must not be conflated.**
      `codemagic` reports **5/7**, not 6/7, because `README.md` is hand-written prose as well —
      the [*Hand-authored READMEs*](#known-limitations) gap `mercury`, `zendesk` and `bitrise`
      carry too, independent of this one and untouched by closing it. Closing the placement rule
      is worth `codemagic` 5/7 → **6/7**; it is not worth 7/7.

      **And it is worth no tier at all — closing it would not have made the prediction come
      true.** A tier is decided by *derivation from the real connector*, and derivation halts at
      `call:reg` and the two search-tool imports long before any byte is compared. Measured
      2026-08-10 against `packages/mcp-connectors` tree `67c7390a`:
      `bun run reach --verbose codemagic` reports the same three blockers on this
      branch and on `main` — `call:reg`, `import-from:../../shared/mcp-search-tool.ts`,
      `import-from:./search-filter.ts` — so reading the guard ladder changed `codemagic`'s
      blocker report not at all. The placement rule is a **byte-diff** gap sitting downstream of
      a blocker that fires first. The prediction was wrong about which constraint was binding,
      not merely about a line's position; `codemagic` needs the search-tool frame before the
      ladder can matter to reach.

      **Closing it is a placement rule in both halves, and it is worth one connector.** The
      emitter would have to write a hoist after the ladder when no guard's path reads it, and
      `recognizeConditionalPath` would have to accept a hoist run between the last rung and the
      fallthrough. Measured 2026-08-09 against tree `67c7390a`, **3** corpus connectors place a
      defaulted-argument hoist after a `=== undefined` guard in the same block — `codemagic`,
      `snyk` and `sonarqube` — and both of the others are independently blocked several times over.
      Re-checked 2026-08-14 against tree `23c90b92`, after the auth-expressiveness work removed
      `function:authHeader` from `snyk`: `snyk` still reports `call:reg`, both search-tool imports
      and `function:snykPost`, and `sonarqube` reports `call:reg`, both search-tool imports,
      `statement:VariableDeclaration`, `function:apiBase` and `function:stripTrailingSlashes`. So
      the rule moves `codemagic`'s byte diff and nothing else — and no connector's tier. Not built
      here: it is a change to what the emitter writes, gated on a spec field, for one connector.
- [x] **The env `Authorization` shapes the `auth` modes could not state.** Four constructs, all
      `env[]` fields, all emitted and read back, and only the first two of them bearer's:
      `authScheme` (the scheme word, replacing the literal `Bearer`, and bearer-only), and
      `extraHeaders` (static literal-valued headers between the auth entry and the trailing
      `Accept`, valid under `bearer`, `basic` and `headers` alike). The other two are not header
      shapes at all: a `tokenLocal` no longer restricted to bearer — it splits the READ into its
      own accessor, and is valid on any single-var entry declaring an `auth` mode — and
      `auth: "basic"` accepting one var as well as two, the one meaning a literal `""` password.
      See
      [SPEC-RULES § Env auth](./SPEC-RULES.md#env-auth-authscheme-extraheaders-tokenlocal-and-one-var-basic)
      for each field's rejections and the corpus measurement under it.

      **`fixtures/intercom.spec.json` and `fixtures/lever.spec.json` reproduce those connectors'
      `src/server.ts` byte-for-byte**, which is what the constructs bought;
      `fixtures/zzauth.spec.json` is the synthetic that exercises the combinations no real fixture
      does. **The headline `server-identical` count did not move**, against a written prediction
      that it would go 6/94 → 8/94 — [The measured ceiling](#the-measured-ceiling) records the
      prediction, the measurement and why a one-bucket blocker report was the wrong evidence to
      predict from. Marked `[x]` on the constructs, which are complete; the raising half of this
      stage stays open on the `[~]` bullet below.
- [ ] **Enum arguments, and the two other shapes `bitrise`'s ladders carry.** `bitrise_list` maps
      a `z.enum` through a lookup table (`{ "not-finished": 0, … }`) into a `params` array, and
      the construct does not exist in the spec language. Two smaller shapes sit alongside it and
      are why `pathWhen` does not reach `bitrise` even setting the enum aside: `bitrise_list`'s
      guard consequent holds *two* statements (its own `const limit` before the return), where
      the emitter writes one; and `bitrise_get`'s fallthrough binds `const path = …` and passes
      the binding, where the emitter inlines the path expression. Both tools stay `impl: "stub"`
      in `fixtures/bitrise.spec.json`.
- [ ] **CLI-backed connectors, and both sets now surface.** Nine connectors shell out instead of
      calling `fetch`, in two shapes that used to report very differently:

      | Shape | Bucket | Connectors |
      | --- | --- | --- |
      | `shared/safe-cli-arg`, from `src/tools.ts` | `import-from:../../shared/safe-cli-arg.ts` | `athena`, `cloud-logging`, `cloudwatch`, `sagemaker`, `vertex-ai` |
      | `shared/run-cli-json`, from `src/server.ts` | `import-from:../../shared/run-cli-json.ts` | `aws`, `azure`, `gcp`, `kubernetes` |

      **This bullet used to say the first construct "is never reached"** — true when the deriver
      stopped at `frame:tools-in-second-file` and never opened the second file, and false as of
      the 2026-08-09 measurement, which is what reading `src/tools.ts` changed. The five are now
      reported under the same kind of bucket as the four, so the construct can be counted rather
      than inferred. Recorded rather than quietly corrected, because the claim was invalidated by
      this repository's own change and the next reader deserves to know a sentence here moved.

      Nothing about the *gap* changed: shelling out is unexpressible in the spec language either
      way, and closing it means a spec construct for a subprocess call plus an emitter path for
      it — not a recognizer.
- [~] Raise the measured regeneration coverage of the 94-connector corpus, and publish the
      number with its method. **The publishing half is closed; the raising half is not, and
      this bullet stays `[~]` for that reason rather than being marked done.** The method is no
      longer a hand count: `bun run reach --nimbus-root <path>` derives a spec from every real
      connector's `src/server.ts` and `nimbus.extension.json`, runs it through the same
      `parseSpec` → `validateSpec` → `generate()` pipeline the CLI uses, and reports a tier
      histogram plus the connectors blocking each tier. `bun run reach:baseline` records a
      per-connector snapshot in `fixtures/reach-baseline.json`; `bun run reach --baseline`
      fails when a connector regresses a tier against it. The number itself, with its date, its
      corpus tree and a named cause for every connector under it, is
      [The measured ceiling](#the-measured-ceiling).

### Stage F — authoring experience `[x]`

**Closed, and each bullet judged on its own.** Two of the four close with a limit stated on the
bullet rather than silently, because in both cases the gap is permanent and no further work here
removes it: an OpenAPI document does not carry Nimbus's conventions, and JSON Schema cannot
express a cross-field refinement. A limit that cannot be closed is a limitation, not an unfinished
task — `[~]` is for work that is genuinely half-done, which is why [Stage E](#stage-e--the-corpus-tail-)
still carries it and this stage does not.

- [x] **Spec authoring from an OpenAPI document.** `--from-openapi` reads an OpenAPI 3 document
      (JSON or YAML, `$ref`s resolved), `--list-operations` prints what it found, and each `--op`
      selects an operation to become a tool. It fills what the document actually states —
      endpoints, methods, arguments, request bodies, base URL, network permission, auth mode — and
      **refuses by name** every construct the spec language cannot express, since an operation maps
      completely or not at all. What it cannot fill is the part of a connector that encodes *Nimbus*
      conventions rather than API facts, and that part is placeholders and notes, not omissions. See
      [What `--from-openapi` cannot fill](#known-limitations) for the constructs, and the
      [README](../README.md#what-an-openapi-document-can-and-cannot-supply) for the full refusal
      vocabulary.
- [x] **`--from-connector`**, deriving a starting spec from an existing connector directory, to
      make regeneration coverage measurable in bulk rather than one hand-written fixture at a
      time. Shipped, with `--partial` for a draft from a module that blocks; `bun run reach` is
      the bulk half, running the same deriver over a whole checkout. See
      [Known limitations](#known-limitations) for what its report does and does not carry.
- [x] **Better validation errors**, pointing at the JSON path rather than naming the field. Every
      `parseSpec` issue now renders as `tools[0].args.limit.max: <why> (received "ten")` — the whole
      path with bracketed indices, and the value that was actually there. `validateSpec`'s
      whole-spec rules still locate by name — `Tool "widgets_list" path references "${arg.id}", but
      declares no arg named "id"` — and that is deliberate: an identifier collision or a dangling
      reference is a relation between two places, so a single path would name only one end of it.
- [x] A JSON Schema for `ConnectorSpec`, published so editors can complete and validate a spec
      file — **structurally**, which is as far as the format reaches.
      `schema/connector-spec.schema.json` is generated from `ConnectorSpecSchema` itself and
      byte-compared against a fresh build on every test run, so it cannot drift from the language it
      describes. It does **not** carry the refinements, and therefore accepts specs the generator
      rejects. Closed with that limit stated rather than left open, because nothing on this side
      closes it — see [Known limitations](#known-limitations).

### Stage G — consolidation `[ ]`

**Scoped, not started — and scoping is not building.** Its preconditions are now recorded and
checked rather than guessed at, and one of them turned out to be materially smaller than this
document used to claim. But none is closed and no emitter path has moved toward any of them, so
the marker stays `[ ]`. It is not `[~]`: by the test [Stage F](#stage-f--authoring-experience-x)
states, `[~]` is for work genuinely half-done, and no half of this stage exists yet. Nor is it
`[x]`-with-a-limit — that form is for a gap no further work *here* closes, and the largest of
these four is a change to this repository's own emitter.

**[CONSOLIDATION.md](./CONSOLIDATION.md) is the stage**: the four preconditions, what each one
blocks, what each would cost, and — since every one of them rests on another repository's state
— the commit and date each was checked against.

---

## Measuring reach

Stage E asks for the corpus reach to be published **with its method**, because the number is
easy to get wrong and was — three times, each wrong in a way the next pass exposed.

**The question.** For how many of the 40 hand-written extractor files can the three entry
kinds — a plain key, a nested-path read, a tag helper — express the file's whole field list?
That is the *expressible* question, and it is narrower than *generatable*: a connector can be
expressible and still not be one the generator actually emits, when a separate rule blocks it.
`readwise` is the case in point — its field lists are expressible, but it declares two
extractors and this generator allows at most one per connector, so it is expressible without
being generatable. Two extractors behave the same when, for any row that connector's API
actually returns, the haystack `filterByQuery` builds contains the same substrings in the same
order — so `.includes(needle)` answers identically for every query.

**The method.** Read every file. For each element of the returned array, classify it as a plain
key, a nested-path read of any depth, or a tag helper — and for every *local* helper, diff its
guard and body against the shared primitive rather than matching on its name. A file is
expressible only if every element maps to one of the three entry kinds; one unexpressible
element disqualifies the file, since the emitter writes one extractor, not a partial one.

**Why the earlier numbers were wrong**, recorded because each error was a method error:

- **12** came from pattern-matching helper names instead of reading bodies.
- **7** came from a script whose range was `/^function fieldsOf/,/^}/`, which cannot see
  `firebase` and `testflight` — they write `const releaseFields: FieldExtractor = (item) => …`,
  an arrow. Structurally identical files landed on opposite sides of the split.
- **9** came from asking a *structural* question — "does this file define a local function?" —
  when the goal is a *semantic* one. A helper that walks a path is expressible; a helper that
  joins an array is not. Defining a helper says nothing on its own. This is the error that
  understated reach by more than half, and `netlify` is the fixture that demonstrates it:
  its `subStringField(row, "build_settings", "repo_url")` is exactly
  `nestedString(row, ["build_settings", "repo_url"])`.

**A pattern worth naming**, since it caused two of the three: a check for `String(` also matches
inside `nestedString(`, and a check for `.join(` fires on helpers that are exact
re-implementations of `tagText`. Both silently move files to the wrong side.

The counts this method produces are in [Stage E](#stage-e--the-corpus-tail-). They describe
*behaviour*, not bytes — byte-matching is a stricter question, answered in
[Known limitations](#known-limitations) and, live, by `diff:golden`.

This section is about the search-extractor question specifically, hand-measured before the
harness existed. The whole-corpus regeneration question — how many of the 94 connectors this
generator can derive a spec for, and how far each gets — is now measured mechanically, the same
way it is *derived* mechanically: `bun run reach --nimbus-root <path>`. It is the same kind of
question, asked with the same discipline the three wrong counts above forced on this file — read
what the code actually does, not what its name suggests — pointed at a script instead of a
person, so the count cannot go stale from being restated by hand.

The corpus-wide question is asked across all three frame styles a connector's wiring can take —
`hand-rolled`, `rest-kit` and `read-only-kit` — not just the first one the deriver recognized.
A connector's frame style decides which tool recognizer runs next; it says nothing on its own
about whether that recognizer can express what the connector's tools do.

---

## Known limitations

Measured, not guessed, and each one visible on every harness run rather than hidden in an
expectation file. They are listed here so nobody rediscovers them the hard way.

### The measured ceiling

**Re-measured 2026-08-14 against `packages/mcp-connectors` tree `23c90b92` (Nimbus commit
`a8f76942`).** This is the one place in this repository where the corpus *regeneration* counts
are written down, and it carries the date and the corpus tree so a reader can tell when it was
true. (Source comments carry measurements of their own, inventoried by
`test/measurement-hygiene.test.ts` — see *How to read this* at the top of this document.) Re-measure
with `bun run reach --verbose --nimbus-root <path>`; the per-connector tiers for this same tree
are in `fixtures/reach-baseline.json`, which is regenerated by `bun run reach:baseline` and
never hand-edited.

The tree moved from `67c7390a` on its own — the corpus is not this repository's to hold still, and
it has now moved under two consecutive re-baselines (`94fd3623` → `67c7390a` → `23c90b92`). Both
times, re-baselining across it changed **one line**, the tree stamp: every per-connector tier is
identical on both trees, and `reach --baseline` reports *"No connector lost a tier"* against the
new one. That is what makes this re-baseline a record rather than a reset. **Never re-baseline to
make a regression pass** — the rule `fixtures/expectations.json` carries applies here unchanged.
The tier map is also what makes the auth-expressiveness result below attributable: the tiers on
`23c90b92` were confirmed identical to the recorded ones *before* that branch landed, so nothing in
the paragraphs that follow is the tree move in disguise.

**6 of 94 reach `server-identical`. 4 of those 94 reach `all-identical`** — the byte-locked
fixtures. The remaining **88 are `blocked`, and every one of them has a named cause.**

The grouping below is what makes the number a ceiling rather than a score. Each cause is either
a **spec-language gap** — a construct the spec cannot express, which no recognizer can close —
or a **recognizer gap**, a construct the spec *can* express and `src/derive/` does not read,
which is remaining work. A number without that split says nothing about which half is
achievable.

| Cause | Connectors | Which gap |
| --- | --- | --- |
| **Frame** — `frame:no-registrar` (4) | 4 | **spec-language** |
| **Manifest** — `manifest:missing-syncInterval` (`iac`) | 1 | **spec-language** |
| **Tool registration** — `call:reg`, the single-connector `call:register<X>Tool` buckets, `const-call:makeRestToolRegistrar` | 79 | mostly **spec-language**; see below |
| **Hoisted helper functions** — 196 distinct `function:<name>` buckets | 78 | **spec-language** |
| **Hoisted consts and schemas** — `statement:VariableDeclaration`, `method-call:.object`, `.extend` | 47 | **spec-language**, plus one downstream case |
| **Local type declarations** — `TSTypeAliasDeclaration`, `TSInterfaceDeclaration` | 9 | **spec-language** |
| **Imports** — 30 buckets: shared primitives, node builtins, per-connector modules | 72 | mixed, and mostly downstream |

**Those columns do not add to 88, and that is the most important thing to know about them.** A
connector is blocked by *every* statement nothing claimed, so one refusal upstream produces
several buckets downstream: a connector whose fetch helper is refused also reports its hoisted
base-URL const, its imports and its registrations as unclaimed, none of which is an independent
cause. **5 connectors carry exactly one bucket**, and only for those is the bucket the whole
story: `apple`/`fastmail`/`imap`/`protonmail` on `frame:no-registrar`, and `iac` on its manifest.
Read the histogram as a map of constructs, not as a ranking of causes.

**That figure was 8 before the auth-expressiveness branch, and the three that left it are the
reason a "sole bucket" reading is not evidence.** `intercom`, `lever` and `readwise` each reported
`function:authHeader` and nothing else. Closing that construct (`authScheme`, `extraHeaders`, a
generalized `tokenLocal`, one-var `basic`) removed the bucket from all three — and each of them
then reported four or five *new* buckets, in a file the deriver had never reached. **The histogram
is a leading-edge report, not an inventory.** A connector's blockers are the unclaimed statements
at the stage derivation halts; what a later stage would have refused is invisible until the earlier
one is closed. Budget a predicted increment against that, not against a bucket count — see the
prediction recorded below.

That figure was **19** on the previous tree, and the eleven that left it are the shims: reading
`src/tools.ts` replaced each one's single `frame:tools-in-second-file` bucket with several real
ones. Every row above rose for the same reason — the constructs were always there, and the
deriver could not see them. **A row growing here is the histogram getting more honest, not the
corpus getting worse**, which is exactly why a number in this table is worth nothing without the
tree stamp above it.

**The headline 6 has now survived two written predictions, of 7 and of 8.**

- **7, from the conditional-endpoint work (`pathWhen`).** It was designed on the stated
  expectation that `codemagic` would go `blocked` → `server-identical` and take this figure
  6/94 → 7/94; it shipped, both halves work, and the figure did not move. The
  [Stage E bullet](#stage-e--the-corpus-tail-) records the prediction, what actually happened and
  the one-statement cause.
- **8, from the auth-expressiveness work (`authScheme`, `extraHeaders`, a `tokenLocal` no longer
  tied to bearer, one-var `basic`).** The prediction named `intercom` and `lever` as landing —
  both carried `function:authHeader` as their *sole* bucket, verified live — with `readwise` a
  stated maybe, not banked. Measured 2026-08-14 against tree `23c90b92` with
  `bun run reach --verbose --nimbus-root <path>`: still **6/94**, and all three are still
  `blocked`. The construct itself closed exactly as designed — `function:authHeader` fell from
  **15** connectors to **7**, and `intercom`, `lever` and `readwise` are no longer in that bucket —
  and the emitter reaches the shape for real: `fixtures/intercom.spec.json` and
  `fixtures/lever.spec.json` reproduce those connectors' `src/server.ts` **byte-for-byte** under
  `diff:golden` (5/7 each; the gaps are the hand-written `README.md` and `src/search-filter.ts`).
  **What the prediction got wrong was reading a one-bucket report as a complete list of what stood
  in the way.** All three block on their own `src/search-filter.ts` — `function:fieldsOf`, the
  `../../shared/search-filter.ts` import, an exported filter const and one or two bespoke field
  helpers apiece — a file the deriver never got to while the auth helper was refusing first.

Read both before treating any *predicted* increment to this number as banked. Neither prediction is
deleted, because in both cases what it got wrong is the useful part: the first was wrong about
*which constraint was binding*, and the second about *how many there were*.

Four groups are worth naming precisely, because each is a *different* kind of gap:

- **The frame group is now four connectors, and the eleven that left it answered the question they
  were blocking.** `apple`, `fastmail`, `imap` and `protonmail` wire through a bespoke
  `registerXTools(server, …)` with no `createZodToolRegistrar`, and `style` has three values, none
  of which is that. A spec-language gap: no recognizer can close it, because the emitter cannot
  write what it would be reading.

  The other eleven — `athena`, `bigquery`, `cloud-logging`, `cloudwatch`, `dataprofile`,
  `elasticsearch`, `great-expectations`, `localdb`, `sagemaker`, `storybook`, `vertex-ai` — put
  their tools in `src/tools.ts`, and `frame:tools-in-second-file` was the only thing anyone could
  say about them. The deriver now reads that file (`src/derive/server/second-file.ts`), **all
  eleven splice successfully with zero refusals**, and what they were hiding is this:

  | Bucket | Connectors |
  | --- | --- |
  | `import-from:zod` | 11 |
  | `import-from:../../shared/mcp-tool-kit.ts` | 11 |
  | `statement:ExportNamedDeclaration` | 11 |
  | `function:isRecord` / `function:strField` | 7 each |
  | `function:asArray` | 6 |
  | `import-from:../../shared/safe-cli-arg.ts` | 5 |

  and `call:reg` rose 62 → 73 as their registrations became visible and unrecognized. **The
  headline did not move**, which was the prediction and is the point: every one of those buckets
  is a spec-language gap that an emitter split would not touch. **The frame was never the binding
  constraint** — see [Considered and declined](#considered-and-declined) for why the split is not
  being built.
- **The named argument-schema const is the largest single closable-looking shape, and it is
  not one recognizer.** **13** connectors hoist `const <name>Schema = z.object({ … })` — **66**
  such declarations — and pass it to `reg` by name. Re-measured 2026-08-09 against tree
  `67c7390a` with

  ```bash
  grep -rE '^const [A-Za-z_$][A-Za-z0-9_$]*Schema\s*=\s*z\.object\(' */src/*.ts
  ```

  run from `packages/mcp-connectors`, and scoped to `src/*.ts` rather than `src/server.ts`
  because the deriver now reads both files.

  This paragraph previously said **20** connectors and **109** declarations, taken on tree
  `94fd3623`. Those figures do not reproduce here under any pattern tried, including a
  deliberately loose one counting every `const …Schema` however initialised (14 / 92). The
  earlier method was not written down, so whether the corpus changed or the count was wider than
  its own description cannot be settled — which is the argument for the command above being
  printed beside the number rather than the number standing alone. **Five** connectors compose with
  `.extend` (`bitbucket`, `circleci`, `github`, `github-actions`, `gitlab`), and only four of them
  produce a bucket for it: the other four hoist the composed schema into a module-scope const,
  while `circleci` writes `.extend` only inside its registrar call's arguments, where it is part
  of a registration nothing claimed rather than a hoisted declaration of its own.
  That produces both their `method-call:.object` buckets *and* their `call:reg` ones,
  since a registration whose third argument is an identifier is not a shape any tool recognizer
  reads. Closing it is a spec-language gap **plus** an emitter change: `argsSchemaStyle` chooses
  between inline forms only, and a recognizer that read the hoisted form without the emitter
  writing it would derive a spec that re-emits differently — reaching `emits` and never
  `server-identical`.
- **`function:authHeader` was the narrowest-looking gap in the corpus, it has been closed, and it
  was worth no tier.** This bullet used to read "the narrowest gap in the whole corpus is two env
  fields", on the evidence that the bucket blocked **15** connectors and was the *only* bucket for
  `intercom`, `lever` and `readwise`. The fields were built — `authScheme` for an alternate scheme
  word (`readwise`'s `` `Token ${…}` ``), `extraHeaders` for a static header beside the auth one
  (`intercom`'s `Intercom-Version`), one-var `auth: "basic"` for a credential whose password half is
  a literal `""` (`lever`), and a `tokenLocal` no longer restricted to bearer so the split accessor
  those three write is expressible under any mode.

  Re-measured 2026-08-14 against tree `23c90b92`: the bucket now blocks **7** (`figma`,
  `salesforce`, `stackoverflow`, `testflight`, `vercel`, `workday`, `zotero`), and the eight it
  lost are `dbt`, `flagsmith`, `greenhouse`, `intercom`, `lever`, `readwise`, `snowflake` and
  `snyk`. **No connector changed tier**, and the headline stayed 6/94. Five of the eight were
  independently blocked on `call:reg` and their search imports all along; the other three —
  `intercom`, `lever`, `readwise` — moved from one bucket to four or five, every one of them in
  `src/search-filter.ts`, a file derivation had never reached. What the emitter gained is real and
  is measured elsewhere: `fixtures/intercom.spec.json` and `fixtures/lever.spec.json` reproduce
  those connectors' `src/server.ts` byte-for-byte. What the *bucket* was worth was nothing, and the
  paragraph above on reading the histogram is the general form of that lesson.

  `auth: "headers"` never reached these shapes and still does not: it maps each var to a header
  name and emits the binding bare, with no scheme prefix and no literal-valued key. That is what
  `extraHeaders` adds, and the two compose.
- **The lone `statement:IfStatement` bucket is not a guard-ladder near-miss.** It is one
  connector, `outlook`, and its `if`s are module-scope
  `if (outlookToolShouldRegister("<tool>", grantedOutlookScopes)) { … }` gates wrapping ten
  registrations — a scope-conditional registration shape, not a path-conditional handler. Stated
  because the bucket's name invites the other reading: `blockerFor` only ever sees *top-level*
  unclaimed statements, and a `pathWhen` ladder's `if`s live inside a `reg(...)` argument, which
  buckets as `call:reg`. There is no corpus evidence in this bucket for or against the
  conditional-endpoint work; budgeting it as one would be counting a shape nobody looked at.
- **`const-call:makeRestToolRegistrar` looks like a recognizer gap and is not.** `gmail`,
  `onedrive` and `outlook` all pass a fifth registrar option, `snippetMax: 200`, which
  `renderRestKitTools` never writes and no spec field carries. Reading it would need the field
  first.

The two largest import buckets — `./search-filter.ts` (43) and `../../shared/mcp-search-tool.ts`
(39) — are downstream in the same way: `claimSearchImports` (`src/derive/server/search.ts`) claims
both imports, and it never ran for these connectors because their search registration was not
recognized — it is called only once at least one search tool has been positively recognized. No
connector in the corpus is blocked by imports alone.

#### Three constructs the histogram cannot show

These do not appear as buckets at all. Each is a construct this generator **emits** and the
corpus **writes differently**, so the connectors carrying it are blocked earlier and the
divergence never surfaces. All three were measured 2026-08-06 against tree `94fd3623`. **The
cost of closing each is named; none is proposed.**

- **The query tail.** Ten connectors write `new URL(...)` inside a path-builder lambda. Eight
  end it `` return `${u.pathname}${u.search}` `` (`circleci`, `discord`, `github`,
  `github-actions`, `google-meet`, `google-photos`, `outlook`, `pagerduty`) and two end it
  `return u.toString()` (`gitlab`, `gmail`). **None writes `` return `${u}`; ``,** which is what
  this generator emits, deliberately — see *An upstream defect this generator deliberately does
  not reproduce* below. A further **22** build a query string from a standalone
  `new URLSearchParams` with no `new URL` at all. Cost: the first is **a change to what the
  emitter writes** — recognizing the pathname+search tail without emitting it derives a spec
  that re-emits the other form, and emitting it means reproducing the doubling defect. The
  second is **a different construct**, needing its own spec shape before any recognizer applies.
- **The write helper.** **No corpus connector declares `<local>Send`** — the two-helper
  read/write split is this generator's own convention. Three carry a generic `<x>Post(path,
  body)` (`argocd`, `mlflow`, `snyk`); **16** route reads *and* writes through a single helper
  taking `init?: RequestInit` and supply the verb there. Cost: **a change to what the emitter
  writes** — a second hand-rolled helper shape, chosen per connector, which means a spec field
  to choose it and a second emitter path gated on a field the four byte-locked fixtures never
  set.
- **The token exchange.** Three connectors run a client-credentials grant (`powerbi`, `ramp`,
  `wiz`) and no two share a shape. **`expires_in` appears nowhere in any connector's source**,
  and none of the three caches an expiry: the corpus's four `let cachedToken` declarations have
  four different types, and the only one carrying an `expiresAt` belongs to `firebase`, which is
  not a client-credentials connector. This generator's `token()` reads `expires_in`, renews
  early and halves the skew for short-lived tokens. Cost: **a change to what the emitter
  writes**, and one that would have to be optional — emitting the corpus's cache-forever shape
  by default would remove a correctness property from every connector this tool generates.

#### Three follow-ups, all deliberately not built here

- **The recovered rest-kit `title` should be reported per run, like `$effectAmbiguity`.** The
  limitation itself is recorded below under *A recovered rest-kit `title` is verified against
  only one of its two consumers*; what is missing is the per-run note. `src/derive/index.ts`
  has the exact precedent — `$effectAmbiguity` reports an attribution that is byte-identical
  but not forced, on the stated grounds that semantically wrong is a real cost even when
  byte-identical — and the `title` case is stronger, because the recovered value is byte-*visible*
  and byte-*wrong* in a file the deriver never sees. Start from `$effectAmbiguity` rather than
  rediscovering the shape. Deferred because widening `Derivation` is a contract change across
  three consumers (`src/derive/from-connector.ts`, `scripts/_lib/reach.ts`,
  `test/derive/round-trip.test.ts`).
- **The `derive → emit` layering, and the rule that keeps it safe.** `parsePathTemplate` now
  lives in `src/spec.ts`, not `src/emit/server/path-template.ts`, so `src/derive/server/body.ts`
  imports the spec language rather than the emitter. The rule that placement encodes:
  **`src/derive/` may share the spec language's parser; it may never import the emitter's
  renderer.** Sharing a parser removes the only failure direction nothing can see — a private
  copy that under-parses leaves an arg in the default body set and emits a spurious explicit
  `body` that is byte-identical, invisible to `diff:golden`, to the round trip and to every
  other gate, while one that over-parses throws. Comparing *rendered* text against observed
  source is the opposite: it would let a renderer bug agree with itself and disappear.
- **The property *shorthand* spelling is not pinned the way the key spelling now is.** The key
  spelling was made structural: `objectProps` is module-private in `src/derive/read.ts`, and the
  only exported readings are `bareKeyedProps` and `quoteMinimalProps`, so a recognizer cannot
  obtain an unjudged key. Shorthand-ness has no such treatment. `isRestReturnStatement`
  (`src/derive/server/fetch-helper.ts`) accepts the longhand `{ json: json }` where the emitter
  writes the shorthand `{ json, text }` — the same wrong-claim shape, since the recovered fields
  are identical and re-emission differs. Both the precedent and the accessor already exist:
  `src/derive/server/body.ts`'s `bodyPairs` pins shorthand-ness through `isShorthandProperty`
  for exactly this reason. Deferred rather than folded into the key sweep because it is a
  different predicate over a different call-site set, and the sweep that settled the keys was
  scoped to the keys. Whoever takes it should sweep `isShorthandProperty`'s absence the same way
  the key sweep swept `objectProps`', rather than fixing the one site named here.

**Content no spec field can derive.**

- **Hand-authored READMEs.** Several real connectors carry prose naming their specific item
  types, their tool names and their deferred follow-ups. The generator emits boilerplate. This
  is a content gap, not a formatting one, and no rewording closes it.
- **`*-mapping.ts` bodies.** No spec field describes a service's API response shape.

**Constructs outside the spec language.**

Every entry here says what the generator cannot express **today**, which is not the same as
saying it never will. Three of them are also open [Stage E](#stage-e--the-corpus-tail-) tasks, and
those three link to the bullet that carries the measurement rather than restating a shorter version
of it — a construct described in two places drifts, and the shorter description is the one a reader
trusts. The rest carry their reason in place, because for those the reason *is* the whole entry:
a deliberate divergence, a rule chosen over a spec field, or a gap this repository cannot close
alone.

- **Conditional query parameters, the remaining gaps.** The construct itself — `query` plus
  `omitWhen` — now exists; the gaps are narrower now. An **inlined default**: real connectors
  write `p.pageSize ?? 50` at the call site, but a `default`-bearing arg is always hoisted to a
  named const above the handler (`isHoisted` in `src/emit/server/args.ts`), so `google-meet`'s
  `pageSize`/`searchPageSize` differ from the real file on that one line even though the
  request they build is identical. **Repeating, multi-value parameters** — `gmail` sends
  `labelIds` and `metadataHeaders` more than once via `searchParams.append`, and `pagerduty`
  does the same with `statuses[]` — are out of scope; `query` models one value per name. **A
  slashless path**: the query branch threads the fetch helper's
  base straight into `renderPath`'s `prefix` with no separator and none of the leading-slash
  normalization the non-query path gets, so `query` is rejected at parse time on any tool whose
  `path` does not begin with `/`.
- **An upstream defect this generator deliberately does not reproduce.** Eight corpus
  connectors' hand-written path builders return `` `${u.pathname}${u.search}` ``, measured
  2026-08-06: `circleci`, `discord`, `github`, `github-actions`, `google-meet`, `google-photos`,
  `outlook` and `pagerduty`. `u.pathname` already carries the base's own path component — the
  base is spliced into `new URL(...)` as a literal string prefix, not passed as the URL's
  origin — and the connector's fetch helper prepends that same base a second time
  (`resolveUrlWithBase` concatenates verbatim for any path not starting `http`). The real
  `discord` connector therefore requests
  `https://discord.com/api/v10/api/v10/channels/123/messages`, a doubled `/api/v10`; verified
  by running the connector's own code. **Which of the eight actually double is decided by the
  base, not the tail:** `discord`, `circleci`, `google-meet`, `google-photos` and `outlook`
  (whose `GRAPH` base carries `/v1.0`) have a path component to double; `github`,
  `github-actions` and `pagerduty` escape only because `api.github.com` and
  `api.pagerduty.com` have none. This generator emits `` `${u}` `` — the absolute URL — instead, which
  the fetch helper's own `startsWith("http")` short-circuit passes through untouched,
  producing one correct request. That is a deliberate divergence from a defect, not a
  generator shortcoming, and it is why `discord` and `google-meet` do not byte-match
  `src/server.ts` even though both now use `query` for real, non-stub tools.
- **`auth: "bearer"` could not express two real shapes. The spec language now expresses both, and
  `discord` — the fixture this entry was written against — still cannot use either FIELD.**
  Rewritten rather than deleted: the general claim stopped being true, the connector-specific one
  did not, and collapsing the two is how this entry got written imprecisely in the first place.
  "Cannot use either field" is not "cannot reach either shape", and the paragraphs below keep them
  apart — one of the two shapes was always reachable on this connector by another route.

  The two shapes are Discord's literal `Bot ${token}` scheme and the static `User-Agent` header it
  sends alongside `Authorization`. `env[].authScheme` and `env[].extraHeaders` carry them — see
  [SPEC-RULES](./SPEC-RULES.md#env-auth-authscheme-extraheaders-tokenlocal-and-one-var-basic) — and
  `intercom` byte-matches its `src/server.ts` on the strength of the second.

  **`discord` reaches neither, because it is `rest-kit`.** Both fields are `env[]` fields, and a
  rest-kit connector emits no env accessor at all: `makeRestToolRegistrar` resolves the credential
  itself and the `Authorization` line is written by the rest-kit fetch helper, whose only
  header seam is `fetchHelper.inlineHeaders`. So the `User-Agent` half was in fact reachable
  *before* this work, through `inlineHeaders` rather than through any env field — verified
  2026-08-14 by generating `fixtures/discord.spec.json` with
  `"inlineHeaders": { "User-Agent": … }` added, which reproduces the real connector's header object
  exactly, `Bearer`-for-`Bot` aside. This entry previously said no field carried a static extra
  header, full stop, which was already wrong on that half. The scheme half remains a **spec-language
  gap**, recorded below under *Alternate fetch-helper shapes*.

  **And `discord`'s byte gap is neither of them.** It does not match `src/server.ts` because of the
  URL-doubling divergence recorded above under *An upstream defect this generator deliberately does
  not reproduce* — a deliberate refusal to reproduce a defect, untouched by this work and not
  proposed for closing. Closing the scheme gap would not move its tier or its file count.
- **A validator over-rejection in hoisted-argument-local uniqueness.** `src/validate.ts`
  claims every tool's hoisted argument locals into one map shared across the whole connector,
  but each is emitted inside its own tool's arrow function (`renderHoists`), so two tools
  declaring the same defaulted arg name can never actually collide in the generated file — the
  spec is rejected anyway. `fixtures/google-meet.spec.json` carries `"local":
  "searchPageSize"` purely to work around this. Pre-existing, not introduced by this stage,
  and not fixed here.
- **An unguarded optional argument interpolated into a path emits a package that does not
  typecheck.** An arg with `"optional": true` and no `"default"` is `string | undefined` in the
  emitted `z.object`, and `renderPath`'s `|enc` mode wraps it in `encodeURIComponent`, which
  accepts `string | number | boolean`. So `"path": "/x/${arg.a|enc}"` with
  `"a": { "type": "string", "optional": true }` emits
  `encodeURIComponent(p.a)` and the generated package fails `tsc` under its own strict
  `tsconfig.json`. Nothing rejects the spec — the arg IS used, so the unreferenced-arg checks
  pass, and hoisting does not apply because there is no default to hoist. **A `pathWhen` guard
  narrows only the arg it names**, so this survives the guard ladder: a tool whose fallthrough
  path interpolates a *second*, unguarded optional arg takes the block form and still emits the
  uncompilable call. `fixtures/zzcond.spec.json` compiles only because its one guard happens to
  cover its one path argument; the emitter does not guarantee that pairing.

  **No gate in the merge gate catches it.** `test/emit/emitted-typecheck.test.ts`'s own header
  (`:71`) records that hand-rolled and rest-kit `src/server.ts` are compiled nowhere in
  `bun test` at either target; the read-only-kit × monorepo cases that *are* compiled there do
  not include this shape. `diff:golden` is a byte comparison against real connectors, and no
  real connector writes it. Pre-existing and unrelated to the conditional-endpoint work, which
  neither introduced nor closed it. The cheap close is a read-only-kit × monorepo case in
  `emitted-typecheck.test.ts` — that path IS compiled — which would turn this from an
  uncaught defect into a failing test naming the arg.
- **A `pathWhen` ladder cannot be combined with a hoisted argument the guards do not read.**
  `renderTool` emits every hoisted-argument const above the guard ladder, and `splitHoists` reads
  a hoist run only off the front of a handler block. A connector that writes the hoist *below* its
  guards — because the guarded branch has no use for it — therefore differs by two lines and is
  refused by the deriver. This is **one of the two** reasons `fixtures/codemagic.spec.json` reports
  5/7 — it accounts for `src/server.ts`, and `README.md` is the other, the *Hand-authored READMEs*
  gap above that `mercury`, `zendesk` and `bitrise` carry too and that closing this rule would not
  touch. It is **not** the reason `codemagic` did not move a tier: derivation from the real
  connector halts at `call:reg` and two search-tool imports before any byte is compared, and those
  three blockers are identical on this branch and on `main`. This is a byte-diff gap sitting
  downstream of a blocker that fires first. The [Stage E
  bullet](#stage-e--the-corpus-tail-) carries the isolation, the corpus count and what closing it
  would cost. **Open Stage E work**, not a permanent ceiling — but it is worth 6/7, not 7/7, and
  no tier.
- **A `pathWhen` ladder over the write helper is emitted but never read back.** `pathWhen` is
  legal on a non-GET tool, and `renderTool` writes the ladder correctly — every rung repeats
  `renderBodyExpr`'s output around its own path. `recognizeConditionalPath` refuses that shape
  outright (`plainReadPath`, in `src/derive/server/conditional-path.ts`): accepting it would mean
  pinning the rungs' body expressions equal to each other and to the fallthrough's, and nothing
  at the tool-recognizer layer can compare two expression *nodes* — only the module source could,
  which the recognizers do not have. Reading only the fallthrough's body and ignoring the rungs'
  would claim a module that re-emits with the wrong body in every guard. So the refusal is
  deliberate and it under-claims into `blocked`, never into a wrong spec: a write ladder shows up
  by name in the blocker histogram rather than deriving successfully and re-emitting differently.
  No corpus connector carries the shape — measured 2026-08-10 against `packages/mcp-connectors`
  tree `67c7390a`, none declares a `<local>Send` write helper at all (see *The write helper*,
  above) — so this costs no reach today; it is recorded because
  the emitter can write something the deriver will not read, which is the asymmetry every other
  entry here exists to make visible.
- **Enum arguments.** Mapping a `z.enum` through a lookup table. **Open Stage E work**, not a
  permanent ceiling — the [Stage E bullet](#stage-e--the-corpus-tail-) names the connector that
  needs it, and the two other shapes its handlers carry.
- **Multi-file connectors.** The generator emits one source file; some connectors split their
  tools into `src/tools.ts`. **Open Stage E work**, and the largest of the three: the
  [Stage E bullet](#stage-e--the-corpus-tail-) carries the count, why `bun run reach` labels these
  `frame:tools-in-second-file` rather than as import blockers, and which stage of the deriver
  applies the label. Closing it is a spec-language gap *and* an emitter change, since the emitter
  cannot today write the file a recognizer would be reading.
- **CLI-backed connectors.** A handful shell out rather than calling `fetch`. **Open Stage E
  work**; the [Stage E bullet](#stage-e--the-corpus-tail-) names them, and the two different shapes
  they split into, only one of which surfaces as a bucket of its own.
- **A connector with no `createZodToolRegistrar` at all.** `apple`, `fastmail`, `imap` and
  `protonmail` wire their tools through a bespoke `registerXTools(server, …)` call instead.
  Reported as `frame:no-registrar`.
- **At most one extractor-branch search filter per connector.** The emitted `fieldsOf` function
  is always that name, so a second search tool taking the extractor branch in the same
  `src/search-filter.ts` would redeclare it — `validateSpec` rejects this at parse time rather
  than auto-suffixing or adding a spec field to name the extractor. Measured: the only corpus
  connector with two extractors in one file is `readwise` (`fieldsOf` and `bookFieldsOf`). Its
  field lists are otherwise expressible — it is one of the 26 counted under
  [Measuring reach](#measuring-reach) — so this rule is the sole reason it is not generatable
  today, not a second, independent gap stacked on top of one.
- **Bespoke search extractors, past what `path` and tag entries reach.** `filter.fields` omitted
  still emits a throwing stub. Of the 40 corpus filter files that hand-write an extractor, **14**
  need logic no declarative field list expresses — a join over a non-`tags` array, a numeric
  coercion, an alternate tag shape, a conditional array search, a per-item concatenation — and
  `zoom`, which does not use `makeQueryFilter` at all, is one of those 14, not an extra on top
  of them. The other 26 are expressible; [Stage E](#stage-e--the-corpus-tail-) names the cause
  for each of the 14 and [Measuring reach](#measuring-reach) gives the method. **Defining a
  local helper function is not on its own disqualifying** — an earlier count of 30 asked that
  structural question instead of a semantic one, and understated reach by more than half. A
  local *variable* binding that just projects a sub-object before reading flat keys off it is
  not in this group either — that shape is exactly what a `path` entry expresses.

**Shape variance the emitter models one way.**

- **Alternate fetch-helper shapes.** A rest-kit connector using a different shared fetch
  primitive or a non-bearer auth scheme cannot be expressed — the rest-kit `fetchHelper` has no
  `authScheme` field and forbids `${env.*}` references, since the credential is resolved by the
  registrar rather than an env accessor. (An extra *static* header is the one part of this that is
  expressible, through `fetchHelper.inlineHeaders`; it was listed here as unreachable and was not.)

  **The env-side auth fields were accepted on a rest-kit spec and silently dropped. They are now
  refused**, by one style-scoped rule rather than three per-field ones. Measured 2026-08-14 by
  generating `fixtures/discord.spec.json` with `authScheme`, `extraHeaders` and `tokenLocal` added
  to its env entry: each parsed, validated and emitted a `src/server.ts` carrying none of the
  three — the "validated then discarded" class this repository keeps closing elsewhere, reached by
  a field that had no rule yet rather than by a new mechanism.

  The rule names those three and stops there, and the pre-existing
  *exactly one `auth: "bearer"` single-var entry* rule is what makes that exhaustive rather than
  arbitrary: under the shape it pins, `prefix`/`suffix`/`transform` are already refused beside any
  `auth`, `headerNames` needs `auth: "headers"` and `tokenUrl` needs client-credentials. `local`
  and `bindings` stay accepted-and-ignored, and that IS the older hole this one sat next to —
  `local` is required by `EnvSchema` and every rest-kit spec including `discord` sets it, so
  refusing it would refuse the style. Naming a required field as droppable is the one thing a rule
  here cannot do.
- **Registrar and helper naming.** Derived by formula. A connector whose author picked a
  shorter name by hand will differ on that line.
- **A recovered rest-kit `title` is verified against only one of its two consumers.** For
  `style: "rest-kit"`, the deriver recovers `spec.title` by inverting the registrar name
  `register<Title>Tool` and asserts the round trip reproduces the observed identifier
  (`recognizeRestTitle` in `src/derive/index.ts`). `spec.title` has a second consumer
  the deriver does not check — `src/emit/readme.ts` — and the sanitization is many-to-one, so a
  recovered `title` that reproduces the registrar name can still regenerate a different
  `README.md`. Bounded, not silent: the `all-identical` tier requires every emitted file to
  match, so this downgrades such a connector to `server-identical` rather than passing falsely.
- **Wiring and tail idiom.** The emitter always writes the one-line registrar form
  (`const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));`) and a named transport
  const. Real connectors write two other forms, and `recognizeFrame`
  (`src/derive/server/index.ts`) now **reads** both: the **split registrar**, which hoists the
  inner call to its own `const registerSimpleTool = …;` one line above, and the **inlined
  transport tail**, `await <mcpVar>.connect(new StdioServerTransport());` as the file's last
  statement with no transport const at all. Neither axis is rest-kit-only: the split registrar
  mixes hand-rolled connectors (e.g. `bitbucket`, `notion`) with rest-kit ones (e.g. `discord`,
  `github`), and a connector may write both (`google-meet`, `google-photos`) — which is why the
  two recognizers had to land together, since `frameFailureKind` checks the registrar element
  before the transport one and such a connector stays blocked while either is missing. Reading a
  form is not emitting it: `wiring()` and `tail()` (`src/emit/server/index.ts`) still write the
  one-line registrar and the named transport const. What recognizing these forms buys is that a
  connector writing one **gets past the frame** — and it then blocks on whatever is behind it.
  That is the measured result, not a prediction: all 27 connectors on these axes are `blocked`
  today, on statement-level blockers the frame used to hide. **Not one reaches `emits`** — and no
  connector in the corpus carries that tier as its verdict, since the only six that derive and
  emit all go on to `server-identical`. (`bun run reach` prints the tiers cumulatively, so
  "spec derived + emits 6/94" beside "server.ts identical 6/94" is that same fact, not a
  separate six.) The frame widening reveals rather than clears, which is what it was for.
  The `emits` ceiling stated here is what these axes would impose *if* everything behind them
  were recognized — a connector in either form would then re-emit in **this generator's** form,
  reaching `emits` and never `server-identical`. No cosmetic spec field is added to close that
  gap — the operative bar is "no cosmetic field without a fixture that byte-matches *because of*
  it", and no such fixture can exist until what sits behind those frames has itself been
  measured, which reading them is what makes possible. There is no majority to converge on, so
  the emitter picks one form per axis and the other differs.
- **A read-only-kit callback that is a named function reference, not an inline arrow.**
  `argocd`, `bigeye`, `flux`, `looker`, `mlflow`, `monte-carlo`, `powerbi`, `snowflake`,
  `tableau` and `workday` write three top-level statements where the emitter writes one: an
  exported `register<X>Tools(reg: ZodToolRegistrar)`, an exported `async startConnector()` whose
  body awaits `runReadOnlyMcpConnector("nimbus-<x>", register<X>Tools)` with a **bare function
  reference**, and `if (import.meta.main) await startConnector();`. `recognizeReadOnlyFrame`
  reads this as a second entry shape alongside the inline wrapper, splicing
  `register<X>Tools`' **body** into `verifyStatements` rather than claiming the declaration —
  see `src/derive/server/frame.ts` on why claiming it would cover every registration by
  containment. As with the wiring and tail idioms above, `renderTools` still writes the inline
  `(reg) => { … }` arrow at the call site, so `emits` rather than `server-identical` is the best
  any of these ten could reach — and none reaches it: all ten get past the frame and block on
  statements behind it, which is the whole of what recognizing the shape changed. This entry used
  to promise a
  `frame:readonly-callback-not-inline` histogram bucket, which upstream commit `b3a6f159`
  emptied when it refactored these ten into the shape above; until this recognizer existed they
  were reported as `frame:no-mcp-server`, that shape having no top-level `McpServer` const at
  all. The divergence was found by tracing why the read-only-kit frame recognizer moved 50
  connectors rather than the roughly 60 predicted going in — see
  [Measuring reach](#measuring-reach) on reading what the code does rather than trusting a
  prediction.
- **`permissions.filesystem` is always collapsed to one line**, which is what 27 of the 29
  manifests declaring it do.
- **The type alias in a filter file** is emitted always, following 47 of 49 connectors; the
  other two cannot byte-match.
- **Expressible is not the same as byte-identical, and almost none of the 26 byte-match.**
  Expressing a field list correctly says nothing about reproducing the file that carries it —
  `netlify` is the clearest case, generated correctly and textually different on every line of
  its extractor, because the real file declares a local `subStringField` where the emitter
  calls the shared `nestedString`. Four gaps account for the rest. The guard: `argocd` writes
  `asRecord(item)`, the emitter
  always writes `asObjectish(item)`, and the two differ semantically (`asObjectish` admits
  arrays, `asRecord` rejects them). The extractor form: `firebase` and `testflight` write
  `const buildFields: FieldExtractor = (item) => …`, an arrow expression with an explicit type
  annotation, where the emitter always writes a `function fieldsOf(item: unknown)` declaration.
  The extractor's name: `firebase` calls it `releaseFields` and `testflight` calls it
  `buildFields`; the emitter's is always `fieldsOf`. And a hand-written 4–5 line doc comment
  explaining the service's response shape, present in `canva`, `figma`, `firebase`, `hubspot`,
  `miro`, `salesforce` and `testflight` — the same content gap already recorded above for
  hand-authored READMEs, not a formatting one. `dependencytrack` **does** byte-match: it guards
  with `asObjectish`, names its extractor `fieldsOf`, and carries no hand-written doc comment,
  so none of the four gaps applies to it — the exception shows these are gaps in what a spec
  can carry, not a ceiling the emitter itself imposes.

**Absences.**

- **A connector with no `test/sandbox.test.ts`.** 15 of the 94 lack one; the generator always
  emits it, so the harness reports `MISSING` rather than `DIFF`.

**What the byte gates do not reach.**

Gaps in *verification* rather than in the generator, recorded here because each is a place where
the fixture list implies coverage that does not exist — and "the write path is byte-verified" is
the specific belief that is not true. [TESTING.md](./TESTING.md) carries the per-shape matrix and
the probes behind these; what belongs here is that they are known, and why none is closable from
this side.

- **No real-connector fixture declares a write tool, so `diff:golden` has zero purchase on the
  Stage C emitter paths.** Verified at HEAD by reading every `fixtures/*.spec.json`: not one of
  the fixtures transcribed from a real Nimbus connector declares a tool with `effect: "write"`
  or a non-`GET` `method`. `method`, `effect`, `body`, `hitlRequired` and the `<local>Send` write
  helper are exercised only by the synthetic `zz*` fixtures, which byte-match nothing — no
  `packages/mcp-connectors/zz*` directory exists, so their `fixtures/expectations.json` entries
  are empty lists and every generated file reports MISSING. That is a pass that compared against
  nothing, by design. Holding those paths in place instead: `fixtures/snapshots/`,
  `test/derive/round-trip.test.ts`, and `standalone-acceptance` / `runtime:acceptance` — all
  real, none ground truth. **No corpus connector closes this**, and *The write helper* above is
  why: no corpus connector declares `<local>Send` at all, so there is nothing to transcribe a
  fixture from.
- **`read-only-kit` + `client-credentials` is documented and has no fixture.** The
  [SPEC-RULES § OAuth](./SPEC-RULES.md#oauth-client-credentials) section documents the pairing; every
  `read-only-kit` fixture uses `bearer`, `basic` or plain headers, and the one fixture declaring
  `client-credentials` is `hand-rolled`. The single check on the combination is the standalone
  KIT-import ordering case in `test/emit/emitted-typecheck.test.ts`, and that case is a
  `biome check`, not a compile.
- **`read-only-kit` × standalone is byte-compared nowhere in this repository.** Both byte
  comparisons inside `bun test` miss it by construction: `listWriteFixtures`
  (`src/golden/snapshots.ts`) selects snapshot fixtures on `effect !== "read"` and no
  `read-only-kit` fixture has a write tool, while `test/derive/round-trip.test.ts` runs at the
  monorepo target. Measured rather than reasoned — a plain `TS2322` emitted into that file passes
  the entire suite with zero failures, including the real `biome check`, because an exported const
  is read by definition and Biome has no type information. `standalone-acceptance` catches it, in
  `acceptance.yml`, which is outside the merge gate.

**`--from-connector`'s report shape.**

- **`--partial` prints less than the report it replaces.** `partialResult`
  (`src/derive/from-connector.ts`) keeps only each blocker's `kind`; `renderBlockers`, the exit-1
  report `--partial` stands in for, prints the `kind` **and** the source line. `docs/USAGE.md`
  calls the flag "a draft to work from," which is true of the one thing it reliably carries — the
  `$partial` marker key `ConnectorSpecSchema`'s `z.strictObject` refuses by construction, so the
  draft cannot reach `generate()` until a human deletes it — but the exit-0 draft is strictly less
  informative than the exit-1 report it replaces. The mechanism is sound; the label overstates
  what ships with it.
- **`--partial` does not reach a missing-file blocker.** `deriveFromDirectory` checks
  `existsSync` on both inputs and returns before `options.partial` is ever read, so
  `--from-connector <dir-missing-src/server.ts> --partial` exits 1 with the same blocker report a
  non-partial run prints, while the identical flag against a directory that has both files but
  blocks later exits 0 with a draft. Defensible — there is no source to draft a spec from — but
  the asymmetry is easy to miss, since every other blocker in this module does downgrade to a
  draft under `--partial`.
- **A file that exists but cannot be read still throws raw.** `deriveFromDirectory` gates on
  `existsSync`, then reads both files with `Bun.file(...).text()` unguarded. A path that exists
  but isn't a readable file — permissions, or (verified) a directory sitting where
  `src/server.ts` should be — throws Bun's own error message straight through `main`'s top-level
  catch, printed as one line with none of `renderBlockers`'s formatting. `missing()`'s own
  comment in that file claims "one report shape covers every failure"; this is the failure that
  report shape doesn't cover.

**What `--from-openapi` cannot fill.**

The mechanical majority of a spec is in the document — endpoints, methods, arguments, request
bodies, the base URL, the network host, the auth mode — and the reader takes all of it. What is
left is not remaining work on this side: it is the part of a connector that encodes *Nimbus*
conventions rather than API facts, and no document states it. The output is a **starting point a
human edits**, and the `TODO:` markers are how it says so.

- **The connector's own identity and shape are placeholders.** `style`, `syncInterval`,
  `minNimbusVersion`, `displayName`, `serviceLabel`, the connector `description`, and a tool
  description for an operation carrying no `summary`. Each prose one carries a `TODO:` marker;
  `style` is an enum and `syncInterval` a positive integer, so neither can hold prose and both
  carry a value that parses and is obviously provisional instead. They live in one `PLACEHOLDER`
  const (`src/openapi/spec.ts`) so the set is readable at a glance rather than scattered.
- **`effect` is never guessed from the HTTP method.** It is left unset on every operation — which
  means `"read"`, so the manifest asks for no confirmation — and each non-GET carries a note asking
  for it. The corpus does not support deriving human-in-the-loop confirmation from the verb, and a
  wrong default here is worse than an absent one, because it is the one field whose error ships a
  mutating tool that runs unconfirmed.
- **Search tools do not come from a document.** `impl: "search"`, `filter`, `rows` and `maxLimit`
  describe how a connector presents results to an agent; an OpenAPI operation describes a request.
  Every mapped operation becomes a plain tool.
- **Tool names are `operationId`s verbatim, and that collides with the Gateway wiring's one
  convention.** `mapOperation` (`src/openapi/operation.ts`) sets `name: op.operationId`, while
  `emitWiring`'s `findListTool` (`src/emit/wiring.ts`) selects the tool whose name
  `endsWith("_list")` and **throws** when none does — the same corpus convention `src/prompts.ts`
  defaults a hand-authored tool name to, as `${name}_list`. So a document declaring
  `operationId: listWidgets` produces a spec `--gateway-wiring` **refuses outright**, not one that
  merely wires the wrong tool. Rename the tool before wiring it.
- **A refusal names its operation by method and path, not by `operationId`.** `mapOperation` builds
  its refusal context as `` where: `${op.method} ${op.path}` ``, and every refusal routes through
  the one `refuse()` sink, so selecting `--op listWidgets` produces refusals headed `GET /widgets`.
  Correct, and worth knowing before reading the output.
- **An exclusive bound is widened to an inclusive one, with a note.** `exclusiveMinimum` /
  `exclusiveMaximum` have no counterpart in the spec language, so they become `min` / `max` and the
  note records the widening. This is the one knowing divergence in the whole path — the tool will
  accept a value the API rejects — and the note is the entirety of its honesty.
- **Everything else it cannot express is refused by name**, per document and per operation: a
  header or cookie parameter, an `array` or `object` argument, `oneOf`/`anyOf`/`allOf`, a body that
  is not flat `application/json`, an absent or ambiguous `servers` entry, a security scheme with no
  env auth mode. The [README](../README.md#what-an-openapi-document-can-and-cannot-supply) carries
  the full vocabulary; what belongs here is the rule behind it. **An operation maps completely or
  not at all** — a tool missing the one parameter that could not be expressed is a connector that
  compiles, passes every gate, and sends the wrong request.

**The published JSON Schema.**

- **It cannot express the refinements, so it accepts specs the generator rejects.**
  `schema/connector-spec.schema.json` is generated from `ConnectorSpecSchema` and byte-compared
  against a fresh build by `test/schema.test.ts`, so it cannot drift from the *shape* of the spec
  language. The rules that are not shape have no JSON Schema expression and are simply absent from
  the document: cross-field requirements, `RESERVED_IDENTIFIERS`, style-specific constraints, and
  the string-safety refinements that stop a spec value becoming executable code in the generated
  package. An editor therefore reports green on a spec the CLI refuses — a false green in the
  direction this repository normally removes, kept because the alternative is not publishing a
  schema at all. It is a property of the format rather than unfinished work: completion and
  structural checking are what it buys, and `bun src/cli.ts --spec <path> --dry-run` is what says a
  spec is actually accepted.
  [SPEC-RULES § Editor support](./SPEC-RULES.md#editor-support-the-published-json-schema-and-what-it-cannot-check)
  states the same limit beside the editor setup, where somebody wiring it up will meet it.

## Considered and declined

Recorded so they are not re-proposed. Each was measured before being rejected.

- **Coercing the row set before `matchesResult`** (`accounts ?? []`). The guard already exists
  one level down — `matchesResult` does `Array.isArray(rows) ? … : []`, so `undefined`, `null`
  and any non-array already yield an empty match set. The coercion would be dead code that
  changes a byte-exact fixture's bytes.
- **Recovering `rows` from a hoisted pluck helper.** Proposed as a case-2 widening — the rule
  is in [GLOSSARY § Reach and derivation](./GLOSSARY.md#reach-and-derivation): corpus connectors commonly hoist
  `function <name>From(root: unknown): unknown[]` above their registrations and pluck the row
  array there, so a recognizer could read that key back as `rows` even though `renderSearchTool`
  writes the narrowing inline. The proposal drew a careful line between the pluck bodies that are
  behaviourally identical to the inline form and the ones that fall back to the root array, which
  `rows` cannot express. That line was correct and irrelevant: **the connectors that hoist a
  pluck helper are exactly the ones that never call `matchesResult`.** They build the
  `{ matches }` envelope by hand — `const matches = filterX(<pluck>(root), { query: p.query,
  limit: p.limit }); return jsonResult({ matches });` — and `recognizeSearchTool` requires
  `matchesResult` before it inspects a handler body at all. Every corpus `matchesResult` call
  site instead passes a bare identifier, `root` or the narrowed const, which
  `recognizeNoRowsBody` and `recognizeRowsBody` already read. The proposal was made in a document
  whose own trap list had measured this from the other side — a connector that carries
  `src/search-filter.ts` without calling `matchesResult` builds its own envelope and is out of the
  recognizer's reach *by construction, not by omission* — so the proposal and the trap could not
  both be true, and the trap is the half backed by a measurement. Recorded because that is the
  useful part: two halves of one document contradicting each other is what a design document does
  when it is read once and never re-read.

  Recognizing the **hand-written result tail** instead would be a legitimate case-2 widening —
  `matchesResult`'s own docstring calls it the verbatim equivalent of that tail — and is declined
  because it moves no connector out of `blocked`. Two separate things stop it, each sufficient
  alone: `recognizeTools` is all-or-nothing, and several of these connectors also call the pluck
  helper from an unmodeled *list* handler (`jsonResult({ items: <pluck>(root) })`), so nothing in
  those modules would be claimed; and `matchSearchKitImport` requires `matchesResult` in a clause
  these connectors import only `searchToolInputSchema` from. A bespoke result envelope is bespoke
  code — a matcher for it would add surface area and a case-2 divergence to maintain, and change
  no number.

  A **third** reason was recorded here and has since died: that the connectors whose read-only-kit
  callback is a named function reference never reach a statement-level blocker at all, failing
  earlier at `frame:no-mcp-server`. `recognizeReadOnlyFrame` now reads exactly that shape — see
  *A read-only-kit callback that is a named function reference* above — so all ten do reach
  statement-level blockers. It is struck rather than deleted because the conclusion did not
  depend on it, and a reason that expires is worth showing as expired.

  The sweep behind the proposal also under-counted the helper's own body shapes, and a table that
  claims to be exhaustive and is not is worth recording as such: beside the keyed pluck, the
  root-array pluck, the array-first prelude and the keyed-first root fallback, `figma` writes a
  loop flattener returning `Array<{ id; name }>` rather than `unknown[]`, so it keeps a
  `function:<name>From` blocker under any correct guard.
- **A validation warning on a large `maxLimit`.** It measures the wrong quantity. `maxLimit`
  caps how many matches are *returned*, not how many rows are *fetched* — the connector has
  already awaited the full response. A connector with `maxLimit: 50` against an endpoint
  returning 100,000 rows carries the whole memory cost and would draw no warning, while a
  legitimate 2000 would. Warning on response size would be defensible; warning on `maxLimit`
  would train authors to lower a number that is not the problem.
- **Making the URL/body treatment of an unset optional boolean consistent.** Both halves are
  right for their medium and one is byte-locked by the corpus. See
  [SPEC-RULES § Writes](./SPEC-RULES.md#writes-method-effect-and-body).
- **Generating a working Gateway `sync()`.** The shape it would assume fits 6 of the 98 real
  `*-sync.ts` files, and producing it would mean reproducing AGPL source nearly verbatim in an
  MIT repo. (The 6 is a re-measurement: this said 2, which was the two files the shape was
  find/replaced from rather than the number carrying it. The licensing half of the reason does
  not depend on the count.)
- **Splitting the emitter to write `src/tools.ts` and a shim `src/server.ts`.** Declined on a
  measurement taken 2026-08-09 against tree `67c7390a`, and it is the clearest case in this file
  of a plausible feature killed by looking rather than by arguing.

  Eleven connectors reported `frame:tools-in-second-file` and nothing else, which reads like a
  frame problem with an obvious fix: teach the emitter to write two files. Nobody could see
  inside those second files, so the fix was gated on reading them first. The deriver now does —
  **all eleven splice with zero refusals** — and behind the frame are `zod` and
  `mcp-tool-kit.ts` value imports (11 each), `statement:ExportNamedDeclaration` (11), hoisted
  helpers `isRecord` and `strField` (7 each) and `asArray` (6), five `safe-cli-arg` CLI
  connectors, and eleven newly-visible unrecognized registrations (`call:reg` 62 → 73).

  Not one of those is a frame gap. **The frame was never the binding constraint**; it was the
  first thing the deriver happened to refuse on. Splitting the emitter would have moved all
  eleven from one blocker to several and changed no tier, at the cost of a second emitted file,
  a spec field to select it, and an emitter path gated on a field the four byte-locked fixtures
  never set.

  Worth keeping for the method rather than the conclusion: the ROADMAP precedent said frame
  widening *reveals rather than clears* — measured once, on the split-registrar and
  inlined-transport axes, where 27 connectors got past the frame and not one reached `emits`.
  That precedent predicted this result before the work started, and the work was scoped as a
  measurement because of it. The reading half is kept: it is what makes the eleven's real
  blockers visible to whoever closes them.
- **Growing the spec with purely cosmetic fields.** `local` and `bindings` are permitted
  everywhere; beyond those, a field that changes only appearance is refused and the difference
  is recorded as an irreducible diff instead. Spec surface is the cost being controlled — a
  generator whose input is harder to write than its output is a failed generator.

  The bar is sharper than "no cosmetic fields", because `handlerStyle`, `argsSchemaStyle` and
  `staticPathStyle` are exactly that and were each admitted. It is **no cosmetic field without a
  fixture that byte-matches *because of* it** — which is why the frame idiom axes get none: no
  such fixture can exist until what sits behind those frames has itself been measured.

### On the `query` design

Six alternatives, each measured while conditional query parameters were being designed.

- **Extending the path-string DSL** with optionality and default markers (`${arg.after|enc?}`,
  `${arg.limit|num=50}`). Declined: it encodes control flow as punctuation, `?` and `=` would
  each mean two things, and query-versus-path would stop being structurally distinguishable. The
  DSL already rejects `{id}` and `/:id` because ambiguous path syntax caused real bugs.
- **Setting every parameter unconditionally**, letting absent ones render empty. Declined
  because it changes the request: `?after=` is not `after` omitted, several APIs treat an empty
  cursor differently from no cursor, and every corpus connector guards.
- **A `default` field on the query entry.** Declined as a second source of truth for a value the
  argument already carries.
- **An "inline this default" knob** to reach `google-meet`'s form. Declined as a formatting
  reproduction knob, consistent with the extractor guard/form/name decisions above.
- **Adding `!== null` to the `omitWhen: "empty"` guard.** Declined because `null` is
  unreachable: `ArgSchema` types an argument `string`, `number` or `boolean`, and zod's
  `.optional()` widens to `| undefined`, never `| null` — a JSON `null` fails the schema before a
  handler runs. Every corpus entry using the `"empty"` predicate guards on exactly
  `!== undefined && !== ""`. That is a claim about the `"empty"` entries specifically, not about
  all guarded entries: `circleci` and `github-actions` guard other args on `!== undefined` alone,
  which is the separate `"absent"` predicate, not this one with a clause missing. A third clause
  would emit a check that can never fire *and* forfeit every byte match it was added to protect.
- **Renaming the emitted URL local from `u`** to something less collision-prone (`urlObj`,
  `__url`). Declined, though the concern is fair. The corpus is genuinely split — across all
  connectors the name is `search` ×23, `u` ×20, `params` ×15, `qs` ×10, `body` ×2, `q` ×1 — so
  any choice matches some files and not others, exactly like the registrar naming and the
  transport tail. `u` is what `discord` and `google-meet` write, the two connectors this branch
  targets. Reserving it costs a spec author one rename of their own identifier.

### On the search-filter field entries

- **A tagged discriminated union for field entries** — `{ "type": "nested", "path": [...] }`
  rather than `{ "path": [...] }`. Declined: the required-key sets are already disjoint under
  `strictObject`, so the untagged form is unambiguous today and stays extensible — a future
  coercion kind is either a new disjoint shape or an optional key on an existing one. The cost
  would be paid on every entry an author writes. If union error messages prove poor in practice,
  the fix is a `superRefine` naming the unrecognised entry shape, not a keyword on every entry.
- **A deprecation warning on legacy `tags: true`.** Declined, and it would have been actively
  harmful. `tags: true` is not superseded — it is the *only* spelling that reaches the
  `fieldsFromKeys` form, which is what `zendesk` byte-matches on today. Steering authors off it
  would push them to the `fieldsOf` form and break byte matches.
- **Numeric or boolean extraction primitives** (`nestedNumber`, `booleanField`). Declined on two
  grounds. `stringField` and `nestedString` do not coerce — both are
  `typeof v === "string" ? v : ""` — and the connectors that need coercion (`databricks`, `dbt`,
  `flagsmith`) are among the 14 already out of reach. More decisively,
  `shared/search-filter.ts` exports no such primitive, and **the emitter may only compose helpers
  that already ship**: adding one means a change to the AGPL Nimbus repo *and* a release of the
  MIT SDK, neither of which this repository can make unilaterally.

## Non-goals

- **Generating Gateway sync handlers.** They live in `packages/gateway/src/connectors/` and are
  type-coupled to the monorepo. The generator prints a verified checklist of the sites to
  touch instead of guessing at code.
- **Vendoring any Nimbus source.** This repo is MIT and the monorepo is AGPL-3.0-only. The
  harnesses read a checkout at runtime; that constraint is permanent.
- **A Node/npm runtime path.** Bun-only by decision, for the CLI and its output alike. The sole
  exception is `npm publish --provenance` in CI, which is the only way to attach a sigstore
  attestation.
- **Changing what a connector *does*.** Search semantics, the tool-output envelope and the
  manifest vocabulary are Nimbus's to define. This generator reproduces them.
