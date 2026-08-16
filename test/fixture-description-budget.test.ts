import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

/**
 * The licensing carve-out in `CLAUDE.md` and `docs/LICENSING.md` is a bounded claim: the
 * fixtures reproduce real connectors' description strings verbatim, and the bound is how
 * many fixtures and how many characters. Both numbers were hand-written and both went
 * stale — the corpus grew from eleven fixtures / 8,452 characters to fourteen / 12,688
 * when `codemagic` (#93) and then `intercom`/`lever` (#99) landed, and neither PR touched
 * the prose. Nothing failed, because nothing derived the numbers.
 *
 * An understated bound is the bad direction to drift in: the sentence is the load-bearing
 * argument for why `diff:golden` is not comparing the corpus against itself, and it is
 * weaker than the truth it is defending. So this derives both numbers from the fixtures
 * and asserts the documents quote them.
 */

type Spec = {
  readonly description?: string;
  readonly tools?: ReadonlyArray<{ readonly description?: string }>;
};

/** The real-connector fixtures: the non-`zz` keys, the same set the write-tool gate uses. */
function realConnectorFixtures(): string[] {
  const raw = readFileSync(join(ROOT, "fixtures", "expectations.json"), "utf8");
  return Object.keys(JSON.parse(raw) as Record<string, unknown>)
    .filter((k) => !k.startsWith("zz"))
    .sort();
}

/** Every description string the carve-out covers: the spec's own, plus each tool's. */
function describedCharacters(fixture: string): number {
  const raw = readFileSync(join(ROOT, "fixtures", `${fixture}.spec.json`), "utf8");
  const spec = JSON.parse(raw) as Spec;
  let n = spec.description?.length ?? 0;
  for (const tool of spec.tools ?? []) n += tool.description?.length ?? 0;
  return n;
}

describe("the licensing carve-out's stated bound matches the corpus", () => {
  it("derives a non-trivial corpus", () => {
    // Non-vacuity floor. Both assertions below compare derived numbers against document
    // text, so a scan that silently produced 0 fixtures / 0 characters would otherwise
    // fail in a way that looks like a docs problem rather than a broken scan.
    //
    // Every fixture, not just the first sorted one: the character total is a SUM, so one
    // fixture quietly reading zero — a renamed `tools` key, a spec that lost its
    // `description` — only makes the total smaller, and the fix that follows is someone
    // updating CLAUDE.md to the new number. Checking one fixture cannot see that; the
    // floor has to be per-fixture to be a floor on the scan rather than on the corpus.
    const fixtures = realConnectorFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(14);
    for (const fixture of fixtures) {
      expect(
        describedCharacters(fixture),
        `${fixture} contributes no described characters`,
      ).toBeGreaterThan(0);
    }
  });

  it("CLAUDE.md and docs/LICENSING.md state the real fixture count", () => {
    const count = realConnectorFixtures().length;
    // Spelled out, matching how the sentences are written ("All fourteen real-connector
    // fixtures"). Only the counts this corpus can plausibly reach are mapped; an
    // unmapped count fails loudly rather than skipping the check.
    const spelled: Record<number, string> = {
      12: "twelve",
      13: "thirteen",
      14: "fourteen",
      15: "fifteen",
      16: "sixteen",
      17: "seventeen",
      18: "eighteen",
      19: "nineteen",
      20: "twenty",
    };
    const word = spelled[count];
    expect(word, `no spelling mapped for ${count} fixtures — extend this table`).toBeDefined();

    for (const doc of ["CLAUDE.md", "docs/LICENSING.md"]) {
      const src = readFileSync(join(ROOT, doc), "utf8");
      const claims = src.match(
        /\b(?:eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\s+(?:real-connector|hand-written)\s+fixtures/g,
      );
      expect(claims, `${doc} makes no fixture-count claim — did the sentence move?`).not.toBeNull();
      for (const claim of claims ?? []) {
        expect(claim, `${doc} states a stale fixture count`).toContain(word as string);
      }
    }
  });

  it("CLAUDE.md states the real description-character total", () => {
    const total = realConnectorFixtures().reduce((n, f) => n + describedCharacters(f), 0);
    const src = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
    const formatted = total.toLocaleString("en-US");
    expect(src, `CLAUDE.md should state ${formatted} described characters`).toContain(formatted);
  });
});
