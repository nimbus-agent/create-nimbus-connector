/**
 * The changelog gate: whether `CHANGELOG.md`'s `## Unreleased` section still holds notes that
 * were supposed to move under a version before the release was cut.
 *
 * ## What it is guarding
 *
 * That section is hand-written — release-please derives its entries from commit subjects, and a
 * change to the BYTES a generated connector contains is something an existing user needs told even
 * when no subject line would say so — and release-please inserts its generated section BELOW it
 * rather than above. So the notes never move on their own: 0.4.0, 0.5.0 and 0.6.0 each published
 * with their own notes still filed as unreleased, and nothing in the repository reported it.
 *
 * The gate runs in `.github/workflows/release.yml` before `npm publish`, because npm cannot
 * unpublish after 72 hours. That ordering is asserted in test/release-workflow-guard.test.ts.
 *
 * ## Why this is TypeScript rather than the awk program it replaces
 *
 * It was nine lines of awk inlined in the workflow's `run:` body, and it was correct — checked
 * against the ten cases in test/scripts/changelog-gate.test.ts, all ten of which still pass here.
 * Nothing tested it. Deleting `bad = 1` from either branch left the gate exiting 0 on every input,
 * with the step still present, still named, still ordered before the publish, and every test in
 * this repository still green: a check that passes while asserting nothing, protecting the one
 * action in this project that cannot be undone.
 *
 * A test could have executed the awk, and that was tried first. It cannot be relied on: the
 * program needs `bash` and `awk` on PATH, and on Windows — where this project is developed —
 * `bash` resolves to the WSL launcher and `awk` is absent entirely unless `bun test` happens to
 * have been started from a Git Bash shell. A gate whose test passes or fails depending on which
 * terminal the developer opened is worse than the untested awk. Moved here, the rule is a pure
 * function over a string, it is Bun-only like everything else in this repository, and the driver
 * that runs it in CI is a driver — see scripts/_lib/build-spec-doc.ts's header for why the split
 * matters to the coverage floor.
 *
 * ## The one shape it deliberately lets through
 *
 * Prose. The real Unreleased section is permanently full of convention prose explaining what the
 * section is for, so a rule of "the section must be empty" would fail every release. What is
 * refused is a `###` sub-heading, a `*` or `-` bullet, and any section whose last non-blank line
 * is not the placeholder. That is what makes "there is a note filed here" decidable without
 * forbidding the paragraphs that must stay.
 */

/**
 * The literal the Unreleased section carries when it holds nothing.
 *
 * One fact in three files — CHANGELOG.md's own convention header names it so a reader knows what
 * to leave behind, this grades against it, and test/release-workflow-guard.test.ts transcribes it
 * independently and asserts all three agree. Rename it in one place and the gate would grade
 * against a string nothing will ever contain again.
 */
export const UNRELEASED_PLACEHOLDER = "*Nothing pending.*";

/** The heading that opens the section, and the one shape that closes it. */
const OPENS_SECTION = /^## Unreleased[ \t]*$/;
const OPENS_ANY_SECTION = /^## /;

/**
 * A line that is a release NOTE rather than the convention prose around it: a sub-heading, or a
 * bulleted entry in either spelling.
 *
 * `[*-][ \t]` requires whitespace after the marker, which is what keeps the placeholder itself —
 * `*Nothing pending.*` — from reading as a `*` bullet. That is not incidental: without it the gate
 * would fail every correct changelog.
 */
const IS_A_NOTE = /^(###|[*-][ \t])/;

/**
 * Every problem the Unreleased section has, as the GitHub `::error` annotations the workflow
 * prints — empty for a section that is clean.
 *
 * The annotation text is part of what is returned rather than left to the caller because the
 * `file=`/`line=` prefix is what makes the message land on the offending line in the pull request
 * diff. A wrong prefix still prints, still fails the job, and silently stops being a pointer.
 *
 * Faithful to the awk it replaces in one respect worth naming: `last` tracks the last non-blank
 * line of the LAST `## Unreleased` section in the file, and offending lines update it too, so a
 * bullet placed AFTER the placeholder reports both problems.
 */
export function unreleasedProblems(markdown: string): string[] {
  const problems: string[] = [];
  let inside = false;
  let last = "";

  // `\r?\n`, where the awk split on `\n` alone. The awk only ever ran on the ubuntu runner, whose
  // checkout is LF; this also runs on a developer's machine, and a stray CR would be counted as
  // content — failing the gate for a reason that has nothing to do with the changelog. That is the
  // same local-gate-untrustworthy failure .gitattributes' own comment describes.
  const lines = markdown.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    if (OPENS_SECTION.test(raw)) {
      inside = true;
      continue;
    }
    if (OPENS_ANY_SECTION.test(raw)) inside = false;
    if (!inside) continue;

    const line = raw.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");
    if (line === "") continue;
    if (IS_A_NOTE.test(line)) {
      problems.push(
        `::error file=CHANGELOG.md,line=${i + 1}::a release note is still filed as ` +
          `unreleased: ${line}`,
      );
    }
    last = line;
  }

  if (last !== UNRELEASED_PLACEHOLDER) {
    // An absent section and a section that ends in something else are one failure, not two: both
    // mean "nothing here says the notes were moved". They are distinguished in the message alone,
    // because the fix differs — restore the section, versus move what is in it.
    const ends = last === "" ? "(no ## Unreleased section at all)" : last;
    problems.push(
      `::error file=CHANGELOG.md::the Unreleased section must end with its placeholder ` +
        `${UNRELEASED_PLACEHOLDER} — it ends with: ${ends}`,
    );
  }

  return problems;
}
