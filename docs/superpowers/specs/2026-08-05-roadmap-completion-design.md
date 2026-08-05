# Finishing the roadmap — design

**Date:** 2026-08-05
**Status:** designed
**Roadmap item:** all of it. [Stage E](../../ROADMAP.md#stage-e--the-corpus-tail-) closes with a
measured ceiling, [Stage F](../../ROADMAP.md#stage-f--authoring-experience-) ships in full, and
[Stage G](../../ROADMAP.md#stage-g--consolidation-) becomes a scoping document rather than three
open checkboxes.

**This document is itself temporary.** Its durable conclusions fold into `README.md`,
`docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/GLOSSARY.md` and a new `docs/CONSOLIDATION.md`;
the file is then deleted along with the rest of `docs/superpowers/`, following commit `ef59c13`.
Git history keeps it. Nothing here is meant to survive as a document anyone maintains.

---

## 1. The problem, and the measurement that reframed it

`docs/ROADMAP.md` carries eleven open `[ ]` items across three stages. The intent is to finish
them. The first thing to establish is what finishing them is actually worth, because the
roadmap's own framing — Pillar 2, *"the honest measure of coverage is how many of the 94
connectors could be regenerated from a spec"* — implies the remaining work moves that number a
long way.

Measured on 2026-08-05 against `C:/gitrep/Nimbus` at `packages/mcp-connectors` tree
`e3751a3a`, `bun run reach` reports:

```
REACH  4/94  (server.ts byte-identical)
  spec derived + emits   4/94
  server.ts identical    4/94   <- headline
  all files identical    4/94
```

All three sub-tiers are 4. Nothing in the corpus is currently derived-but-different, so the
distinction between *functional* and *byte* reproduction — which the four tiers exist to draw —
has never actually been visible in a run.

The largest histogram buckets are `call:reg` (47), `import-from:./search-filter.ts` (39),
`statement:VariableDeclaration` (37), `import-from:../../shared/mcp-search-tool.ts` (36),
`function:authHeader` (23), then the three `frame:*` idiom buckets (27 combined) and
`import-from:./tools.ts` (11).

### The instrument's own shape distorts the reading

Two mechanisms in `scripts/_lib/derive/` mean a bucket count is **not** a connector count, and
both were rediscovered the hard way while designing this:

- **Frame failure short-circuits.** `deriveSpec` returns immediately when `recognizeFrame`
  fails (`scripts/_lib/derive/index.ts:262-264`), carrying exactly one blocker. So the 31
  frame-blocked connectors have **never been measured past their first line**. A histogram
  where each of them shows a single blocker reads as "nearly there" and means "unexamined".
- **`recognizeTools` is all-or-nothing.** One unmodeled handler leaves every `reg(...)` in the
  module unclaimed, so a connector contributes one `call:reg` entry whether it has one
  unreadable shape or five. `call:reg = 47` is 47 connectors, not 47 problems, and it hides
  how many *distinct* problems sit behind each.

Both are correct behaviour — claiming nine of ten tools would derive a spec that silently drops
the tenth — and both make the obvious inference from the histogram wrong.

### What that costs, measured rather than predicted

Inverting the verbose histogram per connector and treating a connector as cleared only when
*every* one of its buckets is covered:

| if these recognizers landed | connectors fully unblocked |
| --- | --- |
| `search` + `search-filter` alone | **0** |
| + module-scope `const` | **0** |
| + the env/auth/base/trim/fetch helper shapes | 13 |
| + `query` + `body` | 13 |

The recognizer-set design calls search *"the widest single unlock"*. On its own it moves
nothing: every one of those 39 connectors also carries `statement:VariableDeclaration`,
`function:authHeader`, `function:trimTrailingSlash` or a `function:<x>Get` bucket.
`test/scripts/derive-round-trip.test.ts:68-73` already says this for five fixtures; it holds
corpus-wide.

**And the 13 is itself too high**, for the `call:reg` reason above. Reading the sources rather
than the buckets: `bitrise` and `codemagic` branch on `if (p.<arg> === undefined)` — conditional
endpoint selection, already outside the spec language; `netlify` and `stripe` build a
`new URLSearchParams` const before the fetch, and `netlify` passes `root` with no pluck;
`intercom`'s `authHeader` returns a third header that `renderSplitBearer`'s own docstring names
as out of scope; `lever` uses Basic over one var with an empty password, which `renderBasic`'s
two-var rule excludes.

**The genuinely deriver-only cohort is two connectors: `mercury` and `zendesk`** — and
`fixtures/expectations.json` already lists `src/server.ts` in both of their expected-match sets,
so `diff:golden` proves the emitter can reproduce them from a hand-written spec. What is missing
is the deriver's ability to *produce* that spec.

### A second gap that would have swallowed the whole result

`deriveSpec` emits no `argsSchemaStyle`, and `recognizeFetchHelper` recovers no
`staticPathStyle`. Both fixtures set both fields. Re-emitting each fixture with the two fields
stripped, and counting differing lines of `src/server.ts`:

| fixture | `argsSchemaStyle` | `staticPathStyle` | differing lines |
| --- | --- | --- | --- |
| `mercury` | `expanded` | `template` | **21** |
| `zendesk` | `expanded` | `template` | **21** |
| `netlify` | `expanded` | `template` | 34 |
| `dependencytrack` | `expanded` | *(unset)* | 38 |

Without style recovery, every recognizer below lands at `emits` and the headline stays 4/94.
With it, the same work reaches 6/94. That is the entire difference between the programme being
worth doing and being a large branch that ends where it started, and it is the reason style
recovery is sequenced first rather than last.

### Three counts this document had to correct in itself

Recorded because the roadmap's *Measuring reach* section exists for exactly this reason, and
because each error here was the same **method** error it names — reading names instead of bodies,
or reading buckets instead of connectors.

- **A layered projection claiming 13 / 25 / 52 connectors cleared.** Wrong: it treated a
  connector's single `call:reg` bucket as covered by the search recognizer, when for
  `bitrise`, `codemagic`, `netlify` and `stripe` that bucket also hides a shape no recognizer in
  scope touches. Bucket-to-connector inference, the error this document then documents.
- **"All 31 frame connectors are blocked by nothing else."** Wrong, and an artifact: frame
  failure short-circuits, so nothing behind them has been measured. They are not near-misses;
  they are unexamined.
- **Classifying `function:` buckets by name.** `dagsFrom` and `projectsFrom` were called bespoke
  response-shaping helpers. Reading the bodies: they are the `rows` envelope pluck plus the
  `Array.isArray` coercion that *Considered and declined* already refuses to emit. Right bucket,
  wrong reason — and the same name carries different bodies in different connectors
  (`projectsFrom` is a pluck in `dependencytrack` and bespoke in `figma`; `flattenJobs` is a
  pluck in `dagster` and bespoke in `jenkins`), so a name-keyed classification is wrong by
  construction.

---

## 2. Scope

**Stage E** — build out the recognizer set, apply the case-2 rule below, re-baseline, then write
the ceiling into *Known limitations* and close the stage. Its four named tail items move to
*Considered and declined* with their measurements; **conditional endpoint selection stays open**,
reworded, because it is an 11-connector idiom rather than the `bitrise` quirk the current bullet
implies.

**Stage F** — ship all four items.

**Stage G** — design, do not build. One document, `docs/CONSOLIDATION.md`.

**Release condition** — the repo is intended to sit unattended after this. CI, docs and hygiene
are in scope as their own work, not as a footnote.

**Explicitly out of scope**, so it is not rediscovered as an omission: emitting Python (§6),
generating a working Gateway `sync()` (already declined), vendoring any Nimbus source (permanent),
and adding cosmetic spec fields for the frame idiom axes (§4 explains why the evidence that would
justify them does not exist yet).

---

## 3. The approach: the deriver is a product surface, not a harness

`scripts/_lib/derive/` and Stage F's `--from-connector` are the same code pointed at different
directories. Treating them as one thing decides several open questions at once, and it is the
reason the sequence in §5 interleaves rather than finishing the harness first.

The alternative — complete the instrument, then build the features — was considered and rejected
for one specific reason: we now know the instrument's headline moves 4 → 6. A long branch whose
only visible output is that number has to be justified by it, and it cannot be. The same commits
justified as *"this command can now read one more real connector"* stand on their own, and the
reach number becomes a by-product.

### 3.1 The move, and the decision it reverses

`CLAUDE.md` and `.claude/commands/cnc-reach-deriver.md` both state that the deriver **must stay** under
`scripts/`: `package.json`'s `files` is `["src", "README.md"]`, so shipping it would put
unreachable code and an unresolvable `@babel/parser` import into every published tarball.

That reasoning is correct today and stops being correct the moment `--from-connector` exists —
the code is then the feature, not dead weight. The dependency half already has a precedent in
this repo: `@biomejs/js-api` and `@biomejs/wasm-nodejs` are `optionalDependencies`, and
`src/format.ts` fails loudly when they are absent. `@babel/parser` follows that pattern exactly.

**Both documents are updated in the commit that moves the directory**, so the rule does not
survive as a stale prohibition. This is a reversal, stated as one.

### 3.2 `blocked` is a result, not an error

When the deriver cannot read a connector, the CLI prints the same blocker labels `reach` prints —
`frame:registrar-not-inlined`, `call:reg`, `import-from:./tools.ts` — with the source line. The
user learns which construct stopped it; we learn which recognizer to write next. It is the one
output the harness and the feature genuinely share.

### 3.3 Partial derivation must be `parseSpec`-invalid by construction

A draft a human reads with TODOs on screen is not a gate that lies, so partial output is allowed.
But a partial spec that *validated* would silently generate a connector missing tools — which is
precisely the accepted-then-discarded failure mode this repo has already removed twice. So partial
output carries a marker `ConnectorSpecSchema` rejects, and making it validate is the author's
edit. `z.strictObject` at every level means there is no annotation channel, so the marker is a
top-level key the schema refuses by name rather than a comment.

### 3.4 Two preconditions before it ships to anyone

- **`method` / `effect` recovery.** `ToolFields` carries no `method`, and `fetchPathArgument`
  takes `args[0]` without inspecting the callee, so `<helper>Send(path, "POST", body)` derives as
  a **GET read tool** — losing `method`, `effect`, and therefore the manifest's `hitlRequired`.
  It is dormant only because the `<local>Send` declaration is itself unclaimed
  (`zzwriteonly` / `zzwriterest` are `BLOCKED` on "write body"), and goes live in whichever commit
  first writes a write-helper recognizer. This is the one item in the whole programme that
  produces a silently **wrong artifact** rather than a byte mismatch. The hand-rolled recognizer
  should also cross-check the awaited callee against the recognized `fetchHelper.local`, which
  `deriveRestKitSpec` already does for rest-kit.
- **The licensing answer, written down.** The reach design deferred it explicitly: *"The
  authoring-aid form of `--from-connector` is a separate feature with a separate licensing
  answer, deliberately not designed here."* The answer this design proposes: deriving a spec on a
  user's machine from a checkout they already have is not vendoring — the output is a description,
  it is produced locally, and nothing AGPL enters this repository. It goes in `docs/` under its
  own heading, and it states the one thing that remains forbidden: **a spec derived from a real
  connector may not be committed to `fixtures/`.** That is what keeps `CLAUDE.md`'s
  hand-written-fixtures rule intact.

### 3.5 The standalone recognizer comes before any corpus recognizer

`isFrameImport` accepts only the monorepo's kit imports, so every standalone package this tool
emits derives as `frame:no-kit-import` — **0% on the shape a third-party author would actually
point the flag at.** It also needs no AGPL checkout, which makes it the only Stage F work
verifiable in CI.

It is a **new recognizer, not a loosened one.** Relaxing `isFrameImport` in place would silently
change what `reach` claims against the corpus. Standalone also inlines `runReadOnlyMcpConnector`
and `searchToolInputSchema` as local declarations, which the totality rule would surface as
unclaimed — so the recognizer claims those too, or reports them.

---

## 4. The case-2 rule

The deriver's existing rule is *"match only what the emitter can actually produce."* It conflates
two cases that fail differently:

1. **A matcher that cannot correctly recover the spec fields** from a shape. Widening it produces
   a wrong derivation reported as a success — the defect class the totality rule is structurally
   blind to, and the reason the rule exists.
2. **A matcher that can recover every field correctly**, where only the emitted *text* differs.
   The connector derives, emits, and the byte-compare honestly reports `emits` rather than
   `server-identical`.

Case 2 cannot manufacture a false `server-identical`, because the byte compare is real and runs
regardless. It *can* manufacture a false `emits`. So:

> **A recognizer may claim a shape the emitter does not write only when both hold:**
> **(a)** the divergence is already recorded in *Known limitations* or *Considered and declined*,
> and **(b)** a test proves every spec field recovered from that shape is correct.

Condition (b) is what separates case 2 from a widened matcher, and it is not optional.

### 4.1 Application: the rows pluck

`dagsFrom(root)` → `rows: "dags"`. The divergence is *Considered and declined*'s
*"Coercing the row set before `matchesResult`"* — the emitter writes the pluck inline in the
handler and lets `matchesResult` guard with `Array.isArray` itself. Fields recovered: the pluck
key. Nothing else.

### 4.2 Application: the frame idiom axes

Worth stating precisely, because it is easy to conflate the two directions:

- Reaching **`server-identical`** on these axes *would* need cosmetic spec fields, because
  `wiring()` and `tail()` hardcode the inlined registrar and the two-statement transport.
- Reaching **`emits`** needs none. The deriver recognizes the corpus form, derives a spec with no
  new field, and the emitter writes its own form.

**We do the second only.** `frame:registrar-not-inlined` (13), `frame:tail-inlined-transport` (4)
and `frame:readonly-callback-not-inline` (10) become derivable; `frame:no-registrar` (`apple`,
`fastmail`, `imap`, `protonmail`) does not — those wire tools through a bespoke
`registerXTools(server, …)` call and are genuinely structural.

**The registrar and transport axes must land together.** `frameFailureKind` checks the registrar
element first, so `google-meet` and `google-photos` — which write *both* near-miss shapes — are
reported on the registrar axis and stay blocked if only one closes.

The named read-only callback splices the named function's body into `toolStatements` while leaving
the wrapper verified-but-unclaimed, which is the two-list contract read-only-kit already documents
and inherits unchanged.

### 4.3 Why this settles the cosmetic-field question instead of arguing it

The roadmap declines *"growing the spec with purely cosmetic fields"*. But `handlerStyle`,
`argsSchemaStyle` and `staticPathStyle` are already exactly that, each admitted because a fixture
byte-matched *because of* it. The operative bar is therefore not "no cosmetic fields" but **"no
cosmetic field without a fixture that byte-matches because of it"** — and for the frame axes no
such fixture can exist today, because nothing behind those frames has ever been measured.

Case-2 widening produces the evidence. Whether the fields are then justified is a decision for
whoever reads that evidence, and this document deliberately does not pre-empt it.

---

## 5. The work, in order

Effort letters are S/M/L. The dependency arrows are the part that matters; the grouping is not.

**Eighteen items is more than one implementation plan should carry**, and the phases below are the
decomposition: **one plan per phase, written only after the previous phase lands.** That ordering
is not bureaucracy — the predecessor plan's ~11 defects came from writing recognizer code against
an accessor layer that did not exist yet, and phase 2's recognizers are written against a
`src/derive/` whose final shape is an *output* of phase 1. Each phase delivers working software on
its own and the work can stop cleanly at any phase boundary.

### Phase 1 — the deriver becomes shippable

| # | item | effort |
| --- | --- | --- |
| 1 | `scripts/_lib/derive/` → `src/derive/`; `@babel/parser` → `optionalDependency`; update `CLAUDE.md` and `cnc-reach-deriver` | S |
| 2 | **Harden:** recover `method`/`effect` from `<helper>Send`; refuse an awaited callee that is not the recognized fetch helper | S |
| 3 | `--from-connector`, with `blocked` as a first-class result and the `parseSpec`-invalid partial mode | M |
| 4 | The licensing answer, in `docs/` under its own heading | S |
| 5 | The standalone frame recognizer (`frame:no-kit-import` → derivable); CI-verifiable, no AGPL checkout | M |

Item 2 blocks item 3. Item 1 blocks both.

### Phase 2 — completing the recognizer set

| # | item | effort |
| --- | --- | --- |
| 6 | **Style recovery:** `staticPathStyle` (a `StringLiteral`-vs-`TemplateLiteral` discriminator `recognizePath` already computes and discards) and `argsSchemaStyle` (a `loc.start.line` comparison on a field `AstNode` already exposes) | S |
| 7 | Hoisted base const — accept an `Identifier` in the base position of `reconstructBase` and its rest-kit twin `matchRestUrlConst`, resolve it against a module-scope `const X = "<literal>"`, record `fetchHelper.baseConst` | S |
| 8 | `search` + `search-filter` recognizers | M |
| 9 | Env: the split-bearer pair (`env.tokenLocal`), `auth: "basic"`, and the `trimTrailingSlash` claim | M |
| 10 | `query`, `body`, `client-credentials` | M |
| 11 | Case 2: the rows pluck | S |
| 12 | Blocker-label honesty: a `frame:tools-in-second-file`-style label for the 11 shim connectors; rename `iac`'s `no-manifest` | S |
| 13 | Case 2: both frame wiring axes **together**, plus the named read-only callback | M |
| 14 | Re-baseline, write the ceiling into *Known limitations*, close Stage E | S |

Item 6 must precede 7–11 or they all land at `emits`. Item 12 changes no number by design.

**Traps to carry into the implementation plan**, each already paid for once:

- The search recognizer must **refuse** the no-pluck `const root` variant, any pre-fetch
  `new URLSearchParams` const, and every hand-rolled result tail — all shapes `renderSearchTool`
  cannot write. Measured 2026-08-05: **49** connectors carry `src/search-filter.ts` but only
  **22** call `matchesResult`, so 27 build their own envelope and are out of the recognizer's
  reach by construction, not by omission.
- Search tools must be **excluded from `recognizeTools`' `handlerStyle` vote**;
  `renderSearchTool` always writes a hoist-free block and would otherwise force
  `handlerStyle: "block"` on the whole connector.
- The split-bearer recognizer must consume **both** functions into one entry. `recognizeEnv`
  currently claims the inner reader as a standalone plain entry, and only the unclaimed wrapper
  stops a wrong spec today — a live instance of the wrongly-claimed class.
- Gate the `trimTrailingSlash` claim on an entry actually carrying `transform:
  "trimTrailingSlashFn"`, and match the emitted constant rather than the function name.
- `argsSchemaStyle`'s connector-wide vote must **tolerate abstentions**: Biome re-wraps an
  over-long inline object, so a long-arg tool yields no evidence and silence is not a vote.
- Claim the two search imports **only after** a search tool is positively recognized, the same
  scoping `recognizeReadOnlyFrame` uses.
- `grafana` declares an **argument named `query`** with `"default": ""` and `"local": "q"`, so it
  sits on the `isHoisted`/`renderHoists` path. Any work touching defaults or hoist rendering must
  re-diff `grafana` specifically — "the four fixtures declare no `query` array" is true and does
  not cover this.

### Phase 3 — Stage F's remainder

| # | item | effort |
| --- | --- | --- |
| 15 | `--from-openapi <doc>`, `--list-operations`, `--op` | M |
| 16 | JSON-path validation errors; `ConnectorSpec` JSON Schema generated from the zod schema | M |

### Phase 4 — Stage G and release condition

| # | item | effort |
| --- | --- | --- |
| 17 | `docs/CONSOLIDATION.md` | S |
| 18 | Release condition: CI punch list, doc updates, `bun run preflight`, retire `docs/superpowers/` | M |

---

## 6. Stage F and Stage G, in detail

### 6.1 `--from-openapi`

**No new dependency.** `Bun.YAML.parse` exists in the Bun version pinned across all four
workflows, handles aliases and multi-document input, and parses a synthetic 1,000-operation
document in 4 ms. Internal `$ref` resolution is ~50 lines; the document subset is expressed as a
second zod schema.

**Fills automatically:** `path` (OpenAPI's `{id}` → `${arg.id|enc}`, a substitution
`src/emit/server/path-template.ts` already prescribes by name), `method`, `args` with
type/optional/default/min/max/int, `body` from a flat request schema, `fetchHelper.base` and
`network` from `servers`, and the env auth mode from `components.securitySchemes`. That reaches the
majority of what a spec's tool bodies contain — **59 of the 94** corpus connectors percent-encode
at least one path argument, and every `method` and `body` map in the corpus falls inside this set.

**Cannot fill at all:** `style`, the three style fields, `syncInterval`, `minNimbusVersion`, tool
names, the connector `description` (the corpus ones are Nimbus design notes naming vault keys and
spawn-time hooks, not API prose), `impl: "search"`, `rows`, `maxLimit`, `filter.*`, `omitWhen`'s
absent-vs-empty choice, `credentialsIn`, env var names, and `effect` for non-GET operations.

**Shape of v1:** output printed to **stdout**, validated through the real `parseSpec` /
`validateSpec` before printing, never a written package. Every unmappable construct is refused
**by name** rather than silently omitted. TODOs live inside description strings, exactly as
`src/prompts.ts` already does. It adds no emitter path and no spec field, so the four byte-locked
fixtures cannot move.

### 6.2 `docs/CONSOLIDATION.md`

A new file rather than a `ROADMAP.md` section: it is a standing statement with conditions, it
outlives the roadmap's open items, and it needs room for a precondition nobody has recorded.

- **The handshake is small, and currently mis-described.** `NimbusExtensionServer` is a stub whose
  `registerTool` discards both arguments and whose `start()` only validates `manifest.id`. The
  template tool never imports it — `templates/typescript/main.ts:23` imports `performHandshake`
  from `@nimbus-dev/sdk/ipc` and then serves MCP through the same `McpServer` /
  `StdioServerTransport` this generator already emits. So it is a ~45-line rewrite of `tail()` in
  `src/emit/server/index.ts`, gated on a new `contractVersions` field that **zero of the 94 corpus
  manifests declare** — byte-safe by construction — and **not** a third `GenerateTarget`. Two
  sentences in `ROADMAP.md` and one at `README.md:35` say otherwise and inflate this blocker.
- **Python is unschedulable, and the roadmap should say why rather than carry an open `[ ]`.**
  There is no Python connector-kit in the SDK (an open Phase 3 item there, which is why the
  template inlines its own `_on_list_tools` / `_on_call_tool`); `formatAll()` runs Biome, which has
  no Python formatter; and decisively there is **no Python corpus**, so `diff:golden`, `reach` and
  the four-fixture byte invariant have no analogue. Every quality mechanism this project has is
  unavailable for Python output, against a fixed template a tree copy already reproduces exactly.
- **`npm create` is release infrastructure**, complicated by the SDK's own design document having
  rejected the unscoped name this repo holds, and by `npm create` running under Node in a
  Bun-only project.
- **A fourth precondition, on nobody's list:** the SDK's published manifest schema declares
  `permissions` an **array**, while all 94 corpus manifests and the gateway use an **object**. The
  two tools emit type-incompatible manifests on a required field, and no generator work resolves
  it. It is owned by neither repository, which is why it needs recording.

Plus the free interim item: the cross-link is one-directional. This README points at
`@nimbus-dev/create-connector`; the SDK repo has no reciprocal link.

---

## 7. Release condition

The repo is intended to sit unattended. That makes three things work rather than housekeeping.

### 7.1 State CI's ceiling, the same way reach's is stated

`diff:golden`, `reach`, `wiring:conformance` and `acceptance` all need the AGPL monorepo and
**cannot ever run in CI**. `ROADMAP.md` already refuses the tempting fix — *"Do not add a CI job
that skips when the root is absent; a silently-skipping gate is the failure mode this repo keeps
removing."* So CI is permanently partial, and the honest form is to say what it proves, what only
a local run proves, and why that is not fixable.

### 7.2 `bun run preflight`

One command running the local gate sequence in order. It follows the pattern
`standalone-acceptance` established: when the Nimbus root is absent it reports the local-only
gates as **SKIP**, loudly and by name, and deliberately does **not** print the sentence a
fully-verified run prints. A preflight that silently omitted four gates would be the exact
false green this repo exists to avoid.

### 7.3 Documents

| doc | change |
| --- | --- |
| `README.md` | the `NimbusExtensionServer` correction at :35; `--from-connector` and `--from-openapi`; the published JSON Schema |
| `docs/ARCHITECTURE.md` | the deriver at `src/derive/`; the new recognizers; the case-2 rule as a stated invariant |
| `docs/USAGE.md` | walkthroughs for both new flags |
| `docs/GLOSSARY.md` | the four reach tiers, the three frame styles, case 1 vs case 2 |
| `docs/ROADMAP.md` | Stage E closed with the ceiling; Stage F closed; Stage G → `CONSOLIDATION.md` |
| `docs/CONSOLIDATION.md` | **new** (§6.2) |
| `CLAUDE.md` | the deriver-stays-in-`scripts/` rule reversed; gate table gains `preflight` |
| `.claude/commands/cnc-*.md` | `cnc-reach-deriver.md` states the reversed rule as law and must change in the same commit; `cnc-add-fixture.md` is missing two steps (§7.5) |
| `docs/TESTING.md` | **new** — the test-honesty matrix (§7.5) |
| `docs/SPEC.md` | **new** — generated field reference, from the same source as the published JSON Schema (§7.5) |

`docs/superpowers/specs/` and `plans/` are deleted last, per `ef59c13`.

### 7.4 Hygiene

Baseline at HEAD (`9c0886f`, measured 2026-08-05): `bunx tsc --noEmit` exit 0, `bunx biome check
src/ test/ scripts/` exit 0, `bun test --coverage` exit 0 with 1139 passing across 60 files and
per-file coverage at or near 100% on nearly every module. The repo is in strong condition; this is
a punch list, not a rescue.

Known items: 30+ stale local branches; `CLAUDE.md` quotes `bunx tsc --noEmit` and `bunx biome
check …` while `package.json` also defines `typecheck` and `lint` scripts, so one gate has two
spellings.

### 7.5 The audit punch list

An audit of the test suite, the README's claims and the non-README documents ran on 2026-08-05
against `9c0886f`. Each item below was re-verified by hand before being written here; items the
audit raised that did not survive that check are not listed.

**The CI/CD half of that audit — the seven workflows, `dependabot.yml`, `codeql-config.yml`, the
required-check set and the release path — had not returned when this was written, and its findings
belong in this section.** Phase 4 does not start until it has been run and folded in. Recorded as
an open gap rather than silently omitted, because a punch list that looks complete and is not is
the same failure this repo keeps removing.

**Three are defects in `src/`, not documentation.**

- **`rows` is emitted as an identifier but is neither identifier-checked nor collision-checked.**
  `src/spec.ts:364` types it `z.string().min(1).optional()`, `src/validate.ts` never claims it, and
  `src/emit/server/search.ts:62-63` emits
  `const ${rows} = (root as { ${rows}?: unknown[] } | null)?.${rows};`. So `"rows": "class"` emits a
  syntax error and `"rows": "root"` emits a duplicate declaration against the `const root` one line
  above. This is the exact class `RESERVED_IDENTIFIERS` exists to move to parse time, and
  `CLAUDE.md` records that it has been missed twice already. Fix: identifier regex on the field,
  and claim it in `validateSpec` beside the hoisted-arg locals.
- **Nothing verifies `RESERVED_IDENTIFIERS` is complete.** The list is hand-maintained against
  emitter paths that keep growing; `CLAUDE.md` asks for it to be updated in the same change, which
  is a convention rather than a gate. It should be checked mechanically the way
  `test/cli.test.ts` checks `--help` against `parseFlags`.
- **`bun test` never compiles hand-rolled or rest-kit emitted `server.ts`.**
  `test/emit/emitted-typecheck.test.ts` compiles a subset, and its docstring does not say which —
  so the strongest in-CI check has a hole its own documentation hides.

**Two are README claims that are false at HEAD**, both verified against the emitter:

- `README.md:159` says a `DELETE` whose only arg is in the path sends "no body (and no
  `Content-Type` header)". `src/emit/server/fetch-helper.ts:157` writes
  `"Content-Type": "application/json"` unconditionally in `<local>Send`.
- The same line documents the default body as "every arg not referenced in the tool's path".
  `src/emit/server/body.ts:96` also excludes every `query` entry's arg — a rule added with `query`
  and never written down.

Plus: `README.md:34` overclaims byte-identity across the whole corpus (four fixtures reproduce
6/6, not 94); `README.md:63`'s "`local` and `bindings` are permitted everywhere" is wrong on three
counts; the six-files framing is monorepo-only (standalone emits seven, and `biome.json` is
documented nowhere); the interactive-prompt list is wrong in both directions; and `README.md:17`
calls itself "the reference" while roughly half of `ConnectorSpecSchema`'s accepted surface
appears in no prose document at all.

**Two are gaps in the gate lists**, which is the pillar-3 concern in its purest form:

- **`reach --baseline` is named in no canonical gate list except `ARCHITECTURE.md` and
  `cnc-preflight.md`.** `CLAUDE.md`'s table has a `reach` row but no `--baseline` row;
  `CONTRIBUTING.md` contains no occurrence of `reach` at all and tells contributors about two of
  the four local gates; `RELEASING.md:68` and `ci.yml:61` both say "three gates need a Nimbus
  checkout" when there are four. A tier-regression gate no checklist names is a gate that silently
  stops being run. `bun run preflight` (§7.2) is the structural fix; the lists are the immediate
  one.
- **`fixtures/snapshots/` and `bun run snapshot:update` are documented nowhere**, and
  `cnc-add-fixture.md` omits both that step and the `derive-round-trip.test.ts` step — so following
  the fixture guide end-to-end leaves `bun test` red.

**And a dangling citation.** `design decision D4` is cited in `.github/workflows/acceptance.yml:14`,
`.github/workflows/ci.yml:66` and `CONTRIBUTING.md:37`, and resolves to a document retired in
`ef59c13`. Since this design retires `docs/superpowers/` too, the rule generalises: **a citation
must name a document that still exists, or state the reasoning inline.** Every retirement commit
checks for new dangling references.

**Two new documents the audit argued for**, both accepted:

- **`docs/TESTING.md`** — the test-honesty matrix. For each style × target, which check actually
  compiles the emitted output, which only substring-asserts it, which byte-compares against a
  snapshot, and which needs an out-of-CI gate. That reasoning currently lives in four places that
  disagree at the edges, and "is this emitter change safe to merge?" cannot be answered without
  reconstructing it. It also carries what the coverage gate *structurally cannot see*: a file no
  test imports never enters the report at all; subprocess execution is invisible; and files
  generated into temp directories and dynamically imported **do** get measured and **do** fall
  under the per-file floor.
- **`docs/SPEC.md`** — a complete field reference generated from the zod schema, from the same
  source as the published JSON Schema (item 16) so the two cannot drift. This is what makes
  `README.md:17`'s "reference" claim true rather than removing it.

---

## 8. The expected result, stated in advance

**`server-identical` goes from 4/94 to 6/94** — `mercury` and `zendesk`. `emits` rises
considerably further, and roughly 27 connectors become measurable for the first time. That is the
whole corpus movement, and it is written here so a modest figure at the end is not mistaken for a
failed branch.

The recognizer-set design wrote itself the same warning and was still too optimistic; this one is
calibrated against a per-connector inversion rather than a bucket count, and against four
re-emission measurements. It can still be wrong, in which case the number is the answer and this
paragraph is the record of what was predicted.

The deliverables that do not depend on that number: a shipped `--from-connector` and
`--from-openapi`, standalone packages that this tool can read back, a histogram whose buckets mean
what they appear to mean, a stated ceiling with a denominator, and a repo whose documents match
its code.

---

## 9. Known risks

- **The frame widening reveals rather than clears.** Nothing behind those 31 frames has been
  measured, so item 13 will *add* histogram buckets. That is the intended result and is stated so
  it is not read as a regression.
- **Moving the deriver into `src/` reverses a written rule** and adds `@babel/parser` to what
  users install. The `optionalDependencies` precedent contains it, and the tarball contents are
  checked by `npm pack` in the same commit.
- **Case 2 is a judgment call per application.** Condition (b) — a test proving field recovery —
  is the whole guard. A recognizer added under case 2 without that test is a false `emits` and is
  worse than no recognizer.
- **`--from-connector` produces artifacts, not numbers.** Every wrong derivation that was
  previously a wrong histogram entry becomes a wrong file someone might commit. §3.4 is the
  mitigation; it is a precondition, not a follow-up.
- **Branch size.** Eighteen items. Each is independently verifiable and independently revertible,
  and the work can stop after any of them with the repo strictly better than before.

---

## 10. Verification

Per commit, exit codes rather than printed output:

```bash
bun test --coverage
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
bun run diff:golden --nimbus-root <path>     # newrelic/datadog/grafana/sentry stay 6/6
bun run reach --nimbus-root <path>           # histogram compared against the previous commit's
```

Every new module under `src/derive/` ships with its own test file — `bunfig.toml` enforces
coverage **per file**, and no `coveragePathIgnorePatterns` entries are added.

Every fixture must remain in exactly one of `derive-round-trip.test.ts`'s `ROUND_TRIP` /
`BLOCKED` lists, and a `BLOCKED` reason must be checked by running `deriveSpec` against the
fixture's emitted output — never inferred from the spec or the emitter. Two earlier versions of
that docstring went stale exactly that way.

`fixtures/reach-baseline.json` is rewritten once, at item 14, via `bun run reach:baseline`. It is
re-baselined because the measurement moved, never edited to make a run pass.
