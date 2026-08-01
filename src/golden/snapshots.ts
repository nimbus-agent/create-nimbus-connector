import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseSpec } from "../spec.ts";

/**
 * A pure diff between two file trees, keyed by POSIX-relative path -> content.
 *
 * `missing` — declared in `expected` but absent from `actual`: the generator stopped
 * emitting a file the checked-in snapshot has.
 * `unexpected` — present in `actual` but absent from `expected`: the generator started
 * emitting something new (or `expected` is empty — see compareSnapshot's doc).
 * `changed` — present in both, with different content.
 *
 * All three arrays are sorted by UTF-16 code unit (not `localeCompare`, which is locale-
 * and ICU-dependent) so a failure line reads the same on every machine.
 */
export type SnapshotDiff = {
  readonly missing: string[];
  readonly unexpected: string[];
  readonly changed: string[];
};

const byCodeUnit = (a: string, b: string): number => {
  if (a < b) return -1;
  return a > b ? 1 : 0;
};

/**
 * A total pure diff over two in-memory trees. Deliberately never throws: given an empty
 * `expected` tree it reports every `actual` file as `unexpected`, which is a loud, correct
 * answer, not a vacuous pass. Refusing an absent-or-empty snapshot *directory* is
 * loadSnapshot's job, one level up — see its doc for why the split sits there.
 */
export function compareSnapshot(
  actual: ReadonlyMap<string, string>,
  expected: ReadonlyMap<string, string>,
): SnapshotDiff {
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [path, content] of expected) {
    if (!actual.has(path)) {
      missing.push(path);
    } else if (actual.get(path) !== content) {
      changed.push(path);
    }
  }
  const unexpected = [...actual.keys()].filter((path) => !expected.has(path));

  missing.sort(byCodeUnit);
  unexpected.sort(byCodeUnit);
  changed.sort(byCodeUnit);
  return { missing, unexpected, changed };
}

/**
 * Walk `dir` and return every file it contains as POSIX-relative path -> content (utf8,
 * CRLF normalised to LF so a Windows checkout diffs identically to a Unix one).
 *
 * Throws when `dir` is absent or contains no files, in both cases with a message matching
 * /no snapshot/i. This is deliberate and is the counterpart to compareSnapshot staying
 * total: Stage A shipped a golden harness that walked zero fixtures and printed "All
 * fixtures byte-identical" — a directory that silently contributes nothing must not be
 * able to make a comparison report success. compareSnapshot cannot catch that on its own
 * (an empty `expected` map is indistinguishable from "everything genuinely matched
 * nothing"), so the refusal has to happen here, before a tree ever becomes a Map.
 */
export function loadSnapshot(dir: string): Map<string, string> {
  if (!existsSync(dir)) {
    throw new Error(
      `No snapshot directory at ${dir}. Run \`bun run snapshot:update\` to create it — ` +
        "a missing snapshot must fail loudly, not compare against nothing.",
    );
  }

  const out = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const abs = join(entry.parentPath, entry.name);
    const rel = relative(dir, abs).split(sep).join("/");
    out.set(rel, readFileSync(abs, "utf8").replaceAll("\r\n", "\n"));
  }

  if (out.size === 0) {
    throw new Error(
      `No snapshot files found under ${dir} — the directory exists but is empty. Run ` +
        "`bun run snapshot:update` to populate it; a directory that is present but hollow " +
        "must fail exactly like one that is absent.",
    );
  }

  return out;
}

/**
 * The sorted names of every fixture under `fixturesDir` that has at least one non-`read`
 * effect tool — the same `effect` field the emitter reads for `hitlRequired`.
 *
 * Sorted with the same explicit {@link byCodeUnit} comparator the diff above uses, for the
 * same reason: this list decides which fixtures get a checked-in snapshot directory, so its
 * order has to be identical on every machine. A bare `.sort()` happens to order strings by
 * UTF-16 code unit too, but it says so nowhere and reads as an oversight; `localeCompare`
 * would be an outright regression here, being locale- and ICU-dependent.
 *
 * Deliberately data-driven rather than a hardcoded list, and deliberately the single
 * definition (imported by both test/golden/snapshots.test.ts and
 * scripts/snapshot-update.ts, not copied into each): neither of those files is on Task 8's
 * list of files to modify, so both must pick up `zzwrite` / `zzwriterest` (and anything
 * added later) purely from fixture content, and must agree with each other on exactly
 * which fixtures that is — a script that snapshots fixtures the test never checks (or vice
 * versa) would defeat the point of either.
 */
export function listWriteFixtures(fixturesDir: string): string[] {
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".spec.json"))
    .map((f) => f.replace(/\.spec\.json$/, ""))
    .filter((name) => {
      const spec = parseSpec(
        JSON.parse(readFileSync(join(fixturesDir, `${name}.spec.json`), "utf8")),
      );
      return spec.tools.some((t) => t.effect !== "read");
    })
    .sort(byCodeUnit);
}
