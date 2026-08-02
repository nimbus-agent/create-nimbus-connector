# Review and Suggestions: Conditional Query Parameters Design

This document compiles open questions, potential edge cases, and design improvements for the proposed conditional query parameters design.

---

## 1. Critical Technical/Implementation Questions

### A. Relative Paths vs. `new URL()` Parsing
A relative path like `/channels/123/messages` will throw a `TypeError: Invalid URL` in Javascript/Bun if instantiated with `new URL(path)` without a base URL:
```ts
// This throws TypeError:
const u = new URL("/channels/123/messages");

// This succeeds:
const u = new URL("/channels/123/messages", "http://nimbus.local");
```
* **Suggestion:** The rendering engine should emit a dummy base URL (e.g., `http://nimbus.local` or similar constant) when constructing the `URL` object for relative paths, or always use one if the output is just `pathname + search`. For example:
  ```ts
  const u = new URL(pathExpression, "http://nimbus.local");
  ```

### B. Auto-encoding and Filter Safety
In path templates, parameters are often encoded explicitly: `${arg.channelId|enc}`.
* **Point of Clarification:** Since `URLSearchParams.set()` automatically encodes keys and values, we should explicitly document that no encoding filters (like `|enc`) should or can be applied to `query.arg` values. 

---

## 2. API Edge Cases & Improvements

### A. Array / Multi-value Parameters
APIs sometimes handle array query parameters in different ways:
1. Repeating keys: `?status=active&status=pending`
2. Comma-separated: `?status=active,pending`

`URLSearchParams.set("status", String(["active", "pending"]))` will produce `status=active%2Cpending` (comma-separated).
* **Question:** Does the corpus contain any tools requiring repeating keys? If so, `u.searchParams.append` would be needed instead of `set`, or we should explicitly state that multi-value repeating parameters are out of scope for this design.

### B. `omitWhen` Predicates and Nullish Values
The design states:
> `"empty"` is the only accepted value. It renders the guard `!== undefined && !== ""`.

* **Question:** Should the guard also check for `null`? If the parsed argument can be `null`, we might want the guard to be:
  ```ts
  if (parsed.after !== undefined && parsed.after !== null && parsed.after !== "")
  ```
  Or does the gateway schema system guarantee that arguments are either defined/non-empty or `undefined` (never `null`)?

### C. Name Collision for Variable `u`
`u` is proposed to join `RESERVED_IDENTIFIERS`. However, `u` is a very common variable name, and a tool author might naturally want to name a tool argument or local variable `u` (e.g. representing a URL parameter).
* **Suggestion:** Consider using a more unique/hygienic variable name for the internal URL builder in the emitted code, such as `urlObj` or `__url`, to avoid unnecessarily restricting the use of `u` in user-defined arguments.
