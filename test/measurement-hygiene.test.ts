/**
 * Measurements written into source comments, graded against one rule: **a measurement carries the
 * date it was taken.**
 *
 * This exists because the same defect was found twice in one day, both times by accident while
 * doing something else:
 *
 * - `.github/workflows/sonar.yml` argued three times from "58 code smells already open". The real
 *   figure was 3 — wrong by an order of magnitude, and the paragraph's whole rhetorical weight
 *   rested on it.
 * - `test/gate-lists.test.ts`'s own header recorded "the 38 such files `trackedProseFiles`
 *   returns (24 Markdown, 14 YAML)" and `docs/ROADMAP.md` at "892 lines". Adding one document
 *   invalidated both, one pull request later.
 *
 * Neither was caught by anything. `docs/ROADMAP.md`'s *How to read this* already states the rule
 * they broke — "**Each states its date, its tree, and the command that re-measures it.** A number
 * carrying those can be checked; one without them is what the rule above forbids" — and nothing
 * enforced it, which is how a rule stated in prose behaves.
 *
 * ## What this proves, and the larger thing it does NOT
 *
 * **It cannot tell a current number from a stale one.** Nothing can, short of re-running the
 * measurement, and neither of the two failures above would have been caught by this file: both
 * comments already existed, and it was their *figures* that rotted. Saying so plainly matters more
 * than the gate does — a checklist that implies it verifies freshness would be worse than none.
 *
 * What it does prove is narrower and still worth having:
 *
 * 1. **A new measurement cannot arrive undated.** An undated one is unfalsifiable: a reader who
 *    doubts it has no way in. A dated one can be re-run and disproved, which is the whole
 *    difference between a claim and a measurement.
 * 2. **The existing debt is on screen on every run**, rather than discovered by accident a third
 *    time. `UNDATED_DEBT` below lists every file still carrying one, with its count.
 * 3. **The debt can only shrink.** An entry whose count drops fails until the number is lowered,
 *    so a file cannot be cleaned up quietly and leave a stale allowance behind — the same reason
 *    `fixtures/expectations.json` lists gaps rather than hiding them.
 *
 * ## Why an allowlist rather than dating all of them
 *
 * Because the dates are not recoverable. Most of these comments record something measured against
 * a Nimbus corpus tree nobody wrote down, at a time only `git log` approximates, and stamping
 * today's date on them would manufacture exactly the false confidence the rule exists to prevent —
 * a number that *looks* checkable and is not. A grandfathered entry is honest about being debt.
 * Delete an entry when you re-measure that file for real.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

/**
 * Files still carrying at least one undated measurement, with how many each has.
 *
 * **Not a target to hold steady — a debt to pay down.** Every entry is a comment asserting a
 * number that no reader can check and no gate can re-derive. Lower the count when you date one;
 * remove the file when it reaches zero. Both directions are enforced below.
 */
const UNDATED_DEBT: Readonly<Record<string, number>> = {
  ".github/workflows/sonar.yml": 1,
  "scripts/_lib/changelog-gate.ts": 1,
  "scripts/_lib/golden-diff.ts": 1,
  "scripts/_lib/mcp-frames.ts": 1,
  "scripts/_lib/preflight.ts": 2,
  "src/derive/index.ts": 1,
  "src/emit/manifest.ts": 1,
  "src/golden/biome-version.ts": 1,
  "src/openapi/operation.ts": 2,
  "src/openapi/schema.ts": 2,
  "src/openapi/spec.ts": 4,
  "src/spec.ts": 5,
  "src/validate.ts": 2,
  "test/coverage-gate.test.ts": 1,
  "test/derive/body.test.ts": 1,
  "test/derive/frame-readonly.test.ts": 1,
  "test/derive/round-trip.test.ts": 1,
  "test/emit/emitted-typecheck.test.ts": 1,
  "test/gate-lists.test.ts": 1,
  "test/openapi/spec.test.ts": 1,
  "test/schema.test.ts": 3,
  "test/scripts/preflight.test.ts": 1,
  "test/source-hygiene.test.ts": 1,
  "test/spec-doc.test.ts": 1,
  "test/spec.test.ts": 1,
};

/**
 * This file, excluded from its own sweep — and the detector limitation that forces the exclusion.
 *
 * `commentBlocks` scans raw text, so `"/** Measured across 22 fixtures *\/"` written as a STRING
 * LITERAL in the matcher cases below is indistinguishable from a real comment to it. Excluding the
 * grader is the cheap fix; the honest statement is that the same blind spot exists everywhere,
 * because any file could embed comment-shaped text in a string. Closing it properly means parsing
 * TypeScript rather than scanning it, which is a real cost for a defect nobody has ever committed
 * outside this file.
 *
 * Named as one path rather than a pattern, so a second grader cannot quietly inherit the
 * exemption.
 */
const SELF = "test/measurement-hygiene.test.ts";

/**
 * A comment that DECLARES a measurement, rather than one that merely contains a number.
 *
 * Triggering on the author's own word is deliberate, and it is the same choice
 * `test/gate-lists.test.ts` makes in triggering on a complete half of `GATES` rather than on
 * anything number-shaped. "Every comment with a digit in it" would fire on array indices, HTTP
 * status codes, version floors and byte offsets, and a gate that cries wolf is one people learn
 * to silence. Writing "measured" is a claim about evidence; this asks that the evidence be
 * datable.
 *
 * The cost is a real hole: a comment that states a corpus count without saying "measured" is
 * invisible here. `sonar.yml`'s "58 code smells" happened to say "that is measured rather than
 * assumed" and would have been seen; a bare "60 of the 94 connectors" would not. Narrowing the
 * hole means widening the trigger, and every widening tested so far cost more in noise than it
 * bought — recorded so the next person does not rediscover it as an oversight.
 */
const DECLARES_MEASUREMENT = /\b(?:re-)?measured\b/i;

/** An ISO date, which is what makes a measurement re-runnable rather than merely asserted. */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;

const isYaml = (path: string): boolean => path.endsWith(".yml") || path.endsWith(".yaml");

/**
 * The contiguous comment blocks in a source file, each as one string.
 *
 * Blocks rather than lines, because a measurement and its date are routinely on different lines of
 * the same paragraph — `src/emit/wiring.ts` writes "**Re-measured 2026-08-07 against" with the
 * tree on the line below. A line-scoped check would report every one of those as undated, and the
 * first thing anyone did about it would be to disable the check.
 */
function commentBlocks(path: string, text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) blocks.push(current.join("\n"));
    current = [];
  };

  if (isYaml(path) || path.endsWith(".toml")) {
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("#")) current.push(line);
      else flush();
    }
    flush();
    return blocks;
  }

  // TypeScript: `/* … */` spans are whole blocks; runs of `//` lines are one block each.
  for (const [span] of text.matchAll(/\/\*[\s\S]*?\*\//g)) blocks.push(span);
  for (const line of text.replaceAll(/\/\*[\s\S]*?\*\//g, "").split("\n")) {
    if (line.trimStart().startsWith("//")) current.push(line);
    else flush();
  }
  flush();
  return blocks;
}

/** Tracked source files a measurement could hide in. Excludes `fixtures/`, which is golden DATA. */
function trackedSourceFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
  });
  if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
  return out.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /\.(ts|yml|yaml|toml)$/.test(l) && !l.startsWith("fixtures/") && l !== SELF);
}

/** How many comment blocks in a file declare a measurement without dating it. */
function undatedMeasurements(path: string): number {
  const text = readFileSync(join(repoRoot, path), "utf8");
  return commentBlocks(path, text).filter((b) => DECLARES_MEASUREMENT.test(b) && !ISO_DATE.test(b))
    .length;
}

function surveyed(): Map<string, number> {
  const found = new Map<string, number>();
  for (const path of trackedSourceFiles()) {
    const n = undatedMeasurements(path);
    if (n > 0) found.set(path, n);
  }
  return found;
}

describe("measurements written into source comments", () => {
  it("finds the undated ones at all, so the rules below are not vacuous", () => {
    // Non-vacuity first, on test/source-hygiene.test.ts's reasoning: a sweep that silently matched
    // nothing would satisfy every assertion after this one. Asserted as a floor rather than an
    // exact figure — an exact one would be a number in a comment's clothing, which is the defect
    // this file is about.
    const found = surveyed();
    expect(found.size).toBeGreaterThan(10);
    expect([...found.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(20);
  });

  it("adds no new undated measurement outside the declared debt", () => {
    // The rule that actually bites on a pull request. A file absent from UNDATED_DEBT must carry
    // none; a file present must not carry MORE than it did. Both directions in one message,
    // because "you added an undated measurement" and "you added another one" are the same mistake.
    const found = surveyed();
    const regressions = [...found.entries()]
      .filter(([path, n]) => n > (UNDATED_DEBT[path] ?? 0))
      .map(([path, n]) => `${path}: ${n} undated, allowed ${UNDATED_DEBT[path] ?? 0}`);

    expect(regressions).toEqual([]);
  });

  it("keeps the debt list honest, so a cleaned-up file cannot leave a stale allowance", () => {
    // The direction an allowlist normally rots in. Without this, a file whose measurements were
    // all dated keeps its entry forever, and the list stops describing the repository — which is
    // the failure `fixtures/expectations.json` avoids by listing gaps rather than permissions.
    const found = surveyed();
    const stale = Object.entries(UNDATED_DEBT)
      .filter(([path, allowed]) => (found.get(path) ?? 0) < allowed)
      .map(([path, allowed]) => `${path}: allows ${allowed}, actually ${found.get(path) ?? 0}`);

    expect(stale).toEqual([]);
  });

  it("recognises a dated measurement, and an undated one, on real text", () => {
    // The matcher, exercised on the failing side too. Run only against files that already pass, a
    // matcher proves the tree is tidy and says nothing about whether it works — the reasoning
    // test/gate-lists.test.ts's MATCHER_CASES gives, applied to a much smaller matcher.
    const undated = (src: string): number => {
      const blocks = commentBlocks("x.ts", src);
      return blocks.filter((b) => DECLARES_MEASUREMENT.test(b) && !ISO_DATE.test(b)).length;
    };

    expect(undated("/** Measured across 22 fixtures: nothing. */")).toBe(1);
    expect(undated("/** Measured 2026-08-07 across 22 fixtures. */")).toBe(0);
    expect(undated("/** Re-measured against tree 94fd3623. */")).toBe(1);
    // The multi-line case the block scope exists for: claim and date on different lines.
    expect(undated("// Re-measured 2026-08-07\n// against tree 94fd3623.")).toBe(0);
    // A number with no claim of measurement is not this file's business.
    expect(undated("/** Retries 3 times before giving up. */")).toBe(0);
    // Two separate `//` runs are two blocks, so a date in one does not excuse the other.
    expect(undated("// Measured: 5 things.\nconst a = 1;\n// Measured 2026-08-07: 6 things.")).toBe(
      1,
    );
  });

  it("reads YAML comment blocks, where one of the two known failures lived", () => {
    const yaml = ["# Measured over the corpus:", "# 58 code smells.", "jobs:", "  x: 1"].join("\n");
    expect(commentBlocks("a.yml", yaml).filter((b) => DECLARES_MEASUREMENT.test(b))).toHaveLength(
      1,
    );
    expect(commentBlocks("a.yml", yaml)[0]).toContain("58 code smells");
  });
});
