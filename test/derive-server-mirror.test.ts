import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * `src/derive/server/` mirrors `src/emit/server/` one recognizer per emitter module, plus a
 * handful that recognize shapes no single emitter module writes. Two documents enumerate that
 * remainder — `docs/ARCHITECTURE.md` and `.claude/commands/cnc-reach-deriver.md` — and BOTH
 * said "frame.ts and hoists.ts" long after `second-file.ts` (0.12.0) and `conditional-path.ts`
 * (0.13.0) joined them.
 *
 * Two copies of the same wrong list is the tell. The remainder is a set difference over two
 * directories, so it is derivable, and a derived expectation cannot fall behind the way a
 * hand-written one did twice.
 */

const ls = (rel: string): Set<string> =>
  new Set(
    readdirSync(join(repoRoot, rel))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, "")),
  );

/** Recognizers with no emitter module of the same name. */
function counterpartless(): string[] {
  const emitters = ls("src/emit/server");
  return [...ls("src/derive/server")].filter((m) => !emitters.has(m)).sort();
}

const DOCS = ["docs/ARCHITECTURE.md", ".claude/commands/cnc-reach-deriver.md"];

describe("the counterpart-less derive/server modules", () => {
  it("is a non-empty set, so the assertions below are not vacuous", () => {
    // A set difference that silently became empty would let every document pass while naming
    // nothing. Four qualify today: frame, hoists, second-file, conditional-path.
    expect(counterpartless().length).toBeGreaterThanOrEqual(4);
  });

  it.each(DOCS)("%s names every one of them", (doc) => {
    const src = readFileSync(join(repoRoot, doc), "utf8");
    const missing = counterpartless().filter((m) => !src.includes(m));
    expect(missing, `${doc} is missing a counterpart-less recognizer`).toEqual([]);
  });

  it.each(DOCS)("%s does not name a module that has since gained an emitter", (doc) => {
    // The other direction, which is the one a reader is actively misled by: a document still
    // calling a module counterpart-less after an emitter for it landed. Only modules that
    // exist under derive/server are checked, so unrelated prose cannot trip this.
    const src = readFileSync(join(repoRoot, doc), "utf8");
    const emitters = ls("src/emit/server");
    const wronglyListed = [...ls("src/derive/server")]
      .filter((m) => emitters.has(m))
      .filter((m) => new RegExp(`${m}[^\\w-]*(?:\\.ts)?[^\\n]*no emitter counterpart`).test(src));
    expect(wronglyListed).toEqual([]);
  });
});
