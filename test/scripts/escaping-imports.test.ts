/**
 * Unit tests for the "no relative import escapes the package" scan.
 *
 * A generated standalone package must be self-contained. An import that climbs out of it
 * (`../../src/...`) resolves perfectly in the temp tree standalone-acceptance builds — the
 * file really is up there — and breaks for every real consumer, and no other check in the
 * pipeline sees it: `tsc` is happy, `biome` is happy, and the server starts.
 *
 * The scan is hand-rolled rather than `grep -rn` for a project non-negotiable (Windows,
 * macOS and Linux are equally supported, and grep is not on a stock Windows PATH), which is
 * exactly the kind of substitution that can quietly match nothing and report a clean tree
 * forever. So the first thing worth pinning is that it FINDS things, and the second is the
 * grep-compatible shape of what it prints.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findEscapingImports } from "../../scripts/_lib/escaping-imports.ts";
import { tempDirs } from "../support/tmp.ts";

const tmp = tempDirs();
afterAll(tmp.cleanup);

function tree(files: Record<string, string>): string {
  const root = tmp.make("cnc-escaping-");
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, ...rel.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return root;
}

describe("findEscapingImports", () => {
  it("reports nothing for a self-contained package", () => {
    const dir = tree({
      "server.ts": 'import { x } from "./tools.ts";\n',
      "tools.ts": 'import { y } from "../src/inside.ts";\n',
    });

    expect(findEscapingImports(dir)).toBe("");
  });

  it("finds an import that climbs out of the package", () => {
    const dir = tree({ "server.ts": 'import { x } from "../../src/emit/index.ts";\n' });

    expect(findEscapingImports(dir)).toBe(
      'server.ts:1:import { x } from "../../src/emit/index.ts";',
    );
  });

  it("prints path:line:content, with the line number 1-based as grep -n does", () => {
    // The output is pasted into an editor by whoever has to fix it. An off-by-one here
    // sends them to the wrong line of a generated file they did not write.
    const dir = tree({ "server.ts": 'const a = 1;\nconst b = 2;\nimport "../../x.ts";\n' });

    expect(findEscapingImports(dir)).toBe('server.ts:3:import "../../x.ts";');
  });

  it("recurses into subdirectories", () => {
    const dir = tree({ "deep/nested/mod.ts": 'export * from "../../shared.ts";\n' });

    expect(findEscapingImports(dir)).toBe('deep/nested/mod.ts:1:export * from "../../shared.ts";');
  });

  it("reports paths with forward slashes on every platform", () => {
    // The harness runs on Windows too, where relative() returns backslashes. A backslash
    // path is not what a reader pastes anywhere, and it makes CI output differ by runner.
    const dir = tree({ "a/b/c.ts": 'import "../../up.ts";\n' });

    expect(findEscapingImports(dir)).not.toContain("\\");
  });

  it("reports every offending line, one per line, not just the first", () => {
    const dir = tree({
      "one.ts": 'import "../../a.ts";\n',
      "two.ts": 'import "../../b.ts";\nimport "../../c.ts";\n',
    });

    expect(findEscapingImports(dir).split("\n")).toHaveLength(3);
  });

  it("returns empty for a directory that is not there rather than throwing", () => {
    // The caller scopes this to a generated package's src/. A missing directory is already
    // caught, loudly, by the build and run checks around it; throwing here would abort the
    // fixture before those ran and report the wrong cause.
    expect(findEscapingImports(join(tmp.make("cnc-escaping-absent-"), "nope"))).toBe("");
  });

  it("returns empty for an empty directory", () => {
    expect(findEscapingImports(tmp.make("cnc-escaping-empty-"))).toBe("");
  });
});
