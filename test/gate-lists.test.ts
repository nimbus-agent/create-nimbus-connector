/**
 * The prose gate lists, graded against `GATES` — because "a gate no checklist names is a gate
 * that silently stops being run" is this repository's own sentence, and it had already happened.
 *
 * `reach --baseline` was named in two canonical lists while four others described the local gate
 * set without it, and three separate places said *three* gates need a Nimbus checkout when there
 * are four. One of those three was `.github/pull_request_template.md` — the checklist a
 * contributor actually reads. It was all repaired by hand across eleven files, and nothing stopped
 * it recurring: `scripts/_lib/preflight.ts` holds the sequence as `GATES`, and the documents were
 * unrelated text that merely happened to agree with it.
 *
 * ## The rule, and where each half of it comes from
 *
 * **Expected content is derived, never transcribed.** Every name this file requires comes from
 * `GATES`, and the two scopes come from its `needsRoot` discriminant. A hand-copied list of gate
 * names here would be the same defect one level over: two lists that agree today and drift
 * tomorrow. (test/scripts/preflight.test.ts transcribes them deliberately, and the two choices are
 * not in tension — that file asks whether the module behaves as specified, where reading the list
 * back would only prove the module agrees with itself. This one asks whether two artifacts agree.)
 *
 * **The documents are enumerated, not listed.** `CANONICAL` below is a hardcoded set, which is
 * only acceptable if a document that belongs on it cannot stay off it — the property
 * test/coverage-gate.test.ts gets by reading the workflow *directory* rather than naming `ci.yml`.
 * Here it comes from `presentsAGateList`: a document that names every gate in either half of
 * `GATES` is a gate list, whoever wrote it and whenever it arrived, and the enumeration sweeps
 * every tracked Markdown file and every tracked YAML comment block in the repository. Measured on
 * 2026-08-07 over 26 such files, exactly the eight in `CANONICAL` qualify and the next closest
 * miss is `docs/ROADMAP.md`, which names five gates scattered across 800 lines and no complete
 * half. What this does **not** catch is a new document listing a partial set — five of eight, say
 * — which is a real residual hole and the reason the halves are the threshold rather than a count.
 *
 * **A subset is expressed, not accommodated.** Two of the eight legitimately describe only the
 * gates that need the monorepo: `docs/RELEASING.md`'s *Before you merge a release PR*, and
 * `.github/workflows/ci.yml`'s trailing comment, whose whole subject is the four gates CI cannot
 * run. Rather than weaken the rule for them, they declare `scope: "needs-root"` — and a
 * subset-scoped document must name **nothing outside its scope**, so the declaration cannot be
 * used to excuse a full list that lost a gate. Both name zero gates outside it today.
 *
 * ## Why the matching is fussy
 *
 * The distinction that was missing is `reach` versus `reach --baseline`, so a matcher that treats
 * a gate name as a substring reproduces the bug it is here to catch. `gatesNamedIn` takes the
 * LONGEST gate name at each position, so `bun test --coverage` does not credit the `bun test`
 * gate, and requires boundaries on both sides, so `standalone-acceptance`, `runtime:acceptance`
 * and `scripts/acceptance.ts` do not credit `acceptance`. `MATCHER_CASES` pins all of it against
 * an independent transcription, on test/source-hygiene.test.ts's reasoning: run only against
 * documents that already pass, a matcher proves the documents are tidy and says nothing about
 * whether it works. Task 4 hardened the coverage gate's matcher after `--coverage\b` turned out to
 * be satisfied by the hyphen in `--coverage-reporter=lcov`; that exact string is a case below.
 *
 * ## What is graded, and what is not
 *
 * The unit is the whole document, so this asserts that a canonical list names every gate in scope
 * *somewhere in the file* — not, in general, that it names it inside the list. That is the drift
 * that actually happened (the gate was absent, not misfiled), and a section-scoped rule would need
 * heading text transcribed here, which is one more thing to drift. The measured cost is real and
 * was demonstrated rather than assumed: deleting `bun test --coverage` from
 * `.claude/commands/cnc-preflight.md`'s **command block**, while leaving the paragraph beneath it
 * that explains the gate, fails nothing here — and a reader copies the block. `checkboxLinesOf`
 * closes that for the one document shape where the structure is unambiguous, and nowhere else.
 *
 * For YAML only comment lines count: a workflow's `run:` steps are it doing its job rather than
 * describing the gate set, and test/coverage-gate.test.ts and test/release-workflow-guard.test.ts
 * already read those as code.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATES } from "../scripts/_lib/preflight.ts";

// `fileURLToPath`, not `URL.pathname`, for the reason test/source-hygiene.test.ts's `repoRootFrom`
// records: a pathname is percent-encoded, so a checkout under a path with a space in it would name
// a directory that is not there and every read below would fail.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The gate names, and the two halves — derived from `GATES` and its `needsRoot` discriminant, so
 * adding, renaming or reclassifying a gate changes what every document must say without anyone
 * editing this file.
 */
const EVERY_GATE = GATES.map((g) => g.name);
const NEEDS_ROOT = GATES.filter((g) => g.needsRoot).map((g) => g.name);
const CI_RUNNABLE = GATES.filter((g) => !g.needsRoot).map((g) => g.name);

/** `"all"`, or one of the two halves a document may honestly restrict itself to. */
type Scope = "all" | "needs-root" | "ci-runnable";

function gatesInScope(scope: Scope): readonly string[] {
  if (scope === "needs-root") return NEEDS_ROOT;
  if (scope === "ci-runnable") return CI_RUNNABLE;
  return EVERY_GATE;
}

/**
 * The documents that enumerate the local gates for a reader, and how much of the set each one
 * claims to cover.
 *
 * Hardcoded, but not trusted: *is the complete set of documents that present a gate list* below
 * compares this against everything the repository actually contains, so a ninth list cannot arrive
 * exempt and none of these eight can quietly stop being one.
 *
 * `ci-runnable` has no member today. It is here because the halves are what `presentsAGateList`
 * tests, so a future page listing only the gates CI runs would be discovered — and would then have
 * to be declared rather than argued about.
 */
const CANONICAL: readonly { readonly path: string; readonly scope: Scope }[] = [
  { path: "CLAUDE.md", scope: "all" },
  { path: "CONTRIBUTING.md", scope: "all" },
  { path: ".github/pull_request_template.md", scope: "all" },
  { path: ".claude/commands/cnc-preflight.md", scope: "all" },
  { path: "docs/ARCHITECTURE.md", scope: "all" },
  { path: "docs/TESTING.md", scope: "all" },
  // Scoped to the monorepo gates on purpose. RELEASING's *Before you merge a release PR* lists
  // "the four it adds to CI's three"; ci.yml's trailing comment lists the four it deliberately
  // does not run. Neither names a gate outside that half, which is what makes the scope honest
  // rather than an excuse — and the assertion below is what keeps it that way.
  { path: "docs/RELEASING.md", scope: "needs-root" },
  { path: ".github/workflows/ci.yml", scope: "needs-root" },
];

/**
 * A character that would make a gate name part of something longer to its left.
 *
 * `:` and `-` are the load-bearing entries: without them `runtime:acceptance` and
 * `standalone-acceptance` — two harnesses that are emphatically NOT the `acceptance` gate, and
 * which appear in nearly every document here — would each credit it. `/` keeps `scripts/acceptance.ts`
 * from counting as a mention of the gate that script implements.
 */
const NAME_CONTINUES_LEFT = /[\w:./-]/;

/**
 * Whether a gate name ENDS at `end`, rather than continuing into a longer token.
 *
 * The `.`-followed-by-a-letter clause is `acceptance.yml`: the workflow is named in this repo's
 * prose more often than the gate is, and reading it as the gate would let a document satisfy
 * `acceptance` while never mentioning the command.
 */
function nameEndsAt(text: string, end: number): boolean {
  const next = text[end];
  if (next === undefined) return true;
  if (/[\w-]/.test(next)) return false;
  if (next === "." && /[A-Za-z]/.test(text[end + 1] ?? "")) return false;
  return true;
}

/** Longest first, so `bun test --coverage` is tried before `bun test` at the same position. */
const BY_LENGTH_DESC = [...EVERY_GATE].sort((a, b) => b.length - a.length);

/**
 * Which gates a piece of prose NAMES — longest match wins at each position.
 *
 * That is the whole point rather than an optimisation. `bun test --coverage` and `bun test` are
 * two gates that fail for different reasons, and a first-match scan would let a document naming
 * only the coverage form claim to have named both. It is the same shape as `reach` standing in for
 * `reach --baseline`, which is the drift this file exists for.
 */
function gatesNamedIn(text: string): Set<string> {
  const named = new Set<string>();
  for (let i = 0; i < text.length; i++) {
    if (i > 0 && NAME_CONTINUES_LEFT.test(text[i - 1] ?? "")) continue;
    for (const gate of BY_LENGTH_DESC) {
      if (!text.startsWith(gate, i)) continue;
      if (!nameEndsAt(text, i + gate.length)) continue;
      named.add(gate);
      i += gate.length - 1;
      break;
    }
  }
  return named;
}

const isYaml = (path: string): boolean => path.endsWith(".yml") || path.endsWith(".yaml");

/**
 * The Markdown task-list lines in a document — `- [ ]` and `- [x]`, and their `*` spellings.
 *
 * This is the one place the whole-document rule below can be sharpened structurally without
 * transcribing a heading here. Where a document has checkboxes, the checkboxes ARE the gate list:
 * a contributor ticks them and reports the result, so a gate named in the surrounding prose but
 * missing a box is a gate that will not be run. That is not hypothetical — Task 10 found exactly
 * it in `.github/pull_request_template.md`, which had no `reach --baseline` box and no
 * `bun test --coverage` box, so a contributor could tick every box and still have run six gates
 * out of eight.
 *
 * Only continuation-free lines, deliberately: a box's own line is what carries the command, and
 * pulling in wrapped prose would let the surrounding text satisfy the box again.
 */
function checkboxLinesOf(prose: string): string[] {
  return prose.split("\n").filter((line) => /^\s*[-*] \[[ xX]\]/.test(line));
}

/**
 * The in-scope gates a checklist mentions somewhere but never gives a box — empty for a document
 * that has no boxes at all, which is most of them.
 *
 * A named function rather than an inline loop, so it can be run against a document that is WRONG.
 * Inlined, it would only ever see checklists that already pass, and weakening it to grade the
 * whole document instead of the box lines — a strictly weaker rule that today's `.github/
 * pull_request_template.md` satisfies either way — failed nothing when that was measured. That is
 * the shape test/source-hygiene.test.ts's `MUST_BE_CAUGHT` docstring is about.
 */
function gatesMissingABox(prose: string, scope: Scope): string[] {
  const boxes = checkboxLinesOf(prose);
  if (boxes.length === 0) return [];
  const boxed = gatesNamedIn(boxes.join("\n"));
  return gatesInScope(scope).filter((gate) => !boxed.has(gate));
}

/**
 * The part of a file that is describing the gates to a reader.
 *
 * For Markdown that is the file. For YAML it is the comment lines alone — `ci.yml` RUNS
 * `bun test --coverage` as a step, and counting that as the trailing comment having named the gate
 * would grade the workflow's behaviour as though it were its prose.
 */
function proseOf(path: string): string {
  const text = readFileSync(join(repoRoot, path), "utf8");
  if (!isYaml(path)) return text;
  return text
    .split("\n")
    .filter((line) => line.trimStart().startsWith("#"))
    .join("\n");
}

/**
 * Every prose file git can see — tracked, staged, or merely written.
 *
 * `--others --exclude-standard` for test/source-hygiene.test.ts's reason: a plain `git ls-files`
 * cannot see a brand-new file, and a brand-new document is exactly when a gate list arrives
 * undeclared.
 */
function trackedProseFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: repoRoot,
  });
  if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
  return out.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".md") || isYaml(l));
}

/**
 * Whether a document presents itself as a list of this repository's local gates.
 *
 * Named for the claim it gates rather than for the count that decides it: the question is not "how
 * many gates does this mention" but "is this a gate list", and a document that walks a reader
 * through every gate needing the monorepo, or every gate CI can run, is one. Both halves come from
 * `GATES`, so a gate that changes sides changes what qualifies.
 */
function presentsAGateList(prose: string): boolean {
  const named = gatesNamedIn(prose);
  return NEEDS_ROOT.every((g) => named.has(g)) || CI_RUNNABLE.every((g) => named.has(g));
}

describe("the canonical gate lists", () => {
  it("each names every gate in its scope", () => {
    const missing = CANONICAL.flatMap(({ path, scope }) => {
      const named = gatesNamedIn(proseOf(path));
      return gatesInScope(scope)
        .filter((gate) => !named.has(gate))
        .map((gate) => `${path} (scope "${scope}") never names \`${gate}\``);
    });
    expect(missing).toEqual([]);
  });

  it("keeps a subset-scoped list an honest subset rather than a full list with a hole", () => {
    // Without this, the fix for a canonical list that lost a gate would be to relabel the document
    // as a subset — turning the scope field from a description into an escape hatch, which is the
    // `fixtures/expectations.json` failure mode in another costume.
    const leaked = CANONICAL.filter((c) => c.scope !== "all").flatMap(({ path, scope }) => {
      const named = gatesNamedIn(proseOf(path));
      const inScope = new Set(gatesInScope(scope));
      return EVERY_GATE.filter((g) => !inScope.has(g) && named.has(g)).map(
        (g) => `${path} is scoped "${scope}" but also names \`${g}\`, so it is not a subset`,
      );
    });
    expect(leaked).toEqual([]);
  });

  it("gives every in-scope gate a box, in a list made of boxes", () => {
    // Applies wherever checkboxes are found rather than to a named file, so a second checklist
    // added later inherits it — the widening test/coverage-gate.test.ts made when it stopped
    // parsing `ci.yml` alone. `.github/pull_request_template.md` is the only member today.
    const boxless = CANONICAL.flatMap(({ path, scope }) =>
      gatesMissingABox(proseOf(path), scope).map(
        (gate) => `${path} is a checklist but gives \`${gate}\` no box`,
      ),
    );
    expect(boxless).toEqual([]);
  });

  it("is the complete set of documents that present a gate list", () => {
    // The assertion that makes the hardcoded set above safe, and the one that fails if the matcher
    // stops matching or the enumeration stops enumerating: both collapse `present` to fewer
    // entries than `CANONICAL` has.
    const present = trackedProseFiles().filter((path) => presentsAGateList(proseOf(path)));
    expect(present.sort()).toEqual(CANONICAL.map((c) => c.path).sort());
  });
});

describe("the rule cannot pass vacuously", () => {
  it("has gates to require, in both halves, each named once", () => {
    // An empty `GATES` makes `gatesInScope` empty, `presentsAGateList` true for every file in the
    // repository, and every assertion above either trivially true or loudly wrong. This is the one
    // that says which.
    expect(EVERY_GATE.length).toBeGreaterThan(4);
    expect(NEEDS_ROOT.length).toBeGreaterThan(0);
    expect(CI_RUNNABLE.length).toBeGreaterThan(0);
    expect(new Set(EVERY_GATE).size).toBe(EVERY_GATE.length);
  });

  it("has documents to grade, of more than one scope", () => {
    expect(CANONICAL.filter((c) => c.scope === "all").length).toBeGreaterThan(0);
    expect(CANONICAL.filter((c) => c.scope !== "all").length).toBeGreaterThan(0);
  });

  it("enumerates the repository's prose rather than only the files it already agrees with", () => {
    // `git ls-files` exits 0 and prints nothing for a path that matches nothing, so an enumeration
    // that silently narrowed to the eight declared files would satisfy every assertion above while
    // discovering nothing — the exact shape test/coverage-gate.test.ts widened to a directory read
    // to escape.
    const files = trackedProseFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(files).toEqual(expect.arrayContaining([...CANONICAL.map((c) => c.path)]));
  });

  it("finds the checkboxes the checkbox rule is applied to", () => {
    // The checkbox rule skips a document with no boxes, so a `checkboxLinesOf` that stopped
    // matching — a changed bullet character, a tightened regex — would make it a no-op over the
    // whole repository while still reporting green. It is the rule's only structural input, so it
    // is the one thing worth counting.
    const withBoxes = CANONICAL.map((c) => checkboxLinesOf(proseOf(c.path))).filter(
      (lines) => lines.length > 0,
    );
    expect(withBoxes.length).toBeGreaterThan(0);
    expect(Math.max(...withBoxes.map((l) => l.length))).toBeGreaterThan(EVERY_GATE.length);
  });

  it("reads real text from every canonical list, including the YAML comment block", () => {
    // Counts what was READ, not what was listed. A comment extractor that returned "" would leave
    // ci.yml graded against nothing; the assertions above would report it as missing four gates,
    // but only after someone worked out why.
    const empty = CANONICAL.filter((c) => proseOf(c.path).trim().length === 0).map((c) => c.path);
    expect(empty).toEqual([]);
    expect(CANONICAL.reduce((n, c) => n + proseOf(c.path).length, 0)).toBeGreaterThan(20_000);
  });
});

/**
 * What the matcher must and must not see, transcribed INDEPENDENTLY of the documents.
 *
 * Every case is a string that appears in this repository's prose, or one line away from it. The
 * negatives are the ones that matter: each is a near-miss that a substring search reports as a
 * mention, which would let a document satisfy a gate it never names.
 */
const MATCHER_CASES: readonly { readonly text: string; readonly names: readonly string[] }[] = [
  // The distinction that was actually missing. A document may discuss `reach` at length — most of
  // them do — without naming the gate form, and that is precisely how it stayed off four lists.
  { text: "bun run reach --nimbus-root C:/gitrep/Nimbus", names: [] },
  { text: "`reach` measures the spec language's coverage of the corpus", names: [] },
  { text: "bun run reach --baseline --nimbus-root <path>", names: ["reach --baseline"] },

  // Task 4's hyphen trap, one level over: `--coverage` followed by `-` is a different flag.
  { text: "bun test --coverage", names: ["bun test --coverage"] },
  { text: "bun test", names: ["bun test"] },
  { text: "bun test --coverage --coverage-reporter=lcov", names: ["bun test --coverage"] },
  { text: "bun test --coverage-reporter=lcov", names: ["bun test"] },

  // Three things that are not the `acceptance` gate, all of which this repo's prose is full of.
  { text: "bun run standalone-acceptance --registry", names: [] },
  { text: "bun run runtime:acceptance --registry", names: [] },
  { text: "scripts/acceptance.ts", names: [] },
  { text: "in `acceptance.yml`, on a daily cron and on pull requests", names: [] },
  { text: "bun run acceptance <nimbus-root>", names: ["acceptance"] },

  { text: "bunx tsc --noEmit", names: ["tsc --noEmit"] },
  { text: "bunx biome check src/ test/ scripts/", names: ["biome check"] },
  { text: "bun run diff:golden --nimbus-root <path>", names: ["diff:golden"] },
  { text: "bun run wiring:conformance --nimbus-root <path>", names: ["wiring:conformance"] },

  // A whole checklist line, since that is the shape the documents are actually made of.
  {
    text: "- [ ] `bun test --coverage` (the per-file floors; a bare `bun test` does not evaluate them)",
    names: ["bun test --coverage", "bun test"],
  },
];

describe("the matcher", () => {
  it("credits a gate only where the document names that gate", () => {
    for (const { text, names } of MATCHER_CASES) {
      expect([...gatesNamedIn(text)].sort(), text).toEqual([...names].sort());
    }
  });

  it("has a positive case for every gate, so no gate's spelling is untested", () => {
    // Ties the table to `GATES`: a gate added without a case here fails, which is the moment to
    // decide whether its name survives the boundary rules at all.
    const covered = new Set(MATCHER_CASES.flatMap((c) => c.names));
    expect(EVERY_GATE.filter((g) => !covered.has(g))).toEqual([]);
  });

  it("has cases in both directions", () => {
    // A table of positives alone would pass with `nameEndsAt` deleted entirely.
    expect(MATCHER_CASES.filter((c) => c.names.length === 0).length).toBeGreaterThan(3);
    expect(MATCHER_CASES.filter((c) => c.names.length > 0).length).toBeGreaterThan(5);
  });
});

describe("the checkbox rule, on a checklist that is wrong", () => {
  const fullChecklist = EVERY_GATE.map((g) => `- [ ] \`${g}\``).join("\n");

  it("passes a checklist that boxes every gate", () => {
    expect(gatesMissingABox(fullChecklist, "all")).toEqual([]);
  });

  it("reports a gate demoted from its box into the surrounding prose", () => {
    // Run for EVERY gate rather than one, so no single choice of victim is load-bearing — and
    // paired with the whole-document matcher on the same string, which is what makes the claim
    // "the box rule does work the document rule does not" an assertion rather than a hope.
    const undetected = EVERY_GATE.filter((demoted) => {
      const doc = fullChecklist
        .split("\n")
        .map((line) =>
          line.includes(`\`${demoted}\``) ? `Also run \`${demoted}\` sometime.` : line,
        )
        .join("\n");
      const boxRuleCatchesIt = gatesMissingABox(doc, "all").join() === demoted;
      const documentRuleMissesIt = gatesNamedIn(doc).has(demoted);
      return !(boxRuleCatchesIt && documentRuleMissesIt);
    });
    expect(undetected).toEqual([]);
  });

  it("says nothing about a document that is not a checklist", () => {
    // The skip that makes the rule applicable at all: six of the eight canonical lists are prose
    // and tables, and a rule that demanded boxes of them would have to be deleted rather than
    // enforced.
    expect(gatesMissingABox("no boxes here, and no `bun test` either", "all")).toEqual([]);
  });
});
