# Search-filter field extractors — design

**Date:** 2026-08-02
**Stage:** E — the corpus tail, first bullet ("bespoke field extractors")
**Status:** approved, not yet implemented

## Problem

`filter.fields` accepts a flat list of top-level string keys and emits
`makeQueryFilter(fieldsFromKeys([...]))`. A spec that omits `fields` emits a throwing stub.
Between those two states sits most of the corpus: of the 49 filter files in Nimbus, **9** use
`fieldsFromKeys` and **40** hand-write an extractor the generator cannot express.

The roadmap treats those 40 as one gap. They are not. Measured against the checkout at
`f4e9d93d` (95 connectors):

| Group | Count | Shape |
| --- | --- | --- |
| A | 9 | `fieldsOf` built only from primitives `shared/search-filter.ts` already exports, plus local *variable* bindings that project a sub-object before reading flat keys off it — that shape is what a `path` entry expresses |
| B | 30 | `fieldsOf` defining a local helper *function*, or needing logic no `path`/tag entry can express — a join, an array flatten, a coercion |
| C | 1 | `zoom` — hand-rolled, does not use `makeQueryFilter` at all |

Measuring this by hand is easy to get wrong, and it was: a first pass with a script matching the
range `/^function fieldsOf/,/^}/` reported 7/32/1. That pattern never matches `firebase` and
`testflight`, which write their extractor as `const releaseFields: FieldExtractor = (item) =>
{…}` — an arrow, not a `function` declaration — so those two spuriously reported zero local
bindings while structurally identical files (`hubspot`, `miro`) reported non-zero and were
excluded. The criterion the first pass used — "binds locals before its return array" — was also
wrong, not just its application: a local binding that projects a sub-object and then reads flat
keys off it (`const props = asObjectish(row["properties"]) ?? {}` in `hubspot`, `owner` in
`miro`, `releaseNotes` in `firebase`, `attributes` in `testflight`) is exactly what a `path`
entry expresses. What actually disqualifies a file is a local *function* declaration, or inline
logic — a loop, an array filter, a `String()` coercion — that no entry kind reaches. Reading
every one of the 40 files against that corrected criterion gives 9/30/1 (see
[Reach](#reach)).

Group A is reachable by composing existing primitives. Group B is not: byte-matching it means
emitting *that connector's* bespoke helper under *that author's* chosen name, which no
declarative field list can do. Group C is a different product.

## Goal

**Correctness reach, with the byte gap documented** — chosen over byte-exactness in
brainstorming on 2026-08-02.

Emit a semantically correct filter for flat, nested, projected and tag-bearing field shapes,
and stop emitting a throwing stub for them. Do *not* add spec fields whose only purpose is
reproducing another author's stylistic choices.

The honest headline for this change is "the throwing stub disappears for a slice of the
corpus", **not** a jump in the `diff:golden` number. It moves the byte count by one.

### Why not byte-exactness

Byte-matching Group A requires the spec to carry four further things, none of which is
derivable from the field list:

- the guard — `argocd` uses `asRecord(item)`, the rest `asObjectish(item)`, and these differ
  semantically (`asObjectish` admits arrays, `asRecord` rejects them)
- the extractor form — `function fieldsOf(…)` vs `const buildFields: FieldExtractor = (…) =>`
- the extractor's name — `releaseFields`, `buildFields`, `fieldsOf`
- a hand-written 4–5 line doc comment explaining the service's response shape, present in
  `canva`, `figma`, `firebase`, `hubspot`, `miro`, `salesforce` and `testflight`

The doc comments are the same class of gap the ROADMAP already records for hand-authored
READMEs: content no spec field can derive. The other three are the same class as the registrar
naming and tail idiom this repo has already declined to add knobs for.

## Spec language

`SearchFilterSchema.fields` widens from `string[]` to an array of three entry kinds:

```jsonc
"filter": {
  "export": "filterArgocdApplications",
  "fields": [
    "name",                                     // stringField(row, "name")
    { "path": ["spec", "source", "repoURL"] },  // nestedString(row, ["spec","source","repoURL"])
    { "tags": "objects" }                       // tagNamesFromObjects(row)
  ]
}
```

`{ "tags": "text" }` renders `tagText(row)`.

Entry objects are `z.strictObject`s, matching every other schema in `spec.ts`, so a misspelled
or mixed-shape entry — `{ "path": ["spec"], "tag": "objects" }` — is rejected rather than
silently reinterpreted.

The union is untagged (no `"type"` discriminator) because the required-key sets are disjoint:
an entry is a string, or has `path`, or has `tags`. A tagged form was considered and declined —
see [Considered and declined](#considered-and-declined).

There is no fourth kind. `firebase` and `testflight` project a sub-object and then read flat
keys off it — `const attributes = asObjectish(row["attributes"]) ?? {}` followed by
`stringField(attributes, "version")`. That is semantically identical to
`nestedString(row, ["attributes", "version"])`, so `path` already covers it. It will not byte-match,
which is expected under the chosen goal.

### Rejections

Each is a parse-time error, not a normalisation:

- **A `path` with fewer than two segments.** A one-segment path and a plain string key produce
  identical output. Accepting both spellings for one emission is an ambiguity, and silently
  normalising it hides a probable authoring mistake. The message quotes the offending path and
  names the plain-string spelling to use instead.
- **An empty path segment.** `z.string().min(1)` per segment, matching the rule `fields`
  already applies to plain keys. Whitespace-only segments are *not* rejected: `{" ": …}` is a
  legal JSON key, and trimming would reject a spec that is merely unusual.
- **Both legacy `tags: true` and a `{ "tags": … }` entry.** The message names both, because a
  precedence rule here would be invisible in the emitted file.
- **An empty `fields` array**, unchanged from today.

Every message names the offending key or value, matching the convention `validate.ts` already
holds itself to.

### Backward compatibility

`filter.fields: string[]` and `filter.tags: boolean` keep their exact current meaning. Every
published 0.4.0 spec parses unchanged and emits identical bytes. This is not a courtesy —
`mercury` and `zendesk` byte-match today and must continue to.

## Rendering

Derived from the entry kinds present. No selector field.

| Spec shape | Emission |
| --- | --- |
| all entries plain strings, `tags` absent or false | `makeQueryFilter(fieldsFromKeys([...]))` |
| all entries plain strings, `tags: true` | `makeQueryFilter(fieldsFromKeys([...], { tags: true }))` |
| all entries plain strings **plus a trailing `{"tags":"text"}`** | `makeQueryFilter(fieldsFromKeys([...], { tags: true }))` |
| any `path` entry, a non-trailing `{"tags":…}`, or `{"tags":"objects"}` | `function fieldsOf(…)` + `makeQueryFilter(fieldsOf)` |
| `fields` omitted | throwing stub |

The first, second and fifth rows are today's behaviour, unchanged.

The third row makes the two tag spellings **converge** rather than diverge. `fieldsFromKeys`
appends `tagText(row)` after the keyed fields when `opts.tags` is set, so a trailing
`{"tags":"text"}` is byte-identical to `tags: true` — and emitting it as such means an author
who prefers the newer spelling does not silently lose a byte-match. The trailing requirement is
load-bearing: `fieldsFromKeys` can only append, so a `{"tags":"text"}` in any other position
changes field order and must use `fieldsOf`.

`{"tags":"objects"}` has no `fieldsFromKeys` equivalent — that helper hardcodes `tagText` — so
it always takes the `fieldsOf` branch.

A `form` override was considered and dropped. It was proposed to byte-match the nine Group A
files that write a flat list in `fieldsOf` form, and it lost its justification when the goal
became correctness reach rather than byte-exactness.

### The byte-safety invariant

`newrelic`, `datadog`, `grafana` and `sentry` declare no search tool, so they emit no
`src/search-filter.ts` and cannot reach any branch this change touches.

`mercury` and `zendesk` reach only the unchanged `fieldsFromKeys` rows, because their specs
contain only plain-string entries. Their byte-match is preserved *by construction* — no new
branch is reachable from their spec shape — rather than by remembering to check.

The guard is always `asObjectish`. `argocd`'s `asRecord` becomes a documented difference.

## Identifier safety

`src/server.ts` imports the filter export (`import { filterArgocdApplications } from
"./search-filter.ts"`), so that name occupies `server.ts`'s module scope beside the fetch
helper and the env accessors.

Two changes, both required in this commit by the rule in `CLAUDE.md`:

1. **`validateSpec` claims each `filter.export`.** This closes a pre-existing latent gap:
   today `filter.export: "makeQueryFilter"` emits
   `export const makeQueryFilter = makeQueryFilter(…)`, a self-reference that fails the
   generated package's own typecheck. Nothing rejects it at parse time.

2. **`RESERVED_IDENTIFIERS` gains** `fieldsOf`, `asObjectish`, `stringField`, `nestedString`,
   `tagText`, `tagNamesFromObjects`, and the two already emitted but never reserved —
   `makeQueryFilter` and `fieldsFromKeys`.

Reserving the names that appear only inside `src/search-filter.ts` slightly over-rejects: an
env accessor named `stringField` would collide with nothing real. This follows the flat-list
precedent `validate.ts` argues for in its own comments — conditional entries would make a spec
validate or fail depending on a field elsewhere in the file, and the list is deliberately a
flat set checked before any style or tool kind is considered.

## Emitter

`src/emit/search-filter.ts` only.

- `keyedFilter()` keeps the `fieldsFromKeys` path untouched.
- `extractorFilter()` is new: renders the `fieldsOf` function and the `makeQueryFilter(fieldsOf)`
  binding.
- The import set is computed from the entry kinds actually present. An unused import is a
  `noUnusedLocals` error in the generated package and a biome lint failure, which is why the
  existing code already computes this precisely for `SearchFilter`.
- Emitters return unformatted source; line breaks are hand-managed, indentation is not.

**Which primitives each branch imports.** The `fieldsOf` branch always imports `asObjectish`,
for the guard; `stringField`, `nestedString`, `tagText` and `tagNamesFromObjects` only when an
entry of that kind is present. `FieldExtractor` is **never** imported: the emitted form is a
function declaration —

```ts
function fieldsOf(item: unknown): readonly string[] | null
```

— which annotates its own signature. `FieldExtractor` is needed only by the
`const buildFields: FieldExtractor = (item) => …` form that `firebase` and `testflight` use,
and this design does not emit that form.

`asRecord` is never imported either, since the guard is always `asObjectish`.

**Targets.** Monorepo imports from `../../shared/search-filter.ts`. Standalone imports from the
single `@nimbus-dev/sdk/connector-kit` barrel. All six primitives are exported from
`connector-kit/index.ts` as of the 1.15.0 release commit (`f2932d4`), and npm is at 1.16.0, so
the registry acceptance path will not report `SKIP` for an unpublished floor.

## Fixtures

- **`dependencytrack`** — the one real connector this change makes byte-exact. Guards with
  `asObjectish`, names its extractor `fieldsOf`, carries no doc comment, and its fields are
  three `stringField` reads plus `tagNamesFromObjects`. Its expectation entry lists
  `src/search-filter.ts`; the README is omitted, as with the other search fixtures.
- **`zzextract`** — throwaway, exercises all three entry kinds in one file, and carries the
  standalone/registry path.

Per `CLAUDE.md`, both specs are hand-written from the API shape. No connector source is copied
into this repository.

## Testing

- Unit tests per entry kind and per rendering-table row, including that a plain-string-only
  spec still emits `fieldsFromKeys` unchanged.
- A convergence test: a spec with a trailing `{"tags":"text"}` and the equivalent spec with
  `tags: true` emit **identical bytes**.
- A rejection test per new validator error, each asserting the offending key appears in the
  message.
- Import-set tests for both targets, asserting absent primitives are *not* imported — including
  that a paths-only spec imports `nestedString` but neither `tagText` nor `tagNamesFromObjects`,
  and that no branch ever imports `FieldExtractor` or `asRecord`.
- `test/emit/emitted-typecheck.test.ts` covers the emitted source compiling.

Generated `test/sandbox.test.ts` is not evidence — it is wrapped in
`describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])` and skips on every run.

## Gates

| Gate | Expected |
| --- | --- |
| `bun test` | green |
| `bunx tsc --noEmit` | green |
| `bunx biome check src/ test/ scripts/` | green |
| `bun run diff:golden --nimbus-root <path>` | `newrelic`/`datadog`/`grafana`/`sentry` still **6/6**; `mercury`/`zendesk` still **6/7**; `dependencytrack` at its declared expectation |
| `bun run standalone-acceptance --registry` | fully verified, not `SKIP` |
| `bun run acceptance <nimbus-root>` | green |

`fixtures/expectations.json` is never edited to hide a mismatch.

## Docs

- ROADMAP Stage E: replace the single bespoke-extractor bullet with the A/B/C breakdown and the
  reach this change achieves.
- ROADMAP *Known limitations*: add the guard, extractor-form, extractor-name and doc-comment
  gaps that keep Group A from byte-matching.
- ROADMAP: correct the multi-file bullet. It names `elasticsearch` and `storybook`; 16
  connectors carry `src/tools.ts` and `server.ts` imports it in 15 of them.
- Live numbers stay out of the docs. `diff:golden` is the answer.

## Considered and declined

Recorded so they are not re-proposed. Each came out of review on 2026-08-02.

**A tagged discriminated union for field entries** — `{ "type": "nested", "path": [...] }`
rather than `{ "path": [...] }`. Declined. The required-key sets are already disjoint under
`strictObject`, so the untagged form is unambiguous today, and it stays extensible: a future
coercion kind is either a new disjoint shape or an optional key on an existing one. The cost is
paid on every entry an author writes, for extensibility this design explicitly defers to a
later one. `spec.ts` also has no `discriminatedUnion` precedent to follow. If union error
messages prove poor in practice, the fix is a `superRefine` naming the unrecognised entry
shape — not a keyword on every entry.

**A deprecation warning on legacy `tags: true`.** Declined, and it would have been actively
harmful. `tags: true` is not superseded — it is the *only* spelling that reaches the
`fieldsFromKeys` form, which is what `zendesk` and `raindrop` are written in and what `zendesk`
byte-matches on today. Steering authors off it would push them to the `fieldsOf` form and break
byte-matches. The trailing-`{"tags":"text"}` convergence rule above addresses the underlying
concern — two spellings, one emission — without deprecating anything.

**Numeric or boolean extraction primitives** (`nestedNumber`, `booleanField`). Declined here,
on two grounds. `stringField` and `nestedString` do not coerce — both are
`typeof v === "string" ? v : ""`, so a non-string field contributes `""` to the haystack. No
Group A connector needs coercion; the connectors that do (`databricks`, `dbt`, `flagsmith` and
others wrapping values in `String()`) are all Group B, already out of scope. More decisively,
`shared/search-filter.ts` exports no such primitive, and the emitter may only compose helpers
that already ship: adding one means a change to the AGPL Nimbus repo *and* a release of the MIT
SDK, neither of which this repository can make unilaterally.

## Out of scope

- Group B's 30 local-helper extractors. Reaching them means modelling joins, array flattening
  and coercion — a mini-AST in the spec language, deserving its own design once the entry-union
  shape has proven itself.
- `zoom`'s hand-rolled filter.
- Any guard, form, name or doc-comment spec field.

## Reach

Group A went through three passes, and the history is recorded here rather than smoothed over,
because the second pass was also wrong and shipped into this document and the ROADMAP before
being caught.

**Pass 1**, pattern-matched: 12 files. Too loose — it did not distinguish a local *function*
declaration from a local *variable* binding, so it counted several files (`dagster`, `semgrep`,
`intercom`, and others) that define genuine local helper logic.

**Pass 2**, reading every file by hand, but scripted with the range `/^function fieldsOf/,/^}/`
to check for local bindings: 7 files. This under-counted. The pattern never matches `firebase`
and `testflight`, which write their extractor as `const releaseFields: FieldExtractor = (item)
=> {…}` — an arrow, not a `function` declaration — so the script reported those two as having
*zero* local bindings and, by the (also wrong) criterion "bind locals before the return array",
excluded `hubspot` and `miro` for a shape that `firebase` and `testflight` share:

```ts
// hubspot — excluded by pass 2
const props = asObjectish(row["properties"]) ?? {};
return [stringField(props, "dealname"), stringField(props, "dealstage"), ...];

// firebase — kept by pass 2, because the range pattern never matched its arrow form
const releaseNotes = asObjectish(row["releaseNotes"]) ?? {};
return [..., stringField(releaseNotes, "text"), ...];
```

These are the same pattern: project a sub-object, then read flat keys off it. Both are exactly
what a `path` entry expresses — `{ "path": ["properties", "dealname"] }`,
`{ "path": ["releaseNotes", "text"] }`. A local *variable* binding is not disqualifying; only a
local *function* declaration or logic no entry kind reaches (a join, an array flatten, a
coercion) is.

**Pass 3**, every file read against the corrected criterion: **9**. `hubspot` and `miro` move
back in; nothing else changes.

| Connector | Why it is not reachable (pass 3, corrected criterion) |
| --- | --- |
| `dagster`, `semgrep`, `bigeye`, `databricks`, `dbt`, `flagsmith`, `flux`, `greenhouse`, `launchdarkly`, `lever`, `looker`, `mendeley`, `metabase`, `mlflow`, `netlify`, `powerbi`, `prefect`, `ramp`, `readwise`, `snowflake`, `sonarqube`, `stackoverflow`, `superset`, `tableau`, `vercel`, `wiz`, `zotero`, `airflow` | define a local helper function |
| `intercom` | defines a local `tagText` that shadows the shared export |
| `snyk` | inline coercion logic (array filter over `cve`), no local function needed to disqualify it |

That is 30 (some rows above collapse several connectors sharing the same reason). The remaining
nine — `argocd`, `canva`, `dependencytrack`, `figma`, `firebase`, `hubspot`, `miro`,
`salesforce`, `testflight` — all generate a correct filter under this design. One
(`dependencytrack`) byte-matches.
