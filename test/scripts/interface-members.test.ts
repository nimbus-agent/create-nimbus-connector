/**
 * Unit tests for the interface-member extractor behind `bun run wiring:conformance`.
 *
 * That harness is the only thing in this MIT repo that checks the emitted Gateway wiring
 * against Nimbus's REAL `sync/types.ts` — an AGPL-3.0-only repository that cannot be
 * vendored here, which is why it is a script rather than a test. The parse is what the whole
 * check rests on: if it returns the wrong member names, the harness reports that the
 * skeleton supplies everything `Syncable` requires when it does not, and the first person to
 * find out is a user whose connector stops compiling.
 *
 * The reason it is regex-and-brace-matching rather than a TypeScript parser is that the
 * shape is one flat interface of scalar members and a wrong answer is loud — the harness
 * refuses an empty member set. These tests pin the cases where "loud" is not automatic:
 * nested object members, comments that look like members, and optional/readonly modifiers.
 */

import { describe, expect, it } from "bun:test";
import { interfaceMemberDetails, interfaceMembers } from "../../scripts/_lib/interface-members.ts";

describe("interfaceMembers", () => {
  it("lists the members of a flat interface", () => {
    const source = `
export interface SyncResult {
  itemsUpserted: number;
  itemsDeleted: number;
}
`;

    expect(interfaceMembers(source, "SyncResult")).toEqual(["itemsUpserted", "itemsDeleted"]);
  });

  it("includes optional members, without the question mark", () => {
    // The name must come back bare: the harness matches it against emitted source, where a
    // trailing "?" would never appear.
    const source =
      "interface SyncResult {\n  itemsUpserted: number;\n  bytesTransferred?: number;\n}";

    expect(interfaceMembers(source, "SyncResult")).toEqual(["itemsUpserted", "bytesTransferred"]);
  });

  it("strips a readonly modifier rather than returning it as the member name", () => {
    const source = "interface X {\n  readonly id: string;\n  readonly count?: number;\n}";

    expect(interfaceMembers(source, "X")).toEqual(["id", "count"]);
  });

  it("includes method members declared with a parameter list", () => {
    // `sync(...)` is how Syncable declares the method a connector must supply; matching only
    // `name:` would silently drop it, and the "does the skeleton supply it" loop would never
    // ask about the one member that matters most.
    const source = "interface Syncable {\n  id: string;\n  sync(ctx: Ctx): Promise<SyncResult>;\n}";

    expect(interfaceMembers(source, "Syncable")).toEqual(["id", "sync"]);
  });

  it("stops at the interface's own closing brace, not the first one it sees", () => {
    // The brace matching exists for exactly this: a nested object member closes a brace
    // before the interface does. Cutting there truncates the member list, and a truncated
    // list is a check that passes because it stopped asking.
    const source = `
interface Syncable {
  id: string;
  options: { deep: boolean; deeper: { x: number } };
  sync(): void;
}
interface Other {
  notMine: string;
}
`;

    const members = interfaceMembers(source, "Syncable");

    expect(members).toContain("sync");
    expect(members).not.toContain("notMine");
  });

  it("does not pick up the following interface's members", () => {
    const source = "interface A {\n  a: string;\n}\ninterface B {\n  b: string;\n}";

    expect(interfaceMembers(source, "A")).toEqual(["a"]);
    expect(interfaceMembers(source, "B")).toEqual(["b"]);
  });

  it("ignores a line comment that looks like a member declaration", () => {
    const source = `
interface Syncable {
  // upserted: number;  <- the old spelling, kept as a note
  itemsUpserted: number;
}
`;

    expect(interfaceMembers(source, "Syncable")).toEqual(["itemsUpserted"]);
  });

  it("throws, naming the interface, when it is not in the source at all", () => {
    // The load-bearing failure. A renamed or moved interface must stop the harness, not
    // yield [] — an empty required-member set makes "the skeleton supplies everything
    // Syncable requires" trivially true.
    expect(() => interfaceMembers("interface Other { x: string }", "Syncable")).toThrow(
      "interface Syncable not found in the real sync/types.ts",
    );
  });

  it("does not match an interface whose name merely starts with the one asked for", () => {
    // `indexOf("interface Sync {")` includes the trailing brace for this reason: without it,
    // asking for `Sync` would match `SyncResult` and check the wrong shape.
    expect(() => interfaceMembers("interface SyncResult {\n  a: string;\n}", "Sync")).toThrow(
      /interface Sync not found/,
    );
  });

  it("returns an empty list for an interface that genuinely has no members", () => {
    // Not an error here — the harness's own "parsed no members" check is what turns this
    // into a failure, and it needs to see the empty list to do that.
    expect(interfaceMembers("interface Empty {\n}", "Empty")).toEqual([]);
  });
});

/**
 * Optionality, which the name-only extractor discarded.
 *
 * This is the half that was missing when Nimbus's `Syncable` grew an optional `fetchOne`:
 * every member came back looking required, `wiring:conformance` reported that the emitted
 * skeleton "does not supply Syncable.fetchOne", and `preflight` failed at a gate the generator
 * had not broken. A false RED, which costs the same thing a false green does — it teaches
 * people that the gate's opinion can be ignored.
 */
describe("interfaceMemberDetails", () => {
  it("marks a `?:` member optional and a plain one required", () => {
    const source =
      "interface SyncResult {\n  itemsUpserted: number;\n  bytesTransferred?: number;\n}";

    expect(interfaceMemberDetails(source, "SyncResult")).toEqual([
      { name: "itemsUpserted", optional: false },
      { name: "bytesTransferred", optional: true },
    ]);
  });

  it("marks an optional METHOD optional — the shape that produced the false red", () => {
    // `fetchOne?(ctx, url)` reaches the `[:(]` tail through the `(`, not the `:`. Reading the
    // `?` off a class that also matches spaces is what makes both spellings work.
    const source = [
      "interface Syncable {",
      "  readonly serviceId: string;",
      "  sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult>;",
      "  fetchOne?(ctx: SyncContext, url: string): Promise<FetchOneResult>;",
      "}",
    ].join("\n");

    expect(interfaceMemberDetails(source, "Syncable")).toEqual([
      { name: "serviceId", optional: false },
      { name: "sync", optional: false },
      { name: "fetchOne", optional: true },
    ]);
  });

  it("reads the `?` through whitespace on either side", () => {
    // The capture is over `[ \t?]*`, so it must not depend on the `?` hugging the name.
    const source = "interface X {\n  a ? : string;\n  b\t?\t: number;\n  c: number;\n}";

    expect(interfaceMemberDetails(source, "X")).toEqual([
      { name: "a", optional: true },
      { name: "b", optional: true },
      { name: "c", optional: false },
    ]);
  });

  it("keeps `readonly` off the name while still reading optionality", () => {
    const source = "interface X {\n  readonly id: string;\n  readonly count?: number;\n}";

    expect(interfaceMemberDetails(source, "X")).toEqual([
      { name: "id", optional: false },
      { name: "count", optional: true },
    ]);
  });
});
