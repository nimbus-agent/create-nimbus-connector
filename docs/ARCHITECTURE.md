# Architecture

How `create-nimbus-connector` is built. For *what* it does see the
[README](../README.md); for how to drive it see [USAGE.md](./USAGE.md); for the operational
rules an agent working here needs see [CLAUDE.md](../CLAUDE.md).

## The pipeline

One direction, four stages, no cycles:

```text
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

It also holds the spec language's **parsers**, alongside the schema: `resolveKeyedShape` and
`needsExtractor` for a search filter's field list, and `parsePathTemplate` for `tool.path`'s
`${env.X}` / `${arg.X|enc}` DSL. Those answer questions about a spec *field*, and three layers
need the same answer — `src/validate.ts` checks that every `${arg.X}` names a declared argument,
`src/emit/` renders it, `src/derive/` reads it back. This module is the one place all three
already depend on, so it is where the answer lives rather than in any one of them.

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

```text
server/index.ts         imports, wiring, glue, assembly
server/env.ts           credential accessors, the auth modes
server/fetch-helper.ts  the read and write helpers
server/args.ts          zod argument schemas
server/path-template.ts renderPath — the DSL's renderer (the parser is in src/spec.ts)
server/query.ts         conditional query-string parameters (query + omitWhen)
server/body.ts          request bodies for write tools
server/tools-hand.ts    hand-rolled + read-only-kit registrations
server/tools-rest.ts    rest-kit registrations
server/search.ts        impl: "search" registrations
```

`emit/index.ts` composes them into `GeneratedFile[]`. A seventh file joins the six-file tree
only when the spec declares a search tool.

### `src/derive/` — the inverse of `src/emit/`

`deriveSpec(files)` turns a connector's `src/server.ts`, `nimbus.extension.json` and (when
present) `src/search-filter.ts` back into a spec, or into named blockers. It is what
`--from-connector` and `bun run reach` both run; it ships, because `package.json`'s `files` is
`["src", "README.md"]`.

```text
ast.ts             the Babel boundary — parseModule, the AstNode type
read.ts            THE ONLY module that reads a node's fields, through guarded accessors
claims.ts          byte-range claims; coverage is containment
blockers.ts        an unclaimed statement -> a histogram bucket
manifest.ts        nimbus.extension.json -> spec fields
search-filter.ts   src/search-filter.ts -> filter entries
index.ts           deriveSpec(files) -> Derivation
from-connector.ts  a connector DIRECTORY -> a spec, or a blocker report
server/            mirrors src/emit/server/ — one recognizer per emitter module, plus
                   frame.ts and hoists.ts, which have no emitter counterpart
```

Three properties hold it honest, and each exists because its absence produced a false pass:

- **The totality rule.** Every top-level and function-body statement must be covered by a claim;
  an unclaimed statement fails the connector. There is no ignore-the-rest path. The number this
  produces is deliberately lower than a scrape's, because a scrape is silent about what it does
  not recognize and silence reads as absence.
- **`AstNode` carries only `type`, `start`, `end`, `loc`**, so every other field read goes
  through `read.ts`. `bunx tsc --noEmit` is the enforcement: with an index signature,
  `node["computed"]` typechecks for any key and yields `undefined`, and a matcher that validates
  part of a construct while claiming the whole of it is exactly the defect the totality rule
  cannot see.
- **The dependency direction.** A recognizer may import the **spec language** — `src/spec.ts`'s
  `parsePathTemplate`, `resolveKeyedShape` — because a private copy that under-parses fails
  silently while the shared one fails loudly. It may **never** import `src/emit/`'s renderers:
  comparing rendered text against observed source would make a renderer bug self-consistent and
  invisible to every gate.

### `src/openapi/` — the document reader

`assembleSpec(doc, ops)` turns an OpenAPI 3 document plus a selection of its operations into a
spec, or into named refusals. It is what `--from-openapi` runs, and it writes nothing.

```text
schema.ts     the zod boundary — the SUBSET of OpenAPI this tool reads, in loose objects so
              parameters, requestBody and vendor extensions survive the parse
document.ts   text -> document: JSON or YAML, every internal $ref resolved, operations listed
operation.ts  one operation -> one tool: path, method, args, query, body — or its refusals
spec.ts       document + selected operations -> a whole spec, with its placeholders
```

**It is the structural mirror of `src/derive/`:** both produce a spec from something that is not
one, and both **refuse by name** rather than approximate — one reads a foreign document, the other
reads this generator's own emitted source. The mirror is deliberate and so is the one place it
breaks: there is no counterpart to `derive/read.ts`, because a Babel AST has a hundred node types
and an index signature made eight wrong claims possible, while an OpenAPI document is plain JSON
that `OpenApiDocumentSchema` has already proved the shape of — **the schema is the guard**.

The two differ in what a quiet mis-read costs, which is why the reader's rule is stricter. A
deriver that under-reads re-emits different bytes and `diff:golden` catches it; a mapper that
drops the one parameter it could not express produces a connector that compiles, passes every
gate and sends the wrong request. So an operation maps completely or not at all, every refusal in
a run is collected rather than only the first, and `assembleSpec` puts its own output through the
real `parseSpec` and `validateSpec` before returning it — the spec it prints has already been
accepted by the pipeline that will consume it.

### `src/golden/` — fixture machinery

Root resolution (`resolve.ts`, `resolve-root.ts`, `sdk-root.ts`), the expectations file
(`expectations.ts`), snapshots (`snapshots.ts`), and `run.ts`, the subprocess wrapper the
harnesses share. Kept out of `scripts/` deliberately: these are the parts that decide
something from their arguments alone, so they can be unit-tested, while `scripts/` holds what
genuinely needs subprocesses.

## The verification layers

Four harnesses, each answering a question the others cannot. They are layered, and the
ordering is by how much of the world they need. **`bun run preflight --nimbus-root <path>` is
the runner over all of them** — `scripts/_lib/preflight.ts` holds the gate sequence as data and
the decision of whether a run may call itself fully verified; `scripts/preflight.ts` is the
driver that spawns. Which emitted shape each layer actually covers, and which of them can pass
while proving nothing, is [TESTING.md](./TESTING.md).

1. **`bun test`** — emitters called directly. Includes `emitted-typecheck.test.ts`, which
   compiles emitted output with the real TypeScript compiler; substring assertions cannot see
   an unbalanced brace or an unused import. It also holds the **snapshot** comparison below,
   which is the only byte-level ground truth in the repo that needs no external checkout.
   `preflight` runs **`bun test --coverage`** as a separate gate beside this one rather than in
   place of it: Bun evaluates `bunfig.toml`'s per-file floors only on a run carrying the flag, so
   the two fail for different reasons and a single entry covering both would conflate them.
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

`reach` sits alongside `diff:golden`, reading the same Nimbus checkout to answer a different
question: not whether one fixture's bytes match, but how many of the 94 real connectors this
generator can derive a spec for and regenerate at all. It derives a spec from each connector's
`src/server.ts` and `nimbus.extension.json`, runs it through `parseSpec`, `validateSpec` and
`generate()`, and buckets the result into a tier — `blocked`, `emits`, `server-identical`, or
`all-identical` — without ever writing the derived spec to disk. `bun run reach:baseline`
records the per-connector tiers in `fixtures/reach-baseline.json`, keyed on `connectorsTree`:
the git tree object of `packages/mcp-connectors`, the only path the harness reads. Keying on
HEAD was deliberately refused — two commits can carry a byte-identical `packages/mcp-connectors`
(a change elsewhere in the monorepo, a merge, a revert), and refusing on a commit SHA that moved
while the tree did not made `--baseline` refuse a corpus that had not actually changed.
`bun run reach --baseline` refuses to compare across a moved or dirty checkout and otherwise
fails when a connector has regressed a tier. Like `diff:golden` and `wiring:conformance`, it
needs the AGPL monorepo and so cannot run in CI.

### 1a. `fixtures/snapshots/` — checked-in ground truth for the shapes no real connector has

`fixtures/snapshots/<fixture>/` holds a complete generated **standalone** package, checked in
file by file, and `test/golden/snapshots.test.ts` regenerates it and byte-compares the tree.
It exists because `diff:golden`'s ground truth is the corpus, and the corpus does not contain
every shape this generator emits: no real connector fixture declares a write tool, so `method`,
`effect`, `body` and the `<local>Send` helper have no hand-written file to be diffed against.
A snapshot is the substitute — weaker than a real connector, because it only proves the bytes
did not *change*, but it is a byte comparison and it runs in CI.

**Which fixtures get one is derived, never listed.** `listWriteFixtures` (`src/golden/snapshots.ts`)
selects every fixture with at least one non-`read`-effect tool, and both the test and the update
script import that one definition — a script that snapshots fixtures the test never checks, or
the reverse, would defeat either. Adding a write fixture therefore adds a snapshot requirement
automatically, and `loadSnapshot` refuses an absent **or empty** directory rather than comparing
against nothing.

```bash
bun run snapshot:update            # regenerate every snapshot tree
```

Run it after any change that legitimately moves standalone write output, and **read the diff it
produces before committing it** — this is the one gate in the repo whose expected value is
rewritten by a command, which is exactly the shape `fixtures/expectations.json` warns about.

### 2. The golden-fixture harness, in detail

```bash
bun run diff:golden                                        # all fixtures
bun run diff:golden sentry --nimbus-root /path/to/Nimbus
bun run diff:golden sentry datadog --nimbus-root /path/to/Nimbus
```

Resolution order for the Nimbus root: the `--nimbus-root` flag, then `$NIMBUS_ROOT`, then a
sibling directory named `Nimbus` or `nimbus`. A resolved path must contain the marker file
`packages/mcp-connectors/shared/mcp-tool-kit.ts` or resolution fails loudly, rather than
producing a wall of missing-file errors.

`fixtures/expectations.json` records, per fixture, **which** files are expected to match — not
how many. That distinction is load-bearing: for a partial fixture at 3 of 6, a count alone
reports PASS when a change newly matches `README.md` while breaking `package.json`. The harness
fails when reality diverges **in either direction**, so an unexpected *improvement* also fails
— otherwise the expectations file and the documented gaps go stale silently.

### 3. The monorepo acceptance harness

```bash
bun run acceptance /path/to/Nimbus
```

Generates a throwaway `zzscratch` connector into `packages/mcp-connectors/zzscratch/`, runs the
monorepo's own `tsc --noEmit`, `biome check` and `bun run audit:package-readmes` against it,
then deletes it in a `finally` so it is removed even if a check throws. It finishes by asserting
`git status --short packages/mcp-connectors/` is empty in the target checkout, so a bug can
never leave someone else's working tree dirty.

### 4. The standalone acceptance harness, and its two modes

There is no live ground truth for standalone connectors — no standalone Nimbus connector exists
yet — so this harness substitutes an end-to-end run: generate into a temp directory outside the
monorepo, resolve `@nimbus-dev/sdk`, `bun install`, `bunx tsc --noEmit`, run the generated
package's **own** `typecheck` and `lint` scripts (which resolve `tsc` and `biome` through its
own `node_modules`, and re-check the emitted formatting and import order against the emitted
`biome.json`), assert no `../../` import escapes `src/`, drive the server over real MCP stdio
against both `src/server.ts` and the `bun run build`-produced `dist/server.js`, then remove the
temp directory whether or not a step threw.

```bash
bun run standalone-acceptance --registry                 # the published tarball
bun run standalone-acceptance /path/to/nimbus-sdk        # a local SDK checkout
```

**The two modes answer different questions and both are kept.** Passing both is an error, not a
precedence question.

- **`--registry`** installs exactly what the generator emitted, unmodified, from npm. It is the
  only check that verifies the artifact real consumers get: a `dist` missing from the published
  `files` array surfaces here and nowhere else. Run it before publishing this CLI.
- **Local checkout** rewrites the dependency to `file:<sdk-root>/sdks/typescript`. It is the
  pre-release gate — it can be pointed at an SDK branch that is not on npm and cannot be, so it
  stays useful for every future SDK change. Run it before releasing an SDK version.

**A fixture whose declared SDK floor is not published yet reports `SKIP`, not `FAIL`.** The
registry mode's question is genuinely unanswerable for such a fixture, and answering "no" would
be wrong — but the skip is narrow by construction. `isUnpublishedFloorFailure` requires bun's
own unresolvable-range message naming both the exact declared range and `@nimbus-dev/sdk`; an
outage, a 500, a missing package or a frozen lockfile all still fail. A skipped run prints what
was skipped and does **not** print the sentence a fully-verified run prints, and nothing in the
predicate names a version or a fixture, so it expires by itself the moment the release lands.

In local-checkout mode the SDK must already be built, because `tsc` resolves the kit's types
from `dist/connector-kit/index.d.ts`. That is genuine `dist` coverage for **types** and for
**install-time existence**, but not for runtime JS: Bun applies the SDK's `"bun"` export
condition, which points `./connector-kit` at TypeScript source, so both `bun src/server.ts` and
`bun dist/server.js` run the kit from source. Runtime coverage of the built `dist` JS is the
SDK's own `node-smoke` CI job. What `--registry` adds is proof the published tarball *contains*
`dist` at all.

### The wiring conformance script

```bash
bun run wiring:conformance --nimbus-root /path/to/Nimbus
```

`test/emit/emitted-typecheck.test.ts` compiles the emitted Gateway wiring pair against a
stand-in written *in this repo*, because Nimbus is AGPL-3.0-only and its real `sync/types.ts`
cannot be vendored. That proves the skeleton is internally well-typed and free of unread
declarations — and proves **nothing** about whether it still matches Nimbus.

That is not hypothetical: the stand-in once shipped with `upserted`/`deleted` while the real
`SyncResult` spells them `itemsUpserted`/`itemsDeleted`, and every test was green.

This script reads the real interface and checks two things — that the emitted skeleton supplies
every member `Syncable` **requires**, and that the stand-in agrees with the real field names. It
reads Nimbus and writes nothing to it. Like `diff:golden` it needs a checkout and so cannot run
in CI; run it before merging a wiring change.

Both halves of that sentence are load-bearing, and each was wrong once:

- **`requires` means required.** The member parse discarded `?`, so every optional member read as
  mandatory. `SyncResult.bytesTransferred` was patched around by *name*; when Nimbus's `Syncable`
  later grew an optional `fetchOne`, there was no such patch and the gate failed `preflight` at a
  defect the generator did not have. Optional members are now reported, never failed on — a
  connector may legitimately omit `fetchOne`, and Nimbus answers `no_targeted_fetch` for one that
  does. A gate that cries wolf stops being run, which costs exactly what a false green costs.
- **"supplies" means *the object literal* supplies it.** The check searched the whole emitted
  file, and the file's own generated docstring says `sync() below throws` — so `\bsync\s*[:(]`
  matched as English regardless of what the skeleton declared. Renaming the emitted method to
  `syncMUTANT` left the gate green. It now reads the literal's top-level keys
  (`scripts/_lib/object-literal-keys.ts`), which is the scoping the second check had already
  been given, with a comment explaining why, while the first check kept the bug that comment
  describes.

### 5. The runtime acceptance harness

Every other check is static — string assertions, `tsc`, `biome`, a byte-diff, and `tools/list`,
which proves a server starts and describes itself but never *invokes* a tool. Until this harness
existed, no generated connector's `fetch` had ever run and every belief about runtime behaviour
was inference from reading emitted text.

It stands up a `Bun.serve` on an ephemeral loopback port, points a generated connector's base
URL at it, drives the connector over stdio with real `tools/call` requests, and asserts on the
traffic produced: that the bearer token arrives as `Authorization: Bearer …`; that an unset
optional boolean is `?flag=false` in the URL and **absent** from the JSON body; that a boolean
in a body is a real JSON `true`, not `"true"`; that a defaulted arg is sent with its default
applied; that path args are percent-encoded and excluded from the default write body; that a
`DELETE` whose only arg is in the path sends no body; that a non-2xx becomes a tool error naming
the status; and that `client-credentials` exchanges its token *before* the API call, sends the
credentials where `credentialsIn` says, and **caches** — two tool calls producing one exchange.

It needs only the SDK from npm and no Nimbus checkout, so unlike `diff:golden` and
`wiring:conformance` it **does** run in CI, in `.github/workflows/acceptance.yml`, on pull
requests touching `src/`, `scripts/` or `fixtures/`, and daily.

That workflow is deliberately separate from the merge gate: both network-dependent harnesses
live there, so a registry outage cannot red-X a pull request that changed nothing related. The
daily run exists because the published SDK can change without anything in this repo changing —
which is exactly what `--registry` mode is for.

## Why the fixtures are hand-written

The repo is MIT and Nimbus is AGPL-3.0-only, so no connector source may be copied here. The
fixtures are therefore hand-written specs, and the harness reads the real connectors from a
path passed at runtime. This is a licensing constraint expressed as an architecture: it is
also why `wiring-conformance.ts` exists, since the wiring test in `test/` compiles against a
locally-written stand-in that proves internal consistency and nothing about whether the
skeleton still matches Nimbus.
