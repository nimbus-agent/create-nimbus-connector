# Phase 3: Authoring From a Document — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close Stage F — author a spec from an OpenAPI document (`--from-openapi`), point validation
errors at the JSON path, and publish a `ConnectorSpec` JSON Schema that editors can use.

**Architecture:** One new subsystem, `src/openapi/`, structured as the mirror of `src/derive/`: a
document reader, a per-operation mapper, and an assembler that produces a raw spec object which
`parseSpec` then judges. It reads a *document*, where `src/derive/` reads *emitted source*; both
produce a spec and both refuse by name rather than guessing. Two smaller changes follow in
`src/spec.ts` (error paths) and a new `schema/` directory (the published JSON Schema).

**Tech Stack:** TypeScript, Bun (`Bun.YAML.parse` — no new dependency), zod ^4.4.2 (`z.toJSONSchema`),
Biome 2.5.7.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Licensing.** This repo is MIT; the Nimbus monorepo is AGPL-3.0-only. **No connector source and
  no `shared/` source may be copied into `src/`, `test/` or `fixtures/`.** Reading the corpus to
  check a fact is expected; transcribing it is not. **Every OpenAPI test document in this plan is
  synthetic** — do not copy a real API's published document either, even though its licence would
  permit it, because a hand-written one is the only kind whose every field is deliberate.
- **Bun-only.** No Node, npm or pnpm path in this project or its output. `Bun.YAML.parse` is the
  YAML reader; **no new dependency is added by this plan.**
- **The byte-safety invariant.** `newrelic`, `datadog`, `grafana` and `sentry` reproduce **6/6**
  files and must stay there. This plan adds **no emitter path and no spec field**, so `diff:golden`
  cannot move — which makes any movement a finding, not a surprise.
- **`fixtures/` is not touched.** OpenAPI test documents live under `test/`, not `fixtures/` —
  `fixtures/*.spec.json` is the golden-fixture corpus that `diff:golden` and `expectations.json`
  sweep, and a document of a different kind there would be a category error.
- **Refuse by name.** Every construct `--from-openapi` cannot map is reported with a label naming
  it, the same discipline `src/derive/`'s blockers use. Silent omission is the failure mode this
  whole repo is built against: a spec that looks complete and quietly dropped an operation is worse
  than a refusal.
- **Output is validated before it is printed.** Everything `--from-openapi` prints has passed the
  real `parseSpec` **and** `validateSpec`. It never writes a package.
- **Cite by symbol or heading text, never by line number.** Line-number citations drifted thirteen
  times on the previous branch and were replaced wholesale.
- **Comments explain *why*** and cite the measurement behind a choice. A measurement in a comment
  carries the corpus tree it was taken against and the command that re-measures it — the convention
  the previous branch settled after twenty-four stale claims.
- **Never commit on `main`.** **Conventional Commits** drive release-please.
- **Before claiming anything works, run it.**

### The gates

| Command | What it proves | Needs |
| --- | --- | --- |
| `bun test` | Unit + emitted-source typecheck | — |
| `bunx tsc --noEmit` | This repo typechecks | — |
| `bunx biome check src/ test/ scripts/` | This repo lints | — |
| `bun test --coverage` | Per-file floors | — |
| `bun run diff:golden --nimbus-root <path>` | Emitted bytes unchanged | Nimbus checkout |
| `bun run reach --baseline --nimbus-root <path>` | No connector lost a tier | Nimbus checkout |

Read **each gate's own exit code**. `cmd | tail; echo $?` reports `tail`'s status. Note that
`bun test <file> | tail` has been observed to hang in Git Bash on this machine — redirect to a file
rather than piping.

---

## What I verified before writing this plan

Four claims this plan rests on, checked rather than assumed. Two of them changed the plan.

| claim | result |
| --- | --- |
| `Bun.YAML.parse` exists in the pinned Bun | **holds** — Bun `1.3.14` in all four workflows and locally; `parse` is a function, resolves aliases (`a: &x 1 / b: *x` → `{a:1,b:1}`), and returns an array for a multi-document stream |
| The design's "59 of the 94 corpus connectors percent-encode at least one path argument" | **holds exactly** — 59 files match `encodeURIComponent` at tree `94fd3623` |
| `z.toJSONSchema(ConnectorSpecSchema)` generates the schema | **FALSE as written** — it **throws** `Transforms cannot be represented in JSON Schema`. It succeeds only with `{ io: "input" }` (4819 bytes) or `{ unrepresentable: "any" }` (5027 bytes) |
| The generated schema carries the schema's refinements | **FALSE** — `"must also declare"`, `"only valid on a tool"` and `"reserved"` are all absent from the output. Refinements do not survive |

The last two are why Task 6 is written the way it is.

---

## Decisions taken, and why

The design specifies `--from-openapi` in detail (§6.1) and item 16 in a single table row. These are
the calls that row left open. Each is a judgement I made; each is reversible, and the reasoning is
here so a reviewer can disagree with the reason rather than guess at it.

**`--op` is repeatable; `--list-operations` prints and exits.** One document describes many
operations and one connector has many tools, so the selection has to be a set. `--list-operations`
is the discovery half: print `operationId`, method and path, then exit 0 without producing a spec.

**Unfillable required fields get placeholder values, not omissions.** §6.1 says output is validated
through the real `parseSpec` before printing, and also lists `style`, `syncInterval`,
`minNimbusVersion` and the connector `description` as things the document cannot supply. Both hold
only if the placeholders *parse*. So they are filled with values that parse and are obviously
provisional, and the `TODO:` marker lives in description strings — the convention `src/prompts.ts`
already uses (`TODO: describe ${name}.`).

**Validation errors use bracketed paths (`tools[0].args.limit`), not JSON Pointer.** The audience is
a human editing a JSON file by hand. Bracketed indices distinguish an array position from an object
key on sight, which `tools.0.args.limit` — today's output — does not. JSON Pointer (`/tools/0/...`)
is better for machines and worse for the reader this is for.

**The published JSON Schema is generated with `io: "input"`, checked in, and drift-tested.**
`io: "input"` is both the only option that does not throw *and* the semantically correct one: the
schema exists to validate a spec a human is *writing*, which is the input shape, before defaults and
transforms are applied. It is checked in rather than generated on demand so an editor can reference
it by URL, and a test regenerates and byte-compares it so it cannot drift — the same mechanism
`fixtures/expectations.json` relies on.

**The JSON Schema's limits are published with it.** This is the one that matters. Refinements do not
survive into JSON Schema, so the published schema **accepts specs `parseSpec` rejects**: an editor
will show a spec as valid and the CLI will then refuse it. That is a false green in this repo's
exact sense. It cannot be fixed — it is a property of JSON Schema, not of this generator — so it is
stated in the schema's own `description`, in `README.md`, and pinned by a test that asserts the gap
is *known* rather than discovered later.

---

## Task 1: The OpenAPI document reader, and `--list-operations`

**Files:**
- Create: `src/openapi/document.ts`, `src/openapi/schema.ts`
- Test: `test/openapi/document.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `src/openapi/schema.ts`: `OpenApiDocumentSchema` (a zod schema for the *subset* this tool reads)
    and `type OpenApiDocument = z.infer<typeof OpenApiDocumentSchema>`.
  - `src/openapi/document.ts`:
    ```ts
    export type LoadedDocument = { doc: OpenApiDocument; source: "yaml" | "json" };
    export function loadDocument(text: string): LoadedDocument;   // throws with a named reason
    export type Operation = {
      readonly operationId: string;
      readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      readonly path: string;
      readonly summary?: string;
      readonly raw: unknown;    // the operation object, for Task 2 to map
    };
    export function listOperations(doc: OpenApiDocument): Operation[];
    export function resolveRefs(doc: unknown): unknown;   // internal $ref only
    ```

- [ ] **Step 1: Write the failing test**

Create `test/openapi/document.test.ts`. The document is **synthetic** — invent it; do not copy a
published one.

```ts
import { describe, expect, it } from "bun:test";
import { listOperations, loadDocument, resolveRefs } from "../../src/openapi/document.ts";

/** A minimal document exercising every construct Task 1 must read: both body formats, an
 *  internal $ref, an alias, and two operations on one path. */
const YAML_DOC = [
  "openapi: 3.0.3",
  "info:",
  "  title: ZZ Widgets",
  "  version: 1.0.0",
  "servers:",
  "  - url: https://api.zzwidgets.test/v1",
  "paths:",
  "  /widgets:",
  "    get:",
  "      operationId: listWidgets",
  "      summary: List widgets.",
  "    post:",
  "      operationId: createWidget",
  "      summary: Create a widget.",
  "  /widgets/{widgetId}:",
  "    get:",
  "      operationId: getWidget",
  "      summary: Fetch one widget.",
  "",
].join("\n");
```

Assertions: `loadDocument` reports `source: "yaml"` for the above and `"json"` for the same document
as JSON; `listOperations` returns the three operations in document order with `method` upper-cased
and `path` verbatim; and a document with no `paths` is refused with a named error rather than
returning `[]`.

Add refusals, each proving it corrupted something first (`expect(bad).not.toBe(YAML_DOC)`):
- an operation with **no `operationId`** — refused by name, because `--op` selects on it and a
  generated fallback would be a name the document does not contain;
- an **external** `$ref` (`./other.yaml#/X`) — refused by name; only internal `#/...` refs resolve;
- a **circular** internal `$ref` — refused rather than recursing forever;
- a **dangling** internal `$ref` (`#/components/schemas/NoSuchThing`) — refused by name. This is the
  one that fails quietly if unhandled: a missing lookup yields `undefined`, which then flows into a
  mapper as an absent field rather than an error, and the operation maps with a silently missing
  schema. Refuse at resolution, where the reference is still in hand;
- an unsupported `openapi` major version (`2.0` / Swagger) — refused by name.

- [ ] **Step 2: Run it — must FAIL on the missing module**

```bash
bun test test/openapi/document.test.ts
```
Expected: FAIL, "Cannot find module '../../src/openapi/document.ts'".

- [ ] **Step 3: Write `src/openapi/schema.ts`**

A zod schema for **the subset this tool reads**, not for OpenAPI. Model only: `openapi`, `info.title`,
`info.version`, `servers[].url`, `paths` (a record of path → record of method → operation), and
`components` (`schemas`, `securitySchemes`). Everything else passes through untouched — this schema's
job is to make the shapes Task 2 reads *provably present*, not to validate the document as a whole.

Say that in the module docstring, because a reader will otherwise reasonably expect an OpenAPI
validator and file the gaps as bugs.

- [ ] **Step 4: Write `src/openapi/document.ts`**

`loadDocument` tries `JSON.parse` first (a JSON document is also valid YAML, but `JSON.parse` gives a
better error and is the common case for a downloaded spec), then `Bun.YAML.parse`. **A multi-document
YAML stream parses to an array** — verified — so an array result is refused by name rather than
silently taking the first document.

`resolveRefs` walks the document and replaces `{ $ref: "#/..." }` with the referenced node. Internal
refs only; a `$ref` that is not a string starting `#/` is refused by name. Track the resolution path
to refuse a cycle. Roughly 50 lines, per the design.

**Do not add a generic node accessor layer here.** `src/derive/read.ts`'s guarded-accessor discipline
exists because a Babel AST has a hundred node types and an index signature made eight wrong claims
possible. An OpenAPI document is plain JSON already validated by a zod schema, so the schema *is* the
guard. Say so in the docstring so the asymmetry with `src/derive/` reads as deliberate.

- [ ] **Step 5: Run the tests**

```bash
bun test test/openapi/document.test.ts
bunx tsc --noEmit
```
Both exit 0.

- [ ] **Step 6: Wire `--list-operations` into the CLI**

`src/cli.ts` parses flags in a single `for` loop over `argv` (see the `--from-connector` /
`--partial` handling). Add `--from-openapi <doc>` and `--list-operations` the same way, and add both
to the flag list the help text prints.

`--list-operations` requires `--from-openapi`; alone it is an error naming the missing flag. It
prints one line per operation — `operationId`, method, path — and exits 0.

- [ ] **Step 7: Test the CLI path through the real binary**

`src/cli.ts` is driven through `Bun.spawnSync` in `test/`, because Bun cannot instrument it for
coverage (see `bunfig.toml`, which explains this at length — do **not** add in-process tests that
duplicate the subprocess ones). Follow the existing pattern in the CLI tests.

- [ ] **Step 8: Gates and commit**

```bash
bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/ && bun test --coverage
```
```bash
git add src/openapi/ src/cli.ts test/
git commit -m "feat(openapi): read a document and list its operations"
```

---

## Task 2: Operation → tool

**Files:**
- Create: `src/openapi/operation.ts`
- Test: `test/openapi/operation.test.ts`

**Interfaces:**
- Consumes: `Operation`, `OpenApiDocument` (Task 1).
- Produces:
  ```ts
  export type MappedTool = { tool: Record<string, unknown>; notes: string[] };
  export type Refusal = { kind: string; detail: string };
  export function mapOperation(op: Operation, doc: OpenApiDocument):
    { ok: true; mapped: MappedTool } | { ok: false; refusals: Refusal[] };
  ```
  `notes` are human-facing TODO fragments Task 3 folds into description strings.

- [ ] **Step 1: Write the failing test**

What must map, per the design:

- **`path`** — OpenAPI's `{id}` becomes `${arg.id|enc}`. The `|enc` mode is the default because
  **59 of the 94 corpus connectors percent-encode at least one path argument** (measured at tree
  `94fd3623`; re-measure with `grep -l encodeURIComponent */src/server.ts` under
  `packages/mcp-connectors`). Note that `src/emit/server/path-template.ts` **rejects** a literal
  `{id}` — its `FOREIGN_PLACEHOLDER` check names OpenAPI's form specifically — so this substitution
  is the bridge between the two conventions, not a convenience.
- **`method`** — upper-cased; `GET` is omitted so `ToolSchema`'s default applies.

**A hazard Task 1 hit, which reaches you differently: a zod object schema with declared keys
silently REORDERS its input to schema-declaration order.** Measured:
`z.object({ get, post }).parse({ post: 1, get: 2 })` returns keys in `get,post` order.
`z.looseObject({})` and `z.record(...)` both preserve input order.

Task 1 hit this on path items, where it destroyed the document order `--list-operations` promises.
**It reaches you on emitted bytes.** `src/emit/server/args.ts` iterates `Object.entries(args)` in
four places — `renderZodFieldList`, `renderHoists` and their callers — so **argument order is
emitted order**, and `renderBodyExpr`'s default body is built from `Object.keys(tool.args)` too. A
schema that reorders a document's property names changes the emitted `z.object({ … })` field order
and the emitted `JSON.stringify({ … })` field order with it.

OpenAPI `parameters` is an **array**, so parameter order is safe. The exposure is a request body's
`properties` **object**: model it with `z.record(...)`, never with declared keys, and add a test
that a body whose properties are declared `{ zebra, alpha }` maps to args in that order rather than
alphabetically. Order is not cosmetic here — it is bytes.
- **`args`** — from `parameters` (`in: "path"` and `in: "query"`), carrying `type`, `optional`
  (`required: false`), `default`, `min`/`max` (`minimum`/`maximum`), and `int`
  (`type: integer`).

  **Merge the path item's own `parameters` first — Task 1 exposes them for you.** A path item may
  declare `parameters` that apply to *every* operation inside it, and `/widgets/{widgetId}` with the
  variable declared at path level is a canonical OpenAPI shape. Task 1 originally dropped them
  silently, which would have left you seeing a `{widgetId}` in the path template with nothing
  declaring it — forced to either refuse a common valid document or invent a type. It now carries
  them as `Operation.pathParameters`.

  **OpenAPI's merge rule, which you implement rather than re-derive:** path-level parameters apply
  to all operations in the item, and an operation-level parameter **overrides** a path-level one
  when both `name` **and** `in` match. Matching on `name` alone is wrong — the same name may legally
  appear once in `path` and once in `query`. Test both: a path-level parameter inherited by an
  operation that declares none, and an operation-level parameter overriding a path-level one of the
  same `(name, in)`.

  **Those two tests are the only gate this obligation has.** Task 1's implementer flagged it
  precisely: *"a Task 2 that ignores `pathParameters` entirely still passes every gate in this
  task."* The field exists, the rule is documented, and nothing fails if you never read it — so
  omitting the tests is not a thin test file, it is an unenforced contract, and a document whose
  path variable is declared at path level would then map with an invented type or a spurious
  refusal. Write them first.

  **One more inherited condition, with an expiry.** Task 1 resolves a `$ref` by replacing the whole
  node, so `summary`/`description` siblings are dropped — documented there as acceptable *because no
  mapper reads them*. If you read any field from a schema node beyond `type`, `format`, `enum`,
  `minimum`, `maximum` and `default`, **that argument expires and nothing will notice**. Say so in
  your report if you do.
- **`body`** — from a **flat** `requestBody` JSON schema: one level of properties, each a scalar.
  **Select the media type explicitly.** `requestBody.content` is keyed by media type; take
  `application/json` or a `+json` suffix type (`application/problem+json`). A body offering only
  `application/x-www-form-urlencoded`, `multipart/form-data` or `text/*` is **refused by name** —
  `renderBodyExpr` writes `JSON.stringify(...)` and the fetch helper sends
  `Content-Type: application/json`, so a form-encoded body is not a formatting difference, it is a
  different request this generator cannot emit.

**Argument names must be valid JS identifiers, and OpenAPI's are frequently not.** `ToolSchema`
constrains `args` keys with `/^[A-Za-z_$][A-Za-z0-9_$]*$/` ("argument name must be a valid JS
identifier"), while `{widget-id}` and `{widget.id}` are ordinary in real documents.

**Slugify to camelCase rather than refusing** — `{widget-id}` → `widgetId` — because the argument
name is spec-internal and never reaches the URL: the path template interpolates the *value* at that
segment's position, so `/widgets/{widget-id}` becomes `/widgets/${arg.widgetId|enc}` and the request
is byte-identical either way. Refusing here would cost real reach for a name nobody observes.

Two rules make that safe, and both need tests:
- **The slug must be injective across the operation.** If two parameters slugify onto one name
  (`widget-id` and `widget_id`), **refuse by name** — silently collapsing them would drop an
  argument, and the tool would then send one value where the API expects two.
- **A slug that lands on a `RESERVED_IDENTIFIERS` entry refuses**, for the reason Task 3 states
  about connector names: a spec that fails its own `validateSpec` is worse than a refusal.

Assert each, then the refusals — every one **by name**:
- a nested (non-flat) request body;
- a parameter `in: "header"` or `in: "cookie"`;
- a schema type this spec language has no equivalent for (`array`, `object`);
- `oneOf` / `anyOf` / `allOf` in a parameter or body schema;
- a path templating form other than `{name}`.

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement `mapOperation`**

One function per concern (`mapPath`, `mapParameters`, `mapBody`), each returning either a value or a
refusal, so the caller can report **every** refusal rather than the first. A partial map is never
returned: an operation either maps completely or is refused.

**The `|enc` default deserves its own comment** citing the 59/94 measurement with its tree and
re-measure command, because it is the one place this task encodes a corpus-derived convention rather
than a document fact.

- [ ] **Step 4: Run the tests and commit**

```bash
bun test test/openapi/operation.test.ts && bunx tsc --noEmit
```
```bash
git add src/openapi/ test/
git commit -m "feat(openapi): map one operation onto a tool, refusing what it cannot express"
```

---

## Task 3: Document → spec, and the placeholders

**Files:**
- Create: `src/openapi/spec.ts`
- Test: `test/openapi/spec.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  ```ts
  export type Assembled =
    | { ok: true; spec: Record<string, unknown>; notes: string[] }
    | { ok: false; refusals: Refusal[] };
  export function assembleSpec(
    doc: OpenApiDocument, ops: readonly Operation[],
  ): Assembled;
  ```

- [ ] **Step 1: Write the failing test**

What the *document* supplies:
- **`fetchHelper.base` and `network`** from `servers[0].url` — origin into `network`, full URL into
  `base`. More than one server is a refusal by name, not a silent first-wins.

  **Three server cases refuse rather than placeholder, and the distinction is the point.** A
  `servers` array that is **absent**, **empty**, or whose first entry has **no `url`**; and a URL
  carrying OpenAPI **server-variable templating** (`https://{tenant}.api.example/v1`, with a
  `variables` block). All four are refused by name.

  This is a different category from the placeholders below, and the plan should not blur them. A
  placeholder stands in for a *Nimbus convention the document cannot express* — `style`,
  `syncInterval` — where any value is provisional and the author knows to set it. A base URL is a
  **fact about the API that an OpenAPI document is supposed to carry**; inventing one emits a spec
  that points at an endpoint nobody chose, and `network` would then declare a host the connector
  never contacts. Refuse, and say which of the four cases it was.
- **the env auth mode** from `components.securitySchemes`:
  - `type: http`, `scheme: bearer` → `auth: "bearer"`
  - `type: http`, `scheme: basic` → `auth: "basic"` — `EnvSchema` supports it natively, and
    `EnvSchema`'s own refine requires **exactly two vars** for basic, so emit two placeholder var
    names (a username and a secret). Refusing a scheme the spec language models would be a gap in
    this mapper, not a limit of the generator.
  - `type: apiKey`, `in: header` → `auth: "headers"` with the header name.

  Anything else — OAuth2 flows, OpenID Connect, mutual TLS, an API key `in: query` or `in: cookie` —
  refused by name. **`credentialsIn` is never inferred**; the design lists it as unfillable, and it
  is a fact about the token endpoint that `securitySchemes` does not carry.
- **`name`** slugified from `info.title`.

What gets a **placeholder that parses**, with the reason stated in the test's name:
`style` (`"hand-rolled"`), `syncInterval`, `minNimbusVersion`, `serviceLabel`, `displayName`, the
connector `description`, and every tool `description` the document does not supply — each carrying a
`TODO:` marker, matching `src/prompts.ts`'s `TODO: describe ${name}.` form.

**Then the assertion that matters:** the assembled spec passes the real `parseSpec` **and**
`validateSpec`. Import them and call them in the test. That is the whole contract — an assembled
spec that does not parse is not a spec.

Also assert a tool name collision is refused by name (two operations whose slugified `operationId`
collide), and that a document with zero mappable operations refuses rather than emitting
`tools: []`.

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement**

Placeholders are **constants in one place**, not scattered literals, so the set of things the
document cannot supply is readable at a glance and matches §6.1's list.

Check `RESERVED_IDENTIFIERS` (`src/validate.ts`) when deriving any local name from the document — a
document whose title slugifies onto a reserved name must refuse, not emit a spec that fails its own
`validateSpec`.

- [ ] **Step 4: Gates and commit**

```bash
bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/
```
```bash
git add src/openapi/ test/
git commit -m "feat(openapi): assemble a spec the real parseSpec and validateSpec accept"
```

---

## Task 4: `--from-openapi` end to end

**Files:**
- Modify: `src/cli.ts`
- Test: the CLI subprocess tests
- Modify: `README.md` (the flag reference)

**Interfaces:**
- Consumes: `assembleSpec`, `listOperations`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Through the real binary via `Bun.spawnSync`:
- `--from-openapi <doc> --op listWidgets --op getWidget` prints a spec to **stdout**, exit 0, and
  the printed text is valid JSON that `parseSpec` accepts. **Parse the stdout in the test** — that
  is the assertion, not a substring match.
- `--op` naming an operation the document does not contain: exit non-zero, the message names the
  missing `operationId` **and** lists what is available.
- A document whose every selected operation refuses: exit non-zero, every refusal printed by name.
- `--from-openapi` with no `--op`: decide and pin one behaviour — either all mappable operations, or
  an error directing the user to `--list-operations`. **State which in the help text.**

  **Task 1 left a provisional answer here and flagged it for you.** It could not assemble a spec, so
  a bare `--from-openapi` currently exits 1 with "pass `--list-operations`…", and the help text says
  `requires --list-operations`. That is one of the two candidate behaviours, standing by accident
  rather than by choice. **Choose deliberately now** — a connector author who has already run
  `--list-operations` and wants everything mappable is a real case, and so is refusing to guess at
  a tool set. Whichever you pick, the help text must stop describing the provisional state.

**One refusal is handed to you deliberately: an `--op` naming an unsupported-method operation.**
Task 1 detects `head`/`options`/`trace` and originally refused the whole document for them — which
was reversed, because refusing a valid forty-operation document over one `HEAD /health` defeats the
purpose of `--list-operations`. Those operations are now **noted and omitted from the selectable
set**, so the hard refusal belongs here, at selection: `--op` naming one must refuse **by name**,
saying the method is unsupported rather than reporting the operation as missing. Those are different
diagnoses and a user who is told "no such operation" for one they can see in the listing will not
believe the tool. Test it.

**That test is the only gate this obligation has**, and Task 1's implementer said so explicitly when
handing it over. `listSkippedOperations` exists and nothing fails if you never call it. A `--op`
naming a skipped operation would then fall through to the generic missing-operation path and report
a confidently wrong diagnosis.
- Nothing is ever written to disk. Assert the output directory is untouched.

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Wire it**

Print the spec with `JSON.stringify(spec, null, 2)`. Refusals go to **stderr**, the spec to
**stdout**, so `--from-openapi … > spec.json` produces a usable file while the refusals stay visible.
That split is the reason to prefer stdout over a written file, and it belongs in a comment.

- [ ] **Step 4: Update `README.md`**

Add `--from-openapi`, `--op` and `--list-operations` to the flag reference, and a short section on
what the document can and cannot supply — the §6.1 lists, as prose. **Name the constructs, not the
counts.**

- [ ] **Step 5: Full gates and commit**

```bash
bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/ && bun test --coverage
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --baseline --nimbus-root C:/gitrep/Nimbus
```
`diff:golden` must be **unchanged** — this plan adds no emitter path. `reach --baseline` must exit 0.

```bash
git add src/cli.ts test/ README.md
git commit -m "feat(cli): author a spec from an OpenAPI document with --from-openapi"
```

---

## Task 5: Validation errors that point at the JSON path

**Files:**
- Modify: `src/spec.ts` (`parseSpec`)
- Test: `test/spec.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports; `parseSpec`'s thrown message changes shape.

Today `parseSpec` renders each issue as `  ${i.path.join(".") || "(root)"}: ${i.message}` — so a bad
argument bound reads `tools.0.args.limit.max: ...`, in which `0` could be an array index or a key
named `0`.

- [ ] **Step 1: Write the failing test**

```ts
it("points at the JSON path with bracketed indices, so an array position is distinguishable from a key", () => {
  const bad = { /* a spec with a bad value inside tools[0].args */ };
  expect(() => parseSpec(bad)).toThrow(/tools\[0\]\.args\.limit/);
});

it("reports every issue, not the first", () => { /* two independent bad values, both named */ });

it("names the root for a top-level issue rather than printing an empty path", () => { /* (root) */ });
```

Add one asserting the **received value** appears, so a reader sees what was rejected rather than only
where. Keep it to one line per issue — a spec with ten problems must stay readable.

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Implement**

A small `formatIssuePath(path: readonly PropertyKey[]): string` that joins string keys with `.` and
wraps numeric keys in `[...]`. Export it **only if** Task 6 needs it; otherwise keep it module-private
— an export is a contract, and this one has a single caller.

- [ ] **Step 4: Check what else asserts on this message**

`parseSpec`'s error text is asserted in several tests, and `src/cli.ts` prints it. Grep before
committing:

```bash
grep -rn "Invalid connector spec" src/ test/ scripts/
```
Update every assertion that pins the old shape. A test that pins the *old* format and still passes
means the change did not reach it.

- [ ] **Step 5: Gates and commit**

```bash
bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/
```
```bash
git add src/spec.ts test/
git commit -m "fix(spec): point validation errors at the JSON path with bracketed indices"
```

---

## Task 6: The published `ConnectorSpec` JSON Schema, and its stated limits

**Files:**
- Create: `schema/connector-spec.schema.json`, `scripts/build-schema.ts`
- Modify: `package.json` (`files`, and a `schema` script)
- Test: `test/schema.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `ConnectorSpecSchema` (`src/spec.ts`).
- Produces: the checked-in schema file.

### Read this before writing any code — two verified facts that shape the task

**`z.toJSONSchema(ConnectorSpecSchema)` throws.** Verified: `Transforms cannot be represented in JSON
Schema`. It succeeds with `{ io: "input" }` or `{ unrepresentable: "any" }`.

**Use `{ io: "input" }`.** It is both the option that does not throw and the semantically right one:
the schema validates a spec a human is *writing*, which is the input shape — before `parseSpec`
applies defaults and transforms. `{ unrepresentable: "any" }` describes the *output* shape, which no
editor ever sees.

**The refinements do not survive.** Verified: `"must also declare"`, `"only valid on a tool"` and
`"reserved"` are all absent from the generated schema. So the published schema **accepts specs
`parseSpec` rejects**. An editor will show a file as valid and the CLI will then refuse it.

That is a false green, it is inherent to JSON Schema rather than a defect in this generator, and it
**cannot be fixed** — so it is *published*. Do not attempt to encode the refinements by hand: a
hand-maintained mirror of `superRefine` is precisely the second source of truth this repo removes
wherever it finds one.

- [ ] **Step 1: Write the failing tests**

```ts
it("is byte-identical to what the generator produces, so the checked-in file cannot drift", () => {
  const generated = buildSchema();                       // the same function scripts/build-schema.ts calls
  const onDisk = readFileSync("schema/connector-spec.schema.json", "utf8");
  expect(onDisk).toBe(generated);
});

it("accepts a spec that parseSpec REJECTS — the published gap, pinned so it is known and not discovered", () => {
  // A spec violating a refinement the JSON Schema cannot express: e.g. an argument declaring
  // `default` without `optional: true`, which ToolSchema's refine rejects.
  const violating = { /* ... */ };
  expect(() => parseSpec(violating)).toThrow();
  // and the schema's own required/type rules do not catch it:
  expect(schemaWouldAccept(violating)).toBe(true);
});
```

The second test is the important one. Write `schemaWouldAccept` as a **minimal structural check**
against the generated schema (required keys present, types match) — **not** a full JSON Schema
validator, which would need a dependency this plan does not add. State that limitation in the test's
own comment: it proves the gap exists, it does not measure its full extent.

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Write `scripts/build-schema.ts`**

Export the build as a function so the test and the script share one implementation — the drift test
is worthless if it regenerates by a different path than the script does. `$id` should be the public
URL the schema will live at; `title` and `description` state what it is **and its limit**, in the
schema itself:

> Refinements enforced by `parseSpec` (cross-field rules, reserved identifiers, style-specific
> requirements) cannot be expressed in JSON Schema and are **not** represented here. A spec that
> validates against this schema may still be rejected by the generator.

- [ ] **Step 4: Ship it**

Add `schema` to `package.json`'s `files` array — currently `["src", "README.md"]`, so the schema
would otherwise not reach npm. Add a `schema` script that regenerates it.

**Check the published tarball actually contains it**, rather than trusting the `files` edit:

```bash
npm pack --dry-run 2>&1 | grep -i schema
```
This is the same class of check as `standalone-acceptance --registry`: a `files` array is a claim
about a tarball, and only packing it is evidence.

- [ ] **Step 5: Document it in `README.md`**

How to reference the schema from an editor (`$schema` in the spec file, or the editor's
JSON-schema mapping), **and the limit** — in the same paragraph, not a footnote. A reader who learns
about the schema and not about its gap has been given a false green.

- [ ] **Step 6: Gates and commit**

```bash
bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/ && bun test --coverage
```
```bash
git add schema/ scripts/build-schema.ts package.json test/ README.md
git commit -m "feat(spec): publish a ConnectorSpec JSON Schema, with its limits stated"
```

---

## Task 7: Close Stage F

**Files:**
- Modify: `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md`
- Test: —

- [ ] **Step 1: Close the three Stage F bullets**

`docs/ROADMAP.md`'s Stage F has three open bullets — OpenAPI authoring, better validation errors, and
the JSON Schema — and one already `[x]` (`--from-connector`). Mark what this branch closed, and
**leave open anything that did not close, with its reason.** A bullet that cannot honestly close
stays `[ ]`; a stage marked complete by marking open items done is the one outcome that wastes the
work.

For `--from-openapi`, record what it **cannot** fill — §6.1's list — as a *Known limitations* entry,
naming constructs rather than counts. That list is the honest boundary of the feature and belongs
next to the claim that it exists.

- [ ] **Step 2: Update `docs/ARCHITECTURE.md`**

Add `src/openapi/` to the layout with one line on what it is: the document reader, structured as the
mirror of `src/derive/` — both produce a spec and refuse by name, one from a document and one from
emitted source.

- [ ] **Step 3: Update `CLAUDE.md`'s Layout block**

Add `src/openapi/`. Check the rest of that block against the tree at HEAD while you are there — it
has gone stale twice.

- [ ] **Step 4: Final gates, from a clean tree**

```bash
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
bun test --coverage
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --baseline --nimbus-root C:/gitrep/Nimbus
bun run wiring:conformance --nimbus-root C:/gitrep/Nimbus
bun run acceptance C:/gitrep/Nimbus
```
Report every exit code independently.

- [ ] **Step 5: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs: close Stage F and record what --from-openapi cannot fill"
```

---

## Self-review

**Spec coverage.** Design item 15 is Tasks 1–4; item 16 is Tasks 5 and 6; Task 7 closes the stage.
§6.1's "fills automatically" list maps to Tasks 2 and 3; its "cannot fill at all" list becomes Task
3's placeholders and Task 7's *Known limitations* entry.

**Two design claims were checked and one was false.** `Bun.YAML.parse` and the 59/94 measurement
both hold. `z.toJSONSchema(ConnectorSpecSchema)` does **not** work as the design implies — it throws
— and the option that fixes it also determines the schema's meaning. That is recorded in Task 6
rather than left for an implementer to hit.

**What this plan deliberately does not do.** No emitter path, no spec field, no new dependency, no
`fixtures/` change — so `diff:golden` cannot move and the four locked fixtures cannot be at risk.
`--from-openapi` never writes a package: it prints a spec that has already passed `parseSpec` and
`validateSpec`, and every construct it cannot map is refused by name.

**The honest expectation.** `--from-openapi` fills the mechanical majority of a spec — paths,
methods, arguments, bodies, base URL, network, auth mode — and cannot fill the parts that encode
*Nimbus* conventions rather than API facts: style, sync interval, tool naming, search behaviour, and
the effect of a non-GET operation. The output is a **starting point a human edits**, and the `TODO:`
markers are how it says so. Anyone expecting a finished connector from a document will be
disappointed, and the README should make sure they are not surprised.

---

## Review responses

[`2026-08-07-authoring-from-a-document-review.md`](./2026-08-07-authoring-from-a-document-review.md)
raised five items. **All five are accepted**, which is itself worth noting: every one is a mapping
edge case in the half of the plan that reads a foreign document, and that is exactly where a plan
written from a design's prose under-specifies. Both of the review's factual premises were checked
against `src/spec.ts` before ruling, and both hold.

### R1 — non-identifier path parameter names · **accepted, slugify rather than refuse**

The premise is exact: `ToolSchema` constrains `args` keys with
`/^[A-Za-z_$][A-Za-z0-9_$]*$/` and the message "argument name must be a valid JS identifier", while
`{widget-id}` is ordinary in real documents.

Slugifying is the right call **and it is lossless**, which the review suggested without stating why:
the argument name is spec-internal and never reaches the URL. The path template interpolates the
*value* at that segment's position, so the emitted request is byte-identical whichever name the spec
uses. Refusing would cost real reach for a name nobody observes.

Two guards make it safe, and Task 2 now carries both: the slug must be **injective across the
operation** (two parameters collapsing onto one name refuses, because silently merging them would
drop an argument and send one value where the API expects two), and a slug landing on a
`RESERVED_IDENTIFIERS` entry refuses.

### R2 — missing, empty or templated `servers` · **accepted, refuse in all four cases**

A real gap: the plan said only that *more than one* server refuses. Absent, empty, no `url`, and
server-variable templating are now all refusals by name.

The review offered "refuse or placeholder" and the answer is refuse, for a reason worth writing
down: a placeholder stands in for a **Nimbus convention the document cannot express**, where any
value is provisional and the author knows to set it. A base URL is a **fact the document is supposed
to carry**. Inventing one emits a spec pointing at an endpoint nobody chose, and `network` would then
declare a host the connector never contacts — a placeholder that looks like data.

### R3 — HTTP Basic · **accepted, map it**

The premise is exact: `EnvSchema`'s `auth` enum includes `"basic"`. Refusing a scheme the spec
language natively models would have been a gap in this mapper mistaken for a limit of the generator.

One detail the review could not have known and Task 3 now states: `EnvSchema`'s own refine requires
**exactly two vars** for `auth: "basic"`, so the mapping emits two placeholder var names rather than
one.

### R4 — request-body media type · **accepted**

`requestBody.content` is keyed by media type and the plan never said which to take. Task 2 now
requires `application/json` or a `+json` suffix, and refuses form-encoded and multipart by name —
not as a formatting difference but because `renderBodyExpr` writes `JSON.stringify(...)` and the
fetch helper sends `Content-Type: application/json`, so those are a different request this generator
cannot emit.

### R5 — dangling internal `$ref` · **accepted**

Task 1 covered external refs and cycles and missed the dangling case. It is the one that fails
*quietly*: a missing lookup yields `undefined`, which flows into a mapper as an absent field rather
than an error, and the operation maps with a silently missing schema. Refused at resolution, where
the reference is still in hand to name.
