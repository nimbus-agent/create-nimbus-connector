# Review: Finishing the roadmap — design

**Review Date:** 2026-08-05  
**Review Target:** [`2026-08-05-roadmap-completion-design.md`](./2026-08-05-roadmap-completion-design.md)

---

## Summary of Strengths

1. **Realistic, Data-Driven Baseline:** The document correctly points out the distortion of bucket counts versus actual connector coverage due to short-circuiting frame failures. Reframing the deriver-only cohort as two connectors (`mercury` and `zendesk`) sets a realistic target for identical byte reproduction (6/94) while aiming for a much larger expansion of `emits` coverage.
2. **Case-2 Rule Safeguard:** The formalization of the "Case-2 Rule" prevents false successes in `emits` and enforces that any non-emitted shape claimed by a recognizer is explicitly backed by a test proving 100% field recovery correctness.
3. **Decoupled Iteration (Phased Implementation):** Structuring the 18 items into 4 distinct phases, where each phase's plan is written only after the previous lands, prevents design drift and guards against building recognizers on top of a shifting accessor layer.
4. **Thorough Audit and Bug Identification:** Diagnosing the `BIOME_VERSION` drift/tautology, `rows` collision vulnerability, and scheduled workflow auto-disable limits shows an exceptional level of attention to repo hygiene and release readiness.

---

## Open Questions & Suggestions

### 1. Auto-Disabled Scheduled Workflows: Automated Keep-Alive
* **Observation:** The design notes that the daily registry acceptance runs and weekly CodeQL runs will auto-disable after 60 days of inactivity, and proposes placing a reminder in `docs/GOVERNANCE.md`.
* **Question:** Since this repo is intended to sit unattended, is a manual reminder in governance docs robust enough?
* **Suggestion:** To make the unattended state truly self-sustaining, consider adding a lightweight scheduled keep-alive workflow. For example, a workflow that runs every 50 days and pushes a dummy commit or updates a timestamp file to keep the repository active and prevent GitHub from disabling the cron triggers. Alternatively, we could expose a check in `bun run preflight` or the release check that warns if a scheduled workflow was last triggered more than 7 days ago.

### 2. Mechanical Verification of `RESERVED_IDENTIFIERS`
* **Observation:** The audit punch list calls for checking `RESERVED_IDENTIFIERS` completeness mechanically rather than relying on manual updates or reviewer conventions.
* **Suggestion:** We can automate this verification in `test/validate.test.ts` by:
  1. Reading the source code of the template and emitter files (under `src/emit/`) as plain text.
  2. Using regex or simple AST searches to extract all hardcoded variable names, helper function calls, or template parameters (e.g., `rows`, `root`, `matchesResult`, etc.).
  3. Asserting that every identifier matching this list is present in the `RESERVED_IDENTIFIERS` array. This ensures that new template constructs or helper names are automatically caught if they are not reserved.

### 3. Compilation Verification of Hand-Rolled and Rest-Kit Outputs
* **Observation:** The audit notes that `bun test` never compiles hand-rolled or rest-kit emitted `server.ts` files, exposing a hole in the CI type-checking guarantees.
* **Suggestion:** We should expand `test/emit/emitted-typecheck.test.ts` (or create a dedicated test file) to dynamically load the generated spec for *all* test fixtures (including hand-rolled and rest-kit ones), emit the server file to a temporary directory, and execute `tsc --noEmit` on them. If performance is a concern (e.g., running `tsc` multiple times is slow), we can merge all generated code blocks into a single compilation context or run it as part of `bun run preflight` instead of standard `bun test`.

### 4. Graceful Degradation for `@babel/parser`
* **Observation:** Moving the deriver into `src/` makes `@babel/parser` an `optionalDependency`.
* **Question:** How does the CLI handle cases where the user executes `--from-connector` but `@babel/parser` is missing?
* **Suggestion:** Wrap the dynamic import of `@babel/parser` in `src/derive` with a `try/catch` block. If the import fails, catch the error and print a clear, user-friendly message explaining that `--from-connector` requires `@babel/parser` to be installed (e.g., `npm install -g @babel/parser` or running the command with a package manager that resolves optional dependencies), rather than letting Bun throw a raw stack trace.

### 5. Resolution Path for the Manifest Permissions Schema Discrepancy
* **Observation:** The SDK's published manifest schema expects `permissions` as an `array`, whereas the 94 corpus manifests and the gateway use an `object`.
* **Question:** Since this is a required field and incompatible across tools, does this block consolidation, or is there an interim translation layer planned?
* **Suggestion:** If the SDK cannot be modified to accept both formats, `create-nimbus-connector`'s emitter should probably feature an internal translation layer that adapts the permissions structure based on the targeted platform version, or the spec itself should define the permission block as an object and translate it to an array during the manifest emission step if targeting the SDK schema. This should be explicitly scoped in `docs/CONSOLIDATION.md`.
