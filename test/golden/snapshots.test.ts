import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../../src/emit/index.ts";
import { formatAll, initFormatter } from "../../src/format.ts";
import { compareSnapshot, loadSnapshot } from "../../src/golden/snapshots.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath } from "../../src/types.ts";

describe("compareSnapshot", () => {
  it("reports nothing when the trees match", () => {
    const m = new Map([["a.ts", "x"]]);
    expect(compareSnapshot(m, new Map(m))).toEqual({ missing: [], unexpected: [], changed: [] });
  });

  it("reports a changed file", () => {
    expect(compareSnapshot(new Map([["a.ts", "y"]]), new Map([["a.ts", "x"]])).changed).toEqual([
      "a.ts",
    ]);
  });

  it("reports a file the generator stopped emitting", () => {
    expect(compareSnapshot(new Map(), new Map([["a.ts", "x"]])).missing).toEqual(["a.ts"]);
  });

  it("reports a file the generator started emitting", () => {
    expect(compareSnapshot(new Map([["b.ts", "x"]]), new Map()).unexpected).toEqual(["b.ts"]);
  });

  // Non-emptiness is loadSnapshot's job, not compareSnapshot's. compareSnapshot is a pure
  // diff over two trees and must stay total — given an empty expected tree it reports every
  // actual file as `unexpected`, which is a loud, correct answer rather than a throw.
  //
  // The vacuous-pass risk lives one level up: a snapshot directory that is absent or empty
  // must not silently compare nothing and report success. Stage A shipped a harness that
  // printed "All fixtures byte-identical" on zero fixtures; loadSnapshot is where that is
  // prevented for snapshots.
  it("reports every actual file as unexpected against an empty tree, rather than throwing", () => {
    expect(compareSnapshot(new Map([["a.ts", "x"]]), new Map()).unexpected).toEqual(["a.ts"]);
  });

  it("refuses to load a missing snapshot directory", () => {
    expect(() => loadSnapshot("does/not/exist")).toThrow(/no snapshot/i);
  });

  it("refuses to load a snapshot directory containing no files", () => {
    const empty = mkdtempSync(join(tmpdir(), "cnc-snap-empty-"));
    try {
      expect(() => loadSnapshot(empty)).toThrow(/no snapshot/i);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

const fixturesDir = join(import.meta.dir, "..", "..", "fixtures");
const snapshotsDir = join(fixturesDir, "snapshots");

/**
 * A "write fixture" is a spec with at least one non-`read`-effect tool — the same
 * `effect` field the emitter reads to decide `hitlRequired`. Deliberately not a hardcoded
 * name list: no write fixture exists yet (Task 8 adds `zzwrite` and `zzwriterest`), and
 * neither this file nor scripts/snapshot-update.ts is on Task 8's list of files to modify,
 * so both must pick up new write fixtures purely from fixture content.
 */
function listWriteFixtures(): string[] {
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".spec.json"))
    .map((f) => f.replace(/\.spec\.json$/, ""))
    .filter((name) => {
      const spec = parseSpec(
        JSON.parse(readFileSync(join(fixturesDir, `${name}.spec.json`), "utf8")),
      );
      return spec.tools.some((t) => t.effect !== "read");
    })
    .sort();
}

describe("generated write output vs. checked-in snapshots", () => {
  beforeAll(async () => {
    await initFormatter();
  });

  const names = listWriteFixtures();

  // Nothing to iterate yet — this task builds the machinery; Task 8 adds the write
  // fixtures and their snapshots, at which point the loop below starts generating cases
  // with no change needed here.
  for (const name of names) {
    it(`matches the checked-in snapshot for ${name}`, () => {
      const spec = parseSpec(
        JSON.parse(readFileSync(join(fixturesDir, `${name}.spec.json`), "utf8")),
      );
      const files = formatAll(generate(spec, { target: "standalone" }));
      const actual = new Map(files.map((f) => [displayPath(f.path), f.content]));

      // loadSnapshot throws if the directory is absent or empty — the non-emptiness
      // assertion the brief calls for happens here, before compareSnapshot ever runs.
      const expected = loadSnapshot(join(snapshotsDir, name));

      expect(compareSnapshot(actual, expected)).toEqual({
        missing: [],
        unexpected: [],
        changed: [],
      });
    });
  }
});
