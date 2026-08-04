# Review of 2026-08-02-conditional-query-params.md

This document contains a code review, open questions, improvements, and suggestions for the **Conditional query parameters Implementation Plan**.

---

## 1. Critical Suggestions & Improvements

### A. Non-GET Method Support in Hand-Rolled Tools (Task 4, Step 5)
In **Task 4: Step 5 (Implement the hand-rolled branch)**, the plan suggests generating the following handler body when `tool.query !== undefined`:
```ts
    const queryLines = renderQueryLines(query, { param: PARAM, hoisted });
    const inner = [
      `const u = new URL(${pathExpr});`,
      ...queryLines,
      "const path = `${u.pathname}${u.search}`;",
      `return jsonResult(await ${spec.fetchHelper.local}(path));`,
    ];
```
* **Issue**: This assumes all hand-rolled tools with query parameters are `GET` requests and hardcodes the GET fetch helper (`${spec.fetchHelper.local}`). If a future tool declares a `query` array but uses a non-GET method (like `POST`, `PUT`, or `DELETE`), calling the GET helper instead of `${spec.fetchHelper.local}Send` will result in incorrect behavior or type check/runtime failures.
* **Suggestion**: Make the fetch helper call conditional on the method, matching the pattern used elsewhere in the same file:
  ```ts
  const callWithQuery =
    tool.method === "GET"
      ? `jsonResult(await ${spec.fetchHelper.local}(path))`
      : `jsonResult(await ${spec.fetchHelper.local}Send(path, ${JSON.stringify(tool.method)}, ${bodyExpr ?? "undefined"}))`;
  
  const inner = [
    `const u = new URL(${pathExpr});`,
    ...queryLines,
    "const path = `${u.pathname}${u.search}`;",
    `return ${callWithQuery};`,
  ];
  ```

### B. Use `identifierField()` for `QueryParamSchema.arg` validation (Task 1, Step 3)
In **Task 1: Step 3 (Implement the schema)**, `QueryParamSchema` is defined as:
```ts
export const QueryParamSchema = z.strictObject({
  name: z.string().min(1),
  arg: z.string().min(1),
  omitWhen: z.literal("empty").optional(),
});
```
* **Improvement**: Since tool argument names are validated to be valid JS identifiers via `identifierField()`, validating the query's `arg` parameter using `identifierField()` instead of a simple `z.string().min(1)` makes validation stricter and more consistent upfront, rather than relying solely on the refinement check.
* **Suggestion**:
  ```ts
  export const QueryParamSchema = z.strictObject({
    name: z.string().min(1),
    arg: identifierField(),
    omitWhen: z.literal("empty").optional(),
  });
  ```

### C. Defensive check for `t.args` in Zod `superRefine` (Task 1, Step 3)
In the `superRefine` block for `ToolSchema`:
```ts
      if (!(q.arg in t.args)) {
```
* **Improvement**: Although `t.args` has a default value (`.default({})`), it is safer to write defensively as `if (!t.args || !(q.arg in t.args))` to prevent any potential runtime errors during Zod validation/refinement phases if `args` is unresolved.

---

## 2. Clarifications & Open Questions

1. **How are query values containing special characters handled?**
   * Since `URL.searchParams.set()` automatically encodes query parameter values, do we have any tests or validation to ensure that existing query-encoding logic (which might be handled manually in some path parameters) does not conflict with or double-encode values in the query parameters?
   * *Answer / Design Note*: `searchParams.set` handles percent-encoding automatically. This is a cleaner approach, and the documentation in Task 7 should explicitly point this out to authors.

2. **Wait/Timeout Behavior in CI Gates?**
   * In **Task 7: Step 4 (Full preflight)**, there are many acceptance and conformance tests. If there are environment issues or missing local checkouts of `C:/gitrep/Nimbus`, does the implementation plan have a fallback or a specific skip policy?
