# Architecture

How `create-nimbus-connector` is built. For *what* it does see the
[README](../README.md); for how to drive it see [USAGE.md](./USAGE.md); for the operational
rules an agent working here needs see [CLAUDE.md](../CLAUDE.md).

## The pipeline

One direction, four stages, no cycles:

```
JSON spec ──▶ parseSpec ──▶ validateSpec ──▶ generate ──▶ formatAll ──▶ writeFiles
              (src/spec)    (src/validate)  (src/emit)   (src/format)  (src/cli)
                   │              │              │            │
              zod schema   identifier      pure: spec →   real Biome
              + refinements  collisions   GeneratedFile[]
```

**`generate()` is pure.** Same spec in, same array out — no clock, no filesystem, no network.
That is what lets every emitter be unit-tested by calling it directly, and what lets the
golden harness diff its output without side effects.

**Emitters return unformatted source.** Indentation is Biome's job. Emitters do control
*line breaks*, because Biome preserves author breaks in several positions, and in those
positions the break is part of the bytes being matched.

### Why formatting is a real stage

The generated connectors must match hand-written files byte-for-byte, and those files were
formatted by Biome. Re-implementing Biome's output would be a losing game, so `src/format.ts`
runs the actual `@biomejs/js-api` with `FORMATTER_CONFIG` (2-space, 100 columns, double
quotes, trailing commas, semicolons, LF).

Two consequences worth knowing. Biome's `organizeImports` sorts names *within* an import
clause, using a rule that is not a plain string sort — it buckets by the case-folded first
character of the **local** binding and puts `type` imports ahead of value imports in a shared
bucket. `src/emit/server/index.ts` replicates that in `biomeNamedImportOrder`, verified
against the pinned binary rather than inferred. And the generated package's own `bun run lint`
re-checks the emitted formatting against the emitted `biome.json`, so a drift between the two
fails in acceptance.

## The two targets

`GenerateTarget = "monorepo" | "standalone"` is the seam every emitter consults. It is
threaded as a parameter rather than read from global state, so a single process can emit both.

|  | monorepo | standalone |
| --- | --- | --- |
| Lives at | `packages/mcp-connectors/<name>/` | `<name>/` |
| Kit imports | `../../shared/*.ts` | `@nimbus-dev/sdk/connector-kit` |
| `tsconfig` | extends the workspace base | self-contained |
| Scripts | typecheck, lint, test | plus `dev`, `build` |
| Relative imports | may carry `.ts` | must not — `.js` specifier |

**Some helpers cannot cross the seam, and the emitter compensates by inlining.**
`runReadOnlyMcpConnector` imports `@modelcontextprotocol/sdk` directly, so it cannot live in
the dependency-free SDK; `searchToolInputSchema` builds a zod schema, same problem. For the
standalone target both are emitted as local definitions, chosen so the *call site* is
byte-identical across targets. Only the definitions differ.

## Module boundaries

### `src/spec.ts` — the spec language

A zod schema plus refinements, and the single source of truth for what a connector spec may
say. Every rule that can be expressed as "this combination is invalid" lives here as a
refinement with a message that names the field, rather than in an emitter as a silent
fallback. Fields the emitters cannot render are a **hard error, never a downgrade** — a spec
that would silently generate something other than what it describes is rejected.

`parseSpec` also derives `title` (PascalCase from `name`) when absent, which is why
`ConnectorSpec` is `z.infer<...> & { title: string }`.

### `src/validate.ts` — identifier collisions

Separate from the schema because it is a *whole-spec* question, not a field question: does
any spec-supplied identifier collide with another, or with a name the emitter itself
declares? `RESERVED_IDENTIFIERS` is that second set. Its purpose is to move a failure that
would otherwise appear as a duplicate declaration in the generated package's `tsc` forward to
parse time, where the message can name the offending field.

### `src/emit/` — one module per emitted file

`manifest.ts`, `package-json.ts`, `readme.ts`, `sandbox-test.ts`, `tsconfig.ts`,
`biome-json.ts`, `search-filter.ts`, `wiring.ts`, and `server/` for the one file complex
enough to need splitting:

```
server/index.ts         imports, wiring, glue, assembly
server/env.ts           credential accessors, the auth modes
server/fetch-helper.ts  the read and write helpers
server/args.ts          zod argument schemas
server/path-template.ts the ${env.X} / ${arg.X|enc} DSL
server/body.ts          request bodies for write tools
server/tools-hand.ts    hand-rolled + read-only-kit registrations
server/tools-rest.ts    rest-kit registrations
server/search.ts        impl: "search" registrations
```

`emit/index.ts` composes them into `GeneratedFile[]`. A seventh file joins the six-file tree
only when the spec declares a search tool.

### `src/golden/` — fixture machinery

Root resolution (`resolve.ts`, `resolve-root.ts`, `sdk-root.ts`), the expectations file
(`expectations.ts`), snapshots (`snapshots.ts`), and `run.ts`, the subprocess wrapper the
harnesses share. Kept out of `scripts/` deliberately: these are the parts that decide
something from their arguments alone, so they can be unit-tested, while `scripts/` holds what
genuinely needs subprocesses.

## The verification layers

Four harnesses, each answering a question the others cannot. They are layered, and the
ordering is by how much of the world they need.

1. **`bun test`** — emitters called directly. Includes `emitted-typecheck.test.ts`, which
   compiles emitted output with the real TypeScript compiler; substring assertions cannot see
   an unbalanced brace or an unused import.
2. **`diff:golden`** — generate from a fixture spec, diff against the real connector in a
   Nimbus checkout. This is the acceptance test for the *template*: where the diff is
   irreducible, that is either a spec field the template must expose or an honest limitation
   to document. Needs the monorepo, so it cannot run in CI.
3. **`acceptance`** — write a generated connector into a real Nimbus checkout and run the
   monorepo's own `tsc`, `biome` and `audit:package-readmes` over it. Proves it survives
   where it will actually live.
4. **`standalone-acceptance`** — generate into a temp dir, install a real SDK, then typecheck,
   lint, build, and **drive the server over stdio** — from source and again from the bundled
   `dist/server.js`, because a bundler can strip an import in a way that leaves every
   source-level check green.

`runtime:acceptance` sits alongside 4, executing generated connectors against a loopback HTTP
server and asserting on the requests they actually make — the only check that observes runtime
behaviour rather than inferring it from text.

## Why the fixtures are hand-written

The repo is MIT and Nimbus is AGPL-3.0-only, so no connector source may be copied here. The
fixtures are therefore hand-written specs, and the harness reads the real connectors from a
path passed at runtime. This is a licensing constraint expressed as an architecture: it is
also why `wiring-conformance.ts` exists, since the wiring test in `test/` compiles against a
locally-written stand-in that proves internal consistency and nothing about whether the
skeleton still matches Nimbus.
