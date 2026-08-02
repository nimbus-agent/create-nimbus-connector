# create-nimbus-connector

A generator for [**Nimbus**](https://github.com/nimbus-agent/Nimbus) MCP connector packages. Nimbus's `packages/mcp-connectors/` holds 94+ connectors built from one rigid shape — a `server.ts`, a `nimbus.extension.json` manifest, a `tsconfig.json`, a `package.json`, a boilerplate `README.md`, and a constant `test/sandbox.test.ts`. Adding the next one means hand-copying those six files and editing the parts that vary. This tool turns that shape into a generator: describe a connector as a small JSON spec, and it emits all six files — plus a seventh, `src/search-filter.ts`, when the spec declares a search tool — run through the same Biome formatter the real connectors are formatted with.

Full design rationale, the two emission styles, and the acceptance criteria this project is held to live in [`docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md`](./docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md) (Stage A — monorepo-internal generation), [`docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-b-design.md`](./docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-b-design.md) (Stage B — standalone generation and publishing), [`docs/superpowers/specs/2026-07-31-create-nimbus-connector-stage-c-design.md`](./docs/superpowers/specs/2026-07-31-create-nimbus-connector-stage-c-design.md) (Stage C — writes, HITL, OAuth, Gateway wiring), and [`docs/superpowers/specs/2026-08-01-create-nimbus-connector-stage-d-design.md`](./docs/superpowers/specs/2026-08-01-create-nimbus-connector-stage-d-design.md) (Stage D — the `read-only-kit` style and search tools).

## Scope

Every tool is a single HTTP request against a path built from a small template DSL (`${env.X}`, `${arg.X}`, `${arg.X|enc}`, `${arg.X|num}`, `${arg.X|bool}`). No pagination, no multi-step or multi-fetch tools. A tool spec that can't be expressed under that constraint sets `"impl": "stub"` and gets a typed handler that throws `"<tool> not implemented"` rather than being silently dropped or guessed at. Fields the emitters cannot render are a **hard validation error**, not an automatic downgrade to a stub — see the design doc's "Validation" section. `hitl` on a tool is the one field still rejected outright; declare a tool's write-intent through `effect` instead (below).

Originally (Stage A) that one request was always a GET with no body. **Stage C lifted that**: `method` and `body` are now supported, and only GET-with-no-body remains the default. `POST`, `PUT`, `PATCH` and `DELETE` are all supported, each with an optional JSON body.

### Writes: `method`, `effect` and `body`

```jsonc
{
  "name": "zzwrite_item_create",
  "description": "Create an item.",
  "impl": "rest",
  "method": "POST",
  "effect": "write",
  "path": "/v1/items",
  "args": { "title": { "type": "string", "min": 1 } }
}
```

- **`method`** (`"GET" | "POST" | "PUT" | "PATCH" | "DELETE"`, default `"GET"`) is the HTTP verb, nothing more.
- **`effect`** (`"read" | "write" | "delete"`, default `"read"`) is the author's declaration of intent, and drives the manifest's `hitlRequired` array (the deduplicated set of non-`read` effects across a spec's tools, emitted in the corpus's fixed capability order — `write` before `delete`, which is the order used by all 23 Nimbus manifests declaring both, and by none in reverse). It is deliberately **not** derived from `method` — in the Nimbus corpus a POST is not necessarily a write: `dagster` POSTs GraphQL *queries* and `ramp` POSTs to *exchange an OAuth token*. A REST GET may not carry a write or delete effect (that combination is a hard validation error); a write or delete effect may pair with any non-GET method, including `DELETE` with `effect: "write"` — deleting a webhook subscription, for instance, is not destructive to user data, and `effect` is the author's judgement rather than something read off the verb.
- **`body`** (`Record<string, string>`, arg name → API field name) is optional even on a write tool. **By default the body is every arg *not* referenced in the tool's path** — `PATCH /items/${arg.id}` with args `{id, title}` sends `{title}`, and a `DELETE` whose only arg appears in the path sends no body (and no `Content-Type` header) at all. An explicit `body` mapping overrides the default entirely and wins even for a path arg named there deliberately.
- **`impl: "get"` is a deprecated alias for `"rest"`.** `create-nimbus-connector@0.2.2` is published without `method`, so specs already written against it (which all say `"impl": "get"`, implying a GET) still parse unchanged — `"get"` is normalised to `"rest"` at parse time.

**rest-kit gets writes almost free.** The rest-kit registrar (`makeRestToolRegistrar`, from the published SDK) already accepts an optional `buildInit` returning `{ method, body }`, so a write tool is a few extra lines in a factory that already existed. Hand-rolled has no such seam — a second helper (`<fetchHelper.local>Send`, taking `method` and a serialized body) is emitted alongside the read helper, conditionally: only when the spec contains a non-GET tool, so a read-only spec never touches that code path. Prefer **rest-kit** for a new write connector; hand-rolled write support exists for connectors that already use hand-rolled headers/auth shapes rest-kit does not fit.

### The `read-only-kit` style

`style` takes a third value, `"read-only-kit"`, alongside `"rest-kit"` and `"hand-rolled"`. It is the shape **60 of the 94** Nimbus connectors use, and it differs from `hand-rolled` in the server file's first and last lines only: instead of constructing an `McpServer`, building a registrar and connecting a transport, the registrations are wrapped in a call to the shared `runReadOnlyMcpConnector` helper. Every other rule — env accessors, the fetch helper, `headers`/`inlineHeaders`, tool rendering — is inherited from `hand-rolled` unchanged.

```jsonc
{ "style": "read-only-kit" }
```

Two things worth knowing:

- **The name is a bootstrap convention, not a restriction.** `runReadOnlyMcpConnector` does not prevent a connector from declaring write tools, and nine connectors in the Nimbus corpus use it while declaring `hitlRequired: ["write"]`. Generated READMEs say so explicitly, because the name invites the opposite assumption. What a connector may actually do is what its `nimbus.extension.json` declares.
- **Standalone packages inline the helper.** `runReadOnlyMcpConnector` imports `@modelcontextprotocol/sdk` directly and so cannot move into `@nimbus-dev/sdk`, whose zero runtime dependencies are load-bearing. The monorepo target imports it from `../../shared/`; the standalone target emits an equivalent local definition, and the call site is byte-identical either way.

### Search tools: `impl: "search"`, `rows`, `maxLimit` and `filter`

A fourth tool kind. `impl: "search"` registers a substring-search tool over one endpoint's rows, the form **45 Nimbus connectors** already use.

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
- **`filter.export`** names the `export const` emitted into a **seventh file**, `src/search-filter.ts`, which a search spec adds to the six-file tree. Two tools may not share one export name.
- **`filter.fields`** lists the top-level keys to match against, and `filter.tags: true` additionally matches tag names. Together these emit `makeQueryFilter(fieldsFromKeys([...]))`.
- **A search tool is always a read.** `method`, `body` and a non-`read` `effect` are all validation errors on it — unlike a stub, it does not stand in for something that will later write.
- **Argument-carrying search tools inline their schema.** With no args of its own a tool calls the shared `searchToolInputSchema(maxLimit)`; declaring args (`bitrise`'s `appSlug`, say) means the shared two-key helper cannot express the shape, so the merged `z.object({ …args, query, limit })` is emitted inline instead.

**`filter.fields` is optional, and omitting it is the honest escape hatch.** 40 of the 49 filter files in the corpus hand-write an extractor this generator cannot express — nested paths, computed fields, conditional joins. For those, omit `fields` and the emitter writes a **throwing stub** typed as `SearchFilter` for you to replace. The stub replaces the *filter*, not the extractor, and that placement is load-bearing rather than stylistic: `makeQueryFilter` calls the extractor once per row, so a throwing *extractor* never fires on an empty result set and the tool would report `{ matches: [] }` as success. Throwing from the filter position fires on every invocation.

**`style: "rest-kit"` cannot declare a search tool** — a hard validation error. `makeRestToolRegistrar` performs the request *and* wraps the result itself, leaving no seam between the response and the MCP result for a filter to run in. The corpus agrees: the intersection of the 10 rest-tool-kit users and the 45 `mcp-search-tool` users is empty. Use `read-only-kit` or `hand-rolled`.

**Standalone search needs SDK ≥ 1.15.0**, and only a spec that declares a search tool gets that floor; everything else stays at `^1.11.0`. One search symbol is *not* in the SDK: `searchToolInputSchema` builds a zod schema, and `@nimbus-dev/sdk` ships with no runtime dependencies, so standalone packages define it locally in the same way they inline the `runReadOnly` glue.

### OAuth: `client-credentials`

An env entry may declare `"auth": "client-credentials"` instead of `"bearer"` or `"headers"`:

```jsonc
{
  "vars": ["ZZWRITE_CLIENT_ID", "ZZWRITE_CLIENT_SECRET"],
  "local": "authHeaders",
  "auth": "client-credentials",
  "tokenUrl": "https://api.zzwrite.test/oauth/token",
  "scope": "items:readwrite",
  "credentialsIn": "basic"
}
```

This exchanges the two `vars` (client id, then secret) for a bearer token by POSTing form-encoded `grant_type=client_credentials` (plus `scope`, when given) to `tokenUrl`, then caches the token until it expires: `expires_in` is read and the token is renewed a little early (the skew is halved for short-lived tokens, which would otherwise be treated as already expired and re-exchanged on every call). A response with no `expires_in` is cached for the process lifetime, since treating its absence as "expired" would re-exchange on every call. There is no refresh-token flow — no connector in the corpus has one. `credentialsIn` controls how the client id/secret reach the token endpoint: `"basic"` sends them as an `Authorization: Basic` header (as Nimbus's `ramp` connector does); `"body"` puts `client_id`/`client_secret` in the form body (as Nimbus's `looker`, `powerbi`, `teams` and `wiz` connectors do). `scope` is optional; the two `vars` and `style: "hand-rolled"` are required — `client-credentials` is **hand-rolled only** (`style: "rest-kit"` is a validation error), because the rest-kit registrar resolves a single bearer credential itself and has no seam for a token exchange.

### Reserved identifiers

The emitter introduces module-scope names of its own, so a spec may not reuse them. `local` names, `registrar` names and similar spec-supplied identifiers are validated against `RESERVED_IDENTIFIERS` in `src/validate.ts`, which is the authoritative list; reusing one is a validation error rather than a package that emits two declarations of the same name and fails its own `typecheck`.

`client-credentials` added `token`, `cachedToken` and `encodeBasicAuthHeader` to that list, and the write path added `URLSearchParams` and `<local>Send`. `token` and `cachedToken` are reserved unconditionally, not only for `client-credentials` specs — **a spec that named an env `local` `"token"` and validated under 0.2.2 will now be rejected.** Rename the local; nothing else changes.

The `read-only-kit` style and search tools add eight more, reserved unconditionally for the same reason: `runReadOnlyMcpConnector`, `ZodToolRegistrar`, `searchToolInputSchema`, `matchesResult`, `McpListResult`, `ZodObjectSchema`, `SearchMatchOptions` and `root`. The first seven are declared or imported at module scope in an emitted `src/server.ts`. **`root` is the one likely to bite**: a search tool with `rows` emits `const root = await <fetchHelper.local>(…)`, so a fetch helper named `root` would emit `const root = await root(…)` — a use-before-declaration error rather than a shadow.

## Stage B: standalone connectors

By default, generated connectors are **monorepo-internal**: they live at `packages/mcp-connectors/<name>/` inside a Nimbus checkout, where the `../../shared/*` relative imports (`mcp-tool-kit.ts`, `rest-tool-kit.ts`, etc.) resolve as-is.

Pass `--standalone` to generate a connector that is self-contained instead — installable and runnable anywhere, with no Nimbus checkout required:

```
bun src/cli.ts <name> --standalone
```

The standalone `src/server.ts` imports its helpers from a single published entry point, `@nimbus-dev/sdk/connector-kit`, instead of `../../shared/*`. Its generated `package.json` depends on `"@nimbus-dev/sdk": "^1.11.0"` (see `src/emit/package-json.ts`), and it gains `dev` and `build` scripts (`bun build src/server.ts --outdir dist --target bun`) that monorepo-target output does not have.

**This CLI, and every connector it generates, is Bun-only** (design doc decisions B6 and B7): `nimbus.extension.json` declares `"runtime": "bun"` for every connector, `test/sandbox.test.ts` imports `bun:test`, and the standalone `build` script targets Bun. `src/cli.ts` carries a `#!/usr/bin/env bun` shebang. There is no Node, npm, or pnpm path anywhere in this project or its output. The one exception is publishing: `.github/workflows/release.yml` sets up Node and runs `npm publish --provenance` in CI, because that is the only way to attach a sigstore provenance attestation to an npm tarball — everything else, including the check that proves the packed tarball actually runs, stays Bun-only.

**`@nimbus-dev/sdk` 1.11.0 is published.** It ships the `./connector-kit` export a standalone connector's `package.json` depends on, so `bun install` in a generated standalone package resolves that dependency from the registry with no local checkout and no rewrite. `bun run standalone-acceptance --registry` (see below) proves it end to end against the published tarball.

**This CLI is published to npm** as `create-nimbus-connector` (latest `0.3.2`), so standalone generation needs no checkout of this repo: `bunx create-nimbus-connector <name> --standalone`. From a checkout, the equivalent is `bun src/cli.ts <name> --standalone`.

## Usage

```
bunx create-nimbus-connector <name>   # the published CLI, no checkout needed
bun src/cli.ts <name>                 # from a checkout of this repo
```

Runs an interactive prompt session (name, title, description, network hosts, env vars, tools, ...) and writes the generated files to `packages/mcp-connectors/<name>/` (relative to the current directory), or to `<name>/` when `--standalone` is passed.

The published package's `bin` is `src/cli.ts`, which carries a `#!/usr/bin/env bun` shebang — so Bun is required to run the CLI however it is invoked, `bunx` included. (Generated standalone connectors need no checkout either — their `@nimbus-dev/sdk` dependency resolves from the registry.)

### Flags

- `--spec <path>` — skip the interactive prompts and load a `ConnectorSpec` JSON file instead (see `fixtures/*.spec.json` for examples, e.g. `fixtures/sentry.spec.json`). Mutually exclusive with a positional `<name>` — the name comes from the spec file.
- `--standalone` — generate a self-contained connector (imports `@nimbus-dev/sdk/connector-kit`, gains `dev`/`build` scripts) instead of the default monorepo-internal shape. Defaults the output directory to `<name>/` instead of `packages/mcp-connectors/<name>/`.
- `--dry-run` — don't write anything; print the file tree that would be created (path + byte size per file).
- `--out-dir <path>` — write to a directory other than the default.
- `--license <spdx>` — **standalone only.** Set the generated package's license, in `package.json` and the README's License section. Defaults to `UNLICENSED`. Passing it without `--standalone` is an **error**, not a silent no-op: a monorepo-target connector is `AGPL-3.0-only` unconditionally.
- `--gateway-wiring <nimbus-root>` — **opt-in, monorepo target only.** Also emit two Gateway-side scaffold files into `<nimbus-root>/packages/gateway/src/connectors/`. See "Gateway wiring" below. Off by default; normal generation is unaffected by its absence. Passing it with `--standalone` is an **error**, not a silent no-op: a standalone connector does not live in the Nimbus repo and is not registered with its Gateway.
- `--force` — allow `--gateway-wiring` to overwrite an existing `<name>-sync.ts` or `<name>-mapping.ts` in the target directory. An **error** when passed without `--gateway-wiring`. Without `--force`, `--gateway-wiring` refuses to write over a file it did not create — including a real, hand-authored sync file already in the monorepo.

### Licensing of generated connectors

A **monorepo** connector is `AGPL-3.0-only`. It lives inside the AGPL Nimbus repo and imports AGPL code through `../../shared/*`, and its `package.json` is byte-diffed against 94 real connectors — so this is fixed, not a default.

A **standalone** connector is none of those things: it is your own code, produced by an MIT-licensed tool, depending only on the MIT `@nimbus-dev/sdk`. Nothing about it obliges copyleft, so it is **not** stamped AGPL. It defaults to `UNLICENSED` — npm's marker for "no license granted" — which is a deliberate non-choice rather than a wrong choice made on your behalf. Pass `--license <spdx>` to set a real one:

```
bun src/cli.ts acme --standalone --license MIT
bun src/cli.ts acme --standalone --license "Apache-2.0"
bun src/cli.ts acme --standalone --license "MIT OR Apache-2.0"
```

The value is validated as an SPDX identifier or expression before anything is written; a malformed one fails at parse time rather than landing in a `package.json` npm will later reject. This is a syntax check, not a lookup against the SPDX license list — `LicenseRef-<name>` is accepted deliberately.

Examples:

```
bun src/cli.ts --spec fixtures/sentry.spec.json --dry-run
bun src/cli.ts --spec fixtures/sentry.spec.json --out-dir /tmp/sentry-preview
bun src/cli.ts --spec fixtures/zzstandalone.spec.json --standalone --out-dir /tmp/zzstandalone-preview
```

## Gateway wiring

```
bun src/cli.ts <name> --spec fixtures/<name>.spec.json --gateway-wiring C:\gitrep\Nimbus
```

Opt-in, monorepo-target only, and off by default — normal generation never touches Nimbus's Gateway. When passed, two additional files are written into `<nimbus-root>/packages/gateway/src/connectors/`:

- **`<name>-sync.ts`** — a `create<Name>Syncable(): Syncable` matching the Gateway's own `Syncable` interface (`serviceId`, `defaultIntervalMs`, `sync()`), draining the spec's first `*_list` tool. Its `sync()` body **throws** rather than doing anything.
- **`<name>-mapping.ts`** — a `map<Name>ItemToItem` stub with the expected signature, whose body also **throws**.

Both are **skeletons, not implementations** — deliberately. The Gateway's ~98 real `*-sync.ts` files are not one formulaic shape: the "drain a list tool and upsert" assembly this project could plausibly generate appears in exactly 2 of them; the rest (including this project's own four golden fixtures) are hand-authored with direct `fetch` calls, cursor pagination, and connector-specific option objects. Generating a working `sync()` would mean reproducing AGPL source nearly verbatim in an MIT repository, and asserting a shape that fits 2 of 98 connectors. So the tool emits only what the type system dictates — the shape, not anyone's implementation choices — plus a TODO comment, and leaves the real work to a human. It saves the boilerplate of the two files' scaffolding; it does not produce a working syncable.

`<name>-mapping.ts`'s body is unknowable from a connector spec for the same reason: no spec field describes a service's API response shape.

### Checking the skeleton still fits Nimbus

```
bun run wiring:conformance --nimbus-root C:\gitrep\Nimbus
```

`test/emit/emitted-typecheck.test.ts` compiles the emitted pair against a stand-in written *in this repo*, because this repo is MIT and Nimbus is AGPL-3.0-only, so the real `sync/types.ts` cannot be vendored. That proves the skeleton is internally well-typed and free of unread declarations — and proves nothing about whether it still matches Nimbus. Not hypothetical: the stand-in shipped with `upserted`/`deleted` while the real `SyncResult` spells them `itemsUpserted`/`itemsDeleted`.

This script reads the real interface and checks two things: the emitted skeleton supplies every member `Syncable` requires, and the stand-in agrees with the real field names. It reads Nimbus and writes nothing to it.

Like `diff:golden`, it needs a Nimbus checkout and therefore does not run in CI — a test that silently skipped when the root is absent would be green while asserting nothing. Run it before merging a wiring change.

**Writing refuses to overwrite an existing target file** unless `--force` is passed — Nimbus already ships hand-authored files such as `newrelic-sync.ts` and `datadog-sync.ts`, and an unguarded write on a connector reusing one of those names would destroy it.

**Two files are never written, only printed**: `platform/assemble-sync-registrations.ts` (93+ entries) and `connectors/connector-catalog.ts` (`CONNECTOR_SERVICE_IDS` plus the `tsc`-enforced matching `CONNECTOR_SYNC_INTERVAL_MS` entry). The CLI prints the exact lines to paste into each, rather than editing either — patching a large file it does not own, in another repository under another licence, risks silent corruption; a two-line paste the author controls is the safer trade.

## The golden-fixture diff harness

`fixtures/*.spec.json` are hand-written specs modelled on real connectors already in the Nimbus monorepo. The harness regenerates each one in memory and byte-diffs it against the real file on disk, so the acceptance bar for the generator is "reproduces a real connector exactly," not "produces something that looks plausible."

```
bun run diff:golden                                    # all fixtures, resolves Nimbus by sibling-dir/env probing
bun run diff:golden sentry --nimbus-root C:\gitrep\Nimbus
bun run diff:golden sentry datadog --nimbus-root D:\Nimbus
```

`--nimbus-root <path>` points at a Nimbus checkout explicitly. Resolution order if omitted: `--nimbus-root` flag, then `$NIMBUS_ROOT`, then a sibling directory of this repo named `Nimbus` or `nimbus`. A resolved path must contain the marker file `packages/mcp-connectors/shared/mcp-tool-kit.ts`, or resolution fails loudly rather than producing a wall of missing-file errors.

Each fixture's expected set of byte-identical file paths (out of 6) is checked in at `fixtures/expectations.json`. The harness fails if reality diverges from that set **in either direction** — a file that stopped matching, or one that newly matches without being declared, which would leave the expectations file and the design doc's gap report stale.

It records *which* files match rather than how many, deliberately: for a partial fixture such as `discord` (3 of 6), a count alone reports PASS when a change newly matches `README.md` while breaking `package.json`.

## The acceptance harness

`bun run acceptance <nimbus-root>` proves a generated connector doesn't just diff cleanly against a real one, but actually compiles and lints **inside** a live Nimbus checkout: it generates a throwaway `zzscratch` connector into `packages/mcp-connectors/zzscratch/`, runs `tsc --noEmit`, `biome check`, and `bun run audit:package-readmes` against it, then deletes it — via `try/finally`, so the scratch connector is removed even if generation or a check throws. It finishes by asserting `git status --short packages/mcp-connectors/` is empty in the target checkout, so a bug can never leave someone else's working tree dirty.

```
bun run acceptance C:\gitrep\Nimbus
```

## The runtime acceptance harness

```
bun run runtime:acceptance --registry          # or --sdk-root <path> for a local SDK
```

Every other check in this repo is **static**: string assertions, `tsc`, `biome`, a byte-diff against the corpus, and `tools/list` — which proves a generated server starts and describes itself, but never *invokes* a tool. Until this harness existed, no generated connector's `fetch` had ever run, and every belief about runtime behaviour was inference from reading the emitted text.

This one stands up a `Bun.serve` on an ephemeral loopback port, points a generated connector's base URL at it, drives the connector over stdio with real `tools/call` requests, and asserts on the traffic it actually produces:

- the bearer token arrives as `Authorization: Bearer …`
- an unset optional boolean is `?flag=false` in the URL and **absent** from the JSON body — the decision in the Stage C spec §8, which had been reached by argument and never executed
- a boolean in a body is a real JSON `true`, not the string `"true"`
- a defaulted arg is sent with its default applied
- path args are percent-encoded, and excluded from the default write body (D5)
- a `DELETE` whose only arg is in the path sends no body at all
- a non-2xx response becomes a tool error naming the status
- `client-credentials` exchanges its token **before** the API call, sends the id and secret where `credentialsIn` says, and **caches** — two tool calls produce one exchange

It needs the SDK installed from npm, and nothing else — no Nimbus checkout — so unlike `diff:golden` and `wiring:conformance` it **does** run automatically, in `.github/workflows/acceptance.yml`, alongside the standalone acceptance harness: on pull requests that touch `src/`, `scripts/` or `fixtures/`, and daily.

That workflow is deliberately separate from the merge gate. Both harnesses reach the npm registry, so a registry outage would otherwise red-X pull requests that changed nothing related. The daily run exists because the published SDK can change without anything in this repo changing, which is exactly what `--registry` mode is for.

## The standalone acceptance harness

Stage A's acceptance harness proves a monorepo-target connector against a live Nimbus checkout. There is no equivalent live ground truth for standalone connectors — no standalone Nimbus connector exists yet — so `bun run standalone-acceptance` substitutes a live end-to-end run: generate a `--standalone` connector into a temp directory outside the monorepo, resolve its `@nimbus-dev/sdk` dependency (see the two modes below), `bun install`, `bunx tsc --noEmit`, run the generated package's own `bun run typecheck` and `bun run lint` scripts (which resolve `tsc` and `biome` through its own `node_modules`, and re-check the emitted formatting and import order against the emitted `biome.json`), assert no `../../` import escapes `src/`, drive the server over real MCP stdio (`initialize` → `tools/list`, no credentials in the environment) against both `src/server.ts` and the `bun run build`-produced `dist/server.js`, then remove the temp directory whether or not any step threw.

### Two modes

They resolve `@nimbus-dev/sdk` from different places and answer different questions, so both are kept. Passing both is an error, not a precedence question.

```
bun run standalone-acceptance --registry                      # the published tarball
bun run standalone-acceptance C:\gitrep\nimbus-sdk            # a local SDK checkout
bun run standalone-acceptance --sdk-root C:\gitrep\nimbus-sdk
```

**`--registry`** installs exactly what the generator emitted — `"@nimbus-dev/sdk": "^1.11.0"`, unmodified — from npm. This is the strongest proof Stage B can offer, because it verifies the artifact real consumers actually get: a `dist` missing from the published `files` array surfaces here and nowhere else in this project. Run it before publishing this CLI.

**Local checkout** (the default) rewrites the dependency to `file:<sdk-root>/sdks/typescript` first. This is the **pre-release gate**: it can be pointed at an SDK branch that is not on npm and cannot be, so it stays useful for every future SDK change. Run it before releasing an SDK version.

`<sdk-root>` may be given positionally or as `--sdk-root <path>`, and resolves the same way `--nimbus-root` does: the argument, then `$NIMBUS_SDK_ROOT`, then a sibling directory of this repo named `nimbus-sdk`, requiring the marker file `sdks/typescript/package.json`.

In local-checkout mode the SDK must already be built (`dist/connector-kit/index.js` present), because `bunx tsc --noEmit` resolves the kit's types from `dist/connector-kit/index.d.ts` and the `node_modules` check asserts `dist/connector-kit/index.js` is on disk. That is genuine `dist` coverage for **types** and for **install-time existence** — but not for runtime JS, and this harness does *not* exercise the resolution path a real npm consumer takes. Two reasons: the SDK declares `"files": ["dist", "src"]`, so a `file:` dependency installs both; and Bun applies the SDK's `"bun"` export condition, which points `./connector-kit` at TypeScript source (`src/connector-kit/index.ts`), so both `bun src/server.ts` and `bun dist/server.js` run the kit from source. Runtime coverage of the built `dist` JS is the SDK's own `node-smoke` CI job (`sdks/typescript/scripts/smoke-esm.mjs`), not this harness — and that stays true in `--registry` mode, which changes where the package comes from, not which export condition Bun applies to it. What `--registry` adds is proof that the published tarball *contains* `dist` at all.

## SonarCloud coverage

SonarCloud reported **0.0% coverage on new code** on every pull request for a long time — not because the code was untested, but because **Automatic Analysis cannot ingest a coverage report**, and none was ever uploaded. `.github/workflows/sonar.yml` replaces it with a CI-based analysis that runs `bun test --coverage --coverage-reporter=lcov` and uploads `coverage/lcov.info`.

The two modes are mutually exclusive: SonarCloud **refuses** a CI analysis while Automatic Analysis is enabled. Switching over therefore has an order, and getting it wrong leaves the project with no analysis at all:

1. Add a `SONAR_TOKEN` repository (or organization) secret — SonarCloud → My Account → Security → Generate Token. Without it the scanner cannot authenticate at all: it fails with *"Not authorized or project not found"* before it ever reaches the analysis-mode question.
2. Turn Automatic Analysis off: SonarCloud → the project → Administration → Analysis Method. SonarCloud refuses a CI analysis while it is on, so this cannot wait until after the merge.
3. Re-run the `sonar` check on the pull request. It should now pass.
4. Merge.

Both switches precede the merge, deliberately. The alternative — merge first, then disable — means merging a pull request whose own checks are red, which is a habit worth not starting. The cost is a short window between steps 2 and 3 where `main` has no analysis at all; that window is minutes, and the pull request's own run covers the code going into it.

`bunfig.toml`'s per-file `coverageThreshold` still applies during this run, so the gate does not become advisory just because a reporter was added.

## Development

```
bun test                              # unit tests for the emitters, independent of any monorepo checkout
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
```

`generate(spec)` (pure, no filesystem/env/clock access) and `formatAll(files)` (the only stage that touches Biome) are split deliberately so the emitters are unit-testable without a monorepo, and so the CLI, `--dry-run`, and the golden harness all format through the identical code path. See the design doc's "Generation is a pure function" section for the full rationale.

## License

[MIT](./LICENSE).
