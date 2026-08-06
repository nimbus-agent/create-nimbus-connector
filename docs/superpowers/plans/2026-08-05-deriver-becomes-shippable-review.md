# Review: Phase 1: The Deriver Becomes Shippable — Implementation Plan

**Review Date:** 2026-08-05  
**Review Target:** [`2026-08-05-deriver-becomes-shippable.md`](./2026-08-05-deriver-becomes-shippable.md)

---

## Summary of Strengths

1. **Precision & Detail:** The plan is exceptionally detailed, providing exact code snippets, test file structures, and precise instructions for updating imports, package files, and documentation.
2. **Correctness-First Sequence:** Sequencing correctness checks (like method and effect recovery) *before* shipping the `--from-connector` flag ensures that the tool never produces silently broken specs that could be committed.
3. **Rigorous Degradation Verification:** Including concrete validation steps (such as hiding `node_modules/@babel/parser` and verifying that plain generation still functions) prevents regressions in core functionality for non-deriver users.
4. **Target Decoupling:** Separating the standalone target checks (`isStandaloneKitImport`) from the monorepo checks ensures that third-party connector authors are supported without regressing monorepo reach measurements.

---

## Open Questions & Suggestions

### 1. Optional Dependency Cleanup in `package.json`
* **Observation:** Task 2, Step 5 moves `@babel/parser` and `@babel/types` to `optionalDependencies`.
* **Suggestion:** Make sure these packages are explicitly deleted from `devDependencies` to avoid package managers complaining about duplicate declarations or using the devDependency range instead of the optional one.

### 2. User-Facing Error Formatting in CLI
* **Observation:** Task 6, Step 5 throws a standard `Error` when the parser is unavailable:
  ```ts
  if (!parserAvailable()) throw new Error(parserUnavailableReason() ?? "the parser is unavailable.");
  ```
* **Question:** Does the CLI's `main()` function have a clean exception-catcher that formats errors for the user, or will this print a raw stack trace?
* **Suggestion:** Ensure that user-facing errors (like missing optional dependencies or validation failures) are caught at the entry point and printed cleanly to stderr (e.g. `console.error(err.message); process.exit(1);`) instead of dumping a full Node/Bun stack trace, which looks unpolished.

### 3. Ambiguity Warnings in `attributeEffects`
* **Observation:** `attributeEffects` attributes `effect` to tools based on their HTTP method and the observed `hitlRequired` array. If multiple POST/PUT/PATCH tools exist and `hitlRequired` contains `"write"`, *all* of them will be assigned `effect: "write"`.
* **Suggestion:** While this is byte-safe (as `server.ts` does not depend on `effect`), it may produce a spec that is semantically different from the original (e.g., changing a POST-based read query to a write). Add a console note or warning output in `--from-connector` when multiple candidate tools are assigned the same inferred effect, advising the user to verify the generated `effect` fields.

### 4. Handling of Missing `--from-connector` Directory Value
* **Observation:** The argument parsing logic in Task 6, Step 4 maps `--from-connector` using `takeValue`.
* **Question:** What happens if the user passes `--from-connector` as the very last argument without specifying a directory?
* **Suggestion:** Confirm that `takeValue` throws an explicit, clear error when the value is omitted (e.g. `"--from-connector requires a directory path"`), rather than failing with an undefined index error.
