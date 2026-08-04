import { describe, expect, it } from "bun:test";
import { parseModule } from "../../scripts/_lib/derive/ast.ts";
import { recognizeArgs } from "../../scripts/_lib/derive/server/args.ts";

function argsOf(expression: string) {
  const statement = parseModule(`const x = ${expression};`)[0]!;
  const init = (statement["declarations"] as { init: unknown }[])[0]!.init;
  return recognizeArgs(init as never);
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
