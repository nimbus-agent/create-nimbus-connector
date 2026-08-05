import { beforeAll, describe, expect, it } from "bun:test";
import { initParser, parseModule } from "../../src/derive/ast.ts";
import { constDecl } from "../../src/derive/read.ts";
import { recognizeArgs } from "../../src/derive/server/args.ts";

beforeAll(async () => {
  await initParser();
});

function argsOf(expression: string) {
  const statement = parseModule(`const x = ${expression};`)[0]!;
  const init = constDecl(statement)!.init!;
  return recognizeArgs(init);
}

describe("recognizeArgs", () => {
  it("reads an empty schema", () => {
    expect(argsOf("z.object({})")).toEqual({});
  });

  it("reads a plain string arg", () => {
    expect(argsOf("z.object({ q: z.string() })")).toEqual({ q: { type: "string" } });
  });

  it("reads optional", () => {
    expect(argsOf("z.object({ only_open: z.boolean().optional() })")).toEqual({
      only_open: { type: "boolean", optional: true },
    });
  });

  it("reads the int/min/max chain the emitter writes for a bounded number", () => {
    expect(argsOf("z.object({ limit: z.number().int().min(1).max(100).optional() })")).toEqual({
      limit: { type: "number", int: true, min: 1, max: 100, optional: true },
    });
  });

  it("recognizes a negative min/max bound, via numericValue rather than a bare NumericLiteral read", () => {
    // Babel parses `-5` as a UnaryExpression wrapping a NumericLiteral, not a NumericLiteral
    // itself. ArgSchema constrains sign on neither `min` nor `max`, so `.min(-5)` is a shape
    // renderZodSchema can legitimately write — this is one of this retrofit's two sanctioned
    // widenings (tools-hand.ts's `?? -1` default is the other), and no corpus connector reaches
    // this recognizer with a negative literal today, so it does not move the reach histogram.
    expect(argsOf("z.object({ delta: z.number().min(-5).max(-1) })")).toEqual({
      delta: { type: "number", min: -5, max: -1 },
    });
  });

  it("returns undefined for a modifier it does not model, rather than dropping it", () => {
    expect(argsOf("z.object({ q: z.string().email() })")).toBeUndefined();
  });

  it("returns undefined for anything that is not a z.object call", () => {
    expect(argsOf("searchToolInputSchema")).toBeUndefined();
  });

  it('returns undefined for a computed key, rather than deriving an arg literally named "KEY"', () => {
    // `{ [KEY]: z.string() }` has no literal key — reading property["name"] unguarded would
    // read the identifier's own name ("KEY") as the arg's name, deriving a spec that
    // regenerates a schema the real connector never had.
    expect(argsOf("z.object({ [KEY]: z.string() })")).toBeUndefined();
  });

  it("returns undefined for a computed z[object](...) call instead of establishing z.object(...)", () => {
    // `z[object](...)` has an Identifier `property` too (the KEY variable's name "object"),
    // which unguarded would be read the same as the literal `.object` access.
    expect(argsOf("z[object]({ q: z.string() })")).toBeUndefined();
  });

  it("returns undefined for a computed modifier (z.number()[int]()) instead of establishing .int()", () => {
    expect(argsOf("z.object({ limit: z.number()[int]() })")).toBeUndefined();
  });
});
