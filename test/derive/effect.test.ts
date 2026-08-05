import { describe, expect, it } from "bun:test";
import { attributeEffects } from "../../src/derive/index.ts";

describe("attributeEffects", () => {
  it("leaves every tool read when hitlRequired is empty", () => {
    const tools = [{ name: "a" }, { name: "b" }];
    expect(attributeEffects(tools, [])).toEqual({
      tools: [{ name: "a" }, { name: "b" }],
      ambiguous: [],
    });
  });

  it("marks the only non-GET tool write, and reports it as unambiguous", () => {
    // One candidate: ToolSchema forbids a GET carrying a write effect, so this attribution is
    // the ONLY one reproducing the observed set. Forced, therefore correct.
    const tools = [{ name: "a" }, { name: "b", method: "POST" }];
    expect(attributeEffects(tools, ["write"])).toEqual({
      tools: [{ name: "a" }, { name: "b", method: "POST", effect: "write" }],
      ambiguous: [],
    });
  });

  it("reports ambiguity when two tools could carry the same effect", () => {
    // Both get `write` and the emitted manifest is right either way, but at most one may
    // actually BE a write — dagster POSTs GraphQL queries, ramp POSTs to exchange a token.
    const tools = [
      { name: "a", method: "POST" },
      { name: "b", method: "PUT" },
    ];
    const result = attributeEffects(tools, ["write"]);
    expect(result?.ambiguous).toEqual(["write"]);
  });

  it("marks a DELETE-method tool delete when hitlRequired carries delete", () => {
    const tools = [
      { name: "a", method: "POST" },
      { name: "b", method: "DELETE" },
    ];
    expect(attributeEffects(tools, ["write", "delete"])?.tools).toEqual([
      { name: "a", method: "POST", effect: "write" },
      { name: "b", method: "DELETE", effect: "delete" },
    ]);
  });

  it("refuses when hitlRequired demands an effect no tool can carry", () => {
    // A GET-only connector whose manifest claims a write is a manifest this deriver cannot
    // reproduce. Refusing is a visible blocker; guessing is a wrong spec that emits correctly.
    expect(attributeEffects([{ name: "a" }], ["write"])).toBeUndefined();
  });

  it("refuses when a declared delete has no DELETE-method tool to attribute it to", () => {
    expect(attributeEffects([{ name: "a", method: "POST" }], ["delete"])).toBeUndefined();
  });
});
