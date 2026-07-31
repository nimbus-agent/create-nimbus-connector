import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../../src/emit/index.ts";
import {
  formatAll,
  formatterAvailable,
  formatterUnavailableReason,
  initFormatter,
} from "../../src/format.ts";
import { compareSnapshot, listWriteFixtures, loadSnapshot } from "../../src/golden/snapshots.ts";
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

  // The single-element cases above pass even if .sort() were never called (an array of
  // one is already sorted). This pins the ordering itself, inserted deliberately out of
  // order across all three buckets.
  it("sorts multi-element missing/unexpected/changed arrays by code unit, not insertion order", () => {
    const actual = new Map([
      ["z-changed.ts", "new-z"],
      ["a-changed.ts", "new-a"],
      ["z-new.ts", "x"],
      ["a-new.ts", "x"],
    ]);
    const expected = new Map([
      ["z-changed.ts", "old-z"],
      ["a-changed.ts", "old-a"],
      ["z-gone.ts", "x"],
      ["a-gone.ts", "x"],
    ]);
    const diff = compareSnapshot(actual, expected);
    expect(diff.changed).toEqual(["a-changed.ts", "z-changed.ts"]);
    expect(diff.missing).toEqual(["a-gone.ts", "z-gone.ts"]);
    expect(diff.unexpected).toEqual(["a-new.ts", "z-new.ts"]);
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

describe("generated write output vs. checked-in snapshots", () => {
  beforeAll(async () => {
    await initFormatter();
    if (!formatterAvailable()) {
      throw new Error(
        "@biomejs/biome is required here — snapshots are checked in byte-exact, and an " +
          "unformatted comparison would report spurious `changed` diffs that look like " +
          `generator regressions. ${formatterUnavailableReason()}`,
      );
    }
  });

  const names = listWriteFixtures(fixturesDir);

  // The guard finding-1 exists for: `names` is derived (effect !== "read" on a fixture's
  // tools), not hardcoded, so a broken predicate — wrong glob, renamed field, schema
  // drift — would silently shrink `names` to fewer entries (or zero) while
  // fixtures/snapshots/ still holds the checked-in directories for the fixtures that
  // dropped out. Each of those would then never get an `it()` generated for it below,
  // and the suite would report full green while comparing nothing for them — exactly
  // the Stage A failure shape, just triggered by the selection predicate instead of the
  // snapshot directory itself.
  //
  // This equality is bidirectional and needs no hardcoded count: today both sides are
  // empty (no write fixture exists yet — Task 8 adds zzwrite/zzwriterest) and it passes;
  // once Task 8 lands both sides gain the same two entries and it still passes. It also
  // catches the reverse mistake — a snapshot directory left behind for a fixture that no
  // longer qualifies.
  it("derives exactly the set of directories checked in under fixtures/snapshots/", () => {
    const onDisk = existsSync(snapshotsDir)
      ? readdirSync(snapshotsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
          .sort()
      : [];
    expect(names).toEqual(onDisk);
  });

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
