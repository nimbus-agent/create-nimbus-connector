---
name: cnc-spec-authoring
description: >
  The create-nimbus-connector spec language in one place — styles, tool kinds,
  env auth modes, the path-template DSL, conditional query parameters, search
  filters and their three field-entry kinds, manifest fields, reserved
  identifiers, and the rules that reject a spec. Use when writing or debugging a
  `*.spec.json`, adding a fixture, adding a spec field, or when a spec fails
  validation.
---

# The connector spec language

`src/spec.ts` is the source of truth — a zod schema plus refinements. This is the map; read
the schema for exact messages. Fields the emitters cannot render are a **hard validation
error, never a silent downgrade**.

## Top level

| Field | Notes |
| --- | --- |
| `name` | lower-kebab-case. Required |
| `displayName`, `description`, `serviceLabel` | Required. `serviceLabel` appears in error messages |
| `title` | PascalCase; derived from `name` when omitted |
| `id` | Manifest id; derived when omitted |
| `style` | `rest-kit` (default) \| `hand-rolled` \| `read-only-kit` |
| `network` | Hosts for `permissions.network` |
| `filesystem` | `{ read, write }`; omitted leaves the key out entirely |
| `syncInterval` | Seconds, default 300 |
| `minNimbusVersion` | Default `0.2.0` |
| `env`, `fetchHelper`, `tools` | Below |
| `handlerStyle` | `concise` (expression-bodied) \| `block`. Per-connector convention, never mixed |
| `argsSchemaStyle` | `inline` \| `expanded`. How `z.object({...})` is printed |

The last two exist because Biome preserves author line breaks in those positions, so the form
is part of the bytes being matched.

## `style` — the widest blast radius

- **`rest-kit`** — `makeRestToolRegistrar` fetches and wraps the result. **Cannot do OAuth
  `client-credentials`, cannot do `impl: "search"`** — it performs the request and wraps the
  result itself, leaving no seam for a token exchange or a filter. Both are hard errors.
- **`hand-rolled`** — builds its own `McpServer`, registrar and fetch helper. The general case.
- **`read-only-kit`** — as `hand-rolled`, but registrations are wrapped in
  `runReadOnlyMcpConnector`. Inherits every `hand-rolled` schema rule. **The name does not
  restrict writes** — nine corpus connectors use it while declaring `hitlRequired: ["write"]`.

## Tools

```jsonc
{
  "name": "acme_widget_get",
  "description": "Fetch one widget.",
  "impl": "rest",            // rest (default) | search | stub;  "get" is a deprecated alias for rest
  "method": "GET",           // GET (default) | POST | PUT | PATCH | DELETE
  "effect": "read",          // read (default) | write | delete
  "path": "/v1/widgets/${arg.id|enc}",
  "args": {
    "id": { "type": "string", "min": 1 },
    "after": { "type": "string", "optional": true }
  },
  "query": [{ "name": "after", "arg": "after", "omitWhen": "empty" }],
  "body": { "title": "displayTitle" }   // arg name -> API field name
}
```

- **`effect` is not derived from `method`**, deliberately: in the corpus a POST is often a
  query. It drives the manifest's `hitlRequired` (deduplicated non-`read` effects, `write`
  before `delete`). A GET with a non-`read` effect is a hard error.
- **`body` defaults to every arg not referenced in the path.** An explicit mapping overrides
  entirely. A DELETE whose only arg is in the path sends no body and no `Content-Type`.
- **`impl: "stub"`** emits a typed handler that throws. The honest escape hatch — a tool the
  spec language cannot express is stubbed, never dropped or guessed.

### Conditional query parameters — `query`

`path` renders one fixed string, so it cannot express a parameter sent only when an optional
argument is present. A `query` array alongside `path` does, emitting `const u = new URL(...)`,
one `u.searchParams.set(...)` per entry, and the absolute URL.

```jsonc
"query": [
  { "name": "limit", "arg": "limit" },
  { "name": "after", "arg": "after", "omitWhen": "empty" }
]
```

- **`name`** — the API's spelling of the key. Deliberately not identifier-checked; `page[size]`
  is a real corpus key.
- **`arg`** — a key the tool's own `args` declares.
- **`omitWhen`** — `"absent"` guards on `!== undefined`; `"empty"` adds `&& !== ""` and is
  `string`-only. Omitted means always sent.

**The value's wrap is type-driven, not guard-driven.** A `number` or `boolean` arg goes through
`String(...)`; a `string` arg is passed bare — whether or not the entry is guarded.

**`searchParams` percent-encodes, so there is no `|enc` here** — one would double-encode.
`path`'s own `${arg.X|enc}` is unrelated and still applies inside `path`.

Rejected at parse time: `query` on a `"stub"` or `"search"` tool; a `path` containing `"?"`;
a `path` not starting with `"/"` (the branch joins base and path with no separator); an `arg`
the tool does not declare; two entries sharing a `name`; `omitWhen: "empty"` on a non-`string`
arg; and **either half of an `omitWhen`/undefinedness mismatch** — a guard on an argument that
can never be `undefined` (not `optional`, or carrying a `default`, or `boolean`) is dead code,
and an argument that *can* be `undefined` with no guard sends `"?name=undefined"`.

`discord` and `google-meet` are the fixtures that exercise it.

### Search tools

```jsonc
{
  "impl": "search",
  "path": "/v1/widgets",
  "rows": "widgets",          // pluck from the envelope; omitted means the response IS the array
  "maxLimit": 100,            // corpus: 100 x24, 200 x12, 2000 x2, 50 x1
  "filter": { "export": "filterAcmeWidgets", "fields": ["id", "name"], "tags": false }
}
```

- Emits a **seventh file**, `src/search-filter.ts`, one `export const` per search tool.
- A search tool is always a read: `method`, `body` and a non-`read` `effect` are all errors.
- Two tools may not share a `filter.export`.
- No args → the shared `searchToolInputSchema(maxLimit)`. With args → an inline merged
  `z.object({ ...args, query, limit })`, because the shared helper is a fixed two-key object.

#### `filter.fields` — three entry kinds

Each entry is one of:

| Entry | Emits |
| --- | --- |
| `"id"` — a plain key | `stringField(row, "id")` |
| `{ "path": ["a", "b"] }` — two or more non-empty segments | `nestedString(row, ["a", "b"])` |
| `{ "tags": "text" }` / `{ "tags": "objects" }` | `tagText(row)` / `tagNamesFromObjects(row)` |

**Which branch is emitted is derived from the entries, never selected by a spec field.** All
plain strings — or plain strings plus a **trailing** `{ "tags": "text" }` — emit
`makeQueryFilter(fieldsFromKeys([...]))`, unchanged since Stage D, which is how the existing
byte-matches survive. A trailing `{ "tags": "text" }` converges byte-for-byte on legacy
`filter.tags: true`, because `fieldsFromKeys` can only *append* `tagText(row)`. Any `path`
entry, `{ "tags": "objects" }`, or a tag entry in any other position takes the bespoke branch:
a `function fieldsOf(item: unknown)` guarded with `asObjectish`, plus
`export const <filter.export> = makeQueryFilter(fieldsOf);`.

Rejected at parse time: a `path` with fewer than two segments (a one-segment path emits the same
call as the plain-string spelling — write that); an empty segment; `filter.tags: true` together
with a `{ "tags": ... }` entry; **`filter.tags: true` on a filter whose fields force the
extractor branch** — the extractor never reads `tags`, so it compiled and silently never matched;
and **at most one extractor-branch filter per connector**, since the emitted extractor is always
named `fieldsOf`.

**`filter.fields` omitted emits a throwing stub**, and that is the honest escape hatch. Of the
40 corpus filter files that hand-write an extractor, **26 can be expressed** with these entry
kinds and **14 cannot** — a join over a non-`tags` array, a numeric coercion, an alternate tag
shape, a conditional array search, a per-item concatenation. **Defining a local helper does not
on its own put a file out of reach**: a helper that walks a nested path is exactly a `path`
entry, which is why an earlier count said 9. See `docs/ROADMAP.md`'s *Measuring reach*.

The stub replaces the *filter*, not the extractor, and that placement is load-bearing: a
throwing extractor never fires on an empty result set, so the tool would report
`{ matches: [] }` as success.

## Env

```jsonc
{ "vars": ["ACME_TOKEN"], "local": "authHeader", "bindings": ["t"], "auth": "bearer" }
```

`auth`: `bearer` | `basic` | `headers` | `client-credentials`, or omitted for a raw value
accessor.

> The interactive prompt offers "bearer | token | basic", which is a UI vocabulary, not the
> schema's. Its "token" produces `auth: "headers"` with a custom header name. In a spec file
> only the four values above are valid.

- `basic` requires exactly two `vars` (username, password); may declare `prefix`/`suffix`,
  which decorate the **username**.
- `headers` requires `headerNames` with one entry per var.
- `client-credentials` requires two `vars`, `tokenUrl`, `credentialsIn` (`basic` | `body`),
  optional `scope` — and any style **except `rest-kit`**; `hand-rolled` and `read-only-kit` both
  accept it. **At most one such entry per connector** — the emitted exchange declares `token`
  and `cachedToken` at module scope, so a second would redeclare both. Caches the token,
  renewing early; the skew halves for short-lived tokens. No refresh-token flow exists in the
  corpus.
- `tokenLocal` is bearer-only: it names a raw-token accessor beside the header accessor, and
  must differ from `local`.
- `default` and `required` are mutually exclusive — a defaulted value is never empty.
- `transform` cannot combine with `auth` (the auth wrapper replaces the return value).

## `fetchHelper`

```jsonc
{
  "local": "acmeGet",
  "base": "https://api.acme.com",     // may template ${env.X}
  "baseConst": "BASE",                 // hoist to a module-scope const
  "headers": "authHeader",             // XOR inlineHeaders
  "inlineHeaders": { "Accept": "application/json" },
  "normalizeLeadingSlash": false,
  "jsonFallbackRaw": false,
  "staticPathStyle": "template"
}
```

`headers` and `inlineHeaders` are mutually exclusive, and a `hand-rolled` / `read-only-kit`
spec must declare exactly one.

## Path templates

`${env.X}` · `${arg.X}` · `${arg.X|enc}` (percent-encode) · `${arg.X|num}` · `${arg.X|bool}`

One request per tool. No pagination, no multi-fetch. **Use `|enc` for anything user-supplied
that lands in a path segment.**

## Reserved identifiers

`src/validate.ts`'s `RESERVED_IDENTIFIERS` is authoritative — read it rather than trusting this
summary. A spec-supplied `local`, `tokenLocal`, `baseConst`, `registrar`, `filter.export` or arg
`local` may not collide with it or with each other. It is a **flat set checked before any style
or tool kind is considered**, so nothing on it is conditional on the rest of the spec.

Grouped by the wave that added it:

- Stage C's OAuth branch — `token`, `cachedToken`, `tokenExpiresAt`, `encodeBasicAuthHeader`.
- Stage D — `trimTrailingSlash`, `URLSearchParams`, `runReadOnlyMcpConnector`,
  `ZodToolRegistrar`, `searchToolInputSchema`, `matchesResult`, `McpListResult`,
  `ZodObjectSchema`, `SearchMatchOptions`, `root`.
- Stage E's extractor branch — `fieldsOf`, `asObjectish`, `stringField`, `nestedString`,
  `tagText`, `tagNamesFromObjects`, `makeQueryFilter`, `fieldsFromKeys`.
- Stage E's `query` branch — `u` and `url`, plus `URL`, which sits with the globals below
  because the branch calls the global constructor directly.
- Plus the emitter's own scaffolding (`mcp`, `reg`, `transport`, `path`, `parsed`, …) and the
  globals the emitted code calls (`fetch`, `process`, `JSON`, `String`, `URL`, …).

**The ordinary-looking words are the ones that surprise people.** `root` — a search tool with
`rows` emits `const root = await <fetchHelper.local>(…)`. `stringField` and `nestedString` — an
env accessor may well want either name. `u` and `url` — a `fetchHelper.local` of `"u"` or a
`baseConst` of `"url"` validated fine before 0.6.0. Each is a rename of the spec's own field and
nothing else changes.

**When you add an emitter path that declares a new module-scope name, add it to that list in
the same change.** Two waves have been missed already, and both were found late.

## Worked examples

`fixtures/*.spec.json` are all valid and all tested:

| Fixture | Shows |
| --- | --- |
| `newrelic`, `sentry` | Minimal read connectors (6/6 byte-exact) |
| `mercury`, `zendesk` | `read-only-kit` + search; `zendesk` uses `tags: true` |
| `bitrise` | A search tool with its own args, so an inlined schema |
| `discord`, `google-meet` | `query` entries, guarded and unguarded |
| `netlify` | A `path` entry — a nested read a local helper would otherwise hand-write |
| `zzwrite`, `zzwriterest` | Write tools, both styles |
| `zzwriteonly` | A connector whose only tool mutates — no read helper emitted |
| `zzsearchstub` | Mixed filters: one with `fields`, one stubbed |
