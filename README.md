# create-nimbus-connector

A generator for [**Nimbus**](https://github.com/nimbus-agent/Nimbus) MCP connector packages.

Nimbus's `packages/mcp-connectors/` holds 94+ connectors built from one rigid shape — a `server.ts`, a `nimbus.extension.json` manifest, a `tsconfig.json`, a `package.json`, a boilerplate `README.md`, and a constant `test/sandbox.test.ts`. Adding the next one means hand-copying those six files and editing the parts that vary.

This tool turns that shape into a generator: describe a connector as a small JSON spec, and it emits all six files — plus `src/search-filter.ts` when the spec declares a search tool, and a `biome.json` when the target is `--standalone` — run through the same Biome formatter the real connectors are formatted with.

The bar it is held to is **byte reproduction**: generate from a spec describing an existing connector, and diff the output against the real directory. `newrelic`, `datadog`, `grafana` and `sentry` come out byte-identical. How far that reaches across the rest of the corpus, and what stops it, is [*The measured ceiling*](./docs/ROADMAP.md#the-measured-ceiling) — the one place the regeneration counts are written down, carrying the date and the `packages/mcp-connectors` tree they were measured against.

```bash
bunx create-nimbus-connector acme --standalone
```

## Documentation

**New here? Start with [`docs/USAGE.md`](./docs/USAGE.md)** — a start-to-finish walkthrough. The spec language itself is documented in two halves, deliberately: **[`docs/SPEC.md`](./docs/SPEC.md)** is the field reference — every field `ConnectorSpecSchema` accepts, with its type, its default and the constraints on it, generated from that schema so it cannot drift from it — and **[`docs/SPEC-RULES.md`](./docs/SPEC-RULES.md)** is the prose reference, covering how those fields work together and the rules that reject a spec, which are the part no field-by-field table can carry. Look a field up in the first; find out why your spec was refused in the second.

| | |
| --- | --- |
| [USAGE.md](./docs/USAGE.md) | Generate your first connector, and verify it |
| [SPEC.md](./docs/SPEC.md) | Every spec field, generated from the schema |
| [SPEC-RULES.md](./docs/SPEC-RULES.md) | How the fields work together, and what gets a spec rejected |
| [ARCHITECTURE.md](./docs/ARCHITECTURE.md) | How the generator is built, and how it is verified |
| [ROADMAP.md](./docs/ROADMAP.md) | Where it is going, and the known limitations |
| [LICENSING.md](./docs/LICENSING.md) | The three-repo licence boundary, and what `--from-connector` may and may not produce |
| [CONTRIBUTING.md](./CONTRIBUTING.md) · [GOVERNANCE.md](./docs/GOVERNANCE.md) · [RELEASING.md](./docs/RELEASING.md) · [SECURITY.md](./SECURITY.md) | Working on it |
| [GLOSSARY.md](./docs/GLOSSARY.md) | Terms as this repo uses them |
| [CLAUDE.md](./CLAUDE.md) | Context for Claude Code |

Stuck on how to express a service as a spec, or wondering whether a change would be welcome before writing it? Ask in [Nimbus Discussions](https://github.com/nimbus-agent/Nimbus/discussions) — the one board for the whole organisation — and keep bugs in the generator itself as issues here.

### Which scaffolder do I want?

The org ships two, and they do different jobs:

- **`create-nimbus-connector` (this one)** — you describe a connector as a JSON spec and get a package in the shape the hand-written Nimbus connectors share, formatted by the same Biome. Reach for it when you are wrapping a REST API and want output that matches the corpus. Byte-identity is the bar it is held to, not a blanket guarantee across the corpus — [*The measured ceiling*](./docs/ROADMAP.md#the-measured-ceiling) is how much of it regenerates today, and why.
- **[`@nimbus-dev/create-connector`](https://github.com/nimbus-agent/nimbus-sdk/tree/main/tools/create-connector)** — templates a greenfield TypeScript **or Python** project that performs the SDK's contract-version handshake on stdio before serving MCP through the same `McpServer` and `StdioServerTransport` this generator emits. Reach for it when you want a blank project to write by hand, or when you need Python.

The intent is to converge these into one tool. [CONSOLIDATION.md](./docs/CONSOLIDATION.md) is what has to be true first — four preconditions, only one of which is a checkbox on this side — and because each of them describes another repository's state, each carries the commit and the date it was checked against.

## The two targets

**Standalone** connectors are self-contained — installable and runnable anywhere, with no Nimbus checkout. `src/server.ts` imports its helpers from a single published entry point, `@nimbus-dev/sdk/connector-kit`, and the package gains `dev` and `build` scripts. It also carries its own `biome.json`, which the monorepo target does not emit — a connector inside the checkout inherits the workspace root's, so emitting one there would be dead weight and would break the six-file byte-diff. This is what a third-party connector wants.

```bash
bunx create-nimbus-connector acme --standalone
```

**Monorepo-internal** connectors — the default — live at `packages/mcp-connectors/<name>/` inside a Nimbus checkout, where the `../../shared/*` relative imports resolve as-is.

```bash
bunx create-nimbus-connector acme
```

**This CLI, and every connector it generates, is Bun-only.** `nimbus.extension.json` declares `"runtime": "bun"`, `test/sandbox.test.ts` imports `bun:test`, the standalone `build` script targets Bun, and `src/cli.ts` carries a `#!/usr/bin/env bun` shebang — so Bun is required however the CLI is invoked, `bunx` included. There is no Node, npm or pnpm path in this project or its output. The one exception is publishing: `.github/workflows/release.yml` runs `npm publish --provenance` in CI, because that is the only way to attach a sigstore attestation to an npm tarball.

## The spec language

Every tool is a single HTTP request against a path built from a small template DSL (`${env.X}`, `${arg.X}`, `${arg.X|enc}`, `${arg.X|num}`, `${arg.X|bool}`). No pagination, no multi-step or multi-fetch tools. A tool that can't be expressed under that constraint sets `"impl": "stub"` and gets a typed handler that throws `"<tool> not implemented"` rather than being silently dropped or guessed at. Around that core the language reaches writes and HITL, three registration styles, OAuth client-credentials, conditional query parameters, and substring-search tools with a filter file of their own.

Two rules shape all of it. **Fields the emitters cannot render are a hard validation error, never an automatic downgrade** — a spec that would silently generate something other than what it describes is rejected instead. And **spec surface is a cost**: a field that changes only appearance is refused, and the resulting difference is recorded as a documented irreducible diff. A generator whose input is harder to write than its output is a failed generator.

**[`docs/SPEC-RULES.md`](./docs/SPEC-RULES.md) is the reference for all of it** — each feature, the shapes it takes, and the rules that reject a spec, which are the part no field-by-field table can carry. [`docs/SPEC.md`](./docs/SPEC.md) is the other half: every field the schema accepts, generated from the schema itself.

## CLI reference

```
bunx create-nimbus-connector <name>   # the published CLI, no checkout needed
bun src/cli.ts <name>                 # from a checkout of this repo
```

With a positional name it runs an interactive prompt session — display name, service label, description, base API URL, auth type, credential env var, then tool names. The connector name is *not* asked for: it is the positional argument. Run with neither a name nor `--spec` and the session opens by asking for it. One question is conditional: answering `token` or `basic` to the auth question adds a header-name prompt, which `bearer` skips. Generated output goes to `packages/mcp-connectors/<name>/` relative to the current directory, or to `<name>/` when `--standalone` is passed.

### Flags

- `--spec <path>` — skip the prompts and load a `ConnectorSpec` JSON file instead (see `fixtures/*.spec.json`, e.g. `fixtures/sentry.spec.json`). Mutually exclusive with a positional `<name>` — the name comes from the spec file.
- `--standalone` — generate a self-contained connector instead of the monorepo-internal shape. Defaults the output directory to `<name>/`.
- `--dry-run` — write nothing; print the file tree that would be created, with a byte size per file.
- `--out-dir <path>` — write to a directory other than the default.
- `--license <spdx>` — **standalone only.** Set the generated package's license. Defaults to `UNLICENSED`. Passing it without `--standalone` is an **error**, not a silent no-op: a monorepo-target connector is `AGPL-3.0-only` unconditionally.
- `--gateway-wiring <nimbus-root>` — **opt-in, monorepo target only.** Also emit the Gateway wiring skeleton. Passing it with `--standalone` is an **error**: a standalone connector is not registered with any Gateway.
- `--force` — allow `--gateway-wiring` to overwrite an existing `<name>-sync.ts` or `<name>-mapping.ts`. An **error** without `--gateway-wiring`.
- `--from-connector <dir>` — the pipeline in reverse: read a connector directory and print the `ConnectorSpec` that would regenerate it, writing nothing. Mutually exclusive with a positional `<name>`, `--spec`, `--gateway-wiring`, `--out-dir`, `--standalone`, `--license` and `--dry-run`. A connector the spec language cannot fully describe exits non-zero with the constructs that stopped the read, in the same vocabulary `bun run reach --verbose` uses — never a silent approximation. See [`docs/USAGE.md`](./docs/USAGE.md#8-deriving-a-spec-from-an-existing-connector), and [`docs/LICENSING.md`](./docs/LICENSING.md) for why running it against a checkout you already have is not vendoring.
- `--partial` — with `--from-connector`, print a draft spec instead of only the blocker report. The draft carries a `$partial` marker key that `ConnectorSpecSchema`'s `z.strictObject` refuses by construction, so it cannot be generated until you resolve the blockers and delete the key. An **error** without `--from-connector`.
- `--from-openapi <doc>` — read an OpenAPI 3 document (JSON or YAML, `$ref`s resolved internally) and print the `ConnectorSpec` for a selection of its operations, writing nothing. Mutually exclusive with a positional `<name>`, `--spec`, `--from-connector` and every flag that shapes a write. Requires either `--list-operations` or at least one `--op`. See [What an OpenAPI document can and cannot supply](#what-an-openapi-document-can-and-cannot-supply).
- `--list-operations` — with `--from-openapi`, print one `operationId  METHOD  /path` line per operation to stdout, in document order, so `--op` arguments can be copied straight off it. Operations this reader can see but not offer — `head`/`options`/`trace`, and a mis-cased method key like `Post:` — are named on **stderr** with the reason, never silently dropped. An **error** without `--from-openapi`.
- `--op <operationId>` — with `--from-openapi`, select an operation to become a tool. Repeatable; the tools appear in the order named. An `--op` naming an operation `--list-operations` reported as skipped is refused as *that*, not as a missing operation. An **error** without `--from-openapi`, and an **error** combined with `--list-operations` — both read the same document and only one can produce output.

A bare `--from-openapi` with no `--op` is an **error**, not "map everything". Which operations become tools is a product decision the document does not state: a document describes a whole API, where a connector exposes the few operations an agent should be able to call. Mapping everything would also make one operation the spec language cannot express — of a kind most real documents carry — refuse the whole document, since an operation maps completely or not at all.
- `--help` — print usage. Every flag in that text is one `parseFlags` actually parses; `test/cli.test.ts` asserts the two agree, so an undocumented flag is a failing test.
- `--version` — print the version.

An unrecognised flag is an error with a did-you-mean suggestion, never silently ignored.

> **Connector output overwrites without asking.** Generation creates parent directories and writes each file; there is no existence check and no prompt, so generating into a directory that already holds a connector replaces those files in place. Use `--dry-run` first. The two `--gateway-wiring` files are the only exception, and they refuse to overwrite without `--force`.

```bash
bun src/cli.ts --spec fixtures/sentry.spec.json --dry-run
bun src/cli.ts --spec fixtures/sentry.spec.json --out-dir /tmp/sentry-preview
bun src/cli.ts acme --standalone --license MIT
```

### What an OpenAPI document can and cannot supply

```bash
bun src/cli.ts --from-openapi widgets.yaml --list-operations
bun src/cli.ts --from-openapi widgets.yaml --op listWidgets --op getWidget > widgets.spec.json
bun src/cli.ts --spec widgets.spec.json
```

The spec goes to **stdout** and every note and refusal to **stderr**, so the redirect above leaves a file that `--spec` reads while the notes stay on screen.

**Read from the document.** The connector `name` (`info.title`, slugified to lower-kebab-case), the fetch helper's `base` and the `network` permission (the one `servers[0].url`), the env auth mode (`components.securitySchemes`: `http`/`bearer`, `http`/`basic`, and an `apiKey` sent in a header), and one tool per selected operation — its name from `operationId`, its description from `summary`, its `path` with each `{widgetId}` turned into `${arg.widgetId|enc}`, its method, its query parameters (including OpenAPI's rule that an operation-level parameter overrides a path-item one of the same name and location), and a flat JSON request body.

**Filled with a placeholder, for you to replace.** `style`, `syncInterval`, `minNimbusVersion`, `displayName`, `serviceLabel`, the connector `description`, and a tool description for an operation with no `summary`. Every prose one carries a `TODO:` marker; `style` and `syncInterval` cannot hold prose, so they carry a value that parses and is obviously provisional.

**Cannot be filled at all, and is noted rather than guessed.** `effect` — the manifest's human-in-the-loop confirmation — is left unset on every operation, and each non-GET carries a note asking for it, because the corpus is emphatic that deriving it from the HTTP method is wrong for a third of connectors. An exclusive `exclusiveMinimum`/`exclusiveMaximum` becomes an inclusive `min`/`max` with a note recording the widening, which is the one knowing divergence in the whole path.

**Refused by name rather than approximated.** At the document level: Swagger 2.0 or any non-3 version; a `$ref` that leaves the document, returns to itself, or names a node that is not there; an operation with no `operationId`, or two sharing one; no `servers`, more than one, a URL carrying server-variable templating, one that is not http(s), and one carrying a query string or fragment; no security scheme, more than one, and a scheme with no env auth mode — oauth2 (whose `credentialsIn` the document cannot state) and an `apiKey` in a query string or a cookie. At the operation level: a header or cookie parameter, an `array` or `object` argument, `oneOf`/`anyOf`/`allOf`, a request body that is not flat `application/json`, a body on a GET, a path that is not `/`-absolute or that uses Express-style `/:id` templating, an argument name no slug can make into a JS identifier, two names slugifying onto one argument, and a name landing on a reserved identifier or on a JavaScript reserved word. An operation maps completely or not at all — a tool missing the one parameter that could not be expressed is a connector that passes every gate and sends the wrong request.

`head`, `options` and `trace` operations, and a mis-cased method key, are the two constructs that are **reported instead of refused**: they are listed by `--list-operations` on stderr and omitted from the selectable set, so one `HEAD /health` cannot take forty mappable operations down with it. Naming one with `--op` is then refused as *that*, rather than as an operation the document does not contain.

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
