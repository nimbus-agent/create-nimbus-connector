# create-nimbus-connector

A generator for [**Nimbus**](https://github.com/nimbus-agent/Nimbus) MCP connector packages.

Nimbus's `packages/mcp-connectors/` holds 94+ connectors built from one rigid shape — a `server.ts`, a `nimbus.extension.json` manifest, a `tsconfig.json`, a `package.json`, a boilerplate `README.md`, and a constant `test/sandbox.test.ts`. Adding the next one means hand-copying those six files and editing the parts that vary.

This tool turns that shape into a generator: describe a connector as a small JSON spec, and it emits all six files — plus a seventh, `src/search-filter.ts`, when the spec declares a search tool — run through the same Biome formatter the real connectors are formatted with.

The bar it is held to is **byte reproduction**: generate from a spec describing an existing connector, and diff the output against the real directory. `newrelic`, `datadog`, `grafana` and `sentry` come out byte-identical.

```bash
bunx create-nimbus-connector acme --standalone
```

## Documentation

**New here? Start with [`docs/USAGE.md`](./docs/USAGE.md)** — a start-to-finish walkthrough. This README is the *reference*: what the spec language can express, and the rules that reject a spec.

| | |
| --- | --- |
| [USAGE.md](./docs/USAGE.md) | Generate your first connector, and verify it |
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | How the generator is built, and how it is verified |
| [ROADMAP.md](./docs/ROADMAP.md) | Where it is going, and the known limitations |
| [CONTRIBUTING.md](./CONTRIBUTING.md) · [GOVERNANCE.md](./docs/GOVERNANCE.md) · [RELEASING.md](./docs/RELEASING.md) · [SECURITY.md](./SECURITY.md) | Working on it |
| [GLOSSARY.md](./docs/GLOSSARY.md) | Terms as this repo uses them |
| [CLAUDE.md](./CLAUDE.md) | Context for Claude Code |

Stuck on how to express a service as a spec, or wondering whether a change would be welcome before writing it? Ask in [Nimbus Discussions](https://github.com/nimbus-agent/Nimbus/discussions) — the one board for the whole organisation — and keep bugs in the generator itself as issues here.

### Which scaffolder do I want?

The org ships two, and they do different jobs:

- **`create-nimbus-connector` (this one)** — you describe a connector as a JSON spec and get a package byte-identical to the 94 hand-written Nimbus connectors. Reach for it when you are wrapping a REST API and want output that matches the corpus exactly.
- **[`@nimbus-dev/create-connector`](https://github.com/nimbus-agent/nimbus-sdk/tree/main/tools/create-connector)** — templates a greenfield TypeScript **or Python** project built on `NimbusExtensionServer`, which performs the contract-version handshake before serving MCP. Reach for it when you want a blank project to write by hand, or when you need Python.

[ROADMAP.md](./docs/ROADMAP.md#consolidation) states the intent to converge these into one tool and the three capabilities that must land first.

## The two targets

**Standalone** connectors are self-contained — installable and runnable anywhere, with no Nimbus checkout. `src/server.ts` imports its helpers from a single published entry point, `@nimbus-dev/sdk/connector-kit`, and the package gains `dev` and `build` scripts. This is what a third-party connector wants.

```bash
bunx create-nimbus-connector acme --standalone
```

**Monorepo-internal** connectors — the default — live at `packages/mcp-connectors/<name>/` inside a Nimbus checkout, where the `../../shared/*` relative imports resolve as-is.

```bash
bunx create-nimbus-connector acme
```

**This CLI, and every connector it generates, is Bun-only.** `nimbus.extension.json` declares `"runtime": "bun"`, `test/sandbox.test.ts` imports `bun:test`, the standalone `build` script targets Bun, and `src/cli.ts` carries a `#!/usr/bin/env bun` shebang — so Bun is required however the CLI is invoked, `bunx` included. There is no Node, npm or pnpm path in this project or its output. The one exception is publishing: `.github/workflows/release.yml` runs `npm publish --provenance` in CI, because that is the only way to attach a sigstore attestation to an npm tarball.

## Scope

Every tool is a single HTTP request against a path built from a small template DSL (`${env.X}`, `${arg.X}`, `${arg.X|enc}`, `${arg.X|num}`, `${arg.X|bool}`). No pagination, no multi-step or multi-fetch tools.

A tool that can't be expressed under that constraint sets `"impl": "stub"` and gets a typed handler that throws `"<tool> not implemented"` rather than being silently dropped or guessed at.

**Fields the emitters cannot render are a hard validation error, never an automatic downgrade.** A spec that would silently generate something other than what it describes is rejected instead. `hitl` on a tool is the one field rejected outright; declare write-intent through `effect`.

**Spec surface is a cost, and it is deliberately controlled.** Byte-exactness pushes some purely cosmetic choices into the spec — real connectors hoist defaulted args to hand-picked short names (`const lim = p.limit ?? 10`, `const q = p.query ?? ""`), and there is no derivable rule for that. So `local` and `bindings` are permitted everywhere as optional strings with sensible defaults. Beyond those, a new field that changes only appearance is refused, and the resulting difference is recorded as a documented irreducible diff instead. A generator whose input is harder to write than its output is a failed generator.

### Writes: `method`, `effect` and `body`

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
- **`body`** (`Record<string, string>`, arg name → API field name) is optional even on a write tool. **By default the body is every arg *not* referenced in the tool's path** — `PATCH /items/${arg.id}` with args `{id, title}` sends `{title}`, and a `DELETE` whose only arg appears in the path sends no body (and no `Content-Type` header) at all. An explicit `body` mapping overrides the default entirely.
- **`impl: "get"` is a deprecated alias for `"rest"`**, so specs written before `method` existed still parse; it is normalised at parse time.

**An unset optional boolean renders `false` in the URL but is omitted from a JSON body.** This looks like an inconsistency and is deliberate, so it is pinned by tests rather than left to be "fixed" later. It is reachable only when a spec gives an explicit `body` mapping re-including an arg the path already references. A query string carries text and the corpus decided what that text is — `newrelic` emits `p.only_open === true ? "true" : "false"`, and changing it drops a byte-exact fixture. A JSON body carries types, and every API distinguishes a `false` the caller asserted from a key the caller never sent; emitting `false` for an unset optional would fabricate an assertion the author never made, and would be wrong exactly where the server's own default is `true`.

**rest-kit gets writes almost free.** Its registrar (`makeRestToolRegistrar`) already accepts an optional `buildInit` returning `{ method, body }`. Hand-rolled has no such seam — a second helper (`<fetchHelper.local>Send`) is emitted alongside the read helper, and only when the spec contains a non-GET tool, so a read-only spec never reaches that code path. Prefer **rest-kit** for a new write connector; hand-rolled write support exists for connectors whose auth shape rest-kit does not fit.

### Styles: `rest-kit`, `hand-rolled`, `read-only-kit`

`style` decides how a connector registers its tools, and it has the widest blast radius of any field.

- **`rest-kit`** — `makeRestToolRegistrar` performs the request and wraps the result. **Cannot declare an OAuth `client-credentials` env entry, and cannot declare a search tool** — it does both halves itself, leaving no seam for a token exchange or a filter to run in. Both are hard validation errors.
- **`hand-rolled`** — the connector builds its own `McpServer`, registrar and fetch helper. The general case.
- **`read-only-kit`** — the shape **60 of the 94** Nimbus connectors use. Identical to `hand-rolled` except in the server file's first and last lines: instead of constructing an `McpServer`, building a registrar and connecting a transport, the registrations are wrapped in `runReadOnlyMcpConnector`. Every other rule is inherited unchanged.

Two things worth knowing about `read-only-kit`:

- **The name is a bootstrap convention, not a restriction.** It does not prevent a connector from declaring write tools, and nine corpus connectors use it while declaring `hitlRequired: ["write"]`. Generated READMEs say so explicitly, because the name invites the opposite assumption. What a connector may actually do is what its `nimbus.extension.json` declares.
- **Standalone packages inline the helper.** `runReadOnlyMcpConnector` imports `@modelcontextprotocol/sdk` directly and so cannot move into `@nimbus-dev/sdk`, whose zero runtime dependencies are load-bearing. The monorepo target imports it from `../../shared/`; the standalone target emits an equivalent local definition, and the call site is byte-identical either way.

### Search tools: `impl: "search"`, `rows`, `maxLimit` and `filter`

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

### OAuth: `client-credentials`

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

`credentialsIn` controls how the id and secret reach the token endpoint: `"basic"` sends them as an `Authorization: Basic` header (as Nimbus's `ramp` does); `"body"` puts `client_id`/`client_secret` in the form body (as `looker`, `powerbi`, `teams` and `wiz` do). `scope` is optional. The two `vars` and `style: "hand-rolled"` are required — **`client-credentials` is hand-rolled only**, because the rest-kit registrar resolves a single bearer credential itself and has no seam for a token exchange.

### Reserved identifiers

The emitter declares module-scope names of its own, so a spec may not reuse them. `local` names, `registrar` names and similar spec-supplied identifiers are validated against `RESERVED_IDENTIFIERS` in `src/validate.ts`, which is the authoritative list. Reusing one is a validation error rather than a package that emits two declarations of the same name and fails its own `typecheck`.

The list covers the OAuth path (`token`, `cachedToken`, `encodeBasicAuthHeader`), the write path (`URLSearchParams`, `<local>Send`), the `read-only-kit` and search paths (`runReadOnlyMcpConnector`, `ZodToolRegistrar`, `searchToolInputSchema`, `matchesResult`, `McpListResult`, `ZodObjectSchema`, `SearchMatchOptions`, `root`), and the globals emitted code calls (`fetch`, `process`, `JSON`, …).

They are reserved **unconditionally**, not only for specs that use the feature — the list is checked before any style or tool kind is considered, and conditional entries would mean a spec validating or failing depending on a field elsewhere in the file. Two names are worth calling out:

- **`token`** — a spec that named an env `local` `"token"` and validated under 0.2.2 is now rejected. Rename the local; nothing else changes.
- **`root`** — an ordinary word, and a search tool with `rows` emits `const root = await <fetchHelper.local>(…)`. A fetch helper named `root` would emit `const root = await root(…)`, a use-before-declaration error rather than a shadow.

## CLI reference

```
bunx create-nimbus-connector <name>   # the published CLI, no checkout needed
bun src/cli.ts <name>                 # from a checkout of this repo
```

With a positional name it runs an interactive prompt session (name, display name, service label, description, base API URL, auth type, credential env var, tools) and writes to `packages/mcp-connectors/<name>/` relative to the current directory, or to `<name>/` when `--standalone` is passed.

### Flags

- `--spec <path>` — skip the prompts and load a `ConnectorSpec` JSON file instead (see `fixtures/*.spec.json`, e.g. `fixtures/sentry.spec.json`). Mutually exclusive with a positional `<name>` — the name comes from the spec file.
- `--standalone` — generate a self-contained connector instead of the monorepo-internal shape. Defaults the output directory to `<name>/`.
- `--dry-run` — write nothing; print the file tree that would be created, with a byte size per file.
- `--out-dir <path>` — write to a directory other than the default.
- `--license <spdx>` — **standalone only.** Set the generated package's license. Defaults to `UNLICENSED`. Passing it without `--standalone` is an **error**, not a silent no-op: a monorepo-target connector is `AGPL-3.0-only` unconditionally.
- `--gateway-wiring <nimbus-root>` — **opt-in, monorepo target only.** Also emit the Gateway wiring skeleton. Passing it with `--standalone` is an **error**: a standalone connector is not registered with any Gateway.
- `--force` — allow `--gateway-wiring` to overwrite an existing `<name>-sync.ts` or `<name>-mapping.ts`. An **error** without `--gateway-wiring`.
- `--help` — print usage. Every flag in that text is one `parseFlags` actually parses; `test/cli.test.ts` asserts the two agree, so an undocumented flag is a failing test.
- `--version` — print the version.

An unrecognised flag is an error with a did-you-mean suggestion, never silently ignored.

> **Connector output overwrites without asking.** Generation creates parent directories and writes each file; there is no existence check and no prompt, so generating into a directory that already holds a connector replaces those files in place. Use `--dry-run` first. The two `--gateway-wiring` files are the only exception, and they refuse to overwrite without `--force`.

```bash
bun src/cli.ts --spec fixtures/sentry.spec.json --dry-run
bun src/cli.ts --spec fixtures/sentry.spec.json --out-dir /tmp/sentry-preview
bun src/cli.ts acme --standalone --license MIT
```

### Licensing of generated connectors

A **monorepo** connector is `AGPL-3.0-only`. It lives inside the AGPL Nimbus repo and imports AGPL code through `../../shared/*`, and its `package.json` is byte-diffed against real connectors — so this is fixed, not a default.

A **standalone** connector is none of those things: it is your own code, produced by an MIT-licensed tool, depending only on the MIT `@nimbus-dev/sdk`. Nothing about it obliges copyleft, so it is **not** stamped AGPL. It defaults to `UNLICENSED` — npm's marker for "no license granted" — a deliberate non-choice rather than a wrong choice made on your behalf. Pass `--license <spdx>` to set a real one:

```bash
bun src/cli.ts acme --standalone --license "Apache-2.0"
bun src/cli.ts acme --standalone --license "MIT OR Apache-2.0"
```

The value is validated as an SPDX identifier or expression before anything is written, so a malformed one fails at parse time rather than landing in a `package.json` npm will later reject. It is a syntax check, not a lookup against the SPDX list — `LicenseRef-<name>` is accepted deliberately.

## Gateway wiring

A first-party connector also needs type-coupled registration in the Gateway, which no connector package contains. This is opt-in, monorepo-target only, and off by default — normal generation never touches Nimbus's Gateway.

```bash
bun src/cli.ts --spec fixtures/acme.spec.json --gateway-wiring /path/to/Nimbus
```

Two files are written into `<nimbus-root>/packages/gateway/src/connectors/`:

- **`<name>-sync.ts`** — a `create<Name>Syncable(): Syncable` matching the Gateway's own interface (`serviceId`, `defaultIntervalMs`, `sync()`). Its `sync()` body **throws**.
- **`<name>-mapping.ts`** — a `map<Name>ItemToItem` stub with the expected signature, whose body also **throws**.

**Both are skeletons, not implementations, deliberately.** The Gateway's ~98 real `*-sync.ts` files are not one formulaic shape: the "drain a list tool and upsert" assembly this project could plausibly generate appears in exactly **2** of them; the rest are hand-authored with direct `fetch` calls, cursor pagination and connector-specific options. Generating a working `sync()` would mean reproducing AGPL source nearly verbatim in an MIT repository, and asserting a shape that fits 2 of 98 connectors. So the tool emits what the type system dictates — the shape, not anyone's implementation choices — plus a TODO, and leaves the real work to a human. `<name>-mapping.ts`'s body is unknowable from a spec for a related reason: no spec field describes a service's API response shape.

**Writing refuses to overwrite an existing target file** unless `--force` is passed. Nimbus already ships hand-authored files such as `newrelic-sync.ts`; an unguarded write on a connector reusing one of those names would destroy it.

**Two files are never written, only printed**: `platform/assemble-sync-registrations.ts` and `connectors/connector-catalog.ts`. The CLI prints the exact lines to paste into each rather than editing them — patching a large file it does not own, in another repository under another licence, risks silent corruption; a two-line paste the author controls is the safer trade.

## Development

```bash
bun test                              # emitters, independent of any checkout
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
```

`generate(spec)` is pure — no filesystem, env or clock — and `formatAll(files)` is the only stage that touches Biome. The split is deliberate: it makes the emitters unit-testable without a monorepo, and it means the CLI, `--dry-run` and the golden harness all format through the identical code path.

Several gates need a checkout of the Nimbus monorepo or the SDK and therefore cannot run in CI. [CONTRIBUTING.md](./CONTRIBUTING.md) lists what to run before opening a PR, and [ARCHITECTURE.md](./docs/ARCHITECTURE.md#the-verification-layers) explains what each harness proves and — just as importantly — what it does not.

## License

[MIT](./LICENSE).
