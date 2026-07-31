# create-nimbus-connector

A generator for [**Nimbus**](https://github.com/nimbus-agent/Nimbus) MCP connector packages. Nimbus's `packages/mcp-connectors/` holds 94+ connectors built from one rigid shape — a `server.ts`, a `nimbus.extension.json` manifest, a `tsconfig.json`, a `package.json`, a boilerplate `README.md`, and a constant `test/sandbox.test.ts`. Adding the next one means hand-copying those six files and editing the parts that vary. This tool turns that shape into a generator: describe a connector as a small JSON spec, and it emits all six files, run through the same Biome formatter the real connectors are formatted with.

Full design rationale, the two emission styles, and the acceptance criteria this project is held to live in [`docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md`](./docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md) (Stage A — monorepo-internal generation), [`docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-b-design.md`](./docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-b-design.md) (Stage B — standalone generation and publishing), and [`docs/superpowers/specs/2026-07-31-create-nimbus-connector-stage-c-design.md`](./docs/superpowers/specs/2026-07-31-create-nimbus-connector-stage-c-design.md) (Stage C — writes, HITL, OAuth, Gateway wiring).

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

This exchanges the two `vars` (client id, then secret) for a bearer token by POSTing form-encoded `grant_type=client_credentials` (plus `scope`, when given) to `tokenUrl`, then caches the token for the process's lifetime — it is never refreshed and `expires_in` is never read, which is correct only because a generated connector is spawned per invocation and is short-lived. `credentialsIn` controls how the client id/secret reach the token endpoint: `"basic"` sends them as an `Authorization: Basic` header (as Nimbus's `ramp` connector does); `"body"` puts `client_id`/`client_secret` in the form body (as Nimbus's `looker`, `powerbi`, `teams` and `wiz` connectors do). `scope` is optional; the two `vars` and `style: "hand-rolled"` are required — `client-credentials` is **hand-rolled only** (`style: "rest-kit"` is a validation error), because the rest-kit registrar resolves a single bearer credential itself and has no seam for a token exchange.

### Reserved identifiers

The emitter introduces module-scope names of its own, so a spec may not reuse them. `local` names, `registrar` names and similar spec-supplied identifiers are validated against `RESERVED_IDENTIFIERS` in `src/validate.ts`, which is the authoritative list; reusing one is a validation error rather than a package that emits two declarations of the same name and fails its own `typecheck`.

`client-credentials` added `token`, `cachedToken` and `encodeBasicAuthHeader` to that list, and the write path added `URLSearchParams` and `<local>Send`. `token` and `cachedToken` are reserved unconditionally, not only for `client-credentials` specs — **a spec that named an env `local` `"token"` and validated under 0.2.2 will now be rejected.** Rename the local; nothing else changes.

## Stage B: standalone connectors

By default, generated connectors are **monorepo-internal**: they live at `packages/mcp-connectors/<name>/` inside a Nimbus checkout, where the `../../shared/*` relative imports (`mcp-tool-kit.ts`, `rest-tool-kit.ts`, etc.) resolve as-is.

Pass `--standalone` to generate a connector that is self-contained instead — installable and runnable anywhere, with no Nimbus checkout required:

```
bun src/cli.ts <name> --standalone
```

The standalone `src/server.ts` imports its helpers from a single published entry point, `@nimbus-dev/sdk/connector-kit`, instead of `../../shared/*`. Its generated `package.json` depends on `"@nimbus-dev/sdk": "^1.11.0"` (see `src/emit/package-json.ts`), and it gains `dev` and `build` scripts (`bun build src/server.ts --outdir dist --target bun`) that monorepo-target output does not have.

**This CLI, and every connector it generates, is Bun-only** (design doc decisions B6 and B7): `nimbus.extension.json` declares `"runtime": "bun"` for every connector, `test/sandbox.test.ts` imports `bun:test`, and the standalone `build` script targets Bun. `src/cli.ts` carries a `#!/usr/bin/env bun` shebang. There is no Node, npm, or pnpm path anywhere in this project or its output. The one exception is publishing: `.github/workflows/release.yml` sets up Node and runs `npm publish --provenance` in CI, because that is the only way to attach a sigstore provenance attestation to an npm tarball — everything else, including the check that proves the packed tarball actually runs, stays Bun-only.

**`@nimbus-dev/sdk` 1.11.0 is published.** It ships the `./connector-kit` export a standalone connector's `package.json` depends on, so `bun install` in a generated standalone package resolves that dependency from the registry with no local checkout and no rewrite. `bun run standalone-acceptance --registry` (see below) proves it end to end against the published tarball.

**This CLI is not published yet.** That is now a separate, remaining step rather than something blocked on the SDK — run standalone generation from a checkout of this repo (`bun src/cli.ts <name> --standalone`) until it is.

## Usage

```
bun src/cli.ts <name>
```

Runs an interactive prompt session (name, title, description, network hosts, env vars, tools, ...) and writes the generated files to `packages/mcp-connectors/<name>/` (relative to the current directory), or to `<name>/` when `--standalone` is passed.

This CLI is not published to npm yet, so `bunx create-nimbus-connector <name>` does not work. Run from a checkout of this repo with `bun src/cli.ts` in the meantime. (The connectors it *generates* have no such constraint — their `@nimbus-dev/sdk` dependency is on the registry.)

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

## Development

```
bun test                              # unit tests for the emitters, independent of any monorepo checkout
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
```

`generate(spec)` (pure, no filesystem/env/clock access) and `formatAll(files)` (the only stage that touches Biome) are split deliberately so the emitters are unit-testable without a monorepo, and so the CLI, `--dry-run`, and the golden harness all format through the identical code path. See the design doc's "Generation is a pure function" section for the full rationale.

## License

[MIT](./LICENSE).
