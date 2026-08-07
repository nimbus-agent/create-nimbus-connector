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

  it("passes the repository's real CHANGELOG.md", () => {
    // The case no synthetic table can stand in for. A rule that is right about every fixture and
    // wrong about the actual file would red every release — and the actual file is the one shape
    // nobody would think to write down, four paragraphs of convention prose above a placeholder.
    const real = readFileSync(join(import.meta.dir, "..", "..", "CHANGELOG.md"), "utf8");
    expect(unreleasedProblems(real)).toEqual([]);
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
