# Review: Phase 2a: The Recognizers That Move the Headline — Implementation Plan

**Review Date:** 2026-08-06  
**Review Target:** [`2026-08-06-recognizers-that-move-the-headline.md`](./2026-08-06-recognizers-that-move-the-headline.md)

---

## Summary of Strengths

1. **Byte-Safe Style Recovery:** Recovering `staticPathStyle` and `argsSchemaStyle` is a crucial first step that prevents massive diffs (e.g., 21 lines in `mercury`) and unblocks downstream recognizers from landing at the `emits` tier.
2. **Strict Disagreement Handling:** Using `unanimous` voting and blocking on disagreement (rather than picking a winner or defaulting) preserves the guarantee that the deriver only accepts exact shapes the emitter could write.
3. **Totality Rule on Filter File:** Introducing a totality rule for the second input file (`src/search-filter.ts`) ensures that any custom logic or unknown statements in the filter file are flagged as blockers rather than silently ignored.
4. **Scope-Gating Env Claims:** Restricting split-bearer and `trimTrailingSlash` recognizers to the precise emitter-written patterns (and excluding named out-of-scope exceptions like `intercom` and `lever`) prevents false positives.

---

## Open Questions & Suggestions

### 1. `argsSchemaStyle` Disagreement Blocker via Biome Re-wrapping
* **Observation:** In Task 1, Step 5, the plan suggests comparing the `z.object(...)` line against its first property line. If they match, it is `"inline"`; otherwise, it is `"expanded"`.
* **Risk:** Biome automatically wraps/formats inline object declarations if they exceed the line-width limit. If a connector has some short inline argument schemas (which remain on a single line) and one long argument schema (which Biome wraps to multiple lines), the long one will vote `"expanded"` and the short ones will vote `"inline"`. The `unanimous` check will detect disagreement and return a blocker (`style:mixed-argsSchemaStyle`), even though the connector's spec originally specified `"inline"`.
* **Suggestion:** We should define a threshold (e.g., number of properties or character length of the schema) or allow the tool to abstain from voting if it's long enough to have been re-wrapped by Biome, preventing false disagreement blocks.

### 2. Handling Multiple Hoisted Identifiers in `reconstructBase`
* **Observation:** In Task 2, Step 3, the plan describes resolving identifiers against top-level constants.
* **Question:** What happens if a base path contains multiple hoisted identifiers (e.g., `` `${API_HOST}${API_VERSION}${path}` ``) or a mix of a hoisted identifier and an env accessor call? Since the spec's `FetchHelperFields` only supports a single `baseConst?: string`, how should the recognizer handle multiple candidates?
* **Suggestion:** The recognizer should either:
  * Refuse the helper if more than one identifier is found (reporting a blocker).
  * Only set `baseConst` to the first identifier (the host constant) and ensure subsequent identifiers are resolved/concatenated appropriately, or enforce that only one identifier is supported. Clarify this behavior in the code comments.

### 3. Double-Claim Hazard in Split-Bearer Pair
* **Observation:** Task 4, Step 2 points out that the split-bearer is a pair of functions, and `recognizeEnv` currently claims the inner reader.
* **Suggestion:** When consuming both the wrapper and the inner function under the split-bearer recognizer, make sure the implementation marks both nodes/statements as claimed in the same pass. If the inner reader function is processed first in a loop, it might get claimed as a standalone plain helper before the pair recognizer gets to evaluate it. Ensure the pair check is prioritized or that statement claiming is done atomically for the pair.

### 4. `trimTrailingSlash` Verification
* **Observation:** Task 4, Step 3 recommends matching the emitted constant's text rather than the function's name.
* **Suggestion:** Ensure the regex or AST matching logic precisely validates the body of the `trimTrailingSlash` function/constant to guarantee it performs the expected regex replace (`.replace(/\/$/, "")`), rather than just matching a name or variable declaration, to prevent false positives on custom trim functions.
