# create-nimbus-connector — Stage D design

**Status:** designed, not implemented.
**Date:** 2026-08-01
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
(19) and `raindrop` (20, two exports) are the same shape at greater length, and `workday` (5) is
the same shape minus the type alias (§1.5.1). `mercury`:

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
| Search tools per connector | 1 in most; `raindrop` has 2, sharing one filter file |
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

### 1.8 Not found: any pagination helper

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
| D3 | Search is a tool kind, `impl: "search"`, layered on any style | Additive to Stage C's `impl` enum, as `"rest"` was |
| D4 | `search-filter` and `matchesResult` move into `@nimbus-dev/sdk/connector-kit`; `searchToolInputSchema` does not | §1.4 — only the last needs zod, and it is four emittable lines. The SDK's `"dependencies": {}` stays literally true |
| D5 | Flat keys and `tags` render `fieldsFromKeys`; anything else emits a throwing extractor stub | §1.5 — Stage C §6's `*-mapping.ts` precedent: scaffold the hard case, never guess it |
| D6 | Emission is target-aware — monorepo emits `searchToolInputSchema(n)` and `../../shared/*`; standalone inlines the zod schema and imports the SDK | The targets already diverge this way, and byte-matching `mercury` requires the former |
| D7 | The `runReadOnly` glue is emitted inline for standalone, not added to the SDK | §1.2 — its primitives are already SDK exports; the helper itself imports `@modelcontextprotocol/sdk`, which the SDK core must not |

**Backward compatibility.** Every change is additive. `style` gains a third enum value with its
default unchanged (`rest-kit`); `impl` gains `"search"`. No existing spec file changes meaning,
and specs written against `0.3.3` generate byte-identical output.

**The naming wart, stated rather than smoothed over.** `read-only-kit` names a style that D2
explicitly allows to write. The alternative is inventing a name for a helper the emitted code
calls `runReadOnlyMcpConnector`, which is worse: the spec field would stop describing the output.
The name is Nimbus's, and it is inaccurate there too.

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

With `filter.fields` omitted, the `makeQueryFilter(…)` argument becomes a named extractor whose
body throws and names what must be supplied — the shape Stage C §6 uses for `*-mapping.ts`.
Multiple search tools contribute multiple exports to the one file.

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

A standalone spec using search emits `@nimbus-dev/sdk` `^1.12.0` — the release carrying
`search-filter` and `matchesResult`. Specs without search keep `^1.11.0`. Raising the floor for
everyone would strand users on a version they have no reason to need.

---

## 5. Testing

### 5.1 The monorepo golden harness

This is the first stage that **raises** the harness's claim rather than defending it. Three real
fixtures join, each byte-targeting a full seven-file tree. `expectations.json` lists the files
expected to match per fixture, so `src/search-filter.ts` simply joins the list and the `n/n`
denominator follows — no harness change.

| Fixture | Expectation | Covers |
| --- | --- | --- |
| `mercury` | 7/7 | The style, the `rows` pluck, `searchToolInputSchema(100)`, the `fieldsFromKeys` filter |
| `zendesk` | 7/7 | The same, plus `{ tags: true }` |
| `bitrise` | 7/7 | The `args`-bearing search — inline `z.object`, no `rows` |

Two synthetic fixtures join at expectation `[]`:

- **`zzsearch`** — standalone search, so the SDK import path and the inlined `runReadOnly` glue
  face a real `tsc`.
- **`zzsearchstub`** — the throwing-extractor path, and it is not optional. A stub filter imports
  `FieldExtractor` and not `fieldsFromKeys`, and its body references no parameters: precisely the
  shape that shipped an unread local in Stage C, invisible to substring assertions and caught only
  when a package was put in front of its own `tsc` and `biome`. Stage C §5.3 paid for that lesson
  with `zzwriteonly`; this applies it before the defect rather than after.

That takes the golden harness from 12 fixtures to 17, and standalone acceptance from four
fixtures to six. Runtime grows linearly with fixture count, as Stage C §5.3 already recorded —
each fixture installs the SDK and runs a real `tsc` and `bun build`.

### 5.2 Three honest limits

1. **The style alone is never byte-proven.** §1.7 is a measured negative result: no plain
   single-file REST connector uses this style. Every 7/7 fixture above is a search connector, so
   "the style renders correctly *without* search" rests on `zzsearch`'s snapshots and its `tsc`,
   not on the corpus. That is weaker evidence, and it is weaker because the corpus is.
2. **The 40 bespoke filters are not attempted.** D5 emits a stub for them. If anyone adds one as a
   fixture the diff harness will report it unmatched, which is the correct answer rather than a
   gap to close.
3. **Byte-matching search proves nothing about search quality.** `filterByQuery` is a
   case-insensitive substring match over joined fields. Reproducing `mercury` proves we emit that;
   it says nothing about whether substring matching is the right retrieval strategy. That decision
   is Nimbus's, inherited wholesale.

---

## 6. Sequencing

1. `style: "read-only-kit"` — schema, emitter
2. `impl: "search"` — schema, validation, `src/search-filter.ts` emission, tool body
3. Throwing-stub extractor and `zzsearchstub`
4. **Nimbus SDK: add `search-filter` and `matchesResult` to `connector-kit`, release 1.12.0** —
   a separate PR in `nimbus-sdk`, runnable in parallel with 1–3
5. Standalone target — SDK import path, inlined glue, floor bump to `^1.12.0`
6. Golden fixtures `mercury` / `zendesk` / `bitrise`, snapshots, standalone acceptance

**Step 4 is the critical path for step 5**, exactly as Stage C §7 step 6 was for installability.
Until 1.12.0 is on the registry, standalone acceptance for search fixtures runs only in
local-checkout mode — which is what that mode is for, and it is the pre-release gate. Steps 1–3
and the three real fixtures in step 6 have no cross-repo dependency at all: the monorepo target
imports `../../shared/*` and needs no SDK release.

---

## 7. Out of scope

- **Bespoke field extractors** beyond flat keys and `tags` (D5, §5.2 limit 2).
- **Server-side pagination.** §1.8 — no helper exists, and the corpus does not paginate here.
- **Splitting emission into `src/tools.ts`**, the layout `elasticsearch` and `storybook` use. It is
  a real corpus shape and the direct reason §1.7 has no fixture, but it is a file-layout axis
  independent of this one.
- **Making `shared/mcp-search-tool.ts` dependency-free in the monorepo.** D4 routes around its zod
  import rather than changing it; that is Nimbus's call, not this repository's.
- **Changing what search *does*.** §5.2 limit 3.
