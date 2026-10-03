/**
 * `bun run snapshot:update` — regenerates the checked-in snapshot tree of every write fixture.
 *
 * The driver only: what each fixture's update is, the report lines, the deletion of files the
 * generator stopped emitting and the closing tally all live in scripts/_lib/snapshot-update.ts,
 * where test/scripts/snapshot-update.test.ts reaches them against temp directories. What stays
 * here is the refusal to run without the formatter, and the order: every fixture's plan is
 * printed before that fixture is written.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatterAvailable, formatterUnavailableReason, initFormatter } from "../src/format.ts";
import { listWriteFixtures, type SnapshotDiff } from "../src/golden/snapshots.ts";
import {
  applySnapshotUpdate,
  planSnapshotUpdate,
  snapshotSummary,
} from "./_lib/snapshot-update.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(scriptDir, "..", "fixtures");
const snapshotsDir = join(fixturesDir, "snapshots");

async function main(): Promise<void> {
  await initFormatter();
  if (!formatterAvailable()) {
    throw new Error(
      "@biomejs/biome is required here — snapshots are checked in byte-exact, and " +
        "unformatted output would get pinned as if it were the intended shape. " +
        formatterUnavailableReason(),
    );
  }

  const names = listWriteFixtures(fixturesDir);
  if (names.length === 0) {
    console.log(
      "No write fixtures found (a write fixture is a spec with at least one non-read-effect " +
        "tool). Nothing to update.",
    );
    return;
  }

  const diffs: SnapshotDiff[] = [];
  for (const name of names) {
    const plan = planSnapshotUpdate(name, fixturesDir, snapshotsDir);
    for (const line of plan.lines) console.log(line);
    await applySnapshotUpdate(plan);
    diffs.push(plan.diff);
  }

  console.log(`\n${snapshotSummary(diffs)}`);
}

// Guarded exactly as src/cli.ts is. Importing this module used to rewrite every checked-in
// snapshot tree; now it only defines. `bun scripts/snapshot-update.ts` is unchanged.
if (import.meta.main) {
  await main();
}
