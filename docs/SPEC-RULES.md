# The spec language, rule by rule

How the spec's fields work together, and the rules that reject a spec.

This is the prose half of the reference. [`SPEC.md`](./SPEC.md) is the generated index of *what
fields exist* — each one's type, default and schema constraints — and it cannot carry what is on
this page, because a cross-field rule belongs to no single row. Read that one to look a field up;
read this one to find out why the generator refused your spec, or which of three shapes a feature
takes. [`USAGE.md`](./USAGE.md) walks through writing a spec from scratch, and the
[README](../README.md#cli-reference) documents the flags that feed one to the generator.

**Corpus measurements sit next to the field they justify.** Where a default, a rejection or an
emitted shape was chosen because of what the 94 Nimbus connectors actually do, the count is on the
same line as the choice. That is the reasoning behind the rule, not decoration — the rule is only
as good as the measurement under it.

## Scope

Every tool is a single HTTP request against a path built from a small template DSL (`${env.X}`, `${arg.X}`, `${arg.X|enc}`, `${arg.X|num}`, `${arg.X|bool}`). No pagination, no multi-step or multi-fetch tools.

A tool that can't be expressed under that constraint sets `"impl": "stub"` and gets a typed handler that throws `"<tool> not implemented"` rather than being silently dropped or guessed at.

**Fields the emitters cannot render are a hard validation error, never an automatic downgrade.** A spec that would silently generate something other than what it describes is rejected instead. `hitl` on a tool is the one field rejected outright; declare write-intent through `effect`.

**Spec surface is a cost, and it is deliberately controlled.** Byte-exactness pushes some purely cosmetic choices into the spec — real connectors hoist defaulted args to hand-picked short names (`const lim = p.limit ?? 10`, `const q = p.query ?? ""`), and there is no derivable rule for that. So the spec carries `local` — on an argument, on an env entry and on `fetchHelper` — and `bindings`, on an env entry. Three things about them the phrase "optional strings" would get wrong. They are **validated JS identifiers** (`identifierField` in `src/spec.ts`), checked against `RESERVED_IDENTIFIERS`, not free strings. `bindings` is an **array**, with exactly one entry per `vars` entry. And they are optional only where the emitter can work the name out on its own: an argument's `local` defaults to the argument's own key and `bindings` to the camelCase of each var, while an env entry's `local` and `fetchHelper.local` are **required**, because each names a function the emitter must declare and nothing else in the spec implies it. Beyond those, a new field that changes only appearance is refused, and the resulting difference is recorded as a documented irreducible diff instead. A generator whose input is harder to write than its output is a failed generator.

## Conditional query parameters: `query`

`path`'s template DSL renders one fixed string per tool, so it cannot express a parameter that
is only sent when an optional argument is present. A tool that needs that adds a `query` array
alongside `path` instead:

```jsonc
{
  "name": "acme_channel_messages",
  "description": "List messages in a channel.",
  "impl": "rest",
  "path": "/channels/${arg.channelId|enc}/messages",
  "args": {
    "channelId": { "type": "string", "min": 1 },
    "limit": {
      "type": "number", "int": true, "min": 1, "max": 100,
      "optional": true, "default": 50
    },
    "after": { "type": "string", "optional": true }
  },
  "query": [
    { "name": "limit", "arg": "limit" },
    { "name": "after", "arg": "after", "omitWhen": "empty" }
  ]
}
```

This emits `const u = new URL(...)`, a `u.searchParams.set(...)` line per entry — guarded where
`omitWhen` says to guard — and returns the absolute URL. `discord` and `google-meet` are the two
fixtures that exercise it.

Each entry has three fields:

- **`name`** — the query key as the API spells it. Deliberately not an identifier check —
  `page[size]` is a real corpus key.
- **`arg`** — the tool's declared argument supplying the value. Must name a key in that tool's
  `args`.
- **`omitWhen`** (optional) — guards the `set` call with one of two predicates: `"absent"`
  tests `!== undefined`; `"empty"` adds `&& !== ""` and is valid only on a `string` arg.
  Omitted means the parameter is always sent, unconditionally.

**The value's wrap is type-driven, not guard-driven.** A `number` or `boolean` arg is wrapped
in `String(...)` before it reaches `searchParams.set`; a `string` arg is passed bare. This holds
whether or not the entry is guarded — it mirrors the corpus, where `github` and `github-actions`
wrap their numeric `page` even though it's guarded, and every guarded *string* arg is written
bare. It is not a style choice with an exception; the type decides it every time.

**`searchParams` percent-encodes on its own, so a `query` entry takes no encoding mode.**
There is no `|enc` (or any other) option here — applying one would double-encode the value.
(`path`'s own `${arg.X|enc}` is unrelated and still applies inside `path`.)

**Defaults live on the argument, not the query entry.** `{ "type": "number", "optional": true,
"default": 50 }` is what makes an unconditional `limit` entry safe to emit with no guard at
all — the hoist resolves it to a concrete value before the query line ever runs.

**Rejected at parse time:**

- `query` on a `"stub"` tool — it issues no request, so there is nothing to attach it to.
- `query` on a `"search"` tool — it builds its query string from `filter`, not `query`.
- `query` together with a `path` that already contains `"?"` — both write the query string;
  a tool that needs `query` moves its whole query string there instead.
- `query` on a tool whose `path` does not begin with `"/"` — the `query` branch builds an
  absolute URL by joining the base to `path` directly, with no separator, so `path` must carry
  its own leading slash.
- an entry whose `arg` does not name a key the tool's `args` declares.
- two entries sharing the same `name` — the second would silently win at runtime.
- `omitWhen: "empty"` on a non-`string` arg — comparing a `number` or `boolean` to `""` does
  not typecheck in the generated package.
- `omitWhen` on an argument whose value can never be `undefined` at the point the guard would
  read it: not declared `"optional": true`, or declaring a `"default"`, or type `"boolean"`
  (every boolean argument is hoisted to a `"true"`/`"false"` const, never `undefined`). The
  guard would be dead code — it could never omit the parameter.
- **the mirror of that last rule:** an argument that genuinely *can* be `undefined`
  (`"optional": true`, no `"default"`, not `"boolean"`) but whose entry declares no
  `omitWhen`. Without a guard, `searchParams.set` receives a value that can be `undefined` —
  a compile error for a `string` arg, or a literal `"?name=undefined"` sent on the wire for a
  wrapped one, since `String(undefined) === "undefined"`.

## Writes: `method`, `effect` and `body`

```jsonc
{
  "name": "acme_item_create",
  "description": "Create an item.",
  "impl": "rest",
  "method": "POST",
  "effect": "write",
  "path": "/v1/items",
  "args": { "title": { "type": "string", "min": 1 } }
}
```

- **`method`** (`"GET" | "POST" | "PUT" | "PATCH" | "DELETE"`, default `"GET"`) is the HTTP verb, nothing more.
- **`effect`** (`"read" | "write" | "delete"`, default `"read"`) is the author's declaration of intent, and drives the manifest's `hitlRequired` array (the deduplicated set of non-`read` effects, emitted in the corpus's fixed capability order — `write` before `delete`, the order used by all 23 Nimbus manifests declaring both and by none in reverse). It is deliberately **not** derived from `method` — in the Nimbus corpus a POST is not necessarily a write: `dagster` POSTs GraphQL *queries* and `ramp` POSTs to *exchange an OAuth token*. A REST GET may not carry a write or delete effect (a hard validation error); a write or delete effect may pair with any non-GET method, including `DELETE` with `effect: "write"` — deleting a webhook subscription is not destructive to user data, and `effect` is the author's judgement rather than something read off the verb.
- **`body`** (`Record<string, string>`, arg name → API field name) is optional even on a write tool. **By default the body is every arg the URL does not already carry** — that is, every arg not referenced in the tool's `path` *and* not named by a `query` entry, since either one puts the value on the wire already and mirroring it into the body would send it twice. `PATCH /items/${arg.id}` with args `{id, title}` sends `{title}`; a `DELETE` whose only arg is its path id, or is its one `query` entry, sends no body at all. An explicit `body` mapping overrides the default entirely, and is respected verbatim even where it names a path or `query` arg — doing that is a deliberate author choice, so neither exclusion applies to it.
- **A request with no body still carries `Content-Type: application/json`.** The hand-rolled write helper (`renderWriteHelper` in `src/emit/server/fetch-helper.ts`, emitted as `<fetchHelper.local>Send`) sets that header on every call, and omits only the `body` itself — so the bodyless `DELETE` above is sent with the header and nothing to describe. rest-kit writes do not go through that helper at all: the registrar callback emits only `{ method }` or `{ method, body }`, and the rest-kit fetch helper sets `Authorization` plus the spec's `inlineHeaders` and no `Content-Type`.
- **`impl: "get"` is a deprecated alias for `"rest"`**, so specs written before `method` existed still parse; it is normalised at parse time.

**An unset optional boolean renders `false` in the URL but is omitted from a JSON body.** This looks like an inconsistency and is deliberate, so it is pinned by tests rather than left to be "fixed" later. It is reachable only when a spec gives an explicit `body` mapping re-including an arg the path already references. A query string carries text and the corpus decided what that text is — `newrelic` emits `p.only_open === true ? "true" : "false"`, and changing it drops a byte-exact fixture. A JSON body carries types, and every API distinguishes a `false` the caller asserted from a key the caller never sent; emitting `false` for an unset optional would fabricate an assertion the author never made, and would be wrong exactly where the server's own default is `true`.

**rest-kit gets writes almost free.** Its registrar (`makeRestToolRegistrar`) already accepts an optional `buildInit` returning `{ method, body }`. Hand-rolled has no such seam — a second helper (`<fetchHelper.local>Send`) is emitted alongside the read helper, and only when the spec contains a non-GET tool, so a read-only spec never reaches that code path. Prefer **rest-kit** for a new write connector; hand-rolled write support exists for connectors whose auth shape rest-kit does not fit.

## Styles: `rest-kit`, `hand-rolled`, `read-only-kit`

`style` decides how a connector registers its tools, and it has the widest blast radius of any field.

- **`rest-kit`** — `makeRestToolRegistrar` performs the request and wraps the result. **Cannot declare an OAuth `client-credentials` env entry, and cannot declare a search tool** — it does both halves itself, leaving no seam for a token exchange or a filter to run in. Both are hard validation errors.
- **`hand-rolled`** — the connector builds its own `McpServer`, registrar and fetch helper. The general case.
- **`read-only-kit`** — the shape **60 of the 94** Nimbus connectors use. Identical to `hand-rolled` except in the server file's first and last lines: instead of constructing an `McpServer`, building a registrar and connecting a transport, the registrations are wrapped in `runReadOnlyMcpConnector`. Every other rule is inherited unchanged.

Two things worth knowing about `read-only-kit`:

- **The name is a bootstrap convention, not a restriction.** It does not prevent a connector from declaring write tools, and nine corpus connectors use it while declaring `hitlRequired: ["write"]`. Generated READMEs say so explicitly, because the name invites the opposite assumption. What a connector may actually do is what its `nimbus.extension.json` declares.
- **Standalone packages inline the helper.** `runReadOnlyMcpConnector` imports `@modelcontextprotocol/sdk` directly and so cannot move into `@nimbus-dev/sdk`, whose zero runtime dependencies are load-bearing. The monorepo target imports it from `../../shared/`; the standalone target emits an equivalent local definition, and the call site is byte-identical either way.

## Search tools: `impl: "search"`, `rows`, `maxLimit` and `filter`

`impl: "search"` registers a substring-search tool over one endpoint's rows — the form **45 Nimbus connectors** already use.

```jsonc
{
  "name": "mercury_search",
  "description": "Substring search across the user's Mercury accounts.",
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

- **`rows`** (optional) names the property to pluck from the response envelope. Omitted means the response **is** the array. `matchesResult` guards with `Array.isArray` itself, so neither form needs a coercion.
- **`maxLimit`** (default `100`) is the per-connector result cap. Corpus values: 100 (×24), 200 (×12), 2000 (×2), 50 (×1).
- **`filter.export`** names the `export const` emitted into the seventh file, `src/search-filter.ts`. Two tools may not share one export name.
- **`filter.fields`** is a list of entries, each one of three kinds:
  - a **plain key string**, e.g. `"name"` → `stringField(row, "name")`
  - a **nested path**, `{ "path": ["a", "b"] }`, two or more non-empty segments → `nestedString(row, ["a", "b"])`
  - a **tag entry**, `{ "tags": "text" }` or `{ "tags": "objects" }` → `tagText(row)` (a `tags: string[]`) or `tagNamesFromObjects(row)` (a `tags: {name}[]`)
- **`filter.tags`** (default `false`) additionally matches tag names: `true` appends `tagText(row)` after the keyed fields, emitting `makeQueryFilter(fieldsFromKeys([...], { tags: true }))`. It is not superseded by the tag-entry form above — the two converge on identical bytes — and it is what `zendesk` and `raindrop` are written in, and what `zendesk` byte-matches on today.

  Rendering is derived from which kinds are present, never selected by a spec field: all-plain-string `fields` still emits `makeQueryFilter(fieldsFromKeys([...]))`, unchanged since Stage D. A **trailing** `{ "tags": "text" }` entry converges onto the same form as `filter.tags: true` — `makeQueryFilter(fieldsFromKeys([...], { tags: true }))` — whether or not any plain-string entries precede it: `fields: [{ "tags": "text" }]` alone is legal and emits `fieldsFromKeys([], { tags: true })`, "match on tags only". Convergence holds because `fieldsFromKeys` can only *append* `tagText(row)` after the keyed fields, so a tag entry anywhere else changes field order and cannot converge. Any `path` entry, a non-trailing tag entry, or `{ "tags": "objects" }` takes the bespoke-extractor branch instead: the emitter writes a `function fieldsOf(item: unknown): readonly string[] | null` guarded with `asObjectish`, and `export const <filter.export> = makeQueryFilter(fieldsOf);`.

  **Rejected at parse time**, each with a message naming the offending entry: a `path` with fewer than two segments (a one-segment path emits the same call as the plain-string spelling — write that instead); an empty path segment; `filter.tags: true` together with a `{ "tags": ... }` entry in `fields` (say one); **`filter.tags: true` on a filter whose `fields` force the extractor branch** — the extractor never reads `tags`, so it would be silently dropped and the tool would compile, pass every gate, and just never match on tags. Add `{ "tags": "text" }` as the *last* entry in `fields` instead. And **a connector may declare at most one search tool that takes the extractor branch** — the emitted extractor is always named `fieldsOf`, so a second one in the same `src/search-filter.ts` would be a duplicate declaration.
- **A search tool is always a read.** `method`, `body` and a non-`read` `effect` are all validation errors on it — unlike a stub, it does not stand in for something that will later write.
- **Argument-carrying search tools inline their schema.** With no args of its own a tool calls the shared `searchToolInputSchema(maxLimit)`; declaring args means the shared two-key helper cannot express the shape, so the merged `z.object({ …args, query, limit })` is emitted inline instead.

**`filter.fields` is optional, and omitting it is the honest escape hatch.** Path and tag entries reach nested, projected and tag-bearing shapes, but not every hand-written corpus extractor — one that joins across arrays, flattens a computed field, or coerces a non-string value still has no spec expression. Omit `fields` and the emitter writes a **throwing stub** typed as `SearchFilter` for you to replace. The stub replaces the *filter*, not the extractor, and that placement is load-bearing rather than stylistic: `makeQueryFilter` calls the extractor once per row, so a throwing *extractor* never fires on an empty result set and the tool would report `{ matches: [] }` as success. Throwing from the filter position fires on every invocation.

**Standalone search needs `@nimbus-dev/sdk` ≥ 1.15.0**, and only a spec declaring a search tool gets that floor; everything else stays at `^1.11.0`. One search symbol is deliberately *not* in the SDK: `searchToolInputSchema` builds a zod schema, and the SDK ships with no runtime dependencies, so standalone packages define it locally in the same way they inline the `runReadOnly` glue.

## OAuth: `client-credentials`

An env entry may declare `"auth": "client-credentials"` instead of `"bearer"`, `"basic"` or `"headers"`:

```jsonc
{
  "vars": ["ACME_CLIENT_ID", "ACME_CLIENT_SECRET"],
  "local": "authHeaders",
  "auth": "client-credentials",
  "tokenUrl": "https://api.acme.com/oauth/token",
  "scope": "items:readwrite",
  "credentialsIn": "basic"
}
```

This exchanges the two `vars` (client id, then secret) for a bearer token by POSTing form-encoded `grant_type=client_credentials` (plus `scope`, when given) to `tokenUrl`, then caches it: `expires_in` is read and the token renewed a little early, with the skew halved for short-lived tokens that would otherwise be treated as already expired and re-exchanged on every call. A response with no `expires_in` is cached for the process lifetime, since treating its absence as "expired" would re-exchange on every call.

There is **no refresh-token flow and no authorization-code flow** — no connector in the corpus has either, so adding them would be speculative.

`credentialsIn` controls how the id and secret reach the token endpoint: `"basic"` sends them as an `Authorization: Basic` header (as Nimbus's `ramp` does); `"body"` puts `client_id`/`client_secret` in the form body (as `looker`, `powerbi`, `teams` and `wiz` do). `scope` is optional; exactly two `vars`, `tokenUrl` and `credentialsIn` are required. The one style it cannot pair with is **`rest-kit`**, because that registrar resolves a single bearer credential itself and has no seam for a token exchange; `hand-rolled` and `read-only-kit` both accept it, and the latter emits the same module-scope exchange above a `runReadOnlyMcpConnector` call. A connector may declare **at most one** `client-credentials` entry — the exchange declares `token` and `cachedToken` at module scope, so a second would redeclare both.

## Reserved identifiers

The emitter declares module-scope names of its own, so a spec may not reuse them. `local` names, `registrar` names and similar spec-supplied identifiers are validated against `RESERVED_IDENTIFIERS` in `src/validate.ts`, which is the authoritative list. Reusing one is a validation error rather than a package that emits two declarations of the same name and fails its own `typecheck`.

The list covers the OAuth path (`token`, `cachedToken`, `encodeBasicAuthHeader`), the write path (`URLSearchParams`, `<local>Send`), the `read-only-kit` and search paths (`runReadOnlyMcpConnector`, `ZodToolRegistrar`, `searchToolInputSchema`, `matchesResult`, `McpListResult`, `ZodObjectSchema`, `SearchMatchOptions`, `root`), and the globals emitted code calls (`fetch`, `process`, `JSON`, …).

They are reserved **unconditionally**, not only for specs that use the feature — the list is checked before any style or tool kind is considered, and conditional entries would mean a spec validating or failing depending on a field elsewhere in the file. Two names are worth calling out:

- **`token`** — a spec that named an env `local` `"token"` and validated under 0.2.2 is now rejected. Rename the local; nothing else changes.
- **`root`** — an ordinary word, and a search tool with `rows` emits `const root = await <fetchHelper.local>(…)`. A fetch helper named `root` would emit `const root = await root(…)`, a use-before-declaration error rather than a shadow.

## Editor support: the published JSON Schema, and what it cannot check

The spec language is published as a JSON Schema at [`schema/connector-spec.schema.json`](../schema/connector-spec.schema.json), generated from `ConnectorSpecSchema` itself — `bun run schema` rewrites it, and `test/schema.test.ts` byte-compares the checked-in file against a fresh build, so the document cannot drift from the language it describes. It ships in the npm package too, at `node_modules/create-nimbus-connector/schema/connector-spec.schema.json`.

**Reference it with an editor-side mapping, not with a `$schema` key inside the spec file.** `ConnectorSpecSchema` is a `z.strictObject`, so a spec carrying `"$schema": …` is refused with `Unrecognized key: "$schema"` — that route would make the file validate in the editor and fail at the CLI, which is the opposite of the point. In VS Code, map the glob instead:

```json
// .vscode/settings.json
{
  "json.schemas": [
    {
      "fileMatch": ["*.spec.json"],
      "url": "https://raw.githubusercontent.com/nimbus-agent/create-nimbus-connector/main/schema/connector-spec.schema.json"
    }
  ]
}
```

**And read what it is worth before trusting it.** Refinements enforced by `parseSpec` and `validateSpec` (cross-field rules, reserved identifiers, style-specific requirements) cannot be expressed in JSON Schema and are **not** represented here. A spec that validates against this schema may still be rejected by the generator. An argument declaring `default` without `optional: true`, a `fetchHelper.base` of `https://api.acme.test/${(() => Date.now())()}` — an interpolation spliced raw into the generated source and evaluated on every request — and an env `local` named `token` are each green in an editor and refused by the CLI. Completion and structural checking are what the schema buys you; `bun src/cli.ts --spec <path> --dry-run` is what tells you the spec is actually accepted.
