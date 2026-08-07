/**
 * The synthetic OpenAPI document the reader's tests are built from.
 *
 * SYNTHETIC — invented here, not copied from any published API. A hand-written document is the
 * only kind whose every field is deliberate, and this repo's licensing rule means no real
 * connector or `shared/` source enters `src/`, `test/` or `fixtures/` regardless.
 *
 * It lives in `test/support/` rather than in either test file because both need it:
 * `test/openapi/document.test.ts` reads it through `loadDocument`, and `test/cli-main.test.ts`
 * writes it to disk and drives the real binary over it. Two hand-kept copies of a fifteen-line
 * YAML constant drift, and a drifted copy is a test asserting something about a document the
 * other test no longer describes.
 *
 * `fixtures/` is deliberately NOT where this goes: that directory is the golden-fixture corpus
 * `diff:golden` sweeps, and a document of a different kind sitting in it is a category error.
 *
 * Every field earns its place: two operations on one path (so "document order" has something to
 * be wrong about), one templated path, and a `summary` on each operation. The `$ref`, alias and
 * refusal cases are NOT here — each test builds them from this constant so the corruption is
 * exactly the construct under test.
 */
export const ZZ_WIDGETS_YAML = [
  "openapi: 3.0.3",
  "info:",
  "  title: ZZ Widgets",
  "  version: 1.0.0",
  "servers:",
  "  - url: https://api.zzwidgets.test/v1",
  "paths:",
  "  /widgets:",
  "    get:",
  "      operationId: listWidgets",
  "      summary: List widgets.",
  "    post:",
  "      operationId: createWidget",
  "      summary: Create a widget.",
  "  /widgets/{widgetId}:",
  "    get:",
  "      operationId: getWidget",
  "      summary: Fetch one widget.",
  "",
].join("\n");
