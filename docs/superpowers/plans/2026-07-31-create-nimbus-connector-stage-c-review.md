# Implementation Plan Review: create-nimbus-connector (Stage C)

This document provides a review, suggestions, and open questions for the [Stage C Implementation Plan](file:///C:/gitrep/create-nimbus-connector/docs/superpowers/plans/2026-07-31-create-nimbus-connector-stage-c.md).

---

## 1. Open Questions

### Redundant Zod Refinement validation in ToolSchema (Task 1)
* **Question:** In Task 1 (Step 3), the schema definition uses both `.refine()` and `.superRefine()` to assert that every key in `body` is a declared argument:
  ```ts
  .refine((t) => t.body === undefined || Object.keys(t.body).every((k) => k in t.args), {
    message: 'every "body" key must name a declared arg',
  })
  .superRefine((t, ctx) => {
    if (t.body === undefined) return;
    for (const k of Object.keys(t.body)) {
      if (!(k in t.args)) {
        ctx.addIssue({ code: "custom", message: `"body" key "${k}" is not a declared arg` });
      }
    }
  });
  ```
* **Implication:** The checks are identical. The `.refine` will trigger and reject the validation before or at the same time as `superRefine`, making the second block redundant.
* **Suggestion:** Remove the `.refine` check and keep only the `.superRefine` (which provides a more specific error pointing to the exact key `k`), or simplify to just the `.refine` check if custom error issues per key aren't required.

### URLSearchParams scope serialization for client-credentials (Task 6)
* **Question:** In Task 6 (Step 4), the plan details the token fetch request as:
  ```ts
  const body = new URLSearchParams({ grant_type: "client_credentials", scope: SCOPE });
  ```
* **Implication:** If `scope` is optional and thus undefined/omitted in the spec, passing it directly as `scope: SCOPE` might serialize it as `"scope": "undefined"`.
* **Suggestion:** Dynamically construct the query parameters:
  ```ts
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (SCOPE) {
    body.set("scope", SCOPE);
  }
  ```

### expected tree assertion in snapshots.test.ts (Task 7)
* **Question:** In Task 7 (Step 1), the test checking empty expected trees is written as:
  ```ts
  expect(() => compareSnapshot(new Map([["a.ts", "x"]]), new Map())).not.toThrow();
  ```
  But the comment says: `// Stage A shipped a harness that printed success on zero fixtures. Not again.`
* **Implication:** If the expectation is that an empty expected tree shouldn't be allowed to pass vacuously, testing `not.toThrow()` on `compareSnapshot` suggests the check for "empty expected tree" is shifted entirely to `loadSnapshot`.
* **Suggestion:** Clarify if `loadSnapshot` is the one enforcing non-emptiness (which throws `/no snapshot/i`), and whether `compareSnapshot` itself should enforce that `expected` is non-empty if called in other contexts.

---

## 2. Improvements & Suggestions

### Basic Authentication Encoding in client-credentials (Task 6)
* **Suggestion:** For `credentialsIn: "basic"`, the plan proposes:
  ```ts
  Authorization: `Basic ${btoa(`${id()}:${secret()}`)}`
  ```
* **Improvement:** While standard for ascii credentials, `btoa` in JS standard library will fail on characters outside the Latin1 range (`U+0000` to `U+00FF`). Since client IDs and secrets are typically alphanumeric or standard characters it is fine, but it is worth ensuring that test credentials/secrets used in fixtures don't contain UTF-8 characters that could break `btoa`.
