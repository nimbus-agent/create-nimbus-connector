/**
 * `bun run snapshot:update`'s decisions, lifted out of the driver on the scripts/_lib/ convention:
 * a module nothing imports never enters the coverage report, so logic left in the driver behind
 * its `import.meta.main` guard was logic no test reached and no per-file floor could grade.
 *
 * The update is split in two, and the split is the driver's own order. `planSnapshotUpdate` only
 * READS — the fixture spec, and whatever snapshot tree is already checked in — and says what will
 * move; `applySnapshotUpdate` then WRITES. The driver prints the plan's lines between the two, so
 * the report of what is about to change is on screen before anything on disk has.
 *
 * The rule `applySnapshotUpdate` exists to keep: the checked-in tree ends up exactly matching what
 * the generator emits, whichever bucket a file fell into. Rewriting the current files is not
 * enough on its own — a file the generator STOPPED emitting would stay behind, and
 * test/golden/snapshots.test.ts would then go on comparing against a file no run produces.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFiles } from "../../src/cli.ts";
import { generate } from "../../src/emit/index.ts";
import { formatAll } from "../../src/format.ts";
import {
  compareSnapshot,
  emptySnapshotDirectoryMessage,
  loadSnapshot,
  noSnapshotDirectoryMessage,
  type SnapshotDiff,
} from "../../src/golden/snapshots.ts";
import { parseSpec } from "../../src/spec.ts";
import { displayPath, type GeneratedFile } from "../../src/types.ts";

/**
 * Like loadSnapshot, but a first run for a brand-new fixture has nothing to load yet.
 *
 * "Nothing yet" is loadSnapshot's two refusals and nothing else — no directory, or one with no
 * file in it — recognised by the exact message loadSnapshot builds for this `dir`. Any other
 * throw is rethrown: a tree that is there but cannot be read is not a first run, and reading it as
 * one would print every file as added and plan no stale file for deletion.
 */
export function loadExistingSnapshot(dir: string): Map<string, string> {
  try {
    return loadSnapshot(dir);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === noSnapshotDirectoryMessage(dir) ||
        error.message === emptySnapshotDirectoryMessage(dir))
    ) {
      return new Map();
    }
    throw error;
  }
}

/** One fixture's update, decided but not yet written. */
export type SnapshotPlan = {
  /** The formatted standalone package the fixture's spec generates today. */
  readonly files: readonly GeneratedFile[];
  /** `<snapshotsDir>/<name>`, the tree `files` replaces. */
  readonly outDir: string;
  /** What moves, against whatever is checked in now. */
  readonly diff: SnapshotDiff;
  /** The report: the fixture's name, then one line per moved file, or `(no changes)`. */
  readonly lines: readonly string[];
};

/**
 * Generate `<fixturesDir>/<name>.spec.json` for the standalone target, formatted, and compare it
 * with the tree under `<snapshotsDir>/<name>`. Reads only. `formatAll` requires an initialised
 * formatter; the driver refuses to run without one, since a snapshot is checked in byte-exact.
 */
export function planSnapshotUpdate(
  name: string,
  fixturesDir: string,
  snapshotsDir: string,
): SnapshotPlan {
  const spec = parseSpec(JSON.parse(readFileSync(join(fixturesDir, `${name}.spec.json`), "utf8")));
  const files = formatAll(generate(spec, { target: "standalone" }));
  const actual = new Map(files.map((f) => [displayPath(f.path), f.content]));
  const outDir = join(snapshotsDir, name);

  const diff = compareSnapshot(actual, loadExistingSnapshot(outDir));
  const { missing, unexpected, changed } = diff;

  const lines = [`${name}:`];
  if (missing.length === 0 && unexpected.length === 0 && changed.length === 0) {
    lines.push("  (no changes)");
  } else {
    for (const p of unexpected) lines.push(`  + ${p}`);
    for (const p of changed) lines.push(`  ~ ${p}`);
    for (const p of missing) lines.push(`  - ${p}`);
  }
  return { files, outDir, diff, lines };
}

/**
 * Rewrite every current file (idempotent for the unchanged ones) and delete whatever the
 * generator stopped emitting, so the checked-in tree ends up exactly matching `files` regardless
 * of which of the three buckets each file fell into.
 */
export async function applySnapshotUpdate(plan: SnapshotPlan): Promise<void> {
  await writeFiles(plan.files, plan.outDir);
  for (const p of plan.diff.missing) {
    rmSync(join(plan.outDir, ...p.split("/")), { force: true });
  }
}

/** The closing tally across every fixture the run updated. */
export function snapshotSummary(diffs: readonly SnapshotDiff[]): string {
  let added = 0;
  let changed = 0;
  let removed = 0;
  for (const d of diffs) {
    added += d.unexpected.length;
    changed += d.changed.length;
    removed += d.missing.length;
  }
  return `${diffs.length} write fixture(s): ${added} added, ${changed} changed, ${removed} removed.`;
}
