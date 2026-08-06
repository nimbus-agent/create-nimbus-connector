# Phase 2b: The Honest Histogram — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the recognizer set (`query`, `body`, `client-credentials`, the stub handler), widen two
recognizers under the case-2 rule (the rows pluck, the three frame idioms), make every blocker label
say what actually stopped the connector, then re-baseline and close Stage E.

**Architecture:** Every change is in `src/derive/` — the inverse of `src/emit/`, one recognizer module
per emitter module. Two new modules (`src/derive/server/query.ts`, `src/derive/server/body.ts`) invert
`src/emit/server/query.ts` and `src/emit/server/body.ts`. `src/derive/server/env.ts` grows the
client-credentials shape; `src/derive/server/search.ts` grows the hoisted rows pluck;
`src/derive/server/index.ts` grows three frame idioms and two honest labels. **`src/emit/` is not
touched by any task in this plan**, and `fixtures/expectations.json` is edited only by Task 4, which
adds a new synthetic fixture entry (never to relax an existing one).

**Tech Stack:** TypeScript, Bun (`bun test`, `bunx tsc --noEmit`), Biome 2.5.7, `@babel/parser` (an
`optionalDependency`, loaded dynamically through `src/derive/ast.ts`), zod.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **The licensing boundary is absolute.** `create-nimbus-connector` is MIT; the Nimbus monorepo is
  AGPL-3.0-only. **No connector source and no `shared/` source may be copied into this repository** —
  not into `src/`, not into `test/`, not into `fixtures/`. The one carve-out is connector
  *description strings* in the eleven real-connector fixtures. Every test input in this plan is either
  this repo's own emitter output or a hand-synthesized module. Reading the corpus to design a matcher
  is expected; transcribing it is not.
- **Bun-only.** No Node, npm or pnpm path in this project or its output.
- **The byte-safety invariant.** `newrelic`, `datadog`, `grafana` and `sentry` reproduce **6/6** files
  byte-for-byte and must stay there. After every task, `bun run diff:golden --nimbus-root
  C:/gitrep/Nimbus` must still report all four at `6/6`.
- **Never edit `fixtures/expectations.json` to hide a mismatch.** A fixture that cannot match a file
  omits it so the gap is on screen on every run.
- **The totality rule has no escape hatch.** After every matcher runs, every top-level and
  function-body statement in `src/server.ts` must be covered by a claim. An unclaimed statement fails
  the connector.
- **`AstNode` has no index signature.** Every node field read goes through a guarded accessor in
  `src/derive/read.ts`, and `bunx tsc --noEmit` is what enforces it. **Reaching a field with no
  accessor means adding an accessor to `read.ts`** — never a cast at the call site. Accessors return
  `undefined` rather than throwing. There is deliberately no generic `getChildren`.
- **Claims are byte ranges; coverage is containment.** A matcher may claim several statements at once,
  and a statement is covered when its range lies inside a claimed range. This is why a matcher must
  never claim a statement that *nests* registrations — see the two-list frame contract in
  `src/derive/server/frame.ts`.
- **Labels may be more permissive than claims.** `frameFailureKind` and `blockerFor` only name a
  bucket; a wrong label misdescribes a bucket, a wrong claim misdescribes what the emitter can
  reproduce. Only the latter is the defect this codebase guards against.
- **The case-2 rule.** A recognizer may claim a shape the emitter does *not* write only when both
  hold: **(a)** the divergence is already recorded in `docs/ROADMAP.md`'s *Known limitations* or
  *Considered and declined*, and **(b)** a test proves every spec field recovered from that shape is
  correct. Condition (b) is not optional. Tasks 9 and 11 are the only case-2 tasks in this plan; every
  other task matches only what the emitter writes.
- **Coverage floors are per-file**, not aggregate (`bunfig.toml`). `src/cli.ts` and `src/prompts.ts`
  are excluded because they are driven through `Bun.spawnSync`. Do not "raise coverage" with
  in-process tests duplicating the subprocess ones. A new `src/derive/` module needs its own test file
  meeting the floor.
- **Emitters return UNFORMATTED source.** `generate()` is pure; output goes through `formatAll()`,
  which runs the real Biome. Never hand-align indentation. Do hand-manage line breaks.
- **Comments explain why**, and cite the corpus measurement behind a choice where one exists. Match
  the surrounding density — this codebase's comments carry reasoning, not restatement.
- **Never commit on `main`.** Work on the branch. **Conventional Commits** drive release-please: a
  `feat:` bumps the minor, `fix:` the patch.
- **Before claiming a deriver change works, run it.** "Generated and it looked right" is not
  verification.

### The gate order, and which gates can lie

| Command | What it proves | Needs |
| --- | --- | --- |
| `bun test` | Unit + emitted-source typecheck | — |
| `bunx tsc --noEmit` | This repo typechecks — **the `read.ts` guard is a TYPE rule** | — |
| `bunx biome check src/ test/ scripts/` | This repo lints | — |
| `bun test --coverage` | Per-file floors | — |
| `bun run diff:golden --nimbus-root C:/gitrep/Nimbus` | Emitted bytes match real connectors | Nimbus checkout |
| `bun run reach --nimbus-root C:/gitrep/Nimbus` | Corpus tier histogram | Nimbus checkout |
| `bun run reach --verbose --nimbus-root C:/gitrep/Nimbus` | The connectors behind each bucket | Nimbus checkout |
| `bun run wiring:conformance --nimbus-root C:/gitrep/Nimbus` | The wiring skeleton still matches Nimbus | Nimbus checkout |

**Report exit codes, not the tail of the output.** `cmd | tail; echo $?` reports `tail`'s status, not
`cmd`'s. Phase 2a shipped two commits with a red coverage gate reported as green for exactly this
reason. Run each gate so its own exit code is the thing you read.

`bun run reach --baseline` currently **exits 2** and that is the gate working: the corpus tree moved
to `ec2b4e01` while `fixtures/reach-baseline.json` records `e3751a3a`. **Do not re-baseline before
Task 12.** Re-baselining early to silence the refusal destroys the only signal that would catch a
corpus move mid-branch — which is not hypothetical: it fired once already, during phase 2a.

---

## The measurement this plan is written against

Taken at `c04fd2b` (v0.9.0) against the Nimbus checkout at `packages/mcp-connectors` tree `ec2b4e01`.

```
REACH  6/94  (server.ts byte-identical)
  spec derived + emits   6/94
  server.ts identical    6/94   <- headline
  all files identical    4/94
```

The six fixtures that do not round-trip, with the blockers `deriveSpec` **actually reports** (measured
by emitting each fixture and reading it back, not inferred):

| fixture | blockers reported |
| --- | --- |
| `discord` | 4 × `call:registerDiscordTool` |
| `google-meet` | 3 × `call:registerGoogleMeetTool` |
| `zzwriterest` | 2 × `call:registerZzwriterestTool` |
| `zzwriteonly` | `function:zzGetSend`, 1 × `call:reg` |
| `bitrise` | `import-from:../../shared/mcp-search-tool.ts`, `import-from:./search-filter.ts`, 3 × `call:reg` |
| `zzwrite` | `statement:VariableDeclaration` ×2 (`let cachedToken`, `let tokenExpiresAt`), `function:token`, `function:authHeaders`, `function:zzwriteGet`, `function:zzwriteGetSend`, 3 × `call:reg` |

Tasks 3–8 clear these six. **When Task 8 lands, `BLOCKED` in
`test/derive/round-trip.test.ts` is empty and all 21 fixtures round-trip** — that is this plan's
sharpest deliverable, and it is checkable without an AGPL checkout.

### What this plan does *not* promise about the corpus number

Task 11 widens three frame idioms covering **27** corpus connectors (13 + 4 + 10). Those connectors
have never been measured past their frame. **The expected result is that the histogram grows new
buckets, not that `blocked` falls by 27.** The design says this in *Known risks* — "the frame widening
reveals rather than clears" — and it is repeated here so a bigger histogram at the end is not read as a
regression. Record the new numbers; do not predict them.

### Tasks 3–8 close the inverse, not the corpus gap — measured, and stated before the work starts

A corpus sweep taken 2026-08-06 against tree `ec2b4e01` found that **the three constructs item 10 names
are written differently by every corpus connector that has them.** Each of Tasks 3–8 closes a fixture
round trip and is expected to move **no** corpus connector.

| construct | what the corpus carries | consequence |
| --- | --- | --- |
| **query** | 10 connectors write `new URL(...)`, always inside a rest-kit path-builder lambda. The tail is `` `${u.pathname}${u.search}` `` (7) or `u.toString()` (gitlab, 4 sites); `append` appears in a `for…of` (pagerduty, gmail). **`` const path = `${u}` `` — the hand-rolled tail this generator emits — appears zero times.** A separate, non-overlapping set of 22 connectors builds queries with a standalone `new URLSearchParams` and no `new URL` at all. | Task 3 clears `discord`/`google-meet` **as fixtures**, not as corpus connectors. Task 4's shape has no corpus instance at all. |
| **body** | 30 connectors build a body with `JSON.stringify`, but only 8 use the all-shorthand object literal this generator writes; 15 pass a pre-built variable or a helper parameter. **No connector declares a `<local>Send` helper** — 3 have a generic `xPost(path, body)`, and 16 use one `xFetch(path, init)` for both reads and writes. | Tasks 5 and 6 clear `zzwriteonly`/`zzwriterest` and no corpus connector. |
| **client-credentials** | 3 connectors (`powerbi`, `ramp`, `wiz`), and **no two share a shape** — they differ on every axis: the cache variable (one, none, or absent), the exchange function's name, credentials in a Basic header vs the POST body, scope vs `audience`, and the endpoint's source. `tokenExpiresAt` appears nowhere in the corpus and **no connector reads `expires_in`**. All three also import `./search-filter.ts` and `../../shared/mcp-search-tool.ts`, so all three are blocked elsewhere regardless. | Task 8 clears `zzwrite` and no corpus connector. |

**This does not make Tasks 3–8 optional, and it is not a reason to widen them.** `--from-connector` is
a shipped product surface: a deriver that cannot read back what its own emitter writes is an
incomplete inverse, and every one of these shapes is one `generate()` produces today. The deliverable
is an empty `BLOCKED` list — all 21 fixtures round-tripping, checkable in CI without an AGPL
checkout — not a corpus number.

**Every divergence in that table is a line in Task 12's ceiling.** That is what "publish the number
with its method" means: the corpus does not write these constructs the way this generator does, and
saying so precisely is worth more than a recognizer widened until it matches.

Combined with Tasks 9–11, whose measured effect is that buckets shrink and new ones appear rather than
tiers moving, **it is a plausible and acceptable outcome that `server-identical` is still 6/94 when
this branch lands.** That number, with the causes behind it written down, *is* Stage E's deliverable.

---

## Task 1: The two correctness findings carried from phase 2a

Phase 2a's whole-branch review found two matchers that accept shapes the emitter cannot write. Both
are the wrong-claim class — the class the totality rule is structurally blind to — so both get a RED
test before a fix.

**Files:**
- Modify: `src/derive/search-filter.ts:155-195` (`matchExtractorFunction`)
- Modify: `src/derive/server/env.ts` (`matchSplitBearerReader:437`, `matchSplitBearerWrapper:472`,
  `recognizeBasicAuth:547`, `recognizeOne:387`)
- Test: `test/derive/search-filter.test.ts`, `test/derive/env.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks — this is the first task.
- Produces: no new exports. Later tasks rely only on the *tightened* behaviour.

### Finding A — an extractor whose entries are all keys is a shape the emitter never writes

`src/emit/search-filter.ts` chooses between the two filter forms with `keyedShape(tool)`, which is a
thin wrapper over `resolveKeyedShape` (`src/spec.ts`). The bespoke-extractor form
(`extractorFilter`) is written **only** when `resolveKeyedShape` returns `undefined`. So a
`function fieldsOf(item: unknown)` whose returned array is entirely `stringField(row, "…")` calls
(optionally with a trailing `tagText(row)`) is keys-expressible, and re-emitting the recovered spec
would write the *keyed* form — a different file.

- [ ] **Step 1: Find out whether the import cross-check already catches this**

`recognizeSearchFilter` recomputes the emitter's import list from the recognized body and requires
the file to match it (that is the check whose removal a phase-2a review proved returns `ok: true`).
An all-`stringField` extractor's file imports `asObjectish, makeQueryFilter, stringField`, while the
emitter would compute `fieldsFromKeys, makeQueryFilter` for the recovered spec. **Check whether that
mismatch already blocks.** Write the test in Step 2 and run it before writing any fix.

If it already blocks: the fix is not a code change but a *test that pins it*, plus a comment in
`matchExtractorFunction` recording why the guard lives in the import cross-check rather than in the
matcher. Say so in your report. Do not add a redundant second guard.

- [ ] **Step 2: Write the failing test**

Add to `test/derive/search-filter.test.ts`, inside the existing `describe("recognizeSearchFilter")`:

```ts
  it("refuses an extractor whose entries are all plain keys — emitSearchFilter writes the KEYED form for that field list (resolveKeyedShape returns a shape), so this file is one the emitter cannot have produced", () => {
    const source = [
      'import { asObjectish, makeQueryFilter, type SearchMatchOptions, stringField } from "../../shared/search-filter.ts";',
      "",
      "export type XSearchMatchOptions = SearchMatchOptions;",
      "",
      "function fieldsOf(item: unknown): readonly string[] | null {",
      "  const row = asObjectish(item);",
      "  if (row === undefined) {",
      "    return null;",
      "  }",
      '  return [stringField(row, "a"), stringField(row, "b")];',
      "}",
      "",
      "export const filterX = makeQueryFilter(fieldsOf);",
    ].join("\n");
    const result = recognizeSearchFilter(source);
    expect(result.ok).toBe(false);
  });

  it("still accepts an extractor that is NOT keys-expressible — one nestedString entry is enough to make the extractor form the only one emitSearchFilter can write", () => {
    const source = [
      'import { asObjectish, makeQueryFilter, nestedString, type SearchMatchOptions, stringField } from "../../shared/search-filter.ts";',
      "",
      "export type XSearchMatchOptions = SearchMatchOptions;",
      "",
      "function fieldsOf(item: unknown): readonly string[] | null {",
      "  const row = asObjectish(item);",
      "  if (row === undefined) {",
      "    return null;",
      "  }",
      '  return [stringField(row, "a"), nestedString(row, ["b", "c"])];',
      "}",
      "",
      "export const filterX = makeQueryFilter(fieldsOf);",
    ].join("\n");
    const result = recognizeSearchFilter(source);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.filters[0]?.fields).toEqual(["a", { path: ["b", "c"] }]);
    }
  });
```

- [ ] **Step 3: Run both tests**

```bash
bun test test/derive/search-filter.test.ts
```

Record what happens. Expected: the second test passes. The first either already passes (the import
cross-check caught it — go to Step 5) or fails with `ok: true` (go to Step 4).

- [ ] **Step 4: If it failed — refuse in `matchExtractorFunction`**

`resolveKeyedShape` is exported from `src/spec.ts` and is already the single source of truth for this
rule, shared by the schema's `superRefine`, `validateSpec` and `emitSearchFilter`'s `keyedShape`.
Call it — do not reimplement the convergence rule, which is exactly the drift that shared function
exists to prevent. At the end of `matchExtractorFunction`, replace `return entries;` with:

```ts
  // emitSearchFilter writes the extractor form ONLY when resolveKeyedShape refuses the field list
  // (see its `keyedShape`); for a keys-expressible list it writes `fieldsFromKeys([...])` instead.
  // Recovering these entries would derive a spec that regenerates a DIFFERENT file — the
  // wrong-claim class, which the totality rule cannot see because the statement was claimed, just
  // claimed wrongly. Same source of truth as the schema's superRefine and validateSpec, so the
  // three cannot drift.
  if (resolveKeyedShape(entries) !== undefined) return undefined;
  return entries;
```

Add `resolveKeyedShape` to the `../spec.ts` import at the top of the file. Check its exact signature
and return type first — if it takes something other than a `FieldEntry[]`, adapt the call rather than
the function.

- [ ] **Step 5: Run the tests and the typecheck**

```bash
bun test test/derive/search-filter.test.ts
bunx tsc --noEmit
```
Expected: PASS, exit 0 both.

### Finding B — four env matchers never check the function's return type or async-ness

`src/emit/server/env.ts` writes an exact return-type annotation on every accessor it emits, and never
writes `async` on any of them except the `client-credentials` pair. The four matchers below read the
body and the name and ignore both facts, so `async function headers(): Promise<number>` reads exactly
like `function headers(): Record<string, string>`.

The four, with the annotation the emitter actually writes:

| matcher | emitter | annotation | async |
| --- | --- | --- | --- |
| `matchSplitBearerReader` | `renderSplitBearer` | `(): string` | no |
| `matchSplitBearerWrapper` | `renderSplitBearer` | `(): Record<string, string>` | no |
| `recognizeBasicAuth` | `renderBasic` | `(): Record<string, string>` | no |
| `recognizeOne` | `renderEnvAccessor`'s tail | `(): string` when `auth === undefined`, else `(): Record<string, string>` | no |

- [ ] **Step 6: Write the failing tests**

Add to `test/derive/env.test.ts`. Use the file's existing helper for building a module and running
`recognizeEnv` — read the top of that file and follow it rather than inventing a second harness. The
four cases:

```ts
  it("refuses a split-bearer reader annotated something other than `: string` — renderSplitBearer always writes `(): string`", () => {
    const source = ACCESSOR_MODULE(
      SPLIT_BEARER.replace("function mercuryToken(): string {", "function mercuryToken(): unknown {"),
    );
    expect(recognizeEnvOf(source)).toEqual([]);
  });

  it("refuses an async split-bearer wrapper — renderSplitBearer never writes `async` on either half", () => {
    const source = ACCESSOR_MODULE(
      SPLIT_BEARER.replace(
        "function headers(): Record<string, string> {",
        "async function headers(): Promise<Record<string, string>> {",
      ),
    );
    expect(recognizeEnvOf(source)).toEqual([]);
  });

  it("refuses a basic accessor annotated something other than `: Record<string, string>` — renderBasic always writes that", () => {
    const source = ACCESSOR_MODULE(BASIC.replace("): Record<string, string> {", "): unknown {"));
    expect(recognizeEnvOf(source)).toEqual([]);
  });

  it("refuses a plain accessor whose annotation contradicts its auth shape — renderEnvAccessor writes `: string` for a bare read and `: Record<string, string>` for an auth one", () => {
    const source = ACCESSOR_MODULE(BEARER.replace("): Record<string, string> {", "): string {"));
    expect(recognizeEnvOf(source)).toEqual([]);
  });
```

`ACCESSOR_MODULE`, `SPLIT_BEARER`, `BASIC`, `BEARER` and `recognizeEnvOf` are placeholders for
whatever that file already uses — **read `test/derive/env.test.ts` and use its real names**. Each
`.replace()` must be preceded by an assertion that the replacement actually changed the string, the
way `test/derive/search-filter.test.ts` already does:

```ts
    expect(corrupted).not.toBe(pristine);
```

Without it, a no-op replace (because the emitter stopped writing that text) still passes and the test
silently stops testing anything. That guard is the difference between a test and a decoration.

- [ ] **Step 7: Run them — all four must FAIL**

```bash
bun test test/derive/env.test.ts
```
Expected: four failures, each because the matcher accepted a shape it should refuse.

- [ ] **Step 8: Add a return-type accessor and the four checks**

`read.ts` already exports `functionReturnType(node)` and `isAsyncFunction(node)`. You need to compare
a return-type node against an expected shape. Check whether an accessor for "this type annotation is
the type reference named X" exists (`typeAliasRhsName` is for aliases, not annotations). If not, add
one to `read.ts` in the TS-type-shapes section, following the shape of the accessors already there:

```ts
/**
 * A return-type annotation that is exactly the keyword or type reference `name` — `string`,
 * `unknown`, `Record`, and so on. Returns the head name only; a generic's type arguments are NOT
 * inspected, because every caller so far pairs this with a full-text comparison of the emitted
 * annotation. Needed by server/env.ts's four accessor matchers, which previously read the body and
 * the name and ignored the annotation entirely — so `(): unknown` read exactly like `(): string`.
 */
export function typeAnnotationName(node: AstNode | undefined): string | undefined {
```

Implement it against the Babel node shapes for `TSStringKeyword` / `TSTypeReference` — inspect a
parsed example first (`bun -e` with `parseModule`) rather than guessing the field names, and add a
unit test to `test/derive/read.test.ts` covering the keyword form, the reference form, and a node of
neither kind returning `undefined`.

Then add, in each of the four matchers, a check pinning both facts, each with a one-line comment
naming the emitter function it mirrors. Refusal is `undefined` (or an empty result for
`recognizeEnv`'s loop), never a throw.

- [ ] **Step 9: Run the full gate set**

```bash
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
```
All three must exit 0. Then confirm nothing moved on the corpus:
```bash
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus
```
Expected: `newrelic`/`datadog`/`grafana`/`sentry` all `6/6`; `REACH 6/94` unchanged. **A tightened
matcher that lowers a reach number is a finding, not a pass** — report it before continuing.

- [ ] **Step 10: Commit**

```bash
git add src/derive/search-filter.ts src/derive/server/env.ts src/derive/read.ts test/derive/
git commit -m "fix(derive): refuse a keys-expressible extractor and pin every env accessor's signature"
```

---

## Task 2: Name the duplicated types, sweep the env test comments, fix the skill's Layout block

Three hygiene items carried from phase 2a's whole-branch review. This task lands **before** every new
recognizer so the new code uses the named types from the start.

**Files:**
- Modify: `src/spec.ts` (export `StaticPathStyle`)
- Modify: `src/derive/server/args.ts` (export `SchemaShape`)
- Modify: `src/derive/index.ts:164-203`, `src/derive/server/search.ts:52-53,73`,
  `src/derive/server/tools-hand.ts:61-62,70-71,127`, `src/derive/server/tools-rest.ts:154-155,281-282`,
  `src/derive/server/path-template.ts:35`, `src/emit/server/path-template.ts:19`
- Modify: `test/derive/env.test.ts` (comment sweep only)
- Modify: `.claude/commands/cnc-reach-deriver.md`
- Test: existing tests must keep passing; `bunx tsc --noEmit` is the real gate here.

**Interfaces:**
- Consumes: nothing.
- Produces: `SchemaShape` (exported from `src/derive/server/args.ts`) and `StaticPathStyle` (exported
  from `src/spec.ts`). **Tasks 3–11 must use these two names rather than re-inlining the shapes.**

- [ ] **Step 1: Export `StaticPathStyle` from `src/spec.ts`**

The union `"quoted" | "template"` appears at **11** sites across `src/`, including one in `src/emit/`.
Its authority is `FetchHelperSchema`'s `staticPathStyle` field. Derive the type from the schema rather
than restating it, next to the other spec-derived type exports:

```ts
/**
 * `fetchHelper.staticPathStyle`'s two values, derived from the schema rather than restated — it
 * appeared as an inline `"quoted" | "template"` at eleven sites across src/emit and src/derive,
 * which is eleven places for the schema to be widened and one of them to be missed.
 */
export type StaticPathStyle = NonNullable<z.infer<typeof FetchHelperSchema>["staticPathStyle"]>;
```

Check the field's actual optionality in the schema first — if it carries a `.default("quoted")` the
inferred type is already non-optional and `NonNullable` is noise; use whichever form yields exactly
`"quoted" | "template"`, and verify with a temporary `const _check: StaticPathStyle = "quoted";` plus
a deliberate `// @ts-expect-error` on a third value before deleting both.

- [ ] **Step 2: Export `SchemaShape` from `src/derive/server/args.ts`**

`{ propertyCount: number; oneLine: boolean }` appears at **7** sites in `src/derive/`. It is produced
by `recognizeArgs`'s callers and consumed by `voteArgsSchemaStyle`, so `args.ts` is its home:

```ts
/**
 * One tool's evidence for the connector-wide `argsSchemaStyle` vote — see `voteArgsSchemaStyle`
 * (src/derive/index.ts) for why a `propertyCount` of 0 abstains and why a single one-liner is
 * decisive while multi-line is not. Named because it was inlined at seven sites, and an inline
 * structural type is a place for one site to gain a field the other six silently ignore.
 */
export type SchemaShape = { readonly propertyCount: number; readonly oneLine: boolean };
```

Note the `readonly` markers: check that adding them does not break a call site that mutates one. If it
does, drop them rather than restructuring the caller — this step is mechanical.

- [ ] **Step 3: Replace all 18 inline occurrences**

```bash
grep -rn "propertyCount: number" src/
grep -rn '"quoted" | "template"' src/
```
Replace each with the named type. `voteStaticPathStyle`'s signature becomes:

```ts
export function voteStaticPathStyle(
  styles: readonly (StaticPathStyle | undefined)[],
): { ok: true; value: StaticPathStyle | undefined } | { ok: false } {
  const decisive = styles.filter((s): s is StaticPathStyle => s !== undefined);
  if (new Set(decisive).size > 1) return { ok: false };
  return { ok: true, value: decisive[0] };
}
```

and `voteArgsSchemaStyle`'s parameter becomes `schemas: readonly SchemaShape[]`.

Leave the *test* files' inline literals alone — a test that constructs `{ propertyCount: 0, oneLine:
false }` as a literal is fine and does not need the name.

- [ ] **Step 4: Verify the refactor changed no behaviour**

```bash
bunx tsc --noEmit
bun test
```
Both exit 0, with the same test count as before this task. A type-only change that alters a test
result means it was not type-only — stop and report.

- [ ] **Step 5: Sweep `test/derive/env.test.ts`'s comments**

Phase 2a shipped a test comment claiming `renderSplitBearer`'s docstring names `lever` as an excluded
connector. It does not, and never did — `git log -S"lever" -- src/emit/server/env.ts` returns nothing.
The false citation travelled four hops (plan → brief → dispatch → shipped comment) before anyone
checked it.

Read **every** comment in `test/derive/env.test.ts` that names a corpus connector or asserts something
about `src/emit/server/env.ts`. For each, verify it against the actual source:

```bash
grep -n "intercom\|lever\|readwise\|mendeley\|dagster\|pipedrive\|stackoverflow\|figma\|salesforce\|vercel" test/derive/env.test.ts src/emit/server/env.ts
```

A claim about the emitter must be checkable by reading `src/emit/server/env.ts` **now** — not by
recalling what a plan said. A claim about a connector must be checkable by reading that connector.
Correct or delete each one that fails. Report the list of what you changed and why; if every comment
checks out, say that explicitly rather than silently making no edit.

- [ ] **Step 6: Add `from-connector.ts` to the skill's Layout block**

`.claude/commands/cnc-reach-deriver.md`'s Layout block lists the `src/derive/` modules and omits
`from-connector.ts`, which has been there since phase 1. Add it in the file's own alphabetical-ish
position, matching the surrounding style:

```
  from-connector.ts  a connector DIRECTORY -> a spec, or named blockers (--from-connector)
```

While you are in that file, check the rest of it against the code as it stands at HEAD — the "What is
not built yet" section names `search`, `query`, `body` and `search-filter` as missing, and two of
those shipped in phase 2a. Correct what is stale. **Do not** describe what this plan is about to
build as though it already exists; describe HEAD.

- [ ] **Step 7: Run the gates and commit**

```bash
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
```
```bash
git add src/ test/ .claude/
git commit -m "refactor(derive): name SchemaShape and StaticPathStyle, and correct three stale claims"
```

---

## Task 3: The query recognizer, and the rest-kit query branch

**Files:**
- Create: `src/derive/server/query.ts`
- Modify: `src/derive/server/hoists.ts` (extract `splitHoists`)
- Modify: `src/derive/server/tools-rest.ts` (`recognizeOneCall`'s block form)
- Test: `test/derive/query.test.ts` (new), `test/derive/round-trip.test.ts`

**Interfaces:**
- Consumes: `SchemaShape`, `StaticPathStyle` (Task 2); `recognizeHoistedBlock`, `HoistMeta`,
  `PathLocal` (existing).
- Produces:
  - `src/derive/server/hoists.ts`: `export type HoistSection = { locals: ReadonlyMap<string, PathLocal>; hoistMeta: ReadonlyMap<string, HoistMeta>; rest: readonly AstNode[] }`
    and `export function splitHoists(statements: readonly AstNode[]): HoistSection | undefined`.
  - `src/derive/server/query.ts`: `export type QueryEntry = { name: string; arg: string; omitWhen?: "absent" | "empty" }`
    and `export function recognizeQueryLines(statements: readonly AstNode[], locals: ReadonlyMap<string, PathLocal>): QueryEntry[] | undefined`.
  - Task 4 consumes both.

### What the emitter writes

`src/emit/server/tools-rest.ts:109-131` — the rest-kit query branch, inside the `pathFn` arrow:

```
  (parsed) => {
    <zero or more hoist consts>
    const u = new URL(<pathExpr, built with the base spliced in as a prefix>);
    <query lines>
    return `${u}`;
  },
```

`src/emit/server/query.ts:42-63` — one query entry, in exactly two forms:

```
u.searchParams.set("<name>", <value>);

if (<guard>) {
  u.searchParams.set("<name>", <value>);
}
```

where `<value>` is the hoisted const, or `<param>.<arg>`, wrapped in `String(...)` **iff the arg's
declared type is not `"string"`** (`wrapsInString`), and `<guard>` is `<value> !== undefined` for
`omitWhen: "absent"` or `<value> !== undefined && <value> !== ""` for `"empty"`.

Three facts that decide the matcher's shape:

1. **`String(...)` is driven by the declared type, never by guardedness.** So the recognizer must
   *verify* the wrapper against the arg's recovered type rather than record it: a `String(...)` around
   a `string`-typed arg is a shape the emitter cannot write, and a bare non-string arg likewise.
2. **The receiver is always the const `u`** declared by the statement immediately above the query
   lines. Pin it — an unpinned receiver would accept `other.searchParams.set(...)`.
3. **`omitWhen` is recovered from the guard's shape**, and the two forms are distinguishable: one
   `BinaryExpression` versus a `LogicalExpression` of two. A guard of any other shape is refused.

- [ ] **Step 1: Extract `splitHoists` from `recognizeHoistedBlock`**

`recognizeHoistedBlock` currently walks `statements.slice(0, -1)` as hoists and requires the last to be
a `return`. The query block needs the same hoist reader but a different tail. Extract the shared half —
**do not copy it**, for the reason `hoists.ts`'s own module docstring gives about the two verbatim
copies that preceded it.

In `src/derive/server/hoists.ts`:

```ts
/**
 * The leading run of hoisted-argument consts in a handler block, and everything after it.
 *
 * Split out so the query branch (server/query.ts) reads the SAME hoist statements
 * `recognizeHoistedBlock` does without a second copy of the loop — the copy this module's own
 * docstring exists to have removed once already. The two callers differ only in what they demand
 * of `rest`: a single `return` here, the `new URL` trio there.
 */
export type HoistSection = {
  readonly locals: ReadonlyMap<string, PathLocal>;
  readonly hoistMeta: ReadonlyMap<string, HoistMeta>;
  readonly rest: readonly AstNode[];
};

export function splitHoists(statements: readonly AstNode[]): HoistSection {
  const locals = new Map<string, PathLocal>();
  const hoistMeta = new Map<string, HoistMeta>();
  let i = 0;
  for (; i < statements.length; i++) {
    const hoist = hoistedLocal(statements[i]!);
    if (hoist === undefined) break;
    locals.set(hoist.local, hoist.pathLocal);
    hoistMeta.set(hoist.pathLocal.arg, { local: hoist.local, default: hoist.default });
  }
  return { locals, hoistMeta, rest: statements.slice(i) };
}
```

Then rewrite `recognizeHoistedBlock` in terms of it, **preserving its exact refusals**:

```ts
export function recognizeHoistedBlock(body: AstNode): HoistedBlock | undefined {
  const statements = blockBody(body);
  if (statements === undefined || statements.length === 0) return undefined;

  const section = splitHoists(statements);
  // Unchanged from the slice(0, -1) form this replaced: everything before the last statement must
  // be a hoist, and the last must be a `return`. `splitHoists` stops at the first non-hoist, so
  // "exactly one statement left, and it returns" is the same condition stated positively.
  if (section.rest.length !== 1) return undefined;
  const last = section.rest[0]!;
  if (last.type !== "ReturnStatement") return undefined;
  return { locals: section.locals, hoistMeta: section.hoistMeta, returned: returnArgument(last) };
}
```

- [ ] **Step 2: Run the existing tests to prove the extraction changed nothing**

```bash
bun test test/derive/
bunx tsc --noEmit
```
Expected: PASS, same test count as before Step 1. If any test changes result, the extraction was not
behaviour-preserving — fix it before going on.

- [ ] **Step 3: Write the failing test for the query recognizer**

Create `test/derive/query.test.ts`. Build the input by **emitting a spec with this repo's own
emitter** — the same technique `test/derive/search-filter.test.ts` uses — so the test can never drift
from what the emitter writes:

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

/**
 * One rest-kit connector exercising every query shape `renderQueryLines` writes: an unconditional
 * string entry, an `omitWhen: "absent"` guard, an `omitWhen: "empty"` guard, a NUMBER-typed entry
 * (which `wrapsInString` wraps in `String(...)`) and an entry whose arg is hoisted by a `??`
 * default (so the value expression is the hoisted const, not `parsed.<arg>`).
 */
const SPEC = {
  name: "zzqueryunit",
  displayName: "ZZ Query Unit",
  description: "Fixture for the query recognizer.",
  serviceLabel: "ZZ Query Unit",
  style: "rest-kit",
  network: ["api.zzqueryunit.test"],
  syncInterval: 600,
  minNimbusVersion: "0.2.0",
  env: [{ vars: ["ZZQUERYUNIT_TOKEN"], local: "restAuthToken", auth: "bearer" }],
  fetchHelper: { local: "zzGet", base: "https://api.zzqueryunit.test" },
  tools: [
    {
      name: "zzqueryunit_list",
      description: "List items.",
      path: "/v1/items",
      args: {
        q: { type: "string" },
        after: { type: "string", optional: true },
        filter: { type: "string", optional: true },
        page: { type: "number", optional: true },
        limit: { type: "number", default: 50 },
      },
      query: [
        { name: "q", arg: "q" },
        { name: "after", arg: "after", omitWhen: "absent" },
        { name: "filter", arg: "filter", omitWhen: "empty" },
        { name: "page", arg: "page", omitWhen: "absent" },
        { name: "limit", arg: "limit" },
      ],
    },
  ],
};
```

**Before writing assertions, emit this spec and read the actual `src/server.ts` it produces**, so the
test asserts against real bytes:

```bash
# from the repo root, with the spec above saved to a scratch file
bun -e 'import {generate} from "./src/emit/index.ts"; import {formatAll,initFormatter} from "./src/format.ts"; import {parseSpec} from "./src/spec.ts"; import {displayPath} from "./src/types.ts"; await initFormatter(); const s=parseSpec(JSON.parse(await Bun.file(process.argv[1]).text())); for (const f of formatAll(generate(s,{}))) if (displayPath(f.path)==="src/server.ts") console.log(f.content);' <scratch-spec-path>
```

Adjust the spec until it parses (`parseSpec` will tell you what a rest-kit spec requires — the
`ConnectorSpecSchema` rest-kit refine wants exactly one env entry with `auth: "bearer"`), then write
the assertions against what you saw. The test asserts `recognizeQueryLines` recovers, in order:

```ts
    expect(entries).toEqual([
      { name: "q", arg: "q" },
      { name: "after", arg: "after", omitWhen: "absent" },
      { name: "filter", arg: "filter", omitWhen: "empty" },
      { name: "page", arg: "page", omitWhen: "absent" },
      { name: "limit", arg: "limit" },
    ]);
```

Add refusal tests, each with the `expect(corrupted).not.toBe(pristine)` guard:
- a `searchParams.append(...)` instead of `set` → refused;
- a receiver other than the `new URL` const → refused;
- a guard of a third shape (`value !== null`) → refused;
- a `String(...)` around a `string`-typed arg → refused;
- a bare (unwrapped) number-typed arg → refused.

- [ ] **Step 4: Run it — every test must FAIL (module does not exist)**

```bash
bun test test/derive/query.test.ts
```
Expected: FAIL, "Cannot find module '../../src/derive/server/query.ts'".

- [ ] **Step 5: Write `src/derive/server/query.ts`**

```ts
import type { AstNode } from "../ast.ts";
import {
  binary,
  blockBody,
  callTo,
  identName,
  ifStatement,
  isIdent,
  logical,
  memberName,
  memberObject,
  methodCallTo,
  stringLit,
} from "../read.ts";
import type { PathLocal } from "./path-template.ts";

/**
 * The inverse of src/emit/server/query.ts's `renderQueryLines`.
 *
 * `String(...)` is NOT recorded — it is VERIFIED. `wrapsInString` derives the wrapper from the
 * argument's declared type alone (see its own docstring: guardedness never enters the decision),
 * so the wrapper carries no information the schema does not already hold. Recording it would
 * invent a spec field; checking it is what makes a `String(...)` around a declared `string` — a
 * shape the emitter cannot write — a refusal rather than a silently claimed statement.
 */
export type QueryEntry = {
  readonly name: string;
  readonly arg: string;
  readonly omitWhen?: "absent" | "empty";
};
```

The matcher, in three parts. `valueArg(node, locals)` resolves a value expression to an arg name:

```ts
/**
 * `<hoistedConst>` or `<param>.<arg>` -> the ARG name, plus whether it arrived through a hoist.
 *
 * `locals` is `splitHoists`'s map, keyed by the const's own identifier. The bare-member form is
 * resolved without checking the receiver, the same lax rule `hoists.ts`'s `memberArgName` and
 * `path-template.ts`'s `argNameFromExpr` already use — pinning a check here that neither use site
 * makes would create a second, inconsistent notion of "the param".
 */
function valueArg(
  node: AstNode | undefined,
  locals: ReadonlyMap<string, PathLocal>,
): string | undefined {
  const local = identName(node);
  if (local !== undefined) return locals.get(local)?.arg;
  if (identName(memberObject(node)) === undefined) return undefined;
  return memberName(node);
}
```

`setCall(node, urlVar, locals)` matches one `u.searchParams.set("<name>", <value>)`:

```ts
/**
 * `<urlVar>.searchParams.set("<name>", <value>)` — the receiver pinned to the `new URL` const's
 * own binding, and the method pinned to `set`. `renderQueryLines` writes only `set`; accepting
 * `append` too would claim a statement with different semantics (repeated keys) for a spec that
 * regenerates `set`.
 */
function setCall(
  expr: AstNode | undefined,
  urlVar: string,
  locals: ReadonlyMap<string, PathLocal>,
): { name: string; arg: string; wrapped: boolean } | undefined {
```

Its body must read `<urlVar>.searchParams` as the receiver — a two-level member expression, which
`methodCallTo` (receiver is a plain identifier) cannot express. Check `read.ts` for an accessor that
does; if none fits, add one rather than reaching into the node, and unit-test it in
`test/derive/read.test.ts`.

`guardKind(ifNode, value)` recovers `omitWhen`:

```ts
/**
 * `<value> !== undefined` -> "absent"; `<value> !== undefined && <value> !== ""` -> "empty".
 * Both operands of the `&&` are checked, and both must name the SAME value expression the guarded
 * `set` call uses — a guard on one arg wrapping a `set` of another is a shape `renderQueryLines`
 * cannot write, and claiming it would derive an `omitWhen` attached to the wrong argument.
 */
```

Then the top-level reader:

```ts
export function recognizeQueryLines(
  statements: readonly AstNode[],
  urlVar: string,
  locals: ReadonlyMap<string, PathLocal>,
): QueryEntry[] | undefined {
```

It walks `statements` and refuses on the first statement that is neither a bare `set` call nor an `if`
whose consequent block is exactly one `set` call. Zero statements yields `[]` — but the **caller**
must treat an empty query as a refusal, because `renderQueryLines` with an empty array would not have
emitted the `new URL` trio at all.

**Do not verify the `String(...)` wrapper inside this module** — it needs the arg's declared type,
which lives in the caller's `recognizeArgs` result. Return `wrapped` per entry and have the caller
check it. State that split in the module docstring.

- [ ] **Step 6: Wire the rest-kit call site**

In `src/derive/server/tools-rest.ts`'s `recognizeOneCall`, the block form currently calls
`recognizeHoistedBlock` and refuses anything that is not hoists-then-return. Add the query branch
**after** that attempt, not instead of it:

```ts
  const block = recognizeHoistedBlock(arrow.body);
  if (block !== undefined) {
    /* ...existing path, unchanged... */
  }

  // The query branch: hoists, `const u = new URL(<pathExpr>)`, the query lines, and
  // ``return `${u}`;`` — src/emit/server/tools-rest.ts:109-131. Tried only once the plain
  // hoists-then-return form has failed, so no existing shape changes meaning.
  const query = recognizeQueryBlock(arrow.body, argsResult.args);
  if (query === undefined) return undefined;
```

`recognizeQueryBlock` lives in `query.ts` and owns the whole block shape: `splitHoists`, then exactly
three kinds of remaining statement — the `new URL` const, the query lines, and the tail. The rest-kit
tail is ``return `${u}`;`` (a template literal with one expression and two empty quasis). Verify it
precisely; `templateLiteral` is already in `read.ts`.

### The base prefix — recover it, cross-check it in the assembly, and do not thread it

The `pathExpr` inside `new URL(...)` was built **with the base spliced in as a prefix**
(`renderPath`'s `prefix: baseExpr(spec)`), so `recognizePath` sees a leading base segment a non-query
tool never has. `baseExpr` (`src/emit/server/fetch-helper.ts:35-38`) has exactly two branches:

```ts
  return baseConst === undefined ? resolveEnvRefs(base) : `\${${baseConst}}`;
```

so the prefix is either literal text in the template's leading quasi, or a `${IDENT}` expression
naming the hoisted base const.

**Recover it into a normalized shape and let the assembly function compare it** — do not reorder the
recognizers and do not thread a `helperBase` parameter into `recognizeRestTools`. Both would couple
tool recognition to helper recognition for a fact the assembly already holds, and the assembly is
where this codebase already puts exactly this kind of check: `deriveRestKitSpec`'s
`rest-fetch-helper-name-mismatch` guard exists because "two separate recognizers that never
cross-check each other's output" is the defect, and the fix was a comparison in the caller, not a
parameter. Threading the base would also force this recognizer to resolve a `baseConst` against
module scope a second time, duplicating `reconstructBase`.

So `recognizeQueryBlock` returns:

```ts
/** The `new URL(...)` prefix, in the two forms `baseExpr` can write. Compared against the
 *  recognized fetch helper's own fields by the caller — see deriveRestKitSpec. */
export type BasePrefix = { kind: "literal"; text: string } | { kind: "const"; name: string };
```

and `deriveRestKitSpec` adds, after both recognizers have run:

```ts
  // Every query tool's path was rendered with baseExpr(spec) spliced in as a prefix, so each one
  // must agree with the fetch helper this same module declares. Two recognizers producing the base
  // independently is how they drift; comparing them here is the same guard the fetch-helper name
  // mismatch above applies, for the same reason.
  for (const p of tools.basePrefixes) {
    const agrees =
      p.kind === "const"
        ? p.name === restFetchHelper.baseConst
        : restFetchHelper.baseConst === undefined && p.text === restFetchHelper.base;
    if (!agrees) {
      return blocked(
        "query:base-prefix-mismatch",
        "a query tool's new URL(...) prefix is not the base this module's fetch helper declares",
      );
    }
  }
```

`resolveEnvRefs` means a literal base may itself contain `${accessor()}` interpolations — check what
`restFetchHelper.base` holds (the raw spec text or the resolved form) and compare like with like. If
they are not directly comparable, normalize through the **same** function `baseExpr` uses rather than
writing a second normalizer.

### A query tool abstains from the `staticPathStyle` vote

`renderPath`'s fast path is `if (!dynamic && prefix === "")` — so **a non-empty prefix forces the
template branch regardless of `ctx.staticStyle`**, exactly as a dynamic segment does. A query tool's
path therefore carries no evidence of the connector's `staticPathStyle`, and reporting `"template"`
for one would be reading the prefix as if it were the convention.

This is not cosmetic: `voteStaticPathStyle` **blocks** on disagreement. A connector whose other tools
render `quoted` plus one query tool voting `template` would report `style:mixed-static-path` — a
refusal manufactured by the recognizer, on a module the emitter wrote correctly.

`recognizeQueryBlock` must report `staticStyle: undefined`. Add a test that pins it: a connector with
one `quoted` static-path tool and one query tool must derive with `staticPathStyle` omitted, not
blocked.

- [ ] **Step 7: Verify the `String(...)` wrapper against each arg's type**

In the caller, for every recovered entry:

```ts
    // src/emit/server/query.ts's `wrapsInString`: the wrapper is written iff the declared type is
    // not "string", regardless of guardedness. Checked rather than recorded — see QueryEntry.
    const declared = mergedArgs[entry.arg]?.type;
    if (declared === undefined) return undefined;
    if (entry.wrapped !== (declared !== "string")) return undefined;
```

- [ ] **Step 8: Run the tests**

```bash
bun test test/derive/query.test.ts
bun test test/derive/
bunx tsc --noEmit
```
All exit 0.

- [ ] **Step 9: Move `discord` and `google-meet` to `ROUND_TRIP`**

In `test/derive/round-trip.test.ts`, delete both entries from `BLOCKED` and add both to `ROUND_TRIP`.
**Then update the `BLOCKED` docstring**, which currently explains the query gap at length. That
docstring has gone stale three times; the file's own rule is that every reason must be checked by
actually running `deriveSpec`, never inferred. Rewrite the query paragraph to say what is now true and
delete what no longer is.

- [ ] **Step 10: Run every gate**

```bash
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
bun test --coverage
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus
bun run reach --verbose --nimbus-root C:/gitrep/Nimbus
```
Record each exit code separately. `newrelic`/`datadog`/`grafana`/`sentry` must be `6/6`.

**Expect `REACH` to be unchanged.** `circleci`, `github-actions`, `pagerduty` and the other seven
`new URL` connectors write the tail `` `${u.pathname}${u.search}` `` or `u.toString()`, and this
recognizer accepts only ``return `${u}`;`` — the form `renderTool` emits, and deliberately so (see
its comment on why the absolute URL is the intended use of `buildPath`'s contract). Their buckets
should not move. Record the `--verbose` histogram anyway: **if a bucket does move, something was
claimed that this task did not intend to claim**, and that is a finding to report before committing.

- [ ] **Step 11: Commit**

```bash
git add src/derive/ test/derive/
git commit -m "feat(derive): read the query branch, unblocking the rest-kit new URL form"
```

---

## Task 4: The hand-rolled query branch, the read helper's passthrough form, and a fixture for both

**Files:**
- Modify: `src/derive/server/query.ts`, `src/derive/server/tools-hand.ts`,
  `src/derive/server/fetch-helper.ts`
- Create: `fixtures/zzquery.spec.json`
- Modify: `fixtures/expectations.json`, `test/derive/round-trip.test.ts`
- Test: `test/derive/query.test.ts`, `test/derive/fetch-helper.test.ts`

**Interfaces:**
- Consumes: `recognizeQueryBlock`, `QueryEntry`, `splitHoists` (Task 3).
- Produces: nothing new exported.

### Why this needs a new fixture, and why it is worth building at all

**No existing fixture exercises the hand-rolled query branch.** `discord` and `google-meet` are both
`rest-kit`; `grafana` has an *argument* named `query` but no `query` array. So this task's recognizer
would otherwise be tested only against strings built in a unit test, never against a real
`generate() → deriveSpec() → generate()` round trip.

**And no corpus connector carries this shape either** — the sweep found the hand-rolled tail
`` const path = `${u}` `` zero times in 94 connectors. So this task moves no reach number, by
construction, and the fixture is the *only* thing that will ever exercise it.

That is a reason to state the task's value accurately, not to skip it. `generate()` emits this branch
for any hand-rolled spec with a `query` array, and `--from-connector` is a shipped flag: a deriver
that refuses its own emitter's output is an incomplete inverse, and the gap would surface as a user's
bug report rather than as a number. Task 12 records the corpus divergence in the ceiling.

### What differs from Task 3

Two things, both in `src/emit/server/tools-hand.ts:120-147`:

1. **The tail is two statements, not one.** ``const path = `${u}`;`` then ``return <call>;``, where
   `<call>` is `jsonResult(await <local>(path))` for GET or
   `jsonResult(await <local>Send(path, "<METHOD>", <body>))` otherwise. The existing
   `pathFromJsonResult` reads that call — reuse it; do not write a second reader.
2. **The read helper gains a passthrough line.** `src/emit/server/fetch-helper.ts:203-204,218-219`:
   when the spec has any query tool, `renderFetchHelper` emits
   ``const url = path.startsWith("http") ? path : `<base>${path}`;`` and fetches `url` instead of the
   inline template. `src/derive/server/fetch-helper.ts` models only the non-passthrough form and the
   `normalizeLeadingSlash` const, so the helper itself stops being recognized the moment a query tool
   exists. **This is the trap that makes the recognizer useless without the fetch-helper half**: the
   tools would recognize and the helper would not.

- [ ] **Step 1: Write `fixtures/zzquery.spec.json`**

A synthetic hand-rolled connector with one query tool and one plain tool. Exercise the interaction the
emitter actually has: a query entry naming a **hoisted** arg (so `usedHoists` pulls it in), one naming
an unhoisted arg, one `omitWhen: "absent"`, one `omitWhen: "empty"`, and a non-string arg.

```json
{
  "name": "zzquery",
  "displayName": "ZZ Query",
  "description": "Synthetic fixture: the hand-rolled query branch and the fetch helper's passthrough form.",
  "serviceLabel": "ZZ Query",
  "style": "hand-rolled",
  "network": ["api.zzquery.test"],
  "syncInterval": 600,
  "minNimbusVersion": "0.2.0",
  "env": [
    { "vars": ["ZZQUERY_TOKEN"], "local": "headers", "auth": "bearer", "required": true }
  ],
  "fetchHelper": { "local": "zzGet", "base": "https://api.zzquery.test", "headers": "headers" },
  "tools": [
    {
      "name": "zzquery_item_list",
      "description": "List items, filtered.",
      "path": "/v1/items",
      "args": {
        "q": { "type": "string" },
        "after": { "type": "string", "optional": true },
        "filter": { "type": "string", "optional": true },
        "limit": { "type": "number", "default": 50 }
      },
      "query": [
        { "name": "q", "arg": "q" },
        { "name": "after", "arg": "after", "omitWhen": "absent" },
        { "name": "filter", "arg": "filter", "omitWhen": "empty" },
        { "name": "limit", "arg": "limit" }
      ]
    },
    {
      "name": "zzquery_item_get",
      "description": "Fetch a single item.",
      "path": "/v1/items/{itemId}",
      "args": { "itemId": { "type": "string" } }
    }
  ]
}
```

Run `parseSpec` on it and fix whatever the schema rejects before continuing. Then add to
`fixtures/expectations.json`:

```json
  "zzquery": []
```

`[]` is the correct expectation for a `zz`-prefixed synthetic fixture — it matches no real connector,
so "nothing should match" is the answer, not a gap. Follow the exact formatting of the neighbouring
`zz` entries.

- [ ] **Step 2: Emit it and read the output**

```bash
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
```
Expected: `PASS zzquery 0/N files identical (expected partial)`, and all four locked fixtures still
`6/6`. Then print the emitted `src/server.ts` (the one-liner from Task 3 Step 3) and **read it**. The
recognizer you are about to write must match those bytes. Note especially whether `limit`'s hoist
lands inside the query block and what the `new URL(...)` argument looks like with the base prefix.

- [ ] **Step 3: Write the failing round-trip assertion**

Add `"zzquery"` to `ROUND_TRIP` in `test/derive/round-trip.test.ts`.

```bash
bun test test/derive/round-trip.test.ts
```
Expected: FAIL — `zzquery` derives as blocked.

Record the exact blockers it reports. They are your work list, and they should be the fetch helper
plus the query tool's `reg(...)` call.

- [ ] **Step 4: Teach the read-helper recognizer the passthrough form**

In `src/derive/server/fetch-helper.ts`, the hand-rolled body parser (`parsed` around lines 438-479)
reads an optional `normalizeLeadingSlash` const then the fetch call. Add the passthrough const as a
second optional leading statement:

```ts
/**
 * `const url = path.startsWith("http") ? path : `<base>${path}`;` — the passthrough statement
 * `renderFetchHelper` emits IFF the spec declares a query tool (`hasQueryTool`, src/emit/server/
 * fetch-helper.ts). Structurally identical to `matchRestUrlConst`'s statement, which rest-kit
 * emits unconditionally — matched through the same reader rather than a second copy of it.
 *
 * Its presence is EVIDENCE, not a spec field: it appears exactly when some tool carries a `query`
 * array, so the caller cross-checks it against the recognized tools rather than recording it.
 */
```

Reuse `matchRestUrlConst` if its shape matches exactly; if it differs (check the base expression's
form and whether `normalizeLeadingSlash` can co-occur), factor the common half out rather than
copying. Return a `passthrough: boolean` alongside the existing fields.

- [ ] **Step 5: Cross-check passthrough against the tools**

In `src/derive/index.ts`'s `deriveSharedStyleSpec`, after tools are recognized:

```ts
  // `hasQueryTool` (src/emit/server/fetch-helper.ts) decides the read helper's passthrough line
  // from the SET of tools, so the two must agree in both directions. A helper with the line and no
  // query tool regenerates a helper without it; a query tool with no line regenerates one with it.
  // Either way the derived spec would not reproduce this module — the wrong-claim class, caught
  // here because neither recognizer can see the other's evidence on its own.
  const anyQuery = tools.some((t) => Array.isArray((t as { query?: unknown }).query));
  if (anyQuery !== fetchHelper.passthrough) {
    return blocked(
      "fetch-helper:query-passthrough-mismatch",
      `the read helper ${fetchHelper.passthrough ? "carries" : "lacks"} the absolute-URL ` +
        `passthrough line, but ${anyQuery ? "a tool declares" : "no tool declares"} a query array`,
    );
  }
```

Write the cast without `as` if `ToolFields` can carry `query` as a typed optional field — prefer
extending `ToolFields` with `query?: readonly QueryEntry[]` over casting, since `read.ts`'s whole
discipline is about not casting to reach a field.

**Add the base-prefix cross-check here too**, in the same place and the same form Task 3 added it to
`deriveRestKitSpec` — `deriveSharedStyleSpec` already has `fetchHelper` in scope, so it is a direct
port. Do not thread the base into `recognizeTools`.

**And the `staticPathStyle` abstention applies identically.** `renderPath`'s `!dynamic && prefix ===
""` fast path is shared by both styles, so a hand-rolled query tool carries no evidence either.
Confirm `zzquery` derives with `staticPathStyle` omitted rather than blocking on
`style:mixed-static-path` — its second tool (`zzquery_item_get`) has a dynamic path and abstains too,
so add a third, fully static tool to the fixture if that leaves the vote with no decisive evidence at
all. Read the derived spec and check, rather than assuming the round trip passing means the vote was
right: an abstain-everywhere connector and a correctly-voting one both round-trip.

- [ ] **Step 6: Add the hand-rolled query branch to `recognizeOne`**

Same placement rule as Task 3: after `recognizeHoistedBlock` fails, not instead of it. The tail is the
two-statement form; `path` must be the const the first tail statement binds, and the `jsonResult`
call's argument must be **that exact binding** — not any identifier. Reuse `pathFromJsonResult` for
the call so `method` recovery keeps working for a non-GET query tool.

- [ ] **Step 7: Run the round trip**

```bash
bun test test/derive/round-trip.test.ts
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
bun test --coverage
```
All exit 0, `zzquery` in `ROUND_TRIP`.

- [ ] **Step 8: Re-diff `grafana` specifically**

The design names this trap: `grafana` declares an argument named `query` with `"default": ""` and
`"local": "q"`, so it sits on the `isHoisted`/`renderHoists` path. "The four fixtures declare no
`query` array" is true and does not cover it.

```bash
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
```
Confirm `grafana 6/6` explicitly in your report, by name, not just "all four locked fixtures pass".

- [ ] **Step 9: Corpus check and commit**

```bash
bun run reach --nimbus-root C:/gitrep/Nimbus
bun run reach --verbose --nimbus-root C:/gitrep/Nimbus
```
```bash
git add src/derive/ test/derive/ fixtures/
git commit -m "feat(derive): read the hand-rolled query branch and the helper's passthrough form"
```

---

## Task 5: The body recognizer and the hand-rolled write helper

**Files:**
- Create: `src/derive/server/body.ts`
- Modify: `src/derive/server/fetch-helper.ts` (recognize and claim `<local>Send`),
  `src/derive/server/tools-hand.ts`
- Test: `test/derive/body.test.ts` (new), `test/derive/fetch-helper.test.ts`,
  `test/derive/round-trip.test.ts`

**Interfaces:**
- Consumes: `SchemaShape` (Task 2), `ToolFields` (existing).
- Produces: `src/derive/server/body.ts`:
  `export function recognizeBodyExpr(node: AstNode, tool: { args: Record<string, ArgFields>; path: string; query?: readonly QueryEntry[]; method: string }, param: string): { body?: Record<string, string> } | undefined`.
  Task 6 consumes it.

### What the emitter writes

`src/emit/server/body.ts:86-122`. The body is `JSON.stringify({ <fields> })` where each field is
either shorthand (`issueId`) or `key: value`, and the *value* has three cases
(`fieldValue:48-66`): a boolean is always the raw `<param>.<arg>`; a defaulted arg is the hoisted
const when one is in scope, else an inlined `<param>.<arg> ?? <default>`; everything else is the raw
arg.

**The `body` spec field is a MAPPING, and most tools do not set it.** With `tool.body === undefined`
the emitter builds the pairs from `Object.keys(tool.args)` minus every arg the path names and every
arg `query` names. So the recognizer's job is not "read the object literal into `body`" — it is:

> reconstruct what the *default* would have produced for this tool, and emit a `body` field **only
> when the observed literal differs from it**.

That is the same omit-when-it-is-the-default discipline `title`, `argsSchemaStyle` and
`staticPathStyle` already use, and getting it wrong produces a spec that regenerates a *different*
body ordering or an unnecessary explicit mapping.

The write helper itself (`renderWriteHelper`, `src/emit/server/fetch-helper.ts:133-171`) carries **no
spec field of its own** — every part of it is derived from `fetchHelper`, `serviceLabel` and whether
any tool is non-GET. So it is claimed-and-verified, and recovers nothing.

**No corpus connector has a `<local>Send` helper** — the sweep found zero. Three (`argocd`, `mlflow`,
`snyk`) carry a generic `xPost(path, body)`, and sixteen use a single `xFetch(path, init?)` for reads
and writes alike. Pin this matcher to the `Send` name and the exact three-parameter signature the
emitter writes; do **not** widen it toward `xPost` or `xFetch`, which recover a different helper
shape and would need their own spec field to regenerate. Expect no corpus movement from this task.

- [ ] **Step 1: Write the failing test for the write helper**

`zzwriteonly` reports `function:zzGetSend` as its first blocker. Add to
`test/derive/fetch-helper.test.ts`, following that file's existing harness:

```ts
  it("recognizes and claims the write helper `<local>Send`, which carries no spec field of its own — every line of renderWriteHelper is derived from fetchHelper, serviceLabel and the presence of a non-GET tool", () => {
    /* emit zzwriteonly, parse, assert the <local>Send FunctionDeclaration is claimed */
  });

  it("refuses a `<local>Send` whose error message names a different serviceLabel than the read helper's", () => {
    /* both helpers interpolate spec.serviceLabel; a module where they disagree is one the
       emitter cannot have written, and claiming it would derive a spec that regenerates neither */
  });
```

Fill in the bodies against the harness that file already uses. Read it first.

- [ ] **Step 2: Run — must FAIL**

```bash
bun test test/derive/fetch-helper.test.ts
```

- [ ] **Step 3: Recognize the write helper**

Add `recognizeWriteHelper(statements, claims, readHelper)` to `src/derive/server/fetch-helper.ts`. It
is pinned all the way down, because it claims a whole function:

- name is exactly `${readHelper.local}Send`;
- `async`, three parameters named `path`, `method`, `body` with types `string`, `string`,
  `string | undefined`, returning `Promise<unknown>`;
- the optional passthrough const (Task 4's, present iff a query tool exists);
- `await fetch(<url>, { method, headers: { ...<headerExpr>, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body }) })`;
- the `res.ok` throw whose template names the same `serviceLabel` as the read helper;
- the `try { return JSON.parse(text) as unknown; } catch { return null; }` tail.

`headerExpr` must be the **same** expression the read helper carries (`headerOption(spec)` with the
`headers: ` prefix stripped). Cross-check it against the read helper's recovered headers rather than
re-deriving a spec field from it — the read helper is the authority, and two recognizers producing
`headers` independently is how they drift.

Claim the function's statement only when every clause matches.

- [ ] **Step 4: Write the failing test for the body reader**

Create `test/derive/body.test.ts`. Emit a hand-rolled spec with:
- a POST whose body is the default (no `body` field in the spec);
- a POST with an explicit `body` mapping that renames a field;
- a POST with a boolean arg (proving the raw-arg case);
- a POST with a defaulted arg that is also in the path (proving the hoisted-const case);
- a DELETE whose only arg is in the path (`renderBodyExpr` returns `undefined` → a literal
  `undefined` third argument).

Assert the recovered spec **omits** `body` for the default case and **sets** it for the renamed one.

- [ ] **Step 5: Run — must FAIL (module does not exist)**

- [ ] **Step 6: Write `src/derive/server/body.ts`**

```ts
/**
 * The inverse of src/emit/server/body.ts's `renderBodyExpr`.
 *
 * Returns a `body` mapping ONLY when the observed literal differs from what the DEFAULT would have
 * produced for this tool — `Object.keys(tool.args)` minus every arg the path names and every arg
 * `query` names, in that order. Recording the mapping unconditionally would write an explicit
 * `body` into every derived spec, which parses and emits identical bytes today but states
 * something the connector's author never did, and diverges the moment the default's exclusion set
 * changes (it already grew once, when `query` joined `pathArgs` — see renderBodyExpr's docstring).
 */
```

Verify each field's value expression against the arg's recovered type and default, mirroring
`fieldValue`'s three cases exactly. A value that matches none of them refuses the tool.

- [ ] **Step 7: Wire it into `recognizeOne`**

The write call is already recognized — `fetchCall` reads `<local>Send(path, "METHOD", body)` and
recovers `method`. It currently ignores `args[2]`. Read it now, and refuse when it is neither a
recognized body expression nor the literal `undefined`.

- [ ] **Step 8: Move `zzwriteonly` to `ROUND_TRIP` and run every gate**

```bash
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
bun test --coverage
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus
```
Update the `BLOCKED` docstring's "write body" paragraph — it currently describes two gaps; one is now
closed and the other is Task 6's.

- [ ] **Step 9: Commit**

```bash
git add src/derive/ test/derive/
git commit -m "feat(derive): read the JSON body and claim the hand-rolled write helper"
```

---

## Task 6: The rest-kit `initFn` — arity-5 registrar calls

**Files:**
- Modify: `src/derive/server/tools-rest.ts`
- Test: `test/derive/tools-rest.test.ts`, `test/derive/round-trip.test.ts`

**Interfaces:**
- Consumes: `recognizeBodyExpr` (Task 5).
- Produces: nothing new exported.

`recognizeOneCall` refuses arity 5 outright today, deliberately — "refused here, rather than read for
its first four arguments only, so a connector that needs it blocks visibly on a named blocker instead
of deriving a `GET` the real connector never had." That refusal was correct while nothing could read
the fifth argument. Now something can.

What the emitter writes (`src/emit/server/tools-rest.ts:102-107`):

```
  () => ({ method: "DELETE" }),
  (parsed) => ({ method: "POST", body: JSON.stringify({ … }) }),
```

The parameter is `()` when there is no body and `(parsed)` when there is — forced by the generated
package's `noUnusedParameters`. Pin that correspondence: a `(parsed) => ({ method: "DELETE" })` is a
shape the emitter cannot write.

**The rest-kit body is built with an EMPTY hoist map** (`renderTool` passes `new Map()`), because the
init callback is a different arrow from the path callback and nothing the latter declares is in scope.
So a defaulted arg renders the inlined `?? <default>` form here and the hoisted-const form in the path
callback — the same argument, two different expressions, deliberately. Pass an empty `locals` map to
`recognizeBodyExpr` from this call site and say why in a comment.

- [ ] **Step 1: Write the failing test**

In `test/derive/tools-rest.test.ts`, emit a rest-kit spec with a `DELETE` (no body) and a `PATCH`
(with a body), assert both recover with the right `method` and `body`, and add refusals for:
- a fifth argument that is not an arrow;
- an arrow returning an object with a third key;
- `(parsed) => ({ method: "DELETE" })` — a parameter with no body;
- `() => ({ method: "POST", body: … })` — a body with no parameter.

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Accept arity 5 in `registrarCallParts` and `recognizeOneCall`**

Widen the arity check to `4 | 5`, return the optional fifth node, and add its reader. Update
`registrarCallParts`' docstring — it currently says "arity 4 only, for the reason `recognizeOneCall`
documents", and that reason is now historical. Say what is true and cite this task.

`ToolFields` already carries the optional `method`; a GET (arity 4) keeps omitting it so
`ToolSchema`'s `.default("GET")` applies.

- [ ] **Step 4: Move `zzwriterest` to `ROUND_TRIP`, run every gate, commit**

```bash
bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/ && bun test --coverage
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --verbose --nimbus-root C:/gitrep/Nimbus
```
```bash
git add src/derive/ test/derive/
git commit -m "feat(derive): read the rest-kit initFn, recovering method and body from arity-5 calls"
```

---

## Task 7: The stub tool handler

**Files:**
- Modify: `src/derive/server/tools-hand.ts`
- Test: `test/derive/tools-hand.test.ts`, `test/derive/round-trip.test.ts`

**Interfaces:**
- Consumes: `ToolFields`.
- Produces: `ToolFields` gains `impl?: "stub"` and `path` becomes optional on a stub. Check
  `ToolSchema` first: a stub is pinned to `method: "GET"` by its refine and must have **no** `path`.

This gap is **not** in the design's item list. It is included because it is the last thing standing
between this plan and an empty `BLOCKED` list, it is a shape the emitter genuinely writes
(`impl: "stub"`), and it is small. `bitrise` reports three unclaimed `call:reg` statements plus both
search imports; two of the three are stubs, and `recognizeTools` being all-or-nothing means those two
block its search tool and its imports as well.

What the emitter writes (`src/emit/server/tools-hand.ts:53-65`), and the rest-kit twin
(`tools-rest.ts:62-67`) which takes `() => { throw … }` with **no** `async`:

```
reg(
  "<name>",
  "<description>",
  <schema>,
  async () => {
    throw new Error("<name> is not implemented");
  },
);
```

- [ ] **Step 1: Write the failing test**

In `test/derive/tools-hand.test.ts`, emit a spec with one stub tool and one real tool; assert the stub
recovers as `{ name, description, args, impl: "stub" }` with **no `path`** and **no `method`**.
Refusals, each with the not-equal guard:
- a throw whose message is not exactly `` `${name} is not implemented` `` → refused (the message is
  derived from the tool name, so a different one is a hand-written stub the emitter did not produce);
- a handler that throws something other than `new Error(...)` → refused;
- a block with a statement before the throw → refused;
- a stub handler taking a parameter → refused (`renderTool` writes `async ()` always).

- [ ] **Step 2: Run — must FAIL**

- [ ] **Step 3: Add `recognizeStub` to `tools-hand.ts`**

A third fallback in `recognizeTools`' loop, after `recognizeOne` and `recognizeSearchShape`:

```ts
  const shape =
    recognizeOne(call, helperLocal) ??
    recognizeSearchShape(call, helperLocal) ??
    recognizeStubShape(call);
```

`recognizeStubShape` reports `isBlock: true, hasHoists: false` **and must be excluded from the
`handlerStyle` vote**, for exactly the reason `renderSearchTool`'s shape is: `renderTool`'s stub
branch writes a block regardless of `spec.handlerStyle`, so counting it would force
`handlerStyle: "block"` onto every connector with a stub. Reuse the `isSearch` exclusion mechanism —
rename that field to something that names the concept (`votesOnStyle: false`, say) rather than adding
a second boolean, and update `ToolShape`'s docstring.

Do the same for the rest-kit stub in `tools-rest.ts` — it is three lines and the fixture `bitrise` is
hand-rolled, but leaving one style able to read a shape the other cannot is how the two files drifted
before `hoists.ts` was extracted.

- [ ] **Step 4: Move `bitrise` to `ROUND_TRIP`, run every gate, commit**

`bitrise`'s two search imports should now claim, because `claimSearchImports` runs once `toolsResult`
succeeds. Confirm that in the round-trip run rather than assuming it.

```bash
bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/ && bun test --coverage
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
```
`bitrise` is a real-connector fixture with an expectation entry of `4/7`. Confirm it is **unchanged** —
this task touches no emitter, so its diff cannot move.

```bash
git add src/derive/ test/derive/
git commit -m "feat(derive): read the stub tool handler in both registration styles"
```

---

## Task 8: `client-credentials`

**Files:**
- Modify: `src/derive/server/env.ts`, `src/derive/read.ts` (one new accessor)
- Test: `test/derive/env.test.ts`, `test/derive/round-trip.test.ts`

**Interfaces:**
- Consumes: `EnvEntry` (existing, `src/derive/server/env.ts:35`).
- Produces: nothing new exported.

This is the last blocked fixture and the largest single emitted construct in the codebase:
`renderClientCredentials` (`src/emit/server/env.ts:181-189`) emits **four** module-scope statements —
`let cachedToken`, `let tokenExpiresAt`, `async function token()`, and `async function <local>()` —
which must be claimed as **one** entry, the way the split-bearer pair already is.

`zzwrite` reports all four as separate blockers today, plus its read helper, its write helper and
three `reg` calls. Tasks 5 and 6 clear the last five; this task clears the first four. **Run
`deriveSpec` against `zzwrite` before starting** to confirm what actually remains — do not work from
the table at the top of this plan, which was measured before Tasks 5–7 existed.

The fields to recover, all from `EnvSchema`: `vars` (two, in order), `bindings` when they differ from
`camel(var)`, `tokenUrl`, `credentialsIn` (`"body"` → two `body.set` lines for `client_id`/
`client_secret`; `"basic"` → the `encodeBasicAuthHeader` Authorization header), `scope` (present iff a
`body.set("scope", …)` line exists), and `local`. `auth` is `"client-credentials"`.

Everything else in that 30-line function is a constant: the cache check, the skew comment, the
`expires_in` arithmetic, the two error messages (which interpolate `serviceLabel`). **Verify every
one of them.** A module differing in the skew arithmetic derives a spec that regenerates different
bytes, and the totality rule cannot see it because the statement was claimed.

- [ ] **Step 1: Add the `let` accessor**

`read.ts` has `uninitializedLet` but nothing for `let cachedToken: string | null = null;` — a `let`
with both a type annotation and an initializer. Add:

```ts
/**
 * `let <name>: <type> = <init>;` / `let <name> = <init>;` — the two module-scope bindings
 * `renderTokenFunction` (src/emit/server/env.ts) emits above the token exchange. `constDecl`
 * refuses these by design (its `kind === "const"` guard, added because `let reg = …` was being
 * claimed as the documented const frame), and `uninitializedLet` covers only the no-initializer
 * case, so neither fits.
 */
export function letDecl(node: AstNode | undefined): ConstDecl | undefined {
```

Unit-test it in `test/derive/read.test.ts`: the annotated form, the bare form, a `const` returning
`undefined`, and a `let` with no initializer returning `undefined`.

- [ ] **Step 2: Write the failing test**

In `test/derive/env.test.ts`, emit `zzwrite`'s env accessor with this repo's emitter and assert
`recognizeEnv` recovers exactly one entry with every field above. Then refusals, each guarded with
`expect(corrupted).not.toBe(pristine)`:
- `cachedToken` initialized to something other than `null`;
- `tokenExpiresAt` initialized to something other than `0`;
- a skew constant other than `60`;
- a `body.set("scope", …)` naming a non-literal;
- `credentialsIn: "basic"` with the `client_id`/`client_secret` body lines *also* present (a shape
  `renderTokenFunction`'s if/else cannot produce);
- the wrapper's `Authorization` value not exactly `` `Bearer ${await token()}` ``.

- [ ] **Step 3: Run — must FAIL**

- [ ] **Step 4: Write the recognizer as a THIRD sequential pass**

`recognizeEnv` already runs two passes: Pass A finds reader+wrapper pairs across the whole statement
list and claims both in one `claims.claim()`; Pass B is the plain-accessor loop. Client-credentials is
a four-statement group, so it needs the same treatment and it must run **before** Pass B, or the
wrapper gets claimed as a standalone plain accessor first — the exact live instance of the
wrongly-claimed class that motivated Pass A.

Add Pass A′ between them (or extend Pass A to look for both group shapes — either is fine, but say
which and why in the docstring). Claim all four statements in one call.

`recognizeEnv` re-sorts its entries into declaration order by index — that sort is load-bearing for
`zendesk`'s byte order. Make sure a four-statement group sorts by its **first** statement's position.

**Pin what happens when the group is only partly well-formed.** The hazard is not a confusing error
message; it is Pass B claiming the wrapper as a standalone plain accessor after Pass A′ has refused
the group, which derives a spec carrying a bogus plain env entry — the wrong-claim class again.

Task 1's return-type and async pins are what actually close this: the wrapper is
`async function <local>(): Promise<Record<string, string>>`, and a `recognizeOne` that requires
non-async and a bare `Record<string, string>` refuses it. **That is an interaction between two tasks,
which is exactly the kind of thing that survives until someone reorders them**, so prove it here:

```ts
  it("leaves the wrapper UNCLAIMED when the token exchange is malformed — Pass B must not pick it up as a plain accessor, which would derive an env entry the module never declared. The guard is recognizeOne's async/return-type pin (Task 1); this test is what stops a later change from removing it silently.", () => {
    const source = CLIENT_CREDENTIALS_MODULE.replace("let tokenExpiresAt = 0;", "let tokenExpiresAt = 1;");
    expect(source).not.toBe(CLIENT_CREDENTIALS_MODULE);
    const result = deriveSpec({ server: source, manifest: MANIFEST });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // the wrapper is reported as unclaimed, NOT silently absorbed into an env entry
      expect(result.blockers.some((b) => b.kind === "function:authHeaders")).toBe(true);
    }
  });
```

**Deferred, deliberately:** the review also suggested a descriptive near-miss blocker
(`client-credentials:…`) for a partly-matching group. Declined for now. The four statements already
report as `statement:VariableDeclaration`, `function:token` and `function:<local>`, which names each
unclaimed construct precisely, and a near-miss label needs a definition of "partly" — the thing
`frameFailureKind` needed a whole precedence order to get right. A label that guesses wrong is a
worse diagnostic than four accurate ones. Record it as a possible follow-up in your report; do not
build it in this task.

- [ ] **Step 5: Move `zzwrite` to `ROUND_TRIP` — and empty `BLOCKED`**

`BLOCKED` becomes `{}`. The `accounts for every fixture in fixtures/` test requires every fixture to
be in exactly one list, so this is the moment it is satisfied by `ROUND_TRIP` alone.

**Rewrite both docstrings.** `BLOCKED`'s is now a statement about a list that is empty — say that all
21 fixtures round-trip, and keep the rule that any future entry's reason must be measured by running
`deriveSpec`. Do not leave a docstring describing gaps that no longer exist; that file's comment has
gone stale three times and each time it was because a task closed a gap and edited only the list.

- [ ] **Step 6: Run every gate, then the full corpus set**

```bash
bun test
bunx tsc --noEmit
bunx biome check src/ test/ scripts/
bun test --coverage
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus
bun run reach --verbose --nimbus-root C:/gitrep/Nimbus
bun run wiring:conformance --nimbus-root C:/gitrep/Nimbus
```
Report every exit code.

**Expect no corpus movement, and do not widen to chase it.** Three corpus connectors run a
client-credentials exchange — `powerbi`, `ramp`, `wiz` — and the sweep found **no two of them share a
shape**: they differ on the cache variable (`let cachedToken: string | null = null` in ramp,
`let cachedToken: string | undefined` with no initializer in wiz, no cache at all in powerbi), the
function name, whether credentials go in a Basic header or the POST body, `scope` versus `audience`,
and whether the endpoint is a literal or built from an env var. None reads `expires_in`, and
`tokenExpiresAt` appears nowhere in the corpus. All three also import `./search-filter.ts` and
`../../shared/mcp-search-tool.ts`, so all three stay blocked regardless. Match what
`renderClientCredentials` writes and nothing else; the divergence is Task 12's to record.

- [ ] **Step 7: Commit**

```bash
git add src/derive/ test/derive/
git commit -m "feat(derive): read the client-credentials token exchange as one four-statement entry"
```

---

## Task 9: Case 2 — the hoisted rows pluck

**Files:**
- Modify: `src/derive/server/search.ts`
- Modify: `docs/ROADMAP.md` (*Considered and declined* — condition (a))
- Test: `test/derive/search.test.ts`

**Interfaces:**
- Consumes: `SearchToolFields` (existing).
- Produces: nothing new exported.

### This is a case-2 widening, and the measurement narrows it

The design's §4.1 states the application as "`dagsFrom(root)` → `rows: "dags"`". **A sweep of the
corpus found 18 such helpers in 18 connectors, in four distinct body shapes — and only two of the
four are recoverable.** The guard idiom is uniform: every one of the 18 ends in
`Array.isArray(X) ? X : []`, the keyed read is always `(root as { K?: unknown } | null)?.K` with
optional-chained dot access, and the parameter is named `root` in 18 of 18. The **binding** name is
not uniform (`workday` binds `d`; `mlflow` binds `models` for the key `registered_models`), so the
matcher must not key on it.

| shape | body | connectors | verdict |
| --- | --- | --- | --- |
| **A** keyed only | `const k = (root as { K?: unknown } \| null)?.K; return Array.isArray(k) ? k : [];` | airflow, canva, databricks, figma, hubspot, miro, ramp, salesforce, mlflow, workday (10) | **accept** → `rows: "<K>"` |
| **B** root-array only | `return Array.isArray(root) ? root : [];` | dependencytrack, prefect (2) | **accept** → no `rows` field |
| **C** array-first prelude | `if (Array.isArray(root)) { return root; }` then A | metabase, dbt, flagsmith, flux, argocd (5) | **refuse** |
| **D** keyed-first, root fallback | `if (Array.isArray(k)) { return k; } return Array.isArray(root) ? root : [];` | superset (1) | **refuse** |

**Why C and D are refused, and this is the whole point of condition (b).** Case 2 licenses a
divergence in emitted *text*, not in *behaviour*. Shapes A and B differ from the emitter's inline form
only in coercion — `Array.isArray(x) ? x : []` versus handing the value straight to `matchesResult`,
which guards with `Array.isArray` itself, so both produce the same matches. That is precisely the
divergence *Considered and declined* records as "Coercing the row set before `matchesResult`". Shapes
C and D carry a **fallback**: they return the root when the root itself is an array. The emitter's
form does not, so a spec derived from one regenerates a connector that behaves differently on a
response the fallback exists for. Recovering `rows` from those is not a case-2 widening, it is a wrong
derivation — and it would be reported as `emits`, which is exactly the false `emits` the case-2 rule's
condition (b) is written to catch.

**Verify this claim about `matchesResult` before relying on it.** Read
`C:/gitrep/Nimbus/packages/mcp-connectors/shared/mcp-search-tool.ts` and confirm it guards a non-array
input rather than throwing. Reading it is fine; copying any of it into this repo is not. If it does
not guard, shapes A and B are **also** refused and this task ships as a refusal plus a documented
limitation — report that outcome rather than widening anyway.

- [ ] **Step 1: Record the divergence in `docs/ROADMAP.md` — condition (a) first**

Case-2 condition (a) requires the divergence to be recorded *before* the recognizer claims it. Find
the *Considered and declined* entry for "Coercing the row set before `matchesResult`" and extend it,
or add a *Known limitations* entry if it is not there. State: the corpus's hoisted pluck helper is
recognized and recovers `rows`, the emitter writes the pluck inline, so those connectors reach `emits`
and not `server-identical`; and that shapes C and D are refused with the reason above. **Do not
restate live numbers** — say "shapes with an array-first prelude or a root fallback", not "6
connectors", which goes stale silently.

- [ ] **Step 2: Write the failing test**

In `test/derive/search.test.ts`, build four synthetic modules — one per shape — each with a search
tool whose handler is `return matchesResult(<helper>(await <local>(<path>)), <filter>, p);`. These are
hand-synthesized, not transcribed: use the `zz` naming and a key no corpus connector uses.

```ts
  it("recovers rows from shape A, the keyed pluck helper — a case-2 widening: the emitter writes the pluck inline, so this reaches `emits` and not `server-identical` (see ROADMAP's Considered and declined)", () => { /* → rows: "widgets" */ });

  it("recovers shape B, the root-array helper, as NO rows field — matchesResult guards a non-array itself, so the emitter's no-rows form is behaviourally identical", () => { /* → rows absent */ });

  it("REFUSES shape C, the array-first prelude — it returns the root when the root is an array, behaviour the emitter's inline form does not have, so `rows` would be a wrong derivation rather than a text divergence", () => { /* → undefined */ });

  it("REFUSES shape D, the keyed-first root fallback — same reason as shape C", () => { /* → undefined */ });
```

Plus condition (b)'s own test: for shape A, derive the spec and assert **every** recovered field of
that tool — `name`, `description`, `args`, `path`, `maxLimit`, `filter.export`, `rows` — equals the
spec that produced the fixture, not just `rows`. Condition (b) is "a test proves every spec field
recovered from that shape is correct", and a test asserting only the new field does not meet it.

- [ ] **Step 3: Run — all four must FAIL**

- [ ] **Step 4: Implement**

`src/derive/server/search.ts` already has `matchRowsNarrowing` for the emitter's inline form. Add a
module-scope pluck-helper matcher and a fourth body form:

```ts
/**
 * A hoisted rows pluck: `function <name>(root: unknown): unknown[] { … }` in one of the two shapes
 * that are behaviourally identical to what `renderSearchTool` writes inline.
 *
 * Case 2 (see the case-2 rule): the emitter cannot write this text, so a connector using it reaches
 * `emits` and never `server-identical`. Accepted anyway because every recovered field is provably
 * correct — the pluck key, and nothing else. Shapes carrying a fallback to the root array are
 * REFUSED: that is a behaviour difference, not a text difference, and `rows` cannot express it.
 * Measured across the corpus 2026-08-06: one guard idiom, four body shapes, two recoverable.
 */
function matchPluckHelper(node: AstNode): { name: string; rows?: string } | undefined {
```

The call site: `matchesResult(<helper>(<fetchExpr>), <filter>, <param>)` where `<helper>` resolves to
a recognized pluck helper **in this module**. Claim the helper's own statement — it is a top-level
statement and the totality rule will otherwise report it — and claim it **only** when a search tool
actually calls it, the same scoping `claimSearchImports` uses. A pluck helper nothing calls stays
unclaimed and blocks, correctly.

- [ ] **Step 5: Run every gate and measure the corpus**

```bash
bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/ && bun test --coverage
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --verbose --nimbus-root C:/gitrep/Nimbus
```
The 12 accepted connectors are `airflow, canva, databricks, figma, hubspot, miro, ramp, salesforce,
mlflow, workday, dependencytrack, prefect`. Most carry other blockers too (`call:reg`,
`import-from:./search-filter.ts`), so **the expected result is that their `function:<name>From`
buckets disappear, not that they become `emits`**. Report the before/after of those buckets by name.

- [ ] **Step 6: Commit**

```bash
git add src/derive/ test/derive/ docs/ROADMAP.md
git commit -m "feat(derive): recover rows from a hoisted pluck helper, refusing the fallback shapes"
```

---

## Task 10: Blocker-label honesty

**Files:**
- Modify: `src/derive/manifest.ts`, `src/derive/index.ts`, `src/derive/server/index.ts`
- Test: `test/derive/manifest.test.ts`, `test/derive/blockers.test.ts`, `test/derive/frame*.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: two new blocker kinds. No claim changes.

**This task changes no tier and no reach number, by design.** It changes what the histogram *says*.
Both items below are labels, and labels are allowed to be more permissive than claims.

### Item A — `iac` is not missing a manifest

`iac` reports `no-manifest`. **Its `nimbus.extension.json` exists and is well-formed**; it has no
`syncInterval`, and `deriveManifest`'s `req()` throws with a message that says so — which
`deriveSpec` then discards into a blocker labelled `no-manifest`. The label sends a reader to look for
a file that is right there.

- [ ] **Step 1: Write the failing test**

In `test/derive/manifest.test.ts`, assert that a manifest missing one required key produces a blocker
naming **that key**, and that an absent or unparseable file still produces `no-manifest`:

```ts
  it("names the missing key rather than claiming there is no manifest — a well-formed manifest without one field is a different failure from a file that is not a manifest at all (iac is the live instance: it has a manifest and no syncInterval)", () => {
    const result = deriveSpec({ server: MINIMAL_SERVER, manifest: MANIFEST_WITHOUT_SYNC_INTERVAL });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers[0]?.kind).toBe("manifest:missing-syncInterval");
  });

  it("still reports no-manifest for input that is not JSON at all", () => {
    const result = deriveSpec({ server: MINIMAL_SERVER, manifest: "not json" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers[0]?.kind).toBe("no-manifest");
  });
```

- [ ] **Step 2: Run — the first must FAIL**

- [ ] **Step 3: Carry the key on the error**

Give `req`/`reqString` a typed error carrying the key:

```ts
/** A manifest that IS a manifest but lacks a key the emitter always writes — distinct from a file
 *  that is absent or unparseable, which is what `no-manifest` means. */
export class MissingManifestKey extends Error {
  constructor(readonly key: string) {
    super(`nimbus.extension.json has no "${key}" — it is not a connector manifest.`);
  }
}
```

Reword the message too: "it is not a connector manifest" is the sentence that produced the wrong
label. Say what is true — the key is missing.

In `deriveSpec`, map it:

```ts
  } catch (err) {
    if (err instanceof MissingManifestKey) {
      return blocked(`manifest:missing-${err.key}`, err.message);
    }
    return blocked("no-manifest", err instanceof Error ? err.message : String(err));
  }
```

Check `src/derive/from-connector.ts` — it reads the directory and must keep reporting a genuinely
absent file as its own thing. Confirm by reading it; do not assume.

### Item B — the eleven shim connectors

`athena`, `bigquery`, `cloud-logging`, `cloudwatch`, `dataprofile`, `elasticsearch`,
`great-expectations`, `localdb`, `sagemaker`, `storybook` and `vertex-ai` each have a **6-line**
`src/server.ts` that is nothing but a frame: an import from `./tools.ts` and
`await runReadOnlyMcpConnector("nimbus-<x>", (reg) => { register<X>Tools(reg); });`. The read-only
frame **already matches** — so they report two unrelated buckets, `import-from:./tools.ts` and
`call:register<X>Tools`, neither of which says "every tool lives in another file".

- [ ] **Step 4: Write the failing test**

In `test/derive/frame-readonly.test.ts` (or `blockers.test.ts` — put it where the existing
frame-label tests live), synthesize that 6-line shape and assert the reported blocker kind is
`frame:tools-in-second-file`.

- [ ] **Step 5: Implement as a LABEL, not a claim**

The statements stay unclaimed — nothing changes about what derives. Add the collapse where the
blockers are built, in `deriveSharedStyleSpec`:

```ts
  const unclaimed = claims.unclaimed(frame.verifyStatements);
  if (unclaimed.length > 0) {
    return { ok: false, blockers: collapseSecondFileBlockers(unclaimed, serverSource) };
  }
```

`collapseSecondFileBlockers` returns the ordinary per-statement blockers **unless** the unclaimed set
is exactly {an import from a relative `./…` module, one call to a name that import binds} — in which
case it returns a single `frame:tools-in-second-file` blocker naming the module. Pin both halves: the
called name must be one the import actually binds (`importNames`), or a connector importing one thing
and calling another gets a label that lies in a new way.

Do not extend this to `frame:no-registrar`'s four (`apple`, `fastmail`, `imap`, `protonmail`) — those
also delegate to `./tools.ts` but fail the frame *before* recognition, so their label is already
accurate and reaching them would mean modeling the `register<X>Tools(server, …)` call, which is
downstream work, not labelling.

- [ ] **Step 6: Run the gates and confirm nothing moved**

```bash
bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/ && bun test --coverage
bun run reach --nimbus-root C:/gitrep/Nimbus
bun run reach --verbose --nimbus-root C:/gitrep/Nimbus
```
**`REACH` must be unchanged.** The `--verbose` histogram must show `no-manifest` replaced by
`manifest:missing-syncInterval` (1, `iac`) and the two 11-member buckets replaced by
`frame:tools-in-second-file` (11). A tier that moved means this task claimed something; find it.

- [ ] **Step 7: Commit**

```bash
git add src/derive/ test/derive/
git commit -m "fix(derive): name the missing manifest key and the tools-in-a-second-file frame"
```

---

## Task 11: Case 2 — the three frame idioms

**Files:**
- Modify: `src/derive/server/index.ts`, `src/derive/server/frame.ts` (docstring)
- Modify: `docs/ROADMAP.md` (*Known limitations* — condition (a))
- Test: `test/derive/frame.test.ts`, `test/derive/frame-readonly.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `recognizeFrame`/`recognizeReadOnlyFrame` accept three additional module shapes.

### The three shapes, measured

**The design's item 13 named `frame:readonly-callback-not-inline` as the third axis. That bucket is now
empty** — upstream commit `b3a6f159` refactored those ten connectors, and they report
`frame:no-mcp-server` today. The dead label is retired here, and the axis is retargeted at the shape
they actually carry now.

**Axis 1 — the split registrar (13: `bitbucket`, `confluence`, `discord`, `github`, `gitlab`,
`google-meet`, `google-photos`, `jira`, `linear`, `notion`, `obsidian`, `slack`, `teams`).** One
shape, uniformly: two module-scope consts instead of one nested call.

```ts
const registerSimpleTool = createRegisterSimpleTool(<mcpVar>);
const reg = createZodToolRegistrar(registerSimpleTool);
```

The intermediate binding is a `const`, never a `function` declaration, in all 13. **Do not require a
blank line** between the `McpServer` const and this pair — 12 of 13 have one, `obsidian` does not.
Claim **both** statements. Verify the intermediate const's own name is the identifier the second one
passes; do not pin it to the literal `registerSimpleTool`, which is a claim about naming rather than
structure.

**Axis 2 — the inlined transport tail (4: `gmail`, `google-drive`, `onedrive`, `outlook`).** One
shape, uniformly, as the file's last statement:

```ts
await <mcpVar>.connect(new StdioServerTransport());
```

There is no transport const at all. `isInlinedTransportConnect` already recognizes this shape as a
*label*; this task promotes it to a claim, gated on the strict two-statement form being absent.

**These two must land together.** `frameFailureKind` checks the registrar element before the transport
one, so `google-meet` and `google-photos` — which write both near misses — are reported on the
registrar axis and stay blocked if only one closes.

**Axis 3 — the named read-only registrar (10: `argocd`, `bigeye`, `flux`, `looker`, `mlflow`,
`monte-carlo`, `powerbi`, `snowflake`, `tableau`, `workday`).** Three top-level statements:

```ts
export function register<X>Tools(reg: ZodToolRegistrar): void {
  /* the registrations */
}

export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-<x>", register<X>Tools);
}

if (import.meta.main) await startConnector();
```

`startConnector` is **defined locally in each connector**, not imported; what is imported from
`../../shared/run-read-only-mcp-connector.ts` is `runReadOnlyMcpConnector` and the type
`ZodToolRegistrar`. The second argument is a **bare function reference**, never an inline arrow. The
only variance across the 10 is a two-line `//` comment above `startConnector`, present in 6 and absent
in 4 — so the matcher must not use `hasLeadingComment` as a discriminator here.

**The two-list contract applies and is the crux.** `register<X>Tools`' body *contains* the
registrations, so claiming that statement would cover every one of them by containment and produce
exactly the false `emits` the contract exists to prevent. So:

- remove `register<X>Tools`' declaration from `verifyStatements` and splice its **body** in;
- `toolStatements` = that body;
- claim `startConnector` and the `if (import.meta.main)` guard — neither nests a registration;
- claim the frame imports.

That is the same treatment `recognizeReadOnlyFrame` already gives its inline wrapper, with one more
statement. Say so in the docstring and cite `frame.ts`.

**Do not "mark the function declaration claimed once its body statements are claimed."** It is the
obvious-looking alternative and it is the precise anti-pattern `frame.ts` exists to document: claims
are byte ranges and coverage is **containment**, so claiming the declaration covers every registration
inside it transitively. The totality rule would then find nothing unclaimed and a connector whose
tools were never recognized would derive successfully — a false `emits` produced by the very mechanism
the rule exists to remove. Removing the declaration from `verifyStatements` is the whole point; there
is no second step.

There is no overlapping-claim hazard in the correct design, and it is worth being precise about why:
`startConnector`'s range contains the `runReadOnlyMcpConnector` call but **not** `register<X>Tools`'
body, so claiming it covers nothing a tool recognizer needs to claim. The body statements lie inside
the declaration's range, and the declaration is never claimed, so they stay uncovered until a tool
recognizer claims them individually — which is exactly the behaviour wanted.

**Prove it rather than reasoning about it.** Add this test alongside the three round-trip ones:

```ts
  it("does NOT derive when the spliced registrations are not recognized — the register<X>Tools declaration is removed from verifyStatements and never claimed, so an unrecognizable registration inside it still blocks. Claiming that declaration instead would cover every registration by containment and produce a false `emits`, which is the hazard frame.ts documents.", () => {
    // the axis-3 frame, with one registration replaced by a call no recognizer models
    const source = AXIS_3_MODULE.replace("reg(", "somethingElse(");
    expect(source).not.toBe(AXIS_3_MODULE);
    const result = deriveSpec({ server: source, manifest: MANIFEST });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blockers.some((b) => b.kind === "call:somethingElse")).toBe(true);
  });
```

The assertion that matters is `ok: false`. If it ever returns `ok: true`, the declaration is being
claimed and the frame is producing false derivations — stop and fix the claim, not the test.

### Why all three are case 2

Every one of them recovers exactly the same fields the canonical shape does — the connector `name`
from the `"nimbus-<x>"` literal, and the statement lists. Nothing else. `wiring()` and `tail()`
hardcode the inlined registrar and the two-statement transport, so re-emission writes the canonical
form and these connectors reach **`emits`**, never `server-identical`. That is the honest outcome and
the design chose it deliberately: reaching `server-identical` would need cosmetic spec fields, and the
operative bar is "no cosmetic field without a fixture that byte-matches *because of* it" — no such
fixture can exist for these until something behind those frames has been measured, which is what this
task makes possible.

- [ ] **Step 1: Record all three divergences in `docs/ROADMAP.md` — condition (a) first**

Add to *Known limitations*: the split-registrar form, the inlined-transport tail, and the named
read-only registrar are each recognized and derive a spec, and each re-emits in this generator's own
form, so those connectors reach `emits` and not `server-identical`. Name the construct, not the count.
Also correct any existing text that names `frame:readonly-callback-not-inline`, which no longer
exists.

- [ ] **Step 2: Write the failing tests — condition (b)**

For **each** of the three axes, in `test/derive/frame.test.ts` / `frame-readonly.test.ts`:

1. Take a fixture this repo emits in the canonical shape (`zzscratch` for hand-rolled, `zzstandalone`
   for rest-kit, `zzreadonly` for read-only-kit).
2. Rewrite its `src/server.ts` **in memory** into the near-miss shape by string surgery, with
   `expect(rewritten).not.toBe(original)` guarding every replacement.
3. Assert `deriveSpec` returns `ok: true` and that the derived spec is **deep-equal** to the spec
   derived from the canonical form.

Step 3 is condition (b), and equality against the canonical derivation is a stronger statement than
listing fields by hand: it proves the near-miss recovers *the same* spec, field for field, with no
opportunity to forget one.

Add refusals:
- a split registrar whose second const passes an identifier the first does not bind → refused;
- an inlined transport whose argument is `new SomethingElse()` → refused;
- a `startConnector` whose `runReadOnlyMcpConnector` second argument names a function the module does
  not declare → refused;
- an `if (import.meta.main)` guard calling something other than the recognized `startConnector` →
  refused;
- a `register<X>Tools` taking two parameters → refused (`ZodToolRegistrar` is the only one).

- [ ] **Step 3: Run — all must FAIL**

- [ ] **Step 4: Implement axes 1 and 2 together in `recognizeFrame`**

Element (3) becomes "the inlined registrar const **or** the two-const split", element (4) becomes
optional when element (5) carries the inline transport. Keep every existing check: the strict forms
must still be tried first, and the near-miss accepted only when the strict one is absent, so no
currently-recognized module changes meaning.

Delete the now-unreachable near-miss branches from `frameFailureKind` — `isBareIdentifierRegistrar`
and `isInlinedTransportConnect` exist to label shapes that are about to be *recognized*, so keeping
them would leave two labels that can never fire. Retire `isNamedReadOnlyCallback` and
`frame:readonly-callback-not-inline` for the same reason. Check with `grep` that nothing else
references them.

- [ ] **Step 5: Implement axis 3 in `recognizeReadOnlyFrame`**

A second entry shape alongside the inline wrapper. Both end in the same `Frame`, so the branch is
about *finding* the registration body, not about what happens after.

- [ ] **Step 6: Run every gate, then measure**

```bash
bun test && bunx tsc --noEmit && bunx biome check src/ test/ scripts/ && bun test --coverage
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run wiring:conformance --nimbus-root C:/gitrep/Nimbus
bun run reach --verbose --nimbus-root C:/gitrep/Nimbus
```

**Record the whole histogram before and after.** 27 connectors now get past their frame and report
whatever is behind it for the first time. New buckets are the expected result. Report:
- which of the 27 reached `emits`, if any;
- the new buckets and their sizes;
- that all four locked fixtures are still `6/6`.

**If any connector reaches `server-identical` from this task, stop and investigate** — that would mean
the emitter writes one of these shapes, which contradicts `wiring()`, and something is being claimed
that should not be.

- [ ] **Step 7: Commit**

```bash
git add src/derive/ test/derive/ docs/ROADMAP.md
git commit -m "feat(derive): read the split registrar, the inlined transport and the named read-only registrar"
```

---

## Task 12: Re-baseline, write the ceiling down, close Stage E

**Files:**
- Modify: `fixtures/reach-baseline.json` (regenerated, never hand-edited)
- Modify: `docs/ROADMAP.md`, `README.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md`
- Modify: `.claude/commands/cnc-reach-deriver.md`
- Test: —

**Interfaces:**
- Consumes: the final measurement from Task 11.
- Produces: the closed Stage E.

- [ ] **Step 1: Confirm the corpus has not moved under the branch**

```bash
git -C C:/gitrep/Nimbus status --short packages/mcp-connectors
git -C C:/gitrep/Nimbus rev-parse HEAD:packages/mcp-connectors
```
The tree must be `ec2b4e01…` and the checkout clean under that path. **If it moved, stop.** Every
measurement in this plan was taken against `ec2b4e01`, and re-baselining across a moved corpus records
a number that means nothing. Report the new tree and let the controller decide.

- [ ] **Step 2: Re-baseline**

```bash
bun run reach:baseline --nimbus-root C:/gitrep/Nimbus
bun run reach --baseline --nimbus-root C:/gitrep/Nimbus
```
The first regenerates `fixtures/reach-baseline.json`; the second must now exit **0** rather than 2.
**Never hand-edit the baseline** — it is regenerated or it is wrong.

Confirm the new file's `connectorsTree` is `ec2b4e01…` and that no connector's recorded tier is
*lower* than in the old file. A tier that fell is a regression this branch introduced; find it before
recording it.

- [ ] **Step 3: Write the ceiling into *Known limitations*, with its denominator**

The design's requirement is "a stated ceiling with a denominator". Write, in `docs/ROADMAP.md`:
- the final `server-identical` and `all-identical` counts out of 94, with the date and the corpus tree
  they were measured against;
- what the remaining blocked connectors are blocked *by*, grouped by cause, from the final
  `--verbose` histogram;
- for each group, whether it is a spec-language gap (a construct the language cannot express) or a
  recognizer gap (a construct the language can express and the deriver does not read). **That
  distinction is the ceiling.** A spec-language gap is the honest ceiling; a recognizer gap is
  remaining work, and saying which is which is the whole point of publishing the number with its
  method.

**Then add a third category the histogram cannot show**, because these connectors are blocked earlier
and their divergence never surfaces as a bucket. All three were measured 2026-08-06 against tree
`ec2b4e01` and each is a construct this generator *emits* and the corpus *writes differently*:

- **The query tail.** Ten connectors write `new URL(...)` in a path-builder lambda and end it with
  `` `${u.pathname}${u.search}` `` or `u.toString()`; this generator writes ``return `${u}`;``,
  deliberately (returning pathname+search reintroduces the base's own path component, and the fetch
  helper then prepends the base a second time). A further 22 build queries from a standalone
  `new URLSearchParams` with no `new URL` at all. Recognizing either is not a byte-level widening; the
  first would change what the emitted helper must do, the second is a different construct.
- **The write helper.** No connector declares `<local>Send`. Three carry a generic
  `xPost(path, body)`; sixteen route reads and writes through one `xFetch(path, init?)` and supply the
  verb in `init`. This generator's two-helper split is its own convention.
- **The token exchange.** Three connectors run a client-credentials grant and no two share a shape;
  none caches an expiry, and none reads `expires_in`, which this generator's `token()` does.

Say for each whether closing it would need a new spec field, a case-2 widening, or a change to what
the emitter writes — and do not propose the change here. Naming the cost is the deliverable.

- [ ] **Step 4: Close Stage E**

Mark Stage E `[x]` and each of its bullets to its true state. Two of its bullets are directly affected
by this branch:
- **"Conditional query parameters"** — already `[x]`; check its "what it still doesn't reach" pointer
  still resolves to something true.
- **"Raise the measured regeneration coverage … and publish the number with its method"** — this is
  the one Step 3 closes.

A bullet that is still open stays `[ ]` with its reason; **do not mark the stage complete by marking
open items done.** If a bullet cannot honestly close, say so and leave Stage E `[~]` — a half-closed
stage stated accurately is worth more than a checked box.

- [ ] **Step 5: Sweep every document against the code**

The user's requirement for this phase is a repo whose documents match its code. Check each:

| file | what to check |
| --- | --- |
| `README.md` | the corpus measurements next to the fields they justify; the `--from-connector` section |
| `docs/ROADMAP.md` | Stage E, *Known limitations*, *Considered and declined*, *Measuring reach* |
| `docs/ARCHITECTURE.md` | the harness list, the deriver's place in it, the new `src/derive/` modules |
| `docs/USAGE.md` | anything about what `--from-connector` can and cannot read |
| `CLAUDE.md` | the gate table, the Layout block, the reserved-identifier rule |
| `.claude/commands/cnc-reach-deriver.md` | Layout, "What is not built yet" — most of it shipped |

**Do not restate live numbers** in any of them. `diff:golden` and `reach` are the answer; a document
repeating a number goes stale silently. The one place a number belongs is the ceiling in Step 3, which
carries its date and its corpus tree so a reader can tell when it was true.

- [ ] **Step 6: Run every gate one final time, from a clean tree**

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
Report every exit code independently. `acceptance` is included because it has not run on this branch
and this is the last chance before it merges; if it needs setup the branch cannot provide, say so
rather than skipping it silently.

- [ ] **Step 7: Commit**

```bash
git add fixtures/reach-baseline.json docs/ README.md CLAUDE.md .claude/
git commit -m "docs: record the corpus ceiling with its method and close Stage E"
```

---

## Self-review

**Spec coverage.** Design items 10 (Tasks 3–6, 8), 11 (Task 9), 12 (Task 10), 13 (Task 11) and 14
(Task 12) each have a task. The five findings carried from phase 2a's whole-branch review are Tasks 1
and 2. One item is **added** beyond the design — the stub tool handler (Task 7) — because it is the
last fixture-blocking gap and the design's item 10 did not name it; that addition is called out in
Task 7's own text.

**Two deviations from the design, both measured:**

1. **Item 13's third axis was retargeted.** The design named `frame:readonly-callback-not-inline`;
   upstream `b3a6f159` retired that shape mid-phase-2a and the ten connectors now write a local
   `startConnector` wrapper. Task 11 targets what they carry today.
2. **Item 11's rows pluck was narrowed.** The design stated it as one shape; the corpus has four, and
   two of them carry a fallback to the root array that `rows` cannot express. Task 9 accepts two and
   refuses two, with the reason written into the recognizer.

**What this plan deliberately does not do.** It does not touch `src/emit/`, add a spec field, or move
the `all-identical` count. Every new recognizer reads a shape the emitter already writes, except the
two case-2 tasks, each of which records its divergence in `docs/ROADMAP.md` before claiming anything.

**The honest expectation.** `BLOCKED` in `test/derive/round-trip.test.ts` becomes empty — all 21
fixtures (22 with `zzquery`) round-trip, which is checkable in CI without an AGPL checkout. Tasks 3–8
are measured to move **no** corpus connector: every construct they read is written differently by
every corpus connector that has it. Task 9 shrinks the `function:*From` buckets by up to 12 without
necessarily moving a tier. Task 10 changes labels and nothing else, by design. Task 11 puts 27
connectors past their frame and is expected to *add* buckets.

**So `server-identical` may still read 6/94 when this branch lands, and that is not a failed branch.**
It is Stage E's actual deliverable: a complete inverse of the emitter, a histogram whose buckets mean
what they say, and a ceiling with a denominator and a named cause for every connector under it.

**A third measured deviation from the design, recorded here rather than discovered mid-task:** the
design's §8 predicted item 10 would raise `emits` "considerably". The per-construct sweep above shows
it will not. The prediction was made from bucket counts; this is from reading the constructs. Task 12
writes the real number down either way — that is what the design asked for.

---

## Review responses

[`2026-08-06-the-honest-histogram-review.md`](./2026-08-06-the-honest-histogram-review.md) raised
three items. Two are accepted, one is accepted with its suggested remedy rejected, and one half of a
third is deferred. Checking the first surfaced a defect neither the plan nor the review had.

### R1 — the fetch helper's base is not available where Task 3 needed it · **accepted, third option taken**

The premise is correct and verified: `deriveRestKitSpec` calls `recognizeRestTools` **before**
`recognizeRestFetchHelper` (`src/derive/index.ts:222-230`), and neither `recognizeRestTools` nor
`recognizeOneCall` takes any helper metadata. Task 3's original instruction — "verify the stripped
prefix equals the fetch helper's own base" — could not be carried out where it was written.

Of the review's three options, the third is taken: **recover the prefix, compare it in the assembly
function.** Reordering makes two independent recognizers order-dependent for no gain, and threading a
`helperBase` parameter would make the tool recognizer resolve a `baseConst` against module scope a
second time, duplicating `reconstructBase`. The assembly is also where this codebase already puts
this exact class of check — `rest-fetch-helper-name-mismatch` exists because two recognizers were
producing the same fact independently, and the fix was a comparison in the caller. Task 3 now
specifies `BasePrefix`, the comparison, and its blocker; Task 4 ports the same guard to
`deriveSharedStyleSpec`.

### R1a — a query tool must abstain from the `staticPathStyle` vote · **found while checking R1, added**

Neither the plan nor the review had this. `renderPath`'s fast path is `if (!dynamic && prefix ===
"")`, so a **non-empty prefix forces the template branch regardless of `ctx.staticStyle`** — a query
tool's path carries no evidence of the connector's convention, exactly like a dynamic path.

It is not cosmetic, because `voteStaticPathStyle` *blocks* on disagreement: a connector whose other
tools render `quoted` plus one query tool voting `template` would report `style:mixed-static-path`, a
refusal manufactured by the recognizer against a module the emitter wrote correctly. Both query tasks
now require `staticStyle: undefined` and a test that pins it.

### R2 — claim ranges when splicing axis 3's registrar body · **concern already handled; the suggested alternative rejected**

The plan already removes `register<X>Tools`' declaration from `verifyStatements` and splices its body
in, which is the review's first suggestion. Its second — "or mark the function declaration claimed
once its nested body statements are claimed" — is **the precise anti-pattern `frame.ts` documents**:
claims are byte ranges and coverage is containment, so claiming the declaration covers every
registration transitively, the totality rule finds nothing unclaimed, and a connector whose tools were
never recognized derives successfully. That is the false `emits` the two-list contract exists to
prevent, and it is why `recognizeReadOnlyFrame` verifies its wrapper without ever claiming it.

There is no overlapping-claim hazard in the correct design — `startConnector`'s range contains the
call but not the registrations — but Task 11 now proves that by test rather than by argument: a module
in the axis-3 shape with one unrecognizable registration must still report `ok: false`.

### R3 — a partially malformed client-credentials group · **test accepted, descriptive blocker deferred**

The real hazard is not the error message; it is Pass B claiming the wrapper as a standalone plain
accessor once Pass A′ has refused the group, deriving an env entry the module never declared. Task 1's
async and return-type pins are what close it — the wrapper is `async` and returns
`Promise<Record<string, string>>`. That is a cross-task interaction, so Task 8 now pins it with a
test rather than leaving it to hold by luck of ordering.

The descriptive near-miss blocker is deferred with a reason: the four statements already report as
`statement:VariableDeclaration`, `function:token` and `function:<local>`, which names each unclaimed
construct precisely, and a near-miss label needs a definition of "partly matching" — the thing
`frameFailureKind` needed a whole precedence order to get right, and got wrong twice. Four accurate
labels beat one that guesses.
