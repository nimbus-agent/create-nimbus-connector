# Review & Suggestions: Search-filter field extractors Implementation Plan

This document contains a review of the proposed implementation plan for **Search-filter field extractors**, highlighting potential edge cases, improvements, and verification steps.

---

## 1. Pre-Implementation Validation of Reserved Identifiers

### Suggestion: Search the Nimbus codebase for potential collisions
Task 2 expands `RESERVED_IDENTIFIERS` to include:
`fieldsOf`, `asObjectish`, `stringField`, `nestedString`, `tagText`, `tagNamesFromObjects`, `makeQueryFilter`, `fieldsFromKeys`

If any existing Nimbus connector spec (even those currently byte-matching or using throwing stubs) has defined a local identifier (e.g. fetch helper, env var, or tool argument) matching any of these names, it will immediately fail validation.
* **Action:** Before running Task 2, perform a quick grep search across `C:/gitrep/Nimbus` specs to ensure none of these names are already defined as `"local"` identifiers.

---

## 2. Zod Schema Type Inference & Readonly Annotations

### Edge Case: Zod Array Type Inference
In Task 1, the `PathEntrySchema` is defined as:
```ts
const PathEntrySchema = z.strictObject({
  path: z.array(z.string().min(1, "a path segment cannot be empty")),
});
```
By default, Zod infers mutable arrays (`string[]`). The task description, however, states that a path entry is `{ readonly path: readonly string[] }`.
* **Improvement:** Check if the Zod version in the project supports `.readonly()` (e.g., `z.array(...).readonly()`). If supported, use it to ensure the inferred TypeScript types match the readonly interface. If not, explicitly cast the parsed type or document that mutable arrays are accepted at runtime because they are assignable to `readonly` parameters.

---

## 3. Zod Union Error Messages

### Open Question / UX Concern
`FieldEntrySchema` is defined as `z.union([z.string().min(1), PathEntrySchema, TagsEntrySchema])`. 
If a spec author provides a malformed entry (e.g., `{ "path": ["spec", ""], "tags": "objects" }`), Zod's default union error output will report failures for all three union branches, producing a long and potentially confusing error message.
* **Suggestion:** Add a brief test case or consideration for validating the error message output of malformed objects. If the default Zod union error message is too noisy, we might want to map/format the error inside the `superRefine` block or utilize a custom preprocessor to validate object structures cleanly.

---

## 4. `ZodEffects` vs. `ZodObject` Compatibility

### Technical Precaution
Task 1 applies `superRefine` directly to `SearchFilterSchema`, transforming it from a `ZodObject` to a `ZodEffects` schema. 
* If other schemas in the codebase extend, merge, or pick fields from `SearchFilterSchema` (e.g., `SearchFilterSchema.extend(...)` or `SearchFilterSchema.pick(...)`), those calls will fail to compile or run, as `ZodEffects` does not support these `ZodObject` helper methods.
* **Mitigation:** If this compatibility issue arises, move the `superRefine` block up to `ToolSchema` or `ConnectorSpecSchema` (where `filter` is validated) so that `SearchFilterSchema` remains a plain `ZodObject`.

---

## 5. Multiple / Non-Trailing Tag Entries

### Verification Case
In Task 3, `keyedShape` correctly checks `entries.at(-1)` for `tags: "text"` to perform legacy convergence.
* If a spec has multiple tag entries or a non-trailing tag entry (e.g., `["id", { tags: "text" }, "name"]`), the slicing logic will leave `{ tags: "text" }` inside the `body` array.
* Consequently, `body.every(...)` will return `false`, and the emitter will correctly fall back to the `extractorFilter` path.
* **Improvement:** Add a specific unit test in `test/emit/search-filter.test.ts` to verify that a non-trailing `{ tags: "text" }` (or multiple tag entries) falls back to generating a `fieldsOf` function rather than failing or emitting invalid `fieldsFromKeys` calls.
