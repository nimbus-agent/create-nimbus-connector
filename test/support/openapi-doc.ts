import { loadDocument } from "../../src/openapi/document.ts";
import type { Refusal } from "../../src/openapi/operation.ts";
import type { OpenApiDocument } from "../../src/openapi/schema.ts";

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

/**
 * A loadable document built around `paths`, with `extra` overriding any root key.
 *
 * Also SYNTHETIC, and shared for the reason the constant above is: `test/openapi/operation.test.ts`
 * and `test/openapi/spec.test.ts` both build documents this way, and two hand-kept copies of a
 * builder drift — a drifted copy is a test asserting something about a document the other test no
 * longer describes. Task 2's report flagged the copy as the wrong fix and the move as the right
 * one, so the move is what happened when the second consumer arrived.
 *
 * `extra` is spread LAST so a case can replace `servers`, `info` or `components` outright — and,
 * because `JSON.stringify` drops an `undefined` value, `{ servers: undefined }` produces a document
 * with no `servers` key at all rather than one with an empty value.
 */
export function documentFor(
  paths: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): OpenApiDocument {
  return loadDocument(
    JSON.stringify({
      openapi: "3.0.3",
      info: { title: "ZZ Widgets", version: "1.0.0" },
      servers: [{ url: "https://api.zzwidgets.test/v1" }],
      paths,
      ...extra,
    }),
  ).doc;
}

/**
 * One path item holding one operation, which is what almost every mapper case needs.
 *
 * The path item's own keys are spread FIRST so a `parameters` array sits ahead of the method
 * key, which is where a real document puts it — and Task 1 promises document order, so building
 * it the other way round would test a shape no document has.
 */
export function onePath(
  path: string,
  method: string,
  operation: Record<string, unknown>,
  pathItem: Record<string, unknown> = {},
): Record<string, unknown> {
  return { [path]: { ...pathItem, [method]: { operationId: "op", ...operation } } };
}

/**
 * The two refusal readers `operation.test.ts` and `spec.test.ts` both need, here for the same
 * reason `documentFor` and `onePath` are: each file had its own byte-identical copy, and a
 * drifted copy is two suites disagreeing about what a refusal looks like.
 *
 * They are deliberately the readers and not the assertions. What each file DOES with a refusal
 * differs — one asserts against `mapOperation`'s output, the other against `assembleSpec`'s —
 * and their `mustRefuse` helpers stay local for exactly that reason.
 */
export function kindsOf(refusals: readonly Refusal[]): string[] {
  return refusals.map((r) => r.kind);
}

/** The detail of the one refusal of `kind`, so a message can be asserted on rather than a count. */
export function detailOf(refusals: readonly Refusal[], kind: string): string {
  const hit = refusals.find((r) => r.kind === kind);
  if (hit === undefined) {
    throw new Error(`no "${kind}" refusal among [${kindsOf(refusals).join(", ")}]`);
  }
  return hit.detail;
}
