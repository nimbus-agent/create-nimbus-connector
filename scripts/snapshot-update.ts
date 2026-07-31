import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFiles } from "../src/cli.ts";
import { generate } from "../src/emit/index.ts";
import {
  formatAll,
  formatterAvailable,
  formatterUnavailableReason,
  initFormatter,
} from "../src/format.ts";
import { compareSnapshot, listWriteFixtures, loadSnapshot } from "../src/golden/snapshots.ts";
import { parseSpec } from "../src/spec.ts";
import { displayPath, type GeneratedFile } from "../src/types.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(scriptDir, "..", "fixtures");
const snapshotsDir = join(fixturesDir, "snapshots");

/** Like loadSnapshot, but a first run for a brand-new fixture has nothing to load yet. */
function loadExistingSnapshot(dir: string): Map<string, string> {
  try {
    return loadSnapshot(dir);
  } catch {
    return new Map();
  }
}

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

  let totalAdded = 0;
  let totalChanged = 0;
  let totalRemoved = 0;

  for (const name of names) {
    const spec = parseSpec(
      JSON.parse(readFileSync(join(fixturesDir, `${name}.spec.json`), "utf8")),
    );
    const files: GeneratedFile[] = formatAll(generate(spec, { target: "standalone" }));
    const actual = new Map(files.map((f) => [displayPath(f.path), f.content]));
    const outDir = join(snapshotsDir, name);
    const existing = loadExistingSnapshot(outDir);

    const { missing, unexpected, changed } = compareSnapshot(actual, existing);

    console.log(`${name}:`);
    if (missing.length === 0 && unexpected.length === 0 && changed.length === 0) {
      console.log("  (no changes)");
    } else {
      for (const p of unexpected) console.log(`  + ${p}`);
      for (const p of changed) console.log(`  ~ ${p}`);
      for (const p of missing) console.log(`  - ${p}`);
    }

    // Rewrite every current file (idempotent for the unchanged ones) and delete whatever
    // the generator stopped emitting, so the checked-in tree ends up exactly matching
    // `files` regardless of which of the three buckets above it fell into.
    await writeFiles(files, outDir);
    for (const p of missing) {
      rmSync(join(outDir, ...p.split("/")), { force: true });
    }

    totalAdded += unexpected.length;
    totalChanged += changed.length;
    totalRemoved += missing.length;
  }

  console.log(
    `\n${names.length} write fixture(s): ${totalAdded} added, ${totalChanged} changed, ` +
      `${totalRemoved} removed.`,
  );
}

await main();
