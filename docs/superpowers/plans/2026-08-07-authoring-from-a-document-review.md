# Review: Phase 3: Authoring From a Document — Implementation Plan

**Review Date:** 2026-08-07  
**Review Target:** [`2026-08-07-authoring-from-a-document.md`](./2026-08-07-authoring-from-a-document.md)

---

## Summary of Strengths

1. **Explicit Constraint Verification:** The plan includes a "What I verified before writing this plan" section. Discovering that `z.toJSONSchema` throws on transforms prior to implementation prevents a mid-task redesign.
2. **Refusal Discipline:** Sticking to the "refuse by name" paradigm ensures that authors are immediately informed of what cannot be mapped, rather than dealing with silent omissions or broken configurations.
3. **No-Dependency Constraint:** The choice to use `Bun.YAML.parse` and avoid adding third-party parser/validator dependencies keeps the footprint minimal and matches the Bun-only constraint.
4. **Actionable CLI Separation:** Outputting the spec to stdout and errors/refusals to stderr is a great CLI design decision, enabling seamless redirection (`> spec.json`) while maintaining visibility of errors.

---

## Open Questions & Suggestions

### 1. Handling Non-JS Identifiers in OpenAPI Path Parameters
* **Observation:** OpenAPI path parameters often use kebab-case or characters that are invalid in JS identifiers (e.g., `{widget-id}` or `{widget_id}`). However, `ToolSchema` enforces that all argument names must match `IDENTIFIER_RE` (`/^[A-Za-z_$][A-Za-z0-9_$]*$/`).
* **Suggestion:** In Task 2, Step 1, clarify how parameters with non-JS-compliant names are handled:
  * Do we slugify/camelCase them (e.g. `{widget-id}` -> `widgetId`) and update the mapped `path` template placeholders to match (e.g. `${arg.widgetId|enc}`)?
  * Or do we refuse them by name? Converting to camelCase/valid identifiers is highly recommended to increase reach, but the mapping must be consistent between the parameter definition and the path template.

### 2. Missing/Empty `servers` or templated Server URLs
* **Observation:** Task 3 maps `fetchHelper.base` and `network` from `servers[0].url`.
* **Questions:**
  * What if the `servers` array is missing, empty, or lacks a `url`? Should this result in a refusal by name, or a specific placeholder (e.g., `TODO: define base URL`)?
  * What if `servers[0].url` uses OpenAPI server templating (e.g., `https://{tenant}.api.com/v1`)?
* **Suggestion:** If the URL is templated or missing, we should refuse by name or use a clear placeholder. Refusing templated server URLs by name is safer to avoid emitting invalid base URLs.

### 3. Basic Authentication mapping in Task 3
* **Observation:** Zod's `EnvSchema` supports `auth: "basic"`.
* **Question:** The plan mentions HTTP bearer (`auth: "bearer"`) and API key in header (`auth: "headers"`), but notes "Anything else... refused by name". Does this include HTTP Basic Auth?
* **Suggestion:** If the OpenAPI document contains a security scheme with `type: "http"` and `scheme: "basic"`, we should map it to `auth: "basic"` rather than refusing it, since the spec schema natively supports it.

### 4. Media Type Filtering for Request Bodies
* **Observation:** Task 2 maps request body parameters.
* **Suggestion:** Ensure the mapper explicitly checks the media type of the request body. It should look for `application/json` (or generic `*/*`, or JSON-compatible types like `application/problem+json`). If a request body only defines other media types (like `application/x-www-form-urlencoded` or `multipart/form-data`), it should be refused by name.

### 5. Resolution of Missing/Unresolvable `$ref`
* **Observation:** Task 1, Step 4 resolves internal references (`$ref: "#/..."`).
* **Suggestion:** Explicitly define the behavior for unresolvable internal references (e.g., a `$ref` pointing to `#components/schemas/NonExistent`). The tool should throw/refuse by name rather than failing with an undefined reference lookup.
