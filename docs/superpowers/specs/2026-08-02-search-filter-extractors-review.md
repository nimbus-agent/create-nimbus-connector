# Review & Suggestions: Search-filter field extractors design

This document contains a review of the proposed design for **Search-filter field extractors**, including open questions, potential improvements, and design suggestions.

---

## 1. Schema Extensibility & Entry Taxonomy

### Suggestion: Use a Discriminated Union for Field Entry Types
Currently, the design defines `fields` entries as a union of:
1. `string` (plain key)
2. `{ "path": string[] }`
3. `{ "tags": "objects" | "text" }`

If we want to support other extraction types in the future (e.g. custom mappings, type coercions like numbers or booleans), this ad-hoc object shape could lead to validation complexity and ambiguity.
* **Alternative approach:** Consider using a clear discriminated union structure:
  ```jsonc
  "fields": [
    "name", // Shortcut for { "type": "field", "key": "name" }
    { "type": "nested", "path": ["spec", "source", "repoURL"] },
    { "type": "tags", "format": "objects" }
  ]
  ```
* **Pros:** Highly extensible. New type variants (e.g., `"type": "number"`) can be added without polluting the root key space of the entry objects.
* **Cons:** Slightly more verbose for the common case.

---

## 2. Validation & Edge Cases

### Open Questions
1. **Empty / Blank path segments:**
   Does `validateSpec` reject path segments containing empty strings or whitespace (e.g. `["spec", " "]` or `["spec", ""]`)? It should enforce that all segments are non-empty strings.
2. **Schema validation strictness:**
   Will the schema validator reject unrecognized keys in the entry objects? For example, if an author mistakenly writes `{ "path": ["spec"], "tag": "objects" }`, will it throw a parse/validation error?
3. **Type Coercion Primitives:**
   The design currently mentions `nestedString` and `stringField`. If any of the Group A or Group B connectors require extracting non-string values or converting boolean/number types to strings, do we need corresponding primitives (e.g., `nestedNumber` or `booleanField`)? Or does the runtime `stringField` / `nestedString` handle coercion automatically?

---

## 3. Backward Compatibility & Diagnostics

### Suggestions
* **Deprecation Warning for Legacy `tags: true`:**
  Since the new `{ "tags": ... }` syntax provides finer-grained control, we should consider warning/linting against legacy `tags: true` in new specs (while keeping support for backward compatibility).
* **Clear Error Messages:**
  When rejecting a `path` with fewer than two segments, the error message should explicitly suggest using a simple string key instead, pointing the user to the exact path that triggered the rejection.

---

## 4. Code Generation & Imports

### Open Questions
1. **Treeshaking / Unused Imports:**
   The design specifies that imports are computed based on the entry kinds actually present to avoid `noUnusedLocals` / Biome lint errors. 
   - Is there a test case verifying that *only* the required helpers (e.g. only `stringField` and `nestedString` but not `tagText`) are imported?
   - How are the imports of `asObjectish` and `FieldExtractor` managed when generating `fieldsOf`?
