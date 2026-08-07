# The Unattended Repo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Leave `create-nimbus-connector` in a state where it can sit unattended — one command runs the local gates, CI's permanent ceiling is stated rather than implied, every false or dangling claim is corrected, and Stage G becomes a scoping document instead of an open checkbox.

**Architecture:** Phase 4 of [`2026-08-05-roadmap-completion-design.md`](../specs/2026-08-05-roadmap-completion-design.md) — design items 17 (`docs/CONSOLIDATION.md`) and 18 (release condition). Work proceeds outward: the `preflight` runner first, because the gate-list corrections reference it; then the mechanically-checkable defects in `src/` and `.github/`; then documentation, whose claims depend on the code being right; then the retirement of `docs/superpowers/`, last, because every other task cites documents inside it.

**Tech Stack:** Bun 1.3.14 (Bun-only, no Node path except `npm publish --provenance`), zod v4, Biome 2.5.7, `bun:test`.

---

## ⚠️ Read this before Task 1: the punch lists are stale

§7.5 and §7.6 of the design spec were audited **2026-08-05 against `9c0886f`**. Three phases and ~60 commits have landed since. **At least two items are already fixed**, verified at HEAD while writing this plan:

| Audit item | State at HEAD |
| --- | --- |
| `rows` is neither identifier-checked nor collision-checked | **FIXED.** `src/spec.ts` has `rows: identifierField().optional()`, and `validateSpec` checks it against the claimed set. |
| `bun test` never compiles hand-rolled or rest-kit emitted `server.ts` | **APPEARS FIXED.** `test/emit/emitted-typecheck.test.ts` carries `style: "hand-rolled"` and rest-kit cases. Re-verify what it does *not* cover before acting. |
| Nothing verifies `RESERVED_IDENTIFIERS` is complete | **PARTIAL.** `test/emitted-globals.test.ts` exists; its own report says it catches a *missing* reservation but never a *superfluous* one. |

**Every task below opens by re-verifying its items against HEAD.** An item that is already fixed gets recorded as such and skipped — do not re-fix it, and do not silently drop it either. This plan states what was true on 2026-08-05; `git log` and the code state what is true now, and the code wins.

The same applies to line numbers: the spec cites them, they have moved, and **this plan cites symbols and heading text instead**. Never trust a line number from the spec.

---

## Global Constraints

- **Licensing is load-bearing.** This repo is **MIT**; the Nimbus monorepo at `C:/gitrep/Nimbus` is **AGPL-3.0-only**; `nimbus-sdk` is MIT. **No connector source and no `shared/` source may be copied into this repository — not into `src/`, not into `test/`, not into `fixtures/`.** The one carve-out is connector description strings in the eleven real-connector fixtures.
- **Bun-only.** `#!/usr/bin/env bun`, `bun:test`, `bun build --target bun`. The sole exception is `npm publish --provenance` in `release.yml`.
- **Byte safety is absolute.** `newrelic`, `datadog`, `grafana` and `sentry` must report **6/6** under `diff:golden`. Run it and grep for all four; never infer.
- **`fixtures/expectations.json` is never edited to hide a mismatch.**
- **Emitters return UNFORMATTED source.** `generate()` is pure; `formatAll()` runs the real Biome. Never hand-align indentation.
- **Do not restate live numbers in documents.** `diff:golden` is the answer. The one exception is *The measured ceiling* in `docs/ROADMAP.md`, which carries its date (2026-08-06) and corpus tree (`94fd3623`) on purpose; if you re-measure it, move both.
- **A citation must name a document that still exists, or state its reasoning inline.**
- **A mutation that fails nothing is a finding, not dead code.**
- **Name a gating value for the claim it gates, not the input that sets it.**
- **Cite by symbol or heading text, never by line number.**
- **Conventional Commits.** `feat:` bumps the minor, `fix:` the patch, `docs:`/`chore:`/`test:` neither.
- **Never commit on `main`.** This plan's branch is `docs/phase-4-release-condition`, which already carries `421b70e`.

### The gates

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

Baseline at `421b70e`: `bun test` **2106 pass / 0 fail**, all eight exit 0, four locked fixtures 6/6.

The last four need the AGPL monorepo and **cannot ever run in CI**. Do not add a CI job that skips when the root is absent — a silently-skipping gate is the failure mode this repo keeps removing.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/preflight.ts` | Create. The driver: runs the local gate sequence in order, reports SKIP by name. |
| `scripts/_lib/preflight.ts` | Create. The pure part — gate definitions, sequencing, the report. Testable without spawning. |
| `test/scripts/preflight.test.ts` | Create. Proves the SKIP path names its gates and that a full run prints the verified sentence. |
| `src/emit/biome-json.ts` | Modify. `BIOME_VERSION`. |
| `test/emit/static.test.ts` | Modify. Replace the tautological guards with one that compares against `package.json`. |
| `test/release-workflow-guard.test.ts` | Modify. Widen the Bun-pin comparison to all four workflows; correct the `bootstrap-publish.yml` comment. |
| `.github/workflows/cla.yml` | Modify. Narrow the App token; add `harden-runner`. |
| `.github/workflows/release.yml` | Modify. `CHANGELOG` gate before publish; `bun test --coverage`. |
| `.github/workflows/dependency-review.yml` | Create. The one new gate. |
| `test/coverage-gate.test.ts` | Modify. Parse `release.yml` too. |
| `package.json` | Modify. `description`, `keywords`, the `preflight` script. |
| `scripts/_lib/golden-diff.ts` | Modify. The user-visible dangling citation. |
| `docs/TESTING.md` | Create. The test-honesty matrix. |
| `docs/SPEC.md` | Create. Field reference generated from the zod schema. |
| `scripts/build-spec-doc.ts` | Create. Generates `docs/SPEC.md`, sharing `_lib` with the JSON Schema builder. |
| `docs/CONSOLIDATION.md` | Create. Stage G as a scoping document. |
| `README.md`, `docs/ROADMAP.md`, `docs/ARCHITECTURE.md`, `docs/GLOSSARY.md`, `docs/RELEASING.md`, `docs/GOVERNANCE.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `.claude/commands/cnc-*.md` | Modify. Corrections and gate lists. |
| `docs/superpowers/` | Delete, last. |

---

## Task 1: `bun run preflight`

**Files:**
- Create: `scripts/preflight.ts`, `scripts/_lib/preflight.ts`, `test/scripts/preflight.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `runPreflight(opts: { nimbusRoot?: string; run: (cmd: string[]) => { exitCode: number } }): PreflightReport` and `type PreflightReport = { results: { name: string; status: "pass" | "fail" | "skip"; reason?: string }[]; fullyVerified: boolean }`. Later tasks cite `bun run preflight` in `CONTRIBUTING.md`, `CLAUDE.md` and `docs/RELEASING.md`.

- [ ] **Step 1: Read the pattern this must follow**

`scripts/standalone-acceptance.ts` established it: when a prerequisite is absent it reports **SKIP loudly and by name**, and deliberately does **not** print the sentence a fully-verified run prints. Read it before writing anything. `scripts/_lib/` holds the pure half of a harness and the driver stays a driver — `scripts/_lib/build-schema.ts` is the most recent example, and its header says why the split matters for the coverage metric.

- [ ] **Step 2: Write the failing test**

`test/scripts/preflight.test.ts`. Inject `run` so nothing spawns:

```ts
import { describe, expect, it } from "bun:test";
import { runPreflight } from "../../scripts/_lib/preflight.ts";

const ok = () => ({ exitCode: 0 });

describe("preflight", () => {
  it("reports the four monorepo gates as SKIP, by name, when no root is given", () => {
    const report = runPreflight({ run: ok });
    const skipped = report.results.filter((r) => r.status === "skip").map((r) => r.name);
    expect(skipped).toEqual(["diff:golden", "reach --baseline", "wiring:conformance", "acceptance"]);
  });

  it("does NOT claim full verification when anything skipped", () => {
    expect(runPreflight({ run: ok }).fullyVerified).toBe(false);
  });

  it("claims full verification only when every gate ran and passed", () => {
    expect(runPreflight({ nimbusRoot: "/x", run: ok }).fullyVerified).toBe(true);
  });

  it("does not claim full verification when a gate failed", () => {
    const run = (cmd: string[]) => ({ exitCode: cmd.includes("tsc") ? 1 : 0 });
    expect(runPreflight({ nimbusRoot: "/x", run }).fullyVerified).toBe(false);
  });

  it("stops at the first failure, so a broken typecheck does not run the corpus gates", () => {
    const seen: string[] = [];
    const run = (cmd: string[]) => {
      seen.push(cmd.join(" "));
      return { exitCode: cmd.includes("tsc") ? 1 : 0 };
    };
    runPreflight({ nimbusRoot: "/x", run });
    expect(seen.some((c) => c.includes("diff:golden"))).toBe(false);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

`bun test test/scripts/preflight.test.ts` — expect a module-not-found error.

- [ ] **Step 4: Implement `scripts/_lib/preflight.ts`**

Gate order is the order above: `bun test`, `tsc --noEmit`, `biome check src/ test/ scripts/`, `bun test --coverage`, then the four monorepo gates. The four carry a `needsRoot: true` flag; with no root they are `skip` with the reason naming `--nimbus-root`. `fullyVerified` is true **only** when every gate has `status === "pass"`.

Write the module docstring to say *why* the skip is loud and why `fullyVerified` gates the sentence — a preflight that silently omitted four gates is the exact false green this repo exists to avoid.

- [ ] **Step 5: Implement `scripts/preflight.ts`**

The driver: parse `--nimbus-root`, call `runPreflight` with a real `run` built on `Bun.spawnSync` (inherit stdio), print each result, print the fully-verified sentence only when `report.fullyVerified`, and exit non-zero on any `fail`. Keep the `import.meta.main` guard so importing it in a test does not execute it.

- [ ] **Step 6: Add the script**

In `package.json`: `"preflight": "bun scripts/preflight.ts"`.

- [ ] **Step 7: Run the tests, then run it for real**

`bun test test/scripts/preflight.test.ts` — PASS. Then both live forms, and confirm by eye that the skip form names all four and omits the sentence:

```bash
bun run preflight
bun run preflight --nimbus-root C:/gitrep/Nimbus
```

- [ ] **Step 8: Commit**

```bash
git add scripts/preflight.ts scripts/_lib/preflight.ts test/scripts/preflight.test.ts package.json
git commit -m "feat(scripts): one command for the local gate sequence, skipping loudly"
```

---

## Task 2: the `src/` defects

**Files:**
- Modify: `src/emit/biome-json.ts`, `biome.json`, `test/emit/static.test.ts`
- Verify only: `test/emit/emitted-typecheck.test.ts`, `test/emitted-globals.test.ts`

- [ ] **Step 1: Re-verify all four §7.5 `src/` items against HEAD**

Record each as FIXED or LIVE in the report before touching anything. Confirmed while writing this plan: `rows` is **FIXED**; `emitted-typecheck` **appears fixed** and needs its actual coverage stated; `emitted-globals.test.ts` exists but is **partial**.

- [ ] **Step 2: Write the failing test for `BIOME_VERSION`**

The existing guards in `test/emit/static.test.ts` assert the emitted range equals `^${BIOME_VERSION}` and the `$schema` contains `${BIOME_VERSION}` — both hold for **any** value the constant takes. Replace them with the one comparison that can fail:

```ts
it("BIOME_VERSION matches the Biome this repo actually pins", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
    devDependencies: Record<string, string>;
  };
  // The emitted $schema URL and devDependency range are produced by BIOME_VERSION; the bytes
  // they describe are produced by the Biome in devDependencies. A constant that drifts behind
  // the pin emits a connector whose biome.json points at a schema for a different formatter.
  expect(`^${BIOME_VERSION}`).toBe(pkg.devDependencies["@biomejs/biome"]);
});
```

- [ ] **Step 3: Run it and watch it fail**

`bun test test/emit/static.test.ts` — expect `^2.5.6` vs `^2.5.7`.

- [ ] **Step 4: Fix the drift**

Set `BIOME_VERSION` to `2.5.7` and update `biome.json`'s own `$schema` URL to match.

- [ ] **Step 5: Run the byte gate — this changes emitted bytes**

`biome.json` is an emitted file for the standalone target. **Run `diff:golden` and grep all four locked fixtures.** If any moves, stop and report: the constant feeds emitted output, and a bump that moves a byte-locked fixture is a finding, not a formality.

- [ ] **Step 6: State `emitted-typecheck`'s real coverage**

Its docstring does not say which styles and targets it compiles, which is the hole the audit named. Replace it with what the file actually covers, derived from the cases present — and if a style × target combination is genuinely uncompiled, say so by name rather than omitting it.

- [ ] **Step 7: Run the gates and commit**

```bash
git add src/emit/biome-json.ts biome.json test/emit/static.test.ts test/emit/emitted-typecheck.test.ts
git commit -m "fix(emit): pin BIOME_VERSION to the Biome that formats the bytes"
```

---

## Task 3: CI/CD — the four important items

**Files:**
- Modify: `.github/workflows/cla.yml`, `.github/workflows/release.yml`, `test/release-workflow-guard.test.ts`
- Create: `.github/workflows/dependency-review.yml`

- [ ] **Step 1: Widen the Bun-pin guard to all four workflows**

All four say `1.3.14`; the guard parses only `release.yml` and `ci.yml`, so `acceptance.yml` — which runs the strongest checks in the repo — can drift silently. Write the failing test first: change `acceptance.yml`'s pin to `1.3.13` locally, confirm the widened guard fails, then restore it.

- [ ] **Step 2: Add the `CHANGELOG` gate to `release.yml`**

A step that fails **before** `npm publish` when the `Unreleased` section is anything other than its placeholder. Failing before publish is recoverable; failing after is not, since npm cannot unpublish after 72 hours. The placeholder is the literal `*Nothing pending.*` — read `CHANGELOG.md`'s own header for the convention it documents.

- [ ] **Step 3: Narrow the CLA App token**

`cla.yml` passes no `permission-*` inputs to `actions/create-github-app-token`, so the token carries the App installation's full permission set and is handed to a third-party action on a `pull_request_target` trigger any external contributor can fire. `release.yml` already demonstrates the narrowing. Determine the minimum set the CLA action needs, and **state in the report that it is unverified against a real external PR** — because it is, and that is the one thing that would confirm it.

- [ ] **Step 4: Add `harden-runner` to `cla.yml`**

It is the only workflow without it, and the one where egress audit logs are worth most.

- [ ] **Step 5: Add the dependency-review gate**

`.github/workflows/dependency-review.yml` on `pull_request`, `actions/dependency-review-action` SHA-pinned, `contents: read` only, with `deny-licenses` covering AGPL and GPL. This repo's number-one invariant is a license boundary and `test/license.test.ts` covers only the license string the generator *emits*, not this repo's own dependency tree. It matters most for Dependabot PRs, which auto-merge on patch and minor without a human.

- [ ] **Step 6: Run the gates and commit**

```bash
git add .github/workflows/ test/release-workflow-guard.test.ts
git commit -m "ci: narrow the CLA token, gate the changelog, guard all four Bun pins"
```

---

## Task 4: CI/CD polish, and `package.json` metadata

**Files:**
- Modify: `.github/workflows/release.yml`, `.github/workflows/sonar.yml`, `.github/workflows/codeql-config.yml`, `test/coverage-gate.test.ts`, `package.json`

- [ ] **Step 1: `release.yml` runs `bun test --coverage`**

`ci.yml` runs `--coverage`; `release.yml` runs a bare `bun test`. `coverage-gate.test.ts` parses only `ci.yml`, so its own stated rule goes unenforced against the one file that breaks it. Fix both — the workflow *and* the test that should have caught it.

- [ ] **Step 2: `sonar.qualitygate.wait`**

Without it, findings accumulate behind a green workflow.

- [ ] **Step 3: `codeql-config.yml` uses `security-extended`**

Currently the default suite.

- [ ] **Step 4: `package.json` gains `description` and `keywords`**

Neither is declared, so the npm registry page shows README's first line with the markdown unrendered. Check whether a test pins the `package.json` shape before editing.

- [ ] **Step 5: Run the gates and commit**

```bash
git add .github/ test/coverage-gate.test.ts package.json
git commit -m "ci: enforce the coverage rule where it was written, and fill the registry metadata"
```

---

## Task 5: the dangling citations

**Files:**
- Modify: `scripts/_lib/golden-diff.ts`, `test/scripts/golden-diff.test.ts`, `test/release-workflow-guard.test.ts`, `.github/workflows/{ci,acceptance,release}.yml`, `CONTRIBUTING.md`, `src/golden/expectations.ts`, `src/golden/sdk-root.ts`, `src/spec.ts`, `src/emit/search-filter.ts`, `src/emit/server/index.ts`, `src/validate.ts`

- [ ] **Step 1: Find them all, mechanically**

The spec counted fifteen on 2026-08-05. **Re-derive the list at HEAD** rather than working from that number. Grep for references to `docs/superpowers/`, `design doc`, `design decision`, `the design`, `criterion-2`, and `D4`. A link checker will **not** find these — they are prose references, not links.

- [ ] **Step 2: Fix the user-visible one first**

`scripts/_lib/golden-diff.ts` prints *"; update fixtures/expectations.json and the design doc's criterion-2 gap report"* on a changed diff — sending the maintainer to a deleted document at the moment they most need it. Fixing it also touches the pinned assertion in `test/scripts/golden-diff.test.ts`. `src/golden/expectations.ts` carries the same reference in its docstring.

- [ ] **Step 3: Apply the rule to each remaining citation**

**A citation must name a document that still exists, or state its reasoning inline.** For `decision D4` — cited in `ci.yml`, `acceptance.yml` and `CONTRIBUTING.md` — the reasoning is short and belongs inline: the monorepo is AGPL-3.0-only and this repo is MIT, so vendoring it was refused and the harness reads it at runtime. `docs/LICENSING.md` is the live document to point at.

- [ ] **Step 4: Correct the `bootstrap-publish.yml` comment**

`test/release-workflow-guard.test.ts` describes it as a file that currently exists. Verify whether it does, and make the comment true.

- [ ] **Step 5: Re-run the sweep and prove it is empty**

The same greps must now return nothing but intentional history references. **Note in the report that `docs/superpowers/` still exists at this point** — Task 10 deletes it, and re-runs this sweep afterwards.

- [ ] **Step 6: Run the gates and commit**

```bash
git commit -am "docs: make every citation name a document that exists"
```

---

## Task 6: the false README claims

**Files:**
- Modify: `README.md`, and `.claude/commands/cnc-spec-authoring.md`

- [ ] **Step 1: Re-verify each claim against the emitter at HEAD**

The audit found these, each verified against the code on 2026-08-05. **Check each one again** — phases 2b and 3 changed `src/spec.ts` substantially.

1. A `DELETE` whose only arg is in the path is documented as sending "no body (and no `Content-Type` header)". `src/emit/server/fetch-helper.ts` writes `"Content-Type": "application/json"` unconditionally in `<local>Send`.
2. The default body is documented as "every arg not referenced in the tool's path". `src/emit/server/body.ts` also excludes every `query` entry's arg — a rule added with `query` and never written down.
3. README overclaims byte-identity across the whole corpus: four fixtures reproduce 6/6, not 94.
4. "`local` and `bindings` are permitted everywhere" is wrong on three counts.
5. The six-files framing is monorepo-only — standalone emits seven, and `biome.json` is documented nowhere.
6. The interactive-prompt list is wrong in both directions.
7. `client-credentials` is documented as hand-rolled-only in `README.md` and `.claude/commands/cnc-spec-authoring.md`, but `src/spec.ts` permits `read-only-kit` too.

- [ ] **Step 2: Correct each, and cite the symbol you verified it against**

Do not restate live numbers. For claim 3, point at *The measured ceiling* rather than repeating counts.

- [ ] **Step 3: Fix `renderTokenFunction`'s JSDoc**

`src/emit/server/env.ts` — its JSDoc contradicts the code directly beneath it. Read both and make the doc true.

- [ ] **Step 4: Run the gates and commit**

```bash
git commit -am "docs: correct seven README claims the emitter contradicts"
```

---

## Task 7: `docs/TESTING.md`

**Files:**
- Create: `docs/TESTING.md`
- Modify: `docs/README.md` (the index)

- [ ] **Step 1: Build the matrix from the tests, not from memory**

For each style × target, state which check **actually compiles** the emitted output, which only substring-asserts it, which byte-compares against a snapshot, and which needs an out-of-CI gate. That reasoning currently lives in four places that disagree at the edges, and *"is this emitter change safe to merge?"* cannot be answered without reconstructing it.

- [ ] **Step 2: Write what the coverage gate structurally cannot see**

Three facts, all of which have misled someone: a file no test imports **never enters the report at all**; subprocess execution is invisible, which is why `src/cli.ts` and `src/prompts.ts` are excluded (see `bunfig.toml`, which explains this at length); and files generated into temp directories and dynamically imported **do** get measured and **do** fall under the per-file floor.

- [ ] **Step 3: Record which gates can lie, and how**

`CLAUDE.md`'s *The gates, and which ones can lie* is the seed. Carry over the traps: `--registry` versus local-checkout mode answer different questions; generated `test/sandbox.test.ts` is wrapped in `describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])` and that variable is set nowhere in Nimbus, so all such tests skip on every CI run; `reach` proves nothing about any individual connector that `diff:golden` does not already prove.

- [ ] **Step 4: Verify every claim you wrote**

Each row must be checked against the test file it describes. A matrix that is wrong is worse than no matrix, because it will be trusted.

- [ ] **Step 5: Commit**

```bash
git add docs/TESTING.md docs/README.md
git commit -m "docs: the test-honesty matrix"
```

---

## Task 8: `docs/SPEC.md`, generated

**Files:**
- Create: `scripts/build-spec-doc.ts`, `scripts/_lib/build-spec-doc.ts`, `docs/SPEC.md`, `test/spec-doc.test.ts`
- Modify: `README.md`, `package.json`

**Interfaces:**
- Consumes: `ConnectorSpecSchema` from `src/spec.ts`, and the pattern established by `scripts/_lib/build-schema.ts` — the driver and the drift test import **both** the builder and the output path from `_lib`, so the bytes and their destination cannot diverge.

- [ ] **Step 1: Read `scripts/_lib/build-schema.ts` first**

It is the same shape one file over, and its header explains why the split carries a second load: a drift test that reconstructs the document its own way only proves the two reconstructions agree. Follow it exactly.

- [ ] **Step 2: Write the drift test**

```ts
it("is byte-identical to what the generator produces, so the file cannot drift", () => {
  expect(readFileSync(SPEC_DOC_PATH, "utf8")).toBe(buildSpecDoc());
});
```

- [ ] **Step 3: Generate from the same source as the JSON Schema**

`docs/SPEC.md` is a complete field reference derived from the zod schema — the same source as `schema/connector-spec.schema.json`, so the two cannot drift. This is what makes README's "the reference" claim true rather than removing it.

**State the same limitation the JSON Schema states:** the refinements do not survive into a field table any more than they survive into JSON Schema, so a field-by-field reference cannot express "only valid when that one is set". Link to the refinement rules rather than implying completeness.

- [ ] **Step 4: Add the script and wire the README**

`"build:spec-doc": "bun scripts/build-spec-doc.ts"` in `package.json`. README's "reference" claim now points at `docs/SPEC.md`.

- [ ] **Step 5: Run the tests and commit**

```bash
git add scripts/build-spec-doc.ts scripts/_lib/build-spec-doc.ts docs/SPEC.md test/spec-doc.test.ts package.json README.md
git commit -m "docs: a field reference generated from the schema it describes"
```

---

## Task 9: `docs/CONSOLIDATION.md`, and Stage G

**Files:**
- Create: `docs/CONSOLIDATION.md`
- Modify: `docs/ROADMAP.md`, `README.md`, `docs/README.md`

- [ ] **Step 1: Write the four preconditions, correcting the three the current docs overstate**

Design §6.2 is the source. A new file rather than a `ROADMAP.md` section: it is a standing statement with conditions, it outlives the roadmap's open items, and it needs room for a precondition nobody has recorded.

1. **The handshake is small, and currently mis-described.** `NimbusExtensionServer` is a stub whose `registerTool` discards both arguments and whose `start()` only validates `manifest.id`. The template tool never imports it — `templates/typescript/main.ts` imports `performHandshake` from `@nimbus-dev/sdk/ipc` and then serves MCP through the same `McpServer` / `StdioServerTransport` this generator already emits. So it is a **~45-line rewrite of `tail()`** in `src/emit/server/index.ts`, gated on a new `contractVersions` field that **zero of the 94 corpus manifests declare** — byte-safe by construction — and **not** a third `GenerateTarget`. Two sentences in `ROADMAP.md` and one in `README.md` say otherwise and inflate this blocker; fix them in this task.
2. **Python is unschedulable, and the roadmap should say why rather than carry an open `[ ]`.** There is no Python connector-kit in the SDK; `formatAll()` runs Biome, which has no Python formatter; and decisively there is **no Python corpus**, so `diff:golden`, `reach` and the four-fixture byte invariant have no analogue. Every quality mechanism this project has is unavailable for Python output.
3. **`npm create` is release infrastructure**, complicated by the SDK's own design document having rejected the unscoped name this repo holds, and by `npm create` running under Node in a Bun-only project.
4. **The `permissions` shape mismatch, owned by neither repository.** `nimbus-sdk` `main`'s v1 conformance suite declares `permissions` an **array**; all 94 corpus manifests and the gateway use an **object**. The unmerged **RFC-0010** worktree's `sandbox/case.schema.json` calls the array *"the legacy array form"* its harness must tolerate alongside an object — so the SDK is moving toward the shape this generator already emits. **This generator will not add a translation layer**: it blocks the handshake target specifically, and only if still unresolved when that target ships.

Plus the free interim item: the cross-link is one-directional — this README points at `@nimbus-dev/create-connector`; the SDK repo has no reciprocal link.

- [ ] **Step 2: Verify the claims you can, and mark the ones you cannot**

Several describe another repository's state as of 2026-08-05. **Any claim you cannot verify at HEAD must carry its date and what it was checked against**, exactly as *The measured ceiling* does. Do not restate a cross-repo fact as though it were timeless.

- [ ] **Step 3: Turn Stage G's checkbox into a pointer**

`docs/ROADMAP.md`'s Stage G becomes a link to `docs/CONSOLIDATION.md`. Judge its marker honestly, the way Stage F was judged: scoped-and-recorded is not the same as built.

- [ ] **Step 4: Commit**

```bash
git add docs/CONSOLIDATION.md docs/ROADMAP.md docs/README.md README.md
git commit -m "docs: scope consolidation, and stop overstating the handshake blocker"
```

---

## Task 10: the gate lists, then retire `docs/superpowers/`

**Files:**
- Modify: `CLAUDE.md`, `CONTRIBUTING.md`, `docs/RELEASING.md`, `docs/ARCHITECTURE.md`, `docs/GLOSSARY.md`, `docs/GOVERNANCE.md`, `.claude/commands/cnc-*.md`, `.github/workflows/ci.yml`
- Delete: `docs/superpowers/`

- [ ] **Step 1: Fix the gate lists**

`reach --baseline` is named in no canonical gate list except `docs/ARCHITECTURE.md` and `cnc-preflight.md`. `CLAUDE.md`'s table has a `reach` row but no `--baseline` row. `CONTRIBUTING.md` contains no occurrence of `reach` at all and tells contributors about two of the four local gates. `docs/RELEASING.md` and `ci.yml` both say "three gates need a Nimbus checkout" when there are **four**. Verify that count at HEAD and correct every instance. **A tier-regression gate no checklist names is a gate that silently stops being run** — `bun run preflight` from Task 1 is the structural fix, and every list should now name it.

- [ ] **Step 2: Document `fixtures/snapshots/` and `bun run snapshot:update`**

Documented nowhere. `.claude/commands/cnc-add-fixture.md` omits both that step and the `derive-round-trip.test.ts` step — so following the fixture guide end-to-end leaves `bun test` red. Fix the guide and add the snapshots to `docs/ARCHITECTURE.md`.

- [ ] **Step 3: State CI's permanent ceiling**

In `CONTRIBUTING.md` and `docs/TESTING.md`: what CI proves, what only a local run proves, and why that is not fixable. `docs/ROADMAP.md` already refuses the tempting fix — *"Do not add a CI job that skips when the root is absent; a silently-skipping gate is the failure mode this repo keeps removing."*

- [ ] **Step 4: Record the scheduled-workflow expiry in `docs/GOVERNANCE.md`**

Both scheduled workflows are auto-disabled after 60 days of repository inactivity. The daily `--registry` acceptance run and the weekly CodeQL run are precisely the unattended safety nets. Dependabot's weekly branch pushes reset the window incidentally, which fails exactly when nothing needs updating. GitHub emails before disabling, so the actionable instruction is: **re-enable them; do not assume green means running.**

- [ ] **Step 5: Record the write-path coverage gap in *Known limitations***

No real-connector fixture declares a write tool, so `diff:golden` has **zero purchase on the Stage C emitter paths**. `method`, `effect`, `body` and the `<local>Send` helper are exercised only by synthetic `zz*` fixtures, which byte-match nothing. Worth stating even though no suitable corpus connector exists to fix it, because "the write path is byte-verified" is currently implied by the fixture list and is not true. **Re-verify at HEAD** — a fixture may have been added since.

- [ ] **Step 6: Add `preflight` to `CLAUDE.md`'s gate table, and add `docs/TESTING.md` / `docs/SPEC.md` / `docs/CONSOLIDATION.md` to `docs/README.md`**

- [ ] **Step 7: Delete `docs/superpowers/`**

Specs and plans go **last**, per `ef59c13`. This plan is inside that directory — read it fully before deleting, or work from the ledger.

- [ ] **Step 8: Re-run the dangling-citation sweep from Task 5**

The deletion is what turns a live citation into a dangling one, so the sweep only means something after it. Every reference to `docs/superpowers/` must now be gone or converted to inline reasoning.

- [ ] **Step 9: Full eight-gate sweep, reported individually**

Then confirm the four locked fixtures at 6/6 by grep.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "docs: name every gate in every list, and retire the design workspace"
```

---

## Task 11: clear Sonar, and raise coverage as far as it honestly goes

**Files:**
- Modify: `bunfig.toml`, plus whichever test and source files close a real gap
- Verify only: `sonar-project.properties`

Added at the maintainer's request after the plan was written. It runs **last** so it sees the
final tree — every earlier task adds code, and coverage raised before them would be re-measured
anyway.

- [ ] **Step 1: Get the findings, and say which half you are doing**

`sonar.projectKey=nimbus-agent_create-nimbus-connector`. The project is **not readable
anonymously** — `api/measures/component` and `api/components/show` both answer *"Project doesn't
exist"* — so the finding list must come from the SonarCloud UI or an authenticated token. If you
have neither, **say so plainly in the report and do the coverage half only.** Do not guess at a
finding list and call it cleared; the precedent commit `9c0886f` cleared 87 real findings, and a
report claiming "no findings" without having read them is the false green this repo exists to
refuse.

Note that Task 4 adds `sonar.qualitygate.wait`, which is the structural half of this: without it,
findings accumulate behind a green workflow, which is how the count reached 87 before.

- [ ] **Step 2: Read `bunfig.toml` in full before touching coverage — it forbids the obvious move**

It explains at length that `src/cli.ts` and `src/prompts.ts` are excluded from the **metric, not
from testing**: both are driven through `Bun.spawnSync` on the real binary, which Bun cannot
instrument, so every line `main()` executes reads as uncovered. It then says directly:

> So do NOT "raise coverage" on those two by adding in-process tests that duplicate the
> subprocess ones. That would move the number without adding assurance, which is the
> false-green pattern this repo has spent several rounds removing.

**That instruction binds this task.** "As high as possible" means as high as *real assurance*
reaches, not as high as the number can be pushed.

- [ ] **Step 3: Close the real gaps, and only the real ones**

At the time of writing, per-file coverage is 100% almost everywhere. The exceptions:

| File | Gap |
| --- | --- |
| `src/derive/manifest.ts` | 89.29% lines — sets the current floor |
| `src/emit/server/tools-hand.ts` | 90.00% functions — sets the current function floor |
| `src/format.ts` | 90.91% |
| `src/emit/server/tools-rest.ts` | 91.67% |
| `src/derive/index.ts` | 97.22% |

**Re-measure before acting** — Task 1 already added `scripts/_lib/preflight.ts`, and later tasks
add `scripts/_lib/build-spec-doc.ts`.

For each gap, identify the *uncovered branch* and ask what would make it observable. If the answer
is a genuine untested behaviour, test it. If the answer is that the line is unreachable, that is a
finding about the line, not about the test. `src/format.ts` is the model: its gap closed by
extracting `formatterUnavailableReasonFor()` as a pure exported function and unit-testing all six
diagnosis branches, **while keeping** the subprocess tests that prove `initFormatter` routes a
failed import into that diagnosis. Both layers earned their place. Follow that shape.

- [ ] **Step 4: Raise `coverageThreshold` to the new floor**

It is `{ lines = 0.88, functions = 0.90 }`. Raise it to whatever the weakest file actually
supports after Step 3, and **update `bunfig.toml`'s comment to name the new floor-setting file and
its number**, exactly as the current comment names `src/derive/manifest.ts` and
`src/emit/server/tools-hand.ts`. A threshold whose comment names the wrong file is the stale-claim
defect this branch has hit repeatedly.

Do not raise the floor above what the tree supports "for headroom" — the next legitimate line
added to a small file would fail the gate for no reason. `manifest.ts` already has zero slack, and
the comment says so.

- [ ] **Step 5: Run every gate, then commit**

```bash
git add bunfig.toml test/ src/
git commit -m "test: close the remaining coverage gaps and raise the floor to match"
```

---

## Self-Review

**Spec coverage.** §6.2 → Task 9. §7.1 (CI's ceiling) → Task 10 Step 3. §7.2 (`preflight`) → Task 1. §7.3 (documents table) → Tasks 6–10; `docs/GLOSSARY.md`'s four reach tiers / three frame styles / case 1 vs case 2 → Task 10 Step 6. §7.5 → Tasks 2, 5, 6, 7, 8, 10. §7.6 → Tasks 3, 4, 5, 10 Step 4. §7.4 (hygiene baseline) is a measurement, not a task.

**One deliberate deviation.** §7.3 lists `CLAUDE.md`'s "deriver-stays-in-`scripts/` rule reversed" and `cnc-reach-deriver.md` as needing the same commit. **Both are already correct at HEAD** — verified while writing this plan: `cnc-reach-deriver.md` says *"The deriver lives under `src/derive/`, and ships"*, fixed at `b27cac2`. No task covers it because there is nothing to do.

**Gaps I am accepting.** The `origin/stage-c-writes` branch with no open PR, and 33 local branches tracking a gone upstream, are repository hygiene rather than code — worth a single cleanup step, folded into no task because they need the maintainer's judgment about what to keep.

**Type consistency.** `runPreflight` / `PreflightReport` (Task 1) are cited by name in Task 10. `buildSpecDoc` / `SPEC_DOC_PATH` (Task 8) mirror `buildSchema` / `SCHEMA_PATH`, which exist.

**Ordering.** Task 1 before Task 10 because the gate lists cite `preflight`. Task 5's sweep runs twice — once before the deletion and once after — because only the deletion can create the dangling references it looks for. Task 10 deletes this document, so it must be read before it runs.
