import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * A gate that exists because a real defect passed every other one.
 *
 * Writing `src/openapi/operation.ts` produced a literal NUL byte inside a template literal used as
 * a composite-key separator. It typechecked, it linted, it passed the full suite, and coverage was
 * clean — the sole symptom was `grep` reporting the file as binary. It was caught by eye before it
 * reached a commit, which is not a mechanism.
 *
 * That is the shape this repository exists to refuse: a check that passes while the thing it
 * checks is wrong. `tsc` sees a valid string literal, Biome sees formatted code, and the tests see
 * the value the key was built from — none of them is looking at the bytes. So this looks at the
 * bytes.
 *
 * Scope is every source file git can see under those directories — written, staged or committed —
 * taken from git rather than a directory walk so a file added outside `src/` cannot escape by
 * living somewhere the glob does not reach. `trackedSourceFiles` says why "written" is in that
 * list rather than just "committed".
 *
 * **The set below is wider than "control character", and the widening came from the same failure
 * happening again.** Writing `src/openapi/spec.ts` produced a literal U+200B ZERO WIDTH SPACE
 * inside a docstring. It is not a control character — `code < 0x20` does not see it — so this gate
 * as first written would have passed it, exactly as `tsc`, Biome, the suite and coverage all did.
 * The property that matters is not "is it a control character" but "does it occupy no space on
 * screen", so the check is written against that property instead: the zero-width family, the
 * soft hyphen, the byte-order mark, and the bidirectional overrides that make source read
 * differently from how it executes.
 */
const ALLOWED_CONTROL = new Set(["\t", "\n", "\r"]);

/**
 * Characters that render as nothing (or as a direction change) in an editor.
 *
 *   U+00AD  soft hyphen
 *   U+200B  zero width space          — the one that was actually written into this repository
 *   U+200C  zero width non-joiner
 *   U+200D  zero width joiner
 *   U+2060  word joiner
 *   U+FEFF  zero width no-break space / byte-order mark
 *   U+202A-E, U+2066-9  the bidi embedding and isolate controls ("Trojan Source")
 */
const INVISIBLE = new Set([
  0x00ad, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
  0x2067, 0x2068, 0x2069,
]);

/**
 * The whole decision, as one named function — so it can be asserted over rather than only
 * evaluated against files that are already clean.
 *
 * That is the point of factoring it out. Inlined in the sweep below, this predicate was only ever
 * run against a repository with nothing wrong in it, so **nothing in the suite made it true**. A
 * mistyped code point, `INVISIBLE.has(ch)` where `ch` is a string and the set holds numbers, an
 * inverted condition — any of them and the sweep passes green forever while inspecting every byte
 * and seeing nothing. A gate whose only verification is a manual injection someone ran once is
 * the same shape as the defect it was written to catch.
 */
function rendersAsNothing(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  const isControl = code < 0x20 || code === 0x7f;
  return (isControl && !ALLOWED_CONTROL.has(ch)) || INVISIBLE.has(code);
}

/**
 * The directories this gate is told to sweep — named, so the sweep and the check that the sweep
 * SAW them read from one list.
 *
 * This is the gate's third correction, and the first one aimed at the class rather than the
 * instance. `schema/` was on this list and contributing ZERO files, because `.gitignore` ignores
 * every top-level directory by a catch-all and re-admits the ones this repo owns by name — a
 * brand-new `schema/` was ignored, so `--exclude-standard` dropped it and the sweep saw none of it.
 * Every gate stayed green. Measured per path today: src 58, test 77, scripts 22, schema 1 — so
 * `src` ALONE clears the aggregate floor below, and any one of the other three could go to zero
 * without moving a single assertion. `git ls-files` exits 0 and prints nothing for a path that
 * matches nothing, so silence is the failure mode, not an error.
 */
const SWEPT_PATHS = ["src", "test", "scripts", "schema"] as const;

const repoRoot = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

/**
 * The files git can see under ONE swept path — tracked, staged, or merely written.
 *
 * Per path rather than one call for all four, so the count each path contributes is observable.
 * That is what detects the mismatch between "paths I was told to sweep" and "paths I actually
 * saw", which is the property all three of this gate's failures lacked.
 *
 * `--others --exclude-standard` is the second correction this gate needed, and it comes from the
 * same place the widened set above does: a plain `git ls-files` lists only what is already in the
 * index, so a BRAND NEW file is invisible to this check until it is `git add`ed. That is precisely
 * the moment the check exists for — the defect it was written for was authored into a new file and
 * caught by eye before the commit. The hole was found the same way: a U+200B written into an
 * unstaged `src/openapi/spec.ts` left this gate GREEN. With the flags, the same injection fails
 * it, naming the file and the offset — which is how a gate fix is confirmed.
 *
 * `--exclude-standard` is what keeps `node_modules/` and other ignored output out; without it,
 * `--others` would sweep them in and this would be a scan of a dependency tree. It is also
 * exactly what hid `schema/`, which is why the per-path assertion below exists.
 */
function filesUnder(path: string): string[] {
  const out = Bun.spawnSync(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", path],
    {
      cwd: repoRoot,
    },
  );
  if (out.exitCode !== 0) throw new Error(`git ls-files ${path} failed: ${out.stderr.toString()}`);
  return out.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function trackedSourceFiles(): string[] {
  return SWEPT_PATHS.flatMap(filesUnder);
}

describe("source hygiene", () => {
  it("contains no character that renders as nothing, beyond tab, newline and carriage return", () => {
    const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
    const offenders: string[] = [];

    for (const rel of trackedSourceFiles()) {
      let text: string;
      try {
        text = readFileSync(`${root}/${rel}`, "utf8");
      } catch {
        continue; // deleted between listing and read; not this test's concern
      }
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (rendersAsNothing(ch)) {
          const code = ch.codePointAt(0)!;
          offenders.push(`${rel}: U+${code.toString(16).padStart(4, "0")} at offset ${i}`);
          break; // one report per file is enough to act on
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("lists a non-trivial number of files, so an empty sweep cannot pass vacuously", () => {
    // Without this, a `git ls-files` that returned nothing — a changed working directory, a
    // renamed folder — would make the check above pass while inspecting zero bytes. That is the
    // failure mode the check itself was written to catch, one level up.
    expect(trackedSourceFiles().length).toBeGreaterThan(50);
  });

  it("sees files under EVERY path it is told to sweep, not just enough of them in total", () => {
    // The aggregate guard above closes the instance; this closes the class. Measured per path:
    // src 58, test 77, scripts 22, schema 1 — so `src` alone clears 50, and a directory that
    // contributes nothing (added to SWEPT_PATHS but swallowed by .gitignore's top-level catch-all,
    // which is exactly what happened to `schema/`) leaves every other assertion here green. `git
    // ls-files` exits 0 and prints nothing for a path it cannot match, so nothing else complains.
    const empty = SWEPT_PATHS.filter((p) => filesUnder(p).length === 0);
    expect(empty).toEqual([]);
  });
});

/**
 * The characters this gate must catch, transcribed INDEPENDENTLY of the sets above.
 *
 * The sweep can only ever run the predicate against a repository with nothing wrong in it, so on
 * its own it proves the source is tidy and says nothing about whether the check works. This is
 * what makes it true.
 *
 * The duplication is the point, and it is here because the first version of these tests iterated
 * `INVISIBLE` and asked whether the predicate agreed with it — which is self-referential. Mutating
 * `0x200b` to `0x200f` in that set failed **nothing**: the loop dutifully confirmed that whatever
 * the set contained was caught, while the zero-width space that was actually written into this
 * repository walked straight through. A second transcription is what makes a typo in either list
 * fail, and it is the only defence available, since "is this character invisible" is not a
 * question a program can ask about a number.
 *
 * Every entry is written as a `\\u` ESCAPE, never as the character itself. That is not tidiness:
 * an escape is ASCII in the file, so this table cannot trip the sweep it exists to test. Writing
 * them as literals is a mistake I made here first, and the sweep caught it — which is the most
 * direct evidence in this file that the gate works.
 */
const MUST_BE_CAUGHT: readonly (readonly [string, string])[] = [
  ["U+0000 NUL - the one that started this gate", "\u0000"],
  ["U+000B LINE TABULATION", "\u000b"],
  ["U+007F DELETE", "\u007f"],
  ["U+00AD SOFT HYPHEN", "\u00ad"],
  ["U+200B ZERO WIDTH SPACE - the one that widened it", "\u200b"],
  ["U+200C ZERO WIDTH NON-JOINER", "\u200c"],
  ["U+200D ZERO WIDTH JOINER", "\u200d"],
  ["U+2060 WORD JOINER", "\u2060"],
  ["U+FEFF ZERO WIDTH NO-BREAK SPACE / BOM", "\ufeff"],
  ["U+202A LEFT-TO-RIGHT EMBEDDING", "\u202a"],
  ["U+202E RIGHT-TO-LEFT OVERRIDE", "\u202e"],
  ["U+2066 LEFT-TO-RIGHT ISOLATE", "\u2066"],
  ["U+2069 POP DIRECTIONAL ISOLATE", "\u2069"],
];

describe("the predicate the sweep is built on", () => {
  it("catches every character named in the independent list, so a mistyped set member fails", () => {
    const missed = MUST_BE_CAUGHT.filter(([, ch]) => !rendersAsNothing(ch)).map(([name]) => name);
    expect(missed).toEqual([]);
  });

  it("agrees with the set it is built from, so a predicate bug fails as well as a set bug", () => {
    const missed = [...INVISIBLE].filter((code) => !rendersAsNothing(String.fromCodePoint(code)));
    expect(missed.map((c) => `U+${c.toString(16)}`)).toEqual([]);
  });

  it("is false for every character in ALLOWED_CONTROL", () => {
    const wrong = [...ALLOWED_CONTROL].filter((ch) => rendersAsNothing(ch));
    expect(wrong.map((c) => `U+${(c.codePointAt(0) ?? 0).toString(16)}`)).toEqual([]);
  });

  it("is false for ordinary source characters, including the non-ASCII ones this repo writes", () => {
    // The em dash and the arrow appear in nearly every docstring here. A predicate written as
    // "anything above ASCII" would pass every test above and reject the whole codebase.
    for (const ch of ["a", " ", "\t", "{", "—", "→"]) {
      expect(rendersAsNothing(ch)).toBe(false);
    }
  });

  it("has something in every list, so no sweep above can pass vacuously", () => {
    expect(MUST_BE_CAUGHT.length).toBeGreaterThan(10);
    expect(INVISIBLE.size).toBeGreaterThan(10);
    expect(ALLOWED_CONTROL.size).toBe(3);
  });
});
