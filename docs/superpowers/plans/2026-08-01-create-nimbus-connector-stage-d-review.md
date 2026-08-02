# Plan Review: create-nimbus-connector — Stage D

**Review Date:** 2026-08-01  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Target Plan:** [2026-08-01-create-nimbus-connector-stage-d.md](file:///C:/gitrep/create-nimbus-connector/docs/superpowers/plans/2026-08-01-create-nimbus-connector-stage-d.md)

---

## 1. Key Verification Points & Recommendations

### 1.1 SDK Export of Primitives for Standalone Targets
* **Context (Task 3 Step 3):** The standalone glue imports types `McpListResult` and `ZodObjectSchema` from `@nimbus-dev/sdk/connector-kit`.
* **Verification Required:** In Task 12 (or the existing SDK), we must verify that both `McpListResult` and `ZodObjectSchema` are indeed exported by `src/connector-kit/index.ts`. If either type is missing, we must add it to the barrel exports in Task 12, or the standalone generation will fail compilation during acceptance checks.

### 1.2 RegEx Robustness in `renderSchema` (Task 6 Step 3)
* **Context (Task 6 Step 3):** `renderSchema` uses string replacement to strip the outer `z.object({...})` wrapper:
  ```ts
  const own = renderZodSchema(tool.args).replace(/^z\.object\(\{/, "").replace(/\}\)$/, "").trim();
  ```
* **Potential Issue:** If `renderZodSchema` outputs multi-line strings or formatting with extra whitespace/newlines between the brace and parentheses (e.g. `z.object({\n...\n})`), a simple regex might fail to match/strip it cleanly, or leave trailing characters.
* **Recommendation:** Use a slightly more flexible regex check, such as:
  ```ts
  const own = renderZodSchema(tool.args)
    .replace(/^z\.object\(\s*\{/, "")
    .replace(/\}\s*\)$/, "")
    .trim();
  ```
  This is safer against varying layouts produced prior to Biome formatting.

### 1.3 `SearchFilter` Import Path for Monorepo (Task 8 Step 3)
* **Context (Task 8 Step 3):** The plan notes: 
  > *`SearchFilter` is exported by `shared/mcp-search-tool.ts` in the monorepo, not by `search-filter.ts`.*
* **Potential Issue:** Task 8 Step 3 generates the import statement assuming all symbols (including `SearchFilter`) come from `SHARED` (`../../shared/search-filter.ts`). If `SearchFilter` is defined in `mcp-search-tool.ts` and not in `search-filter.ts`, the monorepo compile will fail.
* **Recommendation:** Ensure the generator maps the monorepo imports correctly:
  * `fieldsFromKeys`, `makeQueryFilter`, `type SearchMatchOptions` imported from `"../../shared/search-filter.ts"`
  * `type SearchFilter` imported from `"../../shared/mcp-search-tool.ts"` (if `SearchFilter` is required by the stubs).
