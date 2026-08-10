/**
 * Unit tests for the two checks behind `bun run wiring:conformance`.
 *
 * The script itself needs an AGPL Nimbus checkout, so before these checks were extracted into
 * `scripts/_lib/wiring-checks.ts` nothing could call them and both had been vacuous in
 * production without a test noticing:
 *
 *   - the stand-in shipped `upserted`/`deleted` against a real `itemsUpserted`/`itemsDeleted`;
 *   - the skeleton check matched the emitted file's own docstring — "sync() below throws" —
 *     rather than its object literal, so renaming the emitted method left the gate green.
 *
 * Both are pinned below, the second as the exact mutation that exposed it.
 *
 * These are hand-written miniatures of Nimbus's shapes, not copies: this repo is MIT and Nimbus
 * is AGPL-3.0-only. They carry the member NAMES, which is what the checks compare.
 */

import { describe, expect, it } from "bun:test";
import { checkWiring, optionalReport } from "../../scripts/_lib/wiring-checks.ts";

/** A miniature of the real `sync/types.ts`: the two interfaces, one optional member each. */
const REAL_TYPES = [
  "export interface SyncResult {",
  "  cursor: string | null;",
  "  itemsUpserted: number;",
  "  itemsDeleted: number;",
  "  bytesTransferred?: number;",
  "}",
  "export interface Syncable {",
  "  readonly serviceId: string;",
  "  readonly defaultIntervalMs: number;",
  "  sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult>;",
  "  fetchOne?(ctx: SyncContext, url: string): Promise<FetchOneResult>;",
  "}",
].join("\n");

/** A conforming skeleton, with the docstring the real emitter writes above it. */
const GOOD_SYNC = [
  "/**",
  " * A SKELETON. This is not a working implementation — sync() below throws.",
  " */",
  "export function createXSyncable(): Syncable {",
  "  return {",
  "    serviceId: SERVICE_ID,",
  "    defaultIntervalMs: 300000,",
  "    sync(_ctx: SyncContext, _cursor: string | null): Promise<SyncResult> {",
  "      throw new Error(`createXSyncable().sync is unimplemented`);",
  "    },",
  "  };",
  "}",
].join("\n");

const GOOD_STANDIN = [
  "interface SyncResult {",
  "  cursor: string | null;",
  "  itemsUpserted: number;",
  "  itemsDeleted: number;",
  "}",
].join("\n");

const inputs = (over: Partial<Parameters<typeof checkWiring>[0]> = {}) => ({
  realTypes: REAL_TYPES,
  emittedSync: GOOD_SYNC,
  standin: GOOD_STANDIN,
  typesPath: "/nimbus/packages/gateway/src/sync/types.ts",
  ...over,
});

describe("checkWiring", () => {
  it("passes a conforming skeleton and stand-in", () => {
    expect(checkWiring(inputs()).failures).toEqual([]);
  });

  it("splits required from optional rather than demanding everything", () => {
    const v = checkWiring(inputs());

    expect(v.required).toEqual(["serviceId", "defaultIntervalMs", "sync"]);
    expect(v.optional).toEqual(["fetchOne"]);
    expect(v.resultRequired).toEqual(["cursor", "itemsUpserted", "itemsDeleted"]);
    expect(v.resultOptional).toEqual(["bytesTransferred"]);
  });

  // The false RED. `fetchOne?` is optional; failing on it fails a gate the generator did not
  // break, and the skeleton above deliberately does not supply it.
  it("does not fail on an optional Syncable member the skeleton omits", () => {
    const v = checkWiring(inputs());

    expect(v.failures.join(" ")).not.toContain("fetchOne");
  });

  // The false GREEN, as the mutation that found it: the docstring says "sync() below throws",
  // so a whole-file search matches whatever the literal declares.
  it("fails when the emitted literal drops a required member the docstring still names", () => {
    const mutated = GOOD_SYNC.replace("    sync(_ctx", "    syncMUTANT(_ctx");
    expect(mutated).toContain("sync() below throws"); // the decoy is still present

    const v = checkWiring(inputs({ emittedSync: mutated }));

    expect(v.failures).toEqual(["emitted skeleton does not supply Syncable.sync"]);
  });

  it("fails when the stand-in has drifted from the real field names", () => {
    // The drift that actually shipped: `upserted`/`deleted` against `itemsUpserted`.
    const drifted = "interface SyncResult {\n  cursor: string | null;\n  upserted: number;\n}";

    const v = checkWiring(inputs({ standin: drifted }));

    expect(v.failures).toHaveLength(2);
    expect(v.failures[0]).toContain("SYNC_TYPES_STANDIN is missing SyncResult.itemsUpserted");
    expect(v.failures[0]).toContain("/nimbus/packages/gateway/src/sync/types.ts");
  });

  it("does not require the stand-in to carry an OPTIONAL SyncResult field", () => {
    // Previously a hard-coded `bytesTransferred` skip — the same rule written once per name.
    expect(checkWiring(inputs()).failures).toEqual([]);
    expect(GOOD_STANDIN).not.toContain("bytesTransferred");
  });

  it("throws, naming the file, when an interface parses to nothing", () => {
    // Load-bearing: an empty member set makes "the skeleton supplies everything required"
    // trivially true, which is the vacuous pass this whole harness exists to refuse.
    const empty = "export interface SyncResult {\n}\nexport interface Syncable {\n}";

    expect(() => checkWiring(inputs({ realTypes: empty }))).toThrow(
      /Parsed no members out of .*types\.ts/,
    );
  });
});

describe("optionalReport", () => {
  it("qualifies each name with the interface it came from", () => {
    expect(optionalReport(checkWiring(inputs()))).toEqual([
      "Syncable.fetchOne",
      "SyncResult.bytesTransferred",
    ]);
  });

  it("is empty when the real interfaces declare nothing optional", () => {
    const allRequired = REAL_TYPES.replace("bytesTransferred?:", "bytesTransferred:").replace(
      "fetchOne?(",
      "fetchOne(",
    );

    expect(optionalReport(checkWiring(inputs({ realTypes: allRequired })))).toEqual([]);
  });
});
