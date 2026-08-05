import { beforeAll, describe, expect, it } from "bun:test";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { blockerFor } from "../../src/derive/blockers.ts";

beforeAll(async () => {
  await initParser();
});

function first(source: string) {
  return blockerFor(parseModule(source)[0]!, source);
}

describe("blockerFor", () => {
  it("names an import by its source, so a multi-file connector is its own bucket", () => {
    expect(first('import { listTools } from "./tools.ts";').kind).toBe("import-from:./tools.ts");
  });

  it("names a bare call by callee", () => {
    expect(first("runReadOnlyMcpConnector(cfg);").kind).toBe("call:runReadOnlyMcpConnector");
  });

  it("names a method call by property, not by receiver", () => {
    expect(first("u.searchParams.append(k, v);").kind).toBe("method-call:.append");
  });

  it("names a const initialised by a call, which is how the rest-kit registrar appears", () => {
    expect(first("const reg = makeRestToolRegistrar(mcp);").kind).toBe(
      "const-call:makeRestToolRegistrar",
    );
  });

  it("names a function declaration by its identifier", () => {
    expect(first("function tagNames(row) { return []; }").kind).toBe("function:tagNames");
  });

  it("falls back to the node type when nothing more specific applies", () => {
    expect(first("for (const x of xs) { g(x); }").kind).toBe("statement:ForOfStatement");
  });

  it("records the source text and line so a near-miss is actionable", () => {
    const b = first("const n = p.pageSize ?? 50;");
    expect(b.detail).toBe("const n = p.pageSize ?? 50;");
    expect(b.line).toBe(1);
  });

  it("collapses whitespace and truncates a long statement", () => {
    const source = `const x = {
      a1: 1, a2: 2, a3: 3, a4: 4, a5: 5, a6: 6, a7: 7, a8: 8, a9: 9, a10: 10,
      a11: 11, a12: 12, a13: 13, a14: 14, a15: 15, a16: 16, a17: 17,
    };`;
    const b = first(source);
    expect(b.detail).not.toContain("\n");
    expect(b.detail.endsWith("…")).toBe(true);
    expect(b.detail).toHaveLength(101);
  });
});
