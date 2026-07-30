# Design Review: create-nimbus-connector (Stage A)

This document provides a review, suggestions, and open questions for the [Stage A Design Specification](file:///C:/gitrep/create-nimbus-connector/docs/superpowers/specs/2026-07-30-create-nimbus-connector-stage-a-design.md).

---

## 1. Open Questions

### Biome Integration: Pure Function vs. Executable Dependency
* **Question:** The design specifies that the generator is a pure function: `generate(spec: ConnectorSpec): GeneratedFile[]`. However, it also states: *"It produces semantically correct TypeScript with naive line breaks, then runs `@biomejs/biome`'s formatter over it"*.
* **Implication:** If formatting requires running the Biome CLI via a child process, the function is no longer pure/in-memory and becomes environment-dependent.
* **Suggestion:** Clarify whether the generator will use the `@biomejs/js-api` (WASM-based formatting) to maintain pure function characteristics, or if formatting is deferred to the CLI runner wrapper (leaving the core generator output unformatted).

### Pipeline Order for Environment Transforms
* **Question:** For `env` variables with transforms/suffixes/prefixes (e.g., `stripTrailingSlash`, `suffix: "/api/0"`), what is the execution/codegen order?
* **Implication:** If `suffix` is applied *before* `stripTrailingSlash`, a trailing slash on the suffix itself might get stripped, whereas if `stripTrailingSlash` is applied first, the suffix remains untouched.
* **Suggestion:** Explicitly define the processing pipeline order in the spec (e.g., `Read Env -> Trim -> Check Empty/Error -> Apply Transforms -> Apply Suffix/Prefix -> Apply Auth Wrapper`).

### Namespace/Scoping Conflicts in `local` Names
* **Question:** The design permits custom names via `local` properties to handle human-style variables/methods (e.g., `apiRoot`, `headers`). How are collisions handled if a spec accidentally reuses a name across different contexts (e.g., a tool argument named `org` and an env accessor named `org`)?
* **Suggestion:** The validator should enforce uniqueness across all hoisted names (`env.local`, `arg` names, `fetchHelper.local`).

---

## 2. Improvements & Suggestions

### Bootstrap / Reverse Spec Generator
* **Suggestion:** Writing `.spec.json` files by hand to match existing connectors (especially the 10 Style R connectors) is error-prone.
* **Idea:** Add a utility/script in Stage A that reads a Style R connector's `src/server.ts` and parses it back into a draft `ConnectorSpec` JSON. Since Style R is already highly declarative (using `makeRestToolRegistrar`), a lightweight AST parse or regex scanner could automatically bootstrap `google-meet.spec.json`, `discord.spec.json`, etc.

### Hardcoded Path Fallback (`C:\gitrep\Nimbus`)
* **Suggestion:** Avoid hardcoding Windows-specific paths like `C:\gitrep\Nimbus` directly as a fallback in the codebase.
* **Correction:** Use a relative path fallback instead (e.g., checking `../../Nimbus` relative to the script location) or prompt the user if both `--nimbus-root` and `$NIMBUS_ROOT` are unset, providing a clean error message rather than a hardcoded path failure on macOS/Linux.

### Validation of Non-GET Tools
* **Suggestion:** Since write tools and non-GET requests are explicitly out-of-scope for Stage A, the schema validator should fail fast if a tool declares a non-GET method or a request body, rather than generating broken/incomplete code. This forces a clean fallback to `"impl": "stub"`.
