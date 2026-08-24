/**
 * `CLAUDE.md`'s *Layout* block, graded against `src/` in both directions.
 *
 * The block is the map an agent reads before deciding where a change belongs, and nothing
 * derived it. Three top-level modules had fallen off it and were named in no Markdown file in
 * the repository at all: `src/types.ts` (the `GeneratedFile` shape every emitter returns),
 * `src/license.ts` (the `--license` SPDX check) and `src/optional-dep.ts` (the predicate that
 * separates an absent optionalDependency from one whose own import failed — the distinction
 * `src/format.ts` and `src/derive/ast.ts` are required to handle *differently*). Each arrived
 * in its own pull request; none of them touched the block, and nothing failed.
 *
 * That is the same defect `test/gate-lists.test.ts` exists for one level over — a list that
 * happens to agree with the tree rather than being derived from it — so this applies the same
 * rule to the one list that says where code lives.
 *
 * ## Why the top level, and only the top level
 *
 * A per-file rule over all of `src/` cannot be written honestly. `src/derive/server/` is
 * documented as a *mirror* — "one recognizer per emitter module, plus frame.ts, hoists.ts,
 * second-file.ts and conditional-path.ts" — which is a complete and checkable description that
 * names none of the ten mirrored files. Requiring each of them by name would force either an
 * allowlist (a hole that grows) or a worse document (ten lines restating a rule that fits in
 * one). The top-level entries have no such out: each is either a module with a distinct job or
 * a directory with its own line, and a new one is a new place code can live.
 *
 * ## What this does NOT prove
 *
 * That a line is *accurate* — only that the entry is named. A description that has gone stale
 * reads exactly like one that has not, and no scan can tell them apart. The claim is narrower
 * than it looks and is worth having anyway: an entry nobody has to add is an entry nobody adds.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

/**
 * The fenced block under `## Layout`.
 *
 * Anchored on the heading rather than "the first fenced block", so moving the section does not
 * silently start grading a different block — a code fence elsewhere in the file would otherwise
 * satisfy every assertion below while the real map rotted.
 */
function layoutBlock(): string {
  const src = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");
  const match = /^## Layout\s*$\n+^```\s*$\n([\s\S]*?)^```\s*$/m.exec(src);
  if (match === null)
    throw new Error("CLAUDE.md has no fenced block under its `## Layout` heading");
  return match[1] ?? "";
}

/**
 * The top-level entries of `src/`, spelled the way the block spells them: a file as
 * `src/<name>.ts`, a directory as `src/<name>/`.
 */
function topLevelSrcEntries(): string[] {
  return readdirSync(join(repoRoot, "src"), { withFileTypes: true })
    .filter((e) => e.isDirectory() || e.name.endsWith(".ts"))
    .map((e) => (e.isDirectory() ? `src/${e.name}/` : `src/${e.name}`))
    .sort();
}

/**
 * Whether the block names an entry, as a whole path rather than as a substring.
 *
 * The boundary matters in one direction that has a real collision: `src/spec.ts` is a suffix of
 * nothing here, but `src/emit/` appears inside the prose of other lines ("the inverse of
 * `src/emit/`"), and a directory named in prose IS a mention. So a mention anywhere in the block
 * counts — what must not count is a *partial* one, which is why the character after the match is
 * checked. Without it `src/format.ts` would be credited by a hypothetical `src/format.tsx`.
 */
function namesEntry(block: string, entry: string): boolean {
  let from = 0;
  for (;;) {
    const at = block.indexOf(entry, from);
    if (at === -1) return false;
    const after = block.charAt(at + entry.length);
    if (!/[A-Za-z0-9_.-]/.test(after)) return true;
    from = at + 1;
  }
}

/** Every `src/…` path the block itself names, so the reverse direction can be checked. */
function pathsNamedInLayout(block: string): string[] {
  return [...new Set([...block.matchAll(/\bsrc\/[A-Za-z0-9_./-]*/g)].map((m) => m[0]))].sort();
}

describe("CLAUDE.md's Layout block", () => {
  it("has something to grade, so every rule below can fail", () => {
    // Non-vacuity, on test/gate-lists.test.ts's reasoning: a block that came back empty, or an
    // enumeration that came back empty, would satisfy the two directions below by having nothing
    // to compare. Floors rather than exact counts — an exact one is a number in a comment's
    // clothing, which is what test/measurement-hygiene.test.ts is about.
    const block = layoutBlock();
    expect(block.length).toBeGreaterThan(200);
    expect(topLevelSrcEntries().length).toBeGreaterThanOrEqual(10);
    expect(pathsNamedInLayout(block).length).toBeGreaterThanOrEqual(10);
  });

  it("discriminates, rather than matching anything src-shaped", () => {
    // The matcher graded against a path that is deliberately not there. Without this, a
    // `namesEntry` that always returned true would pass the whole file.
    const block = layoutBlock();
    expect(namesEntry(block, "src/does-not-exist.ts")).toBe(false);
    expect(namesEntry(block, "src/spec.t")).toBe(false);
    expect(namesEntry(block, "src/spec.ts")).toBe(true);
  });

  it("names every top-level entry of src/", () => {
    const block = layoutBlock();
    for (const entry of topLevelSrcEntries()) {
      expect(namesEntry(block, entry), `CLAUDE.md's Layout block does not name ${entry}`).toBe(
        true,
      );
    }
  });

  it("names no src/ path that is not there", () => {
    // The other direction: a map that still lists a module deleted three releases ago sends a
    // reader to a file that does not exist, which is worse than an omission because it reads as
    // evidence. Whole-path check — a nested path such as `src/emit/server/` is legitimate here
    // and must resolve too.
    const block = layoutBlock();
    for (const named of pathsNamedInLayout(block)) {
      const relative = named.replace(/\/$/, "");
      expect(
        existsSync(join(repoRoot, relative)),
        `CLAUDE.md's Layout block names ${named}, which does not exist`,
      ).toBe(true);
    }
  });
});
