# Review: Guarded Accessors and the Two Missing Frames — Implementation Plan

**Review Date:** 2026-08-04  
**Review Target:** [`2026-08-04-guarded-accessors-and-frames.md`](./2026-08-04-guarded-accessors-and-frames.md)

---

## Summary of Strengths

1. **Incremental Tasks:** Splitting the implementation into 7 logically discrete, sequentially verifiable steps ensures regressions are pinpointed immediately.
2. **Comprehensive Unit Testing:** Designing tests *before* writing the implementation (e.g., Task 1 Step 1, Task 4 Step 1, Task 5 Step 1, Task 6 Step 1) guarantees correct API behavior and avoids false successes.
3. **Well-Defined Interfaces:** The plan clearly articulates what interfaces each task consumes and produces, aiding the subagent in code generation.
4. **Detailed Failure Diagnostic:** Splitting `no-frame` into specific buckets (`frameFailureKind`) is an excellent diagnostic improvement that clarifies remaining gaps.

---

## Open Questions & Suggestions

### 1. Missing `blockerFor` in Task 2 Step 4 Listing
* **Observation:** The provided code block for `scripts/_lib/derive/blockers.ts` in Task 2 Step 4 does not include the `blockerFor` export.
* **Problem:** A subagent replacing the body of `blockers.ts` with that exact code block will inadvertently delete `blockerFor`, breaking compilation across the project.
* **Suggestion:** Update the listing in Task 2 Step 4 to explicitly include `blockerFor` so that the file contents can be copied cleanly without compilation failures.

### 2. Path Parameter Name Resiliency in `tools-rest.ts`
* **Observation:** Task 5 Step 3 states that the path parameter is `parsed` and that `recognizePath` is called with locals keyed against that name.
* **Question:** While the emitter currently writes `(parsed) => ...`, could future versions or manual edits use other names (e.g., `p`, `args`, or `params`)?
* **Suggestion:** Instead of hardcoding the string `"parsed"`, read the first parameter's name dynamically via `identName(arrow.params[0])` and pass it to `recognizePath` to make the path-template extractor more resilient.

### 3. Suffix Matching in `recognizeReadOnlyFrame`
* **Observation:** In Task 4 Step 3, the import search uses `RUN_READ_ONLY_SUFFIX = "/run-read-only-mcp-connector.ts"` with `.endsWith(RUN_READ_ONLY_SUFFIX)`.
* **Problem:** If a test or a local connector imports the file using a relative path with no leading directory slash (e.g., `import { ... } from "run-read-only-mcp-connector.ts"` or via a symlinked/aliased path), the leading slash in the suffix will cause the match to fail.
* **Suggestion:** Change the match suffix to `"run-read-only-mcp-connector.ts"` (without the leading slash) to make it directory-agnostic and robust to import style variations.

### 4. Optional 6b (`client-credentials`) Plan Deferral
* **Observation:** The self-review acknowledges that design §6b (`client-credentials`) is deferred.
* **Question:** Since this accounts for 4 corpus connectors, should it be explicitly listed as a future item under the follow-up Plan 2 alongside `search`/`body`/`query` to ensure it is not forgotten?
* **Suggestion:** Add a small note in `Scope of this plan` listing `client-credentials` as a specific target for Plan 2.
