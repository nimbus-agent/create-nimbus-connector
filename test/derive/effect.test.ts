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

  it("refuses when a tool already carries an effect outside the wanted set", () => {
    // "delete" on tool "a" is never assigned by this call (nothing here maps to it), so the
    // membership loop below — "every wanted effect appears in counts" — is satisfied on its
    // own by tool "b"'s "write". Only the size check catches the extra, undeclared "delete":
    // counts = {delete, write}, wanted = {write}, sizes disagree. Pins the superset direction
    // of the bidirectional equality claim in the comment above, which nothing else here does.
    const tools = [
      { name: "a", effect: "delete" },
      { name: "b", method: "POST" },
    ];
    expect(attributeEffects(tools, ["write"])).toBeUndefined();
  });

  it("reports ambiguity when a stub sits beside an otherwise-forced single candidate", () => {
    // A stub carries no `method`, so the loop above never assigns it an effect and it never
    // reaches `counts` — but ToolSchema does not restrict a stub's OWN declared effect the way
    // it restricts a GET's (the refine's `t.impl !== "stub"` clause), so the author could have
    // written "write" on the stub instead of the POST. `n > 1` alone can't see this: the stub
    // never adds to `counts`, so without `hasStub` this would report `ambiguous: []`, the exact
    // "single candidate -> forced" reasoning the docstring says no longer holds once a stub is
    // in the room.
    const tools = [
      { name: "a", impl: "stub" },
      { name: "b", method: "POST" },
    ];
    const result = attributeEffects(tools, ["write"]);
    expect(result?.ambiguous).toEqual(["write"]);
    expect(result?.tools).toEqual([
      { name: "a", impl: "stub" },
      { name: "b", method: "POST", effect: "write" },
    ]);
  });

  it("reports no ambiguity from a stub alone, when nothing was attributed at all", () => {
    // hitlRequired empty means no effect reaches `counts` regardless of the stub's presence —
    // there is nothing for the stub to be a silent second carrier OF, so `hasStub` has nothing
    // to widen. Determinate: the stub's own effect must be "read", the only value consistent
    // with an empty hitlRequired.
    const tools = [{ name: "a", impl: "stub" }, { name: "b" }];
    expect(attributeEffects(tools, [])).toEqual({
      tools: [{ name: "a", impl: "stub" }, { name: "b" }],
      ambiguous: [],
    });
  });

  it("still reports ambiguity (not a second, larger count) when a stub sits beside two already-ambiguous candidates", () => {
    // Guards against a naive `n > 1 ? n + 1 : ...` reading: the stub does not need to CHANGE the
    // count to widen the ambiguity, membership in `ambiguous` is boolean either way.
    const tools = [
      { name: "a", impl: "stub" },
      { name: "b", method: "POST" },
      { name: "c", method: "PUT" },
    ];
    const result = attributeEffects(tools, ["write"]);
    expect(result?.ambiguous).toEqual(["write"]);
  });
});
