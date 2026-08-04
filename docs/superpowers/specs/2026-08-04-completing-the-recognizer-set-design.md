# Completing the deriver's recognizer set — design

**Date:** 2026-08-04
**Status:** designed
**Roadmap item:** the precondition for ranking [Stage E](../../ROADMAP.md#stage-e--the-corpus-tail-)'s
remaining items. Follows
[the reach-measurement design](./2026-08-03-from-connector-reach-design.md), which built the
instrument and explicitly deferred five recognizer modules to "plan 2's territory".

## The problem: the instrument cannot yet answer the question it was built for

`bun run reach` exists so that *which shape blocks the most connectors* is measured rather than
guessed. `docs/ROADMAP.md`'s *Measuring reach* records three consecutive wrong hand counts — 12,
then 7, then 9 — each wrong for a method reason, the last understating reach by more than half.

Measured against `C:/gitrep/Nimbus` at `packages/mcp-connectors` tree `e3751a3a` on 2026-08-04,
the harness reports `REACH 4/94`, and its largest bucket by a factor of ten is **`no-frame` = 81**.

`no-frame` is not a spec-language gap. `deriveSpec` short-circuits the moment `recognizeFrame`
fails, and `recognizeFrame` models exactly one shape: the hand-rolled
`McpServer`/registrar/`StdioServerTransport`/`connect` prologue and epilogue. The corpus splits
three ways:

| frame shape | connectors | recognizer today |
| --- | --- | --- |
| `runReadOnlyMcpConnector` (read-only-kit) | 60 | none |
| `makeRestToolRegistrar` (rest-kit) | 10 | none |
| hand-rolled `McpServer` / `connect` | 24 | yes |

All three styles are in `ConnectorSpecSchema`'s `style` enum and all three have shipped —
rest-kit in Stage A/B, read-only-kit in Stage D. `deriveSpec` nevertheless hardcodes
`style: "hand-rolled"`. **The emitter can already write what the deriver refuses to read.**

### The evidence that settles it

Stage E's second open item reads *"Multi-file connectors. **16** connectors carry
`src/tools.ts`"*. There are exactly 16, and every one of them is in the `no-frame` list:

> apple, athena, bigquery, cloud-logging, cloudwatch, dataprofile, elasticsearch, fastmail,
> great-expectations, imap, localdb, protonmail, sagemaker, storybook, vertex-ai, workday

The histogram therefore reports **zero** connectors blocked by `import-from:./tools.ts` — the
bucket the reach design named as the way multi-file was supposed to *emerge*. The roadmap's own
worked examples, `elasticsearch` and `storybook`, are invisible behind `no-frame`. The same holds
for CLI-backed: the histogram shows 4 on `run-cli-json.ts` against a hand-counted 5, with
`jenkins` landing on `import-from:./jenkins-api.ts` instead.

So Stage E's item counts are hand counts that the instrument cannot currently corroborate.
Choosing the next stage's work from them would be the fourth hand count after 12, 7 and 9 — and,
worse, would leave 81 connectors unmeasured afterwards, so the choice could not be checked either.

### Why frames alone are not enough

Teaching the deriver the two missing frames is necessary and **not sufficient**, and the reason is
measurable rather than theoretical:

| | count |
| --- | --- |
| read-only-kit connectors that also carry `src/search-filter.ts` | **49 of 60** |
| connectors with a non-`GET` method literal (needs a `body.ts` recognizer) | 33 |
| connectors calling `new URL(` (needs a `query.ts` recognizer) | 10 |

A read-only-kit frame shipped on its own would move 70 connectors off `no-frame` and drop roughly
49 of them straight onto a *search* blocker — which is another missing recognizer, not a
spec-language gap. One wall would be traded for a shorter one, and the histogram would still mix
two populations that must not be mixed.

The reach design already named the boundary: **one recognizer module per emitter module**, so that
"a pull request that adds a path to `src/emit/server/tools.ts` without touching
`scripts/_lib/derive/server/tools.ts` is visibly incomplete". That coupling currently covers 6 of
11 emitter modules. `body.ts`, `query.ts`, `search.ts`, `tools-rest.ts` and `src/emit/search-filter.ts`
have no counterpart. **The histogram ranks spec-language gaps only once the coupling is complete;
until then every missing module manufactures a blocker that looks like a corpus fact and is not.**

The same corollary the reach design drew still applies, and is not weakened here: some connectors
are permanently blocked by decisions already recorded in *Known limitations* and *Considered and
declined*. Completing the recognizer set does not make `server-identical` universally reachable.
It makes the reported blockers real.

## Scope

Complete the recognizer set: the two missing frames plus the five missing modules. Explicitly a
measurement-fidelity change — **no emitter behaviour changes, and no spec field is added.**

Out of scope, unchanged from the reach design: writing a derived spec to disk, typechecking the 94
generated packages, deriving Gateway sync files.

## 1. The guarded accessor layer

### The defect class

The reach implementation surfaced the same defect eight times across five files, in two forms:
unguarded `computed` member reads, and `VariableDeclaration` matchers not checking
`kind === "const"`. Both are instances of one shape: **a matcher that validates part of a
construct and claims the whole of it.**

The totality rule cannot catch this. It detects statements nobody claimed; it is blind to
statements claimed *wrongly*. A partial match is a wrong derivation reported as a success — which
is a wrong number, the thing this instrument exists to prevent.

The root cause is a type, not a habit. `ast.ts` exports

```ts
export type AstNode = { type: string; start: number | null; end: number | null; … ;
                        [key: string]: unknown };
```

That index signature makes `node["computed"]`, `node["kind"]` and `(x as AstNode)["name"]`
typecheck for *any* key, yielding `undefined` for absent ones. Whether that `undefined` rejects or
matches then depends on which side of a comparison it lands on:

```ts
if (node["kind"] !== "const") return undefined;   // rejects — undefined !== "const"
if ((callee["property"] as AstNode)["name"] !== "connect") return false;   // rejects
const name = property["name"];                    // ACCEPTS — derives an arg named after
                                                  // whatever local indexed the member
```

Five new recognizers written against that type will reproduce the class. A helper module offered
*alongside* the raw reads would not prevent it either, because the unguarded spelling stays
available and is shorter.

### The fix: make the unguarded read a compile error

`ast.ts` stops exporting the index signature. `AstNode` becomes exactly the fields the
infrastructure legitimately needs:

```ts
export type AstNode = {
  readonly type: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly loc?: { start: { line: number } };
};
```

`claims.ts` needs `start`/`end`/`type`; `blockers.ts` needs `type`/`loc`. Every one of the eight
defects was in reading some *other* key, so dropping only the index signature is both minimal and
sufficient.

A new `scripts/_lib/derive/read.ts` becomes the sole module that casts to the raw indexable node,
and exports total accessors — each returning `T | undefined`, never throwing:

| accessor | enforces |
| --- | --- |
| `identName(n)` | node is an `Identifier` |
| `memberName(n)` | `MemberExpression` **and** `computed !== true` |
| `memberOn(n, receiver)` | the above **and** the receiver is that exact identifier |
| `constDecl(n)` | `VariableDeclaration`, `kind === "const"`, exactly one declarator, `Identifier` id |
| `callTo(n, callee, argc)` | `CallExpression`, `Identifier` callee of that name, **exact arity** |
| `methodCallTo(n, recv, prop, argc)` | non-computed member callee, receiver identity, exact arity |
| `newOf(n, ctor, argc)` | `NewExpression`, callee name, exact arity |
| `objectProps(n)` | `ObjectExpression`, every property a non-computed `ObjectProperty` |
| `stringLit` / `numberLit` / `boolLit` | the specific literal node type **and** the JS type of `value` |
| `arrowFn(n)` | `ArrowFunctionExpression`, returning params and whether the body is a block |
| `awaited(n)` | `AwaitExpression` |

**That table is representative, not exhaustive.** Child access — `blockBody`, `returnArgument`,
`importSource`, `importNames`, the three limbs of a `ConditionalExpression`, template-literal
quasis and expressions — is reached the same way, by a named accessor that checks the parent's
node type first. The rule the retrofit establishes and every new recognizer inherits: **reaching a
node field that has no accessor means adding one, never widening a type or casting.** There is no
cast outside `read.ts`, and `tsc` is what enforces it.

A generic `getChildren(node): AstNode[]` is deliberately **not** provided, despite being the
obvious way to satisfy a traverser. An untyped child list hands back nodes stripped of which slot
they came from, which is the precise information the guards depend on — it is how a computed
member's key identifier gets read as a property name. Access is by named, shape-checked slot or it
is not access. Nor is a traverser needed: `claims.ts` does not walk the tree (`unclaimed` filters
the list it is given, `covers` compares byte ranges), and every recognizer descends through the
construct it is matching, which is exactly what makes the match total.

**`numericValue` is separate from `numberLit`, because the spec permits negatives.** `ArgSchema`
declares `min: z.number().optional()`, `max: z.number().optional()` and
`default: z.union([z.string(), z.number(), z.boolean()])` — none of the three constrains sign — so
`z.number().min(-5)` and `default: -1` are expressible and the emitter writes them. Babel parses
`-5` as a `UnaryExpression` wrapping a `NumericLiteral`, so a strict `numberLit` at those sites
would manufacture a blocker on a connector the generator can actually reproduce, which is the
class of fake blocker this whole branch exists to remove. Both accessors therefore exist:
`numberLit` for positions where the emitter can only write a bare literal (`maxLimit`, which
`ToolSchema` pins to `.int().positive()`), and `numericValue` — accepting unary `-` and `+` over a
`NumericLiteral` — for `min`, `max` and a numeric `default`. Each call site picks deliberately
rather than inheriting a permissive default.

The property that matters: `computed`, `kind` and arity are checked at the only place the value
can be obtained, so they cannot be skipped. Rejecting stays the safe default — a rejection is a
visible blocker, a wrong claim is a wrong number.

**`blockers.ts` is the one place leniency is correct, and it gets its own named group rather than
an escape hatch.** It reads `callee.property.name` and friends to build a histogram bucket label —
it labels, it never claims. Routing it through the guarded accessors would make `obj[key]()`
collapse from `method-call:.key` into a bare `statement:ExpressionStatement`, merging distinct
buckets and losing exactly the specificity the reach design calls for ("near-misses stay visible").
So `read.ts` exports a second, explicitly-named `label*` group for it, documented as never valid
for a claim. Both groups live in `read.ts` so the raw cast stays confined to a single file — the
alternative, letting `blockers.ts` keep its own cast, is an escape hatch a recognizer could copy.

Two known Babel behaviours the accessors absorb rather than leave to each caller, because both
have already cost time: `?.` chains produce `OptionalCallExpression` / `OptionalMemberExpression`
(distinct node types, never silently equivalent), and `-1` parses as a `UnaryExpression`, not a
`NumericLiteral` — so `numberLit` must reject it rather than return `undefined` ambiguously, and
a caller wanting negative literals asks for them explicitly.

**Enforcement is `bunx tsc --noEmit`**, already a gate. This is deliberately not a lint rule or a
grep-based test: a convention that the typechecker enforces cannot be forgotten in review.

Commit 1 retrofits the six existing recognizer modules — `server/args.ts`, `server/env.ts`,
`server/fetch-helper.ts`, `server/index.ts`, `server/path-template.ts`, `server/tools-hand.ts`,
about 1,750 lines — plus `blockers.ts` onto its `label*` group, with **zero behaviour change**,
proven three ways: the existing unit suite passes unchanged, `derive-round-trip.test.ts`'s
two lists are untouched, and `bun run reach` reports the identical tier counts and the identical
histogram. Proving the layer against known-good code before any new recognizer depends on it is
the point of ordering it first.

## 2. Frame dispatch, and a containment hazard

`recognizeFrame` becomes style-dispatching, returning:

```ts
type Frame = {
  fields: { name: string; style: "hand-rolled" | "read-only-kit" | "rest-kit" };
  toolStatements: readonly AstNode[];   // what the tool recognizers run over
  verifyStatements: readonly AstNode[]; // what the totality rule walks
};
```

`deriveSpec` stops hardcoding `style` and stops running the totality rule over the top-level list
directly.

### Why two lists

Read-only-kit's registrations are nested:

```
await runReadOnlyMcpConnector("nimbus-<name>", (reg) => {
  reg( … );   //  <- the tools
});
```

Claims are byte ranges and **coverage is containment** — a design property the reach document
calls out as load-bearing, because it lets one matcher claim a multi-statement construct. Here it
is a hazard: if the frame claims that `ExpressionStatement`, every registration inside it is
covered transitively, the totality rule finds nothing unclaimed, and a connector whose tools were
never recognized derives successfully. That is a false `emits` produced by the exact mechanism the
totality rule exists to remove — the dominant defect class, at frame scale rather than expression
scale.

So for read-only-kit the frame **removes the wrapper from `verifyStatements` and splices in the
callback's body statements**, and **never claims the wrapper**. The wrapper is not thereby
unchecked: recognition pins the `await`, the callee identity, arity 2, the `"nimbus-<name>"`
string literal, and a single-parameter `(reg) =>` arrow with a block body. It is fully verified and
never granted coverage, so nothing inside it inherits a claim.

**Exactly one statement is removed — the wrapper itself.** Every other top-level statement stays
in `verifyStatements` and must still be claimed or become a blocker: the imports, the base const,
the env accessors, the fetch helpers, and anything else the file happens to contain. The
substitution is a swap of one statement for its children, not a switch from checking the module to
checking the callback. A stray top-level helper is as visible after this change as before it.

For hand-rolled and rest-kit, both lists are the top-level list and nothing is removed.

Env accessors, the base const and the fetch helpers stay at module top level for read-only-kit
(see `emitServer`'s section order), so `env.ts` and `fetch-helper.ts` need no change.

**A dedicated test asserts the hazard is closed:** a read-only-kit module carrying one
unrecognizable statement *inside* the callback must report that statement as its own blocker, not
derive.

### The read-only-kit import block

Recognition also has to accept the import shape `imports()` writes for this style, which differs
from hand-rolled in ways that are not cosmetic: no `McpServer`/`StdioServerTransport` package
group, no blank line before the relative group, `mcp-tool-kit.ts` present **only** when
`encodeBasicAuthHeader` or `jsonResult` is needed, and `run-read-only-mcp-connector.ts` always
present.

## 3. rest-kit

The frame is the hand-rolled five elements — the existing recognizer already reads the `McpServer`
binding's name off the node, so `server` rather than `mcp` needs no change — plus the
`../../shared/rest-tool-kit.ts` import.

New `scripts/_lib/derive/server/tools-rest.ts` inverts `renderRestKitTools`:

- the factory const `const <registrar> = makeRestToolRegistrar({ registrar: reg, tokenEnv, serviceLabel, fetch })`,
  which is the sole source of `serviceLabel`, the auth env var and `fetchHelper.local`;
- each `<registrar>(name, description, schema, pathFn[, initFn])` call, in its four rendered
  shapes: expression-bodied path, block body with hoists, the query branch, and the stub's
  `throw`.

Note rest-kit emits neither env accessors nor a read helper, so `fetchHelper` is recovered from
the factory object and the path expressions rather than from a helper function.

### Why seven rest-kit connectors report `no-frame` — diagnosed

The reach design left this open; it is now answered, and the answer is a limitation
`docs/ROADMAP.md` **already records**, under *Shape variance the emitter models one way*:

> **Wiring and tail idiom.** Roughly half the rest-kit corpus writes the one-line registrar form
> and half the two-line one; likewise the transport tail. There is no majority to converge on, so
> the emitter picks one and the other half differs.

Two independent idiom axes, each with two forms, and the emitter writes one of each:

| axis | the emitter's form | the other form |
| --- | --- | --- |
| registrar | `createZodToolRegistrar(createRegisterSimpleTool(x))` inlined | the inner call bound to its own const first |
| transport tail | `const transport = new StdioServerTransport();` then `await x.connect(transport)` | `await x.connect(new StdioServerTransport())` |

That accounts for all ten rest-kit connectors exactly: `circleci`, `github-actions` and
`pagerduty` match the emitter on both axes and clear the frame; `discord` and `github` take the
other registrar form; `gmail`, `google-meet`, `google-photos`, `onedrive` and `outlook` take the
other tail form. Seven failures, fully explained, with no unexplained residue.

**The recognizer is not widened to accept either variant.** Both are shapes
`src/emit/server/index.ts` cannot produce, so claiming them would be a wrong claim — the "no
escape hatch" rule applies here exactly as it does to `zoom`. A connector on the far side of
either axis can never reach `server-identical`, by a decision already made and written down.

> **Superseded by measurement.** The diagnosis above — two connectors on the registrar axis
> (`discord`, `github`), five on the tail axis, ten rest-kit connectors total — was written before
> the corpus was actually measured. Task 6 measured it and found both counts and both axis
> memberships wrong: `frame:registrar-not-inlined` is **13** connectors, not 2, and is **not
> rest-kit-only** — `bitbucket`, `confluence`, `gitlab`, `jira`, `linear`, `notion`, `obsidian`,
> `slack` and `teams` are hand-rolled connectors that hit the same near miss, alongside `discord`
> and `github`, plus `google-meet` and `google-photos`, which write *both* near-miss shapes and
> land on this axis only because `frameFailureKind` checks the registrar element before the
> transport one. `frame:tail-inlined-transport` is **4** — `gmail`, `google-drive`, `onedrive`,
> `outlook` — and includes `google-drive`, a connector this section never mentions at all. The
> table and the "ten rest-kit connectors … seven failures, fully explained" accounting above are
> left as originally written rather than edited to match — `docs/ROADMAP.md`'s *Wiring and tail
> idiom* bullet carries the verified membership and is the one to trust. Verified via
> `bun run reach --nimbus-root <path> --verbose`.

### `no-frame` is split into named blockers

What the diagnosis *does* change is the reporting. `no-frame` is currently one opaque bucket
holding 81 connectors, which is what made this question expensive enough to defer in the first
place — a bucket that large is a wall, not a finding. When frame recognition fails, the deriver
will name the element that failed rather than the fact that some element did:
`frame:registrar-not-inlined`, `frame:tail-inlined-transport`, `frame:no-mcp-server`,
`frame:no-kit-import`, and so on.

This is the *"blockers are discovered, not enumerated"* principle applied to the one place the
reach implementation did not apply it. It costs nothing at claim time — the frame recognizer
already tests each element separately — and it turns a documented limitation into a bucket the
histogram counts, instead of leaving it indistinguishable from a genuine spec-language gap.

## 4. search — the widest single unlock

`SourceFiles` gains an optional third member:

```ts
export type SourceFiles = { server: string; manifest: string; filter?: string };
```

`scripts/_lib/reach.ts` already reads every connector file into a map, so supplying it is one line
at the `deriveSpec` call site. Absent filter file plus a search tool is a blocker, not a silent
omission.

Two recognizers:

- **`derive/server/search.ts`**, inverting `renderSearchTool`: the
  `reg(name, description, schema, async (p) => { … })` shape, with `maxLimit` recovered from
  either `searchToolInputSchema(N)` or the inlined merged `z.object` whose trailing two fields are
  the helper's own; the `matchesResult(rows, <filterExport>, p)` return; and the optional `rows`
  local pair.
- **`derive/search-filter.ts`**, inverting `emitSearchFilter`, with **its own totality rule over
  the filter file's statements** — the same discipline, applied to the second file rather than
  assumed away. It recognizes the file's **import statements** (below), the type alias (which is
  where `title` becomes recoverable), the keyed
  `makeQueryFilter(fieldsFromKeys([…]{, { tags: true }}))` form, the `fieldsOf` extractor form over
  its four primitives (`stringField`, `nestedString`, `tagText`, `tagNamesFromObjects`), and the
  throwing stub.

**The filter file's imports are recognized, not waved through**, and the distinction earns its
keep. Every emitted filter file opens with one or two import statements — `fieldsFromKeys`,
`makeQueryFilter`, whichever primitives the extractors name, `type SearchMatchOptions`, and
`type SearchFilter` from a second module when any tool is a stub. Left unrecognized they would
block every filter file on its own preamble; claimed blindly they would prove nothing.

The right treatment is available because `emitSearchFilter` derives that list from the body
(`filterNames`, built from `primitivesFor` and the keyed/extractor/stub split, then sorted by
`byBareName`). So the recognizer reads the body first, computes the import list the emitter
*would* have written, and requires the file's actual imports to match it — name set, module
split, and order. A mismatch is a blocker naming the discrepancy. That converts the preamble from
an obstacle into a cross-check on the body recognition, which is a stronger reading of the file
than skipping it and a strictly stronger one than claiming it.

The extractor form is where the corpus is thinnest and the roadmap most detailed. The recognizer
models what the **emitter** writes and nothing else: `asObjectish` (never `asRecord`), the
`function fieldsOf(...)` declaration (never an arrow with a type annotation), and no doc comment.
Those are the four gaps *Known limitations* already records as the reason almost none of the 26
expressible files byte-match; a recognizer that accepted them would claim files the emitter cannot
reproduce.

## 5. query and body

- **`derive/server/query.ts`** inverts `renderQueryLines` plus its surrounding trio: the
  `const u = new URL(<pathExpr>)` statement, each bare or guarded `u.searchParams.set(key, value)`
  — the guard shape distinguishing `omitWhen: "absent"` from `"empty"` — and the
  `` return `${u}`; `` tail. `String(...)` is unwrapped, and cross-checked against the arg's
  declared type rather than assumed from its presence.
- **`derive/server/body.ts`** inverts `renderBodyExpr`: the `JSON.stringify({ … })` expression in
  the rest-kit init callback and in the hand-rolled send call, recovering `method` from the
  literal, `body` from a non-default field mapping, and honouring shorthand properties.

**One consequence to state plainly**, because it looks like a shortfall and is not. The emitter
deliberately writes `` `${u}` `` where the real `discord`, `circleci`, `google-meet` and
`google-photos` write `` `${u.pathname}${u.search}` `` — the doubled-path defect *Known
limitations* documents and this generator declines to reproduce. The recognizer therefore
**rejects** the corpus spelling. `discord` and `google-meet` will round-trip as fixtures and
remain blocked in the corpus. That is the correct, already-recorded outcome, and it is a case
where a recognizer that matched more would measure less.

## 6. Sequence

Each commit is verified by fixtures moving out of `derive-round-trip.test.ts`'s `BLOCKED` map into
`ROUND_TRIP` — hermetic, CI-runnable, and composed entirely of bytes this repository emitted.
`test/scripts/derive-round-trip.test.ts` already asserts every fixture sits in exactly one list, so
neither list can drift.

| | commit | fixtures freed |
| --- | --- | --- |
| 1 | guarded accessors + opaque `AstNode`, seven modules retrofitted | none — behaviour-identical |
| 2 | read-only-kit frame | new synthetic `zzreadonly` |
| 3 | rest-kit frame + `tools-rest` + the `no-frame` blocker split | `zzstandalone` |
| 4 | `search` + `search-filter` | `bitrise`, `dependencytrack`, `mercury`, `netlify`, `zendesk`, `zzextract`, `zzsearch`, `zzsearchstub` |
| 5 | `query` | `discord`, `google-meet` |
| 6 | `body` | `zzwriterest`, `zzwriteonly` |
| 6b | client-credentials env shape *(optional)* | `zzwrite` |
| 7 | re-baseline, docs, `iac`'s `no-manifest`, `deriveManifest` field typing | — |

**Why commit 2 needs a new fixture.** All eight existing `read-only-kit` fixtures declare a search
tool, so the frame recognizer would otherwise ship with nothing proving it end-to-end — the eight
would merely swap their `BLOCKED` reason from `read-only-kit frame` to `search tool`. A gate that
passes while asserting nothing is the failure mode this repository keeps removing. `zzreadonly` is
a hand-written search-free `read-only-kit` spec, following the `zzscratch` /
`zzstandalonehand` precedent of a synthetic fixture that exercises one frame in isolation; its
`fixtures/expectations.json` entry is `[]`, as every synthetic fixture's is. It keeps its value
after commit 4, because it is what distinguishes a frame regression from a search regression.

**Commit 6b is optional.** `zzwrite`'s `auth: "client-credentials"` is a documented exclusion in
`server/env.ts`, not one of the five missing modules, and it accounts for 4 corpus connectors. It
is included if the branch has room and dropped — reported, not hidden — if it does not.

### Verification per commit

Exit codes, never printed output:

```
bun test --coverage        # unit + the round-trip
bunx tsc --noEmit          # also the enforcement for §1
bunx biome check src/ test/ scripts/
bun run diff:golden --nimbus-root <path>    # newrelic/datadog/grafana/sentry stay 6/6
bun run reach --nimbus-root <path>          # histogram compared against the previous commit's
```

`diff:golden` risk is structurally low — the deriver is not in the emitter's path, so emitted bytes
cannot move — with one exception: commit 2's `zzreadonly` is additive fixture surface and is
checked like any other.

Every new file under `scripts/_lib/` enters the per-file coverage report the moment a test imports
it, so each recognizer ships with its own unit-test file. **No `coveragePathIgnorePatterns`
entries**, and no in-process duplicates of subprocess-driven tests — see `bunfig.toml`.

`fixtures/reach-baseline.json` is rewritten once, at commit 7, via `bun run reach:baseline`. It is
re-baselined because the corpus measurement moved, never edited to make a run pass.

## 7. Consequences for other documents

- **`docs/ROADMAP.md`** — Stage E's hand counts (16 multi-file, 5 CLI-backed) are replaced by the
  measured ranking, or removed in favour of pointing at `bun run reach`, per this file's own rule
  against restating live numbers. *Measuring reach* gains a note that the corpus-wide question is
  now answered across all three frame styles rather than one. *Shape variance the emitter models
  one way* gains the exact split behind its "roughly half … and half" sentence, now that the
  connectors on each side of both idiom axes are enumerated (§3) rather than estimated.
- **`docs/superpowers/specs/2026-08-03-from-connector-reach-design.md`** — its *Not built — plan
  2's territory* paragraph is superseded; a pointer to this document is added rather than editing
  the historical record.
- **`CLAUDE.md`** — no gate-table change. `reach` still proves what it proved and still cannot run
  in CI.

## 8. Known risks

- **Seven rest-kit connectors are permanently short of `server-identical`** (§3) — the registrar
  and transport-tail idiom variance, already recorded in *Known limitations*. Diagnosed rather
  than open, but it caps what commit 3 can deliver: those seven move from `no-frame` to a named
  idiom blocker, not into a passing tier. **Superseded by measurement** (see §3's note): the
  actual count spans both frame styles and is far larger than seven — `docs/ROADMAP.md`'s *Wiring
  and tail idiom* bullet has the verified membership.
- **The retrofit in commit 1 is broad** — seven modules, ~1,800 lines. It is behaviour-preserving
  by construction, and the unchanged reach histogram is the check that it was.
- **Branch size.** Seven new modules and their tests, roughly doubling `scripts/_lib/derive/`.
  The commit sequence is the mitigation: each is independently verifiable and independently
  revertible, and the work can stop after any of them with the histogram strictly more honest than
  before.
- **The headline will not move much.** Most of the 70 frame-unblocked connectors will land on their
  real blocker rather than on `server-identical`. That is the intended result — the deliverable is
  a trustworthy ranking, not a larger number — and it is recorded here so a modest `REACH` figure
  after commit 7 is not mistaken for a failed branch.
