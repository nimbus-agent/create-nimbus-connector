# Phase 1: The Deriver Becomes Shippable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

> **Code listings are a starting point, not the authority.** Where a listing disagrees with
> `src/` or `scripts/`, **the source wins** — read it and adapt. Every listing was written
> against the tree at `ce97011`, and none has been executed.

**Goal:** Turn `scripts/_lib/derive/` from a measurement-only harness into a shipped CLI feature,
`create-nimbus-connector --from-connector <dir>`, without letting a wrong derivation become a file
someone commits.

**Architecture:** The deriver moves to `src/derive/` and `@babel/parser` becomes an
`optionalDependency`, following the `@biomejs/js-api` precedent already in `package.json`. Because
a missing optional dependency must not break *unrelated* commands, the Babel import becomes
dynamic and `src/cli.ts` reaches `src/derive/` only through a lazy `import()` inside the
`--from-connector` branch. Two correctness preconditions land before the flag ships: the tool
recognizer learns to read `method` and to refuse a fetch call it cannot attribute, and `effect` is
attributed so the emitted manifest reproduces the observed `hitlRequired`.

**Tech Stack:** Bun 1.3.14 (test runner, no Node path), TypeScript, `@babel/parser`,
Biome 2.5.7 via `@biomejs/js-api` in-process, zod 4 for the spec schema.

## Global Constraints

- **Licensing.** No connector source and no `shared/` source may enter this repository — not
  `src/`, not `test/`, not `fixtures/`. Every test input is hand-written here or produced by this
  repo's own emitter.
- **Byte safety.** `newrelic`, `datadog`, `grafana`, `sentry` must report **6/6** under
  `bun run diff:golden` after every task.
- **Reach must not regress.** `bun run reach --nimbus-root <path>` reports **4/94** with an
  unchanged blocker histogram after every task in this phase. Phase 1 adds no recognizer.
- **Never commit on `main`.** Work on `feat/deriver-shippable`.
- **Conventional Commits.** `feat:` bumps minor, `fix:` patch, `refactor:`/`docs:`/`test:` neither.
- **Bun only.** No Node, npm or pnpm path in this project or its output. Remedy text in error
  messages says `bun add`, never `npm install`.
- **No `coveragePathIgnorePatterns` entries.** `bunfig.toml` enforces coverage floors **per file**,
  and a file enters the report the moment a test imports it. Every new module ships with its own
  test file.
- **Rejecting is always the safe direction.** A rejection is a visible blocker; a wrong claim is a
  wrong number, and after this phase it is also a wrong file on someone's disk.
- **`test/scripts/derive-round-trip.test.ts` is the guard.** Every fixture stays in exactly one of
  `ROUND_TRIP` / `BLOCKED`; its "accounts for every fixture" test enforces this.

## Gate commands — check EXIT CODES, never printed output

```bash
bun test --coverage;                                        echo "cov_exit=$?"
bunx tsc --noEmit;                                          echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;                       echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus
```

**Run `bun install` first.** The tree at `ce97011` was measured with `node_modules` one patch
behind the lockfile, and `reach` warns when its resolved Biome differs from the monorepo's pin. A
diff taken under a mismatched formatter is not evidence.

---

## File Structure

| file | responsibility | task |
| --- | --- | --- |
| `src/optional-dep.ts` | **new** — `isMissingModule`, the one predicate that separates "the optional dependency is absent" from "it is present and broken" | 1 |
| `test/optional-dep.test.ts` | **new** — its unit tests | 1 |
| `src/format.ts` | imports the predicate instead of declaring it | 1 |
| `src/derive/**` | **moved** from `scripts/_lib/derive/**`, unchanged in behaviour | 2 |
| `test/derive/**` | **moved** from `test/scripts/derive-*.test.ts`, mirroring `src/derive/` | 2 |
| `scripts/_lib/reach.ts` | import specifiers repointed | 2 |
| `package.json` | `@babel/parser` + `@babel/types` → `optionalDependencies` | 2 |
| `src/derive/ast.ts` | Babel import becomes dynamic; gains `initParser()` / `parserUnavailableReason()` | 3 |
| `src/derive/server/tools-hand.ts` | recovers `method`; refuses an unattributable callee | 4 |
| `src/derive/index.ts` | attributes `effect` from the manifest's `hitlRequired`; returns `target` | 5, 8 |
| `src/derive/from-connector.ts` | **new** — reads a connector directory, returns a spec or a blocker report | 6 |
| `test/derive/from-connector.test.ts` | **new** | 6 |
| `src/cli.ts` | `--from-connector`, lazily importing `src/derive/` | 6, 7 |
| `src/spec.ts` | the partial-derivation marker key the schema rejects | 7 |
| `docs/LICENSING.md` | **new** — the derived-spec licensing answer | 9 |
| `src/derive/server/index.ts` | standalone frame recognizer | 8 |

---

## Task 1: Extract the optional-dependency predicate

`src/format.ts` already distinguishes *the optional dependency is genuinely absent* from *it is
present but failed to load*, and the distinction is subtle enough that a second copy would drift.
Task 3 needs the same predicate for `@babel/parser`. Extract it now, behaviour-preserving, before
anything depends on it.

**Files:**
- Create: `src/optional-dep.ts`
- Create: `test/optional-dep.test.ts`
- Modify: `src/format.ts:56-63` (delete the local `isMissingModule`, import it instead)

**Interfaces:**
- Produces: `export function isMissingModule(err: unknown, specifier: string): boolean`
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

Create `test/optional-dep.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { isMissingModule } from "../src/optional-dep.ts";

describe("isMissingModule", () => {
  it("matches when the structured specifier field names the module itself", () => {
    const err = { code: "ERR_MODULE_NOT_FOUND", specifier: "@babel/parser" };
    expect(isMissingModule(err, "@babel/parser")).toBe(true);
  });

  it("rejects when the structured specifier names a DIFFERENT module", () => {
    // The package resolved; one of ITS imports did not. Reporting this as "not installed"
    // sends the user to reinstall a package that is already there.
    const err = { code: "ERR_MODULE_NOT_FOUND", specifier: "@babel/helper-validator" };
    expect(isMissingModule(err, "@babel/parser")).toBe(false);
  });

  it("accepts the MODULE_NOT_FOUND spelling", () => {
    const err = { code: "MODULE_NOT_FOUND", specifier: "@babel/parser" };
    expect(isMissingModule(err, "@babel/parser")).toBe(true);
  });

  it("falls back to the message only when the structured field is absent", () => {
    const err = { code: "ERR_MODULE_NOT_FOUND", message: "Cannot find module '@babel/parser'" };
    expect(isMissingModule(err, "@babel/parser")).toBe(true);
  });

  it("rejects any error without a module-resolution code", () => {
    expect(isMissingModule(new TypeError("boom"), "@babel/parser")).toBe(false);
    expect(isMissingModule({ code: "EACCES", specifier: "@babel/parser" }, "@babel/parser")).toBe(
      false,
    );
  });

  it("rejects non-objects rather than throwing", () => {
    expect(isMissingModule(undefined, "x")).toBe(false);
    expect(isMissingModule(null, "x")).toBe(false);
    expect(isMissingModule("a string", "x")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
bun test test/optional-dep.test.ts
```

Expected: FAIL — `Cannot find module '../src/optional-dep.ts'`.

- [ ] **Step 3: Create the module**

Create `src/optional-dep.ts`, moving the body verbatim from `src/format.ts:56-63` and generalising
its docstring from Biome to any optional dependency:

```ts
/**
 * Shared by every optionalDependency load path in this repo. Two very different failures reach
 * a dynamic import's catch, and conflating them sends the user to fix a package that is already
 * installed:
 *   1. the optional dependency is genuinely absent;
 *   2. it is present but one of ITS OWN imports is not.
 *
 * Under Bun a failed dynamic import rejects with a ResolveMessage carrying `code`
 * ERR_MODULE_NOT_FOUND / MODULE_NOT_FOUND and a `specifier` field naming the module that could
 * not be found — which is the *inner* specifier in case 2. That difference is the whole
 * discrimination.
 *
 * What each caller DOES with the answer differs and must not be unified here: a missing
 * formatter degrades to unformatted output (src/format.ts), a missing parser cannot degrade at
 * all (src/derive/ast.ts). This predicate only says which failure occurred.
 */
export function isMissingModule(err: unknown, specifier: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; specifier?: unknown; message?: unknown };
  if (e.code !== "ERR_MODULE_NOT_FOUND" && e.code !== "MODULE_NOT_FOUND") return false;
  // Prefer the structured field; fall back to the message only if a runtime omits it.
  if (typeof e.specifier === "string") return e.specifier === specifier;
  return typeof e.message === "string" && e.message.includes(specifier);
}
```

- [ ] **Step 4: Point `src/format.ts` at it**

Delete `src/format.ts:56-63` (the local `isMissingModule` and its docstring — the reasoning now
lives in `src/optional-dep.ts`), and add to the import block at the top of the file:

```ts
import { isMissingModule } from "./optional-dep.ts";
```

Leave `formatterUnavailableReasonFor` and every message string exactly as they are. This task
changes no behaviour.

- [ ] **Step 5: Run the gates**

```bash
bun test --coverage;                  echo "cov_exit=$?"
bunx tsc --noEmit;                    echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/; echo "biome_exit=$?"
```

Expected: all `0`, and `src/optional-dep.ts` at 100% in the coverage table.

- [ ] **Step 6: Commit**

```bash
git add src/optional-dep.ts test/optional-dep.test.ts src/format.ts
git commit -m "refactor: extract isMissingModule for reuse by a second optional dependency

src/format.ts distinguishes an absent optionalDependency from a present-but-broken one, and
the distinction is subtle enough that the deriver's coming @babel/parser path must share it
rather than re-derive it. Behaviour-preserving; what each caller does with the answer stays
different, because a missing formatter degrades and a missing parser cannot."
```

---

## Task 2: Move the deriver to `src/derive/`

Reverses a rule stated in `.claude/commands/cnc-reach-deriver.md`. It is updated **here**, in the
commit that reverses it, so the prohibition does not survive as stale guidance.

**Correction to the design doc:** §3.1 says `CLAUDE.md` states this rule too. It does not —
`grep -n "scripts/" CLAUDE.md` returns only the gate-table lint command and a one-line Layout
entry (`scripts/  the harnesses`). `CLAUDE.md` still needs a Layout line for `src/derive/`, but it
is not carrying a prohibition to reverse.

The import surface is small — exactly one outward relative import from the whole directory.

**Files:**
- Move: `scripts/_lib/derive/**` → `src/derive/**` (15 files, 3,942 lines)
- Move: `test/scripts/derive-*.test.ts` → `test/derive/*.test.ts`, mirroring `src/derive/`
- Modify: `src/derive/index.ts:1` — `../../../src/spec.ts` → `../spec.ts`
- Modify: `scripts/_lib/reach.ts` — `./derive/index.ts` → `../../src/derive/index.ts`, and
  `./derive/blockers.ts` → `../../src/derive/blockers.ts`
- Modify: every moved test file's import specifiers
- Modify: `package.json`, `CLAUDE.md`, `.claude/commands/cnc-reach-deriver.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: `src/derive/index.ts` exporting `deriveSpec` and the `Derivation` type unchanged;
  `src/derive/blockers.ts` exporting `Blocker` unchanged.

- [ ] **Step 1: Confirm the import surface before moving anything**

```bash
grep -rn 'from "\.\./\.\./' scripts/_lib/derive/
grep -rn "derive/" --include="*.ts" scripts/ test/ src/ | grep -v "^scripts/_lib/derive/"
```

Expected: exactly **one** outward import (`scripts/_lib/derive/index.ts:1`, `capitalize` from
`../../../src/spec.ts`), and inward importers limited to `scripts/_lib/reach.ts` plus
`test/scripts/derive-*.test.ts`. **If this shows anything else, stop and re-plan** — the listings
below assume this surface.

- [ ] **Step 2: Move the source, preserving history**

All **14** derive test files move; `test/scripts/` keeps its other 13, which test the harnesses.

```bash
git mv scripts/_lib/derive src/derive
mkdir -p test/derive
git mv test/scripts/derive-args.test.ts           test/derive/args.test.ts
git mv test/scripts/derive-blockers.test.ts       test/derive/blockers.test.ts
git mv test/scripts/derive-claims.test.ts         test/derive/claims.test.ts
git mv test/scripts/derive-env.test.ts            test/derive/env.test.ts
git mv test/scripts/derive-fetch-helper.test.ts   test/derive/fetch-helper.test.ts
git mv test/scripts/derive-frame-readonly.test.ts test/derive/frame-readonly.test.ts
git mv test/scripts/derive-frame.test.ts          test/derive/frame.test.ts
git mv test/scripts/derive-index.test.ts          test/derive/index.test.ts
git mv test/scripts/derive-manifest.test.ts       test/derive/manifest.test.ts
git mv test/scripts/derive-path-template.test.ts  test/derive/path-template.test.ts
git mv test/scripts/derive-read.test.ts           test/derive/read.test.ts
git mv test/scripts/derive-round-trip.test.ts     test/derive/round-trip.test.ts
git mv test/scripts/derive-tools-hand.test.ts     test/derive/tools-hand.test.ts
git mv test/scripts/derive-tools-rest.test.ts     test/derive/tools-rest.test.ts
```

```bash
ls test/scripts/ | grep derive && echo "STOP: a derive test was left behind" || echo "all moved"
```

`test/derive/round-trip.test.ts` and `test/derive/path-template.test.ts` also import from `src/`
(`../../src/emit/index.ts`, `../../src/format.ts`, `../../src/spec.ts`, `../../src/types.ts`).
Those specifiers are unchanged by the move — both files stay two directories deep.

- [ ] **Step 3: Repoint the one outward import**

`src/derive/index.ts:1`:

```ts
import { capitalize } from "../spec.ts";
```

- [ ] **Step 4: Repoint the inward imports**

In `scripts/_lib/reach.ts`:

```ts
import type { Blocker } from "../../src/derive/blockers.ts";
import { deriveSpec } from "../../src/derive/index.ts";
```

Read the file first — the exact import forms (type-only vs value, which names) must be preserved;
only the specifier changes.

In every file under `test/derive/`, rewrite `../../scripts/_lib/derive/` to `../../src/derive/`:

```bash
grep -rln "scripts/_lib/derive/" test/derive/ | while read -r f; do
  sed -i 's#\.\./\.\./scripts/_lib/derive/#../../src/derive/#g' "$f"
done
grep -rn "scripts/_lib/derive" test/ scripts/ src/ || echo "no stale specifiers"
```

- [ ] **Step 5: Move the Babel packages to `optionalDependencies`**

In `package.json`, remove `"@babel/parser"` and `"@babel/types"` from `devDependencies` and add
them to the existing `optionalDependencies` block beside the Biome entries:

```json
  "optionalDependencies": {
    "@babel/parser": "^8.0.4",
    "@babel/types": "^8.0.4",
    "@biomejs/js-api": "^6.0.0",
    "@biomejs/wasm-nodejs": "^2.5.7"
  },
```

Copy the version ranges from the current `devDependencies` rather than typing them from here.

**They must be *removed* from `devDependencies`, not merely added below.** A package declared in
both blocks resolves by rules that differ between package managers, so the one thing that must not
be left ambiguous is which range applies. Assert it:

```bash
bun -e 'const p=require("./package.json");
for (const n of ["@babel/parser","@babel/types"]) {
  if (p.devDependencies?.[n]) throw new Error(`${n} still in devDependencies`);
  if (!p.optionalDependencies?.[n]) throw new Error(`${n} missing from optionalDependencies`);
}
console.log("dependency blocks are exclusive");'
bun install
```

- [ ] **Step 6: Update the document that forbids this, and CLAUDE.md's layout**

In `.claude/commands/cnc-reach-deriver.md`, replace the paragraph beginning **"The deriver lives
under `scripts/`, not `src/`, and must stay there."** with:

```markdown
**The deriver lives under `src/derive/`, and ships.** `package.json`'s `files` is
`["src", "README.md"]`, so it reaches npm — which is the point: `--from-connector` is the same
code pointed at a user's directory rather than at the corpus. `@babel/parser` is an
`optionalDependency`, following `@biomejs/js-api`, and `src/derive/ast.ts` imports it dynamically
so a consumer without it loses `--from-connector` and nothing else.

It lived under `scripts/` until the flag existed, because shipping unreachable code and an
unresolvable import in every tarball would have been the wrong trade. That reasoning expired when
the code stopped being unreachable.
```

In `CLAUDE.md`, update the **Layout** block: `src/derive/` gains a line
(`the spec deriver — the inverse of src/emit/`), and any sentence placing the deriver under
`scripts/` is corrected. Search first:

```bash
grep -n "derive" CLAUDE.md
```

- [ ] **Step 7: Run every gate, and prove the move changed nothing**

```bash
bun test --coverage;                                   echo "cov_exit=$?"
bunx tsc --noEmit;                                     echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;                  echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus
```

Expected: every exit code `0`; `newrelic`, `datadog`, `grafana`, `sentry` each **6/6**; `reach`
reports **4/94** with a blocker histogram identical to before the move. A move that changes the
histogram is not a move — investigate before continuing.

- [ ] **Step 8: Check the tarball**

```bash
npm pack --dry-run 2>&1 | grep -c "src/derive"
```

Expected: a non-zero count — `src/derive/` must be in the published tarball, since that is what
makes `--from-connector` work under `bunx`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: move the deriver to src/derive/ so it can ship

CLAUDE.md and cnc-reach-deriver.md both said the deriver must stay under scripts/, because
package.json's files is [\"src\", \"README.md\"] and shipping it would put unreachable code and
an unresolvable @babel/parser import into every tarball. That is true right up until
--from-connector exists, at which point the code is the feature. Both documents are updated
here rather than left as a stale prohibition.

@babel/parser and @babel/types become optionalDependencies, following the @biomejs/js-api
precedent already in this file. The import surface was one outward specifier for the whole
directory, so the move is mechanical: reach's histogram is unchanged at 4/94 and the four
byte-locked fixtures stay 6/6."
```

---

## Task 3: Make the parser import dynamic, and fail loudly without it

**This is the task that prevents a regression affecting every user.** `src/derive/ast.ts:6` is a
*static* top-level `import { parse } from "@babel/parser"`. Now that the module lives under
`src/`, any static import chain from `src/cli.ts` to `src/derive/` would make a missing optional
dependency break **plain generation** — the command that has nothing to do with derivation.

Two halves: the parser loads dynamically, and `src/cli.ts` (Task 6) reaches `src/derive/` only
through a lazy `import()`.

**Files:**
- Modify: `src/derive/ast.ts`
- Create: `test/derive/ast.test.ts` (or extend it if the move produced one)

**Interfaces:**
- Consumes: `isMissingModule` from `src/optional-dep.ts` (Task 1).
- Produces:
  - `export async function initParser(): Promise<void>` — idempotent; never throws.
  - `export function parserAvailable(): boolean`
  - `export function parserUnavailableReason(): string | undefined`
  - `export function parseModule(source: string): AstNode[]` — **throws** when `initParser()` has
    not run or the parser is absent.
  - `export function parserUnavailableReasonFor(err: unknown): string` — pure, exported for test.

- [ ] **Step 1: Write the failing test**

Add to `test/derive/ast.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { initParser, parseModule, parserAvailable, parserUnavailableReasonFor } from "../../src/derive/ast.ts";

describe("the parser boundary", () => {
  it("parses a module after initParser()", async () => {
    await initParser();
    expect(parserAvailable()).toBe(true);
    const body = parseModule("const a = 1;\n");
    expect(body).toHaveLength(1);
    expect(body[0]?.type).toBe("VariableDeclaration");
  });

  it("names bun add, not npm install, when the parser is absent", () => {
    // A Bun-only project must not print a Node instruction. Reachable only through this pure
    // function: @babel/parser cannot be made unresolvable in-process in a repo that has it.
    const err = { code: "ERR_MODULE_NOT_FOUND", specifier: "@babel/parser" };
    const reason = parserUnavailableReasonFor(err);
    expect(reason).toContain("bun add @babel/parser");
    expect(reason).not.toContain("npm install");
  });

  it("does not misreport a broken install as a missing one", () => {
    const err = { code: "ERR_MODULE_NOT_FOUND", specifier: "@babel/helper-validator" };
    const reason = parserUnavailableReasonFor(err);
    expect(reason).toContain("installed but failed to load");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
bun test test/derive/ast.test.ts
```

Expected: FAIL — `initParser` / `parserAvailable` / `parserUnavailableReasonFor` are not exported.

- [ ] **Step 3: Rewrite the parser boundary**

Replace `src/derive/ast.ts:6` and `parseModule` with:

```ts
import { isMissingModule } from "../optional-dep.ts";

const PARSER = "@babel/parser";

type ParseFn = (
  source: string,
  options: { sourceType: "module"; plugins: readonly string[] },
) => { program: { body: unknown[] } };

let parse: ParseFn | undefined;
let initialised = false;
let unavailableReason: string | undefined;

/**
 * Why the parser could not load. Exported because it is the only pure part of the load path:
 * @babel/parser cannot be made unresolvable in-process in a repo that depends on it, so the two
 * messages would otherwise go untested and the misdiagnosis could regress unnoticed.
 *
 * Unlike the formatter, this dependency has no degraded mode — there is no partial derivation
 * without an AST — so callers FAIL with this message rather than continuing. Do not "fix" that
 * into a silent fallback.
 */
export function parserUnavailableReasonFor(err: unknown): string {
  if (isMissingModule(err, PARSER)) {
    return (
      `${PARSER} is not installed. It is an optionalDependency, needed only by ` +
      `--from-connector. Install it with \`bun add ${PARSER}\`, or reinstall without ` +
      "omitting optional dependencies."
    );
  }
  const detail = err instanceof Error ? err.message : String(err);
  return (
    `${PARSER} is installed but failed to load, so a connector cannot be read. ` +
    `Underlying error: ${detail}`
  );
}

/** Load the parser if present. Idempotent, and never throws — callers check parserAvailable(). */
export async function initParser(): Promise<void> {
  if (initialised) return;
  initialised = true;
  try {
    ({ parse } = (await import(PARSER)) as { parse: ParseFn });
    unavailableReason = undefined;
  } catch (err) {
    parse = undefined;
    unavailableReason = parserUnavailableReasonFor(err);
  }
}

export function parserAvailable(): boolean {
  return parse !== undefined;
}

export function parserUnavailableReason(): string | undefined {
  return parse === undefined ? unavailableReason : undefined;
}

/**
 * `plugins: ["typescript"]` is required, not optional: connector source carries type
 * annotations and generics that the base parser rejects outright. No `jsx` or `decorators` —
 * neither appears in the corpus, and a plugin list longer than the syntax in play widens what
 * parses without widening what is recognized.
 */
export function parseModule(source: string): AstNode[] {
  if (parse === undefined) {
    throw new Error(unavailableReason ?? `${PARSER} was not initialised — call initParser() first.`);
  }
  const file = parse(source, { sourceType: "module", plugins: ["typescript"] });
  return file.program.body as unknown as AstNode[];
}
```

Keep the `AstNode` type and its docstring exactly as they are.

- [ ] **Step 4: Call `initParser()` wherever `parseModule` is reached**

`scripts/_lib/reach.ts` and every test that calls `parseModule` must `await initParser()` first.
Find them:

```bash
grep -rn "parseModule" src/ scripts/ test/
```

For the tests, add `await initParser()` in a `beforeAll`, following the `initFormatter()`
precedent in `test/derive/round-trip.test.ts`.

- [ ] **Step 5: Run the gates**

```bash
bun test --coverage;                  echo "cov_exit=$?"
bunx tsc --noEmit;                    echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/; echo "biome_exit=$?"
bun run reach --nimbus-root C:/gitrep/Nimbus
```

Expected: all `0`, and `reach` still **4/94** with an unchanged histogram.

- [ ] **Step 6: Prove the degradation is real, not assumed**

```bash
mv node_modules/@babel/parser node_modules/@babel/parser.hidden
bun src/cli.ts --spec fixtures/zzscratch.spec.json --dry-run; echo "generate_exit=$?"
mv node_modules/@babel/parser.hidden node_modules/@babel/parser
```

Expected: `generate_exit=0` — plain generation is **completely unaffected** by the missing parser.
If this fails, a static import chain from `src/cli.ts` to `src/derive/` still exists; find it with
`grep -rn "derive/" src/` and make it a lazy `import()`.

- [ ] **Step 7: Commit**

```bash
git add src/derive/ast.ts test/derive/ast.test.ts scripts/_lib/reach.ts test/
git commit -m "feat(derive): load @babel/parser dynamically, and fail loudly without it

Now that the deriver lives under src/, a static top-level import of an optionalDependency
would break EVERY command for a consumer who does not have it — including plain generation,
which has nothing to do with derivation. The import becomes dynamic and the failure is
diagnosed with the same predicate src/format.ts uses.

The two dependencies are deliberately not symmetric: a missing formatter degrades to
unformatted output, a missing parser cannot degrade at all, so this one fails with a named
message. The remedy text says \`bun add\`, because there is no npm path in this project."
```

---

## Task 4: Recover `method`, and refuse a fetch call the recognizer cannot attribute

`ToolFields` carries no `method`, and `fetchPathArgument` takes `args[0]` without inspecting the
callee — so `<helper>Send(path, "POST", body)` derives as a **GET read tool**. Dormant today only
because the `<local>Send` declaration is itself unclaimed. It becomes a wrong artifact the moment
`--from-connector` ships, so it lands first.

The emitter's shape, from `src/emit/server/tools-hand.ts:98-100`:

```ts
tool.method === "GET"
  ? `jsonResult(await ${spec.fetchHelper.local}(${callPath}))`
  : `jsonResult(await ${spec.fetchHelper.local}Send(${callPath}, ${JSON.stringify(tool.method)}, ${bodyExpr ?? "undefined"}))`
```

**Files:**
- Modify: `src/derive/server/tools-hand.ts`
- Modify: `src/derive/server/index.ts` (thread `fetchHelper.local` into `recognizeTools`)
- Modify: `test/derive/tools-hand.test.ts`

**Interfaces:**
- Consumes: the recognized `FetchHelperFields.local` (a `string`) from
  `src/derive/server/fetch-helper.ts`.
- Produces:
  - `ToolFields` gains `method?: "POST" | "PUT" | "PATCH" | "DELETE"` — **omitted for GET**, so
    `ToolSchema`'s `.default("GET")` applies and a read connector's derived spec is unchanged.
  - `recognizeTools(statements, claims, helperLocal: string)` — a third required parameter.

- [ ] **Step 1: Write the failing tests**

Add to `test/derive/tools-hand.test.ts`. Build the input by **emitting it** — never by
hand-writing connector-shaped source, which would be guessing at the emitter's output:

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { createClaimSet } from "../../src/derive/claims.ts";
import { recognizeTools } from "../../src/derive/server/tools-hand.ts";

beforeAll(async () => {
  await initFormatter();
  await initParser();
});

/** The emitted src/server.ts for a spec, so the test input is bytes this repo produced. */
function emittedServer(spec: unknown): string {
  const files = formatAll(generate(parseSpec(spec)));
  const f = files.find((x) => x.path.join("/") === "src/server.ts");
  if (f === undefined) throw new Error("no src/server.ts emitted");
  return f.content;
}

const WRITE_SPEC = {
  name: "zzmethod",
  displayName: "Zz Method",
  description: "Fixture for method recovery.",
  serviceLabel: "ZzMethod",
  style: "hand-rolled",
  env: [{ vars: ["ZZMETHOD_TOKEN"], local: "headers", auth: "bearer", required: true }],
  fetchHelper: { local: "zzGet", base: "https://api.zzmethod.test", headers: "headers" },
  tools: [
    {
      name: "zzmethod_item_create",
      description: "Create an item.",
      impl: "rest",
      method: "POST",
      effect: "write",
      path: "/v1/items",
      args: { title: { type: "string", min: 1 } },
    },
  ],
};

describe("recognizeTools recovers the HTTP method", () => {
  it("reads POST from the write helper's second argument", () => {
    const body = parseModule(emittedServer(WRITE_SPEC));
    const result = recognizeTools(body, createClaimSet(), "zzGet");
    expect(result?.tools[0]?.method).toBe("POST");
    expect(result?.tools[0]?.path).toBe("/v1/items");
  });

  it("omits `method` entirely for a GET tool, so the schema default applies", () => {
    const readSpec = {
      ...WRITE_SPEC,
      tools: [
        {
          name: "zzmethod_item_list",
          description: "List items.",
          impl: "rest",
          path: "/v1/items",
          args: {},
        },
      ],
    };
    const body = parseModule(emittedServer(readSpec));
    const result = recognizeTools(body, createClaimSet(), "zzGet");
    expect(result?.tools[0]).not.toHaveProperty("method");
  });

  it("refuses a fetch call whose callee is not the recognized helper", () => {
    // The landmine this task removes: args[0] was read as the path with no check that the
    // function producing it was the connector's own fetch helper.
    const body = parseModule(emittedServer(WRITE_SPEC));
    expect(recognizeTools(body, createClaimSet(), "somethingElse")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
bun test test/derive/tools-hand.test.ts
```

Expected: FAIL — `recognizeTools` takes two parameters, and `method` is not on `ToolFields`.

- [ ] **Step 3: Add `method` to `ToolFields`**

In `src/derive/server/tools-hand.ts`:

```ts
export type ToolFields = {
  name: string;
  description: string;
  args: Record<string, ArgFields>;
  path: string;
  /**
   * Omitted for GET, so ToolSchema's `.default("GET")` applies and a read connector's derived
   * spec is byte-unchanged by this field's existence. Present only when the emitter wrote the
   * write helper, which is the only place a method literal appears.
   */
  method?: "POST" | "PUT" | "PATCH" | "DELETE";
};
```

- [ ] **Step 4: Read the callee and the method**

Replace `fetchPathArgument` and `pathFromJsonResult` in `src/derive/server/tools-hand.ts:49-71`
with a version that identifies the callee. `calleeOf`, `isIdent` and `stringLit` are already
imported by this module; add `callArgs` if it is not.

```ts
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

type FetchCall = { path: AstNode; method?: "POST" | "PUT" | "PATCH" | "DELETE" };

/**
 * The read helper `<local>(path)` or the write helper `<local>Send(path, "METHOD", body)`, and
 * NOTHING else. Reading args[0] without checking the callee derived a POST tool as a GET read
 * tool — losing method, effect and therefore the manifest's hitlRequired — which is a wrong
 * artifact rather than a byte mismatch, and invisible to the totality rule because the statement
 * was claimed, just claimed wrongly. deriveRestKitSpec already performs the equivalent refusal.
 */
function fetchCall(call: AstNode, helperLocal: string): FetchCall | undefined {
  const callee = calleeOf(call);
  const args = callArgs(call);
  if (args === undefined) return undefined;

  if (isIdent(callee, helperLocal)) {
    return args.length === 1 && args[0] !== undefined ? { path: args[0] } : undefined;
  }
  if (isIdent(callee, `${helperLocal}Send`)) {
    if (args.length !== 3 || args[0] === undefined) return undefined;
    const method = stringLit(args[1]);
    if (method === undefined || !WRITE_METHODS.has(method)) return undefined;
    return { path: args[0], method: method as "POST" | "PUT" | "PATCH" | "DELETE" };
  }
  return undefined;
}

/** The declared path and method recovered from `jsonResult(await <helper|helperSend>(...))`. */
function pathFromJsonResult(
  node: AstNode | undefined,
  locals: ReadonlyMap<string, PathLocal>,
  helperLocal: string,
): { path: string; method?: "POST" | "PUT" | "PATCH" | "DELETE" } | undefined {
  const helperCall = jsonResultCall(node);
  if (helperCall === undefined) return undefined;
  const fetched = fetchCall(helperCall, helperLocal);
  if (fetched === undefined) return undefined;
  const path = recognizePath(fetched.path, locals);
  if (path === undefined) return undefined;
  return { path, ...(fetched.method === undefined ? {} : { method: fetched.method }) };
}
```

- [ ] **Step 5: Thread `helperLocal` through**

`recognizeOne` and `recognizeTools` both take `helperLocal: string` and pass it down. In
`recognizeOne`'s two call sites, spread the recovered object into `fields`:

```ts
  if (!arrow.isBlock) {
    const recovered = pathFromJsonResult(arrow.body, new Map(), helperLocal);
    return recovered === undefined
      ? undefined
      : {
          fields: { name, description, args: toolArgs, ...recovered },
          isBlock: false,
          hasHoists: false,
        };
  }
```

and the block form likewise, replacing `path` with `...recovered` after the `mergedArgs` step.

- [ ] **Step 6: Update the call site in `src/derive/server/index.ts`**

Find it and pass the recognized helper's `local`:

```bash
grep -n "recognizeTools(" src/derive/server/index.ts
```

The fetch helper is recognized before the tools, so its `local` is in scope. If it is not, **stop
and re-read** — reordering recognition is a larger change than this task, and the plan assumes the
existing order.

- [ ] **Step 7: Run the gates**

```bash
bun test --coverage;                                   echo "cov_exit=$?"
bunx tsc --noEmit;                                     echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;                  echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus
```

Expected: all `0`; four fixtures **6/6**; `reach` still **4/94**. The histogram may shift a
`call:reg` entry — a connector whose fetch callee never matched now fails for a named reason. Note
any change and confirm it is a connector that was already blocked.

- [ ] **Step 8: Commit**

```bash
git add src/derive/ test/derive/
git commit -m "fix(derive): recover the HTTP method, and refuse an unattributable fetch call

ToolFields carried no method and fetchPathArgument took args[0] without inspecting the callee,
so <helper>Send(path, \"POST\", body) derived as a GET read tool — losing method, effect and
therefore the manifest's hitlRequired. The totality rule is structurally blind to this: the
statement WAS claimed, just claimed wrongly.

Dormant while the deriver only produced numbers; a wrong file on someone's disk the moment
--from-connector ships, which is why it lands before the flag. method is omitted for GET so a
read connector's derived spec is unchanged."
```

---

## Task 5: Attribute `effect` so the emitted manifest reproduces `hitlRequired`

`src/emit/manifest.ts:22-24` computes `hitlRequired` as the deduplicated set of non-`read` effects
in `CAPABILITY_ORDER`. `src/derive/manifest.ts:41` deliberately does not recover it, so every
derived tool currently takes the schema default `effect: "read"` — and a write connector's emitted
manifest carries `hitlRequired: []` against an observed `["write"]`.

**`effect` is not uniquely recoverable, and the plan says so rather than pretending.** The manifest
depends only on the *set*, and `src/server.ts` does not depend on `effect` at all. So any
attribution producing the observed set is output-identical, and the byte-compare cannot distinguish
a right attribution from a wrong one. Attribute the minimal one that reproduces the set, refuse
when none does, and make `--from-connector` tell the user to confirm it.

**Files:**
- Modify: `src/derive/index.ts`
- Modify: `src/derive/manifest.ts` (surface the observed `hitlRequired`)
- Modify: `test/derive/round-trip.test.ts` (a write fixture moves out of `BLOCKED` only in a later
  phase — do **not** move it here)
- Create/modify: `test/derive/effect.test.ts`

**Interfaces:**
- Consumes: `ToolFields.method` (Task 4); the manifest's observed `hitlRequired: string[]`.
- Produces: each derived tool gains `effect: "write" | "delete"` **only** when attribution requires
  it; `read` is left to the schema default.

- [ ] **Step 1: Write the failing test**

Create `test/derive/effect.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { attributeEffects } from "../../src/derive/index.ts";

describe("attributeEffects", () => {
  it("leaves every tool read when hitlRequired is empty", () => {
    const tools = [{ name: "a" }, { name: "b" }];
    expect(attributeEffects(tools, [])).toEqual({
      tools: [{ name: "a" }, { name: "b" }],
      ambiguous: [],
    });
  });

  it("marks the only non-GET tool write, and reports it as unambiguous", () => {
    // One candidate: ToolSchema forbids a GET carrying a write effect, so this attribution is
    // the ONLY one reproducing the observed set. Forced, therefore correct.
    const tools = [{ name: "a" }, { name: "b", method: "POST" }];
    expect(attributeEffects(tools, ["write"])).toEqual({
      tools: [{ name: "a" }, { name: "b", method: "POST", effect: "write" }],
      ambiguous: [],
    });
  });

  it("reports ambiguity when two tools could carry the same effect", () => {
    // Both get `write` and the emitted manifest is right either way, but at most one may
    // actually BE a write — dagster POSTs GraphQL queries, ramp POSTs to exchange a token.
    const tools = [{ name: "a", method: "POST" }, { name: "b", method: "PUT" }];
    const result = attributeEffects(tools, ["write"]);
    expect(result?.ambiguous).toEqual(["write"]);
  });

  it("marks a DELETE-method tool delete when hitlRequired carries delete", () => {
    const tools = [{ name: "a", method: "POST" }, { name: "b", method: "DELETE" }];
    expect(attributeEffects(tools, ["write", "delete"])?.tools).toEqual([
      { name: "a", method: "POST", effect: "write" },
      { name: "b", method: "DELETE", effect: "delete" },
    ]);
  });

  it("refuses when hitlRequired demands an effect no tool can carry", () => {
    // A GET-only connector whose manifest claims a write is a manifest this deriver cannot
    // reproduce. Refusing is a visible blocker; guessing is a wrong spec that emits correctly.
    expect(attributeEffects([{ name: "a" }], ["write"])).toBeUndefined();
  });

  it("refuses when a declared delete has no DELETE-method tool to attribute it to", () => {
    expect(attributeEffects([{ name: "a", method: "POST" }], ["delete"])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
bun test test/derive/effect.test.ts
```

Expected: FAIL — `attributeEffects` is not exported.

- [ ] **Step 3: Implement it**

Add to `src/derive/index.ts`:

```ts
/**
 * `effect` is NOT uniquely recoverable, and this function does not pretend otherwise.
 *
 * src/emit/manifest.ts computes hitlRequired as the deduplicated SET of non-read effects, and
 * src/server.ts does not depend on `effect` at all — so every attribution producing the observed
 * set emits identical bytes, and the byte-compare cannot tell a right one from a wrong one. The
 * corpus proves the ambiguity is real rather than theoretical: `dagster` POSTs GraphQL queries
 * and `ramp` POSTs to exchange an OAuth token, neither of which is a write.
 *
 * So: attribute the effect the method suggests, ONLY to tools that can carry it, and refuse when
 * the observed set cannot be reproduced. --from-connector reports the attribution as unverified,
 * because for its purposes — a spec a human will edit — semantically wrong is a real cost even
 * when byte-identical.
 */
export type EffectAttribution = {
  tools: Record<string, unknown>[];
  /**
   * Effects assigned to MORE THAN ONE tool, and therefore not forced by the evidence. With a
   * single candidate the attribution is the only one reproducing the observed set, so it is
   * correct; with several, at least one carries the effect and this function cannot say which.
   */
  ambiguous: string[];
};

export function attributeEffects(
  tools: readonly Record<string, unknown>[],
  hitlRequired: readonly string[],
): EffectAttribution | undefined {
  const wanted = new Set(hitlRequired);
  const out = tools.map((t) => {
    const method = t["method"];
    if (method === "DELETE" && wanted.has("delete")) return { ...t, effect: "delete" };
    if (typeof method === "string" && method !== "GET" && wanted.has("write")) {
      return { ...t, effect: "write" };
    }
    return { ...t };
  });
  // The set the emitter would now compute must equal the one observed, in both directions.
  const counts = new Map<string, number>();
  for (const t of out) {
    const e = t["effect"];
    if (typeof e === "string") counts.set(e, (counts.get(e) ?? 0) + 1);
  }
  if (counts.size !== wanted.size) return undefined;
  for (const e of wanted) if (!counts.has(e)) return undefined;
  return {
    tools: out,
    ambiguous: [...counts].filter(([, n]) => n > 1).map(([e]) => e),
  };
}
```

- [ ] **Step 4: Wire it into `deriveSpec`**

`src/derive/manifest.ts` must surface the observed `hitlRequired` (read it beside the other
manifest fields; its docstring at :41 saying it is "deliberately not recovered" is replaced with a
pointer to `attributeEffects`). In `deriveSpec`, apply it after the tools are recognized, and
return `{ ok: false, blockers: [...] }` with kind `manifest:unattributable-hitl` when it refuses.

**Carry the ambiguity out.** `deriveSpec` attaches `attributeEffects`' `ambiguous` array to the
returned object under `$effectAmbiguity`. It is **reporting metadata, not a spec field**:
`reach`'s tiering ignores it, `from-connector.ts` strips it before printing (Task 6), and no
emitter reads it. Do not add it to `ConnectorSpecSchema` — a spec key that only exists to carry a
warning is a spec field the emitter must then be told to ignore, which is how accepted-then-
discarded fields get introduced.

Update `test/derive/round-trip.test.ts` if it asserts on the exact key set of a derived spec.

- [ ] **Step 5: Run the gates**

```bash
bun test --coverage;                                   echo "cov_exit=$?"
bunx tsc --noEmit;                                     echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;                  echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus
```

Expected: all `0`; four fixtures **6/6**; `reach` still **4/94** — all four have empty
`hitlRequired`, so attribution is a no-op for them.

- [ ] **Step 6: Commit**

```bash
git add src/derive/ test/derive/
git commit -m "feat(derive): attribute effect so the emitted manifest reproduces hitlRequired

deriveManifest deliberately did not recover hitlRequired, so every derived tool took the
schema default effect: read and a write connector's manifest came out with an empty array.

effect is not uniquely recoverable and this does not pretend it is: the manifest depends only
on the SET, and server.ts does not depend on effect at all, so every attribution producing the
observed set is byte-identical and the compare cannot tell them apart. dagster POSTs GraphQL
queries and ramp POSTs to exchange a token, so the ambiguity is measured, not hypothetical.
Attribute what the method suggests, refuse when the set cannot be reproduced, and let
--from-connector flag it as unverified."
```

---

## Task 6: `--from-connector`, with `blocked` as a first-class result

**Files:**
- Create: `src/derive/from-connector.ts`
- Create: `test/derive/from-connector.test.ts`
- Modify: `src/cli.ts` (`CliOptions`, `KNOWN_FLAGS`, `parseFlags`, `assertFlagCombination`,
  `USAGE`, `main`)
- Modify: `test/cli.test.ts`, `test/cli-main.test.ts`

**Interfaces:**
- Consumes: `deriveSpec` from `src/derive/index.ts`; `initParser` / `parserAvailable` /
  `parserUnavailableReason` from `src/derive/ast.ts`.
- Produces:
  ```ts
  export type FromConnectorResult =
    | {
        ok: true;
        spec: Record<string, unknown>;
        target: "monorepo" | "standalone";
        /** Things the user must verify by hand — e.g. an ambiguous `effect` attribution. */
        notes: readonly string[];
      }
    | { ok: false; blockers: readonly Blocker[] };
  export async function deriveFromDirectory(dir: string): Promise<FromConnectorResult>;
  export function renderBlockers(dir: string, blockers: readonly Blocker[]): string;
  ```

- [ ] **Step 1: Write the failing test**

Create `test/derive/from-connector.test.ts`. Generate a connector with this repo's own CLI, then
read it back — the only inputs that may exist in this repository:

```ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { writeFiles } from "../../src/cli.ts";
import { initParser } from "../../src/derive/ast.ts";
import { deriveFromDirectory, renderBlockers } from "../../src/derive/from-connector.ts";
import { tempDirs } from "../support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

beforeAll(async () => {
  await initFormatter();
  await initParser();
});

async function emitInto(fixture: string, dir: string): Promise<void> {
  const raw = JSON.parse(
    await Bun.file(join(import.meta.dir, "..", "..", "fixtures", `${fixture}.spec.json`)).text(),
  );
  await writeFiles(formatAll(generate(parseSpec(raw))), dir);
}

describe("deriveFromDirectory", () => {
  it("round-trips a connector this repo generated", async () => {
    const dir = tmp.make();
    await emitInto("zzscratch", dir);
    const result = await deriveFromDirectory(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.spec["name"]).toBe("zzscratch");
  });

  it("reports blockers by name rather than throwing", async () => {
    const dir = tmp.make();
    await emitInto("zzscratch", dir);
    // Append a statement no recognizer models. The totality rule must surface it.
    const server = join(dir, "src", "server.ts");
    await Bun.write(server, `${await Bun.file(server).text()}\nconst leftover = compute();\n`);

    const result = await deriveFromDirectory(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blockers.length).toBeGreaterThan(0);
      const text = renderBlockers(dir, result.blockers);
      expect(text).toContain("cannot read");
      expect(text).toMatch(/statement:|call:/);
    }
  });

  it("names the missing file rather than throwing a raw ENOENT", async () => {
    const result = await deriveFromDirectory(tmp.make());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(renderBlockers("x", result.blockers)).toContain("src/server.ts");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
bun test test/derive/from-connector.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement `src/derive/from-connector.ts`**

Read `src/derive/index.ts`'s `deriveSpec` signature and `SourceFiles` type first; the listing below
assumes `deriveSpec({ server, manifest })`.

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Blocker } from "./blockers.ts";
import { deriveSpec } from "./index.ts";

export type FromConnectorResult =
  | {
      ok: true;
      spec: Record<string, unknown>;
      target: "monorepo" | "standalone";
      notes: readonly string[];
    }
  | { ok: false; blockers: readonly Blocker[] };

/** A missing input is a blocker like any other, so one report shape covers every failure. */
function missing(path: string): Blocker {
  return { kind: `missing-file:${path}`, detail: `${path} was not found`, line: 0 };
}

export async function deriveFromDirectory(dir: string): Promise<FromConnectorResult> {
  const serverPath = join(dir, "src", "server.ts");
  const manifestPath = join(dir, "nimbus.extension.json");
  const absent = [
    ...(existsSync(serverPath) ? [] : [missing("src/server.ts")]),
    ...(existsSync(manifestPath) ? [] : [missing("nimbus.extension.json")]),
  ];
  if (absent.length > 0) return { ok: false, blockers: absent };

  const server = await Bun.file(serverPath).text();
  const manifest = await Bun.file(manifestPath).text();
  // The target is a generate() option rather than a spec field, so it is reported separately.
  const target = server.includes("@nimbus-dev/sdk/connector-kit") ? "standalone" : "monorepo";

  const derivation = deriveSpec({ server, manifest });
  if (!derivation.ok) return { ok: false, blockers: derivation.blockers };
  // deriveSpec attaches the ambiguity from attributeEffects (Task 5) under this key; it is
  // reporting metadata, not a spec field, so it is stripped before the spec is printed.
  const ambiguous = (derivation.spec["$effectAmbiguity"] as string[] | undefined) ?? [];
  const { $effectAmbiguity: _dropped, ...spec } = derivation.spec;
  return {
    ok: true,
    spec,
    target,
    notes: ambiguous.map(
      (e) =>
        `more than one tool was assigned effect "${e}". The emitted manifest is correct either ` +
        "way, but at most one of them may actually be one — confirm each before generating.",
    ),
  };
}

/**
 * `blocked` is a RESULT, not an error. The user learns which construct stopped the read, in the
 * same vocabulary `bun run reach --verbose` prints — which is also the report that says which
 * recognizer to write next.
 */
export function renderBlockers(dir: string, blockers: readonly Blocker[]): string {
  const lines = blockers.map((b) => `  ${b.kind}${b.line > 0 ? `  (line ${b.line})` : ""}`);
  return (
    `cannot read ${dir} into a spec. What stopped it:\n\n` +
    `${lines.join("\n")}\n\n` +
    "Each label names a construct this generator's spec language does not model. See\n" +
    "docs/ROADMAP.md's Known limitations for the ones that are permanent."
  );
}
```

**No program-name prefix on the first line.** `src/cli.ts:370-377` catches whatever `main` throws
and prints `create-nimbus-connector: ${err.message}` — so a report that named the program itself
would render it twice. Step 5 prints this report directly rather than throwing it, for the same
reason the design gives: `blocked` is a result, not an error, and squeezing a multi-line report
through a single-line error formatter is not how a result gets reported.

- [ ] **Step 4: Add the flag to `src/cli.ts`**

`CliOptions` gains `fromConnector?: string`. `KNOWN_FLAGS` gains `"--from-connector"` **in
alphabetical position** (it is a sorted list). `parseFlags` gains, beside the other value-taking
flags:

```ts
    else if (a === "--from-connector") {
      opts.fromConnector = takeValue(argv, ++i, "--from-connector");
    }
```

`assertFlagCombination` gains the three refusals, each following the file's existing rule that a
flag with no effect is worse silently ignored than loudly rejected:

```ts
  if (opts.fromConnector !== undefined && opts.specPath !== undefined) {
    throw new Error(
      "--from-connector derives a spec from an existing connector and --spec reads one from a " +
        "file; passing both means one would be discarded. Keep one.",
    );
  }
  if (opts.fromConnector !== undefined && opts.name !== undefined) {
    throw new Error(
      "--from-connector takes the connector name from the directory it reads; a positional " +
        "name is redundant and was probably a mistake — remove one.",
    );
  }
  if (opts.fromConnector !== undefined && opts.gatewayWiring !== undefined) {
    throw new Error(
      "--from-connector prints a spec and writes nothing, so --gateway-wiring has nothing to " +
        "attach to. Derive the spec first, then generate from it with --spec.",
    );
  }
```

`USAGE` gains a line — `test/cli.test.ts` extracts flags from `parseFlags` with
`/a === "(--[a-z-]+)"/g` and asserts every one appears in `USAGE`, so omitting this is a failing
test:

```
  --from-connector <dir>   read an existing connector directory and print its spec
```

- [ ] **Step 5: Handle it in `main()`, with a LAZY import**

**The import must be dynamic.** A static `import` of `./derive/…` at the top of `src/cli.ts` pulls
`@babel/parser` into the module graph for every command, undoing Task 3. Add near the top of
`main`, after `parseCliArgs`:

```ts
  if (opts.fromConnector !== undefined) {
    // Lazy: a static import would pull @babel/parser into the module graph for every command,
    // so a consumer without the optionalDependency could not even run --dry-run. Task 3's
    // step 6 is the check that this stays true.
    const { initParser, parserAvailable, parserUnavailableReason } = await import(
      "./derive/ast.ts"
    );
    const { deriveFromDirectory, renderBlockers } = await import("./derive/from-connector.ts");
    await initParser();
    if (!parserAvailable()) throw new Error(parserUnavailableReason() ?? "the parser is unavailable.");

    const result = await deriveFromDirectory(opts.fromConnector);
    if (!result.ok) {
      // Printed, not thrown. `blocked` is a RESULT — the top-level catcher formats a thrown
      // Error as one prefixed line, which would mangle a multi-line report and repeat the
      // program name. The throw below is only how this process exits non-zero.
      console.error(renderBlockers(opts.fromConnector, result.blockers));
      throw new Error(`--from-connector: ${opts.fromConnector} could not be read into a spec.`);
    }
    console.log(JSON.stringify(result.spec, null, 2));
    for (const note of result.notes) console.error(`note: ${note}`);
    if (result.target === "standalone") {
      console.error("note: read from a standalone package — generate with --standalone.");
    }
    return;
  }
```

Place it **before** the `spec` resolution, so `--from-connector` never prompts.

- [ ] **Step 6: Add the CLI tests**

In `test/cli.test.ts`, add cases for each of the three refusals, following the existing
`expect(() => parseCliArgs([...])).toThrow(/…/)` shape. In `test/cli-main.test.ts`, add an
end-to-end case using its `runCli` helper — note that helper always passes `--spec`, so add a
sibling helper that does not, or extend it.

- [ ] **Step 7: Run the gates**

```bash
bun test --coverage;                  echo "cov_exit=$?"
bunx tsc --noEmit;                    echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/; echo "biome_exit=$?"
bun src/cli.ts --spec fixtures/zzscratch.spec.json --out-dir /tmp/zz-rt >/dev/null
bun src/cli.ts --from-connector /tmp/zz-rt
```

Expected: all `0`, and the last command prints a JSON spec whose `"name"` is `"zzscratch"`.

- [ ] **Step 8: Re-run Task 3's degradation check**

```bash
mv node_modules/@babel/parser node_modules/@babel/parser.hidden
bun src/cli.ts --spec fixtures/zzscratch.spec.json --dry-run;  echo "generate_exit=$?"
bun src/cli.ts --from-connector /tmp/zz-rt;                    echo "derive_exit=$?"
mv node_modules/@babel/parser.hidden node_modules/@babel/parser
```

Expected: `generate_exit=0` and `derive_exit=1` with the `bun add @babel/parser` message. If
`generate_exit` is non-zero, the lazy import regressed.

- [ ] **Step 9: Commit**

```bash
git add src/derive/from-connector.ts test/derive/from-connector.test.ts src/cli.ts test/
git commit -m "feat(cli): --from-connector, with blocked as a first-class result

The reach harness has always derived a spec from a real connector and printed only a number.
This is the same code pointed at a user's directory. When it cannot read a connector it prints
the construct that stopped it, in the same vocabulary reach --verbose uses — which is also the
report that says which recognizer to write next.

The derive path is imported lazily. A static import would pull @babel/parser into the module
graph for every command, so a consumer without the optionalDependency could not run --dry-run;
the hidden-module check in this branch is what keeps that honest."
```

---

## Task 7: Partial derivation, rejected by the schema by construction

A draft with TODOs on screen is not a gate that lies. A partial spec that **validates** is: it
silently generates a connector missing tools. `ConnectorSpecSchema` is `z.strictObject`, so an
unknown top-level key is already a rejection — that is the mechanism.

**Files:**
- Modify: `src/derive/from-connector.ts`
- Modify: `src/cli.ts` (`--partial`)
- Modify: `src/spec.ts` (only if a clearer message than the generic strict-object error is wanted)
- Modify: `test/derive/from-connector.test.ts`, `test/spec.test.ts`

**Interfaces:**
- Produces: `export const PARTIAL_MARKER = "$partial";` from `src/derive/from-connector.ts`, and
  `deriveFromDirectory(dir, { partial: true })` returning `{ ok: true, spec }` where `spec` carries
  `$partial` plus the blocker list.

- [ ] **Step 1: Write the failing test**

```ts
import { PARTIAL_MARKER } from "../../src/derive/from-connector.ts";
import { parseSpec } from "../../src/spec.ts";

it("emits a partial spec the schema REFUSES", async () => {
  const dir = tmp.make();
  await emitInto("zzscratch", dir);
  const server = join(dir, "src", "server.ts");
  await Bun.write(server, `${await Bun.file(server).text()}\nconst leftover = compute();\n`);

  const result = await deriveFromDirectory(dir, { partial: true });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.spec).toHaveProperty(PARTIAL_MARKER);
  // The whole point: a draft must not be generatable until a human has resolved it.
  expect(() => parseSpec(result.spec)).toThrow();
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
bun test test/derive/from-connector.test.ts
```

Expected: FAIL — `PARTIAL_MARKER` is not exported and `deriveFromDirectory` takes one argument.

- [ ] **Step 3: Implement**

```ts
/**
 * A top-level key `ConnectorSpecSchema` (a z.strictObject) rejects, so a partial draft cannot be
 * generated from until a human removes it. The rejection is structural rather than a convention:
 * a partial spec that validated would silently emit a connector missing tools, which is the
 * accepted-then-discarded failure this repo has already removed twice.
 */
export const PARTIAL_MARKER = "$partial";

export async function deriveFromDirectory(
  dir: string,
  options: { partial?: boolean } = {},
): Promise<FromConnectorResult> {
  // ... unchanged up to the derivation ...
  if (!derivation.ok) {
    if (options.partial !== true) return { ok: false, blockers: derivation.blockers };
    return {
      ok: true,
      target,
      notes: ["this spec is PARTIAL and will not validate until the marker key is resolved."],
      spec: {
        [PARTIAL_MARKER]: {
          note: "Derived partially. Resolve each blocker, then delete this key.",
          blockers: derivation.blockers.map((b) => b.kind),
        },
      },
    };
  }
  // ...unchanged: the success path from Task 6, including its `notes`.
}
```

Add `--partial` to `KNOWN_FLAGS`, `parseFlags` (as a boolean), `USAGE`, and an
`assertFlagCombination` refusal when it is passed without `--from-connector`, mirroring the
existing `--force` rule.

- [ ] **Step 4: Run the gates and commit**

```bash
bun test --coverage;                  echo "cov_exit=$?"
bunx tsc --noEmit;                    echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/; echo "biome_exit=$?"
```

```bash
git add src/derive/from-connector.ts src/cli.ts test/
git commit -m "feat(cli): --partial, whose output the schema refuses by construction

A draft a human reads with TODOs on screen is not a gate that lies. A partial spec that
VALIDATED would be: it silently generates a connector missing tools. ConnectorSpecSchema is a
z.strictObject, so an unknown top-level key is already a rejection — the marker uses that
rather than adding a convention someone could forget to check."
```

---

## Task 8: A frame recognizer for this generator's own standalone output

Every standalone package this tool emits derives as `frame:no-kit-import` — **0% on the shape a
third-party author would point the flag at.** It needs no Nimbus checkout, so it is the one part of
this phase fully verifiable in CI.

Measured from `bun src/cli.ts --spec fixtures/zzstandalone.spec.json --standalone`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  makeRestToolRegistrar,
} from "@nimbus-dev/sdk/connector-kit";
import { z } from "zod";
```

and for `read-only-kit` standalone, `runReadOnlyMcpConnector` is emitted as a **local
`async function` declaration at module scope** — a statement the totality rule will surface as
unclaimed unless the frame claims it.

**Files:**
- Modify: `src/derive/server/index.ts`
- Create: `test/derive/frame-standalone.test.ts`

**Interfaces:**
- Consumes: the existing `Frame` type and `recognizeFrame` signature — unchanged.
- Produces: no signature change. `isFrameImport` is **not** widened.

- [ ] **Step 1: Write the failing test**

```ts
import { beforeAll, describe, expect, it } from "bun:test";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { parseSpec } from "../../src/spec.ts";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { createClaimSet } from "../../src/derive/claims.ts";
import { recognizeFrame } from "../../src/derive/server/index.ts";

beforeAll(async () => {
  await initFormatter();
  await initParser();
});

function standaloneServer(fixture: string): string {
  const raw = JSON.parse(
    require("node:fs").readFileSync(`fixtures/${fixture}.spec.json`, "utf8"),
  );
  const files = formatAll(generate(parseSpec(raw), { target: "standalone" }));
  return files.find((f) => f.path.join("/") === "src/server.ts")!.content;
}

describe("recognizeFrame reads this generator's standalone output", () => {
  it("accepts the rest-kit standalone frame", () => {
    const frame = recognizeFrame(parseModule(standaloneServer("zzstandalone")), createClaimSet());
    expect(frame?.fields.style).toBe("rest-kit");
    expect(frame?.fields.name).toBe("zzstandalone");
  });

  it("accepts the read-only-kit standalone frame and claims the inlined helper", () => {
    const claims = createClaimSet();
    const body = parseModule(standaloneServer("zzreadonly"));
    const frame = recognizeFrame(body, claims);
    expect(frame?.fields.style).toBe("read-only-kit");
    // The inlined `async function runReadOnlyMcpConnector` must not reach the totality rule
    // as an unclaimed statement.
    expect(claims.unclaimed(frame!.verifyStatements).map((n) => n.type)).not.toContain(
      "FunctionDeclaration",
    );
  });

  it("still rejects a module with no kit import at all", () => {
    expect(recognizeFrame(parseModule("const a = 1;\n"), createClaimSet())).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

```bash
bun test test/derive/frame-standalone.test.ts
```

Expected: FAIL — `recognizeFrame` returns `undefined` for both standalone shapes.

- [ ] **Step 3: Add a standalone kit-import predicate**

In `src/derive/server/index.ts`, beside `isFrameImport`:

```ts
/**
 * The standalone target's single kit import. A SEPARATE predicate rather than a widened
 * `isFrameImport`: relaxing that one in place would change what the frame claims against the
 * AGPL corpus too, and this recognizer must not move a corpus number it has nothing to do with.
 */
const STANDALONE_KIT = "@nimbus-dev/sdk/connector-kit";

function isStandaloneKitImport(node: AstNode): boolean {
  return importSource(node) === STANDALONE_KIT;
}
```

Thread it into the frame's import-claiming step alongside `isFrameImport`, and for the
`read-only-kit` branch claim the inlined `runReadOnlyMcpConnector` function declaration by name —
matching only an `async function` declaration with that exact identifier, so a differently-named
local is still a blocker.

Read `src/emit/server/index.ts`'s `imports()` before writing this: it is the authority on which
names the standalone target aliases (`mcpJsonResult as jsonResult`), and the recognizer must match
the emitted local bindings, not the exported names.

- [ ] **Step 4: Run the gates**

```bash
bun test --coverage;                                   echo "cov_exit=$?"
bunx tsc --noEmit;                                     echo "tsc_exit=$?"
bunx biome check src/ test/ scripts/;                  echo "biome_exit=$?"
bun run diff:golden --nimbus-root C:/gitrep/Nimbus
bun run reach --nimbus-root C:/gitrep/Nimbus
```

Expected: all `0`; four fixtures **6/6**; `reach` **unchanged at 4/94 with an identical
histogram** — no corpus connector is standalone, so a change here means the predicate leaked into
the monorepo path.

- [ ] **Step 5: Prove the end-to-end claim**

```bash
rm -rf /tmp/zz-sa && bun src/cli.ts --spec fixtures/zzstandalone.spec.json --standalone --out-dir /tmp/zz-sa >/dev/null
bun src/cli.ts --from-connector /tmp/zz-sa
```

Expected: a JSON spec, and the `note: read from a standalone package` line on stderr.

- [ ] **Step 6: Commit**

```bash
git add src/derive/server/index.ts test/derive/frame-standalone.test.ts
git commit -m "feat(derive): read this generator's own standalone output

isFrameImport accepted only the monorepo's kit imports, so every standalone package this tool
emits derived as frame:no-kit-import — 0% on the shape a third-party author would actually
point --from-connector at, and the one part of this work verifiable in CI with no AGPL
checkout.

A separate predicate rather than a widened isFrameImport: relaxing that one in place would
silently change what the frame claims against the corpus. The read-only-kit branch also claims
the inlined runReadOnlyMcpConnector declaration, which the totality rule would otherwise
surface as unclaimed."
```

---

## Task 9: The licensing answer

The reach design deferred this explicitly: *"The authoring-aid form of `--from-connector` is a
separate feature with a separate licensing answer, deliberately not designed here."* The feature
now exists, so the answer must be written down — and it must state the one thing that stays
forbidden.

**Files:**
- Create: `docs/LICENSING.md`
- Modify: `README.md` (link it from the documentation table)
- Modify: `CLAUDE.md` (the licensing-constraint section gains a pointer)
- Modify: `docs/USAGE.md` (a `--from-connector` walkthrough referencing it)

- [ ] **Step 1: Write `docs/LICENSING.md`**

Cover, in this order:

1. **The three repositories and their licences** — the table from `CLAUDE.md`, as the shared
   premise rather than a restatement (link, do not duplicate the reasoning).
2. **Why `--from-connector` is not vendoring.** The output is a *description* of a connector, not
   its source; it is produced on the user's machine from a checkout they already have; and nothing
   AGPL-derived enters *this* repository. Contrast explicitly with the harnesses, which read the
   monorepo at runtime and also never vendor it.
3. **The one thing that stays forbidden:** a spec derived from a real Nimbus connector **may not be
   committed to `fixtures/`**. `CLAUDE.md` requires every fixture to be hand-written, and the whole
   test strategy depends on it. Name the failure mode: a derived fixture would make `diff:golden`
   compare the corpus against itself.
4. **What the user owns.** A standalone connector generated from a derived spec is the user's own
   code under whatever `--license` they pass; a monorepo-target one is `AGPL-3.0-only`
   unconditionally, for the reasons `README.md` already gives.
5. **The description-string carve-out**, linked from `CLAUDE.md` rather than restated.

Match `docs/ARCHITECTURE.md`'s voice: reasoning, not restatement, and cite the measurement or the
rule behind each claim.

- [ ] **Step 2: Link it**

Add to `README.md`'s documentation table:

```markdown
| [LICENSING.md](./docs/LICENSING.md) | The three-repo licence boundary, and what `--from-connector` may and may not produce |
```

- [ ] **Step 3: Verify every link resolves**

```bash
grep -oE '\]\(\.{0,2}/?[^)#]*\.md' README.md CLAUDE.md docs/*.md | sed 's/:.*](//' | sort -u
```

Check each path exists. There must be **zero** broken links.

- [ ] **Step 4: Commit**

```bash
git add docs/LICENSING.md README.md CLAUDE.md docs/USAGE.md
git commit -m "docs: the licensing answer --from-connector needed

The reach design deferred this by name, on the grounds that the authoring-aid form of the
feature had a separate licensing answer from the measurement form. The feature now exists.

The answer: deriving a spec on a user's machine from a checkout they already have is not
vendoring — the output is a description, produced locally, and nothing AGPL-derived enters this
repository. What stays forbidden is committing such a spec to fixtures/, because a derived
fixture would make diff:golden compare the corpus against itself."
```

---

## Phase Exit Criteria

Before writing the phase 2 plan, all of the following must hold:

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
- `reach` reports **4/94** with a histogram unchanged from `ce97011` **except** for entries
  explained by Task 4's callee refusal. Phase 1 adds no recognizer, so a *rise* is as suspect as a
  fall — investigate either.
- The hidden-module check passes: generation works without `@babel/parser`, `--from-connector`
  fails with a `bun add` message.
- `npm pack --dry-run` includes `src/derive/`.

---

## Review Responses

[`2026-08-05-deriver-becomes-shippable-review.md`](./2026-08-05-deriver-becomes-shippable-review.md)
raised four items. Two were already handled, one is accepted, and one pointed at a real defect
that was not the one it described.

**R1 — delete the Babel packages from `devDependencies`, don't just add them below.** Already
stated ("remove … and add …"), but the underlying hazard is real: a package declared in both
blocks resolves by rules that differ between package managers. Task 2 Step 5 now **asserts** the
blocks are exclusive rather than relying on the instruction being followed.

**R2 — will a thrown error print a raw stack trace?** No: `src/cli.ts:370-377` already catches
whatever `main` throws and prints one line, `create-nimbus-connector: ${err.message}`, then exits
1. Verified by running `bun src/cli.ts --spec` with no value.

But the question surfaced a defect the plan *did* have. That catcher prefixes the program name to
**line 1 only**, and the original `renderBlockers` began `create-nimbus-connector cannot read …` —
so a blocker report would have printed the program name twice and squeezed a multi-line report
through a single-line formatter. Worse, it contradicted the design's own rule that **`blocked` is
a result, not an error.** Fixed in both places: the report drops its self-naming prefix, and
Task 6 Step 5 **prints** it to stderr and throws only a one-line summary, which is all the exit
code needs.

**R3 — warn when an `effect` attribution is ambiguous.** Accepted, with the condition sharpened.
The review's "multiple candidate tools" is exactly right and the plan now uses it: with **one**
non-GET tool and `hitlRequired: ["write"]` the attribution is *forced* — `ToolSchema` forbids a GET
carrying a write effect, so no other assignment reproduces the observed set — and warning there
would train the user to ignore the warning. With two or more, at least one is a write and this
function cannot say which. `attributeEffects` now returns `{ tools, ambiguous }`,
`FromConnectorResult` carries `notes`, and the CLI prints them to stderr. The design promised this
("`--from-connector` reports the attribution as unverified") and the first draft of the plan only
put it in a docstring.

**R4 — what if `--from-connector` is the last argument with no value?** Already handled.
`takeValue` (`src/cli.ts:77-83`) throws `"--from-connector requires a value"`, which the top-level
catcher renders as one clean line — verified by running `bun src/cli.ts --spec`.

**Deferred, and worth naming since the review was in the neighbourhood:** `takeValue` does not
check that the next token is not itself a flag, so `--from-connector --dry-run` consumes
`--dry-run` as the directory. That is true of **every** value-taking flag in this CLI today
(`--spec`, `--out-dir`, `--license`, `--gateway-wiring`) and is not introduced by this phase.
Fixing it belongs in one change across all five, with its own tests, not smuggled into a task
about the deriver.

## Self-Review

**Spec coverage.** Design §5 phase 1 item 1 → Tasks 1–3 (the move, plus the dynamic-import
consequence the design named in §3.1 but did not size). Item 2 → Tasks 4–5 (split, because
`method` is exactly recoverable from `server.ts` bytes while `effect` is only set-recoverable from
the manifest — a reviewer could accept one and reject the other). Item 3 → Tasks 6–7. Item 4 →
Task 9. Item 5 → Task 8. Design §3.3's `parseSpec`-invalid requirement → Task 7. §3.4's two
preconditions → Tasks 4–5 and Task 9, both sequenced before Task 6 ships the flag.

**Deviation from the design, recorded.** §5 lists five items; this plan has nine tasks. The extra
four are Task 1 (extracting the shared predicate, which §3.4 implied by saying "reuse
`format.ts`'s helper" without saying how), Task 3 (the dynamic-import requirement, which is a
correctness consequence of the move rather than a separate feature), and the 4/5 and 6/7 splits.
No item was dropped.

**Placeholder scan.** No `TBD`, no "add error handling", no "similar to Task N". Task 9's steps
give a required section list rather than finished prose, deliberately: it is a document whose
wording is the deliverable, and pre-writing it here would put the same text in two files, one of
which gets deleted. Every other step carries the code it needs.

**Type consistency.** `ToolFields.method` is introduced in Task 4 and consumed by Task 5's
`attributeEffects` under the same name and union. `FromConnectorResult` is introduced in Task 6 and
extended — not redeclared — in Task 7. `isMissingModule(err, specifier)` keeps one signature across
Tasks 1 and 3. `recognizeFrame`'s signature is unchanged by Task 8, as its Interfaces block states.

**Known risk carried from the design.** Task 4's refusal may move connectors between histogram
buckets. That is a reporting change, not a regression, but it must be *stated* in the commit rather
than discovered later — Task 4 Step 7 requires noting it.
