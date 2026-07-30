# Implementation Plan Review: create-nimbus-connector (Stage A)

This document provides a review, suggestions, and open questions for the [Stage A Implementation Plan](file:///C:/gitrep/create-nimbus-connector/docs/superpowers/plans/2026-07-30-create-nimbus-connector-stage-a.md).

---

## 1. Open Questions

### Bun Compatibility with `@biomejs/wasm-nodejs`
* **Question:** The plan specifies Bun as the runtime and uses `@biomejs/wasm-nodejs` along with `@biomejs/js-api`.
* **Implication:** Bun's compatibility with native Node.js WASM loaders/bindings can sometimes vary between Bun minor versions.
* **Suggestion:** Verify if `@biomejs/wasm-nodejs` initializes successfully under Bun's runtime without extra flags. If issues occur, consider if fallback to calling the CLI binary or `@biomejs/wasm-web` is needed.

### Standard Async Line Reader in Bun (Task 17)
* **Question:** In Task 17 (Step 4), `ask` uses:
  ```ts
  for await (const line of console) { ... }
  ```
* **Implication:** `console` is not standardly an async iterable for reading lines in Node or Bun environments.
* **Suggestion:** Use Bun's native synchronous `prompt(question, fallback)` function, which is fully supported, synchronous, clean, and avoids async stream complexities.

---

## 2. Improvements & Suggestions

### Automated Scratch Cleanup (Task 18)
* **Suggestion:** Task 18 involves creating a scratch folder `zzscratch` inside the monorepo to test compiler and lint compliance.
* **Improvement:** To prevent polluting the monorepo in case of a crash or unexpected failure, wrap the execution steps inside the test/script in a `try...finally` block that guarantees the deletion of `zzscratch` regardless of the success or failure of the typecheck/lint commands.

### offline/air-gapped WASM Readiness
* **Suggestion:** Clarify whether the WASM binary from `@biomejs/wasm-nodejs` requires external network fetch on the first initialization, or if it is fully self-contained. Since this tool might be run in restricted or CI environments, document any proxy/offline setup needed.
