import { describe, expect, it } from "bun:test";
import { hoistedLocals, renderHoists, renderZodSchema } from "../../../src/emit/server/args.ts";
import { ToolSchema } from "../../../src/spec.ts";

function args(raw: unknown) {
  return ToolSchema.parse({ name: "t", description: "d", args: raw, path: "/x" }).args;
}

describe("renderZodSchema", () => {
  it("renders an empty object for no args", () => {
    expect(renderZodSchema(args({}))).toBe("z.object({})");
  });

  it("renders a required string with a min", () => {
    expect(renderZodSchema(args({ projectSlug: { type: "string", min: 1 } }))).toBe(
      "z.object({ projectSlug: z.string().min(1) })",
    );
  });

  it("renders an optional bounded integer in fixed chain order", () => {
    const a = args({ limit: { type: "number", int: true, min: 1, max: 100, optional: true } });
    expect(renderZodSchema(a)).toBe(
      "z.object({ limit: z.number().int().min(1).max(100).optional() })",
    );
  });

  it("renders an optional boolean", () => {
    expect(renderZodSchema(args({ only_open: { type: "boolean", optional: true } }))).toBe(
      "z.object({ only_open: z.boolean().optional() })",
    );
  });
});

describe("hoistedLocals", () => {
  it("hoists defaulted args and booleans only", () => {
    const a = args({
      slug: { type: "string" },
      limit: { type: "number", optional: true, default: 20, local: "lim" },
      flag: { type: "boolean", optional: true, local: "only" },
    });
    expect([...hoistedLocals(a)]).toEqual([
      ["limit", "lim"],
      ["flag", "only"],
    ]);
  });

  it("defaults the local to the arg name", () => {
    const a = args({ limit: { type: "number", optional: true, default: 10 } });
    expect(hoistedLocals(a).get("limit")).toBe("limit");
  });
});

describe("renderHoists", () => {
  it("renders a numeric default with ??", () => {
    const a = args({ limit: { type: "number", optional: true, default: 10, local: "lim" } });
    expect(renderHoists(a, "p")).toEqual(["const lim = p.limit ?? 10;"]);
  });

  it("renders a string default with a quoted literal", () => {
    const a = args({ query: { type: "string", optional: true, default: "", local: "q" } });
    expect(renderHoists(a, "p")).toEqual(['const q = p.query ?? "";']);
  });

  it("renders a boolean as an explicit true/false string", () => {
    const a = args({ only_open: { type: "boolean", optional: true, local: "only" } });
    expect(renderHoists(a, "p")).toEqual(['const only = p.only_open === true ? "true" : "false";']);
  });
});
