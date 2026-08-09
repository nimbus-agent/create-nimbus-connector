/**
 * The changelog gate's rule, driven over the shapes a changelog can be in.
 *
 * This gate protects `npm publish`, which cannot be undone after 72 hours, and until this file
 * existed nothing exercised its logic at all. What guarded it was
 * test/release-workflow-guard.test.ts asserting that a step exists, is ordered before the publish,
 * and names CHANGELOG.md — every one of which stays true of a gate that has been silently
 * defanged. The measurement: with `bad = 1` deleted from either branch of the awk this replaces,
 * all six failing cases below exited 0 and the whole suite stayed green.
 *
 * The table is the ten cases the awk was verified against, transcribed here INDEPENDENTLY of
 * `unreleasedProblems` — this asks whether the rule is right, not whether it agrees with itself.
 * The three passing cases carry as much weight as the seven failing ones: a gate that refuses
 * everything is not a working gate, it is a release that can never be cut, and the prose case is
 * the one that forces the distinction. The real Unreleased section is permanently full of
 * convention prose, so "the section must be empty" is not available as a rule.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNRELEASED_PLACEHOLDER, unreleasedProblems } from "../../scripts/_lib/changelog-gate.ts";

/** How a case must come out: clean, or refused for a stated reason. */
type Case = {
  readonly name: string;
  readonly markdown: string;
  readonly clean: boolean;
  /** A fragment every refusal must carry, so a case cannot pass on the wrong complaint. */
  readonly because?: string;
};

const HEAD = "# Changelog\n\n## Unreleased\n\n";
const TAIL = "\n## 0.7.0\n\n- a shipped note\n";

const CASES: readonly Case[] = [
  {
    name: "the placeholder alone",
    markdown: `${HEAD}*Nothing pending.*\n${TAIL}`,
    clean: true,
  },
  {
    name: "an indented placeholder",
    markdown: `${HEAD}  *Nothing pending.*\n${TAIL}`,
    clean: true,
  },
  {
    name: "a placeholder carrying trailing spaces and tabs",
    // The other half of the trim, and it was uncovered until this case: with the TRAILING half
    // deleted, every test in this file and in test/release-workflow-guard.test.ts still passed,
    // while `last` held "*Nothing pending.*  \t" and the gate refused a changelog with nothing
    // wrong with it — a red release, not a false green, but silent either way. Trailing
    // whitespace is what an editor that does not strip it leaves behind, so this is the ordinary
    // case, not the exotic one.
    markdown: `${HEAD}*Nothing pending.*  \t\n${TAIL}`,
    clean: true,
  },
  {
    name: "convention prose above the placeholder",
    // NOT a hole, and the reason the rule is shaped the way it is: CHANGELOG.md's own Unreleased
    // section holds four paragraphs explaining what the section is for, permanently. A gate that
    // refused this would fail every release.
    markdown: `${HEAD}Hand-written. Move these notes down under their version.\n\n*Nothing pending.*\n${TAIL}`,
    clean: true,
  },
  {
    name: "a `*` bullet",
    markdown: `${HEAD}* an unreleased note\n\n*Nothing pending.*\n${TAIL}`,
    clean: false,
    because: "an unreleased note",
  },
  {
    name: "a `-` bullet",
    markdown: `${HEAD}- an unreleased note\n\n*Nothing pending.*\n${TAIL}`,
    clean: false,
    because: "an unreleased note",
  },
  {
    name: "a `###` sub-heading",
    markdown: `${HEAD}### Output changes\n\n*Nothing pending.*\n${TAIL}`,
    clean: false,
    because: "### Output changes",
  },
  {
    name: "an indented bullet",
    // The trim runs before the note match, so indenting a note does not hide it.
    markdown: `${HEAD}   - an unreleased note\n\n*Nothing pending.*\n${TAIL}`,
    clean: false,
    because: "an unreleased note",
  },
  {
    name: "no placeholder at all",
    markdown: `${HEAD}Some prose, and nothing saying the notes were moved.\n${TAIL}`,
    clean: false,
    because: "must end with its placeholder",
  },
  {
    name: "no Unreleased section at all",
    markdown: `# Changelog\n${TAIL}`,
    clean: false,
    because: "(no ## Unreleased section at all)",
  },
  {
    name: "a bullet filed after the placeholder",
    // Both problems are reported: the note, and the section no longer ending in the placeholder.
    markdown: `${HEAD}*Nothing pending.*\n\n- a late note\n${TAIL}`,
    clean: false,
    because: "a late note",
  },
];

describe("the changelog gate", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const problems = unreleasedProblems(c.markdown);
    if (c.clean) {
      expect(problems).toEqual([]);
      return;
    }
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain(c.because ?? "");
  });

  it("has cases in both directions, so neither verdict is the constant", () => {
    // A table of refusals alone passes against a gate that refuses everything — which would fail
    // every release rather than protect one. A table of clean cases alone passes against the
    // defanged awk this replaced.
    expect(CASES.filter((c) => c.clean).length).toBeGreaterThan(2);
    expect(CASES.filter((c) => !c.clean).length).toBeGreaterThan(5);
  });

  it("reports a bullet placed after the placeholder as both problems, not one", () => {
    // The `last` semantics, which are the subtle half of the rule: an offending line updates the
    // running last-line too, so a note filed below the placeholder is caught by the note rule AND
    // leaves the section not ending in the placeholder.
    const problems = unreleasedProblems(`${HEAD}*Nothing pending.*\n\n- a late note\n${TAIL}`);
    expect(problems).toHaveLength(2);
  });

  it("points the annotation at the offending line, not merely at the file", () => {
    // The `file=`/`line=` prefix is what makes the message land on the line in the pull request
    // diff. An annotation with the wrong prefix still prints and still fails the job, so nothing
    // else here would notice it had stopped being a pointer.
    const markdown = `${HEAD}- a note\n\n*Nothing pending.*\n${TAIL}`;
    expect(unreleasedProblems(markdown)[0]).toStartWith("::error file=CHANGELOG.md,line=5::");
  });

  it("trims the reported line, so trailing whitespace never reaches the annotation", () => {
    // `toContain` cannot pin this — "…note" is a substring of "…note \t" too — so the assertion
    // has to be on the END of the message. The trailing half of the trim is the half that was
    // written as `/[ \t]+$/` and backtracked quadratically; nothing exercised it until this test
    // and the placeholder case above, which is why the rewrite came with both.
    const markdown = `${HEAD}- an unreleased note \t\n\n*Nothing pending.*\n${TAIL}`;
    expect(unreleasedProblems(markdown)[0]).toEndWith("unreleased: - an unreleased note");
  });

  it("does not read the repository's real convention prose as pending work", () => {
    // The case no synthetic table can stand in for: the actual file is the one shape nobody would
    // think to write down, four paragraphs of convention prose above a placeholder. A rule right
    // about every fixture and wrong about that prose would red every release.
    //
    // This asserts the prose, NOT that the section is empty right now. `unreleasedProblems(real)`
    // was the whole file, which passed only while nothing was filed — and filing a note there is
    // what the section EXISTS for, so the first correct use of it would have failed this test and
    // the fix would have looked like weakening the gate. "Is it clean right now" is a question
    // about release readiness, and .github/workflows/release.yml already asks it, at the moment it
    // means something. This asks whether the rule is right.
    //
    // The note lines are dropped by a rule transcribed INDEPENDENTLY of `IS_A_NOTE`, the way the
    // table above transcribes the rest — asking the gate which lines to hide from the gate would
    // pass for any rule at all. `*Nothing pending.*` survives it: the marker needs the space after
    // it that a bullet has and the placeholder does not.
    const real = readFileSync(join(import.meta.dir, "..", "..", "CHANGELOG.md"), "utf8");
    const section = real.slice(real.indexOf("\n## Unreleased\n"));
    const prose = section
      .split("\n")
      .filter((l) => !/^[ \t]*(###|[*-][ \t])/.test(l))
      .join("\n");
    expect(unreleasedProblems(prose)).toEqual([]);
    // …and the prose is the bulk of it, so a `section` that failed to find the heading and left
    // `prose` empty or near-empty cannot pass the assertion above by having nothing in it.
    expect(prose.split("\n").length).toBeGreaterThan(10);
  });

  it("reports the real CHANGELOG.md's Unreleased notes, one per note and no others", () => {
    // Not a pass/fail on release readiness — see above — but the rule still has to be RIGHT about
    // the real file, and while notes are filed that is observable in a way an empty section cannot
    // show. Counted rather than looped over, because a loop over the problems asserts NOTHING in
    // the state this file spends most of its life in: clean, zero problems, body never entered.
    // The count is decidable either way, and `0 === 0` still catches a rule that invents one.
    const real = readFileSync(join(import.meta.dir, "..", "..", "CHANGELOG.md"), "utf8");
    const afterHeading = real.slice(real.indexOf("\n## Unreleased\n") + 1);
    const section = afterHeading.slice(0, afterHeading.indexOf("\n## ", 1));
    const noteLines = section.split("\n").filter((l) => /^[ \t]*(###|[*-][ \t])/.test(l));

    // One problem per note line — and no "must end with its placeholder" problem on top, which is
    // the assertion that the notes sit ABOVE the placeholder where the convention puts them.
    expect(unreleasedProblems(real)).toHaveLength(noteLines.length);
    for (const problem of unreleasedProblems(real)) {
      const quoted = problem.slice(problem.indexOf("::", 2) + 2).replace(/^[^:]*: /, "");
      expect(quoted).not.toBe("");
      expect(noteLines.map((l) => l.trim())).toContain(quoted);
    }
  });

  it("grades against the literal CHANGELOG.md actually documents", () => {
    // One fact in three files. The third statement of it is
    // test/release-workflow-guard.test.ts's own independent transcription.
    expect(readFileSync(join(import.meta.dir, "..", "..", "CHANGELOG.md"), "utf8")).toContain(
      UNRELEASED_PLACEHOLDER,
    );
  });

  it("is not fooled by a CRLF checkout", () => {
    // A deliberate divergence from the awk, which only ever ran on the ubuntu runner. This also
    // runs locally, where a stray CR would be counted as content and fail the gate for a reason
    // that has nothing to do with the changelog.
    expect(unreleasedProblems(`${HEAD}*Nothing pending.*\n${TAIL}`.replace(/\n/g, "\r\n"))).toEqual(
      [],
    );
  });
});
