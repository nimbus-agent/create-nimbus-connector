# Implementation Plan Review: create-nimbus-connector (Stage B)

This document provides a review, suggestions, and open questions for the [Stage B Implementation Plan](file:///C:/gitrep/create-nimbus-connector/docs/superpowers/plans/2026-07-31-create-nimbus-connector-stage-b.md).

---

## 1. Open Questions

### Dynamic Import Cache-Busting in Bun (Task 1)
* **Question:** In Task 1 (Step 1), the test uses a query parameter to bust the ESM import cache:
  ```ts
  const mod = await import(`../src/format.ts?uninit=${Math.random()}`);
  ```
* **Implication:** Bun's module loader behavior regarding URL query parameters for local file path imports is subject to change or may not fully reload the module state under all configurations, potentially causing flaky test results.
* **Suggestion:** Instead of relying on query-string cache-busting, expose a hidden/test-only reset function from `src/format.ts` (e.g., `resetFormatterStateForTest()`) or mock the `initialised` variable directly using `bun` test mocks.

### Robust Stdio JSON-RPC Parsing (Task 6)
* **Question:** Task 6 (Step 5) requires `toolsListCheck` to spawn the server, send MCP `initialize` and `tools/list` payloads, and check output.
* **Implication:** Standard I/O output streaming can split JSON-RPC messages across chunks, or print internal warning logs (e.g. from the runtime or libraries) into stdout/stderr. A simple text search/assertion could fail if logs are prepended.
* **Suggestion:** Parse stdout line-by-line as JSON, ignoring any non-JSON lines, and match the incoming JSON messages by their RPC fields (e.g., matching the `id` of the response to the request).

---

## 2. Improvements & Suggestions

### Force Clean Installation in Acceptance Script (Task 6)
* **Suggestion:** Bun heavily caches packages, including `file:` dependencies. If you build `nimbus-sdk`, run the acceptance script, modify the SDK, rebuild, and run it again, Bun might serve the old SDK build from its cache.
* **Improvement:** In `scripts/standalone-acceptance.ts`, run `bun install --force` or dynamically create a unique local `.bun` configuration directory to guarantee it always resolves the freshly built local SDK files.

### Normalized Temporary Paths (Task 6)
* **Suggestion:** The temp directory is generated using `mkdtempSync(join(tmpdir(), "cnc-standalone-"))`.
* **Improvement:** Normalize `outDir` using `realpathSync` or `path.resolve` immediately after creation. Windows temp paths (e.g., under `AppData/Local/Temp`) sometimes resolve with short 8.3 filename aliases (like `TEMP~1`) or symlinks, which can cause compile-time path resolution errors or mismatching paths in lockfiles.
