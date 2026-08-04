# Review: Completing the deriver's recognizer set — design

**Review Date:** 2026-08-04  
**Review Target:** [`2026-08-04-completing-the-recognizer-set-design.md`](./2026-08-04-completing-the-recognizer-set-design.md)

---

## Summary of Strengths

1. **Strategic Priority (Reach Fidelity):** The design correctly diagnoses that the reach-measurement tool is currently bottlenecked by the `no-frame` bucket (81 out of 94 connectors). Expanding frame recognizers is the logical precursor to any further spec-language design.
2. **Guarded Accessor Layer:** Confining raw Node casts to a single file (`read.ts`) and removing the open index signature from `AstNode` is an excellent type-level enforcement mechanism that prevents bugs at compile-time rather than during review or testing.
3. **Totality containment safety:** Recognizing the containment hazard in read-only-kit nested callbacks and separating `toolStatements` from `verifyStatements` preserves the integrity of the totality rule.
4. **Fixture-Driven Sequence:** The incremental commit plan, backed by moving fixtures from `BLOCKED` to `ROUND_TRIP` and creating `zzreadonly`, ensures that each recognizer has verified coverage as it is built.

---

## Open Questions & Suggestions

### 1. AST Traversal & Node Children Typing
* **Observation:** Removing the index signature from `AstNode` restricts node access strictly to `type`, `start`, `end`, and `loc`.
* **Question:** How will AST traversal / node walking (e.g., in `claims.ts` or helper matchers) access child nodes (like `node.body`, `node.declarations`, `node.argument`, etc.) to recurse or examine nested structures?
* **Suggestion:** 
  * If the traverser walks the AST, it needs to access children. Either `read.ts` should expose a generic `getChildren(node: AstNode): AstNode[]` traversal helper, or `read.ts` should type-safely expose common block/body structures (e.g., `blockBody(node): AstNode[] | undefined`).
  * Ensure the design clarifies that traversers do not need to fall back on `as any` casts to recurse.

### 2. Negative Numbers in `numberLit`
* **Observation:** The design notes that `-1` parses as a `UnaryExpression` rather than a `NumericLiteral`, so `numberLit` will reject it.
* **Question:** If a helper/accessor rejects negative numbers, how should a client recognizer that expects potential negative numbers (e.g., ports, defaults, numeric bounds) read them?
* **Suggestion:** Instead of leaving the handling of `UnaryExpression` to every client recognizer, export a `numericValue(n: AstNode): number | undefined` helper from `read.ts` that handles both positive `NumericLiteral` and negative unary expressions (e.g., `- <NumericLiteral>`).

### 3. Verification Scope for Read-Only-Kit wrappers
* **Observation:** The frame "removes the wrapper from `verifyStatements` and splices in the callback's body statements".
* **Question:** If the callback wrapper statement itself is omitted from `verifyStatements`, what prevents developers from adding unauthorized statements or syntax *outside* the callback wrapper at the top level of the file?
* **Suggestion:** The frame should only exclude/replace the wrapper statement itself. Any other top-level statements (e.g., imports, constants, or unauthorized helpers) must remain in `verifyStatements` so that the totality rule still verifies they are claimed or blocked.

### 4. Imports in the Search Filter File
* **Observation:** `derive/search-filter.ts` will run its own totality rule over the filter file's statements.
* **Question:** How are standard imports in the search filter file (e.g., importing `makeQueryFilter` or types) claimed so they don't trip the filter file's totality rule?
* **Suggestion:** Define a standard import recognizer for the filter file that claims standard/expected import statements (similar to how imports are claimed in the main server file).

### 5. `createZodToolRegistrar` vs. `makeRestToolRegistrar`
* **Observation:** Seven rest-kit connectors use `createZodToolRegistrar` and report `no-frame`.
* **Question:** Is `createZodToolRegistrar` a legacy wrapper, or is it a valid alternative frame style that should be recognized?
* **Suggestion:** Prioritize diagnosing this at the start of Commit 3. If it is an outdated/deprecated pattern, refactoring those seven connectors to use the standard `makeRestToolRegistrar` (via the emitter or manual clean-up) might be cleaner than supporting two distinct rest-kit frame patterns in the deriver.
