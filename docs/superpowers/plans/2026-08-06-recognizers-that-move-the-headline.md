# Phase 2a: The Recognizers That Move the Headline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

> **The source is the authority, not this document.** Every listing below was written against
> `main` at `16196d1`. Where a listing disagrees with `src/`, read the source and adapt — and say
> so in your report. Phase 1 shipped with three plan defects found only on contact with the code.

**Goal:** Take `bun run reach`'s headline from **4/94 to 6/94** — `mercury` and `zendesk` — by
recovering the two style fields that gate every other recognizer, accepting a hoisted base const,
and teaching the deriver to read search tools and the two env accessor shapes.

**Architecture:** Four recognizer changes in dependency order. Style recovery goes first because
without it every later recognizer lands at tier `emits` and the headline never moves at all —
measured: stripping `argsSchemaStyle` and `staticPathStyle` from `fixtures/mercury.spec.json`
changes 21 lines of its emitted `src/server.ts`. Then the hoisted base const, which is why ~25
singleton `function:<x>Get` buckets exist. Then search, the widest single recognizer. Then the
split-bearer and `basic` env accessors, which are the last thing `mercury` and `zendesk` need.

**Tech Stack:** Bun 1.3.14, TypeScript, `@babel/parser` (an `optionalDependency`, loaded
dynamically — `await initParser()` before `parseModule`), Biome 2.5.7 via `@biomejs/js-api`, zod 4.

## Global Constraints

- **Bun only.** No Node, npm or pnpm path in this project or its output. Remedy text says `bun add`.
- **Never commit on `main`.** Work on `feat/recognizers-headline`.
- **Conventional Commits.** `feat:` bumps minor, `fix:` patch, `test:`/`refactor:`/`docs:` neither.
- **Byte safety.** `newrelic`, `datadog`, `grafana`, `sentry` must each report **6/6** under
  `bun run diff:golden --nimbus-root C:/gitrep/Nimbus` after every task. **None of the four sets
  `argsSchemaStyle`, `staticPathStyle` or `fetchHelper.baseConst`**, so Tasks 1 and 2 structurally
  cannot move them — verify rather than assume.
- **No `coveragePathIgnorePatterns` entries, and no floor lowered in `bunfig.toml`.** Coverage is
  enforced PER FILE. `src/derive/ast.ts` has ONE line of slack (34 executable lines, 3 uncovered,
  floor tolerates 4) — do not touch that file without saying so.
- **Licensing.** No connector source and no `shared/` source from the AGPL Nimbus monorepo may
  enter this repository — not `src/`, not `test/`, not `fixtures/`. Every test input is generated
  by this repo's own emitter, or hand-written here.
- **`test/derive/round-trip.test.ts` is the guard.** Every fixture stays in exactly one of
  `ROUND_TRIP` / `BLOCKED`, and a `BLOCKED` reason must be checked by actually running
  `deriveSpec`, never inferred from the spec or the emitter.
- **Comments explain WHY** and cite the measurement behind a choice. A comment restating the code
  below it is a defect here.
- **Rejecting is the safe direction.** A rejection is a visible blocker; a wrong claim is a wrong
  number — and since phase 1, also a wrong file on a user's disk via `--from-connector`.

## Verify by exit code, never a pass count, never through a pipe

```bash
bun test --coverage;                    echo "cov_exit=$?"
bunx tsc --noEmit;                      echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;   echo "biome_exit=$?"
```

`cmd | tail; echo $?` reports **`tail`'s** status. That masked a real regression during phase 1 —
a coverage gate stayed red for two commits because a pass count was read as a passing gate.

## The corpus is a moving target — read this before Task 3

`bun run reach --baseline` currently **exits 2**: `fixtures/reach-baseline.json` records
`packages/mcp-connectors` tree `e3751a3a` and the checkout is at `ec2b4e01`. That is the gate
working, not a defect. **Do not re-baseline to silence it** — that is phase 2b's item 14.

The move was real and it changed a recognizer's target: upstream commit `b3a6f159`
(*"make connectors spawnable from a compiled binary"*) refactored ten connectors from
`if (import.meta.main) { await runReadOnlyMcpConnector(…) }` to a
`export async function startConnector(): Promise<void>` wrapper plus
`if (import.meta.main) await startConnector();`. **Zero** corpus connectors still use the old
block form. That retargeting belongs to phase 2b, but it is why every task below re-measures the
histogram rather than trusting a count written down earlier.

---

## File Structure

| file | responsibility | task |
| --- | --- | --- |
| `src/derive/server/path-template.ts` | `recognizePath` also reports which branch matched | 1 |
| `src/derive/server/args.ts` | `recognizeArgs` also reports inline-vs-expanded evidence | 1 |
| `src/derive/index.ts` | connector-wide votes for both style fields; assembles the spec | 1 |
| `src/derive/server/fetch-helper.ts` | `reconstructBase` and `matchRestUrlConst` accept a hoisted base | 2 |
| `src/derive/search-filter.ts` | **new** — inverts `src/emit/search-filter.ts`, with its own totality rule | 3 |
| `src/derive/server/search.ts` | **new** — inverts `src/emit/server/search.ts` | 3 |
| `src/derive/index.ts` | `SourceFiles` gains an optional `filter` member | 3 |
| `src/derive/from-connector.ts`, `scripts/_lib/reach.ts` | both supply the filter file | 3 |
| `src/derive/server/env.ts` | split-bearer pair, `auth: "basic"`, the `trimTrailingSlash` claim | 4 |

---

## Task 1: Recover `staticPathStyle` and `argsSchemaStyle`

**The multiplier.** `deriveSpec` emits neither field today, so a derived `mercury` regenerates a
`src/server.ts` that differs by 21 lines. Every recognizer in Tasks 2–4 lands at `emits` without
this. It is also the cheapest of the four: both discriminators already exist and are discarded.

**Files:**
- Modify: `src/derive/server/path-template.ts` — `recognizePath`
- Modify: `src/derive/server/args.ts` — `recognizeArgs`
- Modify: `src/derive/index.ts` — the two votes, and the spec assembly
- Test: `test/derive/style-recovery.test.ts` (new), `test/derive/path-template.test.ts`

**Interfaces:**
- Consumes: `AstNode` from `src/derive/ast.ts`, which **already exposes**
  `readonly loc?: { start: { line: number } }` — verified; no change to `ast.ts` is needed, and it
  has only one line of coverage slack so do not touch it.
- Produces:
  - `recognizePath` returns `{ path: string; staticStyle?: "quoted" | "template" } | undefined`
  - `recognizeArgs` returns its existing record plus `schemaStyle?: "inline" | "expanded"`
  - the derived spec carries `argsSchemaStyle` and `fetchHelper.staticPathStyle` **only when the
    vote is decisive**, so the schema defaults apply otherwise

- [ ] **Step 1: Confirm the two discriminators exist before changing anything**

```bash
grep -n "stringLit\|templateLiteral" src/derive/server/path-template.ts | head -4
sed -n '/export type AstNode/,/};/p' src/derive/ast.ts
grep -n "staticStyle" src/emit/server/path-template.ts
```

Expected: `recognizePath` calls `stringLit` **before** `templateLiteral` (the branches are already
separated); `AstNode` exposes `loc`; and the emitter's `staticStyle` docstring says it *"has no
effect on a path with any dynamic segment."* **If any of those is false, stop and report** — the
whole task rests on them.

- [ ] **Step 2: Write the failing test**

Create `test/derive/style-recovery.test.ts`. Build every input by emitting it, so the test reads
bytes this repo produced rather than a guess at them:

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { deriveSpec } from "../../src/derive/index.ts";

beforeAll(async () => {
  await initFormatter();
  await initParser();
});

/** The emitted src/server.ts and nimbus.extension.json for a raw spec object. */
function emitted(raw: unknown): { server: string; manifest: string } {
  const files = formatAll(generate(parseSpec(raw)));
  const pick = (p: string): string => {
    const f = files.find((x) => x.path.join("/") === p);
    if (f === undefined) throw new Error(`no ${p} emitted`);
    return f.content;
  };
  return { server: pick("src/server.ts"), manifest: pick("nimbus.extension.json") };
}

const BASE_SPEC = {
  name: "zzstyle",
  displayName: "ZZ Style",
  description: "Fixture for style recovery.",
  serviceLabel: "ZZ Style",
  style: "hand-rolled",
  env: [{ vars: ["ZZSTYLE_TOKEN"], local: "headers", auth: "bearer", required: true }],
  fetchHelper: { local: "zzGet", base: "https://api.zzstyle.test", headers: "headers" },
  tools: [
    {
      name: "zzstyle_item_get",
      description: "Get one item.",
      impl: "rest",
      path: "/v1/items/x",
      args: { itemId: { type: "string", min: 1 } },
    },
  ],
};

describe("style recovery", () => {
  it("recovers staticPathStyle: template", () => {
    const raw = { ...BASE_SPEC, fetchHelper: { ...BASE_SPEC.fetchHelper, staticPathStyle: "template" } };
    const d = deriveSpec(emitted(raw));
    expect(d.ok).toBe(true);
    if (d.ok) expect((d.spec["fetchHelper"] as Record<string, unknown>)["staticPathStyle"]).toBe("template");
  });

  it("OMITS staticPathStyle when the emitter used the quoted default", () => {
    // Omitted, not "quoted": the schema default already supplies it, and emitting it would make
    // every derived spec differ from the hand-written fixtures for no behavioural reason.
    const d = deriveSpec(emitted(BASE_SPEC));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.spec["fetchHelper"]).not.toHaveProperty("staticPathStyle");
  });

  it("recovers argsSchemaStyle: expanded", () => {
    const d = deriveSpec(emitted({ ...BASE_SPEC, argsSchemaStyle: "expanded" }));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.spec["argsSchemaStyle"]).toBe("expanded");
  });

  it("OMITS argsSchemaStyle when the emitter used the inline default", () => {
    const d = deriveSpec(emitted(BASE_SPEC));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.spec).not.toHaveProperty("argsSchemaStyle");
  });

  it("abstains on staticPathStyle when every path is dynamic", () => {
    // src/emit/server/path-template.ts: staticStyle "has no effect on a path with any dynamic
    // segment". A connector whose every path interpolates an arg therefore carries NO evidence,
    // and guessing would be a wrong claim. Omit and let the default apply.
    const dynamic = {
      ...BASE_SPEC,
      fetchHelper: { ...BASE_SPEC.fetchHelper, staticPathStyle: "template" },
      tools: [
        {
          name: "zzstyle_item_get",
          description: "Get one item.",
          impl: "rest",
          path: "/v1/items/${arg.itemId|enc}",
          args: { itemId: { type: "string", min: 1 } },
        },
      ],
    };
    const d = deriveSpec(emitted(dynamic));
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.spec["fetchHelper"]).not.toHaveProperty("staticPathStyle");
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
bun test test/derive/style-recovery.test.ts
```

Expected: FAIL — neither field is on the derived spec.

- [ ] **Step 4: Report the branch from `recognizePath`**

`recognizePath` currently returns `string | undefined`, and both branches return a string, so
which one fired is discarded. Widen the return so the caller can see it. Change its signature to
return `{ path: string; staticStyle?: "quoted" | "template" } | undefined`:

- the `stringLit` branch reports `staticStyle: "quoted"`
- the `templateLiteral` branch reports `staticStyle: "template"` **only when the template has no
  expressions** (`t.expressions.length === 0`) — a template with placeholders is forced regardless
  of the spec field and is therefore not evidence
- every other case leaves `staticStyle` absent

Update its call sites — `grep -rn "recognizePath(" src/derive/` — to destructure `path`.

- [ ] **Step 5: Report inline-vs-expanded from `recognizeArgs`**

An inline `z.object({ id: … })` has its object literal and its first property on the **same
line**; the expanded form does not. `AstNode` already exposes `loc.start.line`. Add an accessor to
`src/derive/read.ts` beside the existing ones — do **not** read `loc` directly at the call site,
because `read.ts` is the only module permitted to reach a node's fields:

```ts
/** The 1-based source line a node starts on, or undefined when the parser omitted `loc`. */
export function startLine(node: AstNode | undefined): number | undefined {
  return node?.loc?.start.line;
}
```

Then have `recognizeArgs` compare the `z.object(...)` argument's line against its first property's
line, reporting `"inline"` when equal and `"expanded"` when not. **A tool with zero args carries no
evidence** — report nothing.

- [ ] **Step 6: Add the two connector-wide votes**

Both fields are connector-wide (`ConnectorSpecSchema.argsSchemaStyle`,
`FetchHelperSchema.staticPathStyle`), so the value comes from the SET of tools, not any one.

In `src/derive/index.ts`, add one helper used by both:

```ts
/**
 * The single value every tool that carries evidence agrees on, or undefined.
 *
 * Abstentions are expected and are not a failure: a tool whose path is dynamic carries no
 * staticPathStyle evidence (the emitter's own docstring: staticStyle "has no effect on a path
 * with any dynamic segment"), and Biome re-wraps an over-long inline z.object, so a long-arg tool
 * carries no argsSchemaStyle evidence either. Silence is not a vote. DISAGREEMENT, on the other
 * hand, is a shape the emitter cannot produce — it writes one value per connector — so it must
 * refuse rather than pick a winner.
 */
function unanimous<T>(votes: readonly (T | undefined)[]): T | undefined {
  const cast = votes.filter((v): v is T => v !== undefined);
  if (cast.length === 0) return undefined;
  const [first] = cast;
  return cast.every((v) => v === first) ? first : undefined;
}
```

Emit each field **only when the vote is decisive AND differs from the schema default** — `"quoted"`
for `staticPathStyle`, `"inline"` for `argsSchemaStyle`. Emitting a default-valued field would make
every derived spec differ from the hand-written fixtures for no behavioural reason.

**Disagreement must block, not silently pick.** If `unanimous` returns undefined because tools
disagreed (as opposed to all abstaining), that is a module the emitter cannot have produced.
Distinguish the two cases and return `blocked("style:mixed-<field>", …)` for disagreement.

- [ ] **Step 7: Run the gates**

```bash
bun test --coverage;                                    echo "cov_exit=$?"
bunx tsc --noEmit;                                      echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;                   echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus --verbose > /tmp/reach-t1.txt
```

Expected: all `0`; the four fixtures each **6/6** (none sets either field, so they cannot move);
headline still **4/94** — this task unblocks nothing on its own, it makes later tasks able to.
Keep `/tmp/reach-t1.txt`; Tasks 2–4 diff against it.

- [ ] **Step 8: Commit**

```bash
git add src/derive/ test/derive/ && git commit -m "feat(derive): recover argsSchemaStyle and staticPathStyle

Neither field was derived, so a derived mercury regenerated a src/server.ts differing by 21
lines and every recognizer downstream would have landed at tier \`emits\`. Both discriminators
already existed and were discarded: recognizePath calls stringLit before templateLiteral, and
AstNode already exposes loc.start.line.

Both votes tolerate abstention — a dynamic path carries no staticPathStyle evidence, and Biome
re-wraps an over-long inline z.object — but refuse on DISAGREEMENT, which is a module the
emitter cannot have written. Each field is emitted only when it differs from the schema
default, so a derived spec stays byte-comparable with the hand-written fixtures."
```

---

## Task 2: Accept a hoisted base const

`reconstructBase` requires every non-final template expression to be a **zero-argument call** (an
env accessor). A hoisted base makes it an `Identifier` — `` `${BASE}${path}` `` — so `callArgs`
returns `undefined`, the whole helper is refused, and the connector's fetch helper surfaces as its
own `function:<x>Get` bucket. That single rejection is why ~25 singleton buckets and ~33 of the 37
`statement:VariableDeclaration` entries exist.

The exact blocking lines, from `src/derive/server/fetch-helper.ts`:

```ts
const args = callArgs(expressions[i]);
if (args?.length !== 0) return undefined;
const name = identName(calleeOf(expressions[i]));
```

**Files:**
- Modify: `src/derive/server/fetch-helper.ts` — `reconstructBase`, and its rest-kit twin
  `matchRestUrlConst`
- Test: `test/derive/fetch-helper.test.ts`

**Interfaces:**
- Consumes: `constDecl` and the string-literal accessor from `src/derive/read.ts`.
- Produces: `FetchHelperFields` gains `baseConst?: string`, set only when the base was hoisted.

- [ ] **Step 1: Write the failing test**

Add to `test/derive/fetch-helper.test.ts`, generating the input from a spec that sets `baseConst`:

```ts
it("accepts a hoisted base const and records fetchHelper.baseConst", () => {
  const raw = {
    name: "zzhoist",
    displayName: "ZZ Hoist",
    description: "Fixture for a hoisted base.",
    serviceLabel: "ZZ Hoist",
    style: "hand-rolled",
    env: [{ vars: ["ZZHOIST_TOKEN"], local: "headers", auth: "bearer", required: true }],
    fetchHelper: {
      local: "zzGet",
      base: "https://api.zzhoist.test",
      baseConst: "ZZ_API",
      headers: "headers",
    },
    tools: [
      { name: "zzhoist_item_list", description: "List items.", impl: "rest", path: "/v1/items", args: {} },
    ],
  };
  const d = deriveSpec(emitted(raw));
  expect(d.ok).toBe(true);
  if (d.ok) {
    const fh = d.spec["fetchHelper"] as Record<string, unknown>;
    expect(fh["baseConst"]).toBe("ZZ_API");
    expect(fh["base"]).toBe("https://api.zzhoist.test");
  }
});

it("refuses an identifier that does not resolve to a module-scope string const", () => {
  // Resolving loosely would INVENT a base, and a connector that requests the wrong host is a
  // worse outcome than a visible blocker. The identifier must resolve to `const X = "literal"`
  // in the same module or the helper is refused.
  const server = [
    'const ZZ_API = someExpression();',
    'async function zzGet(path: string): Promise<unknown> {',
    '  const res = await fetch(`${ZZ_API}${path}`);',
    '  return res.json();',
    "}",
  ].join("\n");
  expect(recognizeFetchHelper(parseModule(server), createClaimSet())).toBeUndefined();
});
```

Reuse the file's existing `emitted` helper if it has one; otherwise copy Task 1's.

- [ ] **Step 2: Run it and confirm it fails**

```bash
bun test test/derive/fetch-helper.test.ts
```

Expected: FAIL — the hoisted-base case returns `undefined`.

- [ ] **Step 3: Resolve an Identifier against a module-scope string const**

`reconstructBase` needs the module's statements to resolve against, which it does not currently
receive. Thread them in from `recognizeFetchHelper` (which already has them) rather than
re-parsing. In the expression loop, before requiring a call:

- if `identName(expressions[i])` is defined, look for a top-level `const <name> = "<literal>"`
  among the statements; on success push the literal's text and record the const's name as
  `baseConst`
- only if that fails, fall through to the existing zero-argument-call path
- if neither matches, refuse as today

**Claim the const's statement.** The `const ZZ_API = "…"` declaration is a top-level statement, so
the totality rule will report it as unclaimed unless the fetch helper claims it — and an
unclaimed-statement blocker on a connector this task is meant to unblock would waste the whole
change. Verify with a test that the derivation succeeds end to end, not just that
`recognizeFetchHelper` returns fields.

Apply the same resolution to `matchRestUrlConst`, whose comment currently records that it refuses
`` `${baseConst}${path}` ``. Update that comment; leaving it would be a false statement in a file
whose comments carry reasoning.

- [ ] **Step 4: Run the gates and diff the histogram**

```bash
bun test --coverage;                                    echo "cov_exit=$?"
bunx tsc --noEmit;                                      echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;                   echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus --verbose > /tmp/reach-t2.txt
diff /tmp/reach-t1.txt /tmp/reach-t2.txt
```

Expected: all `0`; four fixtures **6/6** (none sets `baseConst`). The histogram **should** move —
`function:<x>Get` singletons and `statement:VariableDeclaration` entries should fall. Record the
exact delta in the commit message; a change here is the point of the task, and an *unchanged*
histogram means the fix did not take.

- [ ] **Step 5: Commit**

```bash
git add src/derive/ test/derive/ && git commit -m "fix(derive): accept a hoisted base const in the fetch-helper recognizers

reconstructBase required every non-final template expression to be a zero-argument call, so
\`\${BASE}\${path}\` failed callArgs() and the entire helper was refused — which is why ~25
singleton function:<x>Get buckets and ~33 statement:VariableDeclaration entries existed.

An identifier now resolves against a module-scope \`const X = \"literal\"\` and records
fetchHelper.baseConst; anything else is still refused, because resolving loosely would invent a
base and a connector requesting the wrong host is worse than a visible blocker. The const's own
statement is claimed, or the totality rule would re-block the connectors this unblocks.

Histogram delta: <paste the measured diff>"
```

---

## Task 3: The `search` and `search-filter` recognizers

The widest single recognizer: 39 connectors block on `import-from:./search-filter.ts` and 36 on
`import-from:../../shared/mcp-search-tool.ts`. It is also the first task needing a **second input
file**.

**Files:**
- Create: `src/derive/server/search.ts` — inverts `src/emit/server/search.ts`
- Create: `src/derive/search-filter.ts` — inverts `src/emit/search-filter.ts`
- Modify: `src/derive/index.ts` — `SourceFiles` gains `filter?: string`; dispatch to the search
  recognizer
- Modify: `src/derive/from-connector.ts:110` and `scripts/_lib/reach.ts:98` — both supply it
- Test: `test/derive/search.test.ts`, `test/derive/search-filter.test.ts`, and
  `test/derive/round-trip.test.ts` (fixtures move lists)

**Interfaces:**
- Consumes: `ToolFields` from `src/derive/server/tools-hand.ts` (which since phase 1 carries an
  optional `method`, omitted for GET).
- Produces:
  - `SourceFiles = { server: string; manifest: string; filter?: string }`
  - `recognizeSearchTool(call, helperLocal)` → the tool's spec fields including
    `impl: "search"`, `rows?`, `maxLimit`, `filter.export`
  - `recognizeSearchFilter(source)` → `{ export: string; fields?: FieldEntry[] } | undefined`

- [ ] **Step 1: Read both emitters first — they are the authority**

```bash
sed -n '1,80p' src/emit/server/search.ts
sed -n '1,120p' src/emit/search-filter.ts
```

`renderSearchTool` writes exactly two handler shapes (with and without `rows`) and two schema
forms (`searchToolInputSchema(N)` when the tool has no args of its own, an inlined merged
`z.object` when it does). `emitSearchFilter` computes its import list from the body. **Do not
transcribe these into the recognizer from memory — invert what the file actually writes.**

- [ ] **Step 2: Widen `SourceFiles` and supply the file at both call sites**

```ts
export type SourceFiles = { server: string; manifest: string; filter?: string };
```

`src/derive/from-connector.ts` reads `src/search-filter.ts` beside the two files it already reads,
passing `undefined` when absent. `scripts/_lib/reach.ts` already reads every connector file into a
map — supply it from there.

**An absent filter file plus a recognized search tool is a BLOCKER, not a silent omission.** A
search tool whose filter cannot be read must not derive a spec that regenerates a connector with a
different filter.

- [ ] **Step 3: Write the failing tests**

`test/derive/search.test.ts` must cover, each built by emitting a spec:

- a search tool with `rows` → recovers `rows`, `maxLimit`, `filter.export`
- a search tool without `rows` → recovers the same minus `rows`
- a search tool with its own args (the inlined merged `z.object` schema form)
- **a refusal**: a handler whose fetch callee is not the recognized helper
- **a refusal**: `matchesResult`'s third argument is not the handler's parameter

`test/derive/search-filter.test.ts` must cover the keyed form, the extractor form over the four
shared primitives, the throwing stub, and **an import-list mismatch** — the recognizer computes
the import list the emitter *would* have written and requires the file's actual imports to match
by name set, module split and order. A mismatch is a blocker naming the discrepancy.

- [ ] **Step 4: Implement, honouring the traps**

Each of these has cost time before and is not optional:

- **Exclude search tools from `recognizeTools`' `handlerStyle` vote.** `renderSearchTool` always
  writes a hoist-free block, so counting it would force `handlerStyle: "block"` on the whole
  connector.
- **Cross-check the awaited callee against the recognized `fetchHelper.local`**, as
  `recognizeTools` has done since phase 1.
- **Claim the two search imports only after a search tool is positively recognized**, the same
  scoping `recognizeReadOnlyFrame` uses — otherwise a non-search module could have an unrelated
  import claimed.
- **`src/derive/search-filter.ts` gets its OWN totality rule** over the filter file's statements.
  The same discipline, applied to the second file rather than assumed away.
- **Model only what the emitter writes**: `asObjectish` (never `asRecord`), a
  `function fieldsOf(item: unknown)` declaration (never an arrow with a type annotation), and no
  doc comment. Those are the gaps *Known limitations* records as the reason almost none of the
  expressible corpus files byte-match; a recognizer accepting them would claim files the emitter
  cannot reproduce.

- [ ] **Step 5: Move the freed fixtures between the round-trip lists**

`test/derive/round-trip.test.ts` holds `ROUND_TRIP` and `BLOCKED`, and asserts every fixture sits
in exactly one. **Check each move by running `deriveSpec` against the fixture's emitted output** —
never by inferring from the spec. Two earlier versions of that docstring went stale exactly that
way. Fixtures currently blocked on "search tool": `bitrise`, `dependencytrack`, `mercury`,
`netlify`, `zendesk`, `zzextract`, `zzsearch`, `zzsearchstub`. Some will still block for other
reasons — move only those that actually round-trip, and update each remaining `BLOCKED` reason to
the blocker `deriveSpec` now really reports.

- [ ] **Step 6: Run the gates and diff the histogram**

```bash
bun test --coverage;                                    echo "cov_exit=$?"
bunx tsc --noEmit;                                      echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;                   echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus --verbose > /tmp/reach-t3.txt
diff /tmp/reach-t2.txt /tmp/reach-t3.txt
```

Expected: all `0`; four fixtures **6/6** (none declares a search tool). The two search import
buckets should fall substantially. The headline may still be 4/94 — Task 4 is what completes
`mercury` and `zendesk`.

- [ ] **Step 7: Commit**

```bash
git add src/derive/ test/derive/ scripts/_lib/reach.ts && git commit -m "feat(derive): read search tools and their filter file

39 connectors blocked on import-from:./search-filter.ts and 36 on the shared mcp-search-tool
import, though the emitter has written both since Stage D. SourceFiles gains an optional filter
member, supplied at both call sites; an absent filter file alongside a recognized search tool is
a blocker rather than a silent omission.

src/derive/search-filter.ts carries its own totality rule over the second file, and recomputes
the import list the emitter would have written rather than waving the preamble through — which
turns the imports into a cross-check on the body recognition instead of an obstacle.

Histogram delta: <paste the measured diff>"
```

---

## Task 4: The split-bearer and `basic` env accessors, and the `trimTrailingSlash` claim

The last thing `mercury` and `zendesk` need. `function:authHeader` is 23 connectors and
`function:trimTrailingSlash` is 9.

**Files:**
- Modify: `src/derive/server/env.ts` — `recognizeEnv` / `recognizeOne`
- Test: `test/derive/env.test.ts`

**Interfaces:**
- Produces: env entries carrying `tokenLocal` (split-bearer) and `auth: "basic"`, plus a claim on
  the emitted `trimTrailingSlash` helper.

- [ ] **Step 1: Read `renderSplitBearer`'s docstring before anything else**

```bash
sed -n '/renderSplitBearer/,/^}/p' src/emit/server/env.ts
```

That docstring **is the membership list** — it enumerates which corpus connectors are out of
scope. Scope this task to what it says the emitter writes. `intercom` (a third header) and `lever`
(Basic over one var with an empty password) are named as OUT; do not widen to catch them.

- [ ] **Step 2: Confirm the wrongly-claimed hazard, then write the failing test**

The split-bearer shape is a **pair** of functions. `recognizeEnv` currently claims the inner
reader as a standalone plain entry, and only the unclaimed wrapper stops a wrong spec today.
Verify that by reading the code, and say in your report whether it holds.

If it does: the recognizer must consume **both** functions into **one** entry. Claiming the inner
one separately while also claiming the pair would be a double claim; claiming only the pair while
the inner stays separately claimed is the wrongly-claimed class the totality rule cannot see.

- [ ] **Step 3: Implement, and gate the `trimTrailingSlash` claim**

Claim the emitted `trimTrailingSlash` helper **only when an env entry actually carries
`transform: "trimTrailingSlashFn"`**, and match the emitted constant's text rather than the
function's name — a connector with a same-named helper doing something else must not be claimed.

- [ ] **Step 4: Run the gates — this is where the headline moves**

```bash
bun test --coverage;                                    echo "cov_exit=$?"
bunx tsc --noEmit;                                      echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;                   echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus --verbose > /tmp/reach-t4.txt
diff /tmp/reach-t3.txt /tmp/reach-t4.txt
```

Expected: all `0`; four fixtures **6/6**; **headline 4/94 → 6/94**, the two new entries being
`mercury` and `zendesk`.

**If the headline does not move, do not adjust anything to force it — report.** `mercury` and
`zendesk` are the two the design predicted, and a different result is information about the corpus
worth more than a matching number. `fixtures/expectations.json` already lists `src/server.ts` for
both, so `diff:golden` proves the emitter can reproduce them from a hand-written spec; if the
deriver still cannot produce that spec, the remaining gap is the finding.

- [ ] **Step 5: Commit**

```bash
git add src/derive/ test/derive/ && git commit -m "feat(derive): read the split-bearer and basic env accessors

function:authHeader was 23 connectors and function:trimTrailingSlash 9, though renderSplitBearer
and renderBasic have emitted both shapes since Stage C. The split-bearer pair is consumed into
ONE entry: recognizeEnv previously claimed the inner reader as a standalone plain entry, and only
the unclaimed wrapper stopped a wrong spec — the wrongly-claimed class the totality rule is
structurally blind to.

The trimTrailingSlash claim is gated on an entry actually carrying transform:
\"trimTrailingSlashFn\" and matches the emitted constant rather than the function name.

Scoped to renderSplitBearer's own docstring, which is the membership list: intercom (a third
header) and lever (Basic over one var with an empty password) stay out.

REACH 4/94 -> 6/94 (mercury, zendesk)"
```

---

## Phase Exit Criteria

```bash
bun install
bun test --coverage;                                        echo "cov_exit=$?"
bunx tsc --noEmit;                                          echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;                       echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus
bun run wiring:conformance --nimbus-root C:/gitrep/Nimbus;  echo "wiring_exit=$?"
```

- Every exit code `0`.
- `newrelic`, `datadog`, `grafana`, `sentry` each **6/6**.
- **`reach` reports 6/94**, the two new entries being `mercury` and `zendesk`.
- Every fixture in exactly one of `ROUND_TRIP` / `BLOCKED`, every `BLOCKED` reason re-checked by
  running `deriveSpec` rather than inferred.
- `reach --baseline` still exits 2 — **that is correct here.** Re-baselining is phase 2b's item 14.

---

## Self-Review

**Spec coverage.** Design §5 item 6 → Task 1. Item 7 → Task 2. Item 8 → Task 3. Item 9 → Task 4.
Items 10–14 are **deliberately deferred to plan 2b** (`query`/`body`/`client-credentials`, both
case-2 widenings, blocker-label honesty, re-baseline and closing Stage E) — stated in this plan's
opening rather than left implicit, because the design lists nine items and this plan has four.

**Deviation from the design, recorded.** The design's item 13 targets
`frame:readonly-callback-not-inline` (10 connectors). Upstream commit `b3a6f159` refactored those
ten to a `startConnector()` wrapper and **zero** corpus connectors retain the old shape, so that
item must be retargeted before it is planned. It belongs to 2b, and 2b must re-measure rather than
inherit the design's count.

**Placeholder scan.** No `TBD`, no "add error handling", no "similar to Task N". Tasks 3 and 4
give contracts, traps and the exact files to read rather than transcribing `renderSearchTool`,
`emitSearchFilter` and `renderSplitBearer` — those are 60–120-line emitter functions in this
repository, and copying them into a plan duplicates the authority and goes stale. Every step names
the exact function to invert and every shape to refuse.

**Type consistency.** `recognizePath`'s widened return is introduced in Task 1 and consumed by
Task 3's path handling under the same shape. `SourceFiles` is widened once, in Task 3, and both
production call sites are named. `FetchHelperFields.baseConst` is introduced in Task 2 and read
nowhere else. `startLine` is added to `read.ts` in Task 1 and used only there.

**Known risk.** Task 4's headline claim (4→6) is a prediction, and the plan says explicitly not to
force it. The corpus moved once already during phase 1's execution; it can move again.
