import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";
import { recognizeFrame } from "../../scripts/_lib/derive/server/index.ts";

/** A read-only-kit module: no McpServer, no transport, tools inside the wrapper callback. */
const READ_ONLY = [
  'import { z } from "zod";',
  'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
  'const BASE = "https://example.test";',
  'await runReadOnlyMcpConnector("nimbus-zzreadonly", (reg) => {',
  '  reg("a", "d", z.object({}), async () => jsonResult(await zzGet("/a")));',
  "});",
].join("\n");

/**
 * A refused module must claim NOTHING — see recognizeReadOnlyFrame's docstring in
 * scripts/_lib/derive/server/index.ts. A recognizer that partially claims a module it ultimately
 * refuses would leave the totality rule reporting blockers for statements a DIFFERENT recognizer
 * would have claimed, which reads as a spec-language gap when it is a wrong-recognizer gap. Every
 * rejection case below is routed through this so that property is checked on each pin, not just
 * asserted once in the abstract.
 */
function expectRejected(source: string): void {
  const claims = createClaimSet();
  expect(recognizeFrame(parseModule(source), claims)).toBeUndefined();
  expect(claims.claims()).toEqual([]);
}

describe("recognizeFrame, read-only-kit", () => {
  it("recovers the name and style", () => {
    const frame = recognizeFrame(parseModule(READ_ONLY), createClaimSet());
    expect(frame?.name).toBe("zzreadonly");
    expect(frame?.style).toBe("read-only-kit");
  });

  it("hands the callback body to the tool recognizers, not the wrapper", () => {
    const frame = recognizeFrame(parseModule(READ_ONLY), createClaimSet());
    expect(frame?.toolStatements).toHaveLength(1);
    expect(frame?.toolStatements[0]?.type).toBe("ExpressionStatement");
  });

  it("swaps exactly one statement: the wrapper, for its body", () => {
    const statements = parseModule(READ_ONLY);
    const frame = recognizeFrame(statements, createClaimSet());
    // 4 top-level statements; the wrapper is replaced by its single inner statement.
    expect(statements).toHaveLength(4);
    expect(frame?.verifyStatements).toHaveLength(4);
    // The base const is still there to be claimed or blocked — the swap is not a switch from
    // checking the module to checking the callback.
    expect(frame?.verifyStatements.some((s) => s.type === "VariableDeclaration")).toBe(true);
    // The length check above passes whether or not the splice happened — the fixture's callback
    // has exactly 1 statement, the same count as the single wrapper statement it replaces — so it
    // does not by itself discriminate a swap from a no-op. Assert the swap directly: the wrapper
    // statement (the fourth top-level statement, the `await runReadOnlyMcpConnector(...)` call
    // itself) must be gone from verifyStatements, replaced by its callback body's statement.
    const wrapper = statements[3];
    expect(frame?.verifyStatements).not.toContain(wrapper);
    expect(frame?.verifyStatements).toContain(frame?.toolStatements[0]);
  });

  it("NEVER claims the wrapper, so a statement inside it stays visible", () => {
    // The containment hazard, asserted directly against the SPECIFIC statement it would hide,
    // not merely "something is unclaimed" — recognizeReadOnlyFrame claims only imports, so
    // `const BASE = ...` is unclaimed regardless of what happens to the wrapper. That made the
    // original version of this assertion (`unclaimed.length > 0`) pass even when the wrapper WAS
    // claimed, because the wrapper claim just reduced 3 unclaimed statements to 1 rather than 0.
    // Pointing at the unrecognized call inside the callback closes that gap: if the wrapper were
    // ever claimed, containment would cover this statement too, and `covers` below would flip.
    const source = READ_ONLY.replace("});", "  someUnrecognizedCall();\n});");
    const statements = parseModule(source);
    const claims = createClaimSet();
    const frame = recognizeFrame(statements, claims);

    const inner = frame!.toolStatements[1]!;
    expect(inner.type).toBe("ExpressionStatement");
    expect(claims.covers(inner)).toBe(false);
    expect(claims.unclaimed(frame!.verifyStatements)).toContain(inner);
  });

  it("rejects a wrapper whose callback is not a single-parameter arrow", () => {
    expectRejected(READ_ONLY.replace("(reg) =>", "(reg, extra) =>"));
  });

  it("rejects a non-awaited wrapper — the emitter always writes await", () => {
    expectRejected(READ_ONLY.replace("await runReadOnly", "runReadOnly"));
  });

  it("rejects a wrapper whose sole parameter is not named exactly `reg`", () => {
    expectRejected(READ_ONLY.replace("(reg) =>", "(registrar) =>"));
  });

  it("rejects a wrapper whose callback is expression-bodied rather than a block", () => {
    const source = [
      'import { z } from "zod";',
      'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
      'await runReadOnlyMcpConnector("nimbus-zzreadonly", (reg) => reg("a", "d", z.object({}), async () => jsonResult(await zzGet("/a"))));',
    ].join("\n");
    expectRejected(source);
  });

  it('rejects a connector-name literal missing the "nimbus-" prefix', () => {
    expectRejected(READ_ONLY.replace('"nimbus-zzreadonly"', '"zzreadonly"'));
  });

  it("rejects a wrapper call with a third argument — arity is pinned at exactly 2", () => {
    expectRejected(READ_ONLY.replace("});", "}, true);"));
  });

  it("refuses (rather than picking one) when a module has two wrappers", () => {
    const source = [
      'import { z } from "zod";',
      'import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";',
      'await runReadOnlyMcpConnector("nimbus-zzreadonly", (reg) => {',
      '  reg("a", "d", z.object({}), async () => jsonResult(await zzGet("/a")));',
      "});",
      'await runReadOnlyMcpConnector("nimbus-zzreadonly", (reg) => {',
      '  reg("b", "d2", z.object({}), async () => jsonResult(await zzGet("/b")));',
      "});",
    ].join("\n");
    expectRejected(source);
  });

  it("requires the run-read-only import source to end on a path SEGMENT, not merely a substring", () => {
    // "shared-run-read-only-mcp-connector.ts" ends with the same characters as the real suffix
    // but with no preceding "/" — a hypothetical sibling file, not the emitter's own import. The
    // whole module is refused (falls through to the hand-rolled branch, which also does not
    // match), not just this one statement.
    expectRejected(
      READ_ONLY.replace("/run-read-only-mcp-connector.ts", "-run-read-only-mcp-connector.ts"),
    );
  });

  it("rejects an async callback — the emitter never writes async (reg) =>", () => {
    expectRejected(READ_ONLY.replace("(reg) =>", "async (reg) =>"));
  });
});
