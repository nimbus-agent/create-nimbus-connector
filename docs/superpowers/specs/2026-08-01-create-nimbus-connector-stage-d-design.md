# create-nimbus-connector — Stage D design

**Status:** implemented on `feat/stage-d-search`; see §8 for the acceptance run. One gate is
red and stays red until the SDK release lands — `standalone-acceptance --registry` cannot
resolve `@nimbus-dev/sdk ^1.15.0`, because the search kit is unmerged (§6 step 4).
**Date:** 2026-08-01, acceptance recorded 2026-08-02
**Predecessors:** Stage A (generator, monorepo target), Stage B (standalone target), Stage C (writes, `hitlRequired`, `client-credentials`, Gateway wiring — published as `create-nimbus-connector@0.3.3`)

Stage D adds the connector shape that Stages A–C left untouched: the `runReadOnlyMcpConnector`
registration style, and the search tools that style almost always carries.

---

## 1. Ground truth

Measured against the 94 connectors in `C:\gitrep\Nimbus\packages\mcp-connectors` and the SDK
checkout at `C:\gitrep\nimbus-sdk` on 2026-08-01. Two findings changed the shape of the design
and one closed a question before it was asked.

### 1.1 The gap is a registration style, not a search feature

Search entered this discussion as "the generator emits neither `search-filter` nor
`mcp-search-tool`". That is true, and it is not the load-bearing part.

| Shared helper | Connectors importing it |
| --- | --- |
| `mcp-tool-kit` | 94 |
| `run-read-only-mcp-connector` | 60 |
| `search-filter` | 49 |
| `mcp-search-tool` | 45 |

All 44 connectors that import both search helpers also import `run-read-only-mcp-connector`, and
none of them imports `rest-tool-kit`. The generator has exactly two styles — `rest-kit` and
`hand-rolled` — and neither is this one. **A search connector cannot be byte-reproduced without
first emitting the style**, and the style covers 16 connectors that have nothing to do with
search.

### 1.2 The style is a bootstrap wrapper and nothing else

`shared/run-read-only-mcp-connector.ts` is 40 lines. Its whole body is
`createZodToolRegistrar(createRegisterSimpleTool(mcp))` over an `McpServer`, followed by a stdio
connect.

Against the existing `hand-rolled` output the difference is confined to the file's ends.
`newrelic` opens `new McpServer(...)`, declares its tools at top level, and closes
`await mcp.connect(transport)`. `mercury` wraps the identical registrations in
`await runReadOnlyMcpConnector("nimbus-mercury", (reg) => { … })`. Prologue, epilogue, and two
spaces of indentation. Env accessor, fetch helper and tool bodies are unchanged.

The style therefore inherits every `hand-rolled` schema rule rather than introducing its own.

### 1.3 `runReadOnly` does not mean read-only

Nine of the 60 declare `hitlRequired: ["write"]`: `argocd`, `bigeye`, `flux`, `looker`, `mlflow`,
`monte-carlo`, `powerbi`, `snowflake`, `tableau`. None declares `["write", "delete"]`.

The helper registers whatever it is handed; the name describes the tier those connectors were
written for, not a capability the code enforces. A validation rule forbidding write tools under
this style would have contradicted the corpus.

### 1.4 The two search helpers have different dependency profiles

This is the Stage B distribution question again, and it splits cleanly.

- **`shared/search-filter.ts`** — 140 LOC, **zero imports**. Pure predicate and field-extraction
  code. SDK-eligible verbatim, exactly as `mcp-tool-kit` was in Stage B.
- **`shared/mcp-search-tool.ts`** — 37 LOC, two exported functions. `matchesResult` is
  dependency-free. `searchToolInputSchema` is the only thing in either file that needs zod, and
  it is four lines of `z.object({ query, limit })`.

`@nimbus-dev/sdk` still declares `"dependencies": {}`, and `connector-kit/mcp-tool-kit.ts:117`
records the intent in the source: *"typed as unknown to avoid a zod import from this shared
path."* `connector-kit` ships three modules today — `fetch-bearer-json`, `mcp-tool-kit`,
`rest-tool-kit`.

Generated connectors already depend on `zod ^4.4.2` and `@modelcontextprotocol/sdk 1.30.0`
(`src/emit/package-json.ts:33-36`). The zero-dependency constraint binds the SDK, not the
connector — which is what makes §2 D4 possible.

### 1.5 The per-connector filter file is more formulaic than Stage C's writes, less than the read path

49 connectors carry a seventh file, `src/search-filter.ts`. Classified:

| Shape | Count |
| --- | --- |
| `makeQueryFilter(fieldsFromKeys([...]))` | 9 |
| Hand-written `fieldsOf` extractor | 40 |

The 9 are strikingly uniform: **6 of them are the identical 11-line file** — `bitrise`,
`codemagic`, `mercury`, `monte-carlo`, `pipedrive`, `zendesk` — one export, no local functions,
differing only in the key list and an optional `{ tags: true }`. Of the remaining three, `stripe`
(19) is the identical shape with a seven-key list the formatter wraps one per line; `workday` (5)
is the shape minus the type alias (§1.5.1); and `raindrop` (20, two exports) carries a prose doc
comment on its second filter and is therefore **not** byte-reproducible, despite using
`fieldsFromKeys` for both. `mercury`:

```ts
import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type MercurySearchMatchOptions = SearchMatchOptions;

export const filterMercuryAccounts = makeQueryFilter(
  fieldsFromKeys(["id", "name", "status", "type", "kind", "legalBusinessName"]),
);
```

The other 40 hand-write an extractor carrying an API-specific doc comment — `firebase` projects
`releaseNotes.text` up out of a nested object, `vercel` reaches into
`meta.githubCommitMessage`. Semantically most are flat keys plus one or two nested lookups, and
`shared/search-filter.ts` already exports `nestedString` for that. But the prose is about that
service's API, so **none of the 40 is byte-reproducible**, however well the extraction is
modelled.

#### 1.5.1 The type alias is a 47-of-49 convention, not a rule

Every filter file but two exports
`export type <PascalCase>SearchMatchOptions = SearchMatchOptions`, a re-export that nothing else
in the connector appears to consume. `workday` and `zoom` omit it.

The emitter follows the 47 and always emits it. The consequence is recorded rather than hidden:
**`workday` and `zoom` can never byte-match**, by a deliberate choice to follow the convention
rather than to make an unused type alias conditional on a spec field nobody would set. Neither is
a chosen fixture, and all three fixtures in §5.1 carry the alias.

This sits between the two precedents deliberately. Stage C §1.3 found 18 distinct write-helper
skeletons from 18 helpers and concluded byte-matching was unachievable. The read path had 66/94
identical `package.json`. Here, one shape covers 9 connectors exactly and the rest do not
converge at all.

### 1.6 Search tool variation

| Axis | Corpus |
| --- | --- |
| `searchToolInputSchema(n)` | 100 ×24, 200 ×12, 2000 ×2, 50 ×1 |
| Search tools per connector | 1 in most; `raindrop` has 2, sharing one filter *file* but declaring **two distinct exports** over different key lists — `filterRaindropBookmarks` and `filterRaindropCollections`. No connector reuses one filter across two search tools |
| Response envelope | `mercury` plucks `root.accounts`; `bitrise` passes the response straight through |
| Extra arguments | `bitrise` takes an `appSlug` path parameter, so it inlines `z.object({ appSlug, query, limit })` instead of calling `searchToolInputSchema` |

### 1.7 A negative result: the style alone has no byte-matchable fixture

No small, single-file, plain-REST connector uses `runReadOnlyMcpConnector` without search. The
candidates all fail for a structural reason:

| Connector | LOC | Why not |
| --- | --- | --- |
| `elasticsearch` | 116 | Splits tools into `src/tools.ts` |
| `storybook` | 141 | Splits into `src/tools.ts` and `src/storybook-parse.ts` |
| `cloud-logging`, `sagemaker`, `cloudwatch`, `vertex-ai`, `athena` | 122–188 | Shell out via `shared/safe-cli-arg`, not `fetch` |

The generator emits a single `src/server.ts`, so none of these is reachable. In the corpus this
style is overwhelmingly paired with search — 44 of 60. §5 states what that costs in evidence.

### 1.8 `rest-kit` has no seam for a search tool

`makeRestToolRegistrar` takes a path callback and an optional
`(parsed) => ({ method, body })` init callback, then performs the fetch **and wraps the result**
itself. A search tool has to intervene between the response and the MCP result — pluck the
envelope, run the filter, return `{ matches }` — and the registrar exposes no callback at that
point.

This is the same shape as Stage C's D9, where `client-credentials` was restricted to
`hand-rolled` because the registrar resolves one bearer credential itself and has no seam for a
token exchange. The corpus agrees independently: **no connector imports both `rest-tool-kit` and
`mcp-search-tool`** — the intersection of the 10 rest-kit users and the 45 search users is empty.

`impl: "search"` is therefore rejected on `style: "rest-kit"` (§3.3), and the exclusion is forced
by the helper's shape rather than chosen for tidiness.

### 1.9 Not found: any pagination helper

`shared/` contains none, and the `limit` argument caps a client-side filter over an
already-fetched array. `mercury`'s own tool description says it plainly: *"There is no
pagination — Mercury returns the full account list in one call."* "Search and pagination" was the
framing this stage started from; the corpus supports only the first half.

---

## 2. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | `style: "read-only-kit"` becomes a third first-class style | §1.1 — 60 of 94 connectors, more than search itself |
| D2 | The style permits write tools | §1.3 — 9 connectors using it declare `["write"]` |
| D3 | Search is a tool kind, `impl: "search"`, valid on `hand-rolled` and `read-only-kit` but **rejected on `rest-kit`** | Additive to Stage C's `impl` enum, as `"rest"` was. The exclusion is forced by `makeRestToolRegistrar`, not chosen — see §1.8 |
| D4 | `search-filter` and `matchesResult` move into `@nimbus-dev/sdk/connector-kit`; `searchToolInputSchema` does not | §1.4 — only the last needs zod, and it is four emittable lines. The SDK's `"dependencies": {}` stays literally true |
| D5 | Flat keys and `tags` render `fieldsFromKeys`; anything else emits a throwing **filter** stub | §1.5 — Stage C §6's `*-mapping.ts` precedent: scaffold the hard case, never guess it. The throw sits in the filter, not the extractor, so it cannot be skipped by an empty result set (§4.3.1) |
| D6 | Emission is target-aware — monorepo emits `searchToolInputSchema(n)` and `../../shared/*`; standalone inlines the zod schema and imports the SDK | The targets already diverge this way, and byte-matching `mercury` requires the former |
| D7 | The `runReadOnly` glue is emitted inline for standalone, not added to the SDK | §1.2 — its primitives are already SDK exports; the helper itself imports `@modelcontextprotocol/sdk`, which the SDK core must not |

**Backward compatibility.** Every change is additive. `style` gains a third enum value with its
default unchanged (`rest-kit`); `impl` gains `"search"`. No existing spec file changes meaning,
and specs written against `0.3.3` generate byte-identical output.

**The naming wart, stated rather than smoothed over.** `read-only-kit` names a style that D2
explicitly allows to write. The alternative is inventing a name for a helper the emitted code
calls `runReadOnlyMcpConnector`, which is worse: the spec field would stop describing the output.
The name is Nimbus's, and it is inaccurate there too.

The warning belongs in the generated `README.md`, under the existing `## What this is` heading,
and **not** as a comment in `server.ts`. Two reasons. No connector in the corpus carries such a
comment — verified — so emitting one would forfeit byte-matching for exactly the nine connectors
that most need the caveat (§1.3), which is the wrong trade in the wrong place. And the README is a
file this generator authors outright, so a sentence there costs no fidelity at all. A reader or
auditor who needs to know that `runReadOnly` does not constrain writes is served either way; only
one of the two options also breaks the diff harness.

---

## 3. Schema

### 3.1 The style

`style: z.enum(["rest-kit", "hand-rolled", "read-only-kit"]).default("rest-kit")`.

`read-only-kit` inherits every `hand-rolled` rule unchanged — the same `fetchHelper.headers` /
`inlineHeaders` exclusivity, the same env accessors, the same `client-credentials` eligibility —
because §1.2 shows the difference is confined to the bootstrap.

### 3.2 The search tool

```jsonc
{
  "name": "mercury_search",
  "description": "Substring search across the user's Mercury accounts…",
  "impl": "search",
  "path": "/api/v1/accounts",
  "rows": "accounts",
  "maxLimit": 100,
  "filter": {
    "export": "filterMercuryAccounts",
    "fields": ["id", "name", "status", "type", "kind", "legalBusinessName"]
  }
}
```

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `rows` | `string` | — | Property plucked from the response envelope. Omitted ⇒ the response *is* the array (§1.6, the `bitrise` shape) |
| `maxLimit` | integer | `100` | §1.6 |
| `filter.export` | identifier | — | The exported const name |
| `filter.fields` | `string[]` | — | Flat keys. Omitted ⇒ throwing stub (D5) |
| `filter.tags` | boolean | `false` | Appends the shared `tagText`, as `zendesk` does |

### 3.3 Validation

Following the Stage A precedent that the schema must reject anything the emitters cannot render:

- `method` and `body` are rejected on `impl: "search"` — a search issues a GET and has no body,
  the rule `impl: "stub"` already carries.
- `effect` must be `"read"`. A search that mutates is a bug, not a design. This is deliberately
  stricter than Stage C §3.2's treatment of stubs, where a non-`read` effect is permitted because
  the stub stands in for an implementation that will write. A search tool stands in for nothing.
- `filter.fields`, when present, must be non-empty. An empty key list makes the haystack `""`,
  which matches every row — Stage A's empty-`checks` array printing success, wearing a different
  hat.
- `filter.export` must be a valid TypeScript identifier and unique across the spec's tools.
  `raindrop` proves multiple search tools per connector is real, and they share one filter file.
- A search tool **may** declare `args`, and that decides the schema form: with none, the emitter
  calls `searchToolInputSchema(maxLimit)`; with args, it inlines
  `z.object({ …args, query, limit })`, the `bitrise` shape.

### 3.4 The seven fields Task 10 added, and which of them are cosmetic

Written **after** the fact. §3.1–§3.3 were designed up front; these came out of driving three
real connectors to a byte diff, and every one of them is a per-connector convention this design
had not measured. They are recorded here in full, including the judgement that most of them buy
no capability, because the honest version is more useful to Task 13 than a tidy one.

All seven are additive and default to the pre-Stage-D behaviour, so §2's backward-compatibility
claim survives — with one exception noted at the end.

| # | Field | Buys | Corpus evidence |
| --- | --- | --- | --- |
| F1 | `fetchHelper.baseConst` | **Formatting only** | Hoists a fully static base to `const BASE = "…";` and references it from the helper. `mercury` spells it `BASE`, `bitrise` `BITRISE_API`. Rejected when `base` names `${env.X}` — that resolves to an accessor call, which must not run at module-initialisation time. Gated on a helper actually being emitted, or the const is an unread local |
| F2 | `env[].tokenLocal` | **Formatting only** | Splits a bearer accessor into a `(): string` reader plus a header wrapper that calls it. **12** connectors are byte-reproducible by it — canva, figma, hubspot, mercury, miro, netlify, raindrop, salesforce, stackoverflow, stripe, vercel, zoom. The membership rule is narrower than "splits the accessor in two"; see §3.4.1 |
| F3 | `handlerStyle: "concise" \| "block"` | **Formatting only** | A statement-bodied handler with an explicit `return`, versus an expression-bodied arrow. **57 of the 60** `runReadOnlyMcpConnector` connectors use the block form; firebase, tableau and workday do not |
| F4 | `argsSchemaStyle: "inline" \| "expanded"` | **Formatting only** | `z.object` on one line or one field per line. Biome preserves whichever the emitter produces, so this is the emitter's decision, not the formatter's. `z.object({})` stays inline under both |
| F5 | `env[].transform: "trimTrailingSlashFn"` | **Formatting only** | Emits the shared `function trimTrailingSlash(s)` once and calls it, instead of inlining `.replace(/\/$/, "")`. The corpus splits **13 to 3** in the helper's favour — this is not a close call. The inline form is kept only because `grafana` and `sentry` are byte-locked on it |
| F6 | `env[].auth: "basic"` | **Capability** | HTTP Basic via `encodeBasicAuthHeader`: airflow, greenhouse, lever, zendesk. Nothing before this could emit it. Each variable is read and guarded on its own, naming only the one that is missing — deliberately not the combined guard `auth: "headers"` builds. `prefix`/`suffix` are permitted here alone, decorating the **username** (zendesk's `` `${email}/token` ``), a position the auth wrapper does not replace |
| F7 | `filesystem` | **Capability** | Emits `permissions.filesystem` into the manifest. **29 of 94** manifests declare it; the other 65 omit the key, and the spec field's optionality is that distinction |

#### 3.4.1 F2's inclusion criterion, and why it needed writing down

This number was wrong three times — first citing testflight and dbt (neither has the split at
all), then citing 15 with three wrong members and `stripe` missing. The cause was not
carelessness about connectors; it was that **no inclusion criterion had been stated**, and
"splits the accessor in two" is fuzzy in exactly the place that decides the answer.

`renderSplitBearer` **hardcodes** its wrapper. A connector counts only if it has all of:

1. a wrapper **function** returning `Record<string, string>` — not an inline use of the reader
   at a call site;
2. whose whole body is one `return` of a **one-line** object literal;
3. with **exactly two** keys, `Authorization` then `Accept: "application/json"`;
4. whose `Authorization` value is exactly `` `Bearer ${reader()}` `` — the literal `Bearer `
   prefix, and a **call** to the reader, **in a header**;
5. plus a reader of that name matching `readLines` + `guardLines` for one required variable.

The five borderline connectors, decided explicitly rather than left to judgement:

| Connector | Has a split? | Verdict | Clause |
| --- | --- | --- | --- |
| `intercom` | yes | **out** | (3) — adds a third header, `"Intercom-Version": "2.11"` |
| `readwise` | yes | **out** | (4) — wrapper emits `` `Token ${apiToken()}` ``, not `Bearer` |
| `dagster` | reader only | **out** | (1)(4) — `apiToken()` is passed inline to a custom `"Dagster-Cloud-Api-Token"` header |
| `pipedrive` | reader only | **out** | (4) — `apiToken()` is spliced into a query string, never a header |
| `mendeley` | reader only | **out** | (1) — `` `Bearer ${accessToken()}` `` is inline in the fetch helper's headers option; no wrapper function |

Counted mechanically across all 95 connector directories, not by eye. The script and its full
output are in the task-10 report's fix-round-2 section, so the number is reproducible rather
than asserted — which is the same standard §2's D-decisions and Stage C's `hitlRequired`
finding are held to.

**So five of the seven are cosmetic.** They exist because this stage's acceptance bar is a byte
diff against hand-written files, and hand-written files carry their authors' habits. That is a
real cost — five spec fields a user must now choose between, none of which changes what a
connector can do — and it is the price of the byte-diff bar rather than a design gain. Anyone
weighing a sixth cosmetic field should weigh it against that sentence.

**Two are per connector where the corpus is per tool.** `argsSchemaStyle` in particular: argocd,
bigeye, flux, monte-carlo, powerbi, snowflake and tableau each mix both forms across their own
tools. All three Task 10 fixtures are internally uniform, so a per-tool override was not needed
and was not guessed at. It will be, for some fourth fixture.

**The one backward-compatibility exception.** A single-variable `auth: "headers"` accessor now
emits its header object on one line, behind no spec field. This is byte-visible to an existing
`0.3.3` user regenerating a connector — semantically neutral, but a diff. It is recorded in
`CHANGELOG.md` under Unreleased as an output change rather than being left for a user to find.
The four locked fixtures do not move and the reason is structural, not luck: `newrelic` uses
`inlineHeaders` with no `auth` entry, `grafana` and `sentry` are `auth: "bearer"`, and `datadog`
is `auth: "headers"` with **two** variables, taking the unchanged multi-variable branch.

---

## 4. Emission

### 4.1 The invariant that protects the four 6/6 fixtures

Stage C §4.1's invariant, restated for this axis. The `read-only-kit` prologue is reached only
when `style` names it, and search emission only when a tool declares `impl: "search"`.
`newrelic`, `datadog`, `grafana` and `sentry` declare neither, so every new code path is
unreachable from them. Byte-safety by construction, not by care.

### 4.2 `src/server.ts`

Both targets emit the **identical call site**:

```ts
await runReadOnlyMcpConnector("nimbus-mercury", (reg) => {
  reg( … );
});
```

Only the function's provenance differs. The monorepo target imports it from
`../../shared/run-read-only-mcp-connector.ts`. The standalone target defines the same 15-line
body locally over `createZodToolRegistrar` and `createRegisterSimpleTool`, which
`@nimbus-dev/sdk/connector-kit` already exports (D7). One call site, two prologues — no
divergence in the part a reader looks at.

### 4.3 `src/search-filter.ts`

The seventh file, emitted only for specs containing a search tool. Monorepo target, byte-targeting
§1.5's 11-line shape:

```ts
import {
  fieldsFromKeys,
  makeQueryFilter,
  type SearchMatchOptions,
} from "../../shared/search-filter.ts";

export type MercurySearchMatchOptions = SearchMatchOptions;

export const filterMercuryAccounts = makeQueryFilter(
  fieldsFromKeys(["id", "name", "status", "type", "kind", "legalBusinessName"]),
);
```

The standalone target emits the same file with the import redirected to
`@nimbus-dev/sdk/connector-kit`. The exported type alias is
`PascalCase(connector) + "SearchMatchOptions"`, emitted unconditionally per §1.5.1.

Multiple search tools contribute multiple exports to the one file, each with its own key list;
no connector in the corpus reuses one filter across two search tools (§1.6).

#### 4.3.1 The stub replaces the filter, not the extractor

With `filter.fields` omitted, the emitted stub is the **filter itself**, and `makeQueryFilter` is
not called at all:

```ts
export const filterMercuryAccounts: SearchFilter = () => {
  throw new Error(
    "mercury_search: supply the searchable fields for this resource — " +
      "replace this stub with makeQueryFilter(fieldsFromKeys([...])) or a bespoke extractor.",
  );
};
```

The obvious alternative — keeping `makeQueryFilter(stubExtractor)` and throwing inside the
extractor — is wrong, and the reason is a property of the shared code rather than a matter of
taste. `makeQueryFilter` returns a closure that defers to `filterByQuery`, which invokes
`options.fields(item)` **once per row**. An extractor that throws therefore fires lazily, and on
an empty result set it never fires at all: the tool returns `{ matches: [] }` and reports success.
A stub that silently passes whenever the upstream list happens to be empty is the exact failure
mode Stage A's empty-`checks` array and Stage C §5.2's "vacuous pass" both describe. Throwing from
the filter position fires on every invocation, regardless of what the API returned.

This costs nothing in fidelity: a stubbed filter byte-matches no corpus connector either way
(§5.1, expectation `[]`).

### 4.4 The search tool body

With `rows`, the envelope is plucked; without it, the response passes straight through.

```ts
async (p) => {
  const root = await mercuryGet(`/api/v1/accounts`);
  const accounts = (root as { accounts?: unknown[] } | null)?.accounts;
  return matchesResult(accounts, filterMercuryAccounts, p);
},
```

### 4.5 The SDK floor

A standalone spec using search emits `@nimbus-dev/sdk` `^1.15.0` — the release carrying
`search-filter` and `matchesResult`. Specs without search keep `^1.11.0`. Raising the floor for
everyone would strand users on a version they have no reason to need.

**This number was 1.12.0 in the design and in the plan, and both were overtaken by the SDK's own
release train.** `nimbus-sdk` shipped typescript 1.12.0, 1.13.0 and 1.14.0 while Stage D was
being built, none of them carrying the search kit — verified with
`git ls-tree typescript-v1.14.0 sdks/typescript/src/connector-kit/`, which lists
`fetch-bearer-json`, `mcp-tool-kit` and `rest-tool-kit` only. Emitting `^1.12.0` would therefore
have resolved 1.14.x and left every emitted
`import { matchesResult } from "@nimbus-dev/sdk/connector-kit"` unresolvable — a floor that
reads as satisfied and is not. The kit lands in the next minor after main's 1.14.0, so the
floor is `^1.15.0`. The lesson generalises: a floor naming an unreleased version has to be
re-derived at the moment it is emitted, not carried forward from a design written weeks earlier.

---

## 5. Testing

### 5.1 The monorepo golden harness

This is the first stage that **raises** the harness's claim rather than defending it. Three real
fixtures join, each byte-targeting a full seven-file tree. `expectations.json` lists the files
expected to match per fixture, so `src/search-filter.ts` simply joins the list and the `n/n`
denominator follows — no harness change.

The table below is the **measured** outcome, not the original prediction. This design planned
7/7 for all three; none of them reaches it, and §5.2 says why for each. The numbers are left
corrected in place rather than annotated, because a plan number and a result number in the same
cell is how a stale document reads as a current one.

| Fixture | Result | Covers |
| --- | --- | --- |
| `mercury` | **6/7** | The style, the `rows` pluck, `searchToolInputSchema(100)`, the `fieldsFromKeys` filter |
| `zendesk` | **6/7** | The same, plus `{ tags: true }`, `auth: "basic"`, and `permissions.filesystem` |
| `bitrise` | **4/7** | The `args`-bearing search — inline `z.object`, `.max(200)`. Note: `bitrise` **does** pluck `rows: "data"`; the "no `rows`" reading of §1.6 was wrong about this connector, and the no-`rows` path is covered by unit tests instead |

Two synthetic fixtures join at expectation `[]`:

- **`zzsearch`** — standalone search, so the SDK import path and the inlined `runReadOnly` glue
  face a real `tsc`.
- **`zzsearchstub`** — the throwing-filter path, and it is not optional. Per §4.3.1 a stub file
  imports the `SearchFilter` type and calls neither `makeQueryFilter` nor `fieldsFromKeys`, and
  its body references no parameters: precisely the shape that shipped an unread local in Stage C,
  invisible to substring assertions and caught only when a package was put in front of its own
  `tsc` and `biome`. A spec mixing one stubbed and one keyed filter must therefore import both
  sets of symbols and neither more nor less. Stage C §5.3 paid for that lesson with `zzwriteonly`;
  this applies it before the defect rather than after.

That takes the golden harness from 12 fixtures to 17, and standalone acceptance from four
fixtures to six. Runtime grows linearly with fixture count, as Stage C §5.3 already recorded —
each fixture installs the SDK and runs a real `tsc` and `bun build`.

### 5.2 Seven honest limits

The first three were designed in. The last four were **found** by Task 10, and each is a file
the harness reports as not matching. None of them is hidden by an expectation entry: the entries
list what genuinely matches, so every gap below is on screen on every run.

1. **The style alone is never byte-proven.** §1.7 is a measured negative result: no plain
   single-file REST connector uses this style. Every real fixture above is a search connector, so
   "the style renders correctly *without* search" rests on `zzsearch`'s snapshots and its `tsc`,
   not on the corpus. That is weaker evidence, and it is weaker because the corpus is.
2. **The 40 bespoke filters are not attempted.** D5 emits a stub for them. If anyone adds one as a
   fixture the diff harness will report it unmatched, which is the correct answer rather than a
   gap to close.
3. **Byte-matching search proves nothing about search quality.** `filterByQuery` is a
   case-insensitive substring match over joined fields. Reproducing `mercury` proves we emit that;
   it says nothing about whether substring matching is the right retrieval strategy. That decision
   is Nimbus's, inherited wholesale.
4. **`README.md` is unreachable for all three, and that is what makes the bar 6/7.** All three
   connectors carry hand-written prose naming their specific item types (`mercury:account`,
   `zendesk:ticket`), their three tool names, and their deferred follow-ups. No spec field derives
   it; the generator emits its own boilerplate, which `newrelic` — a 6/6 fixture — still carries
   precisely because nobody rewrote it. `README.md` is therefore omitted from all three
   expectation entries. **This is the only file omitted for a reason other than "it does not
   match", and the omission is what the 6/7 bar means.** Nothing else may be omitted on those
   grounds.
5. **`bitrise` has no `test/sandbox.test.ts` to match.** The real package's `test/` directory
   holds `search-filter.test.ts` and nothing else — 15 of the 94 connectors lack the sandbox
   test. The harness reports `MISSING`, not `DIFF`. No spec field can make the generator match a
   file that is not there, and the only alternative — stopping emitting the sandbox test — would
   break the four locked fixtures. Irreducible by construction.
6. **`bitrise`'s `src/server.ts` needs three things the spec language does not have.**
   `bitrise_list` and `bitrise_get` select their endpoint from whether an optional argument is
   present, take a `z.enum` argument mapped through a lookup table to an integer, and assemble a
   query string at runtime. A `ToolSpec` has one `path`, `ArgSchema.type` is
   `string | number | boolean`, and a path template is a fixed string with placeholders. Both are
   declared `impl: "stub"` — the same signal `discord_channel_messages` and both of
   `google-meet`'s tools already carry — and the verdict line prints `2 stub tool(s)`. Closing
   this means adding conditional-path and enum-argument support: a change to what a connector
   spec *is*, for two tools, and one connector is not enough evidence to design that syntax
   against. One consequence worth naming: with both non-search tools stubbed, nothing calls
   `jsonResult`, so the emitter correctly omits an import the real file has. That is a symptom
   of the stubs, not a second defect.
7. **`permissions.filesystem` is always emitted collapsed to one line.** 27 of the 29 manifests
   that declare it write it that way; the other 2 expand it, and this emitter cannot produce
   that. No fixture needs it, and a style field for two connectors nobody is reproducing would be
   speculative. Named here so the next person to hit it knows it was seen and declined, not
   missed.

---

## 6. Sequencing

1. `style: "read-only-kit"` — schema, emitter
2. `impl: "search"` — schema, validation, `src/search-filter.ts` emission, tool body
3. Throwing-stub extractor and `zzsearchstub`
4. **Nimbus SDK: add `search-filter` and `matchesResult` to `connector-kit`, release 1.15.0** —
   a separate PR in `nimbus-sdk`, runnable in parallel with 1–3
5. Standalone target — SDK import path, inlined glue, floor bump to `^1.15.0`
6. Golden fixtures `mercury` / `zendesk` / `bitrise`, snapshots, standalone acceptance

**Step 4 is the critical path for step 5**, exactly as Stage C §7 step 6 was for installability.
Until 1.15.0 is on the registry, standalone acceptance for search fixtures runs only in
local-checkout mode — which is what that mode is for, and it is the pre-release gate. Steps 1–3
and the three real fixtures in step 6 have no cross-repo dependency at all: the monorepo target
imports `../../shared/*` and needs no SDK release.

---

## 7. Out of scope

- **Bespoke field extractors** beyond flat keys and `tags` (D5, §5.2 limit 2).
- **Server-side pagination.** §1.9 — no helper exists, and the corpus does not paginate here.
- **Splitting emission into `src/tools.ts`**, the layout `elasticsearch` and `storybook` use. It is
  a real corpus shape and the direct reason §1.7 has no fixture, but it is a file-layout axis
  independent of this one.
- **Making `shared/mcp-search-tool.ts` dependency-free in the monorepo.** D4 routes around its zod
  import rather than changing it; that is Nimbus's call, not this repository's.
- **Changing what search *does*.** §5.2 limit 3.

### 7.1 Considered and declined

Two suggestions from the design review were measured and rejected. Recorded with their reasoning
so they are not re-proposed.

**Coercing the row set before `matchesResult` — e.g. `accounts ?? []`.** Declined: the guard
already exists one level down, and adding a second would cost a fixture. `matchesResult` is

```ts
const matches = Array.isArray(rows) ? filter(rows, opts) : [];
```

so `undefined`, `null`, and any non-array already yield an empty match set. `rows` is typed
`unknown` precisely because external payloads are untyped at the boundary. A `?? []` at the call
site would be dead code that changes `mercury`'s bytes, and `mercury`'s `src/server.ts` is one of
the six files it byte-matches (§5.1) — the coercion would trade a real verification signal for a
branch that can never be taken.

**A validation-time performance warning on a large `maxLimit`.** Declined: it would measure the
wrong quantity. `maxLimit` caps how many matches `filterByQuery` *returns*; it has no effect on
how many rows are *fetched*, because the connector has already awaited the full response before
the filter runs (§1.9 — there is no pagination). A connector with `maxLimit: 50` against an
endpoint returning 100,000 rows carries the whole memory cost and would draw no warning, while
`snowflake` and `tableau` at 2000 would draw one for a cap that costs nothing. Warning on the
response size would be defensible; warning on `maxLimit` would train authors to lower a number
that is not the problem.

---

## 8. Acceptance results

Recorded 2026-08-02, on `feat/stage-d-search`, Tasks 11–13. Every command below was run in
this session against this branch; output is pasted as observed, not summarized and not copied
from the plan.

**1. `bun test`**

```
bun test v1.3.14 (0d9b296a)

 692 pass
 0 fail
 1195 expect() calls
Ran 692 tests across 42 files. [7.32s]
```

**2. `bunx tsc --noEmit`**

No output, exit 0.

**3. `bunx biome check src/ test/ scripts/`**

Exit 0. `Checked 91 files in 30ms. No fixes applied. Found 7 infos.` — infos, not errors, and
the same pre-existing `useLiteralKeys` / `useTemplate` set Stage C recorded (5 then; the two
added are in the Stage D scripts and are the same two rules).

**4. `bun run diff:golden --nimbus-root C:/gitrep/Nimbus`**

```
PASS  bitrise  4/7 files identical (expected partial, 2 stub tool(s))
PASS  datadog  6/6 files identical
PASS  discord  3/6 files identical (expected partial, 1 stub tool(s))
PASS  google-meet  2/6 files identical (expected partial, 2 stub tool(s))
PASS  grafana  6/6 files identical
PASS  mercury  6/7 files identical (expected partial)
PASS  newrelic  6/6 files identical
PASS  sentry  6/6 files identical
PASS  zendesk  6/7 files identical (expected partial)
PASS  zzscratch  0/6 files identical (expected partial)
PASS  zzsearch  0/7 files identical (expected partial)
PASS  zzsearchstub  0/7 files identical (expected partial)
PASS  zzstandalone  0/6 files identical (expected partial)
PASS  zzstandalonehand  0/6 files identical (expected partial)
PASS  zzwrite  0/6 files identical (expected partial)
PASS  zzwriteonly  0/6 files identical (expected partial)
PASS  zzwriterest  0/6 files identical (expected partial)

All fixtures match their declared expectations.
```

17 fixtures — the 15 Stage C left plus `zzsearch` and `zzsearchstub`. §4.1's byte-safety
invariant holds: `newrelic`, `datadog`, `grafana` and `sentry` are still 6/6. The three real
Stage D fixtures land at the §5.1 measured bar (6/7, 6/7, 4/7), not the 7/7 this design
originally predicted, for the reasons §5.2 limits 4–6 give.

**5. `bun run acceptance C:/gitrep/Nimbus`**

```
PASS  tsc --noEmit
PASS  biome check
PASS  audit:package-readmes
PASS  monorepo working tree clean
```

**6. `bun run standalone-acceptance C:/gitrep/nimbus-sdk/.claude/worktrees/connector-kit-search`**

7 fixtures × 10 checks, `All standalone acceptance checks passed.` The SDK root is the
worktree holding the unmerged `feat/connector-kit-search` branch, which is what local-checkout
mode is for: it answers "does an unreleased SDK branch satisfy the contract?".

This is the run that earned its keep. All 20 of `zzsearch`'s and `zzsearchstub`'s checks failed
the first time, on **three defects no unit test in this repository could see and no monorepo
fixture could reach** — see the Task 11 commit for the full account. In summary:
`searchToolInputSchema` was imported from an SDK that deliberately does not export it (its body
is a zod schema; the SDK's empty `dependencies` is load-bearing); the emitted
`"./search-filter.ts"` specifier tripped `TS5097` under a standalone tsconfig that omits
`allowImportingTsExtensions` by design; and filter names were emitted in declaration order,
which Biome's `organizeImports` rejects inside a clause. A fourth was latent — a standalone
`read-only-kit` spec with a zero-arg search tool names `type ZodObjectSchema` from both emitted
glues, which is `TS2300` until deduped.

**7. `bun run standalone-acceptance --registry` — FAILS, and is expected to.**

54 PASS, 16 FAIL. Every one of the 16 belongs to `zzsearch` or `zzsearchstub`; the five
non-search fixtures pass all 50 of their checks. The first failure states the whole cause:

```
error: No version matching "^1.15.0" found for specifier "@nimbus-dev/sdk" (but package exists)
```

**This gate cannot pass until the SDK release lands, and reporting the local-checkout run in its
place would be a false green.** §6 step 4 is the critical path and it is not finished: the
search kit sits on an unmerged, unpushed `feat/connector-kit-search`, and `@nimbus-dev/sdk` is
at 1.14.0 on the registry.

**8. External repositories and scratch state**

`git -C C:/gitrep/Nimbus status --short` → `?? facebook-post.txt` only, pre-existing and not
this project's. `git -C C:/gitrep/nimbus-sdk status --short` → clean, as is the worktree.
19 stale `cnc-prompt-*` / `cnc-help-*` directories were found under `%TEMP%` and removed; a
full `bun test` afterwards left **zero**, so they predate `test/support/tmp.ts` rather than
indicating a current leak.

### 8.1 Where a claim had to be qualified rather than asserted outright

- **The registry gate is red, not green.** Item 7 above. Standalone search is proven against an
  SDK *branch*, not against a published artifact. Local-checkout mode cannot see a `dist`
  missing from the published tarball's `files` array; only `--registry` can, and it has not run
  to completion for a search fixture.
- **The SDK floor is a prediction.** `^1.15.0` is the next minor after main's 1.14.0 and is not
  yet published. This design and the plan both said `^1.12.0`; releases 1.12.0, 1.13.0 and
  1.14.0 all shipped without the search kit while this stage was being built, so that floor
  would have resolved 1.14.x and left every emitted kit import unresolvable — see §4.5. If the
  SDK's release train moves again before the kit merges, this number moves with it.
- **The style alone is still never byte-proven**, exactly as §5.2 limit 1 says. `zzsearch` and
  `zzsearchstub` raise the evidence for the standalone `read-only-kit` path from snapshots to a
  real `tsc`, a real `biome check` and a real `tools/list` over stdio — but every *corpus*
  fixture for this style is a search connector, so "the style renders correctly without search"
  still rests on synthetic fixtures. That is a limit of the corpus, not of the testing.
- **The three real fixtures are 6/7, 6/7 and 4/7, not 7/7.** Unchanged from Task 10, restated
  here because §9 is where a reader looks for the bar: the gaps are hand-written READMEs, a
  sandbox test the real `bitrise` package does not contain, and two `bitrise` handlers the spec
  language cannot express. Each is on screen on every harness run rather than hidden by an
  expectation entry.
