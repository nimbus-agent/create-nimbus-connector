import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { createClaimSet } from "../../scripts/_lib/derive/claims.ts";

const SOURCE = [
  'import { z } from "zod";',
  "function apiKey(): string {",
  '  const k = process.env["A"]?.trim();',
  "  return k;",
  "}",
  "const mcp = 1;",
].join("\n");

describe("parseModule", () => {
  it("parses TypeScript annotations that the base parser rejects", () => {
    const statements = parseModule(SOURCE);
    expect(statements.map((s) => s.type)).toEqual([
      "ImportDeclaration",
      "FunctionDeclaration",
      "VariableDeclaration",
    ]);
  });

  it("throws on source it cannot parse, rather than returning a partial program", () => {
    expect(() => parseModule("const = ;")).toThrow();
  });
});

describe("createClaimSet", () => {
  it("reports a claimed statement as covered and an unclaimed one as not", () => {
    const statements = parseModule(SOURCE);
    const claims = createClaimSet();
    claims.claim(statements[0]!, "frame");

    expect(claims.covers(statements[0]!)).toBe(true);
    expect(claims.covers(statements[1]!)).toBe(false);
    expect(claims.unclaimed(statements).map((s) => s.type)).toEqual([
      "FunctionDeclaration",
      "VariableDeclaration",
    ]);
  });

  it("claims several statements in one call, for the multi-statement constructs the emitter writes", () => {
    const statements = parseModule(SOURCE);
    const claims = createClaimSet();
    claims.claim([statements[1]!, statements[2]!], "env");

    expect(claims.unclaimed(statements).map((s) => s.type)).toEqual(["ImportDeclaration"]);
  });

  it("covers a node nested inside a claimed range without a separate claim", () => {
    const statements = parseModule(SOURCE);
    const fn = statements[1]!;
    const body = (fn["body"] as { body: AstNodeLike[] }).body;
    const claims = createClaimSet();
    claims.claim(fn, "env");

    expect(claims.covers(body[0]!)).toBe(true);
  });

  it("refuses a node with no source range instead of silently claiming nothing", () => {
    const claims = createClaimSet();
    expect(() => claims.claim({ type: "Fake", start: null, end: null }, "x")).toThrow(
      /no source range/,
    );
  });
});

type AstNodeLike = { type: string; start: number | null; end: number | null };
