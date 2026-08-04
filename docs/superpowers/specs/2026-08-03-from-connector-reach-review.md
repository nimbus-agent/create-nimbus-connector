# Review: Corpus reach measurement

**Review Date:** 2026-08-03  
**Review Target:** [`2026-08-03-from-connector-reach-design.md`](./2026-08-03-from-connector-reach-design.md)

---

## Summary of Strengths

1. **In-Memory Spec Derivation:** Deriving specs entirely in-memory avoids licensing/compliance pitfalls (AGPL spec contamination).
2. **The Totality Rule:** This is the key insight. Failing when any statement remains unclaimed prevents the "silent failure/false green" issue of simple pattern matching.
3. **Hermetic Round-Trip Test:** Using `fixtures/*.spec.json` -> `generate()` -> `derive()` -> `generate()` check ensures the emitter and recognizer remain in lockstep without external dependencies.
4. **Structured Blocker Histogram:** Grouping and showing near-misses dynamically via unrecognized syntactic heads keeps the next actions visible and data-driven.

---

## Open Questions & Suggestions

### 1. Babel Parser Configuration for TypeScript
* **Observation:** The design mentions using `@babel/parser` to parse the TS files.
* **Question:** Since `src/server.ts` contains TypeScript type annotations, generics, and TS-specific syntax, does the parser configuration include the `typescript` plugin?
* **Suggestion:** Explicitly note in the design or implementation that `@babel/parser.parse` must be called with `{ plugins: ['typescript'] }` (and potentially others like `decorators` if present) to avoid syntax errors on TS types.

### 2. Biome Formatting Performance
* **Observation:** The harness byte-compares files, necessitating that both target and generated outputs are formatted identically. Running Biome formatting on 94 generated output files sequentially using child processes could be a performance bottleneck.
* **Questions:**
  * How will the formatter be invoked? Will we call the Biome CLI programmatically/sequentially, or can we format the generated string in-memory?
  * If using the CLI, is there a way to batch-format them or pipe strings to a single daemon process to keep `bun run reach` fast?
* **Suggestion:** Explore using a JS-based formatter wrapper or spawning a single long-lived formatting process, or batching file writes and running one single CLI invocation (`biome format --write <temp-dir>`) if temp files are used for the `all-identical` comparison.

### 3. Hand-authored / Custom Helpers in `server.ts`
* **Observation:** The design states: *"all-identical is permanently capped by gaps no spec field can close — hand-authored READMEs and `*-mapping.ts` bodies... so it would measure content gaps rather than the spec language."*
* **Question:** What about custom/hand-authored helper functions or imports within `src/server.ts` itself? If a connector contains custom TypeScript code in its `server.ts` that the spec language does not support and never plans to support, will the totality rule permanently block it from reaching the `server-identical` tier?
* **Suggestion:** We should define how the totality rule handles these. For example:
  * Do we need an escape hatch or "custom block" claim for code that is explicitly hand-written?
  * Or is the goal indeed to make the spec language expressive enough to cover *everything* in `src/server.ts`, meaning any hand-written code there is a legitimate blocker? Clarifying this expectation will prevent developer frustration when trying to reach `server-identical`.

### 4. Dirty Checkout and Git Commit Tracking
* **Observation:** `fixtures/reach-baseline.json` records the Nimbus commit it was measured at (`git -C <root> rev-parse HEAD`).
* **Questions:**
  * What happens if the Nimbus checkout has local/uncommitted changes (dirty state)? The commit SHA alone won't represent the actual state of the files being read.
  * Should the tool check for a dirty git working directory (e.g., via `git status --porcelain`) and warn the user, or refuse to run `--baseline` if the repository is dirty?
* **Suggestion:** Refuse to update the baseline if the Nimbus repository is dirty, to prevent recording transient states under a clean commit SHA.

### 5. AST Traversal: Granularity of Claims
* **Observation:** The design states: *"Statement granularity is the unit because statements are what the emitter writes."*
* **Question:** How do matchers handle multi-statement structures or nested blocks? For example, variable declarations that are used in subsequent statements. If a matcher needs to claim a sequence of statements (e.g., an variable declaration + an expression statement utilizing it), does the claim system support claiming ranges of statements or marking specific AST nodes as claimed recursively?
* **Suggestion:** Ensure the claim-tracking walker supports claiming nodes by reference or ID, rather than just simple index-based statement lists, to allow helper matchers to clean up nested declarations (e.g., variable declarations inside arrow function bodies).
