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
> it and deleting it would leave a decision with no stated reason — `src/emit/wiring.ts`,
> `src/spec.ts` and `test/derive/frame.test.ts` are the three. **Each states its date, its tree,
> and the command that re-measures it.** A number carrying those can be checked; one without them
> is what the rule above forbids.

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

The org currently ships two connector scaffolders:

| | [`@nimbus-dev/create-connector`](https://github.com/nimbus-agent/nimbus-sdk/tree/main/tools/create-connector) | `create-nimbus-connector` (here) |
| --- | --- | --- |
| Approach | fixed templates | JSON spec → emitted source |
| Languages | TypeScript, Python | TypeScript |
| Output shape | `NimbusExtensionServer` handshake, then MCP | MCP over stdio, the existing corpus shape |
| Starting point | greenfield project | a described connector |
| Verified by | CI generates, installs, builds and runs it | byte-diff against 94 real connectors |

**The intent is that this repository becomes the single scaffolder** and
`@nimbus-dev/create-connector` is eventually retired. Two tools with near-identical names is a
choice users should not have to make.

That is a destination, and it has a price. This generator cannot absorb the other until it can
do three things it currently cannot:

- **[ ] Emit Python.** The whole emitter layer is TypeScript-shaped. This is the largest single
  item on this roadmap and needs its own design.
- **[ ] Emit the handshake shape.** The template tool produces a connector built on
  `NimbusExtensionServer`, which performs contract-version negotiation before serving MCP.
  This generator emits a connector that serves MCP over stdio directly. These are different
  products, not different formatting — supporting both means a second target on the existing
  `GenerateTarget` seam.
- **[ ] Answer `npm create`.** `npm create @nimbus-dev/connector` is a published entry point
  with users. Retiring it means either owning that name or providing a migration that does not
  silently change what people get.

Until all three land, both tools ship and the READMEs cross-link so an author can tell which
one they want. **Nothing here is a deprecation announcement**; it is a stated direction with
its conditions attached.

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
- [ ] **Multi-file connectors.** **16** connectors carry `src/tools.ts` (e.g. `elasticsearch`,
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
- [x] **Conditional query parameters.** A `query` array on a tool — `new URL(...)` plus
      guarded `searchParams.set(...)`, the guard chosen by `omitWhen` — lets a parameter be
      sent only when an optional argument is present or non-empty. See the README for the
      field and its rejections, and [Known limitations](#known-limitations) for what it still
      doesn't reach.
- [ ] **Conditional endpoint selection and enum arguments.** `bitrise`'s two non-search tools
      still select an endpoint from whether an optional arg is present and map a `z.enum`
      through a lookup table. Neither construct exists in the spec language.
- [ ] **CLI-backed connectors.** Five connectors shell out via `shared/safe-cli-arg` rather
      than `fetch`: `athena`, `cloud-logging`, `cloudwatch`, `sagemaker`, `vertex-ai`. All five
      write that CLI logic in `src/tools.ts`, so `bun run reach` reports them as
      `frame:tools-in-second-file`, not under a CLI-shaped bucket of their own — the construct
      itself is never reached. A separate set (`aws`, `azure`, `gcp`, `kubernetes`) shells out
      via `shared/run-cli-json` directly from `server.ts`, without `safe-cli-arg`, and *does*
      surface as its own bucket, `import-from:../../shared/run-cli-json.ts`.
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

### Stage F — authoring experience `[ ]`

- [ ] **Spec authoring from an OpenAPI document.** The largest reduction in effort available:
      most of a spec is endpoints, arguments and descriptions that an OpenAPI file already has.
- [x] **`--from-connector`**, deriving a starting spec from an existing connector directory, to
      make regeneration coverage measurable in bulk rather than one hand-written fixture at a
      time. Shipped, with `--partial` for a draft from a module that blocks; `bun run reach` is
      the bulk half, running the same deriver over a whole checkout. See
      [Known limitations](#known-limitations) for what its report does and does not carry.
- [ ] **Better validation errors**, pointing at the JSON path rather than naming the field.
- [ ] A JSON Schema for `ConnectorSpec`, published so editors can complete and validate a spec
      file.

### Stage G — consolidation `[ ]`

The three items under [Consolidation](#consolidation), then retiring
`@nimbus-dev/create-connector` with a migration path.

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

**Measured 2026-08-06 against `packages/mcp-connectors` tree `94fd3623` (Nimbus commit
`b3a6f159`).** This is the one place in this repository where the corpus *regeneration* counts
are written down, and it carries the date and the corpus tree so a reader can tell when it was
true. (Three source comments carry a measurement of their own, each dated and each with its own
re-measure command — see *How to read this* at the top of this document.) Re-measure
with `bun run reach --verbose --nimbus-root <path>`; the per-connector tiers for this same tree
are in `fixtures/reach-baseline.json`, which is regenerated by `bun run reach:baseline` and
never hand-edited.

**6 of 94 reach `server-identical`. 4 of those 94 reach `all-identical`** — the byte-locked
fixtures. The remaining **88 are `blocked`, and every one of them has a named cause.**

The grouping below is what makes the number a ceiling rather than a score. Each cause is either
a **spec-language gap** — a construct the spec cannot express, which no recognizer can close —
or a **recognizer gap**, a construct the spec *can* express and `src/derive/` does not read,
which is remaining work. A number without that split says nothing about which half is
achievable.

| Cause | Connectors | Which gap |
| --- | --- | --- |
| **Frame** — `frame:tools-in-second-file` (11), `frame:no-registrar` (4) | 15 | **spec-language**, both |
| **Manifest** — `manifest:missing-syncInterval` (`iac`) | 1 | **spec-language** |
| **Tool registration** — `call:reg`, eleven single-connector `call:register<X>Tool` buckets, `const-call:makeRestToolRegistrar` | 68 | mostly **spec-language**; see below |
| **Hoisted helper functions** — 173 distinct `function:<name>` buckets | 67 | **spec-language** |
| **Hoisted consts and schemas** — `statement:VariableDeclaration`, `method-call:.object`, `.extend` | 42 | **spec-language**, plus one downstream case |
| **Local type declarations** — `TSTypeAliasDeclaration`, `TSInterfaceDeclaration` | 9 | **spec-language** |
| **Imports** — 23 buckets: shared primitives, node builtins, per-connector modules | 61 | mixed, and mostly downstream |

**Those columns do not add to 88, and that is the most important thing to know about them.** A
connector is blocked by *every* statement nothing claimed, so one refusal upstream produces
several buckets downstream: a connector whose fetch helper is refused also reports its hoisted
base-URL const, its imports and its registrations as unclaimed, none of which is an independent
cause. **19 connectors carry exactly one bucket**, and only for those is the bucket the whole
story: the 15 frame-only ones, `iac`, and `intercom`/`lever`/`readwise` on `function:authHeader`.
Read the histogram as a map of constructs, not as a ranking of causes.

Four groups are worth naming precisely, because each is a *different* kind of gap:

- **The frame group is the cleanest ceiling in the corpus.** Fifteen connectors are blocked by
  their wiring shape and nothing else. Eleven put their tools in `src/tools.ts`, and the
  generator emits one source file; four (`apple`, `fastmail`, `imap`, `protonmail`) wire through
  a bespoke `registerXTools(server, …)` with no `createZodToolRegistrar`, and `style` has three
  values, none of which is that. Both are spec-language gaps — no recognizer can close either,
  because the emitter cannot write what it would be reading.
- **The named argument-schema const is the largest single closable-looking shape, and it is
  not one recognizer.** Twenty connectors hoist `const <name>Schema = z.object({ … })` to module
  scope — 109 such declarations — and pass it to `reg` by name. **Five** connectors compose with
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
- **The narrowest gap in the whole corpus is two env fields.** `function:authHeader` blocks 15
  connectors, and for `intercom`, `lever` and `readwise` it is the *only* bucket: three
  connectors one construct from deriving. All three write an `Authorization` value `EnvSchema`
  cannot state — an alternate scheme (`readwise`'s `` `Token ${…}` ``), a basic credential whose
  second half is a literal `""` (`lever`), or a static extra header beside a bearer one
  (`intercom`'s `Intercom-Version`). `auth: "headers"` does not reach them either: it maps each
  var to a header name and emits the binding bare, with no scheme prefix and no literal-valued
  key. A spec-language gap, and a small one.
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

#### Two follow-ups, both deliberately not built here

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

**Content no spec field can derive.**

- **Hand-authored READMEs.** Several real connectors carry prose naming their specific item
  types, their tool names and their deferred follow-ups. The generator emits boilerplate. This
  is a content gap, not a formatting one, and no rewording closes it.
- **`*-mapping.ts` bodies.** No spec field describes a service's API response shape.

**Constructs outside the spec language.**

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
- **`auth: "bearer"` cannot express two real shapes**, surfaced by the `discord` fixture.
  Discord's own scheme is a literal `Bot ${token}`, not `Bearer ${token}`, and it sends a
  static `User-Agent` header alongside the `Authorization` one. No env field today carries an
  alternate scheme string or a static extra header, so this connector's auth shape is not
  reachable regardless of what `query` can express.
- **A validator over-rejection in hoisted-argument-local uniqueness.** `src/validate.ts`
  claims every tool's hoisted argument locals into one map shared across the whole connector,
  but each is emitted inside its own tool's arrow function (`renderHoists`), so two tools
  declaring the same defaulted arg name can never actually collide in the generated file — the
  spec is rejected anyway. `fixtures/google-meet.spec.json` carries `"local":
  "searchPageSize"` purely to work around this. Pre-existing, not introduced by this stage,
  and not fixed here.
- **Conditional endpoint selection and enum arguments.** Choosing a path from whether an
  optional arg is present, or mapping a `z.enum` through a lookup table.
- **Multi-file connectors.** Some split tools into `src/tools.ts`; the generator assumes one
  source file.
- **CLI-backed connectors.** A handful shell out rather than calling `fetch`.
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
  primitive, a non-bearer auth scheme, or an extra static header cannot be expressed — the
  rest-kit `fetchHelper` has no `authScheme` field and forbids `${env.*}` references, since the
  credential is resolved by the registrar rather than an env accessor.
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

## Considered and declined

Recorded so they are not re-proposed. Each was measured before being rejected.

- **Coercing the row set before `matchesResult`** (`accounts ?? []`). The guard already exists
  one level down — `matchesResult` does `Array.isArray(rows) ? … : []`, so `undefined`, `null`
  and any non-array already yield an empty match set. The coercion would be dead code that
  changes a byte-exact fixture's bytes.
- **Recovering `rows` from a hoisted pluck helper.** Proposed as a case-2 widening (see
  [the roadmap-completion design](./superpowers/specs/2026-08-05-roadmap-completion-design.md)'s
  *Application: the rows pluck*): corpus connectors commonly hoist
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
  `recognizeNoRowsBody` and `recognizeRowsBody` already read. That same design document's trap
  list had measured this from the other side — a connector that carries `src/search-filter.ts`
  without calling `matchesResult` builds its own envelope and is "out of the recognizer's reach
  by construction, not by omission" — so that proposal and that trap could not both be true, and
  the trap is the half backed by a measurement.

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
  right for their medium and one is byte-locked by the corpus. See the README.
- **Generating a working Gateway `sync()`.** The shape it would assume fits 6 of the 98 real
  `*-sync.ts` files, and producing it would mean reproducing AGPL source nearly verbatim in an
  MIT repo. (The 6 is a re-measurement: this said 2, which was the two files the shape was
  find/replaced from rather than the number carrying it. The licensing half of the reason does
  not depend on the count.)
- **Growing the spec with purely cosmetic fields.** `local` and `bindings` are permitted
  everywhere; beyond those, a field that changes only appearance is refused and the difference
  is recorded as an irreducible diff instead. Spec surface is the cost being controlled — a
  generator whose input is harder to write than its output is a failed generator.

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
