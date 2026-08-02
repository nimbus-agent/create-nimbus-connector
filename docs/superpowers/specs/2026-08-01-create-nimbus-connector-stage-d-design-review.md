# Design Review: create-nimbus-connector — Stage D

**Review Date:** 2026-08-01  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Target Spec:** [2026-08-01-create-nimbus-connector-stage-d-design.md](file:///C:/gitrep/create-nimbus-connector/docs/superpowers/specs/2026-08-01-create-nimbus-connector-stage-d-design.md)

---

## 1. Open Questions & Design Feedback

### 1.1 Uniqueness of `filter.export` vs. Shared Filters
* **Context (§3.3 & §1.6):** The validation section states that `filter.export` must be unique across the spec's tools. However, §1.6 mentions that `raindrop` has 2 search tools sharing one filter file.
* **Question:** Do those two search tools in `raindrop` share the *exact same* filter function (i.e. the same export name), or do they use different exports within the same file?
  * If they share the same export name, the uniqueness validation rule will reject the spec.
  * **Recommendation:** If they share the same function name, the validator should allow duplicate `filter.export` names *only if* the filter configurations (fields, tags, etc.) are identical (so they can be deduplicated by the emitter). Otherwise, if they must be unique, the emitter will generate two identical functions under different names, which is acceptable but slightly redundant.

### 1.2 Execution Phase of Throwing Stubs
* **Context (§4.3 & §5.1):** When `filter.fields` is omitted, the emitter generates a throwing-stub extractor.
* **Question:** Does the stub throw during module load/evaluation, or only when the search tool is actually executed?
  * **Recommendation:** The thrown exception should occur **inside** the query filter/extractor function when it is executed, rather than at module load time. This ensures that other tools in the connector remain functional even if the search stub has not been implemented yet.

### 1.3 `runReadOnly` Naming Clarity in Code
* **Context (§2 D2 & Naming Wart):** The name `runReadOnlyMcpConnector` is used for the bootstrap wrapper, even when the connector declares write/delete capabilities (e.g. `hitlRequired: ["write"]` in 9 corpus connectors).
* **Recommendation:** To prevent confusion for developers or security auditors looking at the generated code, the generator should emit a brief inline comment in `server.ts` explaining that `runReadOnlyMcpConnector` is a bootstrap wrapper naming convention and does not restrict the connector from performing write operations.

### 1.4 Response Type Safety and Coercion in Emitter
* **Context (§4.4):** The generated search tool body does:
  ```ts
  const accounts = (root as { accounts?: unknown[] } | null)?.accounts;
  return matchesResult(accounts, filterMercuryAccounts, p);
  ```
* **Question:** How does the SDK's `matchesResult` handle cases where `accounts` is `undefined`, `null`, or not an array?
  * **Recommendation:** If `matchesResult` expects a strict array, the emitter should coerce the result using a default fallback (e.g. `accounts || []`) to prevent runtime type errors before the search utility can handle the input.

---

## 2. Minor Suggestions & Improvements

### 2.1 Performance Warning for Client-Side Filtering
* **Context (§1.8):** Since there is no pagination helper, all filtering is performed client-side on the fetched dataset.
* **Suggestion:** If `maxLimit` is set to a very high value (e.g. > 1000) or if the target API does not support server-side limits, we could output a build-time or validation-time warning reminding the author that client-side filtering of large datasets might impact performance or hit memory limits.

### 2.2 Zod Dependency Verification for Standalone
* **Context (§1.4 & §2 D6):** Standalone targets inline the zod schema instead of importing it from the SDK.
* **Suggestion:** Ensure the generator's validation verifies that `zod` is listed in the `dependencies` of the generated `package.json` for all standalone connectors to avoid resolution issues.
