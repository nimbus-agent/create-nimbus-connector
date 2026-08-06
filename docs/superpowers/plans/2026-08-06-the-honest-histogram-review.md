# Review: Phase 2b: The Honest Histogram — Implementation Plan

**Review Date:** 2026-08-06  
**Review Target:** [`2026-08-06-the-honest-histogram.md`](./2026-08-06-the-honest-histogram.md)

---

## Summary of Strengths

1. **Strict Totality & Verification Focus:** The plan correctly prioritizes verifying output shapes (e.g., verifying the `String(...)` wrapper against the arg's declared type) rather than storing/reconstructing spec fields unnecessarily.
2. **Clear Case-2 Separation:** Distinguishing between text divergences (Axis 1 & 2 in Task 11, Task 9) and behavior differences (Shapes C & D in Task 9) ensures we never compromise functional equivalence.
3. **AST Safety via Shared Hoist Splicing:** Reusing `splitHoists` rather than duplicating the hoist parsing loops keeps the codebase DRY and robust.

---

## Open Questions & Suggestions

### 1. Fetch Helper Base URL Availability in `tools-rest.ts`
* **Observation:** Task 3, Step 6 suggests that during REST tool recognition, `recognizeQueryBlock` should verify that the stripped prefix of `pathExpr` matches the fetch helper's base URL.
* **Problem:** In `deriveRestKitSpec` ([`src/derive/index.ts`](file:///C:/gitrep/create-nimbus-connector/src/derive/index.ts#L226-L230)), `recognizeRestTools` is invoked *before* `recognizeRestFetchHelper`. Even if we reorder them, `recognizeRestTools` and `recognizeOneCall` currently do not accept any fetch helper metadata or base URL parameters.
* **Suggestion:** We should:
  * Reorder the calls in `deriveRestKitSpec` so `restFetchHelper` is recognized first.
  * Update `recognizeRestTools` and `recognizeOneCall` to accept an optional `helperBase?: string` parameter to perform this validation inline.
  * Alternatively, postpone the base prefix match verification to `deriveRestKitSpec` where both the recognized tools and the fetch helper are returned.

### 2. AST Range Mapping & Splicing for Axis 3
* **Observation:** In Task 11 (Axis 3 — Named read-only registrar), the plan suggests removing `register<X>Tools` from `verifyStatements` and splicing its body statements directly into the list of statements to recognize.
* **Risk:** Since the body statements are physically located inside the `register<X>Tools` function declaration, their byte ranges are subsets of the function declaration's range. If we claim the body statements, we must ensure we don't have overlapping claim conflicts or unexpected behavior in the `ClaimSet` when verifying unclaimed ranges of the outer function.
* **Suggestion:** Ensure the outer function declaration node itself is excluded from the list of statements verified by `claims.unclaimed(...)` or that the function declaration itself is marked as claimed once its nested body statements are successfully claimed.

### 3. Client Credentials Claim Ordering
* **Observation:** In Task 8, Step 4, the plan notes that the client-credentials recognizer must run before Pass B (the plain-accessor loop) to prevent the token wrapper from being claimed as a standalone plain accessor.
* **Suggestion:** Add an explicit safeguard or unit test to verify that if a client-credentials block is partially malformed, it doesn't fail silently while allowing Pass B to greedily claim the wrapper, resulting in a confusing `unclaimed` statement error rather than a descriptive `client-credentials` blocker.
