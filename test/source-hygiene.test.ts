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
 * Scope is every tracked source file, taken from git rather than a directory walk so a file added
 * outside `src/` cannot escape by living somewhere the glob does not reach.
 */
const ALLOWED_CONTROL = new Set(["\t", "\n", "\r"]);

/** Tracked text files under the directories this project's own gates cover. */
function trackedSourceFiles(): string[] {
  const out = Bun.spawnSync(["git", "ls-files", "src", "test", "scripts", "schema"], {
    cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  });
  if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
  return out.stdout
    .toString()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

describe("source hygiene", () => {
  it("contains no control characters other than tab, newline and carriage return", () => {
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
        if (isControl && !ALLOWED_CONTROL.has(ch)) {
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
