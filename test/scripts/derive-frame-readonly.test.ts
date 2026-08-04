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
  });

  it("NEVER claims the wrapper, so a statement inside it stays visible", () => {
    // The containment hazard, asserted directly. If the frame claimed the wrapper, this
    // unrecognized statement would be covered transitively and the totality rule would pass
    // on a connector whose tools were never read — a false `emits`.
    const source = READ_ONLY.replace("});", "  someUnrecognizedCall();\n});");
    const statements = parseModule(source);
    const claims = createClaimSet();
    const frame = recognizeFrame(statements, claims);

    const unclaimed = claims.unclaimed(frame!.verifyStatements);
    expect(unclaimed.length).toBeGreaterThan(0);
  });

  it("rejects a wrapper whose callback is not a single-parameter arrow", () => {
    const source = READ_ONLY.replace("(reg) =>", "(reg, extra) =>");
    expect(recognizeFrame(parseModule(source), createClaimSet())).toBeUndefined();
  });

  it("rejects a non-awaited wrapper — the emitter always writes await", () => {
    const source = READ_ONLY.replace("await runReadOnly", "runReadOnly");
    expect(recognizeFrame(parseModule(source), createClaimSet())).toBeUndefined();
  });
});
