/**
 * Unit tests for `bun run snapshot:update`'s decisions — scripts/_lib/snapshot-update.ts.
 *
 * The script rewrites golden data that test/golden/snapshots.test.ts then trusts byte for byte,
 * and until it was split it had no test at all: its one claim — that the checked-in tree ends up
 * EXACTLY matching what the generator emits, files it stopped emitting included — was a comment.
 * Every case below runs against the real `zzwrite` fixture spec, read in place, with the snapshot
 * tree in a fresh temp directory; nothing under fixtures/ is written.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applySnapshotUpdate,
  loadExistingSnapshot,
  planSnapshotUpdate,
  snapshotSummary,
} from "../../scripts/_lib/snapshot-update.ts";
import { initFormatter } from "../../src/format.ts";
import { loadSnapshot } from "../../src/golden/snapshots.ts";
import { displayPath } from "../../src/types.ts";
import { tempDirs } from "../support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

beforeAll(async () => {
  await initFormatter();
});

const fixturesDir = join(import.meta.dir, "..", "..", "fixtures");
const FIXTURE = "zzwrite";

describe("loadExistingSnapshot", () => {
  it("treats a snapshot directory that does not exist yet as empty, for a brand-new fixture", () => {
    expect(loadExistingSnapshot(join(tmp.make("cnc-snap-"), "absent"))).toEqual(new Map());
  });

  it("treats an existing but empty directory the same way", () => {
    expect(loadExistingSnapshot(tmp.make("cnc-snap-empty-"))).toEqual(new Map());
  });

  it("returns a populated tree's files keyed by forward-slash path", () => {
    const dir = tmp.make("cnc-snap-full-");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "server.ts"), "export {};\n", "utf8");

    expect(loadExistingSnapshot(dir)).toEqual(new Map([["src/server.ts", "export {};\n"]]));
  });
});

describe("planSnapshotUpdate", () => {
  it("reports every file as added on a fixture's first run, and writes nothing", () => {
    const snapshotsDir = tmp.make("cnc-snap-first-");

    const plan = planSnapshotUpdate(FIXTURE, fixturesDir, snapshotsDir);
    const paths = plan.files.map((f) => displayPath(f.path)).sort();

    expect(paths).toContain("src/server.ts");
    expect(plan.outDir).toBe(join(snapshotsDir, FIXTURE));
    expect(plan.diff).toEqual({ missing: [], unexpected: paths, changed: [] });
    expect(plan.lines).toEqual([`${FIXTURE}:`, ...paths.map((p) => `  + ${p}`)]);
    // A plan only reads: the driver prints it before anything on disk moves.
    expect(existsSync(plan.outDir)).toBe(false);
  });

  it("reports no changes for a tree a previous run wrote", async () => {
    const snapshotsDir = tmp.make("cnc-snap-again-");
    await applySnapshotUpdate(planSnapshotUpdate(FIXTURE, fixturesDir, snapshotsDir));

    const again = planSnapshotUpdate(FIXTURE, fixturesDir, snapshotsDir);

    expect(again.diff).toEqual({ missing: [], unexpected: [], changed: [] });
    expect(again.lines).toEqual([`${FIXTURE}:`, "  (no changes)"]);
  });

  it("lists added, then changed, then removed files, each under its own mark", async () => {
    const snapshotsDir = tmp.make("cnc-snap-moved-");
    await applySnapshotUpdate(planSnapshotUpdate(FIXTURE, fixturesDir, snapshotsDir));
    const outDir = join(snapshotsDir, FIXTURE);
    rmSync(join(outDir, "README.md"));
    writeFileSync(join(outDir, "package.json"), "{}\n", "utf8");
    writeFileSync(join(outDir, "src", "stale.ts"), "export {};\n", "utf8");

    const plan = planSnapshotUpdate(FIXTURE, fixturesDir, snapshotsDir);

    expect(plan.lines).toEqual([
      `${FIXTURE}:`,
      "  + README.md",
      "  ~ package.json",
      "  - src/stale.ts",
    ]);
  });
});

describe("applySnapshotUpdate", () => {
  it("leaves the tree exactly matching what the generator emits, stale files deleted", async () => {
    const snapshotsDir = tmp.make("cnc-snap-apply-");
    await applySnapshotUpdate(planSnapshotUpdate(FIXTURE, fixturesDir, snapshotsDir));
    const outDir = join(snapshotsDir, FIXTURE);
    writeFileSync(join(outDir, "package.json"), "{}\n", "utf8");
    writeFileSync(join(outDir, "src", "stale.ts"), "export {};\n", "utf8");

    const plan = planSnapshotUpdate(FIXTURE, fixturesDir, snapshotsDir);
    await applySnapshotUpdate(plan);

    // Rewriting the current files alone would leave src/stale.ts behind, and the golden test
    // would go on comparing against a file no run produces.
    expect(existsSync(join(outDir, "src", "stale.ts"))).toBe(false);
    expect(loadSnapshot(outDir)).toEqual(
      new Map(plan.files.map((f) => [displayPath(f.path), f.content])),
    );
    expect(readFileSync(join(outDir, "package.json"), "utf8")).not.toBe("{}\n");
  });
});

describe("snapshotSummary", () => {
  it("totals each kind of move across every fixture the run updated", () => {
    expect(
      snapshotSummary([
        { unexpected: ["a", "b"], changed: ["c"], missing: [] },
        { unexpected: [], changed: [], missing: ["d"] },
        { unexpected: ["e"], changed: ["f", "g"], missing: ["h", "i"] },
      ]),
    ).toBe("3 write fixture(s): 3 added, 3 changed, 3 removed.");
  });

  it("keeps the three counts apart rather than summing them together", () => {
    expect(snapshotSummary([{ unexpected: ["a"], changed: [], missing: ["b", "c", "d"] }])).toBe(
      "1 write fixture(s): 1 added, 0 changed, 3 removed.",
    );
  });
});
