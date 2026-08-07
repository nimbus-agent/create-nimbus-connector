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
 * Every source file under the directories this project's own gates cover — tracked, staged, or
 * merely written.
 *
 * `--others --exclude-standard` is the second correction this gate has needed, and it comes from
 * the same place the widened set above does: a plain `git ls-files` lists only what is already in
 * the index, so a BRAND NEW file is invisible to this check until it is `git add`ed. That is
 * precisely the moment the check exists for — the defect it was written for was authored into a
 * new file and caught by eye before the commit. Verified by writing a U+200B into an unstaged
 * `src/openapi/spec.ts` and watching this test pass.
 *
 * `--exclude-standard` is what keeps `node_modules/` and other ignored output out; without it,
 * `--others` would sweep them in and this would be a scan of a dependency tree.
 */
function trackedSourceFiles(): string[] {
  const out = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "src",
      "test",
      "scripts",
      "schema",
    ],
    { cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") },
  );
  if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
  return out.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
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
        const code = ch.codePointAt(0)!;
        const isControl = code < 0x20 || code === 0x7f;
        if ((isControl && !ALLOWED_CONTROL.has(ch)) || INVISIBLE.has(code)) {
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
});
